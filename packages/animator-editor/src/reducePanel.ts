/*
 * Atlas Animator editor: original implementation.
 *
 * The "Clean up keys" panel: tolerance per channel, scope (selected bones or the whole clip), a live preview count, and Apply
 * (one undo step through the editor's commit). The reduction itself is keyReduce.ts.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { DEFAULT_TOLERANCES, REDUCE_CHANNELS, reduceKeys, TOLERANCE_UNITS, type ReduceChannel, type ReduceOptions, type ReduceResult, type Tolerances } from "./keyReduce.js";

export type ReduceScope = "selected" | "clip";

export interface ReducePanelHost {
  box: HTMLElement;
  clip: () => ClipData;
  /** Names of the selected bones. */
  selection: () => readonly string[];
  /** Replaces the clip as one undo step. */
  commit: (next: ClipData, message: string) => void;
}

export interface ReducePanel {
  /** Re-reads the clip and selection and redraws the preview. */
  render: () => void;
  setScope: (scope: ReduceScope) => void;
  setTolerance: (channel: ReduceChannel, value: number) => void;
  /** The current options' result without applying it. */
  preview: () => ReduceResult;
  apply: () => ReduceResult;
  state: () => { scope: ReduceScope; tolerances: Tolerances; preview: { removed: number; keysBefore: number; keysAfter: number; perChannel: Record<ReduceChannel, number> } };
}

const LABELS: Record<ReduceChannel, string> = { rotate: "Rotate", translate: "Move", scale: "Scale", shear: "Shear", ik: "IK mix" };

export function createReducePanel(host: ReducePanelHost): ReducePanel {
  let scope: ReduceScope = "selected";
  const tolerances: Tolerances = { ...DEFAULT_TOLERANCES };
  const inputs = new Map<ReduceChannel, HTMLInputElement>();
  let scopeSelect: HTMLSelectElement;
  let readout: HTMLElement;
  let applyButton: HTMLButtonElement;

  const options = (): ReduceOptions => (scope === "selected" ? { tolerances, bones: [...host.selection()] } : { tolerances });
  const preview = () => reduceKeys(host.clip(), options());

  function render(): void {
    if (!readout) build();
    scopeSelect.value = scope;
    for (const [channel, input] of inputs) if (document.activeElement !== input) input.value = String(tolerances[channel]);
    const r = preview();
    const parts = REDUCE_CHANNELS.filter((c) => r.perChannel[c]).map((c) => `${LABELS[c].toLowerCase()} ${r.perChannel[c]}`);
    readout.textContent = r.keysBefore
      ? `Would remove ${r.removed} of ${r.keysBefore} keys${parts.length ? ` (${parts.join(", ")})` : ""}`
      : scope === "selected"
        ? "No keys on the selected bones."
        : "No keys in this clip.";
    applyButton.disabled = r.removed === 0;
    applyButton.textContent = r.removed ? `Remove ${r.removed} keys` : "Nothing to remove";
  }

  function apply(): ReduceResult {
    const r = preview();
    if (r.removed) host.commit(r.clip, `Cleaned up keys: removed ${r.removed} of ${r.keysBefore}`);
    return r;
  }

  function build(): void {
    const { box } = host;
    box.replaceChildren();
    const h2 = document.createElement("h2");
    h2.textContent = "Clean up keys";
    box.append(h2);
    const scopeRow = document.createElement("div");
    scopeRow.className = "row";
    scopeRow.style.marginTop = "0";
    const scopeLabel = document.createElement("span");
    scopeLabel.className = "label";
    scopeLabel.textContent = "Scope";
    scopeSelect = document.createElement("select");
    scopeSelect.id = "reducescope";
    scopeSelect.title = "Which keys are looked at. IK keys are only reduced in the whole clip. Events, attachment swaps and draw order are never touched.";
    for (const [value, text] of [["selected", "Selected bones"], ["clip", "Whole clip"]] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      scopeSelect.append(o);
    }
    scopeSelect.addEventListener("change", () => {
      scope = scopeSelect.value as ReduceScope;
      render();
    });
    scopeRow.append(scopeLabel, scopeSelect);
    box.append(scopeRow);
    const grid = document.createElement("div");
    grid.className = "row";
    for (const channel of REDUCE_CHANNELS) {
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = `${LABELS[channel]} (${TOLERANCE_UNITS[channel]})`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = channel === "scale" || channel === "ik" ? "0.005" : "0.1";
      input.style.width = "60px";
      input.id = `reduce-${channel}`;
      input.title = `Largest ${LABELS[channel].toLowerCase()} difference (${TOLERANCE_UNITS[channel]}) a removed key may leave at any frame`;
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= 0) {
          tolerances[channel] = v;
          render();
        }
      });
      inputs.set(channel, input);
      grid.append(label, input);
    }
    box.append(grid);
    readout = document.createElement("div");
    readout.className = "note";
    readout.id = "reducereadout";
    applyButton = document.createElement("button");
    applyButton.id = "reduceapply";
    applyButton.title = "Remove the redundant keys (one undo step). The first and last key of each track stay.";
    applyButton.addEventListener("click", () => {
      apply();
    });
    const row = document.createElement("div");
    row.className = "row";
    row.append(applyButton);
    box.append(readout, row);
  }

  return {
    render,
    setScope: (next) => {
      scope = next;
      render();
    },
    setTolerance: (channel, value) => {
      tolerances[channel] = Math.max(0, value);
      render();
    },
    preview,
    apply,
    state: () => {
      const r = preview();
      return { scope, tolerances: { ...tolerances }, preview: { removed: r.removed, keysBefore: r.keysBefore, keysAfter: r.keysAfter, perChannel: r.perChannel } };
    }
  };
}
