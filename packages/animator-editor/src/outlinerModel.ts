/*
 * Atlas Animator editor: the Tree (outliner) model. Pure data, no DOM: the row list from a rig document, filters and search, the
 * selection history, the standard inherit checkboxes mapped to the engine's inherit modes, and the Split plan.
 *
 * Editor-only state (eye, select lock, show name, icon size, collapse) lives in `OutlinerState` and is never written to the rig.
 */
import type { AnimDocument } from "@atlas-animator/core/core";
import { boneNames, fail, uniqueName, type BonePlan, type Command, type JsonObject } from "./setupModel.js";

export type RowKind = "bone" | "slot" | "attachment" | "weight" | "constraint" | "group" | "skin" | "draw" | "event";

export interface Row {
  /** Unique, stable: `b:name`, `s:name`, `a:slot/name`, `c:kind/name`, `k:skin`, `d:slot` (Draw order), `g:constraints` / `g:skins` / `g:draw` / `g:events`, `e:name` (an event definition). */
  id: string;
  kind: RowKind;
  /** The bone / slot / attachment / constraint name. */
  name: string;
  /** Slot of an attachment row; owning bone of a slot row. */
  slot?: string;
  bone?: string;
  depth: number;
  parent: string | null;
  hasChildren: boolean;
  open: boolean;
  /** rrggbb for the icon, bones only. */
  color: string;
  helper: boolean;
  /** Right-hand badges: "IK", "TC" (transform), "PA" (path), "PH" (physics). */
  badges: string[];
  /** Attachment row: the slot's setup attachment. Slot row: its setup attachment name. */
  current?: boolean;
  /** Constraint rows: the first bone the constraint drives (what a click selects). */
  target?: string;
  /** Attachment rows: true for a mesh attachment (gets the mesh badge). Weight rows: always true. */
  mesh?: boolean;
  /** Mesh attachment rows: how many bones weight the mesh (the "Wn" badge); absent for an unweighted mesh. */
  weightBones?: number;
  /** Attachment rows: "point" (a grip / socket) or "linked" (a linked mesh); gets a badge. */
  attKind?: "point" | "linked" | "clip" | "hitbox" | "sequence" | "path";
  /** Mesh and weight rows: the skin that holds the mesh. */
  skin?: string;
  /** Weight rows: the mesh attachment's name (`name` is the weight bone). */
  attachment?: string;
  /** Mesh attachment and slot rows: the clip has deform keys on this mesh (the dot in Animate). */
  deformKeyed?: boolean;
}

export interface Filters {
  bones: boolean;
  slots: boolean;
  attachments: boolean;
  constraints: boolean;
  /** Meshes only: keep just the mesh attachments (with their slots and bones). Off by default. */
  meshes: boolean;
}

export const ALL_FILTERS: Filters = { bones: true, slots: true, attachments: true, constraints: true, meshes: false };

/** Everything the Tree remembers per rig; editor only. */
export interface OutlinerState {
  filters: Filters;
  /** Row ids whose open state differs from the default (bones open, slots closed). */
  toggled: string[];
  /** Bone / slot / attachment ids hidden with the eye (not drawn on the canvas). */
  hidden: string[];
  /** Bones that cannot be picked on the canvas. */
  locked: string[];
  /** Bones whose name is drawn on the canvas. */
  names: string[];
  /** Per-bone icon size multiplier (default 1). */
  iconSize: Record<string, number>;
  /** Animate shows the full tree instead of the simplified 8 controls. */
  fullInAnimate: boolean;
}

export function emptyState(): OutlinerState {
  return { filters: { ...ALL_FILTERS }, toggled: [], hidden: [], locked: [], names: [], iconSize: {}, fullInAnimate: false };
}

export const ICON_SIZE_MIN = 0.5;
export const ICON_SIZE_MAX = 3;
export const clampIconSize = (v: number): number => (Number.isFinite(v) ? Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, v)) : 1);

