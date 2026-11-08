/*
 * Atlas Animator editor: original implementation.
 *
 * The editor's clip model: pure functions over the `atlas-anim@1` clip format (format.ts
 * `clipSchema`, one entry of a document's `animations`). Every edit returns a new clip; nothing
 * here touches the DOM, Pixi or the skeleton, so it is unit tested under Node. Times snap to the
 * clip's frame grid (fps, default 30) and are written with 5 decimals like the generated rigs.
 */
import { clipSchema, DEFAULT_CLIP_FPS, type ClipData } from "@atlas-animator/core/core";
import { MAX_CLIP_FPS, MULTI_AT_TIME, timedArrays } from "./clipChannels.js";

export type BoneChannel = "rotate" | "translate" | "scale" | "shear";

/** Local offsets of one bone relative to its setup pose (the meaning of a bone key's values). */
export interface BoneOffsets {
  rotate: number;
  translate: { x: number; y: number };
  scale: { x: number; y: number };
  /** Shear offset from setup in degrees; absent = none captured (a pose made before shear was captured). */
  shear?: { x: number; y: number };
}

/** A copied pose: offsets per bone name. */
export type PoseCopy = Record<string, BoneOffsets>;

/** Two keys closer than this (seconds) are the same key; also how far from a frame time a loaded key may be and still snap onto it. */
export const KEY_EPSILON = 1e-4;

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Snaps every key, event and duration time within KEY_EPSILON of a frame time onto that exact frame time (frame / fps as a double).
 * Older rig files hold 5-decimal times (0.13333 for frame 4), which sit a few microseconds off their frame; snapped, an event on
 * frame 6 fires when the clock steps 5/30 -> 6/30. Mutates and returns its argument.
 */
export function snapClipTimes<T>(clip: T): T {
  const fps = clipFps(clip as unknown as Pick<ClipData, "fps">);
  const snap = (t: number) => {
    const f = Math.round(t * fps);
    const exact = f / fps;
    return Math.abs(t - exact) < KEY_EPSILON ? exact : t;
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const [k, val] of Object.entries(o)) {
        if (k === "time" && typeof val === "number") o[k] = snap(val);
        else walk(val);
      }
    }
  };
  const c = clip as unknown as Record<string, unknown>;
  walk(c);
  if (typeof c.duration === "number") c.duration = snap(c.duration);
  return clip;
}

/** Version of the `.clip.json` file wrapper. Files written before versioning have no `clipVersion` and are v1. */
export const CLIP_FILE_VERSION = 2;

/**
 * Clip file migrations: CLIP_MIGRATIONS[n] upgrades a version-n clip to n + 1 (add an entry plus a fixture of the old shape with
 * every future change). Receives a private copy.
 */
const CLIP_MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 -> v2 (Batch 8b-2): event keys may carry an `audio` sound name next to int / float / string. v1 events have none, so nothing
  // is rewritten; the bump makes older builds (strict schema) refuse a file that uses it instead of silently dropping the field.
  1: (raw) => raw
};

/**
 * Brings a raw clip file up to the current version and strips the `clipVersion` field (the clip schema is strict).
 * Unversioned files are v1. Throws on a non-integer version or one newer than this build. Non-objects pass through
 * (parseClip then rejects them with the schema message).
 */
export function migrateClipFile(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { clipVersion, ...rest } = raw as Record<string, unknown>;
  let version = 1;
  if (clipVersion !== undefined) {
    if (typeof clipVersion !== "number" || !Number.isSafeInteger(clipVersion) || clipVersion < 1) throw new Error(`not an atlas-anim@1 clip: clipVersion must be a positive integer, got ${JSON.stringify(clipVersion)}`);
    version = clipVersion;
  }
  if (version > CLIP_FILE_VERSION) throw new Error(`clip file is version ${version}, newer than this build understands (version ${CLIP_FILE_VERSION}); update Atlas Animator`);
  let out: Record<string, unknown> = rest;
  for (let from = version; from < CLIP_FILE_VERSION; from++) {
    const step = CLIP_MIGRATIONS[from];
    if (!step) throw new Error(`no clip migration from version ${from}`);
    out = step(structuredClone(out));
  }
  return out;
}

/** Parses a raw clip (JSON) into the defaults-filled form (times snapped onto the frame grid), throwing with the zod message on error. */
export function parseClip(raw: unknown): ClipData {
  const parsed = clipSchema.safeParse(migrateClipFile(raw));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`not an atlas-anim@1 clip: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid"}`);
  }
  return snapClipTimes(parsed.data);
}

export function clipFps(clip: Pick<ClipData, "fps">): number {
  return clip.fps ?? DEFAULT_CLIP_FPS;
}

/** Number of frame steps in the clip (duration * fps, rounded). */
export function frameCount(clip: Pick<ClipData, "fps" | "duration">): number {
  return Math.max(0, Math.round(clip.duration * clipFps(clip)));
}

