// Demo of Clean up keys (key reduction) and Preview facing right (mirror check) on the "Turned front (pro)" rig.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-reduce.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] || resolve(here, "../../../docs/plans/atlas-animator-demos/editor/reduce"));
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
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const shot = async (name, focus) => {
  if (focus) await page.locator(focus).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};

await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForFunction(() => window.atlasEditor.state().outfit === "pro-turned", null, { timeout: 30_000 });
await page.waitForTimeout(600);
await page.click("#newclip-open");
await page.fill("#newclip-name", "reduce_demo");
await page.click("#newclip-make");
await page.waitForTimeout(200);

// A baked-looking arm swing: a key on every other frame (a sine, so many keys sit on the curve), plus a straight chest lean.
await E(() => {
  const A = window.atlasEditor;
  for (let f = 0; f <= 30; f += 2) {
    A.setTime(f / 30);
    A.select("upper_arm_near");
    A.rotate("upper_arm_near", 35 * Math.sin((f / 30) * Math.PI * 2));
    A.key();
    A.select("chest");
    A.rotate("chest", (f / 30) * 6);
    A.key();
  }
});
await page.waitForTimeout(300);
const full = await E(() => window.atlasEditor.state().clip.bones);
const count = (bones) => Object.values(bones).reduce((n, t) => n + Object.values(t).reduce((m, k) => m + k.length, 0), 0);
const before = count(full);
check("keyed a dense clip", before >= 30, { keys: before });

await E(() => window.atlasEditor.selectBones(["upper_arm_near", "chest"]));
await E(() => window.atlasEditor.reducePanel.render());
await shot("1-before-clean-up.png", "#reduceapply");

const sel = await E(() => window.atlasEditor.reduceKeys({ bones: ["chest"] }));
check("chest (straight lean) loses all inner keys", sel.removed === 14, sel);
const whole = await E(() => window.atlasEditor.reducePanel.state());
console.log("panel", JSON.stringify(whole));

// Tight tolerance keeps the sine; a looser one trims it.
await E(() => window.atlasEditor.reducePanel.setTolerance("rotate", 0.5));
const tight = await E(() => window.atlasEditor.reducePanel.preview().removed);
await E(() => window.atlasEditor.reducePanel.setTolerance("rotate", 2));
const loose = await E(() => window.atlasEditor.reducePanel.preview().removed);
check("a looser rotate tolerance removes more keys", loose >= tight && loose > 14, { tight, loose });
await shot("2-preview-count.png", "#reduceapply");

await page.click("#reduceapply");
await page.waitForTimeout(300);
const afterBones = await E(() => window.atlasEditor.state().clip.bones);
const after = count(afterBones);
check("apply removed the previewed keys", before - after === loose, { before, after, loose });
check("first and last keys stay", afterBones.chest.rotate[0].time === 0 && Math.abs(afterBones.chest.rotate.at(-1).time - 30 / 30) < 1e-6);
await shot("3-after-clean-up.png", "#reduceapply");

await E(() => window.atlasEditor.undo());
await page.waitForTimeout(200);
const undone = count(await E(() => window.atlasEditor.state().clip.bones));
check("undo restores every key", undone === before, { undone });

// Facing right on the same rig.
await E(() => window.atlasEditor.setTime(8 / 30));
await shot("4-facing-left.png");
await page.click("#facingbtn");
await page.waitForTimeout(500);
const facing = await E(() => window.atlasEditor.facing());
check("facing right flips the character root (scale.x -1)", facing.facing === "right" && facing.scaleX === -1, facing);
await shot("5-facing-right-gates.png", ".mirrorhead");
const mirror = await E(() => window.atlasEditor.mirrorCheck());
console.log("mirror findings:", JSON.stringify(mirror.map((i) => i.message)));
check("mirror check lists the weapon-hand assumption", mirror.some((i) => /weapon-hand assumption/.test(i.message)));
check("mirror check is listed in the gates panel", (await page.locator(".mirrorhead").count()) === 1);
await page.click("#facingbtn");
await page.waitForTimeout(300);
check("toggle back restores scale.x 1", (await E(() => window.atlasEditor.facing())).scaleX === 1);

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
