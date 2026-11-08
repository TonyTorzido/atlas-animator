/*
 * Atlas Animator editor: the Tree (outliner). One hierarchy of bones, their slots and the slots' attachments (plus a constraints group),
 * with an eye per row, colour-coded icons, IK / constraint badges, search, selection history, kind filters, the bone properties
 * (inherit, length, select lock, name, icon size, colour) and the New / Parent / Split / Delete buttons.
 *
 * Rig-structure edits (New, Parent, Split, Delete, length, inherit, colour) run through the host's Setup command path, so they are
 * undoable and saved with the rig. Everything else here (eye, select lock, show name, icon size, collapse, filters) is editor-only
 * state kept in localStorage per rig and never written into the rig document.
 */
import { getHost, type EditorHost, type NodeSel } from "./host.js";
import { iconHtml } from "./icons.js";
import {
  arrowTarget,
  buildRows,
  clampIconSize,
  emptyState,
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  ids,
  planChildBone,
  planSplitBone,
  SelectionHistory,
  stepRow,
  toggledFor,
  type Filters,
  type OutlinerState,
  type Row
} from "./outlinerModel.js";
import { planDeleteBone, planRename, planReparent } from "./setupModel.js";
import { chainBonePlans, deleteSummary, planAddOneBoneIk, planAddPhysics, planConstraintMove, planDeleteSlot, planDrawOrder, planDrawOrderTo, planNewSlot, planRenameSlot, type DrawMove } from "./setupRigPlans.js";
import { planAddPathConstraint } from "./pathModel.js";
import { planRemoveConstraint } from "./setupConstraints.js";
import { planRemoveAttachment } from "./setupAttach.js";
import { openContextMenu, type MenuItem } from "./contextMenu.js";
import { confirmDialog } from "./dialog.js";
import { IMAGE_DRAG_TYPE, dropImageOnTarget, openImagesDock } from "./imagesDock.js";

const STORE = "atlasEditor.outliner.v1";

let host: EditorHost | null = null;
let state: OutlinerState = emptyState();
let stateRig = "";
let focusId: string | null = null;
let search = "";
let pickFrom: string | null = null;
let splitPercent = 50;
let rows: Row[] = [];
let lastSig = "";
/** The slot the inspector shows (or the slot of the attachment it shows): its Draw order row is highlighted. */
let activeSlot: string | null = null;
let paintBone: PaintBone | null = null;
const paintListeners = new Set<(e: PaintBone) => void>();
const history = new SelectionHistory();

// ---------------------------------------------------------------------------------------------
// Active paint bone (the Weights tool listens)
// ---------------------------------------------------------------------------------------------

/** A weight bone picked in the Tree: the mesh it weights and the bone to paint with. */
export interface PaintBone {
  skin: string;
  slot: string;
  attachment: string;
  bone: string;
}

/** Subscribes to "active paint bone" picks (a weight row clicked in Weights mode). Returns the unsubscribe function. */
export function onActivePaintBone(fn: (e: PaintBone) => void): () => void {
  paintListeners.add(fn);
  return () => void paintListeners.delete(fn);
}

/** The last picked paint bone, or null before a pick / after the rig changes. */
export function activePaintBone(): PaintBone | null {
  return paintBone;
}

/** True while Setup mode's Weights sub-tool is current. */
function weightsMode(): boolean {
  const a = (window as unknown as { atlasEditor?: { setupState?: () => { active?: boolean; tool?: string } } }).atlasEditor;
  const st = a?.setupState?.();
  return !!host?.setupActive && st?.tool === "weights";
}

function pickPaintBone(row: Row): void {
  if (!row.skin || !row.slot || !row.attachment) return;
  paintBone = { skin: row.skin, slot: row.slot, attachment: row.attachment, bone: row.name };
  for (const fn of [...paintListeners]) fn(paintBone);
  document.dispatchEvent(new CustomEvent("atlas:paint-bone", { detail: paintBone }));
}

// ---------------------------------------------------------------------------------------------
// Editor-only state
// ---------------------------------------------------------------------------------------------

function readStore(): Record<string, Partial<OutlinerState>> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, Partial<OutlinerState>>;
  } catch {
    return {};
  }
}

function ensureState(): void {
  const id = (host ?? getHost())?.rig?.outfit.id ?? "";
  if (id === stateRig) return;
  stateRig = id;
  const saved = readStore()[id] ?? {};
  state = { ...emptyState(), ...saved, filters: { ...emptyState().filters, ...(saved.filters ?? {}) } };
}

function save(): void {
  try {
    const all = readStore();
    all[stateRig] = state;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* private window or blocked storage: the Tree still works for this session */
  }
}

const toSet = (list: readonly string[]) => new Set(list);

/** Bones the eye hid (the canvas draws and picks none of them). */
export function outlinerHiddenBones(): Set<string> {
  ensureState();
  const out = new Set<string>();
  for (const id of state.hidden) if (id.startsWith("b:")) out.add(id.slice(2));
  return out;
}

/** True when the bone's Select lock is on: the canvas cannot pick it. */
export function outlinerLocked(name: string): boolean {
  ensureState();
  return state.locked.includes(name);
}

export function outlinerIconScale(name: string): number {
  ensureState();
  return state.iconSize[name] ?? 1;
}

/** Which workspaces swap the BONES list for the Tree: Pro, Rig and Setup mode; Animate only with "Show full tree". */
export function outlinerActive(workspace: string, setupOn: boolean): boolean {
  ensureState();
  if (setupOn || workspace === "pro" || workspace === "rig") return true;
  return workspace === "animate" && state.fullInAnimate;
}

export function setOutlinerFull(on: boolean): void {
  ensureState();
  state.fullInAnimate = on;
  save();
  host?.refreshBones();
}

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

const ICONS = {
  bone: iconHtml("bone"),
  slot: iconHtml("slot"),
  attachment: iconHtml("attachment"),
  clipMask: iconHtml("clipMask"),
  pathCurve: iconHtml("pathCurve"),
  hitBox: iconHtml("hitBox"),
  constraint: iconHtml("constraint"),
  skin: iconHtml("skin"),
  draw: iconHtml("draw"),
  event: iconHtml("events"),
  plus: iconHtml("plus"),
  reparent: iconHtml("reparent"),
  split: iconHtml("split"),
  trash: iconHtml("trash"),
  eye: iconHtml("eye"),
  eyeOff: iconHtml("eyeOff"),
  lock: iconHtml("lock"),
  unlock: iconHtml("unlock"),
  pencil: iconHtml("pencil"),
  chevron: iconHtml("chevR"),
  back: iconHtml("chevL"),
  forward: iconHtml("chevR"),
  expand: iconHtml("expand"),
  collapse: iconHtml("collapse"),
  search: iconHtml("search")
};

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string; title?: string; html?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, html, ...rest } = props as Record<string, unknown>;
  Object.assign(node, rest);
  if (cls) node.className = String(cls);
  if (html) node.innerHTML = String(html);
  node.append(...kids);
  return node;
}

