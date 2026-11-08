/*
 * Atlas Animator: original implementation.
 *
 * Which art pixels are the garment's outline ink (the importer removes them and the engine draws its
 * own stroke). pose rule: an outline may be any hue, as long as it is darker than the item. So the
 * ink is found by POSITION, never by a fixed colour family:
 * - the outline colour is learned from the art's own silhouette: the median of the opaque pixels
 *   2-4 px inside the alpha edge (the stroke core, the same ring the swag outlineContrast check reads);
 *   it only counts as ink when it is at least `contrast` darker than the item's fill (the mean
 *   luminance of the opaque pixels more than 14 px inside the edge);
 * - outline band: an opaque pixel within `band` px of the silhouette edge that is darker than the fill
 *   by `contrast` and within `bandTol` of the learned outline colour (the stroke and its blends);
 * - declared interior line work: away from the edge, only lines drawn in the outline's own ink
 *   (within `lineTol` of the learned colour) are ink (the painted piece edges, e.g. a jacket's armhole
 *   curve). Interior paint in any other colour (leather seams, a darker panel, a belt) is paint, even
 *   when it is dark or in the outline's hue family.
 * - trim line work (`trimLine`): an interior outline-ink line that separates two different paint
 *   materials (a belt's edge against the leather, a collar band, cream trim against fabric) is the
 *   item's own detail; the painter keeps it like the ink edging cream trim. A line inside one
 *   material (a jacket's armhole or flank line: grey on both sides) is a piece edge and is removed.
 * (Before this, a red-brown colour test decided: medium brown leather was stripped as ink.)
 */
import { distInside } from "./garmentImport.js";
import type { RgbaImage } from "./image.js";

type Rgb = [number, number, number];

export interface ArtInkOptions {
  /** Silhouette band width (px inside the alpha edge). */
  band?: number;
  /** Luminance the outline must sit below the item's fill. */
  contrast?: number;
  /** Colour distance to the learned outline accepted in the band (stroke plus its antialiased blends). */
  bandTol?: number;
  /** Colour distance to the learned outline accepted for interior line work. */
  lineTol?: number;
}

export interface ArtInk {
  width: number;
  height: number;
  /** 1 = outline ink (art canvas pixels). */
  mask: Uint8Array;
  /** 1 = interior outline-ink line work between two different materials (kept as trim detail). */
  trimLine: Uint8Array;
  /** Line component id (>= 0) of each trimLine pixel, -1 elsewhere. */
  trimComp: Int32Array;
  /** The learned outline colour, or null when the art has no outline darker than its fill. */
  outline: Rgb | null;
  outlineLum: number;
  fillLum: number;
  bandPx: number;
  linePx: number;
}

export const INK_BAND = 12;
export const INK_CONTRAST = 30;
export const INK_BAND_TOL = 40;
export const INK_LINE_TOL = 30;
/** Colour distance between the paint on the two sides of a line that makes it a material edge. */
export const MATERIAL_SPLIT = 40;
/** How far (px) to look on each side of a line for its paint. */
const SIDE_REACH = 14;
/** Ink-like paint texels (not mask ink) a dark-material side must hold. */
const DARK_SIDE_PAINT = 3;

export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const dist = (r: number, g: number, b: number, c: Rgb) => Math.hypot(r - c[0], g - c[1], b - c[2]);

