/*
 * Atlas Animator: original implementation.
 *
 * Plan, construction pass 2: the painted art on the body-derived garment surface.
 * - UVs stay frozen from the garment's rest canvas positions (a strip vertex at its own rest offset
 *   position, not its inner anchor); the texture is the art's canvas rectangle under the mesh.
 * - Painting: the visible fabric, the cream trim, the closures and the interior shading are kept.
 *   Ink the runtime contours replace is removed: silhouette ink (within the stroke band of the rest
 *   garment boundary) and occlusion ink (painted piece edges, e.g. the sleeve's armhole curve and the
 *   flank lines, including ink hidden under the other side's strip at rest). Ink is kept only where
 *   it edges the trim or a closure (within TRIM_INK px of cream) and lies inside the stroke band.
 * - Completion: removed ink, pixels the art leaves empty under the mesh (the underarm slit, the
 *   strips past the painted edge) and the padding ring are filled from the nearest kept material
 *   (wavefront average, then a light smoothing of the filled texels only), so fabric colour and
 *   restrained shading continue. Dark rest contact shadow near the declared underarm taper is eased
 *   toward the fabric median, so a raise does not expose a dark band. The rest core is planar (no two
 *   core materials share a texel); the only rest overlap is strip with strip in the underarm slit,
 *   both completed with the same fabric (one completed layer, reported).
 * - Padding (PAD px of edge-extended colour past the footprint) is separate from completion.
 * - Cut details: `deriveCutDetails` records where the source silhouette runs past the uniform shell at
 *   a cut end (a hem flare), as declared domain data; `silhouetteResidual` measures the rest
 *   silhouette against the art per boundary anchor.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RgbaImage } from "./image.js";
import { artOutlineInk, isInkBlend, isInkDark, isOutlineInkColour } from "./garmentInk.js";
import { materialRestOf, type GarmentBuild, type GarmentDomain } from "./garmentSurface.js";
import { FLANK_BAND, FLANK_CUT_CLEAR, flankBandGate, type FlankField } from "./flankBand.js";

type Pt = [number, number];
/** Ink within this many px of cream edges the trim or a closure (kept). */
export const TRIM_INK = 6;
/** Trim ink this close (px) past a boundary stroke's edge repeats that outline: removed. */
export const INK_BESIDE_STROKE = 4;
/** A removed ink texel with kept line work on both sides within this many px along one axis is part of it. */
export const GAP_FILL = 2;
/** Share of an interior ink line's texels within TRIM_INK of cream above which it is a cream edge (the cream rule). */
export const CREAM_EDGE_SHARE = 0.5;
/** Band (stroke widths past the stroke's edge) in which darker painted shading is eased to fabric. */
export const SHADE_BESIDE_STROKE = 2;
/** Inside the beside-stroke band, painted shading stays at most this much (luminance) below the fabric
 * median; past the band it returns to the art over one more band width (armour: the leather's
 * dark flank side panels, eased only in the band's first fifth, read as a soft second line). */
export const BESIDE_SHADE_CAP = 6;
/** A darker region with at least this share of its border on kept trim line work is trim (exempt from the cap). */
export const TRIM_BOUND_FRAC = 0.25;
/** How far past the stroke edge the cap holds: the flank gate's scope, 3 stroke widths from the centre
 * line (main branch item 7), and at least the beside-stroke band. */
export const besideHold = (strokeWidth: number) => Math.max(strokeWidth * SHADE_BESIDE_STROKE, 3 * strokeWidth - strokeWidth / 2);
/** Padding ring past the mesh footprint (px). */
export const PAD = 4;
/** Contact-shadow easing radius around the declared underarm taper (px). */
export const SHADOW_R = 16;
/** The tone reference beside a stroke sits this many stroke widths past the stroke edge: the art just
 * inward of the outline band, so the art's broad form shading carries to the ink and only darker paint hugging the
 * stroke (a line, a side panel) is lifted. */
export const REF_STROKES = 2;
/** The lift's base averages a texel's own tone area: paint within this many luminance levels of it. */
export const TONE_EDGE = 16;
/** Share of the base window a tone area needs before it is an area (smaller: a line or a fleck, texture); full at twice it. */
export const TONE_AREA_MIN = 0.2;

const isCream = (r: number, g: number, b: number) => r > 175 && g > 155 && b > 130;
// Ink is found by position (tools/garmentInk.ts): the outline band of the art's silhouette and line
// work in the outline's own ink; never by a colour family (brown leather was stripped as ink).
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function segDist(p: Pt, s: Pt, e: Pt): number {
  const vx = e[0] - s[0];
  const vy = e[1] - s[1];
  const l2 = vx * vx + vy * vy || 1;
  const u = Math.max(0, Math.min(1, ((p[0] - s[0]) * vx + (p[1] - s[1]) * vy) / l2));
  return Math.hypot(p[0] - s[0] - vx * u, p[1] - s[1] - vy * u);
}

/** Rest canvas positions of the build's vertices (from the frozen UVs). */
export function restPositions(build: GarmentBuild): Pt[] {
  const a = build.attachment;
  const n = a.uvs.length / 2;
  return Array.from({ length: n }, (_, i) => [(a.uvs[i * 2] as number) * a.width + build.origin[0], (a.uvs[i * 2 + 1] as number) * a.height + build.origin[1]] as Pt);
}

/** Rest boundary edges of the garment mesh (one triangle), as vertex pairs. */
/** Rows above a hem the trim zone may reach (cream trim, its ink, a placket running into it). */
const HEM_ZONE = 40;
/** Fabric rows kept between the trim zone and the inserted band (no antialiased blend is repeated). */
const HEM_INSERT_ABOVE = 4;

/**
 * The art for a hem lengthened by `dy` px: a
 * deterministic edit, no squashing. Within the hem's columns, one insertion row g is taken a few
 * rows above the median top of the bottom trim zone (the run of cream/ink texels ending at the
 * art's bottom edge in that column); every texel at or below g moves `dy` down (the cream trim keeps
 * its thickness and lands on the new hem line) and the `dy` rows opened at g repeat the row above
 * g (the fabric and the placket continue straight down).
 */
export function lengthenHemArt(art: RgbaImage, hem: readonly Pt[], dy: number): { art: RgbaImage; insertRow: number; columns: [number, number] } {
  const W = art.width;
  const H = art.height;
  const at = (x: number, y: number) => (y * W + x) * 4;
  const inkMask = artOutlineInk(art).mask;
  const xs = hem.map((p) => p[0]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 24);
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 24);
  const hemY = Math.max(...hem.map((p) => p[1]));
  const tops: number[] = [];
  for (let x = x0; x <= x1; x++) {
    let bottom = -1;
    for (let y = Math.min(H - 1, Math.round(hemY + 30)); y >= hemY - 50; y--) if ((art.data[at(x, y) + 3] as number) >= 128) { bottom = y; break; }
    if (bottom < 0) continue;
    let y = bottom;
    while (y > bottom - HEM_ZONE) {
      const o = at(x, y - 1);
      const [r, g, b, al] = [art.data[o] as number, art.data[o + 1] as number, art.data[o + 2] as number, art.data[o + 3] as number];
      if (al < 128 || !(isCream(r, g, b) || inkMask[(y - 1) * W + x])) break;
      y--;
    }
    if (y > bottom - HEM_ZONE) tops.push(y);
  }
  if (!tops.length) throw new Error("lengthenHemArt: no trim zone above the hem");
  tops.sort((p, q) => p - q);
  const g = (tops[Math.floor(tops.length / 2)] as number) - HEM_INSERT_ABOVE;
  const out: RgbaImage = { width: W, height: H, data: new Uint8Array(art.data) };
  for (let x = x0; x <= x1; x++) {
    for (let y = H - 1; y >= g + dy; y--) out.data.set(art.data.subarray(at(x, y - dy), at(x, y - dy) + 4), at(x, y));
    for (let y = g; y < Math.min(H, g + dy); y++) out.data.set(art.data.subarray(at(x, g - 1), at(x, g - 1) + 4), at(x, y));
  }
  return { art: out, insertRow: g, columns: [x0, x1] };
}

