/*
 * Atlas Animator editor: Setup / Rig plans for hidden-features batch 3 (pure; no DOM).
 *
 * Bone fields (scale, shear, inherit, rotation limits), slot management (new, delete, rename, colour, blend, draw order),
 * constraint ordering and the extra constraint kinds (1-bone IK, transform constraint). Each plan is a command batch that
 * goes through the Setup commit path (setupMode.run), so it is validated, undoable and saved with the rig.
 */
import type { ClipData } from "@atlas-animator/core/core";
import type { PatchOperation } from "@atlas-animator/core/patch";
import { boneNames, canvasOrigin, fail, listOf, objOf, r4, runBatch, setupSkeleton, slotNames, timelineRemoval, uniqueName, type Command, type JsonObject } from "./setupModel.js";
import { TRANSFORM_MIXES } from "./setupConstraints.js";

const esc = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");

export interface RigPlan {
  commands: Command[];
  bone?: string | null;
  /** Rewrites an editor clip (the library copy) the same way the plan rewrote the document's clips; null = untouched. */
  clip?: (clip: ClipData) => ClipData | null;
}

// ---------------------------------------------------------------------------------------------
// Bone fields
// ---------------------------------------------------------------------------------------------

export interface BoneFieldValues {
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

/** Setup scale / shear of a bone (local; the children follow, as in Spine). */
export function planBoneFields(raw: JsonObject, name: string, v: BoneFieldValues): RigPlan {
  if (!boneNames(raw).includes(name)) fail(`no bone '${name}'`);
  for (const [k, n] of Object.entries(v)) if (!Number.isFinite(n)) fail(`${k} must be a number`);
  if (v.scaleX === 0 || v.scaleY === 0) fail("A bone cannot have a scale of 0");
  return { commands: [{ op: "bone.set", name, ...v }], bone: name };
}

/** Rotation limits (degrees relative to the setup rotation); null clears them. */
export function planBoneLimits(raw: JsonObject, name: string, limits: { min: number; max: number } | null): RigPlan {
  if (!boneNames(raw).includes(name)) fail(`no bone '${name}'`);
  if (!limits) return { commands: [{ op: "bone.limits", name, clear: true }], bone: name };
  if (!Number.isFinite(limits.min) || !Number.isFinite(limits.max)) fail("limits must be numbers");
  if (limits.min > limits.max) fail("The minimum limit is above the maximum");
  if (limits.max - limits.min > 360) fail("Limits span at most 360 degrees");
  return { commands: [{ op: "bone.limits", name, min: limits.min, max: limits.max }], bone: name };
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

/** The setup draw order, back to front: the document's drawOrder, or the slot list. Slots anchored to another slot are left out. */
export function drawOrderOf(raw: JsonObject): string[] {
  const slots = listOf(raw["slots"]);
  const anchored = new Set(slots.filter((s) => s["drawAfter"] !== undefined || s["drawBefore"] !== undefined).map((s) => String(s["name"])));
  const all = new Set(slots.map((s) => String(s["name"])));
  const listed = Array.isArray(raw["drawOrder"]) ? (raw["drawOrder"] as string[]).filter((n) => all.has(n)) : slots.map((s) => String(s["name"]));
  const out = listed.filter((n) => !anchored.has(n));
  for (const s of slots) if (!anchored.has(String(s["name"])) && !out.includes(String(s["name"]))) out.push(String(s["name"]));
  return out;
}

export const isAnchored = (raw: JsonObject, slot: string): boolean => listOf(raw["slots"]).some((s) => s["name"] === slot && (s["drawAfter"] !== undefined || s["drawBefore"] !== undefined));

/** A new empty slot on `bone`, drawn in front of everything (or just above `above`). */
export function planNewSlot(raw: JsonObject, bone: string, o: { name?: string; above?: string | null } = {}): RigPlan {
  if (!boneNames(raw).includes(bone)) fail(`no bone '${bone}'`);
  const name = uniqueName(slotNames(raw), o.name?.trim() || `${bone}_slot`);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) fail(`'${name}' is not a valid slot name`);
  const above = o.above && slotNames(raw).includes(o.above) && !isAnchored(raw, o.above) ? o.above : null;
  return { commands: [{ op: "slot.add", name, bone, ...(above ? { after: above } : {}) }], bone };
}

/** Slot-level references inside one clip (a document clip or a library clip); returns a changed copy or null. */
function mapClip(clip: ClipData, from: string, to: string | null): ClipData | null {
  const c = structuredClone(clip) as unknown as JsonObject;
  let changed = false;
  const slots = objOf(c["slots"]);
  if (slots[from] !== undefined) {
    if (to !== null) slots[to] = slots[from]!;
    delete slots[from];
    changed = true;
  }
  const order = Array.isArray(c["drawOrder"]) ? (c["drawOrder"] as JsonObject[]) : [];
  for (const key of order) {
    const offsets = Array.isArray(key["offsets"]) ? (key["offsets"] as JsonObject[]) : [];
    const next = offsets.filter((o) => (to === null ? o["slot"] !== from : true)).map((o) => (o["slot"] === from && to !== null ? { ...o, slot: to } : o));
    if (next.length !== offsets.length || next.some((o, i) => o !== offsets[i])) {
      key["offsets"] = next;
      changed = true;
    }
  }
  const deform = objOf(c["deform"]);
  for (const bySlot of Object.values(deform)) {
    const m = objOf(bySlot as JsonObject);
    if (m[from] !== undefined) {
      if (to !== null) m[to] = m[from]!;
      delete m[from];
      changed = true;
    }
  }
  return changed ? (c as unknown as ClipData) : null;
}

function clipPatch(raw: JsonObject, from: string, to: string | null): PatchOperation[] {
  const out: PatchOperation[] = [];
  for (const [name, clip] of Object.entries(objOf(raw["animations"]))) {
    const next = mapClip(clip as unknown as ClipData, from, to);
    if (next) out.push({ op: "replace", path: `/animations/${esc(name)}`, value: next as never });
  }
  return out;
}

/** Deletes a slot with its images, its clip keys and any anchor that pointed at it. */
export function planDeleteSlot(raw: JsonObject, slot: string): RigPlan {
  if (!slotNames(raw).includes(slot)) fail(`no slot '${slot}'`);
  const commands: Command[] = [];
  for (const s of listOf(raw["slots"])) {
    if (s["name"] === slot) continue;
    if (s["drawAfter"] === slot) commands.push({ op: "slot.set", name: String(s["name"]), drawAfter: null });
    if (s["drawBefore"] === slot) commands.push({ op: "slot.set", name: String(s["name"]), drawBefore: null });
  }
  const patch: PatchOperation[] = [];
  for (const [skin, def] of Object.entries(objOf(raw["skins"]))) {
    const d = objOf(def as JsonObject);
    if (objOf(d["attachments"])[slot] !== undefined) patch.push({ op: "remove", path: `/skins/${esc(skin)}/attachments/${esc(slot)}` });
    if (Array.isArray(d["hides"]) && (d["hides"] as string[]).includes(slot)) patch.push({ op: "replace", path: `/skins/${esc(skin)}/hides`, value: (d["hides"] as string[]).filter((n) => n !== slot) });
  }
  patch.push(...clipPatch(raw, slot, null));
  if (patch.length) commands.push({ op: "patch", patch });
  // A path constraint whose path sits in this slot goes with it (its clip timelines too).
  for (const c of listOf(raw["path"])) {
    if (c["target"] !== slot) continue;
    for (const [clip, def] of Object.entries(objOf(raw["animations"]))) if (objOf(objOf(def as JsonObject)["path"])[String(c["name"])] !== undefined) commands.push(timelineRemoval(clip, "path", String(c["name"])));
    commands.push({ op: "constraint.remove", kind: "path", name: String(c["name"]) });
  }
  commands.push({ op: "slot.remove", name: slot });
  return { commands, clip: (c) => mapClip(c, slot, null) };
}

/** Renames a slot everywhere: the list, draw order, anchors, skins' images and hides, and the clips' keys. */
export function planRenameSlot(raw: JsonObject, slot: string, to: string): RigPlan {
  const slots = listOf(raw["slots"]);
  if (!slots.some((s) => s["name"] === slot)) fail(`no slot '${slot}'`);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(to)) fail(`'${to}' is not a valid slot name (letters, digits, _ . -)`);
  if (to === slot) return { commands: [] };
  if (slotNames(raw).includes(to)) fail(`A slot called "${to}" already exists`);
  const patch: PatchOperation[] = [];
  slots.forEach((s, i) => {
    if (s["name"] === slot) patch.push({ op: "replace", path: `/slots/${i}/name`, value: to });
    if (s["drawAfter"] === slot) patch.push({ op: "replace", path: `/slots/${i}/drawAfter`, value: to });
    if (s["drawBefore"] === slot) patch.push({ op: "replace", path: `/slots/${i}/drawBefore`, value: to });
  });
  if (Array.isArray(raw["drawOrder"])) (raw["drawOrder"] as string[]).forEach((n, i) => n === slot && patch.push({ op: "replace", path: `/drawOrder/${i}`, value: to }));
  for (const [skin, def] of Object.entries(objOf(raw["skins"]))) {
    const d = objOf(def as JsonObject);
    if (objOf(d["attachments"])[slot] !== undefined) patch.push({ op: "move", from: `/skins/${esc(skin)}/attachments/${esc(slot)}`, path: `/skins/${esc(skin)}/attachments/${esc(to)}` });
    if (Array.isArray(d["hides"])) (d["hides"] as string[]).forEach((n, i) => n === slot && patch.push({ op: "replace", path: `/skins/${esc(skin)}/hides/${i}`, value: to }));
  }
  patch.push(...clipPatch(raw, slot, to));
  return { commands: [{ op: "patch", patch }], clip: (c) => mapClip(c, slot, to) };
}

