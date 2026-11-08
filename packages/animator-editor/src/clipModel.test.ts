import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importChannelSpec, isChannelSpec } from "./channelImport.js";
import { CLIP_FILE_VERSION, clipJson, clipsEquivalent, migrateClipFile, deleteKeys, frameTime, hasKey, heldTime, parseClip, pastePose, setDuration, setRotateKey, snapClipTimes, snapTime, writeClip } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";

const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = JSON.parse(readFileSync(repo(player.document), "utf8")) as { bones: { name: string }[]; animations: Record<string, unknown> };
const clipNames = Object.keys(doc.animations);

describe("clip round trip (load then save gives an equivalent clip)", () => {
  it("covers every clip of the player rig", () => {
    expect(clipNames.length).toBeGreaterThanOrEqual(5);
  });
  for (const name of clipNames) {
    it(`${name}: save(load(clip)) is equivalent and the same JSON value (object key order may differ)`, () => {
      const raw = doc.animations[name];
      const saved = migrateClipFile(JSON.parse(clipJson(parseClip(raw)))) as unknown; // the file wrapper's clipVersion is not part of the clip
      expect(clipsEquivalent(raw, saved)).toBe(true);
      // The rig files hold 5-decimal times; loading snaps each onto its exact frame time (frame / fps), saving writes it at full precision.
      expect(saved).toEqual(snapClipTimes(structuredClone(raw)));
      // A second round trip is stable.
      expect(writeClip(parseClip(saved))).toEqual(saved);
    });
  }
  it("set then delete a new key returns the original clip", () => {
    const raw = doc.animations.fk_ik_fk;
    const clip = parseClip(raw);
    const keyed = setRotateKey(clip, "head", 0.5, 7.25);
    expect(hasKey(keyed, "head", "rotate", 0.5)).toBe(true);
    expect(clipsEquivalent(raw, writeClip(keyed))).toBe(false);
    expect(clipsEquivalent(raw, writeClip(deleteKeys(keyed, "head", 0.5)))).toBe(true);
  });
});

