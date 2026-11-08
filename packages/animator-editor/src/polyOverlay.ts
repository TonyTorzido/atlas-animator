/*
 * Atlas Animator editor: which polygon overlays show on the stage (Batch 12a).
 *
 * Hit boxes (bounding boxes) and clip masks are drawn as tinted polygons. Each has a toggle in the
 * Overlays popover; the choice is remembered per browser (localStorage, optional).
 */
export interface PolyFlags {
  boxes: boolean;
  clips: boolean;
  paths: boolean;
}

const KEY = "atlasEditor.polyOverlay.v1";
const flags: PolyFlags = { boxes: true, clips: true, paths: true };
const listeners: (() => void)[] = [];

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<PolyFlags>;
  if (typeof saved.boxes === "boolean") flags.boxes = saved.boxes;
  if (typeof saved.clips === "boolean") flags.clips = saved.clips;
  if (typeof saved.paths === "boolean") flags.paths = saved.paths;
} catch {
  // storage unavailable: defaults
}

export const polyFlags = (): Readonly<PolyFlags> => flags;

export function setPolyFlag(name: keyof PolyFlags, on: boolean): void {
  flags[name] = on;
  try {
    localStorage.setItem(KEY, JSON.stringify(flags));
  } catch {
    // ignore
  }
  for (const l of listeners) l();
}

export function onPolyFlags(fn: () => void): void {
  listeners.push(fn);
}

/** Stage colours (0xRRGGBB): hit boxes green, clip masks red. */
export const POLY_COLOR = { boundingbox: 0x60f000, clipping: 0xce3a3a, path: 0xff9f40 } as const;
