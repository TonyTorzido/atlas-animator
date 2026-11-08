/*
 * Atlas Animator editor: original implementation.
 *
 * Skins (pure, like slotModel.ts). A skin is a named set of attachments: skin -> slot -> placeholder -> attachment.
 * The placeholder name is the stable handle (Spine's "skin placeholder"): a slot's setup pose and a clip's
 * `slots.<slot>.attachment` keys name a placeholder, and each active skin decides which image that placeholder
 * shows. Several skins may be active at once, in order; where two define the same placeholder of a slot the later
 * one wins (the engine's rule, Skeleton.setActiveSkins), so "base + outfit" is the list [base, outfit].
 */
import type { AnimDocument, AttachmentData, SkinData } from "@atlas-animator/core/core";

export type Skins = AnimDocument["skins"];

/** Same shape the format uses for skin, slot, attachment and placeholder names. */
export const SKIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

const clone = <T>(v: T): T => structuredClone(v);

function need(skins: Skins, name: string): SkinData {
  const skin = skins[name];
  if (!skin) throw new Error(`no skin '${name}'`);
  return skin;
}

function validName(name: string): void {
  if (!SKIN_NAME.test(name)) throw new Error(`bad name '${name}' (letters, digits, _ . -)`);
}

/** The skin names in document order; the first is the base (the engine's default and the Spine "default" skin). */
export const skinNames = (skins: Skins): string[] => Object.keys(skins);
export const baseSkin = (skins: Skins): string | undefined => Object.keys(skins)[0];

/** A fresh unused name: `base`, then `base-2`, `base-3`... */
export function uniqueSkinName(skins: Skins, base: string): string {
  const stem = SKIN_NAME.test(base) ? base : "skin";
  if (!(stem in skins)) return stem;
  for (let n = 2; ; n++) if (!(`${stem}-${n}` in skins)) return `${stem}-${n}`;
}

/** Adds an empty skin. */
export function createSkin(skins: Skins, name: string): Skins {
  validName(name);
  if (name in skins) throw new Error(`skin '${name}' exists`);
  return { ...clone(skins), [name]: { attachments: {}, hides: [], bones: [], constraints: [] } as SkinData };
}

/** Rewrites `skin` fields equal to `from` (linked mesh sources, contour references) to `to`, in place. */
function retarget(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) value.forEach((v) => retarget(v, from, to));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === "skin" && v === from) o[k] = to;
      else retarget(v, from, to);
    }
  }
}

/** Copies a skin under a new name (placed right after the source; self references follow the copy). */
export function duplicateSkin(skins: Skins, name: string, copyName: string): Skins {
  validName(copyName);
  if (copyName in skins) throw new Error(`skin '${copyName}' exists`);
  const copy = clone(need(skins, name));
  retarget(copy, name, copyName);
  const out: Skins = {};
  for (const [k, v] of Object.entries(skins)) {
    out[k] = clone(v);
    if (k === name) out[copyName] = copy;
  }
  return out;
}

/** Other skins that name `name` (linked mesh sources, contour references). */
export function skinReferences(skins: Skins, name: string): string[] {
  const found: string[] = [];
  for (const [other, skin] of Object.entries(skins)) {
    if (other === name) continue;
    let hit = false;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (k === "skin" && x === name) hit = true;
          else walk(x);
        }
      }
    };
    walk(skin);
    if (hit) found.push(other);
  }
  return found;
}

/** Removes a skin. The last skin cannot go, nor one another skin's attachments still point at. */
export function deleteSkin(skins: Skins, name: string): Skins {
  need(skins, name);
  if (Object.keys(skins).length < 2) throw new Error("a rig needs at least one skin");
  const refs = skinReferences(skins, name);
  if (refs.length) throw new Error(`skin '${name}' is used by ${refs.join(", ")}`);
  const out = clone(skins);
  delete out[name];
  return out;
}

/** Renames a skin, keeping its position (the base stays the base). Other skins' references follow. */
export function renameSkin(skins: Skins, name: string, to: string): Skins {
  need(skins, name);
  validName(to);
  if (to === name) return clone(skins);
  if (to in skins) throw new Error(`skin '${to}' exists`);
  const out: Skins = {};
  for (const [k, v] of Object.entries(skins)) {
    const skin = clone(v);
    retarget(skin, name, to);
    out[k === name ? to : k] = skin;
  }
  return out;
}

/** renameSkin plus every document-level reference: driven gates, coverage, clip deform keys. Returns a new document. */
export function renameSkinInDocument(doc: AnimDocument, name: string, to: string): AnimDocument {
  const skins = renameSkin(doc.skins, name, to);
  const { skins: _old, animations, ...other } = clone(doc);
  retarget(other, name, to);
  for (const clip of Object.values(animations ?? {})) {
    const deform = (clip as { deform?: Record<string, unknown> }).deform;
    if (deform && name in deform) {
      deform[to] = deform[name];
      delete deform[name];
    }
  }
  return { ...other, animations, skins } as AnimDocument;
}

