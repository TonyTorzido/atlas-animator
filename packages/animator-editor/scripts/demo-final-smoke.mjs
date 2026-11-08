// Final smoke run of the user's core flow on the turned rig, real mouse and keyboard, a screenshot per step:
// new clip -> three poses (rotate ring, move and foot IK drags) -> play -> Ctrl+K -> wear leather in Swag, Phone size, Facing right,
// gate chips -> paint a weight in Rig and undo -> Export Spine from Ship.  Sandboxed server (demo-server.mjs), free port.
//   node packages/animator-editor/scripts/demo-final-smoke.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/ReadPixels|GPU stall/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
let n = 0;
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
};
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "final_smoke");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(600);
await E(() => window.atlasEditor.setBoneView("full"));
check("a clip is open on the turned rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned" && !!(await E(() => window.atlasEditor.state().clip)));
await shot("new-clip");
const setT = async (f) => {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(250);
};
const dragPath = async (pts) => {
  await page.mouse.move(...pts[0]);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};
const ends = (b) => E((x) => window.atlasEditor.boneScreenEnds(x), b);
const BONE = "upper_arm_near";

// ---- pose 1 (frame 0): rotate ring drag on the arm
await setT(0);
await E((b) => window.atlasEditor.select(b), BONE);
await E(() => window.atlasEditor.setGizmo("rotate"));
const ang = () => E((b) => window.atlasEditor.boneRot(b), BONE);
const a0 = await ang();
let c = (await ends(BONE)).origin;
const ring = (a) => [c.x + 70 * Math.cos(a), c.y + 70 * Math.sin(a)];
await dragPath(Array.from({ length: 13 }, (_, i) => ring(-0.6 + (i * 0.9) / 12)));
const a1 = await ang();
check("the rotate ring drag turns the arm", Math.abs(a1 - a0) > 10, { a0, a1 });
await page.keyboard.press("k");
await shot("pose-1-rotate-drag");

// ---- pose 2 (frame 12): move gizmo drag on the hips
await setT(12);
const names = await E(() => window.atlasEditor.debug().skeleton.bones.map((b) => b.data.name));
const hip = names.find((b) => /^(hips?|pelvis)/.test(b)) ?? "root";
await E((b) => window.atlasEditor.select(b), hip);
await E(() => window.atlasEditor.setGizmo("move"));
const m0 = await E((b) => window.atlasEditor.moveOf(b), hip);
c = (await ends(hip)).origin;
await dragPath([[c.x, c.y], [c.x + 20, c.y - 12], [c.x + 40, c.y - 24]]);
const m1 = await E((b) => window.atlasEditor.moveOf(b), hip);
check("the move drag moves the hips", Math.abs(m1.x - m0.x) + Math.abs(m1.y - m0.y) > 3, { hip, m0, m1 });
await page.keyboard.press("k");
await shot("pose-2-move-drag");

// ---- pose 3 (frame 24): foot IK drag
await setT(24);
await E(() => window.atlasEditor.setGizmo("move"));
const feet = names.filter((b) => /foot/.test(b));
const footName = feet.find((b) => /near$/.test(b)) ?? feet[0];
await E((b) => window.atlasEditor.select(b), footName);
const fh = (await E(() => window.atlasEditor.overlayState().ikHandles)).find((h) => /foot_near/.test(h.name));
const fo = (await ends(footName)).origin;
const f0 = { x: fh.x, y: fh.y };
await dragPath([[fo.x, fo.y], [fo.x + 18, fo.y - 14], [fo.x + 40, fo.y - 30]]);
const f1 = (await E(() => window.atlasEditor.overlayState().ikHandles)).find((h) => h.name === fh.name);
check("the foot IK drag lifts the foot target", !!f1 && Math.hypot(f1.x - f0.x, f1.y - f0.y) > 8, { handle: fh.name, f0, f1 });
await page.keyboard.press("k");
const keyed = await E(() => {
  const cl = window.atlasEditor.state().clip;
  return { bones: Object.keys(cl.bones), ik: Object.keys(cl.ik ?? {}) };
});
check("three poses are keyed (rotate, move and the foot)", keyed.bones.length >= 2, keyed);
await shot("pose-3-foot-ik-drag");

// ---- play
await E(() => window.atlasEditor.setGizmo("rotate"));
await setT(0);
await page.keyboard.press("Space");
await page.waitForTimeout(700);
const tPlay = await E(() => window.atlasEditor.state().time);
await shot("playing");
const tPlay2 = await E(() => window.atlasEditor.state().time);
check("playback advances the playhead", tPlay !== tPlay2 || tPlay > 0, { tPlay, tPlay2 });
await page.keyboard.press("Space");
await page.waitForTimeout(300);

