// Demo of the phone dock with screenshots and a frame-time comparison.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-dock.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/dock"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const page = revealTabs(await browser.newPage({ viewport: { width: 1600, height: 900 } }), { workspace: "animate" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor && !!window.atlasDock, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name, clip) => {
  await page.waitForTimeout(400);
  const file = resolve(out, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
};
// A cheap hash of one dock canvas, and the pixel count that differs between two reads.
const grab = (id) => E((i) => {
  const c = document.getElementById(i);
  return Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data);
}, id);
const diff = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0) / 4;
const dockBox = () => E(() => { const r = document.getElementById("dock").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });

const dpr = await E(() => window.devicePixelRatio || 1);
check("opens in Animate with the dock on its rail (windows under 2200 px keep the canvas big)", (await E(() => window.atlasDock.info().mode)) === "rail");
await page.click("#dock-open");
await page.waitForTimeout(400);
check("one click on the rail opens the dock", (await E(() => window.atlasDock.info().mode)) === "open");
let info = await E(() => window.atlasDock.info());
check("one phone canvas, backing pixels = CSS px x device pixel ratio (no scaling blur)", info.canvas.px[0] === Math.round(info.canvas.css[0] * dpr) && info.canvas.px[1] === Math.round(info.canvas.css[1] * dpr), info.canvas);
check("one phone only, 0.471 by default", (await page.locator("#dock canvas").count()) === 1 && info.zoom === 0.471, { zoom: info.zoom });
check("the whole figure always fits: label is true size or fit N%", /^(true size|fit \d+%)$/.test(info.label), { label: info.label, fit: info.fit });
const box = await dockBox();
check("dock is 300 to 504 px wide (as wide as the figure and its weapon need)", box.width >= 270 && box.width <= 504, box); // under 1800 px the dock stacks above the side panel (its width), else its own 320-504 px column
check("dock controls are visible", (await page.locator("#dock-silhouette").isVisible()) && (await page.locator("#dock-mirror").isVisible()) && (await page.locator("#dock-collapse").isVisible()));

// A clip with motion and a hit, like a chop: arm up at frame 8, down at frame 12 (hit), back at 28.
// Animate hides the New clip controls (clips come from the board): make the scratch clip from Pro, then come back.
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "dock_chop");
await page.click("#newclip-make");
await page.waitForTimeout(300);
await E(() => window.atlasEditor.workspace("animate"));
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
  pose(0, { upper_arm_near: 0, forearm_near: 0, chest: 0 });
  pose(8, { upper_arm_near: -70, forearm_near: -30, chest: 8 });
  pose(12, { upper_arm_near: 60, forearm_near: 10, chest: -10 });
  pose(28, { upper_arm_near: 0, forearm_near: 0, chest: 0 });
  e.addEvent("hit", 12);
});
if (!(await E(() => document.getElementById("loop").classList.contains("on")))) await page.click("#loop");
check("the clip loops", await E(() => document.getElementById("loop").classList.contains("on")));
await page.waitForTimeout(300);

// Scrubbing: the dock follows the frame.
await E(() => window.atlasEditor.setTime(0));
await page.waitForTimeout(300);
const a = await grab("dock-canvas");
await E(() => window.atlasEditor.setTime(0.4));
await page.waitForTimeout(300);
const b = await grab("dock-canvas");
const f2 = await E(() => window.atlasDock.info().frame);
check("scrubbing changes the dock pixels", diff(a, b) > 200, { changedPx: diff(a, b), frame: f2 });
check("dock frame follows the scrub (0.4 s = frame 12)", f2 === 12, f2);
let green = 0;
for (let i = 0; i < b.length; i += 4) if (Math.abs(b[i] - 0x5d) < 3 && Math.abs(b[i + 1] - 0x8c) < 3 && Math.abs(b[i + 2] - 0x3a) < 3) green++;
check("the dock draws on the project's green ground", green > 1000, green);
await shot("dock-animate.png");
await shot("dock-column.png", { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 700) });

