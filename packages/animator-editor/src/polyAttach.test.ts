import { describe, expect, it } from "vitest";
import { defaultPolygon, parseSequenceFrames, planAddPolygon, planInsertVertex, planMoveVertex, planRemoveVertex, planSequenceFromPaths, planSetClipEnd, planSetSequence, sequenceSlots } from "./polyAttach.js";
import type { JsonObject } from "./setupModel.js";

const raw = (): JsonObject => ({
  slots: [{ name: "body", bone: "root", attachment: "pic" }, { name: "fx", bone: "root" }],
  skins: { base: { attachments: { body: { pic: { type: "region", path: "p", x: 10, y: 0, width: 20, height: 40 }, hit: { type: "boundingbox", vertices: [0, 0, 10, 0, 10, 10, 0, 10] }, clip: { type: "clipping", vertices: [0, 0, 10, 0, 10, 10] } } } } }
});
const a = { skin: "base", slot: "body", name: "hit" };

describe("polygon plans", () => {
  it("the default box follows the setup image", () => {
    expect(defaultPolygon(raw(), "base", "body")).toEqual([0, -20, 20, -20, 20, 20, 0, 20]);
    expect(defaultPolygon(raw(), "base", "fx")).toHaveLength(8);
  });
  it("adds a named polygon of each kind", () => {
    const p = planAddPolygon(raw(), { skin: "base", slot: "body", kind: "boundingbox" });
    expect(p).toMatchObject({ attachment: "hitbox", slot: "body_hitbox" });
    expect(p.commands[0]).toMatchObject({ op: "slot.add", name: "body_hitbox", bone: "root", attachment: "hitbox", drawAfter: "body" });
    expect(p.commands[1]).toMatchObject({ op: "attachment.add", slot: "body_hitbox", attachment: { type: "boundingbox" } });
    const c = planAddPolygon(raw(), { skin: "base", slot: "body", kind: "clipping" });
    expect(c.commands[0]).toMatchObject({ drawBefore: "body" });
    expect(c.commands[1]).toMatchObject({ attachment: { type: "clipping", end: "body" } });
  });
  it("moves, inserts and removes vertices; three points stay", () => {
    expect((planMoveVertex(raw(), a, 1, 12, 3)[0] as unknown as { fields: { vertices: number[] } }).fields.vertices).toEqual([0, 0, 12, 3, 10, 10, 0, 10]);
    expect((planInsertVertex(raw(), a, 0)[0] as unknown as { fields: { vertices: number[] } }).fields.vertices).toEqual([0, 0, 5, 0, 10, 0, 10, 10, 0, 10]);
    expect((planRemoveVertex(raw(), a, 0)[0] as unknown as { fields: { vertices: number[] } }).fields.vertices).toEqual([10, 0, 10, 10, 0, 10]);
    expect(() => planRemoveVertex(raw(), { ...a, name: "clip" }, 0)).toThrow(/at least 3/);
  });
  it("the clip end must be a slot and only clip masks have one", () => {
    expect(planSetClipEnd(raw(), { ...a, name: "clip" }, "fx")[0]).toMatchObject({ fields: { end: "fx" } });
    expect(() => planSetClipEnd(raw(), { ...a, name: "clip" }, "nope")).toThrow();
    expect(() => planSetClipEnd(raw(), a, "fx")).toThrow();
  });
});

describe("sequences", () => {
  it("reads padded and plain numbering", () => {
    expect(parseSequenceFrames(["fx/b_02", "fx/b_01", "fx/b_03"])).toEqual({ prefix: "fx/b_", start: 1, digits: 2, count: 3 });
    expect(parseSequenceFrames(["a7", "a8"])).toEqual({ prefix: "a", start: 7, digits: 0, count: 2 });
  });
  it("explains why a set is not a sequence", () => {
    expect(parseSequenceFrames(["a1"])).toMatch(/at least 2/);
    expect(parseSequenceFrames(["a1", "b2"])).toMatch(/share the same name/);
    expect(parseSequenceFrames(["a1", "a3"])).toMatch(/consecutive/);
    expect(parseSequenceFrames(["a", "b"])).toMatch(/end in a frame number/);
  });
  it("makes a region from picked frames and edits it", () => {
    const p = planSequenceFromPaths(raw(), { skin: "base", slot: "fx", paths: ["fx/boom_1", "fx/boom_2"], size: { width: 16, height: 16 } });
    expect(p.commands[0]).toMatchObject({ attachment: { type: "region", path: "fx/boom_", sequence: { count: 2, start: 1, digits: 0, setup: 0 } } });
    const set = planSetSequence(raw(), { skin: "base", slot: "body", name: "pic" }, { count: 4, setup: 9 });
    expect(set[0]).toMatchObject({ fields: { sequence: { count: 4, setup: 3 } } });
    expect(planSetSequence(raw(), { skin: "base", slot: "body", name: "pic" }, null)[0]).toMatchObject({ fields: { sequence: null } });
  });
  it("lists the slots that show sequences", () => {
    const r = raw();
    expect(sequenceSlots(r)).toEqual([]);
    ((r["skins"] as JsonObject)["base"] as JsonObject);
    (((r["skins"] as any).base.attachments.body.pic) as JsonObject)["sequence"] = { count: 2, start: 1, digits: 0, setup: 0 };
    expect(sequenceSlots(r)).toEqual(["body"]);
  });
});
