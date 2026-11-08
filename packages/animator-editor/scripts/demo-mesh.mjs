// Demo of the Setup Mesh tool in a sandbox (scripts/demo-server.mjs; never port 5211):
//   convert a strap-like region to a mesh, trace at two densities, add and delete a point, undo and redo,
//   save the rig, reload and confirm the mesh persisted. Screenshots land in outDir.
//   node packages/animator-editor/scripts/demo-mesh.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/mesh"));
const { url } = await demoServer();
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const E = (fn, arg) => page.evaluate(fn, arg);
let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};
const shot = async (name) => {
  await page.waitForTimeout(700);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};
const settle = async () => {
  await page.waitForFunction(() => !window.atlasEditor.setupState().busy, null, { timeout: 30_000 });
  await page.waitForTimeout(600);
};
const boot = async () => {
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor?.setMode, null, { timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.click('#modeseg button[data-mode="setup"]');
  await settle();
};
await boot();

// Pick the slot: a strap if the rig has one, else any region, else any mesh.
const pick = await E(() => {
  const raw = window.atlasEditor.setupRaw();
  const rows = [];
  for (const [skin, s] of Object.entries(raw.skins ?? {})) for (const [slot, atts] of Object.entries(s.attachments ?? {})) for (const [name, a] of Object.entries(atts)) rows.push({ skin, slot, name, type: a.type });
  const score = (r) => (/strap/i.test(r.name + r.slot) ? 0 : r.type === "region" ? 1 : 2);
  rows.sort((a, b) => score(a) - score(b));
  return { chosen: rows.find((r) => r.type === "region" || r.type === "mesh"), total: rows.length };
});
console.log("slot", JSON.stringify(pick.chosen));
const { slot, name } = pick.chosen;
const info = () =>
  E(
    ([s, n]) => {
      const raw = window.atlasEditor.setupRaw();
      for (const sk of Object.values(raw.skins)) {
        const a = sk.attachments?.[s]?.[n];
        if (a) return { type: a.type, count: a.type === "mesh" ? a.uvs.length / 2 : 0, tris: a.type === "mesh" ? a.triangles.length / 3 : 0 };
      }
      return null;
    },
    [slot, name]
  );

await E(() => window.atlasEditor.fit());
await E(([s, n]) => window.atlasEditor.setupSelectSlot(s, n), [slot, name]);
await page.click('#toolpalette [data-tool="mesh"]');
await settle();
check("Mesh tool panel is shown", (await page.locator("#mesh-panel").count()) === 1);
check("UV view is shown", (await page.locator("#mesh-uv").count()) === 1);
await shot("mesh-1-panel.png");
const start = await info();
console.log("start", JSON.stringify(start));

// 1. Convert to a mesh (Trace picture).
await page.waitForFunction(() => !document.querySelector("#mesh-trace")?.disabled, null, { timeout: 20_000 });
await page.locator("#mesh-density").evaluate((e) => {
  e.value = "40";
  e.dispatchEvent(new Event("input"));
});
await page.click("#mesh-trace");
await settle();
const c1 = await info();
check("Trace converted the image to a mesh", c1?.type === "mesh" && c1.count >= 8, c1);
await shot("mesh-2-traced-40.png");

// 2. Trace at a second density.
await page.locator("#mesh-density").evaluate((e) => {
  e.value = "160";
  e.dispatchEvent(new Event("input"));
});
await page.click("#mesh-trace");
await settle();
const c2 = await info();
check("A higher density gives more points", c2.count > c1.count, { low: c1.count, high: c2.count });
await shot("mesh-3-traced-160.png");
await page.locator("#mesh-density").evaluate((e) => {
  e.value = "50";
  e.dispatchEvent(new Event("input"));
});
await page.click("#mesh-trace");
await settle();
const base = await info();
const undoBefore = await E(() => window.atlasEditor.setupState().undoable);

// 3. Add a point inside the mesh, then delete it.
const spotOf = () => E(
  ([s, n]) => {
    const e = window.atlasEditor;
    const raw = e.setupRaw();
    const sk = e.debug().skeleton;
    let att;
    for (const k of Object.values(raw.skins)) att = att ?? k.attachments?.[s]?.[n];
    const slotRow = raw.slots.find((x) => x.name === s);
    const verts = att.vertices;
    const count = att.uvs.length / 2;
    const pts = [];
    const tmp = { x: 0, y: 0 };
    if (!att.bones) {
      const bone = sk.getBone(slotRow.bone);
      for (let v = 0; v < count; v++) {
        bone.localToWorld(verts[2 * v], verts[2 * v + 1], tmp);
        pts.push({ x: tmp.x, y: tmp.y });
      }
    } else {
      const table = att.bones.map((b) => sk.getBone(b));
      let i = 0;
      for (let v = 0; v < count; v++) {
        const n2 = verts[i++];
        let x = 0;
        let y = 0;
        for (let k = 0; k < n2; k++) {
          table[verts[i]].localToWorld(verts[i + 1], verts[i + 2], tmp);
          x += tmp.x * verts[i + 3];
          y += tmp.y * verts[i + 3];
          i += 4;
        }
        pts.push({ x, y });
      }
    }
    let best = null;
    for (let t = 0; t < att.triangles.length; t += 3) {
      const [a, b, c] = [pts[att.triangles[t]], pts[att.triangles[t + 1]], pts[att.triangles[t + 2]]];
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
      if (!best || area > best.area) best = { area, x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    }
    return best;
  },
  [slot, name]
);
const zoomTo = await spotOf();
const zp = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [zoomTo.x, zoomTo.y]);
await page.mouse.move(zp.x, zp.y);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(500);
const spot = await spotOf();
const at = await E(([x, y]) => window.atlasEditor.setupScreen(x, y), [spot.x, spot.y]);
await page.mouse.click(at.x, at.y);
await settle();
const added = await info();
check("Click added a point", added.count === base.count + 1, { before: base.count, after: added.count });
const sel = await page.locator("#mesh-selected").textContent();
check("The new point is selected", /1 selected/.test(sel ?? ""), sel);
await shot("mesh-4-added.png");
await page.keyboard.press("Delete");
await settle();
const deleted = await info();
check("Delete removed the point", deleted.count === base.count, { count: deleted.count });

// 4. Undo / redo (one step per operation).
const steps = await E(() => window.atlasEditor.setupState().undoable);
check("Each committed op is one undo step", steps === undoBefore + 2, { before: undoBefore, now: steps });
await E(() => window.atlasEditor.setupUndo());
await settle();
const undone = await info();
check("Undo brings the point back", undone.count === base.count + 1, undone);
await E(() => window.atlasEditor.setupUndo());
await settle();
const undone2 = await info();
check("Second undo removes it again", undone2.count === base.count, undone2);
await E(() => window.atlasEditor.setupRedo());
await settle();
const redone = await info();
check("Redo re-adds the point", redone.count === base.count + 1, redone);
await shot("mesh-5-undo-redo.png");

// 5. Select everything (shared with the UV view).
await page.keyboard.press("Control+a");
await page.waitForTimeout(300);
const all = (await page.locator("#mesh-selected").textContent()) ?? "";
check("Ctrl+A selects every point", all === `${redone.count} selected`, all);
await shot("mesh-6-selected.png");

// 6. Save, reload, confirm it persisted.
await E(() => window.atlasEditor.setupSave());
await settle();
const saved = await E(() => window.atlasEditor.setupState().unsaved);
check("Save wrote the edits", saved === 0, { unsaved: saved });
await boot();
const reloaded = await info();
check("The mesh persisted across a reload", reloaded?.type === "mesh" && reloaded.count === redone.count, { saved: redone.count, reloaded });
await E(([s, n]) => window.atlasEditor.setupSelectSlot(s, n), [slot, name]);
await page.click('#toolpalette [data-tool="mesh"]');
await settle();
await shot("mesh-7-reloaded.png");

check("No page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
process.exit(failed ? 1 : 0);
