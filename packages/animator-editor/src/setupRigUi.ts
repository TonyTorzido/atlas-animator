/*
 * Atlas Animator editor: Rig panel sections for hidden-features batch 3 (DOM).
 *
 * The "+ Constraint" row, constraint run-order buttons and the Revert row (the bone, slot and constraint pages themselves are in
 * inspector.ts). setupMode.ts owns the state and the commit path; this file only builds the controls and plans each click.
 */
import { constraintSequence, planAddOneBoneIk, planAddPhysics, planAddTransformConstraint, planConstraintMove, type AnyConstraintKind, type RigPlan } from "./setupRigPlans.js";
import { planAddPathConstraint } from "./pathModel.js";
import { planAddTwoBoneIk } from "./setupConstraints.js";
import type { Command, JsonObject } from "./setupModel.js";
import { listOf } from "./setupModel.js";

type Node_ = Node | string;
export interface RigUi {
  run(label: string, make: (raw: JsonObject) => RigPlan | { commands: Command[]; bone?: string | null }): Promise<boolean>;
  status(text: string, kind?: "" | "bad" | "ok"): void;
  el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown>, ...children: Node_[]): HTMLElementTagNameMap[K];
  field(label: string, ...nodes: Node_[]): Node[];
  num(value: number, step: string, onChange: (v: number) => void, width?: number): HTMLInputElement;
  select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement;
  ask(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean; id?: string }): Promise<boolean>;
}

const hex6 = (rgba: string) => `#${rgba.slice(0, 6)}`;

/**
 * What a number field shows: px and degrees (step 0.5 and up) to 1 decimal, scales and mixes (finer steps) to 2, trailing zeros trimmed
 * ("91.5", "-3.9", "1"). Display only: typing a longer value is still applied at full precision.
 */
export function fieldText(value: number, step: string | number): string {
  if (!Number.isFinite(value)) return "0";
  const decimals = Number(step) >= 0.5 ? 1 : 2;
  return String(Number(value.toFixed(decimals)));
}

// ---------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------

/** "+ Constraint": 1-bone IK, 2-bone IK and transform constraint on the selected bone. */
export function addConstraintRow(ui: RigUi, raw: JsonObject, sel: string | null, onMade?: (kind: "ik" | "transform" | "path" | "physics") => void): HTMLElement {
  const row = ui.el("div", { className: "insp-line", id: "setup-addcon" });
  const mk = (id: string, text: string, tip: string, action: string, go: () => Promise<boolean> | void, kind: "ik" | "transform" | "path" | "physics"): HTMLButtonElement => {
    const b = ui.el("button", { textContent: text, title: sel ? tip : `${tip.split(":")[0]}: select a bone first`, type: "button", disabled: !sel });
    b.id = id;
    b.dataset.action = action;
    b.setAttribute("aria-label", tip.split(":")[0]!);
    b.addEventListener("click", () => void Promise.resolve(go()).then((ok) => ok && onMade?.(kind)));
    return b;
  };
  const lower = sel ? (listOf(raw["bones"]).find((b) => b["name"] === sel)?.["parent"] ?? null) : null;
  row.append(
    mk("setup-addik1", "1-bone IK", `Add 1-bone IK: ${sel ?? "the selected bone"} turns toward a new helper target bone placed at its tip; the mix starts at 0 so clips keep their pose`, "add-ik-1", () => sel ? ui.run(`Add 1-bone IK on ${sel}`, (r) => planAddOneBoneIk(r, sel)) : undefined, "ik"),
    mk("setup-addik", "2-bone IK", `Add 2-bone IK: ${sel ?? "the selected bone"} is the lower bone (forearm, shin) and its parent the upper bone; a helper target bone is added at its tip and the mix starts at 0`, "add-ik-2", () => sel ? ui.run(`Add 2-bone IK on ${sel}`, (r) => ({ commands: planAddTwoBoneIk(r, sel).commands, bone: sel })) : undefined, "ik"),
    mk("setup-addtc", "Transform", `Add transform constraint: ${sel ?? "the selected bone"} copies ${lower ?? "its target"}'s transform; every mix starts at 0, raise one to let the target drive it`, "add-transform", () => sel ? ui.run(`Add transform constraint on ${sel}`, (r) => planAddTransformConstraint(r, sel)) : undefined, "transform"),
    mk("setup-addpath", "Path", `Add path constraint: ${sel ?? "the selected bone"} follows the first path in the rig (add one from a slot page with + Path); position, spacing, rotate mode and mixes open on its page`, "add-path", () => sel ? ui.run(`Add path constraint on ${sel}`, (r) => planAddPathConstraint(r, { bones: [sel] })) : undefined, "path"),
    mk("setup-addphys", "Physics", `Add physics: ${sel ?? "the selected bone"} swings about its origin on a spring (hair, cape, tail, pouch); the fields open on its page`, "add-physics", () => sel ? ui.run(`Add physics on ${sel}`, (r) => planAddPhysics(r, sel)) : undefined, "physics")
  );
  return row;
}

/** Run-order position and Up / Down buttons for one constraint card. */
export function constraintOrderRow(ui: RigUi, raw: JsonObject, kind: AnyConstraintKind, name: string): HTMLElement {
  const seq = constraintSequence(raw);
  const at = seq.findIndex((c) => c.kind === kind && c.name === name);
  const mk = (text: string, tip: string, dir: "up" | "down", disabled: boolean): HTMLButtonElement => {
    const b = ui.el("button", { textContent: text, title: tip, type: "button", disabled });
    b.dataset.move = dir;
    b.dataset.con = name;
    b.setAttribute("aria-label", `${tip}`);
    b.addEventListener("click", () => void ui.run(`Constraint order: ${name}`, (r) => planConstraintMove(r, kind, name, dir)));
    return b;
  };
  return ui.el(
    "span",
    { className: "conorder" },
    ui.el("span", { className: "label", textContent: `runs ${at + 1} of ${seq.length}`, title: "Constraints run in this order each frame" }),
    mk("Up", `Run ${name} earlier (before the constraint above it)`, "up", at <= 0),
    mk("Down", `Run ${name} later (after the constraint below it)`, "down", at < 0 || at >= seq.length - 1)
  );
}

// ---------------------------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------------------------

export function revertButton(ui: RigUi, unsaved: number, go: () => void): HTMLButtonElement {
  const b = ui.el("button", {
    textContent: "Revert rig to saved",
    type: "button",
    disabled: unsaved === 0,
    title: unsaved ? `Throw away the ${unsaved} unsaved Setup edit${unsaved === 1 ? "" : "s"} and go back to the rig file as saved (Redo brings them back; older file versions are under Versions...)` : "Nothing to revert: the rig matches its saved file (earlier file versions are under Versions...)"
  });
  b.id = "setup-revert";
  b.dataset.action = "revert-rig";
  b.addEventListener("click", go);
  return b;
}
