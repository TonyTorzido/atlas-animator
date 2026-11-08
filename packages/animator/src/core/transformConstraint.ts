/*
 * Atlas Animator: original implementation.
 *
 * Transform constraint: moves the constrained bones toward the target bone's transform, channel by
 * channel (rotation, translation, X/Y scale, Y shear), each with its own keyable mix (0 = the
 * incoming pose, 1 = fully constrained) and a constant offset from the document.
 *
 * Four modes, from the document's `local` and `relative` flags:
 * - world absolute (default): the bone takes the target's world transform. Rotation turns the
 *   bone's X axis toward the target's (the short way) plus `offset.rotation`; position moves to
 *   the target's local point (offset.x, offset.y); X/Y scale move toward the target's world axis
 *   lengths plus the scale offsets; shear moves the angle between the bone's axes toward the
 *   target's. "Hat follows the head but keeps upright" = rotation mix 0, translation mix 1.
 * - world relative: the target's world values are added: its X-axis direction (plus offset) turns
 *   the bone, its skeleton-space position (the world position minus the skeleton's own position,
 *   so moving the skeleton changes nothing) translates it, its axis lengths minus 1 (plus offsets)
 *   scale it and its shear (axis angle minus 90 degrees, plus offset) shears it.
 * - local absolute: the bone's local channels (`applied`) move toward the target's local channels
 *   plus the offsets (rotation and shear the short way).
 * - local relative: the target's local channels are added (scale multiplies by
 *   1 + (target scale - 1 + offset) * mix). Meant for driver bones whose setup pose is identity.
 * In world modes, rotation and shear offsets turn the other way when the target is mirrored, so a
 * mirrored rig keeps the same look.
 *
 * World modes write the world matrix and finish with Bone.enforceLimits; local modes rebuild from
 * the local channels, which applies the limits too (plan 4.4). Bones are processed in list order;
 * a bone below an earlier listed bone is rebuilt from its (just moved) parent first.
 */
import type { Bone, SkeletonFrame } from "./bone.js";
import type { TransformPose } from "./constraintPose.js";
import type { TransformConstraintData } from "./format.js";
import { DEG_TO_RAD, EPSILON, determinant, rotateLinear, wrapDegrees, wrapRadians, vectorLength } from "./math.js";

const HALF_PI = Math.PI / 2;

export class TransformConstraint {
  readonly data: TransformConstraintData;
  readonly pose: TransformPose;
  readonly bones: readonly Bone[];
  readonly target: Bone;
  private readonly frame: SkeletonFrame;

  constructor(data: TransformConstraintData, pose: TransformPose, bones: readonly Bone[], target: Bone, frame: SkeletonFrame) {
    this.data = data;
    this.pose = pose;
    this.bones = bones;
    this.target = target;
    this.frame = frame;
  }

