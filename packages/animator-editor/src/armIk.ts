/*
 * Atlas Animator editor: original implementation.
 *
 * Hand IK for the arms. The rig's only IK constraints are the legs, so an arm is solved here, analytically, as a
 * two-bone chain (upper arm, forearm) and written back as ordinary FK rotation offsets: the clip keeps plain
 * rotate keys, nothing in the runtime changes. A target the arm cannot reach is pulled back to the chain's full
 * length (never stretched, matching the "no limb stretch" rule). The elbow keeps the side it is bent to now.
 * A two-hand grip pins the second hand to a point in the lead hand's frame (the held weapon's axis).
 */
import type { Bone, Skeleton } from "@atlas-animator/core/core";

export type Side = "l" | "r";

/**
 * The bone name for a side of the body: the stock rigs end in `_l` / `_r`, the pro kit rigs in `_near` / `_far`
 * (`l` is the near side). Falls back to the stock name when neither exists.
 */
export function sideName(skeleton: { findBone(name: string): unknown }, base: string, side: Side): string {
  for (const suffix of [side, side === "l" ? "near" : "far"]) if (skeleton.findBone(`${base}_${suffix}`)) return `${base}_${suffix}`;
  return `${base}_${side}`;
}
type Pt = readonly [number, number];

/** The arm stops this fraction short of fully straight (a straight chain has no elbow side to keep). */
export const MAX_REACH = 0.999;

const DEG = 180 / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export interface TwoBone {
  elbow: Pt;
  /** The point the wrist ends on: the target, or the nearest reachable point toward it. */
  wrist: Pt;
  reached: boolean;
}

/**
 * Two-bone solve in the plane: shoulder `p0`, segment lengths `l1` (upper) and `l2` (fore), wrist target `t`.
 * `side` is the sign of cross(elbow - p0, wrist - elbow) to keep (+1 or -1); 0 picks +1.
 */
export function solveTwoBone(p0: Pt, l1: number, l2: number, t: Pt, side: number): TwoBone {
  let dx = t[0] - p0[0];
  let dy = t[1] - p0[1];
  let d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1e-6;
  }
  const max = (l1 + l2) * MAX_REACH;
  const min = Math.abs(l1 - l2) + 1e-3;
  const dd = Math.min(max, Math.max(min, d));
  const ux = dx / d;
  const uy = dy / d;
  const wrist: Pt = [p0[0] + ux * dd, p0[1] + uy * dd];
  const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const bx = p0[0] + ux * a;
  const by = p0[1] + uy * a;
  // With perp = (-uy, ux), an elbow at base + perp * h * s has cross(elbow - p0, wrist - elbow) = -s * h * dd: keep the sign.
  const s = side < 0 ? 1 : -1;
  const elbow: Pt = [bx - uy * h * s, by + ux * h * s];
  return { elbow, wrist, reached: d <= max + 1e-6 && d >= min - 1e-6 };
}

function bone(skeleton: Skeleton, name: string): Bone | null {
  return skeleton.findBone(name) ?? null;
}

/** +1 when a local rotation turns the bone clockwise on screen, -1 under a mirrored parent. */
function rotationSign(b: Bone): number {
  const p = b.parent?.world;
  return p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
}

const worldAngle = (b: Bone) => Math.atan2(b.world.c, b.world.a) * DEG;

export interface ArmSolve {
  /** New rotation offsets from setup, degrees, for the upper arm and forearm. */
  upper: number;
  fore: number;
  /** False when the target was out of reach (the wrist stops short of it). */
  reached: boolean;
  /** Where the wrist (hand bone origin) ended up. */
  wrist: Pt;
}

/**
 * Solves the arm of `side` so that the hand bone origin lands on `target` (skeleton space), and writes the result
 * into the skeleton's pose (rotations only) and world transforms. The skeleton must already be posed.
 */
export function solveArm(skeleton: Skeleton, side: Side, target: Pt): ArmSolve | null {
  const upper = bone(skeleton, sideName(skeleton, "upper_arm", side));
  const fore = bone(skeleton, sideName(skeleton, "forearm", side));
  const hand = bone(skeleton, sideName(skeleton, "hand", side));
  if (!upper || !fore || !hand) return null;
  skeleton.updateWorldTransform("reset");
  const p0: Pt = [upper.world.x, upper.world.y];
  const e0: Pt = [fore.world.x, fore.world.y];
  const w0: Pt = [hand.world.x, hand.world.y];
  const l1 = Math.hypot(e0[0] - p0[0], e0[1] - p0[1]);
  const l2 = Math.hypot(w0[0] - e0[0], w0[1] - e0[1]);
  const cross = (e0[0] - p0[0]) * (w0[1] - e0[1]) - (e0[1] - p0[1]) * (w0[0] - e0[0]);
  const solved = solveTwoBone(p0, l1, l2, target, cross < -1e-6 ? -1 : 1);

  const upperTarget = Math.atan2(solved.elbow[1] - p0[1], solved.elbow[0] - p0[0]) * DEG;
  upper.pose.rotation += rotationSign(upper) * wrap(upperTarget - worldAngle(upper));
  skeleton.updateWorldTransform("reset");
  const foreTarget = Math.atan2(solved.wrist[1] - fore.world.y, solved.wrist[0] - fore.world.x) * DEG;
  fore.pose.rotation += rotationSign(fore) * wrap(foreTarget - worldAngle(fore));
  skeleton.updateWorldTransform("reset");
  return {
    upper: upper.pose.rotation - upper.data.rotation,
    fore: fore.pose.rotation - fore.data.rotation,
    reached: solved.reached,
    wrist: [hand.world.x, hand.world.y]
  };
}

/** The grip point in skeleton space: (along, across) px in the lead hand bone's frame (x along the hand, y across it). */
export function gripPoint(skeleton: Skeleton, lead: Side, along: number, across: number): Pt | null {
  const hand = bone(skeleton, sideName(skeleton, "hand", lead));
  if (!hand) return null;
  const out = { x: 0, y: 0 };
  hand.localToWorld(along, across, out);
  return [out.x, out.y];
}

export const otherSide = (side: Side): Side => (side === "l" ? "r" : "l");

/**
 * Solves the lead arm to `target`, then (with a grip) the other arm onto the grip point of the lead hand.
 * Returns the rotation offsets to key, by bone name.
 */
export function solveHands(skeleton: Skeleton, lead: Side, target: Pt, grip?: { along: number; across: number }): { offsets: Record<string, number>; reached: boolean; gripReached: boolean | null } | null {
  const a = solveArm(skeleton, lead, target);
  if (!a) return null;
  const offsets: Record<string, number> = { [sideName(skeleton, "upper_arm", lead)]: a.upper, [sideName(skeleton, "forearm", lead)]: a.fore };
  let gripReached: boolean | null = null;
  if (grip) {
    const g = gripPoint(skeleton, lead, grip.along, grip.across);
    const o = otherSide(lead);
    const b = g ? solveArm(skeleton, o, g) : null;
    if (b) {
      offsets[sideName(skeleton, "upper_arm", o)] = b.upper;
      offsets[sideName(skeleton, "forearm", o)] = b.fore;
      gripReached = b.reached;
    }
  }
  return { offsets, reached: a.reached, gripReached };
}
