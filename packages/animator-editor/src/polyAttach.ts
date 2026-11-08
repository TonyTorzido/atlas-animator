/*
 * Atlas Animator editor: clipping masks, hit boxes and image sequences (Batch 12a; pure, no DOM).
 *
 * Plans are command batches (`attachment.add`, `attachment.set`) run with runBatch, like setupAttach.ts.
 * Polygons are x, y pairs in the slot bone's space.
 */
import { fail, isObj, listOf, objOf, r4, slotNames, uniqueName, type Command, type JsonObject } from "./setupModel.js";
import { importedPageFile, importedPath } from "./setupAttach.js";

export type PolygonKind = "clipping" | "boundingbox";

export const POLYGON_LABEL: Record<PolygonKind, string> = { clipping: "Clip mask", boundingbox: "Hit box" };

export interface AttRef {
  skin: string;
  slot: string;
  name: string;
}

function attsOf(raw: JsonObject, skin: string, slot: string): JsonObject {
  const skins = isObj(raw["skins"]) ? raw["skins"] : {};
  const s = isObj(skins[skin]) ? skins[skin] : {};
  const all = isObj(s["attachments"]) ? s["attachments"] : {};
  return isObj(all[slot]) ? all[slot] : {};
}

function polygonOf(raw: JsonObject, a: AttRef, kind?: PolygonKind): number[] {
  const att = attsOf(raw, a.skin, a.slot)[a.name];
  if (!isObj(att)) return fail(`no attachment '${a.name}' on slot '${a.slot}'`);
  if (att["type"] !== "clipping" && att["type"] !== "boundingbox") return fail(`'${a.name}' is a ${String(att["type"])}, not a polygon`);
  if (kind && att["type"] !== kind) return fail(`'${a.name}' is not a ${POLYGON_LABEL[kind].toLowerCase()}`);
  return (att["vertices"] as number[]).slice();
}

/** A starting rectangle: the slot's setup image box when there is one, else 80 x 80 around the bone. */
export function defaultPolygon(raw: JsonObject, skin: string, slot: string): number[] {
  const here = attsOf(raw, skin, slot);
  const s = listOf(raw["slots"]).find((x) => x["name"] === slot);
  const cur = s && typeof s["attachment"] === "string" ? here[s["attachment"]] : undefined;
  let cx = 0;
  let cy = 0;
  let hw = 40;
  let hh = 40;
  if (isObj(cur) && (cur["type"] === "region" || cur["type"] === "mesh")) {
    cx = Number(cur["x"] ?? 0);
    cy = Number(cur["y"] ?? 0);
    hw = Math.max(4, (Number(cur["width"] ?? 80) * Math.abs(Number(cur["scaleX"] ?? 1))) / 2);
    hh = Math.max(4, (Number(cur["height"] ?? 80) * Math.abs(Number(cur["scaleY"] ?? 1))) / 2);
  }
  return [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh].map(r4);
}

export interface PolygonPlan {
  commands: Command[];
  attachment: string;
  /** The slot holding the attachment (a new slot beside the one the button was pressed on). */
  slot: string;
}

/**
 * A clip mask or hit box lives in a slot of its own (Spine: the slot's shown attachment is the polygon). The new slot sits on the same bone:
 * a mask just before the slot it was added from (and clips only that slot until its End slot says otherwise), a hit box just after it.
 */
export function planAddPolygon(raw: JsonObject, o: { skin: string; slot: string; kind: PolygonKind; name?: string }): PolygonPlan {
  if (!slotNames(raw).includes(o.slot)) fail(`no slot '${o.slot}'`);
  const src = listOf(raw["slots"]).find((x) => x["name"] === o.slot)!;
  const suffix = o.kind === "clipping" ? "clip" : "hitbox";
  const slot = uniqueName(slotNames(raw), `${o.slot}_${suffix}`);
  const name = o.name ?? suffix;
  const vertices = defaultPolygon(raw, o.skin, o.slot);
  const slotCmd: Command = { op: "slot.add", name: slot, bone: String(src["bone"]), attachment: name, ...(o.kind === "clipping" ? { drawBefore: o.slot } : { drawAfter: o.slot }) };
  const attachment = o.kind === "clipping" ? { type: o.kind, vertices, end: o.slot } : { type: o.kind, vertices };
  return { commands: [slotCmd, { op: "attachment.add", skin: o.skin, slot, name, attachment }], attachment: name, slot };
}

export function planSetPolygon(raw: JsonObject, a: AttRef, vertices: number[]): Command[] {
  polygonOf(raw, a);
  if (vertices.length < 6 || vertices.length % 2 !== 0) return fail("a polygon needs at least 3 points");
  if (vertices.length > 512) return fail("a polygon may have at most 256 points");
  return [{ op: "attachment.set", ...a, fields: { vertices: vertices.map(r4) } }];
}

