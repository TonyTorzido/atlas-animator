// Layout check: screenshots of Animate / Pro / Rig / Swag at three window sizes, with the canvas (#view) area measured.
//   node packages/animator-editor/scripts/layout-shots.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/layout"));
const { url } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [w, h] of [[1340, 900], [1600, 900], [1920, 1080]]) {
  const page = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }), { workspace: "animate" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  for (const ws of ["animate", "pro", "rig", "swag"]) {
    await page.evaluate((x) => window.atlasEditor.workspace(x), ws);
    await page.waitForTimeout(900);
    await page.evaluate(() => window.atlasEditor.fit?.());
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const r = document.getElementById("view").getBoundingClientRect();
      const vis = (e) => (e && e.offsetParent !== null ? e.getBoundingClientRect() : null);
      const top = vis(document.getElementById("vtop"));
      const tip = vis(document.getElementById("vtip"));
      const strip = vis(document.getElementById("xstrip"));
      const edge = vis(document.getElementById("toolpalette"));
      const art = window.atlasEditor.artBox();
      const free = { w: Math.round(r.right - (edge ? edge.right + 6 : r.left)), h: Math.round(Math.min(tip?.top ?? r.bottom, strip?.top ?? r.bottom) - (top ? top.bottom + 4 : r.top)) };
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), free, artInView: art.x0 >= r.left - 1 && art.x1 <= r.right + 1 && art.y0 >= (top ? top.bottom : r.top) - 1 && art.y1 <= Math.min(tip?.top ?? r.bottom, strip?.top ?? r.bottom) + 1 };
    });
    const pct = ((m.w * m.h) / (w * h)) * 100;
    console.log(`${ws} ${w}x${h} canvas ${m.w}x${m.h} = ${pct.toFixed(1)}%  free posing area ${m.free.w}x${m.free.h} = ${((m.free.w * m.free.h) / (w * h) * 100).toFixed(1)}%  fit clear of overlays: ${m.artInView}`);
    await page.screenshot({ path: resolve(out, `${ws}-${w}x${h}.png`) });
  }
  if (errors.length) console.log("ERRORS", errors);
  await page.close();
}
await browser.close();
process.exit(0);
