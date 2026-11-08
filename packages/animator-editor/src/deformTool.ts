/*
 * Atlas Animator editor: original implementation.
 *
 * Shape keys (MESH-WEIGHTS-PLAN section 3): the Animate canvas tool, id "shape-keys" (the Mesh button / D key). It deforms the vertices of
 * one mesh on the current frame and writes the result as a deform key of the open clip.
 *
 *   - pick vertices on the canvas (click, Shift add, Ctrl toggle, box drag), drag to move; S scales, R rotates, Shift+S squashes the
 *     selection (move the pointer, click to accept, Esc to cancel);
 *   - soft selection: the vertices near the selection follow with a falloff. A radius slider (Alt + mouse wheel too) measured in a straight
 *     line or along the mesh; the ring is drawn on the canvas;
 *   - releasing a drag writes or merges the deform key on this frame (the deformModel API) in ONE `host.commit`. A linked mesh keys its
 *     source mesh and the panel says "shared with <source>";
 *   - Clear deform has three buttons, each one undo step: the selected vertices on this frame, the key on this frame, the whole timeline.
 *
 * The drag shows live by writing the offsets straight into the skeleton's deform array; nothing is committed until the pointer is released.
 * Correctives are shown, not edited: the keys here are the clip's own deform only.
 */
import type { MeshAttachment, Skeleton } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { timeToFrame } from "./clipModel.js";
import { CURVE_LABELS, CURVE_PRESETS, curveKind, type CurveKind } from "./curveModel.js";
import {
  clearDeformTimeline,
  clearVerticesOnFrame,
  deformKeyAt,
  deleteDeformKey,
  expandDeformKey,
  getDeformKeys,
  mergeDeformKey,
  selectionCentre,
  softSelectionWeights,
  dragVertices,
  transformVertices,
  worldPositions,
  type DeformAddress,
  type DeformMesh,
  type DragResult,
  type FalloffMode
} from "./deformModel.js";
import { curveForComp, deformAmountKeys, sampleChannel, setDeformCurve } from "./graphModel.js";
import { registerCanvasTool, SHAPE_KEYS_ID, type CanvasPoint, type CanvasTool, type EditorHost } from "./host.js";
import { adjacency, boxSelect, clickSelect, growSelection, pickVertex, selectAll, shrinkSelection, verticesInBox } from "./vertexSelect.js";

const PICK_PX = 10;
const RADIUS_MIN = 4;
const RADIUS_MAX = 600;

interface Soft {
  on: boolean;
  radius: number;
  mode: FalloffMode;
}

type Modal = "scale" | "rotate" | "squash";

interface Gesture {
  kind: "move" | Modal | "box";
  start: { x: number; y: number };
  centre: { x: number; y: number };
  base: Float64Array;
  positions: Float64Array;
  influence: Float64Array | null;
  dm: DeformMesh;
  mesh: MeshAttachment;
  /** Box: the corner the drag began at and the current one (skeleton space). */
  box?: { x0: number; y0: number; x1: number; y1: number };
  mods?: { shift: boolean; ctrl: boolean };
  live: DragResult | null;
}

const state = {
  target: null as string | null,
  selection: new Set<number>(),
  soft: { on: true, radius: 90, mode: "straight" } as Soft,
  gesture: null as Gesture | null,
  pointer: null as { x: number; y: number } | null,
  refresh: null as (() => void) | null,
  unsubscribe: [] as (() => void)[]
};

// ---------------------------------------------------------------------------------------------
// The mesh being deformed
// ---------------------------------------------------------------------------------------------

const keyOf = (m: Pick<MeshAttachment, "skin" | "slot" | "name">): string => `${m.skin}/${m.slot}/${m.name}`;

/** Every mesh a slot shows now (a mesh with no art on screen cannot be dragged). */
function candidates(skeleton: Skeleton | null): MeshAttachment[] {
  const out: MeshAttachment[] = [];
  for (const slot of skeleton?.slots ?? []) {
    const a = slot.attachment;
    if (a && a.type === "mesh" && !out.includes(a)) out.push(a);
  }
  return out;
}

