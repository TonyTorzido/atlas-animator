/*
 * Atlas Animator: original implementation.
 *
 * Corrective baking (pass 3b; consult 2, sections 3 and 6). The target shape at a
 * pose comes from the surface solver (solver.ts: procedural boundary curves plus the constrained
 * interior solve, reached by feasible continuation). Residuals are baked against the exact runtime
 * evaluator (the Skeleton with every correction that stays active), encoded per influence in its
 * bone space (Poser.encode: each influence's inverse current linear transform applied to the
 * displacement; weights are normalised, so the blend reproduces it exactly):
 * - residual hierarchy: single-driver keys against linear blend skinning first; then each grid,
 *   in preset order, holds only what the single keys and the earlier grids leave at its nodes;
 * - adaptive refinement: the runtime is evaluated between seeds (every degree) and inside grid
 *   cells (centres and edge midpoints) against the solved targets; a failing interval gets a seed at
 *   its worst sample, a failing cell a key line through its centre while the grid is under the
 *   4x3 cap; where the cap binds, or a target cannot be solved, it is reported, never forced.
 */
import { inContactBand, type ContactBandData } from "../contactBand.js";
import { loadAnimDocument } from "../../core/formatLoader.js";
import type { AnimDocument } from "../../core/format.js";
import { Skeleton } from "../../core/skeleton.js";
import type { MeshAttachment } from "../../core/attachments.js";
import { type Pt } from "./geometry.js";
import { AREA_FLOOR, type BuiltSurface, type BuiltMesh } from "./build.js";
import { SurfaceSolver, type PoseTarget } from "./solver.js";
import { insideLimits, reachAlong, type PoseLimit } from "./limits.js";

/**
 * A pose: bone rotation deltas (degrees) by bone name, plus optional scale factors keyed
 * `<bone>.scaleX` / `<bone>.scaleY` (multiplying the setup scale; simultaneous drivers).
 */
export type Pose = Record<string, number>;

/** A pose's rotation deltas and scale factors (see Pose). */
export function splitPose(pose: Pose): { rotate: Record<string, number>; scale: Record<string, { x: number; y: number }> } {
  const rotate: Record<string, number> = {};
  const scale: Record<string, { x: number; y: number }> = {};
  for (const [key, v] of Object.entries(pose)) {
    const m = /^(.+)\.scale([XY])$/.exec(key);
    if (!m) rotate[key] = v;
    else {
      const s = (scale[m[1] as string] ??= { x: 1, y: 1 });
      if (m[2] === "X") s.x = v;
      else s.y = v;
    }
  }
  return { rotate, scale };
}

/** The inverse of splitPose. */
export function joinPose(rotate: Record<string, number>, scale?: Record<string, { x: number; y: number }>): Pose {
  const out: Pose = { ...rotate };
  for (const [bone, s] of Object.entries(scale ?? {})) {
    out[`${bone}.scaleX`] = s.x;
    out[`${bone}.scaleY`] = s.y;
  }
  return out;
}

/** Seeds for a corrective: explicit, else spread over the bone's limits at about `spacing` with 0 included. */
export function seedAngles(at: number[] | undefined, limits: [number, number] | undefined, spacing = 30): number[] {
  if (at) return [...at].sort((a, b) => a - b);
  if (!limits) throw new Error("a corrective without `at` needs bone limits");
  const out = new Set<number>([limits[0], 0, limits[1]]);
  for (const end of [limits[0], limits[1]]) {
    const n = Math.floor(Math.abs(end) / spacing);
    for (let k = 1; k <= n; k++) out.add(Math.sign(end) * k * spacing);
  }
  return [...out].filter((a) => a >= limits[0] && a <= limits[1]).sort((a, b) => a - b);
}

