// Demo of live Hand IK on the pro rig: the arm's IK constraint stays on (mix keyed 1) and the hand target bone is keyed,
// so in-betweens move the hand smoothly; bake mode still writes FK rotate keys.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-hand-ik-live.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/hand-ik-live"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const hand = () => E(() => window.atlasEditor.handPos("l"));
const frame = async (f) => {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(300);
};
const drag = async (dx, dy) => {
  const h = await hand();
  await page.mouse.move(h.screen.x, h.screen.y);
  await page.mouse.down();
  await page.mouse.move(h.screen.x + dx / 2, h.screen.y + dy / 2, { steps: 4 });
  await page.mouse.move(h.screen.x + dx, h.screen.y + dy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};
const armLens = () =>
  E(() => {
    const sk = window.atlasEditor.debug().skeleton;
    const d = (a, b) => Math.hypot(sk.findBone(b).world.x - sk.findBone(a).world.x, sk.findBone(b).world.y - sk.findBone(a).world.y);
    return [d("upper_arm_near", "forearm_near"), d("forearm_near", "hand_near")];
  });

check("opens on the turned rig with hand IK constraints", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned" && !!(await E(() => window.atlasEditor.handIk("l"))));
await page.click("#newclip-open");
await page.fill("#newclip-name", "ik_live");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => {
  window.atlasEditor.setGizmo("ik");
  window.atlasEditor.setIkLive(true);
});
await page.check("#ikliveopt").catch(() => {});
check("the Keep IK live option is checked in the panel", await E(() => document.getElementById("ikliveopt").checked));

await frame(0);
const rest = await hand();
await drag(-40, -90);
await page.keyboard.press("k");
await frame(20);
await drag(60, 20);
await page.keyboard.press("k");
const clip = await E(() => window.atlasEditor.state().clip);
const ik = clip.ik?.hand_ik_near ?? [];
check("the arm constraint is keyed on (mix 1) and the target translate is keyed at both frames", ik.some((k) => k.mix === 1) && clip.bones.hand_near_target?.translate?.length >= 2, { ik, keys: clip.bones.hand_near_target?.translate?.length });
check("no FK rotate keys were baked on the arm", !clip.bones.upper_arm_near?.rotate && !clip.bones.forearm_near?.rotate, Object.keys(clip.bones));
await frame(0);
const h0 = await hand();
await frame(10);
const h10 = await hand();
await frame(20);
const h20 = await hand();
const mid = { x: (h0.screen.x + h20.screen.x) / 2, y: (h0.screen.y + h20.screen.y) / 2 };
check("the hand moved between the keys", Math.hypot(h20.screen.x - h0.screen.x, h20.screen.y - h0.screen.y) > 40, { h0: h0.screen, h20: h20.screen });
check("frame 10 is about midway between the two target keys", Math.hypot(h10.screen.x - mid.x, h10.screen.y - mid.y) < 14, { h10: h10.screen, mid });
check("the first key frame sits where the drag put it (hand left of and above its rest)", h0.screen.x < rest.screen.x - 20 && h0.screen.y < rest.screen.y - 40, { rest: rest.screen, h0: h0.screen });
const lens = await armLens();
check("the arm keeps its length while live", lens.every((v) => v > 20), lens);
const stray = await E(() => window.atlasEditor.state().clip.bones.hand_far_target ?? null);
check("the other arm is untouched", stray === null);
await page.screenshot({ path: resolve(out, "live-ik-frame20.png") });

// Bake mode still works: option off, a drag writes FK rotate keys and no IK keys.
await page.click("#newclip-open");
await page.fill("#newclip-name", "ik_bake");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => {
  window.atlasEditor.setGizmo("ik");
  window.atlasEditor.setIkLive(false);
  window.atlasEditor.setTime(6 / 30);
});
await drag(-30, -60);
await page.keyboard.press("k");
const baked = await E(() => window.atlasEditor.state().clip);
check("bake mode writes rotate keys on the arm and no IK keys", baked.bones.upper_arm_near?.rotate?.length >= 1 && !baked.ik?.hand_ik_near, { bones: Object.keys(baked.bones), ik: baked.ik });
await page.click("#undo").catch(() => {});
check("no page errors", errors.length === 0, errors);
await browser.close();
process.exitCode = failed || errors.length ? 1 : 0;