/** The key time for a frame index: exactly frame / fps as a double, so the clock reaches it on that frame. */
export function frameTime(clip: Pick<ClipData, "fps">, frame: number): number {
  return frame / clipFps(clip);
}

/** Nearest frame index to a time, clamped to the clip. */
export function timeToFrame(clip: Pick<ClipData, "fps" | "duration">, time: number): number {
  return Math.min(frameCount(clip), Math.max(0, Math.round(time * clipFps(clip))));
}

/** Snaps a time to the frame grid (clamped to the clip). */
export function snapTime(clip: Pick<ClipData, "fps" | "duration">, time: number): number {
  return frameTime(clip, timeToFrame(clip, time));
}

/**
 * Held-frame time: the start of the frame that contains `time` (what the project displays). Key and playhead times are
 * written with 5 decimals (0.13333 for frame 4 at 30 fps), which sit up to 1.5e-4 frames below the exact frame, so the
 * floor tolerates 1e-3 of a frame (otherwise such a frame showed the previous pose).
 */
export function heldTime(clip: Pick<ClipData, "fps">, time: number): number {
  const fps = clipFps(clip);
  return Math.floor(time * fps + 1e-3) / fps;
}

function cloneClip(clip: ClipData): ClipData {
  return structuredClone(clip);
}

type AnyKey = { time: number };

function insertKey<K extends AnyKey>(keys: K[], key: K): K[] {
  const at = keys.findIndex((k) => Math.abs(k.time - key.time) < KEY_EPSILON);
  if (at >= 0) {
    keys[at] = key;
    return keys;
  }
  keys.push(key);
  keys.sort((a, b) => a.time - b.time);
  return keys;
}

/** True when the bone has a key of `channel` at `time`. */
export function hasKey(clip: ClipData, bone: string, channel: BoneChannel, time: number): boolean {
  const keys = clip.bones[bone]?.[channel] as AnyKey[] | undefined;
  return !!keys?.some((k) => Math.abs(k.time - time) < KEY_EPSILON);
}

/** True when the bone has any key at `time`. */
export function hasAnyKey(clip: ClipData, bone: string, time: number): boolean {
  return (["rotate", "translate", "scale", "shear"] as const).some((ch) => (clip.bones[bone]?.[ch] as AnyKey[] | undefined)?.some((k) => Math.abs(k.time - time) < KEY_EPSILON));
}

/** Sorted unique key times of one bone (every channel). */
export function boneKeyTimes(clip: ClipData, bone: string): number[] {
  const out: number[] = [];
  const timelines = clip.bones[bone];
  if (!timelines) return out;
  for (const keys of Object.values(timelines) as (AnyKey[] | undefined)[]) {
    for (const k of keys ?? []) if (!out.some((t) => Math.abs(t - k.time) < KEY_EPSILON)) out.push(k.time);
  }
  return out.sort((a, b) => a - b);
}

/** Sets (inserts or replaces) a rotate key; an existing key keeps its curve. */
export function setRotateKey(clip: ClipData, bone: string, time: number, value: number): ClipData {
  const next = cloneClip(clip);
  const t = snapTime(next, time);
  const timelines = (next.bones[bone] ??= {});
  const keys = (timelines.rotate ??= []);
  const old = keys.find((k) => Math.abs(k.time - t) < KEY_EPSILON);
  insertKey(keys, { time: old?.time ?? t, value: round(value, 4), curve: old?.curve ?? "linear" });
  return next;
}

/** Sets a translate, scale (multiplier of setup) or shear (degrees offset) key (x, y); an existing key keeps its curve. */
export function setVectorKey(clip: ClipData, bone: string, channel: "translate" | "scale" | "shear", time: number, x: number, y: number): ClipData {
  const next = cloneClip(clip);
  const t = snapTime(next, time);
  const timelines = (next.bones[bone] ??= {});
  const keys = (timelines[channel] ??= []);
  const old = keys.find((k) => Math.abs(k.time - t) < KEY_EPSILON);
  insertKey(keys, { time: old?.time ?? t, x: round(x, 4), y: round(y, 4), curve: old?.curve ?? "linear" });
  return next;
}

/**
 * Deletes every key of the bone at `time` (all channels, or only `channel`). Empty timelines and
 * bones without timelines are removed (the format rejects an empty continuous timeline).
 */
export function deleteKeys(clip: ClipData, bone: string, time: number, channel?: BoneChannel): ClipData {
  const next = cloneClip(clip);
  const timelines = next.bones[bone];
  if (!timelines) return next;
  for (const ch of ["rotate", "translate", "scale", "shear"] as const) {
    if (channel && ch !== channel) continue;
    const keys = timelines[ch] as AnyKey[] | undefined;
    if (!keys) continue;
    const kept = keys.filter((k) => Math.abs(k.time - time) >= KEY_EPSILON);
    if (kept.length) (timelines as Record<string, AnyKey[]>)[ch] = kept;
    else delete timelines[ch];
  }
  if (!Object.keys(timelines).length) delete next.bones[bone];
  return next;
}

