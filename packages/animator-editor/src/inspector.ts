/*
 * Atlas Animator editor: the Rig inspector (REDESIGN.md, Batch 3).
 *
 * One node-scoped panel for the Rig tab: a header (type icon, name, kind chip, breadcrumb), collapsible sections for the node and a
 * pinned Delete. Pages: Bone, Slot, Attachment (image), Constraint, Skin. The Tree (outliner.ts) picks the node; setupMode.ts owns the
 * state and the command path and hands each page a `PageCtx`, so this file only builds controls and plans each click through the
 * existing plan functions (setupModel / setupRigPlans / setupConstraints / setupAttach). Section open / closed state is editor-only
 * (localStorage, per section id), never written into the rig.
 */
import { iconHtml, type IconName } from "./icons.js";
import type { NodeSel } from "./host.js";
import { outlinerBoneAppearance } from "./outliner.js";
import { inheritToggle } from "./outlinerModel.js";
import { linkCandidates, linkedDependants, linkSourceOf, type AttAddress } from "./meshLink.js";
import type { RelinkMode } from "./relinkModel.js";
import { ANGLE_MAX, ANGLE_MIN, correctiveSets, correctiveState, newSetName, planDeleteCorrectiveKey, roundAngle, syncCorrectiveState } from "./correctiveModel.js";
import { isVariantPath, type AtlasRegion } from "./setupAttach.js";
import { ikConstraints, PHYSICS_FIELDS, physicsConstraints, TRANSFORM_MIXES, TRANSFORM_OFFSETS, transformConstraints, type ConstraintKind } from "./setupConstraints.js";
import type { JsonObject } from "./setupModel.js";
import type { PolygonKind, SequenceFields } from "./polyAttach.js";
import { addablePathBones, PATH_MODE_LABEL, PATH_POSITION_MODES, PATH_ROTATE_MODES, PATH_SPACING_MODES, pathConstraints, pathPoints, pathSlots } from "./pathModel.js";
import { boneNames, listOf } from "./setupModel.js";
import { addConstraintRow, constraintOrderRow, type RigUi } from "./setupRigUi.js";
import { drawOrderOf, isAnchored, planBoneFields, planBoneLimits, planDeleteSlot, planDrawOrder, planNewSlot, planRenameSlot, planSlotLook, type DrawMove } from "./setupRigPlans.js";

type Kid = Node | string;
const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const objOfRaw = (v: unknown): JsonObject => (isObj(v) ? v : {});

// ---------------------------------------------------------------------------------------------
// Sections (collapsible, remembered)
// ---------------------------------------------------------------------------------------------

const STORE = "atlasEditor.inspector.v1";
const readOpenState = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};
/** Is section `id` open? A remembered choice wins; otherwise `def`. */
export function sectionOpen(id: string, def: boolean): boolean {
  const v = readOpenState()[id];
  return typeof v === "boolean" ? v : def;
}
export function setSectionOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...readOpenState(), [id]: open }));
  } catch {
    /* blocked storage: the section still toggles for this render */
  }
}

export interface SectionSpec {
  /** Stable id: the open state is remembered under it, and the header button gets `data-section`. */
  id: string;
  title: string;
  /** Right-hand summary (the mockup's "setup pose", "1 slots", "off"). */
  meta?: string;
  tip: string;
  /** Open when the user has not chosen yet. */
  open: boolean;
  body: Kid[];
}

/** A collapsible inspector section: header button (chevron, title, summary) and a body. */
export function section(spec: SectionSpec, rerender?: () => void): HTMLElement {
  const open = sectionOpen(spec.id, spec.open);
  const box = document.createElement("section");
  box.className = `insp-sec${open ? " open" : ""}`;
  box.dataset.sec = spec.id;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "insp-sec-head";
  head.dataset.section = spec.id;
  head.title = `${spec.title}: ${spec.tip} (click to ${open ? "collapse" : "expand"})`;
  head.setAttribute("aria-expanded", String(open));
  head.innerHTML = `${iconHtml("chevD")}<span class="insp-sec-title">${spec.title}</span><span class="insp-sec-meta"></span>`;
  (head.querySelector(".insp-sec-meta") as HTMLElement).textContent = spec.meta ?? "";
  head.addEventListener("click", () => {
    setSectionOpen(spec.id, !open);
    if (rerender) rerender();
    else {
      box.classList.toggle("open", !open);
      head.setAttribute("aria-expanded", String(!open));
    }
  });
  box.append(head);
  if (open) {
    const body = document.createElement("div");
    body.className = "insp-sec-body";
    body.append(...spec.body);
    box.append(body);
  }
  return box;
}

// ---------------------------------------------------------------------------------------------
// Header, fields
// ---------------------------------------------------------------------------------------------

export interface HeaderSpec {
  icon: IconName;
  /** Token colour variable for the icon, e.g. `--c-bone`. */
  tone: string;
  kind: string;
  /** The name editor (an input) or a static name. */
  name: HTMLElement;
  /** Ancestry shown under the name; each crumb is a button when it has a handler. */
  crumbs: { text: string; go?: () => void }[];
  tip: string;
}

export function nodeHeader(h: HeaderSpec): HTMLElement {
  const head = document.createElement("div");
  head.className = "insp-head";
  head.innerHTML = `<span class="insp-ico" style="color:var(${h.tone})">${iconHtml(h.icon, "ico-md")}</span>`;
  const chip = document.createElement("span");
  chip.className = "chip insp-kind";
  chip.textContent = h.kind;
  chip.title = h.tip;
  const top = document.createElement("div");
  top.className = "insp-top";
  top.append(h.name, chip);
  const crumbs = document.createElement("nav");
  crumbs.className = "insp-crumbs";
  crumbs.setAttribute("aria-label", "Where this node sits");
  h.crumbs.forEach((c, i) => {
    if (i) crumbs.append(Object.assign(document.createElement("span"), { className: "insp-sep", innerHTML: iconHtml("chevR") }));
    const b = document.createElement(c.go ? "button" : "span");
    b.className = "name insp-crumb";
    b.textContent = c.text;
    if (c.go) {
      (b as HTMLButtonElement).type = "button";
      b.title = `Select ${c.text}`;
      b.addEventListener("click", c.go);
    }
    crumbs.append(b);
  });
  const col = document.createElement("div");
  col.className = "insp-id";
  col.append(top, crumbs);
  head.append(col);
  return head;
}

/** A static name in the header (nodes that cannot be renamed here). */
export const staticName = (text: string): HTMLElement => Object.assign(document.createElement("span"), { className: "name insp-name", textContent: text, title: text });

