/*
 * Atlas Animator editor: original implementation.
 *
 * Key reduction (pure): removes keys that the runtime would reproduce anyway from their neighbours.
 *
 * A key is redundant when dropping it leaves the sampled clip within a per-channel tolerance. The test is the sampled value, not just
 * the key list: the shortened timeline is compared with the original at every key time it spans and at every frame of the clip's
 * fps inside the span (what the project displays), through the same curves (`evaluateCurve`: linear, stepped, bezier). So a key on an
 * ease curve, or a stepped hold, is only removed when the result still draws the same poses.
 *
 * Never removed: the first and last key of a timeline, event keys, slot attachment (swap) keys, draw-order keys. Slot colour,
 * transform / physics / deform timelines are not touched at all. Reduced: bone rotate / translate / scale / shear and IK constraint
 * mix + softness (an IK key that changes bend / stretch / compress flags is kept).
 */
import { curveForChannel, evaluateCurve, type ClipData, type CurveSpec } from "@atlas-animator/core/core";
import { clipFps, KEY_EPSILON } from "./clipModel.js";

export type ReduceChannel = "rotate" | "translate" | "scale" | "shear" | "ik";
export const REDUCE_CHANNELS: readonly ReduceChannel[] = ["rotate", "translate", "scale", "shear", "ik"];

/** Largest allowed difference per channel: degrees (rotate, shear), px (translate), scale factor, IK mix / softness. */
export type Tolerances = Record<ReduceChannel, number>;

export const DEFAULT_TOLERANCES: Readonly<Tolerances> = { rotate: 0.5, translate: 0.5, scale: 0.01, shear: 0.5, ik: 0.02 };

export const TOLERANCE_UNITS: Readonly<Record<ReduceChannel, string>> = { rotate: "deg", translate: "px", scale: "x", shear: "deg", ik: "mix" };

export interface ReduceOptions {
  tolerances?: Partial<Tolerances>;
  /** Bones to reduce (their four channels). Omitted: the whole clip (every bone and every IK constraint). IK keys are only reduced in the whole-clip scope. */
  bones?: readonly string[];
}

export interface RemovedKey {
  channel: ReduceChannel;
  /** Bone name, or IK constraint name. */
  owner: string;
  time: number;
}

export interface ReduceResult {
  clip: ClipData;
  removed: number;
  keysBefore: number;
  keysAfter: number;
  perChannel: Record<ReduceChannel, number>;
  keys: RemovedKey[];
}

type CurveField = CurveSpec | Readonly<Record<string, CurveSpec | undefined>>;
type AnyKey = { time: number; curve?: CurveField } & Record<string, unknown>;

interface Track {
  channel: ReduceChannel;
  owner: string;
  /** The key array in the clip (replaced in place by the reduced list). */
  keys: AnyKey[];
  /** Numeric fields compared (value; x, y; mix, softness), which are also the curve channel names. */
  fields: readonly string[];
}

const FIELDS: Record<ReduceChannel, readonly string[]> = { rotate: ["value"], translate: ["x", "y"], scale: ["x", "y"], shear: ["x", "y"], ik: ["mix", "softness"] };
const IK_FLAGS = ["bendPositive", "stretch", "compress"] as const;

function specOf(key: AnyKey, field: string): CurveSpec {
  return key.curve === undefined ? "linear" : curveForChannel(key.curve, field);
}

/** The value of `field` at `t` on `keys` (sorted by time), through each key's own curve; held before the first and after the last key. */
function sample(keys: readonly AnyKey[], field: string, t: number): number | undefined {
  const first = keys[0]!;
  if (t <= first.time) return first[field] as number | undefined;
  const last = keys[keys.length - 1]!;
  if (t >= last.time) return last[field] as number | undefined;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.time <= t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const av = a[field] as number | undefined;
  const bv = b[field] as number | undefined;
  if (av === undefined || bv === undefined) return av;
  const u = (t - a.time) / (b.time - a.time);
  return av + (bv - av) * evaluateCurve(specOf(a, field), u);
}

