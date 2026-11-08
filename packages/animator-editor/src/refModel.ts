/*
 * Atlas Animator editor: reference video / image sequence underlay (pure, no DOM).
 *
 * A clip can have one reference: a local video (mp4 / webm) or a folder of numbered images, drawn behind the rig. The reference is
 * synced to the clip's timeline by an offset (in clip frames) and a speed; scrubbing the timeline picks the source frame exactly.
 * The reference path and transform are editor metadata, kept per clip in clips/refs.json next to board.json, never in the rig or the
 * clip file. This module holds the maths and the validation shared by the browser panel (refUnderlay.ts) and the dev-server API
 * (refsApi.ts).
 */

export type RefKind = "video" | "sequence";

export interface RefTransform {
  /** Rig units from the default spot (centred on the rig, feet on the ground line). */
  x: number;
  y: number;
  /** 1 = the figure height of the rig. */
  scale: number;
  opacity: number;
}

export interface RefMeta {
  kind: RefKind;
  /** Absolute path of the video file, or of the folder that holds the image sequence. */
  path: string;
  /** Frames per second of the source (a video is sought to the middle of the frame this implies). */
  fps: number;
  /** Clip frame at which the source's first frame plays. */
  offsetFrames: number;
  /** Source seconds per clip second (0.5 = half speed). */
  speed: number;
  transform: RefTransform;
  /** Trace mode: the reference at full opacity, the rig at half. */
  trace: boolean;
}

export const VIDEO_EXT = [".mp4", ".webm", ".m4v", ".mov", ".ogv"] as const;
export const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"] as const;
export const REF_SPEED_MIN = 0.05;
export const REF_SPEED_MAX = 8;
export const REF_SCALE_MIN = 0.05;
export const REF_SCALE_MAX = 8;
export const TRACE_RIG_ALPHA = 0.5;

export const DEFAULT_REF_TRANSFORM: RefTransform = { x: 0, y: 0, scale: 1, opacity: 0.5 };

const extOf = (path: string): string => {
  const m = /\.[A-Za-z0-9]+$/.exec(path);
  return m ? m[0].toLowerCase() : "";
};
export const isVideoPath = (path: string): boolean => (VIDEO_EXT as readonly string[]).includes(extOf(path));
export const isImagePath = (path: string): boolean => (IMAGE_EXT as readonly string[]).includes(extOf(path));

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A new reference with the defaults for its kind. */
export function newRef(kind: RefKind, path: string): RefMeta {
  return { kind, path, fps: 30, offsetFrames: 0, speed: 1, transform: { ...DEFAULT_REF_TRANSFORM }, trace: false };
}

/** Clamps every number into its range (the panel and the server both run this, so a hand-edited file cannot break the view). */
export function normalizeRef(m: RefMeta): RefMeta {
  return {
    kind: m.kind,
    path: m.path,
    fps: clamp(finite(m.fps, 30), 1, 240),
    offsetFrames: Math.round(finite(m.offsetFrames, 0)),
    speed: clamp(finite(m.speed, 1), REF_SPEED_MIN, REF_SPEED_MAX),
    transform: {
      x: finite(m.transform?.x, 0),
      y: finite(m.transform?.y, 0),
      scale: clamp(finite(m.transform?.scale, 1), REF_SCALE_MIN, REF_SCALE_MAX),
      opacity: clamp(finite(m.transform?.opacity, 0.5), 0, 1)
    },
    trace: m.trace === true
  };
}

/** Validates one parsed record; null when it is not a reference. */
export function parseRef(raw: unknown): RefMeta | null {
  const r = raw as Partial<RefMeta> | null;
  if (!r || typeof r !== "object") return null;
  if ((r.kind !== "video" && r.kind !== "sequence") || typeof r.path !== "string" || !r.path) return null;
  return normalizeRef(r as RefMeta);
}

export const REF_CLIP_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/;

/** The refs.json file: { [clip name]: RefMeta }. Entries that do not validate are dropped. */
export function parseRefStore(raw: unknown): Record<string, RefMeta> {
  const out: Record<string, RefMeta> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [clip, value] of Object.entries(raw)) {
    const meta = parseRef(value);
    if (meta && REF_CLIP_ID.test(clip)) out[clip] = meta;
  }
  return out;
}

/** Source seconds shown at clip time `clipTime`: before the offset the first frame holds; speed scales the rest. */
export function refTimeAt(meta: Pick<RefMeta, "offsetFrames" | "speed">, clipTime: number, clipFps: number): number {
  return Math.max(0, clipTime - meta.offsetFrames / clipFps) * meta.speed;
}

/** The source frame index for a source time, held on the last frame when `count` is known. */
export function refFrameIndex(refTime: number, srcFps: number, count?: number): number {
  const i = Math.max(0, Math.floor(refTime * srcFps + 1e-6));
  return count !== undefined && count > 0 ? Math.min(i, count - 1) : i;
}

/** The time to seek a video to for frame `index`: the middle of the frame, so rounding in the decoder cannot land on a neighbour. */
export function videoSeekTime(index: number, srcFps: number, duration: number): number {
  const t = (index + 0.5) / srcFps;
  return duration > 0 ? Math.min(t, Math.max(0, duration - 0.5 / srcFps)) : t;
}

/** Number of whole frames a video of `duration` seconds holds at `srcFps`. */
export const videoFrameCount = (duration: number, srcFps: number): number => Math.max(1, Math.round(duration * srcFps));

/** Opacity of the reference and of the rig for the current settings (trace mode swaps their weights). */
export function levels(meta: Pick<RefMeta, "trace" | "transform">): { reference: number; rig: number } {
  return meta.trace ? { reference: 1, rig: TRACE_RIG_ALPHA } : { reference: meta.transform.opacity, rig: 1 };
}

/** New scale for a corner drag: the figure grows with the pointer's distance from the anchor (the feet point). */
export function dragScale(startScale: number, anchor: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const d0 = Math.hypot(from.x - anchor.x, from.y - anchor.y);
  const d1 = Math.hypot(to.x - anchor.x, to.y - anchor.y);
  if (d0 < 1e-6) return startScale;
  return clamp(startScale * (d1 / d0), REF_SCALE_MIN, REF_SCALE_MAX);
}

/** Natural sort for numbered image files ("f2.png" before "f10.png"). */
export function sequenceOrder(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}
