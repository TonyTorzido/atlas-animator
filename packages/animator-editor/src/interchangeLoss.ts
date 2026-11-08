/*
 * Atlas Animator editor: Spine interchange loss report (pure; no DOM). Batch 7b-2, .
 *
 * Spine import and export are not lossless. These build the lists the confirm dialog shows BEFORE anything is written: what comes across,
 * what is dropped and what is approximated. Export reads the rig document; import reads the Spine file (and the dry-run summary).
 */
import { isObj, listOf, objOf, type JsonObject } from "./setupModel.js";

export interface LossReport {
  kept: string[];
  dropped: string[];
  approximated: string[];
}

const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** The dialog lines for a report: each prefixed so the three groups read apart. */
export function lossLines(r: LossReport): string[] {
  return [...r.kept.map((l) => `Comes across: ${l}`), ...r.approximated.map((l) => `Approximated: ${l}`), ...r.dropped.map((l) => `Dropped: ${l}`)];
}

/** Every attachment of the rig, with its skin and slot. */
function attachments(raw: JsonObject): { skin: string; slot: string; name: string; att: JsonObject }[] {
  const out: { skin: string; slot: string; name: string; att: JsonObject }[] = [];
  for (const [skin, data] of Object.entries(objOf(raw["skins"]))) {
    for (const [slot, atts] of Object.entries(objOf(objOf(data)["attachments"]))) for (const [name, att] of Object.entries(objOf(atts))) if (isObj(att)) out.push({ skin, slot, name, att });
  }
  return out;
}

/** What exporting this rig to Spine loses, from the rig document alone. */
export function spineExportLoss(raw: JsonObject): LossReport {
  const all = attachments(raw);
  const meshes = all.filter((a) => a.att["type"] === "mesh").length;
  const linked = all.filter((a) => a.att["type"] === "linkedMesh");
  const clips = Object.keys(objOf(raw["animations"])).filter((c) => c !== "review");
  const kept = [`${n(listOf(raw["bones"]).length, "bone")}, ${n(listOf(raw["slots"]).length, "slot")}, ${n(meshes, "weighted or plain mesh", "weighted or plain meshes")}, ${n(linked.length, "linked mesh", "linked meshes")} (native Spine linked meshes: source, slot, skin and deform inheritance) and ${n(all.filter((a) => a.att["type"] === "point").length, "point")}`, `${n(clips.length, "clip")} (IK, transform, deform, events and image-sequence keys)`];
  const clipMasks = all.filter((a) => a.att["type"] === "clipping").length;
  const hitBoxes = all.filter((a) => a.att["type"] === "boundingbox").length;
  const sequences = all.filter((a) => isObj(a.att["sequence"])).length;
  if (clipMasks || hitBoxes || sequences) kept.push(`${n(clipMasks, "clipping mask")}, ${n(hitBoxes, "bounding box", "bounding boxes")} and ${n(sequences, "image sequence")} (native Spine attachments)`);
  const pathAtts = all.filter((a) => a.att["type"] === "path").length;
  const pathConstraints = listOf(raw["path"]).length;
  if (pathAtts || pathConstraints) kept.push(`${n(pathAtts, "path attachment")} and ${n(pathConstraints, "path constraint")} with their position, spacing and mix keys (native Spine paths)`);
  const dropped: string[] = [];
  const approximated: string[] = [];
  const physics = listOf(raw["physics"]);
  if (physics.length) dropped.push(`${n(physics.length, "physics constraint")} (${physics.map((p) => String(p["name"])).join(", ")}): Spine physics is not written`);
  const grids = Array.isArray(raw["drivenGrids"]) ? (raw["drivenGrids"] as unknown[]).length : 0;
  if (grids) dropped.push(`${n(grids, "driven grid")} (two-driver correctives)`);
  const driven = listOf(raw["driven"]);
  let deformKeys = 0;
  let alphaKeys = 0;
  let swaps = 0;
  for (const d of driven) {
    for (const k of listOf(d["keys"])) {
      if (Object.keys(objOf(k["deform"])).length) deformKeys++;
      if (Object.keys(objOf(k["alpha"])).length) alphaKeys++;
      if (Object.keys(objOf(k["attachments"])).length || (Array.isArray(k["drawOrder"]) && k["drawOrder"].length)) swaps++;
    }
  }
  if (deformKeys) dropped.push(`driven deforms: ${n(deformKeys, "corrective key")} in ${n(driven.length, "set")} (elbow and knee sculpts)`);
  if (alphaKeys) approximated.push(`driven alpha (${n(alphaKeys, "key")}) is baked into slot colour timelines of each clip`);
  if (swaps) approximated.push(`driven attachment swaps and draw order (${n(swaps, "key")}) are baked per frame into each clip as stepped timelines`);
  const limited = listOf(raw["bones"]).filter((b) => isObj(b["limits"]));
  if (limited.length) dropped.push(`rotation limits on ${n(limited.length, "bone")}`);
  // Linked meshes come across natively (Spine 4.3 `source` + `slot`, so a source in another slot works too); only a link whose
  // source is not a plain mesh (a link to a link, or a missing source) is left out by the exporter.
  const meshAt = (s: Record<string, unknown>) => all.find((a) => a.skin === s["skin"] && a.slot === s["slot"] && a.name === s["attachment"]);
  const badLinks = linked.filter((l) => meshAt(objOf(l.att["source"]))?.att["type"] !== "mesh").length;
  if (badLinks) dropped.push(`${n(badLinks, "linked mesh", "linked meshes")} whose source is not a plain mesh (a link to a link or a missing source)`);
  const grouped = all.filter((a) => a.att["type"] === "mesh" && (a.att["groups"] || a.att["embed"])).length;
  if (grouped) dropped.push(`draw groups and embedded vertices on ${n(grouped, "mesh", "meshes")}`);
  let contours = 0;
  for (const skin of Object.values(objOf(raw["skins"]))) for (const slot of Object.values(objOf(objOf(skin)["contours"]))) contours += Object.keys(objOf(slot)).length;
  if (contours) dropped.push(`${n(contours, "dynamic outline")} (contours, contacts and joins)`);
  if (Array.isArray(raw["drawOrder"]) && raw["drawOrder"].length) dropped.push("the document-level draw order list (slot order is used)");
  approximated.push("clips are exported as sampled at their frame rate; the exact easing between keys may differ slightly");
  return { kept, dropped, approximated };
}

