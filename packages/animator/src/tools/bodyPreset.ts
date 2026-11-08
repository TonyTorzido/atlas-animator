/*
 * Atlas Animator: original implementation.
 *
 * Body presets. Everything a body template knows that library code must not: vertex
 * budgets, chain budgets, bend caps and review poses. Library code (validator, review poses, CLI)
 * reads these from a preset or from the document's own `budgets` block, never from template bone
 * names. The humanoid is the first implementation (humanoid.ts, HUMANOID_BODY); a mob declares its
 * budgets in its document (`doc.set budgets`) or passes them on the command line.
 *
 * Precedence, lowest first: the validator's generic defaults, the preset, the document's
 * `budgets`, explicit options (CLI flags).
 */
import type { RigBudgetsData } from "../core/format.js";
import type { ReviewPose } from "./review.js";

export interface ChainBudget {
  from: string;
  to: string;
  budget: number;
}

/**
 * A close-up review crop of the body: canvas coordinates belong to the preset, not
 * to the CLI. `frame` takes the document canvas and returns the crop in canvas pixels.
 */
export interface ReviewCrop {
  /** Output file stem (`<name>.png`). */
  readonly name: string;
  readonly frame: (canvas: { readonly width: number; readonly height: number }) => { x: number; y: number; width: number; height: number };
  readonly scale: number;
  readonly columns: number;
}

export interface BodyPreset {
  readonly name: string;
  /** Budgets in the document's `budgets` shape (vertex, bone and atlas budgets, chains, bend caps). */
  readonly budgets: RigBudgetsData;
  /**
   * Hand-authored review poses for this body (judged besides or instead of the rig-derived ones);
   * omitted = rig-derived poses only.
   */
  readonly reviewPoses?: readonly ReviewPose[];
  /** Close-up crops for review images (`animator rig --review`); omitted = whole-slot sheets only. */
  readonly reviewCrops?: readonly ReviewCrop[];
}

/** Merge budget blocks, later wins per field (`bend` merged per role). */
export function mergeBudgets(...blocks: readonly (RigBudgetsData | undefined)[]): RigBudgetsData {
  const out: RigBudgetsData = {};
  for (const block of blocks) {
    if (!block) continue;
    for (const [key, value] of Object.entries(block) as [keyof RigBudgetsData, unknown][]) {
      if (value === undefined) continue;
      if (key === "bend") out.bend = { ...out.bend, ...(value as RigBudgetsData["bend"]) };
      else (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
