/*
 * Atlas Animator editor: the rig contract as data (Batch 10, PL-05).
 *
 * What a rig needs so swag fits it: slots (named for the body part they cover), the bones those slots ride, and the weapon `grip` /
 * `tip` points. The names below are the LEGACY kit-body-cutout vocabulary (`ITEM_SLOT_MAP`, `boneForAddedSlot`); every slot also carries the
 * part-named rig v2 name it maps onto (`chest_torso`, `chest_sleeve_*`, `pants_hips`, `pants_leg_*`, `boot_*`, `glove_*`, `cape`, `helmet_*`)
 * and its fitting tier (A = linked mesh of the canonical body mesh, B = own mesh + weights), so the v2 build only renames, never re-designs.
 *
 * Pure: `contractStatus` says what a rig document lacks, `planCreateMissing` is the undoable command batch that adds it, and
 * `contractJson` is the file form (`CONTRACT.json`) the validator reads.
 */
// Node-safe: the dev server seeds Player skeleton rigs with it, so it takes no value import from the engine package.
import type { Command, JsonObject } from "./setupModel.js";
import { boneForAddedSlot, ITEM_SLOT_MAP, ITEM_SLOTS, type ItemSlot } from "./swagModel.js";

const objOf = (v: unknown): JsonObject => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : {});
const listOf = (v: unknown): JsonObject[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null && !Array.isArray(x)) as JsonObject[]) : []);
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4 + 0;
const boneNames = (raw: JsonObject): string[] => listOf(raw["bones"]).map((b) => String(b["name"]));
const slotNames = (raw: JsonObject): string[] => listOf(raw["slots"]).map((s) => String(s["name"]));
const fail = (message: string): never => {
  throw new Error(message);
};

export const CONTRACT_ID = "legacy-kit";
export const CONTRACT_REVISION = 1;
export const CONTRACT_FILE = "CONTRACT.json";

/** Setup bones, parents first: name, parent, x, y, rotation, length (the kit-body-cutout setup pose; positions are local to the parent). */
export const CONTRACT_BONES: readonly (readonly [string, string | null, number, number, number, number])[] = [
  ["root", null, 0, 210, 0, 0],
  ["body", "root", 0, -210, 0, 60],
  ["pelvis", "body", 0, 0, 90, 70],
  ["thigh_near", "pelvis", 46.171, 67.6405, 6.8428, 99.5381],
  ["shin_near", "thigh_near", 99.5381, 0, -2.5229, 65.1852],
  ["foot_near", "shin_near", 65.1852, 0, 16.3756, 48.1041],
  ["knee_near", "thigh_near", 99.5381, 0, -2.5229, 24],
  ["thigh_far", "pelvis", 46.3526, -62.4011, -9.8336, 100.1183],
  ["shin_far", "thigh_far", 100.1183, 0, 5.5137, 65.1852],
  ["foot_far", "shin_far", 65.1852, 0, -16.3756, 48.1041],
  ["knee_far", "thigh_far", 100.1183, 0, 5.5137, 24],
  ["hip_near", "pelvis", 46.171, 67.6405, 6.8428, 24],
  ["hip_far", "pelvis", 46.3526, -62.4011, -9.8336, 24],
  ["spine_1", "pelvis", -55, 0, -180, 70],
  ["spine_2", "spine_1", 70, 0, 0, 70],
  ["chest", "spine_2", 70, 0, 0, 65],
  ["neck", "chest", 65, 0, 0, 50],
  ["head", "neck", 33, -6.29, 0, 250],
  ["hair_1", "head", 240, 0, 0, 90],
  ["clavicle_near", "chest", 62, -14, -106.8788, 89.5476],
  ["upper_arm_near", "clavicle_near", 89.5476, 0, -44.0362, 91.5437],
  ["forearm_near", "upper_arm_near", 91.5437, 0, -3.9003, 92.8238],
  ["hand_near", "forearm_near", 92.8238, 0, 0.0088, 75],
  ["weapon", "hand_near", 55, -9.6, -90, 60],
  ["weapon_tip", "weapon", 410, 0, 0, 20],
  ["clavicle_far", "chest", 62, 14, 106.583, 91.099],
  ["upper_arm_far", "clavicle_far", 91.099, 0, 44.3320, 91.5437],
  ["forearm_far", "upper_arm_far", 91.5437, 0, 3.9003, 92.8238],
  ["hand_far", "forearm_far", 92.8238, 0, -0.0088, 75]
];

