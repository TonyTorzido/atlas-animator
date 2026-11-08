/*
 * Atlas Animator: original implementation.
 *
 * Full-body non-mirrored build mode (packages/animator/README.md, phase 2b, option A).
 * The mirrored mode (one half-body preset reflected about `mirror.x`) stays as it is. A full-body
 * preset is for asymmetric views (the turned side): it declares several limb chains (a near arm, a
 * far arm, a near leg, a far leg), each an ordinary single-chain surface preset part with its own
 * skin sheet and outline, solved independently and never mirrored. The canvas and the game scale
 * are declared once and inherited by every part; bones with the same name must agree across parts
 * (one shared skeleton); each limb chain belongs to one part; slot and texture names are unique.
 *
 * Layering (the arm-layer join): a near arm part carries the torso as its `assembly` under-sheet
 * (the arm draws OVER the torso, as in the mirrored arm layer); a far part draws wholly UNDER the
 * torso sheet. The torso is a full sheet (no centre weld): only the parts are composed.
 * Every coordinate lives in the preset files; this module holds no template values.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { surfacePresetSchema, type SurfacePreset } from "./preset.js";

/** Fields every part inherits from the full body (a part must not redeclare them). */
export const INHERITED = ["canvas", "figureHeight", "gamePixels"] as const;

const part = z
  .object({
    /** Part name (reports, gate labels). */
    name: z.string(),
    /** The part preset file, relative to the full-body preset. */
    file: z.string(),
    /** `near`: drawn over the torso sheet (arm-layer join); `far`: wholly under it. */
    depth: z.enum(["near", "far"]),
    kind: z.enum(["arm", "leg"]),
    /** The part on the other side of the body (near arm <-> far arm): the correspondence the mirror used to give. */
    partner: z.string().optional()
  })
  .strict();

export const fullBodySchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    canvas: z.object({ width: z.number(), height: z.number(), originX: z.number(), originY: z.number() }).strict(),
    figureHeight: z.number().positive(),
    gamePixels: z.number().positive(),
    /** The approved canvas art of this view (relative path), for the paint bake and evidence. */
    art: z.string().optional(),
    parts: z.array(part).min(1)
  })
  .strict();

export type FullBodySpec = z.output<typeof fullBodySchema>;
export type FullBodyPartSpec = z.output<typeof part>;
export interface FullBodyPart {
  spec: FullBodyPartSpec;
  preset: SurfacePreset;
  /** Directory of the part file (relative paths in the part resolve against it). */
  dir: string;
}
export interface FullBody {
  spec: FullBodySpec;
  dir: string;
  parts: FullBodyPart[];
}

/** Slot names a part's build can emit (skin, its groups, sheets, regions, garments and their overlays). */
export function partSlots(p: SurfacePreset): string[] {
  const out = new Set<string>([p.skin.slot, ...p.skin.groups.map((g) => g.slot), ...p.regions.map((r) => r.slot), ...p.garments.flatMap((g) => [g.slot, ...(g.overlays ?? []).map((o) => o.name)])]);
  for (const s of p.assembly?.sheets ?? []) out.add(s.slot);
  return [...out];
}

function partTextures(p: SurfacePreset): string[] {
  return [p.skin.texture, ...p.regions.map((r) => r.texture), ...p.garments.map((g) => g.texture), ...(p.assembly?.sheets ?? []).map((s) => s.texture)];
}

/** Cross-part rules of a full-body preset; returns the problems (empty when valid). */
export function fullBodyProblems(parts: readonly { spec: FullBodyPartSpec; preset: SurfacePreset }[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const { spec } of parts) {
    if (names.has(spec.name)) problems.push(`part '${spec.name}' declared twice`);
    names.add(spec.name);
  }
  for (const { spec } of parts) if (spec.partner && (!names.has(spec.partner) || spec.partner === spec.name)) problems.push(`part '${spec.name}': partner '${spec.partner}' is not another part`);
  const bones = new Map<string, { part: string; json: string }>();
  const chainOwner = new Map<string, string>();
  const slotOwner = new Map<string, string>();
  const texOwner = new Map<string, string>();
  for (const { spec, preset } of parts) {
    if (preset.mirror) problems.push(`part '${spec.name}': a full-body part is never mirrored (remove 'mirror')`);
    if (spec.depth === "near" && spec.kind === "arm" && !preset.assembly) problems.push(`part '${spec.name}': a near arm carries the torso sheet it draws over ('assembly')`);
    if (spec.depth === "far" && preset.assembly) problems.push(`part '${spec.name}': a far part draws under the torso and declares no 'assembly'`);
    if (spec.kind === "leg" && preset.assembly) problems.push(`part '${spec.name}': a leg declares no 'assembly'`);
    for (const b of preset.bones) {
      const json = JSON.stringify({ parent: b.parent ?? null, at: b.at ?? null, toward: b.toward ?? null, rotation: b.rotation ?? null, length: b.length ?? null, limits: b.limits ?? null, inherit: b.inherit ?? null });
      const seen = bones.get(b.name);
      if (!seen) bones.set(b.name, { part: spec.name, json });
      else if (seen.json !== json) problems.push(`bone '${b.name}' differs between parts '${seen.part}' and '${spec.name}' (one shared skeleton)`);
    }
    for (const b of preset.chain.bones) {
      const o = chainOwner.get(b);
      if (o) problems.push(`limb bone '${b}' is in the chains of '${o}' and '${spec.name}'`);
      else chainOwner.set(b, spec.name);
    }
    for (const s of partSlots(preset)) {
      const o = slotOwner.get(s);
      if (o) problems.push(`slot '${s}' is built by '${o}' and '${spec.name}'`);
      else slotOwner.set(s, spec.name);
    }
    for (const t of partTextures(preset)) {
      const o = texOwner.get(t);
      if (o) problems.push(`texture '${t}' is built by '${o}' and '${spec.name}'`);
      else texOwner.set(t, spec.name);
    }
  }
  if (!parts.some((p) => p.preset.assembly)) problems.push("no part carries the torso sheet (a near arm with 'assembly')");
  return problems;
}

/** Reads one part file and inherits the full body's shared fields; the result is an ordinary surface preset. */
export function loadPart(spec: FullBodyPartSpec, body: FullBodySpec, bodyDir: string): FullBodyPart {
  const file = resolve(bodyDir, spec.file);
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const k of INHERITED) if (k in json) throw new Error(`part '${spec.name}' (${spec.file}): '${k}' is declared by the full body, not by a part`);
  const preset = surfacePresetSchema.parse({ ...json, canvas: body.canvas, figureHeight: body.figureHeight, gamePixels: body.gamePixels });
  return { spec, preset, dir: dirname(file) };
}

export function loadFullBody(file: string): FullBody {
  const path = resolve(file);
  const spec = fullBodySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const dir = dirname(path);
  const parts = spec.parts.map((p) => loadPart(p, spec, dir));
  const problems = fullBodyProblems(parts);
  if (problems.length) throw new Error(`full body '${spec.name}': ${problems.join("; ")}`);
  return { spec, dir, parts };
}