export interface Axis {
  /** Axis letter shown in the little tab (X, Y, Z, Length ...). */
  tag: string;
  input: HTMLInputElement;
  unit?: string;
}
/** One axis field: a tag tab, the input and a unit. */
export function axisCell(a: Axis): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "insp-ax";
  cell.append(Object.assign(document.createElement("i"), { textContent: a.tag }), a.input, Object.assign(document.createElement("em"), { textContent: a.unit ?? "" }));
  return cell;
}
/** A mockup row: label, then one or two axis fields (`X [ 12 ] px  Y [ 74 ] px`). */
export function axisRow(label: string, ...axes: Axis[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "insp-row";
  row.append(Object.assign(document.createElement("span"), { className: "label insp-lab", textContent: label }));
  for (const a of axes) {
    row.append(axisCell(a));
  }
  return row;
}
/** A label + free controls row. */
export function plainRow(label: string, ...kids: Kid[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "insp-row insp-plain";
  const v = document.createElement("span");
  v.className = "insp-val";
  v.append(...kids);
  row.append(Object.assign(document.createElement("span"), { className: "label insp-lab", textContent: label }), v);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Page context
// ---------------------------------------------------------------------------------------------

export interface PageCtx {
  ui: RigUi;
  raw: JsonObject;
  skin: string;
  regions: AtlasRegion[];
  bone: string | null;
  slot: string | null;
  att: string | null;
  /** The image under the Image tool: name + its attachment object (placement frame). */
  image(): { name: string; att: JsonObject } | null;
  /** Show another node (re-renders the panel and the Tree). */
  nav(n: NodeSel): void;
  /** Set the node without drawing (a rename: the next render must already point at the new name). */
  preset(n: NodeSel): void;
  selectBone(name: string): void;
  rerender(): void;
  /** Persist a section as open and redraw. */
  openSection(id: string): void;
  act: {
    /** Opens the bottom Images dock (the atlas image browser). */
    openImages(): void;
    transformBone(name: string, t: { x?: number; y?: number; rotation?: number; length?: number }): void;
    renameBone(name: string, to: string): Promise<boolean>;
    reparent(name: string, parent: string | null): void;
    boneProps(name: string, p: { color?: string | null; helper?: boolean | null }): void;
    deleteBone(name: string): void;
    setGround(): void;
    autoBind(): void;
    rebindSlot(slot: string, bone: string): void;
    setDefault(slot: string, name: string | null): void;
    removeImage(slot: string, name: string): void;
    /** Adds a point attachment (grip / tip / socket) to the slot. */
    addPoint(slot: string, preset: "point" | "grip" | "tip"): void;
    /** Adds a clip mask or a hit box polygon to the slot. */
    addPolygon(slot: string, kind: PolygonKind): void;
    /** Adds a path (a bezier curve for a path constraint) in a slot of its own beside the slot. */
    addPath(slot: string): void;
    /** Edits a path: move a vertex (3 per control point: handle in, point, handle out), insert or remove a control point, set closed / constant speed. */
    editPath(slot: string, name: string, e: { kind: "move"; index: number; x: number; y: number } | { kind: "insert"; index: number } | { kind: "remove"; index: number } | { kind: "flags"; closed?: boolean; constantSpeed?: boolean }): void;
    /** Edits a clip mask / hit box polygon: move, insert or remove a point, or set a mask's end slot. */
    editPolygon(slot: string, name: string, e: { kind: "move"; index: number; x: number; y: number } | { kind: "insert"; index: number } | { kind: "remove"; index: number } | { kind: "end"; end: string | null }): void;
    /** Makes an image sequence of the picked atlas images on the selected slot. */
    makeSequence(paths: string[]): void;
    /** Edits the image-sequence block of an image or mesh (null makes it a single image again). */
    setSequence(slot: string, name: string, fields: SequenceFields | null): void;
    /** Links the image to a mesh (`source`), unlinks it (`source: null`) or sets deform inheritance (`inherit`). */
    linkMesh(slot: string, name: string, o: { source?: AttAddress | null; inherit?: boolean }): void;
    transformImage(t: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number }): void;
    attachRegion(path: string, o: { slot?: string | null }): void;
    attachFile(file: File, o: { slot?: string | null }): void;
    setConstraint(kind: ConstraintKind, name: string, fields: Record<string, unknown>): void;
    removeConstraint(kind: ConstraintKind, name: string): void;
    setTool(tool: "mesh" | "weights"): void;
    /** Poses the driver bone at `deg` degrees from its setup rotation for looking only (null clears it). */
    previewAngle(bone: string | null, deg: number): void;
    /** Replaces the picture of an image or mesh with a PNG file (rigging kept; UVs remapped per mode). */
    relinkArt(slot: string, name: string, file: File, mode: RelinkMode): void;
    /** Re-reads the image from its page file on disk (the original PNG changed). */
    reloadArt(slot: string, name: string, mode: RelinkMode): void;
    /** Opens the Corrective sculpt tool for a set at a driver angle. */
    sculpt(t: { set: string; bone: string; at: number }): void;
    status(text: string, kind?: "" | "bad" | "ok"): void;
  };
}

const bonesOf = (c: PageCtx) => listOf(c.raw["bones"]);
const slotsOf = (c: PageCtx) => listOf(c.raw["slots"]);

/** root > ... > bone, as crumbs that select each bone. */
function boneCrumbs(c: PageCtx, bone: string): { text: string; go?: () => void }[] {
  const byName = new Map(bonesOf(c).map((b) => [String(b["name"]), b] as const));
  const path: string[] = [];
  for (let n: string | null = bone, guard = 0; n && guard < 64; guard++) {
    path.unshift(n);
    const p: unknown = byName.get(n)?.["parent"];
    n = typeof p === "string" ? p : null;
  }
  const shown = path.length > 7 ? ["…", ...path.slice(-6)] : path;
  return shown.map((n, i) => (n === "…" || i === shown.length - 1 ? { text: n } : { text: n, go: () => c.selectBone(n) }));
}

const nameInput = (c: PageCtx, id: string, value: string, tip: string): HTMLInputElement => {
  const input = c.ui.el("input", { value, id, title: tip, className: "field insp-name-in" });
  input.setAttribute("aria-label", tip.split(":")[0]!);
  return input;
};

// ---------------------------------------------------------------------------------------------
// Bone page
// ---------------------------------------------------------------------------------------------

function slotRows(c: PageCtx, bone: string): HTMLElement {
  const list = ui(c, "div", "insp-list");
  const on = slotsOf(c).filter((s) => s["bone"] === bone);
  const atts = (c.raw["skins"] as JsonObject | undefined)?.[c.skin];
  const byslot = isObj(atts) && isObj(atts["attachments"]) ? (atts["attachments"] as JsonObject) : {};
  for (const s of on) {
    const name = String(s["name"]);
    const a = isObj(byslot[name]) ? Object.values(byslot[name] as JsonObject).filter(isObj) : [];
    const kind = a.some((x) => x["type"] === "mesh") ? "mesh" : a.length ? "img" : "empty";
    const row = ui(c, "button", "insp-item");
    (row as HTMLButtonElement).type = "button";
    row.title = `Open slot ${name}`;
    row.dataset.slot = name;
    row.innerHTML = `${iconHtml("slot")}<span class="name"></span><span class="label"></span>`;
    (row.querySelector(".name") as HTMLElement).textContent = name;
    (row.querySelector(".label") as HTMLElement).textContent = kind;
    row.addEventListener("click", () => c.nav({ kind: "slot", slot: name }));
    list.append(row);
  }
  if (!on.length) list.append(Object.assign(ui(c, "div", "insp-note"), { textContent: "No slot follows this bone yet." }));
  return list;
}
const ui = (c: PageCtx, tag: keyof HTMLElementTagNameMap, cls: string): HTMLElement => c.ui.el(tag, { className: cls });

function constraintRows(c: PageCtx, bone: string): HTMLElement {
  const list = ui(c, "div", "insp-list");
  const rows: { ckind: "ik" | "transform" | "path" | "physics"; name: string; note: string }[] = [
    ...ikConstraints(c.raw).filter((k) => k.bones.includes(bone) || k.target === bone).map((k) => ({ ckind: "ik" as const, name: k.name, note: `${k.bones.length} bone${k.bones.length === 1 ? "" : "s"}` })),
    ...transformConstraints(c.raw).filter((k) => k.bones.includes(bone) || k.target === bone).map((k) => ({ ckind: "transform" as const, name: k.name, note: "transform" })),
    ...pathConstraints(c.raw).filter((k) => k.bones.includes(bone)).map((k) => ({ ckind: "path" as const, name: k.name, note: "path" })),
    ...physicsConstraints(c.raw).filter((k) => k.bone === bone).map((k) => ({ ckind: "physics" as const, name: k.name, note: "physics" }))
  ];
  for (const r of rows) {
    const row = ui(c, "button", "insp-item");
    (row as HTMLButtonElement).type = "button";
    row.title = `Open constraint ${r.name}`;
    row.dataset.con = r.name;
    row.innerHTML = `${iconHtml("constraint")}<span class="name"></span><span class="label"></span>`;
    (row.querySelector(".name") as HTMLElement).textContent = r.name;
    (row.querySelector(".label") as HTMLElement).textContent = r.note;
    row.addEventListener("click", () => c.nav({ kind: "constraint", ckind: r.ckind, name: r.name }));
    list.append(row);
  }
  if (!rows.length) list.append(Object.assign(ui(c, "div", "insp-note"), { textContent: "No constraint uses this bone." }));
  return list;
}

export interface Page {
  head: HTMLElement;
  sections: HTMLElement[];
  /** Pinned at the bottom (Delete). */
  foot: HTMLElement[];
}

export function bonePage(c: PageCtx, names: string[]): Page {
  const { ui: u } = c;
  const sel = c.bone!;
  const bone = bonesOf(c).find((b) => b["name"] === sel)!;
  const t = (k: string, d = 0) => Number(bone[k] ?? d);
  const edit = (label: string, f: Parameters<RigUi["run"]>[1]) => void u.run(label, f);
  const msg = u.el("div", { className: "field-msg", id: "setup-name-msg", hidden: true });
  const name = nameInput(c, "setup-name", sel, "Bone name: Enter or leave the field to rename (clip keys and skins follow)");
  const check = (): string => {
    const v = name.value.trim();
    if (v === sel) return "";
    if (!v) return "A bone needs a name";
    if (/[^A-Za-z0-9_.-]/.test(v)) return "Use letters, digits, _ . and - only";
    if (bonesOf(c).some((b) => b["name"] === v)) return `A bone called "${v}" already exists`;
    return "";
  };
  name.addEventListener("input", () => {
    const m = check();
    msg.textContent = m;
    msg.hidden = !m;
    name.classList.toggle("invalid", !!m);
    name.setAttribute("aria-invalid", m ? "true" : "false");
  });
  name.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      name.value = sel;
      name.dispatchEvent(new Event("input"));
      name.blur();
    }
  });
  name.addEventListener("change", () => {
    if (check()) {
      name.value = sel;
      name.dispatchEvent(new Event("input"));
      return;
    }
    void c.act.renameBone(sel, name.value.trim()).then((ok) => !ok && (name.value = sel));
  });
  const head = nodeHeader({ icon: "bone", tone: "--c-bone", kind: "BONE", name, crumbs: boneCrumbs(c, sel), tip: "A bone: the node you are editing" });
  head.querySelector(".insp-id")!.append(msg);

  const num = (id: string, tip: string, value: number, step: string, apply: (v: number) => void): HTMLInputElement => {
    const i = u.num(value, step, apply, 64);
    i.id = id;
    i.title = tip;
    i.className = "field num";
    i.setAttribute("aria-label", tip.split(":")[0]!);
    return i;
  };
  const field = (label: string, key: "scaleX" | "scaleY" | "shearX" | "shearY", id: string, tip: string, def: number, step: string) => num(id, tip, t(key, def), step, (v) => edit(`${label} ${sel}`, (raw) => planBoneFields(raw, sel, { [key]: v })));
  const transform = section({
    id: "bone.transform",
    title: "Transform",
    meta: "setup pose",
    tip: "where the bone sits in the setup pose: position, rotation, length, scale and shear",
    open: true,
    body: [
      axisRow("Position", { tag: "X", input: num("setup-x", "Position X in the parent's space (px)", t("x"), "1", (v) => c.act.transformBone(sel, { x: v })), unit: "px" }, { tag: "Y", input: num("setup-y", "Position Y in the parent's space (px)", t("y"), "1", (v) => c.act.transformBone(sel, { y: v })), unit: "px" }),
      axisRow("Rotation", { tag: "Z", input: num("setup-rotation", "Setup rotation in degrees", t("rotation"), "0.5", (v) => c.act.transformBone(sel, { rotation: v })), unit: "deg" }, { tag: "Length", input: num("setup-length", "Bone length in px (also the square at the bone tip)", t("length"), "1", (v) => c.act.transformBone(sel, { length: v })), unit: "px" }),
      axisRow("Scale", { tag: "X", input: field("Scale", "scaleX", "setup-scalex", "Setup scale along the bone (1 = unchanged); children follow", 1, "0.05") }, { tag: "Y", input: field("Scale", "scaleY", "setup-scaley", "Setup scale across the bone (1 = unchanged); children follow", 1, "0.05") }),
      axisRow("Shear", { tag: "X", input: field("Shear", "shearX", "setup-shearx", "Setup shear along x, in degrees", 0, "0.5"), unit: "deg" }, { tag: "Y", input: field("Shear", "shearY", "setup-sheary", "Setup shear along y, in degrees", 0, "0.5"), unit: "deg" })
    ]
  });

  // Inherit and limits
  const mode = typeof bone["inherit"] === "string" ? bone["inherit"] : "normal";
  const flags = u.el("span", { className: "insp-chips", id: "setup-inherit" });
  for (const flag of ["rotation", "scale", "reflection"] as const) {
    const tg = inheritToggle(mode, flag);
    const box = u.el("input", { type: "checkbox", checked: tg.checked, disabled: tg.next === null });
    box.dataset.inherit = flag;
    box.addEventListener("change", () => tg.next && void u.run(`Inherit ${flag} of ${sel}`, () => ({ commands: [{ op: "bone.set", name: sel, inherit: tg.next! }], bone: sel })));
    flags.append(u.el("label", { className: "chip-toggle", title: tg.reason || `Inherit ${flag} from the parent bone: ${tg.checked ? "on" : "off"}` }, box, ` ${flag[0]!.toUpperCase()}${flag.slice(1)}`));
  }
  const lim = bone["limits"] as { min?: number; max?: number } | undefined;
  const has = !!lim;
  const limOn = u.el("input", { type: "checkbox", checked: has, id: "setup-limits-on", title: "Limit how far the bone may turn from its setup rotation (degrees); poses are clamped" });
  limOn.addEventListener("change", () => edit(`Limits of ${sel}`, (raw) => planBoneLimits(raw, sel, limOn.checked ? { min: -90, max: 90 } : null)));
  const limMin = num("setup-limit-min", "Lowest turn from the setup rotation, in degrees", lim?.min ?? -90, "1", (v) => edit(`Limits of ${sel}`, (raw) => planBoneLimits(raw, sel, { min: v, max: Number(lim?.max ?? 90) })));
  const limMax = num("setup-limit-max", "Highest turn from the setup rotation, in degrees", lim?.max ?? 90, "1", (v) => edit(`Limits of ${sel}`, (raw) => planBoneLimits(raw, sel, { min: Number(lim?.min ?? -90), max: v })));
  limMin.disabled = limMax.disabled = !has;
  const parent = u.select([{ value: "", label: "(none)" }, ...bonesOf(c).filter((b) => b["name"] !== sel).map((b) => ({ value: String(b["name"]), label: String(b["name"]) }))], typeof bone["parent"] === "string" ? bone["parent"] : "", (v) => c.act.reparent(sel, v || null));
  parent.id = "setup-parent";
  parent.className = "field";
  parent.title = "Parent bone: change it to re-parent (the bone keeps its place in the world)";
  const inherit = section({
    id: "bone.inherit",
    title: "Inherit and limits",
    meta: has ? "limited" : "off",
    tip: "which parent motion the bone follows, its parent, and an optional turn limit",
    open: window.innerHeight >= 860,
    body: [
      plainRow("Parent", parent),
      plainRow("Inherit", flags),
      plainRow("Turn limit", u.el("label", { className: "chip-toggle", title: limOn.title }, limOn, " Limit turning")),
      axisRow("Range", { tag: "Min", input: limMin, unit: "deg" }, { tag: "Max", input: limMax, unit: "deg" })
    ]
  });

  // Appearance
  const colorRaw = typeof bone["color"] === "string" ? (bone["color"] as string) : "";
  const color = u.el("input", { type: "color", value: `#${(colorRaw || "d8dde6ff").slice(0, 6)}`, id: "setup-color", title: "Bone colour (saved in the rig)", className: "insp-color" });
  color.addEventListener("change", () => c.act.boneProps(sel, { color: `${color.value.slice(1)}ff` }));
  const clear = u.el("button", { textContent: "Clear", className: "btn sm", type: "button", title: "Back to the default bone colour", id: "setup-color-clear" });
  clear.addEventListener("click", () => c.act.boneProps(sel, { color: null }));
  const helper = u.el("input", { type: "checkbox", checked: bone["helper"] === true, id: "setup-helper", title: "Mark as a helper bone: hidden when Helpers is off" });
  helper.addEventListener("change", () => c.act.boneProps(sel, { helper: helper.checked }));
  const appearance = section({
    id: "bone.appearance",
    title: "Appearance",
    meta: "colour, helper",
    tip: "the bone's colour, helper flag and how it shows on the canvas",
    open: false,
    body: [plainRow("Colour", color, clear), plainRow("Helper", u.el("label", { className: "chip-toggle", title: helper.title }, helper, " Hidden / helper bone")), outlinerBoneAppearance(names, sel)]
  });

  const slots = slotsOf(c).filter((s) => s["bone"] === sel);
  const newSlot = u.el("button", { textContent: "New slot", className: "btn", type: "button", id: "setup-newslot", title: `New slot: an empty slot on ${sel}, drawn in front of the others` });
  newSlot.dataset.action = "new-slot";
  newSlot.addEventListener("click", () => {
    let made = "";
    void u.run("New slot", (raw) => {
      const plan = planNewSlot(raw, sel);
      made = String(plan.commands[0]!["name"]);
      return plan;
    }).then((ok) => ok && c.nav({ kind: "slot", slot: made }));
  });
  const attachBtn = u.el("button", { textContent: "Attach image", className: "btn", type: "button", id: "setup-attach-open", title: "Attach image: open the Images dock, pick an atlas image and put it on a new slot on this bone" });
  attachBtn.addEventListener("click", () => c.act.openImages());
  const autobind = u.el("button", { textContent: "Auto-bind", className: "btn", type: "button", id: "setup-autobind", title: "Auto-bind: attach every slot to the nearest bone (image centre against the bone)" });
  autobind.addEventListener("click", () => c.act.autoBind());
  const slotSec = section({
    id: "bone.slots",
    title: "Slots on this bone",
    meta: `${slots.length} slot${slots.length === 1 ? "" : "s"}`,
    tip: "the slots that follow this bone; open one to edit it",
    open: true,
    body: [slotRows(c, sel), u.el("div", { className: "insp-line" }, newSlot, attachBtn, autobind)]
  });

  const cons = section({
    id: "bone.constraints",
    title: "Constraints",
    meta: String(ikConstraints(c.raw).filter((k) => k.bones.includes(sel) || k.target === sel).length + transformConstraints(c.raw).filter((k) => k.bones.includes(sel) || k.target === sel).length + physicsConstraints(c.raw).filter((k) => k.bone === sel).length),
    tip: "IK, transform and physics constraints on this bone; add one here",
    open: true,
    body: [addConstraintRow(u, c.raw, sel), constraintRows(c, sel)]
  });

  const del = u.el("button", { textContent: "Delete bone", className: "btn btn-danger insp-delete", type: "button", id: "setup-delete", title: "Delete the bone; its children move up to its parent and stay where they are (Delete)" });
  del.innerHTML = `${iconHtml("trash")}<span>Delete bone</span>`;
  del.addEventListener("click", () => c.act.deleteBone(sel));
  const foot: HTMLElement[] = [];
  if (sel === "root") {
    const g = u.el("button", { className: "btn", type: "button", id: "setup-ground", title: "Set ground here: move the root (the ground point) to the bottom centre of the images; the art does not move" });
    g.innerHTML = "<span>Set ground here</span>";
    g.addEventListener("click", () => c.act.setGround());
    foot.push(g);
  }
  foot.push(del);
  return { head, sections: [transform, inherit, appearance, slotSec, cons, ...(bone["parent"] ? [correctivesCard(c, sel)] : [])], foot };
}

