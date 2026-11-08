/*
 * Atlas Animator editor: original implementation.
 *
 * Mirror pose (pure): copy the pose of one side of the body onto the other (a bone, a selection, a whole arm or leg) or flip the whole
 * pose (swap the sides, mirror the spine and head). Bones pair up by name: `_near` / `_far` and `_l` / `_r` (also `hand_near_target`
 * and `hair_far_1`: one side token anywhere in the name). Keys hold offsets from setup, so a mirror cannot copy numbers across: the
 * mirrored bone is placed where the *total* local transform (setup + offset) of the source reflects over the character's vertical axis,
 * and the offset is whatever reaches that from the partner's own setup. That is why a rig whose near clavicle sits at -105.8 degrees
 * and the far one at +105.8 still looks mirrored, and why a rig with slightly uneven setup legs mirrors exactly rather than by offset.
 *
 * Reflection in local space (the symmetry line is vertical in the world at setup):
 *  - two partners under one parent (clavicles under the chest, thighs under the pelvis, IK targets under the root): the line, seen in
 *    the parent's frame, is at 90 - (parent's world setup angle), so a total angle t becomes 2 * line - t and a point reflects over it;
 *  - two partners under partner parents (forearms under the upper arms): the frames are mirror images, so t becomes -t and (x, y) (x, -y);
 *  - a bone on the axis with no partner (pelvis, spine, neck, head, hair, body, lean) mirrors in place: its rotation and shear are
 *    negated and its translate is reflected.
 * Scale is copied as it is. Setup world transforms here use position and rotation only (the setup has no scale or shear).
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, setRotateKey, setVectorKey, snapTime, type BoneOffsets } from "./clipModel.js";

/** The part of a rig document's bone this module reads. */
export interface MirrorBone {
  name: string;
  parent?: string | null | undefined;
  x?: number | undefined;
  y?: number | undefined;
  rotation?: number | undefined;
}

export interface MirrorOffsets extends BoneOffsets {
  shear: { x: number; y: number };
}

export type BodySide = "near" | "far";
export type Limb = "arm" | "leg";

const DEG = Math.PI / 180;
/** An unpaired bone is "on the axis" when its setup origin is within this many px of the symmetry axis. */
export const AXIS_TOLERANCE = 3;

const SIDE_TOKENS: Record<string, { to: string; side: BodySide }> = {
  near: { to: "far", side: "near" },
  far: { to: "near", side: "far" },
  l: { to: "r", side: "near" },
  r: { to: "l", side: "far" },
  left: { to: "right", side: "near" },
  right: { to: "left", side: "far" }
};

const matchCase = (like: string, word: string) => (like !== like.toLowerCase() && like === like.toUpperCase() ? word.toUpperCase() : word);

