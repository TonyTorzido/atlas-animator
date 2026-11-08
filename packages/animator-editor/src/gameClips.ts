/*
 * Atlas Animator editor: project clip catalogue (pure, no DOM). See the design notes section 2.
 *
 * The list of every clip the project wants for the player: what it is called (`clipId`), which rig and facing it is drawn on,
 * which weapon / class it belongs to, whether it loops and where its timing comes from. The Clip board UI renders this
 * list; clipTemplates.ts turns an entry into a starter ClipData; `boardSummary` turns "which clips exist" plus the saved
 * board state into a status per clip.
 */
import { COMBAT_STYLE_IDS } from "./preview/attackProfiles.js";
import { gameClipsFor, mappedEditorClips } from "../../animator/src/clipMap.js";

export const WEAPONS = ["sword", "axe", "hammer_shield", "scepter_relic", "bow", "staff"] as const;
export type Weapon = (typeof WEAPONS)[number];

export const CLASSES = ["ronin", "warrior", "paladin", "cleric", "ranger", "mage"] as const;
export type Klass = (typeof CLASSES)[number];

/** The one class -> weapon table (one weapon each). Change it here and the whole catalogue follows. */
export const CLASS_WEAPON: Readonly<Record<Klass, Weapon>> = {
  ronin: "sword",
  warrior: "axe",
  paladin: "hammer_shield",
  cleric: "scepter_relic",
  ranger: "bow",
  mage: "staff"
};

export const WEAPON_LABELS: Readonly<Record<Weapon, string>> = {
  sword: "Sword",
  axe: "Double axe",
  hammer_shield: "Hammer and shield",
  scepter_relic: "Scepter and relic",
  bow: "Bow",
  staff: "Staff"
};

export const CLASS_LABELS: Readonly<Record<Klass, string>> = {
  ronin: "Ronin",
  warrior: "Warrior",
  paladin: "Paladin",
  cleric: "Cleric",
  ranger: "Ranger",
  mage: "Mage"
};

export type ClipGroup = "move" | "gather" | "attack" | "guard" | "react" | "emote" | "carry";
// front view retired 2026-10-25: every project clip is on the turned rig.
export type RigId = "pro-turned";
export type GatherTool = "axe" | "pick" | "rod";

/**
 * Where a clip's timing comes from:
 * - "profile": a real attack profile (shared attackProfiles.ts);
 * - "gather": the sample gather timings below;
 * - "default": no real source yet, the numbers are a placeholder (the UI badges "timing not in project yet");
 * - "none": nothing in the project drives the length; it is authored freely (walk cycles, reactions, emotes).
 */
export type TimingSource = "profile" | "gather" | "default" | "none";

export interface ClipTiming {
  source: TimingSource;
  /** Attacks: the combat style whose profile is used ("default" when the weapon / class has none). */
  styleId?: string;
  /** Fixed length in seconds (gathers, moves, reactions); attacks take their length from the profile. */
  durationS?: number;
  /** Gathers: where the tool lands, as a fraction of the cycle. */
  impactAt?: number;
}

export interface GameClip {
  id: string;
  group: ClipGroup;
  label: string;
  rig: RigId;
  facing: "left";
  mirrorForRight: boolean;
  weapon: Weapon | null;
  klass: Klass | null;
  tool: GatherTool | null;
  step?: number;
  loop: boolean;
  timing: ClipTiming;
  /** An user-made slot or clip (clips/board-config.json), not a catalogue entry: its template is blank. */
  custom?: boolean;
  /** A free-form clip of the user's (My clips), not a required slot. */
  mine?: boolean;
}

export const ATTACK_STEPS = [1, 2, 3] as const;

export type ClipSpec =
  | { kind: "attack"; weapon: Weapon; klass?: Klass | null; step: number }
  | { kind: "guard"; weapon: Weapon }
  | { kind: "gather"; name: "chop" | "mine" | "harvest" | "fish" | "plant" }
  | { kind: "named"; name: string };

/** The one place clip names are built. */
export function clipId(spec: ClipSpec): string {
  switch (spec.kind) {
    case "attack":
      return spec.klass ? `atk_${spec.weapon}_${spec.klass}_${spec.step}` : `atk_${spec.weapon}_${spec.step}`;
    case "guard":
      return `guard_walk_${spec.weapon}`;
    case "gather":
      return `gather_${spec.name}`;
    case "named":
      return spec.name;
  }
}

/** The combat style id for a weapon / class pair, or "default" when the project has no profile for it. */
export function styleIdFor(weapon: Weapon, klass: Klass | null): string {
  const id = `${weapon}:${klass ?? "generic"}`;
  return (COMBAT_STYLE_IDS as readonly string[]).includes(id) ? id : "default";
}

