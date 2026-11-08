/*
 * Atlas Animator: original implementation.
 *
 * IK reach: clips keep every active two-bone target within
 * MAX_IK_REACH of the chain's posed reach; IK softness only in the last IK_SOFT_SHARE of the reach
 * (no knee pop near extension). Live limits and the validator flag a target past MAX_IK_REACH.
 */
import type { Skeleton } from "../core/skeleton.js";

/** (2026-10-15): reach allowed up to 0.995; IK softness covers the last 2% (IK_SOFT_SHARE). */
export const MAX_IK_REACH = 0.995;
export const IK_SOFT_SHARE = 0.02;

export interface IkReach {
  name: string;
  /** target distance from the chain root over the posed chain length (bone lengths times world scale). */
  ratio: number;
  mix: number;
}

/**
 * Reach ratios of every two-bone IK constraint that runs on a posed skeleton (world updated): mix > 0
 * and active in the skeleton's update plan (Skeleton.isConstraintActive: a skin constraint of an
 * inactive skin, or one on an inactive skin bone, does not run and is not checked). Live and batch
 * checks both go through this, so they share the activation rules.
 */
export function ikReaches(skeleton: Skeleton): IkReach[] {
  const out: IkReach[] = [];
  for (let i = 0; i < skeleton.ikConstraints.length; i++) {
    const c = skeleton.ikConstraints[i]!;
    if (c.bones.length !== 2 || !(c.pose.mix > 0) || !skeleton.isConstraintActive("ik", i)) continue;
    const [a, b] = c.bones as [(typeof c.bones)[number], (typeof c.bones)[number]];
    const o = { x: 0, y: 0 };
    const k = { x: 0, y: 0 };
    const e = { x: 0, y: 0 };
    const t = { x: 0, y: 0 };
    a.localToWorld(0, 0, o);
    b.localToWorld(0, 0, k);
    b.localToWorld(b.data.length, 0, e);
    c.target.localToWorld(0, 0, t);
    const len = Math.hypot(k.x - o.x, k.y - o.y) + Math.hypot(e.x - k.x, e.y - k.y);
    if (!(len > 0)) continue;
    out.push({ name: c.data.name, ratio: Math.hypot(t.x - o.x, t.y - o.y) / len, mix: c.pose.mix });
  }
  return out;
}

/** Constraints over the hard reach on a posed skeleton. */
export function ikReachViolations(skeleton: Skeleton, max = MAX_IK_REACH): IkReach[] {
  return ikReaches(skeleton).filter((r) => r.ratio > max + 1e-6);
}

/**
 * Constraints over the hard reach in any of `outfits` (skin lists, bandOutfits): per outfit the skins
 * are set and `pose()` re-poses the sample; the worst ratio per constraint is kept. The skeleton is
 * left in the last outfit.
 */
export function ikReachViolationsInOutfits(skeleton: Skeleton, outfits: readonly (readonly string[])[], pose: () => void, max = MAX_IK_REACH): IkReach[] {
  const worst = new Map<string, IkReach>();
  for (const outfit of outfits) {
    skeleton.setActiveSkins(outfit);
    pose();
    for (const r of ikReachViolations(skeleton, max)) if (!(r.ratio <= (worst.get(r.name)?.ratio ?? -1))) worst.set(r.name, r);
  }
  return [...worst.values()];
}