/**
 * Keys a copied pose at `time`. Per bone and channel a key is written when the clip already
 * animates that channel or the copied value differs from setup (so pasting a rest pose into an
 * empty clip writes nothing it does not need).
 */
export function pastePose(clip: ClipData, pose: PoseCopy, time: number): ClipData {
  let next = clip;
  for (const [bone, o] of Object.entries(pose)) {
    const tl = next.bones[bone];
    if (tl?.rotate || Math.abs(o.rotate) > 1e-4) next = setRotateKey(next, bone, time, o.rotate);
    if (tl?.translate || Math.abs(o.translate.x) > 1e-4 || Math.abs(o.translate.y) > 1e-4) next = setVectorKey(next, bone, "translate", time, o.translate.x, o.translate.y);
    if (tl?.scale || Math.abs(o.scale.x - 1) > 1e-4 || Math.abs(o.scale.y - 1) > 1e-4) next = setVectorKey(next, bone, "scale", time, o.scale.x, o.scale.y);
    if (o.shear && (tl?.shear || Math.abs(o.shear.x) > 1e-4 || Math.abs(o.shear.y) > 1e-4)) next = setVectorKey(next, bone, "shear", time, o.shear.x, o.shear.y);
  }
  return next;
}

/** A retime that put two keys of one channel on one frame; the later key won. */
export interface RetimeCollision {
  channel: string;
  /** Frame on the new grid where the keys met. */
  frame: number;
  /** Frames (on the old grid) of the keys that merged, earliest first. */
  fromFrames: number[];
}

/** What changing the frame rate does, without applying it: the new clip plus every key that moved and every collision (). */
export interface RetimePreview {
  clip: ClipData;
  fps: number;
  /** Times that were not already on a new-grid frame. */
  moved: number;
  /** Keys lost to collisions. */
  merged: number;
  collisions: RetimeCollision[];
  /** Channels that were walked (every supported kind), for the confirm text. */
  channels: number;
}

/**
 * Changes the clip frame rate. The clip keeps its length in seconds (rounded to a whole frame at the new rate) and every key and
 * event time, in EVERY channel (bones, slot attachment and colour, IK, transform and physics mixes, deform, draw order, events), moves
 * onto the nearest frame of the new grid. Where two keys of one channel land on one frame the later one wins and the collision is
 * listed (events may share a time and are never merged). The rate is limited to the engine's 1..MAX_CLIP_FPS.
 */
export function previewClipFps(clip: ClipData, fps: number): RetimePreview {
  const next = cloneClip(clip);
  const rate = Math.max(1, Math.min(MAX_CLIP_FPS, Math.round(fps)));
  const old = clipFps(clip);
  let moved = 0;
  let merged = 0;
  const collisions: RetimeCollision[] = [];
  const arrays = timedArrays(next);
  for (const arr of arrays) {
    const placed: { key: (typeof arr.keys)[number]; from: number }[] = [];
    for (const k of arr.keys) {
      const from = Math.round(k.time * old);
      const exact = Math.round(k.time * rate) / rate;
      if (Math.abs(k.time - exact) > KEY_EPSILON) moved++;
      const key = { ...k, time: exact };
      if (!MULTI_AT_TIME.has(arr.kind)) {
        const at = placed.findIndex((p) => Math.abs(p.key.time - exact) < KEY_EPSILON);
        if (at >= 0) {
          merged++;
          const frame = Math.round(exact * rate);
          const hit = collisions.find((c) => c.channel === arr.label && c.frame === frame);
          if (hit) hit.fromFrames.push(from);
          else collisions.push({ channel: arr.label, frame, fromFrames: [placed[at]!.from, from] });
          placed.splice(at, 1);
        }
      }
      placed.push({ key, from });
    }
    arr.set(placed.map((p) => p.key).sort((a, b) => a.time - b.time));
  }
  const seconds = next.duration;
  next.fps = rate;
  next.duration = Math.max(1, Math.round(seconds * rate)) / rate;
  return { clip: next, fps: rate, moved, merged, collisions, channels: arrays.length };
}

/** `previewClipFps` without the report; `moved` counts the times that were not already on a new frame. */
export function setClipFps(clip: ClipData, fps: number): { clip: ClipData; moved: number } {
  const p = previewClipFps(clip, fps);
  return { clip: p.clip, moved: p.moved };
}

export function setLoop(clip: ClipData, loop: boolean): ClipData {
  return { ...cloneClip(clip), loop };
}

