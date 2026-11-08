// Review screenshots of the editor (Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
// node packages/animator-editor/scripts/screenshots.mjs [outDir] [url]
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
await page.waitForTimeout(800);
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, name) });
  console.log(resolve(out, name));
};

// 1. Main screen: jacket rig, walk_in_place at frame 8, upper_arm_l selected.
await page.evaluate(() => {
  const E = window.atlasEditor;
  E.setTime(8 / 30);
  E.select("upper_arm_l");
});
await shot("editor-main.png");

// 2. A posed character on a new clip: keys set through the gizmo path (rotate + key), one bone held at its limit.
await page.evaluate(() => {
  const E = window.atlasEditor;
  document.getElementById("newclip-open").click();
  document.getElementById("newclip-name").value = "wave_demo";
  document.getElementById("newclip-make").click();
  const pose = { upper_arm_l: 95, forearm_l: 45, hand_l: -15, upper_arm_r: -20, forearm_r: -15, head: 8, neck: 4, chest: -3 };
  for (const [frame, k] of [[0, 0], [15, 1], [30, 0]]) {
    E.setTime(frame / 30);
    for (const [bone, v] of Object.entries(pose)) {
      E.select(bone);
      E.rotate(bone, k ? v : v * 0.3);
      E.key();
    }
  }
  E.setTime(15 / 30);
  E.select("forearm_l");
  E.rotate("forearm_l", 95); // past the 0..70 range: clamped, limit flashed, unkeyed
});
await shot("editor-posed-limit.png");

// 3. Timeline + gates after a whole-clip check, bare outfit, grey background.
await page.evaluate(async () => {
  const E = window.atlasEditor;
  await E.mountOutfit("bare");
  E.setTime(15 / 30);
  E.select("upper_arm_l");
  document.querySelectorAll("#bgs button")[1].click();
  E.checkWholeClip();
});
await page.waitForTimeout(2500);
await shot("editor-timeline-gates.png");
await page.screenshot({ path: resolve(out, "editor-timeline-crop.png"), clip: { x: 0, y: 1000 - 236, width: 1680 - 340, height: 236 } });
console.log(resolve(out, "editor-timeline-crop.png"));

// 4. Outfits side by side are one click each: leather on the light background.
await page.evaluate(async () => {
  const E = window.atlasEditor;
  await E.mountOutfit("leather");
  document.querySelectorAll("#bgs button")[2].click();
});
await shot("editor-leather-light.png");

if (errors.length) console.log("page errors:\n" + errors.join("\n"));
await browser.close();
