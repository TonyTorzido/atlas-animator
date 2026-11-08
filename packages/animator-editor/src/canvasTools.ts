/*
 * Atlas Animator editor: original implementation.
 *
 * Canvas tools around the view: the axis space the move / rotate gizmo and numeric entry use (Local / Parent / World), the
 * Bones / Images / Others selectable + visible grid (editor-only: nothing here is saved into a rig or a clip), and the controls on
 * the canvas's left edge (ruler toggle, vertical zoom slider with + and -, zoom to fit, 100%). The pure parts (arm hit tests, move
 * projection, ruler ticks, slider mapping) are exported for tests; everything else talks to the editor through the EditorHost.
 */
import { axisFrame, type BoneLike, type Space } from "./transformModel.js";
import type { EditorHost } from "./host.js";
import { iconEl, type IconName } from "./icons.js";

// ---------------------------------------------------------------------------------------------
// Axis space
// ---------------------------------------------------------------------------------------------

let space: Space = "parent";
const spaceListeners = new Set<() => void>();

export const getSpace = (): Space => space;

export function setSpace(next: Space): void {
  if (next === space) return;
  space = next;
  for (const fn of [...spaceListeners]) fn();
}

export function onSpace(fn: () => void): () => void {
  spaceListeners.add(fn);
  return () => void spaceListeners.delete(fn);
}

// ---------------------------------------------------------------------------------------------
// Bones / Images / Others: selectable and visible
// ---------------------------------------------------------------------------------------------

export type Layer = "bones" | "images" | "others";
export const LAYERS: readonly Layer[] = ["bones", "images", "others"];
export type LayerKey = "selectable" | "visible";

const flags: Record<Layer, Record<LayerKey, boolean>> = {
  bones: { selectable: true, visible: true },
  images: { selectable: true, visible: true },
  // Others = the helper bones (IK targets, twist helpers ...): hidden by default like the Helpers button.
  others: { selectable: true, visible: false }
};
const layerListeners = new Set<() => void>();

export const layerFlag = (layer: Layer, key: LayerKey): boolean => flags[layer][key];

export function setLayerFlag(layer: Layer, key: LayerKey, on: boolean): void {
  if (flags[layer][key] === on) return;
  flags[layer][key] = on;
  for (const fn of [...layerListeners]) fn();
}

export function onLayers(fn: () => void): () => void {
  layerListeners.add(fn);
  return () => void layerListeners.delete(fn);
}

/** Whether a click on the canvas may pick a bone: helper bones belong to Others, the rest to Bones. */
export const boneSelectable = (isHelper: boolean): boolean => flags[isHelper ? "others" : "bones"].selectable;

/** Whether a click may pick an image (the Setup image tool). */
export const imagesSelectable = (): boolean => flags.images.selectable;

// ---------------------------------------------------------------------------------------------
// Move gizmo in an axis space
// ---------------------------------------------------------------------------------------------

export type Arm = "x" | "y" | "xy";

/** Screen length of a move arm and how close a click must be to grab it / the centre. */
export const MOVE_ARM_PX = 46;
const ARM_GRAB_PX = 12;
const CENTER_GRAB_PX = 18;

/** The arm of the move gizmo under a point (skeleton space), or null. `xy` is the centre (free move). */
export function moveArmAt(origin: { x: number; y: number }, bone: BoneLike, sp: Space, zoom: number, x: number, y: number): Arm | null {
  const f = axisFrame(bone, sp);
  const dx = x - origin.x;
  const dy = y - origin.y;
  if (Math.hypot(dx, dy) <= CENTER_GRAB_PX / zoom) return "xy";
  const len = MOVE_ARM_PX / zoom;
  const grab = ARM_GRAB_PX / zoom;
  for (const [arm, u] of [["x", f.ux], ["y", f.uy]] as const) {
    const along = dx * u[0] + dy * u[1];
    const across = Math.abs(-dx * u[1] + dy * u[0]);
    if (along >= 0 && along <= len + grab && across <= grab) return arm;
  }
  return null;
}

/** A drag of (dx, dy) in skeleton space, held to one arm of the frame (the centre leaves it free). */
export function projectMove(bone: BoneLike, sp: Space, arm: Arm | null, dx: number, dy: number): { dx: number; dy: number } {
  if (!arm || arm === "xy") return { dx, dy };
  const f = axisFrame(bone, sp);
  const u = arm === "x" ? f.ux : f.uy;
  const d = dx * u[0] + dy * u[1];
  return { dx: d * u[0], dy: d * u[1] };
}

/** Minimal slice of Pixi's Graphics the gizmo draws with. */
export interface Pen {
  moveTo(x: number, y: number): Pen;
  lineTo(x: number, y: number): Pen;
  circle(x: number, y: number, r: number): Pen;
  stroke(o: { width: number; color: number; alpha?: number }): Pen;
}

