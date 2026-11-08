/*
 * Atlas Animator: original implementation.
 *
 * Continuous-surface builder (consult: one canonical connected skin surface with
 * designed joint topology, garments that own their openings, contours with one owner, angle-driven
 * correctives seeded at chosen angles plus two-driver grids). Input is a preset (data, see
 * preset.ts): bones by world pivots, a bone chain, authored vector paths for the skin silhouette,
 * garments and fills, weight rules, contour spans and corrective seeds. Output is an
 * `atlas-anim@1` document, its texture images and the metadata the gates need.
 *
 * Nothing here knows a particular template: a humanoid shoulder, a creature leg or a wing root
 * differ only in their preset.
 *
 * Pipeline: bones -> chain frame -> silhouette (resampled, row ends inserted) -> topology rows
 * (cross-sections from the chain: joint bands + rigid cores, apex fans) + joint rings + lattice ->
 * constrained Delaunay -> draw groups by explicit region polygons -> regions (pass 3a: joint
 * patches on boundary chains, rigid cores, fixed body regions) -> weight fields (root joint:
 * harmonic field whose boundary values are the patch ramps and the support masks; distal joints:
 * hinge bands; girdle: radial falloff feathered away from anchors) -> hard support masks (forbidden
 * influences exactly zero) -> fills rasterised without outlines -> garments (own lattice, or
 * `conform`: the skin triangulation clipped to the outline; embedded in the skin) -> junctions
 * and contours (spans of the silhouette or a garment edge between declared junctions) ->
 * correctives (target = joint-fraction rotation blend, offset = target - linear blend skinning)
 * -> sweeps as clips.
 */
import { mergeLineIntoMesh, simplifyLine } from "./featureMerge.js";
import cdt2d from "cdt2d";
import {
  ChainFrame,
  clamp01,
  deg,
  dist,
  distanceToPolyline,
  fillPolygon,
  pointInPolygon,
  rad,
  rotateAbout,
  samplePath,
  segmentCross,
  smoothstep,
  type FillImage,
  type PathPoint,
  type Pt
} from "./geometry.js";
import type { Anchor, Bend, Box, ContourSpec, Fill, Patch, SurfacePreset } from "./preset.js";

export interface BuiltMesh {
  slot: string;
  attachment: string;
  texture: string;
  bones: string[];
  /** Bind positions (canvas). */
  points: Pt[];
  hull: number;
  triangles: number[];
  /** Per vertex: influences [boneIndex, weight]. */
  weights: [number, number][][];
  /** Per vertex: chain coordinate s and v (skin only). */
  chainSV?: { s: number; v: number }[];
  /** Per vertex alpha per chain joint (skin) for the rotation-blend target. */
  alphas: number[][];
  image: FillImage;
  origin: Pt;
  groups?: Record<string, [number, number][]>;
  /** Embedded vertices (garments with `embed`): vertex -> point on the skin's bind triangles. */
  embed?: { vertices: number[]; points: EmbedPoint[] };
  /** Garment built by `conform`: the skin triangulation clipped to its outline. */
  conform?: boolean;
  /** Garment vertices off the skin that inherit the weights of their nearest embedded vertex along the garment mesh. */
  offSkin?: number[];
}

/** A vertex index of the skin, or [a, b, c, wa, wb] (wc = 1 - wa - wb), weights possibly a little outside [0, 1]. */
export type EmbedPoint = number | [number, number, number, number, number];

/** A notch apex resolved on the built hull. */
export interface BuiltApex {
  index: number;
  at: Pt;
  s: number;
  sign: 1 | -1;
  reach: number;
  /** Hull walk direction (+1/-1) from the apex along the limb's inner silhouette. */
  walk: 1 | -1;
  /** Rows (chain s) that end at the apex. */
  fanRows: number[];
}

/** An anchored notch apex: skin vertex, base permitted displacement (0: exact) and its optional girdle coupling. */
export interface BuiltAnchor {
  index: number;
  permittedMotion: number;
  /** Girdle coupling (preset `apexGirdle`): the allowance grows by gain x the girdle bone's elevation of the joint pivot away from the apex. */
  girdle?: { bone: string; parent: string; joint: string; gain: number; jointAt: Pt; apexAt: Pt };
}

export interface BuiltSurface {
  preset: SurfacePreset;
  document: Record<string, unknown>;
  images: Map<string, FillImage>;
  skin: BuiltMesh;
  garments: BuiltMesh[];
  /**
   * Arm layer (preset `assembly.sheets`): detached under-sheets (the torso under the arm), trunk
   * weights only; empty for a one-sheet body.
   */
  sheets: BuiltMesh[];
  /** Contour faders (preset contour `fade`): slot, driver bone and alpha keys (written as a driven set by buildRig). */
  fades: { slot: string; name: string; bone: string; keys: { at: number; alpha: number }[]; alphaOr?: string }[];
  /** Vertex indices of the skin shared by triangles of more than one group. */
  partition: number[];
  /** Bind world rotation (degrees) and pivot per bone. */
  bones: Map<string, { at: Pt; rotation: number; parent?: string }>;
  chain: ChainFrame;
  /** Owner slot -> contour names. */
  contours: { owner: string; name: string; mesh: "skin" | string; points: number[]; width: number }[];
  /** Notch apexes (topology.apexes) on the skin hull. */
  apexes: BuiltApex[];
  /** Skin rows as constraint polylines (vertex indices), for tests and the source view. */
  rows: { s: number; ids: number[]; fan: boolean }[];
  /** Per skin vertex: its support region (patch names joined by '+', a core, a fixed region or 'apex') and allowed bone indices; null when unconstrained. */
  support: ({ region: string; allowed: number[] } | null)[];
  /** Joint patches as resolved: boundary-chain extent (and the width fraction chosen by the feasibility search), chain s where the ramp ends. */
  patches: { name: string; side: "inner" | "outer" | "both"; joint: string; extent: number; width?: number; ratio?: number; sEnd: number; feasible: boolean; minBlendRatio: number; chain: number[] }[];
  /** Vertices in both a root-joint side patch and a distal hinge band (allowed: the band's mask applies there). */
  patchOverlaps: number;
  /** Fixed region name -> skin vertices in it. */
  fixedVertices: Record<string, number[]>;
  /** Anchored notch apexes: skin vertex and the posed displacement it may have (0: exact). */
  anchors: BuiltAnchor[];
  /** Contour junctions: hull vertex of the named mesh ('skin' or a garment name). */
  junctions: { name: string; mesh: string; index: number; at: Pt; radius: number }[];
  /** Draw group index of every skin triangle (in the stored triangle order), into `groupSlots`. */
  triangleGroups: number[];
  /** Skin draw group slots (preset order). */
  groupSlots: string[];
  /** Slot draw order, derived: root groups just below their garment, overlays right after their `above` group. */
  drawOrder: string[];
  /** Garment overlays: the overlay slot, its garment (name and body slot), triangle range in the garment mesh, owned contours and bind band polygons. */
  overlays: { name: string; garment: string; slot: string; above: string; contours: string[]; fillBand: number; clearance: number; half: number; bands: Pt[][]; range: [number, number] }[];
  /** Root groups (`under`): drawn just below the garment, hidden under its hull by >= clearance at every pose. */
  roots: { slot: string; garment: string; clearance: number }[];
  /** Runtime reduction applied: kept dense skin vertices and kept garment outline samples. */
  reduced?: SurfaceReduction;
}

/**
 * Runtime reduction (sparse.ts): the dense skin vertices to keep (indices into the
 * unreduced build's skin points; hull vertices, row ends and apexes the rows need must be kept)
 * and, per garment name, the outline samples to keep (indices into its sampled path).
 */
export interface SurfaceReduction {
  skin?: readonly number[];
  garments?: Record<string, readonly number[]>;
}

const WHITE = "ffffffff";

/** Triangle area floor (review): no triangle may shrink below this share of its bind area. */
export const AREA_FLOOR = 0.2;
/** Conform garments: outline features within this many game px of a skin vertex merge onto it. */
export const CONFORM_MERGE_GAME_PX = 0.05;
/** Overlay band lines (interior fill-band boundaries, never drawn as a stroke) merge into skin features within this (game px). */
export const BAND_MERGE_GAME_PX = 0.15;

const signedTriangleArea = (a: Pt, b: Pt, c: Pt) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

// ---------------------------------------------------------------------------------------------
// Bones
// ---------------------------------------------------------------------------------------------

/**
 * Bind transforms of the preset's bones, derived with the runtime's inheritance semantics: `onlyTranslation` and `noRotation` take their position from the parent
 * but not its rotation, so their local rotation is their world rotation at bind (bind scales are 1;
 * `noScale` and `noScaleOrReflection` inherit rotation exactly like `normal` there).
 */
export function boneTable(preset: SurfacePreset) {
  const table = new Map<string, { at: Pt; rotation: number; parent?: string }>();
  const raw: Record<string, unknown>[] = [];
  for (const b of preset.bones) {
    const at: Pt = b.at ?? [preset.canvas.originX, preset.canvas.originY];
    const rotation = b.toward ? deg(Math.atan2(b.toward[1] - at[1], b.toward[0] - at[0])) : (b.rotation ?? 0);
    const length = b.toward ? dist(at, b.toward) : (b.length ?? 0);
    const parent = b.parent ? table.get(b.parent) : undefined;
    if (b.parent && !parent) throw new Error(`bone '${b.name}': parent '${b.parent}' must come first`);
    const base = parent ?? { at: [preset.canvas.originX, preset.canvas.originY] as Pt, rotation: 0 };
    const local = rotateAbout([at[0] - base.at[0], at[1] - base.at[1]], [0, 0], -base.rotation);
    const ownRotation = b.parent !== undefined && (b.inherit === "onlyTranslation" || b.inherit === "noRotation");
    let localRotation = ownRotation ? rotation : rotation - base.rotation;
    while (localRotation > 180) localRotation -= 360;
    while (localRotation <= -180) localRotation += 360;
    const entry: Record<string, unknown> = { name: b.name };
    if (b.parent) entry.parent = b.parent;
    if (Math.abs(local[0]) > 1e-9) entry.x = round(local[0]);
    if (Math.abs(local[1]) > 1e-9) entry.y = round(local[1]);
    if (Math.abs(localRotation) > 1e-9) entry.rotation = round(localRotation);
    if (length > 0) entry.length = round(length);
    if (b.limits) entry.limits = { min: b.limits[0], max: b.limits[1] };
    if (b.inherit && b.inherit !== "normal") entry.inherit = b.inherit;
    raw.push(entry);
    // Keep the rounded values so bind matrices match what the runtime will compute.
    const lx = (entry.x as number | undefined) ?? 0;
    const ly = (entry.y as number | undefined) ?? 0;
    const lr = (entry.rotation as number | undefined) ?? 0;
    const world = rotateAbout([lx, ly], [0, 0], base.rotation);
    table.set(b.name, { at: [base.at[0] + world[0], base.at[1] + world[1]], rotation: ownRotation ? lr : base.rotation + lr, ...(b.parent ? { parent: b.parent } : {}) });
  }
  return { table, raw };
}

const round = (x: number, digits = 4) => Number(x.toFixed(digits));

/**
 * Plan: the preset's bone tree. Every branch hangs from an earlier skeleton bone and lists its
 * bones parent to child; no bone sits in two branches or in the limb chain. Returns the branch bones.
 */
export function checkBranches(preset: SurfacePreset): string[] {
  const parentOf = new Map(preset.bones.map((b) => [b.name, b.parent]));
  const seen = new Set<string>(preset.chain.bones);
  const out: string[] = [];
  for (const branch of preset.chain.branches ?? []) {
    const where = `chain branch '${branch.parent} -> ${branch.bones.join(" > ")}'`;
    if (!parentOf.has(branch.parent)) throw new Error(`${where}: parent '${branch.parent}' is not a bone`);
    let up = branch.parent;
    for (const name of branch.bones) {
      if (!parentOf.has(name)) throw new Error(`${where}: '${name}' is not a bone`);
      if (seen.has(name)) throw new Error(`${where}: '${name}' is already in the limb chain or another branch`);
      if (parentOf.get(name) !== up) throw new Error(`${where}: '${name}' hangs from '${parentOf.get(name) ?? "nothing"}', not '${up}'`);
      seen.add(name);
      out.push(name);
      up = name;
    }
  }
  return out;
}