export const ROLE_COLORS: Record<string, string> = { spine: "e6c26a", limb: "7fd1ff", head: "c79bff", tail: "6bd68f", other: "aab3c2" };

/** The icon colour of a bone: its own `color` (rrggbbaa) or the colour of its role. */
export function boneColor(b: { color?: string | undefined; role?: string | undefined }): string {
  if (b.color && /^[0-9a-fA-F]{8}$/.test(b.color)) return b.color.slice(0, 6).toLowerCase();
  return ROLE_COLORS[b.role ?? "other"] ?? ROLE_COLORS["other"]!;
}

const rowIdBone = (n: string) => `b:${n}`;
const rowIdSlot = (n: string) => `s:${n}`;
const rowIdAtt = (slot: string, n: string) => `a:${slot}/${n}`;
const rowIdWeight = (slot: string, att: string, bone: string) => `w:${slot}/${att}/${bone}`;
export const ids = { bone: rowIdBone, slot: rowIdSlot, attachment: rowIdAtt, weight: rowIdWeight };

export interface BuildOptions {
  filters: Filters;
  toggled: ReadonlySet<string>;
  search: string;
  /** The open clip, whose deform keys get the dot (Animate); omit in Setup, which shows the rig itself. */
  clip?: { deform?: unknown } | null;
  /** Slot names front to back for the Draw order section (the setup draw order); defaults to the document's slot order, reversed. */
  drawOrder?: readonly string[];
}

/** A mesh attachment as the Tree needs it: its skin, and the bones that weight it (empty when unweighted). */
export interface MeshRow {
  skin: string;
  weightBones: string[];
  weighted: boolean;
}

/**
 * The bones that weight a mesh, in the mesh's bone-table order: only those some vertex influence points at (weighted vertices are
 * `n` followed by n groups of `(influence, x, y, weight)`).
 */
export function meshWeightBones(att: { bones?: readonly string[] | undefined; vertices: readonly number[] }): string[] {
  const table = att.bones ?? [];
  if (!table.length) return [];
  const used = new Set<number>();
  const v = att.vertices;
  for (let i = 0; i < v.length; ) {
    const n = v[i]!;
    if (!Number.isInteger(n) || n < 1) break;
    for (let k = 0; k < n; k++) used.add(v[i + 1 + k * 4]!);
    i += 1 + n * 4;
  }
  return table.filter((_, idx) => used.has(idx));
}

/** The mesh behind slot/attachment `name`: the first skin that holds it as a mesh, or null. */
export function meshOf(doc: Pick<AnimDocument, "skins">, slot: string, name: string): MeshRow | null {
  for (const [skin, data] of Object.entries(doc.skins)) {
    const a = data.attachments[slot]?.[name];
    if (a && a.type === "mesh") {
      const bones = meshWeightBones(a);
      return { skin, weightBones: bones, weighted: Array.isArray(a.bones) && a.bones.length > 0 };
    }
  }
  return null;
}

/** "point" or "linked" when the attachment is a point or a linked mesh in any skin, else null. */
export function attKindOf(doc: Pick<AnimDocument, "skins">, slot: string, name: string): "point" | "linked" | "clip" | "hitbox" | "sequence" | "path" | null {
  for (const data of Object.values(doc.skins)) {
    const a = data.attachments[slot]?.[name];
    if (a?.type === "point") return "point";
    if (a?.type === "linkedMesh") return "linked";
    if (a?.type === "clipping") return "clip";
    if (a?.type === "boundingbox") return "hitbox";
    if (a?.type === "path") return "path";
    if ((a?.type === "region" || a?.type === "mesh") && a.sequence) return "sequence";
  }
  return null;
}

/** True when `clip` has at least one deform key on the mesh. */
export function hasDeformKeys(clip: { deform?: unknown } | null | undefined, skin: string, slot: string, name: string): boolean {
  const deform = clip?.deform as Record<string, Record<string, Record<string, unknown>>> | undefined;
  const keys = deform?.[skin]?.[slot]?.[name];
  return Array.isArray(keys) && keys.length > 0;
}

