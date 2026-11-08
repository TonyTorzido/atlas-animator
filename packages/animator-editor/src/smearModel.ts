/*
 * Atlas Animator editor: original implementation.
 *
 * Smear tool (pure). Given the weapon's attachment image and the weapon bone's world transform at about six sub-steps along
 * the swing between two frames, it renders the weapon at each sub-step into the weapon bone's local space at the frame the
 * smear will show on, unions them, stretches the union about 15% along the arc, inks the hull with the stock outline, and
 * returns one image plus the region attachment that places it. The smear is a weapon part: it is built from the weapon
 * slot's own image only and never reads or writes a body part, a hand or an arm.
 */
import type { RgbaImage } from "@atlas-animator/core/pixi";
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, frameTime, timeToFrame } from "./clipModel.js";
import { SLOT_GROUPS } from "./drawOrderPresets.js";
import { setAttachmentKey } from "./slotModel.js";

/** A 2x3 affine like a bone's world matrix: (x, y) -> (a x + b y + tx, c x + d y + ty). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

/** The weapon region attachment's placement in the weapon bone's space (format.ts region attachment). */
export interface RegionPlacement {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface SmearOptions {
  /** The weapon image (straight alpha) and where the region sits on the weapon bone. */
  image: RgbaImage;
  region: RegionPlacement;
  /** The weapon bone's world transform at each sub-step along the swing, first to last. */
  steps: readonly Affine[];
  /** The weapon bone's world transform on the frame the smear shows on (output is in this bone space). */
  show: Affine;
  /** Direction of travel in world space (the arc tangent), for the stretch. */
  travel: { x: number; y: number };
  /** Stretch along the arc as a fraction of the union (default 0.15). */
  stretch?: number;
  /** The stock outline: colour (r, g, b) and full stroke width in px (the rig's contours use 10). */
  ink?: { color: readonly [number, number, number]; width: number };
}

export interface SmearResult {
  image: RgbaImage;
  /** The region attachment for the weapon slot (weapon bone space, unrotated, unscaled). */
  region: { x: number; y: number; rotation: 0; scaleX: 1; scaleY: 1; width: number; height: number; opaque: number[] };
  /** Opaque pixel count of the hull (before inking) and of the ink. */
  hullPx: number;
  inkPx: number;
}

export const SMEAR_STEPS = 6;
/**
 * The attachment's `opaque` outline: a negligible triangle in the image corner. A region attachment trims the body's contour
 * strokes under its opaque outline (the whole rectangle when absent); a smear is an effect and must not trim any body line.
 */
export const SMEAR_OPAQUE: readonly number[] = [0, 0, 0.004, 0, 0, 0.004];
export const SMEAR_STRETCH = 0.15;
export const STOCK_INK_WIDTH = 10;
export const SMEAR_MAX_SIDE = 1600;

const mul = (p: Affine, q: Affine): Affine => ({
  a: p.a * q.a + p.b * q.c,
  b: p.a * q.b + p.b * q.d,
  c: p.c * q.a + p.d * q.c,
  d: p.c * q.b + p.d * q.d,
  tx: p.a * q.tx + p.b * q.ty + p.tx,
  ty: p.c * q.tx + p.d * q.ty + p.ty
});

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) throw new Error("a weapon transform is collapsed");
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) };
}

const apply = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty];

/** The region image's pixel space -> weapon bone space: the image centre sits at (x, y), then rotation and scale apply. */
function regionMatrix(r: RegionPlacement, iw: number, ih: number): Affine {
  const rad = (r.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = r.scaleX * (r.width / iw);
  const sy = r.scaleY * (r.height / ih);
  const a = cos * sx;
  const b = -sin * sy;
  const c = sin * sx;
  const d = cos * sy;
  return { a, b, c, d, tx: r.x - (a * iw) / 2 - (b * ih) / 2, ty: r.y - (c * iw) / 2 - (d * ih) / 2 };
}

/** Weapon slots only: a smear is a weapon part, so a slot of the body, a hand or an arm is refused. */
export function assertWeaponSlot(slot: string, bone: string): void {
  const weapon = (SLOT_GROUPS.weapon as readonly string[]).includes(slot);
  const body = ([...SLOT_GROUPS.arm_l, ...SLOT_GROUPS.arm_r, ...SLOT_GROUPS.body] as string[]).includes(slot) || /^(hand|fore|upper_arm|clavicle|chest|pelvis|neck|head|thigh|shin|foot|root)/.test(bone);
  if (!weapon || body) throw new Error(`the smear tool only works on a weapon slot and bone, not slot '${slot}' on bone '${bone}'`);
}

function sample(img: RgbaImage, x: number, y: number, out: number[]): void {
  // bilinear on premultiplied colour; outside the image is transparent
  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = x0 + i;
      const py = y0 + j;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const o = (py * img.width + px) * 4;
      const al = (img.data[o + 3]! / 255) * w;
      r += img.data[o]! * al;
      g += img.data[o + 1]! * al;
      b += img.data[o + 2]! * al;
      a += al;
    }
  }
  out[0] = a > 0 ? r / a : 0;
  out[1] = a > 0 ? g / a : 0;
  out[2] = a > 0 ? b / a : 0;
  out[3] = a;
}