/** The slot the weapon `grip` / `tip` points ride when the rig has no point of its own yet. */
export const POINT_SLOT = "weapon_points";
export const CONTRACT_POINTS: readonly { name: "grip" | "tip"; bone: string; legacyBone: string; x: number }[] = [
  { name: "grip", bone: "weapon", legacyBone: "weapon", x: 0 },
  { name: "tip", bone: "weapon", legacyBone: "weapon_tip", x: 410 }
];

export type Tier = "A" | "B";
export interface ContractSlot {
  slot: string;
  /** The bone the slot rides. */
  bone: string;
  itemSlot: ItemSlot;
  /** The part-named rig v2 slot this one maps onto. */
  v2: string;
  tier: Tier;
  /** Created on first use by an item (boots, gloves, chain, cape, helmet, mask): not counted as missing. */
  onDemand: boolean;
}

/** Legacy slot -> bone. */
export function boneOfSlot(slot: string): string | null {
  const added = boneForAddedSlot(slot);
  if (added) return added;
  const m = /_(near|far)$/.exec(slot);
  const s = m?.[1];
  if (slot === "shirt_torso" || slot === "pants_waist") return "pelvis";
  if (/^(shirt_strap|shirt_sleeve|skin_arm)_/.test(slot) && s) return `upper_arm_${s}`;
  const p = /^pants_(cuff|shin|hip|knee|thigh)_(near|far)$/.exec(slot);
  if (p) return `${p[1] === "cuff" ? "shin" : p[1]}_${p[2]}`;
  if (slot === "hair_front" || slot === "hair_back") return "hair_1";
  if (["eyes", "brows", "nose", "mouth"].includes(slot)) return "head";
  if (slot === "weapon") return "weapon";
  return null;
}

/** Legacy slot -> rig v2 part name. */
export function v2NameOf(slot: string): string {
  const fixed: Record<string, string> = { shirt_torso: "chest_torso", pants_waist: "pants_hips", chain: "chain", cape_back: "cape", helmet: "helmet_front", mask: "mask", weapon: "weapon" };
  if (fixed[slot]) return fixed[slot]!;
  let m = /^shirt_sleeve_(near|far)$/.exec(slot);
  if (m) return `chest_sleeve_${m[1]}`;
  m = /^pants_(?:cuff|hip|knee|shin|thigh)_(near|far)$/.exec(slot);
  if (m) return `pants_leg_${m[1]}`;
  m = /^boots_(?:foot|shin)_(near|far)$/.exec(slot);
  if (m) return `boot_${m[1]}`;
  m = /^gloves_hand_(near|far)(_back)?$/.exec(slot);
  if (m) return `glove_${m[1]}${m[2] ? "_fingers" : ""}`;
  return slot;
}

/** Fitted garments (cloth, leather, thin plate) link the body mesh (A); hats, capes and bulky pieces bring their own mesh (B). */
const tierOf = (item: ItemSlot): Tier => (item === "chest" || item === "pants" || item === "gloves" || item === "boots" ? "A" : "B");

/** Every slot of the contract, in back-to-front order of the item slots. */
export const CONTRACT_SLOTS: readonly ContractSlot[] = ITEM_SLOTS.flatMap((itemSlot) => [
  ...ITEM_SLOT_MAP[itemSlot].existing.map((slot) => ({ slot, onDemand: false, itemSlot })),
  ...ITEM_SLOT_MAP[itemSlot].added.map((slot) => ({ slot, onDemand: true, itemSlot }))
]).flatMap((e): ContractSlot[] => {
  const bone = boneOfSlot(e.slot);
  return bone ? [{ slot: e.slot, bone, itemSlot: e.itemSlot, v2: v2NameOf(e.slot), tier: tierOf(e.itemSlot), onDemand: e.onDemand }] : [];
});

export type PointState = "point" | "bone" | "missing";

export interface ContractStatus {
  missingBones: string[];
  missingSlots: string[];
  /** Slots an item creates on first use that the rig does not have yet (informational). */
  onDemandSlots: string[];
  points: { name: string; state: PointState }[];
  missingPoints: string[];
  /** Missing bones + slots + points. 0 = the rig is wearable. */
  missing: number;
  /** Everything the contract lists (bones + core slots + points), for "n of m". */
  total: number;
}

