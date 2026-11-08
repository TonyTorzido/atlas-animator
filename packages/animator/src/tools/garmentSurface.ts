/*
 * Atlas Animator: original implementation.
 *
 * Plan, construction pass 1: a fitted garment is ONE body-derived surface.
 * - Domain: declared in body material coordinates (body triangle id + barycentric weights), apart
 *   from the art and the generated garment: the covered draw groups, the cut lines (neckline, cuffs,
 *   hem) as ordered material polylines with the groups they cut, one seed per group on the covered
 *   side, the protected gaps (trunk boundary vs limb boundary) and the margin m (canvas units).
 *   `deriveDomainFromArt` records it once from an art PNG aligned with the rest pose.
 * - Core: the covered body triangles; a triangle a cut crosses is subdivided locally (constrained
 *   triangulation of the triangle, its split edges and the cut pieces inside it). Every core vertex
 *   is a nonnegative barycentric binding to its real parent triangle (a body vertex, a point on a
 *   body edge, or a cut point inside the triangle); the runtime reads the body's final evaluated
 *   positions (correctives included) through the embed. No re-embedding, no extrapolation, no
 *   fallback.
 * - Margin: each run of core boundary edges on the body's own boundary (between cut ends) gets a
 *   strip of one cell per edge: inner edge on the core boundary, outer edge the run's posed polyline
 *   offset by d = m + (w_b - w_g) / 2 along the miter normal from its neighbours on the same run
 *   (runtime `embed.offsets`, core/skinning.ts offsetPoint, bounded joins). Adjacent cells share
 *   their vertices; nothing joins two runs or crosses a gap.
 * - Draw groups: one mesh, its triangles partitioned by the body draw group of their parent (a strip
 *   cell by its core neighbour), each group drawn in its own slot right after the body group; all
 *   groups read the one posed vertex array, so partition vertices are identical.
 * - Outlines: one open stroke per run along the outer offset vertices (the offset body contour),
 *   one per cut along the cut from outer end to outer end; split by draw group at shared vertices.
 * - Texture: flat fabric (pass 1), UVs frozen from the garment's rest positions.
 * The gates (correspondence, zero-margin control, offset deviation, flips, gaps, contours) are pure
 * functions of a posed skeleton and the build, so the CLI and the tests share them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import cdt2d from "cdt2d";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { OFFSET_FLAG_CLIPPED, OFFSET_FLAG_MITER, OFFSET_MITER_LIMIT, computeOffsetPoints, offsetChainsFromNext, offsetPoint } from "../core/skinning.js";
import type { MeshAttachment } from "../core/attachments.js";
import type { RgbaImage } from "./image.js";
import { bindPositions, distInside, smoothLoop, traceLoops } from "./garmentImport.js";

type Pt = [number, number];
/** A body material point: triangle id and the weights of its first two vertices (third = 1 - both). */
export type MaterialPoint = [number, number, number];

export interface GarmentCut {
  name: string;
  kind: "neckline" | "cuff" | "hem" | "cut";
  /** Body draw groups whose material the cut divides (only their triangles are cut). */
  groups: string[];
  /** Ordered polyline; the ends lie on the body boundary of `groups`. */
  points: MaterialPoint[];
  /**
   * The slot drawn over the opening (the head over a neckline). The outline strokes ending at this
   * cut (and, for a stroked cut, its own stroke's ends) also get a short end piece drawn just above
   * that slot, so the line reaches the overlapping part's own ink instead of stopping under its
   * opaque stub. Resolved per cut.
   */
  endsAbove?: string;
  /**
   * Whether the cut's boundary gets a runtime stroke (default: every kind). An unstroked cut keeps
   * the art's own painted edge ink. left necklines unstroked (the art's thin line); 
   * a fitted garment's neckline closes with its own runtime outline in the item stroke
   * colour, drawn inside the garment (see `inset`), and the art's painted neckline ink is repainted.
   */
  stroke?: boolean;
  /**
   * Stroked cuts: canvas px the stroke's centreline sits inside the garment (default: half the
   * stroke width for a neckline, so the stroke's outer edge lies on the cut and the skin between
   * the chin and the collar stays clean; 0 for the other kinds). Ramped to 0 over one stroke width
   * at the chain ends, where the stroke meets the garment's side outlines.
   */
  inset?: number;
  /**
   * Necklines: canvas px the cut is lowered from the art's top edge before the build (default
   * NECKLINE_DROP; 0 keeps it on the art's edge, e.g. a collar trim band right under the ink).
   * Applied by `dropNecklines`; the item's own setting, carried by its domain.
   */
  drop?: number;
}

/** Whether a cut's boundary is stroked at runtime (see GarmentCut.stroke). */
export function cutStroked(cut: GarmentCut): boolean {
  return cut.stroke ?? true;
}

/** Canvas px a stroked cut's line sits inside the garment (see GarmentCut.inset). */
export function cutInset(cut: GarmentCut, strokeWidth: number): number {
  return cut.inset ?? (cut.kind === "neckline" ? strokeWidth / 2 : 0);
}

/** A contour point: a mesh vertex, or [a, b, c, wa, wb] barycentric on a garment triangle. */
export type ContourPoint = number | [number, number, number, number, number];

export interface GarmentDomain {
  format: "atlas-garment-domain/1";
  name: string;
  skin: { slot: string; attachment: string };
  /** Covered body draw groups. */
  groups: string[];
  cuts: GarmentCut[];
  /** One covered material point per group (the covered side of the cuts). */
  seeds: { group: string; point: MaterialPoint }[];
  /** Protected gaps: the garment boundary over groups `a` must never close on the one over `b`. */
  gaps: { name: string; a: string[]; b: string[] }[];
  /** m: separation between the outer painted silhouettes (garment past body), canvas units. */
  margin: number;
  /**
   * Declared cut details (pass 2): at the body-boundary end of a cut, the source silhouette runs
   * `extra` canvas px past the uniform margin (a hem flare, a cuff lip), tapering to 0 over `length`
   * px of rest boundary arc (smoothstep). Recorded from the art (`deriveCutDetails`), bounded.
   */
  details?: { cut: string; end: 0 | 1; extra: number; length: number }[];
  /** The garment's own outline: rrggbbaa; default DEFAULT_GARMENT_STROKE. */
  stroke?: { color: string };
  /**
   * Template type (swag-rules/STYLE.md): "simple" (default: thin, hugs the body) or "medium" (bulky, padded:
   * a larger `margin`, thinner at the neckline ends and beside the underarm gaps, a low-passed outer
   * silhouette). Same cuts and core either way; `bulk` holds the medium construction's per-item settings.
   */
  template?: "simple" | "medium";
  bulk?: Partial<MediumBulk>;
  source?: Record<string, unknown>;
  /**
   * Seam-darkness check config (scripts/polish-seam-ink.py check --domain, not read by the importer):
   * the item's outline `ink` and its materials by nominal base colour. "dark" = a material whose own pattern is
   * dark line work (mail rings, lamellar/laminar plate rows): read in the default mode (luminance > 60); "plain"
   * (cloth, leather, lacquer) = read with the ink override, so near-black plain fabric is still measured.
   */
  seamCheck?: { ink?: [number, number, number]; materials: { name: string; rgb: [number, number, number]; pattern: "plain" | "dark" }[] };
}

/**
 * Medium template construction, canvas px. The full `margin` holds on the free outline; near a
 * neckline end the margin ramps from `neckMargin` (the simple margin: the collar corner stays a clean corner,
 * no step up into the neck) and beside each underarm fold apex from `gapMargin` (the arm/torso gap and the
 * armpit stay as open as on the simple template, in every pose), each over `*Ramp` px of rest arc
 * (smoothstep, after `gapArc` px held at `gapMargin`). Along the whole side of a protected gap the margin is
 * also capped by the rest clearance: the two outline centrelines stay strokeW + `gapVisible` apart (never
 * below gapMargin), and the ramped margin changes by at most `slope` px per px of arc. Then the outer outline
 * is low-passed (Taubin, `smoothIters`), each anchor kept within `smoothDev` of its ramped margin; it may only
 * grow where the margin is free (by the neck ramp's own fraction, never beside a gap).
 * Gates: `maxBumpPx` (silhouetteSmooth: the rest outline's largest deviation from a local quadratic fit over
 * +-BUMP_SIGMA px; the gambeson measures 0.68, the simple cloth 0.65, a 2 px one-vertex bump 1.13) and
 * `armGapMinPx` (armGapEveryFrame: the garment's arm/torso clearance in every 30 fps frame).
 */
export interface MediumBulk {
  neckMargin: number;
  neckRamp: number;
  gapMargin: number;
  gapArc: number;
  gapRamp: number;
  smoothIters: number;
  smoothDev: number;
  maxBumpPx: number;
  armGapMinPx: number;
  gapVisible: number;
  slope: number;
}
export const MEDIUM_BULK_DEFAULTS: MediumBulk = { neckMargin: 4.5, neckRamp: 30, gapMargin: 4.5, gapArc: 6, gapRamp: 40, smoothIters: 40, smoothDev: 2.5, maxBumpPx: 0.9, armGapMinPx: 2.5, gapVisible: 8, slope: 0.2 };
/** The medium settings of a domain (defaults filled in), or null for a simple-template domain. */
export function mediumBulk(domain: GarmentDomain): MediumBulk | null {
  return domain.template === "medium" ? { ...MEDIUM_BULK_DEFAULTS, ...(domain.bulk ?? {}) } : null;
}

/** Default garment outline: near-black, reads as a black line on dark fabric and on any ground. */
export const DEFAULT_GARMENT_STROKE = "1a1614ff";

export interface SkinData {
  slot: string;
  attachment: string;
  P: Pt[];
  T: number[];
  nT: number;
  groupOf: string[];
  /** Edges with one triangle (key ek(a, b)). */
  boundary: Set<number>;
  slotIndex: Map<string, number>;
  skin: any;
}

/**
 * Declared clearance taper (the underarm slit): across a declared protected gap, the margin of an
 * anchor is at most (rest clearance - GAP_CLEAR) / 2, where the clearance counts only boundary
 * points across the gap that fold back (rest arc > FOLD_RATIO x distance + 2), and it changes by at
 * most TAPER_SLOPE px per px of rest arc (a bounded, smooth taper; JOIN_TAPER = 1 / slope in d).
 */
export const GAP_CLEAR = 1.5;
/** Neckline end pieces drawn above the overlapping slot: points kept, prolongation (px). */
export const TUCK_POINTS = 3;
export const TUCK_EXTEND = 4;
/** contourGate: px past half the stroke width an inset (geometric) stroke may lie from the edges it strokes. */
export const INSET_GATE_TOL = 0.5;
/**
 * Bound on a bounded join's offset deviation: a join is where the offset is
 * miter-limited or reversed, so it may leave the nominal curve, but by at most half a game pixel.
 */
export const JOIN_DEV_MAX_GAME_PX = 0.5;
/** Construction: canvas px within which a cut point or a mesh corner counts as lying on an edge / the cut. */
export const ON_EDGE_EPS = 1e-6;
/** Outline smoothing: Laplacian half steps on the untapered margins, and their bounds in m. */
export const OUTLINE_SMOOTH_ITERS = 12;
export const OUTLINE_SMOOTH_MIN = 0.6;
export const OUTLINE_SMOOTH_MAX = 1.5;
/**
 * The declared wedge of a protected gap: only anchors within
 * this rest arc (canvas px) of the gap's apex (the partition at the bottom of the slit) are capped
 * by their clearance (0: the apex anchors only), then GAP_TAPER_SLOPE spreads the cap along the run.
 * Beyond it the full margin holds, so the sleeve underside keeps a constant margin in every pose
 * and, at rest, the sleeve overlaps the torso along the narrow slit (drawn over it, as in the art).
 */
export const GAP_WEDGE_ARC = 8;
/**
 * Slope of the gap taper (px of margin per px of rest arc). Steep: the rest arc beside the underarm
 * apex is compressed (the upper-arm underside is ~30 px at rest and ~120 px in a raise or flex), so a
 * gentle rest slope would taper the whole stretched underside.
 */
export const GAP_TAPER_SLOPE = 0.5;
export const TAPER_SLOPE = 0.25;
const FOLD_RATIO = 2;
export const JOIN_TAPER = 1 / TAPER_SLOPE;
/** A tapered margin below this (canvas px) is 0: the strip closes on the anchor (no sliver cell). */
export const D_MIN = 0.75;
/** Cut details: largest declared excursion, in margins m. */
export const DETAIL_MAX = 2;
/** Shortest rest distance to a tangent neighbour of an offset anchor (canvas px). */
const MIN_TANGENT = 2;
const ek = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const area2 = (a: Pt, b: Pt, c: Pt) => cross(sub(b, a), sub(c, a));

/** Distance between segments a0-a1 and b0-b1 (0 when they cross). */
function segSegDist(a0: Pt, a1: Pt, b0: Pt, b1: Pt): number {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a0, a1, b0);
  const d2 = o(a0, a1, b1);
  const d3 = o(b0, b1, a0);
  const d4 = o(b0, b1, a1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(a0, b0, b1), segDist(a1, b0, b1), segDist(b0, a0, a1), segDist(b1, a0, a1));
}

/** Distance from p to the segment s-e. */
function segDist(p: Pt, s: Pt, e: Pt): number {
  const v = sub(e, s);
  const l2 = v[0] * v[0] + v[1] * v[1] || 1;
  const u = Math.max(0, Math.min(1, ((p[0] - s[0]) * v[0] + (p[1] - s[1]) * v[1]) / l2));
  return Math.hypot(p[0] - s[0] - v[0] * u, p[1] - s[1] - v[1] * u);
}

function baryOf(p: Pt, a: Pt, b: Pt, c: Pt): [number, number, number] {
  const den = area2(a, b, c);
  const l0 = area2(p, b, c) / den;
  const l1 = area2(a, p, c) / den;
  return [l0, l1, 1 - l0 - l1];
}

