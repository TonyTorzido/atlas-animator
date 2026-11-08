/*
 * Atlas Animator editor: bone drawing helpers (pure). Bones are drawn standard: a tapered wedge from a round joint at the
 * pivot to a point at the tip, in the BONE-STANDARD colour of the part of the body they belong to (animateBones.ts).
 * Sizes are in SCREEN pixels; the overlay converts them with the zoom so a bone keeps its on-screen size at any zoom.
 */
import { BONE_COLORS } from "./animateBones.js";

const hex = (s: string): number => parseInt(s.slice(1), 16);

/** Helpers that are neither a target nor a weapon: grey. */
export const HELPER_GREY = 0x9aa3b2;

/** The bone's colour by name (BONE-STANDARD: body / lean yellow, near arm green, far arm orange, near leg blue, far leg purple, head and hair cyan, IK targets pink, weapon red, helpers grey). */
export function boneColor(name: string, helper = false, own?: string | null): number {
  // The artist's saved colour (rrggbbaa) wins over the role / name colour, so the canvas and the tree agree ().
  if (own && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(own)) return parseInt(own.slice(0, 6), 16);
  const n = name.toLowerCase();
  if (/target/.test(n)) return hex(BONE_COLORS.target);
  if (helper) return HELPER_GREY;
  if (/^weapon/.test(n)) return hex(BONE_COLORS.weapon);
  const far = /(_far|_r)(_|\d|$)/.test(n);
  if (/head|hair|jaw|eye/.test(n)) return hex(BONE_COLORS.head);
  if (/clavicle|shoulder|arm|elbow|wrist|hand|finger/.test(n)) return hex(far ? BONE_COLORS.armFar : BONE_COLORS.armNear);
  if (/thigh|shin|foot|knee|hip|leg|toe|ankle/.test(n)) return hex(far ? BONE_COLORS.legFar : BONE_COLORS.legNear);
  if (/body|lean|pelvis|spine|chest|neck|torso/.test(n)) return hex(BONE_COLORS.centre);
  return HELPER_GREY;
}

/** Mixes a colour toward white by `k` (0..1). */
export function brighten(color: number, k: number): number {
  const ch = (shift: number) => {
    const v = (color >> shift) & 255;
    return Math.round(v + (255 - v) * k);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Wedge width (screen px) for a bone `lengthPx` long: proportional, clamped so tiny bones stay clickable and long ones stay slim; `scale` is the size slider. */
export function wedgeWidth(lengthPx: number, scale = 1): number {
  return Math.max(10, Math.min(24, lengthPx * 0.28)) * scale;
}

/** Bones shorter than this (screen px) draw as a small circle with a cross. */
export const TINY_BONE_PX = 5;

/**
 * The wedge polygon (flat x, y list): the pivot, the widest points a little along the bone (`width` across), and the tip.
 * A kite-shaped bone: the round joint is drawn separately over the pivot.
 */
export function wedgePolygon(ox: number, oy: number, tx: number, ty: number, width: number): number[] {
  const dx = tx - ox;
  const dy = ty - oy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const k = 0.2;
  const bx = ox + dx * k;
  const by = oy + dy * k;
  const h = width / 2;
  return [ox, oy, bx + nx * h, by + ny * h, tx, ty, bx - nx * h, by - ny * h];
}

/** The parent chain of a bone from the root down to the bone itself. */
export function crumbChain(parentOf: (name: string) => string | null, name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = name;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(cur);
    cur = parentOf(cur);
  }
  return out;
}