/** Renders the smear. */
export function renderSmear(opt: SmearOptions): SmearResult {
  const { image, region, steps, show } = opt;
  if (steps.length < 2) throw new Error("a smear needs at least two sub-steps");
  const k = opt.stretch ?? SMEAR_STRETCH;
  const ink = opt.ink ?? { color: [0x3a, 0x10, 0x01] as const, width: STOCK_INK_WIDTH };
  const showInv = invert(show);
  const reg = regionMatrix(region, image.width, image.height);
  // sub-step -> show bone space
  const rel = steps.map((s) => mul(showInv, s));
  // the arc direction in show bone space (a direction, so the linear part only)
  const tx = showInv.a * opt.travel.x + showInv.b * opt.travel.y;
  const ty = showInv.c * opt.travel.x + showInv.d * opt.travel.y;
  const tl = Math.hypot(tx, ty) || 1;
  const u = { x: tx / tl, y: ty / tl };
  // centroid of the weapon centres across the sub-steps
  const centre = rel.reduce(
    (acc, m) => {
      const p = apply(mul(m, reg), image.width / 2, image.height / 2);
      return [acc[0] + p[0] / rel.length, acc[1] + p[1] / rel.length] as [number, number];
    },
    [0, 0] as [number, number]
  );
  // stretch: p' = c + (p - c) + k ((p - c) . u) u
  const stretchM: Affine = {
    a: 1 + k * u.x * u.x,
    b: k * u.x * u.y,
    c: k * u.x * u.y,
    d: 1 + k * u.y * u.y,
    tx: 0,
    ty: 0
  };
  stretchM.tx = centre[0] - (stretchM.a * centre[0] + stretchM.b * centre[1]);
  stretchM.ty = centre[1] - (stretchM.c * centre[0] + stretchM.d * centre[1]);
  const full = rel.map((m) => mul(stretchM, mul(m, reg)));
  // bounds of all transformed image corners
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of full) {
    for (const [cx, cy] of [[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]] as const) {
      const [px, py] = apply(m, cx, cy);
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  const pad = Math.ceil(ink.width / 2) + 2;
  const x0 = Math.floor(minX) - pad;
  const y0 = Math.floor(minY) - pad;
  const w = Math.ceil(maxX) + pad - x0;
  const h = Math.ceil(maxY) + pad - y0;
  if (w > SMEAR_MAX_SIDE || h > SMEAR_MAX_SIDE) throw new Error(`the smear would be ${w}x${h}px; pick frames closer together`);
  const inv = full.map(invert);
  const data = new Uint8Array(w * h * 4);
  const hull = new Uint8Array(w * h);
  const px4 = [0, 0, 0, 0];
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const lx = x0 + ox + 0.5;
      const ly = y0 + oy + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      // oldest sub-step first: later ones paint over earlier ones, so the weapon at its show pose reads on top
      for (let i = 0; i < inv.length; i++) {
        const [sx, sy] = apply(inv[i]!, lx, ly);
        sample(image, sx, sy, px4);
        // the trail fades in toward the show pose
        const alpha = px4[3]! * (0.4 + (0.6 * i) / Math.max(1, inv.length - 1));
        if (alpha <= 0.004) continue;
        const outA = alpha + a * (1 - alpha);
        r = (px4[0]! * alpha + r * a * (1 - alpha)) / outA;
        g = (px4[1]! * alpha + g * a * (1 - alpha)) / outA;
        b = (px4[2]! * alpha + b * a * (1 - alpha)) / outA;
        a = outA;
      }
      const o = (oy * w + ox) * 4;
      data[o] = Math.round(r);
      data[o + 1] = Math.round(g);
      data[o + 2] = Math.round(b);
      data[o + 3] = Math.round(a * 255);
      hull[oy * w + ox] = a >= 0.1 ? 1 : 0;
    }
  }
  const hullPx = hull.reduce((s, v) => s + v, 0);
  const inkPx = inkHull(data, hull, w, h, ink.color, ink.width / 2);
  return {
    image: { width: w, height: h, data },
    region: { x: x0 + w / 2, y: y0 + h / 2, rotation: 0, scaleX: 1, scaleY: 1, width: w, height: h, opaque: [...SMEAR_OPAQUE] },
    hullPx,
    inkPx
  };
}

