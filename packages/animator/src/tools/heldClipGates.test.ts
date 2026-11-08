import { describe, expect, it } from "vitest";
import { armFrontGate, armGroups, elbowInwardGate, faderGate, faderSlots, gripCurveGate, hitGate, inwardSigns, offsetsFor, phaseOrder } from "./heldClipGates.js";
import { applyDrawOrderOffsets } from "../core/drawOrder.js";

const bones = [
  { name: "root" }, { name: "chest", parent: "root" }, { name: "neck", parent: "chest" }, { name: "head", parent: "neck" },
  { name: "cl", parent: "chest" }, { name: "ua", parent: "cl" }, { name: "fa", parent: "ua" }, { name: "h", parent: "fa" }, { name: "grip", parent: "h" },
  { name: "cr", parent: "chest" }, { name: "uar", parent: "cr" }, { name: "far", parent: "uar" }, { name: "hr", parent: "far" }
];
const slots = [
  { name: "torso", bone: "chest" }, { name: "arm", bone: "ua" }, { name: "fore", bone: "fa" }, { name: "item", bone: "grip" }, { name: "fist", bone: "h" },
  { name: "arm_r", bone: "uar" }, { name: "fore_r", bone: "far" }, { name: "fist_r", bone: "hr" }, { name: "head", bone: "head" }
];
const free = slots.map((s) => s.name);

