import { describe, expect, it } from "vitest";
import { emptyClip, frameTime, parseClip, setRotateKey, setVectorKey, writeClip } from "./clipModel.js";
import { allKeys, boneChannelRow, boneKeySelected, rowBone, copyKeys, deleteSelectedKeys, isSelected, keysAtTime, keysInRange, moveKeys, pasteKeys, rowKeyTimes, scaleClipTiming, scaleKeys, selectKeys, type KeySel } from "./dopesheetModel.js";
import { setAttachmentKey, setDrawOrderOffset } from "./slotModel.js";

const f = (n: number) => frameTime({ fps: 30 }, n);
const arm = (frame: number): KeySel => ({ row: "bone:upper_arm_l", time: f(frame) });

/** A 1 s non-loop clip: arm keys at 0, 6, 12; head key at 6; an eyes swap at 6; a draw order key at 12. */
function sample() {
  let clip = emptyClip(1, false);
  for (const fr of [0, 6, 12]) clip = setRotateKey(clip, "upper_arm_l", f(fr), fr * 5);
  clip = setRotateKey(clip, "head", f(6), 3);
  clip = setAttachmentKey(clip, "eyes", f(6), "eyes_blink_closed");
  clip = setDrawOrderOffset(clip, f(12), "hair", -2);
  return clip;
}

describe("selection", () => {
  it("finds keys by time and range", () => {
    const clip = sample();
    expect(keysAtTime(clip, f(6)).map((k) => k.row).sort()).toEqual(["bone:head", "bone:upper_arm_l", "slot:eyes"]);
    expect(keysInRange(clip, f(5), f(7)).length).toBe(3);
    expect(keysInRange(clip, f(0), f(12), ["bone:upper_arm_l"]).length).toBe(3);
    expect(allKeys(clip).length).toBe(6);
  });
  it("replaces, adds and toggles", () => {
    const a = [arm(0)];
    expect(selectKeys(a, [arm(6)], "replace")).toEqual([arm(6)]);
    expect(selectKeys(a, [arm(6)], "add")).toEqual([arm(0), arm(6)]);
    expect(selectKeys([arm(0), arm(6)], [arm(6)], "toggle")).toEqual([arm(0)]);
    expect(isSelected([arm(6)], "bone:upper_arm_l", f(6))).toBe(true);
  });
});

describe("move", () => {
  it("moves selected keys together and keeps their values", () => {
    const clip = sample();
    const r = moveKeys(clip, [arm(6), arm(12)], -2);
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0, f(4), f(10)]);
    expect(r.clip.bones.upper_arm_l!.rotate!.map((k) => k.value)).toEqual([0, 30, 60]);
    expect(r.sel).toEqual([arm(4), arm(10)]);
    expect(rowKeyTimes(r.clip, "bone:head")).toEqual([f(6)]);
  });
  it("holds the group at the clip ends", () => {
    const r = moveKeys(sample(), [arm(6), arm(12)], 50);
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0, f(24), f(30)]);
    const back = moveKeys(sample(), [arm(0), arm(6)], -50);
    expect(rowKeyTimes(back.clip, "bone:upper_arm_l")).toEqual([0, f(6), f(12)]);
  });
  it("replaces a key it lands on and moves swap and draw order rows", () => {
    const r = moveKeys(sample(), [arm(0)], 6);
    expect(r.clip.bones.upper_arm_l!.rotate!.map((k) => [k.time, k.value])).toEqual([[f(6), 0], [f(12), 60]]);
    const swap = moveKeys(sample(), [{ row: "slot:eyes", time: f(6) }, { row: "draw", time: f(12) }], -3);
    expect(swap.clip.slots.eyes!.attachment![0]!.time).toBe(f(3));
    expect(swap.clip.drawOrder[0]!.time).toBe(f(9));
  });
  it("stays a valid clip after the writer", () => {
    const r = moveKeys(sample(), [arm(6)], 3);
    expect(parseClip(writeClip(r.clip))).toEqual(r.clip);
  });
});

describe("scale", () => {
  it("scales selected keys about the pivot frame", () => {
    const r = scaleKeys(sample(), [arm(6), arm(12)], 0.5, 0);
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0, f(3), f(6)]);
    const wide = scaleKeys(sample(), [arm(6), arm(12)], 2, 6);
    expect(rowKeyTimes(wide.clip, "bone:upper_arm_l")).toEqual([0, f(6), f(18)]);
  });
  it("merges keys that land on one frame (the later selected one wins, over an unselected key too)", () => {
    const r = scaleKeys(sample(), [arm(6), arm(12)], 0.01, 0);
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0]);
    expect(r.clip.bones.upper_arm_l!.rotate![0]!.value).toBe(60);
  });
  it("scales the whole clip, keys and duration", () => {
    const r = scaleClipTiming(sample(), 2);
    expect(r.duration).toBeCloseTo(2, 4);
    expect(rowKeyTimes(r, "bone:upper_arm_l")).toEqual([0, f(12), f(24)]);
    const half = scaleClipTiming(sample(), 0.5);
    expect(half.duration).toBeCloseTo(0.5, 4);
    expect(rowKeyTimes(half, "bone:upper_arm_l")).toEqual([0, f(3), f(6)]);
    expect(rowKeyTimes(half, "slot:eyes")).toEqual([f(3)]);
  });
});

