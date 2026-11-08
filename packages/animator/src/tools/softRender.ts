/*
 * Atlas Animator: original implementation.
 *
 * A small CPU rasteriser for the Node tools: draws a posed skeleton's slots (textured triangles,
 * bilinear sampling, straight-alpha "over") into an RGBA image, and optionally records for every
 * pixel which slot and which texel is on top (alpha >= 128). The validators use the record for
 * the clipping check; the review tools use the image for weight overlays and contact sheets.
 *
 * It is deliberately independent of Pixi so validators run in plain Node; videos and goldens that
 * must match the game use the Pixi renderer in headless Chromium (plan Phase 5).
 *
 * Joint-ready body: a grouped mesh draws per group at each group's slot (from the one
 * skinned result, as in the game), and each visible contour draws after its owner slot as a flat
 * stroke polygon (the same stroke geometry, no anti-aliasing ramp) whose pixels carry the user
 * slot in `topSlot` (texel -1), so ownership, gap and buried-ink checks can read contours. Stroke
 * width and anti-aliasing are measured on Pixi captures, not here.
 */
import { isDrawable, isGroupedMesh, sequenceFramePath, type MeshAttachment, type RegionAttachment } from "../core/attachments.js";
import type { Rgba } from "../core/color.js";
import { buildStroke, type CompiledContour } from "../core/contours.js";
import { buildTrimmedStroke, filletCapacity, joinedEndMask, trimmedStrokeCapacity } from "../core/coverage.js";
import type { Skeleton } from "../core/skeleton.js";
import { pointInPolygon } from "../core/skinning.js";
import type { Slot } from "../core/slot.js";
import { blendPixel, createImage, type MutableImage, type RgbaImage } from "./image.js";

export interface SoftRenderOptions {
  /** Output size in pixels. */
  width: number;
  height: number;
  /** Output pixels per world pixel (default 1). */
  scale?: number;
  /** World position drawn at the output's top-left corner (default 0, 0). */
  left?: number;
  top?: number;
  /** Opaque background colour, or none (transparent). */
  background?: readonly [number, number, number];
  /** Record the top slot and texel per pixel. */
  ids?: boolean;
  /** Per-slot vertex colours instead of textures (weight overlays): rgba per vertex, 0..255. */
  vertexColors?: (slot: Slot) => ArrayLike<number> | null;
  /** Mix of vertex colour over the texture (0..1) where vertexColors gives colours (default 1). */
  vertexColorMix?: number;
  /** Only these slots are drawn (default: all). */
  slotFilter?: (slot: Slot) => boolean;
  /**
   * Per pixel (width x height, filled by the render): how far below full ink the topmost stroke
   * there is because of a trimmed-end feather (1 - fade), reset to 0 by any later full-ink stroke
   * pixel or opaque fill pixel. A visible feather is a nonzero value (arm layer line-end gate).
   */
  partialInk?: Float32Array;
  /** With partialInk: the feathered stroke's contour id + 1 per pixel (0 = none). */
  partialSource?: Int32Array;
}

export interface SoftRenderResult {
  image: MutableImage;
  /** Per pixel: slot index + 1 of the top opaque texel (0 = none). Present when `ids`. */
  topSlot?: Int16Array;
  /**
   * Per pixel: texel index (y * width + x) in that slot's texture (for a draw group, the grouped
   * mesh's texture; -1 for a contour or nothing). Present when `ids`.
   */
  topTexel?: Int32Array;
}

/**
 * A world-vertex scratch buffer that grows to fit each slot it is asked for (a fixed buffer used to
 * drop every vertex past its end, so large meshes lost triangles in CPU renders and checks).
 */
export function worldScratch(): (skeleton: Skeleton, slot: Slot) => Float64Array<ArrayBuffer> {
  let buffer = new Float64Array(2048);
  return (skeleton, slot) => {
    const need = skeleton.slotWorldFloats(slot);
    if (need > buffer.length) buffer = new Float64Array(need);
    return buffer;
  };
}

/**
 * Draws the skeleton's current pose (call updateWorldTransform first). `textures` maps texture
 * paths to images whose full extent is the attachment's 0..1 UV range.
 */
