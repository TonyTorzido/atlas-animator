import { describe, expect, it } from "vitest";
import type { ClipData } from "@atlas-animator/core/core";
import { contactFrames, frameAtX, frameFraction, gameClipFor, keyFrames, neighbourKey } from "./animateBarModel.js";
import { emptyClip, setRotateKey } from "./clipModel.js";
import { setEvent } from "./eventModel.js";

const base = (): ClipData => emptyClip(1, false, 30);

describe("animate bar model", () => {
  it("collects key frames across bones and contact frames from hit events", () => {
    let c = setRotateKey(base(), "body", 0, 5);
    c = setRotateKey(c, "head", 10 / 30, 2);
    c = setRotateKey(c, "body", 20 / 30, 1);
    c = setEvent(c, 12 / 30, "hit");
    c = setEvent(c, 3 / 30, "windup");
    expect(keyFrames(c)).toEqual([0, 10, 20]);
    expect(contactFrames(c)).toEqual([12]);
  });
  it("finds the neighbouring key", () => {
    expect(neighbourKey([0, 10, 20], 10, 1)).toBe(20);
    expect(neighbourKey([0, 10, 20], 10, -1)).toBe(0);
    expect(neighbourKey([0, 10, 20], 20, 1)).toBeNull();
    expect(neighbourKey([0, 10, 20], 0, -1)).toBeNull();
  });
  it("maps a pointer to a clamped frame and back", () => {
    const c = base();
    expect(frameAtX(c, 0, 300)).toBe(0);
    expect(frameAtX(c, 150, 300)).toBe(15);
    expect(frameAtX(c, 999, 300)).toBe(30);
    expect(frameAtX(c, -5, 300)).toBe(0);
    expect(frameFraction(c, 15)).toBeCloseTo(0.5);
  });
  it("knows project clips by id and by legacy name", () => {
    expect(gameClipFor("idle")?.id).toBe("idle");
    expect(gameClipFor("idle_weight_shift")?.id).toBe("idle");
    expect(gameClipFor("my_scratch_clip")).toBeNull();
  });
});
