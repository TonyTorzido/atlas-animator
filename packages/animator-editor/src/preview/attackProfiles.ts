/** Weapon family ids a profile can be keyed by. */
export type WeaponCategory =
  | "sword" | "axe" | "hammer" | "shield" | "two_handed_martial"
  | "bow" | "crossbow" | "dagger" | "spear" | "staff" | "shuriken" | "wand"
  | "brass_knuckles" | "blowdart" | "sling" | "scepter";

/**
 * Attack cadence profiles (docs/plans/attack-cadence-profiles.md): the action-combat swing timing per
 * (class, weapon family), as data. The server resolves swings with these (recovery gate, combo, damage factor,
 * when damage lands); the client predicts and animates with the same numbers, so changing a combo is a data
 * change here and nowhere else.
 *
 * A step's cadence is `windupMs + recoveryMs`: the press-to-next-press time while the combo chains. It is counted
 * in 20 Hz server ticks (`attackStepCycleTicks`), rounded to the nearest tick, on both sides.
 *
 * Shots (ranged weapons) keep their own fixed rules in actionCombat.ts and never read a profile.
 * The legacy tap-to-attack auto-attack (and PvP, which only it reaches) keeps the 1.4 s beat; profiles do not
 * touch it. Monsters, DoT/HoT and regen ticks keep their own beat grid.
 */

/** Server tick length the profile timings are counted in (20 Hz). */
export const ATTACK_PROFILE_TICK_LENGTH_MS = 50;
/** Longest combo a profile may define; the wire comboIndex accepts 0 .. ATTACK_COMBO_MAX_LENGTH - 1. */
export const ATTACK_COMBO_MAX_LENGTH = 6;

export type AttackSwingStep = Readonly<{
  /** Press to blade contact (ms): the client's contact frame and hit effects; with "contact" hit timing, the server hit too. */
  windupMs: number;
  /** Contact to the next accepted press (ms) while the combo chains. */
  recoveryMs: number;
  /** Factor on the basic-attack damage for this step (the per-hit DPS lever). */
  damageMultiplier: number;
  /** Knockback on a surviving mob (0 = none; skipped, not applied). */
  knockbackM: number;
}>;

/**
 * When the server lands a step's damage. "press": on the tick it resolves the press (today's swing; its 105 / 119 ms
 * contact is client presentation only). "contact": `windupMs` after it, rounded to the tick (`attackStepServerHitDelayTicks`).
 */
export type AttackHitTiming = "press" | "contact";

/** Combat styles: one attack profile each. Resolved server side by `combatStyleFor` and sent in the combat snapshot. */
export const COMBAT_STYLE_IDS = ["default", "sword:generic", "sword:ronin", "axe:generic", "axe:warrior"] as const;
export type CombatStyleId = (typeof COMBAT_STYLE_IDS)[number];

export type AttackProfile = Readonly<{
  /** The CombatStyleId for a registered profile. */
  id: string;
  label: string;
  /** One entry per combo step, played in order and wrapping after the last (the finisher). */
  combo: readonly AttackSwingStep[];
  /** Idle longer than this since the previous swing's press and the combo restarts at step 0. */
  comboResetMs: number;
  hitTiming: AttackHitTiming;
}>;

export const DEFAULT_ATTACK_PROFILE_ID = "default" satisfies CombatStyleId;

/**
 * Today's live swing, exactly: contact at 105 / 105 / 119 ms (the drawn hit frame, sample contact timing),
 * a 700 / 700 / 900 ms cadence (14 / 14 / 18 ticks), damage 0.5 / 0.5 / 0.75, reset after 1.3 s idle, no knockback,
 * damage on the press.
 */
export const DEFAULT_ATTACK_PROFILE: AttackProfile = Object.freeze({
  id: DEFAULT_ATTACK_PROFILE_ID,
  label: "Default swing",
  combo: Object.freeze([
    Object.freeze({ windupMs: 105, recoveryMs: 595, damageMultiplier: 0.5, knockbackM: 0 }),
    Object.freeze({ windupMs: 105, recoveryMs: 595, damageMultiplier: 0.5, knockbackM: 0 }),
    Object.freeze({ windupMs: 119, recoveryMs: 781, damageMultiplier: 0.75, knockbackM: 0 })
  ]),
  comboResetMs: 1_300,
  hitTiming: "press"
});