const baseSkinName = (raw: JsonObject): string => Object.keys(objOf(raw["skins"]))[0] ?? "default";

/** A point attachment called `name` on a slot of any skin. */
function hasPoint(raw: JsonObject, name: string): boolean {
  for (const def of Object.values(objOf(raw["skins"]))) {
    for (const byName of Object.values(objOf(objOf(def as JsonObject)["attachments"]))) {
      const a = objOf(objOf(byName as JsonObject)[name]);
      if (a["type"] === "point") return true;
    }
  }
  return false;
}

/** What `raw` lacks of the contract. A rig whose `weapon` / `weapon_tip` bones exist already has a grip and a tip (the bone origin, the legacy form). */
export function contractStatus(raw: JsonObject): ContractStatus {
  const bones = new Set(boneNames(raw));
  const slots = new Set(slotNames(raw));
  const missingBones = CONTRACT_BONES.map((b) => b[0]).filter((n) => !bones.has(n));
  const core = CONTRACT_SLOTS.filter((s) => !s.onDemand);
  const missingSlots = core.map((s) => s.slot).filter((n) => !slots.has(n));
  const onDemandSlots = CONTRACT_SLOTS.filter((s) => s.onDemand && !slots.has(s.slot)).map((s) => s.slot);
  const points = CONTRACT_POINTS.map((p) => ({ name: p.name, state: (hasPoint(raw, p.name) ? "point" : bones.has(p.legacyBone) ? "bone" : "missing") as PointState }));
  const missingPoints = points.filter((p) => p.state === "missing").map((p) => p.name);
  return { missingBones, missingSlots, onDemandSlots, points, missingPoints, missing: missingBones.length + missingSlots.length + missingPoints.length, total: CONTRACT_BONES.length + core.length + CONTRACT_POINTS.length };
}

export interface ContractPlan {
  commands: Command[];
  bone: string | null;
}

/** The command batch that adds what is missing (bones, then slots after their neighbours, then the points); `onDemand` also adds the first-use slots. One batch = one undo step. */
export function planCreateMissing(raw: JsonObject, o: { onDemand?: boolean } = {}): ContractPlan {
  const st = contractStatus(raw);
  const bones = new Set(boneNames(raw));
  const root = listOf(raw["bones"]).find((b) => b["parent"] === undefined || b["parent"] === null);
  const commands: Command[] = [];
  for (const [name, parent, x, y, rotation, length] of CONTRACT_BONES) {
    if (bones.has(name)) continue;
    let par = parent;
    if (par !== null && !bones.has(par)) par = root ? String(root["name"]) : null;
    if (par === null) {
      if (root) continue; // the document has its own root
      commands.push({ op: "bone.add", name, x, y, rotation, length } as Command);
    } else commands.push({ op: "bone.add", name, parent: par, x: r4(x), y: r4(y), rotation: r4(rotation), length: r4(length) } as Command);
    bones.add(name);
  }
  const slots = new Set(slotNames(raw));
  const anchored = new Set(listOf(raw["slots"]).filter((s) => s["drawAfter"] !== undefined || s["drawBefore"] !== undefined).map((s) => String(s["name"])));
  const want = new Set([...st.missingSlots, ...(o.onDemand ? st.onDemandSlots : [])]);
  let prev: string | null = null;
  for (const c of CONTRACT_SLOTS) {
    if (want.has(c.slot) && !slots.has(c.slot)) {
      commands.push({ op: "slot.add", name: c.slot, bone: c.bone, ...(prev && !anchored.has(prev) ? { after: prev } : {}) } as Command);
      slots.add(c.slot);
    }
    if (slots.has(c.slot)) prev = c.slot;
  }
  if (st.missingPoints.length) {
    const skin = baseSkinName(raw);
    if (!slots.has(POINT_SLOT)) commands.push({ op: "slot.add", name: POINT_SLOT, bone: "weapon" } as Command);
    for (const p of CONTRACT_POINTS) {
      if (!st.missingPoints.includes(p.name)) continue;
      commands.push({ op: "attachment.add", skin, slot: POINT_SLOT, name: p.name, attachment: { type: "point", x: p.x, y: 0, rotation: 0 } } as Command);
    }
  }
  if (!commands.length) fail("The rig already has everything the contract lists");
  return { commands, bone: null };
}

