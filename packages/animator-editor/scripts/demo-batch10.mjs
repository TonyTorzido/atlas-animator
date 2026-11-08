// Batch 10 screenshots (swag on any rig: rig contract card, Blank rig Create missing, weapon grip registration) in a sandbox (never port 5211).
//   node packages/animator-editor/scripts/demo-batch10.mjs [outDir]
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b10"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });

// A plain RGBA PNG (a blade: grey bar, brown grip).
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    const c = paint(x, y);
    if (c) raw.set([c[0], c[1], c[2], 255], o);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const dir = mkdtempSync(resolve(tmpdir(), "atlas-b10-"));
const blade = resolve(dir, "weapon.png");
writeFileSync(blade, png(40, 220, (x, y) => (y > 150 && y < 200 && x > 12 && x < 28 ? [120, 80, 50] : y < 150 && x > 14 && x < 26 ? [170, 180, 190] : null)));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: resolve(out, name) }); console.log(name); };
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const meta = () => E(async () => { window.atlasEditor.inspectorOpen("rig.contract", true); await new Promise((r) => setTimeout(r, 300)); return document.querySelector('[data-sec="rig.contract"] .insp-sec-meta')?.textContent; });
const makeRig = async (name, template) => {
  await page.click("#rig-file");
  await page.click("#newrig-open");
  await page.fill("#newrig-name", name);
  await page.click(`#newrig-dialog [data-template="${template}"]`);
  await page.click("#newrig-create");
  await page.waitForSelector("#newrig-dialog", { state: "detached" });
  await page.waitForTimeout(1800);
  await E(() => { window.atlasEditor.setMode("setup"); window.atlasEditor.select("root"); });
  await page.waitForTimeout(500);
};

await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(1500);
await E(() => { window.atlasEditor.setMode("setup"); window.atlasEditor.select("chest"); });
check("kit-body-cutout contract card: 0 missing", (await meta()) === "0 missing");
await shot("01-contract-kit-0-missing.png");

await makeRig("B10 Blank", "blank");
const before = await meta();
check("Blank New rig lists what is missing", before !== "0 missing", before);
await shot("02-contract-blank-missing.png");
await page.click("#rc-create");
await page.waitForTimeout(800);
check("Create missing makes it 0 missing", (await meta()) === "0 missing");
await shot("03-contract-blank-created.png");

await makeRig("B10 Player", "player");
check("Player skeleton start: 0 missing", (await meta()) === "0 missing");
await shot("04-contract-player-start.png");

await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.click("#swnew");
await page.click('.swdoll .zone[data-slot="weapon"]');
await page.fill("#switemname", "Grip Blade");
await page.setInputFiles("#swfiles", [blade]);
await page.waitForSelector('.swnudge[data-piece="weapon"]');
await page.waitForSelector("#swgrip-pic");
await page.locator("#swgrip-pic").evaluate((e) => e.scrollIntoView({ block: "center" }));
const box = await page.locator("#swgrip-pic img").boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.75);
await page.waitForSelector("#swgrip-pic .swgripdot.grip");
await page.locator("#swgrip-pic").evaluate((e) => e.scrollIntoView({ block: "center" }));
const box2 = await page.locator("#swgrip-pic img").boundingBox();
await page.mouse.click(box2.x + box2.width * 0.5, box2.y + box2.height * 0.04);
await page.waitForSelector("#swgrip-pic .swgripdot.tip");
check("grip and tip marked", (await page.locator("#swgrip-read").textContent()).includes("Tip"), await page.locator("#swgrip-read").textContent());
await shot("05-weapon-grip-tip.png");
await page.click("#swsave");
await page.waitForFunction(() => window.atlasSwag.items().some((i) => i.name === "weapon.grip-blade"), null, { timeout: 60_000 });
const w = await E(() => window.atlasEditor.setupRaw().skins["weapon.grip-blade"]?.attachments.weapon);
check("saved grip within 2 px of the weapon bone", w?.grip && Math.hypot(w.grip.x, w.grip.y) <= 2, w && { grip: w.grip, tip: w.tip });
await shot("06-weapon-saved.png");
console.log(errors.length ? `page errors: ${errors.join(" | ").slice(0, 400)}` : "no page errors");
await browser.close();
process.exit(0);