/**
 * Animator numbers (2026-10-21): contact 100 / 100 / 133 ms, next press 500 / 500 / 650 ms, reset 1.0 s. Damage keeps
 * the proposed 1 : 1 : 1.5 shape (0.36 / 0.36 / 0.54) scaled to the default's DPS (0.761 basic hits/s over a
 * 1.65 s combo): 0.359 / 0.359 / 0.538, +0.05 % (the proposal was +0.36 %).
 */
export const SWORD_GENERIC_ATTACK_PROFILE: AttackProfile = Object.freeze({
  id: "sword:generic",
  label: "Sword combo",
  combo: Object.freeze([
    Object.freeze({ windupMs: 100, recoveryMs: 400, damageMultiplier: 0.359, knockbackM: 0 }),
    Object.freeze({ windupMs: 100, recoveryMs: 400, damageMultiplier: 0.359, knockbackM: 0 }),
    Object.freeze({ windupMs: 133, recoveryMs: 517, damageMultiplier: 0.538, knockbackM: 0 })
  ]),
  comboResetMs: 1_000,
  hitTiming: "contact"
});

/**
 * Animator numbers (2026-10-21), the Ronin samurai combo: contact 133 / 133 / 200 ms, next press 650 / 800 / 1000 ms,
 * reset 1.5 s. Damage keeps the proposed 0.54 / 0.54 / 0.80 shape scaled to the default's DPS over the 2.45 s combo:
 * 0.535 / 0.535 / 0.793, -0.06 % (the proposal was +0.85 %).
 */
export const SWORD_RONIN_ATTACK_PROFILE: AttackProfile = Object.freeze({
  id: "sword:ronin",
  label: "Ronin samurai combo",
  combo: Object.freeze([
    Object.freeze({ windupMs: 133, recoveryMs: 517, damageMultiplier: 0.535, knockbackM: 0 }),
    Object.freeze({ windupMs: 133, recoveryMs: 667, damageMultiplier: 0.535, knockbackM: 0 }),
    Object.freeze({ windupMs: 200, recoveryMs: 800, damageMultiplier: 0.793, knockbackM: 0 })
  ]),
  comboResetMs: 1_500,
  hitTiming: "contact"
});

/**
 * Axe combos (2026-10-21, docs/plans/player-axe-keyposes/axe-combos.md): heavy plain chops for anyone holding an axe.
 * Contact 200 / 200 / 300 ms, next press 800 / 800 / 1100 ms, reset 1.5 s. Damage 0.57 / 0.57 / 0.91 over the 2.7 s
 * combo: 0.759 basic hits/s, -0.2 % against the default (the finisher weighted 1.15x its cadence).
 */
export const AXE_GENERIC_ATTACK_PROFILE: AttackProfile = Object.freeze({
  id: "axe:generic",
  label: "Axe combo",
  combo: Object.freeze([
    Object.freeze({ windupMs: 200, recoveryMs: 600, damageMultiplier: 0.57, knockbackM: 0 }),
    Object.freeze({ windupMs: 200, recoveryMs: 600, damageMultiplier: 0.57, knockbackM: 0 }),
    Object.freeze({ windupMs: 300, recoveryMs: 800, damageMultiplier: 0.91, knockbackM: 0 })
  ]),
  comboResetMs: 1_500,
  hitTiming: "contact"
});

/**
 * The Warrior's axe combo (axe-combos.md B): two momentum sweeps, then a shoulder barge into a two-handed overhead.
 * Contact 233 / 133 / 367 ms, next press 800 / 600 / 1200 ms, reset 1.6 s. Damage 0.54 / 0.40 / 1.04 over the 2.6 s
 * combo: 0.762 basic hits/s, +0.1 % against the default (the finisher carries the weight).
 */
export const AXE_WARRIOR_ATTACK_PROFILE: AttackProfile = Object.freeze({
  id: "axe:warrior",
  label: "Warrior axe combo",
  combo: Object.freeze([
    Object.freeze({ windupMs: 233, recoveryMs: 567, damageMultiplier: 0.54, knockbackM: 0 }),
    Object.freeze({ windupMs: 133, recoveryMs: 467, damageMultiplier: 0.4, knockbackM: 0 }),
    Object.freeze({ windupMs: 367, recoveryMs: 833, damageMultiplier: 1.04, knockbackM: 0 })
  ]),
  comboResetMs: 1_600,
  hitTiming: "contact"
});

