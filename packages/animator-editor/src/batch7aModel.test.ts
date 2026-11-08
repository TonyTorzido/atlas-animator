import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { applyOps, runBatch, type JsonObject } from "./setupModel.js";
import { planAddPoint, planAttachmentTransform } from "./setupAttach.js";
import { constraintSequence, planAddPhysics } from "./setupRigPlans.js";
import { physicsConstraints, planConstraintSet, planRemoveConstraint } from "./setupConstraints.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  expect(parseAnimDocument(r.doc).ok).toBe(true);
  return r;
};

describe("physics constraints (Batch 7a, RG-08)", () => {
  it("adds a physics constraint, edits it with range checks, orders it after IK / transform and removes it; undo restores", () => {
    const raw = load();
    const add = planAddPhysics(raw, "chest");
    const r = apply(raw, add.commands);
    const view = physicsConstraints(r.doc).find((p) => p.name === add.constraint)!;
    expect(view.bone).toBe("chest");
    expect(view.values.rotate).toBe(1);
    expect(view.values.fps).toBe(60);
    expect(constraintSequence(r.doc).at(-1)).toMatchObject({ kind: "physics", name: add.constraint });
    const set = apply(r.doc, planConstraintSet(r.doc, "physics", add.constraint, { gravity: 40, damping: 0.5 }));
    expect(physicsConstraints(set.doc)[0]!.values.gravity).toBe(40);
    expect(() => planConstraintSet(r.doc, "physics", add.constraint, { damping: 2 })).toThrow();
    expect(() => planConstraintSet(r.doc, "physics", add.constraint, { fps: 0 })).toThrow();
    expect(() => planConstraintSet(r.doc, "physics", add.constraint, { fps: 30.5 })).toThrow();
    expect(() => planConstraintSet(r.doc, "physics", add.constraint, { bone: "nope" })).toThrow();
    const gone = apply(set.doc, planRemoveConstraint(set.doc, "physics", add.constraint));
    expect(physicsConstraints(gone.doc)).toHaveLength(0);
    expect(applyOps(set.doc, set.inverse)).toEqual(r.doc);
    expect(applyOps(r.doc, r.inverse)).toEqual(raw);
  });
  it("refuses a second physics on the same bone and a missing bone", () => {
    const raw = load();
    const r = apply(raw, planAddPhysics(raw, "chest").commands);
    expect(() => planAddPhysics(r.doc, "chest")).toThrow();
    expect(() => planAddPhysics(raw, "nope")).toThrow();
  });
});

describe("point attachments (Batch 7a, RG-07)", () => {
  it("adds named grip / tip / point attachments, moves and turns them, refuses scale, and undo restores", () => {
    const raw = load();
    const slot = (raw["slots"] as JsonObject[])[0]!["name"] as string;
    const grip = planAddPoint(raw, { skin: "body", slot, preset: "grip" });
    expect(grip.attachment).toBe("grip");
    const r = apply(raw, grip.commands);
    const atts = ((r.doc["skins"] as JsonObject)["body"] as JsonObject)["attachments"] as JsonObject;
    expect((atts[slot] as JsonObject)["grip"]).toMatchObject({ type: "point" });
    const second = planAddPoint(r.doc, { skin: "body", slot, preset: "grip" });
    expect(second.attachment).not.toBe("grip");
    const moved = apply(r.doc, planAttachmentTransform(r.doc, { skin: "body", slot, name: "grip" }, { x: 5, y: -3, rotation: 90 }));
    const g = ((((moved.doc["skins"] as JsonObject)["body"] as JsonObject)["attachments"] as JsonObject)[slot] as JsonObject)["grip"] as JsonObject;
    expect(g).toMatchObject({ x: 5, y: -3, rotation: 90 });
    expect(() => planAttachmentTransform(r.doc, { skin: "body", slot, name: "grip" }, { scaleX: 2 })).toThrow();
    expect(() => planAddPoint(raw, { skin: "body", slot: "nope" })).toThrow();
    expect(applyOps(r.doc, r.inverse)).toEqual(raw);
  });
});
