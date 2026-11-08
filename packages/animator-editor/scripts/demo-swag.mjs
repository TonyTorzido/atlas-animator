// Demo of the Swag workshop and the item contact sheet, in a sandbox (scripts/demo-server.mjs; never port 5211):
//   wear the leather chest, run the pose-sweep sheet and download it, import a small test item from generated PNGs (auto-map, drag a
//   leftover onto a body part, nudge; the turned view is the only one since the front view was retired), check it, then delete it again.
//   node packages/animator-editor/scripts/demo-swag.mjs [outDir]
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
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/swag"));
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
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
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
await shot("1-item-list.png");

// 1. wear leather
await page.click('.swrow[data-item="chest.leather"] [data-act="wear"]');
await page.waitForTimeout(800);
check("wearing leather", (await E(() => window.atlasEditor.skins().active)).includes("chest.leather"), await E(() => window.atlasEditor.skins().active));
await shot("2-wearing-leather.png");

// 2. pose sweep sheet + download
await page.click('[data-act="sweep"]');
await page.waitForFunction(() => window.atlasSwag.sheetState()?.cells >= 12, null, { timeout: 120_000 });
await shot("3-pose-sweep.png");
await page.click('[data-act="next"]');
await page.waitForFunction(() => window.atlasSwag.sheetState()?.page === 1 && window.atlasSwag.sheetState()?.cells >= 3, null, { timeout: 120_000 });
const sheet = await E(() => window.atlasSwag.sheetState());
check("sweep sheet drew its cells lazily over 2 pages", sheet.pages === 2 && sheet.page === 1, sheet);
await shot("3b-pose-sweep-page2.png");
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.click('[data-act="download"]')]);
const dlPath = resolve(out, "leather-pose-sweep.png");
await dl.saveAs(dlPath);
check("Download PNG saved a file", statSync(dlPath).size > 5000, { name: dl.suggestedFilename(), bytes: statSync(dlPath).size });
await page.click('[data-act="close-sheet"]');

// 3. new item
await page.click("#swnew");
await page.click('.swdoll .zone[data-slot="chest"]');
await page.fill("#switemname", "Test Vest");
await page.setInputFiles("#swfiles", turnedFiles);
await page.waitForSelector('.swcard[data-piece="sleeve_left"]');
check("two pieces auto-mapped, one left as a card", (await page.locator(".swpart.full").count()) === 2 && (await page.locator(".swcard").count()) === 1);
await shot("4-new-item-unmatched.png");
await page.locator('.swpart[data-part="shirt_sleeve_far"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
await page.dragAndDrop('.swcard[data-piece="sleeve_left"]', '.swpart[data-part="shirt_sleeve_far"]');
await page.waitForSelector('.swpart[data-part="shirt_sleeve_far"].full');
await page.fill('.swnudge[data-piece="torso"] [data-nudge="x"]', "2");
await page.fill('.swnudge[data-piece="torso"] [data-nudge="rot"]', "1.5");
check("leftover dropped on its body part", (await page.locator(".swpart.full").count()) === 3);
await shot("5-new-item-ready.png");
await page.click("#swsave");
await page.waitForFunction(() => window.atlasSwag.items().some((i) => i.name === "chest.test-vest"), null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const vest = await E(() => window.atlasSwag.items().find((i) => i.name === "chest.test-vest"));
check("test vest saved in the turned view", vest.turned, { cov: vest.covText, issues: vest.issues.length });
check("test vest is worn after saving", (await E(() => window.atlasEditor.skins().active)).includes("chest.test-vest"));
const onDisk = await E(async () => (await (await fetch("/repo/packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json?v=" + Date.now())).json()).skins["chest.test-vest"].attachments.shirt_torso.torso);
check("saved attachment carries the nudge", onDisk.x === 2 && onDisk.rotation === 1.5, onDisk);
await shot("6-test-vest-worn.png");

// 4. check it on a sheet, then delete it
await page.click('.swrow[data-item="chest.test-vest"]');
await page.click('[data-act="sweep"]');
await page.waitForFunction(() => window.atlasSwag.sheetState()?.cells >= 12, null, { timeout: 120_000 });
await shot("7-test-vest-sweep.png");
await page.click('[data-act="close-sheet"]');
await page.click('.swrow[data-item="chest.test-vest"]');
await page.click('[data-act="delete"]');
await page.click('[data-act="delete-yes"]');
await page.waitForFunction(() => !window.atlasSwag.items().some((i) => i.name === "chest.test-vest"), null, { timeout: 60_000 });
const gone = await E(async () => !("chest.test-vest" in (await (await fetch("/repo/packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json?v=" + Date.now())).json()).skins));
check("test vest deleted from the sandbox rig", gone);
await shot("8-after-delete.png");
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