const defaultOpen = (kind: RowKind) => kind === "bone" || kind === "group";
/** The Skins and Draw order sections start closed (Constraints starts open). */
const CLOSED_GROUPS = new Set(["g:skins", "g:draw", "g:events"]);

/** The attachment names a slot can show, in first-seen order over every skin. */
export function slotAttachments(doc: Pick<AnimDocument, "skins">, slot: string): string[] {
  const out = new Set<string>();
  for (const skin of Object.values(doc.skins)) for (const n of Object.keys(skin.attachments[slot] ?? {})) out.add(n);
  return [...out];
}

/**
 * The visible rows: bones in hierarchy order, each bone's slots, then its child bones; a slot's attachments under it; the constraints in
 * one group at the end. A search keeps the matching rows and their ancestors (forced open); a filter that is off drops that kind.
 */
export function buildRows(doc: Pick<AnimDocument, "bones" | "slots" | "skins" | "ik" | "transform" | "path" | "physics"> & { events?: AnimDocument["events"] }, o: BuildOptions): Row[] {
  const q = o.search.trim().toLowerCase();
  const meshOnly = o.filters.meshes;
  const childrenOf = new Map<string | null, typeof doc.bones>();
  const known = new Set(doc.bones.map((b) => b.name));
  for (const b of doc.bones) {
    const key = b.parent && known.has(b.parent) ? b.parent : null;
    const list = childrenOf.get(key) ?? [];
    list.push(b);
    childrenOf.set(key, list);
  }
  const slotsOf = new Map<string, typeof doc.slots>();
  for (const s of doc.slots) slotsOf.set(s.bone, [...(slotsOf.get(s.bone) ?? []), s]);
  const badgeOf = new Map<string, string[]>();
  const addBadge = (bone: string, tag: string) => {
    const l = badgeOf.get(bone) ?? [];
    if (!l.includes(tag)) l.push(tag);
    badgeOf.set(bone, l);
  };
  for (const c of doc.ik) for (const b of c.bones) addBadge(b, "IK");
  for (const c of doc.ik) addBadge(c.target, "IK");
  for (const c of doc.transform) for (const b of c.bones) addBadge(b, "TC");
  for (const c of doc.path) for (const b of c.bones) addBadge(b, "PA");
  for (const c of doc.physics) addBadge(c.bone, "PH");

  const isOpen = (id: string, kind: RowKind) => (CLOSED_GROUPS.has(id) ? false : defaultOpen(kind)) !== o.toggled.has(id);
  const match = (text: string) => q === "" || text.toLowerCase().includes(q);
  const out: Row[] = [];

  /** Emits `row` and its subtree; returns whether anything from this subtree matched the search. */
  const emit = (row: Row, kids: () => void, own: boolean): boolean => {
    const at = out.length;
    out.push(row);
    const before = out.length;
    // A search expands everything so the match shows; otherwise the row's open state decides.
    const expand = q !== "" || row.open;
    if (q !== "") row.open = true;
    if (expand) kids();
    const kidRows = out.length - before;
    row.hasChildren = row.hasChildren || kidRows > 0;
    const keep = own || kidRows > 0;
    if (!keep) out.length = at;
    return keep;
  };

  const showBone = (b: (typeof doc.bones)[number], depth: number, parent: string | null): void => {
    const id = rowIdBone(b.name);
    const kidsBones = childrenOf.get(b.name) ?? [];
    const kidsSlots = slotsOf.get(b.name) ?? [];
    const visible = o.filters.bones;
    const row: Row = { id, kind: "bone", name: b.name, depth, parent, hasChildren: kidsBones.length + kidsSlots.length > 0, open: isOpen(id, "bone"), color: boneColor(b), helper: b.helper === true, badges: badgeOf.get(b.name) ?? [] };
    const nextDepth = visible ? depth + 1 : depth;
    const kids = () => {
      for (const s of kidsSlots) showSlot(s, nextDepth, visible ? id : parent);
      for (const c of kidsBones) showBone(c, nextDepth, visible ? id : parent);
    };
    if (!visible) return kids();
    emit(row, kids, match(b.name) && !meshOnly);
  };

  const showSlot = (s: (typeof doc.slots)[number], depth: number, parent: string | null): void => {
    const id = rowIdSlot(s.name);
    const atts = slotAttachments(doc, s.name);
    const visible = o.filters.slots;
    const showAtts = o.filters.attachments || meshOnly;
    const meshes = new Map(atts.map((n) => [n, meshOf(doc, s.name, n)] as const));
    const shownAtts = atts.filter((n) => !meshOnly || meshes.get(n));
    const keyed = (n: string): boolean => {
      const m = meshes.get(n);
      return !!m && hasDeformKeys(o.clip, m.skin, s.name, n);
    };
    const row: Row = { id, kind: "slot", name: s.name, bone: s.bone, depth, parent, hasChildren: showAtts && shownAtts.length > 0, open: isOpen(id, "slot"), color: "", helper: false, badges: [], ...(shownAtts.some(keyed) ? { deformKeyed: true } : {}) };
    const nextDepth = visible ? depth + 1 : depth;
    const kids = () => {
      if (!showAtts) return;
      for (const a of shownAtts) {
        const aid = rowIdAtt(s.name, a);
        const m = meshes.get(a) ?? null;
        const weighted = !!m && m.weightBones.length > 0;
        const ar: Row = {
          id: aid,
          kind: "attachment",
          name: a,
          slot: s.name,
          bone: s.bone,
          depth: nextDepth,
          parent: visible ? id : parent,
          hasChildren: weighted,
          open: weighted && isOpen(aid, "attachment"),
          color: "",
          helper: false,
          badges: [],
          current: s.attachment === a,
          ...(attKindOf(doc, s.name, a) ? { attKind: attKindOf(doc, s.name, a)! } : {}),
          ...(m ? { mesh: true, skin: m.skin, ...(m.weighted ? { weightBones: m.weightBones.length } : {}), ...(keyed(a) ? { deformKeyed: true } : {}) } : {})
        };
        const boneMatch = m ? m.weightBones.some((bn) => match(bn)) : false;
        if (!match(a) && !(q !== "" && boneMatch)) continue;
        out.push(ar);
        // A search opens a weighted mesh so the matching bone shows.
        if (m && weighted && (q !== "" || ar.open)) {
          ar.open = true;
          for (const bn of m.weightBones) {
            if (q !== "" && !match(bn) && !match(a)) continue;
            out.push({ id: rowIdWeight(s.name, a, bn), kind: "weight", name: bn, slot: s.name, bone: bn, attachment: a, skin: m.skin, mesh: true, depth: nextDepth + 1, parent: aid, hasChildren: false, open: false, color: "", helper: false, badges: [] });
          }
        }
      }
    };
    if (!visible) return kids();
    // Meshes only: a slot is kept when it holds a mesh (closed it shows no kids, so it must count as its own match).
    emit(row, kids, meshOnly ? q === "" && shownAtts.length > 0 : match(s.name));
  };

  for (const root of childrenOf.get(null) ?? []) showBone(root, 0, null);

  if (o.filters.constraints && !meshOnly) {
    const cons: Row[] = [];
    const push = (kind: string, c: { name: string }, target: string | undefined, badge: string) => {
      if (match(c.name) || match(kind)) cons.push({ id: `c:${kind}/${c.name}`, kind: "constraint", name: c.name, depth: 1, parent: "g:constraints", hasChildren: false, open: false, color: "", helper: false, badges: [badge], ...(target ? { target } : {}) });
    };
    for (const c of doc.ik) push("ik", c, c.bones[0], "IK");
    for (const c of doc.transform) push("transform", c, c.bones[0], "TC");
    for (const c of doc.path) push("path", c, c.bones[0], "PA");
    for (const c of doc.physics) push("physics", c, c.bone, "PH");
    if (cons.length) {
      const gid = "g:constraints";
      const open = q !== "" || isOpen(gid, "group");
      out.push({ id: gid, kind: "group", name: "Constraints", depth: 0, parent: null, hasChildren: true, open, color: "", helper: false, badges: [String(cons.length)] });
      if (open) out.push(...cons);
    }
  }

  // Skins and Draw order: counted sections after the constraints (closed until opened; a search opens them).
  if (!meshOnly) {
    const skinNames = Object.keys(doc.skins).filter((n) => match(n));
    if (skinNames.length) {
      const gid = "g:skins";
      const open = q !== "" || isOpen(gid, "group");
      out.push({ id: gid, kind: "group", name: "Skins", depth: 0, parent: null, hasChildren: true, open, color: "", helper: false, badges: [String(skinNames.length)] });
      if (open) for (const n of skinNames) out.push({ id: `k:${n}`, kind: "skin", name: n, depth: 1, parent: gid, hasChildren: false, open: false, color: "", helper: false, badges: [] });
    }
    const slotBone = new Map(doc.slots.map((s) => [s.name, s.bone] as const));
    const order = (o.drawOrder ?? [...doc.slots].map((s) => s.name).reverse()).filter((n) => slotBone.has(n) && match(n));
    if (order.length) {
      const gid = "g:draw";
      const open = q !== "" || isOpen(gid, "group");
      out.push({ id: gid, kind: "group", name: "Draw order", depth: 0, parent: null, hasChildren: true, open, color: "", helper: false, badges: [String(order.length)] });
      if (open) for (const n of order) out.push({ id: `d:${n}`, kind: "draw", name: n, slot: n, bone: slotBone.get(n)!, depth: 1, parent: gid, hasChildren: false, open: false, color: "", helper: false, badges: [] });
    }
    // Events: the rig's event definitions (always shown, so the first one can be added from its page).
    if (doc.events) {
      const evNames = Object.keys(doc.events).filter((n) => match(n));
      if (evNames.length || q === "") {
        const gid = "g:events";
        const open = q !== "" || isOpen(gid, "group");
        out.push({ id: gid, kind: "group", name: "Events", depth: 0, parent: null, hasChildren: true, open, color: "", helper: false, badges: [String(evNames.length)] });
        if (open) for (const n of evNames) out.push({ id: `e:${n}`, kind: "event", name: n, depth: 1, parent: gid, hasChildren: false, open: false, color: "", helper: false, badges: [] });
      }
    }
  }
  return out;
}

