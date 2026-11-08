/*
 * Atlas Animator editor: Corrective sculpt (Setup sub-tool "sculpt"; Batch 7b-2, ).
 *
 * Opened by "Sculpt at this angle" in the bone inspector's Correctives card. The driver bone is posed at the chosen angle (a preview
 * only; the setup pose in the rig is not changed), the mesh is shown with whatever the set already does there, and dragging vertices
 * moves them with the same soft selection the Shape keys tool uses (deformModel.ts). Releasing the drag stores the result as the
 * driven key of the set at that angle (`driven.key`), as ONE undo step through the Setup edit path.
 */
import type { MeshAttachment, Skeleton } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { keyDeformOf, planCorrectiveKey, sculptSession, type DeformAddress } from "./correctiveModel.js";
import { dragVertices, selectionCentre, softSelectionWeights, worldPositions, type DeformMesh, type DragResult, type FalloffMode } from "./deformModel.js";
import { getHost } from "./host.js";
import { registerSetupSubTool, type SetupToolContext } from "./setupMode.js";
import type { JsonObject } from "./setupModel.js";
import { adjacency, boxSelect, clickSelect, growSelection, pickVertex, shrinkSelection } from "./vertexSelect.js";

const PICK_PX = 10;
const RADIUS_MIN = 4;
const RADIUS_MAX = 600;

interface Gesture {
  kind: "move" | "box";
  start: { x: number; y: number };
  base: Float64Array;
  sampled: Float64Array;
  animBefore: Float64Array;
  influence: Float64Array | null;
  dm: DeformMesh;
  mesh: MeshAttachment;
  box?: { x0: number; y0: number; x1: number; y1: number };
  mods?: { shift: boolean; ctrl: boolean };
  live: DragResult | null;
}

const state = {
  mesh: null as string | null,
  selection: new Set<number>(),
  soft: { on: true, radius: 90, mode: "straight" as FalloffMode },
  gesture: null as Gesture | null,
  refresh: null as (() => void) | null
};

const keyOf = (m: Pick<MeshAttachment, "skin" | "slot" | "name">): string => `${m.skin}/${m.slot}/${m.name}`;
const addressOf = (mesh: MeshAttachment): DeformAddress => ({ skin: mesh.deformOwner.skin, slot: mesh.deformOwner.slot, attachment: mesh.deformOwner.name });

function candidates(skeleton: Skeleton | null): MeshAttachment[] {
  const out: MeshAttachment[] = [];
  for (const slot of skeleton?.slots ?? []) {
    const a = slot.attachment;
    if (a && a.type === "mesh" && !out.includes(a)) out.push(a);
  }
  return out;
}

function currentMesh(ctx: SetupToolContext): MeshAttachment | null {
  const list = candidates(ctx.host.skeleton());
  const found = list.find((m) => keyOf(m) === state.mesh);
  if (found) return found;
  const slot = ctx.slot();
  const pick = list.find((m) => m.slot === slot) ?? list[0] ?? null;
  const next = pick ? keyOf(pick) : null;
  if (next !== state.mesh) {
    state.mesh = next;
    state.selection = new Set();
  }
  return pick;
}

function deformMesh(skeleton: Skeleton, mesh: MeshAttachment): DeformMesh | null {
  const slot = skeleton.slots.find((s) => s.data.name === mesh.slot);
  return slot ? { geometry: mesh.geometry, slotBone: slot.bone, bones: skeleton.bones } : null;
}

const shown = (skeleton: Skeleton, mesh: MeshAttachment): Float64Array => {
  const length = mesh.geometry.deformLength;
  const out = new Float64Array(length);
  const d = skeleton.deformFor(mesh);
  if (d) for (let i = 0; i < length; i++) out[i] = d[i] ?? 0;
  return out;
};

function positionsNow(ctx: SetupToolContext, dm: DeformMesh, mesh: MeshAttachment): Float64Array {
  if (state.gesture?.live) return worldPositions(dm, state.gesture.live.deform);
  const sk = ctx.host.skeleton();
  return worldPositions(dm, sk ? shown(sk, mesh) : null);
}