/** Attachment types the importer reads: meshes (with weights) and linked meshes. */
const IMPORTED_ATTACHMENTS = new Set(["mesh", "linkedmesh", "clipping", "boundingbox", "path"]);

export interface ImportSummaryLike {
  meshes: string[];
  linked: string[];
  deform: string[];
  /** Clipping masks, hit boxes and image sequences read from the file. */
  extras?: string[];
  clips: { name: string; replaced: boolean }[];
  warnings: string[];
}

/** What importing this Spine skeleton into the open rig loses, from the Spine file and the dry-run summary. */
export function spineImportLoss(spine: unknown, summary: ImportSummaryLike): LossReport {
  const sk = isObj(spine as never) ? (spine as JsonObject) : {};
  const kept = [
    `${n(summary.meshes.length, "mesh", "meshes")} with weights, ${n(summary.linked.length, "linked mesh", "linked meshes")} and ${n(summary.deform.length, "deform timeline")} that match this rig`,
    ...(summary.extras && summary.extras.length ? [`${n(summary.extras.length, "clipping mask, hit box or image sequence", "clipping masks, hit boxes and image sequences")} on slots this rig has`] : []),
    `${n(summary.clips.length, "clip")}${summary.clips.length ? ` (${summary.clips.map((c) => `${c.name}: ${c.replaced ? "replaces yours" : "new"}`).join(", ")})` : ""}`
  ];
  const dropped: string[] = ["bones, slots and skins of the Spine file: only meshes and clips are merged into this rig, whose own bones and slots stay"];
  const approximated: string[] = [];
  const types = new Map<string, number>();
  for (const skin of Array.isArray(sk["skins"]) ? (sk["skins"] as unknown[]) : []) {
    for (const slot of Object.values(objOf(objOf(skin as JsonObject)["attachments"]))) for (const att of Object.values(objOf(slot))) if (isObj(att)) types.set(String(att["type"] ?? "region"), (types.get(String(att["type"] ?? "region")) ?? 0) + 1);
  }
  for (const [type, count] of types) {
    if (IMPORTED_ATTACHMENTS.has(type) || type === "region") continue;
    dropped.push(`${n(count, `${type} attachment`)} (${type === "path" ? "path rigs" : type === "clipping" ? "clipping masks" : type === "boundingbox" ? "bounding boxes" : type === "point" ? "points: add them in the Rig tab" : "not supported"})`);
  }
  const constraintCounts: [string, string, number][] = [
    ["ik", "IK constraint", Array.isArray(sk["ik"]) ? (sk["ik"] as unknown[]).length : 0],
    ["transform", "transform constraint", Array.isArray(sk["transform"]) ? (sk["transform"] as unknown[]).length : 0],
    ["physics", "physics constraint", Array.isArray(sk["physics"]) ? (sk["physics"] as unknown[]).length : 0]
  ];
  for (const [, label, count] of constraintCounts) if (count) dropped.push(`${n(count, label)} definitions: constraints are not created from the file (clip keys for ones this rig already has are read)`);
  let physicsTimelines = 0;
  for (const anim of Object.values(objOf(sk["animations"]))) {
    if (isObj(anim)) {
      physicsTimelines += Object.keys(objOf(anim["physics"])).length;
    }
  }
  if (physicsTimelines) dropped.push(`${n(physicsTimelines, "physics timeline")}`);
  approximated.push("curves that are not linear, stepped or bezier import linear; channels with different key times get extra keys");
  for (const w of summary.warnings) dropped.push(w);
  return { kept, dropped, approximated };
}
