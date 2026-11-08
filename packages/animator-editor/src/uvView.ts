/*
 * UV view for the Mesh tool (MESH-WEIGHTS-PLAN section 1, chunk M2): the attachment's picture with its wireframe, in image pixels.
 * It shares the vertex selection with the canvas (the tool owns the selection; this view reports picks) and dragging vertices here moves
 * their UVs only. The view draws; the tool commits.
 */
import type { RgbaImage } from "@atlas-animator/core/pixi";
import { pickVertex, verticesInBox } from "./vertexSelect.js";

export interface UvState {
  picture: RgbaImage | null;
  width: number;
  height: number;
  /** UV positions, image pixels (x, y per vertex). */
  points: readonly number[];
  triangles: readonly number[];
  hull: number;
  edges: readonly (readonly [number, number])[];
  selection: ReadonlySet<number>;
}

export interface UvViewOptions {
  parent: HTMLElement;
  /** A click or box pick: the hit vertices and the modifier keys. */
  onPick(hits: number[], mods: { shift: boolean; ctrl: boolean }): void;
  /** A drag finished: move these vertices' UVs by (dx, dy) image pixels. */
  onMove(vertices: number[], dx: number, dy: number): void;
  onToggle?(open: boolean): void;
}

export interface UvView {
  readonly el: HTMLElement;
  update(state: UvState): void;
  setOpen(open: boolean): void;
  destroy(): void;
}

const SIZE = 264;
const COLORS = { tri: "rgba(140, 150, 168, 0.55)", hull: "#ffb347", edge: "#5fb3ff", dot: "#d9dee8", sel: "#f0b84a", frame: "rgba(240, 184, 74, 0.5)" };

