// Batch 7b screenshots (linked mesh, draw hull, vertex fields, weights table). Starts its own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch7b.mjs [outDir]
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


await E(() => window.atlasEditor.setupSelectSlot("shirt_tip_far", "tip"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.inspectorOpen("att.link", true));
await page.waitForTimeout(300);
await shot("10-linked-before.png");
await page.selectOption("#setup-link-source", "body/shirt_tip_near/tip");
await page.waitForTimeout(800);
check("linked mesh", (await raw()).skins.body.attachments.shirt_tip_far.tip.type === "linkedMesh");
await shot("11-linked-mesh-inspector.png");
await page.click("#setup-unlink");
await page.waitForTimeout(700);
await E(() => window.atlasEditor.setupTool("mesh"));
await E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
await page.waitForTimeout(900);
await E(() => window.atlasMesh.select([37, 38, 39]));
await page.waitForTimeout(300);
await shot("12-mesh-vertex-fields.png");
await page.click("#mesh-mode-hull");
const st = await E(() => window.atlasMesh.state());
const pts = [[0.15, 0.1], [0.85, 0.1], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]];
await page.keyboard.down("Control");
for (const [fx, fy] of pts) {
  const c = await E((p) => window.atlasMesh.client(p.x, p.y), { x: fx * st.width, y: fy * st.height });
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(100);
}
await shot("13-draw-hull-open.png");
const c0 = await E((p) => window.atlasMesh.client(p.x, p.y), { x: pts[0][0] * st.width, y: pts[0][1] * st.height });
await page.mouse.click(c0.x, c0.y);
await page.keyboard.up("Control");
await page.waitForTimeout(900);
check("hull of 5", (await E(() => window.atlasMesh.state())).hull === 5);
await shot("14-draw-hull-closed.png");
await E(() => window.atlasEditor.setupUndo());
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setupTool("weights"));
await E(() => window.atlasEditor.setupSelectSlot("shirt_torso", "torso"));
await page.waitForTimeout(900);
await E(() => window.atlasWeights.setBrush({ tool: "select" }));
await E(() => window.atlasWeights.setActive("chest"));
await E(() => window.atlasWeights.selectAll());
await page.waitForTimeout(500);
await shot("15-weights-table-percent.png");
console.log(errors.length ? `console errors: ${errors.join(" | ")}` : "no console errors");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