export class Poser {
  readonly skeleton: Skeleton;
  constructor(readonly doc: AnimDocument, readonly built: BuiltSurface) {
    this.skeleton = new Skeleton(doc);
    this.skeleton.setActiveSkins(Object.keys(doc.skins));
  }
  pose(pose: Pose): void {
    this.skeleton.setToSetupPose();
    const { rotate, scale } = splitPose(pose);
    for (const [bone, delta] of Object.entries(rotate)) {
      const b = this.skeleton.getBone(bone);
      b.pose.rotation = b.data.rotation + delta;
    }
    for (const [bone, s] of Object.entries(scale)) {
      const b = this.skeleton.getBone(bone);
      b.pose.scaleX = b.data.scaleX * s.x;
      b.pose.scaleY = b.data.scaleY * s.y;
    }
    this.skeleton.updateWorldTransform("none");
  }
  /** World (canvas) vertices of a built mesh at the current pose. */
  vertices(mesh: BuiltMesh): Pt[] {
    const slot = this.skeleton.getSlot(mesh.slot);
    const attachment = this.skeleton.getAttachment(slot, mesh.attachment) as MeshAttachment;
    const world = this.skeleton.meshWorldVertices(attachment, slot.bone);
    const ox = this.doc.canvas.originX;
    const oy = this.doc.canvas.originY;
    return mesh.points.map((_, i) => [(world[i * 2] as number) + ox, (world[i * 2 + 1] as number) + oy]);
  }
  /** Per-influence bone-space offsets realising world displacements `d` at the current pose. */
  encode(mesh: BuiltMesh, d: Pt[]): number[] {
    const out: number[] = [];
    mesh.weights.forEach((inf, i) => {
      const [dx, dy] = d[i] as Pt;
      for (const [b] of inf) {
        const w = this.skeleton.getBone(mesh.bones[b] as string).world;
        const det = w.a * w.d - w.b * w.c;
        if (!(Math.abs(det) > 1e-9)) throw new Error(`encode: bone '${mesh.bones[b]}' has a singular world transform`);
        out.push(Number(((w.d * dx - w.b * dy) / det).toFixed(4)), Number(((-w.c * dx + w.a * dy) / det).toFixed(4)));
      }
    });
    return out;
  }
}

const isZero = (v: number[]) => v.every((x) => Math.abs(x) < 1e-4);

/** Dense lattice of the grid node search: driver step along x (degrees) and rows across y. */
const RELOCATE_X_STEP = 3;
const RELOCATE_Y_ROWS = 8;

/**
 * Grid node placement by the silhouette residual (pass 3d-1): on a fixed lattice
 * (x every RELOCATE_X_STEP degrees, RELOCATE_Y_ROWS + 1 rows plus the node rows; targets solved by
 * continuation along each row, inside the pose limits), every interior node of each axis moves, one
 * at a time, to the lattice value whose bake gives the smallest worst residual of the free hull
 * vertices (runtime against the solved target), until no move improves it. End nodes stay. Mutates
 * `xs`/`ys` and leaves the grid baked at the result; returns a report line ('' when nothing moved).
 */
function relocateGridNodes(S: SurfaceSolver, built: BuiltSurface, g: { name: string; x: { bone: string }; y: { bone: string } }, xs: number[], ys: number[], inside: (pose: Pose) => boolean, bake: () => void, poserFor: () => Poser): string {
  const H = built.skin.hull;
  const lo = (a: number[]) => a[0] as number;
  const hi = (a: number[]) => a[a.length - 1] as number;
  const uniq = (v: number[]) => [...new Set(v.map((x) => Number(x.toFixed(4))))].sort((a, b) => a - b);
  const latticeX = uniq([...Array.from({ length: Math.floor((hi(xs) - lo(xs)) / RELOCATE_X_STEP) + 1 }, (_, k) => lo(xs) + k * RELOCATE_X_STEP), ...xs]);
  const latticeY = uniq([...Array.from({ length: RELOCATE_Y_ROWS + 1 }, (_, k) => lo(ys) + ((hi(ys) - lo(ys)) * k) / RELOCATE_Y_ROWS), ...ys]);
  const samples: PoseTarget[] = [];
  for (const y of latticeY) {
    const row = latticeX.map((x) => ({ [g.x.bone]: x, [g.y.bone]: y })).filter((p) => inside(p));
    if (row.length) for (const t of S.along(row)) if (t.ok) samples.push(t);
  }
  const score = (): number => {
    const poser = poserFor();
    let worst = 0;
    for (const t of samples) {
      poser.pose(t.pose);
      const x = poser.vertices(built.skin);
      for (let i = 0; i < H; i++) if (t.curve[i]) worst = Math.max(worst, Math.hypot((x[i] as Pt)[0] - (t.x[i] as Pt)[0], (x[i] as Pt)[1] - (t.x[i] as Pt)[1]));
    }
    return worst;
  };
  const before = score();
  let best = before;
  const start = `x ${xs.join(", ")}; y ${ys.join(", ")}`;
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const [axis, lattice] of [[xs, latticeX], [ys, latticeY]] as [number[], number[]][]) {
      for (let i = 1; i + 1 < axis.length; i++) {
        let keep = axis[i] as number;
        for (const v of lattice) {
          if (v <= (axis[i - 1] as number) || v >= (axis[i + 1] as number) || v === keep) continue;
          axis[i] = v;
          bake();
          const s = score();
          if (s < best - 1e-6) {
            best = s;
            keep = v;
            improved = true;
          }
        }
        axis[i] = keep;
      }
    }
    if (!improved) break;
  }
  bake();
  const end = `x ${xs.join(", ")}; y ${ys.join(", ")}`;
  return end === start ? "" : `nodes moved by the silhouette residual (${start} -> ${end}; worst hull residual ${before.toFixed(2)} -> ${best.toFixed(2)} canvas px over ${samples.length} lattice targets)`;
}

