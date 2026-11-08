/*
 * Atlas Animator: original implementation.
 *
 * Cuff-to-wrist gap check:
 * every sleeve's cuff hem must reach the wrist dip, the narrow point between the forearm and the fist
 * bulge, on both the inner and the outer side, in every frame; no forearm skin (or its outline) shows
 * between the hem and the fist.
 *
 * The wrist dip comes from the bare body, per pose: the arm's silhouette (the limb slot and the
 * extremity slot, from a bare render with slot ids) is measured across the extremity bone's axis
 * (u along the bone, v across it); the dip is the distal end of the narrowest stretch before the fist
 * bulge (the last u whose width is within DIP_TOL of the narrowest width found from DIP_FROM to DIP_TO).
 * Exposed texels: in the dressed render, a texel whose top slot is the bare limb or extremity slot, on
 * the forearm side of the dip line (u in [uDip - reach, uDip - 1]) and inside the bare arm silhouette.
 * `depth` = how far above the dip line the exposed skin reaches (px along the forearm).
 *
 * The dip is measured on an id render of ONLY that arm's limb and extremity slots (armDipIds), over a
 * window that holds the whole arm: in the full composite another part drawn over the fist (the head
 * under a raised fist at sweep@5.00) or the window edge cut the arm's silhouette, the fist bulge went
 * missing and the "narrowest" point slid to the search edge.
 */
import type { Skeleton } from "../core/skeleton.js";
import type { RgbaImage } from "./image.js";
import { softRender } from "./softRender.js";

/** u range (px along the extremity bone, from its origin) searched for the narrowest point. */
export const DIP_FROM = -40;
export const DIP_TO = 30;
/** px: widths within this of the narrowest count as the dip stretch (antialiased outline rows). */
export const DIP_TOL = 3;
/** px above the dip line inspected (the forearm stretch a sleeve must cover next to the hand). */
export const GAP_REACH = 30;
/** most exposed texels allowed per side per frame (rounded corners of the hem at the outline). */
export const GAP_MAX_PX = 4;

export interface CuffGapArm { limbSlot: string; handSlot: string; handBone: string }
export interface CuffGapSide { arm: string; uDip: number; exposedPx: number; depth: number }

export interface Ids { topSlot: Int16Array; width: number; height: number; left: number; top: number }
/** The bare-body ids the dip is measured on: one render for every arm, or one per arm (armDipIds). */
export type DipIds = Ids | ((arm: CuffGapArm) => Ids);
const dipIdsOf = (d: DipIds, arm: CuffGapArm): Ids => (typeof d === "function" ? d(arm) : d);

/** Slot-id render of only the arm's limb and extremity slots (and their contours), current pose, over `win`. */
export function armDipIds(bare: Skeleton, textures: ReadonlyMap<string, RgbaImage>, arm: CuffGapArm, win: { width: number; height: number; left: number; top: number }): Ids {
  const keep = new Set([bare.getSlot(arm.limbSlot).index, bare.getSlot(arm.handSlot).index]);
  const r = softRender(bare, textures, { ...win, scale: 1, ids: true, slotFilter: (s) => keep.has(s.index) });
  return { topSlot: r.topSlot as Int16Array, ...win };
}

/** Width profile of the bare arm across the extremity bone; the dip u. */
export function wristDip(bare: Skeleton, ids: Ids, arm: CuffGapArm): { uDip: number; widths: Map<number, [number, number]> } {
  const set = new Set([bare.getSlot(arm.limbSlot).index + 1, bare.getSlot(arm.handSlot).index + 1]);
  const hb = bare.getBone(arm.handBone);
  const o = { x: 0, y: 0 };
  const widths = new Map<number, [number, number]>();
  for (let i = 0; i < ids.topSlot.length; i++) {
    if (!set.has(ids.topSlot[i] as number)) continue;
    const x = i % ids.width;
    const y = (i - x) / ids.width;
    hb.worldToLocal(x + ids.left + 0.5, y + ids.top + 0.5, o);
    const u = Math.round(o.x);
    if (u < DIP_FROM || u > DIP_TO) continue;
    const b = widths.get(u) ?? [Infinity, -Infinity];
    b[0] = Math.min(b[0], o.y);
    b[1] = Math.max(b[1], o.y);
    widths.set(u, b);
  }
  let min = Infinity;
  for (const [, b] of widths) min = Math.min(min, b[1] - b[0]);
  let uDip = DIP_FROM;
  for (let u = DIP_FROM; u <= DIP_TO; u++) { const b = widths.get(u); if (b && b[1] - b[0] <= min + DIP_TOL) uDip = u; }
  return { uDip, widths };
}

