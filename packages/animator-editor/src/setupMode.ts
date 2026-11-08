/*
 * Atlas Animator editor: Setup mode (standard rig building).
 *
 * Animate mode keys clips on a fixed rig; Setup mode edits the rig: create, re-parent, rename, delete
 * and transform bones, attach and place images, view and edit IK / transform constraints, bone
 * colour and helper flag. Every edit is a batch of the animator's commands planned in
 * setupModel / setupAttach / setupConstraints, run against the rig's raw document, kept on an undo
 * stack with its inverse patch, and saved through the rig's command log (rigSave.ts).
 *
 * This module owns the Setup UI and state; main.ts hands it a SetupHost (the shown rig, the skeleton,
 * the clip library, a way to rebuild the rig from a changed document) and forwards the viewport
 * pointer events, keys and overlay drawing while Setup mode is on.
 */
import { setCoverMemo } from "@atlas-animator/core/core";
import type { Skeleton, Bone, ClipData, AnimDocument } from "@atlas-animator/core/core";
import { loadRgbaImage, type RgbaImage } from "@atlas-animator/core/pixi";
import type { Graphics } from "pixi.js";
import { applyOps, boneNames, describeBatch, objOf, fixClips, planAddBone, planBoneProps, planDeleteBone, planRename, planReparent, planSetupTransform, runBatch, SetupError, type Command, type SetupTransform, type JsonObject, type JsonValue } from "./setupModel.js";
import { autoBind, type BindBone, type BindSlot } from "./autoBind.js";
import { imagesSelectable } from "./canvasTools.js";
import { getHost, type NodeSel } from "./host.js";
import { downloadJson, rigConflictDialog } from "./persistUi.js";
import { beginSculpt } from "./correctiveModel.js";
import { freshArtName, planRelink, previewRelink, type RelinkMode } from "./relinkModel.js";
import { polyFlags, POLY_COLOR } from "./polyOverlay.js";
import { pathPoints, planAddPath, planInsertPathPoint, planMovePathVertex, planPathConstraintSet, planRemovePathPoint, planSetPathFlags } from "./pathModel.js";
import { planAddPolygon, planInsertVertex, planMoveVertex, planRemoveVertex, parseSequenceFrames, planImportSequence, planSequenceFromPaths, planSetClipEnd, planSetSequence, POLYGON_LABEL, type PolygonKind, type SequenceFields } from "./polyAttach.js";
import { planLinkMesh, planSetInherit, planUnlinkMesh, type AttAddress } from "./meshLink.js";
import { defaultRegion, groupRegions, isVariantPath, planAddPoint, planAttachImage, planAttachmentTransform, planDefaultAttachment, planRemoveAttachment, type AtlasRegion } from "./setupAttach.js";
import { ikConstraints, planAddTwoBoneIk, planConstraintSet, planRemoveConstraint, TRANSFORM_MIXES, TRANSFORM_OFFSETS, transformConstraints, type ConstraintKind } from "./setupConstraints.js";
import { fieldText, revertButton, type RigUi } from "./setupRigUi.js";
import { eventsPage } from "./eventsPage.js";
import { contractSection } from "./rigContractCard.js";
import { declaredEvents } from "./eventRigPlans.js";
import { EVENT_NAMES } from "./eventModel.js";
import { attachmentPage, bonePage, constraintPage, section, setSectionOpen, skinPage, slotPage, type Page, type PageCtx } from "./inspector.js";
import { installImagesDock, openImagesDock, refreshImagesDock, type AttachState, type DockCtx } from "./imagesDock.js";
import { deleteBonesConfirmed, outlinerHiddenBones, outlinerLocked } from "./outliner.js";
import { chainBonePlans } from "./setupRigPlans.js";
import type { PatchOperation } from "@atlas-animator/core/patch";
import { confirmDialog } from "./dialog.js";
import { announceTools } from "./toolPalette.js";
import { drawRotateRef, getSpace, onSpace } from "./canvasTools.js";
import { axisFrame, type Space } from "./transformModel.js";
import { angleStep, drawHandles, handleAt, handleFrame, pointerAngleAbout, scaleAt, scaleStart, shearValue, type HandleAxis, type ScaleStart } from "./gizmoHandles.js";

export interface SetupRig {
  outfitId: string;
  label: string;
  /** Repo-relative rig document and atlas manifest. */
  document: string;
  atlas: string;
  /** Rig name (page files are `<name>.imp-*.png`). */
  name: string;
  /** The raw rig document (what the file holds). */
  raw: JsonObject;
  regions: AtlasRegion[];
  /** The decoded pixels of an atlas texture path (the Images dock cuts its thumbnails from them). */
  image?: DockCtx["image"];
  /** The skin new attachments go into. */
  skin: string;
  /** The in-memory stand-in weapon rig: Setup mode is refused (its document is not the file). */
  standIn: boolean;
}

export interface SetupHost {
  rig(): SetupRig | null;
  skeleton(): Skeleton | null;
  library(): ReadonlyMap<string, ClipData>;
  /** Rebuilds the shown rig (skeleton, character) from a changed raw document. */
  replaceRig(raw: JsonObject, parsed?: AnimDocument): Promise<void>;
  /** The editor's clips changed with the rig (renamed or dropped timelines): store them, drop clip undo history. */
  clipsChanged(changed: Map<string, ClipData>): void;
  /** Registers a pixel image under a texture path (an imported PNG). */
  addImage(path: string, image: RgbaImage): void;
  selected(): string | null;
  select(name: string | null): void;
  zoom(): number;
  /** Pointer or wheel event to skeleton space. */
  toSkeleton(e: { clientX: number; clientY: number }): { x: number; y: number; sx: number; sy: number };
  /** Skeleton space to client (page) pixels. */
  toClient(x: number, y: number): { x: number; y: number };
  redraw(): void;
  repose(): void;
  status(text: string, kind?: "" | "bad" | "ok"): void;
  renderBones(): void;
  stopPlayback(): void;
  /** The editor's own bone drawing (coloured wedges), so Setup shows the same bones as Animate. */
  drawBones?(px: number, hideHelpers: boolean): void;
  /** "Reload theirs" after a stale Save rig: keep a recovery autosave of everything unsaved, then reload the page. */
  reloadRig?(): void;
}

export type Tool = "select" | "rotate" | "move" | "scale" | "shear" | "length" | "bone" | "transform" | "attachment" | "mesh" | "weights" | "sculpt";
/** Ids a module can register a Setup sub-tool for. */
export type SetupSubToolId = "mesh" | "weights" | "sculpt";

/** What a registered Setup sub-tool is handed: the editor's seams, so a tool module never imports main.ts or this file's internals. */
export interface SetupToolContext {
  /** The shown rig, skeleton, clips and viewport (see SetupHost). */
  readonly host: SetupHost;
  /** Runs one undoable, saved rig edit (the same path every Setup edit takes). */
  run(label: string, make: (raw: JsonObject) => { commands: Command[]; bone?: string | null }): Promise<boolean>;
  /** The slot selected in the panel, or null. */
  slot(): string | null;
  /** Hides / shows a slot's art on the canvas (a live preview overlay replaces it). */
  setSlotHidden(slot: string, hidden: boolean): void;
  /** Re-renders the side panel (after the tool's own state changed). */
  renderPanel(): void;
  redraw(): void;
  /** Leaves the tool (back to Select). */
  exit(): void;
  /** Poses `bone` at `deg` degrees from its setup rotation (a look-only preview; null clears it). */
  previewAngle(bone: string | null, deg: number): void;
}

type ToolPoint = { x: number; y: number; sx: number; sy: number };

/** One Setup tool a later module adds (Mesh, Weights). Every hook is optional; a pointer hook returns true when it used the event. */
export interface SetupSubTool {
  id: SetupSubToolId;
  label: string;
  /** Setup-mode hotkey (one letter). */
  key: string;
  hint: string;
  /** The tool became / stopped being the current Setup tool. */
  activate?(ctx: SetupToolContext): void;
  deactivate?(ctx: SetupToolContext): void;
  /** `p` is in skeleton space (sx, sy are screen pixels). */
  pointerDown?(p: ToolPoint, e: { shiftKey: boolean; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, ctx: SetupToolContext): boolean | void;
  pointerMove?(p: ToolPoint, ctx: SetupToolContext): boolean | void;
  pointerUp?(ctx: SetupToolContext): boolean | void;
  /** Draws on the bone overlay (skeleton space; `px` is one screen pixel in it). */
  drawOverlay?(g: Graphics, px: number, ctx: SetupToolContext): void;
  /** Fills the side panel (above the bone section) with the tool's controls. */
  panel?(box: HTMLElement, ctx: SetupToolContext): void;
  /** A key press while the tool is current (after Ctrl+Z / S / Esc, which Setup keeps). Return true when handled. */
  onKey?(e: KeyboardEvent, ctx: SetupToolContext): boolean | void;
}

const subTools = new Map<SetupSubToolId, SetupSubTool>();
const subToolListeners = new Set<() => void>();

/** Registers (or replaces) the Setup sub-tool for `tool.id`. The returned function removes it again. */
export function registerSetupSubTool(tool: SetupSubTool): () => void {
  subTools.set(tool.id, tool);
  for (const fn of [...subToolListeners]) fn();
  return () => {
    if (subTools.get(tool.id) === tool) subTools.delete(tool.id);
    for (const fn of [...subToolListeners]) fn();
  };
}

export function getSetupSubTool(id: string): SetupSubTool | undefined {
  return subTools.get(id as SetupSubToolId);
}

export const COMING_TEXT = "Coming in the next update.";
/** The placeholder panel; the real tool replaces it by registering the same id. */
function comingSoon(id: SetupSubToolId, label: string, key: string, hint: string): SetupSubTool {
  return {
    id,
    label,
    key,
    hint,
    panel(box) {
      const h = document.createElement("h2");
      h.textContent = label;
      const note = document.createElement("div");
      note.className = "note";
      note.id = `setup-coming-${id}`;
      note.textContent = `${label} editing: ${COMING_TEXT}`;
      box.append(h, note);
    }
  };
}
registerSetupSubTool(comingSoon("mesh", "Mesh", "M", "Edit the selected slot's mesh: points, edges, UVs and the outline."));
registerSetupSubTool(comingSoon("weights", "Weights", "W", "Paint which bones move each mesh vertex."));

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Click a bone to select it. With a bone selected: drag its origin dot to move it, the square at its tip to change its length, or the ring to rotate it. Select a bone, press Parent, then click its new parent." },
  { id: "rotate", label: "Rotate", key: "R", hint: "Drag anywhere to turn the selected bone about its origin (setup rotation). Click another bone to select it." },
  { id: "move", label: "Move", key: "T", hint: "Drag the selected bone's body or origin to move it (setup position); the red arm moves it along X, the green arm along Y of the Axes chosen in the bar above (Local, Parent or World)." },
  { id: "scale", label: "Scale", key: "S", hint: "Drag a square handle to squash or stretch the selected bone's setup scale (red = X, green = Y, centre = both); the handles lie along the Axes chosen in the bar above. Children and images follow." },
  { id: "shear", label: "Shear", key: "", hint: "Drag a round handle to skew the selected bone's setup shear (red = X, green = Y); the handles lie along the Axes chosen in the bar above. Children and images follow." },
  { id: "length", label: "Length", key: "L", hint: "Drag the square at the selected bone's tip to change its length." },
  { id: "bone", label: "Draw bone", key: "B", hint: "Click-drag in the view: a new bone from the click to the release. Press on an existing bone to make it the parent, otherwise the selected bone is (Shift starts at the parent's tip; Alt-click picks a bone)." },
  { id: "attachment", label: "Image", key: "A", hint: "Drag the selected slot's image to move it, the top handle to rotate it, the corner handle to scale it." }
];

interface Entry {
  label: string;
  commands: Command[];
  inverse: PatchOperation[];
  patch: PatchOperation[];
  before: Map<string, ClipData>;
  after: Map<string, ClipData>;
}

interface ImportedImage {
  file: string;
  path: string;
  png: string;
}

/** Everything Setup mode remembers per rig document. */
interface Session {
  done: Entry[];
  undone: Entry[];
  /** The batches the file already has (same arrays as in `done`, by reference). */
  saved: Command[][];
  /** Hash of the rig file text the editor last saw; null until fetched. */
  base: string | null;
  imported: Map<string, ImportedImage>;
}

type Drag =
  | { kind: "new"; parent: string | null; from: [number, number]; to: [number, number] }
  | { kind: "move"; bone: string; grab: [number, number]; x: number; y: number; axis?: "x" | "y"; space: Space; w0: [number, number]; others?: MoveMate[] }
  | { kind: "rotate"; bone: string; start: number; last: number; accum: number; sign: number; rotation: number; ik?: IkRotate; others?: RotateMate[] }
  | { kind: "length"; bone: string; length: number; len0: number; others?: LengthMate[] }
  | { kind: "scale"; bone: string; axis: HandleAxis; start: { x: number; y: number }; ss: ScaleStart; scaleX: number; scaleY: number }
  | { kind: "shear"; bone: string; axis: HandleAxis; start: { x: number; y: number }; last: number; accum: number; sign: number; shearX: number; shearY: number }
  | { kind: "box"; from: [number, number]; to: [number, number]; add: boolean }
  | { kind: "att-move"; grab: [number, number]; x: number; y: number }
  | { kind: "att-rotate"; ang0: number; rot0: number; rotation: number }
  | { kind: "poly-vertex"; slot: string; name: string; index: number; x: number; y: number }
  | { kind: "path-vertex"; slot: string; name: string; index: number; x: number; y: number }
  | { kind: "att-scale"; d0: number; s0: [number, number]; scaleX: number; scaleY: number };

/** The other selected bones that move, turn or stretch with the dragged one (one undo step for the lot). */
interface MoveMate { name: string; w0: [number, number]; x: number; y: number }
interface RotateMate { name: string; start: number; sign: number; rotation: number }
interface LengthMate { name: string; len0: number; length: number }

/** An IK-driven bone being turned: its constraint's target swings about the bone's origin so the solved chain follows (target local x, y kept in `x`, `y`). */
interface IkRotate {
  ik: string;
  target: string;
  pivot: [number, number];
  tip: [number, number];
  x: number;
  y: number;
}

const RING = 70;
/** Scale / Shear handle distance and grab radius, screen px (the Animate gizmo's). */
const HANDLE_PX = 64;
const HANDLE_GRAB_PX = 18;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "style") node.setAttribute("style", String(v));
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const msg = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isObj = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObj) as JsonObject[]) : []);
const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const colorHex = (rgba: string | undefined): number | null => (rgba ? parseInt(rgba.slice(0, 6), 16) : null);

