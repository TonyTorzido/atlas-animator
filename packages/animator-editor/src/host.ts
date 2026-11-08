/*
 * Atlas Animator editor: the seam between main.ts and the project-tailored UI modules (the design notes, Phase 0).
 *
 * main.ts builds one EditorHost in boot() and hands it to `setHost`. Every new feature module (workspaces, home, clip board, swag
 * workshop ...) talks to the editor only through it, so main.ts stays the one file that knows the editor's internals.
 * No DOM and no Pixi imports here beyond types, so the module is cheap to import from tests.
 */
import type { AnimDocument, ClipData, Skeleton } from "@atlas-animator/core/core";
import type { AnimatorCharacter } from "@atlas-animator/core/pixi";
import type { Application, Container, Graphics } from "pixi.js";
import type { Facing } from "./facing.js";
import type { PoseCopy } from "./clipModel.js";
import type { PoseInclude, PoseRecord } from "./poseModel.js";
import type { ViewAids } from "./viewAids.js";
import type { Channel, V2 } from "./transformModel.js";
import type { Layer } from "./canvasTools.js";
import type { Command, JsonObject } from "./setupModel.js";

/**
 * The node the Rig inspector shows: the selected bone (default), or a slot, an attachment, a constraint or a skin picked in the Tree
 * (a slot / attachment / constraint also leaves its bone selected on the canvas).
 */
export type NodeSel =
  | { kind: "bone" }
  | { kind: "slot"; slot: string }
  | { kind: "attachment"; slot: string; name: string }
  | { kind: "constraint"; ckind: "ik" | "transform" | "path" | "physics"; name: string }
  | { kind: "skin"; name: string }
  /** The rig's event definitions (Batch 8b-2); `name` is the event the Tree row picked. */
  | { kind: "event"; name?: string };

export type HostEvent = "clip" | "time" | "pose" | "rig" | "skins" | "save" | "select" | "tool";

/** The open rig, as far as the new UI needs it. */
export interface HostRig {
  outfit: { id: string; label: string };
  doc: AnimDocument;
}

/** The active bone's channels as stored (offsets from setup, in the parent's space) and which are keyed here / changed but unkeyed. */
export interface XformRead {
  bone: string;
  values: { rotate: number; translate: V2; scale: V2; shear: V2 };
  keyed: Record<Channel, boolean>;
  unkeyed: Record<Channel, boolean>;
}

/** The transform strip's and the Pose panel's one door into the editor: read, set (with group moves, Compensate and Auto key) and key a channel. */
export interface XformApi {
  /** The active bone (null in Setup mode or with nothing selected). */
  read(): XformRead | null;
  /** Sets a channel from stored values. `live` (a scrub or wheel in progress) skips Auto key; call `finish` when it ends. */
  set(channel: Channel, x: number, y: number, live?: boolean): void;
  /** Auto key after a live edit. */
  finish(channel: Channel): void;
  /** Keys only that channel of the active bone at the playhead (plus the Compensate children it moved). */
  key(channel: Channel): void;
  /** Keys every channel of the active bone. */
  keyAll(): void;
}

/** The view: pan / zoom state and the editor-only layer visibility. */
export interface ViewApi {
  /** Pixel offset and scale of the world in the view, and the view's size. */
  state(): { x: number; y: number; zoom: number; w: number; h: number };
  zoomTo(z: number): void;
  zoomBy(factor: number): void;
  fit(): void;
  setLayerVisible(layer: Layer, on: boolean): void;
  layerVisible(layer: Layer): boolean;
}

/** Compensate: Bones (children stay put) works in Animate and Setup; Images (images stay put) is Setup only. */
export interface CompensateApi {
  readonly setupMode: boolean;
  /** Animate: children keep their place while a bone moves (keyed offsets). Setup: children keep their place in the rig. */
  readonly bones: boolean;
  readonly images: boolean;
  setBones(on: boolean): void;
  setImages(on: boolean): void;
}

/** One mesh attachment of the open rig, as `host.meshes()` lists it. */
export interface MeshInfo {
  slot: string;
  skin: string;
  /** The attachment's name in the skin. */
  attachment: string;
  vertexCount: number;
  /** True when the mesh carries bone weights (its vertices are skinned to bones). */
  weighted: boolean;
}

