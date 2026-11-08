/*
 * Atlas Animator editor: original implementation.
 *
 * On-canvas placement handles for the Swag workshop. Pure geometry: where a piece sits on the draft picture (its
 * pixels -> slot bone frame -> rig world -> picture pixels), the three handles (Move at the centre, Turn on a stalk above it, Size at the
 * bottom-right corner) and the new Across / Down / Turn / Size a drag gives. The workshop draws the handles over the picture and writes the
 * result into the same numbers the fields show.
 */
import { boneForAddedSlot } from "./swagModel.js";
import { pieceLocalPoint } from "./swagTransfer.js";
import { listOf, type JsonObject } from "./setupModel.js";

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

export interface Placed {
  width: number;
  height: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export type HandleKind = "move" | "turn" | "size";

export const SIZE_MIN = 0.1;
export const SIZE_MAX = 4;
export const TURN_SNAP = 15;
export const SIZE_SNAP = 0.1;

/** The bone a piece for `rigSlot` rides: the slot's own bone when the rig has the slot, else the bone a new slot would be put on. */
export function pieceBone(raw: JsonObject, rigSlot: string): string | null {
  for (const s of listOf(raw["slots"])) if (s["name"] === rigSlot && typeof s["bone"] === "string") return s["bone"];
  return boneForAddedSlot(rigSlot);
}

export const mul = (p: Mat, q: Mat): Mat => ({
  a: p.a * q.a + p.b * q.c,
  b: p.a * q.b + p.b * q.d,
  c: p.c * q.a + p.d * q.c,
  d: p.c * q.b + p.d * q.d,
  x: p.a * q.x + p.b * q.y + p.x,
  y: p.c * q.x + p.d * q.y + p.y
});

export const apply = (m: Mat, x: number, y: number): [number, number] => [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];

export function invert(m: Mat): Mat | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) };
}

export interface HandleSet {
  centre: [number, number];
  turn: [number, number];
  size: [number, number];
  /** The four corners of the piece, for the outline. */
  corners: [number, number][];
}

/** `toPicture` maps the slot bone's frame to picture pixels (picture camera times the bone's setup-pose world matrix). */
export function handleSet(p: Placed, toPicture: Mat, stalk = 22): HandleSet {
  const pt = (px: number, py: number): [number, number] => {
    const l = pieceLocalPoint(p, px, py);
    return apply(toPicture, l.x, l.y);
  };
  const centre = pt(p.width / 2, p.height / 2);
  const top = pt(p.width / 2, 0);
  const dx = top[0] - centre[0];
  const dy = top[1] - centre[1];
  const len = Math.hypot(dx, dy) || 1;
  return { centre, turn: [top[0] + (dx / len) * stalk, top[1] + (dy / len) * stalk], size: pt(p.width, p.height), corners: [pt(0, 0), pt(p.width, 0), pt(p.width, p.height), pt(0, p.height)] };
}

/** Whether a picture point lies on the piece. */
export function hitPiece(p: Placed, toPicture: Mat, x: number, y: number): boolean {
  const inv = invert(toPicture);
  if (!inv) return false;
  const [lx, ly] = apply(inv, x, y);
  const s = p.scale || 1;
  const a = (p.rotation * Math.PI) / 180;
  const dx = lx - p.x;
  const dy = ly - p.y;
  const px = (dx * Math.cos(a) + dy * Math.sin(a)) / s + p.width / 2;
  const py = (-dx * Math.sin(a) + dy * Math.cos(a)) / s + p.height / 2;
  return px >= 0 && py >= 0 && px <= p.width && py <= p.height;
}

const round = (v: number, n = 2): number => Math.round(v * 10 ** n) / 10 ** n + 0;

/** Move: the new Across / Down after the pointer moved by (dx, dy) picture pixels. Shift keeps the drag on one axis (the longer way). */
export function dragMove(start: Placed, toPicture: Mat, dx: number, dy: number, shift: boolean): { x: number; y: number } {
  const inv = invert({ ...toPicture, x: 0, y: 0 });
  if (!inv) return { x: start.x, y: start.y };
  let mx = dx;
  let my = dy;
  if (shift) {
    if (Math.abs(dx) >= Math.abs(dy)) my = 0;
    else mx = 0;
  }
  const [lx, ly] = apply(inv, mx, my);
  return { x: round(start.x + lx), y: round(start.y + ly) };
}

/** Turn: the new angle when the pointer, pressed at angle `a0` about the centre, is now at (x, y). Shift snaps to 15 degree steps. */
export function dragTurn(start: Placed, toPicture: Mat, centre: [number, number], a0: number, x: number, y: number, shift: boolean): number {
  const a1 = (Math.atan2(y - centre[1], x - centre[0]) * 180) / Math.PI;
  let d = a1 - a0;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  const flip = toPicture.a * toPicture.d - toPicture.b * toPicture.c < 0 ? -1 : 1;
  let r = start.rotation + flip * d;
  if (shift) r = Math.round(r / TURN_SNAP) * TURN_SNAP;
  r = ((((r + 180) % 360) + 360) % 360) - 180;
  return round(r);
}

/** Size: the new uniform size when the pointer, pressed `d0` away from the centre, is now at (x, y). Shift snaps to 10 percent steps. */
export function dragSize(start: Placed, centre: [number, number], d0: number, x: number, y: number, shift: boolean): number {
  const d1 = Math.hypot(x - centre[0], y - centre[1]);
  let s = start.scale * (d1 / (d0 || 1));
  if (shift) s = Math.round(s / SIZE_SNAP) * SIZE_SNAP;
  return round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, s)), 3);
}