export function boundaryEdges(build: GarmentBuild): [number, number][] {
  const T: number[] = build.attachment.triangles;
  const count = new Map<string, [number, number, number]>();
  for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k] as number;
    const b = T[t * 3 + ((k + 1) % 3)] as number;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const c = count.get(key);
    if (c) c[2]++; else count.set(key, [a, b, 1]);
  }
  return [...count.values()].filter((c) => c[2] === 1).map((c) => [c[0], c[1]]);
}

export interface PaintReport {
  rect: [number, number, number, number];
  footprintPx: number;
  inkRemovedPx: number;
  inkKeptPx: number;
  emptyFilledPx: number;
  shadowEasedPx: number;
  /** Darker painted shading eased beside a boundary stroke (no doubled outline). */
  besideStrokeShadeEasedPx: number;
  /** Refilled texels of the removed outline strip beside a run stroke given the art's texture mirrored inward. */
  stripExtrudedPx: number;
  /** Texture and tone continuity across the last FLANK_BAND px inside the side outline (tools/flankBand.ts); null without a trunk. */
  flankBand: { windows: number; failed: number; worstDarkDelta: number; worstTexRatio: number | null; at: string[]; texturedWindows: number; controlDarkFailed: number; controlFlatFailed: number; controlsFail: boolean; artPlainWindows: string[]; ok: boolean };
  padPx: number;
  restOverlapPx: number;
  restOverlapGroups: string[];
  creamPx: number;
  creamPreserved: number;
  /** Share of the art's kept trim line texels (lines between two paints) that leave the painter unchanged. */
  trimLinePreserved: number;
  /** Ink texels left in the stroke band of the rest boundary (runtime ink only belongs there). */
  residualSilhouetteInk: number;
  /** Ink texels away from any trim or closure (painted piece edges): replaced by runtime contours. Kept trim line work (garmentInk trimLine: a line between two materials) is trim, not a piece edge. */
  residualOcclusionInk: number;
  fabricMedian: [number, number, number];
}

/**
 * The completed texture of a build from canvas-aligned art (see the file comment). Returns the
 * texture (the build's texture rectangle) and a classification image for the evidence (kept ink
 * green, removed ink red, completed empty texels blue, eased shadow yellow, padding grey).
 */
