/*
 * Atlas Animator: original implementation.
 *
 * Inverse kinematics: one bone aims at a target, or a parent/child pair bends so the child's tip
 * reaches it (law of cosines).
 *
 * The solver works on world matrices. Turning a bone's world matrix about its own origin is the
 * same motion whatever the bone's inherit mode, so the solver rotates (and, to stretch, scales)
 * world matrices and then converts back to local values with Bone.enforceLimits, which also holds
 * the bones' rotation limits (plan 4.4). Lengths are measured in world space, so parent, skeleton
 * and bone scales are all accounted for.
 *
 * Keyable values (IkPose): `mix` blends from the incoming pose (0) to the solved pose (1) as a
 * fraction of each bone's world rotation change (and of the stretch factor); `bendPositive` picks
 * the side the joint bends to, in the parent bone's local terms (positive = the child turns
 * clockwise relative to the parent in an unmirrored frame); `softness`, `stretch` and `compress`
 * are below. `uniform` (document only) makes stretch and compress scale both local axes.
 *
 * One bone: the bone's X axis turns to point at the target. With `stretch` the bone lengthens
 * (local X scale) to reach a target beyond its length, with `compress` it shortens for a target
 * nearer than its length. A bone of length 0 only turns. Softness does not apply.
 *
 * Two bones (bones[0] = parent, bones[1] = its direct child): l1 = distance from the parent's
 * origin to the child's origin, l2 = the child's world length (its tip is at local (length, 0)).
 * For a target at distance d from the parent's origin:
 * - softness s (pixels, clamped to l1 + l2): inside the last s pixels of reach the solved distance
 *   eases toward full extension, r = L - s * exp((L - s - d) / s) for d > L - s (L = l1 + l2),
 *   so the elbow straightens smoothly instead of snapping straight at full reach. r < L always,
 *   so a soft chain never quite locks out.
 * - stretch: when the target is beyond r (or L without softness), both bones lengthen by one
 *   factor f so the tip reaches the target: the parent's local X scale grows by f (Y too with
 *   `uniform`) and the child's X axis is scaled so its world length grows by f (a bent child
 *   inherits only part of the parent's stretch). f = d / r when the child's origin scales with the
 *   parent (uniform, or a child on the parent's X axis); for an off-axis child under nonuniform
 *   stretch f is solved so the stretched upper length (which grows by less than f) plus the lower
 *   one reach the target, and the bend is solved from the lengths re-measured after stretching
 *   (F6). With softness the soft elbow bend shape (r / L) is kept instead of locking straight. Without stretch an unreachable target leaves the chain
 *   straight, pointing at it.
 * - compress applies to one-bone IK only (a two-bone chain shortens by bending).
 * Both turns are rigid rotations of the world matrices, so l1 and l2 do not change while solving
 * and the tip lands on the target within float precision for any parent or skeleton scale, shear
 * or mirroring. (Under a non-uniformly scaled parent this keeps the child's current world shape
 * rather than re-deriving it from a new local angle; the solved local values describe that shape.)
 *
 * Degenerate chains: when the child's origin sits on the parent's, the child alone aims; when the
 * child has no length, the parent alone turns its child's origin toward the target.
 */
import type { Bone } from "./bone.js";
import type { IkPose } from "./constraintPose.js";
import type { IkConstraintData } from "./format.js";
import { determinant, rotateLinear, wrapRadians, vectorLength } from "./math.js";

/** Below this many pixels a length counts as zero. */
const MIN_LENGTH = 1e-4;

export class IkConstraint {
  readonly data: IkConstraintData;
  readonly pose: IkPose;
  /** One bone, or [parent, child]. */
  readonly bones: readonly Bone[];
  readonly target: Bone;
  constructor(data: IkConstraintData, pose: IkPose, bones: readonly Bone[], target: Bone) {
    if (bones.length < 1 || bones.length > 2) throw new Error(`ik '${data.name}': needs one or two bones`);
    if (bones.length === 2 && bones[1]?.parent !== bones[0]) {
      throw new Error(`ik '${data.name}': the second bone must be a direct child of the first`);
    }
    this.data = data;
    this.pose = pose;
    this.bones = bones;
    this.target = target;
  }

  /** Solves for the target's current world position. Bones and target must be up to date. */
  update(): void {
    // Per-frame path: helpers take objects and booleans only (doubles passed to calls the engine
    // does not inline are boxed; see src/pixi/allocation.test.ts).
    const mix = this.pose.mix;
    if (mix <= 0) return;
    const first = this.bones[0] as Bone;
    if (this.bones.length === 1) {
      this.aim(first, true);
      return;
    }
    this.solveTwo(first, this.bones[1] as Bone);
  }

  /**
   * Turns `bone` so its X axis points at the target (by `mix` of the way); with `scale`, applies
   * stretch/compress. Ends with enforceLimits.
   */
  private aim(bone: Bone, scale: boolean): void {
    const pose = this.pose;
    const mix = pose.mix;
    const t = this.target.world;
    const w = bone.world;
    const dx = t.x - w.x;
    const dy = t.y - w.y;
    const distance = vectorLength(dx, dy);
    if (distance > MIN_LENGTH) {
      rotateLinear(w, wrapRadians(Math.atan2(dy, dx) - Math.atan2(w.c, w.a)) * mix);
    }
    if (scale) {
      const length = bone.data.length * vectorLength(w.a, w.c);
      if (length > MIN_LENGTH && ((pose.stretch && distance > length) || (pose.compress && distance < length))) {
        const factor = 1 + (distance / length - 1) * mix;
        w.a *= factor;
        w.c *= factor;
        if (this.data.uniform) {
          w.b *= factor;
          w.d *= factor;
        }
      }
    }
    bone.enforceLimits();
  }

