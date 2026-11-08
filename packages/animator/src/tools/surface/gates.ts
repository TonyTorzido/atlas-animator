/*
 * Atlas Animator: original implementation.
 *
 * Contract gates for a built surface (plan 4d, "acceptance is by contract, not by sheet"):
 * - shared geometry: weights normalised (<= 4 influences), group boundary vertices bit-identical
 *   in every group at every pose, no inverted or collapsed triangles (skin and garments);
 * - hidden coverage: along a garment opening, the skin reaches past the trim's outer edge plus
 *   one anti-aliasing pixel, measured as the minimum overlap through every sweep frame;
 * - contour ownership: one owner per contour (by construction: contours are stored per owner),
 *   none on a group boundary, and no two visible contours closer than their half widths outside
 *   declared junctions (doubled or competing borders);
 * - temporal pops: the second difference of every vertex trajectory through the dense sweeps;
 * - image gates (Pixi captures): coverage-aware perpendicular outline width at 3x, and alpha gaps
 *   inside the expected filled region (from the CPU renderer's id buffer).
 */
import { inContactBand } from "../contactBand.js";
import { pairMatches } from "./contacts.js";
import type { Slot } from "../../core/slot.js";
import type { Skeleton } from "../../core/skeleton.js";
import type { MeshAttachment } from "../../core/attachments.js";
import { softRender } from "../softRender.js";
import type { RgbaImage } from "../image.js";
import { Poser, type Pose } from "./correctives.js";
import { junctionGates, junctionRegions } from "./junctionGate.js";
import { dist, distanceToPolyline, distanceToSegment, pointInPolygon, type Pt } from "./geometry.js";
import type { SurfaceRig } from "./output.js";
import { AREA_FLOOR, boneTable, contourContacts, type BuiltAnchor, type BuiltMesh, type BuiltSurface } from "./build.js";
import { applyContacts, type ContactInk, type ContourContact } from "../../core/contours.js";
import { apexAllowance, patchSelfIntersections, type Affine } from "./solver.js";
import { findingKey, GeometryEvaluator, type GeometryFinding } from "../validateGeometry.js";
import { finalPoses, poseLabel, validationCompanion } from "./validationCompanion.js";

export interface VisibleSample {
  contour: number;
  p: Pt;
  /** Unit normal (left of the contour direction). */
  n: Pt;
  /** Unit normal pointing out of the contour's own surface. */
  out: Pt;
  /** Within a posed junction's radius plus the contour width (endpoint region, not a width sample). */
  nearJunction: boolean;
}

export interface GeometryReport {
  frames: number;
  weightErrors: string[];
  maxInfluences: number;
  partitionMismatches: number;
  inverted: { sweep: string; frame: number; mesh: string; count: number; at: string }[];
  /** Smallest posed/bind signed-area ratio of any triangle over every sweep frame (gate: > MIN_AREA_RATIO). */
  minAreaRatio: number;
  minAreaAt: string;
  /** Embedded garment vertices that differ (bit for bit) from their skin point, summed over frames. */
  embed: { mesh: string; vertices: number; mismatches: number }[];
  coverage: { contour: string; minOverlap: number; required: number; worstAt: string }[];
  contourOnPartition: number;
  doubled: { sweep: string; frame: number; a: string; b: string; at: Pt; distance: number }[];
  /**
   * Stroke clearance (sub-pixel cracks between near-parallel contours). `violations`: crack runs
   * >= minSpan at held and end poses (rest, sweep endpoints, declared holds). `transient`: in-motion
   * streaks of consecutive frames with a crack run >= minSpan, their extent in degrees of the moving
   * joint, the longest, and those over transientDegrees.
   */
  clearance: {
    checked: number;
    holds: number;
    violations: ClearanceViolation[];
    transient: { frames: number; streaks: number; maxDegrees: number; at: string; over: CrackStreak[] };
    limit: { maxAngle: number; minSpan: number; minGap: number; transientDegrees: number };
    /** Held or end poses inside a declared pass-through range (`gates.clearance.passThrough`; gate: none). */
    passThroughHolds: string[];
    /** Held/end poses inside a measured contact band (fail), and in-motion cracks of a band's pair inside it (crossings, allowed). */
    contactHolds: string[];
    contactCrossings: number;
    contacts: { name: string; pair: [string, string]; cells: number; sampled: number }[];
    /** The declared pass-through ranges (preset data). */
    passThrough: { joint: string; range: [number, number]; at: Pose }[];
  };
  /** Doubled or competing borders at the setup pose (gate: none). */
  doubledAtRest: { sweep: string; frame: number; a: string; b: string; at: Pt; distance: number }[];
  /**
   * Visible kink (pass 3d-2): along every contour, the net turn over a window of
   * KINK_WINDOW game px centred on a visible point, counting only visible vertices and none within
   * KINK_CORNER px (bind) of a declared corner (`corner: true` path points), must stay within
   * KINK_TURN degrees, or within the bind turn of the same window when the drawing itself turns more
   * (same sign, + KINK_SLACK): a pose may not add a bend the art does not have.
   */
  /** `bySweep`: violation count per sweep name (attributes a kink rise to its sweeps). */
  kinks: { checked: number; violations: number; maxExcess: number; worst: string; first: string[]; hard: HardKink[]; bySweep: Record<string, number> };
  /**
   * Junction gates (junctionGate.ts) over every sweep frame: `junction` (added concave
   * turn at a cap run's limb/strap junction over the rest art's own turn, within the preset's
   * per-raise limit) and `neck` (the strap/neck curve's turn within its allowance of rest).
   */
  junctions: Record<"junction" | "neck", { checked: number; violations: number; maxExcess: number; worst: string; first: string[] }>;
  /** Fixed regions and anchored apexes: largest deviation from their bone's rigid motion over every frame (canvas px). */
  flankLock: { vertices: number; maxDeviation: number; at: string };
  /** Riding apexes: base permitted motion, largest motion, largest pose-dependent allowance seen, largest excess over the allowance at its frame (girdle-coupled when declared). */
  apexMotion: { index: number; permitted: number; max: number; maxAllowed: number; excess: number; at: string }[];
  /** Skin of a group drawn below a garment sliding under it at the declared poses (deepest point vs the garment's edge half width). */
  occlusion: { garment: string; limit: number; maxDepth: number; at: string }[];
  /**
   * Partition hidden (3d-1 fix review): (a) `above`: skin of a group drawn above a garment
   * piece that lies on that piece at bind (vertices, edge midpoints, centroids) must be covered by a
   * piece drawn above the group (an overlay), else it shows on the garment; exact at every pose
   * because conform garments are piecewise affine in the skin; (b) `root`: a group `under` a
   * garment stays inside its posed hull by >= clearance at every pose (rest, sweeps, limit vertices).
   */
  partitionHidden: { group: string; kind: "above" | "root"; piece: string; samples: number; exposed: number; minDepth: number; worst: string }[];
  /**
   * Ends hidden or joined: every contour end, every frame, is at a declared junction (posed, within
   * its radius) or shared with another contour of its mesh, or lies inside a garment piece (body or
   * overlay: its triangles plus the strokes it owns) drawn above its owner by >= clearance canvas px.
   */
  endsHidden: { checked: number; exposed: number; clearance: number; ends: { contour: string; end: number; rule: string }[]; first: string[] };
  /**
   * Junction containment (overlays): every skin contour end and apex inside an overlay's bind
   * footprint, owned below it, lies inside its opaque band by >= clearance at every pose (rest,
   * sweep frames, pose-limit polygon vertices).
   */
  junctionContainment: { overlay: string; clearance: number; points: string[]; poses: number; minDepth: number; worst: string }[];
  pops: { sweep: string; maxSecondDiffGamePx: number; atFrame: number; medianGamePx: number }[];
  /** Pass 3b: every sweep frame of the runtime against its solved target. */
  shape: ShapeReport;
  /**
   * Unified geometry evaluator over every sweep frame: findings (errors and excused,
   * one per ID and pose, the same keys `animator validate` emits on the companion poses), the count
   * of diagnostic old-rule edge findings, the largest visible principal stretch and edge ratio.
   */
  distortion: { findings: GeometryFinding[]; diagnostics: number; maxVisibleStretch: number; maxEdgeRatio: number; worst: string };
  /** Per sweep, per frame: visible contour samples (for the width gate). */
  visible: Record<string, VisibleSample[][]>;
}

export interface ShapeReport {
  /** Triangles (summed over frames, every mesh) with posed/bind ratio < 0 (flips) and in [0, floor] (collapses). */
  flips: number;
  collapses: number;
  /** Crossings between non-adjacent boundary edges of a joint region (self-intersection within the patch), summed over frames. */
  selfIntersections: number;
  selfIntersectionAt: string;
  /** Per joint region: smallest and largest aggregate area ratio over every frame, and its declared band. */
  areas: { joint: string; band: [number, number]; min: number; max: number; minAt: string; maxAt: string }[];
  /** Free hull vertices: largest distance to the solved target's hull (canvas and game px). */
  silhouette: { canvasPx: number; gamePx: number; at: string; limitGamePx: number };
  /** Sweep frames whose target the solver could not reach (reported, never accepted). */
  unsolvedFrames: number;
  unsolvedFirst: string;
  /** Target boundary curves that still reverse along their chord (an extra lobe or hook). */
  lobes: number;
  /** Rigid cores: largest deviation from their bone (canvas px); hinge thickness (row end to the opposite posed boundary) outside the patch's width envelope. */
  coreDeviation: number;
  widths: { checked: number; outside: number; worst: string; bindOutside: number; min: number; max: number };
  /**
   * No swelling: limb cross-sections across every core row (the
   * posed boundary on both sides at the row's bind arc length, measured across the posed core bone)
   * stay <= bind x (1 + SWELL_LIMIT) outside declared bulge zones (patches with an `envelope.bulge`:
   * bind + bulge there). Largest ratio outside bulge zones and the worst excess anywhere.
   */
  swelling: { checked: number; outside: number; maxRatio: number; maxRatioAt: string; worst: string };
  /** Largest frame-to-frame change of the runtime's silhouette residual from the target (game px): a position jump. */
  residualJumpGamePx: number;
  residualJumpAt: string;
}

/** Temporal gate (game px): frame-to-frame residual jump, and the second difference per (2 degrees)^2. */
export const MAX_JUMP = 0.25;
/** Per hard contour (preset `gates.kink.hard`): the same visible-kink windows, every violation counted, the worst per sweep listed. */
export interface HardKink {
  contour: string;
  /** Turn cap (degrees) and pose scope (bone -> [lo, hi] degrees) from the preset. */
  turn: number;
  when: Record<string, [number, number]>;
  s: [number, number] | null;
  checked: number;
  violations: number;
  maxExcess: number;
  worst: string;
  bySweep: Record<string, { violations: number; worst: number; at: string }>;
}

/** Visible-kink gate: window (game px), turn cap (degrees), slack over the bind turn (degrees), corner exclusion (canvas px). */
export const KINK_WINDOW = 3;
export const KINK_TURN = 35;
export const KINK_SLACK = 5;
export const KINK_CORNER = 4;

/**
 * Net turn (radians) of a polyline over windows of arc length `window` centred on each vertex,
 * from the turning angles at the vertices with `counts[j]` true (end vertices turn 0).
 */
export function windowTurns(line: readonly Pt[], window: number, counts: readonly boolean[]): number[] {
  const n = line.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push((s[i - 1] as number) + dist(line[i - 1] as Pt, line[i] as Pt));
  const turn = line.map((p, i) => {
    if (i === 0 || i === n - 1 || !counts[i]) return 0;
    const a = line[i - 1] as Pt;
    const b = line[i + 1] as Pt;
    if (dist(a, p) < 1e-9 || dist(p, b) < 1e-9) return 0;
    let t = Math.atan2(b[1] - p[1], b[0] - p[0]) - Math.atan2(p[1] - a[1], p[0] - a[0]);
    while (t > Math.PI) t -= 2 * Math.PI;
    while (t < -Math.PI) t += 2 * Math.PI;
    return t;
  });
  return line.map((_, i) => {
    let net = 0;
    for (let j = 0; j < n; j++) if (Math.abs((s[j] as number) - (s[i] as number)) <= window / 2) net += turn[j] as number;
    return net;
  });
}
/** No-swelling gate: largest cross-section growth outside declared bulge zones (fraction of the bind width). */
export const SWELL_LIMIT = 0.03;

/** Signed-area gate (review): no triangle may shrink below this share of its bind area. */
export const MIN_AREA_RATIO = AREA_FLOOR;
/** Conform garment containment tolerance (canvas px): the outline/skin snapping distance, doubled. */
export const CONFORM_TOLERANCE = 0.1;
/** Fixed regions follow their bone exactly (float tolerance, canvas px). */
export const FLANK_TOLERANCE = 1e-3;

const triangleArea = (a: Pt, b: Pt, c: Pt) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