function currentMesh(host: EditorHost): MeshAttachment | null {
  const list = candidates(host.skeleton);
  const found = list.find((m) => keyOf(m) === state.target);
  if (found) return found;
  // First use: the mesh that already has shape keys in this clip, else the first one on screen.
  const keyed = list.find((m) => getDeformKeys(host.clip, addressOf(m)));
  const pick = keyed ?? list[0] ?? null;
  const next = pick ? keyOf(pick) : null;
  if (next !== state.target) {
    state.target = next;
    state.selection = new Set();
  }
  return pick;
}

/** Where the clip keys a mesh: a linked mesh that inherits deform is keyed on its source. */
function addressOf(mesh: MeshAttachment): DeformAddress {
  const o = mesh.deformOwner;
  return { skin: o.skin, slot: o.slot, attachment: o.name };
}

function deformMesh(skeleton: Skeleton, mesh: MeshAttachment): DeformMesh | null {
  const slot = skeleton.slots.find((s) => s.data.name === mesh.slot);
  if (!slot) return null;
  return { geometry: mesh.geometry, slotBone: slot.bone, bones: skeleton.bones };
}

function shownDeform(skeleton: Skeleton, mesh: MeshAttachment): Float32Array | null {
  return skeleton.deformFor(mesh);
}

/** The full deform array a drag starts from: the key on this frame, else what the frame shows. */
function baseDeform(host: EditorHost, mesh: MeshAttachment, sampled: ArrayLike<number> | null): Float64Array {
  const length = mesh.geometry.deformLength;
  const key = deformKeyAt(host.clip, addressOf(mesh), host.time);
  if (key) return expandDeformKey(key, length);
  const out = new Float64Array(length);
  if (sampled) for (let i = 0; i < length; i++) out[i] = sampled[i] ?? 0;
  return out;
}

/** The posed vertex positions now (skeleton space), with a gesture's live deform when one is running. */
function positionsNow(host: EditorHost, dm: DeformMesh, mesh: MeshAttachment): Float64Array {
  if (state.gesture?.live) return worldPositions(dm, state.gesture.live.deform);
  return worldPositions(dm, host.skeleton ? shownDeform(host.skeleton, mesh) : null);
}

// ---------------------------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------------------------

function influenceFor(dm: DeformMesh, positions: Float64Array): Float64Array | null {
  if (!state.soft.on || state.soft.radius <= 0) return null;
  return softSelectionWeights(dm, positions, state.selection, state.soft.radius, state.soft.mode);
}

function begin(host: EditorHost, kind: Gesture["kind"], mesh: MeshAttachment, at: { x: number; y: number }): Gesture | null {
  const skeleton = host.skeleton;
  if (!skeleton) return null;
  const dm = deformMesh(skeleton, mesh);
  if (!dm) return null;
  const sampled = shownDeform(skeleton, mesh);
  const positions = worldPositions(dm, sampled);
  const centre = selectionCentre(positions, state.selection) ?? at;
  return { kind, start: at, centre, base: baseDeform(host, mesh, sampled), positions, influence: kind === "box" ? null : influenceFor(dm, positions), dm, mesh, live: null };
}

function evaluate(g: Gesture, p: { x: number; y: number }): DragResult {
  if (g.kind === "move") return dragVertices(g.dm, g.base, p.x - g.start.x, p.y - g.start.y, g.influence, state.selection);
  const d0 = Math.hypot(g.start.x - g.centre.x, g.start.y - g.centre.y) || 1;
  const f = Math.max(0.05, Math.hypot(p.x - g.centre.x, p.y - g.centre.y) / d0);
  if (g.kind === "rotate") {
    const a = Math.atan2(p.y - g.centre.y, p.x - g.centre.x) - Math.atan2(g.start.y - g.centre.y, g.start.x - g.centre.x);
    return transformVertices(g.dm, g.base, g.positions, state.selection, g.influence, { rotate: a }, g.centre);
  }
  if (g.kind === "squash") return transformVertices(g.dm, g.base, g.positions, state.selection, g.influence, { scaleX: 1 / f, scaleY: f }, g.centre);
  return transformVertices(g.dm, g.base, g.positions, state.selection, g.influence, { scaleX: f, scaleY: f }, g.centre);
}

let liveLayer: Graphics | null = null;

