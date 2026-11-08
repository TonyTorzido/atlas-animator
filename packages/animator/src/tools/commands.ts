/*
 * Atlas Animator: original implementation.
 *
 * The command bus (plan 4.3): one vocabulary of JSON commands (`{"op": "bone.add", ...}`) for the
 * CLI, the editor console and the editor UI. A command compiles to an RFC 6902 patch on the raw
 * document (the JSON as stored, defaults left out) and records the inverse patch, so the pair is
 * one undo step and one line of the command log. Pure module (core + zod, no Node, no DOM).
 *
 * Every command is checked after it runs: if it introduces a format or reference error the
 * command is rejected and the document is left unchanged. Commands never write outside their
 * patch, so nothing reaches the document except through the log.
 */
import { z } from "zod";
import {
  attachmentSchema,
  blendSchema,
  boneSchema,
  colorKeySchema,
  colorSchema,
  curveSpecSchema,
  deformKeySchema,
  drawOrderKeySchema,
  drivenKeySchema,
  drivenSchema,
  eventDefinitionSchema,
  eventKeySchema,
  FORMAT_ID,
  ikConstraintSchema,
  ikKeySchema,
  inheritSchema,
  nameSchema,
  physicsConstraintSchema,
  pathConstraintSchema,
  pathKeySchema,
  transformConstraintSchema,
  transformKeySchema,
  valueKeySchema,
  vectorKeySchema,
  attachmentKeySchema,
  sequenceKeySchema,
  contourSchema,
  CONTOUR_CAPS,
  contourVisibilitySchema,
  coverageRegionSchema,
  drivenGridSchema,
  MAX_VERTEX_INFLUENCES,
  triangleRangesSchema,
  budgetsSchema,
  authoringSchema,
  type AnimDocument
} from "../core/format.js";
import { bindPointToMesh } from "../core/contours.js";
import { formatIssue, parseAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { Bone } from "../core/bone.js";
import { adjacency, autoWeightsTree, normalizeInfluences, pruneWeights, smoothWeights, weightsAtPoint, weldWeights, type Influence, type WeightBone, type WeightTree } from "./autoWeights.js";
import { chainBones, domainFor } from "./authoring.js";
import { autoMesh } from "./autoMesh.js";
import { checkMeshEditable, MeshEditError, oldToNewMap, planDeformRemap, planReferenceRemap, remapDeform, type DeformGeom, type PlannedWrite } from "./meshEdit.js";
import { clipsTouched, describeViolations, keyedTimes, limitDocument, newViolations, type LimitMode, type LimitViolation } from "./liveLimits.js";
import { polygonArea, segmentDistance, type Point } from "./outline.js";
import {
  applyPatchMutable,
  cloneJson,
  getAt,
  jsonEqual,
  PatchError,
  parsePatch,
  pointer,
  type JsonObject,
  type JsonValue,
  type PatchOperation
} from "./jsonPatch.js";

export type Command = { op: string } & Record<string, unknown>;

export class CommandError extends Error {
  constructor(
    message: string,
    /** Index of the failing command in its batch, when run as a batch. */
    readonly index: number | null = null,
    readonly op: string | null = null
  ) {
    super(message);
    this.name = "CommandError";
  }
}

const fail = (message: string): never => {
  throw new CommandError(message);
};

// ---------------------------------------------------------------------------------------------
// Edit: applies primitive patch operations to a working document and records forward + inverse
// ---------------------------------------------------------------------------------------------

/** A diagnostic a command reports beside its patch (`weights.auto` ambiguity and domains). */
export interface CommandNote {
  level: "info" | "warning";
  message: string;
  /** Vertex IDs the note is about (`weights.auto` ambiguous vertices, for overlays). */
  vertices?: number[];
}

export class Edit {
  readonly patch: PatchOperation[] = [];
  readonly inverse: PatchOperation[] = [];
  /** Diagnostics of the command (returned in its AppliedCommand; the CLI prints warnings). */
  readonly notes: CommandNote[] = [];

  constructor(public doc: JsonObject) {}

  apply(operation: PatchOperation): void {
    const result = applyPatchMutable(this.doc, [operation]);
    this.doc = result.doc as JsonObject;
    this.patch.push(operation);
    this.inverse.unshift(...result.inverse);
  }

  get(path: string): JsonValue | undefined {
    return getAt(this.doc, path);
  }

  has(path: string): boolean {
    return this.get(path) !== undefined;
  }

  /** add or replace; no operation when the value is already equal. */
  set(path: string, value: JsonValue): void {
    const old = this.get(path);
    if (old !== undefined && jsonEqual(old, value)) return;
    this.apply(old === undefined ? { op: "add", path, value } : { op: "replace", path, value });
  }

  remove(path: string): void {
    if (this.has(path)) this.apply({ op: "remove", path });
  }

  /** Creates empty objects along `tokens` where missing and returns the pointer. */
  ensure(...tokens: (string | number)[]): string {
    for (let i = 1; i <= tokens.length; i++) {
      const path = pointer(...tokens.slice(0, i));
      if (!this.has(path)) this.apply({ op: "add", path, value: {} });
    }
    return pointer(...tokens);
  }

  /** Removes the object at `tokens` and then each empty parent, stopping at `keep` levels. */
  prune(tokens: (string | number)[], keep: number): void {
    for (let i = tokens.length; i > keep; i--) {
      const path = pointer(...tokens.slice(0, i));
      const value = this.get(path);
      const empty = value !== undefined && ((Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0));
      if (!empty) return;
      this.remove(path);
    }
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Document lookups with errors written for the caller
// ---------------------------------------------------------------------------------------------

function listNames(names: readonly string[]): string {
  if (names.length === 0) return "none";
  return names.length > 24 ? `${names.slice(0, 24).join(", ")}, ... (${names.length})` : names.join(", ");
}

function arrayAt(doc: JsonObject, key: string): JsonObject[] {
  const value = doc[key];
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

function recordAt(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function indexByName(doc: JsonObject, key: string, name: string, what: string): number {
  const list = arrayAt(doc, key);
  const index = list.findIndex((entry) => entry["name"] === name);
  if (index < 0) fail(`no ${what} '${name}'; ${what}s: ${listNames(list.map((entry) => String(entry["name"])))}`);
  return index;
}

function requireKey(record: JsonObject, name: string, what: string): void {
  if (!Object.prototype.hasOwnProperty.call(record, name)) fail(`no ${what} '${name}'; ${what}s: ${listNames(Object.keys(record))}`);
}

function requireFree(names: readonly string[], name: string, what: string): void {
  if (names.includes(name)) fail(`${what} '${name}' already exists`);
}

const boneNames = (doc: JsonObject) => arrayAt(doc, "bones").map((bone) => String(bone["name"]));
const slotNames = (doc: JsonObject) => arrayAt(doc, "slots").map((slot) => String(slot["name"]));

/** Index after the last descendant of `name` (where a new child keeps the list parents-first). */
function afterSubtree(bones: readonly JsonObject[], name: string): number {
  const inside = new Set([name]);
  let end = bones.findIndex((bone) => bone["name"] === name) + 1;
  for (let i = end; i < bones.length; i++) {
    const parent = bones[i]?.["parent"];
    if (typeof parent === "string" && inside.has(parent)) {
      inside.add(String(bones[i]?.["name"]));
      end = i + 1;
    }
  }
  return end;
}

function subtreeOf(bones: readonly JsonObject[], name: string): Set<string> {
  const inside = new Set([name]);
  for (const bone of bones) {
    const parent = bone["parent"];
    if (typeof parent === "string" && inside.has(parent)) inside.add(String(bone["name"]));
  }
  return inside;
}

/** Copies the given optional fields of `params` in the order listed (skipping undefined). */
function pick(params: Record<string, unknown>, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (params[key] !== undefined) out[key] = params[key] as JsonValue;
  return out;
}

/** Sets each given field; null removes it. */
function setFields(edit: Edit, base: (string | number)[], fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const path = pointer(...base, key);
    if (value === null) edit.remove(path);
    else edit.set(path, value as JsonValue);
  }
}

// ---------------------------------------------------------------------------------------------
// Setup-pose geometry (for vertex moves and binding)
// ---------------------------------------------------------------------------------------------

interface WeightedVertex {
  influences: { bone: number; x: number; y: number; weight: number }[];
}

function decodeWeighted(vertices: readonly number[], count: number): WeightedVertex[] {
  const out: WeightedVertex[] = [];
  let cursor = 0;
  for (let v = 0; v < count; v++) {
    const n = vertices[cursor++] as number;
    const influences = [];
    for (let k = 0; k < n; k++, cursor += 4) {
      influences.push({ bone: vertices[cursor] as number, x: vertices[cursor + 1] as number, y: vertices[cursor + 2] as number, weight: vertices[cursor + 3] as number });
    }
    out.push({ influences });
  }
  return out;
}

function encodeWeighted(vertices: readonly WeightedVertex[]): number[] {
  return vertices.flatMap((vertex) => [vertex.influences.length, ...vertex.influences.flatMap((inf) => [inf.bone, round(inf.x), round(inf.y), inf.weight])]);
}

const round = (value: number) => Math.round(value * 1e4) / 1e4 + 0;

/** The setup pose of the document as the runtime builds it (every skin active). */
function setupSkeleton(doc: JsonObject): Skeleton {
  // The batch's input document, parsed when an earlier batch returned it: valid only while this command has not edited it.
  const hint = parseHint;
  let document: AnimDocument;
  if (hint && hint.edit.doc === doc && hint.edit.patch.length === 0) document = hint.document;
  else {
    const parsed = parseAnimDocument(doc);
    if (!parsed.ok) fail(`the document has errors, fix them before editing geometry:\n  ${parsed.issues.map(formatIssue).join("\n  ")}`);
    document = (parsed as { document: AnimDocument }).document;
  }
  const skeleton = new Skeleton(document);
  skeleton.setActiveSkins(Object.keys(document.skins));
  skeleton.updateWorldTransform("none");
  return skeleton;
}

interface MeshAddress {
  skin: string;
  slot: string;
  name: string;
}

function attachmentTokens(address: MeshAddress): string[] {
  return ["skins", address.skin, "attachments", address.slot, address.name];
}

function requireAttachment(doc: JsonObject, address: MeshAddress): JsonObject {
  const skins = recordAt(doc["skins"]);
  requireKey(skins, address.skin, "skin");
  const slots = recordAt(recordAt(skins[address.skin])["attachments"]);
  requireKey(slots, address.slot, `attachment slot in skin '${address.skin}'; slot`);
  const attachments = recordAt(slots[address.slot]);
  requireKey(attachments, address.name, `attachment in ${address.skin}/${address.slot}; attachment`);
  return attachments[address.name] as JsonObject;
}

function requireMesh(doc: JsonObject, address: MeshAddress): JsonObject {
  const attachment = requireAttachment(doc, address);
  if (attachment["type"] !== "mesh") fail(`${address.skin}/${address.slot}/${address.name} is a ${String(attachment["type"])}, not a mesh`);
  return attachment;
}

function slotBoneOf(doc: JsonObject, slot: string): string {
  const entry = arrayAt(doc, "slots").find((candidate) => candidate["name"] === slot);
  if (!entry) fail(`no slot '${slot}'`);
  return String(entry?.["bone"]);
}

/** Setup world position of every vertex of a mesh (skeleton space; canvas = world + origin). */
function meshWorld(skeleton: Skeleton, doc: JsonObject, address: MeshAddress, mesh: JsonObject): { x: number; y: number }[] {
  const uvs = mesh["uvs"] as number[];
  const count = uvs.length / 2;
  const vertices = mesh["vertices"] as number[];
  const out: { x: number; y: number }[] = [];
  const point = { x: 0, y: 0 };
  const tableNames = mesh["bones"] as string[] | undefined;
  if (!tableNames) {
    const bone = skeleton.getBone(slotBoneOf(doc, address.slot));
    for (let v = 0; v < count; v++) {
      bone.localToWorld(vertices[2 * v] as number, vertices[2 * v + 1] as number, point);
      out.push({ x: point.x, y: point.y });
    }
    return out;
  }
  const table = tableNames.map((name) => skeleton.getBone(name));
  for (const vertex of decodeWeighted(vertices, count)) {
    let x = 0;
    let y = 0;
    for (const inf of vertex.influences) {
      (table[inf.bone] as Bone).localToWorld(inf.x, inf.y, point);
      x += point.x * inf.weight;
      y += point.y * inf.weight;
    }
    out.push({ x, y });
  }
  return out;
}

function toLocal(bone: Bone, x: number, y: number): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  if (!bone.worldToLocal(x, y, out)) fail(`bone '${bone.data.name}' has a collapsed (zero-scale) setup transform`);
  return out;
}

function selectVertices(selection: number[] | "all" | undefined, count: number): number[] {
  if (selection === undefined || selection === "all") return Array.from({ length: count }, (_, i) => i);
  for (const v of selection) if (v >= count) fail(`vertex ${v} is out of range (mesh has ${count} vertices)`);
  return [...new Set(selection)];
}

// ---------------------------------------------------------------------------------------------
// Keys and timelines
// ---------------------------------------------------------------------------------------------

const BONE_TIMELINES = ["rotate", "translate", "scale", "shear"] as const;
const SLOT_TIMELINES = ["attachment", "color", "sequence"] as const;
const PHYSICS_TIMELINES = ["mix", "reset"] as const;

const deformAddressSchema = z.object({ skin: nameSchema, slot: nameSchema, attachment: nameSchema }).strict();

/** Which timeline a key command addresses (exactly one of bone/slot/ik/transform/physics/deform/drawOrder). */
const addressShape = {
  bone: nameSchema.optional(),
  slot: nameSchema.optional(),
  ik: nameSchema.optional(),
  transform: nameSchema.optional(),
  physics: nameSchema.optional(),
  path: nameSchema.optional(),
  deform: deformAddressSchema.optional(),
  drawOrder: z.literal(true).optional(),
  /** bone: rotate|translate|scale|shear; slot: attachment|color; physics: mix|reset. */
  timeline: z.string().optional()
};
type Address = { [K in keyof typeof addressShape]?: z.infer<(typeof addressShape)[K]> };

interface Timeline {
  /** Tokens from the clip object to the key array. */
  tokens: string[];
  /** Validates one key of this timeline. */
  key: z.ZodTypeAny;
  label: string;
}

function resolveTimeline(address: Address): Timeline {
  const given = (["bone", "slot", "ik", "transform", "path", "physics", "deform", "drawOrder"] as const).filter((key) => address[key] !== undefined);
  if (given.length !== 1) fail(`give exactly one of bone, slot, ik, transform, path, physics, deform, drawOrder (got ${given.length ? given.join(", ") : "none"})`);
  const timeline = address.timeline;
  const need = <T extends readonly string[]>(allowed: T, what: string): T[number] => {
    if (!timeline || !allowed.includes(timeline)) fail(`${what} keys need timeline ${allowed.join("|")} (got ${timeline ?? "none"})`);
    return timeline as T[number];
  };
  if (address.bone !== undefined) {
    const kind = need(BONE_TIMELINES, "bone");
    return { tokens: ["bones", address.bone, kind], key: kind === "rotate" ? valueKeySchema : vectorKeySchema, label: `bone ${address.bone} ${kind}` };
  }
  if (address.slot !== undefined) {
    const kind = need(SLOT_TIMELINES, "slot");
    return { tokens: ["slots", address.slot, kind], key: kind === "color" ? colorKeySchema : kind === "sequence" ? sequenceKeySchema : attachmentKeySchema, label: `slot ${address.slot} ${kind}` };
  }
  if (address.physics !== undefined) {
    const kind = need(PHYSICS_TIMELINES, "physics");
    return { tokens: ["physics", address.physics, kind], key: kind === "mix" ? valueKeySchema : z.object({ time: z.number() }).strict(), label: `physics ${address.physics} ${kind}` };
  }
  if (timeline !== undefined) fail(`'timeline' only applies to bone, slot and physics keys`);
  if (address.ik !== undefined) return { tokens: ["ik", address.ik], key: ikKeySchema, label: `ik ${address.ik}` };
  if (address.transform !== undefined) return { tokens: ["transform", address.transform], key: transformKeySchema, label: `transform ${address.transform}` };
  if (address.path !== undefined) return { tokens: ["path", address.path], key: pathKeySchema, label: `path ${address.path}` };
  if (address.deform !== undefined) {
    const d = address.deform;
    return { tokens: ["deform", d.skin, d.slot, d.attachment], key: deformKeySchema, label: `deform ${d.skin}/${d.slot}/${d.attachment}` };
  }
  return { tokens: ["drawOrder"], key: drawOrderKeySchema, label: "drawOrder" };
}

const TIME_EPSILON = 1e-6;
const sameTime = (a: number, b: number) => Math.abs(a - b) <= TIME_EPSILON;

function requireClip(doc: JsonObject, clip: string): JsonObject {
  const animations = recordAt(doc["animations"]);
  requireKey(animations, clip, "clip");
  return animations[clip] as JsonObject;
}

function keysOf(edit: Edit, clip: string, timeline: Timeline): JsonObject[] {
  const value = edit.get(pointer("animations", clip, ...timeline.tokens));
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

function keyIndexAt(keys: readonly JsonObject[], time: number, label: string): number {
  const index = keys.findIndex((key) => sameTime(key["time"] as number, time));
  if (index < 0) fail(`no ${label} key at ${time}s; keys at: ${listNames(keys.map((key) => `${String(key["time"])}s`))}`);
  return index;
}

/** Every key array of a clip (bone, slot, constraint, deform, draw-order and event timelines). */
function clipTimelines(clip: JsonObject): { tokens: string[]; keys: JsonObject[] }[] {
  const out: { tokens: string[]; keys: JsonObject[] }[] = [];
  const walk = (value: JsonValue | undefined, tokens: string[], depth: number) => {
    if (Array.isArray(value)) out.push({ tokens, keys: value as JsonObject[] });
    else if (isObject(value) && depth > 0) for (const [key, child] of Object.entries(value)) walk(child, [...tokens, key], depth - 1);
  };
  walk(clip["bones"], ["bones"], 2);
  walk(clip["slots"], ["slots"], 2);
  walk(clip["ik"], ["ik"], 1);
  walk(clip["transform"], ["transform"], 1);
  walk(clip["path"], ["path"], 1);
  walk(clip["physics"], ["physics"], 2);
  walk(clip["deform"], ["deform"], 3);
  walk(clip["drawOrder"], ["drawOrder"], 0);
  walk(clip["events"], ["events"], 0);
  return out;
}

function addressedTimelines(clip: JsonObject, address: Address): { tokens: string[]; keys: JsonObject[] }[] {
  const any = (["bone", "slot", "ik", "transform", "path", "physics", "deform", "drawOrder"] as const).some((key) => address[key] !== undefined);
  if (!any) return clipTimelines(clip);
  const timeline = resolveTimeline(address);
  const keys = getAt(clip, pointer(...timeline.tokens));
  return Array.isArray(keys) ? [{ tokens: timeline.tokens, keys: keys as JsonObject[] }] : [];
}

/** Inserts or replaces keys in a sorted key array (events: same time + name replaces). */
function writeKeys(edit: Edit, base: string[], incoming: readonly JsonObject[], events: boolean): void {
  for (const key of incoming) {
    const keys = (edit.get(pointer(...base)) as JsonObject[] | undefined) ?? [];
    const time = key["time"] as number;
    const same = keys.findIndex((other) => sameTime(other["time"] as number, time) && (!events || other["name"] === key["name"]));
    if (same >= 0) {
      edit.set(pointer(...base, same), key);
      continue;
    }
    let at = keys.findIndex((other) => (other["time"] as number) > time + TIME_EPSILON);
    if (at < 0) at = keys.length;
    if (keys.length === 0) edit.set(pointer(...base), [key]);
    else edit.apply({ op: "add", path: pointer(...base, at), value: key });
  }
}

const roundTime = (time: number) => Math.round(time * 1e6) / 1e6 + 0;

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

export interface CommandSpec<P = never> {
  op: string;
  summary: string;
  params: z.ZodType<P>;
  example: Command;
  run(edit: Edit, params: P): void;
}

const specs: CommandSpec<never>[] = [];

function define<S extends z.ZodRawShape>(
  op: string,
  summary: string,
  shape: S,
  example: Record<string, unknown>,
  run: (edit: Edit, params: z.infer<z.ZodObject<S>>) => void,
  /** Accept fields beyond the shape (key.set: the key's own fields depend on the timeline). */
  passthrough = false
): void {
  const object = z.object({ op: z.literal(op), ...shape });
  const params = (passthrough ? object.passthrough() : object.strict()) as unknown as z.ZodType<z.infer<z.ZodObject<S>>>;
  specs.push({ op, summary, params, example: { op, ...example }, run } as unknown as CommandSpec<never>);
}

const finite = () => z.number().finite();
const meshAddressShape = { skin: nameSchema, slot: nameSchema, name: nameSchema };
const boneFieldShape = {
  length: finite().nonnegative().optional(),
  x: finite().optional(),
  y: finite().optional(),
  rotation: finite().optional(),
  scaleX: finite().optional(),
  scaleY: finite().optional(),
  shearX: finite().optional(),
  shearY: finite().optional(),
  inherit: inheritSchema.optional(),
  role: z.enum(["spine", "limb", "head", "tail", "other"]).optional(),
  skin: z.boolean().optional(),
  color: colorSchema.nullable().optional(),
  helper: z.boolean().nullable().optional()
};
const BONE_FIELDS = ["length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "inherit", "limits", "role", "skin", "color", "helper"] as const;
const placement = { before: nameSchema.optional(), after: nameSchema.optional() };

// --- doc.* -------------------------------------------------------------------------------------

define(
  "doc.new",
  "Replaces the whole document with an empty rig (one root bone) and an empty default skin (`skin`, default body).",
  { name: nameSchema, width: z.number().int().positive(), height: z.number().int().positive(), originX: finite().optional(), originY: finite().optional(), skin: nameSchema.optional() },
  { name: "hero", width: 1086, height: 1448, originX: 543, originY: 1240 },
  (edit, p) => {
    const doc: JsonObject = {
      format: FORMAT_ID,
      name: p.name,
      canvas: { width: p.width, height: p.height, originX: p.originX ?? p.width / 2, originY: p.originY ?? p.height },
      bones: [{ name: "root" }],
      slots: [],
      skins: { [p.skin ?? "body"]: { attachments: {} } },
      animations: {}
    };
    edit.apply({ op: "replace", path: "", value: doc });
  }
);

define(
  "doc.set",
  "Sets document metadata: name, revision, canvas fields, atlas, budgets, authoring (null removes the atlas, the budgets or the authoring block; budgets and authoring replace the whole block).",
  {
    name: nameSchema.optional(),
    revision: z.number().int().positive().optional(),
    canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), originX: finite(), originY: finite() }).partial().strict().optional(),
    atlas: z.object({ pages: z.array(z.string()).min(1), scale: finite().positive().max(1) }).strict().nullable().optional(),
    budgets: budgetsSchema.nullable().optional(),
    authoring: authoringSchema.nullable().optional()
  },
  { revision: 2, canvas: { originY: 1250 }, budgets: { bodyVertices: 400, bend: { spine: 30 } } },
  (edit, p) => {
    setFields(edit, [], { name: p.name, revision: p.revision, atlas: p.atlas, budgets: p.budgets as JsonValue | null | undefined, authoring: p.authoring as JsonValue | null | undefined });
    if (p.canvas) setFields(edit, ["canvas"], p.canvas);
  }
);

// --- bone.* ------------------------------------------------------------------------------------

define(
  "bone.add",
  "Adds a bone (placed after its parent's subtree so the list stays parents-first). `world: [x, y]` places its start at a canvas point (setup pose) and `tip: [x, y]` (with `world`) sets its rotation and length so it ends at a canvas point; both are converted to the parent-local x, y, rotation and length (they may not be combined with those fields).",
  { name: nameSchema, parent: nameSchema.optional(), ...boneFieldShape, limits: z.object({ min: finite(), max: finite() }).strict().optional(), world: z.tuple([finite(), finite()]).optional(), tip: z.tuple([finite(), finite()]).optional() },
  { name: "sword_tip", parent: "tip_b", x: 40, length: 20 },
  (edit, p) => {
    const bones = arrayAt(edit.doc, "bones");
    requireFree(boneNames(edit.doc), p.name, "bone");
    let at = bones.length;
    if (p.parent !== undefined) {
      indexByName(edit.doc, "bones", p.parent, "bone");
      at = afterSubtree(bones, p.parent);
    }
    const placed: Record<string, number> = {};
    if (p.tip && !p.world) fail("bone.add: `tip` needs `world` (the bone's start on the canvas)");
    if (p.world) {
      for (const field of ["x", "y", ...(p.tip ? ["rotation", "length"] : [])]) if ((p as Record<string, unknown>)[field] !== undefined) fail(`bone.add: \`world\`${p.tip ? "/`tip`" : ""} sets ${field}; give one or the other`);
      // Canvas -> skeleton space (the canvas origin is the skeleton origin), then parent-local.
      const canvas = (edit.doc["canvas"] ?? {}) as { originX?: number; originY?: number };
      const toSkeleton = ([x, y]: [number, number]) => ({ x: x - Number(canvas.originX ?? 0), y: y - Number(canvas.originY ?? 0) });
      const parent = p.parent !== undefined ? setupSkeleton(edit.doc).getBone(p.parent) : null;
      const local = (point: [number, number]) => {
        const at = toSkeleton(point);
        return parent ? toLocal(parent, at.x, at.y) : at;
      };
      const start = local(p.world);
      placed["x"] = round(start.x);
      placed["y"] = round(start.y);
      if (p.tip) {
        const end = local(p.tip);
        placed["rotation"] = round((Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI);
        placed["length"] = round(Math.hypot(end.x - start.x, end.y - start.y));
      }
    }
    const bone = { name: p.name, ...pick(p, ["parent", ...BONE_FIELDS]), ...placed };
    boneSchema.parse(bone);
    edit.apply({ op: "add", path: pointer("bones", at), value: bone });
  }
);

define("bone.remove", "Removes a bone that has no children (references to it are rejected by the check).", { name: nameSchema }, { name: "sword_tip" }, (edit, p) => {
  const bones = arrayAt(edit.doc, "bones");
  const index = indexByName(edit.doc, "bones", p.name, "bone");
  const children = bones.filter((bone) => bone["parent"] === p.name).map((bone) => String(bone["name"]));
  if (children.length) fail(`bone '${p.name}' has children (${children.join(", ")}); remove or re-parent them first`);
  edit.apply({ op: "remove", path: pointer("bones", index) });
});

define(
  "bone.set",
  "Sets setup-pose fields of a bone (local x, y, rotation, scale, shear, length, inherit, skin).",
  { name: nameSchema, ...boneFieldShape },
  { name: "trunk", rotation: 5 },
  (edit, p) => {
    const index = indexByName(edit.doc, "bones", p.name, "bone");
    setFields(edit, ["bones", index], pick(p, BONE_FIELDS));
  }
);

define(
  "bone.parent",
  "Re-parents a bone (null makes it a root); its subtree moves with it. Local values are kept.",
  { name: nameSchema, parent: nameSchema.nullable() },
  { name: "sword", parent: "tip_a" },
  (edit, p) => {
    const bones = arrayAt(edit.doc, "bones");
    const index = indexByName(edit.doc, "bones", p.name, "bone");
    const subtree = subtreeOf(bones, p.name);
    if (p.parent !== null) {
      indexByName(edit.doc, "bones", p.parent, "bone");
      if (subtree.has(p.parent)) fail(`cannot parent '${p.name}' to '${p.parent}': '${p.parent}' is inside its subtree`);
    }
    const moved = bones.filter((bone) => subtree.has(String(bone["name"]))).map((bone) => cloneJson(bone));
    const head = moved[0] as JsonObject;
    const keys = Object.keys(head);
    const rebuilt: JsonObject = {};
    for (const key of keys.includes("parent") ? keys : ["name", "parent", ...keys.filter((key) => key !== "name")]) {
      if (key === "parent") {
        if (p.parent !== null) rebuilt["parent"] = p.parent;
      } else rebuilt[key] = head[key] as JsonValue;
    }
    moved[0] = rebuilt;
    const rest = bones.filter((bone) => !subtree.has(String(bone["name"])));
    const at = p.parent === null ? Math.min(index, rest.length) : afterSubtree(rest, p.parent);
    const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    edit.set("/bones", next as JsonValue);
  }
);

define(
  "bone.limits",
  "Sets a bone's rotation limits (degrees relative to setup), or removes them with clear: true.",
  { name: nameSchema, min: finite().optional(), max: finite().optional(), clear: z.literal(true).optional() },
  { name: "lower_b", min: 0, max: 70 },
  (edit, p) => {
    const index = indexByName(edit.doc, "bones", p.name, "bone");
    if (p.clear) {
      edit.remove(pointer("bones", index, "limits"));
      return;
    }
    if (p.min === undefined || p.max === undefined) fail("give min and max, or clear: true");
    edit.set(pointer("bones", index, "limits"), { min: p.min as number, max: p.max as number });
  }
);

define("bone.rename", "Renames a bone and every reference to it (slots, constraints, driven sets, skins, mesh bone tables, clips).", { name: nameSchema, to: nameSchema }, { name: "tip_b", to: "hand_right" }, (edit, p) => {
  const from = p.name;
  indexByName(edit.doc, "bones", from, "bone");
  requireFree(boneNames(edit.doc), p.to, "bone");
  const rename = (value: JsonValue | undefined) => (value === from ? p.to : value);
  arrayAt(edit.doc, "bones").forEach((bone, i) => {
    if (bone["name"] === from) edit.set(pointer("bones", i, "name"), p.to);
    if (bone["parent"] === from) edit.set(pointer("bones", i, "parent"), p.to);
  });
  arrayAt(edit.doc, "slots").forEach((slot, i) => {
    if (slot["bone"] === from) edit.set(pointer("slots", i, "bone"), p.to);
  });
  for (const kind of ["ik", "transform", "path"] as const) {
    arrayAt(edit.doc, kind).forEach((constraint, i) => {
      const list = constraint["bones"] as string[];
      if (list.includes(from)) edit.set(pointer(kind, i, "bones"), list.map((bone) => rename(bone) as string));
      if (kind !== "path" && constraint["target"] === from) edit.set(pointer(kind, i, "target"), p.to);
    });
  }
  arrayAt(edit.doc, "physics").forEach((constraint, i) => {
    if (constraint["bone"] === from) edit.set(pointer("physics", i, "bone"), p.to);
  });
  arrayAt(edit.doc, "driven").forEach((driven, i) => {
    if (driven["bone"] === from) edit.set(pointer("driven", i, "bone"), p.to);
  });
  arrayAt(edit.doc, "drivenGrids").forEach((grid, i) => {
    for (const axis of ["x", "y"]) {
      if (recordAt(grid[axis])["bone"] === from) edit.set(pointer("drivenGrids", i, axis, "bone"), p.to);
    }
  });
  for (const [skinName, skin] of Object.entries(recordAt(edit.doc["skins"]))) {
    for (const [slotName, contours] of Object.entries(recordAt(recordAt(skin)["contours"]))) {
      for (const [contourName, contour] of Object.entries(recordAt(contours))) {
        const base = ["skins", skinName, "contours", slotName, contourName];
        const table = recordAt(contour)["bones"];
        if (Array.isArray(table) && table.includes(from)) edit.set(pointer(...base, "bones"), table.map(rename) as JsonValue);
        const visible = recordAt(contour)["visible"];
        if (Array.isArray(visible)) {
          visible.forEach((rule, r) => {
            if (recordAt(rule)["bone"] === from) edit.set(pointer(...base, "visible", r, "bone"), p.to);
          });
        }
      }
    }
  }
  for (const [skinName, skin] of Object.entries(recordAt(edit.doc["skins"]))) {
    const list = recordAt(skin)["bones"];
    if (Array.isArray(list) && list.includes(from)) edit.set(pointer("skins", skinName, "bones"), list.map(rename) as JsonValue);
    for (const [slotName, attachments] of Object.entries(recordAt(recordAt(skin)["attachments"]))) {
      for (const [attachmentName, attachment] of Object.entries(recordAt(attachments))) {
        const table = recordAt(attachment)["bones"];
        if (Array.isArray(table) && table.includes(from)) edit.set(pointer("skins", skinName, "attachments", slotName, attachmentName, "bones"), table.map(rename) as JsonValue);
      }
    }
  }
  for (const [clipName, clip] of Object.entries(recordAt(edit.doc["animations"]))) {
    const timelines = recordAt(recordAt(clip)["bones"]);
    if (timelines[from] !== undefined) {
      const value = timelines[from] as JsonValue;
      edit.remove(pointer("animations", clipName, "bones", from));
      edit.set(pointer("animations", clipName, "bones", p.to), value);
    }
  }
});

// --- slot.* ------------------------------------------------------------------------------------

function insertDrawPosition(edit: Edit, name: string, where: { before?: string | undefined; after?: string | undefined }): void {
  if (where.before !== undefined && where.after !== undefined) fail("give at most one of before and after");
  const anchor = where.before ?? where.after;
  const order = edit.get("/drawOrder");
  if (Array.isArray(order)) {
    const list = order as string[];
    let at = list.length;
    if (anchor !== undefined) {
      const i = list.indexOf(anchor);
      if (i < 0) fail(`no slot '${anchor}' in drawOrder`);
      at = where.before !== undefined ? i : i + 1;
    }
    edit.apply({ op: "add", path: pointer("drawOrder", at), value: name });
    return;
  }
  // No explicit draw order: the slot list is the draw order, so position the slot there.
  const slots = arrayAt(edit.doc, "slots");
  const index = slots.findIndex((slot) => slot["name"] === name);
  const slot = slots[index] as JsonObject;
  if (anchor === undefined) return;
  edit.apply({ op: "remove", path: pointer("slots", index) });
  const rest = arrayAt(edit.doc, "slots");
  const i = rest.findIndex((other) => other["name"] === anchor);
  if (i < 0) fail(`no slot '${anchor}'`);
  edit.apply({ op: "add", path: pointer("slots", where.before !== undefined ? i : i + 1), value: slot });
}

define(
  "slot.add",
  "Adds a slot on a bone; before/after place it in the draw order (default: drawn last).",
  {
    name: nameSchema,
    bone: nameSchema,
    attachment: nameSchema.nullable().optional(),
    color: colorSchema.optional(),
    blend: blendSchema.optional(),
    drawAfter: nameSchema.optional(),
    drawBefore: nameSchema.optional(),
    ...placement
  },
  { name: "sword", bone: "tip_b", attachment: "sword", after: "limb_b" },
  (edit, p) => {
    requireFree(slotNames(edit.doc), p.name, "slot");
    indexByName(edit.doc, "bones", p.bone, "bone");
    const slot = { name: p.name, bone: p.bone, ...pick(p, ["color", "blend", "attachment", "drawAfter", "drawBefore"]) };
    if (!Array.isArray(edit.doc["slots"])) edit.set("/slots", []);
    edit.apply({ op: "add", path: pointer("slots", arrayAt(edit.doc, "slots").length), value: slot });
    insertDrawPosition(edit, p.name, p);
  }
);

define("slot.remove", "Removes a slot (and its draw-order entry).", { name: nameSchema }, { name: "sword" }, (edit, p) => {
  const index = indexByName(edit.doc, "slots", p.name, "slot");
  edit.apply({ op: "remove", path: pointer("slots", index) });
  const order = edit.get("/drawOrder");
  if (Array.isArray(order) && order.includes(p.name)) edit.apply({ op: "remove", path: pointer("drawOrder", order.indexOf(p.name)) });
});

const slotFieldShape = {
  bone: nameSchema.optional(),
  color: colorSchema.optional(),
  blend: blendSchema.optional(),
  attachment: nameSchema.nullable().optional(),
  drawAfter: nameSchema.nullable().optional(),
  drawBefore: nameSchema.nullable().optional()
};

define(
  "slot.set",
  "Sets slot fields: bone, color (rrggbbaa), blend, setup attachment (null shows nothing), drawAfter/drawBefore anchors (null clears).",
  { name: nameSchema, ...slotFieldShape },
  { name: "aura", blend: "additive", color: "ffffff80" },
  (edit, p) => {
    const index = indexByName(edit.doc, "slots", p.name, "slot");
    const { attachment, ...rest } = pick(p, ["bone", "color", "blend", "attachment", "drawAfter", "drawBefore"]);
    setFields(edit, ["slots", index], rest);
    if (p.drawAfter === null) edit.remove(pointer("slots", index, "drawAfter"));
    if (p.drawBefore === null) edit.remove(pointer("slots", index, "drawBefore"));
    if (attachment !== undefined) edit.set(pointer("slots", index, "attachment"), attachment);
    else if (p.attachment === null) edit.set(pointer("slots", index, "attachment"), null);
  }
);

define("slot.color", "Sets a slot's setup colour (rrggbbaa).", { name: nameSchema, color: colorSchema }, { name: "core", color: "ffe0e0ff" }, (edit, p) => {
  edit.set(pointer("slots", indexByName(edit.doc, "slots", p.name, "slot"), "color"), p.color);
});

define("slot.blend", "Sets a slot's blend mode (normal | additive).", { name: nameSchema, blend: blendSchema }, { name: "aura", blend: "additive" }, (edit, p) => {
  edit.set(pointer("slots", indexByName(edit.doc, "slots", p.name, "slot"), "blend"), p.blend);
});

define(
  "slot.order",
  "Moves a slot in the setup draw order, before or after another slot (draw order is back to front).",
  { name: nameSchema, ...placement },
  { name: "sword", before: "core" },
  (edit, p) => {
    indexByName(edit.doc, "slots", p.name, "slot");
    if ((p.before === undefined) === (p.after === undefined)) fail("give exactly one of before and after");
    if ((p.before ?? p.after) === p.name) fail("a slot cannot be placed relative to itself");
    const order = edit.get("/drawOrder");
    if (Array.isArray(order)) {
      const i = order.indexOf(p.name);
      if (i >= 0) edit.apply({ op: "remove", path: pointer("drawOrder", i) });
    }
    insertDrawPosition(edit, p.name, p);
  }
);

// --- skin.* ------------------------------------------------------------------------------------

define(
  "skin.add",
  "Adds an empty skin (optionally with hides, skin bones and skin constraints).",
  { name: nameSchema, hides: z.array(nameSchema).optional(), bones: z.array(nameSchema).optional(), constraints: z.array(nameSchema).optional() },
  { name: "tunic-green", hides: ["hair"] },
  (edit, p) => {
    if (!isObject(edit.doc["skins"])) edit.set("/skins", {});
    requireFree(Object.keys(recordAt(edit.doc["skins"])), p.name, "skin");
    edit.apply({ op: "add", path: pointer("skins", p.name), value: { attachments: {}, ...pick(p, ["hides", "bones", "constraints"]) } });
  }
);

define("skin.remove", "Removes a skin and all its attachments.", { name: nameSchema }, { name: "tunic-green" }, (edit, p) => {
  requireKey(recordAt(edit.doc["skins"]), p.name, "skin");
  edit.apply({ op: "remove", path: pointer("skins", p.name) });
});

for (const [op, field, summary] of [
  ["skin.hide", "hides", "Sets the slots a skin hides while active."],
  ["skin.bones", "bones", "Sets the skin bones a skin activates."],
  ["skin.constraints", "constraints", "Sets the skin constraints a skin activates."]
] as const) {
  define(op, summary, { name: nameSchema, [field]: z.array(nameSchema) } as { name: typeof nameSchema } & Record<typeof field, z.ZodArray<typeof nameSchema>>, { name: "helmet", [field]: ["hair"] }, (edit, p) => {
    requireKey(recordAt(edit.doc["skins"]), p.name, "skin");
    const value = (p as Record<string, unknown>)[field] as string[];
    if (value.length === 0) edit.remove(pointer("skins", p.name, field));
    else edit.set(pointer("skins", p.name, field), value);
  });
}

// --- attachment.* ------------------------------------------------------------------------------

define(
  "attachment.add",
  "Adds (or replaces) an attachment under skin/slot/name, creating the skin when it is missing; `attachment` is a region, mesh, linkedMesh or point object.",
  { ...meshAddressShape, attachment: z.record(z.unknown()) },
  { skin: "body", slot: "sword", name: "sword", attachment: { type: "region", path: "weapons/sword", width: 60, height: 200, y: -90 } },
  (edit, p) => {
    attachmentSchema.parse(p.attachment);
    indexByName(edit.doc, "slots", p.slot, "slot");
    if (!isObject(edit.doc["skins"])) edit.set("/skins", {});
    if (!isObject(recordAt(edit.doc["skins"])[p.skin])) edit.apply({ op: "add", path: pointer("skins", p.skin), value: { attachments: {} } });
    const base = edit.ensure("skins", p.skin, "attachments", p.slot);
    edit.set(`${base}${pointer(p.name)}`, p.attachment as JsonValue);
  }
);

define(
  "attachment.set",
  "Sets fields of an attachment (null removes a field), e.g. a region's x/y/rotation or a linked mesh's inheritDeform.",
  { ...meshAddressShape, fields: z.record(z.unknown()) },
  { skin: "body", slot: "sword", name: "sword", fields: { rotation: 10, y: -95 } },
  (edit, p) => {
    requireAttachment(edit.doc, p);
    if ("type" in p.fields) fail("an attachment's type cannot change; remove and add it instead");
    setFields(edit, attachmentTokens(p), p.fields);
  }
);

define("attachment.remove", "Removes an attachment (and its slot entry in the skin when empty).", meshAddressShape, { skin: "body", slot: "sword", name: "sword" }, (edit, p) => {
  requireAttachment(edit.doc, p);
  edit.remove(pointer(...attachmentTokens(p)));
  edit.prune(["skins", p.skin, "attachments", p.slot], 3);
});

define(
  "attachment.move-vertices",
  "Moves mesh vertices (all, or the listed indices) by dx, dy canvas pixels at the setup pose; weighted meshes keep their weights.",
  { ...meshAddressShape, vertices: z.union([z.array(z.number().int().nonnegative()), z.literal("all")]).optional(), dx: finite(), dy: finite() },
  { skin: "body", slot: "core", name: "core", vertices: [3, 4], dx: 2, dy: -1 },
  (edit, p) => {
    const mesh = requireMesh(edit.doc, p);
    const skeleton = setupSkeleton(edit.doc);
    const count = (mesh["uvs"] as number[]).length / 2;
    const selected = selectVertices(p.vertices, count);
    const vertices = [...(mesh["vertices"] as number[])];
    const point = { x: 0, y: 0 };
    const table = mesh["bones"] as string[] | undefined;
    if (!table) {
      const bone = skeleton.getBone(slotBoneOf(edit.doc, p.slot));
      for (const v of selected) {
        bone.localToWorld(vertices[2 * v] as number, vertices[2 * v + 1] as number, point);
        const local = toLocal(bone, point.x + p.dx, point.y + p.dy);
        vertices[2 * v] = round(local.x);
        vertices[2 * v + 1] = round(local.y);
      }
      edit.set(pointer(...attachmentTokens(p), "vertices"), vertices);
      return;
    }
    const decoded = decodeWeighted(vertices, count);
    const bones = table.map((name) => skeleton.getBone(name));
    for (const v of selected) {
      for (const inf of (decoded[v] as WeightedVertex).influences) {
        const bone = bones[inf.bone] as Bone;
        bone.localToWorld(inf.x, inf.y, point);
        const local = toLocal(bone, point.x + p.dx, point.y + p.dy);
        inf.x = local.x;
        inf.y = local.y;
      }
    }
    edit.set(pointer(...attachmentTokens(p), "vertices"), encodeWeighted(decoded));
  }
);

define(
  "attachment.set-uvs",
  "Replaces a mesh's UVs (2 values per vertex, 0..1 of its image).",
  { ...meshAddressShape, uvs: z.array(finite().min(0).max(1)) },
  { skin: "body", slot: "core", name: "core", uvs: [0, 0, 1, 0, 1, 1] },
  (edit, p) => {
    const mesh = requireMesh(edit.doc, p);
    if (p.uvs.length !== (mesh["uvs"] as number[]).length) fail(`uvs must keep the vertex count (${(mesh["uvs"] as number[]).length} values)`);
    edit.set(pointer(...attachmentTokens(p), "uvs"), p.uvs);
  }
);

// --- mesh.* ------------------------------------------------------------------------------------

define(
  "mesh.set",
  "Replaces mesh geometry fields together (uvs, triangles, vertices, bones, hull, edges); use for meshes built elsewhere.",
  {
    ...meshAddressShape,
    uvs: z.array(finite()).optional(),
    triangles: z.array(z.number().int().nonnegative()).optional(),
    vertices: z.array(finite()).optional(),
    bones: z.array(nameSchema).nullable().optional(),
    hull: z.number().int().nonnegative().optional(),
    edges: z.array(z.number().int().nonnegative()).nullable().optional()
  },
  { skin: "body", slot: "cloth", name: "cloth", triangles: [0, 1, 2, 0, 2, 3] },
  (edit, p) => {
    requireMesh(edit.doc, p);
    setFields(edit, attachmentTokens(p), pick(p, ["uvs", "triangles", "vertices", "bones", "hull", "edges"]));
    if (p.bones === null) edit.remove(pointer(...attachmentTokens(p), "bones"));
    if (p.edges === null) edit.remove(pointer(...attachmentTokens(p), "edges"));
  }
);

define("mesh.triangles", "Replaces a mesh's triangle list (3 vertex indices per triangle).", { ...meshAddressShape, triangles: z.array(z.number().int().nonnegative()) }, { skin: "body", slot: "cloth", name: "cloth", triangles: [0, 1, 2, 0, 2, 3] }, (edit, p) => {
  requireMesh(edit.doc, p);
  edit.set(pointer(...attachmentTokens(p), "triangles"), p.triangles);
});

define("mesh.hull", "Sets how many leading vertices form the outline.", { ...meshAddressShape, hull: z.number().int().nonnegative() }, { skin: "body", slot: "cloth", name: "cloth", hull: 12 }, (edit, p) => {
  requireMesh(edit.doc, p);
  edit.set(pointer(...attachmentTokens(p), "hull"), p.hull);
});

define(
  "mesh.groups",
  "Sets a mesh's draw groups: slot -> triangle ranges [start, end) partitioning its triangles (null removes them). The mesh is skinned once; each group draws at its slot's draw position.",
  { ...meshAddressShape, groups: z.record(nameSchema, triangleRangesSchema).nullable() },
  { skin: "body", slot: "core", name: "core", groups: { core: [[0, 40]], limb_a: [[40, 64]] } },
  (edit, p) => {
    requireMesh(edit.doc, p);
    const path = pointer(...attachmentTokens(p), "groups");
    if (p.groups === null) edit.remove(path);
    else edit.set(path, p.groups as JsonValue);
  }
);

// --- weights.* ---------------------------------------------------------------------------------

function weightedState(edit: Edit, p: MeshAddress, skeleton: Skeleton): { table: string[]; weights: Influence[][]; world: { x: number; y: number }[] } {
  const mesh = requireMesh(edit.doc, p);
  const world = meshWorld(skeleton, edit.doc, p, mesh);
  const table = mesh["bones"] as string[] | undefined;
  if (!table) return { table: [slotBoneOf(edit.doc, p.slot)], weights: world.map(() => [{ bone: 0, weight: 1 }]), world };
  const decoded = decodeWeighted(mesh["vertices"] as number[], world.length);
  return { table: [...table], weights: decoded.map((vertex) => vertex.influences.map((inf) => ({ bone: inf.bone, weight: inf.weight }))), world };
}

/** Writes weights back with bind positions recomputed from the setup world positions. */
function writeWeights(edit: Edit, p: MeshAddress, skeleton: Skeleton, state: { table: string[]; weights: Influence[][]; world: { x: number; y: number }[] }): void {
  const used = [...new Set(state.weights.flatMap((list) => list.map((inf) => inf.bone)))].sort((a, b) => a - b);
  const remap = new Map(used.map((old, i) => [old, i]));
  const table = used.map((i) => state.table[i] as string);
  const bones = table.map((name) => skeleton.getBone(name));
  const vertices: WeightedVertex[] = state.weights.map((list, v) => {
    const at = state.world[v] as { x: number; y: number };
    return {
      influences: list.map((inf) => {
        const local = toLocal(bones[remap.get(inf.bone) as number] as Bone, at.x, at.y);
        return { bone: remap.get(inf.bone) as number, x: local.x, y: local.y, weight: inf.weight };
      })
    };
  });
  edit.set(pointer(...attachmentTokens(p), "bones"), table);
  edit.set(pointer(...attachmentTokens(p), "vertices"), encodeWeighted(vertices));
}

define("weights.bind", "Binds an unweighted mesh rigidly to one bone (weights 1), keeping its setup shape.", { ...meshAddressShape, bone: nameSchema }, { skin: "body", slot: "cloth", name: "cloth", bone: "trunk" }, (edit, p) => {
  const mesh = requireMesh(edit.doc, p);
  if (mesh["bones"]) fail(`${p.skin}/${p.slot}/${p.name} is already weighted; use weights.set`);
  indexByName(edit.doc, "bones", p.bone, "bone");
  const skeleton = setupSkeleton(edit.doc);
  const world = meshWorld(skeleton, edit.doc, p, mesh);
  writeWeights(edit, p, skeleton, { table: [p.bone], weights: world.map(() => [{ bone: 0, weight: 1 }]), world });
});

define("weights.unbind", "Turns a weighted mesh back into an unweighted one on its slot bone, keeping its setup shape.", meshAddressShape, { skin: "body", slot: "cloth", name: "cloth" }, (edit, p) => {
  const mesh = requireMesh(edit.doc, p);
  if (!mesh["bones"]) fail(`${p.skin}/${p.slot}/${p.name} is not weighted`);
  const skeleton = setupSkeleton(edit.doc);
  const bone = skeleton.getBone(slotBoneOf(edit.doc, p.slot));
  const world = meshWorld(skeleton, edit.doc, p, mesh);
  edit.remove(pointer(...attachmentTokens(p), "bones"));
  edit.set(
    pointer(...attachmentTokens(p), "vertices"),
    world.flatMap(({ x, y }) => {
      const local = toLocal(bone, x, y);
      return [round(local.x), round(local.y)];
    })
  );
});

define(
  "weights.set",
  "Sets the influences of the listed vertices ({bone, weight} list, normalised to 1, at most 4); binds an unweighted mesh to its slot bone first.",
  { ...meshAddressShape, vertices: z.array(z.number().int().nonnegative()).min(1), influences: z.array(z.object({ bone: nameSchema, weight: finite().positive() }).strict()).min(1).max(MAX_VERTEX_INFLUENCES) },
  { skin: "body", slot: "core", name: "core", vertices: [10, 11], influences: [{ bone: "trunk", weight: 0.7 }, { bone: "spine", weight: 0.3 }] },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const state = weightedState(edit, p, skeleton);
    const selected = selectVertices(p.vertices, state.world.length);
    const list = p.influences.map((inf) => {
      indexByName(edit.doc, "bones", inf.bone, "bone");
      let index = state.table.indexOf(inf.bone);
      if (index < 0) index = state.table.push(inf.bone) - 1;
      return { bone: index, weight: inf.weight };
    });
    if (new Set(list.map((inf) => inf.bone)).size !== list.length) fail("a bone is listed twice in influences");
    const normalised = normalizeInfluences(list.sort((a, b) => b.weight - a.weight));
    for (const v of selected) state.weights[v] = normalised.map((inf) => ({ ...inf }));
    writeWeights(edit, p, skeleton, state);
  }
);

define(
  "weights.prune",
  "Keeps at most `max` influences per vertex, drops weights under `min`, renormalises.",
  { ...meshAddressShape, max: z.number().int().min(1).max(MAX_VERTEX_INFLUENCES).optional(), min: finite().min(0).max(0.5).optional() },
  { skin: "body", slot: "core", name: "core", max: 3, min: 0.05 },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const state = weightedState(edit, p, skeleton);
    state.weights = pruneWeights(state.weights, p.max ?? MAX_VERTEX_INFLUENCES, p.min ?? 0.02);
    writeWeights(edit, p, skeleton, state);
  }
);

define(
  "weights.smooth",
  "Smooths weights over the mesh edges (each pass moves a vertex halfway to its neighbours' average), then prunes to 4 influences.",
  { ...meshAddressShape, iterations: z.number().int().min(1).max(20).optional(), vertices: z.array(z.number().int().nonnegative()).optional() },
  { skin: "body", slot: "core", name: "core", iterations: 2 },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const state = weightedState(edit, p, skeleton);
    const mesh = requireMesh(edit.doc, p);
    const neighbours = adjacency(state.world.length, mesh["triangles"] as number[]);
    const selected = new Set(selectVertices(p.vertices, state.world.length));
    for (let i = 0; i < (p.iterations ?? 1); i++) state.weights = smoothWeights(state.weights, neighbours, (v) => selected.has(v), state.table.length);
    state.weights = pruneWeights(state.weights, MAX_VERTEX_INFLUENCES, 0.02);
    writeWeights(edit, p, skeleton, state);
  }
);