function pointInTriangles(p: Pt, verts: Pt[], tris: number[], from: number, to: number): boolean {
  for (let t = from; t < to; t++) {
    const a = verts[tris[t * 3] as number] as Pt;
    const b = verts[tris[t * 3 + 1] as number] as Pt;
    const c = verts[tris[t * 3 + 2] as number] as Pt;
    const d1 = triangleArea(p, a, b);
    const d2 = triangleArea(p, b, c);
    const d3 = triangleArea(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}

/** Limb thickness at a row: the smaller distance from a row end to the posed hull on the other side of the limb. */
function thickness(x: readonly Pt[], w: { a: number; b: number; oppA: [number, number][]; oppB: [number, number][] }): number {
  const to = (p: Pt, edges: [number, number][]) => edges.reduce((m, [i, j]) => Math.min(m, distanceToSegment(p, x[i] as Pt, x[j] as Pt)), Infinity);
  return Math.min(to(x[w.a] as Pt, w.oppA), to(x[w.b] as Pt, w.oppB));
}

const label = (pose: Pose) =>
  Object.entries(pose)
    .map(([b, v]) => `${b} ${v}`)
    .join(" ") || "setup";

export function geometryGates(rig: SurfaceRig): GeometryReport {
  const { built, frames } = rig;
  const preset = built.preset;
  const gameScale = preset.gamePixels / preset.figureHeight;
  const poser = new Poser(rig.document, built);
  const meshes: BuiltMesh[] = [built.skin, ...built.garments];
  const clearanceLimit = clearanceLimitOf(preset);
  const isHold = (pose: Pose, f: number, count: number) => clearanceHold(preset, pose, f, count);
  const report: GeometryReport = {
    frames: 0,
    weightErrors: [],
    maxInfluences: 0,
    partitionMismatches: 0,
    inverted: [],
    minAreaRatio: Infinity,
    minAreaAt: "",
    embed: built.garments.filter((g) => g.embed).map((g) => ({ mesh: g.slot, vertices: g.embed?.vertices.length ?? 0, mismatches: 0 })),
    coverage: [],
    contourOnPartition: 0,
    doubled: [],
    clearance: { checked: 0, holds: 0, violations: [], transient: { frames: 0, streaks: 0, maxDegrees: 0, at: "", over: [] }, limit: clearanceLimit, passThroughHolds: passThroughHolds(preset, frames), contactHolds: [], contactCrossings: 0, contacts: (rig.contacts ?? []).map((b) => ({ name: b.name, pair: b.pair, cells: b.cells.length, sampled: b.sampled })), passThrough: (preset.gates?.clearance?.passThrough ?? []).map((r) => ({ joint: r.joint, range: r.range, at: r.at })) },
    doubledAtRest: [],
    kinks: { checked: 0, violations: 0, maxExcess: -Infinity, worst: "", first: [], bySweep: {}, hard: (preset.gates?.kink?.hard ?? []).map((h) => ({ contour: h.contour, turn: h.turn ?? KINK_TURN, when: h.when ?? {}, s: h.s ?? null, checked: 0, violations: 0, maxExcess: -Infinity, worst: "", bySweep: {} })) },
    junctions: { junction: { checked: 0, violations: 0, maxExcess: -Infinity, worst: "", first: [] }, neck: { checked: 0, violations: 0, maxExcess: -Infinity, worst: "", first: [] } },
    flankLock: { vertices: 0, maxDeviation: 0, at: "" },
    apexMotion: built.anchors.map((a) => ({ index: a.index, permitted: a.permittedMotion, max: 0, maxAllowed: a.permittedMotion, excess: -Infinity, at: "" })),
    occlusion: [],
    partitionHidden: [],
    endsHidden: { checked: 0, exposed: 0, clearance: built.overlays.length ? Math.min(...built.overlays.map((o) => o.clearance)) : 3, ends: [], first: [] },
    junctionContainment: [],
    pops: [],
    shape: {
      flips: 0,
      collapses: 0,
      selfIntersections: 0,
      selfIntersectionAt: "",
      areas: rig.solver.regions.map((r) => ({ joint: r.joint, band: r.band, min: Infinity, max: -Infinity, minAt: "", maxAt: "" })),
      silhouette: { canvasPx: 0, gamePx: 0, at: "", limitGamePx: 0.25 },
      unsolvedFrames: 0,
      unsolvedFirst: "",
      lobes: 0,
      coreDeviation: 0,
      widths: { checked: 0, outside: 0, worst: "", bindOutside: 0, min: Infinity, max: 0 },
      swelling: { checked: 0, outside: 0, maxRatio: 0, maxRatioAt: "", worst: "" },
      residualJumpGamePx: 0,
      residualJumpAt: ""
    },
    visible: {},
    distortion: { findings: [], diagnostics: 0, maxVisibleStretch: 1, maxEdgeRatio: 1, worst: "" }
  };
  const shape = report.shape;
  const distortion = (() => {
    poser.pose({});
    return { evaluator: new GeometryEvaluator(poser.skeleton, validationCompanion(rig)), seen: new Set<string>() };
  })();
  const solver = rig.solver;
  // Rows across a patch with a width envelope: [first hull vertex, last hull vertex, lo, hi, label].
  // Hinge bands only: a root patch's row ends on the opening notch (armpit, crease) once the limb
  // leaves rest, so it is no cross-section; root shapes are held by the silhouette and area gates.
  const patchWidth = new Map(preset.skin.regions.patches.filter((p) => p.envelope?.width && p.side === "both").map((p) => [p.name, p.envelope?.width as [number, number]]));
  const rootPatches = new Set(preset.skin.regions.patches.filter((p) => p.side !== "both").map((p) => p.name));
  const fixedNames = new Set([...preset.skin.regions.fixed.map((f) => f.name), "apex"]);
  const tube = preset.skin.topology.halfWidth + preset.skin.topology.columns;
  const widthRows = built.rows.flatMap((row) => {
    const ends = [row.ids[0] as number, row.ids[row.ids.length - 1] as number];
    if (row.fan || ends.some((e) => e >= built.skin.hull)) return [];
    const names = new Set(row.ids.flatMap((i) => built.support[i]?.region.split("+") ?? []));
    if ([...names].some((n) => rootPatches.has(n))) return [];
    const bands = [...names].flatMap((n) => (patchWidth.has(n) ? [patchWidth.get(n) as [number, number]] : []));
    if (!bands.length) return [];
    const lo = Math.min(...bands.map((b) => b[0]));
    const hi = Math.max(...bands.map((b) => b[1]));
    // Opposite boundary of each end: the hull edges on the other side of the limb within reach of the row.
    const sv = built.skin.chainSV ?? [];
    const sideOf = (i: number) => Math.sign((sv[i] as { v: number }).v);
    const near = (sign: number) => {
      const out: [number, number][] = [];
      for (let i = 0; i < built.skin.hull; i++) {
        const j = (i + 1) % built.skin.hull;
        // The limb's own boundary: inside the chain tube, within half a limb width along it, neither a
        // fixed body region nor a root patch (those stay with the body while the limb moves).
        const ok = (k: number) =>
          sideOf(k) === sign &&
          Math.abs((sv[k] as { s: number }).s - row.s) < hi / 2 &&
          Math.abs((sv[k] as { v: number }).v) <= tube &&
          !fixedNames.has(built.support[k]?.region ?? "") &&
          !(built.support[k]?.region.split("+") ?? []).some((r) => rootPatches.has(r));
        if (ok(i) && ok(j)) out.push([i, j]);
      }
      return out;
    };
    const w = { a: ends[0] as number, b: ends[1] as number, lo, hi, s: row.s, oppA: near(-sideOf(ends[0] as number)), oppB: near(-sideOf(ends[1] as number)) };
    const bind = thickness(built.skin.points, w);
    if (bind < lo || bind > hi) shape.widths.bindOutside++;
    return [w];
  });
  // No-swelling rows: every 3 px of bind arc length along each core, the two hull points bracketing
  // the row on each side of the limb (fixed regions and the apex excluded).
  const swellRows = (() => {
    const sv = built.skin.chainSV ?? [];
    const bulgeOf = new Map(preset.skin.regions.patches.filter((p) => p.envelope?.bulge !== undefined).map((p) => [p.name, p.envelope?.bulge as number]));
    const sideList = (sign: number) =>
      Array.from({ length: built.skin.hull }, (_, i) => i)
        .filter((i) => Math.sign((sv[i] as { v: number }).v) === sign && Math.abs((sv[i] as { v: number }).v) <= tube && !fixedNames.has(built.support[i]?.region ?? ""))
        .sort((a, b) => (sv[a] as { s: number }).s - (sv[b] as { s: number }).s);
    const sides = [sideList(1), sideList(-1)];
    const apexPatches = new Set(preset.skin.regions.patches.filter((p) => p.from && !Array.isArray(p.from)).map((p) => p.name));
    const bracket = (list: number[], s: number): [number, number, number] | null => {
      for (let k = 0; k + 1 < list.length; k++) {
        const a = list[k] as number;
        const b = list[k + 1] as number;
        const sa = (sv[a] as { s: number }).s;
        const sb = (sv[b] as { s: number }).s;
        if (sa <= s && s <= sb && sb - sa < 24) return [a, b, sb - sa > 1e-9 ? (s - sa) / (sb - sa) : 0];
      }
      return null;
    };
    const rows: { s: number; bone: string; ends: [number, number, number][]; bulge: number | null; bind: number }[] = [];
    for (const core of preset.skin.regions.cores) {
      for (let s = core.sMin + 1.5; s <= core.sMax - 1.5; s += 3) {
        const ends = sides.map((l) => bracket(l, s));
        if (ends.some((e) => e === null)) continue;
        const ids = (ends as [number, number, number][]).flatMap((e) => [e[0], e[1]]);
        // A row ending in an apex-anchored root patch (armpit, crease) ends on the opening notch once
        // the limb leaves rest: no cross-section (held by the area and silhouette gates).
        if (ids.some((i) => (built.support[i]?.region.split("+") ?? []).some((r) => apexPatches.has(r)))) continue;
        const bulges = ids.flatMap((i) => (built.support[i]?.region.split("+") ?? []).flatMap((r) => (bulgeOf.has(r) ? [bulgeOf.get(r) as number] : [])));
        rows.push({ s, bone: core.bone, ends: ends as [number, number, number][], bulge: bulges.length ? Math.max(...bulges) : null, bind: 0 });
      }
    }
    return rows;
  })();
  const crossSection = (x: readonly Pt[], row: (typeof swellRows)[number], dir: Pt): number => {
    const at = ([a, b, u]: [number, number, number]): Pt => [(x[a] as Pt)[0] + ((x[b] as Pt)[0] - (x[a] as Pt)[0]) * u, (x[a] as Pt)[1] + ((x[b] as Pt)[1] - (x[a] as Pt)[1]) * u];
    const p = at(row.ends[0] as [number, number, number]);
    const q = at(row.ends[1] as [number, number, number]);
    return Math.abs((p[0] - q[0]) * -dir[1] + (p[1] - q[1]) * dir[0]);
  };
  const boneDir = (bone: string): Pt => {
    const w = poser.skeleton.getBone(bone).world;
    const l = Math.hypot(w.a, w.c) || 1;
    return [w.a / l, w.c / l];
  };
  poser.pose({});
  for (const row of swellRows) row.bind = crossSection(built.skin.points, row, boneDir(row.bone));
  // Rigid cores: vertices whose support region is a core follow that bone exactly.
  const coreBone = new Map<number, string>();
  for (const c of preset.skin.regions.cores) built.support.forEach((sup, i) => sup?.region === c.name && coreBone.set(i, c.bone));
  for (const mesh of meshes) {
    mesh.weights.forEach((inf, i) => {
      const sum = inf.reduce((s, [, w]) => s + w, 0);
      report.maxInfluences = Math.max(report.maxInfluences, inf.length);
      if (Math.abs(sum - 1) > 1e-6 || inf.length > 4) report.weightErrors.push(`${mesh.slot} vertex ${i}: ${inf.length} influences, sum ${sum}`);
    });
  }
  // Partition vertices (shared by triangles of different groups); a contour on a partition is an
  // owner/group mismatch, counted by structureGates (ownership).
  const partition = new Set(built.partition);
  report.contourOnPartition = structureGates(built).ownership.ownerMismatch;
  const order = built.drawOrder;
  const ownerIndex = built.contours.map((c) => order.indexOf(c.owner));
  const groupSlots = built.groupSlots;
  const groupRanges = groupSlots.map((slot) => (built.skin.groups?.[slot]?.[0] ?? [0, 0]) as [number, number]);
  // Junctions are posed points: the junction's hull vertex on its mesh at the current frame.
  const junctionMesh = built.junctions.map((j) => (j.mesh === "skin" ? 0 : preset.garments.findIndex((g) => g.name === j.mesh) + 1));
  const aaCanvas = 1 / gameScale; // one display pixel at game size (DPR 1)
  const coverageSpecs = preset.gates?.coverage ?? [];
  const coverageState = coverageSpecs.map((spec) => ({ contour: spec.contour, minOverlap: Infinity, required: 0, worstAt: "" }));
  // Garment pieces: the body piece (the garment slot) and each overlay, as triangle ranges of the
  // garment mesh plus the contours they own (strokes extend a piece by their half width).
  const pieces = garmentPieces(built);
  const pieceRank = pieces.map((pc) => order.indexOf(pc.slot));
  // Partition hidden (a): skin of a group drawn above a piece that lies on it at bind must be covered by a piece above the group.
  {
    const bind = meshes.map((m) => m.points);
    groupSlots.forEach((slot, gk) => {
      if (built.roots.some((r) => r.slot === slot)) return;
      const rank = order.indexOf(slot);
      const below = pieces.filter((_, k) => (pieceRank[k] as number) < rank);
      const above = pieces.filter((_, k) => (pieceRank[k] as number) > rank);
      if (!below.length) return;
      const [from, to] = groupRanges[gk] as [number, number];
      const tri = built.skin.triangles;
      const pts = built.skin.points;
      const samples: Pt[] = [];
      for (let t = from; t < to; t++) {
        const v = [0, 1, 2].map((k) => pts[tri[t * 3 + k] as number] as Pt) as [Pt, Pt, Pt];
        samples.push(...v, [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3]);
        for (let k = 0; k < 3; k++) samples.push([(v[k]![0] + v[(k + 1) % 3]![0]) / 2, (v[k]![1] + v[(k + 1) % 3]![1]) / 2]);
      }
      for (const pc of below) {
        const st = { group: slot, kind: "above" as const, piece: pc.slot, samples: 0, exposed: 0, minDepth: Infinity, worst: "" };
        for (const q of samples) {
          // On the piece's own fill (not just its stroke) by more than half a canvas px.
          if (!pointInTriangles(q, bind[pc.gi + 1] as Pt[], (built.garments[pc.gi] as BuiltMesh).triangles, pc.from, pc.to) || pieceEdgeDistance(pc, bind, q) < 0.5) continue;
          st.samples++;
          const cover = Math.max(-Infinity, ...above.map((a) => pieceDepth(a, bind, q)));
          st.minDepth = Math.min(st.minDepth, cover);
          if (cover < 0) {
            st.exposed++;
            if (!st.worst) st.worst = `${slot} skin at (${q[0].toFixed(1)}, ${q[1].toFixed(1)}) lies on '${pc.slot}' at bind, uncovered (${cover.toFixed(2)} px)`;
          }
        }
        if (st.samples) report.partitionHidden.push({ ...st, minDepth: Number(st.minDepth.toFixed(2)) });
      }
    });
  }
  // Partition hidden (b): root groups stay inside their garment's posed hull.
  const rootChecks = built.roots.map((r) => {
    const gi = preset.garments.findIndex((g) => g.name === r.garment);
    const gk = groupSlots.indexOf(r.slot);
    const [from, to] = groupRanges[gk] as [number, number];
    const ids = new Set<number>();
    for (let t = from; t < to; t++) for (let k = 0; k < 3; k++) ids.add(built.skin.triangles[t * 3 + k] as number);
    const st = { group: r.slot, kind: "root" as const, piece: r.garment, samples: 0, exposed: 0, minDepth: Infinity, worst: "" };
    report.partitionHidden.push(st);
    return { r, gi, ids: [...ids], st };
  });
  const checkRoots = (verts: Pt[][], where: string) => {
    for (const { r, gi, ids, st } of rootChecks) {
      const hullNow = (verts[gi + 1] as Pt[]).slice(0, (built.garments[gi] as BuiltMesh).hull);
      for (const i of ids) {
        const p = (verts[0] as Pt[])[i] as Pt;
        const d = (pointInPolygon(p, hullNow) ? 1 : -1) * distanceToPolyline(p, hullNow, true);
        st.samples++;
        st.minDepth = Math.min(st.minDepth, d);
        if (d < r.clearance) {
          st.exposed++;
          if (!st.worst) st.worst = `vertex ${i} at ${where} (${p[0].toFixed(1)}, ${p[1].toFixed(1)}): ${d.toFixed(2)} px inside`;
        }
      }
    }
  };
  // Ends hidden or joined: contour ends that no declared junction or shared end covers must hide under a piece drawn above.
  const endRules = built.contours.flatMap((c, ci) =>
    [0, 1].map((end) => {
      const v = end === 0 ? (c.points[0] as number) : (c.points[c.points.length - 1] as number);
      const shared = built.contours.some((o) => o !== c && o.mesh === c.mesh && (o.points[0] === v || o.points[o.points.length - 1] === v));
      const mi = c.mesh === "skin" ? 0 : preset.garments.findIndex((g) => g.name === c.mesh) + 1;
      return { ci, end, v, mi, shared };
    })
  );
  report.endsHidden.ends = endRules.map((r) => ({ contour: `${(built.contours[r.ci] as { owner: string }).owner}/${(built.contours[r.ci] as { name: string }).name}`, end: r.end, rule: r.shared ? "shared" : "junction or hidden" }));
  const checkEnds = (verts: Pt[][], where: string) => {
    const eh = report.endsHidden;
    const junctionsAt = built.junctions.map((j, k) => ({ at: (verts[junctionMesh[k] as number] as Pt[])[j.index] as Pt, radius: j.radius }));
    for (const r of endRules) {
      eh.checked++;
      if (r.shared) continue;
      const p = (verts[r.mi] as Pt[])[r.v] as Pt;
      if (junctionsAt.some((j) => dist(j.at, p) <= j.radius + 1e-9)) continue;
      const mine = order.indexOf((built.contours[r.ci] as { owner: string }).owner);
      if (pieces.some((pc, k) => (pieceRank[k] as number) > mine && pieceDepth(pc, verts, p) >= eh.clearance)) continue;
      eh.exposed++;
      if (eh.first.length < 5) eh.first.push(`${(report.endsHidden.ends[endRules.indexOf(r)] as { contour: string }).contour} end ${r.end} at ${where} (${p[0].toFixed(1)}, ${p[1].toFixed(1)})`);
    }
  };
  // Junction containment: skin contour ends and apexes in an overlay's bind footprint, owned below it.
  const containment = built.overlays.map((o) => {
    const pc = pieces.find((x) => x.slot === o.name) as GarmentPiece;
    const rank = order.indexOf(o.name);
    const bind = meshes.map((m) => m.points);
    // A point is held by the overlay and by its garment's other pieces drawn above the point's owner
    // (an end owned below the garment body may sit under the body as well); apexes by the overlay alone.
    const pts: { label: string; v: number; by: GarmentPiece[] }[] = [];
    built.contours.forEach((c) => {
      const own = order.indexOf(c.owner);
      if (c.mesh !== "skin" || own >= rank) return;
      const by = pieces.filter((x, k) => x.gi === pc.gi && (pieceRank[k] as number) > own);
      for (const [end, v] of [[0, c.points[0] as number], [1, c.points[c.points.length - 1] as number]] as const) {
        if (pieceDepth(pc, bind, built.skin.points[v] as Pt) >= 0 && !pts.some((x) => x.v === v)) pts.push({ label: `${c.owner}/${c.name} end ${end}`, v, by });
      }
    });
    built.apexes.forEach((a, k) => {
      if (pieceDepth(pc, bind, built.skin.points[a.index] as Pt) >= 0 && !pts.some((x) => x.v === a.index)) pts.push({ label: `apex ${k}`, v: a.index, by: [pc] });
    });
    const st = { overlay: o.name, clearance: o.clearance, points: pts.map((x) => x.label), poses: 0, minDepth: Infinity, worst: "" };
    report.junctionContainment.push(st);
    return { o, pc, pts, st };
  });
  const checkContainment = (verts: Pt[][], where: string) => {
    for (const { o, pts, st } of containment) {
      st.poses++;
      for (const x of pts) {
        const p = (verts[0] as Pt[])[x.v] as Pt;
        const d = Math.max(...x.by.map((q) => pieceDepth(q, verts, p)));
        if (d < st.minDepth) {
          st.minDepth = d;
          if (d < o.clearance) st.worst = `${x.label} at ${where} (${p[0].toFixed(1)}, ${p[1].toFixed(1)}): ${d.toFixed(2)} px inside`;
        }
      }
    }
  };

  // Fixed regions and anchors: setup positions and setup bone matrices.
  const fixedBone = new Map<number, string>();
  for (const f of preset.skin.regions.fixed) for (const v of built.fixedVertices[f.name] ?? []) fixedBone.set(v, f.bone);
  // Exact anchors only; a riding apex (permitted motion > 0) is held by the apex-motion bound instead.
  for (const a of built.anchors) if (!(a.permittedMotion > 0)) fixedBone.set(a.index, preset.base);
  const fixedOnly = new Set(fixedBone.keys());
  report.flankLock.vertices = fixedBone.size;
  for (const [v, bone] of coreBone) if (!fixedBone.has(v)) fixedBone.set(v, bone);
  const { originX, originY } = rig.document.canvas;
  poser.pose({});
  const setupSkin = poser.vertices(built.skin);
  const affine = (name: string) => {
    const w = poser.skeleton.getBone(name).world;
    return { a: w.a, b: w.b, c: w.c, d: w.d, x: w.x, y: w.y };
  };
  const setupBones = new Map([...new Set(fixedBone.values())].map((b) => [b, affine(b)]));
  const setupAll = new Map(preset.bones.map((b) => [b.name, affine(b.name)]));
  const setupLocal = new Map<number, Pt>();
  for (const [v, bone] of fixedBone) {
    const m = setupBones.get(bone) as ReturnType<typeof affine>;
    const q = setupSkin[v] as Pt;
    const x = q[0] - originX - m.x;
    const y = q[1] - originY - m.y;
    const det = m.a * m.d - m.b * m.c;
    setupLocal.set(v, [(m.d * x - m.b * y) / det, (-m.c * x + m.a * y) / det]);
  }
  const checkFixed = (skinVerts: Pt[], label: string) => {
    const now = new Map([...setupBones.keys()].map((b) => [b, affine(b)]));
    for (const [v, bone] of fixedBone) {
      const m = now.get(bone) as ReturnType<typeof affine>;
      const l = setupLocal.get(v) as Pt;
      const expected: Pt = [m.a * l[0] + m.b * l[1] + m.x + originX, m.c * l[0] + m.d * l[1] + m.y + originY];
      const d = dist(expected, skinVerts[v] as Pt);
      if (coreBone.has(v) && !fixedOnly.has(v)) {
        shape.coreDeviation = Math.max(shape.coreDeviation, d);
        continue;
      }
      if (d > report.flankLock.maxDeviation) report.flankLock = { ...report.flankLock, maxDeviation: d, at: `${label} vertex ${v}` };
    }
    // Apex motion is measured in the base bone's frame: a trunk lean carries the
    // anchored apex with the body; only motion relative to the body counts.
    const baseNow = affine(preset.base);
    const baseSetup = setupAll.get(preset.base) as ReturnType<typeof affine>;
    const carried = (q: Pt): Pt => {
      const x = q[0] - originX - baseSetup.x;
      const y = q[1] - originY - baseSetup.y;
      const det = baseSetup.a * baseSetup.d - baseSetup.b * baseSetup.c;
      const l: Pt = [(baseSetup.d * x - baseSetup.b * y) / det, (-baseSetup.c * x + baseSetup.a * y) / det];
      return [baseNow.a * l[0] + baseNow.b * l[1] + baseNow.x + originX, baseNow.c * l[0] + baseNow.d * l[1] + baseNow.y + originY];
    };
    report.apexMotion.forEach((a, k) => {
      const m = dist(skinVerts[a.index] as Pt, carried(setupSkin[a.index] as Pt));
      const allowed = apexAllowance(built.anchors[k] as BuiltAnchor, (b) => poser.skeleton.getBone(b).world, (b) => setupAll.get(b) as Affine, [originX, originY]);
      a.max = Math.max(a.max, m);
      a.maxAllowed = Math.max(a.maxAllowed, allowed);
      if (m - allowed > a.excess) Object.assign(a, { excess: m - allowed, at: `${label}: ${m.toFixed(2)} vs ${allowed.toFixed(2)}` });
    });
  };
  // Visible-kink gate inputs: per contour, the vertices near a declared corner and the bind turns.
  const kinkWindow = KINK_WINDOW / gameScale;
  // Declared corners: canvas `{ at, corner }` and chain-relative `{ s, v, corner }` path points (a
  // garment cut across a limb, such as the creature's band cuff, declares its hem corners in s/v).
  const cornerPts: Pt[] = [...preset.skin.silhouette, ...preset.garments.flatMap((g) => g.path)].flatMap((q) => {
    if (typeof q !== "object" || q === null || Array.isArray(q) || !("corner" in q) || !q.corner) return [];
    if ("at" in q) return [q.at as Pt];
    if ("s" in q && "v" in q) return [built.chain.point(q.s as number, q.v as number)];
    return [];
  });
  for (const h of report.kinks.hard) if (!built.contours.some((c) => `${c.owner}/${c.name}` === h.contour)) throw new Error(`gates.kink.hard: no contour '${h.contour}'`);
  const kinkInput = built.contours.map((c) => {
    const mesh = c.mesh === "skin" ? built.skin : (built.garments[preset.garments.findIndex((g) => g.name === c.mesh)] as BuiltMesh);
    const bind = c.points.map((i) => mesh.points[i] as Pt);
    const counts = bind.map((p) => !cornerPts.some((q) => dist(p, q) <= KINK_CORNER));
    return { counts, bind: windowTurns(bind, kinkWindow, counts) };
  });
  /** Longest clearance crack run of the last contourFrame (null when none >= minSpan). */
  let frameCrack: ClearanceViolation | null = null;
  /** Visible contour samples at the current pose and the doubled/competing borders among them. */
  const contourFrame = (verts: Pt[][], sweepName: string, f: number, doubled: GeometryReport["doubled"], hold: boolean, pose: Pose): VisibleSample[] => {
    // Rigid regions cover where their art is at this pose, not at bind.
    poser.pose(pose);
    const covers = regionCovers(rig, poser.skeleton);
    const skinHull = (verts[0] as Pt[]).slice(0, built.skin.hull);
    const lines = built.contours.map((c) => {
      const mi = c.mesh === "skin" ? 0 : preset.garments.findIndex((g) => g.name === c.mesh) + 1;
      return c.points.map((i) => (verts[mi] as Pt[])[i] as Pt);
    });
    const occluded = (p: Pt, ci: number): boolean => {
      const mine = ownerIndex[ci] as number;
      for (let gi = 0; gi < groupSlots.length; gi++) {
        if (order.indexOf(groupSlots[gi] as string) <= mine) continue;
        const [from, to] = groupRanges[gi] as [number, number];
        if (pointInTriangles(p, verts[0] as Pt[], built.skin.triangles, from, to)) return true;
      }
      for (let k = 0; k < pieces.length; k++) {
        if ((pieceRank[k] as number) <= mine) continue;
        const pc = pieces[k] as GarmentPiece;
        const g = built.garments[pc.gi] as BuiltMesh;
        if (pc.whole ? pointInPolygon(p, (verts[pc.gi + 1] as Pt[]).slice(0, g.hull)) : pointInTriangles(p, verts[pc.gi + 1] as Pt[], g.triangles, pc.from, pc.to)) return true;
      }
      for (const c of covers) {
        if (order.indexOf(c.slot) <= mine) continue;
        if (c.covers(p)) return true;
      }
      const wa = (built.contours[ci] as { width: number }).width;
      for (let other = 0; other < lines.length; other++) {
        if ((ownerIndex[other] as number) <= mine) continue;
        const wb = (built.contours[other] as { width: number }).width;
        const line = lines[other] as Pt[];
        for (let k = 0; k + 1 < line.length; k++) if (distanceToSegment(p, line[k] as Pt, line[k + 1] as Pt) + wa / 2 <= wb / 2 + 1) return true;
      }
      return false;
    };
    // Stroke clearance: held/end poses may keep no crack run >= minSpan; motion frames cap the longest run.
    {
      const cr = report.clearance;
      cr.checked++;
      if (hold) cr.holds++;
      else cr.transient.frames++;
      const found = strokeClearance(clearanceLines(built, verts), clearanceLimit, clearanceCovered(built, verts, covers)).map((v) => ({ ...v, at: `${sweepName} frame ${f}${hold ? " (hold)" : ""}: ${v.at}` }));
      // Contact bands (closeout, tightened after the review): a hold may not sit in a
      // band. Every sweep frame is a displayed (held) frame at the clip's fps, so every crack fails at
      // every frame, a band pair's crack inside its band included (counted as a displayed crossing
      // too). Motion may only jump across a band between displayed frames.
      const bands = rig.contacts ?? [];
      const sitting = bands.filter((b) => inContactBand(b, pose));
      if (hold && sitting.length && cr.contactHolds.length < 200) cr.contactHolds.push(`${sweepName} frame ${f}: in ${sitting.map((b) => b.name).join(", ")} (${label(pose)})`);
      for (const v of found) {
        const crossing = sitting.some((b) => pairMatches(b.pair, v.a, v.b));
        if (crossing && !hold) cr.contactCrossings++;
        if (cr.violations.length < 200) cr.violations.push(crossing ? { ...v, at: `${v.at} (displayed inside contact band)` } : v);
      }
      frameCrack = found.reduce<ClearanceViolation | null>((m, v) => (!m || v.span > m.span ? v : m), null);
    }
    // Visible kink: net turn over the window at visible vertices vs the cap and the bind turn.
    lines.forEach((line, ci) => {
      const input = kinkInput[ci] as { counts: boolean[]; bind: number[] };
      const vis = line.map((p) => !occluded(p, ci));
      const turns = windowTurns(line, kinkWindow, line.map((_, j) => (input.counts[j] as boolean) && (vis[j] as boolean)));
      const cap = (KINK_TURN * Math.PI) / 180;
      const slack = (KINK_SLACK * Math.PI) / 180;
      turns.forEach((t, j) => {
        if (!vis[j]) return;
        const b = input.bind[j] as number;
        const hi = Math.max(cap, b + slack);
        const lo = Math.min(-cap, b - slack);
        const k = report.kinks;
        k.checked++;
        const excess = Math.max(t - hi, lo - t);
        const c = built.contours[ci] as { owner: string; name: string; mesh: string; points: number[] };
        const p = line[j] as Pt;
        const note = `${sweepName} frame ${f} ${c.owner}/${c.name} at (${p[0].toFixed(0)}, ${p[1].toFixed(0)}): ${((t * 180) / Math.PI).toFixed(1)} deg over ${KINK_WINDOW} game px (bind ${((b * 180) / Math.PI).toFixed(1)})`;
        if (excess > k.maxExcess) Object.assign(k, { maxExcess: excess, worst: note });
        const hard = k.hard.find((h) => h.contour === `${c.owner}/${c.name}` && Object.entries(h.when).every(([bone, [lo, hi]]) => (pose[bone] ?? 0) >= lo && (pose[bone] ?? 0) <= hi));
        const inSpan = (h: HardKink) => !h.s || (() => { const cs = built.chain.coords((built.skin.points[(c as { points: number[] }).points[j] as number] as Pt)).s; return c.mesh === "skin" && cs >= (h.s as [number, number])[0] && cs <= (h.s as [number, number])[1]; })();
        if (hard && inSpan(hard)) {
          const hcap = (hard.turn * Math.PI) / 180;
          const hexcess = Math.max(t - Math.max(hcap, b + slack), Math.min(-hcap, b - slack) - t);
          hard.checked++;
          if (hexcess > hard.maxExcess) Object.assign(hard, { maxExcess: hexcess, worst: note });
          const sw = (hard.bySweep[sweepName] ??= { violations: 0, worst: -Infinity, at: "" });
          if (hexcess > 0) {
            hard.violations++;
            sw.violations++;
          }
          if (Math.abs(t) * (180 / Math.PI) > sw.worst) Object.assign(sw, { worst: +(Math.abs(t) * (180 / Math.PI)).toFixed(1), at: `frame ${f} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})` });
        }
        if (excess > 0) {
          k.violations++;
          k.bySweep[sweepName] = (k.bySweep[sweepName] ?? 0) + 1;
          if (k.first.length < 40 && !k.first.some((x) => x.startsWith(`${sweepName} `) && x.includes(`${c.owner}/${c.name}`))) k.first.push(note);
        }
      });
    });
    const junctionsNow = built.junctions.map((j, k) => ({ at: (verts[junctionMesh[k] as number] as Pt[])[j.index] as Pt, radius: j.radius }));
    const samples: VisibleSample[] = [];
    const all: VisibleSample[] = [];
    lines.forEach((line, ci) => {
      const c = built.contours[ci] as { mesh: string; owner: string; width: number };
      // The contour's own surface: its owner group's triangles (skin), else the garment.
      const ownGroup = groupSlots.indexOf(c.owner);
      const gi = preset.garments.findIndex((g) => g.name === c.mesh);
      const inOwn = (q: Pt) => {
        if (c.mesh === "skin") return ownGroup >= 0 ? pointInTriangles(q, verts[0] as Pt[], built.skin.triangles, ...(groupRanges[ownGroup] as [number, number])) : pointInPolygon(q, skinHull);
        return pointInPolygon(q, (verts[gi + 1] as Pt[]).slice(0, (built.garments[gi] as BuiltMesh).hull));
      };
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i] as Pt;
        const b = line[i + 1] as Pt;
        const len = dist(a, b);
        if (len < 1e-6) continue;
        const steps = Math.max(1, Math.round(len / 3));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const n: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
          const outward = inOwn([p[0] + 2 * n[0], p[1] + 2 * n[1]]) ? -1 : 1;
          const sample = { contour: ci, p, n, out: [n[0] * outward, n[1] * outward] as Pt, nearJunction: junctionsNow.some((j) => dist(j.at, p) < j.radius + c.width) };
          // Every sample takes part in the doubled check (a stroke stacked on another counts even
          // when one occludes the other); only visible ones are width samples.
          all.push(sample);
          if (!occluded(p, ci)) samples.push(sample);
        }
      }
    });
    const ends = lines.flatMap((l) => [l[0] as Pt, l[l.length - 1] as Pt]);
    for (const s of all) {
      const ca = built.contours[s.contour] as { width: number; name: string; owner: string };
      if (junctionsNow.some((j) => dist(j.at, s.p) < j.radius) || ends.some((e) => dist(e, s.p) < ca.width * 1.5)) continue;
      for (const o of all) {
        if (o.contour === s.contour) continue;
        const cb = built.contours[o.contour] as { width: number; name: string; owner: string };
        const limit = (ca.width + cb.width) / 2 - 0.5;
        const d = dist(s.p, o.p);
        // Two borders facing the same way this close = a doubled border; facing each other = two surfaces in contact.
        if (s.out[0] * o.out[0] + s.out[1] * o.out[1] < 0.5) continue;
        if (d < limit && doubled.length < 200) {
          doubled.push({ sweep: sweepName, frame: f, a: `${ca.owner}/${ca.name}`, b: `${cb.owner}/${cb.name}`, at: [Number(s.p[0].toFixed(1)), Number(s.p[1].toFixed(1))], distance: Number(d.toFixed(2)) });
          break;
        }
      }
    }
    return samples;
  };
  // The setup pose: no doubled border at rest.
  {
    const rest = meshes.map((m) => poser.vertices(m));
    contourFrame(rest, "rest", 0, report.doubledAtRest, true, {});
    checkRoots(rest, "rest");
    checkEnds(rest, "rest");
    checkContainment(rest, "rest");
  }
  // Draw-group occlusion: skin of a group drawn below a garment must not slide under it deeper than
  // the garment's edge half width (the limb belongs to a group drawn above the garment).
  for (const spec of preset.gates?.occlusion ?? []) {
    const gi = preset.garments.findIndex((g) => g.name === spec.garment);
    const garment = built.garments[gi];
    if (!garment) throw new Error(`occlusion: no garment '${spec.garment}'`);
    const limit = Math.max(0, ...(preset.garments[gi]?.contours ?? []).map((c) => c.width / 2));
    const rank = order.indexOf(garment.slot);
    const below = new Set<number>();
    groupSlots.forEach((slot, k) => {
      // Root groups (`under`) go under their garment by design; the partition-hidden gate holds them.
      if (order.indexOf(slot) >= rank || built.roots.some((r) => r.slot === slot)) return;
      const [from, to] = groupRanges[k] as [number, number];
      for (let t = from; t < to; t++) for (let j = 0; j < 3; j++) below.add(built.skin.triangles[t * 3 + j] as number);
    });
    const bindHull = garment.points.slice(0, garment.hull);
    const outside = [...below].filter((v) => !pointInPolygon(built.skin.points[v] as Pt, bindHull) && distanceToPolyline(built.skin.points[v] as Pt, bindHull, true) > 0.5);
    const state = { garment: spec.garment, limit, maxDepth: 0, at: "" };
    for (const pose of spec.poses) {
      poser.pose(pose);
      const sv = poser.vertices(built.skin);
      const hullNow = poser.vertices(garment).slice(0, garment.hull);
      for (const v of outside) {
        const q = sv[v] as Pt;
        if (!pointInPolygon(q, hullNow)) continue;
        const depth = distanceToPolyline(q, hullNow, true);
        if (depth > state.maxDepth) Object.assign(state, { maxDepth: Number(depth.toFixed(2)), at: `${JSON.stringify(pose)} vertex ${v} (${(built.skin.points[v] as Pt).map((x) => x.toFixed(0)).join(", ")})` });
      }
    }
    report.occlusion.push(state);
  }

  // The shared final-runtime pose set beyond the sweep frames (installed-grid nodes, edge midpoints
  // and centres, limit boundaries, third-driver values): judged by the same distortion evaluator, so
  // the gates and the validation companion cover the same poses. A failing pose names its grid cell.
  {
    const sweepLabels = new Set(Object.values(frames).flat().map((p) => poseLabel(p)));
    for (const p of finalPoses(rig)) {
      if (sweepLabels.has(p.label)) continue;
      poser.pose(p.pose);
      const found: GeometryFinding[] = [];
      const st = distortion.evaluator.evaluate(poser.skeleton, p.label, found);
      if (st.minDet < report.minAreaRatio) {
        report.minAreaRatio = st.minDet;
        report.minAreaAt = `${p.origin} ${st.worst}`;
      }
      for (const finding of found) {
        if (finding.kind === "flip") shape.flips++;
        else if (finding.kind === "collapse") shape.collapses++;
        if (finding.severity === "diagnostic") report.distortion.diagnostics++;
        else if (!distortion.seen.has(findingKey(finding))) {
          distortion.seen.add(findingKey(finding));
          report.distortion.findings.push(finding);
        }
      }
    }
  }

  const jRegions = junctionRegions(built);
  for (const sweep of preset.sweeps) {
    const poses = frames[sweep.name] as Pose[];
    const history: Pt[][] = [];
    const visibleFrames: VisibleSample[][] = [];
    const sweepCracks: CrackFrame[] = [];
    let prevResidual: Pt[] | null = null;
    poses.forEach((pose, f) => {
      report.frames++;
      poser.pose(pose);
      const verts = meshes.map((m) => poser.vertices(m));
      history.push(verts[0] as Pt[]);
      // Group boundary identity.
      const byIndex = new Map<number, [number, number]>();
      for (const slotName of groupSlots) {
        const slot = poser.skeleton.getSlot(slotName) as Slot & { groupMesh?: { geometry: { groups?: { vertices: ArrayLike<number> }[] } }; groupIndex: number };
        const group = slot.groupMesh?.geometry.groups?.[slot.groupIndex];
        if (!group) continue;
        const out = new Float64Array(group.vertices.length * 2);
        poser.skeleton.computeGroupWorldVertices(slot, out);
        for (let k = 0; k < group.vertices.length; k++) {
          const v = group.vertices[k] as number;
          if (!partition.has(v)) continue;
          const seen = byIndex.get(v);
          if (seen && (seen[0] !== out[k * 2] || seen[1] !== out[k * 2 + 1])) report.partitionMismatches++;
          byIndex.set(v, [out[k * 2] as number, out[k * 2 + 1] as number]);
        }
      }
      // Inversions, collapse and directional distortion: the unified evaluator, the
      // same function and finding IDs as `animator validate`.
      {
        const label = poseLabel(pose);
        const found: GeometryFinding[] = [];
        const st = distortion.evaluator.evaluate(poser.skeleton, label, found);
        if (st.minDet < report.minAreaRatio) {
          report.minAreaRatio = st.minDet;
          report.minAreaAt = `${sweep.name} frame ${f} ${st.worst}`;
        }
        const perMesh = new Map<string, { count: number; at: string }>();
        for (const finding of found) {
          if (finding.kind === "flip" || finding.kind === "collapse") {
            if (finding.kind === "flip") shape.flips++;
            else shape.collapses++;
            const entry = perMesh.get(finding.mesh) ?? { count: 0, at: "" };
            if (++entry.count <= 3) entry.at += ` ${finding.id.slice(finding.id.lastIndexOf("/") + 1)}:${finding.value.toFixed(2)}`;
            perMesh.set(finding.mesh, entry);
          }
          if (finding.severity === "diagnostic") report.distortion.diagnostics++;
          else if (!distortion.seen.has(findingKey(finding))) {
            distortion.seen.add(findingKey(finding));
            report.distortion.findings.push(finding);
          }
        }
        for (const [mesh, { count, at }] of perMesh) report.inverted.push({ sweep: sweep.name, frame: f, mesh: mesh.slice(0, mesh.indexOf("/")), count, at });
        if (st.maxVisibleStretch > report.distortion.maxVisibleStretch) Object.assign(report.distortion, { maxVisibleStretch: st.maxVisibleStretch, worst: `${sweep.name} frame ${f}: ${st.worst}` });
        report.distortion.maxEdgeRatio = Math.max(report.distortion.maxEdgeRatio, st.maxEdgeRatio);
      }
      // Embedded garment vertices: bit-identical to the skin point under them.
      {
        const sk = poser.skeleton;
        const skinSlot = sk.getSlot(built.skin.slot);
        const skinWorld = sk.meshWorldVertices(sk.getAttachment(skinSlot, built.skin.attachment) as MeshAttachment, skinSlot.bone);
        let e = 0;
        for (const g of built.garments) {
          if (!g.embed) continue;
          const slot = sk.getSlot(g.slot);
          const world = sk.meshWorldVertices(sk.getAttachment(slot, g.attachment) as MeshAttachment, slot.bone);
          let bad = 0;
          g.embed.vertices.forEach((v, k) => {
            const point = g.embed?.points[k] as number | [number, number, number, number, number];
            const [a, b, c, wa, wb] = typeof point === "number" ? [point, point, point, 1, 0] : point;
            const wc = typeof point === "number" ? 0 : 1 - wa - wb;
            for (let comp = 0; comp < 2; comp++) {
              const expected = Math.fround((skinWorld[a * 2 + comp] as number) * wa + (skinWorld[b * 2 + comp] as number) * wb + (skinWorld[c * 2 + comp] as number) * wc);
              if (world[v * 2 + comp] !== expected) bad++;
            }
          });
          (report.embed[e] as { mismatches: number }).mismatches += bad;
          e++;
        }
      }
      // Hidden coverage along garment openings.
      const skinHull = (verts[0] as Pt[]).slice(0, built.skin.hull);
      void skinHull;
      coverageSpecs.forEach((spec, k) => {
        const c = built.contours.find((x) => x.name === spec.contour && x.mesh !== "skin");
        if (!c) return;
        const gi = preset.garments.findIndex((g) => g.name === c.mesh);
        const gv = verts[gi + 1] as Pt[];
        const mesh = built.garments[gi] as BuiltMesh;
        const line = c.points.map((i) => gv[i] as Pt);
        const required = c.width / 2 + aaCanvas / 2;
        (coverageState[k] as { required: number }).required = required;
        const n = line.length;
        const nearestBind = (q: Pt) => c.points.reduce((best, vi, k) => (dist(mesh.points[vi] as Pt, q) < dist(mesh.points[c.points[best] as number] as Pt, q) ? k : best), 0);
        const i0 = nearestBind(spec.from);
        const i1 = nearestBind(spec.to);
        for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
          const a = line[Math.max(0, i - 1)] as Pt;
          const b = line[Math.min(n - 1, i + 1)] as Pt;
          const len = dist(a, b) || 1;
          const nx = (-(b[1] - a[1]) / len) * spec.side;
          const ny = ((b[0] - a[0]) / len) * spec.side;
          const p = line[i] as Pt;
          let d = 0;
          while (d < 40 && pointInPolygon([p[0] + nx * (d + 0.5), p[1] + ny * (d + 0.5)], skinHull)) d += 0.5;
          const state = coverageState[k] as { minOverlap: number; worstAt: string };
          if (d < state.minOverlap) {
            state.minOverlap = d;
            state.worstAt = `${sweep.name} frame ${f} near (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`;
          }
        }
      });
      // Pass 3b: the runtime against the solved target of this frame.
      {
        const x = verts[0] as Pt[];
        const where = `${sweep.name} frame ${f} ${label(pose)}`;
        solver.regions.forEach((r, k) => {
          const c = patchSelfIntersections(x, built.skin.triangles, r.triangles);
          if (c && !shape.selfIntersectionAt) shape.selfIntersectionAt = `${where} (${r.joint})`;
          shape.selfIntersections += c;
        });
        solver.solver.regionAreas(x).forEach((a, k) => {
          const st = shape.areas[k] as ShapeReport["areas"][number];
          if (a < st.min) Object.assign(st, { min: Number(a.toFixed(3)), minAt: where });
          if (a > st.max) Object.assign(st, { max: Number(a.toFixed(3)), maxAt: where });
        });
        const target = rig.targets[sweep.name]?.[f];
        if (!target || !target.ok) {
          shape.unsolvedFrames++;
          if (!shape.unsolvedFirst) shape.unsolvedFirst = `${where}: ${target?.reason ?? "no target"}`;
        } else {
          shape.lobes += target.lobes;
          const e = solver.silhouetteError(x, target);
          if (e.shape > shape.silhouette.canvasPx) shape.silhouette = { ...shape.silhouette, canvasPx: Number(e.shape.toFixed(3)), gamePx: Number((e.shape * gameScale).toFixed(3)), at: `${where} hull vertex ${e.at}` };
          const residual = x.map((p, i) => [p[0] - (target.x[i] as Pt)[0], p[1] - (target.x[i] as Pt)[1]] as Pt);
          if (prevResidual) {
            let jump = 0;
            // Silhouette residual (free hull vertices, pinned by the boundary curves): a visible jump.
            residual.forEach((r, i) => {
              if (target.curve[i]) jump = Math.max(jump, dist(r, prevResidual?.[i] as Pt));
            });
            if (jump * gameScale > shape.residualJumpGamePx) Object.assign(shape, { residualJumpGamePx: Number((jump * gameScale).toFixed(3)), residualJumpAt: where });
          }
          prevResidual = residual;
        }
        for (const row of swellRows) {
          const sw = shape.swelling;
          sw.checked++;
          const d = crossSection(x, row, boneDir(row.bone));
          const limit = row.bulge === null ? row.bind * (1 + SWELL_LIMIT) : row.bind + row.bulge;
          if (row.bulge === null && d / row.bind - 1 > sw.maxRatio) Object.assign(sw, { maxRatio: Number((d / row.bind - 1).toFixed(4)), maxRatioAt: `${where} ${row.bone} row s ${row.s.toFixed(1)}: ${d.toFixed(1)} vs bind ${row.bind.toFixed(1)}` });
          if (d > limit + 1e-6) {
            sw.outside++;
            if (!sw.worst) sw.worst = `${where} ${row.bone} row s ${row.s.toFixed(1)}: ${d.toFixed(1)} > ${limit.toFixed(1)} (bind ${row.bind.toFixed(1)}${row.bulge === null ? `, +${SWELL_LIMIT * 100}%` : `, bulge zone +${row.bulge}`})`;
          }
        }
        for (const w of widthRows) {
          shape.widths.checked++;
          const d = thickness(x, w);
          shape.widths.min = Math.min(shape.widths.min, Number(d.toFixed(1)));
          shape.widths.max = Math.max(shape.widths.max, Number(d.toFixed(1)));
          if (d < w.lo || d > w.hi) {
            shape.widths.outside++;
            if (!shape.widths.worst) shape.widths.worst = `${where} row s ${w.s.toFixed(1)}: ${d.toFixed(1)} not in [${w.lo}, ${w.hi}]`;
          }
        }
      }
      // Fixed regions and anchors, visible contour samples and doubled borders.
      checkFixed(verts[0] as Pt[], `${sweep.name} frame ${f}`);
      checkRoots(verts, `${sweep.name} frame ${f} ${label(pose)}`);
      checkEnds(verts, `${sweep.name} frame ${f} ${label(pose)}`);
      checkContainment(verts, `${sweep.name} frame ${f} ${label(pose)}`);
      const hold = isHold(pose, f, poses.length);
      visibleFrames.push(contourFrame(verts, sweep.name, f, report.doubled, hold, pose));
      for (const g of junctionGates(built, jRegions, verts[0] as Pt[], pose)) {
        const j = report.junctions[g.kind];
        j.checked++;
        const note = `${sweep.name} frame ${f} ${label(pose)} ${g.patch}: ${g.deg.toFixed(1)} deg vs rest ${g.bindDeg.toFixed(1)} at (${g.at[0].toFixed(0)}, ${g.at[1].toFixed(0)}), limit ${g.cap.toFixed(1)}`;
        if (g.excess - g.cap > j.maxExcess) Object.assign(j, { maxExcess: g.excess - g.cap, worst: note });
        if (g.excess > g.cap) {
          j.violations++;
          if (j.first.length < 12) j.first.push(note);
        }
      }
      sweepCracks.push({ pose, hold, crack: frameCrack });
    });
    report.visible[sweep.name] = visibleFrames;
    {
      const cr = report.clearance;
      const streaks = crackStreaks(sweepCracks);
      cr.transient.streaks += streaks.length;
      for (const s of streaks) {
        if (s.degrees > cr.transient.maxDegrees) Object.assign(cr.transient, { maxDegrees: s.degrees, at: s.at });
        // Reported only: the time cap is gone (stepped playback), cracks outside bands already fail per frame.
      }
    }
    // Temporal pops: second difference of vertex trajectories.
    let max = 0;
    let at = 0;
    const perFrame: number[] = [];
    const stepOf = (f: number) => {
      const a = poses[f] as Pose;
      const b = poses[f + 1] as Pose;
      return Math.max(1e-9, ...[...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => Math.abs((b[k] ?? 0) - (a[k] ?? 0))));
    };
    for (let f = 1; f + 1 < history.length; f++) {
      const norm = (2 / Math.max(stepOf(f - 1), stepOf(f))) ** 2;
      let m = 0;
      const a = history[f - 1] as Pt[];
      const b = history[f] as Pt[];
      const c = history[f + 1] as Pt[];
      for (let i = 0; i < b.length; i++) {
        const dx = (a[i] as Pt)[0] - 2 * (b[i] as Pt)[0] + (c[i] as Pt)[0];
        const dy = (a[i] as Pt)[1] - 2 * (b[i] as Pt)[1] + (c[i] as Pt)[1];
        m = Math.max(m, Math.hypot(dx, dy) * norm);
      }
      perFrame.push(m);
      if (m > max) {
        max = m;
        at = f;
      }
    }
    const sorted = [...perFrame].sort((x, y) => x - y);
    report.pops.push({ sweep: sweep.name, maxSecondDiffGamePx: Number((max * gameScale).toFixed(3)), atFrame: at, medianGamePx: Number(((sorted[Math.floor(sorted.length / 2)] ?? 0) * gameScale).toFixed(3)) });
  }
  report.coverage = coverageState.map((s) => ({ ...s, minOverlap: Number(s.minOverlap.toFixed(2)), required: Number(s.required.toFixed(2)) }));
  // Pose-limit polygon vertices (every pose in the limits: the sweeps above plus these corners).
  for (const lim of rig.limits) {
    for (const [x, y] of lim.polygon) {
      const pose: Pose = { [lim.x]: x, [lim.y]: y };
      poser.pose(pose);
      const verts = meshes.map((m) => poser.vertices(m));
      checkRoots(verts, `limit ${lim.name} ${label(pose)}`);
      checkContainment(verts, `limit ${lim.name} ${label(pose)}`);
    }
  }
  for (const st of report.partitionHidden) st.minDepth = Number(st.minDepth.toFixed(2));
  for (const st of report.junctionContainment) st.minDepth = Number(st.minDepth.toFixed(2));
  return report;
}


