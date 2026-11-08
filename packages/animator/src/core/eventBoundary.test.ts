import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

/*
 * Transition-boundary events stable across frame divisions. Rule: a
 * key of an entry being mixed out fires iff its track time is at or before the boundary (the old
 * entry's track time when the newer mix fraction reaches eventThreshold) plus EVENT_EPSILON; once.
 */

const B = 0.55; // fade starts at old track time 0.25, mix 0.3, threshold 1
const events = { before: {}, at: {}, after: {} };

function run(splits: readonly number[], options: { loop: boolean; queued: boolean; threshold?: number }) {
  const old = options.loop
    ? { duration: 0.25, loop: true, bones: {}, events: [{ time: 0.05, name: "at" }] }
    : { duration: 2, bones: {}, events: [{ time: B - 1e-4, name: "before" }, { time: B, name: "at" }, { time: B + 1e-4, name: "after" }] };
  const doc = testDocument({ bones: [{ name: "root" }], events, animations: { old, next: { duration: 2, bones: {} } } });
  const skeleton = new Skeleton(doc);
  const state = new AnimationState(new AnimationStateData(doc));
  const fired: string[] = [];
  const step = (dt: number) => {
    state.update(dt);
    state.apply(skeleton);
  };
  const first = state.setAnimation(0, "old", { loop: options.loop, eventThreshold: options.threshold ?? 1 });
  first.listener = { event: (e, ev) => fired.push(`${ev.name}@${(e.trackTime >= 0 ? ev.time : 0).toFixed(4)}`) };
  if (options.queued) {
    state.addAnimation(0, "next", { delay: 0.25, mix: 0.3 });
  } else {
    step(0.25);
    state.setAnimation(0, "next", { mix: 0.3 });
  }
  const startCount = options.queued ? 0 : fired.length;
  for (const dt of splits) step(dt);
  return fired.slice(startCount);
}

/** Splits of `total` seconds: one update, regular, irregular (deterministic), and float-noisy edges. */
function divisions(total: number, boundary: number): Record<string, number[]> {
  const irregular: number[] = [];
  let seed = 7;
  let left = total;
  while (left > 1e-12) {
    seed = (seed * 16807) % 2147483647;
    const dt = Math.min(left, 0.004 + (seed / 2147483647) * 0.05);
    irregular.push(dt);
    left -= dt;
  }
  return {
    one: [total],
    "60 Hz": Array.from({ length: Math.round(total * 60) }, () => 1 / 60),
    "30 Hz": Array.from({ length: Math.round(total * 30) }, () => 1 / 30),
    irregular,
    "at the boundary": [boundary, total - boundary],
    "just before the boundary": [boundary - 1e-15, 1e-15, total - boundary],
    "summed tenths": [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].slice(0, Math.round(total / 0.1))
  };
}

describe("outgoing events at the fade boundary (item 6)", () => {
  for (const [name, splits] of Object.entries(divisions(0.6, B - 0.25))) {
    it(`fires keys before and at the boundary once, never after (${name})`, () => {
      expect(run(splits, { loop: false, queued: false })).toEqual(["before@0.5499", "at@0.5500"]);
    });
  }

  for (const [name, splits] of Object.entries(divisions(0.9, B))) {
    it(`queued transition, looping clip: the cycle key at the boundary fires once (${name})`, () => {
      const fired = run(splits, { loop: true, queued: true });
      // Keys at 0.05, 0.30 (before the fade) and 0.55 (the boundary); 0.80 is after it.
      expect(fired).toEqual(["at@0.0500", "at@0.0500", "at@0.0500"]);
    });
  }

  it("threshold 0.5: the boundary moves to the mix midpoint, same rule", () => {
    for (const splits of Object.values(divisions(0.6, 0.15))) {
      const fired = run(splits, { loop: false, queued: false, threshold: 0.5 });
      expect(fired).toEqual([]);
    }
  });
});
