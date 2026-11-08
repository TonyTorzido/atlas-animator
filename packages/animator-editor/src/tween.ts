/*
 * Atlas Animator editor: original implementation.
 *
 * Smart in-betweens ("Arc in-betweens"), an assist the user triggers. Between the keys of a frame range, an effector (the weapon tip,
 * a fist or a foot) is made to follow a smooth world-space path instead of whatever the per-bone rotation blend happens to trace:
 *   1. the effector's world position (and its end bone's world angle) is read at every key frame of the arm / leg chain in the range,
 *      from the clip as it stands: those are the waypoints (the range ends are always waypoints);
 *   2. a centripetal Catmull-Rom spline runs through the waypoints; an optional "arc" bias bows each span sideways, away from the
 *      chain's root, by `bias * chord * 4u(1-u)` (zero at the keys, so the path still passes through them);
 *   3. a spacing preset (ease in / out, slow in-out, anticipation hold then snap) maps frame fraction to spline fraction per span;
 *   4. for each in-between frame the end bone's world angle is planned (Hermite through the waypoint angles), the wrist target is the
 *      effector target minus the effector's offset from the wrist, and a two-bone analytic solve (armIk.solveTwoBone) plus the end bone
 *      rotation gives FK rotations that put the effector on the spline. The segments are rigid by construction (only rotations are keyed);
 *   5. the result is baked as plain rotate keys on the chain bones (every N frames, or only at chosen frames), and every generated frame
 *      is run through the user rules. A rule that fires at a generated frame but not at either key around it is reported.
 * Everything here is pure on a document + clip: the caller owns undo (one commit) and the panel. Generated keys are remembered
 * per clip name with their values so the timeline can paint them and "Clear generated keys" removes only those still untouched.
 */
import { Skeleton, type AnimDocument, type Bone, type ClipData } from "@atlas-animator/core/core";
import { solveTwoBone } from "./armIk.js";
import { deleteKeys, frameTime, hasKey, KEY_EPSILON, snapTime, timeToFrame } from "./clipModel.js";
import { makeSampler, type Sampler } from "./motionPath.js";
import { poseRuleHits, referenceOf, type PoseRule, type Reference } from "./poseRules.js";

export type Pt = [number, number];
const DEG = 180 / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ---------------------------------------------------------------------------------------------
// Spacing presets
// ---------------------------------------------------------------------------------------------

export type SpacingId = "linear" | "ease-in" | "ease-out" | "slow-in-out" | "attack";
export const SPACING_LABEL: Record<SpacingId, string> = {
  linear: "Even (linear)",
  "ease-in": "Ease in (start slow)",
  "ease-out": "Ease out (end slow)",
  "slow-in-out": "Slow in, slow out",
  attack: "Attack: hold, snap, settle"
};
export const SPACING_IDS = Object.keys(SPACING_LABEL) as SpacingId[];

/** The attack curve's knots (frame fraction, path fraction): a long wind-up that barely moves, a fast swing, a short settle. */
const ATTACK_KNOTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.4, 0.05],
  [0.72, 0.93],
  [1, 1]
];

/** Monotone cubic (Fritsch-Carlson) through the knots: never overshoots, so the effector never runs past a key. */
function pchip(knots: readonly (readonly [number, number])[], x: number): number {
  const n = knots.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(knots[i + 1]![0] - knots[i]![0]);
    d.push((knots[i + 1]![1] - knots[i]![1]) / h[i]!);
  }
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (2 * d[i - 1]! * d[i]!) / (d[i - 1]! + d[i]!);
  // Flat at both ends: the wind-up starts from rest and the settle comes to rest.
  m[0] = 0;
  m[n - 1] = 0;
  let i = 0;
  while (i < n - 2 && x > knots[i + 1]![0]) i++;
  const t = (x - knots[i]![0]) / h[i]!;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * knots[i]![1] + (t3 - 2 * t2 + t) * h[i]! * m[i]! + (-2 * t3 + 3 * t2) * knots[i + 1]![1] + (t3 - t2) * h[i]! * m[i + 1]!;
}

/** Path fraction (0..1) at frame fraction `p` (0..1) of a key-to-key span. */
export function spacingAt(id: SpacingId, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (id) {
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "slow-in-out":
      return x * x * (3 - 2 * x);
    case "attack":
      return Math.min(1, Math.max(0, pchip(ATTACK_KNOTS, x)));
    default:
      return x;
  }
}

// ---------------------------------------------------------------------------------------------
// The path: centripetal Catmull-Rom through waypoints, with an arc bias
// ---------------------------------------------------------------------------------------------