/** The ids of every row that has children, whatever its open state (for expand all / collapse all). */
export function foldableIds(doc: Parameters<typeof buildRows>[0]): { id: string; kind: RowKind }[] {
  const all = buildRows(doc, { filters: ALL_FILTERS, toggled: new Set(), search: "" });
  const out: { id: string; kind: RowKind }[] = [];
  const visit = (rows: Row[]) => rows.filter((r) => r.hasChildren).forEach((r) => out.push({ id: r.id, kind: r.kind }));
  visit(all);
  // Closed slots hide their attachments from the default build: add them from the document.
  for (const s of doc.slots) {
    const atts = slotAttachments(doc, s.name);
    if (atts.length && !out.some((o) => o.id === rowIdSlot(s.name))) out.push({ id: rowIdSlot(s.name), kind: "slot" });
    // A weighted mesh folds open to its weight bones.
    for (const a of atts) if (meshOf(doc, s.name, a)?.weightBones.length && !out.some((o) => o.id === rowIdAtt(s.name, a))) out.push({ id: rowIdAtt(s.name, a), kind: "attachment" });
  }
  return out;
}

/** The toggled-ids list that makes every foldable row open (`true`) or closed (`false`). */
export function toggledFor(doc: Parameters<typeof buildRows>[0], open: boolean): string[] {
  return foldableIds(doc)
    .filter((f) => (CLOSED_GROUPS.has(f.id) ? false : defaultOpen(f.kind)) !== open)
    .map((f) => f.id);
}