/** The first-use slots plus an explicit grip and tip point, for the Player skeleton start (a rig that is wearable from the first minute). */
export function planSeedPlayer(raw: JsonObject): Command[] {
  const missing = planCreateMissing(raw, { onDemand: true }).commands;
  const skin = baseSkinName(raw);
  const have = new Set(slotNames(raw));
  const added = new Set(missing.filter((c) => c["op"] === "slot.add").map((c) => String(c["name"])));
  const out = [...missing];
  if (!have.has(POINT_SLOT) && !added.has(POINT_SLOT)) out.push({ op: "slot.add", name: POINT_SLOT, bone: "weapon" } as Command);
  for (const p of CONTRACT_POINTS) if (!hasPoint(raw, p.name) && !out.some((c) => c["op"] === "attachment.add" && c["name"] === p.name)) out.push({ op: "attachment.add", skin, slot: POINT_SLOT, name: p.name, attachment: { type: "point", x: p.x, y: 0, rotation: 0 } } as Command);
  return out;
}

/** The `CONTRACT.json` form: what the validator and the rig v2 build read. */
export function contractJson(): Record<string, unknown> {
  return {
    format: "rig-contract@1",
    id: CONTRACT_ID,
    revision: CONTRACT_REVISION,
    bones: CONTRACT_BONES.map(([name, parent, x, y, rotation, length]) => ({ name, parent, x, y, rotation, length })),
    slots: CONTRACT_SLOTS.map((s) => ({ name: s.slot, bone: s.bone, itemSlot: s.itemSlot, v2: s.v2, tier: s.tier, onDemand: s.onDemand })),
    points: CONTRACT_POINTS.map((p) => ({ name: p.name, slot: POINT_SLOT, bone: p.bone, legacyBone: p.legacyBone }))
  };
}

/** Validates a contract file object against the editor's own: same ids, every slot on a listed bone, no duplicate names. Returns problems. */
export function validateContract(file: unknown): string[] {
  const out: string[] = [];
  const f = objOf(file as never);
  if (f["format"] !== "rig-contract@1") out.push("format must be rig-contract@1");
  const bones = listOf(f["bones"] as never).map((b) => String(b["name"]));
  const dupe = (list: string[], what: string) => list.forEach((n, i) => list.indexOf(n) !== i && out.push(`duplicate ${what} ${n}`));
  dupe(bones, "bone");
  const slots = listOf(f["slots"] as never);
  dupe(slots.map((s) => String(s["name"])), "slot");
  for (const s of slots) if (!bones.includes(String(s["bone"]))) out.push(`slot ${String(s["name"])} rides ${String(s["bone"])}, which the contract does not list`);
  for (const p of listOf(f["points"] as never)) if (!bones.includes(String(p["bone"]))) out.push(`point ${String(p["name"])} rides ${String(p["bone"])}, which the contract does not list`);
  return out;
}

/** Applies the bone.add / slot.add / attachment.add commands of planSeedPlayer / planCreateMissing straight to a rig document (no engine import: the dev server uses it when it writes a new rig). */
export function applyContractCommands(doc: JsonObject, commands: readonly Command[]): JsonObject {
  const bones = (doc["bones"] ??= []) as JsonObject[];
  const slots = (doc["slots"] ??= []) as JsonObject[];
  const skins = (doc["skins"] ??= {}) as Record<string, JsonObject>;
  for (const c of commands) {
    if (c["op"] === "bone.add") {
      const { op: _op, ...bone } = c as Record<string, unknown>;
      bones.push(bone as JsonObject);
    } else if (c["op"] === "slot.add") {
      const slot: JsonObject = { name: String(c["name"]), bone: String(c["bone"]) } as JsonObject;
      const at = typeof c["after"] === "string" ? slots.findIndex((s) => s["name"] === c["after"]) : -1;
      if (at >= 0) slots.splice(at + 1, 0, slot);
      else slots.push(slot);
    } else if (c["op"] === "attachment.add") {
      const skin = (skins[String(c["skin"])] ??= { attachments: {} } as JsonObject);
      const atts = (skin["attachments"] ??= {}) as Record<string, Record<string, unknown>>;
      (atts[String(c["slot"])] ??= {})[String(c["name"])] = c["attachment"];
    } else throw new Error("applyContractCommands: unsupported op " + String(c["op"]));
  }
  return doc;
}
