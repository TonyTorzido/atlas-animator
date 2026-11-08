/*
 * Atlas Animator: original implementation.
 *
 * `animator surface <preset.json> --out <dir> [--demos <dir>] [--quick] [--calibrate-width <k>]`:
 * builds a continuous skin surface from a preset (src/tools/surface), writes the rig (document,
 * atlas, source SVG), runs the geometric contract gates over every sweep, and with --demos renders
 * every sweep through the game's Pixi renderer in two views (review, item 6): the joint
 * crop (the preset `frame`; game size DPR 1 shown 3x nearest, and the true 3x through DPR 3) and
 * the full figure (posed bounds + 20 canvas px; DPR 1 and DPR 3), on dark and light backgrounds,
 * fractional offsets and a saturated background; contact sheets and MP4s with every tile tagged
 * (scale, DPR, renderer, view); the coverage-aware 3x width gate with its committed calibration
 * pair (as is: p99 <= 0.25 game px; every contour x1.5: p99 >= 0.4) and the alpha-gap gate on
 * every frame at DPR 1 and 3. Writes `<preset>.gates.json`; exit 1 when a gate fails.
 * `--calibrate-width <k>` scales every contour width by k before everything (a deliberately bad
 * rig: with 1.5 the width gate must fail).
 */
import { execFileSync } from "node:child_process";
import { buildSparseRig, sparseReport } from "../tools/surface/sparse.js";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodePng, encodePng, writePng } from "../tools/png.js";
import type { MutableImage, RgbaImage } from "../tools/image.js";
import { grid } from "../tools/review.js";
import { loadPreset } from "../tools/surface/preset.js";
import { buildRig, writeRig, type SurfaceRig } from "../tools/surface/output.js";
import { STROKE_JOIN_ERROR, strokeJoinError } from "../core/contours.js";
import { knownGoodStroke, type VisibleSample } from "../tools/surface/gates.js";
import { KINK_SLACK, KINK_TURN, KINK_WINDOW } from "../tools/surface/gates.js";
import { alphaGaps, mergeOverlays, overlayInvisibility, clearanceContactPoints, clearanceHold, clearanceLimitOf, crackStreaks, errorStats, figureBounds, FLANK_TOLERANCE, geometryGates, MAX_JUMP, measureWidths, MIN_AREA_RATIO, SWELL_LIMIT, structureGates, type GeometryReport, type StructureReport } from "../tools/surface/gates.js";
import { Poser, type BakeReport } from "../tools/surface/correctives.js";
import { renderFrames, writeMp4, type RenderResult } from "./render.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { checkPoseLimits, type ValidationIssue } from "../tools/validate.js";
import { insideLimits, type PoseLimit } from "../tools/surface/limits.js";

export interface SurfaceOptions {
  /** Plan: reduce to the sparse runtime rig and gate that (the dense rig is the reference). */
  sparse?: boolean;
  /** With sparse: frames to time per rig in headless Chromium (relative frame cost). */
  bench?: number;
  preset: string;
  out: string;
  demos?: string;
  quick?: boolean;
  calibrateWidth?: number;
}

const MAX_WIDTH_ERROR = 0.25; // game px (p99), plan 4d; calibrated by the committed pair below
const BAD_WIDTH_SCALE = 1.5;
const BAD_WIDTH_MIN_P99 = 0.4;
const MAX_POP = 0.25; // game px
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));
const BACKGROUNDS = { dark: 0x1e2430, light: 0xf2f2f2, saturated: 0x2a7de1 } as const;
type Rect = { left: number; top: number; right: number; bottom: number };

/** One row of the plan's pass 3 gate table. */
export interface GateRow {
  gate: string;
  /** The sub-pass whose exit requires the row green. */
  subpass: "3a" | "3b" | "3c" | "3d" | "" | "" | "" | "all";
  status: "pass" | "fail" | "not measured";
  detail: string;
}