export function createUvView(options: UvViewOptions): UvView {
  const root = document.createElement("div");
  root.className = "mesh-uv";
  root.id = "mesh-uv";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "mesh-uv-head";
  head.id = "mesh-uv-head";
  head.innerHTML = '<span class="mesh-uv-title">UV view</span><span class="mesh-uv-chev" aria-hidden="true"></span>';
  head.title = "The picture with its wireframe. Drag vertices here to move their UVs only; the selection is shared with the canvas.";
  const body = document.createElement("div");
  body.className = "mesh-uv-body";
  const canvas = document.createElement("canvas");
  canvas.id = "mesh-uv-canvas";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE}px`;
  const foot = document.createElement("div");
  foot.className = "mesh-uv-foot";
  foot.textContent = "Wheel zooms, Space-drag pans. Drag a vertex to move its UV.";
  body.append(canvas, foot);
  root.append(head, body);
  options.parent.append(root);

  let state: UvState | null = null;
  let open = true;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let pictureCanvas: HTMLCanvasElement | null = null;
  let pictureOf: RgbaImage | null = null;
  let drag: { kind: "move"; vertices: number[]; sx: number; sy: number; dx: number; dy: number } | { kind: "box"; sx: number; sy: number; x: number; y: number } | { kind: "pan"; sx: number; sy: number; px: number; py: number } | null = null;
  let space = false;
  const ctx = canvas.getContext("2d")!;

  const fit = () => (state && state.width > 0 && state.height > 0 ? Math.min((SIZE - 24) / state.width, (SIZE - 24) / state.height) : 1);
  const scale = () => fit() * zoom;
  const origin = () => {
    const s = scale();
    return { x: (SIZE - (state?.width ?? 0) * s) / 2 + panX, y: (SIZE - (state?.height ?? 0) * s) / 2 + panY };
  };
  const toView = (x: number, y: number) => {
    const o = origin();
    const s = scale();
    return { x: o.x + x * s, y: o.y + y * s };
  };
  const toImage = (vx: number, vy: number) => {
    const o = origin();
    const s = scale();
    return { x: (vx - o.x) / s, y: (vy - o.y) / s };
  };

  function pictureLayer(): HTMLCanvasElement | null {
    const pic = state?.picture ?? null;
    if (!pic) return null;
    if (pictureOf === pic && pictureCanvas) return pictureCanvas;
    const c = document.createElement("canvas");
    c.width = pic.width;
    c.height = pic.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pic.data), pic.width, pic.height), 0, 0);
    pictureOf = pic;
    pictureCanvas = c;
    return c;
  }

  function draw(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (!state) return;
    const s = scale();
    const o = origin();
    // checkerboard behind the picture so transparent pixels read
    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, state.width * s, state.height * s);
    ctx.clip();
    const cell = 8;
    for (let y = 0; y * cell < SIZE; y++) for (let x = 0; x * cell < SIZE; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#232936" : "#1b2029";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
    const layer = pictureLayer();
    if (layer) {
      ctx.imageSmoothingEnabled = s < 1;
      ctx.drawImage(layer, o.x, o.y, state.width * s, state.height * s);
    }
    ctx.restore();
    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, state.width * s, state.height * s);

    const moved = (v: number) => {
      const on = drag?.kind === "move" && drag.vertices.includes(v);
      return { x: (state!.points[2 * v] as number) + (on ? (drag as { dx: number }).dx : 0), y: (state!.points[2 * v + 1] as number) + (on ? (drag as { dy: number }).dy : 0) };
    };
    const at = (v: number) => {
      const p = moved(v);
      return toView(p.x, p.y);
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.tri;
    ctx.beginPath();
    for (let t = 0; t + 2 < state.triangles.length; t += 3) {
      const a = at(state.triangles[t] as number);
      const b = at(state.triangles[t + 1] as number);
      const c = at(state.triangles[t + 2] as number);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [a, b] of state.edges) {
      const p = at(a);
      const q = at(b);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.strokeStyle = COLORS.hull;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let i = 0; i < state.hull; i++) {
      const p = at(i);
      const q = at((i + 1) % state.hull);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    const count = state.points.length / 2;
    for (let v = 0; v < count; v++) {
      const p = at(v);
      const sel = state.selection.has(v);
      ctx.beginPath();
      ctx.arc(p.x, p.y, sel ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = sel ? COLORS.sel : v < state.hull ? COLORS.hull : COLORS.dot;
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = "#1d1505";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (drag?.kind === "box") {
      ctx.strokeStyle = COLORS.sel;
      ctx.fillStyle = "rgba(240, 184, 74, 0.12)";
      ctx.lineWidth = 1;
      const x = Math.min(drag.sx, drag.x);
      const y = Math.min(drag.sy, drag.y);
      ctx.fillRect(x, y, Math.abs(drag.x - drag.sx), Math.abs(drag.y - drag.sy));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x - drag.sx), Math.abs(drag.y - drag.sy));
    }
  }

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE };
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!state) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    if (space || e.button === 1) {
      drag = { kind: "pan", sx: p.x, sy: p.y, px: panX, py: panY };
      return;
    }
    const img = toImage(p.x, p.y);
    const reach = 8 / scale();
    const hit = pickVertex(state.points, img.x, img.y, reach);
    if (hit >= 0) {
      if (!state.selection.has(hit) || e.shiftKey || e.ctrlKey || e.metaKey) options.onPick([hit], { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
      const vertices = state.selection.has(hit) || !(e.shiftKey || e.ctrlKey || e.metaKey) ? (state.selection.has(hit) ? [...state.selection] : [hit]) : [hit];
      drag = e.ctrlKey || e.metaKey ? null : { kind: "move", vertices, sx: img.x, sy: img.y, dx: 0, dy: 0 };
    } else {
      drag = { kind: "box", sx: p.x, sy: p.y, x: p.x, y: p.y };
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) options.onPick([], { shift: false, ctrl: false });
    }
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || !state) return;
    const p = local(e);
    if (drag.kind === "pan") {
      panX = drag.px + (p.x - drag.sx);
      panY = drag.py + (p.y - drag.sy);
    } else if (drag.kind === "box") {
      drag.x = p.x;
      drag.y = p.y;
    } else {
      const img = toImage(p.x, p.y);
      drag.dx = img.x - drag.sx;
      drag.dy = img.y - drag.sy;
    }
    draw();
  });
  const finish = (e: PointerEvent) => {
    if (!drag || !state) return;
    const d = drag;
    drag = null;
    if (d.kind === "box" && Math.hypot(d.x - d.sx, d.y - d.sy) > 3) {
      const a = toImage(d.sx, d.sy);
      const b = toImage(d.x, d.y);
      options.onPick(verticesInBox(state.points, { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }), { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    } else if (d.kind === "move" && Math.hypot(d.dx, d.dy) * scale() >= 2) options.onMove(d.vertices, d.dx, d.dy);
    draw();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => {
    drag = null;
    draw();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!state) return;
      e.preventDefault();
      e.stopPropagation();
      const p = local(e);
      const before = toImage(p.x, p.y);
      zoom = Math.min(16, Math.max(0.5, zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
      const after = toView(before.x, before.y);
      panX += p.x - after.x;
      panY += p.y - after.y;
      draw();
    },
    { passive: false }
  );
  const keyDown = (e: KeyboardEvent) => {
    if (e.code === "Space" && root.matches(":hover")) {
      space = true;
      e.preventDefault();
    }
  };
  const keyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") space = false;
  };
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);

  const setOpen = (value: boolean) => {
    open = value;
    root.classList.toggle("closed", !open);
    head.setAttribute("aria-expanded", String(open));
    options.onToggle?.(open);
  };
  head.addEventListener("click", () => setOpen(!open));
  setOpen(true);

  return {
    el: root,
    update(next) {
      const resized = !state || state.width !== next.width || state.height !== next.height;
      state = next;
      if (resized) {
        zoom = 1;
        panX = 0;
        panY = 0;
      }
      if (open) draw();
    },
    setOpen,
    destroy() {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      root.remove();
    }
  };
}
