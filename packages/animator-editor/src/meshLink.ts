/*
 * Atlas Animator editor: linked meshes (pure; no DOM). Batch 7b, .
 *
 * A linked mesh shares the vertices, triangles, UVs and weights of a source mesh but draws its own picture; with `inheritDeform` the
 * source's deform keys move it too. These are the plans (command batches) to link an image to a mesh, unlink it again (the geometry is
 * copied back, nothing is lost), and flip the deform inheritance, plus the lookups the inspector shows (candidates, dependants).
 */
import { fail, isObj, objOf, type Command, type JsonObject } from "./setupModel.js";

export interface AttAddress {
  skin: string;
  slot: string;
  name: string;
}

const attachmentAt = (raw: JsonObject, a: AttAddress): JsonObject | null => {
  const found = objOf(objOf(objOf(objOf(raw["skins"])[a.skin])["attachments"])[a.slot])[a.name];
  return isObj(found) ? found : null;
};

const same = (a: AttAddress, b: AttAddress): boolean => a.skin === b.skin && a.slot === b.slot && a.name === b.name;
const label = (a: AttAddress): string => `${a.skin}/${a.slot}/${a.name}`;

/** Every attachment in the rig, with its address. */
function everyAttachment(raw: JsonObject): { address: AttAddress; att: JsonObject }[] {
  const out: { address: AttAddress; att: JsonObject }[] = [];
  for (const [skin, data] of Object.entries(objOf(raw["skins"]))) {
    for (const [slot, atts] of Object.entries(objOf(objOf(data)["attachments"]))) {
      for (const [name, att] of Object.entries(objOf(atts))) if (isObj(att)) out.push({ address: { skin, slot, name }, att });
    }
  }
  return out;
}

/** The attachments that are linked meshes of `source`. */
export function linkedDependants(raw: JsonObject, source: AttAddress): AttAddress[] {
  return everyAttachment(raw)
    .filter(({ att }) => att["type"] === "linkedMesh" && isObj(att["source"]) && att["source"]["skin"] === source.skin && att["source"]["slot"] === source.slot && att["source"]["attachment"] === source.name)
    .map((x) => x.address);
}

/** The meshes `target` could link to: plain meshes (not linked ones), never itself. */
export function linkCandidates(raw: JsonObject, target: AttAddress): AttAddress[] {
  return everyAttachment(raw)
    .filter(({ address, att }) => att["type"] === "mesh" && !same(address, target))
    .map((x) => x.address);
}

/** The source address of a linked mesh, or null. */
export function linkSourceOf(raw: JsonObject, target: AttAddress): AttAddress | null {
  const att = attachmentAt(raw, target);
  if (!att || att["type"] !== "linkedMesh" || !isObj(att["source"])) return null;
  return { skin: String(att["source"]["skin"]), slot: String(att["source"]["slot"]), name: String(att["source"]["attachment"]) };
}

/**
 * Links an image to a source mesh: the attachment becomes a linked mesh (its own picture and size, the source's shape and weights).
 * A mesh that other images link to cannot itself become a link (the chain would be two deep), so it refuses and names them.
 */
export function planLinkMesh(raw: JsonObject, target: AttAddress, source: AttAddress, o: { inheritDeform?: boolean } = {}): Command[] {
  const att = attachmentAt(raw, target);
  if (!att) return fail(`no attachment ${label(target)}`);
  if (att["type"] === "point") return fail("a point has no picture to link");
  if (same(target, source)) return fail("an image cannot link to itself");
  const src = attachmentAt(raw, source);
  if (!src) return fail(`no attachment ${label(source)}`);
  if (src["type"] !== "mesh") return fail(`${label(source)} is ${src["type"] === "linkedMesh" ? "itself a linked mesh" : "not a mesh"}; link to the mesh it shares from`);
  const kids = linkedDependants(raw, target);
  if (kids.length) return fail(`${kids.length} image${kids.length === 1 ? "" : "s"} link to ${target.name} (${kids.map((k) => k.name).join(", ")}); unlink ${kids.length === 1 ? "it" : "them"} first`);
  const width = Number(att["width"] ?? src["width"] ?? 0);
  const height = Number(att["height"] ?? src["height"] ?? 0);
  if (!(width > 0 && height > 0)) return fail(`${target.name} has no picture size`);
  const linked: JsonObject = {
    type: "linkedMesh",
    path: String(att["path"] ?? target.name),
    source: { skin: source.skin, slot: source.slot, attachment: source.name },
    inheritDeform: o.inheritDeform ?? (att["type"] === "linkedMesh" ? att["inheritDeform"] !== false : true),
    width,
    height,
    ...(att["color"] !== undefined ? { color: att["color"] } : {})
  };
  return [{ op: "attachment.add", ...target, attachment: linked } as unknown as Command];
}

/** Unlinks: the source's shape and weights are copied into this image as its own mesh, so it looks exactly the same. */
export function planUnlinkMesh(raw: JsonObject, target: AttAddress): Command[] {
  const att = attachmentAt(raw, target);
  if (!att || att["type"] !== "linkedMesh") return fail(`${label(target)} is not a linked mesh`);
  const from = linkSourceOf(raw, target)!;
  const src = attachmentAt(raw, from);
  if (!src || src["type"] !== "mesh") return fail(`the source ${label(from)} is gone, so there is no shape to copy`);
  const own: JsonObject = structuredClone(src);
  own["path"] = att["path"] as never;
  own["width"] = att["width"] as never;
  own["height"] = att["height"] as never;
  if (att["color"] !== undefined) own["color"] = att["color"] as never;
  delete own["groups"];
  delete own["embed"];
  return [{ op: "attachment.add", ...target, attachment: own } as unknown as Command];
}

/** Whether the source's deform keys also move this linked mesh. */
export function planSetInherit(raw: JsonObject, target: AttAddress, inherit: boolean): Command[] {
  const att = attachmentAt(raw, target);
  if (!att || att["type"] !== "linkedMesh") return fail(`${label(target)} is not a linked mesh`);
  return [{ op: "attachment.set", ...target, fields: { inheritDeform: inherit } } as unknown as Command];
}
