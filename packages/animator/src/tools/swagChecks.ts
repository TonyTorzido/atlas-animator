/*
 * Atlas Animator: original implementation.
 *
 * Swag checks (swag-rules/STYLE.md): checks on the artist's art, on top of the importer gates
 * (cli/garmentImport.ts). Each check returns pass/fail and a plain-English reason written to be fed
 * straight back to the artist in a redraw prompt. All are pure functions over the art and the guide
 * data (tools/swagGuide.ts), in rig canvas pixels:
 * - outlineContrast: the outline (any hue) must be clearly darker than the item's fill;
 * - paletteOutliers: flat cel shading uses a few colours; gradients, noise and scribbles fail;
 * - paintOutsideAllowed: no paint outside the allowed area plus declared overflow zones;
 * - holesAndSeeThrough: no holes or semi-transparent spots inside the item (flat, no visible inside);
 * - registration: the art sits on the body: no offset, no scale drift, and it covers the area.
 */
import type { RgbaImage } from "./image.js";
import { dilate, type SwagContext } from "./swagGuide.js";
import { distInside } from "./garmentImport.js";

export interface SwagCheckResult {
  name: string;
  pass: boolean;
  /** Plain English; for a failure it says what is wrong and what to do about it. */
  reason: string;
  metrics: Record<string, number | string>;
}

export interface SwagChecksReport {
  passed: boolean;
  checks: SwagCheckResult[];
  /** The reasons of the failed checks, in order. */
  reasons: string[];
}

/**
 * `required`: the area the item must cover (the zero-margin core, the body inside the cuts). Cracks
 * are checked against it whether or not they reach the item's edge (review #6: a slit open to
 * the outside is not an enclosed hole, but it still leaves the body bare).
 */
export type SwagCheckContext = Pick<SwagContext, "width" | "height" | "allowed" | "overflow"> & { neckZone?: Uint8Array; required?: Uint8Array };

export interface SwagCheckOptions {
  /** Min luminance gap (0-255) between the item's mean fill and the outline. */
  outlineContrast?: number;
  /** Max palette entries (flat cel shading). */
  maxPalette?: number;
  /** Max share of interior pixels outside every palette entry. */
  maxOutlierShare?: number;
  /** Tolerance px past the allowed area (anti-aliasing, hand drawn edges). */
  edgeTolerance?: number;
  /** Tolerance px past the allowed area inside the neck and shoulder zone. */
  neckTolerance?: number;
  /** Max paint px outside before failing: absolute and as a share of the item. */
  maxOutsidePx?: number;
  maxOutsideShare?: number;
  /** Smallest enclosed see-through spot that counts, px. */
  minHolePx?: number;
  /** Max semi-transparent interior px. */
  maxSemiPx?: number;
  /** Cracks: required-area pixels this far (px) from the required area's edge must be opaque. */
  requiredInset?: number;
  /** Registration limits: best-shift px, scale ratio band, coverage of the allowed area. */
  maxShift?: number;
  scaleBand?: number;
  minCoverage?: number;
}

const DEFAULTS: Required<SwagCheckOptions> = {
  outlineContrast: 30,
  maxPalette: 8,
  maxOutlierShare: 0.03,
  edgeTolerance: 4,
  neckTolerance: 16,
  maxOutsidePx: 60,
  maxOutsideShare: 0.002,
  minHolePx: 12,
  maxSemiPx: 20,
  requiredInset: 3,
  maxShift: 3,
  scaleBand: 0.04,
  minCoverage: 0.88
};

