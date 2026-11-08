/*
 * Atlas Animator editor: original implementation.
 *
 * Easing presets for attack animation (pure), applied to the selected keys. A key's curve shapes the move from that key
 * to the next, so each preset is named by what the move into the next pose should feel like:
 *
 * - anticipate: a held start that drifts, then speeds up into the next pose (the wind-up);
 * - strike:     almost instant, decelerating into contact (the swing);
 * - overshoot:  fast, passes the target by about 8% and settles back (one bezier);
 * - damped:     overshoot 10%, undershoot 3%, settle: two extra keys per channel are written between the key and the next one.
 *
 * The cubic beziers are the same CurveSpec the curve panel edits, so a preset can still be tuned by hand afterwards.
 */
import type { ClipData, CurveSpec } from "@atlas-animator/core/core";
import { KEY_EPSILON, frameTime, timeToFrame } from "./clipModel.js";
import { bezierAt, setCurves, type Bezier, type CurveTarget } from "./curveModel.js";

export type EasingId = "anticipate" | "strike" | "overshoot" | "damped";

export const EASING_PRESETS: readonly { id: EasingId; label: string; hint: string }[] = [
  { id: "anticipate", label: "Anticipation hold", hint: "Holds the pose, then eases hard into the next one (wind-up)" },
  { id: "strike", label: "Fast strike", hint: "Almost a snap into the next pose, easing out at contact" },
  { id: "overshoot", label: "Overshoot, settle", hint: "Passes the next pose by about 8% and settles back" },
  { id: "damped", label: "Damped settle", hint: "Overshoots 10%, undershoots 3%, settles (writes two extra keys per channel)" }
];

export const EASING_CURVES: Record<Exclude<EasingId, "damped">, CurveSpec> = {
  anticipate: [0.8, 0, 1, 0.6],
  strike: [0.02, 0.85, 0.12, 1],
  overshoot: [0.2, 0.9, 0.4, 1.25]
};

/** Share of the span (0..1) and the fraction of the value change past (+) or short of (-) the next key, for the two damped keys. */
export const DAMPED_STEPS = [
  { at: 0.5, past: 0.1 },
  { at: 0.75, past: -0.03 }
] as const;
/** Fewest frames between a key and the next one that still fit the two damped keys. */
export const DAMPED_MIN_FRAMES = 5;

/** The largest excursion past the end value of a bezier, as a fraction of the value change (0 when it never passes). */
export function overshootOf(spec: CurveSpec): number {
  if (!Array.isArray(spec)) return 0;
  let peak = 1;
  for (let i = 1; i <= 200; i++) peak = Math.max(peak, bezierAt(spec as Bezier, i / 200));
  return peak - 1;
}

type ChannelKey = { time: number; value?: number; x?: number; y?: number; curve?: unknown };

const EASE_OUT: CurveSpec = [0, 0, 0.58, 1];
const EASE_IN_OUT: CurveSpec = [0.42, 0, 0.58, 1];

/** Adds the damped keys after `key` in one channel; returns false when the span is too short or a frame is taken. */
function dampKeys(clip: ClipData, keys: ChannelKey[], key: ChannelKey): boolean {
  const at = keys.indexOf(key);
  const next = keys[at + 1];
  if (!next) return false;
  const f0 = timeToFrame(clip, key.time);
  const span = timeToFrame(clip, next.time) - f0;
  if (span < DAMPED_MIN_FRAMES) return false;
  const frames = DAMPED_STEPS.map((s) => f0 + Math.round(span * s.at));
  if (new Set(frames).size < frames.length || frames.some((f) => keys.some((k) => Math.abs(k.time - frameTime(clip, f)) < KEY_EPSILON))) return false;
  const make = (past: number, f: number, curve: CurveSpec): ChannelKey => {
    const out: ChannelKey = { time: frameTime(clip, f), curve };
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    if (key.value !== undefined && next.value !== undefined) out.value = r(next.value + (next.value - key.value) * past);
    if (key.x !== undefined && next.x !== undefined) out.x = r(next.x + (next.x - key.x) * past);
    if (key.y !== undefined && next.y !== undefined) out.y = r(next.y + (next.y - key.y) * past);
    return out;
  };
  const first = make(DAMPED_STEPS[0].past, frames[0]!, EASE_IN_OUT);
  const second = make(DAMPED_STEPS[1].past, frames[1]!, EASE_IN_OUT);
  key.curve = EASE_OUT;
  keys.splice(at + 1, 0, first, second);
  return true;
}

/** Applies a preset to each target key. Missing keys are skipped. Damped falls back to a 4% overshoot curve where it cannot add keys. */
export function applyEasing(clip: ClipData, id: EasingId, targets: readonly CurveTarget[]): ClipData {
  if (id !== "damped") return setCurves(clip, targets, EASING_CURVES[id]);
  const next = structuredClone(clip);
  const fallback: CurveTarget[] = [];
  for (const t of targets) {
    if (t.kind !== "bone") {
      fallback.push(t);
      continue;
    }
    let done = false;
    for (const ch of ["rotate", "translate", "scale"] as const) {
      const keys = next.bones[t.name]?.[ch] as unknown as ChannelKey[] | undefined;
      const key = keys?.find((k) => Math.abs(k.time - t.time) < KEY_EPSILON);
      if (keys && key && dampKeys(next, keys, key)) done = true;
    }
    if (!done) fallback.push(t);
  }
  return fallback.length ? setCurves(next, fallback, [0.3, 0.9, 0.5, 1.1]) : next;
}