export function artOutlineInk(art: RgbaImage, o: ArtInkOptions = {}): ArtInk {
  const band = o.band ?? INK_BAND;
  const contrast = o.contrast ?? INK_CONTRAST;
  const bandTol = o.bandTol ?? INK_BAND_TOL;
  const lineTol = o.lineTol ?? INK_LINE_TOL;
  const { width: w, height: h } = art;
  const D = art.data;
  const op = new Uint8Array(w * h);
  for (let i = 0; i < op.length; i++) op[i] = (D[i * 4 + 3] as number) >= 128 ? 1 : 0;
  const d = distInside(op, w, h);
  const ring: number[][] = [[], [], []];
  let fs = 0;
  let fn = 0;
  for (let i = 0; i < op.length; i++) {
    if (!op[i]) continue;
    const di = d[i] as number;
    if (di >= 2 && di <= 4) for (let k = 0; k < 3; k++) (ring[k] as number[]).push(D[i * 4 + k] as number);
    else if (di > 14) { fs += luminance(D[i * 4] as number, D[i * 4 + 1] as number, D[i * 4 + 2] as number); fn++; }
  }
  const mask = new Uint8Array(w * h);
  const trimLine = new Uint8Array(w * h);
  const trimComp = new Int32Array(w * h).fill(-1);
  const fillLum = fn ? fs / fn : 255;
  const out: ArtInk = { width: w, height: h, mask, trimLine, trimComp, outline: null, outlineLum: 255, fillLum, bandPx: 0, linePx: 0 };
  if (!(ring[0] as number[]).length) return out;
  const O = ring.map((c) => c.sort((p, q) => p - q)[Math.floor(c.length / 2)] as number) as Rgb;
  const oLum = luminance(...O);
  out.outlineLum = oLum;
  if (oLum > fillLum - contrast) return out;
  out.outline = O;
  for (let i = 0; i < op.length; i++) {
    if ((D[i * 4 + 3] as number) < 128) continue;
    const r = D[i * 4] as number;
    const g = D[i * 4 + 1] as number;
    const b = D[i * 4 + 2] as number;
    const dc = dist(r, g, b, O);
    if ((d[i] as number) <= band) {
      if (dc <= bandTol && luminance(r, g, b) <= fillLum - contrast) { mask[i] = 1; out.bandPx++; }
    } else if (dc <= lineTol) { mask[i] = 1; out.linePx++; }
  }
  markTrimLines(art, out, d, band, bandTol);
  extendTrimIntoBand(out, d, band);
  return out;
}

/**
 * Trim lines run INTO the outline: band ink connected to a trim line component, deeper than the art's
 * outline stroke itself, is that trim line's end, not silhouette ink. The outline depth is the first
 * depth (px inside the alpha edge) where under half of the opaque pixels are band ink; the flood never
 * enters pixels at or above it, so it cannot run along the outline ring.
 */
function extendTrimIntoBand(ink: ArtInk, d: Float32Array, band: number): void {
  const { width: w, height: h, mask, trimLine, trimComp } = ink;
  const opq = new Array<number>(band + 2).fill(0);
  const ink0 = new Array<number>(band + 2).fill(0);
  for (let i = 0; i < w * h; i++) { const k = Math.round(d[i] as number); if (k < 1 || k > band) continue; opq[k]!++; if (mask[i]) ink0[k]!++; }
  let depth = band;
  for (let k = 1; k <= band; k++) if ((opq[k] as number) > 0 && (ink0[k] as number) / (opq[k] as number) < 0.5) { depth = k; break; }
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) if (trimLine[i]) st.push(i);
  while (st.length) {
    const i = st.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx;
      const Y = y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const j = Y * w + X;
      if (trimLine[j] || !mask[j] || (d[j] as number) > band || (d[j] as number) <= depth) continue;
      trimLine[j] = 1;
      trimComp[j] = trimComp[i] as number;
      st.push(j);
    }
  }
}

/**
 * Interior line work between two materials: per interior ink pixel, the paint on both sides along
 * the direction that crosses the line fastest (of 4) is the first settled colour (opaque, not ink,
 * within 10 of the next pixel along, so antialiased blends are skipped); a side split above
 * MATERIAL_SPLIT is a material edge. Then each 8-connected interior line component takes its
 * majority; only pixels that voted trim themselves are marked.
 */