const rgbText = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v)).join(",")})`;
const hexText = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number : 0);

function opaqueMask(art: RgbaImage, minAlpha = 128): Uint8Array {
  const m = new Uint8Array(art.width * art.height);
  for (let i = 0; i < m.length; i++) m[i] = (art.data[i * 4 + 3] as number) >= minAlpha ? 1 : 0;
  return m;
}

function sizeFail(art: RgbaImage, ctx: SwagCheckContext): string | null {
  return art.width === ctx.width && art.height === ctx.height ? null : `The image is ${art.width}x${art.height}; it must be exactly ${ctx.width}x${ctx.height}, the same canvas as the guide, never cropped, resized or squashed.`;
}

const where = (x0: number, y0: number, x1: number, y1: number) => `x ${x0}-${x1}, y ${y0}-${y1}`;

/** Luminance (0-255, Rec. 709 weights) of an rgb colour. */
const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The outline may be any hue; it must be clearly darker than the item's own fill. Outline = the opaque
 * pixels 2-4 px inside the silhouette edge (the stroke core); fill = the mean luminance of the
 * opaque pixels more than 14 px inside the edge (clear of the stroke), trim and shade tones included.
 * Pass when the outline's median luminance is at least `outlineContrast` (30 of 255) below the fill mean.
 */
export function checkOutlineContrast(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagCheckResult {
  const opt = { ...DEFAULTS, ...o };
  const name = "outlineContrast";
  const bad = sizeFail(art, ctx);
  if (bad) return { name, pass: false, reason: bad, metrics: {} };
  const { width: w, height: h } = art;
  const op = opaqueMask(art);
  const d = distInside(op, w, h);
  const ring: number[] = [];
  const rgb: number[][] = [[], [], []];
  let fillSum = 0;
  let fillN = 0;
  for (let i = 0; i < w * h; i++) {
    if (!op[i]) continue;
    const r = art.data[i * 4] as number;
    const g = art.data[i * 4 + 1] as number;
    const b = art.data[i * 4 + 2] as number;
    const di = d[i] as number;
    if (di >= 2 && di <= 4) { ring.push(lum(r, g, b)); rgb[0]?.push(r); rgb[1]?.push(g); rgb[2]?.push(b); }
    else if (di > 14) { fillSum += lum(r, g, b); fillN++; }
  }
  if (ring.length < 50) return { name, pass: false, reason: "No outline found: the item is missing or has no solid outline. Every contour needs a solid bold outline clearly darker than the item's colours.", metrics: {} };
  if (fillN < 200) return { name, pass: false, reason: "There is almost no fill area inside the outline to compare it with.", metrics: { outlinePx: ring.length } };
  const outline = median(ring);
  const fill = fillSum / fillN;
  const diff = fill - outline;
  const metrics = { outlinePx: ring.length, outlineLuminance: Math.round(outline), fillMeanLuminance: Math.round(fill), contrast: Math.round(diff), medianRgb: rgbText(rgb.map(median)) };
  if (diff >= opt.outlineContrast) return { name, pass: true, reason: `The outline (median ${metrics.medianRgb}) is clearly darker than the item's fill (luminance ${metrics.outlineLuminance} against ${metrics.fillMeanLuminance}).`, metrics };
  return { name, pass: false, reason: `The outline is not dark enough against the item: its luminance is ${metrics.outlineLuminance} (median ${metrics.medianRgb}) and the item's average fill is ${metrics.fillMeanLuminance}, a gap of ${metrics.contrast}; it must be at least ${opt.outlineContrast} darker. Redraw every contour as a solid bold line in a colour clearly darker than the item's colours (any hue is fine).`, metrics };
}