interface Parts {
  root: HTMLElement;
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  search: HTMLInputElement;
  filters: Record<keyof Filters, HTMLButtonElement>;
  simple: HTMLButtonElement;
  showAll: HTMLButtonElement;
  tree: HTMLElement;
  /** Constraints / Skins / Draw order: pinned under the nested tree so their counts stay in view. */
  sections: HTMLElement;
  buttons: Record<"new" | "rename" | "parent" | "split" | "delete", HTMLButtonElement>;
  splitAt: HTMLInputElement;
  hint: HTMLElement;
}
let parts: Parts | null = null;

const FILTER_META: { key: keyof Filters; icon: string; title: string; text?: string }[] = [
  { key: "bones", icon: ICONS.bone, title: "Show bones" },
  { key: "slots", icon: ICONS.slot, title: "Show slots" },
  { key: "attachments", icon: ICONS.attachment, title: "Show attachments" },
  { key: "constraints", icon: ICONS.constraint, title: "Show constraints (IK, transform, path, physics)" },
  { key: "meshes", icon: "", text: "Mesh", title: "Meshes only: show just the mesh attachments, with their slots and bones" }
];

function build(): Parts {
  if (parts) return parts;
  const root = document.getElementById("outliner");
  if (!root) throw new Error("no #outliner element");
  const back = h("button", { type: "button", class: "ol-ic", html: ICONS.back, title: "Back: the previous selection" });
  const forward = h("button", { type: "button", class: "ol-ic", html: ICONS.forward, title: "Forward: the next selection" });
  const box = h("input", { type: "search", class: "ol-search", placeholder: "Search the tree", title: "Search bones, slots, attachments and constraints by name" });
  const filters = {} as Record<keyof Filters, HTMLButtonElement>;
  const chips = h("div", { class: "ol-filters", role: "group" });
  for (const f of FILTER_META) {
    const b = h("button", { type: "button", class: `ol-ic ol-filter${f.text ? " ol-filter-text" : ""}`, html: f.icon, title: f.title });
    if (f.text) b.textContent = f.text;
    b.dataset.filter = f.key;
    filters[f.key] = b;
    chips.append(b);
  }
  const expand = h("button", { type: "button", class: "ol-ic", html: ICONS.expand, title: "Expand every row" });
  const collapse = h("button", { type: "button", class: "ol-ic", html: ICONS.collapse, title: "Collapse every row" });
  const simple = h("button", { type: "button", class: "ol-simple", textContent: "Simple list", title: "Back to the simplified Animate bone list" });
  const top = h("div", { class: "ol-top" }, h("div", { class: "ol-toprow" }, back, forward, h("span", { class: "spacer" }), chips, expand, collapse), h("span", { class: "ol-searchwrap", html: ICONS.search }, box));
  const showAll = h("button", { type: "button", class: "ol-simple ol-showall", textContent: "Show all", title: "Show every row you hid with an eye (editor only; the rig is untouched)" });
  showAll.id = "ol-showall";
  const tree = h("div", { class: "ol-tree", tabIndex: 0, role: "tree", title: "" });
  tree.setAttribute("aria-label", "Tree");
  const sections = h("div", { class: "ol-sections", role: "tree", tabIndex: 0 });
  sections.setAttribute("aria-label", "Constraints, skins and draw order");
  const mk = (key: string, label: string, title: string, icon: string) => {
    const b = h("button", { type: "button", class: "ol-btn", title });
    b.innerHTML = `${icon}<span class="ol-btn-label">${label}</span>`;
    b.dataset.act = key;
    b.setAttribute("aria-label", title.split(":")[0]!);
    return b;
  };
  const buttons = {
    new: mk("new", "New", "New bone: a child of the selected bone, continuing its direction (Setup or Rig)", ICONS.plus),
    rename: mk("rename", "Rename", "Rename the selected bone or slot (F2, or double-click its row)", ICONS.pencil),
    parent: mk("parent", "Reparent", "Reparent: click a bone in the tree or on the canvas to make it the new parent of the selected bone (Setup or Rig)", ICONS.reparent),
    split: mk("split", "Split", "Split the selected bone in two at the percent in the Split at field; its children move to the second half (Setup or Rig)", ICONS.split),
    delete: mk("delete", "Delete", "Delete the selected bones after a confirm; their children and slots move to the parent (Setup or Rig)", ICONS.trash)
  };
  const splitAt = h("input", { type: "number", class: "ol-split", min: "5", max: "95", step: "5", value: String(splitPercent), title: "Split point: percent along the bone, from its start" });
  const hint = h("div", { class: "ol-hint" });
  const acts = h("div", { class: "ol-acts" }, buttons.new, buttons.rename, buttons.parent, buttons.split, buttons.delete, h("label", { class: "ol-splitgroup", title: "Split point: percent along the bone, from its start" }, h("span", { class: "label", textContent: "Split at" }), splitAt, h("span", { class: "ol-pct", textContent: "%" })));
  const selAll = h("button", { type: "button", class: "ol-simple ol-ico", html: `${iconHtml("selAll")}<span>Select all</span>`, title: "Select every bone (Ctrl+Shift+A)" });
  selAll.id = "ol-selall";
  selAll.setAttribute("aria-label", "Select all bones");
  selAll.addEventListener("click", () => getHost()?.selectAllBones());
  const selBranch = h("button", { type: "button", class: "ol-simple ol-ico", html: `${iconHtml("branch")}<span>Branch</span>`, title: "Select the active bone and every bone below it" });
  selBranch.id = "ol-selbranch";
  selBranch.setAttribute("aria-label", "Select branch");
  selBranch.addEventListener("click", () => getHost()?.selectBranch());
  root.replaceChildren(h("div", { class: "ol-head" }, h("span", { class: "label", textContent: "Tree" }), selAll, selBranch, showAll, h("span", { class: "spacer" }), simple), top, tree, sections, acts, hint);
  parts = { root, back, forward, search: box, filters, simple, showAll, tree, sections, buttons, splitAt, hint };
  wire(parts, expand, collapse);
  return parts;
}

function wire(p: Parts, expand: HTMLElement, collapse: HTMLElement): void {
  p.search.addEventListener("input", () => {
    search = p.search.value;
    lastSig = "";
    render();
  });
  p.search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      p.tree.focus();
    } else if (e.key === "Escape") {
      p.search.value = "";
      search = "";
      lastSig = "";
      render();
      p.tree.focus();
    }
  });
  for (const f of FILTER_META)
    p.filters[f.key].addEventListener("click", () => {
      state.filters[f.key] = !state.filters[f.key];
      save();
      render(true);
    });
  expand.addEventListener("click", () => setOpenAll(true));
  collapse.addEventListener("click", () => setOpenAll(false));
  p.simple.addEventListener("click", () => setOutlinerFull(false));
  p.back.addEventListener("click", () => stepHistory(-1));
  p.forward.addEventListener("click", () => stepHistory(1));
  p.splitAt.addEventListener("change", () => {
    const v = Number(p.splitAt.value);
    splitPercent = Number.isFinite(v) ? Math.min(95, Math.max(5, v)) : 50;
    p.splitAt.value = String(splitPercent);
  });
  p.splitAt.addEventListener("keydown", (e) => e.stopPropagation());
  for (const box of [p.tree, p.sections]) {
    box.addEventListener("click", onTreeClick);
    box.addEventListener("dblclick", onTreeDblClick);
    box.addEventListener("contextmenu", onTreeContext);
    box.addEventListener("dragstart", onDragStart);
    box.addEventListener("dragover", onDragOver);
    box.addEventListener("dragleave", (e) => (e.target as HTMLElement).closest(".ol-row")?.classList.remove("drop-into", "drop-above", "drop-below"));
    box.addEventListener("drop", onDrop);
    box.addEventListener("dragend", clearDrop);
    box.addEventListener("keydown", onTreeKey);
  }
  p.showAll.addEventListener("click", () => {
    state.hidden = [];
    save();
    render(true);
    host?.repose();
  });
  p.buttons.new.addEventListener("click", newBone);
  p.buttons.rename.addEventListener("click", () => renameActive());
  p.buttons.parent.addEventListener("click", toggleParent);
  p.buttons.split.addEventListener("click", splitBone);
  p.buttons.delete.addEventListener("click", deleteBone);
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

