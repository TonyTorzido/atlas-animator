/*
 * Atlas Animator: original implementation.
 *
 * Leg stance policy: with `stance: "foreshorten"`
 * a planted leg stays straight as drawn (the shin keeps its setup angle to the thigh) and shortens
 * toward the viewer when the hip comes closer to the plant: the thigh turns so the ankle lies on
 * the hip -> plant line and its length scales so the ankle lands exactly on the plant. No knee bow,
 * no knee pop. Two-bone IK blends in only while the foot is lifted (swing) and out again at plant.
 * `stance: "bend"` keeps two-bone IK in stance too. Data: preset `ik.stance`, `ik.blend`.
 */
export type StanceMode = "foreshorten" | "bend";

export interface Pt2 {
  x: number;
  y: number;
}

/** What the solver needs from a posed skeleton: pose the keys, read a bone's world point. */
export interface StanceRig {
  pose(keys: Record<string, number>): void;
  world(bone: string, lx?: number, ly?: number): Pt2;
  /** Current world rotation (degrees) of a bone's X axis. */
  rotation(bone: string): number;
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const ang = (a: Pt2, b: Pt2) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/**
 * Straight-leg stance: writes `keys[thigh]` (rotation offset) and `keys[thigh.scaleX]` so the shin's
 * end (the ankle, `shin` length along its X axis) lands on `ankle`. The shin must not inherit the
 * thigh's scale (inherit noScale), so only the thigh foreshortens. Returns the residual (world px).
 */
export function solveStraightStance(rig: StanceRig, keys: Record<string, number>, thigh: string, shin: string, shinLength: number, ankle: Pt2, iterations = 8): number {
  let residual = Infinity;
  for (let it = 0; it < iterations; it++) {
    rig.pose(keys);
    const hip = rig.world(thigh);
    const knee = rig.world(shin);
    const end = rig.world(shin, shinLength, 0);
    // length: the thigh scale so |end - hip| = |ankle - hip| (shin length fixed, straight angle kept)
    const want = Math.hypot(ankle.x - hip.x, ankle.y - hip.y);
    const l1 = Math.hypot(knee.x - hip.x, knee.y - hip.y) / (keys[`${thigh}.scaleX`] ?? 1);
    const l2 = Math.hypot(end.x - knee.x, end.y - knee.y);
    const kneeAngle = (Math.abs(wrap(ang(knee, end) - ang(hip, knee))) * Math.PI) / 180;
    // law of cosines on the fixed knee angle: want^2 = a^2 + l2^2 + 2 a l2 cos(k)
    const c = Math.cos(kneeAngle);
    const a = -l2 * c + Math.sqrt(Math.max(0, l2 * l2 * c * c - (l2 * l2 - want * want)));
    keys[`${thigh}.scaleX`] = Math.max(0.2, a / l1);
    rig.pose(keys);
    const h2 = rig.world(thigh);
    const e2 = rig.world(shin, shinLength, 0);
    const err = wrap(ang(h2, ankle) - ang(h2, e2));
    const r0 = keys[thigh] ?? 0;
    keys[thigh] = r0 + 1;
    rig.pose(keys);
    const slope = wrap(ang(rig.world(thigh), rig.world(shin, shinLength, 0)) - ang(h2, e2)) || 1;
    keys[thigh] = r0 + err / slope;
    rig.pose(keys);
    const e3 = rig.world(shin, shinLength, 0);
    residual = Math.hypot(e3.x - ankle.x, e3.y - ankle.y);
    if (residual < 1e-7) break;
  }
  return residual;
}

/** IK mix over a swing (u in 0..1): blends in over the first `blend`, out over the last `blend`. */
export function swingIkMix(u: number, blend: number): number {
  const s = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  if (blend <= 0) return u > 0 && u < 1 ? 1 : 0;
  return s(0, blend, u) * (1 - s(1 - blend, 1, u));
}