export function skinData(raw: any, ref: { slot: string; attachment: string }): SkinData {
  const skinKey = Object.keys(raw.skins)[0] as string;
  const skin = raw.skins[skinKey].attachments[ref.slot]?.[ref.attachment];
  if (!skin || skin.type !== "mesh" || skin.embed) throw new Error(`no plain skin mesh ${ref.slot}/${ref.attachment}`);
  const P = bindPositions(raw, ref.slot, ref.attachment);
  const T = skin.triangles as number[];
  const nT = T.length / 3;
  const groupOf: string[] = new Array(nT).fill(ref.slot);
  for (const [g, ranges] of Object.entries((skin.groups ?? {}) as Record<string, [number, number][]>)) for (const [a, b] of ranges) for (let t = a; t < b; t++) groupOf[t] = g;
  const count = new Map<number, number>();
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const key = ek(T[t * 3 + k] as number, T[t * 3 + ((k + 1) % 3)] as number); count.set(key, (count.get(key) ?? 0) + 1); }
  const boundary = new Set([...count].filter(([, n]) => n === 1).map(([k]) => k));
  const slotIndex = new Map((raw.slots as any[]).map((s, i) => [s.name as string, i]));
  return { slot: ref.slot, attachment: ref.attachment, P, T, nT, groupOf, boundary, slotIndex, skin };
}

const triPts = (sd: SkinData, t: number): [Pt, Pt, Pt] => [sd.P[sd.T[t * 3] as number] as Pt, sd.P[sd.T[t * 3 + 1] as number] as Pt, sd.P[sd.T[t * 3 + 2] as number] as Pt];

/** Rest canvas position of a material point. */
export function materialRest(sd: { P: Pt[]; T: number[] }, mp: MaterialPoint): Pt {
  const [t, w0, w1] = mp;
  const a = sd.P[sd.T[t * 3] as number] as Pt;
  const b = sd.P[sd.T[t * 3 + 1] as number] as Pt;
  const c = sd.P[sd.T[t * 3 + 2] as number] as Pt;
  const w2 = 1 - w0 - w1;
  return [a[0] * w0 + b[0] * w1 + c[0] * w2, a[1] * w0 + b[1] * w1 + c[1] * w2];
}

/**
 * A longer hem: the domain with each hem cut moved `dy` canvas px down
 * the body's material. Every point is re-resolved on the cut's groups at its moved rest position; the
 * two ends are walked along the cut to the groups' boundary (outward while inside, inward while
 * outside), so the cut still crosses the body cleanly. Throws when a moved point leaves the groups.
 * Returns the moved domain and the old and new rest hem polylines (for the art edit).
 */
export function lengthenHemDomain(raw: any, domain: GarmentDomain, dy: number): { domain: GarmentDomain; hems: { from: Pt[]; to: Pt[] }[] } {
  return moveCutsDomain(raw, domain, (c) => (c.kind === "hem" ? dy : 0));
}

/**
 * Where a fitted garment's neckline sits: canvas px the neckline cut is
 * lowered from the art's top edge before the build (moveCutsDomain), so the runtime neckline stroke
 * sits a little lower on the neck with clean skin between the chin and the collar.
 */
export const NECKLINE_DROP = 4;

/** The domain with each neckline lowered by its own `drop` (default NECKLINE_DROP; see GarmentCut.drop). */
export function dropNecklines(raw: any, domain: GarmentDomain): GarmentDomain {
  return moveCutsDomain(raw, domain, (c) => (c.kind === "neckline" ? (c.drop ?? NECKLINE_DROP) : 0)).domain;
}

/** The domain with each cut moved `by(cut)` canvas px down the body's material (see lengthenHemDomain). */
export function moveCutsDomain(raw: any, domain: GarmentDomain, by: (cut: GarmentCut) => number): { domain: GarmentDomain; hems: { from: Pt[]; to: Pt[] }[] } {
  const sd = skinData(raw, domain.skin);
  const hems: { from: Pt[]; to: Pt[] }[] = [];
  const cuts = domain.cuts.map((c) => {
    const dy = by(c);
    if (!dy) return c;
    const from = c.points.map((mp) => materialRest(sd, mp));
    const pts = from.map((p) => [p[0], p[1] + dy] as Pt);
    const inside = (q: Pt) => materialAt(sd, q, c.groups) !== null;
    const edge = (end: Pt, inner: Pt): Pt => {
      const l = Math.hypot(end[0] - inner[0], end[1] - inner[1]) || 1;
      const u: Pt = [(end[0] - inner[0]) / l, (end[1] - inner[1]) / l];
      const at = (s: number): Pt => [end[0] + u[0] * s, end[1] + u[1] * s];
      if (inside(end)) { let s = 0; while (s < 80 && inside(at(s + 0.25))) s += 0.25; return at(s); }
      for (let s = 0.25; s < 80; s += 0.25) if (inside(at(-s))) return at(-s);
      throw new Error(`moveCuts: ${c.name} end ${end.map((v) => v.toFixed(1))} finds no body material`);
    };
    const n = pts.length;
    pts[0] = edge(pts[0] as Pt, pts[Math.min(3, n - 1)] as Pt);
    pts[n - 1] = edge(pts[n - 1] as Pt, pts[Math.max(0, n - 4)] as Pt);
    const points = pts.map((p) => {
      const mp = materialAt(sd, p, c.groups);
      if (!mp) throw new Error(`moveCuts: ${c.name} point ${p.map((v) => v.toFixed(1))} leaves ${c.groups.join(",")}`);
      return mp;
    });
    hems.push({ from, to: pts });
    return { ...c, points };
  });
  return { domain: { ...domain, cuts }, hems };
}

/** Rest canvas position of a material point of the domain's skin. */
export function materialRestOf(raw: any, domain: GarmentDomain, mp: MaterialPoint): Pt {
  return materialRest(skinData(raw, domain.skin), mp);
}

/** The material point at rest position p on the topmost (draw order) triangle of `groups`, or null. */
export function materialAt(sd: SkinData, p: Pt, groups: readonly string[]): MaterialPoint | null {
  let best: MaterialPoint | null = null;
  let bestOrder = -1;
  for (let t = 0; t < sd.nT; t++) {
    if (!groups.includes(sd.groupOf[t] as string)) continue;
    const [a, b, c] = triPts(sd, t);
    const l = baryOf(p, a, b, c);
    if (Math.min(...l) < -1e-9) continue;
    const order = sd.slotIndex.get(sd.groupOf[t] as string) ?? 0;
    if (order > bestOrder) {
      bestOrder = order;
      const w0 = Math.max(0, l[0]);
      const w1 = Math.max(0, l[1]);
      const w2 = Math.max(0, l[2]);
      const s = w0 + w1 + w2;
      best = [t, Number((w0 / s).toFixed(9)), Number((w1 / s).toFixed(9))];
    }
  }
  return best;
}

/**
 * Records a garment domain from art aligned with the rest pose (pixel for pixel with the canvas):
 * cuts = the art's outline where it runs inside the body (at least `deep` px from the body edge),
 * smoothed, extended along its end tangents to the body boundary of the groups it lies on; covered
 * groups = groups under at least 200 art px; one seed per group (its deepest art pixel); gaps = the
 * trunk (the skin's slot) against each limb side (groups by `_r` suffix); margin = the median
 * distance of the art's outer edge past the body art's silhouette (`base`), else 4.
 */
export function deriveDomainFromArt(raw: any, art: RgbaImage, opts: { name: string; skin: { slot: string; attachment: string }; base?: RgbaImage; deep?: number; artPath?: string }): GarmentDomain {
  const sd = skinData(raw, opts.skin);
  const W = raw.canvas.width as number;
  const H = raw.canvas.height as number;
  if (art.width !== W || art.height !== H) throw new Error(`art ${art.width}x${art.height} is not aligned with the rig canvas ${W}x${H}`);
  const deep = opts.deep ?? 4;
  const topGroup = new Int16Array(W * H).fill(-1);
  const groupNames = [...new Set(sd.groupOf)];
  const union = new Uint8Array(W * H);
  for (let t = 0; t < sd.nT; t++) {
    const [a, b, c] = triPts(sd, t);
    const g = groupNames.indexOf(sd.groupOf[t] as string);
    const order = sd.slotIndex.get(sd.groupOf[t] as string) ?? 0;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.min(...baryOf([x + 0.5, y + 0.5], a, b, c)) < 0) continue;
      const i = y * W + x;
      union[i] = 1;
      const cur = topGroup[i] as number;
      if (cur < 0 || order > (sd.slotIndex.get(groupNames[cur] as string) ?? 0)) topGroup[i] = g;
    }
  }
  const A = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) A[i] = (art.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
  const perGroup = new Map<string, number>();
  for (let i = 0; i < W * H; i++) if (A[i] && (topGroup[i] as number) >= 0) perGroup.set(groupNames[topGroup[i] as number] as string, (perGroup.get(groupNames[topGroup[i] as number] as string) ?? 0) + 1);
  const groups = groupNames.filter((g) => (perGroup.get(g) ?? 0) >= 200);
  const inside = distInside(union, W, H);
  const at = (p: Pt) => Math.round(p[1] - 0.5) * W + Math.round(p[0] - 0.5);
  const isIn = (p: Pt, gs: readonly string[]) => {
    for (let t = 0; t < sd.nT; t++) {
      if (!gs.includes(sd.groupOf[t] as string)) continue;
      const [a, b, c] = triPts(sd, t);
      if (Math.min(...baryOf(p, a, b, c)) >= 0) return true;
    }
    return false;
  };
  const trunk = sd.slot;
  const trunkY = (() => {
    let s = 0;
    let n = 0;
    for (let t = 0; t < sd.nT; t++) if (sd.groupOf[t] === trunk) for (const p of triPts(sd, t)) { s += p[1]; n++; }
    return n ? s / n : 0;
  })();
  const cuts: GarmentCut[] = [];
  for (const loop of traceLoops(A, W, H)) {
    const sm = smoothLoop(loop, 2, 2, 5000);
    const n = sm.length;
    const deepAt = sm.map((p) => (inside[at(p)] as number) >= deep);
    if (deepAt.every(Boolean) || !deepAt.some(Boolean)) continue;
    const s0 = deepAt.findIndex((x, i) => !x && deepAt[(i + 1) % n]);
    let run: Pt[] = [];
    const runs: Pt[][] = [];
    for (let j = 1; j <= n; j++) {
      const q = (s0 + j) % n;
      if (deepAt[q]) run.push(sm[q] as Pt);
      else if (run.length) { runs.push(run); run = []; }
    }
    for (const r of runs) {
      if (r.length < 8) continue;
      const pts = r.filter((_, i) => i % 3 === 0 || i === r.length - 1);
      const votes = new Map<string, number>();
      for (const p of pts) { const g = groupNames[topGroup[at(p)] as number]; if (g && groups.includes(g)) votes.set(g, (votes.get(g) ?? 0) + 1); }
      const cutGroups = [...votes.keys()];
      const main = [...votes].sort((x, y) => y[1] - x[1])[0]?.[0];
      if (!main) continue;
      const extend = (end: Pt, from: Pt): Pt => {
        const d = sub(end, from);
        const l = Math.hypot(d[0], d[1]) || 1;
        let last: Pt = end;
        for (let s = 0.25; s < 80; s += 0.25) {
          const q: Pt = [end[0] + (d[0] / l) * s, end[1] + (d[1] / l) * s];
          if (!isIn(q, cutGroups)) break;
          last = q;
        }
        return last;
      };
      const ends: [Pt, Pt] = [extend(pts[0] as Pt, pts[Math.min(3, pts.length - 1)] as Pt), extend(pts[pts.length - 1] as Pt, pts[Math.max(0, pts.length - 4)] as Pt)];
      const poly = [ends[0], ...pts, ends[1]];
      const mps = poly.map((p) => materialAt(sd, p, cutGroups)).filter((x): x is MaterialPoint => x !== null);
      const meanY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const kind: GarmentCut["kind"] = main === trunk ? (meanY < trunkY ? "neckline" : "hem") : "cuff";
      cuts.push({ name: kind === "cuff" ? `cuff_${main}` : kind, kind, groups: cutGroups, points: mps });
    }
  }
  const seeds: GarmentDomain["seeds"] = [];
  for (const g of groups) {
    const gi = groupNames.indexOf(g);
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = A[i] && topGroup[i] === gi ? 1 : 0;
    const di = distInside(m, W, H);
    let best = -1;
    for (let i = 0; i < W * H; i++) if (m[i] && (best < 0 || (di[i] as number) > (di[best] as number))) best = i;
    const mp = best >= 0 ? materialAt(sd, [(best % W) + 0.5, Math.floor(best / W) + 0.5], [g]) : null;
    if (mp) seeds.push({ group: g, point: mp });
  }
  const limbs = groups.filter((g) => g !== trunk);
  const gaps = [
    { name: "underarm", a: [trunk], b: limbs.filter((g) => !g.endsWith("_r")) },
    { name: "underarm_r", a: [trunk], b: limbs.filter((g) => g.endsWith("_r")) }
  ].filter((g) => groups.includes(trunk) && g.b.length);
  let margin = 4;
  const source: Record<string, unknown> = { art: opts.artPath ?? null, deepPx: deep };
  if (opts.base) {
    const bodyOut = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bodyOut[i] = (opts.base.data[i * 4 + 3] as number) >= 128 ? 0 : 1;
    const dOut = distInside(bodyOut, W, H);
    const ds: number[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!A[i] || !bodyOut[i] || (A[i - 1] && A[i + 1] && A[i - W] && A[i + W])) continue;
      ds.push(dOut[i] as number);
    }
    ds.sort((a, b) => a - b);
    if (ds.length) margin = Math.max(0, Math.round(((ds[Math.floor(ds.length / 2)] as number) - 1) * 2) / 2);
    source.artEdgePastBodyArtPx = { samples: ds.length, p50: ds[Math.floor(ds.length / 2)] ?? null, p90: ds[Math.floor(ds.length * 0.9)] ?? null };
  }
  return { format: "atlas-garment-domain/1", name: opts.name, skin: opts.skin, groups, cuts, seeds, gaps, margin, stroke: { color: DEFAULT_GARMENT_STROKE }, source };
}

export interface GarmentBuildOptions {
  name: string;
  /** Overrides the domain's margin (0: the zero-margin control, core only). */
  margin?: number;
  strokeWidth?: number;
  strokeColor?: string;
  /** Body stroke width w_b (default the stroke width): d = m + (w_b - w_g) / 2. */
  bodyStrokeWidth?: number;
  /** Flat fabric colour (pass 1). */
  fabric?: [number, number, number];
  /** Slots the garment hides (draw position of the trunk group after them). */
  hides?: readonly string[];
  /** No outline contours (the zero-margin control). */
  noStrokes?: boolean;
}

export interface GarmentRun {
  anchors: number[];
  outer: number[];
  cyclic: boolean;
  d: number;
  /** Offset per anchor (d, tapered to 0 at declared concave joins). */
  dAt: number[];
  /** Body group of the cell after each anchor (cells.length = anchors.length - 1, or = for cyclic). */
  cellGroup: string[];
}

