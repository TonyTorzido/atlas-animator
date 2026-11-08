/*
 * Atlas Animator: original implementation.
 *
 * `animator layers plan`: visible-pixel ownership, hidden-completion and uncertain masks per part, sized from the
 * rig's motion, before any art is generated.
 *
 * - Silhouette: the source alpha (ownership covers every pixel with alpha > 0, so antialiasing is
 *   kept; seeds and coverage use alpha >= 128).
 * - Seeds: each part's bones, as thin strokes along the middle of each bone (15%..85% of its
 *   length), clipped to the silhouette; pixels claimed by two parts are dropped. A parts spec may
 *   add seed strokes.
 * - Seeded segmentation: competitive geodesic growth (a seeded watershed). A step costs
 *   1 + edgeWeight * colour difference (premultiplied, 0..1) + boneWeight * distance to the
 *   label's own bones, so boundaries settle on drawn edges near where the skeleton says.
 * - Outlines: an interior ink pixel (dark, not on the silhouette) lying between fill of a part
 *   drawn in front and fill of another part, within an outline width, goes to the front part: a drawn line between
 *   two parts is the occluder's outline, assigned once.
 * - Uncertain: a part's pixels next to another part (one pixel), except the front part's own ink.
 * - Coverage near a joint (`jointExpected`): inside the joint's coverage mask (the joint disc plus
 *   the silhouette within one joint radius of the contact between the two parts), static pixels
 *   stay where they are, moving pixels go where the rotation takes them, and pixels a moving part
 *   drawn in front leaves must be covered by what is behind it, inside the static side's outline
 *   continued under it (a closing by the joint radius). A moving part drawn behind opens
 *   no such hole (nothing in front hid anything); its failure mode is an exposed cut cap, which
 *   `layers check` reports.
 * - Completion, per joint (parent part, child part, pivot = the child's attach bone origin, radius
 *   = the child's local half-width at most): the part drawn behind gets (a) one joint radius under
 *   the part in front, then (b) the union over the probe rotations (the pivot bone's limits) of
 *   the background cracks the visible-only layers open inside the joint disc, mapped back into
 *   its rest frame, (c) grown by max(outline width, 2 px at the smallest display scale) and kept
 *   to what is hidden at rest (under parts drawn above it). What cannot be hidden is reported.
 */
import { z } from "zod";
import { createImage, createMask, type Mask, type MutableImage, type RgbaImage } from "../image.js";
import {
  alphaAt,
  closeDisc,
  compositeLayers,
  countMask,
  dilateDisc,
  discMask,
  distanceTo,
  distanceInside,
  hex,
  intersect,
  inverseSample,
  luma,
  maskFrom,
  PART_COLORS,
  rotation,
  subtract,
  union
} from "./core.js";
import { depthOf, isUnder, rigView, segmentDistance, type RigBone, type RigView } from "./rig.js";

export const partsSpecSchema = z
  .object({
    version: z.literal(1),
    skin: z.string().default("body"),
    parts: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]+$/),
            /** Human wording for prompts ("near foreleg"); default the id. */
            label: z.string().optional(),
            /** Bones whose geometry seeds this part's visible pixels. */
            bones: z.array(z.string()).min(1),
            /** The slot bone; default the root-most of `bones`. */
            bone: z.string().optional(),
            /** Weight domain; default `bones`. */
            allowedBones: z.array(z.string()).min(1).optional(),
            /** Extra seed strokes [x0, y0, x1, y1, radius] in source pixels. */
            seeds: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number().positive()])).optional(),
            /**
             * Keep the part beyond its root: only pixels whose projection on the slot bone's axis
             * is at least `rootOffset` px past the bone's origin (an ear, a horn: the shape above
             * its root, never the skull it sits on).
             */
            clipAtRoot: z.boolean().optional(),
            rootOffset: z.number().optional(),
            /** The part owns nothing farther than this (px) from its own bones (an ear, not the fur tufts beside it). */
            maxBoneDistance: z.number().positive().optional()
          })
          .strict()
      )
      .min(1),
    /** Back to front. */
    drawOrder: z.array(z.string()),
    /** Default: derived from the skeleton (a part's attach bone hanging from another part's bone). */
    joints: z
      .array(
        z
          .object({
            parent: z.string(),
            child: z.string(),
            pivotBone: z.string().optional(),
            kind: z.enum(["overlap", "welded", "membrane"]).default("overlap"),
            radius: z.number().positive().optional(),
            /** Probe range, degrees; default the pivot bone's limits, else -30..30. */
            min: z.number().optional(),
            max: z.number().optional()
          })
          .strict()
      )
      .optional(),
    minDisplayScale: z.number().positive().max(4).default(0.5),
    /** Detached pieces of a part smaller than this (px) go to the part they touch most. */
    minComponentPx: z.number().int().min(0).default(64),
    probeSteps: z.number().int().min(2).max(64).default(8),
    inkThreshold: z.number().min(1).max(255).default(90),
    /** Dark areas thicker than this (px) are dark fill (markings, dark legs), not drawn line. */
    maxLineWidth: z.number().positive().default(8),
    edgeWeight: z.number().min(0).default(6),
    boneWeight: z.number().min(0).default(0.03)
  })
  .strict();
export type PartsSpec = z.output<typeof partsSpecSchema>;

export interface OutlineMeasure {
  widthPx: number;
  color: string;
  aaColor: string | null;
  samples: number;
}

export interface PlannedPart {
  id: string;
  label: string;
  bones: string[];
  bone: string;
  allowedBones: string[];
  pivot: [number, number];
  visible: Mask;
  completion: Mask;
  uncertain: Mask;
  seeds: number;
  outline: OutlineMeasure | null;
  fills: string[];
}

export interface PlannedProbe {
  name: string;
  degrees: number;
  /** Background cracks with the visible-only layers (pixels). */
  cracks: number;
}

export interface PlannedJoint {
  parent: string;
  child: string;
  pivotBone: string;
  kind: "overlap" | "welded" | "membrane";
  pivot: [number, number];
  radius: number;
  margin: number;
  front: string;
  back: string;
  probes: PlannedProbe[];
  /** Joint disc inside the silhouette: what must stay covered (rest frame). */
  coverage: Mask;
  exposedArea: number;
  /** Exposed pixels that are not hidden at rest, so no completion can fill them. */
  unfillable: number;
}