define(
  "weights.seam",
  "Binds the vertices along a cut line (canvas points [[x1, y1], [x2, y2]], extended 15% each way) to one bone: rigid within `hard` px (default 22), then smoothed out to `soft` px (default 45). For a part split off with `atlas split`: give both sides of the cut the bone they hang from (the tail's base and the body edge beside it both on the pelvis), so the seam stays shut while the limbs nearby move.",
  { ...meshAddressShape, bone: nameSchema, line: z.tuple([z.tuple([finite(), finite()]), z.tuple([finite(), finite()])]), hard: finite().positive().optional(), soft: finite().positive().optional() },
  { skin: "body", slot: "core", name: "core", bone: "trunk", line: [[40, 60], [20, 90]] },
  (edit, p) => {
    indexByName(edit.doc, "bones", p.bone, "bone");
    const skeleton = setupSkeleton(edit.doc);
    const state = weightedState(edit, p, skeleton);
    const canvas = (edit.doc["canvas"] ?? {}) as { originX?: number; originY?: number };
    const [a, b] = p.line.map(([x, y]) => ({ x: x - Number(canvas.originX ?? 0), y: y - Number(canvas.originY ?? 0) })) as [Point, Point];
    const ext = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const hard = p.hard ?? 22;
    const soft = Math.max(hard, p.soft ?? 45);
    const near: number[] = [];
    const ring: number[] = [];
    state.world.forEach(({ x, y }, v) => {
      const d = segmentDistance(x, y, ext(-0.15), ext(1.15));
      if (d <= hard) near.push(v);
      else if (d <= soft) ring.push(v);
    });
    if (near.length + ring.length === 0) fail(`weights.seam: no vertex of ${p.skin}/${p.slot}/${p.name} lies within ${soft} px of the line`);
    let index = state.table.indexOf(p.bone);
    if (index < 0) index = state.table.push(p.bone) - 1;
    for (const v of [...near, ...ring]) state.weights[v] = [{ bone: index, weight: 1 }];
    if (ring.length > 0) {
      const mesh = requireMesh(edit.doc, p);
      const neighbours = adjacency(state.world.length, mesh["triangles"] as number[]);
      const selected = new Set(ring);
      state.weights = smoothWeights(state.weights, neighbours, (v) => selected.has(v), state.table.length);
      state.weights = pruneWeights(state.weights, MAX_VERTEX_INFLUENCES, 0.02);
    }
    edit.notes.push({ level: "info", message: `weights.seam ${p.skin}/${p.slot}/${p.name}: ${near.length} vertices on ${p.bone}, ${ring.length} blended out to ${soft} px` });
    writeWeights(edit, p, skeleton, state);
  }
);

