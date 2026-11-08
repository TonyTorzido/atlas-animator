/*
 * Atlas Animator: original implementation.
 *
 * Key-to-key interpolation curves.
 *
 * A curve maps the fraction u of the time between two keys (0..1) to the fraction of the value
 * change applied at that moment:
 * - linear:  f(u) = u
 * - stepped: f(u) = 0 (the value holds until the next key)
 * - Bezier:  the cubic Bezier through (0, 0), (cx1, cy1), (cx2, cy2), (1, 1), read as a function
 *            y(x), the same normalisation as CSS cubic-bezier(). With cx1 and cx2 in 0..1 (the
 *            schema enforces it) x(s) never decreases, so y(x) is a function.
 *
 * Bezier evaluation: a cubic B(s) = 3(1-s)^2 s c1 + 3(1-s) s^2 c2 + s^3 in power form is
 * ((A s + B) s + C) s with A = 1 + 3 c1 - 3 c2, B = 3 c2 - 6 c1, C = 3 c1. To find y for a given
 * x we need s with x(s) = x. A table of x(s) at s = 0, 0.1, ..., 1 (10 segments) is built once
 * per key; sampling finds the segment holding x (the table is monotone), inverts it linearly as a
 * first guess, refines s with Newton steps kept inside the segment (bisecting when a step would
 * leave it), then evaluates y(s) exactly. Typical eases converge in one or two steps; the result
 * matches the exact curve to about 1e-6 (curves.test.ts compares against bisection).
 */
import type { CurveSpec } from "./format.js";

export const CURVE_LINEAR = 0;
export const CURVE_STEPPED = 1;
export const CURVE_BEZIER = 2;

/** Segments of the x(s) table. */
export const BEZIER_SEGMENTS = 10;
const TABLE = BEZIER_SEGMENTS + 1;
/** Floats per Bezier curve: cx1, cy1, cx2, cy2, then the x(s) table. */
const STRIDE = 4 + TABLE;

/**
 * Curves for every (key, channel) of one timeline: `fraction(key, channel, u)` is the eased
 * fraction between key `key` and key `key + 1`. Immutable after construction; allocation-free
 * sampling.
 */
export class CurveSet {
  readonly keyCount: number;
  readonly channels: number;
  private readonly kinds: Uint8Array;
  private readonly bezier: Float64Array;

  constructor(keyCount: number, channels: number) {
    this.keyCount = keyCount;
    this.channels = channels;
    this.kinds = new Uint8Array(keyCount * channels);
    this.bezier = new Float64Array(keyCount * channels * STRIDE);
  }

  set(key: number, channel: number, spec: CurveSpec): void {
    const slot = key * this.channels + channel;
    if (spec === "linear") this.kinds[slot] = CURVE_LINEAR;
    else if (spec === "stepped") this.kinds[slot] = CURVE_STEPPED;
    else {
      const [cx1, cy1, cx2, cy2] = spec;
      // A Bezier with its controls on the diagonal is exactly linear.
      if (cx1 === cy1 && cx2 === cy2) {
        this.kinds[slot] = CURVE_LINEAR;
        return;
      }
      this.kinds[slot] = CURVE_BEZIER;
      writeBezier(this.bezier, slot * STRIDE, cx1, cy1, cx2, cy2);
    }
  }

  kind(key: number, channel: number): number {
    return this.kinds[key * this.channels + channel] as number;
  }

  /** Eased fraction at u (0..1) of the span after `key`. */
  fraction(key: number, channel: number, u: number): number {
    const io = fractionScratch;
    io[0] = u;
    this.easeInPlace(key, channel, io);
    return io[0] as number;
  }

  /**
   * The playback form of fraction(): reads u from io[0] and writes the eased fraction back to
   * io[0]. Numbers passed through a typed array are never boxed, so the per-frame path allocates
   * nothing even where the engine does not inline this call.
   */
  easeInPlace(key: number, channel: number, io: Float64Array): void {
    const slot = key * this.channels + channel;
    const kind = this.kinds[slot];
    if (kind === CURVE_LINEAR) return;
    if (kind === CURVE_STEPPED) io[0] = 0;
    else sampleBezier(this.bezier, slot * STRIDE, io);
  }
}