// ---------------------------------------------------------------------------------------------
// Garment pieces (3d-1 fix review: overlays)
// ---------------------------------------------------------------------------------------------

/** A garment's body piece or one of its overlays: a triangle range, its boundary edges and the strokes it owns. */
export interface GarmentPiece {
  slot: string;
  /** Garment index (verts[gi + 1]). */
  gi: number;
  from: number;
  to: number;
  /** The garment mesh's triangle list. */
  triangles: number[];
  /** True for a garment without overlays (its hull is the piece). */
  whole: boolean;
  /** Boundary edges of the range; `stroked` when a stroke this piece owns runs along it. */
  boundary: { a: number; b: number; stroked: boolean }[];
  strokes: { ids: number[]; half: number }[];
}

export function garmentPieces(built: BuiltSurface): GarmentPiece[] {
  return built.garments.flatMap((g, gi) => {
    const name = built.preset.garments[gi]?.name as string;
    const ranges = g.groups ?? { [g.slot]: [[0, g.triangles.length / 3]] as [number, number][] };
    return Object.entries(ranges).map(([slot, r]) => {
      const [from, to] = r[0] as [number, number];
      const count = new Map<string, [number, number, number]>();
      for (let t = from; t < to; t++) {
        for (let k = 0; k < 3; k++) {
          const a = g.triangles[t * 3 + k] as number;
          const b = g.triangles[t * 3 + ((k + 1) % 3)] as number;
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          const e = count.get(key);
          count.set(key, e ? [e[0], e[1], e[2] + 1] : [a, b, 1]);
        }
      }
      const strokes = built.contours.filter((c) => c.mesh === name && c.owner === slot).map((c) => ({ ids: c.points, half: c.width / 2 }));
      const stroked = new Set(strokes.flatMap((st) => st.ids.slice(1).map((b, k) => { const a = st.ids[k] as number; return a < b ? `${a},${b}` : `${b},${a}`; })));
      const boundary = [...count.entries()].filter(([, e]) => e[2] === 1).map(([key, e]) => ({ a: e[0], b: e[1], stroked: stroked.has(key) }));
      return { slot, gi, from, to, triangles: g.triangles, whole: !g.groups, boundary, strokes };
    });
  });
}

