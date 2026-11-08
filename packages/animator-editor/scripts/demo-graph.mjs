// Demo of the graph editor with checks and a screenshot.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-graph.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/graph"));
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
const frame = (f) => E((x) => window.atlasEditor.setTime(x / 30), f);
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const curveOf = async (bone, ch) => (await E(() => window.atlasEditor.graphState())).curves.find((c) => c.bone === bone && c.channel === ch);

// A short clip: the left arm swings (rotate), the pelvis lunges (move x / y).
await page.click("#newclip-open");
await page.fill("#newclip-name", "demo_graph");
await page.click("#newclip-make");
await page.waitForTimeout(200);
await E(() => window.atlasEditor.select("upper_arm_near"));
for (const [f, deg] of [[0, 0], [8, 70], [16, -20], [24, 40]]) {
  await frame(f);
  await E(([a, b]) => window.atlasEditor.rotate("upper_arm_near", b) ?? a, [f, deg]);
  await E(() => window.atlasEditor.key());
}
await E(() => window.atlasEditor.select("pelvis"));
for (const [f, x, y] of [[0, 0, 0], [12, 30, -40], [24, 0, 0]]) {
  await frame(f);
  await E(([a, b]) => window.atlasEditor.move("pelvis", a, b), [x, y]);
  await E(() => window.atlasEditor.keyMove("pelvis"));
}
await E(() => window.atlasEditor.select("upper_arm_near"));
await frame(8);
await E(() => window.atlasEditor.graphSelect([{ bone: "upper_arm_near", frame: 8 }]));

// Open the graph.
await page.click("#graphbtn");
await page.waitForTimeout(400);
let s = await E(() => window.atlasEditor.graphState());
check("graph opens with the selected bone's curves", s.open && s.curves.some((c) => c.bone === "upper_arm_near" && c.channel === "rotate"), s.curves.map((c) => `${c.bone}.${c.channel}`));

// Bezier handles on the selected key, then a handle drag.
await E(() => window.atlasEditor.graphInterp("bezier"));
await page.waitForTimeout(200);
let rot = await curveOf("upper_arm_near", "rotate");
check("Bezier turns the selected key's segment into handles", Array.isArray(rot.keys[1].curve), rot.keys[1]);
await E(() => window.atlasEditor.graphFrameAll()); // opening with a key selected frames just that key (Batch A)
const h1 = await E(() => window.atlasEditor.graphPoint("upper_arm_near", "rotate", 8, "h1"));
check("a handle is shown for the selected key", !!h1, h1);
await page.mouse.move(h1.x, h1.y);
await page.mouse.down();
await page.mouse.move(h1.x + 40, h1.y - 30, { steps: 6 });
await page.mouse.up();
rot = await curveOf("upper_arm_near", "rotate");
check("dragging the handle changes the curve", JSON.stringify(rot.keys[1].curve) !== JSON.stringify([0.3333, 0.3333, 0.6667, 0.6667]), rot.keys[1].curve);

// A key drag: up and one frame right.
const k = await E(() => window.atlasEditor.graphPoint("upper_arm_near", "rotate", 16));
const before = (await curveOf("upper_arm_near", "rotate")).keys[2];
await page.mouse.move(k.x, k.y);
await page.mouse.down();
await page.mouse.move(k.x + 30, k.y - 50, { steps: 6 });
await page.mouse.up();
const after = (await curveOf("upper_arm_near", "rotate")).keys;
check("dragging a key changes its value", after.length === 4 && after[2].value > before.value + 5, { before, after: after[2] });
check("the key moved in time as well (dopesheet follows)", after[2].frame !== 16, after[2].frame);

// Per-channel curve: ease the pelvis lunge in Y only.
await E(() => window.atlasEditor.select("pelvis"));
await frame(0);
await E(() => window.atlasEditor.graphSelect([{ bone: "pelvis", frame: 0 }]));
await E(() => window.atlasEditor.graphChannels(["translateY"]));
await E(() => window.atlasEditor.graphInterp("stepped"));
const clip = await E(() => window.atlasEditor.state().clip);
check("one channel steps while the other stays linear (per-channel curve object)", JSON.stringify(clip.bones.pelvis.translate[0].curve) === JSON.stringify({ x: "linear", y: "stepped" }), clip.bones.pelvis.translate[0].curve);

// Channel filter and frame all.
await E(() => window.atlasEditor.graphChannels(["rotate", "translateX", "translateY"]));
await E(() => window.atlasEditor.graphSelect([{ bone: "upper_arm_near", frame: 8 }, { bone: "pelvis", frame: 12 }]));
await E(() => window.atlasEditor.graphZoom(0.4));
const zoomed = await E(() => window.atlasEditor.graphView());
const framed = await E(() => window.atlasEditor.graphFrameAll());
check("frame all widens the zoomed window again", framed.t1 - framed.t0 > zoomed.t1 - zoomed.t0, { zoomed, framed });
await E(() => window.atlasEditor.graphChannels(["rotate"]));
s = await E(() => window.atlasEditor.graphState());
check("channel filter hides the other channels", s.curves.every((c) => c.channel === "rotate"), s.channels);
await E(() => window.atlasEditor.graphChannels(["rotate", "translateX", "translateY"]));
await E(() => window.atlasEditor.graphFrameAll());

// Undo restores the pre-drag clip through the shared undo stack.
await frame(8);
await page.waitForTimeout(500);
const file = resolve(out, "graph-editor.png");
await page.screenshot({ path: file });
console.log(file);

console.log(errors.length ? `console errors: ${JSON.stringify(errors)}` : "no console errors");
await browser.close();
process.exitCode = errors.length || failed ? 1 : 0;
