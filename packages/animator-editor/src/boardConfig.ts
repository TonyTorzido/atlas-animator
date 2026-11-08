/*
 * Atlas Animator editor: Clip board custom slots and custom clips (pure, no DOM).
 *
 * The catalogue in gameClips.ts is fixed. The user can add more required clips ("slots") to a category, saved in
 * clips/board-config.json (GET / POST /api/board-config), and make free-form clips of their own ("My clips": any saved clip that
 * is not a project clip or a slot). This module validates names, parses the config, and turns a slot into a GameClip so the board
 * can give it the same status, tooltip and menu as the built-in ones.
 */
import { ATTACK_STEPS, CLASS_LABELS, CLASSES, clipId, clipStatus, GAME_CLIPS, LEGACY_CLIP_ALIASES, WEAPON_LABELS, WEAPONS } from "./gameClips.js";
import type { ClipData } from "@atlas-animator/core/core";
import { clipFps, setDuration, snapClipTimes } from "./clipModel.js";
import type { BoardInputs, BoardState, BoardSummary, ClipStatus, GameClip, Klass, Weapon } from "./gameClips.js";

export const SLOT_CATEGORIES = ["move", "gather", "guard", "other", "attack"] as const;
export type SlotCategory = (typeof SLOT_CATEGORIES)[number];

export const SLOT_CATEGORY_LABELS: Readonly<Record<SlotCategory, string>> = {
  move: "Move",
  gather: "Gather",
  guard: "Guard",
  other: "Other (reaction, emote, carry)",
  attack: "Attack combo step"
};

export interface CustomSlot {
  id: string;
  label: string;
  category: SlotCategory;
  /** Attack steps only: the matrix cell. */
  weapon?: Weapon;
  klass?: Klass | null;
  step?: number;
  loop: boolean;
  durationS: number;
}

export interface BoardConfig {
  slots: CustomSlot[];
}

export const NAME_MAX = 96;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Why a clip name cannot be used, or null when it can. `taken` are names already in use (library + saved files). */
export function clipNameError(raw: string, taken: ReadonlySet<string>, ownName?: string): string | null {
  const name = raw.trim();
  if (!name) return "Give the clip a name.";
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  if (!NAME_RE.test(name)) return "Use letters, digits, _ . - (no spaces).";
  if (/\.clip(\.json)?$/i.test(name)) return "Leave off .clip.json: it is added for you.";
  if (name === ownName) return null;
  if (GAME_CLIPS.some((c) => c.id === name) || name in LEGACY_CLIP_ALIASES) return "That is a project clip name: open it from the board instead.";
  if (taken.has(name)) return "A clip with that name already exists.";
  return null;
}