/** The wireframe layer used while a drag is live (a re-pose would throw the live deform away, so the canvas overlay is not redrawn then). */
function liveGraphics(host: EditorHost): Graphics {
  if (!liveLayer || liveLayer.destroyed) liveLayer = new Graphics({ label: "shape-keys-live" });
  if (liveLayer.parent !== host.world) host.world.addChild(liveLayer);
  return liveLayer;
}

function clearLive(): void {
  liveLayer?.clear();
}

/** Shows a gesture's deform on the character without committing it. */
function showLive(host: EditorHost, g: Gesture, result: DragResult): void {
  g.live = result;
  const owner = g.mesh.deformOwner;
  try {
    const arr = host.skeleton!.animationDeformFor(owner);
    for (let i = 0; i < arr.length; i++) arr[i] = result.deform[i] as number;
    host.character?.update();
  } catch {
    // an inheriting mesh without a source: nothing to show
  }
  const layer = liveGraphics(host);
  layer.clear();
  paint(layer, 1 / Math.max(host.zoom(), 1e-6), host);
  // The editor draws on demand (no Pixi ticker), so ask for the frame now.
  host.app.render();
}

function cancel(host: EditorHost): void {
  if (!state.gesture) return;
  state.gesture = null;
  clearLive();
  host.repose();
}

function finish(host: EditorHost): void {
  const g = state.gesture;
  state.gesture = null;
  if (!g) return;
  clearLive();
  if (g.kind === "box") {
    const b = g.box;
    if (b) {
      const wide = Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 3 / Math.max(host.zoom(), 1e-6);
      if (wide) state.selection = boxSelect(state.selection, g.positions, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, g.mods ?? {});
      else if (!g.mods?.shift && !g.mods?.ctrl) state.selection = new Set();
    }
    host.redraw();
    state.refresh?.();
    return;
  }
  const result = g.live;
  if (!result || result.edits.size === 0) {
    host.repose();
    host.redraw();
    return;
  }
  const mesh = g.mesh;
  const address = addressOf(mesh);
  const next = mergeDeformKey(host.clip, address, host.time, mesh.geometry.deformLength, result.edits, g.base);
  const verb = g.kind === "move" ? "Moved" : g.kind === "rotate" ? "Rotated" : g.kind === "squash" ? "Squashed" : "Scaled";
  host.commit(next, `${verb} ${result.touched.length} vertices of ${mesh.name} at frame ${timeToFrame(host.clip, host.time)}`);
  state.refresh?.();
}