/** The name the other side would have (any bone name with exactly one side token), or null. */
export function partnerCandidate(name: string): string | null {
  const tokens = name.split("_");
  const at = tokens.map((t, i) => (SIDE_TOKENS[t.toLowerCase()] ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) return null;
  const i = at[0]!;
  const swap = SIDE_TOKENS[tokens[i]!.toLowerCase()]!;
  return [...tokens.slice(0, i), matchCase(tokens[i]!, swap.to), ...tokens.slice(i + 1)].join("_");
}

/** Which side of the body a bone name is on (by its side token), or null when it has none. */
export function nameSide(name: string): BodySide | null {
  const hits = name.split("_").map((t) => SIDE_TOKENS[t.toLowerCase()]).filter((x) => !!x);
  return hits.length === 1 ? hits[0]!.side : null;
}

const LIMB_TOKENS: Record<Limb, ReadonlySet<string>> = {
  arm: new Set(["clavicle", "shoulder", "arm", "forearm", "elbow", "wrist", "hand"]),
  leg: new Set(["thigh", "hip", "knee", "shin", "leg", "calf", "foot", "toe"])
};

interface Setup {
  x: number;
  y: number;
  angle: number;
}

export interface MirrorRig {
  bones: readonly MirrorBone[];
  byName: ReadonlyMap<string, MirrorBone>;
  /** Partner bone name per bone that has one in this rig. */
  partner: ReadonlyMap<string, string>;
  /** Setup world origin and angle (degrees) per bone. */
  setup: ReadonlyMap<string, Setup>;
  /** Unpaired bones whose setup origin sits on the symmetry axis (mirrored in place by a flip), the root excluded. */
  center: ReadonlySet<string>;
  /** World x of the symmetry axis. */
  axisX: number;
}

export function makeMirrorRig(bones: readonly MirrorBone[]): MirrorRig {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const partner = new Map<string, string>();
  for (const b of bones) {
    const c = partnerCandidate(b.name);
    if (c && c !== b.name && byName.has(c)) partner.set(b.name, c);
  }
  const setup = new Map<string, Setup>();
  const world = (name: string): Setup => {
    const have = setup.get(name);
    if (have) return have;
    const b = byName.get(name)!;
    const p = b.parent && byName.has(b.parent) ? world(b.parent) : { x: 0, y: 0, angle: 0 };
    const r = p.angle * DEG;
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    const out = { x: p.x + x * Math.cos(r) - y * Math.sin(r), y: p.y + x * Math.sin(r) + y * Math.cos(r), angle: p.angle + (b.rotation ?? 0) };
    setup.set(name, out);
    return out;
  };
  for (const b of bones) world(b.name);
  // The axis runs through the middle of the paired bones.
  let sum = 0;
  let n = 0;
  for (const [a, b] of partner) {
    if (a < b) {
      sum += (setup.get(a)!.x + setup.get(b)!.x) / 2;
      n++;
    }
  }
  const axisX = n ? sum / n : 0;
  const center = new Set<string>();
  for (const b of bones) {
    if (!b.parent || partner.has(b.name)) continue;
    if (Math.abs(setup.get(b.name)!.x - axisX) <= AXIS_TOLERANCE) center.add(b.name);
  }
  return { bones, byName, partner, setup, center, axisX };
}

/** One mirror edit: the pose of `from` placed on `to` (the same bone for a bone on the axis). */
export interface MirrorOp {
  from: string;
  to: string;
}

/** The angle (degrees) of the symmetry line in a bone's parent frame. */
function lineAngle(rig: MirrorRig, bone: string): number {
  const parent = rig.byName.get(bone)?.parent;
  return 90 - (parent && rig.setup.get(parent) ? rig.setup.get(parent)!.angle : 0);
}

/** Partners under partner parents see each other in mirrored frames; partners under one parent share a frame. */
function partnered(rig: MirrorRig, from: string, to: string): boolean {
  const pf = rig.byName.get(from)?.parent ?? null;
  const pt = rig.byName.get(to)?.parent ?? null;
  return !!pf && !!pt && pf !== pt && rig.partner.get(pf) === pt;
}

const reflect = (v: { x: number; y: number }, lineDeg: number) => {
  const c = Math.cos(2 * lineDeg * DEG);
  const s = Math.sin(2 * lineDeg * DEG);
  return { x: c * v.x + s * v.y, y: s * v.x - c * v.y };
};

/**
 * The offsets (from setup) `op.to` takes so it mirrors `o`, the offsets of `op.from`. A bone mirrored onto itself (on the axis) negates
 * its rotation and shear and reflects its translate; a partner is placed by the total local transform, see the module comment.
 */
export function mirrorOffsets(rig: MirrorRig, op: MirrorOp, o: MirrorOffsets): MirrorOffsets {
  const from = rig.byName.get(op.from);
  const to = rig.byName.get(op.to);
  if (!from || !to) throw new Error(`unknown bone in mirror: ${op.from} -> ${op.to}`);
  const scale = { x: o.scale.x, y: o.scale.y };
  const shear = { x: -o.shear.x, y: -o.shear.y };
  const line = lineAngle(rig, op.to);
  if (op.from === op.to) return { rotate: -o.rotate, translate: reflect(o.translate, line), scale, shear };
  const mirroredFrames = partnered(rig, op.from, op.to);
  const total = (from.rotation ?? 0) + o.rotate;
  const raw = (mirroredFrames ? -total : 2 * line - total) - (to.rotation ?? 0);
  // Whole turns do not change the pose: take the one nearest the plain negation, so neighbouring keys interpolate the short way.
  const rotate = raw + 360 * Math.round((-o.rotate - raw) / 360);
  const p = { x: (from.x ?? 0) + o.translate.x, y: (from.y ?? 0) + o.translate.y };
  const q = mirroredFrames ? { x: p.x, y: -p.y } : reflect(p, line);
  return { rotate, translate: { x: q.x - (to.x ?? 0), y: q.y - (to.y ?? 0) }, scale, shear };
}

/** The names and every bone below them (a shoulder brings the whole arm). */
export function withDescendants(rig: MirrorRig, names: Iterable<string>): Set<string> {
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of rig.bones) {
      if (b.parent && out.has(b.parent) && !out.has(b.name)) {
        out.add(b.name);
        grew = true;
      }
    }
  }
  return out;
}

