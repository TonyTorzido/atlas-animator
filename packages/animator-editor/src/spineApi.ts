/*
 * Atlas Animator editor: Spine import and export for the dev server (Node; used by vite.config.ts).
 *
 * - importSpineIntoRig: runs the engine's `import-spine --merge` (meshes, weights, linked meshes, deform) and `import-spine-clips`
 *   (clips) against a rig document under `rigsRoot` (the sandbox copy when ATLAS_EDITOR_DATA_DIR is set). A pre-import copy of the
 *   document is kept so the editor's "Revert import" button can put it back (the importers' own .bak files are folded into that copy).
 * - revertSpineImport: restores that copy.
 * - exportSpineFull: runs the engine's exporter (`export-spine`) so the file carries deform timelines and linked meshes.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { exportSpine } from "../../animator/src/cli/exportSpine.js";
import { importSpineClips } from "../../animator/src/cli/importSpine.js";
import { importSpineMeshes } from "../../animator/src/cli/importSpineMeshes.js";
import { SKIN_RIG_PATH } from "./exportApi.js";
import { rigAbs, rigsDirOf, type RigRoot } from "./rigSave.js";

export class SpineApiError extends Error {}

export interface SpineImportSummary {
  file: string;
  dryRun: boolean;
  /** Id for the revert call (null on a dry run). */
  backup: string | null;
  meshes: string[];
  linked: string[];
  deform: string[];
  /** Clipping masks, hit boxes and image sequences read from the file. */
  extras: string[];
  clips: { name: string; replaced: boolean; duration: number; bones: number; ik: number; transform: number; events: number }[];
  warnings: string[];
  /** The merged rig document text (what the editor reloads). */
  text: string;
}

const BACKUP_ID = /^[A-Za-z0-9_.-]+\.anim\.json\.pre-import-\d+$/;

function docOf(rigsRoot: RigRoot, file: string): string {
  if (typeof file !== "string" || !SKIN_RIG_PATH.test(file)) throw new SpineApiError("expected { file: packages/animator/rigs/<dir>/<name>.anim.json }");
  const path = rigAbs(rigsRoot, file);
  if (!path.startsWith(rigsDirOf(rigsRoot) + sep) || !existsSync(path)) throw new SpineApiError(`no rig document ${file}`);
  return path;
}

export function importSpineIntoRig(rigsRoot: RigRoot, file: string, spineText: string, dryRun = false): SpineImportSummary {
  const doc = docOf(rigsRoot, file);
  let spine: unknown;
  try {
    spine = JSON.parse(spineText);
  } catch {
    throw new SpineApiError("that file is not valid JSON");
  }
  const version = (spine as { skeleton?: { spine?: string } } | null)?.skeleton?.spine;
  if (typeof version !== "string" || !/^4\.[0-9]/.test(version)) throw new SpineApiError(`expected a Spine 4.x skeleton JSON (found ${typeof version === "string" ? version : "no skeleton.spine version"})`);
  const temp = mkdtempSync(resolve(tmpdir(), "atlas-spine-import-"));
  try {
    const spinePath = resolve(temp, "in.spine.json");
    writeFileSync(spinePath, spineText);
    const backupId = dryRun ? null : `${basename(doc)}.pre-import-${Date.now()}`;
    if (backupId) copyFileSync(doc, resolve(dirname(doc), backupId));
    const meshes = importSpineMeshes({ spine: spinePath, merge: doc, dryRun });
    const clips = importSpineClips({ spine: spinePath, rig: doc, dryRun });
    for (const own of [meshes.backup, clips.backup]) if (own && existsSync(own)) unlinkSync(own);
    return {
      file,
      dryRun,
      backup: backupId,
      meshes: meshes.meshes,
      linked: meshes.linked,
      deform: meshes.deform,
      extras: meshes.extras,
      clips: clips.clips,
      warnings: [...new Set([...meshes.warnings, ...clips.warnings])],
      text: readFileSync(doc, "utf8")
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function revertSpineImport(rigsRoot: RigRoot, file: string, backup: string): { text: string } {
  const doc = docOf(rigsRoot, file);
  if (typeof backup !== "string" || !BACKUP_ID.test(backup) || !backup.startsWith(`${basename(doc)}.pre-import-`)) throw new SpineApiError("unknown import backup");
  const saved = resolve(dirname(doc), backup);
  if (!existsSync(saved)) throw new SpineApiError("that import backup is gone");
  copyFileSync(saved, doc);
  unlinkSync(saved);
  return { text: readFileSync(doc, "utf8") };
}

export interface SpineExportSummary {
  json: string;
  atlas: string | null;
  images: number;
  clips: string[];
  warnings: string[];
  deformTimelines: number;
  linkedMeshes: number;
}

export function exportSpineFull(rigsRoot: RigRoot, file: string, outDir: string): SpineExportSummary {
  const doc = docOf(rigsRoot, file);
  mkdirSync(outDir, { recursive: true });
  const result = exportSpine({ document: doc, outDir });
  const spine = JSON.parse(readFileSync(result.json, "utf8")) as { skins?: { attachments?: Record<string, Record<string, { type?: string }>> }[]; animations?: Record<string, { attachments?: Record<string, Record<string, Record<string, { deform?: unknown }>>> }> };
  let linkedMeshes = 0;
  for (const skin of spine.skins ?? []) for (const slot of Object.values(skin.attachments ?? {})) for (const a of Object.values(slot)) if (a.type === "linkedmesh") linkedMeshes++;
  let deformTimelines = 0;
  for (const clip of Object.values(spine.animations ?? {})) for (const skin of Object.values(clip.attachments ?? {})) for (const slot of Object.values(skin)) for (const a of Object.values(slot)) if (a.deform) deformTimelines++;
  return { json: result.json, atlas: result.atlas, images: result.images, clips: result.clips, warnings: result.warnings, deformTimelines, linkedMeshes };
}
