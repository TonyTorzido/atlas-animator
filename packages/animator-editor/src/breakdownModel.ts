/*
 * Atlas Animator editor: original implementation.
 *
 * Breakdown (pure), like a Tween Machine: put the selected bones at a chosen fraction of the way from their previous key to their next
 * key, and key them there. 0 % is the previous key's value, 100 % the next key's, below 0 and above 100 overshoot (the slider goes
 * from -50 to 150). Rotate, translate, scale and shear are each blended per channel, linearly in the key values, from the nearest key
 * before the playhead to the nearest key after it. A key already on the playhead is ignored when looking for neighbours, so applying
 * a breakdown twice (or dragging the slider) gives the same result as applying it once. On a looping clip the neighbour search wraps
 * around the end.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, setRotateKey, setVectorKey, snapTime, type BoneChannel } from "./clipModel.js";

export const BREAKDOWN_MIN = -50;
export const BREAKDOWN_MAX = 150;
/** The quick buttons next to the slider. */
export const BREAKDOWN_PRESETS: readonly number[] = [0, 25, 33, 50, 66, 75, 100];

export const clampBreakdown = (percent: number) => Math.min(BREAKDOWN_MAX, Math.max(BREAKDOWN_MIN, percent));

type RotKey = { time: number; value: number };
type VecKey = { time: number; x: number; y: number };

export interface Neighbours<K> {
  prev: K;
  next: K;
}

/** The keys either side of `time` (the key on `time` itself is skipped), wrapping on a loop; null when a side is missing. */
export function neighbourKeys<K extends { time: number }>(keys: readonly K[] | undefined, time: number, loop: boolean): Neighbours<K> | null {
  if (!keys?.length) return null;
  const sorted = keys.filter((k) => Math.abs(k.time - time) >= KEY_EPSILON).sort((a, b) => a.time - b.time);
  const before = sorted.filter((k) => k.time < time);
  const after = sorted.filter((k) => k.time > time);
  const prev = before[before.length - 1] ?? (loop ? after[after.length - 1] : undefined);
  const next = after[0] ?? (loop ? before[0] : undefined);
  return prev && next ? { prev, next } : null;
}

/** The blended value: `from` at 0, `to` at 100. */
export const blend = (from: number, to: number, percent: number) => from + (to - from) * (percent / 100);

export interface BreakdownResult {
  clip: ClipData;
  /** Bone -> channels keyed. */
  keyed: Record<string, BoneChannel[]>;
  /** Bones with no channel that has a key on both sides of the playhead. */
  skipped: string[];
}

/** Keys `bones` at `time` at `percent` between their previous and next keys. */
export function breakdownBones(clip: ClipData, bones: readonly string[], time: number, percent: number): BreakdownResult {
  const t = snapTime(clip, time);
  const p = clampBreakdown(percent);
  let next = clip;
  const keyed: Record<string, BoneChannel[]> = {};
  const skipped: string[] = [];
  for (const bone of bones) {
    const tl = clip.bones[bone];
    const done: BoneChannel[] = [];
    const rot = neighbourKeys(tl?.rotate as RotKey[] | undefined, t, clip.loop);
    if (rot) {
      next = setRotateKey(next, bone, t, blend(rot.prev.value, rot.next.value, p));
      done.push("rotate");
    }
    for (const ch of ["translate", "scale", "shear"] as const) {
      const n = neighbourKeys(tl?.[ch] as VecKey[] | undefined, t, clip.loop);
      if (!n) continue;
      next = setVectorKey(next, bone, ch, t, blend(n.prev.x, n.next.x, p), blend(n.prev.y, n.next.y, p));
      done.push(ch);
    }
    if (done.length) keyed[bone] = done;
    else skipped.push(bone);
  }
  return { clip: next, keyed, skipped };
}