/** A name for a label: "Emote: dance!" -> "emote_dance". */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** The first free name from `base`, then `base2`, `base3`... */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}_x`;
}

export function parseBoardConfig(v: unknown): BoardConfig {
  const slots: CustomSlot[] = [];
  const raw = (v as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(raw)) return { slots };
  const seen = new Set<string>();
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const { id, label, category } = e;
    if (typeof id !== "string" || typeof label !== "string" || !SLOT_CATEGORIES.includes(category as SlotCategory)) continue;
    if (!NAME_RE.test(id) || id.length > NAME_MAX || seen.has(id) || GAME_CLIPS.some((c) => c.id === id)) continue;
    const slot: CustomSlot = {
      id,
      label: label.trim() || id,
      category: category as SlotCategory,
      loop: e.loop === true,
      durationS: typeof e.durationS === "number" && e.durationS > 0 && e.durationS <= 60 ? e.durationS : 1
    };
    if (slot.category === "attack") {
      if (!(WEAPONS as readonly string[]).includes(e.weapon as string) || typeof e.step !== "number" || e.step < 1) continue;
      slot.weapon = e.weapon as Weapon;
      slot.klass = (CLASSES as readonly string[]).includes(e.klass as string) ? (e.klass as Klass) : null;
      slot.step = Math.floor(e.step);
    }
    seen.add(id);
    slots.push(slot);
  }
  return { slots };
}

/** The id an attack-step slot gets (the same naming as the built-in combos). */
export function attackSlotId(weapon: Weapon, klass: Klass | null, step: number): string {
  return clipId({ kind: "attack", weapon, klass, step });
}

/** The next combo step number free in a matrix cell, counting built-in and custom steps. */
export function nextStep(slots: readonly CustomSlot[], weapon: Weapon, klass: Klass | null): number {
  const used: number[] = [
    ...ATTACK_STEPS,
    ...slots.filter((s) => s.category === "attack" && s.weapon === weapon && (s.klass ?? null) === klass).map((s) => s.step ?? 0)
  ];
  return Math.max(...used) + 1;
}

/** Label for an attack-step slot, in the same words as the built-in ones. */
export function attackSlotLabel(weapon: Weapon, klass: Klass | null, step: number): string {
  const who = klass ? `${CLASS_LABELS[klass]} ${WEAPON_LABELS[weapon].toLowerCase()}` : `${WEAPON_LABELS[weapon]} (generic)`;
  return `${who} attack ${step}`;
}

export function slotToGameClip(s: CustomSlot): GameClip {
  const group = s.category === "other" ? "emote" : s.category;
  return {
    id: s.id,
    group,
    label: s.label,
    rig: "pro-turned",
    facing: "left",
    mirrorForRight: true,
    weapon: s.category === "attack" ? (s.weapon ?? null) : null,
    klass: s.category === "attack" ? (s.klass ?? null) : null,
    tool: null,
    ...(s.category === "attack" ? { step: s.step } : {}),
    loop: s.loop,
    timing: { source: "none", durationS: s.durationS },
    custom: true
  };
}

/** Adds the custom slots to a catalogue summary: they count toward the total, the bar and the filters. */
export function addSlotsToSummary(sum: BoardSummary, slots: readonly CustomSlot[], have: ReadonlySet<string>, board: BoardState, inputs: BoardInputs): BoardSummary {
  const status: Record<string, ClipStatus> = { ...sum.status };
  const counts = { ...sum.counts };
  for (const s of slots) {
    const st = clipStatus(slotToGameClip(s), have, board, inputs);
    status[s.id] = st;
    counts[st]++;
  }
  const total = sum.total + slots.length;
  return { status, counts, total, progress: total ? counts.done / total : 0, problems: counts["needs-recheck"] + counts.broken };
}

/** Names of the clips that are the user's own: saved or newly made, not a project clip, a legacy alias or a slot. */
export function customClipNames(names: Iterable<string>, slots: readonly CustomSlot[]): string[] {
  const reserved = new Set<string>([...GAME_CLIPS.map((c) => c.id), ...Object.values(LEGACY_CLIP_ALIASES).flat(), ...slots.map((s) => s.id)]);
  return [...new Set(names)].filter((n) => !reserved.has(n)).sort((a, b) => a.localeCompare(b));
}

/** A board entry for a free-form clip, so it gets the same status, tooltip and menu as a project clip. */
export function customClipEntry(name: string): GameClip {
  return {
    id: name, group: "emote", label: name, rig: "pro-turned", facing: "left", mirrorForRight: true,
    weapon: null, klass: null, tool: null, loop: false, timing: { source: "none" }, custom: true, mine: true
  };
}

/**
 * The clip with a new length (seconds) and frame rate. Keys keep their times and snap onto the new frame grid; keys past the new
 * end are dropped (counted in `dropped`).
 */
export function retimeClip(clip: ClipData, durationS: number, fps: number): { clip: ClipData; dropped: number } {
  const base = structuredClone(clip);
  base.fps = fps;
  const out = setDuration(base, durationS);
  return { clip: snapClipTimes(out.clip), dropped: out.dropped };
}

/** The length and fps the dialogs show for a clip: seconds rounded to 3 places, fps as is. */
export function clipLengthFps(clip: ClipData): { seconds: number; fps: number } {
  return { seconds: Math.round(clip.duration * 1000) / 1000, fps: clipFps(clip) };
}

export const FPS_MIN = 1;
export const FPS_MAX = 120;
export const LENGTH_MAX_S = 60;

/** Why a length / fps pair cannot be used, or null. */
export function lengthFpsError(seconds: number, fps: number): string | null {
  if (!Number.isFinite(fps) || fps < FPS_MIN || fps > FPS_MAX || !Number.isInteger(fps)) return `Frames per second: a whole number from ${FPS_MIN} to ${FPS_MAX}.`;
  if (!Number.isFinite(seconds) || seconds <= 0) return "Length must be more than 0 seconds.";
  if (seconds > LENGTH_MAX_S) return `Length can be at most ${LENGTH_MAX_S} seconds.`;
  return null;
}
