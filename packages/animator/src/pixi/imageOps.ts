/*
 * Atlas Animator: original implementation.
 *
 * Pixel operations for the dynamic atlas. Pure functions on RGBA byte arrays (no DOM, no Pixi),
 * so they run and are tested in Node.
 *
 * Box (area) resampling: every destination pixel is the area-weighted average of the source
 * pixels its footprint covers. It is the exact low-pass for integer factors (2x2 average at 0.5)
 * and degrades gracefully for fractional ones. Averaging happens in premultiplied alpha, so
 * transparent neighbours do not darken edges (a straight-alpha average would pull their black
 * RGB into the border), and the result is stored premultiplied, which is what the GPU blends.
 */

/** RGBA bytes, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ResampledImage extends RgbaImage {
  readonly data: Uint8Array;
  /** Exact size of the source rectangle after scaling (the image covers [0, w) x [0, h)). */
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/**
 * Resamples `rect` of a straight-alpha image by `scale` (<= 1) into a premultiplied image of
 * ceil(rect.width * scale) x ceil(rect.height * scale) pixels. The source rectangle maps onto
 * [0, rect.width * scale) x [0, rect.height * scale); a final partial column or row is covered
 * only partly and fades accordingly.
 */
export function resampleToPremultiplied(source: RgbaImage, rect: Rect, scale: number): ResampledImage {
  if (!(scale > 0 && scale <= 1)) throw new RangeError(`scale must be in (0, 1], got ${scale}`);
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > source.width || rect.y + rect.height > source.height) {
    throw new RangeError(`rect ${rect.x},${rect.y} ${rect.width}x${rect.height} is outside the ${source.width}x${source.height} image`);
  }
  if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.width) || !Number.isInteger(rect.height)) {
    throw new RangeError("rect must be whole pixels");
  }
  const contentWidth = rect.width * scale;
  const contentHeight = rect.height * scale;
  const width = Math.max(1, Math.ceil(contentWidth - 1e-9));
  const height = Math.max(1, Math.ceil(contentHeight - 1e-9));
  const columns = footprints(rect.width, width, scale);
  const rows = footprints(rect.height, height, scale);

  // Horizontal pass: premultiplied floats, `width` columns per source row.
  const stride = source.width * 4;
  const horizontal = new Float32Array(width * rect.height * 4);
  for (let sy = 0; sy < rect.height; sy++) {
    const rowStart = (rect.y + sy) * stride + rect.x * 4;
    for (let dx = 0; dx < width; dx++) {
      const footprint = columns[dx] as Footprint;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < footprint.indices.length; k++) {
        const i = rowStart + (footprint.indices[k] as number) * 4;
        const w = (footprint.weights[k] as number) * ((source.data[i + 3] as number) / 255);
        r += (source.data[i] as number) * w;
        g += (source.data[i + 1] as number) * w;
        b += (source.data[i + 2] as number) * w;
        a += (footprint.weights[k] as number) * (source.data[i + 3] as number);
      }
      const o = (sy * width + dx) * 4;
      horizontal[o] = r;
      horizontal[o + 1] = g;
      horizontal[o + 2] = b;
      horizontal[o + 3] = a;
    }
  }

  // Vertical pass into bytes.
  const data = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const footprint = rows[dy] as Footprint;
    for (let dx = 0; dx < width; dx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < footprint.indices.length; k++) {
        const i = ((footprint.indices[k] as number) * width + dx) * 4;
        const w = footprint.weights[k] as number;
        r += (horizontal[i] as number) * w;
        g += (horizontal[i + 1] as number) * w;
        b += (horizontal[i + 2] as number) * w;
        a += (horizontal[i + 3] as number) * w;
      }
      const o = (dy * width + dx) * 4;
      data[o] = toByte(r);
      data[o + 1] = toByte(g);
      data[o + 2] = toByte(b);
      data[o + 3] = toByte(a);
    }
  }
  return { width, height, data, contentWidth, contentHeight };
}

interface Footprint {
  readonly indices: readonly number[];
  readonly weights: readonly number[];
}

/**
 * For each destination pixel d (covering [d, d + 1) in destination units, i.e.
 * [d / scale, (d + 1) / scale) in source units), the source pixels it overlaps and the overlap
 * as a fraction of the destination pixel's area along this axis (sums to 1 for full pixels).
 */
function footprints(sourceSize: number, destinationSize: number, scale: number): Footprint[] {
  const result: Footprint[] = [];
  for (let d = 0; d < destinationSize; d++) {
    const start = d / scale;
    const end = Math.min(sourceSize, (d + 1) / scale);
    const indices: number[] = [];
    const weights: number[] = [];
    for (let s = Math.floor(start); s < end; s++) {
      const overlap = Math.min(end, s + 1) - Math.max(start, s);
      if (overlap > 1e-9) {
        indices.push(s);
        weights.push(overlap * scale);
      }
    }
    result.push({ indices, weights });
  }
  return result;
}

function toByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Converts premultiplied RGBA bytes back to straight alpha (for writing PNGs in tools/tests). */
export function unpremultiply(image: RgbaImage): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = image.data[i + 3] as number;
    data[i + 3] = a;
    if (a === 0) continue;
    data[i] = toByte(((image.data[i] as number) * 255) / a);
    data[i + 1] = toByte(((image.data[i + 1] as number) * 255) / a);
    data[i + 2] = toByte(((image.data[i + 2] as number) * 255) / a);
  }
  return { width: image.width, height: image.height, data };
}