/** Distance from `p` to the piece's boundary edges (posed `verts`). */
function pieceEdgeDistance(pc: GarmentPiece, verts: readonly (readonly Pt[])[], p: Pt): number {
  const v = verts[pc.gi + 1] as Pt[];
  let m = Infinity;
  for (const e of pc.boundary) m = Math.min(m, distanceToSegment(p, v[e.a] as Pt, v[e.b] as Pt));
  return m;
}

/**
 * Signed depth of `p` inside a piece's opaque footprint (its triangles plus the strokes it owns),
 * canvas px, positive inside: inside the triangles, the distance to the nearest boundary edge
 * (an edge under one of its strokes counts half a stroke width further out); elsewhere the best
 * stroke depth (half width minus the distance to the centreline), else minus the distance to the
 * triangles. A lower bound of the true depth of the union.
 */
export function pieceDepth(pc: GarmentPiece, verts: readonly (readonly Pt[])[], p: Pt): number {
  const v = verts[pc.gi + 1] as Pt[];
  let stroke = -Infinity;
  for (const st of pc.strokes) {
    let m = Infinity;
    for (let k = 0; k + 1 < st.ids.length; k++) m = Math.min(m, distanceToSegment(p, v[st.ids[k] as number] as Pt, v[st.ids[k + 1] as number] as Pt));
    stroke = Math.max(stroke, st.half - m);
  }
  let inner = Infinity;
  let any = Infinity;
  for (const e of pc.boundary) {
    const d = distanceToSegment(p, v[e.a] as Pt, v[e.b] as Pt);
    any = Math.min(any, d);
    inner = Math.min(inner, e.stroked ? d + Math.max(0, ...pc.strokes.map((st) => st.half)) : d);
  }
  const inside = pointInTriangles(p, v, pc.triangles, pc.from, pc.to);
  return Math.max(stroke, inside ? inner : -any);
}