/** Slot colour (rrggbbaa) and blend mode. */
export function planSlotLook(raw: JsonObject, slot: string, v: { color?: string; blend?: "normal" | "additive" }): RigPlan {
  if (!slotNames(raw).includes(slot)) fail(`no slot '${slot}'`);
  if (v.color !== undefined && !/^[0-9a-fA-F]{8}$/.test(v.color)) fail("A colour is 8 hex digits (rrggbbaa)");
  return { commands: [{ op: "slot.set", name: slot, ...(v.color !== undefined ? { color: v.color.toLowerCase() } : {}), ...(v.blend !== undefined ? { blend: v.blend } : {}) }] };
}

export type DrawMove = "up" | "down" | "front" | "back";

/** Moves a slot in the setup draw order. "up" = one step toward the front (drawn later), "front" = drawn last. No-op = no commands. */
export function planDrawOrder(raw: JsonObject, slot: string, how: DrawMove): RigPlan {
  if (!slotNames(raw).includes(slot)) fail(`no slot '${slot}'`);
  if (isAnchored(raw, slot)) fail(`'${slot}' is drawn relative to another slot (drawAfter / drawBefore); clear that first`);
  const order = drawOrderOf(raw);
  const at = order.indexOf(slot);
  if (at < 0) fail(`no slot '${slot}' in the draw order`);
  if (how === "up") return at >= order.length - 1 ? { commands: [] } : { commands: [{ op: "slot.order", name: slot, after: order[at + 1]! }] };
  if (how === "down") return at <= 0 ? { commands: [] } : { commands: [{ op: "slot.order", name: slot, before: order[at - 1]! }] };
  if (how === "front") return at >= order.length - 1 ? { commands: [] } : { commands: [{ op: "slot.order", name: slot, after: order[order.length - 1]! }] };
  return at <= 0 ? { commands: [] } : { commands: [{ op: "slot.order", name: slot, before: order[0]! }] };
}