// ---------------------------------------------------------------------------------------------
// Correctives ()
// ---------------------------------------------------------------------------------------------

/**
 * Elbow / knee correctives: pick the driver joint, scrub its angle, sculpt the mesh at that angle (a driven key of a set), list and delete
 * the keys. The sculpt itself is the Corrective sculpt Setup tool; every store and delete is one undoable Setup edit.
 */
function correctivesCard(c: PageCtx, sel: string): HTMLElement {
  const { ui: u } = c;
  syncCorrectiveState(c.raw, sel);
  const st = correctiveState;
  const driver = st.driver!;
  const sets = correctiveSets(c.raw, driver);
  const current = sets.find((s) => s.name === st.set) ?? null;
  const named = <T extends HTMLElement>(id: string, text: string, node: T): T => {
    node.setAttribute("aria-label", text);
    node.id = id;
    return node;
  };
  const driverSel = named(
    "corr-driver",
    "Driver joint",
    u.select(bonesOf(c).map((b) => ({ value: String(b["name"]), label: String(b["name"]) })), driver, (v) => {
      st.driver = v;
      st.set = correctiveSets(c.raw, v)[0]?.name ?? "new";
      c.act.previewAngle(v, st.angle);
      c.rerender();
    })
  );
  driverSel.className = "field";
  driverSel.title = "Driver joint: the bone whose angle selects the correction (the elbow for a bent forearm)";
  const setSel = named(
    "corr-set",
    "Corrective set",
    u.select([...sets.map((s) => ({ value: s.name, label: s.name })), { value: "new", label: "(new set)" }], st.set, (v) => {
      st.set = v;
      c.rerender();
    })
  );
  setSel.className = "field";
  setSel.title = "Corrective set: the group of angle keys to add to, or start a new set";
  const angle = u.el("input", { type: "range", min: String(ANGLE_MIN), max: String(ANGLE_MAX), step: "1", value: String(st.angle), id: "corr-angle", className: "field", title: "Driver angle: scrub the joint to preview the corrections at this bend (looking only, the setup pose is not changed)" });
  angle.setAttribute("aria-label", "Driver angle");
  const angleNum = u.num(st.angle, "1", (v) => setAngle(v), 64);
  angleNum.id = "corr-angle-num";
  angleNum.className = "field num";
  angleNum.title = "Driver angle in degrees from the setup rotation (type an exact angle)";
  angleNum.setAttribute("aria-label", "Driver angle in degrees");
  function setAngle(v: number): void {
    st.angle = roundAngle(Math.max(ANGLE_MIN, Math.min(ANGLE_MAX, v)));
    angle.value = String(st.angle);
    angleNum.value = String(st.angle);
    c.act.previewAngle(driver, st.angle);
  }
  angle.addEventListener("input", () => setAngle(Number(angle.value)));
  const sculpt = u.el("button", { textContent: "Sculpt at this angle", className: "btn btn-primary", type: "button", id: "corr-sculpt", title: "Sculpt at this angle: pose the driver here and drag mesh vertices; each release stores a key of the set at this angle (undoable)" });
  sculpt.addEventListener("click", () => {
    const set = st.set === "new" ? newSetName(c.raw, driver) : st.set;
    st.pending = st.set === "new" ? set : null;
    c.act.sculpt({ set, bone: driver, at: st.angle });
  });
  const reset = u.el("button", { textContent: "Reset pose", className: "btn", type: "button", id: "corr-reset", title: "Reset pose: clear the angle preview and put the joint back at its setup pose" });
  reset.addEventListener("click", () => {
    st.angle = 0;
    c.act.previewAngle(null, 0);
    c.rerender();
  });
  const rows = u.el("div", { className: "insp-list", id: "corr-keys" });
  for (const k of current?.keys ?? []) {
    const row = u.el("div", { className: "insp-item corr-key" });
    row.dataset.at = String(k.at);
    const go = u.el("button", { textContent: "Go", className: "btn sm", type: "button", title: "Go to this angle: pose the driver here to preview the key" });
    go.dataset.act = "corr-go";
    go.addEventListener("click", () => {
      setAngle(k.at);
      c.rerender();
    });
    const again = u.el("button", { textContent: "Sculpt", className: "btn sm", type: "button", title: "Sculpt this key again at its angle" });
    again.dataset.act = "corr-edit";
    again.addEventListener("click", () => {
      setAngle(k.at);
      c.act.sculpt({ set: current!.name, bone: driver, at: k.at });
    });
    const del = u.el("button", { textContent: "Delete", className: "btn sm btn-danger", type: "button", title: "Delete the key at this angle (undoable); the last key removes the set" });
    del.dataset.act = "corr-del";
    del.addEventListener("click", () => void u.run(`Delete the ${current!.name} key at ${k.at} degrees`, (raw) => ({ commands: planDeleteCorrectiveKey(raw, current!.name, k.at), bone: sel })));
    const what = [k.meshes.length ? `${k.meshes.length} mesh${k.meshes.length === 1 ? "" : "es"}` : "empty", ...k.extras].join(", ");
    row.append(Object.assign(document.createElement("span"), { className: "name", textContent: `${k.at} deg`, title: k.meshes.join(", ") }), Object.assign(document.createElement("span"), { className: "label", textContent: what }), go, again, del);
    rows.append(row);
  }
  if (!current?.keys.length) rows.append(Object.assign(document.createElement("div"), { className: "insp-note", textContent: current ? "This set has no keys." : "No keys yet. Scrub the angle, then Sculpt at this angle." }));
  const total = sets.reduce((n, s) => n + s.keys.length, 0);
  return section(
    {
      id: "bone.correctives",
      title: "Correctives",
      meta: sets.length ? `${sets.length} set${sets.length === 1 ? "" : "s"}, ${total} key${total === 1 ? "" : "s"}` : "none",
      tip: "fix a bent elbow or knee: sculpt the mesh at chosen joint angles; the project blends between the keys",
      open: sets.length > 0,
      body: [plainRow("Driver joint", driverSel), plainRow("Set", setSel), plainRow("Angle", angle, angleNum, " deg"), u.el("div", { className: "insp-line" }, sculpt, reset), rows]
    },
    c.rerender
  );
}

