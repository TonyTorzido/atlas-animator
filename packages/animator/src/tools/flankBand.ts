/*
 * Atlas Animator: original implementation.
 *
 *: texture and tone continuity across the last FLANK_BAND px inside the side
 * outline. The garment's side flank texels (the trunk's silhouette run where it runs down the side, away from the
 * arms and the cuts) are split into windows of FLANK_BAND_ROWS rows per side; in each window the outer band (0 to
 * FLANK_BAND px past the stroke's inner edge) is compared with the band just inward of it (FLANK_BAND to 2 x
 * FLANK_BAND). A window fails when the outer band is darker than the inner by more than FLANK_TONE_MAX (luminance),
 * or when the inner band is textured (FLANK_TEX_MIN) and the outer band keeps less than FLANK_FLAT_RATIO of that
 * texture (mean absolute difference from the 3x3 mean of the same band's fabric texels): a flat or darkened strip down the side. Damaged controls:
 * the outer band flattened to its mean colour and the outer band darkened by FLANK_CONTROL_DARKEN must fail. A window
 * with the art reference fails as flat only where the output keeps less than ART_KEEP of the art's own outer-band
 * texture (a band the generation draws plain is listed as artPlain, not blamed on the pipeline).
 */
import type { RgbaImage } from "./image.js";

export const FLANK_BAND = 10;
export const FLANK_BAND_ROWS = 24;
export const FLANK_TONE_MAX = 8;
export const FLANK_TEX_MIN = 1.5;
export const FLANK_FLAT_RATIO = 0.5;
export const FLANK_CONTROL_DARKEN = 0.8;
/** The flank texels stay this many FLANK_BAND widths clear of the cut strokes (hem, neckline: their trim bands). */
export const FLANK_CUT_CLEAR = 3;
const MIN_TEXELS = 30;
/** Fewest texels per band for the art comparison (the art's outline ink covers most of some outer bands). */
const ART_MIN_TEXELS = 8;
/** Share of the art's own outer-band texture the output must keep for a flat band to be the drawing's, not the pipeline's. */
export const ART_KEEP = 0.8;

/** Flank texels of a texture: distance past the stroke's inner edge (NaN off the flank) and a side id per texel. */
export interface FlankField {
  width: number;
  height: number;
  dist: Float32Array;
  side: Int16Array;
}

export interface FlankBandWindow {
  side: number;
  y0: number;
  outerLum: number;
  innerLum: number;
  outerTex: number;
  innerTex: number;
  dark: boolean;
  flat: boolean;
}

export interface FlankBandResult {
  windows: number;
  failed: number;
  worstDarkDelta: number;
  worstTexRatio: number | null;
  at: string[];
  list: FlankBandWindow[];
}

const lumOf = (d: Uint8Array | Uint8ClampedArray, o: number) => 0.299 * (d[o] as number) + 0.587 * (d[o + 1] as number) + 0.114 * (d[o + 2] as number);

