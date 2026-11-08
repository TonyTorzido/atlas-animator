import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { applyOps, planDeleteBone, planSetupTransform, runBatch, type JsonObject } from "./setupModel.js";
import { chainBonePlans, constraintSequence, deleteSummary, drawOrderOf, planAddOneBoneIk, planAddTransformConstraint, planBoneFields, planBoneLimits, planConstraintMove, planDeleteSlot, planDrawOrder, planDrawOrderTo, planNewSlot, planRenameSlot, planSlotLook } from "./setupRigPlans.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const valid = (raw: JsonObject) => expect(parseAnimDocument(raw).ok).toBe(true);
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  valid(r.doc);
  return r;
};

describe("bone fields", () => {
  it("sets scale, shear and limits, and clears limits; undo restores", () => {
    const raw = load();
    const r = apply(raw, planBoneFields(raw, "chest", { scaleX: 1.2, shearY: 5 }).commands);
    const b = (r.doc["bones"] as JsonObject[]).find((x) => x["name"] === "chest")!;
    expect(b["scaleX"]).toBe(1.2);
    expect(b["shearY"]).toBe(5);
    const l = apply(r.doc, planBoneLimits(r.doc, "chest", { min: -20, max: 30 }).commands);
    expect((l.doc["bones"] as JsonObject[]).find((x) => x["name"] === "chest")!["limits"]).toEqual({ min: -20, max: 30 });
    const c = apply(l.doc, planBoneLimits(l.doc, "chest", null).commands);
    expect((c.doc["bones"] as JsonObject[]).find((x) => x["name"] === "chest")!["limits"]).toBeUndefined();
    expect(applyOps(r.doc, r.inverse)).toEqual(raw);
  });
  it("refuses a zero scale and inverted limits", () => {
    const raw = load();
    expect(() => planBoneFields(raw, "chest", { scaleX: 0 })).toThrow();
    expect(() => planBoneLimits(raw, "chest", { min: 10, max: -10 })).toThrow();
  });
});

describe("slots", () => {
  it("adds a slot in front, renames it everywhere and deletes it, each undoable", () => {
    const raw = load();
    const n = planNewSlot(raw, "chest");
    const added = apply(raw, n.commands);
    const name = n.commands[0]!["name"] as string;
    expect(drawOrderOf(added.doc).at(-1)).toBe(name);
    const ren = planRenameSlot(added.doc, name, "my_slot");
    const renamed = apply(added.doc, ren.commands);
    expect(drawOrderOf(renamed.doc)).toContain("my_slot");
    expect(drawOrderOf(renamed.doc)).not.toContain(name);
    const del = apply(renamed.doc, planDeleteSlot(renamed.doc, "my_slot").commands);
    expect(drawOrderOf(del.doc)).not.toContain("my_slot");
    expect(applyOps(del.doc, del.inverse)).toEqual(renamed.doc);
  });
  it("renames a slot that has images and clip keys, and deletes one cleanly", () => {
    const raw = load();
    const skins = Object.values(raw["skins"] as Record<string, JsonObject>);
    const slot = (raw["slots"] as JsonObject[]).map((x) => x["name"] as string).find((n) => skins.some((k) => (k["attachments"] as JsonObject)[n] !== undefined))!;
    const r = apply(raw, planRenameSlot(raw, slot, "renamed_x").commands);
    const after = Object.values(r.doc["skins"] as Record<string, JsonObject>);
    expect(after.some((k) => (k["attachments"] as JsonObject)[slot] !== undefined)).toBe(false);
    expect(after.some((k) => (k["attachments"] as JsonObject)["renamed_x"] !== undefined)).toBe(true);
    apply(raw, planDeleteSlot(raw, slot).commands);
  });
  it("sets colour and blend", () => {
    const raw = load();
    const slot = (raw["slots"] as JsonObject[])[0]!["name"] as string;
    const r = apply(raw, planSlotLook(raw, slot, { color: "ff8000cc", blend: "additive" }).commands);
    const s = (r.doc["slots"] as JsonObject[]).find((x) => x["name"] === slot)!;
    expect(s["color"]).toBe("ff8000cc");
    expect(s["blend"]).toBe("additive");
    expect(() => planSlotLook(raw, slot, { color: "zz" })).toThrow();
  });
  it("moves a slot up, down, to front, to back and by drop", () => {
    let raw = load();
    const order0 = drawOrderOf(raw);
    const mid = order0[Math.floor(order0.length / 2)]!;
    const step = (plan: { commands: Parameters<typeof runBatch>[1] }) => (raw = apply(raw, plan.commands).doc);
    step(planDrawOrder(raw, mid, "up"));
    expect(drawOrderOf(raw).indexOf(mid)).toBe(order0.indexOf(mid) + 1);
    step(planDrawOrder(raw, mid, "down"));
    expect(drawOrderOf(raw)).toEqual(order0);
    step(planDrawOrder(raw, mid, "front"));
    expect(drawOrderOf(raw).at(-1)).toBe(mid);
    expect(planDrawOrder(raw, mid, "front").commands).toEqual([]);
    step(planDrawOrder(raw, mid, "back"));
    expect(drawOrderOf(raw)[0]).toBe(mid);
    step(planDrawOrderTo(raw, mid, order0.at(-1)!, "after"));
    expect(drawOrderOf(raw).at(-1)).toBe(mid);
  });
});