/**
 * Changes the clip length (seconds, snapped to whole frames, at least one frame). Keys past the
 * new end are kept in the data but the format requires keys inside the clip, so they are dropped
 * here and reported by the caller as a count.
 */
export function setDuration(clip: ClipData, duration: number): { clip: ClipData; dropped: number } {
  const next = cloneClip(clip);
  const fps = clipFps(next);
  next.duration = Math.max(1, Math.round(duration * fps)) / fps;
  let dropped = 0;
  // Every channel is trimmed: bones, slot attachment and colour, IK, transform and physics, deform, draw order and events ().
  for (const arr of timedArrays(next)) {
    const kept = arr.keys.filter((k) => k.time <= next.duration + KEY_EPSILON);
    if (kept.length === arr.keys.length) continue;
    dropped += arr.keys.length - kept.length;
    arr.set(kept);
  }
  return { clip: next, dropped };
}

/** A new empty clip (non-looping by default: most clips are one-shots; Loop is one click). */
export function emptyClip(duration = 1, loop = false, fps = DEFAULT_CLIP_FPS): ClipData {
  return parseClip({ duration, loop, fps });
}

// ---------------------------------------------------------------------------------------------
// Writing: the defaults the schema fills are left out again, so a saved clip reads like the
// generated rigs (no `"curve": "linear"`, no empty records). parseClip(writeClip(c)) equals c.
// ---------------------------------------------------------------------------------------------

function compactKeys(keys: readonly Record<string, unknown>[], defaults: Record<string, unknown>): Record<string, unknown>[] {
  return keys.map((key) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(key)) {
      if (v === undefined) continue;
      if (k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(v)) continue;
      out[k] = v;
    }
    return out;
  });
}

const CURVE_DEFAULT = { curve: "linear" };

function compactRecord<T>(record: Record<string, T>, map: (value: T) => unknown): Record<string, unknown> | undefined {
  const entries = Object.entries(record);
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, map(v)]));
}

/** The clip as written to disk: format-valid, defaults omitted, key order like the generated rigs. */
export function writeClip(clip: ClipData): Record<string, unknown> {
  const out: Record<string, unknown> = { duration: clip.duration, loop: clip.loop };
  if (clip.fps !== undefined) out.fps = clip.fps;
  const bones = compactRecord(clip.bones, (timelines) => {
    const t: Record<string, unknown> = {};
    for (const [ch, keys] of Object.entries(timelines)) if (keys) t[ch] = compactKeys(keys as Record<string, unknown>[], CURVE_DEFAULT);
    return t;
  });
  if (bones) out.bones = bones;
  const slots = compactRecord(clip.slots, (timelines) => {
    const t: Record<string, unknown> = {};
    if (timelines.attachment) t.attachment = timelines.attachment.map((k) => ({ ...k }));
    if (timelines.color) t.color = compactKeys(timelines.color, CURVE_DEFAULT);
    return t;
  });
  if (slots) out.slots = slots;
  const ik = compactRecord(clip.ik, (keys) => compactKeys(keys, CURVE_DEFAULT));
  if (ik) out.ik = ik;
  const transform = compactRecord(clip.transform, (keys) => compactKeys(keys, CURVE_DEFAULT));
  if (transform) out.transform = transform;
  const pathKeys = compactRecord(clip.path, (keys) => compactKeys(keys, CURVE_DEFAULT));
  if (pathKeys) out.path = pathKeys;
  const physics = compactRecord(clip.physics, (timelines) => {
    const t: Record<string, unknown> = {};
    if (timelines.mix) t.mix = compactKeys(timelines.mix, CURVE_DEFAULT);
    if (timelines.reset) t.reset = timelines.reset.map((k) => ({ ...k }));
    return t;
  });
  if (physics) out.physics = physics;
  const deform = compactRecord(clip.deform, (slots) =>
    Object.fromEntries(Object.entries(slots).map(([slot, atts]) => [slot, Object.fromEntries(Object.entries(atts).map(([att, keys]) => [att, compactKeys(keys, { ...CURVE_DEFAULT, offset: 0 })]))]))
  );
  if (deform) out.deform = deform;
  if (clip.drawOrder.length) out.drawOrder = clip.drawOrder.map((k) => ({ ...k }));
  if (clip.events.length) out.events = clip.events.map((k) => ({ ...k }));
  return out;
}

/** JSON text of a clip file (one space indent like the fixtures). */
export function clipJson(clip: ClipData): string {
  return `${JSON.stringify({ clipVersion: CLIP_FILE_VERSION, ...writeClip(clip) }, null, 1)}\n`;
}

/** Structural equality of two clips after parsing (the round-trip criterion). */
export function clipsEquivalent(a: unknown, b: unknown): boolean {
  return canonical(parseClip(a)) === canonical(parseClip(b));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}
