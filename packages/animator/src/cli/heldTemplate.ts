/*
 * Atlas Animator: held-item template output (guide, body and allowed-mask images).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPng, writePng } from "../tools/png.js";
import { renderRigRest } from "../tools/hardPlate.js";
import { heldAreaMask, loadHeldSpec, renderHeldGuide, type HeldSpec } from "../tools/heldItem.js";
import { maskImage } from "../tools/swagGuide.js";

export interface HeldTemplateOutput {
  guide: string;
  body: string;
  allowedMask: string;
  spec: HeldSpec;
  width: number;
  height: number;
}

/** Writes guide.png, body.png, allowed-mask.png (the box) and guide.json for a held item into `outDir`. */
export function writeHeldTemplate(specPath: string, rigPath: string, outDir: string, bodyPath?: string): HeldTemplateOutput {
  const spec = loadHeldSpec(specPath);
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const body = bodyPath ? readPng(bodyPath) : renderRigRest(rigPath);
  const { width, height } = body;
  if (width !== raw.canvas.width || height !== raw.canvas.height) throw new Error(`body image is ${width}x${height}, the rig canvas is ${raw.canvas.width}x${raw.canvas.height}`);
  mkdirSync(outDir, { recursive: true });
  const guide = join(outDir, "guide.png");
  const bodyOut = join(outDir, "body.png");
  const allowedMask = join(outDir, "allowed-mask.png");
  writePng(guide, renderHeldGuide(body, spec));
  writePng(bodyOut, body);
  writePng(allowedMask, maskImage(heldAreaMask(spec, width, height), width, height));
  writeFileSync(join(outDir, "guide.json"), `${JSON.stringify({ type: "held-item", ready: true, width, height, spec: specPath, rig: rigPath, grip: spec.grip, art: spec.art, hand: spec.hand }, null, 1)}\n`);
  return { guide, body: bodyOut, allowedMask, spec, width, height };
}

