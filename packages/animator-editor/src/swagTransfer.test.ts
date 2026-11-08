import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAnimDocument, Skeleton, type MeshAttachment } from "@atlas-animator/core/core";
import type { JsonObject } from "./setupModel.js";
import { boneWorlds, findSource, piecePixelAt, pieceLocalPoint, planTransfer, planTransfers, restLocal } from "./swagTransfer.js";

const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../animator/rigs/kit-body-cutout/kit-body-cutout.anim.json", import.meta.url)), "utf8")) as JsonObject;
const rawAny = raw as Record<string, any>;

describe("swag mesh and weight transfer", () => {
  it("rest positions match the engine's skinned setup pose (in the slot bone frame)", () => {
    const sk = new Skeleton(loadAnimDocument({ ...structuredClone(raw), animations: {} } as never));
    sk.setActiveSkins([Object.keys(rawAny.skins)[0]!]);
    sk.setToSetupPose();
    sk.updateWorldTransform("none");
    const slot = sk.getSlot("skin_arm_near");
    const att = sk.getAttachment(slot, "mesh") as MeshAttachment;
    const world = sk.meshWorldVertices(att, slot.bone);
    const mine = restLocal(rawAny.skins.body.attachments.skin_arm_near.mesh, "upper_arm_near", boneWorlds(raw));
    const bw = slot.bone.world;
    const det = bw.a * bw.d - bw.b * bw.c;
    for (let i = 0; i < world.length / 2; i += 97) {
      const dx = world[i * 2]! - bw.x;
      const dy = world[i * 2 + 1]! - bw.y;
      expect(mine[i * 2]).toBeCloseTo((bw.d * dx - bw.b * dy) / det, 0);
      expect(mine[i * 2 + 1]).toBeCloseTo((-bw.c * dx + bw.a * dy) / det, 0);
    }
  });

  it("piece pixel and bone point are inverses", () => {
    const p = { width: 80, height: 120, x: 5, y: -7, rotation: 23, scale: 1.3 };
    const l = pieceLocalPoint(p, 10, 90);
    const back = piecePixelAt(p, l.x, l.y);
    expect(back.x).toBeCloseTo(10, 6);
    expect(back.y).toBeCloseTo(90, 6);
  });

  it("a piece fitted to a base mesh becomes a linked mesh (Tier A)", () => {
    const t = planTransfer(raw, { rigSlot: "skin_arm_near", placeholder: "mesh", width: 169, height: 229, x: 0, y: 0, rotation: 0, scale: 1 });
    expect(t.report.tier).toBe("A");
    expect(t.attachment).toMatchObject({ type: "linkedMesh", source: { skin: "body", slot: "skin_arm_near", attachment: "mesh" }, inheritDeform: true, width: 169, height: 229 });
  });

  it("a sleeve of another size is an own mesh with the weights copied (Tier B), at least two bones", () => {
    const t = planTransfer(raw, { rigSlot: "shirt_sleeve_near", placeholder: "sleeve", width: 120, height: 210, x: 0, y: 0, rotation: 0, scale: 1 });
    expect(t.report.tier).toBe("B");
    const m = t.attachment as Record<string, any>;
    expect(m.type).toBe("mesh");
    expect(new Set(m.bones).size).toBeGreaterThanOrEqual(2);
    expect(m.uvs.length / 2).toBe(m.vertices.length ? t.report.vertices : 0);
    expect(m.uvs.every((u: number) => u >= 0 && u <= 1)).toBe(true);
  });

  it("art cut for an item's own mesh (the Leather torso at its own size) learns from that mesh, not another item's", () => {
    const t = planTransfer(raw, { rigSlot: "shirt_torso", placeholder: "torso", width: 239, height: 291, x: 0, y: 0, rotation: 0, scale: 1 });
    expect(t.report.source).toMatchObject({ skin: "chest.leather", slot: "shirt_torso" });
    expect(t.attachment).toMatchObject({ type: "mesh" });
  });

  it("with no sleeve mesh in any skin the body arm is the twin the weights come from", () => {
    const bare = structuredClone(rawAny);
    for (const k of Object.keys(bare.skins)) if (k !== "body") delete bare.skins[k];
    const src = findSource(bare, "shirt_sleeve_near", "sleeve");
    expect(src).toMatchObject({ how: "twin", slot: "skin_arm_near" });
    const t = planTransfers(bare, [{ rigSlot: "shirt_sleeve_near", width: 150, height: 220, x: 0, y: 0, rotation: 0 }]);
    expect(t["shirt_sleeve_near"]!.report.tier).toBe("B");
    expect(t["shirt_sleeve_near"]!.report.bones).toBeGreaterThanOrEqual(2);
  });

  it("a slot without any mesh stays a region", () => {
    const t = planTransfer(raw, { rigSlot: "weapon", placeholder: "weapon", width: 30, height: 200, x: 0, y: 0, rotation: 0 });
    expect(t.report.tier).toBe("region");
    expect(t.attachment).toBeNull();
  });

  it("the produced mesh passes the engine loader", () => {
    const t = planTransfer(raw, { rigSlot: "shirt_sleeve_near", placeholder: "sleeve", width: 120, height: 210, x: 3, y: 4, rotation: 10, scale: 1.1 });
    const doc = structuredClone(rawAny);
    doc.skins["chest.qa_t"] = { attachments: { shirt_sleeve_near: { sleeve: { ...t.attachment, path: "chest.qa_t/shirt_sleeve_near__sleeve" } } } };
    expect(() => loadAnimDocument({ ...doc, animations: {} } as never)).not.toThrow();
  });
});
