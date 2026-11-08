/*
 * Atlas Animator editor: original implementation.
 *
 * The maths behind the live gate HUD (pure, no DOM): IK reach of the posed skeleton and of every frame of a clip. The pose rules come
 * from ruleOverlay.ts (liveFindings / clipFindings); the outline gate lives in gateOverlay.ts.
 */
import { AnimationState, AnimationStateData, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { ikReaches, MAX_IK_REACH } from "@atlas-animator/core/tools/ikReach";
import { frameCount, frameTime } from "./clipModel.js";
import { withClip } from "./gates.js";

/** Reach ratios above this read as "nearly at full stretch" (a warning); above MAX_IK_REACH the validator fails the clip. */
export const IK_WARN_REACH = 0.97;

export interface IkFinding {
  /** IK constraint name. */
  name: string;
  ratio: number;
  level: "warn" | "fail";
  text: string;
  /** The bone to select (the constraint's target). */
  bone: string;
}

/** "hand_ik_near" -> "hand near". */
export const ikWords = (name: string): string => name.split(/[_-]+/).filter((w) => w && w.toLowerCase() !== "ik").join(" ") || name;

export function ikText(name: string, ratio: number): string {
  const who = ikWords(name);
  if (ratio > 1 + 1e-6) return `IK ${who}: target out of reach (${Math.round(ratio * 100)}%)`;
  if (ratio > MAX_IK_REACH + 1e-6) return `IK ${who}: at full stretch (${Math.round(ratio * 100)}%, limit ${Math.round(MAX_IK_REACH * 1000) / 10}%)`;
  return `IK ${who}: nearly straight (${Math.round(ratio * 100)}%)`;
}

/** How far past its own rest reach a chain must go before it counts (a leg that is straight in the setup pose is not a posing fault). */
export const REST_SLACK = 0.01;

const rests = new WeakMap<AnimDocument, Map<string, number>>();

/** The reach ratio of every IK chain in the rig's setup pose, remembered per rig document. */
export function restReaches(doc: AnimDocument): Map<string, number> {
  let m = rests.get(doc);
  if (!m) {
    m = new Map();
    if (doc.ik.length) {
      const bare = new Skeleton(doc);
      bare.setToSetupPose();
      bare.updateWorldTransform("reset");
      for (const r of ikReaches(bare)) m.set(r.name, r.ratio);
    }
    rests.set(doc, m);
  }
  return m;
}

/**
 * IK constraints near or past full stretch on a posed skeleton (world updated). With `rest` (restReaches), a chain only counts when it is
 * stretched further than the rig's own rest pose by REST_SLACK, so a rig whose legs are straight at rest does not read red on every frame.
 */
export function ikFindings(skeleton: Skeleton, rest?: ReadonlyMap<string, number>): IkFinding[] {
  const out: IkFinding[] = [];
  for (const r of ikReaches(skeleton)) {
    if (r.ratio <= IK_WARN_REACH || (rest && r.ratio <= (rest.get(r.name) ?? 0) + REST_SLACK)) continue;
    const c = skeleton.ikConstraints.find((k) => k.data.name === r.name);
    out.push({ name: r.name, ratio: r.ratio, level: r.ratio > MAX_IK_REACH + 1e-6 ? "fail" : "warn", text: ikText(r.name, r.ratio), bone: c?.target.data.name ?? r.name });
  }
  return out;
}

/** Every frame of `clip` where an IK chain is near or past full stretch. Frame -> findings (frames that are fine are absent). */
export function clipIkFindings(doc: AnimDocument, name: string, clip: ClipData): Map<number, IkFinding[]> {
  const out = new Map<number, IkFinding[]>();
  if (!doc.ik.length) return out;
  const rig = withClip(doc, name, clip);
  const skeleton = new Skeleton(rig);
  const data = new AnimationStateData(rig);
  const rest = restReaches(doc);
  const last = clip.loop ? frameCount(clip) - 1 : frameCount(clip);
  for (let f = 0; f <= last; f++) {
    skeleton.setToSetupPose();
    const state = new AnimationState(data);
    state.setAnimation(0, name, { loop: clip.loop });
    const t = frameTime(clip, f);
    state.update(clip.loop ? Math.min(t, Math.max(0, clip.duration - 1e-4)) : t);
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
    const hits = ikFindings(skeleton, rest);
    if (hits.length) out.set(f, hits);
  }
  return out;
}

const cache = new WeakMap<ClipData, { doc: AnimDocument; name: string; result: Map<number, IkFinding[]> }>();

/** `clipIkFindings`, remembered per clip object (a commit makes a new clip object, so an edit is always re-checked). */
export function clipIkFindingsCached(doc: AnimDocument, name: string, clip: ClipData): Map<number, IkFinding[]> {
  const hit = cache.get(clip);
  if (hit && hit.doc === doc && hit.name === name) return hit.result;
  const result = clipIkFindings(doc, name, clip);
  cache.set(clip, { doc, name, result });
  return result;
}

/** The next frame after `from` (wrapping) that is in `frames`, or null when `frames` is empty. `dir` -1 looks backwards. */
export function nextBadFrame(frames: readonly number[], from: number, dir: 1 | -1 = 1): number | null {
  if (!frames.length) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  if (dir > 0) return sorted.find((f) => f > from) ?? sorted[0]!;
  return [...sorted].reverse().find((f) => f < from) ?? sorted[sorted.length - 1]!;
}
