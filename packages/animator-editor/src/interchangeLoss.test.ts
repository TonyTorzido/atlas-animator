import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lossLines, spineExportLoss, spineImportLoss } from "./interchangeLoss.js";
import type { JsonObject } from "./setupModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;

describe("Spine loss report (Batch 7b-2, )", () => {
  it("export names driven deforms, limits, physics and the baked parts of a real rig", () => {
    const raw = load();
    (raw["driven"] as JsonObject[]).push({ name: "elbow_fix", bone: "forearm_far", keys: [{ at: 70, deform: { body: { skin_arm_far: { mesh: { offset: 0, vertices: [1] } } } } }] });
    const r = spineExportLoss(raw);
    const text = lossLines(r).join("\n");
    expect(text).toMatch(/^Comes across: .*bone/);
    expect(text).toMatch(/Dropped: driven deforms: \d+ corrective key/);
    expect(text).toMatch(/Approximated: clips are exported as sampled/);
    raw["physics"] = [{ name: "cape_sway", bone: "root" }];
    expect(spineExportLoss(raw).dropped.join("\n")).toMatch(/physics constraint .*cape_sway/);
  });
  it("clipping masks, bounding boxes and image sequences are kept, not dropped (Batch 12a)", () => {
    const raw = load();
    const skin = Object.values(raw["skins"] as Record<string, { attachments: Record<string, Record<string, unknown>> }>)[0]!;
    const slot = Object.keys(skin.attachments)[0]!;
    skin.attachments[slot]!["mask_a"] = { type: "clipping", vertices: [0, 0, 1, 0, 1, 1] };
    skin.attachments[slot]!["hit_a"] = { type: "boundingbox", vertices: [0, 0, 1, 0, 1, 1] };
    skin.attachments[slot]!["seq_a"] = { type: "region", path: "fx/a", width: 4, height: 4, sequence: { count: 2, start: 1, digits: 0, setup: 0 } };
    const r = spineExportLoss(raw);
    expect(r.kept.join(" ")).toMatch(/1 clipping mask, 1 bounding box and 1 image sequence/);
    expect(r.dropped.join(" ")).not.toMatch(/clipping|bounding|sequence/);
  });
  it("linked meshes come across, a source in another slot included; only a link without a plain mesh source is dropped (Batch 9)", () => {
    const raw = load();
    const skins = raw["skins"] as Record<string, { attachments: Record<string, Record<string, JsonObject>> }>;
    const body = skins[Object.keys(skins)[0]!]!;
    const [meshSlot, meshName] = Object.entries(body.attachments).flatMap(([slot, atts]) => Object.entries(atts).filter(([, a]) => a["type"] === "mesh").map(([name]) => [slot, name] as const))[0]!;
    const skinName = Object.keys(skins)[0]!;
    const otherSlot = Object.keys(body.attachments).find((s) => s !== meshSlot)!;
    body.attachments[otherSlot]!["cross"] = { type: "linkedMesh", path: "x", width: 1, height: 1, source: { skin: skinName, slot: meshSlot, attachment: meshName } };
    let r = spineExportLoss(raw);
    expect(r.kept.join(" ")).toMatch(/\d+ linked mesh(es)? \(native Spine linked meshes/);
    expect(r.dropped.join(" ")).not.toMatch(/linked mesh/);
    body.attachments[otherSlot]!["chain"] = { type: "linkedMesh", path: "x", width: 1, height: 1, source: { skin: skinName, slot: otherSlot, attachment: "cross" } };
    r = spineExportLoss(raw);
    expect(r.dropped.join(" ")).toMatch(/1 linked mesh whose source is not a plain mesh/);
  });
  it("import lists what the file holds that the rig never receives", () => {
    const spine = {
      skeleton: { spine: "4.2.1" },
      ik: [{ name: "a" }],
      physics: [{ name: "p" }],
      skins: [{ name: "default", attachments: { s: { x: { type: "path" }, y: { type: "clipping" }, z: { type: "mesh" } } } }],
      animations: { run: { path: { a: {} }, physics: { p: [] } } }
    };
    const r = spineImportLoss(spine, { meshes: ["m"], linked: [], deform: [], clips: [{ name: "run", replaced: true }], warnings: ["x: skipped"] });
    const text = lossLines(r).join("\n");
    expect(text).toMatch(/Comes across: 1 mesh with weights/);
    expect(text).toMatch(/run: replaces yours/);
    expect(text).not.toMatch(/path attachment/);
    expect(text).not.toMatch(/Dropped: .*clipping attachment/);
    expect(text).toMatch(/Dropped: 1 IK constraint definitions/);
    expect(text).toMatch(/Dropped: 1 physics constraint definitions/);
    expect(text).not.toMatch(/path timeline/);
    expect(text).toMatch(/Dropped: x: skipped/);
  });
});
