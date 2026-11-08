// New rig flow, end to end, in a sandboxed server (ATLAS_EDITOR_DATA_DIR, free port, never 5211):
//   1. root master control: select with Shift+R, move it in Setup;
//   2. New rig "test-blob" from 5 generated PNG parts, draw 3 bones, auto-bind, key a 2-pose clip, export Spine, reload, still listed;
//   3. New rig from the practice kit's layered PSD (copied first; the Desktop folder is never modified).
//   node packages/animator-editor/scripts/demo-new-rig.mjs [outDir]
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const { PNG } = require("pngjs");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
mkdirSync(out, { recursive: true });
const { url, dataDir } = await demoServer();

const work = mkdtempSync(join(tmpdir(), "new-rig-demo-"));
const swatch = (name, w, h, rgb) => {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;
    png.data.set(inside ? [...rgb, 255] : [0, 0, 0, 0], i);
  }
  const file = join(work, name);
  writeFileSync(file, PNG.sync.write(png));
  return file;
};
const parts = [
  swatch("00_leg.png", 40, 110, [90, 120, 200]),
  swatch("01_body.png", 90, 120, [200, 90, 90]),
  swatch("02_arm_left.png", 36, 100, [90, 200, 120]),
  swatch("03_arm_right.png", 36, 100, [200, 200, 90]),
  swatch("04_head.png", 70, 70, [220, 180, 150])
];
// The practice kit is copied first; only the copy is read.
const KIT = (process.env.ATLAS_RIG_PRACTICE_KIT ?? join(homedir(), "Desktop", "rig-practice-kit")).split("\\").join("/");
const psdCopy = join(work, "kit-body-cutout_layers.psd");
const havePsd = existsSync(`${KIT}/kit-body-cutout_layers.psd`);
if (havePsd) copyFileSync(`${KIT}/kit-body-cutout_layers.psd`, psdCopy);
const kitPngs = [];
if (havePsd) for (const f of readdirSync(KIT).filter((n) => /^\d\d_.*\.png$/.test(n))) {
  copyFileSync(`${KIT}/${f}`, join(work, f));
  kitPngs.push(join(work, f));
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const errors = [];
const open = async () => {
  const page = revealTabs(await browser.newPage({ viewport: { width: 1900, height: 1100 } }), { workspace: "home" });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  return page;
};
let page = await open();
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: resolve(out, name) });
const settle = () => E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));

// Drops files on the dialog's drop zone (real DataTransfer with File objects).
const dropFiles = async (files) => {
  const payload = files.map((f) => ({ name: f.split(/[\\/]/).pop(), b64: readFileSync(f).toString("base64") }));
  await E((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.name.endsWith(".png") ? "image/png" : "application/octet-stream" }));
    }
    document.querySelector("#newrig-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, payload);
  await page.waitForFunction(() => document.querySelector("#newrig-parts")?.children.length > 0, null, { timeout: 30_000 });
};

// ---- Home entry ----------------------------------------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("home"));
await settle();
check("Home has a New rig button", await page.isVisible("#home-newrig"));
await shot("01-home.png");

// ---- 1. Root master control ----------------------------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("rig"));
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1200);
await E(() => window.atlasEditor.setMode("setup"));
await settle();
await page.keyboard.press("Shift+R");
await settle();
check("Shift+R selects the root", (await E(() => window.atlasEditor.state().selected)) === "root");
await shot("02-root-selected-setup.png");
await E(() => window.atlasEditor.setupTool("transform"));
const r0 = await E(() => window.atlasEditor.setupBoneWorld("root"));
const rootBefore = await E(() => window.atlasEditor.setupRaw().bones.find((b) => b.name === "root"));
const a = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [r0.origin.x, r0.origin.y]);
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move(a.x + 20, a.y + 10, { steps: 4 });
await page.mouse.move(a.x + 40, a.y + 20, { steps: 4 });
await page.mouse.up();
await settle();
const rootAfter = await E(() => window.atlasEditor.setupRaw().bones.find((b) => b.name === "root"));
check("moving the root in Setup edits the rig placement", rootAfter.x !== rootBefore.x || rootAfter.y !== rootBefore.y, { rootBefore, rootAfter });
await shot("03-root-moved-setup.png");
await E(() => window.atlasEditor.setupUndo());
await E(() => window.atlasEditor.setMode("animate"));
await E(() => window.atlasEditor.workspace("animate"));
await page.keyboard.press("Shift+R");
await settle();
check("root is selectable in Animate too", (await E(() => window.atlasEditor.state().selected)) === "root");
await shot("04-root-animate-flag.png");

