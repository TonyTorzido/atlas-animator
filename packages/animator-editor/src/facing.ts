/*
 * Atlas Animator editor: original implementation.
 *
 * Facing right. The game animates and draws ONE facing, the left-facing turned view, and shows right as that same view mirrored.
 *
 * RUNTIME CONTRACT (the same for the editor preview, the Pixi render path and the Spine export):
 *   - There is no right-facing clip and no right-facing rig. Facing right is the left-facing character with its root flipped
 *     horizontally: `scale.x = -1` on the Pixi container that holds the character (`applyFacing`), or `skeleton.scaleX = -1` on a
 *     Spine runtime skeleton (`spineFacing`). The flip is about the character's own origin, so the feet stay put.
 *   - Clip, rig and atlas are shared and untouched; nothing is baked into keys. Mirroring a clip into a second clip is the one
 *     thing not to do (it drifts the moment either facing is edited).
 *   - Anything that places other things from the character in screen space (weapon trails, hit effects, hand-held props placed by
 *     world position) has to read the flip too: `facingSign(facing)` is the multiplier.
 *   - The editor's "Preview facing right" toggle does exactly this to the character, and `mirrorGates` lists what a flip breaks.
 * exportSpine.ts (the Spine export) writes the left-facing skeleton only and must not emit a mirrored twin: a Spine game sets
 * `skeleton.scaleX = spineFacing("right").scaleX` at runtime.
 */
import { AnimationState, AnimationStateData, Skeleton, type AnimDocument, type Bone, type ClipData } from "@atlas-animator/core/core";
import { clipSampleTimes } from "@atlas-animator/core/tools/liveLimits";
import type { GateIssue } from "./gates.js";
import { withClip } from "./gates.js";

export type Facing = "left" | "right";

/** Multiplier for horizontal screen-space offsets: 1 facing left (the authored facing), -1 facing right. */
export const facingSign = (facing: Facing): 1 | -1 => (facing === "right" ? -1 : 1);

/** Applies the facing to the node holding the character: the one place the mirror lives. */
export function applyFacing(root: { scale: { x: number } }, facing: Facing): void {
  root.scale.x = facingSign(facing) * Math.abs(root.scale.x || 1);
}

/** The Spine runtime fields for a facing (`skeleton.scaleX = ...`); a Spine export never carries a mirrored skeleton. */
export function spineFacing(facing: Facing): { scaleX: 1 | -1 } {
  return { scaleX: facingSign(facing) };
}

const SIDE = /^(.*?)[_.-](l|r|left|right|near|far)$/i;
const OPPOSITE: Record<string, string> = { l: "r", r: "l", left: "right", right: "left", near: "far", far: "near" };
const WEAPON = /weapon|axe|sword|staff|bow|shield|grip/i;

const sidedKey = (name: string): { base: string; side: string } | null => {
  const m = SIDE.exec(name);
  return m ? { base: m[1]!, side: m[2]!.toLowerCase() } : null;
};

/** The opposite-side name of a sided name (hand_l -> hand_r, arm_near -> arm_far), or null. */
function twinName(name: string): string | null {
  const s = sidedKey(name);
  if (!s) return null;
  const raw = name.slice(name.length - s.side.length);
  const opposite = OPPOSITE[s.side]!;
  return name.slice(0, name.length - s.side.length) + (raw === raw.toUpperCase() ? opposite.toUpperCase() : opposite);
}

/**
 * Document-level mirror findings (no posing): pieces that a flip cannot treat the same on both sides.
 * - unpaired side pieces: a `_l` bone or slot with no `_r` twin (or near without far), an asymmetric piece;
 * - side pairs whose setup size differs;
 * - bones whose inherit mode refuses a reflection (noScaleOrReflection, noScale, noRotation, onlyTranslation): under a root flip
 *   they do not follow the mirror;
 * - weapon-hand assumptions: a weapon / grip bone under a side hand, which stays in that hand when mirrored.
 */
export function mirrorStaticIssues(doc: AnimDocument): GateIssue[] {
  const out: GateIssue[] = [];
  const bones = new Map(doc.bones.map((b) => [b.name, b]));
  const warn = (message: string): void => {
    out.push({ kind: "mirror", severity: "warning", message });
  };
  for (const bone of doc.bones) {
    const twin = twinName(bone.name);
    if (!twin) continue;
    const other = bones.get(twin);
    if (!other) {
      if (!bone.helper) warn(`${bone.name} has no ${twin} twin: an asymmetric piece (it will mirror to the wrong side)`);
      continue;
    }
    if (bone.name < twin) {
      const dl = Math.abs(bone.length - other.length);
      if (dl > Math.max(1, 0.05 * Math.max(bone.length, other.length))) warn(`${bone.name} / ${twin} differ in length (${bone.length.toFixed(1)} vs ${other.length.toFixed(1)}): not symmetric`);
    }
  }
  for (const bone of doc.bones) {
    if (bone.inherit !== "normal" && bone.parent) warn(`${bone.name} inherits '${bone.inherit}': it ignores the root flip's reflection, so it will not mirror with the body`);
    if (bone.parent && WEAPON.test(bone.name)) {
      const parent = bones.get(bone.parent);
      if (parent && /hand/i.test(parent.name) && sidedKey(parent.name)) warn(`${bone.name} is parented to ${parent.name}: a weapon-hand assumption, it stays in that hand and is held on the other side when mirrored`);
    }
  }
  for (const slot of doc.slots) {
    const twin = twinName(slot.name);
    if (twin && !doc.slots.some((o) => o.name === twin)) warn(`slot ${slot.name} has no opposite-side twin: an asymmetric piece`);
  }
  return out;
}