describe("constraints", () => {
  it("adds a 1-bone IK and a transform constraint at mix 0, and reorders constraints", () => {
    const raw = load();
    const ik = planAddOneBoneIk(raw, "chest");
    const a = apply(raw, ik.commands);
    expect((a.doc["ik"] as JsonObject[]).some((c) => c["name"] === ik.constraint && (c["bones"] as string[]).length === 1)).toBe(true);
    const tc = planAddTransformConstraint(a.doc, "head");
    const b = apply(a.doc, tc.commands);
    expect((b.doc["transform"] as JsonObject[]).some((c) => c["name"] === tc.constraint)).toBe(true);
    const seq = constraintSequence(b.doc);
    const last = seq.at(-1)!;
    const moved = apply(b.doc, planConstraintMove(b.doc, last.kind, last.name, "up").commands);
    expect(constraintSequence(moved.doc).map((c) => c.name)).toEqual([...seq.slice(0, -2).map((c) => c.name), last.name, seq.at(-2)!.name]);
    expect(planConstraintMove(b.doc, seq[0]!.kind, seq[0]!.name, "up").commands).toEqual([]);
    expect(applyOps(a.doc, a.inverse)).toEqual(raw);
  });
});

describe("chainBonePlans / deleteSummary", () => {
  it("counts what a delete touches", () => {
    const raw = load();
    const sum = deleteSummary(raw, ["chest"]);
    expect(sum.bones).toBe(1);
    expect(sum.children).toBe((raw["bones"] as { parent?: string }[]).filter((b) => b.parent === "chest").length);
    expect(sum.slots).toBe((raw["slots"] as { bone?: string }[]).filter((x) => x.bone === "chest").length);
  });
  it("joins several rotations into one batch, each bone turned", () => {
    const raw = load();
    const plan = chainBonePlans(raw, ["chest", "upper_arm_near"], (cur, name) => planSetupTransform(cur, name, { rotation: 15 }, false));
    expect(plan.commands).toHaveLength(2);
    const out = apply(raw, plan.commands).doc as unknown as { bones: { name: string; rotation?: number }[] };
    expect(out.bones.find((b) => b.name === "chest")?.rotation).toBe(15);
    expect(out.bones.find((b) => b.name === "upper_arm_near")?.rotation).toBe(15);
  });
  it("skips a bone an earlier step removed", () => {
    const raw = load();
    const plan = chainBonePlans(raw, ["hair_1_near", "hair_1_near"], (cur, name) => planDeleteBone(cur, name));
    expect(() => runBatch(raw, plan.commands)).not.toThrow();
  });
});