function begin(ctx: SetupToolContext, kind: Gesture["kind"], mesh: MeshAttachment, at: { x: number; y: number }): Gesture | null {
  const sk = ctx.host.skeleton();
  const t = sculptSession.target;
  if (!sk || !t) return null;
  const dm = deformMesh(sk, mesh);
  if (!dm) return null;
  const sampled = shown(sk, mesh);
  const raw = ctx.host.rig()?.raw ?? {};
  const stored = keyDeformOf(raw as JsonObject, t.set, t.at, addressOf(mesh), mesh.geometry.deformLength);
  const length = mesh.geometry.deformLength;
  const anim = new Float64Array(length);
  try {
    const a = sk.animationDeformFor(mesh.deformOwner);
    for (let i = 0; i < length; i++) anim[i] = a[i] ?? 0;
  } catch {
    // an inheriting mesh without a source
  }
  const positions = worldPositions(dm, sampled);
  const influence = kind === "move" && state.soft.on && state.soft.radius > 0 ? softSelectionWeights(dm, positions, state.selection, state.soft.radius, state.soft.mode) : null;
  return { kind, start: at, base: stored ?? sampled, sampled, animBefore: anim, influence, dm, mesh, live: null };
}

let liveLayer: Graphics | null = null;
function liveGraphics(world: Graphics["parent"]): Graphics {
  if (!liveLayer || liveLayer.destroyed) liveLayer = new Graphics({ label: "corrective-live" });
  if (world && liveLayer.parent !== world) world.addChild(liveLayer);
  return liveLayer;
}
const clearLive = (): void => void liveLayer?.clear();

function showLive(ctx: SetupToolContext, g: Gesture, result: DragResult): void {
  g.live = result;
  const eh = getHost();
  const sk = ctx.host.skeleton();
  if (!eh || !sk) return;
  try {
    const arr = sk.animationDeformFor(g.mesh.deformOwner);
    for (let i = 0; i < arr.length; i++) arr[i] = (g.animBefore[i] as number) + (result.deform[i] as number) - (g.sampled[i] as number);
    eh.character?.update();
  } catch {
    // nothing to show
  }
  const layer = liveGraphics(eh.world);
  layer.clear();
  paint(layer, 1 / Math.max(ctx.host.zoom(), 1e-6), ctx);
  eh.app.render();
}

function cancel(ctx: SetupToolContext): void {
  if (!state.gesture) return;
  state.gesture = null;
  clearLive();
  ctx.host.repose();
}

function finish(ctx: SetupToolContext): void {
  const g = state.gesture;
  state.gesture = null;
  if (!g) return;
  clearLive();
  if (g.kind === "box") {
    const b = g.box;
    if (b) {
      const wide = Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 3 / Math.max(ctx.host.zoom(), 1e-6);
      const pos = worldPositions(g.dm, g.sampled);
      if (wide) state.selection = boxSelect(state.selection, pos, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, g.mods ?? {});
      else if (!g.mods?.shift && !g.mods?.ctrl) state.selection = new Set();
    }
    ctx.redraw();
    state.refresh?.();
    return;
  }
  const result = g.live;
  const t = sculptSession.target;
  if (!result || result.edits.size === 0 || !t) {
    ctx.host.repose();
    return;
  }
  void commit(ctx, g.mesh, result.deform, `Sculpted ${g.mesh.name} at ${t.at} degrees (${t.set})`);
}

async function commit(ctx: SetupToolContext, mesh: MeshAttachment, full: ArrayLike<number>, label: string): Promise<void> {
  const t = sculptSession.target;
  if (!t) return;
  const address = addressOf(mesh);
  const ok = await ctx.run(label, (raw) => ({ commands: planCorrectiveKey(raw, { set: t.set, bone: t.bone, at: t.at, address, full }), bone: t.bone }));
  if (!ok) ctx.host.repose();
  state.refresh?.();
  ctx.renderPanel();
}

