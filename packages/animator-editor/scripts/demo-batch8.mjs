// Batch 8 screenshots (Home, Ship, Pro; 8b adds Swag, events, keymap). Starts its own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch8.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b8"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  const Stub = function (u, p) {
    if (String(p ?? "").includes("vite")) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
    return new Real(u, p);
  };
  Stub.prototype = Real.prototype;
  Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Stub;
});
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.addStyleTag({ content: "#restorebar { display: none !important; }" });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(out, name) });
};
const ws = async (id) => {
  await E((w) => window.atlasEditor.workspace(w), id);
  await page.waitForTimeout(600);
};

await ws("pro");
await page.click("#newclip-open");
await page.fill("#newclip-name", "walk_demo");
await page.click("#newclip-make");
await page.waitForTimeout(500);
await shot("01-pro-animate-1366.png");
await E(() => document.querySelector("#modeseg [data-mode=setup]").click());
await shot("02-pro-setup-1366.png");
await E(() => document.querySelector("#modeseg [data-mode=animate]").click());
await ws("ship");
await page.click("#ship-save");
await page.waitForTimeout(800);
await page.click("#ship-check");
await page.waitForTimeout(1800);
await shot("03-ship-check-apply-1366.png");
await E(() => document.getElementById("ship-published").scrollIntoView({ block: "center" }));
await shot("04-ship-published-1366.png");
await ws("home");
await shot("05-home-1366.png");
console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
