/*
 * Atlas Animator: original implementation.
 *
 * The validation companion of a surface rig: `<name>.validation.json`, written beside
 * the rig by the rig build and hash-checked by `animator validate`. It carries the triangle regions
 * (the solver's joint regions on the skin, every garment mesh), their distortion allowances (generic
 * defaults per region kind, overridden by the preset's `gates.distortion`), excused findings, and
 * the poses both validators evaluate (every sweep frame).
 */
import type { Skeleton } from "../../core/skeleton.js";
import { COMPANION_FORMAT, GeometryEvaluator, rigHash, type DistortionAllowance, type GeometryFinding, type PoseStats, type ValidationCompanion } from "../validateGeometry.js";
import { joinPose, Poser, splitPose, type Pose } from "./correctives.js";
import type { Pt } from "./geometry.js";
import { insideLimits } from "./limits.js";
import type { SurfaceRig } from "./output.js";

/**
 * Generic allowances per region kind (no template data): `default` for skin outside joint regions,
 * `joint` for a solver joint region (the skin opens around the pivot by design), `garment` for
 * garment meshes (a printed pattern shows distortion sooner than skin).
 */
export const KIND_ALLOWANCES: Record<"default" | "joint" | "garment", DistortionAllowance> = {
  default: { minDet: 0.2, maxDet: 5, maxStretch: 2, minStretch: 0.5, absGamePx: 0.5 },
  joint: { minDet: 0.2, maxDet: 5, maxStretch: 3, minStretch: 1 / 3, absGamePx: 0.5 },
  garment: { minDet: 0.2, maxDet: 5, maxStretch: 2, minStretch: 0.5, absGamePx: 0.5 }
};

/** Canonical name of a pose (sorted bone=degrees): the finding pose label in both validators. */
export function poseLabel(pose: Readonly<Record<string, number>>): string {
  const keys = Object.keys(pose).filter((k) => pose[k] !== 0).sort();
  return keys.length ? keys.map((k) => `${k}=${Number((pose[k] as number).toFixed(3))}`).join(",") : "setup";
}

/**
 * The final-runtime pose set every gate shares (review): built from the rig as installed, after
 * every driven grid is baked. Every distinct sweep frame, then for each installed grid (its actual
 * refined axes) the nodes, edge midpoints and cell centres; the pose-limit boundaries (polygon
 * vertices and edge midpoints); and every grid pose again with each other limited driver at its
 * low and high limit (the interacting third driver). Only poses inside the pose limits. `origin`
 * names where a pose came from so a failing pose flags its grid cell.
 */
export function finalPoses(rig: SurfaceRig): { label: string; origin: string; pose: Pose }[] {
  const out = new Map<string, { label: string; origin: string; pose: Pose }>();
  const add = (origin: string, pose: Pose) => {
    const clean: Pose = Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, Number(v.toFixed(4))]));
    if (!insideLimits(rig.limits, clean)) return;
    const label = poseLabel(clean);
    if (!out.has(label)) out.set(label, { label, origin, pose: clean });
  };
  for (const sweep of rig.built.preset.sweeps) (rig.frames[sweep.name] ?? []).forEach((pose, i) => add(`${sweep.name}#${i}`, pose));
  const drivers = rig.built.preset.bones.filter((b) => b.limits).map((b) => ({ bone: b.name, limits: b.limits as [number, number] }));
  const breathe = rig.built.preset.gates?.combined?.breathe;
  // Breathing at its peak on every sweep frame's held end (combined with whatever that sweep drives).
  if (breathe) for (const sweep of rig.built.preset.sweeps) (rig.frames[sweep.name] ?? []).forEach((pose, i, all) => { if (i === all.length - 1 || i === 0) add(`${sweep.name}#${i}, breathe peak`, { ...pose, [`${breathe.bone}.scaleX`]: breathe.x, [`${breathe.bone}.scaleY`]: breathe.y }); });
  type Grid = { name: string; x: { bone: string; at: number[] }; y: { bone: string; at: number[] } };
  for (const g of (rig.document.drivenGrids ?? []) as Grid[]) {
    const xs = [...g.x.at].sort((a, b) => a - b);
    const ys = [...g.y.at].sort((a, b) => a - b);
    const xv = xs.flatMap((x, i) => (i + 1 < xs.length ? [x, (x + (xs[i + 1] as number)) / 2] : [x]));
    const yv = ys.flatMap((y, j) => (j + 1 < ys.length ? [y, (y + (ys[j + 1] as number)) / 2] : [y]));
    xv.forEach((x, i) =>
      yv.forEach((y, j) => {
        const kind = i % 2 === 0 && j % 2 === 0 ? "node" : i % 2 === 1 && j % 2 === 1 ? "centre" : "edge";
        const cell = `${g.name} cell ${g.x.bone} [${xs[Math.floor(i / 2)]}, ${xs[Math.min(Math.ceil(i / 2), xs.length - 1)]}] x ${g.y.bone} [${ys[Math.floor(j / 2)]}, ${ys[Math.min(Math.ceil(j / 2), ys.length - 1)]}] ${kind}`;
        const base: Pose = { [g.x.bone]: x, [g.y.bone]: y };
        add(cell, base);
        const others = drivers.filter((d) => d.bone !== g.x.bone && d.bone !== g.y.bone);
        for (const d of others) for (const v of d.limits) add(`${cell}, ${d.bone} ${v}`, { ...base, [d.bone]: v });
        // Higher-order combinations: at each node, every other driver
        // at its low (then high) limit together, and each of those with breathing at its peak.
        if (kind === "node") {
          const combos: [string, Pose][] = [[cell, base]];
          for (const end of [0, 1] as const) {
            const all: Pose = { ...base };
            for (const d of others) all[d.bone] = d.limits[end];
            combos.push([`${cell}, others at ${end ? "high" : "low"}`, all]);
            add(combos[combos.length - 1]?.[0] as string, all);
          }
          if (breathe) for (const [name, p] of combos) add(`${name}, breathe peak`, { ...p, [`${breathe.bone}.scaleX`]: breathe.x, [`${breathe.bone}.scaleY`]: breathe.y });
        }
      })
    );
  }
  for (const l of rig.limits) {
    l.polygon.forEach((p, i) => {
      const q = l.polygon[(i + 1) % l.polygon.length] as Pt;
      add(`limit ${l.name} vertex ${i}`, { [l.x]: p[0], [l.y]: p[1] });
      add(`limit ${l.name} edge ${i}`, { [l.x]: (p[0] + q[0]) / 2, [l.y]: (p[1] + q[1]) / 2 });
    });
  }
  return [...out.values()];
}

