/*
 * Atlas Animator editor: original implementation.
 *
 * Live hand IK (pure clip edit). The bake mode of the Hand IK tool writes plain FK rotate keys. The live mode, keeps the
 * arm's IK constraint on instead: the constraint mix is keyed to 1 at the key frame (and 0 at the clip start, so the frames before are
 * untouched FK) and the hand target bone is keyed to where the hand stands, so the in-betweens move the hand smoothly between target keys.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, setVectorKey } from "./clipModel.js";

type Key = { time: number; mix?: number; curve?: unknown };

/** Whether the constraint is already keyed on (mix > 0) at `time`: the last key at or before it, or the first key. */
export function ikLiveAt(clip: ClipData, ik: string, time: number): boolean {
  const keys = ((clip.ik as unknown as Record<string, Key[] | undefined>)[ik] ?? []).slice().sort((a, b) => a.time - b.time);
  if (!keys.length) return false;
  const before = keys.filter((k) => k.time <= time + KEY_EPSILON);
  return (before[before.length - 1] ?? keys[0]!).mix !== 0;
}

/**
 * Switches the constraint `ik` on at `time` and keys its `target` bone's translate offset (`x`, `y` from setup) there.
 * With no earlier IK key a mix 0 key is added at time 0, so nothing before `time` changes.
 */
export function keyHandIk(clip: ClipData, ik: string, target: string, time: number, x: number, y: number): ClipData {
  const next = structuredClone(clip);
  const rec = next.ik as unknown as Record<string, Key[]>;
  const keys = (rec[ik] ??= []);
  const at = keys.findIndex((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (at >= 0) keys[at] = { ...keys[at]!, mix: 1 };
  else keys.push({ time, mix: 1, curve: "linear" });
  if (time > KEY_EPSILON && !keys.some((k) => k.time < time - KEY_EPSILON)) keys.push({ time: 0, mix: 0, curve: "linear" });
  keys.sort((a, b) => a.time - b.time);
  return setVectorKey(next, target, "translate", time, x, y);
}
