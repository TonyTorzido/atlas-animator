// UX2 Batch E check: canvas picking, gizmo grab sizes, Alt+click cycling, hover = click, bone view (Shift+B, per workspace), canvas right-click menu.
// Real mouse and keyboard at zoom 0.3, 1 and 3. Starts its own sandboxed server.   node packages/animator-editor/scripts/demo-batch-e.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../the design notes"));
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1800, height: 1100 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const E = (fn, arg) => page.evaluate(fn, arg);
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1500);
await E(() => window.atlasEditor.workspace("pro"));
await page.click("#newclip-open");
await page.fill("#newclip-name", "pick");
await page.click("#newclip-make");
await page.waitForTimeout(400);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(500);
await E(() => window.atlasEditor.setBoneView("full"));

const setZoom = async (z) => {
  await E((target) => { const v = window.atlasEditor.view(); window.atlasEditor.zoomAt(target / v.zoom, 800, 500); }, z);
  await page.waitForTimeout(700);
  const v = await E(() => window.atlasEditor.view());
  return v.zoom;
};
// Brings a bone to the middle of the canvas with a real right-drag (pan), so every press lands on the canvas at any zoom.
// `at` picks which point of the bone goes to the middle: at zoom 3 the head bone is taller than the canvas, so its tip has to be brought in.
const panTo = async (name, at = "mid") => {
  const e = await E((n) => window.atlasEditor.boneScreenEnds(n), name);
  const r = await E(() => { const b = document.querySelector("#view canvas").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(r.x + (r.x - e[at].x), r.y + (r.y - e[at].y), { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(150);
};
const ends = (name) => E((n) => window.atlasEditor.boneScreenEnds(n), name);
const sel = () => E(() => window.atlasEditor.boneSelection());
const hover = () => E(() => window.atlasEditor.overlayState().hover);
const clear = async () => { await E(() => window.atlasEditor.clearSelection()); await E(() => window.atlasEditor.setGizmo("rotate")); };

for (const z of [0.3, 1, 3]) {
  const got = await setZoom(z);
  check(`zoom ${z}: view is at ${z}`, Math.abs(got - z) < 0.02, got);
  await clear();
  await panTo("head", "tip");
  // 1. A press 13 px beyond a bone's tip picks it (the tip used to miss), and hover names the same bone a click takes.
  const e = await ends("head");
  const dx = e.tip.x - e.origin.x, dy = e.tip.y - e.origin.y, len = Math.hypot(dx, dy) || 1;
  const spot = { x: e.tip.x + (dx / len) * 5, y: e.tip.y + (dy / len) * 5 };
  await page.mouse.move(spot.x, spot.y);
  await page.waitForTimeout(150);
  const h = await hover();
  check(`zoom ${z}: hovering just past the head's tip names head, not hair_1`, h === "head", h);
  await page.mouse.click(spot.x, spot.y);
  const s1 = await sel();
  check(`zoom ${z}: clicking there selects what hover named`, s1.active === h, s1.active);
  // 2. Alt+click cycles the stack.
  await clear();
  await page.keyboard.down("Alt");
  await page.mouse.click(e.tip.x, e.tip.y);
  const a1 = (await sel()).active;
  await page.mouse.click(e.tip.x, e.tip.y);
  const a2 = (await sel()).active;
  await page.keyboard.up("Alt");
  check(`zoom ${z}: Alt+click cycles to a different bone under the pointer`, !!a1 && !!a2 && a1 !== a2, [a1, a2]);
  // 3. A short bone's body, 12 px to the side, is still grabbed.
  await clear();
  await panTo("upper_arm_near");
  const f = await ends("upper_arm_near");
  const mx = f.mid.x, my = f.mid.y;
  const ux = f.tip.x - f.origin.x, uy = f.tip.y - f.origin.y, fl = Math.hypot(ux, uy) || 1;
  const side = { x: mx - (uy / fl) * 12, y: my + (ux / fl) * 12 };
  await page.mouse.move(side.x, side.y);
  await page.waitForTimeout(120);
  const hs = await hover();
  check(`zoom ${z}: 12 px beside an arm bone still hovers a bone`, !!hs, hs);
  // 4. Scale handle grabbed 14 px off its centre.
  await E(() => window.atlasEditor.select("upper_arm_near"));
  await E(() => window.atlasEditor.setGizmo("scale"));
  await page.waitForTimeout(150);
  const hp = await E(() => window.atlasEditor.handlePos("upper_arm_near"));
  const before = await E(() => window.atlasEditor.scaleOf("upper_arm_near"));
  const gx = hp.x.x - hp.origin.x, gy = hp.x.y - hp.origin.y, gl = Math.hypot(gx, gy) || 1;
  const off = { x: hp.x.x + (-gy / gl) * 14, y: hp.x.y + (gx / gl) * 14 };
  await page.mouse.move(off.x, off.y);
  await page.mouse.down();
  await page.mouse.move(off.x + (gx / gl) * 14, off.y + (gy / gl) * 14, { steps: 6 });
  await page.mouse.move(off.x + (gx / gl) * 34, off.y + (gy / gl) * 34, { steps: 6 });
  await page.mouse.up();
  const after = await E(() => window.atlasEditor.scaleOf("upper_arm_near"));
  check(`zoom ${z}: the scale handle grabs 14 px off its centre`, Math.abs(after.x - before.x) > 0.02, { before, after });
  await E(() => window.atlasEditor.undo());
  // 5. Hand IK ring: 23 px off the hand's centre still grabs it.
  await clear();
  await panTo("hand_near");
  await E(() => window.atlasEditor.setGizmo("ik"));
  const hd = await ends("hand_near");
  await page.mouse.move(hd.origin.x + 23, hd.origin.y);
  await page.waitForTimeout(120);
  const hi = await hover();
  check(`zoom ${z}: hand IK ring is grabbed 23 px from its centre`, hi === "hand_near", hi);
  await E(() => window.atlasEditor.setGizmo("rotate"));
}

// Screenshots at zoom 1: hover tip, chain / dim views.
await setZoom(1);
await clear();
await E(() => window.atlasEditor.fitSmooth());
await page.waitForTimeout(900);
await E(() => window.atlasEditor.select("upper_arm_near"));
await E(() => window.atlasEditor.setBoneView("full"));
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(out, "01-bones-full.png") });
await E(() => window.atlasEditor.setBoneView("dim"));
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(out, "02-bones-dim.png") });
await E(() => window.atlasEditor.setBoneView("chain"));
await page.waitForTimeout(200);
await page.screenshot({ path: resolve(out, "03-bones-chain.png") });
await E(() => window.atlasEditor.setBoneView("full"));

