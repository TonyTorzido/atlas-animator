/*
 * Atlas Animator editor: original implementation.
 *
 * Graph editor model (pure): value-over-time curves per channel of a bone (rotate, translate x / y,
 * scale x / y, shear x / y). The `atlas-anim@1` format already allows a key's `curve` to be one spec for
 * every channel or an object per channel (`{ x, y }`; missing = linear), so no format change is needed:
 * a vector key whose x and y ease differently is written as `curve: { x: [...], y: [...] }`, and a key
 * whose channels ease the same stays a single spec (the collapse below keeps old files byte-identical).
 * A curve shapes the move from its key to the next one; x is the fraction of the time span, y the
 * fraction of the value change (CSS-like cubic bezier), so a bezier handle sits at
 * (t0 + cx * dt, v0 + cy * dv).
 */
import type { ClipData, CurveSpec } from "@atlas-animator/core/core";
import { KEY_EPSILON } from "./clipModel.js";
import { bezierAt, type Bezier } from "./curveModel.js";

export type GraphTimeline = "rotate" | "translate" | "scale" | "shear";
export type GraphChannelId = "rotate" | "translateX" | "translateY" | "scaleX" | "scaleY" | "shearX" | "shearY";

export interface GraphChannel {
  id: GraphChannelId;
  label: string;
  timeline: GraphTimeline;
  /** Which value of the key: `value` (rotate), or `x` / `y` of a vector key. */
  comp: "value" | "x" | "y";
  color: string;
}

export const GRAPH_CHANNELS: readonly GraphChannel[] = [
  { id: "rotate", label: "Rotate", timeline: "rotate", comp: "value", color: "#f0b84a" },
  { id: "translateX", label: "Move X", timeline: "translate", comp: "x", color: "#ff7a7a" },
  { id: "translateY", label: "Move Y", timeline: "translate", comp: "y", color: "#6bd68f" },
  { id: "scaleX", label: "Scale X", timeline: "scale", comp: "x", color: "#c39bff" },
  { id: "scaleY", label: "Scale Y", timeline: "scale", comp: "y", color: "#5fd6e0" },
  { id: "shearX", label: "Shear X", timeline: "shear", comp: "x", color: "#ff9f5f" },
  { id: "shearY", label: "Shear Y", timeline: "shear", comp: "y", color: "#e08fc0" }
];

export const channelById = (id: GraphChannelId): GraphChannel => GRAPH_CHANNELS.find((c) => c.id === id)!;

/** One key of one channel. `curve` is the easing of that channel from this key to the next. */
export interface GraphKey {
  time: number;
  value: number;
  curve: CurveSpec;
}

type RawKey = { time: number; value?: number; x?: number; y?: number; curve?: unknown };

const r4 = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
};

function rawKeys(clip: ClipData, bone: string, ch: GraphChannel): RawKey[] | undefined {
  return clip.bones[bone]?.[ch.timeline] as RawKey[] | undefined;
}

/** The curve a raw key's `curve` field gives one component (a per-channel object: its entry, or linear). */
export function curveForComp(curve: unknown, comp: GraphChannel["comp"]): CurveSpec {
  if (curve === undefined || curve === null) return "linear";
  if (typeof curve === "string" || Array.isArray(curve)) return curve as CurveSpec;
  return (curve as Record<string, CurveSpec | undefined>)[comp] ?? "linear";
}

export function hasChannel(clip: ClipData, bone: string, id: GraphChannelId): boolean {
  return !!rawKeys(clip, bone, channelById(id))?.length;
}

/** The channels a bone has keys for. */
export function boneChannels(clip: ClipData, bone: string): GraphChannelId[] {
  return GRAPH_CHANNELS.filter((c) => hasChannel(clip, bone, c.id)).map((c) => c.id);
}

/** Keys of one channel of a bone, in time order. */
export function channelKeys(clip: ClipData, bone: string, id: GraphChannelId): GraphKey[] {
  const ch = channelById(id);
  return (rawKeys(clip, bone, ch) ?? []).map((k) => ({ time: k.time, value: ch.comp === "value" ? (k.value ?? 0) : (k[ch.comp] ?? 0), curve: curveForComp(k.curve, ch.comp) }));
}

/** Value of the move from key `a` to key `b` at time `t` (a <= t <= b). */
export function sampleSegment(a: GraphKey, b: GraphKey, t: number): number {
  const dt = b.time - a.time;
  if (dt <= 0) return b.value;
  const u = Math.min(1, Math.max(0, (t - a.time) / dt));
  if (a.curve === "stepped") return u >= 1 ? b.value : a.value;
  const f = a.curve === "linear" ? u : bezierAt(a.curve as Bezier, u);
  return a.value + (b.value - a.value) * f;
}

