// Demo of Arc in-betweens (tween.ts) on the "Turned front (pro)" rig (kit-body-cutout): two key poses (axe raised, axe swung down), the attack preset,
// the motion-path preview, a contact sheet of the generated frames, undo, and Clear generated keys, with checks and screenshots.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-tween.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/tween"));
const { url } = await demoServer(process.argv[3]);
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
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name, clip) => {
  await page.waitForTimeout(450);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};
const frame = async (f) => {
  await E((x) => window.atlasEditor.setTime(x / 30), f);
  await page.waitForTimeout(200);
};
const pose = (f, values) =>
  E(
    ([fr, vals]) => {
      const e = window.atlasEditor;
      e.setTime(fr / 30);
      for (const [bone, v] of Object.entries(vals)) {
        e.select(bone);
        e.rotate(bone, v);
        e.key();
      }
    },
    [f, values]
  );
const clipNow = () => E(() => JSON.stringify(window.atlasEditor.state().clip));
const tipAt = (f) =>
  E(async (x) => {
    const e = window.atlasEditor;
    e.setTime(x / 30);
    await new Promise((r) => setTimeout(r, 80));
    const sk = e.debug().skeleton;
    const b = sk.findBone("weapon_tip");
    return [b.world.x, b.world.y];
  }, f);

// ---- set up: the pro turned rig (near arm holds the axe), a clip with two key poses
await page.evaluate(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForFunction(() => window.atlasEditor.state().outfit === "pro-turned", null, { timeout: 30_000 });
await page.waitForTimeout(500);
await page.click("#newclip-open");
await page.fill("#newclip-name", "tween_demo");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.fit());
await pose(0, { chest: -2, upper_arm_near: -30, forearm_near: -45 });
await pose(12, { chest: 2, upper_arm_near: 25, forearm_near: 0 });
await E(() => window.atlasEditor.setArc("bone:weapon_tip"));
await frame(0);
await E(() => window.atlasEditor.setPlayRange(0, 12));
await page.waitForTimeout(300);

const canvasBox = await page.locator("canvas").first().boundingBox();
const panelBox = () =>
  E(() => {
    window.atlasEditor.reveal("#tweenpanel");
    document.getElementById("tween-apply").scrollIntoView({ block: "end" });
    const r = document.getElementById("tweenpanel").getBoundingClientRect();
    return { x: Math.max(0, r.x - 4), y: 0, width: r.width + 8, height: 1000 };
  });

// Plain rotation blend first (what the engine does with just the two keys): the tip's path and a contact sheet.
const plainTips = [];
for (let f = 0; f <= 12; f++) plainTips.push(await tipAt(f));
await frame(6);
await shot("01-plain-blend-arc-overlay.png", canvasBox);

// ---- the panel: tick the weapon tip, attack spacing, preview
await E(() => window.atlasEditor.reveal("#tweenpanel"));
await E(() => {
  const p = window.atlasEditor.tweenPanel;
  p.set({ effectors: ["weapon-tip"], spacing: "attack", a: 0, b: 12, mode: "every", step: 1 });
});
await E(() => window.atlasEditor.setArc(null));
await frame(6);
const prev = await E(() => {
  const r = window.atlasEditor.tweenPanel.preview();
  return { keys: r.keys, maxError: r.maxError, flagged: r.flagged, notes: r.notes, generated: r.plans[0].generated };
});
check("preview plans 11 in-between frames x 3 bones (+2 pins for hand_near, which had no key at the range ends)", prev.keys === 35 && prev.generated.length === 11, prev);
check("preview makes no change to the clip", (await clipNow()) === (await clipNow()));
await shot("02-preview-motion-path.png", canvasBox);
await shot("03-panel-preview.png", await panelBox());


