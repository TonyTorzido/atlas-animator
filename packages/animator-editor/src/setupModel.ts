/*
 * Atlas Animator editor: Setup mode model (pure; no DOM).
 *
 * Setup mode edits the rig itself (bones, attachments, constraints), not a clip. Every edit is a
 * batch of the animator's own commands (`bone.add`, `bone.parent`, `attachment.set`, ...) planned
 * here against the raw rig document and run through `applyCommands`, so it is validated, atomic
 * and undoable with the batch's inverse patch, and it is saved through the document store's
 * command log (`src/rigSave.ts`). Plans that must keep things where they are ("move bone, keep
 * images", re-parenting, delete with re-parenting) measure world positions on the setup skeleton
 * before the change and write the local values that restore them after it.
 */
import { applyCommands, type Command } from "@atlas-animator/core/commands";
import { applyPatch, cloneJson, type JsonObject, type JsonValue, type PatchOperation } from "@atlas-animator/core/patch";
import { loadAnimDocument, Skeleton, type Bone, type AnimDocument, type ClipData } from "@atlas-animator/core/core";

export type { Command, JsonObject };

/** A refused setup edit; the message is shown in the status bar. */
export class SetupError extends Error {}

export const fail = (message: string): never => {
  throw new SetupError(message);
};

export const isObj = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const objOf = (v: JsonValue | undefined): JsonObject => (isObj(v) ? v : {});
export const listOf = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObj) as JsonObject[]) : []);
export const r4 = (n: number) => Math.round(n * 1e4) / 1e4 + 0;
const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------------------------------------
// Applying a batch
// ---------------------------------------------------------------------------------------------

export interface SetupResult {
  /** The document after the batch. */
  doc: JsonObject;
  /** The validated parse of `doc` from the batch check (hand it to the remount instead of parsing again). */
  parsed?: AnimDocument | undefined;
  /** Undoes the batch. */
  inverse: PatchOperation[];
  patch: PatchOperation[];
}

/** Runs a command batch against a rig document (format and reference errors added by it are refused). */
export function runBatch(raw: JsonObject, commands: readonly Command[]): SetupResult {
  try {
    const out = applyCommands(raw, commands, { check: "command" });
    return { doc: out.doc, parsed: out.parsed, inverse: out.inverse, patch: out.patch };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(error instanceof Error ? error.message : String(error));
  }
}

/** Undoes (inverse) or redoes (patch) a batch result on a document. */
export function applyOps(raw: JsonObject, ops: readonly PatchOperation[]): JsonObject {
  return applyPatch(raw, ops).doc as JsonObject;
}

// ---------------------------------------------------------------------------------------------
// Setup skeleton and world snapshots
// ---------------------------------------------------------------------------------------------

/** The setup pose of a document (every skin active), world transforms computed. */
export function setupSkeleton(raw: JsonObject): Skeleton {
  const doc = loadAnimDocument(cloneJson(raw));
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(Object.keys(doc.skins));
  skeleton.updateWorldTransform("none");
  return skeleton;
}

export const boneNames = (raw: JsonObject): string[] => listOf(raw["bones"]).map((b) => String(b["name"]));
export const slotNames = (raw: JsonObject): string[] => listOf(raw["slots"]).map((s) => String(s["name"]));

/** `base`, or `base2`, `base3`, ... when taken. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  const stem = base.replace(/\d+$/, "") || base;
  for (let i = 2; ; i++) if (!set.has(`${stem}${i}`)) return `${stem}${i}`;
}

const mirrorSign = (bone: Bone | null): number => (bone && bone.world.a * bone.world.d - bone.world.b * bone.world.c < 0 ? -1 : 1);

/** Where a thing sits in the world: a point and the direction of its x axis. */
interface Spot {
  x: number;
  y: number;
  angle: number;
}

/** What a plan keeps in place across a structural change. */
type Anchor = { kind: "bone"; name: string } | { kind: "region"; skin: string; slot: string; name: string };

const slotBoneOf = (raw: JsonObject, slot: string): string => String(listOf(raw["slots"]).find((s) => s["name"] === slot)?.["bone"] ?? "");

