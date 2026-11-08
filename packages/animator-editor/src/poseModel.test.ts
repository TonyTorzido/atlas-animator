import { describe, expect, it } from "vitest";
import { clipSchema } from "@atlas-animator/core/core";
import { emptyClip, frameTime, setRotateKey } from "./clipModel.js";
import { applyPoseRecord, makePose, parsePose, poseSummary } from "./poseModel.js";
import { attachmentAt, drawOrderAt, setDrawOrderOffset } from "./slotModel.js";

const off = (rotate: number) => ({ rotate, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } });
const pose = makePose({
  name: "axe_overhead",
  bones: { upper_arm_r: off(-120), forearm_r: off(-60), chest: off(-8), hand_l: off(0) },
  attachments: { eyes: "eyes_blink_closed", hair: null },
  drawOrder: [{ slot: "hand", offset: -4 }]
});

describe("pose library", () => {
  it("round-trips through JSON and rejects malformed files", () => {
    expect(parsePose(JSON.parse(JSON.stringify(pose)))).toEqual(pose);
    expect(() => parsePose({ format: "other" })).toThrow(/atlas-pose/);
    expect(() => parsePose({ ...pose, bones: { x: { rotate: "a" } } })).toThrow(/malformed/);
    expect(() => makePose({ name: "bad name!", bones: {}, attachments: {}, drawOrder: [] })).toThrow(/pose names/);
  });
  it("keys bones, swaps and draw order into any clip at a frame", () => {
    const c = emptyClip(1);
    const r = applyPoseRecord(c, pose, frameTime(c, 6));
    expect(r.bones).toBe(4);
    expect(r.clip.bones.upper_arm_r!.rotate![0]).toMatchObject({ time: frameTime(c, 6), value: -120 });
    expect(attachmentAt(r.clip, "eyes", frameTime(c, 6))).toBe("eyes_blink_closed");
    expect(attachmentAt(r.clip, "hair", frameTime(c, 6))).toBeNull();
    expect(drawOrderAt(r.clip, frameTime(c, 6))).toEqual([{ slot: "hand", offset: -4 }]);
    expect(clipSchema.safeParse(r.clip).success).toBe(true);
    expect(c.bones.upper_arm_r).toBeUndefined();
  });
  it("applies parts separately and only to the picked bones", () => {
    const c = emptyClip(1);
    const bonesOnly = applyPoseRecord(c, pose, 0.2, { attachments: false, order: false, only: ["chest"] });
    expect(Object.keys(bonesOnly.clip.bones)).toEqual(["chest"]);
    expect(Object.keys(bonesOnly.clip.slots)).toEqual([]);
    expect(bonesOnly.clip.drawOrder).toEqual([]);
    const swapsOnly = applyPoseRecord(c, pose, 0.2, { bones: false, order: false });
    expect(Object.keys(swapsOnly.clip.bones)).toEqual([]);
    expect(swapsOnly.slots).toBe(2);
  });
  it("skips bones and slots the target rig lacks and says so", () => {
    const r = applyPoseRecord(emptyClip(1), pose, 0, { knownBones: new Set(["chest"]), knownSlots: new Set(["eyes", "hand"]) });
    expect(Object.keys(r.clip.bones)).toEqual(["chest"]);
    expect(r.skipped).toEqual(["bone upper_arm_r", "bone forearm_r", "bone hand_l", "slot hair"]);
  });
  it("an empty-order pose resets an earlier draw order key only when one is in force", () => {
    const plain = makePose({ name: "ready", bones: { chest: off(2) }, attachments: {}, drawOrder: [] });
    const clean = applyPoseRecord(emptyClip(1), plain, 0.3);
    expect(clean.order).toBe(false);
    expect(clean.clip.drawOrder).toEqual([]);
    let c = emptyClip(1);
    c = setRotateKey(c, "chest", 0, 0);
    c = setDrawOrderOffset(c, 0, "hair", -3);
    const reset = applyPoseRecord(c, plain, frameTime(c, 9));
    expect(reset.order).toBe(true);
    expect(drawOrderAt(reset.clip, frameTime(c, 9))).toEqual([]);
    expect(drawOrderAt(reset.clip, 0)).toEqual([{ slot: "hair", offset: -3 }]);
  });
  it("summarises a pose for the list", () => {
    expect(poseSummary(pose)).toBe("3 bones posed, 2 swaps, custom draw order");
  });
});

describe("built-in poses", () => {
  it("keep their read-only mark and rig through a parse (none ship with the editor)", () => {
    const p = parsePose({ ...makePose({ name: "user_pose", bones: { chest: off(3) }, attachments: {}, drawOrder: [], builtin: true, rig: "pro-front" }) });
    expect(p).toMatchObject({ builtin: true, rig: "pro-front" });
    expect(parsePose(makePose({ name: "plain", bones: {}, attachments: {}, drawOrder: [] })).builtin).toBeUndefined();
  });
});
