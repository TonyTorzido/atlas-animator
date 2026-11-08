// Batch 6a screenshots (speed, channel rows, frame operations, key inspector, popover, graph tangents). Own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch6.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../test-results/batch-shots/b6"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  const Stub = function (u, p) { if (String(p ?? "").includes("vite")) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 }; return new Real(u, p); };
  Stub.prototype = Real.prototype;
  Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Stub;
});
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
await E(() => window.atlasEditor.workspace("pro"));
await page.waitForTimeout(450);
await page.click("#newclip-open");
await page.fill("#newclip-name", "b6_shots");
await page.click("#newclip-make");
await page.waitForTimeout(500);
await E(() => {
  const a = window.atlasEditor;
  for (const [f, v] of [[0, 0], [6, 40], [12, 10]]) {
    a.setTime(f / 30);
    a.select("upper_arm_near");
    a.rotate("upper_arm_near", v);
    a.key();
  }
  a.workspace("animate");
});
await page.waitForTimeout(600);
await E(() => window.atlasEditor.showTab("keys"));
const slot = await E(() => window.atlasEditor.setupRaw().slots.map((x) => x.name).find((n) => /eye/i.test(n)) ?? window.atlasEditor.setupRaw().slots[0].name);
await page.selectOption("#ki-target", `color:${slot}`);
await E(() => window.atlasEditor.setTime(4 / 30));
await page.click("#ki-addkey");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.setKeySelection([{ row: "bone:upper_arm_near", time: 6 / 30 }]));
await page.fill("#speed", "0.5");
await page.locator("#speed").dispatchEvent("change");
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(out, "b6-animate-inspector-speed.png") });
const pos = await E(() => window.atlasEditor.keyScreenPos("bone:upper_arm_near", 6));
await page.mouse.dblclick(pos.x, pos.y);
await page.waitForSelector("#ki-pop");
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(out, "b6-value-popover.png") });
await page.keyboard.press("Escape");
await E(() => window.atlasEditor.select("upper_arm_near"));
await page.click("#graphbtn");
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setKeySelection([{ row: "bone:upper_arm_near", time: 6 / 30 }]));
await page.click("#graphtan-smooth");
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(out, "b6-graph-tangents.png") });
await browser.close();
process.exit(0);
