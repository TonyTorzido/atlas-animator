/*
 * Atlas Animator editor: swag items (pure, like skinModel.ts). Plan: the design notes section 3.
 *
 * An item is one skin named `<slot>.<item>` (slot = an ITEM_SLOT such as `chest`, item = a free id like `red-jerkin`)
 * that holds replacement attachments only, for the rig slots its item slot owns. Skins never touch clips, so every
 * clip picks the item up. `itemCoverage` reports
 * which pieces one view still lacks and `checkItem` the quality rules (right side, hides, pivot drift, size).
 */
import type { AnimDocument, AttachmentData } from "@atlas-animator/core/core";
import { createSkin, setSkinHide, SKIN_NAME, type Skins } from "./skinModel.js";

export const ITEM_SLOTS = ["chest", "pants", "boots", "gloves", "chain", "cape", "helmet", "hair", "face", "mask", "weapon"] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];

/** A piece may be this far (fraction) bigger or smaller than the base piece it replaces, per axis. */
export const PIECE_SIZE_TOLERANCE = 0.15;
/** A region piece's origin may sit this far (canvas px, in the slot bone's frame) from the base piece's. */
export const PIVOT_DRIFT_TOLERANCE_PX = 24;
/**
 * A chest garment's torso mesh extends up under the head to cover the neck and shoulder slopes (the strict
 * neck-coverage rule). That extension is not visible garment body, so it is taken off the height before the size check: up to
 * this fraction of the base piece's height. Anything taller than the allowance (plus the normal tolerance) still warns.
 */
export const NECK_COVER_ALLOWANCE = 0.2;

const SIDES = ["near", "far"] as const;
const both = (stem: string): string[] => SIDES.map((s) => `${stem}_${s}`);

export interface ItemSlotSpec {
  /** Rig slots that exist in both pro rigs today. */
  existing: readonly string[];
  /** Rig slots the pro rigs do not have yet (added once through the setup commands, P7). */
  added: readonly string[];
  /** The pieces an item of this slot must supply (a subset of existing + added). */
  required: readonly string[];
  /** Slots the item's skin hides while worn. */
  hides: readonly string[];
  /** Slots the skin may hide without having to (a sleeved chest piece replaces the shirt strap). */
  mayHide?: readonly string[];
  /** Slots whose piece is meant to differ in size from the base piece (a chest item's skin arm is only the skin the sleeve leaves bare), so the size check skips them. */
  sizeFree?: readonly string[];
  /** Slots whose mesh may reach up over the neck (when skinned to the neck bone): the height check ignores that extension. */
  neckCover?: readonly string[];
  /** Free-form art (hair, weapons): no size or pivot comparison with the base piece. */
  freeform: boolean;
}

const PANTS = ["pants_waist", ...["cuff", "hip", "knee", "shin", "thigh"].flatMap((p) => both(`pants_${p}`))];

export const ITEM_SLOT_MAP: Readonly<Record<ItemSlot, ItemSlotSpec>> = {
  // Mesh-arm rigs: one skinned mesh per arm (skin_arm_<s>) with a sleeve mesh over it (shirt_sleeve_<s>); the arm_<s>_crease driven track swaps their crease variants.
  chest: { existing: ["shirt_torso", "shirt_strap_near", ...both("shirt_sleeve"), ...both("skin_arm")], added: [], required: ["shirt_torso"], hides: [], mayHide: ["shirt_strap_near", "shirt_tip_near", "shirt_tip_far"], sizeFree: both("skin_arm"), neckCover: ["shirt_torso"], freeform: false },
  pants: { existing: PANTS, added: [], required: ["pants_waist", ...both("pants_thigh"), ...both("pants_shin")], hides: [], freeform: false },
  boots: { existing: [], added: [...both("boots_foot"), ...both("boots_shin")], required: both("boots_foot"), hides: [], freeform: false },
  gloves: { existing: [], added: [...both("gloves_hand"), ...both("gloves_hand").map((s) => `${s}_back`)], required: both("gloves_hand"), hides: [], freeform: false },
  chain: { existing: [], added: ["chain"], required: ["chain"], hides: [], freeform: false },
  cape: { existing: [], added: ["cape_back"], required: ["cape_back"], hides: [], freeform: true },
  helmet: { existing: [], added: ["helmet"], required: ["helmet"], hides: ["hair_front", "hair_back"], freeform: true },
  hair: { existing: ["hair_front", "hair_back"], added: [], required: ["hair_front", "hair_back"], hides: [], freeform: true },
  face: { existing: ["eyes", "brows", "nose", "mouth"], added: [], required: ["eyes"], hides: [], freeform: false },
  mask: { existing: [], added: ["mask"], required: ["mask"], hides: [], freeform: true },
  weapon: { existing: ["weapon"], added: [], required: ["weapon"], hides: [], freeform: true }
};

