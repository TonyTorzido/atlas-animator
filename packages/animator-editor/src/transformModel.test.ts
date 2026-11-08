import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { ALL_OUTFITS } from "./fixtures.js";
import { axisFrame, clampField, formatField, keyState, rotateFromSpace, rotateToSpace, scrubValue, translateFromSpace, translateToSpace, wheelValue, worldAngleOf, wrapDeg, SPACES, type Space } from "./transformModel.js";

const load = (id: string, mirrorParent = false) => {
  const outfit = ALL_OUTFITS.find((o) => o.id === id)!;
  const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${outfit.document}`, import.meta.url), "utf8")));
  const sk = new Skeleton(doc);
  sk.limitsEnforced = false;
  sk.setToSetupPose();
  const arm = sk.findBone("upper_arm_near")!;
  arm.pose.rotation += 37;
  if (mirrorParent) sk.findBone("upper_arm_near")!.pose.scaleX = -1;
  sk.updateWorldTransform("reset");
  return sk;
};
const BONE = "forearm_near";
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

for (const mirror of [false, true]) {
  describe(`axis spaces (${mirror ? "mirrored" : "plain"} parent)`, () => {
    it("round-trips translate through every space", () => {
      const bone = load("pro-front", mirror).findBone(BONE)!;
      for (const space of SPACES) {
        const shown = translateToSpace(bone, space, { x: 7, y: -3 });
        const back = translateFromSpace(bone, space, shown);
        near(back.x, 7);
        near(back.y, -3);
      }
    });

    it("world translate moves the bone's origin by exactly that vector on screen", () => {
      for (const space of ["world", "local"] as Space[]) {
        const sk = load("pro-front", mirror);
        const bone = sk.findBone(BONE)!;
        const before = { x: bone.world.x, y: bone.world.y };
        const typed = { x: 10, y: 0 };
        const stored = translateFromSpace(bone, space, typed);
        bone.pose.x += stored.x;
        bone.pose.y += stored.y;
        sk.updateWorldTransform("reset");
        const dx = bone.world.x - before.x;
        const dy = bone.world.y - before.y;
        if (space === "world") {
          near(dx, 10);
          near(dy, 0);
        } else {
          const a = (worldAngleOf(bone) * Math.PI) / 180;
          near(dx, Math.cos(a) * 10);
          near(dy, Math.sin(a) * 10);
        }
      }
    });

    it("typing a world angle turns the bone to exactly that angle", () => {
      const sk = load("pro-front", mirror);
      const bone = sk.findBone(BONE)!;
      const offset = bone.pose.rotation - bone.data.rotation;
      const target = 25;
      const next = rotateFromSpace(bone, "world", target, offset);
      bone.pose.rotation = bone.data.rotation + next;
      sk.updateWorldTransform("reset");
      near(wrapDeg(worldAngleOf(bone)), target, 1e-4);
      near(rotateToSpace(bone, "world", next), target, 1e-4);
    });

    it("rotation is the stored offset in local and parent space", () => {
      const bone = load("pro-front", mirror).findBone(BONE)!;
      for (const space of ["local", "parent"] as Space[]) {
        expect(rotateToSpace(bone, space, 12.5)).toBe(12.5);
        expect(rotateFromSpace(bone, space, 12.5, 3)).toBe(12.5);
      }
    });
  });
}

describe("axis frames", () => {
  it("are orthonormal; world is the screen axes, parent is the parent's, local follows the bone", () => {
    const bone = load("pro-front").findBone(BONE)!;
    expect(axisFrame(bone, "world")).toEqual({ ux: [1, 0], uy: [0, 1] });
    for (const space of SPACES) {
      const f = axisFrame(bone, space);
      near(Math.hypot(...f.ux), 1);
      near(Math.hypot(...f.uy), 1);
    }
    const local = axisFrame(bone, "local");
    near(Math.atan2(local.ux[1], local.ux[0]), (worldAngleOf(bone) * Math.PI) / 180);
    const p = bone.parent!;
    const parent = axisFrame(bone, "parent");
    near(Math.atan2(parent.ux[1], parent.ux[0]), (worldAngleOf(p) * Math.PI) / 180);
  });

  it("falls back to the stored values under a collapsed parent", () => {
    const bone = { world: { a: 1, b: 0, c: 0, d: 1 }, parent: { world: { a: 0, b: 0, c: 0, d: 0 } } };
    expect(translateToSpace(bone, "world", { x: 4, y: 5 })).toEqual({ x: 4, y: 5 });
    expect(translateFromSpace(bone, "local", { x: 4, y: 5 })).toEqual({ x: 4, y: 5 });
  });
});

describe("field editing", () => {
  it("wheel and scrub step by channel, fine with Shift and coarse with Ctrl", () => {
    expect(wheelValue("rotate", 10, -100)).toBe(11);
    expect(wheelValue("rotate", 10, 100)).toBe(9);
    expect(wheelValue("rotate", 10, -100, { shift: true })).toBe(10.1);
    expect(wheelValue("translate", 0, -1, { ctrl: true })).toBe(10);
    expect(wheelValue("scale", 1, -1)).toBe(1.05);
    expect(scrubValue("rotate", 0, 20)).toBe(10);
    expect(scrubValue("scale", 1, 10, { shift: true })).toBeCloseTo(1.01, 6);
  });

  it("never lets scale reach zero", () => {
    expect(clampField("scale", 0)).toBe(0.001);
    expect(scrubValue("scale", 0.01, -1000)).toBe(0.001);
    expect(clampField("shear", -5)).toBe(-5);
  });

  it("formats with the channel's decimals", () => {
    expect(formatField("rotate", 1.005)).toMatch(/^1\.0[01]$/);
    expect(formatField("scale", 1)).toBe("1.000");
    expect(formatField("translate", -3.14159)).toBe("-3.1");
  });

  it("colours the key button: unkeyed edits are orange even over a key, a key here is red", () => {
    expect(keyState(true, false)).toBe("keyed");
    expect(keyState(true, true)).toBe("changed");
    expect(keyState(false, true)).toBe("changed");
    expect(keyState(false, false)).toBe("none");
  });
});
