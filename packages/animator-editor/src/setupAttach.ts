/*
 * Atlas Animator editor: Setup mode attachments (pure; no DOM).
 *
 * Attach an image to a slot (an atlas region, or a PNG imported into the rig as a new atlas
 * page), move / rotate / scale a region attachment relative to its bone, and choose a slot's
 * default (setup) attachment. All plans are command batches (`slot.add`, `attachment.add`,
 * `attachment.set`, `slot.set`, `doc.set`), run with `runBatch`.
 */
import { fail, isObj, listOf, objOf, r4, slotNames, uniqueName, type Command, type JsonObject } from "./setupModel.js";

export interface AtlasRegion {
  path: string;
  width: number;
  height: number;
}

/** Every region of an `atlas-pack@1` manifest, sizes in canvas pixels (page pixels / scale). */
export function atlasRegions(manifest: unknown): AtlasRegion[] {
  const pack = manifest as { scale?: number; pages?: { regions?: Record<string, { width: number; height: number }> }[] };
  const scale = pack.scale && pack.scale > 0 ? pack.scale : 1;
  const out: AtlasRegion[] = [];
  for (const page of pack.pages ?? []) {
    for (const [path, r] of Object.entries(page.regions ?? {})) out.push({ path, width: Math.round(r.width / scale), height: Math.round(r.height / scale) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The atlas page file an imported image is stored in: `<rig>.imp-<name>.png`. */
export function importedPageFile(rigName: string, attachment: string): string {
  const safe = attachment.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${rigName.replace(/[^A-Za-z0-9_.-]/g, "_")}.imp-${safe}.png`;
}

/** The texture path of an imported image. */
export const importedPath = (skin: string, slot: string, attachment: string): string => `${skin}/${slot}__${attachment}`;

export interface AttachPlan {
  commands: Command[];
  slot: string;
  attachment: string;
  /** The texture path of the region, and the atlas page file when the image was imported. */
  path: string;
  page?: string;
}

export interface AttachOptions {
  skin: string;
  /** An existing slot, or null to make a new slot on `bone`. */
  slot: string | null;
  /** The bone of a new slot (the selected bone). */
  bone?: string;
  /** Attachment name; defaults to the last part of the texture path. */
  name?: string;
  /** The atlas texture path. Omit with `imported`: the path is derived from the slot and attachment names. */
  path?: string;
  width: number;
  height: number;
  /** An image imported from a PNG: stored as a new atlas page of the rig `rigName` and registered in `doc.atlas`. */
  imported?: { rigName: string };
  /** Make it the slot's default (setup) attachment. */
  setDefault: boolean;
}

const attachmentsOf = (raw: JsonObject, skin: string, slot: string): JsonObject => objOf(objOf(objOf(objOf(raw["skins"])[skin])["attachments"])[slot]);

export function planAttachImage(raw: JsonObject, o: AttachOptions): AttachPlan {
  const base = (o.name ?? (o.path ?? "image").split("/").pop()!.split("__").pop()!).replace(/[^A-Za-z0-9_.-]/g, "_") || "image";
  const commands: Command[] = [];
  let slot = o.slot;
  if (slot === null) {
    if (!o.bone) fail("select a bone for the new slot");
    slot = uniqueName(slotNames(raw), base);
    commands.push({ op: "slot.add", name: slot, bone: o.bone });
  } else if (!slotNames(raw).includes(slot)) fail(`no slot '${slot}'`);
  const existing = Object.keys(attachmentsOf(raw, o.skin, slot));
  const name = uniqueName(existing, base);
  if (!(o.width > 0 && o.height > 0)) fail("the image has no size");
  const path = o.path ?? (o.imported ? importedPath(o.skin, slot, name) : fail("give the atlas path of the image"));
  const page = o.imported ? importedPageFile(o.imported.rigName, name) : undefined;
  if (page) {
    const atlas = objOf(raw["atlas"]);
    const pages = Array.isArray(atlas["pages"]) ? (atlas["pages"] as string[]) : [];
    if (!pages.includes(page)) commands.push({ op: "doc.set", atlas: { pages: [...pages, page], scale: Number(atlas["scale"] ?? 1) } });
  }
  commands.push({ op: "attachment.add", skin: o.skin, slot, name, attachment: { type: "region", path, width: o.width, height: o.height } });
  if (o.setDefault) commands.push({ op: "slot.set", name: slot, attachment: name });
  return { commands, slot, attachment: name, path, ...(page ? { page } : {}) };
}

export interface RegionTransform {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

/** Moves, rotates and scales a region attachment relative to its bone. */
export function planAttachmentTransform(raw: JsonObject, a: { skin: string; slot: string; name: string }, t: RegionTransform): Command[] {
  const att = attachmentsOf(raw, a.skin, a.slot)[a.name];
  if (!isObj(att)) return fail(`no attachment '${a.name}' on slot '${a.slot}'`);
  if (att["type"] !== "region" && att["type"] !== "point") return fail(`'${a.name}' is a ${String(att["type"])}; only region images and points are moved here`);
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) if (typeof v === "number" && Number.isFinite(v)) fields[k] = r4(v);
  if (att["type"] === "point" && ("scaleX" in fields || "scaleY" in fields)) fail("a point has no scale: move and turn it");
  if ((fields["scaleX"] ?? 1) === 0 || (fields["scaleY"] ?? 1) === 0) fail("scale cannot be zero");
  return [{ op: "attachment.set", ...a, fields }];
}

export type PointPreset = "point" | "grip" | "tip";

export interface PointPlan {
  commands: Command[];
  attachment: string;
}

/**
 * A point attachment on a slot's bone (weapon grip, tool tip, FX socket): a named position and direction that nothing draws. `grip` and
 * `tip` are the weapon presets: the point starts on the slot's image (its centre) and is named for its job so the project and swag can find it;
 * drag it with the Image tool. It never becomes the slot's setup image.
 */
export function planAddPoint(raw: JsonObject, o: { skin: string; slot: string; preset?: PointPreset; name?: string; x?: number; y?: number; rotation?: number }): PointPlan {
  if (!slotNames(raw).includes(o.slot)) fail(`no slot '${o.slot}'`);
  const here = attachmentsOf(raw, o.skin, o.slot);
  const preset = o.preset ?? "point";
  const name = uniqueName(Object.keys(here), o.name ?? preset);
  const s = listOf(raw["slots"]).find((x) => x["name"] === o.slot)!;
  const cur = typeof s["attachment"] === "string" ? here[s["attachment"]] : undefined;
  const base = isObj(cur) && cur["type"] === "region" ? { x: Number(cur["x"] ?? 0), y: Number(cur["y"] ?? 0), rotation: Number(cur["rotation"] ?? 0) } : { x: 0, y: 0, rotation: 0 };
  const x = r4(o.x ?? (preset === "point" ? 0 : base.x));
  const y = r4(o.y ?? (preset === "point" ? 0 : base.y));
  const rotation = r4(o.rotation ?? (preset === "point" ? 0 : base.rotation));
  return { commands: [{ op: "attachment.add", skin: o.skin, slot: o.slot, name, attachment: { type: "point", x, y, rotation } }], attachment: name };
}

/** Sets the slot's default (setup) attachment; null shows nothing. */
export function planDefaultAttachment(raw: JsonObject, slot: string, name: string | null): Command[] {
  const s = listOf(raw["slots"]).find((x) => x["name"] === slot);
  if (!s) return fail(`no slot '${slot}'`);
  return [{ op: "slot.set", name: slot, attachment: name }];
}

export function planRemoveAttachment(raw: JsonObject, a: { skin: string; slot: string; name: string }): Command[] {
  const s = listOf(raw["slots"]).find((x) => x["name"] === a.slot);
  if (!s) return fail(`no slot '${a.slot}'`);
  return [...(s["attachment"] === a.name ? [{ op: "slot.set", name: a.slot, attachment: null } as Command] : []), { op: "attachment.remove", ...a }];
}

/** The active attachment of a slot in a skin (its default), when it is a region. */
export function defaultRegion(raw: JsonObject, skin: string, slot: string): { name: string; att: JsonObject } | null {
  const s = listOf(raw["slots"]).find((x) => x["name"] === slot);
  const name = s && typeof s["attachment"] === "string" ? s["attachment"] : null;
  if (!name) return null;
  const att = attachmentsOf(raw, skin, slot)[name];
  return isObj(att) && att["type"] === "region" ? { name, att } : null;
}

/** A crease / generated variant of an image (`body/skin_arm_far__c020`, `..__g0004`): hidden from the picker until asked for. */
export const isVariantPath = (path: string): boolean => /__[cg]\d+$/.test(path);

export interface RegionGroup {
  family: string;
  items: AtlasRegion[];
}

/** The picker's rows: filtered by a case-insensitive query, variants hidden unless `showVariants`, grouped by folder (slot family), capped at `limit` rows. */
export function groupRegions(regions: readonly AtlasRegion[], query: string, showVariants: boolean, limit = 300): { groups: RegionGroup[]; shown: number; matched: number; hiddenVariants: number } {
  const q = query.trim().toLowerCase();
  const byFamily = new Map<string, AtlasRegion[]>();
  let matched = 0;
  let hiddenVariants = 0;
  let shown = 0;
  for (const r of regions) {
    if (q && !r.path.toLowerCase().includes(q)) continue;
    if (!showVariants && isVariantPath(r.path)) {
      hiddenVariants++;
      continue;
    }
    matched++;
    if (shown >= limit) continue;
    shown++;
    const slash = r.path.indexOf("/");
    const family = slash > 0 ? r.path.slice(0, slash) : "(root)";
    const list = byFamily.get(family);
    if (list) list.push(r);
    else byFamily.set(family, [r]);
  }
  return { groups: [...byFamily].map(([family, items]) => ({ family, items })), shown, matched, hiddenVariants };
}
