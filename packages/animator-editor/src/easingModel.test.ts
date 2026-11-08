import { describe, expect, it } from "vitest";
import { clipSchema, type ClipData } from "@atlas-animator/core/core";
import { emptyClip, frameTime, setRotateKey } from "./clipModel.js";
import { bezierAt, keyCurveAt, type Bezier } from "./curveModel.js";
import { applyEasing, DAMPED_MIN_FRAMES, EASING_CURVES, overshootOf } from "./easingModel.js";

const arm = (frames: number[], values: number[], duration = 1): ClipData => {
  let c = emptyClip(duration);
  frames.forEach((f, i) => (c = setRotateKey(c, "upper_arm_r", frameTime(c, f), values[i]!)));
  return c;
};
const target = (clip: ClipData, f: number) => ({ kind: "bone" as const, name: "upper_arm_r", time: frameTime(clip, f) });

describe("easing presets", () => {
  it("anticipate holds longer than linear and strike gets there sooner", () => {
    const at = (spec: Bezier) => bezierAt(spec, 0.3);
    expect(at(EASING_CURVES.anticipate as Bezier)).toBeLessThan(0.1);
    expect(at(EASING_CURVES.strike as Bezier)).toBeGreaterThan(0.8);
  });
  it("overshoot passes the end by about 8% and only it", () => {
    expect(overshootOf(EASING_CURVES.overshoot)).toBeGreaterThan(0.06);
    expect(overshootOf(EASING_CURVES.overshoot)).toBeLessThan(0.1);
    expect(overshootOf(EASING_CURVES.strike)).toBe(0);
    expect(overshootOf("linear")).toBe(0);
  });
  it("sets the curve on the selected key and leaves the others", () => {
    const c = arm([0, 6, 12], [0, 40, 80]);
    const next = applyEasing(c, "strike", [target(c, 6)]);
    expect(keyCurveAt(next, target(c, 6))).toEqual(EASING_CURVES.strike);
    expect(keyCurveAt(next, target(c, 0))).toBe("linear");
    expect(c.bones.upper_arm_r!.rotate![1]!.curve).toBe("linear");
  });
  it("damped settle writes an overshoot and an undershoot key, then the original value", () => {
    const c = arm([0, 10], [0, 100]);
    const next = applyEasing(c, "damped", [target(c, 0)]);
    const keys = next.bones.upper_arm_r!.rotate!;
    expect(keys.map((k) => Math.round(k.time * 30))).toEqual([0, 5, 8, 10]);
    expect(keys[1]!.value).toBeCloseTo(110);
    expect(keys[2]!.value).toBeCloseTo(97);
    expect(keys[3]!.value).toBe(100);
    expect(clipSchema.safeParse(next).success).toBe(true);
  });
  it("damped on a span too short falls back to a small overshoot curve", () => {
    const c = arm([0, DAMPED_MIN_FRAMES - 1], [0, 50]);
    const next = applyEasing(c, "damped", [target(c, 0)]);
    expect(next.bones.upper_arm_r!.rotate).toHaveLength(2);
    expect(overshootOf(keyCurveAt(next, target(c, 0))!)).toBeGreaterThan(0.01);
  });
  it("damped skips a key with no next key or a short span", () => {
    const c = arm([0, 4, 10], [0, 30, 100]);
    const next = applyEasing(c, "damped", [target(c, 0)]);
    expect(next.bones.upper_arm_r!.rotate).toHaveLength(3);
    const end = applyEasing(c, "damped", [target(c, 10)]);
    expect(end.bones.upper_arm_r!.rotate).toHaveLength(3);
  });
});
