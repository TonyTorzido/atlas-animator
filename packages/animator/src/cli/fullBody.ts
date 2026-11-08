/*
 * Atlas Animator: original implementation.
 *
 * Full-body non-mirrored build (phase 2b, packages/animator/README.md):
 * `tsx src/cli/fullBody.ts <body.json> <out dir> [--no-gates] [--no-extremity]`
 * builds every part of a full-body preset (tools/surface/fullBody.ts) with the ordinary surface
 * builder (no mirror), writes each part under <out>/parts/<part>, composes them
 * (tools/surface/fullBodyCompose.ts: far arms under the body, the near arm over the full torso
 * sheet, leg skins under the torso and leg garments over it), joins the rigid extremities (fists)
 * as the arm-layer CLI does, writes <out>/<name>.{anim,atlas}.json + png and runs the arm-layer
 * gates per arm (tools/surface/fullBodyGates.ts) into <out>/<name>.gates.json. Exit 1 on a failed gate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { loadFullBody } from "../tools/surface/fullBody.js";
import { composeFullBody, type BuiltPart } from "../tools/surface/fullBodyCompose.js";
import { farArmGates, nearArmGates, type GatePart } from "../tools/surface/fullBodyGates.js";
import { buildRig, writeAtlas, writeRig } from "../tools/surface/output.js";
import { validationCompanion } from "../tools/surface/validationCompanion.js";
import { opaqueOutline } from "../tools/bodyContours.js";
import { joinExtremities } from "../tools/extremityJoin.js";
import { DEFAULT_ALLOWANCE, type DistortionAllowance } from "../tools/validateGeometry.js";
import type { GateResult } from "../tools/surface/armLayerGates.js";

async function main() {
  const [bodyPath, outDir] = process.argv.slice(2) as [string, string];
  if (!bodyPath || !outDir) throw new Error("usage: fullBody.ts <body.json> <out dir> [--no-gates] [--no-extremity]");
  const body = loadFullBody(resolve(bodyPath));
  const built: BuiltPart[] = [];
  const gateParts = new Map<string, GatePart>();
  for (const part of body.parts) {
    const rig = buildRig(part.preset, part.dir);
    writeRig(rig, join(outDir, "parts", part.spec.name));
    built.push({ spec: part.spec, preset: part.preset, raw: rig.raw as Record<string, any>, textures: rig.textures });
    const companion = validationCompanion(rig);
    const armSheet = `${part.preset.skin.slot}/${part.preset.skin.attachment}`;
    const regionOf = new Map<number, string>();
    for (const [region, ids] of Object.entries(companion.regions[armSheet]?.triangles ?? {})) for (const t of ids as number[]) regionOf.set(t, region);
    const allowanceOf = (key: string, t: number): DistortionAllowance => (key === armSheet ? (companion.allowances[regionOf.get(t) ?? "default"] ?? companion.allowances.default ?? DEFAULT_ALLOWANCE) : (companion.allowances.default ?? DEFAULT_ALLOWANCE)) as DistortionAllowance;
    gateParts.set(part.spec.name, { spec: part.spec, preset: part.preset, limits: [...rig.limits, ...rig.clipLimits], allowanceOf, gameScale: companion.gameScale });
    process.stdout.write(`built part ${part.spec.name} (${part.spec.depth} ${part.spec.kind}) in ${(rig.buildMs / 1000).toFixed(1)} s\n`);
  }
  const c = composeFullBody(body.spec.name, built);
  // Rigid regions trim strokes only under their opaque art (as the arm-layer CLI does).
  for (const sk of Object.values(c.doc.skins as Record<string, any>)) for (const bySlot of Object.values((sk.attachments ?? {}) as Record<string, Record<string, any>>)) for (const att of Object.values(bySlot)) {
    if (att.type !== "region" || att.opaque) continue;
    const img = c.textures.get(att.path);
    const outline = img ? opaqueOutline(img) : null;
    if (outline) att.opaque = outline;
  }
  // Fist joins: each arm part's rigid extremity regions with a keep polygon (the hand of its chain); only that
  // arm's own strokes are cut there (the torso outline under a fist's keep box stays whole).
  if (!process.argv.includes("--no-extremity")) {
    const extremities = body.parts.filter((p) => p.spec.kind === "arm").flatMap((p) => p.preset.regions.filter((r) => r.keep && p.preset.chain.bones.includes(r.bone)).map((r) => ({ slot: r.slot, keep: r.keep as number[][], contourSlots: [p.preset.skin.slot, ...p.preset.skin.groups.map((g) => g.slot)] })));
    c.report.push(...joinExtremities(c.doc, c.textures, extremities).map((l) => `extremity ${l}`));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${body.spec.name}.anim.json`), `${JSON.stringify(c.doc)}\n`);
  writeAtlas(c.textures, outDir, body.spec.name);
  const results: GateResult[] = [];
  if (!process.argv.includes("--no-gates")) {
    const doc = loadAnimDocument(c.doc);
    const arms = body.parts.filter((p) => p.spec.kind === "arm");
    const farArms = arms.filter((p) => p.spec.depth === "far");
    const carrier = body.parts.find((p) => p.preset.assembly);
    const clearance = Math.min(...(carrier?.preset.assembly?.connections ?? []).map((x) => x.clearance));
    // An arm's own slots: its part's slots without the torso sheet and without rigid regions off its chain (the head).
    const armSlots = (name: string) => {
      const part = body.parts.find((p) => p.spec.name === name);
      const off = new Set([...(part?.preset.assembly?.sheets ?? []).map((s) => s.slot), ...(part?.preset.regions ?? []).filter((r) => !part?.preset.chain.bones.includes(r.bone)).map((r) => r.slot)]);
      return (c.slotsOf[name] ?? []).filter((s) => !off.has(s));
    };
    for (const near of arms.filter((p) => p.spec.depth === "near")) {
      const far = farArms.find((f) => f.spec.name === near.spec.partner || f.spec.partner === near.spec.name) ?? farArms[0] ?? null;
      results.push(...nearArmGates(doc, c.textures, gateParts.get(near.spec.name) as GatePart, far ? (gateParts.get(far.spec.name) as GatePart) : null, far ? armSlots(far.spec.name) : [], armSlots(near.spec.name)));
    }
    for (const far of farArms) results.push(...farArmGates(doc, gateParts.get(far.spec.name) as GatePart, c.sheets[0] as string, clearance));
  }
  const failures = results.filter((r) => !r.ok).map((r) => `${r.gate}: ${r.detail}`);
  writeFileSync(join(outDir, `${body.spec.name}.gates.json`), `${JSON.stringify({ body: body.spec.name, compose: c.report, slotsOf: c.slotsOf, gates: results, failures }, null, 2)}\n`);
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${r.gate}: ${r.detail}\n`);
  if (failures.length) {
    process.stderr.write(`full body: ${failures.length} gate failure(s)\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