const boneOfRow = (r: Row | undefined): string | null => (!r ? null : r.kind === "bone" || r.kind === "weight" ? r.name : r.kind === "constraint" ? (r.target ?? null) : (r.bone ?? null));

function activeRowId(): string | null {
  const sel = host?.boneSelection();
  return focusId ?? (sel?.active ? ids.bone(sel.active) : null);
}

const conOfRow = (r: Row): NodeSel => {
  const [ckind, ...rest] = r.id.slice(2).split("/");
  return { kind: "constraint", ckind: ckind as "ik" | "transform" | "path" | "physics", name: rest.join("/") };
};

/** The row the inspector's node points at (Setup / Rig); null in Animate, where the focused row or the bone decides. */
function nodeRowId(n: NodeSel, bone: string | null): string | null {
  switch (n.kind) {
    case "slot":
      return ids.slot(n.slot);
    case "attachment":
      return ids.attachment(n.slot, n.name);
    case "constraint":
      return `c:${n.ckind}/${n.name}`;
    case "skin":
      return `k:${n.name}`;
    case "event":
      return n.name ? `e:${n.name}` : "g:events";
    default:
      return bone ? ids.bone(bone) : null;
  }
}

function activate(row: Row, e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, swap: boolean): void {
  if (!host) return;
  if (pickFrom && row.kind === "bone") return void doParent(row.name);
  history.push(row.id);
  if (row.kind === "group") {
    if (row.id === "g:events") host.selectNode({ kind: "event" });
    return toggleOpen(row.id);
  }
  focusId = row.id;
  if (row.kind === "bone") {
    if (e.shiftKey) {
      const bones = rows.filter((r) => r.kind === "bone");
      const from = bones.findIndex((r) => r.name === host!.boneSelection().active);
      const to = bones.findIndex((r) => r.id === row.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        host.selectBones(bones.slice(a, b + 1).map((r) => r.name), "replace", row.name);
        return host.selectNode({ kind: "bone" });
      }
    }
    if (e.ctrlKey || e.metaKey) return host.selectBones([row.name], "toggle");
    host.selectBone(row.name);
    return host.selectNode({ kind: "bone" });
  }
  if (row.kind === "weight") {
    // The bone and its slot become the selection; in Weights mode the bone also becomes the paint bone.
    host.selectSlot(row.slot ?? null);
    host.selectBone(row.name);
    if (weightsMode()) pickPaintBone(row);
    render(true);
    return;
  }
  if (row.kind === "skin") {
    host.selectNode({ kind: "skin", name: row.name });
    return render(true);
  }
  if (row.kind === "event") {
    host.selectNode({ kind: "event", name: row.name });
    return render(true);
  }
  if (row.kind === "constraint") {
    if (row.target) host.selectBone(row.target);
    host.selectNode(conOfRow(row));
    render(true);
    return;
  }
  const slot = row.kind === "slot" || row.kind === "draw" ? row.name : (row.slot ?? null);
  host.selectSlot(slot);
  if (row.bone) host.selectBone(row.bone);
  if (slot) host.selectNode(row.kind === "attachment" ? { kind: "attachment", slot, name: row.name } : { kind: "slot", slot });
  if (row.kind === "attachment" && swap && row.slot) {
    const res = host.swapAttachment(row.slot, row.name);
    if (res === "blocked") host.status("Auto key is off: turn it on to key this attachment swap, or use Setup to change the slot's own image", "bad");
    else host.status(res === "keyed" ? `Keyed ${row.slot}: ${row.name}` : `Default image of ${row.slot}: ${row.name}`, "ok");
  }
  render(true);
}

function stepHistory(dir: 1 | -1): void {
  const id = history.move(dir, (i) => rows.some((r) => r.id === i) || i.startsWith("b:"));
  if (!id || !host) return;
  const row = rows.find((r) => r.id === id);
  if (row) activate(row, {}, false);
  else if (id.startsWith("b:")) host.selectBone(id.slice(2));
}

function onTreeClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const rowEl = target.closest<HTMLElement>(".ol-row");
  if (!rowEl) return;
  const id = rowEl.dataset.id!;
  if (target.closest(".ol-eye")) return toggleHidden(id);
  if (target.closest(".ol-lock")) return toggleLock(id);
  if (target.closest(".ol-arrow")) return toggleOpen(id);
  const row = rows.find((r) => r.id === id);
  parts?.tree.focus({ preventScroll: true });
  if (row) activate(row, e, true);
}

// Double-click renames (bones and slots); dragging a bone row onto another re-parents it keeping its world position.
function onTreeDblClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest(".ol-eye") || target.closest(".ol-lock") || target.closest(".ol-arrow") || target.closest(".ol-rename")) return;
  const rowEl = target.closest<HTMLElement>(".ol-row");
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  if (!rowEl || !row) return;
  startRename(rowEl, row);
}

/** Opens the inline name field on a bone or slot row (double-click, F2, the Rename button, the row menu). */
function startRename(rowEl: HTMLElement, row: Row): void {
  if (row.kind !== "bone" && row.kind !== "slot" && row.kind !== "draw") return;
  if (!host || !structureOk()) return;
  const label = rowEl.querySelector<HTMLElement>(".ol-label");
  if (!label) return;
  const input = h("input", { type: "text", class: "ol-rename", value: row.name, title: "Type the new name; Enter renames, Esc cancels" });
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const to = input.value.trim();
    if (!commit || !to || to === row.name) return void render(true);
    const run = row.kind === "bone" ? host!.setupRun(`Rename ${row.name}`, (raw) => planRename(raw, row.name, to)) : host!.setupRun(`Rename slot ${row.name}`, (raw) => planRenameSlot(raw, row.name, to));
    void run.then(() => render(true));
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  label.replaceChildren(input);
  input.focus();
  input.select();
}

let dragBone: string | null = null;
let dragSlot: string | null = null;

function descendantsOf(name: string): Set<string> {
  const out = new Set<string>([name]);
  for (const b of host?.doc?.bones ?? []) if (b.parent && out.has(b.parent) ) out.add(b.name);
  return out;
}

