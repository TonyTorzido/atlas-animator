// Screenshots for hidden-features batch 2 (view HUD, palette button, select all / branch) in a sandboxed server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";
const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(here, "../../../ux2-shots/hidden-2");
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [w, h] of [[1600, 1000], [1366, 768]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.atlasEditor.workspace("animate"));
  await page.click("#newclip-open");
  await page.fill("#newclip-name", "shot_clip");
  await page.click("#newclip-make");
  await page.waitForTimeout(500);
  await page.evaluate(() => { const e = window.atlasEditor; e.rotate("chest", 12); e.key(); });
  for (const [f, n] of [[5, "windup"], [8, "hit"], [10, "trailOff"], [24, "ready"]]) {
    await page.evaluate(([fr]) => window.atlasEditor.setTime(fr / 30), [f]);
    await page.click("#addevent");
    await page.click(`.ctxmenu button.ctx-item:has-text("${n}")`);
  }
  await page.evaluate(() => window.atlasEditor.setTime(12 / 30));
  await page.evaluate(() => window.atlasEditor.select("chest"));
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, `animate-${w}.png`) });
  await page.click("#vh-onion-set");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `animate-${w}-onion-popover.png`) });
  await page.keyboard.press("Escape");
  await page.click("#vh-ab");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `animate-${w}-compare-popover.png`) });
  await page.keyboard.press("Escape");
  await page.click("#evmenu-btn");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `animate-${w}-events-menu.png`) });
  await page.keyboard.press("Escape");
  await page.close();
}
await browser.close();
process.exit(0);