/** Every rig slot an item slot may fill. */
export const rigSlotsOf = (slot: ItemSlot): string[] => [...ITEM_SLOT_MAP[slot].existing, ...ITEM_SLOT_MAP[slot].added];

/** The rig slots the pro rigs lack (the "new slots" list), in item-slot order. */
export const NEW_RIG_SLOTS: readonly string[] = ITEM_SLOTS.flatMap((s) => ITEM_SLOT_MAP[s].added);

/** Mapped rig slots that `doc` does not have. */
export function missingRigSlots(doc: AnimDocument): string[] {
  const have = new Set(doc.slots.map((s) => s.name));
  return ITEM_SLOTS.flatMap((s) => rigSlotsOf(s)).filter((n) => !have.has(n));
}

// ---------------------------------------------------------------------------------------------------------- naming

const ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const isItemSlot = (v: string): v is ItemSlot => (ITEM_SLOTS as readonly string[]).includes(v);

/** `chest` + `red-jerkin` -> `chest.red-jerkin`. Throws on a bad slot or id (the result must also be a valid skin name). */
export function itemSkinName(slot: ItemSlot, item: string): string {
  if (!isItemSlot(slot)) throw new Error(`unknown item slot '${slot}'`);
  if (!ITEM_ID.test(item)) throw new Error(`bad item id '${item}' (letters, digits, _ -, up to 40)`);
  const name = `${slot}.${item}`;
  if (!SKIN_NAME.test(name)) throw new Error(`bad skin name '${name}'`);
  return name;
}

/** The slot and item id of an item skin name, or null for any other skin (such as the base `body`). */
export function parseItemSkin(name: string): { slot: ItemSlot; item: string } | null {
  if (!SKIN_NAME.test(name)) return null;
  const dot = name.indexOf(".");
  if (dot < 1) return null;
  const slot = name.slice(0, dot);
  const item = name.slice(dot + 1);
  return isItemSlot(slot) && ITEM_ID.test(item) ? { slot, item } : null;
}

/** The item skins of a document, in order. */
export const itemSkins = (skins: Skins): { name: string; slot: ItemSlot; item: string }[] =>
  Object.keys(skins).flatMap((name) => {
    const p = parseItemSkin(name);
    return p ? [{ name, ...p }] : [];
  });

/** A new empty item skin with the hides its slot calls for (a helmet hides the hair). */
export function createItemSkin(skins: Skins, slot: ItemSlot, item: string): Skins {
  const name = itemSkinName(slot, item);
  let out = createSkin(skins, name);
  for (const hidden of ITEM_SLOT_MAP[slot].hides) out = setSkinHide(out, name, hidden, true);
  return out;
}

// ------------------------------------------------------------------------------------------------------- coverage

// front view retired 2026-10-25: the turned rig is the only view an item is made for.
export type ViewId = "turned";

export interface ViewCoverage {
  view: ViewId;
  /** The skin does not exist in this view's document. */
  absent: boolean;
  /** Required pieces the skin does not supply (the rig has the slot). */
  missing: string[];
  /** Required pieces the rig has no slot for yet (add the slot first). */
  noRigSlot: string[];
  /** Optional mapped slots the skin does supply. */
  optionalPresent: string[];
  /** Slots the skin fills that its item slot does not own. */
  stray: string[];
}

export interface ItemCoverage {
  skin: string;
  turned: ViewCoverage;
  /** The skin exists and has every required piece, and the rig has every slot. */
  complete: boolean;
}

