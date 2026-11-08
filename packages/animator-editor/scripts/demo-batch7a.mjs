// Batch 7a screenshots (scale / shear tools, physics, point attachments, skin bones list). Starts its own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch7a.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b7"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
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
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, name) });
};
const raw = () => E(() => window.atlasEditor.setupRaw());
const edits = () => E(() => window.atlasEditor.setupState().undoable);
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(800);
await E(() => window.atlasEditor.showTab("rig"));
await page.waitForTimeout(500);


await E(() => window.atlasEditor.select("chest"));
await page.waitForTimeout(400);
await page.keyboard.press("s");
await shot("01-scale-tool.png");
await page.click("#setup-addphys");
await page.waitForTimeout(600);
await shot("02-physics-added.png");
await E(() => window.atlasEditor.setupSelectSlot("skin_forearm_near"));
await page.waitForTimeout(400);
await E(() => window.atlasEditor.inspectorOpen("slot.images", true));
await page.waitForTimeout(300);
await shot("03-slot-point-buttons.png");
await page.click("#setup-add-grip");
await page.waitForTimeout(700);
const pts = await E(() => Object.values(window.atlasEditor.setupRaw().skins.body.attachments.skin_forearm_near).filter((a) => a.type === "point").length);
check("grip point added", pts >= 1, pts);
await shot("04-point-page-viewport.png");
await E(() => window.atlasEditor.setupSelectNode({ kind: "skin", name: "body" }));
await page.waitForTimeout(400);
await E(() => window.atlasEditor.inspectorOpen("skin.scoped", true));
await page.waitForTimeout(300);
await shot("05-skin-bones-constraints.png");
console.log(errors.length ? `console errors: ${errors.join(" | ")}` : "no console errors");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