// Bone view hotkey, remembered per workspace, Swag starts dimmed.
await page.mouse.move(900, 900);
await page.keyboard.press("Shift+B");
let v = await E(() => window.atlasEditor.boneView());
check("Shift+B: all bones -> dimmed", v === "dim", v);
await page.keyboard.press("Shift+B");
await page.keyboard.press("Shift+B");
v = await E(() => window.atlasEditor.boneView());
check("Shift+B x3: hidden", v === "off", v);
await page.keyboard.press("Shift+B");
v = await E(() => window.atlasEditor.boneView());
check("Shift+B x4: back to all bones", v === "full", v);
await page.keyboard.press("Shift+B");
await E(() => window.atlasEditor.workspace("rig"));
await page.waitForTimeout(400);
v = await E(() => window.atlasEditor.boneView());
check("Rig workspace keeps its own choice (all bones)", v === "full", v);
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
v = await E(() => window.atlasEditor.boneView());
check("Animate remembers dimmed after the round trip", v === "dim", v);
await E(() => window.atlasEditor.workspace("swag"));
await page.waitForTimeout(600);
v = await E(() => window.atlasEditor.boneView());
check("Swag defaults to dimmed", v === "dim", v);
await page.screenshot({ path: resolve(out, "04-swag-dim.png") });
await E(() => window.atlasEditor.workspace("animate"));
await page.waitForTimeout(400);
await E(() => window.atlasEditor.setBoneView("full"));

// Canvas context menu with real right-clicks.
await clear();
await E(() => window.atlasEditor.fitSmooth());
await page.waitForTimeout(900);
const arm = await ends("upper_arm_near");
await page.mouse.click(arm.mid.x, arm.mid.y, { button: "right" });
await page.waitForTimeout(200);
let labels = await E(() => [...document.querySelectorAll(".ctxmenu .ctx-item")].map((b) => b.textContent.trim()));
check("right-click on a bone opens the bone menu", labels.some((l) => /^Key/.test(l)) && labels.some((l) => /Reset pose/.test(l)) && labels.some((l) => /Select children/.test(l)) && labels.some((l) => /Mirror/.test(l)) && labels.some((l) => /Copy pose/.test(l)) && labels.some((l) => /Hide bone/.test(l)), labels);
check("the right-clicked bone is selected", (await sel()).active === "upper_arm_near", (await sel()).active);
await page.screenshot({ path: resolve(out, "05-bone-menu.png") });
await page.click(".ctxmenu .ctx-item:has-text('Select children')");
const kids = await sel();
check("Select children selects the bone and what hangs off it", kids.names.length > 1 && kids.names.includes("upper_arm_near"), kids.names);
const cv = await E(() => { const b = document.querySelector("#view canvas").getBoundingClientRect(); return { x: b.x + 80, y: b.y + b.height * 0.3 }; });
await page.mouse.click(cv.x, cv.y, { button: "right" });
await page.waitForTimeout(200);
labels = await E(() => [...document.querySelectorAll(".ctxmenu .ctx-item")].map((b) => b.textContent.trim()));
check("right-click on empty space opens the view menu", labels.some((l) => /Fit view/.test(l)) && labels.some((l) => /bones/i.test(l)) && labels.some((l) => /Onion/.test(l)), labels);
await page.screenshot({ path: resolve(out, "06-view-menu.png") });
await page.keyboard.press("Escape");
// Right-drag still pans and opens nothing.
const v0 = await E(() => window.atlasEditor.view());
await page.mouse.move(cv.x, cv.y);
await page.mouse.down({ button: "right" });
await page.mouse.move(cv.x + 60, cv.y + 40, { steps: 5 });
await page.mouse.up({ button: "right" });
const v1 = await E(() => window.atlasEditor.view());
const open = await E(() => !!document.querySelector(".ctxmenu"));
check("a right-drag pans and opens no menu", Math.abs(v1.x - v0.x) > 30 && !open, { moved: v1.x - v0.x, open });

check("no page errors", errors.length === 0, errors);
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
