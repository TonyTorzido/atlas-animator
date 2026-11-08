// Rotating an IK-driven leg bone (thigh / shin) with the rotate ring must move the leg: Animate keys the foot target, Rig (Setup) edits the
// setup pose and moves the target with it. Real mouse, canvas pixels checked mid-drag and after release. Own sandboxed server.
//   node packages/animator-editor/scripts/demo-ik-rotate.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/ik-rotate"));
const { url } = await demoServer();
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
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
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("animate"));
await E(() => window.atlasEditor.setGizmo("rotate"));
await E(() => { const d = window.atlasEditor.debug(); d.world.children.forEach((c) => { if (c !== d.character) c.visible = false; }); });
await E(() => { const st = document.createElement("style"); st.textContent = "#hoverlabel{visibility:hidden !important}"; document.head.append(st); });
await page.click("#gate-toggle").catch(() => {});
let box = await E(() => { const r = document.querySelector("#view canvas").getBoundingClientRect(); return { x: r.x + 220, y: r.y + 60, width: r.width - 440, height: r.height - 200 }; });
const snap = async (key) => {
  await E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const png = await page.screenshot({ clip: box });
  return E(async ([b64, k]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    window.__snaps ??= {};
    const prev = window.__snaps[k];
    window.__snaps[k] = d;
    if (!prev) return 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]) > 30) n++;
    return n;
  }, [png.toString("base64"), key]);
};
const world = (name) => E((n) => { const b = window.atlasEditor.debug().skeleton.findBone(n); return { x: b.world.x, y: b.world.y }; }, name);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const cases = [
  { mode: "animate", bone: "thigh_near", target: "foot_near_target", turn: 0.6 },
  { mode: "animate", bone: "shin_far", target: "foot_far_target", turn: 0.5 },
  { mode: "setup", bone: "thigh_near", target: "foot_near_target", turn: 0.6 },
  { mode: "setup", bone: "shin_far", target: "foot_far_target", turn: 0.5 }
];
for (const k of cases) {
  const tag = `${k.mode} / ${k.bone}`;
  if (k.mode === "setup") {
    await E(() => window.atlasEditor.workspace("rig"));
    await E(() => window.atlasEditor.setupTool("transform"));
  } else await E(() => window.atlasEditor.workspace("animate"));
  await page.waitForTimeout(500);
  await E((b) => window.atlasEditor.select(b), k.bone);
  await page.waitForTimeout(300);
  const ends = await E((b) => window.atlasEditor.boneScreenEnds(b), k.bone);
  const hint = await E(() => document.querySelector("#status")?.textContent ?? "");
  check(`${tag}: selecting shows an IK hint`, /IK/.test(hint), hint.slice(0, 120));
  const c = ends.origin;
  const vp = page.viewportSize();
  const bx = Math.max(0, Math.round(c.x - 320)), by = Math.max(0, Math.round(c.y - 200));
  box = { x: bx, y: by, width: Math.min(640, vp.width - bx), height: Math.min(760, vp.height - by) };
  const a0 = -0.9;
  const r0 = 70;
  const t0 = await world(k.target);
  const bone0 = await world(k.bone);
  const hip0 = await world(k.bone.replace("shin", "thigh"));
  await page.mouse.move(c.x + r0 * Math.cos(a0), c.y + r0 * Math.sin(a0));
  await snap(tag);
  await page.mouse.down();
  const diffs = [];
  for (let s = 1; s <= 8; s++) {
    const a = a0 + (k.turn * s) / 8;
    await page.mouse.move(c.x + r0 * Math.cos(a), c.y + r0 * Math.sin(a));
    if (s % 4 === 0) diffs.push(await snap(tag));
  }
  const mid = await world(k.target);
  const midBone = await world(k.bone);
  const hipFar = await world(k.bone.replace("shin", "thigh"));
  const midShot = await page.screenshot({ path: resolve(out, `${k.mode}-${k.bone}-mid.png`), clip: box });
  check(`${tag}: canvas changes mid-drag`, diffs[0] > 80 && diffs[1] > 80, diffs);
  check(`${tag}: the foot target moved mid-drag`, dist(mid, t0) > 5, { moved: dist(mid, t0) });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const post = await world(k.target);
  const after = await snap(tag);
  check(`${tag}: nothing snaps back on release (canvas)`, after < 60, after);
  check(`${tag}: the foot target stays where it was left`, dist(post, mid) < 1.5, { mid, post });
  if (k.bone.startsWith("thigh")) check(`${tag}: the hip stays put while the leg swings`, dist(midBone, bone0) < 1.5, { hipMoved: dist(midBone, bone0) });
  else check(`${tag}: the hip stays put while the knee bends`, dist(hipFar, hip0) < 1.5, { hipMoved: dist(hipFar, hip0) });
  await page.screenshot({ path: resolve(out, `${k.mode}-${k.bone}-after.png`), clip: box });
  // undo so the next case starts from the same rig / pose
  if (k.mode === "setup") await E(() => window.atlasEditor.setupUndo());
  else await E(() => window.atlasEditor.undo?.());
  await page.waitForTimeout(500);
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