function pointerDown(p: { x: number; y: number }, e: { shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, ctx: SetupToolContext): boolean {
  const mesh = currentMesh(ctx);
  const sk = ctx.host.skeleton();
  if (!mesh || !sk || !sculptSession.target) return false;
  const dm = deformMesh(sk, mesh);
  if (!dm) return false;
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const radius = PICK_PX / Math.max(ctx.host.zoom(), 1e-6);
  const hit = pickVertex(positionsNow(ctx, dm, mesh), p.x, p.y, radius);
  if (hit < 0) {
    for (const other of candidates(sk)) {
      if (other === mesh) continue;
      const odm = deformMesh(sk, other);
      if (odm && pickVertex(worldPositions(odm, shown(sk, other)), p.x, p.y, radius) >= 0) {
        state.mesh = keyOf(other);
        state.selection = new Set();
        state.refresh?.();
        ctx.redraw();
        return true;
      }
    }
    const g = begin(ctx, "box", mesh, p);
    if (g) {
      g.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      g.mods = { shift: e.shiftKey, ctrl };
      state.gesture = g;
    }
    return true;
  }
  if (!(state.selection.has(hit) && !e.shiftKey && !ctrl)) state.selection = clickSelect(state.selection, hit, { shift: e.shiftKey, ctrl });
  if (!state.selection.has(hit)) {
    ctx.redraw();
    state.refresh?.();
    return true;
  }
  state.gesture = begin(ctx, "move", mesh, p);
  state.refresh?.();
  ctx.redraw();
  return true;
}

function pointerMove(p: { x: number; y: number }, ctx: SetupToolContext): boolean {
  const g = state.gesture;
  if (!g) return false;
  if (g.kind === "box") {
    g.box = { x0: g.box!.x0, y0: g.box!.y0, x1: p.x, y1: p.y };
    ctx.redraw();
    return true;
  }
  showLive(ctx, g, dragVertices(g.dm, g.base, p.x - g.start.x, p.y - g.start.y, g.influence, state.selection));
  return true;
}

function pointerUp(ctx: SetupToolContext): boolean {
  if (!state.gesture) return false;
  finish(ctx);
  return true;
}

const WIRE = 0x7fd0ff;
const DOT = 0xcfe9ff;
const SELECTED = 0xffb84a;
const SOFT = 0xffe39a;

function paint(g: Graphics, px: number, ctx: SetupToolContext): void {
  const mesh = currentMesh(ctx);
  const sk = ctx.host.skeleton();
  if (!mesh || !sk) return;
  const dm = deformMesh(sk, mesh);
  if (!dm) return;
  const pos = positionsNow(ctx, dm, mesh);
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
  if (centre && state.soft.on && state.soft.radius > 0) g.circle(centre.x, centre.y, state.soft.radius).stroke({ width: 1.5 * px, color: SOFT, alpha: 0.9 });
  const box = state.gesture?.box;
  if (box) g.rect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0)).fill({ color: 0xffffff, alpha: 0.08 }).stroke({ width: px, color: 0xffffff, alpha: 0.8 });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

function panel(box: HTMLElement, ctx: SetupToolContext): void {
  const title = el("h2", { textContent: "Corrective sculpt" });
  const info = el("div", { id: "cs-info", className: "note" });
  const meshSel = el("select", { id: "cs-mesh", title: "The mesh to sculpt (meshes showing now)" });
  meshSel.setAttribute("aria-label", "Mesh to sculpt");
  const soft = el("input", { id: "cs-soft", type: "checkbox", checked: state.soft.on, title: "Soft selection: vertices near the selection follow" });
  const radius = el("input", { id: "cs-radius", type: "range", min: String(RADIUS_MIN), max: String(RADIUS_MAX), value: String(state.soft.radius), title: "Soft selection radius in px" });
  radius.setAttribute("aria-label", "Soft selection radius");
  const radiusVal = el("span", { id: "cs-radius-val" });
  const mode = el("select", { id: "cs-mode", title: "Distance measured in a straight line, or along the mesh edges" }, el("option", { value: "straight", textContent: "Straight line" }), el("option", { value: "edge", textContent: "Along mesh" }));
  mode.setAttribute("aria-label", "Soft selection distance");
  mode.value = state.soft.mode;
  const reset = el("button", { id: "cs-clear", type: "button", className: "btn", textContent: "Clear this mesh", title: "Remove this mesh's deform from the key at this angle (the key stays)" });
  const done = el("button", { id: "cs-done", type: "button", className: "btn btn-primary", textContent: "Done", title: "Leave the sculpt and go back to the Select tool; the keys are already stored" });
  const hint = el("div", { className: "note", textContent: "Drag a vertex to move it; drag empty space to box-select (Shift adds). Each release stores the key at this angle and is one undo step. + / - grow or shrink the selection." });
  const row = (...kids: (Node | string)[]) => {
    const r = el("div", {}, ...kids);
    r.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    return r;
  };
  box.append(title, info, row("Mesh", meshSel), row(soft, "Soft", radius, radiusVal), row("Distance", mode), row(reset, done), hint);
  soft.onchange = () => ((state.soft.on = soft.checked), ctx.redraw());
  radius.oninput = () => {
    state.soft.radius = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(Number(radius.value))));
    refresh();
    ctx.redraw();
  };
  mode.onchange = () => ((state.soft.mode = mode.value as FalloffMode), ctx.redraw());
  meshSel.onchange = () => {
    state.mesh = meshSel.value;
    state.selection = new Set();
    refresh();
    ctx.redraw();
  };
  reset.onclick = () => {
    const mesh = currentMesh(ctx);
    if (mesh) void commit(ctx, mesh, new Float64Array(mesh.geometry.deformLength), `Cleared ${mesh.name} from the key at ${sculptSession.target?.at} degrees`);
  };
  done.onclick = () => ctx.exit();
  function refresh(): void {
    const t = sculptSession.target;
    const mesh = currentMesh(ctx);
    const list = candidates(ctx.host.skeleton());
    meshSel.replaceChildren(...list.map((m) => el("option", { value: keyOf(m), textContent: m.name === m.slot ? m.slot : `${m.slot} / ${m.name}` })));
    if (mesh) meshSel.value = keyOf(mesh);
    info.textContent = t ? `${t.set} at ${t.at} degrees on ${t.bone}. ${mesh ? `${state.selection.size} of ${mesh.geometry.vertexCount} vertices selected.` : "No mesh is showing."}` : "Open this from the Correctives card (Sculpt at this angle).";
    radiusVal.textContent = `${state.soft.radius}px`;
    radius.value = String(state.soft.radius);
    reset.disabled = !mesh || !t;
  }
  state.refresh = refresh;
  refresh();
}

