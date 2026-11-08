// "Live" proof by canvas PIXELS: while the mouse is held and moving, the rendered canvas (screenshots of the composited page, overlay hidden so
// only the character art counts) must differ progressively before mouseup. Gestures: the rotate ring, a press on the axe image itself,
// a press on the weapon bone; slow and fast drags; no clip and a clip; plus Move / Scale / Shear / Hand IK drags.
// Starts its own sandboxed server.   node packages/animator-editor/scripts/demo-rotate-pixels.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/rotate-live"));
const { url } = await demoServer();
mkdirSync(out, { recursive: true });
// GPU=1: a headed browser on the machine's real GPU (what the user has) instead of software GL.
const browser = process.env.GPU === "1" ? await chromium.launch({ headless: false }) : await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 2400, height: 1300 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
await page.bringToFront();
// OUTFIT=pro-turned (the only player view). Nothing worn by default (the tank); WEAR=1 wears the leather chest skin (the Setup ring drag used to jump on release: fixed in UX2 Batch E).
const OUTFIT = process.env.OUTFIT ?? "pro-turned";
await E((o) => window.atlasEditor.mountOutfit(o), OUTFIT);
await page.waitForTimeout(1500);
if (process.env.WEAR) {
  await E(() => [...document.querySelectorAll('#skinpanel .skinrow[data-skin="chest.leather"] button')].find((b) => /Wear/.test(b.textContent))?.click());
  await page.waitForTimeout(800);
}
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);
// Only the character art counts: the gizmo / bone overlay is hidden (it would change with the drag by itself).
await E(() => { const d = window.atlasEditor.debug(); d.world.children.forEach((c) => { if (c !== d.character) c.visible = false; }); });
await E(() => window.atlasEditor.setGizmo("rotate"));
await E(() => {
  window.__ev = [];
  let t = 0;
  window.addEventListener("pointermove", () => { t = performance.now(); }, true);
  window.addEventListener("pointermove", () => { if (document.querySelector("#hoverlabel")?.style.display === "block") window.__ev.push(performance.now() - t); });
  const st = document.createElement("style");
  st.textContent = "#hoverlabel{visibility:hidden !important}";
  document.head.append(st);
});
await page.click("#gate-toggle").catch(() => {});
const box = await E(() => { const r = document.querySelector("#view canvas").getBoundingClientRect(); return { x: r.x + 220, y: r.y + 60, width: r.width - 440, height: r.height - 200 }; });

// Snapshot of the canvas region as RGBA in the page; returns the count of pixels that differ from the previous snapshot of the same tag.
const snap = async (tag) => {
  await E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // let the compositor present the latest render
  const png = await page.screenshot({ clip: box });
  return E(async ([b64, key]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    window.__snaps ??= {};
    const prev = window.__snaps[key];
    window.__snaps[key] = d;
    if (!prev) return 0;
    let n = 0;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]) > 30) { n++; const px = (i / 4) % bmp.width, py = Math.floor(i / 4 / bmp.width); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
    window.__bbox = [x0, y0, x1, y1];
    return n;
  }, [png.toString("base64"), tag]);
};

const weaponAt = () => E(() => { const e = window.atlasEditor.boneScreenEnds("weapon"); return e; });
// Gesture start points for the weapon: ring (70 px from the origin), the bone stick (middle of the bone), the axe art (towards the tip, on the blade).
const starts = {
  ring: (e) => [e.origin.x + 70 * Math.cos(-0.6), e.origin.y + 70 * Math.sin(-0.6), e.origin],
  bone: (e) => [e.mid.x, e.mid.y, e.origin],
  art: (e) => [e.origin.x + (e.tip.x - e.origin.x) * 1.7, e.origin.y + (e.tip.y - e.origin.y) * 1.7, e.origin]
};

