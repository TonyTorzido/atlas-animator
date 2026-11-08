/*
 * Atlas Animator: original implementation.
 *
 * `pnpm --filter @atlas-animator/core swag:template --type simple --domain <domain.json> [--out <dir>]
 *  [--rig <body.anim.json>] [--body <rest.png>] [--hides tank]`
 * Writes the colour-in guide for a template type (see swag-rules/STYLE.md): guide.png (the body at rest
 * with the allowed area and the guide outline on top, standard pose, size and background),
 * body.png (the body alone) and allowed-mask.png (white = allowed). The allowed area is the garment
 * surface of the domain at rest, so it is exactly what the importer accepts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePng } from "../tools/png.js";
import { loadSwagContext, maskImage, renderGuide, type SwagContext } from "../tools/swagGuide.js";
import { loadPlateSpec, mirrorAxis, plateAreaMask, renderPlateGuide, renderRigRest, type PlateSpec } from "../tools/hardPlate.js";
import { readPng } from "../tools/png.js";
import { readFileSync } from "node:fs";
import { writeHeldTemplate } from "./heldTemplate.js";
import { DEFAULT_BODY_RIG, DEFAULT_HELD, DEFAULT_PLATE, SWAG_READY, defaultDomainFor, domainTemplateMismatch, flagStr, parseArgs, swagTypeFlag, type Flags, type SwagType } from "../tools/swagTypes.js";

export interface TemplateOutput {
  guide: string;
  body: string;
  allowedMask: string;
  ctx: SwagContext;
}

/** Writes the guide files for `type` into `outDir`. */
export function writeSwagTemplate(type: SwagType, ctx: SwagContext, outDir: string): TemplateOutput {
  mkdirSync(outDir, { recursive: true });
  const guide = join(outDir, "guide.png");
  const body = join(outDir, "body.png");
  const allowedMask = join(outDir, "allowed-mask.png");
  writePng(guide, renderGuide(ctx));
  writePng(body, ctx.body);
  writePng(allowedMask, maskImage(ctx.allowed, ctx.width, ctx.height));
  writeFileSync(join(outDir, "guide.json"), `${JSON.stringify({ type, ready: SWAG_READY.includes(type), width: ctx.width, height: ctx.height, margin: ctx.margin, strokeWidth: ctx.strokeWidth, overflowZones: ctx.overflowZones }, null, 1)}\n`);
  return { guide, body, allowedMask, ctx };
}

export interface PlateTemplateOutput {
  guide: string;
  body: string;
  allowedMask: string;
  spec: PlateSpec;
  axis: number;
  width: number;
  height: number;
}

/**
 * Writes the hard-plate guide files into `outDir`: guide.png (the body at rest, e.g. in the armour the
 * plate goes over, with the left plate's allowed area, the socket and the mirrored side), body.png,
 * allowed-mask.png (the left area) and guide.json.
 */
export function writePlateTemplate(specPath: string, rigPath: string, outDir: string, bodyPath?: string): PlateTemplateOutput {
  const spec = loadPlateSpec(specPath);
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const axis = mirrorAxis(spec, raw);
  const body = bodyPath ? readPng(bodyPath) : renderRigRest(rigPath);
  const { width, height } = body;
  if (width !== raw.canvas.width || height !== raw.canvas.height) throw new Error(`body image is ${width}x${height}, the rig canvas is ${raw.canvas.width}x${raw.canvas.height}`);
  mkdirSync(outDir, { recursive: true });
  const guide = join(outDir, "guide.png");
  const bodyOut = join(outDir, "body.png");
  const allowedMask = join(outDir, "allowed-mask.png");
  writePng(guide, renderPlateGuide(body, spec, axis));
  writePng(bodyOut, body);
  writePng(allowedMask, maskImage(plateAreaMask(spec, width, height, "l", axis), width, height));
  writeFileSync(join(outDir, "guide.json"), `${JSON.stringify({ type: "hard-plate", ready: true, width, height, spec: specPath, rig: rigPath, area: spec.area, socket: spec.socket, sides: spec.sides, overflow: spec.overflow ?? [] }, null, 1)}
`);
  return { guide, body: bodyOut, allowedMask, spec, axis, width, height };
}

export function swagTemplateCommand(flags: Flags): number {
  const type = swagTypeFlag(flags, (m) => process.stderr.write(m));
  if (!type) return 2;
  if (type === "hard-plate") {
    const out = resolve(flagStr(flags, "out") ?? "swag-template-hard-plate");
    const body = flagStr(flags, "body");
    const r = writePlateTemplate(resolve(flagStr(flags, "plate") ?? DEFAULT_PLATE), resolve(flagStr(flags, "rig") ?? DEFAULT_BODY_RIG), out, body ? resolve(body) : undefined);
    process.stdout.write(`${JSON.stringify({ type, guide: r.guide, allowedMask: r.allowedMask, body: r.body })}
`);
    return 0;
  }
  if (type === "held-item") {
    const out = resolve(flagStr(flags, "out") ?? "swag-template-held-item");
    const body = flagStr(flags, "body");
    const r = writeHeldTemplate(resolve(flagStr(flags, "held") ?? DEFAULT_HELD), resolve(flagStr(flags, "rig") ?? DEFAULT_BODY_RIG), out, body ? resolve(body) : undefined);
    process.stdout.write(`${JSON.stringify({ type, guide: r.guide, allowedMask: r.allowedMask, body: r.body })}
`);
    return 0;
  }
  const domain = flagStr(flags, "domain") ?? defaultDomainFor(type);
  const mismatch = domainTemplateMismatch(type, JSON.parse(readFileSync(resolve(domain), "utf8")) as { template?: string });
  if (mismatch) { process.stderr.write(`${mismatch}
`); return 2; }
  if (!SWAG_READY.includes(type)) process.stderr.write(`note: ${type} is a stub template type (swag-rules/STYLE.md); the guide is the same body and domain area, the rules are not final\n`);
  const bodyPath = flagStr(flags, "body");
  const ctx = loadSwagContext({ rigPath: resolve(flagStr(flags, "rig") ?? DEFAULT_BODY_RIG), domainPath: resolve(domain), hides: (flagStr(flags, "hides") ?? "tank").split(",").filter(Boolean), ...(bodyPath ? { bodyPath: resolve(bodyPath) } : {}) });
  const out = resolve(flagStr(flags, "out") ?? `swag-template-${type}`);
  const r = writeSwagTemplate(type, ctx, out);
  process.stdout.write(`${JSON.stringify({ type, guide: r.guide, allowedMask: r.allowedMask, body: r.body })}\n`);
  return 0;
}

const stem = (path: string) => resolve(path).replace(/\.[cm]?[jt]s$/, "");
if (process.argv[1] && stem(process.argv[1]) === stem(fileURLToPath(import.meta.url))) {
  try {
    process.exit(swagTemplateCommand(parseArgs(process.argv.slice(2)).flags));
  } catch (e) {
    process.stderr.write(`${(e as Error).stack}\n`);
    process.exit(1);
  }
}
