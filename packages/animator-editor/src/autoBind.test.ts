import { describe, expect, it } from "vitest";
import { autoBind, nearestBone, type BindBone } from "./autoBind.js";

const bones: BindBone[] = [
  { name: "root", ox: 0, oy: 0, tx: 0, ty: 0 },
  { name: "torso", ox: 0, oy: 0, tx: 0, ty: -100 },
  { name: "arm", ox: 0, oy: -90, tx: 80, ty: -90 },
  { name: "target", ox: 200, oy: 0, tx: 200, ty: 0, helper: true }
];

describe("auto-bind", () => {
  it("picks the bone segment closest to the image centre, never the root or a helper", () => {
    expect(nearestBone(5, -50, bones)).toBe("torso");
    expect(nearestBone(70, -85, bones)).toBe("arm");
    expect(nearestBone(200, 0, bones)).not.toBe("target");
    expect(nearestBone(0, 0, [bones[0]!])).toBe("root");
  });
  it("lists only the slots that change bone", () => {
    const r = autoBind([{ slot: "chest", cx: 0, cy: -40, bone: "root" }, { slot: "hand", cx: 75, cy: -90, bone: "arm" }], bones);
    expect(r).toEqual([{ slot: "chest", from: "root", to: "torso" }]);
  });
});
