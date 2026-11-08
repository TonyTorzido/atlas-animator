import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData, BoneMask, MAX_MIX_CHAIN, MAX_TRACKS, type AnimationStateListener, type TrackEntry } from "./animationState.js";
import type { AnimDocumentInput } from "./format.js";
import { wrapDegrees } from "./math.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";
import type { AnimationEvent } from "./timelines.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;
type Clips = NonNullable<Sections["animations"]>;

const region = (path: string) => ({ type: "region" as const, path, width: 10, height: 10 });

/**
 * root -> hips (setup y -40, rotation -90, scale 1) -> chest -> arm; root -> leg.
 * Slots torso (hips) with anchored torso_cloth / torso_plate, arm, weapon (arm), leg.
 */
function rig(animations: Clips, extra: Partial<Sections> = {}) {
  return testDocument({
    bones: [
      { name: "root" },
      { name: "hips", parent: "root", y: -40, rotation: -90 },
      { name: "chest", parent: "hips", x: 30 },
      { name: "arm", parent: "chest", x: 20, rotation: 10 },
      { name: "leg", parent: "root", rotation: 90 }
    ],
    slots: [
      { name: "leg", bone: "leg", attachment: "leg" },
      { name: "torso", bone: "hips", attachment: "torso" },
      { name: "torso_cloth", bone: "hips", attachment: "cloth", drawAfter: "torso" },
      { name: "torso_plate", bone: "hips", attachment: "plate", drawAfter: "torso_cloth" },
      { name: "arm", bone: "arm", attachment: "arm" },
      { name: "weapon", bone: "arm", attachment: "sword" }
    ],
    skins: {
      body: {
        attachments: {
          leg: { leg: region("leg") },
          torso: {
            torso: {
              type: "mesh",
              path: "torso",
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              vertices: [-10, -10, 10, -10, 10, 10, -10, 10],
              hull: 4,
              width: 20,
              height: 20
            }
          },
          torso_cloth: { cloth: region("cloth") },
          torso_plate: { plate: region("plate") },
          arm: { arm: region("arm") },
          weapon: { sword: region("sword"), axe: region("axe") }
        }
      }
    },
    events: { hit: { int: 7, float: 0.5, string: "slash", audio: "swing" }, step: {} },
    ...extra,
    animations
  });
}

function setup(animations: Clips, extra: Partial<Sections> = {}) {
  const doc = rig(animations, extra);
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body"]);
  const data = new AnimationStateData(doc);
  const state = new AnimationState(data);
  /** update(dt) + apply. */
  const step = (dt: number) => {
    state.update(dt);
    state.apply(skeleton);
  };
  const pose = (bone: string) => skeleton.getBone(bone).pose;
  return { doc, skeleton, data, state, step, pose };
}

const rotate = (...keys: [number, number, ([number, number, number, number] | "stepped")?][]) =>
  keys.map(([time, value, curve]) => (curve ? { time, value, curve } : { time, value }));

