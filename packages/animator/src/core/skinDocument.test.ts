import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "./attachments.js";
import { formatIssue } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import {
  mergeSkinDocuments,
  parseSkinDocument,
  type MergeIssue,
  type MergeResult,
  type SkinDocument,
  type SkinDocumentInput
} from "./skinDocument.js";
import { testDocument } from "./testHelpers.js";

const rig = () =>
  testDocument({
    revision: 3,
    bones: [{ name: "root" }, { name: "chest", parent: "root" }, { name: "hand_r", parent: "chest", x: 30 }],
    slots: [
      { name: "torso", bone: "chest", attachment: "torso" },
      { name: "torso_cloth", bone: "chest", attachment: "torso_cloth" },
      { name: "hair", bone: "chest", attachment: "hair" },
      { name: "held_r", bone: "hand_r", attachment: "held_r" }
    ],
    skins: {
      body: {
        attachments: {
          torso: {
            torso: {
              type: "mesh",
              path: "body/torso",
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              vertices: [-10, -10, 10, -10, 10, 10, -10, 10],
              hull: 4,
              width: 20,
              height: 20
            }
          },
          hair: { hair: { type: "region", path: "body/hair", width: 10, height: 6 } }
        }
      }
    }
  });

// The rig in these tests is named "test" (testDocument).
const tunic: SkinDocumentInput = {
  format: "atlas-skin@1",
  name: "tunic-green",
  template: { name: "test", revision: 3 },
  skin: {
    attachments: {
      torso_cloth: {
        torso_cloth: {
          type: "linkedMesh",
          path: "swag/tunic-green/torso",
          source: { skin: "body", slot: "torso", attachment: "torso" },
          width: 20,
          height: 20
        }
      }
    }
  }
};

const cape: SkinDocumentInput = {
  format: "atlas-skin@1",
  name: "cape-red",
  template: { name: "test", revision: 2 },
  bones: [
    { name: "cape-red.1", parent: "chest", y: 5, rotation: 90, length: 20 },
    { name: "cape-red.2", parent: "cape-red.1", x: 20, length: 20 }
  ],
  slots: [{ name: "cape-red", bone: "cape-red.2", attachment: "cape", drawBefore: "torso" }],
  skin: { attachments: { "cape-red": { cape: { type: "region", path: "swag/cape-red", width: 30, height: 40 } } }, hides: ["hair"] },
  physics: [{ name: "cape-red.swing", bone: "cape-red.1", rotate: 1 }],
  driven: [{ name: "cape-red.lift", bone: "hand_r", keys: [{ at: 0 }, { at: 90, attachments: { "cape-red": null } }] }]
};

/** Error issues of a merge (warnings dropped). */
function errors(result: MergeResult): MergeIssue[] {
  return result.ok ? [] : result.issues.filter((issue) => issue.severity === "error");
}

function parsed(input: SkinDocumentInput): SkinDocument {
  const result = parseSkinDocument(input);
  if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
  return result.document;
}

describe("skin documents", () => {
  it("parse with defaults", () => {
    const doc = parsed(tunic);
    expect(doc.bones).toEqual([]);
    expect(doc.skin.hides).toEqual([]);
  });

  it("reject bones and constraints that are not skin-gated, and slots without a placement", () => {
    const result = parseSkinDocument({
      ...cape,
      bones: [{ name: "x", parent: "chest", skin: false }],
      slots: [{ name: "s", bone: "x" }],
      ik: [{ name: "k", bones: ["x"], target: "chest", skin: false }]
    });
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.issues.map(formatIssue);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^bones\[0\]\.skin: .*always skin bones/),
        expect.stringMatching(/^slots\[0\]\.drawAfter: give exactly one of 'drawAfter' and 'drawBefore'/),
        expect.stringMatching(/^ik\[0\]\.skin: .*always skin constraints/)
      ])
    );
  });

  it("reject unknown fields and a wrong format", () => {
    const result = parseSkinDocument({ ...tunic, format: "atlas-anim@1", colour: "red" });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual(
      expect.arrayContaining([`format: expected "atlas-skin@1"`, "(document): unknown field 'colour'"])
    );
  });
});