/** Plan: the share of a vertex's `from` weight a bend zone moves to `to` (0..1). */
export function bendShare(bend: Bend, p: Pt): number {
  const ax = bend.b[0] - bend.a[0];
  const ay = bend.b[1] - bend.a[1];
  const len = Math.hypot(ax, ay);
  const along = ((p[0] - bend.a[0]) * ax + (p[1] - bend.a[1]) * ay) / (len * len);
  let t = smoothstep(0, 1, along);
  if (t > 0 && bend.r1 !== undefined) {
    const across = Math.abs((p[0] - bend.a[0]) * ay - (p[1] - bend.a[1]) * ax) / len;
    t *= 1 - smoothstep(bend.r0 ?? 0, bend.r1, across);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Mesh construction
// ---------------------------------------------------------------------------------------------

function inBox(sv: { s: number; v: number }, box: Box): boolean {
  return (box.sMin === undefined || sv.s >= box.sMin) && (box.sMax === undefined || sv.s <= box.sMax) && (box.vMin === undefined || sv.v >= box.vMin) && (box.vMax === undefined || sv.v <= box.vMax);
}

/** Rows: joint bands plus rigid-core fill, plus authored extras. */
export function topologyRows(t: SurfacePreset["skin"]["topology"]): number[] {
  // Authored rows (partitions, contour junctions) win over generated rows that crowd them.
  const extra = t.extraRows ?? [];
  const generated: number[] = [t.from, t.to];
  for (const j of t.joints) for (let k = 0; k < j.rows; k++) generated.push(j.s - j.band + (2 * j.band * k) / Math.max(1, j.rows - 1));
  const rows = [...extra, ...generated.filter((r) => !extra.some((e) => Math.abs(e - r) < t.minRowGap))];
  rows.sort((a, b) => a - b);
  const filled: number[] = [];
  for (const r of rows) {
    const last = filled[filled.length - 1];
    if (last !== undefined && r - last < t.minRowGap) continue;
    if (last !== undefined && r - last > t.core) {
      const n = Math.ceil((r - last) / t.core);
      for (let k = 1; k < n; k++) filled.push(last + ((r - last) * k) / n);
    }
    filled.push(r);
  }
  return filled.filter((r) => r >= t.from && r <= t.to);
}

export function triangulate(points: Pt[], edges: [number, number][], hull: number) {
  // Inside/outside by the hull polygon, not cdt2d's constraint parity: interior constraint rows that
  // close a loop with the hull would otherwise flip a whole strip to "exterior" (a hole in the skin).
  const outline = points.slice(0, hull);
  const cells = cdt2d(points, edges, { exterior: true });
  const tris: number[] = [];
  for (const [a, b, c] of cells) {
    const pa = points[a] as Pt;
    const pb = points[b] as Pt;
    const pc = points[c] as Pt;
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    if (Math.abs(area) < 1e-6) continue;
    if (!pointInPolygon([(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3], outline)) continue;
    tris.push(a, b, c);
  }
  if (tris.length === 0) throw new Error(`triangulation produced no triangles (${points.length} points, hull ${hull})`);
  return tris;
}

function lattice(poly: Pt[], existing: Pt[], spacing: number, minDistance: number): Pt[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const out: Pt[] = [];
  const rowH = (spacing * Math.sqrt(3)) / 2;
  let row = 0;
  for (let y = minY + rowH / 2; y < maxY; y += rowH, row++) {
    for (let x = minX + (row % 2 ? spacing / 2 : 0); x < maxX; x += spacing) {
      const p: Pt = [x, y];
      if (!pointInPolygon(p, poly) || distanceToPolyline(p, poly, true) < minDistance * 0.8) continue;
      if (existing.some((q) => dist(p, q) < minDistance) || out.some((q) => dist(p, q) < minDistance)) continue;
      out.push(p);
    }
  }
  return out;
}

interface ApexSpec {
  raw: number;
  at: Pt;
  s: number;
  sign: 1 | -1;
  reach: number;
}

interface Cut {
  s: number;
  v0: number;
  v1: number;
  ends: [boolean, boolean];
  /** Fan row: the raw hull index of the apex it ends at, and its outer end. */
  fan?: { apex: number; outer: Pt; outerOnHull: boolean; outerSide: number };
}

/**
 * Inserts row/hull crossings into the hull; returns the hull, the cuts and the crossing index per
 * row end. Rows that reach the body side of a notch apex become fan rows ending at the apex; rows
 * past the notch keep `minRowGap` between their inner ends measured along the hull.
 */
function cutRows(hull: Pt[], chain: ChainFrame, rows: number[], topo: SurfacePreset["skin"]["topology"], apexes: ApexSpec[]) {
  const { halfWidth, columns, minRowGap } = topo;
  const inserts: { edge: number; t: number; p: Pt; row: number; side: number }[] = [];
  const cuts: Cut[] = [];
  const arc = [0];
  for (let i = 1; i <= hull.length; i++) arc.push((arc[i - 1] as number) + dist(hull[i - 1] as Pt, hull[i % hull.length] as Pt));
  const total = arc[hull.length] as number;
  const arcAt = (edge: number, t: number) => (arc[edge] as number) + t * dist(hull[edge] as Pt, hull[(edge + 1) % hull.length] as Pt);
  const arcGap = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, total - d);
  };
  const lastInner = apexes.map((a) => arc[a.raw] as number);
  const segmentInside = (a: Pt, b: Pt, skip: Set<number>) => {
    for (let k = 1; k < 20; k++) if (!pointInPolygon([a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20], hull)) return false;
    for (let i = 0; i < hull.length; i++) {
      if (skip.has(i)) continue;
      const x = segmentCross(a, b, hull[i] as Pt, hull[(i + 1) % hull.length] as Pt);
      if (x && x.t > 1e-6 && x.t < 1 - 1e-6) return false;
    }
    return true;
  };
  for (let r = 0; r < rows.length; r++) {
    const s = rows[r] as number;
    const a = chain.point(s, -halfWidth - 30);
    const b = chain.point(s, halfWidth + 30);
    const span = 2 * halfWidth + 60;
    const hits: { v: number; edge: number; t: number; p: Pt }[] = [];
    for (let i = 0; i < hull.length; i++) {
      const c = hull[i] as Pt;
      const d = hull[(i + 1) % hull.length] as Pt;
      const x = segmentCross(a, b, c, d);
      if (x) hits.push({ v: -halfWidth - 30 + x.t * span, edge: i, t: x.u, p: [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t] });
    }
    hits.sort((p, q) => p.v - q.v);
    // The inside interval containing v = 0 (inside if the midpoint is in the polygon).
    const bounds = [-Infinity, ...hits.map((h) => h.v), Infinity];
    let lo = -halfWidth;
    let hi = halfWidth;
    let loHit: (typeof hits)[number] | null = null;
    let hiHit: (typeof hits)[number] | null = null;
    for (let k = 0; k + 1 < bounds.length; k++) {
      if ((bounds[k] as number) <= 0 && (bounds[k + 1] as number) >= 0) {
        if (k > 0 && (bounds[k] as number) >= -halfWidth - 1e-6) {
          lo = bounds[k] as number;
          loHit = hits[k - 1] ?? null;
        }
        if (k + 1 < bounds.length - 1 && (bounds[k + 1] as number) <= halfWidth + 1e-6) {
          hi = bounds[k + 1] as number;
          hiHit = hits[k] ?? null;
        }
      }
    }
    if (!pointInPolygon(chain.point(s, 0), hull)) continue;
    // Apex fan: rows up to the notch (or whose inner end would crowd the apex) end at the apex.
    let fan: ApexSpec | null = null;
    let drop = false;
    apexes.forEach((apex, k) => {
      if (fan || drop) return;
      const inner = apex.sign < 0 ? loHit : hiHit;
      const innerArc = inner ? arcAt(inner.edge, inner.t) : null;
      if (s <= apex.s || (innerArc !== null && arcGap(innerArc, arc[apex.raw] as number) < minRowGap)) {
        fan = apex;
        return;
      }
      if (innerArc !== null && arcGap(innerArc, lastInner[k] as number) < minRowGap) drop = true;
      else if (innerArc !== null && s < apex.s + apex.reach) lastInner[k] = innerArc;
    });
    if (drop) continue;
    if (fan) {
      const apex = fan as ApexSpec;
      const outerHit = apex.sign < 0 ? hiHit : loHit;
      const outer: Pt = outerHit ? outerHit.p : chain.point(s, -apex.sign * halfWidth);
      const skip = new Set<number>([apex.raw, (apex.raw - 1 + hull.length) % hull.length]);
      if (outerHit) skip.add(outerHit.edge);
      if (!segmentInside(hull[apex.raw] as Pt, outer, skip)) continue;
      if (outerHit) inserts.push({ edge: outerHit.edge, t: outerHit.t, p: outerHit.p, row: r, side: -apex.sign });
      cuts.push({ s, v0: lo, v1: hi, ends: [loHit !== null, hiHit !== null], fan: { apex: apex.raw, outer, outerOnHull: outerHit !== null, outerSide: -apex.sign } });
      continue;
    }
    if (loHit) inserts.push({ edge: loHit.edge, t: loHit.t, p: loHit.p, row: r, side: -1 });
    if (hiHit) inserts.push({ edge: hiHit.edge, t: hiHit.t, p: hiHit.p, row: r, side: 1 });
    cuts.push({ s, v0: lo, v1: hi, ends: [loHit !== null, hiHit !== null] });
  }
  // Fan rows keep a minimum angle between them at the apex (nearly coincident fan lines make
  // slivers that fold): from the notch outwards, a fan row closer than `fanAngle` to the last kept is dropped.
  const dropped = new Set<number>();
  for (const apex of apexes) {
    const fans = cuts.filter((c) => c.fan?.apex === apex.raw).sort((x, y) => y.s - x.s);
    let last: number | null = null;
    for (const c of fans) {
      const o = (c.fan as NonNullable<Cut["fan"]>).outer;
      const angle = deg(Math.atan2(o[1] - apex.at[1], o[0] - apex.at[0]));
      if (last !== null && Math.abs(((angle - last + 540) % 360) - 180) < (topo.fanAngle ?? 12)) {
        dropped.add(rows.indexOf(c.s));
        continue;
      }
      last = angle;
    }
  }
  if (dropped.size) {
    for (let k = cuts.length - 1; k >= 0; k--) if (dropped.has(rows.indexOf((cuts[k] as Cut).s))) cuts.splice(k, 1);
    for (let k = inserts.length - 1; k >= 0; k--) if (dropped.has((inserts[k] as { row: number }).row)) inserts.splice(k, 1);
  }
  // Rebuild the hull with inserts, dropping hull points too close to an insert (never an apex).
  inserts.sort((p, q) => p.edge - q.edge || p.t - q.t);
  const protect = new Set(apexes.map((a) => a.raw));
  const out: Pt[] = [];
  const endIndex = new Map<string, number>();
  const rawIndex = new Map<number, number>();
  let k = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i] as Pt;
    if (protect.has(i) || !inserts.some((ins) => dist(ins.p, p) < columns * 0.35)) {
      rawIndex.set(i, out.length);
      out.push(p);
    }
    while (k < inserts.length && (inserts[k] as { edge: number }).edge === i) {
      const ins = inserts[k] as (typeof inserts)[number];
      endIndex.set(`${ins.row}:${ins.side}`, out.length);
      out.push(ins.p);
      k++;
    }
  }
  return { hull: out, cuts, endIndex, rawIndex };
}

/** Barycentric weights of p in triangle (a, b, c), unclamped. */
function barycentric(p: Pt, a: Pt, b: Pt, c: Pt): [number, number, number] | null {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-12) return null;
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  return [wa, wb, 1 - wa - wb];
}

/**
 * Embeds a point in a mesh at bind: the vertex it sits on, else the triangle containing it, else
 * (within `margin` of the mesh) the nearest triangle's affine extension. Null when off the mesh.
 */
export function embedInMesh(points: readonly Pt[], triangles: readonly number[], p: Pt, margin: number): { point: EmbedPoint; weights: [number, number, number]; tri: [number, number, number] } | null {
  for (let i = 0; i < points.length; i++) if (dist(points[i] as Pt, p) < 1e-6) return { point: i, weights: [1, 0, 0], tri: [i, i, i] };
  let best: { tri: [number, number, number]; w: [number, number, number]; d: number } | null = null;
  for (let t = 0; t < triangles.length; t += 3) {
    const tri: [number, number, number] = [triangles[t] as number, triangles[t + 1] as number, triangles[t + 2] as number];
    const w = barycentric(p, points[tri[0]] as Pt, points[tri[1]] as Pt, points[tri[2]] as Pt);
    if (!w) continue;
    if (w[0] >= -1e-9 && w[1] >= -1e-9 && w[2] >= -1e-9) {
      best = { tri, w, d: 0 };
      break;
    }
    const d = Math.min(distanceToSegmentPt(p, points[tri[0]] as Pt, points[tri[1]] as Pt), distanceToSegmentPt(p, points[tri[1]] as Pt, points[tri[2]] as Pt), distanceToSegmentPt(p, points[tri[2]] as Pt, points[tri[0]] as Pt));
    if (!best || d < best.d) best = { tri, w, d };
  }
  if (!best || best.d > margin || best.w.some((x) => x < -1 || x > 2)) return null;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const wa = r6(best.w[0]);
  const wb = r6(best.w[1]);
  return { point: [best.tri[0], best.tri[1], best.tri[2], wa, wb], weights: [wa, wb, 1 - wa - wb], tri: best.tri };
}