describe("timelines and value rules", () => {
  it("rotate, translate and shear keys are offsets from setup; scale keys multiply it", () => {
    const { state, step, pose } = setup({
      pose: {
        duration: 1,
        bones: {
          hips: { rotate: rotate([0, 30]), translate: [{ time: 0, x: 5, y: -2 }], scale: [{ time: 0, x: 2, y: 0.5 }], shear: [{ time: 0, x: 4, y: 6 }] }
        }
      }
    });
    state.setAnimation(0, "pose");
    step(0);
    expect(pose("hips")).toEqual({ x: 5, y: -42, rotation: -60, scaleX: 2, scaleY: 0.5, shearX: 4, shearY: 6 });
  });

  it("interpolates linearly, holds before the first and after the last key", () => {
    const { state, step, pose } = setup({ swing: { duration: 2, bones: { arm: { rotate: rotate([0.5, 10], [1.5, 30]) } } } });
    state.setAnimation(0, "swing");
    const at = (t: number) => {
      step(t - state.getCurrent(0)!.trackTime);
      return pose("arm").rotation - 10;
    };
    expect(at(0.25)).toBeCloseTo(10, 12);
    expect(at(1)).toBeCloseTo(20, 12);
    expect(at(1.25)).toBeCloseTo(25, 12);
    expect(at(2)).toBeCloseTo(30, 12);
  });

  it("stepped keys hold their value until the next key", () => {
    const { state, step, pose } = setup({ snap: { duration: 1, bones: { arm: { rotate: rotate([0, 0, "stepped"], [0.5, 40, "stepped"], [1, 80]) } } } });
    state.setAnimation(0, "snap");
    for (const [t, expected] of [
      [0, 0],
      [0.2, 0],
      [0.4999, 0],
      [0.5, 40],
      [0.9999, 40],
      [1, 80]
    ] as const) {
      step(t - state.getCurrent(0)!.trackTime);
      expect(pose("arm").rotation - 10, `t=${t}`).toBeCloseTo(expected, 12);
    }
  });

  it("Bezier keys ease per channel; a symmetric curve is at the midpoint halfway", () => {
    const { state, step, pose } = setup({
      ease: {
        duration: 1,
        bones: { hips: { translate: [{ time: 0, x: 0, y: 0, curve: { x: [0.25, 0.1, 0.75, 0.9], y: "stepped" } }, { time: 1, x: 10, y: 10 }] } }
      }
    });
    state.setAnimation(0, "ease");
    step(0.5);
    expect(pose("hips").x).toBeCloseTo(5, 10);
    expect(pose("hips").y).toBe(-40);
    step(0.25);
    // Ease-in-out: behind linear in the first half's mirror, ahead of it here.
    expect(pose("hips").x).toBeGreaterThan(7.5);
  });

  it("slot colours, attachments, deform, draw order and constraint values are keyable", () => {
    const { state, step, skeleton } = setup(
      {
        all: {
          duration: 1,
          slots: { arm: { color: [{ time: 0, color: "ff000080" }, { time: 1, color: "0000ffff" }] }, weapon: { attachment: [{ time: 0.5, name: "axe" }] } },
          deform: { body: { torso: { torso: [{ time: 0, offset: 2, vertices: [4, 6] }] } } },
          drawOrder: [{ time: 0, offsets: [{ slot: "torso", offset: 2 }] }],
          ik: { reach: [{ time: 0, mix: 0.25, bendPositive: false }] },
          transform: { follow: [{ time: 0, mixRotate: 0.5 }] },
          physics: { sway: { mix: [{ time: 0, value: 0.2 }], reset: [{ time: 0.25 }] } }
        }
      },
      {
        ik: [{ name: "reach", bones: ["arm"], target: "leg", softness: 3 }],
        transform: [{ name: "follow", bones: ["arm"], target: "leg", mixX: 0.7 }],
        physics: [{ name: "sway", bone: "chest" }]
      }
    );
    state.setAnimation(0, "all");
    step(0.5);
    const color = skeleton.getSlot("arm").color;
    expect([color.r, color.g, color.b, color.a]).toEqual([0.5, 0, 0.5, expect.closeTo((0x80 / 255 + 1) / 2, 12)]);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    expect([...skeleton.animationDeformFor(skeleton.getSlot("torso").attachment as never)]).toEqual([0, 0, 4, 6, 0, 0, 0, 0]);
    expect(skeleton.physicsPoses[0]).toEqual({ mix: 0.2, resetRequested: true });
    skeleton.updateWorldTransform();
    expect(skeleton.drawOrder.map((slot) => slot.data.name)).toEqual(["leg", "arm", "weapon", "torso", "torso_cloth", "torso_plate"]);
    expect(skeleton.ikPoses[0]).toEqual({ mix: 0.25, softness: 3, bendPositive: false, stretch: false, compress: false });
    expect(skeleton.transformPoses[0]).toMatchObject({ mixRotate: 0.5, mixX: 0.7 });
    // The physics solver consumed the reset request.
    expect(skeleton.physicsPoses[0]).toEqual({ mix: 0.2, resetRequested: false });
  });

  it("before its first key an attachment or draw-order timeline leaves the setup value", () => {
    const { state, step, skeleton } = setup({
      late: { duration: 1, slots: { weapon: { attachment: [{ time: 0.5, name: "axe" }] } }, drawOrder: [{ time: 0.5, offsets: [{ slot: "leg", offset: 2 }] }] }
    });
    state.setAnimation(0, "late");
    step(0.25);
    skeleton.updateWorldTransform();
    expect(skeleton.getSlot("weapon").placeholder).toBe("sword");
    expect(skeleton.drawOrder[0]?.data.name).toBe("leg");
  });
});

