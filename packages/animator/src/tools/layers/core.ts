/*
 * Atlas Animator: original implementation.
 *
 * Layered-parts pipeline: shared pixel helpers. Masks are the image.ts `Mask`
 * (1 byte per pixel); mask PNGs are opaque black/white (white = inside) so any viewer and any
 * image model reads them the same way. Coordinates are source pixels, top-left origin, y down.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createImage, createMask, type Mask, type MutableImage, type RgbaImage } from "../image.js";
import { readPng, writePng } from "../png.js";

export type { Mask, MutableImage, RgbaImage };

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writeMaskPng(path: string, mask: Mask): void {
  const image = createImage(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i] ? 255 : 0;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  writePng(path, image);
}

/** Reads a mask PNG: inside where red >= 128 on an opaque pixel (black/white masks as written). */
export function readMaskPng(path: string): Mask {
  const image = readPng(path);
  const mask = createMask(image.width, image.height);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = (image.data[i * 4 + 3] as number) >= 128 && (image.data[i * 4] as number) >= 128 ? 1 : 0;
  return mask;
}

export function maskFrom(width: number, height: number, test: (i: number) => boolean): Mask {
  const mask = createMask(width, height);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = test(i) ? 1 : 0;
  return mask;
}

export function countMask(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i] as number;
  return n;
}

export const alphaAt = (image: RgbaImage, i: number) => image.data[i * 4 + 3] as number;

export function luma(image: RgbaImage, i: number): number {
  return 0.299 * (image.data[i * 4] as number) + 0.587 * (image.data[i * 4 + 1] as number) + 0.114 * (image.data[i * 4 + 2] as number);
}

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb and Huttenlocher), in place over `f`. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] as number) + q * q - ((f[v[k] as number] as number) + (v[k] as number) * (v[k] as number));
    s /= 2 * q - 2 * (v[k] as number);
    while (s <= (z[k] as number)) {
      k--;
      s = ((f[q] as number) + q * q - ((f[v[k] as number] as number) + (v[k] as number) * (v[k] as number))) / (2 * q - 2 * (v[k] as number));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] as number) < q) k++;
    const dq = q - (v[k] as number);
    d[q] = dq * dq + (f[v[k] as number] as number);
  }
  for (let q = 0; q < n; q++) f[q] = d[q] as number;
}

/**
 * Exact Euclidean distance from every pixel to the nearest pixel where `target` is set (0 on
 * target pixels). With no target pixel every distance is a large number.
 */
export function distanceTo(target: Mask): Float64Array {
  const { width: w, height: h } = target;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = target.data[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x] as number;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = f[y] as number;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x] as number;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(f[x] as number);
  }
  return grid;
}

/** Distance from each pixel inside `mask` to the nearest pixel outside it (0 outside). */
export function distanceInside(mask: Mask): Float64Array {
  return distanceTo(maskFrom(mask.width, mask.height, (i) => !mask.data[i]));
}

/** Euclidean (disc) dilation by `radius` pixels. */
export function dilateDisc(mask: Mask, radius: number): Mask {
  if (radius <= 0) return maskFrom(mask.width, mask.height, (i) => mask.data[i] === 1);
  const d = distanceTo(mask);
  return maskFrom(mask.width, mask.height, (i) => (d[i] as number) <= radius + 1e-9);
}

/** Morphological closing by a disc: fills notches narrower than 2 radius, never grows convex outlines. */
export function closeDisc(mask: Mask, radius: number): Mask {
  const grown = dilateDisc(mask, radius);
  const outside = distanceTo(maskFrom(mask.width, mask.height, (i) => grown.data[i] !== 1));
  return maskFrom(mask.width, mask.height, (i) => (outside[i] as number) > radius);
}

export function union(a: Mask, b: Mask): Mask {
  return maskFrom(a.width, a.height, (i) => a.data[i] === 1 || b.data[i] === 1);
}

