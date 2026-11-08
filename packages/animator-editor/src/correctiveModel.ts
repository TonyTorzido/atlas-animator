/*
 * Atlas Animator editor: elbow / knee correctives (pure; no DOM). Batch 7b-2,  / .
 *
 * A corrective is a driven set (`driven`): deform keyed on a driver bone's angle, applied under every clip. The engine already has the
 * commands (`driven.add`, `driven.key`, `driven.unkey`, `driven.remove`); these are the plans the Correctives card and the Sculpt tool
 * use, so each click is one undoable batch, plus the lookups the card lists (sets of a bone, keys per angle, what each key holds).
 */
import { trimDeform } from "./deformModel.js";
import { fail, isObj, listOf, objOf, type Command, type JsonObject } from "./setupModel.js";

export const ANGLE_MIN = -180;
export const ANGLE_MAX = 180;

export interface DeformAddress {
  skin: string;
  slot: string;
  attachment: string;
}

export interface CorrectiveKey {
  at: number;
  /** Meshes (`slot/attachment`) that carry a deform in this key. */
  meshes: string[];
  /** Other things the key holds: alpha, draw order, attachment swaps. */
  extras: string[];
}

export interface CorrectiveSet {
  name: string;
  bone: string;
  skin: string | null;
  keys: CorrectiveKey[];
}

/** An angle as stored: two decimals, clamped to the engine's -360..360 and never -0. */
export const roundAngle = (deg: number): number => {
  const clamped = Math.max(-360, Math.min(360, Number.isFinite(deg) ? deg : 0));
  return Math.round(clamped * 100) / 100 + 0;
};

function keyInfo(key: JsonObject): CorrectiveKey {
  const meshes: string[] = [];
  for (const slots of Object.values(objOf(key["deform"]))) for (const [slot, atts] of Object.entries(objOf(slots))) for (const att of Object.keys(objOf(atts))) meshes.push(`${slot}/${att}`);
  const extras: string[] = [];
  if (Object.keys(objOf(key["alpha"])).length) extras.push("alpha");
  if (Array.isArray(key["drawOrder"]) && key["drawOrder"].length) extras.push("draw order");
  if (Object.keys(objOf(key["attachments"])).length) extras.push("swaps");
  return { at: Number(key["at"] ?? 0), meshes, extras };
}

/** The driven sets whose driver is `bone`, with their keys by angle. */
export function correctiveSets(raw: JsonObject, bone: string): CorrectiveSet[] {
  return listOf(raw["driven"])
    .filter((d) => d["bone"] === bone)
    .map((d) => ({ name: String(d["name"]), bone, skin: typeof d["skin"] === "string" ? d["skin"] : null, keys: listOf(d["keys"]).map(keyInfo) }));
}

/** A set name not used yet: `<bone>_fix`, `<bone>_fix2`, ... */
export function newSetName(raw: JsonObject, bone: string): string {
  const taken = new Set(listOf(raw["driven"]).map((d) => String(d["name"])));
  let name = `${bone}_fix`;
  for (let n = 2; taken.has(name); n++) name = `${bone}_fix${n}`;
  return name;
}

const findSet = (raw: JsonObject, name: string): JsonObject | undefined => listOf(raw["driven"]).find((d) => d["name"] === name);

/**
 * Stores the sculpted deform of one mesh as the key at `at` of a set (created when `set` does not exist yet). Other meshes, alpha, draw
 * order and swaps already in the key at that angle are kept. A deform that is all zero removes the mesh from the key.
 */