/** Paints the outline ring (centred on the hull edge, `radius` each way) in the ink colour, fully opaque. Returns the ring's pixel count. */
function inkHull(data: Uint8Array, hull: Uint8Array, w: number, h: number, color: readonly [number, number, number], radius: number): number {
  const r = Math.max(1, Math.round(radius));
  const r2 = r * r + r * 0.5;
  // distance to the nearest pixel of the other kind, capped at r: inside pixels look for ground, outside pixels for hull
  let ring = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = hull[y * w + x] === 1;
      let edge = false;
      for (let dy = -r; dy <= r && !edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if ((hull[yy * w + xx] === 1) !== inside) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) continue;
      ring++;
      const o = (y * w + x) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }
  return ring;
}

/** Sub-step times between two frames, inclusive of both (n >= 2). */
export function smearTimes(clip: Pick<ClipData, "fps" | "duration">, a: number, b: number, n = SMEAR_STEPS): number[] {
  const ta = frameTime(clip, a);
  const tb = frameTime(clip, b);
  return Array.from({ length: n }, (_, i) => ta + ((tb - ta) * i) / Math.max(1, n - 1));
}

/**
 * Keys the smear attachment on `showFrame` of the weapon slot and the original attachment back on the next frame (unless a
 * swap is already keyed there). Touches only `slots.<slot>.attachment`; every other part of the clip is returned as it was.
 */
export function keySmear(clip: ClipData, slot: string, bone: string, smear: string, restore: string | null, showFrame: number): ClipData {
  assertWeaponSlot(slot, bone);
  const t = frameTime(clip, showFrame);
  let next = setAttachmentKey(clip, slot, t, smear);
  const after = frameTime(clip, showFrame + 1);
  const keyed = next.slots[slot]?.attachment?.some((k) => Math.abs(k.time - after) < KEY_EPSILON);
  if (timeToFrame(clip, after) > showFrame && !keyed) next = setAttachmentKey(next, slot, after, restore);
  return next;
}

/** Gap between neighbouring sub-steps (tip distance, px) above which extra sub-steps are added so the hull stays connected. */
export const SMEAR_MAX_GAP = 45;
export const SMEAR_MAX_STEPS = 40;

/**
 * Picks sub-steps from a dense sampling of the swing: evenly spaced by distance travelled by the tip (so they lie evenly along the
 * arc whatever the easing), at least `n` of them, more when the arc is long enough that `n` would leave gaps over SMEAR_MAX_GAP.
 * Always includes the first and last sample. Returns indices into `tips`.
 */
export function pickByArc(tips: readonly { x: number; y: number }[], n: number, densify = true): number[] {
  if (tips.length < 2) return tips.map((_, i) => i);
  const cum = [0];
  for (let i = 1; i < tips.length; i++) cum.push(cum[i - 1]! + Math.hypot(tips[i]!.x - tips[i - 1]!.x, tips[i]!.y - tips[i - 1]!.y));
  const total = cum[cum.length - 1]!;
  if (total < 1e-6) return Array.from({ length: Math.max(2, n) }, (_, i) => Math.round((i * (tips.length - 1)) / Math.max(1, n - 1)));
  const count = densify ? Math.min(SMEAR_MAX_STEPS, Math.max(n, Math.ceil(total / SMEAR_MAX_GAP) + 1)) : n;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const want = (total * k) / (count - 1);
    let best = 0;
    for (let i = 0; i < cum.length; i++) if (Math.abs(cum[i]! - want) < Math.abs(cum[best]! - want)) best = i;
    if (!out.length || best !== out[out.length - 1]) out.push(best);
  }
  return out;
}