function regionsOnBones(raw: JsonObject, bones: ReadonlySet<string>): Anchor[] {
  const out: Anchor[] = [];
  for (const [skin, def] of Object.entries(objOf(raw["skins"]))) {
    for (const [slot, atts] of Object.entries(objOf(objOf(def)["attachments"]))) {
      if (!bones.has(slotBoneOf(raw, slot))) continue;
      for (const [name, att] of Object.entries(objOf(atts))) if (objOf(att)["type"] === "region") out.push({ kind: "region", skin, slot, name });
    }
  }
  return out;
}

function regionOf(raw: JsonObject, a: Extract<Anchor, { kind: "region" }>): JsonObject {
  return objOf(objOf(objOf(objOf(objOf(raw["skins"])[a.skin])["attachments"])[a.slot])[a.name]);
}

function snapshot(sk: Skeleton, raw: JsonObject, anchors: readonly Anchor[]): Spot[] {
  return anchors.map((a) => {
    if (a.kind === "bone") {
      const b = sk.getBone(a.name);
      return { x: b.world.x, y: b.world.y, angle: b.worldRotationX };
    }
    const att = regionOf(raw, a);
    const bone = sk.getBone(slotBoneOf(raw, a.slot));
    const p = bone.localToWorld(Number(att["x"] ?? 0), Number(att["y"] ?? 0), { x: 0, y: 0 });
    return { x: p.x, y: p.y, angle: bone.worldRotationX + mirrorSign(bone) * Number(att["rotation"] ?? 0) };
  });
}

/** The commands that put each anchor back at its snapshot in the (changed) document. */
function restore(sk: Skeleton, raw: JsonObject, anchors: readonly Anchor[], spots: readonly Spot[]): Command[] {
  const out: Command[] = [];
  anchors.forEach((a, i) => {
    const spot = spots[i]!;
    if (a.kind === "bone") {
      const bone = sk.getBone(a.name);
      const local = { x: 0, y: 0 };
      bone.worldToParent(spot.x, spot.y, local);
      const parentAngle = bone.parent ? bone.parent.worldRotationX : 0;
      out.push({ op: "bone.set", name: a.name, x: r4(local.x), y: r4(local.y), rotation: r4(norm(mirrorSign(bone.parent) * (spot.angle - parentAngle))) });
      return;
    }
    const bone = sk.getBone(slotBoneOf(raw, a.slot));
    const local = { x: 0, y: 0 };
    bone.worldToLocal(spot.x, spot.y, local);
    out.push({ op: "attachment.set", skin: a.skin, slot: a.slot, name: a.name, fields: { x: r4(local.x), y: r4(local.y), rotation: r4(norm(mirrorSign(bone) * (spot.angle - bone.worldRotationX))) } });
  });
  return out;
}

// --- mesh vertices (unweighted meshes ride their slot's bone; weighted ones their influences) -----------------

interface MeshRef {
  skin: string;
  slot: string;
  name: string;
  att: JsonObject;
}

function meshes(raw: JsonObject): MeshRef[] {
  const out: MeshRef[] = [];
  for (const [skin, def] of Object.entries(objOf(raw["skins"]))) {
    for (const [slot, atts] of Object.entries(objOf(objOf(def)["attachments"]))) {
      for (const [name, att] of Object.entries(objOf(atts))) if (objOf(att)["type"] === "mesh") out.push({ skin, slot, name, att: objOf(att) });
    }
  }
  return out;
}

type MeshPoints = { points: { bone: string; x: number; y: number }[]; weighted: boolean };

/** Vertex positions of a mesh as (bone, local x, y) per vertex or influence, flattened in file order. */
function meshPoints(raw: JsonObject, m: MeshRef): MeshPoints {
  const vertices = (m.att["vertices"] as number[]) ?? [];
  const table = m.att["bones"] as string[] | undefined;
  const points: MeshPoints["points"] = [];
  if (!table) {
    const bone = slotBoneOf(raw, m.slot);
    for (let i = 0; i + 1 < vertices.length; i += 2) points.push({ bone, x: vertices[i]!, y: vertices[i + 1]! });
    return { points, weighted: false };
  }
  const count = ((m.att["uvs"] as number[]) ?? []).length / 2;
  let cursor = 0;
  for (let v = 0; v < count; v++) {
    const n = vertices[cursor++]!;
    for (let k = 0; k < n; k++, cursor += 4) points.push({ bone: table[vertices[cursor]!]!, x: vertices[cursor + 1]!, y: vertices[cursor + 2]! });
  }
  return { points, weighted: true };
}