export const ATTACK_PROFILES: Readonly<Record<CombatStyleId, AttackProfile>> = Object.freeze({
  default: DEFAULT_ATTACK_PROFILE,
  "sword:generic": SWORD_GENERIC_ATTACK_PROFILE,
  "sword:ronin": SWORD_RONIN_ATTACK_PROFILE,
  "axe:generic": AXE_GENERIC_ATTACK_PROFILE,
  "axe:warrior": AXE_WARRIOR_ATTACK_PROFILE
});

/** Anyone holding this weapon family who has no class-specific style for it. */
const WEAPON_COMBAT_STYLES: Readonly<Partial<Record<WeaponCategory, CombatStyleId>>> = Object.freeze({
  sword: "sword:generic",
  axe: "axe:generic"
});

/**
 * Class (or specialization) id -> its own style per weapon family. "ronin" is not a class id at t1565 (it lives on the
 * class-rework branch); this entry activates once a player's class id is "ronin".
 */
const CLASS_COMBAT_STYLES: Readonly<Record<string, Readonly<Partial<Record<WeaponCategory, CombatStyleId>>>>> = Object.freeze({
  ronin: Object.freeze({ sword: "sword:ronin" }),
  // The Warrior's weapon is the axe (skill ranks +Axe Attack, the Axe Mastery trait).
  warrior: Object.freeze({ axe: "axe:warrior" })
});

/** The one resolver: the combat style of a class (specialization) id holding a weapon family. */
export function combatStyleFor(
  classId: string | null | undefined,
  weaponFamily: WeaponCategory | null | undefined
): CombatStyleId {
  if (!weaponFamily) return DEFAULT_ATTACK_PROFILE_ID;
  const classStyles = classId && Object.prototype.hasOwnProperty.call(CLASS_COMBAT_STYLES, classId)
    ? CLASS_COMBAT_STYLES[classId]
    : undefined;
  return classStyles?.[weaponFamily] ?? WEAPON_COMBAT_STYLES[weaponFamily] ?? DEFAULT_ATTACK_PROFILE_ID;
}

export function isCombatStyleId(value: unknown): value is CombatStyleId {
  return typeof value === "string" && (COMBAT_STYLE_IDS as readonly string[]).includes(value);
}

/** The profile of a combat style (an unknown or missing id is the default). */
export function attackProfileForStyle(style: string | null | undefined): AttackProfile {
  return isCombatStyleId(style) ? ATTACK_PROFILES[style] : DEFAULT_ATTACK_PROFILE;
}

/** Profile for a class (specialization) id holding a weapon family: `attackProfileForStyle(combatStyleFor(...))`. */
export function attackProfileFor(
  classId: string | null | undefined,
  weaponFamily: WeaponCategory | null | undefined
): AttackProfile {
  return ATTACK_PROFILES[combatStyleFor(classId, weaponFamily)];
}

/** The step a combo index plays (indices past the end wrap; a defensive clamp, never expected). */
export function attackProfileStep(profile: AttackProfile, comboIndex: number): AttackSwingStep {
  const length = profile.combo.length;
  return profile.combo[((Math.trunc(comboIndex) % length) + length) % length]!;
}

/** Press-to-next-press time of a chained step, in ms. */
export function attackStepCycleMs(step: AttackSwingStep): number {
  return step.windupMs + step.recoveryMs;
}

/** The step's recovery gate in server ticks (nearest tick, at least one). Server and client both use this. */
export function attackStepCycleTicks(step: AttackSwingStep): number {
  return Math.max(1, Math.round(attackStepCycleMs(step) / ATTACK_PROFILE_TICK_LENGTH_MS));
}

/**
 * Ticks the server waits after resolving a press before the step's damage lands: 0 for "press" hit timing, else the
 * windup rounded to the tick (the hit resolves at contact).
 */
export function attackStepServerHitDelayTicks(profile: AttackProfile, step: AttackSwingStep): number {
  if (profile.hitTiming === "press") return 0;
  return Math.max(0, Math.round(step.windupMs / ATTACK_PROFILE_TICK_LENGTH_MS));
}

/** The combo step a press at `nowMs` plays: the next step within the reset window, else step 0. */
export function attackComboNextIndex(
  profile: AttackProfile,
  lastCombo: number | null,
  lastSwingAtMs: number,
  nowMs: number
): number {
  return lastCombo !== null && lastSwingAtMs > 0 && nowMs - lastSwingAtMs <= profile.comboResetMs
    ? (lastCombo + 1) % profile.combo.length
    : 0;
}

