import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyCommands } from "../../animator/src/tools/commands.js";
import { buildItemBatch, issueChip, itemIdFrom, mapPieces, partLabel, pieceStem, skinsWithout, stillNeeded, wearList } from "./swagWorkshopModel.js";
import { clipRows, pageCount, pageRows, POSE_SWEEPS, sheetFrames, sweepRows } from "./contactSheetModel.js";
import type { JsonObject } from "./setupModel.js";

const raw = (): JsonObject => JSON.parse(readFileSync(new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url), "utf8")) as JsonObject;
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("mapping", () => {
  it("normalises file names", () => expect(pieceStem("C:/x/Upper Arm-Near.PNG")).toBe("upper_arm_near"));
  it("maps by slot name, short name or item-slot prefix; leftovers stay unmatched", () => {
    const m = mapPieces("chest", ["torso", "shirt_sleeve_near", "chest_skin_arm_far", "mystery", "torso_copy"]);
    expect(m.mapped).toEqual({ torso: "shirt_torso", shirt_sleeve_near: "shirt_sleeve_near", chest_skin_arm_far: "skin_arm_far" });
    expect(m.unmatched).toEqual(["mystery", "torso_copy"]);
  });
  it("never maps two pieces to one slot", () => expect(mapPieces("chest", ["torso", "shirt_torso"]).unmatched).toEqual(["shirt_torso"]));
  it("reports what an item still needs and labels parts", () => {
    expect(stillNeeded("pants", ["pants_waist"])).toContain("pants_thigh_near");
    expect(partLabel("shirt_sleeve_near")).toBe("Sleeve (near side)");
    expect(partLabel("skin_arm_far")).toBe("Skin arm (far side)");
    expect(partLabel("gloves_hand_far_back")).toBe("Hand, back (far side)");
  });
  it("makes ids", () => expect(itemIdFrom(" Red Jerkin! ")).toBe("red-jerkin"));
});

describe("chips and wearing", () => {
  it("speaks plainly", () => {
    expect(issueChip({ kind: "missing piece", view: "turned", slot: "shirt_torso", message: "" }).text).toBe("The side view is missing the torso");
    expect(issueChip({ kind: "size", view: "turned", slot: "shirt_torso", message: "turned: shirt_torso/torso width is 70% of the base piece" }).text).toContain("too small");
  });
  it("wears one item per slot, newest wins, only what the rig has", () => {
    expect(wearList(["chest.a", "chest.b", "pants.p", "boots.x"], new Set(["chest.a", "chest.b", "pants.p"]))).toEqual(["chest.b", "pants.p"]);
  });
});

describe("saving", () => {
  it("builds a batch the command engine accepts, with one atlas page per piece", () => {
    const r = raw();
    const batch = buildItemBatch(r, { slot: "chest", item: "test-vest", rigName: "kit-body-front0", pieces: [{ rigSlot: "shirt_torso", width: 40, height: 50, png: PNG, x: 3, y: -2, rotation: 5 }] });
    expect(batch.skin).toBe("chest.test-vest");
    expect(batch.images).toHaveLength(1);
    expect(batch.images[0]!.file).toMatch(/imp-test-vest-shirt_torso\.png$/);
    const out = applyCommands(r, batch.commands, { check: "command" }).doc as { skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }> };
    expect(out.skins["chest.test-vest"]!.attachments["shirt_torso"]!["torso"]).toMatchObject({ type: "region", x: 3, y: -2, rotation: 5 });
  });
  it("adds the slot a pro rig lacks and the helmet's hides", () => {
    const r = raw();
    const batch = buildItemBatch(r, { slot: "helmet", item: "cap", rigName: "kit", pieces: [{ rigSlot: "helmet", width: 90, height: 60, png: PNG, x: 0, y: 0, rotation: 0 }] });
    const out = applyCommands(r, batch.commands, { check: "command" }).doc as { slots: { name: string; bone: string }[]; skins: Record<string, { hides?: string[] }> };
    expect(out.slots.find((s) => s.name === "helmet")?.bone).toBe("head");
    expect(out.skins["helmet.cap"]!.hides).toEqual(["hair_front", "hair_back"]);
  });
  it("refuses duplicates, strangers and empty items", () => {
    const piece = { rigSlot: "shirt_torso", width: 4, height: 4, png: PNG, x: 0, y: 0, rotation: 0 };
    expect(() => buildItemBatch(raw(), { slot: "chest", item: "leather", rigName: "k", pieces: [piece] })).toThrow(/already/);
    expect(() => buildItemBatch(raw(), { slot: "pants", item: "x", rigName: "k", pieces: [piece] })).toThrow(/not a pants/);
    expect(() => buildItemBatch(raw(), { slot: "chest", item: "x", rigName: "k", pieces: [] })).toThrow(/at least one/);
  });
  it("deletes by leaving the skin out", () => expect(Object.keys(skinsWithout(raw(), "chest.leather"))).toEqual(["body", "chest.jacket_b"]));
});

describe("contact sheet model", () => {
  it("samples first, contact, middle and last", () => {
    const f = sheetFrames({ duration: 0.9, loop: false, events: [{ time: 0.4, name: "hit" }] } as never);
    expect(f.map((x) => x.label)).toEqual(["First", "Contact", "Middle", "Last"]);
    expect(f.map((x) => x.t)).toEqual([0, 0.4, 0.45, 0.9]);
    expect(sheetFrames({ duration: 1, loop: true, events: [] } as never)[3]!.t).toBeLessThan(1);
  });
  it("lists only clips that exist, pages them, and sweeps four poses on four bones", () => {
    expect(clipRows(new Set(["idle", "nope"])).map((r) => r.key)).toEqual(["idle"]);
    expect(clipRows(new Set(["idle_weight_shift"]))[0]!.clipName).toBe("idle_weight_shift");
    expect(clipRows(new Set())).toEqual([]);
    expect(sweepRows()).toHaveLength(POSE_SWEEPS.length);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(5)).toBe(3);
    expect(pageRows([1, 2, 3, 4, 5], 2)).toEqual([5]);
  });
});
