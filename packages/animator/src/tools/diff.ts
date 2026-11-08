/*
 * Atlas Animator: original implementation.
 *
 * Semantic diff of two `atlas-anim@1` documents: what changed in rig terms (bones, slots, skins,
 * attachments, constraints, driven sets, events, clips and their keys), not raw JSON lines.
 * Keys are matched by time; a key removed at one time and added at another with the same values
 * is reported as moved. Pure module.
 */
import { getAt, jsonEqual, type JsonObject, type JsonValue } from "./jsonPatch.js";

export interface DiffChange {
  /** "meta", "bone", "slot", "drawOrder", "skin", "attachment", "constraint", "driven", "event", "clip", "key". */
  area: string;
  /** Who changed: "bone chest", "clip idle: bone chest rotate", ... */
  subject: string;
  /** "added", "removed", "changed", "moved", "reordered". */
  kind: string;
  /** Human-readable detail: "rotation -90 -> -85", "1.2s -> 1.3s". */
  detail: string;
}

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: JsonValue | undefined): JsonObject => (isObject(value) ? value : {});
const list = (value: JsonValue | undefined): JsonObject[] => (Array.isArray(value) ? (value as JsonObject[]) : []);

function show(value: JsonValue | undefined): string {
  if (value === undefined) return "(none)";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** "x 0 -> 2, rotation (none) -> 5" for the top-level fields that differ. */
function fieldChanges(a: JsonObject, b: JsonObject, skip: readonly string[] = []): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !skip.includes(key));
  return keys.filter((key) => !jsonEqual(a[key], b[key])).map((key) => `${key} ${show(a[key])} -> ${show(b[key])}`);
}

function byName(entries: readonly JsonObject[]): Map<string, JsonObject> {
  return new Map(entries.map((entry) => [String(entry["name"]), entry]));
}

function compareNamed(changes: DiffChange[], area: string, a: Map<string, JsonObject>, b: Map<string, JsonObject>, label: (name: string) => string, skip: readonly string[] = ["name"]): void {
  for (const [name, entry] of a) {
    const other = b.get(name);
    if (!other) changes.push({ area, subject: label(name), kind: "removed", detail: "" });
    else {
      const fields = fieldChanges(entry, other, skip);
      if (fields.length) changes.push({ area, subject: label(name), kind: "changed", detail: fields.join(", ") });
    }
  }
  for (const name of b.keys()) if (!a.has(name)) changes.push({ area, subject: label(name), kind: "added", detail: "" });
}

function describeAttachment(a: JsonObject, b: JsonObject): string {
  if (a["type"] !== b["type"]) return `type ${show(a["type"])} -> ${show(b["type"])}`;
  if (a["type"] !== "mesh") return fieldChanges(a, b).join(", ");
  const parts: string[] = [];
  const count = (mesh: JsonObject) => list(mesh["uvs"]).length / 2;
  if (count(a) !== count(b)) parts.push(`vertices ${count(a)} -> ${count(b)}`);
  if (!jsonEqual(a["triangles"], b["triangles"])) parts.push(`triangles ${list(a["triangles"]).length / 3} -> ${list(b["triangles"]).length / 3}`);
  if (!jsonEqual(a["uvs"], b["uvs"])) parts.push("uvs changed");
  if (!jsonEqual(a["bones"], b["bones"])) parts.push(`weight bones ${show(a["bones"])} -> ${show(b["bones"])}`);
  if (!jsonEqual(a["vertices"], b["vertices"])) parts.push(a["bones"] || b["bones"] ? "positions/weights changed" : "positions changed");
  parts.push(...fieldChanges(a, b, ["uvs", "triangles", "vertices", "bones"]));
  return parts.join(", ");
}

/** Every key array of a clip with a readable label. */
function timelines(clip: JsonObject): Map<string, JsonObject[]> {
  const out = new Map<string, JsonObject[]>();
  for (const [bone, kinds] of Object.entries(record(clip["bones"]))) for (const [kind, keys] of Object.entries(record(kinds))) out.set(`bone ${bone} ${kind}`, list(keys));
  for (const [slot, kinds] of Object.entries(record(clip["slots"]))) for (const [kind, keys] of Object.entries(record(kinds))) out.set(`slot ${slot} ${kind}`, list(keys));
  for (const [name, keys] of Object.entries(record(clip["ik"]))) out.set(`ik ${name}`, list(keys));
  for (const [name, keys] of Object.entries(record(clip["transform"]))) out.set(`transform ${name}`, list(keys));
  for (const [name, kinds] of Object.entries(record(clip["physics"]))) for (const [kind, keys] of Object.entries(record(kinds))) out.set(`physics ${name} ${kind}`, list(keys));
  for (const [skin, slots] of Object.entries(record(clip["deform"])))
    for (const [slot, attachments] of Object.entries(record(slots))) for (const [name, keys] of Object.entries(record(attachments))) out.set(`deform ${skin}/${slot}/${name}`, list(keys));
  if (list(clip["drawOrder"]).length) out.set("drawOrder", list(clip["drawOrder"]));
  return out;
}