/** Drops `slot` before or after `target` in the draw order (list drag). */
export function planDrawOrderTo(raw: JsonObject, slot: string, target: string, side: "before" | "after"): RigPlan {
  if (slot === target) return { commands: [] };
  if (isAnchored(raw, slot) || isAnchored(raw, target)) fail("A slot drawn relative to another slot cannot be dragged; clear its drawAfter / drawBefore first");
  const order = drawOrderOf(raw);
  const a = order.indexOf(slot);
  const b = order.indexOf(target);
  if (a < 0 || b < 0) fail("unknown slot in the draw order");
  // Already there: right after / right before the target.
  if ((side === "after" && a === b + 1) || (side === "before" && a === b - 1)) return { commands: [] };
  return { commands: [{ op: "slot.order", name: slot, [side]: target }] };
}

// ---------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------

export type AnyConstraintKind = "ik" | "transform" | "path" | "physics";

export interface OrderedConstraint {
  kind: AnyConstraintKind;
  name: string;
  order: number;
}

const DEFAULT_ORDER: Record<AnyConstraintKind, number> = { ik: 0, transform: 1, path: 2, physics: 3 };

/** Every constraint in the order the engine runs them (order, then kind, then list position). */
export function constraintSequence(raw: JsonObject): OrderedConstraint[] {
  const out: OrderedConstraint[] = [];
  for (const kind of ["ik", "transform", "path", "physics"] as const) for (const c of listOf(raw[kind])) out.push({ kind, name: String(c["name"]), order: typeof c["order"] === "number" ? c["order"] : DEFAULT_ORDER[kind] });
  return out.sort((a, b) => a.order - b.order);
}