/**
 * Exposed arm texels between the hem and the wrist dip, one pose: `bare` and `dressed` sampled on the same
 * pose, `bareIds` the bare ids the dip is measured on (armDipIds per arm), `dressedIds` the dressed slot-id render.
 */
export function cuffWristGap(bare: Skeleton, bareIds: DipIds, dressed: Skeleton, dressedIds: Ids, arms: readonly CuffGapArm[]): CuffGapSide[] {
  return arms.map((arm) => {
    const { uDip, widths } = wristDip(bare, dipIdsOf(bareIds, arm), arm);
    const skin = new Set([dressed.getSlot(arm.limbSlot).index + 1, dressed.getSlot(arm.handSlot).index + 1]);
    const hb = dressed.getBone(arm.handBone);
    const o = { x: 0, y: 0 };
    let exposedPx = 0;
    let depth = 0;
    for (let i = 0; i < dressedIds.topSlot.length; i++) {
      if (!skin.has(dressedIds.topSlot[i] as number)) continue;
      const x = i % dressedIds.width;
      const y = (i - x) / dressedIds.width;
      hb.worldToLocal(x + dressedIds.left + 0.5, y + dressedIds.top + 0.5, o);
      const u = Math.round(o.x);
      if (u >= uDip || u < uDip - GAP_REACH) continue;
      const b = widths.get(u);
      if (!b || o.y < b[0] || o.y > b[1]) continue;
      exposedPx++;
      depth = Math.max(depth, uDip - u);
    }
    return { arm: arm.limbSlot, uDip, exposedPx, depth };
  });
}

/**
 * Damaged control: the dressed ids with every texel within `px` above the dip line handed back to the hand slot (a cuff
 * that stops `px` short). Phase 2c: only the wrist columns visible in that pose are handed back, i.e. texels whose
 * dressed top slot is the arm's own sleeve, limb or hand (`visible`, slot index + 1); a wrist behind another part (the
 * far wrist under the torso in a turned side view) stays covered, so the control cannot pass on hidden texels.
 */
export function damagedShortCuff(bare: Skeleton, bareIds: DipIds, dressed: Skeleton, dressedIds: Ids, arms: readonly CuffGapArm[], px = 6, visible?: (arm: CuffGapArm, topSlot: number) => boolean): Ids {
  const top = new Int16Array(dressedIds.topSlot);
  for (const arm of arms) {
    const { uDip, widths } = wristDip(bare, dipIdsOf(bareIds, arm), arm);
    const hb = dressed.getBone(arm.handBone);
    const hand = dressed.getSlot(arm.handSlot).index + 1;
    const o = { x: 0, y: 0 };
    for (let i = 0; i < top.length; i++) {
      if (!top[i]) continue;
      if (visible && !visible(arm, dressedIds.topSlot[i] as number)) continue;
      const x = i % dressedIds.width;
      const y = (i - x) / dressedIds.width;
      hb.worldToLocal(x + dressedIds.left + 0.5, y + dressedIds.top + 0.5, o);
      const u = Math.round(o.x);
      const b = widths.get(u);
      if (u < uDip && u >= uDip - px && b && o.y >= b[0] && o.y <= b[1]) top[i] = hand;
    }
  }
  return { ...dressedIds, topSlot: top };
}

/** The sleeved arms of a rig: each limb slot with a garment cuff whose bone has a child bone carrying a slot drawn as the extremity (hand). */
export function sleevedArms(doc: { slots: { name: string; bone: string }[]; bones: { name: string; parent?: string }[] }, cuffGroups: readonly string[]): CuffGapArm[] {
  const out: CuffGapArm[] = [];
  for (const g of cuffGroups) {
    const limb = doc.slots.find((s) => s.name === g);
    if (!limb) continue;
    const child = doc.bones.find((b) => b.parent === limb.bone && doc.slots.some((s) => s.bone === b.name));
    const hand = child && doc.slots.find((s) => s.bone === child.name);
    if (child && hand) out.push({ limbSlot: g, handSlot: hand.name, handBone: child.name });
  }
  return out;
}
