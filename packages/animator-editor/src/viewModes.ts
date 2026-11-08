/*
 * Atlas Animator editor: sticky view modes the canvas HUD (viewHud.ts) turns on and main.ts reads while it handles the pointer.
 * Pan = the hand tool (a plain drag pans, like holding Space). rot15 = rotate drags snap to 15 degree steps as if Shift were held.
 * snapKey = rotate drags snap to the previous key's angle (or the mirror bone's) as if Ctrl were held. Editor-only, never saved.
 */
export interface ViewModes {
  pan: boolean;
  rot15: boolean;
  snapKey: boolean;
}

export const viewModes: ViewModes = { pan: false, rot15: false, snapKey: false };

const listeners = new Set<() => void>();

export function setViewMode(key: keyof ViewModes, on: boolean): void {
  if (viewModes[key] === on) return;
  viewModes[key] = on;
  for (const fn of [...listeners]) fn();
}

export function onViewModes(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