describe("held clip gates", () => {
  it("finds the holding arm and the other arm by bone chain", () => {
    const g = armGroups(bones, slots, "h");
    expect(g.armSlots).toEqual(["arm", "fore", "fist"]);
    expect(g.otherSlots).toEqual(["arm_r", "fore_r", "fist_r"]);
  });

  it("phase orders round-trip through draw-order offsets", () => {
    const g = armGroups(bones, slots, "h");
    for (const order of ["back", "front", "hand"] as const) {
      const want = phaseOrder(free, "item", order, { arm: g.armSlots, other: g.otherSlots });
      const offs = new Array(free.length).fill(0);
      for (const o of offsetsFor(free, want)) offs[free.indexOf(o.slot)] = o.offset;
      const out: number[] = [];
      applyDrawOrderOffsets(free.map((_, i) => i), offs, out, []);
      expect(out.map((i) => free[i])).toEqual(want);
    }
    const hand = phaseOrder(free, "item", "hand", { arm: g.armSlots, other: g.otherSlots });
    expect(hand.indexOf("item")).toBe(hand.indexOf("arm") - 1);
    expect(hand.indexOf("arm")).toBeGreaterThan(hand.indexOf("fist_r"));
  });

  it("grip curve: declared smooth keys pass; unkeyed spin, keyed jitter, drift, undeclared keys and too fast fail (controls)", () => {
    const fps = 30;
    const limits = { fps, maxDegPerSecond: 2700, minReversalGapFrames: 3 };
    // a swing-like curve keyed every frame f0-6, eased back by f12: one direction change (f3)
    const values = [0, -30, -70, -90, -80, -60, -45];
    const declared = [...values.map((v, f) => ({ time: f / fps, value: v })), { time: 12 / fps, value: 0 }];
    const turn = [...values, -36, -27, -18, -9, -4, 0];
    const clip = { clip: "slash", declared, keyed: declared, otherTimelines: false, turn, local: turn };
    const locked = { clip: "ready", declared: [], keyed: [], otherTimelines: false, turn: [0, 0, 0], local: [0, 0, 0] };
    expect(gripCurveGate([clip, locked], limits).ok).toBe(true);
    // unkeyed spin: the grip turns a full circle over the idle with no declared keys
    const spin = Array.from({ length: 13 }, (_, f) => (f * 360) / 12);
    expect(gripCurveGate([{ ...locked, keyed: [{ time: 0, value: 0 }, { time: 12 / fps, value: 360 }], turn: spin, local: spin }], limits).ok).toBe(false);
    // a grip turn in a clip with no keys at all (driven by something else) fails too
    expect(gripCurveGate([{ ...locked, turn: [0, 5, 0], local: [0, 5, 0] }], limits).ok).toBe(false);
    // keyed jitter: +-8 deg on alternate frames, declared and keyed alike
    const jitter = turn.map((v, f) => v + (f > 0 && f < 12 ? (f % 2 ? 8 : -8) : 0));
    const jitterKeys = jitter.map((v, f) => ({ time: f / fps, value: v }));
    expect(gripCurveGate([{ ...clip, declared: jitterKeys, keyed: jitterKeys, turn: jitter, local: jitter }], limits).ok).toBe(false);
    // drift: the world turn leaves the applied keys (e.g. the grip stopped inheriting the hand's rotation)
    expect(gripCurveGate([{ ...clip, turn: turn.map((v, f) => v + f * 0.5) }], limits).ok).toBe(false);
    // keys in the document that the clip file does not declare
    expect(gripCurveGate([{ ...clip, keyed: declared.map((k) => ({ ...k, value: k.value + 1 })) }], limits).ok).toBe(false);
    // faster than the limit
    expect(gripCurveGate([clip], { ...limits, maxDegPerSecond: 600 }).ok).toBe(false);
    // overshoot between two keys
    const over = [...turn];
    over[9] = 5;
    expect(gripCurveGate([{ ...clip, turn: over, local: over }], limits).ok).toBe(false);
  });

  it("arm front passes when the arm draws after the other arm and fails otherwise (control)", () => {
    const g = armGroups(bones, slots, "h");
    const front = phaseOrder(free, "item", "hand", { arm: g.armSlots, other: g.otherSlots });
    expect(armFrontGate([{ label: "f0", order: front }], g.armSlots, g.otherSlots).ok).toBe(true);
    expect(armFrontGate([{ label: "f0", order: free }], g.armSlots, g.otherSlots).ok).toBe(false);
  });

  it("hit gate needs one hit on the contact frame and a held pose (controls)", () => {
    const pose = (v: number) => Float64Array.from([v, 0, 0]);
    const frames = [pose(0), pose(1), pose(2), pose(2), pose(2), pose(3)];
    const good = { clip: "s", fps: 30, hit: { time: 2 / 30, holdFrames: 2 }, events: [{ time: 2 / 30, name: "hit" }], frames };
    expect(hitGate([good]).ok).toBe(true);
    expect(hitGate([{ ...good, events: [{ time: 3 / 30, name: "hit" }] }]).ok).toBe(false);
    expect(hitGate([{ ...good, events: [] }]).ok).toBe(false);
    expect(hitGate([{ ...good, frames: [pose(0), pose(1), pose(2), pose(2.5), pose(2), pose(3)] }]).ok).toBe(false);
  });

  it("elbow gate reads the inward side from the limit and fails an outward fold (control)", () => {
    const limits = [
      { name: "elbow_never_outward", x: "ua", y: "fa", polygon: [[-70, -85], [105, -85], [105, 70], [45, 70], [16, 10], [-70, 10]] },
      { name: "elbow_never_outward_r", x: "uar", y: "far", polygon: [[70, 85], [-105, 85], [-105, -70], [-45, -70], [-16, -10], [70, -10]] }
    ];
    const signs = inwardSigns(limits);
    expect(signs).toEqual([{ bone: "fa", sign: -1 }, { bone: "far", sign: 1 }]);
    expect(elbowInwardGate([{ label: "f0", pose: { fa: -30, far: 20 }, inside: true }], signs).ok).toBe(true);
    expect(elbowInwardGate([{ label: "f0", pose: { fa: 5 }, inside: true }], signs).ok).toBe(false);
    expect(elbowInwardGate([{ label: "f0", pose: {}, inside: false }], signs).ok).toBe(false);
  });

  it("faderGate: arm faders fully off or on pass; a half-faded cap fails (damaged control); no faders fails", () => {
    expect(faderSlots(["upper_arm_cap_front_fade", "upper_arm_cap_front_fade_r", "upper_arm", "hand"])).toEqual(["upper_arm_cap_front_fade", "upper_arm_cap_front_fade_r"]);
    const clean = [{ label: "f0", faders: { cap: 0, out: 1 } }, { label: "f1", faders: { cap: 1, out: 0.99 } }];
    expect(faderGate(clean).ok).toBe(true);
    expect(faderGate([...clean, { label: "f2", faders: { cap: 0.4, out: 1 } }]).ok).toBe(false);
    expect(faderGate([{ label: "f0", faders: {} }]).ok).toBe(false);
  });
});
