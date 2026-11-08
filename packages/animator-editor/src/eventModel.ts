/*
 * Atlas Animator editor: original implementation.
 *
 * Event markers on a clip (pure). Six named markers say where a swing's phases are: `windup` (start), `hit` (the
 * contact frame), `trailOn` / `trailOff` (the slash trail window), `follow` (follow-through) and `ready` (back to
 * idle). They are ordinary clip `events` keys, so they travel with the clip file; the rig document must declare the
 * names (`withEventDefs`). A `hit` key can carry a link to an attack profile step in its string payload
 * ("axe:generic#0"): the contact frame is then `windupMs * fps / 1000` of that step
 * (src/preview/attackProfiles.ts), and a hit off that frame is reported as a warning.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { ATTACK_PROFILES, attackProfileForStyle, COMBAT_STYLE_IDS } from "./preview/attackProfiles.js";
import { clipFps, frameTime, KEY_EPSILON, snapTime, timeToFrame } from "./clipModel.js";

/** The six game events every rig starts with (the defaults of the event list; a rig can add its own, Batch 8b-2). */
export const EVENT_NAMES = ["windup", "hit", "trailOn", "trailOff", "follow", "ready"] as const;
/** An event name: one of the project's six or a rig-defined one. */
export type EventName = string;

/** The game events' colours; a rig-defined event gets a stable colour from its name (`eventColor`). */
export const EVENT_COLORS: Record<string, string> = {
  windup: "#8c96a8",
  hit: "#ff6b6b",
  trailOn: "#5fb3ff",
  trailOff: "#9fd0ff",
  follow: "#6bd68f",
  ready: "#f0b84a"
};

/** The colour of an event name: the project's palette, else a stable hue from the name. */
export function eventColor(name: string): string {
  const known = EVENT_COLORS[name];
  if (known) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 68%)`;
}

export interface EventPayload {
  int?: number;
  float?: number;
  string?: string;
  audio?: string;
}

/** A rig's event definition (its default payload). */
export interface EventDef {
  int: number;
  float: number;
  string: string;
  audio: string;
}

export const emptyEventDef = (): EventDef => ({ int: 0, float: 0, string: "", audio: "" });

/** Declares the six event names on a rig document (a clip's events must be declared there). */
export function withEventDefs<T extends { events: Record<string, { int: number; float: number; string: string; audio?: string }> }>(doc: T): T {
  for (const name of EVENT_NAMES) doc.events[name] ??= { int: 0, float: 0, string: "", audio: "" };
  return doc;
}

export const PROFILE_STYLES: readonly string[] = COMBAT_STYLE_IDS.filter((id) => id !== "default");

type Ev = ClipData["events"][number];

const same = (a: number, b: number) => Math.abs(a - b) < KEY_EPSILON;

/** Frame of blade contact for a profile step: windupMs * fps / 1000, rounded. */
export function contactFrame(windupMs: number, fps = 30): number {
  return Math.round((windupMs * fps) / 1000);
}

export function profileStepCount(style: string): number {
  return attackProfileForStyle(style).combo.length;
}

/** The contact frame of a profile's combo step at `fps`, or null for an unknown style / step. */
export function stepContactFrame(style: string, step: number, fps = 30): number | null {
  const profile = ATTACK_PROFILES[style as keyof typeof ATTACK_PROFILES];
  const s = profile?.combo[step];
  return s ? contactFrame(s.windupMs, fps) : null;
}

export const linkString = (style: string, step: number) => `${style}#${step}`;

/** The profile step a hit event is linked to (its string payload), if any. */
export function hitLink(ev: Pick<Ev, "string">): { style: string; step: number } | null {
  const m = /^(.+)#(\d+)$/.exec(ev.string ?? "");
  return m ? { style: m[1]!, step: Number(m[2]) } : null;
}

/** Adds an event (an existing event of the same name at the same frame is replaced); times snap to frames. */
export function setEvent(clip: ClipData, time: number, name: EventName, link?: { style: string; step: number }, payload?: EventPayload): ClipData {
  const next = structuredClone(clip);
  const t = snapTime(next, time);
  next.events = next.events.filter((e) => !(e.name === name && same(e.time, t)));
  const ev: Ev = { time: t, name };
  if (payload?.int !== undefined) ev.int = Math.round(payload.int);
  if (payload?.float !== undefined) ev.float = payload.float;
  if (payload?.string !== undefined) ev.string = payload.string;
  if (payload?.audio !== undefined && payload.audio !== "") ev.audio = payload.audio;
  if (name === "hit" && link) ev.string = linkString(link.style, link.step);
  next.events.push(ev);
  next.events.sort((a, b) => a.time - b.time);
  return next;
}