/** True when dropping `keys[index]` (between the kept key `prev` and the key `next`) still samples within `tol` of the original over that span. */
function removable(track: Track, keys: readonly AnyKey[], prev: number, index: number, next: number, fps: number, tol: number): boolean {
  const key = keys[index]!;
  if (track.channel === "ik") {
    // Flags are discrete: only drop a key that leaves them as the previous kept key had them.
    const p = keys[prev]!;
    for (const flag of IK_FLAGS) if (key[flag] !== p[flag]) return false;
    for (const field of track.fields) if ((key[field] === undefined) !== (p[field] === undefined)) return false;
  }
  const candidate = [keys[prev]!, keys[next]!];
  const t0 = keys[prev]!.time;
  const t1 = keys[next]!.time;
  if (t1 - t0 < KEY_EPSILON) return false;
  const times = new Set<number>();
  for (let j = prev; j <= next; j++) times.add(keys[j]!.time);
  for (let f = Math.ceil(t0 * fps - 1e-9); f / fps <= t1 + 1e-9; f++) times.add(f / fps);
  for (const t of times) {
    if (t < t0 - 1e-9 || t > t1 + 1e-9) continue;
    for (const field of track.fields) {
      const a = sample(keys, field, t);
      const b = sample(candidate, field, t);
      if (a === undefined || b === undefined) {
        if (a !== b) return false;
        continue;
      }
      if (Math.abs(a - b) > tol + 1e-9) return false;
    }
  }
  return true;
}

function reduceTrack(track: Track, fps: number, tol: number): { keys: AnyKey[]; dropped: number[] } {
  const keys = track.keys;
  const dropped: number[] = [];
  if (keys.length <= 2) return { keys: [...keys], dropped };
  const kept: AnyKey[] = [keys[0]!];
  let prev = 0;
  for (let i = 1; i < keys.length - 1; i++) {
    if (removable(track, keys, prev, i, i + 1, fps, tol)) {
      dropped.push(keys[i]!.time);
    } else {
      kept.push(keys[i]!);
      prev = i;
    }
  }
  kept.push(keys[keys.length - 1]!);
  return { keys: kept, dropped };
}

function collectTracks(clip: ClipData, bones: readonly string[] | undefined): Track[] {
  const tracks: Track[] = [];
  for (const owner of bones ?? Object.keys(clip.bones)) {
    const t = clip.bones[owner];
    if (!t) continue;
    for (const channel of ["rotate", "translate", "scale", "shear"] as const) {
      const keys = t[channel] as AnyKey[] | undefined;
      if (keys) tracks.push({ channel, owner, keys, fields: FIELDS[channel] });
    }
  }
  if (!bones) for (const [owner, keys] of Object.entries(clip.ik)) tracks.push({ channel: "ik", owner, keys: keys as AnyKey[], fields: FIELDS.ik });
  return tracks;
}

/** Keys that a reduction with this scope looks at (the "before" figure of the preview). */
export function countKeys(clip: ClipData, bones?: readonly string[]): number {
  return collectTracks(clip, bones).reduce((n, t) => n + t.keys.length, 0);
}

/**
 * The clip with redundant keys removed (a new clip; the input is untouched) and what was removed. The preview count is the same call:
 * `reduceKeys(clip, options).removed`.
 */
export function reduceKeys(clip: ClipData, options: ReduceOptions = {}): ReduceResult {
  const tolerances: Tolerances = { ...DEFAULT_TOLERANCES, ...options.tolerances };
  const next = structuredClone(clip);
  const fps = clipFps(next);
  const perChannel: Record<ReduceChannel, number> = { rotate: 0, translate: 0, scale: 0, shear: 0, ik: 0 };
  const removedKeys: RemovedKey[] = [];
  const before = countKeys(next, options.bones);
  for (const track of collectTracks(next, options.bones)) {
    const { keys, dropped } = reduceTrack(track, fps, Math.max(0, tolerances[track.channel]));
    if (!dropped.length) continue;
    track.keys.splice(0, track.keys.length, ...keys);
    perChannel[track.channel] += dropped.length;
    for (const time of dropped) removedKeys.push({ channel: track.channel, owner: track.owner, time });
  }
  return { clip: next, removed: removedKeys.length, keysBefore: before, keysAfter: before - removedKeys.length, perChannel, keys: removedKeys };
}