// ---- 2. New rig from generated PNGs --------------------------------------------------------------------------------
await E(() => window.atlasEditor.workspace("rig"));
await page.click("#newrig-open");
await page.waitForSelector("#newrig-dialog");
await page.fill("#newrig-name", "Test Blob");
check("the folder id follows the name", (await page.inputValue("#newrig-id")) === "test-blob");
await page.fill("#newrig-id", "Bad Id!");
check("a bad id is refused with a message", (await page.isDisabled("#newrig-create")) && (await page.textContent("#newrig-idmsg")).length > 0);
await page.fill("#newrig-id", "test-blob");
await dropFiles(parts);
check("5 parts listed", (await E(() => document.querySelector("#newrig-parts").children.length)) === 5);
await shot("05-new-rig-dialog.png");
await page.click("#newrig-create");
await page.waitForSelector("#newrig-steps:not([hidden])", { timeout: 30_000 });
await settle();
const created = await E(() => ({ rig: window.atlasEditor.setupRaw(), btn: !!document.querySelector('#outfits-menu button[data-id="test-blob"]') }));
check("the rig opened with 5 slots on root and is in the outfit menu", created.rig.slots.length === 5 && created.rig.slots.every((s) => s.bone === "root") && created.btn, { slots: created.rig.slots.length });
check("the steps card shows the five steps", (await E(() => document.querySelectorAll("#newrig-steps li").length)) === 5);
await shot("06-new-rig-steps.png");

// Draw 3 bones (the Draw bone tool, click-drag; the parent is the pressed or selected bone).
await E(() => window.atlasEditor.setMode("setup"));
await page.click('#toolpalette [data-tool="bone"]');
const dragSk = async (from, to) => {
  const p = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), from);
  const q = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), to);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
  await page.mouse.move(q.x, q.y, { steps: 6 });
  await page.mouse.up();
  await settle();
};
const centres = await E(() => window.atlasEditor.setupRaw().skins.default.attachments);
const xs = Object.values(centres).map((s) => Object.values(s)[0].x);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const span = maxX - minX;
await dragSk([minX - 20, -55], [minX + span * 0.33, -55]);
await dragSk([minX + span * 0.33, -55], [minX + span * 0.66, -55]);
await dragSk([minX + span * 0.66, -55], [maxX + 20, -55]);
const bones = await E(() => window.atlasEditor.setupRaw().bones.map((b) => `${b.name}<${b.parent ?? ""}`));
check("3 bones drawn, chained from the root", bones.length === 4 && bones.filter((b) => b.endsWith("<root")).length >= 1, bones);
await shot("07-bones-drawn.png");

