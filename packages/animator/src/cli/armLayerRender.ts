/*
 * Atlas Animator: original implementation.
 *
 * Arm layer evidence renders from an already built upper rig (no rebuild, no gates):
 * `tsx src/cli/armLayerRender.ts <upper rig dir> <out.png> --preset <preset.json> --sheet raise-sweep`
 *   the shoulder seam at 4x, left arm raise 15 / 45 / 105 (crop [380, 640, 490, 750]): raise-sweep-4x.png;
 * `tsx src/cli/armLayerRender.ts <upper rig dir> <out.png> --rect x0,y0,x1,y1 [--scale 4] [--columns 3]
 *   --pose "label:bone=deg,bone=deg" [--pose ...]`
 *   any poses, one tile each (bones by name, rotations in degrees).
 * Tank slots are hidden, as in the armLayer CLI's evidence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadPreset } from "../tools/surface/preset.js";
import { readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas } from "../tools/validate.js";
import { softRender } from "../tools/softRender.js";
import { grid } from "../tools/review.js";
import type { RgbaImage } from "../tools/image.js";
import { applyPose, poseSkeleton, type ArmLayerPose } from "../tools/surface/armLayerGates.js";

const BG: [number, number, number] = [30, 36, 48];

function main(): void {
  const [rigDir, outPath] = process.argv.slice(2) as [string, string];
  if (!rigDir || !outPath) throw new Error("usage: armLayerRender <upper rig dir> <out.png> (--sheet raise-sweep --preset <preset.json> | --rect x0,y0,x1,y1 --pose label:bone=deg,...)");
  const flag = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const flags = (k: string) => process.argv.flatMap((a, i) => (a === k && process.argv[i + 1] ? [process.argv[i + 1] as string] : []));
  const base = (readdirSync(rigDir).find((f) => f.endsWith(".anim.json")) ?? "").replace(/\.anim\.json$/, "");
  if (!base) throw new Error(`${rigDir}: no .anim.json`);
  const doc = loadAnimDocument(JSON.parse(readFileSync(join(rigDir, `${base}.anim.json`), "utf8")));
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(join(rigDir, `${base}.atlas.json`), "utf8")));
  const textures = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(rigDir, p.file))] as [string, RgbaImage])));

  let rect: [number, number, number, number];
  let scale = Number(flag("--scale") ?? 4);
  let columns = Number(flag("--columns") ?? 3);
  const poses: ArmLayerPose[] = [];
  const sheet = flag("--sheet");
  if (sheet === "raise-sweep") {
    const presetPath = flag("--preset");
    if (!presetPath) throw new Error("--sheet raise-sweep needs --preset (the upper arm is the preset chain's first bone)");
    const root = loadPreset(resolve(presetPath)).chain.bones[0] as string;
    rect = [380, 640, 490, 750];
    scale = 4;
    columns = 3;
    for (const a of [15, 45, 105]) poses.push({ name: `left raise ${a} (4x)`, rotate: { [root]: a } });
  } else if (sheet) throw new Error(`unknown --sheet '${sheet}'`);
  else {
    const r = (flag("--rect") ?? "").split(",").map(Number);
    if (r.length !== 4 || r.some((v) => !Number.isFinite(v))) throw new Error("--rect x0,y0,x1,y1 required");
    rect = r as [number, number, number, number];
    for (const spec of flags("--pose")) {
      const [label, body = ""] = spec.includes(":") ? (spec.split(/:(.*)/s) as [string, string]) : [spec, spec];
      const rotate: Record<string, number> = {};
      for (const kv of body.split(",").filter(Boolean)) {
        const [b, v] = kv.split("=");
        if (!b || !Number.isFinite(Number(v))) throw new Error(`--pose '${spec}': bad '${kv}'`);
        rotate[b.trim()] = Number(v);
      }
      poses.push({ name: label, rotate });
    }
    if (!poses.length) throw new Error("no --pose given");
  }
  const [x0, y0, x1, y1] = rect;
  const tiles = poses.map((pose) => {
    const sk = poseSkeleton(doc);
    for (const s of sk.slots) if (/tank/.test(s.data.name)) s.hidden = true;
    applyPose(sk, pose);
    const image = softRender(sk, textures, { width: Math.round((x1 - x0) * scale), height: Math.round((y1 - y0) * scale), scale, left: x0 - doc.canvas.originX, top: y0 - doc.canvas.originY, background: BG }).image;
    return { image, label: pose.name };
  });
  writePng(resolve(outPath), grid(tiles, Math.min(columns, tiles.length), 3));
  console.log(`${outPath}: ${tiles.length} tiles, rect [${rect.join(", ")}] at ${scale}x`);
}

main();
