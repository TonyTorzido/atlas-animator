// Demo of the outline gate overlay (G2), in a sandbox (scripts/demo-server.mjs; never port 5211):
//   wear the leather chest, check the rest pose, tear the chest's outline with a shape key, confirm the red marks appear ~250 ms after the
//   pose stops changing, toggle the overlay off and on, run "Check clip" (red ticks on the timeline, bad-frame list, warning in the clip
//   check) and jump to a bad frame from the list. Screenshots + PASS/FAIL checks.
//   node packages/animator-editor/scripts/demo-gate.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../docs/plans/atlas-animator-demos/editor/gate"));
const { url } = await demoServer(undefined);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }), { workspace: "pro" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor && !!window.atlasShapeKeys && !!window.atlasGate, null, { timeout: 60_000 });
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
const frame = async (n) => {
  await E((t) => window.atlasEditor.setTime(t), n / 30);
};

await page.click("#newclip-open");
await page.fill("#newclip-name", "demo_gate");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(300);

// ---- 1. nothing worn: the panel says what to do
await frame(6);
await page.waitForTimeout(800);
check("no item worn: the panel asks for one", /Wear a swag item/.test(await E(() => window.atlasGate.status())), await E(() => window.atlasGate.status()));
await shot("1-no-item.png");

// ---- 2. wear the leather chest: rest pose
await E(() => window.atlasEditor.setActiveSkin("chest.leather"));
await page.waitForTimeout(300);
const r0 = await E(() => window.atlasGate.recompute());
check("the gate ran on the rest pose (renderer loaded, pieces rendered)", !!r0 && r0.pieces.length >= 1, r0 && { breaks: r0.breaks, pieces: r0.pieces });
await shot("2-leather-rest-pose.png");

// ---- 3. tear the outline: pull the chest bottom-centre vertex up into the figure with the Shape keys tool (real mouse drag)
await E(() => window.atlasEditor.setCanvasTool("shape-keys"));
await page.waitForTimeout(400);
await E(() => window.atlasShapeKeys.setTarget("chest.leather/shirt_torso/torso"));
await E(() => window.atlasShapeKeys.setSoft({ on: false }));
const pos = await E(() => window.atlasShapeKeys.positions());
let left = 0;
// The turned torso's sides and top sit under the sleeves and hair, so notch the bottom edge instead: the bottom-centre vertex.
for (let i = 0; i < pos.length; i += 2) if (pos[i + 1] > pos[left * 2 + 1] + 1 || (Math.abs(pos[i + 1] - pos[left * 2 + 1]) <= 1 && Math.abs(pos[i]) < Math.abs(pos[left * 2]))) left = i / 2;
const at = await E((v) => window.atlasShapeKeys.vertexScreen(v), left);
await page.mouse.click(at.x, at.y);
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x, at.y - 90, { steps: 8 }); // inward: the outline now runs through the fill
await page.mouse.up();
await page.waitForTimeout(300);
check("a shape key tore the chest on frame 6", Object.keys(await E(() => window.atlasShapeKeys.deformKeys())).length > 0);
await E(() => window.atlasEditor.setCanvasTool(null));
await page.waitForTimeout(900); // the gate waits ~250 ms after the pose settles, then renders
const marks = await E(() => window.atlasGate.marks());
const status = await E(() => window.atlasGate.status());
console.log("status:", status);
check("red marks appear over the ink break", marks.length > 0, { marks: marks.length, status });
await shot("3-ink-break-red-marks.png");

// ---- 4. toggle off and on
await page.click("#gate-toggle");
await page.waitForTimeout(500);
check("toggling the overlay off removes the marks", (await E(() => window.atlasGate.marks())).length === 0 && !(await E(() => window.atlasGate.enabled())));
await shot("4-overlay-off.png");
await page.click("#gate-toggle");
await page.waitForTimeout(1200);
check("toggling it on brings them back", (await E(() => window.atlasGate.marks())).length > 0);

// ---- 5. whole clip
await page.click("#gate-check");
await page.waitForFunction(() => window.atlasGate.badFrames() !== null, null, { timeout: 280_000 });
const bad = await E(() => window.atlasGate.badFrames());
check("whole-clip check found the bad frames (a shape key holds before and after its frame)", bad.length > 0 && bad.includes(6) && bad.includes(12), bad);
check("a red button per bad frame (first 18 listed)", (await page.locator("#gate-frames button").count()) === Math.min(18, bad.length));
await frame(0);
await page.waitForTimeout(600);
await shot("5-clip-check-ticks-and-list.png");
await page.locator('#gate-frames button[data-frame="12"]').click();
await page.waitForTimeout(500);
check("clicking a bad frame jumps to it", /Frame 12 \/ 30/.test(await page.locator("body").innerText()));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.checkWholeClip());
await page.waitForTimeout(800);
const gateText = await page.locator("body").innerText();
check("the clip check reports one warning per bad frame (gates.ts)", new RegExp("Clip check: " + bad.length + " finding").test(gateText), gateText.match(/Clip check: \d+ finding/)?.[0]);
await shot("6-clip-check-warning.png");

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
