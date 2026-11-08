import { describe, expect, it } from "vitest";
import { clipSchema, type ClipData } from "@atlas-animator/core/core";
import { emptyClip, frameTime, setVectorKey } from "./clipModel.js";
import { footLockRanges, lockFoot, lockRoot, maxDrift, unlockFoot } from "./footLockModel.js";

const base = (): ClipData => emptyClip(1);
const lock = { ik: "foot_l_ik", target: "foot_l_target", a: 4, b: 12, x: 20, y: -3 };
const mixes = (c: ClipData) => (c.ik.foot_l_ik as unknown as { time: number; mix: number }[]).map((k) => [Math.round(k.time * 30), k.mix]);

describe("foot lock", () => {
  it("keys the IK mix to 1 over the range with a one-frame blend each side, and holds the target", () => {
    const c = lockFoot(base(), lock);
    expect(mixes(c)).toEqual([[3, 0], [4, 1], [12, 1], [13, 0]]);
    const tl = c.bones.foot_l_target!.translate!;
    expect(tl.map((k) => [Math.round(k.time * 30), k.x, k.y])).toEqual([[4, 20, -3], [12, 20, -3]]);
    expect(clipSchema.safeParse(c).success).toBe(true);
  });
  it("replaces earlier keys inside the range and leaves the clip untouched", () => {
    const orig = setVectorKey(base(), "foot_l_target", "translate", frameTime(base(), 8), 99, 99);
    const c = lockFoot(orig, lock);
    expect(c.bones.foot_l_target!.translate).toHaveLength(2);
    expect(orig.bones.foot_l_target!.translate).toHaveLength(1);
  });
  it("skips blend keys that fall outside the clip and respects keys already there", () => {
    const c = lockFoot(base(), { ...lock, a: 0, b: 30 });
    expect(mixes(c)).toEqual([[0, 1], [30, 1]]);
  });
  it("reads its own ranges back and unlocks them completely", () => {
    const c = lockFoot(base(), lock);
    expect(footLockRanges(c, "foot_l_ik")).toEqual([{ a: 4, b: 12 }]);
    const open = unlockFoot(c, "foot_l_ik", "foot_l_target", 4, 12);
    expect(open.ik).toEqual({});
    expect(open.bones.foot_l_target).toBeUndefined();
  });
  it("rejects a backwards range", () => {
    expect(() => lockFoot(base(), { ...lock, a: 9, b: 3 })).toThrow(/ends before/);
  });
});

describe("root lock and drift", () => {
  it("holds a bone at one offset across the range", () => {
    let c = setVectorKey(base(), "root", "translate", frameTime(base(), 6), 40, 0);
    c = lockRoot(c, "root", 2, 10, 5, 1);
    expect(c.bones.root!.translate!.map((k) => [Math.round(k.time * 30), k.x, k.y])).toEqual([[2, 5, 1], [10, 5, 1]]);
  });
  it("measures drift from the first sample", () => {
    expect(maxDrift([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 1, y: 1 }])).toBe(5);
    expect(maxDrift([])).toBe(0);
  });
});
