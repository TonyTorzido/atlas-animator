// Renders rigs with the real Atlas Animator renderer (renderFrames) for sheet.py (repo copy,
// packages/animator/scripts/swag/render-rest.ts; the renderer is this checkout's src/cli/render.ts). Run from packages/animator:
//   npx tsx <this> <out-dir> <scale> <clip|rest> <frame> <name>=<rig.anim.json> ...
// writes <out-dir>/<name>.png (RGBA, the renderer's own output at that scale, background b4b9c2).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const WT = process.env.ANIMATOR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { renderFrames } = await import(pathToFileURL(resolve(WT, "src/cli/render.ts")).href);
const [outDir, scale, clipArg, frameArg, ...pairs] = process.argv.slice(2) as string[];
mkdirSync(outDir!, { recursive: true });
const clip = clipArg === "rest" ? null : clipArg!;
const f = Number(frameArg ?? 0);
for (const p of pairs) {
  const i = p.indexOf("=");
  const r = await renderFrames({ document: p.slice(i + 1), clip, fps: 30, scale: Number(scale), background: 0xb4b9c2, frames: clip ? f + 1 : 1 });
  writeFileSync(join(outDir!, p.slice(0, i) + ".png"), r.frames[clip ? f : 0].png);
}
console.log("rendered", pairs.length);