define(
  "weights.assign",
  "Sets per-vertex influence lists in one step (a weight-paint stroke): weights [{vertex, influences: [{bone, weight}]}], each list normalised, at most 4.",
  {
    ...meshAddressShape,
    weights: z
      .array(z.object({ vertex: z.number().int().nonnegative(), influences: z.array(z.object({ bone: nameSchema, weight: finite().positive() }).strict()).min(1).max(MAX_VERTEX_INFLUENCES) }).strict())
      .min(1)
  },
  { skin: "body", slot: "core", name: "core", weights: [{ vertex: 4, influences: [{ bone: "trunk", weight: 0.6 }, { bone: "spine", weight: 0.4 }] }] },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const state = weightedState(edit, p, skeleton);
    const known = new Set(boneNames(edit.doc));
    const seen = new Set<number>();
    for (const entry of p.weights) {
      if (entry.vertex >= state.world.length) fail(`vertex ${entry.vertex} is out of range (mesh has ${state.world.length} vertices)`);
      if (seen.has(entry.vertex)) fail(`vertex ${entry.vertex} is listed twice`);
      seen.add(entry.vertex);
      const list = entry.influences.map((inf) => {
        if (!known.has(inf.bone)) fail(`no bone '${inf.bone}'`);
        let index = state.table.indexOf(inf.bone);
        if (index < 0) index = state.table.push(inf.bone) - 1;
        return { bone: index, weight: inf.weight };
      });
      if (new Set(list.map((inf) => inf.bone)).size !== list.length) fail(`vertex ${entry.vertex}: a bone is listed twice`);
      state.weights[entry.vertex] = normalizeInfluences(list.sort((a, b) => b.weight - a.weight));
    }
    writeWeights(edit, p, skeleton, state);
  }
);

