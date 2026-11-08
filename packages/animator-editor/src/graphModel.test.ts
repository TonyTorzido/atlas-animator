import { readFileSync } from "node:fs";
import { AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip, setRotateKey, setVectorKey, writeClip } from "./clipModel.js";
import { keyCurveAt } from "./curveModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { channelKeys, dragHandle, frameBounds, gridStep, sampleChannel, segmentHandles, setChannelCurve, setChannelValue, toBezier, zoomBounds, type GraphKey } from "./graphModel.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));
const base = () => parseClip({ duration: 1, loop: false, fps: 30 });
const moveClip = () => setVectorKey(setVectorKey(base(), "pelvis", "translate", 0, 0, 0), "pelvis", "translate", 0.4, 10, 40);
const armClip = () => setRotateKey(setRotateKey(base(), "upper_arm_l", 0, 0), "upper_arm_l", 0.4, 80);
const EASE: [number, number, number, number] = [0.42, 0, 0.58, 1];

describe("graph channels", () => {
  it("reads the keys of one channel with its own curve", () => {
    const clip = setChannelCurve(moveClip(), "pelvis", "translateY", 0, EASE);
    expect(channelKeys(clip, "pelvis", "translateX")[0]).toEqual({ time: 0, value: 0, curve: "linear" });
    expect(channelKeys(clip, "pelvis", "translateY")[0]!.curve).toEqual(EASE);
    expect(channelKeys(clip, "pelvis", "translateY")[1]).toMatchObject({ time: 0.4, value: 40 });
    expect(channelKeys(clip, "pelvis", "scaleX")).toEqual([]);
  });
  it("splits a single-spec curve per channel and collapses it back", () => {
    let clip = setChannelCurve(moveClip(), "pelvis", "translateX", 0, "stepped");
    expect(clip.bones.pelvis!.translate![0]!.curve).toEqual({ x: "stepped", y: "linear" });
    clip = setChannelCurve(clip, "pelvis", "translateY", 0, "stepped");
    expect(clip.bones.pelvis!.translate![0]!.curve).toBe("stepped");
    clip = setChannelCurve(clip, "pelvis", "translateX", 0, "linear");
    expect(channelKeys(clip, "pelvis", "translateY")[0]!.curve).toBe("stepped");
    expect(channelKeys(clip, "pelvis", "translateX")[0]!.curve).toBe("linear");
  });
  it("keeps the other channel when one channel of a shared curve changes", () => {
    let clip = setChannelCurve(moveClip(), "pelvis", "translateX", 0, [...EASE]);
    clip = setChannelCurve(clip, "pelvis", "translateY", 0, [...EASE]);
    expect(clip.bones.pelvis!.translate![0]!.curve).toEqual(EASE);
    clip = setChannelCurve(clip, "pelvis", "translateY", 0, "linear");
    expect(clip.bones.pelvis!.translate![0]!.curve).toEqual({ x: EASE, y: "linear" });
  });
  it("a rotate key takes the spec directly", () => {
    const clip = setChannelCurve(armClip(), "upper_arm_l", "rotate", 0, "stepped");
    expect(clip.bones.upper_arm_l!.rotate![0]!.curve).toBe("stepped");
  });
  it("is backward compatible: old single-curve files read, and an untouched clip is unchanged", () => {
    const old = parseClip({ duration: 1, loop: false, fps: 30, bones: { pelvis: { translate: [{ time: 0, x: 0, y: 0, curve: EASE }, { time: 0.4, x: 10, y: 40 }] } } });
    expect(channelKeys(old, "pelvis", "translateX")[0]!.curve).toEqual(EASE);
    expect(channelKeys(old, "pelvis", "translateY")[0]!.curve).toEqual(EASE);
    expect(setChannelCurve(old, "pelvis", "translateX", 0, [...EASE])).toEqual(old);
    expect(keyCurveAt(old, { kind: "bone", name: "pelvis", time: 0 })).toEqual(EASE);
    expect(parseClip(writeClip(old))).toEqual(old);
  });
  it("round trips a per-channel curve through the writer and the format", () => {
    const clip = setChannelCurve(moveClip(), "pelvis", "translateY", 0, [0.1, 1.4, 0.7, 1]);
    const written = writeClip(clip);
    expect(JSON.stringify(written)).toContain('"y":[0.1,1.4,0.7,1]');
    expect(parseClip(written)).toEqual(clip);
  });
  it("the runtime eases each channel on its own curve", () => {
    const clip = setChannelCurve(moveClip(), "pelvis", "translateY", 0, "stepped");
    const d = { ...doc, animations: { c: clip } };
    const sk = new Skeleton(d);
    const st = new AnimationState(new AnimationStateData(d));
    st.setAnimation(0, "c", { loop: false });
    st.update(0.2);
    st.apply(sk);
    const pelvis = sk.findBone("pelvis")!;
    expect(pelvis.pose.x - pelvis.data.x).toBeCloseTo(5, 3);
    expect(pelvis.pose.y - pelvis.data.y).toBeCloseTo(0, 3);
  });
  it("sets a channel value without touching the other component", () => {
    const clip = setChannelValue(moveClip(), "pelvis", "translateY", 0.4, 55);
    expect(channelKeys(clip, "pelvis", "translateY")[1]!.value).toBe(55);
    expect(channelKeys(clip, "pelvis", "translateX")[1]!.value).toBe(10);
    const same = moveClip();
    expect(setChannelValue(same, "pelvis", "translateY", 0.7, 1)).toBe(same);
  });
});