export interface LayerPlan {
  width: number;
  height: number;
  offset: { x: number; y: number };
  parts: PlannedPart[];
  drawOrder: string[];
  joints: PlannedJoint[];
  outline: OutlineMeasure | null;
  occlusion: { front: string; back: string; boundaryPx: number }[];
  overlay: MutableImage;
  notes: string[];
}

/** Painted art is often a few levels short of 255 inside; this counts as opaque. */
const OPAQUE = 240;
/** A front pixel at least this opaque hides completion behind it (within 2/255 at most). */
const HIDES = 250;

const probeName = (bone: string, degrees: number) => `${bone} rotate ${Math.round(degrees * 100) / 100}`;
export const probeDegrees = (name: string): number | null => {
  const m = / rotate (-?[\d.]+)$/.exec(name);
  return m ? Number(m[1]) : null;
};

/** A binary min-heap of (cost, pixel, label). */
class Heap {
  cost = new Float64Array(1024);
  pix = new Int32Array(1024);
  lab = new Int16Array(1024);
  size = 0;
  push(c: number, p: number, l: number): void {
    if (this.size === this.cost.length) {
      const grow = <T extends Float64Array | Int32Array | Int16Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.cost = grow(this.cost);
      this.pix = grow(this.pix);
      this.lab = grow(this.lab);
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.cost[parent] as number) <= c) break;
      this.cost[i] = this.cost[parent] as number;
      this.pix[i] = this.pix[parent] as number;
      this.lab[i] = this.lab[parent] as number;
      i = parent;
    }
    this.cost[i] = c;
    this.pix[i] = p;
    this.lab[i] = l;
  }
  pop(): [number, number, number] {
    const top: [number, number, number] = [this.cost[0] as number, this.pix[0] as number, this.lab[0] as number];
    const n = --this.size;
    const c = this.cost[n] as number;
    const p = this.pix[n] as number;
    const l = this.lab[n] as number;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && (this.cost[child + 1] as number) < (this.cost[child] as number)) child++;
      if ((this.cost[child] as number) >= c) break;
      this.cost[i] = this.cost[child] as number;
      this.pix[i] = this.pix[child] as number;
      this.lab[i] = this.lab[child] as number;
      i = child;
    }
    this.cost[i] = c;
    this.pix[i] = p;
    this.lab[i] = l;
    return top;
  }
}

/**
 * Drawn line ("ink"): opaque-ish pixels darker than `threshold` that are not part of a dark area
 * thicker than `maxLineWidth` (a morphological opening removes the thick dark fill).
 */
export function inkMask(image: RgbaImage, threshold: number, maxLineWidth: number): Mask {
  const dark = maskFrom(image.width, image.height, (i) => alphaAt(image, i) >= 128 && luma(image, i) < threshold);
  const t = maxLineWidth / 2 + 0.5;
  const inside = distanceInside(dark);
  const core = maskFrom(image.width, image.height, (i) => (inside[i] as number) > t);
  return subtract(dark, intersect(dilateDisc(core, t + 0.5), dark));
}

/** Outline width and colours from ink connected to the silhouette edge inside `region`. */
export function measureOutline(source: RgbaImage, ink: Mask, depth: Float64Array, region: Mask | null): OutlineMeasure | null {
  const { width: w, height: h } = source;
  const isInk = (i: number) => ink.data[i] === 1;
  // From each silhouette-edge ink pixel, march inward (to the deepest 8-neighbour) while the
  // pixels stay ink: the run length is the local line width; the median over the edge is the width.
  const queue: number[] = [];
  const runs: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!isInk(i) || (region && !region.data[i]) || (depth[i] as number) > 1.01) continue;
    let at = i;
    let run = 0;
    for (let guard = 0; guard < 24 && isInk(at) && (!region || region.data[at]); guard++) {
      queue.push(at);
      run++;
      const x = at % w;
      const y = (at - x) / w;
      let next = -1;
      let best = depth[at] as number;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if ((depth[j] as number) > best + 0.5) {
            best = depth[j] as number;
            next = j;
          }
        }
      }
      if (next < 0) break;
      at = next;
    }
    runs.push(run);
  }
  if (runs.length < 8) return null;
  runs.sort((p, q) => p - q);
  const median = runs[Math.floor(runs.length / 2)] as number;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let an = 0;
  for (const i of queue) {
    if (alphaAt(source, i) >= OPAQUE) {
      r += source.data[i * 4] as number;
      g += source.data[i * 4 + 1] as number;
      b += source.data[i * 4 + 2] as number;
      n++;
    }
  }
  for (let i = 0; i < w * h; i++) {
    const a = alphaAt(source, i);
    if (a === 0 || a >= OPAQUE || (region && !dilatedContains(region, i))) continue;
    ar += source.data[i * 4] as number;
    ag += source.data[i * 4 + 1] as number;
    ab += source.data[i * 4 + 2] as number;
    an++;
  }
  return {
    widthPx: Math.max(1, median),
    color: n > 0 ? hex(r / n, g / n, b / n) : "#000000",
    aaColor: an > 0 ? hex(ar / an, ag / an, ab / an) : null,
    samples: runs.length
  };
}

// The region masks are visible masks (alpha > 0 pixels), so a semi-transparent rim pixel is in them.
const dilatedContains = (region: Mask, i: number) => region.data[i] === 1;

/** Up to three dominant fill colours (opaque, non-ink) inside `region`. */
function dominantFills(source: RgbaImage, region: Mask, inkThreshold: number): string[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < region.data.length; i++) {
    if (!region.data[i] || alphaAt(source, i) < OPAQUE || luma(source, i) < inkThreshold) continue;
    const r = source.data[i * 4] as number;
    const g = source.data[i * 4 + 1] as number;
    const b = source.data[i * 4 + 2] as number;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  return [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((bin) => hex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n));
}