// ---------------------------------------------------------------------------------------------
// Slot page
// ---------------------------------------------------------------------------------------------

const MOVES: Array<[DrawMove, string, string, string, IconName]> = [
  ["up", "Up", "setup-slot-up", "Move the slot one step toward the front (drawn later, on top)", "chevU"],
  ["down", "Down", "setup-slot-down", "Move the slot one step toward the back (drawn earlier, underneath)", "chevD"],
  ["front", "Front", "setup-slot-front", "Draw the slot in front of every other slot", "chevU"],
  ["back", "Back", "setup-slot-back", "Draw the slot behind every other slot", "chevD"]
];

export function slotPage(c: PageCtx): Page {
  const { ui: u } = c;
  const slotName = c.slot!;
  const cur = slotsOf(c).find((s) => s["name"] === slotName)!;
  const boneOf = String(cur["bone"] ?? "");
  const name = nameInput(c, "setup-slot-name", slotName, "Slot name: Enter or leave the field to rename (clip keys and skins follow)");
  name.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      name.value = slotName;
      name.blur();
    }
  });
  name.addEventListener("change", () => {
    const to = name.value.trim();
    c.preset({ kind: "slot", slot: to });
    void u.run(`Rename slot ${slotName}`, (raw) => planRenameSlot(raw, slotName, to)).then((ok) => {
      if (ok) return;
      name.value = slotName;
      c.nav({ kind: "slot", slot: slotName });
    });
  });
  const head = nodeHeader({ icon: "slot", tone: "--c-slot", kind: "SLOT", name, crumbs: [...boneCrumbs(c, boneOf).map((x) => (x.go ? x : { ...x, go: () => c.selectBone(boneOf) })), { text: slotName }], tip: "A slot: a place on a bone that shows one image at a time" });

  const color = typeof cur["color"] === "string" ? (cur["color"] as string) : "ffffffff";
  const swatch = u.el("input", { type: "color", value: `#${color.slice(0, 6)}`, id: "setup-slot-color", title: "Slot tint: multiplies the colour of every image in the slot", className: "insp-color" });
  swatch.addEventListener("change", () => void u.run(`Tint of ${slotName}`, (raw) => planSlotLook(raw, slotName, { color: `${swatch.value.slice(1)}${color.slice(6)}` })));
  const alpha = u.num(Math.round((parseInt(color.slice(6), 16) / 255) * 100) / 100, "0.05", (v) => void u.run(`Opacity of ${slotName}`, (raw) => planSlotLook(raw, slotName, { color: `${color.slice(0, 6)}${Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")}` })), 64);
  alpha.id = "setup-slot-alpha";
  alpha.title = "Slot opacity, 0 to 1";
  alpha.className = "field num";
  const blend = u.select([{ value: "normal", label: "Normal" }, { value: "additive", label: "Additive (glow)" }], typeof cur["blend"] === "string" ? (cur["blend"] as string) : "normal", (v) => void u.run(`Blend of ${slotName}`, (raw) => planSlotLook(raw, slotName, { blend: v as "normal" | "additive" })));
  blend.id = "setup-slot-blend";
  blend.title = "Blend mode: Normal, or Additive for glows";
  blend.className = "field";
  const boneSel = u.select(boneNames(c.raw).map((n) => ({ value: n, label: n })), boneOf, (v) => c.act.rebindSlot(slotName, v));
  boneSel.id = "setup-slot-bone";
  boneSel.title = "The bone this slot follows; the image stays where it is";
  boneSel.className = "field";
  const slotSec = section({
    id: "slot.look",
    title: "Slot",
    meta: `follows ${boneOf}`,
    tip: "the bone the slot follows, its tint and its blend mode",
    open: true,
    body: [plainRow("Bone", boneSel), plainRow("Tint", swatch, axisCell({ tag: "Op", input: alpha })), plainRow("Blend", blend)]
  });

  // Draw order
  const order = drawOrderOf(c.raw);
  const at = order.indexOf(slotName);
  const anchored = isAnchored(c.raw, slotName);
  const bar = u.el("div", { className: "insp-line insp-moves", id: "setup-draworder-btns" });
  for (const [how, text, id, tip, icon] of MOVES) {
    const b = u.el("button", { className: "btn sm", type: "button", id, title: anchored ? "This slot is drawn relative to another slot (drawAfter / drawBefore): clear that first" : tip });
    b.innerHTML = `${iconHtml(icon)}<span>${text}</span>`;
    b.dataset.move = how;
    b.disabled = at < 0 || anchored || ((how === "up" || how === "front") && at === order.length - 1) || ((how === "down" || how === "back") && at === 0);
    b.addEventListener("click", () => void u.run(`${text}: ${slotName}`, (raw) => planDrawOrder(raw, slotName, how)));
    bar.append(b);
  }
  const position = at < 0 ? 0 : order.length - at;
  const draw = section({
    id: "slot.draw",
    title: "Draw order",
    meta: at < 0 ? "anchored" : `${position} of ${order.length}`,
    tip: "where the slot is drawn: higher is in front. Drag rows in the Tree's Draw order section to reorder many",
    open: true,
    body: [u.el("div", { className: "insp-note", textContent: at < 0 ? "Drawn relative to another slot." : `Position ${position} of ${order.length}. Higher draws on top.` }), bar]
  });

  // Images in this slot
  const skinDef = isObj(c.raw["skins"]) && isObj((c.raw["skins"] as JsonObject)[c.skin]) ? ((c.raw["skins"] as JsonObject)[c.skin] as JsonObject) : {};
  const allAtts = isObj(skinDef["attachments"]) ? (skinDef["attachments"] as JsonObject) : {};
  const atts = isObj(allAtts[slotName]) ? (allAtts[slotName] as JsonObject) : {};
  const current = typeof cur["attachment"] === "string" ? cur["attachment"] : null;
  const showAll = sectionOpen("slot.variants", false);
  const list = u.el("div", { className: "insp-list insp-images" });
  let hidden = 0;
  for (const [aname, a] of Object.entries(atts)) {
    if (!showAll && isVariantPath(aname) && aname !== current && aname !== c.att) {
      hidden++;
      continue;
    }
    const type = isObj(a) ? String(a["type"]) : "";
    const row = u.el("div", { className: `insp-item insp-att${aname === current ? " sel" : ""}` });
    const radio = u.el("input", { type: "radio", checked: aname === current, title: "Setup image: the one this slot shows by default", name: "setup-default-image" });
    radio.setAttribute("aria-label", `Use ${aname} as the setup image`);
    radio.addEventListener("change", () => c.act.setDefault(slotName, aname));
    const open = u.el("button", { type: "button", className: "insp-link", title: `Open ${aname}: its placement and mesh` });
    open.innerHTML = `${iconHtml(type === "mesh" ? "toolMesh" : "attachment")}<span class="name"></span><span class="label"></span>`;
    (open.querySelector(".name") as HTMLElement).textContent = aname;
    (open.querySelector(".label") as HTMLElement).textContent = type;
    open.addEventListener("click", () => c.nav({ kind: "attachment", slot: slotName, name: aname }));
    const rm = u.el("button", { type: "button", className: "btn-icon insp-trash", title: "Remove this image from the slot", innerHTML: iconHtml("trash") });
    rm.setAttribute("aria-label", `Remove ${aname}`);
    rm.addEventListener("click", () => c.act.removeImage(slotName, aname));
    row.append(radio, open, rm);
    list.append(row);
  }
  const none = u.el("div", { className: "insp-item insp-att" }, u.el("input", { type: "radio", checked: current === null, title: "Show nothing by default", name: "setup-default-image" }), u.el("span", { className: "name dim", textContent: "(nothing)" }));
  none.querySelector("input")!.addEventListener("change", () => c.act.setDefault(slotName, null));
  list.append(none);
  const attachBtn = u.el("button", { textContent: "Attach image...", className: "btn", type: "button", id: "setup-attach-open", title: "Attach image: open the Images dock to pick an atlas image or import a PNG for this slot" });
  attachBtn.addEventListener("click", () => c.act.openImages());
  const buttons = [attachBtn];
  const pointTips = { point: "Add a named point (a socket for an effect or attachment) on this slot's bone; drag it with the Image tool", grip: "Add a grip point: where a hand holds this item (weapon grip). Starts on the slot's image; drag it with the Image tool", tip: "Add a tip point: the business end of this item (blade tip, tool head). Starts on the slot's image; drag it with the Image tool" } as const;
  for (const [preset, label] of [["point", "+ Point"], ["grip", "+ Grip"], ["tip", "+ Tip"]] as const) {
    const b = u.el("button", { textContent: label, className: "btn", type: "button", id: `setup-add-${preset}`, title: pointTips[preset] });
    b.dataset.action = `add-${preset}`;
    b.addEventListener("click", () => c.act.addPoint(slotName, preset));
    buttons.push(b);
  }
  const polyTips = { clipping: "Add a clip mask: a polygon that cuts the slots drawn after it (up to its end slot) to its shape. Drag its points with the Image tool", boundingbox: "Add a hit box: a polygon the project can test a point against (hit areas, click targets). Never drawn in the project; drag its points with the Image tool" } as const;
  for (const [kind, label] of [["clipping", "+ Clip mask"], ["boundingbox", "+ Hit box"]] as const) {
    const b = u.el("button", { textContent: label, className: "btn", type: "button", id: `setup-add-${kind}`, title: polyTips[kind] });
    b.dataset.action = `add-${kind}`;
    b.addEventListener("click", () => c.act.addPolygon(slotName, kind));
    buttons.push(b);
  }
  {
    const b = u.el("button", { textContent: "+ Path", className: "btn", type: "button", id: "setup-add-path", title: "Add a path: a bezier curve in a slot of its own on this bone. Drag its points and handles with the Image tool, then add a path constraint to make bones follow it" });
    b.dataset.action = "add-path";
    b.addEventListener("click", () => c.act.addPath(slotName));
    buttons.push(b);
  }
  if (hidden) {
    const more = u.el("button", { textContent: `Show ${hidden} variants`, className: "btn", type: "button", title: "Crease (c###) and generated (g####) variants of this slot's images" });
    more.addEventListener("click", () => {
      setSectionOpen("slot.variants", true);
      c.rerender();
    });
    buttons.push(more);
  }
  const count = Object.keys(atts).length;
  const images = section({
    id: "slot.images",
    title: "Images in this slot",
    meta: `${count} image${count === 1 ? "" : "s"}`,
    tip: "the images this slot can show; the dot marks the setup image",
    open: true,
    body: [list, u.el("div", { className: "insp-line" }, ...buttons)]
  });

  const del = u.el("button", { className: "btn btn-danger insp-delete", type: "button", id: "setup-delslot", title: `Delete slot: removes ${slotName}, its images and its clip keys (Undo brings it back)`, innerHTML: `${iconHtml("trash")}<span>Delete slot</span>` });
  del.dataset.action = "delete-slot";
  del.addEventListener("click", () => {
    void u
      .ask({ title: `Delete slot ${slotName}?`, message: `Delete the slot "${slotName}" with its images and its clip keys? Undo brings it back.`, confirmLabel: "Delete slot", danger: true, id: "delete-slot-dialog" })
      .then((yes) => yes && u.run(`Delete slot ${slotName}`, (raw) => planDeleteSlot(raw, slotName)))
      .then((ok) => ok && c.selectBone(boneOf));
  });
  return { head, sections: [slotSec, draw, images], foot: [del] };
}