const runDrag = async (tag, gesture, steps, shotName) => {
  await E(() => { window.atlasEditor.rotate("weapon", 0); window.atlasEditor.select("weapon"); });
  await page.waitForTimeout(250);
  const e = await weaponAt();
  const [sx, sy, c] = starts[gesture](e);
  const r0 = Math.hypot(sx - c.x, sy - c.y) || 70;
  const a0 = Math.atan2(sy - c.y, sx - c.x);
  await page.mouse.move(sx, sy);
  await snap(tag);
  if (shotName) await page.screenshot({ path: resolve(out, `${shotName}-mid0.png`), clip: box });
  await page.mouse.down();
  const diffs = [];
  const N = 6;
  const t0 = Date.now();
  for (let k = 1; k <= N; k++) {
    // 1.3 rad in all, in `steps` mouse events per sample
    for (let s = 1; s <= steps; s++) {
      const a = a0 + (1.3 * ((k - 1) * steps + s)) / (N * steps);
      await page.mouse.move(c.x + r0 * Math.cos(a), c.y + r0 * Math.sin(a));
    }
    diffs.push(await snap(tag));
    if (shotName) await page.screenshot({ path: resolve(out, `${shotName}-mid${k}.png`), clip: box });
  }
  // Still holding the mouse, still: the canvas must already show the final pose (nothing may arrive later).
  await page.waitForTimeout(400);
  const settle = await snap(tag);
  check(`${tag}: the canvas is already final while the mouse is held still`, settle < 150, settle);
  const active = await E(() => window.atlasEditor.boneSelection().active);
  const ev = await E(() => { const a = window.__ev.splice(0); return a; });
  console.log(`info: ${tag}: handler ms per pointermove: avg ${Math.round(ev.reduce((x, y) => x + y, 0) / Math.max(1, ev.length))}, max ${Math.round(Math.max(0, ...ev))}, n ${ev.length}`);
  console.log(`info: ${tag}: ${Math.round((Date.now() - t0) / (N * steps))} ms per mouse event incl. snapshots`);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const post = await snap(tag);
  console.log("info: post-release diff bbox", await E(() => window.__bbox));
  if (shotName) await page.screenshot({ path: resolve(out, `${shotName}-post.png`), clip: box });
  check(`${tag}: selection is the weapon`, active === "weapon", active);
  check(`${tag}: canvas pixels change at every sample BEFORE mouseup`, diffs.every((d) => d > 150), diffs);
  check(`${tag}: nothing jumps on release`, post < 2500, post);
  return diffs;
};

const modes = async (prefix) => {
  for (const [gesture, steps] of [["ring", 2], ["ring", 12], ["bone", 3], ["art", 3], ["art", 14]]) {
    await runDrag(`${prefix} / rotate ${gesture} ${steps}/sample`, gesture, steps, gesture === "ring" && steps === 12 ? `${prefix.replace(/\W+/g, "-")}-ring` : null);
  }
};

await modes("no clip");
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "pix");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
await E(() => window.atlasEditor.setGizmo("rotate"));
await modes("clip");

// Rig workspace = Setup mode: the transform tool's ring / centre drag edits the rig; the bone must show live and the rig file changes once, on mouse-up.
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(600);
await E(() => window.atlasEditor.setupTool("transform"));
for (const [gesture, steps] of [["ring", 2], ["ring", 12]]) {
  await E(() => window.atlasEditor.select("weapon"));
  await runDrag(`rig (Setup) / rotate ${gesture} ${steps}/sample`, gesture, steps, steps === 12 ? "rig-setup-ring" : null);
  await page.waitForTimeout(500);
}
// Move (the bone's centre dot): same check.
{
  const tag = "rig (Setup) / move weapon (centre dot)";
  await E(() => window.atlasEditor.select("weapon"));
  await page.waitForTimeout(250);
  const e = await weaponAt();
  await page.mouse.move(e.origin.x, e.origin.y);
  await snap(tag);
  await page.mouse.down();
  const diffs = [];
  for (let k = 1; k <= 5; k++) {
    await page.mouse.move(e.origin.x + 14 * k, e.origin.y + 9 * k, { steps: 3 });
    diffs.push(await snap(tag));
  }
  await page.waitForTimeout(300);
  const held = await snap(tag);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const post = await snap(tag);
  check(`${tag}: canvas pixels change during the drag, before mouseup`, diffs.filter((d) => d > 100).length >= 4, diffs);
  check(`${tag}: already final while held still / nothing jumps on release`, held < 150 && post < 2500, { held, post });
  await E(() => window.atlasEditor.setupUndo?.());
}