/** The pointer position handed to canvas tools: skeleton space, plus screen pixels in the canvas. */
export interface CanvasPoint {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

/**
 * An Animate-mode tool that draws on and listens to the main canvas ("Shape keys" is the first). Registered with `registerCanvasTool`, made
 * current with `host.setCanvasTool(id)`. While it is current, main.ts offers it the pointer, overlay and key events before the bone tools see them.
 */
export interface CanvasTool {
  id: string;
  label: string;
  hint: string;
  /** True for the stand-in panel; a real tool registered under the same id replaces it. */
  placeholder?: boolean;
  activate?(host: EditorHost): void;
  deactivate?(host: EditorHost): void;
  /** Return true when the event was used (the bone tools then skip it). */
  pointerDown?(p: CanvasPoint, e: { shiftKey: boolean; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, host: EditorHost): boolean | void;
  pointerMove?(p: CanvasPoint, host: EditorHost): boolean | void;
  pointerUp?(host: EditorHost): boolean | void;
  /** Draws on the overlay (skeleton space; `px` is one screen pixel in it). */
  drawOverlay?(g: Graphics, px: number, host: EditorHost): void;
  /** Fills the tool's floating panel on the canvas. */
  panel?(box: HTMLElement, host: EditorHost): void;
  onKey?(e: KeyboardEvent, host: EditorHost): boolean | void;
}

export interface EditorHost {
  readonly xform: XformApi;
  readonly view: ViewApi;
  readonly compensate: CompensateApi;
  // Reads (live values: read them when needed, do not cache).
  readonly rig: HostRig | null;
  readonly doc: AnimDocument | null;
  readonly skeleton: Skeleton | null;
  readonly clip: ClipData;
  readonly clipName: string;
  readonly time: number;
  /** True while the editor's transport is playing. */
  readonly playing: boolean;
  /** The facing the main view shows. */
  readonly facing: Facing;
  readonly app: Application;
  /** The Pixi container that holds the character; overlays added next to it follow the view's pan and zoom. */
  readonly world: Container;
  readonly character: AnimatorCharacter | null;
  zoom(): number;
  /** True when auto key is on (a pose applied from the library is then keyed; otherwise it stays an unkeyed edit). */
  readonly autoKey: boolean;
  /** The drawing aids (onion skin, underlay); null before a rig is open. */
  readonly aids: ViewAids | null;
  /** Every bone's offsets from setup as posed now, unkeyed edits included. */
  poseOffsets(): PoseCopy;
  /** The bones selected in the bone list / timeline. */
  selectedBones(): string[];
  /** The pose at the playhead as a library record (bones, attachment swaps, draw order). */
  capturePose(name: string, include?: PoseInclude, only?: readonly string[] | null): PoseRecord;
  /** Shows these offsets as unkeyed pose edits (what dragging the gizmo does before a key is set). */
  previewOffsets(copy: PoseCopy): void;
  /** Asks for a repaint of the canvas (after something drawn behind or over the rig changed). */
  redraw(): void;
  /** Names of the clips in the editor's library, and whether each has unsaved edits. */
  clips(): { name: string; dirty: boolean; origin: string }[];
  /** Names of the clips saved in the clips folder (some may not be in the library until opened). */
  saved(): string[];
  /** Loads a saved clip file (`<name>.clip.json`) into the library and opens it. */
  openSaved(file: string): Promise<void>;

