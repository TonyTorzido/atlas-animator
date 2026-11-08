import { describe, expect, it } from "vitest";
import { boneColor, brighten, crumbChain, HELPER_GREY, wedgePolygon, wedgeWidth } from "./boneDraw.js";

describe("bone drawing model", () => {
  it("honours a bone's saved colour before the role colour ()", () => {
    expect(boneColor("body", false, "11aa22ff")).toBe(0x11aa22);
    expect(boneColor("body", false, "zz")).toBe(0xf0c24a);
    expect(boneColor("body", false, null)).toBe(0xf0c24a);
  });
  it("colours bones by the BONE-STANDARD", () => {
    expect(boneColor("body")).toBe(0xf0c24a);
    expect(boneColor("upper_arm_near")).toBe(0x5fd47a);
    expect(boneColor("forearm_far")).toBe(0xf29a3d);
    expect(boneColor("thigh_near")).toBe(0x4a9cf0);
    expect(boneColor("shin_far")).toBe(0xa37be8);
    expect(boneColor("hair_near_1")).toBe(0x3fd0d8);
    expect(boneColor("hand_near_target", true)).toBe(0xf06fb4);
    expect(boneColor("weapon")).toBe(0xee5a50);
    expect(boneColor("weapon_tip", true)).toBe(HELPER_GREY);
    expect(boneColor("mystery")).toBe(HELPER_GREY);
  });
  it("brightens toward white", () => {
    expect(brighten(0x000000, 1)).toBe(0xffffff);
    expect(brighten(0x102030, 0)).toBe(0x102030);
  });
  it("clamps the wedge width and scales it", () => {
    expect(wedgeWidth(2)).toBe(10);
    expect(wedgeWidth(1000)).toBe(24);
    expect(wedgeWidth(50, 2)).toBeCloseTo(28);
  });
  it("builds a kite from pivot to tip", () => {
    const p = wedgePolygon(0, 0, 100, 0, 20);
    expect(p.slice(0, 2)).toEqual([0, 0]);
    expect(p.slice(4, 6)).toEqual([100, 0]);
    expect(Math.abs(p[3]! - p[7]!)).toBeCloseTo(20);
  });
  it("lists the parent chain root first", () => {
    const parents: Record<string, string | null> = { a: null, b: "a", c: "b" };
    expect(crumbChain((n) => parents[n] ?? null, "c")).toEqual(["a", "b", "c"]);
  });
});
