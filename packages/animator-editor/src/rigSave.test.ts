import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { planAddBone, planBoneProps, runBatch, type Command, type JsonObject } from "./setupModel.js";
import { planAttachImage, importedPath } from "./setupAttach.js";
import { IMPORTS_DIR, isImportPage, rigHash, saveRig, setRigSaveFault, RIGS_DIR, SaveError } from "./rigSave.js";
import { mergeSkinsIntoRigText } from "./exportApi.js";
import { readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePng, encodePng } from "../../animator/src/tools/png.js";

const SRC = new URL("../../animator/rigs/kit-body-front0/", import.meta.url);
/** A real w x h PNG filled with one colour, as a data URL (saves decode and re-pack imported images). */
const pngOf = (width: number, height: number, rgba: [number, number, number, number]): string => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return "data:image/png;base64," + encodePng({ width, height, data }).toString("base64");
};
const PNG = pngOf(2, 3, [255, 0, 0, 255]);

let root = "";
const FILE = `${RIGS_DIR}/t/rig.anim.json`;
const ATLAS = `${RIGS_DIR}/t/rig.atlas.json`;
const doc = (): JsonObject => JSON.parse(readFileSync(join(root, FILE), "utf8")) as JsonObject;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rigsave-"));
  mkdirSync(join(root, RIGS_DIR, "t"), { recursive: true });
  copyFileSync(new URL("kit-body-front0.anim.json", SRC), join(root, FILE));
  copyFileSync(new URL("kit-body-front0.atlas.json", SRC), join(root, ATLAS));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const addBone = (raw: JsonObject, name: string): Command[] => planAddBone(raw, { parent: "root", from: [0, 0], to: [40, 0], name }).commands;