  // Actions.
  switchClip(name: string): void;
  /** Adds a clip to the library (marked unsaved) and opens it. Returns an error text, or null when it worked. */
  newClip(name: string, data: ClipData): string | null;
  mountOutfit(id: string): Promise<void>;
  /** Drops the cached copy of an outfit's rig and mounts it again from disk (after another module saved the rig file). */
  reloadOutfit(id: string): Promise<void>;
  setFacing(facing: Facing): Facing;
  setTime(t: number, snap?: boolean): void;
  /** Poses the shared skeleton at clip time `t` (no edits), for a second view; call `restorePose` when done. */
  poseAt(t: number): void;
  /** Puts the skeleton back to the pose the main view shows (including unkeyed edits). */
  restorePose(): void;
  commit(next: ClipData, message?: string): void;
  setKey(): void;
  play(): void;
  pause(): void;
  mirrorSelection(): void;
  flipPose(): void;
  /** Keys the whole standard pose (every BONE-STANDARD control but the IK targets) at the playhead, whatever is selected. Returns how many bones it keyed. */
  keyPose(): number;
  /** The bones with an edit that is not keyed yet (they snap back on scrub; Esc drops them). */
  readonly unkeyed: readonly string[];
  /** Keys every unkeyed edit at the playhead in one undo step. Returns how many bones it keyed. */
  keyUnkeyed(): number;
  /** Discard unkeyed: drops the unkeyed edits at the playhead (the explicit discard; scrubbing parks them instead). */
  discardUnkeyed(): void;
  undo(): void;
  /** Redoes the step Undo took back. */
  redo(): void;
  /** True when there is an edit to undo. */
  readonly canUndo: boolean;
  /** Breakdown of the selected bones at the slider's percent. */
  breakdown(): void;
  /** Moves the playhead to the previous / next key (of the selected bone, any bone when none is selected). */
  jumpToKey(dir: 1 | -1, anyBone?: boolean): void;
  /** Rebuilds the bone list (after a feature changed what it shows). */
  refreshBones(): void;
  /** The skins worn on top of the base skin now (set by this editor's own Skins panel or the Swag workshop). */
  wornSkins(): string[];
  /** Adds an undo step that is not a clip edit (Ctrl+Z runs `undoFn`, Ctrl+Y runs `redoFn`). */
  pushHistory(label: string, undoFn: () => void, redoFn: () => void): void;
  /** Wears exactly these skins (the base skin is always under them). */
  setActiveSkins(list: string[]): void;
  status(text: string, kind?: "" | "bad" | "ok"): void;
  checkWholeClip(): void;
  /** The selected bones (empty when nothing is selected). */
  selectedBones(): string[];
  /** Selects one bone (replacing the selection) and makes it the active bone. */
  selectBone(name: string): void;
  /** Rig inspector: the node it shows (Setup / Rig), and a way to show another one. Selecting a bone returns it to the bone page. */
  inspectorNode(): NodeSel;
  selectNode(node: NodeSel): void;
  /** The Tree (outliner): the bone selection (active bone and every selected one), and a way to change it. */
  boneSelection(): { active: string | null; names: string[] };
  selectBones(names: string[], mode: "replace" | "add" | "toggle", active?: string): void;
  /** Selects every bone. */
  selectAllBones(): void;
  /** Selects the active bone and every bone below it. */
  selectBranch(): void;
  /** Frames the selected bones in the view (everything when none). */
  frameSelection(): void;
  /** Selects a slot for the slot panel (null clears). */
  selectSlot(slot: string | null): void;
  /**
   * Makes `name` (null = nothing) the slot's visible attachment: keyed at the playhead when Auto key is on in Animate, written as the slot's
   * setup attachment in Setup / Rig. "blocked" means neither applies (Auto key is off): nothing changed.
   */
  swapAttachment(slot: string, name: string | null): "keyed" | "setup" | "blocked";
  /** The id of the current Animate canvas tool (see `registerCanvasTool`), or null. */
  readonly canvasTool: string | null;
  /** Makes a registered canvas tool current (null leaves it). Unknown ids are ignored. */
  setCanvasTool(id: string | null): void;
  /** Hides / shows one slot's art on the canvas (editor-only; a tool hides the slot while it draws a live preview over it). */
  setSlotHidden(slot: string, hidden: boolean): void;
  /** Every mesh attachment in the open rig. */
  meshes(): MeshInfo[];
  /**
   * Replaces one mesh attachment's geometry in the shown rig without rebuilding the whole character (the fast path for live mesh edits).
   * Stub in this version: returns false, and callers then commit through `setupRun`.
   */
  patchMeshGeometry(skin: string, slot: string, attachment: string, geometry: { vertices: number[]; uvs?: number[]; triangles?: number[] }): boolean;
  /** True while Setup mode is on (rig structure edits allowed). */
  readonly setupActive: boolean;
  /** Runs one undoable, saved rig-structure edit through Setup's command path. Resolves false when refused. */
  setupRun(label: string, make: (raw: JsonObject) => { commands: Command[]; bone?: string | null }): Promise<boolean>;
  /** The rig document as the setup command path sees it (a copy), or null. */
  setupRaw(): JsonObject | null;
  /** Re-poses the shown character and redraws the bone overlay (after the Tree changed what the canvas hides or draws). */
  repose(): void;
  /** Repaints the timeline now (after a feature changed what it decorates). */
  redrawTimeline(): void;
  renderSheets(): Promise<unknown>;
  /** What Ship checks: the rig and the open clip, as saved / applied right now (Batch 8a). */
  shipState(): { rig: string | null; rigUnsaved: boolean; clip: string; clipDirty: boolean; clipApplied: boolean; clipJson: string };
  applyToRig(allViews?: boolean): Promise<unknown>;
  /** Saves the open clip; true only when that revision reached the file (validation, conflicts and write errors answer false). */
  saveClip(): Promise<boolean>;

