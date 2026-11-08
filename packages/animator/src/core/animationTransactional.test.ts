import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData, type TrackEntry } from "./animationState.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

/*
 * Rejected playback changes leave state intact: every option is
 * validated before the queue, the chain or the track changes.
 */

function setup() {
  const clip = (value: number) => ({ duration: 1, bones: { arm: { rotate: [{ time: 0, value }] } } });
  const doc = testDocument({ bones: [{ name: "root" }, { name: "arm", parent: "root" }], animations: { a: clip(10), b: clip(20), c: clip(30) } });
  const skeleton = new Skeleton(doc);
  const state = new AnimationState(new AnimationStateData(doc));
  const log: string[] = [];
  state.addListener({
    start: (e) => log.push(`start ${e.clip.name}`),
    interrupt: (e) => log.push(`interrupt ${e.clip.name}`),
    end: (e) => log.push(`end ${e.clip.name}`)
  });
  const step = (dt: number) => {
    state.update(dt);
    state.apply(skeleton);
  };
  return { state, log, step };
}

const shape = (e: TrackEntry | null) => {
  const out: string[] = [];
  for (let n = e; n; n = n.next) out.push(`${n.clip.name}${n.ended ? "(ended)" : ""}`);
  return { chain: out, from: e?.mixingFrom?.clip.name ?? null, to: e?.mixingTo?.clip.name ?? null };
};

const bad = [{ mix: -1 }, { mix: Number.NaN }, { alpha: 2 }, { timeScale: -1 }] as const;

describe("transactional playback (item 5)", () => {
  for (const options of bad) {
    it(`an invalid replacement (${JSON.stringify(options)}) with a clip queued changes nothing`, () => {
      for (const applied of [true, false]) {
        const { state, log, step } = setup();
        state.setAnimation(0, "a");
        state.addAnimation(0, "b", { delay: 0.5 });
        if (applied) step(0.1);
        const current = state.getCurrent(0)!;
        const before = shape(current);
        const events = log.length;
        expect(() => state.setAnimation(0, "c", options)).toThrow();
        expect(state.getCurrent(0)).toBe(current);
        expect(shape(state.getCurrent(0))).toEqual(before);
        step(0);
        expect(log.slice(events)).toEqual([]);
        // The queued clip still plays on schedule.
        step(0.5);
        expect(state.getCurrent(0)?.clip.name).toBe("b");
      }
    });
  }

  it("an invalid queued clip on an empty track with a delay leaves the track empty", () => {
    const { state, log, step } = setup();
    expect(() => state.addAnimation(0, "a", { delay: 1, mix: -1 })).toThrow();
    expect(state.getCurrent(0)).toBeNull();
    step(0);
    expect(log).toEqual([]);
  });

  it("an invalid empty animation leaves the queue intact", () => {
    const { state, step } = setup();
    state.setAnimation(0, "a");
    state.addAnimation(0, "b", { delay: 0.5 });
    step(0.1);
    const before = shape(state.getCurrent(0));
    expect(() => state.setEmptyAnimation(0, -1)).toThrow();
    expect(shape(state.getCurrent(0))).toEqual(before);
  });
});
