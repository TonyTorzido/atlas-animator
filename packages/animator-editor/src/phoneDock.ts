/*
 * Atlas Animator editor: the pinned phone dock (the design notes, section 4, phoneDock.ts).
 *
 * A column beside the canvas with one live phone screen showing the character on the project's grass at a game scale, 0.471 or 0.4 CSS px
 * per rig px (a segmented toggle). It follows the editor's current frame; while the editor plays it runs the project's clock (held to the
 * clip's frames, with the client's hit-stop on a `hit` event). The whole figure with its weapon always shows: at true size when the
 * screen is tall enough (drawn one canvas pixel per device pixel, no smoothing, so it is crisp), else scaled down by the exact factor
 * that fits and labelled ("fit 82%"). A silhouette toggle flattens the character to black over a light ground, and a toggle shows
 * the mirrored right-facing side. Only the character is drawn (no bones, onion skins or underlay).
 *
 * Open by default in Animate and Swag, a thin rail in Pro (optional), gone in Rig, Ship and Home. Collapsible.
 * The pure parts (dockModeFor, cellCamera, DockFollower) take no DOM and are unit tested.
 */
import { ColorMatrixFilter, Rectangle, RenderTexture } from "pixi.js";
import type { ClipData } from "@atlas-animator/core/core";
import { heldTime, timeToFrame } from "./clipModel.js";
import { applyFacing, type Facing } from "./facing.js";
import { GameClock, GROUNDS } from "./gameViewModel.js";
import { fillRail } from "./chrome.js";
import { iconHtml } from "./icons.js";
import { getHost, whenHost, type EditorHost } from "./host.js";
import { PREVIEW_SCALES } from "./preview.js";
import type { Workspaces, WorkspaceId } from "./workspace.js";
import "./phoneDock.css";

/** The phone screen is at least CELL_W wide and grows (up to MAX_W, and 28% of the window) to hold the figure with its weapon at true size. */
export const CELL_W = 300;
export const MAX_W = 480;
/** Its height follows the room the dock has (MIN_H to MAX_H). */
export const MIN_H = 240;
export const MAX_H = 620;
/** Blank ground kept around the figure, CSS px. */
export const MARGIN = 14;
/** While the editor's frames are further apart than this (ms) the dock backs off to one redraw per DOCK_SLOW_MS. */
export const SLOW_GAP_MS = 24;
export const DOCK_SLOW_MS = 100;
/** The light ground the silhouette view uses in the main canvas too. */
const SILHOUETTE_GROUND = 0xe8e4da;

/** Windows narrower than this start Animate and Swag with the phone dock on its rail. */
export const DOCK_OPEN_WIDTH = 2200;

/** Under this window width the open dock stacks above the side panel's content instead of taking its own column (the canvas keeps its width). */
export const DOCK_STACK_WIDTH = 1800;

export type DockMode = "open" | "rail" | "hidden";

/** How the dock shows in a workspace before the person collapses or opens it. */
export function dockModeFor(ws: WorkspaceId, width = Infinity): DockMode {
  // Narrower windows keep the posing canvas big: the dock starts on its rail (one click opens it).
  if (ws === "animate" || ws === "swag") return width < DOCK_OPEN_WIDTH ? "rail" : "open";
  if (ws === "pro") return "rail";
  return "hidden";
}

/** The rig-space extent of the figure with its weapon (y down, from the skeleton origin). */
export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The dock's screen height for the room it has: everything but the screen takes about 160 px. */
export function cellHeightFor(dockHeight: number): number {
  return Math.max(MIN_H, Math.min(MAX_H, Math.floor(dockHeight - 160)));
}

export interface Camera {
  /** Where the skeleton origin sits in the screen (CSS px) and the scale to draw at (game scale x fit). */
  x: number;
  y: number;
  scale: number;
  /** 1 when the whole figure fits at the project scale ("true size"); under 1 when it was scaled down to fit. */
  fit: number;
}

