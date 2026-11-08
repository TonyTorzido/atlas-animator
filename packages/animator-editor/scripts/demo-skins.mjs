// Demo of the Skins panel with screenshots: a test skin that swaps the shirt on the pro rig "Straight front (pro)".
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-skins.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] ?? resolve(here, "../../../docs/plans/atlas-animator-demos/editor/skins"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const shot = async (name) => {
  await page.waitForTimeout(600);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
  return file;
};
const shirtRed = () =>
  E(() => {
    const { skeleton } = window.atlasEditor.debug();
    const slot = skeleton.slots.find((s) => s.data.name === "shirt_torso");
    return skeleton.getAttachment(slot, "torso").color.r;
  });

check("opens on the turned rig", (await E(() => window.atlasEditor.state().outfit)) === "pro-turned");
await page.click('#skinpanel .skinrow[data-skin="body"]');
await shot("1-base-skin.png");
const baseR = await shirtRed();

// Create the test skin through the panel and give it a tinted copy of the base shirt.
await page.fill("#skinname", "test-shirt");
await page.click('#skinpanel button:text-is("New")');
await page.waitForSelector('#skinpanel .skinrow[data-skin="test-shirt"]');
await page.waitForTimeout(800);
check("skin created", (await E(() => window.atlasEditor.skins().names)).includes("test-shirt"));
await page.selectOption("#skinpanel select", "shirt_torso");
await page.fill('#skinpanel input[placeholder="tint RRGGBB"]', "d9482b");
await page.click('#skinpanel .phrow[data-placeholder="torso"] button:text-is("Add")');
await page.waitForFunction(() => window.atlasEditor.skins().counts["test-shirt"] === 1, null, { timeout: 30_000 });
await page.waitForTimeout(600);
await shot("2-test-skin-made-not-worn.png");

// Swap: wear the test skin, then back to the base.
await page.click('#skinpanel .skinrow[data-skin="test-shirt"] button:text-is("Wear")');
await page.waitForTimeout(500);
const wornR = await shirtRed();
const st = await E(() => window.atlasEditor.skins());
check("worn skin replaces the shirt", Math.abs(wornR - 0xd9 / 255) < 0.01 && Math.abs(baseR - wornR) > 0.05, { baseR, wornR });
check("active is base + test-shirt", JSON.stringify(st.active) === '["body","test-shirt"]', st.active);
check("one placeholder replaced", st.overrides.length === 1 && st.overrides[0].placeholder === "torso", st.overrides);
await shot("3-test-shirt-worn.png");
await page.click('#skinpanel .skinrow[data-skin="body"] button:text-is("Worn"), #skinpanel .skinrow[data-skin="body"] button:text-is("Wear")');
await page.waitForTimeout(500);
check("swapped back", Math.abs((await shirtRed()) - baseR) < 0.001);
await shot("4-back-to-base.png");

const spine = await E(() => window.atlasEditor.exportSkins());
const spineNames = spine.skins.map((s) => s.name);
check("Spine export has default + test-shirt", spineNames[0] === "default" && spineNames.includes("test-shirt"), spineNames); // the rig also ships the chest.* item skins
check("no page errors", errors.length === 0, errors.slice(0, 3));
await browser.close();