function viewCoverage(view: ViewId, doc: AnimDocument, skinName: string, slot: ItemSlot): ViewCoverage {
  const skin = doc.skins[skinName];
  const spec = ITEM_SLOT_MAP[slot];
  const rigSlots = new Set(doc.slots.map((s) => s.name));
  const supplied = (n: string): boolean => Object.keys(skin?.attachments[n] ?? {}).length > 0;
  const owned = new Set(rigSlotsOf(slot));
  return {
    view,
    absent: !skin,
    missing: spec.required.filter((n) => rigSlots.has(n) && !supplied(n)),
    noRigSlot: spec.required.filter((n) => !rigSlots.has(n)),
    optionalPresent: skin ? rigSlotsOf(slot).filter((n) => !spec.required.includes(n) && supplied(n)) : [],
    stray: skin ? Object.keys(skin.attachments).filter((n) => !owned.has(n) && supplied(n)) : []
  };
}

/** What the item `skinName` (`<slot>.<item>`) still lacks in the turned view. */
export function itemCoverage(docTurned: AnimDocument, skinName: string): ItemCoverage {
  const parsed = parseItemSkin(skinName);
  if (!parsed) throw new Error(`'${skinName}' is not an item skin name (<slot>.<item>)`);
  const turned = viewCoverage("turned", docTurned, skinName, parsed.slot);
  const done = (v: ViewCoverage): boolean => !v.absent && !v.missing.length && !v.noRigSlot.length;
  return { skin: skinName, turned, complete: done(turned) };
}

// ---------------------------------------------------------------------------------------------------------- checks

export type ItemIssueKind = "name" | "missing piece" | "no rig slot" | "wrong side" | "stray piece" | "placeholder" | "hides" | "pivot drift" | "size";

export interface ItemIssue {
  kind: ItemIssueKind;
  view: ViewId;
  slot?: string;
  message: string;
}

const sideOf = (name: string): "near" | "far" | null => (/_near(_back)?$/.test(name) ? "near" : /_far(_back)?$/.test(name) ? "far" : null);
const boneSide = (bone: string): "near" | "far" | null => (/(^|_)near(_|$)/.test(bone) ? "near" : /(^|_)far(_|$)/.test(bone) ? "far" : null);

type Sized = { width: number; height: number };
const sizeOf = (a: AttachmentData | undefined): Sized | null => {
  const v = a as Partial<Sized> | undefined;
  return v && typeof v.width === "number" && typeof v.height === "number" && v.width > 0 && v.height > 0 ? { width: v.width, height: v.height } : null;
};
const originOf = (a: AttachmentData | undefined): [number, number] | null => {
  const v = a as { type?: string; x?: number; y?: number } | undefined;
  return v?.type === "region" ? [v.x ?? 0, v.y ?? 0] : null;
};

/** The base skin's piece that `piece` replaces: the same placeholder if the base has it, else the base's first one. */
function basePiece(doc: AnimDocument, slot: string, placeholder: string): AttachmentData | undefined {
  const base = doc.skins[Object.keys(doc.skins)[0]!]?.attachments[slot];
  if (!base) return undefined;
  return base[placeholder] ?? Object.values(base)[0];
}