/** The validation companion's poses: the shared final-runtime pose set (finalPoses). */
export function companionPoses(rig: SurfaceRig): { name: string; rotate: Record<string, number>; scale?: Record<string, { x: number; y: number }> }[] {
  return finalPoses(rig).map((p) => {
    const { rotate, scale } = splitPose(p.pose);
    return { name: p.label, rotate, ...(Object.keys(scale).length ? { scale } : {}) };
  });
}

export function validationCompanion(rig: SurfaceRig): ValidationCompanion {
  const { built } = rig;
  const preset = built.preset;
  const declared = (preset.gates as { distortion?: { allowances?: Record<string, Partial<DistortionAllowance>>; exceptions?: { id: string; reason: string }[] } } | undefined)?.distortion;
  const allowances: Record<string, DistortionAllowance> = {};
  const regions: ValidationCompanion["regions"] = {};
  const kindOf = (region: string) => (region.startsWith("joint:") ? "joint" : region.startsWith("garment") ? "garment" : "default");
  const allow = (region: string) => {
    allowances[region] ??= { ...KIND_ALLOWANCES[kindOf(region)], ...(declared?.allowances?.[kindOf(region)] ?? {}), ...(declared?.allowances?.[region] ?? {}) };
  };
  allow("default");
  const skin: Record<string, number[]> = {};
  for (const r of rig.solver.regions) {
    const name = `joint:${r.joint}`;
    allow(name);
    (skin[name] ??= []).push(...r.triangles.filter((t) => !Object.values(skin).some((list) => list.includes(t))));
  }
  regions[`${built.skin.slot}/${built.skin.attachment}`] = { default: "default", triangles: skin };
  for (const g of built.garments) {
    const name = `garment:${g.slot}`;
    allow(name);
    regions[`${g.slot}/${g.attachment}`] = { default: name, triangles: {} };
  }
  return {
    format: COMPANION_FORMAT,
    version: 1,
    rigHash: rigHash(rig.document),
    gameScale: preset.gamePixels / preset.figureHeight,
    allowances,
    regions,
    exceptions: declared?.exceptions ?? [],
    poses: companionPoses(rig)
  };
}

/** The surface-gate side of the unified validator: every companion pose through the rig's Poser. */
export function surfaceDistortion(rig: SurfaceRig, companion: ValidationCompanion = validationCompanion(rig)): { findings: GeometryFinding[]; stats: Map<string, PoseStats> } {
  const poser = new Poser(rig.document, rig.built);
  poser.pose({});
  const evaluator = new GeometryEvaluator(poser.skeleton as Skeleton, companion);
  const findings: GeometryFinding[] = [];
  const stats = new Map<string, PoseStats>();
  for (const pose of companion.poses) {
    poser.pose(joinPose(pose.rotate, pose.scale));
    stats.set(pose.name, evaluator.evaluate(poser.skeleton, pose.name, findings));
  }
  return { findings, stats };
}
