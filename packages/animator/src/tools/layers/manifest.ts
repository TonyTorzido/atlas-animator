/*
 * Atlas Animator: original implementation.
 *
 * The layered-parts placement manifest, version 1, with
 * its schema and validator. Conventions:
 *
 * - `coordinates`: source pixels, top-left origin, y down.
 * - `canvasFromLayer` [a, b, c, d, e, f]: canvas = (a x + c y + e, b x + d y + f) for a layer
 *   pixel (x, y) (the 2D-canvas `setTransform` order). Full-canvas layers use the identity
 *   [1, 0, 0, 1, 0, 0]. It is the placement on the source canvas, separate from the attachment's
 *   bone-local transform (which `layers build` derives on import).
 * - File refs are relative to the manifest's folder (or absolute); `sha256` is of the file bytes.
 * - `drawOrder` is back to front. Joint `probeNames` are `<pivot bone> rotate <degrees>`.
 * - `generationRecord` is a JSON file: { kind: "extracted" | "generated", prompt, references
 *   (ordered FileRefs), tool, model, output (the accepted image's FileRef) }.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readPng } from "../png.js";
import { sha256File } from "./core.js";

const sha = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
export const fileRefSchema = z.object({ path: z.string().min(1), sha256: sha }).strict();
export type FileRef = z.output<typeof fileRefSchema>;

const name = z.string().min(1);
export const layerManifestSchema = z
  .object({
    version: z.literal(1),
    source: fileRefSchema.extend({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    coordinates: z.literal("source-pixels-top-left-y-down"),
    rig: fileRefSchema.extend({ codeCommit: z.string().min(1) }).strict(),
    parts: z
      .array(
        z
          .object({
            id: name,
            image: fileRefSchema,
            visibleMask: fileRefSchema,
            completionMask: fileRefSchema,
            uncertainMask: fileRefSchema,
            canvasFromLayer: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
            pivotCanvas: z.tuple([z.number(), z.number()]),
            skin: name,
            slot: name,
            attachment: name,
            bone: name,
            domainId: name,
            allowedBones: z.array(name).min(1),
            generationRecord: fileRefSchema
          })
          .strict()
      )
      .min(1),
    drawOrder: z.array(name),
    joints: z.array(
      z
        .object({
          parentPart: name,
          childPart: name,
          pivotBone: name,
          kind: z.enum(["overlap", "welded", "membrane"]),
          coverageMask: fileRefSchema,
          marginSourcePx: z.number().nonnegative(),
          probeNames: z.array(name)
        })
        .strict()
    ),
    acceptanceReport: fileRefSchema
  })
  .strict();
export type LayerManifest = z.output<typeof layerManifestSchema>;
export type ManifestPart = LayerManifest["parts"][number];

export const generationRecordSchema = z
  .object({
    kind: z.enum(["extracted", "generated"]),
    part: name,
    prompt: z.string().nullable(),
    references: z.array(fileRefSchema),
    tool: z.string().nullable(),
    model: z.string().nullable(),
    output: fileRefSchema,
    notes: z.array(z.string()).optional()
  })
  .strict();
export type GenerationRecord = z.output<typeof generationRecordSchema>;

export const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

export function resolveRef(baseDir: string, ref: { path: string }): string {
  return isAbsolute(ref.path) ? ref.path : join(baseDir, ref.path);
}

export interface ManifestIssue {
  severity: "error" | "warning";
  message: string;
}

export interface ValidateManifestOptions {
  /** Folder file refs resolve against; when given, files are hashed and image sizes checked. */
  baseDir?: string;
  /** Bone names of the rig (when known): every bone, allowed bone and pivot bone must exist. */
  bones?: ReadonlySet<string>;
}