  /** Bones and target must be up to date. */
  update(): void {
    const pose = this.pose;
    if (
      pose.mixRotate === 0 &&
      pose.mixX === 0 &&
      pose.mixY === 0 &&
      pose.mixScaleX === 0 &&
      pose.mixScaleY === 0 &&
      pose.mixShearY === 0
    ) {
      return;
    }
    const local = this.data.local;
    const relative = this.data.relative;
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i] as Bone;
      // A later bone may sit below an earlier one that just moved.
      if (i > 0) bone.updateWorldTransform();
      if (local) {
        if (relative) this.relativeLocal(bone);
        else this.absoluteLocal(bone);
      } else if (relative) this.relativeWorld(bone);
      else this.absoluteWorld(bone);
    }
  }

  private absoluteWorld(bone: Bone): void {
    const pose = this.pose;
    const offset = this.data.offset;
    const t = this.target.world;
    const w = bone.world;
    const mirror = determinant(t) < 0 ? -1 : 1;

    if (pose.mixRotate !== 0) {
      const turn = Math.atan2(t.c, t.a) - Math.atan2(w.c, w.a) + offset.rotation * DEG_TO_RAD * mirror;
      rotateLinear(w, wrapRadians(turn) * pose.mixRotate);
    }
    if (pose.mixX !== 0 || pose.mixY !== 0) {
      // The target's local point (offset.x, offset.y) in world space.
      const x = t.a * offset.x + t.b * offset.y + t.x;
      const y = t.c * offset.x + t.d * offset.y + t.y;
      w.x += (x - w.x) * pose.mixX;
      w.y += (y - w.y) * pose.mixY;
    }
    if (pose.mixScaleX !== 0) {
      const s = vectorLength(w.a, w.c);
      if (s > EPSILON) {
        const factor = (s + (vectorLength(t.a, t.c) - s + offset.scaleX) * pose.mixScaleX) / s;
        w.a *= factor;
        w.c *= factor;
      }
    }
    if (pose.mixScaleY !== 0) {
      const s = vectorLength(w.b, w.d);
      if (s > EPSILON) {
        const factor = (s + (vectorLength(t.b, t.d) - s + offset.scaleY) * pose.mixScaleY) / s;
        w.b *= factor;
        w.d *= factor;
      }
    }
    if (pose.mixShearY !== 0) {
      const yAngle = Math.atan2(w.d, w.b);
      const ownShear = yAngle - Math.atan2(w.c, w.a);
      const targetShear = Math.atan2(t.d, t.b) - Math.atan2(t.c, t.a);
      const angle = yAngle + wrapRadians(targetShear - ownShear + offset.shearY * DEG_TO_RAD * mirror) * pose.mixShearY;
      const s = vectorLength(w.b, w.d);
      w.b = Math.cos(angle) * s;
      w.d = Math.sin(angle) * s;
    }
    bone.enforceLimits();
  }

  private relativeWorld(bone: Bone): void {
    const pose = this.pose;
    const offset = this.data.offset;
    const t = this.target.world;
    const w = bone.world;
    const mirror = determinant(t) < 0 ? -1 : 1;

    if (pose.mixRotate !== 0) {
      rotateLinear(w, wrapRadians(Math.atan2(t.c, t.a) + offset.rotation * DEG_TO_RAD * mirror) * pose.mixRotate);
    }
    if (pose.mixX !== 0 || pose.mixY !== 0) {
      const x = t.a * offset.x + t.b * offset.y + t.x;
      const y = t.c * offset.x + t.d * offset.y + t.y;
      w.x += (x - this.frame.x) * pose.mixX;
      w.y += (y - this.frame.y) * pose.mixY;
    }
    if (pose.mixScaleX !== 0) {
      const factor = (vectorLength(t.a, t.c) - 1 + offset.scaleX) * pose.mixScaleX + 1;
      w.a *= factor;
      w.c *= factor;
    }
    if (pose.mixScaleY !== 0) {
      const factor = (vectorLength(t.b, t.d) - 1 + offset.scaleY) * pose.mixScaleY + 1;
      w.b *= factor;
      w.d *= factor;
    }
    if (pose.mixShearY !== 0) {
      const targetShear = Math.atan2(t.d, t.b) - Math.atan2(t.c, t.a) - HALF_PI;
      const angle = Math.atan2(w.d, w.b) + wrapRadians(targetShear + offset.shearY * DEG_TO_RAD * mirror) * pose.mixShearY;
      const s = vectorLength(w.b, w.d);
      w.b = Math.cos(angle) * s;
      w.d = Math.sin(angle) * s;
    }
    bone.enforceLimits();
  }

  private absoluteLocal(bone: Bone): void {
    const pose = this.pose;
    const offset = this.data.offset;
    const t = this.target.applied;
    const a = bone.applied;
    a.rotation += wrapDegrees(t.rotation - a.rotation + offset.rotation) * pose.mixRotate;
    a.x += (t.x - a.x + offset.x) * pose.mixX;
    a.y += (t.y - a.y + offset.y) * pose.mixY;
    a.scaleX += (t.scaleX - a.scaleX + offset.scaleX) * pose.mixScaleX;
    a.scaleY += (t.scaleY - a.scaleY + offset.scaleY) * pose.mixScaleY;
    a.shearY += wrapDegrees(t.shearY - a.shearY + offset.shearY) * pose.mixShearY;
    bone.updateWorldTransform();
  }

  private relativeLocal(bone: Bone): void {
    const pose = this.pose;
    const offset = this.data.offset;
    const t = this.target.applied;
    const a = bone.applied;
    a.rotation += (t.rotation + offset.rotation) * pose.mixRotate;
    a.x += (t.x + offset.x) * pose.mixX;
    a.y += (t.y + offset.y) * pose.mixY;
    a.scaleX *= (t.scaleX - 1 + offset.scaleX) * pose.mixScaleX + 1;
    a.scaleY *= (t.scaleY - 1 + offset.scaleY) * pose.mixScaleY + 1;
    a.shearY += (t.shearY + offset.shearY) * pose.mixShearY;
    bone.updateWorldTransform();
  }
}