describe("saving setup edits through the command log", () => {
  it("applies each batch as a log entry, returns the new hash, and the file is a valid rig", () => {
    const base = rigHash(root, FILE);
    const raw = doc();
    const b1 = addBone(raw, "wing");
    const after1 = runBatch(raw, b1).doc;
    const b2 = planBoneProps(after1, "wing", { color: "ff0000ff" }).commands;
    const r = saveRig(root, { file: FILE, base, undo: 0, batches: [b1, b2] });
    expect(r.applied).toBe(2);
    expect(r.hash).not.toBe(base);
    const saved = doc();
    expect((saved["bones"] as JsonObject[]).find((b) => b["name"] === "wing")!["color"]).toBe("ff0000ff");
    expect(parseAnimDocument(saved).ok).toBe(true);
    const log = readFileSync(join(root, FILE.replace(/\.json$/, "") + ".log.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; source: string; commands: Command[] });
    expect(log.map((e) => [e.kind, e.source])).toEqual([["apply", "editor"], ["apply", "editor"]]);
    expect(log[0]!.commands[0]!.op).toBe("bone.add");
  });
  it("undoes saved batches the user undid, then applies the new ones", () => {
    const raw = doc();
    const b1 = addBone(raw, "wing");
    const first = saveRig(root, { file: FILE, base: rigHash(root, FILE), undo: 0, batches: [b1] });
    const b2 = addBone(raw, "tail");
    const second = saveRig(root, { file: FILE, base: first.hash, undo: 1, batches: [b2] });
    expect(second.undone).toBe(1);
    const names = (doc()["bones"] as JsonObject[]).map((b) => b["name"]);
    expect(names).toContain("tail");
    expect(names).not.toContain("wing");
  });
  it("refuses a file that changed under the editor, and paths outside the rigs folder", () => {
    const raw = doc();
    expect(() => saveRig(root, { file: FILE, base: "deadbeef00000000", undo: 0, batches: [addBone(raw, "x")] })).toThrowError(/changed on disk/);
    try {
      saveRig(root, { file: FILE, base: "deadbeef00000000", undo: 0, batches: [] });
    } catch (error) {
      expect((error as SaveError).status).toBe(409);
    }
    expect(() => saveRig(root, { file: "package.json", base: null, undo: 0, batches: [] })).toThrow(SaveError);
    expect(() => saveRig(root, { file: `${RIGS_DIR}/../x.anim.json`, base: null, undo: 0, batches: [] })).toThrow(SaveError);
  });
  it("refuses an invalid batch without changing the file", () => {
    const before = readFileSync(join(root, FILE), "utf8");
    expect(() => saveRig(root, { file: FILE, base: null, undo: 0, batches: [[{ op: "bone.set", name: "nope", x: 1 }]] })).toThrowError(/refused/);
    expect(readFileSync(join(root, FILE), "utf8")).toBe(before);
  });
  it("re-packs an imported image into a packed page (PL-11) and keeps the PNG as its import source", () => {
    const raw = doc();
    const plan = planAttachImage(raw, { skin: "body", slot: null, bone: "body", name: "badge", imported: { rigName: "rig" }, width: 2, height: 3, setDefault: true });
    const file = plan.page!;
    const r = saveRig(root, { file: FILE, atlas: ATLAS, base: rigHash(root, FILE), undo: 0, batches: [plan.commands], images: [{ file, path: importedPath("body", "badge", "badge"), png: PNG }] });
    expect(r.images).toEqual([file]);
    expect(r.packed).toHaveLength(1);
    expect(existsSync(join(root, RIGS_DIR, "t", file))).toBe(false);
    expect(readFileSync(join(root, RIGS_DIR, "t", IMPORTS_DIR, file))).toEqual(Buffer.from(PNG.split(",")[1]!, "base64"));
    const page = manifestOf().pages.find((p) => p.file === r.packed[0])!;
    const rect = page.regions[importedPath("body", "badge", "badge")]!;
    expect([rect.width, rect.height]).toEqual([2, 3]);
    expect(pixel(r.packed[0]!, rect.x + 1, rect.y + 2)).toEqual([255, 0, 0, 255]);
    const pages = (doc()["atlas"] as { pages: string[] }).pages;
    expect(pages).toContain(r.packed[0]);
    expect(pages).not.toContain(file);
    expect(manifestOf().pages.map((p) => p.file)).toEqual(pages);
    expect(parseAnimDocument(doc()).ok).toBe(true);
  });
  it("a second import joins the same packed page set, older one-image pages are migrated, and undo of the save takes the page list back", () => {
    // An older rig: one page per imported image (the layout before PL-11), written by hand.
    const dir = join(root, RIGS_DIR, "t");
    const raw0 = doc();
    const old = planAttachImage(raw0, { skin: "body", slot: null, bone: "body", name: "old", imported: { rigName: "rig" }, width: 2, height: 3, setDefault: true });
    const oldPng = Buffer.from(pngOf(2, 3, [0, 255, 0, 255]).split(",")[1]!, "base64");
    writeFileSync(join(dir, old.page!), oldPng);
    const m0 = manifestOf();
    m0.pages.push({ file: old.page!, width: 2, height: 3, regions: { [old.path]: { x: 0, y: 0, width: 2, height: 3 } } });
    writeFileSync(join(root, ATLAS), JSON.stringify(m0));
    const first = saveRig(root, { file: FILE, base: rigHash(root, FILE), undo: 0, batches: [old.commands] });
    expect(first.packed).toEqual([]); // no images sent: nothing re-packed
    const before = manifestOf().pages.length;

    const raw1 = doc();
    const plan = planAttachImage(raw1, { skin: "body", slot: null, bone: "body", name: "badge", imported: { rigName: "rig" }, width: 4, height: 4, setDefault: true });
    const r = saveRig(root, { file: FILE, atlas: ATLAS, base: first.hash, undo: 0, batches: [plan.commands], images: [{ file: plan.page!, path: plan.path, png: pngOf(4, 4, [0, 0, 255, 255]) }] });
    const after = manifestOf();
    expect(after.pages.length).toBeLessThanOrEqual(before);
    expect(existsSync(join(dir, old.page!))).toBe(false);
    expect(readFileSync(join(dir, IMPORTS_DIR, old.page!))).toEqual(oldPng);
    const packed = after.pages.find((p) => p.file === r.packed[0])!;
    const o = packed.regions[old.path]!;
    const b = packed.regions[plan.path]!;
    expect(pixel(packed.file, o.x, o.y)).toEqual([0, 255, 0, 255]);
    expect(pixel(packed.file, b.x + 3, b.y + 3)).toEqual([0, 0, 255, 255]);
    expect((doc()["atlas"] as { pages: string[] }).pages).toEqual(after.pages.map((p) => p.file));
    // The page-list change is part of the save's own log entry: one undo takes back the edit and the list together.
    saveRig(root, { file: FILE, atlas: ATLAS, base: r.hash, undo: 1, batches: [] });
    expect((doc()["atlas"] as { pages: string[] }).pages).toContain(old.page!);
    expect(readFileSync(join(root, FILE.replace(/\.json$/, "") + ".log.ndjson"), "utf8").trim().split("\n")).toHaveLength(3);
  });
  it("is one transaction (): a refused later batch leaves the document, the log and the hash as they were", () => {
    const base = rigHash(root, FILE);
    const before = readFileSync(join(root, FILE), "utf8");
    const logFile = join(root, FILE.replace(/\.json$/, "") + ".log.ndjson");
    const good = addBone(doc(), "wing");
    expect(() => saveRig(root, { file: FILE, base, undo: 0, batches: [good, [{ op: "bone.set", name: "nope", x: 1 }]] })).toThrowError(/batch 2 was refused, nothing was saved/);
    expect(readFileSync(join(root, FILE), "utf8")).toBe(before);
    expect(existsSync(logFile)).toBe(false);
    expect(rigHash(root, FILE)).toBe(base);
    // The retry sends the same first batch against the same base and it applies once.
    const retry = saveRig(root, { file: FILE, base, undo: 0, batches: [good] });
    expect(retry.applied).toBe(1);
    expect((doc()["bones"] as JsonObject[]).filter((b) => b["name"] === "wing")).toHaveLength(1);
  });
  it("rolls back the images and the manifest too when a save fails after writing them", () => {
    const base = rigHash(root, FILE);
    const docBefore = readFileSync(join(root, FILE), "utf8");
    const atlasBefore = readFileSync(join(root, ATLAS), "utf8");
    const raw = doc();
    const plan = planAttachImage(raw, { skin: "body", slot: null, bone: "body", name: "badge", imported: { rigName: "rig" }, width: 2, height: 3, setDefault: true });
    setRigSaveFault(() => {
      throw new Error("disk full (injected)");
    });
    try {
      expect(() => saveRig(root, { file: FILE, atlas: ATLAS, base, undo: 0, batches: [plan.commands], images: [{ file: plan.page!, path: importedPath("body", "badge", "badge"), png: PNG }] })).toThrowError(/disk full/);
    } finally {
      setRigSaveFault(null);
    }
    expect(readFileSync(join(root, FILE), "utf8")).toBe(docBefore);
    expect(readFileSync(join(root, ATLAS), "utf8")).toBe(atlasBefore);
    expect(existsSync(join(root, RIGS_DIR, "t", plan.page!))).toBe(false);
    expect(existsSync(join(root, RIGS_DIR, "t", IMPORTS_DIR))).toBe(false);
    expect(readdirSync(join(root, RIGS_DIR, "t")).filter((f) => f.includes(".packed-"))).toEqual([]);
    expect(rigHash(root, FILE)).toBe(base);
  });
  it("refuses an image that is not a readable PNG, writing nothing", () => {
    const before = readFileSync(join(root, ATLAS), "utf8");
    const plan = planAttachImage(doc(), { skin: "body", slot: null, bone: "body", name: "badge", imported: { rigName: "rig" }, width: 2, height: 3, setDefault: true });
    const fake = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000", "hex").toString("base64") + "AAAA";
    expect(() => saveRig(root, { file: FILE, atlas: ATLAS, base: rigHash(root, FILE), undo: 0, batches: [plan.commands], images: [{ file: plan.page!, path: plan.path, png: fake }] })).toThrowError(/not a readable PNG/);
    expect(readFileSync(join(root, ATLAS), "utf8")).toBe(before);
  });
  it("a save killed at any moment leaves a manifest whose every page is a whole PNG holding its regions (kill -9 drill)", async () => {
    // A child process saves big images in a loop; it is killed at a different moment each round. After every kill the manifest
    // must parse, and every page it lists must decode at its listed size (never a truncated or half-switched page).
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const child = join(root, "saver.mjs");
    const rigSaveUrl = pathToFileURL(fileURLToPath(new URL("./rigSave.ts", import.meta.url))).href;
    const setupUrl = pathToFileURL(fileURLToPath(new URL("./setupAttach.ts", import.meta.url))).href;
    const big = pngOf(700, 700, [10, 20, 30, 255]);
    writeFileSync(join(root, "big.txt"), big);
    writeFileSync(child, [
      `import { readFileSync } from "node:fs";`,
      `const { saveRig, rigHash } = await import(${JSON.stringify(rigSaveUrl)});`,
      `const { planAttachImage } = await import(${JSON.stringify(setupUrl)});`,
      `const root = ${JSON.stringify(root)}; const FILE = ${JSON.stringify(FILE)}; const ATLAS = ${JSON.stringify(ATLAS)};`,
      `const png = readFileSync(${JSON.stringify(join(root, "big.txt"))}, "utf8");`,
      `process.stdout.write("ready\\n");`,
      `for (let n = 0; ; n++) {`,
      `  const raw = JSON.parse(readFileSync(root + "/" + FILE, "utf8"));`,
      `  const plan = planAttachImage(raw, { skin: "body", slot: null, bone: "body", name: "big" + process.pid + "_" + n, imported: { rigName: "rig" }, width: 700, height: 700, setDefault: false });`,
      `  saveRig(root, { file: FILE, atlas: ATLAS, base: rigHash(root, FILE), undo: 0, batches: [plan.commands], images: [{ file: plan.page, path: plan.path, png }] });`,
      `}`
    ].join("\n"));
    for (let round = 0; round < 4; round++) {
      const proc = spawn(process.execPath, ["--import", pathToFileURL(tsx).href, child], { stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((ok) => proc.stdout.once("data", () => ok()));
      await new Promise((r) => setTimeout(r, 150 + round * 170));
      proc.kill("SIGKILL");
      await new Promise((r) => proc.once("exit", r));
      const m = manifestOf();
      for (const page of m.pages.filter((pg) => isImportPage(pg.file))) {
        const img = decodePng(readFileSync(join(root, RIGS_DIR, "t", page.file)));
        expect([img.width, img.height], page.file).toEqual([page.width, page.height]);
      }
    }
    expect(manifestOf().pages.some((pg) => isImportPage(pg.file))).toBe(true); // the child did save between kills
  }, 60_000);
});

const manifestOf = () => JSON.parse(readFileSync(join(root, ATLAS), "utf8")) as { pages: { file: string; width: number; height: number; regions: Record<string, { x: number; y: number; width: number; height: number }> }[] };
const pixel = (page: string, x: number, y: number): number[] => {
  const img = decodePng(readFileSync(join(root, RIGS_DIR, "t", page)));
  return [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
};

describe("skins save and Setup save on the same rig copy", () => {
  it("a skins write changes the hash (Setup refetches it), after which a Setup save applies and keeps the skins", () => {
    const stale = rigHash(root, FILE);
    const text = readFileSync(join(root, FILE), "utf8");
    writeFileSync(join(root, FILE), mergeSkinsIntoRigText(text, { ...(doc()["skins"] as JsonObject), extra: { attachments: {} } }));
    expect(() => saveRig(root, { file: FILE, base: stale, undo: 0, batches: [addBone(doc(), "wing")] })).toThrow(SaveError);
    const r = saveRig(root, { file: FILE, base: rigHash(root, FILE), undo: 0, batches: [addBone(doc(), "wing")] });
    expect(r.applied).toBe(1);
    expect(Object.keys(doc()["skins"] as JsonObject)).toContain("extra");
    expect((doc()["bones"] as JsonObject[]).some((b) => b["name"] === "wing")).toBe(true);
  });
});