export interface GarmentBuild {
  ownerSlot: string;
  attachment: any;
  slots: { name: string; after: string; bone: string }[];
  contours: Record<string, Record<string, any>>;
  texture: RgbaImage;
  origin: Pt;
  runs: GarmentRun[];
  /** Per garment triangle: parent body triangle (core) or -1 (strip). */
  parent: Int32Array;
  /** Boundary edges of unstroked cuts (cutStroked false): the art's painted edge ink stays there. */
  paintedEdges: [number, number][];
  /** Stroked cuts drawn inside the garment (cutInset > 0): their boundary edges and the stroke's points. */
  insetCuts: { edges: [number, number][]; points: ContourPoint[] }[];
  report: Record<string, unknown>;
}

/** Builds the garment surface for a declared domain (see the file comment). */
export function buildGarmentSurface(raw: any, domain: GarmentDomain, opts: GarmentBuildOptions): GarmentBuild {
  const sd = skinData(raw, domain.skin);
  const { P, T, nT } = sd;
  const name = opts.name;
  const m = opts.margin ?? domain.margin;
  const strokeW = opts.strokeWidth ?? 10;
  const d = m + ((opts.bodyStrokeWidth ?? strokeW) - strokeW) / 2;
  const inDomain = (t: number) => domain.groups.includes(sd.groupOf[t] as string);

  // --- cut polylines at rest (ends pushed 3 px past the boundary so they cross it cleanly)
  const cutPolys = domain.cuts.map((c) => {
    const pts = c.points.map((mp) => materialRest(sd, mp));
    const push = (e: Pt, f: Pt): Pt => { const v = sub(e, f); const l = Math.hypot(v[0], v[1]) || 1; return [e[0] + (v[0] / l) * 3, e[1] + (v[1] / l) * 3]; };
    if (pts.length >= 2) {
      pts[0] = push(pts[0] as Pt, pts[1] as Pt);
      pts[pts.length - 1] = push(pts[pts.length - 1] as Pt, pts[pts.length - 2] as Pt);
    }
    return { cut: c, pts };
  });

  // --- global vertices: key -> index; position; binding
  type Vtx = { p: Pt; bind: number | [number, number, number, number, number] };
  const V: Vtx[] = [];
  const index = new Map<string, number>();
  const vtx = (key: string, make: () => Vtx) => {
    let i = index.get(key);
    if (i === undefined) { i = V.length; V.push(make()); index.set(key, i); }
    return i;
  };
  const corner = (v: number) => vtx(`v${v}`, () => ({ p: P[v] as Pt, bind: v }));
  const children: { tri: [number, number, number]; parent: number }[] = [];
  const blocked = new Set<string>();
  const blockedCut = new Map<string, number>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  let subdivided = 0;
  for (let t = 0; t < nT; t++) {
    if (!inDomain(t)) continue;
    const tv = [T[t * 3] as number, T[t * 3 + 1] as number, T[t * 3 + 2] as number];
    const tp = tv.map((v) => P[v] as Pt) as [Pt, Pt, Pt];
    const local: number[] = tv.map(corner);
    const onEdge: { s: number; v: number }[][] = [[], [], []];
    const cons: [number, number][] = [];
    let touched = false;
    cutPolys.forEach(({ cut, pts }, ci) => {
      if (!cut.groups.includes(sd.groupOf[t] as string)) return;
      for (let si = 0; si + 1 < pts.length; si++) {
        const a = pts[si] as Pt;
        const b = pts[si + 1] as Pt;
        const along: { u: number; v: number }[] = [];
        const r = sub(b, a);
        const rl2 = r[0] * r[0] + r[1] * r[1];
        // triangle corners on the cut (a cut through a vertex or along an edge reuses the vertex)
        for (let k = 0; k < 3; k++) {
          const q = tp[k] as Pt;
          const u = rl2 > 0 ? ((q[0] - a[0]) * r[0] + (q[1] - a[1]) * r[1]) / rl2 : 0;
          if (u >= -1e-9 && u <= 1 + 1e-9 && segDist(q, a, b) < ON_EDGE_EPS) along.push({ u, v: local[k] as number });
        }
        // proper crossings of the triangle's edges (at neither the edge's nor the cut segment's ends)
        for (let k = 0; k < 3; k++) {
          const e0 = tv[k] as number;
          const e1 = tv[(k + 1) % 3] as number;
          const lo = Math.min(e0, e1);
          const hi = Math.max(e0, e1);
          const p0 = P[lo] as Pt;
          const p1 = P[hi] as Pt;
          const s = sub(p1, p0);
          const den = cross(r, s);
          if (Math.abs(den) < 1e-12) continue; // parallel: an overlap is found through the corners and cut points
          const u = cross(sub(p0, a), s) / den;
          const w = cross(sub(p0, a), r) / den;
          if (u <= 1e-9 || u >= 1 - 1e-9 || w <= 1e-9 || w >= 1 - 1e-9) continue;
          if (segDist(p0, a, b) < ON_EDGE_EPS || segDist(p1, a, b) < ON_EDGE_EPS) continue; // at a corner (above)
          const gi = vtx(`e${lo}:${hi}:${ci}:${si}`, () => ({ p: [p0[0] + s[0] * w, p0[1] + s[1] * w], bind: [lo, hi, tv.find((q) => q !== lo && q !== hi) as number, Number((1 - w).toFixed(12)), Number(w.toFixed(12))] }));
          onEdge[k]?.push({ s: e0 === lo ? w : 1 - w, v: gi });
          along.push({ u, v: gi });
        }
        // the cut's own points: inside the triangle, or on one of its edges (a vertex splitting that
        // edge, shared with the neighbour through its key); a point on a corner is that corner
        for (const [u, p, key] of [[0, a, `c${ci}:${si}`], [1, b, `c${ci}:${si + 1}`]] as const) {
          const l = baryOf(p, tp[0], tp[1], tp[2]);
          if (Math.min(...l) < -1e-9) continue;
          if (tp.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < ON_EDGE_EPS)) continue;
          const v = vtx(key, () => ({ p, bind: [tv[0] as number, tv[1] as number, tv[2] as number, Number(l[0].toFixed(12)), Number(l[1].toFixed(12))] }));
          const k = [0, 1, 2].find((k) => segDist(p, tp[k] as Pt, tp[(k + 1) % 3] as Pt) < ON_EDGE_EPS);
          if (k !== undefined) {
            const e0 = tp[k] as Pt;
            const e1 = tp[(k + 1) % 3] as Pt;
            onEdge[k]?.push({ s: Math.hypot(p[0] - e0[0], p[1] - e0[1]) / (Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) || 1), v });
          }
          along.push({ u, v });
        }
        along.sort((x, y) => x.u - y.u);
        for (let k = 0; k + 1 < along.length; k++) {
          const x = along[k] as { u: number; v: number };
          const y = along[k + 1] as { u: number; v: number };
          const mid: Pt = [((V[x.v] as Vtx).p[0] + (V[y.v] as Vtx).p[0]) / 2, ((V[x.v] as Vtx).p[1] + (V[y.v] as Vtx).p[1]) / 2];
          // a piece inside the triangle or along one of its edges (a cut coincident with a mesh edge)
          if (x.v === y.v || Math.min(...baryOf(mid, tp[0], tp[1], tp[2])) < -1e-9) continue;
          cons.push([x.v, y.v]);
          blocked.add(edgeKey(x.v, y.v));
          blockedCut.set(edgeKey(x.v, y.v), ci);
          touched = true;
        }
      }
    });
    if (!touched) { children.push({ tri: local as [number, number, number], parent: t }); continue; }
    subdivided++;
    const ids = [...local];
    const loc = (g: number) => { let i = ids.indexOf(g); if (i < 0) { i = ids.length; ids.push(g); } return i; };
    const edges: [number, number][] = [];
    for (let k = 0; k < 3; k++) {
      const chain = [local[k] as number, ...(onEdge[k] as { s: number; v: number }[]).sort((x, y) => x.s - y.s).map((e) => e.v), local[(k + 1) % 3] as number];
      for (let j = 0; j + 1 < chain.length; j++) edges.push([loc(chain[j] as number), loc(chain[j + 1] as number)]);
    }
    for (const [x, y] of cons) edges.push([loc(x), loc(y)]);
    const seen = new Set<string>();
    const uniq = edges.filter(([x, y]) => { const key = x < y ? `${x}:${y}` : `${y}:${x}`; if (x === y || seen.has(key)) return false; seen.add(key); return true; });
    const tris = cdt2d(ids.map((g) => (V[g] as Vtx).p), uniq, { exterior: false }) as [number, number, number][];
    for (const tr of tris) {
      const g = tr.map((i) => ids[i] as number) as [number, number, number];
      if (Math.abs(area2((V[g[0]] as Vtx).p, (V[g[1]] as Vtx).p, (V[g[2]] as Vtx).p)) < 1e-9) continue;
      children.push({ tri: g, parent: t });
    }
  }
  // every declared cut must leave at least one blocking piece (a cut is never silently dropped)
  const dropped = domain.cuts.filter((_, ci) => ![...blockedCut.values()].includes(ci)).map((c) => c.name);
  if (dropped.length) throw new Error(`garment domain: cut ${dropped.join(", ")} blocks no edge of its groups`);
  // consistent winding (positive in canvas coordinates)
  for (const c of children) if (area2((V[c.tri[0]] as Vtx).p, (V[c.tri[1]] as Vtx).p, (V[c.tri[2]] as Vtx).p) < 0) c.tri = [c.tri[0], c.tri[2], c.tri[1]];

  // --- covered domain: flood from the seeds over edges that are not cut pieces
  const byEdge = new Map<string, number[]>();
  children.forEach((c, i) => { for (let k = 0; k < 3; k++) { const key = edgeKey(c.tri[k] as number, c.tri[(k + 1) % 3] as number); const l = byEdge.get(key) ?? []; l.push(i); byEdge.set(key, l); } });
  const covered = new Uint8Array(children.length);
  const missingSeeds: string[] = [];
  for (const seed of domain.seeds) {
    const p = materialRest(sd, seed.point);
    const start = children.findIndex((c) => sd.groupOf[c.parent] === seed.group && Math.min(...baryOf(p, (V[c.tri[0]] as Vtx).p, (V[c.tri[1]] as Vtx).p, (V[c.tri[2]] as Vtx).p)) >= -1e-9);
    if (start < 0) { missingSeeds.push(seed.group); continue; }
    const stack = [start];
    covered[start] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      const c = children[i] as (typeof children)[number];
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(c.tri[k] as number, c.tri[(k + 1) % 3] as number);
        if (blocked.has(key)) continue;
        for (const j of byEdge.get(key) ?? []) if (!covered[j]) { covered[j] = 1; stack.push(j); }
      }
    }
  }
  if (missingSeeds.length) throw new Error(`garment domain: seeds of ${missingSeeds.join(", ")} lie on no covered triangle`);
  // a cut must separate: every cut piece has exactly one covered side
  let leaks = 0;
  for (const key of blocked) { const s = (byEdge.get(key) ?? []).filter((j) => covered[j]).length; if (s !== 1 && (byEdge.get(key) ?? []).length === 2) leaks++; }
  if (leaks) throw new Error(`garment domain: ${leaks} cut pieces have both sides covered (a cut does not cross its groups)`);
  const core = children.filter((_, i) => covered[i]);

  // --- core boundary: directed edges (core on the left in canvas winding), typed body / cut
  const coreEdges = new Map<string, number>();
  for (const c of core) for (let k = 0; k < 3; k++) { const key = edgeKey(c.tri[k] as number, c.tri[(k + 1) % 3] as number); coreEdges.set(key, (coreEdges.get(key) ?? 0) + 1); }
  const nextOf = new Map<number, { to: number; body: boolean; group: string; third: number }>();
  const bodyEdgeOf = (a: number, b: number) => {
    // a body-boundary edge: both ends on one body boundary edge (a corner or a point on it)
    const ends = (v: number): [number, number] | [number] => { const bnd = (V[v] as Vtx).bind; return typeof bnd === "number" ? [bnd] : [bnd[0], bnd[1]]; };
    const ea = ends(a);
    const eb = ends(b);
    const vs = [...new Set([...ea, ...eb])];
    if (vs.length !== 2) return false;
    if (ea.length === 2 && eb.length === 2 && (ea[0] !== eb[0] || ea[1] !== eb[1])) return false;
    return sd.boundary.has(ek(vs[0] as number, vs[1] as number));
  };
  for (const c of core) for (let k = 0; k < 3; k++) {
    const a = c.tri[k] as number;
    const b = c.tri[(k + 1) % 3] as number;
    if (coreEdges.get(edgeKey(a, b)) !== 1) continue;
    nextOf.set(a, { to: b, body: !blocked.has(edgeKey(a, b)) && bodyEdgeOf(a, b), group: sd.groupOf[c.parent] as string, third: c.tri[(k + 2) % 3] as number });
  }
  const loops: { v: number; to: number; body: boolean; group: string; third: number }[][] = [];
  const seen = new Set<number>();
  for (const s of nextOf.keys()) {
    if (seen.has(s)) continue;
    const loop: { v: number; to: number; body: boolean; group: string; third: number }[] = [];
    let cur = s;
    while (!seen.has(cur)) {
      seen.add(cur);
      const e = nextOf.get(cur);
      if (!e) break;
      loop.push({ v: cur, ...e });
      cur = e.to;
    }
    loops.push(loop);
  }
  // end caps: a body-boundary edge shorter than MIN_TANGENT at a run end (a cut crossing the body
  // boundary next to a body vertex) joins the cut chain, so the run starts at a real edge and the
  // sliver gets the cut's stroke instead of a degenerate strip cell
  const capped = new Set<string>();
  const elen = (e: { v: number; to: number }) => Math.hypot(...sub((V[e.to] as Vtx).p, (V[e.v] as Vtx).p));
  for (const loop of loops) {
    const n = loop.length;
    if (loop.every((e) => e.body)) continue;
    let changed = true;
    while (changed) {
      changed = false;
      loop.forEach((e, i) => {
        if (!e.body) return;
        const prev = loop[(i - 1 + n) % n] as (typeof loop)[number];
        const next = loop[(i + 1) % n] as (typeof loop)[number];
        const atStart = !prev.body && next.body;
        const atEnd = !next.body && prev.body;
        if ((atStart || atEnd) && elen(e) < MIN_TANGENT) { e.body = false; capped.add(edgeKey(e.v, e.to)); changed = true; }
      });
    }
  }
  const unknownEdges = loops.flat().filter((e) => !e.body && !blocked.has(edgeKey(e.v, e.to)) && !capped.has(edgeKey(e.v, e.to))).length;

  // --- margin strip per run of body-boundary edges
  const runs: GarmentRun[] = [];
  const stripTris: { tri: [number, number, number]; group: string }[] = [];
  const offsets: { v: number; a: number; p: number; n: number; d: number }[] = [];
  let boundedJoinsAtRest = 0;
  let taperedAnchors = 0;
  const nbOf = new Map<GarmentRun, (i: number) => [number, number]>();
  // the run's offset points exactly as the runtime poses them (core/skinning.ts computeOffsetPoints:
  // miter points, folded cells joined into clips); anchors with |d| < D_MIN close on the anchor and
  // break the chain (no strip cell links them, as in the runtime's triangle-derived chains)
  const runOffsets = (pos: Float64Array, run: GarmentRun, dAt: number[]): { pts: Pt[]; flags: number[] } => {
    const k = run.anchors.length;
    const nb = nbOf.get(run) as (i: number) => [number, number];
    const live = dAt.map((x) => Math.abs(x) >= D_MIN);
    const idx = dAt.map(() => -1);
    const refs: number[] = [];
    const dist: number[] = [];
    for (let i = 0; i < k; i++) if (live[i]) { idx[i] = dist.length; const [pp, nn] = nb(i); refs.push(run.anchors[i] as number, pp, nn); dist.push(dAt[i] as number); }
    const next = new Int32Array(dist.length).fill(-1);
    for (let i = 0; i < k; i++) { const j = run.cyclic ? (i + 1) % k : i + 1; if (j < k && j !== i && (idx[i] as number) >= 0 && (idx[j] as number) >= 0) next[idx[i] as number] = idx[j] as number; }
    const out = new Float64Array(dist.length * 2);
    const fl = new Uint8Array(dist.length);
    computeOffsetPoints(pos, refs, dist, offsetChainsFromNext(next), out, fl);
    const pts = run.anchors.map((a, i): Pt => { const e = idx[i] as number; return e < 0 ? [pos[a * 2] as number, pos[a * 2 + 1] as number] : [out[e * 2] as number, out[e * 2 + 1] as number]; });
    return { pts, flags: idx.map((e) => (e < 0 ? 0 : (fl[e] as number))) };
  };
  const runArc = new Map<GarmentRun, number[]>();
  // cut details: the rest end points of each cut (its first / last point), matched to run ends
  const cutEnds = domain.cuts.map((c) => [materialRest(sd, c.points[0] as MaterialPoint), materialRest(sd, c.points[c.points.length - 1] as MaterialPoint)] as [Pt, Pt]);
  const detailAt = (run: GarmentRun, arc: number[], i: number) => {
    let x = 0;
    const k = run.anchors.length;
    if (run.cyclic) return 0;
    for (const det of domain.details ?? []) {
      const ci = domain.cuts.findIndex((c) => c.name === det.cut);
      if (ci < 0) throw new Error(`garment domain: detail of unknown cut ${det.cut}`);
      const end = (cutEnds[ci] as [Pt, Pt])[det.end];
      for (const [j, s0] of [[0, 0], [k - 1, arc[k - 1] as number]] as const) {
        if (Math.hypot(...sub((V[run.anchors[j] as number] as Vtx).p, end)) > 8) continue;
        const u = Math.max(0, 1 - Math.abs((arc[i] as number) - s0) / det.length);
        x = Math.max(x, Math.min(DETAIL_MAX * Math.max(m, 1), det.extra) * u * u * (3 - 2 * u));
      }
    }
    return x;
  };
  const taperReport = { anchors: 0, minD: Infinity as number, gaps: [] as string[] };
  // medium template (see MediumBulk): neckline-end and underarm-apex ramps, then a bounded low-pass
  const bulk = mediumBulk(domain);
  const foldApexes: { run: GarmentRun; s: number }[] = [];
  /** Rest clearance across a protected gap per run anchor (clearanceTaper's fold-aware pairs; Infinity: off the gap). */
  const gapClearAt = new Map<GarmentRun, number[]>();
  /** Medium: how much of smoothDev the low-pass may ADD per anchor (1 free outline, the neck ramp's own fraction, 0 beside a gap). */
  const bulkGrow = new Map<GarmentRun, number[]>();
  const smoothstep = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };
  const neckEnds = (run: GarmentRun): number[] => {
    if (run.cyclic) return [];
    const arc = runArc.get(run) as number[];
    const k = run.anchors.length;
    return ([0, k - 1] as const).filter((j) => domain.cuts.some((c, ci) => c.kind === "neckline" && (cutEnds[ci] as [Pt, Pt]).some((e) => Math.hypot(...sub((V[run.anchors[j] as number] as Vtx).p, e)) <= 10))).map((j) => arc[j] as number);
  };
  const apexDist = (run: GarmentRun, s: number) => Math.min(Infinity, ...foldApexes.filter((x) => x.run === run).map((x) => Math.abs(x.s - s)));
  const bulkReport = { neckEnds: 0, foldApexes: 0, cappedAnchors: 0, smoothShiftMax: 0 };
  const bulkCaps = () => {
    const b = bulk as MediumBulk;
    const full = Math.abs(d);
    for (const run of runs) {
      const arc = runArc.get(run) as number[];
      const necks = neckEnds(run);
      bulkReport.neckEnds += necks.length;
      const grow: number[] = [];
      bulkGrow.set(run, grow);
      run.dAt = run.dAt.map((x, i) => {
        const s = arc[i] as number;
        let cap = Infinity;
        let g = 1;
        for (const s0 of necks) { const u = smoothstep(Math.abs(s - s0) / b.neckRamp); cap = Math.min(cap, b.neckMargin + (full - b.neckMargin) * u); g = Math.min(g, u); }
        const sa = apexDist(run, s);
        if (Number.isFinite(sa)) { cap = Math.min(cap, b.gapMargin + (full - b.gapMargin) * smoothstep((sa - b.gapArc) / b.gapRamp)); if (sa < b.gapArc + b.gapRamp) g = 0; }
        // along the whole gap side: never thinner than gapMargin there, and where the rest clearance allows, the
        // two outline centrelines keep strokeW + gapVisible apart (gapVisible px of open wedge between the inks)
        const c = gapClearAt.get(run)?.[i] ?? Infinity;
        if (Number.isFinite(c)) { const cc = Math.max(b.gapMargin, (c - strokeW - b.gapVisible) / 2); if (cc < full) g = 0; cap = Math.min(cap, cc); }
        grow.push(g);
        if (cap < Math.abs(x)) { bulkReport.cappedAnchors++; return Math.sign(x || run.d) * cap; }
        return x;
      });
    }
    // bounded slope of the ramped margin along each run (no jog where a cap changes fast between anchors); the
    // clearance taper's own values below gapMargin at the apex are not spread (the simple template's slope holds there)
    for (const run of runs) {
      const arc = runArc.get(run) as number[];
      const r0 = run.dAt.map(Math.abs);
      run.dAt = r0.map((di, i) => Math.sign(run.d) * Math.min(di, ...r0.map((dj, j) => Math.max(dj, b.gapMargin) + b.slope * Math.abs((arc[i] as number) - (arc[j] as number)))));
    }
    bulkReport.foldApexes = foldApexes.length;
  };
  // declared clearance taper across each protected gap (see GAP_CLEAR); rest geometry, all runs
  const clearanceTaper = () => {
    const pts: { run: GarmentRun; i: number; p: Pt; s: number; sides: string[] }[] = [];
    for (const run of runs) {
      const arc = runArc.get(run) as number[];
      const nc = run.cellGroup.length;
      run.anchors.forEach((v, i) => {
        const sides = [run.cellGroup[Math.min(i, nc - 1)], i > 0 ? run.cellGroup[i - 1] : run.cyclic ? run.cellGroup[nc - 1] : undefined].filter((g): g is string => !!g);
        pts.push({ run, i, p: (V[v] as Vtx).p, s: arc[i] as number, sides });
      });
    }
    for (const gap of domain.gaps) {
      const onA = pts.filter((x) => x.sides.some((g) => gap.a.includes(g)));
      const onB = pts.filter((x) => x.sides.some((g) => gap.b.includes(g)));
      let hit = 0;
      const clear = new Map<(typeof pts)[number], number>();
      for (const [P, Q] of [[onA, onB], [onB, onA]] as const) for (const x of P) {
        let c = clear.get(x) ?? Infinity;
        for (const y of Q) {
          if (y === x) continue;
          const dist = Math.hypot(...sub(x.p, y.p));
          if (x.run === y.run && Math.abs(x.s - y.s) <= FOLD_RATIO * dist + 2) continue; // along the boundary, not across the gap
          c = Math.min(c, dist);
        }
        clear.set(x, c);
      }
      // the fold apex (an anchor on both sides: the partition at the bottom of the slit) has no
      // partner across the gap; it takes its run neighbours' clearance (a shoulder-top partition,
      // whose neighbours face no fold, keeps its margin)
      const apexes = pts.filter((x) => onA.includes(x) && onB.includes(x));
      const nbr = (x: (typeof pts)[number], k: number) => pts.find((y) => y.run === x.run && y.i === x.i + k);
      for (const x of apexes) {
        const c = Math.min(clear.get(x) ?? Infinity, ...[-1, 1].map((k) => { const y = nbr(x, k); return y ? (clear.get(y) ?? Infinity) : Infinity; }));
        // a fold apex facing a fold (finite clearance) closes on the body (margin 0): the cell across
        // the partition joins the arm and the torso, whose anchors part in a raise, so a margin there
        // folds the cell over
        // (only across a narrow slit, one that cannot hold both margins: a shoulder-top partition
        // faces open space far off and keeps its margin; it had closed into a notch)
        clear.set(x, c < 2 * d + 1 + GAP_CLEAR ? 0 : c);
      }
      const apexArc = (x: (typeof pts)[number]) => Math.min(Infinity, ...apexes.filter((y) => y.run === x.run).map((y) => Math.abs(y.s - x.s)));
      for (const [x, c] of clear) {
        if (apexArc(x) > GAP_WEDGE_ARC) continue; // outside the declared wedge: full margin (overlap allowed)
        const cap = Math.max(0, (c - GAP_CLEAR) / 2);
        if (cap < Math.abs(x.run.dAt[x.i] as number)) { x.run.dAt[x.i] = Math.sign(x.run.d) * cap; hit++; }
      }
      if (hit) taperReport.gaps.push(gap.name);
      for (const x of apexes) if (clear.get(x) === 0) foldApexes.push({ run: x.run, s: x.s });
      for (const [x, c] of clear) { const l = gapClearAt.get(x.run) ?? gapClearAt.set(x.run, x.run.anchors.map(() => Infinity)).get(x.run) as number[]; l[x.i] = Math.min(l[x.i] as number, c); }
    }
    if (bulk) bulkCaps();
    // bounded slope along each run
    for (const run of runs) {
      const arc = runArc.get(run) as number[];
      const raw0 = run.dAt.map(Math.abs);
      run.dAt = raw0.map((_, i) => Math.sign(run.d) * Math.min(...raw0.map((dj, j) => dj + GAP_TAPER_SLOPE * Math.abs((arc[i] as number) - (arc[j] as number)))));
      run.dAt.forEach((x) => { if (Math.abs(x) < d - 1e-9) { taperReport.anchors++; taperReport.minD = Math.min(taperReport.minD, Math.abs(x)); } });
    }
  };
  for (const loop of loops) {
    const n = loop.length;
    const allBody = loop.every((e) => e.body);
    const starts = allBody ? [0] : loop.flatMap((e, i) => (e.body && !(loop[(i - 1 + n) % n] as { body: boolean }).body ? [i] : []));
    for (const s of starts) {
      const edges: typeof loop = [];
      for (let j = 0; j < n; j++) { const e = loop[(s + j) % n] as (typeof loop)[number]; if (!e.body) break; edges.push(e); }
      const anchors = edges.map((e) => e.v);
      if (!allBody) anchors.push((nextOf.get((edges[edges.length - 1] as (typeof loop)[number]).v) as { to: number }).to);
      runs.push({ anchors, outer: [], cyclic: allBody, d: 0, dAt: [], cellGroup: edges.map((e) => e.group) });
    }
  }
  if (d > 0) {
    const pos = new Float64Array(V.length * 2);
    V.forEach((v, i) => { pos[i * 2] = v.p[0]; pos[i * 2 + 1] = v.p[1]; });
    const o = new Float64Array(2);
    for (const run of runs) {
      const k = run.anchors.length;
      // tangent neighbours on the same run: the nearest anchors at least MIN_TANGENT px away at rest
      // (a cut ending next to a body vertex leaves a sliver edge whose direction is noise)
      const at = (j: number) => (run.cyclic ? (run.anchors[((j % k) + k) % k] as number) : (run.anchors[Math.max(0, Math.min(k - 1, j))] as number));
      const far = (i: number, step: number) => {
        const a = (V[at(i)] as Vtx).p;
        for (let j = i + step, n = 0; n < k; j += step, n++) {
          if (!run.cyclic && (j < 0 || j >= k)) return at(i); // run end: one-sided tangent (a cap)
          const q = (V[at(j)] as Vtx).p;
          if (Math.hypot(q[0] - a[0], q[1] - a[1]) >= MIN_TANGENT) return at(j);
        }
        return at(i);
      };
      const nb = (i: number): [number, number] => [far(i, -1), far(i, 1)];
      nbOf.set(run, nb);
      // outward sign from the first cell: away from its core triangle's third vertex
      const e0 = loops.flat().find((e) => e.v === run.anchors[0] && e.body) as { v: number; third: number; to: number };
      const [p0, n0] = nb(0);
      offsetPoint(pos, run.anchors[0] as number, p0, n0, 1, o);
      const third = (V[e0.third] as Vtx).p;
      const a0 = (V[run.anchors[0] as number] as Vtx).p;
      const sign = ((o[0] as number) - a0[0]) * (third[0] - a0[0]) + ((o[1] as number) - a0[1]) * (third[1] - a0[1]) > 0 ? -1 : 1;
      run.d = sign * d;
      const arc: number[] = [0];
      for (let i = 1; i < k; i++) arc.push((arc[i - 1] as number) + Math.hypot(...sub((V[run.anchors[i] as number] as Vtx).p, (V[run.anchors[i - 1] as number] as Vtx).p)));
      runArc.set(run, arc);
      run.dAt = run.anchors.map((_, i) => run.d * (1 + detailAt(run, arc, i) / d));
    }
    clearanceTaper();
    // smooth outline: the body
    // boundary is a sampled mesh edge with small kinks (turns of +-30 degrees between 5 px vertices)
    // that a uniform offset reproduces as scallops, where the body's own outline (a coarser contour)
    // reads smooth. The untapered margins of each run are relaxed toward the Laplacian of the offset
    // polyline, along the offset direction (OUTLINE_SMOOTH_ITERS Taubin steps, +0.5 / -0.53, so the
    // kinks go and the shoulder's own curvature stays: plain Laplacian steps shrink a convex arc; kept within
    // [OUTLINE_SMOOTH_MIN, OUTLINE_SMOOTH_MAX] x m); tapered, closed and detail anchors keep theirs.
    for (const run of runs) {
      const k = run.anchors.length;
      const nb = nbOf.get(run) as (i: number) => [number, number];
      const full = Math.abs(run.d);
      if (full < 1e-9 || k < 3) continue;
      const interior = (i: number) => run.cyclic || (i > 0 && i < k - 1);
      const arc = runArc.get(run) as number[];
      // simple: the untapered stretches only, within [MIN, MAX] x m. Medium: every interior anchor clear of
      // the underarm apex wedge, within smoothDev of its ramped margin, never wider than it where ramped
      const base = run.dAt.map(Math.abs);
      const free = bulk
        ? base.map((x, i) => interior(i) && x >= D_MIN && apexDist(run, arc[i] as number) > bulk.gapArc)
        : run.dAt.map((x, i) => Math.abs(Math.abs(x) - full) < 1e-9 && interior(i));
      const lo = base.map((x) => (bulk ? Math.max(D_MIN, x - bulk.smoothDev) : full * OUTLINE_SMOOTH_MIN));
      const hi = base.map((x, i) => (bulk ? x + bulk.smoothDev * (bulkGrow.get(run)?.[i] ?? 1) : full * OUTLINE_SMOOTH_MAX));
      void nb;
      for (let it = 0; it < (bulk ? bulk.smoothIters : OUTLINE_SMOOTH_ITERS); it++) {
        const out = runOffsets(pos, run, run.dAt).pts;
        const next = run.dAt.slice();
        for (let i = 0; i < k; i++) {
          // an untapered stretch only: beside a taper the Laplacian would pull the outline inward
          if (!free[i] || !free[(i - 1 + k) % k] || !free[(i + 1) % k]) continue;
          const a = (V[run.anchors[i] as number] as Vtx).p;
          const q = out[i] as Pt;
          const prev = out[(i - 1 + k) % k] as Pt;
          const nxt = out[(i + 1) % k] as Pt;
          const nx = q[0] - a[0];
          const ny = q[1] - a[1];
          const nl = Math.hypot(nx, ny) || 1;
          const lap = ((prev[0] + nxt[0]) / 2 - q[0]) * (nx / nl) + ((prev[1] + nxt[1]) / 2 - q[1]) * (ny / nl);
          const v = Math.abs(run.dAt[i] as number) + (it % 2 ? -0.53 : 0.5) * lap;
          next[i] = Math.sign(run.d) * Math.min(hi[i] as number, Math.max(lo[i] as number, v));
        }
        run.dAt = next;
      }
      run.dAt.forEach((x, i) => { bulkReport.smoothShiftMax = Math.max(bulkReport.smoothShiftMax, Math.abs(Math.abs(x) - (base[i] as number))); });
    }
    for (const run of runs) {
      const k = run.anchors.length;
      const nb = nbOf.get(run) as (i: number) => [number, number];
      taperedAnchors += run.dAt.filter((x) => Math.abs(x) < Math.abs(run.d) - 1e-9).length;
      const placed = runOffsets(pos, run, run.dAt);
      for (let i = 0; i < k; i++) {
        const a = run.anchors[i] as number;
        const [p, nn] = nb(i);
        const di = run.dAt[i] as number;
        if (Math.abs(di) < D_MIN) { run.dAt[i] = 0; run.outer.push(a); continue; }
        if ((placed.flags[i] as number) & (OFFSET_FLAG_CLIPPED | OFFSET_FLAG_MITER)) boundedJoinsAtRest++;
        const vi = V.length;
        V.push({ p: placed.pts[i] as Pt, bind: -1 });
        offsets.push({ v: vi, a, p, n: nn, d: di });
        run.outer.push(vi);
      }
      const cells = run.cyclic ? k : k - 1;
      for (let i = 0; i < cells; i++) {
        const a = run.anchors[i] as number;
        const b = run.anchors[(i + 1) % k] as number;
        const oa = run.outer[i] as number;
        const ob = run.outer[(i + 1) % k] as number;
        const g = run.cellGroup[i] as string;
        for (const tri of [[a, b, ob], [a, ob, oa]] as [number, number, number][]) {
          if (new Set(tri).size < 3) continue;
          const ar = area2((V[tri[0]] as Vtx).p, (V[tri[1]] as Vtx).p, (V[tri[2]] as Vtx).p);
          if (Math.abs(ar) < 0.05) continue; // a cell closed on its anchor at rest (no orientation to keep)
          stripTris.push({ tri: ar < 0 ? [tri[0], tri[2], tri[1]] : tri, group: g });
        }
      }
    }
  }

  // --- the mesh: used vertices, triangles by draw group
  const gslot = (g: string) => (g === sd.slot ? name : `${name}_${g}`);
  const all = [...core.map((c) => ({ tri: c.tri, group: sd.groupOf[c.parent] as string, parent: c.parent })), ...stripTris.map((s) => ({ ...s, parent: -1 }))];
  const order = domain.groups.filter((g) => all.some((x) => x.group === g));
  all.sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group));
  const used = [...new Set(all.flatMap((x) => x.tri))].sort((x, y) => x - y);
  const remap = new Map(used.map((v, i) => [v, i]));
  const ranges: Record<string, [number, number][]> = {};
  {
    let start = 0;
    for (const g of order) { const n = all.filter((x) => x.group === g).length; ranges[gslot(g)] = [[start, start + n]]; start += n; }
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const v of used) { const p = (V[v] as Vtx).p; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const left = Math.floor(x0) - 2;
  const top = Math.floor(y0) - 2;
  const texW = Math.ceil(x1) + 2 - left;
  const texH = Math.ceil(y1) + 2 - top;
  const fabric = opts.fabric ?? [96, 99, 106];
  const texture: RgbaImage = { width: texW, height: texH, data: new Uint8Array(texW * texH * 4) };
  for (let i = 0; i < texW * texH; i++) texture.data.set([fabric[0], fabric[1], fabric[2], 255], i * 4);
  // fallback weights (tools that do not pose embeds): the skin weights under each vertex
  const SW: { bone: string; w: number }[][] = [];
  {
    const sv: number[] = sd.skin.vertices;
    let k = 0;
    while (k < sv.length) {
      const n = sv[k++] as number;
      const list: { bone: string; w: number }[] = [];
      for (let j = 0; j < n; j++) { list.push({ bone: sd.skin.bones[sv[k] as number], w: sv[k + 3] as number }); k += 4; }
      SW.push(list);
    }
  }
  const bindSk = new Skeleton(loadAnimDocument({ ...raw, animations: {} }));
  bindSk.setToSetupPose();
  bindSk.updateWorldTransform("none");
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  const anchorOf = new Map(offsets.map((o) => [o.v, o.a]));
  const bonesUsed: string[] = [];
  const vertexData: number[] = [];
  for (const v of used) {
    const blend = new Map<string, number>();
    const bnd = (V[anchorOf.get(v) ?? v] as Vtx).bind;
    const add = (i: number, k: number) => { for (const { bone, w } of SW[i] ?? []) blend.set(bone, (blend.get(bone) ?? 0) + w * k); };
    if (typeof bnd === "number") add(bnd, 1);
    else { add(bnd[0], bnd[3]); add(bnd[1], bnd[4]); add(bnd[2], 1 - bnd[3] - bnd[4]); }
    const topw = [...blend.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4).filter(([, w]) => w > 1e-6);
    const sum = topw.reduce((s, [, w]) => s + w, 0) || 1;
    vertexData.push(topw.length);
    const p = (V[v] as Vtx).p;
    for (const [bone, w] of topw) {
      if (!bonesUsed.includes(bone)) bonesUsed.push(bone);
      const mtx = bindSk.getBone(bone).world;
      const x = p[0] - ox - mtx.x;
      const y = p[1] - oy - mtx.y;
      const det = mtx.a * mtx.d - mtx.b * mtx.c;
      vertexData.push(bonesUsed.indexOf(bone), Number(((mtx.d * x - mtx.b * y) / det).toFixed(4)), Number(((-mtx.c * x + mtx.a * y) / det).toFixed(4)), Number((w / sum).toFixed(6)));
    }
  }
  const embedded = used.filter((v) => !anchorOf.has(v));
  const offsetUsed = offsets.filter((o) => remap.has(o.v));
  const attachment = {
    type: "mesh",
    path: `garment/${name}`,
    uvs: used.flatMap((v) => [Number((((V[v] as Vtx).p[0] - left) / texW).toFixed(7)), Number((((V[v] as Vtx).p[1] - top) / texH).toFixed(7))]),
    triangles: all.flatMap((x) => x.tri.map((v) => remap.get(v) as number)),
    vertices: vertexData,
    bones: bonesUsed,
    hull: 3,
    groups: ranges,
    embed: {
      slot: sd.slot,
      attachment: sd.attachment,
      vertices: embedded.map((v) => remap.get(v) as number),
      points: embedded.map((v) => { const b = (V[v] as Vtx).bind; return typeof b === "number" ? b : [...b]; }),
      ...(offsetUsed.length ? { offsets: { vertices: offsetUsed.map((o) => remap.get(o.v) as number), points: offsetUsed.map((o) => [remap.get(o.a) as number, remap.get(o.p) as number, remap.get(o.n) as number, Number(o.d.toFixed(4))]) } } : {})
    },
    width: texW,
    height: texH
  };
  for (const run of runs) { run.anchors = run.anchors.map((v) => remap.get(v) as number); run.outer = run.outer.map((v) => remap.get(v) as number); }

  // --- slots: each group right after its body group; the trunk after every layer drawn between the
  // skin and its first limb (underwear: shorts, tank; hidden or not), so a top's hem overlaps them
  const slots = raw.slots as any[];
  const hides = opts.hides ?? [];
  const firstLimb = Math.min(...order.filter((g) => g !== sd.slot).map((g) => sd.slotIndex.get(g) ?? Infinity));
  const outSlots = [...order, ...(order.includes(sd.slot) ? [] : [sd.slot])].map((g) => {
    let after = g;
    if (g === sd.slot) {
      const under = slots.map((x) => x.name as string).filter((h) => { const i = sd.slotIndex.get(h) ?? -1; return i > (sd.slotIndex.get(g) ?? 0) && i < firstLimb; }).sort((a, b) => (sd.slotIndex.get(b) ?? 0) - (sd.slotIndex.get(a) ?? 0))[0];
      if (under) after = under;
    } else if (domain.cuts.some((c) => c.kind === "cuff" && c.groups.includes(g))) {
      //: a cuffed sleeve draws over the
      // extremity hanging off its limb bone (the fist region, which carries the wrist above the dip), so the hem
      // overlaps the wrist and the hand comes out from under it; the cuff cut sits on the wrist dip (tools/cuffGap.ts)
      const bone = slots.find((s) => s.name === g)?.bone as string | undefined;
      const kids = new Set((raw.bones as any[]).filter((b) => b.parent === bone).map((b) => b.name as string));
      const gi = sd.slotIndex.get(g) ?? 0;
      const skinGroups = new Set(order);
      // only body regions (the fist, a fist copy) go under the sleeve: the walk stops at the first slot on the
      // extremity bone that is not a region (a blade, a held item, an empty slot filled at runtime), which stays on top
      const attsOf = (s: string) => Object.values(raw.skins as Record<string, any>).flatMap((sk) => Object.values((sk.attachments?.[s] ?? {}) as Record<string, any>));
      const isRegion = (s: string) => { const a = attsOf(s); return a.length > 0 && a.every((x) => x?.type === "region"); };
      let k = gi + 1;
      while (k < slots.length && !skinGroups.has(slots[k].name) && (kids.has(slots[k].bone) || slots[k].bone === bone)) {
        if (kids.has(slots[k].bone)) { if (!isRegion(slots[k].name)) break; after = slots[k].name; }
        k++;
      }
    }
    return { name: gslot(g), after, bone: slots.find((s) => s.name === g)?.bone as string };
  });

  // --- outlines: runs along the outer vertices, cuts from outer end to outer end; split by group
  const contours: Record<string, Record<string, any>> = {};
  // trimAtOutline (armour): a later plate (the head, a fist, a pauldron) trims these strokes only
  // where their centreline is under its opaque outline, never half a width outside it: the fabric reaches the
  // centreline, so a stroke trimmed there left bare fabric against the background (the cuff corner nick)
  const style = { width: strokeW, color: opts.strokeColor ?? domain.stroke?.color ?? DEFAULT_GARMENT_STROKE, caps: "round", trimAtOutline: true };
  const emit = (pts: ContourPoint[], groupsAt: string[], tag: string, closed: boolean) => {
    // pts[i]..pts[i+1] lies in group groupsAt[i]; one contour per maximal group run, sharing ends
    if (closed && groupsAt.every((g) => g === groupsAt[0])) {
      const s = gslot(groupsAt[0] as string);
      (contours[s] ??= {})[`${s}_${tag}`] = { mesh: { slot: name, attachment: name }, points: pts, closed: true, ...style };
      return;
    }
    const segs = closed ? pts.length : pts.length - 1;
    let i0 = 0;
    if (closed) { i0 = groupsAt.findIndex((g, i) => g !== groupsAt[(i - 1 + segs) % segs]); }
    let run: ContourPoint[] = [pts[i0 % pts.length] as ContourPoint];
    let g = groupsAt[i0 % segs] as string;
    let part = 0;
    const flush = () => {
      if (run.length >= 2) { const s = gslot(g); (contours[s] ??= {})[`${s}_${tag}_${part++}`] = { mesh: { slot: name, attachment: name }, points: run, closed: false, ...style }; }
    };
    for (let j = 0; j < segs; j++) {
      const i = (i0 + j) % segs;
      if (groupsAt[i] !== g) { flush(); run = [run[run.length - 1] as ContourPoint]; g = groupsAt[i] as string; }
      run.push(pts[(i + 1) % pts.length] as ContourPoint);
    }
    flush();
  };
  let cutStrokes = 0;
  // the edges of unstroked cut chains (the art's painted ink stays there), framing edges included
  const paintedEdges: [number, number][] = [];
  const insetCuts: GarmentBuild["insetCuts"] = [];
  // per vertex: the unstroked cut whose chain it lies on; per chain end vertex: its stroked cut
  const paintedAt = new Map<number, GarmentCut>();
  const strokedEnd = new Map<number, GarmentCut>();
  // a chain of garment vertices moved `inset` px into the garment (vertex normals; the offset ramps
  // from 0 at both chain ends over one stroke width), each point barycentric on its garment triangle
  const insetChain = (pts: number[], inset: number): ContourPoint[] => {
    const at = (i: number) => (V[used[i] as number] as Vtx).p;
    const tris = all.map((x) => x.tri.map((v) => remap.get(v) as number) as [number, number, number]);
    const locate = (q: Pt): ContourPoint | null => {
      for (const [a, b, c] of tris) {
        const l = baryOf(q, at(a), at(b), at(c));
        if (Math.min(...l) < -1e-9) continue;
        return [a, b, c, Number(l[0].toFixed(9)), Number(l[1].toFixed(9))];
      }
      return null;
    };
    const n = pts.length;
    const arc = [0];
    for (let k = 1; k < n; k++) arc.push((arc[k - 1] as number) + Math.hypot(at(pts[k] as number)[0] - at(pts[k - 1] as number)[0], at(pts[k] as number)[1] - at(pts[k - 1] as number)[1]));
    const total = arc[n - 1] as number;
    const normal = (k: number): Pt => {
      const p0 = at(pts[Math.max(0, k - 1)] as number);
      const p1 = at(pts[Math.min(n - 1, k + 1)] as number);
      const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      return [-(p1[1] - p0[1]) / l, (p1[0] - p0[0]) / l];
    };
    // the side of the garment: the normal at the chain's middle points into it or away from it
    const mid = Math.floor(n / 2);
    const pm = at(pts[mid] as number);
    const nm = normal(mid);
    const sign = locate([pm[0] + nm[0], pm[1] + nm[1]]) ? 1 : -1;
    return pts.map((v, k) => {
      const e = Math.min(arc[k] as number, total - (arc[k] as number)) / strokeW;
      const r = e >= 1 ? 1 : e <= 0 ? 0 : e * e * (3 - 2 * e);
      const nk = normal(k);
      const p = at(v);
      for (let o = inset * r; o > 0.05; o *= 0.5) {
        const q = locate([p[0] + sign * nk[0] * o, p[1] + sign * nk[1] * o]);
        if (q) return q;
      }
      return v;
    });
  };
  if (!opts.noStrokes && d > 0) {
    runs.forEach((run, ri) => emit(run.cyclic ? run.outer : run.outer, run.cellGroup, `edge${ri}`, run.cyclic));
    // cut chains: in each loop, maximal runs of cut edges, framed by the outer vertices of the runs around them
    const outerAt = new Map<number, number>();
    for (const run of runs) run.anchors.forEach((a, i) => outerAt.set(a, run.outer[i] as number));
    loops.forEach((loop, li) => {
      const n = loop.length;
      loop.forEach((e, i) => {
        if (e.body || !(loop[(i - 1 + n) % n] as { body: boolean }).body) return;
        const cut = domain.cuts[blockedCut.get(edgeKey(e.v, e.to)) ?? -1];
        const stroke = !cut || cutStroked(cut);
        const pts: number[] = [];
        const gs: string[] = [];
        const first = remap.get(e.v) as number;
        if (outerAt.has(first)) { pts.push(outerAt.get(first) as number); gs.push(e.group); }
        let j = i;
        pts.push(first);
        while (!(loop[j % n] as { body: boolean }).body && j < i + n) { const c = loop[j % n] as (typeof loop)[number]; gs.push(c.group); pts.push(remap.get(c.to) as number); j++; }
        const last = pts[pts.length - 1] as number;
        if (outerAt.has(last)) { pts.push(outerAt.get(last) as number); gs.push(gs[gs.length - 1] as string); }
        if (!stroke) {
          for (let k = 0; k + 1 < pts.length; k++) paintedEdges.push([pts[k] as number, pts[k + 1] as number]);
          if (cut) for (const v of pts) paintedAt.set(v, cut);
          return;
        }
        if (cut) { strokedEnd.set(pts[0] as number, cut); strokedEnd.set(pts[pts.length - 1] as number, cut); }
        const inset = cut ? cutInset(cut, strokeW) : 0;
        if (inset > 0) {
          const ip = insetChain(pts, inset);
          insetCuts.push({ edges: pts.slice(1).map((v, k) => [pts[k] as number, v] as [number, number]), points: ip });
          emit(ip, gs, `cut${li}_${i}`, false);
        } else emit(pts, gs, `cut${li}_${i}`, false);
        cutStrokes++;
      });
    });
    // a run stroke ending at an unstroked cut is prolonged one stroke width along its end tangent, so
    // it tucks under what overlaps the opening (the head's outline) on both sides instead of stopping
    // short of it. Each stroke end at a cut with
    // `endsAbove` (resolved per cut: the cut its end vertex belongs to) also gets an end piece drawn
    // just above that slot: at an unstroked cut the prolonged end; at a stroked cut (the
    // neckline) the strokes meeting at the chain end, so the corner under the overlapping part's
    // opaque stub still shows the line
    const tucks: [string, string, any][] = [];
    for (const byName of Object.values(contours)) for (const [cn, c] of Object.entries(byName)) {
      if (c.closed) continue;
      const p = c.points as ContourPoint[];
      const atEnd = [p[0], p[p.length - 1]].map((v) => (typeof v === "number" ? { painted: paintedAt.get(v), stroked: strokedEnd.get(v) } : {}));
      const e0 = atEnd[0]?.painted ? strokeW : 0;
      const e1 = atEnd[1]?.painted ? strokeW : 0;
      if (e0 || e1) c.extend = [e0, e1];
      // the end piece above the overlapping slot: the last TUCK_POINTS points (prolonged TUCK_EXTEND at a painted cut)
      for (const end of [0, 1] as const) {
        const at = atEnd[end];
        const cut = at?.painted ?? at?.stroked;
        if (!cut?.endsAbove) continue;
        const piece = end ? p.slice(-TUCK_POINTS) : p.slice(0, TUCK_POINTS).reverse();
        if (piece.length >= 2) tucks.push([cut.endsAbove, `${cn}_tuck${end}`, { ...c, points: piece, extend: [0, at?.painted ? TUCK_EXTEND : 0] }]);
      }
    }
    for (const [slot, n, c] of tucks) (contours[slot] ??= {})[n] = c;
  }
  const parent = Int32Array.from(all, (x) => x.parent);
  const report = {
    margin: m,
    offsetD: d,
    strokeWidth: strokeW,
    bodyTrianglesInGroups: Array.from({ length: nT }, (_, t) => t).filter(inDomain).length,
    subdividedTriangles: subdivided,
    coreTriangles: core.length,
    stripTriangles: stripTris.length,
    vertices: used.length,
    embeddedVertices: embedded.length,
    offsetVertices: offsetUsed.length,
    boundaryLoops: loops.length,
    runs: runs.map((r) => ({ anchors: r.anchors.length, cyclic: r.cyclic, groups: [...new Set(r.cellGroup)] })),
    unknownBoundaryEdges: unknownEdges,
    boundedJoinsAtRest,
    taperedAnchors,
    clearanceTaper: { gaps: taperReport.gaps, anchors: taperReport.anchors, minD: Number.isFinite(taperReport.minD) ? Number(taperReport.minD.toFixed(3)) : null, gapClear: GAP_CLEAR, slope: GAP_TAPER_SLOPE, wedgeArc: GAP_WEDGE_ARC },
    template: domain.template ?? "simple",
    ...(bulk ? { bulk: { ...bulk, ...bulkReport } } : {}),
    cutDetails: domain.details ?? [],
    cappedSliverEdges: capped.size,
    cutStrokes,
    groups: Object.fromEntries(Object.entries(ranges).map(([k, r]) => [k, (r[0] as [number, number])[1] - (r[0] as [number, number])[0]])),
    texture: [texW, texH]
  };
  return { ownerSlot: name, attachment, slots: outSlots, contours, texture, origin: [left, top], runs, parent, paintedEdges, insetCuts, report };
}

