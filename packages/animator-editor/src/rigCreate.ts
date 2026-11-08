/*
 * Atlas Animator editor: creating rigs and adding parts to them (Node; used by the dev server).
 *
 * A new rig is a folder `packages/animator/rigs/<id>/` with `<id>.anim.json`, `<id>.atlas.json`, the atlas pages and a `rig.meta.json`
 * marker. The marker is how the editor discovers editor-made rigs (listRigs), so the hand-built rigs in fixtures.ts are never listed twice.
 * Parts arrive as PNG data URLs with an offset (top-left, root-relative, y down); each becomes a slot on the root bone plus a region
 * attachment, in the order given (first = back, last = front), and is packed into the rig's atlas with the engine's packer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeAtomic } from "./safeFs.js";
import { resolve, sep } from "node:path";
import { atlasPackSchema } from "../../animator/src/core/atlasPack.js";
import { decodePng, writePng } from "../../animator/src/tools/png.js";
import { createImage } from "../../animator/src/tools/image.js";
import { packAtlas } from "../../animator/src/tools/atlasPacker.js";
import { SaveError, RIGS_DIR, rigAbs, rigsDirOf, type RigRoot } from "./rigSave.js";

import { RESERVED_RIG_IDS, RIG_ID, partName, rigIdProblem, type CanvasSpec } from "./newRigModel.js";
import { applyContractCommands, planSeedPlayer } from "./rigContract.js";
export { RESERVED_RIG_IDS, RIG_ID, partName, rigIdProblem };
export const SKIN = "default";
// The kit-body-cutout skeleton: near / far bones, IK and the standard names the swag contract (rigContract.ts) binds to.
const TEMPLATE_DOC = `${RIGS_DIR}/kit-body-cutout/kit-body-cutout.anim.json`;
const LEGACY_TEMPLATE_DOC = `${RIGS_DIR}/player/front-turn15-faceA.anim.json`;
const META = "rig.meta.json";

export type RigTemplate = "blank" | "player";

export interface PartIn {
  name: string;
  /** `data:image/png;base64,...` */
  png: string;
  /** Top-left of the image, root-relative, y down (skeleton pixels). */
  x: number;
  y: number;
}

export interface CreateRequest {
  id: string;
  label?: string;
  template: RigTemplate;
  parts?: PartIn[];
  /** Canvas of a blank rig (a PSD import sets the PSD's size and ground point). */
  canvas?: CanvasSpec;
}

export interface RigEntry {
  id: string;
  label: string;
  document: string;
  atlas: string;
  template: RigTemplate;
}

type Json = Record<string, unknown>;

function folderOf(rigsRoot: RigRoot, id: string): string {
  const folder = resolve(rigsDirOf(rigsRoot), id);
  if (!folder.startsWith(rigsDirOf(rigsRoot) + sep)) throw new SaveError("bad rig id");
  return folder;
}

const rel = (id: string, file: string) => `${RIGS_DIR}/${id}/${file}`;

export function listRigs(rigsRoot: RigRoot): RigEntry[] {
  const dir = rigsDirOf(rigsRoot);
  if (!existsSync(dir)) return [];
  const out: RigEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const metaPath = resolve(dir, name, META);
    if (!existsSync(metaPath) || !existsSync(resolve(dir, name, `${name}.anim.json`))) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Json;
      out.push({ id: name, label: String(meta["label"] ?? name), document: rel(name, `${name}.anim.json`), atlas: rel(name, `${name}.atlas.json`), template: meta["template"] === "player" ? "player" : "blank" });
    } catch {
      // an unreadable marker is skipped, not fatal
    }
  }
  return out;
}

const writeJson = (path: string, v: unknown): void => writeAtomic(path, `${JSON.stringify(v, null, 1)}\n`);

function uniqueName(taken: Set<string>, base: string): string {
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  taken.add(n);
  return n;
}