/**
 * Gather timing mirrored from GATHER_PROGRAMS (sample timings): chop 1000 ms / 0.555, mine 1300 ms /
 * 0.64, harvest 1100 ms / 0.43, fish cast = GATHER_TUNING.fish.castMs (900 ms, no impact). A test pins these to the source.
 * Planting has no program yet.
 */
export const GATHER_TIMING = {
  chop: { durationS: 1.0, impactAt: 0.555 },
  mine: { durationS: 1.3, impactAt: 0.64 },
  harvest: { durationS: 1.1, impactAt: 0.43 },
  fish: { durationS: 0.9, impactAt: null }
} as const;

const PLANT_DEFAULT_S = 1.0;

/** Authored lengths (seconds) for clips the project does not time. The walk cycle matches the rig's walk_in_place (28 frames). */
const WALK_S = 28 / 30;
const MOVE_LENGTHS = { idle: 3.2, walk_down: WALK_S, walk_side: WALK_S, run: 0.6, dash: 0.4 } as const;

function move(name: keyof typeof MOVE_LENGTHS, label: string, rig: RigId, loop: boolean): GameClip {
  return {
    id: clipId({ kind: "named", name }), group: "move", label, rig, facing: "left", mirrorForRight: rig === "pro-turned",
    weapon: null, klass: null, tool: null, loop, timing: { source: "none", durationS: MOVE_LENGTHS[name] }
  };
}

function other(name: string, group: ClipGroup, label: string, rig: RigId, loop: boolean, durationS: number): GameClip {
  return {
    id: name, group, label, rig, facing: "left", mirrorForRight: rig === "pro-turned",
    weapon: null, klass: null, tool: null, loop, timing: { source: "none", durationS }
  };
}

function gather(name: "chop" | "mine" | "harvest" | "fish" | "plant", label: string, tool: GatherTool | null): GameClip {
  const base = { id: clipId({ kind: "gather", name }), group: "gather" as const, label, rig: "pro-turned" as const, facing: "left" as const, mirrorForRight: true, weapon: null, klass: null, tool, loop: true };
  if (name === "plant") return { ...base, timing: { source: "default", durationS: PLANT_DEFAULT_S } };
  const t = GATHER_TIMING[name];
  return { ...base, timing: { source: "gather", durationS: t.durationS, ...(t.impactAt === null ? {} : { impactAt: t.impactAt }) } };
}

function attack(weapon: Weapon, klass: Klass | null, step: 1 | 2 | 3): GameClip {
  const styleId = styleIdFor(weapon, klass);
  const who = klass ? `${CLASS_LABELS[klass]} ${WEAPON_LABELS[weapon].toLowerCase()}` : `${WEAPON_LABELS[weapon]} (generic)`;
  return {
    id: clipId({ kind: "attack", weapon, klass, step }), group: "attack", label: `${who} attack ${step}`,
    rig: "pro-turned", facing: "left", mirrorForRight: true, weapon, klass, tool: null, step, loop: false,
    timing: { source: styleId === "default" ? "default" : "profile", styleId }
  };
}

function buildCatalogue(): readonly GameClip[] {
  const out: GameClip[] = [
    move("idle", "Idle", "pro-turned", true),
    move("walk_down", "Walk down", "pro-turned", true),
    move("walk_side", "Walk side", "pro-turned", true),
    move("run", "Run", "pro-turned", true),
    move("dash", "Dash", "pro-turned", false),
    gather("chop", "Chop (axe)", "axe"),
    gather("mine", "Mine (pick)", "pick"),
    gather("harvest", "Harvest (bare hands)", null),
    gather("fish", "Fish (rod)", "rod"),
    gather("plant", "Plant", null)
  ];
  for (const weapon of WEAPONS) for (const step of ATTACK_STEPS) out.push(attack(weapon, null, step));
  for (const klass of CLASSES) for (const step of ATTACK_STEPS) out.push(attack(CLASS_WEAPON[klass], klass, step));
  for (const weapon of WEAPONS) {
    out.push({
      id: clipId({ kind: "guard", weapon }), group: "guard", label: `Guard walk (${WEAPON_LABELS[weapon].toLowerCase()})`,
      rig: "pro-turned", facing: "left", mirrorForRight: true, weapon, klass: null, tool: null, loop: true,
      timing: { source: "none", durationS: WALK_S }
    });
  }
  out.push(
    other("hit_react", "react", "Hit reaction", "pro-turned", false, 0.4),
    other("death", "react", "Death", "pro-turned", false, 1.2),
    other("emote_wave", "emote", "Emote: wave", "pro-turned", false, 1.5),
    other("emote_cheer", "emote", "Emote: cheer", "pro-turned", false, 1.5),
    other("carry_idle", "carry", "Carry idle", "pro-turned", true, 2.0),
    other("carry_walk", "carry", "Carry walk", "pro-turned", true, WALK_S)
  );
  return Object.freeze(out);
}

