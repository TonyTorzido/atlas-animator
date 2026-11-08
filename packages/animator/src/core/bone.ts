/*
 * Atlas Animator: original implementation.
 *
 * A runtime bone: three transforms and the math between them.
 *
 * - `pose`    the local transform animation writes (reset from the setup pose by the skeleton);
 * - `applied` the local transform the world transform was actually built from: `pose` after
 *             rotation limits, or whatever a constraint wrote;
 * - `world`   the bone's 2x3 world matrix (column (a, c) = local X axis, (b, d) = local Y axis).
 *
 * Inherit modes (what a child takes from its parent's world matrix P; translation is always
 * P * (x, y) + parent origin):
 *
 * - normal               W = P * L.
 * - onlyTranslation      W = L. Parent rotation, scale, shear and reflection are ignored.
 * - noRotation           W = R(phi) * diag(px, py) * R(-phi) * L, where phi is the direction of the
 *                        parent's X axis, px its length and py = |det P| / px. The child is stretched
 *                        the way the parent is, along the parent's axes, but keeps its own rotation;
 *                        the parent's shear and reflection are dropped.
 * - noScale              W = F * S. F is the orthonormal frame whose X axis points along
 *                        P * (cos r, sin r) (the parent-mapped direction of the child's rotation r)
 *                        and S is the child's own scale and shear. The parent's reflection is kept.
 * - noScaleOrReflection  as noScale, but F is always a proper rotation (reflection dropped).
 *
 * L is the full local matrix (composeLinear of rotation, scale and shear).
 */
import type { BoneData, InheritMode } from "./format.js";
import {
  type Affine2,
  type LinearDecomposition,
  type LocalTransform,
  type Vec2,
  DEG_TO_RAD,
  EPSILON,
  RAD_TO_DEG,
  clampRotationToLimits,
  composeLocalLinear,
  copyLocalTransform,
  createAffine,
  createLocalTransform,
  decomposeAffine,
  determinant,
  inverseTransformPoint,
  multiplyLinear,
  rotateLinear,
  transformPoint,
  wrapDegrees,
  vectorLength
} from "./math.js";

/** Where skeleton space (0, 0) sits in the world. The skeleton implements this. */
export interface SkeletonFrame {
  readonly x: number;
  readonly y: number;
  /** False: bone rotation limits are not applied (AnimationState.apply turns them off while a non-looping clip is posed). Absent counts as true. */
  readonly limitsEnforced?: boolean;
}