/**
 * Overlay invisibility (3d-1 fix review): the raw document with every overlay merged back
 * into its garment's body piece (its triangle range and its contours drawn at the garment slot).
 */
export function mergeOverlays(built: BuiltSurface, raw: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(raw)) as { slots: { name: string }[]; skins: Record<string, { attachments: Record<string, Record<string, { groups?: Record<string, [number, number][]> }>>; contours?: Record<string, Record<string, unknown>> }> };
  for (const o of built.overlays) {
    copy.slots = copy.slots.filter((x) => x.name !== o.name);
    for (const skin of Object.values(copy.skins)) {
      for (const att of Object.values(skin.attachments[o.slot] ?? {})) {
        if (!att.groups?.[o.name]) continue;
        att.groups[o.slot] = [...(att.groups[o.slot] ?? []), ...(att.groups[o.name] as [number, number][])];
        delete att.groups[o.name];
      }
      const owned = skin.contours?.[o.name];
      if (owned && skin.contours) {
        skin.contours[o.slot] = { ...(skin.contours[o.slot] ?? {}), ...owned };
        delete skin.contours[o.name];
      }
      // Contour contacts follow their contours to the garment slot (the merged render must merge the
      // same pairs, or the overlay is visible wherever a contact moves its ink).
      for (const cc of (skin as { contourContacts?: { a: { slot: string }; b: { slot: string } }[] }).contourContacts ?? []) {
        if (cc.a.slot === o.name) cc.a.slot = o.slot;
        if (cc.b.slot === o.name) cc.b.slot = o.slot;
      }
    }
  }
  return copy as unknown as Record<string, unknown>;
}

/**
 * Pixels where the render with overlays differs from the merged render must lie where an overlay
 * covers a skin group drawn between its garment body and itself (both footprints dilated by `pad`
 * canvas px for anti-aliasing): anywhere else the overlay must be invisible (same fills, weights and
 * geometry; no seam along its inner boundary).
 */