// ---------------------------------------------------------------------------------------------
// Attachment page
// ---------------------------------------------------------------------------------------------

export function attachmentPage(c: PageCtx): Page {
  const { ui: u } = c;
  const slotName = c.slot!;
  const aname = c.att!;
  const slot = slotsOf(c).find((s) => s["name"] === slotName);
  const boneOf = String(slot?.["bone"] ?? "");
  const info = c.image();
  const rawAtt = objOfRaw(objOfRaw(objOfRaw(objOfRaw(c.raw["skins"])[c.skin])["attachments"])[slotName])[aname];
  const type = info ? String(info.att["type"] ?? "region") : isObj(rawAtt) ? String(rawAtt["type"] ?? "region") : "region";
  if (type === "clipping" || type === "boundingbox") return polygonPage(c, slotName, aname, type, objOfRaw(rawAtt), boneOf);
  if (type === "path") return pathPage(c, slotName, aname, objOfRaw(rawAtt), boneOf);
  const linkedKind = type === "linkedMesh";
  const mesh = type === "mesh" || linkedKind;
  const point = type === "point";
  const head = nodeHeader({ icon: mesh ? "toolMesh" : "attachment", tone: mesh ? "--c-mesh" : "--c-image", kind: linkedKind ? "LINKED" : mesh ? "MESH" : point ? "POINT" : "IMAGE", name: staticName(aname), crumbs: [...boneCrumbs(c, boneOf).map((x) => (x.go ? x : { ...x, go: () => c.selectBone(boneOf) })), { text: slotName, go: () => c.nav({ kind: "slot", slot: slotName }) }, { text: aname }], tip: mesh ? "A mesh image: a deformable picture" : point ? "A point: a named position and direction on a bone that nothing draws (grip, tip, socket)" : "An image: a picture placed on a slot" });
  const n = (id: string, tip: string, v: number, step: string, apply: (v: number) => void): HTMLInputElement => {
    const i = u.num(v, step, apply, 64);
    i.id = id;
    i.title = tip;
    i.className = "field num";
    return i;
  };
  const f = (k: string, d: number) => Number(info?.att[k] ?? d);
  const body: Kid[] = info && point
    ? [
        axisRow("Position", { tag: "X", input: n("setup-img-x", "Point position X on its bone (px)", f("x", 0), "1", (v) => c.act.transformImage({ x: v })), unit: "px" }, { tag: "Y", input: n("setup-img-y", "Point position Y on its bone (px)", f("y", 0), "1", (v) => c.act.transformImage({ y: v })), unit: "px" }),
        axisRow("Direction", { tag: "Z", input: n("setup-img-rot", "Point direction in degrees (the arrow in the view)", f("rotation", 0), "0.5", (v) => c.act.transformImage({ rotation: v })), unit: "deg" }),
        u.el("div", { className: "insp-note", textContent: "A point is never drawn in the project. Drag it with the Image tool; drag the ring at the end of its arrow to turn it." })
      ]
    : info
    ? [
        axisRow("Position", { tag: "X", input: n("setup-img-x", "Image position X on its bone (px)", f("x", 0), "1", (v) => c.act.transformImage({ x: v })), unit: "px" }, { tag: "Y", input: n("setup-img-y", "Image position Y on its bone (px)", f("y", 0), "1", (v) => c.act.transformImage({ y: v })), unit: "px" }),
        axisRow("Rotation", { tag: "Z", input: n("setup-img-rot", "Image rotation in degrees", f("rotation", 0), "0.5", (v) => c.act.transformImage({ rotation: v })), unit: "deg" }),
        axisRow("Scale", { tag: "X", input: n("setup-img-sx", "Image scale X", f("scaleX", 1), "0.05", (v) => c.act.transformImage({ scaleX: v })) }, { tag: "Y", input: n("setup-img-sy", "Image scale Y", f("scaleY", 1), "0.05", (v) => c.act.transformImage({ scaleY: v })) }),
        plainRow("Size", Object.assign(u.el("span", { className: "name" }), { textContent: `${f("width", 0)} x ${f("height", 0)} px` }))
      ]
    : [u.el("div", { className: "insp-note", textContent: mesh ? "Mesh placement is edited with the Mesh tool." : "This image has no placement to edit." })];
  const isDefault = slot?.["attachment"] === aname;
  const dflt = u.el("button", { className: "btn", type: "button", id: "setup-set-default", disabled: isDefault, textContent: isDefault ? "Setup image" : "Make setup image", title: isDefault ? "This is the image the slot shows in the setup pose" : "Make this the image the slot shows in the setup pose" });
  dflt.addEventListener("click", () => c.act.setDefault(slotName, aname));
  const tools: HTMLElement[] = point ? [] : [dflt];
  if (mesh && !linkedKind) {
    const em = u.el("button", { className: "btn", type: "button", id: "setup-edit-mesh", textContent: "Edit mesh", title: "Edit mesh: switch to the Mesh tool for this image (M)" });
    em.addEventListener("click", () => c.act.setTool("mesh"));
    const ew = u.el("button", { className: "btn", type: "button", id: "setup-edit-weights", textContent: "Weights", title: "Weights: switch to the Weights tool to paint which bones move this mesh (W)" });
    ew.addEventListener("click", () => c.act.setTool("weights"));
    tools.push(em, ew);
  }
  const place = section({ id: "att.place", title: mesh ? "Mesh image" : point ? "Point" : "Image", meta: type, tip: point ? "where the point sits on its bone and which way it faces" : "where the image sits on its bone", open: true, body: [...body, u.el("div", { className: "insp-line" }, ...tools)] });
  const del = u.el("button", { className: "btn btn-danger insp-delete", type: "button", id: "setup-remove-image", title: point ? "Remove this point from the slot (Undo brings it back)" : "Remove this image from the slot (Undo brings it back)", innerHTML: `${iconHtml("trash")}<span>${point ? "Remove point" : "Remove image"}</span>` });
  del.addEventListener("click", () => {
    c.act.removeImage(slotName, aname);
    c.nav({ kind: "slot", slot: slotName });
  });
  const sections: HTMLElement[] = [place];
  if (mesh) sections.push(linkSection(c, slotName, aname, rawAtt));
  if (!point) sections.push(sourceArtSection(c, slotName, aname, rawAtt));
  if (!point) sections.push(sequenceSection(c, slotName, aname, objOfRaw(rawAtt)));
  return { head, sections, foot: [del] };
}

/** The page of a clip mask or hit box: end slot (masks), the point table and how to edit on the stage. */
function polygonPage(c: PageCtx, slotName: string, aname: string, kind: PolygonKind, att: JsonObject, boneOf: string): Page {
  const { ui: u } = c;
  const mask = kind === "clipping";
  const head = nodeHeader({ icon: "attachment", tone: mask ? "--c-mesh" : "--c-image", kind: mask ? "CLIP MASK" : "HIT BOX", name: staticName(aname), crumbs: [...boneCrumbs(c, boneOf).map((x) => (x.go ? x : { ...x, go: () => c.selectBone(boneOf) })), { text: slotName, go: () => c.nav({ kind: "slot", slot: slotName }) }, { text: aname }], tip: mask ? "A clip mask: cuts the slots drawn after it, up to its end slot, to its polygon" : "A hit box: a polygon the project can test a point against; never drawn" });
  const vertices = Array.isArray(att["vertices"]) ? (att["vertices"] as number[]) : [];
  const count = vertices.length / 2;
  const body: Kid[] = [];
  if (mask) {
    const slots = listOf(c.raw["slots"]).map((s) => String(s["name"]));
    const sel = u.select([{ value: "", label: "(end of the draw order)" }, ...slots.map((s) => ({ value: s, label: s }))], typeof att["end"] === "string" ? att["end"] : "", (v) => c.act.editPolygon(slotName, aname, { kind: "end", end: v === "" ? null : v }));
    sel.id = "poly-end";
    sel.className = "field";
    sel.title = "End slot: the last slot the mask cuts. Slots drawn after it are not clipped";
    sel.setAttribute("aria-label", "End slot");
    body.push(plainRow("End slot", sel));
  }
  const list = u.el("div", { className: "insp-list", id: "poly-points" });
  for (let i = 0; i < count; i++) {
    const row = u.el("div", { className: "insp-item" });
    const x = u.num(vertices[i * 2] as number, "1", (v) => c.act.editPolygon(slotName, aname, { kind: "move", index: i, x: v, y: vertices[i * 2 + 1] as number }), 64);
    const y = u.num(vertices[i * 2 + 1] as number, "1", (v) => c.act.editPolygon(slotName, aname, { kind: "move", index: i, x: vertices[i * 2] as number, y: v }), 64);
    for (const [input, axis] of [[x, "X"], [y, "Y"]] as const) {
      input.className = "field num";
      input.title = `Point ${i + 1} ${axis} on the bone (px)`;
      input.setAttribute("aria-label", `Point ${i + 1} ${axis}`);
    }
    x.id = `poly-x${i}`;
    y.id = `poly-y${i}`;
    const add = u.el("button", { type: "button", className: "btn sm", textContent: "+", title: `Add a point after point ${i + 1}, halfway to the next` });
    add.setAttribute("aria-label", `Add a point after point ${i + 1}`);
    add.addEventListener("click", () => c.act.editPolygon(slotName, aname, { kind: "insert", index: i }));
    const rm = u.el("button", { type: "button", className: "btn-icon insp-trash", title: count <= 3 ? "A polygon needs at least 3 points" : `Remove point ${i + 1}`, innerHTML: iconHtml("trash") });
    rm.setAttribute("aria-label", `Remove point ${i + 1}`);
    rm.disabled = count <= 3;
    rm.addEventListener("click", () => c.act.editPolygon(slotName, aname, { kind: "remove", index: i }));
    row.append(u.el("span", { className: "name", textContent: String(i + 1) }), x, y, add, rm);
    list.append(row);
  }
  body.push(list, u.el("div", { className: "insp-note", textContent: "Edit on the stage with the Image tool: drag a point to move it, click an edge to add a point, Shift-click a point to remove it. The colour toggle is in Overlays." }));
  const place = section({ id: "poly.points", title: mask ? "Mask polygon" : "Hit box polygon", meta: `${count} points`, tip: "the corners of the polygon in the slot bone's space; at least 3", open: true, body });
  const del = u.el("button", { className: "btn btn-danger insp-delete", type: "button", id: "setup-remove-image", title: `Remove this ${mask ? "clip mask" : "hit box"} from the slot (Undo brings it back)`, innerHTML: `${iconHtml("trash")}<span>Remove ${mask ? "clip mask" : "hit box"}</span>` });
  del.addEventListener("click", () => {
    c.act.removeImage(slotName, aname);
    c.nav({ kind: "slot", slot: slotName });
  });
  return { head, sections: [place], foot: [del] };
}

