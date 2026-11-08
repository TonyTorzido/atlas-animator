import { describe, expect, it } from "vitest";
import { bonesInBox, helperBones, hiddenHelpers, pickBone, rangeBetween, selectBones, snapDegrees, withSelectedAncestor, type PickBone } from "./selectionModel.js";

const bone = (name: string, ox: number, oy: number, tx: number, ty: number, extra: Partial<PickBone> = {}): PickBone => ({ name, ox, oy, tx, ty, helper: false, hidden: false, ...extra });

describe("pickBone", () => {
  const bones = [bone("arm", 0, 0, 100, 0), bone("fore", 100, 0, 200, 0), bone("target", 50, 3, 50, 3, { helper: true })];

  it("picks the closest bone inside the tolerance", () => {
    expect(pickBone(bones, 150, 4, 10)).toBe("fore");
    expect(pickBone(bones, 20, -4, 10)).toBe("arm");
    expect(pickBone(bones, 150, 40, 10)).toBeNull();
  });
  it("prefers a real bone over a helper sitting on it", () => {
    expect(pickBone(bones, 50, 2, 10)).toBe("arm");
  });
  it("still picks a helper when it is clearly the nearest", () => {
    const off = [bone("arm", 0, 0, 100, 0), bone("target", 50, 40, 50, 40, { helper: true })];
    expect(pickBone(off, 50, 38, 10)).toBe("target");
  });
  it("ignores hidden helpers", () => {
    const hid = [bone("target", 50, 40, 50, 40, { helper: true, hidden: true })];
    expect(pickBone(hid, 50, 40, 10)).toBeNull();
  });
});

describe("helpers", () => {
  const names = ["root", "hand_near", "hand_near_target", "weapon", "weapon_tip", "weapon_grip2", "weapon_grip2_wrist", "foot_near_target"].map((name) => ({ name }));
  const ik = [
    { target: "hand_near_target" },
    { target: "foot_near_target" },
    { target: "weapon_grip2_wrist" }
  ];
  it("finds IK targets and weapon markers", () => {
    expect([...helperBones(names, ik)].sort()).toEqual(["foot_near_target", "hand_near_target", "weapon_grip2", "weapon_grip2_wrist", "weapon_tip"]);
  });
  it("hides a helper whose constraint is off and keeps the live ones", () => {
    const hidden = hiddenHelpers(helperBones(names, ik), [
      { target: "hand_near_target", mix: 0 },
      { target: "foot_near_target", mix: 1 },
      { target: "weapon_grip2_wrist", mix: 0 }
    ]);
    expect([...hidden].sort()).toEqual(["hand_near_target", "weapon_grip2", "weapon_grip2_wrist", "weapon_tip"]);
    const on = hiddenHelpers(helperBones(names, ik), [
      { target: "hand_near_target", mix: 0.5 },
      { target: "foot_near_target", mix: 1 },
      { target: "weapon_grip2_wrist", mix: 1 }
    ]);
    expect([...on]).toEqual(["weapon_tip"]);
  });
});

describe("box select", () => {
  const bones = [bone("a", 10, 10, 60, 10), bone("b", 200, 200, 260, 200), bone("h", 30, 30, 30, 30, { helper: true }), bone("gone", 20, 20, 20, 20, { helper: true, hidden: true }), bone("tipin", -50, 15, 20, 15)];
  it("takes bones with an end in the box, in any drag direction, never hidden helpers", () => {
    expect(bonesInBox(bones, { x0: 0, y0: 0, x1: 70, y1: 40 })).toEqual(["a", "h", "tipin"]);
    expect(bonesInBox(bones, { x0: 70, y0: 40, x1: 0, y1: 0 })).toEqual(["a", "h", "tipin"]);
    expect(bonesInBox(bones, { x0: 190, y0: 190, x1: 270, y1: 210 })).toEqual(["b"]);
  });
});

describe("selection edits", () => {
  const none = { active: null, names: [] as string[] };
  it("replaces, adds and toggles, keeping the active bone inside the set", () => {
    const one = selectBones(none, ["a"], "replace");
    expect(one).toEqual({ active: "a", names: ["a"] });
    const two = selectBones(one, ["b"], "add");
    expect(two).toEqual({ active: "b", names: ["a", "b"] });
    const off = selectBones(two, ["b"], "toggle");
    expect(off).toEqual({ active: "a", names: ["a"] });
    expect(selectBones(off, ["a"], "toggle")).toEqual({ active: null, names: [] });
    expect(selectBones(two, ["a", "b", "c"], "replace", "a")).toEqual({ active: "a", names: ["a", "b", "c"] });
  });
  it("selects the rows between two list rows", () => {
    const order = ["root", "body", "pelvis", "chest", "head"];
    expect(rangeBetween(order, "body", "chest")).toEqual(["body", "pelvis", "chest"]);
    expect(rangeBetween(order, "head", "pelvis")).toEqual(["pelvis", "chest", "head"]);
    expect(rangeBetween(order, null, "head")).toEqual(["head"]);
  });
  it("finds bones that already ride a selected ancestor", () => {
    const parent: Record<string, string | null> = { arm: "chest", fore: "arm", hand: "fore", chest: null };
    expect([...withSelectedAncestor(["arm", "hand"], (n) => parent[n] ?? null)]).toEqual(["hand"]);
  });
});

describe("snapDegrees", () => {
  it("rounds to the step", () => {
    expect(snapDegrees(7.4)).toBe(0);
    expect(snapDegrees(7.6)).toBe(15);
    expect(snapDegrees(-22.6)).toBe(-30);
    expect(snapDegrees(44, 45)).toBe(45);
    expect(Object.is(snapDegrees(-1), 0)).toBe(true);
  });
});
