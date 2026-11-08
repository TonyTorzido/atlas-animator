/** Swing and shot geometry used by the swing-effects preview (a self-contained copy of the combat hit tests). */

export const SWING_RANGE_M = 110;
/** Half of the 120 degree swing arc. */
export const SWING_HALF_ANGLE_DEG = 60;
/** Targets whose centre is within this distance are hit regardless of angle. */
export const SWING_POINT_BLANK_M = 25;
export const SWING_TARGET_RADIUS_M = 20;
/** Cleave cap: at most this many targets per swing, nearest first. */
export const SWING_MAX_TARGETS = 1;

export const SHOT_RANGE_M = 280;
export const SHOT_WIDTH_M = 18;
export const SHOT_RECOVERY_TICKS = 20;
export const SHOT_DAMAGE_FACTOR = 0.75;

/** Shot rules of one ranged attack kind: the hitscan corridor, the recovery gate and the damage factor. */
export type ShotProfile = Readonly<{
  id: "arrow" | "arcane_blast" | "holy_arc";
  rangeM: number;
  widthM: number;
  recoveryTicks: number;
  damageFactor: number;
}>;

export const BOW_SHOT_PROFILE: ShotProfile = Object.freeze({
  id: "arrow",
  rangeM: SHOT_RANGE_M,
  widthM: SHOT_WIDTH_M,
  recoveryTicks: SHOT_RECOVERY_TICKS,
  damageFactor: SHOT_DAMAGE_FACTOR
});

export type ProjectileTransform = {
  offsetX: number;
  offsetY: number;
  rotationDegrees: number;
  scaleX: number;
  scaleY: number;
  impactX: number;
  impactY: number;
  tailX: number;
  tailY: number;
};

const SWING_HALF_ANGLE_COS = Math.cos((SWING_HALF_ANGLE_DEG * Math.PI) / 180);
const SWING_HALF_ANGLE_SIN = Math.sin((SWING_HALF_ANGLE_DEG * Math.PI) / 180);
const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

/** Signed shortest east-positive longitude change from `from` to `to`, across 180 degrees. */
function longitudeDeltaDegrees(from: number, to: number): number {
  const raw = to - from;
  if (raw >= -180 && raw < 180) return raw;
  const delta = ((((raw + 180) % 360) + 360) % 360) - 180;
  return Object.is(delta, -0) ? 0 : delta;
}

/** Mutable output point for `toLocalMeters` (reuse one per caller; nothing is allocated). */
export type LocalMetersOut = { x: number; y: number };

/**
 * Local metric frame around (lat0, lon0): x = metres east, y = metres north.
 * east = dLon * cos(lat0) * R * rad, north = dLat * R * rad. Pass `cosLat0 = Math.cos(lat0 rad)`,
 * computed once per swing. Longitude deltas take the short way across the antimeridian.
 * Accurate to well under a metre at swing/shot ranges.
 */
export function toLocalMeters(
  lat0: number,
  lon0: number,
  cosLat0: number,
  lat: number,
  lon: number,
  out: LocalMetersOut
): void {
  out.x = longitudeDeltaDegrees(lon0, lon) * cosLat0 * METERS_PER_DEGREE;
  out.y = (lat - lat0) * METERS_PER_DEGREE;
}

/**
 * Does a target circle at local (x, y) with radius `targetRadiusM` touch the swing arc aimed
 * along (dirX, dirY)? The arc is SWING_RANGE_M long (to the target's edge) and
 * 2 x SWING_HALF_ANGLE_DEG wide; a centre within SWING_POINT_BLANK_M always counts.
 * The direction is normalised here, so a near-unit wire vector is fine.
 */
export function swingArcContains(
  dirX: number,
  dirY: number,
  x: number,
  y: number,
  targetRadiusM: number
): boolean {
  const dirLength = Math.hypot(dirX, dirY);
  if (!(dirLength > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const distanceM = Math.hypot(x, y);
  if (distanceM <= SWING_POINT_BLANK_M) return true;
  const radius = Math.max(0, targetRadiusM);
  if (distanceM - radius > SWING_RANGE_M) return false;
  const ux = dirX / dirLength;
  const uy = dirY / dirLength;
  const along = ux * x + uy * y;
  const across = Math.abs(ux * y - uy * x);
  // Centre inside the wedge: cos(angle) >= cos(half angle).
  if (along >= distanceM * SWING_HALF_ANGLE_COS) return true;
  // Otherwise test the circle against the nearer edge ray (rotated by the half angle toward it).
  const projectionOnEdge = along * SWING_HALF_ANGLE_COS + across * SWING_HALF_ANGLE_SIN;
  if (projectionOnEdge < 0) return distanceM <= radius;
  const distanceToEdge = across * SWING_HALF_ANGLE_COS - along * SWING_HALF_ANGLE_SIN;
  return distanceToEdge <= radius;
}

/**
 * Hitscan shot along (dirX, dirY): returns the target's distance along the aim line (>= 0) when
 * its circle touches the profile's corridor (`widthM` wide, `rangeM` long; the bow's SHOT_WIDTH_M x
 * SHOT_RANGE_M by default), otherwise null.
 * Targets behind the shooter are never hit. Callers pick the smallest result (first on the line).
 */
export function shotLineContains(
  dirX: number,
  dirY: number,
  x: number,
  y: number,
  targetRadiusM: number,
  profile: ShotProfile = BOW_SHOT_PROFILE
): number | null {
  const dirLength = Math.hypot(dirX, dirY);
  if (!(dirLength > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const ux = dirX / dirLength;
  const uy = dirY / dirLength;
  const along = ux * x + uy * y;
  if (along < 0) return null;
  const radius = Math.max(0, targetRadiusM);
  if (along - radius > profile.rangeM) return null;
  const across = Math.abs(ux * y - uy * x);
  if (across > profile.widthM / 2 + radius) return null;
  return along;
}

