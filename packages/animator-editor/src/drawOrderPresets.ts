/*
 * Atlas Animator editor: original implementation.
 *
 * Draw-order presets (pure): the four named states the rig brief allows a clip to key (section 1.5), so a clip keys a state,
 * not raw offsets:
 *
 * - arm_r_front    the right (far) arm group is drawn in front of the torso and its clothes (it crosses the chest);
 * - arm_l_behind   the left (near) arm group goes behind the body (a backswing);
 * - weapon_behind  the weapon group goes behind the body (sheathed, or hidden by it);
 * - cape_over_arms the cape group is drawn over both arms (a big overhead swing).
 *
 * A preset is written as groups of slots and anchors, not slot numbers, so it resolves against any rig whose slot names
 * match (the stock player rig today, the split-limb kit rig later): slots a rig lacks are ignored, a preset whose group or
 * anchors are all missing is "not applicable" on that rig. The result is the clip's draw-order offsets (places from the
 * setup order, `drawOrder.ts`), written so that the moved group is the only thing that gets an offset.
 */
import { applyDrawOrderOffsets } from "@atlas-animator/core/core";
import type { DrawOffset } from "./slotModel.js";

export type DrawPresetId = "arm_r_front" | "arm_l_behind" | "weapon_behind" | "cape_over_arms";

/** Slot groups by role. A slot name that is not in the rig is skipped. */
export const SLOT_GROUPS = {
  arm_r: ["upper_arm_r", "tank_armhole_r", "forearm_r", "hand_r", "arm_r_upper", "arm_r_lower", "fore_up_r", "shoulder_r"],
  arm_l: ["upper_arm", "tank_armhole", "forearm", "hand", "arm_l_upper", "arm_l_lower", "fore_up_l", "hand_l", "shoulder_l"],
  weapon: ["weapon", "weapon_tip", "weapon_grip", "weapon_back"],
  cape: ["cape", "cape_front", "cape_back"],
  body: ["hips", "torso", "waist", "chest", "chain", "tank", "shirt", "pants", "shorts"]
} as const satisfies Record<string, readonly string[]>;

interface Move {
  group: readonly string[];
  place: "before" | "after";
  /** The group lands immediately before the earliest (or after the latest) of these slots that the rig has. */
  anchors: readonly string[];
}

export interface DrawPreset {
  id: DrawPresetId;
  label: string;
  hint: string;
  moves: readonly Move[];
}

const BODY = SLOT_GROUPS.body;
export const DRAW_PRESETS: readonly DrawPreset[] = [
  { id: "arm_r_front", label: "Arm R front", hint: "The far arm crosses the chest: drawn in front of the torso and its clothes", moves: [{ group: SLOT_GROUPS.arm_r, place: "after", anchors: BODY }] },
  { id: "arm_l_behind", label: "Arm L behind", hint: "The near arm goes behind the body on a backswing", moves: [{ group: SLOT_GROUPS.arm_l, place: "before", anchors: BODY }] },
  { id: "weapon_behind", label: "Weapon behind", hint: "The weapon is sheathed or hidden by the body: drawn behind the torso", moves: [{ group: SLOT_GROUPS.weapon, place: "before", anchors: BODY }] },
  {
    id: "cape_over_arms",
    label: "Cape over arms",
    hint: "The cape is drawn over both arms (big overhead swing); needs a cape slot",
    moves: [{ group: SLOT_GROUPS.cape, place: "after", anchors: [...SLOT_GROUPS.arm_r, ...SLOT_GROUPS.arm_l, ...SLOT_GROUPS.weapon] }]
  }
];

export interface ResolvedPreset {
  id: DrawPresetId;
  applicable: boolean;
  /** Why it is not applicable (a missing group or anchors). */
  reason: string | null;
  /** The draw-order key's offsets (places from the setup order); empty when the setup order already is the state. */
  offsets: DrawOffset[];
  /** The resulting slot order, back to front. */
  order: string[];
}

/** Resolves a preset against a rig's setup slot order. */
export function resolveDrawPreset(setup: readonly string[], id: DrawPresetId): ResolvedPreset {
  const preset = DRAW_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown draw order preset '${id}'`);
  let order = [...setup];
  for (const move of preset.moves) {
    const group = order.filter((s) => (move.group as readonly string[]).includes(s));
    if (!group.length) return { id, applicable: false, reason: `the rig has none of ${move.group.slice(0, 3).join(", ")}...`, offsets: [], order: [...setup] };
    const rest = order.filter((s) => !group.includes(s));
    const anchors = rest.map((s, i) => ({ s, i })).filter((a) => (move.anchors as readonly string[]).includes(a.s));
    if (!anchors.length) return { id, applicable: false, reason: `the rig has none of ${move.anchors.slice(0, 3).join(", ")}...`, offsets: [], order: [...setup] };
    const at = move.place === "before" ? Math.min(...anchors.map((a) => a.i)) : Math.max(...anchors.map((a) => a.i)) + 1;
    // Already on the right side of every anchor: leave the group where it is (the order stays as authored).
    const indexes = group.map((s) => order.indexOf(s));
    const anchorIndexes = anchors.map((a) => order.indexOf(a.s));
    const done = move.place === "before" ? Math.max(...indexes) < Math.min(...anchorIndexes) : Math.min(...indexes) > Math.max(...anchorIndexes);
    if (done) continue;
    order = [...rest.slice(0, at), ...group, ...rest.slice(at)];
  }
  const offsets = order.flatMap((slot, index) => {
    const offset = index - setup.indexOf(slot);
    return offset === 0 ? [] : [{ slot, offset }];
  });
  // Only the moved group keeps an offset when the others can stay unmoved: drop offsets that the setup-order fill reproduces.
  const moved = new Set(preset.moves.flatMap((m) => m.group));
  const lean = leanOffsets(setup, order, offsets, moved);
  return { id, applicable: true, reason: null, offsets: lean, order };
}

/** Removes offsets of slots that were only displaced by the group and are put right by the runtime's fill of unmoved slots. */
function leanOffsets(setup: readonly string[], order: readonly string[], offsets: DrawOffset[], keep: ReadonlySet<string>): DrawOffset[] {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
  let kept = [...offsets];
  for (const o of offsets.filter((x) => !keep.has(x.slot))) {
    const trial = kept.filter((k) => k !== o);
    if (same(runtimeOrder(setup, trial), order)) kept = trial;
  }
  return kept;
}

/** The slot order the runtime builds from `offsets` (drawOrder.ts applyDrawOrderOffsets). */
export function runtimeOrder(setup: readonly string[], offsets: readonly DrawOffset[]): string[] {
  const n = setup.length;
  const per = new Array<number>(n).fill(0);
  for (const o of offsets) {
    const i = setup.indexOf(o.slot);
    if (i >= 0) per[i] = o.offset;
  }
  const out = new Array<number>(n).fill(0);
  applyDrawOrderOffsets(
    Array.from({ length: n }, (_, i) => i),
    per,
    out,
    new Array<number>(n).fill(0)
  );
  return out.map((i) => setup[i]!);
}

/** Which preset (or "setup" / "custom") the offsets in force at a time amount to on this rig. */
export function drawOrderState(setup: readonly string[], offsets: readonly DrawOffset[]): DrawPresetId | "setup" | "custom" {
  const order = runtimeOrder(setup, offsets);
  if (order.every((s, i) => s === setup[i])) return "setup";
  for (const p of DRAW_PRESETS) {
    const r = resolveDrawPreset(setup, p.id);
    if (r.applicable && r.order.every((s, i) => s === order[i])) return p.id;
  }
  return "custom";
}
