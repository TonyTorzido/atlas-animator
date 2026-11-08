/*
 * Atlas Animator editor: original implementation.
 *
 * The easing picker that opens on a click on one segment of a dopesheet curve: six presets drawn as curve thumbnails (linear, ease in,
 * ease out, ease both, stepped, bounce). It applies to the selected segments, so one click batch-sets many. It is a popover with
 * arrow-key / Enter / Esc handling; the caller decides what a pick does (curveRows.applySegmentPreset through main.ts commit).
 */
import type { CurveSpec } from "@atlas-animator/core/core";
import { presetPoints, SEG_PRESETS, type SegPresetId } from "./curveRows.js";

export interface SegPickerOpen {
  /** Client position to anchor near (the click). */
  x: number;
  y: number;
  count: number;
  /** The preset all the selected segments share, "mixed" when they differ, null when hand-tuned. */
  current: SegPresetId | "mixed" | null;
  /** Channel colour for the thumbnails. */
  color: string;
}

export interface SegPickerHandlers {
  pick(spec: CurveSpec, id: SegPresetId): void;
  /** Adds every segment of the clicked channel to the selection. */
  addChannel(): void;
  /** Adds the segments that start at the selected dopesheet keys. */
  addKeys(): void;
  clear(): void;
  closed(): void;
}

export interface SegPicker {
  open(at: SegPickerOpen): void;
  close(): void;
  isOpen(): boolean;
}

const W = 46;
const H = 30;

function thumb(spec: CurveSpec, color: string): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement("canvas");
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  c.style.width = `${W}px`;
  c.style.height = `${H}px`;
  c.setAttribute("aria-hidden", "true");
  const g = c.getContext("2d");
  if (!g) return c;
  g.scale(dpr, dpr);
  const pts = presetPoints(spec);
  const lo = Math.min(0, ...pts.map((p) => p.y));
  const hi = Math.max(1, ...pts.map((p) => p.y));
  const px = 5;
  const py = 5;
  const X = (x: number) => px + x * (W - 2 * px);
  const Y = (y: number) => H - py - ((y - lo) / (hi - lo)) * (H - 2 * py);
  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(X(0), Y(0) + 0.5);
  g.lineTo(X(1), Y(0) + 0.5);
  g.moveTo(X(0), Y(1) + 0.5);
  g.lineTo(X(1), Y(1) + 0.5);
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.lineJoin = "round";
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
  g.stroke();
  g.fillStyle = color;
  for (const p of [pts[0]!, pts[pts.length - 1]!]) {
    g.beginPath();
    g.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

export function createSegPicker(h: SegPickerHandlers): SegPicker {
  const root = document.createElement("div");
  root.id = "segpicker";
  root.className = "pop";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Segment easing");
  root.hidden = true;
  document.body.append(root);
  let isOpen = false;

  const close = (notify = true): void => {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    root.replaceChildren();
    if (notify) h.closed();
  };

  const onDown = (e: PointerEvent) => {
    if (isOpen && !root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const items = [...root.querySelectorAll<HTMLButtonElement>("button.sp-item")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 3 : e.key === "ArrowUp" ? -3 : 0;
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      items[Math.max(0, Math.min(items.length - 1, at + move))]?.focus();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);

  return {
    isOpen: () => isOpen,
    close: () => close(),
    open(at) {
      close(false);
      isOpen = true;
      root.replaceChildren();
      const head = document.createElement("div");
      head.className = "sp-head";
      head.textContent = at.count === 1 ? "Easing for this segment" : `Easing for ${at.count} segments`;
      const grid = document.createElement("div");
      grid.className = "sp-grid";
      for (const p of SEG_PRESETS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `sp-item${at.current === p.id ? " on" : ""}`;
        b.dataset.preset = p.id;
        b.title = p.hint;
        b.setAttribute("aria-label", `${p.label}: ${p.hint}`);
        b.setAttribute("aria-pressed", String(at.current === p.id));
        const name = document.createElement("span");
        name.textContent = p.label;
        b.append(thumb(p.spec, at.current === p.id ? "#f0b84a" : at.color), name);
        b.addEventListener("click", () => {
          h.pick(p.spec, p.id);
          close();
        });
        grid.append(b);
      }
      const foot = document.createElement("div");
      foot.className = "sp-foot";
      const mk = (text: string, title: string, fn: () => void, keepOpen: boolean) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sp-act";
        b.textContent = text;
        b.title = title;
        b.addEventListener("click", () => {
          fn();
          if (!keepOpen) close();
        });
        return b;
      };
      const state = document.createElement("span");
      state.className = "sp-state";
      state.textContent = at.current === "mixed" ? "Mixed easing" : at.current === null ? "Hand-tuned curve" : "";
      foot.append(
        mk("+ Channel", "Add every segment of this channel to the selection", () => h.addChannel(), true),
        mk("+ Selected keys", "Add the segments that start at the selected dopesheet keys", () => h.addKeys(), true),
        mk("Clear", "Deselect all segments", () => h.clear(), false),
        state
      );
      root.append(head, grid, foot);
      root.hidden = false;
      const w = root.offsetWidth;
      const hh = root.offsetHeight;
      root.style.left = `${Math.max(8, Math.min(at.x - w / 2, window.innerWidth - w - 8))}px`;
      root.style.top = `${at.y - hh - 14 > 8 ? at.y - hh - 14 : Math.min(at.y + 18, window.innerHeight - hh - 8)}px`;
      (root.querySelector<HTMLButtonElement>("button.sp-item.on") ?? root.querySelector<HTMLButtonElement>("button.sp-item"))?.focus();
    }
  };
}
