import { describe, expect, it } from "vitest";
import { animateBoneLists, inAnimateList, isMoreBone, keyPoseBones, MAIN_BONES } from "./animateBones.js";

const RIG = ["root", "body", "pelvis", "spine_1", "chest", "head", "clavicle_near", "upper_arm_near", "forearm_near", "hand_near", "weapon", "weapon_grip2", "weapon_tip", "knee_near", "hip_near", "wrist_near", "lean", "foot_near_target", "foot_far_target", "hand_near_target", "hand_far_target", "thigh_near", "shin_near", "foot_near"];

describe("animate bone list", () => {
  it("lists body, lean, the 4 IK targets, weapon and head first", () => {
    const { main } = animateBoneLists(RIG);
    expect(main.map((b) => b.name)).toEqual(["body", "lean", "hand_near_target", "hand_far_target", "foot_near_target", "foot_far_target", "weapon", "head"]);
    expect(MAIN_BONES).toHaveLength(8);
  });
  it("puts clavicles and the FK chains under More and leaves helpers out", () => {
    const { main, more } = animateBoneLists(RIG);
    const all = [...main, ...more].map((b) => b.name);
    expect(more.map((b) => b.name)).toContain("clavicle_near");
    expect(more.map((b) => b.name)).toContain("forearm_near");
    for (const helper of ["root", "weapon_grip2", "weapon_tip", "knee_near", "hip_near", "wrist_near"]) expect(all).not.toContain(helper);
    expect(inAnimateList("weapon_tip")).toBe(false);
    expect(isMoreBone("thigh_near")).toBe(true);
    expect(isMoreBone("body")).toBe(false);
  });
  it("skips bones the rig lacks and gives each a colour", () => {
    const { main } = animateBoneLists(["body", "head"]);
    expect(main.map((b) => b.name)).toEqual(["body", "head"]);
    expect(main.every((b) => /^#[0-9a-f]{6}$/.test(b.color))).toBe(true);
  });
  it("keys the whole pose without the IK targets", () => {
    const names = keyPoseBones(RIG);
    expect(names).toContain("body");
    expect(names).toContain("weapon");
    expect(names.some((n) => n.endsWith("_target"))).toBe(false);
  });
});
