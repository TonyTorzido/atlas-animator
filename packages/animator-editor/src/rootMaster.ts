/*
 * Atlas Animator editor: the root (master) bone as a first-class control (pure helpers).
 *
 * Every rig has a "root" bone at the ground point. It used to be hidden everywhere; now it is a standard master control: a crosshair
 * glyph in its own colour, always on top, with a small label. Selecting it and moving, rotating or scaling it moves the whole character.
 *
 * Root-motion rule: in Setup the root edits the rig's placement (stored in the rig document). In Animate, root keys are ALLOWED but
 * flagged: the project plays clips in place and positions the character itself, so it ignores or locks root motion. A clip that keys root
 * shows the warning chip, and the "Hold root" lock (lockRootRange) stays the way to pin it.
 */
import type { ClipData } from "@atlas-animator/core/core";

export const ROOT_BONE = "root";
/** The master control's own colour (teal, apart from every BONE-STANDARD colour). */
export const ROOT_COLOR = 0x2dd4bf;
export const ROOT_WARN_COLOR = 0xffc65c;
export const ROOT_LABEL = "ROOT";
export const ROOT_WARNING = "root motion: the project ignores or locks this";
export const ROOT_TIP = "Root: the master control at the ground point. Move, rotate or scale it to move the whole character (Shift+R selects it)";
/** Pick radius of the glyph, in screen px. */
export const ROOT_PICK_PX = 13;

export function isRoot(name: string | null | undefined): boolean {
  return name === ROOT_BONE;
}

/** True when the pointer (skeleton space) is on the glyph at the root origin; `zoom` is screen px per skeleton unit. */
export function hitsRootGlyph(px: number, py: number, rootX: number, rootY: number, zoom: number): boolean {
  return Math.hypot(px - rootX, py - rootY) <= ROOT_PICK_PX / Math.max(zoom, 1e-6);
}

/** Does the clip key the root bone at all (any channel)? */
export function clipKeysRoot(clip: Pick<ClipData, "bones"> | undefined): boolean {
  const t = clip?.bones?.[ROOT_BONE] as Record<string, unknown[] | undefined> | undefined;
  if (!t) return false;
  return Object.values(t).some((track) => Array.isArray(track) && track.length > 0);
}

/** The label the glyph shows: plain in Setup (placement), flagged in Animate when the project would ignore the motion. */
export function rootLabel(inSetup: boolean, keyed: boolean, selected: boolean): { text: string; warn: boolean } {
  if (inSetup) return { text: ROOT_LABEL, warn: false };
  if (keyed || selected) return { text: `${ROOT_LABEL}  ${ROOT_WARNING}`, warn: true };
  return { text: ROOT_LABEL, warn: false };
}