/** The gate table (pass 3): geometric and raster sections, separate pass/fail. */
export function gateTable(geo: GeometryReport, structure: StructureReport, images: Record<string, unknown> | undefined, bake?: BakeReport, limits?: LimitsReport): { geometric: GateRow[]; raster: GateRow[] } {
  const row = (gate: string, subpass: GateRow["subpass"], ok: boolean | null, detail: string): GateRow => ({ gate, subpass, status: ok === null ? "not measured" : ok ? "pass" : "fail", detail });
  const conn = structure.connectivity;
  const sup = structure.support;
  const own = structure.ownership;
  const reg = structure.registration;
  const apexOk = geo.apexMotion.every((a) => a.excess <= FLANK_TOLERANCE);
  const coverageOk = geo.coverage.every((c) => c.minOverlap >= c.required);
  const embedOk = geo.embed.every((e) => e.mismatches === 0);
  const pops = Math.max(0, ...geo.pops.map((p) => p.maxSecondDiffGamePx));
  const sh = geo.shape;
  const interp = bake?.interpolation;
  const unsolved = bake?.unsolved ?? [];
  const width = images?.width as { p99?: number; samples?: number; calibration?: Record<string, unknown> & { asIs?: { passes: boolean } } } | undefined;
  const seams = images?.alphaOnOverlapSeams as { pixels: number; streaks: number; longestDegrees: number; longestAt: string; capDegrees: number; over: string[] } | undefined;
  const bad = width?.calibration ? (Object.values(width.calibration).find((v) => typeof v === "object" && v !== null && "fails" in v) as { fails: boolean } | undefined) : undefined;
  const geometric: GateRow[] = [
    row(
      "connectivity",
      "3a",
      conn.meshes.every((m) => m.components === 1 && m.nonManifold === 0 && m.boundaryMismatch === 0) && conn.conformUnembedded.every((c) => c.vertices === 0) && geo.partitionMismatches === 0,
      `${conn.meshes.map((m) => `${m.mesh}: ${m.components} component(s), ${m.nonManifold} non-manifold, ${m.boundaryMismatch} boundary/hull mismatches`).join("; ")}; group boundary mismatches ${geo.partitionMismatches}; conform vertices not embedded ${JSON.stringify(conn.conformUnembedded)}`
    ),
    row(
      "weight support",
      "3a",
      sup.violations === 0 && geo.weightErrors.length === 0,
      `${sup.violations} forbidden influences${sup.first.length ? ` (${sup.first.join("; ")})` : ""}, ${sup.overlaps} vertices in a root patch and a hinge band (allowed; the band's mask applies), ${geo.weightErrors.length} weight errors; patches ${sup.patches.map((p) => `${p.name} ${p.side} extent ${p.extent}${p.ratio !== undefined ? ` (${p.ratio} W, W ${p.width})` : ""} ends s ${p.sEnd}`).join(", ")}; regions ${JSON.stringify(sup.regions)}`
    ),
    row(
      "fixed flank",
      "3a",
      geo.flankLock.maxDeviation <= FLANK_TOLERANCE && apexOk,
      `${geo.flankLock.vertices} fixed/anchored vertices, max deviation from their bone ${geo.flankLock.maxDeviation.toExponential(2)} canvas px (tolerance ${FLANK_TOLERANCE})${geo.flankLock.at ? ` at ${geo.flankLock.at}` : ""}; apex motion ${geo.apexMotion.map((a) => `max ${a.max.toFixed(2)} (allowance ${a.permitted}${a.maxAllowed > a.permitted + 1e-9 ? ` + girdle, up to ${a.maxAllowed.toFixed(2)}` : ""}; worst ${a.at})`).join(", ")}`
    ),
    row(
      `triangle validity > ${MIN_AREA_RATIO}`,
      "3b",
      geo.minAreaRatio > MIN_AREA_RATIO,
      `min area ratio ${geo.minAreaRatio.toFixed(3)} (${geo.minAreaAt}); below the floor: ${sh.flips} flipped and ${sh.collapses} collapsed triangle-frames (${geo.inverted.length} frames); inner transition (solver search over both root limits): ${sup.patches
        .filter((p) => p.side !== "both")
        .map((p) => `${p.name} ${p.ratio !== undefined ? `${p.ratio} W ` : ""}${p.feasible ? "feasible" : "infeasible"} (min ${p.minBlendRatio})`)
        .join(", ")}`
    ),
    row("global validity (no self-intersection per patch)", "3b", sh.selfIntersections === 0, `${sh.selfIntersections} boundary-edge crossings inside a joint region over every frame${sh.selfIntersectionAt ? ` (first ${sh.selfIntersectionAt})` : ""}`),
    row(
      "joint area (declared band, default +-10%)",
      "3b",
      sh.areas.every((a) => a.min >= a.band[0] && a.max <= a.band[1]),
      sh.areas.map((a) => `${a.joint} ${a.min}..${a.max} in [${a.band.join(", ")}] (min at ${a.minAt}; max at ${a.maxAt})`).join("; ")
    ),
    row(
      "silhouette <= 0.25 game px",
      "3b",
      sh.silhouette.gamePx <= sh.silhouette.limitGamePx && sh.lobes === 0 && sh.unsolvedFrames === 0 && unsolved.length === 0,
      `max ${sh.silhouette.gamePx} game px (${sh.silhouette.canvasPx} canvas px) against the procedural target${sh.silhouette.at ? ` at ${sh.silhouette.at}` : ""}; ${sh.lobes} reversing curves; ${sh.unsolvedFrames} sweep frames unsolved${sh.unsolvedFirst ? ` (${sh.unsolvedFirst})` : ""}; ${unsolved.length} key targets unsolved${unsolved.length ? ` (${unsolved.slice(0, 3).join(" | ")})` : ""}`
    ),
    row(
      "limb shape",
      "3b",
      sh.coreDeviation <= FLANK_TOLERANCE && sh.widths.outside === 0 && sh.widths.bindOutside === 0,
      `rigid cores: max deviation ${sh.coreDeviation.toExponential(2)} canvas px; hinge thickness ${sh.widths.min}..${sh.widths.max} canvas px over ${sh.widths.checked} checks, ${sh.widths.outside} outside the width envelope${sh.widths.worst ? ` (${sh.widths.worst})` : ""}, ${sh.widths.bindOutside} rows outside it at bind`
    ),
    row(
      `no swelling (cores <= bind +${SWELL_LIMIT * 100}% outside bulge zones)`,
      "3c",
      sh.swelling.checked > 0 && sh.swelling.outside === 0,
      `${sh.swelling.checked} row checks, ${sh.swelling.outside} over the limit${sh.swelling.worst ? ` (first ${sh.swelling.worst})` : ""}; largest growth outside bulge zones +${(sh.swelling.maxRatio * 100).toFixed(1)}%${sh.swelling.maxRatioAt ? ` at ${sh.swelling.maxRatioAt}` : ""}`
    ),
    row(
      "garment registration",
      "3a",
      embedOk && coverageOk && reg.conformCrossings.every((c) => c.crossing === 0),
      `embedded mismatches ${JSON.stringify(geo.embed)}; conform triangles crossing a skin edge ${JSON.stringify(reg.conformCrossings)}; coverage ${JSON.stringify(geo.coverage)}`
    ),
    row(
      `visible kink (<= ${KINK_TURN} deg over ${KINK_WINDOW} game px outside declared corners, or the bind turn + ${KINK_SLACK})`,
      "3d",
      geo.kinks.violations === 0,
      `${geo.kinks.checked} window checks, ${geo.kinks.violations} over${geo.kinks.first.length ? ` (${geo.kinks.first.join(" | ")})` : ""}; worst ${geo.kinks.worst} (excess ${((geo.kinks.maxExcess * 180) / Math.PI).toFixed(1)} deg)`
    ),
    ...geo.kinks.hard.map((h) =>
      row(
        `visible kink, hard: ${h.contour} (<= ${h.turn} deg over ${KINK_WINDOW} game px outside declared corners${Object.keys(h.when).length ? `, at ${Object.entries(h.when).map(([b, [lo, hi]]) => `${b} ${lo}..${hi}`).join(", ")}` : ""})`,
        "",
        h.checked > 0 && h.violations === 0,
        `${h.checked} window checks, ${h.violations} over; worst ${h.worst} (excess ${((h.maxExcess * 180) / Math.PI).toFixed(1)} deg); worst turn per sweep: ${Object.entries(h.bySweep).map(([sw, v]) => `${sw} ${v.worst} deg at ${v.at}${v.violations ? ` (${v.violations} over)` : ""}`).join(", ")}`
      )
    ),
    row(
      "junction (added concave turn at the limb/strap junction over the rest art, per-raise limit from the references, <= 35 deg / 3 game px)",
      "",
      geo.junctions.junction.violations === 0,
      `${geo.junctions.junction.checked} frame checks, ${geo.junctions.junction.violations} over${geo.junctions.junction.first.length ? ` (${geo.junctions.junction.first.join(" | ")})` : ""}; worst ${geo.junctions.junction.worst} (margin ${(-geo.junctions.junction.maxExcess).toFixed(1)} deg)`
    ),
    row(
      "strap/neck curve (turn within its allowance of the rest art; shrug neckline is)",
      "",
      geo.junctions.neck.violations === 0,
      `${geo.junctions.neck.checked} frame checks, ${geo.junctions.neck.violations} over${geo.junctions.neck.first.length ? ` (${geo.junctions.neck.first.join(" | ")})` : ""}; worst ${geo.junctions.neck.worst}`
    ),
    row(
      "partition hidden",
      "3d",
      geo.partitionHidden.every((c) => c.exposed === 0),
      geo.partitionHidden.length
        ? geo.partitionHidden.map((c) => (c.kind === "root" ? `root ${c.group} inside '${c.piece}' over every pose: ${c.samples} vertex checks, min depth ${c.minDepth}, ${c.exposed} exposed` : `${c.group} skin on '${c.piece}' at bind: ${c.samples} samples, min cover depth ${c.minDepth}, ${c.exposed} uncovered`) + (c.worst ? ` (worst ${c.worst})` : "")).join("; ")
        : "no group drawn above a garment piece lies on it, no root groups"
    ),
    row(
      "junction containment",
      "3d",
      geo.junctionContainment.every((c) => c.points.length > 0 && c.minDepth >= c.clearance),
      geo.junctionContainment.length
        ? geo.junctionContainment.map((c) => `${c.overlay}: ${c.points.length} points (${c.points.join(", ")}) over ${c.poses} poses (rest, sweeps, limit vertices), min depth ${c.minDepth} vs clearance ${c.clearance}${c.worst ? ` (worst ${c.worst})` : ""}`).join("; ")
        : "no overlays declared"
    ),
    row(
      "ends hidden or joined",
      "3d",
      geo.endsHidden.checked > 0 && geo.endsHidden.exposed === 0,
      `${geo.endsHidden.checked} contour-end checks over every frame (clearance ${geo.endsHidden.clearance} px under a higher garment, else a declared junction or a shared end): ${geo.endsHidden.exposed} exposed${geo.endsHidden.first.length ? ` (first ${geo.endsHidden.first.join(" | ")})` : ""}`
    ),
    row(
      "draw-group occlusion",
      "3a",
      geo.occlusion.every((o) => o.maxDepth <= o.limit),
      geo.occlusion.length ? geo.occlusion.map((o) => `${o.garment}: deepest ${o.maxDepth} <= ${o.limit}${o.at ? ` at ${o.at}` : ""}`).join("; ") : "no occlusion poses declared"
    ),
    row(
      "ownership",
      "3a",
      own.ownerMismatch === 0 && own.sharedSpans === 0 && own.looseEnds.length === 0 && geo.doubledAtRest.length === 0,
      `${own.ownerMismatch} contour segments over another group${own.ownerMismatchAt.length ? ` (${own.ownerMismatchAt.join("; ")})` : ""}, ${own.sharedSpans} shared spans, loose ends ${JSON.stringify(own.looseEnds)}, doubled at rest ${geo.doubledAtRest.length}, doubled in motion ${geo.doubled.length}`
    ),
    row(
      "interpolation",
      "3b",
      interp ? interp.samples > 0 && interp.failing === 0 : null,
      interp
        ? `${interp.samples} runtime samples between keys and inside grid cells, ${interp.failing} failing; min det ${interp.minRatio}, worst silhouette ${interp.worstShape} canvas px (${interp.worstAt}), worst vertex ${interp.worstVertex} canvas px; keys ${(bake?.singles ?? []).map((x) => `${x.name} [${x.seeds.join(", ")}]${x.added.length ? ` (+${x.added.join(", ")})` : ""}`).join(", ")}; grids ${(bake?.grids ?? []).map((g) => `${g.name} ${g.x.length}x${g.y.length}${g.capBinds.length ? ` (cap binds: ${g.capBinds.join("; ")})` : ""}`).join(", ")}`
        : "no bake report"
    ),
    row(
      "temporal",
      "3b",
      pops <= MAX_POP && sh.residualJumpGamePx <= MAX_JUMP,
      `max second difference ${pops} game px per (2 deg)^2 (limit ${MAX_POP}); largest frame-to-frame jump of the silhouette residual from the solved target ${sh.residualJumpGamePx} game px (limit ${MAX_JUMP})${sh.residualJumpAt ? ` at ${sh.residualJumpAt}` : ""}`
    ),
    row(
      "pose limits (sweeps, seeds and gates inside; validator flags clips outside)",
      "3d",
      limits ? limits.framesOutside === 0 && limits.validator.length === 0 && limits.validatorCatches : null,
      limits
        ? `${limits.limits.length ? limits.limits.map((l) => `${l.name} (${l.x} x ${l.y}) ${JSON.stringify(l.polygon)} [${l.source}]`).join("; ") : "none declared"}; sweep frames clipped ${JSON.stringify(limits.clipped)}; frames outside ${limits.framesOutside}; validator issues on the rig ${limits.validator.length}${limits.validator.length ? ` (${limits.validator[0]})` : ""}; validator flags a clip outside: ${limits.validatorCatches}; unreachable ${(bake?.unreachable ?? []).length ? (bake?.unreachable ?? []).join(" | ") : "none"}`
        : "not measured"
    ),
    row(
      `stroke clearance (no sub-pixel crack < ${Number(geo.clearance.limit.minGap.toFixed(2))} canvas px between near-parallel contours at any frame, at any displayed frame; declared contact pairs render merged (contour contacts), so they leave no sliver)`,
      "3d",
      geo.clearance.checked > 0 && geo.clearance.violations.length === 0 && geo.clearance.contactHolds.length === 0 && geo.clearance.passThroughHolds.length === 0,
      `contact bands ${JSON.stringify(geo.clearance.contacts)}, ${geo.clearance.contactCrossings} displayed motion frames cracking inside a band (fail), holds in a band ${geo.clearance.contactHolds.length}${geo.clearance.contactHolds.length ? ` (${geo.clearance.contactHolds.slice(0, 3).join(" | ")})` : ""}; ${geo.clearance.holds} held/end frames: ${geo.clearance.violations.length} crack runs >= ${geo.clearance.limit.minSpan} canvas px (angle < ${geo.clearance.limit.maxAngle} deg, gap in (0, ${geo.clearance.limit.minGap.toFixed(2)}))${geo.clearance.violations.length ? `, first ${geo.clearance.violations.slice(0, 3).map((v) => `${v.at} span ${v.span} gap ${v.minGap}..${v.maxGap}`).join(" | ")}` : ""}; ${geo.clearance.transient.frames} motion frames, ${geo.clearance.transient.streaks} crack streaks, longest ${geo.clearance.transient.maxDegrees} deg${geo.clearance.transient.at ? ` (${geo.clearance.transient.at})` : ""}, ${geo.clearance.transient.over.length} over the cap${geo.clearance.transient.over.length ? `, first ${geo.clearance.transient.over.slice(0, 3).map((v) => `${v.at} ${v.degrees} deg`).join(" | ")}` : ""}; pass-through ranges ${JSON.stringify(geo.clearance.passThrough)}, held/end poses inside them ${geo.clearance.passThroughHolds.length}${geo.clearance.passThroughHolds.length ? ` (${geo.clearance.passThroughHolds.slice(0, 3).join(" | ")})` : ""}`
    ),
    row("generality", "all", true,"one implementation and one set of thresholds for every preset")
  ];
  const raster: GateRow[] = images
    ? [
        row(
          "overlay invisibility",
          "3d",
          (images as { overlayInvisibility?: { unexplained: number } | null }).overlayInvisibility ? (images as { overlayInvisibility: { unexplained: number } }).overlayInvisibility.unexplained === 0 : true,
          JSON.stringify((images as { overlayInvisibility?: unknown }).overlayInvisibility ?? "no overlays")
        ),
        row(
          "outline p99 <= 0.25 game px (DPR 3, DPR 1, offsets, saturated)",
          "3c",
          width?.p99 !== undefined && (width.samples ?? 0) > 0 && width.p99 <= MAX_WIDTH_ERROR && Object.values((width as { numerical?: Record<string, { passes: boolean }> }).numerical ?? {}).every((v) => v.passes),
          `DPR 3 p99 ${width?.p99} over ${width?.samples} samples (underlay: the contour-less render of each frame); numerical ${JSON.stringify((width as { numerical?: unknown }).numerical)}; split ${JSON.stringify((width as { split?: unknown }).split)}`
        ),
        row("calibration", "3c", !!(width?.calibration?.asIs?.passes && bad?.fails), JSON.stringify(width?.calibration)),
        row(
          "alpha (no unexplained holes)",
          "3c",
          images.alphaGaps === 0 && (seams?.over.length ?? 0) === 0,
          `${String(images.alphaGaps)} gap pixels (${String(images.alphaOnTransientCracks ?? 0)} more on sub-pixel cracks, failed by the stroke-clearance gate at every displayed frame (no time cap); ${seams?.pixels ?? 0} on sub-display-px overlap seams in motion frames, ${seams?.streaks ?? 0} streaks, longest ${seams?.longestDegrees ?? 0} deg${seams?.longestAt ? ` (${seams.longestAt})` : ""}, ${seams?.over.length ?? 0} over the ${seams?.capDegrees ?? "-"} deg cap; held/end poses get no allowance)`
        )
      ]
    : ["outline p99 <= 0.25 game px", "calibration", "alpha (no unexplained holes)"].map((g) => row(g, "3c", null, "not rendered (run with --demos)"));
  return { geometric, raster };
}

