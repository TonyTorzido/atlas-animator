import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createImage } from "../../animator/src/tools/image.js";
import { encodePng } from "../../animator/src/tools/png.js";
import { addParts, createRig, listRigs, partName, rigIdProblem } from "./rigCreate.js";

const repo = resolve(__dirname, "../../..");
const png = (w: number, h: number) => {
  const img = createImage(w, h);
  img.data.fill(255);
  return `data:image/png;base64,${encodePng(img).toString("base64")}`;
};
const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "rigs-"));
  const dir = join(root, "packages/animator/rigs/player");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, "packages/animator/rigs/player/front-turn15-faceA.anim.json"), join(dir, "front-turn15-faceA.anim.json"));
  return root;
};

describe("rig ids and part names", () => {
  it("accepts folder-safe ids only", () => {
    expect(rigIdProblem("test-blob")).toBeNull();
    for (const bad of ["", "A", "Test", "a b", "../x", "-x", "player"]) expect(rigIdProblem(bad)).not.toBeNull();
  });
  it("makes slot names from file names", () => {
    expect(partName("Left Arm.png")).toBe("Left_Arm");
    expect(partName("???.png")).toBe("part");
  });
});

describe("createRig / addParts / listRigs", () => {
  it("creates a blank rig with parts in layer order at their offsets, packed into an atlas", () => {
    const root = sandbox();
    const entry = createRig(root, { id: "test-blob", label: "Test blob", template: "blank", parts: [{ name: "body.png", png: png(40, 60), x: -20, y: -60 }, { name: "head.png", png: png(30, 30), x: -15, y: -90 }] });
    const doc = JSON.parse(readFileSync(join(root, entry.document), "utf8"));
    expect(doc.bones.map((b: { name: string }) => b.name)).toEqual(["root"]);
    expect(doc.slots.map((s: { name: string; bone: string }) => `${s.name}@${s.bone}`)).toEqual(["body@root", "head@root"]);
    expect(doc.skins.default.attachments.head.head).toMatchObject({ type: "region", x: 0, y: -75, width: 30, height: 30 });
    const manifest = JSON.parse(readFileSync(join(root, entry.atlas), "utf8"));
    expect(Object.keys(manifest.pages[0].regions).sort()).toEqual(["test-blob/body", "test-blob/head"]);
    expect(doc.atlas.pages).toEqual(manifest.pages.map((p: { file: string }) => p.file));
    expect(existsSync(join(root, "packages/animator/rigs/test-blob", manifest.pages[0].file))).toBe(true);
  });
  it("refuses duplicate and reserved ids", () => {
    const root = sandbox();
    createRig(root, { id: "dup-rig", template: "blank" });
    expect(() => createRig(root, { id: "dup-rig", template: "blank" })).toThrow(/already exists/);
    expect(() => createRig(root, { id: "player", template: "blank" })).toThrow(/built-in/);
  });
  it("the player template keeps bones and IK but no art", () => {
    const root = sandbox();
    const entry = createRig(root, { id: "hero-two", template: "player" });
    const doc = JSON.parse(readFileSync(join(root, entry.document), "utf8"));
    expect(doc.bones.length).toBeGreaterThan(15);
    expect(doc.ik.length).toBeGreaterThan(0);
    // the contract slots, empty, plus the weapon grip and tip points
    expect(doc.slots.length).toBeGreaterThan(30);
    expect(doc.slots.some((s: { name: string }) => s.name === "boots_foot_near")).toBe(true);
    expect(Object.keys(doc.skins.default.attachments)).toEqual(["weapon_points"]);
    expect(Object.keys(doc.skins.default.attachments.weapon_points)).toEqual(["grip", "tip"]);
    expect(doc.animations).toEqual({});
  });
  it("adds more parts later with unique names, and lists only editor-made rigs", () => {
    const root = sandbox();
    createRig(root, { id: "blob-a", template: "blank", parts: [{ name: "arm.png", png: png(10, 10), x: 0, y: 0 }] });
    expect(addParts(root, "blob-a", [{ name: "arm.png", png: png(12, 12), x: 5, y: 5 }]).slots).toEqual(["arm_2"]);
    const manifest = JSON.parse(readFileSync(join(root, "packages/animator/rigs/blob-a/blob-a.atlas.json"), "utf8"));
    expect(manifest.pages.length).toBe(2);
    expect(listRigs(root).map((r) => r.id)).toEqual(["blob-a"]);
  });
});