export function createSetup(host: SetupHost) {
  let on = false;
  let tool: Tool = "select";
  const ctx: SetupToolContext = {
    host,
    run: (label, make) => run(label, make),
    slot: () => slotSel,
    setSlotHidden: (slot, hidden) => getHost()?.setSlotHidden(slot, hidden),
    renderPanel: () => renderPanel(),
    redraw: () => host.redraw(),
    exit: () => setTool("select"),
    previewAngle: (bone, deg) => setPreviewAngle(bone, deg)
  };
  const isSub = (t: Tool): t is SetupSubToolId => t === "mesh" || t === "weights" || t === "sculpt";
  const activeSub = (): SetupSubTool | undefined => (isSub(tool) ? subTools.get(tool) : undefined);
  /** The driver angle the Correctives card scrubs: shown on the posed skeleton in Setup, never written into the rig. */
  let preview: { bone: string; deg: number } | null = null;
  function setPreviewAngle(bone: string | null, deg: number): void {
    preview = bone ? { bone, deg } : null;
    host.repose();
  }
  subToolListeners.add(() => {
    if (on && isSub(tool)) {
      renderHud();
      renderBoneHint();
      renderPanel();
      host.redraw();
    }
  });
  let keepImages = false;
  /** Children stay put when a bone moves (Compensate > Bones in Setup); the legacy keep-images box sets both. */
  let keepBones = false;
  let hideHelpers = false;
  let slotSel: string | null = null;
  let attSel: string | null = null;
  let drag: Drag | null = null;
  let busy = false;
  /** The node the Rig inspector shows (the Tree picks it; selecting a bone returns to the bone page). */
  let node: NodeSel = { kind: "bone" };
  let keepNode = false;
  const attachState: AttachState = { filter: "", pick: "", asNew: false, makeDefault: true, showVariants: false };
  let restOpen = false;
  const sessions = new Map<string, Session>();

  const rigNow = (): SetupRig => host.rig() ?? (() => { throw new SetupError("no rig is open"); })();
  const session = (): Session => {
    const id = rigNow().outfitId;
    let s = sessions.get(id);
    if (!s) {
      s = { done: [], undone: [], saved: [], base: null, imported: new Map() };
      sessions.set(id, s);
    }
    return s;
  };

  // -------------------------------------------------------------------------------------------
  // Running edits
  // -------------------------------------------------------------------------------------------

  /** Plans, validates and applies one undoable batch; returns false (with the reason in the status line) on refusal. */
  async function run(label: string, make: (raw: JsonObject) => { commands: Command[]; bone?: string | null; clip?: (clip: ClipData) => ClipData | null }): Promise<boolean> {
    if (busy) return false;
    const rig = host.rig();
    if (!rig) return false;
    if (rig.standIn) {
      host.status("Setup mode edits the rig file; this fixture adds an in-memory weapon, so open another view", "bad");
      return false;
    }
    busy = true;
    try {
      const t0 = performance.now();
      const plan = make(rig.raw);
      if (!plan.commands.length) return false;
      const result = runBatch(rig.raw, plan.commands);
      performance.measure("setup.commands", { start: t0, end: performance.now() });
      const library = host.library();
      const changed = fixClips(library, plan.commands, rig.raw, result.doc);
      if (plan.clip) for (const [name, clip] of library) {
        const next = plan.clip(changed.get(name) ?? clip);
        if (next) changed.set(name, next);
      }
      const before = new Map([...changed.keys()].map((k) => [k, library.get(k)!]));
      const s = session();
      s.done.push({ label, commands: plan.commands, inverse: result.inverse, patch: result.patch, before, after: changed });
      s.undone.length = 0;
      if (changed.size) host.clipsChanged(new Map(changed));
      const t1 = performance.now();
      await host.replaceRig(result.doc, result.parsed);
      performance.measure("setup.replaceRig", { start: t1, end: performance.now() });
      const names = boneNames(result.doc);
      const pick = plan.bone === undefined ? host.selected() : plan.bone;
      // A command's own re-selection keeps the inspector on its node (only a user pick returns to the bone page).
      keepNode = true;
      try {
        host.select(pick && names.includes(pick) ? pick : host.selected() && names.includes(host.selected()!) ? host.selected() : null);
      } finally {
        keepNode = false;
      }
      host.status(label, "ok");
      const ops = describeBatch(plan.commands);
      if (ops) document.getElementById("status")?.setAttribute("title", `${label} (engine: ${ops})`);
      renderAll();
      return true;
    } catch (error) {
      host.status(error instanceof SetupError ? msg(error) : `Setup edit failed: ${msg(error)}`, "bad");
      return false;
    } finally {
      busy = false;
    }
  }

  async function step(direction: "undo" | "redo"): Promise<void> {
    if (busy) return;
    const rig = host.rig();
    if (!rig) return;
    const s = session();
    const entry = direction === "undo" ? s.done.pop() : s.undone.pop();
    if (!entry) {
      host.status(`Nothing to ${direction}`);
      return;
    }
    busy = true;
    try {
      const raw = applyOps(rig.raw, direction === "undo" ? entry.inverse : entry.patch);
      const clips = direction === "undo" ? entry.before : entry.after;
      if (clips.size) host.clipsChanged(new Map(clips));
      (direction === "undo" ? s.undone : s.done).push(entry);
      await host.replaceRig(raw);
      const sel = host.selected();
      if (sel && !boneNames(raw).includes(sel)) host.select(null);
      host.status(`${direction === "undo" ? "Undid" : "Redid"}: ${entry.label}`);
      renderAll();
    } catch (error) {
      host.status(`${direction} failed: ${msg(error)}`, "bad");
    } finally {
      busy = false;
    }
  }

  async function ensureBase(): Promise<void> {
    const rig = host.rig();
    if (!rig || rig.standIn) return;
    const s = session();
    if (s.base !== null) return;
    try {
      const r = await fetch(`/api/rig/hash?file=${encodeURIComponent(rig.document)}`);
      const body = (await r.json()) as { hash?: string };
      if (body.hash) s.base = body.hash;
    } catch {
      /* the server is only needed to save */
    }
  }

  async function save(): Promise<boolean> {
    const rig = host.rig();
    if (!rig) return false;
    await ensureBase();
    const s = session();
    const active = s.done.map((e) => e.commands);
    let common = 0;
    while (common < s.saved.length && common < active.length && s.saved[common] === active[common]) common++;
    const undo = s.saved.length - common;
    const batches = active.slice(common);
    const used = new Set<string>();
    for (const skin of Object.values(isObj(rig.raw["skins"]) ? rig.raw["skins"] : {})) {
      for (const slot of Object.values(isObj(skin) && isObj(skin["attachments"]) ? skin["attachments"] : {})) {
        for (const att of Object.values(isObj(slot) ? slot : {})) if (isObj(att) && typeof att["path"] === "string") used.add(att["path"]);
      }
    }
    const images = [...s.imported.values()].filter((i) => used.has(i.path));
    if (!undo && !batches.length && !images.length) {
      host.status("Nothing to save: the rig file already has these edits");
      return true;
    }
    try {
      const res = await fetch("/api/rig/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rig.document, atlas: rig.atlas, base: s.base, undo, batches, images }) });
      const body = (await res.json()) as { hash?: string; applied?: number; error?: string };
      if (res.status === 409) {
        // A stale rig (): the choices act on this tab's unsaved Setup edits, which stay here until one of them succeeds.
        const name = rig.document.split("/").pop() ?? rig.document;
        const choice = await rigConflictDialog(name, body.error ?? "the rig file changed on disk");
        if (choice === "download") {
          downloadJson(`${name.replace(/\.anim\.json$/, "")}.recovery.json`, { format: "atlas-rig-recovery@1", document: rig.document, savedAt: new Date().toISOString(), base: s.base, undo, batches, images, skins: rig.raw["skins"] ?? null });
          host.status(`Downloaded your ${batches.length} unsaved Setup edit${batches.length === 1 ? "" : "s"} as a recovery file; they are still unsaved here`, "ok");
          return false;
        }
        if (choice === "overwrite") {
          // Apply mine on top of theirs: the batches run as commands against the newer file (refused as a whole when they no longer fit).
          s.base = null;
          return save();
        }
        if (choice === "reload") {
          host.reloadRig?.();
          return false;
        }
        host.status(`Not saved: ${body.error ?? "the rig file changed on disk"}. Your Setup edits are still here`, "bad");
        return false;
      }
      if (!res.ok || !body.hash) {
        host.status(`Save failed: ${body.error ?? res.status}. Nothing was written; your Setup edits are still here`, "bad");
        return false;
      }
      s.base = body.hash;
      s.saved = active;
      for (const i of images) s.imported.delete(i.path);
      host.status(`Saved ${batches.length} edit${batches.length === 1 ? "" : "s"}${undo ? ` (undid ${undo} saved)` : ""}${images.length ? `, ${images.length} image${images.length === 1 ? "" : "s"}` : ""} to ${rig.document.split("/").pop()}`, "ok");
      renderAll();
      return true;
    } catch (error) {
      host.status(`Save failed: ${msg(error)}`, "bad");
      return false;
    }
  }

  const unsaved = (): number => {
    const s = sessions.get(host.rig()?.outfitId ?? "");
    if (!s) return 0;
    const active = s.done.map((e) => e.commands);
    let common = 0;
    while (common < s.saved.length && common < active.length && s.saved[common] === active[common]) common++;
    return s.saved.length - common + active.length - common;
  };

  // -------------------------------------------------------------------------------------------
  // Bone and image operations (used by the UI and by window.atlasEditor)
  // -------------------------------------------------------------------------------------------

  const addBone = (o: { parent?: string | null; from: [number, number]; to: [number, number]; name?: string }) =>
    run("Add bone", (raw) => planAddBone(raw, { parent: o.parent === undefined ? defaultParent(raw) : o.parent, from: o.from, to: o.to, ...(o.name ? { name: o.name } : {}) }));
  const deleteBone = (name: string) => run(`Delete bone ${name}`, (raw) => planDeleteBone(raw, name));
  const reparent = (name: string, parent: string | null, keepWorld = true) => run(`Re-parent ${name}`, (raw) => planReparent(raw, name, parent, keepWorld));
  const renameBone = (name: string, to: string) => run(`Rename ${name}`, (raw) => planRename(raw, name, to));
  const transformBone = (name: string, t: SetupTransform, keep?: boolean) => run(`Transform ${name}`, (raw) => planSetupTransform(raw, name, t, keep === undefined ? { bones: keepBones, images: keepImages } : keep));
  /** The active IK constraint (mix > 0) whose chain contains `name`, from the rig document. */
  const ikDriving = (name: string) => {
    const raw = host.rig()?.raw;
    return raw ? ikConstraints(raw).find((c) => c.mix > 1e-6 && c.bones.includes(name)) : undefined;
  };
  /** Turns an IK-driven bone and moves its constraint's target to where the turned chain puts the foot: one undo step. */
  const transformIkBone = (name: string, rotation: number, ik: IkRotate) =>
    run(`Rotate ${name} (IK)`, (raw) => {
      const a = planSetupTransform(raw, name, { rotation }, false);
      const b = planSetupTransform(raw, ik.target, { x: ik.x, y: ik.y }, false);
      return { commands: [...a.commands, ...b.commands], bone: name };
    });
  /** Several selected bones transformed by one drag: one command batch, so one undo step. */
  const transformBones = (verb: string, entries: { name: string; t: { x?: number; y?: number; rotation?: number; length?: number } }[]) =>
    run(`${verb} ${entries.length} bones`, (raw) => chainBonePlans(raw, entries.map((e) => e.name), (cur, n) => planSetupTransform(cur, n, entries.find((e) => e.name === n)!.t, { bones: keepBones, images: keepImages })));
  /** Box select: the bones whose origin, middle or tip is inside the rectangle (locked and hidden bones are skipped). */
  function boxSelect(d: Extract<Drag, { kind: "box" }>): void {
    const sk = host.skeleton();
    if (!sk) return;
    if (Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) * host.zoom() < 5) return;
    const [x0, x1] = [Math.min(d.from[0], d.to[0]), Math.max(d.from[0], d.to[0])];
    const [y0, y1] = [Math.min(d.from[1], d.to[1]), Math.max(d.from[1], d.to[1])];
    const hidden = outlinerHiddenBones();
    const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const names = sk.bones
      .filter((b) => b.data.name !== "root" && !(hideHelpers && b.data.helper) && !outlinerLocked(b.data.name) && !hidden.has(b.data.name))
      .filter((b) => {
        const t = tipOf(b);
        return inside(b.world.x, b.world.y) || inside(t.x, t.y) || inside((b.world.x + t.x) / 2, (b.world.y + t.y) / 2);
      })
      .map((b) => b.data.name);
    if (!names.length) return void host.status("No bones inside the box");
    getHost()?.selectBones(names, d.add ? "add" : "replace", names[0]);
    host.status(`${names.length} bone${names.length === 1 ? "" : "s"} selected: drag Rotate or Move to change them together (one undo step)`, "ok");
  }
  const boneProps = (name: string, p: { color?: string | null; helper?: boolean | null }) => run(`Bone ${name}`, (raw) => planBoneProps(raw, name, p));
  const setDefault = (slot: string, name: string | null) => run(`Default image of ${slot}`, (raw) => ({ commands: planDefaultAttachment(raw, slot, name) }));
  const setConstraint = (kind: ConstraintKind, name: string, fields: Record<string, unknown>) => run(`${kind === "ik" ? "IK" : kind === "transform" ? "Transform" : kind === "path" ? "Path" : "Physics"} ${name}`, (raw) => ({ commands: kind === "path" ? planPathConstraintSet(raw, name, fields) : planConstraintSet(raw, kind, name, fields) }));
  const removeConstraint = (kind: ConstraintKind, name: string) => run(`Remove ${name}`, (raw) => ({ commands: planRemoveConstraint(raw, kind, name) }));
  const addIk = (lower: string, o: { name?: string; target?: string } = {}) =>
    run(`Add 2-bone IK on ${lower}`, (raw) => {
      const plan = planAddTwoBoneIk(raw, lower, o);
      return { commands: plan.commands, bone: lower };
    });
  /** Plans moving a slot to another bone with every region image of the slot staying where it is on screen. */
  const planRebind = (raw: JsonObject, slot: string, to: string): { commands: Command[] } => {
    const sk = host.skeleton();
    const rig = host.rig();
    const nb = sk?.findBone(to);
    const s = list(raw["slots"]).find((x) => x["name"] === slot);
    const ob = sk?.findBone(String(s?.["bone"]));
    if (!sk || !rig || !nb || !ob || !s) throw new SetupError(`cannot move slot '${slot}' to '${to}'`);
    const skin = isObj(raw["skins"]) && isObj(raw["skins"][rig.skin]) ? (raw["skins"][rig.skin] as JsonObject) : {};
    const atts = isObj(skin["attachments"]) && isObj(skin["attachments"][slot]) ? (skin["attachments"][slot] as JsonObject) : {};
    const commands: Command[] = [{ op: "slot.set", name: slot, bone: to }];
    for (const [name, a] of Object.entries(atts)) {
      if (!isObj(a) || a["type"] !== "region") continue;
      const w = ob.localToWorld(Number(a["x"] ?? 0), Number(a["y"] ?? 0), { x: 0, y: 0 });
      const l = { x: 0, y: 0 };
      nb.worldToLocal(w.x, w.y, l);
      const rotation = Number(a["rotation"] ?? 0) + ob.worldRotationX - nb.worldRotationX;
      commands.push(...planAttachmentTransform(raw, { skin: rig.skin, slot, name }, { x: Math.round(l.x * 100) / 100, y: Math.round(l.y * 100) / 100, rotation: Math.round(rotation * 100) / 100 }));
    }
    return { commands };
  };
  const rebindSlot = (slot: string, to: string) => run(`Bind ${slot} to ${to}`, (raw) => planRebind(raw, slot, to));
  /** Auto-bind: every slot with a region image goes to the nearest bone (image centre against the bone segment). Returns how many moved. */
  const autoBindSlots = async (): Promise<number> => {
    const sk = host.skeleton();
    const rig = host.rig();
    if (!sk || !rig) return 0;
    const bones: BindBone[] = sk.bones.map((b) => {
      const t = tipOf(b);
      return { name: b.data.name, ox: b.world.x, oy: b.world.y, tx: t.x, ty: t.y, helper: b.data.helper === true };
    });
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const slots: BindSlot[] = [];
    for (const s of list(rig.raw["slots"])) {
      const name = String(s["name"]);
      const atts = isObj(skin["attachments"]) && isObj(skin["attachments"][name]) ? (skin["attachments"][name] as JsonObject) : {};
      const cur = typeof s["attachment"] === "string" ? atts[s["attachment"]] : Object.values(atts)[0];
      const ob = sk.findBone(String(s["bone"]));
      if (!ob || !isObj(cur) || cur["type"] !== "region") continue;
      const w = ob.localToWorld(Number(cur["x"] ?? 0), Number(cur["y"] ?? 0), { x: 0, y: 0 });
      slots.push({ slot: name, cx: w.x, cy: w.y, bone: ob.data.name });
    }
    const moves = autoBind(slots, bones);
    if (!moves.length) {
      host.status("Auto-bind: every slot is already on its nearest bone", "");
      return 0;
    }
    const ok = await run(`Auto-bind ${moves.length} slot${moves.length === 1 ? "" : "s"}`, (raw) => ({ commands: moves.flatMap((m) => planRebind(raw, m.slot, m.to).commands) }));
    if (ok) host.status(`Auto-bind: moved ${moves.length} slot${moves.length === 1 ? "" : "s"} to the nearest bone`, "");
    return ok ? moves.length : 0;
  };
  /** Moves the ground (the root bone) to the bottom centre of the region images; the art stays where it is. Returns whether it moved. */
  const setGroundHere = async (): Promise<boolean> => {
    const sk = host.skeleton();
    const rig = host.rig();
    if (!sk || !rig) return false;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of list(rig.raw["slots"])) {
      const name = String(s["name"]);
      const atts = isObj(skin["attachments"]) && isObj(skin["attachments"][name]) ? (skin["attachments"][name] as JsonObject) : {};
      const cur = typeof s["attachment"] === "string" ? atts[s["attachment"]] : undefined;
      const bone = sk.findBone(String(s["bone"]));
      if (!bone || !isObj(cur) || cur["type"] !== "region") continue;
      const f = frameOf(cur);
      for (const [lx, ly] of [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2]] as const) {
        const w = regionWorld(bone, f, lx, ly);
        minX = Math.min(minX, w.x);
        maxX = Math.max(maxX, w.x);
        maxY = Math.max(maxY, w.y);
      }
    }
    const root = sk.findBone("root");
    if (!root || !Number.isFinite(minX)) {
      host.status("Set ground: this rig has no images to stand on yet", "bad");
      return false;
    }
    const target = { x: Math.round((minX + maxX) / 2), y: Math.round(maxY) };
    const out = { x: root.data.x + (target.x - root.world.x), y: root.data.y + (target.y - root.world.y) };
    const ok = await transformBone("root", out, true);
    if (ok) host.status(`Ground set under the art (root at ${target.x}, ${target.y}); the art did not move`, "ok");
    return ok;
  };
  const defaultParent = (raw: JsonObject): string | null => {
    const sel = host.selected();
    if (sel && boneNames(raw).includes(sel)) return sel;
    return list(raw["bones"]).find((b) => b["parent"] === undefined)?.["name"] as string | null ?? null;
  };

  const attachRegion = (path: string, o: { slot?: string | null; bone?: string; name?: string; setDefault?: boolean } = {}) =>
    run("Attach image", (raw) => {
      const rig = rigNow();
      const region = rig.regions.find((r) => r.path === path);
      if (!region) throw new SetupError(`no atlas region '${path}'`);
      const slot = o.slot === undefined ? slotSel : o.slot;
      const bone = o.bone ?? host.selected() ?? undefined;
      const plan = planAttachImage(raw, { skin: rig.skin, slot, ...(bone ? { bone } : {}), ...(o.name ? { name: o.name } : {}), path, width: region.width, height: region.height, setDefault: o.setDefault ?? attachState.makeDefault });
      slotSel = plan.slot;
      attSel = plan.attachment;
      node = { kind: "slot", slot: plan.slot };
      return { commands: plan.commands };
    });

  /** Attaches a PNG (data URL) as a new atlas page of the rig. */
  async function attachPng(dataUrl: string, o: { slot?: string | null; bone?: string; name?: string; setDefault?: boolean } = {}): Promise<boolean> {
    const rig = host.rig();
    if (!rig) return false;
    const image = await loadRgbaImage(dataUrl);
    return run("Import image", (raw) => {
      const bone = o.bone ?? host.selected() ?? undefined;
      const slot = o.slot === undefined ? slotSel : o.slot;
      const plan = planAttachImage(raw, { skin: rig.skin, slot, ...(bone ? { bone } : {}), ...(o.name ? { name: o.name } : {}), imported: { rigName: rig.name }, width: image.width, height: image.height, setDefault: o.setDefault ?? attachState.makeDefault });
      host.addImage(plan.path, image);
      session().imported.set(plan.path, { file: plan.page!, path: plan.path, png: dataUrl });
      slotSel = plan.slot;
      attSel = plan.attachment;
      node = { kind: "slot", slot: plan.slot };
      return { commands: plan.commands };
    });
  }

  /** Several numbered PNG files into one image sequence: each file becomes an atlas page of the rig, one region attachment plays them. */
  async function importSequencePngs(files: { name: string; dataUrl: string }[], o: { slot: string | null }): Promise<boolean> {
    const rig = host.rig();
    if (!rig) return false;
    const named = files.map((f) => ({ ...f, name: f.name.replace(/\.png$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_") }));
    const parsed = parseSequenceFrames(named.map((f) => f.name));
    if (typeof parsed === "string") {
      host.status(parsed, "bad");
      return false;
    }
    const num = (n: string) => Number(/(\d+)$/.exec(n)?.[1] ?? 0);
    named.sort((a, b) => num(a.name) - num(b.name));
    const images = await Promise.all(named.map((f) => loadRgbaImage(f.dataUrl)));
    return run("Import PNG sequence", (raw) => {
      const plan = planImportSequence(raw, { skin: rig.skin, slot: o.slot, ...(host.selected() ? { bone: host.selected()! } : {}), rigName: rig.name, frames: named.map((f, i) => ({ name: f.name, width: images[i]!.width, height: images[i]!.height })) });
      plan.pages.forEach((p, i) => {
        host.addImage(p.path, images[i]!);
        session().imported.set(p.path, { file: p.page, path: p.path, png: named[i]!.dataUrl });
      });
      slotSel = plan.slot;
      attSel = plan.attachment;
      node = { kind: "attachment", slot: plan.slot, name: plan.attachment };
      return { commands: plan.commands };
    });
  }
  const transformImage = (t: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number }, target?: { slot: string; name: string }) =>
    run("Place image", (raw) => {
      const rig = rigNow();
      const slot = target?.slot ?? slotSel;
      if (!slot) throw new SetupError("select a slot first");
      const name = target?.name ?? attSel ?? defaultRegion(raw, rig.skin, slot)?.name;
      if (!name) throw new SetupError("the slot has no image to place");
      return { commands: planAttachmentTransform(raw, { skin: rig.skin, slot, name }, t) };
    });
  /** Adds a point attachment (grip / tip / socket) to the slot; the Image tool drags it. */
  const addPoint = (slot: string, preset: "point" | "grip" | "tip" = "point") =>
    run(`Add ${preset} on ${slot}`, (raw) => {
      const rig = rigNow();
      const plan = planAddPoint(raw, { skin: rig.skin, slot, preset });
      slotSel = slot;
      attSel = plan.attachment;
      node = { kind: "attachment", slot, name: plan.attachment };
      return { commands: plan.commands };
    });
  /** Adds a clip mask or a hit box (a polygon the size of the slot's image) to the slot; the Image tool drags its corners. */
  const addPolygon = (slot: string, kind: PolygonKind) =>
    run(`Add ${POLYGON_LABEL[kind].toLowerCase()} on ${slot}`, (raw) => {
      const plan = planAddPolygon(raw, { skin: rigNow().skin, slot, kind });
      slotSel = plan.slot;
      attSel = plan.attachment;
      node = { kind: "attachment", slot: plan.slot, name: plan.attachment };
      return { commands: plan.commands };
    });
  type PolygonEdit = { kind: "move"; index: number; x: number; y: number } | { kind: "insert"; index: number; x?: number; y?: number } | { kind: "remove"; index: number } | { kind: "end"; end: string | null };
  const editPolygon = (slot: string, name: string, e: PolygonEdit) =>
    run(e.kind === "move" ? "Move polygon point" : e.kind === "insert" ? "Add polygon point" : e.kind === "remove" ? "Remove polygon point" : "Set clip end slot", (raw) => {
      const a = { skin: rigNow().skin, slot, name };
      slotSel = slot;
      attSel = name;
      return { commands: e.kind === "move" ? planMoveVertex(raw, a, e.index, e.x, e.y) : e.kind === "insert" ? planInsertVertex(raw, a, e.index, e.x !== undefined && e.y !== undefined ? { x: e.x, y: e.y } : undefined) : e.kind === "remove" ? planRemoveVertex(raw, a, e.index) : planSetClipEnd(raw, a, e.end) };
    });
  /** Adds a path (a bezier curve a path constraint moves bones along) in a slot of its own beside the given slot; the Image tool drags its points and handles. */
  const addPath = (slot: string) =>
    run(`Add path on ${slot}`, (raw) => {
      const plan = planAddPath(raw, { skin: rigNow().skin, slot });
      slotSel = plan.slot;
      attSel = plan.attachment;
      node = { kind: "attachment", slot: plan.slot, name: plan.attachment };
      return { commands: plan.commands };
    });
  type PathEdit = { kind: "move"; index: number; x: number; y: number } | { kind: "insert"; index: number } | { kind: "remove"; index: number } | { kind: "flags"; closed?: boolean; constantSpeed?: boolean };
  const editPath = (slot: string, name: string, e: PathEdit) =>
    run(e.kind === "move" ? "Move path point" : e.kind === "insert" ? "Add path point" : e.kind === "remove" ? "Remove path point" : "Set path options", (raw) => {
      const a = { skin: rigNow().skin, slot, name };
      slotSel = slot;
      attSel = name;
      return { commands: e.kind === "move" ? planMovePathVertex(raw, a, e.index, e.x, e.y) : e.kind === "insert" ? planInsertPathPoint(raw, a, e.index) : e.kind === "remove" ? planRemovePathPoint(raw, a, e.index) : planSetPathFlags(raw, a, e) };
    });
  /** Turns the picked atlas images (consecutive frame numbers) into one image-sequence attachment on the selected slot. */
  const makeSequence = (paths: string[]) =>
    run("Make image sequence", (raw) => {
      const rig = rigNow();
      if (!slotSel) throw new SetupError("select a slot first: the sequence is added to it");
      const numeric = (p: string) => Number(/(\d+)$/.exec(p)?.[1] ?? 0);
      const first = [...paths].sort((x, y) => numeric(x) - numeric(y))[0] ?? "";
      const region = rig.regions.find((r) => r.path === first);
      if (!region) throw new SetupError(`no atlas region '${first}'`);
      const plan = planSequenceFromPaths(raw, { skin: rig.skin, slot: slotSel, paths, size: { width: region.width, height: region.height } });
      attSel = plan.attachment;
      node = { kind: "attachment", slot: slotSel, name: plan.attachment };
      return { commands: plan.commands };
    });
  const setSequence = (slot: string, name: string, fields: SequenceFields | null) =>
    run(fields ? "Edit image sequence" : "Remove image sequence", (raw) => ({ commands: planSetSequence(raw, { skin: rigNow().skin, slot, name }, fields) }));
  /** Links the slot's image to another mesh (`source`), unlinks it (null), or flips deform inheritance (`inherit`). One undo step. */
  const linkMesh = (slot: string, name: string, o: { source?: AttAddress | null; inherit?: boolean }) =>
    run(o.inherit !== undefined ? "Set deform inheritance" : o.source ? "Link mesh" : "Unlink mesh", (raw) => {
      const rig = rigNow();
      const target = { skin: rig.skin, slot, name };
      slotSel = slot;
      attSel = name;
      if (o.inherit !== undefined) return { commands: planSetInherit(raw, target, o.inherit) };
      return { commands: o.source ? planLinkMesh(raw, target, o.source) : planUnlinkMesh(raw, target) };
    });
  const readDataUrl = (file: Blob): Promise<string> =>
    new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(file);
    });
  const sameSize = (a: { width: number; height: number }, b: { width: number; height: number }) => a.width === b.width && a.height === b.height;
  const relinkLines = (name: string, p: NonNullable<ReturnType<typeof previewRelink>>, mode: RelinkMode): string[] => [
    `${name}: ${p.from.width} x ${p.from.height} px becomes ${p.to.width} x ${p.to.height} px${p.sizeChanged ? "" : " (same size)"}.`,
    `Kept: ${p.keeps.join(", ")}.`,
    p.type === "mesh" ? (p.sizeChanged ? (mode === "keep-scale" ? "UVs are remapped to keep the pixel scale, centred." : "UVs stay: the new picture is stretched over the same shape.") : "UVs stay as they are.") : p.type === "region" && p.sizeChanged ? (mode === "stretch" ? "The image scale is adjusted so it keeps its size on screen." : "The image is drawn at its new pixel size.") : "No UVs to remap.",
    "Undo brings the old picture back."
  ];
  /** Replaces the picture of an image or mesh with a PNG (any size); the rigging stays and the UVs are remapped. One undo step. */
  async function relinkArt(slot: string, name: string, file: File, mode: RelinkMode): Promise<void> {
    const rig = host.rig();
    if (!rig || busy) return;
    try {
      const dataUrl = await readDataUrl(file);
      const image = await loadRgbaImage(dataUrl);
      const target = { skin: rig.skin, slot, name };
      const p = previewRelink(rig.raw, target, { width: image.width, height: image.height }, mode);
      if (!p) return host.status(`'${name}' has no picture to replace`, "bad");
      const go = await confirmDialog({ title: "Replace the picture?", message: `Replace the picture of ${name} with ${file.name}.`, lines: relinkLines(name, p, mode), confirmLabel: "Replace image", id: "relink-dialog" });
      if (!go) return;
      const fresh = freshArtName(rig.raw, target, rig.name);
      await run(`Replace the picture of ${name}`, (raw) => {
        const commands = planRelink(raw, target, { path: fresh.path, width: image.width, height: image.height, mode, page: fresh.page });
        host.addImage(fresh.path, image);
        session().imported.set(fresh.path, { file: fresh.page, path: fresh.path, png: dataUrl });
        return { commands };
      });
    } catch (error) {
      host.status(`Replace image failed: ${msg(error)}`, "bad");
    }
  }
  /** Reads the picture's page file from disk again. Same size: the new pixels show at once; another size: remapped like Replace image. */
  async function reloadArt(slot: string, name: string, mode: RelinkMode): Promise<void> {
    const rig = host.rig();
    if (!rig || busy) return;
    try {
      const att = objOf(objOf(objOf(objOf(rig.raw["skins"])[rig.skin])["attachments"])[slot])[name];
      const path = isObj(att) && typeof att["path"] === "string" ? att["path"] : "";
      if (!path) return host.status(`'${name}' has no picture to reload`, "bad");
      if (session().imported.has(path)) return host.status("This picture was imported in this session and is not saved yet: Save rig first, then change the file and reload", "bad");
      const manifest = (await (await fetch(`/repo/${rig.atlas}`, { cache: "no-store" })).json()) as { pages?: { file: string; width: number; height: number; regions: Record<string, { x: number; y: number; width: number; height: number }> }[] };
      const page = (manifest.pages ?? []).find((pg) => pg.regions[path]);
      const region = page?.regions[path];
      if (!page || !region || region.x !== 0 || region.y !== 0 || region.width !== page.width || region.height !== page.height) {
        return host.status("This picture sits inside a packed atlas page, so there is no file of its own to reload: use Replace image with a PNG", "bad");
      }
      const res = await fetch(`/repo/${rig.atlas.slice(0, rig.atlas.lastIndexOf("/"))}/${page.file}?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return host.status(`Reload failed: ${page.file} is not on disk (${res.status})`, "bad");
      const dataUrl = await readDataUrl(await res.blob());
      const image = await loadRgbaImage(dataUrl);
      const now = rig.image?.(path)?.pixels;
      const identical = !!now && sameSize(now, image) && now.data.length === image.data.length && now.data.every((v, i) => v === image.data[i]);
      if (identical) return host.status(`${page.file} has not changed on disk`, "ok");
      const target = { skin: rig.skin, slot, name };
      if (now && sameSize(now, image)) {
        host.addImage(path, image);
        await host.replaceRig(structuredClone(rig.raw));
        host.redraw();
        return host.status(`Reloaded ${name} from ${page.file}`, "ok");
      }
      const p = previewRelink(rig.raw, target, { width: image.width, height: image.height }, mode);
      if (!p) return host.status(`'${name}' has no picture to reload`, "bad");
      const go = await confirmDialog({ title: "Reload the picture?", message: `${page.file} changed size on disk.`, lines: relinkLines(name, p, mode), confirmLabel: "Reload image", id: "relink-dialog" });
      if (!go) return;
      await run(`Reload the picture of ${name}`, (raw) => {
        const commands = planRelink(raw, target, { path, width: image.width, height: image.height, mode });
        host.addImage(path, image);
        session().imported.set(path, { file: page.file, path, png: dataUrl });
        return { commands };
      });
    } catch (error) {
      host.status(`Reload failed: ${msg(error)}`, "bad");
    }
  }
  const removeImage = (slot: string, name: string) =>
    run("Remove image", (raw) => {
      const rig = rigNow();
      attSel = null;
      return { commands: planRemoveAttachment(raw, { skin: rig.skin, slot, name }) };
    });

  // -------------------------------------------------------------------------------------------
  // Viewport: picking, gizmos, overlay
  // -------------------------------------------------------------------------------------------

  const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const tipOf = (b: Bone) => b.localToWorld(b.data.length, 0, { x: 0, y: 0 });
  const mirror = (b: Bone | null) => (b && b.world.a * b.world.d - b.world.b * b.world.c < 0 ? -1 : 1);

  function pick(x: number, y: number): string | null {
    const sk = host.skeleton();
    if (!sk) return null;
    let best: string | null = null;
    let bestD = 10 / host.zoom();
    const hidden = outlinerHiddenBones();
    const rb = sk.findBone("root");
    if (rb && !outlinerLocked("root") && !hidden.has("root") && Math.hypot(x - rb.world.x, y - rb.world.y) <= 13 / host.zoom()) return "root";
    for (const b of sk.bones) {
      if (b.data.name === "root" || (hideHelpers && b.data.helper) || outlinerLocked(b.data.name) || hidden.has(b.data.name)) continue;
      const t = tipOf(b);
      const d = segDist(x, y, b.world.x, b.world.y, t.x, t.y);
      if (d < bestD) {
        bestD = d;
        best = b.data.name;
      }
    }
    return best;
  }

  /** The image the attachment tool works on: the selected slot's chosen (or default) region. */
  function imageInfo(): { bone: Bone; slot: string; name: string; att: JsonObject } | null {
    const rig = host.rig();
    const sk = host.skeleton();
    if (!rig || !sk || !slotSel) return null;
    const slot = list(rig.raw["slots"]).find((s) => s["name"] === slotSel);
    if (!slot) return null;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const atts = isObj(skin["attachments"]) && isObj(skin["attachments"][slotSel]) ? (skin["attachments"][slotSel] as JsonObject) : {};
    const name = attSel && isObj(atts[attSel]) ? attSel : typeof slot["attachment"] === "string" ? slot["attachment"] : null;
    const att = name ? atts[name] : undefined;
    const bone = sk.findBone(String(slot["bone"]));
    if (!name || !bone || !isObj(att) || (att["type"] !== "region" && att["type"] !== "point")) return null;
    return { bone, slot: slotSel, name, att };
  }

  interface RegionFrame {
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    w: number;
    h: number;
  }
  const frameOf = (att: JsonObject): RegionFrame => ({ x: Number(att["x"] ?? 0), y: Number(att["y"] ?? 0), rotation: Number(att["rotation"] ?? 0), scaleX: Number(att["scaleX"] ?? 1), scaleY: Number(att["scaleY"] ?? 1), w: Number(att["width"] ?? 0), h: Number(att["height"] ?? 0) });
  /** A point of the image (offset from its centre in image pixels) in world space. */
  function regionWorld(bone: Bone, f: RegionFrame, lx: number, ly: number): { x: number; y: number } {
    const r = (f.rotation * Math.PI) / 180;
    const px = f.x + Math.cos(r) * lx * f.scaleX - Math.sin(r) * ly * f.scaleY;
    const py = f.y + Math.sin(r) * lx * f.scaleX + Math.cos(r) * ly * f.scaleY;
    return bone.localToWorld(px, py, { x: 0, y: 0 });
  }
  function handles(bone: Bone, f: RegionFrame) {
    const px = 1 / host.zoom();
    const centre = regionWorld(bone, f, 0, 0);
    const top = regionWorld(bone, f, 0, -f.h / 2);
    const len = Math.hypot(top.x - centre.x, top.y - centre.y) || 1;
    const rot = { x: top.x + ((top.x - centre.x) / len) * 34 * px, y: top.y + ((top.y - centre.y) / len) * 34 * px };
    return { centre, rot, corner: regionWorld(bone, f, f.w / 2, f.h / 2), top };
  }
  /** A point attachment's centre in world space and the handle at the end of its direction arrow. */
  function pointHandles(bone: Bone, f: RegionFrame): { centre: { x: number; y: number }; rot: { x: number; y: number }; dir: { x: number; y: number } } {
    const px = 1 / host.zoom();
    const r = (f.rotation * Math.PI) / 180;
    const centre = bone.localToWorld(f.x, f.y, { x: 0, y: 0 });
    const ahead = bone.localToWorld(f.x + Math.cos(r), f.y + Math.sin(r), { x: 0, y: 0 });
    const len = Math.hypot(ahead.x - centre.x, ahead.y - centre.y) || 1;
    const dir = { x: (ahead.x - centre.x) / len, y: (ahead.y - centre.y) / len };
    return { centre, rot: { x: centre.x + dir.x * 44 * px, y: centre.y + dir.y * 44 * px }, dir };
  }
  /** Draws every point attachment of the rig's skin: a crosshair and a direction arrow (the selected one bigger, with its turn handle under the Image tool). */
  function drawPoints(g: Graphics, px: number, sk: Skeleton): void {
    const rig = host.rig();
    if (!rig) return;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const all = isObj(skin["attachments"]) ? (skin["attachments"] as JsonObject) : {};
    const colour = 0xe85de0;
    for (const s of list(rig.raw["slots"])) {
      const bone = sk.findBone(String(s["bone"]));
      const here = all[String(s["name"])];
      if (!bone || !isObj(here)) continue;
      for (const [name, att] of Object.entries(here)) {
        if (!isObj(att) || att["type"] !== "point") continue;
        const selected = String(s["name"]) === slotSel && name === attSel;
        let f = frameOf(att);
        if (selected && drag?.kind === "att-move") f = { ...f, x: drag.x, y: drag.y };
        else if (selected && drag?.kind === "att-rotate") f = { ...f, rotation: drag.rotation };
        const ph = pointHandles(bone, f);
        const k = selected ? 1.4 : 1;
        const alpha = selected ? 1 : 0.7;
        g.moveTo(ph.centre.x - 9 * k * px, ph.centre.y).lineTo(ph.centre.x + 9 * k * px, ph.centre.y).stroke({ width: 2 * px, color: colour, alpha });
        g.moveTo(ph.centre.x, ph.centre.y - 9 * k * px).lineTo(ph.centre.x, ph.centre.y + 9 * k * px).stroke({ width: 2 * px, color: colour, alpha });
        g.circle(ph.centre.x, ph.centre.y, 5 * k * px).stroke({ width: 1.5 * px, color: colour, alpha });
        const tipX = ph.centre.x + ph.dir.x * 26 * k * px;
        const tipY = ph.centre.y + ph.dir.y * 26 * k * px;
        g.moveTo(ph.centre.x, ph.centre.y).lineTo(tipX, tipY).stroke({ width: 2 * px, color: colour, alpha });
        g.poly([tipX + ph.dir.x * 6 * px, tipY + ph.dir.y * 6 * px, tipX - ph.dir.y * 4 * px, tipY + ph.dir.x * 4 * px, tipX + ph.dir.y * 4 * px, tipY - ph.dir.x * 4 * px]).fill({ color: colour, alpha });
        if (selected && tool === "attachment") {
          g.moveTo(tipX, tipY).lineTo(ph.rot.x, ph.rot.y).stroke({ width: 1.5 * px, color: colour, alpha: 0.6 });
          g.circle(ph.rot.x, ph.rot.y, 6 * px).fill({ color: colour });
        }
      }
    }
  }
  /** The selected clip mask or hit box, with its bone, or null. */
  function polyInfo(): { bone: Bone; slot: string; name: string; att: JsonObject; vertices: number[] } | null {
    const sk = host.skeleton();
    const rig = host.rig();
    if (!sk || !rig || !slotSel || !attSel) return null;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const byslot = isObj(skin["attachments"]) && isObj(skin["attachments"][slotSel]) ? (skin["attachments"][slotSel] as JsonObject) : {};
    const att = byslot[attSel];
    const slot = list(rig.raw["slots"]).find((s) => s["name"] === slotSel);
    const bone = slot ? sk.findBone(String(slot["bone"])) : undefined;
    if (!bone || !isObj(att) || (att["type"] !== "clipping" && att["type"] !== "boundingbox") || !Array.isArray(att["vertices"])) return null;
    return { bone, slot: slotSel, name: attSel, att, vertices: att["vertices"] as number[] };
  }
  /** The selected path attachment (unweighted), with its bone, or null. */
  function pathInfo(): { bone: Bone; slot: string; name: string; att: JsonObject; closed: boolean } | null {
    const sk = host.skeleton();
    const rig = host.rig();
    if (!sk || !rig || !slotSel || !attSel) return null;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const byslot = isObj(skin["attachments"]) && isObj(skin["attachments"][slotSel]) ? (skin["attachments"][slotSel] as JsonObject) : {};
    const att = byslot[attSel];
    const slot = list(rig.raw["slots"]).find((s) => s["name"] === slotSel);
    const bone = slot ? sk.findBone(String(slot["bone"])) : undefined;
    if (!bone || !isObj(att) || att["type"] !== "path" || Array.isArray(att["bones"])) return null;
    return { bone, slot: slotSel, name: attSel, att, closed: att["closed"] === true };
  }
  /** World positions of a path's vertices (3 per control point: handle in, point, handle out), with a live drag applied. */
  function pathWorld(bone: Bone, att: JsonObject, slot: string, name: string): { x: number; y: number }[] {
    const v = (att["vertices"] as number[]).slice();
    if (drag?.kind === "path-vertex" && drag.slot === slot && drag.name === name) {
      const pts = pathPoints(att);
      const i = Math.floor(drag.index / 3);
      const p = pts[i];
      if (p) {
        if (drag.index % 3 === 1) {
          const dx = drag.x - p.x;
          const dy = drag.y - p.y;
          for (const k of [0, 1, 2]) {
            v[(i * 3 + k) * 2] = (v[(i * 3 + k) * 2] as number) + dx;
            v[(i * 3 + k) * 2 + 1] = (v[(i * 3 + k) * 2 + 1] as number) + dy;
          }
        } else {
          v[drag.index * 2] = drag.x;
          v[drag.index * 2 + 1] = drag.y;
        }
      }
    }
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push(bone.localToWorld(v[i] as number, v[i + 1] as number, { x: 0, y: 0 }));
    return out;
  }
  /** The curve segments of a world path as [p0, c1, c2, p1] quadruples (a closed path adds the last-to-first segment). */
  const pathSegments = (w: { x: number; y: number }[], closed: boolean) => {
    const n = Math.floor(w.length / 3);
    const segs: { x: number; y: number }[][] = [];
    for (let i = 0; i + 1 < n; i++) segs.push([w[i * 3 + 1]!, w[i * 3 + 2]!, w[(i + 1) * 3]!, w[(i + 1) * 3 + 1]!]);
    if (closed && n >= 3) segs.push([w[(n - 1) * 3 + 1]!, w[(n - 1) * 3 + 2]!, w[0]!, w[1]!]);
    return segs;
  };
  /** Every path curve as an orange line (the selected one with point squares, handle dots and handle lines). */
  function drawPaths(g: Graphics, px: number): void {
    const rig = host.rig();
    const sk = host.skeleton();
    if (!rig || !sk) return;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const all = isObj(skin["attachments"]) ? (skin["attachments"] as JsonObject) : {};
    const flags = polyFlags();
    for (const s of list(rig.raw["slots"])) {
      const bone = sk.findBone(String(s["bone"]));
      const here = all[String(s["name"])];
      if (!bone || !isObj(here)) continue;
      for (const [name, att] of Object.entries(here)) {
        if (!isObj(att) || att["type"] !== "path" || Array.isArray(att["bones"]) || !Array.isArray(att["vertices"])) continue;
        const selected = String(s["name"]) === slotSel && name === attSel;
        if (!selected && !flags.paths) continue;
        const w = pathWorld(bone, att, String(s["name"]), name);
        const segs = pathSegments(w, att["closed"] === true);
        const colour = POLY_COLOR.path;
        for (const seg of segs) g.moveTo(seg[0]!.x, seg[0]!.y).bezierCurveTo(seg[1]!.x, seg[1]!.y, seg[2]!.x, seg[2]!.y, seg[3]!.x, seg[3]!.y);
        g.stroke({ width: (selected ? 2.5 : 1.6) * px, color: colour, alpha: selected ? 1 : 0.8 });
        if (selected) {
          const n = Math.floor(w.length / 3);
          for (let i = 0; i < n; i++) {
            const pin = w[i * 3]!;
            const pt = w[i * 3 + 1]!;
            const pout = w[i * 3 + 2]!;
            g.moveTo(pin.x, pin.y).lineTo(pt.x, pt.y).lineTo(pout.x, pout.y).stroke({ width: px, color: colour, alpha: 0.55 });
            g.circle(pin.x, pin.y, 3.5 * px).fill({ color: 0xffffff }).stroke({ width: px, color: colour });
            g.circle(pout.x, pout.y, 3.5 * px).fill({ color: 0xffffff }).stroke({ width: px, color: colour });
            g.rect(pt.x - 4.5 * px, pt.y - 4.5 * px, 9 * px, 9 * px).fill({ color: i === 0 ? colour : 0xffffff }).stroke({ width: 1.5 * px, color: colour });
          }
        }
      }
    }
  }
  const polyWorld = (bone: Bone, v: readonly number[]) => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push(bone.localToWorld(v[i] as number, v[i + 1] as number, { x: 0, y: 0 }));
    return out;
  };
  /** Every clip mask and hit box of the rig's skin as tinted polygons (the selected one with point handles and edge midpoints). */
  function drawPolygons(g: Graphics, px: number): void {
    drawPaths(g, px);
    const rig = host.rig();
    const sk = host.skeleton();
    if (!rig || !sk) return;
    const skin = isObj(rig.raw["skins"]) && isObj(rig.raw["skins"][rig.skin]) ? (rig.raw["skins"][rig.skin] as JsonObject) : {};
    const all = isObj(skin["attachments"]) ? (skin["attachments"] as JsonObject) : {};
    const flags = polyFlags();
    for (const s of list(rig.raw["slots"])) {
      const bone = sk.findBone(String(s["bone"]));
      const here = all[String(s["name"])];
      if (!bone || !isObj(here)) continue;
      for (const [name, att] of Object.entries(here)) {
        if (!isObj(att) || (att["type"] !== "clipping" && att["type"] !== "boundingbox") || !Array.isArray(att["vertices"])) continue;
        const selected = String(s["name"]) === slotSel && name === attSel;
        if (!selected && !(att["type"] === "boundingbox" ? flags.boxes : flags.clips)) continue;
        let v = att["vertices"] as number[];
        if (selected && drag?.kind === "poly-vertex") {
          v = v.slice();
          v[drag.index * 2] = drag.x;
          v[drag.index * 2 + 1] = drag.y;
        }
        const pts = polyWorld(bone, v);
        if (pts.length < 3) continue;
        const colour = POLY_COLOR[att["type"]];
        g.poly(pts.flatMap((q) => [q.x, q.y])).fill({ color: colour, alpha: selected ? 0.22 : 0.12 }).stroke({ width: (selected ? 2 : 1.4) * px, color: colour, alpha: selected ? 1 : 0.75 });
        if (selected) {
          pts.forEach((q, i) => {
            const n = pts[(i + 1) % pts.length]!;
            if (tool === "attachment") g.poly([(q.x + n.x) / 2, (q.y + n.y) / 2 - 4 * px, (q.x + n.x) / 2 + 4 * px, (q.y + n.y) / 2, (q.x + n.x) / 2, (q.y + n.y) / 2 + 4 * px, (q.x + n.x) / 2 - 4 * px, (q.y + n.y) / 2]).stroke({ width: px, color: colour, alpha: 0.8 });
            g.rect(q.x - 4.5 * px, q.y - 4.5 * px, 9 * px, 9 * px).fill({ color: 0xffffff }).stroke({ width: 1.5 * px, color: colour });
          });
        }
      }
    }
  }
  const localOf = (bone: Bone, x: number, y: number) => {
    const out = { x: 0, y: 0 };
    bone.worldToLocal(x, y, out);
    return out;
  };

  function pointerDown(p: { x: number; y: number }, e: { shiftKey: boolean; altKey: boolean }): boolean {
    const sk = host.skeleton();
    if (!on || !sk || busy) return true;
    const px = 1 / host.zoom();
    const sub = activeSub();
    if (sub) {
      sub.pointerDown?.(p as ToolPoint, e, ctx);
      return true;
    }
    if (e.altKey) {
      const hit = pick(p.x, p.y);
      if (hit) host.select(hit);
      return true;
    }
    if (tool === "bone") {
      const rig = host.rig();
      const pressed = pick(p.x, p.y);
      const parent = pressed ?? (rig ? defaultParent(rig.raw) : null);
      let from: [number, number] = [p.x, p.y];
      const pb = parent ? sk.findBone(parent) : undefined;
      if (e.shiftKey && pb) {
        const t = tipOf(pb);
        from = [t.x, t.y];
      }
      drag = { kind: "new", parent, from, to: [p.x, p.y] };
      return true;
    }
    if (tool === "attachment") {
      if (!imagesSelectable()) {
        host.status("Images are not selectable (Bones / Images / Others grid)", "bad");
        return true;
      }
      const pathSel = pathInfo();
      if (pathSel) {
        // A path: drag a point (its handles come along) or a handle, click the curve to add a point, Shift-click a point to remove it.
        const w = pathWorld(pathSel.bone, pathSel.att, pathSel.slot, pathSel.name);
        const att = pathSel.att["vertices"] as number[];
        const n = Math.floor(w.length / 3);
        const near = (part: number) => {
          for (let i = n - 1; i >= 0; i--) {
            const q = w[i * 3 + part]!;
            if (Math.hypot(p.x - q.x, p.y - q.y) < 12 * px) return i * 3 + part;
          }
          return -1;
        };
        const hit = [1, 2, 0].map(near).find((x) => x >= 0) ?? -1;
        if (hit >= 0) {
          if (e.shiftKey && hit % 3 === 1) void editPath(pathSel.slot, pathSel.name, { kind: "remove", index: Math.floor(hit / 3) });
          else drag = { kind: "path-vertex", slot: pathSel.slot, name: pathSel.name, index: hit, x: att[hit * 2] as number, y: att[hit * 2 + 1] as number };
          return true;
        }
        const segs = pathSegments(w, pathSel.closed);
        for (let i = 0; i < segs.length; i++) {
          const [a, b, c, d] = segs[i]!;
          for (let k = 0; k <= 24; k++) {
            const t = k / 24;
            const u = 1 - t;
            const x = u * u * u * a!.x + 3 * u * u * t * b!.x + 3 * u * t * t * c!.x + t * t * t * d!.x;
            const y = u * u * u * a!.y + 3 * u * u * t * b!.y + 3 * u * t * t * c!.y + t * t * t * d!.y;
            if (Math.hypot(p.x - x, p.y - y) < 8 * px) {
              void editPath(pathSel.slot, pathSel.name, { kind: "insert", index: i });
              return true;
            }
          }
        }
        host.status("Drag a square to move the point and its handles, drag a dot to bend the curve, click the curve to add a point, Shift-click a square to remove it");
        return true;
      }
      const poly = polyInfo();
      if (poly) {
        // A clip mask or hit box: drag a point to move it, click an edge to add a point, Shift-click a point to remove it.
        const pts = polyWorld(poly.bone, poly.vertices);
        const hit = pts.findIndex((q) => Math.hypot(p.x - q.x, p.y - q.y) < 12 * px);
        if (hit >= 0) {
          if (e.shiftKey) void editPolygon(poly.slot, poly.name, { kind: "remove", index: hit });
          else drag = { kind: "poly-vertex", slot: poly.slot, name: poly.name, index: hit, x: poly.vertices[hit * 2] as number, y: poly.vertices[hit * 2 + 1] as number };
          return true;
        }
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!;
          const c = pts[(i + 1) % pts.length]!;
          const len2 = (c.x - a.x) ** 2 + (c.y - a.y) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * (c.x - a.x) + (p.y - a.y) * (c.y - a.y)) / len2));
          if (Math.hypot(p.x - (a.x + t * (c.x - a.x)), p.y - (a.y + t * (c.y - a.y))) < 8 * px) {
            const L = localOf(poly.bone, p.x, p.y);
            void editPolygon(poly.slot, poly.name, { kind: "insert", index: i, x: Math.round(L.x * 100) / 100, y: Math.round(L.y * 100) / 100 });
            return true;
          }
        }
        host.status("Drag a point to move it, click an edge to add a point, Shift-click a point to remove it");
        return true;
      }
      const info = imageInfo();
      if (!info) {
        host.status("Select a slot with a region image in the panel first", "bad");
        return true;
      }
      if (info.att["type"] === "point") {
        // A point: drag it to move, drag the ring at the end of its arrow to turn it.
        const pf = frameOf(info.att);
        const ph = pointHandles(info.bone, pf);
        const PL = localOf(info.bone, p.x, p.y);
        if (Math.hypot(p.x - ph.rot.x, p.y - ph.rot.y) < 12 * px) drag = { kind: "att-rotate", ang0: (Math.atan2(PL.y - pf.y, PL.x - pf.x) * 180) / Math.PI, rot0: pf.rotation, rotation: pf.rotation };
        else drag = { kind: "att-move", grab: [PL.x - pf.x, PL.y - pf.y], x: pf.x, y: pf.y };
        return true;
      }
      const f = frameOf(info.att);
      const h = handles(info.bone, f);
      const L = localOf(info.bone, p.x, p.y);
      if (Math.hypot(p.x - h.rot.x, p.y - h.rot.y) < 12 * px) drag = { kind: "att-rotate", ang0: (Math.atan2(L.y - f.y, L.x - f.x) * 180) / Math.PI, rot0: f.rotation, rotation: f.rotation };
      else if (Math.hypot(p.x - h.corner.x, p.y - h.corner.y) < 12 * px) drag = { kind: "att-scale", d0: Math.hypot(L.x - f.x, L.y - f.y) || 1, s0: [f.scaleX, f.scaleY], scaleX: f.scaleX, scaleY: f.scaleY };
      else drag = { kind: "att-move", grab: [L.x - f.x, L.y - f.y], x: f.x, y: f.y };
      return true;
    }
    // Select / Rotate / Move / Length: the handles of the selected bone, else pick a bone.
    const sel = host.selected();
    const bone = sel ? sk.findBone(sel) : undefined;
    const intent = intentAt(p, sk);
    if (bone && intent) {
      const mates = matesOf(bone.data.name, sk);
      if (intent.kind === "scale" || intent.kind === "shear") {
        const f = handleFrame(bone, getSpace(), HANDLE_PX / host.zoom());
        const axis = intent.hand ?? "x";
        if (intent.kind === "scale") {
          const st = { x: bone.data.scaleX, y: bone.data.scaleY };
          drag = { kind: "scale", bone: bone.data.name, axis, start: st, ss: scaleStart(f, p.x, p.y), scaleX: st.x, scaleY: st.y };
        } else drag = { kind: "shear", bone: bone.data.name, axis, start: { x: bone.data.shearX, y: bone.data.shearY }, last: pointerAngleAbout(bone.world.x, bone.world.y, p.x, p.y), accum: 0, sign: mirror(bone.parent), shearX: bone.data.shearX, shearY: bone.data.shearY };
      } else if (intent.kind === "length") drag = { kind: "length", bone: bone.data.name, length: bone.data.length, len0: bone.data.length, ...(mates.length ? { others: mates.map((m) => ({ name: m.data.name, len0: m.data.length, length: m.data.length })) } : {}) };
      else if (intent.kind === "move") drag = { kind: "move", bone: bone.data.name, grab: [p.x - bone.world.x, p.y - bone.world.y], x: bone.data.x, y: bone.data.y, w0: [bone.world.x, bone.world.y], space: getSpace(), ...(intent.axis ? { axis: intent.axis } : {}), ...(mates.length ? { others: mates.map((m) => ({ name: m.data.name, w0: [m.world.x, m.world.y] as [number, number], x: m.data.x, y: m.data.y })) } : {}) };
      else {
        const a = (Math.atan2(p.y - bone.world.y, p.x - bone.world.x) * 180) / Math.PI;
        const chain = ikDriving(bone.data.name);
        const tb = chain ? sk.findBone(chain.target) : undefined;
        const ik: IkRotate | undefined = chain && tb && tb.parent ? { ik: chain.name, target: chain.target, pivot: [bone.world.x, bone.world.y], tip: [tb.world.x, tb.world.y], x: tb.data.x, y: tb.data.y } : undefined;
        if (ik) host.status(`${bone.data.name} is driven by IK '${ik.ik}': turning it moves the target ${ik.target}, so the pose stays after release`);
        drag = { kind: "rotate", bone: bone.data.name, start: bone.data.rotation, last: a, accum: 0, sign: mirror(bone.parent), rotation: bone.data.rotation, ...(ik ? { ik } : {}), ...(!ik && mates.length ? { others: mates.map((m) => ({ name: m.data.name, start: m.data.rotation, sign: mirror(m.parent), rotation: m.data.rotation })) } : {}) };
      }
      return true;
    }
    const hit = pick(p.x, p.y);
    if (hit && e.shiftKey) getHost()?.selectBones([hit], "toggle", hit);
    else if (hit) host.select(hit);
    else if (tool === "select" || tool === "rotate" || tool === "move" || tool === "scale" || tool === "shear" || tool === "length") drag = { kind: "box", from: [p.x, p.y], to: [p.x, p.y], add: e.shiftKey };
    return true;
  }

  /** The other bones of the multi-selection that a drag of `primary` also moves, turns or stretches (none when it is not in it). */
  function matesOf(primary: string, sk: Skeleton): Bone[] {
    const names = getHost()?.boneSelection().names ?? [];
    if (names.length < 2 || !names.includes(primary)) return [];
    return names.filter((n) => n !== primary).map((n) => sk.findBone(n)).filter((b): b is Bone => !!b);
  }

  /**
   * The bone edit being dragged (or just released and still being committed): shown on the skeleton at once, in setup mode, while
   * the rig file is only changed when the mouse is released (one undo step). applyLive puts it on the posed skeleton.
   */
  type Live = { bone?: string; x?: number; y?: number; rotation?: number; length?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number; extra?: { bone: string; x?: number; y?: number; rotation?: number; length?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number }[]; ikTarget?: { bone: string; x: number; y: number }; image?: { slot: string; name: string; f: RegionFrame } };
  let live: Live | null = null;
  /** Puts back what applyLive overwrote on the posed skeleton's data (bone length, region corners) once the drag ends or its commit is done. */
  let restores = new Map<string, () => void>();
  function clearLive(): void {
    for (const r of restores.values()) r();
    restores = new Map();
    live = null;
  }
  function applyLive(sk: { findBone(name: string): Bone | undefined; findSlot?(name: string): unknown; getAttachment?(slot: never, name: string): unknown }): void {
    if (preview) {
      const driver = sk.findBone(preview.bone);
      if (driver) driver.pose.rotation = driver.data.rotation + preview.deg;
    }
    if (!live) return;
    for (const one of [live, ...(live.extra ?? [])]) {
      if (!one.bone) continue;
      const b = sk.findBone(one.bone);
      if (b) {
        if (one.x !== undefined) b.pose.x = one.x;
        if (one.y !== undefined) b.pose.y = one.y;
        if (one.rotation !== undefined) {
          b.pose.rotation = one.rotation;
          // Driven keys (garment creases) read pose minus SETUP rotation. The live angle is the bone's new setup angle, so the setup
          // rotation follows it until the commit replaces the rig; otherwise the creases flip mid-drag and snap back on release.
          const data = b.data as { rotation: number };
          const key = `rot:${one.bone}`;
          if (!restores.has(key)) {
            const was = data.rotation;
            restores.set(key, () => void (data.rotation = was));
          }
          data.rotation = one.rotation;
        }
        if (one.scaleX !== undefined) b.pose.scaleX = one.scaleX;
        if (one.scaleY !== undefined) b.pose.scaleY = one.scaleY;
        if (one.shearX !== undefined) b.pose.shearX = one.shearX;
        if (one.shearY !== undefined) b.pose.shearY = one.shearY;
        if (one.length !== undefined) {
          const data = b.data as { length: number };
          if (!restores.has(`len:${one.bone}`)) {
            const was = data.length;
            restores.set(`len:${one.bone}`, () => void (data.length = was));
          }
          data.length = one.length;
        }
      }
    }
    if (live.ikTarget) {
      const t = sk.findBone(live.ikTarget.bone);
      if (t) {
        t.pose.x = live.ikTarget.x;
        t.pose.y = live.ikTarget.y;
      }
    }
    if (live.image && sk.findSlot && sk.getAttachment) {
      const slot = sk.findSlot(live.image.slot);
      const att = slot ? (sk.getAttachment(slot as never, live.image.name) as { type?: string; offsets?: Float64Array } | undefined) : undefined;
      if (att?.type === "region" && att.offsets) {
        const offsets = att.offsets;
        const key = `img:${live.image.slot}/${live.image.name}`;
        if (!restores.has(key)) {
          const was = Float64Array.from(offsets);
          restores.set(key, () => offsets.set(was));
        }
        const f = live.image.f;
        const cos = Math.cos((f.rotation * Math.PI) / 180);
        const sin = Math.sin((f.rotation * Math.PI) / 180);
        const hw = (f.w / 2) * f.scaleX;
        const hh = (f.h / 2) * f.scaleY;
        const corners = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
        for (let i = 0; i < 8; i += 2) {
          offsets[i] = f.x + cos * corners[i]! - sin * corners[i + 1]!;
          offsets[i + 1] = f.y + sin * corners[i]! + cos * corners[i + 1]!;
        }
      }
    }
  }

  const ARM = 48;
  type Intent = { kind: "move" | "length" | "rotate" | "scale" | "shear"; axis?: "x" | "y"; hand?: HandleAxis };
  /** What a press at p would start for the selected bone with the current tool (also drives the hover cursor and hint). */
  function intentAt(p: { x: number; y: number }, sk: Skeleton): Intent | null {
    if (tool !== "select" && tool !== "rotate" && tool !== "move" && tool !== "scale" && tool !== "shear" && tool !== "length") return null;
    const px = 1 / host.zoom();
    const sel = host.selected();
    const bone = sel ? sk.findBone(sel) : undefined;
    if (!bone) return null;
    const tip = tipOf(bone);
    const d = Math.hypot(p.x - bone.world.x, p.y - bone.world.y);
    const nearTip = bone.data.length > 0 && Math.hypot(p.x - tip.x, p.y - tip.y) < 13 * px;
    const nearDot = d < 15 * px;
    if (tool === "length") return nearTip ? { kind: "length" } : null;
    if (tool === "scale" || tool === "shear") {
      // The same handles and grab radius as Animate's Scale / Shear gizmo (gizmoHandles.ts), laid along the Axes choice.
      const hand = handleAt(handleFrame(bone, getSpace(), HANDLE_PX * px), tool, p.x, p.y, HANDLE_GRAB_PX * px);
      return hand ? { kind: tool, hand, ...(hand !== "xy" ? { axis: hand } : {}) } : null;
    }
    if (tool === "move") {
      // The arms lie along the Axes choice in the stage context bar (Local / Parent / World), the same frame Animate's move gizmo uses (RG-05).
      const fr = axisFrame(bone, getSpace());
      const ax = segDist(p.x, p.y, bone.world.x, bone.world.y, bone.world.x + fr.ux[0] * ARM * px, bone.world.y + fr.ux[1] * ARM * px);
      const ay = segDist(p.x, p.y, bone.world.x, bone.world.y, bone.world.x + fr.uy[0] * ARM * px, bone.world.y + fr.uy[1] * ARM * px);
      if (d > 8 * px && ax < 7 * px && ax <= ay) return { kind: "move", axis: "x" };
      if (d > 8 * px && ay < 7 * px) return { kind: "move", axis: "y" };
      return nearDot || segDist(p.x, p.y, bone.world.x, bone.world.y, tip.x, tip.y) < 10 * px ? { kind: "move" } : null;
    }
    if (tool === "rotate") {
      const other = pick(p.x, p.y);
      return other && other !== sel ? null : { kind: "rotate" };
    }
    if (nearTip) return { kind: "length" };
    if (nearDot) return { kind: "move" };
    return d > RING * 0.6 * px && d < RING * 1.4 * px ? { kind: "rotate" } : null;
  }
  const HINTS: Record<string, string> = {
    move: "Drag: move bone (setup position)",
    "move-x": "Drag: move bone along X (setup position)",
    "move-y": "Drag: move bone along Y (setup position)",
    length: "Drag: change bone length",
    rotate: "Drag: rotate bone (setup rotation)",
    scale: "Drag: scale bone (setup scale)",
    "scale-x": "Drag: scale bone along its X (setup scaleX)",
    "scale-y": "Drag: scale bone along its Y (setup scaleY)",
    shear: "Drag: shear bone (setup shear)",
    "shear-x": "Drag: shear bone's X axis (setup shearX)",
    "shear-y": "Drag: shear bone's Y axis (setup shearY)"
  };
  const CURSORS: Record<string, string> = { move: "move", "move-x": "ew-resize", "move-y": "ns-resize", length: "nwse-resize", rotate: "grab", scale: "nwse-resize", "scale-x": "ew-resize", "scale-y": "ns-resize", shear: "grab", "shear-x": "grab", "shear-y": "grab" };
  let lastHint = "";
  function hover(p: { x: number; y: number }, sk: Skeleton): void {
    const view = document.getElementById("view");
    const intent = intentAt(p, sk);
    const key = intent ? (intent.axis ? `${intent.kind}-${intent.axis}` : intent.kind) : tool === "bone" ? "draw" : "";
    if (view) view.style.cursor = key === "draw" ? "crosshair" : (CURSORS[key] ?? "");
    if (key !== lastHint) {
      lastHint = key;
      if (HINTS[key]) host.status(HINTS[key]!);
    }
  }

  function pointerMove(p: { x: number; y: number }): boolean {
    if (!on) return false;
    const sub = activeSub();
    if (sub) return !!sub.pointerMove?.(p as ToolPoint, ctx);
    const sk = host.skeleton();
    if (sk && !drag) hover(p, sk);
    if (!drag || !sk) return false;
    if (drag.kind === "new") drag.to = [p.x, p.y];
    else if (drag.kind === "box") {
      drag.to = [p.x, p.y];
      host.redraw();
      return true;
    } else if (drag.kind === "move") {
      const b = sk.getBone(drag.bone);
      const out = { x: 0, y: 0 };
      let wx = p.x - drag.grab[0];
      let wy = p.y - drag.grab[1];
      if (drag.axis) {
        // Held to one arm of the chosen frame: world-x with Axes = World keeps the world y exactly.
        const fr = axisFrame(b, drag.space);
        const u = drag.axis === "x" ? fr.ux : fr.uy;
        const along = (wx - drag.w0[0]) * u[0] + (wy - drag.w0[1]) * u[1];
        wx = drag.w0[0] + along * u[0];
        wy = drag.w0[1] + along * u[1];
      }
      if (b.parent) b.parent.worldToLocal(wx, wy, out);
      else {
        out.x = wx;
        out.y = wy;
      }
      drag.x = Math.round(out.x * 100) / 100;
      drag.y = Math.round(out.y * 100) / 100;
      live = { bone: drag.bone, x: drag.x, y: drag.y };
      if (drag.others) {
        // The same world shift for every other selected bone, each in its own parent's space.
        const dx = wx - drag.w0[0];
        const dy = wy - drag.w0[1];
        live.extra = drag.others.map((o) => {
          const ob = sk.getBone(o.name);
          const loc = { x: 0, y: 0 };
          if (ob.parent) ob.parent.worldToLocal(o.w0[0] + dx, o.w0[1] + dy, loc);
          else {
            loc.x = o.w0[0] + dx;
            loc.y = o.w0[1] + dy;
          }
          o.x = Math.round(loc.x * 100) / 100;
          o.y = Math.round(loc.y * 100) / 100;
          return { bone: o.name, x: o.x, y: o.y };
        });
      }
    } else if (drag.kind === "rotate") {
      const b = sk.getBone(drag.bone);
      const a = (Math.atan2(p.y - b.world.y, p.x - b.world.x) * 180) / Math.PI;
      drag.accum += norm(a - drag.last);
      drag.last = a;
      drag.rotation = Math.round(norm(drag.start + drag.sign * drag.accum) * 100) / 100;
      live = { bone: drag.bone, rotation: drag.rotation };
      if (drag.others) {
        const accum = drag.accum;
        live.extra = drag.others.map((o) => {
          o.rotation = Math.round(norm(o.start + o.sign * accum) * 100) / 100;
          return { bone: o.name, rotation: o.rotation };
        });
      }
      const ik = drag.ik;
      const tb = ik ? sk.findBone(ik.target) : undefined;
      if (ik && tb?.parent) {
        // The pointer's turn about the bone swings the target the same way about the same pivot: the FK result, reached through the IK target.
        const rad = (drag.accum * Math.PI) / 180;
        const dx = ik.tip[0] - ik.pivot[0];
        const dy = ik.tip[1] - ik.pivot[1];
        const out = { x: 0, y: 0 };
        tb.parent.worldToLocal(ik.pivot[0] + Math.cos(rad) * dx - Math.sin(rad) * dy, ik.pivot[1] + Math.sin(rad) * dx + Math.cos(rad) * dy, out);
        ik.x = Math.round(out.x * 100) / 100;
        ik.y = Math.round(out.y * 100) / 100;
        live.ikTarget = { bone: ik.target, x: ik.x, y: ik.y };
      }
    } else if (drag.kind === "scale") {
      const b = sk.getBone(drag.bone);
      const sc = scaleAt(handleFrame(b, getSpace(), HANDLE_PX / host.zoom()), drag.ss, drag.axis, drag.start, p.x, p.y);
      drag.scaleX = Math.round(sc.x * 1000) / 1000;
      drag.scaleY = Math.round(sc.y * 1000) / 1000;
      live = { bone: drag.bone, scaleX: drag.scaleX, scaleY: drag.scaleY };
    } else if (drag.kind === "shear") {
      const b = sk.getBone(drag.bone);
      const a = pointerAngleAbout(b.world.x, b.world.y, p.x, p.y);
      drag.accum += angleStep(drag.last, a);
      drag.last = a;
      const v = Math.round(shearValue(drag.axis === "y" ? drag.start.y : drag.start.x, drag.sign, drag.accum) * 100) / 100;
      if (drag.axis === "y") drag.shearY = v;
      else drag.shearX = v;
      live = { bone: drag.bone, shearX: drag.shearX, shearY: drag.shearY };
    } else if (drag.kind === "length") {
      const b = sk.getBone(drag.bone);
      const ang = (b.worldRotationX * Math.PI) / 180;
      drag.length = Math.max(0, Math.round(((p.x - b.world.x) * Math.cos(ang) + (p.y - b.world.y) * Math.sin(ang)) * 100) / 100);
      live = { bone: drag.bone, length: drag.length };
      if (drag.others) {
        const delta = drag.length - drag.len0;
        live.extra = drag.others.map((o) => {
          o.length = Math.max(0, Math.round((o.len0 + delta) * 100) / 100);
          return { bone: o.name, length: o.length };
        });
      }
    } else if (drag.kind === "path-vertex") {
      const pathSel = pathInfo();
      if (!pathSel) return true;
      const L = localOf(pathSel.bone, p.x, p.y);
      drag.x = Math.round(L.x * 100) / 100;
      drag.y = Math.round(L.y * 100) / 100;
    } else if (drag.kind === "poly-vertex") {
      const poly = polyInfo();
      if (!poly) return true;
      const L = localOf(poly.bone, p.x, p.y);
      drag.x = Math.round(L.x * 100) / 100;
      drag.y = Math.round(L.y * 100) / 100;
    } else {
      const info = imageInfo();
      if (!info) return true;
      const f = frameOf(info.att);
      const L = localOf(info.bone, p.x, p.y);
      if (drag.kind === "att-move") {
        drag.x = L.x - drag.grab[0];
        drag.y = L.y - drag.grab[1];
      } else if (drag.kind === "att-rotate") drag.rotation = norm(drag.rot0 + (Math.atan2(L.y - f.y, L.x - f.x) * 180) / Math.PI - drag.ang0);
      else {
        const ratio = Math.max(0.02, (Math.hypot(L.x - f.x, L.y - f.y) || 1) / drag.d0);
        drag.scaleX = drag.s0[0] * ratio;
        drag.scaleY = drag.s0[1] * ratio;
      }
      const g = drag;
      live = { image: { slot: info.slot, name: info.name, f: { ...f, ...(g.kind === "att-move" ? { x: g.x, y: g.y } : g.kind === "att-rotate" ? { rotation: g.rotation } : { scaleX: g.scaleX, scaleY: g.scaleY }) } } };
    }
    host.redraw();
    if (live) host.repose(); // the dragged bone shows on the skeleton now, not only as the ghost line
    return true;
  }

  function pointerUp(): boolean {
    const sub = on ? activeSub() : undefined;
    if (sub) return !!sub.pointerUp?.(ctx);
    if (!on || !drag) return false;
    const d = drag;
    drag = null;
    if (d.kind === "new" || d.kind === "box") clearLive();
    host.redraw();
    if (d.kind === "box") {
      boxSelect(d);
      return true;
    }
    if (d.kind === "new") {
      if (Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) * host.zoom() < 6) return true;
      void addBone({ parent: d.parent, from: d.from, to: d.to });
    } else {
      // The live pose stays on screen until the commit has replaced the rig (no snap back to the old pose in between).
      const done =
        d.kind === "move" ? (d.others ? transformBones("Move", [{ name: d.bone, t: { x: d.x, y: d.y } }, ...d.others.map((o) => ({ name: o.name, t: { x: o.x, y: o.y } }))]) : transformBone(d.bone, { x: d.x, y: d.y }))
        : d.kind === "rotate" ? (d.ik ? transformIkBone(d.bone, d.rotation, d.ik) : d.others ? transformBones("Rotate", [{ name: d.bone, t: { rotation: d.rotation } }, ...d.others.map((o) => ({ name: o.name, t: { rotation: o.rotation } }))]) : transformBone(d.bone, { rotation: d.rotation }))
        : d.kind === "scale" ? transformBone(d.bone, { scaleX: d.scaleX, scaleY: d.scaleY })
        : d.kind === "shear" ? transformBone(d.bone, { shearX: d.shearX, shearY: d.shearY })
        : d.kind === "length" ? (d.others ? transformBones("Length of", [{ name: d.bone, t: { length: d.length } }, ...d.others.map((o) => ({ name: o.name, t: { length: o.length } }))]) : transformBone(d.bone, { length: d.length }))
        : d.kind === "poly-vertex" ? editPolygon(d.slot, d.name, { kind: "move", index: d.index, x: d.x, y: d.y })
        : d.kind === "path-vertex" ? editPath(d.slot, d.name, { kind: "move", index: d.index, x: d.x, y: d.y })
        : d.kind === "att-move" ? transformImage({ x: d.x, y: d.y })
        : d.kind === "att-rotate" ? transformImage({ rotation: d.rotation })
        : transformImage({ scaleX: d.scaleX, scaleY: d.scaleY });
      void done.finally(() => {
        clearLive();
        host.repose();
        host.redraw();
      });
    }
    return true;
  }

  function drawOverlay(g: Graphics, px: number): void {
    const sk = host.skeleton();
    if (!sk) return;
    const sel = host.selected();
    const targets = new Set(ikConstraints(host.rig()?.raw ?? {}).map((c) => c.target));
    if (host.drawBones) host.drawBones(px, hideHelpers);
    else for (const b of sk.bones) {
      const name = b.data.name;
      if (name === "root") continue;
      const helper = b.data.helper === true;
      if (helper && hideHelpers) continue;
      const own = colorHex(b.data.color);
      const isSel = name === sel;
      const color = isSel ? 0xf0b84a : (own ?? (helper ? 0x7e8aa0 : 0xd8dde6));
      const alpha = isSel ? 1 : helper ? 0.5 : 0.85;
      const t = tipOf(b);
      if (b.data.length > 0) g.moveTo(b.world.x, b.world.y).lineTo(t.x, t.y).stroke({ width: (isSel ? 4 : 2.5) * px, color, alpha });
      g.circle(b.world.x, b.world.y, (isSel ? 5 : 3.5) * px).fill({ color, alpha });
      if (targets.has(name)) g.circle(b.world.x, b.world.y, 8 * px).stroke({ width: 1.5 * px, color: 0x5fb3ff, alpha: 0.9 });
    }
    const bone = sel ? sk.findBone(sel) : undefined;
    if (bone && (tool === "scale" || tool === "shear")) drawHandles(g, tool, handleFrame(bone, getSpace(), HANDLE_PX * px), px, drag?.kind === "scale" || drag?.kind === "shear" ? drag.axis : null);
    if (bone && (tool === "select" || tool === "rotate" || tool === "move" || tool === "length")) {
      const gold = 0xf0b84a;
      const t = tipOf(bone);
      if (tool === "select" || tool === "rotate") g.circle(bone.world.x, bone.world.y, RING * px).stroke({ width: (tool === "rotate" ? 2.5 : 1.5) * px, color: gold, alpha: tool === "rotate" ? 0.9 : 0.45 });
      if (tool === "select" || tool === "move") g.circle(bone.world.x, bone.world.y, 9 * px).stroke({ width: 2 * px, color: gold });
      if (tool === "select" || tool === "length") g.rect(t.x - 5 * px, t.y - 5 * px, 10 * px, 10 * px).fill({ color: gold });
      if (tool === "move") {
        const arm = (dx: number, dy: number, color: number): void => {
          const x1 = bone.world.x + dx * ARM * px;
          const y1 = bone.world.y + dy * ARM * px;
          g.moveTo(bone.world.x, bone.world.y).lineTo(x1, y1).stroke({ width: 3 * px, color });
          g.poly([x1 + dx * 9 * px, y1 + dy * 9 * px, x1 - dy * 5 * px, y1 + dx * 5 * px, x1 + dy * 5 * px, y1 - dx * 5 * px]).fill({ color });
        };
        const fr = axisFrame(bone, getSpace());
        arm(fr.ux[0], fr.ux[1], 0xe5484d);
        arm(fr.uy[0], fr.uy[1], 0x3fcf8e);
      }
      // Rotate: a tick on the ring at the chosen space's zero direction (none for Local, whose zero is the bone's own line).
      if (tool === "rotate" || tool === "select") drawRotateRef(g, bone, bone.world, getSpace(), RING * px, px);
    }
    drawPoints(g, px, sk);
    drawPolygons(g, px);
    const info = tool === "attachment" || slotSel ? imageInfo() : null;
    if (info && info.att["type"] !== "point") {
      let f = frameOf(info.att);
      if (drag?.kind === "att-move") f = { ...f, x: drag.x, y: drag.y };
      else if (drag?.kind === "att-rotate") f = { ...f, rotation: drag.rotation };
      else if (drag?.kind === "att-scale") f = { ...f, scaleX: drag.scaleX, scaleY: drag.scaleY };
      const c = [regionWorld(info.bone, f, -f.w / 2, -f.h / 2), regionWorld(info.bone, f, f.w / 2, -f.h / 2), regionWorld(info.bone, f, f.w / 2, f.h / 2), regionWorld(info.bone, f, -f.w / 2, f.h / 2)];
      g.moveTo(c[0]!.x, c[0]!.y);
      for (const q of [c[1]!, c[2]!, c[3]!, c[0]!]) g.lineTo(q.x, q.y);
      g.stroke({ width: 1.5 * px, color: 0x6bd68f, alpha: tool === "attachment" ? 0.95 : 0.5 });
      if (tool === "attachment") {
        const h = handles(info.bone, f);
        g.moveTo(h.top.x, h.top.y).lineTo(h.rot.x, h.rot.y).stroke({ width: 1.5 * px, color: 0x6bd68f });
        g.circle(h.rot.x, h.rot.y, 6 * px).fill({ color: 0x6bd68f });
        g.rect(h.corner.x - 5 * px, h.corner.y - 5 * px, 10 * px, 10 * px).fill({ color: 0x6bd68f });
        g.circle(h.centre.x, h.centre.y, 3.5 * px).fill({ color: 0x6bd68f });
      }
    }
    activeSub()?.drawOverlay?.(g, px, ctx);
    if (drag?.kind === "box") {
      const x = Math.min(drag.from[0], drag.to[0]);
      const y = Math.min(drag.from[1], drag.to[1]);
      g.rect(x, y, Math.abs(drag.to[0] - drag.from[0]), Math.abs(drag.to[1] - drag.from[1])).fill({ color: 0x5fb3ff, alpha: 0.12 }).stroke({ width: 1.5 * px, color: 0x5fb3ff, alpha: 0.9 });
    }
    if (drag) drawGhost(g, px, sk);
  }

  function drawGhost(g: Graphics, px: number, sk: Skeleton): void {
    if (!drag) return;
    const ghost = 0x5fb3ff;
    if (drag.kind === "new") {
      g.moveTo(drag.from[0], drag.from[1]).lineTo(drag.to[0], drag.to[1]).stroke({ width: 3 * px, color: ghost });
      g.circle(drag.from[0], drag.from[1], 5 * px).fill({ color: ghost });
      return;
    }
    if (drag.kind !== "move" && drag.kind !== "rotate" && drag.kind !== "length") return;
    const b = sk.getBone(drag.bone);
    const x = drag.kind === "move" ? drag.x : b.data.x;
    const y = drag.kind === "move" ? drag.y : b.data.y;
    const rot = drag.kind === "rotate" ? drag.rotation : b.data.rotation;
    const len = drag.kind === "length" ? drag.length : b.data.length;
    const o = b.parent ? b.parent.localToWorld(x, y, { x: 0, y: 0 }) : { x, y };
    const ang = (((b.parent ? b.parent.worldRotationX : 0) + mirror(b.parent) * rot) * Math.PI) / 180;
    g.moveTo(o.x, o.y).lineTo(o.x + Math.cos(ang) * len, o.y + Math.sin(ang) * len).stroke({ width: 3 * px, color: ghost });
    g.circle(o.x, o.y, 5 * px).fill({ color: ghost });
  }

  // -------------------------------------------------------------------------------------------
  // Chrome: HUD, bone list, panel
  // -------------------------------------------------------------------------------------------

  function renderHud(): void {
    const hud = $("setuphud");
    hud.replaceChildren();
    // The tools are the one palette (toolPalette.ts); it asks setupState() for the current one. This row keeps Undo / Redo (and Save rig, pinned beside it).
    const hist = host.rig() ? session() : null;
    const lastDone = hist?.done[hist.done.length - 1]?.label;
    const lastUndone = hist?.undone[hist.undone.length - 1]?.label;
    const undo = el("button", { textContent: "Undo", title: lastDone ? `Undo: ${lastDone} (Ctrl+Z)` : "Nothing to undo (Ctrl+Z)" });
    undo.id = "setup-undo";
    undo.addEventListener("click", () => void step("undo"));
    const redo = el("button", { textContent: "Redo", title: lastUndone ? `Redo: ${lastUndone} (Ctrl+Y)` : "Nothing to redo (Ctrl+Y)" });
    redo.id = "setup-redo";
    redo.addEventListener("click", () => void step("redo"));
    const saveBtn = el("button", { className: "btn-primary", textContent: unsaved() ? `Save rig (${unsaved()})` : "Save rig", title: "Write the Setup edits into the rig document through its command log (Ctrl+S)" });
    saveBtn.id = "setupsave";
    saveBtn.addEventListener("click", () => void save());
    hud.append(undo, redo);
    announceTools();
    // Save rig is pinned at the right end of the canvas toolbar, outside #setuphud, so the toolbar's "..." overflow never takes it.
    let pin = document.getElementById("setupsavebox");
    if (!pin) {
      pin = el("div", { className: "hud", id: "setupsavebox" });
      document.getElementById("vtop")?.append(pin);
    }
    pin.replaceChildren(saveBtn);
  }

  // The Axes choice redraws the move arms and the rotate reference tick.
  onSpace(() => {
    if (on) host.redraw();
  });

  function renderBoneHint(): void {
    $("setuphint").textContent = (TOOLS.find((t) => t.id === tool) ?? subTools.get(tool as SetupSubToolId))?.hint ?? "";
  }

  function decorateRow(row: HTMLElement, name: string): void {
    const rig = host.rig();
    const data = list(rig?.raw["bones"]).find((b) => b["name"] === name);
    if (data?.["helper"] === true) row.classList.add("helper");
    if (typeof data?.["color"] === "string") row.prepend(el("span", { className: "dot", style: `background:#${(data["color"] as string).slice(0, 6)}` }));
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop");
      const dragged = e.dataTransfer?.getData("text/plain");
      if (dragged && dragged !== name) void reparent(dragged, name);
    });
  }

  const field = (label: string, ...nodes: (Node | string)[]) => [el("span", { className: "label", textContent: label }), el("span", { className: "v" }, ...nodes)];
  function num(value: number, step: string, onChange: (v: number) => void, width = 62): HTMLInputElement {
    const input = el("input", { type: "number", step, value: fieldText(value, step), style: `width:${width}px` });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onChange(v);
      else input.value = String(value);
    });
    return input;
  }
  function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = el("select", { style: "max-width:150px" });
    for (const o of options) s.append(el("option", { value: o.value, textContent: o.label, selected: o.value === value }));
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  /** The controls the Rig-panel sections (setupRigUi.ts) share with this module. */
  const rigUi: RigUi = {
    run: (label, make) => run(label, make),
    status: (text, kind) => host.status(text, kind),
    el,
    field,
    num,
    select,
    ask: (o) => confirmDialog(o)
  };
  const confirmRemove = (kind: ConstraintKind, name: string): void => {
    void confirmDialog({ title: `Remove ${name}?`, message: `Remove the ${kind === "ik" ? "IK" : kind === "transform" ? "transform" : kind === "path" ? "path" : "physics"} constraint "${name}"? Undo brings it back.`, confirmLabel: "Remove constraint", danger: true, id: "remove-constraint-dialog" }).then((ok) => ok && removeConstraint(kind, name));
  };
  /** Steps Undo / Redo until the rig is exactly what the file has. Redo brings the reverted edits back. */
  async function revertRig(ask: boolean): Promise<number> {
    const n = unsaved();
    if (!n) {
      host.status("Nothing to revert: the rig matches its saved file");
      return 0;
    }
    if (ask && !(await confirmDialog({ title: "Revert the rig?", message: `Revert the rig to the saved file? ${n} unsaved edit${n === 1 ? "" : "s"} are undone (Redo brings them back).`, confirmLabel: "Revert rig", danger: true, id: "revert-rig-dialog" }))) return 0;
    const s = session();
    for (let guard = 0; unsaved() > 0 && guard < 500; guard++) {
      const active = s.done.map((e) => e.commands);
      let common = 0;
      while (common < s.saved.length && common < active.length && s.saved[common] === active[common]) common++;
      const before = `${s.done.length}/${s.undone.length}`;
      await step(s.done.length > common ? "undo" : "redo");
      if (`${s.done.length}/${s.undone.length}` === before) break;
    }
    host.status(`Reverted ${n} unsaved edit${n === 1 ? "" : "s"}: the rig matches its saved file (Redo brings them back)`, "ok");
    return n;
  }

  /** Is the inspector's node still in the rig? Falls back to the bone page. */
  function validNode(raw: JsonObject): NodeSel {
    const n = node;
    const rig = host.rig();
    const hasSlot = (name: string) => list(raw["slots"]).some((s) => s["name"] === name);
    if (n.kind === "slot" && !hasSlot(n.slot)) return { kind: "bone" };
    if (n.kind === "attachment") {
      if (!hasSlot(n.slot)) return { kind: "bone" };
      if (!rig || !(n.name in imageAtts(raw, rig.skin, n.slot))) return { kind: "slot", slot: n.slot };
    }
    if (n.kind === "constraint" && !list(raw[n.ckind]).some((c) => c["name"] === n.name)) return { kind: "bone" };
    if (n.kind === "skin" && !(isObj(raw["skins"]) && n.name in raw["skins"])) return { kind: "bone" };
    if (n.kind === "event" && n.name && !(n.name in declaredEvents(raw)) && !(EVENT_NAMES as readonly string[]).includes(n.name)) return { kind: "event" };
    return n;
  }
  const imageAtts = (raw: JsonObject, skin: string, slot: string): JsonObject => {
    const skinDef = isObj(raw["skins"]) && isObj(raw["skins"][skin]) ? (raw["skins"][skin] as JsonObject) : {};
    const all = isObj(skinDef["attachments"]) ? (skinDef["attachments"] as JsonObject) : {};
    return isObj(all[slot]) ? (all[slot] as JsonObject) : {};
  };

  function showNode(next: NodeSel): void {
    node = next;
    if (next.kind === "slot") {
      slotSel = next.slot;
      attSel = null;
    } else if (next.kind === "attachment") {
      slotSel = next.slot;
      attSel = next.name;
    }
    renderPanel();
    host.renderBones();
    host.redraw();
  }

  function pageCtx(rig: SetupRig, nd: NodeSel): PageCtx {
    return {
      ui: rigUi,
      raw: rig.raw,
      skin: rig.skin,
      regions: rig.regions,
      bone: host.selected(),
      slot: nd.kind === "slot" || nd.kind === "attachment" ? nd.slot : slotSel,
      att: nd.kind === "attachment" ? nd.name : attSel,
      image: () => {
        const info = imageInfo();
        return info ? { name: info.name, att: info.att } : null;
      },
      nav: showNode,
      preset: (n) => void (node = n),
      selectBone: (name) => {
        host.select(name);
        showNode({ kind: "bone" });
      },
      rerender: renderPanel,
      openSection: (id) => {
        setSectionOpen(id, true);
        renderPanel();
      },
      act: {
        openImages: () => openImagesDock(),
        transformBone: (name, t) => void transformBone(name, t),
        renameBone,
        reparent: (name, parent) => void reparent(name, parent),
        boneProps: (name, p) => void boneProps(name, p),
        deleteBone: (name) => void deleteBonesConfirmed(host.selected() === name && (getHost()?.boneSelection().names.length ?? 0) > 1 ? getHost()!.boneSelection().names : [name]),
        setGround: () => void setGroundHere(),
        autoBind: () => void autoBindSlots(),
        rebindSlot: (slot, bone) => void rebindSlot(slot, bone),
        setDefault: (slot, name) => void setDefault(slot, name),
        removeImage: (slot, name) => void removeImage(slot, name),
        addPoint: (slot, preset) => void addPoint(slot, preset),
        addPolygon: (slot, kind) => void addPolygon(slot, kind),
        addPath: (slot) => void addPath(slot),
        editPath: (slot, name, e) => void editPath(slot, name, e),
        editPolygon: (slot, name, e) => void editPolygon(slot, name, e),
        makeSequence: (paths) => void makeSequence(paths),
        setSequence: (slot, name, fields) => void setSequence(slot, name, fields),
        linkMesh: (slot, name, o) => void linkMesh(slot, name, o),
        transformImage: (t) => void transformImage(t),
        attachRegion: (path, o) => void attachRegion(path, o),
        attachFile: (file, o) => {
          const reader = new FileReader();
          reader.onload = () => void attachPng(String(reader.result), { slot: o.slot ?? null, name: file.name.replace(/\.png$/i, "") });
          reader.readAsDataURL(file);
        },
        setConstraint: (kind, name, fields) => void setConstraint(kind, name, fields),
        removeConstraint: confirmRemove,
        setTool: (t) => setTool(t),
        previewAngle: (bone, deg) => setPreviewAngle(bone, deg),
        relinkArt: (slot, name, file, mode) => void relinkArt(slot, name, file, mode),
        reloadArt: (slot, name, mode) => void reloadArt(slot, name, mode),
        sculpt: (t) => {
          beginSculpt(t);
          setTool("sculpt");
        },
        status: (text, kind) => host.status(text, kind)
      }
    };
  }

  function renderPanel(): void {
    const box = $("setuppanel");
    box.replaceChildren();
    const rig = host.rig();
    if (!on || !rig) return void refreshImagesDock();
    if (rig.standIn) {
      box.append(el("h2", { textContent: "Setup" }), el("div", { className: "note", textContent: "This view adds an in-memory weapon to the rig file, so its document is not the file. Open another view to edit the rig." }));
      return;
    }
    const raw = rig.raw;
    const sel = host.selected();
    const slots = list(raw["slots"]);
    if (slotSel && !slots.some((s) => s["name"] === slotSel)) slotSel = null;
    node = validNode(raw);
    const nd = node;
    const ctxNow = pageCtx(rig, nd);

    // Registered tool (Mesh, Weights): its panel goes above the inspector, which folds away so the tool's own controls stay on screen.
    const subPanel = activeSub()?.panel;
    const folded = !!activeSub();
    const insp = el("div", { className: `insp${folded ? " insp-flat" : ""}`, id: "inspector" });
    let page: Page | null = null;
    if (nd.kind === "event") page = eventsPage(ctxNow, nd.name ?? null, (name) => ctxNow.nav({ kind: "event", ...(name ? { name } : {}) }));
    else if (nd.kind === "skin") page = skinPage(ctxNow, nd.name, getHost()?.wornSkins() ?? [], (names) => getHost()?.setActiveSkins(names));
    else if (nd.kind === "constraint") page = constraintPage(ctxNow, nd.ckind, nd.name);
    else if (nd.kind === "attachment") page = attachmentPage(ctxNow);
    else if (nd.kind === "slot" && slotSel) page = slotPage(ctxNow);
    else if (sel && list(raw["bones"]).some((b) => b["name"] === sel)) page = bonePage(ctxNow, getHost()?.boneSelection().names ?? [sel]);
    if (!page) {
      insp.append(el("div", { className: "insp-empty note", textContent: "Select a bone in the Tree or the view. With Create bone, drag in the view to add one under the selected bone." }), el("div", { className: "insp-body" }, contractSection(rigUi, raw, renderPanel)));
    } else {
      const body = el("div", { className: "insp-body" });
      body.append(...page.sections, contractSection(rigUi, raw, renderPanel), editsSection());
      insp.append(page.head, body);
      if (page.foot.length) insp.append(el("div", { className: "insp-foot" }, ...page.foot));
    }
    if (subPanel) {
      const subBox = el("div", { className: "setup-subtool" });
      subPanel(subBox, ctx);
      box.append(subBox);
    }
    if (folded) {
      const out = el("details", { className: "setup-fold", id: "setup-fold", open: restOpen });
      out.append(el("summary", { title: "Show or hide the bone, slot and constraint settings of this tool" }, el("span", { textContent: "Bone, slots and constraints" }), el("span", { className: "setup-fold-sel", textContent: sel ?? "no bone" })), insp);
      out.addEventListener("toggle", () => (restOpen = out.open));
      box.append(out);
    } else box.append(insp);
    refreshImagesDock();
  }

  /** The rig-wide Edits card: the last few edits and Revert (the rig file's undo log). */
  function editsSection(): HTMLElement {
    const s = session();
    const log = el("div", { className: "editlog" });
    for (const e of s.done.slice(-3).reverse()) log.append(el("div", { textContent: e.label, title: e.commands.map((c) => c.op).join(", ") }));
    if (!s.done.length) log.append(el("div", { className: "label", textContent: "No Setup edits yet." }));
    return section({ id: "rig.edits", title: "Edits", meta: `${s.done.length}, ${unsaved()} unsaved`, tip: "the last Setup edits of this rig, and Revert to the saved file", open: false, body: [log, el("div", { className: "insp-line" }, revertButton(rigUi, unsaved(), () => void revertRig(true)))] });
  }

  function renderAll(): void {
    renderHud();
    renderBoneHint();
    renderPanel();
    host.renderBones();
    host.redraw();
  }

  function setTool(requested: Tool): void {
    const next: Tool = requested === "transform" ? "select" : requested;
    const was = activeSub();
    tool = next;
    lastHint = "";
    const view = document.getElementById("view");
    if (view) view.style.cursor = next === "bone" ? "crosshair" : "";
    const def = TOOLS.find((x) => x.id === next);
    if (def && on) host.status(`${def.label}: ${def.hint.split(". ")[0]}`);
    drag = null;
    const now = activeSub();
    if (was !== now) {
      was?.deactivate?.(ctx);
      now?.activate?.(ctx);
    }
    renderHud();
    renderBoneHint();
    if (was || now) renderPanel();
    host.redraw();
  }

  async function setMode(next: "animate" | "setup"): Promise<void> {
    const want = next === "setup";
    if (want === on) return;
    if (want && host.rig()?.standIn) {
      host.status("Setup mode edits the rig file; this fixture adds an in-memory weapon, so open another view first", "bad");
      return;
    }
    host.stopPlayback();
    on = want;
    setCoverMemo(on); // Setup edits rebuild the rig on a still pose: remember the coverage intervals across rebuilds
    drag = null;
    if (!on) {
      activeSub()?.deactivate?.(ctx);
      preview = null;
    } else activeSub()?.activate?.(ctx);
    document.body.classList.toggle("setup", on);
    refreshImagesDock();
    for (const b of $("modeseg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === next);
    if (on) await ensureBase();
    renderAll();
    host.repose();
    host.status(on ? "Setup mode: the rig is shown in its setup pose; edits go to the rig, not to a clip" : "Animate mode");
  }

  function key(e: KeyboardEvent): boolean {
    if (!on) return false;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === "z") {
      e.preventDefault();
      void step(e.shiftKey ? "redo" : "undo");
    } else if (mod && k === "y") {
      e.preventDefault();
      void step("redo");
    } else if (mod && k === "s") {
      e.preventDefault();
      void save();
    } else if (!mod && (k === "delete" || k === "backspace")) {
      const names = getHost()?.boneSelection().names ?? [];
      const sel = host.selected();
      if (names.length || sel) void deleteBonesConfirmed(names.length ? names : [sel!]);
    } else if (k === "escape") {
      // Esc cancels a drag or a sub-tool's own gesture; with nothing to cancel it falls through to the shared Clear selection.
      const wasDragging = drag !== null;
      drag = null;
      const used = activeSub()?.onKey?.(e, ctx) === true;
      host.redraw();
      if (!wasDragging && !used) return false;
    } else if (!mod && !e.altKey && !e.shiftKey) {
      if (activeSub()?.onKey?.(e, ctx)) return true;
      const t = [...TOOLS, ...subTools.values()].find((x) => x.key.toLowerCase() === k);
      if (!t) return false; // not a Setup key: the shared hotkeys (F, Shift+F, ?, F1) get it
      setTool(t.id);
    } else return false;
    return true;
  }

  function onSelect(): void {
    if (on) {
      const sel = host.selected();
      const rig = host.rig();
      if (preview && sel !== preview.bone && tool !== "sculpt") {
        preview = null;
        host.repose();
      }
      // Picking a bone (Tree row, canvas) returns the inspector to the bone page; a Tree slot / constraint pick selects its node afterwards.
      const leaving = !keepNode && node.kind !== "bone";
      if (!keepNode) node = { kind: "bone" };
      if (leaving) host.renderBones();
      if (sel && rig) {
        const slot = list(rig.raw["slots"]).find((s) => s["bone"] === sel);
        if (slot && (!slotSel || list(rig.raw["slots"]).find((s) => s["name"] === slotSel)?.["bone"] !== sel)) {
          slotSel = String(slot["name"]);
          attSel = null;
        }
      }
      if (sel && !drag) {
        const c = ikDriving(sel);
        if (c) host.status(`${sel} is driven by IK '${c.name}': rotating it moves the target ${c.target}`);
      }
      renderPanel();
    }
  }

  // The bottom dock (Images / Edits / Draw order) works through these seams.
  const dockCtx: DockCtx = {
    rigKey: () => host.rig()?.outfitId ?? "",
    regions: () => host.rig()?.regions ?? [],
    image: (path) => host.rig()?.image?.(path),
    attach: attachState,
    target: () => ({ slot: node.kind === "slot" || node.kind === "attachment" ? node.slot : null, bone: host.selected() }),
    attachRegion: (path, o) => void attachRegion(path, { slot: o.slot, ...(o.bone ? { bone: o.bone } : {}) }),
    makeSequence: (paths) => void makeSequence(paths),
    attachSequenceFiles: (fileList, o) => void Promise.all(fileList.map(async (f) => ({ name: f.name, dataUrl: await readDataUrl(f) }))).then((items) => importSequencePngs(items, o)),
    attachFile: (file, o) => {
      const reader = new FileReader();
      reader.onload = () => void attachPng(String(reader.result), { slot: o.slot, name: file.name.replace(/.png$/i, "") });
      reader.readAsDataURL(file);
    },
    status: (text, kind) => host.status(text, kind),
    edits: () => (host.rig() ? session().done.map((e) => e.label) : []),
    unsaved: () => (host.rig() ? unsaved() : 0),
    revert: () => void revertRig(true),
    raw: () => host.rig()?.raw ?? null,
    run: (label, make) => run(label, make),
    active: () => on
  };
  installImagesDock(() => dockCtx);

  // wire the static chrome
  for (const b of $("modeseg").querySelectorAll("button")) b.addEventListener("click", () => void setMode(b.dataset.mode as "animate" | "setup"));

  return {
    active: () => on,
    setMode,
    pointerDown,
    pointerMove,
    pointerUp,
    applyLive,
    key,
    drawOverlay,
    drawPolygons,
    decorateRow,
    onSelect,
    /**
     * This tab wrote the rig file itself (a skins save, an Apply): `hash` is the file's new hash, so the next Save rig still refuses a
     * file another tab changed. Without a hash the next save fetches it again.
     */
    rebase: (hash?: string | null) => {
      const rig = host.rig();
      const s = rig ? sessions.get(rig.outfitId) : undefined;
      if (s) s.base = hash ?? null;
    },
    /** The hash of the rig file text this tab last read or wrote (the skins save sends it as its compare-and-swap base). */
    baseHash: async (): Promise<string | null> => {
      await ensureBase();
      const rig = host.rig();
      return (rig ? sessions.get(rig.outfitId)?.base : null) ?? null;
    },
    undo: () => step("undo"),
    redo: () => step("redo"),
    save,
    /** The edits of the open rig the file does not have yet (autosave): the batches to apply, and how many saved ones were undone. Null when none. */
    unsavedEdits: (): { batches: Command[][]; undo: number } | null => {
      const s = sessions.get(host.rig()?.outfitId ?? "");
      if (!s) return null;
      const active = s.done.map((e) => e.commands);
      let common = 0;
      while (common < s.saved.length && common < active.length && s.saved[common] === active[common]) common++;
      const undo = s.saved.length - common;
      const batches = active.slice(common);
      return undo || batches.length ? { batches, undo } : null;
    },
    /** Applies saved batches again (restoring an autosave) as undoable Setup edits; returns how many applied. */
    replayEdits: async (batches: Command[][]): Promise<number> => {
      let applied = 0;
      for (const commands of batches) if (await run("Restored edit", () => ({ commands }))) applied++;
      return applied;
    },
    /** window.atlasEditor additions. */
    api: {
      setMode,
      mode: () => (on ? "setup" : "animate"),
      setupTool: setTool,
      autoBind: autoBindSlots,
      setGround: setGroundHere,
      bindSlot: rebindSlot,
      /** Sets the two keeps separately (Compensate > Bones / Images); an omitted one stays as it is. */
      setupKeep: (v: { bones?: boolean; images?: boolean }) => {
        if (v.bones !== undefined) keepBones = v.bones;
        if (v.images !== undefined) keepImages = v.images;
        if (v.bones !== undefined || v.images !== undefined) renderAll();
        return { bones: keepBones, images: keepImages };
      },
      setupKeepImages: (v: boolean) => {
        keepImages = keepBones = v;
        renderAll();
      },
      setupHideHelpers: (v: boolean) => {
        hideHelpers = v;
        renderHud();
        host.redraw();
      },
      setupSelectSlot: (slot: string | null, attachment?: string | null) => {
        slotSel = slot;
        attSel = attachment ?? null;
        node = slot ? (attachment ? { kind: "attachment", slot, name: attachment } : { kind: "slot", slot }) : { kind: "bone" };
        renderPanel();
        host.renderBones();
        host.redraw();
      },
      /** The node the Rig inspector shows, and a way to show another one (the Tree uses these through the host). */
      setupNode: (): NodeSel => node,
      setupSelectNode: (n: NodeSel) => {
        if (on) showNode(n);
        else node = n;
      },
      /** Opens (or closes) an inspector section by id, e.g. "slot.attach" (the Attach image block). */
      inspectorOpen: (id: string, open = true) => {
        setSectionOpen(id, open);
        renderPanel();
      },
      setupState: () => {
        const s = host.rig() ? session() : null;
        return { active: on, tool, keepImages, keepBones, slot: slotSel, attachment: attSel, edits: s?.done.map((e) => e.label) ?? [], undoable: s?.done.length ?? 0, redoable: s?.undone.length ?? 0, unsaved: unsaved(), busy };
      },
      /** Forgets the Setup undo history and saved-batch bookkeeping of the open rig (after its file was replaced on disk, e.g. a Spine import). */
      setupResetSession: () => void sessions.delete(rigNow().outfitId),
      /** A rig was (re)mounted: for a different rig forget the old rig's slot / image selection; either way redraw the Rig panel from the new one. */
      rigSwitched: (differentRig = true) => {
        if (differentRig) {
          slotSel = null;
          attSel = null;
          node = { kind: "bone" };
        }
        renderAll();
      },
      setupRaw: () => (host.rig() ? structuredClone(host.rig()!.raw) : null),
      setupLog: () => session().done.map((e) => ({ label: e.label, commands: e.commands })),
      setupRun: run,
      setupAddBone: addBone,
      setupDeleteBone: deleteBone,
      setupReparent: reparent,
      setupRename: renameBone,
      setupTransform: transformBone,
      setupBoneProps: boneProps,
      setupAttachRegion: attachRegion,
      setupAddPoint: addPoint,
      setupAddPolygon: addPolygon,
      setupAddPath: addPath,
      setupEditPath: editPath,
      setupMakeSequence: makeSequence,
      setupLinkMesh: linkMesh,
      setupAttachPng: attachPng,
      setupImportSequence: importSequencePngs,
      setupEditPolygon: editPolygon,
      setupPlaceImage: transformImage,
      setupDefaultImage: setDefault,
      setupRemoveImage: removeImage,
      setupConstraint: setConstraint,
      setupRemoveConstraint: removeConstraint,
      setupAddIk: addIk,
      setupRevert: () => revertRig(false),
      setupUndo: () => step("undo"),
      setupRedo: () => step("redo"),
      setupSave: save,
      setupScreen: (x: number, y: number) => host.toClient(x, y),
      setupBoneWorld: (name: string) => {
        const b = host.skeleton()?.findBone(name);
        if (!b) return null;
        const t = tipOf(b);
        return { origin: { x: b.world.x, y: b.world.y }, tip: { x: t.x, y: t.y }, angle: b.worldRotationX };
      },
      setupImageHandles: () => {
        const info = imageInfo();
        if (!info) return null;
        const h = handles(info.bone, frameOf(info.att));
        return { centre: h.centre, rotate: h.rot, scale: h.corner };
      }
    }
  };
}

export type Setup = ReturnType<typeof createSetup>;
