import { describe, expect, it } from "vitest";
import type { ClipData } from "@atlas-animator/core/core";
import { emptyClip } from "./clipModel.js";
import { HANDLE_PX, keyDotOffsets, onIkHandle, overlayHidden, worldSize } from "./overlayModel.js";
import { boneChannelTimes, boneKeyTypesAt, channelKeyType, clampView, fitView, frameToX, KEY_COLOR, KEY_TYPES, keyColorHex, labelStep, MIN_SPAN, panView, sliderToSpan, xToFrameFloat, zoomToSlider, zoomView } from "./timelineView.js";

function clipWith(): ClipData {
  const c = emptyClip();
  c.bones.arm = { rotate: [{ time: 0, value: 0 }, { time: 0.5, value: 10 }], translate: [{ time: 0.5, x: 1, y: 0 }], shear: [{ time: 1, x: 0, y: 5 }] } as ClipData["bones"][string];
  return c;
}

describe("timeline view", () => {
  it("fits the whole clip and clamps zoom and pan", () => {
    expect(fitView(30)).toEqual({ start: 0, span: 30 });
    expect(clampView({ start: 100, span: 200 }, 30)).toEqual({ start: 0, span: 30 });
    expect(clampView({ start: 25, span: 10 }, 30)).toEqual({ start: 20, span: 10 });
    expect(clampView({ start: 0, span: 1 }, 30).span).toBe(MIN_SPAN);
  });

  it("zooms about an anchor frame, which stays under the same x", () => {
    const v = { start: 0, span: 60 };
    const z = zoomView(v, 2, 30, 60);
    expect(z.span).toBe(30);
    expect(frameToX(z, 30, 0, 600)).toBeCloseTo(frameToX(v, 30, 0, 600), 6);
    expect(zoomView(v, 0.1, 30, 60)).toEqual({ start: 0, span: 60 });
    expect(zoomView(v, 1000, 30, 60).span).toBe(MIN_SPAN);
  });

  it("pans within the clip", () => {
    const v = { start: 10, span: 20 };
    expect(panView(v, 5, 60).start).toBe(15);
    expect(panView(v, -50, 60).start).toBe(0);
    expect(panView(v, 500, 60).start).toBe(40);
  });

  it("maps frames to x and back", () => {
    const v = { start: 10, span: 20 };
    expect(frameToX(v, 20, 100, 400)).toBe(300);
    expect(xToFrameFloat(v, 300, 100, 400)).toBe(20);
  });

  it("zoom slider round-trips and is 0 at fit", () => {
    expect(zoomToSlider(fitView(60), 60)).toBe(0);
    expect(sliderToSpan(0, 60)).toBeCloseTo(60);
    expect(sliderToSpan(1, 60)).toBeCloseTo(MIN_SPAN);
    const s = zoomToSlider({ start: 0, span: 15 }, 60);
    expect(sliderToSpan(s, 60)).toBeCloseTo(15, 6);
  });

  it("keeps ruler numbers at least minPx apart at every zoom", () => {
    for (const ppf of [0.2, 0.5, 1, 3, 8, 15, 40, 120]) {
      const s = labelStep(ppf);
      expect(s * ppf).toBeGreaterThanOrEqual(Math.min(42, 600 * ppf));
    }
    expect(labelStep(100)).toBe(1);
    expect(labelStep(1)).toBe(60);
  });

  it("colours each key type distinctly", () => {
    expect(new Set(KEY_TYPES.map((t) => KEY_COLOR[t])).size).toBe(KEY_TYPES.length);
    expect(keyColorHex("rotate")).toBe(0x5fb3ff);
    expect(channelKeyType("scale")).toBe("scaleShear");
    expect(channelKeyType("shear")).toBe("scaleShear");
  });

  it("lists the key types a bone has at a time, and per type over the clip", () => {
    const c = clipWith();
    expect(boneKeyTypesAt(c, "arm", 0.5)).toEqual(["rotate", "translate"]);
    expect(boneKeyTypesAt(c, "arm", 1)).toEqual(["scaleShear"]);
    expect(boneKeyTypesAt(c, "arm", 0.25)).toEqual([]);
    expect(boneKeyTypesAt(c, "nobody", 0)).toEqual([]);
    const g = boneChannelTimes(c, "arm");
    expect(g.map((x) => x.type)).toEqual(["rotate", "translate", "scaleShear"]);
    expect(g[0]!.times).toEqual([0, 0.5]);
  });
});

describe("overlay handles", () => {
  it("keeps handles a constant screen size at any zoom", () => {
    for (const z of [0.25, 1, 4]) expect(worldSize(HANDLE_PX.ikHalf, z) * z).toBeCloseTo(HANDLE_PX.ikHalf, 9);
    expect(onIkHandle(10, 0, 0, 0, 1)).toBe(true);
    expect(onIkHandle(30, 0, 0, 0, 1)).toBe(false);
    expect(onIkHandle(30, 0, 0, 0, 0.5)).toBe(true);
  });

  it("centres key dots above the bone", () => {
    expect(keyDotOffsets(0)).toEqual([]);
    const o = keyDotOffsets(3);
    expect(o.map((p) => p.dx)).toEqual([-HANDLE_PX.keyGap, 0, HANDLE_PX.keyGap]);
    expect(o.every((p) => p.dy < 0)).toBe(true);
  });

  it("hides helpers unless shown, but keeps live IK targets", () => {
    const helpers = new Set(["ik_hand", "ik_foot", "weapon_tip"]);
    const inert = new Set(["ik_foot", "weapon_tip"]);
    const live = new Set(["ik_hand"]);
    expect([...overlayHidden(helpers, inert, live, false)].sort()).toEqual(["ik_foot", "weapon_tip"]);
    expect([...overlayHidden(helpers, new Set(["weapon_tip"]), live, false)].sort()).toEqual(["ik_foot", "weapon_tip"]);
    expect([...overlayHidden(helpers, inert, live, true)]).toEqual([]);
    expect([...overlayHidden(helpers, new Set(), new Set(), true)]).toEqual([]);
  });
});
