import { describe, expect, it } from "vitest";
import { dragScale, levels, newRef, normalizeRef, parseRef, parseRefStore, refFrameIndex, refTimeAt, sequenceOrder, videoSeekTime } from "./refModel.js";

describe("reference timing", () => {
  it("holds the first frame before the offset and scales time by speed", () => {
    const m = { offsetFrames: 15, speed: 2 };
    expect(refTimeAt(m, 0, 30)).toBe(0);
    expect(refTimeAt(m, 0.5, 30)).toBe(0);
    expect(refTimeAt(m, 1, 30)).toBeCloseTo(1, 6);
    expect(refTimeAt({ offsetFrames: -30, speed: 1 }, 0, 30)).toBeCloseTo(1, 6);
  });

  it("picks the exact source frame and seeks to its middle", () => {
    expect(refFrameIndex(0.1, 30)).toBe(3);
    expect(refFrameIndex(3 / 30, 30)).toBe(3);
    expect(refFrameIndex(99, 30, 10)).toBe(9);
    expect(videoSeekTime(3, 30, 2)).toBeCloseTo(3.5 / 30, 9);
    expect(videoSeekTime(9999, 30, 2)).toBeCloseTo(2 - 0.5 / 30, 9);
  });
});

describe("reference metadata", () => {
  it("clamps wild numbers and drops invalid records", () => {
    const m = normalizeRef({ ...newRef("video", "C:/a.mp4"), speed: 99, fps: 0, transform: { x: 1, y: 2, scale: -3, opacity: 4 } });
    expect(m.speed).toBe(8);
    expect(m.fps).toBe(1);
    expect(m.transform).toEqual({ x: 1, y: 2, scale: 0.05, opacity: 1 });
    expect(parseRef({ kind: "gif", path: "x" })).toBeNull();
    expect(parseRefStore({ good_clip: newRef("sequence", "C:/frames"), "bad clip": newRef("video", "C:/a.mp4"), x: 5 })).toEqual({ good_clip: newRef("sequence", "C:/frames") });
  });

  it("trace mode shows the reference fully and the rig at half", () => {
    expect(levels({ trace: true, transform: { x: 0, y: 0, scale: 1, opacity: 0.2 } })).toEqual({ reference: 1, rig: 0.5 });
    expect(levels({ trace: false, transform: { x: 0, y: 0, scale: 1, opacity: 0.2 } })).toEqual({ reference: 0.2, rig: 1 });
  });
});

describe("handles and sequences", () => {
  it("scales with the pointer's distance from the feet", () => {
    expect(dragScale(1, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 })).toBe(2);
    expect(dragScale(1, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 })).toBe(1);
  });
  it("sorts numbered frames naturally", () => {
    expect(["f10.png", "f2.png", "f1.png"].sort(sequenceOrder)).toEqual(["f1.png", "f2.png", "f10.png"]);
  });
});
