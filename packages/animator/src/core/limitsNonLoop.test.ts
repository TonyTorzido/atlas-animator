import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

function worldRotationAt(loop: boolean): number {
  const doc = testDocument({
    bones: [{ name: "root" }, { name: "arm", parent: "root", rotation: 0, limits: { min: -20, max: 40 } }],
    animations: { swing: { duration: 1, loop, fps: 30, bones: { arm: { rotate: [{ time: 0, value: 120 }, { time: 1, value: 120 }] } } } }
  });
  const skeleton = new Skeleton(doc);
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, "swing");
  state.update(0.5);
  state.apply(skeleton);
  skeleton.updateWorldTransform("reset");
  return skeleton.getBone("arm").applied.rotation;
}

describe("bone limits and non-looping clips", () => {
  it("clamps a looping clip to the bone range", () => {
    expect(worldRotationAt(true)).toBeCloseTo(40, 3);
  });
  it("lifts the clamp while a non-looping clip is posed", () => {
    expect(worldRotationAt(false)).toBeCloseTo(120, 3);
  });
});