export function planLayers(source: RgbaImage, rawRig: unknown, specInput: unknown): LayerPlan {
  const spec = partsSpecSchema.parse(specInput);
  const view = rigView(rawRig, source);
  const { width: w, height: h } = source;
  const notes: string[] = [];
  const ids = spec.parts.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate part ids: ${ids.join(", ")}`);
  const order = spec.drawOrder;
  if (order.length !== ids.length || new Set(order).size !== order.length || order.some((id) => !ids.includes(id))) {
    throw new Error(`drawOrder must list every part once (parts: ${ids.join(", ")}; drawOrder: ${order.join(", ")})`);
  }
  const rank = new Map(order.map((id, k) => [id, k]));
  const bone = (name: string): RigBone => {
    const b = view.bones.get(name);
    if (!b) throw new Error(`no bone '${name}' in the rig`);
    return b;
  };
  for (const part of spec.parts) for (const b of [...part.bones, ...(part.allowedBones ?? []), ...(part.bone ? [part.bone] : [])]) bone(b);
  const owner = new Map<string, string>();
  for (const part of spec.parts) {
    for (const b of part.bones) {
      if (owner.has(b)) throw new Error(`bone '${b}' seeds both '${owner.get(b)}' and '${part.id}'`);
      owner.set(b, part.id);
    }
  }
  const attachBone = (part: PartsSpec["parts"][number]) => part.bone ?? [...part.bones].sort((a, b) => depthOf(view, a) - depthOf(view, b))[0] as string;

  // --- silhouette and seeds -------------------------------------------------------------------
  const present = maskFrom(w, h, (i) => alphaAt(source, i) > 0);
  const solid = maskFrom(w, h, (i) => alphaAt(source, i) >= 128);
  const depth = distanceInside(solid);
  const ink = inkMask(source, spec.inkThreshold, spec.maxLineWidth);
  const outline = measureOutline(source, ink, depth, null);
  const outlineWidth = outline?.widthPx ?? 2;
  const labels = new Int16Array(w * h).fill(-1);
  const seed = new Int16Array(w * h).fill(-1);
  const seedCounts = spec.parts.map(() => 0);
  // Domains: a part clipped at its root owns nothing behind the root line.
  const reachOf = (part: PartsSpec["parts"][number], i: number) => {
    if (part.maxBoneDistance === undefined) return true;
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    return part.bones.some((name) => segmentDistance(bone(name), x, y) <= (part.maxBoneDistance as number));
  };
  const domain = spec.parts.map((part) => {
    if (!part.clipAtRoot) return part.maxBoneDistance === undefined ? null : maskFrom(w, h, (i) => reachOf(part, i));
    const b = bone(attachBone(part));
    const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    if (len < 1e-6) throw new Error(`part '${part.id}': clipAtRoot needs a slot bone with a length`);
    const ux = (b.x1 - b.x0) / len;
    const uy = (b.y1 - b.y0) / len;
    const offset = part.rootOffset ?? 0;
    return maskFrom(w, h, (i) => ((i % w) + 0.5 - b.x0) * ux + (Math.floor(i / w) + 0.5 - b.y0) * uy >= offset && reachOf(part, i));
  });
  const inDomain = (k: number, i: number) => {
    const d = domain[k];
    return !d || d.data[i] === 1;
  };
  // Seeds of a part stop short of the roots of the parts hanging from it (a neck bone ending at
  // the head's root must not seed the head's cheek): no seed within 0.6 x the silhouette depth
  // (4..40 px) of a child part's root.
  const childRoots = spec.parts.map((part) => {
    const roots: { x: number; y: number; r: number }[] = [];
    for (const other of spec.parts) {
      if (other === part) continue;
      let parentPart: string | undefined;
      for (let b = view.bones.get(attachBone(other))?.parent ?? null; b && !parentPart; b = view.bones.get(b)?.parent ?? null) parentPart = owner.get(b);
      if (parentPart !== part.id) continue;
      const o = bone(attachBone(other));
      const oi = Math.min(h - 1, Math.max(0, Math.floor(o.y0))) * w + Math.min(w - 1, Math.max(0, Math.floor(o.x0)));
      roots.push({ x: o.x0, y: o.y0, r: Math.max(4, Math.min(40, 0.6 * (depth[oi] as number))) });
    }
    return roots;
  });
  const stroke = (k: number, x0: number, y0: number, x1: number, y1: number, radius: number, t0: number, t1: number) => {
    const seg: RigBone = { name: "", parent: null, x0, y0, x1, y1, length: 0, limits: null };
    const xa = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
    const xb = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
    const yb = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const i = y * w + x;
        if (!solid.data[i] || !inDomain(k, i) || segmentDistance(seg, x + 0.5, y + 0.5, t0, t1) > radius) continue;
        if ((childRoots[k] as { x: number; y: number; r: number }[]).some((c) => Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) < c.r)) continue;
        const s = seed[i] as number;
        if (s === -1) seed[i] = k;
        else if (s !== k) seed[i] = -2;
      }
    }
  };
  spec.parts.forEach((part, k) => {
    for (const name of part.bones) {
      const b = bone(name);
      const mx = Math.min(w - 1, Math.max(0, Math.floor((b.x0 + b.x1) / 2)));
      const my = Math.min(h - 1, Math.max(0, Math.floor((b.y0 + b.y1) / 2)));
      const radius = Math.max(1.5, Math.min(5, 0.3 * (depth[my * w + mx] as number)));
      stroke(k, b.x0, b.y0, b.x1, b.y1, radius, b.length > 0 ? 0.15 : 0, b.length > 0 ? 0.85 : 0);
    }
    for (const [x0, y0, x1, y1, r] of part.seeds ?? []) stroke(k, x0, y0, x1, y1, r, 0, 1);
  });
  for (let i = 0; i < seed.length; i++) if ((seed[i] as number) >= 0) seedCounts[seed[i] as number] = (seedCounts[seed[i] as number] as number) + 1;
  spec.parts.forEach((part, k) => {
    if (seedCounts[k] === 0) throw new Error(`part '${part.id}' has no seed pixel inside the silhouette (its bones lie outside the art, or every seed is shared): add seed strokes`);
  });

  // --- seeded segmentation (competitive geodesic growth) --------------------------------------
  const partBones = spec.parts.map((part) => part.bones.map(bone));
  const boneDistance = (k: number, x: number, y: number) => {
    let best = Infinity;
    for (const b of partBones[k] as RigBone[]) best = Math.min(best, segmentDistance(b, x + 0.5, y + 0.5));
    return best;
  };
  const heap = new Heap();
  for (let i = 0; i < seed.length; i++) if ((seed[i] as number) >= 0) heap.push(0, i, seed[i] as number);
  const pm = (i: number, c: number) => ((source.data[i * 4 + c] as number) * (source.data[i * 4 + 3] as number)) / 255;
  const colourStep = (i: number, j: number) => Math.max(Math.abs(pm(i, 0) - pm(j, 0)), Math.abs(pm(i, 1) - pm(j, 1)), Math.abs(pm(i, 2) - pm(j, 2)), Math.abs(alphaAt(source, i) - alphaAt(source, j))) / 255;
  while (heap.size > 0) {
    const [cost, i, k] = heap.pop();
    if ((labels[i] as number) !== -1) continue;
    labels[i] = k;
    const x = i % w;
    const y = (i - x) / w;
    const visit = (j: number, nx: number, ny: number) => {
      if (!present.data[j] || (labels[j] as number) !== -1 || !inDomain(k, j)) return;
      heap.push(cost + 1 + spec.edgeWeight * colourStep(i, j) + spec.boneWeight * boneDistance(k, nx, ny), j, k);
    };
    if (x > 0) visit(i - 1, x - 1, y);
    if (x < w - 1) visit(i + 1, x + 1, y);
    if (y > 0) visit(i - w, x, y - 1);
    if (y < h - 1) visit(i + w, x, y + 1);
  }
  // Islands no seed reached: the nearest bone's part.
  let islands = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!present.data[i] || (labels[i] as number) !== -1) continue;
    const x = i % w;
    const y = (i - x) / w;
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < spec.parts.length; k++) {
      if (!inDomain(k, i)) continue;
      const d = boneDistance(k, x, y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    labels[i] = best;
    islands++;
  }
  if (islands > 0) notes.push(`${islands} pixel(s) in islands no seed reached went to the nearest bone's part`);

  type JointSpec = NonNullable<PartsSpec["joints"]>[number];
  let jointSpecs: JointSpec[];
  if (spec.joints) jointSpecs = spec.joints;
  else {
    jointSpecs = [];
    for (const part of spec.parts) {
      const root = attachBone(part);
      let parentPart: string | undefined;
      for (let b = view.bones.get(root)?.parent ?? null; b && !parentPart; b = view.bones.get(b)?.parent ?? null) parentPart = owner.get(b);
      if (parentPart) jointSpecs.push({ parent: parentPart, child: part.id, pivotBone: root, kind: "overlap" });
    }
  }
  // --- joint cuts: live-wire refinement ------------------------------------------------------
  // Competitive growth bisects flat fur with straight lines. Near each joint the cut between the
  // two parts is redrawn as the cheapest path across the silhouette between the two places where
  // their shared boundary meets the background or a third part, inside a band around the current boundary: drawn
  // lines are cheap, colour edges cheaper than flat fill, so the cut follows a contour or a fur
  // boundary, and otherwise takes the narrowest crossing (a neck, a shoulder).
  {
    const edge = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!present.data[i]) continue;
      const x = i % w;
      let g = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < w * h ? i + w : -1]) if (j >= 0 && present.data[j]) g = Math.max(g, colourStep(i, j));
      edge[i] = ink.data[i] ? 0.15 : 1 + 6 * (1 - Math.min(1, g * 4));
    }
    const index0 = new Map(ids.map((id, k) => [id, k]));
    for (const js of jointSpecs) {
      const a = index0.get(js.parent);
      const c = index0.get(js.child);
      if (a === undefined || c === undefined) continue;
      const boundary = maskFrom(w, h, (i) => {
        const l = labels[i];
        if (l !== a && l !== c) return false;
        const other = l === a ? c : a;
        const x = i % w;
        return (x > 0 && labels[i - 1] === other) || (x < w - 1 && labels[i + 1] === other) || (i >= w && labels[i - w] === other) || (i + w < w * h && labels[i + w] === other);
      });
      if (countMask(boundary) === 0) continue;
      const pb = bone(js.pivotBone ?? attachBone(spec.parts[c] as PartsSpec["parts"][number]));
      const pi = Math.min(h - 1, Math.max(0, Math.floor(pb.y0))) * w + Math.min(w - 1, Math.max(0, Math.floor(pb.x0)));
      const reach = Math.max(8, Math.min(60, 1.5 * Math.max(depth[pi] as number, 8)));
      const near = distanceTo(boundary);
      // The cut keeps clear of both parts' seeds and of the child's root (a hip, a shoulder stays
      // with its limb), so it cannot shortcut through a limb below its root.
      const keepOut = dilateDisc(maskFrom(w, h, (i) => seed[i] === a || seed[i] === c), 2);
      const rootClear = Math.min(Math.max(4, 0.35 * (depth[pi] as number)), Math.max(1, 0.5 * (near[pi] as number)));
      const band = maskFrom(w, h, (i) => present.data[i] === 1 && (labels[i] === a || labels[i] === c) && (near[i] as number) <= reach && inDomain(a, i) && inDomain(c, i));
      const passable = maskFrom(w, h, (i) => band.data[i] === 1 && !keepOut.data[i] && Math.hypot((i % w) + 0.5 - pb.x0, Math.floor(i / w) + 0.5 - pb.y0) > rootClear);
      // Terminals: band pixels next to the background, in connected arcs.
      const nextToBackground = (i: number) => {
        const x = i % w;
        const open = (j: number) => !solid.data[j] || (labels[j] !== a && labels[j] !== c);
        return (x > 0 && open(i - 1)) || (x < w - 1 && open(i + 1)) || (i >= w && open(i - w)) || (i + w < w * h && open(i + w));
      };
      // The cut ends where it meets the background (below half alpha: a faint haze around painted
      // art is not body) or a third part.
      const term = maskFrom(w, h, (i) => band.data[i] === 1 && solid.data[i] === 1 && nextToBackground(i));
      // The two ends of the current cut: where the shared boundary reaches the background. The
      // path runs between the silhouette pixels near each end.
      // The grown boundary usually stops at the inside of the silhouette's outline (the line is
      // one part's): look an outline width further for the background.
      const boundaryNear = dilateDisc(boundary, outlineWidth + 3);
      const ends = connectedComponents8(maskFrom(w, h, (i) => term.data[i] === 1 && boundaryNear.data[i] === 1), w, h);
      if (ends.length < 2) {
        notes.push(`joint ${js.parent} -> ${js.child}: the cut reaches the background at ${ends.length} place(s); kept the grown boundary`);
        continue;
      }
      const centre = (comp: number[]): [number, number] => {
        let sx = 0;
        let sy = 0;
        for (const i of comp) {
          sx += i % w;
          sy += Math.floor(i / w);
        }
        return [sx / comp.length, sy / comp.length];
      };
      let pair: [number, number] = [0, 1];
      let bestGap = -1;
      const centres = ends.map(centre);
      for (let p1 = 0; p1 < ends.length; p1++) {
        for (let p2 = p1 + 1; p2 < ends.length; p2++) {
          const gap = Math.hypot((centres[p1] as [number, number])[0] - (centres[p2] as [number, number])[0], (centres[p1] as [number, number])[1] - (centres[p2] as [number, number])[1]);
          if (gap > bestGap) {
            bestGap = gap;
            pair = [p1, p2];
          }
        }
      }
      const radiusEnd = Math.max(6, reach / 2);
      const termNear = (c0: [number, number]) => {
        const out: number[] = [];
        for (let i = 0; i < w * h; i++) if (term.data[i] && Math.hypot((i % w) - c0[0], Math.floor(i / w) - c0[1]) <= radiusEnd) out.push(i);
        return out;
      };
      const from = termNear(centres[pair[0]] as [number, number]);
      const to = termNear(centres[pair[1]] as [number, number]);
      if (from.length === 0 || to.length === 0) continue;
      const target = new Uint8Array(w * h);
      for (const i of to) target[i] = 1;
      const dist = new Float64Array(w * h).fill(Infinity);
      const prev = new Int32Array(w * h).fill(-1);
      const q = new Heap();
      for (const i of from) {
        if (!passable.data[i]) continue;
        dist[i] = edge[i] as number;
        q.push(dist[i] as number, i, 0);
      }
      let end = -1;
      while (q.size > 0) {
        const [d, i] = q.pop();
        if (d > (dist[i] as number)) continue;
        if (target[i]) {
          end = i;
          break;
        }
        const x = i % w;
        const y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!passable.data[j]) continue;
            const nd = d + (edge[j] as number) * (dx && dy ? Math.SQRT2 : 1);
            if (nd < (dist[j] as number)) {
              dist[j] = nd;
              prev[j] = i;
              q.push(nd, j, 0);
            }
          }
        }
      }
      if (end < 0) continue;
      const cut = createMask(w, h);
      for (let i = end; i >= 0; i = prev[i] as number) cut.data[i] = 1;
      // Each side of the cut takes the label most of it had; the cut goes to the part in front.
      // Sides are split over the solid pixels only: a semi-transparent rim runs round the cut's
      // ends and would join them. Rim pixels then follow their solid neighbour.
      const rest = maskFrom(w, h, (i) => band.data[i] === 1 && solid.data[i] === 1 && !cut.data[i]);
      const front = (rank.get(js.parent) as number) > (rank.get(js.child) as number) ? a : c;
      for (const comp of connectedComponents4(rest, w, h)) {
        let na = 0;
        let sa = 0;
        let sc = 0;
        for (const i of comp) {
          if (labels[i] === a) na++;
          if (seed[i] === a) sa++;
          if (seed[i] === c) sc++;
        }
        const l = sc > sa ? c : sa > sc ? a : na * 2 >= comp.length ? a : c;
        for (const i of comp) if (inDomain(l, i)) labels[i] = l;
      }
      for (let i = 0; i < w * h; i++) if (cut.data[i] && inDomain(front, i)) labels[i] = front;
      for (let i = 0; i < w * h; i++) {
        if (!band.data[i] || solid.data[i]) continue;
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < w * h ? i + w : -1]) {
          if (j >= 0 && solid.data[j] && band.data[j] && inDomain(labels[j] as number, i)) {
            labels[i] = labels[j] as number;
            break;
          }
        }
      }
    }
  }

  // --- outlines: an interior line between two parts belongs to the part in front --------------
  const reach = Math.ceil(outlineWidth) + 1;
  const isInk = (i: number) => ink.data[i] === 1;
  const reassigned: [number, number][] = [];
  for (let i = 0; i < labels.length; i++) {
    if (!isInk(i) || (depth[i] as number) <= reach) continue;
    const own = labels[i] as number;
    const x = i % w;
    const y = (i - x) / w;
    let front = own;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const l = labels[j] as number;
        if (l < 0 || !present.data[j] || isInk(j)) continue;
        if (!((rank.get(ids[l] as string) as number) > (rank.get(ids[front] as string) as number) && inDomain(l, i))) continue;
        // Only a line between two parts: the pixel opposite (through the line) must be fill of
        // another part. A back part's own side outline running past the front part's edge stays
        // the back part's (it would otherwise ride on the front part as loose dashes).
        const ox = x - dx;
        const oy = y - dy;
        if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
        const o = oy * w + ox;
        const lo = labels[o] as number;
        if (lo < 0 || lo === l || !present.data[o] || isInk(o)) continue;
        front = l;
      }
    }
    if (front !== own) reassigned.push([i, front]);
  }
  for (const [i, l] of reassigned) labels[i] = l;

  // --- tiny-component cleanup: a detached speck of a part joins the part it touches most ------
  {
    const cleaned: string[] = [];
    spec.parts.forEach((part, k) => {
      // Over solid pixels (alpha >= 128, what outline tracing sees), 4-connected: islands joined
      // to the body only through antialiasing or a diagonal are detached pieces too.
      const own = maskFrom(w, h, (i) => solid.data[i] === 1 && labels[i] === k);
      // 4-connected, as the outline tracer splits components.
      const comps = connectedComponents4(own, w, h).sort((p, q) => q.length - p.length);
      let moved = 0;
      let pieces = 0;
      for (const comp of comps.slice(1)) {
        if (comp.length >= spec.minComponentPx) continue;
        const touch = new Map<number, number>();
        for (const i of comp) {
          const x = i % w;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < w * h ? i + w : -1]) {
            const l = j >= 0 && present.data[j] ? (labels[j] as number) : -1;
            if (l >= 0 && l !== k && inDomain(l, i)) touch.set(l, (touch.get(l) ?? 0) + 1);
          }
        }
        const best = [...touch.entries()].sort((p, q) => q[1] - p[1])[0];
        if (!best) continue;
        // The piece and its own antialiased rim move together.
        const rim: number[] = [];
        for (const i of comp) {
          const x = i % w;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = i + dy * w + dx;
              if (x + dx < 0 || x + dx >= w || j < 0 || j >= w * h) continue;
              if (!solid.data[j] && present.data[j] && labels[j] === k && inDomain(best[0], j)) rim.push(j);
            }
          }
        }
        for (const i of comp) labels[i] = best[0];
        for (const j of rim) labels[j] = best[0];
        moved += comp.length;
        pieces++;
      }
      if (pieces > 0) cleaned.push(`${part.id} ${pieces} piece(s) ${moved} px`);
    });
    if (cleaned.length > 0) notes.push(`cleanup: detached pieces under ${spec.minComponentPx} px joined their neighbours: ${cleaned.join("; ")}`);
  }

  // --- per-part masks ---------------------------------------------------------------------------
  const visible = spec.parts.map((_, k) => maskFrom(w, h, (i) => present.data[i] === 1 && labels[i] === k));
  const uncertain = spec.parts.map((part, k) =>
    maskFrom(w, h, (i) => {
      if (labels[i] !== k || !present.data[i]) return false;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          const l = labels[j] as number;
          if (!present.data[j] || l === k || l < 0) continue;
          const inFront = (rank.get(part.id) as number) > (rank.get(ids[l] as string) as number);
          if (!(inFront && isInk(i))) return true;
        }
      }
      return false;
    })
  );

  // --- joints -----------------------------------------------------------------------------------
  const index = new Map(ids.map((id, k) => [id, k]));
  const hiddenUnder = (k: number) => {
    const out = createMask(w, h);
    // Only fully opaque front pixels hide anything (completion under antialiasing would show).
    for (const [id, r] of rank) if (r > (rank.get(ids[k] as string) as number)) for (let i = 0; i < out.data.length; i++) if ((visible[index.get(id) as number] as Mask).data[i] && alphaAt(source, i) >= HIDES) out.data[i] = 1;
    return out;
  };
  const completion = spec.parts.map(() => createMask(w, h));
  const joints: PlannedJoint[] = [];
  for (const js of jointSpecs) {
    const pk = index.get(js.parent);
    const ck = index.get(js.child);
    if (pk === undefined || ck === undefined) throw new Error(`joint ${js.parent} -> ${js.child}: unknown part`);
    const childPart = spec.parts[ck] as PartsSpec["parts"][number];
    const pivotBone = js.pivotBone ?? attachBone(childPart);
    const pb = bone(pivotBone);
    const px = pb.x0;
    const py = pb.y0;
    const pi = Math.min(h - 1, Math.max(0, Math.floor(py))) * w + Math.min(w - 1, Math.max(0, Math.floor(px)));
    const childDepth = distanceInside(visible[ck] as Mask);
    let childHalf = 0;
    for (let i = 0; i < childDepth.length; i++) childHalf = Math.max(childHalf, childDepth[i] as number);
    // Local joint radius: the child's half-width near the pivot (its deepest pixel within its own
    // greatest half-width of the pivot), else the silhouette depth at the pivot.
    let local = 0;
    for (let i = 0; i < childDepth.length; i++) {
      const d = childDepth[i] as number;
      if (d > local && Math.hypot((i % w) + 0.5 - px, Math.floor(i / w) + 0.5 - py) <= childHalf) local = d;
    }
    const radius = js.radius ?? Math.max(3, local > 0 ? local : Math.min(depth[pi] as number, childHalf));
    const front = (rank.get(js.parent) as number) > (rank.get(js.child) as number) ? pk : ck;
    const back = front === pk ? ck : pk;
    const backOutline = measureOutline(source, ink, depth, visible[back] as Mask);
    const margin = Math.max(backOutline?.widthPx ?? outlineWidth, 2 / spec.minDisplayScale);
    const min = js.min ?? pb.limits?.min ?? -30;
    const max = js.max ?? pb.limits?.max ?? 30;
    const angles: number[] = [];
    for (let s = 0; s <= spec.probeSteps; s++) {
      const a = min + ((max - min) * s) / spec.probeSteps;
      if (Math.abs(a) > 1e-9) angles.push(Math.round(a * 100) / 100);
    }
    const moving = spec.parts.map((part) => isUnder(view, attachBone(part), pivotBone));
    const movingVisible = (i: number) => moving.some((m, k) => m && (visible[k] as Mask).data[i] === 1);
    const staticVisible = (i: number) => moving.some((m, k) => !m && (visible[k] as Mask).data[i] === 1);
    const staticHull = staticHullMask(visible, moving, radius);
    const hullAt = (i: number) => staticHull.data[i] === 1;
    // The contact: where the two parts' visible pixels meet. What must stay covered is the joint
    // disc plus everything within one joint radius of the contact; the part behind starts with one
    // joint radius under the part in front, from the contact.
    const vp = visible[pk] as Mask;
    const vc = visible[ck] as Mask;
    const contact = maskFrom(w, h, (i) => {
      const other = vp.data[i] ? vc : vc.data[i] ? vp : null;
      if (!other) return false;
      const x = i % w;
      return (x > 0 && other.data[i - 1] === 1) || (x < w - 1 && other.data[i + 1] === 1) || (i >= w && other.data[i - w] === 1) || (i + w < w * h && other.data[i + w] === 1);
    });
    const disc = discMask(w, h, px, py, radius);
    const hasContact = countMask(contact) > 0;
    if (!hasContact) notes.push(`joint ${js.parent} -> ${js.child}: the parts do not touch; coverage uses the joint disc only`);
    const zone = hasContact ? dilateDisc(contact, radius) : disc;
    const coverage = intersect(union(disc, zone), solid);
    const initial = intersect(zone, visible[front] as Mask);
    let reachR = radius;
    for (let i = 0; i < coverage.data.length; i++) if (coverage.data[i]) reachR = Math.max(reachR, Math.hypot((i % w) + 0.5 - px, Math.floor(i / w) + 0.5 - py));
    const exposed = createMask(w, h);
    const probes: PlannedProbe[] = [];
    const x0 = Math.max(0, Math.floor(px - reachR - 1));
    const x1 = Math.min(w - 1, Math.ceil(px + reachR + 1));
    const y0 = Math.max(0, Math.floor(py - reachR - 1));
    const y1 = Math.min(h - 1, Math.ceil(py + reachR + 1));
    for (const degrees of angles) {
      const rot = rotation(px, py, degrees);
      let cracks = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          const back0 = inverseSample(rot, w, h, x, y);
          if (!jointExpected(coverage, i, back0, movingVisible, staticVisible, !moving[back], hullAt)) continue;
          let covered = false;
          for (let k = 0; k < spec.parts.length && !covered; k++) {
            const s = moving[k] ? back0 : i;
            if (s >= 0 && (visible[k] as Mask).data[s] && alphaAt(source, s) >= 128) covered = true;
          }
          if (covered) continue;
          cracks++;
          const need = moving[back] ? back0 : i;
          if (need >= 0) exposed.data[need] = 1;
        }
      }
      probes.push({ name: probeName(pivotBone, degrees), degrees, cracks });
    }
    const hidden = hiddenUnder(back);
    let unfillable = 0;
    for (let i = 0; i < exposed.data.length; i++) if (exposed.data[i] && !hidden.data[i]) unfillable++;
    const grown = subtract(intersect(dilateDisc(union(initial, exposed), margin), hidden), visible[back] as Mask);
    completion[back] = union(completion[back] as Mask, grown);
    // Pivot diagnostic: a pivot far from where the two parts meet swings the child about the
    // wrong point (the root rotates out from under its occluder).
    if (hasContact) {
      let sx = 0;
      let sy = 0;
      let sn = 0;
      for (let i = 0; i < contact.data.length; i++) {
        if (!contact.data[i]) continue;
        sx += (i % w) + 0.5;
        sy += Math.floor(i / w) + 0.5;
        sn++;
      }
      const off = Math.hypot(sx / sn - px, sy / sn - py);
      if (off > 0.75 * radius) notes.push(`pivot: joint ${js.parent} -> ${js.child}: the pivot (${round2(px)}, ${round2(py)}) is ${Math.round(off)} px from the contact centre (${Math.round(sx / sn)}, ${Math.round(sy / sn)}); joint radius ${round2(radius)}`);
    }
    if (unfillable > 0) notes.push(`joint ${js.parent} -> ${js.child}: ${unfillable} exposed pixel(s) are not hidden at rest under a part in front of '${ids[back]}', so no completion can fill them (revise the split, the occlusion order or the motion range)`);
    joints.push({
      parent: js.parent,
      child: js.child,
      pivotBone,
      kind: js.kind,
      pivot: [round2(px), round2(py)],
      radius: round2(radius),
      margin: round2(margin),
      front: ids[front] as string,
      back: ids[back] as string,
      probes,
      coverage,
      exposedArea: countMask(exposed),
      unfillable
    });
  }

  // --- occlusion graph --------------------------------------------------------------------------
  const pairs = new Map<string, number>();
  for (let i = 0; i < labels.length; i++) {
    if (!present.data[i]) continue;
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i + w < labels.length ? i + w : -1]) {
      if (j < 0 || !present.data[j] || labels[j] === labels[i]) continue;
      const a = ids[labels[i] as number] as string;
      const b = ids[labels[j] as number] as string;
      const [front, back] = (rank.get(a) as number) > (rank.get(b) as number) ? [a, b] : [b, a];
      const key = `${front}\u0000${back}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const occlusion = [...pairs.entries()].map(([key, boundaryPx]) => {
    const [front, back] = key.split("\u0000") as [string, string];
    return { front, back, boundaryPx };
  }).sort((a, b) => b.boundaryPx - a.boundaryPx);

  const parts: PlannedPart[] = spec.parts.map((part, k) => {
    const root = attachBone(part);
    const b = bone(root);
    const vis = visible[k] as Mask;
    const near = countMask(completion[k] as Mask) > 0 ? intersect(dilateDisc(completion[k] as Mask, 3 * outlineWidth + 6), vis) : vis;
    return {
      id: part.id,
      label: part.label ?? part.id,
      bones: [...part.bones],
      bone: root,
      allowedBones: [...(part.allowedBones ?? part.bones)],
      pivot: [round2(b.x0), round2(b.y0)],
      visible: vis,
      completion: completion[k] as Mask,
      uncertain: uncertain[k] as Mask,
      seeds: seedCounts[k] as number,
      outline: measureOutline(source, ink, depth, vis),
      fills: dominantFills(source, countMask(near) > 0 ? near : vis, spec.inkThreshold)
    };
  });
  // Plausibility: a part's pixels should sit around its own bones.
  spec.parts.forEach((part, k) => {
    const vis = visible[k] as Mask;
    let reach = 0;
    for (const b of partBones[k] as RigBone[]) {
      for (let s = 0; s <= 8; s++) {
        const x = Math.floor(b.x0 + ((b.x1 - b.x0) * s) / 8);
        const y = Math.floor(b.y0 + ((b.y1 - b.y0) * s) / 8);
        if (x >= 0 && y >= 0 && x < w && y < h) reach = Math.max(reach, depth[y * w + x] as number);
      }
    }
    reach = Math.max(reach, 4);
    let n = 0;
    let cx = 0;
    let cy = 0;
    let far = 0;
    for (let i = 0; i < vis.data.length; i++) {
      if (!vis.data[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      n++;
      cx += x + 0.5;
      cy += y + 0.5;
      if (boneDistance(k, x, y) > 1.5 * reach) far++;
    }
    if (n === 0) return void notes.push(`plausibility: part '${part.id}' owns no pixels`);
    const centroidDistance = boneDistance(k, cx / n - 0.5, cy / n - 0.5);
    const farShare = far / n;
    const bonesLength = (partBones[k] as RigBone[]).reduce((sum, b) => sum + Math.max(b.length, 1), 0);
    const expectedArea = bonesLength * 2 * reach;
    if (centroidDistance > reach) notes.push(`plausibility: part '${part.id}': its centroid is ${Math.round(centroidDistance)} px from its bones (body depth there ${Math.round(reach)} px): check the seeds and the split`);
    if (farShare > 0.2) notes.push(`plausibility: part '${part.id}': ${Math.round(farShare * 100)}% of its pixels are over ${Math.round(1.5 * reach)} px from its bones`);
    if (n > 2.5 * expectedArea || n < 0.15 * expectedArea) notes.push(`plausibility: part '${part.id}': ${n} px against about ${Math.round(expectedArea)} px expected from its bones (length x body depth)`);
  });
  const overlay = drawOverlay(source, parts, seed, joints, view);
  return { width: w, height: h, offset: view.offset, parts, drawOrder: [...order], joints, outline, occlusion, overlay, notes };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function componentsOf(mask: Mask, w: number, h: number, diagonal: boolean): number[][] {
  const seen = new Uint8Array(w * h);
  const out: number[][] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask.data[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k] as number;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask.data[j] && !seen[j]) {
            seen[j] = 1;
            comp.push(j);
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}
const connectedComponents8 = (m: Mask, w: number, h: number) => componentsOf(m, w, h, true);
const connectedComponents4 = (m: Mask, w: number, h: number) => componentsOf(m, w, h, false);

/**
 * Whether pixel `i` must be covered at a probe pose (see the file comment). `back0` is the rest
 * pixel the rotation brings to `i` (-1 off canvas); `frontMoves`: the moving side is drawn in front.
 */
export function jointExpected(coverage: Mask, i: number, back0: number, movingAt: (i: number) => boolean, staticAt: (i: number) => boolean, frontMoves: boolean, staticHullAt: (i: number) => boolean): boolean {
  if (coverage.data[i] === 1 && staticAt(i)) return true;
  if (back0 >= 0 && coverage.data[back0] === 1 && movingAt(back0)) return true;
  return frontMoves && coverage.data[i] === 1 && movingAt(i) && staticHullAt(i);
}

/**
 * The static side's outline continued under the moving part: the closing (by the joint radius) of
 * the static parts' visible pixels. A pixel a front part leaves is a hole only inside it (below a
 * belly line, say, it is background).
 */
export function staticHullMask(visible: readonly Mask[], moving: readonly boolean[], radius: number): Mask {
  const first = visible[0] as Mask;
  const stat = maskFrom(first.width, first.height, (i) => visible.some((m, k) => !moving[k] && m.data[i] === 1));
  return closeDisc(stat, radius);
}

function drawOverlay(source: RgbaImage, parts: readonly PlannedPart[], seed: Int16Array, joints: readonly PlannedJoint[], view: RigView): MutableImage {
  const { width: w, height: h } = source;
  const base = compositeLayers([source], w, h, undefined, [128, 128, 128]);
  const out = createImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const g = 0.299 * (base.data[p] as number) + 0.587 * (base.data[p + 1] as number) + 0.114 * (base.data[p + 2] as number);
    let r = g * 0.6 + 50;
    let gg = g * 0.6 + 50;
    let b = g * 0.6 + 50;
    const x = i % w;
    const y = (i - x) / w;
    parts.forEach((part, k) => {
      const c = PART_COLORS[k % PART_COLORS.length] as readonly [number, number, number];
      if (part.visible.data[i]) {
        r = r * 0.5 + c[0] * 0.5;
        gg = gg * 0.5 + c[1] * 0.5;
        b = b * 0.5 + c[2] * 0.5;
      }
      if (part.completion.data[i] && (x + y) % 6 < 3) {
        r = c[0];
        gg = c[1];
        b = c[2];
      }
    });
    if (parts.some((part) => part.uncertain.data[i])) r = gg = b = 255;
    const s = seed[i] as number;
    if (s >= 0) {
      const c = PART_COLORS[s % PART_COLORS.length] as readonly [number, number, number];
      r = c[0] * 0.6;
      gg = c[1] * 0.6;
      b = c[2] * 0.6;
    }
    out.data[p] = Math.round(r);
    out.data[p + 1] = Math.round(gg);
    out.data[p + 2] = Math.round(b);
    out.data[p + 3] = 255;
  }
  const dot = (x: number, y: number, rad: number, c: readonly [number, number, number]) => {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dy * dy > rad * rad) continue;
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const p = (py * w + px) * 4;
        out.data[p] = c[0];
        out.data[p + 1] = c[1];
        out.data[p + 2] = c[2];
      }
    }
  };
  for (const b of view.bones.values()) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x1 - b.x0, b.y1 - b.y0)));
    for (let s = 0; s <= steps; s++) dot(b.x0 + ((b.x1 - b.x0) * s) / steps, b.y0 + ((b.y1 - b.y0) * s) / steps, 1, [0, 0, 0]);
    dot(b.x0, b.y0, 2, [255, 255, 255]);
  }
  for (const j of joints) {
    const steps = Math.ceil(2 * Math.PI * j.radius);
    for (let s = 0; s < steps; s++) dot(j.pivot[0] + j.radius * Math.cos((2 * Math.PI * s) / steps), j.pivot[1] + j.radius * Math.sin((2 * Math.PI * s) / steps), 0, [255, 230, 0]);
    dot(j.pivot[0], j.pivot[1], 3, [255, 230, 0]);
  }
  return out;
}