function distanceToSegmentPt(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function laplace(n: number, triangles: number[], fixed: (number | null)[], iterations: number): number[] {
  const nbr: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    (nbr[a] as Set<number>).add(b).add(c);
    (nbr[b] as Set<number>).add(a).add(c);
    (nbr[c] as Set<number>).add(a).add(b);
  }
  const lists = nbr.map((s) => [...s]);
  const x = fixed.map((f) => f ?? 0.5);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      if (fixed[i] !== null) continue;
      const l = lists[i] as number[];
      if (l.length === 0) continue;
      let sum = 0;
      for (const j of l) sum += x[j] as number;
      x[i] = sum / l.length;
    }
  }
  return x.map(clamp01);
}

/** For every vertex, the nearest `sources` vertex along the mesh edges (Dijkstra; -1 when unreachable). */
export function inheritAlongMesh(points: readonly Pt[], triangles: readonly number[], sources: ReadonlySet<number>): number[] {
  const nbr: Set<number>[] = points.map(() => new Set<number>());
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k] as number;
      const b = triangles[t + ((k + 1) % 3)] as number;
      (nbr[a] as Set<number>).add(b);
      (nbr[b] as Set<number>).add(a);
    }
  }
  const d = points.map(() => Infinity);
  const from = points.map(() => -1);
  const open = new Set<number>();
  for (const s of sources) {
    d[s] = 0;
    from[s] = s;
    open.add(s);
  }
  while (open.size) {
    let u = -1;
    for (const v of open) if (u < 0 || (d[v] as number) < (d[u] as number)) u = v;
    open.delete(u);
    for (const v of nbr[u] as Set<number>) {
      const nd = (d[u] as number) + dist(points[u] as Pt, points[v] as Pt);
      if (nd < (d[v] as number)) {
        d[v] = nd;
        from[v] = from[u] as number;
        open.add(v);
      }
    }
  }
  return from;
}

/**
 * Clips a triangulation to an outline (garment `conform`): the outline with every crossing of a
 * mesh edge (and every mesh vertex on it) inserted is the new hull, mesh vertices strictly inside
 * are kept, and the mesh edges inside become constraints, so every output triangle lies inside one
 * input triangle (or outside the input mesh, in the strip between its hull and the outline).
 * `lines`: interior constraint polylines (a garment overlay's band edge), split wherever they cross
 * a mesh edge, the outline or each other, so triangles never straddle them and still lie inside
 * one input triangle.
 */
export function conformToSkin(outline: readonly Pt[], meshPoints: readonly Pt[], meshTriangles: readonly number[], eps = 0.05, lines: readonly (readonly Pt[])[] = []): { points: Pt[]; hull: number; triangles: number[] } {
  const n = outline.length;
  const edgeMap = new Map<string, [number, number]>();
  for (let t = 0; t < meshTriangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = meshTriangles[t + k] as number;
      const b = meshTriangles[t + ((k + 1) % 3)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, a < b ? [a, b] : [b, a]);
    }
  }
  const edges = [...edgeMap.values()];
  // Outline splits: crossings with mesh edges and mesh vertices lying on the outline.
  const splits: { t: number; p: Pt; vertex?: number }[][] = outline.map(() => []);
  const edgeSplits = new Map<string, { t: number; p: Pt }[]>();
  const addEdgeSplit = (u: number, v: number, t: number, p: Pt) => {
    const key = `${u},${v}`;
    (edgeSplits.get(key) ?? (edgeSplits.set(key, []).get(key) as { t: number; p: Pt }[])).push({ t, p });
  };
  const onOutline = new Map<number, Pt>();
  for (let i = 0; i < n; i++) {
    const a = outline[i] as Pt;
    const b = outline[(i + 1) % n] as Pt;
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    for (const [u, v] of edges) {
      const x = segmentCross(a, b, meshPoints[u] as Pt, meshPoints[v] as Pt);
      if (!x || x.u <= 1e-9 || x.u >= 1 - 1e-9 || x.t <= 1e-9 || x.t >= 1 - 1e-9) continue;
      const p: Pt = [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t];
      if (dist(p, meshPoints[u] as Pt) < eps || dist(p, meshPoints[v] as Pt) < eps) continue;
      (splits[i] as { t: number; p: Pt }[]).push({ t: x.t, p });
      addEdgeSplit(u, v, x.u, p);
    }
    meshPoints.forEach((q, v) => {
      if (len2 === 0 || distanceToSegmentPt(q, a, b) >= eps) return;
      const t = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / len2;
      if (dist(q, a) < eps) onOutline.set(v, a);
      else if (dist(q, b) < eps) onOutline.set(v, b);
      else if (!onOutline.has(v)) {
        onOutline.set(v, q);
        (splits[i] as { t: number; p: Pt; vertex?: number }[]).push({ t, p: q, vertex: v });
      }
    });
  }
  // An outline vertex on a mesh edge splits that edge.
  for (const a of outline) {
    for (const [u, v] of edges) {
      const pu = meshPoints[u] as Pt;
      const pv = meshPoints[v] as Pt;
      if (dist(a, pu) < eps || dist(a, pv) < eps || distanceToSegmentPt(a, pu, pv) >= eps) continue;
      const len2 = (pv[0] - pu[0]) ** 2 + (pv[1] - pu[1]) ** 2;
      addEdgeSplit(u, v, ((a[0] - pu[0]) * (pv[0] - pu[0]) + (a[1] - pu[1]) * (pv[1] - pu[1])) / len2, a);
    }
  }
  // Interior constraint lines: split at mesh edge crossings, mesh vertices on them, outline
  // crossings (inserted into the hull) and crossings with each other.
  const segs: [Pt, Pt][] = lines.flatMap((l) => l.slice(1).map((b, k) => [l[k] as Pt, b] as [Pt, Pt]));
  const segSplits: { t: number; p: Pt }[][] = segs.map(() => []);
  const open = (x: number) => x > 1e-9 && x < 1 - 1e-9;
  segs.forEach(([a, b], si) => {
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (len2 === 0) return;
    for (const [u, v] of edges) {
      const pu = meshPoints[u] as Pt;
      const pv = meshPoints[v] as Pt;
      const x = segmentCross(a, b, pu, pv);
      if (!x || !open(x.t) || !open(x.u)) continue;
      const p: Pt = [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t];
      if (dist(p, pu) < eps || dist(p, pv) < eps) continue;
      (segSplits[si] as { t: number; p: Pt }[]).push({ t: x.t, p });
      addEdgeSplit(u, v, x.u, p);
    }
    meshPoints.forEach((q) => {
      if (distanceToSegmentPt(q, a, b) >= eps || dist(q, a) < eps || dist(q, b) < eps) return;
      (segSplits[si] as { t: number; p: Pt }[]).push({ t: ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / len2, p: q });
    });
    for (let i = 0; i < n; i++) {
      const c = outline[i] as Pt;
      const d = outline[(i + 1) % n] as Pt;
      const x = segmentCross(a, b, c, d);
      if (!x || !open(x.t) || !open(x.u)) continue;
      const p: Pt = [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t];
      if (dist(p, a) < eps || dist(p, b) < eps) continue;
      (segSplits[si] as { t: number; p: Pt }[]).push({ t: x.t, p });
      (splits[i] as { t: number; p: Pt }[]).push({ t: x.u, p });
    }
    for (let sj = si + 1; sj < segs.length; sj++) {
      const [c, d] = segs[sj] as [Pt, Pt];
      const x = segmentCross(a, b, c, d);
      if (!x || !open(x.t) || !open(x.u)) continue;
      const p: Pt = [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t];
      (segSplits[si] as { t: number; p: Pt }[]).push({ t: x.t, p });
      (segSplits[sj] as { t: number; p: Pt }[]).push({ t: x.u, p });
    }
  });
  const points: Pt[] = [];
  const indexOf = (p: Pt): number => {
    for (let i = 0; i < points.length; i++) if (dist(points[i] as Pt, p) < eps) return i;
    points.push(p);
    return points.length - 1;
  };
  for (let i = 0; i < n; i++) {
    indexOf(outline[i] as Pt);
    for (const sp of (splits[i] as { t: number; p: Pt }[]).sort((x, y) => x.t - y.t)) indexOf(sp.p);
  }
  const hull = points.length;
  const local = new Map<number, number>();
  meshPoints.forEach((q, v) => {
    const on = onOutline.get(v);
    if (on) local.set(v, indexOf(on));
    else if (pointInPolygon(q, outline)) local.set(v, indexOf(q));
  });
  const constraints: [number, number][] = Array.from({ length: hull }, (_, i) => [i, (i + 1) % hull]);
  for (const [u, v] of edges) {
    const pu = meshPoints[u] as Pt;
    const pv = meshPoints[v] as Pt;
    const cuts = [{ t: 0, p: pu, id: local.get(u) }, ...(edgeSplits.get(`${u},${v}`) ?? []).map((x) => ({ ...x, id: indexOf(x.p) })), { t: 1, p: pv, id: local.get(v) }].sort((x, y) => x.t - y.t);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const c0 = cuts[k] as { p: Pt; id?: number };
      const c1 = cuts[k + 1] as { p: Pt; id?: number };
      if (c0.id === undefined || c1.id === undefined || c0.id === c1.id) continue;
      const mid: Pt = [(c0.p[0] + c1.p[0]) / 2, (c0.p[1] + c1.p[1]) / 2];
      if (!pointInPolygon(mid, outline) || distanceToPolyline(mid, outline, true) < eps) continue;
      constraints.push([c0.id, c1.id]);
    }
  }
  segs.forEach(([a, b], si) => {
    const cuts = [{ t: 0, p: a }, ...(segSplits[si] as { t: number; p: Pt }[]), { t: 1, p: b }].sort((x, y) => x.t - y.t);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const p0 = (cuts[k] as { p: Pt }).p;
      const p1 = (cuts[k + 1] as { p: Pt }).p;
      const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      if (dist(p0, p1) < eps || !pointInPolygon(mid, outline) || distanceToPolyline(mid, outline, true) < eps) continue;
      const i0 = indexOf(p0);
      const i1 = indexOf(p1);
      if (i0 !== i1) constraints.push([i0, i1]);
    }
  });
  const cells = cdt2d(points, constraints, { exterior: true });
  const triangles: number[] = [];
  for (const [a, b, c] of cells) {
    const pa = points[a] as Pt;
    const pb = points[b] as Pt;
    const pc = points[c] as Pt;
    if (Math.abs(signedTriangleArea(pa, pb, pc)) < 1e-6) continue;
    if (!pointInPolygon([(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3], outline)) continue;
    triangles.push(a, b, c);
  }
  if (triangles.length === 0) throw new Error("conform: the outline covers no part of the mesh");
  return { points, hull, triangles };
}

// ---------------------------------------------------------------------------------------------
// Garment overlays (3d-1 fix review, the sandwich)
// ---------------------------------------------------------------------------------------------

/** Offset (miter, capped at 2x) of a polyline on a closed outline; positive = away from the outline's interior. */
export function offsetEdge(line: readonly Pt[], outline: readonly Pt[], offset: number | ((k: number) => number)): Pt[] {
  const segN = line.slice(1).map((b, k) => {
    const a = line[k] as Pt;
    const len = dist(a, b) || 1;
    let n: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    if (pointInPolygon([(a[0] + b[0]) / 2 + n[0] * 0.25, (a[1] + b[1]) / 2 + n[1] * 0.25], outline)) n = [-n[0], -n[1]];
    return n;
  });
  return line.map((p, k) => {
    const n0 = segN[Math.max(0, k - 1)] as Pt;
    const n1 = segN[Math.min(segN.length - 1, k)] as Pt;
    const sum: Pt = [n0[0] + n1[0], n0[1] + n1[1]];
    const l = Math.hypot(sum[0], sum[1]);
    const n: Pt = l > 1e-9 ? [sum[0] / l, sum[1] / l] : n1;
    const miter = Math.min(2, 1 / Math.max(0.5, n[0] * n1[0] + n[1] * n1[1]));
    const d = typeof offset === "number" ? offset : offset(k);
    return [p[0] + n[0] * d * miter, p[1] + n[1] * d * miter];
  });
}