export interface LimitsReport {
  limits: PoseLimit[];
  clipped: Record<string, number>;
  framesOutside: number;
  validator: string[];
  /** The validator's self-check: a copy of the rig with one clip pushed outside a polygon is flagged (true when no limits are declared). */
  validatorCatches: boolean;
}

/** Pose-limit row inputs: every sweep frame inside, the validator clean on the rig and flagging a clip pushed outside. */
export function limitsReport(rig: SurfaceRig): LimitsReport {
  const framesOutside = Object.values(rig.frames).reduce((n, poses) => n + poses.filter((p) => !insideLimits(rig.limits, p)).length, 0);
  const issues: ValidationIssue[] = [];
  checkPoseLimits(rig.document, issues);
  let validatorCatches = true;
  const limit = rig.limits[0];
  if (limit) {
    // Far corner of the drivers' limits outside the polygon, as a two-key clip.
    const bones = rig.built.preset.bones;
    const lx = bones.find((b) => b.name === limit.x)?.limits as [number, number];
    const ly = bones.find((b) => b.name === limit.y)?.limits as [number, number];
    const outside = [[lx[1], ly[1]], [lx[0], ly[1]], [lx[1], ly[0]], [lx[0], ly[0]]].find(([x, y]) => !insideLimits([limit], { [limit.x]: x as number, [limit.y]: y as number }));
    if (outside) {
      const raw = { ...rig.raw, animations: { probe: { duration: 1, loop: false, bones: { [limit.x]: { rotate: [{ time: 0, value: 0 }, { time: 1, value: outside[0] }] }, [limit.y]: { rotate: [{ time: 0, value: 0 }, { time: 1, value: outside[1] }] } } } } };
      const probe: ValidationIssue[] = [];
      checkPoseLimits(loadAnimDocument(raw), probe);
      validatorCatches = probe.some((i) => i.check === "limits");
    }
  }
  return { limits: rig.limits, clipped: rig.clipped, framesOutside, validator: issues.map((i) => i.message), validatorCatches };
}