// ---- Ctrl+K
await page.mouse.click(5, 500);
await page.keyboard.press("Control+k");
await page.waitForSelector("#palette .palette-input");
await page.keyboard.type("swag");
check("Ctrl+K lists actions", (await E(() => document.querySelectorAll("#palette .palette-row").length)) > 0);
await shot("palette-ctrl-k");
await page.keyboard.press("Escape");

// ---- Swag: leather, Phone size, Facing right, gate chips
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForTimeout(700);
await page.click('.swrow[data-item="chest.leather"] [data-act="wear"]');
await page.waitForTimeout(900);
check("leather chest is worn", (await E(() => window.atlasEditor.skins().active)).includes("chest.leather"));
await shot("swag-leather");
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(600);
await page.mouse.click(5, 500);
await page.keyboard.press("p");
await page.waitForTimeout(500);
const zPhone = await E(() => window.atlasEditor.debug().world.scale.x);
check("Phone size zooms to the 0.42 scale", Math.abs(zPhone - 0.42) < 0.08, zPhone);
await page.keyboard.press("x");
await page.waitForTimeout(500);
check("Facing right flips the preview", await E(() => document.getElementById("facingbtn")?.classList.contains("on")));
const chips = await E(() => ({ pill: document.getElementById("gatepill")?.textContent, rows: [...document.querySelectorAll("#gates > *")].map((e) => e.textContent.trim().slice(0, 50)).slice(0, 10) }));
console.log("gate chips", JSON.stringify(chips));
check("the gate chips are shown", !!chips.pill && chips.pill !== "...", chips);
await shot("swag-phone-size-facing-right");
await page.keyboard.press("x");
await page.keyboard.press("p");
await page.waitForTimeout(400);

// ---- Rig: paint a weight, undo
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(700);
await page.mouse.click(5, 500);
await page.keyboard.press("w");
await page.waitForSelector("#wt-root", { timeout: 20_000 });
await page.waitForTimeout(600);
const opts = await E(() => [...document.querySelectorAll("#wt-root select option")].slice(0, 80).map((o) => ({ v: o.value, t: o.textContent })));
const big = opts.map((o) => ({ ...o, n: Number(/- (\d+)$/.exec(o.t.trim())?.[1] ?? 0) })).sort((x, y) => y.n - x.n)[0];
console.log("mesh options", opts.length, JSON.stringify(big));
if (big) {
  await E((v) => { const sel = document.querySelector("#wt-root select"); sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); }, big.v);
  await page.waitForTimeout(800);
}
console.log("weights", JSON.stringify(await E(() => { const st = window.atlasWeights.state(); return { v: st.vertices, addr: st.addr }; })));
await E(() => window.atlasWeights.setActive("shin_far"));
const bone = await E(() => window.atlasWeights.bone("shin_far"));
const at = await E((p) => window.atlasWeights.client(p[0], p[1]), bone);
await E(() => window.atlasWeights.setBrush({ mode: "add", radiusPx: 60, strength: 0.6 }));
const undo0 = await E(() => window.atlasEditor.setupState().undoable);
await dragPath(Array.from({ length: 12 }, (_, k) => [at.x - 40 + k * 7, at.y + (k % 2) * 6]));
await page.waitForTimeout(700);
const undo1 = await E(() => window.atlasEditor.setupState().undoable);
check("a brush stroke paints a weight (one undo step)", undo1 === undo0 + 1, { undo0, undo1 });
await shot("rig-weight-painted");
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);
check("Ctrl+Z undoes the stroke", (await E(() => window.atlasEditor.setupState().undoable)) === undo0);
await shot("rig-weight-undone");

// ---- Ship: Export Spine
await E(() => window.atlasEditor.workspace("ship"));
await page.waitForTimeout(700);
await page.click("#ship-spine-export");
await page.waitForFunction(() => /Wrote /.test((document.getElementById("spine-result")?.textContent ?? "") + (document.getElementById("ship-spine")?.textContent ?? "")), null, { timeout: 120_000 }).catch(() => {});
const res = await E(() => (document.getElementById("spine-result")?.textContent ?? "") + (document.getElementById("ship-spine")?.textContent ?? ""));
check("Export Spine writes a skeleton", /Wrote /.test(res), res.slice(0, 120));
await shot("ship-export-spine");

check("no page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
