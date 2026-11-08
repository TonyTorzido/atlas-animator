// Demo of the Shape keys tool (Animate, D), in a sandbox (scripts/demo-server.mjs; never port 5211):
//   squash the torso on frame 6 (S/Shift+S modal), fold the hair on frame 8 with soft selection (real mouse drag), onion skin shows both,
//   the dopesheet row and amount curve, then the three Clear deform options (each one undo step). Screenshots + PASS/FAIL checks.
//   node packages/animator-editor/scripts/demo-deform.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../docs/plans/atlas-animator-demos/editor/deform"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }), { workspace: "animate" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor && !!window.atlasShapeKeys, null, { timeout: 60_000 });
await page.waitForTimeout(1500);

const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const frame = (n) => n / 30;
const goto = async (n) => {
  await E((t) => window.atlasEditor.setTime(t), frame(n));
  await page.waitForTimeout(250);
};
const keys = () => E(() => window.atlasShapeKeys.deformKeys());
const timesOf = (all, skin, slot, att) => (all[skin]?.[slot]?.[att] ?? []).map((k) => Math.round(k.time * 30));
const screen = (v) => E((i) => window.atlasShapeKeys.vertexScreen(i), v);

// ---- a named clip to key into (the editor starts without one)
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "demo_deform");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(300);
await E(() => window.atlasEditor.setCanvasTool("shape-keys"));
await page.waitForTimeout(500);
check("Shape keys tool is current (the Mesh button / D)", (await E(() => window.atlasEditor.canvasTool())) === "shape-keys");
check("the real panel replaced the stand-in", (await page.locator("#sk-mesh").count()) === 1 && (await page.locator("#ctool-coming-shape-keys").count()) === 0);

// ---- 1. torso squash on frame 6
await goto(6);
await E(() => window.atlasShapeKeys.setTarget("body/skin_torso/torso"));
await E(() => window.atlasShapeKeys.setSoft({ on: false }));
await page.waitForTimeout(300);
const n = await E(() => window.atlasShapeKeys.vertexCount());
check("skin_torso mesh is the target", n === 126, n);
await shot("1-tool-torso.png");
// select every vertex with Ctrl+A on the canvas
const box = await page.locator("#view canvas").first().boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
await page.keyboard.press("Control+a");
await page.waitForTimeout(200);
check("Ctrl+A selects all vertices", (await E(() => window.atlasShapeKeys.selection().length)) === n);
const pos0 = await E(() => window.atlasShapeKeys.positions());
const ys = pos0.filter((_, i) => i % 2 === 1);
const h0 = Math.max(...ys) - Math.min(...ys);
const mid = await screen(0);
// Shift+S squash: the pointer starts 120 px right of the centre; moving it in squashes in y and widens in x
const cx = (Math.min(...pos0.filter((_, i) => i % 2 === 0)) + Math.max(...pos0.filter((_, i) => i % 2 === 0))) / 2;
const cyv = (Math.min(...ys) + Math.max(...ys)) / 2;
void cx;
void cyv;
void mid;
const c = await E(() => {
  const p = window.atlasShapeKeys.positions();
  let x = 0, y = 0;
  for (let i = 0; i < p.length; i += 2) { x += p[i]; y += p[i + 1]; }
  return { x: x / (p.length / 2), y: y / (p.length / 2) };
});
const cs = await E((c) => {
  // screen position of the centroid: take the vertex nearest it and offset by its skeleton delta using the zoom
  const p = window.atlasShapeKeys.positions();
  let best = 0, bd = 1e18;
  for (let i = 0; i < p.length; i += 2) { const d = (p[i] - c.x) ** 2 + (p[i + 1] - c.y) ** 2; if (d < bd) { bd = d; best = i / 2; } }
  const s = window.atlasShapeKeys.vertexScreen(best);
  const z = window.atlasEditor.view?.().zoom ?? 1;
  return { x: s.x - (p[best * 2] - c.x) * z, y: s.y - (p[best * 2 + 1] - c.y) * z, z };
}, c);
await page.mouse.move(cs.x + 150, cs.y);
await page.keyboard.press("Shift+S");
await page.mouse.move(cs.x + 150, cs.y + 2);
await page.mouse.move(cs.x + 120, cs.y + 2, { steps: 4 });
await shot("2-torso-squash-live.png");
await page.mouse.click(cs.x + 120, cs.y + 2);
await page.waitForTimeout(500);
let all = await keys();
check("torso has a deform key on frame 6 (one commit)", timesOf(all, "body", "skin_torso", "torso").includes(6), timesOf(all, "body", "skin_torso", "torso"));
const pos1 = await E(() => window.atlasShapeKeys.positions());
const ys1 = pos1.filter((_, i) => i % 2 === 1);
const h1 = Math.max(...ys1) - Math.min(...ys1);
check("the torso is squashed (shorter than before)", h1 < h0 - 3, { before: Math.round(h0), after: Math.round(h1) });
await shot("3-torso-squashed.png");