describe("clip edits", () => {
  const base = parseClip({ duration: 1, loop: true, fps: 30 });
  it("snaps key times onto the 30 fps grid at full precision (exactly frame / 30)", () => {
    expect(snapTime(base, 0.034)).toBe(1 / 30);
    expect(frameTime(base, 4)).toBe(4 / 30);
    const c = setRotateKey(base, "chest", 0.51, 3);
    expect(c.bones.chest?.rotate?.[0]).toEqual({ time: 0.5, value: 3, curve: "linear" });
  });
  it("replacing a key keeps its curve", () => {
    let c = setRotateKey(base, "chest", 0.5, 3);
    c.bones.chest!.rotate![0]!.curve = "stepped";
    c = setRotateKey(c, "chest", 0.5, 4);
    expect(c.bones.chest!.rotate).toEqual([{ time: 0.5, value: 4, curve: "stepped" }]);
  });
  it("deleting the last key removes the timeline (empty timelines are invalid)", () => {
    const c = deleteKeys(setRotateKey(base, "chest", 0.5, 3), "chest", 0.5);
    expect(c.bones.chest).toBeUndefined();
    expect(() => parseClip(writeClip(c))).not.toThrow();
  });
  it("paste keys only what differs from setup or is already animated", () => {
    const c = pastePose(setRotateKey(base, "head", 0, 1), {
      head: { rotate: 0, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      chest: { rotate: 5, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      neck: { rotate: 0, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }
    }, 0.2);
    expect(hasKey(c, "head", "rotate", 0.2)).toBe(true);
    expect(hasKey(c, "chest", "rotate", 0.2)).toBe(true);
    expect(c.bones.neck).toBeUndefined();
    expect(c.bones.chest?.translate).toBeUndefined();
  });
  it("shortening drops keys past the end and stays valid", () => {
    const c = setRotateKey(setRotateKey(base, "chest", 0.2, 1), "chest", 0.9, 2);
    const { clip, dropped } = setDuration(c, 0.5);
    expect(dropped).toBe(1);
    expect(clip.duration).toBe(0.5);
    expect(() => parseClip(writeClip(clip))).not.toThrow();
  });
});

describe("fixtures/clips import", () => {
  const bling = JSON.parse(readFileSync(repo("packages/animator/fixtures/clips/emote-bling.json"), "utf8")) as unknown;
  const walk = JSON.parse(readFileSync(repo("packages/animator/fixtures/clips/walk-front-chibi.json"), "utf8")) as unknown;
  it("the Bling channel spec becomes a valid looping clip on the rig's bones", () => {
    expect(isChannelSpec(bling)).toBe(true);
    const out = importChannelSpec(bling as Parameters<typeof importChannelSpec>[0], doc.bones.map((b) => b.name));
    expect(out.imported).toEqual(expect.arrayContaining(["upper_arm_l", "forearm_l", "hand_l", "upper_arm_r", "chest", "head"]));
    expect(out.skipped).toEqual(expect.arrayContaining(["knee", "chest.scaleX"]));
    expect(out.clip.duration).toBeCloseTo(119 / 30, 4);
    const saved = writeClip(out.clip);
    expect(clipsEquivalent(saved, JSON.parse(clipJson(parseClip(saved))))).toBe(true);
    for (const tl of Object.values(out.clip.bones)) {
      const keys = tl.rotate!;
      expect(keys[0]!.time).toBe(0);
      expect(keys[keys.length - 1]!.time).toBeCloseTo(out.clip.duration, 5);
      expect(keys[keys.length - 1]!.value).toBe(keys[0]!.value);
    }
  });
  it("the walk parameter file is not a channel spec", () => {
    expect(isChannelSpec(walk)).toBe(false);
  });
});

describe("held time", () => {
  it("shows the frame a 5-decimal key time belongs to (0.13333 is frame 4, not 3)", () => {
    const clip = parseClip({ duration: 1, loop: false, fps: 30 });
    for (let f = 0; f <= 30; f++) expect(Math.round(heldTime(clip, frameTime(clip, f)) * 30)).toBe(f);
    expect(Math.round(heldTime(clip, 0.1999) * 30)).toBe(5);
  });
});

describe("frame-exact times", () => {
  it("loading snaps 5-decimal times onto their frame and leaves other times alone", () => {
    const clip = parseClip({ duration: 0.93333, loop: false, fps: 30, bones: { chest: { rotate: [{ time: 0.13333, value: 1 }, { time: 0.5, value: 2 }, { time: 0.52, value: 3 }] } } });
    expect(clip.duration).toBe(28 / 30);
    expect(clip.bones.chest!.rotate!.map((k) => k.time)).toEqual([4 / 30, 0.5, 0.52]);
  });
  it("writes times as the exact double, and the written file parses to the same clip", () => {
    let c = parseClip({ duration: 1, loop: false, fps: 30 });
    c = setRotateKey(c, "chest", frameTime(c, 4), 5);
    const text = clipJson(c);
    expect(text).toContain(String(4 / 30));
    expect(parseClip(JSON.parse(text))).toEqual(c);
  });
  it("setDuration lands on an exact frame multiple", () => {
    expect(setDuration(parseClip({ duration: 1, loop: false, fps: 30 }), 0.6).clip.duration).toBe(18 / 30);
  });
});

describe("clip file version", () => {
  const raw = { duration: 1, loop: true, fps: 30, bones: { chest: { rotate: [{ time: 0, value: 1 }] } } };
  it("writes clipVersion first and loads it back unchanged", () => {
    const text = clipJson(parseClip(raw));
    expect(Object.keys(JSON.parse(text) as object)[0]).toBe("clipVersion");
    expect((JSON.parse(text) as { clipVersion: number }).clipVersion).toBe(CLIP_FILE_VERSION);
    expect(parseClip(JSON.parse(text))).toEqual(parseClip(raw));
  });
  it("treats an unversioned file as v1 and migrates it to v2", () => {
    expect(migrateClipFile(raw)).toEqual(raw);
    expect(parseClip({ ...raw, clipVersion: 1, events: [{ time: 0, name: "hit", int: 2 }] }).events).toEqual([{ time: 0, name: "hit", int: 2 }]);
    expect(parseClip(raw).duration).toBe(1);
  });
  it("round-trips an event payload with audio through clipJson and parseClip", () => {
    const ev = { time: 0.5, name: "footstep", int: 2, float: 0.25, string: "left", audio: "step_soft" };
    const clip = parseClip({ ...raw, events: [ev] });
    const text = clipJson(clip);
    expect((JSON.parse(text) as { clipVersion: number }).clipVersion).toBe(2);
    expect(parseClip(JSON.parse(text)).events[0]).toMatchObject(ev);
  });
  it("refuses a newer or malformed version", () => {
    expect(() => parseClip({ ...raw, clipVersion: CLIP_FILE_VERSION + 1 })).toThrow(/newer than this build/);
    expect(() => parseClip({ ...raw, clipVersion: "1" })).toThrow(/clipVersion/);
    expect(() => parseClip({ ...raw, clipVersion: 0 })).toThrow(/clipVersion/);
  });
});