/** A bone of the setup pose as a weight segment (skeleton space), with a body radius. */
function weightBone(skeleton: Skeleton, name: string, radius: number): WeightBone {
  const bone = skeleton.getBone(name);
  const start = { x: 0, y: 0 };
  const end = { x: 0, y: 0 };
  bone.localToWorld(0, 0, start);
  bone.localToWorld(Math.max(bone.data.length, 1e-3), 0, end);
  return { name, start, end, radius };
}

/** True when `ancestor` is a strict ancestor of `bone` in the document's skeleton. */
function descendsFrom(doc: JsonObject, bone: string, ancestor: string): boolean {
  const parents = new Map(arrayAt(doc, "bones").map((b) => [b["name"] as string, b["parent"] as string | undefined]));
  for (let at = parents.get(bone); at !== undefined; at = parents.get(at)) if (at === ancestor) return true;
  return false;
}

/**
 * The bone tree of `weights.auto`: from `bones` (one chain, each bone descending from the one
 * before) or `chains` (explicit chain roots). A branched `bones` list is refused, never flattened.
 * Returns the bone names in order and each one's parent index in that order (-1 for the root).
 */
function weightTreeSpec(doc: JsonObject, p: { bones?: string[] | undefined; chains?: { bones: string[]; parent?: string | undefined; radius?: number | undefined }[] | undefined }): { names: string[]; parents: number[]; radii: (number | undefined)[]; chainOf: number[] } {
  if ((p.bones === undefined) === (p.chains === undefined)) fail("give exactly one of `bones` (one chain) or `chains` (a tree with explicit chain roots)");
  const chains = p.chains ?? [{ bones: p.bones as string[] }];
  const names: string[] = [];
  const parents: number[] = [];
  const radii: (number | undefined)[] = [];
  const chainOf: number[] = [];
  chains.forEach((chain, c) => {
    for (const name of chain.bones) indexByName(doc, "bones", name, "bone");
    let parent = -1;
    if (c === 0) {
      if (chain.parent !== undefined) fail("the first chain is the trunk: it has no `parent`");
    } else {
      const parentName = chain.parent ?? fail(`chain ${c + 1} (${chain.bones[0]}...) needs a \`parent\`: the bone of an earlier chain it hangs from`);
      parent = names.indexOf(parentName);
      if (parent < 0) fail(`chain ${c + 1}'s parent '${parentName}' is not a bone of an earlier chain`);
      if (!descendsFrom(doc, chain.bones[0] as string, parentName)) fail(`chain ${c + 1}: '${chain.bones[0]}' does not descend from its parent '${parentName}' in the skeleton`);
    }
    chain.bones.forEach((name, k) => {
      if (names.includes(name)) fail(`bone '${name}' is listed twice`);
      if (k > 0 && !descendsFrom(doc, name, chain.bones[k - 1] as string)) {
        const where = p.chains ? `chain ${c + 1}` : "bones";
        fail(`${where} is not one chain: '${name}' does not descend from '${chain.bones[k - 1]}' (a branched list would be flattened); pass \`chains\` with explicit chain roots instead`);
      }
      parents.push(k === 0 ? parent : names.length - 1);
      radii.push(chain.radius);
      chainOf.push(c);
      names.push(name);
    });
  });
  return { names, parents, radii, chainOf };
}

// Plan: no authoring caps on chain length, chain count or tree size beyond the engine's own
// (a weighted mesh's bone table is unbounded; each vertex keeps at most MAX_VERTEX_INFLUENCES).
const weightChainSchema = z.object({ bones: z.array(nameSchema).min(1), parent: nameSchema.optional(), radius: finite().positive().optional() }).strict();