export function paintGarmentTexture(build: GarmentBuild, art: RgbaImage, opts: { strokeWidth: number; margin: number; trunk?: string }): { texture: RgbaImage; classes: RgbaImage; report: PaintReport; flankField: FlankField } {
  const a = build.attachment;
  const [left, top] = build.origin;
  const W = a.width as number;
  const H = a.height as number;
  const rest = restPositions(build);
  const T: number[] = a.triangles;
  // footprint per draw group (bit per group) at rest
  const groupOf: number[] = [];
  const groupNames = Object.keys(a.groups as Record<string, unknown>);
  groupNames.forEach((g, gi) => { for (const [s, e] of (a.groups as Record<string, [number, number][]>)[g] as [number, number][]) for (let t = s; t < e; t++) groupOf[t] = gi; });
  const foot = new Uint32Array(W * H);
  for (let t = 0; t < T.length / 3; t++) {
    const p = [0, 1, 2].map((k) => rest[T[t * 3 + k] as number] as Pt);
    const [p0, p1, p2] = p as [Pt, Pt, Pt];
    const den = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(den) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0]) - left));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0]) - left));
    const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1]) - top));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1]) - top));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + left + 0.5;
      const py = y + top + 0.5;
      const l1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / den;
      const l2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / den;
      if (l1 < -0.02 || l2 < -0.02 || l1 + l2 > 1.02) continue;
      foot[y * W + x] = (foot[y * W + x] as number) | (1 << (groupOf[t] ?? 0));
    }
  }
  // distance to the runtime strokes' rest centreline: the garment boundary, except unstroked cuts
  // (their painted ink stays) and cuts stroked inside the garment (their own inset centreline)
  const ekey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  const painted = new Set([...(build.paintedEdges ?? []), ...(build.insetCuts ?? []).flatMap((c) => c.edges)].map(([u, v]) => ekey(u, v)));
  const edges = boundaryEdges(build).filter(([u, v]) => !painted.has(ekey(u, v))).map(([u, v]) => [rest[u] as Pt, rest[v] as Pt] as [Pt, Pt]);
  const restOf = (q: number | readonly number[]): Pt => {
    if (typeof q === "number") return rest[q] as Pt;
    const [a, b, c, wa, wb] = q as [number, number, number, number, number];
    const [A, B, C] = [rest[a] as Pt, rest[b] as Pt, rest[c] as Pt];
    return [A[0] * wa + B[0] * wb + C[0] * (1 - wa - wb), A[1] * wa + B[1] * wb + C[1] * (1 - wa - wb)];
  };
  for (const c of build.insetCuts ?? []) for (let k = 0; k + 1 < c.points.length; k++) edges.push([restOf(c.points[k] as number), restOf(c.points[k + 1] as number)]);
  const bdist = new Float32Array(W * H).fill(Infinity);
  const half = opts.strokeWidth / 2;
  // the field reaches past every band that reads it
  const reach = half + Math.max(TRIM_INK + 4, INK_BESIDE_STROKE, besideHold(opts.strokeWidth) + opts.strokeWidth * SHADE_BESIDE_STROKE, 2) + 2;
  for (const [s, e] of edges) {
    const r = reach;
    const x0 = Math.max(0, Math.floor(Math.min(s[0], e[0]) - r - left));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(s[0], e[0]) + r - left));
    const y0 = Math.max(0, Math.floor(Math.min(s[1], e[1]) - r - top));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(s[1], e[1]) + r - top));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dd = segDist([x + left + 0.5, y + top + 0.5], s, e);
      if (dd < (bdist[y * W + x] as number)) bdist[y * W + x] = dd;
    }
  }
  // distance to the cut strokes alone (every stroked edge that is not a silhouette run edge), for the flank band gate
  const runEdgeKeys = new Set(build.runs.flatMap((run) => run.outer.map((u, k) => (k + 1 < run.outer.length || run.cyclic ? ekey(u, run.outer[(k + 1) % run.outer.length] as number) : ""))));
  const cutEdges = [
    ...boundaryEdges(build).filter(([u, v]) => !painted.has(ekey(u, v)) && !runEdgeKeys.has(ekey(u, v))).map(([u, v]) => [rest[u] as Pt, rest[v] as Pt] as [Pt, Pt]),
    ...edges.slice(edges.length - (build.insetCuts ?? []).reduce((a, c) => a + Math.max(0, c.points.length - 1), 0))
  ];
  const bdistCut = new Float32Array(W * H).fill(Infinity);
  for (const [s, e] of cutEdges) {
    const r = reach + FLANK_CUT_CLEAR * FLANK_BAND;
    const x0 = Math.max(0, Math.floor(Math.min(s[0], e[0]) - r - left));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(s[0], e[0]) + r - left));
    const y0 = Math.max(0, Math.floor(Math.min(s[1], e[1]) - r - top));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(s[1], e[1]) + r - top));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dd = segDist([x + left + 0.5, y + top + 0.5], s, e);
      if (dd < (bdistCut[y * W + x] as number)) bdistCut[y * W + x] = dd;
    }
  }
  // distance to the silhouette run strokes alone (not the cuts: hem, neckline, cuffs), for the beside-stroke cap
  const bdistRun = new Float32Array(W * H).fill(Infinity);
  const bdistOther = new Float32Array(W * H).fill(Infinity);
  const runSide = new Int16Array(W * H).fill(-1);
  build.runs.forEach((run, ri) => {
    const o = run.outer;
    const n = o.length;
    for (let k = 0; k + (run.cyclic ? 0 : 1) < n; k++) {
      const u = o[k] as number;
      const v = o[(k + 1) % n] as number;
      if (u === v) continue;
      const S = rest[u] as Pt;
      const E = rest[v] as Pt;
      const x0 = Math.max(0, Math.floor(Math.min(S[0], E[0]) - reach - left));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(S[0], E[0]) + reach - left));
      const y0 = Math.max(0, Math.floor(Math.min(S[1], E[1]) - reach - top));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(S[1], E[1]) + reach - top));
      // the side flank (flank band gate): a trunk cell running more down than across
      const flankSeg = !!opts.trunk && run.cellGroup[Math.min(k, run.cellGroup.length - 1)] === opts.trunk && Math.abs(E[1] - S[1]) > Math.abs(E[0] - S[0]);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dd = segDist([x + left + 0.5, y + top + 0.5], S, E);
        if (dd < (bdistRun[y * W + x] as number)) { bdistRun[y * W + x] = dd; runSide[y * W + x] = flankSeg ? ri : -1; }
        if (!flankSeg && dd < (bdistOther[y * W + x] as number)) bdistOther[y * W + x] = dd;
      }
    }
  });
  // art in the rectangle; cream distance (chamfer)
  const px = (x: number, y: number): [number, number, number, number] => {
    const cx = x + left;
    const cy = y + top;
    if (cx < 0 || cy < 0 || cx >= art.width || cy >= art.height) return [0, 0, 0, 0];
    const o = (cy * art.width + cx) * 4;
    return [art.data[o] as number, art.data[o + 1] as number, art.data[o + 2] as number, art.data[o + 3] as number];
  };
  const ink = artOutlineInk(art);
  const inkAt = (x: number, y: number): boolean => {
    const cx = x + left;
    const cy = y + top;
    return cx >= 0 && cy >= 0 && cx < art.width && cy < art.height && ink.mask[cy * art.width + cx] === 1;
  };

  const creamD = new Float32Array(W * H).fill(1e9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b, al] = px(x, y); if (al >= 200 && isCream(r, g, b)) creamD[y * W + x] = 0; }
  for (const pass of [0, 1]) {
    const ys = pass ? [...Array(H).keys()].reverse() : [...Array(H).keys()];
    const xs = pass ? [...Array(W).keys()].reverse() : [...Array(W).keys()];
    const st = pass ? 1 : -1;
    for (const y of ys) for (const x of xs) {
      let v = creamD[y * W + x] as number;
      for (const [dx, dy, w] of [[st, 0, 1], [0, st, 1], [st, st, 1.414], [-st, st, 1.414]] as const) {
        const X = x + dx;
        const Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        v = Math.min(v, (creamD[Y * W + X] as number) + w);
      }
      creamD[y * W + x] = v;
    }
  }
  // interior outline-ink line work between two materials (a belt edge, a collar band): trim detail.
  // A line that edges cream trim anywhere stays under the cream rule (TRIM_INK) as before.
  const compAt = (x: number, y: number): number => {
    const cx = x + left;
    const cy = y + top;
    return cx >= 0 && cy >= 0 && cx < art.width && cy < art.height ? (ink.trimComp[cy * art.width + cx] as number) : -1;
  };
  // A line counts as a cream edge only where it mostly edges cream: a belt edge that merely touches a pale
  // metal buckle (armour, leather -05: buckle 184,185,177 reads as cream) is still a belt edge, and
  // under the cream rule everything past TRIM_INK of the buckle was removed (the strap vanished).
  const compTotal = new Map<number, number>();
  const compNearCream = new Map<number, number>();
  for (let i = 0; i < W * H; i++) {
    const c = compAt(i % W, Math.floor(i / W));
    if (c < 0) continue;
    compTotal.set(c, (compTotal.get(c) ?? 0) + 1);
    if ((creamD[i] as number) <= TRIM_INK) compNearCream.set(c, (compNearCream.get(c) ?? 0) + 1);
  }
  const creamComps = new Set<number>();
  for (const [c, n] of compNearCream) if (n >= CREAM_EDGE_SHARE * (compTotal.get(c) as number)) creamComps.add(c);
  const trimLineAt = (x: number, y: number): boolean => { const c = compAt(x, y); return c >= 0 && !creamComps.has(c); };
  // fabric median (opaque, not ink, not cream, inside the footprint away from the boundary)
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < W * H; i += 3) {
    if (!foot[i] || (bdist[i] as number) < half + 2) continue;
    const [r, g, b, al] = px(i % W, Math.floor(i / W));
    if (al < 250 || inkAt(i % W, Math.floor(i / W)) || isCream(r, g, b)) continue;
    ch[0]?.push(r); ch[1]?.push(g); ch[2]?.push(b);
  }
  const med = ch.map((c) => c.sort((p, q) => p - q)[Math.floor(c.length / 2)] ?? 60) as [number, number, number];
  // classes: 0 outside, 1 known, 2 removed ink, 3 empty, 4 pad
  const cls = new Uint8Array(W * H);
  const col = new Float32Array(W * H * 3);
  const near = (i: number, r: number, f: (j: number) => boolean) => { const x = i % W; const y = (i - x) / W; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H && f(Y * W + X)) return true; } return false; };
  let inkRemoved = 0;
  let inkKept = 0;
  let empty = 0;
  let pad = 0;
  let creamPx = 0;
  for (let i = 0; i < W * H; i++) {
    const inFoot = foot[i] !== 0;
    const inPad = !inFoot && near(i, PAD, (j) => foot[j] !== 0);
    if (!inFoot && !inPad) continue;
    const [r, g, b, al] = px(i % W, Math.floor(i / W));
    if (inPad) { cls[i] = 4; pad++; continue; }
    if (al < 250) { cls[i] = 3; empty++; continue; }
    if (isCream(r, g, b)) creamPx++;
    // under or beside a runtime stroke, a texel in the outline ink colour is the painted copy of that
    // outline even where the position detector missed it (armour: the jacket's neckline, a
    // stroked boundary since item 4, kept 65,29,16 texels that then seeded the completion)
    const strokeInk = (bdist[i] as number) <= half + INK_BESIDE_STROKE && isOutlineInkColour(ink, r, g, b);
    if (inkAt(i % W, Math.floor(i / W)) || strokeInk) {
      // trim ink between the cream and the boundary stroke (within
      // INK_BESIDE_STROKE of its edge) is the painted copy of that outline (the collar crescent): removed
      // an interior trim line (a belt edge) runs on up to the stroke it meets: removing its stroke-side end left a
      // gap the completion refilled with ink-dark paint (armour); cream-edge ink keeps the wider clearance
      const keep = ((creamD[i] as number) <= TRIM_INK && (bdist[i] as number) > half + INK_BESIDE_STROKE) || (trimLineAt(i % W, Math.floor(i / W)) && (bdist[i] as number) > half);
      if (keep) { inkKept++; cls[i] = 1; } else { inkRemoved++; cls[i] = 2; }
    } else cls[i] = 1;
    col.set([r, g, b], i * 3);
  }
  // (gapKept: these texels count as the kept line from here on: the halo skips them, the residual ink report too)
  const gapKept = new Uint8Array(W * H);
  // gaps in kept line work (Jade C belt edges): a removed ink texel past the stroke's reach with kept trim
  // line ink on both sides within GAP_FILL px along one axis is a texel of that kept line the trim vote missed
  // (its own sides read the line's shading, no vote); removing it refilled fabric between kept texels and the
  // belt's edge read as dark ticks. A piece-edge line inside one material has no kept ink beside it: unchanged.
  {
    const keptLine = (X: number, Y: number) => X >= 0 && Y >= 0 && X < W && Y < H && cls[Y * W + X] === 1 && inkAt(X, Y) && trimLineAt(X, Y);
    const gaps: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (cls[i] !== 2 || (bdist[i] as number) <= half + INK_BESIDE_STROKE || (creamD[i] as number) <= TRIM_INK) continue;
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
        let a = false, b = false;
        for (let k = 1; k <= GAP_FILL && !(a && b); k++) { a ||= keptLine(x + dx * k, y + dy * k); b ||= keptLine(x - dx * k, y - dy * k); }
        if (a && b) { gaps.push(i); break; }
      }
    }
    for (const i of gaps) { cls[i] = 1; gapKept[i] = 1; inkRemoved--; inkKept++; }
  }
  // halo: one ring touching removed ink goes too: antialiased blends of the outline ink into the
  // fabric, and the edge texel of kept outline ink where it meets removed ink (as the colour halo did)
  const halo: number[] = [];
  for (let i = 0; i < W * H; i++) {
    // a kept interior trim line keeps its end texel where it meets its removed stroke-side piece (armour round
    // 14: the halo cut the belt edge's end and the completion refilled it with ink-dark paint)
    if (cls[i] !== 1 || gapKept[i] || (inkAt(i % W, Math.floor(i / W)) && trimLineAt(i % W, Math.floor(i / W)))) continue;
    const [r, g, b] = [col[i * 3] as number, col[i * 3 + 1] as number, col[i * 3 + 2] as number];
    if ((inkAt(i % W, Math.floor(i / W)) || isInkBlend(ink, med, r, g, b)) && lum(r, g, b) < lum(...med) + 25 && near(i, 1, (j) => cls[j] === 2)) halo.push(i);
  }
  for (const i of halo) { cls[i] = 2; inkRemoved++; }
  // completion: wavefront average from known texels
  const known = new Uint8Array(W * H);
  // sources: kept material that is not ink (kept trim ink never spreads into completed texels)
  for (let i = 0; i < W * H; i++) known[i] = cls[i] === 1 && !inkAt(i % W, Math.floor(i / W)) ? 1 : 0;
  // Removed ink (class 2) is refilled only from paint that is not ink-dark (garmentInk isInkDark: the outline, its
  // blends and near-ink shading such as a dark strap shade), and never to an ink-dark colour: when the neighbour
  // average lands ink-dark (near-ink shades on two sides of the outline colour average back into it), the
  // neighbour farthest from the ink is taken instead (Jade C strap edge against the mail). A removed
  // texel with no such neighbour waits for the fill to reach it; one that never gets one (an art that is ink-dark
  // throughout) takes the nearest kept paint that is not ink-dark (a removed line inside a near-ink strap shade:
  // the fabric beside the strap), and only an art with no such paint at all falls back to the plain average.
  // Empty and padding texels fill as before.
  const darkAt = (j: number) => isInkDark(ink, col[j * 3] as number, col[j * 3 + 1] as number, col[j * 3 + 2] as number);
  const nearestClean = new Int32Array(W * H).fill(-1);
  {
    let q: number[] = [];
    for (let i = 0; i < W * H; i++) if (known[i] && !darkAt(i)) { nearestClean[i] = i; q.push(i); }
    while (q.length) {
      const nq: number[] = [];
      for (const i of q) {
        const x = i % W;
        const y = (i - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H || (nearestClean[Y * W + X] as number) >= 0) continue;
          nearestClean[Y * W + X] = nearestClean[i] as number;
          nq.push(Y * W + X);
        }
      }
      q = nq;
    }
  }
  let front = [...Array(W * H).keys()].filter((i) => cls[i] !== 0 && cls[i] !== 1);
  const filled: number[] = [];
  for (const strict of [true, false]) {
    if (!strict) {
      // removed ink the clean wavefront could not reach (walled in by near-ink shading): nearest clean paint
      const rest: number[] = [];
      for (const i of front) {
        const j = cls[i] === 2 ? (nearestClean[i] as number) : -1;
        if (j < 0) { rest.push(i); continue; }
        col.set([col[j * 3] as number, col[j * 3 + 1] as number, col[j * 3 + 2] as number], i * 3);
        known[i] = 1;
        filled.push(i);
      }
      front = rest;
    }
    while (front.length) {
      const next: number[] = [];
      const set: [number, number, number, number][] = [];
      for (const i of front) {
        const x = i % W;
        const y = (i - x) / W;
        const clean = strict && cls[i] === 2;
        let n = 0;
        const s: [number, number, number] = [0, 0, 0];
        let far = -1;
        let farD = -1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (!(dx || dy) || X < 0 || Y < 0 || X >= W || Y >= H || !known[Y * W + X]) continue;
          const j = Y * W + X;
          if (clean && darkAt(j)) continue;
          s[0] += col[j * 3] as number; s[1] += col[j * 3 + 1] as number; s[2] += col[j * 3 + 2] as number; n++;
          if (clean && ink.outline) { const dd = Math.hypot((col[j * 3] as number) - ink.outline[0], (col[j * 3 + 1] as number) - ink.outline[1], (col[j * 3 + 2] as number) - ink.outline[2]); if (dd > farD) { farD = dd; far = j; } }
        }
        if (!n) { next.push(i); continue; }
        const avg: [number, number, number] = [s[0] / n, s[1] / n, s[2] / n];
        if (clean && far >= 0 && isInkDark(ink, ...avg)) set.push([i, col[far * 3] as number, col[far * 3 + 1] as number, col[far * 3 + 2] as number]);
        else set.push([i, ...avg]);
      }
      if (!set.length) break;
      for (const [i, r, g, b] of set) { col.set([r, g, b], i * 3); known[i] = 1; filled.push(i); }
      front = next;
    }
  }
  // light smoothing of the completed texels (two 3x3 box passes, reading everything but kept ink: armour,
  // kept belt edge ink smeared outline-dark paint into the completed end of the line). Refilled removed ink reads
  // no ink-dark paint and keeps its fill when the smoothed colour would be ink-dark.
  const cleanFill = new Uint8Array(W * H);
  for (const i of filled) if (cls[i] === 2 && !darkAt(i)) cleanFill[i] = 1;
  for (let pass = 0; pass < 2; pass++) {
    const prev = col.slice();
    const prevDark = (j: number) => isInkDark(ink, prev[j * 3] as number, prev[j * 3 + 1] as number, prev[j * 3 + 2] as number);
    for (const i of filled) {
      const x = i % W;
      const y = (i - x) / W;
      let n = 0;
      const s: [number, number, number] = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H && cls[Y * W + X] && !(cls[Y * W + X] === 1 && inkAt(X, Y)) && !(cleanFill[i] && prevDark(Y * W + X))) { const j = Y * W + X; s[0] += prev[j * 3] as number; s[1] += prev[j * 3 + 1] as number; s[2] += prev[j * 3 + 2] as number; n++; } }
      if (!n) continue;
      const avg: [number, number, number] = [s[0] / n, s[1] / n, s[2] / n];
      if (cleanFill[i] && isInkDark(ink, ...avg)) continue;
      col.set(avg, i * 3);
    }
  }
  // the removed outline strip beside a run stroke has no art of its own: the completion's neighbour average left
  // a flat smear there (Jade C flank). The art's texture continues outward along the stroke normal
  // instead: each refilled texel within the strip takes the art texel mirrored across the edge of the kept paint
  // (the walk follows the run-distance gradient inward), so quilting and shading run on up to the stroke.
  const gradStep = (field: Float32Array, x: number, y: number): [number, number] | null => {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const at = (u: number, v: number) => (u < 0 || v < 0 || u >= W || v >= H ? 1e6 : Math.min(field[v * W + u] as number, 1e6));
    let gx = (at(X + 1, Y) - at(X - 1, Y)) / 2;
    let gy = (at(X, Y + 1) - at(X, Y - 1)) / 2;
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-6 || gl > 1e5) return null;
    gx /= gl;
    gy /= gl;
    return [gx, gy];
  };
  const artPaint = (j: number) => cls[j] === 1 && !inkAt(j % W, Math.floor(j / W));
  let stripExtruded = 0;
  {
    const strip = half + INK_BESIDE_STROKE + TRIM_INK;
    const prev = col.slice();
    for (const i of filled) {
      if (cls[i] !== 2 && cls[i] !== 3) continue;
      if (!((bdistRun[i] as number) < strip) || (bdist[i] as number) < (bdistRun[i] as number) - 0.5) continue;
      let x = (i % W) + 0.5;
      let y = Math.floor(i / W) + 0.5;
      let s0 = -1;
      const path: number[] = [];
      for (let step = 0; step < 4 * strip; step++) {
        const j = Math.floor(y) * W + Math.floor(x);
        path.push(j);
        if (s0 < 0 && step > 0 && artPaint(j)) s0 = step;
        if (s0 >= 0 && step >= 2 * s0) break;
        const g = gradStep(bdistRun, x, y);
        if (!g) break;
        x += g[0];
        y += g[1];
        if (x < 0 || y < 0 || x >= W || y >= H) break;
      }
      if (s0 < 0) continue;
      const k = path[Math.min(path.length - 1, 2 * s0)] as number;
      // the mirrored texel must be the art's own paint of the same draw group, else the nearest kept texel
      const src = artPaint(k) && (foot[k] as number) & (foot[i] as number) ? k : (path[s0] as number);
      if (!((foot[src] as number) & (foot[i] as number) || !foot[i])) continue;
      col.set([prev[src * 3] as number, prev[src * 3 + 1] as number, prev[src * 3 + 2] as number], i * 3);
      stripExtruded++;
    }
  }
  // Tone near the outline (contact shadow around the declared underarm taper, the beside-stroke cap, owner
  // review / armour). Both used to pull darker paint toward the garment's single fabric
  // median, which on a patterned, multi-material piece flattened the art's texture and swapped its hue for the
  // median's (Jade C: a grey-green band with no quilting down both flanks). Both now lift the LOCAL tone
  // only: the reference is the art's own tone just past the eased zone (the box-blurred luminance there, reached
  // along the stroke-distance gradient), the lift is a gain on the texel's colour computed from its blurred
  // luminance, so the texture's relative contrast and the art's hue carry on up to the ink. A darker painted line
  // beside the stroke is still lifted to within BESIDE_SHADE_CAP of the fabric beside it (the doubled-line rule).
  // Cream, kept trim line work and trim-bounded regions are left alone.
  let shadow = 0;
  const shadowMask = new Uint8Array(W * H);
  let besideShade = 0;
  const band = opts.strokeWidth * SHADE_BESIDE_STROKE;
  const keptTrim = (i: number) => cls[i] === 1 && inkAt(i % W, Math.floor(i / W));
  const medLum = lum(...med);
  const hold = besideHold(opts.strokeWidth);
  const zoneEnd = hold + band;
  const lumAt = (i: number) => lum(col[i * 3] as number, col[i * 3 + 1] as number, col[i * 3 + 2] as number);
  // darker than the fabric median by more than the cap: the trim-region and crossing tests (unchanged)
  const darker = (i: number) => !!cls[i] && cls[i] !== 4 && !!foot[i] && !keptTrim(i) && medLum - lumAt(i) > BESIDE_SHADE_CAP;
  // trim survives the cap (armour: the cap flattened the leather's belt strap and its edge lines,
  // within reach of the hem stroke). Kept trim line work is never eased. A darker region is judged as a
  // beside a cut stroke (hem, neckline, cuff) as a whole: capped unless trim-bounded (a belt strap, a collar
  // band: most of its border is kept trim line); beside a silhouette run stroke per texel (crossesInward).
  const trimBound = new Uint8Array(W * H);
  {
    const seen = new Uint8Array(W * H);
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (let s0 = 0; s0 < W * H; s0++) {
      if (seen[s0] || !darker(s0)) continue;
      const comp = [s0];
      seen[s0] = 1;
      const edge = new Set<number>();
      for (let q = 0; q < comp.length; q++) {
        const i = comp[q] as number;
        const x = i % W;
        const y = (i - x) / W;
        for (const [dx, dy] of N4) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const j = Y * W + X;
          if (darker(j)) { if (!seen[j]) { seen[j] = 1; comp.push(j); } } else if (cls[j]) edge.add(j);
        }
      }
      let trim = 0;
      for (const j of edge) if (keptTrim(j)) trim++;
      const isTrim = edge.size > 0 && trim / edge.size >= TRIM_BOUND_FRAC;
      if (isTrim) for (const i of comp) trimBound[i] = 1;
    }
  }
  // a band of darker paint between two kept trim lines (a belt strap between its edge lines) is trim, even where
  // its region touches a darker side panel and so fails the region's border share (armour, leather -05):
  // walking up and down (or left and right) through darker paint reaches kept trim line work on both sides
  {
    const reachBand = 4 * opts.strokeWidth;
    const hits = (i: number, dx: number, dy: number): boolean => {
      let x = i % W;
      let y = (i - x) / W;
      for (let k = 0; k < reachBand; k++) {
        x += dx;
        y += dy;
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const j = y * W + x;
        if (keptTrim(j)) return true;
        if (!darker(j)) return false;
      }
      return false;
    };
    for (let i = 0; i < W * H; i++) {
      if (trimBound[i] || !darker(i)) continue;
      if ((hits(i, 0, -1) && hits(i, 0, 1)) || (hits(i, -1, 0) && hits(i, 1, 0))) trimBound[i] = 1;
    }
  }
  // beside a run stroke, a texel whose darker paint continues inward (away from the stroke, along the distance
  // gradient) past the cap's reach belongs to paint crossing the garment (the strap rows of a belt); one whose
  // paint ends first hugs the flank (a side panel), even where the two touch
  const runFar = (j: number) => !Number.isFinite(bdistRun[j] as number) || (bdistRun[j] as number) - half >= zoneEnd;
  const crossesInward = (i: number) => {
    let x = (i % W) + 0.5;
    let y = Math.floor(i / W) + 0.5;
    for (let step = 0; step < 2 * zoneEnd + 4; step++) {
      const j = Math.floor(y) * W + Math.floor(x);
      if (runFar(j)) return true;
      if (!darker(j) && !keptTrim(j)) return false;
      const g = gradStep(bdistRun, x, y);
      if (!g) return false;
      x += g[0];
      y += g[1];
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
    }
    return false;
  };
  // allowed darkness at stroke distance d: 0 at the stroke edge rising to BESIDE_SHADE_CAP over the band,
  // held to the gate's scope, then back to the art's own shade over one band (smoothstep, no step)
  const allowedAt = (d: number, deficit: number) => {
    if (d >= zoneEnd) return Infinity;
    const u = Math.max(0, d - hold) / band;
    return d < hold ? BESIDE_SHADE_CAP * Math.min(1, Math.max(0, d) / band) : BESIDE_SHADE_CAP + Math.max(0, deficit - BESIDE_SHADE_CAP) * u * u * (3 - 2 * u);
  };
  // the tone source (fabric paint: not pad, cream, kept trim or ink-dark) and its box-blurred luminance
  // (not the trim-bound regions: on a quilted piece the whole darker fabric field is bounded by its kept quilting
  // lines; ink-dark paint, a belt or a strap, is left out instead)
  const toneSrc = (i: number) => !!cls[i] && cls[i] !== 4 && !!foot[i] && !keptTrim(i) && (creamD[i] as number) > TRIM_INK && !isCream(col[i * 3] as number, col[i * 3 + 1] as number, col[i * 3 + 2] as number) && !darkAt(i);
  // follow-up: the base never straddles a tone edge running BESIDE the stroke. A plain box there (a side
  // panel's inner edge) gave the panel's last texels a lighter base (lifted too little: a dark line) and the fabric's
  // first texels a darker one (lifted though not darker: a light line), the doubled line of armour. Three
  // means per texel over the tone-source paint: B, the box; E, the box over the texel's own tone area only (texels
  // within TONE_EDGE of it; a tone area under TONE_AREA_MIN of the window, a line or a fleck, is texture and keeps B);
  // T, a line of the same length tangent to the stroke-distance field. Where a tone edge runs beside the stroke the
  // tangent line stays in the texel's tone (T near E) and E is the base; where it runs across the stroke (a drawn
  // chevron, a quilting stitch) T falls between and B keeps the shape's contrast as texture.
  const baseR = Math.max(2, Math.round(opts.strokeWidth / 2));
  const base = new Float32Array(W * H).fill(NaN);
  {
    const L = new Float32Array(W * H).fill(NaN);
    for (let i = 0; i < W * H; i++) if (toneSrc(i)) L[i] = lumAt(i);
    const tl = 2 * baseR;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!cls[i] || cls[i] === 4) continue;
      const c = lumAt(i);
      let sB = 0, nB = 0, sE = 0, nE = 0;
      for (let Y = Math.max(0, y - baseR); Y <= Math.min(H - 1, y + baseR); Y++) for (let X = Math.max(0, x - baseR); X <= Math.min(W - 1, x + baseR); X++) {
        const v = L[Y * W + X] as number;
        if (v !== v) continue;
        sB += v;
        nB++;
        if (Math.abs(v - c) <= TONE_EDGE) { sE += v; nE++; }
      }
      if (!nB) continue;
      const B = sB / nB;
      const w = nE ? Math.min(1, Math.max(0, (nE / nB - TONE_AREA_MIN) / TONE_AREA_MIN)) : 0;
      const E = w * (nE ? sE / nE : B) + (1 - w) * B;
      const g = Number.isFinite(bdist[i] as number) ? gradStep(bdist, x + 0.5, y + 0.5) : null;
      let p = 0;
      if (g && Math.abs(E - B) > 1) {
        let sT = 0, nT = 0;
        for (let k = -tl; k <= tl; k++) {
          const X = Math.floor(x + 0.5 - g[1] * k);
          const Y = Math.floor(y + 0.5 + g[0] * k);
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const v = L[Y * W + X] as number;
          if (v === v) { sT += v; nT++; }
        }
        if (nT) p = Math.max(0, 1 - Math.abs(sT / nT - E) / Math.abs(B - E));
      }
      base[i] = p * E + (1 - p) * B;
    }
  }
  // the reference tone: the blurred art just inward of the outline band (REF_STROKES stroke widths past the stroke
  // edge, or one stroke width past the texel when it lies further in), reached along the stroke-distance gradient
  // (the fabric median where the walk finds no fabric paint: off the footprint, or onto trim). A dark line or a
  // side panel hugging the stroke is darker than this; the art's own broad form shading is not, and is kept.
  const refAt = (i: number): number => {
    let x = (i % W) + 0.5;
    let y = Math.floor(i / W) + 0.5;
    const want = Math.max((bdist[i] as number) - half + opts.strokeWidth, REF_STROKES * opts.strokeWidth);
    for (let step = 0; step < 3 * want + 8; step++) {
      const j = Math.floor(y) * W + Math.floor(x);
      if (!foot[j] && step > 2) break;
      if (((bdist[j] as number) - half >= want || !Number.isFinite(bdist[j] as number)) && toneSrc(j) && !Number.isNaN(base[j] as number)) return base[j] as number;
      const g = gradStep(bdist, x, y);
      if (!g) break;
      x += g[0];
      y += g[1];
      if (x < 0 || y < 0 || x >= W || y >= H) break;
    }
    return medLum;
  };
  const taperPts: Pt[] = [];
  for (const run of build.runs) run.anchors.forEach((v, i) => { if (Math.abs(run.dAt[i] as number) < opts.margin - 1e-6) taperPts.push(rest[v] as Pt); });
  // candidates (near a stroke or the taper) and their reference, box-smoothed over the candidates (one stroke width)
  // so neighbouring texels that reach different art along the gradient carry no step
  const cand = new Uint8Array(W * H);
  const taperD = new Float32Array(W * H).fill(Infinity);
  const refRaw = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!cls[i] || cls[i] === 4 || keptTrim(i)) continue;
    const nearStroke = Math.min(bdist[i] as number, bdistRun[i] as number) - half < zoneEnd;
    let dmin = Infinity;
    for (const q of taperPts) dmin = Math.min(dmin, Math.hypot((i % W) + left + 0.5 - q[0], Math.floor(i / W) + top + 0.5 - q[1]));
    taperD[i] = dmin;
    if (!nearStroke && dmin >= SHADOW_R) continue;
    cand[i] = 1;
    refRaw[i] = refAt(i);
  }
  const refS = new Float32Array(W * H);
  {
    const R = Math.max(1, Math.round(opts.strokeWidth));
    const S = new Float64Array((W + 1) * (H + 1));
    const N = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = (y + 1) * (W + 1) + x + 1;
      S[o] = (cand[i] ? (refRaw[i] as number) : 0) + (S[o - 1] as number) + (S[o - W - 1] as number) - (S[o - W - 2] as number);
      N[o] = (cand[i] ? 1 : 0) + (N[o - 1] as number) + (N[o - W - 1] as number) - (N[o - W - 2] as number);
    }
    const box = (A: Float64Array, x0: number, y0: number, x1: number, y1: number) => (A[(y1 + 1) * (W + 1) + x1 + 1] as number) - (A[y0 * (W + 1) + x1 + 1] as number) - (A[(y1 + 1) * (W + 1) + x0] as number) + (A[y0 * (W + 1) + x0] as number);
    for (let i = 0; i < W * H; i++) {
      if (!cand[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      const x0 = Math.max(0, x - R), x1 = Math.min(W - 1, x + R), y0 = Math.max(0, y - R), y1 = Math.min(H - 1, y + R);
      refS[i] = box(S, x0, y0, x1, y1) / box(N, x0, y0, x1, y1);
    }
  }
  const gains: [number, number][] = [];
  for (let i = 0; i < W * H; i++) {
    // (contact-shadow texels too: the underarm taper now ends at the apex, so its shadow
    // easing fades out within the beside-stroke band and left a darker row beside the flank stroke)
    if (!cand[i]) continue;
    const [r, g, b] = [col[i * 3] as number, col[i * 3 + 1] as number, col[i * 3 + 2] as number];
    if (isCream(r, g, b)) continue;
    const bl = Number.isNaN(base[i] as number) ? lum(r, g, b) : (base[i] as number);
    const nearStroke = Math.min(bdist[i] as number, bdistRun[i] as number) - half < zoneEnd;
    const dmin = taperD[i] as number;
    const ref = refS[i] as number;
    const deficit = ref - bl;
    if (deficit <= 0) continue;
    let target = bl;
    let by = 0;
    if (dmin < SHADOW_R && bl < ref - 2) { target = bl + (ref - 2 - bl) * 0.8 * (1 - dmin / SHADOW_R); by = 1; }
    if (foot[i] && (creamD[i] as number) > TRIM_INK && nearStroke) {
      const cutCap = trimBound[i] ? Infinity : allowedAt((bdist[i] as number) - half, deficit);
      const runCapRaw = allowedAt((bdistRun[i] as number) - half, deficit);
      const allowed = Math.min(cutCap, runCapRaw < deficit && crossesInward(i) ? Infinity : runCapRaw);
      if (deficit > allowed && ref - allowed > target) { target = ref - allowed; by = 2; }
    }
    if (!by || target <= bl + 1e-3) continue;
    gains.push([i, target / Math.max(bl, 1)]);
    if (by === 1) { shadow++; shadowMask[i] = 1; } else besideShade++;
  }
  for (const [i, k] of gains) for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.min(255, (col[i * 3 + c] as number) * k);
  // output texture + classes image
  const texture: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  const classes: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  let restOverlap = 0;
  const overlapGroups = new Set<string>();
  let residualSil = 0;
  let residualOcc = 0;
  let creamKept = 0;
  let trimLinePx = 0;
  let trimLineKept = 0;
  for (let i = 0; i < W * H; i++) {
    const f = foot[i] as number;
    if (f & (f - 1)) { restOverlap++; groupNames.forEach((g, gi) => { if (f & (1 << gi)) overlapGroups.add(g); }); }
    if (!cls[i]) continue;
    const rgb = [Math.round(col[i * 3] as number), Math.round(col[i * 3 + 1] as number), Math.round(col[i * 3 + 2] as number)] as [number, number, number];
    texture.data.set([...rgb, 255], i * 4);
    if (f && isOutlineInkColour(ink, ...rgb)) { if ((bdist[i] as number) <= half) residualSil++; if ((creamD[i] as number) > TRIM_INK && !(cls[i] === 1 && (trimLineAt(i % W, Math.floor(i / W)) || gapKept[i]))) residualOcc++; }
    if (f && cls[i] === 1) { const [r, g, b] = px(i % W, Math.floor(i / W)); if (isCream(r, g, b)) creamKept++; }
    // every texel of the art's interior trim lines that are not cream edges (outside the strokes' reach), not only
    // the ones the painter chose to keep: a dropped belt edge counts as lost (armour). Cream-edge lines
    // are judged by the cream rule (their painted outline copies past TRIM_INK are removed on purpose).
    if (f && (keptTrim(i) || (trimLineAt(i % W, Math.floor(i / W)) && (bdist[i] as number) > half + INK_BESIDE_STROKE + 2))) { trimLinePx++; const [r, g, b] = px(i % W, Math.floor(i / W)); if (Math.abs(rgb[0] - r) + Math.abs(rgb[1] - g) + Math.abs(rgb[2] - b) <= 6) trimLineKept++; }
    const c = cls[i] === 4 ? [150, 150, 150] : cls[i] === 3 ? [60, 90, 255] : cls[i] === 2 ? [255, 40, 40] : shadowMask[i] ? [255, 220, 0] : isOutlineInkColour(ink, ...rgb) ? [40, 200, 60] : rgb.map((v) => Math.round(v * 0.6 + 60));
    classes.data.set([...(c as number[]), 255], i * 4);
  }
  // the flank band gate: the side flank texels between the arms' and the cuts' reach
  const flankField: FlankField = { width: W, height: H, dist: new Float32Array(W * H).fill(NaN), side: new Int16Array(W * H).fill(-1) };
  for (let i = 0; i < W * H; i++) {
    // fabric only (trim and cream are design elements, judged by their own gates), on the trunk's side of the
    // gap to the hanging arm (the trunk stroke nearer by half a stroke), FLANK_CUT_CLEAR bands clear of the cuts
    if ((runSide[i] as number) < 0 || !toneSrc(i)) continue;
    const d = (bdistRun[i] as number) - half;
    if ((bdistOther[i] as number) < (bdistRun[i] as number) + half || (bdistCut[i] as number) - half < FLANK_CUT_CLEAR * FLANK_BAND) continue;
    flankField.dist[i] = d;
    flankField.side[i] = runSide[i] as number;
  }
  // the art's own outline band (its outline ink left out), for windows where the drawing itself is plain there
  const artTex: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  const artField: FlankField = { width: W, height: H, dist: new Float32Array(flankField.dist), side: flankField.side };
  for (let i = 0; i < W * H; i++) {
    artTex.data.set(px(i % W, Math.floor(i / W)), i * 4);
    // (the art's outline ink, its antialiased ring and the removed ink are not the art's fabric texture)
    if (!Number.isNaN(artField.dist[i] as number) && (cls[i] === 2 || near(i, 2, (j) => inkAt(j % W, Math.floor(j / W))))) artField.dist[i] = NaN;
  }
  const flankGate = flankBandGate(texture, flankField, { texture: artTex, field: artField });
  return {
    texture,
    classes,
    flankField,
    report: {
      rect: [left, top, W, H],
      footprintPx: [...foot].filter((f) => f).length,
      inkRemovedPx: inkRemoved,
      inkKeptPx: inkKept,
      emptyFilledPx: empty,
      shadowEasedPx: shadow,
      besideStrokeShadeEasedPx: besideShade,
      stripExtrudedPx: stripExtruded,
      flankBand: { windows: flankGate.result.windows, failed: flankGate.result.failed, worstDarkDelta: flankGate.result.worstDarkDelta, worstTexRatio: flankGate.result.worstTexRatio, at: flankGate.result.at, texturedWindows: flankGate.texturedWindows, controlDarkFailed: flankGate.controlDark, controlFlatFailed: flankGate.controlFlat, controlsFail: flankGate.controlsFail, artPlainWindows: flankGate.artPlain, ok: flankGate.ok },
      padPx: pad,
      restOverlapPx: restOverlap,
      restOverlapGroups: [...overlapGroups],
      creamPx,
      creamPreserved: creamPx ? Number((creamKept / creamPx).toFixed(4)) : 1,
      trimLinePreserved: trimLinePx ? Number((trimLineKept / trimLinePx).toFixed(4)) : 1,
      residualSilhouetteInk: residualSil,
      residualOcclusionInk: residualOcc,
      fabricMedian: med
    }
  };
}

