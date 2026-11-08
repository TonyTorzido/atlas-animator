/*
 * Atlas Animator editor: pose rules for the player rig (the user's art rules, plan section 12 decision 10).
 *
 * Four geometric rules on the posed skeleton, replacing the jacket-era pose-limit polygons, IK reach and
 * contour-band gates:
 *   1. no arm behind the head: the upper arm, forearm or fist overlaps the head's silhouette ellipse;
 *   2. no upper arm thrown back: the turned character faces one way on screen (L view: screen-left), and "back"
 *      is the rear side (screen-right in the L view, mirrored when the rig faces right). An upper arm pointing
 *      toward the rear side more than UPPER_ARM_REAR_MAX_FROM_DOWN_DEG from straight down (a horizontal-ish or
 *      higher arm reaching behind the body) is flagged. Straight up beside the head is rule 1's. The straight
 *      front rig has no rear side, so the rule is off there;
 *   3. no limb stretch: an arm or leg segment grows more than STRETCH_TOLERANCE past its setup length;
 *   4. head scale within +-HEAD_SCALE_TOLERANCE of setup (world scale, so a scaled parent counts);
 *   5. limb scale (a warning on any clip): an arm or leg bone carries a local scale other than setup. Limbs never
 *      stretch; torso, chest and head squash and stretch are allowed (they are not in the limb list, and the check
 *      reads the bone's own scale so a squashed chest does not flag the arms it carries).
 *   6. fist on its own arm: the hand bone's origin stays within FIST_DETACH_TOLERANCE px of its forearm's tip, and
 *      the hand slot (skin_hand_*) rides the hand bone (an error on any clip);
 *   7. weapon never across the face: the weapon art's box must not overlap the face ellipse, a subset of the head
 *      ellipse built from the eyes, nose and mouth art (an error on any clip);
 *   8. eyes never widen: the eyes world scale, relative to the head, stays at or below setup + EYES_WIDEN_TOLERANCE, no face bone carries
 *      a scale or shear, and the eyes slot only shows an allowed placeholder (an error on any clip).
 * Rules 6 to 8 read both bone naming schemes (l/r of the old player rig, near/far of the pro rigs).
 * The rules are pure functions of the world transforms: nothing here knows about clips or severity.
 */
import type { Skeleton } from "@atlas-animator/core/core";

export const HEAD_SCALE_TOLERANCE = 0.03;
export const STRETCH_TOLERANCE = 0.03;
export const UPPER_ARM_REAR_MAX_FROM_DOWN_DEG = 60;
/** The head sits this far (skeleton px) off the chest column before the rig counts as turned. */
const TURNED_MIN_HEAD_OFFSET = 2;

/**
 * The head silhouette as an ellipse in the head bone's frame. The head attachment is 544 x 497 centred
 * 241.5 along the bone (stock rig atlas); 0.9 of its half extents keeps the hair rim and chin out of the test.
 */
export const HEAD_ELLIPSE = { centerAlong: 241.5, along: 223, across: 245 } as const;

export type PoseRule = "arm behind head" | "upper arm thrown back" | "limb stretch" | "head scale" | "limb scale" | "fist on own arm" | "weapon across face" | "eyes widen";

export interface RuleHit {
  rule: PoseRule;
  message: string;
  /** The bones that break the rule; the first is the one a label or a click should land on. */
  bones: string[];
  /** Set when the rule has one severity whatever the clip (the caller's severity otherwise). */
  severity?: "warning" | "error";
}

export const LIMB_SCALE_TOLERANCE = 0.01;
/** Arm and leg bones whose own scale must stay at setup. */
export const LIMB_BONES: readonly string[] = ["upper_arm_", "forearm_", "hand_", "thigh_", "shin_", "foot_"].flatMap((b) => ["l", "r", "near", "far"].map((s) => `${b}${s}`));

/** Side suffixes of both rigs: the old player rig (l/r) and the pro rigs (near/far). */
const ALL_SIDES: readonly string[] = ["l", "r", "near", "far"];