/** Draws the move gizmo: both arms along the space's axes (red x, green y), the arm being dragged (`grabbed`) lit, the centre ring. */
export function drawMoveGizmo(g: Pen, bone: BoneLike, origin: { x: number; y: number }, sp: Space, px: number, grabbed: Arm | null = null): void {
  const f = axisFrame(bone, sp);
  const len = MOVE_ARM_PX * px;
  const lit = (a: Arm) => (grabbed === a ? 0xffffff : a === "x" ? 0xff7a7a : 0x6bd68f);
  for (const [arm, u] of [["x", f.ux], ["y", f.uy]] as const) {
    g.moveTo(origin.x - u[0] * len * 0.35, origin.y - u[1] * len * 0.35).lineTo(origin.x + u[0] * len, origin.y + u[1] * len).stroke({ width: (grabbed === arm ? 3 : 2) * px, color: lit(arm) });
    // A small arrowhead on the positive end.
    const hx = origin.x + u[0] * len;
    const hy = origin.y + u[1] * len;
    g.moveTo(hx - u[0] * 8 * px - u[1] * 4 * px, hy - u[1] * 8 * px + u[0] * 4 * px).lineTo(hx, hy).lineTo(hx - u[0] * 8 * px + u[1] * 4 * px, hy - u[1] * 8 * px - u[0] * 4 * px).stroke({ width: 2 * px, color: lit(arm) });
  }
  g.circle(origin.x, origin.y, 8 * px).stroke({ width: 2 * px, color: grabbed === "xy" ? 0xffffff : 0xf0b84a });
}

/** True when a press `dist` skeleton units from the selected bone's origin lands on its rotate ring (radius `ringPx` screen px, grabbed within a fat band so it is easy to hit). */
export function onRotateRing(dist: number, ringPx: number, zoom: number): boolean {
  return Math.abs(dist * zoom - ringPx) <= Math.max(16, ringPx * 0.25);
}

/** Rotate gizmo: a tick on the ring at the space's zero direction (world east / the parent's x axis). Local is the bone's own handle line. */
export function drawRotateRef(g: Pen, bone: BoneLike, origin: { x: number; y: number }, sp: Space, radius: number, px: number): void {
  if (sp === "local") return;
  const u = axisFrame(bone, sp).ux;
  g.moveTo(origin.x + u[0] * radius * 0.9, origin.y + u[1] * radius * 0.9).lineTo(origin.x + u[0] * radius * 1.12, origin.y + u[1] * radius * 1.12).stroke({ width: 2 * px, color: 0x8c96a8 });
}

// ---------------------------------------------------------------------------------------------
// Ruler and zoom slider maths
// ---------------------------------------------------------------------------------------------

/** Zoom limits of the view (main.ts clamps to the same). */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

/** Slider position (0..1, bottom to top) of a zoom, on a log scale. */
export const zoomToSlider = (z: number): number => (Math.log(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN));
export const sliderToZoom = (t: number): number => Math.exp(Math.log(ZOOM_MIN) + Math.min(1, Math.max(0, t)) * (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN)));

/** A "nice" tick step (1, 2 or 5 times a power of ten) in rig units, at least `minPx` pixels apart at `scale` px per unit. */
export function rulerStep(scale: number, minPx = 56): number {
  const raw = minPx / Math.max(1e-6, scale);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** Tick positions (rig units) covering [from, to]. */
export function rulerTicks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Edge controls and rulers (DOM)
// ---------------------------------------------------------------------------------------------

export function icon(name: string): SVGElement {
  return iconEl(name as IconName);
}

/** Ids of the controls this module builds (each has an entry in tooltips.ts). */
export const EDGE_IDS = ["xs-ruler", "xs-zoom", "xs-mag"] as const;


/**
 * Keeps a bar on ONE row: when its content is wider than the bar, the `items` (the order they give way in: the first entry moves
 * first) move into a "..." popover, and the "..." button shows only while something is in it. `bar` must be `flex-wrap: nowrap`;
 * `up` opens the popover above the bar instead of below it. `rebuilt` lists elements whose children a module rebuilds from time to
 * time (the Setup tool row): the bar is fitted again after each rebuild.
 */
export function installOverflow(bar: HTMLElement, items: Array<() => HTMLElement | null>, up = false, rebuilt: HTMLElement[] = []): { fit(): void } {
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn-icon ovf-btn";
  more.hidden = true;
  more.setAttribute("aria-label", "More controls");
  more.setAttribute("aria-haspopup", "true");
  more.title = "More controls";
  more.append(icon("more"));
  const pop = document.createElement("div");
  pop.className = `pop ovf-pop${up ? " up" : ""}`;
  pop.hidden = true;
  bar.append(more, pop);
  const holes = new Map<HTMLElement, Comment>();
  const setOpen = (open: boolean) => {
    pop.hidden = !open || more.hidden;
    more.classList.toggle("on", !pop.hidden);
  };
  const fit = () => {
    const wasOpen = !pop.hidden;
    for (const [el, hole] of holes) hole.replaceWith(el);
    holes.clear();
    pop.replaceChildren();
    more.hidden = true;
    pop.hidden = true;
    for (const get of items) {
      if (bar.scrollWidth <= bar.clientWidth + 1) break;
      const el = get();
      if (!el || el.offsetWidth === 0) continue;
      const hole = document.createComment("ovf");
      el.before(hole);
      holes.set(el, hole);
      pop.append(el);
      more.hidden = false;
    }
    setOpen(wasOpen);
    watch.takeRecords();
    for (const c of bar.children) ro.observe(c);
    for (const get of items) {
      const el = get();
      if (el) ro.observe(el);
    }
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit();
    });
  };
  const ro = new ResizeObserver(later);
  ro.observe(bar);
  const watch = new MutationObserver(later);
  for (const r of rebuilt) watch.observe(r, { childList: true });
  more.addEventListener("click", () => setOpen(pop.hidden));
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !more.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) setOpen(false);
  });
  new MutationObserver(later).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  later();
  return { fit: later };
}