export interface MirrorPlan {
  ops: MirrorOp[];
  /** Bones asked for that have no partner and are not on the axis. */
  unmatched: string[];
  /** The side copied from (null when only axis bones were asked for). */
  from: BodySide | null;
}

export interface PlanOptions {
  /** Expand the named bones to everything below them (a shoulder brings the whole arm). */
  limb?: boolean;
  /** The side to copy from; default the side of `active`, else of the first paired bone named. */
  from?: BodySide;
  active?: string | null;
  /** Bones that must not be keyed (driven by a constraint). */
  skip?: ReadonlySet<string>;
}

/** The ops that copy the named bones to their partners (and mirror axis bones in place). Bones of the other side are not overwritten. */
export function planMirror(rig: MirrorRig, names: readonly string[], options: PlanOptions = {}): MirrorPlan {
  const skip = options.skip ?? new Set<string>();
  const asked = names.filter((n) => rig.byName.has(n));
  const list = options.limb ? [...withDescendants(rig, asked)].filter((n) => rig.partner.has(n) || rig.center.has(n) || asked.includes(n)) : [...new Set(asked)];
  const paired = list.filter((n) => rig.partner.has(n));
  let from: BodySide | null = options.from ?? null;
  if (!from) {
    const lead = options.active && paired.includes(options.active) ? options.active : paired[0];
    from = lead ? nameSide(lead) : null;
  }
  const ops: MirrorOp[] = [];
  const unmatched: string[] = [];
  for (const n of list) {
    const mate = rig.partner.get(n);
    if (mate) {
      if (nameSide(n) !== from || skip.has(n) || skip.has(mate)) continue;
      ops.push({ from: n, to: mate });
    } else if (rig.center.has(n)) {
      if (!skip.has(n)) ops.push({ from: n, to: n });
    } else unmatched.push(n);
  }
  return { ops, unmatched, from };
}

/** The ops that copy a whole arm or leg (IK target included) of side `from` onto the other side. */
export function planLimb(rig: MirrorRig, limb: Limb, from: BodySide, skip?: ReadonlySet<string>): MirrorPlan {
  const tokens = LIMB_TOKENS[limb];
  const names = rig.bones.filter((b) => nameSide(b.name) === from && rig.partner.has(b.name) && b.name.split("_").some((t) => tokens.has(t.toLowerCase()))).map((b) => b.name);
  return planMirror(rig, names, { from, ...(skip ? { skip } : {}) });
}

