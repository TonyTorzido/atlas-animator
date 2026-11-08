/*
 * Atlas Animator editor: rig-level event definitions.
 *
 * A rig declares its events (name + default int / float / string / audio); a clip's event keys reference them and may override the
 * payload. These plans are Setup commit-path batches (validated, undoable, saved with the rig): add, change the defaults, rename
 * (keys in every clip follow), remove (keys using the event go with it). Pure; no DOM.
 */
import type { ClipData } from "@atlas-animator/core/core";
import type { PatchOperation } from "@atlas-animator/core/patch";
import { EVENT_NAMES, emptyEventDef, type EventDef } from "./eventModel.js";
import { fail, objOf, type Command, type JsonObject } from "./setupModel.js";
import type { RigPlan } from "./setupRigPlans.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const esc = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");

/** The events a rig file declares, with defaults filled. */
export function declaredEvents(raw: JsonObject): Record<string, EventDef> {
  const out: Record<string, EventDef> = {};
  for (const [name, d] of Object.entries(objOf(raw["events"]))) {
    const o = objOf(d as never);
    out[name] = { ...emptyEventDef(), ...(typeof o["int"] === "number" ? { int: o["int"] } : {}), ...(typeof o["float"] === "number" ? { float: o["float"] } : {}), ...(typeof o["string"] === "string" ? { string: o["string"] } : {}), ...(typeof o["audio"] === "string" ? { audio: o["audio"] } : {}) };
  }
  return out;
}

function checkName(raw: JsonObject, name: string): void {
  if (!NAME.test(name)) fail(`'${name}' is not a valid event name (letters, digits, _ . -; it starts with a letter or _)`);
  if (name in declaredEvents(raw)) fail(`An event called "${name}" already exists`);
}

function payload(p: Partial<EventDef>): Partial<EventDef> {
  const out: Partial<EventDef> = {};
  if (p.int !== undefined) {
    if (!Number.isFinite(p.int)) fail("Int must be a number");
    out.int = Math.round(p.int);
  }
  if (p.float !== undefined) {
    if (!Number.isFinite(p.float)) fail("Float must be a number");
    out.float = p.float;
  }
  if (p.string !== undefined) out.string = p.string;
  if (p.audio !== undefined) out.audio = p.audio.trim();
  return out;
}

/** Declares a new event with default payload values. */
export function planAddEvent(raw: JsonObject, name: string, p: Partial<EventDef> = {}): RigPlan {
  checkName(raw, name);
  return { commands: [{ op: "event.add", name, ...payload(p) }] };
}

/** Declares the project's six events that the rig lacks. */
export function planAddGameEvents(raw: JsonObject): RigPlan {
  const have = declaredEvents(raw);
  const commands: Command[] = EVENT_NAMES.filter((n) => !(n in have)).map((name) => ({ op: "event.add", name }));
  return { commands };
}

/** Changes an event's default payload. An implicit game event (not in the file yet) is declared first. */
export function planSetEvent(raw: JsonObject, name: string, p: Partial<EventDef>): RigPlan {
  const have = declaredEvents(raw);
  const fields = payload(p);
  if (!(name in have)) {
    if (!(EVENT_NAMES as readonly string[]).includes(name)) fail(`no event '${name}'`);
    return { commands: [{ op: "event.add", name, ...fields }] };
  }
  return { commands: [{ op: "event.set", name, ...fields }] };
}

function mapKeys(clip: ClipData, from: string, to: string | null): ClipData | null {
  if (!clip.events.some((e) => e.name === from)) return null;
  const next = structuredClone(clip);
  next.events = to === null ? next.events.filter((e) => e.name !== from) : next.events.map((e) => (e.name === from ? { ...e, name: to } : e));
  return next;
}

function clipPatch(raw: JsonObject, from: string, to: string | null): PatchOperation[] {
  const out: PatchOperation[] = [];
  for (const [name, clip] of Object.entries(objOf(raw["animations"]))) {
    const next = mapKeys(clip as unknown as ClipData, from, to);
    if (next) out.push({ op: "replace", path: `/animations/${esc(name)}`, value: next as never });
  }
  return out;
}

/** Renames an event: the definition and every key in the rig's clips (and the library copies) follow. */
export function planRenameEvent(raw: JsonObject, name: string, to: string): RigPlan {
  const have = declaredEvents(raw);
  if (to === name) return { commands: [] };
  checkName(raw, to);
  const def = have[name] ?? (EVENT_NAMES.includes(name as never) ? emptyEventDef() : fail(`no event '${name}'`));
  const commands: Command[] = [{ op: "event.add", name: to, ...def }];
  const patch = clipPatch(raw, name, to);
  if (patch.length) commands.push({ op: "patch", patch } as never);
  if (name in have) commands.push({ op: "event.remove", name });
  return { commands, clip: (c) => mapKeys(c, name, to) };
}

/** Removes an event and every key that fires it. */
export function planRemoveEvent(raw: JsonObject, name: string): RigPlan {
  const have = declaredEvents(raw);
  if (!(name in have)) fail((EVENT_NAMES as readonly string[]).includes(name) ? `'${name}' is a built-in game event: it is always listed` : `no event '${name}'`);
  const commands: Command[] = [];
  const patch = clipPatch(raw, name, null);
  if (patch.length) commands.push({ op: "patch", patch } as never);
  commands.push({ op: "event.remove", name });
  return { commands, clip: (c) => mapKeys(c, name, null) };
}

/** How many keys across the rig's clips fire an event (for the remove confirm). */
export function eventUses(raw: JsonObject, library: Iterable<ClipData>, name: string): number {
  let n = 0;
  for (const clip of library) n += clip.events.filter((e) => e.name === name).length;
  for (const clip of Object.values(objOf(raw["animations"]))) n += (Array.isArray((clip as JsonObject)["events"]) ? ((clip as JsonObject)["events"] as JsonObject[]) : []).filter((e) => e["name"] === name).length;
  return n;
}