describe("graph curves and handles", () => {
  it("samples linear, stepped and bezier segments", () => {
    const lin = channelKeys(armClip(), "upper_arm_l", "rotate");
    expect(sampleChannel(lin, 0.2)).toBeCloseTo(40, 6);
    expect(sampleChannel(lin, -1)).toBe(0);
    expect(sampleChannel(lin, 9)).toBe(80);
    const stepped = channelKeys(setChannelCurve(armClip(), "upper_arm_l", "rotate", 0, "stepped"), "upper_arm_l", "rotate");
    expect(sampleChannel(stepped, 0.39)).toBe(0);
    const ease = channelKeys(setChannelCurve(armClip(), "upper_arm_l", "rotate", 0, [0.42, 0, 1, 1]), "upper_arm_l", "rotate");
    expect(sampleChannel(ease, 0.1)!).toBeLessThan(20);
  });
  it("places handles in time and value space and drags them back to a bezier", () => {
    const keys = channelKeys(setChannelCurve(armClip(), "upper_arm_l", "rotate", 0, [0.25, 0.5, 0.75, 1.5]), "upper_arm_l", "rotate");
    const [a, b] = keys as [GraphKey, GraphKey];
    const hs = segmentHandles(a, b)!;
    expect(hs.h1.t).toBeCloseTo(0.1, 6);
    expect(hs.h1.v).toBeCloseTo(40, 6);
    expect(hs.h2.v).toBeCloseTo(120, 6);
    expect(dragHandle(a, b, 1, hs.h1)).toEqual([0.25, 0.5, 0.75, 1.5]);
    expect(dragHandle(a, b, 2, { t: 5, v: 160 })).toEqual([0.25, 0.5, 1, 2]);
    expect(dragHandle(a, b, 1, { t: -3, v: -40 })).toEqual([0, -0.5, 0.75, 1.5]);
    expect(segmentHandles({ ...a, curve: "linear" }, b)).toBeNull();
    expect(dragHandle({ ...a, curve: "stepped" }, b, 1, hs.h1)).toBeNull();
  });
  it("a linear key becomes a bezier that still runs the same line", () => {
    const [a, b] = channelKeys(armClip(), "upper_arm_l", "rotate") as [GraphKey, GraphKey];
    const sampled = sampleChannel([{ ...a, curve: toBezier("linear")! }, b], 0.3)!;
    expect(sampled).toBeCloseTo(60, 0);
  });
  it("keeps y when the handle of a flat segment moves", () => {
    const flat = setRotateKey(setRotateKey(base(), "upper_arm_l", 0, 10), "upper_arm_l", 0.4, 10);
    const [a, b] = channelKeys(setChannelCurve(flat, "upper_arm_l", "rotate", 0, [0.25, 0.2, 0.75, 0.8]), "upper_arm_l", "rotate") as [GraphKey, GraphKey];
    expect(dragHandle(a, b, 1, { t: 0.2, v: 99 })).toEqual([0.5, 0.2, 0.75, 0.8]);
  });
});

describe("graph view", () => {
  it("frames the clip in time and the curves (with overshoot) in value", () => {
    const over = setChannelCurve(armClip(), "upper_arm_l", "rotate", 0, [0.2, 1.6, 0.8, 1]);
    const b = frameBounds(over, [{ bone: "upper_arm_l", channel: "rotate" }]);
    expect(b.t0).toBe(0);
    expect(b.t1).toBe(1);
    expect(b.v1).toBeGreaterThan(90);
    expect(b.v0).toBeLessThan(0);
    const none = frameBounds(armClip(), []);
    expect(none.v0).toBeLessThan(none.v1);
  });
  it("zooms about a point and picks grid steps", () => {
    const z = zoomBounds({ t0: 0, t1: 10, v0: 0, v1: 100 }, { t: 0.5 }, { t: 0.5, v: 0.5 });
    expect(z).toEqual({ t0: 2.5, t1: 7.5, v0: 0, v1: 100 });
    expect(gridStep(100, 5)).toBe(20);
    expect(gridStep(1, 10)).toBe(0.1);
  });
});
