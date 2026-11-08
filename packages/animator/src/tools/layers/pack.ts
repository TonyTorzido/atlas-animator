/*
 * Atlas Animator: original implementation.
 *
 * `animator layers pack`: one completion request per part
 * that has a hidden-completion area, for an image model that takes reference images but no mask
 * argument. Each request folder holds explicit, hashed files (never "the image above"):
 *
 *   reference.png  the approved source (identity and style)
 *   target.png     the part's current layer, full canvas, original coordinates
 *   guide.png      the same canvas: the target part as is, the area to complete in magenta, the
 *                  matting band in cyan, the rest of the source faded for context
 *   prompt.txt     suggested wording, filled with the measured outline width and colours
 *   request.json   the references (path + sha256, in order), measurements, areas and joints
 *
 * The guide is guidance only; `layers enforce` is what keeps the trusted pixels.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createImage } from "../image.js";
import { readPng, writePng } from "../png.js";
import { alphaAt, readMaskPng, sha256File } from "./core.js";
import { readJson, readManifest, writeJson, type PlanFile } from "./files.js";
import { resolveRef } from "./manifest.js";

export interface PackResult {
  part: string;
  folder: string;
  completionPx: number;
}

export function writeCompletionPacks(manifestPath: string, options: { out?: string; subject?: string } = {}): PackResult[] {
  const dir = dirname(resolve(manifestPath));
  const manifest = readManifest(manifestPath);
  const plan = readJson(join(dir, "plan.json")) as PlanFile;
  const outRoot = options.out ? resolve(options.out) : join(dir, "completion-requests");
  const subject = options.subject ?? "character";
  const sourcePath = resolveRef(dir, manifest.source);
  const source = readPng(sourcePath);
  const { width: w, height: h } = source;
  const results: PackResult[] = [];
  const labelOf = (id: string) => plan.parts.find((p) => p.id === id)?.label ?? id;
  for (const part of manifest.parts) {
    const planned = plan.parts.find((p) => p.id === part.id);
    const completion = readMaskPng(resolveRef(dir, part.completionMask));
    const uncertain = readMaskPng(resolveRef(dir, part.uncertainMask));
    let n = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < w * h; i++) {
      if (!completion.data[i]) continue;
      n++;
      const x = i % w;
      const y = (i - x) / w;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (n === 0) continue;
    const folder = join(outRoot, part.id);
    mkdirSync(folder, { recursive: true });
    const target = readPng(resolveRef(dir, part.image));
    copyFileSync(sourcePath, join(folder, "reference.png"));
    copyFileSync(resolveRef(dir, part.image), join(folder, "target.png"));
    const guide = createImage(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      // Faded context over white, then the target over it, then the marks.
      const sa = alphaAt(source, i) / 255;
      let r = 255 * (1 - 0.25 * sa) + 0.25 * sa * (source.data[p] as number);
      let g = 255 * (1 - 0.25 * sa) + 0.25 * sa * (source.data[p + 1] as number);
      let b = 255 * (1 - 0.25 * sa) + 0.25 * sa * (source.data[p + 2] as number);
      const ta = alphaAt(target, i) / 255;
      r = r * (1 - ta) + ta * (target.data[p] as number);
      g = g * (1 - ta) + ta * (target.data[p + 1] as number);
      b = b * (1 - ta) + ta * (target.data[p + 2] as number);
      if (completion.data[i]) [r, g, b] = [255, 0, 255];
      else if (uncertain.data[i]) [r, g, b] = [0, 220, 255];
      guide.data[p] = Math.round(r);
      guide.data[p + 1] = Math.round(g);
      guide.data[p + 2] = Math.round(b);
      guide.data[p + 3] = 255;
    }
    writePng(join(folder, "guide.png"), guide);
    const label = labelOf(part.id);
    const joints = plan.joints.filter((j) => j.back === part.id);
    const occluders = [...new Set(joints.map((j) => labelOf(j.front)))];
    const isChild = joints.some((j) => j.child === part.id);
    const where = isChild ? `hidden ${occluders.length > 0 ? "root" : "portion"}` : "hidden areas";
    const outline = planned?.outline ?? plan.outline;
    const fills = planned?.fills ?? [];
    const outlineText = outline ? `about ${outline.widthPx} px wide, colour ${outline.color}${outline.aaColor ? `, antialiased toward ${outline.aaColor}` : ""}` : "as in the reference";
    const prompt = [
      `Complete only the ${where} of the ${label} shown in the target layer (target.png).${occluders.length > 0 ? ` That area sits beneath the ${occluders.join(" and ")}.` : ""}`,
      `The approved ${subject} (reference.png) is the identity and style reference.`,
      `Preserve the existing visible ${label}: its silhouette, markings, pose and scale stay exactly as in target.png.`,
      `Extend the existing colours${fills.length > 0 ? ` (${fills.join(", ")})` : ""} naturally into the area marked magenta in guide.png (source pixels x ${x0}..${x1}, y ${y0}..${y1}); the cyan band is the existing edge and may be blended.`,
      `Match the adjacent outline: ${outlineText}; keep its thickness, taper and antialiasing.`,
      isChild
        ? `The attachment cap will sit beneath the ${occluders.join(" and ") || "neighbouring part"}: do not draw a transverse dark cut line across it.`
        : `Do not draw the ${occluders.map((o) => `${o}'s`).join(" or ") || "neighbouring parts'"} outline or fur into this layer: the completed area must read as continuous ${label}.`,
      `Keep the original canvas framing (${w}x${h} pixels, the part in the same position) and a transparent background.`,
      `Return only this complete ${label} layer, without labels or other body parts.`
    ].join(" ");
    writeFileSync(join(folder, "prompt.txt"), `${prompt}\n`);
    const ref = (file: string) => ({ path: file, sha256: sha256File(join(folder, file)) });
    writeJson(join(folder, "request.json"), {
      part: part.id,
      label,
      references: [ref("reference.png"), ref("target.png"), ref("guide.png")],
      prompt: "prompt.txt",
      canvas: { width: w, height: h },
      completion: { pixels: n, bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } },
      outline,
      fills,
      joints: joints.map((j) => ({ parent: j.parent, child: j.child, front: j.front, pivotBone: j.pivotBone, pivot: j.pivot, radius: j.radius, marginSourcePx: j.margin })),
      afterGeneration: `animator layers enforce ${manifestPath} ${part.id} <generated.png> --prompt-file ${join(folder, "prompt.txt")}`
    });
    results.push({ part: part.id, folder, completionPx: n });
  }
  return results;
}