export function overlayInvisibility(rig: SurfaceRig, pose: Pose, a: RgbaImage, b: RgbaImage, display: { scale: number; left: number; top: number }, threshold = 8): { differing: number; explained: number; joins: number; unexplained: number; at: string } {
  const { built } = rig;
  const poser = new Poser(rig.document, built);
  poser.pose(pose);
  const verts = [built.skin, ...built.garments].map((m) => poser.vertices(m));
  const pieces = garmentPieces(built);
  const order = built.drawOrder;
  const pad = 1.5 / display.scale;
  const overlays = built.overlays.map((o) => {
    const pc = pieces.find((x) => x.slot === o.name) as GarmentPiece;
    const lo = order.indexOf(o.slot);
    const hi = order.indexOf(o.name);
    const between = built.groupSlots.flatMap((slot, k) => {
      const r = order.indexOf(slot);
      if (r <= lo || r >= hi) return [];
      return [{ range: (built.skin.groups?.[slot]?.[0] ?? [0, 0]) as [number, number], strokes: built.contours.filter((c) => c.mesh === "skin" && c.owner === slot).map((c) => ({ pts: c.points.map((i) => (verts[0] as Pt[])[i] as Pt), half: c.width / 2 })), k }];
    });
    // Joins: an overlay contour end shared with a body-piece contour (the trim continuing as the
    // neckline or the flank). The two strokes are separate draws, so their anti-aliased fringes
    // compose in a different order there; pixels within a stroke width of a join are reported apart.
    const gi = built.garments.findIndex((_, k) => built.preset.garments[k]?.name === o.garment);
    const mine = built.contours.filter((c) => c.mesh === o.garment && c.owner === o.name);
    const others = built.contours.filter((c) => c.mesh === o.garment && c.owner !== o.name);
    const joins = mine.flatMap((c) => [c.points[0] as number, c.points[c.points.length - 1] as number]).filter((v) => others.some((x) => x.points[0] === v || x.points[x.points.length - 1] === v)).map((v) => ({ at: (verts[gi + 1] as Pt[])[v] as Pt, r: Math.max(...mine.map((c) => c.width)) + pad }));
    return { pc, between, joins };
  });
  const inBetween = (q: Pt, between: (typeof overlays)[number]["between"]) =>
    between.some((g) => {
      if (pointInTriangles(q, verts[0] as Pt[], built.skin.triangles, g.range[0], g.range[1])) return true;
      const tri = built.skin.triangles;
      for (let t = g.range[0]; t < g.range[1]; t++) {
        const v = [0, 1, 2].map((k) => (verts[0] as Pt[])[tri[t * 3 + k] as number] as Pt) as [Pt, Pt, Pt];
        if (Math.min(distanceToSegment(q, v[0], v[1]), distanceToSegment(q, v[1], v[2]), distanceToSegment(q, v[2], v[0])) <= pad) return true;
      }
      return g.strokes.some((st) => distanceToPolyline(q, st.pts, false) <= st.half + pad);
    });
  let differing = 0;
  let explained = 0;
  let joins = 0;
  let at = "";
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs((a.data[i + c] as number) - (b.data[i + c] as number)));
      if (d <= threshold) continue;
      differing++;
      const q: Pt = [display.left + (x + 0.5) / display.scale, display.top + (y + 0.5) / display.scale];
      if (overlays.some((o) => pieceDepth(o.pc, verts, q) >= -pad && inBetween(q, o.between))) explained++;
      else if (overlays.some((o) => o.joins.some((j) => dist(j.at, q) <= j.r))) joins++;
      else if (!at) at = `(${x}, ${y}) = canvas (${q[0].toFixed(1)}, ${q[1].toFixed(1)}), max channel diff ${d}`;
    }
  }
  return { differing, explained, joins, unexplained: differing - explained - joins, at };
}

// ---------------------------------------------------------------------------------------------
// Structural gates (pass 3a): connectivity, weight support, ownership, registration
// ---------------------------------------------------------------------------------------------

export interface MeshTopology {
  mesh: string;
  /** Edge-connected triangle components (1 = one connected surface). */
  components: number;
  /** Edges used by more than two triangles. */
  nonManifold: number;
  /** Boundary edges that are not hull edges, plus hull edges that are not boundary edges. */
  boundaryMismatch: number;
}

/** Connectivity of a triangle mesh whose first `hull` points form its boundary loop. */
export function meshTopology(mesh: string, triangles: readonly number[], hull: number): MeshTopology {
  const uses = new Map<string, number[]>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < triangles.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const e = key(triangles[t * 3 + k] as number, triangles[t * 3 + ((k + 1) % 3)] as number);
      (uses.get(e) ?? (uses.set(e, []).get(e) as number[])).push(t);
    }
  }
  const parent = Array.from({ length: triangles.length / 3 }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
  let nonManifold = 0;
  const boundary = new Set<string>();
  for (const [e, ts] of uses) {
    if (ts.length > 2) nonManifold++;
    if (ts.length === 1) boundary.add(e);
    for (let k = 1; k < ts.length; k++) parent[find(ts[k] as number)] = find(ts[0] as number);
  }
  const components = new Set(parent.map((_, i) => find(i))).size;
  let boundaryMismatch = 0;
  const hullEdges = new Set(Array.from({ length: hull }, (_, i) => key(i, (i + 1) % hull)));
  for (const e of hullEdges) if (!boundary.has(e)) boundaryMismatch++;
  for (const e of boundary) if (!hullEdges.has(e)) boundaryMismatch++;
  return { mesh, components, nonManifold, boundaryMismatch };
}

export interface StructureReport {
  connectivity: { meshes: MeshTopology[]; conformUnembedded: { mesh: string; vertices: number }[] };
  support: {
    /** Influences on a bone outside the vertex's support region (must be 0). */
    violations: number;
    first: string[];
    /** Vertices in both a root side patch and a distal hinge band. */
    overlaps: number;
    patches: BuiltSurface["patches"];
    /** Side patches whose extent search found no transition above the area floor, or whose width fraction left its range. */
    infeasible: string[];
    regions: Record<string, number>;
  };
  ownership: {
    /** Skin contour segments drawn by an owner that is not the draw group of the triangle they bound. */
    ownerMismatch: number;
    ownerMismatchAt: string[];
    /** Hull edges carried by more than one contour of the same mesh. */
    sharedSpans: number;
    /** Contour ends that neither share a vertex with another contour nor lie at a declared junction. */
    looseEnds: string[];
  };
  registration: {
    /** Conform garment triangles (inside the skin hull) not contained in one skin triangle. */
    conformCrossings: { mesh: string; triangles: number; crossing: number }[];
  };
}

export function structureGates(built: BuiltSurface): StructureReport {
  const preset = built.preset;
  const skin = built.skin;
  const meshes: BuiltMesh[] = [skin, ...built.garments];
  const meshKey = (m: BuiltMesh) => (m === skin ? "skin" : (preset.garments[built.garments.indexOf(m)]?.name ?? m.slot));
  // Connectivity.
  // A garment with overlays: its body piece is the whole surface (overlays redraw part of it).
  const topo = meshes.map((m) => {
    const body = m.groups?.[m.slot]?.[0];
    return meshTopology(meshKey(m), body && m !== skin ? m.triangles.slice(body[0] * 3, body[1] * 3) : m.triangles, m.hull);
  });
  // Conform garments: every vertex is embedded (on the skin) or inherits along the garment mesh (off it).
  const conformUnembedded = built.garments.filter((g) => g.conform).map((g) => ({ mesh: meshKey(g), vertices: g.points.length - (g.embed?.vertices.length ?? 0) - (g.offSkin?.length ?? 0) }));
  // Weight support.
  let violations = 0;
  const first: string[] = [];
  const regions: Record<string, number> = {};
  skin.weights.forEach((inf, i) => {
    const sup = built.support[i];
    if (!sup) return;
    regions[sup.region] = (regions[sup.region] ?? 0) + 1;
    for (const [b, w] of inf) {
      if (w !== 0 && !sup.allowed.includes(b)) {
        violations++;
        if (first.length < 5) first.push(`vertex ${i} (${sup.region}): ${skin.bones[b]} ${w}`);
      }
    }
  });
  const infeasible = built.patches.filter((p) => p.side !== "both" && (!p.feasible || (p.ratio !== undefined && !(p.ratio >= 0 && p.ratio <= 1)))).map((p) => `${p.name}: min blend ratio ${p.minBlendRatio}`);
  // Ownership: a skin contour bounds triangles of its the user's draw group.
  const edgeTriangle = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < skin.triangles.length / 3; t++) for (let k = 0; k < 3; k++) edgeTriangle.set(key(skin.triangles[t * 3 + k] as number, skin.triangles[t * 3 + ((k + 1) % 3)] as number), t);
  const groupSlots = built.groupSlots;
  const junctionPoints = built.junctions.map((j) => {
    const m = j.mesh === "skin" ? skin : (built.garments[preset.garments.findIndex((g) => g.name === j.mesh)] as BuiltMesh);
    return { at: m.points[j.index] as Pt, radius: j.radius, name: j.name };
  });
  const pieces = garmentPieces(built);
  const bind = [skin.points, ...built.garments.map((g) => g.points)];
  let ownerMismatch = 0;
  const ownerMismatchAt: string[] = [];
  let sharedSpans = 0;
  const looseEnds: string[] = [];
  const spanOwner = new Map<string, string>();
  for (const c of built.contours) {
    const mesh = c.mesh === "skin" ? skin : (built.garments[preset.garments.findIndex((g) => g.name === c.mesh)] as BuiltMesh);
    for (let k = 0; k + 1 < c.points.length; k++) {
      const a = c.points[k] as number;
      const b = c.points[k + 1] as number;
      const e = `${c.mesh}:${key(a, b)}`;
      if (spanOwner.has(e)) sharedSpans++;
      spanOwner.set(e, `${c.owner}/${c.name}`);
      if (c.mesh !== "skin") continue;
      const t = edgeTriangle.get(key(a, b));
      const group = t === undefined ? undefined : groupSlots[built.triangleGroups[t] as number];
      const mid: Pt = [((mesh.points[a] as Pt)[0] + (mesh.points[b] as Pt)[0]) / 2, ((mesh.points[a] as Pt)[1] + (mesh.points[b] as Pt)[1]) / 2];
      if (group !== c.owner && !junctionPoints.some((j) => dist(j.at, mid) < j.radius)) {
        ownerMismatch++;
        if (ownerMismatchAt.length < 5) ownerMismatchAt.push(`${c.owner}/${c.name} over ${group ?? "no triangle"} at (${mid[0].toFixed(1)}, ${mid[1].toFixed(1)})`);
      }
    }
    for (const end of [c.points[0] as number, c.points[c.points.length - 1] as number]) {
      const p = mesh.points[end] as Pt;
      const shared = built.contours.some((o) => o !== c && o.mesh === c.mesh && (o.points[0] === end || o.points[o.points.length - 1] === end));
      // Hidden ends (under a garment piece drawn above the user at bind; gate "ends hidden or joined" checks every pose).
      const mine = built.drawOrder.indexOf(c.owner);
      const hidden = c.mesh === "skin" && pieces.some((pc) => built.drawOrder.indexOf(pc.slot) > mine && pieceDepth(pc, bind, p) >= 0);
      if (!shared && !hidden && !junctionPoints.some((j) => dist(j.at, p) <= j.radius)) looseEnds.push(`${c.owner}/${c.name} end at (${p[0].toFixed(1)}, ${p[1].toFixed(1)})`);
    }
  }
  // Registration: conform garment triangles each inside one skin triangle.
  const skinHull = skin.points.slice(0, skin.hull);
  const conformCrossings = built.garments
    .filter((g) => g.conform)
    .map((g) => {
      let triangles = 0;
      let crossing = 0;
      for (let t = 0; t < g.triangles.length / 3; t++) {
        const v = [0, 1, 2].map((k) => g.points[g.triangles[t * 3 + k] as number] as Pt) as [Pt, Pt, Pt];
        const c: Pt = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3];
        if (!pointInPolygon(c, skinHull)) continue;
        triangles++;
        // Contained: every vertex inside one skin triangle, or outside it by at most the conform
        // snapping tolerance (sub-pixel; the affine map error there is negligible).
        let inside = false;
        for (let s = 0; s < skin.triangles.length / 3 && !inside; s++) {
          const a = skin.points[skin.triangles[s * 3] as number] as Pt;
          const b = skin.points[skin.triangles[s * 3 + 1] as number] as Pt;
          const d = skin.points[skin.triangles[s * 3 + 2] as number] as Pt;
          if (Math.abs(triangleArea(a, b, d)) < 1e-12) continue;
          inside = v.every((p) => pointInTriangles(p, [a, b, d], [0, 1, 2], 0, 1) || Math.min(distanceToSegment(p, a, b), distanceToSegment(p, b, d), distanceToSegment(p, d, a)) <= CONFORM_TOLERANCE);
        }
        if (!inside) crossing++;
      }
      return { mesh: meshKey(g), triangles, crossing };
    });
  return {
    connectivity: { meshes: topo, conformUnembedded },
    support: { violations, first, overlaps: built.patchOverlaps, patches: built.patches, infeasible, regions },
    ownership: { ownerMismatch, ownerMismatchAt, sharedSpans, looseEnds },
    registration: { conformCrossings }
  };
}

// ---------------------------------------------------------------------------------------------
// Image gates
// ---------------------------------------------------------------------------------------------

function bilinear(img: RgbaImage, x: number, y: number): [number, number, number] {
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(x - 0.5)));
  const y0 = Math.max(0, Math.min(img.height - 2, Math.floor(y - 0.5)));
  const tx = Math.min(1, Math.max(0, x - 0.5 - x0));
  const ty = Math.min(1, Math.max(0, y - 0.5 - y0));
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = (xx: number, yy: number) => img.data[(yy * img.width + xx) * 4 + c] as number;
    out[c] = (p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty;
  }
  return out;
}

export interface WidthResult {
  samples: number;
  /** Samples skipped: profile outside the capture or its margin, or too little underlay contrast. */
  skipped: { outOfFrame: number; lowContrast: number };
  worstErrorGamePx: number;
  p99ErrorGamePx: number;
  meanWidthGamePx: number;
  worst: string;
  /** Per contour (owner/name): measured errors (game px). */
  perContour: Record<string, number[]>;
}

/**
 * Coverage integral across one stroke profile (display px): along the normal n through `centre`,
 * each point's coverage is how far the capture moved from its underlay towards the ink colour.
 * `underAt(t)` gives the underlay at offset t along n. Null when the underlay is too close to the ink.
 */
export function profileWidth(image: RgbaImage, underAt: (t: number) => [number, number, number], centre: Pt, n: Pt, edge: number, ink: readonly number[]): number {
  let width = 0;
  const step = 0.125;
  for (let t = -edge; t <= edge; t += step) {
    const u = underAt(t);
    const px = bilinear(image, centre[0] + n[0] * t, centre[1] + n[1] * t);
    const ku = [(ink[0] as number) - u[0], (ink[1] as number) - u[1], (ink[2] as number) - u[2]] as const;
    const den = ku[0] * ku[0] + ku[1] * ku[1] + ku[2] * ku[2];
    width += Math.min(1, Math.max(0, ((px[0] - u[0]) * ku[0] + (px[1] - u[1]) * ku[1] + (px[2] - u[2]) * ku[2]) / den)) * step;
  }
  return width;
}

/**
 * Known-good stroke (pass 3d-2, an independent member of the width calibration): an
 * analytic annulus of display width `w` (supersampled 8 x 8 per pixel, exact coverage) over a flat
 * background at a fractional offset, measured with the same profile integral against its underlay.
 * Returns the absolute errors (display px) over 72 normals.
 */
