// Demo of the Scale and Shear gizmos: a squash and stretch on the chest and head, and the limb-scale warning.
// Starts its own sandboxed dev server (scripts/demo-server.mjs; a url argument is ignored, :5211 needs --allow-user-server).
//   node packages/animator-editor/scripts/demo-scale.mjs [outDir] [url]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = require("@playwright/test");
const out = resolve(process.argv[2] || resolve(here, "../../../docs/plans/atlas-animator-demos/editor/scale"));
const { url, dataDir } = await demoServer(process.argv[3]);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1680, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(800);
const E = (fn, arg) => page.evaluate(fn, arg);
const check = (label, ok, detail) => console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
const shot = async (name) => {
  await page.waitForTimeout(500);
  const file = resolve(out, name);
  await page.screenshot({ path: file });
  console.log(file);
};

await E(() => window.atlasEditor.mountOutfit("turned-l"));
await page.waitForTimeout(600);
await page.click("#newclip-open");
await page.fill("#newclip-name", "squash_demo");
await page.click("#newclip-make");
await page.waitForTimeout(200);

// Frame 0 rest key; frame 8 squash (chest wide and short, head follows); frame 16 stretch.
await E(() => window.atlasEditor.setGizmo("scale"));
await E(() => {
  const A = window.atlasEditor;
  A.setTime(0);
  for (const b of ["chest", "head"]) {
    A.select(b);
    A.scale(b, 1, 1);
    A.keyScale(b);
  }
});
// Drag the chest's y handle with the mouse at frame 8.
await E(() => {
  window.atlasEditor.setTime(8 / 30);
  window.atlasEditor.select("chest");
});
// The x handle sits on the bone's own axis (up the torso for the chest): pull it in to squash the chest 25%.
const before = await E(() => window.atlasEditor.scaleOf("chest"));
const h = await E(() => window.atlasEditor.handlePos("chest"));
const to = { x: h.origin.x + (h.x.x - h.origin.x) * 0.75, y: h.origin.y + (h.x.y - h.origin.y) * 0.75 };
await page.mouse.move(h.x.x, h.x.y);
await page.mouse.down();
await page.mouse.move((h.x.x + to.x) / 2, (h.x.y + to.y) / 2, { steps: 4 });
await page.mouse.move(to.x, to.y, { steps: 4 });
await page.mouse.up();
const after = await E(() => window.atlasEditor.scaleOf("chest"));
const keyed = await E(() => window.atlasEditor.state().clip.bones.chest.scale.length);
check("dragging the x handle squashes the chest (scale x ~0.75) and auto-keys it", Math.abs(after.x - 0.75) < 0.05 && keyed === 2, { before, after, keyed });
await E(() => {
  const A = window.atlasEditor;
  A.select("head");
  A.scale("head", 1.02, 0.98);
  A.keyScale("head");
  A.setGizmo("shear");
  A.select("chest");
  A.shear("chest", 8, 0);
  A.keyShear("chest");
});
const st = await E(() => window.atlasEditor.state().clip.bones);
check("chest has scale and shear keys", !!st.chest?.scale && !!st.chest?.shear, Object.keys(st.chest ?? {}));
const torsoGates = await E(() => window.atlasEditor.gatesNow().map((g) => `${g.kind}:${g.severity}`));
check("torso / head squash raises no limb scale warning", !torsoGates.some((g) => g.startsWith("limb scale")), torsoGates);
await E(() => window.atlasEditor.setGizmo("scale"));
await E(() => window.atlasEditor.select("chest"));
await shot("scale-squash-chest.png");

// Limb scale: warning only.
await E(() => {
  const A = window.atlasEditor;
  A.setTime(16 / 30);
  A.select("upper_arm_l");
  A.scale("upper_arm_l", 1, 1.35);
  A.keyScale("upper_arm_l");
});
const limbGates = await E(() => window.atlasEditor.gatesNow().filter((g) => g.kind === "limb scale").map((g) => `${g.severity}: ${g.message}`));
check("scaling a limb warns (warning, not error)", limbGates.length === 1 && limbGates[0].startsWith("warning"), limbGates);
await shot("scale-limb-warning.png");
check("no page errors", errors.length === 0, errors);
await browser.close();