/** Value of a channel's curve at `t` (held before the first and after the last key). */
export function sampleChannel(keys: readonly GraphKey[], t: number): number | undefined {
  if (!keys.length) return undefined;
  if (t <= keys[0]!.time) return keys[0]!.value;
  const last = keys[keys.length - 1]!;
  if (t >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) if (t <= keys[i + 1]!.time) return sampleSegment(keys[i]!, keys[i + 1]!, t);
  return last.value;
}

function findKey(keys: RawKey[], time: number): RawKey | undefined {
  return keys.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
}

/** Sets the value of one channel of the key at `time` (the other channel of a vector key is untouched). Returns `clip` itself when there is no such key. */
export function setChannelValue(clip: ClipData, bone: string, id: GraphChannelId, time: number, value: number): ClipData {
  const ch = channelById(id);
  if (!findKey(rawKeys(clip, bone, ch) ?? [], time)) return clip;
  const next = structuredClone(clip);
  const key = findKey(rawKeys(next, bone, ch)!, time)!;
  key[ch.comp === "value" ? "value" : ch.comp] = r4(value);
  return next;
}

/** Collapses a per-channel curve object: all channels equal -> one spec; all linear -> "linear". */
function normalizeCurve(curve: Record<string, CurveSpec | undefined>, comps: readonly string[]): unknown {
  const specs = comps.map((c) => curve[c] ?? "linear");
  const same = specs.every((s) => JSON.stringify(s) === JSON.stringify(specs[0]));
  if (same) return Array.isArray(specs[0]) ? [...(specs[0] as number[])] : specs[0];
  const out: Record<string, CurveSpec> = {};
  comps.forEach((c, i) => {
    out[c] = Array.isArray(specs[i]) ? ([...(specs[i] as number[])] as unknown as CurveSpec) : specs[i]!;
  });
  return out;
}

/**
 * Sets the easing of one channel of the key at `time`. A rotate key takes the spec directly; a vector
 * key keeps the other component's easing (a single spec becomes `{ x, y }` while they differ and
 * collapses back when they match). Returns `clip` itself when there is no such key.
 */
export function setChannelCurve(clip: ClipData, bone: string, id: GraphChannelId, time: number, spec: CurveSpec): ClipData {
  const ch = channelById(id);
  if (!findKey(rawKeys(clip, bone, ch) ?? [], time)) return clip;
  const next = structuredClone(clip);
  const key = findKey(rawKeys(next, bone, ch)!, time)!;
  const copy = (s: CurveSpec): CurveSpec => (Array.isArray(s) ? ([...s] as unknown as CurveSpec) : s);
  if (ch.comp === "value") {
    key.curve = copy(spec);
    return next;
  }
  const other = ch.comp === "x" ? "y" : "x";
  key.curve = normalizeCurve({ [ch.comp]: copy(spec), [other]: curveForComp(key.curve, other) }, ["x", "y"]);
  return next;
}

/** Retimes nothing: rewrites the value and easing of a key at once (a handle or key drag in one step). */
export function setChannelKey(clip: ClipData, bone: string, id: GraphChannelId, time: number, value: number, spec?: CurveSpec): ClipData {
  let next = setChannelValue(clip, bone, id, time, value);
  if (spec !== undefined) next = setChannelCurve(next, bone, id, time, spec);
  return next;
}

/** An equivalent bezier of any spec (linear -> the 1/3, 2/3 line, a bezier stays; stepped has none). */
export function toBezier(spec: CurveSpec): [number, number, number, number] | null {
  if (spec === "stepped") return null;
  if (spec === "linear") return [0.3333, 0.3333, 0.6667, 0.6667];
  const [a, b, c, d] = spec as Bezier;
  return [a, b, c, d];
}

export interface HandlePoint {
  t: number;
  v: number;
}

/** Bezier handles of the segment a -> b in time/value space, or null when the segment is not a bezier. */
export function segmentHandles(a: GraphKey, b: GraphKey): { h1: HandlePoint; h2: HandlePoint } | null {
  if (!Array.isArray(a.curve)) return null;
  const [x1, y1, x2, y2] = a.curve as Bezier;
  const dt = b.time - a.time;
  const dv = b.value - a.value;
  return { h1: { t: a.time + x1 * dt, v: a.value + y1 * dv }, h2: { t: a.time + x2 * dt, v: a.value + y2 * dv } };
}

/**
 * The bezier for segment a -> b after moving handle 1 or 2 to (t, v). x clamps to 0..1 of the span (the
 * format keeps time monotonic), y is free (overshoot). With a flat segment (no value change) y cannot be
 * recovered from a value, so the old y is kept.
 */