/** Flat cel shading: a few flat colours; anything else (gradients, noise, scribbles) is an outlier. */
export function checkPaletteOutliers(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagCheckResult {
  const opt = { ...DEFAULTS, ...o };
  const name = "paletteOutliers";
  const bad = sizeFail(art, ctx);
  if (bad) return { name, pass: false, reason: bad, metrics: {} };
  const { width: w, height: h } = art;
  const op = opaqueMask(art);
  const d = distInside(op, w, h);
  // interior pixels (clear of the anti-aliased silhouette edge), quantised to 5 bits per channel
  const hist = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    if (!op[i] || (d[i] as number) < 3) continue;
    total++;
    const k = ((art.data[i * 4] as number) >> 3 << 10) | ((art.data[i * 4 + 1] as number) >> 3 << 5) | ((art.data[i * 4 + 2] as number) >> 3);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  if (total < 200) return { name, pass: false, reason: "There is almost no opaque item area to check.", metrics: { interiorPx: total } };
  const key = (k: number): [number, number, number] => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];
  const palette: { c: [number, number, number]; share: number }[] = [];
  for (const [k, count] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
    if (count / total < 0.01) break;
    const c = key(k);
    if (palette.some((p) => Math.hypot(p.c[0] - c[0], p.c[1] - c[1], p.c[2] - c[2]) < 40)) continue;
    palette.push({ c, share: count / total });
  }
  let outliers = 0;
  let sx = 0;
  let sy = 0;
  const box = [w, h, 0, 0];
  for (let i = 0; i < w * h; i++) {
    if (!op[i] || (d[i] as number) < 3) continue;
    const r = art.data[i * 4] as number;
    const g = art.data[i * 4 + 1] as number;
    const b = art.data[i * 4 + 2] as number;
    if (palette.some((p) => Math.hypot(p.c[0] - r, p.c[1] - g, p.c[2] - b) < 40)) continue;
    outliers++;
    const x = i % w;
    const y = Math.floor(i / w);
    sx += x; sy += y;
    box[0] = Math.min(box[0] as number, x); box[1] = Math.min(box[1] as number, y); box[2] = Math.max(box[2] as number, x); box[3] = Math.max(box[3] as number, y);
  }
  const share = outliers / total;
  const metrics = { interiorPx: total, paletteSize: palette.length, outlierPx: outliers, outlierShare: Number(share.toFixed(4)), palette: palette.map((p) => hexText(p.c)).join(" ") };
  const problems: string[] = [];
  if (palette.length > opt.maxPalette) problems.push(`it uses ${palette.length} distinct colours (flat cel shading uses at most ${opt.maxPalette}: base, one shade, trim, outline, a highlight at most)`);
  if (share > opt.maxOutlierShare) problems.push(`${Math.round(share * 1000) / 10}% of the item is off-palette colour (gradients, noise, texture or scribbles; around ${where(box[0] as number, box[1] as number, box[2] as number, box[3] as number)})`);
  if (problems.length) return { name, pass: false, reason: `The shading is not flat cel shading: ${problems.join("; ")}. Repaint with a few flat colours and one hard-edged shade tone; no gradients, no texture, no scribbles.`, metrics };
  return { name, pass: true, reason: `The palette is flat (${palette.length} colours, ${Math.round(share * 1000) / 10}% off-palette).`, metrics };
}