const seconds = (time: JsonValue | undefined) => `${Number(time)}s`;
const withoutTime = (key: JsonObject): JsonObject => Object.fromEntries(Object.entries(key).filter(([k]) => k !== "time"));

function compareKeys(changes: DiffChange[], subject: string, a: readonly JsonObject[], b: readonly JsonObject[], identity: (key: JsonObject) => string): void {
  const index = (keys: readonly JsonObject[]) => new Map(keys.map((key) => [identity(key), key]));
  const left = index(a);
  const right = index(b);
  const removed = [...left].filter(([id]) => !right.has(id)).map(([, key]) => key);
  const added = [...right].filter(([id]) => !left.has(id)).map(([, key]) => key);
  for (const [id, key] of left) {
    const other = right.get(id);
    if (!other || jsonEqual(key, other)) continue;
    changes.push({ area: "key", subject, kind: "changed", detail: `key at ${seconds(key["time"])}: ${fieldChanges(key, other, ["time"]).join(", ")}` });
  }
  // Moved: a removed and an added key with equal content (apart from time), paired in time order.
  for (const key of removed) {
    const match = added.findIndex((other) => jsonEqual(withoutTime(key), withoutTime(other)));
    if (match >= 0) {
      const [other] = added.splice(match, 1) as [JsonObject];
      changes.push({ area: "key", subject, kind: "moved", detail: `key ${seconds(key["time"])} -> ${seconds(other["time"])}` });
    } else changes.push({ area: "key", subject, kind: "removed", detail: `key at ${seconds(key["time"])} ${show(withoutTime(key))}` });
  }
  for (const key of added) changes.push({ area: "key", subject, kind: "added", detail: `key at ${seconds(key["time"])} ${show(withoutTime(key))}` });
}

function compareClips(changes: DiffChange[], a: JsonObject, b: JsonObject): void {
  for (const name of Object.keys(a)) if (!(name in b)) changes.push({ area: "clip", subject: `clip ${name}`, kind: "removed", detail: "" });
  for (const [name, clipValue] of Object.entries(b)) {
    const after = record(clipValue);
    if (!(name in a)) {
      changes.push({ area: "clip", subject: `clip ${name}`, kind: "added", detail: `duration ${show(after["duration"])}s` });
      continue;
    }
    const before = record(a[name]);
    const meta = ["duration", "loop"].filter((key) => !jsonEqual(before[key], after[key])).map((key) => `${key} ${show(before[key])} -> ${show(after[key])}`);
    if (meta.length) changes.push({ area: "clip", subject: `clip ${name}`, kind: "changed", detail: meta.join(", ") });
    const left = timelines(before);
    const right = timelines(after);
    for (const label of new Set([...left.keys(), ...right.keys()])) {
      const subject = `clip ${name}: ${label}`;
      const keysA = left.get(label) ?? [];
      const keysB = right.get(label) ?? [];
      if (keysA.length === 0) changes.push({ area: "key", subject, kind: "added", detail: `timeline with ${keysB.length} key(s) at ${keysB.map((key) => seconds(key["time"])).join(", ")}` });
      else if (keysB.length === 0) changes.push({ area: "key", subject, kind: "removed", detail: `timeline with ${keysA.length} key(s)` });
      else compareKeys(changes, subject, keysA, keysB, (key) => String(key["time"]));
    }
    compareKeys(changes, `clip ${name}: events`, list(before["events"]), list(after["events"]), (key) => `${String(key["time"])} ${String(key["name"])}`);
  }
}