const RULER_BAND = 18;

export function installCanvasEdge(host: EditorHost, view: HTMLElement = document.getElementById("view")!): void {
  // Batch 2: the left-edge column is gone. Zoom out / % / in / Fit and Bones / Helpers are static buttons in the stage context bar (index.html: #ctx-view, #ctx-vis,
  // main.ts binds them by id); the rest of the zoom controls are the Zoom and bones section of the Overlays popover.
  const btn = (id: string, ic: string, label: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "xs-btn";
    b.setAttribute("aria-label", label);
    b.append(icon(ic), Object.assign(document.createElement("span"), { textContent: label }));
    return b;
  };
  const ruler = btn("xs-ruler", "ruler", "Rulers");
  const mag = btn("xs-mag", "magnifier", "100%");
  mag.setAttribute("aria-label", "Zoom to 100%");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = "xs-zoom";
  slider.min = "0";
  slider.max = "1000";
  slider.step = "1";
  slider.className = "xs-zslider";
  slider.setAttribute("aria-label", "Zoom");
  document.getElementById("ov-zoom")?.prepend(ruler, mag, slider);
  const sizeSlider = document.getElementById("bonesize");
  sizeSlider?.removeAttribute("style");
  sizeSlider?.setAttribute("aria-label", "Bone size");

  // Give way (first entry first) into the bar's "..." popover: Bones / Helpers, then the zoom group (the wheel and Fit key still zoom). Axes and Keep in place never leave.
  installOverflow(document.getElementById("vtop")!, [() => document.getElementById("ctx-vis"), () => document.getElementById("ctx-view")]);
  const canvas = document.createElement("canvas");
  canvas.id = "xs-rulers";
  view.append(canvas);

  let rulersOn = false;
  ruler.addEventListener("click", () => {
    rulersOn = !rulersOn;
    ruler.classList.toggle("on", rulersOn);
    document.body.classList.toggle("xs-ruler", rulersOn);
    canvas.style.display = rulersOn ? "block" : "none";
    last = "";
  });
  canvas.style.display = "none";
  mag.addEventListener("click", () => host.view.zoomTo(1));
  slider.addEventListener("input", () => host.view.zoomTo(sliderToZoom(Number(slider.value) / 1000)));

  let last = "";
  const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const frame = () => {
    const v = host.view.state();
    slider.value = String(Math.round(zoomToSlider(v.zoom) * 1000));
    if (rulersOn) {
      const sig = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.zoom.toFixed(4)},${v.w},${v.h}`;
      if (sig !== last) {
        last = sig;
        drawRulers(canvas, v, css("--line", "#2d3443"), css("--dim", "#8c96a8"), css("--panel", "#1b1f27"), css("--accent", "#f0b84a"));
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function drawRulers(canvas: HTMLCanvasElement, v: { x: number; y: number; zoom: number; w: number; h: number }, line: string, dim: string, bg: string, accent: string): void {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(v.w * dpr) || canvas.height !== Math.round(v.h * dpr)) {
    canvas.width = Math.round(v.w * dpr);
    canvas.height = Math.round(v.h * dpr);
    canvas.style.width = `${v.w}px`;
    canvas.style.height = `${v.h}px`;
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, v.w, v.h);
  g.fillStyle = bg;
  g.globalAlpha = 0.92;
  g.fillRect(0, 0, v.w, RULER_BAND);
  g.fillRect(0, 0, RULER_BAND, v.h);
  g.globalAlpha = 1;
  g.strokeStyle = line;
  g.beginPath();
  g.moveTo(0, RULER_BAND + 0.5);
  g.lineTo(v.w, RULER_BAND + 0.5);
  g.moveTo(RULER_BAND + 0.5, 0);
  g.lineTo(RULER_BAND + 0.5, v.h);
  g.stroke();
  g.font = "10px 'Segoe UI', system-ui, sans-serif";
  g.fillStyle = dim;
  g.strokeStyle = dim;
  const step = rulerStep(v.zoom);
  const minor = step / 5;
  const toScreenX = (u: number) => v.x + u * v.zoom;
  const toScreenY = (u: number) => v.y + u * v.zoom;
  g.beginPath();
  g.textBaseline = "top";
  for (const u of rulerTicks((RULER_BAND - v.x) / v.zoom, (v.w - v.x) / v.zoom, step)) {
    const sx = Math.round(toScreenX(u)) + 0.5;
    g.moveTo(sx, RULER_BAND - 7);
    g.lineTo(sx, RULER_BAND);
    g.fillText(String(Math.round(u * 100) / 100), sx + 3, 2);
  }
  if (minor * v.zoom >= 6) {
    for (const u of rulerTicks((RULER_BAND - v.x) / v.zoom, (v.w - v.x) / v.zoom, minor)) {
      const sx = Math.round(toScreenX(u)) + 0.5;
      g.moveTo(sx, RULER_BAND - 3);
      g.lineTo(sx, RULER_BAND);
    }
  }
  for (const u of rulerTicks((RULER_BAND - v.y) / v.zoom, (v.h - v.y) / v.zoom, step)) {
    const sy = Math.round(toScreenY(u)) + 0.5;
    g.moveTo(RULER_BAND - 7, sy);
    g.lineTo(RULER_BAND, sy);
    g.save();
    g.translate(2, sy - 3);
    g.rotate(-Math.PI / 2);
    g.textBaseline = "top";
    g.fillText(String(Math.round(u * 100) / 100), 0, 0);
    g.restore();
  }
  if (minor * v.zoom >= 6) {
    for (const u of rulerTicks((RULER_BAND - v.y) / v.zoom, (v.h - v.y) / v.zoom, minor)) {
      const sy = Math.round(toScreenY(u)) + 0.5;
      g.moveTo(RULER_BAND - 3, sy);
      g.lineTo(RULER_BAND, sy);
    }
  }
  g.stroke();
  // The rig origin (0, 0) gets an accent mark on both rulers.
  g.fillStyle = accent;
  const ox = toScreenX(0);
  const oy = toScreenY(0);
  if (ox > RULER_BAND && ox < v.w) g.fillRect(Math.round(ox) - 1, RULER_BAND - 3, 2, 3);
  if (oy > RULER_BAND && oy < v.h) g.fillRect(RULER_BAND - 3, Math.round(oy) - 1, 3, 2);
}

/** Pixels at the bottom of the view the transform strip and the tip line cover; the fit leaves them free. */
export function viewInset(view: HTMLElement = document.getElementById("view")!): number {
  return viewInsets(view).b;
}

/**
 * The strips drawn over the posing canvas: the toolbar row on top (t), the edge column on the left (l) and the tip line plus
 * transform strip at the bottom (b). Fit frames the character in what is left, so nothing ever covers it.
 */
export function viewInsets(view: HTMLElement = document.getElementById("view")!): { l: number; t: number; b: number } {
  const r = view.getBoundingClientRect();
  const shown = (e: HTMLElement | null): e is HTMLElement => !!e && e.offsetParent !== null && e.offsetWidth > 0;
  const top = view.querySelector<HTMLElement>("#vtop");
  const tip = view.querySelector<HTMLElement>("#vtip");
  const strip = view.querySelector<HTMLElement>("#xstrip");
  const edge = view.querySelector<HTMLElement>("#toolpalette");
  const t = shown(top) ? Math.max(0, Math.ceil(top.getBoundingClientRect().bottom - r.top)) + 4 : 0;
  const stripTop = shown(strip) ? strip.getBoundingClientRect().top : r.bottom;
  const tipTop = shown(tip) ? tip.getBoundingClientRect().top : stripTop;
  const hint = view.querySelector<HTMLElement>("#setuphint");
  const hintTop = shown(hint) ? hint.getBoundingClientRect().top : r.bottom;
  const b = Math.max(0, Math.ceil(r.bottom - Math.min(stripTop, tipTop, hintTop))) + 4;
  const l = shown(edge) ? Math.max(0, Math.ceil(edge.getBoundingClientRect().right - r.left)) + 6 : 0;
  return { l, t, b };
}