/** Puts a build into the document: its slots after their anchors, the mesh and contours set, hidden slots unset. */
export function dressGarment(raw: any, build: GarmentBuild, hides: readonly string[] = []): any {
  const doc = JSON.parse(JSON.stringify(raw));
  const skinKey = Object.keys(doc.skins)[0] as string;
  const slots = doc.slots as any[];
  for (const s of build.slots) {
    const at = slots.findIndex((x) => x.name === s.after);
    if (at < 0) throw new Error(`no slot ${s.after}`);
    slots.splice(at + 1, 0, { name: s.name, bone: s.bone, ...(s.name === build.ownerSlot ? { attachment: build.ownerSlot } : {}) });
  }
  doc.skins[skinKey].attachments[build.ownerSlot] = { [build.ownerSlot]: build.attachment };
  for (const [slot, byName] of Object.entries(build.contours)) { const cs = (doc.skins[skinKey].contours ??= {}); cs[slot] = { ...(cs[slot] ?? {}), ...structuredClone(byName) }; }
  for (const h of hides) { const s = slots.find((x) => x.name === h); if (s) delete s.attachment; }
  return doc;
}

// --- gates -----------------------------------------------------------------------------------------

/**
 * Surface correspondence (structural, from the attachment alone): every triangle whose vertices are
 * all embedded (a core triangle) has ONE real parent body triangle holding every reference of its
 * vertices with nonnegative weights; each embedded vertex at the setup pose lies where its UV says
 * it was built (rest = uv * size + origin), so a wrong binding shows.
 */
