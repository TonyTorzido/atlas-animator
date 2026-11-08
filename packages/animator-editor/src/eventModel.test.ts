import { readFileSync } from "node:fs";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { emptyClip, frameTime, parseClip, writeClip } from "./clipModel.js";
import { allKeys, moveKeys } from "./dopesheetModel.js";
import { contactFrame, deleteEvent, eventIssues, eventsAt, hitLink, lockHit, setEvent, stepContactFrame, withEventDefs } from "./eventModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { clipGates, poseGates } from "./gates.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = withEventDefs(loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8"))));
const f = (n: number) => frameTime({ fps: 30 }, n);

describe("contact frame from the attack profiles", () => {
  it("is windupMs * 30 / 1000", () => {
    expect(contactFrame(200)).toBe(6);
    expect(contactFrame(300)).toBe(9);
    expect(contactFrame(133)).toBe(4);
    expect(stepContactFrame("axe:generic", 0)).toBe(6);
    expect(stepContactFrame("axe:generic", 2)).toBe(9);
    expect(stepContactFrame("sword:ronin", 2)).toBe(6);
    expect(stepContactFrame("axe:generic", 9)).toBeNull();
  });
});

describe("event markers", () => {
  it("adds, replaces and deletes markers (snapped to frames) and round trips the clip", () => {
    let clip = setEvent(emptyClip(1, false), 0, "windup");
    clip = setEvent(clip, f(6), "hit", { style: "axe:generic", step: 0 });
    clip = setEvent(clip, f(6), "trailOn");
    clip = setEvent(clip, f(6), "hit", { style: "axe:generic", step: 0 });
    expect(clip.events.map((e) => e.name)).toEqual(["windup", "trailOn", "hit"]);
    expect(eventsAt(clip, f(6)).length).toBe(2);
    expect(hitLink(clip.events[2]!)).toEqual({ style: "axe:generic", step: 0 });
    expect(parseClip(writeClip(clip))).toEqual(clip);
    expect(deleteEvent(clip, f(6), "trailOn").events.map((e) => e.name)).toEqual(["windup", "hit"]);
    expect(deleteEvent(clip, f(6)).events.map((e) => e.name)).toEqual(["windup"]);
  });
  it("needs the names declared on the rig document, which the editor does", () => {
    const clip = setEvent(emptyClip(1, false), f(6), "hit");
    expect(clipGates(doc, "t", clip).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("hit marker lock and warning", () => {
  it("locks the hit to the step's contact frame, moving an existing hit", () => {
    const clip = setEvent(emptyClip(1, false), f(4), "hit");
    const locked = lockHit(clip, "axe:generic", 0);
    expect(locked.events).toEqual([{ time: f(6), name: "hit", string: "axe:generic#0" }]);
    const finisher = lockHit(locked, "axe:generic", 2);
    expect(finisher.events).toEqual([{ time: f(9), name: "hit", string: "axe:generic#2" }]);
  });
  it("warns when a linked hit is off the contact frame, not when it is on it or unlinked", () => {
    const on = lockHit(emptyClip(1, false), "axe:generic", 0);
    expect(eventIssues(on)).toEqual([]);
    const off = setEvent(emptyClip(1, false), f(8), "hit", { style: "axe:generic", step: 0 });
    const issues = eventIssues(off);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("frame 8");
    expect(issues[0]!.message).toContain("frame 6");
    expect(eventIssues(setEvent(emptyClip(1, false), f(8), "hit"))).toEqual([]);
  });
  it("shows up as a warning in the live gates (never an error), and follows a dopesheet move", () => {
    const on = lockHit(emptyClip(1, false), "axe:generic", 0);
    expect(poseGates(doc, "t", on, 0).filter((i) => i.kind === "event timing")).toEqual([]);
    const moved = moveKeys(on, allKeys(on).filter((k) => k.row === "event"), 2).clip;
    const gates = poseGates(doc, "t", moved, 0);
    expect(gates.some((i) => i.kind === "event timing" && i.severity === "warning")).toBe(true);
    expect(gates.filter((i) => i.severity === "error")).toEqual([]);
    expect(clipGates(doc, "t", moved).some((i) => i.kind === "event timing")).toBe(true);
  });
});
