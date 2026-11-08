/*
 * Atlas Animator editor: the Swag wizard's "Where does it go?" zones, drawn from the rig itself (Batch 10b, PL-12).
 *
 * Each item slot (chest, pants, boots, ...) is the union of the boxes of the rig slots it fills (`ITEM_SLOT_MAP`): a slot with art (a mesh or a region in
 * any skin) uses that art's box in the setup pose; a slot with only a bone (an on-demand slot such as boots or a cape) uses a box around its bone. An item
 * slot whose bones the rig lacks has no zone: the wizard lists it as unavailable, with the bone it needs. Pure and Node-safe.
 */
import { boneForAddedSlot, ITEM_SLOTS, rigSlotsOf, type ItemSlot } from "./swagModel.js";
import { boneOfSlot } from "./rigContract.js";
import { boneWorlds, restLocal, type Affine } from "./swagTransfer.js";
import type { JsonObject } from "./setupModel.js";

type Json = Record<string, unknown>;
const objOf = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const listOf = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null && !Array.isArray(x)) as Json[]) : []);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export interface ZoneBox {
  /** The rig slot this box comes from. */
  slot: string;
  from: "art" | "bone";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Zone {
  item: ItemSlot;
  boxes: ZoneBox[];
  /** Bones this item slot needs that the rig does not have (so no zone can be drawn for them). */
  missingBones: string[];
}

export interface ZoneMap {
  zones: Zone[];
  /** The box around every zone, in rig world pixels (y down). */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

const apply = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];

/** The setup-pose world box of the first mesh or region any skin has on `slot`, or null. */
function artBox(raw: JsonObject, slot: string, bone: string, worlds: ReadonlyMap<string, Affine>): [number, number, number, number] | null {
  const bw = worlds.get(bone);
  if (!bw) return null;
  for (const skin of Object.values(objOf(raw["skins"]))) {
    for (const att of Object.values(objOf(objOf(objOf(skin)["attachments"])[slot]))) {
      const a = objOf(att);
      const pts: [number, number][] = [];
      if (a["type"] === "mesh") {
        const rest = restLocal(a, bone, worlds);
        for (let i = 0; i + 1 < rest.length; i += 2) pts.push(apply(bw, rest[i]!, rest[i + 1]!));
      } else if (a["type"] === "region" || a["type"] === undefined) {
        const w = num(a["width"], 0) * num(a["scaleX"], 1);
        const h = num(a["height"], 0) * num(a["scaleY"], 1);
        if (w <= 0 || h <= 0) continue;
        const r = (num(a["rotation"], 0) * Math.PI) / 180;
        for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) {
          pts.push(apply(bw, num(a["x"], 0) + cx * Math.cos(r) - cy * Math.sin(r), num(a["y"], 0) + cx * Math.sin(r) + cy * Math.cos(r)));
        }
      }
      if (pts.length) return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    }
  }
  return null;
}

/** A box around a bone: its segment, with a thickness of a third of its length (at least 16 px). */
function boneBox(raw: JsonObject, bone: string, worlds: ReadonlyMap<string, Affine>): [number, number, number, number] | null {
  const w = worlds.get(bone);
  if (!w) return null;
  const len = num(listOf(raw["bones"]).find((b) => b["name"] === bone)?.["length"], 40);
  const [ex, ey] = apply(w, Math.max(len, 24), 0);
  const pad = Math.max(16, len / 3);
  return [Math.min(w.x, ex) - pad, Math.min(w.y, ey) - pad, Math.max(w.x, ex) + pad, Math.max(w.y, ey) + pad];
}

/** The zones of a rig document, one per item slot that the rig can serve. */
export function rigZones(raw: JsonObject): ZoneMap {
  const worlds = boneWorlds(raw);
  const slots = listOf(raw["slots"]);
  const zones: Zone[] = [];
  for (const item of ITEM_SLOTS) {
    const boxes: ZoneBox[] = [];
    const missing = new Set<string>();
    for (const slot of rigSlotsOf(item)) {
      const def = slots.find((s) => s["name"] === slot);
      const bone = (typeof def?.["bone"] === "string" ? (def["bone"] as string) : null) ?? boneForAddedSlot(slot) ?? boneOfSlot(slot);
      if (!bone || !worlds.has(bone)) {
        if (bone && !def) missing.add(bone);
        continue;
      }
      const art = def ? artBox(raw, slot, bone, worlds) : null;
      const b = art ?? boneBox(raw, bone, worlds);
      if (b) boxes.push({ slot, from: art ? "art" : "bone", x0: b[0], y0: b[1], x1: b[2], y1: b[3] });
    }
    zones.push({ item, boxes, missingBones: boxes.length ? [] : [...missing] });
  }
  const all = zones.flatMap((z) => z.boxes);
  const bounds = all.length ? { x0: Math.min(...all.map((b) => b.x0)), y0: Math.min(...all.map((b) => b.y0)), x1: Math.max(...all.map((b) => b.x1)), y1: Math.max(...all.map((b) => b.y1)) } : null;
  return { zones, bounds };
}

/** The item slots in the order the wizard draws them (back to front: cape behind everything, weapon in front). */
export const ZONE_ORDER: readonly ItemSlot[] = ["cape", "pants", "boots", "chest", "gloves", "chain", "hair", "helmet", "face", "mask", "weapon"];
