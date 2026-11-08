// Screenshots for hidden-features batch 3 (Rig: bone fields, slots manager, draw order, constraints, revert, tree drag, view HUD) in a sandboxed server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";
const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(here, "../../../ux2-shots/hidden-3");
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [w, h] of [[1600, 1000], [1366, 768]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const e = window.atlasEditor; e.workspace("rig"); });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const e = window.atlasEditor; e.showTab("rig"); e.select("chest"); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, `rig-${w}.png`) });
  const panel = page.locator("#setuppanel");
  await page.click("#setup-newslot");
  await page.waitForTimeout(500);
  await page.click("#setup-addik1");
  await page.waitForTimeout(500);
  await page.click("#setup-addtc");
  await page.waitForTimeout(500);
  for (const [name, sel] of [["bone-fields", "#setup-scalex"], ["slots", "#setup-newslot"], ["draw-order", "#setup-draworder"], ["constraints", "#setup-addcon"], ["revert", "#setup-revert"]]) {
    await page.locator(sel).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: resolve(out, `rig-${w}-${name}.png`) });
  }
  // tree drag indicator mid-drag
  const pick = await page.evaluate(() => {
    const r = window.atlasEditor.setupRaw();
    const present = new Set([...document.querySelectorAll("#outliner .ol-row.k-bone")].map((e) => e.dataset.id.slice(2)));
    const kids = new Set(r.bones.map((b) => b.parent));
    const leaf = r.bones.find((b) => b.parent && !kids.has(b.name) && present.has(b.name));
    const to = r.bones.find((b) => present.has(b.name) && b.name !== leaf?.parent && b.name !== leaf?.name && b.name !== "root");
    return { bone: leaf.name, to: to.name };
  });
  const a = await page.locator(`#outliner .ol-row[data-id="b:${pick.bone}"]`).boundingBox();
  const b = await page.locator(`#outliner .ol-row[data-id="b:${pick.to}"]`).boundingBox();
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + a.height / 2 + 6, { steps: 3 });
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 8 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `rig-${w}-tree-drop.png`) });
  await page.mouse.up();
  await page.waitForTimeout(500);
  // overlap check: nothing in the view toolbars overlaps
  const overlaps = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#vhud, #setuphud, #vtop .hud.tr, #pathstack, #vmid")].filter((e) => e.offsetParent && e.getBoundingClientRect().width > 0).map((e) => [e.id || e.className, e.getBoundingClientRect()]);
    const hit = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [na, a] = boxes[i], [nb, b] = boxes[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hit.push(`${na} x ${nb}`);
    }
    return hit;
  });
  console.log(w, "toolbar overlaps:", overlaps.length ? overlaps.join("; ") : "none");
  await page.screenshot({ path: resolve(out, `rig-${w}-after.png`) });
  await page.close();
}
await browser.close();
process.exit(0);
