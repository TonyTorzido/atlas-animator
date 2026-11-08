/*
 * Atlas Animator editor: original implementation.
 *
 * Smart pose assist (pure): what a rotate or move drag shows and snaps to.
 * - the readout at the cursor: the angle and its change from where the drag began (or x / y when moving);
 * - Shift snaps the angle to 15 degrees, Ctrl to the previous key's angle or the mirror bone's angle (a magnet: only near a target);
 * - typing a number mid-drag sets the exact value, Blender style: digits, "-", ".", Backspace, Enter commits.
 * main.ts draws the guides and moves the pose; this file only decides numbers.
 */
import { snapDegrees } from "./selectionModel.js";

/** Degrees within which Ctrl pulls the angle onto the previous key or the mirror bone. */
export const MAGNET = 18;
export const SNAP_STEP = 15;

export type SnapKind = "step" | "key" | "mirror";

export interface AssistGuide {
  kind: "key" | "mirror";
  /** The rotation offset (degrees from setup) the guide marks. */
  value: number;
}

export interface AssistInput {
  /** The angle the pointer asks for (degrees from setup). */
  raw: number;
  shift: boolean;
  /** Ctrl or Cmd. */
  ctrl: boolean;
  /** The bone's rotation at its previous key (before the playhead), or null. */
  prevKey: number | null;
  /** The mirror partner's angle seen from this bone, or null. */
  mirror: number | null;
}

export interface AssistResult {
  value: number;
  snap: SnapKind | null;
  /** Guides to draw: with Ctrl held both candidates show, the snapped one is `snap`. */
  guides: AssistGuide[];
}

const dist = (a: number, b: number) => Math.abs(a - b);

/** Applies the held modifiers to a raw angle. Shift wins over Ctrl when both are down. */
export function assistRotation(i: AssistInput): AssistResult {
  if (i.shift) return { value: snapDegrees(i.raw, SNAP_STEP), snap: "step", guides: [] };
  if (!i.ctrl) return { value: i.raw, snap: null, guides: [] };
  const guides: AssistGuide[] = [];
  if (i.prevKey !== null) guides.push({ kind: "key", value: i.prevKey });
  if (i.mirror !== null) guides.push({ kind: "mirror", value: i.mirror });
  let best: AssistGuide | null = null;
  for (const g of guides) if (dist(g.value, i.raw) <= MAGNET && (!best || dist(g.value, i.raw) < dist(best.value, i.raw))) best = g;
  return best ? { value: best.value, snap: best.kind, guides } : { value: i.raw, snap: null, guides };
}

const MINUS = "−";
const DEG = "°";
const CARET = "▏";
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Degrees as the readout writes them: one decimal, a real minus sign. */
export const fmtDeg = (v: number) => `${r1(v).toFixed(1).replace("-", MINUS)}${DEG}`;
/** A signed change with the degree sign. */
export const fmtDelta = (v: number) => `${r1(v) >= 0 ? "+" : MINUS}${Math.abs(r1(v)).toFixed(1)}${DEG}`;
const fmtNum = (v: number) => r1(v).toFixed(1).replace("-", MINUS);
const fmtDelta2 = (v: number) => `${r1(v) >= 0 ? "+" : MINUS}${Math.abs(r1(v)).toFixed(1)}`;

export interface Readout {
  /** The big line: "42.0 deg" or "x 12.0  y -3.0". */
  main: string;
  /** The small line: the change from the start, or the snap in force. */
  sub: string;
  /** True while a number is being typed. */
  typing: boolean;
  /** Which snap is on (drives the readout's accent). */
  snap: SnapKind | null;
}

function snapText(snap: SnapKind | null, delta: string): string {
  if (snap === "step") return `${delta}  ·  snap ${SNAP_STEP}${DEG}`;
  if (snap === "key") return `${delta}  ·  previous key`;
  if (snap === "mirror") return `${delta}  ·  mirror bone`;
  return delta;
}

export function rotateReadout(value: number, start: number, snap: SnapKind | null, typed: string | null): Readout {
  const delta = fmtDelta(value - start);
  const sub = typed !== null ? `${delta}  ·  Enter to set` : snapText(snap, delta);
  return { main: typed !== null ? `${typed || "0"}${CARET}${DEG}` : fmtDeg(value), sub, typing: typed !== null, snap };
}

export function moveReadout(x: number, y: number, sx: number, sy: number, typed: { x: string; y: string; field: "x" | "y" } | null): Readout {
  if (typed) {
    const f = (k: "x" | "y") => (typed.field === k ? `${typed[k] || "0"}${CARET}` : typed[k] || fmtNum(k === "x" ? x : y));
    return { main: `x ${f("x")}   y ${f("y")}`, sub: "Tab switches X / Y  ·  Enter to set", typing: true, snap: null };
  }
  return { main: `x ${fmtNum(x)}   y ${fmtNum(y)}`, sub: `${fmtDelta2(x - sx)}  ${fmtDelta2(y - sy)}`, typing: false, snap: null };
}

/** One key press into the typed-number buffer: the new buffer, or null when the key is not for the number. */
export function typeKey(buffer: string, key: string): string | null {
  if (/^[0-9]$/.test(key)) return buffer.length >= 8 ? buffer : buffer + key;
  if (key === "-") return buffer.startsWith("-") ? buffer.slice(1) : `-${buffer}`;
  if (key === "." || key === ",") return buffer.includes(".") ? buffer : `${buffer || "0"}.`;
  if (key === "Backspace") return buffer.slice(0, -1);
  return null;
}

/** The number a buffer holds ("", "-" and "." are not numbers yet). */
export function typedValue(buffer: string): number | null {
  if (!/^-?\d*\.?\d*$/.test(buffer) || !/\d/.test(buffer)) return null;
  const v = Number(buffer);
  return Number.isFinite(v) ? v : null;
}