/** Adds parts to an existing editor-made rig: slots on the root bone, region attachments, one new atlas bundle. Returns the new slot names. */
export function addParts(rigsRoot: RigRoot, id: string, parts: PartIn[], opts: { replace?: boolean } = {}): { slots: string[]; replaced: string[] } {
  const folder = folderOf(rigsRoot, id);
  const docPath = resolve(folder, `${id}.anim.json`);
  const manifestPath = resolve(folder, `${id}.atlas.json`);
  if (!existsSync(resolve(folder, META)) || !existsSync(docPath)) throw new SaveError(`no editor-made rig '${id}'`, 404);
  if (!Array.isArray(parts) || !parts.length) throw new SaveError("no parts to add");
  const doc = JSON.parse(readFileSync(docPath, "utf8")) as Json;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { format: string; scale: number; pages: { file: string; width: number; height: number; regions: Record<string, unknown> }[] };
  manifest.pages = manifest.pages.filter((p) => Object.keys(p.regions).length > 0);
  const bones = doc["bones"] as Json[];
  const root = bones.find((b) => b["parent"] === undefined) ?? bones[0]!;
  const rx = Number(root["x"] ?? 0);
  const ry = Number(root["y"] ?? 0);
  const slots = doc["slots"] as Json[];
  const skins = doc["skins"] as Record<string, { attachments: Record<string, Record<string, Json>> }>;
  const skin = (skins[SKIN] ??= { attachments: {} });
  const taken = new Set(slots.map((s) => String(s["name"])));
  const existing = new Set(taken);
  const tag = `p${manifest.pages.length}`;
  const items: { path: string; image: ReturnType<typeof decodePng> }[] = [];
  const planned: { slot: string; path: string; x: number; y: number; width: number; height: number; replace: boolean }[] = [];
  for (const part of parts) {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(part.png));
    if (!m) throw new SaveError(`part '${part.name}' is not a PNG data URL`);
    const image = decodePng(Buffer.from(m[1]!, "base64"));
    // Replace: a part whose slot already exists swaps that slot's image (under a fresh atlas name); otherwise it becomes a new, uniquely named slot.
    const same = !!opts.replace && existing.has(partName(part.name)) && !planned.some((q) => q.slot === partName(part.name));
    const slot = same ? partName(part.name) : uniqueName(taken, partName(part.name));
    const path = same ? `${id}/${slot}.${tag}` : `${id}/${slot}`;
    items.push({ path, image });
    planned.push({ slot, path, replace: same, x: Number(part.x) + image.width / 2 - rx, y: Number(part.y) + image.height / 2 - ry, width: image.width, height: image.height });
  }
  const packed = packAtlas(items, { name: `${id}.${tag}`, scale: 1, pageSize: 2048, padding: 2 });
  for (const page of packed.pages) writePng(resolve(folder, page.file), page.image);
  manifest.pages.push(...(packed.pack.pages as typeof manifest.pages));
  for (const p of planned) {
    const old = p.replace ? slots.find((q) => q["name"] === p.slot) : undefined;
    const attName = p.replace ? String(old?.["attachment"] ?? p.slot) : p.slot;
    if (!p.replace) slots.push({ name: p.slot, bone: String(root["name"]), attachment: p.slot });
    else if (old) old["attachment"] = attName;
    (skin.attachments[p.slot] ??= {})[attName] = { type: "region", path: p.path, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, width: p.width, height: p.height };
  }
  doc["atlas"] = { pages: manifest.pages.map((p) => p.file), scale: 1 };
  writeJson(manifestPath, atlasPackSchema.parse(manifest));
  writeJson(docPath, doc);
  return { slots: planned.filter((p) => !p.replace).map((p) => p.slot), replaced: planned.filter((p) => p.replace).map((p) => p.slot) };
}