function nearest(image: RgbaImage, k: number): MutableImage {
  const out = { width: image.width * k, height: image.height * k, data: new Uint8Array(image.width * k * image.height * k * 4) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / k) * image.width + Math.floor(x / k)) * 4;
      out.data.set(image.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

function crop(image: RgbaImage, x0: number, y0: number, w: number, h: number): MutableImage {
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, y0 + y));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, x0 + x));
      out.data.set(image.data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}

/** The document without any contour (the width gate's per-pixel underlay: the same frame rendered without strokes). */
function stripContours(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(raw)) as { skins: Record<string, { contours?: unknown }> };
  for (const skin of Object.values(copy.skins)) delete skin.contours;
  return copy as unknown as Record<string, unknown>;
}

/** Scales every contour width of a raw document by k (the calibration's deliberately bad rig). */
function scaleWidths(raw: Record<string, unknown>, k: number): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(raw)) as { skins: Record<string, { contours?: Record<string, Record<string, { width: number }>> }> };
  for (const skin of Object.values(copy.skins)) for (const owner of Object.values(skin.contours ?? {})) for (const c of Object.values(owner)) c.width *= k;
  return copy as unknown as Record<string, unknown>;
}

export async function runSurface(options: SurfaceOptions): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
  const presetPath = resolve(options.preset);
  const preset = loadPreset(presetPath);
  let rig = buildRig(preset, dirname(presetPath));
  let sparse: ReturnType<typeof sparseReport> | undefined;
  if (options.sparse) {
    // Plan: the dense rig is the offline reference (written to <out>/dense for comparison);
    // everything below (files, gates, demos) runs on the sparse runtime rig.
    const dense = rig;
    const reduced = buildSparseRig(dense);
    const denseFiles = writeRig(dense, join(resolve(options.out), "dense"));
    rig = reduced.rig;
    sparse = sparseReport(dense, reduced);
    if (options.bench) {
      // Headless Chromium (SwiftShader) frame cost, dense vs sparse on the same clip: relative only.
      const sparseFiles = writeRig(rig, join(resolve(options.out), "sparse-bench"));
      const clip = preset.sweeps[0]?.name ?? null;
      const time = async (f: { document: string; atlas: string }) => (await renderFrames({ document: f.document, atlas: f.atlas, clip, bench: options.bench as number })).bench?.msPerFrame ?? NaN;
      const d = await time(denseFiles);
      const sp = await time(sparseFiles);
      Object.assign(sparse, { chromium: { clip, frames: options.bench, denseMsPerFrame: Number(d.toFixed(3)), sparseMsPerFrame: Number(sp.toFixed(3)), relative: Number((sp / d).toFixed(3)), note: "headless Chromium + SwiftShader, one character: relative cost only, not a phone number" } });
    }
  }
  if (options.calibrateWidth && options.calibrateWidth !== 1) {
    const raw = scaleWidths(rig.raw, options.calibrateWidth);
    rig = { ...rig, raw, document: loadAnimDocument(raw) };
    rig.built.contours.forEach((c) => (c.width *= options.calibrateWidth as number));
    for (const spec of [...preset.skin.contours, ...preset.garments.flatMap((g) => g.contours)]) spec.width *= options.calibrateWidth;
  }
  const files = writeRig(rig, resolve(options.out));
  const geo = geometryGates(rig);
  const structure = structureGates(rig.built);
  const summary: Record<string, unknown> = { preset: preset.name, generatedBy: generatingCommit(), ...(sparse ? { sparse } : {}), build: rig.report, buildSeconds: Number((rig.buildMs / 1000).toFixed(1)), bake: rig.bake, files, ...(options.calibrateWidth ? { calibrateWidth: options.calibrateWidth } : {}) };
  const failures: string[] = [];
  if (sparse && sparse.visibleDistortion.sparse.errors) failures.push(`visible distortion (hard from): ${sparse.visibleDistortion.sparse.errors} findings on ${sparse.visibleDistortion.sparse.triangles} triangles (dense: ${sparse.visibleDistortion.dense.errors} on ${sparse.visibleDistortion.dense.triangles}) outside the declared openings; worst ${sparse.visibleDistortion.sparse.worst}`);
  if (sparse && sparse.visibleDistortion.sparse.opening.errors) failures.push(`visible distortion parked in declared openings (texture debt, not passing): ${sparse.visibleDistortion.sparse.opening.errors} findings on ${sparse.visibleDistortion.sparse.opening.triangles} triangles; worst ${sparse.visibleDistortion.sparse.opening.worst}`);
  if (sparse && !sparse.silhouette.pass) failures.push(`sparse silhouette vs dense: ${sparse.silhouette.maxGamePx} game px > 0.25 (${sparse.silhouette.worstAt})`);
  if (geo.weightErrors.length) failures.push(`weights: ${geo.weightErrors.length} errors`);
  if (geo.partitionMismatches) failures.push(`group boundary mismatches: ${geo.partitionMismatches}`);
  if (!(geo.minAreaRatio > MIN_AREA_RATIO)) failures.push(`signed area: min ratio ${geo.minAreaRatio.toFixed(3)} <= ${MIN_AREA_RATIO} (${geo.minAreaAt}); ${geo.inverted.length} frames with triangles below it`);
  for (const e of geo.embed) if (e.mismatches) failures.push(`embedded '${e.mesh}': ${e.mismatches} coordinates differ from the skin point under them`);
  if (geo.contourOnPartition) failures.push(`contour segments on a group boundary: ${geo.contourOnPartition}`);
  for (const c of geo.coverage) if (c.minOverlap < c.required) failures.push(`hidden coverage '${c.contour}': ${c.minOverlap} < ${c.required} canvas px (${c.worstAt})`);
  if (geo.doubled.length) failures.push(`doubled/competing contours: ${geo.doubled.length} samples (first ${JSON.stringify(geo.doubled[0])})`);
  for (const p of geo.pops) if (p.maxSecondDiffGamePx > MAX_POP) failures.push(`temporal pop in '${p.sweep}': ${p.maxSecondDiffGamePx} game px per (2 deg)^2 at frame ${p.atFrame}`);
  summary.geometry = { ...geo, visible: undefined, inverted: geo.inverted.slice(0, 20) };
  summary.structure = structure;
  if (options.demos) summary.images = await renderDemos(rig, geo, resolve(options.demos), options.quick ?? false, failures);
  const table = gateTable(geo, structure, summary.images as Record<string, unknown> | undefined, rig.bake, limitsReport(rig));
  for (const r of [...table.geometric, ...table.raster]) if (r.status === "fail" && (table.geometric.includes(r) || r.subpass === "3a" || r.subpass === "3b" || r.subpass === "3d")) failures.push(`gate ${r.gate}: ${r.detail.slice(0, 400)}`);
  summary.gateTable = table;
  summary.subpasses = Object.fromEntries(
    (["3a", "3b", "3c", "3d"] as const).map((sp) => [sp, [...table.geometric, ...table.raster].filter((r) => r.subpass === sp || r.subpass === "all").every((r) => r.status === "pass") ? "green" : "red"])
  );
  summary.failures = failures;
  summary.ok = failures.length === 0;
  const target = options.demos ? resolve(options.demos) : resolve(options.out);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${preset.name}${options.calibrateWidth ? `.width-x${options.calibrateWidth}` : ""}.gates.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return { ok: failures.length === 0, summary };
}

