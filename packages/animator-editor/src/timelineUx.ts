/*
 * Atlas Animator editor: original implementation.
 *
 * Timeline ergonomics (pure): the resizable dopesheet height, the key hover text, and the undo / redo button labels.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON } from "./clipModel.js";
import { CURVE_LABELS, curveKind, keyCurveAt } from "./curveModel.js";

/** Shortest dopesheet: the ruler and about three rows. */
export const TL_MIN_H = 96;
/** One keyboard step of the splitter. */
export const TL_STEP_PX = 16;

/** Tallest dopesheet: the canvas keeps at least 380 px (header 44, bar and tool rows ~76, status 26 are fixed). */
export function tlMaxHeight(viewportH: number): number {
  return Math.max(TL_MIN_H, Math.min(Math.round(viewportH * 0.6), viewportH - 44 - 76 - 26 - 380));
}

export function clampTlHeight(h: number, viewportH: number): number {
  if (!Number.isFinite(h)) return TL_MIN_H;
  return Math.round(Math.max(TL_MIN_H, Math.min(tlMaxHeight(viewportH), h)));
}

/** A saved height read back from storage: null when it is missing or nonsense. */
export function parseTlHeight(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Undo: Moved 6 keys by 12 frames (Ctrl+Z)"; with nothing to undo, "Nothing to undo". */
export function historyTip(kind: "Undo" | "Redo", label: string | undefined | null, keys: string): string {
  if (label === null) return `Nothing to ${kind.toLowerCase()}`;
  return label ? `${kind}: ${label} (${keys})` : `${kind} the last change (${keys})`;
}

/** The status-bar text after an undo / redo: "Undid: Moved 6 keys by 12 frames". */
export function historyStatus(kind: "Undo" | "Redo", label: string | undefined): string {
  const verb = kind === "Undo" ? "Undid" : "Redid";
  return label ? `${verb}: ${label}` : verb;
}

/** Turns a past-tense status message into the label stored on an undo step (first letter kept, trailing period dropped). */
export function stepLabel(message: string | undefined): string | undefined {
  const m = message?.trim().replace(/\.$/, "");
  return m ? (m.length > 90 ? `${m.slice(0, 87)}...` : m) : undefined;
}

export const nudgeLabel = (n: number, df: number) => `Moved ${plural(n, "key")} ${df > 0 ? "+" : ""}${df} frame${Math.abs(df) === 1 ? "" : "s"}`;

/** Hover text for one dopesheet key: "chest rotate, frame 24, 8.0 deg, linear". */
export function keyHoverText(clip: ClipData, row: { kind: string; name: string; type?: string }, time: number, frame: number): string {
  const parts: string[] = [];
  if (row.kind === "bone" || row.kind === "chan") {
    const tlines = clip.bones[row.name];
    const at = (keys: readonly { time: number }[] | undefined) => keys?.find((k) => Math.abs(k.time - time) < KEY_EPSILON) as Record<string, number> | undefined;
    const wantAll = row.kind === "bone";
    const type = row.type;
    const bits: string[] = [];
    const rot = (wantAll || type === "rotate") && at(tlines?.rotate);
    if (rot && typeof rot.value === "number") bits.push(`${rot.value.toFixed(1)} deg`);
    for (const ch of ["translate", "scale", "shear"] as const) {
      const k = (wantAll || type === (ch === "translate" ? "translate" : "scaleShear")) && at(tlines?.[ch]);
      if (k && typeof k.x === "number") bits.push(`${ch} ${k.x.toFixed(1)}, ${(k.y ?? 0).toFixed(1)}`);
    }
    parts.push(row.kind === "chan" ? `${row.name} ${type === "scaleShear" ? "scale" : type}` : row.name, `frame ${frame}`, ...bits);
    const curve = keyCurveAt(clip, { kind: "bone", name: row.name, time });
    if (curve !== undefined) parts.push(CURVE_LABELS[curveKind(curve)].toLowerCase());
  } else if (row.kind === "all") {
    parts.push("all keys", `frame ${frame}`);
  } else {
    parts.push(row.kind === "ik" ? `IK ${row.name}` : row.kind === "draw" ? "draw order" : row.kind === "event" ? "event" : `${row.kind} ${row.name}`, `frame ${frame}`);
  }
  return parts.join(", ");
}

/**
 * Shift-drag snapping: the delta (frames) that lands one moved key exactly on a neighbouring (unselected) key, when that is within
 * `tol` frames of the raw delta. Returns the delta and the frame it snapped to, or null.
 */
export function snapDelta(moved: readonly number[], others: readonly number[], rawDelta: number, tol = 3): { delta: number; to: number } | null {
  let best: { delta: number; to: number } | null = null;
  let bestD = tol + 1e-9;
  for (const m of moved)
    for (const o of others) {
      const delta = o - m;
      const d = Math.abs(delta - rawDelta);
      if (d < bestD) {
        bestD = d;
        best = { delta, to: o };
      }
    }
  return best;
}

/** The timeline header text: "Frame 12 / 24 · 0.80 s · 30 fps" (frame, frame count, clip length in seconds, frame rate). */
export function timelineHeader(frame: number, frames: number, duration: number, fps: number): string {
  return `Frame ${frame} / ${frames} · ${duration.toFixed(2)} s · ${fps} fps`;
}
