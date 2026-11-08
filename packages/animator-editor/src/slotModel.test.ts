import { readFileSync } from "node:fs";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { clipJson, parseClip, writeClip } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { clipGates } from "./gates.js";
import { attachmentAt, attachmentKeyAt, deleteAttachmentKey, deleteDrawOrderKey, drawOrderAt, setAttachmentKey, setDrawOrderOffset } from "./slotModel.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));
const base = () => parseClip({ duration: 1, loop: false, fps: 30 });

describe("attachment swaps", () => {
  it("keys a swap, replaces it at the same frame, and holds until the next key", () => {
    let clip = setAttachmentKey(base(), "eyes", 0, "eyes");
    clip = setAttachmentKey(clip, "eyes", 10 / 30, "eyes_blink_closed");
    clip = setAttachmentKey(clip, "eyes", 10 / 30, "eyes_blink_half");
    expect(clip.slots.eyes!.attachment).toEqual([
      { time: 0, name: "eyes" },
      { time: 10 / 30, name: "eyes_blink_half" }
    ]);
    expect(attachmentAt(clip, "eyes", 0.2)).toBe("eyes");
    expect(attachmentAt(clip, "eyes", 0.5)).toBe("eyes_blink_half");
    expect(attachmentKeyAt(clip, "eyes", 0.33333)?.name).toBe("eyes_blink_half");
  });
  it("hides a slot with null and deleting the last key removes the slot entry", () => {
    const hidden = setAttachmentKey(base(), "hair", 0, null);
    expect(attachmentAt(hidden, "hair", 0.5)).toBeNull();
    expect(deleteAttachmentKey(hidden, "hair", 0).slots).toEqual({});
  });
  it("round trips through the writer and passes the clip gates on the player rig", () => {
    const clip = setAttachmentKey(setAttachmentKey(base(), "eyes", 0, "eyes"), "eyes", 0.2, "eyes_blink_closed");
    expect(parseClip(writeClip(clip))).toEqual(clip);
    expect(clipJson(clip)).toContain("eyes_blink_closed");
    expect(clipGates(doc, "t", clip).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("draw order keys", () => {
  it("keys an offset, holds earlier moves in later keys, and 0 clears a slot", () => {
    let clip = setDrawOrderOffset(base(), 0, "hair", -2);
    clip = setDrawOrderOffset(clip, 0.2, "tank", 1);
    expect(drawOrderAt(clip, 0.1)).toEqual([{ slot: "hair", offset: -2 }]);
    expect(drawOrderAt(clip, 0.5)).toEqual([{ slot: "hair", offset: -2 }, { slot: "tank", offset: 1 }]);
    clip = setDrawOrderOffset(clip, 0.2, "hair", 0);
    expect(drawOrderAt(clip, 0.5)).toEqual([{ slot: "tank", offset: 1 }]);
    expect(deleteDrawOrderKey(clip, 0.2).drawOrder).toHaveLength(1);
  });
  it("is valid on the player rig", () => {
    const clip = setDrawOrderOffset(base(), 0.2, "tank", 1);
    expect(parseClip(writeClip(clip))).toEqual(clip);
    expect(clipGates(doc, "t", clip).filter((i) => i.severity === "error")).toEqual([]);
  });
});