export function softRender(skeleton: Skeleton, textures: ReadonlyMap<string, RgbaImage>, options: SoftRenderOptions): SoftRenderResult {
  const { width, height } = options;
  const scale = options.scale ?? 1;
  const left = options.left ?? 0;
  const top = options.top ?? 0;
  const image = createImage(width, height);
  if (options.background) {
    const [r, g, b] = options.background;
    for (let p = 0; p < image.data.length; p += 4) image.data.set([r, g, b, 255], p);
  }
  const partialInk = options.partialInk;
  if (partialInk) partialInk.fill(0);
  options.partialSource?.fill(0);
  const topSlot = options.ids ? new Int16Array(width * height) : undefined;
  const topTexel = options.ids ? new Int32Array(width * height).fill(-1) : undefined;
  const scratch = worldScratch();
  let world = new Float64Array(0);
  const mix = options.vertexColorMix ?? 1;

  const contoursBySlot = new Map<number, CompiledContour[]>();
  for (const contour of skeleton.activeContours) {
    const index = skeleton.contourSlot(contour).index;
    const list = contoursBySlot.get(index) ?? [];
    list.push(contour);
    contoursBySlot.set(index, list);
  }

  // Clipping (Spine): the polygon, in output pixels, that later slots are cut to until the mask's end slot.
  let clip: Float64Array | null = null;
  const clipped = (px: number, py: number): boolean => clip !== null && !pointInPolygon(clip, clip.length / 2, px + 0.5, py + 0.5);

  const drawSlot = (slot: Slot): void => {
    let attachment: MeshAttachment | RegionAttachment;
    let uvs: ArrayLike<number>;
    let triangles: ArrayLike<number>;
    let count: number;
    const group = slot.groupMesh;
    if (group) {
      if (slot.hidden) return;
      const data = group.geometry.groups?.[slot.groupIndex];
      if (!data) return;
      attachment = group;
      uvs = data.uvs;
      triangles = data.triangles;
      count = skeleton.computeGroupWorldVertices(slot, (world = scratch(skeleton, slot)));
    } else {
      const own = slot.attachment;
      if (!own || !isDrawable(own) || isGroupedMesh(own)) return;
      attachment = own;
      ({ uvs, triangles } = geometryOf(own));
      count = skeleton.computeSlotWorldVertices(slot, (world = scratch(skeleton, slot)));
    }
    const texture = textures.get(attachment.sequence ? sequenceFramePath(attachment.path, attachment.sequence, slot.sequenceFrame) : attachment.path);
    const colors = group ? null : options.vertexColors?.(slot) ?? null;
    const tint = {
      r: slot.color.r * attachment.color.r,
      g: slot.color.g * attachment.color.g,
      b: slot.color.b * attachment.color.b,
      a: slot.color.a * slot.drivenAlpha * attachment.color.a
    };
    if (tint.a <= 0) return;
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    for (let v = 0; v < count; v++) {
      sx[v] = ((world[v * 2] as number) - left) * scale;
      sy[v] = ((world[v * 2 + 1] as number) - top) * scale;
    }
    for (let t = 0; t + 2 < triangles.length; t += 3) {
      rasterTriangle(
        triangles[t] as number,
        triangles[t + 1] as number,
        triangles[t + 2] as number,
        sx,
        sy,
        (px, py, w0, w1, w2, i0, i1, i2) => {
          if (clipped(px, py)) return;
          const u = w0 * (uvs[i0 * 2] as number) + w1 * (uvs[i1 * 2] as number) + w2 * (uvs[i2 * 2] as number);
          const v = w0 * (uvs[i0 * 2 + 1] as number) + w1 * (uvs[i1 * 2 + 1] as number) + w2 * (uvs[i2 * 2 + 1] as number);
          const sample = texture ? bilinear(texture, u, v) : [255, 0, 255, 255];
          const a = sample[3] as number;
          let [r, g, b] = sample as [number, number, number, number];
          if (colors) {
            const cr = w0 * (colors[i0 * 4] as number) + w1 * (colors[i1 * 4] as number) + w2 * (colors[i2 * 4] as number);
            const cg = w0 * (colors[i0 * 4 + 1] as number) + w1 * (colors[i1 * 4 + 1] as number) + w2 * (colors[i2 * 4 + 1] as number);
            const cb = w0 * (colors[i0 * 4 + 2] as number) + w1 * (colors[i1 * 4 + 2] as number) + w2 * (colors[i2 * 4 + 2] as number);
            const ca = (w0 * (colors[i0 * 4 + 3] as number) + w1 * (colors[i1 * 4 + 3] as number) + w2 * (colors[i2 * 4 + 3] as number)) / 255;
            const k = mix * ca;
            r = r * (1 - k) + cr * k;
            g = g * (1 - k) + cg * k;
            b = b * (1 - k) + cb * k;
          }
          const p = py * width + px;
          blendPixel(image, p * 4, r * tint.r, g * tint.g, b * tint.b, a * tint.a);
          if (partialInk && a * tint.a >= 252) {
            partialInk[p] = 0;
            if (options.partialSource) options.partialSource[p] = 0;
          }
          if (topSlot && topTexel && texture && a * tint.a >= 128) {
            const tx = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
            const ty = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
            topSlot[p] = slot.index + 1;
            topTexel[p] = ty * texture.width + tx;
          }
        },
        width,
        height
      );
    }
  };

  const drawContour = (slot: Slot, contour: CompiledContour): void => {
    if (!skeleton.isContourVisible(contour)) return;
    const color: Readonly<Rgba> = contour.color;
    const alpha = color.a * slot.color.a * slot.drivenAlpha * skeleton.contourOwnerAlpha(contour);
    if (alpha <= 0) return;
    const points = new Float32Array(contour.pointCount * 2);
    skeleton.computeContourPoints(contour, points);
    // Clothing model: the stroke's visible runs (trimmed under later opaque coverers, faded ends).
    const runs = skeleton.contourRuns(contour, points);
    if (runs && runs.length === 0) return;
    const capacity = trimmedStrokeCapacity(contour.pointCount, contour.closed, contour.roundCaps, filletCapacity(contour));
    const positions = new Float32Array(capacity.vertices * 2);
    // Flat polygon: a vanishing anti-aliasing band puts the rim at exactly half the width.
    const ramp = { u0: 0, u1: 1, v: 0, rampFraction: 1 };
    const strokeIndices = new Uint32Array(capacity.indices);
    const counts = { vertices: 0, indices: 0 };
    const fade = runs ? new Float32Array(capacity.vertices) : null;
    if (runs && fade) buildTrimmedStroke(points, contour.pointCount, contour.closed, contour.roundCaps, contour.width, 1e-6, ramp, skeleton.contourHandoverRuns(contour, points) ?? runs, positions, new Float32Array(positions.length), strokeIndices, counts, fade, joinedEndMask(contour.joins), skeleton.contourFillets(contour, points), skeleton.contourCappedEnds(contour, points));
    else buildStroke(points, contour.pointCount, contour.closed, contour.roundCaps, contour.width, 1e-6, ramp, positions, new Float32Array(positions.length), strokeIndices, counts);
    const sx = new Float64Array(counts.vertices);
    const sy = new Float64Array(counts.vertices);
    for (let v = 0; v < counts.vertices; v++) {
      sx[v] = ((positions[v * 2] as number) - left) * scale;
      sy[v] = ((positions[v * 2 + 1] as number) - top) * scale;
    }
    const r = 255 * color.r * slot.color.r;
    const g = 255 * color.g * slot.color.g;
    const b = 255 * color.b * slot.color.b;
    // Stroke triangles overlap at joins: plot each pixel once so it is not blended twice.
    const plotted = new Uint8Array(width * height);
    const indices = strokeIndices;
    for (let t = 0; t + 2 < counts.indices; t += 3) {
      rasterTriangle(
        indices[t] as number,
        indices[t + 1] as number,
        indices[t + 2] as number,
        sx,
        sy,
        (px, py, w0, w1, w2, i0, i1, i2) => {
          if (clipped(px, py)) return;
          const p = py * width + px;
          if (plotted[p]) return;
          // A trimmed run end fades along the stroke (fade 0 at the trim, 1 one feather inside).
          const f = fade ? w0 * (fade[i0] as number) + w1 * (fade[i1] as number) + w2 * (fade[i2] as number) : 1;
          if (f <= 0.001) return;
          plotted[p] = 1;
          blendPixel(image, p * 4, r, g, b, 255 * alpha * f);
          if (partialInk && alpha >= 0.99) {
            partialInk[p] = f < 0.99 ? Math.max(partialInk[p] as number, 1 - f) : 0;
            if (options.partialSource) options.partialSource[p] = f < 0.99 ? contour.id + 1 : 0;
          }
          if (topSlot && topTexel && alpha * f >= 0.5) {
            topSlot[p] = slot.index + 1;
            topTexel[p] = -1;
          }
        },
        width,
        height
      );
    }
  };

  let clipEnd: string | null = null;
  for (const slot of skeleton.drawOrder) {
    const own = slot.attachment;
    if (own && own.type === "clipping" && !slot.hidden) {
      const polygon = skeleton.slotPolygonWorld(slot);
      clip = polygon && polygon.length >= 6 ? polygon.map((v, i) => (i % 2 === 0 ? (v - left) * scale : (v - top) * scale)) : null;
      clipEnd = own.endSlot;
      continue;
    }
    if (!options.slotFilter || options.slotFilter(slot)) {
      drawSlot(slot);
      for (const contour of contoursBySlot.get(slot.index) ?? []) drawContour(slot, contour);
    }
    if (clip && clipEnd !== null && slot.data.name === clipEnd) {
      clip = null;
      clipEnd = null;
    }
  }
  const result: SoftRenderResult = { image };
  if (topSlot) result.topSlot = topSlot;
  if (topTexel) result.topTexel = topTexel;
  return result;
}

