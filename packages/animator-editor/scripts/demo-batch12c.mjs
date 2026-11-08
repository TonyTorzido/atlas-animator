// Batch 12c screenshots and checks: on-canvas Swag placement handles and the Transitions graph. Starts its own sandboxed server (never :5211).
//   node packages/animator-editor/scripts/demo-batch12c.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../test-results/batch-shots/b12"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });

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
const files = resolve(tmpdir(), `atlas-12c-demo-${process.pid}`);
mkdirSync(files, { recursive: true });
const baseSize = (slot) => {
  const d = JSON.parse(readFileSync(resolve(here, "../../animator/rigs/kit-body-cutout/kit-body-cutout.anim.json"), "utf8"));
  const a = Object.values(d.skins).flatMap((k) => Object.values(k.attachments[slot] ?? {}))[0];
  return [Math.round(a.width), Math.round(a.height)];
};
const torso = resolve(files, "torso.png");
{
  const [w, h] = baseSize("shirt_torso");
  writeFileSync(torso, png(w, h, [60, 120, 190]));
}

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
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(out, name) });
};

// ---------------------------------------------------------------- 1. Swag placement handles
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForFunction(() => window.atlasSwag?.items().length > 0, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.click("#swnew");
await page.click('.swdoll .zone[data-slot="chest"]');
await page.fill("#switemname", "Handle Vest");
await page.setInputFiles("#swfiles", [torso]);
await page.waitForSelector('.swnudge[data-piece="torso"]');
await page.waitForFunction(() => document.querySelectorAll("#swhandles .swh-move").length === 1, null, { timeout: 30_000 });
await page.waitForTimeout(600);
const num = (k) => page.locator(`.swnudge[data-piece="torso"] [data-nudge="${k}"]`).inputValue().then(Number);
const vals = async () => ({ x: await num("x"), y: await num("y"), rot: await num("rot"), scale: await num("scale") });
const center = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
await shot("13-swag-handles.png");
const v0 = await vals();
check("handles are drawn for the selected piece", (await page.locator("#swhandles [data-h]").count()) === 3);
// Move
let c = await center("#swhandles .swh-move");
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + 12, c.y + 8, { steps: 4 });
await page.mouse.up();
const v1 = await vals();
check("dragging the Move handle changes Across / Down", v1.x !== v0.x && v1.y !== v0.y, { v0, v1 });
// Turn, with Shift (15 degree steps)
c = await center("#swhandles .swh-turn");
const cm = await center("#swhandles .swh-move");
await page.mouse.move(c.x, c.y);
await page.keyboard.down("Shift");
await page.mouse.down();
await page.mouse.move(c.x + 25, c.y + 10, { steps: 5 });
await page.mouse.up();
await page.keyboard.up("Shift");
const v2 = await vals();
check("Shift turn snaps to 15 degree steps", v2.rot !== v1.rot && Math.abs(v2.rot / 15 - Math.round(v2.rot / 15)) < 1e-6, { rot: v2.rot, cm });
// Size
c = await center("#swhandles .swh-size");
const mc = await center("#swhandles .swh-move");
const ox = c.x - mc.x;
const oy = c.y - mc.y;
const ol = Math.hypot(ox, oy) || 1;
await page.mouse.move(c.x, c.y);
await page.mouse.down();
await page.mouse.move(c.x + (ox / ol) * 14, c.y + (oy / ol) * 14, { steps: 4 });
await page.mouse.up();
const v3 = await vals();
check("dragging the Size handle changes Size %", v3.scale !== v2.scale, { v2, v3 });
await shot("14-swag-handles-dragged.png");
// Each drag is one undo step
await page.click("#sw-undo");
check("Undo takes back the size drag only", (await vals()).scale === v2.scale && (await vals()).rot === v2.rot, await vals());
await page.click("#sw-undo");
check("Undo takes back the turn", (await vals()).rot === v1.rot, await vals());
await page.click("#sw-undo");
const back = await vals();
check("Undo takes back the move", back.x === v0.x && back.y === v0.y, back);
await page.click("#sw-redo");
check("Redo puts the move back", (await vals()).x === v1.x, await vals());
// Numeric fields still drive the handles
await page.fill('.swnudge[data-piece="torso"] [data-nudge="rot"]', "30");
await page.waitForTimeout(300);
check("typing a number redraws the handles", (await page.locator("#swhandle-read").innerText()).includes("turn 30"), await page.locator("#swhandle-read").innerText());
await page.click("#swcancel");

