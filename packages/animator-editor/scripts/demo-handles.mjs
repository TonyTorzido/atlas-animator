// Demo of the canvas handles and the timeline (zoom / pan / fit, key colours, channel rows, summary row) with screenshots,
// on the "Straight front (pro)" rig. Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-handles.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/handles"));
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
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const shot = async (name, clip) => {
  await page.waitForTimeout(400);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};

check("default rig is the pro rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned", await E(() => window.atlasEditor.state().outfit));

// A 40 frame clip with rotate / translate / scale / shear keys on several bones, a slot swap, a draw order key and an event.
await page.click("#newclip-open");
await page.fill("#newclip-name", "handles_demo");
await page.click("#newclip-make");
await page.waitForTimeout(200);
await page.fill("#duration", String(40 / 30));
await page.press("#duration", "Enter");
await E(() => {
  const e = window.atlasEditor;
  const key = (f, bone, deg) => {
    e.setTime(f / 30);
    e.select(bone);
    e.rotate(bone, deg);
    e.key();
  };
  for (const [f, v] of [[0, 0], [10, -40], [20, -80], [30, -30], [40, 0]]) key(f, "upper_arm_near", v);
  for (const [f, v] of [[0, 0], [14, 25], [28, 5], [40, 0]]) key(f, "upper_arm_far", v);
  for (const [f, v] of [[0, 0], [20, 12], [40, 0]]) key(f, "chest", v);
  // translate / scale / shear keys on other frames, so the colours differ per type
  e.setTime(10 / 30);
  e.select("chest");
  e.move("chest", 6, -4);
  e.keyMove("chest");
  e.setTime(20 / 30);
  e.scale("chest", 1.08, 0.94);
  e.keyScale("chest");
  e.setTime(30 / 30);
  e.select("head");
  e.shear("head", 8, 0);
  e.keyShear("head");
  // events, a draw order key and an attachment swap
  e.addEvent("windup", 6);
  e.addEvent("hit", 22);
  const slots = e.debug().skeleton.slots;
  if (slots.length > 2) {
    e.setTime(25 / 30);
    e.setDrawOrder(slots[1].data.name, 1);
    e.setTime(18 / 30);
    const sl = slots.find((x) => x.data.attachmentName);
    if (sl) e.setAttachment(sl.data.name, sl.data.attachmentName);
  }
});
await E(() => window.atlasEditor.setTime(10 / 30));
await page.waitForTimeout(500);

// 1. Canvas handles at frame 10: key dots on keyed bones, selected bone's ring, hover label.
await E(() => window.atlasEditor.select(null)); // a selected bone's own ring and pick bonus win hover over a bone it covers (Batch E), so hover with nothing selected (atlasEditor.clearSelection only clears the key selection)
const hp = await E(() => window.atlasEditor.boneScreenEnds("forearm_near"));
await page.mouse.move(hp.mid.x, hp.mid.y);
await page.waitForTimeout(300);
const ov = await E(() => window.atlasEditor.overlayState());
check("hover highlights the bone under the cursor", ov.hover === "forearm_near", ov.hover);
check("label shows the bone name", (await page.textContent("#hoverlabel")) === "forearm_near" && (await page.isVisible("#hoverlabel")));
await E(() => window.atlasEditor.select("upper_arm_near"));
check("key dots on bones keyed at this frame", ov.keyDots.some((k) => k.bone === "upper_arm_near" && k.types.includes("rotate")), JSON.stringify(ov.keyDots.map((k) => k.bone + ":" + k.types.join("+"))));
await shot("1-handles-hover-keydots.png");

// 2. Handles keep a constant screen size when zoomed: zoom the view and measure the overlay dot via the pick radius.
const near = async (bone, px) => {
  const p = await E((b) => window.atlasEditor.boneScreenPos(b), bone);
  return E(([x, y]) => window.atlasEditor.hoverAt(x, y), [p.x - (await E(() => document.querySelector("canvas").getBoundingClientRect().left)) + px, p.y - (await E(() => document.querySelector("canvas").getBoundingClientRect().top))]);
};
const zoomsA = [];
for (const z of [0.7, 1.4, 1.4]) {
  await E((f) => window.atlasEditor.zoomAt(f, 700, 500), z);
  zoomsA.push(z);
}
check("pick distance is 14 screen px at any zoom", (await near("hand_near", 8)) === "hand_near" && (await near("hand_near", 60)) !== "hand_near");