describe("anchored slots under draw-order keys", () => {
  it("a key that moves the torso carries torso_cloth and torso_plate with it", () => {
    const { state, step, skeleton } = setup({ turn: { duration: 1, drawOrder: [{ time: 0, offsets: [{ slot: "torso", offset: 2 }] }] } });
    skeleton.updateWorldTransform();
    expect(skeleton.drawOrder.map((slot) => slot.data.name)).toEqual(["leg", "torso", "torso_cloth", "torso_plate", "arm", "weapon"]);
    state.setAnimation(0, "turn");
    step(0);
    skeleton.updateWorldTransform();
    expect(skeleton.drawOrder.map((slot) => slot.data.name)).toEqual(["leg", "arm", "weapon", "torso", "torso_cloth", "torso_plate"]);
  });
});

describe("mixing", () => {
  const clips: Clips = {
    a: { duration: 1, loop: true, bones: { arm: { rotate: rotate([0, 170]) }, hips: { translate: [{ time: 0, x: 10, y: 0 }] } } },
    b: { duration: 1, loop: true, bones: { arm: { rotate: rotate([0, -170]) }, leg: { rotate: rotate([0, 40]) } } },
    reach: { duration: 1, bones: { arm: { rotate: rotate([0, 50]) }, leg: { rotate: rotate([0, -30]) } } },
    flinch: { duration: 1, bones: { arm: { rotate: rotate([0, 20]) }, hips: { scale: [{ time: 0, x: 0.5, y: 1 }] } } }
  };

  it("alpha blends a track from the setup pose", () => {
    const { state, step, pose } = setup(clips);
    state.setAnimation(0, "reach", { alpha: 0.5 });
    step(0);
    expect(pose("arm").rotation).toBeCloseTo(10 + 25, 12);
    expect(pose("leg").rotation).toBeCloseTo(90 - 15, 12);
  });

  it("crossfade at mix 0.5 of 170 and -170 degrees is the midpoint the short way, across 180", () => {
    const { state, step, pose } = setup(clips);
    state.setAnimation(0, "a");
    step(0);
    state.setAnimation(0, "b", { mix: 1 });
    step(0.5);
    // setup 10: a = 180, b = -160; the short way from 180 to -160 (= 200) passes 190.
    expect(wrapDegrees(pose("arm").rotation)).toBeCloseTo(-170, 10);
    expect(Math.abs(pose("arm").rotation - 180)).toBeLessThan(20);
    // Only a keys hips translate: it fades back to setup. Only b keys the leg: it fades in.
    expect(pose("hips").x).toBeCloseTo(5, 12);
    expect(pose("leg").rotation).toBeCloseTo(90 + 20, 12);
  });

  it("weights follow the mix linearly and the old entry ends once the mix is done", () => {
    const { state, step, pose } = setup(clips);
    const ended: string[] = [];
    state.addListener({ end: (entry) => ended.push(entry.clip.name) });
    state.setAnimation(0, "reach");
    step(0);
    state.setAnimation(0, "a", { mix: 0.4 });
    for (const [t, m] of [
      [0.1, 0.25],
      [0.1, 0.5],
      [0.1, 0.75]
    ] as const) {
      step(t);
      expect(pose("leg").rotation, `m=${m}`).toBeCloseTo(90 - 30 * (1 - m), 10);
    }
    step(0.1);
    expect(pose("leg").rotation).toBeCloseTo(90, 12);
    expect(ended).toEqual([]);
    step(0.1);
    expect(ended).toEqual(["reach"]);
    expect(state.getCurrent(0)?.mixingFrom).toBeNull();
  });

  it("an add track adds its offset times alpha (scale multiplies)", () => {
    const { state, step, pose } = setup(clips);
    state.setAnimation(0, "reach");
    state.setAnimation(2, "flinch", { blend: "add", alpha: 0.5 });
    step(0);
    expect(pose("arm").rotation).toBeCloseTo(10 + 50 + 10, 12);
    expect(pose("hips").scaleX).toBeCloseTo(1 * (1 + (0.5 - 1) * 0.5), 12);
    expect(pose("leg").rotation).toBeCloseTo(60, 12);
  });

  it("a replace track at alpha blends over the tracks below it", () => {
    const { state, step, pose } = setup(clips);
    state.setAnimation(0, "reach");
    state.setAnimation(1, "flinch", { alpha: 0.25 });
    step(0);
    expect(pose("arm").rotation).toBeCloseTo(60 + (30 - 60) * 0.25, 12);
  });

  it("holdPrevious keeps the old clip's values under the new one while mixing", () => {
    const run = (holdPrevious: boolean) => {
      const { state, step, pose } = setup(clips);
      state.setAnimation(0, "a");
      step(0);
      state.setAnimation(0, "reach", { mix: 1, holdPrevious });
      step(0.5);
      return { hips: pose("hips").x, leg: pose("leg").rotation };
    };
    // hips: only `a` keys it. Without hold it fades to setup (0) halfway; with hold it stays.
    expect(run(false).hips).toBeCloseTo(5, 12);
    expect(run(true).hips).toBeCloseTo(10, 12);
    // leg: only `reach` keys it; it fades in either way.
    expect(run(true).leg).toBeCloseTo(90 - 15, 12);
  });

  it("a bone mask keeps a track off the bones outside it (and their slots)", () => {
    const { doc, state, step, pose, skeleton } = setup({
      ...clips,
      wave: {
        duration: 1,
        bones: { arm: { rotate: rotate([0, 45]) }, leg: { rotate: rotate([0, 45]) } },
        slots: { leg: { color: [{ time: 0, color: "00000000" }] }, weapon: { attachment: [{ time: 0, name: "axe" }] } }
      }
    });
    state.setTrackMask(1, BoneMask.of(doc, ["chest"]));
    state.setAnimation(0, "reach");
    state.setAnimation(1, "wave");
    step(0);
    expect(pose("arm").rotation).toBeCloseTo(55, 12);
    expect(pose("leg").rotation).toBeCloseTo(60, 12);
    expect(skeleton.getSlot("leg").color.a).toBe(1);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    const mask = BoneMask.of(doc, ["chest"]);
    expect([...mask.bones]).toEqual([0, 0, 1, 1, 0]);
    expect([...BoneMask.of(doc, ["chest"], { descendants: false }).bones]).toEqual([0, 0, 1, 0, 0]);
    expect([...mask.inverted().bones]).toEqual([1, 1, 0, 0, 1]);
  });

  it("fades an add track out with an empty animation and then clears it", () => {
    const { state, step, pose } = setup(clips);
    state.setAnimation(0, "reach");
    state.setAnimation(2, "flinch", { blend: "add" });
    step(0);
    state.setEmptyAnimation(2, 0.2);
    step(0.1);
    expect(pose("arm").rotation).toBeCloseTo(60 + 10, 10);
    step(0.1);
    expect(pose("arm").rotation).toBeCloseTo(60, 12);
    step(0.01);
    step(0.01);
    expect(state.getCurrent(2)).toBeNull();
  });

  it("an interrupted mix nests: A -> B -> C keeps each mix advancing", () => {
    const { state, step, pose } = setup({
      p: { duration: 1, bones: { leg: { rotate: rotate([0, 0]) } } },
      q: { duration: 1, bones: { leg: { rotate: rotate([0, 40]) } } },
      r: { duration: 1, bones: { leg: { rotate: rotate([0, 80]) } } }
    });
    state.setAnimation(0, "p");
    step(0);
    state.setAnimation(0, "q", { mix: 1 });
    step(0.5); // q at 0.5 over p: 20
    expect(pose("leg").rotation - 90).toBeCloseTo(20, 10);
    state.setAnimation(0, "r", { mix: 1 });
    step(0.25); // q's own mix 0.75 -> 30; r at 0.25: 30 + (80 - 30) * 0.25 = 42.5
    expect(pose("leg").rotation - 90).toBeCloseTo(42.5, 10);
  });

  it("caps the mix chain", () => {
    const { state, step } = setup(clips);
    for (let i = 0; i < 10; i++) {
      state.setAnimation(0, i % 2 ? "a" : "b", { mix: 1 });
      step(0.01);
    }
    let length = 0;
    for (let entry: TrackEntry | null = state.getCurrent(0); entry; entry = entry.mixingFrom) length++;
    expect(length).toBe(MAX_MIX_CHAIN);
  });

  it("the pose signature fits every track at its longest mix chain; a write past it asserts in development", () => {
    const { state, step } = setup(clips);
    for (let track = 0; track < MAX_TRACKS; track++) {
      for (let i = 0; i < 10; i++) {
        state.setAnimation(track, i % 2 ? "a" : "b", { mix: 1 });
        step(0.01);
      }
    }
    expect(() => state.poseVersion).not.toThrow();
    const sig = state as unknown as { sigPut(n: number, value: number): number; signature: Float64Array };
    expect(() => sig.sigPut(sig.signature.length, 1)).toThrow(/signature overflow/);
  });

  it("a second setAnimation before anything was applied replaces the first outright", () => {
    const { state, step } = setup(clips);
    state.setAnimation(0, "a");
    step(0);
    state.setAnimation(0, "b", { mix: 1 });
    const c = state.setAnimation(0, "reach", { mix: 1 });
    expect(c.mixingFrom?.clip.name).toBe("a");
  });

  it("a newer entry that does not key an attachment leaves the old key until the old entry is dropped", () => {
    const { state, step, skeleton } = setup({
      attack: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: "axe" }] } } },
      idle: { duration: 1, loop: true, bones: { arm: { rotate: rotate([0, 5]) } } }
    });
    state.setAnimation(0, "attack");
    step(0);
    state.setAnimation(0, "idle", { mix: 0.5 });
    step(0.25);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    step(0.25); // mix reaches 1: the attack still decides on this frame
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    step(0.01); // the attack is dropped: the setup attachment applies
    expect(state.getCurrent(0)?.mixingFrom).toBeNull();
    expect(skeleton.getSlot("weapon").placeholder).toBe("sword");
  });

  it("a newer entry before its first discrete key leaves the older decision in place", () => {
    const { state, step, skeleton } = setup({
      axe: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: "axe" }] } } },
      late: { duration: 1, slots: { weapon: { attachment: [{ time: 0.3, name: null }] } } }
    });
    state.setAnimation(0, "axe");
    step(0);
    state.setAnimation(0, "late", { mix: 1 });
    step(0.2);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    step(0.2);
    expect(skeleton.getSlot("weapon").placeholder).toBeNull();
  });

  it("discrete keys switch to the newer entry at its discreteThreshold", () => {
    const { state, step, skeleton } = setup({
      axe: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: "axe" }] } } },
      none: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: null }] } } }
    });
    state.setAnimation(0, "axe");
    step(0);
    state.setAnimation(0, "none", { mix: 1, discreteThreshold: 0.5 });
    step(0.25);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    step(0.25);
    expect(skeleton.getSlot("weapon").placeholder).toBeNull();
  });

  it("changing discreteThreshold mid-crossfade changes the pose version (review, held-pose cache)", () => {
    const { state, step, skeleton } = setup({
      axe: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: "axe" }] } } },
      none: { duration: 1, slots: { weapon: { attachment: [{ time: 0, name: null }] } } }
    });
    state.heldFrames = true;
    state.setAnimation(0, "axe");
    step(0);
    const entry = state.setAnimation(0, "none", { mix: 1, discreteThreshold: 1 });
    step(0.25);
    expect(skeleton.getSlot("weapon").placeholder).toBe("axe");
    const before = state.poseVersion;
    expect(state.poseVersion).toBe(before);
    // Frozen time, new threshold: apply() now decides differently, so the version must move.
    entry.discreteThreshold = 0;
    expect(state.poseVersion).not.toBe(before);
    state.apply(skeleton);
    expect(skeleton.getSlot("weapon").placeholder).toBeNull();
  });
});