/** Paint outside the allowed area plus the declared overflow zones. */
export function checkPaintOutsideAllowed(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagCheckResult {
  const opt = { ...DEFAULTS, ...o };
  const name = "paintOutsideAllowed";
  const bad = sizeFail(art, ctx);
  if (bad) return { name, pass: false, reason: bad, metrics: {} };
  const { width: w, height: h } = art;
  const union = new Uint8Array(w * h);
  for (let i = 0; i < union.length; i++) union[i] = ctx.allowed[i] || ctx.overflow[i] ? 1 : 0;
  const ok = dilate(union, w, h, opt.edgeTolerance);
  if (ctx.neckZone) {
    const wide = dilate(union, w, h, opt.neckTolerance);
    for (let i = 0; i < ok.length; i++) if (ctx.neckZone[i] && wide[i]) ok[i] = 1;
  }
  let outside = 0;
  let item = 0;
  let sx = 0;
  let sy = 0;
  const box = [w, h, 0, 0];
  for (let i = 0; i < w * h; i++) {
    const a = art.data[i * 4 + 3] as number;
    if (a >= 128) item++;
    if (a < 64 || ok[i]) continue;
    outside++;
    const x = i % w;
    const y = Math.floor(i / w);
    sx += x; sy += y;
    box[0] = Math.min(box[0] as number, x); box[1] = Math.min(box[1] as number, y); box[2] = Math.max(box[2] as number, x); box[3] = Math.max(box[3] as number, y);
  }
  const metrics = { itemPx: item, outsidePx: outside, outsideShare: item ? Number((outside / item).toFixed(4)) : 0 };
  if (outside <= opt.maxOutsidePx && outside <= opt.maxOutsideShare * Math.max(1, item)) return { name, pass: true, reason: `All paint is inside the allowed area (${outside} px of anti-aliasing past it).`, metrics };
  const cx = sx / outside;
  const cy = sy / outside;
  const side = `${cy < h / 2 ? "above" : "below"} and ${cx < w / 2 ? "left" : "right"} of the middle`;
  return {
    name,
    pass: false,
    reason: `${outside} px of paint lie outside the allowed area, around ${where(box[0] as number, box[1] as number, box[2] as number, box[3] as number)} (${side}). The item is bigger or looser than the guide outline: it must hug the body and stay inside the magenta guide line, with the gaps between arms and torso left open, and only extend past the body where an overflow zone is declared.`,
    metrics
  };
}

/** Holes and see-through spots inside the item. */
export function checkHolesAndSeeThrough(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagCheckResult {
  const opt = { ...DEFAULTS, ...o };
  const name = "holesAndSeeThrough";
  const bad = sizeFail(art, ctx);
  if (bad) return { name, pass: false, reason: bad, metrics: {} };
  const { width: w, height: h } = art;
  const op = opaqueMask(art);
  // transparent components that do not reach the image border are enclosed by the item
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const holes: { px: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let s = 0; s < w * h; s++) {
    if (op[s] || seen[s]) continue;
    let px = 0;
    let touches = false;
    const b = { x0: w, y0: h, x1: 0, y1: 0 };
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      px++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || op[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (!touches && px >= opt.minHolePx) holes.push({ px, ...b });
  }
  const d = distInside(op, w, h);
  let semi = 0;
  for (let i = 0; i < w * h; i++) if (op[i] && (d[i] as number) >= 3 && (art.data[i * 4 + 3] as number) < 250) semi++;
  // cracks: transparent pixels inside the required area (clear of its edge), connected ones grouped,
  // wherever they lead (a slit open to the outside counts as much as an enclosed hole)
  const cracks: { px: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  if (ctx.required) {
    const dr = distInside(ctx.required, w, h);
    const bare = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bare[i] = ctx.required[i] && (dr[i] as number) > opt.requiredInset && !op[i] ? 1 : 0;
    const seenB = new Uint8Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!bare[s] || seenB[s]) continue;
      const b = { px: 0, x0: w, y0: h, x1: 0, y1: 0 };
      stack.length = 0;
      stack.push(s);
      seenB[s] = 1;
      while (stack.length) {
        const i = stack.pop() as number;
        const x = i % w;
        const y = (i - x) / w;
        b.px++;
        b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (j < 0 || j >= w * h || seenB[j] || !bare[j]) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
          seenB[j] = 1;
          stack.push(j);
        }
      }
      if (b.px >= opt.minHolePx) cracks.push(b);
    }
  }
  const metrics = { holes: holes.length, largestHolePx: holes.reduce((m, x) => Math.max(m, x.px), 0), semiTransparentInteriorPx: semi, cracks: cracks.length, crackPx: cracks.reduce((m, x) => m + x.px, 0) };
  const problems: string[] = [];
  if (cracks.length) {
    const big = cracks.reduce((m, x) => (x.px > m.px ? x : m), cracks[0] as (typeof cracks)[number]);
    problems.push(`${cracks.length} gap${cracks.length === 1 ? "" : "s"} or slit${cracks.length === 1 ? "" : "s"} where the body would show through (${metrics.crackPx} px; the largest is ${big.px} px at ${where(big.x0, big.y0, big.x1, big.y1)}), even where it opens to the item's edge`);
  }
  if (holes.length) {
    const big = holes.reduce((m, x) => (x.px > m.px ? x : m), holes[0] as (typeof holes)[number]);
    problems.push(`${holes.length} hole${holes.length === 1 ? "" : "s"} inside the item (the largest is ${big.px} px at ${where(big.x0, big.y0, big.x1, big.y1)})`);
  }
  if (semi > opt.maxSemiPx) problems.push(`${semi} semi-transparent px inside the item (alpha must be 0 or 255 with clean edges)`);
  if (problems.length) return { name, pass: false, reason: `The item is not flat and solid: ${problems.join("; ")}. Garments are flat: no holes, no see-through spots, no visible inside or back. Collars are flat and open to the neck skin; fill every inside area with fabric.`, metrics };
  return { name, pass: true, reason: "The item is solid: no holes and no see-through spots inside it.", metrics };
}

/** Registration against the guide: offset, scale drift and coverage of the allowed area. */
export function checkRegistration(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagCheckResult {
  const opt = { ...DEFAULTS, ...o };
  const name = "registration";
  const bad = sizeFail(art, ctx);
  if (bad) return { name, pass: false, reason: bad, metrics: {} };
  const { width: w, height: h } = art;
  const M = opaqueMask(art);
  const A = ctx.allowed;
  // the fitted part is registered: paint past the allowed area inside the neck and shoulder zone (collar
  // variation) or inside a declared overflow zone is left out of the art mask. The allowed area itself
  // stays whole, so missing paint anywhere, the neck zone included, lowers the coverage (review #6, #8).
  let overflowPx = 0;
  for (let i = 0; i < M.length; i++) {
    if (!M[i] || A[i]) continue;
    if (ctx.overflow[i]) { M[i] = 0; overflowPx++; } else if (ctx.neckZone?.[i]) M[i] = 0;
  }
  const stats = (m: Uint8Array) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    const b = { x0: w, y0: h, x1: -1, y1: -1 };
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      n++; sx += x; sy += y;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
    return { n, cx: n ? sx / n : 0, cy: n ? sy / n : 0, ...b };
  };
  const sm = stats(M);
  const sa = stats(A);
  if (sm.n < 200) return { name, pass: false, reason: "There is almost no opaque item to register against the body.", metrics: { itemPx: sm.n } };
  // best integer shift of the art over the allowed area (search +-10 px), by overlap
  const inter = (dx: number, dy: number) => {
    let c = 0;
    for (let y = sm.y0; y <= sm.y1; y++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let x = sm.x0; x <= sm.x1; x++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (M[y * w + x] && A[yy * w + xx]) c++;
      }
    }
    return c;
  };
  const iou = (c: number) => c / (sm.n + sa.n - c);
  const base = iou(inter(0, 0));
  let best = { dx: 0, dy: 0, v: base };
  for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
    const v = iou(inter(dx, dy));
    if (v > best.v + 1e-9) best = { dx, dy, v };
  }
  const shift = Math.hypot(best.dx, best.dy);
  const wr = (sm.x1 - sm.x0 + 1) / (sa.x1 - sa.x0 + 1);
  const hr = (sm.y1 - sm.y0 + 1) / (sa.y1 - sa.y0 + 1);
  const coverage = inter(0, 0) / sa.n;
  const metrics = { iou: Number(base.toFixed(3)), bestShiftX: -best.dx, bestShiftY: -best.dy, centroidDx: Number((sm.cx - sa.cx).toFixed(1)), centroidDy: Number((sm.cy - sa.cy).toFixed(1)), widthRatio: Number(wr.toFixed(3)), heightRatio: Number(hr.toFixed(3)), coverage: Number(coverage.toFixed(3)), overflowPx };
  const problems: string[] = [];
  if (shift > opt.maxShift && best.v - base > 0.01) {
    const parts = [best.dx ? `${Math.abs(best.dx)} px too far ${best.dx > 0 ? "left" : "right"}` : "", best.dy ? `${Math.abs(best.dy)} px too far ${best.dy > 0 ? "up" : "down"}` : ""].filter(Boolean);
    problems.push(`the art sits ${parts.join(" and ")} compared with the body`);
  }
  if (Math.abs(wr - 1) > opt.scaleBand || Math.abs(hr - 1) > opt.scaleBand) problems.push(`the scale is off (the item is ${Math.round(wr * 100)}% as wide and ${Math.round(hr * 100)}% as tall as the guide area)`);
  if (coverage < opt.minCoverage) problems.push(`it covers only ${Math.round(coverage * 100)}% of the guide area (at least ${Math.round(opt.minCoverage * 100)}% is needed; skin or body outline would show through)`);
  if (problems.length) return { name, pass: false, reason: `The item does not register with the body: ${problems.join("; ")}. Keep the item exactly on the body at the guide's position and size, pixel for pixel; never move, resize, crop or squash it.`, metrics };
  return { name, pass: true, reason: `The item registers with the body (overlap ${base.toFixed(2)}, covers ${Math.round(coverage * 100)}%, scale ${Math.round(wr * 100)}% by ${Math.round(hr * 100)}%).`, metrics };
}

/** Runs every check. */
export function runSwagChecks(art: RgbaImage, ctx: SwagCheckContext, o: SwagCheckOptions = {}): SwagChecksReport {
  const checks = [checkOutlineContrast, checkPaletteOutliers, checkPaintOutsideAllowed, checkHolesAndSeeThrough, checkRegistration].map((f) => f(art, ctx, o));
  return { passed: checks.every((c) => c.pass), checks, reasons: checks.filter((c) => !c.pass).map((c) => c.reason) };
}