/** The span of a closed outline between the vertices nearest `from` and `to` (walking backwards when `reverse`). */
export function outlineSpan(outline: readonly Pt[], from: Pt, to: Pt, reverse = false): Pt[] {
  const nearest = (q: Pt) => outline.reduce((b, p, i) => (dist(p, q) < dist(outline[b] as Pt, q) ? i : b), 0);
  const a = nearest(from);
  const b = nearest(to);
  const step = reverse ? -1 : 1;
  const line: Pt[] = [outline[a] as Pt];
  for (let i = a; i !== b; ) {
    i = (((i + step) % outline.length) + outline.length) % outline.length;
    line.push(outline[i] as Pt);
  }
  return line;
}

// ---------------------------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------------------------

function paint(points: Pt[], base: string, fills: readonly Fill[], chain: ChainFrame, pad: number): { image: FillImage; origin: Pt } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const x0 = Math.floor(minX - pad);
  const y0 = Math.floor(minY - pad);
  const width = Math.ceil(maxX + pad) - x0;
  const height = Math.ceil(maxY + pad) - y0;
  const image: FillImage = { width, height, data: new Uint8Array(width * height * 4) };
  // The base colour fills the whole image: edges sample opaque texels (no fringe); contours cover the mesh edge.
  fillPolygon(image, [[x0 - 1, y0 - 1], [x0 + width + 1, y0 - 1], [x0 + width + 1, y0 + height + 1], [x0 - 1, y0 + height + 1]], base, x0, y0);
  for (const f of fills) fillPolygon(image, samplePath(f.polygon, chain, 1.5, true), f.color, x0, y0);
  return { image, origin: [x0, y0] };
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