/** Largest grid (plan 4d: at most 4x3 keys per grid). */
export const GRID_CAP: [number, number] = [4, 3];

/** Runtime vs target at one pose: validity, silhouette, aggregate joint areas. */
export interface PoseCheck {
  pose: Pose;
  minRatio: number;
  /** Free hull vertices: distance to the target hull polyline (canvas px). */
  shape: number;
  /** Free vertices: distance to their solved target (canvas px). */
  vertex: number;
  areas: number[];
  pass: boolean;
  why: string;
}

export function checkPose(solver: SurfaceSolver, poser: Poser, target: PoseTarget): PoseCheck {
  poser.pose(target.pose);
  const x = poser.vertices(solver.built.skin);
  const min = solver.solver.minRatio(x).min;
  const sil = solver.silhouetteError(x, target);
  let vertex = 0;
  solver.free.forEach((f, i) => {
    if (f) vertex = Math.max(vertex, Math.hypot((x[i] as Pt)[0] - (target.x[i] as Pt)[0], (x[i] as Pt)[1] - (target.x[i] as Pt)[1]));
  });
  const areas = solver.solver.regionAreas(x);
  const why: string[] = [];
  if (!(min > AREA_FLOOR)) why.push(`det ${min.toFixed(3)}`);
  if (sil.shape > solver.silhouette) why.push(`silhouette ${sil.shape.toFixed(2)} px`);
  areas.forEach((a, k) => {
    const r = solver.regions[k] as { joint: string; band: [number, number] };
    if (a < r.band[0] || a > r.band[1]) why.push(`${r.joint} area ${a.toFixed(3)}`);
  });
  return { pose: target.pose, minRatio: min, shape: sil.shape, vertex, areas, pass: why.length === 0, why: why.join(", ") };
}

export interface BakeReport {
  /** Wall time of target solving plus baking (ms). */
  ms: number;
  singles: { name: string; bone: string; seeds: number[]; added: number[]; samples: number; failing: number; worst: string }[];
  grids: { name: string; x: number[]; y: number[]; added: string[]; capBinds: string[]; samples: number; failing: number; worst: string }[];
  /** Seed or node targets the solver could not reach within the envelope (reported, not baked). */
  unsolved: string[];
  /** Seeds, grid nodes and cells outside the combined pose limits (pass 3d-1): never checked; nodes are baked only to support interpolation inside. */
  unreachable: string[];
  /** Runtime between keys and inside cells (not at seeds): the interpolation gate. */
  interpolation: { samples: number; failing: number; minRatio: number; worstShape: number; worstVertex: number; worstAt: string };
}

const label = (pose: Pose) => SurfaceSolver.key(pose) || "setup";

/** Largest runtime second difference across a key the refinement accepts (game px per (2 deg)^2; the temporal gate allows 0.25). */
export const KINK_LIMIT = 0.2;
/** Driver step of the kink measure where no declared sweep moves the bone across the key (degrees). */
export const KINK_STEP = 2;

/** Finest step of the preset's sweeps that move `bone` across driver value `at` (else KINK_STEP): the step the temporal gate will see there. */
export function sweepStepAt(preset: BuiltSurface["preset"], bone: string, at: number): number {
  let step = Infinity;
  for (const sw of preset.sweeps) for (const ph of sw.phases) if (ph.bone === bone && at > Math.min(ph.from, ph.to) && at < Math.max(ph.from, ph.to)) step = Math.min(step, Math.abs(ph.step));
  return Number.isFinite(step) ? step : KINK_STEP;
}

/** Runtime second difference of every skin vertex across driver value `at` of `bone` at driver step `h` (canvas px, normalised to (2 deg)^2 as the temporal gate), other drivers held in `hold`. */
export function kinkAt(poser: Poser, bone: string, at: number, h = KINK_STEP, hold: Pose = {}): number {
  const xs = [at - h, at, at + h].map((a) => {
    poser.pose({ ...hold, [bone]: a });
    return poser.vertices(poser.built.skin);
  });
  const [a, b, c] = xs as [Pt[], Pt[], Pt[]];
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.hypot((a[i] as Pt)[0] - 2 * (b[i] as Pt)[0] + (c[i] as Pt)[0], (a[i] as Pt)[1] - 2 * (b[i] as Pt)[1] + (c[i] as Pt)[1]));
  return m * (2 / h) ** 2;
}