/**
 * The screen's camera at game `scale`. The whole figure with its weapon always shows: at true size when the screen is big enough, else
 * scaled down by the exact factor that fits. The screen is centred on the middle of the extent (`side` -1 when the character is flipped to
 * face right, which mirrors the extent about the origin), and the feet stand MARGIN above the bottom edge.
 */
export function cellCamera(scale: number, width: number, height: number, ext: Extent, side: 1 | -1 = 1): Camera {
  const spanW = (ext.maxX - ext.minX) * scale;
  const spanH = (ext.maxY - ext.minY) * scale;
  const fit = Math.min(1, (width - 2 * MARGIN) / spanW, (height - 2 * MARGIN) / spanH);
  const s = scale * fit;
  return { x: width / 2 - side * ((ext.minX + ext.maxX) / 2) * s, y: height - MARGIN - ext.maxY * s, scale: s, fit };
}

/** The screen width that holds the whole figure with its weapon at true size, in steps of 20 px, within the limits for this window. */
export function cellWidthFor(scale: number, ext: Extent, viewportWidth: number): number {
  const need = Math.ceil(((ext.maxX - ext.minX) * scale + 2 * MARGIN) / 20) * 20;
  return Math.max(CELL_W, Math.min(need, MAX_W, Math.floor(viewportWidth * 0.28)));
}

/** "true size" at fit 1, else "fit 82%". */
export function fitLabel(fit: number): string {
  return fit >= 0.9995 ? "true size" : `fit ${Math.round(fit * 100)}%`;
}

/** The pose time the dock shows: the held frame of the editor's time. */
export function dockFrameTime(clip: Pick<ClipData, "fps" | "duration">, editorTime: number): number {
  return Math.min(clip.duration, heldTime(clip, Math.max(0, editorTime)));
}

/**
 * Where the dock samples the clip. Paused it is the held frame of the editor's time. Playing it runs the project clock from the
 * time play started (hit-stop freezes it on a `hit` event, then it catches up), and starts over when the editor wraps or jumps.
 */
export class DockFollower {
  private clock: GameClock | null = null;
  private base = 0;
  private lastEditor = 0;
  private lastNow = 0;

  sample(clip: Pick<ClipData, "events" | "duration" | "fps">, editorTime: number, playing: boolean, nowMs: number): { t: number; held: boolean } {
    if (!playing) {
      this.clock = null;
      return { t: dockFrameTime(clip, editorTime), held: false };
    }
    if (!this.clock || editorTime < this.lastEditor - 1e-6) {
      this.clock = new GameClock();
      this.base = editorTime;
      this.lastNow = nowMs;
    }
    this.lastEditor = editorTime;
    const base = this.base;
    const shifted = { duration: Math.max(0, clip.duration - base), events: clip.events.filter((e) => e.time > base).map((e) => ({ ...e, time: e.time - base })) };
    const step = this.clock.step(Math.min(100, Math.max(0, nowMs - this.lastNow)), shifted, false);
    this.lastNow = nowMs;
    return { t: dockFrameTime(clip, base + step.t), held: step.held };
  }
}

/** Grows to cover every pose seen on a rig, so the camera stays still while the limbs move. */
function unionExtent(prev: Extent | undefined, b: Extent): Extent {
  return prev ? { minX: Math.min(prev.minX, b.minX), maxX: Math.max(prev.maxX, b.maxX), minY: Math.min(prev.minY, b.minY), maxY: Math.max(prev.maxY, b.maxY) } : { ...b };
}

export interface DockInfo {
  mode: DockMode;
  silhouette: boolean;
  mirror: boolean;
  facing: Facing;
  frame: number;
  held: boolean;
  renders: number;
  /** Mean ms per redraw spent re-posing the skeleton and drawing the phone. */
  poseMs: number;
  drawMs: number;
  /** The game scale shown (0.471 or 0.4), the fit factor (1 = true size) and its label. */
  zoom: number;
  fit: number;
  label: string;
  /** The rig-space extent the camera fits (null before the first draw). */
  extent: Extent | null;
  canvas: { css: [number, number]; px: [number, number] };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

const STORE = "atlas-editor-dock";

function readChoices(): Partial<Record<WorkspaceId, DockMode>> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, unknown>;
    const out: Partial<Record<WorkspaceId, DockMode>> = {};
    for (const [k, m] of Object.entries(v)) if (m === "open" || m === "rail") out[k as WorkspaceId] = m;
    return out;
  } catch {
    return {}; // storage can be unavailable
  }
}