/** Changes the display name of an editor-made rig (the folder and id stay, so clips and references keep working). */
export function renameRig(rigsRoot: RigRoot, id: string, label: string): RigEntry {
  const folder = folderOf(rigsRoot, id);
  const metaPath = resolve(folder, META);
  if (!existsSync(metaPath) || !existsSync(resolve(folder, `${id}.anim.json`))) throw new SaveError(`'${id}' is not an editor-made rig: only rigs made with New rig can be renamed`, 403);
  const name = String(label ?? "").trim().slice(0, 60);
  if (!name) throw new SaveError("a rig needs a name");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Json;
  meta["label"] = name;
  writeJson(metaPath, meta);
  const entry = listRigs(rigsRoot).find((r) => r.id === id);
  if (!entry) throw new SaveError("rig vanished", 500);
  return entry;
}

/** Deletes an editor-made rig folder. `beforeDelete` runs first (the server snapshots the rig document into history there). Built-in rigs have no marker and are refused. */
export function deleteRig(rigsRoot: RigRoot, id: string, beforeDelete?: (docPath: string) => void): void {
  const folder = folderOf(rigsRoot, id);
  if (!existsSync(resolve(folder, META)) || !existsSync(resolve(folder, `${id}.anim.json`))) throw new SaveError(`'${id}' is a built-in rig (or not found): it cannot be deleted`, 403);
  beforeDelete?.(resolve(folder, `${id}.anim.json`));
  rmSync(folder, { recursive: true, force: true });
}

/** templateRoot: where the player template rig is read from (default: the same root; the user layer passes the stock repo). */
export function createRig(rigsRoot: RigRoot, req: CreateRequest, templateRoot: RigRoot = rigsRoot): RigEntry {
  const id = String(req.id ?? "");
  const problem = rigIdProblem(id);
  if (problem) throw new SaveError(problem);
  const folder = folderOf(rigsRoot, id);
  if (existsSync(folder)) throw new SaveError(`a rig folder '${id}' already exists`, 409);
  let doc: Json;
  if (req.template === "player") {
    const found = [TEMPLATE_DOC, LEGACY_TEMPLATE_DOC].flatMap((t) => [rigAbs(rigsRoot, t), rigAbs(templateRoot, t)]).find((p) => existsSync(p));
    const src = found ?? rigAbs(templateRoot, TEMPLATE_DOC);
    if (!found) throw new SaveError("the player template rig is missing", 500);
    doc = JSON.parse(readFileSync(src, "utf8")) as Json;
    // Bones, IK, limits, contact bands and standard bone names stay; art, clips and anything that points at art go.
    for (const k of ["slots", "skins", "animations", "driven", "drivenGrids", "atlas"]) delete doc[k];
    // Contract slots (empty) and the weapon grip / tip points, so the rig is wearable from the first minute.
    doc["slots"] = [];
    doc["skins"] = { [SKIN]: { attachments: {} } };
    doc["animations"] = {};
    doc["atlas"] = { pages: [`${id}.empty.png`], scale: 1 };
    doc = applyContractCommands(doc as never, planSeedPlayer(doc as never)) as Json;
  } else {
    doc = { format: "atlas-anim@1", canvas: req.canvas ?? { width: 1086, height: 1448, originX: 542, originY: 960 }, bones: [{ name: "root", x: 0, y: 0 }] };
  }
  doc["name"] = id;
  doc["slots"] ??= [];
  doc["skins"] ??= { [SKIN]: { attachments: {} } };
  doc["animations"] = {};
  doc["atlas"] = { pages: [`${id}.empty.png`], scale: 1 };
  mkdirSync(folder, { recursive: true });
  writeJson(resolve(folder, `${id}.anim.json`), doc);
  const blank = createImage(1, 1);
  writePng(resolve(folder, `${id}.empty.png`), blank);
  writeJson(resolve(folder, `${id}.atlas.json`), { format: "atlas-pack@1", scale: 1, pages: [{ file: `${id}.empty.png`, width: 1, height: 1, regions: {} }] });
  const label = (req.label ?? id).trim() || id;
  writeJson(resolve(folder, META), { id, label, template: req.template, created: new Date().toISOString() });
  if (req.parts?.length) addParts(rigsRoot, id, req.parts);
  return { id, label, document: rel(id, `${id}.anim.json`), atlas: rel(id, `${id}.atlas.json`), template: req.template };
}
