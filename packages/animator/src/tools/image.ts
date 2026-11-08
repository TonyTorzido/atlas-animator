/*
 * Atlas Animator: original implementation.
 *
 * Image and mask helpers for the rigging tools: straight-alpha RGBA images, binary masks from an
 * alpha threshold, square dilation, connected components, crops. Pure functions over typed
 * arrays; PNG files are read and written in png.ts (Node only).
 */
import type { RgbaImage } from "../pixi/imageOps.js";

export type { RgbaImage } from "../pixi/imageOps.js";

/** A mutable straight-alpha RGBA image. */
export interface MutableImage extends RgbaImage {
  readonly data: Uint8Array;
}

/** One byte per pixel, 1 = inside, 0 = outside. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function createImage(width: number, height: number): MutableImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** Pixels whose alpha is at least `threshold` (plan 4.6: 128). */
export function alphaMask(image: RgbaImage, threshold = 128): Mask {
  const mask = createMask(image.width, image.height);
  for (let i = 0, p = 3; i < mask.data.length; i++, p += 4) mask.data[i] = (image.data[p] as number) >= threshold ? 1 : 0;
  return mask;
}

export function maskArea(mask: Mask): number {
  let area = 0;
  for (let i = 0; i < mask.data.length; i++) area += mask.data[i] as number;
  return area;
}

/** Smallest rectangle holding every set pixel, or null for an empty mask. */
export function maskBounds(mask: Mask): PixelRect | null {
  let x0 = mask.width;
  let y0 = mask.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Square (Chebyshev) dilation by `radius` whole pixels: keeps axis-aligned edges straight. */
export function dilateMask(mask: Mask, radius: number): Mask {
  if (radius <= 0) return { width: mask.width, height: mask.height, data: mask.data.slice() };
  const { width, height } = mask;
  // Separable: a horizontal then a vertical running-max pass.
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask.data[row + x]) continue;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let k = from; k <= to; k++) horizontal[row + k] = 1;
    }
  }
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!horizontal[row + x]) continue;
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      for (let k = from; k <= to; k++) out.data[k * width + x] = 1;
    }
  }
  return out;
}

/** Square erosion by `radius` (pixels outside the image count as outside). */
export function erodeMask(mask: Mask, radius: number): Mask {
  const inverted = createMask(mask.width, mask.height);
  for (let i = 0; i < inverted.data.length; i++) inverted.data[i] = mask.data[i] ? 0 : 1;
  // Pad by treating the border as outside: dilate the outside, then also clear a border band.
  const grown = dilateMask(inverted, radius);
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const i = y * mask.width + x;
      const nearBorder = x < radius || y < radius || x >= mask.width - radius || y >= mask.height - radius;
      out.data[i] = !grown.data[i] && !nearBorder && mask.data[i] ? 1 : 0;
    }
  }
  return out;
}

/**
 * 4-connected components. Returns a label per pixel (0 = background, 1..n) and the pixel count of
 * each label (index 0 unused).
 */
export function connectedComponents(mask: Mask): { labels: Int32Array; sizes: number[] } {
  const { width, height } = mask;
  const labels = new Int32Array(width * height);
  const sizes = [0];
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start++) {
    if (!mask.data[start] || labels[start]) continue;
    const label = sizes.length;
    let size = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      size += 1;
      const x = i % width;
      const y = (i - x) / width;
      const visit = (j: number) => {
        if (mask.data[j] && !labels[j]) {
          labels[j] = label;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Copies `rect` of an image (pixels outside the source are transparent). */
export function cropImage(image: RgbaImage, rect: PixelRect): MutableImage {
  const out = createImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= image.width) continue;
      const s = (sy * image.width + sx) * 4;
      const d = (y * rect.width + x) * 4;
      out.data[d] = image.data[s] as number;
      out.data[d + 1] = image.data[s + 1] as number;
      out.data[d + 2] = image.data[s + 2] as number;
      out.data[d + 3] = image.data[s + 3] as number;
    }
  }
  return out;
}

/** The image with every pixel outside `mask` made fully transparent (same size as the mask). */
export function applyMask(image: RgbaImage, mask: Mask): MutableImage {
  if (image.width !== mask.width || image.height !== mask.height) throw new RangeError("image and mask sizes differ");
  const out = createImage(image.width, image.height);
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue;
    const p = i * 4;
    out.data[p] = image.data[p] as number;
    out.data[p + 1] = image.data[p + 1] as number;
    out.data[p + 2] = image.data[p + 2] as number;
    out.data[p + 3] = image.data[p + 3] as number;
  }
  return out;
}

/** Straight-alpha "over" of one RGBA colour onto the pixel at byte offset `p`. */
export function blendPixel(image: MutableImage, p: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const da = (image.data[p + 3] as number) / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  const mix = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / oa);
  image.data[p] = mix(r, image.data[p] as number);
  image.data[p + 1] = mix(g, image.data[p + 1] as number);
  image.data[p + 2] = mix(b, image.data[p + 2] as number);
  image.data[p + 3] = Math.round(oa * 255);
}

/** Draws `source` over `target` with its top-left at (x, y). */
export function drawImage(target: MutableImage, source: RgbaImage, x: number, y: number): void {
  for (let sy = 0; sy < source.height; sy++) {
    const ty = y + sy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = x + sx;
      if (tx < 0 || tx >= target.width) continue;
      const s = (sy * source.width + sx) * 4;
      blendPixel(
        target,
        (ty * target.width + tx) * 4,
        source.data[s] as number,
        source.data[s + 1] as number,
        source.data[s + 2] as number,
        source.data[s + 3] as number
      );
    }
  }
}

/** Fills the image with one opaque colour. */
export function fillImage(image: MutableImage, r: number, g: number, b: number, a = 255): void {
  for (let p = 0; p < image.data.length; p += 4) {
    image.data[p] = r;
    image.data[p + 1] = g;
    image.data[p + 2] = b;
    image.data[p + 3] = a;
  }
}

/** Dark outline ink: luma under 110 (the body-template convention for drawn lines). */
export function isInk(image: RgbaImage, p: number): boolean {
  const r = image.data[p * 4] as number;
  const g = image.data[p * 4 + 1] as number;
  const b = image.data[p * 4 + 2] as number;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;
}

/** Atlas texture path of a rig part (`body/<part>`). */
export function texturePath(part: string): string {
  return `body/${part}`;
}