function clearDrop(): void {
  dragBone = null;
  dragSlot = null;
  parts?.root.querySelectorAll(".drop-into, .drop-above, .drop-below").forEach((n) => n.classList.remove("drop-into", "drop-above", "drop-below"));
}

/** Draw order rows run front to back top to bottom: the top half of a row drops in front of (after) that slot. */
const dropSide = (e: DragEvent, rowEl: HTMLElement): "before" | "after" => (e.clientY < rowEl.getBoundingClientRect().top + rowEl.getBoundingClientRect().height / 2 ? "after" : "before");

function onDragStart(e: DragEvent): void {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row");
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  if (!row || (row.kind !== "bone" && row.kind !== "draw") || !host?.setupActive) return void e.preventDefault();
  if (row.kind === "bone") dragBone = row.name;
  else dragSlot = row.name;
  e.dataTransfer?.setData("text/plain", row.name);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

/** A thumbnail from the Images dock is being dragged: slot, draw order and bone rows take it. */
const imageDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes(IMAGE_DRAG_TYPE);
const imageTarget = (rowEl: HTMLElement | null): { slot?: string; bone?: string } | null => {
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  if (!row) return null;
  if (row.kind === "slot" || row.kind === "draw") return { slot: row.name };
  if (row.kind === "bone") return { bone: row.name };
  return null;
};

function onDragOver(e: DragEvent): void {
  if (imageDrag(e)) {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row");
    parts?.root.querySelectorAll(".drop-into").forEach((n) => n !== rowEl && n.classList.remove("drop-into"));
    if (!rowEl || !imageTarget(rowEl) || !host?.setupActive) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    rowEl.classList.add("drop-into");
    return;
  }
  if (dragSlot) {
    const target = (e.target as HTMLElement).closest<HTMLElement>(".ol-row.k-draw");
    parts?.root.querySelectorAll(".drop-above, .drop-below").forEach((n) => n !== target && n.classList.remove("drop-above", "drop-below"));
    if (!target || target.dataset.id === `d:${dragSlot}`) return;
    e.preventDefault();
    const after = dropSide(e, target) === "after";
    target.classList.toggle("drop-above", after);
    target.classList.toggle("drop-below", !after);
    return;
  }
  if (!dragBone) return;
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row.k-bone");
  parts?.root.querySelectorAll(".drop-into").forEach((n) => n !== rowEl && n.classList.remove("drop-into"));
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  if (!rowEl || !row || descendantsOf(dragBone).has(row.name)) return;
  e.preventDefault();
  rowEl.classList.add("drop-into");
}

function onDrop(e: DragEvent): void {
  if (imageDrag(e)) {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row");
    const target = imageTarget(rowEl);
    const path = e.dataTransfer?.getData(IMAGE_DRAG_TYPE) ?? "";
    clearDrop();
    if (!target || !path) return;
    e.preventDefault();
    dropImageOnTarget(path, target);
    return;
  }
  if (dragSlot) {
    const moved = dragSlot;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".ol-row.k-draw");
    const side = target ? dropSide(e, target) : "after";
    const to = rows.find((r) => r.id === target?.dataset.id)?.name;
    clearDrop();
    if (!to || to === moved || !host) return;
    e.preventDefault();
    void host.setupRun(`Draw order: ${moved}`, (raw) => planDrawOrderTo(raw, moved, to, side)).then(() => render(true));
    return;
  }
  const from = dragBone ?? e.dataTransfer?.getData("text/plain") ?? null;
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row.k-bone");
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  clearDrop();
  if (!from || !row || !host || row.name === from) return;
  e.preventDefault();
  void host.setupRun(`Parent ${from} to ${row.name}`, (raw) => planReparent(raw, from, row.name, true)).then(() => render(true));
}

function onTreeKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "F2") {
    e.preventDefault();
    e.stopPropagation();
    return renameActive();
  }
  const id = activeRowId();
  const go = (to: string | null | undefined, swap = false) => {
    const row = rows.find((r) => r.id === to);
    if (row) activate(row, { shiftKey: e.shiftKey }, swap);
  };
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      e.preventDefault();
      e.stopPropagation();
      return go(stepRow(rows, id, e.key === "ArrowDown" ? 1 : -1));
    case "Home":
    case "End":
      e.preventDefault();
      e.stopPropagation();
      return go(e.key === "Home" ? rows[0]?.id : rows[rows.length - 1]?.id);
    case "ArrowLeft":
    case "ArrowRight": {
      e.preventDefault();
      e.stopPropagation();
      if (!id) return;
      const step = arrowTarget(rows, id, e.key === "ArrowLeft" ? "left" : "right");
      if (step.toggle) return toggleOpen(id);
      if (step.to && step.to !== id) go(step.to);
      return;
    }
    case "Enter":
    case " ":
      e.preventDefault();
      e.stopPropagation();
      return go(id, true);
    case "Escape":
      if (pickFrom) {
        pickFrom = null;
        render(true);
      }
      return;
    default:
  }
}

function toggleOpen(id: string): void {
  const at = state.toggled.indexOf(id);
  if (at >= 0) state.toggled.splice(at, 1);
  else state.toggled.push(id);
  save();
  render(true);
}

function setOpenAll(open: boolean): void {
  if (!host?.doc) return;
  state.toggled = toggledFor(host.doc, open);
  save();
  render(true);
}

/** Hides a bone from the canvas (the Tree's eye shows it again). */
export function hideOutlinerBone(name: string): void {
  ensureState();
  const id = `b:${name}`;
  if (state.hidden.includes(id)) return;
  state.hidden.push(id);
  save();
  render(true);
  host?.repose();
}

/** Flips a bone's select lock (the canvas cannot pick it); editor-only, kept per rig like the eye. */
function toggleLock(id: string): void {
  if (!id.startsWith("b:")) return;
  const name = id.slice(2);
  const at = state.locked.indexOf(name);
  if (at >= 0) state.locked.splice(at, 1);
  else state.locked.push(name);
  save();
  render(true);
  host?.repose();
}

function toggleHidden(id: string): void {
  const at = state.hidden.indexOf(id);
  if (at >= 0) state.hidden.splice(at, 1);
  else state.hidden.push(id);
  save();
  render(true);
  host?.repose();
}

// ---------------------------------------------------------------------------------------------
// Rig-structure edits (Setup command path)
// ---------------------------------------------------------------------------------------------

function structureOk(): boolean {
  if (host?.setupActive) return true;
  host?.status("Switch to Setup mode (the Rig workspace, or Mode: Setup in Pro) to change the rig's structure", "bad");
  return false;
}

function activeBone(): string | null {
  return host?.boneSelection().active ?? null;
}

function newBone(): void {
  if (!host || !structureOk()) return;
  const sk = host.skeleton;
  const name = activeBone() ?? host.doc?.bones.find((b) => !b.parent)?.name;
  const parent = name ? sk?.findBone(name) : undefined;
  if (!name || !parent) return void host.status("Select a bone to add a child to", "bad");
  void host.setupRun(`New bone under ${name}`, (raw) => planChildBone(raw, name, { x: parent.world.x, y: parent.world.y, angleDeg: parent.worldRotationX, length: parent.data.length }, Math.max(24, Math.min(80, parent.data.length * 0.6))));
}