describe("rotation unwrapping", () => {
  it("a crossfade whose target crosses 180 keeps turning the same way (no flip)", () => {
    // a holds 0; b turns from 160 to 200 over its 2 s. Mixing a -> b over 2 s, the shortest
    // difference passes +180 -> -180 mid-mix; the remembered side keeps the motion smooth.
    const { state, step, pose } = setup({
      a: { duration: 2, bones: { arm: { rotate: rotate([0, -10]) } } },
      b: { duration: 2, bones: { arm: { rotate: rotate([0, 150], [2, 190]) } } }
    });
    state.setAnimation(0, "a");
    step(0);
    state.setAnimation(0, "b", { mix: 2 });
    let previous = pose("arm").rotation;
    let largest = 0;
    for (let frame = 0; frame < 120; frame++) {
      step(1 / 60);
      const now = pose("arm").rotation;
      largest = Math.max(largest, Math.abs(now - previous));
      previous = now;
    }
    expect(largest).toBeLessThan(5);
    expect(wrapDegrees(previous)).toBeCloseTo(wrapDegrees(200), 6);
  });

  it("an alpha blend against a moving base does not flip either", () => {
    const { state, step, pose } = setup({
      spin: { duration: 2, bones: { arm: { rotate: rotate([0, 0], [2, 360]) } } },
      hold: { duration: 1, bones: { arm: { rotate: rotate([0, 170]) } } }
    });
    state.setAnimation(0, "spin", { loop: true });
    state.setAnimation(1, "hold", { alpha: 0.5 });
    step(0);
    let previous = pose("arm").rotation;
    let largest = 0;
    for (let frame = 0; frame < 120; frame++) {
      step(1 / 60);
      const now = pose("arm").rotation;
      largest = Math.max(largest, Math.abs(wrapDegrees(now - previous)));
      previous = now;
    }
    expect(largest).toBeLessThan(5);
  });
});

