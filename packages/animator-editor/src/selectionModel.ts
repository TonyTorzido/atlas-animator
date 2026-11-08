/*
 * Atlas Animator editor: original implementation.
 *
 * Bone selection and picking (pure): the helper bones, hit-testing on the canvas (closest bone, real bones before
 * helpers, hidden helpers ignored), box select, multi-selection edits and the Shift rotation snap.
 */

export interface PickBone {
  name: string;
  /** Bone origin and tip, skeleton space. */
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  helper: boolean;
  /** A helper that does nothing right now (an IK target whose constraint has mix 0): not drawn, not pickable. */
  hidden: boolean;
}

export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Helper bones: IK targets and the weapon grip / tip markers. They steer the rig but carry no art. */
export function helperBones(bones: readonly { name: string }[], ik: readonly { target: string }[]): Set<string> {
  const out = new Set<string>(ik.map((c) => c.target));
  for (const b of bones) if (/(^|_)tip$|grip2/.test(b.name)) out.add(b.name);
  return out;
}

/**
 * The helpers to hide now: an IK target while every constraint on it has mix 0, a `*_tip` marker always, and the
 * `grip2*` bones while the constraint aimed at a `grip2*` target is off.
 */
export function hiddenHelpers(helpers: ReadonlySet<string>, constraints: readonly { target: string; mix: number }[]): Set<string> {
  const out = new Set<string>();
  for (const h of helpers) {
    const own = constraints.filter((c) => c.target === h);
    if (own.length) {
      if (own.every((c) => c.mix <= 1e-6)) out.add(h);
      continue;
    }
    if (/(^|_)tip$/.test(h)) out.add(h);
    else if (h.includes("grip2")) {
      const driven = constraints.filter((c) => c.target.includes("grip2"));
      if (!driven.length || driven.every((c) => c.mix <= 1e-6)) out.add(h);
    }
  }
  return out;
}

/** Names that lose a close call to a real bone under the pointer: the hair chain hangs off the head, so a click on the head's tip must pick the head. */
export const isHairBone = (name: string): boolean => /^hair(_|\d|$)/.test(name);

export interface PickOptions {
  /** The selected bone: it wins a close call (its gizmo is the thing in front). */
  selected?: string | null;
  /** How much closer (skeleton units) a helper must be than a real bone to win. */
  helperPenalty?: number;
}

/**
 * Every bone within `tol` of (x, y), best first. The score is the distance to the bone's segment, plus a penalty for helpers and the
 * hair chain (a real bone wins a close call), minus a bonus for the selected bone. Hidden helpers never match.
 */
export function rankBones(bones: readonly PickBone[], x: number, y: number, tol: number, opts: PickOptions = {}): string[] {
  const helperPenalty = opts.helperPenalty ?? tol * 0.4;
  const hairPenalty = tol * 0.5;
  const selectedBonus = tol * 0.35;
  const scored: { name: string; score: number; d: number }[] = [];
  for (const b of bones) {
    if (b.hidden) continue;
    const d = segmentDistance(x, y, b.ox, b.oy, b.tx, b.ty);
    if (d > tol) continue;
    const score = d + (b.helper ? helperPenalty : 0) + (isHairBone(b.name) ? hairPenalty : 0) - (b.name === opts.selected ? selectedBonus : 0);
    scored.push({ name: b.name, score, d });
  }
  scored.sort((a, c) => a.score - c.score || a.d - c.d);
  return scored.map((s) => s.name);
}

/** The bone to pick at (x, y): the best of `rankBones`, or null. */
export function pickBone(bones: readonly PickBone[], x: number, y: number, tol: number, helperPenaltyOrOpts?: number | PickOptions): string | null {
  const opts: PickOptions = typeof helperPenaltyOrOpts === "number" ? { helperPenalty: helperPenaltyOrOpts } : helperPenaltyOrOpts ?? {};
  return rankBones(bones, x, y, tol, opts)[0] ?? null;
}

/** The next bone in a stack of overlapping picks after `current` (Alt+click cycling); the first when `current` is not in it. */
export function cycleStack(stack: readonly string[], current: string | null): string | null {
  if (!stack.length) return null;
  const at = current ? stack.indexOf(current) : -1;
  return stack[(at + 1) % stack.length] ?? null;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const normalBox = (b: Box): Box => ({ x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) });

const inBox = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

/** Bones whose origin or tip is inside the box (helpers only when their origin is, hidden helpers never). */
export function bonesInBox(bones: readonly PickBone[], box: Box): string[] {
  const nb = normalBox(box);
  const out: string[] = [];
  for (const b of bones) {
    if (b.hidden) continue;
    if (inBox(nb, b.ox, b.oy) || (!b.helper && inBox(nb, b.tx, b.ty))) out.push(b.name);
  }
  return out;
}

export type SelectMode = "replace" | "add" | "toggle";

export interface BoneSelection {
  /** The active bone (the detail pane, the gizmo ring). Always one of `names` when set. */
  active: string | null;
  names: string[];
}

export function selectBones(current: BoneSelection, picked: readonly string[], mode: SelectMode, active?: string | null): BoneSelection {
  let names: string[];
  if (mode === "replace") names = [...new Set(picked)];
  else if (mode === "add") names = [...new Set([...current.names, ...picked])];
  else {
    const set = new Set(current.names);
    for (const n of picked) {
      if (set.has(n)) set.delete(n);
      else set.add(n);
    }
    names = [...set];
  }
  let next = active !== undefined ? active : picked.length ? picked[picked.length - 1]! : current.active;
  if (next && !names.includes(next)) next = names.length ? names[names.length - 1]! : null;
  if (!next && names.length) next = names[names.length - 1]!;
  return { active: next, names };
}

/** Rows between `from` and `to` in list order (both included), for Shift-click in the bone list. */
export function rangeBetween(order: readonly string[], from: string | null, to: string): string[] {
  const b = order.indexOf(to);
  const a = from ? order.indexOf(from) : -1;
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Rounds to the nearest `step` degrees (15 for the Shift snap). */
export function snapDegrees(value: number, step = 15): number {
  const r = Math.round(value / step) * step;
  return Object.is(r, -0) ? 0 : r;
}

/** Bones with a selected ancestor (a move of the ancestor already carries them). */
export function withSelectedAncestor(names: readonly string[], parentOf: (n: string) => string | null): Set<string> {
  const set = new Set(names);
  const out = new Set<string>();
  for (const n of names) {
    let p = parentOf(n);
    while (p) {
      if (set.has(p)) {
        out.add(n);
        break;
      }
      p = parentOf(p);
    }
  }
  return out;
}