// Zoom toggle: 0.4 draws the figure smaller (a different frame), 0.471 is the default.
const z471 = await grab("dock-canvas");
await page.click("#dock-z400");
await page.waitForTimeout(300);
info = await E(() => window.atlasDock.info());
const z400 = await grab("dock-canvas");
check("zoom toggle switches to 0.4 (when the figure is scaled to fit, both zooms draw at the same fitted size)", info.zoom === 0.4 && /^Shown at (true size|\d+% of true size)$/.test(await E(() => document.getElementById("dock-scale").textContent)) && (await E(() => document.getElementById("dock-scale").title)).includes("0.4"), { zoom: info.zoom, label: info.label, caption: await E(() => document.getElementById("dock-scale").textContent), changedPx: diff(z471, z400) });
await shot("dock-zoom-0.4.png");
await page.click("#dock-z471");
await page.waitForTimeout(200);

// Mirror toggle.
const facingMain = await E(() => window.atlasEditor.facing().facing);
const before = await grab("dock-canvas");
await page.click("#dock-mirror");
await page.waitForTimeout(300);
const after = await grab("dock-canvas");
info = await E(() => window.atlasDock.info());
check("mirror toggle shows the right side in the dock", info.mirror && info.facing === "right" && diff(before, after) > 200, { facing: info.facing, changedPx: diff(before, after) });
check("the main view keeps its facing", (await E(() => window.atlasEditor.facing().facing)) === facingMain);
await shot("dock-mirror.png");
await page.click("#dock-mirror");

// Silhouette toggle.
await page.click("#dock-silhouette");
await page.waitForTimeout(300);
const sil = await grab("dock-canvas");
let dark = 0;
let light = 0;
for (let i = 0; i < sil.length; i += 4) {
  if (sil[i] < 20 && sil[i + 1] < 20 && sil[i + 2] < 20) dark++;
  else if (sil[i] > 200 && sil[i + 1] > 200) light++;
}
check("silhouette is flat black on a light ground", dark > 500 && light > 200, { dark, light });
await shot("dock-silhouette.png");
await page.click("#dock-silhouette");

// Playing: the dock keeps moving, then stops.
await E(() => window.atlasEditor.setTime(0));
await page.click("#play");
await page.waitForTimeout(250);
const r0 = await E(() => window.atlasDock.info().renders);
await page.waitForTimeout(1200);
const r1 = await E(() => window.atlasDock.info().renders);
check("while playing the dock redraws on its own", r1 - r0 >= 5, { renders: r1 - r0 });
let sawHold = false;
for (let i = 0; i < 80 && !sawHold; i++) {
  sawHold = await E(() => window.atlasDock.info().held);
  await page.waitForTimeout(25);
}
check("a hit event holds the dock (hit-stop)", sawHold);
await shot("dock-playing.png");