export function buildSurface(preset: SurfacePreset, reduce?: SurfaceReduction): BuiltSurface {
  const { table: bones, raw: rawBones } = boneTable(preset);
  const chainBones = preset.chain.bones;
  const branchBones = checkBranches(preset);
  const pivots: Pt[] = chainBones.map((b) => (bones.get(b) ?? fail(`chain bone '${b}' missing`)).at);
  const last = preset.bones.find((b) => b.name === chainBones[chainBones.length - 1]);
  if (!last?.toward) throw new Error("the chain's last bone needs `toward` (its end point)");
  pivots.push(last.toward);
  const topo = preset.skin.topology;
  const blends = topo.joints.map((j) => j.band);
  const chain = new ChainFrame(pivots, blends, topo.frameFrom ?? -200, topo.frameTo ?? 600);

  // --- skin hull and rows ---------------------------------------------------------------------
  const skin = preset.skin;
  const rawHull = samplePath(skin.silhouette, chain, skin.spacing, true);
  const rows = topologyRows(topo);
  const apexSpecs: ApexSpec[] = (topo.apexes ?? []).map((a) => {
    let raw = 0;
    for (let i = 1; i < rawHull.length; i++) if (dist(rawHull[i] as Pt, a.at) < dist(rawHull[raw] as Pt, a.at)) raw = i;
    if (dist(rawHull[raw] as Pt, a.at) > 0.5) throw new Error(`apex (${a.at.join(", ")}) is not a silhouette point (mark it { at, corner: true })`);
    return { raw, at: rawHull[raw] as Pt, s: chain.coords(a.at).s, sign: a.side === "+" ? 1 : -1, reach: a.reach };
  });
  const { hull, cuts, endIndex, rawIndex } = cutRows(rawHull, chain, rows, topo, apexSpecs);
  const points: Pt[] = [...hull];
  const edges: [number, number][] = hull.map((_, i) => [i, (i + 1) % hull.length]);
  const rowEnd = new Map<string, number>();
  const rowLines: BuiltSurface["rows"] = [];
  const fanRows = new Map<number, number[]>();
  cuts.forEach((cut) => {
    const r = rows.indexOf(cut.s);
    const ids: number[] = [];
    if (cut.fan) {
      const apexIndex = rawIndex.get(cut.fan.apex) as number;
      const outerIndex = cut.fan.outerOnHull ? endIndex.get(`${r}:${cut.fan.outerSide}`) : undefined;
      const a = points[apexIndex] as Pt;
      const b = outerIndex !== undefined ? (points[outerIndex] as Pt) : cut.fan.outer;
      const n = Math.max(1, Math.round(dist(a, b) / topo.columns));
      ids.push(apexIndex);
      for (let k = 1; k <= n; k++) {
        if (k === n && outerIndex !== undefined) break;
        const p: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        if (dist(p, a) < topo.columns || distanceToPolyline(p, hull, true) < topo.columns * 0.3) continue;
        ids.push(points.length);
        points.push(p);
      }
      if (outerIndex !== undefined) ids.push(outerIndex);
      const sign = cut.fan.outerSide > 0 ? -1 : 1;
      rowEnd.set(`${round(cut.s, 3)}:${sign < 0 ? "-" : "+"}`, apexIndex);
      if (outerIndex !== undefined) rowEnd.set(`${round(cut.s, 3)}:${sign < 0 ? "+" : "-"}`, outerIndex);
      (fanRows.get(apexIndex) ?? fanRows.set(apexIndex, []).get(apexIndex) as number[]).push(cut.s);
    } else {
      const lo = cut.ends[0] ? endIndex.get(`${r}:-1`) : undefined;
      const hi = cut.ends[1] ? endIndex.get(`${r}:1`) : undefined;
      // Candidate polyline first: a row that would cross an earlier row (a tight bend) is dropped.
      const cand: (number | Pt)[] = [];
      if (lo !== undefined) cand.push(lo);
      const n = Math.max(1, Math.round((cut.v1 - cut.v0) / topo.columns));
      for (let k = 0; k <= n; k++) {
        const v = cut.v0 + ((cut.v1 - cut.v0) * k) / n;
        if ((k === 0 && lo !== undefined) || (k === n && hi !== undefined)) continue;
        const p = chain.point(cut.s, v);
        if (!pointInPolygon(p, hull) || distanceToPolyline(p, hull, true) < topo.columns * 0.3) continue;
        cand.push(p);
      }
      if (hi !== undefined) cand.push(hi);
      const at = (c: number | Pt): Pt => (typeof c === "number" ? (points[c] as Pt) : c);
      const crosses = cand.slice(1).some((c, k) =>
        rowLines.some((line) => line.ids.slice(1).some((b, j) => {
          const a = line.ids[j] as number;
          if (a === cand[k] || b === cand[k] || a === c || b === c) return false;
          const x = segmentCross(at(cand[k] as number | Pt), at(c), points[a] as Pt, points[b] as Pt);
          return x !== null && x.t > 1e-6 && x.t < 1 - 1e-6;
        }))
      );
      if (crosses) return;
      for (const c of cand) {
        if (typeof c === "number") ids.push(c);
        else {
          ids.push(points.length);
          points.push(c);
        }
      }
      if (lo !== undefined) rowEnd.set(`${round(cut.s, 3)}:-`, lo);
      if (hi !== undefined) rowEnd.set(`${round(cut.s, 3)}:+`, hi);
    }
    for (let k = 0; k + 1 < ids.length; k++) edges.push([ids[k] as number, ids[k + 1] as number]);
    rowLines.push({ s: cut.s, ids, fan: cut.fan !== undefined });
  });
  const apexes: BuiltApex[] = apexSpecs.map((a) => {
    const index = rawIndex.get(a.raw) as number;
    // The limb's inner silhouette is the hull direction that stays in the chain tube longest.
    const inTube = (dir: number) => {
      let n = 0;
      let d = 0;
      for (let k = 1; k < hull.length && d < a.reach; k++) {
        const i = (((index + k * dir) % hull.length) + hull.length) % hull.length;
        d += dist(points[i] as Pt, points[(((i - dir) % hull.length) + hull.length) % hull.length] as Pt);
        const c = chain.coords(points[i] as Pt);
        if (Math.abs(c.v) <= topo.halfWidth + topo.columns && c.s > a.s) n++;
        else break;
      }
      return n;
    };
    const walk: 1 | -1 = inTube(1) >= inTube(-1) ? 1 : -1;
    const fans = (fanRows.get(index) ?? []).sort((x, y) => x - y);
    return { index, at: a.at, s: a.s, sign: a.sign, reach: a.reach, walk, fanRows: fans };
  });
  const constraintSegments = edges.slice(hull.length).map(([a, b]) => [points[a] as Pt, points[b] as Pt] as [Pt, Pt]);
  const nearConstraint = (p: Pt, d: number) => constraintSegments.some(([a, b]) => distanceToSegmentPt(p, a, b) < d);
  for (const ring of topo.rings ?? []) {
    const c = pivots[ring.joint] as Pt;
    for (const r of ring.radii) {
      for (let a = ring.from; a <= ring.to + 1e-9; a += ring.step) {
        const p: Pt = [c[0] + r * Math.cos(rad(a)), c[1] + r * Math.sin(rad(a))];
        if (!pointInPolygon(p, hull) || distanceToPolyline(p, hull, true) < skin.minDistance * 0.8) continue;
        if (points.some((q) => dist(p, q) < skin.minDistance * 0.8) || nearConstraint(p, skin.minDistance * 0.4)) continue;
        points.push(p);
      }
    }
  }
  points.push(...lattice(hull, points, skin.lattice, skin.minDistance).filter((p) => !nearConstraint(p, skin.minDistance * 0.4)));
  if (reduce?.skin) {
    // Runtime reduction: the same build on a subset of the dense vertices (order kept,
    // so the hull stays first); rows keep their ends, their dropped samples become straight chords.
    const keep = [...new Set(reduce.skin)].sort((a, b) => a - b);
    if (keep.some((v) => v < 0 || v >= points.length)) fail(`runtime reduction: a kept vertex is outside the dense skin (${points.length} vertices)`);
    const index = new Int32Array(points.length).fill(-1);
    keep.forEach((v, i) => (index[v] = i));
    const required = [...apexes.map((a) => a.index), ...rowLines.flatMap((r) => [r.ids[0] as number, r.ids[r.ids.length - 1] as number]), ...rowEnd.values()];
    for (const v of required) if ((index[v] as number) < 0) fail(`runtime reduction drops required vertex ${v} (apex or row end)`);
    const keptHull = keep.filter((v) => v < hull.length).map((v) => hull[v] as Pt);
    const keptPoints = keep.map((v) => points[v] as Pt);
    hull.splice(0, hull.length, ...keptHull);
    points.splice(0, points.length, ...keptPoints);
    for (const r of rowLines) r.ids = r.ids.filter((v) => (index[v] as number) >= 0).map((v) => index[v] as number);
    for (const [k, v] of rowEnd) rowEnd.set(k, index[v] as number);
    for (const a of apexes) a.index = index[a.index] as number;
    edges.splice(0, edges.length, ...hull.map((_, i) => [i, (i + 1) % hull.length] as [number, number]), ...rowLines.flatMap((r) => r.ids.slice(1).map((b, k) => [r.ids[k] as number, b] as [number, number])));
  }
  let triangles = triangulate(points, edges, hull.length);
  const sv = points.map((p) => chain.coords(p));

  // --- draw groups ----------------------------------------------------------------------------
  // Explicit regions (pass 3a): a triangle belongs to the last group whose polygon and
  // chain range contain its centroid; the first group takes the rest.
  const groupOf = (t: number): number => {
    const c: Pt = [0, 0];
    for (let k = 0; k < 3; k++) {
      const p = points[triangles[t * 3 + k] as number] as Pt;
      c[0] += p[0] / 3;
      c[1] += p[1] / 3;
    }
    let g = 0;
    const cs = chain.coords(c).s;
    skin.groups.forEach((group, i) => {
      if (!group.polygon && !group.s) return;
      if (group.polygon && !pointInPolygon(c, group.polygon)) return;
      if (group.s && !(cs >= group.s[0] && cs < group.s[1])) return;
      g = i;
    });
    return g;
  };
  const triCount = triangles.length / 3;
  const owner = Array.from({ length: triCount }, (_, t) => groupOf(t));
  const order = Array.from({ length: triCount }, (_, t) => t).sort((a, b) => (owner[a] as number) - (owner[b] as number) || a - b);
  triangles = order.flatMap((t) => [triangles[t * 3] as number, triangles[t * 3 + 1] as number, triangles[t * 3 + 2] as number]);
  const sortedOwner = order.map((t) => owner[t] as number);
  const groups: Record<string, [number, number][]> = {};
  skin.groups.forEach((group, i) => {
    const first = sortedOwner.indexOf(i);
    if (first < 0) return;
    const end = sortedOwner.lastIndexOf(i) + 1;
    groups[group.slot] = [[first, end]];
  });
  const vertexGroups = points.map(() => new Set<number>());
  sortedOwner.forEach((g, t) => {
    for (let k = 0; k < 3; k++) (vertexGroups[triangles[t * 3 + k] as number] as Set<number>).add(g);
  });
  const partition = vertexGroups.flatMap((s, i) => (s.size > 1 ? [i] : []));

  // --- regions and support masks (pass 3a) ---------------------------------------------
  // Joint patches (inner/outer boundary-chain ramps at the chain root, hinge bands distally), rigid
  // cores and fixed body regions. Their bone lists are hard support masks: applied after every
  // influence is generated, a forbidden influence is exactly zero.
  const H = hull.length;
  const girdle = preset.girdle;
  const meshBones = [preset.base, ...(girdle ? [girdle.bone] : []), ...chainBones];
  // Trunk influences: branch bones named by a bend zone, appended after the limb
  // chain so the limb's influence indices (and its correctives' layout) are unchanged.
  const bendSpecs = skin.regions.bends ?? [];
  for (const bend of bendSpecs) {
    for (const name of [bend.from, bend.to]) {
      if (meshBones.includes(name)) continue;
      if (!branchBones.includes(name)) fail(`bend '${bend.name}': bone '${name}' is neither the base, the girdle nor a chain.branches bone`);
      meshBones.push(name);
    }
    if (bend.from === bend.to) fail(`bend '${bend.name}': from and to are the same bone`);
    if (dist(bend.a, bend.b) < 1e-6) fail(`bend '${bend.name}': a and b coincide`);
    if (bend.r0 !== undefined && bend.r1 !== undefined && bend.r1 <= bend.r0) fail(`bend '${bend.name}': r1 must exceed r0`);
  }
  const boneIndex = (name: string, what: string): number => {
    const k = meshBones.indexOf(name);
    if (k < 0) fail(`${what}: bone '${name}' is not a skin influence (${meshBones.join(", ")})`);
    return k;
  };
  const baseIndex = 0;
  const girdleIndex = girdle ? 1 : -1;
  const chainIndex = chainBones.map((_, k) => (girdle ? 2 : 1) + k);
  const tubeLimit = topo.halfWidth + topo.columns;
  // In the limb tube: near the chain axis and reaching it without leaving the surface (a body point
  // across the notch is not in the tube even when its chain v is small).
  // Past the last joint (the distal extremity: hand, foot, paw) the limb may be wider than the
  // tube (a foot's toe and heel): any point that sees the axis is in the tube there, so it takes
  // the distal bone's weights instead of falling back to the first chain bone (r3).
  const lastJoint = Math.max(-Infinity, ...topo.joints.map((j) => j.s));
  const seesFrom = (i: number, q: Pt, j = -1) => {
    const p = points[i] as Pt;
    if (!pointInPolygon(q, hull) && j < 0) return false;
    for (let k = 0; k < H; k++) {
      if (k === i || (k + 1) % H === i || k === j || (k + 1) % H === j) continue;
      const x = segmentCross(p, q, hull[k] as Pt, hull[(k + 1) % H] as Pt);
      if (x && x.t > 1e-6 && (j < 0 || x.t < 1 - 1e-6)) return false;
    }
    return true;
  };
  const inTube = points.map((p, i) => {
    const c = sv[i] as { s: number; v: number };
    if (c.s < topo.from || (Math.abs(c.v) > tubeLimit && !(c.s > lastJoint))) return false;
    const axis = chain.point(c.s, 0);
    if (dist(p, axis) < topo.columns) return true;
    // a distal point also counts when it sees the last joint's axis point (a wide foot or hand)
    return seesFrom(i, axis) || (c.s > lastJoint && seesFrom(i, chain.point(lastJoint, 0)));
  });
  // A distal point in a small bump of the extremity's silhouette (a knuckle or the fist's heel, a toe)
  // sees neither axis point past the hull's own fold, but it is still the hand or foot: it counts
  // when it sees a distal tube point within a column width or two (never across the notch to the
  // body, which is not past the last joint). Without this it falls back to the chain root (100%
  // upper arm on the fist's heel, which flips the hand's edge triangles at any elbow fold).
  const distalTube = points.flatMap((_, i) => (inTube[i] && (sv[i] as { s: number }).s > lastJoint ? [i] : []));
  points.forEach((p, i) => {
    if (inTube[i] || !((sv[i] as { s: number }).s > lastJoint)) return;
    if (distalTube.some((j) => dist(p, points[j] as Pt) <= 2 * topo.columns && seesFrom(i, points[j] as Pt, j < H ? j : -1))) inTube[i] = true;
  });
  const walkHull = (start: number, dir: 1 | -1, length: number) => {
    const out = [{ index: start, arc: 0 }];
    let d = 0;
    for (let k = 1, i = start; k < H; k++) {
      const j = (((i + dir) % H) + H) % H;
      d += dist(points[i] as Pt, points[j] as Pt);
      if (d > length) break;
      out.push({ index: j, arc: d });
      i = j;
    }
    return out;
  };
  const nearestHull = (q: Pt): number => {
    let best = 0;
    for (let i = 1; i < H; i++) if (dist(points[i] as Pt, q) < dist(points[best] as Pt, q)) best = i;
    return best;
  };
  /** Limb width at chain s: the inside interval of the cross-section around the axis. */
  const widthAt = (s: number): number | null => {
    const reach = tubeLimit + 30;
    const a = chain.point(s, -reach);
    const b = chain.point(s, reach);
    let lo: number | null = null;
    let hi: number | null = null;
    for (let i = 0; i < H; i++) {
      const x = segmentCross(a, b, hull[i] as Pt, hull[(i + 1) % H] as Pt);
      if (!x) continue;
      const v = -reach + 2 * reach * x.t;
      if (v <= 0 && (lo === null || v > lo)) lo = v;
      if (v > 0 && (hi === null || v < hi)) hi = v;
    }
    return lo !== null && hi !== null ? hi - lo : null;
  };
  const anchoredApexes = new Map<number, number>(); // apex vertex -> permitted motion
  const apexGirdles = new Map<number, NonNullable<BuiltAnchor["girdle"]>>(); // apex vertex -> girdle coupling
  interface SidePatch {
    spec: Patch;
    start: number;
    walk: 1 | -1;
    sign: 1 | -1;
    extent: number;
    width?: number;
    ratio?: number;
    range?: [number, number];
  }
  const rootBone = chainBones[0] as string;
  const sidePatches: SidePatch[] = [];
  const bandPatches: { spec: Patch; chainK: number; s: number; band: number; foldBand: number; fold: 1 | -1 }[] = [];
  const allowedOf = new Map<Patch, Set<number>>();
  for (const spec of skin.regions.patches) {
    allowedOf.set(spec, new Set(spec.bones.map((b) => boneIndex(b, `patch '${spec.name}'`))));
    const chainK = chainBones.indexOf(spec.joint);
    if (chainK < 0) fail(`patch '${spec.name}': joint '${spec.joint}' is not a chain bone`);
    if (spec.side === "both") {
      if (spec.s === undefined || spec.band === undefined) fail(`patch '${spec.name}': a 'both' patch needs s and band`);
      if (chainK === 0) fail(`patch '${spec.name}': the chain root joint takes inner/outer patches, not a band`);
      bandPatches.push({ spec, chainK, s: spec.s, band: spec.band, foldBand: spec.foldBand ?? spec.band, fold: spec.fold === "-" ? -1 : 1 });
      continue;
    }
    if (spec.joint !== rootBone) fail(`patch '${spec.name}': inner/outer patches are for the chain root joint ('${rootBone}')`);
    if (!spec.from || spec.extent === undefined) fail(`patch '${spec.name}': an inner/outer patch needs from and extent`);
    let start: number;
    let walk: 1 | -1;
    let sign: 1 | -1;
    if (!Array.isArray(spec.from)) {
      const apex = apexes[spec.from.apex] ?? fail(`patch '${spec.name}': no apex ${spec.from.apex}`);
      start = apex.index;
      walk = apex.walk;
      sign = spec.side === "inner" ? apex.sign : (-apex.sign as 1 | -1);
      anchoredApexes.set(apex.index, spec.permittedApexMotion ?? 0);
      if (spec.apexGirdle) {
        const g = spec.apexGirdle;
        const gb = preset.bones.find((b) => b.name === g.bone) ?? fail(`patch '${spec.name}': apexGirdle bone '${g.bone}' is not a bone`);
        // The girdle bone lies on the joint's parent path (a parented ancestor of the joint).
        const ancestors: string[] = [];
        for (let b = preset.bones.find((x) => x.name === spec.joint)?.parent; b; b = preset.bones.find((x) => x.name === b)?.parent) ancestors.push(b);
        if (!ancestors.includes(g.bone) || !gb.parent) fail(`patch '${spec.name}': apexGirdle bone '${g.bone}' must be a parented ancestor of '${spec.joint}'`);
        const jointAt = (preset.bones.find((b) => b.name === spec.joint)?.at ?? fail(`patch '${spec.name}': joint '${spec.joint}' has no 'at'`)) as Pt;
        const k = points[apex.index] as Pt;
        apexGirdles.set(apex.index, { bone: g.bone, parent: gb.parent as string, joint: spec.joint, gain: g.gain, jointAt: [jointAt[0], jointAt[1]], apexAt: [k[0], k[1]] });
      }
    } else {
      if (!spec.toward) fail(`patch '${spec.name}': a patch from a point needs 'toward'`);
      start = nearestHull(spec.from);
      const target = nearestHull(spec.toward);
      const forward = (target - start + H) % H;
      walk = forward <= H - forward ? 1 : -1;
      sign = chain.coords(spec.toward).v >= 0 ? 1 : -1;
    }
    let extent: number;
    let width: number | undefined;
    let range: [number, number] | undefined;
    if (typeof spec.extent === "number") extent = spec.extent;
    else {
      // Local limb width W: the median cross-section of the joint bone's segment past the patch start.
      const from = Math.max((sv[start] as { s: number }).s, chain.jointS[0] as number);
      const to = chain.jointS[1] as number;
      const ws: number[] = [];
      for (let s = from; s <= to; s += 2) {
        const w = widthAt(s);
        if (w !== null) ws.push(w);
      }
      ws.sort((a, b) => a - b);
      width = ws[Math.floor(ws.length / 2)] ?? fail(`patch '${spec.name}': no limb cross-section between s ${from.toFixed(1)} and ${to.toFixed(1)}`);
      range = spec.extent.width;
      extent = range[0] * width;
    }
    sidePatches.push({ spec, start, walk, sign, extent, ...(width !== undefined ? { width } : {}), ...(range ? { range, ratio: range[0] } : {}) });
  }
  for (let k = 1; k < chainBones.length; k++) if (!bandPatches.some((b) => b.chainK === k)) fail(`chain joint '${chainBones[k]}' has no 'both' patch (its hinge band)`);
  /** Half length of a hinge band at chain v: `band` on the extensor side, `foldBand` on the fold side, blended across a quarter width of the axis. */
  const bandHalf = (b: (typeof bandPatches)[number], v: number) => b.band + (b.foldBand - b.band) * smoothstep(-topo.halfWidth / 4, topo.halfWidth / 4, v * b.fold);
  const sEnd = (sp: SidePatch) => {
    const chainHull = walkHull(sp.start, sp.walk, sp.extent);
    return (sv[(chainHull[chainHull.length - 1] as { index: number }).index] as { s: number }).s;
  };
  const fixedPolys = skin.regions.fixed.map((f) => ({ spec: f, bone: boneIndex(f.bone, `fixed region '${f.name}'`), polygon: f.polygon }));
  const coreSpecs = skin.regions.cores.map((c) => ({ spec: c, bone: boneIndex(c.bone, `core '${c.name}'`) }));
  // Region of every vertex, by precedence: anchored apex, fixed region, patches (intersection), core.
  const supportFor = (patchEnds: number[]) => {
    let overlaps = 0;
    const support = points.map((p, i): { region: string; allowed: Set<number> } | null => {
      const permitted = anchoredApexes.get(i);
      if (permitted !== undefined) return { region: "apex", allowed: new Set(permitted > 0 && girdleIndex >= 0 ? [baseIndex, girdleIndex] : [baseIndex]) };
      const fixedHit = fixedPolys.find((f) => pointInPolygon(p, f.polygon));
      if (fixedHit) return { region: fixedHit.spec.name, allowed: new Set([fixedHit.bone]) };
      const c = sv[i] as { s: number; v: number };
      const hits: Patch[] = [];
      if (inTube[i]) {
        sidePatches.forEach((sp, k) => {
          if (c.v * sp.sign >= 0 && c.s <= (patchEnds[k] as number)) hits.push(sp.spec);
        });
        for (const b of bandPatches) if (Math.abs(c.s - b.s) <= bandHalf(b, c.v)) hits.push(b.spec);
      }
      if (hits.length) {
        // Patches may overlap geometrically; influence sets stay disjoint: a hinge band's mask wins
        // over a root side patch (whose body share is clipped to zero at the band's proximal edge).
        const bands = hits.filter((h) => h.side === "both");
        const masks = bands.length ? bands : hits;
        let allowed = new Set(allowedOf.get(masks[0] as Patch));
        for (const h of masks.slice(1)) allowed = new Set([...allowed].filter((b) => (allowedOf.get(h) as Set<number>).has(b)));
        if (bands.length && bands.length < hits.length) overlaps++;
        if (allowed.size === 0) fail(`vertex ${i} at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}) lies in patches ${hits.map((h) => h.name).join(" + ")} with no common bone`);
        return { region: hits.map((h) => h.name).join("+"), allowed };
      }
      const coreHit = inTube[i] ? coreSpecs.find((cs) => c.s >= cs.spec.sMin && c.s <= cs.spec.sMax) : undefined;
      if (coreHit) return { region: coreHit.spec.name, allowed: new Set([coreHit.bone]) };
      return null;
    });
    return { support, overlaps };
  };
  const rule = skin.root;
  const profileAt = (spec: Patch, t: number) => (spec.profile === "smooth" ? smoothstep(0, 1, t) : clamp01(t));
  const bodyBones = new Set([baseIndex, ...(girdleIndex >= 0 ? [girdleIndex] : [])]);
  /** Root joint field: boundary-chain ramps, zeros, then the support masks as boundary values; harmonic in between. */
  const rootField = (support: ({ allowed: Set<number> } | null)[]) => {
    const fixed: (number | null)[] = points.map(() => null);
    for (const sp of sidePatches) for (const { index, arc } of walkHull(sp.start, sp.walk, sp.extent)) fixed[index] = profileAt(sp.spec, arc / sp.extent);
    points.forEach((p, i) => {
      if (rule.zeros.some((z) => ("polygon" in z ? pointInPolygon(p, z.polygon) : inBox(sv[i] as { s: number; v: number }, z)))) fixed[i] = 0;
    });
    support.forEach((sup, i) => {
      if (!sup) return;
      const body = [...sup.allowed].some((b) => bodyBones.has(b));
      const limb = [...sup.allowed].some((b) => !bodyBones.has(b));
      if (!limb) fixed[i] = 0;
      else if (!body) fixed[i] = 1;
    });
    return laplace(points.length, triangles, fixed, rule.iterations ?? 4000);
  };
  // Feasibility: the shortest transition (within the declared width range) whose rotation-blend
  // target keeps every triangle touching the patch above the area floor at both root limits.
  const rootLimits = (preset.bones.find((b) => b.name === rootBone)?.limits ?? [0, 0]) as [number, number];
  const rootPivot = pivots[0] as Pt;
  const blendMinRatio = (alpha: number[], members: Set<number>) => {
    let min = Infinity;
    for (const angle of rootLimits) {
      if (angle === 0) continue;
      const q = points.map((p, i) => rotateAbout(p, rootPivot, (alpha[i] as number) * angle));
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t] as number;
        const b = triangles[t + 1] as number;
        const c = triangles[t + 2] as number;
        if (!members.has(a) && !members.has(b) && !members.has(c)) continue;
        const bind = signedTriangleArea(points[a] as Pt, points[b] as Pt, points[c] as Pt);
        const posed = signedTriangleArea(q[a] as Pt, q[b] as Pt, q[c] as Pt);
        min = Math.min(min, posed / bind);
      }
    }
    return min;
  };
  const patchReport: BuiltSurface["patches"] = [];
  for (const sp of sidePatches) {
    const k = sidePatches.indexOf(sp);
    let best: { ratio: number; extent: number; min: number } | null = null;
    let chosen: { ratio: number; extent: number; min: number } | null = null;
    const candidates = sp.range && sp.width ? Array.from({ length: 6 }, (_, j) => (sp.range as [number, number])[0] + (((sp.range as [number, number])[1] - (sp.range as [number, number])[0]) * j) / 5) : [null];
    for (const ratio of candidates) {
      if (ratio !== null) sp.extent = ratio * (sp.width as number);
      const ends = sidePatches.map(sEnd);
      const { support } = supportFor(ends);
      const alpha = rootField(support);
      const members = new Set(points.flatMap((_, i) => (support[i]?.region.split("+").includes(sp.spec.name) ? [i] : [])));
      const min = blendMinRatio(alpha, members);
      const result = { ratio: ratio ?? sp.extent, extent: sp.extent, min };
      if (!best || min > best.min) best = result;
      if (min > AREA_FLOOR) {
        chosen = result;
        break;
      }
    }
    const pick = chosen ?? (best as { ratio: number; extent: number; min: number });
    sp.extent = pick.extent;
    if (sp.range) sp.ratio = pick.ratio;
    patchReport[k] = {
      name: sp.spec.name,
      side: sp.spec.side,
      joint: sp.spec.joint,
      extent: round(sp.extent, 2),
      ...(sp.width !== undefined ? { width: round(sp.width, 2), ratio: round(sp.ratio as number, 3) } : {}),
      sEnd: 0,
      feasible: chosen !== null,
      minBlendRatio: round(pick.min, 3),
      chain: []
    };
  }
  const patchEnds = sidePatches.map(sEnd);
  sidePatches.forEach((sp, k) => {
    const r = patchReport[k] as BuiltSurface["patches"][number];
    r.sEnd = round(patchEnds[k] as number, 2);
    r.chain = walkHull(sp.start, sp.walk, sp.extent).map((c) => c.index);
  });
  for (const b of bandPatches) patchReport.push({ name: b.spec.name, side: "both", joint: b.spec.joint, extent: b.band + b.foldBand, sEnd: b.s + b.band, feasible: true, minBlendRatio: NaN, chain: [] });
  const { support, overlaps } = supportFor(patchEnds);
  const alphaRoot = rootField(support);
  const distal = chainBones.slice(1).map((_, j) => {
    const b = bandPatches.find((x) => x.chainK === j + 1) as (typeof bandPatches)[number];
    return points.map((_, i) => {
      const c = sv[i] as { s: number; v: number };
      const h = bandHalf(b, c.v);
      return inTube[i] ? smoothstep(b.s - h, b.s + h, c.s) : 0;
    });
  });
  // The root side patches' body share (base + girdle) fades to zero at the first hinge band's
  // proximal edge (smoothstep over its fold-side half length): no chest in the elbow patch.
  const firstBand = bandPatches.find((b) => b.chainK === 1);
  if (firstBand) {
    points.forEach((_, i) => {
      if (!inTube[i]) return;
      const c = sv[i] as { s: number; v: number };
      const h = bandHalf(firstBand, c.v);
      const edge = firstBand.s - h;
      const keep = 1 - smoothstep(edge - firstBand.foldBand, edge, c.s);
      alphaRoot[i] = 1 - (1 - (alphaRoot[i] as number)) * keep;
    });
  }
  // Cumulative chain fractions before masking (monotone along the chain).
  const rawAlphas: number[][] = [alphaRoot];
  for (const field of distal) rawAlphas.push(field.map((a, i) => Math.min(a, (rawAlphas[rawAlphas.length - 1] as number[])[i] as number)));
  // The girdle never overrides an anchor: its share fades to 0 towards fixed regions and anchored apexes.
  const featherOf = (p: Pt): number => {
    if (!girdle?.feather) return 1;
    let d = Infinity;
    for (const f of fixedPolys) d = Math.min(d, pointInPolygon(p, f.polygon) ? 0 : distanceToPolyline(p, f.polygon, true));
    for (const v of anchoredApexes.keys()) d = Math.min(d, dist(p, points[v] as Pt));
    return smoothstep(0, girdle.feather, d);
  };
  const girdleAlpha = (p: Pt) => {
    if (!girdle) return 0;
    const dx = p[0] - girdle.center[0];
    const dy = (p[1] - girdle.center[1]) * (p[1] > girdle.center[1] ? girdle.belowScale : 1);
    // Mirror rule: the girdle ends before the centreline (trunk weights only there).
    const mid = preset.mirror ? smoothstep(0, preset.mirror.feather, Math.abs(p[0] - preset.mirror.x)) : 1;
    return (1 - smoothstep(girdle.r0, girdle.r1, Math.hypot(dx, dy))) * featherOf(p) * mid;
  };
  const weightsFor = (p: Pt, chainAlphas: number[], allowed?: Set<number> | null): [number, number][] => {
    const a0 = chainAlphas[0] ?? 0;
    const g = girdle ? Math.max(girdleAlpha(p), a0) : a0;
    const raw: number[] = [1 - g];
    if (girdle) raw.push(g - a0);
    chainAlphas.forEach((a, k) => raw.push(a - (chainAlphas[k + 1] ?? 0)));
    // Hard support mask: forbidden influences are exactly zero, the rest renormalised.
    const kept = raw.map((w, b) => [b, w >= 0.004 && (!allowed || allowed.has(b)) ? w : 0] as [number, number]).filter(([, w]) => w > 0);
    const sum = kept.reduce((s, [, w]) => s + w, 0);
    if (!(sum > 0)) {
      const only = allowed && allowed.size === 1 ? [...allowed][0] : undefined;
      if (only !== undefined) return [[only, 1]];
      fail(`support mask leaves the vertex at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}) without an influence`);
    }
    return kept.map(([b, w]) => [b, w / sum]);
  };
  const weights = points.map((p, i) => weightsFor(p, rawAlphas.map((a) => a[i] as number), support[i]?.allowed));
  // Trunk bends: near-rigid regions joined by local bends, applied over the limb
  // weights: only the `from` share moves, so the limb's and girdle's shares stay exactly as built.
  const fixedVertexSet = new Set(support.flatMap((x, i) => (x && fixedPolys.some((f) => f.spec.name === x.region) ? [i] : [])));
  for (const bend of bendSpecs) {
    const from = meshBones.indexOf(bend.from);
    const to = meshBones.indexOf(bend.to);
    points.forEach((p, i) => {
      const t = bendShare(bend, p);
      if (t <= 0) return;
      const inf = weights[i] as [number, number][];
      const k = inf.findIndex(([b]) => b === from);
      if (k < 0) return;
      if (fixedVertexSet.has(i)) fail(`bend '${bend.name}' reaches fixed-region vertex ${i} at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}): a fixed region follows its bone alone (end it before the bend)`);
      // Hard support masks hold through bends: a bend may not hand a
      // share to a bone the vertex's patch, core or apex mask forbids (end the bend before it).
      const sup = support[i];
      if (sup && !sup.allowed.has(to)) fail(`bend '${bend.name}' reaches vertex ${i} at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}) in support region '${sup.region}', which does not allow '${bend.to}' (end the bend before it)`);
      // A remainder under the influence floor moves whole (no renormalisation: the other shares stay exact).
      const own = (inf[k] as [number, number])[1];
      const moved = own * t > own - 0.004 ? own : own * t;
      const j = inf.findIndex(([b]) => b === to);
      if (j >= 0) (inf[j] as [number, number])[1] += moved;
      else inf.push([to, moved]);
      if (moved === own) inf.splice(k, 1);
      else (inf[k] as [number, number])[1] = own - moved;
      if (inf.length > 4) fail(`bend '${bend.name}': vertex ${i} would carry ${inf.length} influences (max 4)`);
    });
  }
  // alphas[k][i]: the fraction of chain joint k's rotation vertex i follows, from the final weights.
  const alphas: number[][] = chainBones.map((_, k) => weights.map((inf) => inf.reduce((s, [b, w]) => s + (chainIndex.indexOf(b) >= k ? w : 0), 0)));
  const fixedVertices: Record<string, number[]> = {};
  for (const f of skin.regions.fixed) fixedVertices[f.name] = support.flatMap((s, i) => (s?.region === f.name ? [i] : []));
  const skinPaint = paint(points, skin.base, skin.fills, chain, 6);
  const skinMesh: BuiltMesh = {
    slot: skin.slot,
    attachment: skin.attachment,
    texture: skin.texture,
    bones: meshBones,
    points,
    hull: hull.length,
    triangles,
    weights,
    chainSV: sv,
    alphas,
    image: skinPaint.image,
    origin: skinPaint.origin,
    groups
  };

  // --- garments ------------------------------------------------------------------------------
  const overlayInfo: BuiltSurface["overlays"] = [];
  const garmentGroups = new Map<string, Record<string, [number, number][]>>();
  const garments: BuiltMesh[] = preset.garments.map((g) => {
    const sampled = samplePath(g.path, chain, g.spacing, true);
    const keptOutline = reduce?.garments?.[g.name];
    const gh = keptOutline ? [...new Set(keptOutline)].sort((a, b) => a - b).map((i) => sampled[i] ?? fail(`runtime reduction: garment '${g.name}' has no outline sample ${i}`)) : sampled;
    let gp: Pt[];
    let gt: number[];
    let hullCount: number;
    // Overlay bands: per listed contour, its bind centreline and the inner line (half width plus
    // the fill band inside, eased to the centreline over `taper` px of arc at both ends).
    const bands = (g.overlays ?? []).map((o) => {
      const what = `garment '${g.name}' overlay '${o.name}'`;
      if (!g.conform) fail(`${what}: overlays need a conform garment`);
      const lines = o.contours.map((name) => {
        const spec = g.contours.find((c) => c.name === name) ?? fail(`${what}: no contour '${name}' on the garment`);
        if (spec.owner !== o.name) fail(`${what}: contour '${name}' must be owned by the overlay (owner '${spec.owner}')`);
        const anchor = (a: Anchor): Pt => (Array.isArray(a) ? (a as Pt) : fail(`${what}: contour '${name}' needs point anchors`));
        const line = outlineSpan(gh, anchor(spec.from), anchor(spec.to), spec.reverse);
        const arcs = [0];
        for (let i = 1; i < line.length; i++) arcs.push((arcs[i - 1] as number) + dist(line[i - 1] as Pt, line[i] as Pt));
        const total = arcs[arcs.length - 1] as number;
        const half = spec.width / 2;
        const depth = (k: number) => {
          const a = arcs[k] as number;
          const ease = o.taper > 0 ? smoothstep(0, o.taper, a) * smoothstep(0, o.taper, total - a) : 1;
          return -(half + o.fillBand) * ease;
        };
        // The inner offset of a convex corner folds back on itself (a swallowtail): cut each loop at its crossing.
        const inner = offsetEdge(line, gh, depth);
        for (let i = 0; i + 1 < inner.length; i++) {
          for (let j = inner.length - 2; j > i + 1; j--) {
            const a = inner[i] as Pt;
            const b = inner[i + 1] as Pt;
            const x = segmentCross(a, b, inner[j] as Pt, inner[j + 1] as Pt);
            if (!x || x.t <= 1e-9 || x.t >= 1 - 1e-9 || x.u <= 1e-9 || x.u >= 1 - 1e-9) continue;
            inner.splice(i + 1, j - i, [a[0] + (b[0] - a[0]) * x.t, a[1] + (b[1] - a[1]) * x.t]);
            break;
          }
        }
        return { name, half, line, inner, band: [...line, ...[...inner].reverse()] };
      });
      return { o, lines };
    });
    if (g.conform) {
      // Close-fitting garment: the skin triangulation clipped to the garment outline (overlay band
      // inner lines as extra constraints).
      // Near-coincident outline/skin features merged first: no sliver triangles, no
      // minimum-angle floor, conformity exact (the outline moves onto skin vertices).
      const merge = (CONFORM_MERGE_GAME_PX * preset.figureHeight) / preset.gamePixels;
      const c = conformToSkin(mergeLineIntoMesh(gh, points, triangles, merge, true), points, triangles, 0.05, bands.flatMap((b) => b.lines.map((l) => mergeLineIntoMesh(simplifyLine(l.inner, (BAND_MERGE_GAME_PX * preset.figureHeight) / preset.gamePixels), points, triangles, (BAND_MERGE_GAME_PX * preset.figureHeight) / preset.gamePixels))));
      gp = c.points;
      gt = c.triangles;
      hullCount = c.hull;
      if (bands.length) {
        // Overlay triangles: centroid inside the overlay's region and one of its bands, and off the
        // strokes it does not own (a redrawn band must not cover a body-piece stroke such as the
        // neckline where it leaves the strap).
        const foreign = bands.map((b) =>
          g.contours.filter((c) => !b.o.contours.includes(c.name) && Array.isArray(c.from) && Array.isArray(c.to)).map((c) => ({ line: outlineSpan(gh, c.from as Pt, c.to as Pt, c.reverse), half: c.width / 2 }))
        );
        const owner = Array.from({ length: gt.length / 3 }, (_, t) => {
          const c3: Pt = [0, 0];
          for (let k = 0; k < 3; k++) {
            const q = gp[gt[t * 3 + k] as number] as Pt;
            c3[0] += q[0] / 3;
            c3[1] += q[1] / 3;
          }
          let o = 0;
          bands.forEach((b, k) => {
            if (!pointInPolygon(c3, b.o.region) || !b.lines.some((l) => pointInPolygon(c3, l.band))) return;
            if ((foreign[k] ?? []).some((f) => distanceToPolyline(c3, f.line, false) < f.half + 0.5)) return;
            o = k + 1;
          });
          return o;
        });
        // The body piece keeps every triangle (no hole, so no anti-aliased seam along the band's inner
        // line); each overlay draws its band's triangles again, same vertices, UVs and weights.
        const all = gt.slice();
        const ranges: Record<string, [number, number][]> = { [g.slot]: [[0, all.length / 3]] };
        bands.forEach((b, k) => {
          const mine = owner.flatMap((o, t) => (o === k + 1 ? [t] : []));
          if (!mine.length) fail(`garment '${g.name}': overlay '${b.o.name}' selects no triangle (region and band)`);
          ranges[b.o.name] = [[gt.length / 3, gt.length / 3 + mine.length]];
          gt = [...gt, ...mine.flatMap((t) => [all[t * 3] as number, all[t * 3 + 1] as number, all[t * 3 + 2] as number])];
        });
        for (const b of bands) {
          overlayInfo.push({ name: b.o.name, garment: g.name, slot: g.slot, above: b.o.above, contours: b.o.contours, fillBand: b.o.fillBand, clearance: b.o.clearance, half: Math.max(...b.lines.map((l) => l.half)), bands: b.lines.map((l) => l.band), range: (ranges[b.o.name] as [number, number][])[0] as [number, number] });
        }
        garmentGroups.set(g.name, ranges);
      }
    } else {
      gp = [...gh];
      gp.push(...lattice(gh, gp, g.lattice, g.minDistance ?? g.lattice * 0.6));
      gt = triangulate(gp, gh.map((_, i) => [i, (i + 1) % gh.length] as [number, number]), gh.length);
      hullCount = gh.length;
    }
    const embed: NonNullable<BuiltMesh["embed"]> = { vertices: [], points: [] };
    const embedded = new Set<number>();
    const gw = gp.map((p, i) => {
      const own = weightsFor(p, []);
      if (!g.embed && !g.conform) return own;
      // On the skin (or within the snapping margin of it): a barycentric point of the skin triangle.
      const e = embedInMesh(points, triangles, p, g.embedMargin ?? 0.05);
      if (!e) return own;
      embedded.add(i);
      embed.vertices.push(i);
      embed.points.push(e.point);
      // Fallback weights (tools that do not pose meshes): the skin weights blended at the point.
      const blend = new Map<number, number>();
      e.tri.forEach((v, k) => {
        const w = Math.max(0, e.weights[k] as number);
        for (const [b, x] of weights[v] as [number, number][]) blend.set(b, (blend.get(b) ?? 0) + w * x);
      });
      const top = [...blend.entries()].filter(([, w]) => w > 0.004).sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0);
      return top.map(([b, w]) => [b, w / sum] as [number, number]);
    });
    // Off the skin: a vertex inherits the weights of its nearest embedded garment vertex along the
    // garment mesh (a cuff hanging off the arm follows the arm), whatever skin group lies near it.
    const offSkin: number[] = [];
    if ((g.embed || g.conform) && embedded.size) {
      const from = inheritAlongMesh(gp, gt, embedded);
      gp.forEach((_, i) => {
        if (embedded.has(i)) return;
        const src = from[i];
        if (src === undefined || src < 0) return;
        gw[i] = (gw[src] as [number, number][]).map(([b, w]) => [b, w] as [number, number]);
        offSkin.push(i);
      });
    }
    const painted = paint(gp, g.base, g.fills, chain, 6);
    return {
      slot: g.slot,
      attachment: g.attachment ?? g.name,
      texture: g.texture,
      bones: meshBones,
      points: gp,
      hull: hullCount,
      triangles: gt,
      weights: gw,
      alphas: [],
      image: painted.image,
      origin: painted.origin,
      ...(embed.vertices.length ? { embed } : {}),
      ...(offSkin.length ? { offSkin } : {}),
      ...(g.conform ? { conform: true } : {}),
      ...(garmentGroups.has(g.name) ? { groups: garmentGroups.get(g.name) as Record<string, [number, number][]> } : {})
    };
  });

  // --- arm layer: detached under-sheets ---------------------------------------------------------
  // Built beside the skin, not cut from it: own silhouette and lattice, trunk weights only
  // (base, girdle, trunk bends), never a chain joint, so moving an arm cannot pull the torso.
  const sheetSpecs = preset.assembly?.sheets ?? [];
  const sheets: BuiltMesh[] = sheetSpecs.map((sh) => {
    const sp = samplePath(sh.silhouette, chain, sh.spacing, true);
    const pts: Pt[] = [...sp];
    pts.push(...lattice(sp, pts, sh.lattice, sh.minDistance));
    const tri = triangulate(pts, sp.map((_, i) => [i, (i + 1) % sp.length] as [number, number]), sp.length);
    const w = pts.map((p) => weightsFor(p, []));
    for (const bend of bendSpecs) {
      const from = meshBones.indexOf(bend.from);
      const to = meshBones.indexOf(bend.to);
      pts.forEach((p, i) => {
        const t = bendShare(bend, p);
        if (t <= 0) return;
        const inf = w[i] as [number, number][];
        const k = inf.findIndex(([b]) => b === from);
        if (k < 0) return;
        const own = (inf[k] as [number, number])[1];
        const moved = own * t > own - 0.004 ? own : own * t;
        const j = inf.findIndex(([b]) => b === to);
        if (j >= 0) (inf[j] as [number, number])[1] += moved;
        else inf.push([to, moved]);
        if (moved === own) inf.splice(k, 1);
        else (inf[k] as [number, number])[1] = own - moved;
      });
    }
    for (const inf of w) if (inf.some(([b]) => chainIndex.includes(b))) fail(`sheet '${sh.name}': a vertex carries a limb chain weight`);
    const painted = paint(pts, sh.base, sh.fills, chain, 6);
    return { slot: sh.slot, attachment: sh.attachment, texture: sh.texture, bones: meshBones, points: pts, hull: sp.length, triangles: tri, weights: w, alphas: [], image: painted.image, origin: painted.origin };
  });

  // --- junctions and contours ------------------------------------------------------------------
  const meshByKey = (key: string): BuiltMesh => {
    if (key === "skin") return skinMesh;
    const si = sheetSpecs.findIndex((x) => x.name === key);
    if (si >= 0) return sheets[si] as BuiltMesh;
    const k = preset.garments.findIndex((g) => g.name === key);
    return (garments[k] as BuiltMesh | undefined) ?? fail(`no mesh '${key}' (the skin or a garment name)`);
  };
  const nearestHullOf = (mesh: BuiltMesh, q: Pt): number => {
    let best = 0;
    for (let i = 1; i < mesh.hull; i++) if (dist(mesh.points[i] as Pt, q) < dist(mesh.points[best] as Pt, q)) best = i;
    return best;
  };
  const junctions: BuiltSurface["junctions"] = (skin.junctions ?? []).map((j) => {
    const mesh = j.on ?? "skin";
    let index = nearestHullOf(meshByKey(mesh), j.at);
    if (j.leaves) {
      // Hull exit: the first skin hull vertex (from `at` towards `toward`) outside the garment by
      // more than its edge half width; the garment's edge owns the silhouette before it.
      if (mesh !== "skin") fail(`junction '${j.name}': a 'leaves' junction is a skin vertex`);
      const gi = preset.garments.findIndex((g) => g.name === j.leaves);
      const garment = garments[gi] ?? fail(`junction '${j.name}': no garment '${j.leaves}'`);
      const half = Math.max(0, ...(preset.garments[gi]?.contours ?? []).map((c) => c.width / 2));
      const gHull = garment.points.slice(0, garment.hull);
      const target = nearestHullOf(skinMesh, j.toward ?? fail(`junction '${j.name}': 'leaves' needs 'toward'`));
      const forward = (target - index + H) % H;
      const step = forward <= H - forward ? 1 : -1;
      for (let k = 0; k < H; k++, index = (((index + step) % H) + H) % H) {
        const p = points[index] as Pt;
        if (!pointInPolygon(p, gHull) && distanceToPolyline(p, gHull, true) > half) break;
        if (index === target) fail(`junction '${j.name}': the skin hull does not leave '${j.leaves}' before (${(j.toward as Pt).join(", ")})`);
      }
    }
    return { name: j.name, mesh, index, at: meshByKey(mesh).points[index] as Pt, radius: j.radius };
  });
  const anchorIndex = (mesh: BuiltMesh, anchor: Anchor): number => {
    if (Array.isArray(anchor)) return nearestHullOf(mesh, anchor);
    if ("junction" in anchor) {
      const j = junctions.find((x) => x.name === anchor.junction) ?? fail(`no junction '${anchor.junction}' (skin.junctions)`);
      return nearestHullOf(mesh, j.at);
    }
    if (mesh !== skinMesh) fail(`row and apex anchors are skin anchors (mesh '${mesh.slot}')`);
    if ("apex" in anchor) return (apexes[anchor.apex] ?? fail(`no apex ${anchor.apex}`)).index;
    const key = `${round(anchor.row, 3)}:${anchor.side}`;
    const found = rowEnd.get(key);
    if (found === undefined) throw new Error(`no row end '${key}' on the ${mesh.slot} hull (rows: ${rows.map((r) => round(r, 2)).join(", ")})`);
    return found;
  };
  const contourList: BuiltSurface["contours"] = [];
  const contourDocs: Record<string, Record<string, unknown>> = {};
  const addContours = (mesh: BuiltMesh, specs: readonly ContourSpec[], meshKey: string) => {
    for (const c of specs) {
      const a = anchorIndex(mesh, c.from);
      const b = anchorIndex(mesh, c.to);
      const step = c.reverse ? -1 : 1;
      const ids: number[] = [a];
      for (let i = a; i !== b; ) {
        i = (((i + step) % mesh.hull) + mesh.hull) % mesh.hull;
        ids.push(i);
        if (ids.length > mesh.hull + 1) throw new Error(`contour '${c.name}' does not close`);
      }
      (contourDocs[c.owner] ??= {})[c.name] = { mesh: { slot: mesh.slot, attachment: mesh.attachment }, points: ids, width: c.width, color: c.color, caps: c.caps ?? "butt", ...(c.extend ? { extend: c.extend } : {}), ...(c.coverUnder ? { coverUnder: c.coverUnder } : {}), ...(c.coverTight ? { coverTight: true } : {}), ...(c.visible ? { visible: c.visible } : {}), ...(c.trimAtOutline ? { trimAtOutline: true } : {}), ...(c.fade ? { owner: { slot: `${c.owner}_${c.name}_fade`, attachment: "fade" } } : {}) };
      contourList.push({ owner: c.owner, name: c.name, mesh: meshKey, points: ids, width: c.width });
    }
  };
  addContours(skinMesh, skin.contours, "skin");
  preset.garments.forEach((g, k) => addContours(garments[k] as BuiltMesh, g.contours, g.name));
  sheetSpecs.forEach((sh, k) => addContours(sheets[k] as BuiltMesh, sh.contours, sh.name));

  // --- document --------------------------------------------------------------------------------
  const encode = (mesh: BuiltMesh) => {
    const out: number[] = [];
    mesh.points.forEach((p, i) => {
      const inf = mesh.weights[i] as [number, number][];
      out.push(inf.length);
      for (const [b, w] of inf) {
        const bone = bones.get(mesh.bones[b] as string) as { at: Pt; rotation: number };
        const local = rotateAbout([p[0] - bone.at[0], p[1] - bone.at[1]], [0, 0], -bone.rotation);
        out.push(b, round(local[0]), round(local[1]), round(w, 6));
      }
    });
    return out;
  };
  const meshDoc = (mesh: BuiltMesh) => ({
    type: "mesh",
    path: mesh.texture,
    bones: mesh.bones,
    uvs: mesh.points.flatMap((p) => [round((p[0] - mesh.origin[0]) / mesh.image.width, 6), round((p[1] - mesh.origin[1]) / mesh.image.height, 6)]),
    triangles: mesh.triangles,
    vertices: encode(mesh),
    hull: mesh.hull,
    ...(mesh.groups ? { groups: mesh.groups } : {}),
    ...(mesh.embed ? { embed: { slot: skinMesh.slot, attachment: skinMesh.attachment, vertices: mesh.embed.vertices, points: mesh.embed.points } } : {}),
    width: mesh.image.width,
    height: mesh.image.height
  });
  const attachments: Record<string, Record<string, unknown>> = { [skinMesh.slot]: { [skinMesh.attachment]: meshDoc(skinMesh) } };
  for (const g of garments) attachments[g.slot] = { [g.attachment]: meshDoc(g) };
  for (const g of sheets) attachments[g.slot] = { [g.attachment]: meshDoc(g) };
  const images = new Map<string, FillImage>([[skinMesh.texture, skinMesh.image], ...garments.map((g) => [g.texture, g.image] as [string, FillImage]), ...sheets.map((g) => [g.texture, g.image] as [string, FillImage])]);
  for (const r of preset.regions) {
    const bone = bones.get(r.bone) ?? fail(`region bone '${r.bone}' missing`);
    const centre: Pt = [r.crop[0] + r.crop[2] / 2, r.crop[1] + r.crop[3] / 2];
    const local = rotateAbout([centre[0] - bone.at[0], centre[1] - bone.at[1]], [0, 0], -bone.rotation);
    attachments[r.slot] = { [r.name]: { type: "region", path: r.texture, x: round(local[0]), y: round(local[1]), rotation: round(-bone.rotation), width: r.crop[2], height: r.crop[3] } };
  }
  const slotBone = new Map<string, string>();
  skin.groups.forEach((g) => slotBone.set(g.slot, g.bone));
  preset.garments.forEach((g) => slotBone.set(g.slot, g.bone));
  sheetSpecs.forEach((g) => slotBone.set(g.slot, preset.base));
  // Fader slots (contour `fade`): a point attachment on the user's bone, drawn right after the user.
  const fades: BuiltSurface["fades"] = [];
  for (const c of [...skin.contours, ...sheetSpecs.flatMap((s) => s.contours)]) {
    if (!c.fade) continue;
    const slot = `${c.owner}_${c.name}_fade`;
    const keysOf = (k: readonly (readonly number[])[]) => k.map(([at, alpha]) => ({ at: at as number, alpha: alpha as number }));
    const ors = c.fade.or ?? [];
    fades.push({ slot, name: slot, bone: c.fade.bone, keys: keysOf(c.fade.keys), ...(ors.length ? { alphaOr: `${slot}_or0` } : {}) });
    ors.forEach((factors, i) => factors.forEach((f, j) => fades.push({ slot, name: `${slot}_or${i + 1}_${j}`, bone: f.bone, keys: keysOf(f.keys), alphaOr: `${slot}_or${i + 1}` })));
    attachments[slot] = { fade: { type: "point" } };
  }
  preset.regions.forEach((r) => slotBone.set(r.slot, r.bone));
  // Derived draw order: a root group (`under`) just below its garment's body piece; an overlay
  // right after its `above` group (before the next limb segment's group).
  const drawOrder = [...preset.drawOrder];
  const derived = [...skin.groups.filter((g) => g.under).map((g) => g.slot), ...overlayInfo.map((o) => o.name)];
  for (const name of derived) if (drawOrder.includes(name)) fail(`slot '${name}' is derived (a root group or an overlay); leave it out of drawOrder`);
  for (const g of skin.groups) {
    if (!g.under) continue;
    const garment = preset.garments.find((x) => x.name === g.under?.garment) ?? fail(`group '${g.slot}': no garment '${g.under.garment}'`);
    const at = drawOrder.indexOf(garment.slot);
    if (at < 0) fail(`group '${g.slot}' is under '${garment.name}': drawOrder must list '${garment.slot}'`);
    drawOrder.splice(at, 0, g.slot);
  }
  for (const o of overlayInfo) {
    const at = drawOrder.indexOf(o.above);
    if (at < 0 || !skin.groups.some((g) => g.slot === o.above)) fail(`overlay '${o.name}': above '${o.above}' is not a skin group in drawOrder`);
    if (drawOrder.indexOf(o.slot) > at) fail(`overlay '${o.name}': drawOrder must list its garment '${o.slot}' before '${o.above}'`);
    drawOrder.splice(at + 1, 0, o.name);
    slotBone.set(o.name, slotBone.get(o.slot) as string);
  }
  for (const f of fades) {
    if (drawOrder.includes(f.slot)) continue; // further OR factors of one fader
    const host = drawOrder.find((n) => f.slot.startsWith(`${n}_`) && slotBone.has(n)) ?? fail(`fader '${f.slot}': its owner slot is not drawn`);
    slotBone.set(f.slot, slotBone.get(host) as string);
    drawOrder.splice(drawOrder.indexOf(host) + 1, 0, f.slot);
  }
  const slots = drawOrder.map((name) => {
    const bone = slotBone.get(name) ?? fail(`slot '${name}' has no bone (not a group, garment or region slot)`);
    const attachment = attachments[name] ? Object.keys(attachments[name] as object)[0] : undefined;
    return { name, bone, ...(attachment ? { attachment } : {}), color: WHITE };
  });
  const document: Record<string, unknown> = {
    format: "atlas-anim@1",
    name: preset.name,
    canvas: preset.canvas,
    bones: rawBones,
    slots,
    skins: { [preset.skinName ?? "body"]: { attachments, contours: contourDocs, ...(contourContacts(preset, contourList).length ? { contourContacts: contourContacts(preset, contourList) } : {}) } },
    animations: {}
  };
  return { preset, document, images, skin: skinMesh, garments, sheets, fades, partition, bones, chain, contours: contourList, apexes, rows: rowLines, support: support.map((x) => (x ? { region: x.region, allowed: [...x.allowed].sort((p, q) => p - q) } : null)), patches: patchReport, patchOverlaps: overlaps, fixedVertices, anchors: [...anchoredApexes.entries()].map(([index, permittedMotion]) => ({ index, permittedMotion, ...(apexGirdles.has(index) ? { girdle: apexGirdles.get(index) as NonNullable<BuiltAnchor["girdle"]> } : {}) })), junctions, triangleGroups: sortedOwner, groupSlots: skin.groups.map((g) => g.slot), drawOrder, overlays: overlayInfo, roots: skin.groups.flatMap((g) => (g.under ? [{ slot: g.slot, garment: g.under.garment, clearance: g.under.clearance }] : [])), ...(reduce ? { reduced: reduce } : {}) };
}

