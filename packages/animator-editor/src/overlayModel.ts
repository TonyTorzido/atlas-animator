/*
 * Atlas Animator editor: original implementation.
 *
 * Canvas handle sizes and layout (pure). Every size is in SCREEN pixels; the overlay divides by the zoom to draw them,
 * so a handle keeps the same on-screen size and grab area at any zoom.
 */

/** Screen-pixel sizes of the overlay handles. */
export const HANDLE_PX = {
  /** Radius of a bone's origin dot (selected is bigger). */
  dot: 6,
  dotSelected: 8,
  /** Stick width. */
  stick: 3,
  stickSelected: 5,
  /** How close (px) the pointer must be to a bone to pick it. */
  pick: 18,
  /** Half side of a pink IK target square and its grab radius. */
  ikHalf: 9,
  ikGrab: 20,
  /** Radius of the rotate ring around the selected bone. */
  ring: 70,
  /** Key dot radius and gap. */
  keyDot: 3.5,
  keyGap: 9
} as const;

/** Offsets (screen px) of `count` key dots laid out in a row centred above a bone's origin. */
export function keyDotOffsets(count: number): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  const total = (count - 1) * HANDLE_PX.keyGap;
  for (let i = 0; i < count; i++) out.push({ dx: -total / 2 + i * HANDLE_PX.keyGap, dy: -(HANDLE_PX.dotSelected + 7) });
  return out;
}

/** World-space radius that keeps a handle of `px` screen pixels the same size at any zoom. */
export const worldSize = (px: number, zoom: number): number => px / zoom;

/** True when (x, y) is within the grab area of an IK target handle at (cx, cy); `zoom` converts the screen-px grab radius. */
export function onIkHandle(x: number, y: number, cx: number, cy: number, zoom: number): boolean {
  return Math.hypot(x - cx, y - cy) <= worldSize(HANDLE_PX.ikGrab, zoom);
}

/**
 * The helpers to hide from the canvas now. With "show helpers" off every helper bone (IK target, weapon marker) is hidden
 * except a live IK target, which stays as the pink square you drag; with it on nothing is hidden, including helpers that
 * do nothing right now (`inert`: IK targets with the constraint off, weapon markers).
 */
export function overlayHidden(helpers: ReadonlySet<string>, inert: ReadonlySet<string>, liveTargets: ReadonlySet<string>, showHelpers: boolean): Set<string> {
  if (showHelpers) return new Set();
  const out = new Set<string>();
  for (const h of helpers) if (!liveTargets.has(h)) out.add(h);
  for (const h of inert) out.add(h);
  return out;
}