export function dragHandle(a: GraphKey, b: GraphKey, which: 1 | 2, p: HandlePoint): CurveSpec | null {
  const cur = toBezier(a.curve);
  if (!cur) return null;
  const dt = b.time - a.time;
  const dv = b.value - a.value;
  if (dt <= 0) return null;
  const cx = Math.min(1, Math.max(0, (p.t - a.time) / dt));
  const cy = Math.abs(dv) < 1e-9 ? (which === 1 ? cur[1] : cur[3]) : (p.v - a.value) / dv;
  const out: [number, number, number, number] = which === 1 ? [cx, cy, cur[2], cur[3]] : [cur[0], cur[1], cx, cy];
  return out.map(r4) as unknown as CurveSpec;
}

export interface GraphBounds {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
}

/**
 * The time/value window that frames the given curves: the whole clip in time, the sampled min / max (so
 * overshoot shows) padded by 8% in value. A flat or empty set gets a window around its value (or 0).
 */
export function frameBounds(clip: ClipData, items: readonly { bone: string; channel: GraphChannelId }[]): GraphBounds {
  let lo = Infinity;
  let hi = -Infinity;
  for (const { bone, channel } of items) {
    const keys = channelKeys(clip, bone, channel);
    for (let i = 0; i < keys.length; i++) {
      lo = Math.min(lo, keys[i]!.value);
      hi = Math.max(hi, keys[i]!.value);
      const next = keys[i + 1];
      if (!next) continue;
      for (let s = 1; s < 24; s++) {
        const v = sampleSegment(keys[i]!, next, keys[i]!.time + ((next.time - keys[i]!.time) * s) / 24);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = -1;
    hi = 1;
  }
  const span = hi - lo;
  const pad = span < 1e-6 ? Math.max(1, Math.abs(lo) * 0.1) : span * 0.08;
  return { t0: 0, t1: Math.max(clip.duration, 1e-3), v0: lo - pad, v1: hi + pad };
}

/** Zooms a window about a point (fractions 0..1 of the window) by `factor` (< 1 zooms in) along time and / or value. */
export function zoomBounds(b: GraphBounds, factor: { t?: number; v?: number }, about: { t: number; v: number } = { t: 0.5, v: 0.5 }): GraphBounds {
  const ft = factor.t ?? 1;
  const fv = factor.v ?? 1;
  const at = b.t0 + (b.t1 - b.t0) * about.t;
  const av = b.v0 + (b.v1 - b.v0) * about.v;
  return { t0: at - (at - b.t0) * ft, t1: at + (b.t1 - at) * ft, v0: av - (av - b.v0) * fv, v1: av + (b.v1 - av) * fv };
}

/** Nice grid step (1, 2, 5 x 10^n) giving about `target` lines across `span`. */
export function gridStep(span: number, target: number): number {
  const raw = Math.max(span, 1e-9) / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

// ---------------------------------------------------------------------------------------------
// Shape keys: the deform "amount" curve
// ---------------------------------------------------------------------------------------------

type DeformKeyRaw = ClipData["deform"][string][string][string][number];

/** The largest vertex offset a deform key carries (px): its (x, y) pairs' length, maximised. Zero for an empty key. */
export function deformAmount(key: Pick<DeformKeyRaw, "vertices">): number {
  let max = 0;
  for (let i = 0; i + 1 < key.vertices.length; i += 2) max = Math.max(max, Math.hypot(key.vertices[i]!, key.vertices[i + 1]!));
  return r4(max);
}

/**
 * A mesh's deform timeline as one graph curve: a key's value is its amount (see `deformAmount`), its curve the key's own. A deform key has
 * one curve for the whole vertex set, so there is a single curve per mesh, not one per vertex.
 */
export function deformAmountKeys(clip: ClipData, skin: string, slot: string, attachment: string): GraphKey[] {
  return (clip.deform[skin]?.[slot]?.[attachment] ?? []).map((k) => ({ time: k.time, value: deformAmount(k), curve: curveForComp(k.curve, "value") }));
}

/** Sets the easing of the deform key at `time` (the move from it to the next key). Returns `clip` itself when there is no such key. */
export function setDeformCurve(clip: ClipData, skin: string, slot: string, attachment: string, time: number, spec: CurveSpec): ClipData {
  const keys = clip.deform[skin]?.[slot]?.[attachment];
  if (!keys?.some((k) => Math.abs(k.time - time) < KEY_EPSILON)) return clip;
  const next = structuredClone(clip);
  const key = next.deform[skin]![slot]![attachment]!.find((k) => Math.abs(k.time - time) < KEY_EPSILON)!;
  key.curve = Array.isArray(spec) ? ([...spec] as unknown as CurveSpec) : spec;
  return next;
}

// ---------------------------------------------------------------------------------------------
// Tangents (Batch 6, ): smooth / flat / auto at a key, and linked or broken handles
// ---------------------------------------------------------------------------------------------

export type TangentMode = "smooth" | "flat" | "auto";

/** Slope (value per second) a tangent mode gives at key `i` of a channel. */
function tangentSlope(keys: readonly GraphKey[], i: number, mode: TangentMode): number {
  if (mode === "flat") return 0;
  const k = keys[i]!;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  const seg = (a: GraphKey, b: GraphKey) => (b.time - a.time > 1e-9 ? (b.value - a.value) / (b.time - a.time) : 0);
  let slope: number;
  if (prev && next) slope = (next.value - prev.value) / Math.max(1e-9, next.time - prev.time);
  else if (next) slope = seg(k, next);
  else if (prev) slope = seg(prev, k);
  else slope = 0;
  if (mode === "auto") {
    // Auto never overshoots: a turning point is flat, and the slope never exceeds three times either neighbouring segment's slope.
    const sIn = prev ? seg(prev, k) : slope;
    const sOut = next ? seg(k, next) : slope;
    if (sIn * sOut <= 0) return 0;
    const cap = 3 * Math.min(Math.abs(sIn), Math.abs(sOut));
    return Math.sign(slope) * Math.min(Math.abs(slope), cap);
  }
  return slope;
}

/** Bezier of segment a -> b with the given end slopes (x handles stay where they are, 1/3 and 2/3 when the segment was not a bezier). */
function withSlopes(a: GraphKey, b: GraphKey, slopeOut: number | null, slopeIn: number | null): CurveSpec | null {
  const cur = toBezier(a.curve);
  if (!cur) return null;
  const dt = b.time - a.time;
  const dv = b.value - a.value;
  if (dt <= 0) return null;
  const [x1, , x2] = cur;
  let y1 = cur[1];
  let y2 = cur[3];
  if (Math.abs(dv) < 1e-9) {
    // No value change to measure against: flat handles are the only meaningful reading (an overshoot needs a breakdown key).
    if (slopeOut !== null) y1 = 0;
    if (slopeIn !== null) y2 = 1;
  } else {
    if (slopeOut !== null) y1 = (slopeOut * x1 * dt) / dv;
    if (slopeIn !== null) y2 = 1 - (slopeIn * (1 - x2) * dt) / dv;
  }
  return [x1, y1, x2, y2].map(r4) as unknown as CurveSpec;
}

/**
 * Sets the tangent at the key at `time` of one channel: the outgoing segment's first handle and the incoming segment's second handle both
 * take the slope the mode gives (flat = 0, smooth = through the neighbours, auto = smooth without overshoot). Stepped segments are left
 * alone. Returns `clip` itself when nothing changed.
 */
export function setTangent(clip: ClipData, bone: string, id: GraphChannelId, time: number, mode: TangentMode): ClipData {
  const keys = channelKeys(clip, bone, id);
  const i = keys.findIndex((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (i < 0) return clip;
  const slope = tangentSlope(keys, i, mode);
  let next = clip;
  const out = keys[i + 1] ? withSlopes(keys[i]!, keys[i + 1]!, slope, null) : null;
  if (out) next = setChannelCurve(next, bone, id, keys[i]!.time, out);
  const prev = keys[i - 1];
  const inn = prev ? withSlopes(prev, keys[i]!, null, slope) : null;
  if (inn && prev) next = setChannelCurve(next, bone, id, prev.time, inn);
  return next;
}

/**
 * Linked handles: after one handle of the key at `time` moved, makes the handle on the other side of that key collinear with it (same
 * slope). `moved` names the dragged side: "out" is the outgoing segment's first handle, "in" the incoming segment's second one.
 */
export function linkHandles(clip: ClipData, bone: string, id: GraphChannelId, time: number, moved: "in" | "out"): ClipData {
  const keys = channelKeys(clip, bone, id);
  const i = keys.findIndex((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (i < 0) return clip;
  const k = keys[i]!;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (!prev || !next || !Array.isArray(prev.curve) || !Array.isArray(k.curve)) return clip;
  if (moved === "out") {
    const [x1, y1] = k.curve as Bezier;
    const dt = next.time - k.time;
    const dv = next.value - k.value;
    if (x1 < 1e-6 || Math.abs(dv) < 1e-9) return clip;
    const spec = withSlopes(prev, k, null, (y1 * dv) / (x1 * dt));
    return spec ? setChannelCurve(clip, bone, id, prev.time, spec) : clip;
  }
  const [, , x2, y2] = prev.curve as Bezier;
  const dt = k.time - prev.time;
  const dv = k.value - prev.value;
  if (1 - x2 < 1e-6 || Math.abs(dv) < 1e-9) return clip;
  const spec = withSlopes(k, next, ((1 - y2) * dv) / ((1 - x2) * dt), null);
  return spec ? setChannelCurve(clip, bone, id, k.time, spec) : clip;
}