async function renderDemos(rig: SurfaceRig, geo: GeometryReport, dir: string, quick: boolean, failures: string[]) {
  const preset = rig.built.preset;
  const name = preset.name;
  mkdirSync(dir, { recursive: true });
  // Regenerate: stale sheets and videos of this preset go first.
  for (const f of readdirSync(dir)) if (f.startsWith(`${name}-`) && /\.(png|mp4)$/.test(f)) rmSync(join(dir, f));
  const rigDir = join(dir, "rig");
  const { document, atlas } = writeRig(rig, rigDir);
  const s1 = preset.gamePixels / preset.figureHeight;
  const dirPoser = new Poser(rig.document, rig.built);
  const boneDirection = (bone: string, pose: Record<string, number>) => {
    dirPoser.pose(pose);
    const w = dirPoser.skeleton.getBone(bone).world;
    return Math.round((((Math.atan2(w.c, w.a) * 180) / Math.PI) % 360 + 360) % 360);
  };
  const full: Rect = figureBounds(rig, 20);
  const joint: Rect = preset.frame;
  const { originX, originY } = rig.document.canvas;
  const render = (clip: string, dpr: number, background: number | null, offset = 0, docPath = document): Promise<RenderResult> => {
    const scale = s1 * dpr;
    return renderFrames({
      document: docPath,
      atlas,
      clip,
      fps: 30,
      scale,
      width: Math.ceil((full.right - full.left) * scale) + 2,
      height: Math.ceil((full.bottom - full.top) * scale) + 2,
      x: (originX - full.left) * scale + offset,
      y: (originY - full.top) * scale + offset,
      background
    });
  };
  const jointCrop = (image: RgbaImage, scale: number) => {
    const x0 = Math.floor((joint.left - full.left) * scale);
    const y0 = Math.floor((joint.top - full.top) * scale);
    return crop(image, x0, y0, Math.ceil((joint.right - joint.left) * scale), Math.ceil((joint.bottom - joint.top) * scale));
  };
  const tag = (scale: number, dpr: number, view: string) => `${Number(scale.toFixed(3))}x dpr${dpr} pixi-ss ${view}`;
  const sheet = (file: string, tiles: { image: RgbaImage; label: string }[], columns: number) => writePng(join(dir, `${name}-${file}.png`), grid(tiles, columns, 1));
  const video = (file: string, r: RenderResult, images: RgbaImage[]) => writeMp4({ ...r, frames: images.map((im, i) => ({ time: (r.frames[i] as { time: number }).time, png: encodePng(im) })) }, join(dir, `${name}-${file}.mp4`));

  const out: Record<string, unknown> = {};
  // Overlay invisibility: the same frames with every overlay merged back into its garment.
  const mergedDoc = join(rigDir, `${name}.overlays-merged.anim.json`);
  if (rig.built.overlays.length) writeFileSync(mergedDoc, JSON.stringify(mergeOverlays(rig.built, rig.raw)));
  // Width gate underlay (pass 3d-2): every measured render is paired with the same frame
  // rendered without contours; numerical acceptance covers DPR 3, DPR 1, fractional offsets and the
  // saturated background.
  const bareDoc = join(rigDir, `${name}.no-contours.anim.json`);
  writeFileSync(bareDoc, JSON.stringify(stripContours(rig.raw)));
  const numeric = { dpr1: [] as number[], offsets: [] as number[], saturated: [] as number[] };
  let firstUnderlay: RgbaImage[] = [];
  const measureInto = (into: number[], frames: RgbaImage[], under: RgbaImage[], vis: VisibleSample[][], r: RenderResult, dpr: number, offset: number, what: string) =>
    frames.forEach((im, i) => into.push(...measureWidths(rig, im, vis[i] ?? [], { scale: r.scale, left: full.left, top: full.top, dpr, offsetX: offset, offsetY: offset }, `${what} #${i}`, under[i]).errors));
  const invisibility = { frames: 0, differing: 0, explained: 0, joins: 0, unexplained: 0, first: "" };
  const widthErrors: number[] = [];
  const perContour: Record<string, number[]> = {};
  const skipped = { outOfFrame: 0, lowContrast: 0 };
  let widthWorst = { error: 0, at: "" };
  let gapsTotal = 0;
  let crackTotal = 0;
  let seamTotalAll = 0;
  let seamStreakCount = 0;
  let seamLongest = { degrees: 0, at: "" };
  const seamOver: string[] = [];
  const firstSweepErrors: number[] = [];
  const sweeps = quick ? preset.sweeps.slice(0, 2) : preset.sweeps;
  for (const [si, sweep] of sweeps.entries()) {
    const poses = rig.frames[sweep.name] as Record<string, number>[];
    // Pose labels are bone directions (screen degrees, y down), with the offset from setup in brackets.
    const label = (i: number) => {
      const pose = poses[i] as Record<string, number>;
      return `#${i} ${Object.entries(pose).map(([b, v]) => `${b.replace(/_[lr]$/, "")} ${boneDirection(b, pose)}deg (${v >= 0 ? "+" : ""}${v})`).join(" ")}`;
    };
    const entry: Record<string, unknown> = { frames: poses.length };
    // Per-joint crops (3c input 4): for every chain joint this sweep moves, the posed bounds of its
    // patch vertices over the sweep plus 1.5 limb widths, at least 240 px wide at 3x nearest.
    const limbW = 2 * preset.skin.topology.halfWidth;
    const moved = new Set(poses.flatMap((p) => Object.entries(p).filter(([, v]) => v !== 0).map(([b]) => b)));
    const jointCrops = [...new Set(preset.skin.regions.patches.map((p) => p.joint))]
      .filter((j) => moved.has(j))
      .map((j) => {
        const names = new Set(preset.skin.regions.patches.filter((p) => p.joint === j).map((p) => p.name));
        const ids = rig.built.support.flatMap((sup, i) => ((sup?.region.split("+") ?? []).some((r) => names.has(r)) ? [i] : []));
        const r = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
        for (const pose of poses) {
          dirPoser.pose(pose);
          const v = dirPoser.vertices(rig.built.skin);
          for (const i of ids) {
            const q = v[i] as [number, number];
            r.left = Math.min(r.left, q[0]);
            r.right = Math.max(r.right, q[0]);
            r.top = Math.min(r.top, q[1]);
            r.bottom = Math.max(r.bottom, q[1]);
          }
        }
        const pad = 1.5 * limbW;
        const minW = 240 / (3 * s1);
        const cx = (r.left + r.right) / 2;
        const half = Math.max((r.right - r.left) / 2 + pad, minW / 2);
        return { joint: j, rect: { left: Math.floor(cx - half), right: Math.ceil(cx + half), top: Math.floor(r.top - pad), bottom: Math.ceil(r.bottom + pad) } as Rect };
      });
    entry.jointCrops = jointCrops;
    const cropTo = (image: RgbaImage, scale: number, c: Rect) =>
      crop(image, Math.floor((c.left - full.left) * scale), Math.floor((c.top - full.top) * scale), Math.ceil((c.right - c.left) * scale), Math.ceil((c.bottom - c.top) * scale));
    const visible = geo.visible[sweep.name] ?? [];
    const step = Math.max(1, Math.ceil(poses.length / 32));
    const pick = <T,>(xs: T[]) => xs.map((x, i) => [x, i] as const).filter(([, i]) => i % step === 0 || i === xs.length - 1);
    for (const bgName of ["dark", "light"] as const) {
      const bg = BACKGROUNDS[bgName];
      const r1 = await render(sweep.name, 1, bg);
      const r3 = await render(sweep.name, 3, bg);
      const f1 = r1.frames.map((fr) => decodePng(fr.png));
      const f3 = r3.frames.map((fr) => decodePng(fr.png));
      const j1 = f1.map((im) => nearest(jointCrop(im, r1.scale), 3));
      const j3 = f3.map((im) => jointCrop(im, r3.scale));
      // Joint crop: game size 3x nearest (every frame) and the true 3x (DPR 3); full figure DPR 1 (every frame) and DPR 3.
      sheet(`${sweep.name}-${bgName}-joint-x3nearest`, j1.map((image, i) => ({ image, label: `${label(i)}\n${tag(r1.scale, 1, "joint x3 nearest")}` })), 12);
      sheet(`${sweep.name}-${bgName}-joint-dpr3`, pick(j3).map(([image, i]) => ({ image, label: `${label(i)}\n${tag(r3.scale, 3, "joint")}` })), 8);
      sheet(`${sweep.name}-${bgName}-full-dpr1`, f1.map((image, i) => ({ image: nearest(image, 1), label: `#${i}\n${tag(r1.scale, 1, "")}` })), 16);
      sheet(`${sweep.name}-${bgName}-full-dpr3`, pick(f3).map(([image, i]) => ({ image, label: `${label(i)}\n${tag(r3.scale, 3, "full")}` })), 8);
      for (const jc of jointCrops) {
        const k1 = f1.map((im) => nearest(cropTo(im, r1.scale, jc.rect), 3));
        sheet(`${sweep.name}-${bgName}-${jc.joint}-x3nearest`, k1.map((image, i) => ({ image, label: `${label(i)}
${tag(r1.scale, 1, `${jc.joint} x3 nearest`)}` })), 8);
        sheet(`${sweep.name}-${bgName}-${jc.joint}-dpr3`, pick(f3).map(([im, i]) => ({ image: cropTo(im, r3.scale, jc.rect), label: `${label(i)}
${tag(r3.scale, 3, jc.joint)}` })), 8);
        if (bgName === "dark") video(`${sweep.name}-${jc.joint}-x3nearest`, r1, k1);
      }
      if (bgName === "dark") {
        video(`${sweep.name}-joint-x3nearest`, r1, j1);
        video(`${sweep.name}-joint-dpr3`, r3, j3);
        writeMp4(r1, join(dir, `${name}-${sweep.name}-full-dpr1.mp4`));
        writeMp4(r3, join(dir, `${name}-${sweep.name}-full-dpr3.mp4`));
      }
      if (bgName === "dark" && rig.built.overlays.length) {
        const rm = await render(sweep.name, 3, bg, 0, mergedDoc);
        rm.frames.forEach((fr, i) => {
          const v = overlayInvisibility(rig, poses[i] as Record<string, number>, f3[i] as RgbaImage, decodePng(fr.png), { scale: r3.scale, left: full.left, top: full.top });
          invisibility.frames++;
          invisibility.differing += v.differing;
          invisibility.explained += v.explained;
          invisibility.joins += v.joins;
          invisibility.unexplained += v.unexplained;
          if (v.unexplained && !invisibility.first) invisibility.first = `${sweep.name} #${i} ${v.at}`;
        });
      }
      // 3x width gate on every DPR 3 frame, both backgrounds, against the contour-less underlay; DPR 1 numerically too.
      const u3 = (await render(sweep.name, 3, bg, 0, bareDoc)).frames.map((fr) => decodePng(fr.png));
      const u1 = (await render(sweep.name, 1, bg, 0, bareDoc)).frames.map((fr) => decodePng(fr.png));
      if (si === 0 && bgName === "dark") firstUnderlay = u3;
      measureInto(numeric.dpr1, f1, u1, visible, r1, 1, 0, `${sweep.name} ${bgName} dpr1`);
      f3.forEach((im, i) => {
        const w = measureWidths(rig, im, visible[i] ?? [], { scale: r3.scale, left: full.left, top: full.top, dpr: 3 }, `${sweep.name} ${bgName} #${i}`, u3[i]);
        widthErrors.push(...w.errors);
        if (si === 0 && bgName === "dark") firstSweepErrors.push(...w.errors);
        for (const [k, e] of Object.entries(w.perContour)) (perContour[k] ??= []).push(...e);
        skipped.outOfFrame += w.skipped.outOfFrame;
        skipped.lowContrast += w.skipped.lowContrast;
        if (w.worstErrorGamePx > widthWorst.error) widthWorst = { error: w.worstErrorGamePx, at: w.worst };
      });
    }
    // Alpha gaps (transparent background) on every frame at DPR 1 and 3.
    // Motion frames: pixels on a transient sub-pixel crack (clearance rule, judged by its time cap) are explained.
    // Motion frames: pixels on a sub-display-px overlap seam are excused
    // too, but the seamed frames form streaks under the same degree time cap; held/end poses stay strict.
    let gaps = 0;
    let explained = 0;
    let gapAt = "";
    const holds = poses.map((p, i) => clearanceHold(preset, p, i, poses.length));
    const contacts = poses.map((p, i) => (holds[i] ? { cracks: [], seams: [] } : clearanceContactPoints(rig, p)));
    const seamPixels = poses.map(() => 0);
    for (const dpr of [1, 3]) {
      const rt = await render(sweep.name, dpr, null);
      rt.frames.forEach((fr, i) => {
        const c = contacts[i] ?? { cracks: [], seams: [] };
        const g = alphaGaps(rig, poses[i] as Record<string, number>, decodePng(fr.png), { scale: rt.scale, left: full.left, top: full.top }, dpr === 1 ? 1 : 2, 4, c.cracks, c.seams);
        gaps += g.gaps;
        explained += g.explained;
        seamPixels[i] = (seamPixels[i] ?? 0) + g.seams;
        if (g.gaps && !gapAt) gapAt = `dpr${dpr} #${i} ${g.at}`;
      });
    }
    const seamStreaks = crackStreaks(poses.map((pose, i) => ({ pose, hold: holds[i] ?? false, crack: (seamPixels[i] ?? 0) > 0 ? { a: "", b: "", span: seamPixels[i] ?? 0, maxGap: 0, minGap: 0, at: `${sweep.name} frame ${i}` } : null })));
    const seamTotal = seamPixels.reduce((a, b) => a + b, 0);
    entry.alphaGaps = gaps;
    entry.alphaOnTransientCracks = explained;
    entry.alphaOnOverlapSeams = { pixels: seamTotal, streaks: seamStreaks.map((st) => ({ frames: st.frames, degrees: st.degrees, pixels: st.span, at: st.at })) };
    if (gapAt) entry.alphaGapFirst = gapAt;
    gapsTotal += gaps;
    crackTotal += explained;
    seamTotalAll += seamTotal;
    for (const st of seamStreaks) {
      if (st.degrees > seamLongest.degrees) seamLongest = { degrees: st.degrees, at: st.at };
      if (st.degrees > clearanceLimitOf(preset).transientDegrees + 1e-9) seamOver.push(`${st.at} ${st.degrees} deg`);
    }
    seamStreakCount += seamStreaks.length;
    // Fractional offsets (game size, joint crop 3x nearest): every sweep at 0.33 on dark and 0.5 on light.
    if (!quick) {
      for (const [key, bg, offset] of [["offset033-dark", BACKGROUNDS.dark, 0.33], ["offset050-light", BACKGROUNDS.light, 0.5]] as const) {
        const r = await render(sweep.name, 1, bg, offset);
        const under = (await render(sweep.name, 1, bg, offset, bareDoc)).frames.map((fr) => decodePng(fr.png));
        measureInto(numeric.offsets, r.frames.map((fr) => decodePng(fr.png)), under, visible, r, 1, offset, `${sweep.name} ${key}`);
        sheet(`${sweep.name}-${key}-joint-x3nearest`, r.frames.map((fr, i) => ({ image: nearest(jointCrop(decodePng(fr.png), r.scale), 3), label: `${label(i)}\n${tag(r.scale, 1, `joint x3n +${offset}px`)}` })), 12);
      }
    }
    out[sweep.name] = entry;
  }
  // Saturated background on the first sweep (joint crop at DPR 1 x3 nearest and DPR 3).
  const first = (preset.sweeps[0] as { name: string }).name;
  for (const dpr of quick ? [] : [1, 3]) {
    const r = await render(first, dpr, BACKGROUNDS.saturated);
    const frames = r.frames.map((fr) => decodePng(fr.png));
    const under = (await render(first, dpr, BACKGROUNDS.saturated, 0, bareDoc)).frames.map((fr) => decodePng(fr.png));
    measureInto(numeric.saturated, frames, under, geo.visible[first] ?? [], r, dpr, 0, `${first} saturated dpr${dpr}`);
    const step = dpr === 1 ? 1 : Math.max(1, Math.ceil(frames.length / 32));
    sheet(`${first}-saturated-joint-${dpr === 1 ? "x3nearest" : "dpr3"}`, frames.filter((_, i) => i % step === 0).map((im, k) => ({ image: dpr === 1 ? nearest(jointCrop(im, r.scale), 3) : jointCrop(im, r.scale), label: `#${k * step}\n${tag(r.scale, dpr, dpr === 1 ? "joint x3 nearest" : "joint")}` })), dpr === 1 ? 12 : 8);
  }
  // Calibration pair (review, item 4): the same measure on the first sweep at DPR 3 (dark),
  // as is and with every contour width x1.5. The gate is trusted only when it separates them.
  const badDoc = join(rigDir, `${name}.width-x${BAD_WIDTH_SCALE}.anim.json`);
  writeFileSync(badDoc, JSON.stringify(scaleWidths(rig.raw, BAD_WIDTH_SCALE)));
  const rb = await render(first, 3, BACKGROUNDS.dark, 0, badDoc);
  const badErrors: number[] = [];
  const firstVisible = geo.visible[first] ?? [];
  rb.frames.forEach((fr, i) => {
    // Measured against the as-is widths: a x1.5 stroke must read as a width error.
    badErrors.push(...measureWidths(rig, decodePng(fr.png), firstVisible[i] ?? [], { scale: rb.scale, left: full.left, top: full.top, dpr: 3 }, `x${BAD_WIDTH_SCALE} #${i}`, firstUnderlay[i]).errors);
  });
  const asIs = errorStats(firstSweepErrors);
  const bad = errorStats(badErrors);
  // Independent known-good member: analytic strokes of the rig's contour widths at DPR 1 and 3, at
  // fractional offsets 0, 0.33 and 0.5, on the dark and saturated backgrounds (game px errors).
  const knownErrors: number[] = [];
  const widths = [...new Set(rig.built.contours.map((c) => c.width))];
  for (const dpr of [1, 3]) {
    for (const w of widths) {
      for (const offset of [0, 0.33, 0.5]) {
        for (const bg of [BACKGROUNDS.dark, BACKGROUNDS.saturated]) {
          const rgb = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
          knownErrors.push(...knownGoodStroke(w * s1 * dpr, rgb, [43, 26, 14], offset).map((e) => e / dpr));
        }
      }
    }
  }
  const known = errorStats(knownErrors);
  const calibration = {
    sweep: first,
    knownGood: { ...known, limit: MAX_WIDTH_ERROR / 2, passes: known.samples > 0 && known.p99 <= MAX_WIDTH_ERROR / 2 },
    asIs: { ...asIs, limit: MAX_WIDTH_ERROR, passes: asIs.samples > 0 && asIs.p99 <= MAX_WIDTH_ERROR && known.p99 <= MAX_WIDTH_ERROR / 2 },
    [`widthX${BAD_WIDTH_SCALE}`]: { ...bad, mustFailAtLeast: BAD_WIDTH_MIN_P99, fails: bad.samples > 0 && bad.p99 >= BAD_WIDTH_MIN_P99 }
  };
  if (!(calibration.asIs.passes && bad.samples > 0 && bad.p99 >= BAD_WIDTH_MIN_P99)) failures.push(`width gate calibration did not separate good from bad: ${JSON.stringify(calibration)}`);
  const all = errorStats(widthErrors);
  const numerical = Object.fromEntries(Object.entries(numeric).map(([k, e]) => [k, { ...errorStats(e), passes: e.length > 0 && errorStats(e).p99 <= MAX_WIDTH_ERROR }]));
  if (!(all.samples > 0) || all.p99 > MAX_WIDTH_ERROR) failures.push(`outline width: p99 ${all.p99} game px > ${MAX_WIDTH_ERROR} over ${all.samples} samples (worst ${widthWorst.error}: ${widthWorst.at})`);
  for (const [k, v] of Object.entries(numerical)) if (!quick && !v.passes) failures.push(`outline width (${k}): p99 ${v.p99} game px > ${MAX_WIDTH_ERROR} over ${v.samples} samples`);
  // Geometric half of the width report: the largest chord error of a round join's rim with the
  // stroke's pixel-error-driven arc steps (strokeJoinSteps), from the posed visible centrelines, at
  // DPR 1 and 3 (game px).
  let joinGeom = 0;
  for (const frames of Object.values(geo.visible)) {
    for (const vis of frames) {
      for (let i = 1; i < vis.length; i++) {
        const a = vis[i - 1] as VisibleSample;
        const b = vis[i] as VisibleSample;
        if (a.contour !== b.contour || dist(a.p, b.p) > 6) continue;
        const turn = Math.acos(Math.max(-1, Math.min(1, a.n[0] * b.n[0] + a.n[1] * b.n[1])));
        for (const dpr of [1, 3]) {
          const radius = ((rig.built.contours[a.contour] as { width: number }).width / 2) * s1 * dpr + 0.5;
          joinGeom = Math.max(joinGeom, strokeJoinError(turn, radius) / dpr);
        }
      }
    }
  }
  if (seamOver.length) failures.push(`alpha overlap seams over the ${clearanceLimitOf(preset).transientDegrees} deg time cap: ${seamOver.slice(0, 5).join(" | ")}`);
  if (invisibility.unexplained) failures.push(`overlay invisibility: ${invisibility.unexplained} pixels differ from the merged render away from the band over a covered group (first ${invisibility.first})`);
  if (gapsTotal) failures.push(`alpha gaps: ${gapsTotal} pixels (${Object.entries(out).map(([k, v]) => `${k}: ${(v as { alphaGaps: number }).alphaGaps}${(v as { alphaGapFirst?: string }).alphaGapFirst ? ` first ${(v as { alphaGapFirst?: string }).alphaGapFirst}` : ""}`).join(", ")})`);
  return {
    views: { full, joint },
    sweeps: out,
    width: {
      ...all,
      limit: MAX_WIDTH_ERROR,
      worstAt: widthWorst.at,
      skipped,
      perContour: Object.fromEntries(Object.entries(perContour).map(([k, e]) => [k, errorStats(e)])),
      numerical,
      split: { geometric: { joinChordGamePx: Number(joinGeom.toFixed(4)), budgetDisplayPx: STROKE_JOIN_ERROR, note: "largest round-join rim chord error with pixel-error-driven arc steps (analytic, posed visible centrelines, DPR 1 and 3)" }, raster: { p99: all.p99, dpr1: numerical.dpr1?.p99, offsets: numerical.offsets?.p99, saturated: numerical.saturated?.p99 } },
      calibration
    },
    overlayInvisibility: rig.built.overlays.length ? invisibility : null,
    alphaGaps: gapsTotal,
    alphaOnTransientCracks: crackTotal,
    alphaOnOverlapSeams: { pixels: seamTotalAll, streaks: seamStreakCount, longestDegrees: seamLongest.degrees, longestAt: seamLongest.at, capDegrees: clearanceLimitOf(preset).transientDegrees, over: seamOver }
  };
}