/** The page of a path: closed and constant-speed switches and the table of control points with their handles. */
function pathPage(c: PageCtx, slotName: string, aname: string, att: JsonObject, boneOf: string): Page {
  const { ui: u } = c;
  const head = nodeHeader({ icon: "pathCurve", tone: "--c-constraint", kind: "PATH", name: staticName(aname), crumbs: [...boneCrumbs(c, boneOf).map((x) => (x.go ? x : { ...x, go: () => c.selectBone(boneOf) })), { text: slotName, go: () => c.nav({ kind: "slot", slot: slotName }) }, { text: aname }], tip: "A path: a bezier curve that a path constraint moves bones along; never drawn in the project" });
  const weighted = Array.isArray(att["bones"]);
  const pts = weighted ? [] : pathPoints(att);
  const closed = att["closed"] === true;
  const flag = (id: string, label: string, tip: string, on: boolean, apply: (v: boolean) => void) => {
    const cb = u.el("input", { type: "checkbox", checked: on, id, title: tip });
    cb.setAttribute("aria-label", label);
    cb.addEventListener("change", () => apply(cb.checked));
    return u.el("label", { className: "chip-toggle", title: tip }, cb, ` ${label}`);
  };
  const body: Kid[] = [
    plainRow("Options", flag("path-closed", "Closed loop", "Closed: the last point joins back to the first, making a loop (needs 3 or more points)", closed, (v) => c.act.editPath(slotName, aname, { kind: "flags", closed: v })), flag("path-constant", "Constant speed", "Constant speed: bones move along the curve at an even speed (off = by curve parameter, cheaper but uneven)", att["constantSpeed"] !== false, (v) => c.act.editPath(slotName, aname, { kind: "flags", constantSpeed: v })))
  ];
  if (weighted) body.push(u.el("div", { className: "insp-note", textContent: "This path is weighted to bones; it is edited in the rig file. The editor moves unweighted paths." }));
  const list = u.el("div", { className: "insp-list", id: "path-points" });
  const vert = (pi: number, part: 0 | 1 | 2, axis: 0 | 1) => (att["vertices"] as number[])[(pi * 3 + part) * 2 + axis] as number;
  pts.forEach((_p, i) => {
    const row = u.el("div", { className: "insp-item insp-pathpt" });
    const cell = (part: 0 | 1 | 2, label: string): Node[] => {
      const out: Node[] = [];
      for (const axis of [0, 1] as const) {
        const input = u.num(vert(i, part, axis), "1", (v) => c.act.editPath(slotName, aname, { kind: "move", index: i * 3 + part, x: axis === 0 ? v : vert(i, part, 0), y: axis === 1 ? v : vert(i, part, 1) }), 56);
        input.className = "field num";
        input.id = `path-${part === 1 ? "p" : part === 0 ? "in" : "out"}${axis === 0 ? "x" : "y"}${i}`;
        input.title = `Point ${i + 1} ${label} ${axis === 0 ? "X" : "Y"} on the bone (px)${part === 1 ? ": moving the point carries its handles" : ""}`;
        input.setAttribute("aria-label", `Point ${i + 1} ${label} ${axis === 0 ? "X" : "Y"}`);
        out.push(input);
      }
      return out;
    };
    const add = u.el("button", { type: "button", className: "btn sm", textContent: "+", title: closed || i < pts.length - 1 ? `Add a point after point ${i + 1}, splitting that curve in its middle` : "An open path has no curve after its last point" });
    add.setAttribute("aria-label", `Add a point after point ${i + 1}`);
    add.disabled = !closed && i >= pts.length - 1;
    add.addEventListener("click", () => c.act.editPath(slotName, aname, { kind: "insert", index: i }));
    const min = closed ? 3 : 2;
    const rm = u.el("button", { type: "button", className: "btn-icon insp-trash", title: pts.length <= min ? `A ${closed ? "closed" : "open"} path needs at least ${min} points` : `Remove point ${i + 1}`, innerHTML: iconHtml("trash") });
    rm.setAttribute("aria-label", `Remove point ${i + 1}`);
    rm.disabled = pts.length <= min;
    rm.addEventListener("click", () => c.act.editPath(slotName, aname, { kind: "remove", index: i }));
    row.append(u.el("span", { className: "name", textContent: String(i + 1) }), ...cell(1, "point"), u.el("span", { className: "label", textContent: "in", title: "Handle in: bends the curve arriving at this point" }), ...cell(0, "handle in"), u.el("span", { className: "label", textContent: "out", title: "Handle out: bends the curve leaving this point" }), ...cell(2, "handle out"), add, rm);
    list.append(row);
  });
  body.push(list, u.el("div", { className: "insp-note", textContent: "Edit on the stage with the Image tool: drag a square to move a point and its handles, drag a dot to bend the curve, click the curve to add a point, Shift-click a square to remove it. The orange toggle is in Overlays." }));
  const place = section({ id: "path.points", title: "Path curve", meta: `${pts.length} points`, tip: "the control points of the curve in the slot bone's space; each has a handle in and a handle out", open: true, body });
  const users = pathConstraints(c.raw).filter((k) => k.target === slotName);
  const used = section({ id: "path.users", title: "Used by", meta: users.length ? `${users.length}` : "none", tip: "the path constraints that move bones along this path", open: true, body: users.length ? users.map((k) => { const b = u.el("button", { type: "button", className: "insp-item", title: `Open the path constraint ${k.name}` }); b.textContent = k.name; b.addEventListener("click", () => c.nav({ kind: "constraint", ckind: "path", name: k.name })); return b; }) : [u.el("div", { className: "insp-note", textContent: "No path constraint uses this path yet. Select a bone and press Path in the + Constraint row." })] });
  const del = u.el("button", { className: "btn btn-danger insp-delete", type: "button", id: "setup-remove-image", title: "Remove this path from the slot (Undo brings it back)", innerHTML: `${iconHtml("trash")}<span>Remove path</span>` });
  del.addEventListener("click", () => {
    c.act.removeImage(slotName, aname);
    c.nav({ kind: "slot", slot: slotName });
  });
  return { head, sections: [place, used], foot: [del] };
}

/** The Image sequence card: frame count, first number, padding and setup frame of an image or mesh that plays numbered atlas images. */
function sequenceSection(c: PageCtx, slotName: string, aname: string, att: JsonObject): HTMLElement {
  const { ui: u } = c;
  const seq = isObj(att["sequence"]) ? att["sequence"] : null;
  const body: Kid[] = [];
  const field = (id: string, label: string, tip: string, key: keyof SequenceFields, min: number) => {
    const input = u.num(Number(seq?.[key] ?? 0), "1", (v) => c.act.setSequence(slotName, aname, { [key]: Math.max(min, Math.round(v)) }), 64);
    input.id = id;
    input.className = "field num";
    input.title = tip;
    input.setAttribute("aria-label", label);
    return plainRow(label, input);
  };
  if (seq) {
    body.push(
      field("seq-count", "Frames", "How many numbered images the sequence has", "count", 1),
      field("seq-start", "First number", "The number of the first frame in the image names (boom_01 starts at 1)", "start", 0),
      field("seq-digits", "Digits", "Zero padding of the frame numbers: 2 reads boom_01; 0 for no padding", "digits", 0),
      field("seq-setup", "Setup frame", "The frame shown when no sequence key is in effect (0 is the first)", "setup", 0),
      u.el("div", { className: "insp-note", textContent: `Frames are the atlas images named ${String(att["path"] ?? "")} plus the number. Key the mode, start frame and delay in Animate (Image sequence row).` })
    );
    const off = u.el("button", { type: "button", className: "btn", id: "seq-remove", textContent: "Make a single image", title: "Remove the sequence: the attachment shows its one image again (Undo brings it back)" });
    off.addEventListener("click", () => c.act.setSequence(slotName, aname, null));
    body.push(u.el("div", { className: "insp-line" }, off));
  } else {
    const on = u.el("button", { type: "button", className: "btn", id: "seq-make", textContent: "Play numbered images", title: "Make this image a sequence: it shows the atlas images named like its path plus a frame number (boom_1, boom_2, ...). To start from several images at once, Ctrl-click them in the Images dock and press Make sequence" });
    on.addEventListener("click", () => c.act.setSequence(slotName, aname, { count: 2, start: 1, digits: 0, setup: 0 }));
    body.push(u.el("div", { className: "insp-note", textContent: "A single image. Make it a sequence to play frame-by-frame art (effects, smears, blinks)." }), u.el("div", { className: "insp-line" }, on));
  }
  return section({ id: "att.sequence", title: "Image sequence", meta: seq ? `${String(seq["count"])} frames` : "off", tip: "frame-by-frame art in this slot: numbered atlas images played by sequence keys", open: !!seq, body });
}


