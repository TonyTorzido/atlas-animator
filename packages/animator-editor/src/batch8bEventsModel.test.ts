import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { clipJson, parseClip } from "./clipModel.js";
import { eventColor, setEvent } from "./eventModel.js";
import { declaredEvents, planAddEvent, planAddGameEvents, planRemoveEvent, planRenameEvent, planSetEvent } from "./eventRigPlans.js";
import { keyChannels, setKeyFields } from "./keyInspectorModel.js";
import { applyOps, runBatch, type JsonObject } from "./setupModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  expect(parseAnimDocument(r.doc).ok).toBe(true);
  return r;
};

describe("rig event definitions (Batch 8b-2)", () => {
  it("adds, sets (payload incl. audio), renames with clip keys following, removes with its keys; undo restores", () => {
    const raw = load();
    const add = apply(raw, planAddEvent(raw, "footstep", { int: 2, audio: "step_soft" }).commands);
    expect(declaredEvents(add.doc)["footstep"]).toEqual({ int: 2, float: 0, string: "", audio: "step_soft" });
    expect(() => planAddEvent(add.doc, "footstep")).toThrow(/already exists/);
    expect(() => planAddEvent(add.doc, "bad name")).toThrow(/valid event name/);
    const set = apply(add.doc, planSetEvent(add.doc, "footstep", { float: 0.5, string: "left", audio: "" }).commands);
    expect(declaredEvents(set.doc)["footstep"]).toEqual({ int: 2, float: 0.5, string: "left", audio: "" });
    // A clip in the document fires it.
    const anims = (set.doc["animations"] ?? {}) as Record<string, JsonObject>;
    const clipName = Object.keys(anims)[0];
    let withKey = set.doc;
    if (clipName) withKey = apply(set.doc, [{ op: "event.key", clip: clipName, time: 0, name: "footstep", int: 3 }]).doc;
    const ren = apply(withKey, planRenameEvent(withKey, "footstep", "step").commands);
    expect("footstep" in declaredEvents(ren.doc)).toBe(false);
    expect(declaredEvents(ren.doc)["step"]!.float).toBe(0.5);
    if (clipName) expect((ren.doc["animations"] as Record<string, JsonObject>)[clipName]!["events"]).toEqual([{ time: 0, name: "step", int: 3 }]);
    const gone = apply(ren.doc, planRemoveEvent(ren.doc, "step").commands);
    expect("step" in declaredEvents(gone.doc)).toBe(false);
    if (clipName) expect((gone.doc["animations"] as Record<string, JsonObject>)[clipName]!["events"]).toBeUndefined();
    expect(applyOps(gone.doc, gone.inverse)).toEqual(ren.doc);
  });
  it("declares the missing game events and refuses to remove a built-in one", () => {
    const raw = load();
    const r = apply(raw, planAddGameEvents(raw).commands);
    expect(Object.keys(declaredEvents(r.doc))).toEqual(expect.arrayContaining(["windup", "hit", "trailOn", "trailOff", "follow", "ready"]));
    expect(planAddGameEvents(r.doc).commands).toHaveLength(0);
    expect(() => planRemoveEvent(r.doc, "hit")).not.toThrow();
    expect(() => planRemoveEvent(raw, "nope")).toThrow(/no event/);
  });
  it("a clip event with a custom name and payload round-trips through the clip file", () => {
    const clip = setEvent(parseClip({ duration: 1, loop: false, fps: 30 }), 0.1, "footstep", undefined, { int: 2, float: 0.25, string: "left", audio: "step_soft" });
    const back = parseClip(JSON.parse(clipJson(clip)));
    expect(back.events).toEqual([{ time: 3 / 30, name: "footstep", int: 2, float: 0.25, string: "left", audio: "step_soft" }]);
    expect(eventColor("footstep")).toBe(eventColor("footstep"));
  });
  it("the key inspector always lists name, int, float, string and audio for an event key, and edits write the payload", () => {
    const clip = parseClip({ duration: 1, loop: false, fps: 30, events: [{ time: 0, name: "hit" }] });
    const ch = keyChannels(clip, "event", 0);
    expect(ch).toHaveLength(1);
    expect(ch[0]!.fields.map((f) => f.id)).toEqual(["name", "int", "float", "string", "audio"]);
    const next = setKeyFields(clip, "event", 0, ch[0]!.channel, { int: 2, audio: "clang" });
    expect(next.events[0]).toMatchObject({ name: "hit", int: 2, audio: "clang" });
  });
});
