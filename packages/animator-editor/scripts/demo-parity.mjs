// Render parity (MESH-WEIGHTS-PLAN P1) in a sandbox (scripts/demo-server.mjs; never port 5211):
//   edit the Turned L rig file (new weights on the torso skin mesh + deform keys on walk_in_place), render one frame with
//   `animator render`, capture the same frame from the editor canvas (character only, same scale and origin), compare with pixelmatch.
//   Difference must be under 0.5% of the pixels the character covers.
//   node packages/animator-editor/scripts/demo-parity.mjs [outDir] [--frame=7]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revealTabs } from "./tab-reveal.mjs";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../../..");
const req = createRequire(resolve(here, "../../animator/package.json"));
const { chromium } = req("@playwright/test");
const pixelmatchModule = req("pixelmatch");
const pixelmatch = pixelmatchModule.default ?? pixelmatchModule;
const { PNG } = req("pngjs");
const out = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : resolve(here, "../../../docs/plans/atlas-animator-demos/editor/parity"));
const FRAME = Number((process.argv.find((a) => a.startsWith("--frame=")) ?? "--frame=7").slice(8));
const CLIP = "walk_in_place";
const FPS = 30;
const SCALE = 1;
const { url, dataDir } = await demoServer();
mkdirSync(out, { recursive: true });
const rigPath = resolve(dataDir, "rigs/player/front-turn15-faceA.anim.json");

// 1. Edited rig: other weights on the torso skin mesh, and deform keys on the clip.
const doc = JSON.parse(readFileSync(rigPath, "utf8"));
const mesh = doc.skins.body.attachments.torso.skin;
let influences = 0;
for (let c = 0, v = 0; v < mesh.uvs.length / 2; v++) {
  const n = mesh.vertices[c++];
  if (n === 2) {
    const w = mesh.vertices[c + 3] * 0.55;
    mesh.vertices[c + 3] = w;
    mesh.vertices[c + 7] = 1 - w; // the other influence takes the rest
  }
  influences += n;
  c += n * 4;
}
const wave = (seed) => Array.from({ length: influences * 2 }, (_, i) => Math.round(Math.sin(i * 0.37 + seed) * 60) / 10);
doc.animations[CLIP].deform = { body: { torso: { skin: [{ time: 0, vertices: wave(1) }, { time: 0.2, vertices: wave(2) }, { time: doc.animations[CLIP].duration, vertices: wave(1) }] } } };
writeFileSync(rigPath, JSON.stringify(doc));
const canvas = doc.canvas;
const size = `${Math.ceil(canvas.width * SCALE)}x${Math.ceil(canvas.height * SCALE)}`;
const origin = [Math.round(canvas.originX * SCALE), Math.round(canvas.originY * SCALE)];
const W = Math.ceil(canvas.width * SCALE);
const H = Math.ceil(canvas.height * SCALE);

// 2. The CLI frame.
const pngDir = resolve(out, "cli");
mkdirSync(pngDir, { recursive: true });
const run = spawnSync(process.execPath, [resolve(repo, "node_modules/tsx/dist/cli.mjs"), resolve(repo, "packages/animator/src/cli/animator.ts"), "render", rigPath, "--clip", CLIP, "--fps", String(FPS), "--frames", String(FRAME + 1), "--scale", String(SCALE), "--size", size, "--origin", origin.join(","), "--background", "1e2430", "--png-dir", pngDir], { cwd: repo, encoding: "utf8", timeout: 240_000 });
console.log(run.stdout.trim().split("\n")[0], run.stderr.trim());
const files = readdirSync(pngDir).filter((f) => f.endsWith(".png")).sort();
const cliPng = PNG.sync.read(readFileSync(resolve(pngDir, files[FRAME])));

// 3. The editor frame.
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = revealTabs(await browser.newPage({ viewport: { width: 1800, height: 1000 } }));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1000);
await page.evaluate(() => window.atlasEditor.mountOutfit("turned-l"));
await page.waitForTimeout(1500);
await page.evaluate((clip) => window.atlasEditor.switchClip(clip), CLIP);
await page.waitForTimeout(500);
await page.evaluate(([t]) => window.atlasEditor.setTime(t), [FRAME / FPS]);
await page.waitForTimeout(500);
const grab = await page.evaluate(([W, H, ox, oy, scale]) => {
  const { app, character, world } = window.atlasEditor.debug();
  for (const c of world.children) if (c !== character) c.visible = false;
  world.scale.set(scale);
  world.position.set(0, 0);
  const rect = character.getBounds();
  // Put the rig origin at (ox, oy) of the capture frame: the character sits in `world` at the rig origin (0, 0).
  const o = character.toGlobal({ x: 0, y: 0 });
  world.position.set(ox - o.x, oy - o.y);
  app.renderer.background.color = 0x1e2430;
  app.renderer.render(app.stage);
  const Rect = rect.rectangle.constructor;
  const { pixels, width, height } = app.renderer.extract.pixels({ target: app.stage, frame: new Rect(0, 0, W, H), resolution: 1, clearColor: [0x1e / 255, 0x24 / 255, 0x30 / 255, 1] });
  return { pixels: Array.from(pixels), width, height, facing: window.atlasEditor.facing?.() ?? null };
}, [W, H, origin[0], origin[1], SCALE]);
await browser.close();
const edPng = new PNG({ width: grab.width, height: grab.height });
edPng.data = Buffer.from(grab.pixels);
writeFileSync(resolve(out, `editor-frame${FRAME}.png`), PNG.sync.write(edPng));
writeFileSync(resolve(out, `cli-frame${FRAME}.png`), PNG.sync.write(cliPng));

// 4. Compare.
const bg = [0x1e, 0x24, 0x30];
const covered = (png) => {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (Math.abs(png.data[i] - bg[0]) + Math.abs(png.data[i + 1] - bg[1]) + Math.abs(png.data[i + 2] - bg[2]) > 12) n++;
  return n;
};
const dims = `${cliPng.width}x${cliPng.height} vs ${edPng.width}x${edPng.height}`;
const diff = new PNG({ width: cliPng.width, height: cliPng.height });
const wrong = edPng.width === cliPng.width && edPng.height === cliPng.height ? pixelmatch(cliPng.data, edPng.data, diff.data, cliPng.width, cliPng.height, { threshold: 0.1, includeAA: false }) : -1;
writeFileSync(resolve(out, `diff-frame${FRAME}.png`), PNG.sync.write(diff));
const total = cliPng.width * cliPng.height;
const pct = (wrong / total) * 100;
console.log(JSON.stringify({ dims, wrong, total, pctOfFrame: +pct.toFixed(4), covered: covered(cliPng), pctOfCovered: +((wrong / Math.max(1, covered(cliPng))) * 100).toFixed(3), errors }));
console.log(pct < 0.5 && wrong >= 0 && errors.length === 0 ? "PASS parity under 0.5%" : "FAIL parity");
process.exit(pct < 0.5 && wrong >= 0 && errors.length === 0 ? 0 : 1);