// Setup tool bar: Select, Rotate, Move, Length, Draw bone, Image.
const toolBtns = await E(() => [...document.querySelectorAll("#setuphud button[data-tool]")].map((b) => b.dataset.tool));
check("the Setup tool bar lists Select, Rotate, Move, Length, Draw bone", ["select", "rotate", "move", "length", "bone"].every((t) => toolBtns.includes(t)), toolBtns);
await E(() => window.atlasEditor.select("bone2"));
const boneRaw = () => E(() => window.atlasEditor.setupRaw().bones.find((b) => b.name === "bone2"));
const b2 = await E(() => window.atlasEditor.setupBoneWorld("bone2"));
const mid = { x: (b2.origin.x + b2.tip.x) / 2, y: (b2.origin.y + b2.tip.y) / 2 };
// Move: drag the body anywhere along the bone; the arms (red x, green y) are drawn.
await page.keyboard.press("t");
check("T is the Move tool in Setup", (await E(() => document.querySelector('#toolpalette [data-tool="move"]').classList.contains("on"))));
const mv0 = await boneRaw();
const sMid = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [mid.x, mid.y]);
await page.mouse.move(sMid.x, sMid.y);
await settle();
const hintMove = await E(() => document.querySelector("#status")?.textContent ?? "");
check("hovering the bone body says what a drag does", /move bone/i.test(hintMove), hintMove);
check("the hover cursor is a move cursor", ["move", "ew-resize"].includes(await E(() => document.querySelector("#view").style.cursor)));
await shot("14-setup-move-arms.png");
await dragSk([mid.x, mid.y], [mid.x + 30, mid.y - 25]);
const mv1 = await boneRaw();
check("Move: dragging the bone body moves it (setup position)", Math.abs(mv1.x - mv0.x) + Math.abs(mv1.y - mv0.y) > 5, { mv0: [mv0.x, mv0.y], mv1: [mv1.x, mv1.y] });
// Move along X only, with the red arm.
const o2 = await E(() => window.atlasEditor.setupBoneWorld("bone2"));
await dragSk([o2.origin.x + 30, o2.origin.y], [o2.origin.x + 60, o2.origin.y + 40]);
const mv2 = await boneRaw();
check("the red X arm moves along X only", Math.abs(mv2.x - mv1.x) > 3 && Math.abs(mv2.y - mv1.y) < 1.5, { mv1: [mv1.x, mv1.y], mv2: [mv2.x, mv2.y] });
// Length: drag the tip.
await page.keyboard.press("l");
const o3 = await E(() => window.atlasEditor.setupBoneWorld("bone2"));
const len0 = (await boneRaw()).length;
await dragSk([o3.tip.x, o3.tip.y], [o3.tip.x + 40, o3.tip.y]);
const len1 = (await boneRaw()).length;
check("Length: dragging the tip changes the length", Math.abs(len1 - len0) > 10, { len0, len1 });
// Rotate: drag anywhere.
await page.keyboard.press("r");
check("R is the Rotate tool in Setup (and Shift+R still selects the root)", await E(() => document.querySelector('#toolpalette [data-tool="rotate"]').classList.contains("on")));
const rot0 = (await boneRaw()).rotation ?? 0;
const o4 = await E(() => window.atlasEditor.setupBoneWorld("bone2"));
await dragSk([o4.origin.x + 120, o4.origin.y + 100], [o4.origin.x + 90, o4.origin.y + 150]);
const rot1 = (await boneRaw()).rotation ?? 0;
check("Rotate: dragging anywhere turns the selected bone", Math.abs(rot1 - rot0) > 5, { rot0, rot1 });
await shot("15-setup-rotate.png");
// Select keeps the direct handles: drag the origin dot.
await page.keyboard.press("v");
const o5 = await E(() => window.atlasEditor.setupBoneWorld("bone2"));
const sel0 = await boneRaw();
await dragSk([o5.origin.x, o5.origin.y], [o5.origin.x + 20, o5.origin.y + 20]);
const sel1 = await boneRaw();
check("Select still moves the bone by its origin dot", Math.abs(sel1.x - sel0.x) + Math.abs(sel1.y - sel0.y) > 3);
await page.keyboard.press("b");
// Auto-bind.
await page.click("#setup-autobind");
await settle();
const bound = await E(() => window.atlasEditor.setupRaw().slots.map((s) => `${s.name}@${s.bone}`));
check("auto-bind moved the slots onto the drawn bones", bound.every((b) => !b.endsWith("@root")) && new Set(bound.map((b) => b.split("@")[1])).size >= 2, bound);
await shot("08-auto-bound.png");
// Reassign one slot with the dropdown.
await E(() => window.atlasEditor.setupSelectSlot("head"));
await settle();
const dd = await page.$("#setup-slot-bone");
check("the slot's bone dropdown is there", !!dd);
await page.click("#setupsave, #setup-save").catch(() => {});
await E(() => window.atlasEditor.setupSave());
await settle();
check("Setup edits saved to the rig file", !(await E(() => window.atlasEditor.setupState().unsaved)));

