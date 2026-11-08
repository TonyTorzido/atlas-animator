/*
 * Atlas Animator editor: original implementation.
 *
 * A stand-in weapon for the stock player rig, used until the real weapon bone lands in the rig kit. It adds, in memory
 * only (no rig file is touched): a `weapon` bone riding `hand_r`, a `weapon` slot with a procedurally drawn axe region,
 * and two point slots, `weapon_tip` (tip) and `weapon_grip` (grip, grip2), shaped like the brief's weapon bone contract
 * ("weapon bone with grip / grip2 / tip points"). The arc overlay and the smear tool run on it.
 */
import type { RgbaImage } from "@atlas-animator/core/pixi";

type Json = Record<string, unknown>;

export const STAND_IN_BONE = "weapon";
export const STAND_IN_SLOT = "weapon";
export const STAND_IN_TIP_SLOT = "weapon_tip";
export const STAND_IN_GRIP_SLOT = "weapon_grip";
export const STAND_IN_PATH = "standin/axe";
export const AXE_WIDTH = 320;
export const AXE_HEIGHT = 140;
/** The weapon bone is as long as the handle; the tip point sits at its end. */
export const AXE_LENGTH = 290;

/** Returns a copy of a raw `atlas-anim@1` document with the stand-in weapon added. */
export function withStandInWeapon(json: unknown): unknown {
  const doc = structuredClone(json) as Json;
  const bones = doc.bones as Json[];
  if (bones.some((b) => b.name === STAND_IN_BONE)) return doc;
  if (!bones.some((b) => b.name === "hand_r")) throw new Error("the stand-in weapon needs a hand_r bone");
  bones.push({ name: STAND_IN_BONE, parent: "hand_r", x: 34, y: 0, rotation: -78, length: AXE_LENGTH });
  const slots = doc.slots as Json[];
  const at = slots.findIndex((s) => s.name === "hand_r");
  slots.splice(
    at + 1,
    0,
    { name: STAND_IN_SLOT, bone: STAND_IN_BONE, attachment: "axe", color: "ffffffff" },
    { name: STAND_IN_TIP_SLOT, bone: STAND_IN_BONE, attachment: "tip", color: "ffffffff" },
    { name: STAND_IN_GRIP_SLOT, bone: STAND_IN_BONE, attachment: "grip", color: "ffffffff" }
  );
  const skins = doc.skins as Record<string, { attachments: Record<string, Json> }>;
  const skin = skins.body ?? Object.values(skins)[0]!;
  skin.attachments[STAND_IN_SLOT] = { axe: { type: "region", path: STAND_IN_PATH, x: AXE_WIDTH / 2 - 14, y: 0, width: AXE_WIDTH, height: AXE_HEIGHT } };
  skin.attachments[STAND_IN_TIP_SLOT] = { tip: { type: "point", x: AXE_LENGTH, y: 0, rotation: 0 } };
  skin.attachments[STAND_IN_GRIP_SLOT] = { grip: { type: "point", x: 14, y: 0, rotation: 0 }, grip2: { type: "point", x: 96, y: 0, rotation: 0 } };
  return doc;
}

export const STOCK_INK: readonly [number, number, number] = [0x3a, 0x10, 0x01];
const WOOD: readonly [number, number, number] = [0x9a, 0x62, 0x30];
const STEEL: readonly [number, number, number] = [0xc8, 0xd2, 0xdc];
const STEEL_EDGE: readonly [number, number, number] = [0xf2, 0xf6, 0xfa];

/** The axe pixels (straight alpha): a wooden handle along +x with a steel blade near the far end, inked like the stock outline. */
export function standInAxePixels(): RgbaImage {
  const w = AXE_WIDTH;
  const h = AXE_HEIGHT;
  const fill = new Uint8Array(w * h); // 0 none, 1 wood, 2 steel, 3 steel edge
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dy = y + 0.5 - cy;
      if (x <= 296 && Math.abs(dy) <= 8) fill[y * w + x] = 1;
      // The blade: a rounded wedge flat on the handle side (x = 214) and bulging both ways.
      const bx = x - 214;
      if (bx >= 0 && bx <= 82) {
        const half = 62 * Math.sin((bx / 82) * Math.PI) ** 0.8 * (1 - 0.18 * (bx / 82));
        if (Math.abs(dy) <= half && Math.abs(dy) > 6) fill[y * w + x] = bx > 66 ? 3 : 2;
      }
    }
  }
  const data = new Uint8Array(w * h * 4);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && fill[y * w + x] !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = fill[y * w + x]!;
      if (!f) continue;
      let edge = false;
      for (let dy = -3; dy <= 3 && !edge; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 10 && !solid(x + dx, y + dy)) { edge = true; break; }
      const c = edge ? STOCK_INK : f === 1 ? WOOD : f === 2 ? STEEL : STEEL_EDGE;
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