/** The Source art card: replace the picture (any size, rigging kept) or reload it from its file on disk. */
function sourceArtSection(c: PageCtx, slotName: string, aname: string, rawAtt: unknown): HTMLElement {
  const { ui: u } = c;
  const att = objOfRaw(rawAtt);
  const mode = u.select(
    [
      { value: "stretch", label: "Stretch to the same shape" },
      { value: "keep-scale", label: "Keep pixel scale, centred" }
    ],
    "stretch",
    () => undefined
  );
  mode.id = "art-mode";
  mode.className = "field";
  mode.title = "When the new picture has another size: stretch it over the same shape, or keep its pixel scale centred on the old one (UVs are remapped either way; vertices, weights and keys stay)";
  mode.setAttribute("aria-label", "When the size changes");
  const file = u.el("input", { type: "file", accept: "image/png", id: "art-file", hidden: true });
  file.setAttribute("aria-label", "New picture (PNG)");
  const pick = u.el("button", { textContent: "Replace image...", className: "btn", type: "button", id: "art-replace", title: "Replace image: choose a new PNG for this picture, even at another size; the mesh, weights and keys stay (Undo brings the old picture back)" });
  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) c.act.relinkArt(slotName, aname, f, mode.value as RelinkMode);
  });
  const reload = u.el("button", { textContent: "Reload from source", className: "btn", type: "button", id: "art-reload", title: "Reload from source: read this picture's PNG from disk again after you changed it in your paint program; the rigging stays" });
  reload.addEventListener("click", () => c.act.reloadArt(slotName, aname, mode.value as RelinkMode));
  const path = String(att["path"] ?? "");
  return section({
    id: "att.art",
    title: "Source art",
    meta: `${Number(att["width"] ?? 0)} x ${Number(att["height"] ?? 0)}`,
    tip: "replace this picture with a new PNG or reload it from disk; the mesh, weights and keys stay",
    open: false,
    body: [plainRow("Picture", Object.assign(u.el("span", { className: "name", id: "art-path" }), { textContent: path, title: path })), plainRow("If size changes", mode), u.el("div", { className: "insp-line" }, pick, reload, file)]
  });
}

/** The Linked mesh card: the source this image shares its shape and weights with, deform inheritance, Unlink, and who links to this mesh. */
function linkSection(c: PageCtx, slotName: string, aname: string, rawAtt: unknown): HTMLElement {
  const { ui: u } = c;
  const self: AttAddress = { skin: c.skin, slot: slotName, name: aname };
  const src = linkSourceOf(c.raw, self);
  const keyOf = (a: AttAddress) => `${a.skin}/${a.slot}/${a.name}`;
  const options = [{ value: "", label: "(not linked: its own mesh)" }, ...linkCandidates(c.raw, self).map((a) => ({ value: keyOf(a), label: a.skin === c.skin ? `${a.slot} / ${a.name}` : keyOf(a) }))];
  const pick = u.select(options, src ? keyOf(src) : "", (v) => {
    if (!v) {
      if (src) c.act.linkMesh(slotName, aname, { source: null });
      return;
    }
    const chosen = linkCandidates(c.raw, self).find((a) => keyOf(a) === v);
    if (chosen) c.act.linkMesh(slotName, aname, { source: chosen });
  });
  pick.id = "setup-link-source";
  pick.className = "field";
  pick.title = "Link to mesh: this image draws its own picture on another mesh's shape and weights; edit the source and this follows";
  const inherit = u.el("input", { type: "checkbox", id: "setup-link-inherit", checked: isObj(rawAtt) ? rawAtt["inheritDeform"] !== false : true, disabled: !src, title: "Inherit deform: the source's deform keys (shape keys) and driven deforms also move this image" });
  inherit.addEventListener("change", () => c.act.linkMesh(slotName, aname, { inherit: inherit.checked }));
  const unlink = u.el("button", { className: "btn", type: "button", id: "setup-unlink", textContent: "Unlink", disabled: !src, title: "Unlink: copy the source's shape and weights into this image so it becomes its own mesh (it looks the same; Undo relinks)" });
  unlink.addEventListener("click", () => c.act.linkMesh(slotName, aname, { source: null }));
  const deps = linkedDependants(c.raw, self);
  const notes: HTMLElement[] = [];
  if (src) notes.push(u.el("div", { className: "insp-note", id: "setup-link-note", textContent: `Shares the shape and weights of ${src.slot} / ${src.name}. Reshape the source and this follows; this image only changes its picture.` }));
  if (deps.length) notes.push(u.el("div", { className: "insp-note", id: "setup-link-deps", textContent: `${deps.length} image${deps.length === 1 ? "" : "s"} link to this mesh (${deps.slice(0, 4).map((d) => d.name).join(", ")}${deps.length > 4 ? ", ..." : ""}). Editing this mesh moves them too.` }));
  return section({ id: "att.link", title: "Linked mesh", meta: src ? `to ${src.name}` : deps.length ? `${deps.length} link here` : "none", tip: "share another mesh's shape and weights instead of keeping a copy", open: !!src || deps.length > 0, body: [plainRow("Link to", pick), plainRow("Deform", inherit, " inherit"), u.el("div", { className: "insp-line" }, unlink), ...notes] });
}

// ---------------------------------------------------------------------------------------------
// Constraint page
// ---------------------------------------------------------------------------------------------