export function intersect(a: Mask, b: Mask): Mask {
  return maskFrom(a.width, a.height, (i) => a.data[i] === 1 && b.data[i] === 1);
}

export function subtract(a: Mask, b: Mask): Mask {
  return maskFrom(a.width, a.height, (i) => a.data[i] === 1 && b.data[i] !== 1);
}

export function discMask(width: number, height: number, cx: number, cy: number, radius: number): Mask {
  return maskFrom(width, height, (i) => {
    const x = (i % width) + 0.5 - cx;
    const y = Math.floor(i / width) + 0.5 - cy;
    return x * x + y * y <= radius * radius;
  });
}

/** A rotation by `degrees` about (px, py); positive turns clockwise on screen (y down), as bones do. */
export interface Rotation {
  px: number;
  py: number;
  cos: number;
  sin: number;
}

export function rotation(px: number, py: number, degrees: number): Rotation {
  const r = (degrees * Math.PI) / 180;
  return { px, py, cos: Math.cos(r), sin: Math.sin(r) };
}

/** Source pixel index that lands on pixel (x, y) after rotation `r` (nearest sample), or -1. */
export function inverseSample(r: Rotation | null, width: number, height: number, x: number, y: number): number {
  if (!r) return y * width + x;
  const dx = x + 0.5 - r.px;
  const dy = y + 0.5 - r.py;
  // Inverse rotation: by -angle.
  const sx = Math.floor(r.px + r.cos * dx + r.sin * dy);
  const sy = Math.floor(r.py - r.sin * dx + r.cos * dy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return -1;
  return sy * width + sx;
}

/** Mask `m` moved by rotation `r` (nearest sample). */
export function rotateMask(m: Mask, r: Rotation): Mask {
  const out = createMask(m.width, m.height);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const s = inverseSample(r, m.width, m.height, x, y);
      if (s >= 0 && m.data[s]) out.data[y * m.width + x] = 1;
    }
  }
  return out;
}

/** Premultiplied 8-bit channel value (round half up, the compositor's rounding). */
export const premul = (c: number, a: number) => Math.round((c * a) / 255);

/**
 * Composites straight-alpha layers back to front ("over", premultiplied arithmetic) into a
 * straight-alpha image. `sample(k, x, y)` gives the source pixel index of layer k at (x, y), or -1.
 */
export function compositeLayers(layers: readonly RgbaImage[], width: number, height: number, sample?: (k: number, x: number, y: number) => number, background?: readonly [number, number, number]): MutableImage {
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = background ? background[0] : 0;
      let g = background ? background[1] : 0;
      let b = background ? background[2] : 0;
      let a = background ? 255 : 0;
      for (let k = 0; k < layers.length; k++) {
        const layer = layers[k] as RgbaImage;
        const s = sample ? sample(k, x, y) : y * width + x;
        if (s < 0) continue;
        const la = layer.data[s * 4 + 3] as number;
        if (la === 0) continue;
        const inv = (255 - la) / 255;
        r = (layer.data[s * 4] as number) * (la / 255) + r * inv;
        g = (layer.data[s * 4 + 1] as number) * (la / 255) + g * inv;
        b = (layer.data[s * 4 + 2] as number) * (la / 255) + b * inv;
        a = la + a * inv;
      }
      const p = (y * width + x) * 4;
      // r, g, b are premultiplied here; store straight.
      out.data[p + 3] = Math.round(a);
      if (a > 0) {
        out.data[p] = Math.min(255, Math.round((r * 255) / a));
        out.data[p + 1] = Math.min(255, Math.round((g * 255) / a));
        out.data[p + 2] = Math.min(255, Math.round((b * 255) / a));
      }
    }
  }
  return out;
}

export function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Distinct, readable part colours for overlays. */
export const PART_COLORS: readonly (readonly [number, number, number])[] = [
  [230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [170, 110, 40], [128, 0, 0]
];
