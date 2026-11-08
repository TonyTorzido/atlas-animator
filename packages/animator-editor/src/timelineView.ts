/*
 * Atlas Animator editor: original implementation.
 *
 * Timeline view maths (pure): the visible frame window (zoom / pan / fit), frame <-> pixel mapping, label spacing that
 * stays readable at every zoom, and the key-type palette shared by the dopesheet and the canvas key dots.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON } from "./clipModel.js";

/** What a key is, for colouring: one colour per type, on the dopesheet diamonds and the canvas key dots. */
export type KeyType = "rotate" | "translate" | "scaleShear" | "ik" | "attachment" | "drawOrder" | "event" | "color" | "transform" | "path" | "physics" | "deform" | "sequence";

export const KEY_TYPES: readonly KeyType[] = ["rotate", "translate", "scaleShear", "ik", "attachment", "drawOrder", "event", "color", "transform", "path", "physics", "deform", "sequence"];

export const KEY_TYPE_LABEL: Record<KeyType, string> = {
  rotate: "Rotate",
  translate: "Translate",
  scaleShear: "Scale / shear",
  ik: "IK mix",
  attachment: "Attachment swap",
  drawOrder: "Draw order",
  event: "Event",
  color: "Slot colour / alpha",
  transform: "Transform mix",
  path: "Path constraint",
  physics: "Physics mix",
  deform: "Shape keys",
  sequence: "Image sequence"
};

/** CSS colours (2D canvas); `keyColorHex` gives the same colour as 0xRRGGBB for Pixi. */
export const KEY_COLOR: Record<KeyType, string> = {
  rotate: "#5fb3ff",
  translate: "#6bd68f",
  scaleShear: "#c58bff",
  ik: "#ff7ac8",
  attachment: "#2fd6c8",
  drawOrder: "#ff9a3c",
  event: "#ff6b6b",
  color: "#f2d34f",
  transform: "#8fa8ff",
  path: "#ff9f40",
  physics: "#a3e635",
  deform: "#e879f9",
  sequence: "#38bdf8"
};

export const keyColorHex = (t: KeyType): number => parseInt(KEY_COLOR[t].slice(1), 16);

type BoneChannel = "rotate" | "translate" | "scale" | "shear";

/** The key type a bone channel belongs to. */
export function channelKeyType(channel: BoneChannel): KeyType {
  return channel === "rotate" ? "rotate" : channel === "translate" ? "translate" : "scaleShear";
}

/** The key types a bone has a key of at `time` (in KEY_TYPES order), for the canvas key dots. */
export function boneKeyTypesAt(clip: Pick<ClipData, "bones">, bone: string, time: number): KeyType[] {
  const tl = clip.bones[bone];
  if (!tl) return [];
  const has = (keys: readonly { time: number }[] | undefined) => !!keys?.some((k) => Math.abs(k.time - time) < KEY_EPSILON);
  const out: KeyType[] = [];
  if (has(tl.rotate)) out.push("rotate");
  if (has(tl.translate)) out.push("translate");
  if (has(tl.scale) || has(tl.shear)) out.push("scaleShear");
  return out;
}

/** A bone's keys grouped by type (rotate, translate, scale+shear) with the sorted unique times of each. */
export function boneChannelTimes(clip: Pick<ClipData, "bones">, bone: string): { type: KeyType; channels: BoneChannel[]; times: number[] }[] {
  const tl = clip.bones[bone];
  if (!tl) return [];
  const groups: { type: KeyType; channels: BoneChannel[] }[] = [
    { type: "rotate", channels: ["rotate"] },
    { type: "translate", channels: ["translate"] },
    { type: "scaleShear", channels: ["scale", "shear"] }
  ];
  const out: { type: KeyType; channels: BoneChannel[]; times: number[] }[] = [];
  for (const g of groups) {
    const times: number[] = [];
    for (const ch of g.channels) for (const k of tl[ch] ?? []) if (!times.some((t) => Math.abs(t - k.time) < KEY_EPSILON)) times.push(k.time);
    if (times.length) out.push({ ...g, times: times.sort((a, b) => a - b) });
  }
  return out;
}

/** The visible window of the timeline: first visible frame (can be fractional) and how many frames fit across. */
export interface TlView {
  start: number;
  span: number;
}

/** Fewest frames shown at full zoom, so a diamond never fills the screen. */
export const MIN_SPAN = 4;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Whole clip in view. */
export function fitView(frames: number): TlView {
  return { start: 0, span: Math.max(1, frames) };
}

/** Keeps the view sane: span between MIN_SPAN and the clip, start so the window stays over the clip. */
export function clampView(view: TlView, frames: number): TlView {
  const n = Math.max(1, frames);
  const span = clamp(view.span, Math.min(MIN_SPAN, n), n);
  const start = clamp(view.start, 0, Math.max(0, n - span));
  return { start, span };
}

/** Zooms by `factor` (> 1 zooms in) keeping `anchorFrame` under the same screen position. */
export function zoomView(view: TlView, factor: number, anchorFrame: number, frames: number): TlView {
  const n = Math.max(1, frames);
  const span = clamp(view.span / factor, Math.min(MIN_SPAN, n), n);
  const t = view.span > 0 ? (anchorFrame - view.start) / view.span : 0;
  return clampView({ start: anchorFrame - t * span, span }, frames);
}

/** Pans by `frames` (positive moves the window later). */
export function panView(view: TlView, frames: number, total: number): TlView {
  return clampView({ start: view.start + frames, span: view.span }, total);
}

/** Zoom slider position (0 = whole clip, 1 = max zoom), log scaled so equal slider steps are equal zoom steps. */
export function zoomToSlider(view: TlView, frames: number): number {
  const n = Math.max(1, frames);
  const min = Math.min(MIN_SPAN, n);
  if (n <= min) return 0;
  return clamp(Math.log(n / view.span) / Math.log(n / min), 0, 1);
}

export function sliderToSpan(slider: number, frames: number): number {
  const n = Math.max(1, frames);
  const min = Math.min(MIN_SPAN, n);
  return n / Math.exp(clamp(slider, 0, 1) * Math.log(n / min));
}

/** Frame -> x for a key area starting at `left` and `width` pixels wide. */
export function frameToX(view: TlView, frame: number, left: number, width: number): number {
  return left + ((frame - view.start) / view.span) * width;
}

export function xToFrameFloat(view: TlView, x: number, left: number, width: number): number {
  return view.start + ((x - left) / width) * view.span;
}

/**
 * Frames between two numbered ruler ticks so the numbers stay at least `minPx` apart at the current zoom:
 * the smallest "nice" step (1, 2, 5, 10, 15, 30, 60, ...) that leaves enough room.
 */
export function labelStep(pxPerFrame: number, minPx = 42): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * pxPerFrame >= minPx) return s;
  return steps[steps.length - 1]!;
}
