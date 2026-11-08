/*
 * Atlas Animator: original implementation.
 *
 * 2D affine math shared by the runtime. Conventions (atlas-anim@1):
 * - Positions are canvas pixels with y pointing down.
 * - Angles are degrees; positive turns clockwise on screen. With y down, the ordinary rotation
 *   matrix [cos -sin; sin cos] already turns clockwise, so no sign flips are needed anywhere.
 * - A world transform maps a bone-local point (u, v) to (a*u + b*v + x, c*u + d*v + y).
 *   Column (a, c) is the bone's local X axis in world space, column (b, d) its local Y axis.
 *
 * Nothing here allocates on the hot path: functions write into caller-owned objects.
 */

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** Below this magnitude a length or determinant is treated as zero (degenerate transform). */
export const EPSILON = 1e-9;

/** A 2x3 affine transform. Mutable on purpose: bones rewrite theirs every frame. */
export interface Affine2 {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

/** The seven local channels a bone is posed with. */
export interface LocalTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Rotation, scale and shear of a 2x2 linear map in canonical form (shearX is always 0). */
export interface LinearDecomposition {
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

export function createAffine(): Affine2 {
  return { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
}

export function createLocalTransform(): LocalTransform {
  return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
}

export function copyLocalTransform(from: Readonly<LocalTransform>, to: LocalTransform): LocalTransform {
  to.x = from.x;
  to.y = from.y;
  to.rotation = from.rotation;
  to.scaleX = from.scaleX;
  to.scaleY = from.scaleY;
  to.shearX = from.shearX;
  to.shearY = from.shearY;
  return to;
}

/** Wraps an angle in degrees to the half-open range (-180, 180]. */
export function wrapDegrees(angle: number): number {
  let wrapped = angle % 360;
  if (wrapped > 180) wrapped -= 360;
  else if (wrapped <= -180) wrapped += 360;
  return wrapped;
}

/**
 * Length of (x, y). Use this, not Math.hypot, on per-frame paths: Math.hypot boxes its
 * arguments (about 48 bytes of garbage per call in V8), Math.sqrt does not. Overflow safety does
 * not matter at pixel scales.
 */
export function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Wraps an angle in radians to the half-open range (-pi, pi]. */
export function wrapRadians(angle: number): number {
  let wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  else if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/** Turns the linear part of `m` by `radians` (left-multiplies by a rotation; translation kept). */
export function rotateLinear(m: Affine2, radians: number): void {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = m.a;
  const b = m.b;
  const c = m.c;
  const d = m.d;
  m.a = cos * a - sin * c;
  m.b = cos * b - sin * d;
  m.c = sin * a + cos * c;
  m.d = sin * b + cos * d;
}

export function determinant(m: Readonly<Affine2>): number {
  return m.a * m.d - m.b * m.c;
}

/**
 * Writes the linear part of a local transform into `out` (translation untouched).
 * The X axis is turned by rotation + shearX and has length scaleX; the Y axis is turned by
 * rotation + 90 + shearY and has length scaleY. With no shear this is R(rotation) * diag(sx, sy).
 */
export function composeLinear(
  rotation: number,
  scaleX: number,
  scaleY: number,
  shearX: number,
  shearY: number,
  out: Affine2
): Affine2 {
  const xAngle = (rotation + shearX) * DEG_TO_RAD;
  const yAngle = (rotation + 90 + shearY) * DEG_TO_RAD;
  out.a = Math.cos(xAngle) * scaleX;
  out.c = Math.sin(xAngle) * scaleX;
  out.b = Math.cos(yAngle) * scaleY;
  out.d = Math.sin(yAngle) * scaleY;
  return out;
}

/**
 * composeLinear of a local transform's channels (rotation 0 when `withRotation` is false), taking
 * the transform as an object for the per-frame paths (see decomposeAffine).
 */
export function composeLocalLinear(t: Readonly<LocalTransform>, withRotation: boolean, out: Affine2): Affine2 {
  const rotation = withRotation ? t.rotation : 0;
  const xAngle = (rotation + t.shearX) * DEG_TO_RAD;
  const yAngle = (rotation + 90 + t.shearY) * DEG_TO_RAD;
  out.a = Math.cos(xAngle) * t.scaleX;
  out.c = Math.sin(xAngle) * t.scaleX;
  out.b = Math.cos(yAngle) * t.scaleY;
  out.d = Math.sin(yAngle) * t.scaleY;
  return out;
}

/** Linear part of out = m * n (translation untouched). `out` must not alias `m` or `n`. */
export function multiplyLinear(m: Readonly<Affine2>, n: Readonly<Affine2>, out: Affine2): Affine2 {
  out.a = m.a * n.a + m.b * n.c;
  out.b = m.a * n.b + m.b * n.d;
  out.c = m.c * n.a + m.d * n.c;
  out.d = m.c * n.b + m.d * n.d;
  return out;
}

/**
 * Splits a 2x2 linear map into canonical rotation/scale/shear such that
 * composeLinear(result) reproduces it exactly (up to floating point).
 *
 * Canonical form: shearX = 0, scaleX >= 0, rotation in (-180, 180], and scaleY carries the sign of
 * the determinant so shearY stays within [-90, 90]. Any input with shearX = 0, scaleX > 0,
 * |shearY| < 90 and rotation in (-180, 180] decomposes back to itself.
 *
 * Derivation: column X = scaleX * (cos r, sin r) gives scaleX and r directly. Rotating column Y by
 * -r leaves v = scaleY * (cos(90 + h), sin(90 + h)) = scaleY * (-sin h, cos h), so
 * h = atan2(-v.x / scaleY, v.y / scaleY) once the sign of scaleY is chosen.
 */
export function decomposeLinear(
  a: number,
  b: number,
  c: number,
  d: number,
  out: LinearDecomposition
): LinearDecomposition {
  scratchLinear.a = a;
  scratchLinear.b = b;
  scratchLinear.c = c;
  scratchLinear.d = d;
  return decomposeAffine(scratchLinear, out);
}

const scratchLinear: Affine2 = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

/**
 * decomposeLinear of the linear part of `m`. Takes the matrix as an object: the per-frame paths
 * call this, and numbers passed to a call the engine does not inline are boxed.
 */
export function decomposeAffine(m: Readonly<Affine2>, out: LinearDecomposition): LinearDecomposition {
  const a = m.a;
  const b = m.b;
  const c = m.c;
  const d = m.d;
  const scaleX = vectorLength(a, c);
  out.shearX = 0;
  if (scaleX > EPSILON) {
    const r = Math.atan2(c, a);
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const vx = cos * b + sin * d;
    const vy = -sin * b + cos * d;
    const length = vectorLength(vx, vy);
    const scaleY = vy < 0 ? -length : length;
    out.rotation = r * RAD_TO_DEG;
    out.scaleX = scaleX;
    out.scaleY = scaleY;
    out.shearY = length > EPSILON ? Math.atan2(-vx / scaleY, vy / scaleY) * RAD_TO_DEG : 0;
  } else {
    // X axis collapsed: take the orientation from the Y axis instead.
    out.scaleX = 0;
    out.scaleY = vectorLength(b, d);
    out.rotation = out.scaleY > EPSILON ? wrapDegrees(Math.atan2(d, b) * RAD_TO_DEG - 90) : 0;
    out.shearY = 0;
  }
  return out;
}

/** out = m * (x, y) + translation. */
export function transformPoint(m: Readonly<Affine2>, x: number, y: number, out: Vec2): Vec2 {
  const px = m.a * x + m.b * y + m.x;
  out.y = m.c * x + m.d * y + m.y;
  out.x = px;
  return out;
}

/**
 * out = m^-1 * ((x, y) - translation). Returns false and leaves `out` untouched when the linear
 * part is singular.
 */
export function inverseTransformPoint(m: Readonly<Affine2>, x: number, y: number, out: Vec2): boolean {
  const det = determinant(m);
  if (Math.abs(det) <= EPSILON) return false;
  const dx = x - m.x;
  const dy = y - m.y;
  out.x = (m.d * dx - m.b * dy) / det;
  out.y = (m.a * dy - m.c * dx) / det;
  return true;
}

/**
 * Clamps a rotation to [setup + min, setup + max] (limits are relative to the bone's setup
 * rotation, AtlasRig semantics).
 *
 * Rotations are compared as angles, so 350 and -10 are the same pose. If any full-turn
 * equivalent of the input lies inside the limits, the input is returned unchanged (keyed values
 * keep their numeric continuity); otherwise the result is the bound nearer around the circle.
 */
export function clampRotationToLimits(rotation: number, setupRotation: number, min: number, max: number): number {
  const delta = rotation - setupRotation;
  if (delta >= min && delta <= max) return rotation;
  const wrapped = wrapDegrees(delta);
  // The full-turn equivalents worth trying (no array literal: this runs per bone per frame).
  if ((wrapped >= min && wrapped <= max) || (wrapped - 360 >= min && wrapped - 360 <= max) || (wrapped + 360 >= min && wrapped + 360 <= max)) {
    return rotation;
  }
  const toMin = Math.abs(wrapDegrees(wrapped - min));
  const toMax = Math.abs(wrapDegrees(wrapped - max));
  return setupRotation + (toMin <= toMax ? min : max);
}