define(
  "weights.auto",
  "Computes heat weights for a mesh from a bone chain (`bones`, parent to child) or a bone tree (`chains`, each later chain naming the `parent` bone it hangs from); each branch keeps its own influence domain; pruned to 4 influences; vertices keep their setup positions. Body radius: a chain's own `radius`, else the global `radius`, else measured from the hull. Reports the vertex count per domain and the ambiguous vertices (two branches at nearly the same distance: split the mesh) in its notes.",
  {
    ...meshAddressShape,
    bones: z.array(nameSchema).min(1).optional(),
    chains: z.array(weightChainSchema).min(1).optional(),
    radius: finite().positive().optional(),
    heat: finite().positive().max(10).optional(),
    smooth: z.number().int().min(0).max(10).optional(),
    hubPolicy: z.enum(["warn", "reject"]).optional()
  },
  { skin: "body", slot: "limb_a", name: "limb_a", bones: ["upper_a", "lower_a", "tip_a"] },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const mesh = requireMesh(edit.doc, p);
    const spec = weightTreeSpec(edit.doc, p);
    const world = meshWorld(skeleton, edit.doc, p, mesh);
    const points = world.flatMap(({ x, y }) => [x, y]);
    const triangles = mesh["triangles"] as number[];
    // Body radius per bone: the median distance of the hull vertices nearest to it.
    const segments = spec.names.map((name) => weightBone(skeleton, name, 1));
    const hull = Math.min(Number(mesh["hull"] ?? world.length), world.length) || world.length;
    const distances: number[][] = segments.map(() => []);
    // Plan: a hull sample equidistant from several segments (coincident siblings) is shared
    // by all of them, never given to the first listed, so radii do not depend on sibling order.
    for (let v = 0; v < hull; v++) {
      const at = world[v] as { x: number; y: number };
      const d = segments.map((segment) => segmentDistance(at.x, at.y, segment.start, segment.end));
      const bestDistance = Math.min(...d);
      const tolerance = 1e-6 * Math.max(1, bestDistance);
      d.forEach((dk, k) => {
        if (dk <= bestDistance + tolerance) (distances[k] as number[]).push(bestDistance);
      });
    }
    // Plan: the mesh's authoring domain (allowed influences, radius overrides, transition
    // widths) and the authoring connections between chains are enforced inside the solve.
    // An authoring block that fails to parse is an error, never silently ignored.
    const parsed = parseAnimDocument(edit.doc);
    if (!parsed.ok && (edit.doc as { authoring?: unknown }).authoring !== undefined) {
      fail(`weights.auto: the document has an authoring block but does not parse, so its domains and connections cannot be applied: ${parsed.issues
          .filter((i) => i.severity === "error")
          .slice(0, 8)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }
    const loaded = parsed.ok ? parsed.document : undefined;
    const domain = loaded ? domainFor(loaded, p) : undefined;
    const radiusOverride = domain?.radius ?? {};
    const tree: WeightTree = {
      bones: segments.map((segment, k) => {
        const list = (distances[k] as number[]).sort((a, b) => a - b);
        const median = list.length > 0 ? (list[Math.floor(list.length / 2)] as number) : 12;
        // Second rig acceptance: a side chain (limb, ear, tail) owns vertices out to its own length;
        // past that the trunk wins (the mouse's back edge went to a short thigh 200 px away).
        const c = spec.chainOf[k] as number;
        const reach = c === 0 ? undefined : segments.reduce((sum, s, j) => (spec.chainOf[j] === c ? sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) : sum), 0);
        return { ...segment, radius: radiusOverride[spec.names[k] as string] ?? spec.radii[k] ?? p.radius ?? Math.max(4, median), parent: spec.parents[k] as number, ...(reach !== undefined ? { reach } : {}) };
      })
    };
    const index = (name: string) => spec.names.indexOf(name);
    const jointWidth = new Map<number, number>();
    for (const t of domain?.transitions ?? []) {
      const [a, b] = t.bones.map(index) as [number, number];
      if (a < 0 || b < 0) continue;
      if (spec.parents[b] === a) jointWidth.set(b, t.width);
      else if (spec.parents[a] === b) jointWidth.set(a, t.width);
      else fail(`domain '${domain?.id}': transition ${t.bones.join(" - ")} is not a parent and child of the weight tree`);
    }
    const connections = (loaded ? (loaded.authoring?.connections ?? []).map((c) => ({ c, doc: loaded })) : [])
      .map(({ c, doc }) => ({ kind: c.kind, a: chainBones(doc, c.between[0]).map(index).filter((k) => k >= 0), b: chainBones(doc, c.between[1]).map(index).filter((k) => k >= 0) }))
      .filter((c) => c.a.length > 0 && c.b.length > 0);
    const allowedBones = domain ? new Set(domain.bones) : null;
    if (allowedBones && !spec.names.some((name) => allowedBones.has(name))) fail(`domain '${domain?.id}' allows none of the tree's bones (${spec.names.join(", ")})`);
    const result = autoWeightsTree({ points, triangles }, tree, {
      ...(p.heat !== undefined ? { heat: p.heat } : {}),
      ...(p.smooth !== undefined ? { smooth: p.smooth } : {}),
      ...(p.hubPolicy !== undefined ? { hubPolicy: p.hubPolicy } : {}),
      ...(allowedBones ? { allow: (k: number) => allowedBones.has(spec.names[k] as string) } : {}),
      ...(jointWidth.size > 0 ? { jointWidth } : {}),
      ...(connections.length > 0 ? { connections } : {})
    });
    if (domain) edit.notes.push({ level: "info", message: `weights.auto ${p.skin}/${p.slot}/${p.name}: domain '${domain.id}' (${domain.bones.length} allowed bone(s)${connections.length > 0 ? `, ${connections.length} connection(s)` : ""})` });
    writeWeights(edit, p, skeleton, { table: spec.names, weights: result.weights, world });
    const counts = spec.names.map(() => 0);
    for (const k of result.domains) counts[k] = (counts[k] as number) + 1;
    const where = `${p.skin}/${p.slot}/${p.name}`;
    edit.notes.push({ level: "info", message: `weights.auto ${where}: domains ${spec.names.map((name, k) => `${name} ${counts[k]}`).join(", ")}` });
    if (result.ambiguous > 0) {
      // Plan: vertex IDs and the competing bones (top three non-adjacent), not only a count.
      const listed = result.diagnostics.ambiguities
        .slice(0, 12)
        .map((a) => `v${a.vertex} ${spec.names[a.owner]} vs ${a.competitors.map((c) => spec.names[c.bone]).join("/")}`)
        .join(", ");
      edit.notes.push({
        level: "warning",
        vertices: result.diagnostics.ambiguities.map((a) => a.vertex),
        message: `weights.auto ${where}: ${result.ambiguous} ambiguous vertices (two non-adjacent branches at nearly the same distance); the domain split there is a guess: split the mesh, or give the chains their own \`radius\`: ${listed}${result.ambiguous > 12 ? ", ..." : ""} (overlay: animator weights overview --ambiguous)`
      });
    }
    const { clamped, pruning } = result.diagnostics;
    if (clamped.vertices.length > 0 && clamped.maxMagnitude > 1e-3) {
      edit.notes.push({ level: "warning", message: `weights.auto ${where}: heat weights outside [0, 1] at ${clamped.vertices.length} vertices before the clamp (largest overshoot ${clamped.maxMagnitude.toFixed(3)}; obtuse triangles: remesh)` });
    }
    if (pruning.overVertices.length > 0) {
      edit.notes.push({
        level: "warning",
        message: `weights.auto ${where}: ${pruning.overVertices.length} vertices need more than 4 influences (largest dropped mass ${pruning.maxDiscarded.toFixed(3)}, posed error ${pruning.maxErrorPx.toFixed(2)} px at v${pruning.worstVertex}); split the hub, or pass hubPolicy "reject" to fail`
      });
    }
  }
);

define(
  "weights.weld",
  "Gives coincident vertices of several meshes (setup positions within `tolerance` px) the same averaged weights, so seams deform together.",
  { meshes: z.array(z.object(meshAddressShape).strict()).min(2).max(16), tolerance: finite().positive().max(8).optional() },
  { meshes: [{ skin: "body", slot: "core", name: "core" }, { skin: "body", slot: "limb_a.cap", name: "limb_a.cap" }], tolerance: 1 },
  (edit, p) => {
    const skeleton = setupSkeleton(edit.doc);
    const global: string[] = [];
    const states = p.meshes.map((address) => {
      const state = weightedState(edit, address, skeleton);
      const weights = state.weights.map((list) =>
        list.map((inf) => {
          const name = state.table[inf.bone] as string;
          let index = global.indexOf(name);
          if (index < 0) index = global.push(name) - 1;
          return { bone: index, weight: inf.weight };
        })
      );
      return { address, state, points: state.world.flatMap(({ x, y }) => [x, y]), weights };
    });
    weldWeights(states, p.tolerance ?? 0.5, MAX_VERTEX_INFLUENCES);
    for (const entry of states) writeWeights(edit, entry.address, skeleton, { table: [...global], weights: entry.weights, world: entry.state.world });
  }
);

// --- mesh.generate -----------------------------------------------------------------------------

const outlinePointSchema = z.tuple([finite(), finite()]);

/** Image pixel (0..width, 0..height) of an attachment to setup world, for regions and meshes. */
function imageToWorld(skeleton: Skeleton, doc: JsonObject, address: MeshAddress, attachment: JsonObject): (u: number, v: number) => { x: number; y: number } {
  const width = Number(attachment["width"]);
  const height = Number(attachment["height"]);
  if (attachment["type"] === "region") {
    const bone = skeleton.getBone(slotBoneOf(doc, address.slot));
    const angle = (Number(attachment["rotation"] ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const sx = Number(attachment["scaleX"] ?? 1);
    const sy = Number(attachment["scaleY"] ?? 1);
    const cx = Number(attachment["x"] ?? 0);
    const cy = Number(attachment["y"] ?? 0);
    return (u, v) => {
      const lx = (u - width / 2) * sx;
      const ly = (v - height / 2) * sy;
      const out = { x: 0, y: 0 };
      bone.localToWorld(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos, out);
      return out;
    };
  }
  // Mesh: least-squares affine map from image pixels (uv * size) to setup world positions.
  const world = meshWorld(skeleton, doc, address, attachment);
  const uvs = attachment["uvs"] as number[];
  const rows = world.map((at, i) => ({ u: (uvs[2 * i] as number) * width, v: (uvs[2 * i + 1] as number) * height, x: at.x, y: at.y }));
  const det = (a: readonly number[]) =>
    (a[0] as number) * ((a[4] as number) * (a[8] as number) - (a[5] as number) * (a[7] as number)) -
    (a[1] as number) * ((a[3] as number) * (a[8] as number) - (a[5] as number) * (a[6] as number)) +
    (a[2] as number) * ((a[3] as number) * (a[7] as number) - (a[4] as number) * (a[6] as number));
  const solve = (value: (row: (typeof rows)[number]) => number): [number, number, number] => {
    // Normal equations for value = a*u + b*v + c, solved by Cramer's rule.
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = [0, 0, 0];
    for (const row of rows) {
      const basis = [row.u, row.v, 1];
      for (let i = 0; i < 3; i++) {
        r[i] = (r[i] as number) + (basis[i] as number) * value(row);
        for (let j = 0; j < 3; j++) m[i * 3 + j] = (m[i * 3 + j] as number) + (basis[i] as number) * (basis[j] as number);
      }
    }
    const d = det(m);
    if (Math.abs(d) < 1e-9) fail(`${address.skin}/${address.slot}/${address.name}: its UVs do not span the image, cannot place a new mesh`);
    const column = (k: number) => m.map((entry, index) => (index % 3 === k ? (r[Math.floor(index / 3)] as number) : entry));
    return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
  };
  const [ax, bx, cx] = solve((row) => row.x);
  const [ay, by, cy] = solve((row) => row.y);
  return (u, v) => ({ x: ax * u + bx * v + cx, y: ay * u + by * v + cy });
}

define(
  "mesh.generate",
  "Builds a mesh for an attachment (a region becomes a mesh) from an outline in its image pixels ({outer, holes?} as [x, y] lists), or from its current hull; a weighted mesh keeps its weights (interpolated).",
  {
    ...meshAddressShape,
    outline: z.object({ outer: z.array(outlinePointSchema).min(3), holes: z.array(z.array(outlinePointSchema).min(3)).optional() }).strict().optional(),
    targetVertices: z.number().int().min(4).max(400).optional(),
    spacing: finite().positive().optional(),
    bridgeNotches: z.boolean().optional()
  },
  { skin: "body", slot: "core", name: "core", targetVertices: 60 },
  (edit, p) => {
    const attachment = requireAttachment(edit.doc, p);
    const type = attachment["type"];
    if (type !== "mesh" && type !== "region") fail(`${p.skin}/${p.slot}/${p.name} is a ${String(type)}; mesh.generate needs a region or a mesh`);
    const width = Number(attachment["width"]);
    const height = Number(attachment["height"]);
    const skeleton = setupSkeleton(edit.doc);
    const toWorld = imageToWorld(skeleton, edit.doc, p, attachment);
    let outer: Point[];
    let holes: Point[][] = [];
    if (p.outline) {
      outer = p.outline.outer.map(([x, y]) => ({ x, y }));
      holes = (p.outline.holes ?? []).map((hole) => hole.map(([x, y]) => ({ x, y })));
    } else if (type === "mesh") {
      const uvs = attachment["uvs"] as number[];
      const hull = Number(attachment["hull"]);
      if (hull < 3) fail(`${p.skin}/${p.slot}/${p.name} has no hull to regenerate from; pass an outline`);
      outer = Array.from({ length: hull }, (_, i) => ({ x: (uvs[2 * i] as number) * width, y: (uvs[2 * i + 1] as number) * height }));
    } else {
      outer = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    }
    if (polygonArea(outer) < 0) outer.reverse();
    holes = holes.map((hole) => (polygonArea(hole) > 0 ? [...hole].reverse() : hole));
    let built: ReturnType<typeof autoMesh>;
    try {
      built = autoMesh(
        { outer, holes },
        {
          ...(p.targetVertices !== undefined ? { targetVertices: p.targetVertices } : {}),
          ...(p.spacing !== undefined ? { spacing: p.spacing } : {}),
          ...(p.bridgeNotches !== undefined ? { bridgeNotches: p.bridgeNotches } : {})
        }
      );
    } catch (error) {
      return fail(`mesh.generate: ${error instanceof Error ? error.message : String(error)}`);
    }
    const count = built.points.length / 2;
    // Second rig acceptance: say when the vertex target forced a coarser hull than the outline.
    if (built.hullPolygon.length < outer.length) {
      let push = 0;
      for (const q of built.hullPolygon) {
        let d = Infinity;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) d = Math.min(d, segmentDistance(q.x, q.y, outer[j] as Point, outer[i] as Point));
        push = Math.max(push, d);
      }
      edit.notes.push({ level: "info", message: `mesh.generate ${p.skin}/${p.slot}/${p.name}: simplified the ${outer.length}-point outline to a ${built.hullPolygon.length}-point hull to meet the vertex budget (${count} vertices, spacing ${built.spacing.toFixed(1)} px; the hull stands up to ${push.toFixed(1)} px off the outline; raise --target or pass --spacing for a closer fit)` });
    }
    const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
    const uvs: number[] = [];
    const world: { x: number; y: number }[] = [];
    // The simplified hull is pushed outward to contain the dropped outline points, so at a rounded
    // tip touching the image edge its corner lands past the edge. Clamp the point itself (not only
    // its UV): a position past the edge with a clamped UV stretches the edge texels outward (second
    // rig acceptance: the mouse rendered 5 px wider than its art at the feather and tail tips).
    for (let v = 0; v < count; v++) {
      const u = Math.min(width, Math.max(0, built.points[2 * v] as number));
      const w = Math.min(height, Math.max(0, built.points[2 * v + 1] as number));
      uvs.push(Number(clampUnit(u / width).toFixed(6)), Number(clampUnit(w / height).toFixed(6)));
      world.push(toWorld(u, w));
    }
    const tokens = attachmentTokens(p);
    const geometry = { triangles: Array.from(built.triangles), hull: built.hull, edges: Array.from(built.edges), uvs };
    const unweighted = () => {
      const bone = skeleton.getBone(slotBoneOf(edit.doc, p.slot));
      return world.flatMap(({ x, y }) => {
        const local = toLocal(bone, x, y);
        return [round(local.x), round(local.y)];
      });
    };
    if (type === "region") {
      const mesh: JsonObject = { type: "mesh", path: attachment["path"] as JsonValue, ...geometry, vertices: unweighted(), width, height };
      if (attachment["color"] !== undefined) mesh["color"] = attachment["color"] as JsonValue;
      edit.set(pointer(...tokens), mesh);
      return;
    }
    if (!attachment["bones"]) {
      setFields(edit, tokens, { ...geometry, vertices: unweighted() });
      return;
    }
    const old = weightedState(edit, p, skeleton);
    const oldMesh = { points: old.world.flatMap(({ x, y }) => [x, y]), triangles: attachment["triangles"] as number[] };
    const weights = world.map(({ x, y }) => weightsAtPoint(oldMesh, old.weights, x, y));
    setFields(edit, tokens, geometry);
    writeWeights(edit, p, skeleton, { table: old.table, weights, world });
  }
);

// --- mesh.edit and weights.table (plan MESH-WEIGHTS-PLAN D1) ---------------------------------------

function guarded<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof MeshEditError) return fail(error.message);
    throw error;
  }
}

function geomOf(mesh: JsonObject, slotBone: string): DeformGeom {
  return { count: (mesh["uvs"] as number[]).length / 2, vertices: mesh["vertices"] as number[], bones: mesh["bones"] as string[] | undefined, slotBone };
}

/** Applies the deform and reference rewrites a layout or topology change owes (all in the caller's patch). */
function applyPlanned(edit: Edit, writes: readonly PlannedWrite[]): void {
  for (const write of writes) edit.set(pointer(...write.path), write.value);
}