/** The last step of a combo of two or more is its finisher (bigger arc, heavier cue). */
export function isAttackFinisherStep(profile: AttackProfile, comboIndex: number): boolean {
  return profile.combo.length > 1 && comboIndex === profile.combo.length - 1;
}

/** Full combo time when every press lands the moment recovery ends (ms, tick-rounded as the server counts it). */
export function attackProfileComboCycleMs(profile: AttackProfile): number {
  return profile.combo.reduce((total, step) => total + attackStepCycleTicks(step) * ATTACK_PROFILE_TICK_LENGTH_MS, 0);
}

/** Basic-attack damage multiples per second over a full chained combo (the DPS figure to keep equal). */
export function attackProfileDamagePerSecond(profile: AttackProfile): number {
  const damage = profile.combo.reduce((total, step) => total + step.damageMultiplier, 0);
  return (damage * 1_000) / attackProfileComboCycleMs(profile);
}

/**
 * Per-step damage multipliers that give `targetDamagePerSecond` over the chained combo. Each step's share is its
 * `weight` (default: its tick-rounded cadence, so a slower swing hits proportionally harder); pass weights to make
 * a finisher heavier than its time alone would. Round the results for data entry; the DPS test allows for that.
 */
export function equalDpsDamageMultipliers(
  steps: ReadonlyArray<Pick<AttackSwingStep, "windupMs" | "recoveryMs"> & { weight?: number }>,
  targetDamagePerSecond: number = attackProfileDamagePerSecond(DEFAULT_ATTACK_PROFILE)
): number[] {
  const cycles = steps.map((step) => attackStepCycleTicks({ ...step, damageMultiplier: 0, knockbackM: 0 }) * ATTACK_PROFILE_TICK_LENGTH_MS);
  const weights = steps.map((step, index) => step.weight ?? cycles[index]!);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const totalCycleS = cycles.reduce((total, cycle) => total + cycle, 0) / 1_000;
  return weights.map((weight) => (weight * targetDamagePerSecond * totalCycleS) / totalWeight);
}

/** Data errors in a profile (empty = valid). The test suite runs this over every entry. */
export function attackProfileProblems(profile: AttackProfile): string[] {
  const problems: string[] = [];
  const length = profile.combo.length;
  if (length < 1 || length > ATTACK_COMBO_MAX_LENGTH) problems.push(`combo length ${length} outside 1..${ATTACK_COMBO_MAX_LENGTH}`);
  profile.combo.forEach((step, index) => {
    const at = `step ${index}`;
    if (!(Number.isFinite(step.windupMs) && step.windupMs >= 0)) problems.push(`${at}: windupMs must be >= 0`);
    if (!(Number.isFinite(step.recoveryMs) && step.recoveryMs >= 0)) problems.push(`${at}: recoveryMs must be >= 0`);
    if (!(Number.isFinite(step.damageMultiplier) && step.damageMultiplier > 0)) problems.push(`${at}: damageMultiplier must be > 0`);
    if (!(Number.isFinite(step.knockbackM) && step.knockbackM >= 0)) problems.push(`${at}: knockbackM must be >= 0`);
    // One windup in flight per player: the hit lands before the next press is accepted.
    if (attackStepServerHitDelayTicks(profile, step) >= attackStepCycleTicks(step)) problems.push(`${at}: contact must come before the next press`);
    // Any step must be able to chain into the next one.
    if (attackStepCycleMs(step) >= profile.comboResetMs) problems.push(`${at}: cadence must be shorter than comboResetMs`);
  });
  return problems;
}

/**
 * SWING combat event `abilityId` for a combo step: "swing_<index>", plus "@<style>" for any style but the default, so
 * other clients time the swing and spot the finisher with the profile the server used. The default sends exactly
 * today's "swing_0" / "swing_1" / "swing_2".
 */
export function swingEventAbilityId(comboIndex: number, profile: AttackProfile = DEFAULT_ATTACK_PROFILE): string {
  return profile.id === DEFAULT_ATTACK_PROFILE_ID ? `swing_${comboIndex}` : `swing_${comboIndex}@${profile.id}`;
}

/** Reads a swing event id back: the combo index and the profile (the default when untagged or unknown). Null for anything else. */
export function parseSwingEventAbilityId(abilityId: string): { comboIndex: number; profile: AttackProfile } | null {
  const match = /^swing_(\d)(?:@(.+))?$/.exec(abilityId);
  if (!match) return null;
  return { comboIndex: Number(match[1]), profile: attackProfileForStyle(match[2] ?? null) };
}