export function knownGoodStroke(w: number, background: readonly number[], ink: readonly number[], offset: number): number[] {
  const R = 18 + 3 * w;
  const size = Math.ceil(2 * R + 4 * w + 16);
  const c: Pt = [size / 2 + offset, size / 2 + offset];
  const img = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) if (Math.abs(Math.hypot(x + (sx + 0.5) / 8 - c[0], y + (sy + 0.5) / 8 - c[1]) - R) <= w / 2) cov++;
      const a = cov / 64;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) img.data[i + k] = Math.round((background[k] as number) * (1 - a) + (ink[k] as number) * a);
      img.data[i + 3] = 255;
    }
  }
  const bg: [number, number, number] = [background[0] as number, background[1] as number, background[2] as number];
  const errors: number[] = [];
  for (let k = 0; k < 72; k++) {
    const a = (k * Math.PI) / 36;
    const n: Pt = [Math.cos(a), Math.sin(a)];
    errors.push(Math.abs(profileWidth(img, () => bg, [c[0] + n[0] * R, c[1] + n[1] * R], n, w / 2 + 2.5, ink) - w));
  }
  return errors;
}

/** Summary of a list of errors (game px). */
export function errorStats(errors: readonly number[]): { samples: number; p99: number; mean: number; worst: number } {
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p99: Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0).toFixed(3)),
    mean: Number((sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : 0).toFixed(3)),
    worst: Number((sorted[sorted.length - 1] ?? 0).toFixed(3))
  };
}

/**
 * Coverage-aware perpendicular width of every visible contour sample in a Pixi capture: along the
 * normal, coverage c = how far a pixel moved from its underlay (sampled just past the stroke on
 * that side) towards the ink colour; width = integral of c. Expressed in game pixels (`gameScale`
 * output pixels per game pixel ... display pixels / dpr) against the authored width.
 */
export function measureWidths(
  rig: SurfaceRig,
  image: RgbaImage,
  samples: VisibleSample[],
  display: { scale: number; left: number; top: number; dpr: number; offsetX?: number; offsetY?: number; margin?: number },
  label: string,
  underlay?: RgbaImage
): WidthResult & { errors: number[]; records: { key: string; p: Pt; n: Pt; measured: number; error: number }[] } {
  const records: { key: string; p: Pt; n: Pt; measured: number; error: number }[] = [];
  const margin = display.margin ?? 2;
  const skipped = { outOfFrame: 0, lowContrast: 0 };
  const perContour: Record<string, number[]> = {};
  const { built } = rig;
  const preset = built.preset;
  const specs = [...preset.skin.contours, ...preset.garments.flatMap((g) => g.contours)];
  const gamePerCanvas = preset.gamePixels / preset.figureHeight;
  const errors: number[] = [];
  let worst = 0;
  let worstAt = "";
  let sum = 0;
  const toDisplay = (p: Pt): Pt => [(p[0] - display.left) * display.scale + (display.offsetX ?? 0), (p[1] - display.top) * display.scale + (display.offsetY ?? 0)];
  for (const s of samples) {
    const c = built.contours[s.contour] as { name: string; owner: string; width: number };
    const spec = specs.find((x) => x.name === c.name && x.owner === c.owner);
    if (!spec) continue;
    if (s.nearJunction) continue;
    // Skip samples with another visible contour within reach of the profile.
    const reach = c.width / 2 + 4 / display.scale;
    if (samples.some((o) => o.contour !== s.contour && dist(o.p, s.p) < reach + (built.contours[o.contour] as { width: number }).width / 2)) continue;
    const ink = [parseInt(spec.color.slice(0, 2), 16), parseInt(spec.color.slice(2, 4), 16), parseInt(spec.color.slice(4, 6), 16)];
    const half = (c.width * display.scale) / 2;
    const edge = half + 2.5;
    const centre = toDisplay(s.p);
    const at = (n: number) => bilinear(image, centre[0] + s.n[0] * n, centre[1] + s.n[1] * n);
    // The whole profile (edge + 0.5 each side) must lie inside the capture, clear of its margin.
    const reachOut = edge + 1.5;
    const ends: Pt[] = [
      [centre[0] - s.n[0] * reachOut, centre[1] - s.n[1] * reachOut],
      [centre[0] + s.n[0] * reachOut, centre[1] + s.n[1] * reachOut]
    ];
    if (ends.some(([x, y]) => x < margin || y < margin || x > image.width - margin || y > image.height - margin)) {
      skipped.outOfFrame++;
      continue;
    }
    // Underlay: with the contour-less render of the same frame (pass 3d-2) every profile
    // point has its own background, so a fill edge under the stroke does not read as ink; without
    // it, the colour just past the stroke on each side.
    const under = [at(-edge - 0.5), at(edge + 0.5)];
    const underAt = (n: number): [number, number, number] => (underlay ? bilinear(underlay, centre[0] + s.n[0] * n, centre[1] + s.n[1] * n) : (under[n < 0 ? 0 : 1] as [number, number, number]));
    const probes = underlay ? [-edge, -half / 2, 0, half / 2, edge].map(underAt) : under;
    const contrast = probes.map((u) => Math.hypot(u[0] - (ink[0] as number), u[1] - (ink[1] as number), u[2] - (ink[2] as number)));
    if (contrast.some((x) => x < 60)) {
      skipped.lowContrast++;
      continue;
    }
    const width = profileWidth(image, underAt, centre, s.n, edge, ink);
    const measured = width / display.scale; // canvas px
    const errorGame = Math.abs(measured - c.width) * gamePerCanvas;
    errors.push(errorGame);
    (perContour[`${c.owner}/${c.name}`] ??= []).push(errorGame);
    records.push({ key: `${c.owner}/${c.name}`, p: s.p, n: s.n, measured: measured * gamePerCanvas, error: errorGame });
    sum += measured * gamePerCanvas;
    if (errorGame > worst) {
      worst = errorGame;
      worstAt = `${label} ${c.owner}/${c.name} at (${s.p[0].toFixed(0)}, ${s.p[1].toFixed(0)}): ${(measured * gamePerCanvas).toFixed(3)} vs ${(c.width * gamePerCanvas).toFixed(3)} game px`;
    }
  }
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    samples: errors.length,
    skipped,
    perContour,
    worstErrorGamePx: Number(worst.toFixed(3)),
    p99ErrorGamePx: Number((sorted[Math.floor(sorted.length * 0.99)] ?? 0).toFixed(3)),
    meanWidthGamePx: Number((errors.length ? sum / errors.length : 0).toFixed(3)),
    worst: worstAt,
    errors,
    records
  };
}

/** Held and end poses for the clearance rule: rest, a sweep's first and last frame, a pose the preset declares in `gates.clearance.holds`. */
export function clearanceHold(preset: BuiltSurface["preset"], pose: Pose, f: number, count: number): boolean {
  if (f === 0 || f === count - 1) return true;
  const same = (a: Pose, b: Pose) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-6);
  return same(pose, {}) || (preset.gates?.clearance?.holds ?? []).some((h) => same(pose, h));
}

/**
 * Held and end poses inside a declared pass-through range (`gates.clearance.passThrough`): every
 * declared hold, the rest pose and each sweep's first and last frame (and any frame that matches a
 * declared hold) is checked against every range; a pose matches a range when each bone of `at` has
 * exactly that value and `joint` lies in `range` (inclusive). A pass-through is never a hold.
 */
export function passThroughHolds(preset: BuiltSurface["preset"], frames: Record<string, readonly Pose[]>): string[] {
  const ranges = preset.gates?.clearance?.passThrough ?? [];
  if (!ranges.length) return [];
  const out: string[] = [];
  const check = (pose: Pose, where: string) => {
    for (const r of ranges) {
      const lo = Math.min(r.range[0], r.range[1]);
      const hi = Math.max(r.range[0], r.range[1]);
      const v = pose[r.joint] ?? 0;
      if (Object.entries(r.at).every(([b, a]) => Math.abs((pose[b] ?? 0) - a) < 1e-6) && v >= lo - 1e-6 && v <= hi + 1e-6)
        out.push(`${where}: ${r.joint} ${v} in pass-through [${lo}, ${hi}]${Object.keys(r.at).length ? ` at ${label(r.at)}` : ""}`);
    }
  };
  (preset.gates?.clearance?.holds ?? []).forEach((h, i) => check(h, `declared hold ${i} (${label(h)})`));
  for (const sweep of preset.sweeps) {
    const poses = frames[sweep.name] ?? [];
    poses.forEach((pose, f) => {
      if (clearanceHold(preset, pose, f, poses.length)) check(pose, `${sweep.name} frame ${f} (hold)`);
    });
  }
  return out;
}

/** Clearance limits of a preset (canvas px). */
export function clearanceLimitOf(preset: BuiltSurface["preset"]): { maxAngle: number; minSpan: number; minGap: number; transientDegrees: number } {
  const cl = preset.gates?.clearance;
  return { maxAngle: cl?.maxAngle ?? 15, minSpan: cl?.minSpan ?? 3, minGap: (cl?.displayPx ?? 1) / (preset.gamePixels / preset.figureHeight), transientDegrees: cl?.transientDegrees ?? 6 };
}

/** Posed contour polylines (every mesh's vertices posed, skin first) keyed owner/name. */
export function clearanceLines(built: BuiltSurface, verts: Pt[][]): { key: string; points: Pt[]; width: number; chain: number }[] {
  // Garment contours chained end to start with one width are one ink (an edge split between the
  // garment's body piece and an overlay).
  const meshIndex = (mesh: string) => (mesh === "skin" ? 0 : built.preset.garments.findIndex((g) => g.name === mesh) + 1);
  const posed = built.contours.map((c) => c.points.map((i) => (verts[meshIndex(c.mesh)] as Pt[])[i] as Pt));
  // Contour contacts (the runtime's merged contact runs, core/contours.ts applyContacts), on unmoved
  // geometry; chains and junction inks as the runtime compiles them (mesh, width, end-to-start).
  const chainOf = built.contours.map((_, k) => k);
  const rootOf = (k: number): number => (chainOf[k] === k ? k : rootOf(chainOf[k] as number));
  built.contours.forEach((a, i) => built.contours.forEach((b, j) => {
    if (i === j || a.mesh !== b.mesh || a.width !== b.width || a.points[a.points.length - 1] !== b.points[0]) return;
    const [ra, rb] = [rootOf(i), rootOf(j)];
    if (ra !== rb) chainOf[Math.max(ra, rb)] = Math.min(ra, rb);
  }));
  const inks: ContactInk[] = built.contours.map((c, k) => ({ points: (posed[k] as Pt[]).flat(), count: c.points.length, closed: false, width: c.width, chain: rootOf(k) }));
  const contacts: ContourContact[][] = built.contours.map(() => []);
  for (const cc of contourContacts(built.preset, built.contours)) {
    const ia = built.contours.findIndex((c) => c.owner === cc.a.slot && c.name === cc.a.name);
    const ib = built.contours.findIndex((c) => c.owner === cc.b.slot && c.name === cc.b.name);
    if (ia < 0 || ib < 0) continue;
    const spec = { gap: cc.gap, cosMax: Math.cos((cc.angle * Math.PI) / 180), overlap: cc.gap, minRun: 2 * cc.gap, taper: cc.gap };
    (contacts[ia] as ContourContact[]).push({ other: ib, ...spec });
    (contacts[ib] as ContourContact[]).push({ other: ia, ...spec });
  }
  const moved = posed.map((pts, k) => {
    const out = pts.flat();
    applyContacts(out, inks[k] as ContactInk, contacts[k] as ContourContact[], inks.map((x, j) => (j === k ? null : x)));
    return pts.map((_, n) => [out[n * 2] as number, out[n * 2 + 1] as number] as Pt);
  });
  const items = built.contours.map((c, k) => ({ key: `${c.owner}/${c.name}`, mesh: c.mesh, ids: [...c.points], pts: [...(moved[k] as Pt[])], width: c.width }));
  for (let merged = true; merged; ) {
    merged = false;
    for (const a of items) {
      if (a.mesh === "skin") continue;
      const b = items.find((x) => x !== a && x.mesh === a.mesh && x.width === a.width && x.ids[0] === a.ids[a.ids.length - 1] && x.ids[x.ids.length - 1] !== a.ids[0]);
      if (!b) continue;
      a.ids.push(...b.ids.slice(1));
      a.pts.push(...b.pts.slice(1));
      a.key = `${a.key}+${b.key}`;
      items.splice(items.indexOf(b), 1);
      merged = true;
      break;
    }
  }
  // Skin outlines split between draw groups (upper arm, forearm) stay separate lines but one chain:
  // two pieces of one outline never form a crack with each other.
  const chain = items.map((_, k) => k);
  const root = (k: number): number => (chain[k] === k ? k : root(chain[k] as number));
  items.forEach((a, i) => items.forEach((b, j) => {
    if (i !== j && a.mesh === b.mesh && (a.ids[a.ids.length - 1] === b.ids[0] || a.ids[0] === b.ids[b.ids.length - 1])) chain[root(i)] = root(j);
  }));
  return items.map((c, k) => ({ key: c.key, points: c.pts, width: c.width, chain: root(k) }));
}

/** A rigid region's coverage at the skeleton's current pose. */
export interface RegionCover {
  name: string;
  slot: string;
  /** True where the region's opaque art (inside its keep polygon, texture alpha >= 128) lies at the current pose. */
  covers: (q: Pt) => boolean;
}

/**
 * Rigid-region coverage at the current pose: a query point is carried
 * back to the bind canvas through the region bone's inverse current world transform and its bind
 * transform, then tested against the keep polygon and, when the region texture is loaded, its alpha
 * (a keep polygon need not be filled to its edge). The skeleton must already be posed.
 */
export function regionCovers(rig: Pick<SurfaceRig, "built" | "textures" | "document">, skeleton: Skeleton): RegionCover[] {
  const preset = rig.built.preset;
  const { table } = boneTable(preset);
  const ox = rig.document.canvas.originX;
  const oy = rig.document.canvas.originY;
  return preset.regions.map((r) => {
    const bind = table.get(r.bone);
    if (!bind) throw new Error(`region '${r.name}': bone '${r.bone}' missing`);
    const w = skeleton.getBone(r.bone).world;
    const det = w.a * w.d - w.b * w.c;
    const cos = Math.cos((bind.rotation * Math.PI) / 180);
    const sin = Math.sin((bind.rotation * Math.PI) / 180);
    const tex = rig.textures.get(r.texture);
    const [x0, y0, cw, ch] = r.crop;
    const covers = (q: Pt): boolean => {
      // Bone-local point at the current pose, then the bind canvas point.
      const dx = q[0] - ox - w.x;
      const dy = q[1] - oy - w.y;
      const lx = (w.d * dx - w.b * dy) / det;
      const ly = (-w.c * dx + w.a * dy) / det;
      const b: Pt = [bind.at[0] + lx * cos - ly * sin, bind.at[1] + lx * sin + ly * cos];
      if (r.keep && !pointInPolygon(b, r.keep)) return false;
      if (!tex) return !!r.keep;
      const px = Math.floor(b[0] - x0);
      const py = Math.floor(b[1] - y0);
      if (px < 0 || py < 0 || px >= cw || py >= ch) return false;
      return (tex.data[(py * tex.width + px) * 4 + 3] as number) >= 128;
    };
    return { name: r.name, slot: r.slot, covers };
  });
}

