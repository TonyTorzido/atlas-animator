import { readFileSync } from "node:fs";
import { AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip, setRotateKey, writeClip } from "./clipModel.js";
import { bezier, bezierAt, CURVE_PRESETS, curveKind, hasCurveKey, keyCurveAt, setCurves } from "./curveModel.js";
import { ALL_OUTFITS } from "./fixtures.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));
const twoKeys = () => setRotateKey(setRotateKey(parseClip({ duration: 1, loop: false, fps: 30 }), "upper_arm_l", 0, 0), "upper_arm_l", 12 / 30, 80);
const arm = (time: number) => ({ kind: "bone" as const, name: "upper_arm_l", time });

describe("key curves", () => {
  it("recognises the presets and any other bezier", () => {
    expect(curveKind("linear")).toBe("linear");
    expect(curveKind("stepped")).toBe("stepped");
    expect(curveKind(CURVE_PRESETS["ease-in"])).toBe("ease-in");
    expect(curveKind(CURVE_PRESETS["ease-out"])).toBe("ease-out");
    expect(curveKind(CURVE_PRESETS["ease-in-out"])).toBe("ease-in-out");
    expect(curveKind([0.1, 0.9, 0.2, 1])).toBe("bezier");
  });
  it("clamps bezier x to 0..1 and lets y overshoot", () => {
    expect(bezier(-1, -0.5, 2, 1.4)).toEqual([0, -0.5, 1, 1.4]);
  });
  it("sets a curve on the key (all channels) and reads it back", () => {
    const clip = setCurves(twoKeys(), [arm(0)], CURVE_PRESETS["ease-in"]);
    expect(keyCurveAt(clip, arm(0))).toEqual([0.42, 0, 1, 1]);
    expect(keyCurveAt(clip, arm(12 / 30))).toBe("linear");
    expect(hasCurveKey(clip, arm(5 / 30))).toBe(false);
  });
  it("round trips through the writer (linear omitted, others kept)", () => {
    const clip = setCurves(setCurves(twoKeys(), [arm(0)], "stepped"), [arm(12 / 30)], bezier(0.2, 1.3, 0.7, 1));
    expect(parseClip(writeClip(clip))).toEqual(clip);
    expect(JSON.stringify(writeClip(clip))).toContain("stepped");
  });
  it("the runtime follows the curve: ease-in is slower early than linear, stepped holds then jumps", () => {
    const at = (clip: ReturnType<typeof twoKeys>, t: number) => {
      const d = { ...doc, animations: { c: clip } };
      const sk = new Skeleton(d);
      const st = new AnimationState(new AnimationStateData(d));
      st.setAnimation(0, "c", { loop: false });
      st.update(t);
      st.apply(sk);
      return sk.findBone("upper_arm_l")!.pose.rotation - sk.findBone("upper_arm_l")!.data.rotation;
    };
    const linear = at(twoKeys(), 0.2);
    const easeIn = at(setCurves(twoKeys(), [arm(0)], CURVE_PRESETS["ease-in"]), 0.2);
    const stepped = at(setCurves(twoKeys(), [arm(0)], "stepped"), 0.2);
    expect(linear).toBeCloseTo(40, 1);
    expect(easeIn).toBeLessThan(linear - 5);
    expect(stepped).toBeCloseTo(0, 3);
    expect(at(setCurves(twoKeys(), [arm(0)], "stepped"), 0.4)).toBeCloseTo(80, 3);
  });
  it("bezierAt matches linear for the identity bezier and the ease-in preset is slow at first", () => {
    expect(bezierAt([0, 0, 1, 1], 0.5)).toBeCloseTo(0.5, 3);
    expect(bezierAt([0.42, 0, 1, 1], 0.25)).toBeLessThan(0.15);
  });
});