function pointerDown(p: CanvasPoint, e: { shiftKey: boolean; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, host: EditorHost): boolean {
  const mesh = currentMesh(host);
  if (!mesh || !host.skeleton) return false;
  if (state.gesture && state.gesture.kind !== "box" && state.gesture.kind !== "move") {
    // A modal S / R transform: the click accepts it.
    finish(host);
    return true;
  }
  const dm = deformMesh(host.skeleton, mesh);
  if (!dm) return false;
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const radius = PICK_PX / Math.max(host.zoom(), 1e-6);
  const positions = positionsNow(host, dm, mesh);
  let hit = pickVertex(positions, p.x, p.y, radius);
  if (hit < 0) {
    // A vertex of another mesh on screen switches the target.
    for (const other of candidates(host.skeleton)) {
      if (other === mesh) continue;
      const odm = deformMesh(host.skeleton, other);
      if (!odm) continue;
      if (pickVertex(worldPositions(odm, shownDeform(host.skeleton, other)), p.x, p.y, radius) >= 0) {
        state.target = keyOf(other);
        state.selection = new Set();
        state.refresh?.();
        host.redraw();
        return true;
      }
    }
  }
  if (hit >= 0) {
    if (!(state.selection.has(hit) && !e.shiftKey && !ctrl)) state.selection = clickSelect(state.selection, hit, { shift: e.shiftKey, ctrl });
    if (!state.selection.has(hit)) {
      host.redraw();
      state.refresh?.();
      return true;
    }
    const g = begin(host, "move", mesh, { x: p.x, y: p.y });
    state.gesture = g;
    state.refresh?.();
    host.redraw();
    return true;
  }
  const g = begin(host, "box", mesh, { x: p.x, y: p.y });
  if (g) {
    g.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    g.mods = { shift: e.shiftKey, ctrl };
    state.gesture = g;
  }
  return true;
}

function pointerMove(p: CanvasPoint, host: EditorHost): boolean {
  state.pointer = { x: p.x, y: p.y };
  const g = state.gesture;
  if (!g) return false;
  if (g.kind === "box") {
    g.box = { x0: g.box!.x0, y0: g.box!.y0, x1: p.x, y1: p.y };
    host.redraw();
    return true;
  }
  showLive(host, g, evaluate(g, p));
  return true;
}

function pointerUp(host: EditorHost): boolean {
  const g = state.gesture;
  if (!g) return false;
  // S / R / Shift+S stay open until a click; a drag (move) or a box ends on release.
  if (g.kind !== "move" && g.kind !== "box") return true;
  finish(host);
  return true;
}

function startModal(host: EditorHost, kind: Modal): boolean {
  const mesh = currentMesh(host);
  if (!mesh || state.selection.size === 0) return false;
  if (state.gesture) cancel(host);
  const at = state.pointer ?? { x: 0, y: 0 };
  const g = begin(host, kind, mesh, at);
  if (!g) return false;
  // Without a pointer position yet, start 60 px right of the centre so the first move has a distance to compare.
  if (!state.pointer) g.start = { x: g.centre.x + 60 / Math.max(host.zoom(), 1e-6), y: g.centre.y };
  state.gesture = g;
  host.status(`${kind === "rotate" ? "Rotate" : kind === "squash" ? "Squash" : "Scale"}: move the pointer, click to accept, Esc to cancel`);
  return true;
}

function onKey(e: KeyboardEvent, host: EditorHost): boolean {
  const key = e.key.toLowerCase();
  const mesh = currentMesh(host);
  if (key === "escape" && state.gesture) {
    cancel(host);
    return true;
  }
  if (!mesh || e.ctrlKey || e.metaKey || e.altKey) {
    if (mesh && (e.ctrlKey || e.metaKey) && key === "a") {
      state.selection = selectAll(shownPositions(host, mesh));
      host.redraw();
      state.refresh?.();
      return true;
    }
    return false;
  }
  if (key === "s") return startModal(host, e.shiftKey ? "squash" : "scale");
  if (key === "r" && !e.shiftKey) return startModal(host, "rotate");
  if (key === "=" || key === "+" || key === "-") {
    const nb = adjacency(mesh.geometry.vertexCount, mesh.geometry.triangles);
    state.selection = key === "-" ? shrinkSelection(state.selection, nb) : growSelection(state.selection, nb);
    host.redraw();
    state.refresh?.();
    return true;
  }
  return false;
}

function shownPositions(host: EditorHost, mesh: MeshAttachment): Float64Array {
  const dm = deformMesh(host.skeleton!, mesh);
  return dm ? positionsNow(host, dm, mesh) : new Float64Array(0);
}

function setRadius(host: EditorHost, radius: number): void {
  state.soft.radius = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(radius)));
  state.refresh?.();
  host.redraw();
}

// ---------------------------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------------------------

const WIRE = 0x7fd0ff;
const DOT = 0xcfe9ff;
const SELECTED = 0xffb84a;
const SOFT = 0xffe39a;

function drawOverlay(g: Graphics, px: number, host: EditorHost): void {
  // A live drag is drawn by its own layer (see showLive).
  if (state.gesture?.live) return;
  paint(g, px, host);
}