define(
  "mesh.edit",
  "Replaces a mesh's topology in one step: `points` (image pixels, x y per vertex), `triangles`, `hull` (leading outline vertices), optional `edges`, and `origin` (old index of each new vertex, -1 = new). Recomputes UVs and setup positions; new vertices take interpolated weights; deform keys (clips, correctives, grids), contour vertex references and other meshes' embed references follow `origin`. Refuses meshes with draw groups, coverage regions or an own embedding, and references to deleted vertices.",
  {
    ...meshAddressShape,
    points: z.array(finite()).min(6),
    triangles: z.array(z.number().int().nonnegative()),
    hull: z.number().int().nonnegative(),
    edges: z.array(z.number().int().nonnegative()).optional(),
    origin: z.array(z.number().int().min(-1))
  },
  { skin: "body", slot: "core", name: "core", points: [0, 0, 60, 0, 60, 120, 0, 120], triangles: [0, 1, 2, 0, 2, 3], hull: 4, origin: [0, 5, 9, 4] },
  (edit, p) => {
    guarded(() => {
      const mesh = requireMesh(edit.doc, p);
      checkMeshEditable(edit.doc, p, mesh);
      const count = p.points.length / 2;
      if (!Number.isInteger(count)) fail("points needs two values (x, y) per vertex");
      if (p.origin.length !== count) fail(`origin needs one entry per vertex (${count}), got ${p.origin.length}`);
      const oldCount = (mesh["uvs"] as number[]).length / 2;
      for (const old of p.origin) if (old >= oldCount) fail(`origin names old vertex ${old}, but the mesh has ${oldCount} vertices`);
      const width = Number(mesh["width"]);
      const height = Number(mesh["height"]);
      const skeleton = setupSkeleton(edit.doc);
      const slotBone = slotBoneOf(edit.doc, p.slot);
      const toWorld = imageToWorld(skeleton, edit.doc, p, mesh);
      const old = weightedState(edit, p, skeleton);
      const oldUvs = mesh["uvs"] as number[];
      const oldGeom = geomOf(mesh, slotBone);
      const oldMesh = { points: old.world.flatMap(({ x, y }) => [x, y]), triangles: mesh["triangles"] as number[] };
      const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
      const uvs: number[] = [];
      const world: { x: number; y: number }[] = [];
      const weights: Influence[][] = [];
      for (let v = 0; v < count; v++) {
        const x = Math.min(width, Math.max(0, p.points[2 * v] as number));
        const y = Math.min(height, Math.max(0, p.points[2 * v + 1] as number));
        uvs.push(Number(clampUnit(x / width).toFixed(6)), Number(clampUnit(y / height).toFixed(6)));
        const from = p.origin[v] as number;
        const unmoved = from >= 0 && Math.abs((oldUvs[2 * from] as number) * width - x) < 1e-3 && Math.abs((oldUvs[2 * from + 1] as number) * height - y) < 1e-3;
        const at = unmoved ? (old.world[from] as { x: number; y: number }) : toWorld(x, y);
        world.push(at);
        weights.push(from >= 0 ? (old.weights[from] as Influence[]).map((inf) => ({ ...inf })) : weightsAtPoint(oldMesh, old.weights, at.x, at.y));
      }
      const tokens = attachmentTokens(p);
      const oldEdges = mesh["edges"] as number[] | undefined;
      const newOf = oldToNewMap(p.origin);
      let edges = p.edges;
      if (!edges && oldEdges) {
        edges = [];
        for (let i = 0; i + 1 < oldEdges.length; i += 2) {
          const a = newOf.get(oldEdges[i] as number);
          const b = newOf.get(oldEdges[i + 1] as number);
          if (a !== undefined && b !== undefined) edges.push(a, b);
        }
      }
      setFields(edit, tokens, { uvs, triangles: p.triangles, hull: p.hull });
      if (edges && edges.length > 0) edit.set(pointer(...tokens, "edges"), edges);
      else edit.remove(pointer(...tokens, "edges"));
      if (mesh["bones"]) {
        writeWeights(edit, p, skeleton, { table: old.table, weights, world });
      } else {
        const bone = skeleton.getBone(slotBone);
        edit.set(
          pointer(...tokens, "vertices"),
          world.flatMap(({ x, y }) => {
            const local = toLocal(bone, x, y);
            return [round(local.x), round(local.y)];
          })
        );
      }
      const newGeom = geomOf(requireMesh(edit.doc, p), slotBone);
      applyPlanned(edit, planDeformRemap(edit.doc, p, remapDeform(oldGeom, newGeom, p.origin, skeleton)));
      applyPlanned(edit, planReferenceRemap(edit.doc, p, p.origin));
    });
  }
);

define(
  "weights.table",
  "Writes a whole weight table in one step: `influences` lists B bones (the table's columns) and `weights` holds vertices x B values row-major. Rebuilds the setup skeleton once, prunes to `max` influences (default and ceiling 4) and weights under `min` (default 0.02), normalises, and re-encodes the mesh's deform keys when a vertex's influences change so each keeps its setup-pose world offset.",
  {
    ...meshAddressShape,
    influences: z.array(nameSchema).min(1),
    weights: z.array(finite().min(0)),
    max: z.number().int().min(1).max(MAX_VERTEX_INFLUENCES).optional(),
    min: finite().min(0).max(0.5).optional()
  },
  { skin: "body", slot: "core", name: "core", influences: ["base_a", "upper_a"], weights: [1, 0, 1, 0, 0.5, 0.5, 0, 1, 0, 1, 0, 1, 0, 1, 0.5, 0.5, 1, 0, 1, 0] },
  (edit, p) => {
    guarded(() => {
      const mesh = requireMesh(edit.doc, p);
      const columns = p.influences.length;
      if (new Set(p.influences).size !== columns) fail("a bone is listed twice in influences");
      for (const name of p.influences) indexByName(edit.doc, "bones", name, "bone");
      const skeleton = setupSkeleton(edit.doc);
      const state = weightedState(edit, p, skeleton);
      const count = state.world.length;
      if (p.weights.length !== count * columns) fail(`weights needs ${count} vertices x ${columns} bones = ${count * columns} values, got ${p.weights.length}`);
      const oldGeom = geomOf(mesh, slotBoneOf(edit.doc, p.slot));
      const rows: Influence[][] = [];
      for (let v = 0; v < count; v++) {
        const list: Influence[] = [];
        for (let b = 0; b < columns; b++) {
          const weight = p.weights[v * columns + b] as number;
          if (weight > 0) list.push({ bone: b, weight });
        }
        if (list.length === 0) fail(`vertex ${v} has no weight on any listed bone`);
        rows.push(list);
      }
      const capped = pruneWeights(rows, p.max ?? MAX_VERTEX_INFLUENCES, p.min ?? 0.02);
      writeWeights(edit, p, skeleton, { table: [...p.influences], weights: capped, world: state.world });
      const newGeom = geomOf(requireMesh(edit.doc, p), oldGeom.slotBone);
      const identity = Array.from({ length: count }, (_, v) => v);
      applyPlanned(edit, planDeformRemap(edit.doc, p, remapDeform(oldGeom, newGeom, identity, skeleton)));
    });
  }
);

// --- constraint.* ------------------------------------------------------------------------------

const CONSTRAINT_KINDS = { ik: ikConstraintSchema, transform: transformConstraintSchema, path: pathConstraintSchema, physics: physicsConstraintSchema } as const;
const constraintKind = z.enum(["ik", "transform", "path", "physics"]);

define(
  "constraint.add",
  "Adds an ik, transform, path or physics constraint (`constraint` holds its fields, including name).",
  { kind: constraintKind, constraint: z.record(z.unknown()) },
  { kind: "physics", constraint: { name: "cape_1", bone: "cape_1", rotate: 1, inertia: 0.6, strength: 60, damping: 0.85, gravity: 60 } },
  (edit, p) => {
    CONSTRAINT_KINDS[p.kind].parse(p.constraint);
    const name = String(p.constraint["name"]);
    for (const kind of constraintKind.options) requireFree(arrayAt(edit.doc, kind).map((c) => String(c["name"])), name, "constraint");
    if (!Array.isArray(edit.doc[p.kind])) edit.set(pointer(p.kind), []);
    edit.apply({ op: "add", path: pointer(p.kind, arrayAt(edit.doc, p.kind).length), value: p.constraint as JsonValue });
  }
);

define(
  "constraint.set",
  "Sets fields of a constraint (null removes a field), e.g. mix, softness, strength, damping.",
  { kind: constraintKind, name: nameSchema, fields: z.record(z.unknown()) },
  { kind: "ik", name: "tip_b", fields: { mix: 1, bendPositive: false } },
  (edit, p) => {
    if ("name" in p.fields) fail("rename a constraint by removing and adding it");
    setFields(edit, [p.kind, indexByName(edit.doc, p.kind, p.name, `${p.kind} constraint`)], p.fields);
  }
);

define("constraint.remove", "Removes a constraint.", { kind: constraintKind, name: nameSchema }, { kind: "ik", name: "tip_b" }, (edit, p) => {
  edit.apply({ op: "remove", path: pointer(p.kind, indexByName(edit.doc, p.kind, p.name, `${p.kind} constraint`)) });
});

// --- joint.* -----------------------------------------------------------------------------------

/** Runs another command's handler inside this one (same edit: one logged, undoable step). */
function runOp(edit: Edit, command: Record<string, unknown>): void {
  const spec = specs.find((s) => s.op === command["op"]);
  if (spec === undefined) return fail(`internal: no command '${String(command["op"])}'`);
  spec.run(edit, spec.params.parse(command) as never);
}

define(
  "joint.add",
  "Adds a cut-out disc joint between two rigid segments in one step: a joint bone `name` under `parent` at the child's pivot that turns `mix` (default 0.5) of the child's bend (a local relative transform constraint `<name>_half`), and a slot `<slot>` (default `<name>_joint`) on it drawn before `before` (default: before the parent's first slot), for a disc drawing centred on the pivot. The disc sits under both segments: inscribed in the straight limb, it shows only as the outer arc of the bend.",
  { name: nameSchema, parent: nameSchema, child: nameSchema, slot: nameSchema.optional(), before: nameSchema.optional(), mix: finite().min(0).max(1).optional(), length: finite().positive().optional() },
  { name: "elbow_a", parent: "upper_a", child: "lower_a", before: "upper_a" },
  (edit, p) => {
    const bones = arrayAt(edit.doc, "bones");
    const child = bones[indexByName(edit.doc, "bones", p.child, "bone")] as JsonObject;
    indexByName(edit.doc, "bones", p.parent, "bone");
    if (child["parent"] !== p.parent) fail(`joint.add: '${p.child}' hangs from '${String(child["parent"])}', not '${p.parent}'`);
    runOp(edit, { op: "bone.add", name: p.name, parent: p.parent, x: Number(child["x"] ?? 0), y: Number(child["y"] ?? 0), rotation: Number(child["rotation"] ?? 0), length: p.length ?? 24 });
    runOp(edit, {
      op: "constraint.add",
      kind: "transform",
      constraint: { name: `${p.name}_half`, bones: [p.name], target: p.child, local: true, relative: true, mixRotate: p.mix ?? 0.5, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 }
    });
    let before = p.before;
    if (before === undefined) {
      const order = (edit.get("/drawOrder") as string[] | undefined) ?? arrayAt(edit.doc, "slots").map((s) => String(s["name"]));
      const slotBone = new Map(arrayAt(edit.doc, "slots").map((s) => [String(s["name"]), String(s["bone"])]));
      before = order.find((name) => slotBone.get(name) === p.parent);
    }
    runOp(edit, { op: "slot.add", name: p.slot ?? `${p.name}_joint`, bone: p.name, ...(before ? { before } : {}) });
  }
);

// --- driven.* ----------------------------------------------------------------------------------

define(
  "driven.add",
  "Adds a driven set (corrections keyed to a bone angle) with its first key at 0 unless keys are given.",
  { name: nameSchema, bone: nameSchema, skin: nameSchema.optional(), keys: z.array(z.record(z.unknown())).optional() },
  { name: "bend_b_fix", bone: "lower_b" },
  (edit, p) => {
    requireFree(arrayAt(edit.doc, "driven").map((d) => String(d["name"])), p.name, "driven set");
    const driven = { name: p.name, bone: p.bone, ...pick(p, ["skin"]), keys: (p.keys ?? [{ at: 0 }]) as JsonValue };
    drivenSchema.parse(driven);
    if (!Array.isArray(edit.doc["driven"])) edit.set("/driven", []);
    edit.apply({ op: "add", path: pointer("driven", arrayAt(edit.doc, "driven").length), value: driven });
  }
);

define("driven.remove", "Removes a driven set.", { name: nameSchema }, { name: "bend_b_fix" }, (edit, p) => {
  edit.apply({ op: "remove", path: pointer("driven", indexByName(edit.doc, "driven", p.name, "driven set")) });
});

define(
  "driven.key",
  "Sets (or replaces) the key at driver angle `at` of a driven set: deform, drawOrder, attachments, alpha.",
  { name: nameSchema, at: finite().min(-360).max(360), deform: z.record(z.unknown()).optional(), drawOrder: z.array(z.unknown()).optional(), attachments: z.record(z.unknown()).optional(), alpha: z.record(z.unknown()).optional() },
  { name: "bend_b_fix", at: 70, alpha: { arm_r_rim: 1 } },
  (edit, p) => {
    const index = indexByName(edit.doc, "driven", p.name, "driven set");
    const key = { at: p.at, ...pick(p, ["deform", "drawOrder", "attachments", "alpha"]) };
    drivenKeySchema.parse(key);
    const keys = (edit.get(pointer("driven", index, "keys")) as JsonObject[] | undefined) ?? [];
    const same = keys.findIndex((other) => other["at"] === p.at);
    if (same >= 0) edit.set(pointer("driven", index, "keys", same), key);
    else {
      let at = keys.findIndex((other) => (other["at"] as number) > p.at);
      if (at < 0) at = keys.length;
      edit.apply({ op: "add", path: pointer("driven", index, "keys", at), value: key });
    }
  }
);

define("driven.unkey", "Deletes the key at driver angle `at` of a driven set (a set keeps at least one key).", { name: nameSchema, at: finite() }, { name: "bend_b_fix", at: 70 }, (edit, p) => {
  const index = indexByName(edit.doc, "driven", p.name, "driven set");
  const keys = (edit.get(pointer("driven", index, "keys")) as JsonObject[] | undefined) ?? [];
  const same = keys.findIndex((other) => other["at"] === p.at);
  if (same < 0) fail(`driven set '${p.name}' has no key at ${p.at}; keys at: ${listNames(keys.map((key) => String(key["at"])))}`);
  edit.apply({ op: "remove", path: pointer("driven", index, "keys", same) });
});

define(
  "driven.grid",
  "Adds (or replaces) a two-driver corrective grid: deform keyed on the driver values of bones x and y, blended bilinearly (at most 4 keys per axis, 12 in all); keys default to empty.",
  {
    name: nameSchema,
    x: z.object({ bone: nameSchema, at: z.array(finite()) }).strict(),
    y: z.object({ bone: nameSchema, at: z.array(finite()) }).strict(),
    skin: nameSchema.optional(),
    keys: z.array(z.record(z.unknown())).optional()
  },
  { name: "base_a_combo", x: { bone: "upper_a", at: [0, 45, 90] }, y: { bone: "base_a", at: [0, 15] } },
  (edit, p) => {
    const count = p.x.at.length * p.y.at.length;
    const grid = { name: p.name, ...pick(p, ["skin"]), x: p.x, y: p.y, keys: (p.keys ?? Array.from({ length: count }, () => ({}))) as JsonValue };
    drivenGridSchema.parse(grid);
    if (!Array.isArray(edit.doc["drivenGrids"])) edit.set("/drivenGrids", []);
    const index = arrayAt(edit.doc, "drivenGrids").findIndex((other) => other["name"] === p.name);
    if (index >= 0) edit.set(pointer("drivenGrids", index), grid as JsonValue);
    else edit.apply({ op: "add", path: pointer("drivenGrids", arrayAt(edit.doc, "drivenGrids").length), value: grid as JsonValue });
  }
);