function geometryOf(attachment: MeshAttachment | RegionAttachment): { uvs: ArrayLike<number>; triangles: ArrayLike<number> } {
  return attachment.type === "mesh"
    ? { uvs: attachment.geometry.uvs, triangles: attachment.geometry.triangles }
    : { uvs: attachment.uvs, triangles: attachment.triangles };
}

type PixelCallback = (x: number, y: number, w0: number, w1: number, w2: number, i0: number, i1: number, i2: number) => void;

/**
 * Pixel centres inside the triangle, with a top-left fill rule so pixels on a shared edge are
 * drawn by exactly one of the two triangles (no double blending along interior edges).
 */
function rasterTriangle(
  i0: number,
  i1: number,
  i2: number,
  xs: Float64Array,
  ys: Float64Array,
  plot: PixelCallback,
  width: number,
  height: number
): void {
  let a = i0;
  let b = i1;
  const c = i2;
  let ax = xs[a] as number;
  let ay = ys[a] as number;
  let bx = xs[b] as number;
  let by = ys[b] as number;
  const cx = xs[c] as number;
  const cy = ys[c] as number;
  let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-12) return;
  if (area < 0) {
    // Make the winding positive (clockwise on a y-down screen).
    [a, b] = [b, a];
    [ax, bx] = [bx, ax];
    [ay, by] = [by, ay];
    area = -area;
  }
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  // Edge function of edge p->q at point s, positive inside for positive winding.
  const edge = (px: number, py: number, qx: number, qy: number, sx: number, sy: number) => (qx - px) * (sy - py) - (qy - py) * (sx - px);
  // Top-left rule on a y-down screen with this winding: an edge owns its pixels when it is a
  // "top" edge (horizontal, going right) or a "left" edge (going up).
  const owns = (px: number, py: number, qx: number, qy: number) => (qy === py && qx > px) || qy < py;
  const ownA = owns(bx, by, cx, cy);
  const ownB = owns(cx, cy, ax, ay);
  const ownC = owns(ax, ay, bx, by);
  for (let y = minY; y <= maxY; y++) {
    const sy = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const sx = x + 0.5;
      const e0 = edge(bx, by, cx, cy, sx, sy);
      const e1 = edge(cx, cy, ax, ay, sx, sy);
      const e2 = edge(ax, ay, bx, by, sx, sy);
      if (e0 < 0 || e1 < 0 || e2 < 0) continue;
      if ((e0 === 0 && !ownA) || (e1 === 0 && !ownB) || (e2 === 0 && !ownC)) continue;
      plot(x, y, e0 / area, e1 / area, e2 / area, a, b, c);
    }
  }
}

/** Bilinear sample at UV (0..1 over the whole image), straight alpha, weighted by alpha. */
function bilinear(image: RgbaImage, u: number, v: number): [number, number, number, number] {
  const fx = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const fy = Math.min(image.height - 1, Math.max(0, v * image.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const add = (x: number, y: number, w: number) => {
    const p = (y * image.width + x) * 4;
    const alpha = (image.data[p + 3] as number) * w;
    r += (image.data[p] as number) * alpha;
    g += (image.data[p + 1] as number) * alpha;
    b += (image.data[p + 2] as number) * alpha;
    a += alpha;
  };
  add(x0, y0, (1 - tx) * (1 - ty));
  add(x1, y0, tx * (1 - ty));
  add(x0, y1, (1 - tx) * ty);
  add(x1, y1, tx * ty);
  if (a <= 0) return [0, 0, 0, 0];
  return [r / a, g / a, b / a, a];
}