describe("merging skin documents into a rig", () => {
  it("adds skins, skin bones, slots, constraints and gated driven keys", () => {
    const result = mergeSkinDocuments(rig(), [parsed(tunic), parsed(cape)]);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
    const doc = result.document;
    expect(Object.keys(doc.skins)).toEqual(["body", "tunic-green", "cape-red"]);
    expect(doc.skins["cape-red"]?.bones).toEqual(["cape-red.1", "cape-red.2"]);
    expect(doc.skins["cape-red"]?.constraints).toEqual(["cape-red.swing"]);
    expect(doc.skins["cape-red"]?.hides).toEqual(["hair"]);
    expect(doc.bones.slice(-2).map((bone) => [bone.name, bone.skin])).toEqual([
      ["cape-red.1", true],
      ["cape-red.2", true]
    ]);
    expect(doc.physics.map((c) => [c.name, c.skin])).toEqual([["cape-red.swing", true]]);
    expect(doc.driven.map((set) => [set.name, set.skin])).toEqual([["cape-red.lift", "cape-red"]]);
    expect(doc.drawOrder).toEqual(["cape-red", "torso", "torso_cloth", "hair", "held_r"]);
    // The anchor stays on the merged slot (plan 4.4, anchored slots).
    expect(doc.slots.at(-1)).toEqual({ name: "cape-red", bone: "cape-red.2", attachment: "cape", color: "ffffffff", blend: "normal", drawBefore: "torso" });
    // The cape item targets revision 2 of a revision-3 rig.
    expect(result.warnings.map((issue) => `${issue.document}: ${formatIssue(issue)}`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^cape-red\.skin: warning: template\.revision: made for revision 2/)])
    );
  });

  it("the merged rig runs: tunic rides the body torso, cape bones activate with the cape", () => {
    const result = mergeSkinDocuments(rig(), [parsed(tunic), parsed(cape)]);
    if (!result.ok) throw new Error("merge failed");
    const skeleton = new Skeleton(result.document);
    skeleton.setActiveSkins(["body", "tunic-green"]);
    skeleton.updateWorldTransform();
    const cloth = skeleton.getSlot("torso_cloth").attachment as MeshAttachment;
    expect(cloth.linkedTo).toBe(skeleton.getSlot("torso").attachment);
    expect(skeleton.getBone("cape-red.1").active).toBe(false);
    expect(skeleton.isConstraintActive("physics", 0)).toBe(false);
    skeleton.setActiveSkins(["body", "tunic-green", "cape-red"]);
    skeleton.updateWorldTransform();
    expect(skeleton.getBone("cape-red.2").active).toBe(true);
    expect(skeleton.isConstraintActive("physics", 0)).toBe(true);
    expect(skeleton.getSlot("hair").attachment).toBeNull();
    // The cape is drawn behind the torso; its gated driven key hides it with the hand raised.
    expect(skeleton.drawOrder[0]?.data.name).toBe("cape-red");
    expect(skeleton.getSlot("cape-red").attachment).not.toBeNull();
    skeleton.getBone("hand_r").pose.rotation = 90;
    skeleton.updateWorldTransform();
    expect(skeleton.getSlot("cape-red").attachment).toBeNull();
  });

  it("stacks items placed against the same anchor in merge order", () => {
    const a = parsed({ ...cape, name: "a", bones: [], physics: [], driven: [], skin: {}, slots: [{ name: "a1", bone: "chest", drawAfter: "torso" }] });
    const b = parsed({ ...cape, name: "b", bones: [], physics: [], driven: [], skin: {}, slots: [{ name: "b1", bone: "chest", drawAfter: "torso" }] });
    const c = parsed({ ...cape, name: "c", bones: [], physics: [], driven: [], skin: {}, slots: [{ name: "c1", bone: "chest", drawBefore: "torso" }] });
    const d = parsed({ ...cape, name: "d", bones: [], physics: [], driven: [], skin: {}, slots: [{ name: "d1", bone: "chest", drawBefore: "torso" }] });
    const result = mergeSkinDocuments(rig(), [a, b, c, d]);
    expect(result.ok && result.document.drawOrder).toEqual(["c1", "d1", "torso", "a1", "b1", "torso_cloth", "hair", "held_r"]);
  });

  it("an item anchored to an earlier item's slot travels in that slot's group", () => {
    const item = (name: string, slot: string, after: string) =>
      parsed({ ...cape, name, bones: [], physics: [], driven: [], skin: {}, slots: [{ name: slot, bone: "chest", drawAfter: after }] });
    const result = mergeSkinDocuments(rig(), [item("a", "a1", "torso"), item("b", "b1", "a1"), item("c", "c1", "torso")]);
    expect(result.ok && result.document.drawOrder).toEqual(["torso", "a1", "b1", "c1", "torso_cloth", "hair", "held_r"]);
  });

  it("refuses an item made for another rig or a newer revision", () => {
    const other = mergeSkinDocuments(rig(), [parsed({ ...tunic, template: { name: "wolf", revision: 1 } })]);
    const newer = mergeSkinDocuments(rig(), [parsed({ ...tunic, template: { name: "test", revision: 4 } })]);
    expect(other.ok ? [] : other.issues.map((issue) => `${issue.document}: ${formatIssue(issue)}`)).toEqual([
      "tunic-green.skin: template.name: made for rig 'wolf', not 'test'"
    ]);
    expect(newer.ok ? [] : newer.issues.map(formatIssue)).toEqual([
      "template.revision: made for revision 4 of 'test', but the rig is at revision 3"
    ]);
  });

  it("refuses name collisions with the rig and between items", () => {
    const clash = parsed({
      ...cape,
      name: "body",
      bones: [{ name: "chest", parent: "root" }],
      slots: [{ name: "hair", bone: "chest", drawAfter: "torso" }]
    });
    const result = mergeSkinDocuments(rig(), [clash]);
    expect(errors(result).map(formatIssue)).toEqual(["name: the rig (or an item merged earlier) already has a skin named 'body'"]);
    const twice = mergeSkinDocuments(rig(), [parsed(cape), parsed({ ...cape, name: "cape-blue" })]);
    expect(twice.ok ? [] : twice.issues.map((issue) => `${issue.document}: ${formatIssue(issue)}`)).toEqual(
      expect.arrayContaining([
        "cape-blue.skin: bones[0].name: bone 'cape-red.1' already exists",
        "cape-blue.skin: slots[0].name: slot 'cape-red' already exists",
        "cape-blue.skin: physics[0].name: constraint 'cape-red.swing' already exists",
        "cape-blue.skin: driven[0].name: driven key set 'cape-red.lift' already exists"
      ])
    );
  });

  it("refuses unknown draw-order anchors and foreign driven gates", () => {
    const result = mergeSkinDocuments(rig(), [
      parsed({
        ...cape,
        slots: [{ name: "cape-red", bone: "cape-red.2", drawAfter: "nowhere" }],
        driven: [{ name: "x", bone: "chest", skin: "body", keys: [{ at: 0 }] }]
      })
    ]);
    expect(errors(result).map(formatIssue)).toEqual([
      "driven[0].skin: a skin document's driven keys are gated on its own skin 'cape-red'; omit 'skin'",
      "slots[0].drawAfter: unknown slot 'nowhere'"
    ]);
  });

  it("validates the merged document as a whole (broken references name the merged path)", () => {
    const broken = parsed({
      ...tunic,
      skin: {
        attachments: {
          torso_cloth: {
            torso_cloth: {
              type: "linkedMesh",
              path: "swag/x",
              source: { skin: "body", slot: "torso", attachment: "nope" },
              width: 1,
              height: 1
            }
          }
        }
      }
    });
    const result = mergeSkinDocuments(rig(), [broken]);
    expect(errors(result).map((issue) => `${issue.document}: ${formatIssue(issue)}`)).toEqual([
      'merged: skins["tunic-green"].attachments.torso_cloth.torso_cloth.source: source mesh \'body/torso/nope\' does not exist'
    ]);
  });

  it("does not modify the rig", () => {
    const base = rig();
    const before = JSON.stringify(base);
    mergeSkinDocuments(base, [parsed(tunic), parsed(cape)]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("keeps anchors through a merge, and the merged result re-validates them", () => {
    const result = mergeSkinDocuments(rig(), [parsed(cape)]);
    if (!result.ok) throw new Error("merge failed");
    const again = mergeSkinDocuments(result.document, [parsed({ ...tunic, template: { name: "test", revision: 3 } })]);
    expect(again.ok && again.document.slots.find((slot) => slot.name === "cape-red")?.drawBefore).toBe("torso");
  });
});

describe("skin documents: driven grids (Phase)", () => {
  const grid = { name: "pauldron.combo", x: { bone: "chest", at: [0, 90] }, y: { bone: "hand_r", at: [0, 45] }, keys: [{}, {}, {}, { deform: { body: { torso: { torso: { vertices: [4, 0] } } } } }] };

  it("merge gated on the item's skin, so the correction applies only while it is worn", () => {
    const result = mergeSkinDocuments(rig(), [parsed({ ...tunic, drivenGrids: [grid] })]);
    if (!result.ok) throw new Error(result.issues.map(formatIssue).join("\n"));
    expect(result.document.drivenGrids?.[0]).toMatchObject({ name: "pauldron.combo", skin: "tunic-green" });
    const skeleton = new Skeleton(result.document);
    const torso = () => skeleton.getAttachment(skeleton.getSlot("torso"), "torso") as MeshAttachment;
    skeleton.setActiveSkins(["body"]);
    skeleton.getBone("chest").pose.rotation = 90;
    skeleton.getBone("hand_r").pose.rotation = 45;
    skeleton.updateWorldTransform();
    expect(skeleton.deformFor(torso())).toBeNull();
    skeleton.setActiveSkins(["body", "tunic-green"]);
    skeleton.updateWorldTransform();
    expect(skeleton.deformFor(torso())?.[0]).toBeCloseTo(4, 5);
  });

  it("reject a foreign skin gate and a duplicate grid name", () => {
    const result = mergeSkinDocuments(rig(), [
      parsed({ ...tunic, drivenGrids: [{ ...grid, skin: "body" }] }),
      parsed({ ...cape, template: { name: "test", revision: 3 }, drivenGrids: [grid] })
    ]);
    const messages = errors(result).map((issue) => `${issue.document} ${formatIssue(issue)}`);
    expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/tunic-green\.skin drivenGrids\[0\]\.skin: .*gated on its own skin/)]));
    const second = mergeSkinDocuments(rig(), [parsed({ ...tunic, drivenGrids: [grid] }), parsed({ ...cape, template: { name: "test", revision: 3 }, drivenGrids: [grid] })]);
    expect(errors(second).map(formatIssue)).toEqual(expect.arrayContaining([expect.stringMatching(/driven grid 'pauldron\.combo' already exists/)]));
  });
});