/** Moves a constraint one place earlier ("up") or later ("down") in the run order, by writing explicit `order` positions. */
export function planConstraintMove(raw: JsonObject, kind: AnyConstraintKind, name: string, dir: "up" | "down"): RigPlan {
  const seq = constraintSequence(raw);
  const at = seq.findIndex((c) => c.kind === kind && c.name === name);
  if (at < 0) fail(`no ${kind} constraint '${name}'`);
  const to = dir === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= seq.length) return { commands: [] };
  const next = [...seq];
  [next[at], next[to]] = [next[to]!, next[at]!];
  const commands: Command[] = [];
  next.forEach((c, i) => {
    const current = typeof listOf(raw[c.kind]).find((x) => x["name"] === c.name)?.["order"] === "number" ? c.order : null;
    if (current !== i) commands.push({ op: "constraint.set", kind: c.kind, name: c.name, fields: { order: i } });
  });
  return { commands };
}

/** A 1-bone IK: `bone` turns toward a new helper target bone placed at its tip. Starts at mix 0 so clips keep their pose. */
export function planAddOneBoneIk(raw: JsonObject, bone: string, o: { name?: string; target?: string } = {}): RigPlan & { constraint: string; target: string } {
  const bones = listOf(raw["bones"]);
  if (!bones.some((b) => b["name"] === bone)) fail(`no bone '${bone}'`);
  for (const c of listOf(raw["ik"])) if ((c["bones"] as string[]).includes(bone)) fail(`'${bone}' already has the IK '${String(c["name"])}'`);
  const taken = [...listOf(raw["ik"]), ...listOf(raw["transform"]), ...listOf(raw["path"]), ...listOf(raw["physics"])].map((c) => String(c["name"]));
  const constraint = uniqueName(taken, o.name ?? `${bone}_ik`);
  const sk = setupSkeleton(raw);
  const b = sk.getBone(bone);
  const tip = b.localToWorld(b.data.length, 0, { x: 0, y: 0 });
  const root = bones.find((x) => x["parent"] === undefined);
  const origin = canvasOrigin(raw);
  const target = uniqueName(boneNames(raw), o.target ?? `${bone}_target`);
  return {
    commands: [
      { op: "bone.add", name: target, ...(root ? { parent: String(root["name"]) } : {}), world: [r4(tip.x + origin.x), r4(tip.y + origin.y)], helper: true },
      { op: "constraint.add", kind: "ik", constraint: { name: constraint, bones: [bone], target, bendPositive: true, mix: 0 } }
    ],
    bone,
    constraint,
    target
  };
}

