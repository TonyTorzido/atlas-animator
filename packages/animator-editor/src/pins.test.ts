import { readFileSync } from "node:fs";
import { clipSchema, loadAnimDocument, type AnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { emptyClip, frameTime, setRotateKey, setVectorKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { makeSampler } from "./motionPath.js";
import { defaultPinRange, endAt, holdGrip, pinClip, pinDrift, pinSlots, pinsOf, unpinClip } from "./pins.js";

const load = (id: string): AnimDocument => loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${ALL_OUTFITS.find((o) => o.id === id)!.document}`, import.meta.url), "utf8")));
const doc = load("pro-front");
const slots = pinSlots(doc);
const slot = (ik: string) => slots.find((s) => s.ik === ik)!;

/**
 * The whole figure steps `dx` px along the ground and the body dips 2 px. The arms of the pro rig stand almost fully stretched, so a
 * pinned hand can only follow a move that does not pull the shoulder away from it: `dx` goes toward the hand's side.
 */
function lunge(dx = -8) {
  let c = emptyClip(1);
  c = setVectorKey(c, "root", "translate", frameTime(c, 0), 0, 0);
  c = setVectorKey(c, "root", "translate", frameTime(c, 16), dx, 0);
  c = setVectorKey(c, "body", "translate", frameTime(c, 0), 0, 0);
  c = setVectorKey(c, "body", "translate", frameTime(c, 16), 0, 2);
  return c;
}
const dxFor = (ik: string) => (ik.includes("far") ? 8 : -8);

describe("pin slots", () => {
  it("finds the hands, feet and the weapon grip hold in the pro rig", () => {
    expect(slots.map((s) => [s.ik, s.kind, s.end]).sort()).toEqual(
      [
        ["trail_grip", "grip", "weapon_grip2_wrist"],
        ["leg_ik_near", "foot", "foot_near"],
        ["leg_ik_far", "foot", "foot_far"],
        ["hand_ik_near", "hand", "hand_near"],
        ["hand_ik_far", "hand", "hand_far"]
      ].sort()
    );
  });
});

describe("pinning a hand or foot", () => {
  for (const ik of ["hand_ik_near", "hand_ik_far", "leg_ik_near", "leg_ik_far"]) {
    it(`${ik}: the end moves without a pin and stays within 0.5 px with one`, () => {
      const s = slot(ik);
      const clip = lunge(dxFor(ik));
      const free = pinDrift(doc, "lunge", clip, s, 2, 14);
      const pinned = pinClip(doc, "lunge", clip, s, 2, 14);
      const drift = pinDrift(doc, "lunge", pinned, s, 2, 14);
      expect(free).toBeGreaterThan(3);
      expect(drift).toBeLessThan(0.5);
      expect(clipSchema.safeParse(pinned).success).toBe(true);
    });
  }

  it("keeps the spot where the end stood on the first frame", () => {
    const s = slot("hand_ik_near");
    const clip = lunge();
    const before = endAt(doc, "lunge", clip, s, 4)!;
    const after = endAt(doc, "lunge", pinClip(doc, "lunge", clip, s, 4, 12), s, 12)!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.5);
  });

  it("writes clean edge keys: mix 0, 1 ... 1, 0 and target keys at the range ends", () => {
    const pinned = pinClip(doc, "lunge", lunge(), slot("hand_ik_near"), 4, 12);
    const mix = (pinned.ik.hand_ik_near as unknown as { time: number; mix: number }[]).map((k) => [Math.round(k.time * 30), k.mix]);
    expect(mix).toEqual([[3, 0], [4, 1], [12, 1], [13, 0]]);
    const tl = pinned.bones.hand_near_target!.translate!.map((k) => Math.round(k.time * 30));
    expect(tl[0]).toBe(4);
    expect(tl[tl.length - 1]).toBe(12);
  });

  it("lists its pins and unpin gives the FK keys back", () => {
    const s = slot("hand_ik_near");
    const clip = lunge();
    const pinned = pinClip(doc, "lunge", clip, s, 4, 12);
    expect(pinsOf(doc, pinned).map((p) => [p.slot.ik, p.a, p.b])).toEqual([["hand_ik_near", 4, 12]]);
    const open = unpinClip(pinned, s, 4, 12);
    expect(pinsOf(doc, open)).toEqual([]);
    expect(open.ik).toEqual({});
    expect(open.bones.hand_near_target).toBeUndefined();
    const a = makeSampler(doc, "lunge", clip).poseFrame(8).findBone("hand_near")!.world;
    const b = makeSampler(doc, "lunge", open).poseFrame(8).findBone("hand_near")!.world;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
  });

  it("rejects a backwards range", () => {
    expect(() => pinClip(doc, "lunge", lunge(), slot("hand_ik_near"), 9, 3)).toThrow(/ends before/);
  });
});

describe("weapon grip hold", () => {
  it("turns the far-hand grip constraint on over the range and keeps the far hand on the haft while the weapon swings", () => {
    // Bring the grip helper within reach of the far hand, then swing the weapon 15 degrees.
    const sk0 = makeSampler(doc, "lunge", emptyClip(1)).poseFrame(0);
    const weapon = sk0.findBone("weapon")!;
    const wrist = sk0.findBone("weapon_grip2_wrist")!.world;
    const local = { x: 0, y: 0 };
    weapon.worldToParent(weapon.world.x + (60 - wrist.x), weapon.world.y + (-110 - wrist.y), local);
    let clip = lunge(8);
    clip = setVectorKey(clip, "weapon", "translate", frameTime(clip, 0), local.x - weapon.data.x, local.y - weapon.data.y);
    clip = setRotateKey(clip, "weapon", frameTime(clip, 0), 0);
    clip = setRotateKey(clip, "weapon", frameTime(clip, 16), 15);
    const s = slot("trail_grip");
    const held = pinClip(doc, "lunge", clip, s, 2, 14);
    const mix = (held.ik.trail_grip as unknown as { time: number; mix: number }[]).map((k) => [Math.round(k.time * 30), k.mix]);
    expect(mix).toEqual([[1, 0], [2, 1], [14, 1], [15, 0]]);
    expect(held.bones.weapon_grip2_wrist).toBeUndefined();
    const sampler = makeSampler(doc, "lunge", held);
    for (const f of [2, 8, 14]) {
      const sk = sampler.poseFrame(f);
      const hand = sk.findBone("hand_far")!.world;
      const grip = sk.findBone("weapon_grip2_wrist")!.world;
      expect(Math.hypot(hand.x - grip.x, hand.y - grip.y)).toBeLessThan(0.5);
    }
    expect(pinsOf(doc, held).map((p) => p.slot.kind)).toEqual(["grip"]);
    expect(unpinClip(held, s, 2, 14).ik).toEqual({});
  });
  it("keeps existing mix keys outside the range", () => {
    const c = holdGrip(holdGrip(lunge(), "trail_grip", 2, 5), "trail_grip", 10, 14);
    expect(pinsOf(doc, c).map((p) => [p.a, p.b])).toEqual([[2, 5], [10, 14]]);
  });
});

describe("default range", () => {
  it("starts at the playhead for eight frames, inside the clip", () => {
    expect(defaultPinRange(emptyClip(1), 4)).toEqual({ a: 4, b: 12 });
    expect(defaultPinRange(emptyClip(1), 28)).toEqual({ a: 28, b: 30 });
  });
});