export function constraintPage(c: PageCtx, ckind: "ik" | "transform" | "path" | "physics", cname: string): Page {
  const { ui: u } = c;
  const boneOpts = bonesOf(c).map((b) => ({ value: String(b["name"]), label: String(b["name"]) }));
  const num = (v: number, step: string, apply: (v: number) => void, tip: string, id?: string): HTMLInputElement => {
    const i = u.num(v, step, apply, 64);
    i.className = "field num";
    i.title = tip;
    if (id) i.id = id;
    return i;
  };
  const kindText = ckind === "ik" ? "IK" : ckind === "transform" ? "TRANSFORM" : ckind === "path" ? "PATH" : "PHYSICS";
  const owner = ckind === "ik" ? ikConstraints(c.raw).find((k) => k.name === cname) : ckind === "transform" ? transformConstraints(c.raw).find((k) => k.name === cname) : undefined;
  const bones = owner?.bones ?? [];
  const head = nodeHeader({ icon: "constraint", tone: "--c-constraint", kind: kindText, name: staticName(cname), crumbs: [{ text: "Constraints" }, { text: cname }], tip: `A ${ckind} constraint: runs every frame in the order shown below` });
  const sections: HTMLElement[] = [];
  if (ckind === "ik" && owner && "bendPositive" in owner) {
    const k = owner;
    const bend = u.el("button", { textContent: k.bendPositive ? "Bend +" : "Bend -", title: "Bend direction of the elbow or knee", className: "btn bend", type: "button" });
    bend.dataset.ik = cname;
    bend.addEventListener("click", () => c.act.setConstraint("ik", cname, { bendPositive: !k.bendPositive }));
    const stretch = u.el("input", { type: "checkbox", checked: k.stretch, title: "Stretch: lengthen the chain to reach a far target" });
    stretch.addEventListener("change", () => c.act.setConstraint("ik", cname, { stretch: stretch.checked }));
    const compress = u.el("input", { type: "checkbox", checked: k.compress, title: "Compress: shorten the chain toward a near target" });
    compress.addEventListener("change", () => c.act.setConstraint("ik", cname, { compress: compress.checked }));
    const mix = num(k.mix, "0.05", (v) => c.act.setConstraint("ik", cname, { mix: v }), "How much the constraint drives the chain, 0 to 1");
    mix.dataset.ik = cname;
    mix.classList.add("ikmix");
    const target = u.select(boneOpts, k.target, (v) => c.act.setConstraint("ik", cname, { target: v }));
    target.className = "field";
    target.title = "Target bone the chain reaches for";
    sections.push(
      section({
        id: "con.ik",
        title: "IK",
        meta: bones.join(" > "),
        tip: "target, mix, bend direction, softness, stretch and compress",
        open: true,
        body: [plainRow("Target", target), plainRow("Mix", mix, bend), plainRow("Softness", num(k.softness, "1", (v) => c.act.setConstraint("ik", cname, { softness: v }), "Softness: eases the chain's reach near full extension")), plainRow("Flags", u.el("label", { className: "chip-toggle" }, stretch, " Stretch"), u.el("label", { className: "chip-toggle" }, compress, " Compress"))]
      })
    );
  } else if (ckind === "transform" && owner && "mixes" in owner) {
    const k = owner;
    const local = u.el("input", { type: "checkbox", checked: k.local, title: "Local: copy the target's local transform" });
    local.addEventListener("change", () => c.act.setConstraint("transform", cname, { local: local.checked }));
    const relative = u.el("input", { type: "checkbox", checked: k.relative, title: "Relative: add the target's change to the bone" });
    relative.addEventListener("change", () => c.act.setConstraint("transform", cname, { relative: relative.checked }));
    const target = u.select(boneOpts, k.target, (v) => c.act.setConstraint("transform", cname, { target: v }));
    target.className = "field";
    target.title = "Target bone whose transform is copied";
    const mixes = u.el("div", { className: "insp-grid" });
    for (const m of TRANSFORM_MIXES) mixes.append(u.el("span", { className: "label", textContent: `Mix ${m.slice(3).toLowerCase()}`, title: `How much of the target ${m.slice(3)} the bone takes, 0 to 1` }), num(k.mixes[m], "0.05", (v) => c.act.setConstraint("transform", cname, { [m]: v }), `Mix ${m.slice(3)}: 0 to 1`));
    const offsets = u.el("div", { className: "insp-grid" });
    for (const o of TRANSFORM_OFFSETS) offsets.append(u.el("span", { className: "label", textContent: `Offset ${o}`, title: `Added to the copied ${o}` }), num(k.offset[o], "0.5", (v) => c.act.setConstraint("transform", cname, { offset: { [o]: v } }), `Offset ${o}`));
    sections.push(
      section({ id: "con.tc", title: "Transform", meta: `${bones.join(", ")} < ${k.target}`, tip: "target, flags, mixes and offsets", open: true, body: [plainRow("Target", target), plainRow("Flags", u.el("label", { className: "chip-toggle" }, local, " Local"), u.el("label", { className: "chip-toggle" }, relative, " Relative"))] }),
      section({ id: "con.tc.mix", title: "Mixes", meta: "", tip: "how much of each channel the target drives", open: true, body: [mixes] }),
      section({ id: "con.tc.off", title: "Offsets", meta: "", tip: "values added to the copied channels", open: false, body: [offsets] })
    );
  } else if (ckind === "path") {
    const k = pathConstraints(c.raw).find((p) => p.name === cname);
    if (!k) sections.push(section({ id: "con.other", title: "Path", meta: "", tip: "a path constraint", open: true, body: [u.el("div", { className: "insp-note", textContent: "This path constraint no longer exists." })] }));
    else {
      const set = (fields: Record<string, unknown>) => c.act.setConstraint("path", cname, fields);
      const modeSel = (id: string, key: "positionMode" | "spacingMode" | "rotateMode", options: readonly string[], value: string, tip: string) => {
        const sel = u.select(options.map((m) => ({ value: m, label: PATH_MODE_LABEL[m] ?? m })), value, (v) => set({ [key]: v }));
        sel.className = "field";
        sel.id = id;
        sel.title = tip;
        sel.setAttribute("aria-label", tip.split(":")[0]!);
        return sel;
      };
      const numField = (id: string, v: number, step: string, key: string, tip: string) => num(v, step, (x) => set({ [key]: x }), tip, id);
      const slots = pathSlots(c.raw);
      const targetSel = u.select((slots.includes(k.target) ? slots : [...slots, k.target]).map((s) => ({ value: s, label: s })), k.target, (v) => set({ target: v }));
      targetSel.className = "field";
      targetSel.id = "path-target";
      targetSel.title = "Target path slot: the slot whose path attachment the bones follow";
      const boneList = u.el("div", { className: "insp-list", id: "path-bones" });
      k.bones.forEach((b, i) => {
        const row = u.el("div", { className: "insp-item" });
        const rm = u.el("button", { type: "button", className: "btn-icon insp-trash", title: k.bones.length <= 1 ? "A path constraint needs at least one bone" : `Stop moving ${b} along the path`, innerHTML: iconHtml("trash") });
        rm.setAttribute("aria-label", `Remove bone ${b}`);
        rm.disabled = k.bones.length <= 1;
        rm.addEventListener("click", () => set({ bones: k.bones.filter((_x, j) => j !== i) }));
        row.append(u.el("span", { className: "name", textContent: b }), rm);
        boneList.append(row);
      });
      const valid = new Set(addablePathBones(c.raw, k.target, k.bones));
      const free = boneOpts.filter((o) => valid.has(o.value));
      const addSel = u.select(free, free[0]?.value ?? "", () => {});
      addSel.className = "field";
      addSel.id = "path-addbone-sel";
      addSel.title = "Pick a bone to add to the chain. Only bones the engine accepts are listed: not the bone the path's slot rides on or the bones above it";
      const addBtn = u.el("button", { type: "button", className: "btn", id: "path-addbone", textContent: "Add bone", title: "Add the picked bone to the end of the chain; the chain keeps this order along the path" });
      addBtn.disabled = !free.length;
      addBtn.addEventListener("click", () => set({ bones: [...k.bones, addSel.value] }));
      sections.push(
        section({ id: "con.pa", title: "Path", meta: `${k.bones.join(", ")} on ${k.target}`, tip: "the path slot and the bones that follow it", open: true, body: [plainRow("Path slot", targetSel), boneList, plainRow("Add", addSel, addBtn)] }),
        section({
          id: "con.pa.place",
          title: "Placement",
          meta: "",
          tip: "position, spacing and rotate modes",
          open: true,
          body: [
            plainRow("Position", numField("path-position", k.position, k.positionMode === "percent" ? "0.05" : "1", "position", "Position: where the first bone sits along the path (a distance in Fixed mode, 0 to 1 in Percent mode). Key it in Animate to run bones along the curve"), modeSel("path-positionmode", "positionMode", PATH_POSITION_MODES, k.positionMode, "Position mode: Fixed is a distance in px, Percent is a share of the path length")),
            plainRow("Spacing", numField("path-spacing", k.spacing, k.spacingMode === "percent" ? "0.05" : "1", "spacing", "Spacing: the gap between the bones along the path (its meaning depends on the spacing mode)"), modeSel("path-spacingmode", "spacingMode", PATH_SPACING_MODES, k.spacingMode, "Spacing mode: Length adds to bone lengths, Fixed is a distance, Percent a share of the path, Proportional shares by length")),
            plainRow("Rotate", modeSel("path-rotatemode", "rotateMode", PATH_ROTATE_MODES, k.rotateMode, "Rotate mode: Tangent faces along the path, Chain runs bone to bone, Chain scale also stretches"), numField("path-offsetrot", k.offsetRotation, "1", "offsetRotation", "Offset rotation: degrees added to the bones' turn along the path"))
          ]
        }),
        section({
          id: "con.pa.mix",
          title: "Mixes",
          meta: "",
          tip: "how much of the path each channel takes",
          open: true,
          body: [plainRow("Rotate", numField("path-mixrotate", k.mixRotate, "0.05", "mixRotate", "Mix rotate: how much the bones turn to follow the path, 0 to 1")), plainRow("X", numField("path-mixx", k.mixX, "0.05", "mixX", "Mix X: how much the bones are pulled onto the path along x, 0 to 1")), plainRow("Y", numField("path-mixy", k.mixY, "0.05", "mixY", "Mix Y: how much the bones are pulled onto the path along y, 0 to 1"))]
        })
      );
    }
  } else if (ckind === "physics") {
    const k = physicsConstraints(c.raw).find((p) => p.name === cname);
    if (!k) sections.push(section({ id: "con.other", title: "Physics", meta: "", tip: "a physics constraint", open: true, body: [u.el("div", { className: "insp-note", textContent: "This physics constraint no longer exists." })] }));
    else {
      const boneSel = u.select(boneOpts, k.bone, (v) => c.act.setConstraint("physics", cname, { bone: v }));
      boneSel.className = "field";
      boneSel.title = "The bone that swings";
      boneSel.id = "setup-phys-bone";
      const group = (g: "follow" | "spring" | "forces" | "run"): HTMLElement => {
        const grid = u.el("div", { className: "insp-grid" });
        for (const f of PHYSICS_FIELDS.filter((x) => x.group === g)) {
          grid.append(u.el("span", { className: "label", textContent: f.label, title: f.tip }), num(k.values[f.key], f.step, (v) => c.act.setConstraint("physics", cname, { [f.key]: v }), f.tip, `setup-phys-${f.key}`));
        }
        return grid;
      };
      sections.push(
        section({ id: "con.ph", title: "Physics", meta: k.bone, tip: "the bone that swings and how much of each channel follows the spring", open: true, body: [plainRow("Bone", boneSel), group("follow")] }),
        section({ id: "con.ph.spring", title: "Spring", meta: "", tip: "inertia, strength, damping and mass", open: true, body: [group("spring")] }),
        section({ id: "con.ph.forces", title: "Forces", meta: "", tip: "wind and gravity", open: true, body: [group("forces")] }),
        section({ id: "con.ph.run", title: "Mix and limits", meta: "", tip: "mix, speed limit and simulation rate", open: false, body: [group("run")] })
      );
    }
  }
  sections.push(section({ id: "con.order", title: "Run order", meta: "", tip: "constraints run in this order every frame", open: true, body: [constraintOrderRow(u, c.raw, ckind, cname)] }));
  const foot: HTMLElement[] = [];
  {
    const del = u.el("button", { className: "btn btn-danger insp-delete", type: "button", title: `Remove the ${ckind} constraint ${cname} (asks first; Undo brings it back)`, innerHTML: `${iconHtml("trash")}<span>Delete constraint</span>` });
    del.dataset.remove = cname;
    del.addEventListener("click", () => c.act.removeConstraint(ckind, cname));
    foot.push(del);
  }
  return { head, sections, foot };
}

// ---------------------------------------------------------------------------------------------
// Skin page
// ---------------------------------------------------------------------------------------------

export function skinPage(c: PageCtx, skinName: string, worn: string[], setWorn: (list: string[]) => void): Page {
  const { ui: u } = c;
  const head = nodeHeader({ icon: "skin", tone: "--c-skin", kind: "SKIN", name: staticName(skinName), crumbs: [{ text: "Skins" }, { text: skinName }], tip: "A skin: a set of images the rig can wear" });
  const def = isObj(c.raw["skins"]) && isObj((c.raw["skins"] as JsonObject)[skinName]) ? ((c.raw["skins"] as JsonObject)[skinName] as JsonObject) : {};
  const atts = isObj(def["attachments"]) ? (def["attachments"] as JsonObject) : {};
  const slotCount = Object.keys(atts).length;
  const imageCount = Object.values(atts).reduce<number>((n, s) => n + (isObj(s) ? Object.keys(s).length : 0), 0);
  const isBase = skinName === c.skin || skinName === "default";
  const on = isBase || worn.includes(skinName);
  const wear = u.el("input", { type: "checkbox", checked: on, disabled: isBase, id: "setup-skin-wear", title: isBase ? "The base skin is always worn" : "Wear this skin on top of the base skin (editor preview)" });
  wear.addEventListener("change", () => setWorn(wear.checked ? [...worn.filter((s) => s !== skinName), skinName] : worn.filter((s) => s !== skinName)));
  const open = u.el("button", { className: "btn", type: "button", id: "setup-skin-open", textContent: "Open Skins tab", title: "Open the Skins tab: wear, compare and clean up skins" });
  open.addEventListener("click", () => (window as unknown as { atlasEditor?: { showTab(t: string): void } }).atlasEditor?.showTab("skins"));
  const sec = section({
    id: "skin.info",
    title: "Skin",
    meta: isBase ? "base" : on ? "worn" : "not worn",
    tip: "what the skin holds and whether it is worn in the view",
    open: true,
    body: [plainRow("Slots", Object.assign(u.el("span", { className: "name" }), { textContent: String(slotCount) })), plainRow("Images", Object.assign(u.el("span", { className: "name" }), { textContent: String(imageCount) })), plainRow("Worn", u.el("label", { className: "chip-toggle", title: wear.title }, wear, " Wear this skin")), u.el("div", { className: "insp-line" }, open)]
  });
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const bones = names(def["bones"]);
  const cons = names(def["constraints"]);
  const listNames = (list: string[], empty: string, id: string): HTMLElement => (list.length ? u.el("div", { className: "insp-list", id }, ...list.map((nm) => u.el("div", { className: "insp-item" }, u.el("span", { className: "name", textContent: nm })))) : u.el("div", { className: "insp-note", id, textContent: empty }));
  const scoped = section({
    id: "skin.scoped",
    title: "Skin bones and constraints",
    meta: `${bones.length} bones, ${cons.length} constraints`,
    tip: "bones and constraints that are only active while this skin is worn (listed here; they come from the skin file)",
    open: bones.length + cons.length > 0,
    body: [plainRow("Bones", listNames(bones, "None: this skin adds no bones.", "setup-skin-bones")), plainRow("Constraints", listNames(cons, "None: this skin adds no constraints.", "setup-skin-constraints"))]
  });
  return { head, sections: [sec, scoped], foot: [] };
}
