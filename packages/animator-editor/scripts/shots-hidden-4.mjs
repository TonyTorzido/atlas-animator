// Screenshots for hidden-features batch 4 (Animate slot keys, clip Manage menu and dialogs, Weights actions, Add parts, Save rig at 1366) in a sandboxed server.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";
const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(here, "../../../ux2-shots/hidden-4");
mkdirSync(out, { recursive: true });
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const [w, h] of [[1600, 1000], [1366, 768]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  const E = (f, a) => page.evaluate(f, a);
  const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: resolve(out, `${name}-${w}.png`) }); };
  // Animate: Keys tab with the slot key controls, then the Manage menu and its Length dialog.
  await E(() => window.atlasEditor.workspace("pro"));
  await page.click("#newclip-open");
  await page.fill("#newclip-name", "shot_h4");
  await page.click("#newclip-make");
  await page.waitForTimeout(500);
  await E(() => { const e = window.atlasEditor; e.workspace("animate"); e.showTab("keys"); e.setTime(6 / 30); });
  await page.waitForTimeout(600);
  await page.click("#slot-key-swap");
  await page.click("#slot-key-order");
  await shot("animate-keys");
  await page.click("#clip-manage");
  await shot("animate-manage-menu");
  await page.locator('.cb-menu-item[data-act="length"]').click();
  await shot("animate-manage-length");
  await page.click("#cb-length-dialog .cb-cancel");
  await page.click("#clip-manage");
  await page.locator('.cb-menu-item[data-act="delete"]').click();
  await shot("animate-manage-delete-confirm");
  await page.click("#cb-delete-dialog .cb-cancel");
  // Rig: Add parts in the header, then the Weights actions.
  await E(() => { const e = window.atlasEditor; e.workspace("rig"); e.mountOutfit("turned-l"); });
  await page.waitForTimeout(1800);
  await page.click("#toolpalette [data-tool='weights']");
  await page.waitForTimeout(500);
  await E(() => window.atlasEditor.selectSlot("torso"));
  await page.waitForTimeout(900);
  await shot("rig-weights");
  await page.locator("#wt-smooth").scrollIntoViewIfNeeded();
  await shot("rig-weights-actions");
  // Save rig with unsaved edits stays at the right end of the toolbar.
  await E(() => window.atlasEditor.setupTransform("chest", { rotation: 11 }));
  await page.waitForTimeout(500);
  await shot("rig-save-visible");
  const info = await E(() => {
    const b = document.getElementById("setupsave").getBoundingClientRect();
    return { text: document.getElementById("setupsave").textContent, left: b.left, right: b.right, inPop: !!document.getElementById("setupsave").closest(".ovf-pop") };
  });
  console.log(w, "save button:", JSON.stringify(info));
  await page.close();
}
await browser.close();
process.exit(0);