export function planCorrectiveKey(raw: JsonObject, o: { set: string; bone: string; at: number; address: DeformAddress; full: ArrayLike<number> }): Command[] {
  const at = roundAngle(o.at);
  const set = findSet(raw, o.set);
  if (set && set["bone"] !== o.bone) fail(`The set '${o.set}' is driven by ${String(set["bone"])}, not ${o.bone}`);
  const existing = set ? listOf(set["keys"]).find((k) => Number(k["at"]) === at) : undefined;
  const key: JsonObject = {};
  for (const field of ["deform", "drawOrder", "attachments", "alpha"] as const) if (existing && existing[field] !== undefined) key[field] = structuredClone(existing[field]!);
  const deform = isObj(key["deform"]) ? (key["deform"] as JsonObject) : {};
  const trimmed = trimDeform(o.full);
  const { skin, slot, attachment } = o.address;
  const slots = objOf(deform[skin]);
  const atts = objOf(slots[slot]);
  if (trimmed.vertices.length) atts[attachment] = trimmed;
  else delete atts[attachment];
  if (Object.keys(atts).length) slots[slot] = atts;
  else delete slots[slot];
  if (Object.keys(slots).length) deform[skin] = slots;
  else delete deform[skin];
  key["deform"] = deform;
  const commands: Command[] = [];
  if (!set) commands.push({ op: "driven.add", name: o.set, bone: o.bone, keys: [{ at }] } as Command);
  commands.push({ op: "driven.key", name: o.set, at, ...key } as Command);
  return commands;
}

/** Deletes the key at `at`; the last key of a set removes the set (a set keeps at least one key). */
export function planDeleteCorrectiveKey(raw: JsonObject, setName: string, at: number): Command[] {
  const set = findSet(raw, setName);
  if (!set) fail(`There is no corrective set '${setName}'`);
  const keys = listOf(set!["keys"]);
  if (!keys.some((k) => Number(k["at"]) === at)) fail(`The set '${setName}' has no key at ${at} degrees`);
  return keys.length <= 1 ? [{ op: "driven.remove", name: setName } as Command] : [{ op: "driven.unkey", name: setName, at } as Command];
}

export function planRemoveCorrectiveSet(raw: JsonObject, setName: string): Command[] {
  if (!findSet(raw, setName)) fail(`There is no corrective set '${setName}'`);
  return [{ op: "driven.remove", name: setName } as Command];
}

/** The deform a key stores for one mesh as a full array (zeros where it stores nothing), or null when the key has none. */
export function keyDeformOf(raw: JsonObject, setName: string, at: number, a: DeformAddress, length: number): Float64Array | null {
  const set = findSet(raw, setName);
  const key = set ? listOf(set["keys"]).find((k) => Number(k["at"]) === roundAngle(at)) : undefined;
  const values = objOf(objOf(objOf(objOf(key?.["deform"])[a.skin])[a.slot])[a.attachment]);
  if (!Array.isArray(values["vertices"])) return null;
  const offset = Number(values["offset"] ?? 0);
  const out = new Float64Array(length);
  (values["vertices"] as number[]).forEach((v, i) => {
    if (offset + i < length) out[offset + i] = Number(v);
  });
  return out;
}

/** What the Corrective sculpt tool is sculpting: the set, its driver bone and the angle (editor-only). */
export interface SculptTarget {
  set: string;
  bone: string;
  at: number;
}
export const sculptSession: { target: SculptTarget | null } = { target: null };
export function beginSculpt(target: SculptTarget): void {
  sculptSession.target = { ...target, at: roundAngle(target.at) };
}

/** The mutable corrective-authoring state the card and the Sculpt tool share (editor-only, never saved in the rig). */
export const correctiveState: { forBone: string | null; driver: string | null; set: string | "new"; angle: number; pending: string | null } = { forBone: null, driver: null, set: "new", angle: 0, pending: null };

/** Keeps the card's choices while the same bone stays selected; another bone starts fresh with itself as the driver and its first set. */
export function syncCorrectiveState(raw: JsonObject, selected: string): void {
  const s = correctiveState;
  if (s.forBone !== selected || !s.driver) {
    s.forBone = selected;
    s.driver = selected;
    s.set = correctiveSets(raw, selected)[0]?.name ?? "new";
    s.angle = 0;
    s.pending = null;
    return;
  }
  const sets = correctiveSets(raw, s.driver);
  // A set the sculpt is about to create: the card switches to it as soon as the first key exists.
  if (s.pending && sets.some((x) => x.name === s.pending)) {
    s.set = s.pending;
    s.pending = null;
  }
  if (s.set !== "new" && !sets.some((x) => x.name === s.set)) s.set = sets[0]?.name ?? "new";
}