// Setup image drags (the attachment tool: move by the body, rotate by the green knob, scale by the corner square): the art shows live, the rig commits on release.
{
  await E(() => { window.atlasEditor.setupTool("attachment"); window.atlasEditor.setupSelectSlot("weapon", "double_axe"); });
  await page.waitForTimeout(400);
  const handle = (which) => E((w) => { const h = window.atlasEditor.setupImageHandles(); return window.atlasEditor.setupScreen(h[w].x, h[w].y); }, which);
  for (const [which, path] of [["centre", [[18, 10], [36, 20], [54, 30], [72, 40], [90, 50]]], ["rotate", [[10, 20], [20, 40], [30, 60], [40, 80], [50, 100]]], ["scale", [[10, 8], [20, 16], [30, 24], [40, 32], [50, 40]]]]) {
    const tag = `rig (Setup) / image ${which === "centre" ? "move" : which}`;
    const h0 = await handle(which);
    await page.mouse.move(h0.x, h0.y);
    await snap(tag);
    await page.mouse.down();
    const diffs = [];
    for (const [dx, dy] of path) {
      await page.mouse.move(h0.x + dx, h0.y + dy, { steps: 3 });
      diffs.push(await snap(tag));
    }
    await page.waitForTimeout(300);
    const held = await snap(tag);
    await page.mouse.up();
    await page.waitForTimeout(800);
    const post = await snap(tag);
    check(`${tag}: art changes during the drag, before mouseup`, diffs.filter((d) => d > 100).length >= 4, diffs);
    check(`${tag}: already final while held still / nothing jumps on release`, held < 150 && post < 2500, { held, post });
    await E(() => window.atlasEditor.setupUndo());
    await page.waitForTimeout(600);
  }
  // Bone length: not visible in the art, so read the skeleton's bone length mid-drag.
  await E(() => { window.atlasEditor.setupTool("transform"); window.atlasEditor.select("weapon"); });
  await page.waitForTimeout(300);
  const w = await E(() => { const e = window.atlasEditor.setupBoneWorld("weapon"); return { tip: window.atlasEditor.setupScreen(e.tip.x, e.tip.y), len: window.atlasEditor.debug().skeleton.findBone("weapon").data.length }; });
  await page.mouse.move(w.tip.x, w.tip.y);
  await page.mouse.down();
  await page.mouse.move(w.tip.x - 20, w.tip.y + 40, { steps: 6 });
  await page.waitForTimeout(150);
  const mid = await E(() => window.atlasEditor.debug().skeleton.findBone("weapon").data.length);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const post = await E(() => window.atlasEditor.debug().skeleton.findBone("weapon").data.length);
  check("rig (Setup) / bone length: the skeleton shows the new length mid-drag", Math.abs(mid - w.len) > 5, { was: w.len, mid });
  check("rig (Setup) / bone length: kept after the commit", Math.abs(post - mid) < 0.6, { mid, post });
  await E(() => window.atlasEditor.setupUndo());
  await page.waitForTimeout(600);
}
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);

// Move / Scale / Shear / Hand IK drags on a bone with art, pixel-checked the same way (clip open).
const other = async (tag, mode, bone, from, to) => {
  await E((b) => { window.atlasEditor.setGizmo("rotate"); window.atlasEditor.select(b); }, bone);
  await E((m) => window.atlasEditor.setGizmo(m), mode);
  await page.waitForTimeout(250);
  const e = await E((b) => window.atlasEditor.boneScreenEnds(b), bone);
  const p0 = from(e);
  await page.mouse.move(p0[0], p0[1]);
  await snap(tag);
  await page.mouse.down();
  const diffs = [];
  for (let k = 1; k <= 5; k++) {
    await page.mouse.move(p0[0] + ((to[0] * k) / 5), p0[1] + ((to[1] * k) / 5), { steps: 3 });
    diffs.push(await snap(tag));
  }
  await page.mouse.up();
  check(`${tag}: canvas pixels change during the drag, before mouseup`, diffs.filter((d) => d > 100).length >= 4, diffs);
  await E(() => window.atlasEditor.undo());
};
await other("move weapon (centre)", "move", "weapon", (e) => [e.origin.x, e.origin.y], [60, 40]);
await other("move forearm (centre)", "move", "forearm_near", (e) => [e.origin.x, e.origin.y], [60, 40]);
await other("hand IK near hand", "ik", "hand_near", (e) => [e.origin.x, e.origin.y], [-60, -40]);
await E(() => window.atlasEditor.setGizmo("rotate"));
// Scale and Shear: drag the chest's x handle (squash) in the same way, pixel-checked.
for (const mode of ["scale", "shear"]) {
  await E((m) => { window.atlasEditor.setGizmo(m); window.atlasEditor.select("chest"); }, mode);
  await page.waitForTimeout(250);
  const h = await E(() => window.atlasEditor.handlePos("chest"));
  const hx = h.x;
  const tag = `${mode} chest (x handle)`;
  await page.mouse.move(hx.x, hx.y);
  await snap(tag);
  await page.mouse.down();
  const diffs = [];
  for (let k = 1; k <= 5; k++) {
    const f = mode === "scale" ? 1 - 0.1 * k : 1;
    await page.mouse.move(h.origin.x + (hx.x - h.origin.x) * f + (mode === "shear" ? 14 * k : 0), h.origin.y + (hx.y - h.origin.y) * f + (mode === "shear" ? -6 * k : 0), { steps: 3 });
    diffs.push(await snap(tag));
  }
  await page.mouse.up();
  check(`${tag}: canvas pixels change during the drag, before mouseup`, diffs.filter((d) => d > 100).length >= 4, diffs);
  await E(() => window.atlasEditor.undo());
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