const fractionScratch = new Float64Array(1);

/** Resolves a key's curve for one channel: a single spec, or a per-channel object (missing = linear). */
export function curveForChannel(curve: CurveSpec | Readonly<Record<string, CurveSpec | undefined>>, channel: string): CurveSpec {
  if (typeof curve === "string" || Array.isArray(curve)) return curve as CurveSpec;
  return (curve as Readonly<Record<string, CurveSpec | undefined>>)[channel] ?? "linear";
}

/** One-off evaluation of a curve spec at u (builds the table each call; for tools and tests). */
export function evaluateCurve(spec: CurveSpec, u: number): number {
  const set = new CurveSet(1, 1);
  set.set(0, 0, spec);
  return set.fraction(0, 0, Math.min(1, Math.max(0, u)));
}

function writeBezier(out: Float64Array, at: number, cx1: number, cy1: number, cx2: number, cy2: number): void {
  out[at] = cx1;
  out[at + 1] = cy1;
  out[at + 2] = cx2;
  out[at + 3] = cy2;
  for (let j = 0; j < TABLE; j++) out[at + 4 + j] = cubic(cx1, cx2, j / BEZIER_SEGMENTS);
  // Pin the ends exactly (the polynomial gives 1 up to rounding).
  out[at + 4] = 0;
  out[at + 4 + BEZIER_SEGMENTS] = 1;
}

/** One coordinate of the unit cubic Bezier with control values c1, c2 at parameter s. */
function cubic(c1: number, c2: number, s: number): number {
  const a = 1 + 3 * c1 - 3 * c2;
  const b = 3 * c2 - 6 * c1;
  const c = 3 * c1;
  return ((a * s + b) * s + c) * s;
}

/** Reads u from io[0] and writes y(u) of the Bezier stored at `at` to io[0]. */
function sampleBezier(data: Float64Array, at: number, io: Float64Array): void {
  const u = io[0] as number;
  if (u <= 0) {
    io[0] = 0;
    return;
  }
  if (u >= 1) {
    io[0] = 1;
    return;
  }
  const cx1 = data[at] as number;
  const cy1 = data[at + 1] as number;
  const cx2 = data[at + 2] as number;
  const cy2 = data[at + 3] as number;
  const table = at + 4;
  // First segment whose end reaches u (the table is non-decreasing and ends at 1 > u).
  let j = 0;
  while (j < BEZIER_SEGMENTS - 1 && (data[table + j + 1] as number) < u) j++;
  const x0 = data[table + j] as number;
  const x1 = data[table + j + 1] as number;
  const low = j / BEZIER_SEGMENTS;
  const high = (j + 1) / BEZIER_SEGMENTS;
  let s = x1 > x0 ? low + ((u - x0) / (x1 - x0)) * (high - low) : low;
  // Refine x(s) = u with Newton steps safeguarded by the bracket [low, high] (bisect when a step
  // would leave it). Usually one or two steps; near-flat spans of x(s) take a few more. The cubic
  // is written out in power form here (A, B, C as in the header) so no helper returns a number.
  const ax = 1 + 3 * cx1 - 3 * cx2;
  const bx = 3 * cx2 - 6 * cx1;
  const cx = 3 * cx1;
  let lo = low;
  let hi = high;
  for (let i = 0; i < 8; i++) {
    const error = ((ax * s + bx) * s + cx) * s - u;
    if (Math.abs(error) < 1e-9) break;
    if (error < 0) lo = s;
    else hi = s;
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    const next = slope > 1e-12 ? s - error / slope : Number.NaN;
    s = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  const ay = 1 + 3 * cy1 - 3 * cy2;
  const by = 3 * cy2 - 6 * cy1;
  const cy = 3 * cy1;
  io[0] = ((ay * s + by) * s + cy) * s;
}
