// Undo / redo regression: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z from real keyboard events after every kind of Animate edit and in Setup, whatever has
// focus (canvas, a button, a dropdown). Root cause it guards: a focused <select> / checkbox / button swallowed the hotkeys, so Ctrl+Z did nothing
// after the clip dropdown (or any control) had focus. Sandboxed server, free port.
//   node packages/animator-editor/scripts/qa-undo.mjs
// If the page reloads mid-run (a source file changed under the dev server) the run aborts: rerun it.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const page = revealTabs(await browser.newPage({ viewport: { width: 1900, height: 1100 } }), { workspace: "pro" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
let navigations = 0;
page.on("framenavigated", () => navigations++);
const E = (fn, arg) => page.evaluate(fn, arg);
const settle = () => E(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
const status = () => E(() => document.querySelector("#status")?.textContent ?? "");

await E(() => window.atlasEditor.mountOutfit("pro-turned"));
await page.waitForTimeout(1200);
await E(() => window.atlasEditor.workspace("pro"));
await settle();
await page.click("#newclip-open");
await page.fill("#newclip-name", "qa_clip");
await page.click("#newclip-make");
await settle();

const screen = (bone) => E((b) => window.atlasEditor.boneScreenPos(b), bone);
const dragMouse = async (a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await settle();
};
const edits = {
  "rotate drag": async () => {
    await E(() => window.atlasEditor.select("upper_arm_near"));
    await E(() => window.atlasEditor.setGizmo("rotate"));
    const p = await screen("upper_arm_near");
    await dragMouse({ x: p.x + 70, y: p.y }, { x: p.x + 50, y: p.y + 60 });
  },
  "move drag": async () => {
    await E(() => window.atlasEditor.select("pelvis"));
    await E(() => window.atlasEditor.setGizmo("move"));
    const p = await screen("pelvis");
    await dragMouse({ x: p.x, y: p.y }, { x: p.x + 40, y: p.y + 20 });
  },
  "key pose (K)": async () => {
    await E(() => window.atlasEditor.select("head"));
    await E(() => window.atlasEditor.rotate("head", 12));
    await E(() => window.atlasEditor.setTime(0.2));
    await E(() => window.atlasEditor.rotate("head", 25));
    await page.keyboard.press("k");
    await settle();
  },
  "key nudge": async () => {
    await E(() => window.atlasEditor.select("chest"));
    await E(() => window.atlasEditor.rotate("chest", 8));
    await E(() => window.atlasEditor.key());
    await E(() => window.atlasEditor.setTime(0));
    await page.keyboard.press(".");
    await settle();
  },
  "IK foot drag": async () => {
    await E(() => window.atlasEditor.setGizmo("move"));
    const p = await screen("foot_near_target").catch(() => null);
    if (p) await dragMouse({ x: p.x, y: p.y }, { x: p.x + 30, y: p.y - 25 });
  }
};
const focusModes = {
  canvas: async () => {
    const r = await E(() => { const b = document.querySelector("#view canvas").getBoundingClientRect(); return { x: b.x + 30, y: b.y + 30 }; });
    await page.mouse.move(r.x, r.y);
  },
  "after a button": async () => {
    await page.click("#autokey");
    await page.click("#autokey");
  },
  "a focused dropdown": async () => {
    await page.focus("#clip");
  },
  "a focused checkbox": async () => {
    await E(() => document.querySelector("#applyall")?.focus());
  }
};

for (const ws of ["animate", "pro"]) {
  await E((w) => window.atlasEditor.workspace(w), ws);
  await settle();
  for (const [editName, edit] of Object.entries(edits)) {
    for (const [focusName, focus] of Object.entries(focusModes)) {
      await E(() => window.atlasEditor.setTime(0));
      await edit();
      await focus();
      const before = await status();
      await page.keyboard.press("Control+z");
      await settle();
      const afterUndo = await status();
      check(`${ws}: Ctrl+Z after ${editName}, ${focusName}`, /^Undid/i.test(afterUndo) && afterUndo !== before, afterUndo);
      await page.keyboard.press("Control+y");
      await settle();
      check(`${ws}: Ctrl+Y redoes (${editName}, ${focusName})`, /^Redid/i.test(await status()), await status());
      await page.keyboard.press("Control+z");
      await settle();
      await page.keyboard.press("Control+Shift+z");
      await settle();
      check(`${ws}: Ctrl+Shift+Z redoes (${editName}, ${focusName})`, /^Redid/i.test(await status()), await status());
    }
  }
}

// Rig / Setup.
await E(() => window.atlasEditor.workspace("rig"));
await settle();
await E(() => window.atlasEditor.setMode("setup"));
await settle();
const rigFocus = {
  canvas: focusModes.canvas,
  "a focused button": () => E(() => document.querySelector("#toolpalette [data-tool=select]")?.focus()),
  "a focused dropdown": () => E(() => [...document.querySelectorAll("select")].find((x) => x.offsetParent)?.focus())
};
const boneCount = () => E(() => window.atlasEditor.setupRaw().bones.length);
for (const [focusName, focus] of Object.entries(rigFocus)) {
  const n0 = await boneCount();
  await E(() => window.atlasEditor.setupAddBone({ parent: "head", from: [0, -600], to: [40, -700] }));
  const added = (await boneCount()) === n0 + 1;
  await focus();
  await page.keyboard.press("Control+z");
  await settle();
  check(`rig: Ctrl+Z undoes a Setup edit (${focusName})`, added && (await boneCount()) === n0);
  await page.keyboard.press("Control+y");
  await settle();
  check(`rig: Ctrl+Y redoes it (${focusName})`, (await boneCount()) === n0 + 1);
  await page.keyboard.press("Control+z");
  await settle();
  await page.keyboard.press("Control+Shift+z");
  await settle();
  check(`rig: Ctrl+Shift+Z redoes it (${focusName})`, (await boneCount()) === n0 + 1);
  await E(() => window.atlasEditor.setupUndo());
}
await E(() => window.atlasEditor.setMode("animate"));
await E(() => window.atlasEditor.workspace("swag"));
await settle();
await E(() => window.atlasEditor.select("head"));
await E(() => window.atlasEditor.rotate("head", 15));
await page.keyboard.press("Control+z");
await settle();
check("swag: Ctrl+Z keeps the editor responsive", await E(() => !!window.atlasEditor.state()));

// : a key moved from a channel row moves that property only, and one Undo puts it back.
await E(() => window.atlasEditor.workspace("pro"));
await settle();
const frameOf = (keys) => (keys ?? []).map((k) => Math.round(k.time * 30));
const prop = await E(() => {
  const e = window.atlasEditor;
  e.setAutoKey(true);
  e.setTime(0.4);
  e.select("forearm_near");
  e.rotate("forearm_near", 30);
  e.key();
  e.move("forearm_near", 5, 3);
  e.key();
  e.expandBone("forearm_near", true);
  e.selectKeys([{ row: "bone:forearm_near#rotate", frame: 12 }]);
  e.moveSelected(4);
  return e.state().clip.bones.forearm_near;
});
check("AN-05: moving the rotate key (channel row) moved rotate only", frameOf(prop.rotate).includes(16) && frameOf(prop.translate).includes(12) && !frameOf(prop.translate).includes(16), prop);
await E(() => window.atlasEditor.undoStep());
const undone = await E(() => window.atlasEditor.state().clip.bones.forearm_near);
check("AN-05: one Undo puts the rotate key back on its frame", frameOf(undone.rotate).includes(12) && !frameOf(undone.rotate).includes(16), undone);
if (navigations > 0) {
  console.log(`ABORT: the page reloaded ${navigations}x during the run (a source file changed under the dev server); rerun`);
  process.exit(3);
}
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
