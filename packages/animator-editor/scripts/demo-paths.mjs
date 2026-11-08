// Demo of motion paths and pins on the turned rig: the weapon tip path comes on by itself in an attack clip, dots are clickable,
// a hand pin keeps the fist planted while the body steps, "hand to weapon grip" holds the far hand on the haft, Unpin gives FK back.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-paths.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/paths"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }), { workspace: "pro" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor && !!window.atlasPaths, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, name) });
  console.log(resolve(out, name));
};
const frame = async (f) => {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(150);
};
const pose = (f, values, moves = {}) =>
  E(
    ([fr, vals, mv]) => {
      const e = window.atlasEditor;
      e.setTime(fr / 30);
      for (const [bone, v] of Object.entries(vals)) {
        e.select(bone);
        e.rotate(bone, v);
        e.key();
      }
      for (const [bone, [x, y]] of Object.entries(mv)) {
        e.select(bone);
        e.move(bone, x, y);
        e.key();
      }
    },
    [f, values, moves]
  );
const dots = () => E(() => window.atlasPaths.dots());
const state = () => E(() => window.atlasEditor.state().clip);
const ikText = (keys) => keys?.map((k) => `${Math.round(k.time * 30)}:${k.mix}`).join();

check("opens on the turned rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned");
await page.click("#newclip-open");
await page.fill("#newclip-name", "attack_swing");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await page.fill("#duration", String(20 / 30));
await page.press("#duration", "Enter");
await pose(0, { upper_arm_near: 0, forearm_near: 0 }, { body: [0, 0] });
await pose(6, { upper_arm_near: -70, forearm_near: -30 });
await pose(10, { upper_arm_near: -80, forearm_near: -34 });
await pose(14, { upper_arm_near: 25, forearm_near: -8 }, { body: [-6, 2] });
await pose(20, { upper_arm_near: 40, forearm_near: -5 }, { body: [-8, 2] });
await frame(10);
await page.waitForTimeout(400);

// 1. Paths: on by themselves for the weapon tip in an attack clip.
const settings = await E(() => window.atlasPaths.settings());
check("an attack clip turns Paths on with the weapon tip", settings.on && settings.tip, settings);
let d = await dots();
const tip = d.find((p) => p.id === "weapon-tip");
check("one dot per frame (21 frames), key frames flagged", tip?.dots.length === 21, { dots: tip?.dots.length, keys: tip?.dots.filter((x) => x.key).map((x) => x.frame) });
await shot("1-weapon-tip-path.png");

// 2. A selected bone and the fist centre, onion range of 4 frames.
await E(() => window.atlasEditor.select("hand_near"));
await page.check("#paths-fist input");
await page.selectOption("#paths-range", "4");
await page.waitForTimeout(400);
d = await dots();
check("selected bone and fist add paths", d.length === 3, d.map((p) => [p.id, p.dots.length]));
await shot("2-selected-fist-onion.png");
await page.selectOption("#paths-range", "all");
await page.uncheck("#paths-fist input");
await E(() => window.atlasEditor.select("root"));

// 3. Clicking a dot jumps to its frame.
await page.waitForTimeout(500);
d = await dots();
const target = d.find((p) => p.id === "weapon-tip").dots.find((x) => x.frame === 6);
await page.mouse.click(target.x, target.y);
await page.waitForTimeout(300);
const at = await E(() => Math.round(window.atlasEditor.state().time * 30));
check("clicking the frame 6 dot jumps to frame 6", at === 6, at);

// 4. Pin the near hand over frames 4-18 while the body steps: it stays planted.
await page.click("#pins-toggle");
await frame(4);
await page.fill("#pins-from", "4");
await page.fill("#pins-to", "18");
const handAt = (f) => E((fr) => { const e = window.atlasEditor; e.setTime(fr / 30); const h = e.debug().skeleton.findBone("hand_near"); return { x: h.world.x, y: h.world.y }; }, f);
const free = [];
for (const f of [4, 11, 18]) free.push(await handAt(f));
await frame(4);
await page.click('#pins-add button:has-text("Pin hand near")');
await page.waitForTimeout(300);
let c = await state();
check("pin keys the near hand IK mix to 1 with clean edges", ikText(c.ik.hand_ik_near) === "3:0,4:1,18:1,19:0", c.ik.hand_ik_near);
const spots = [];
for (const f of [4, 6, 8, 11, 14, 16, 18]) spots.push(await handAt(f));
const drift = Math.max(...spots.map((s) => Math.hypot(s.x - spots[0].x, s.y - spots[0].y)));
check("the pinned fist stays within 0.5 px while the body steps", drift < 0.5, { drift, unpinnedDrift: Math.hypot(free[2].x - free[0].x, free[2].y - free[0].y) });
await frame(12);
await page.mouse.move(5, 5);
await shot("3-hand-pinned.png");

// 5. Hand to weapon grip.
await frame(6);
await page.fill("#pins-from", "6");
await page.fill("#pins-to", "16");
await page.click('#pins-add button:has-text("Hand to weapon grip")');
await page.waitForTimeout(300);
c = await state();
check("grip hold keys trail_grip mix 1 over the range", ikText(c.ik.trail_grip) === "5:0,6:1,16:1,17:0", c.ik.trail_grip);
await frame(11);
await shot("4-grip-and-pin-bars.png");
const chips = await E(() => [...document.querySelectorAll("#pins-list .pin-chip")].map((x) => x.textContent));
check("the pin list shows both pins", chips.length === 2, chips);

// 6. Unpin gives FK back.
await page.click('#pins-list .pin-row:has-text("Hand near") .pin-unpin');
await page.waitForTimeout(200);
await page.click('#pins-list .pin-row:has-text("weapon grip") .pin-unpin');
await page.waitForTimeout(300);
c = await state();
check("unpin removes the IK keys and the target keys", !c.ik?.hand_ik_near && !c.ik?.trail_grip && !c.bones.hand_near_target, { ik: c.ik, bones: Object.keys(c.bones) });
const back = await handAt(18);
check("FK is back: the hand moves with the body again", Math.hypot(back.x - free[0].x, back.y - free[0].y) > 3 || Math.hypot(free[2].x - back.x, free[2].y - back.y) < 0.5, { back, free });
await shot("5-unpinned.png");
check("no page errors", errors.length === 0, errors);
await browser.close();
process.exitCode = failed || errors.length ? 1 : 0;
