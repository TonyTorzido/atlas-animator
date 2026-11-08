import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { applyOps, runBatch, type JsonObject } from "./setupModel.js";
import { freshArtName, planRelink, previewRelink, remapUvs } from "./relinkModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  expect(parseAnimDocument(r.doc).ok).toBe(true);
  return r;
};
const mesh = { skin: "body", slot: "skin_arm_far", name: "mesh" };

describe("relink source art (Batch 7b-2, )", () => {
  it("remaps UVs per mode, keeps vertices and weights, and undoes", () => {
    const raw = load();
    const att = (raw["skins"] as any).body.attachments.skin_arm_far.mesh;
    const fresh = freshArtName(raw, mesh, "kit-body-front0");
    const to = { width: att.width * 2, height: att.height * 2 };
    const stretch = apply(raw, planRelink(raw, mesh, { path: fresh.path, ...to, mode: "stretch", page: fresh.page }));
    const a1 = (stretch.doc["skins"] as any).body.attachments.skin_arm_far.mesh;
    expect(a1.path).toBe(fresh.path);
    expect(a1.uvs).toEqual(att.uvs);
    expect(a1.vertices).toEqual(att.vertices);
    expect(a1.bones).toEqual(att.bones);
    expect(((stretch.doc["atlas"] as any).pages as string[]).includes(fresh.page)).toBe(true);
    const keep = apply(raw, planRelink(raw, mesh, { path: fresh.path, ...to, mode: "keep-scale", page: fresh.page }));
    const a2 = (keep.doc["skins"] as any).body.attachments.skin_arm_far.mesh;
    expect(a2.uvs.every((u: number) => u >= 0.25 - 1e-4 && u <= 0.75 + 1e-4)).toBe(true);
    expect(a2.vertices).toEqual(att.vertices);
    expect(applyOps(keep.doc, keep.inverse)).toEqual(raw);
    expect(previewRelink(raw, mesh, to, "keep-scale")).toMatchObject({ sizeChanged: true, uvsRemapped: true });
    expect(previewRelink(raw, mesh, { width: att.width, height: att.height }, "keep-scale")).toMatchObject({ sizeChanged: false, uvsRemapped: false });
  });
  it("remaps with centring and clamps, and refuses what is not an image", () => {
    expect(remapUvs([0, 0, 1, 1], { width: 100, height: 100 }, { width: 50, height: 50 }, "keep-scale")).toEqual([0, 0, 1, 1]);
    expect(remapUvs([0.5, 0.5], { width: 100, height: 100 }, { width: 200, height: 200 }, "keep-scale")).toEqual([0.5, 0.5]);
    expect(remapUvs([0, 1], { width: 100, height: 100 }, { width: 200, height: 200 }, "keep-scale")).toEqual([0.25, 0.75]);
    expect(remapUvs([0.2, 0.3], { width: 100, height: 100 }, { width: 10, height: 10 }, "stretch")).toEqual([0.2, 0.3]);
    expect(() => planRelink(load(), { skin: "body", slot: "nope", name: "x" }, { path: "a", width: 1, height: 1, mode: "stretch" })).toThrow(/no image/);
  });
});
