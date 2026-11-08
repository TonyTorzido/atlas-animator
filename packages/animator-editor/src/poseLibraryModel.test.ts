import { describe, expect, it } from "vitest";
import { makeMirrorRig } from "./mirrorModel.js";
import { makePose } from "./poseModel.js";
import { blendPoseCopy, effectiveTags, filterPoses, inferTags, mirrorPoseCopy, normalizeTags, onlyBones, poseHash } from "./poseLibraryModel.js";

const o = (rotate: number) => ({ rotate, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } });
const pose = (name: string, extra: Partial<Parameters<typeof makePose>[0]> = {}) => makePose({ name, bones: { a: o(10) }, attachments: {}, drawOrder: [], ...extra });

describe("tags and search", () => {
  it("guesses tags for poses saved without any", () => {
    expect(inferTags({ name: "axe_guard_high", note: "" })).toContain("guard");
    expect(effectiveTags(pose("x", { tags: ["idle"] }))).toEqual(["idle"]);
    expect(normalizeTags([" Idle ", "guard", "idle", "zeta", "Alpha"])).toEqual(["guard", "idle", "alpha", "zeta"]);
  });

  it("filters by words and by chosen tags", () => {
    const list = [{ pose: pose("sword_guard", { tags: ["guard"] }) }, { pose: pose("sword_windup", { tags: ["wind-up"], note: "pulled back" }) }, { pose: pose("walk_a") }];
    expect(filterPoses(list, "sword", new Set()).map((p) => p.pose.name)).toEqual(["sword_guard", "sword_windup"]);
    expect(filterPoses(list, "pulled", new Set()).map((p) => p.pose.name)).toEqual(["sword_windup"]);
    expect(filterPoses(list, "", new Set(["guard"])).map((p) => p.pose.name)).toEqual(["sword_guard"]);
  });
});

describe("blend and mirror", () => {
  it("moves part of the way and keeps scale between", () => {
    const b = blendPoseCopy({ a: o(0) }, { a: { rotate: 40, translate: { x: 10, y: 0 }, scale: { x: 2, y: 2 } }, c: o(8) }, 0.25);
    expect(b.a).toEqual({ rotate: 10, translate: { x: 2.5, y: 0 }, scale: { x: 1.25, y: 1.25 } });
    expect(b.c!.rotate).toBe(2);
    expect(blendPoseCopy({}, { a: o(40) }, 1).a!.rotate).toBe(40);
    expect(blendPoseCopy({ a: o(5) }, { a: o(40) }, 0).a!.rotate).toBe(5);
  });

  it("swaps near and far and negates the axis bones", () => {
    const rig = makeMirrorRig([
      { name: "root", x: 0, y: 0, rotation: 0 },
      { name: "spine", parent: "root", x: 0, y: -50, rotation: 90 },
      { name: "arm_near", parent: "spine", x: 20, y: 0, rotation: 0 },
      { name: "arm_far", parent: "spine", x: -20, y: 0, rotation: 180 }
    ]);
    const m = mirrorPoseCopy(rig, { spine: o(10), arm_near: o(30) });
    expect(m.spine!.rotate).toBeCloseTo(-10, 6);
    expect(m.arm_far).toBeTruthy();
    expect(m.arm_near).toBeUndefined();
  });

  it("restricts to bones and hashes what the thumbnail shows", () => {
    expect(Object.keys(onlyBones({ a: o(1), b: o(2) }, ["b"]))).toEqual(["b"]);
    expect(poseHash(pose("p"))).not.toBe(poseHash(pose("p", { bones: { a: o(11) } })));
    expect(poseHash(pose("p"))).toBe(poseHash(pose("p")));
  });
});
