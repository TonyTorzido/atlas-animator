// Demo of the workspaces and the Home screen with screenshots at 1600x900 and 1920x1080: Home, then each workspace.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-workspaces.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/workspaces"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = [];
const check = (label, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

for (const [w, h] of [
  [1600, 900],
  [1920, 1080]
]) {
  // workspace: null = the real launch, Home first
  const page = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }), { workspace: null });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    await page.waitForTimeout(450);
    const file = resolve(out, `${name}-${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };
  const ws = () => E(() => window.atlasEditor.workspace());
  const tabs = () => E(() => [...document.querySelectorAll("#tabs button")].filter((b) => !b.hidden && b.offsetParent).map((b) => b.dataset.tab));
  const scrollbars = () => E(() => [document.documentElement, document.body, document.getElementById("home")].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "scroll"));

  check(`${w}: opens on Home`, (await ws()) === "home");
  await shot("home");

  // Open a clip and come back so Continue / Recent have something to show.
  await E(() => window.atlasEditor.workspace("animate"));
  await page.waitForTimeout(500);
  // The sandbox has no clips and Home only continues a clip that exists (Continue is for work you left, not an empty library), so make one first.
  // The clip picker always holds an empty placeholder option, so count only real clips.
  if (!(await E(() => document.querySelectorAll("#clip option[value^=\"clip:\"]").length))) {
    await E(() => window.atlasEditor.workspace("pro"));
    await page.click("#newclip-open");
    await page.fill("#newclip-name", `ws_demo_${w}`);
    await page.click("#newclip-make");
    await page.waitForTimeout(300);
    await E(() => window.atlasEditor.workspace("animate"));
    await page.waitForTimeout(300);
  }
  // Open a clip other than the one the editor starts on.
  const other = await E(() => [...document.querySelectorAll("#clip option")].map((o) => o.value).filter((v) => v.startsWith("clip:")).map((v) => v.slice(5)));
  const cur = await E(() => window.atlasEditor.state().clipName);
  await E((n) => window.atlasEditor.switchClip(n), other.find((n) => n !== cur) ?? cur);
  await E(() => window.atlasEditor.setTime(0.2));
  await page.waitForTimeout(400);
  check(`${w}: Animate tabs`, JSON.stringify(await tabs()) === JSON.stringify(["pose", "keys", "library"]), await tabs());
  await shot("animate");

  // Home through the logo, then the Animate card.
  await page.click("#logo");
  await page.waitForTimeout(800);
  check(`${w}: logo goes Home`, (await ws()) === "home");
  check(`${w}: Continue row shows`, (await page.locator("#home .home-continue-btn").count()) === 1);
  await shot("home-continue");
  await page.click('#home .home-card[data-go="swag"]');
  check(`${w}: Swag card opens Swag`, (await ws()) === "swag");
  check(`${w}: Swag tabs`, JSON.stringify(await tabs()) === JSON.stringify(["preview"]), await tabs());
  await shot("swag");

  await page.keyboard.press("h");
  check(`${w}: H goes Home from Swag`, (await ws()) === "home");
  await page.click('#home .home-card[data-go="rig"]');
  await page.waitForTimeout(1200);
  check(`${w}: Rig is Setup mode`, await E(() => document.body.classList.contains("setup")));
  check(`${w}: Rig tabs`, JSON.stringify(await tabs()) === JSON.stringify(["rig", "skins"]), await tabs());
  await shot("rig");
  await page.click('#home .home-card[data-go="ship"]').catch(() => {});
  await page.click("#ws-ship");
  await page.waitForTimeout(800);
  check(`${w}: leaving Rig leaves Setup`, !(await E(() => document.body.classList.contains("setup"))));
  check(`${w}: Ship tabs`, JSON.stringify(await tabs()) === JSON.stringify(["export"]), await tabs());
  await shot("ship");

  await page.click("#ws-pro");
  await page.waitForTimeout(500);
  check(`${w}: Pro shows all tabs`, (await tabs()).length === 7, await tabs());
  await page.keyboard.press("Shift+H");
  check(`${w}: Shift+H goes Home from Pro`, (await ws()) === "home");
  await page.click("#ws-pro");
  await shot("pro");

  // A hidden tab's control opens Pro.
  await page.click("#ws-animate");
  await E(() => window.atlasEditor.reveal("#skinpanel"));
  check(`${w}: reveal of a hidden tab falls back to Pro`, (await ws()) === "pro");

  check(`${w}: no native scrollbars`, !(await scrollbars()));
  check(`${w}: no page errors`, errors.length === 0, errors.slice(0, 3));
  await page.close();
}
await browser.close();
if (results.some((r) => !r)) process.exitCode = 1;