/** Moves one vertex. */
export function planMoveVertex(raw: JsonObject, a: AttRef, index: number, x: number, y: number): Command[] {
  const v = polygonOf(raw, a);
  if (index < 0 || index * 2 >= v.length) return fail(`no vertex ${index}`);
  v[index * 2] = x;
  v[index * 2 + 1] = y;
  return planSetPolygon(raw, a, v);
}

/** Adds a vertex after `index` (halfway to the next one unless x, y are given). */
export function planInsertVertex(raw: JsonObject, a: AttRef, index: number, at?: { x: number; y: number }): Command[] {
  const v = polygonOf(raw, a);
  const n = v.length / 2;
  const i = Math.max(0, Math.min(n - 1, index));
  const j = (i + 1) % n;
  const x = at?.x ?? ((v[i * 2] as number) + (v[j * 2] as number)) / 2;
  const y = at?.y ?? ((v[i * 2 + 1] as number) + (v[j * 2 + 1] as number)) / 2;
  v.splice(i * 2 + 2, 0, x, y);
  return planSetPolygon(raw, a, v);
}

export function planRemoveVertex(raw: JsonObject, a: AttRef, index: number): Command[] {
  const v = polygonOf(raw, a);
  if (v.length <= 6) return fail("a polygon needs at least 3 points");
  if (index < 0 || index * 2 >= v.length) return fail(`no vertex ${index}`);
  v.splice(index * 2, 2);
  return planSetPolygon(raw, a, v);
}

/** The last slot a clip mask applies to (null = the end of the draw order). */
export function planSetClipEnd(raw: JsonObject, a: AttRef, end: string | null): Command[] {
  polygonOf(raw, a, "clipping");
  if (end !== null && !slotNames(raw).includes(end)) return fail(`no slot '${end}'`);
  return [{ op: "attachment.set", ...a, fields: { end } }];
}

// ---------------------------------------------------------------------------------------------
// Image sequences
// ---------------------------------------------------------------------------------------------

export interface SequenceFrames {
  /** The shared path prefix (what `path` of the attachment holds). */
  prefix: string;
  start: number;
  digits: number;
  count: number;
}

/**
 * Reads the frame numbering out of a set of atlas paths: they share a prefix and end in consecutive numbers ("fx/boom_01", "fx/boom_02").
 * Zero padding gives `digits` (0 when no path is padded). Returns a message when the set is not a clean run.
 */
export function parseSequenceFrames(paths: readonly string[]): SequenceFrames | string {
  if (paths.length < 2) return "pick at least 2 images for a sequence";
  const parts = paths.map((p) => /^(.*?)(\d+)$/.exec(p));
  if (parts.some((m) => !m)) return "every picked image name must end in a frame number (for example boom_01, boom_02)";
  const prefix = (parts[0] as RegExpExecArray)[1] as string;
  if (parts.some((m) => (m as RegExpExecArray)[1] !== prefix)) return "the picked images must share the same name before the frame number";
  const frames = parts.map((m) => ({ text: (m as RegExpExecArray)[2] as string, n: Number((m as RegExpExecArray)[2]) })).sort((a, b) => a.n - b.n);
  const widths = new Set(frames.map((f) => f.text.length));
  const padded = frames.some((f) => f.text.length > 1 && f.text.startsWith("0"));
  if (padded && widths.size > 1) return "the frame numbers must have the same number of digits";
  for (let i = 1; i < frames.length; i++) if ((frames[i] as { n: number }).n !== (frames[i - 1] as { n: number }).n + 1) return "the frame numbers must be consecutive (no gaps or repeats)";
  return { prefix, start: (frames[0] as { n: number }).n, digits: padded ? (frames[0] as { text: string }).text.length : 0, count: frames.length };
}

