/*
 * Atlas Animator: original implementation.
 *
 * Layered-parts pipeline: the rig seen from the source image. A rig document's
 * canvas need not be the source image's size: a source imported whole (`atlas import` of a PNG
 * that is not canvas-sized) has its opaque bounds placed at (originX - w/2, originY - h), exactly
 * as `partPlacement` does, so source pixel + offset = rig canvas pixel. Bone geometry here is in
 * source pixels at the setup pose.
 */
import { loadAnimDocument } from "../../core/formatLoader.js";
import { Skeleton } from "../../core/skeleton.js";
import type { AnimDocument } from "../../core/format.js";
import { alphaMask, maskBounds, type RgbaImage } from "../image.js";

export interface RigBone {
  name: string;
  parent: string | null;
  /** Setup-pose origin and tip, source pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  length: number;
  limits: { min: number; max: number } | null;
}

export interface RigView {
  doc: AnimDocument;
  /** Rig canvas pixel = source pixel + offset. */
  offset: { x: number; y: number };
  bones: Map<string, RigBone>;
}

export function rigOffset(source: RgbaImage, canvas: { width: number; height: number; originX: number; originY: number }): { x: number; y: number } {
  if (source.width === canvas.width && source.height === canvas.height) return { x: 0, y: 0 };
  const bounds = maskBounds(alphaMask(source, 8));
  if (!bounds) throw new Error("the source PNG has no opaque pixels");
  return { x: Math.round(canvas.originX - bounds.width / 2) - bounds.x, y: Math.round(canvas.originY - bounds.height) - bounds.y };
}

export function rigView(raw: unknown, source: RgbaImage): RigView {
  const doc = loadAnimDocument(raw);
  const offset = rigOffset(source, doc.canvas);
  const skeleton = new Skeleton(doc);
  skeleton.x = doc.canvas.originX;
  skeleton.y = doc.canvas.originY;
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("pose");
  const bones = new Map<string, RigBone>();
  const tip = { x: 0, y: 0 };
  const origin = { x: 0, y: 0 };
  for (const data of doc.bones) {
    const bone = skeleton.getBone(data.name);
    const length = data.length ?? 0;
    bone.localToWorld(length, 0, tip);
    bone.localToWorld(0, 0, origin);
    const limits = (data as { limits?: { min?: number; max?: number } }).limits;
    bones.set(data.name, {
      name: data.name,
      parent: data.parent ?? null,
      x0: origin.x - offset.x,
      y0: origin.y - offset.y,
      x1: tip.x - offset.x,
      y1: tip.y - offset.y,
      length,
      limits: limits && limits.min !== undefined && limits.max !== undefined ? { min: limits.min, max: limits.max } : null
    });
  }
  return { doc, offset, bones };
}

/** True when `bone` is `ancestor` or below it. */
export function isUnder(view: RigView, bone: string, ancestor: string): boolean {
  for (let b: string | null = bone; b; b = view.bones.get(b)?.parent ?? null) if (b === ancestor) return true;
  return false;
}

export function depthOf(view: RigView, bone: string): number {
  let d = 0;
  for (let b = view.bones.get(bone)?.parent ?? null; b; b = view.bones.get(b)?.parent ?? null) d++;
  return d;
}

/** Distance from (x, y) to the segment of `bone` between fractions t0 and t1 of its length. */
export function segmentDistance(bone: RigBone, x: number, y: number, t0 = 0, t1 = 1): number {
  const dx = bone.x1 - bone.x0;
  const dy = bone.y1 - bone.y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((x - bone.x0) * dx + (y - bone.y0) * dy) / len2 : 0;
  t = Math.max(t0, Math.min(t1, t));
  const px = bone.x0 + t * dx - x;
  const py = bone.y0 + t * dy - y;
  return Math.sqrt(px * px + py * py);
}

/**
 * The weight-tree chains for a set of allowed bones (`weights.auto` `chains`): the root-most bone
 * starts the first chain, which continues into the child with the longest line of descendants
 * (a spine past its legs and tail); where two children tie (two ears on a head) the chain stops
 * and every child starts its own chain naming its `parent`.
 */
export function chainsFor(parents: ReadonlyMap<string, string | null>, allowed: readonly string[]): { bones: string[]; parent?: string }[] {
  const set = new Set(allowed);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const bone of allowed) {
    const parent = parents.get(bone) ?? null;
    if (parent && set.has(parent)) children.set(parent, [...(children.get(parent) ?? []), bone]);
    else roots.push(bone);
  }
  if (roots.length !== 1) throw new Error(`allowed bones ${allowed.join(", ")} must form one connected tree (roots: ${roots.join(", ")})`);
  const depth = (b: string): number => 1 + Math.max(0, ...(children.get(b) ?? []).map(depth));
  const chains: { bones: string[]; parent?: string }[] = [];
  const walk = (start: string, parent: string | undefined) => {
    const bones = [start];
    const branches: [string, string][] = [];
    let at = start;
    for (;;) {
      const kids = children.get(at) ?? [];
      if (kids.length === 0) break;
      const depths = kids.map(depth);
      const best = Math.max(...depths);
      const deepest = kids.filter((_, k) => depths[k] === best);
      if (deepest.length !== 1) {
        for (const kid of kids) branches.push([at, kid]);
        break;
      }
      const next = deepest[0] as string;
      for (const kid of kids) if (kid !== next) branches.push([at, kid]);
      at = next;
      bones.push(at);
    }
    chains.push(parent ? { bones, parent } : { bones });
    for (const [from, kid] of branches) walk(kid, from);
  };
  walk(roots[0] as string, undefined);
  return chains;
}