function writeMeshPoints(m: MeshRef, pts: MeshPoints["points"], weighted: boolean): number[] {
  const vertices = [...((m.att["vertices"] as number[]) ?? [])];
  if (!weighted) {
    pts.forEach((p, i) => {
      vertices[2 * i] = r4(p.x);
      vertices[2 * i + 1] = r4(p.y);
    });
    return vertices;
  }
  const count = ((m.att["uvs"] as number[]) ?? []).length / 2;
  let cursor = 0;
  let at = 0;
  for (let v = 0; v < count; v++) {
    const n = vertices[cursor++]!;
    for (let k = 0; k < n; k++, cursor += 4, at++) {
      vertices[cursor + 1] = r4(pts[at]!.x);
      vertices[cursor + 2] = r4(pts[at]!.y);
    }
  }
  return vertices;
}

/**
 * Commands that keep the meshes' vertices where they are in the world: every vertex (or weighted
 * influence) whose bone is in `moved` is re-expressed in the same bone of the new skeleton; an
 * unweighted mesh on a slot that changed bone is re-expressed in the slot's new bone.
 */
function meshCommands(rawOld: JsonObject, skOld: Skeleton, rawNew: JsonObject, skNew: Skeleton, moved: ReadonlySet<string>): Command[] {
  const out: Command[] = [];
  for (const m of meshes(rawOld)) {
    const { points, weighted } = meshPoints(rawOld, m);
    const newSlotBone = slotBoneOf(rawNew, m.slot);
    let changed = false;
    const next = points.map((p) => {
      const target = !weighted && p.bone !== newSlotBone ? newSlotBone : p.bone;
      if (!moved.has(p.bone) && target === p.bone) return p;
      const from = skOld.findBone(p.bone);
      const to = skNew.findBone(target);
      if (!from || !to) return p;
      const world = from.localToWorld(p.x, p.y, { x: 0, y: 0 });
      const local = { x: 0, y: 0 };
      to.worldToLocal(world.x, world.y, local);
      changed = true;
      return { bone: target, x: local.x, y: local.y };
    });
    if (changed) out.push({ op: "attachment.set", skin: m.skin, slot: m.slot, name: m.name, fields: { vertices: writeMeshPoints(m, next, weighted) } });
  }
  return out;
}

/**
 * Weighted meshes (the mesh arms) that bind to `deleted`: every influence on it moves to `parent`, keeping its world position, and the
 * deleted bone leaves the mesh's bone table. `skOld` is the skeleton before the delete.
 */