export function flankBandContinuity(tex: RgbaImage, f: FlankField, artRef?: { texture: RgbaImage; field: FlankField }, minTexels = MIN_TEXELS): FlankBandResult {
  // with the art: the art's and this texture's outer-band texture over the same texels (the art's fabric texels)
  const outerOn = (t: RgbaImage) => artRef ? new Map(flankBandContinuity(t, artRef.field, undefined, ART_MIN_TEXELS).list.map((w) => [`${w.side}:${w.y0}`, w.outerTex])) : undefined;
  const art = outerOn(artRef?.texture as RgbaImage);
  const mine = outerOn(tex);
  const W = tex.width;
  const H = tex.height;
  const D = tex.data;
  // high-frequency texture per texel: |lum - mean of its opaque 3x3 neighbours|
  const bandOf = (i: number) => { const d = f.dist[i] as number; return d >= 0 && d < FLANK_BAND ? 0 : d >= FLANK_BAND && d < 2 * FLANK_BAND ? 1 : -1; };
  const hf = (i: number) => {
    const b = bandOf(i);
    const x = i % W;
    const y = (i - x) / W;
    let s = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx;
      const Y = y + dy;
      // fabric neighbours of the same band only: a belt or trim edge beside the flank, the stroke-covered texels or the
      // other band are not this band's texture
      if (X < 0 || Y < 0 || X >= W || Y >= H || (D[(Y * W + X) * 4 + 3] as number) < 200 || bandOf(Y * W + X) !== b) continue;
      s += lumOf(D, (Y * W + X) * 4);
      n++;
    }
    return n ? Math.abs(lumOf(D, i * 4) - s / n) : 0;
  };
  type Acc = { side: number; y0: number; o: number[]; inn: number[] };
  const wins = new Map<number, Acc>();
  for (let i = 0; i < W * H; i++) {
    const d = f.dist[i] as number;
    const s = f.side[i] as number;
    if (!(d >= 0 && d < 2 * FLANK_BAND) || s < 0 || (D[i * 4 + 3] as number) < 200) continue;
    const y = Math.floor(i / W);
    const key = s * 100000 + Math.floor(y / FLANK_BAND_ROWS);
    let w = wins.get(key);
    if (!w) { w = { side: s, y0: Math.floor(y / FLANK_BAND_ROWS) * FLANK_BAND_ROWS, o: [], inn: [] }; wins.set(key, w); }
    (d < FLANK_BAND ? w.o : w.inn).push(i);
  }
  const out: FlankBandResult = { windows: 0, failed: 0, worstDarkDelta: -Infinity, worstTexRatio: null, at: [], list: [] };
  for (const w of [...wins.values()].sort((a, b) => a.side - b.side || a.y0 - b.y0)) {
    if (w.o.length < minTexels || w.inn.length < minTexels) continue;
    const mean = (ids: number[], g: (i: number) => number) => ids.reduce((a, i) => a + g(i), 0) / ids.length;
    const outerLum = mean(w.o, (i) => lumOf(D, i * 4));
    const innerLum = mean(w.inn, (i) => lumOf(D, i * 4));
    const outerTex = mean(w.o, hf);
    const innerTex = mean(w.inn, hf);
    const dark = innerLum - outerLum > FLANK_TONE_MAX;
    // with the art: flat only where the pipeline lost texture the drawing has there (the output keeps less than ART_KEEP
    // of the art's own outer-band texture); a band the art draws plain is the drawing's, listed by the gate (artPlain)
    const artOuter = art?.get(`${w.side}:${w.y0}`);
    const mineOuter = mine?.get(`${w.side}:${w.y0}`);
    const flat = innerTex >= FLANK_TEX_MIN && outerTex < FLANK_FLAT_RATIO * innerTex && (artOuter === undefined || mineOuter === undefined || mineOuter < ART_KEEP * artOuter);
    out.windows++;
    out.worstDarkDelta = Math.max(out.worstDarkDelta, innerLum - outerLum);
    if (innerTex >= FLANK_TEX_MIN) out.worstTexRatio = Math.min(out.worstTexRatio ?? Infinity, outerTex / innerTex);
    const r = (v: number) => Number(v.toFixed(2));
    out.list.push({ side: w.side, y0: w.y0, outerLum: r(outerLum), innerLum: r(innerLum), outerTex: r(outerTex), innerTex: r(innerTex), dark, flat });
    if (dark || flat) {
      out.failed++;
      if (out.at.length < 8) out.at.push(`side ${w.side} rows ${w.y0}+${FLANK_BAND_ROWS}: ${dark ? `darker by ${r(innerLum - outerLum)}` : ""}${dark && flat ? ", " : ""}${flat ? `texture ${r(outerTex)} vs ${r(innerTex)}` : ""}`);
    }
  }
  out.worstDarkDelta = Number(out.worstDarkDelta.toFixed(2));
  if (out.worstTexRatio !== null) out.worstTexRatio = Number(out.worstTexRatio.toFixed(3));
  return out;
}

/** The damaged controls: the outer band flattened to its window's mean colour, or darkened (by FLANK_CONTROL_DARKEN, and
 * at least to 2 x FLANK_TONE_MAX below the inner band). */
