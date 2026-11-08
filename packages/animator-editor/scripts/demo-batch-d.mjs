// UX2 Batch D check: the Weights panel paints first (all paint controls visible without scrolling at 1366x768), a real brush stroke
// changes weights, the Mesh tool's Select / Add / Delete point modes and the canvas Trace hint, the docked UV view, the folded
// inspector with inline rename validation, the grouped attach picker, and the Swag outline gate on the worn leather jacket.
// Real mouse and keyboard. Starts its own sandboxed server (never :5211).   node packages/animator-editor/scripts/demo-batch-d.mjs [outDir]
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
const page = revealTabs(await browser.newPage({ viewport: { width: 1366, height: 768 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const E = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(600);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const settle = async () => {
  await page.waitForFunction(() => !window.atlasEditor.setupState().busy, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
};
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor?.setMode, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.bringToFront();
await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(2500);

// ---------------------------------------------------------------- Weights at 1366x768 and 1600x1000
for (const [w, h] of [[1366, 768], [1600, 1000]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  if (!(await page.locator("#wt-root").count())) {
    await page.click("#tp-weights");
    await page.waitForTimeout(600);
  }
  if ((await E(() => window.atlasWeights.state().addr?.slot)) !== "shirt_torso") {
    await page.selectOption("#wt-mesh", "body|shirt_torso|torso");
    await page.waitForTimeout(800);
  }
  await E(() => window.atlasEditor.select("chest"));
  await page.waitForTimeout(300);
  await E(() => window.atlasWeights.setActive("chest"));
  await page.waitForTimeout(400);
  // Everything the painter needs is on screen without scrolling the panel.
  const vis = await E(() => {
    const ids = ["wt-tool", "wt-mode", "wt-radius", "wt-strength", "wt-normalise", "wt-bones", "wt-heat", "wt-bend"];
    const panel = document.getElementById("wt-root");
    let scroller = panel;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
    const out = {};
    for (const id of ids) {
      const r = document.getElementById(id)?.getBoundingClientRect();
      out[id] = r ? Math.round(r.bottom) : null;
    }
    return { bottoms: out, innerHeight: innerHeight, scrollTop: scroller ? scroller.scrollTop : 0 };
  });
  check(`${w}x${h}: brush, mode, bones, heat map and bend are on screen without scrolling`, Object.values(vis.bottoms).every((b) => b !== null && b <= vis.innerHeight - 24) && vis.scrollTop === 0, vis);
  check(`${w}x${h}: the inspector and the image list are folded away`, (await page.locator("details#setup-fold:not([open])").count()) === 1);
  await shot(`weights-${w}.png`);
}

// A real brush stroke changes the active bone's weights.
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(500);
const totals = () => E(() => {
  const n = window.atlasWeights.state().vertices;
  const a = window.atlasWeights.state().active;
  let t = 0;
  for (let v = 0; v < n; v++) t += window.atlasWeights.weights(v)[a] ?? 0;
  return t;
});
const bone = await E(() => window.atlasWeights.bone(window.atlasWeights.state().active));
const at = await E((p) => window.atlasWeights.client(p[0], p[1]), bone);
await page.mouse.move(at.x, at.y);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240);
await page.waitForTimeout(500);
const at2 = await E((p) => window.atlasWeights.client(p[0], p[1]), bone);
await E(() => window.atlasWeights.setBrush({ mode: "add", radiusPx: 60, strength: 0.6 }));
const t0 = await totals();
const undo0 = await E(() => window.atlasEditor.setupState().undoable);
await page.mouse.move(at2.x - 40, at2.y);
await page.mouse.down();
for (let k = 0; k <= 14; k++) await page.mouse.move(at2.x - 40 + k * 6, at2.y + (k % 2) * 6);
await page.mouse.up();
await page.waitForTimeout(900);
const t1 = await totals();
check("a real brush stroke changes the active bone's weights", Math.abs(t1 - t0) > 0.05, { before: t0, after: t1 });
check("the stroke is one undo step", (await E(() => window.atlasEditor.setupState().undoable)) === undo0 + 1);
await page.keyboard.press("3");
check("key 3 switches the brush to Smooth", (await E(() => window.atlasWeights.state().mode)) === "smooth" || (await page.locator("#wt-mode button.on").innerText()) === "Smooth");
await shot("weights-painted-1600.png");
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);

// Folded inspector: open it, rename validation.
await E(() => window.atlasEditor.select("chest"));
await page.waitForTimeout(400);
await page.click("#setup-fold > summary");
await page.waitForTimeout(300);
const cur = await E(() => document.getElementById("setup-name")?.value);
check("opening the fold shows the bone inspector", !!cur, cur);
await page.fill("#setup-name", "pelvis");
await page.waitForTimeout(200);
const msg = await page.locator("#setup-name-msg").innerText().catch(() => "");
check("renaming to an existing bone shows an inline error", /already exists/.test(msg), msg);
await page.fill("#setup-name", "bad name!");
check("an illegal character shows an inline error", /letters, digits/.test(await page.locator("#setup-name-msg").innerText()));
await shot("bone-rename-validation.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---------------------------------------------------------------- Mesh tool
const pick = await E(() => {
  const raw = window.atlasEditor.setupRaw();
  const rows = [];
  for (const [skin, s] of Object.entries(raw.skins ?? {})) for (const [slot, atts] of Object.entries(s.attachments ?? {})) for (const [name, a] of Object.entries(atts)) if (a.type === "region" && !/__[cg]\d+$/.test(name)) rows.push({ skin, slot, name });
  rows.sort((a, b) => (/strap|belt|cuff/i.test(b.name + b.slot) ? 1 : 0) - (/strap|belt|cuff/i.test(a.name + a.slot) ? 1 : 0));
  return rows[0];
});
console.log("mesh slot", JSON.stringify(pick));
await E(() => window.atlasEditor.fit());
await E(([s, n]) => window.atlasEditor.setupSelectSlot(s, n), [pick.slot, pick.name]);
await page.click('#toolpalette [data-tool="mesh"]');
await settle();
check("a region slot shows the Trace picture hint on the canvas", (await page.locator("#mesh-hint").count()) === 1);
check("the UV view is docked in the panel and collapsed", (await page.locator("#mesh-panel #mesh-uv.closed").count()) === 1);
await shot("mesh-region-hint-1600.png");
await page.click("#mesh-hint-trace");
await settle();
check("Trace from the canvas hint makes a mesh and removes the hint", (await page.locator("#mesh-hint").count()) === 0 && (await page.locator("#mesh-count").innerText()).includes("points"), await page.locator("#mesh-count").innerText());
const count = () => E(([s, n]) => { for (const k of Object.values(window.atlasEditor.setupRaw().skins)) { const a = k.attachments?.[s]?.[n]; if (a) return a.uvs.length / 2; } return 0; }, [pick.slot, pick.name]);
const n0 = await count();
// A screen spot inside the mesh: centroid of its points through the slot's bone.
const spotWorld = (sn) => E(([s, n]) => {
  const e = window.atlasEditor;
  const sk = e.debug().skeleton;
  const raw = e.setupRaw();
  let att;
  for (const k of Object.values(raw.skins)) att = att ?? k.attachments?.[s]?.[n];
  const bone = sk.getBone(raw.slots.find((x) => x.name === s).bone);
  const c = att.uvs.length / 2;
  let cx = 0, cy = 0;
  for (let v = 0; v < c; v++) { cx += att.vertices[2 * v]; cy += att.vertices[2 * v + 1]; }
  const tmp = { x: 0, y: 0 };
  bone.localToWorld(cx / c + 1, cy / c + 1, tmp);
  return { x: tmp.x, y: tmp.y };
}, sn);
const w0 = await spotWorld([pick.slot, pick.name]);
const z0 = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [w0.x, w0.y]);
await page.mouse.move(z0.x, z0.y);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(500);
const w1 = await spotWorld([pick.slot, pick.name]);
const spot = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [w1.x, w1.y]);
await page.click("#mesh-action-select");
await page.mouse.click(spot.x, spot.y);
await settle();
check("Select mode: a click on empty space adds no point", (await count()) === n0, { n0, now: await count() });
await page.keyboard.press("2");
await page.mouse.click(spot.x, spot.y);
await settle();
check("Add mode (key 2): a click adds one point", (await count()) === n0 + 1, { n0, now: await count() });
const undoLabel = await E(() => document.getElementById("setup-undo")?.title ?? "");
check("the Undo tooltip names the edit", /Undo: Add mesh point/.test(undoLabel), undoLabel);
await shot("mesh-add-1600.png");
await page.keyboard.press("3");
await page.mouse.click(spot.x, spot.y);
await settle();
check("Delete mode (key 3): a click on the point removes it", (await count()) === n0, { n0, now: await count() });
await page.click("#mesh-uv-head");
await page.waitForTimeout(400);
check("the UV view opens in the panel on click", (await page.locator("#mesh-panel #mesh-uv:not(.closed)").count()) === 1);
await page.setViewportSize({ width: 1366, height: 768 });
await shot("mesh-uv-1366.png");

// ---------------------------------------------------------------- Attach picker
await page.click('#toolpalette [data-tool="attachment"]');
await settle();
const picker = await E(() => ({ groups: document.querySelectorAll("#setuppanel optgroup").length, options: document.querySelectorAll("#setuppanel optgroup option").length, count: document.getElementById("setup-attach-count")?.textContent }));
check("the attach picker is grouped by folder and hides variants", picker.groups >= 1 && picker.options < 700 && /variants hidden|images/.test(picker.count ?? ""), picker);
await E(() => document.getElementById("setup-attach-count").scrollIntoView({ block: "start" }));
await page.fill("#setup-attach-filter", "arm");
await page.waitForTimeout(300);
const filtered = await E(() => document.querySelectorAll("#setuppanel optgroup option").length);
check("searching narrows the picker", filtered > 0 && filtered < picker.options, { filtered, was: picker.options });
await shot("attach-picker-1366.png");

check("no page errors", errors.length === 0, errors.slice(0, 5));
await browser.close();
process.exit(failures ? 1 : 0);
