/*
 * Atlas Animator editor: relink / reload source art (pure; no DOM). Batch 7b-2,  / .
 *
 * Replacing an image's picture keeps everything the rig built on it: a mesh keeps its vertices, triangles, weights and every deform or
 * driven key (they are addressed by vertex, not by pixel), a region keeps its place. Only the picture reference and size change, and the
 * UVs are remapped when the picture's size changes:
 *   - "stretch": the new picture is laid over the same mesh (UVs unchanged, so the art fills the same shape whatever its size);
 *   - "keep-scale": the new picture keeps the old pixel scale, centred (the old canvas sits in the middle of the new one; a smaller
 *     picture crops, UVs clamp to 0..1), for a repaint on a bigger or smaller canvas.
 */
import { importedPageFile, importedPath } from "./setupAttach.js";
import { fail, isObj, objOf, type Command, type JsonObject } from "./setupModel.js";

export type RelinkMode = "stretch" | "keep-scale";

export interface RelinkTarget {
  skin: string;
  slot: string;
  name: string;
}

export interface Size {
  width: number;
  height: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5 + 0;

/** UVs for a picture that went from `from` to `to`, per mode. */
export function remapUvs(uvs: readonly number[], from: Size, to: Size, mode: RelinkMode): number[] {
  if (mode === "stretch" || (from.width === to.width && from.height === to.height)) return [...uvs];
  const offX = (to.width - from.width) / 2;
  const offY = (to.height - from.height) / 2;
  const out: number[] = [];
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    out.push(r5(clamp01((uvs[i]! * from.width + offX) / to.width)), r5(clamp01((uvs[i + 1]! * from.height + offY) / to.height)));
  }
  return out;
}

const attOf = (raw: JsonObject, t: RelinkTarget): JsonObject | null => {
  const found = objOf(objOf(objOf(objOf(raw["skins"])[t.skin])["attachments"])[t.slot])[t.name];
  return isObj(found) ? found : null;
};

/** What a relink would change, for the confirm dialog (null when the attachment cannot be relinked). */
export interface RelinkPreview {
  type: string;
  from: Size;
  to: Size;
  sizeChanged: boolean;
  keeps: string[];
  uvsRemapped: boolean;
}

export function previewRelink(raw: JsonObject, t: RelinkTarget, to: Size, mode: RelinkMode): RelinkPreview | null {
  const att = attOf(raw, t);
  if (!att || !["region", "mesh", "linkedMesh"].includes(String(att["type"]))) return null;
  const from = { width: Number(att["width"]), height: Number(att["height"]) };
  const sizeChanged = from.width !== to.width || from.height !== to.height;
  const type = String(att["type"]);
  const keeps = type === "mesh" ? ["mesh shape", ...(Array.isArray(att["bones"]) ? ["weights"] : []), "deform and corrective keys"] : type === "linkedMesh" ? ["link to its source mesh"] : ["position and scale"];
  return { type, from, to, sizeChanged, keeps, uvsRemapped: type === "mesh" && sizeChanged && mode === "keep-scale" };
}

export interface RelinkOptions {
  /** The new picture's texture path and size. */
  path: string;
  width: number;
  height: number;
  mode: RelinkMode;
  /** An imported page file to register in the atlas (omit when the path is already in it). */
  page?: string;
}

/** A page file and texture path for a replacement picture that collide with nothing in the rig (so Undo can bring the old art back). */
export function freshArtName(raw: JsonObject, t: RelinkTarget, rigName: string): { name: string; page: string; path: string } {
  const pages = new Set(Array.isArray(objOf(raw["atlas"])["pages"]) ? (objOf(raw["atlas"])["pages"] as string[]) : []);
  const paths = new Set<string>();
  for (const skin of Object.values(objOf(raw["skins"]))) for (const slot of Object.values(objOf(objOf(skin)["attachments"]))) for (const a of Object.values(objOf(slot))) if (isObj(a) && typeof a["path"] === "string") paths.add(a["path"]);
  const base = t.name.replace(/_r\d+$/, "");
  for (let n = 1; ; n++) {
    const name = `${base}_r${n}`;
    const page = importedPageFile(rigName, name);
    const path = importedPath(t.skin, t.slot, name);
    if (!pages.has(page) && !paths.has(path)) return { name, page, path };
  }
}

/** The commands that swap the picture of a region, mesh or linked mesh, keeping its rigging. */
export function planRelink(raw: JsonObject, t: RelinkTarget, o: RelinkOptions): Command[] {
  const att = attOf(raw, t);
  if (!att) return fail(`There is no image '${t.name}' on slot '${t.slot}'`);
  const type = String(att["type"]);
  if (!["region", "mesh", "linkedMesh"].includes(type)) return fail(`'${t.name}' is a ${type}; only images and meshes have a picture to replace`);
  if (!(o.width > 0 && o.height > 0)) return fail("The new image has no size");
  const from = { width: Number(att["width"]), height: Number(att["height"]) };
  const to = { width: o.width, height: o.height };
  const fields: Record<string, unknown> = { path: o.path, width: o.width, height: o.height };
  if (type === "mesh" && Array.isArray(att["uvs"])) fields["uvs"] = remapUvs(att["uvs"] as number[], from, to, o.mode);
  if (type === "region" && o.mode === "stretch" && (from.width !== to.width || from.height !== to.height)) {
    // The region draws width x height pixels times its scale: keep what the artist sees by scaling the other way.
    fields["scaleX"] = r5(Number(att["scaleX"] ?? 1) * (from.width / to.width));
    fields["scaleY"] = r5(Number(att["scaleY"] ?? 1) * (from.height / to.height));
  }
  const commands: Command[] = [];
  if (o.page) {
    const atlas = objOf(raw["atlas"]);
    const pages = Array.isArray(atlas["pages"]) ? (atlas["pages"] as string[]) : [];
    if (!pages.includes(o.page)) commands.push({ op: "doc.set", atlas: { pages: [...pages, o.page], scale: Number(atlas["scale"] ?? 1) } } as Command);
  }
  commands.push({ op: "attachment.set", ...t, fields } as Command);
  return commands;
}