/** Every clip the project wants for the player. */
export const GAME_CLIPS: readonly GameClip[] = buildCatalogue();

export function findClip(id: string): GameClip | undefined {
  return GAME_CLIPS.find((c) => c.id === id);
}

export function clipsInGroup(group: ClipGroup): readonly GameClip[] {
  return GAME_CLIPS.filter((c) => c.group === group);
}

/** Attack clips of one matrix cell: row = a class or null for generic, column = a weapon. Empty when the class uses another weapon. */
export function matrixCell(klass: Klass | null, weapon: Weapon): readonly GameClip[] {
  return GAME_CLIPS.filter((c) => c.group === "attack" && c.weapon === weapon && c.klass === klass);
}

/** The runtime clip ids a catalogue clip feeds (packages/animator/clipMap.json, PL-03); empty = not in the project yet. */
export function gameIdsFor(id: string): string[] {
  return gameClipsFor(id).map((g) => g.id);
}

/** Catalogue clips with no clipMap.json row: Ship lists them as "not in project". */
export function clipsNotInGame(): readonly GameClip[] {
  const mapped = new Set(mappedEditorClips());
  return GAME_CLIPS.filter((c) => !mapped.has(c.id));
}

/**
 * Names the rigs and game already use for clips this catalogue calls something else (a runtime plays
 * idle_weight_shift and walk_in_place). An existing clip under the alias counts as the catalogue clip existing.
 */
export const LEGACY_CLIP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  idle: ["idle_weight_shift"],
  walk_down: ["walk_in_place"]
};

function exists(id: string, have: ReadonlySet<string>): boolean {
  return have.has(id) || (LEGACY_CLIP_ALIASES[id]?.some((a) => have.has(a)) ?? false);
}

// ---------------------------------------------------------------------------------------------
// Board status
// ---------------------------------------------------------------------------------------------

export type ClipStatus = "missing" | "draft" | "done" | "needs-recheck" | "broken";

/** clips/board.json: what the user marked done, against which rig. */
export type BoardState = Record<string, { done: boolean; rigHash: string; updated: string }>;

export interface BoardInputs {
  /** Current hash of each rig (by rig id). A done clip whose stored hash differs needs a re-check. A rig with no hash is not checked. */
  rigHashes?: Partial<Record<RigId, string>>;
  /** Gate error counts per clip id (clipGates, severity error). Unknown clips count as clean. */
  gateErrors?: Readonly<Record<string, number>>;
}

export interface BoardSummary {
  status: Record<string, ClipStatus>;
  counts: Record<ClipStatus, number>;
  total: number;
  /** done / total, 0..1. */
  progress: number;
  /** Clips with a problem the user should look at: needs-recheck or broken. */
  problems: number;
}

export function clipStatus(clip: GameClip, have: ReadonlySet<string>, board: BoardState, inputs: BoardInputs = {}): ClipStatus {
  if (!exists(clip.id, have)) return "missing";
  const entry = board[clip.id];
  if (!entry?.done) return "draft";
  const hash = inputs.rigHashes?.[clip.rig];
  if (hash !== undefined && entry.rigHash !== hash) return "needs-recheck";
  if ((inputs.gateErrors?.[clip.id] ?? 0) > 0) return "broken";
  return "done";
}

/** Status per catalogue clip, plus counts and progress. Pure: the caller supplies the clip names, board file and gate results. */
export function boardSummary(existingClipIds: Iterable<string>, boardState: BoardState, inputs: BoardInputs = {}): BoardSummary {
  const have = new Set(existingClipIds);
  const status: Record<string, ClipStatus> = {};
  const counts: Record<ClipStatus, number> = { missing: 0, draft: 0, done: 0, "needs-recheck": 0, broken: 0 };
  for (const clip of GAME_CLIPS) {
    const s = clipStatus(clip, have, boardState, inputs);
    status[clip.id] = s;
    counts[s]++;
  }
  const total = GAME_CLIPS.length;
  return { status, counts, total, progress: total ? counts.done / total : 0, problems: counts["needs-recheck"] + counts.broken };
}