define(
  "driven.grid-key",
  "Sets the deform of the grid key at driver values (x, y) (each must be one of its axis's `at` values); an empty deform clears the key.",
  { name: nameSchema, x: finite(), y: finite(), deform: z.record(z.unknown()) },
  { name: "base_a_combo", x: 90, y: 15, deform: { body: { core: { core: { offset: 120, vertices: [1.5, -2] } } } } },
  (edit, p) => {
    const index = indexByName(edit.doc, "drivenGrids", p.name, "driven grid");
    const grid = arrayAt(edit.doc, "drivenGrids")[index] as JsonObject;
    const xs = recordAt(grid["x"])["at"] as number[];
    const ys = recordAt(grid["y"])["at"] as number[];
    const i = xs.indexOf(p.x);
    const j = ys.indexOf(p.y);
    if (i < 0) fail(`driven grid '${p.name}' has no x key at ${p.x}; x keys at: ${listNames(xs.map(String))}`);
    if (j < 0) fail(`driven grid '${p.name}' has no y key at ${p.y}; y keys at: ${listNames(ys.map(String))}`);
    const path = pointer("drivenGrids", index, "keys", j * xs.length + i, "deform");
    if (Object.keys(p.deform).length === 0) edit.remove(path);
    else edit.set(path, p.deform as JsonValue);
  }
);

define("driven.grid-remove", "Removes a two-driver corrective grid.", { name: nameSchema }, { name: "base_a_combo" }, (edit, p) => {
  edit.apply({ op: "remove", path: pointer("drivenGrids", indexByName(edit.doc, "drivenGrids", p.name, "driven grid")) });
  if (arrayAt(edit.doc, "drivenGrids").length === 0) edit.remove("/drivenGrids");
});

// --- contour.* ---------------------------------------------------------------------------------

function contourTokens(p: MeshAddress): string[] {
  return ["skins", p.skin, "contours", p.slot, p.name];
}

function requireContour(doc: JsonObject, p: MeshAddress): JsonObject {
  const skins = recordAt(doc["skins"]);
  requireKey(skins, p.skin, "skin");
  const contours = recordAt(recordAt(recordAt(skins[p.skin])["contours"])[p.slot]);
  requireKey(contours, p.name, `contour of slot '${p.slot}' in skin '${p.skin}'; contour`);
  return contours[p.name] as JsonObject;
}

function writeContour(edit: Edit, p: MeshAddress, contour: JsonObject): void {
  requireKey(recordAt(edit.doc["skins"]), p.skin, "skin");
  indexByName(edit.doc, "slots", p.slot, "slot");
  contourSchema.parse(contour);
  const base = edit.ensure("skins", p.skin, "contours", p.slot);
  edit.set(`${base}${pointer(p.name)}`, contour);
}

define(
  "contour.add",
  "Adds (or replaces) a dynamic outline owned by slot `slot`: `contour` binds to a mesh ({mesh: {slot, attachment, skin?}, points}) or to bones ({bones, vertices}); width, color, closed, caps, visible.",
  { ...meshAddressShape, contour: z.record(z.unknown()) },
  { skin: "body", slot: "limb_a", name: "outer", contour: { mesh: { slot: "core", attachment: "core" }, points: [12, 13, 14, [14, 15, 40, 0.5, 0.5]], width: 6, color: "2a1d14ff" } },
  (edit, p) => writeContour(edit, p, p.contour as JsonObject)
);

define(
  "contour.trace",
  "Adds (or replaces) a mesh-bound contour from canvas points at the setup pose: each point is bound barycentrically to the mesh triangle under it (nearest triangle when outside).",
  {
    ...meshAddressShape,
    mesh: z.object({ skin: nameSchema.optional(), slot: nameSchema, attachment: nameSchema }).strict(),
    points: z.array(z.tuple([finite(), finite()])).min(2),
    width: finite().positive(),
    closed: z.boolean().optional(),
    color: colorSchema.optional(),
    caps: z.enum(CONTOUR_CAPS).optional(),
    visible: z.array(contourVisibilitySchema).optional()
  },
  { skin: "body", slot: "limb_a", name: "outer", mesh: { slot: "core", attachment: "core" }, points: [[410, 300], [430, 340], [436, 390]], width: 6 },
  (edit, p) => {
    const address = { skin: p.mesh.skin ?? p.skin, slot: p.mesh.slot, name: p.mesh.attachment };
    const mesh = requireMesh(edit.doc, address);
    const skeleton = setupSkeleton(edit.doc);
    const world = meshWorld(skeleton, edit.doc, address, mesh).flatMap(({ x, y }) => [x, y]);
    const canvas = recordAt(edit.doc["canvas"]);
    const originX = Number(canvas["originX"]);
    const originY = Number(canvas["originY"]);
    const points = p.points.map(([x, y]) => bindPointToMesh(world, mesh["triangles"] as number[], x - originX, y - originY));
    writeContour(edit, p, { mesh: p.mesh, points, width: p.width, ...pick(p, ["closed", "color", "caps", "visible"]) } as JsonObject);
  }
);

define(
  "contour.set",
  "Sets fields of a contour (null removes a field), e.g. width, color, closed, caps, visible.",
  { ...meshAddressShape, fields: z.record(z.unknown()) },
  { skin: "body", slot: "limb_a", name: "outer", fields: { width: 5, visible: [{ bone: "upper_a", min: -20, max: 110 }] } },
  (edit, p) => {
    const merged: JsonObject = { ...requireContour(edit.doc, p) };
    for (const [key, value] of Object.entries(p.fields)) {
      if (value === null) delete merged[key];
      else merged[key] = value as JsonValue;
    }
    contourSchema.parse(merged);
    setFields(edit, contourTokens(p), p.fields);
  }
);

define("contour.remove", "Removes a contour (and empty containers).", meshAddressShape, { skin: "body", slot: "limb_a", name: "outer" }, (edit, p) => {
  requireContour(edit.doc, p);
  const tokens = contourTokens(p);
  edit.remove(pointer(...tokens));
  edit.prune(tokens.slice(0, -1), 2);
});

// --- coverage.* --------------------------------------------------------------------------------

define(
  "coverage.region",
  "Declares (or replaces) a named coverage region on a skin: triangle ranges [start, end) of one of its meshes (e.g. the body's upper arm).",
  { skin: nameSchema, name: nameSchema, mesh: z.object({ slot: nameSchema, attachment: nameSchema }).strict(), triangles: triangleRangesSchema.min(1) },
  { skin: "body", name: "upper_a", mesh: { slot: "core", attachment: "core" }, triangles: [[40, 52]] },
  (edit, p) => {
    requireKey(recordAt(edit.doc["skins"]), p.skin, "skin");
    const region = { mesh: p.mesh, triangles: p.triangles };
    coverageRegionSchema.parse(region);
    const base = edit.ensure("skins", p.skin, "coverage", "regions");
    edit.set(`${base}${pointer(p.name)}`, region as JsonValue);
  }
);

define("coverage.remove-region", "Removes a coverage region from a skin.", { skin: nameSchema, name: nameSchema }, { skin: "body", name: "upper_a" }, (edit, p) => {
  const tokens = ["skins", p.skin, "coverage", "regions", p.name];
  if (!edit.has(pointer(...tokens))) fail(`skin '${p.skin}' declares no coverage region '${p.name}'`);
  edit.remove(pointer(...tokens));
  edit.prune(tokens.slice(0, -1), 2);
});

define(
  "coverage.covers",
  "Sets the coverage regions (of any skin) a skin covers opaquely while active; an empty list clears them.",
  { skin: nameSchema, covers: z.array(z.object({ skin: nameSchema, region: nameSchema }).strict()) },
  { skin: "cover_a", covers: [{ skin: "body", region: "upper_a" }] },
  (edit, p) => {
    requireKey(recordAt(edit.doc["skins"]), p.skin, "skin");
    const tokens = ["skins", p.skin, "coverage", "covers"];
    if (p.covers.length === 0) {
      edit.remove(pointer(...tokens));
      edit.prune(tokens.slice(0, -1), 2);
      return;
    }
    const base = edit.ensure("skins", p.skin, "coverage");
    edit.set(`${base}/covers`, p.covers as JsonValue);
  }
);

// --- event.* -----------------------------------------------------------------------------------

const eventValueShape = { int: z.number().int().optional(), float: finite().optional(), string: z.string().optional(), audio: z.string().optional() };

define("event.add", "Defines an event with default int/float/string payload.", { name: nameSchema, ...eventValueShape }, { name: "hit", int: 1 }, (edit, p) => {
  if (!isObject(edit.doc["events"])) edit.set("/events", {});
  requireFree(Object.keys(recordAt(edit.doc["events"])), p.name, "event");
  const definition = pick(p, ["int", "float", "string", "audio"]);
  eventDefinitionSchema.parse(definition);
  edit.apply({ op: "add", path: pointer("events", p.name), value: definition });
});

define("event.set", "Sets an event definition's default payload.", { name: nameSchema, ...eventValueShape }, { name: "hit", float: 0.5 }, (edit, p) => {
  requireKey(recordAt(edit.doc["events"]), p.name, "event");
  setFields(edit, ["events", p.name], pick(p, ["int", "float", "string", "audio"]));
});

define("event.remove", "Removes an event definition (keys using it are rejected by the check).", { name: nameSchema }, { name: "hit" }, (edit, p) => {
  requireKey(recordAt(edit.doc["events"]), p.name, "event");
  edit.apply({ op: "remove", path: pointer("events", p.name) });
});

define(
  "event.key",
  "Fires an event at `time` in a clip (payload fields override the definition's).",
  { clip: nameSchema, time: finite().nonnegative(), name: nameSchema, ...eventValueShape },
  { clip: "attack", time: 0.35, name: "hit" },
  (edit, p) => {
    requireClip(edit.doc, p.clip);
    const key = { time: roundTime(p.time), name: p.name, ...pick(p, ["int", "float", "string", "audio"]) };
    eventKeySchema.parse(key);
    writeKeys(edit, ["animations", p.clip, "events"], [key], true);
  }
);

define("event.unkey", "Removes the event `name` fired at `time` in a clip.", { clip: nameSchema, time: finite().nonnegative(), name: nameSchema }, { clip: "attack", time: 0.35, name: "hit" }, (edit, p) => {
  requireClip(edit.doc, p.clip);
  const keys = (edit.get(pointer("animations", p.clip, "events")) as JsonObject[] | undefined) ?? [];
  const index = keys.findIndex((key) => sameTime(key["time"] as number, p.time) && key["name"] === p.name);
  if (index < 0) fail(`clip '${p.clip}' has no '${p.name}' event at ${p.time}s`);
  edit.apply({ op: "remove", path: pointer("animations", p.clip, "events", index) });
  edit.prune(["animations", p.clip, "events"], 2);
});

// --- clip.* ------------------------------------------------------------------------------------

define("clip.add", "Adds an empty clip.", { name: nameSchema, duration: finite().nonnegative(), loop: z.boolean().optional() }, { name: "idle", duration: 2.4, loop: true }, (edit, p) => {
  if (!isObject(edit.doc["animations"])) edit.set("/animations", {});
  requireFree(Object.keys(recordAt(edit.doc["animations"])), p.name, "clip");
  edit.apply({ op: "add", path: pointer("animations", p.name), value: { duration: p.duration, ...pick(p, ["loop"]) } });
});

define("clip.remove", "Removes a clip.", { name: nameSchema }, { name: "idle" }, (edit, p) => {
  requireClip(edit.doc, p.name);
  edit.apply({ op: "remove", path: pointer("animations", p.name) });
});

define("clip.duration", "Sets a clip's duration in seconds (keys past it are rejected by the check).", { name: nameSchema, duration: finite().nonnegative() }, { name: "idle", duration: 2.0 }, (edit, p) => {
  requireClip(edit.doc, p.name);
  edit.set(pointer("animations", p.name, "duration"), p.duration);
});

define("clip.loop", "Sets whether a clip loops.", { name: nameSchema, loop: z.boolean() }, { name: "idle", loop: true }, (edit, p) => {
  requireClip(edit.doc, p.name);
  edit.set(pointer("animations", p.name, "loop"), p.loop);
});

define("clip.rename", "Renames a clip.", { name: nameSchema, to: nameSchema }, { name: "idle", to: "idle_breathe" }, (edit, p) => {
  const clip = requireClip(edit.doc, p.name);
  requireFree(Object.keys(recordAt(edit.doc["animations"])), p.to, "clip");
  edit.apply({ op: "remove", path: pointer("animations", p.name) });
  edit.apply({ op: "add", path: pointer("animations", p.to), value: clip });
});

define("clip.copy", "Copies a clip under a new name.", { name: nameSchema, to: nameSchema }, { name: "attack", to: "chop" }, (edit, p) => {
  const clip = requireClip(edit.doc, p.name);
  requireFree(Object.keys(recordAt(edit.doc["animations"])), p.to, "clip");
  edit.apply({ op: "add", path: pointer("animations", p.to), value: cloneJson(clip) });
});

// --- key.* -------------------------------------------------------------------------------------

const KEY_RESERVED = new Set(["op", "clip", "time", ...Object.keys(addressShape)]);

define(
  "key.set",
  "Sets (inserts or merges into) the key at `time` on one timeline. Fields by timeline: rotate {value}; translate/scale/shear {x, y}; slot color {color}; slot attachment {name|null}; ik {mix, softness, bendPositive, stretch, compress}; transform {mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY}; physics mix {value}; physics reset {}; deform {offset, vertices}; drawOrder {offsets}. Optional curve: linear | stepped | [cx1, cy1, cx2, cy2].",
  { clip: nameSchema, time: finite().nonnegative(), ...addressShape },
  { clip: "idle", bone: "trunk", timeline: "rotate", time: 1.2, value: 4, curve: [0.42, 0, 0.58, 1] },
  (edit, p) => {
    requireClip(edit.doc, p.clip);
    const timeline = resolveTimeline(p);
    const fields: JsonObject = {};
    for (const [key, value] of Object.entries(p as Record<string, unknown>)) if (!KEY_RESERVED.has(key) && value !== undefined) fields[key] = value as JsonValue;
    const keys = keysOf(edit, p.clip, timeline);
    const time = roundTime(p.time);
    const existing = keys.find((key) => sameTime(key["time"] as number, time));
    const merged: JsonObject = existing ? { ...cloneJson(existing), ...fields } : { time, ...fields };
    const parsed = timeline.key.safeParse(merged);
    if (!parsed.success) fail(`${timeline.label} key at ${time}s: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(key)"} ${issue.message}`).join("; ")}`);
    edit.ensure("animations", p.clip, ...timeline.tokens.slice(0, -1));
    writeKeys(edit, ["animations", p.clip, ...timeline.tokens], [merged], false);
  },
  true
);

define("key.delete", "Deletes the key at `time` on one timeline (empty timelines are removed).", { clip: nameSchema, time: finite().nonnegative(), ...addressShape }, { clip: "idle", bone: "trunk", timeline: "rotate", time: 1.2 }, (edit, p) => {
  requireClip(edit.doc, p.clip);
  const timeline = resolveTimeline(p);
  const index = keyIndexAt(keysOf(edit, p.clip, timeline), p.time, timeline.label);
  edit.apply({ op: "remove", path: pointer("animations", p.clip, ...timeline.tokens, index) });
  edit.prune(["animations", p.clip, ...timeline.tokens], 2);
});

define(
  "key.move",
  "Moves the key at `time` to time `to` on one timeline (replacing any key already there).",
  { clip: nameSchema, time: finite().nonnegative(), to: finite().nonnegative(), ...addressShape },
  { clip: "idle", bone: "trunk", timeline: "rotate", time: 1.2, to: 1.0 },
  (edit, p) => {
    requireClip(edit.doc, p.clip);
    const timeline = resolveTimeline(p);
    const base = ["animations", p.clip, ...timeline.tokens];
    const index = keyIndexAt(keysOf(edit, p.clip, timeline), p.time, timeline.label);
    const key = cloneJson(keysOf(edit, p.clip, timeline)[index] as JsonObject);
    edit.apply({ op: "remove", path: pointer(...base, index) });
    key["time"] = roundTime(p.to);
    writeKeys(edit, base, [key], false);
  }
);

define(
  "key.curve",
  "Sets the curve from the key at `time` to the next: linear | stepped | [cx1, cy1, cx2, cy2], or an object per channel.",
  { clip: nameSchema, time: finite().nonnegative(), curve: z.union([curveSpecSchema, z.record(curveSpecSchema)]), ...addressShape },
  { clip: "idle", bone: "trunk", timeline: "rotate", time: 0, curve: [0.42, 0, 0.58, 1] },
  (edit, p) => {
    requireClip(edit.doc, p.clip);
    const timeline = resolveTimeline(p);
    const keys = keysOf(edit, p.clip, timeline);
    const index = keyIndexAt(keys, p.time, timeline.label);
    const key = { ...cloneJson(keys[index] as JsonObject), curve: p.curve as JsonValue };
    const parsed = timeline.key.safeParse(key);
    if (!parsed.success) fail(`${timeline.label} has no curve or the curve is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    edit.set(pointer("animations", p.clip, ...timeline.tokens, index, "curve"), p.curve as JsonValue);
  }
);