/** The id of the next / previous row, clamped. */
export function stepRow(rows: readonly Row[], from: string | null, dir: 1 | -1): string | null {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.id === from);
  if (i < 0) return rows[dir > 0 ? 0 : rows.length - 1]!.id;
  return rows[Math.min(rows.length - 1, Math.max(0, i + dir))]!.id;
}

/** Left arrow: closes an open row, else moves to the parent. Right arrow: opens a closed row, else moves to its first child. */
export function arrowTarget(rows: readonly Row[], id: string, key: "left" | "right"): { toggle: boolean; to: string | null } {
  const i = rows.findIndex((r) => r.id === id);
  const row = rows[i];
  if (!row) return { toggle: false, to: null };
  if (key === "left") {
    if (row.hasChildren && row.open) return { toggle: true, to: id };
    return { toggle: false, to: row.parent && rows.some((r) => r.id === row.parent) ? row.parent : id };
  }
  if (row.hasChildren && !row.open) return { toggle: true, to: id };
  const next = rows[i + 1];
  return { toggle: false, to: next && next.parent === id ? next.id : id };
}

// ---------------------------------------------------------------------------------------------
// Selection history (the back and forward buttons)
// ---------------------------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
}

export class SelectionHistory {
  private list: string[] = [];
  private at = -1;