describe("time, queue, hitstop", () => {
  const clips: Clips = {
    loop: { duration: 1, loop: true, bones: { arm: { rotate: rotate([0, 0], [1, 100]) } } },
    once: { duration: 1, bones: { arm: { rotate: rotate([0, 0], [1, 100]) } } },
    next: { duration: 1, bones: { leg: { rotate: rotate([0, 10]) } } }
  };

  it("hitstop freezes clip time, mixes and events for exactly that many milliseconds", () => {
    const { state, step } = setup(clips);
    const entry = state.setAnimation(0, "loop");
    step(0.1);
    state.hitstop(33);
    step(0.016);
    step(0.016);
    expect(entry.trackTime).toBeCloseTo(0.1, 12);
    expect(state.hitstopRemaining).toBeCloseTo(1, 9);
    step(0.016);
    expect(entry.trackTime).toBeCloseTo(0.1 + 0.015, 12);
    expect(state.hitstopRemaining).toBe(0);
    state.hitstop(10);
    state.hitstop(5);
    expect(state.hitstopRemaining).toBeCloseTo(10, 9);
  });

  it("time scales multiply (state and entry)", () => {
    const { state, step } = setup(clips);
    const entry = state.setAnimation(0, "loop", { timeScale: 2 });
    state.timeScale = 0.5;
    step(0.3);
    expect(entry.trackTime).toBeCloseTo(0.3, 12);
  });

  it("a queued entry starts when the previous one ends minus the mix, carrying the overshoot", () => {
    const { state, step } = setup(clips);
    state.setAnimation(0, "once");
    const queued = state.addAnimation(0, "next", { mix: 0.2 });
    expect(queued.delay).toBeCloseTo(0.8, 12);
    step(0.5);
    expect(state.getCurrent(0)?.clip.name).toBe("once");
    step(0.5);
    expect(state.getCurrent(0)).toBe(queued);
    expect(queued.trackTime).toBeCloseTo(0.2, 12);
    expect(queued.mixTime).toBeCloseTo(0.2, 12);
    expect(queued.mixingFrom?.clip.name).toBe("once");
  });

  it("an entry queued after a loop waits for the end of the current cycle", () => {
    const { state, step } = setup(clips);
    state.setAnimation(0, "loop");
    step(1.3);
    const queued = state.addAnimation(0, "next", { mix: 0 });
    expect(queued.delay).toBeCloseTo(2, 12);
    step(0.69);
    expect(state.getCurrent(0)?.clip.name).toBe("loop");
    step(0.02);
    expect(state.getCurrent(0)).toBe(queued);
    expect(queued.trackTime).toBeCloseTo(0.01, 12);
  });

  it("addAnimation with a delay on an empty track waits, then fades in from the pose below", () => {
    const { state, step, pose } = setup(clips);
    state.data.defaultMix = 0.2;
    state.addAnimation(0, "next", { delay: 0.5 });
    step(0.4);
    expect(pose("leg").rotation).toBe(90);
    step(0.2);
    expect(state.getCurrent(0)?.clip.name).toBe("next");
    expect(pose("leg").rotation).toBeCloseTo(90 + 10 * 0.5, 10);
  });
});