export interface Path {
  frames: number[];
  pts: Pt[];
  /** The chain root at each waypoint (the bow goes away from it). */
  roots: Pt[];
  /** End-bone world angles at the waypoints, unwrapped to be continuous. */
  angles: number[];
  bias: number;
  /** Per span: +1 or -1, which side of the chord the bow goes (1 = the chord's left normal). Missing = away from the chain root. */
  sides?: number[];
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mix = (a: Pt, b: Pt, w: number): Pt => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];

/** Barry-Goldman evaluation of the centripetal Catmull-Rom segment P1..P2 at `u` in 0..1. */
function centripetal(p0: Pt, p1: Pt, p2: Pt, p3: Pt, u: number): Pt {
  const t0 = 0;
  const t1 = t0 + Math.max(1e-4, Math.sqrt(dist(p0, p1)));
  const t2 = t1 + Math.max(1e-4, Math.sqrt(dist(p1, p2)));
  const t3 = t2 + Math.max(1e-4, Math.sqrt(dist(p2, p3)));
  const t = t1 + u * (t2 - t1);
  const a1 = mix(p0, p1, (t - t0) / (t1 - t0));
  const a2 = mix(p1, p2, (t - t1) / (t2 - t1));
  const a3 = mix(p2, p3, (t - t2) / (t3 - t2));
  const b1 = mix(a1, a2, (t - t0) / (t2 - t0));
  const b2 = mix(a2, a3, (t - t1) / (t3 - t1));
  return mix(b1, b2, (t - t1) / (t2 - t1));
}

export function buildPath(frames: number[], pts: Pt[], roots: Pt[], angles: number[], bias: number, sides?: number[]): Path {
  const unwrapped: number[] = [];
  angles.forEach((a, i) => unwrapped.push(i === 0 ? a : unwrapped[i - 1]! + wrap(a - unwrapped[i - 1]!)));
  return { frames, pts, roots, angles: unwrapped, bias, ...(sides ? { sides } : {}) };
}

/** The span (index j: waypoint j to j + 1) holding `frame`, and the frame fraction in it. */
export function spanOf(path: Path, frame: number): { j: number; p: number } {
  const last = path.frames.length - 2;
  let j = 0;
  while (j < last && frame > path.frames[j + 1]!) j++;
  const a = path.frames[j]!;
  const b = path.frames[j + 1]!;
  return { j, p: b > a ? (frame - a) / (b - a) : 0 };
}