// Scratch space: bones are updated one at a time on one thread, so shared temporaries are safe
// and keep the per-frame path free of allocations.
const scratchLocal = createAffine();
const scratchParent = createAffine();
const scratchDecomposition: LinearDecomposition = { rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
const scratchRelative = createAffine();

export class Bone {
  readonly data: BoneData;
  readonly index: number;
  readonly parent: Bone | null;
  readonly children: Bone[] = [];
  readonly inherit: InheritMode;
  readonly pose: LocalTransform = createLocalTransform();
  readonly applied: LocalTransform = createLocalTransform();
  readonly world: Affine2 = createAffine();
  /** False while the bone is a skin bone of no active skin; inactive bones are not updated. */
  active = true;

  private readonly frame: SkeletonFrame;

  constructor(data: BoneData, index: number, parent: Bone | null, frame: SkeletonFrame) {
    this.data = data;
    this.index = index;
    this.parent = parent;
    this.inherit = data.inherit;
    this.frame = frame;
    parent?.children.push(this);
    this.setToSetupPose();
  }

  /** Resets `pose` (and `applied`) to the setup values from the document. */
  setToSetupPose(): void {
    const { data, pose } = this;
    pose.x = data.x;
    pose.y = data.y;
    pose.rotation = data.rotation;
    pose.scaleX = data.scaleX;
    pose.scaleY = data.scaleY;
    pose.shearX = data.shearX;
    pose.shearY = data.shearY;
    copyLocalTransform(pose, this.applied);
  }

  /** Rebuilds the world matrix from `applied` (rotation clamped to the limits; the parent's world matrix must be current). */
  updateWorldTransform(): void {
    // Works on `applied` in place rather than forwarding seven numbers to
    // updateWorldTransformWith: numbers passed to a call the engine does not inline are boxed,
    // and this runs for every bone every frame (src/pixi/allocation.test.ts).
    const limits = this.frame.limitsEnforced === false ? undefined : this.data.limits;
    if (limits) {
      const applied = this.applied;
      const delta = applied.rotation - this.data.rotation;
      if (delta < limits.min || delta > limits.max) {
        applied.rotation = clampRotationToLimits(applied.rotation, this.data.rotation, limits.min, limits.max);
      }
    }
    this.buildWorld();
  }

  /**
   * Stores the given local transform in `applied` (rotation clamped to the bone's limits) and
   * rebuilds the world matrix from it. Constraints call this with their solved values.
   */
  updateWorldTransformWith(
    x: number,
    y: number,
    rotation: number,
    scaleX: number,
    scaleY: number,
    shearX: number,
    shearY: number
  ): void {
    const limits = this.frame.limitsEnforced === false ? undefined : this.data.limits;
    if (limits) rotation = clampRotationToLimits(rotation, this.data.rotation, limits.min, limits.max);

    const applied = this.applied;
    applied.x = x;
    applied.y = y;
    applied.rotation = rotation;
    applied.scaleX = scaleX;
    applied.scaleY = scaleY;
    applied.shearX = shearX;
    applied.shearY = shearY;
    this.buildWorld();
  }

  /**
   * The world matrix from `applied` as it stands (no limits applied here). Per frame for every
   * bone: helpers take objects, never loose numbers (see math.decomposeAffine).
   */
  private buildWorld(): void {
    const applied = this.applied;
    const world = this.world;
    const parent = this.parent;
    if (!parent) {
      composeLocalLinear(applied, true, world);
      world.x = this.frame.x + applied.x;
      world.y = this.frame.y + applied.y;
      return;
    }

    const p = parent.world;
    world.x = p.a * applied.x + p.b * applied.y + p.x;
    world.y = p.c * applied.x + p.d * applied.y + p.y;

    switch (this.inherit) {
      case "normal":
        multiplyLinear(p, composeLocalLinear(applied, true, scratchLocal), world);
        return;
      case "onlyTranslation":
        composeLocalLinear(applied, true, world);
        return;
      case "noRotation":
        multiplyLinear(parentStretch(p, scratchParent), composeLocalLinear(applied, true, scratchLocal), world);
        return;
      case "noScale":
      case "noScaleOrReflection":
        multiplyLinear(
          parentRotationFrame(p, applied, this.inherit === "noScale", scratchParent),
          composeLocalLinear(applied, false, scratchLocal),
          world
        );
        return;
    }
  }

  /**
   * Recomputes `applied` from the current world matrix (the inverse of updateWorldTransform).
   * Constraints that write the world matrix directly call this so later steps read consistent
   * local values. The result is canonical (shearX = 0, scaleX >= 0 where possible), so it may
   * differ numerically from the values that built the matrix while describing the same matrix.
   * When the parent's matrix is singular there is no unique answer and the affected channels keep
   * their previous values.
   */
  updateAppliedTransform(): void {
    const world = this.world;
    const applied = this.applied;
    const parent = this.parent;

    if (!parent) {
      applied.x = world.x - this.frame.x;
      applied.y = world.y - this.frame.y;
      this.setAppliedLinear(world);
      return;
    }

    const p = parent.world;
    const det = p.a * p.d - p.b * p.c;
    if (Math.abs(det) > EPSILON) {
      // (x, y) = P^-1 * (world origin - parent origin), written out (no number-argument calls).
      const dx = world.x - p.x;
      const dy = world.y - p.y;
      applied.x = (p.d * dx - p.b * dy) / det;
      applied.y = (p.a * dy - p.c * dx) / det;
    }

    switch (this.inherit) {
      case "onlyTranslation":
        this.setAppliedLinear(world);
        return;
      case "normal":
        this.setAppliedRelativeTo(p);
        return;
      case "noRotation":
        this.setAppliedRelativeTo(parentStretch(p, scratchParent));
        return;
      case "noScale":
      case "noScaleOrReflection": {
        // W = F(r) * S with S's X axis along F's X axis, so W's X axis gives F's direction, and
        // r is the direction that P maps onto it.
        const length = vectorLength(world.a, world.c);
        if (length > EPSILON) {
          const zx = world.a / length;
          const zy = world.c / length;
          applied.rotation =
            Math.abs(det) > EPSILON
              ? Math.atan2((p.a * zy - p.c * zx) / det, (p.d * zx - p.b * zy) / det) * RAD_TO_DEG
              : Math.atan2(zy, zx) * RAD_TO_DEG;
        }
        const f = parentRotationFrame(p, applied, this.inherit === "noScale", scratchParent);
        // F is orthonormal, so S = F^T * W.
        const r = scratchRelative;
        r.a = f.a * world.a + f.c * world.c;
        r.b = f.a * world.b + f.c * world.d;
        r.c = f.b * world.a + f.d * world.c;
        r.d = f.b * world.b + f.d * world.d;
        const s = decomposeAffine(r, scratchDecomposition);
        // S was built with rotation 0; any rotation the decomposition found belongs to the shear
        // angles (composeLinear(q, sx, sy, 0, h) == composeLinear(0, sx, sy, q, q + h)).
        applied.rotation = wrapDegrees(applied.rotation);
        applied.scaleX = s.scaleX;
        applied.scaleY = s.scaleY;
        applied.shearX = s.rotation;
        applied.shearY = s.rotation + s.shearY;
        return;
      }
    }
  }

  /** Maps a world point into this bone's local space. Returns false if the bone is collapsed. */
  worldToLocal(x: number, y: number, out: Vec2): boolean {
    return inverseTransformPoint(this.world, x, y, out);
  }

  localToWorld(x: number, y: number, out: Vec2): Vec2 {
    return transformPoint(this.world, x, y, out);
  }

  /** Maps a world point into the space this bone's (x, y) is expressed in. */
  worldToParent(x: number, y: number, out: Vec2): boolean {
    if (this.parent) return this.parent.worldToLocal(x, y, out);
    out.x = x - this.frame.x;
    out.y = y - this.frame.y;
    return true;
  }

  /** World direction of the local X axis, in degrees. */
  get worldRotationX(): number {
    return Math.atan2(this.world.c, this.world.a) * RAD_TO_DEG;
  }

  /** World direction of the local Y axis, in degrees. */
  get worldRotationY(): number {
    return Math.atan2(this.world.d, this.world.b) * RAD_TO_DEG;
  }

  get worldScaleX(): number {
    return vectorLength(this.world.a, this.world.c);
  }

  get worldScaleY(): number {
    return vectorLength(this.world.b, this.world.d);
  }

  /** Turns the world matrix by `degrees` about the bone's own origin. Call enforceLimits after. */
  rotateWorld(degrees: number): void {
    rotateLinear(this.world, degrees * DEG_TO_RAD);
  }

  /**
   * Finishes a direct write of the world matrix (constraint rule, plan 4.4): recomputes `applied`
   * from the world matrix, then holds the rotation limits. When the rotation is outside them it is
   * clamped and the world matrix rebuilt; when a full-turn equivalent is inside, `applied.rotation`
   * is rewritten as that equivalent (same matrix), so `applied.rotation - setup` always lies within
   * [min, max] for limited bones, which is what driven keys read.
   */
  enforceLimits(): void {
    this.updateAppliedTransform();
    const limits = this.frame.limitsEnforced === false ? undefined : this.data.limits;
    if (!limits) return;
    const applied = this.applied;
    const setup = this.data.rotation;
    const { min, max } = limits;
    const delta = applied.rotation - setup;
    if (delta >= min && delta <= max) return;
    // Limits lie within [-360, 360] and span at most 360 degrees, so the wrapped difference or
    // one turn either way is the only candidate equivalent.
    const wrapped = wrapDegrees(delta);
    if (wrapped >= min && wrapped <= max) applied.rotation = setup + wrapped;
    else if (wrapped + 360 >= min && wrapped + 360 <= max) applied.rotation = setup + wrapped + 360;
    else if (wrapped - 360 >= min && wrapped - 360 <= max) applied.rotation = setup + wrapped - 360;
    else {
      applied.rotation = clampRotationToLimits(applied.rotation, setup, min, max);
      this.buildWorld();
    }
  }

  private setAppliedRelativeTo(parentLinear: Readonly<Affine2>): void {
    const pa = parentLinear.a;
    const pb = parentLinear.b;
    const pc = parentLinear.c;
    const pd = parentLinear.d;
    const det = pa * pd - pb * pc;
    if (Math.abs(det) <= EPSILON) return;
    const w = this.world;
    // R = P^-1 * W
    const r = scratchRelative;
    r.a = (pd * w.a - pb * w.c) / det;
    r.b = (pd * w.b - pb * w.d) / det;
    r.c = (pa * w.c - pc * w.a) / det;
    r.d = (pa * w.d - pc * w.b) / det;
    this.setAppliedLinear(r);
  }

  private setAppliedLinear(linear: Readonly<Affine2>): void {
    const s = decomposeAffine(linear, scratchDecomposition);
    const applied = this.applied;
    applied.rotation = wrapDegrees(s.rotation);
    applied.scaleX = s.scaleX;
    applied.scaleY = s.scaleY;
    applied.shearX = 0;
    applied.shearY = s.shearY;
  }
}

/**
 * The noRotation parent matrix: R(phi) * diag(px, py) * R(-phi). phi and px come from the parent's
 * X axis; py = |det P| / px keeps the parent's area scale. If the X axis has collapsed, the
 * orientation is read from the Y axis instead (px = 0).
 */
function parentStretch(p: Readonly<Affine2>, out: Affine2): Affine2 {
  const px = vectorLength(p.a, p.c);
  let cos = 1;
  let sin = 0;
  let py: number;
  if (px > EPSILON) {
    cos = p.a / px;
    sin = p.c / px;
    py = Math.abs(determinant(p)) / px;
  } else {
    py = vectorLength(p.b, p.d);
    if (py > EPSILON) {
      // phi = angle(Y axis) - 90 degrees.
      cos = p.d / py;
      sin = -p.b / py;
    }
  }
  const cross = (px - py) * cos * sin;
  out.a = px * cos * cos + py * sin * sin;
  out.b = cross;
  out.c = cross;
  out.d = px * sin * sin + py * cos * cos;
  return out;
}

/**
 * The noScale frame (r = the local rotation): unit X axis along P * (cos r, sin r) and a perpendicular unit Y axis, turned
 * the parent's way when `keepReflection` and the parent is mirrored. Falls back to the child's own
 * rotation if the parent maps that direction to zero.
 */
function parentRotationFrame(p: Readonly<Affine2>, local: Readonly<LocalTransform>, keepReflection: boolean, out: Affine2): Affine2 {
  const r = local.rotation * DEG_TO_RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  let zx = p.a * cos + p.b * sin;
  let zy = p.c * cos + p.d * sin;
  const length = vectorLength(zx, zy);
  if (length > EPSILON) {
    zx /= length;
    zy /= length;
  } else {
    zx = cos;
    zy = sin;
  }
  const side = keepReflection && determinant(p) < 0 ? -1 : 1;
  out.a = zx;
  out.c = zy;
  out.b = -side * zy;
  out.d = side * zx;
  return out;
}
