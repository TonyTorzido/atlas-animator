/*
 * Atlas Animator editor: server-tick hit lock (pure, no DOM).
 *
 * The server lands a hit on a 20 Hz tick (ATTACK_PROFILE_TICK_LENGTH_MS) while the clip plays at 30 fps, so a `hit` event has exactly
 * one right frame per profile step: `stepContactFrame` (windupMs at the clip's fps). This module finds which profile step each hit
 * belongs to (its link, else the project clip the open clip is named after), says how far each hit is from its contact frame, flags a
 * clip longer than the step's windupMs + recoveryMs, and snaps a hit onto the right frame with `lockHit`.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { ATTACK_PROFILE_TICK_LENGTH_MS, attackProfileForStyle } from "./preview/attackProfiles.js";
import { clipFps, frameCount, frameTime, timeToFrame } from "./clipModel.js";
import { hitLink, lockHit, stepContactFrame } from "./eventModel.js";
import { findClip } from "./gameClips.js";

export const TICK_S = ATTACK_PROFILE_TICK_LENGTH_MS / 1000;

/** Times (seconds) of the server ticks inside a clip of `duration` seconds. */
export function tickTimes(duration: number): number[] {
  const out: number[] = [];
  for (let k = 0; k * TICK_S <= duration + 1e-9; k++) out.push(k * TICK_S);
  return out;
}

export interface ProfileRef {
  style: string;
  step: number;
}

/** The attack profile step the clip is for, from the project clip catalogue (the open clip is named after a project clip id). */
export function clipProfile(clipName: string): ProfileRef | null {
  const game = findClip(clipName);
  if (!game || game.group !== "attack" || game.timing.source !== "profile" || !game.timing.styleId) return null;
  return { style: game.timing.styleId, step: (game.step ?? 1) - 1 };
}

export interface HitStatus {
  time: number;
  frame: number;
  /** The profile step's contact frame. */
  want: number;
  /** Frames the hit is after (+) or before (-) the contact frame. */
  delta: number;
  ok: boolean;
  profile: ProfileRef;
  /** The hit's server tick, and the tick the contact frame belongs to. */
  tick: number;
  wantTick: number;
}

export function hitStatuses(clip: ClipData, clipName: string): HitStatus[] {
  const fps = clipFps(clip);
  const fallback = clipProfile(clipName);
  const out: HitStatus[] = [];
  for (const e of clip.events) {
    if (e.name !== "hit") continue;
    const profile = hitLink(e) ?? fallback;
    if (!profile) continue;
    const want = stepContactFrame(profile.style, profile.step, fps);
    if (want === null) continue;
    const frame = timeToFrame(clip, e.time);
    out.push({
      time: e.time,
      frame,
      want,
      delta: frame - want,
      ok: frame === want,
      profile,
      tick: Math.round(frame / fps / TICK_S),
      wantTick: Math.round(frameTime(clip, want) / TICK_S)
    });
  }
  return out;
}

export interface LengthIssue {
  frames: number;
  allowedFrames: number;
  windupMs: number;
  recoveryMs: number;
}

/** The profile step a clip is for: its first linked hit, else the project clip it is named after. */
export function clipStep(clip: ClipData, clipName: string): ProfileRef | null {
  for (const e of clip.events) {
    const link = e.name === "hit" ? hitLink(e) : null;
    if (link) return link;
  }
  return clipProfile(clipName);
}

/** Set when the clip is longer than the step's windupMs + recoveryMs (the next press would not wait for the tail). */
export function lengthIssue(clip: ClipData, clipName: string): LengthIssue | null {
  const ref = clipStep(clip, clipName);
  const step = ref ? attackProfileForStyle(ref.style).combo[ref.step] : undefined;
  if (!step) return null;
  const allowedFrames = Math.max(1, Math.round(((step.windupMs + step.recoveryMs) * clipFps(clip)) / 1000));
  const frames = frameCount(clip);
  return frames > allowedFrames ? { frames, allowedFrames, windupMs: step.windupMs, recoveryMs: step.recoveryMs } : null;
}

export type ChipState = "ok" | "bad" | "none";

export interface Chip {
  state: ChipState;
  text: string;
  detail: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The live chip: "Hit on tick ✓", "Hit 1 frame late ▾", a length warning, or nothing when the clip has no attack profile. */
export function hitChip(hits: readonly HitStatus[], length: LengthIssue | null): Chip {
  const detail: string[] = [];
  for (const h of hits) {
    detail.push(
      h.ok
        ? `Hit on frame ${h.frame} lands on server tick ${h.tick} (${h.profile.style} step ${h.profile.step + 1}).`
        : `Hit is on frame ${h.frame} (tick ${h.tick}); ${h.profile.style} step ${h.profile.step + 1} makes contact on frame ${h.want} (tick ${h.wantTick}).`
    );
  }
  if (length) detail.push(`The clip is ${plural(length.frames, "frame")} long but the step allows ${length.allowedFrames} (windup ${length.windupMs} ms + recovery ${length.recoveryMs} ms).`);
  const worst = hits.find((h) => !h.ok);
  if (worst) {
    const n = Math.abs(worst.delta);
    return { state: "bad", text: `Hit ${plural(n, "frame")} ${worst.delta > 0 ? "late" : "early"} ▾`, detail };
  }
  if (length) return { state: "bad", text: `Clip ${length.frames - length.allowedFrames} over ▾`, detail };
  if (hits.length) return { state: "ok", text: "Hit on tick ✓", detail };
  return { state: "none", text: "", detail };
}

/** The clip with the hit snapped onto its profile step's contact frame (and linked to it). */
export function snapHit(clip: ClipData, status: Pick<HitStatus, "profile">): ClipData {
  return lockHit(clip, status.profile.style, status.profile.step);
}