function rebindWeightedMeshes(raw: JsonObject, skOld: Skeleton, skNew: Skeleton, deleted: string, parent: string | null): Command[] {
  const out: Command[] = [];
  for (const m of meshes(raw)) {
    const table = m.att["bones"] as string[] | undefined;
    if (!table || !table.includes(deleted)) continue;
    const target = parent ?? fail(`${m.skin}/${m.slot}/${m.name} is weighted to '${deleted}', a root bone; rebind it first`);
    const from = skOld.findBone(deleted);
    const to = skNew.findBone(target);
    if (!from || !to) continue;
    const nextTable = table.filter((b) => b !== deleted);
    if (!nextTable.includes(target)) nextTable.push(target);
    const vertices = [...((m.att["vertices"] as number[]) ?? [])];
    const count = ((m.att["uvs"] as number[]) ?? []).length / 2;
    let cursor = 0;
    for (let v = 0; v < count; v++) {
      const n = vertices[cursor++]!;
      for (let k = 0; k < n; k++, cursor += 4) {
        const bone = table[vertices[cursor]!]!;
        if (bone === deleted) {
          const world = from.localToWorld(vertices[cursor + 1]!, vertices[cursor + 2]!, { x: 0, y: 0 });
          const local = { x: 0, y: 0 };
          to.worldToLocal(world.x, world.y, local);
          vertices[cursor + 1] = r4(local.x);
          vertices[cursor + 2] = r4(local.y);
          vertices[cursor] = nextTable.indexOf(target);
        } else vertices[cursor] = nextTable.indexOf(bone);
      }
    }
    out.push({ op: "attachment.set", skin: m.skin, slot: m.slot, name: m.name, fields: { vertices, bones: nextTable } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bones
// ---------------------------------------------------------------------------------------------

export interface BonePlan {
  commands: Command[];
  /** The bone the plan creates or acts on (to select afterwards). */
  bone: string;
}

export const canvasOrigin = (raw: JsonObject): { x: number; y: number } => {
  const c = objOf(raw["canvas"]);
  return { x: Number(c["originX"] ?? 0), y: Number(c["originY"] ?? 0) };
};

/** A new bone from a click-drag: starts at `from` and ends at `to` (skeleton space), child of `parent`. */
export function planAddBone(raw: JsonObject, o: { parent: string | null; from: [number, number]; to: [number, number]; name?: string }): BonePlan {
  if (o.parent !== null && !boneNames(raw).includes(o.parent)) fail(`no bone '${o.parent}'`);
  if (Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1]) < 1) fail("drag a little further to give the bone a length");
  const name = uniqueName(boneNames(raw), o.name ?? "bone");
  const origin = canvasOrigin(raw);
  const command: Command = {
    op: "bone.add",
    name,
    ...(o.parent !== null ? { parent: o.parent } : {}),
    world: [r4(o.from[0] + origin.x), r4(o.from[1] + origin.y)],
    tip: [r4(o.to[0] + origin.x), r4(o.to[1] + origin.y)]
  };
  return { commands: [command], bone: name };
}

export function planRename(raw: JsonObject, name: string, to: string): BonePlan {
  if (!boneNames(raw).includes(name)) fail(`no bone '${name}'`);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(to)) fail(`'${to}' is not a valid bone name`);
  return { commands: [{ op: "bone.rename", name, to }], bone: to };
}

/** Re-parent a bone (null = root). `keepWorld` writes the local values that keep it where it is. */
export function planReparent(raw: JsonObject, name: string, parent: string | null, keepWorld = true): BonePlan {
  const bones = listOf(raw["bones"]);
  const bone = bones.find((b) => b["name"] === name) ?? fail(`no bone '${name}'`);
  if ((bone["parent"] ?? null) === parent) return { commands: [], bone: name };
  const first: Command[] = [{ op: "bone.parent", name, parent }];
  if (!keepWorld) return { commands: first, bone: name };
  const skOld = setupSkeleton(raw);
  const anchors: Anchor[] = [{ kind: "bone", name }];
  const spots = snapshot(skOld, raw, anchors);
  const mid = runBatch(raw, first).doc;
  return { commands: [...first, ...restore(setupSkeleton(mid), mid, anchors, spots)], bone: name };
}

export interface SetupTransform {
  x?: number;
  y?: number;
  rotation?: number;
  length?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

/** What stays put when a bone's setup transform changes: its children (`bones`) and the images on its slots (`images`). */
export interface Keep {
  bones: boolean;
  images: boolean;
}

/**
 * Edits a bone's setup transform. `keep` (true = both) says what stays where it is in the world: the bone's children and / or the
 * images on its slots (regions and meshes); whatever is not kept follows the bone.
 */
export function planSetupTransform(raw: JsonObject, name: string, t: SetupTransform, keep: boolean | Keep): BonePlan {
  if (!boneNames(raw).includes(name)) fail(`no bone '${name}'`);
  const k: Keep = typeof keep === "boolean" ? { bones: keep, images: keep } : keep;
  const fields = Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  if (fields["length"] !== undefined && fields["length"] < 0) fail("length cannot be negative");
  const first: Command[] = [{ op: "bone.set", name, ...fields }];
  const moves = fields["x"] !== undefined || fields["y"] !== undefined || fields["rotation"] !== undefined;
  if ((!k.bones && !k.images) || !moves) return { commands: first, bone: name };
  const skOld = setupSkeleton(raw);
  const children = k.bones ? listOf(raw["bones"]).filter((b) => b["parent"] === name).map((b) => String(b["name"])) : [];
  const anchors: Anchor[] = [...children.map((c) => ({ kind: "bone", name: c }) as Anchor), ...(k.images ? regionsOnBones(raw, new Set([name])) : [])];
  const spots = snapshot(skOld, raw, anchors);
  const mid = runBatch(raw, first).doc;
  const skNew = setupSkeleton(mid);
  return { commands: [...first, ...restore(skNew, mid, anchors, spots), ...(k.images ? meshCommands(raw, skOld, mid, skNew, new Set([name])) : [])], bone: name };
}

/**
 * Deletes a bone. Its children move up to its parent and its slots and images move to the parent
 * too, all staying where they are in the world; constraints that use the bone and its clip
 * timelines are removed with it.
 */
export function planDeleteBone(raw: JsonObject, name: string): BonePlan {
  const bones = listOf(raw["bones"]);
  const bone = bones.find((b) => b["name"] === name) ?? fail(`no bone '${name}'`);
  const parent = typeof bone["parent"] === "string" ? bone["parent"] : null;
  const children = bones.filter((b) => b["parent"] === name).map((b) => String(b["name"]));
  const slots = listOf(raw["slots"]).filter((s) => s["bone"] === name).map((s) => String(s["name"]));
  if (parent === null && slots.length) fail(`'${name}' is a root bone with slots (${slots.join(", ")}); move the slots to another bone first`);
  if (parent === null && bones.filter((b) => b["parent"] === undefined).length === 1 && children.length) fail("the only root bone cannot be deleted while it has children");

  const phase1: Command[] = [];
  const removedConstraints: { kind: string; name: string }[] = [];
  for (const kind of ["ik", "transform"] as const) {
    for (const c of listOf(raw[kind])) {
      if ((c["bones"] as string[]).includes(name) || c["target"] === name) removedConstraints.push({ kind, name: String(c["name"]) });
    }
  }
  for (const c of listOf(raw["path"])) if ((c["bones"] as string[]).includes(name)) removedConstraints.push({ kind: "path", name: String(c["name"]) });
  for (const c of listOf(raw["physics"])) if (c["bone"] === name) removedConstraints.push({ kind: "physics", name: String(c["name"]) });
  // Driven corrections keyed to the bone (and grids with it as an axis) go with it, last index first so the pointers stay valid.
  const drivenOps: PatchOperation[] = [];
  listOf(raw["driven"]).forEach((d, i) => d["bone"] === name && drivenOps.unshift({ op: "remove", path: `/driven/${i}` }));
  listOf(raw["drivenGrids"]).forEach((g, i) => (objOf(g["x"])["bone"] === name || objOf(g["y"])["bone"] === name) && drivenOps.unshift({ op: "remove", path: `/drivenGrids/${i}` }));
  if (drivenOps.length) phase1.push({ op: "patch", patch: drivenOps as unknown as JsonValue });
  // Clip timelines of the bone and of the removed constraints.
  for (const [clip, def] of Object.entries(objOf(raw["animations"]))) {
    const d = objOf(def);
    if (objOf(d["bones"])[name] !== undefined) phase1.push(timelineRemoval(clip, "bones", name));
    for (const c of removedConstraints) if (objOf(d[c.kind])[c.name] !== undefined) phase1.push(timelineRemoval(clip, c.kind, c.name));
  }

  for (const c of removedConstraints) phase1.push({ op: "constraint.remove", kind: c.kind, name: c.name });
  const skOld = setupSkeleton(raw);
  const anchors: Anchor[] = [...children.map((c) => ({ kind: "bone", name: c }) as Anchor), ...regionsOnBones(raw, new Set([name]))];
  const spots = snapshot(skOld, raw, anchors);
  for (const c of children) phase1.push({ op: "bone.parent", name: c, parent });
  for (const s of slots) phase1.push({ op: "slot.set", name: s, bone: parent as string });
  const mid = runBatch(raw, phase1).doc;
  const skMid = setupSkeleton(mid);
  // Unweighted meshes of the moved slots follow their new bone; weighted ones are rebound below.
  const meshFix = meshCommands(raw, skOld, mid, skMid, new Set());
  // Weighted meshes (the mesh arms) that use the bone hand its influences to the parent, in the same world place.
  const weightFix = rebindWeightedMeshes(raw, skOld, skMid, name, parent);
  return { commands: [...phase1, ...restore(skMid, mid, anchors, spots), ...meshFix, ...weightFix, { op: "bone.remove", name }], bone: parent ?? "" };
}

export function timelineRemoval(clip: string, section: string, key: string): Command {
  return { op: "patch", patch: [{ op: "remove", path: `/animations/${esc(clip)}/${section}/${esc(key)}` }] };
}

const esc = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");

export interface BoneProps {
  /** rrggbbaa, or null to clear. */
  color?: string | null;
  /** The helper / hidden flag; null or false clears it. */
  helper?: boolean | null;
}

export function planBoneProps(raw: JsonObject, name: string, p: BoneProps): BonePlan {
  if (!boneNames(raw).includes(name)) fail(`no bone '${name}'`);
  const fields: Record<string, unknown> = {};
  if (p.color !== undefined) fields["color"] = p.color === null ? null : p.color.toLowerCase();
  if (p.helper !== undefined) fields["helper"] = p.helper ? true : null;
  return { commands: [{ op: "bone.set", name, ...fields }], bone: name };
}

// ---------------------------------------------------------------------------------------------
// Editor clips follow the document edits
// ---------------------------------------------------------------------------------------------

/**
 * The clips of the editor's library after a batch: `bone.rename` renames timelines, `bone.remove`
 * and `constraint.remove` drop theirs. Returns only the clips that changed (copies).
 */
export function fixClips(library: ReadonlyMap<string, ClipData>, commands: readonly Command[], before: JsonObject = {}, after: JsonObject = {}): Map<string, ClipData> {
  const changed = new Map<string, ClipData>();
  const edit = (name: string): ClipData => {
    let c = changed.get(name);
    if (!c) {
      c = structuredClone(library.get(name)!);
      changed.set(name, c);
    }
    return c;
  };
  for (const command of commands) {
    for (const name of library.keys()) {
      const source = changed.get(name) ?? library.get(name)!;
      if (command.op === "bone.rename") {
        const from = String(command["name"]);
        if (source.bones[from]) {
          const c = edit(name);
          c.bones[String(command["to"])] = c.bones[from]!;
          delete c.bones[from];
        }
      } else if (command.op === "bone.remove") {
        if (source.bones[String(command["name"])]) delete edit(name).bones[String(command["name"])];
      } else if (command.op === "constraint.remove") {
        const kind = String(command["kind"]) as "ik" | "transform" | "path" | "physics";
        if (source[kind]?.[String(command["name"])]) delete edit(name)[kind][String(command["name"])];
      }
    }
  }
  // Registered fixers (mesh / weights tools remap deform keys when geometry changes) see each clip as the built-in rules left it.
  if (clipFixers.length) {
    for (const name of library.keys()) {
      for (const fixer of clipFixers) {
        const source = changed.get(name) ?? library.get(name)!;
        const next = fixer(source, { name, commands, before, after });
        if (next) changed.set(name, next);
      }
    }
  }
  return changed;
}

/** What a clip fixer is told: which clip, the batch, and the rig document before and after it. */
export interface ClipFixContext {
  name: string;
  commands: readonly Command[];
  before: JsonObject;
  after: JsonObject;
}

/** Returns a changed copy of the clip, or null when the batch does not touch it. Must not mutate its input. */
export type ClipFixer = (clip: ClipData, ctx: ClipFixContext) => ClipData | null;

const clipFixers: ClipFixer[] = [];

/** Adds a hook that `fixClips` runs after its built-in rename / drop rules. Returns an unregister function. */
export function registerClipFixer(fn: ClipFixer): () => void {
  clipFixers.push(fn);
  return () => {
    const i = clipFixers.indexOf(fn);
    if (i >= 0) clipFixers.splice(i, 1);
  };
}

/** The names a batch would remove from clips (for a status line). */
export function describeBatch(commands: readonly Command[]): string {
  const ops = commands.map((c) => c.op).filter((o) => o !== "patch");
  return [...new Set(ops)].join(", ");
}

export type { JsonValue };
