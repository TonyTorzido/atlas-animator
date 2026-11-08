/*
 * Atlas Animator: original implementation.
 *
 * Layered-parts pipeline on a small synthetic creature: a body bar and a leg drawn
 * in front of it, each with a 2 px dark outline and an antialiased rim.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDocumentFile } from "../documentStore.js";
import { createImage, type MutableImage } from "../image.js";
import { readPng, writePng } from "../png.js";
import { checkManifestFile, writeReviewSheets } from "./check.js";
import { readMaskPng, sha256File } from "./core.js";
import { enforceFile, enforcePart, extractFolder, readJson, writeJson, writePlanFolder } from "./files.js";
import { validateManifest } from "./manifest.js";
import { writeCompletionPacks } from "./pack.js";
import { planLayers } from "./plan.js";
import { chainsFor } from "./rig.js";
import { buildFromManifest } from "../../cli/layers.js";

const W = 80;
const H = 64;
const INK: [number, number, number] = [40, 18, 16];
const BODY: [number, number, number] = [220, 110, 40];
const LEG: [number, number, number] = [235, 150, 70];

function rect(img: MutableImage, x0: number, y0: number, x1: number, y1: number, fill: [number, number, number]): void {
  // Antialiased rim one pixel outside, a 2 px outline, then the fill.
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const p = (y * W + x) * 4;
      const rim = x === x0 - 1 || x === x1 + 1 || y === y0 - 1 || y === y1 + 1;
      const line = x < x0 + 2 || x > x1 - 2 || y < y0 + 2 || y > y1 - 2;
      if (rim) {
        if ((img.data[p + 3] as number) > 0) continue;
        img.data.set([...INK, 120], p);
      } else img.data.set([...(line ? INK : fill), 255], p);
    }
  }
}

function creature(): MutableImage {
  const img = createImage(W, H);
  rect(img, 10, 10, 69, 33, BODY);
  rect(img, 30, 24, 41, 57, LEG);
  return img;
}

const dir = mkdtempSync(join(tmpdir(), "layers-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(name: string): { folder: string; source: string; rig: string; parts: string } {
  const folder = join(dir, name);
  const source = join(folder, "in", "creature.png");
  writePng(source, creature());
  const rig = join(folder, "in", "creature.anim.json");
  createDocumentFile(rig, [
    { op: "doc.new", name: "creature", width: W, height: H, originX: 0, originY: 0 },
    { op: "bone.add", name: "body", parent: "root", x: 12, y: 18, rotation: 0, length: 55 },
    { op: "bone.add", name: "leg", parent: "body", x: 24, y: 10, rotation: 90, length: 26, limits: { min: -30, max: 30 } }
  ]);
  const parts = join(folder, "in", "parts.json");
  writeJson(parts, {
    version: 1,
    parts: [
      { id: "body", bones: ["body"] },
      { id: "leg", label: "front leg", bones: ["leg"] }
    ],
    drawOrder: ["body", "leg"],
    minDisplayScale: 1,
    probeSteps: 4
  });
  return { folder, source, rig, parts };
}

function plan(name: string) {
  const s = setup(name);
  const p = planLayers(readPng(s.source), readJson(s.rig), readJson(s.parts));
  writePlanFolder(join(s.folder, "out"), p, { source: s.source, rig: s.rig, partsSpec: s.parts, skin: "body" });
  return { ...s, plan: p, out: join(s.folder, "out") };
}

describe("layers plan", () => {
  it("partitions the source pixels, gives the shared line to the front part and sizes completion under it", () => {
    const { plan: p } = plan("plan");
    const [body, leg] = p.parts as [(typeof p.parts)[number], (typeof p.parts)[number]];
    const src = creature();
    for (let i = 0; i < W * H; i++) {
      const owners = (body.visible.data[i] as number) + (leg.visible.data[i] as number);
      expect(owners).toBe((src.data[i * 4 + 3] as number) > 0 ? 1 : 0);
    }
    // The leg's top outline crosses the body's interior: it is the leg's (drawn in front).
    expect(leg.visible.data[24 * W + 35]).toBe(1);
    expect(leg.visible.data[25 * W + 35]).toBe(1);
    expect(body.visible.data[20 * W + 35]).toBe(1);
    // One joint, body behind the leg: the body gets completion, only where the leg hides it.
    expect(p.joints).toHaveLength(1);
    expect(p.joints[0]).toMatchObject({ parent: "body", child: "leg", pivotBone: "leg", front: "leg", back: "body", unfillable: 0 });
    expect(p.joints[0]?.probes.map((q) => q.degrees)).toEqual([-30, -15, 15, 30]);
    expect(body.completion.data.some((v) => v === 1)).toBe(true);
    for (let i = 0; i < W * H; i++) if (body.completion.data[i]) expect(leg.visible.data[i]).toBe(1);
    expect(leg.completion.data.every((v) => v === 0)).toBe(true);
    expect(body.outline?.widthPx).toBe(2);
    expect(p.occlusion).toEqual([expect.objectContaining({ front: "leg", back: "body" })]);
  });
});

describe("layers extract, check and enforce", () => {
  it("reassembles the source exactly at rest, fails coverage until completion, and passes it after", () => {
    const { out } = plan("pipeline");
    const { manifest } = extractFolder(out);
    expect(validateManifest(readJson(join(out, "manifest.json")), { baseDir: out }).issues.filter((i) => i.severity === "error")).toEqual([]);
    // Visible-only layers keep the source bytes, antialiasing included.
    const legLayer = readPng(join(out, "layers", "leg.png"));
    const src = creature();
    const rimIndex = (23 * W + 35) * 4; // inside the body: not the leg's
    expect(legLayer.data[rimIndex + 3]).toBe(0);
    expect(Array.from(legLayer.data.slice((58 * W + 35) * 4, (58 * W + 35) * 4 + 4))).toEqual(Array.from(src.data.slice((58 * W + 35) * 4, (58 * W + 35) * 4 + 4)));
    const first = checkManifestFile(join(out, "manifest.json")).report;
    expect(first.rest.pass).toBe(true);
    expect(first.rest.protected.maxDiff).toBe(0);
    expect(first.gates.coverage).toBe(false);
    expect(first.joints[0]?.probes.some((q) => q.cracks > 0)).toBe(true);
    // The acceptance report ref follows the report.
    const m1 = readJson(join(out, "manifest.json")) as { acceptanceReport: { sha256: string } };
    expect(m1.acceptanceReport.sha256).toBe(sha256File(join(out, "acceptance.json")));

    // A "generated" body: the whole bar drawn, plus a stray red blob outside every allowed area.
    const generated = createImage(W, H);
    rect(generated, 10, 10, 69, 33, BODY);
    for (let y = 50; y < 60; y++) for (let x = 60; x < 70; x++) generated.data.set([255, 0, 0, 255], (y * W + x) * 4);
    const genPath = join(out, "..", "generated-body.png");
    writePng(genPath, generated);
    const { stats } = enforceFile(join(out, "manifest.json"), "body", genPath, { record: { prompt: "complete the body", tool: "test", model: null } });
    expect(stats.droppedOutside).toBeGreaterThanOrEqual(100);
    expect(stats.kept).toBeGreaterThan(0);
    const bodyLayer = readPng(join(out, "layers", "body.png"));
    const visible = readMaskPng(join(out, manifest.parts[0]?.visibleMask.path as string));
    const uncertain = readMaskPng(join(out, manifest.parts[0]?.uncertainMask.path as string));
    for (let i = 0; i < W * H; i++) {
      if (visible.data[i] && !uncertain.data[i]) expect(Array.from(bodyLayer.data.slice(i * 4, i * 4 + 4))).toEqual(Array.from(src.data.slice(i * 4, i * 4 + 4)));
    }
    expect(bodyLayer.data[(55 * W + 65) * 4 + 3]).toBe(0);
    const second = checkManifestFile(join(out, "manifest.json")).report;
    expect(second.rest.pass).toBe(true);
    expect(second.joints[0]?.probes.every((q) => q.cracks === 0)).toBe(true);
    const record = readJson(join(out, "records", "body.json")) as { kind: string; prompt: string; output: { sha256: string } };
    expect(record).toMatchObject({ kind: "generated", prompt: "complete the body" });
    expect(record.output.sha256).toBe(sha256File(join(out, "layers", "body.png")));
    expect(validateManifest(readJson(join(out, "manifest.json")), { baseDir: out }).issues.filter((i) => i.severity === "error")).toEqual([]);
    const sheets = writeReviewSheets(join(out, "manifest.json"), { scale: 3 });
    const restSheet = readPng(sheets.rest);
    expect(restSheet.width).toBe(W * 3 * 2 + 12); // the crop is the whole 80 px canvas here
    expect(readPng(sheets.probes).width).toBeGreaterThan(0);
  });

  it("enforcePart restores trusted pixels and drops everything outside the allowed areas", () => {
    const src = creature();
    const gen = createImage(W, H);
    gen.data.fill(200);
    const mask = (test: (x: number, y: number) => boolean) => ({ width: W, height: H, data: Uint8Array.from({ length: W * H }, (_, i) => (test(i % W, Math.floor(i / W)) ? 1 : 0)) });
    const visible = mask((x, y) => y < 20 && (src.data[(y * W + x) * 4 + 3] as number) > 0);
    const completion = mask((_, y) => y >= 20 && y < 25);
    const uncertain = mask((_, y) => y === 19);
    expect(Array.from(enforcePart(src, gen, visible, completion, uncertain, { bandFromGenerated: true }).image.data.slice((19 * W + 20) * 4, (19 * W + 20) * 4 + 4))).toEqual([200, 200, 200, 200]);
    const { image, stats } = enforcePart(src, gen, visible, completion, uncertain);
    expect(Array.from(image.data.slice((12 * W + 20) * 4, (12 * W + 20) * 4 + 4))).toEqual(Array.from(src.data.slice((12 * W + 20) * 4, (12 * W + 20) * 4 + 4)));
    expect(Array.from(image.data.slice((22 * W + 20) * 4, (22 * W + 20) * 4 + 4))).toEqual([200, 200, 200, 200]);
    expect(Array.from(image.data.slice((19 * W + 20) * 4, (19 * W + 20) * 4 + 4))).toEqual(Array.from(src.data.slice((19 * W + 20) * 4, (19 * W + 20) * 4 + 4)));
    expect(image.data[(40 * W + 5) * 4 + 3]).toBe(0);
    expect(stats.driftedTrusted).toBeGreaterThan(0);
    expect(() => enforcePart(src, createImage(10, 10), visible, completion, uncertain)).toThrow(/source canvas/);
  });
});

describe("layer manifest validator", () => {
  it("reports schema, cross-reference and hash errors", () => {
    const { out } = plan("validate");
    extractFolder(out);
    const good = readJson(join(out, "manifest.json")) as Record<string, unknown> & { drawOrder: string[]; joints: { probeNames: string[] }[] };
    expect(validateManifest(good, { baseDir: out, bones: new Set(["root", "body", "leg"]) }).issues).toEqual([]);
    expect(validateManifest({ ...good, version: 2 }).issues[0]?.message).toMatch(/version/);
    expect(validateManifest({ ...good, drawOrder: ["leg"] }).issues.map((i) => i.message).join()).toMatch(/drawOrder/);
    const badProbe = { ...good, joints: [{ ...good.joints[0], probeNames: ["leg turn 5"] }] };
    expect(validateManifest(badProbe).issues.map((i) => i.message).join()).toMatch(/rotate/);
    expect(validateManifest(good, { bones: new Set(["root"]) }).issues.map((i) => i.message).join()).toMatch(/no bone 'body'/);
    writeFileSync(join(out, "layers", "leg.png"), readFileSync(join(out, "layers", "body.png")));
    expect(validateManifest(good, { baseDir: out }).issues.map((i) => i.message).join()).toMatch(/leg image.*sha256/);
  });
});

describe("layers pack and build", () => {
  it("writes a completion request per part with a completion area", () => {
    const { out } = plan("pack");
    extractFolder(out);
    const packs = writeCompletionPacks(join(out, "manifest.json"), { subject: "creature" });
    expect(packs.map((p) => p.part)).toEqual(["body"]);
    const prompt = readFileSync(join(out, "completion-requests", "body", "prompt.txt"), "utf8");
    expect(prompt).toMatch(/Complete only the hidden areas of the body/);
    expect(prompt).toMatch(/about 2 px wide, colour #28/);
    expect(prompt).toMatch(/beneath the front leg/);
    const request = readJson(join(out, "completion-requests", "body", "request.json")) as { references: { path: string }[] };
    expect(request.references.map((r) => r.path)).toEqual(["reference.png", "target.png", "guide.png"]);
  });

  it("builds a weighted, ordered rig from the stored PNGs and rebuilds without touching the art", async () => {
    const { out, folder } = plan("build");
    extractFolder(out);
    const hashes = ["body", "leg"].map((p) => sha256File(join(out, "layers", `${p}.png`)));
    const docPath = join(folder, "rig", "creature-layers.anim.json");
    const built = await buildFromManifest(join(out, "manifest.json"), docPath);
    expect(built.slots).toEqual(["body", "leg"]);
    const doc = readJson(docPath) as { canvas: { width: number }; slots: { name: string; bone: string }[]; drawOrder: string[]; authoring: { domains: { slot: string; bones: string[] }[]; joints: unknown[] }; skins: { body: { attachments: Record<string, Record<string, { type: string; bones?: unknown[] }>> } } };
    expect(doc.canvas.width).toBe(W);
    expect(doc.slots.map((s) => [s.name, s.bone])).toEqual([["body", "body"], ["leg", "leg"]]);
    expect(doc.drawOrder).toEqual(["body", "leg"]);
    expect(doc.authoring.domains.map((d) => [d.slot, d.bones])).toEqual([["body", ["body"]], ["leg", ["leg"]]]);
    expect(doc.authoring.joints).toEqual([{ parent: "body", child: "leg", pivotBone: "leg" }]);
    expect(doc.skins.body.attachments["leg"]?.["leg"]?.type).toBe("mesh");
    await buildFromManifest(join(out, "manifest.json"), docPath);
    expect(["body", "leg"].map((p) => sha256File(join(out, "layers", `${p}.png`)))).toEqual(hashes);
    writeFileSync(join(out, "layers", "leg.png"), readFileSync(join(out, "layers", "body.png")));
    await expect(buildFromManifest(join(out, "manifest.json"), docPath)).rejects.toThrow(/no art is regenerated/);
  }, 120_000);

  it("derives weight chains from allowed bones", () => {
    const parents = new Map<string, string | null>([["pelvis", "root"], ["spine", "pelvis"], ["chest", "spine"], ["neck", "chest"], ["tail", "pelvis"]]);
    expect(chainsFor(parents, ["pelvis", "spine", "chest", "tail"])).toEqual([{ bones: ["pelvis", "spine", "chest"] }, { bones: ["tail"], parent: "pelvis" }]);
    expect(() => chainsFor(parents, ["spine", "tail"])).toThrow(/one connected tree/);
    const fox = new Map<string, string | null>([["pelvis", "root"], ["spine", "pelvis"], ["chest", "spine"], ["neck", "chest"], ["head", "neck"], ["ear_a", "head"], ["ear_b", "head"], ["leg", "chest"], ["tail", "pelvis"]]);
    expect(chainsFor(fox, ["pelvis", "spine", "chest", "neck", "head", "ear_a", "ear_b", "leg", "tail"])).toEqual([
      { bones: ["pelvis", "spine", "chest", "neck", "head"] },
      { bones: ["tail"], parent: "pelvis" },
      { bones: ["leg"], parent: "chest" },
      { bones: ["ear_a"], parent: "head" },
      { bones: ["ear_b"], parent: "head" }
    ]);
  });
});

describe("layers plan segmentation options", () => {
  it("clips a part at its root and warns when a part sits away from its bones", () => {
    const s = setup("clip");
    const spec = readJson(s.parts) as { parts: Record<string, unknown>[] };
    (spec.parts[1] as Record<string, unknown>)["clipAtRoot"] = true;
    (spec.parts[1] as Record<string, unknown>)["rootOffset"] = 8;
    const p = planLayers(readPng(s.source), readJson(s.rig), spec);
    const leg = p.parts[1] as (typeof p.parts)[number];
    // The leg bone starts at y = 28 pointing down: nothing above y = 36 is the leg's.
    for (let y = 0; y < 35; y++) for (let x = 0; x < W; x++) expect(leg.visible.data[y * W + x]).toBe(0);
    expect(leg.visible.data[45 * W + 35]).toBe(1);
    // A distance cap keeps a part to its bones' neighbourhood.
    const capped = { ...spec, parts: [{ id: "body", bones: ["body"] }, { id: "leg", bones: ["leg"], maxBoneDistance: 3 }] };
    const r = planLayers(readPng(s.source), readJson(s.rig), capped);
    for (let i = 0; i < W * H; i++) if ((r.parts[1] as (typeof r.parts)[number]).visible.data[i]) expect(Math.abs((i % W) + 0.5 - 36)).toBeLessThanOrEqual(3.5);
    // A misplaced seed stroke: the leg seeded across the whole bar takes the body's pixels.
    const wrong = { ...spec, parts: [{ id: "body", bones: ["body"] }, { id: "leg", bones: ["leg"], seeds: [[14, 14, 66, 14, 3], [14, 22, 66, 22, 3], [14, 28, 66, 28, 3]] }] };
    const q = planLayers(readPng(s.source), readJson(s.rig), wrong);
    expect(q.notes.join("\n")).toMatch(/plausibility/);
  });
});
