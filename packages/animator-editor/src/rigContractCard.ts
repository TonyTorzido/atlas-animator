/*
 * Atlas Animator editor: the "Rig contract" card of the Rig inspector (Batch 10, PL-05): what the rig lacks so swag fits it,
 * and Create missing (one undoable Setup batch).
 */
import { section } from "./inspector.js";
import { contractStatus, planCreateMissing, CONTRACT_SLOTS, type ContractStatus } from "./rigContract.js";
import type { RigUi } from "./setupRigUi.js";
import type { JsonObject } from "./setupModel.js";

const list = (names: readonly string[], max = 6): string => (names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`);

/** The one-line summary the card header shows. */
export function contractMeta(st: ContractStatus): string {
  return st.missing ? `${st.missing} missing` : "0 missing";
}

/** The Rig contract section. `rerender` redraws the inspector after a toggle. */
export function contractSection(ui: RigUi, raw: JsonObject, rerender?: () => void): HTMLElement {
  const st = contractStatus(raw);
  const row = (id: string, label: string, text: string, tone: "ok" | "bad" | "" = ""): HTMLElement => {
    const r = ui.el("div", { className: "insp-row insp-plain", id });
    r.append(ui.el("span", { className: "label insp-lab", textContent: label }), ui.el("span", { className: `insp-val${tone ? ` ${tone}` : ""}`, textContent: text, title: text }));
    return r;
  };
  const core = CONTRACT_SLOTS.filter((s) => !s.onDemand).length;
  const body: HTMLElement[] = [
    row("rc-bones", "Bones", st.missingBones.length ? `missing ${list(st.missingBones)}` : "all there", st.missingBones.length ? "bad" : "ok"),
    row("rc-slots", "Slots", st.missingSlots.length ? `missing ${list(st.missingSlots)}` : `all ${core} there`, st.missingSlots.length ? "bad" : "ok"),
    row("rc-points", "Grip and tip", st.points.map((p) => `${p.name}: ${p.state === "point" ? "point" : p.state === "bone" ? "bone origin" : "missing"}`).join(", "), st.missingPoints.length ? "bad" : "ok")
  ];
  if (st.onDemandSlots.length) body.push(row("rc-demand", "On first use", `${st.onDemandSlots.length} slot${st.onDemandSlots.length === 1 ? "" : "s"} an item adds when it needs them: ${list(st.onDemandSlots, 4)}`));
  const create = ui.el("button", { textContent: "Create missing", className: "btn", type: "button", id: "rc-create", disabled: st.missing === 0, title: st.missing ? `Create missing: add the ${st.missing} bone${st.missing === 1 ? "" : "s"}, slots and points above in one step (Undo takes them all back)` : "Nothing is missing: this rig is wearable" });
  create.addEventListener("click", () => void ui.run("Create the missing rig contract parts", (r) => planCreateMissing(r)));
  const all = ui.el("button", { textContent: "Add all item slots", className: "btn", type: "button", id: "rc-create-all", disabled: st.missing === 0 && st.onDemandSlots.length === 0, title: "Add all item slots: also add the slots boots, gloves, chain, cape, helmet and mask pieces use, instead of waiting for the first item (Undo takes them back)" });
  all.addEventListener("click", () => void ui.run("Add all rig contract slots", (r) => planCreateMissing(r, { onDemand: true })));
  body.push(ui.el("div", { className: "insp-line" }, create, all));
  body.push(ui.el("div", { className: "insp-note", textContent: "The slot, bone and point names swag items bind to. Kit names today; each maps onto a part-named v2 slot (chest_torso, chest_sleeve_*, pants_leg_*, boot_*, glove_*)." }));
  return section({ id: "rig.contract", title: "Rig contract", meta: contractMeta(st), tip: "the slots, bones and weapon points swag items need on this rig", open: st.missing > 0, body }, rerender);
}