function paint(g: Graphics, px: number, host: EditorHost): void {
  const mesh = currentMesh(host);
  if (!mesh || !host.skeleton) return;
  const dm = deformMesh(host.skeleton, mesh);
  if (!dm) return;
  const pos = positionsNow(host, dm, mesh);
  const tri = mesh.geometry.triangles;
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const a = tri[i] as number;
    const b = tri[i + 1] as number;
    const c = tri[i + 2] as number;
    g.moveTo(pos[a * 2] as number, pos[a * 2 + 1] as number)
      .lineTo(pos[b * 2] as number, pos[b * 2 + 1] as number)
      .lineTo(pos[c * 2] as number, pos[c * 2 + 1] as number)
      .lineTo(pos[a * 2] as number, pos[a * 2 + 1] as number)
      .stroke({ width: px, color: WIRE, alpha: 0.35 });
  }
  const soft = state.selection.size ? softSelectionWeights(dm, pos, state.selection, state.soft.on ? state.soft.radius : 0, state.soft.mode) : null;
  for (let v = 0; v < mesh.geometry.vertexCount; v++) {
    const x = pos[v * 2] as number;
    const y = pos[v * 2 + 1] as number;
    if (state.selection.has(v)) g.circle(x, y, 4.5 * px).fill({ color: SELECTED }).stroke({ width: px, color: 0x000000, alpha: 0.7 });
    else if (soft && (soft[v] as number) > 0.02) g.circle(x, y, 3.5 * px).fill({ color: SOFT, alpha: 0.25 + 0.65 * (soft[v] as number) });
    else g.circle(x, y, 2.6 * px).fill({ color: DOT, alpha: 0.85 });
  }
  const centre = selectionCentre(pos, state.selection);
  if (centre && state.soft.on && state.soft.radius > 0) {
    g.circle(centre.x, centre.y, state.soft.radius).stroke({ width: 1.5 * px, color: SOFT, alpha: state.soft.mode === "straight" ? 0.9 : 0.45 });
  }
  const box = state.gesture?.box;
  if (box) {
    g.rect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
      .fill({ color: 0xffffff, alpha: 0.08 })
      .stroke({ width: px, color: 0xffffff, alpha: 0.8 });
  }
  if (state.gesture && state.gesture.kind !== "move" && state.gesture.kind !== "box" && state.pointer) {
    g.moveTo(state.gesture.centre.x, state.gesture.centre.y).lineTo(state.pointer.x, state.pointer.y).stroke({ width: px, color: SELECTED, alpha: 0.8 });
  }
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...kids);
  return node;
}

const CURVE_KINDS: Exclude<CurveKind, "bezier">[] = ["linear", "stepped", "ease-in", "ease-out", "ease-in-out"];