  private solveTwo(parent: Bone, child: Bone): void {
    const pose = this.pose;
    const mix = pose.mix;
    const t = this.target.world;
    const p = parent.world;
    let c = child.world;

    let l1 = vectorLength(c.x - p.x, c.y - p.y);
    let l2 = child.data.length * vectorLength(c.a, c.c);
    if (l1 <= MIN_LENGTH) {
      this.aim(child, false);
      return;
    }
    if (l2 <= MIN_LENGTH) {
      // Only the parent can move the end effector (the child's origin).
      rotateLinear(p, wrapRadians(Math.atan2(t.y - p.y, t.x - p.x) - Math.atan2(c.y - p.y, c.x - p.x)) * mix);
      parent.enforceLimits();
      child.updateWorldTransform();
      return;
    }

    const d = vectorLength(t.x - p.x, t.y - p.y);
    const full = l1 + l2;
    const softness = Math.min(pose.softness, full);
    let reach = d;
    if (softness > 0 && d > full - softness) reach = full - softness * Math.exp((full - softness - d) / softness);
    else if (d > full) reach = full;

    // Stretch first, so the bend is solved with the lengths the chain really has.
    if (pose.stretch && d > reach) {
      // The bend keeps the shape it has at this distance: solved distance = ratio * (l1 + l2).
      // Scaling both lengths by f reaches d at f = d / reach when the child's origin scales with
      // the parent (uniform stretch, or an on-axis child). Nonuniform stretch scales only the
      // parent's X axis: an off-axis child origin (local y != 0) moves less, so l1 grows by less
      // than f (runtime contract F6). Solve |f u + w| + l2 f = G for the f that makes the
      // stretched chain reach G = d / ratio, with u and w the child offset's parts along the
      // parent's X and Y axes.
      const ratio = reach / full;
      let target = d / reach;
      if (!this.data.uniform) {
        const det = determinant(p);
        if (Math.abs(det) > 1e-12) {
          const vx = c.x - p.x;
          const vy = c.y - p.y;
          const ox = (vx * p.d - vy * p.b) / det;
          const oy = (p.a * vy - p.c * vx) / det;
          const ux = ox * p.a;
          const uy = ox * p.c;
          const wx = oy * p.b;
          const wy = oy * p.d;
          const uu = ux * ux + uy * uy;
          const uw = ux * wx + uy * wy;
          const ww = wx * wx + wy * wy;
          const g = d / ratio;
          // (uu - l2^2) f^2 + 2 (uw + g l2) f + (ww - g^2) = 0, root with g - l2 f >= 0.
          const qa = uu - l2 * l2;
          const qb = 2 * (uw + g * l2);
          const qc = ww - g * g;
          let root = Number.NaN;
          if (Math.abs(qa) < 1e-12) {
            if (Math.abs(qb) > 1e-12) root = -qc / qb;
          } else {
            const disc = qb * qb - 4 * qa * qc;
            if (disc >= 0) {
              const sq = Math.sqrt(disc);
              const r1 = (-qb + sq) / (2 * qa);
              const r2 = (-qb - sq) / (2 * qa);
              const ok1 = r1 > 0 && g - l2 * r1 >= -1e-9;
              const ok2 = r2 > 0 && g - l2 * r2 >= -1e-9;
              root = ok1 && ok2 ? Math.min(r1, r2) : ok1 ? r1 : ok2 ? r2 : Number.NaN;
            }
          }
          if (root > 0) target = root;
        }
      }
      const factor = 1 + (target - 1) * mix;
      p.a *= factor;
      p.c *= factor;
      if (this.data.uniform) {
        p.b *= factor;
        p.d *= factor;
      }
      parent.enforceLimits();
      child.updateWorldTransform();
      c = child.world;
      // The child inherited the parent's stretch along the parent's X axis only; top it up so
      // its own world length grows by the same factor.
      const inherited = child.data.length * vectorLength(c.a, c.c);
      if (inherited > MIN_LENGTH) {
        const topUp = (l2 * factor) / inherited;
        c.a *= topUp;
        c.c *= topUp;
        child.enforceLimits();
      }
      // Recompute the geometry from the stretched matrices (F6), never from the scalar factor.
      l1 = vectorLength(c.x - p.x, c.y - p.y);
      l2 = child.data.length * vectorLength(c.a, c.c);
      reach = ratio * (l1 + l2);
      if (reach > d && mix >= 1) reach = d;
    }

    // Turn angle from the parent-to-child line to the child's axis, in world terms: the local
    // bend side flips when the parent's frame is mirrored.
    let cos = (reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    if (cos > 1) cos = 1;
    else if (cos < -1) cos = -1;
    const side = (pose.bendPositive ? 1 : -1) * (determinant(p) < 0 ? -1 : 1);
    const bend = Math.acos(cos) * side;
    const towardTarget = Math.atan2(t.y - p.y, t.x - p.x);
    const upper = towardTarget - Math.atan2(l2 * Math.sin(bend), l1 + l2 * Math.cos(bend));

    rotateLinear(p, wrapRadians(upper - Math.atan2(c.y - p.y, c.x - p.x)) * mix);
    parent.enforceLimits();
    child.updateWorldTransform();
    c = child.world;
    const currentBend = Math.atan2(c.c, c.a) - Math.atan2(c.y - p.y, c.x - p.x);
    rotateLinear(c, wrapRadians(bend - currentBend) * mix);
    child.enforceLimits();
  }
}