function toggleParent(): void {
  if (!host || !structureOk()) return;
  const name = activeBone();
  if (!name) return void host.status("Select the bone to re-parent first", "bad");
  pickFrom = pickFrom ? null : name;
  host.status(pickFrom ? `Click the new parent of ${name} in the tree or on the canvas (Esc cancels)` : "Parent cancelled");
  render(true);
}

function doParent(target: string): void {
  const from = pickFrom;
  pickFrom = null;
  if (!host || !from) return;
  if (target === from) {
    host.status("Parent cancelled");
    return render(true);
  }
  void host.setupRun(`Parent ${from} to ${target}`, (raw) => planReparent(raw, from, target, true)).then(() => render(true));
}

function splitBone(): void {
  const name = activeBone();
  if (!host || !structureOk()) return;
  if (!name) return void host.status("Select the bone to split first", "bad");
  void host.setupRun(`Split ${name}`, (raw) => planSplitBone(raw, name, splitPercent / 100));
}

function deleteBone(): void {
  if (!host || !structureOk()) return;
  const names = host.boneSelection().names;
  if (!names.length) return void host.status("Select the bone to delete first", "bad");
  void deleteBonesConfirmed(names);
}

/**
 * Delete / Backspace in Setup, the Tree's Delete button and the row menu all come here: one confirm that names what goes and what moves
 * up, Enter accepts, and the whole selection is removed as one undo step.
 */
export async function deleteBonesConfirmed(names: readonly string[]): Promise<boolean> {
  const h2 = host ?? getHost();
  if (!h2 || !names.length) return false;
  const raw = h2.setupRaw();
  if (!raw) return false;
  const sum = deleteSummary(raw, names);
  const what = names.length === 1 ? `bone "${names[0]}"` : `${names.length} bones`;
  const moved = [sum.children ? `${sum.children} child bone${sum.children === 1 ? "" : "s"}` : "", sum.slots ? `${sum.slots} slot${sum.slots === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const message = `Delete ${what}?${moved ? ` Its ${moved} move up to the parent bone.` : ""}${sum.constraints ? ` ${sum.constraints} constraint${sum.constraints === 1 ? "" : "s"} that use${sum.constraints === 1 ? "s" : ""} it and its clip keys go with it.` : " Its clip keys go with it."} Undo brings it all back.`;
  const yes = await confirmDialog({ title: names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} bones?`, message, confirmLabel: "Delete", danger: true, id: "delete-bones-dialog" });
  if (!yes) return false;
  return h2.setupRun(names.length === 1 ? `Delete ${names[0]}` : `Delete ${names.length} bones`, (r) => chainBonePlans(r, names, (cur, n) => planDeleteBone(cur, n)));
}

/** F2 and the Rename button: the active row (or the active bone's row) gets its name field. */
function renameActive(): void {
  if (!host || !structureOk()) return;
  const id = activeRowId();
  const row = rows.find((r) => r.id === id) ?? rows.find((r) => r.kind === "bone" && r.name === activeBone());
  const el = row ? parts?.root.querySelector<HTMLElement>(`.ol-row[data-id="${CSS.escape(row.id)}"]`) : null;
  if (!row || !el) return void host.status("Select a bone or slot to rename first", "bad");
  if (row.kind !== "bone" && row.kind !== "slot" && row.kind !== "draw") return void host.status("Only bones and slots can be renamed here", "bad");
  startRename(el, row);
}

// ---------------------------------------------------------------------------------------------
// Context menu (one per row kind). Every entry is also a visible control: the footer (New, Rename, Reparent, Split, Delete), the head
// (Select all, Branch), the eye and lock columns, and the inspector pages (New slot, Add IK, Delete slot, Draw order, Remove image ...).
// ---------------------------------------------------------------------------------------------

const rigSkin = (): string => Object.keys(host?.rig?.doc.skins ?? {})[0] ?? "body";
const setupTool = (id: string): void => void (window as unknown as { atlasEditor?: { setupTool?: (t: string) => void } }).atlasEditor?.setupTool?.(id);

function boneChildren(name: string): string[] {
  const out: string[] = [];
  const bones = host?.doc?.bones ?? [];
  const seen = new Set<string>([name]);
  for (const b of bones) if (b.parent && seen.has(b.parent)) { seen.add(b.name); out.push(b.name); }
  return out;
}

