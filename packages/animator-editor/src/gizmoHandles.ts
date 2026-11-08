/*
 * Atlas Animator editor: original implementation.
 *
 * The Scale and Shear handles, shared by the Animate gizmo (main.ts) and the Setup Scale / Shear tools (setupMode.ts),
 * (RG-04, ). Pure geometry plus one draw function: a handle frame (origin, the two axis directions, the two handle points), the
 * grab test, the scale factors of a drag and the shear angle of a drag. The axis directions follow the Axes choice of the stage bar
 * (Local, Parent, World): the red handle always edits the bone's X value and the green one its Y value, but it sits, and the drag
 * is measured, along the chosen frame's x / y direction.
 */
import { axisFrame, type BoneLike, type Space } from "./transformModel.js";

export interface HandleFrame {
  ox: number;
  oy: number;
  ux: [number, number];
  uy: [number, number];
  hx: [number, number];
  hy: [number, number];
}

export type HandleAxis = "x" | "y" | "xy";
export type HandleMode = "scale" | "shear";

/** A bone with its world origin. */
export interface HandleBone extends BoneLike {
  world: { a: number; b: number; c: number; d: number; x: number; y: number };
}

/** The handle frame of a bone: handles `radius` world units out along the frame's axes. Local keeps the bone's own (scaled, sheared) axes. */
export function handleFrame(bone: HandleBone, space: Space, radius: number): HandleFrame {
  const w = bone.world;
  let ux: [number, number];
  let uy: [number, number];
  if (space === "local") {
    const lx = Math.hypot(w.a, w.c) || 1;
    const ly = Math.hypot(w.b, w.d) || 1;
    ux = [w.a / lx, w.c / lx];
    uy = [w.b / ly, w.d / ly];
  } else {
    const f = axisFrame(bone, space);
    ux = f.ux;
    uy = f.uy;
  }
  return { ox: w.x, oy: w.y, ux, uy, hx: [w.x + ux[0] * radius, w.y + ux[1] * radius], hy: [w.x + uy[0] * radius, w.y + uy[1] * radius] };
}

/** The handle under a point (the centre grabs both axes in Scale), or null. `grab` is the pick radius in world units. */
export function handleAt(f: HandleFrame, mode: HandleMode, x: number, y: number, grab: number): HandleAxis | null {
  const near = (h: [number, number]) => Math.hypot(x - h[0], y - h[1]) <= grab;
  return near(f.hx) ? "x" : near(f.hy) ? "y" : mode === "scale" && Math.hypot(x - f.ox, y - f.oy) <= grab ? "xy" : null;
}

export interface ScaleStart {
  d0: { x: number; y: number };
  r0: number;
}

/** What a scale drag measures from at the press. */
export function scaleStart(f: HandleFrame, x: number, y: number): ScaleStart {
  const dx = x - f.ox;
  const dy = y - f.oy;
  return { d0: { x: Math.abs(dx * f.ux[0] + dy * f.ux[1]) || 1, y: Math.abs(dx * f.uy[0] + dy * f.uy[1]) || 1 }, r0: Math.hypot(dx, dy) || 1 };
}

export const SCALE_MIN = 0.05;
export const SCALE_MAX = 5;
const clampScale = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, v));

/** The scale a drag to (x, y) gives: the grabbed axis follows the pointer's distance along it (both together for the centre), the other keeps its start value. */
export function scaleAt(f: HandleFrame, s: ScaleStart, axis: HandleAxis, start: { x: number; y: number }, x: number, y: number): { x: number; y: number } {
  const dx = x - f.ox;
  const dy = y - f.oy;
  const fx = Math.abs(dx * f.ux[0] + dy * f.ux[1]) / s.d0.x;
  const fy = Math.abs(dx * f.uy[0] + dy * f.uy[1]) / s.d0.y;
  const fu = Math.hypot(dx, dy) / s.r0;
  return { x: axis === "y" ? start.x : clampScale(start.x * (axis === "xy" ? fu : fx)), y: axis === "x" ? start.y : clampScale(start.y * (axis === "xy" ? fu : fy)) };
}

export const SHEAR_LIMIT = 80;

/** The pointer's angle about the origin, degrees. */
export const pointerAngleAbout = (ox: number, oy: number, x: number, y: number): number => (Math.atan2(y - oy, x - ox) * 180) / Math.PI;

/** The turn from `last` to `a`, the short way round (-180..180). */
export function angleStep(last: number, a: number): number {
  let d = a - last;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** The shear value after the pointer has turned `accum` degrees (the parent's flip as `sign`), held to +-80. */
export const shearValue = (start: number, sign: number, accum: number): number => Math.max(-SHEAR_LIMIT, Math.min(SHEAR_LIMIT, start + sign * accum));

/** The minimal drawing surface the handles need (a Pixi Graphics fits). */
export interface HandlePen {
  moveTo(x: number, y: number): HandlePen;
  lineTo(x: number, y: number): HandlePen;
  rect(x: number, y: number, w: number, h: number): HandlePen;
  circle(x: number, y: number, r: number): HandlePen;
  stroke(o: { width: number; color: number; alpha?: number }): HandlePen;
  fill(o: { color: number; alpha?: number }): HandlePen;
}

export const HANDLE_COLORS = { x: 0xff7a7a, y: 0x6bd68f, hot: 0xf0b84a, centre: 0xe8edf5 } as const;

/** Draws the handles: squares for Scale (plus the centre square), circles for Shear (plus a centre dot). `px` = world units per screen pixel. */
export function drawHandles(g: HandlePen, mode: HandleMode, f: HandleFrame, px: number, hotAxis: HandleAxis | null): void {
  for (const axis of ["x", "y"] as const) {
    const h = axis === "x" ? f.hx : f.hy;
    const hot = hotAxis === axis;
    g.moveTo(f.ox, f.oy).lineTo(h[0], h[1]).stroke({ width: 2 * px, color: HANDLE_COLORS[axis], alpha: 0.8 });
    if (mode === "scale") g.rect(h[0] - 8 * px, h[1] - 8 * px, 16 * px, 16 * px).fill({ color: hot ? HANDLE_COLORS.hot : HANDLE_COLORS[axis] });
    else g.circle(h[0], h[1], 9 * px).fill({ color: hot ? HANDLE_COLORS.hot : HANDLE_COLORS[axis] });
  }
  if (mode === "scale") g.rect(f.ox - 10 * px, f.oy - 10 * px, 20 * px, 20 * px).stroke({ width: 2 * px, color: hotAxis === "xy" ? HANDLE_COLORS.hot : HANDLE_COLORS.centre });
  else g.circle(f.ox, f.oy, 5 * px).fill({ color: HANDLE_COLORS.centre });
}
