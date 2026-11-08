import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { gripPoint, MAX_REACH, otherSide, solveArm, solveHands, solveTwoBone, type Side } from "./armIk.js";
import { ALL_OUTFITS } from "./fixtures.js";

const cross = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);

describe("two-bone solve", () => {
  it("puts the wrist on a reachable target with both segment lengths kept", () => {
    const r = solveTwoBone([0, 0], 100, 80, [120, 60], 1);
    expect(r.reached).toBe(true);
    expect(r.wrist).toEqual([120, 60]);
    expect(Math.hypot(r.elbow[0], r.elbow[1])).toBeCloseTo(100, 6);
    expect(Math.hypot(r.wrist[0] - r.elbow[0], r.wrist[1] - r.elbow[1])).toBeCloseTo(80, 6);
  });
  it("keeps the requested elbow side, both ways", () => {
    for (const side of [1, -1]) {
      const r = solveTwoBone([0, 0], 100, 80, [120, 60], side);
      expect(Math.sign(cross([0, 0], r.elbow, r.wrist))).toBe(side);
    }
  });
  it("pulls an out-of-reach target back to the full length (no stretch) toward the target", () => {
    const r = solveTwoBone([0, 0], 100, 80, [500, 0], 1);
    expect(r.reached).toBe(false);
    expect(r.wrist[0]).toBeCloseTo(180 * MAX_REACH, 6);
    expect(r.wrist[1]).toBeCloseTo(0, 6);
  });
});

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const load = (limits = false) => {
  const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));
  const sk = new Skeleton(doc);
  // a one-shot (combat) clip: bone ranges are not enforced; on a loop the ranges would clamp the solve
  sk.limitsEnforced = limits;
  sk.setToSetupPose();
  sk.updateWorldTransform("reset");
  return sk;
};
const hand = (sk: Skeleton, s: Side) => [sk.findBone(`hand_${s}`)!.world.x, sk.findBone(`hand_${s}`)!.world.y] as const;
const len = (sk: Skeleton, a: string, b: string) => Math.hypot(sk.findBone(b)!.world.x - sk.findBone(a)!.world.x, sk.findBone(b)!.world.y - sk.findBone(a)!.world.y);

describe("arm IK on the player rig", () => {
  for (const side of ["l", "r"] as const) {
    it(`the ${side} hand follows a reachable target and the arm keeps its length (${side === "l" ? "screen left" : "mirrored right"} arm)`, () => {
      const sk = load();
      const l1 = len(sk, `upper_arm_${side}`, `forearm_${side}`);
      const l2 = len(sk, `forearm_${side}`, `hand_${side}`);
      const [hx, hy] = hand(sk, side);
      const target: [number, number] = [hx + (side === "l" ? -40 : 40), hy - 150];
      const r = solveArm(sk, side, target)!;
      expect(r.reached).toBe(true);
      const [nx, ny] = hand(sk, side);
      expect(Math.hypot(nx - target[0], ny - target[1])).toBeLessThan(0.5);
      expect(len(sk, `upper_arm_${side}`, `forearm_${side}`)).toBeCloseTo(l1, 3);
      expect(len(sk, `forearm_${side}`, `hand_${side}`)).toBeCloseTo(l2, 3);
    });
  }
  it("a target out of reach stops the hand short, in line, at the full arm length", () => {
    const sk = load();
    const up = sk.findBone("upper_arm_l")!;
    const l = len(sk, "upper_arm_l", "forearm_l") + len(sk, "forearm_l", "hand_l");
    const r = solveArm(sk, "l", [up.world.x - 1000, up.world.y - 1000])!;
    expect(r.reached).toBe(false);
    expect(Math.hypot(r.wrist[0] - up.world.x, r.wrist[1] - up.world.y)).toBeCloseTo(l * MAX_REACH, 0);
  });
  it("keeps the elbow bent the way it already is", () => {
    const sk = load();
    const arm = (s: Side) => [sk.findBone(`upper_arm_${s}`)!, sk.findBone(`forearm_${s}`)!, sk.findBone(`hand_${s}`)!] as const;
    const sign = (s: Side) => {
      const [u, f, h] = arm(s);
      return Math.sign(cross([u.world.x, u.world.y], [f.world.x, f.world.y], [h.world.x, h.world.y]));
    };
    const before = { l: sign("l"), r: sign("r") };
    for (const s of ["l", "r"] as const) {
      const [hx, hy] = hand(sk, s);
      solveArm(sk, s, [hx + (s === "l" ? -30 : 30), hy - 90]);
      if (before[s] !== 0) expect(sign(s)).toBe(before[s]);
    }
  });
  it("returns the rotation offsets the clip needs (pose minus setup)", () => {
    const sk = load();
    const [hx, hy] = hand(sk, "l");
    const r = solveArm(sk, "l", [hx - 60, hy - 100])!;
    expect(r.upper).toBeCloseTo(sk.findBone("upper_arm_l")!.pose.rotation - sk.findBone("upper_arm_l")!.data.rotation, 6);
    expect(Math.abs(r.upper) + Math.abs(r.fore)).toBeGreaterThan(5);
  });
  it("a two-hand grip pins the second hand to a point of the lead hand's frame while the lead moves", () => {
    const sk = load();
    const [hx, hy] = hand(sk, "l");
    const grip = { along: 70, across: 0 };
    const r = solveHands(sk, "l", [hx - 20, hy - 120], grip)!;
    expect(Object.keys(r.offsets).sort()).toEqual(["forearm_l", "forearm_r", "upper_arm_l", "upper_arm_r"]);
    const g = gripPoint(sk, "l", grip.along, grip.across)!;
    const [rx, ry] = hand(sk, otherSide("l"));
    if (r.gripReached) expect(Math.hypot(rx - g[0], ry - g[1])).toBeLessThan(0.5);
    else expect(Math.hypot(rx - g[0], ry - g[1])).toBeGreaterThan(0);
  });
  it("without a grip only the lead arm changes", () => {
    const sk = load();
    const [hx, hy] = hand(sk, "r");
    const r = solveHands(sk, "r", [hx + 20, hy - 90])!;
    expect(Object.keys(r.offsets).sort()).toEqual(["forearm_r", "upper_arm_r"]);
    expect(r.gripReached).toBeNull();
  });
});