/** Builds the dock in #dock and keeps it in step with the workspace and the editor. */
export function createPhoneDock(workspaces: Workspaces): { render(): void; info(): DockInfo } {
  const app = document.getElementById("app")!;
  const dock = document.getElementById("dock")!;
  const ground = GROUNDS.find((g) => g.id === "grass")!.ground;
  const silhouetteFilter = new ColorMatrixFilter();
  silhouetteFilter.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
  const follower = new DockFollower();
  const choices = readChoices();

  let silhouette = false;
  let mirror = false;
  let renders = 0;
  let lastKey = "";
  let lastCall = 0;
  let lastDraw = 0;
  let frameShown = 0;
  let heldShown = false;
  let facingShown: Facing = "left";
  let dpr = window.devicePixelRatio || 1;
  let cellW = CELL_W;
  let cellH = 320;
  let zoom: number = PREVIEW_SCALES[1];
  let fitShown = 1;
  let extentShown: Extent | null = null;
  let rt: RenderTexture | null = null;
  const cost = { pose: 0, draw: 0, n: 0 };
  const extents = new Map<string, Extent>();

  const collapse = el("button", { id: "dock-collapse", type: "button", className: "dk-btn", innerHTML: iconHtml("chevR") });
  const head = el("div", { className: "dk-head" }, el("span", { className: "label", textContent: "Phone" }), collapse);
  const canvas = el("canvas", { id: "dock-canvas", className: "dk-canvas" });
  canvas.style.width = `${cellW}px`;
  canvas.style.height = `${cellH}px`;
  const caption = el("div", { id: "dock-scale", className: "label dk-cap" });
  const phone = el("div", { className: "dk-phone" }, el("div", { className: "dk-screen" }, canvas), caption);
  const zoomBtns = new Map<number, HTMLButtonElement>();
  const zoomSeg = el("div", { className: "seg dk-zoom" });
  for (const z of [PREVIEW_SCALES[1], PREVIEW_SCALES[0]]) {
    const b = el("button", { id: `dock-z${Math.round(z * 1000)}`, type: "button", textContent: z === PREVIEW_SCALES[1] ? "Phone (large)" : "Phone (small)", title: `Phone scale ${z}` });
    b.addEventListener("click", () => {
      zoom = z;
      for (const [k, btn] of zoomBtns) btn.classList.toggle("on", k === z);
      render(true);
    });
    zoomBtns.set(z, b);
    zoomSeg.append(b);
  }
  zoomBtns.get(zoom)!.classList.add("on");
  const silBtn = el("button", { id: "dock-silhouette", type: "button", className: "dk-tool", textContent: "Silhouette" });
  const mirBtn = el("button", { id: "dock-mirror", type: "button", className: "dk-tool" });
  mirBtn.innerHTML = `${iconHtml("mirror")}Mirror`;
  mirBtn.title = "Mirror: preview the right-facing side (the runtime flips the left view for it)";
  const readout = el("div", { id: "dock-info", className: "dk-info readout" });
  const body = el("div", { className: "dk-body" }, head, phone, zoomSeg, el("div", { className: "dk-tools" }, silBtn, mirBtn), readout);
  const openBtn = el("button", { id: "dock-open", type: "button", className: "dk-rail" });
  fillRail(openBtn, "Phone", "left");
  dock.append(body, openBtn);

  const stacked = (): boolean => window.innerWidth < DOCK_STACK_WIDTH;
  const mode = (): DockMode => (app.classList.contains("dockopen") ? (app.classList.contains("dockrail") ? "rail" : "open") : "hidden");
  const setMode = (m: DockMode): void => {
    app.classList.toggle("dockopen", m !== "hidden");
    app.classList.toggle("dockrail", m === "rail");
    app.classList.toggle("dockstack", m !== "hidden" && stacked());
    if (m === "open") {
      fitHeight();
      render(true);
    }
  };
  const choose = (ws: WorkspaceId, m: "open" | "rail"): void => {
    choices[ws] = m;
    try {
      localStorage.setItem(STORE, JSON.stringify(choices));
    } catch {
      // the choice still holds for this session
    }
    setMode(m);
  };
  const apply = (ws: WorkspaceId): void => setMode(dockModeFor(ws) === "hidden" ? "hidden" : (choices[ws] ?? dockModeFor(ws, window.innerWidth)));

  collapse.addEventListener("click", () => choose(workspaces.current(), "rail"));
  openBtn.addEventListener("click", () => choose(workspaces.current(), "open"));
  silBtn.addEventListener("click", () => {
    silhouette = !silhouette;
    silBtn.classList.toggle("on", silhouette);
    render(true);
  });
  mirBtn.addEventListener("click", () => {
    mirror = !mirror;
    mirBtn.classList.toggle("on", mirror);
    render(true);
  });

  function drawCell(h: EditorHost, facing: Facing, ext: Extent): void {
    const ch = h.character!;
    const { app: pixi, world } = h;
    if (!rt || dpr !== rt.source.resolution || rt.height !== cellH || rt.width !== cellW) {
      rt?.destroy(true);
      rt = RenderTexture.create({ width: cellW, height: cellH, resolution: dpr });
    }
    const cam = cellCamera(zoom, cellW, cellH, ext, facing === "right" ? -1 : 1);
    fitShown = cam.fit;
    extentShown = ext;
    const saved = { x: world.position.x, y: world.position.y, sx: world.scale.x, sy: world.scale.y, filters: ch.filters, scaleX: ch.scale.x };
    // Only the character: hide the bone overlay, onion skins and underlay that share the world container.
    const hidden = world.children.filter((k) => k !== ch && k.visible);
    for (const k of hidden) k.visible = false;
    try {
      world.scale.set(cam.scale);
      world.position.set(cam.x, cam.y);
      applyFacing(ch, facing);
      ch.filters = silhouette ? [silhouetteFilter] : [];
      pixi.renderer.render({ container: pixi.stage, target: rt, clear: true, clearColor: silhouette ? SILHOUETTE_GROUND : ground });
      // One read back of the opaque render (no scratch canvas per draw), put straight into the phone's canvas.
      const px = pixi.renderer.extract.pixels({ target: rt, frame: new Rectangle(0, 0, cellW, cellH) });
      const w = px.width;
      const hh = px.height;
      if (canvas.width !== w || canvas.height !== hh) {
        canvas.width = w;
        canvas.height = hh;
      }
      canvas.getContext("2d")!.putImageData(new ImageData(px.pixels as unknown as Uint8ClampedArray<ArrayBuffer>, w, hh), 0, 0);
    } finally {
      for (const k of hidden) k.visible = true;
      world.position.set(saved.x, saved.y);
      world.scale.set(saved.sx, saved.sy);
      ch.filters = saved.filters ? [...saved.filters] : null;
      ch.scale.x = saved.scaleX;
    }
  }

  function render(force = false): void {
    if (mode() !== "open") return;
    const h = getHost();
    if (!h || !h.character || !h.skeleton || !h.rig) return;
    dpr = window.devicePixelRatio || 1;
    // The main canvas comes first: while playing, when the editor itself is running slow (frame gaps over SLOW_GAP_MS) the dock
    // drops to at most one redraw per DOCK_SLOW_MS until the editor recovers.
    const now = performance.now();
    const gap = now - lastCall;
    lastCall = now;
    if (h.playing && !force && gap > SLOW_GAP_MS && now - lastDraw < DOCK_SLOW_MS) return;
    const { t, held } = follower.sample(h.clip, h.time, h.playing, performance.now());
    const frame = timeToFrame(h.clip, t);
    const facing: Facing = mirror ? "right" : h.facing;
    const key = `${frame}|${zoom}|${silhouette}|${facing}|${h.rig.outfit.id}`;
    heldShown = held;
    // Playing, the pose only changes with the held frame: draw each frame once. Paused, an edit can change the pose under the same frame.
    if (h.playing && !force && key === lastKey) return;
    lastKey = key;
    // The editor already posed the skeleton at its own time; only pose again when the dock samples somewhere else (hit-stop, held frames).
    const moved = Math.abs(t - h.time) > 1e-9;
    const t0 = performance.now();
    if (moved) h.poseAt(t);
    const t1 = performance.now();
    try {
      const b = h.character.getLocalBounds();
      const ext = unionExtent(extents.get(`${h.rig.outfit.id}|${h.clipName}`), { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY });
      extents.set(`${h.rig.outfit.id}|${h.clipName}`, ext);
      const want = stacked() ? Math.max(180, dock.clientWidth - 24) : cellWidthFor(zoom, ext, window.innerWidth);
      if (want !== cellW) {
        cellW = want;
        canvas.style.width = `${cellW}px`;
        if (!stacked()) app.style.setProperty("--dock-w", `${cellW + 24}px`);
      }
      drawCell(h, facing, ext);
    } finally {
      const t2 = performance.now();
      if (moved) h.restorePose();
      cost.pose += t1 - t0 + (performance.now() - t2);
      cost.draw += t2 - t1;
      cost.n++;
    }
    renders++;
    lastDraw = performance.now();
    frameShown = frame;
    facingShown = facing;
    caption.textContent = fitShown >= 0.9995 ? "Shown at true size" : `Shown at ${Math.round(fitShown * 100)}% of true size`;
    caption.title = `Phone scale ${zoom}; ${fitShown >= 0.9995 ? "true size" : `${fitLabel(fitShown)}, drawn at ${(zoom * fitShown).toFixed(3)}`}`;
    readout.textContent = `${facing === "right" ? "Facing right" : "Facing left"}${held ? " · hit-stop" : ""}`;
  }

  // The screen takes the height the dock has.
  const fitHeight = (): void => {
    if (mode() !== "open") return;
    const next = stacked() ? Math.max(MIN_H, Math.min(300, Math.floor(window.innerHeight * 0.3))) : cellHeightFor(dock.clientHeight);
    if (next !== cellH) {
      cellH = next;
      canvas.style.height = `${cellH}px`;
    }
    if (stacked()) app.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
    render(true);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitHeight).observe(dock);
  window.addEventListener("resize", () => {
    app.classList.toggle("dockstack", mode() !== "hidden" && stacked());
    fitHeight();
  });

  whenHost((h) => {
    for (const ev of ["pose", "rig", "skins", "clip"] as const) h.on(ev, () => render());
  });
  workspaces.onChange((id) => apply(id));
  apply(workspaces.current());

  const info = (): DockInfo => ({
    mode: mode(),
    silhouette,
    mirror,
    facing: facingShown,
    frame: frameShown,
    held: heldShown,
    renders,
    poseMs: cost.n ? cost.pose / cost.n : 0,
    drawMs: cost.n ? cost.draw / cost.n : 0,
    zoom,
    fit: fitShown,
    label: fitLabel(fitShown),
    extent: extentShown,
    canvas: { css: [canvas.clientWidth, canvas.clientHeight], px: [canvas.width, canvas.height] }
  });
  (window as unknown as { atlasDock?: unknown }).atlasDock = {
    info,
    render: () => render(true),
    setZoom: (z: number) => zoomBtns.get(z)?.click(),
    toggleSilhouette: () => silBtn.click(),
    toggleMirror: () => mirBtn.click(),
    collapse: () => collapse.click(),
    open: () => openBtn.click()
  };
  return { render: () => render(true), info };
}