  // Events.
  on(ev: HostEvent, fn: () => void): () => void;
}

const canvasTools = new Map<string, CanvasTool>();
const canvasToolListeners = new Set<() => void>();

/** Registers (or replaces) an Animate canvas tool by id. The returned function removes it. */
export function registerCanvasTool(tool: CanvasTool): () => void {
  canvasTools.set(tool.id, tool);
  for (const fn of [...canvasToolListeners]) fn();
  return () => {
    if (canvasTools.get(tool.id) === tool) canvasTools.delete(tool.id);
    for (const fn of [...canvasToolListeners]) fn();
  };
}

export function getCanvasTool(id: string | null): CanvasTool | undefined {
  return id ? canvasTools.get(id) : undefined;
}

/** Called when a tool is registered or replaced (main.ts redraws the panel of the current one). */
export function onCanvasTools(fn: () => void): () => void {
  canvasToolListeners.add(fn);
  return () => void canvasToolListeners.delete(fn);
}

/** Animate's "Mesh" button is Shape keys. Until that tool lands in a later update this stand-in shows a clear note. */
export const SHAPE_KEYS_ID = "shape-keys";
registerCanvasTool({
  id: SHAPE_KEYS_ID,
  label: "Shape keys",
  hint: "Deform mesh vertices on the current frame.",
  placeholder: true,
  panel(box) {
    const h = document.createElement("div");
    h.className = "ctool-title";
    h.textContent = "Shape keys";
    const note = document.createElement("div");
    note.className = "note";
    note.id = "ctool-coming-shape-keys";
    note.textContent = "Shape keys (deform mesh vertices on this frame): coming in the next update.";
    box.append(h, note);
  }
});

type Listener = () => void;

/** The editor's event bus: main.ts calls `emit` from its pose / clip / rig paths; features subscribe through `host.on`. */
export function createEmitter(): { on(ev: HostEvent, fn: Listener): () => void; emit(ev: HostEvent): void } {
  const listeners = new Map<HostEvent, Set<Listener>>();
  return {
    on(ev, fn) {
      let set = listeners.get(ev);
      if (!set) listeners.set(ev, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
    emit(ev) {
      for (const fn of [...(listeners.get(ev) ?? [])]) {
        try {
          fn();
        } catch (error) {
          console.error(`host listener for "${ev}" threw`, error);
        }
      }
    }
  };
}

let current: EditorHost | null = null;
const waiting: ((h: EditorHost) => void)[] = [];

export function setHost(h: EditorHost): void {
  current = h;
  for (const fn of waiting.splice(0)) fn(h);
}

export function getHost(): EditorHost | null {
  return current;
}

/** Runs `fn` with the host as soon as main.ts has registered it (now, if it already has). */
export function whenHost(fn: (h: EditorHost) => void): void {
  if (current) fn(current);
  else waiting.push(fn);
}

/** Draws extra marks on the timeline canvas (rule ticks ...). `frameX` maps a frame to canvas x; `rulerH` is the ruler's height. */
export type TimelineDecorator = (g: CanvasRenderingContext2D, frameX: (frame: number) => number, width: number, height: number, rulerH: number) => void;
const decorators: TimelineDecorator[] = [];

export function addTimelineDecorator(fn: TimelineDecorator): void {
  decorators.push(fn);
}

/** Called by the timeline after it has drawn its ruler and rows. */
export function decorateTimeline(g: CanvasRenderingContext2D, frameX: (frame: number) => number, width: number, height: number, rulerH: number): void {
  for (const fn of decorators) fn(g, frameX, width, height, rulerH);
}