/** The hand origin may sit this far (skeleton px) from its forearm's tip before the fist counts as detached. */
export const FIST_DETACH_TOLERANCE = 3;
/** The eyes world scale relative to the head may exceed setup by this fraction (the face never widens). */
export const EYES_WIDEN_TOLERANCE = 0.01;
/** A face bone's own scale may differ from setup by this fraction; shear by this many degrees. */
export const FACE_SCALE_TOLERANCE = 0.01;
export const FACE_SHEAR_TOLERANCE_DEG = 0.5;
/** The eyes slot may only show these placeholders (open, half blink, closed): no other eye swaps. */
export const EYE_PLACEHOLDERS_ALLOWED: readonly string[] = ["eyes", "eyes_blink_half", "eyes_blink_closed"];
const FACE_SLOTS: readonly string[] = ["eyes", "brows", "nose", "mouth"];
/** [bone, child that ends its segment]; the segment length is measured origin to origin. */
const LIMB_SEGMENTS: readonly (readonly [string, string])[] = [
  ["upper_arm_", "forearm_"],
  ["forearm_", "hand_"],
  ["thigh_", "shin_"],
  ["shin_", "foot_"]
];

type Pt = readonly [number, number];

function worldOf(skeleton: Skeleton, name: string): { x: number; y: number; a: number; b: number; c: number; d: number; length: number } | null {
  const bone = skeleton.findBone(name);
  if (!bone) return null;
  const w = bone.world;
  return { x: w.x, y: w.y, a: w.a, b: w.b, c: w.c, d: w.d, length: bone.data.length };
}

/** Where the bone ends (origin + local X axis * length). */
function tipOf(w: NonNullable<ReturnType<typeof worldOf>>): Pt {
  return [w.x + w.a * w.length, w.y + w.c * w.length];
}

function lerpPoints(from: Pt, to: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);
  return out;
}

/** The fixed distances and scales a pose is compared with (taken from the setup pose of the same skeleton). */
export interface Reference {
  segment: Map<string, number>;
  headScaleX: number;
  headScaleY: number;
  /** World scale of the bone the eyes ride, at setup. */
  eyesScaleX: number;
  eyesScaleY: number;
  /** The face ellipse in the head bone's frame (from the eyes, nose and mouth art at setup), or null without it. */
  face: FaceEllipse | null;
}

export interface FaceEllipse {
  cx: number;
  cy: number;
  /** Semi-axes along the head bone's x and y. */
  ax: number;
  ay: number;
}

type Slot = NonNullable<ReturnType<Skeleton["findSlot"]>>;

/** The four corner points (flat x,y list, bone frame) of a slot's shown region art, or null. */
function artCorners(skeleton: Skeleton, slot: Slot | undefined): number[] | null {
  if (!slot) return null;
  // The shown art when skins are active; with none active (the gates' bare skeleton) the base skin's art for the placeholder.
  const placeholder = slot.drivenPlaceholder !== undefined ? slot.drivenPlaceholder : slot.placeholder;
  const baseSkin = Object.keys(skeleton.document.skins)[0];
  const a = (slot.attachment ?? (placeholder && baseSkin ? skeleton.attachments.get(baseSkin, slot.data.name, placeholder) : undefined)) as { type?: string; offsets?: ArrayLike<number> } | null | undefined;
  if (!a || a.type !== "region" || !a.offsets || a.offsets.length < 8) return null;
  return Array.from(a.offsets).slice(0, 8);
}

/** The face ellipse: the box of the eyes, nose and mouth art on the head bone, inscribed. */
function faceEllipseOf(skeleton: Skeleton): FaceEllipse | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const name of ["eyes", "nose", "mouth"]) {
    const slot = skeleton.findSlot(name);
    const c = artCorners(skeleton, slot);
    if (!c || slot!.bone.data.name !== "head") continue;
    for (let i = 0; i < c.length; i += 2) {
      minX = Math.min(minX, c[i]!);
      maxX = Math.max(maxX, c[i]!);
      minY = Math.min(minY, c[i + 1]!);
      maxY = Math.max(maxY, c[i + 1]!);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, ax: (maxX - minX) / 2, ay: (maxY - minY) / 2 };
}

/** The bone the eyes ride (a dedicated `eyes` bone, else the eyes slot's bone). */
function eyesBoneOf(skeleton: Skeleton): ReturnType<Skeleton["findBone"]> {
  return skeleton.findBone("eyes") ?? skeleton.findSlot("eyes")?.bone;
}

