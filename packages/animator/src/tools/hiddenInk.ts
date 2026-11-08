/*
 * Atlas Animator: original implementation.
 *
 * Hidden ink. A skin mesh texture built from the art carries the art's outline ink
 * where, at rest, the rig draws something else on top: under the body's own strokes, under a rigid
 * region (the fist over the wrist), under the torso or head. Those texels never show at rest; in a
 * strong bend the skin stretches and they peek out as specks inside the line. Every mesh texel
 * that is not the top texel anywhere in the setup-pose render away from a stroke (strokes count as
 * on top; within BESIDE_LINE px of one, shown ink only thickens the line) and is
 * clearly darker than the skin around it (below HIDDEN_INK_SHARE of the local skin luma) is
 * repainted with that skin. What shows at rest is untouched (rest fidelity), and the stroke stays
 * the only outline ink.
 */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { RgbaImage } from "./image.js";
import { softRender } from "./softRender.js";

/** A hidden texel darker than this share of the local skin luma is ink. */
export const HIDDEN_INK_SHARE = 0.75;
/** Canvas px beside a stroke where shown ink is treated as hidden (it would thicken the line). */
export const BESIDE_LINE = 6;
/** Per-channel distance from its seed a dark band texel beside a stroke may have and still be band material. */
const MATERIAL_COLOUR = 24;
/** Chroma distance from the nearest stroke's colour that makes a dark texel beside another slot's stroke a different material. */
const STROKE_CHROMA = 24;
/** Luma (0..255) a texel needs to count as skin for the local average. */
const SKIN_LUMA = 150;

/** Garment texels whose luma differs from their fill by more than this are repainted. */
const GARMENT_FILL_TOLERANCE = 6;
/** Nearest shown texels a garment fill is taken from (per-channel median). */
const GARMENT_DONORS = 8;

/**
 * A garment's band under and beside its strokes (every texel not shown at rest away from a line)
 * becomes the garment's own fill: the per-channel median of the nearest shown texels. Its painted
 * ring and the highlight inside the ring both go (a removed ring left the art's highlight as
 * light dashes beside the thinner line), so a stretch shows fill, never the ring, and the stroke is
 * the garment's only outline. Garment donors are the shown texels, not a luma threshold, so a dark
 * fabric keeps its own colour.
 */
function flattenGarmentBand(tex: RgbaImage, shown: Uint8Array): Uint8Array {
  const src = tex.data;
  const data = new Uint8Array(src);
  const w = tex.width;
  const h = tex.height;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const med = (a: number[]) => (a.sort((x, y) => x - y), a[a.length >> 1] as number);
  for (let t = 0; t < shown.length; t++) {
    if (shown[t] || (src[t * 4 + 3] as number) < 8) continue;
    const x = t % w;
    const y = (t - x) / w;
    rs.length = gs.length = bs.length = 0;
    for (let r = 1; r <= 16 && rs.length < GARMENT_DONORS; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!shown[j] || (src[j * 4 + 3] as number) < 200) continue;
        rs.push(src[j * 4] as number);
        gs.push(src[j * 4 + 1] as number);
        bs.push(src[j * 4 + 2] as number);
      }
    }
    if (rs.length < 3) continue;
    const fr = med(rs);
    const fg = med(gs);
    const fb = med(bs);
    if (Math.abs(luma(src, t * 4) - (0.3 * fr + 0.59 * fg + 0.11 * fb)) <= GARMENT_FILL_TOLERANCE) continue;
    data[t * 4] = fr;
    data[t * 4 + 1] = fg;
    data[t * 4 + 2] = fb;
  }
  return data;
}

function countChanged(a: RgbaImage, b: RgbaImage): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  return n;
}

const luma = (d: ArrayLike<number>, o: number) => 0.3 * (d[o] as number) + 0.59 * (d[o + 1] as number) + 0.11 * (d[o + 2] as number);

/**
 * Repaints hidden ink in the mesh textures of `skinName` (non-embedded meshes, and embedded ones
 * whose slot carries contours); returns the
 * repainted texel count per texture path. `textures` is updated with new images.
 */