function menuFor(row: Row): MenuItem[] {
  const setupOn = !!host?.setupActive;
  const why = setupOn ? undefined : "Switch to Setup mode (the Rig workspace, or Mode: Setup in Pro) to change the rig's structure";
  const edit = (label: string, hint: string | undefined, run: () => void, extra: Partial<MenuItem> = {}): MenuItem => ({ label, ...(hint ? { hint } : {}), run, disabled: !setupOn, ...(why ? { why } : {}), ...extra });
  switch (row.kind) {
    case "bone": {
      const kids = boneChildren(row.name);
      const names = host!.boneSelection().names;
      const targets = names.includes(row.name) ? names : [row.name];
      return [
        edit("Rename", "F2", () => renameActive()),
        edit(targets.length > 1 ? `Delete ${targets.length} bones...` : "Delete...", "Del", () => void deleteBonesConfirmed(targets)),
        { label: "Select children", run: () => void host!.selectBones(kids, "replace", kids[0]), disabled: !kids.length, ...(kids.length ? {} : { why: "This bone has no children" }), separator: true },
        edit("New child bone", undefined, () => newBone(), { separator: true }),
        edit("New slot", undefined, () => void host!.setupRun(`New slot on ${row.name}`, (raw) => planNewSlot(raw, row.name))),
        edit("Add IK", undefined, () => void host!.setupRun(`Add 1-bone IK on ${row.name}`, (raw) => planAddOneBoneIk(raw, row.name))),
        edit("Add path constraint", undefined, () => void host!.setupRun(`Add path constraint on ${row.name}`, (raw) => planAddPathConstraint(raw, { bones: [row.name] }))),
        edit("Add physics", undefined, () => void host!.setupRun(`Add physics on ${row.name}`, (raw) => planAddPhysics(raw, row.name))),
        { label: state.locked.includes(row.name) ? "Unlock (canvas can pick it)" : "Lock (canvas cannot pick it)", run: () => toggleLock(row.id), separator: true },
        { label: state.hidden.includes(row.id) ? "Show in the editor" : "Hide in the editor", run: () => toggleHidden(row.id) }
      ];
    }
    case "slot":
    case "draw": {
      const moves: [DrawMove, string][] = [["front", "Bring to front"], ["up", "Move toward the front"], ["down", "Move toward the back"], ["back", "Send to back"]];
      return [
        edit("Rename", "F2", () => renameActive()),
        edit("Delete slot...", undefined, () => void confirmDialog({ title: `Delete slot ${row.name}?`, message: `Delete the slot "${row.name}" with its images and its clip keys? Undo brings it back.`, confirmLabel: "Delete slot", danger: true, id: "delete-slot-dialog" }).then((ok) => ok && host!.setupRun(`Delete slot ${row.name}`, (raw) => planDeleteSlot(raw, row.name)))),
        edit("Attach image...", undefined, () => openImagesDock(), { separator: true }),
        ...moves.map(([how, text], i) => edit(text, undefined, () => void host!.setupRun(`${text}: ${row.name}`, (raw) => planDrawOrder(raw, row.name, how)), i === 0 ? { separator: true } : {})),
        { label: "Select its bone", run: () => row.bone && host!.selectBone(row.bone), disabled: !row.bone, separator: true }
      ];
    }
    case "attachment": {
      const slot = row.slot ?? "";
      return [
        edit("Make setup image", undefined, () => void host!.swapAttachment(slot, row.name)),
        edit("Remove image", undefined, () => void host!.setupRun(`Remove image ${row.name}`, (raw) => ({ commands: planRemoveAttachment(raw, { skin: rigSkin(), slot, name: row.name }) }))),
        ...(row.mesh ? [edit("Edit mesh", "M", () => setupTool("mesh"), { separator: true }), edit("Paint weights", "W", () => setupTool("weights"))] : [])
      ];
    }
    case "constraint": {
      const ck = conOfRow(row);
      return [
        edit("Run earlier", undefined, () => void host!.setupRun(`Constraint order: ${row.name}`, (raw) => planConstraintMove(raw, ck.kind === "constraint" ? ck.ckind : "ik", row.name, "up"))),
        edit("Run later", undefined, () => void host!.setupRun(`Constraint order: ${row.name}`, (raw) => planConstraintMove(raw, ck.kind === "constraint" ? ck.ckind : "ik", row.name, "down"))),
        edit("Remove constraint...", undefined, () => {
          if (ck.kind !== "constraint") return void host!.status("Open the constraint in the inspector to remove it", "bad");
          const kind = ck.ckind;
          void confirmDialog({ title: `Remove ${row.name}?`, message: `Remove the ${kind === "ik" ? "IK" : kind === "transform" ? "transform" : kind === "path" ? "path" : "physics"} constraint "${row.name}"? Undo brings it back.`, confirmLabel: "Remove constraint", danger: true, id: "remove-constraint-dialog" }).then((ok) => ok && host!.setupRun(`Remove ${row.name}`, (raw) => ({ commands: planRemoveConstraint(raw, kind, row.name) })));
        }, { separator: true })
      ];
    }
    case "group":
      return [{ label: row.open ? "Collapse" : "Expand", run: () => toggleOpen(row.id) }];
    default:
      return [{ label: "Open in the inspector", run: () => activate(row, {}, false) }];
  }
}

function onTreeContext(e: MouseEvent): void {
  const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".ol-row");
  const row = rows.find((r) => r.id === rowEl?.dataset.id);
  if (!rowEl || !row || !host) return;
  e.preventDefault();
  // A right-click on a row outside the current multi-selection selects it first; inside it, the selection stays for the multi actions.
  const inMulti = row.kind === "bone" && host.boneSelection().names.includes(row.name) && host.boneSelection().names.length > 1;
  if (!inMulti && row.kind !== "group") activate(row, {}, false);
  focusId = row.id;
  openContextMenu(e.clientX, e.clientY, menuFor(row), parts?.tree ?? null);
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

function rowEl(r: Row, sel: { active: string | null; names: string[] }, active: string | null): HTMLElement {
  const hidden = state.hidden.includes(r.id);
  const multi = r.kind === "bone" && sel.names.includes(r.name);
  const isActive = r.id === active || (r.kind === "draw" && r.name === activeSlot);
  const el = h("div", { class: `ol-row k-${r.kind}${isActive ? " sel" : multi ? " multi" : ""}${hidden ? " hid" : ""}${r.helper ? " helper" : ""}${r.kind === "bone" && state.locked.includes(r.name) ? " locked" : ""}${pickFrom && r.kind === "bone" ? " pickable" : ""}${pickFrom === r.name ? " from" : ""}` });
  el.dataset.id = r.id;
  el.setAttribute("role", "treeitem");
  el.setAttribute("aria-selected", String(isActive));
  el.style.setProperty("--d", String(r.depth));
  const canHide = r.kind === "bone" || r.kind === "slot" || r.kind === "attachment";
  const eye = h("span", { class: `ol-eye${canHide ? "" : " none"}`, html: canHide ? (hidden ? ICONS.eyeOff : ICONS.eye) : "", title: canHide ? (hidden ? "Hidden in the editor only: click to show it" : "Visible: click to hide it in the editor (never saved into the rig)") : "" });
  const arrow = h("span", { class: `ol-arrow${r.hasChildren ? (r.open ? " open" : "") : " leaf"}`, html: r.hasChildren ? ICONS.chevron : "", title: r.hasChildren ? (r.open ? "Collapse" : "Expand") : "" });
  const groupIcon = r.id === "g:skins" ? "skin" : r.id === "g:draw" ? "draw" : r.id === "g:events" ? "event" : "constraint";
  const icon = h("span", { class: "ol-icon", html: ICONS[r.kind === "group" ? groupIcon : r.kind === "weight" ? "bone" : r.kind === "draw" ? "slot" : r.kind === "attachment" && r.attKind === "clip" ? "clipMask" : r.kind === "attachment" && r.attKind === "hitbox" ? "hitBox" : r.kind === "attachment" && r.attKind === "path" ? "pathCurve" : r.kind] });
  if (r.kind === "bone") icon.style.color = `#${r.color}`;
  const label = h("span", { class: "ol-label", textContent: r.kind === "group" ? `${r.name} (${r.badges[0] ?? 0})` : r.name });
  if (r.kind === "attachment" && r.current) label.append(h("span", { class: "ol-cur", title: "The slot's setup attachment", textContent: "setup" }));
  const badges = h("span", { class: "ol-badges" });
  for (const b of r.kind === "group" ? [] : r.badges) badges.append(h("span", { class: `ol-badge b-${b.toLowerCase()}`, textContent: b, title: b === "IK" ? "Driven by or driving an IK constraint" : b === "TC" ? "In a transform constraint" : b === "PH" ? "Has a physics constraint" : b === "PA" ? "Driven by a path constraint" : "" }));
  if (r.kind === "attachment" && r.mesh) {
    badges.append(h("span", { class: "ol-badge b-mesh", textContent: "mesh", title: "A mesh attachment" }));
    if (r.weightBones !== undefined) badges.append(h("span", { class: "ol-badge b-w", textContent: `W${r.weightBones}`, title: `Weighted to ${r.weightBones} bone${r.weightBones === 1 ? "" : "s"}: expand to list them` }));
  }
  if (r.kind === "attachment" && r.attKind === "point") badges.append(h("span", { class: "ol-badge b-point", textContent: "point", title: "A point attachment: a named position and direction (weapon grip, tool tip, FX socket); nothing draws it" }));
  if (r.kind === "attachment" && r.attKind === "clip") badges.append(h("span", { class: "ol-badge b-clip", textContent: "clip", title: "A clip mask: cuts the slots drawn after it, up to its end slot, to its polygon" }));
  if (r.kind === "attachment" && r.attKind === "hitbox") badges.append(h("span", { class: "ol-badge b-hitbox", textContent: "hit box", title: "A hit box: a polygon the project can test a point against; never drawn" }));
  if (r.kind === "attachment" && r.attKind === "path") badges.append(h("span", { class: "ol-badge b-path", textContent: "path", title: "A path: a bezier curve a path constraint moves bones along" }));
  if (r.kind === "attachment" && r.attKind === "sequence") badges.append(h("span", { class: "ol-badge b-seq", textContent: "seq", title: "An image sequence: frame-by-frame art played by sequence keys" }));
  if (r.kind === "attachment" && r.attKind === "linked") badges.append(h("span", { class: "ol-badge b-linked", textContent: "linked", title: "A linked mesh: it shares another mesh's shape and weights" }));
  if ((r.kind === "attachment" || r.kind === "slot") && r.deformKeyed) badges.append(h("span", { class: "ol-dot", title: r.kind === "slot" ? "A mesh on this slot has deform keys in this clip" : "This mesh has deform keys in this clip" }));
  if (r.kind === "bone" && state.locked.includes(r.name)) badges.append(h("span", { class: "ol-badge b-lock", textContent: "lock", title: "Select lock is on: not pickable on the canvas" }));
  const canLock = r.kind === "bone";
  const locked = canLock && state.locked.includes(r.name);
  const lock = h("span", { class: `ol-lock${canLock ? "" : " none"}${locked ? " on" : ""}`, html: canLock ? (locked ? ICONS.lock : ICONS.unlock) : "", title: canLock ? (locked ? `Locked: ${r.name} cannot be picked on the canvas. Click to unlock it (editor only)` : `Unlocked. Click to lock ${r.name} so the canvas cannot pick it (editor only, never saved into the rig)`) : "" });
  lock.setAttribute("role", canLock ? "button" : "presentation");
  if (canLock) lock.setAttribute("aria-label", locked ? `Unlock ${r.name}` : `Lock ${r.name}`);
  el.append(eye, lock, h("span", { class: "ol-indent" }), arrow, icon, label, badges);
  if ((r.kind === "bone" || r.kind === "draw") && host?.setupActive) {
    el.draggable = true;
    el.dataset.drag = r.kind;
  }
  if (r.kind === "weight" && paintBone && paintBone.slot === r.slot && paintBone.attachment === r.attachment && paintBone.bone === r.name) el.classList.add("paint");
  if (r.kind === "draw") el.title = `${r.name} on ${r.bone ?? ""}: drag to change its draw order (front is on top); click to select the slot`;
  else if (r.kind === "skin") el.title = `Skin ${r.name}: click to see it in the inspector`;
  else if (r.kind === "event") el.title = `Event ${r.name}: click to edit its default payload, rename or remove it`;
  else if (r.kind === "group") el.title = `${r.name}: ${r.open ? "collapse" : "expand"} this section`;
  else el.title = r.kind === "weight" ? (weightsMode() ? `${r.name}: click to paint ${r.attachment} with this bone` : `${r.name} weights ${r.attachment}: click to select the bone (switch to the Weights tool to paint with it)`) : r.kind === "bone" ? `${r.name}${r.helper ? " (helper)" : ""}` : r.kind === "attachment" ? `${r.name}: click to make it ${r.slot}'s visible attachment` : r.name;
  return el;
}

