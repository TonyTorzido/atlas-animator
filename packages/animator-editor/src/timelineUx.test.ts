import { describe, expect, it } from "vitest";
import type { ClipData } from "@atlas-animator/core/core";
import { snapDelta, clampTlHeight, historyStatus, historyTip, keyHoverText, parseTlHeight, stepLabel, tlMaxHeight, TL_MIN_H } from "./timelineUx.js";

const clip = { duration: 1, bones: { chest: { rotate: [{ time: 0.5, value: 8, curve: "linear" }] } }, ik: {}, slots: {}, events: [], loop: false } as unknown as ClipData;

describe("timeline height", () => {
  it("clamps between a sensible minimum and a viewport-based maximum", () => {
    expect(clampTlHeight(10, 1000)).toBe(TL_MIN_H);
    expect(clampTlHeight(5000, 1000)).toBe(tlMaxHeight(1000));
    expect(tlMaxHeight(768)).toBeLessThan(tlMaxHeight(1000));
    expect(clampTlHeight(220, 1000)).toBe(220);
    expect(clampTlHeight(NaN, 1000)).toBe(TL_MIN_H);
  });
  it("reads a stored height defensively", () => {
    expect(parseTlHeight(null)).toBeNull();
    expect(parseTlHeight("abc")).toBeNull();
    expect(parseTlHeight("240")).toBe(240);
  });
});

describe("history labels", () => {
  it("names the action in the tooltip and the status text", () => {
    expect(historyTip("Undo", "Moved 2 keys by 12 frames", "Ctrl+Z")).toBe("Undo: Moved 2 keys by 12 frames (Ctrl+Z)");
    expect(historyTip("Redo", undefined, "Ctrl+Y")).toBe("Redo the last change (Ctrl+Y)");
    expect(historyStatus("Undo", "Deleted 1 selected key")).toBe("Undid: Deleted 1 selected key");
    expect(stepLabel("  Keyed hips at frame 3. ")).toBe("Keyed hips at frame 3");
    expect(stepLabel(undefined)).toBeUndefined();
  });
});

describe("key hover text", () => {
  it("gives bone, frame, value and interpolation", () => {
    expect(keyHoverText(clip, { kind: "chan", name: "chest", type: "rotate" }, 0.5, 15)).toBe("chest rotate, frame 15, 8.0 deg, linear");
    expect(keyHoverText(clip, { kind: "event", name: "" }, 0.5, 15)).toBe("event, frame 15");
  });
});

describe("shift-drag snap", () => {
  it("lands a moved key on the nearest neighbour within the tolerance", () => {
    expect(snapDelta([10, 20], [31, 50], 10)).toEqual({ delta: 11, to: 31 });
    expect(snapDelta([10], [40], 5)).toBeNull();
    expect(snapDelta([10], [], 5)).toBeNull();
  });
});
