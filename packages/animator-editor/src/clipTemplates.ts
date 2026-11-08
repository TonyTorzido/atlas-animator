/*
 * Atlas Animator editor: starter clips for the project clip catalogue (pure, no DOM).
 *
 * `templateFor(entry)` builds an empty ClipData with the right length, fps, loop flag and event markers; the user then
 * poses it. Attacks take length and contact frame from the attack profile (src/preview/attackProfiles.ts) through
 * eventModel's `stepContactFrame` / `lockHit`; gathers put `hit` on the tool impact.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { attackProfileForStyle } from "./preview/attackProfiles.js";
import { emptyClip, frameCount, frameTime } from "./clipModel.js";
import { lockHit, setEvent, stepContactFrame } from "./eventModel.js";
import type { GameClip } from "./gameClips.js";

export const TEMPLATE_FPS = 30;
/** The slash trail opens this many frames before the hit and closes this many after. */
export const TRAIL_LEAD_FRAMES = 2;

const framesFor = (seconds: number) => Math.max(1, Math.round(seconds * TEMPLATE_FPS));

/** Length in frames of an attack step: (windupMs + recoveryMs) snapped to frames. */
export function attackFrames(styleId: string, stepIndex: number): number {
  const step = attackProfileForStyle(styleId).combo[stepIndex];
  return step ? framesFor((step.windupMs + step.recoveryMs) / 1000) : framesFor(0.7);
}

function attackTemplate(entry: GameClip): ClipData {
  const styleId = entry.timing.styleId ?? "default";
  const stepIndex = (entry.step ?? 1) - 1;
  const frames = attackFrames(styleId, stepIndex);
  let clip = emptyClip(frameTime({ fps: TEMPLATE_FPS }, frames), false, TEMPLATE_FPS);
  const hit = stepContactFrame(styleId, stepIndex, TEMPLATE_FPS) ?? 0;
  const t = (f: number) => frameTime(clip, Math.min(frames, Math.max(0, f)));
  clip = setEvent(clip, 0, "windup");
  clip = lockHit(clip, styleId, stepIndex);
  clip = setEvent(clip, t(hit - TRAIL_LEAD_FRAMES), "trailOn");
  clip = setEvent(clip, t(hit + TRAIL_LEAD_FRAMES), "trailOff");
  clip = setEvent(clip, t(frames), "ready");
  return clip;
}

function gatherTemplate(entry: GameClip): ClipData {
  const frames = framesFor(entry.timing.durationS ?? 1);
  let clip = emptyClip(frameTime({ fps: TEMPLATE_FPS }, frames), entry.loop, TEMPLATE_FPS);
  if (entry.timing.impactAt !== undefined) {
    clip = setEvent(clip, frameTime(clip, Math.round(entry.timing.impactAt * frames)), "hit");
  }
  return clip;
}

/** A fresh ClipData for a catalogue entry: fps 30, loop flag from the entry, length and events from its timing. */
export function templateFor(entry: GameClip): ClipData {
  if (entry.custom) return emptyClip(frameTime({ fps: TEMPLATE_FPS }, framesFor(entry.timing.durationS ?? 1)), entry.loop, TEMPLATE_FPS);
  if (entry.group === "attack") return attackTemplate(entry);
  if (entry.group === "gather") return gatherTemplate(entry);
  return emptyClip(frameTime({ fps: TEMPLATE_FPS }, framesFor(entry.timing.durationS ?? 1)), entry.loop, TEMPLATE_FPS);
}

/** Frame count of a template (for tests and the board's length column). */
export function templateFrames(entry: GameClip): number {
  return frameCount(templateFor(entry));
}
