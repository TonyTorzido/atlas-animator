// Layered animation preview demo + check (Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
// node packages/animator-editor/scripts/tracks-demo.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.evaluate(() => window.atlasEditor.mountOutfit("turned-l"));
await page.waitForTimeout(800);

const rot = (bone) => page.evaluate((b) => window.atlasEditor.debug().skeleton.findBone(b).pose.rotation, bone);

const clipJson = () => page.evaluate(() => JSON.stringify(window.atlasEditor.state().clip));
// Two clips made through the editor's own key path: a leg-and-arm walk cycle (loops) and an overhead chop (one shot).
await page.evaluate(() => {
  const E = window.atlasEditor;
  const make = (name, keys) => {
    document.getElementById("newclip-open").click();
    document.getElementById("newclip-name").value = name;
    document.getElementById("newclip-make").click();
    for (const [frame, pose] of keys) {
      E.setTime(frame / 30);
      for (const [bone, v] of Object.entries(pose)) {
        E.select(bone);
        E.rotate(bone, v);
        E.key();
      }
    }
  };
  make("walk_demo", [
    [0, { thigh_l: 28, shin_l: 5, thigh_r: -28, upper_arm_l: -35, upper_arm_r: 35, pelvis: 2 }],
    [15, { thigh_l: -28, shin_l: 30, thigh_r: 28, upper_arm_l: 35, upper_arm_r: -35, pelvis: -2 }],
    [30, { thigh_l: 28, shin_l: 5, thigh_r: -28, upper_arm_l: -35, upper_arm_r: 35, pelvis: 2 }]
  ]);
  document.getElementById("loop").click();
  make("chop_demo", [
    [0, { upper_arm_r: -20, forearm_r: -10, chest: 0, head: 0 }],
    [9, { upper_arm_r: 95, forearm_r: 55, chest: -12, head: -6 }],
    [18, { upper_arm_r: 10, forearm_r: 10, chest: 14, head: 6 }],
    [24, { upper_arm_r: -20, forearm_r: -10, chest: 0, head: 0 }]
  ]);
  E.switchClip("walk_demo");
  E.tracksOpen(true);
  E.trackSet(0, { clip: "walk_demo", loop: true });
  E.trackSet(1, { clip: "chop_demo", loop: false, mask: "upper", alpha: 1, then: "walk_demo", crossfade: 0.3 });
  E.tracksSeek(0.3);
});
await page.waitForTimeout(500);
const lowerLayered = await rot("thigh_l");
const armLayered = await rot("upper_arm_r");
await page.screenshot({ path: resolve(out, "editor-tracks.png") });
console.log(resolve(out, "editor-tracks.png"));

// Playing advances the combined clock; the edited clip is untouched.
const before = await clipJson();
await page.evaluate(() => window.atlasEditor.tracksPlay(true));
await page.waitForTimeout(600);
const t = await page.evaluate(() => window.atlasEditor.tracksInfo().time);
await page.evaluate(() => window.atlasEditor.tracksOpen(false));
await page.waitForTimeout(300);
const after = await clipJson();
console.log(JSON.stringify({ lowerLayered, armLayered, playedTo: t, clipUnchanged: before === after, errors }));
if (before !== after || !(t > 0.45) || errors.length) process.exitCode = 1;
await browser.close();