  push(id: string): void {
    if (this.list[this.at] === id) return;
    this.list.length = this.at + 1;
    this.list.push(id);
    if (this.list.length > 100) this.list.shift();
    this.at = this.list.length - 1;
  }

  canBack(): boolean {
    return this.at > 0;
  }

  canForward(): boolean {
    return this.at >= 0 && this.at < this.list.length - 1;
  }

  /** Moves and returns the id to select, skipping ids `exists` says are gone. */
  move(dir: 1 | -1, exists: (id: string) => boolean): string | null {
    let i = this.at + dir;
    while (i >= 0 && i < this.list.length && !exists(this.list[i]!)) i += dir;
    if (i < 0 || i >= this.list.length) return null;
    this.at = i;
    return this.list[i]!;
  }
}

// ---------------------------------------------------------------------------------------------
// Inherit checkboxes <-> engine inherit modes
// ---------------------------------------------------------------------------------------------

export type InheritName = "normal" | "onlyTranslation" | "noRotation" | "noScale" | "noScaleOrReflection";
export interface InheritFlags {
  rotation: boolean;
  scale: boolean;
  reflection: boolean;
}

/** Spine's three checkboxes for each engine mode (bone.ts): noRotation also drops the parent's reflection; noScale keeps it. */
export const INHERIT_FLAGS: Record<InheritName, InheritFlags> = {
  normal: { rotation: true, scale: true, reflection: true },
  noRotation: { rotation: false, scale: true, reflection: false },
  noScale: { rotation: true, scale: false, reflection: true },
  noScaleOrReflection: { rotation: true, scale: false, reflection: false },
  onlyTranslation: { rotation: false, scale: false, reflection: false }
};

export const flagsOf = (mode: string): InheritFlags => INHERIT_FLAGS[mode as InheritName] ?? INHERIT_FLAGS.normal;

/** The engine mode that has exactly these flags, or null when the engine has none (e.g. scale on but reflection off). */
export function modeFor(f: InheritFlags): InheritName | null {
  for (const [mode, flags] of Object.entries(INHERIT_FLAGS)) if (flags.rotation === f.rotation && flags.scale === f.scale && flags.reflection === f.reflection) return mode as InheritName;
  return null;
}

export interface InheritToggle {
  /** The flag's current value. */
  checked: boolean;
  /** The mode a click sets, or null when the engine lacks it (the checkbox shows disabled). */
  next: InheritName | null;
  /** Why it is disabled, when it is. */
  reason: string;
}