/** The ops of a whole-pose flip: every pair swaps, every bone on the axis mirrors in place. */
export function planFlip(rig: MirrorRig, skip?: ReadonlySet<string>): MirrorPlan {
  const ops: MirrorOp[] = [];
  for (const b of rig.bones) {
    if (skip?.has(b.name)) continue;
    const mate = rig.partner.get(b.name);
    if (mate) {
      if (!skip?.has(mate)) ops.push({ from: mate, to: b.name });
    } else if (rig.center.has(b.name)) ops.push({ from: b.name, to: b.name });
  }
  return { ops, unmatched: [], from: null };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-4;

/**
 * Keys one bone's offsets `o` at `time`. A channel gets a key when the clip already animates it or the source it was mirrored from was
 * off its setup, so a bone at rest mirrors to a bone at rest (no keys), even where the partner's setup is a little uneven.
 */
export function keyOffsets(clip: ClipData, bone: string, o: MirrorOffsets, time: number, source: MirrorOffsets = o): ClipData {
  let next = clip;
  const tl = next.bones[bone];
  if (tl?.rotate || !near(source.rotate, 0)) next = setRotateKey(next, bone, time, o.rotate);
  if (tl?.translate || !near(source.translate.x, 0) || !near(source.translate.y, 0)) next = setVectorKey(next, bone, "translate", time, o.translate.x, o.translate.y);
  if (tl?.scale || !near(source.scale.x, 1) || !near(source.scale.y, 1)) next = setVectorKey(next, bone, "scale", time, o.scale.x, o.scale.y);
  if (tl?.shear || !near(source.shear.x, 0) || !near(source.shear.y, 0)) next = setVectorKey(next, bone, "shear", time, o.shear.x, o.shear.y);
  return next;
}

export interface MirrorResult {
  clip: ClipData;
  /** The bones that were keyed. */
  keyed: string[];
}

/**
 * Applies the ops at `time`. Every source is read before anything is written, so a flip swaps the sides instead of copying one over
 * the other. `read` gives a bone's current offsets from setup (unkeyed edits included).
 */
export function applyMirror(clip: ClipData, rig: MirrorRig, ops: readonly MirrorOp[], read: (bone: string) => MirrorOffsets, time: number): MirrorResult {
  const t = snapTime(clip, time);
  const computed = ops.map((op) => {
    const source = read(op.from);
    return { to: op.to, source, o: mirrorOffsets(rig, op, source) };
  });
  let next = clip;
  const keyed: string[] = [];
  for (const c of computed) {
    const before = next;
    next = keyOffsets(next, c.to, c.o, t, c.source);
    if (next !== before && !keyed.includes(c.to)) keyed.push(c.to);
  }
  return { clip: next, keyed };
}

/** The IK constraint pairs that follow bone ops: a constraint whose target is the source of an op, with a same-named partner constraint. */
export function mirrorIkOps(ik: readonly { name: string; target: string }[], ops: readonly MirrorOp[]): MirrorOp[] {
  const out: MirrorOp[] = [];
  for (const c of ik) {
    const op = ops.find((o) => o.from === c.target && o.to !== o.from);
    const mate = partnerCandidate(c.name);
    if (op && mate && ik.some((k) => k.name === mate)) out.push({ from: c.name, to: mate });
  }
  return out;
}

type IkKey = { time: number; mix?: number; curve?: unknown };

/** Keys the mix of IK constraint `name` at `time`. With no earlier key a key of `base` (its mix before this edit) is added at time 0, so the frames before stay as they were. */
export function setIkMixKey(clip: ClipData, name: string, time: number, mix: number, base = mix): ClipData {
  const next = structuredClone(clip);
  const rec = next.ik as unknown as Record<string, IkKey[]>;
  const keys = (rec[name] ??= []);
  const at = keys.findIndex((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (at >= 0) keys[at] = { ...keys[at]!, mix };
  else keys.push({ time, mix, curve: "linear" });
  if (time > KEY_EPSILON && !keys.some((k) => k.time < time - KEY_EPSILON)) keys.push({ time: 0, mix: base, curve: "linear" });
  keys.sort((a, b) => a.time - b.time);
  return next;
}