export function correspondenceGate(raw: any, att: any, origin: Pt): { coreTriangles: number; noParent: number; negativeWeights: number; restMismatchMax: number } {
  const sd = skinData(raw, { slot: att.embed.slot, attachment: att.embed.attachment });
  const n = att.uvs.length / 2;
  const at = new Int32Array(n).fill(-1);
  (att.embed.vertices as number[]).forEach((v, i) => { at[v] = i; });
  const refs = (i: number): [number[], number[]] => { const p = att.embed.points[at[i] as number]; return typeof p === "number" ? [[p], [1]] : [[p[0], p[1], p[2]], [p[3], p[4], 1 - p[3] - p[4]]]; };
  const triOf = new Map<number, number[]>();
  for (let t = 0; t < sd.nT; t++) for (let k = 0; k < 3; k++) { const v = sd.T[t * 3 + k] as number; const l = triOf.get(v) ?? []; l.push(t); triOf.set(v, l); }
  let core = 0;
  let noParent = 0;
  let neg = 0;
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    if ((at[i] as number) < 0) continue;
    const [r, w] = refs(i);
    if (w.some((x) => x < -1e-9)) neg++;
    let x = 0;
    let y = 0;
    r.forEach((v, k) => { x += (sd.P[v] as Pt)[0] * (w[k] as number); y += (sd.P[v] as Pt)[1] * (w[k] as number); });
    const ux = (att.uvs[i * 2] as number) * att.width + origin[0];
    const uy = (att.uvs[i * 2 + 1] as number) * att.height + origin[1];
    mismatch = Math.max(mismatch, Math.hypot(x - ux, y - uy));
  }
  const T: number[] = att.triangles;
  for (let t = 0; t < T.length / 3; t++) {
    const vs = [T[t * 3] as number, T[t * 3 + 1] as number, T[t * 3 + 2] as number];
    if (vs.some((v) => (at[v] as number) < 0)) continue;
    core++;
    const need = new Set<number>();
    for (const v of vs) { const [r, w] = refs(v); r.forEach((q, k) => { if (Math.abs(w[k] as number) > 1e-12) need.add(q); }); }
    const first = [...need][0] as number;
    const ok = (triOf.get(first) ?? []).some((pt) => [...need].every((q) => q === sd.T[pt * 3] || q === sd.T[pt * 3 + 1] || q === sd.T[pt * 3 + 2]));
    if (!ok) noParent++;
  }
  return { coreTriangles: core, noParent, negativeWeights: neg, restMismatchMax: Number(mismatch.toFixed(6)) };
}