function fail(message: string): never {
  throw new Error(message);
}

export type { PathPoint };

/**
 * The document's contour contacts from the preset's declared contact pairs (gates.clearance.contacts,
 * keys owner/name): drawn as one merged line where they touch, with the clearance gap (one display px)
 * and angle (core/contours.ts applyContact).
 */
export function contourContacts(preset: SurfacePreset, contours: readonly { owner: string; name: string; mesh: string; points: number[]; width: number }[] = []): { a: { slot: string; name: string }; b: { slot: string; name: string }; gap: number; angle: number }[] {
  const cl = preset.gates?.clearance;
  if (!cl?.merge) return [];
  const gap = (cl?.displayPx ?? 1) / (preset.gamePixels / preset.figureHeight);
  const ref = (key: string) => ({ slot: key.slice(0, key.indexOf("/")), name: key.slice(key.indexOf("/") + 1) });
  // A garment ink split into contours chained end to start with one width is one ink: a declared
  // contact applies to every member of the chain.
  const chainOf = (key: string): string[] => {
    const c = contours.find((x) => `${x.owner}/${x.name}` === key);
    if (!c || c.mesh === "skin") return [key];
    const members = new Set([c]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of contours) {
        if (members.has(x) || x.mesh !== c.mesh || x.width !== c.width) continue;
        if ([...members].some((m) => m.points[m.points.length - 1] === x.points[0] || x.points[x.points.length - 1] === m.points[0])) {
          members.add(x);
          grew = true;
        }
      }
    }
    return [...members].map((m) => `${m.owner}/${m.name}`);
  };
  const seen = new Set<string>();
  const out: { a: { slot: string; name: string }; b: { slot: string; name: string }; gap: number; angle: number }[] = [];
  for (const c of cl?.contacts ?? []) {
    for (const ka of chainOf(c.pair[0])) {
      for (const kb of chainOf(c.pair[1])) {
        const id = [ka, kb].sort().join("|");
        if (ka === kb || seen.has(id)) continue;
        seen.add(id);
        out.push({ a: ref(ka), b: ref(kb), gap: Number(gap.toFixed(4)), angle: cl?.maxAngle ?? 15 });
      }
    }
  }
  return out;
}
