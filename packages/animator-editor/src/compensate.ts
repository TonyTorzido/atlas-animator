/*
 * Atlas Animator editor: original implementation.
 *
 * Compensate: while a bone is moved or rotated, its direct children can stay where they were on screen (world
 * position and orientation). The editor snapshots the children before the change, applies the change, and asks
 * `solveCompensation` for the local offsets that put each child back; grandchildren follow their parent, so only
 * direct children need a fix. The result is ordinary rotate / translate offsets from setup, keyed like any edit.
 */
import type { Bone, Skeleton } from "@atlas-animator/core/core";

export interface Anchor {
  name: string;
  x: number;
  y: number;
  /** Clockwise degrees of the bone's x axis in skeleton space. */
  angle: number;
}

export interface Fix {
  name: string;
  /** Rotation offset from setup, degrees. */
  rotate: number;
  /** Translate offset from setup, in the parent's space. */
  move: { x: number; y: number };
}

const DEG = 180 / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const worldAngle = (b: Bone) => Math.atan2(b.world.c, b.world.a) * DEG;
const sign = (b: Bone) => {
  const p = b.parent?.world;
  return p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
};

/** Bones a constraint drives right now (an IK chain with mix, a transform or physics constraint): their own offsets do not show. */
export function drivenBones(skeleton: Skeleton): Set<string> {
  const out = new Set<string>();
  for (const c of skeleton.ikConstraints) if (c.pose.mix > 1e-6) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.transformConstraints) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.pathConstraints) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.physicsConstraints) out.add(c.bone.data.name);
  return out;
}

/**
 * Direct children of `moved` that are not themselves being edited or constraint-driven, with their world placement.
 * The skeleton must be posed.
 */
export function anchorsFor(skeleton: Skeleton, moved: Iterable<string>, exclude: ReadonlySet<string>): Anchor[] {
  const out = new Map<string, Anchor>();
  const driven = drivenBones(skeleton);
  for (const name of moved) {
    const bone = skeleton.findBone(name);
    for (const child of bone?.children ?? []) {
      if (exclude.has(child.data.name) || driven.has(child.data.name) || out.has(child.data.name)) continue;
      out.set(child.data.name, { name: child.data.name, x: child.world.x, y: child.world.y, angle: worldAngle(child) });
    }
  }
  return [...out.values()];
}

/**
 * The offsets that put each anchored child back at its snapshot. The skeleton must be posed with the parent's change
 * applied (and the child's current pose); changes under `eps` are left out.
 */
export function solveCompensation(skeleton: Skeleton, anchors: readonly Anchor[], eps = 0.005): Fix[] {
  const fixes: Fix[] = [];
  for (const a of anchors) {
    const bone = skeleton.findBone(a.name);
    if (!bone) continue;
    const local = { x: a.x, y: a.y };
    if (bone.parent) bone.parent.worldToLocal(a.x, a.y, local);
    const rotation = bone.pose.rotation + sign(bone) * wrap(a.angle - worldAngle(bone));
    const dr = Math.abs(rotation - bone.pose.rotation);
    const dm = Math.hypot(local.x - bone.pose.x, local.y - bone.pose.y);
    if (dr > eps || dm > eps) fixes.push({ name: a.name, rotate: rotation - bone.data.rotation, move: { x: local.x - bone.data.x, y: local.y - bone.data.y } });
  }
  return fixes;
}
