/*
 * Atlas Animator editor: original implementation.
 *
 * Live gate feedback for the pose under the playhead, through the runtime's own entry points:
 * - format: `clipSchema` on the clip as it would be saved, plus `findReferenceIssues` (unknown
 *   bones / constraints, keys past the end) on the rig with this clip;
 * - the user's pose rules (poseRules.ts: fist on its own arm, weapon never across the face, eyes never widen (always errors), no arm behind the head, no upper arm thrown straight back,
 *   no limb stretch, head scale +-3%, limb bones never scaled: always a warning) on the posed skeleton;
 * - per-bone rotation limits (`bones[].limits`, relative to setup) on the sampled local pose.
 * Severity: format and reference problems always block. The pose rules and bone ranges are errors on
 * a looping clip (a loop must stay clean) and warnings on any other clip (combat swings go past them
 * on purpose). Unkeyed gizmo edits are checked as if keyed at the playhead (what Set Key would write).
 */
import { AnimationState, AnimationStateData, clipSchema, findReferenceIssues, formatIssuePath, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { clipSampleTimes } from "@atlas-animator/core/tools/liveLimits";
import { setRotateKey, setVectorKey, writeClip } from "./clipModel.js";
import { eventIssues } from "./eventModel.js";
import { poseRuleHits, referenceOf, type PoseRule } from "./poseRules.js";

export type GateKind = "format" | "reference" | PoseRule | "bone limit" | "event timing" | "mirror" | "outline";

export interface GateIssue {
  kind: GateKind;
  severity: "error" | "warning" | "info";
  message: string;
  time?: number;
}

/**
 * Issues found by checks that need the renderer (the outline continuity gate renders both pro rigs, so it cannot run inside these pure
 * functions). The module that ran the check hands them over with `setExternalGateIssues` (clip name -> issues, each with its `time`), and
 * `clipGates` / `poseGates` add them as warnings. `clearExternalGateIssues` drops them when the clip, the worn items or the rig change.
 */
const externalIssues = new Map<string, GateIssue[]>();

export function setExternalGateIssues(source: string, issues: readonly GateIssue[]): void {
  if (issues.length) externalIssues.set(source, [...issues]);
  else externalIssues.delete(source);
}

export function clearExternalGateIssues(source?: string): void {
  if (source === undefined) externalIssues.clear();
  else externalIssues.delete(source);
}

/** The handed-over issues of a clip; with `time`, only those at that pose. */
export function externalGateIssues(source: string, time?: number): GateIssue[] {
  const all = externalIssues.get(source) ?? [];
  return time === undefined ? all : all.filter((i) => i.time !== undefined && Math.abs(i.time - time) < 1e-4);
}

export function withClip(doc: AnimDocument, name: string, clip: ClipData): AnimDocument {
  return { ...doc, animations: { [name]: clip } };
}

/** The clip with unkeyed rotate offsets keyed at `time` (what Set Key on each bone would write). */
export function clipWithPending(
  clip: ClipData,
  time: number,
  pending: Readonly<Record<string, number>>,
  moves: Readonly<Record<string, { x: number; y: number }>> = {},
  scales: Readonly<Record<string, { x: number; y: number }>> = {},
  shears: Readonly<Record<string, { x: number; y: number }>> = {}
): ClipData {
  let next = clip;
  for (const [bone, m] of Object.entries(scales)) next = setVectorKey(next, bone, "scale", time, m.x, m.y);
  for (const [bone, m] of Object.entries(shears)) next = setVectorKey(next, bone, "shear", time, m.x, m.y);
  for (const [bone, value] of Object.entries(pending)) next = setRotateKey(next, bone, time, value);
  for (const [bone, m] of Object.entries(moves)) next = setVectorKey(next, bone, "translate", time, m.x, m.y);
  return next;
}

/** Pose rules and bone ranges block only on a loop; any other clip (combat, one-shot) gets warnings. */
export function limitSeverity(clip: ClipData): "error" | "warning" {
  return clip.loop ? "error" : "warning";
}

/**
 * Bone ranges and the user's pose rules at each time, from one skeleton posed through the runtime.
 * (The runtime ties a state to the document its skeleton was built from: both are built from `doc`.)
 */
function poseLimitIssues(doc: AnimDocument, name: string, times: readonly number[], severity: "error" | "warning"): GateIssue[] {
  const skeleton = new Skeleton(doc);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("reset");
  const reference = referenceOf(skeleton);
  const data = new AnimationStateData(doc);
  const duration = doc.animations[name]?.duration ?? 0;
  const out: GateIssue[] = [];
  for (const time of times) {
    skeleton.setToSetupPose();
    const state = new AnimationState(data);
    // The loop flag is the clip's own: the runtime clamps bone ranges on a loop and lifts them on a one-shot.
    state.setAnimation(0, name, { loop: severity === "error" });
    state.update(severity === "error" ? Math.min(time, Math.max(0, duration - 1e-4)) : time);
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
    for (const bone of skeleton.bones) {
      const limits = bone.data.limits;
      if (!limits) continue;
      const offset = bone.pose.rotation - bone.data.rotation;
      if (offset < limits.min - 1e-4 || offset > limits.max + 1e-4) {
        out.push({ kind: "bone limit", severity, time, message: `${bone.data.name} ${offset.toFixed(1)}° outside its range ${limits.min}..${limits.max}°` });
      }
    }
    for (const hit of poseRuleHits(skeleton, reference)) out.push({ kind: hit.rule, severity: hit.severity ?? severity, time, message: hit.message });
  }
  return out;
}

function formatIssues(doc: AnimDocument, name: string, clip: ClipData): GateIssue[] {
  const out: GateIssue[] = [];
  const parsed = clipSchema.safeParse(writeClip(clip));
  if (!parsed.success) for (const issue of parsed.error.issues) out.push({ kind: "format", severity: "error", message: `${issue.path.join(".") || "clip"}: ${issue.message}` });
  for (const issue of findReferenceIssues(withClip(doc, name, clip))) {
    if (issue.path[0] !== "animations") continue;
    out.push({ kind: "reference", severity: issue.severity, message: `${formatIssuePath(issue.path.slice(2))}: ${issue.message}` });
  }
  return out;
}

/** Issues of the pose at `time` (held time) of `clip` on `doc` (the shown rig). */
export function poseGates(
  doc: AnimDocument,
  name: string,
  clip: ClipData,
  time: number,
  pending: Readonly<Record<string, number>> = {},
  moves: Readonly<Record<string, { x: number; y: number }>> = {},
  scales: Readonly<Record<string, { x: number; y: number }>> = {},
  shears: Readonly<Record<string, { x: number; y: number }>> = {}
): GateIssue[] {
  const edited = Object.keys(pending).length || Object.keys(moves).length || Object.keys(scales).length || Object.keys(shears).length;
  const effective = edited ? clipWithPending(clip, time, pending, moves, scales, shears) : clip;
  const out = formatIssues(doc, name, effective);
  if (out.some((i) => i.severity === "error")) return out;
  out.push(...poseLimitIssues(withClip(doc, name, effective), name, [time], limitSeverity(effective)));
  out.push(...timingIssues(effective));
  out.push(...externalGateIssues(`outline:${name}`, time));
  return out;
}

/** Event markers off their profile frame (warnings: timing is the). */
function timingIssues(clip: ClipData): GateIssue[] {
  return eventIssues(clip).map((i) => ({ kind: "event timing" as const, severity: "warning" as const, message: i.message, time: i.time }));
}

/** Whole-clip check: every sample time `animator validate` and the live check use. */
export function clipGates(doc: AnimDocument, name: string, clip: ClipData): GateIssue[] {
  const out = formatIssues(doc, name, clip);
  if (out.some((i) => i.severity === "error")) return out;
  const rig = withClip(doc, name, clip);
  out.push(...timingIssues(clip));
  out.push(...externalGateIssues(`outline:${name}`));
  out.push(...poseLimitIssues(rig, name, clipSampleTimes(rig, name), limitSeverity(clip)).map((i) => ({ ...i, message: i.message.replace(/ -?[\d.]+° outside/, " outside") })));
  // One line per (kind, message) run: keep the first time of each.
  const seen = new Set<string>();
  return out.filter((i) => {
    const key = `${i.kind}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