describe("events and callbacks", () => {
  function recorder() {
    const log: string[] = [];
    const listener: AnimationStateListener = {
      start: (entry) => log.push(`start ${entry.clip.name}`),
      interrupt: (entry) => log.push(`interrupt ${entry.clip.name}`),
      end: (entry) => log.push(`end ${entry.clip.name}`),
      complete: (entry) => log.push(`complete ${entry.clip.name}`),
      event: (entry, event: AnimationEvent) => log.push(`${event.name}@${event.time} ${entry.clip.name}`)
    };
    return { log, listener };
  }

  const clips: Clips = {
    walk: {
      duration: 1,
      loop: true,
      events: [
        { time: 0, name: "step" },
        { time: 0.5, name: "step", int: 1 },
        { time: 1, name: "step", int: 2 }
      ]
    },
    attack: { duration: 0.6, events: [{ time: 0.3, name: "hit" }] }
  };

  for (const [label, dt] of [
    ["exact quarter steps", 0.25],
    ["0.3 s steps", 0.3],
    ["1/60 s steps", 1 / 60],
    ["2.7 s steps (several cycles a frame)", 2.7]
  ] as const) {
    it(`fire exactly once per pass across loop wraps (${label})`, () => {
      const { state, step } = setup(clips);
      const { log, listener } = recorder();
      state.setAnimation(0, "walk", { listener });
      let time = 0;
      while (time + dt <= 5.4 + 1e-9) {
        step(dt);
        time += dt;
      }
      const t = state.getCurrent(0)!.trackTime;
      const count = (name: string) => log.filter((line) => line === name).length;
      // Keys at 0 fire at 0, 1, 2, ...; keys at 0.5 at 0.5, 1.5, ...; keys at 1 at 1, 2, ...
      expect(count("step@0 walk")).toBe(Math.floor(t + 1e-9) + 1);
      expect(count("step@0.5 walk")).toBe(Math.floor(t - 0.5 + 1e-9) + 1);
      expect(count("step@1 walk")).toBe(Math.floor(t + 1e-9));
      expect(count("complete walk")).toBe(Math.floor(t + 1e-9));
    });
  }

  it("orders events, completes and loop starts in time", () => {
    const { state, step } = setup(clips);
    const { log, listener } = recorder();
    state.setAnimation(0, "walk", { listener });
    step(0.4);
    step(1.2);
    expect(log).toEqual([
      "start walk",
      "step@0 walk",
      "step@0.5 walk",
      "step@1 walk",
      "complete walk",
      "step@0 walk",
      "step@0.5 walk"
    ]);
  });

  it("delivers the event payload with the declaration's defaults", () => {
    const { state, step } = setup(clips);
    const events: AnimationEvent[] = [];
    state.addListener({ event: (_entry, event) => events.push(event) });
    state.setAnimation(0, "attack");
    step(0.31);
    expect(events).toEqual([{ name: "hit", time: 0.3, int: 7, float: 0.5, string: "slash", audio: "swing" }]);
  });

  it("a non-looping clip completes once; replacing it interrupts and ends it; listeners may re-enter", () => {
    const { state, step } = setup(clips);
    const { log, listener } = recorder();
    state.addListener(listener);
    state.addListener({ complete: (entry) => entry.clip.name === "attack" && state.setAnimation(0, "walk", { mix: 0.1 }) });
    state.setAnimation(0, "attack");
    step(0);
    step(0.7);
    expect(log).toEqual(["start attack", "hit@0.3 attack", "complete attack", "interrupt attack", "start walk"]);
    step(0.1);
    step(0.01);
    expect(log.slice(5)).toEqual(["step@0 walk", "end attack"]);
  });

  it("an entry being mixed out fires events only below its eventThreshold", () => {
    const run = (eventThreshold: number) => {
      const { state, step } = setup(clips);
      const hits: string[] = [];
      state.addListener({ event: (entry, event) => hits.push(`${event.name} ${entry.clip.name}`) });
      state.setAnimation(0, "attack", { eventThreshold });
      step(0.2);
      state.setAnimation(0, "walk", { mix: 1 });
      step(0.2);
      return hits.filter((hit) => hit.startsWith("hit"));
    };
    expect(run(0)).toEqual([]);
    expect(run(0.5)).toEqual(["hit attack"]);
  });

  it("hitstop holds events back until time moves again", () => {
    const { state, step } = setup(clips);
    const { log, listener } = recorder();
    state.setAnimation(0, "attack", { listener });
    step(0.25);
    state.hitstop(100);
    step(0.09);
    expect(log).not.toContain("hit@0.3 attack");
    step(0.1);
    expect(log).toContain("hit@0.3 attack");
  });

  it("clearing a track ends its entries; apply then leaves those properties at setup", () => {
    const { state, step, pose } = setup({ bend: { duration: 1, bones: { leg: { rotate: rotate([0, 30]) } } } });
    const { log, listener } = recorder();
    state.addListener(listener);
    state.setAnimation(0, "bend");
    step(0);
    expect(pose("leg").rotation).toBe(120);
    state.clearTrack(0);
    step(0);
    expect(pose("leg").rotation).toBe(90);
    expect(log).toEqual(["start bend", "end bend"]);
  });

  it("refuses a skeleton made from another document", () => {
    const { state } = setup(clips);
    expect(() => state.apply(new Skeleton(rig(clips)))).toThrow(/different document/);
  });
});