/** A transform constraint copying `target` onto `bone`. Every mix starts at 0 so nothing moves until you raise one. */
export function planAddTransformConstraint(raw: JsonObject, bone: string, o: { name?: string; target?: string } = {}): RigPlan & { constraint: string; target: string } {
  const bones = listOf(raw["bones"]);
  const data = bones.find((b) => b["name"] === bone) ?? fail(`no bone '${bone}'`);
  const fallback = typeof data["parent"] === "string" ? data["parent"] : bones.find((b) => b["name"] !== bone)?.["name"];
  const target = o.target ?? (typeof fallback === "string" ? fallback : fail("The rig needs a second bone to use as the target"));
  if (!boneNames(raw).includes(target)) fail(`no bone '${target}'`);
  if (target === bone) fail("A bone cannot be its own transform target");
  const taken = [...listOf(raw["ik"]), ...listOf(raw["transform"]), ...listOf(raw["path"]), ...listOf(raw["physics"])].map((c) => String(c["name"]));
  const constraint = uniqueName(taken, o.name ?? `${bone}_tc`);
  const mixes = Object.fromEntries(TRANSFORM_MIXES.map((k) => [k, 0]));
  return { commands: [{ op: "constraint.add", kind: "transform", constraint: { name: constraint, bones: [bone], target, ...mixes } }], bone, constraint, target };
}

/**
 * A physics constraint on `bone` (hair, cape, tail, pouch): the bone swings about its own origin with a spring. It starts with Rotate 1 and a
 * soft spring so the swing shows at once; Mix 1 (physics is cosmetic and never networked). Runs after the IK and transform constraints.
 */
export function planAddPhysics(raw: JsonObject, bone: string, o: { name?: string } = {}): RigPlan & { constraint: string } {
  if (!boneNames(raw).includes(bone)) fail(`no bone '${bone}'`);
  for (const c of listOf(raw["physics"])) if (c["bone"] === bone) fail(`'${bone}' already has the physics '${String(c["name"])}'`);
  const taken = [...listOf(raw["ik"]), ...listOf(raw["transform"]), ...listOf(raw["path"]), ...listOf(raw["physics"])].map((c) => String(c["name"]));
  const constraint = uniqueName(taken, o.name ?? `${bone}_physics`);
  return { commands: [{ op: "constraint.add", kind: "physics", constraint: { name: constraint, bone, rotate: 1, inertia: 0.6, strength: 60, damping: 0.85, gravity: 0, mix: 1 } }], bone, constraint };
}

// ---------------------------------------------------------------------------------------------
// Several bones in one batch (Tree multi-select, Delete, rotate / move drags): one command list, so one undo step
// ---------------------------------------------------------------------------------------------

/**
 * Plans one edit per bone against the document the earlier ones produce, and joins them into a single batch. A bone that an earlier
 * step removed is skipped. A refusal from any step refuses the whole batch.
 */
export function chainBonePlans(raw: JsonObject, names: readonly string[], plan: (cur: JsonObject, name: string) => { commands: Command[] }): RigPlan {
  let cur = raw;
  const commands: Command[] = [];
  for (const name of names) {
    if (!boneNames(cur).includes(name)) continue;
    const step = plan(cur, name);
    if (!step.commands.length) continue;
    commands.push(...step.commands);
    cur = runBatch(cur, step.commands).doc;
  }
  return { commands };
}

/** What a bone delete touches, for the confirm: the bones, the children and slots that move up, the constraints that go. */
export function deleteSummary(raw: JsonObject, names: readonly string[]): { bones: number; children: number; slots: number; constraints: number } {
  const set = new Set(names);
  const bones = listOf(raw["bones"]);
  const constraints = [...listOf(raw["ik"]), ...listOf(raw["transform"])].filter((c) => (Array.isArray(c["bones"]) && (c["bones"] as string[]).some((b) => set.has(b))) || (typeof c["target"] === "string" && set.has(c["target"]))).length + listOf(raw["path"]).filter((c) => Array.isArray(c["bones"]) && (c["bones"] as string[]).some((b) => set.has(b))).length + listOf(raw["physics"]).filter((c) => typeof c["bone"] === "string" && set.has(c["bone"])).length;
  return {
    bones: names.length,
    children: bones.filter((b) => typeof b["parent"] === "string" && set.has(b["parent"]) && !set.has(String(b["name"]))).length,
    slots: listOf(raw["slots"]).filter((x) => typeof x["bone"] === "string" && set.has(x["bone"])).length,
    constraints
  };
}
