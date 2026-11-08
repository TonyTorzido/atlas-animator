// Batch 10b screenshots (garment gates with honest scope, Ship gate rows, wizard zones from the rig, Leather rebuilt with mesh sleeves) in a sandbox (never port 5211).
//   node packages/animator-editor/scripts/demo-batch10b.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b10"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  const Stub = function (u, p) { if (String(p ?? "").includes("vite")) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 }; return new Real(u, p); };
  Stub.prototype = Real.prototype;
  window.WebSocket = Stub;
});
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
await page.waitForTimeout(1200);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: resolve(out, name) }); console.log(name); };
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1200);
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(800);

// 1. Jacket B: the approved template, Sample gates
await E(() => window.atlasSwag.wear("chest.jacket_b", true));
await page.waitForTimeout(1000);
await E(() => window.atlasSwag.runGates("sample"));
await shot("07-gates-jacket-b-sampled.png");
// 2. Ship's checklist shows the same rows with their scope
await E(() => window.atlasEditor.workspace("ship"));
await shot("08-ship-gate-rows.png");
await E(() => window.atlasEditor.workspace("swag"));
// 3. Leather: all green
await E(() => window.atlasSwag.wear("chest.jacket_b", false));
await E(() => window.atlasSwag.wear("chest.leather", true));
await page.waitForTimeout(800);
await E(() => window.atlasSwag.runGates("sample"));
await shot("09-gates-leather-sampled.png");
await E(() => window.atlasSwag.wear("chest.leather", false));
// 4. Wizard: zones drawn from the rig
await page.click("#swnew");
await page.waitForSelector(".swdoll");
await page.click('.swdoll .zone[data-slot="chest"]');
await shot("10-wizard-zones-from-rig.png");
console.log("errors", errors.length, errors.slice(0, 3));
await browser.close();
process.exit(errors.length ? 1 : 0);