/** Sets one attachment of a skin under `placeholder` of `slot`. */
export function setSkinAttachment(skins: Skins, skinName: string, slot: string, placeholder: string, attachment: AttachmentData): Skins {
  need(skins, skinName);
  validName(placeholder);
  const out = clone(skins);
  const bySlot = (out[skinName]!.attachments[slot] ??= {});
  bySlot[placeholder] = clone(attachment);
  return out;
}

/** Removes a skin's attachment for `placeholder` of `slot` (an emptied slot entry goes with it). */
export function removeSkinAttachment(skins: Skins, skinName: string, slot: string, placeholder: string): Skins {
  need(skins, skinName);
  const out = clone(skins);
  const bySlot = out[skinName]!.attachments[slot];
  if (!bySlot || !(placeholder in bySlot)) throw new Error(`skin '${skinName}' has no ${slot}/${placeholder}`);
  delete bySlot[placeholder];
  if (!Object.keys(bySlot).length) delete out[skinName]!.attachments[slot];
  return out;
}

/** Copies an attachment from one skin to another, optionally under another placeholder name (default: the same). */
export function copySkinAttachment(skins: Skins, from: string, slot: string, placeholder: string, to: string, asPlaceholder = placeholder): Skins {
  const source = need(skins, from).attachments[slot]?.[placeholder];
  if (!source) throw new Error(`skin '${from}' has no ${slot}/${placeholder}`);
  return setSkinAttachment(skins, to, slot, asPlaceholder, source);
}

/** The attachment with its colour replaced (a tint multiplies the image): how a test outfit differs without new images. */
export function tintedAttachment(attachment: AttachmentData, color: string): AttachmentData {
  if (attachment.type === "point" || attachment.type === "linkedMesh") return clone(attachment);
  return { ...clone(attachment), color } as AttachmentData;
}

/** Hides (or shows again) a slot while the skin is active. */
export function setSkinHide(skins: Skins, skinName: string, slot: string, hidden: boolean): Skins {
  need(skins, skinName);
  const out = clone(skins);
  const hides = new Set(out[skinName]!.hides);
  if (hidden) hides.add(slot);
  else hides.delete(slot);
  out[skinName]!.hides = [...hides];
  return out;
}

/** Placeholder names any skin defines for `slot`, with the skins that provide each. */
export function slotPlaceholderSkins(skins: Skins, slot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [skinName, skin] of Object.entries(skins)) {
    for (const placeholder of Object.keys(skin.attachments[slot] ?? {})) out.set(placeholder, [...(out.get(placeholder) ?? []), skinName]);
  }
  return out;
}

export interface ResolvedPlaceholder {
  slot: string;
  placeholder: string;
  /** The active skin whose attachment shows. */
  skin: string;
  /** The earlier active skins it covers. */
  covers: string[];
}

/** What the active skins (in order, later wins) show per slot placeholder, without hides. */
export function resolveActive(skins: Skins, active: readonly string[]): ResolvedPlaceholder[] {
  const winner = new Map<string, ResolvedPlaceholder>();
  for (const skinName of active) {
    const skin = skins[skinName];
    if (!skin) continue;
    for (const [slot, byName] of Object.entries(skin.attachments)) {
      for (const placeholder of Object.keys(byName)) {
        const key = `${slot}/${placeholder}`;
        const prior = winner.get(key);
        winner.set(key, { slot, placeholder, skin: skinName, covers: prior ? [...prior.covers, prior.skin] : [] });
      }
    }
  }
  return [...winner.values()];
}

/** Slots hidden by the active skins. */
export function activeHides(skins: Skins, active: readonly string[]): string[] {
  return [...new Set(active.flatMap((n) => skins[n]?.hides ?? []))];
}

/**
 * The active list for "this skin on top of the base": [base, ...mixed layers, chosen], without repeats and without
 * names that no longer exist. The base is always first (it holds the body the outfits are laid on).
 */
export function activeList(skins: Skins, chosen: string | null, mixed: readonly string[] = []): string[] {
  const base = baseSkin(skins);
  const out: string[] = [];
  for (const n of [base, ...mixed, chosen]) if (n && n in skins && !out.includes(n)) out.push(n);
  return out;
}

/** Sets the setup-pose placeholder of a slot (null = nothing shown in the setup pose). Returns new slots. */
export function setSetupPlaceholder(slots: AnimDocument["slots"], slot: string, placeholder: string | null): AnimDocument["slots"] {
  if (!slots.some((s) => s.name === slot)) throw new Error(`no slot '${slot}'`);
  return slots.map((s) => {
    const next = clone(s) as Record<string, unknown>;
    if (s.name === slot) {
      next.attachment = placeholder;
    }
    return next as typeof s;
  });
}
