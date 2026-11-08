/*
 * Atlas Animator editor: the Animate workspace's short bone list (the design notes, section 5).
 *
 * The player rig's BONE-STANDARD (rig-side-template-01/BONE-STANDARD.md) says the animator grabs a few obvious controls: body, lean,
 * the four IK targets, weapon and head. Those show first; clavicles, spine and the FK arm / leg chain sit under "More". Helpers and
 * everything else stay out of the list (the Pro workspace still lists every bone). Colours follow the standard: body and lean yellow,
 * near arm green, far arm orange, near leg blue, far leg purple, head cyan, IK targets pink, weapon red.
 * Pure: no DOM, unit tested.
 */

export interface AnimateBone {
  name: string;
  /** Plain words for the row. */
  label: string;
  /** CSS colour of the row's dot. */
  color: string;
}

export const BONE_COLORS = {
  centre: "#f0c24a",
  armNear: "#5fd47a",
  armFar: "#f29a3d",
  legNear: "#4a9cf0",
  legFar: "#a37be8",
  head: "#3fd0d8",
  target: "#f06fb4",
  weapon: "#ee5a50"
} as const;

type Def = readonly [name: string, label: string, color: string];

/** The controls Animate always lists, in order. */
export const MAIN_BONES: readonly Def[] = [
  ["body", "Body", BONE_COLORS.centre],
  ["lean", "Lean", BONE_COLORS.centre],
  ["hand_near_target", "Near hand (IK)", BONE_COLORS.target],
  ["hand_far_target", "Far hand (IK)", BONE_COLORS.target],
  ["foot_near_target", "Near foot (IK)", BONE_COLORS.target],
  ["foot_far_target", "Far foot (IK)", BONE_COLORS.target],
  ["weapon", "Weapon", BONE_COLORS.weapon],
  ["head", "Head", BONE_COLORS.head]
];

/** Under "More": spine, clavicles and the FK arm and leg chains. */
export const MORE_BONES: readonly Def[] = [
  ["pelvis", "Pelvis", BONE_COLORS.centre],
  ["spine_1", "Lower spine", BONE_COLORS.centre],
  ["spine_2", "Upper spine", BONE_COLORS.centre],
  ["chest", "Chest", BONE_COLORS.centre],
  ["neck", "Neck", BONE_COLORS.head],
  ["clavicle_near", "Near shoulder", BONE_COLORS.armNear],
  ["upper_arm_near", "Near upper arm", BONE_COLORS.armNear],
  ["forearm_near", "Near forearm", BONE_COLORS.armNear],
  ["hand_near", "Near hand (FK)", BONE_COLORS.armNear],
  ["clavicle_far", "Far shoulder", BONE_COLORS.armFar],
  ["upper_arm_far", "Far upper arm", BONE_COLORS.armFar],
  ["forearm_far", "Far forearm", BONE_COLORS.armFar],
  ["hand_far", "Far hand (FK)", BONE_COLORS.armFar],
  ["thigh_near", "Near thigh", BONE_COLORS.legNear],
  ["shin_near", "Near shin", BONE_COLORS.legNear],
  ["foot_near", "Near foot (FK)", BONE_COLORS.legNear],
  ["thigh_far", "Far thigh", BONE_COLORS.legFar],
  ["shin_far", "Far shin", BONE_COLORS.legFar],
  ["foot_far", "Far foot (FK)", BONE_COLORS.legFar]
];

export interface AnimateBoneLists {
  main: AnimateBone[];
  more: AnimateBone[];
}

/** The standard controls this rig has (a bone the rig lacks is left out). */
export function animateBoneLists(have: Iterable<string>): AnimateBoneLists {
  const names = new Set(have);
  const pick = (defs: readonly Def[]): AnimateBone[] => defs.filter(([n]) => names.has(n)).map(([name, label, color]) => ({ name, label, color }));
  return { main: pick(MAIN_BONES), more: pick(MORE_BONES) };
}

/** Whether a bone is in either Animate group. */
export function inAnimateList(name: string): boolean {
  return MAIN_BONES.some(([n]) => n === name) || MORE_BONES.some(([n]) => n === name);
}

/** Whether a bone belongs under "More" (so selecting it on the canvas opens the group). */
export function isMoreBone(name: string): boolean {
  return MORE_BONES.some(([n]) => n === name);
}

/** Bones the big Key pose button keys when nothing is selected: every standard control except the IK targets (those key by dragging). */
export function keyPoseBones(have: Iterable<string>): string[] {
  const { main, more } = animateBoneLists(have);
  return [...main, ...more].map((b) => b.name).filter((n) => !n.endsWith("_target"));
}
