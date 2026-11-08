/*
 * Atlas Animator editor: original implementation.
 *
 * Per-key easing (pure). A key's `curve` shapes the move from that key to the next one: "linear",
 * "stepped" (hold, then jump), or a CSS-like cubic bezier [cx1, cy1, cx2, cy2] (x = fraction of the time
 * span, y = fraction of the value change, may overshoot). The presets are the usual ease-in / ease-out /
 * ease-in-out beziers, so a slow wind-up into a fast hit is one click on the key before the hit.
 */
import type { ClipData, CurveSpec } from "@atlas-animator/core/core";
import { KEY_EPSILON } from "./clipModel.js";

export type CurveKind = "linear" | "stepped" | "ease-in" | "ease-out" | "ease-in-out" | "bezier";
export type Bezier = readonly [number, number, number, number];

export const CURVE_PRESETS: Record<Exclude<CurveKind, "bezier">, CurveSpec> = {
  linear: "linear",
  stepped: "stepped",
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1]
};

export const CURVE_LABELS: Record<CurveKind, string> = {
  linear: "Linear",
  stepped: "Stepped",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "In-out",
  bezier: "Bezier"
};

const sameSpec = (a: CurveSpec, b: CurveSpec) => (Array.isArray(a) && Array.isArray(b) ? a.every((v, i) => Math.abs(v - (b as Bezier)[i]!) < 1e-6) : a === b);

/** Which preset a curve is, or "bezier" for any other control points. */
export function curveKind(spec: CurveSpec): CurveKind {
  for (const kind of ["linear", "stepped", "ease-in", "ease-out", "ease-in-out"] as const) if (sameSpec(spec, CURVE_PRESETS[kind])) return kind;
  return "bezier";
}

/** A valid bezier from loose numbers: x control points clamp to 0..1, y stays free (overshoot allowed), 4 decimals. */
export function bezier(cx1: number, cy1: number, cx2: number, cy2: number): CurveSpec {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const cx = (v: number) => r(Math.min(1, Math.max(0, v)));
  return [cx(cx1), r(cy1), cx(cx2), r(cy2)];
}

/** One key whose curve is edited: a bone's keys at a time (every channel), or an IK mix key. */
export type CurveTarget = { kind: "bone" | "ik"; name: string; time: number };

type CurvedKey = { time: number; curve?: unknown };

function keysOf(clip: ClipData, target: CurveTarget): CurvedKey[][] {
  if (target.kind === "ik") return clip.ik[target.name] ? [clip.ik[target.name] as CurvedKey[]] : [];
  const t = clip.bones[target.name];
  if (!t) return [];
  return [t.rotate, t.translate, t.scale, t.shear].filter((k): k is NonNullable<typeof k> => !!k) as CurvedKey[][];
}

/** The curve of the key at `time` (first channel that has one; a per-channel object reads as its first channel). */
export function keyCurveAt(clip: ClipData, target: CurveTarget): CurveSpec | undefined {
  for (const keys of keysOf(clip, target)) {
    const key = keys.find((k) => Math.abs(k.time - target.time) < KEY_EPSILON);
    if (!key) continue;
    const c = key.curve;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const first = Object.values(c as Record<string, CurveSpec | undefined>).find((v) => v !== undefined);
      return first ?? "linear";
    }
    return (c as CurveSpec | undefined) ?? "linear";
  }
  return undefined;
}

/** True when some key exists at the target (a curve can be set). */
export function hasCurveKey(clip: ClipData, target: CurveTarget): boolean {
  return keyCurveAt(clip, target) !== undefined;
}

/** Sets one curve on every channel of each target key (a per-channel curve object is replaced). Missing keys are skipped. */
export function setCurves(clip: ClipData, targets: readonly CurveTarget[], spec: CurveSpec): ClipData {
  const next = structuredClone(clip);
  for (const target of targets) {
    for (const keys of keysOf(next, target)) {
      const key = keys.find((k) => Math.abs(k.time - target.time) < KEY_EPSILON);
      if (key) key.curve = Array.isArray(spec) ? [...spec] : spec;
    }
  }
  return next;
}

/** y (0..1 of the value change) for x (0..1 of the span) on a cubic bezier through (0,0), (cx1,cy1), (cx2,cy2), (1,1). */
export function bezierAt(spec: Bezier, x: number): number {
  const [x1, y1, x2, y2] = spec;
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}