define(
  "key.offset",
  "Shifts key times by `by` seconds, for keys in [from, to] (default all) on one timeline or, without an address, every timeline and event of the clip.",
  { clip: nameSchema, by: finite(), from: finite().nonnegative().optional(), to: finite().nonnegative().optional(), ...addressShape },
  { clip: "attack", by: 0.05, from: 0.3 },
  (edit, p) => {
    const clip = requireClip(edit.doc, p.clip);
    const from = p.from ?? 0;
    const to = p.to ?? Number.POSITIVE_INFINITY;
    for (const { tokens, keys } of addressedTimelines(clip, p)) {
      const inRange = (key: JsonObject) => (key["time"] as number) >= from - TIME_EPSILON && (key["time"] as number) <= to + TIME_EPSILON;
      const moved = keys.filter(inRange).map((key) => ({ ...cloneJson(key), time: roundTime((key["time"] as number) + p.by) }));
      if (moved.length === 0) continue;
      if (moved.some((key) => (key["time"] as number) < 0)) fail(`offset ${p.by} would move a ${tokens.join(" ")} key before 0`);
      const kept = keys.filter((key) => !inRange(key));
      const base = ["animations", p.clip, ...tokens];
      edit.set(pointer(...base), kept as JsonValue);
      writeKeys(edit, base, moved, tokens[0] === "events");
    }
  }
);

define(
  "key.copy-range",
  "Copies keys in [from, to] so the first lands at `at` (same clip, or `toClip`), on one timeline or every timeline and event.",
  { clip: nameSchema, from: finite().nonnegative(), to: finite().nonnegative(), at: finite().nonnegative(), toClip: nameSchema.optional(), ...addressShape },
  { clip: "walk", from: 0, to: 0.4, at: 0.4 },
  (edit, p) => {
    const clip = requireClip(edit.doc, p.clip);
    const target = p.toClip ?? p.clip;
    requireClip(edit.doc, target);
    if (p.to < p.from) fail("to must not be before from");
    for (const { tokens, keys } of addressedTimelines(clip, p)) {
      const copies = keys
        .filter((key) => (key["time"] as number) >= p.from - TIME_EPSILON && (key["time"] as number) <= p.to + TIME_EPSILON)
        .map((key) => ({ ...cloneJson(key), time: roundTime((key["time"] as number) - p.from + p.at) }));
      if (copies.length === 0) continue;
      edit.ensure("animations", target, ...tokens.slice(0, -1));
      writeKeys(edit, ["animations", target, ...tokens], copies, tokens[0] === "events");
    }
  }
);

// --- patch -------------------------------------------------------------------------------------

define(
  "patch",
  "Applies raw RFC 6902 operations (add, remove, replace, move, copy, test) to the document; prefer the named commands.",
  { patch: z.array(z.record(z.unknown())) },
  { patch: [{ op: "replace", path: "/bones/1/rotation", value: -88 }] },
  (edit, p) => {
    let operations: PatchOperation[];
    try {
      operations = parsePatch(p.patch);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    for (const operation of operations) {
      if (operation.op === "move" || operation.op === "copy" || operation.op === "test") {
        // Recorded as the primitives they expand to, so the log stays add/remove/replace.
        const value = edit.get(operation.op === "test" ? operation.path : operation.from);
        if (operation.op === "test") {
          if (!jsonEqual(value, operation.value)) fail(`test failed at '${operation.path}'`);
          continue;
        }
        if (value === undefined) fail(`'${operation.op}' source '${operation.from}' does not exist`);
        if (operation.op === "move") edit.apply({ op: "remove", path: operation.from });
        edit.apply({ op: "add", path: operation.path, value: cloneJson(value as JsonValue) });
      } else edit.apply(operation);
    }
  }
);

// ---------------------------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------------------------

export const COMMANDS: ReadonlyMap<string, CommandSpec<never>> = new Map(specs.map((spec) => [spec.op, spec]));

export interface AppliedCommand {
  command: Command;
  patch: PatchOperation[];
  inverse: PatchOperation[];
  /** The command's diagnostics (empty for most commands). */
  notes: CommandNote[];
}

export interface ApplyOptions {
  /**
   * "command" (default): reject a command that adds a format or reference error. "end": check
   * once after the batch. "none": no check (tests and trusted replays).
   */
  check?: "command" | "end" | "none";
  /**
   * Live pose limits for key and clip commands: their keyed poses and the sampled
   * in-betweens are checked against the document's `poseLimits`. "off" (default here; the CLI
   * defaults to warn, the editor to reject); "warn": applied, reported in `limitWarnings`;
   * "reject": the command (check "command") or the batch (check "end") is refused, naming the key,
   * the limit and the nearest legal pose. With check "end" the clips are checked once at the end.
   */
  limits?: LimitMode;
}

export interface BatchResult {
  doc: JsonObject;
  /** The result document already parsed and validated (when valid): hand it to the loader instead of parsing `doc` again. */
  parsed?: AnimDocument | undefined;
  /** Forward patch of the whole batch (concatenated). */
  patch: PatchOperation[];
  /** Undoes the whole batch. */
  inverse: PatchOperation[];
  applied: AppliedCommand[];
  /** Pose-limit findings (limits "warn"; one line per command and limit). */
  limitWarnings: string[];
  /** The raw findings behind `limitWarnings`. */
  limitViolations: LimitViolation[];
  /** Every command's notes, prefixed `command N (op): `. */
  notes: CommandNote[];
}

/** One parse of a document: its error multiset and the parse result (the document, when valid). */
interface Analysis {
  counts: Map<string, number>;
  result: ReturnType<typeof parseAnimDocument>;
}

/**
 * Error counts of documents that applyCommands returned, by identity: a commit's result document is
 * the next commit's input, so its errors are counted once. Only returned documents are keyed (they
 * are never mutated afterwards); the working copy inside a batch is edited in place and never cached.
 */
const returnedCounts = new WeakMap<object, Map<string, number>>();
/** The parse a returned document came with (the editor may have attached clips to it, which setup-pose reads ignore). */
const returnedParse = new WeakMap<object, AnimDocument>();
/** The parse of the document the running command has not touched yet (see setupSkeleton). */
let parseHint: { edit: Edit; document: AnimDocument } | null = null;

function analyse(doc: JsonValue): Analysis {
  const result = parseAnimDocument(doc);
  const counts = new Map<string, number>();
  if (!result.ok) {
    for (const issue of result.issues) {
      if (issue.severity !== "error") continue;
      counts.set(issue.message, (counts.get(issue.message) ?? 0) + 1);
    }
  }
  return { counts, result };
}

/** Errors of `after` that `before` did not have (multiset difference), formatted. */
function newErrors(after: Analysis, before: Map<string, number>): string[] {
  const result = after.result;
  if (result.ok) return [];
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const issue of result.issues) {
    if (issue.severity !== "error") continue;
    const n = (seen.get(issue.message) ?? 0) + 1;
    seen.set(issue.message, n);
    if (n > (before.get(issue.message) ?? 0)) out.push(formatIssue(issue));
  }
  return out;
}

function describeZod(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(command)"}: ${issue.message}`).join("; ");
}

/** Parses a command's params against its spec (throws CommandError naming the op). */
export function parseCommand(input: unknown): { spec: CommandSpec<never>; params: never } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("a command must be a JSON object with an 'op'");
  const op = (input as { op?: unknown }).op;
  if (typeof op !== "string") fail("a command needs a string 'op'");
  const spec = COMMANDS.get(op as string);
  if (!spec) {
    const family = String(op).split(".")[0];
    const near = [...COMMANDS.keys()].filter((name) => name.startsWith(`${family}.`));
    fail(`unknown command '${String(op)}'${near.length ? `; ${family}.* commands: ${near.join(", ")}` : ""}; run 'animator ops' for the vocabulary`);
  }
  const parsed = (spec as CommandSpec<never>).params.safeParse(input);
  if (!parsed.success) fail(`${String(op)}: ${describeZod(parsed.error)}`);
  return { spec: spec as CommandSpec<never>, params: parsed.data as never };
}

/**
 * Applies a batch of commands to a document and returns the new document with the batch's
 * forward and inverse patches. Atomic: if any command fails, the input is unchanged and a
 * CommandError names the command's index and op. The input document is never modified.
 */
export function applyCommands(doc: JsonValue, commands: readonly unknown[], options: ApplyOptions = {}): BatchResult {
  const check = options.check ?? "command";
  let working = cloneJson(doc) as JsonObject;
  const inputCounts = (): Map<string, number> => (typeof doc === "object" && doc !== null ? returnedCounts.get(doc) : undefined) ?? analyse(doc).counts;
  const startCounts = check === "none" ? new Map<string, number>() : inputCounts();
  let before = check === "command" ? startCounts : new Map<string, number>();
  const startErrors = check === "end" ? startCounts : before;
  let lastAnalysis: Analysis | null = null;
  const applied: AppliedCommand[] = [];
  const patch: PatchOperation[] = [];
  const inverse: PatchOperation[] = [];
  const limits = options.limits ?? "off";
  const limitWarnings: string[] = [];
  const limitViolations: LimitViolation[] = [];
  const notes: CommandNote[] = [];
  const startDoc = limits !== "off" && check === "end" ? limitDocument(working) : null;
  const endClips: string[] = [];
  const endKeyed: number[] = [];
  // The parsed document before the current command (the edit mutates `working` in place); kept
  // from the previous key command while consecutive commands touch clips.
  let prior: ReturnType<typeof limitDocument> | undefined;
  commands.forEach((input, index) => {
    const op = typeof input === "object" && input !== null ? String((input as { op?: unknown }).op) : null;
    try {
      const { spec, params } = parseCommand(input);
      const command = input as Record<string, unknown>;
      const touched = limits !== "off" ? clipsTouched(command) : [];
      if (touched.length && check !== "end" && prior === undefined) prior = limitDocument(working);
      if (!touched.length) prior = undefined;
      const edit = new Edit(working);
      const hinted = index === 0 && typeof doc === "object" && doc !== null ? returnedParse.get(doc) : undefined;
      parseHint = hinted ? { edit, document: hinted } : null;
      try {
        spec.run(edit, params);
      } finally {
        parseHint = null;
      }
      if (check === "command") {
        const analysis = analyse(edit.doc);
        const added = newErrors(analysis, before);
        if (added.length) fail(`the result would be invalid:\n  ${added.join("\n  ")}`);
        before = analysis.counts;
        lastAnalysis = analysis;
      }
      if (touched.length && check !== "end") {
        const after = limitDocument(edit.doc);
        const found = after ? newViolations(prior ?? null, after, touched, keyedTimes(command)) : [];
        prior = after;
        if (found.length) {
          const lines = describeViolations(found);
          if (limits === "reject") fail(`${describeKey(command)} leaves the pose limits (rejected):\n  ${lines.join("\n  ")}`);
          limitWarnings.push(...lines.map((line) => `command ${index + 1} (${describeKey(command)}): ${line}`));
          limitViolations.push(...found);
        }
      } else if (touched.length) {
        endClips.push(...touched);
        endKeyed.push(...keyedTimes(command));
      }
      working = edit.doc;
      applied.push({ command: input as Command, patch: edit.patch, inverse: edit.inverse, notes: edit.notes });
      notes.push(...edit.notes.map((note) => ({ ...note, message: `command ${index + 1} (${op}): ${note.message}` })));
      patch.push(...edit.patch);
      inverse.unshift(...edit.inverse);
    } catch (error) {
      const message = error instanceof z.ZodError ? describeZod(error) : error instanceof Error ? error.message : String(error);
      const known = error instanceof CommandError || error instanceof PatchError || error instanceof z.ZodError;
      if (!known) throw error;
      throw new CommandError(`command ${index + 1}${op ? ` (${op})` : ""}: ${message}`, index, op);
    }
  });
  if (check === "end") {
    const analysis = analyse(working);
    const added = newErrors(analysis, startErrors);
    lastAnalysis = analysis;
    if (added.length) throw new CommandError(`the batch would leave the document invalid:\n  ${added.join("\n  ")}`);
  }
  if (endClips.length) {
    const after = limitDocument(working);
    const found = after ? newViolations(startDoc, after, endClips, endKeyed) : [];
    if (found.length) {
      const lines = describeViolations(found);
      if (limits === "reject") throw new CommandError(`the batch leaves the pose limits (rejected at the end):\n  ${lines.join("\n  ")}`);
      limitWarnings.push(...lines.map((line) => `end of batch: ${line}`));
      limitViolations.push(...found);
    }
  }
  const last = lastAnalysis as Analysis | null;
  if (last) returnedCounts.set(working, last.counts);
  if (last && last.result.ok) returnedParse.set(working, last.result.document);
  const parsed = last && last.result.ok ? last.result.document : undefined;
  return { doc: working, parsed, patch, inverse, applied, limitWarnings, limitViolations, notes };
}

/** A key command in rig terms for limit messages: `key.set lower_a rotate t 0.45s`. */
function describeKey(command: Record<string, unknown>): string {
  const address = ["bone", "slot", "ik", "transform", "path", "physics"].map((k) => command[k]).find((v) => typeof v === "string");
  const time = typeof command["time"] === "number" ? ` t ${command["time"]}s` : "";
  return [String(command["op"]), address, command["timeline"]].filter((v) => typeof v === "string").join(" ") + time;
}

/** One command; see applyCommands. */
export function applyCommand(doc: JsonValue, command: unknown, options: ApplyOptions = {}): BatchResult {
  return applyCommands(doc, [command], options);
}

// ---------------------------------------------------------------------------------------------
// Scripts and the vocabulary listing
// ---------------------------------------------------------------------------------------------

/**
 * Parses a command script: a JSON array of commands, or JSON Lines (one command per line; blank
 * lines and lines starting with `#` or `//` are ignored). Errors name the line.
 */
export function parseScript(text: string): Command[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const value: unknown = JSON.parse(trimmed);
    if (!Array.isArray(value)) fail("a JSON script must be an array of commands");
    return value as Command[];
  }
  const commands: Command[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const content = line.trim();
    if (!content || content.startsWith("#") || content.startsWith("//")) return;
    try {
      commands.push(JSON.parse(content) as Command);
    } catch (error) {
      fail(`line ${i + 1}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  return commands;
}

export interface CommandDescription {
  op: string;
  summary: string;
  /** Parameter names; a trailing '?' marks optional ones. */
  params: string[];
  example: Command;
}

function paramNames(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([key]) => key !== "op")
    .map(([key, value]) => (value.isOptional() ? `${key}?` : key));
}

export function describeCommands(): CommandDescription[] {
  return specs.map((spec) => ({ op: spec.op, summary: spec.summary, params: paramNames(spec.params as unknown as z.ZodTypeAny), example: spec.example }));
}
