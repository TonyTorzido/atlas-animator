/*
 * Atlas Animator editor: original implementation.
 *
 * Root and foot lock (pure clip edits). A foot lock pins a foot to the ground across a frame range: the leg's IK mix is keyed
 * to 1 over the range (blending in the frame before and out the frame after) and the IK target bone is keyed to the world
 * spot the foot stood at on the first frame, so the hips can lunge and the foot stays put. A root lock holds a bone (the
 * root, normally) at one translate across the range, removing drift. Measuring the spot is the editor's job (main.ts).
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, frameCount, frameTime, setVectorKey, timeToFrame } from "./clipModel.js";

export interface FootLock {
  /** The IK constraint name (e.g. foot_l_ik) and its target bone (foot_l_target). */
  ik: string;
  target: string;
  /** First and last locked frame. */
  a: number;
  b: number;
  /** Translate offset of the target bone from its setup that puts the foot on the spot. */
  x: number;
  y: number;
  /** Frames the IK mix takes to blend in before `a` and out after `b` (default 1). */
  blend?: number;
}

type Key = { time: number; mix?: number; curve?: unknown };

const near = (a: number, b: number) => Math.abs(a - b) < KEY_EPSILON;

function ikKeys(clip: ClipData, ik: string): Key[] {
  return ((clip.ik as unknown as Record<string, Key[] | undefined>)[ik] ??= []);
}

function dropKeysBetween(keys: { time: number }[], from: number, to: number): { time: number }[] {
  return keys.filter((k) => k.time <= from + KEY_EPSILON || k.time >= to - KEY_EPSILON);
}

/** Pins the foot: IK mix 1 from a to b, the target held on the spot. */
export function lockFoot(clip: ClipData, lock: FootLock): ClipData {
  if (!(lock.b >= lock.a)) throw new Error("the lock range ends before it starts");
  let next = structuredClone(clip);
  const blend = Math.max(1, Math.round(lock.blend ?? 1));
  const ta = frameTime(next, lock.a);
  const tb = frameTime(next, lock.b);
  const keys = dropKeysBetween(ikKeys(next, lock.ik), ta, tb) as Key[];
  const put = (time: number, mix: number, onlyIfFree: boolean) => {
    const at = keys.findIndex((k) => near(k.time, time));
    if (at >= 0) {
      if (onlyIfFree) return;
      keys[at] = { ...keys[at]!, mix };
    } else keys.push({ time, mix, curve: "linear" });
  };
  put(ta, 1, false);
  put(tb, 1, false);
  if (lock.a - blend >= 0) put(frameTime(next, lock.a - blend), 0, true);
  if (lock.b + blend <= frameCount(next)) put(frameTime(next, lock.b + blend), 0, true);
  keys.sort((p, q) => p.time - q.time);
  (next.ik as unknown as Record<string, Key[]>)[lock.ik] = keys;
  const tl = next.bones[lock.target]?.translate;
  if (tl) next.bones[lock.target]!.translate = dropKeysBetween(tl, ta, tb) as typeof tl;
  next = setVectorKey(next, lock.target, "translate", ta, lock.x, lock.y);
  next = setVectorKey(next, lock.target, "translate", tb, lock.x, lock.y);
  return next;
}

/** Removes a foot lock: the IK mix keys and the target's translate keys from a - blend to b + blend. */
export function unlockFoot(clip: ClipData, ik: string, target: string, a: number, b: number, blend = 1): ClipData {
  const next = structuredClone(clip);
  const from = frameTime(next, a - blend) - KEY_EPSILON;
  const to = frameTime(next, b + blend) + KEY_EPSILON;
  const inside = (k: { time: number }) => k.time >= from && k.time <= to;
  const keys = (next.ik as unknown as Record<string, Key[] | undefined>)[ik];
  if (keys) {
    const kept = keys.filter((k) => !inside(k));
    if (kept.length) (next.ik as unknown as Record<string, Key[]>)[ik] = kept;
    else delete (next.ik as unknown as Record<string, Key[]>)[ik];
  }
  const tl = next.bones[target]?.translate;
  if (tl) {
    const kept = tl.filter((k) => !inside(k));
    if (kept.length) next.bones[target]!.translate = kept;
    else {
      delete next.bones[target]!.translate;
      if (!Object.keys(next.bones[target]!).length) delete next.bones[target];
    }
  }
  return next;
}

/** Holds a bone at one translate offset from frame a to b (keys at both ends, the keys between removed). */
export function lockRoot(clip: ClipData, bone: string, a: number, b: number, x: number, y: number): ClipData {
  if (!(b >= a)) throw new Error("the lock range ends before it starts");
  let next = structuredClone(clip);
  const ta = frameTime(next, a);
  const tb = frameTime(next, b);
  const tl = next.bones[bone]?.translate;
  if (tl) next.bones[bone]!.translate = dropKeysBetween(tl, ta, tb) as typeof tl;
  next = setVectorKey(next, bone, "translate", ta, x, y);
  next = setVectorKey(next, bone, "translate", tb, x, y);
  return next;
}

/** The frame ranges where an IK constraint is keyed to a mix of 1 at both ends (what lockFoot writes). */
export function footLockRanges(clip: ClipData, ik: string): { a: number; b: number }[] {
  const keys = (clip.ik as unknown as Record<string, Key[] | undefined>)[ik] ?? [];
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    if ((keys[i]!.mix ?? 0) >= 1 && (keys[i + 1]!.mix ?? 0) >= 1) {
      const a = timeToFrame(clip, keys[i]!.time);
      const b = timeToFrame(clip, keys[i + 1]!.time);
      const last = out[out.length - 1];
      if (last && last.b === a) last.b = b;
      else out.push({ a, b });
    }
  }
  return out;
}

/** Largest distance of any sample from the first one (how far a foot slid). */
export function maxDrift(samples: readonly { x: number; y: number }[]): number {
  const first = samples[0];
  if (!first) return 0;
  return Math.max(0, ...samples.map((s) => Math.hypot(s.x - first.x, s.y - first.y)));
}