// Cost with the dock open and collapsed, main canvas playing a looping clip. Headless frames are vsync-bound (16.7 ms either way), so
// the comparison is the page's main-thread busy time per frame (CDP Performance metrics) plus the frame gaps with the CPU slowed 6x.
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const frameGaps = () => E(() => new Promise((resolveP) => {
  const gaps = [];
  let last = performance.now();
  const end = last + 4000;
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else {
      gaps.shift();
      gaps.sort((x, y) => x - y);
      const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
      resolveP({ frames: gaps.length, meanMs: +mean.toFixed(2), p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}));
const measure = async () => {
  const m0 = await metric();
  const gaps = await frameGaps();
  const m1 = await metric();
  const busyMs = (m1.TaskDuration - m0.TaskDuration) * 1000;
  return { ...gaps, busyMsPerFrame: +(busyMs / gaps.frames).toFixed(2) };
};
const open = await measure();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
const openSlow = await frameGaps();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await page.click("#dock-collapse");
await page.waitForTimeout(500);
const rail = await E(() => window.atlasDock.info().mode);
const closed = await measure();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
const closedSlow = await frameGaps();
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
console.log("FRAMETIME dock open  ", JSON.stringify(open), "CPUx6 gaps", JSON.stringify(openSlow));
console.log("FRAMETIME dock closed", JSON.stringify(closed), "CPUx6 gaps", JSON.stringify(closedSlow));
check("collapse leaves a rail", rail === "rail" && ((await dockBox()).width < 60 || (await dockBox()).height < 40), rail);
await shot("dock-collapsed.png");
await page.click("#play");

// The cost of one dock redraw.
await page.click("#dock-open");
await page.waitForTimeout(400);
const cost = await E(() => {
  const n = 60;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) window.atlasDock.render();
  return +((performance.now() - t0) / n).toFixed(2);
});
console.log("FRAMETIME one dock redraw (both phones, ms)", cost, JSON.stringify(await E(() => { const i = window.atlasDock.info(); return { poseMs: +i.poseMs.toFixed(2), drawMs: +i.drawMs.toFixed(2) }; })));
check("dock reopens", (await E(() => window.atlasDock.info().mode)) === "open");

// Workspaces: Swag open, Rig / Ship hidden, Pro a rail you can open.
for (const [id, mode] of [["swag", "rail"], ["rig", "hidden"], ["ship", "hidden"], ["pro", "rail"]]) {
  await E((w) => window.atlasEditor.workspace(w), id);
  await page.waitForTimeout(300);
  check(`${id}: dock is ${mode}`, (await E(() => window.atlasDock.info().mode)) === mode, await E(() => window.atlasDock.info().mode));
}
await shot("dock-pro-rail.png");
await page.click("#dock-open");
await page.waitForTimeout(300);
check("pro: the rail opens the dock", (await E(() => window.atlasDock.info().mode)) === "open");
await shot("dock-pro-open.png");
await E(() => window.atlasEditor.workspace("animate"));
await E(() => window.atlasEditor.setTime(0.3));
await shot("dock-animate-full.png");

check("no page errors", errors.length === 0, errors.slice(0, 3));
await page.close();

// Screenshots and fit labels at 1600x900 and 1920x1080 (a fresh page each, Animate with a motion clip).
for (const [w, h] of [[1600, 900], [1920, 1080]]) {
  const pg = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }), { workspace: "animate" });
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(url);
  await pg.waitForFunction(() => !!window.atlasEditor && !!window.atlasDock, null, { timeout: 60_000 });
  await pg.waitForTimeout(1500);
  if ((await pg.evaluate(() => window.atlasDock.info().mode)) === "rail") await pg.click("#dock-open");
  await pg.evaluate(() => window.atlasEditor.setTime(0.4));
  await pg.waitForTimeout(500);
  for (const z of [0.471, 0.4]) {
    await pg.evaluate((zz) => window.atlasDock.setZoom(zz), z);
    await pg.waitForTimeout(400);
    const i = await pg.evaluate(() => window.atlasDock.info());
    console.log(`${w}x${h} zoom ${z}: ${i.label} (fit ${i.fit.toFixed(3)}) canvas ${i.canvas.css.join("x")} dock ${await pg.evaluate(() => document.getElementById("dock").getBoundingClientRect().width)}px`);
    check(`${w}x${h} ${z}: whole figure shown (${i.label})`, i.fit > 0.3 && /^(true size|fit \d+%)$/.test(i.label));
    const file = resolve(out, `dock-${w}x${h}-z${Math.round(z * 1000)}.png`);
    await pg.screenshot({ path: file });
    console.log(file);
    if (z === 0.471) {
      const box = await pg.evaluate(() => { const r = document.getElementById("dock").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      await pg.screenshot({ path: resolve(out, `dock-${w}x${h}-column.png`), clip: box });
    }
  }
  check(`${w}x${h}: no page errors`, errs.length === 0, errs.slice(0, 3));
  await pg.close();
}
await browser.close();
if (failed) process.exitCode = 1;