// ---------------------------------------------------------------- 2. Transitions
// three clips with different poses (a fresh sandbox has none): idle_weight_shift, walk_in_place and attack_1 are the names the project clip map knows
await E(() => window.atlasEditor.workspace("pro"));
await page.waitForTimeout(600);
const poses = { idle_weight_shift: [4, 2], walk_in_place: [35, -20], attack_1: [-60, 30] };
for (const [name, [arm, chest]] of Object.entries(poses)) {
  await page.click("#newclip-open");
  await page.fill("#newclip-name", name);
  await page.click("#newclip-make");
  await page.waitForTimeout(500);
  await E(({ arm, chest }) => {
    const a = window.atlasEditor;
    for (const f of [0, 10]) {
      a.setTime(f / 30);
      a.select("upper_arm_near");
      a.rotate("upper_arm_near", f === 0 ? arm : -arm);
      a.key();
      a.select("chest");
      a.rotate("chest", f === 0 ? chest : -chest);
      a.key();
    }
  }, { arm, chest });
}
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(800);
await page.click("#transitionsbtn");
await page.waitForSelector("#transgraph", { timeout: 20_000 });
await page.waitForTimeout(1500);
let info = await E(() => window.atlasEditor.transInfo());
check("Animate button opened Pro's Transitions tab and turned the graph on", info.active && (await E(() => window.atlasEditor.currentTab())) === "transitions", { ws: await E(() => window.atlasEditor.workspace()), active: info.active });
check("graph pre-filled from the project clip map", info.graph.nodes.length >= 2 && info.graph.edges.length >= 2, info.graph);
await shot("15-transitions-panel.png");
const first = info.graph.path[0];
const second = info.graph.path[1];
await E(({ a }) => window.atlasEditor.transStart(a), { a: first });
await page.waitForTimeout(300);
const fired = await E(({ b }) => window.atlasEditor.transFire(b), { b: second });
check("firing a transition starts a crossfade", fired === null, fired);
await page.waitForTimeout(80);
info = await E(() => window.atlasEditor.transInfo());
check("the status shows the blend", info.status?.from === first && info.status.mix !== null, info.status);
await shot("16-transitions-blending.png");
await page.waitForTimeout(900);
await E(() => window.atlasEditor.transCycle(true));
await page.waitForTimeout(3500);
info = await E(() => window.atlasEditor.transInfo());
check("auto-cycle keeps firing transitions", info.cycling && info.status.fired >= 2, info.status);
await shot("17-transitions-cycle.png");
await E(() => window.atlasEditor.transCycle(false));
check("the graph is saved per rig in the data folder", await E(() => window.atlasEditor.transSave()));
const stored = await E(() => fetch(`/api/transitions?rig=${encodeURIComponent(window.atlasEditor.transInfo().rig)}`).then((r) => r.json()));
check("GET /api/transitions returns it", stored.graph?.nodes?.length === info.graph.nodes.length, stored.graph?.nodes);
const bad = await E(() => fetch("/api/transitions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rig: "x", graph: { format: "nope" } }) }).then((r) => r.status));
check("a bad graph is refused", bad === 400, bad);
console.log(errors.length ? `console errors: ${errors.slice(0, 5).join(" | ")}` : "no console errors");
await browser.close();
process.exit(failed ? 1 : 0);
