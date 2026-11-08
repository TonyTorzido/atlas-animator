// Batch 8b swag screenshots and checks (target rig, live preview, edit, replace art, undo, search, thumbnails) in a sandbox (never port 5211).
//   node packages/animator-editor/scripts/demo-batch8b.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../test-results/batch-shots/b8"));
const { url } = await demoServer();
mkdirSync(out, { recursive: true });

// ---- generated PNGs: a solid piece with a lighter stripe, sized like the base piece it replaces
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const stripe = Math.abs(x - w / 2) < w * 0.08;
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = stripe ? Math.min(255, r + 70) : r;
      raw[o + 1] = stripe ? Math.min(255, g + 70) : g;
      raw[o + 2] = stripe ? Math.min(255, b + 70) : b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const baseSize = (rigFile, slot) => {
  const d = JSON.parse(readFileSync(resolve(here, "../../animator/rigs", rigFile), "utf8"));
  const a = Object.values(d.skins).flatMap((k) => Object.values(k.attachments[slot] ?? {}))[0];
  return [Math.round(a.width), Math.round(a.height)];
};
const files = resolve(tmpdir(), `atlas-swag-demo-${process.pid}`);
mkdirSync(files, { recursive: true });
const make = (dir, name, slot, rig, color) => {
  const [w, h] = baseSize(rig, slot);
  mkdirSync(resolve(files, dir), { recursive: true });
  const file = resolve(files, dir, `${name}.png`);
  writeFileSync(file, png(w, h, color));
  return file;
};
const TURNED = "kit-body-cutout/kit-body-cutout.anim.json";
const set = (dir, rig) => [make(dir, "torso", "shirt_torso", rig, [60, 120, 190]), make(dir, "Sleeve Near", "shirt_sleeve_near", rig, [50, 100, 170]), make(dir, "sleeve_left", "shirt_sleeve_far", rig, [50, 100, 170])];
const turnedFiles = set("turned", TURNED);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, acceptDownloads: true });
const page = revealTabs(await ctx.newPage(), { workspace: null });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => console.log(`[e${errors.length}] ${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};

await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const names = await E(() => window.atlasSwag.items().map((i) => i.name));
check("leather chest is listed", names.includes("chest.leather"), names);

await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(2500);
check("target rig is named in the header", (await page.inputValue("#swtarget")) === "pro-turned" && (await E(() => window.atlasSwag.target())) === "pro-turned");
const thumbs = await E(() => [...document.querySelectorAll("img.swthumb")].map((i) => i.src).filter(Boolean));
check("item thumbnails are distinct", thumbs.length > 1 && new Set(thumbs).size === thumbs.length, { n: thumbs.length, distinct: new Set(thumbs).size });
check("bone overlay hidden by default in Swag", (await E(() => window.atlasEditor.overlayState().boneView)) === "off");
await shot("b8b-01-swag-list-1680.png");
await page.fill("#swsearch", "leather");
check("search narrows the list", (await page.locator(".swrow").count()) >= 1 && (await page.locator(".swrow").count()) < (await E(() => window.atlasSwag.items().length)));
await shot("b8b-02-search.png");
await page.fill("#swsearch", "");

await page.click("#swnew");
await page.click('.swdoll .zone[data-slot="chest"]');
await page.fill("#switemname", "Test Vest");
await page.setInputFiles("#swfiles", [...turnedFiles, resolve(files, "notes.txt")].filter((f) => !f.endsWith("notes.txt")));
await page.waitForSelector('.swcard[data-piece="sleeve_left"]');
await page.locator('.swpart[data-part="shirt_sleeve_far"]').evaluate((e) => e.scrollIntoView({ block: "center" }));
await page.dragAndDrop('.swcard[data-piece="sleeve_left"]', '.swpart[data-part="shirt_sleeve_far"]');
await page.waitForSelector('.swpart[data-part="shirt_sleeve_far"].full');
await page.waitForFunction(() => (document.getElementById("swpvmsg")?.hidden ?? false), null, { timeout: 30_000 });
const before = await E(() => document.getElementById("swpreview").toDataURL());
await page.fill('.swnudge[data-piece="torso"] [data-nudge="y"]', "40");
await page.waitForTimeout(900);
const after = await E(() => document.getElementById("swpreview").toDataURL());
check("live preview draws and changes while adjusting", before.length > 2000 && before !== after);
await shot("b8b-03-new-item-live-preview.png");
await page.click("#swsave");
await page.waitForFunction(() => window.atlasSwag.items().some((i) => i.name === "chest.test-vest"), null, { timeout: 60_000 });
await page.waitForTimeout(1500);
check("undo is enabled in the workshop after the save", !(await page.locator("#sw-undo").isDisabled()), await page.getAttribute("#sw-undo", "title"));

// edit: reopen, resize, replace art
await page.click('.swrow[data-item="chest.test-vest"]');
await page.click("#swedit");
await page.waitForSelector('.swnudge[data-piece="shirt_torso"]');
check("edit reopens the saved pieces", (await page.locator(".swnudge").count()) === 3 && (await page.inputValue('.swnudge[data-piece="shirt_torso"] [data-nudge="y"]')) === "40");
await page.fill('.swnudge[data-piece="shirt_torso"] [data-nudge="scale"]', "120");
await page.setInputFiles('.swnudge[data-piece="shirt_torso"] input[type=file]', turnedFiles[0]);
await page.waitForTimeout(900);
await shot("b8b-04-edit-item.png");
await E(() => (document.getElementById("status").textContent = ""));
await page.click("#swsave");
await page.waitForFunction(() => /^Saved chest.test-vest/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 60_000 });
await page.waitForTimeout(1200);
const att = await E(async () => (await (await fetch("/repo/packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json?v=" + Date.now())).json()).skins["chest.test-vest"].attachments.shirt_torso);
const a0 = Object.values(att)[0];
check("edit saved the new size and kept the placement", a0.scaleX === 1.2 && a0.y === 40, a0);
await shot("b8b-05-after-edit.png");

// visible undo of the edit
await page.click("#sw-undo");
await page.waitForTimeout(3500);
const att2 = await E(async () => Object.values((await (await fetch("/repo/packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json?v=" + Date.now())).json()).skins["chest.test-vest"].attachments.shirt_torso)[0]);
check("the workshop Undo took the edit back", att2.scaleX === undefined || att2.scaleX === 1, att2);
await shot("b8b-06-after-undo.png");

// a different target rig
await page.selectOption("#swtarget", "turned-l");
await page.waitForTimeout(3000);
check("choosing another target rig lists that rig", (await E(() => window.atlasSwag.target())) === "turned-l" && (await E(() => window.atlasEditor.rig?.outfit?.id ?? null)) !== "pro-turned");
await shot("b8b-07-other-target.png");
await page.selectOption("#swtarget", "pro-turned");
await page.waitForTimeout(2500);

// clean up
await page.click('.swrow[data-item="chest.test-vest"]');
await page.click('[data-act="delete"]');
await page.click('[data-act="delete-yes"]');
await page.waitForTimeout(100);
await page.waitForFunction(() => !window.atlasSwag.items().some((i) => i.name === "chest.test-vest"), null, { timeout: 60_000 });
const real = errors;
check("no page errors", real.length === 0, real.slice(0, 3));
if (real.length) console.log(real[0]);
await browser.close();
process.exit(real.length ? 1 : 0);