/** The path point in span `j` at path fraction `u`: the spline plus the bow (zero at both waypoints). */
export function pathPoint(path: Path, j: number, u: number): Pt {
  const { pts } = path;
  const n = pts.length;
  const p1 = pts[j]!;
  const p2 = pts[j + 1]!;
  const p0 = j > 0 ? pts[j - 1]! : ([2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] as Pt);
  const p3 = j + 2 < n ? pts[j + 2]! : ([2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] as Pt);
  const q = centripetal(p0, p1, p2, p3, u);
  const chord = dist(p1, p2);
  if (!path.bias || chord < 1e-6) return q;
  // Unit normal of the chord; the bow side is the one the clip's own path bulges to (see generateTween), else away from the chain root.
  let nx = -(p2[1] - p1[1]) / chord;
  let ny = (p2[0] - p1[0]) / chord;
  const root = path.roots[j]!;
  const side = path.sides?.[j];
  if (side !== undefined ? side < 0 : nx * ((p1[0] + p2[0]) / 2 - root[0]) + ny * ((p1[1] + p2[1]) / 2 - root[1]) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const bow = path.bias * chord * 4 * u * (1 - u);
  return [q[0] + nx * bow, q[1] + ny * bow];
}

/** The planned end-bone world angle in span `j` at `u` (Hermite through the waypoint angles, Catmull-Rom tangents). */
export function pathAngle(path: Path, j: number, u: number): number {
  const a = path.angles;
  const n = a.length;
  const tan = (i: number) => (i === 0 ? a[1]! - a[0]! : i === n - 1 ? a[n - 1]! - a[n - 2]! : (a[i + 1]! - a[i - 1]!) / 2);
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a[j]! + (u3 - 2 * u2 + u) * tan(j) + (-2 * u3 + 3 * u2) * a[j + 1]! + (u3 - u2) * tan(j + 1);
}

// ---------------------------------------------------------------------------------------------
// Effectors
// ---------------------------------------------------------------------------------------------

export interface Effector {
  id: string;
  label: string;
  /** [upper, fore, end] bone names; the end bone (hand or foot) carries the effector point. */
  chain: readonly [string, string, string];
  /** The tracked point: (x, y) in `bone`'s frame. */
  point: { bone: string; x: number; y: number };
  /** The leg's IK constraint, when the chain is a leg (the effector is unavailable while it is on). */
  ik?: string;
  /** Set when the effector cannot be generated on this rig / clip. */
  unavailable?: string;
}

const SIDES = ["l", "r", "near", "far"] as const;
const SIDE_LABEL: Record<string, string> = { l: "near", r: "far", near: "near", far: "far" };

/** The weapon tip, both fists and both feet that the rig has. */
export function listEffectors(doc: AnimDocument, clip?: ClipData): Effector[] {
  const names = new Set(doc.bones.map((b) => b.name));
  const byName = new Map(doc.bones.map((b) => [b.name, b]));
  const out: Effector[] = [];
  const handOf = (bone: string): string | null => {
    for (let b = byName.get(bone); b; b = b.parent ? byName.get(b.parent) : undefined) if (/^hand_/.test(b.name)) return b.name;
    return null;
  };
  const armOf = (hand: string): [string, string, string] | null => {
    const side = hand.slice("hand_".length);
    const chain: [string, string, string] = [`upper_arm_${side}`, `forearm_${side}`, hand];
    return chain.every((n) => names.has(n)) ? chain : null;
  };
  // Weapon tip: a point slot named weapon_tip, else a bone of that name.
  let tip: Effector["point"] | null = null;
  const slot = doc.slots.find((s) => s.name === "weapon_tip");
  if (slot) {
    for (const skin of Object.values(doc.skins)) {
      const att = Object.values(skin.attachments[slot.name] ?? {}).find((a) => a.type === "point") as { x?: number; y?: number } | undefined;
      if (att) {
        tip = { bone: slot.bone, x: att.x ?? 0, y: att.y ?? 0 };
        break;
      }
    }
  }
  if (!tip && names.has("weapon_tip")) tip = { bone: "weapon_tip", x: 0, y: 0 };
  const tipHand = tip ? handOf(tip.bone) : null;
  const tipChain = tipHand ? armOf(tipHand) : null;
  if (tip && tipChain) out.push({ id: "weapon-tip", label: "Weapon tip", chain: tipChain, point: tip });
  for (const side of SIDES) {
    const hand = `hand_${side}`;
    const chain = names.has(hand) ? armOf(hand) : null;
    if (chain) out.push({ id: `hand-${side}`, label: `Fist ${SIDE_LABEL[side]} (${hand})`, chain, point: { bone: hand, x: byName.get(hand)!.length ?? 0, y: 0 } });
  }
  for (const side of SIDES) {
    const chain: [string, string, string] = [`thigh_${side}`, `shin_${side}`, `foot_${side}`];
    if (!chain.every((n) => names.has(n))) continue;
    const ik = doc.ik.find((c) => c.bones.includes(chain[0]));
    const clipKeys = ik && clip ? ((clip.ik as unknown as Record<string, { mix?: number }[] | undefined>)[ik.name] ?? []) : [];
    const driven = !!ik && ((ik.mix ?? 1) > 0 || clipKeys.some((k) => (k.mix ?? 0) > 0));
    out.push({
      id: `foot-${side}`,
      label: `Foot ${SIDE_LABEL[side]} (${chain[2]})`,
      chain,
      point: { bone: chain[2], x: byName.get(chain[2])!.length ?? 0, y: 0 },
      ...(ik ? { ik: ik.name } : {}),
      ...(driven ? { unavailable: `${ik!.name} is on: the foot follows its IK target, not the leg rotations` } : {})
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Posing through the runtime
// ---------------------------------------------------------------------------------------------

/** Poses one skeleton at any time of a clip (the motion-path sampler, motionPath.ts, so there is one way to pose a clip headlessly). */
class Poser {
  private readonly sampler: Sampler;
  private readonly fps: number;
  constructor(doc: AnimDocument, name: string, clip: ClipData) {
    this.sampler = makeSampler(doc, name, clip);
    this.fps = clip.fps ?? 30;
  }
  at(time: number): Skeleton {
    return this.sampler.poseFrame(Math.round(time * this.fps));
  }
}

const worldAngle = (b: Bone) => Math.atan2(b.world.c, b.world.a) * DEG;
const rotationSign = (b: Bone) => {
  const p = b.parent?.world;
  return p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
};
function pointOf(sk: Skeleton, e: Effector): Pt {
  const w = sk.findBone(e.point.bone)!.localToWorld(e.point.x, e.point.y, { x: 0, y: 0 });
  return [w.x, w.y];
}
const originOf = (sk: Skeleton, name: string): Pt => {
  const b = sk.findBone(name)!;
  return [b.world.x, b.world.y];
};
const elbowSide = (sk: Skeleton, chain: readonly [string, string, string]): number => {
  const p0 = originOf(sk, chain[0]);
  const e0 = originOf(sk, chain[1]);
  const w0 = originOf(sk, chain[2]);
  return (e0[0] - p0[0]) * (w0[1] - e0[1]) - (e0[1] - p0[1]) * (w0[0] - e0[0]) < -1e-6 ? -1 : 1;
};
/** Rotation offsets from setup of the chain's three bones, as a rotate key stores them. */
const offsetsOf = (sk: Skeleton, chain: readonly [string, string, string]): number[] => chain.map((n) => sk.findBone(n)!.pose.rotation - sk.findBone(n)!.data.rotation);

/**
 * Poses the chain so the wrist origin is at `wrist` (two-bone solve, elbow on `side`) and the end bone's world angle is `angle`.
 * Writes rotations only into `sk`'s pose; the lengths of the segments never change.
 */
function solveChain(sk: Skeleton, chain: readonly [string, string, string], wrist: Pt, side: number, angle: number): void {
  const [upper, fore, end] = chain.map((n) => sk.findBone(n)!) as [Bone, Bone, Bone];
  sk.updateWorldTransform("reset");
  const p0: Pt = [upper.world.x, upper.world.y];
  const l1 = dist(p0, [fore.world.x, fore.world.y]);
  const l2 = dist([fore.world.x, fore.world.y], [end.world.x, end.world.y]);
  const solved = solveTwoBone(p0, l1, l2, wrist, side);
  upper.pose.rotation += rotationSign(upper) * wrap(Math.atan2(solved.elbow[1] - p0[1], solved.elbow[0] - p0[0]) * DEG - worldAngle(upper));
  sk.updateWorldTransform("reset");
  fore.pose.rotation += rotationSign(fore) * wrap(Math.atan2(solved.wrist[1] - fore.world.y, solved.wrist[0] - fore.world.x) * DEG - worldAngle(fore));
  sk.updateWorldTransform("reset");
  end.pose.rotation += rotationSign(end) * wrap(angle - worldAngle(end));
  sk.updateWorldTransform("reset");
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

export interface TweenOptions {
  /** The frame range; both ends are waypoints (they need not be keys). */
  a: number;
  b: number;
  /** Effector ids from listEffectors. */
  effectors: readonly string[];
  /** Arc bias: the span bows sideways by bias * chord at its middle (0 = the plain spline, negative bows the other way). */
  bias: number;
  spacing: SpacingId;
  /** Bake a key every `step` frames (default 1). Ignored when `frames` is set. */
  step?: number;
  /** Breakdown mode: bake keys only at these frames. */
  frames?: readonly number[];
  /** Frames to leave out (the user chose "skip" for a flagged frame). */
  skip?: readonly number[];
}

export interface TweenViolation {
  frame: number;
  rule: PoseRule | "unreachable";
  message: string;
  bones: string[];
}

export interface EffectorPlan {
  effector: string;
  label: string;
  /** The effector's path as the clip stands: one point per frame a..b. */
  original: { frame: number; x: number; y: number }[];
  /** The planned spline: one point per frame a..b (the effector lands here at the generated frames). */
  planned: { frame: number; x: number; y: number }[];
  /** How far the path as the clip stands bulges off its chords (sagitta over chord, chord-weighted): the arc bias that keeps its natural arc. */
  natural: number;
  /** A dense sampling of the planned curve for drawing. */
  curve: Pt[];
  /** Waypoint frames. */
  waypoints: number[];
  /** Frames baked. */
  generated: number[];
}

export interface TweenResult {
  clip: ClipData;
  /** Bone -> frames keyed. */
  keyed: Record<string, number[]>;
  keys: number;
  plans: EffectorPlan[];
  /** Largest distance (px) from a baked frame's effector to the planned spline. */
  maxError: number;
  violations: TweenViolation[];
  /** Frames (sorted, unique) with a violation. */
  flagged: number[];
  notes: string[];
}

function insertRotate(clip: ClipData, bone: string, time: number, value: number): void {
  const tl = (clip.bones[bone] ??= {});
  const keys = (tl.rotate ??= []);
  const at = keys.findIndex((k) => Math.abs(k.time - time) < KEY_EPSILON);
  const key = { time: at >= 0 ? keys[at]!.time : time, value: round4(value), curve: at >= 0 ? keys[at]!.curve : ("linear" as const) };
  if (at >= 0) keys[at] = key as (typeof keys)[number];
  else {
    keys.push(key as (typeof keys)[number]);
    keys.sort((p, q) => p.time - q.time);
  }
}

/** The pose rule hits at one pose, keyed by rule. */
function hitsAt(poser: Poser, reference: Reference, time: number): Map<PoseRule, { message: string; bones: string[] }> {
  const sk = poser.at(time);
  const out = new Map<PoseRule, { message: string; bones: string[] }>();
  for (const h of poseRuleHits(sk, reference)) if (!out.has(h.rule)) out.set(h.rule, { message: h.message, bones: h.bones });
  return out;
}

const CURVE_SAMPLES = 14;
/** +1 when the chord's left normal points away from `root`, else -1 (the bow side when the clip's own path is straight). */
function awayFromRoot(p1: Pt, p2: Pt, root: Pt): number {
  const nx = -(p2[1] - p1[1]);
  const ny = p2[0] - p1[0];
  return nx * ((p1[0] + p2[0]) / 2 - root[0]) + ny * ((p1[1] + p2[1]) / 2 - root[1]) < 0 ? -1 : 1;
}
/** A baked frame whose effector lands farther than this (px) from the planned point could not be reached. */
const REACH_TOLERANCE = 0.5;
/** End-bone angle bends tried (degrees from the planned angle, smallest first) when the planned angle cannot reach the arc. */
const BENDS: readonly number[] = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 3, -3, 4, -4, 5, -5, 7, -7, 10, -10, 15, -15, 20, -20, 25, -25, 30, -30, 35, -35, 50, -50, 70, -70];
/** Cost of one degree of end-bone angle bend against one degree of elbow change from the previous frame. */
const BEND_WEIGHT = 0.5;
/** Bends past this are only tried when nothing smaller reaches the arc. */
const SOFT_BEND = 35;

/** Builds the in-betweens. Never mutates `clip`; the result clip is a copy. */
export function generateTween(doc: AnimDocument, clipName: string, clip: ClipData, opts: TweenOptions): TweenResult {
  const notes: string[] = [];
  const a = Math.round(Math.min(opts.a, opts.b));
  const b = Math.round(Math.max(opts.a, opts.b));
  const empty = (): TweenResult => ({ clip, keyed: {}, keys: 0, plans: [], maxError: 0, violations: [], flagged: [], notes });
  if (b - a < 2) {
    notes.push("The range needs at least one frame between its ends.");
    return empty();
  }
  const all = listEffectors(doc, clip);
  let effs = opts.effectors.map((id) => all.find((e) => e.id === id)).filter((e): e is Effector => !!e);
  for (const e of effs.filter((x) => x.unavailable)) notes.push(`${e.label}: ${e.unavailable}`);
  effs = effs.filter((e) => !e.unavailable);
  // The weapon tip already places its hand: a fist effector on the same arm would fight it.
  const tipEff = effs.find((e) => e.id === "weapon-tip");
  if (tipEff) {
    for (const e of effs.filter((x) => x !== tipEff && x.chain[0] === tipEff.chain[0])) notes.push(`${e.label}: skipped, the weapon tip already places this arm`);
    effs = effs.filter((e) => e === tipEff || e.chain[0] !== tipEff.chain[0]);
  }
  if (!effs.length) {
    notes.push("No effector to generate.");
    return empty();
  }

  const fps = clip.fps ?? 30;
  const timeOf = (f: number) => snapTime(clip, f / fps);
  const poser = new Poser(doc, clipName, clip);
  const result = structuredClone(clip);
  const skip = new Set(opts.skip ?? []);
  const keyed: Record<string, number[]> = {};
  const plans: EffectorPlan[] = [];
  const generatedByFrame = new Map<number, string[]>();
  const waypointsAll = new Set<number>([a, b]);
  const step = Math.max(1, Math.round(opts.step ?? 1));
  let maxError = 0;
  const violations: TweenViolation[] = [];

  for (const eff of effs) {
    const chainKeyFrames = new Set<number>();
    for (const bone of eff.chain) for (const k of clip.bones[bone]?.rotate ?? []) chainKeyFrames.add(timeToFrame(clip, k.time));
    const waypoints = [a, ...[...chainKeyFrames].filter((f) => f > a && f < b).sort((p, q) => p - q), b];
    waypoints.forEach((f) => waypointsAll.add(f));
    // Waypoint samples.
    const pts: Pt[] = [];
    const roots: Pt[] = [];
    const angles: number[] = [];
    const elbows: number[] = [];
    const offs: number[][] = [];
    for (const f of waypoints) {
      const sk = poser.at(timeOf(f));
      pts.push(pointOf(sk, eff));
      roots.push(originOf(sk, eff.chain[0]));
      angles.push(worldAngle(sk.findBone(eff.chain[2])!));
      elbows.push(elbowSide(sk, eff.chain));
      offs.push(offsetsOf(sk, eff.chain));
    }
    const original: EffectorPlan["original"] = [];
    for (let f = a; f <= b; f++) {
      const o = pointOf(poser.at(timeOf(f)), eff);
      original.push({ frame: f, x: o[0], y: o[1] });
    }
    // The side each span bows to is the side the clip's own path bulges to; the bulge size is the "natural" arc.
    const sides: number[] = [];
    let natNum = 0;
    let natDen = 0;
    for (let j = 0; j < waypoints.length - 1; j++) {
      const p1 = pts[j]!;
      const chord = dist(p1, pts[j + 1]!);
      let dev = 0;
      for (const o of original.filter((q) => q.frame > waypoints[j]! && q.frame < waypoints[j + 1]!)) {
        const d = (-(pts[j + 1]![1] - p1[1]) * (o.x - p1[0]) + (pts[j + 1]![0] - p1[0]) * (o.y - p1[1])) / Math.max(chord, 1e-6);
        if (Math.abs(d) > Math.abs(dev)) dev = d;
      }
      const frac = chord > 1e-6 ? dev / chord : 0;
      sides.push(Math.abs(frac) < 0.02 ? 0 : Math.sign(frac));
      natNum += Math.abs(frac) * chord;
      natDen += chord;
    }
    const natural = natDen > 0 ? natNum / natDen : 0;
    const path = buildPath(waypoints, pts, roots, angles, opts.bias, sides.map((x, j) => x || awayFromRoot(pts[j]!, pts[j + 1]!, roots[j]!)));
    const planned: EffectorPlan["planned"] = [];
    for (let f = a; f <= b; f++) {
      const { j, p } = spanOf(path, f);
      const q = pathPoint(path, j, spacingAt(opts.spacing, p));
      planned.push({ frame: f, x: q[0], y: q[1] });
    }
    const curve: Pt[] = [];
    for (let j = 0; j < waypoints.length - 1; j++) for (let i = 0; i <= CURVE_SAMPLES; i++) curve.push(pathPoint(path, j, i / CURVE_SAMPLES));

    // Frames to bake: not a key of this chain, in the chosen set, not skipped.
    const wanted: number[] = [];
    if (opts.frames) for (const f of opts.frames) wanted.push(Math.round(f));
    else for (let f = a + step; f < b; f += step) wanted.push(f);
    const still = pts.every((p) => dist(p, pts[0]!) < 1) && angles.every((x) => Math.abs(wrap(x - angles[0]!)) < 0.5);
    if (still) notes.push(`${eff.label}: does not move between the keys, nothing to generate`);
    const gen = still ? [] : [...new Set(wanted)].filter((f) => f > a && f < b && !skip.has(f) && !eff.chain.some((n) => hasKey(clip, n, "rotate", timeOf(f)))).sort((p, q) => p - q);

    // Solve each frame, then unwrap the angles so a key never spins a full turn from its neighbour.
    const rows: { frame: number; values: number[]; err: number; reached: boolean }[] = [];
    const bent: [number, number][] = [];
    let seqSpan = -1;
    let seqPrev: number[] = [];
    for (const f of gen) {
      const { j, p } = spanOf(path, f);
      const u = spacingAt(opts.spacing, p);
      const target = pathPoint(path, j, u);
      const planAngle = pathAngle(path, j, u);
      if (j !== seqSpan) {
        seqSpan = j;
        seqPrev = [...offs[j]!];
      }
      const side = p < 0.5 ? elbows[j]! : elbows[j + 1]!;
      // One degree of freedom is free: the end bone's angle. Among the angles that put the effector on the arc, take the one whose
      // arm stays closest to the previous frame's solution (so the elbow bend stays continuous and never folds), bending the
      // planned angle as little as possible. Bends past SOFT_BEND are a last resort.
      let best: { values: number[]; err: number; bend: number; cost: number } | null = null;
      for (const bend of BENDS) {
        if (Math.abs(bend) > SOFT_BEND && best && best.err < REACH_TOLERANCE) break;
        const sk = poser.at(timeOf(f));
        const end = sk.findBone(eff.chain[2])!;
        const tip0 = pointOf(sk, eff);
        const angle = planAngle + bend;
        const dA = (angle - worldAngle(end)) / DEG;
        const v0: Pt = [tip0[0] - end.world.x, tip0[1] - end.world.y];
        let wrist: Pt = [target[0] - (v0[0] * Math.cos(dA) - v0[1] * Math.sin(dA)), target[1] - (v0[0] * Math.sin(dA) + v0[1] * Math.cos(dA))];
        let err = Infinity;
        for (let it = 0; it < 6; it++) {
          solveChain(sk, eff.chain, wrist, side, angle);
          const now = pointOf(sk, eff);
          err = dist(now, target);
          if (err < 0.02) break;
          wrist = [wrist[0] + (target[0] - now[0]), wrist[1] + (target[1] - now[1])];
        }
        const values = offsetsOf(sk, eff.chain);
        const cost = Math.abs(wrap(values[1]! - seqPrev[1]!)) + 0.5 * Math.abs(wrap(values[0]! - seqPrev[0]!)) + BEND_WEIGHT * Math.abs(bend);
        const ok = err < REACH_TOLERANCE;
        const bestOk = !!best && best.err < REACH_TOLERANCE;
        if (!best || (ok && (!bestOk || cost < best.cost)) || (!ok && !bestOk && err < best.err - 1e-9)) best = { values, err, bend, cost };
      }
      seqPrev = best!.values;
      if (best!.bend && best!.err < REACH_TOLERANCE) bent.push([f, best!.bend]);
      rows.push({ frame: f, values: best!.values, err: best!.err, reached: best!.err < REACH_TOLERANCE });
    }
    if (bent.length) notes.push(`${eff.label}: the end bone's angle was bent up to ${Math.max(...bent.map(([, d]) => Math.abs(d)))} degrees at frame${bent.length === 1 ? "" : "s"} ${bent.map(([f]) => f).join(", ")} to stay on the arc`);
    let prev: number[] = [];
    let prevSpan = -1;
    for (const r of rows) {
      const j = spanOf(path, r.frame).j;
      if (j !== prevSpan) {
        prev = [...offs[j]!];
        prevSpan = j;
      }
      r.values = r.values.map((v, i) => v + 360 * Math.round((prev[i]! - v) / 360));
      prev = [...r.values];
    }
    // A bone with no key at a waypoint would hold the first baked value back to the waypoint: pin it to the pose it has there.
    const anchorSpans = new Set(rows.flatMap((r) => [spanOf(path, r.frame).j, spanOf(path, r.frame).j + 1]));
    for (const w of anchorSpans) {
      const t = timeOf(waypoints[w]!);
      eff.chain.forEach((bone, i) => {
        if (hasKey(clip, bone, "rotate", t) || (keyed[bone] ?? []).includes(waypoints[w]!)) return;
        insertRotate(result, bone, t, offs[w]![i]!);
        (keyed[bone] ??= []).push(waypoints[w]!);
      });
    }
    for (const r of rows) {
      maxError = Math.max(maxError, r.reached ? r.err : 0);
      eff.chain.forEach((bone, i) => {
        insertRotate(result, bone, timeOf(r.frame), r.values[i]!);
        (keyed[bone] ??= []).push(r.frame);
      });
      generatedByFrame.set(r.frame, [...(generatedByFrame.get(r.frame) ?? []), eff.id]);
      if (!r.reached) violations.push({ frame: r.frame, rule: "unreachable", message: `${eff.label} cannot reach the planned path at frame ${r.frame} (the arm or leg is too short): it stops ${r.err.toFixed(0)} px short`, bones: [...eff.chain] });
    }
    plans.push({ effector: eff.id, label: eff.label, original, planned, natural, curve, waypoints, generated: gen });
  }

  // Rule safety: every generated frame, against the keys around it.
  const keyCount = Object.values(keyed).reduce((n, f) => n + new Set(f).size, 0);
  if (keyCount) {
    const setup = new Skeleton(doc);
    setup.setToSetupPose();
    setup.updateWorldTransform("reset");
    const reference = referenceOf(setup);
    const after = new Poser(doc, clipName, result);
    const wp = [...waypointsAll].sort((p, q) => p - q);
    const keyHits = new Map<number, Map<PoseRule, { message: string; bones: string[] }>>();
    const keyHitsAt = (f: number) => keyHits.get(f) ?? keyHits.set(f, hitsAt(after, reference, timeOf(f))).get(f)!;
    for (const f of [...generatedByFrame.keys()].sort((p, q) => p - q)) {
      const lo = [...wp].reverse().find((w) => w < f) ?? a;
      const hi = wp.find((w) => w > f) ?? b;
      const around = [keyHitsAt(lo), keyHitsAt(hi)];
      for (const [rule, hit] of hitsAt(after, reference, timeOf(f))) {
        if (around.some((m) => m.has(rule))) continue;
        violations.push({ frame: f, rule, message: hit.message, bones: hit.bones });
      }
    }
  }
  violations.sort((p, q) => p.frame - q.frame);
  const flagged = [...new Set(violations.map((v) => v.frame))];
  return { clip: result, keyed, keys: keyCount, plans, maxError, violations, flagged, notes };
}

/**
 * "Adjust arc": retries the generation with other biases and returns the one with the fewest flagged frames (ties keep the nearest to the
 * current bias). Null when no other bias does better than the current one.
 */
export function adjustArc(doc: AnimDocument, clipName: string, clip: ClipData, opts: TweenOptions, current?: TweenResult): { bias: number; result: TweenResult } | null {
  const base = current ?? generateTween(doc, clipName, clip, opts);
  const score = (r: TweenResult) => r.violations.length;
  let best: { bias: number; result: TweenResult } | null = null;
  const b = opts.bias;
  const candidates = [b * 0.5, 0, -b * 0.5, -b, b * 1.5, 0.15, -0.15, 0.4, -0.4, 0.7, -0.7].map((v) => Math.round(v * 100) / 100);
  for (const bias of [...new Set(candidates)].filter((v) => v !== b)) {
    const result = generateTween(doc, clipName, clip, { ...opts, bias });
    if (score(result) < (best ? score(best.result) : score(base))) best = { bias, result };
    else if (best && score(result) === score(best.result) && Math.abs(bias - b) < Math.abs(best.bias - b)) best = { bias, result };
    if (best && score(best.result) === 0) break;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Generated-key markers
// ---------------------------------------------------------------------------------------------

/** Clip name -> "bone|time" -> the value that was baked. A key counts as generated only while it still holds that value. */
const registry = new Map<string, Map<string, number>>();
const regKey = (bone: string, time: number) => `${bone}|${Math.round(time * 1e4)}`;

/** Remembers the keys `result` baked into `clipName`. */
export function markGenerated(clipName: string, clip: ClipData, result: TweenResult): void {
  const map = registry.get(clipName) ?? new Map<string, number>();
  for (const [bone, frames] of Object.entries(result.keyed)) {
    for (const f of frames) {
      const t = snapTime(clip, frameTime(clip, f));
      const key = (result.clip.bones[bone]?.rotate ?? []).find((k) => Math.abs(k.time - t) < KEY_EPSILON);
      if (key) map.set(regKey(bone, key.time), key.value);
    }
  }
  registry.set(clipName, map);
}

/** True when the bone's rotate key at `time` is still the one the tool baked. */
export function isGeneratedKey(clipName: string, clip: ClipData, bone: string, time: number): boolean {
  const want = registry.get(clipName)?.get(regKey(bone, time));
  if (want === undefined) return false;
  const key = clip.bones[bone]?.rotate?.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
  return !!key && Math.abs(key.value - want) < 1e-6;
}

/** Every still-generated key of the clip: [bone, time]. */
export function generatedKeys(clipName: string, clip: ClipData): [string, number][] {
  const out: [string, number][] = [];
  for (const [bone, tl] of Object.entries(clip.bones)) for (const k of tl.rotate ?? []) if (isGeneratedKey(clipName, clip, bone, k.time)) out.push([bone, k.time]);
  return out;
}

/** The clip without its generated keys (keys the user moved or re-keyed since are left alone). */
export function clearGenerated(clipName: string, clip: ClipData): { clip: ClipData; removed: number } {
  const gen = generatedKeys(clipName, clip);
  let next = clip;
  for (const [bone, time] of gen) next = deleteKeys(next, bone, time, "rotate");
  const map = registry.get(clipName);
  for (const [bone, time] of gen) map?.delete(regKey(bone, time));
  return { clip: next, removed: gen.length };
}

/** Drops all remembered markers (tests, or a clip that was deleted). */
export function forgetGenerated(clipName?: string): void {
  if (clipName) registry.delete(clipName);
  else registry.clear();
}

/** The remembered generated keys, for saving next to the clips: clip name -> [bone, time, value][]. */
export function exportMarks(): Record<string, [string, number, number][]> {
  const out: Record<string, [string, number, number][]> = {};
  for (const [clip, map] of registry) {
    const rows: [string, number, number][] = [];
    for (const [key, value] of map) {
      const at = key.lastIndexOf("|");
      rows.push([key.slice(0, at), Number(key.slice(at + 1)) / 1e4, value]);
    }
    if (rows.length) out[clip] = rows;
  }
  return out;
}

/** Restores remembered generated keys (keys the clip no longer holds with that value simply do not show as generated). */
export function importMarks(marks: Record<string, unknown>): void {
  for (const [clip, rows] of Object.entries(marks)) {
    if (!Array.isArray(rows)) continue;
    const map = registry.get(clip) ?? new Map<string, number>();
    for (const r of rows) if (Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(r[1]) && Number.isFinite(r[2])) map.set(regKey(r[0], r[1] as number), r[2] as number);
    registry.set(clip, map);
  }
}
