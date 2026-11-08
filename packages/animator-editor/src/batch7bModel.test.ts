import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { applyOps, runBatch, type JsonObject } from "./setupModel.js";
import { linkCandidates, linkedDependants, linkSourceOf, planLinkMesh, planSetInherit, planUnlinkMesh } from "./meshLink.js";
import { psdReportLines, readPsd } from "./psdRead.js";
import { modelFromMesh, redrawHull, resetUvs, transformVertices } from "./meshModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  expect(parseAnimDocument(r.doc).ok).toBe(true);
  return r;
};
const far = { skin: "body", slot: "shirt_tip_far", name: "tip" };
const near = { skin: "body", slot: "shirt_tip_near", name: "tip" };

describe("linked meshes (Batch 7b, )", () => {
  it("links an image to another mesh, flips the deform inheritance, unlinks it back to the same shape, and undo restores", () => {
    const raw = load();
    expect(linkCandidates(raw, far).some((c) => c.slot === "shirt_tip_near")).toBe(true);
    const linked = apply(raw, planLinkMesh(raw, far, near));
    const att = (linked.doc["skins"] as any).body.attachments.shirt_tip_far.tip;
    expect(att).toMatchObject({ type: "linkedMesh", source: { skin: "body", slot: "shirt_tip_near", attachment: "tip" }, inheritDeform: true, width: 56, height: 47 });
    expect(linkSourceOf(linked.doc, far)).toEqual(near);
    expect(linkedDependants(linked.doc, near).map((d) => d.slot)).toContain("shirt_tip_far");
    const off = apply(linked.doc, planSetInherit(linked.doc, far, false));
    expect((off.doc["skins"] as any).body.attachments.shirt_tip_far.tip.inheritDeform).toBe(false);
    const back = apply(off.doc, planUnlinkMesh(off.doc, far));
    const own = (back.doc["skins"] as any).body.attachments.shirt_tip_far.tip;
    const src = (back.doc["skins"] as any).body.attachments.shirt_tip_near.tip;
    expect(own.type).toBe("mesh");
    expect(own.triangles).toEqual(src.triangles);
    expect(own.vertices).toEqual(src.vertices);
    expect(own.width).toBe(56);
    expect(applyOps(linked.doc, linked.inverse)).toEqual(raw);
  });
  it("refuses a self link, a link to a linked mesh, a link while other images depend on the mesh, and unlinking a plain mesh", () => {
    const raw = load();
    expect(() => planLinkMesh(raw, far, far)).toThrow(/itself/);
    expect(() => planLinkMesh(raw, far, { skin: "body", slot: "skin_arm_far", name: "c020" })).toThrow(/linked mesh/);
    expect(() => planLinkMesh(raw, { skin: "body", slot: "skin_arm_far", name: "mesh" }, near)).toThrow(/link to/);
    expect(() => planUnlinkMesh(raw, far)).toThrow(/not a linked mesh/);
  });
});

describe("mesh vertex tools (Batch 7b, )", () => {
  const square = () => modelFromMesh({ uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, width: 100, height: 100 });
  it("rotates 90 degrees around a pivot and scales around it", () => {
    const m = transformVertices(square(), [0, 1, 2, 3], { x: 50, y: 50 }, { angle: 90 });
    expect(m.points[0]).toBeCloseTo(100, 3);
    expect(m.points[1]).toBeCloseTo(0, 3);
    const s = transformVertices(square(), [2], { x: 0, y: 0 }, { scaleX: 0.5, scaleY: 2 });
    expect(s.points.slice(4, 6)).toEqual([50, 200]);
    expect(() => transformVertices(square(), [0], { x: 0, y: 0 }, { scaleX: 0 })).toThrow();
    expect(() => transformVertices(square(), [0, 1], { x: 50, y: 50 }, { angle: 90 })).toThrow(/cross/);
  });
  it("resets UVs to the picture position and clamps", () => {
    expect(resetUvs([0, 0, 100, 50, 120, -5], 100, 100)).toEqual([0, 0, 1, 0.5, 1, 0]);
  });
  it("draws a 5 point hull from clicks", () => {
    const m = redrawHull(square(), [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 60 }, { x: 50, y: 110 }, { x: -10, y: 60 }]);
    expect(m.hull).toBe(5);
  });
});

/** A 1x1 PSD with one layer carrying the given composition properties. */
function tinyPsd(layer: { name: string; blend: string; opacity: number; clipping: number; flags: number; maskLen: number; blocks: [string, number[]][] }): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const str = (s: string) => [...s].forEach((c) => out.push(c.charCodeAt(0)));
  str("8BPS"); u16(1); out.push(0, 0, 0, 0, 0, 0); u16(3); u32(1); u32(1); u16(8); u16(3); u32(0); u32(0);
  const rec: number[] = [];
  const r16 = (v: number) => rec.push((v >> 8) & 255, v & 255);
  const r32 = (v: number) => rec.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const rstr = (s: string) => [...s].forEach((c) => rec.push(c.charCodeAt(0)));
  r32(0); r32(0); r32(1); r32(1); r16(4);
  for (const id of [65535, 0, 1, 2]) { r16(id); r32(3); }
  rstr("8BIM"); rstr(layer.blend); rec.push(layer.opacity, layer.clipping, layer.flags, 0);
  const extra: number[] = [];
  const e32 = (v: number) => extra.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  e32(layer.maskLen); extra.push(...new Array(layer.maskLen).fill(0)); e32(0);
  const nameBytes = [layer.name.length, ...[...layer.name].map((c) => c.charCodeAt(0))];
  while (nameBytes.length % 4) nameBytes.push(0);
  extra.push(...nameBytes);
  for (const [key, data] of layer.blocks) { extra.push(...[..."8BIM"].map((c) => c.charCodeAt(0)), ...[...key].map((c) => c.charCodeAt(0))); e32(data.length); extra.push(...data); if (data.length % 2) extra.push(0); }
  r32(extra.length); rec.push(...extra);
  const pixels: number[] = [];
  for (let c = 0; c < 4; c++) pixels.push(0, 0, 200);
  const info = [0, 1, ...rec, ...pixels];
  u32(info.length + 4); u32(info.length); out.push(...info);
  return new Uint8Array(out);
}

describe("PSD intake report (Batch 7b, )", () => {
  it("names the blend mode, opacity, mask, effects, hidden flag and clipping a layer carries", () => {
    const psd = readPsd(tinyPsd({ name: "glow", blend: "mul ", opacity: 128, clipping: 1, flags: 2, maskLen: 20, blocks: [["lrFX", [0, 0]]] }));
    expect(psd.layers).toHaveLength(1);
    const kinds = psd.issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(["blend", "clipping", "effects", "hidden", "mask", "opacity"]);
    expect(psd.issues.find((i) => i.kind === "blend")!.detail).toMatch(/multiply/);
    expect(psdReportLines(psd.issues)[0]).toMatch(/^glow: /);
  });
  it("reports nothing for a plain layer and a group divider", () => {
    const plain = readPsd(tinyPsd({ name: "arm", blend: "norm", opacity: 255, clipping: 0, flags: 0, maskLen: 0, blocks: [] }));
    expect(plain.issues).toEqual([]);
    expect(psdReportLines(plain.issues)[0]).toMatch(/Nothing is ignored/);
    const group = readPsd(tinyPsd({ name: "Body", blend: "pass", opacity: 255, clipping: 0, flags: 0, maskLen: 0, blocks: [["lsct", [0, 0, 0, 1]]] }));
    expect(group.issues.map((i) => i.kind)).toEqual(["group"]);
  });
});