function checkView(view: ViewId, doc: AnimDocument, skinName: string, slot: ItemSlot): ItemIssue[] {
  const issues: ItemIssue[] = [];
  const skin = doc.skins[skinName];
  const spec = ITEM_SLOT_MAP[slot];
  if (!skin) return [{ kind: "missing piece", view, message: `${view}: skin '${skinName}' does not exist` }];
  const cov = viewCoverage(view, doc, skinName, slot);
  for (const n of cov.missing) issues.push({ kind: "missing piece", view, slot: n, message: `${view}: required piece ${n} is missing` });
  for (const n of cov.noRigSlot) issues.push({ kind: "no rig slot", view, slot: n, message: `${view}: the rig has no slot ${n} yet` });
  for (const n of cov.stray) issues.push({ kind: "stray piece", view, slot: n, message: `${view}: ${n} is not a ${slot} slot` });

  const rigSlots = new Map(doc.slots.map((s) => [s.name, s]));
  for (const [rigSlot, byName] of Object.entries(skin.attachments)) {
    const data = rigSlots.get(rigSlot);
    if (!data) continue;
    // side: a near slot must ride a near bone (and far a far one)
    const want = sideOf(rigSlot);
    if (want && boneSide(data.bone) !== want) issues.push({ kind: "wrong side", view, slot: rigSlot, message: `${view}: ${rigSlot} sits on bone ${data.bone} (needs a ${want} bone)` });
    // placeholder: the slot shows its setup placeholder, so the item must supply that name
    if (data.attachment && Object.keys(byName).length && !(data.attachment in byName)) {
      issues.push({ kind: "placeholder", view, slot: rigSlot, message: `${view}: ${rigSlot} shows '${data.attachment}' but the item only has ${Object.keys(byName).map((k) => `'${k}'`).join(", ")}` });
    }
    if (spec.freeform) continue;
    const sizeFree = spec.sizeFree?.includes(rigSlot) ?? false;
    for (const [placeholder, piece] of Object.entries(byName)) {
      const base = basePiece(doc, rigSlot, placeholder);
      if (!base) continue;
      const a = sizeOf(piece);
      const b = sizeOf(base);
      if (a && b && !sizeFree) {
        for (const axis of ["width", "height"] as const) {
          const covers = axis === "height" && !!spec.neckCover?.includes(rigSlot);
          const r = covers ? Math.max(a[axis] - NECK_COVER_ALLOWANCE * b[axis], Math.min(a[axis], b[axis])) / b[axis] : a[axis] / b[axis];
          if (Math.abs(r - 1) > PIECE_SIZE_TOLERANCE) {
            issues.push({ kind: "size", view, slot: rigSlot, message: `${view}: ${rigSlot}/${placeholder} ${axis} is ${(r * 100).toFixed(0)}% of the base piece (allowed ${Math.round((1 - PIECE_SIZE_TOLERANCE) * 100)}..${Math.round((1 + PIECE_SIZE_TOLERANCE) * 100)}%)` });
          }
        }
      }
      const po = originOf(piece);
      const bo = originOf(base);
      if (po && bo) {
        const drift = Math.hypot(po[0] - bo[0], po[1] - bo[1]);
        if (drift > PIVOT_DRIFT_TOLERANCE_PX) issues.push({ kind: "pivot drift", view, slot: rigSlot, message: `${view}: ${rigSlot}/${placeholder} origin is ${drift.toFixed(0)} px from the base piece (allowed ${PIVOT_DRIFT_TOLERANCE_PX})` });
      }
    }
  }

  // hides: exactly the slot's hides (a helmet hides the hair, nothing else hides anything)
  const hides = new Set(skin.hides);
  for (const h of spec.hides) if (!hides.has(h)) issues.push({ kind: "hides", view, slot: h, message: `${view}: a ${slot} must hide ${h}` });
  for (const h of hides) if (!spec.hides.includes(h) && !spec.mayHide?.includes(h)) issues.push({ kind: "hides", view, slot: h, message: `${view}: a ${slot} must not hide ${h}` });
  return issues;
}

/** All checks of item `skinName` in the turned view. A bad name comes back as one "name" issue. */
export function checkItem(docTurned: AnimDocument, skinName: string): ItemIssue[] {
  const parsed = parseItemSkin(skinName);
  if (!parsed) return [{ kind: "name", view: "turned", message: `'${skinName}' is not an item skin name (<slot>.<item>)` }];
  return checkView("turned", docTurned, skinName, parsed.slot);
}

/** Where a rig slot that the pro rigs lack gets attached: the bone it rides. */
export function boneForAddedSlot(rigSlot: string): string | null {
  if (rigSlot === "helmet" || rigSlot === "mask") return "head";
  if (rigSlot === "chain" || rigSlot === "cape_back") return "chest";
  const m = /^(boots_foot|boots_shin|gloves_hand)_(near|far)(_back)?$/.exec(rigSlot);
  if (!m) return null;
  return `${m[1] === "boots_foot" ? "foot" : m[1] === "boots_shin" ? "shin" : "hand"}_${m[2]}`;
}