// ---- 2. hair fold on frame 8 with soft selection (real mouse drag)
await goto(8);
await E(() => window.atlasShapeKeys.setTarget("body/hair_back/hair"));
await E(() => window.atlasShapeKeys.setSoft({ on: true, radius: 140, mode: "edge" }));
await page.waitForTimeout(300);
const hp = await E(() => window.atlasShapeKeys.positions());
let low = 0;
for (let i = 0; i < hp.length; i += 2) if (hp[i + 1] > hp[low * 2 + 1]) low = i / 2;
const lowScreen = await screen(low);
await page.mouse.click(lowScreen.x, lowScreen.y);
await page.waitForTimeout(200);
check("clicking a vertex selects it", (await E(() => window.atlasShapeKeys.selection())).includes(low));
await shot("4-hair-soft-selection-ring.png");
await page.mouse.move(lowScreen.x, lowScreen.y);
await page.mouse.down();
await page.mouse.move(lowScreen.x + 70, lowScreen.y - 40, { steps: 8 });
await shot("5-hair-fold-live.png");
await page.mouse.up();
await page.waitForTimeout(500);
all = await keys();
check("hair has a deform key on frame 8", timesOf(all, "body", "hair_back", "hair").includes(8), timesOf(all, "body", "hair_back", "hair"));
const hp2 = await E(() => window.atlasShapeKeys.positions());
const moved = Math.hypot(hp2[low * 2] - hp[low * 2], hp2[low * 2 + 1] - hp[low * 2 + 1]);
check("the dragged vertex followed the cursor (~80 px at this zoom)", moved > 10, Math.round(moved));
let neighbours = 0;
for (let i = 0; i < hp.length; i += 2) if (i / 2 !== low && Math.hypot(hp2[i] - hp[i], hp2[i + 1] - hp[i + 1]) > 0.5) neighbours++;
check("soft selection moved neighbours too", neighbours > 3, neighbours);
await shot("6-hair-folded.png");

// ---- 3. onion skin: both meshes get a rest key on frame 0 (Clear selected with everything selected), so the deform moves between frames
for (const target of ["body/hair_back/hair", "body/skin_torso/torso"]) {
  await goto(0);
  await E((t) => window.atlasShapeKeys.setTarget(t), target);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.keyboard.press("Control+a");
  await page.click("#sk-clear-sel");
  await page.waitForTimeout(300);
}
check("rest keys on frame 0", timesOf(await keys(), "body", "skin_torso", "torso").join() === "0,6" && timesOf(await keys(), "body", "hair_back", "hair").join() === "0,8", [timesOf(await keys(), "body", "skin_torso", "torso"), timesOf(await keys(), "body", "hair_back", "hair")]);
await E(() => window.atlasShapeKeys.select([]));
// onion skin on frame 4 shows ghosts of frames 2, 3, 5 and 6: the 6 ghost carries the full squash
await goto(4);
await E(() => window.atlasShapeKeys.select([]));
const torsoClip = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3, width: box.width * 0.4, height: box.height * 0.45 };
const withoutOnion = await page.screenshot({ clip: torsoClip });
await E(() => document.getElementById("onionbtn").click());
await page.waitForTimeout(300);
await goto(4);
await page.waitForTimeout(800);
const onion = await E(() => window.atlasEditor.onionInfo());
check("onion skin is on with ghosts", onion?.enabled && onion.ghosts > 0, onion);
const withOnion = await page.screenshot({ clip: torsoClip });
let diff = 0;
for (let i = 0; i < Math.min(withOnion.length, withoutOnion.length); i++) if (withOnion[i] !== withoutOnion[i]) diff++;
check("the onion skin ghosts of the keyed deforms change the picture", diff > 2000, diff);
await shot("7-onion-both.png");

// ---- 4. dopesheet rows and the amount curve
const rows = await E(() => window.atlasEditor.timelineRows());
const deformRows = rows.filter((r) => r.kind === "deform");
check("dopesheet shows a deform row per mesh under its slot", deformRows.length === 2, rows.map((r) => `${r.kind}:${r.name}`));
await goto(6);
await E(() => window.atlasShapeKeys.setTarget("body/skin_torso/torso"));
await page.waitForTimeout(400);
await shot("8-timeline-rows-amount-curve.png");

// ---- 5. Clear deform: three options, one undo step each
await goto(6);
await E(() => window.atlasShapeKeys.setTarget("body/skin_torso/torso"));
await E(() => window.atlasShapeKeys.select([0, 1, 2, 3]));
const before = await E(() => window.atlasShapeKeys.positions());
await page.click("#sk-clear-sel");
await page.waitForTimeout(400);
const afterSel = await E(() => window.atlasShapeKeys.positions());
let changed = 0;
for (let i = 0; i < before.length; i += 2) if (Math.hypot(afterSel[i] - before[i], afterSel[i + 1] - before[i + 1]) > 0.01) changed++;
check("Clear selected zeroes only the selected vertices on this frame (key stays)", changed >= 1 && changed <= 4 && timesOf(await keys(), "body", "skin_torso", "torso").includes(6), changed);
await E(() => window.atlasEditor.undo());
await page.waitForTimeout(300);
const undone = await E(() => window.atlasShapeKeys.positions());
check("that was one undo step", Math.hypot(undone[0] - before[0], undone[1] - before[1]) < 0.01);
await page.click("#sk-clear-key");
await page.waitForTimeout(400);
check("Delete key removes the key on this frame only", !timesOf(await keys(), "body", "skin_torso", "torso").includes(6));
await E(() => window.atlasEditor.undo());
await page.waitForTimeout(300);
check("undo brings the key back", timesOf(await keys(), "body", "skin_torso", "torso").includes(6));
await page.click("#sk-clear-all");
await page.waitForTimeout(400);
check("Remove all drops the whole timeline", !(await keys()).body?.skin_torso);
check("the hair keys are untouched", timesOf(await keys(), "body", "hair_back", "hair").includes(8));
await shot("9-after-clear.png");

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
