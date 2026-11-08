/*
 * Atlas Animator editor: original implementation.
 *
 * Arc overlay maths (pure): the path of a bone or point across the clip, one sample per frame, and the numbers that say
 * whether it is a curve (not a straight line) and whether the spacing between frames is uneven (held, slow, fast).
 * Sampling the posed skeleton is the editor's job (main.ts); this module classifies what it gets back.
 */
export interface ArcPoint {
  frame: number;
  x: number;
  y: number;
}

export type StepClass = "hold" | "slow" | "even" | "fast";

export interface ArcStats {
  frames: number;
  /** Path length (skeleton px). */
  length: number;
  /** Straight distance from the first to the last point. */
  chord: number;
  /** Largest distance of any point from the chord, as a fraction of the chord (0 = a straight line). */
  bulge: number;
  /** Distance travelled between consecutive samples (steps[i] runs from points[i] to points[i + 1]). */
  steps: number[];
  /** Median of the non-zero steps. */
  median: number;
  /** Step i divided by the median. */
  ratios: number[];
  classes: StepClass[];
  /** Frame numbers (of the step's first sample) whose step is a hold, slow or fast. */
  uneven: number[];
  /** Largest step over the median (1 = perfectly even). */
  peakRatio: number;
}

/** A target on the posed skeleton: a bone origin, a bone tip, or the first point attachment of a slot. */
export type ArcTarget = { kind: "bone"; name: string } | { kind: "tip"; name: string } | { kind: "point"; slot: string };

export function parseArcTarget(spec: string): ArcTarget | null {
  const at = spec.indexOf(":");
  if (at < 0) return null;
  const kind = spec.slice(0, at);
  const name = spec.slice(at + 1);
  if (!name) return null;
  if (kind === "bone") return { kind: "bone", name };
  if (kind === "tip") return { kind: "tip", name };
  if (kind === "point") return { kind: "point", slot: name };
  return null;
}

export const arcTargetSpec = (t: ArcTarget): string => (t.kind === "point" ? `point:${t.slot}` : `${t.kind}:${t.name}`);

/** Thresholds against the median step: below HOLD it reads as a hold, below SLOW it eases, above FAST it snaps. */
export const HOLD_RATIO = 0.15;
export const SLOW_RATIO = 0.6;
export const FAST_RATIO = 1.7;

const dist = (a: ArcPoint, b: ArcPoint) => Math.hypot(b.x - a.x, b.y - a.y);

export function classifyStep(ratio: number): StepClass {
  return ratio < HOLD_RATIO ? "hold" : ratio < SLOW_RATIO ? "slow" : ratio > FAST_RATIO ? "fast" : "even";
}

export function arcStats(points: readonly ArcPoint[]): ArcStats {
  const steps: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) steps.push(dist(points[i]!, points[i + 1]!));
  const length = steps.reduce((a, b) => a + b, 0);
  const moving = steps.filter((s) => s > 1e-6).sort((a, b) => a - b);
  const median = moving.length ? (moving.length % 2 ? moving[(moving.length - 1) / 2]! : (moving[moving.length / 2 - 1]! + moving[moving.length / 2]!) / 2) : 0;
  const ratios = steps.map((s) => (median > 0 ? s / median : 0));
  const classes = ratios.map(classifyStep);
  const first = points[0];
  const last = points[points.length - 1];
  const chord = first && last ? dist(first, last) : 0;
  let bulge = 0;
  if (first && last && points.length > 2) {
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const len = Math.hypot(dx, dy);
    for (const p of points) {
      // Distance from the chord line, or from the start when the path closes on itself.
      const d = len > 1e-6 ? Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) / len : dist(first, p);
      bulge = Math.max(bulge, d);
    }
    bulge = bulge / Math.max(1e-6, len > 1e-6 ? len : length / 2);
  }
  const uneven = points.flatMap((p, i) => (i < classes.length && classes[i] !== "even" ? [p.frame] : []));
  return { frames: points.length, length, chord, bulge, steps, median, ratios, classes, uneven, peakRatio: ratios.length ? Math.max(...ratios) : 0 };
}

/** The unit direction of travel at sample i (central difference; one-sided at the ends), or null when the path stands still there. */
export function arcTangent(points: readonly ArcPoint[], i: number): { x: number; y: number } | null {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  if (!a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len > 1e-6 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : null;
}

/** A heat colour for a step ratio: blue for holds and slow steps, grey near the median, orange to red for fast steps. */
export function stepColor(ratio: number): number {
  const t = Math.max(0, Math.min(1, ratio / 2.4));
  const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
  const cold = [0x5f, 0xb3, 0xff] as const;
  const mid = [0xe8, 0xe8, 0xe8] as const;
  const hot = [0xff, 0x5a, 0x3c] as const;
  const from = t < 0.42 ? cold : mid;
  const to = t < 0.42 ? mid : hot;
  const k = t < 0.42 ? t / 0.42 : (t - 0.42) / 0.58;
  return (lerp(from[0], to[0], k) << 16) | (lerp(from[1], to[1], k) << 8) | lerp(from[2], to[2], k);
}
