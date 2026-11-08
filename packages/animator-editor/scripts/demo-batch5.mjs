// Batch 5 probe + screenshots (Animate chrome: one transport, Key menu, dock sizing). Own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch5.mjs <before|after> [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const phase = process.argv[2] === "after" ? "after" : "before";
const out = resolve(process.argv[3] ?? resolve(here, "../../../test-results/batch-shots/b5"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const CLIP = "atk_axe_warrior_1";
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [w, h] of [[1600, 1000], [1366, 768]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
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
  await page.click('#home .home-card[data-go="animate"]');
  await page.waitForSelector("#clipboard:not([hidden]) .cb-dot", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(out, `${phase}-noclip-${w}x${h}.png`) });
  await page.click(`#clipboard .cb-dot[data-clip="${CLIP}"]`).catch(() => {});
  await page.waitForFunction((c) => window.atlasEditor.state().clipName === c, CLIP, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await E(() => window.atlasEditor.gameView?.(false));
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, `${phase}-clip-${w}x${h}.png`) });
  const info = await E(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; };
    return { timeline: r("#timeline"), lower: r("#lower"), footer: r("footer"), view: r("#view") };
  });
  if (phase === "after") {
    for (const id of ["pro", "swag"]) {
      await E((x) => window.atlasEditor.workspace(x), id);
      await page.waitForTimeout(900);
      await page.screenshot({ path: resolve(out, `after-${id}-${w}x${h}.png`) });
    }
  }
  console.log(`${w}x${h}`, JSON.stringify(info), errors.length ? errors : "");
  await page.close();
}
await browser.close();
process.exit(0);