/** First distance (canvas px) along the outward direction from p at which the art is transparent. */
function artExit(art: RgbaImage, p: Pt, n: Pt, max = 40): number {
  for (let t = 0; t <= max; t += 0.5) {
    const x = Math.round(p[0] + n[0] * t);
    const y = Math.round(p[1] + n[1] * t);
    if (x < 0 || y < 0 || x >= art.width || y >= art.height || (art.data[(y * art.width + x) * 4 + 3] as number) < 128) return t;
  }
  return -1;
}

/**
 * Rest silhouette against the art, per boundary anchor with an offset vertex: residual = art exit
 * distance along the anchor's outward offset direction - (its margin + stroke half width), i.e. how
 * far the painted silhouette runs past (+) or inside (-) the runtime one. Anchors whose exit is not
 * found (the art continues across a slit) are skipped.
 */
export function silhouetteResidual(build: GarmentBuild, art: RgbaImage, strokeWidth: number): { run: number; i: number; arc: number; group: string; rest: Pt; residual: number; tapered: boolean }[] {
  const rest = restPositions(build);
  const out: { run: number; i: number; arc: number; group: string; rest: Pt; residual: number; tapered: boolean }[] = [];
  const full = Math.max(...build.runs.map((r) => Math.abs(r.d)));
  build.runs.forEach((run, ri) => {
    let arc = 0;
    run.anchors.forEach((v, i) => {
      if (i > 0) arc += Math.hypot(...((): Pt => { const p = rest[v] as Pt; const q = rest[run.anchors[i - 1] as number] as Pt; return [p[0] - q[0], p[1] - q[1]]; })());
      const o = run.outer[i] as number;
      if (o === v) return;
      const p = rest[v] as Pt;
      const q = rest[o] as Pt;
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const e = artExit(art, p, [(q[0] - p[0]) / l, (q[1] - p[1]) / l]);
      if (e < 0) return;
      out.push({ run: ri, i, arc, group: run.cellGroup[Math.min(i, run.cellGroup.length - 1)] as string, rest: p, residual: Number((e - (Math.abs(run.dAt[i] as number) + strokeWidth / 2)).toFixed(2)), tapered: Math.abs(run.dAt[i] as number) < full - 1e-6 });
    });
  });
  return out;
}