/** Schema plus cross-reference checks; never throws on bad input. */
export function validateManifest(input: unknown, options: ValidateManifestOptions = {}): { manifest: LayerManifest | null; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const parsed = layerManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push({ severity: "error", message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
    return { manifest: null, issues };
  }
  const m = parsed.data;
  const error = (message: string) => issues.push({ severity: "error", message });
  const ids = m.parts.map((p) => p.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) error(`part ids repeat: ${ids.join(", ")}`);
  const slots = m.parts.map((p) => p.slot);
  if (new Set(slots).size !== slots.length) error(`slots repeat: ${slots.join(", ")}`);
  if (m.drawOrder.length !== ids.length || new Set(m.drawOrder).size !== m.drawOrder.length || m.drawOrder.some((id) => !idSet.has(id))) error(`drawOrder must list every part id once (parts: ${ids.join(", ")})`);
  for (const part of m.parts) {
    const t = part.canvasFromLayer;
    if (Math.abs(t[0] * t[3] - t[1] * t[2]) < 1e-9) error(`part ${part.id}: canvasFromLayer is singular`);
    if (options.bones) {
      for (const b of [part.bone, ...part.allowedBones]) if (!options.bones.has(b)) error(`part ${part.id}: no bone '${b}' in the rig`);
    }
    if (!part.allowedBones.includes(part.bone)) issues.push({ severity: "warning", message: `part ${part.id}: its bone '${part.bone}' is not among its allowed bones` });
  }
  for (const joint of m.joints) {
    if (!idSet.has(joint.parentPart) || !idSet.has(joint.childPart)) error(`joint ${joint.parentPart} -> ${joint.childPart}: unknown part`);
    if (joint.parentPart === joint.childPart) error(`joint ${joint.parentPart}: a part cannot join itself`);
    if (options.bones && !options.bones.has(joint.pivotBone)) error(`joint ${joint.parentPart} -> ${joint.childPart}: no bone '${joint.pivotBone}' in the rig`);
    for (const probe of joint.probeNames) if (!/ rotate -?[\d.]+$/.test(probe)) error(`joint ${joint.parentPart} -> ${joint.childPart}: probe '${probe}' is not '<bone> rotate <degrees>'`);
  }
  if (options.baseDir !== undefined) {
    const base = options.baseDir;
    const checkRef = (where: string, ref: FileRef, size?: { width: number; height: number }) => {
      const path = resolveRef(base, ref);
      if (!existsSync(path)) return error(`${where}: ${ref.path} is missing`);
      const actual = sha256File(path);
      if (actual !== ref.sha256) return error(`${where}: ${ref.path} sha256 ${actual.slice(0, 12)}... does not match the manifest's ${ref.sha256.slice(0, 12)}...`);
      if (size && path.toLowerCase().endsWith(".png")) {
        const image = readPng(path);
        if (image.width !== size.width || image.height !== size.height) error(`${where}: ${ref.path} is ${image.width}x${image.height}, not the source's ${size.width}x${size.height}`);
      }
    };
    const size = { width: m.source.width, height: m.source.height };
    checkRef("source", m.source);
    const src = resolveRef(base, m.source);
    if (existsSync(src)) {
      const image = readPng(src);
      if (image.width !== m.source.width || image.height !== m.source.height) error(`source: the PNG is ${image.width}x${image.height}, not ${m.source.width}x${m.source.height}`);
    }
    checkRef("rig", m.rig);
    for (const part of m.parts) {
      checkRef(`part ${part.id} image`, part.image, isIdentity(part.canvasFromLayer) ? size : undefined);
      checkRef(`part ${part.id} visibleMask`, part.visibleMask, size);
      checkRef(`part ${part.id} completionMask`, part.completionMask, size);
      checkRef(`part ${part.id} uncertainMask`, part.uncertainMask, size);
      checkRef(`part ${part.id} generationRecord`, part.generationRecord);
    }
    for (const joint of m.joints) checkRef(`joint ${joint.parentPart} -> ${joint.childPart} coverageMask`, joint.coverageMask, size);
    checkRef("acceptanceReport", m.acceptanceReport);
  }
  return { manifest: m, issues };
}

export function isIdentity(t: readonly number[]): boolean {
  return t.every((v, k) => Math.abs(v - (IDENTITY[k] as number)) < 1e-12);
}