export function diffDocuments(aValue: JsonValue, bValue: JsonValue): DiffChange[] {
  const a = record(aValue);
  const b = record(bValue);
  const changes: DiffChange[] = [];

  for (const key of ["format", "name", "revision", "canvas", "atlas"]) {
    if (!jsonEqual(a[key], b[key])) changes.push({ area: "meta", subject: key, kind: "changed", detail: `${show(a[key])} -> ${show(b[key])}` });
  }

  const bonesA = list(a["bones"]);
  const bonesB = list(b["bones"]);
  compareNamed(changes, "bone", byName(bonesA), byName(bonesB), (name) => `bone ${name}`);
  const order = (bones: JsonObject[], other: Map<string, JsonObject>) => bones.map((bone) => String(bone["name"])).filter((name) => other.has(name));
  if (!jsonEqual(order(bonesA, byName(bonesB)), order(bonesB, byName(bonesA)))) changes.push({ area: "bone", subject: "bones", kind: "reordered", detail: "" });

  const slotsA = list(a["slots"]);
  const slotsB = list(b["slots"]);
  compareNamed(changes, "slot", byName(slotsA), byName(slotsB), (name) => `slot ${name}`);
  const drawOrder = (doc: JsonObject) => (Array.isArray(doc["drawOrder"]) ? (doc["drawOrder"] as string[]) : list(doc["slots"]).map((slot) => String(slot["name"])));
  const shared = (names: string[], other: string[]) => names.filter((name) => other.includes(name));
  if (!jsonEqual(shared(drawOrder(a), drawOrder(b)), shared(drawOrder(b), drawOrder(a)))) {
    changes.push({ area: "drawOrder", subject: "draw order", kind: "reordered", detail: `${drawOrder(a).join(" ")} -> ${drawOrder(b).join(" ")}` });
  }

  const skinsA = record(a["skins"]);
  const skinsB = record(b["skins"]);
  for (const name of new Set([...Object.keys(skinsA), ...Object.keys(skinsB)])) {
    const sa = skinsA[name];
    const sb = skinsB[name];
    if (sa === undefined || sb === undefined) {
      changes.push({ area: "skin", subject: `skin ${name}`, kind: sa === undefined ? "added" : "removed", detail: "" });
      continue;
    }
    const fields = fieldChanges(record(sa), record(sb), ["attachments"]);
    if (fields.length) changes.push({ area: "skin", subject: `skin ${name}`, kind: "changed", detail: fields.join(", ") });
    const attA = record(record(sa)["attachments"]);
    const attB = record(record(sb)["attachments"]);
    for (const slot of new Set([...Object.keys(attA), ...Object.keys(attB)])) {
      const ra = record(attA[slot]);
      const rb = record(attB[slot]);
      for (const attachment of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        const subject = `attachment ${name}/${slot}/${attachment}`;
        const x = ra[attachment];
        const y = rb[attachment];
        if (x === undefined) changes.push({ area: "attachment", subject, kind: "added", detail: show(getAt(record(y), "/type")) });
        else if (y === undefined) changes.push({ area: "attachment", subject, kind: "removed", detail: "" });
        else if (!jsonEqual(x, y)) changes.push({ area: "attachment", subject, kind: "changed", detail: describeAttachment(record(x), record(y)) });
      }
    }
  }

  for (const kind of ["ik", "transform", "physics"]) compareNamed(changes, "constraint", byName(list(a[kind])), byName(list(b[kind])), (name) => `${kind} ${name}`);
  const drivenA = byName(list(a["driven"]));
  const drivenB = byName(list(b["driven"]));
  compareNamed(changes, "driven", drivenA, drivenB, (name) => `driven ${name}`, ["name", "keys"]);
  for (const [name, set] of drivenA) {
    const other = drivenB.get(name);
    if (other) compareKeys(changes, `driven ${name}`, list(set["keys"]).map((key) => ({ ...key, time: key["at"] as JsonValue })), list(other["keys"]).map((key) => ({ ...key, time: key["at"] as JsonValue })), (key) => String(key["at"]));
  }

  const eventsA = record(a["events"]);
  const eventsB = record(b["events"]);
  compareNamed(
    changes,
    "event",
    new Map(Object.entries(eventsA).map(([name, value]) => [name, record(value)])),
    new Map(Object.entries(eventsB).map(([name, value]) => [name, record(value)])),
    (name) => `event ${name}`,
    []
  );

  compareClips(changes, record(a["animations"]), record(b["animations"]));
  return changes;
}

export function formatDiff(changes: readonly DiffChange[]): string {
  if (changes.length === 0) return "no changes";
  return changes.map((change) => `${change.subject}: ${change.kind}${change.detail ? ` ${change.detail}` : ""}`).join("\n");
}
