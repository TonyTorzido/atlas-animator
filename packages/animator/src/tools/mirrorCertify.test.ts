import { describe, expect, it } from "vitest";
import { bodyBudget, compareFindings, companionWithPoses, skinAloneDoc } from "./mirrorCertify.js";
import type { GeometryFinding } from "./validateGeometry.js";

/* review 2 / 8, 11: the half baseline's poses, per-pose/per-triangle comparison, skin-alone weld, budget. */
const f = (id: string, pose: string): GeometryFinding => ({ id, kind: id.split("/")[0] as GeometryFinding["kind"], severity: "error", pose, mesh: "torso/skin", region: "r", value: 2, absGamePx: 1 });

describe("mirror certification helpers", () => {
  it("the half companion carries the projected poses (the validator prefers companion poses)", () => {
    const half = { format: "x", poses: Array.from({ length: 1526 }, (_, i) => ({ name: `p${i}` })) };
    expect(companionWithPoses(half, [{ name: "a" }, { name: "b" }]).poses).toHaveLength(2);
  });
  it("compares findings per pose and per triangle, not by totals", () => {
    const merged = [f("stretch/torso/skin/t3", "A"), f("stretch/torso/skin/t4", "A"), f("stretch/torso/skin/t13", "A")];
    const half = [f("stretch/torso/skin/t3", "A"), f("stretch/torso/skin/t4", "B"), f("stretch/torso/skin/t5", "A")];
    // Same totals (3 vs 3) but: t3@A inherited, t4@A introduced, t13 is the mirror side, t4@B and t5@A resolved.
    expect(compareFindings(merged, half, { "torso/skin": 10 })).toMatchObject({ inherited: 1, introduced: 1, rightSide: 1, resolved: 2 });
    // Restricted to the shared pose set: findings at other poses (clip samples) are not compared.
    expect(compareFindings([...merged, f("stretch/torso/skin/t6", "'clip' at 0.30s")], half, { "torso/skin": 10 }, new Set(["A", "B"]))).toMatchObject({ inherited: 1, introduced: 1, rightSide: 1, resolved: 2 });
  });
  it("skin-alone weld document keeps only the mesh slot and its group slots, no strokes", () => {
    const doc = {
      slots: [{ name: "torso", attachment: "skin" }, { name: "tank", attachment: "tank" }, { name: "upper_arm", attachment: null }, { name: "head", attachment: "head" }],
      skins: { body: { attachments: { torso: { skin: { type: "mesh", groups: { upper_arm: [[0, 1]] } } } }, contours: { torso: {} } } },
      contactBands: []
    };
    const d = skinAloneDoc(doc, "torso", "skin");
    expect(d.slots.map((s: { attachment: string | null }) => s.attachment)).toEqual(["skin", null, null, null]);
    expect(d.skins.body.contours).toBeUndefined();
    expect(doc.slots[1]?.attachment).toBe("tank");
  });
  it("budget: whole-body derivation and the dressed-character figure", () => {
    const doc = { skins: { body: { attachments: { torso: { skin: { type: "mesh", uvs: new Array(700).fill(0) } }, tank: { tank: { type: "mesh", uvs: new Array(400).fill(0) } }, head: { head: { type: "region" } } } } } };
    const b = bodyBudget(doc, { skin: 180, garment: 110 }, "torso/skin", 7);
    expect(b.submitted).toMatchObject({ skin: 350, garments: 200, regionVertices: 4, total: 554 });
    expect(b.wholeUpperBodyDerived).toEqual({ skin: 353, garment: 220 });
    expect(b.tunic).toEqual({ declared: 260, redeclared: 280 });
    expect(b.remainingForLegsAndHair).toBe(2500 - (554 + 280 + 8));
  });
});
