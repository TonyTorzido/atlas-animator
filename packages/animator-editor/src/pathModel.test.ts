import { describe, expect, it } from "vitest";
import { addablePathBones, pathPoints, planAddPath, planAddPathConstraint, planInsertPathPoint, planMovePathVertex, planPathConstraintSet, planRemovePathPoint, planSetPathFlags } from "./pathModel.js";
import { runBatch, type JsonObject } from "./setupModel.js";
import { planImportSequence } from "./polyAttach.js";

const rig = (): JsonObject =>
  ({
    format: "atlas-anim@1",
    canvas: { width: 100, height: 100, originX: 50, originY: 50 },
    bones: [{ name: "root", length: 80 }, { name: "tail", parent: "root", length: 20 }],
    slots: [{ name: "body", bone: "root" }],
    skins: { body: { attachments: {} } },
    animations: {}
  }) as unknown as JsonObject;

const attOf = (doc: JsonObject) => ((doc["skins"] as Record<string, { attachments: Record<string, Record<string, JsonObject>> }>)["body"]!.attachments["body_path"] as Record<string, JsonObject>)["path"]!;

describe("path editing plans", () => {
  const added = planAddPath(rig(), { skin: "body", slot: "body" });
  const doc1 = runBatch(rig(), added.commands).doc;
  const ref = { skin: "body", slot: added.slot, name: added.attachment };

  it("adds a three-point open path in its own slot", () => {
    expect(added.slot).toBe("body_path");
    expect(pathPoints(attOf(doc1))).toHaveLength(3);
  });
  it("moving a point carries its handles; moving a handle moves only it", () => {
    const before = pathPoints(attOf(doc1))[1]!;
    const a = pathPoints(attOf(runBatch(doc1, planMovePathVertex(doc1, ref, 4, before.x + 5, before.y + 2)).doc))[1]!;
    expect(a.inX).toBeCloseTo(before.inX + 5);
    expect(a.outY).toBeCloseTo(before.outY + 2);
    const b = pathPoints(attOf(runBatch(doc1, planMovePathVertex(doc1, ref, 5, 1, 2)).doc))[1]!;
    expect([b.outX, b.outY, b.x]).toEqual([1, 2, before.x]);
  });
  it("inserting splits the curve and keeps its end points; removing respects the minimum", () => {
    const doc2 = runBatch(doc1, planInsertPathPoint(doc1, ref, 0)).doc;
    const pts = pathPoints(attOf(doc2));
    expect(pts).toHaveLength(4);
    expect(pts[0]!.x).toBe(0);
    expect(() => planInsertPathPoint(doc2, ref, 3)).toThrow();
    const doc3 = runBatch(doc2, planRemovePathPoint(doc2, ref, 1)).doc;
    expect(pathPoints(attOf(doc3))).toHaveLength(3);
    const two = runBatch(doc3, planRemovePathPoint(doc3, ref, 1)).doc;
    expect(() => planRemovePathPoint(two, ref, 0)).toThrow();
  });
  it("closed needs three points", () => {
    expect((attOf(runBatch(doc1, planSetPathFlags(doc1, ref, { closed: true })).doc) as JsonObject)["closed"]).toBe(true);
  });
});

describe("path constraint plans", () => {
  const doc = runBatch(rig(), planAddPath(rig(), { skin: "body", slot: "body" }).commands).doc;
  it("needs a path first", () => {
    expect(() => planAddPathConstraint(rig(), { bones: ["tail"] })).toThrow(/path/);
  });
  it("adds on a free bone and edits fields with validation", () => {
    const free = JSON.parse(JSON.stringify(doc)) as JsonObject;
    (free["bones"] as JsonObject[]).push({ name: "rope", parent: "root", length: 10 } as unknown as JsonObject);
    const plan = planAddPathConstraint(free, { bones: ["rope"] });
    const d = runBatch(free, plan.commands).doc;
    expect((d["path"] as JsonObject[])[0]!["target"]).toBe("body_path");
    const d2 = runBatch(d, planPathConstraintSet(d, plan.constraint, { position: 0.5, rotateMode: "chain" })).doc;
    expect((d2["path"] as JsonObject[])[0]!["rotateMode"]).toBe("chain");
    expect(() => planPathConstraintSet(d, plan.constraint, { mixX: 2 })).toThrow();
    expect(() => planPathConstraintSet(d, plan.constraint, { rotateMode: "spin" })).toThrow();
  });
});

describe("PNG sequence import plan", () => {
  it("makes atlas pages and one sequence attachment", () => {
    const plan = planImportSequence(rig(), { skin: "body", slot: "body", rigName: "r", frames: [{ name: "boom_01", width: 4, height: 4 }, { name: "boom_02", width: 4, height: 4 }] });
    expect(plan.pages).toHaveLength(2);
    const d = runBatch(rig(), plan.commands).doc;
    const a = (d["skins"] as Record<string, { attachments: Record<string, Record<string, JsonObject>> }>)["body"]!.attachments["body"]![plan.attachment]!;
    expect(a["sequence"]).toMatchObject({ count: 2, start: 1, digits: 2 });
    expect(a["path"]).toBe("body/body__boom_");
  });
  it("refuses a gap", () => {
    expect(() => planImportSequence(rig(), { skin: "body", slot: "body", rigName: "r", frames: [{ name: "a1", width: 1, height: 1 }, { name: "a3", width: 1, height: 1 }] })).toThrow();
  });
});

describe("addablePathBones (12c)", () => {
  const raw = {
    bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "b", parent: "a" }, { name: "c", parent: "b" }, { name: "side", parent: "root" }],
    slots: [{ name: "trail", bone: "b" }]
  };
  it("leaves out the slot's bone, the bones above it and bones already listed", () => {
    expect(addablePathBones(raw as never, "trail", [])).toEqual(["c", "side"]);
    expect(addablePathBones(raw as never, "trail", ["side"])).toEqual(["c"]);
  });
  it("a bone below a listed bone needs its parent listed first", () => {
    const deep = { bones: [{ name: "r" }, { name: "x", parent: "r" }, { name: "y", parent: "x" }, { name: "z", parent: "y" }, { name: "p" , parent: "r"}], slots: [{ name: "s", bone: "p" }] };
    expect(addablePathBones(deep as never, "s", ["x"])).toEqual(["y"]);
  });
});
