/*
 * Atlas Animator editor: original implementation.
 *
 * The transform strip's math (pure). A bone's channels are stored as offsets from setup in the PARENT's space (translate), degrees
 * (rotate), multipliers of setup (scale) and degrees (shear). The strip and the Pose panel show and accept them in an axis space:
 *   parent: the stored values as they are (the parent's axes);
 *   local:  translate along the bone's own axes (the bone's world angle);
 *   world:  translate along the skeleton's axes, and rotate as the bone's absolute world angle.
 * Scale and shear do not depend on the space. A collapsed (non-invertible) parent falls back to parent space.
 */

export type Channel = "rotate" | "translate" | "scale" | "shear";
export type Space = "local" | "parent" | "world";

export const CHANNELS: readonly Channel[] = ["rotate", "translate", "scale", "shear"];
export const SPACES: readonly Space[] = ["local", "parent", "world"];

export interface V2 {
  x: number;
  y: number;
}

/** The parts of a Bone the math reads: its world matrix and its parent's. */
export interface BoneLike {
  world: { a: number; b: number; c: number; d: number };
  parent?: { world: { a: number; b: number; c: number; d: number } } | null;
}

const DEG = 180 / Math.PI;
const EPS = 1e-9;

export const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

/** Clockwise degrees of the bone's x axis in skeleton space (y down). */
export const worldAngleOf = (b: BoneLike): number => Math.atan2(b.world.c, b.world.a) * DEG;

/** +1 when a local rotation turns the bone clockwise on screen, -1 under a mirrored parent. */
export function rotationSignOf(b: BoneLike): number {
  const p = b.parent?.world;
  return p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
}

/** Parent-space vector to skeleton space (the parent's linear part; identity for a root). */
function parentToWorld(b: BoneLike, v: V2): V2 {
  const p = b.parent?.world;
  return p ? { x: p.a * v.x + p.b * v.y, y: p.c * v.x + p.d * v.y } : { ...v };
}

function worldToParent(b: BoneLike, v: V2): V2 | null {
  const p = b.parent?.world;
  if (!p) return { ...v };
  const det = p.a * p.d - p.b * p.c;
  if (Math.abs(det) < EPS) return null;
  return { x: (p.d * v.x - p.b * v.y) / det, y: (-p.c * v.x + p.a * v.y) / det };
}

function rotate(v: V2, deg: number): V2 {
  const r = deg / DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

const collapsed = (b: BoneLike): boolean => worldToParent(b, { x: 1, y: 0 }) === null;

/** A stored translate offset (parent space) as the numbers to show in `space`. */
export function translateToSpace(b: BoneLike, space: Space, v: V2): V2 {
  if (space === "parent" || collapsed(b)) return { ...v };
  const w = parentToWorld(b, v);
  return space === "world" ? w : rotate(w, -worldAngleOf(b));
}

/** Numbers typed in `space` as the translate offset to store (parent space). Inverse of `translateToSpace`. */
export function translateFromSpace(b: BoneLike, space: Space, v: V2): V2 {
  if (space === "parent" || collapsed(b)) return { ...v };
  const w = space === "world" ? v : rotate(v, worldAngleOf(b));
  return worldToParent(b, w) ?? { ...v };
}

/** A stored rotation offset as the number to show: the bone's absolute world angle in world space, else the offset. */
export function rotateToSpace(b: BoneLike, space: Space, offset: number): number {
  return space === "world" ? wrapDeg(worldAngleOf(b)) : offset;
}

/**
 * A rotation typed in `space` as the offset to store. `offset` is the bone's current stored offset, and the bone must be posed with it
 * (its world angle is what the typed world angle is measured against).
 */
export function rotateFromSpace(b: BoneLike, space: Space, value: number, offset: number): number {
  return space === "world" ? offset + rotationSignOf(b) * wrapDeg(value - worldAngleOf(b)) : value;
}

/** Unit world directions of the bone's x and y axes in `space`, for the move gizmo: the axes translate would follow. */
export function axisFrame(b: BoneLike, space: Space): { ux: [number, number]; uy: [number, number] } {
  if (space === "world") return { ux: [1, 0], uy: [0, 1] };
  if (space === "local") {
    const a = worldAngleOf(b) / DEG;
    return { ux: [Math.cos(a), Math.sin(a)], uy: [-Math.sin(a), Math.cos(a)] };
  }
  const p = b.parent?.world;
  if (!p) return { ux: [1, 0], uy: [0, 1] };
  const lx = Math.hypot(p.a, p.c) || 1;
  const ly = Math.hypot(p.b, p.d) || 1;
  return { ux: [p.a / lx, p.c / lx], uy: [p.b / ly, p.d / ly] };
}

/** Which channel keys the strip shows for: red (keyed at this frame), orange (changed, not keyed), grey (no key). */
export type KeyState = "keyed" | "changed" | "none";

export function keyState(keyedHere: boolean, unkeyed: boolean): KeyState {
  return unkeyed ? "changed" : keyedHere ? "keyed" : "none";
}

/** Per-field step, decimals and the pixel-to-value rate for drag-scrubbing. */
export const FIELD_SPEC: Record<Channel, { step: number; decimals: number; perPx: number; min?: number }> = {
  rotate: { step: 1, decimals: 2, perPx: 0.5 },
  translate: { step: 1, decimals: 1, perPx: 0.5 },
  scale: { step: 0.05, decimals: 3, perPx: 0.01, min: 0.001 },
  shear: { step: 1, decimals: 2, perPx: 0.5 }
};

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/** Shift is fine (x0.1), Ctrl / Alt coarse (x10). */
export const modScale = (m: Mods): number => (m.shift ? 0.1 : m.ctrl || m.alt ? 10 : 1);

export function roundTo(v: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/** The value after one wheel notch over a field (wheel up raises it). */
export function wheelValue(ch: Channel, value: number, deltaY: number, m: Mods = {}): number {
  const spec = FIELD_SPEC[ch];
  const next = value + (deltaY < 0 ? 1 : -1) * spec.step * modScale(m);
  return clampField(ch, roundTo(next, spec.decimals + 1));
}

/** The value after dragging the label by `dx` pixels from `start`. */
export function scrubValue(ch: Channel, start: number, dx: number, m: Mods = {}): number {
  const spec = FIELD_SPEC[ch];
  return clampField(ch, roundTo(start + dx * spec.perPx * modScale(m), spec.decimals + 1));
}

export function clampField(ch: Channel, v: number): number {
  const min = FIELD_SPEC[ch].min;
  return min !== undefined && v < min ? min : v;
}

export const formatField = (ch: Channel, v: number): string => roundTo(v, FIELD_SPEC[ch].decimals).toFixed(FIELD_SPEC[ch].decimals);