export function referenceOf(skeleton: Skeleton): Reference {
  const segment = new Map<string, number>();
  for (const side of ALL_SIDES) {
    for (const [from, to] of LIMB_SEGMENTS) {
      const a = worldOf(skeleton, from + side);
      const b = worldOf(skeleton, to + side);
      if (a && b) segment.set(from + side, Math.hypot(b.x - a.x, b.y - a.y));
    }
  }
  const head = worldOf(skeleton, "head");
  const eyes = eyesBoneOf(skeleton)?.world;
  return {
    segment,
    headScaleX: head ? Math.hypot(head.a, head.c) : 1,
    headScaleY: head ? Math.hypot(head.b, head.d) : 1,
    eyesScaleX: eyes ? Math.hypot(eyes.a, eyes.c) : 1,
    eyesScaleY: eyes ? Math.hypot(eyes.b, eyes.d) : 1,
    face: faceEllipseOf(skeleton)
  };
}

/** Rule hits of the skeleton's current world pose (call updateWorldTransform first). */
export function poseRuleHits(skeleton: Skeleton, reference: Reference): RuleHit[] {
  const hits: RuleHit[] = [];
  const head = worldOf(skeleton, "head");
  const chest = worldOf(skeleton, "chest");
  // The rear side: +1 screen-right (rig faces left), -1 screen-left (rig faces right), 0 straight front (no rear).
  const headOffset = head && chest ? head.x - chest.x : 0;
  const rear = Math.abs(headOffset) < TURNED_MIN_HEAD_OFFSET ? 0 : headOffset < 0 ? 1 : -1;

  for (const side of ALL_SIDES) {
    const upper = worldOf(skeleton, `upper_arm_${side}`);
    const fore = worldOf(skeleton, `forearm_${side}`);
    const hand = worldOf(skeleton, `hand_${side}`);
    if (!upper || !fore || !hand) continue;

    // 1. arm behind the head: any point of the arm inside the head ellipse
    if (head) {
      const sx = Math.hypot(head.a, head.c) || 1;
      const sy = Math.hypot(head.b, head.d) || 1;
      const ux: Pt = [head.a / sx, head.c / sx];
      const uy: Pt = [head.b / sy, head.d / sy];
      const cx = head.x + head.a * HEAD_ELLIPSE.centerAlong;
      const cy = head.y + head.c * HEAD_ELLIPSE.centerAlong;
      const inside = (p: Pt): boolean => {
        const dx = p[0] - cx;
        const dy = p[1] - cy;
        const u = (dx * ux[0] + dy * ux[1]) / (HEAD_ELLIPSE.along * sx);
        const v = (dx * uy[0] + dy * uy[1]) / (HEAD_ELLIPSE.across * sy);
        return u * u + v * v < 1;
      };
      const samples: Pt[] = [...lerpPoints([upper.x, upper.y], [fore.x, fore.y], 8), ...lerpPoints([fore.x, fore.y], [hand.x, hand.y], 8), ...lerpPoints([hand.x, hand.y], tipOf(hand), 4)];
      if (samples.some(inside)) hits.push({ rule: "arm behind head", bones: [`forearm_${side}`, `upper_arm_${side}`, `hand_${side}`], message: `${side} arm overlaps the head` });
    }

    // 2. upper arm thrown back: toward the rear side, past 60 degrees from straight down
    if (rear !== 0) {
      const ul = Math.hypot(upper.a, upper.c) || 1;
      const dx = upper.a / ul;
      const dy = upper.c / ul;
      const fromDown = (Math.acos(Math.max(-1, Math.min(1, dy))) * 180) / Math.PI;
      if (dx * rear > 0 && fromDown > UPPER_ARM_REAR_MAX_FROM_DOWN_DEG) {
        hits.push({ rule: "upper arm thrown back", bones: [`upper_arm_${side}`], message: `${side} upper arm reaches back, ${fromDown.toFixed(0)}° from straight down (maximum ${UPPER_ARM_REAR_MAX_FROM_DOWN_DEG}°)` });
      }
    }
  }

  // 3. limb stretch
  for (const side of ALL_SIDES) {
    for (const [from, to] of LIMB_SEGMENTS) {
      const a = worldOf(skeleton, from + side);
      const b = worldOf(skeleton, to + side);
      const rest = reference.segment.get(from + side);
      if (!a || !b || !rest) continue;
      const ratio = Math.hypot(b.x - a.x, b.y - a.y) / rest;
      if (ratio > 1 + STRETCH_TOLERANCE) hits.push({ rule: "limb stretch", bones: [from + side], message: `${from}${side} stretched ${((ratio - 1) * 100).toFixed(0)}% past its length` });
    }
  }

  // 5. limb scale: the bone's own pose scale against its setup scale (warning only)
  for (const name of LIMB_BONES) {
    const bone = skeleton.findBone(name);
    if (!bone) continue;
    const sx = bone.pose.scaleX / (bone.data.scaleX || 1);
    const sy = bone.pose.scaleY / (bone.data.scaleY || 1);
    if (Math.abs(sx - 1) > LIMB_SCALE_TOLERANCE || Math.abs(sy - 1) > LIMB_SCALE_TOLERANCE) {
      hits.push({ rule: "limb scale", severity: "warning", bones: [name], message: `${name} scaled to ${(sx * 100).toFixed(0)}% x ${(sy * 100).toFixed(0)}% (limbs never stretch; squash the torso, chest or head instead)` });
    }
  }

  hits.push(...fistHits(skeleton), ...weaponFaceHits(skeleton, reference), ...eyesHits(skeleton, reference));

  // 4. head scale
  if (head) {
    const sx = Math.hypot(head.a, head.c) / reference.headScaleX;
    const sy = Math.hypot(head.b, head.d) / reference.headScaleY;
    for (const [axis, s] of [["x", sx], ["y", sy]] as const) {
      if (Math.abs(s - 1) > HEAD_SCALE_TOLERANCE) hits.push({ rule: "head scale", bones: ["head"], message: `head scale ${axis} ${(s * 100).toFixed(1)}% (allowed ${(100 - HEAD_SCALE_TOLERANCE * 100).toFixed(0)}..${(100 + HEAD_SCALE_TOLERANCE * 100).toFixed(0)}%)` });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------- rules 6 to 8

/** 6. fist on its own arm. */
function fistHits(skeleton: Skeleton): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const side of ALL_SIDES) {
    const fore = worldOf(skeleton, `forearm_${side}`);
    const hand = worldOf(skeleton, `hand_${side}`);
    if (!fore || !hand) continue;
    const tip = tipOf(fore);
    const gap = Math.hypot(hand.x - tip[0], hand.y - tip[1]);
    if (gap > FIST_DETACH_TOLERANCE) {
      hits.push({ rule: "fist on own arm", severity: "error", bones: [`hand_${side}`, `forearm_${side}`], message: `${side} fist is ${gap.toFixed(1)} px off the end of its forearm (maximum ${FIST_DETACH_TOLERANCE})` });
    }
    for (const slotName of [`skin_hand_${side}`, `skin_hand_${side}_back`]) {
      const slot = skeleton.findSlot(slotName);
      if (slot && slot.bone.data.name !== `hand_${side}`) {
        hits.push({ rule: "fist on own arm", severity: "error", bones: [`hand_${side}`], message: `${slotName} rides ${slot.bone.data.name}, not hand_${side}` });
      }
    }
  }
  return hits;
}

/** World point -> head bone frame (null when the head has no inverse). */
function toHeadFrame(head: NonNullable<ReturnType<typeof worldOf>>, p: Pt): Pt | null {
  const det = head.a * head.d - head.b * head.c;
  if (Math.abs(det) < 1e-9) return null;
  const dx = p[0] - head.x;
  const dy = p[1] - head.y;
  return [(head.d * dx - head.b * dy) / det, (-head.c * dx + head.a * dy) / det];
}

const WEAPON_GRID = 12;

/** 7. weapon never across the face: the weapon art's box (sampled) against the face ellipse. */
function weaponFaceHits(skeleton: Skeleton, reference: Reference): RuleHit[] {
  const face = reference.face;
  const head = worldOf(skeleton, "head");
  const slot = skeleton.findSlot("weapon");
  if (!face || !head || !slot || slot.hidden || !slot.bone.active) return [];
  const corners = artCorners(skeleton, slot);
  if (!corners) return [];
  const w = slot.bone.world;
  const world = (x: number, y: number): Pt => [w.a * x + w.b * y + w.x, w.c * x + w.d * y + w.y];
  const hit: RuleHit[] = [{ rule: "weapon across face", severity: "error", bones: [slot.bone.data.name, "head"], message: "the weapon crosses the face" }];
  const inFace = (p: Pt): boolean => {
    const q = toHeadFrame(head, p);
    if (!q) return false;
    const u = (q[0] - face.cx) / face.ax;
    const v = (q[1] - face.cy) / face.ay;
    return u * u + v * v < 1;
  };
  // corners 0..3 are the quad top-left, top-right, bottom-right, bottom-left: a bilinear grid over it
  const [x0, y0, x1, y1, x2, y2, x3, y3] = corners as [number, number, number, number, number, number, number, number];
  for (let i = 0; i <= WEAPON_GRID; i++) {
    for (let j = 0; j <= WEAPON_GRID; j++) {
      const s = i / WEAPON_GRID;
      const t = j / WEAPON_GRID;
      const tx = x0 + (x1 - x0) * s;
      const ty = y0 + (y1 - y0) * s;
      const bx = x3 + (x2 - x3) * s;
      const by = y3 + (y2 - y3) * s;
      if (inFace(world(tx + (bx - tx) * t, ty + (by - ty) * t))) return hit;
    }
  }
  // a weapon wider than the face can cover it with no grid point inside: test the face centre against the quad
  const centre: Pt = [head.a * face.cx + head.b * face.cy + head.x, head.c * face.cx + head.d * face.cy + head.y];
  const quad = [world(x0, y0), world(x1, y1), world(x2, y2), world(x3, y3)];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const cross = (b[0] - a[0]) * (centre[1] - a[1]) - (b[1] - a[1]) * (centre[0] - a[0]);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return [];
  }
  return hit;
}