/**
 * The editor-only bone settings (select lock, name on canvas, icon size) as inspector rows. They live in the Rig inspector's Appearance
 * section; the Tree no longer carries a properties pane of its own. Nothing here is written into the rig.
 */
export function outlinerBoneAppearance(names: string[], active: string): HTMLElement {
  if (!host) host = getHost();
  ensureState();
  const grid = h("div", { class: "kv" });
  const each = (fn: (n: string) => void) => {
    for (const n of names.includes(active) ? names : [active]) fn(n);
    save();
    render(true);
    host?.repose();
  };
  const selectable = h("input", { type: "checkbox", checked: !state.locked.includes(active), id: "setup-selectable", title: "Selectable: unchecked locks this bone so it cannot be picked on the canvas (editor only)" });
  selectable.dataset.field = "select";
  selectable.addEventListener("change", () => each((n) => (selectable.checked ? void (state.locked = state.locked.filter((x) => x !== n)) : void (state.locked.includes(n) || state.locked.push(n)))));
  const showName = h("input", { type: "checkbox", checked: state.names.includes(active), id: "setup-shownames", title: "Name: draw this bone's name on the canvas (editor only)" });
  showName.dataset.field = "name";
  showName.addEventListener("change", () => each((n) => (showName.checked ? void (state.names.includes(n) || state.names.push(n)) : void (state.names = state.names.filter((x) => x !== n)))));
  const size = h("input", { type: "range", min: String(ICON_SIZE_MIN), max: String(ICON_SIZE_MAX), step: "0.1", value: String(state.iconSize[active] ?? 1), id: "setup-iconsize", title: "Size of the bone's dot on the canvas (editor only)" });
  size.dataset.field = "iconSize";
  const sizeVal = h("span", { class: "ol-val", textContent: `${(state.iconSize[active] ?? 1).toFixed(1)}x` });
  size.addEventListener("input", () => {
    const v = clampIconSize(Number(size.value));
    for (const n of names.includes(active) ? names : [active]) {
      if (v === 1) delete state.iconSize[n];
      else state.iconSize[n] = v;
    }
    sizeVal.textContent = `${v.toFixed(1)}x`;
    host?.repose();
  });
  size.addEventListener("change", save);
  const field = (label: string, ...nodes: (Node | string)[]) => grid.append(h("span", { class: "label", textContent: label }), h("span", { class: "v" }, ...nodes));
  field("Canvas", h("label", { class: "ol-check" }, selectable, "Selectable"), h("label", { class: "ol-check" }, showName, "Show name"));
  field("Dot size", size, sizeVal);
  return grid;
}