/** Mirrors the root bones (scaleX -1): a clone of the document with only that changed. */
export function mirroredDoc(doc: AnimDocument): AnimDocument {
  return { ...doc, bones: doc.bones.map((b) => (b.parent ? b : { ...b, scaleX: -b.scaleX })) };
}

function posed(doc: AnimDocument, name: string, time: number, loop: boolean): Skeleton {
  const skeleton = new Skeleton(doc);
  skeleton.setToSetupPose();
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, name, { loop });
  const duration = doc.animations[name]?.duration ?? 0;
  state.update(loop ? Math.min(time, Math.max(0, duration - 1e-4)) : time);
  state.apply(skeleton);
  skeleton.updateWorldTransform("reset");
  return skeleton;
}

type Pt = [number, number];

/** Bone origin and tip in the frame of a skeleton's (unflipped) root, so a root rotation or offset cancels and a flip is a plain x negation. */
function rootFrame(skeleton: Skeleton): (bone: Bone) => { o: Pt; t: Pt; u: Pt } {
  const root = skeleton.bones.find((b) => !b.parent) ?? skeleton.bones[0]!;
  const w = root.world;
  const det = w.a * w.d - w.b * w.c || 1;
  const local = (x: number, y: number): Pt => {
    const dx = x - w.x;
    const dy = y - w.y;
    return [(w.d * dx - w.b * dy) / det, (-w.c * dx + w.a * dy) / det];
  };
  // o origin, t tip along the bone's x axis, u a point 30 px along its y axis (catches a bone whose axes were not reflected).
  return (bone) => ({
    o: local(bone.world.x, bone.world.y),
    t: local(bone.world.x + bone.world.a * bone.data.length, bone.world.y + bone.world.c * bone.data.length),
    u: local(bone.world.x + bone.world.b * 30, bone.world.y + bone.world.d * 30)
  });
}

/** Distance (px) a bone ends up from the mirror image of its normal pose, for one sample time. */
function mirrorDeviations(doc: AnimDocument, name: string, time: number, loop: boolean): Map<string, number> {
  const a = posed(doc, name, time, loop);
  const b = posed(mirroredDoc(doc), name, time, loop);
  const fa = rootFrame(a);
  const out = new Map<string, number>();
  for (const bone of a.bones) {
    const other = b.findBone(bone.data.name);
    if (!other) continue;
    const p = fa(bone);
    const q = fa(other);
    // Both are read in the unflipped root's frame: the flipped skeleton's positions must be the first's with x negated.
    const d = Math.max(Math.hypot(-p.o[0] - q.o[0], p.o[1] - q.o[1]), Math.hypot(-p.t[0] - q.t[0], p.t[1] - q.t[1]), Math.hypot(-p.u[0] - q.u[0], p.u[1] - q.u[1]));
    if (d > 0) out.set(bone.data.name, d);
  }
  return out;
}

export const MIRROR_TOLERANCE = 0.5;

/**
 * Everything the mirrored facing breaks for this clip, as gate issues of kind "mirror" (warnings: the flip is a preview, nothing
 * is blocked). Document findings first, then a posed check: the clip is played with the root flipped and every bone must land on the
 * mirror image (within MIRROR_TOLERANCE px, in the root's frame) of where it lands unflipped; a bone that does not (an IK bend
 * the reflection turned over, a constraint that is not reflection safe) is listed with the worst frame.
 * Pixel-level asymmetry (a logo, an eye patch, a scar on one cheek) cannot be seen from the document: use the preview toggle.
 */
export function mirrorGates(doc: AnimDocument, name: string, clip: ClipData, times?: readonly number[]): GateIssue[] {
  const out = mirrorStaticIssues(doc);
  const rig = withClip(doc, name, clip);
  const samples = times ?? clipSampleTimes(rig, name);
  const worst = new Map<string, { d: number; time: number }>();
  for (const time of samples) {
    for (const [bone, d] of mirrorDeviations(rig, name, time, clip.loop)) {
      if (d <= MIRROR_TOLERANCE) continue;
      const w = worst.get(bone);
      if (!w || d > w.d) worst.set(bone, { d, time });
    }
  }
  for (const [bone, w] of worst) out.push({ kind: "mirror", severity: "warning", time: w.time, message: `${bone} does not mirror: ${w.d.toFixed(1)} px off its mirror image (worst here)` });
  return out;
}