function onKey(e: KeyboardEvent, ctx: SetupToolContext): boolean {
  const key = e.key.toLowerCase();
  if (key === "escape" && state.gesture) {
    cancel(ctx);
    return true;
  }
  const mesh = currentMesh(ctx);
  if (!mesh || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (key === "=" || key === "+" || key === "-") {
    const nb = adjacency(mesh.geometry.vertexCount, mesh.geometry.triangles);
    state.selection = key === "-" ? shrinkSelection(state.selection, nb) : growSelection(state.selection, nb);
    ctx.redraw();
    state.refresh?.();
    return true;
  }
  return false;
}

registerSetupSubTool({
  id: "sculpt",
  label: "Corrective sculpt",
  key: "",
  hint: "Sculpt the mesh at the chosen driver angle; each release stores a driven key of the set.",
  activate(ctx) {
    activeCtx = ctx;
    state.selection = new Set();
    const t = sculptSession.target;
    if (t) ctx.previewAngle(t.bone, t.at);
  },
  deactivate() {
    activeCtx = null;
    state.gesture = null;
    state.refresh = null;
    clearLive();
  },
  pointerDown: (p, e, ctx) => pointerDown(p, e, ctx),
  pointerMove: (p, ctx) => pointerMove(p, ctx),
  pointerUp: (ctx) => pointerUp(ctx),
  drawOverlay(g, px, ctx) {
    if (state.gesture?.live) return;
    paint(g, px, ctx);
  },
  panel,
  onKey
});

/** Test / demo hook: the sculpt's state and a way to find vertices on screen. */
export interface CorrectiveApi {
  state(): { target: typeof sculptSession.target; mesh: string | null; selection: number[]; vertexCount: number };
  select(vertices: number[]): void;
  /** Client (page) position of a vertex of the shown mesh. */
  vertexScreen(v: number): { x: number; y: number } | null;
}
declare global {
  interface Window {
    atlasCorrective?: CorrectiveApi;
  }
}
let activeCtx: SetupToolContext | null = null;
if (typeof window !== "undefined") {
  window.atlasCorrective = {
    state: () => ({ target: sculptSession.target, mesh: state.mesh, selection: [...state.selection].sort((a, b) => a - b), vertexCount: activeCtx ? (currentMesh(activeCtx)?.geometry.vertexCount ?? 0) : 0 }),
    select(vertices) {
      state.selection = new Set(vertices);
      activeCtx?.redraw();
      state.refresh?.();
    },
    vertexScreen(v) {
      const eh = getHost();
      const mesh = activeCtx ? currentMesh(activeCtx) : null;
      if (!activeCtx || !eh || !mesh) return null;
      const sk = activeCtx.host.skeleton();
      const dm = sk ? deformMesh(sk, mesh) : null;
      if (!dm) return null;
      const pos = positionsNow(activeCtx, dm, mesh);
      if (v < 0 || v * 2 + 1 >= pos.length) return null;
      const g = eh.world.toGlobal({ x: pos[v * 2] as number, y: pos[v * 2 + 1] as number });
      const r = eh.app.canvas.getBoundingClientRect();
      return { x: r.left + g.x, y: r.top + g.y };
    }
  };
}
