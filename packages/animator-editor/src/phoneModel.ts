/*
 * Atlas Animator editor: pure helpers shared by the phone page (phonePage.ts) and the editor's Phone preview (phonePush.ts).
 */

/** The game's draw scales in CSS px per rig px (gameViewModel GAME_SCALES without the 1x close-up). */
export const PHONE_SCALES = [0.4, 0.471] as const;
export type PhoneScale = (typeof PHONE_SCALES)[number];

/** Grass, the project's first biome ground (gameViewModel GROUNDS "grass"). */
export const PHONE_GRASS = { ground: 0x5d8c3a, dark: 0x4a7530, light: 0x78a64c };

/** Poll period of the phone, ms: edits reach the phone within about this plus the editor's push delay. */
export const PHONE_POLL_MS = 400;

/** Seconds into a looping clip after `elapsed` seconds of play (never exactly the duration, so the last frame is not held twice). */
export function loopTime(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 0;
  const t = elapsed % duration;
  return Math.min(t < 0 ? t + duration : t, Math.max(0, duration - 1e-4));
}

/** The token from a /phone/<token>/ page path, or null. */
export function tokenFromPath(pathname: string): string | null {
  return /^\/phone\/([A-Za-z0-9]{8,64})(?:\/|$)/.exec(pathname)?.[1] ?? null;
}

/** Where the feet stand on the phone screen and the character's y so the feet land there (character local `feetY` at scale 1). */
export function phoneLayout(viewW: number, viewH: number, feetY: number, scale: number): { x: number; groundY: number; charY: number } {
  const groundY = Math.round(viewH * 0.68);
  return { x: Math.round(viewW / 2), groundY, charY: groundY - feetY * scale };
}

/** What the editor needs to tell the phone changed: a stable string of the parts the phone shows. */
export function stateKey(s: { clipName: string; clip: unknown; facing: string; rigKey: string }): string {
  return `${s.rigKey}|${s.clipName}|${s.facing}|${JSON.stringify(s.clip)}`;
}

/** Next scale in the toggle. */
export const nextScale = (scale: number): PhoneScale => (scale === PHONE_SCALES[0] ? PHONE_SCALES[1] : PHONE_SCALES[0]);
