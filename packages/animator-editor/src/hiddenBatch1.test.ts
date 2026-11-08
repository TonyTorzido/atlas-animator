import { describe, expect, it } from "vitest";
import { emptyClip, frameCount, frameTime, setClipFps, setRotateKey } from "./clipModel.js";
import { placeEventLabel, renameEvent, setEvent } from "./eventModel.js";
import { timelineHeader } from "./timelineUx.js";

const width = (s: string) => s.length * 6;

describe("timeline header", () => {
  it("prints frame, count, length and fps", () => {
    expect(timelineHeader(12, 24, 0.8, 30)).toBe("Frame 12 / 24 · 0.80 s · 30 fps");
  });
});

describe("placeEventLabel", () => {
  it("puts the name right of the diamond when it fits", () => {
    const p = placeEventLabel([100], 0, "hit", width, 5, 50, 400)!;
    expect(p.align).toBe("left");
    expect(p.x).toBe(108);
  });
  it("flips left at the right edge", () => {
    const p = placeEventLabel([300], 0, "trailOff", width, 5, 50, 320)!;
    expect(p.align).toBe("right");
    expect(p.text).toBe("trailOff");
  });
  it("cuts crowded names with an ellipsis and never passes the next diamond", () => {
    const xs = [100, 130];
    const p = placeEventLabel(xs, 0, "trailOff", width, 5, 100, 400)!;
    expect(p.text.endsWith("…")).toBe(true);
    expect(p.x + width(p.text)).toBeLessThanOrEqual(xs[1]! - 5);
  });
  it("draws nothing when there is no room at all", () => {
    expect(placeEventLabel([100, 112], 0, "hit", width, 5, 98, 400)).toBeNull();
  });
});

describe("renameEvent", () => {
  it("renames the markers at a time and does not double up", () => {
    let c = emptyClip(1, false, 30);
    c = setEvent(c, frameTime(c, 6), "hit");
    c = setEvent(c, frameTime(c, 6), "windup");
    const r = renameEvent(c, frameTime(c, 6), "windup", "hit");
    expect(r.events.map((e) => e.name)).toEqual(["windup"]);
  });
});

describe("setClipFps", () => {
  it("keeps the length in seconds and moves keys onto the new grid", () => {
    let c = emptyClip(0.8, false, 30);
    c = setRotateKey(c, "chest", frameTime(c, 7), 10);
    const { clip, moved } = setClipFps(c, 24);
    expect(clip.fps).toBe(24);
    expect(clip.duration).toBeCloseTo(19 / 24, 5);
    expect(frameCount(clip)).toBe(19);
    expect(moved).toBe(1);
    expect(clip.bones["chest"]!.rotate![0]!.time).toBeCloseTo(6 / 24, 6);
  });
  it("reports no moved keys when 30 -> 60 keeps every key on a frame", () => {
    let c = emptyClip(1, false, 30);
    c = setRotateKey(c, "chest", frameTime(c, 3), 5);
    expect(setClipFps(c, 60).moved).toBe(0);
  });
});

describe("rig delete / rename guards", () => {
  it("refuse a rig without the New rig marker", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { deleteRig, renameRig } = await import("./rigCreate.js");
    const { RIGS_DIR } = await import("./rigSave.js");
    const root = mkdtempSync(join(tmpdir(), "rigs-"));
    mkdirSync(join(root, RIGS_DIR, "builtin"), { recursive: true });
    writeFileSync(join(root, RIGS_DIR, "builtin", "builtin.anim.json"), "{}");
    expect(() => deleteRig(root, "builtin")).toThrow(/built-in/);
    expect(() => renameRig(root, "builtin", "x")).toThrow(/not an editor-made/);
  });
});