/**
 * Contour integrity (structural): every boundary edge of the garment mesh is stroked exactly once
 * and no interior edge (a draw-group partition) is stroked. A contour with barycentric points (a
 * cut stroked inside the garment, GarmentCut.inset) is checked geometrically at rest: it strokes the
 * shortest boundary path between its two end vertices over the edges whose ends and midpoint lie
 * within half its width (+ INSET_GATE_TOL) of its centreline, and each of its points must lie within
 * that distance of the path.
 */
/**
 * Outline turn angle (notch gate): a zig-zag is two opposite turns within
 * OUTLINE_ZIG_ARC canvas px of arc along a posed stroke (points closer than OUTLINE_ZIG_STEP merged);
 * its size is the smaller of the two turns, in degrees. The body's own outlines stay at or below
 * 37 degrees in every clip frame (the torso at the shoulder top on a raise); a garment outline may
 * not zig-zag more than
 * OUTLINE_TURN_MAX_DEG (the shoulder-top notch on a raise measured 70, 78 on the leather).
 */
export const OUTLINE_ZIG_ARC = 15;
export const OUTLINE_ZIG_STEP = 0.75;
export const OUTLINE_TURN_MAX_DEG = 40;
export function outlineZigDeg(pts: ArrayLike<number>, n: number): { deg: number; at: Pt } {
  const P: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p: Pt = [pts[i * 2] as number, pts[i * 2 + 1] as number];
    const q = P[P.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > OUTLINE_ZIG_STEP) P.push(p);
  }
  const arc: number[] = [0];
  for (let i = 1; i < P.length; i++) arc.push((arc[i - 1] as number) + Math.hypot(...sub(P[i] as Pt, P[i - 1] as Pt)));
  const turn: number[] = [0];
  for (let i = 1; i + 1 < P.length; i++) {
    const [ux, uy] = sub(P[i] as Pt, P[i - 1] as Pt);
    const [vx, vy] = sub(P[i + 1] as Pt, P[i] as Pt);
    turn.push((Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI);
  }
  let deg = 0;
  let at: Pt = [0, 0];
  for (let i = 1; i + 1 < P.length; i++) {
    for (let j = i + 1; j + 1 < P.length && (arc[j] as number) - (arc[i] as number) <= OUTLINE_ZIG_ARC; j++) {
      const ti = turn[i] as number;
      const tj = turn[j] as number;
      if (Math.sign(ti) === Math.sign(tj)) continue;
      const v = Math.min(Math.abs(ti), Math.abs(tj));
      if (v > deg) { deg = v; at = P[i] as Pt; }
    }
  }
  return { deg, at };
}