function markTrimLines(art: RgbaImage, ink: ArtInk, d: Float32Array, band: number, bandTol: number): void {
  const { width: w, height: h, mask, trimLine, trimComp } = ink;
  let compId = 0;
  const O = ink.outline;
  if (!O) return;
  const D = art.data;
  const interior = (i: number) => mask[i] === 1 && (d[i] as number) > band;
  const col = (i: number): Rgb => [D[i * 4] as number, D[i * 4 + 1] as number, D[i * 4 + 2] as number];
  // (Jade C belt end caps: a line edging a dark material whose paint is itself ink-like across the whole
  // reach, the belt's rounded end, found no settled paint on that side and never voted; its texels were removed
  // and refilled with the fabric, the belt's end read frayed. Ink and ink-like paint over the whole reach, all of it
  // past the silhouette band, is that dark material: its mean colour is the side's paint (a walk into the garment's
  // own thick outline reaches the band: no vote, jacket v4-clean's cuff), and holding some ink-like paint that is
  // not mask ink (DARK_SIDE_PAINT texels: a walk along the line's own ink is no material). The span is the full reach, so a
  // direction with paint settled on both sides nearer still wins: a line inside one fabric is unchanged.)
  const settled = (x: number, y: number, dx: number, dy: number): { c: Rgb; t: number } | null => {
    const dk: Rgb = [0, 0, 0];
    let nd = 0;
    let rim = false;
    let np = 0;
    for (let t = 1; t <= SIDE_REACH; t++) {
      const X = x + dx * t;
      const Y = y + dy * t;
      const X2 = X + dx;
      const Y2 = Y + dy;
      if (X < 0 || Y < 0 || X >= w || Y >= h || X2 < 0 || Y2 < 0 || X2 >= w || Y2 >= h) return null;
      const i = Y * w + X;
      const j = Y2 * w + X2;
      if ((D[i * 4 + 3] as number) < 250) return null;
      if (mask[i] || dist(...col(i), O) <= bandTol) { const c = col(i); dk[0] += c[0]; dk[1] += c[1]; dk[2] += c[2]; nd++; if (!mask[i]) np++; if ((d[i] as number) <= band) rim = true; continue; }
      const a = col(i);
      const b = col(j);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 10) return { c: a, t };
    }
    return nd >= SIDE_REACH / 2 && np >= DARK_SIDE_PAINT && !rim ? { c: [dk[0] / nd, dk[1] / nd, dk[2] / nd], t: SIDE_REACH } : null;
  };
  const vote = new Int8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!interior(i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    let best: { span: number; split: number } | null = null;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      const a = settled(x, y, dx, dy);
      const b = settled(x, y, -dx, -dy);
      if (!a || !b) continue;
      const span = (a.t + b.t) * Math.hypot(dx, dy);
      if (!best || span < best.span) best = { span, split: Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) };
    }
    vote[i] = best ? (best.split > MATERIAL_SPLIT ? 1 : -1) : 0;
  }
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !interior(s)) continue;
    const comp: number[] = [];
    const st = [s];
    seen[s] = 1;
    let sum = 0;
    while (st.length) {
      const i = st.pop() as number;
      comp.push(i);
      sum += vote[i] as number;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx;
        const Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!seen[j] && interior(j)) { seen[j] = 1; st.push(j); }
      }
    }
    // a pixel is trim when its own two sides are different materials and its line votes trim (the
    // inner fringe of a thick outline sees transparency on one side: no vote, never trim)
    if (sum > 0) { for (const i of comp) if (vote[i] === 1) { trimLine[i] = 1; trimComp[i] = compId; } compId++; }
  }
}

/** Whether a colour (e.g. a completed texel) is the learned outline ink (the interior line tolerance). */
export function isOutlineInkColour(ink: ArtInk, r: number, g: number, b: number): boolean {
  return ink.outline !== null && dist(r, g, b, ink.outline) <= INK_LINE_TOL;
}

/**
 * Ink-dark paint: within the band tolerance (INK_BAND_TOL) of the learned outline colour, i.e. the outline
 * itself, its antialiased blends and near-ink shading (a dark strap or baldric shade just outside the line
 * tolerance). The completion never refills removed ink from such paint (Jade C: two removed
 * strap-edge ink texels refilled from the near-ink baldric shade averaged back into the ink colour).
 */
export function isInkDark(ink: ArtInk, r: number, g: number, b: number): boolean {
  return ink.outline !== null && dist(r, g, b, ink.outline) <= INK_BAND_TOL;
}

/**
 * An antialiased blend between the outline ink and the fabric next to it: a colour on the way from
 * the outline colour to the fabric median (closer to the segment than `tol`, not the fabric itself).
 */
export function isInkBlend(ink: ArtInk, fabric: Rgb, r: number, g: number, b: number, tol = 10): boolean {
  const O = ink.outline;
  if (!O) return false;
  const v: Rgb = [fabric[0] - O[0], fabric[1] - O[1], fabric[2] - O[2]];
  const l2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] || 1;
  const t = ((r - O[0]) * v[0] + (g - O[1]) * v[1] + (b - O[2]) * v[2]) / l2;
  if (t <= 0 || t >= 1) return false;
  if (dist(r, g, b, fabric) <= tol) return false;
  return Math.hypot(r - O[0] - v[0] * t, g - O[1] - v[1] * t, b - O[2] - v[2] * t) <= tol;
}
