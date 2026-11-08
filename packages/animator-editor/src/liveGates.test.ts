import { describe, expect, it } from "vitest";
import { ikText, nextBadFrame } from "./liveGates.js";

describe("live gates", () => {
  it("finds the next failing frame, wrapping, in either direction", () => {
    expect(nextBadFrame([4, 9, 20], 9)).toBe(20);
    expect(nextBadFrame([4, 9, 20], 20)).toBe(4);
    expect(nextBadFrame([4, 9, 20], 9, -1)).toBe(4);
    expect(nextBadFrame([4, 9, 20], 4, -1)).toBe(20);
    expect(nextBadFrame([], 3)).toBeNull();
  });
  it("words the IK reach in plain English", () => {
    expect(ikText("hand_ik_near", 1.2)).toMatch(/hand near: target out of reach/);
    expect(ikText("leg_ik_far", 0.998)).toMatch(/full stretch/);
    expect(ikText("leg_ik_far", 0.98)).toMatch(/nearly straight/);
  });
});