/**
 * Cut details from the art: at each run end next to a cut end of the given kinds (cuffs and hems;
 * a neckline excursion stays a reported deviation), the median residual of the anchors
 * 3-15 px of arc from the end; when it exceeds `minExtra`, a detail {extra, length} with length =
 * the arc where the residual first drops below 1 px (12-60 px). Built on a build WITHOUT details.
 */
export function deriveCutDetails(raw: any, domain: GarmentDomain, build: GarmentBuild, art: RgbaImage, strokeWidth: number, kinds: readonly string[] = ["cuff", "hem"], minExtra = 1.5): NonNullable<GarmentDomain["details"]> {
  const res = silhouetteResidual(build, art, strokeWidth);
  const rest = restPositions(build);
  const out: NonNullable<GarmentDomain["details"]> = [];
  const cutEnds = domain.cuts.map((c) => [materialRestOf(raw, domain, c.points[0] as [number, number, number]), materialRestOf(raw, domain, c.points[c.points.length - 1] as [number, number, number])] as [Pt, Pt]);
  build.runs.forEach((run, ri) => {
    if (run.cyclic) return;
    const k = run.anchors.length;
    const all = res.filter((r) => r.run === ri && !r.tapered);
    const total = Math.max(...all.map((r) => r.arc), 0);
    for (const fromStart of [true, false]) {
      const endPt = rest[run.anchors[fromStart ? 0 : k - 1] as number] as Pt;
      let best: { cut: string; end: 0 | 1; dist: number } | null = null;
      domain.cuts.forEach((c, ci) => kinds.includes(c.kind) && ([0, 1] as const).forEach((end) => { const q = (cutEnds[ci] as [Pt, Pt])[end]; const dd = Math.hypot(q[0] - endPt[0], q[1] - endPt[1]); if (dd <= 8 && (!best || dd < best.dist)) best = { cut: c.name, end, dist: dd }; }));
      if (!best) continue;
      const s = (r: { arc: number }) => (fromStart ? r.arc : total - r.arc);
      const near = all.filter((r) => s(r) >= 3 && s(r) <= 15).map((r) => r.residual).sort((p, q) => p - q);
      const extra = near[Math.floor(near.length / 2)];
      if (extra === undefined || extra < minExtra) continue;
      const along = all.filter((r) => s(r) >= 3).sort((p, q) => s(p) - s(q));
      const drop = along.find((r) => r.residual < 1);
      const length = Math.max(12, Math.min(60, drop ? s(drop) : 60));
      const b = best as { cut: string; end: 0 | 1 };
      out.push({ cut: b.cut, end: b.end, extra: Number(extra.toFixed(2)), length: Number(length.toFixed(1)) });
    }
  });
  return out;
}