// 3. Helpers toggle (off by default) and IK target squares.
check("helpers are hidden by default", (await E(() => window.atlasEditor.overlayState().showHelpers)) === false);
await page.keyboard.press("Escape");
await E(() => window.atlasEditor.setIkLive?.(true));
await E(() => window.atlasEditor.setGizmo("ik"));
await page.waitForTimeout(300);
const ovIk = await E(() => window.atlasEditor.overlayState());
console.log("ik handles:", JSON.stringify(ovIk.ikHandles), "hidden:", JSON.stringify(ovIk.hidden));
await shot("2-ik-and-helpers-off.png");
await E(() => window.atlasEditor.setShowHelpers(true));
await shot("3-helpers-on.png");
await E(() => window.atlasEditor.setShowHelpers(false));
await E(() => window.atlasEditor.setShowBones(false));
const ovOff = await E(() => window.atlasEditor.overlayState());
check("show bones off hides the hover pick", (await E(() => window.atlasEditor.hoverAt(10, 10))) === null && ovOff.showBones === false);
await shot("4-bones-off.png");
await E(() => window.atlasEditor.setShowBones(true));

// 4. Timeline: fit, key colours, summary row, per-channel rows.
await E(() => window.atlasEditor.setGizmo("rotate"));
await E(() => window.atlasEditor.select("chest"));
await E(() => window.atlasEditor.fitTimeline());
const tlBox = await E(() => {
  const r = document.getElementById("tl").getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top) - 40, width: Math.round(r.width), height: Math.round(r.height) + 40 };
});
await shot("5-timeline-fit-collapsed.png", tlBox);
await E(() => window.atlasEditor.expandBone("chest", true));
await E(() => window.atlasEditor.expandBone("upper_arm_near", true));
const rows = await E(() => window.atlasEditor.timelineRows());
check("expanding a bone adds per-channel rows", rows.filter((r) => r.kind === "chan").length >= 2, rows.map((r) => r.kind + ":" + r.name + (r.type ? "/" + r.type : "")).join(" "));
check("summary row is pinned first", rows[0].kind === "all");
await shot("6-timeline-expanded-channels.png", tlBox);

// 5. Zoom with the wheel about the cursor, pan, slider, fit.
const view0 = await E(() => window.atlasEditor.timelineView());
const c = await E(() => {
  const r = document.getElementById("tl").getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + 90 };
});
await page.mouse.move(c.x, c.y);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240);
await page.waitForTimeout(200);
const view1 = await E(() => window.atlasEditor.timelineView());
check("wheel zooms in", view1.span < view0.span && !view1.fit, `${view0.span} -> ${view1.span.toFixed(1)}`);
await shot("7-timeline-zoomed.png", tlBox);
await page.keyboard.down("Shift");
await page.mouse.wheel(0, 300);
await page.keyboard.up("Shift");
await page.waitForTimeout(200);
const view2 = await E(() => window.atlasEditor.timelineView());
check("shift+wheel pans", view2.start > view1.start, `${view1.start.toFixed(1)} -> ${view2.start.toFixed(1)}`);
await page.fill("#tlzoom", "900");
await page.waitForTimeout(150);
const view3 = await E(() => window.atlasEditor.timelineView());
check("zoom slider zooms", view3.span < view2.span, `${view2.span.toFixed(1)} -> ${view3.span.toFixed(1)}`);
await shot("8-timeline-deep-zoom.png", tlBox);
await page.click("#tlfit");
const view4 = await E(() => window.atlasEditor.timelineView());
check("Fit shows the whole clip again", view4.fit && view4.span === view4.frames && view4.start === 0);

// 6. A key click still selects with the zoomed mapping.
await E(() => window.atlasEditor.zoomTimeline(2.5, 20));
const kp = await E(() => window.atlasEditor.keyScreenPos("bone:chest", 20));
await page.mouse.click(kp.x, kp.y);
const t20 = await E(() => Math.round(window.atlasEditor.state().time * 30));
check("clicking a key at zoom jumps to its frame", t20 === 20, String(t20));
await shot("9-timeline-zoomed-key-selected.png");

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
