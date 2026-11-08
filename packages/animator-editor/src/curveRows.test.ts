import { describe, expect, it } from "vitest";
import type { ClipData } from "@atlas-animator/core/core";
import { applySegmentPreset, curveChannelsOf, curveRange, presetOf, SEG_PRESETS, segmentAt, segmentCurve, segmentPoints, segmentsOf, segmentsOfKeys } from "./curveRows.js";

const clip = (): ClipData =>
  ({
    name: "t",
    duration: 1,
    fps: 30,
    loop: false,
    bones: {
      arm: {
        rotate: [
          { time: 0, value: 0 },
          { time: 0.2, value: 40 },
          { time: 0.5, value: 10 }
        ],
        translate: [
          { time: 0, x: 0, y: 0 },
          { time: 0.5, x: 10, y: -4 }
        ]
      }
    },
    slots: {},
    ik: {},
    deform: {},
    drawOrder: [],
    events: []
  }) as unknown as ClipData;

describe("curve rows", () => {
  it("lists the curve channels a bone has", () => {
    expect(curveChannelsOf(clip(), "arm")).toEqual(["rotate", "translateX", "translateY"]);
    expect(curveChannelsOf(clip(), "none")).toEqual([]);
  });
  it("makes one segment per pair of keys and finds the one under a time", () => {
    expect(segmentsOf(clip(), "arm", "rotate").map((s) => s.ref.time)).toEqual([0, 0.2]);
    expect(segmentAt(clip(), "arm", "rotate", 0.3)?.ref.time).toBe(0.2);
    expect(segmentAt(clip(), "arm", "rotate", 0.9)).toBeNull();
  });
  it("sets a preset on one channel only and leaves the other component alone", () => {
    const ease = SEG_PRESETS.find((p) => p.id === "ease-in")!.spec;
    const next = applySegmentPreset(clip(), [{ bone: "arm", channel: "translateX", time: 0 }], ease);
    expect(presetOf(segmentCurve(next, { bone: "arm", channel: "translateX", time: 0 }))).toBe("ease-in");
    expect(presetOf(segmentCurve(next, { bone: "arm", channel: "translateY", time: 0 }))).toBe("linear");
    expect(clip().bones.arm!.rotate![0]).not.toHaveProperty("curve");
  });
  it("batch-applies to several segments in one clip", () => {
    const refs = segmentsOf(clip(), "arm", "rotate").map((s) => s.ref);
    const next = applySegmentPreset(clip(), refs, "stepped");
    expect(refs.every((r) => segmentCurve(next, r) === "stepped")).toBe(true);
  });
  it("picks the segments of the selected keys across channels", () => {
    expect(segmentsOfKeys(clip(), [{ row: "bone:arm", time: 0 }]).map((s) => s.channel)).toEqual(["rotate", "translateX", "translateY"]);
    expect(segmentsOfKeys(clip(), [{ row: "ik:x", time: 0 }])).toEqual([]);
  });
  it("includes overshoot in the range", () => {
    const bounce = applySegmentPreset(clip(), [{ bone: "arm", channel: "rotate", time: 0 }], SEG_PRESETS.find((p) => p.id === "bounce")!.spec);
    expect(curveRange(bounce, "arm", "rotate").hi).toBeGreaterThan(curveRange(clip(), "arm", "rotate").hi);
  });
  it("draws a stepped segment as a hold and a jump", () => {
    const seg = segmentsOf(clip(), "arm", "rotate")[0]!;
    expect(segmentPoints({ ...seg, a: { ...seg.a, curve: "stepped" } }, 8)).toHaveLength(3);
  });
});