function panel(box: HTMLElement, host: EditorHost): void {
  const title = el("div", { className: "ctool-title", textContent: "Shape keys" });
  const meshSel = el("select", { id: "sk-mesh", title: "The mesh to deform (meshes on screen now)" });
  const shared = el("div", { id: "sk-shared", className: "note" });
  const info = el("div", { id: "sk-info", className: "note" });
  const soft = el("input", { id: "sk-soft", type: "checkbox", checked: state.soft.on, title: "Soft selection: vertices near the selection follow" });
  const radius = el("input", { id: "sk-radius", type: "range", min: String(RADIUS_MIN), max: String(RADIUS_MAX), value: String(state.soft.radius), title: "Soft selection radius (Alt + mouse wheel on the canvas)" });
  const radiusVal = el("span", { id: "sk-radius-val" });
  const mode = el("select", { id: "sk-mode", title: "Distance measured in a straight line, or along the mesh edges" }, el("option", { value: "straight", textContent: "Straight line" }), el("option", { value: "edge", textContent: "Along mesh" }));
  mode.value = state.soft.mode;
  const curve = el("select", { id: "sk-curve", title: "How this key eases into the next one" }, ...CURVE_KINDS.map((k) => el("option", { value: k, textContent: CURVE_LABELS[k] })));
  const graph = el("canvas", { id: "sk-amount", width: 260, height: 54, title: "Amount of deform over time (largest vertex offset, px)" });
  graph.style.cssText = "width:260px;height:54px;background:#161a22;border-radius:4px";
  const clearSel = el("button", { id: "sk-clear-sel", textContent: "Clear selected", title: "Zero the selected vertices on this frame (the key stays)" });
  const clearKey = el("button", { id: "sk-clear-key", textContent: "Delete key", title: "Delete the deform key on this frame" });
  const clearAll = el("button", { id: "sk-clear-all", textContent: "Remove all", title: "Remove the whole deform timeline of this mesh" });
  const hint = el("div", { className: "note", textContent: "Drag a vertex to move it. S scale, R rotate, Shift+S squash (click to accept, Esc cancels). Ctrl+A all, + / - grow or shrink. Alt + wheel: soft radius." });
  const row = (...kids: (Node | string)[]) => {
    const r = el("div", {}, ...kids);
    r.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    return r;
  };
  box.append(title, row(meshSel), shared, info, row(soft, "Soft", radius, radiusVal), row("Distance", mode), row("Key curve", curve), graph, row(clearSel, clearKey, clearAll), hint);

  const commit = (next: ReturnType<typeof clearDeformTimeline>, message: string) => {
    if (next === host.clip) {
      host.status("Nothing to clear here");
      return;
    }
    host.commit(next, message);
  };
  const target = () => {
    const m = currentMesh(host);
    return m ? { mesh: m, address: addressOf(m) } : null;
  };
  soft.onchange = () => ((state.soft.on = soft.checked), host.redraw());
  radius.oninput = () => setRadius(host, Number(radius.value));
  mode.onchange = () => ((state.soft.mode = mode.value as FalloffMode), host.redraw());
  meshSel.onchange = () => {
    state.target = meshSel.value;
    state.selection = new Set();
    refresh();
    host.redraw();
  };
  curve.onchange = () => {
    const t = target();
    if (t) commit(setDeformCurve(host.clip, t.address.skin, t.address.slot, t.address.attachment, host.time, CURVE_PRESETS[curve.value as Exclude<CurveKind, "bezier">]), `Curve ${CURVE_LABELS[curve.value as CurveKind]} on the ${t.mesh.name} shape key`);
  };
  clearSel.onclick = () => {
    const t = target();
    if (t && state.selection.size && host.skeleton) commit(clearVerticesOnFrame(host.clip, t.address, host.time, t.mesh.geometry, state.selection, shownDeform(host.skeleton, t.mesh)), `Cleared ${state.selection.size} selected vertices of ${t.mesh.name} on this frame`);
  };
  clearKey.onclick = () => {
    const t = target();
    if (t) commit(deleteDeformKey(host.clip, t.address, host.time), `Deleted the ${t.mesh.name} shape key on this frame`);
  };
  clearAll.onclick = () => {
    const t = target();
    if (t) commit(clearDeformTimeline(host.clip, t.address), `Removed every ${t.mesh.name} shape key`);
  };

  function drawAmount(): void {
    const t = target();
    const g = graph.getContext("2d")!;
    g.clearRect(0, 0, graph.width, graph.height);
    if (!t) return;
    const keys = deformAmountKeys(host.clip, t.address.skin, t.address.slot, t.address.attachment);
    const dur = Math.max(host.clip.duration, 1e-3);
    const top = Math.max(1, ...keys.map((k) => k.value)) * 1.15;
    const X = (time: number) => 6 + (time / dur) * (graph.width - 12);
    const Y = (v: number) => graph.height - 6 - (v / top) * (graph.height - 12);
    g.strokeStyle = "#2c3342";
    g.beginPath();
    g.moveTo(6, Y(0));
    g.lineTo(graph.width - 6, Y(0));
    g.stroke();
    if (keys.length) {
      g.strokeStyle = "#7fd0ff";
      g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i <= 80; i++) {
        const time = (dur * i) / 80;
        const v = sampleChannel(keys, time) ?? 0;
        if (i === 0) g.moveTo(X(time), Y(v));
        else g.lineTo(X(time), Y(v));
      }
      g.stroke();
      g.fillStyle = "#ffb84a";
      for (const k of keys) {
        g.beginPath();
        g.arc(X(k.time), Y(k.value), 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(X(host.time), 2);
    g.lineTo(X(host.time), graph.height - 2);
    g.stroke();
  }

  function refresh(): void {
    const list = candidates(host.skeleton);
    const mesh = currentMesh(host);
    meshSel.replaceChildren(...list.map((m) => el("option", { value: keyOf(m), textContent: m.name === m.slot ? m.slot : `${m.slot} / ${m.name}` })));
    if (mesh) meshSel.value = keyOf(mesh);
    const owner = mesh?.deformOwner;
    shared.textContent = mesh && owner && owner !== mesh ? `shared with ${owner.name} (keys are stored on ${owner.name})` : "";
    shared.style.display = shared.textContent ? "" : "none";
    const address = mesh ? addressOf(mesh) : null;
    const key = address ? deformKeyAt(host.clip, address, host.time) : undefined;
    const keys = address ? (getDeformKeys(host.clip, address)?.length ?? 0) : 0;
    info.textContent = mesh ? `${state.selection.size} of ${mesh.geometry.vertexCount} vertices selected. ${key ? "Key on this frame" : "No key on this frame"} (${keys} in the clip)` : "No mesh is showing on this frame.";
    radiusVal.textContent = `${state.soft.radius}px`;
    radius.value = String(state.soft.radius);
    soft.checked = state.soft.on;
    if (key) curve.value = curveKind(curveForComp(key.curve, "value")) === "bezier" ? "linear" : curveKind(curveForComp(key.curve, "value"));
    curve.disabled = !key;
    clearSel.disabled = !state.selection.size;
    clearKey.disabled = !key;
    clearAll.disabled = keys === 0;
    drawAmount();
  }
  state.refresh = refresh;
  refresh();
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

let wheelHost: EditorHost | null = null;
const onWheel = (e: WheelEvent): void => {
  if (!e.altKey || !wheelHost) return;
  e.preventDefault();
  e.stopPropagation();
  setRadius(wheelHost, state.soft.radius * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
};

const tool: CanvasTool = {
  id: SHAPE_KEYS_ID,
  label: "Shape keys",
  hint: "Deform mesh vertices on the current frame.",
  activate(host) {
    wheelHost = host;
    host.app.canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });
    state.unsubscribe = (["pose", "time", "clip", "rig", "skins"] as const).map((ev) =>
      host.on(ev, () => {
        if (ev === "rig" || ev === "skins") state.selection = new Set();
        if (!state.gesture) state.refresh?.();
      })
    );
  },
  deactivate(host) {
    host.app.canvas.removeEventListener("wheel", onWheel, { capture: true });
    for (const off of state.unsubscribe) off();
    state.unsubscribe = [];
    wheelHost = null;
    state.gesture = null;
    state.refresh = null;
    clearLive();
  },
  pointerDown,
  pointerMove,
  pointerUp,
  drawOverlay,
  panel,
  onKey
};

registerCanvasTool(tool);

/** Test / demo hook: the tool's state and a way to find vertices on screen. */
export interface ShapeKeysApi {
  target(): string | null;
  selection(): number[];
  select(vertices: number[]): void;
  vertexCount(): number;
  /** Canvas pixel position of a vertex (client coordinates of the canvas element). */
  vertexScreen(v: number): { x: number; y: number } | null;
  soft(): Soft;
  setSoft(next: Partial<Soft>): void;
  setTarget(key: string): void;
  verticesInBox(x0: number, y0: number, x1: number, y1: number): number[];
  /** The open clip's deform timelines (skin -> slot -> attachment -> keys), a copy. */
  deformKeys(): unknown;
  /** Skeleton-space positions of the shown mesh, x then y per vertex. */
  positions(): number[];
}

declare global {
  interface Window {
    atlasShapeKeys?: ShapeKeysApi;
  }
}

export function installShapeKeysApi(host: EditorHost): void {
  window.atlasShapeKeys = {
    target: () => state.target,
    selection: () => [...state.selection].sort((a, b) => a - b),
    select(vertices) {
      state.selection = new Set(vertices);
      host.redraw();
      state.refresh?.();
    },
    vertexCount: () => currentMesh(host)?.geometry.vertexCount ?? 0,
    vertexScreen(v) {
      const mesh = currentMesh(host);
      if (!mesh || !host.skeleton) return null;
      const pos = shownPositions(host, mesh);
      if (v < 0 || v * 2 + 1 >= pos.length) return null;
      const g = host.world.toGlobal({ x: pos[v * 2] as number, y: pos[v * 2 + 1] as number });
      const r = host.app.canvas.getBoundingClientRect();
      return { x: r.left + g.x, y: r.top + g.y };
    },
    soft: () => ({ ...state.soft }),
    setSoft(next) {
      Object.assign(state.soft, next);
      state.refresh?.();
      host.redraw();
    },
    setTarget(key) {
      state.target = key;
      state.selection = new Set();
      state.refresh?.();
      host.redraw();
    },
    deformKeys: () => structuredClone(host.clip.deform),
    positions() {
      const mesh = currentMesh(host);
      return mesh ? [...shownPositions(host, mesh)] : [];
    },
    verticesInBox(x0, y0, x1, y1) {
      const mesh = currentMesh(host);
      return mesh ? verticesInBox(shownPositions(host, mesh), { x0, y0, x1, y1 }) : [];
    }
  };
}