/** Residual of `target` against the runtime of `doc` at the target's pose, encoded per influence in bone space. */
export function bakeResidual(doc: AnimDocument, built: BuiltSurface, target: { pose: Pose; x: Pt[] }): { d: Pt[]; encoded: number[]; max: number } {
  const poser = new Poser(doc, built);
  poser.pose(target.pose);
  const got = poser.vertices(built.skin);
  const d = target.x.map((t, i) => [t[0] - (got[i] as Pt)[0], t[1] - (got[i] as Pt)[1]] as Pt);
  return { d, encoded: poser.encode(built.skin, d), max: Math.max(...d.map(([x, y]) => Math.hypot(x, y))) };
}

/** Adds `driven` and `drivenGrids` (skin mesh; embedded garments follow it) baked from solved targets. */
export function seedCorrectives(built: BuiltSurface, solver?: SurfaceSolver, limitsIn: readonly PoseLimit[] = []): { document: Record<string, unknown>; report: string[]; bake: BakeReport; solver: SurfaceSolver } {
  const started = Date.now();
  const preset = built.preset;
  const skin = built.skin;
  const skinName = preset.skinName ?? "body";
  const gameScale = preset.gamePixels / preset.figureHeight;
  const tolerance = 0.25 / gameScale; // 0.25 game px in canvas px
  const S = solver ?? new SurfaceSolver(built, { silhouette: tolerance });
  const deform = (vertices: number[]) => (isZero(vertices) ? {} : { [skinName]: { [skin.slot]: { [skin.attachment]: { offset: 0, vertices } } } });
  const report: string[] = [];
  const unsolved: string[] = [];
  const unreachable: string[] = [];
  const inside = (pose: Pose) => insideLimits(limitsIn, pose);
  const interp = { samples: 0, failing: 0, minRatio: Infinity, worstShape: 0, worstVertex: 0, worstAt: "" };
  const note = (c: PoseCheck) => {
    interp.samples++;
    if (!c.pass) interp.failing++;
    interp.minRatio = Math.min(interp.minRatio, c.minRatio);
    interp.worstVertex = Math.max(interp.worstVertex, c.vertex);
    if (c.shape > interp.worstShape) {
      interp.worstShape = c.shape;
      interp.worstAt = label(c.pose);
    }
  };
  const docWith = (driven: unknown[], grids: unknown[]) => loadAnimDocument({ ...built.document, driven, drivenGrids: grids });
  const unsolvedNote = (what: string, t: PoseTarget) => {
    const msg = `${what}: ${t.reason}`;
    if (!unsolved.includes(msg)) unsolved.push(msg);
  };
  // A reachable sample whose target does not solve is a certification failure (never skipped):
  // it counts as failing in the sample totals and is listed with the unsolved targets.
  const unsolvedCheck = (what: string, t: PoseTarget): PoseCheck => {
    unsolvedNote(what, t);
    return { pose: t.pose, minRatio: Infinity, shape: 0, vertex: 0, areas: [], pass: false, why: `unsolved target (${t.reason})` };
  };

  // --- single-driver keys (against linear blend skinning), refined between seeds ---------------
  const singles: BakeReport["singles"] = [];
  const driven: Record<string, unknown>[] = [];
  for (const c of preset.correctives) {
    const limits = preset.bones.find((b) => b.name === c.bone)?.limits as [number, number] | undefined;
    const poseLimits = limitsIn;
    const declared = seedAngles(c.at, limits, c.spacing);
    const [lo0, hi0] = limits ?? [Math.min(...declared), Math.max(...declared)];
    // Only reachable driver values (others at setup): a seed outside the pose limits moves to the
    // farthest reachable value on its side.
    const lo = reachAlong(poseLimits, c.bone, lo0);
    const hi = reachAlong(poseLimits, c.bone, hi0);
    const seeds = new Set<number>([0]);
    for (const a of declared) {
      if (a >= lo && a <= hi) seeds.add(a);
      else {
        seeds.add(a < 0 ? lo : hi);
        unreachable.push(`${c.name} seed ${a} -> ${a < 0 ? lo : hi}`);
      }
    }
    // Dense targets by continuation outwards from the setup pose, one degree apart.
    const dense = new Map<number, PoseTarget>();
    for (const dir of [1, -1]) {
      const end = dir > 0 ? hi : lo;
      const angles: number[] = [];
      for (let a = 0; dir > 0 ? a <= end + 1e-9 : a >= end - 1e-9; a += dir) angles.push(Number(a.toFixed(6)));
      if (Math.abs((angles[angles.length - 1] as number) - end) > 1e-9) angles.push(end);
      S.along(angles.map((a) => (a === 0 ? {} : { [c.bone]: a }))).forEach((t, k) => dense.set(angles[k] as number, t));
    }
    const added: number[] = [];
    let keys: { at: number; deform: unknown }[] = [];
    const bake = () => {
      const base = docWith([], []);
      keys = [];
      for (const at of [...seeds].sort((a, b) => a - b)) {
        if (at === 0) {
          keys.push({ at, deform: {} });
          continue;
        }
        const t = dense.get(at) ?? S.solve({ [c.bone]: at });
        if (!t.ok) {
          unsolvedNote(`${c.name} @ ${at}`, t);
          continue;
        }
        keys.push({ at, deform: deform(bakeResidual(base, built, t).encoded) });
      }
    };
    bake();
    let checks: PoseCheck[] = [];
    for (let round = 0; round < 8; round++) {
      const poser = new Poser(docWith([{ name: c.name, bone: c.bone, keys }], []), built);
      checks = [...dense.entries()].filter(([a, t]) => t.ok && !seeds.has(a)).map(([, t]) => checkPose(S, poser, t));
      const sorted = [...seeds].sort((a, b) => a - b);
      const worstPerInterval = new Map<number, PoseCheck>();
      const score = (ch: PoseCheck) => ch.shape / S.silhouette + Math.max(0, AREA_FLOOR + 0.05 - ch.minRatio) * 100;
      for (const ch of checks) {
        if (ch.pass) continue;
        const a = ch.pose[c.bone] as number;
        const k = sorted.findIndex((s, i) => a > s && a < (sorted[i + 1] ?? Infinity));
        const prev = worstPerInterval.get(k);
        if (!prev || score(ch) > score(prev)) worstPerInterval.set(k, ch);
      }
      let grew = false;
      for (const [k, ch] of worstPerInterval) {
        const a = ch.pose[c.bone] as number;
        const l = sorted[k] as number;
        const r = sorted[k + 1] as number;
        // The worst sample, pulled to the interval's middle when it hugs a seed (a bisection step).
        const pick = Math.round(Math.abs(a - l) < (r - l) / 4 || Math.abs(r - a) < (r - l) / 4 ? (l + r) / 2 : a);
        if (pick <= l || pick >= r || !dense.get(pick)?.ok) continue;
        seeds.add(pick);
        added.push(pick);
        grew = true;
      }
      // Kinks: linear keys turn the residual's slope at every key; where the runtime's second
      // difference across a key exceeds KINK_LIMIT (the temporal gate's measure at the densest
      // sweep step), both neighbouring intervals are bisected.
      for (let k = 1; k + 1 < sorted.length; k++) {
        const at = sorted[k] as number;
        if (kinkAt(poser, c.bone, at, sweepStepAt(preset, c.bone, at)) <= KINK_LIMIT / gameScale) continue;
        for (const [l, r] of [[sorted[k - 1] as number, at], [at, sorted[k + 1] as number]] as [number, number][]) {
          const pick = Math.round((l + r) / 2);
          if (pick <= l || pick >= r || seeds.has(pick) || !dense.get(pick)?.ok) continue;
          seeds.add(pick);
          added.push(pick);
          grew = true;
        }
      }
      // Silhouette residual (pass 3d-2): validity alone added no key where the baked
      // interpolation lets the free hull vertices drift from the solved target and back; the temporal
      // gate sees that as a residual jump between sweep frames. Where the curve-vertex residual changes
      // by more than KINK_LIMIT over the sweep step, the interval gets a key at the jump.
      const residualAt = new Map<number, Pt[]>();
      const residualOf = (a: number) => {
        let r = residualAt.get(a);
        if (r) return r;
        const t = dense.get(a) as PoseTarget;
        poser.pose(t.pose);
        const x = poser.vertices(skin);
        r = x.map((p, i) => (t.curve[i] ? ([p[0] - (t.x[i] as Pt)[0], p[1] - (t.x[i] as Pt)[1]] as Pt) : ([0, 0] as Pt)));
        residualAt.set(a, r);
        return r;
      };
      const jumpPicks = new Map<number, { at: number; jump: number }>();
      for (const [a, t] of dense) {
        const h = sweepStepAt(preset, c.bone, a);
        const b = Number((a + h).toFixed(6));
        const tb = dense.get(b);
        if (!t.ok || !tb?.ok) continue;
        const ra = residualOf(a);
        const rb = residualOf(b);
        let jump = 0;
        ra.forEach((p, i) => (jump = Math.max(jump, Math.hypot(p[0] - (rb[i] as Pt)[0], p[1] - (rb[i] as Pt)[1]))));
        if (jump * gameScale <= KINK_LIMIT) continue;
        const k = sorted.findIndex((s, i) => a >= s && a < (sorted[i + 1] ?? Infinity));
        if (k < 0 || !(jump > (jumpPicks.get(k)?.jump ?? 0))) continue;
        jumpPicks.set(k, { at: Math.round(a + h / 2), jump });
      }
      for (const [k, p] of jumpPicks) {
        const l = sorted[k] as number;
        const r = sorted[k + 1] as number;
        const pick = p.at <= l || p.at >= r ? Math.round((l + r) / 2) : p.at;
        if (pick <= l || pick >= r || seeds.has(pick) || !dense.get(pick)?.ok) continue;
        seeds.add(pick);
        added.push(pick);
        grew = true;
      }
      if (!grew) break;
      bake();
    }
    for (const [a, t] of dense) if (!t.ok && !seeds.has(a) && inside(t.pose)) checks.push(unsolvedCheck(`${c.name} @ ${a}`, t));
    checks.forEach(note);
    const failing = checks.filter((x) => !x.pass);
    const worst = [...failing].sort((x, y) => y.shape - x.shape)[0];
    singles.push({ name: c.name, bone: c.bone, seeds: keys.map((k) => k.at), added: added.sort((a, b) => a - b), samples: checks.length, failing: failing.length, worst: worst ? `${label(worst.pose)}: ${worst.why}` : "" });
    report.push(`corrective ${c.name}: keys ${keys.map((k) => k.at).join(", ")}${added.length ? ` (refinement added ${added.join(", ")})` : ""}; ${checks.length} samples between keys, ${failing.length} failing${worst ? ` (worst ${label(worst.pose)}: ${worst.why})` : ""}`);
    driven.push({ name: c.name, bone: c.bone, keys });
  }

  // --- two-driver grids: residual hierarchy, refined inside cells under the cap ----------------
  const grids: Record<string, unknown>[] = [];
  const gridReport: BakeReport["grids"] = [];
  for (const g of preset.grids) {
    const xs = [...g.x.at].sort((a, b) => a - b);
    const ys = [...g.y.at].sort((a, b) => a - b);
    const added: string[] = [];
    const capBinds: string[] = [];
    const cap: [number, number] = g.cap ?? GRID_CAP;
    let keys: { deform: unknown }[] = [];
    const bake = () => {
      const base = docWith(driven, grids);
      keys = [];
      // A node outside the pose limits is unreachable: never checked, but baked when its target
      // solves (it supports the interpolation of the reachable part of its cells); otherwise it
      // copies the nearest reachable node of its row (or column), never an empty key.
      const encoded: (number[] | null)[] = [];
      for (const y of ys) {
        for (const x of xs) {
          const pose = { [g.x.bone]: x, [g.y.bone]: y };
          const t = S.solve(pose);
          const reach = inside(pose);
          if (!reach) {
            const note = `${g.name} node ${label(pose)}${t.ok ? " (baked for interpolation)" : " (unsolvable; copies a reachable neighbour)"}`;
            if (!unreachable.includes(note)) unreachable.push(note);
          } else if (!t.ok) unsolvedNote(`${g.name} node ${label(t.pose)}`, t);
          encoded.push(t.ok ? bakeResidual(base, built, t).encoded : null);
        }
      }
      const at = (i: number, j: number) => encoded[j * xs.length + i];
      for (let j = 0; j < ys.length; j++) {
        for (let i = 0; i < xs.length; i++) {
          let e = at(i, j);
          if (!e && !inside({ [g.x.bone]: xs[i] as number, [g.y.bone]: ys[j] as number })) {
            const order = [...xs.keys()].filter((k) => k !== i).sort((a, b) => Math.abs(a - i) - Math.abs(b - i));
            for (const k of order) if ((e = at(k, j) ?? null)) break;
            if (!e) for (const k of [...ys.keys()].filter((k) => k !== j).sort((a, b) => Math.abs(a - j) - Math.abs(b - j))) if ((e = at(i, k) ?? null)) break;
          }
          keys.push({ deform: e ? deform(e) : {} });
        }
      }
    };
    bake();
    const gridDoc = () => ({ name: g.name, x: { bone: g.x.bone, at: [...xs] }, y: { bone: g.y.bone, at: [...ys] }, keys });
    let checks: PoseCheck[] = [];
    const cellChecks = () => {
      const poser = new Poser(docWith(driven, [...grids, gridDoc()]), built);
      checks = [];
      const cellFails: { i: number; j: number; check: PoseCheck }[] = [];
      for (let j = 0; j + 1 < ys.length; j++) {
        for (let i = 0; i + 1 < xs.length; i++) {
          const xa = xs[i] as number;
          const xb = xs[i + 1] as number;
          const ya = ys[j] as number;
          const yb = ys[j + 1] as number;
          const xm = (xa + xb) / 2;
          const ym = (ya + yb) / 2;
          const corners = [[xa, ya], [xb, ya], [xa, yb], [xb, yb]].filter(([x, y]) => inside({ [g.x.bone]: x as number, [g.y.bone]: y as number })).length;
          const samples: [number, number][] = [[xm, ym], [xm, ya], [xm, yb], [xa, ym], [xb, ym]];
          if (corners === 0) {
            const cell = `${g.name} cell ${g.x.bone} [${xa}, ${xb}] x ${g.y.bone} [${ya}, ${yb}]`;
            if (!unreachable.includes(cell)) unreachable.push(cell);
          } else if (corners < 4) {
            // A cell the limit cuts: its reachable part is sampled on the quarter lattice too.
            for (const u of [0.25, 0.5, 0.75]) for (const v of [0.25, 0.5, 0.75]) if (u !== 0.5 || v !== 0.5) samples.push([xa + (xb - xa) * u, ya + (yb - ya) * v]);
          }
          for (const [x, y] of samples) {
            if (!inside({ [g.x.bone]: x, [g.y.bone]: y })) continue;
            const t = S.solve({ [g.x.bone]: x, [g.y.bone]: y });
            if (!t.ok) {
              // Not a refinement target (a finer grid cannot fix a target that does not solve).
              checks.push(unsolvedCheck(`${g.name} cell sample ${label(t.pose)}`, t));
              continue;
            }
            const ch = checkPose(S, poser, t);
            checks.push(ch);
            if (!ch.pass) cellFails.push({ i, j, check: ch });
          }
        }
      }
      return cellFails;
    };
    for (let round = 0; round < cap[0] + cap[1]; round++) {
      const cellFails = cellChecks();
      if (!cellFails.length) break;
      const worst = [...cellFails].sort((p, q) => q.check.shape - p.check.shape)[0] as (typeof cellFails)[number];
      const canX = xs.length < cap[0];
      const canY = ys.length < cap[1];
      if (canX && (!canY || cellFails.filter((f) => f.i === worst.i).length >= cellFails.filter((f) => f.j === worst.j).length)) {
        const xm = Math.round(((xs[worst.i] as number) + (xs[worst.i + 1] as number)) / 2);
        xs.push(xm);
        xs.sort((a, b) => a - b);
        added.push(`${g.x.bone} ${xm}`);
      } else if (canY) {
        const ym = Math.round(((ys[worst.j] as number) + (ys[worst.j + 1] as number)) / 2);
        ys.push(ym);
        ys.sort((a, b) => a - b);
        added.push(`${g.y.bone} ${ym}`);
      } else {
        for (const f of cellFails) {
          const cell = `${g.x.bone} [${xs[f.i]}, ${xs[f.i + 1]}] x ${g.y.bone} [${ys[f.j]}, ${ys[f.j + 1]}]`;
          if (!capBinds.includes(cell)) capBinds.push(cell);
        }
        break;
      }
      bake();
    }
    // At the cap with failing cells: move the interior nodes to where the silhouette residual is
    // smallest (coordinate descent on a fixed dense lattice of solved targets), then recheck.
    let moved = "";
    if (capBinds.length) {
      moved = relocateGridNodes(S, built, g, xs, ys, inside, bake, () => new Poser(docWith(driven, [...grids, gridDoc()]), built));
      capBinds.length = 0;
      const fails = cellChecks();
      for (const f of fails) {
        const cell = `${g.x.bone} [${xs[f.i]}, ${xs[f.i + 1]}] x ${g.y.bone} [${ys[f.j]}, ${ys[f.j + 1]}]`;
        if (!capBinds.includes(cell)) capBinds.push(cell);
      }
      if (moved) added.push(moved);
    }
    checks.forEach(note);
    const failing = checks.filter((x) => !x.pass);
    const worst = [...failing].sort((x, y) => y.shape - x.shape)[0];
    grids.push({ name: g.name, x: { bone: g.x.bone, at: xs }, y: { bone: g.y.bone, at: ys }, keys });
    gridReport.push({ name: g.name, x: xs, y: ys, added, capBinds, samples: checks.length, failing: failing.length, worst: worst ? `${label(worst.pose)}: ${worst.why}` : "" });
    report.push(`grid ${g.name}: ${xs.length}x${ys.length} keys (x ${xs.join(", ")}; y ${ys.join(", ")})${added.length ? `, refinement added ${added.join(", ")}` : ""}; ${checks.length} cell samples, ${failing.length} failing${worst ? ` (worst ${label(worst.pose)}: ${worst.why})` : ""}${capBinds.length ? `; ${cap[0]}x${cap[1]} cap binds at ${capBinds.join("; ")}` : ""}`);
  }
  if (unsolved.length) report.push(`unsolved targets (reported, not baked): ${unsolved.join(" | ")}`);
  if (unreachable.length) report.push(`outside the pose limits (never checked): ${unreachable.join(" | ")}`);
  const bakeReport: BakeReport = {
    ms: Date.now() - started,
    singles,
    grids: gridReport,
    unsolved,
    unreachable,
    interpolation: { ...interp, minRatio: Number(interp.minRatio.toFixed(3)), worstShape: Number(interp.worstShape.toFixed(3)), worstVertex: Number(interp.worstVertex.toFixed(3)) }
  };
  report.push(`solve + bake: ${(bakeReport.ms / 1000).toFixed(1)} s`);
  return { document: { ...built.document, driven, drivenGrids: grids }, report, bake: bakeReport, solver: S };
}