export function repaintHiddenInk(doc: any, textures: Map<string, RgbaImage>, skinName: string): Record<string, number> {
  const sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins([skinName]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const { width, height, originX, originY } = doc.canvas as { width: number; height: number; originX: number; originY: number };
  const R = softRender(sk, textures, { width, height, left: -originX, top: -originY, ids: true });
  const top = R.topSlot as Int16Array;
  const texel = R.topTexel as Int32Array;
  const paths = new Set<string>();
  const garments = new Set<string>();
  // skin meshes, and rigid regions and embedded garment meshes (the tank) that carry a runtime
  // outline (their painted ring is replaced by the strokes; the tank's painted armhole ring
  // widened past its stroke in an armpit stretch, the user's dark ticks at upper arm 16-61)
  const outlined = new Set(Object.keys((doc.skins[skinName]?.contours ?? {}) as Record<string, unknown>));
  for (const [slot, atts] of Object.entries((doc.skins[skinName]?.attachments ?? {}) as Record<string, Record<string, any>>)) {
    for (const a of Object.values(atts)) {
      if (!textures.has(a.path)) continue;
      if ((a.type === "mesh" && (!a.embed || outlined.has(slot))) || (a.type === "region" && outlined.has(slot))) paths.add(a.path);
      if (a.type === "mesh" && a.embed && outlined.has(slot)) garments.add(a.path);
    }
  }
  const visible = new Map<string, Uint8Array>();
  for (const p of paths) visible.set(p, new Uint8Array((textures.get(p) as RgbaImage).width * (textures.get(p) as RgbaImage).height));
  // Pixels beside a stroke (within BESIDE_LINE px of a contour pixel): ink shown there thickens the
  // line at rest and is the first to peek out in a bend, so it counts as hidden too.
  const stroke = new Uint8Array(top.length);
  for (let i = 0; i < top.length; i++) if (top[i] && (texel[i] as number) < 0) stroke[i] = 1;
  const beside = new Uint8Array(top.length);
  for (let i = 0; i < top.length; i++) {
    if (!stroke[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -BESIDE_LINE; dy <= BESIDE_LINE; dy++) for (let dx = -BESIDE_LINE; dx <= BESIDE_LINE; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height && dx * dx + dy * dy <= BESIDE_LINE * BESIDE_LINE) beside[yy * width + xx] = 1;
    }
  }
  const pathAt = (i: number): string | undefined => {
    const s = top[i] as number;
    if (!s || (texel[i] as number) < 0) return undefined;
    const slot = sk.slots[s - 1];
    return ((slot?.groupMesh ?? slot?.attachment) as { path?: string } | null | undefined)?.path;
  };
  // Shown dark material beside a stroke is not line thickening when it continues, through shown dark
  // texels of the same texture, past BESIDE_LINE: a broad dark band of the art (the neck's shadow side,
  // a garment trim) that a stroke runs along. Those texels stay (session 8: the side neck's dark band
  // was repainted with the tank white within BESIDE_LINE of the torso stroke, a light strip at rest).
  const darkShown = (i: number): boolean => {
    const p = pathAt(i);
    const tex = p ? textures.get(p) : undefined;
    if (!tex || !visible.has(p as string)) return false;
    const o = (texel[i] as number) * 4;
    return (tex.data[o + 3] as number) >= 8 && luma(tex.data, o) < SKIN_LUMA;
  };
  // The band keeps its own colour: a texel joins only while it stays within MATERIAL_COLOUR of the
  // band's seed texel (a garment trim does not carry the flood into the art's limb outline beside it).
  const rgbAt = (i: number): [number, number, number] => {
    const d = (textures.get(pathAt(i) as string) as RgbaImage).data;
    const o = (texel[i] as number) * 4;
    return [d[o] as number, d[o + 1] as number, d[o + 2] as number];
  };
  // The nearest stroke pixel of every pixel beside one (multi-source BFS): band material either lies
  // beside its own slot's stroke (the neck's shadow side under the torso outline) or differs from the
  // stroke's colour (a grey trim under an arm's stroke). Ink of the stroke's colour beside another
  // slot's stroke is that part's spilled art outline (the fist's outline left on the torso texture
  // where the rig's forearm is narrower than the art) and stays hidden ink.
  const nearStroke = new Int32Array(top.length).fill(-1);
  {
    const q: number[] = [];
    for (let i = 0; i < top.length; i++) if (stroke[i]) { nearStroke[i] = i; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h] as number;
      const x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= top.length || !beside[j] || (nearStroke[j] as number) >= 0) continue;
        nearStroke[j] = nearStroke[i] as number;
        q.push(j);
      }
    }
  }
  const img = R.image.data;
  const bandAllowed = (j: number): boolean => {
    const k = nearStroke[j] as number;
    if (k < 0 || top[k] === top[j]) return true;
    // chroma (r - g, g - b) apart from the stroke's: a neutral trim beside a brown stroke differs, the
    // stroke's own ink and its anti-aliased rim do not, however light the rim is
    const c = rgbAt(j);
    const s0 = img[k * 4] as number;
    const s1 = img[k * 4 + 1] as number;
    const s2 = img[k * 4 + 2] as number;
    return Math.hypot(c[0] - c[1] - (s0 - s1), c[1] - c[2] - (s1 - s2)) > STROKE_CHROMA;
  };
  const material = new Uint8Array(top.length);
  const queue: number[] = [];
  const seedOf: number[] = [];
  for (let i = 0; i < top.length; i++) if (!beside[i] && darkShown(i)) { material[i] = 1; queue.push(i); seedOf.push(i); }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h] as number;
    const seed = seedOf[h] as number;
    const sc = rgbAt(seed);
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j < 0 || j >= top.length || material[j] || !beside[j] || stroke[j] || pathAt(j) !== pathAt(i) || !darkShown(j) || !bandAllowed(j)) continue;
      const c = rgbAt(j);
      if (Math.max(Math.abs(c[0] - sc[0]), Math.abs(c[1] - sc[1]), Math.abs(c[2] - sc[2])) > MATERIAL_COLOUR) continue;
      material[j] = 1;
      queue.push(j);
      seedOf.push(seed);
    }
  }
  for (let i = 0; i < top.length; i++) {
    const t = texel[i] as number;
    if (!top[i] || t < 0 || (beside[i] && !material[i])) continue;
    const p = pathAt(i);
    const v = p ? visible.get(p) : undefined;
    if (v) v[t] = 1;
  }
  const out: Record<string, number> = {};
  for (const p of paths) {
    const tex = textures.get(p) as RgbaImage;
    const v = visible.get(p) as Uint8Array;
    const src = tex.data;
    const data = new Uint8Array(src);
    let n = 0;
    if (garments.has(p)) {
      textures.set(p, { width: tex.width, height: tex.height, data: flattenGarmentBand(tex, v) });
      out[p] = countChanged(tex, textures.get(p) as RgbaImage);
      continue;
    }
    for (let t0 = 0; t0 < v.length; t0++) {
      if (v[t0] || (src[t0 * 4 + 3] as number) < 8) continue;
      const own = luma(src, t0 * 4);
      if (own >= SKIN_LUMA) continue;
      const x = t0 % tex.width;
      const y = (t0 - x) / tex.width;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let sl = 0;
      let cnt = 0;
      for (let r = 4; r <= 16 && cnt < 6; r += 4) {
        s0 = s1 = s2 = sl = cnt = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= tex.width || yy >= tex.height) continue;
          const o = (yy * tex.width + xx) * 4;
          if ((src[o + 3] as number) < 200) continue;
          const l = luma(src, o);
          if (l < SKIN_LUMA) continue;
          s0 += src[o] as number;
          s1 += src[o + 1] as number;
          s2 += src[o + 2] as number;
          sl += l;
          cnt++;
        }
      }
      if (cnt < 6 || own > (HIDDEN_INK_SHARE * sl) / cnt) continue;
      data[t0 * 4] = Math.round(s0 / cnt);
      data[t0 * 4 + 1] = Math.round(s1 / cnt);
      data[t0 * 4 + 2] = Math.round(s2 / cnt);
      n++;
    }
    textures.set(p, { width: tex.width, height: tex.height, data });
    out[p] = n;
  }
  return out;
}