export function damagedFlankBand(tex: RgbaImage, f: FlankField, kind: "flat" | "dark"): RgbaImage {
  const W = tex.width;
  const data = new Uint8Array(tex.data);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < W * tex.height; i++) {
    const d = f.dist[i] as number;
    const s = f.side[i] as number;
    if (!(d >= 0 && d < FLANK_BAND) || s < 0 || (data[i * 4 + 3] as number) < 200) continue;
    const key = s * 100000 + Math.floor(Math.floor(i / W) / FLANK_BAND_ROWS);
    (groups.get(key) ?? groups.set(key, []).get(key) as number[]).push(i);
  }
  // the inner band's mean luminance per window (the darkened control sits 2 x FLANK_TONE_MAX below it)
  const innerLum = new Map<number, number>();
  {
    const acc = new Map<number, [number, number]>();
    for (let i = 0; i < W * tex.height; i++) {
      const d = f.dist[i] as number;
      const s = f.side[i] as number;
      if (!(d >= FLANK_BAND && d < 2 * FLANK_BAND) || s < 0 || (data[i * 4 + 3] as number) < 200) continue;
      const key = s * 100000 + Math.floor(Math.floor(i / W) / FLANK_BAND_ROWS);
      const a = acc.get(key) ?? [0, 0];
      a[0] += lumOf(data, i * 4);
      a[1]++;
      acc.set(key, a);
    }
    for (const [k, [sum, n]] of acc) innerLum.set(k, sum / n);
  }
  for (const [key, ids] of groups) {
    if (kind === "dark") {
      const outer = ids.reduce((a, i) => a + lumOf(data, i * 4), 0) / ids.length;
      const inner = innerLum.get(key) ?? outer;
      const k = Math.min(FLANK_CONTROL_DARKEN, Math.max(0, inner - 2 * FLANK_TONE_MAX) / Math.max(outer, 1));
      for (const i of ids) for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round((data[i * 4 + c] as number) * k);
      continue;
    }
    const m = [0, 1, 2].map((c) => Math.round(ids.reduce((a, i) => a + (data[i * 4 + c] as number), 0) / ids.length));
    for (const i of ids) data.set(m, i * 4);
  }
  return { width: W, height: tex.height, data };
}

/** The art's own outer-band texture per window, from the art in the texture rectangle (ink left out of its field). */
export function artOuterTexture(art: { texture: RgbaImage; field: FlankField }): { outer: Map<string, number>; plain: string[] } {
  const r = flankBandContinuity(art.texture, art.field, undefined, ART_MIN_TEXELS);
  return {
    outer: new Map(r.list.map((w) => [`${w.side}:${w.y0}`, w.outerTex])),
    plain: r.list.filter((w) => w.innerTex >= FLANK_TEX_MIN && w.outerTex < FLANK_FLAT_RATIO * w.innerTex).map((w) => `${w.side}:${w.y0} ${w.outerTex.toFixed(2)}/${w.innerTex.toFixed(2)}`)
  };
}

/** The gate: no failing window, at least one window, and both damaged controls fail (the flat one wherever the flank is
 * textured). With the art: windows the art itself draws plain are listed (artPlain) and judged against the art. */
export function flankBandGate(tex: RgbaImage, f: FlankField, artRef?: { texture: RgbaImage; field: FlankField }): { result: FlankBandResult; controlDark: number; controlFlat: number; texturedWindows: number; controlsFail: boolean; artPlain: string[]; ok: boolean } {
  const ref = artRef ? artOuterTexture(artRef) : undefined;
  const art = ref?.outer;
  const result = flankBandContinuity(tex, f, artRef);
  const dark = flankBandContinuity(damagedFlankBand(tex, f, "dark"), f, artRef);
  // (the flat control is read without the art excuse: it shows the measure finds a flattened band)
  const flat = flankBandContinuity(damagedFlankBand(tex, f, "flat"), f);
  // the flat control is required to fail wherever the flank is textured and the art has texture in its outline band
  const judged = (w: FlankBandWindow) => w.innerTex >= FLANK_TEX_MIN && (art?.get(`${w.side}:${w.y0}`) ?? Infinity) >= FLANK_FLAT_RATIO * FLANK_TEX_MIN;
  const texturedWindows = result.list.filter(judged).length;
  const flatFails = flat.list.filter((w) => w.flat && judged(w)).length;
  const controlsFail = result.windows > 0 && dark.failed === dark.windows && (texturedWindows === 0 || flatFails >= texturedWindows);
  const artPlain = ref?.plain ?? [];
  return { result, controlDark: dark.failed, controlFlat: flatFails, texturedWindows, controlsFail, artPlain, ok: result.windows > 0 && result.failed === 0 && controlsFail };
}