export function contourGate(att: any, contours: Record<string, Record<string, any>>, painted: readonly [number, number][] = []): { boundaryEdges: number; unstroked: number; doubled: number; interiorStroked: number; painted: number; inset: number } {
  // `painted`: boundary edges of unstroked cuts (GarmentBuild.paintedEdges), inked by the art itself
  const T: number[] = att.triangles;
  const count = new Map<number, number>();
  const ends = new Map<number, [number, number]>();
  for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) { const a = T[t * 3 + k] as number; const b = T[t * 3 + ((k + 1) % 3)] as number; const key = ek(a, b); count.set(key, (count.get(key) ?? 0) + 1); ends.set(key, [a, b]); }
  const rest = (v: number): Pt => [(att.uvs[v * 2] as number) * att.width, (att.uvs[v * 2 + 1] as number) * att.height];
  const pointAt = (q: ContourPoint): Pt | null => {
    if (typeof q === "number") return rest(q);
    const [a, b, c, wa, wb] = q;
    const wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) < -1e-6) return null;
    const [A, B, C] = [rest(a), rest(b), rest(c)];
    return [A[0] * wa + B[0] * wb + C[0] * wc, A[1] * wa + B[1] * wb + C[1] * wc];
  };
  const stroked = new Map<number, number>();
  const geometric: { line: Pt[]; reach: number; from: number; to: number }[] = [];
  let unstroked = 0;
  for (const byName of Object.values(contours)) for (const [cn, c] of Object.entries(byName)) {
    if (/_tuck[01]$/.test(cn)) continue; // an end piece repeated above the overlapping slot
    const p = c.points as ContourPoint[];
    if (p.some((q) => typeof q !== "number")) {
      const line = p.map(pointAt);
      const [from, to] = [p[0], p[p.length - 1]];
      if (line.some((q) => q === null) || typeof from !== "number" || typeof to !== "number" || c.closed) { unstroked++; continue; }
      geometric.push({ line: line as Pt[], reach: (c.width as number) / 2 + INSET_GATE_TOL, from, to });
      continue;
    }
    const segs = c.closed ? p.length : p.length - 1;
    for (let i = 0; i < segs; i++) { const key = ek(p[i] as number, p[(i + 1) % p.length] as number); stroked.set(key, (stroked.get(key) ?? 0) + 1); }
  }
  // a geometric stroke strokes the shortest boundary path between its two end vertices over the
  // boundary edges within its reach (ends and midpoint); no such path: the stroke is broken
  const lineDist = (q: Pt, line: Pt[]) => { let m = Infinity; for (let i = 0; i + 1 < line.length; i++) m = Math.min(m, segDist(q, line[i] as Pt, line[i + 1] as Pt)); return m; };
  const insetKeys: number[] = [];
  const insetEdges: [Pt, Pt][] = [];
  for (const g of geometric) {
    const adj = new Map<number, [number, number][]>();
    for (const [key, n] of count) {
      if (n !== 1) continue;
      const [u, v] = ends.get(key) as [number, number];
      const [a, b] = [rest(u), rest(v)];
      if (![a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Pt].every((q) => lineDist(q, g.line) <= g.reach)) continue;
      (adj.get(u) ?? adj.set(u, []).get(u) as [number, number][]).push([v, key]);
      (adj.get(v) ?? adj.set(v, []).get(v) as [number, number][]).push([u, key]);
    }
    const prev = new Map<number, [number, number]>([[g.from, [-1, -1]]]);
    const queue = [g.from];
    while (queue.length && !prev.has(g.to)) { const u = queue.shift() as number; for (const [v, key] of adj.get(u) ?? []) if (!prev.has(v)) { prev.set(v, [u, key]); queue.push(v); } }
    if (!prev.has(g.to) || g.from === g.to) { unstroked++; continue; }
    for (let v = g.to; v !== g.from; v = (prev.get(v) as [number, number])[0]) {
      const key = (prev.get(v) as [number, number])[1];
      insetKeys.push(key);
      insetEdges.push((ends.get(key) as [number, number]).map(rest) as [Pt, Pt]);
    }
  }
  for (const key of insetKeys) stroked.set(key, (stroked.get(key) ?? 0) + 1);
  const paintedKeys = new Set(painted.map(([u, v]) => ek(u, v)));
  let boundary = 0;
  let doubled = 0;
  let interior = 0;
  for (const [key, n] of count) {
    const s = stroked.get(key) ?? 0;
    if (n === 1) { boundary++; if (s === 0 && !paintedKeys.has(key)) unstroked++; if (s > 1 || (s > 0 && paintedKeys.has(key))) doubled++; } else if (s > 0) interior++;
  }
  for (const key of stroked.keys()) if (!count.has(key)) unstroked++; // a stroke across no mesh edge
  // a geometric stroke away from the boundary edges it strokes (across the garment's interior)
  for (const g of geometric) for (const q of g.line) { let m = Infinity; for (const [a, b] of insetEdges) m = Math.min(m, segDist(q, a, b)); if (m > g.reach) unstroked++; }
  const inset = insetKeys.length;
  return { boundaryEdges: boundary, unstroked, doubled, interiorStroked: interior, painted: paintedKeys.size, inset };
}

export interface PoseMetrics {
  zeroMarginMaxGamePx: number;
  offsetDevMaxGamePx: number;
  /** Bounded joins and closed-apex cell midpoints (JOIN_DEV_MAX_GAME_PX). */
  joinDevMaxGamePx: number;
  apexMidpoints: number;
  boundedJoins: number;
  flipsCore: number;
  flipsCoreInherited: number;
  flipsStrip: number;
  /** Rest positions of the flipped strip triangles (ids for the report). */
  flipAt: string[];
  /** garmentGap null: no pair across the gap is wide enough to hold both margins (the declared rest overlap). */
  gaps: { name: string; bodyGap: number; garmentGap: number | null; pairs: number; verdict: "open" | "bodyClosed" | "tapered" | "web" | "overlap" }[];
}

/**
 * Posed geometry of the garment against the evaluated body (one skeleton, already posed):
 * - zero-margin control: each embedded vertex vs the body point under it, the latter recomputed
 *   from the body's posed triangle with weights taken at rest from the vertex's UV position (so a
 *   wrong binding or a second deformation shows), in game px;
 * - offset deviation: each outer vertex and outer-edge midpoint vs |d| from its run's posed anchor
 *   polyline (bounded joins apart), in game px;
 * - flips: garment triangles whose orientation differs from rest (core ones whose parent flips too
 *   are inherited, reported apart);
 * - gaps: per protected gap the body's and the garment's clearance (outer vertices of the two sides,
 *   pairs closer than 4m + stroke along one run excluded): `web` = the body is open by at least 2m+1
 *   and the garment closed; `thicknessLimited` = the body is open by less than 2m+1 (the requested
 *   thickness does not fit: unsupported, reported).
 */
export function garmentPoseMetrics(sk: Skeleton, build: GarmentBuild, domain: GarmentDomain, raw: any, gameScale: number): PoseMetrics {
  const att = sk.getAttachment(sk.getSlot(build.ownerSlot), build.ownerSlot) as MeshAttachment;
  const gw = sk.meshWorldVertices(att, sk.getSlot(build.ownerSlot).bone);
  const skinSlot = sk.getSlot(domain.skin.slot);
  const skinAtt = sk.getAttachment(skinSlot, domain.skin.attachment) as MeshAttachment;
  const bw = sk.meshWorldVertices(skinAtt, skinSlot.bone);
  const a = build.attachment;
  const sd = skinData(raw, domain.skin);
  const restOf = (i: number): Pt => [(a.uvs[i * 2] as number) * a.width + build.origin[0], (a.uvs[i * 2 + 1] as number) * a.height + build.origin[1]];
  const T: number[] = a.triangles;
  const isOffset = new Uint8Array(a.uvs.length / 2);
  for (const v of (a.embed.offsets?.vertices ?? []) as number[]) isOffset[v] = 1;
  let zm = 0;
  let flipsCore = 0;
  let flipsInh = 0;
  let flipsStrip = 0;
  const flipAt: string[] = [];
  const done = new Uint8Array(a.uvs.length / 2);
  const bp = (v: number): Pt => [bw[v * 2] as number, bw[v * 2 + 1] as number];
  for (let t = 0; t < T.length / 3; t++) {
    const vs = [T[t * 3] as number, T[t * 3 + 1] as number, T[t * 3 + 2] as number];
    const g = vs.map((v): Pt => [gw[v * 2] as number, gw[v * 2 + 1] as number]) as [Pt, Pt, Pt];
    const r = vs.map(restOf) as [Pt, Pt, Pt];
    const flipped = Math.sign(area2(g[0], g[1], g[2])) !== Math.sign(area2(r[0], r[1], r[2])) || Math.abs(area2(g[0], g[1], g[2])) < 1e-6 * Math.abs(area2(r[0], r[1], r[2]));
    const parent = build.parent[t] as number;
    if (parent < 0) { if (flipped) { flipsStrip++; flipAt.push(`strip t${t} rest ${r.map((q) => q.map(Math.round).join(",")).join(" ")}`); } continue; }
    const pv = [sd.T[parent * 3] as number, sd.T[parent * 3 + 1] as number, sd.T[parent * 3 + 2] as number];
    const pr = pv.map((v) => sd.P[v] as Pt) as [Pt, Pt, Pt];
    const pp = pv.map(bp) as [Pt, Pt, Pt];
    if (flipped) { const pf = Math.sign(area2(pp[0], pp[1], pp[2])) !== Math.sign(area2(pr[0], pr[1], pr[2])); if (pf) flipsInh++; else flipsCore++; }
    for (const v of vs) {
      if (done[v]) continue;
      done[v] = 1;
      const l = baryOf(restOf(v), pr[0], pr[1], pr[2]);
      const x = pp[0][0] * l[0] + pp[1][0] * l[1] + pp[2][0] * l[2];
      const y = pp[0][1] * l[0] + pp[1][1] * l[1] + pp[2][1] * l[2];
      zm = Math.max(zm, Math.hypot((gw[v * 2] as number) - x, (gw[v * 2 + 1] as number) - y));
    }
  }
  // offset deviation
  let dev = 0;
  let joinDev = 0;
  let joins = 0;
  let apexMid = 0;
  // joins as the runtime posed them: clipped concave joins and bounded miters (computeOffsetPoints)
  const emb = att.geometry.embed as NonNullable<MeshAttachment["geometry"]["embed"]>;
  const offPos = new Float64Array(emb.offsetDist.length * 2);
  const offFlags = new Uint8Array(emb.offsetDist.length);
  computeOffsetPoints(gw, emb.offsetRefs, emb.offsetDist, emb.offsetChains, offPos, offFlags);
  const gp = (v: number): Pt => [gw[v * 2] as number, gw[v * 2 + 1] as number];
  for (const run of build.runs) {
    if (!run.outer.length) continue;
    const k = run.anchors.length;
    const A = run.anchors.map(gp);
    // distance to the anchor's own curve: its two run segments (the offset of the local boundary;
    // clearance to other parts of the run, e.g. across the underarm slit, is the gaps gate's)
    const LOCAL = 1;
    const polyDist = (p: Pt, at: number) => { let best = Infinity; const segs = run.cyclic ? k : k - 1; for (let j = at - LOCAL; j < at + LOCAL; j++) { const i = run.cyclic ? (j + k) % k : j; if (i < 0 || i >= segs) continue; best = Math.min(best, segDist(p, A[i] as Pt, A[(i + 1) % k] as Pt)); } return best; };
    const lineDev = (p: Pt, at: number, d: number) => {
      let worst = -1;
      const segs = run.cyclic ? k : k - 1;
      for (const j of [at - 1, at]) {
        const i = run.cyclic ? (j + k) % k : j;
        if (i < 0 || i >= segs) continue;
        const a0 = A[i] as Pt;
        const a1 = A[(i + 1) % k] as Pt;
        const l = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
        const dist = l > 1e-9 ? Math.abs(cross(sub(a1, a0), sub(p, a0))) / l : Math.hypot(p[0] - a0[0], p[1] - a0[1]);
        worst = Math.max(worst, Math.abs(dist - d));
      }
      return worst < 0 ? Math.abs(polyDist(p, at) - d) : worst;
    };
    const joinAt = new Uint8Array(k);
    const offIdx = new Map(((a.embed.offsets?.vertices ?? []) as number[]).map((v, i) => [v, i]));
    run.outer.forEach((o, i) => {
      if (!offIdx.has(o)) { joinAt[i] = 0; return; } // closed on the anchor (tapered to 0)
      const di = Math.abs(run.dAt[i] as number);
      // the anchor's offset point against the supporting lines of its own two run segments: the runtime offsets an
      // anchor along its turn's bisector by d / cos(half turn) (a miter, flagged only when bounded at
      // OFFSET_MITER_LIMIT), which is d from both lines; a segment distance reads the corner vertex instead at a
      // convex turn (d / cos - d: 3.4 px at the side near arm's 105 deg shoulder-top corner). Same on straight runs
      // and concave turns (the foot of the perpendicular lies on the segment).
      const e = lineDev(gp(o), i, di);
      const join = ((offFlags[offIdx.get(o) as number] as number) & (OFFSET_FLAG_CLIPPED | OFFSET_FLAG_MITER)) !== 0;
      if (join) { joins++; joinDev = Math.max(joinDev, e); } else dev = Math.max(dev, e);
      joinAt[i] = join ? 1 : 0;
    });
    // outer-edge midpoints: on the declared curve (d interpolated) unless an end is a bounded join
    run.outer.forEach((o, i) => {
      const j = run.cyclic ? (i + 1) % k : i + 1;
      if (j >= k || joinAt[i] || joinAt[j]) return;
      // a cell closing on its anchor (margin 0: the fold apex, a sliver taper end) is a declared join,
      // not a stretch of offset curve; its midpoint is measured against the join bound
      //
      const apex = run.outer[i] === run.anchors[i] || run.outer[j] === run.anchors[j];
      const q = gp(run.outer[j] as number);
      const pm: Pt = [(gp(o)[0] + q[0]) / 2, (gp(o)[1] + q[1]) / 2];
      const want = (Math.abs(run.dAt[i] as number) + Math.abs(run.dAt[j] as number)) / 2;
      const e = Math.abs(Math.min(polyDist(pm, i), polyDist(pm, j)) - want);
      if (apex) { apexMid++; joinDev = Math.max(joinDev, e); } else dev = Math.max(dev, e);
    });
  }
  // gaps
  const m = Math.abs(build.runs.find((r) => r.outer.length)?.d ?? 0);
  const gaps: PoseMetrics["gaps"] = [];
  for (const gap of domain.gaps) {
    const side = (groups: string[], outer: boolean) => build.runs.flatMap((run, ri) => {
      const k = run.anchors.length;
      let s = 0;
      const out: { p: Pt; ri: number; s: number; i: number }[] = [];
      for (let i = 0; i < k; i++) {
        if (i > 0) s += Math.hypot(...sub(restOf(run.anchors[i] as number), restOf(run.anchors[i - 1] as number)));
        const g = run.cellGroup[Math.min(i, run.cellGroup.length - 1)] as string;
        if (!groups.includes(g)) continue;
        const v = outer && run.outer.length ? (run.outer[i] as number) : (run.anchors[i] as number);
        out.push({ p: gp(v), ri, s, i });
      }
      return out;
    });
    // segments across the gap (consecutive anchors of one run on that side): the distance between
    // two segments, 0 when they cross. The
    // garment's clearance counts only pairs whose body clearance holds both margins (option
    // B: a narrower slit may overlap, the sleeve drawn over the torso); with no such pair the
    // verdict is the explicit "overlap", never an unmeasured pass
    type SidePt = { p: Pt; ri: number; s: number; i: number };
    const segsOf = (xs: SidePt[]) => xs.slice(1).map((y, k) => [xs[k] as SidePt, y] as const).filter(([x, y]) => x.ri === y.ri && y.i === x.i + 1).map(([x, y], k) => ({ a: x, b: y, k }));
    const minGap = (xs: SidePt[], ys: SidePt[], bx?: SidePt[], by?: SidePt[]) => {
      let best = Infinity;
      let pairs = 0;
      const sx = segsOf(xs);
      const sy = segsOf(ys);
      const bsx = bx ? segsOf(bx) : null;
      const bsy = by ? segsOf(by) : null;
      sx.forEach((x, ix) => sy.forEach((y, iy) => {
        if (x.a.ri === y.a.ri && Math.min(Math.abs(x.a.s - y.a.s), Math.abs(x.b.s - y.b.s), Math.abs(x.a.s - y.b.s), Math.abs(x.b.s - y.a.s)) < 4 * m + 10) return;
        if (bsx && bsy && segSegDist((bsx[ix] as typeof x).a.p, (bsx[ix] as typeof x).b.p, (bsy[iy] as typeof y).a.p, (bsy[iy] as typeof y).b.p) < 2 * m + 1 + GAP_CLEAR) return;
        pairs++;
        best = Math.min(best, segSegDist(x.a.p, x.b.p, y.a.p, y.b.p));
      }));
      return { best, pairs };
    };
    const ba = side(gap.a, false);
    const bb = side(gap.b, false);
    const body = minGap(ba, bb);
    const bodyGap = body.best;
    const garment = m > 0 ? minGap(side(gap.a, true), side(gap.b, true), ba, bb) : body;
    const garmentGap = garment.pairs ? garment.best : null;
    // tapered: the body is open by less than 2m + 1 and the declared clearance taper keeps it open
    const verdict = bodyGap < 1 ? "bodyClosed" : garmentGap === null ? "overlap" : garmentGap < 1 ? "web" : bodyGap < 2 * m + 1 ? "tapered" : "open";
    gaps.push({ name: gap.name, bodyGap: Number(bodyGap.toFixed(2)), garmentGap: garmentGap === null ? null : Number(garmentGap.toFixed(2)), pairs: garment.pairs, verdict });
  }
  return { zeroMarginMaxGamePx: zm * gameScale, offsetDevMaxGamePx: dev * gameScale, joinDevMaxGamePx: joinDev * gameScale, boundedJoins: joins, apexMidpoints: apexMid, flipsCore, flipsCoreInherited: flipsInh, flipsStrip, flipAt, gaps };
}