export async function surfaceCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [preset] = positional;
  const out = flags.get("out");
  if (!preset || typeof out !== "string") {
    process.stderr.write("usage: animator surface <preset.json> --out <dir> [--demos <dir>] [--quick] [--calibrate-width <k>]\n");
    return 2;
  }
  const demos = flags.get("demos");
  const calibrate = flags.get("calibrate-width");
  const { ok, summary } = await runSurface({
    preset,
    out,
    ...(typeof demos === "string" ? { demos } : {}),
    quick: flags.has("quick"),
    sparse: flags.has("sparse"),
    ...(typeof flags.get("bench") === "string" ? { bench: Number(flags.get("bench")) } : {}),
    ...(typeof calibrate === "string" ? { calibrateWidth: Number(calibrate) } : {})
  });
  process.stdout.write(`${(summary.build as string[]).join("\n")}\n`);
  const geometry = summary.geometry as GeometryReport;
  process.stdout.write(
    `geometry: ${geometry.frames} frames, max influences ${geometry.maxInfluences}, boundary mismatches ${geometry.partitionMismatches}, min area ratio ${geometry.minAreaRatio.toFixed(3)} (${geometry.minAreaAt}), embed ${JSON.stringify(geometry.embed)}, coverage ${JSON.stringify(geometry.coverage)}, doubled ${geometry.doubled.length}, pops ${JSON.stringify(geometry.pops)}\n`
  );
  if (summary.images) process.stdout.write(`images: ${JSON.stringify(summary.images, null, 1)}\n`);
  for (const [section, rows] of Object.entries(summary.gateTable as ReturnType<typeof gateTable>)) {
    process.stdout.write(`${section} gates:\n`);
    for (const r of rows) process.stdout.write(`  [${r.status}] ${r.gate} (${r.subpass})${r.status === "pass" ? "" : `: ${r.detail.slice(0, 240)}`}\n`);
  }
  process.stdout.write(`sub-passes: ${JSON.stringify(summary.subpasses)}\n`);
  process.stdout.write(ok ? "all gates green\n" : `FAILED:\n- ${(summary.failures as string[]).join("\n- ")}\n`);
  return ok ? 0 : 1;
}

/** The commit a report was generated from (dirty: tracked changes outside the generated demo folders). */
function generatingCommit(): { commit: string; dirty: boolean } | { commit: "unknown" } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", ":(top)", ":(top,exclude)docs/plans/atlas-animator-demos"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown" };
  }
}
