import { describe, expect, it } from "vitest";
import { BREAKDOWN_MAX, BREAKDOWN_MIN, BREAKDOWN_PRESETS, blend, breakdownBones, clampBreakdown, neighbourKeys } from "./breakdownModel.js";
import { emptyClip, setRotateKey, setVectorKey } from "./clipModel.js";

// 30 fps, 1 s: frame 0 and frame 30 keyed, the playhead at frame 15 (0.5 s)
const base = () => {
  let c = emptyClip(1, false);
  c = setRotateKey(setRotateKey(c, "arm", 0, 10), "arm", 1, 50);
  c = setVectorKey(setVectorKey(c, "arm", "translate", 0, 0, 10), "arm", "translate", 1, 40, -10);
  c = setVectorKey(setVectorKey(c, "arm", "scale", 0, 1, 1), "arm", "scale", 1, 2, 0.5);
  c = setVectorKey(setVectorKey(c, "arm", "shear", 0, 0, 0), "arm", "shear", 1, 20, -8);
  return c;
};
const rotAt = (c: ReturnType<typeof base>, t: number) => c.bones.arm!.rotate!.find((k) => Math.abs(k.time - t) < 1e-4)?.value;

describe("breakdown", () => {
  it("offers a -50..150 slider and the quick buttons 0, 25, 33, 50, 66, 75, 100", () => {
    expect([BREAKDOWN_MIN, BREAKDOWN_MAX]).toEqual([-50, 150]);
    expect(BREAKDOWN_PRESETS).toEqual([0, 25, 33, 50, 66, 75, 100]);
    expect(clampBreakdown(-80)).toBe(-50);
    expect(clampBreakdown(400)).toBe(150);
  });

  it("0 is the previous key, 100 the next key, between is linear, outside overshoots", () => {
    expect(blend(10, 50, 0)).toBe(10);
    expect(blend(10, 50, 100)).toBe(50);
    for (const [p, v] of [[0, 10], [25, 20], [50, 30], [100, 50], [-50, -10], [150, 70]] as const) {
      expect(rotAt(breakdownBones(base(), ["arm"], 0.5, p).clip, 0.5), `${p}%`).toBeCloseTo(v, 4);
    }
  });

  it("blends rotate, translate, scale and shear, each between its own neighbours", () => {
    const r = breakdownBones(base(), ["arm"], 0.5, 50);
    expect(r.keyed.arm).toEqual(["rotate", "translate", "scale", "shear"]);
    const tl = r.clip.bones.arm!;
    const at = <K extends { time: number }>(keys: K[]) => keys.find((k) => Math.abs(k.time - 0.5) < 1e-4)!;
    expect(at(tl.translate!)).toMatchObject({ x: 20, y: 0 });
    expect(at(tl.scale!)).toMatchObject({ x: 1.5, y: 0.75 });
    expect(at(tl.shear!)).toMatchObject({ x: 10, y: -4 });
    const over = breakdownBones(base(), ["arm"], 0.5, 150).clip.bones.arm!;
    expect(at(over.translate!)).toMatchObject({ x: 60, y: -20 });
  });

  it("uses each channel's own keys: a channel keyed at other times uses those", () => {
    let c = setRotateKey(setRotateKey(setRotateKey(emptyClip(1, false), "b", 0, 0), "b", 0.4, 100), "b", 1, 0);
    c = setVectorKey(setVectorKey(c, "b", "translate", 0.2, 0, 0), "b", "translate", 0.8, 60, 0);
    const r = breakdownBones(c, ["b"], 0.5, 50);
    expect(r.clip.bones.b!.rotate!.find((k) => Math.abs(k.time - 0.5) < 1e-4)!.value).toBeCloseTo(50, 4); // between the 0.4 (100) and 1.0 (0) keys
    expect(r.clip.bones.b!.translate!.find((k) => Math.abs(k.time - 0.5) < 1e-4)).toMatchObject({ x: 30 });
  });

  it("is repeatable: the key already on the playhead is not its own neighbour, so a second pass at another % replaces it", () => {
    const once = breakdownBones(base(), ["arm"], 0.5, 25).clip;
    const twice = breakdownBones(once, ["arm"], 0.5, 75).clip;
    expect(rotAt(twice, 0.5)).toBeCloseTo(40, 4);
    expect(twice.bones.arm!.rotate).toHaveLength(3);
    expect(neighbourKeys(once.bones.arm!.rotate, 0.5, false)?.prev.time).toBe(0);
  });

  it("skips bones with no key on one side, and says so", () => {
    const c = setRotateKey(emptyClip(1, false), "lonely", 0, 5);
    const r = breakdownBones(c, ["lonely", "ghost"], 0.5, 50);
    expect(r.skipped).toEqual(["lonely", "ghost"]);
    expect(r.keyed).toEqual({});
    expect(r.clip.bones.lonely!.rotate).toHaveLength(1);
  });

  it("wraps around a loop: before the first key the previous key is the last one", () => {
    let c = emptyClip(1, true);
    c = setRotateKey(setRotateKey(c, "arm", 0.2, 10), "arm", 0.8, 50);
    expect(breakdownBones(c, ["arm"], 0, 0).clip.bones.arm!.rotate![0]!.value).toBeCloseTo(50, 4);
    expect(breakdownBones(c, ["arm"], 0, 100).clip.bones.arm!.rotate![0]!.value).toBeCloseTo(10, 4);
    const oneShot = emptyClip(1, false);
    expect(breakdownBones(setRotateKey(setRotateKey(oneShot, "arm", 0.2, 10), "arm", 0.8, 50), ["arm"], 0, 50).skipped).toEqual(["arm"]);
  });

  it("keeps the curve of a key that is already there", () => {
    const c = base();
    c.bones.arm!.rotate!.push({ time: 0.5, value: 99, curve: "stepped" } as never);
    c.bones.arm!.rotate!.sort((a, b) => a.time - b.time);
    const r = breakdownBones(c, ["arm"], 0.5, 50).clip;
    expect(r.bones.arm!.rotate!.find((k) => Math.abs(k.time - 0.5) < 1e-4)).toMatchObject({ value: 30, curve: "stepped" });
  });
});
