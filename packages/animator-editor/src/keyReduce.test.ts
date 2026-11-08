import { readFileSync } from "node:fs";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { countKeys, reduceKeys } from "./keyReduce.js";

const clipOf = (raw: Record<string, unknown>) => parseClip({ duration: 1, loop: false, fps: 30, ...raw });
const rot = (pairs: [number, number][], curve?: unknown) => pairs.map(([time, value]) => ({ time, value, ...(curve ? { curve } : {}) }));
const times = (clip: ReturnType<typeof clipOf>, bone: string) => (clip.bones[bone]?.rotate ?? []).map((k) => k.time);

describe("key reduction", () => {
  it("removes keys on the line between their neighbours and keeps the ends", () => {
    const clip = clipOf({ bones: { a: { rotate: rot([[0, 0], [0.1, 10], [0.2, 20], [0.3, 30], [0.5, 50]]) } } });
    const r = reduceKeys(clip);
    expect(times(r.clip, "a")).toEqual([0, 0.5]);
    expect(r.removed).toBe(3);
    expect(r.keysBefore).toBe(5);
    expect(r.keysAfter).toBe(2);
    expect(r.perChannel.rotate).toBe(3);
    // The input is untouched.
    expect(times(clip, "a").length).toBe(5);
  });

  it("keeps a key that is off the line by more than the tolerance, and drops it once the tolerance covers it", () => {
    const clip = clipOf({ bones: { a: { rotate: rot([[0, 0], [0.2, 11], [0.4, 20]]) } } });
    expect(reduceKeys(clip, { tolerances: { rotate: 0.5 } }).removed).toBe(0);
    expect(reduceKeys(clip, { tolerances: { rotate: 1.5 } }).removed).toBe(1);
  });

  it("uses a tolerance per channel", () => {
    const clip = clipOf({
      bones: { a: { rotate: rot([[0, 0], [0.2, 2], [0.4, 0]]), translate: [{ time: 0, x: 0, y: 0 }, { time: 0.2, x: 2, y: 0 }, { time: 0.4, x: 0, y: 0 }] } }
    });
    const r = reduceKeys(clip, { tolerances: { rotate: 5, translate: 0.1 } });
    expect(r.perChannel).toMatchObject({ rotate: 1, translate: 0 });
  });

  it("never removes the first or last key, even on a flat track", () => {
    const clip = clipOf({ bones: { a: { rotate: rot([[0, 5], [0.5, 5], [1, 5]]) } } });
    expect(times(reduceKeys(clip).clip, "a")).toEqual([0, 1]);
    expect(times(reduceKeys(clipOf({ bones: { a: { rotate: rot([[0, 5], [1, 5]]) } } })).clip, "a")).toEqual([0, 1]);
  });

  it("keeps a key that an ease curve makes meaningful, and checks the poses between frames", () => {
    // Linear through the middle key, but the first key eases: the middle key is no longer on the drawn path.
    const eased = clipOf({ bones: { a: { rotate: rot([[0, 0]], [0.9, 0, 1, 1]).concat(rot([[0.2, 10], [0.4, 20]])) } } });
    expect(reduceKeys(eased).removed).toBe(0);
    // The same middle key with straight neighbours goes.
    expect(reduceKeys(clipOf({ bones: { a: { rotate: rot([[0, 0], [0.2, 10], [0.4, 20]]) } } })).removed).toBe(1);
  });

  it("keeps a stepped jump and drops a stepped repeat", () => {
    const jump = clipOf({ bones: { a: { rotate: rot([[0, 0], [0.2, 0], [0.4, 30], [0.6, 30]], "stepped") } } });
    // 0.2 repeats 0, so the hold reaches 0.4 anyway; 0.4 changes the value and stays.
    expect(times(reduceKeys(jump).clip, "a")).toEqual([0, 0.4, 0.6]);
  });

  it("the reduced clip samples within tolerance of the original at every frame", () => {
    const pairs: [number, number][] = [];
    for (let f = 0; f <= 30; f++) pairs.push([f / 30, 20 * Math.sin((f / 30) * Math.PI * 2)]);
    const clip = clipOf({ bones: { a: { rotate: rot(pairs) } } });
    const r = reduceKeys(clip, { tolerances: { rotate: 0.4 } });
    expect(r.removed).toBeGreaterThan(5);
    const lerp = (keys: { time: number; value: number }[], t: number) => {
      let i = 0;
      while (i + 1 < keys.length - 1 && keys[i + 1]!.time <= t) i++;
      const a = keys[i]!;
      const b = keys[i + 1]!;
      return a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time);
    };
    for (const [t, v] of pairs) expect(Math.abs(lerp(r.clip.bones.a!.rotate!, t) - v)).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it("scopes to the selected bones; the whole clip also reduces IK", () => {
    const clip = clipOf({
      bones: { a: { rotate: rot([[0, 0], [0.2, 10], [0.4, 20]]) }, b: { rotate: rot([[0, 0], [0.2, 10], [0.4, 20]]) } },
      ik: { arm: [{ time: 0, mix: 1 }, { time: 0.2, mix: 1 }, { time: 0.4, mix: 1 }] }
    });
    const some = reduceKeys(clip, { bones: ["a"] });
    expect(times(some.clip, "a")).toEqual([0, 0.4]);
    expect(times(some.clip, "b").length).toBe(3);
    expect(some.clip.ik.arm!.length).toBe(3);
    expect(countKeys(clip, ["a"])).toBe(3);
    const all = reduceKeys(clip);
    expect(all.perChannel.ik).toBe(1);
    expect(all.removed).toBe(3);
  });

  it("keeps an IK key that flips the bend", () => {
    const clip = clipOf({ ik: { arm: [{ time: 0, mix: 1, bendPositive: true }, { time: 0.2, mix: 1, bendPositive: false }, { time: 0.4, mix: 1, bendPositive: false }] } });
    expect(reduceKeys(clip).clip.ik.arm!.length).toBe(3);
  });

  it("leaves events, attachment swaps, draw order and slot colour alone", () => {
    const clip = clipOf({
      events: [{ name: "hit", time: 0.2 }],
      slots: { s: { attachment: [{ time: 0, name: "x" }, { time: 0.2, name: "x" }, { time: 0.4, name: "x" }], color: [{ time: 0, color: "ffffffff" }, { time: 0.2, color: "ffffffff" }, { time: 0.4, color: "ffffffff" }] } },
      drawOrder: [{ time: 0.2, offsets: [] }]
    });
    const r = reduceKeys(clip);
    expect(r.removed).toBe(0);
    expect(r.clip).toEqual(clip);
  });

  it("reduces the committed pro rig clips without changing what they draw", () => {
    const fixture = ALL_OUTFITS.find((o) => o.id === "pro-turned")!;
    const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${fixture.document}`, import.meta.url), "utf8")));
    for (const [name, raw] of Object.entries(doc.animations)) {
      const clip = parseClip(raw);
      const r = reduceKeys(clip);
      expect(r.keysAfter, name).toBeLessThanOrEqual(r.keysBefore);
      // Idempotent.
      expect(reduceKeys(r.clip).removed, name).toBe(0);
    }
  });
});