/** 8. eyes never widen. */
function eyesHits(skeleton: Skeleton, reference: Reference): RuleHit[] {
  const hits: RuleHit[] = [];
  const eyesBone = eyesBoneOf(skeleton);
  if (eyesBone) {
    const w = eyesBone.world;
    const head = skeleton.findBone("head")?.world;
    const hx = head ? Math.hypot(head.a, head.c) / (reference.headScaleX || 1) : 1;
    const hy = head ? Math.hypot(head.b, head.d) / (reference.headScaleY || 1) : 1;
    // relative to the head: a scaled head (its own +-3% rule) carries the eyes along
    const sx = Math.hypot(w.a, w.c) / (reference.eyesScaleX || 1) / (hx || 1);
    const sy = Math.hypot(w.b, w.d) / (reference.eyesScaleY || 1) / (hy || 1);
    if (sx > 1 + EYES_WIDEN_TOLERANCE || sy > 1 + EYES_WIDEN_TOLERANCE) {
      hits.push({ rule: "eyes widen", severity: "error", bones: [eyesBone.data.name], message: `eyes scaled to ${(sx * 100).toFixed(1)}% x ${(sy * 100).toFixed(1)}% (maximum ${(100 + EYES_WIDEN_TOLERANCE * 100).toFixed(0)}%)` });
    }
  }
  // face bones: bones that carry only face slots (not the head, which has its own rule)
  const onlyFace = new Map<string, boolean>();
  for (const slot of skeleton.slots) {
    const name = slot.bone.data.name;
    onlyFace.set(name, (onlyFace.get(name) ?? true) && FACE_SLOTS.includes(slot.data.name));
  }
  for (const [name, face] of onlyFace) {
    const bone = face ? skeleton.findBone(name) : undefined;
    if (!bone) continue;
    const sx = bone.pose.scaleX / (bone.data.scaleX || 1);
    const sy = bone.pose.scaleY / (bone.data.scaleY || 1);
    if (Math.abs(sx - 1) > FACE_SCALE_TOLERANCE || Math.abs(sy - 1) > FACE_SCALE_TOLERANCE) hits.push({ rule: "eyes widen", severity: "error", bones: [name], message: `face bone ${name} is scaled (face bones never scale)` });
    if (Math.abs(bone.pose.shearX - bone.data.shearX) > FACE_SHEAR_TOLERANCE_DEG || Math.abs(bone.pose.shearY - bone.data.shearY) > FACE_SHEAR_TOLERANCE_DEG) {
      hits.push({ rule: "eyes widen", severity: "error", bones: [name], message: `face bone ${name} is sheared (face bones never shear)` });
    }
  }
  // eye swaps: only the allowed placeholders
  const eyes = skeleton.findSlot("eyes");
  if (eyes) {
    const shown = eyes.drivenPlaceholder !== undefined ? eyes.drivenPlaceholder : eyes.placeholder;
    if (shown && !EYE_PLACEHOLDERS_ALLOWED.includes(shown)) hits.push({ rule: "eyes widen", severity: "error", bones: [(eyesBone ?? eyes.bone).data.name], message: `eyes show '${shown}' (allowed: ${EYE_PLACEHOLDERS_ALLOWED.join(", ")})` });
  }
  return hits;
}