/** Default bound of the armGapEveryFrame gate (canvas px between outline centrelines; simple items measure >= 3). */
export const ARM_GAP_MIN = 2.5;

/**
 * Arm/torso clearance of the posed garment (armGapEveryFrame): per protected gap, the smallest
 * distance between the garment's outer outline segments on the two sides, over the segment pairs whose
 * BODY clearance can hold the two local margins (|dAt| of each segment's anchors, + 1 + GAP_CLEAR); the
 * narrower rest slit is the declared overlap (sleeve over torso). Unlike the gaps of garmentPoseMetrics this
 * reads each anchor's own margin, so a thick (medium) garment is measured where a thin one would be.
 * `min` Infinity: no pair measured in this pose.
 */
export function armGapClearance(sk: Skeleton, build: GarmentBuild, domain: GarmentDomain): { name: string; min: number; pairs: number; at: Pt | null }[] {
  const att = sk.getAttachment(sk.getSlot(build.ownerSlot), build.ownerSlot) as MeshAttachment;
  const gw = sk.meshWorldVertices(att, sk.getSlot(build.ownerSlot).bone);
  const gp = (v: number): Pt => [gw[v * 2] as number, gw[v * 2 + 1] as number];
  const a = build.attachment;
  const restOf = (i: number): Pt => [(a.uvs[i * 2] as number) * a.width, (a.uvs[i * 2 + 1] as number) * a.height];
  type Seg = { ri: number; i: number; s: number; body: [Pt, Pt]; out: [Pt, Pt]; d: number };
  const segsOf = (groups: string[]): Seg[] => build.runs.flatMap((run, ri) => {
    if (!run.outer.length) return [];
    const k = run.anchors.length;
    const out: Seg[] = [];
    let s = 0;
    for (let i = 0; i + 1 < k; i++) {
      if (i > 0) s += Math.hypot(...sub(restOf(run.anchors[i] as number), restOf(run.anchors[i - 1] as number)));
      if (!groups.includes(run.cellGroup[i] as string)) continue;
      const [p, q] = [run.anchors[i] as number, run.anchors[i + 1] as number];
      out.push({ ri, i, s, body: [gp(p), gp(q)], out: [gp(run.outer[i] as number), gp(run.outer[i + 1] as number)], d: Math.max(Math.abs(run.dAt[i] as number), Math.abs(run.dAt[i + 1] as number)) });
    }
    return out;
  });
  return domain.gaps.map((gap) => {
    const A = segsOf(gap.a);
    const B = segsOf(gap.b);
    let min = Infinity;
    let pairs = 0;
    let at: Pt | null = null;
    for (const x of A) for (const y of B) {
      // along one run near each other: the same stretch of outline, not across the gap
      if (x.ri === y.ri && Math.abs(x.s - y.s) < 4 * Math.max(x.d, y.d) + 10) continue;
      if (segSegDist(x.body[0], x.body[1], y.body[0], y.body[1]) < x.d + y.d + 1 + GAP_CLEAR) continue;
      pairs++;
      const g = segSegDist(x.out[0], x.out[1], y.out[0], y.out[1]);
      if (g < min) { min = g; at = [(x.out[0][0] + y.out[0][0]) / 2, (x.out[0][1] + y.out[0][1]) / 2]; }
    }
    return { name: gap.name, min, pairs, at };
  });
}

/** Half window of the silhouetteSmooth gate's local fit (canvas px of arc). */
export const BUMP_SIGMA = 16;
/**
 * Silhouette smoothness: the largest distance (canvas px) between the rest outer outline of each
 * margin run and its own local quadratic fit (+-BUMP_SIGMA px of arc), run ends (2 windows) left out: the small
 * body bumps a padded garment must not follow. Rest positions from the build.
 */
export function silhouetteBump(build: GarmentBuild): { maxPx: number; at: Pt | null } {
  const a = build.attachment;
  const restOf = (i: number): Pt => [(a.uvs[i * 2] as number) * a.width + build.origin[0], (a.uvs[i * 2 + 1] as number) * a.height + build.origin[1]];
  let maxPx = 0;
  let at: Pt | null = null;
  for (const run of build.runs) {
    if (run.cyclic || run.outer.length < 3) continue;
    // resample at 1 px of arc
    // (a closed anchor, the outline on the body: the underarm fold apex, is a declared corner, not a bump)
    const P = run.outer.map(restOf);
    const S: Pt[] = [P[0] as Pt];
    const corner: boolean[] = [run.outer[0] === run.anchors[0]];
    for (let i = 1; i < P.length; i++) {
      const [p, q] = [P[i - 1] as Pt, P[i] as Pt];
      const l = Math.hypot(...sub(q, p));
      for (let t = 1; t <= Math.floor(l); t++) { S.push([p[0] + ((q[0] - p[0]) * t) / l, p[1] + ((q[1] - p[1]) * t) / l]); corner.push(false); }
      if (run.outer[i] === run.anchors[i]) corner[corner.length - 1] = true;
    }
    const nearCorner = S.map((_, i) => corner.slice(Math.max(0, i - BUMP_SIGMA), i + BUMP_SIGMA + 1).some(Boolean));
    const n = S.length;
    // local quadratic least-squares fit over +-BUMP_SIGMA px of arc (Savitzky-Golay: exact on any
    // parabola, so the outline's own curvature has no sag; only bumps shorter than the window remain)
    const h = BUMP_SIGMA;
    const sg = Array.from({ length: 2 * h + 1 }, (_, j) => { const t = j - h; const m2 = (h * (h + 1)) / 3; const m4 = (3 * h * h + 3 * h - 1) * m2 / 5; return (m4 - m2 * t * t) / ((2 * h + 1) * (m4 - m2 * m2)); });
    for (let i = 2 * h; i < n - 2 * h; i++) {
      if (nearCorner[i]) continue;
      let x = 0;
      let y = 0;
      for (let j = -h; j <= h; j++) { const c = sg[j + h] as number; x += (S[i + j] as Pt)[0] * c; y += (S[i + j] as Pt)[1] * c; }
      const q = S[i] as Pt;
      const prev = S[i - 1] as Pt;
      const next = S[i + 1] as Pt;
      const tl = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
      const nrm: Pt = [-(next[1] - prev[1]) / tl, (next[0] - prev[0]) / tl];
      const dev = Math.abs((q[0] - x) * nrm[0] + (q[1] - y) * nrm[1]);
      if (dev > maxPx) { maxPx = dev; at = q; }
    }
  }
  return { maxPx: Number(maxPx.toFixed(3)), at };
}

/**
 * Coverage samples from the declaration alone (independent of the built garment): points on a
 * barycentric grid of each body triangle of the covered groups, kept when on the covered side of
 * every cut of their group (the segment to the group's seed crosses the cut an even number of
 * times) and more than `clear` px from any cut. Rest material points.
 */
export function domainSamples(raw: any, domain: GarmentDomain, grid = 6, clear = 1.5): { tri: number; w: [number, number, number]; group: string }[] {
  const sd = skinData(raw, domain.skin);
  const covered = coveredTest(sd, domain, clear);
  const out: { tri: number; w: [number, number, number]; group: string }[] = [];
  for (let t = 0; t < sd.nT; t++) {
    const g = sd.groupOf[t] as string;
    if (!domain.groups.includes(g)) continue;
    const [a, b, c] = triPts(sd, t);
    for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid - i; j++) {
      const w: [number, number, number] = [i / grid, j / grid, (grid - i - j) / grid];
      if (covered(g, [a[0] * w[0] + b[0] * w[1] + c[0] * w[2], a[1] * w[0] + b[1] * w[1] + c[1] * w[2]])) out.push({ tri: t, w, group: g });
    }
  }
  return out;
}

/** The declaration's covered-side test for a rest point of a group (see `domainSamples`). */
function coveredTest(sd: SkinData, domain: GarmentDomain, clear: number): (g: string, p: Pt) => boolean {
  const cuts = domain.cuts.map((c) => ({ groups: c.groups, pts: c.points.map((mp) => materialRest(sd, mp)) }));
  const seedOf = new Map(domain.seeds.map((s) => [s.group, materialRest(sd, s.point)]));
  const segX = (a: Pt, b: Pt, c: Pt, e: Pt) => { const r = sub(b, a); const s = sub(e, c); const den = cross(r, s); if (Math.abs(den) < 1e-12) return false; const u = cross(sub(c, a), s) / den; const w = cross(sub(c, a), r) / den; return u > 0 && u < 1 && w > 0 && w < 1; };
  return (g, p) => {
    const seed = seedOf.get(g);
    if (!seed || !domain.groups.includes(g)) return false;
    for (const cut of cuts) {
      if (!cut.groups.includes(g)) continue;
      let crossings = 0;
      let near = Infinity;
      for (let k = 0; k + 1 < cut.pts.length; k++) {
        if (segX(p, seed, cut.pts[k] as Pt, cut.pts[k + 1] as Pt)) crossings++;
        near = Math.min(near, segDist(p, cut.pts[k] as Pt, cut.pts[k + 1] as Pt));
      }
      if (crossings % 2 === 1 || near <= clear) return false;
    }
    return true;
  };
}

/**
 * The covered material in the skin's texture (width x height texels, 1 = covered): each texel of a
 * covered group's triangle (by UV) whose rest point is on the covered side of every cut of its group
 * and more than `clear` px from any cut. The per-frame coverage check reads it through the
 * renderer's top texel: a visible covered texel is body skin showing through the garment.
 */
export function coveredTexelMask(raw: any, domain: GarmentDomain, width: number, height: number, clear = 1.5): Uint8Array {
  const sd = skinData(raw, domain.skin);
  const covered = coveredTest(sd, domain, clear);
  const uv: number[] = sd.skin.uvs;
  const mask = new Uint8Array(width * height);
  for (let t = 0; t < sd.nT; t++) {
    const g = sd.groupOf[t] as string;
    if (!domain.groups.includes(g)) continue;
    const vi = [0, 1, 2].map((k) => sd.T[t * 3 + k] as number);
    const q = vi.map((v) => [(uv[v * 2] as number) * width, (uv[v * 2 + 1] as number) * height] as Pt) as [Pt, Pt, Pt];
    const [a, b, c] = triPts(sd, t);
    const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0])));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1])));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
    if (Math.abs(area2(q[0], q[1], q[2])) < 1e-12) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l = baryOf([x + 0.5, y + 0.5], q[0], q[1], q[2]);
      if (Math.min(...l) < -1e-6) continue;
      if (covered(g, [a[0] * l[0] + b[0] * l[1] + c[0] * l[2], a[1] * l[0] + b[1] * l[1] + c[1] * l[2]])) mask[y * width + x] = 1;
    }
  }
  return mask;
}