/** Removes events at `time` (one name, or all of them). */
export function deleteEvent(clip: ClipData, time: number, name?: EventName): ClipData {
  const next = structuredClone(clip);
  next.events = next.events.filter((e) => !(same(e.time, time) && (!name || e.name === name)));
  return next;
}

export function eventsAt(clip: ClipData, time: number): Ev[] {
  return clip.events.filter((e) => same(e.time, time));
}

/** Puts the hit marker on a profile step's contact frame (moving the clip's hit event, or adding one) and links it. */
export function lockHit(clip: ClipData, style: string, step: number): ClipData {
  const frame = stepContactFrame(style, step, clipFps(clip));
  if (frame === null) return clip;
  const t = frameTime(clip, frame);
  const without: ClipData = { ...structuredClone(clip), events: clip.events.filter((e) => e.name !== "hit") };
  return setEvent(without, t, "hit", { style, step });
}

export interface EventIssue {
  message: string;
  time: number;
}

/** Linked hit markers that are not on their profile step's contact frame. */
export function eventIssues(clip: ClipData): EventIssue[] {
  const out: EventIssue[] = [];
  const fps = clipFps(clip);
  for (const e of clip.events) {
    if (e.name !== "hit") continue;
    const link = hitLink(e);
    if (!link) continue;
    const want = stepContactFrame(link.style, link.step, fps);
    if (want === null) {
      out.push({ time: e.time, message: `hit is linked to an unknown profile step '${e.string}'` });
      continue;
    }
    const have = timeToFrame(clip, e.time);
    if (have !== want) {
      const ms = attackProfileForStyle(link.style).combo[link.step]!.windupMs;
      out.push({ time: e.time, message: `hit marker on frame ${have}, but ${link.style} step ${link.step + 1} makes contact on frame ${want} (windup ${ms} ms)` });
    }
  }
  return out;
}

/** Renames the markers at `time` (all of them, or just the one called `from`) to `to`; a marker already called `to` there is not doubled. */
export function renameEvent(clip: ClipData, time: number, to: EventName, from?: EventName): ClipData {
  const next = structuredClone(clip);
  for (const e of next.events) {
    if (!same(e.time, time) || (from && e.name !== from)) continue;
    if (e.name === "hit" && to !== "hit") delete e.string;
    e.name = to;
  }
  const seen = new Set<string>();
  next.events = next.events.filter((e) => {
    const key = `${e.name}@${Math.round(e.time * 1e5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return next;
}

export interface EventLabel {
  /** The text to draw (shortened with an ellipsis when it had to be). */
  text: string;
  /** The side of the text that touches the diamond. */
  x: number;
  align: "left" | "right";
}

/**
 * Where an event's name goes on the dopesheet. `xs` are the diamond x positions of all events, sorted; `i` is this one. The name sits
 * to the right of its diamond; at the right edge it flips to the left; if neither side has room it is cut with an ellipsis (the full
 * name stays in the hover tip) and never runs over the next diamond. `measure` gives a string's pixel width.
 */
export function placeEventLabel(xs: readonly number[], i: number, text: string, measure: (s: string) => number, r: number, minX: number, maxX: number): EventLabel | null {
  const x = xs[i]!;
  const next = i + 1 < xs.length ? xs[i + 1]! : null;
  const prev = i > 0 ? xs[i - 1]! : null;
  const rightRoom = (next === null ? maxX : next - r - 3) - (x + r + 3);
  const leftRoom = x - r - 3 - (prev === null ? minX : prev + r + 3);
  const full = measure(text);
  if (full <= rightRoom) return { text, x: x + r + 3, align: "left" };
  if (full <= leftRoom) return { text, x: x - r - 3, align: "right" };
  const cut = (room: number): string | null => {
    if (room < 12) return null;
    let t = text;
    while (t.length > 1 && measure(`${t}…`) > room) t = t.slice(0, -1);
    return measure(`${t}…`) <= room ? `${t}…` : null;
  };
  if (rightRoom >= leftRoom) {
    const t = cut(rightRoom);
    return t ? { text: t, x: x + r + 3, align: "left" } : null;
  }
  const t = cut(leftRoom);
  return t ? { text: t, x: x - r - 3, align: "right" } : null;
}
