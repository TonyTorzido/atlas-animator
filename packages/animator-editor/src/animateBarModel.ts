/*
 * Atlas Animator editor: pure helpers for the Animate bar (animateBar.ts; the design notes, section 5).
 * Key frames for the scrubber's diamonds, contact frames for its flags, jumping between keys, mapping a pointer to a frame, and
 * which project clip (if any) the open clip is. No DOM.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { boneKeyTimes, frameCount, timeToFrame } from "./clipModel.js";
import { findClip, LEGACY_CLIP_ALIASES, type GameClip } from "./gameClips.js";

/** Frames that hold a key on any bone, sorted. */
export function keyFrames(clip: ClipData): number[] {
  const frames = new Set<number>();
  for (const bone of Object.keys(clip.bones)) for (const t of boneKeyTimes(clip, bone)) frames.add(timeToFrame(clip, t));
  return [...frames].sort((a, b) => a - b);
}

/** Frames of the clip's `hit` events: the moment of contact. */
export function contactFrames(clip: ClipData): number[] {
  const frames = new Set<number>();
  for (const e of clip.events) if (e.name === "hit") frames.add(timeToFrame(clip, e.time));
  return [...frames].sort((a, b) => a - b);
}

/** The key frame before / after `frame` (null at the ends). */
export function neighbourKey(frames: readonly number[], frame: number, dir: 1 | -1): number | null {
  if (dir > 0) return frames.find((f) => f > frame) ?? null;
  return [...frames].reverse().find((f) => f < frame) ?? null;
}

/** The frame under a pointer at `x` px of a track `width` px wide, clamped to the clip. */
export function frameAtX(clip: Pick<ClipData, "fps" | "duration">, x: number, width: number): number {
  const n = frameCount(clip);
  if (width <= 0 || n <= 0) return 0;
  return Math.max(0, Math.min(n, Math.round((x / width) * n)));
}

/** The 0..1 position of a frame along the track. */
export function frameFraction(clip: Pick<ClipData, "fps" | "duration">, frame: number): number {
  const n = frameCount(clip);
  return n <= 0 ? 0 : Math.max(0, Math.min(1, frame / n));
}

/** The catalogue clip the open clip is (by its id, or a legacy name the project still plays it under), or null for a free-named clip. */
export function gameClipFor(name: string): GameClip | null {
  const direct = findClip(name);
  if (direct) return direct;
  for (const [id, aliases] of Object.entries(LEGACY_CLIP_ALIASES)) if (aliases.includes(name)) return findClip(id) ?? null;
  return null;
}
