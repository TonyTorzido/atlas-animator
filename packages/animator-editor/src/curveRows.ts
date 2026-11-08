/*
 * Atlas Animator editor: original implementation.
 *
 * Curves inside the dopesheet (pure): the mini value curves a bone row shows when it is expanded, and the easing presets a click on one
 * segment of a curve can set. A segment is the move from one key of a channel to the next; its easing lives on the first key, so the
 * edit is the graph editor's own `setChannelCurve` and the two views never disagree.
 */
import type { ClipData, CurveSpec } from "@atlas-animator/core/core";
import { KEY_EPSILON } from "./clipModel.js";
import { rowBone, type RowId } from "./dopesheetModel.js";
import { bezierAt, type Bezier } from "./curveModel.js";
import { boneChannels, channelKeys, sampleSegment, setChannelCurve, type GraphChannelId, type GraphKey } from "./graphModel.js";

/** The channels the dopesheet draws curves for (scale and shear stay in the graph panel). */
export const CURVE_ROW_CHANNELS: readonly GraphChannelId[] = ["rotate", "translateX", "translateY"];

export type SegPresetId = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "stepped" | "bounce";

export const SEG_PRESETS: readonly { id: SegPresetId; label: string; hint: string; spec: CurveSpec }[] = [
  { id: "linear", label: "Linear", hint: "Constant speed", spec: "linear" },
  { id: "ease-in", label: "Ease in", hint: "Starts slow, ends fast", spec: [0.42, 0, 1, 1] },
  { id: "ease-out", label: "Ease out", hint: "Starts fast, settles slowly", spec: [0, 0, 0.58, 1] },
  { id: "ease-in-out", label: "Ease both", hint: "Slow at both ends", spec: [0.42, 0, 0.58, 1] },
  { id: "stepped", label: "Stepped", hint: "Holds the pose, then jumps at the next key", spec: "stepped" },
  { id: "bounce", label: "Bounce", hint: "Overshoots the next pose by about 15% and settles back", spec: [0.34, 1.56, 0.64, 1] }
];

const sameSpec = (a: CurveSpec, b: CurveSpec): boolean => (Array.isArray(a) && Array.isArray(b) ? a.every((v, i) => Math.abs(v - (b as Bezier)[i]!) < 1e-6) : a === b);

/** Which preset a curve is, or null for hand-tuned control points. */
export function presetOf(spec: CurveSpec): SegPresetId | null {
  return SEG_PRESETS.find((p) => sameSpec(p.spec, spec))?.id ?? null;
}

/** One segment of one channel: the key at `time` and the move to the key after it. */
export interface SegRef {
  bone: string;
  channel: GraphChannelId;
  time: number;
}

export const sameSeg = (a: SegRef, b: SegRef): boolean => a.bone === b.bone && a.channel === b.channel && Math.abs(a.time - b.time) < KEY_EPSILON;
export const hasSeg = (list: readonly SegRef[], s: SegRef): boolean => list.some((x) => sameSeg(x, s));

/** The curve channels a bone has keys for, in row order. */
export function curveChannelsOf(clip: ClipData, bone: string): GraphChannelId[] {
  const have = new Set(boneChannels(clip, bone));
  return CURVE_ROW_CHANNELS.filter((c) => have.has(c));
}

export interface Segment {
  ref: SegRef;
  a: GraphKey;
  b: GraphKey;
}

/** Every segment of a channel (n keys give n - 1). */
export function segmentsOf(clip: ClipData, bone: string, channel: GraphChannelId): Segment[] {
  const keys = channelKeys(clip, bone, channel);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < keys.length; i++) out.push({ ref: { bone, channel, time: keys[i]!.time }, a: keys[i]!, b: keys[i + 1]! });
  return out;
}

/** The segment that holds `time` (between its two keys), or null before the first and after the last key. */
export function segmentAt(clip: ClipData, bone: string, channel: GraphChannelId, time: number): Segment | null {
  return segmentsOf(clip, bone, channel).find((s) => time >= s.a.time - KEY_EPSILON && time <= s.b.time + KEY_EPSILON) ?? null;
}

/** The value range a channel's curve covers (overshoot included), padded a little so the line never touches the row edge. */
export function curveRange(clip: ClipData, bone: string, channel: GraphChannelId): { lo: number; hi: number } {
  const keys = channelKeys(clip, bone, channel);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < keys.length; i++) {
    lo = Math.min(lo, keys[i]!.value);
    hi = Math.max(hi, keys[i]!.value);
    const next = keys[i + 1];
    if (next && Array.isArray(keys[i]!.curve)) {
      for (let k = 1; k < 12; k++) {
        const v = sampleSegment(keys[i]!, next, keys[i]!.time + ((next.time - keys[i]!.time) * k) / 12);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) return { lo: -1, hi: 1 };
  if (hi - lo < 1e-6) return { lo: lo - 1, hi: hi + 1 };
  const pad = (hi - lo) * 0.1;
  return { lo: lo - pad, hi: hi + pad };
}

/** Points (t, value) along one segment: a stepped segment is a hold and a jump; a linear one two points; the rest are sampled `n` times. */
export function segmentPoints(s: Segment, n: number): { t: number; v: number }[] {
  if (s.a.curve === "stepped") return [{ t: s.a.time, v: s.a.value }, { t: s.b.time, v: s.a.value }, { t: s.b.time, v: s.b.value }];
  if (s.a.curve === "linear") return [{ t: s.a.time, v: s.a.value }, { t: s.b.time, v: s.b.value }];
  const out: { t: number; v: number }[] = [];
  const steps = Math.max(2, Math.round(n));
  for (let i = 0; i <= steps; i++) {
    const t = s.a.time + ((s.b.time - s.a.time) * i) / steps;
    out.push({ t, v: sampleSegment(s.a, s.b, t) });
  }
  return out;
}

/** Points of a preset's unit curve (x, y in 0..1, y may leave it), for the picker thumbnails. */
export function presetPoints(spec: CurveSpec, n = 24): { x: number; y: number }[] {
  if (spec === "stepped") return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  if (spec === "linear") return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  return Array.from({ length: n + 1 }, (_, i) => ({ x: i / n, y: bezierAt(spec as Bezier, i / n) }));
}

/** The segments (all curve channels) that start at the selected bone-row keys of the dopesheet. */
export function segmentsOfKeys(clip: ClipData, keys: readonly { row: string; time: number }[]): SegRef[] {
  const out: SegRef[] = [];
  for (const k of keys) {
    const bone = rowBone(k.row as RowId);
    if (!bone) continue;
    for (const ch of curveChannelsOf(clip, bone)) {
      const seg = segmentsOf(clip, bone, ch).find((s) => Math.abs(s.ref.time - k.time) < KEY_EPSILON);
      if (seg && !hasSeg(out, seg.ref)) out.push(seg.ref);
    }
  }
  return out;
}

/** Sets one easing on every listed segment (one new clip; segments that no longer exist are skipped). */
export function applySegmentPreset(clip: ClipData, segs: readonly SegRef[], spec: CurveSpec): ClipData {
  let next = clip;
  for (const s of segs) next = setChannelCurve(next, s.bone, s.channel, s.time, spec);
  return next;
}

/** The easing of a segment as the graph editor reads it (a per-channel curve object gives that channel's entry); linear when the key is gone. */
export function segmentCurve(clip: ClipData, s: SegRef): CurveSpec {
  const k = channelKeys(clip, s.bone, s.channel).find((x) => Math.abs(x.time - s.time) < KEY_EPSILON);
  return k ? k.curve : "linear";
}