/**
 * A point covered by a mesh or a rigid region (a gap there is not background). `regions` gives the
 * rigid regions at the pose of `verts` (regionCovers); without it, the bind keep polygons are used,
 * which is right at the setup pose only.
 */
export function clearanceCovered(built: BuiltSurface, verts: Pt[][], regions?: readonly RegionCover[]): (q: Pt, a?: string, b?: string) => boolean {
  // A third, garment stroke over the gap (a trim drawn across two outline ends) covers it too.
  const strokes = built.contours.filter((c) => c.mesh !== "skin").map((c) => {
    const mi = c.mesh === "skin" ? 0 : built.preset.garments.findIndex((g) => g.name === c.mesh) + 1;
    return { key: `${c.owner}/${c.name}`, points: c.points.map((i) => (verts[mi] as Pt[])[i] as Pt), half: c.width / 2 };
  });
  return (q, a = "", b = "") =>
    strokes.some((st) => !a.split("+").includes(st.key) && !b.split("+").includes(st.key) && distanceToPolyline(q, st.points, false) <= st.half - 0.5) ||
    pointInTriangles(q, verts[0] as Pt[], built.skin.triangles, 0, built.skin.triangles.length / 3) ||
    built.garments.some((g, gi) => pointInPolygon(q, (verts[gi + 1] as Pt[]).slice(0, g.hull))) ||
    (regions ? regions.some((r) => r.covers(q)) : built.preset.regions.some((r) => !!r.keep && pointInPolygon(q, r.keep)));
}

/**
 * Sub-pixel crack sample points (the middle of each gap sample on a run >= minSpan) at a pose: where
 * the clearance rule sees background narrower than one display px between near-parallel inks. In a
 * motion frame these cracks are the accepted transient (the time cap judges them), so the alpha
 * gate treats pixels on them as explained; held and end poses get no such allowance.
 */
export function clearanceCrackPoints(rig: SurfaceRig, pose: Pose): Pt[] {
  return clearanceContactPoints(rig, pose).cracks;
}

/**
 * Contact sample points at a pose: `cracks` as `clearanceCrackPoints`, and `seams`, the middles of
 * near-parallel ink pairs over background that overlap by less than one display px (gap in
 * (-minGap, 0]). Where two strokes overlap by under one output pixel, a pixel can hold both facing
 * edges: each stroke's AA fringe is partial and their composite stays under full alpha although the
 * union of the geometry is full (a conflation seam).): such alpha
 * pixels are excused only in motion frames, under the same degree time cap as the cracks.
 */
export function clearanceContactPoints(rig: SurfaceRig, pose: Pose): { cracks: Pt[]; seams: Pt[] } {
  const poser = new Poser(rig.document, rig.built);
  poser.pose(pose);
  const verts = [rig.built.skin, ...rig.built.garments].map((m) => poser.vertices(m));
  const cracks: Pt[] = [];
  const seams: Pt[] = [];
  strokeClearance(clearanceLines(rig.built, verts), clearanceLimitOf(rig.built.preset), clearanceCovered(rig.built, verts, regionCovers(rig, poser.skeleton)), 1.5, cracks, seams);
  return { cracks, seams };
}

/** One sweep frame for the clearance time cap: its pose, whether it is a held/end pose, its longest crack run. */
export interface CrackFrame {
  pose: Pose;
  hold: boolean;
  crack: ClearanceViolation | null;
}

/** A run of consecutive in-motion frames with a crack; `degrees` sums each frame's step from the previous frame. */
export interface CrackStreak {
  frames: number;
  degrees: number;
  /** Longest crack run (canvas px) inside the streak. */
  span: number;
  at: string;
}

/** Largest change of any bone between two poses (degrees): the moving joint's step. */
const poseStep = (a: Pose, b: Pose) => Math.max(0, ...[...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));

/**
 * Clearance time cap (pass 3d-1): an arm closing on the body
 * passes through sub-pixel cracks, which is acceptable while it moves. Groups consecutive cracked
 * frames that are not held or end poses (those fail on their own) into streaks and measures each
 * in degrees of the moving joint: every frame counts its step from the previous frame (the first
 * frame of a sweep its step to the next), so one cracked frame lasts one sweep step.
 */
export function crackStreaks(frames: readonly CrackFrame[]): CrackStreak[] {
  const out: CrackStreak[] = [];
  let cur: CrackStreak | null = null;
  frames.forEach((fr, f) => {
    if (!fr.crack || fr.hold) {
      if (cur) out.push(cur);
      cur = null;
      return;
    }
    const other = frames[f > 0 ? f - 1 : f + 1];
    const step = other ? poseStep(fr.pose, other.pose) : 0;
    if (!cur) cur = { frames: 0, degrees: 0, span: 0, at: fr.crack.at };
    cur.frames++;
    cur.degrees = Number((cur.degrees + step).toFixed(6));
    if (fr.crack.span > cur.span) Object.assign(cur, { span: fr.crack.span, at: fr.crack.at });
  });
  if (cur) out.push(cur);
  return out;
}

export interface ClearanceViolation {
  a: string;
  b: string;
  /** Arc length (canvas px) of the near-parallel run along `a` whose background gap to `b` is in (0, minGap). */
  span: number;
  /** Largest and smallest background gap between the two inks on the run (canvas px). */
  maxGap: number;
  minGap: number;
  at: string;
}

/**
 * Stroke clearance (pass 3d-1): wherever contour A runs near-parallel to a different
 * contour B (tangent angle below `maxAngle` degrees) and the background between their inks
 * (centre distance minus the two half widths) is above 0 and below `minGap` canvas px over a run
 * of at least `minSpan` canvas px along A, the pair leaves a thin slit or lens of background that
 * renders as a semi-transparent crack. Strokes may overlap (gap <= 0) or keep >= minGap apart.
 * A diverging wedge (two strokes leaving a junction at an angle) is not near-parallel and passes.
 */
export function strokeClearance(lines: { key: string; points: readonly Pt[]; width: number; chain?: number }[], limit: { maxAngle: number; minSpan: number; minGap: number }, covered: (p: Pt, a?: string, b?: string) => boolean = () => false, step = 1.5, samples?: Pt[], seams?: Pt[]): ClearanceViolation[] {
  const out: ClearanceViolation[] = [];
  const cosMax = Math.cos((limit.maxAngle * Math.PI) / 180);
  // B is a whole chain (outline pieces split between draw groups are one ink): nearest over all its segments.
  const chains = new Map<number | string, { key: string; width: number; points: Pt[][] }>();
  lines.forEach((l, k) => {
    const id = l.chain ?? `line${k}`;
    const c = chains.get(id);
    if (c) {
      c.key = `${c.key}+${l.key}`;
      c.points.push(l.points as Pt[]);
    } else chains.set(id, { key: l.key, width: l.width, points: [l.points as Pt[]] });
  });
  for (let ia = 0; ia < lines.length; ia++) {
    for (const [cid, B] of chains) {
      const A = lines[ia] as (typeof lines)[number];
      if (cid === (A.chain ?? `line${ia}`)) continue;
      let run = { span: 0, maxGap: 0, minGap: Infinity, at: "", mids: [] as Pt[] };
      const close = () => {
        if (run.span >= limit.minSpan) {
          out.push({ a: A.key, b: B.key, span: Number(run.span.toFixed(1)), maxGap: Number(run.maxGap.toFixed(2)), minGap: Number(run.minGap.toFixed(2)), at: run.at });
          samples?.push(...run.mids);
        }
        run = { span: 0, maxGap: 0, minGap: Infinity, at: "", mids: [] };
      };
      for (let i = 0; i + 1 < A.points.length; i++) {
        const p0 = A.points[i] as Pt;
        const p1 = A.points[i + 1] as Pt;
        const len = dist(p0, p1);
        if (len < 1e-9) continue;
        const ta: Pt = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const p: Pt = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
          let best = Infinity;
          let cos = 0;
          let near: Pt = p;
          for (const bp of B.points) for (let j = 0; j + 1 < bp.length; j++) {
            const q0 = bp[j] as Pt;
            const q1 = bp[j + 1] as Pt;
            const d = distanceToSegment(p, q0, q1);
            if (d < best) {
              const l = dist(q0, q1);
              best = d;
              cos = l > 1e-9 ? Math.abs((ta[0] * (q1[0] - q0[0]) + ta[1] * (q1[1] - q0[1])) / l) : 0;
              const u = l > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - q0[0]) * (q1[0] - q0[0]) + (p[1] - q0[1]) * (q1[1] - q0[1])) / (l * l))) : 0;
              near = [q0[0] + (q1[0] - q0[0]) * u, q0[1] + (q1[1] - q0[1]) * u];
            }
          }
          const gap = best - (A.width + B.width) / 2;
          // Background between the inks: the middle of the gap lies on no mesh (a limb drawn over the body is not a slit).
          const mid: Pt = [(p[0] + near[0]) / 2, (p[1] + near[1]) / 2];
          // Overlap seam (sub-display-px overlap of the two inks over background), collected for the alpha gate.
          if (seams && cos >= cosMax && gap <= 0 && gap > -limit.minGap && !covered(mid, A.key, B.key)) seams.push(mid);
          if (cos >= cosMax && gap > 0 && gap < limit.minGap && !covered(mid, A.key, B.key)) {
            if (samples) run.mids.push(mid);
            if (!run.span) run.at = `${A.key} at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}) vs ${B.key}`;
            run.span += len / n;
            run.maxGap = Math.max(run.maxGap, gap);
            run.minGap = Math.min(run.minGap, gap);
          } else close();
        }
      }
      close();
    }
  }
  return out;
}

/**
 * Pixels inside the expected filled region whose Pixi alpha is below 250. The expected fill is the
 * true combined coverage of every mesh and stroke (CPU id buffer supersampled `ss` x `ss` per pixel;
 * a pixel is expected full only when every subsample of it and of its `erode`-pixel neighbourhood
 * is covered), not each shape thresholded at its own pixel centre: a background gap narrower than a
 * pixel between two strokes (the tip of a sharp V) is partial coverage in the geometry itself, so
 * the semi-transparent pixel there is explained (pass 3d-1, measurement correction).
 */
export function alphaGaps(rig: SurfaceRig, pose: Pose, pixi: RgbaImage, display: { scale: number; left: number; top: number }, erode = 1, ss = 4, cracks: readonly Pt[] = [], seams: readonly Pt[] = []): { gaps: number; explained: number; seams: number; at: string } {
  const poser = new Poser(rig.document, rig.built);
  poser.pose(pose);
  const { originX, originY } = rig.document.canvas;
  const W = pixi.width * ss;
  // Subsample centres sit at (k + 0.5) / ss inside each output pixel.
  const soft = softRender(poser.skeleton, rig.textures, { width: W, height: pixi.height * ss, scale: display.scale * ss, left: display.left - originX, top: display.top - originY, ids: true });
  const ids = soft.topSlot as Int16Array;
  const full = new Uint8Array(pixi.width * pixi.height);
  for (let y = 0; y < pixi.height; y++) {
    for (let x = 0; x < pixi.width; x++) {
      let all = 1;
      for (let sy = 0; sy < ss && all; sy++) for (let sx = 0; sx < ss && all; sx++) if ((ids[(y * ss + sy) * W + x * ss + sx] as number) === 0) all = 0;
      full[y * pixi.width + x] = all;
    }
  }
  let gaps = 0;
  let explained = 0;
  let onSeams = 0;
  let at = "";
  // A transient sub-pixel crack (or overlap seam) explains pixels within half the clearance plus one sample step and one output pixel of its middles.
  const reach = clearanceLimitOf(rig.built.preset).minGap / 2 + 1.5 + 1 / display.scale;
  const near = (points: readonly Pt[], x: number, y: number) => {
    const c: Pt = [display.left + (x + 0.5) / display.scale, display.top + (y + 0.5) / display.scale];
    return points.some((q) => Math.abs(q[0] - c[0]) <= reach && Math.abs(q[1] - c[1]) <= reach && dist(q, c) <= reach);
  };
  const onCrack = (x: number, y: number) => near(cracks, x, y);
  for (let y = erode; y < pixi.height - erode; y++) {
    for (let x = erode; x < pixi.width - erode; x++) {
      let inside = true;
      for (let dy = -erode; dy <= erode && inside; dy++) for (let dx = -erode; dx <= erode && inside; dx++) if (!full[(y + dy) * pixi.width + x + dx]) inside = false;
      if (!inside) continue;
      if ((pixi.data[(y * pixi.width + x) * 4 + 3] as number) < 250) {
        if (cracks.length && onCrack(x, y)) {
          explained++;
          continue;
        }
        if (seams.length && near(seams, x, y)) {
          onSeams++;
          continue;
        }
        gaps++;
        if (!at) at = `(${x}, ${y})`;
      }
    }
  }
  return { gaps, explained, seams: onSeams, at };
}

/**
 * Canvas bounds of the whole figure through every sweep frame (every mesh vertex plus half the
 * widest contour, rigid regions at bind), padded by `pad` canvas px: the full-figure review view.
 */
export function figureBounds(rig: SurfaceRig, pad = 20): { left: number; top: number; right: number; bottom: number } {
  const { built, frames } = rig;
  const poser = new Poser(rig.document, built);
  const meshes: BuiltMesh[] = [built.skin, ...built.garments];
  const half = Math.max(0, ...built.contours.map((c) => c.width / 2));
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (p: Pt, r = 0) => {
    left = Math.min(left, p[0] - r);
    right = Math.max(right, p[0] + r);
    top = Math.min(top, p[1] - r);
    bottom = Math.max(bottom, p[1] + r);
  };
  for (const sweep of built.preset.sweeps) {
    for (const pose of frames[sweep.name] ?? []) {
      poser.pose(pose);
      for (const m of meshes) for (const p of poser.vertices(m)) add(p, half);
    }
  }
  for (const r of built.preset.regions) {
    add([r.crop[0], r.crop[1]]);
    add([r.crop[0] + r.crop[2], r.crop[1] + r.crop[3]]);
  }
  return { left: Math.floor(left - pad), top: Math.floor(top - pad), right: Math.ceil(right + pad), bottom: Math.ceil(bottom + pad) };
}

export { distanceToSegment };