/** A region attachment that plays the picked frames; its size is the first frame's. */
export function planSequenceFromPaths(raw: JsonObject, o: { skin: string; slot: string; paths: readonly string[]; size: { width: number; height: number }; name?: string }): PolygonPlan {
  if (!slotNames(raw).includes(o.slot)) fail(`no slot '${o.slot}'`);
  const frames = parseSequenceFrames(o.paths);
  if (typeof frames === "string") return fail(frames);
  const name = uniqueName(Object.keys(attsOf(raw, o.skin, o.slot)), o.name ?? (frames.prefix.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").split("_").pop() || "sequence"));
  const attachment = { type: "region", path: frames.prefix, width: o.size.width, height: o.size.height, sequence: { count: frames.count, start: frames.start, digits: frames.digits, setup: 0 } };
  return { commands: [{ op: "attachment.add", skin: o.skin, slot: o.slot, name, attachment }], attachment: name, slot: o.slot };
}

export interface SequenceImportPlan {
  commands: Command[];
  slot: string;
  attachment: string;
  /** One entry per frame image, in frame order: the atlas texture path and page file the image is stored under. */
  pages: { path: string; page: string; name: string }[];
}

/**
 * Several numbered PNG files (boom_01.png, boom_02.png ...) straight into one image-sequence attachment: each file becomes an atlas page of the
 * rig (like Import PNG), and one region attachment plays them. `frames` are the sanitized file names (no extension) in frame order, with sizes.
 * The slot is `o.slot`, or a new slot on `o.bone`.
 */
export function planImportSequence(raw: JsonObject, o: { skin: string; slot: string | null; bone?: string; rigName: string; frames: readonly { name: string; width: number; height: number }[]; name?: string }): SequenceImportPlan {
  const parsed = parseSequenceFrames(o.frames.map((f) => f.name));
  if (typeof parsed === "string") return fail(parsed);
  const first = o.frames[0]!;
  if (!(first.width > 0 && first.height > 0)) return fail("the first image has no size");
  const commands: Command[] = [];
  const base = (parsed.prefix.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "sequence").slice(0, 40);
  let slot = o.slot;
  if (slot === null) {
    if (!o.bone) return fail("select a slot or a bone first: the sequence needs a slot to play in");
    slot = uniqueName(slotNames(raw), base);
    commands.push({ op: "slot.add", name: slot, bone: o.bone });
  } else if (!slotNames(raw).includes(slot)) return fail(`no slot '${slot}'`);
  const atlas = objOf(raw["atlas"]);
  const have = Array.isArray(atlas["pages"]) ? (atlas["pages"] as string[]) : [];
  const pages = o.frames.map((f) => ({ name: f.name, path: importedPath(o.skin, slot as string, f.name), page: importedPageFile(o.rigName, f.name) }));
  for (const p of pages) if (have.includes(p.page)) return fail(`an image named '${p.name}' was already imported in this rig: rename the files or remove the old image first`);
  commands.push({ op: "doc.set", atlas: { pages: [...have, ...pages.map((p) => p.page)], scale: Number(atlas["scale"] ?? 1) } });
  const attachment = uniqueName(Object.keys(attsOf(raw, o.skin, slot)), o.name ?? base);
  commands.push({
    op: "attachment.add",
    skin: o.skin,
    slot,
    name: attachment,
    attachment: { type: "region", path: importedPath(o.skin, slot, parsed.prefix), width: first.width, height: first.height, sequence: { count: parsed.count, start: parsed.start, digits: parsed.digits, setup: 0 } }
  });
  commands.push({ op: "slot.set", name: slot, attachment });
  return { commands, slot, attachment, pages };
}

export interface SequenceFields {
  count?: number;
  start?: number;
  digits?: number;
  setup?: number;
}

/** Edits the sequence block of a region or mesh; `null` makes it a plain single image again. */
export function planSetSequence(raw: JsonObject, a: AttRef, fields: SequenceFields | null): Command[] {
  const att = attsOf(raw, a.skin, a.slot)[a.name];
  if (!isObj(att)) return fail(`no attachment '${a.name}' on slot '${a.slot}'`);
  if (att["type"] !== "region" && att["type"] !== "mesh" && att["type"] !== "linkedMesh") return fail("only images and meshes can be sequences");
  if (fields === null) return [{ op: "attachment.set", ...a, fields: { sequence: null } }];
  const cur = isObj(att["sequence"]) ? att["sequence"] : { count: 2, start: 1, digits: 0, setup: 0 };
  const next = { count: Number(cur["count"] ?? 2), start: Number(cur["start"] ?? 1), digits: Number(cur["digits"] ?? 0), setup: Number(cur["setup"] ?? 0), ...fields };
  next.count = Math.max(1, Math.min(256, Math.round(next.count)));
  next.start = Math.max(0, Math.round(next.start));
  next.digits = Math.max(0, Math.min(8, Math.round(next.digits)));
  next.setup = Math.max(0, Math.min(next.count - 1, Math.round(next.setup)));
  return [{ op: "attachment.set", ...a, fields: { sequence: next } }];
}

/** Slots whose attachments include an image sequence (any skin): where sequence keys make sense. */
export function sequenceSlots(raw: JsonObject): string[] {
  const out = new Set<string>();
  for (const skin of Object.values(isObj(raw["skins"]) ? raw["skins"] : {})) {
    if (!isObj(skin) || !isObj(skin["attachments"])) continue;
    for (const [slot, byName] of Object.entries(skin["attachments"])) {
      if (isObj(byName) && Object.values(byName).some((x) => isObj(x) && isObj(x["sequence"]))) out.add(slot);
    }
  }
  return [...out];
}

/** The sequence key command for a clip. */
export function sequenceKeyCommand(clip: string, slot: string, time: number, key: { mode: "hold" | "once" | "loop" | "pingpong"; index: number; delay: number }): Command {
  return { op: "key.set", clip, slot, timeline: "sequence", time, mode: key.mode, index: Math.max(0, Math.round(key.index)), delay: Math.max(0, key.delay) };
}
