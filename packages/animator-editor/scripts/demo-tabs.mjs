// Screenshots and checks of the tabbed right panel, tooltips and status bar at 1600x900 and 1920x1080.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-tabs.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/tabs"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

for (const [w, h] of [[1600, 900], [1920, 1080]]) {
  const page = revealTabs(await browser.newPage({ viewport: { width: w, height: h } }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(800);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (name) => {
    await page.waitForTimeout(350);
    const file = resolve(out, `${name}-${w}x${h}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };

  // A real edit: a new clip with a key on a selected bone, so the selection, frame and Unsaved show.
  await page.click("#newclip-open");
  await page.fill("#newclip-name", `tabs_demo_${w}`);
  await page.click("#newclip-make");
  await E(() => {
    const A = window.atlasEditor;
    A.setTime(8 / 30);
    A.select("upper_arm_near");
    A.rotate("upper_arm_near", 40);
    A.key();
  });
  await page.waitForTimeout(300);

  const bar = await E(() => ({ tool: document.getElementById("sb-tool").textContent, sel: document.getElementById("sb-sel").textContent, frame: document.getElementById("sb-frame").textContent, save: document.getElementById("sb-save").dataset.state }));
  check(`${w}: status bar shows tool, selection, frame and unsaved`, /Rotate/.test(bar.tool) && /upper_arm_near/.test(bar.sel) && /frame 8/i.test(bar.frame) && bar.save === "unsaved", JSON.stringify(bar));
  await E(() => window.atlasEditor.setAutosaving(true));
  check(`${w}: autosaving state`, (await E(() => document.getElementById("sb-save").dataset.state)) === "autosaving");
  await E(() => window.atlasEditor.setAutosaving(false));

  for (const tab of ["pose", "keys", "rig", "skins", "preview", "library", "export"]) {
    await page.click(`#tab-${tab}`);
    const m = await E(() => {
      const p = document.querySelector(".pane.active");
      return { fits: p.scrollHeight <= p.clientHeight + 1, docOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth, scroll: p.scrollHeight - p.clientHeight };
    });
    check(`${w}: ${tab} tab has no page scrollbar`, !m.docOverflow, `pane overflow ${m.scroll}px`);
    await shot(`tab-${tab}`);
  }

  await page.click("#tab-keys");
  await page.reload();
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
  await page.waitForTimeout(600);
  check(`${w}: the last tab is remembered`, (await E(() => window.atlasEditor.currentTab())) === "keys");

  const untitled = await E(() => [...document.querySelectorAll("button, input, select, textarea")].filter((e) => !e.title && !e.dataset.tipped).map((e) => e.id || e.textContent.trim()));
  check(`${w}: every control has a tooltip`, untitled.length === 0, untitled.join(", "));
  const tips = await E(() => Object.fromEntries(["#gizmo [data-mode=rotate]", "#setkey", "#undo", "#play", "#graphbtn"].map((s) => [s, document.querySelector(s).title])));
  console.log(JSON.stringify(tips));
  check(`${w}: tips carry the hotkey`, tips["#gizmo [data-mode=rotate]"].endsWith("(R)") && tips["#setkey"].endsWith("(K)") && (tips["#undo"].endsWith("(Ctrl+Z)") || /Nothing to undo/.test(tips["#undo"])) && tips["#play"].endsWith("(Space)"));

  // Setup mode owns the right panel.
  await page.click('[data-mode="setup"]');
  await page.waitForTimeout(500);
  check(`${w}: Setup opens the Rig tab`, (await E(() => window.atlasEditor.currentTab())) === "rig" && (await E(() => document.getElementById("pane-rig").classList.contains("active"))));
  check(`${w}: Setup status bar names the tool`, /Setup/.test(await E(() => document.getElementById("sb-tool").textContent)));
  await shot("setup");
  await page.click('[data-mode="animate"]');
  await page.waitForTimeout(400);
  check(`${w}: leaving Setup restores the tab`, (await E(() => window.atlasEditor.currentTab())) === "keys");

  await page.keyboard.press("?");
  await shot("help");
  await page.keyboard.press("Escape");

  check(`${w}: no page errors`, errors.length === 0, errors.join("; "));
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