function render(force = false): void {
  if (!host) host = getHost();
  if (!host) return;
  ensureState();
  const p = build();
  const doc = host.doc;
  const sel = host.boneSelection();
  if (pickFrom && sel.active && sel.active !== pickFrom && !force) {
    const t = sel.active;
    return doParent(t);
  }
  const setupNow = !!host.setupActive;
  const order = setupNow ? host.skeleton?.drawOrder.map((sl) => sl.data.name).reverse() : undefined;
  rows = doc ? buildRows(doc, { filters: state.filters, toggled: toSet(state.toggled), search, clip: setupNow ? null : host.clip, ...(order ? { drawOrder: order } : {}) }) : [];
  // The focused slot / attachment row only stays while its bone is the active bone.
  const focus = rows.find((r) => r.id === focusId);
  if (focusId && (!focus || (focus.kind !== "skin" && focus.kind !== "event" && focus.kind !== "draw" && boneOfRow(focus) !== sel.active))) focusId = null;
  const setupOn = !!host.setupActive;
  const node = host.inspectorNode();
  const active = setupOn ? nodeRowId(node, sel.active) : activeRowId();
  activeSlot = node.kind === "slot" ? node.slot : node.kind === "attachment" ? node.slot : null;
  const bone = doc?.bones.find((b) => b.name === sel.active);
  const sig = JSON.stringify([rows.map((r) => [r.id, r.open, r.hasChildren, r.color, r.current ?? 0, r.badges, r.weightBones ?? -1, r.deformKeyed ?? 0]), paintBone, sel, active, activeSlot, state, search, setupOn, pickFrom, splitPercent, bone ? [bone.inherit, bone.length, bone.color] : 0, history.canBack(), history.canForward(), document.body.classList.contains("ws-animate")]);
  if (sig === lastSig) return;
  lastSig = sig;
  const keepTop = p.tree.scrollTop;
  const firstGroup = rows.findIndex((r) => r.kind === "group");
  const nested = firstGroup < 0 ? rows : rows.slice(0, firstGroup);
  p.tree.replaceChildren(...nested.map((r) => rowEl(r, sel, active)));
  const secRows = firstGroup < 0 ? [] : rows.slice(firstGroup);
  // One block per section: a header that always shows, and its rows in a short list that scrolls inside the block.
  const blocks: HTMLElement[] = [];
  let rowsBox: HTMLElement | null = null;
  for (const r of secRows) {
    const e = rowEl(r, sel, active);
    if (r.kind === "group") {
      rowsBox = h("div", { class: "ol-sec-rows" });
      blocks.push(h("div", { class: "ol-sec" }, e, rowsBox));
    } else rowsBox?.append(e);
  }
  for (const b of blocks) if (!b.querySelector(".ol-sec-rows")?.childElementCount) b.querySelector(".ol-sec-rows")?.remove();
  p.sections.replaceChildren(...blocks);
  p.sections.hidden = firstGroup < 0;
  p.tree.scrollTop = keepTop;
  if (!nested.length) p.tree.append(h("div", { class: "ol-empty", textContent: search ? "Nothing matches." : "No rig is open." }));
  (p.tree.querySelector(".ol-row.sel") ?? p.sections.querySelector(".ol-row.sel"))?.scrollIntoView({ block: "nearest" });
  for (const f of FILTER_META) p.filters[f.key].classList.toggle("on", state.filters[f.key]);
  p.back.disabled = !history.canBack();
  p.forward.disabled = !history.canForward();
  p.simple.hidden = !document.body.classList.contains("ws-animate") || !!host.setupActive;
  p.showAll.disabled = !state.hidden.length;
  const lock = setupOn ? "" : "Switch to Setup mode (the Rig workspace, or Mode: Setup in Pro) to edit the rig's structure";
  for (const b of Object.values(p.buttons)) {
    b.disabled = !setupOn;
    b.classList.remove("on");
  }
  p.buttons.rename.title = lock || "Rename the selected bone or slot (F2, or double-click its row)";
  p.buttons.new.title = lock || "New bone: a child of the selected bone, continuing its direction";
  p.buttons.parent.classList.toggle("on", !!pickFrom);
  p.buttons.parent.querySelector(".ol-btn-label")!.textContent = pickFrom ? "Pick..." : "Reparent";
  p.splitAt.disabled = !setupOn;
  p.hint.textContent = pickFrom ? `Click the new parent of ${pickFrom} (Esc cancels)` : lock;
  p.hint.classList.toggle("on", !!pickFrom);
  syncNames();
}

/** Called from main.ts's renderBones while the Tree is the bone list. */
export function renderOutliner(): void {
  render();
}

// ---------------------------------------------------------------------------------------------
// Editor-only canvas effects: hidden art, bone names
// ---------------------------------------------------------------------------------------------

interface CharacterView {
  slot: { data: { name: string }; attachment: { name: string } | null };
  mesh: { visible: boolean };
  shown: unknown;
  contours?: { mesh: { visible: boolean } }[];
}
const PATCHED = Symbol("outlinerPatched");

/** Wraps the character's update so slots the eye hid stay un-drawn; the rig and the clip are untouched. */
function patchCharacter(): void {
  const ch = host?.character as unknown as (Record<symbol, boolean> & { update(): void; views?: CharacterView[] }) | null | undefined;
  if (!ch || ch[PATCHED]) return;
  ch[PATCHED] = true;
  const original = ch.update.bind(ch);
  ch.update = () => {
    original();
    if (!state.hidden.some((i) => i.startsWith("s:") || i.startsWith("a:"))) {
      if (!hadArtHidden) return;
      hadArtHidden = false;
    } else hadArtHidden = true;
    const hid = toSet(state.hidden);
    for (const v of ch.views ?? []) {
      const slot = v.slot.data.name;
      const off = hid.has(ids.slot(slot)) || (!!v.slot.attachment && hid.has(ids.attachment(slot, v.slot.attachment.name)));
      v.mesh.visible = off ? false : !!v.shown;
      if (off) for (const c of v.contours ?? []) c.mesh.visible = false;
    }
  };
}
let hadArtHidden = false;

let nameLayer: HTMLElement | null = null;
let nameTimer = 0;

function syncNames(): void {
  if (!host) return;
  if (state.names.length && !nameTimer) nameTimer = requestAnimationFrame(tickNames);
  if (!state.names.length && nameLayer) nameLayer.replaceChildren();
}

function tickNames(): void {
  nameTimer = 0;
  if (!host || !state.names.length) return;
  const view = document.getElementById("view");
  const sk = host.skeleton;
  if (view && sk) {
    if (!nameLayer) {
      nameLayer = h("div", { id: "ol-names" });
      view.append(nameLayer);
    }
    const on = document.body.classList.contains("ol-on");
    const vr = view.getBoundingClientRect();
    const cr = host.app.canvas.getBoundingClientRect();
    const z = host.zoom();
    const hidden = outlinerHiddenBones();
    const shown = on ? state.names.filter((n) => !hidden.has(n) && sk.findBone(n)) : [];
    while (nameLayer.children.length > shown.length) nameLayer.lastElementChild!.remove();
    while (nameLayer.children.length < shown.length) nameLayer.append(h("span", { class: "ol-name" }));
    shown.forEach((n, i) => {
      const b = sk.findBone(n)!;
      const mid = b.localToWorld(b.data.length / 2, 0, { x: 0, y: 0 });
      const el = nameLayer!.children[i] as HTMLElement;
      if (el.textContent !== n) el.textContent = n;
      el.style.transform = `translate(${Math.round(cr.left - vr.left + host!.world.x + mid.x * z)}px, ${Math.round(cr.top - vr.top + host!.world.y + mid.y * z)}px)`;
    });
  }
  nameTimer = requestAnimationFrame(tickNames);
}

/** Hooks the Tree into the editor once the host exists (main.ts calls this through whenHost). */
export function installOutliner(h2: EditorHost): void {
  host = h2;
  patchCharacter();
  h2.on("rig", () => {
    patchCharacter();
    lastSig = "";
    paintBone = null;
  });
  // The deform dot follows the clip; the weight rows' tooltips follow the Weights tool.
  h2.on("clip", () => render());
  h2.on("tool", () => render());
}