// ---- a wild arc breaks a rule or leaves reach: Adjust arc tries other biases, Skip leaves the flagged frames out
await E(() => window.atlasEditor.tweenPanel.set({ bias: 1 }));
const wild = await E(() => {
  const r = window.atlasEditor.tweenPanel.preview();
  return { flagged: r.flagged, rules: [...new Set(r.violations.map((v) => v.rule))] };
});
check("a bias of 1 flags frames", wild.flagged.length > 0, wild);
await frame(6);
await shot("03b-wild-arc-flagged.png", canvasBox);
await shot("03c-wild-arc-panel.png", await panelBox());
const fixed = await E(() => {
  const p = window.atlasEditor.tweenPanel;
  const bias = p.adjust();
  const r = p.preview();
  return { bias, flagged: r.flagged };
});
check("Adjust arc finds a bias with fewer flagged frames", fixed.bias !== null && fixed.flagged.length < wild.flagged.length, fixed);
await E(() => window.atlasEditor.tweenPanel.set({ bias: 1 }));
const skipped = await E(() => {
  const p = window.atlasEditor.tweenPanel;
  p.skipFlagged();
  const r = p.preview();
  return { generated: r.plans[0].generated.length, flagged: r.flagged };
});
check("Skip leaves the flagged frames out", skipped.generated < 11 && skipped.flagged.length === 0, skipped);
await E(() => {
  const p = window.atlasEditor.tweenPanel;
  p.set({ skip: [] });
  p.clearAuto?.();
});
// back to the natural arc for the real run
await page.click("#tween-natural");
await page.waitForTimeout(200);
// ---- apply
const plannedPts = await E(() => window.atlasEditor.tweenPanel.preview().plans[0].planned.map((p) => [p.x, p.y]));
const beforeJson = await clipNow();
const res = await E(() => {
  const r = window.atlasEditor.tweenPanel.apply();
  return { keys: r.keys, maxError: r.maxError, flagged: r.flagged, violations: r.violations.map((v) => `${v.frame} ${v.rule}`) };
});
console.log("apply:", JSON.stringify(res));
check("apply baked 35 keys", res.keys === 35);
// Effector-on-spline error on the live skeleton: re-plan from the original clip (the preview now sees the baked keys as waypoints).
const afterJson = await clipNow();
await E(() => window.atlasEditor.setArc("bone:weapon_tip"));
await frame(6);
await shot("04-applied-arc-overlay.png", canvasBox);
const genTips = [];
for (let f = 0; f <= 12; f++) genTips.push(await tipAt(f));
const step = genTips.map((p, i) => (i ? Math.hypot(p[0] - genTips[i - 1][0], p[1] - genTips[i - 1][1]) : 0));
const dev = genTips.map((p, i) => Math.hypot(p[0] - plannedPts[i][0], p[1] - plannedPts[i][1]));
console.log("tip vs planned spline (px):", dev.map((d) => d.toFixed(2)).join(" "));
check("the live weapon tip is within 1 px of the planned arc at every frame", Math.max(...dev) <= 1, dev.map((d) => +d.toFixed(2)));
console.log("tip step per frame (px):", step.map((s) => s.toFixed(0)).join(" "));
check("the attack preset holds first, snaps, then settles", step[1] + step[2] + step[3] < step[6] && step[6] > 100 && step[12] < step[7], step.map(Math.round));
check("undo restores the clip exactly (one step)", await (async () => {
  await E(() => window.atlasEditor.undo());
  return (await clipNow()) === beforeJson;
})());
await E(() => window.atlasEditor.tweenPanel.apply());
check("re-applying after undo gives the same clip as before", (await clipNow()) === afterJson);

// ---- timeline marker and clear
await E(() => window.atlasEditor.setPlayRange(null));
const rowsBox = await page.locator("#timeline, canvas#tl, #tl").first().boundingBox().catch(() => null);
const gen = await E(() => window.atlasEditor.tweenPanel.state());
await page.waitForTimeout(300);
await shot("05-timeline-generated-markers.png", rowsBox ? { x: rowsBox.x, y: Math.max(0, rowsBox.y - 4), width: rowsBox.width, height: rowsBox.height + 8 } : undefined);
const cleared = await E(() => window.atlasEditor.tweenPanel.clearGenerated());
check("Clear generated keys removes exactly the 35 generated keys", cleared === 35 && (await clipNow()) === beforeJson, cleared);
await E(() => window.atlasEditor.undo());
check("undo of the clear brings them back", (await clipNow()) === afterJson);

// ---- contact sheet of the generated frames
await E(() => window.atlasEditor.setArc(null));
await E(() => window.atlasEditor.tweenPanel.set({ showPath: false }));
await E(() => window.atlasEditor.select("chest"));
const shots = [];
const cell = { x: canvasBox.x + canvasBox.width * 0.2, y: canvasBox.y + canvasBox.height * 0.04, width: canvasBox.width * 0.6, height: canvasBox.height * 0.64 };
for (let f = 0; f <= 12; f++) {
  await frame(f);
  await page.waitForTimeout(250);
  shots.push((await page.screenshot({ clip: cell })).toString("base64"));
}
const sheet = await browser.newPage({ viewport: { width: 1800, height: 1300 } });
await sheet.setContent(
  `<body style="margin:0;background:#12151b;color:#cfd6e4;font:14px sans-serif"><div style="display:grid;grid-template-columns:repeat(4,440px);gap:6px;padding:8px">${shots
    .map((b, i) => `<div style="position:relative"><img src="data:image/png;base64,${b}" style="width:440px;display:block"><span style="position:absolute;left:6px;top:4px;font-weight:700;color:${i === 0 || i === 12 ? "#f0b84a" : "#ff5ec8"}">frame ${i}${i === 0 || i === 12 ? " (key)" : ""}</span></div>`)
    .join("")}</div></body>`
);
await sheet.waitForTimeout(500);
await sheet.screenshot({ path: resolve(out, "06-contact-sheet-generated-frames.png"), fullPage: true });
console.log(resolve(out, "06-contact-sheet-generated-frames.png"));

check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