/** Sweeps as clips: one frame per sample at `fps` (the clip's displayed rate), linear keys, offsets from setup. */
export function sweepClips(built: BuiltSurface, fps = 30, limits: readonly PoseLimit[] = [], bands: readonly ContactBandData[] = []): { clips: Record<string, unknown>; frames: Record<string, Pose[]>; clipped: Record<string, number> } {
  const clips: Record<string, unknown> = {};
  const frames: Record<string, Pose[]> = {};
  const clipped: Record<string, number> = {};
  for (const sweep of built.preset.sweeps) {
    let poses: Pose[] = [];
    const hold = sweep.hold ?? {};
    for (const phase of sweep.phases) {
      const n = Math.max(1, Math.round(Math.abs(phase.to - phase.from) / phase.step));
      for (let k = 0; k <= n; k++) {
        if (k === 0 && poses.length > 0) continue;
        const base = poses.length ? { ...(poses[poses.length - 1] as Pose) } : { ...hold };
        base[phase.bone] = Number((phase.from + ((phase.to - phase.from) * k) / n).toFixed(4));
        poses.push(base);
      }
    }
    // Sweeps run only inside the pose limits: the longest run of consecutive reachable frames.
    const all = poses.length;
    let best: [number, number] = [0, 0];
    let start = -1;
    poses.forEach((p, i) => {
      if (insideLimits(limits, p)) {
        if (start < 0) start = i;
        if (i + 1 - start > best[1] - best[0]) best = [start, i + 1];
      } else start = -1;
    });
    poses = poses.slice(best[0], best[1]);
    // Ends are holds: trimmed out of any contact band (motion inside still crosses it).
    while (poses.length > 1 && bands.some((b) => inContactBand(b, poses[0] as Pose))) poses.shift();
    while (poses.length > 1 && bands.some((b) => inContactBand(b, poses[poses.length - 1] as Pose))) poses.pop();
    // A sweep entirely inside a band has no legal hold: rejected, never a forbidden 1-frame hold.
    if (poses.length && bands.some((b) => inContactBand(b, poses[0] as Pose))) throw new Error(`sweep '${sweep.name}': every frame inside the pose limits sits in a contact band`);
    if (!poses.length) throw new Error(`sweep '${sweep.name}': no frame inside the pose limits`);
    clipped[sweep.name] = all - poses.length;
    const bones = new Set(poses.flatMap((p) => Object.keys(p)));
    const timelines: Record<string, unknown> = {};
    for (const bone of bones) timelines[bone] = { rotate: poses.map((p, i) => ({ time: Number((i / fps).toFixed(6)), value: p[bone] ?? 0 })) };
    clips[sweep.name] = { duration: Number(((poses.length - 1) / fps).toFixed(6)), loop: false, fps, bones: timelines };
    frames[sweep.name] = poses;
  }
  return { clips, frames, clipped };
}