const FLAG_LABEL: Record<keyof InheritFlags, string> = { rotation: "Inherit Rotation", scale: "Inherit Scale", reflection: "Inherit Reflection" };

export function inheritToggle(mode: string, flag: keyof InheritFlags): InheritToggle {
  const now = flagsOf(mode);
  const target = { ...now, [flag]: !now[flag] };
  const next = modeFor(target);
  const on = (v: boolean) => (v ? "on" : "off");
  return {
    checked: now[flag],
    next,
    reason: next ? "" : `The engine has no inherit mode with ${FLAG_LABEL.rotation} ${on(target.rotation)}, ${FLAG_LABEL.scale} ${on(target.scale)}, ${FLAG_LABEL.reflection} ${on(target.reflection)}; change another flag first`
  };
}

// ---------------------------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------------------------

const objs = (v: unknown): JsonObject[] => (Array.isArray(v) ? (v as JsonObject[]) : []);

/**
 * Splits `name` in two at `fraction` (0..1) of its length: the bone keeps its start and gets shorter, a new bone (a child of it,
 * `<name>2` style) takes the rest, and the bone's children move onto the new bone with their local x reduced so nothing moves.
 * Slots stay on the first bone.
 */
export function planSplitBone(raw: JsonObject, name: string, fraction: number, newName?: string): BonePlan {
  const bones = objs(raw["bones"]);
  const bone = bones.find((b) => b["name"] === name) ?? fail(`no bone '${name}'`);
  const length = Number(bone["length"] ?? 0);
  if (!(length > 0)) fail(`'${name}' has no length to split`);
  if (!(fraction > 0.02 && fraction < 0.98)) fail("split between 2% and 98% of the bone");
  const cut = Math.round(length * fraction * 1e4) / 1e4;
  const rest = Math.round((length - cut) * 1e4) / 1e4;
  const created = uniqueName(boneNames(raw), newName ?? name);
  const kids = bones.filter((b) => b["parent"] === name);
  const add: Command = {
    op: "bone.add",
    name: created,
    parent: name,
    x: cut,
    y: 0,
    rotation: 0,
    length: rest,
    ...(typeof bone["role"] === "string" ? { role: bone["role"] } : {}),
    ...(typeof bone["color"] === "string" ? { color: bone["color"] } : {}),
    ...(bone["helper"] === true ? { helper: true } : {})
  };
  const commands: Command[] = [{ op: "bone.set", name, length: cut }, add];
  for (const k of kids) {
    commands.push({ op: "bone.parent", name: String(k["name"]), parent: created });
    commands.push({ op: "bone.set", name: String(k["name"]), x: Math.round((Number(k["x"] ?? 0) - cut) * 1e4) / 1e4 });
  }
  return { commands, bone: created };
}

/** A child-bone plan from the parent's world tip, `len` long, continuing the parent's direction (skeleton space). */
export function planChildBone(raw: JsonObject, parent: string, parentWorld: { x: number; y: number; angleDeg: number; length: number }, len = 40): BonePlan {
  const a = (parentWorld.angleDeg * Math.PI) / 180;
  const from: [number, number] = [parentWorld.x + Math.cos(a) * parentWorld.length, parentWorld.y + Math.sin(a) * parentWorld.length];
  const to: [number, number] = [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
  const origin = objOrigin(raw);
  const name = uniqueName(boneNames(raw), "bone");
  return {
    commands: [{ op: "bone.add", name, parent, world: [round4(from[0] + origin.x), round4(from[1] + origin.y)], tip: [round4(to[0] + origin.x), round4(to[1] + origin.y)] }],
    bone: name
  };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
function objOrigin(raw: JsonObject): { x: number; y: number } {
  const c = (raw["canvas"] ?? {}) as JsonObject;
  return { x: Number(c["originX"] ?? 0), y: Number(c["originY"] ?? 0) };
}