describe("copy, paste, delete", () => {
  it("copies a key range and pastes it at the playhead, keeping relative timing", () => {
    const clip = sample();
    const board = copyKeys(clip, keysInRange(clip, f(0), f(6), ["bone:upper_arm_l", "bone:head", "slot:eyes"]))!;
    expect(board.entries.length).toBe(4);
    const r = pasteKeys(clip, board, f(18));
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0, f(6), f(12), f(18), f(24)]);
    expect(rowKeyTimes(r.clip, "bone:head")).toEqual([f(6), f(24)]);
    expect(r.clip.slots.eyes!.attachment!.map((k) => k.time)).toEqual([f(6), f(24)]);
    expect(r.sel.length).toBe(4);
  });
  it("drops pasted keys that fall past the end and replaces keys on the same frame", () => {
    const clip = sample();
    const board = copyKeys(clip, [arm(6), arm(12)])!;
    const r = pasteKeys(clip, board, f(26));
    expect(rowKeyTimes(r.clip, "bone:upper_arm_l")).toEqual([0, f(6), f(12), f(26)]);
    const over = pasteKeys(clip, copyKeys(clip, [arm(12)])!, f(0));
    expect(over.clip.bones.upper_arm_l!.rotate![0]!.value).toBe(60);
  });
  it("deletes selected keys and prunes empty rows", () => {
    const r = deleteSelectedKeys(sample(), [{ row: "bone:head", time: f(6) }, arm(0), { row: "draw", time: f(12) }]);
    expect(r.bones.head).toBeUndefined();
    expect(rowKeyTimes(r, "bone:upper_arm_l")).toEqual([f(6), f(12)]);
    expect(r.drawOrder).toEqual([]);
    expect(parseClip(writeClip(r))).toEqual(r);
  });
});

describe("per-property rows ()", () => {
  /** upper_arm_l keyed on rotate AND translate AND scale at frame 6. */
  function coincident() {
    let clip = sample();
    clip = setVectorKey(clip, "upper_arm_l", "translate", f(6), 4, 2);
    clip = setVectorKey(clip, "upper_arm_l", "scale", f(6), 1.2, 1.2);
    return clip;
  }
  it("moving a rotate key from its property row leaves the coincident move / scale keys where they were", () => {
    const clip = coincident();
    const moved = moveKeys(clip, [{ row: boneChannelRow("upper_arm_l", "rotate"), time: f(6) }], 3).clip;
    expect(moved.bones.upper_arm_l!.rotate!.map((k) => Math.round(k.time * 30))).toEqual([0, 9, 12]);
    expect(moved.bones.upper_arm_l!.translate!.map((k) => Math.round(k.time * 30))).toEqual([6]);
    expect(moved.bones.upper_arm_l!.scale!.map((k) => Math.round(k.time * 30))).toEqual([6]);
  });
  it("the bone summary row still moves every channel at that time", () => {
    const moved = moveKeys(coincident(), [arm(6)], 3).clip;
    expect(moved.bones.upper_arm_l!.translate!.map((k) => Math.round(k.time * 30))).toEqual([9]);
    expect(moved.bones.upper_arm_l!.scale!.map((k) => Math.round(k.time * 30))).toEqual([9]);
  });
  it("delete and copy / paste act on one property", () => {
    const clip = coincident();
    const row = boneChannelRow("upper_arm_l", "translate");
    const del = deleteSelectedKeys(clip, [{ row, time: f(6) }]);
    expect(del.bones.upper_arm_l!.translate).toBeUndefined();
    expect(del.bones.upper_arm_l!.rotate!.length).toBe(3);
    expect(del.bones.upper_arm_l!.scale!.length).toBe(1);
    const board = copyKeys(clip, [{ row, time: f(6) }])!;
    expect(board.entries.map((e) => e.channel)).toEqual(["translate"]);
    const pasted = pasteKeys(clip, board, f(20)).clip;
    expect(pasted.bones.upper_arm_l!.translate!.length).toBe(2);
    expect(pasted.bones.upper_arm_l!.rotate!.length).toBe(3);
    expect(rowKeyTimes(clip, boneChannelRow("upper_arm_l", "scaleShear")).map((t) => Math.round(t * 30))).toEqual([6]);
  });
  it("rowBone / boneKeySelected read both row forms", () => {
    expect(rowBone(boneChannelRow("head", "rotate"))).toBe("head");
    expect(rowBone("bone:head")).toBe("head");
    expect(boneKeySelected([{ row: boneChannelRow("head", "scaleShear"), time: f(6) }], "head", "shear", f(6))).toBe(true);
    expect(boneKeySelected([{ row: boneChannelRow("head", "rotate"), time: f(6) }], "head", "translate", f(6))).toBe(false);
  });
});