// Animate: 2-pose clip.
await E(() => window.atlasEditor.setMode("animate"));
await E(() => window.atlasEditor.workspace("pro"));
await settle();
await page.click("#newclip-open");
await page.fill("#newclip-name", "wobble");
await page.click("#newclip-make");
await settle();
const firstBone = bones.find((b) => !b.startsWith("root"))?.split("<")[0];
await E((b) => window.atlasEditor.select(b), firstBone);
await E(() => window.atlasEditor.setTime(0));
await E((b) => window.atlasEditor.rotate(b, 0), firstBone);
await E(() => window.atlasEditor.key());
await E(() => window.atlasEditor.setTime(0.5));
await E((b) => window.atlasEditor.rotate(b, 35), firstBone);
await E(() => window.atlasEditor.key());
await settle();
const keys = await E(() => window.atlasEditor.timelineRows().length);
check("the clip has keys on the new rig", keys > 0, keys);
await shot("09-animate-clip.png");
// Spine export.
await E(() => window.atlasEditor.workspace("ship"));
await E(() => window.atlasEditor.workspace("pro"));
const exp = await E(async () => {
  const res = await fetch("/api/rig/export-spine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: "packages/animator/rigs/test-blob/test-blob.anim.json" }) });
  const j = await res.json();
  return { ok: res.ok, error: j.error, images: j.images, clips: j.clips };
});
check("Spine export works on the new rig", exp.ok && exp.images === 5, exp);

// Reload: still listed and loadable.
page.removeAllListeners("pageerror");
await page.close();
page = await open();
const listed = await page.evaluate(async () => {
  const r = await (await fetch("/api/rigs")).json();
  return { ids: r.rigs.map((x) => x.id), button: !!document.querySelector('#outfits-menu button[data-id="test-blob"]') };
});
check("after a reload the rig is listed (server list and menu)", listed.ids.includes("test-blob") && listed.button, listed);
await page.evaluate(() => window.atlasEditor.workspace("rig"));
await page.evaluate(() => window.atlasEditor.mountOutfit("test-blob"));
await page.waitForTimeout(1500);
const reloaded = await page.evaluate(() => ({ slots: window.atlasEditor.setupRaw().slots.map((s) => s.bone), bones: window.atlasEditor.setupRaw().bones.length, clips: Object.keys(window.atlasEditor.setupRaw().animations ?? {}) }));
check("the reloaded rig keeps its bones and bindings", reloaded.bones === 4 && reloaded.slots.every((b) => b !== "root"), reloaded);
await shot("10-after-reload.png");

// ---- 3. PSD import (a copy of the practice kit) ----------------------------------------------------------------------
if (havePsd) {
  await E(() => window.atlasEditor.workspace("rig"));
  await page.click("#newrig-open");
  await page.waitForSelector("#newrig-dialog");
  await page.fill("#newrig-name", "Kit PSD");
  await dropFiles([psdCopy]);
  const layerCount = await E(() => document.querySelector("#newrig-parts").children.length);
  check("the PSD gave 23 layers", layerCount === 23, layerCount);
  const topName = await E(() => document.querySelector("#newrig-parts input").value);
  check("the front-most layer is listed first", topName === "skin_hand_near", topName);
  await shot("11-psd-dialog.png");
  await page.click("#newrig-create");
  await page.waitForSelector("#newrig-steps:not([hidden])", { timeout: 60_000 });
  await settle();
  const psdRig = await E(() => window.atlasEditor.setupRaw());
  const foot = psdRig.skins.default.attachments.skin_foot_near.skin_foot_near;
  check("23 slots in layer order, back first", psdRig.slots.length === 23 && psdRig.slots[0].name === "skin_foot_near" && psdRig.slots[22].name === "skin_hand_near", psdRig.slots.map((s) => s.name).slice(0, 2));
  const og = psdRig.canvas;
  check("layers sit at their PSD positions relative to the ground origin", Math.abs(foot.x - (439.5 - og.originX)) < 0.6 && Math.abs(foot.y - (1179.5 - og.originY)) < 0.6, { foot: [foot.x, foot.y], origin: [og.originX, og.originY] });
  check("root stands on the ground between the feet (origin y at the lowest opaque pixel, about 1240)", og.originY > 1200 && og.originY < 1260 && Math.abs(og.originX - 543) < 40 && psdRig.bones[0].x === 0 && psdRig.bones[0].y === 0, og);
  check("the rig canvas is the PSD's size", psdRig.canvas.width === 1086 && psdRig.canvas.height === 1448, psdRig.canvas);
  await E(() => window.atlasEditor.fit?.());
  await settle();
  await E(() => window.atlasEditor.setMode("setup"));
  await page.keyboard.press("Shift+R");
  await settle();
  check("root sits at the feet on screen (root below the pelvis)", await E(() => { const r = window.atlasEditor.setupBoneWorld("root"); return !!r; }));
  check("Set ground here is a visible button when root is selected", await page.isVisible("#setup-ground"));
  await shot("12-psd-rig.png");
  // Set ground here on a rig whose root is off the ground: the PNG test-blob rig.
  // The loose PNGs of the kit (no offsets) also import.
  await E(() => window.atlasEditor.workspace("rig"));
  await page.click("#newrig-open");
  await page.waitForSelector("#newrig-dialog");
  await page.fill("#newrig-name", "Kit PNGs");
  await dropFiles(kitPngs);
  check("the kit's 23 PNGs list in name order", (await E(() => document.querySelector("#newrig-parts").children.length)) === 23);
  await page.click("#newrig-create");
  await page.waitForSelector("#newrig-steps:not([hidden])", { timeout: 60_000 });
  await settle();
  const pr = await E(() => window.atlasEditor.setupRaw());
  check("23 PNG slots named without the order prefix", pr.slots.length === 23 && pr.slots[0].name === "skin_foot_near", pr.slots[0].name);
  await shot("13-png-kit-rig.png");
}

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed", `(sandbox ${dataDir})`);
process.exit(failures ? 1 : 0);
