// Demo of the Game view (V): the clip as the runtime draws it, on the "Straight front (pro)" rig, with screenshots.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-gameview.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/gameview"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1800 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(800);
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const shot = async (name, locator) => {
  await page.waitForTimeout(400);
  const file = resolve(out, name);
  await (locator ?? page).screenshot({ path: file });
  console.log(file);
};

// The default rig is the turned pro rig: a one-handed overhead chop with the weapon events on it.
check("the turned rig is open", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned");
await page.click("#newclip-open");
await page.fill("#newclip-name", "gameview_chop");
await page.click("#newclip-make");
await page.waitForTimeout(200);
await E(() => {
  const e = window.atlasEditor;
  const pose = (f, vals) => {
    e.setTime(f / 30);
    for (const [bone, v] of Object.entries(vals)) {
      e.select(bone);
      e.rotate(bone, v);
      e.key();
    }
  };
  pose(0, { upper_arm_near: 0, forearm_near: 0, weapon: 0, chest: 0 });
  pose(8, { upper_arm_near: -70, forearm_near: -30, weapon: 0, chest: 8 });
  pose(12, { upper_arm_near: 60, forearm_near: 10, weapon: 100, chest: -10 });
  pose(18, { upper_arm_near: 80, forearm_near: 10, weapon: 100, chest: -14 });
  pose(28, { upper_arm_near: 0, forearm_near: 0, weapon: 0, chest: 0 });
  e.addEvent("windup", 0);
  e.addEvent("trailOn", 9);
  e.addEvent("hit", 12);
  e.addEvent("trailOff", 17);
  e.addEvent("follow", 18);
  e.addEvent("ready", 26);
  e.setTime(0);
});

// Open with the V hotkey.
await page.keyboard.press("v");
await page.waitForTimeout(300);
let info = await E(() => window.atlasEditor.gameViewInfo());
check("V opens the project view", info.open === true && (await page.locator("#gameview").isVisible()));
check("the backing store uses the client's render resolution", info.resolution >= 2, info.resolution);
check("three sizes: 0.4, 0.471 and 1x", JSON.stringify(Object.keys(info.sizes).sort()) === JSON.stringify(["0.4", "0.471", "1"]), Object.keys(info.sizes));

// Frame the swing by hand on the project clock: before the hit, on the hit (hit-stop + flash), after it.
await E(() => window.atlasEditor.gameViewPlay(false));
info = await E(() => window.atlasEditor.gameViewSeek(0.37));
check("trail runs while trailOn..trailOff is open", info.trailPoints >= 2, info.trailPoints);
check("no flash before the hit", info.dummy.flash === 0, info.dummy.flash);
await shot("gameview-before-hit.png", page.locator("#gameview"));
info = await E(() => window.atlasEditor.gameViewSeek(0.4 + 1 / 60));
check("the hit event fired once, with a hit-stop and a flash on the target", info.fired.hit === 1 && info.fired.held >= 1 && info.dummy.flash > 0.5, { fired: info.fired, flash: info.dummy.flash, held: info.step.held });
check("the target stands on the weapon's side at weapon range", Math.abs(info.dummy.x) >= 240 && info.dummy.side === (info.tip.x < 0 ? -1 : 1), { dummy: info.dummy.x, tip: info.tip });
await shot("gameview-hit-flash.png", page.locator("#gameview"));
await shot("gameview-full-editor.png");
info = await E(() => window.atlasEditor.gameViewSeek(0.7));
check("after the hit the flash is gone", info.dummy.flash === 0 && info.dummy.pushPx === 0, info.dummy);

// Mirror: the target moves to the other side.
const before = info.dummy.x;
await E(() => window.atlasEditor.gameViewOptions({ mirror: true }));
info = await E(() => window.atlasEditor.gameViewSeek(0.4 + 1 / 60));
await shot("gameview-mirrored.png", page.locator("#gameview"));
check("mirror flips the view (option stored)", info.options.mirror === true && info.dummy.x === before, { before, now: info.dummy.x });
await E(() => window.atlasEditor.gameViewOptions({ mirror: false }));

// Playing for real: the clock loops and the hit fires every cycle.
await E(() => window.atlasEditor.gameViewReplay());
await E(() => window.atlasEditor.gameViewPlay(true));
await page.waitForTimeout(2600);
info = await E(() => window.atlasEditor.gameViewInfo());
check("playing loops the clip and fires hit each cycle", info.playing && info.fired.hit >= 2 && info.drawnFrames > 10, { fired: info.fired, drawn: info.drawnFrames });

// Auto-refresh: key a new pose while paused and the view follows the editor's clip.
await E(() => window.atlasEditor.gameViewPlay(false));
const drawn = (await E(() => window.atlasEditor.gameViewInfo())).drawnFrames;
await E(() => {
  const e = window.atlasEditor;
  e.setTime(12 / 30);
  e.select("upper_arm_near");
  e.rotate("upper_arm_near", 60);
  e.key();
});
await page.waitForTimeout(300);
info = await E(() => window.atlasEditor.gameViewInfo());
check("editing the clip redraws the paused game view", info.drawnFrames > drawn, { drawn, now: info.drawnFrames });
// Walk under: a looping "walk_cycle" clip beside the edited one: the walk drives the legs and body, the edited clip the upper body.
await E(() => window.atlasEditor.gameView(false));
await page.click("#newclip-open");
await page.fill("#newclip-name", "walk_cycle");
await page.click("#newclip-make");
await page.waitForTimeout(200);
if (!(await E(() => window.atlasEditor.state().clip.loop))) await page.click("#loop");
await E(() => {
  const e = window.atlasEditor;
  const pose = (f, vals) => {
    e.setTime(f / 30);
    for (const [bone, v] of Object.entries(vals)) {
      e.select(bone);
      e.rotate(bone, v);
      e.key();
    }
  };
  pose(0, { pelvis: -6, thigh_near: 25, thigh_far: -25 });
  pose(15, { pelvis: 6, thigh_near: -25, thigh_far: 25 });
});
await E(() => window.atlasEditor.switchClip("gameview_chop"));
await E(() => window.atlasEditor.gameView(true));
await E(() => window.atlasEditor.gameViewOptions({ walkUnder: true, dummy: true }));
info = await E(() => window.atlasEditor.gameViewSeek(0.5));
check("walk under plays the walk clip beneath the edited clip", info.walkActive === true && info.walkClip === "walk_cycle" && info.error === "", { walk: info.walkClip, active: info.walkActive, error: info.error });
await shot("gameview-walk-under.png", page.locator("#gameview"));
check("no errors", errors.length === 0 && info.error === "", { errors, error: info.error });
await browser.close();
