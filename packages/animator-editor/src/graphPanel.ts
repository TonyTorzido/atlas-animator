/*
 * Atlas Animator editor: original implementation.
 *
 * Graph panel (canvas): value-over-time curves per channel of the selected bones, draggable keys
 * and bezier handles. It owns only its view (window, channel filter) and drawing; the clip, key
 * selection, playhead and undo belong to main.ts and come in through GraphCtx, so the dopesheet and
 * the graph always show the same selection and clip. The maths is in graphModel.ts.
 */
import type { ClipData, CurveSpec } from "@atlas-animator/core/core";
import { clipFps, frameCount, frameTime, KEY_EPSILON, timeToFrame } from "./clipModel.js";
import { boneChannelRow, boneKeySelected, moveKeys, rowBone, selectKeys, type KeySel } from "./dopesheetModel.js";

/** The keyed property a graph channel lives in (: a graph pick, move or delete acts on that property only). */
const propertyOf = (c: GraphChannelId): "rotate" | "translate" | "scale" | "shear" => (c === "rotate" ? "rotate" : c.startsWith("translate") ? "translate" : c.startsWith("scale") ? "scale" : "shear");
import {
  channelById,
  channelKeys,
  dragHandle,
  linkHandles,
  setTangent,
  type TangentMode,
  frameBounds,
  GRAPH_CHANNELS,
  gridStep,
  sampleChannel,
  sampleSegment,
  segmentHandles,
  setChannelCurve,
  setChannelValue,
  toBezier,
  zoomBounds,
  type GraphBounds,
  type GraphChannelId,
  type GraphKey
} from "./graphModel.js";

export interface GraphCtx {
  canvas: HTMLCanvasElement;
  getClip(): ClipData;
  /** Bones whose curves are shown (the selected bone plus bones of selected keys). */
  bones(): string[];
  selectedBone(): string | null;
  keySel(): KeySel[];
  setKeySelection(sel: KeySel[]): void;
  /** Playhead, seconds. */
  time(): number;
  setTime(t: number): void;
  selectBone(name: string): void;
  /** Shows an edited clip without an undo step (a drag in progress). */
  preview(clip: ClipData, sel?: KeySel[]): void;
  /** Ends a drag or applies a one-shot edit: pushes `origin` on the undo stack when the clip changed. */
  commit(origin: ClipData, message: string): void;
  /** Called when the panel's own state (filter, readouts) changed and the toolbar should refresh. */
  changed(): void;
}

const M_LEFT = 58;
const M_TOP = 22;
const M_RIGHT = 12;
const M_BOTTOM = 8;

type Hit = { kind: "key" | "h1" | "h2"; bone: string; channel: GraphChannelId; time: number; next?: number; x: number; y: number };
type Drag =
  | { kind: "scrub" }
  | { kind: "pan"; x: number; y: number; view: GraphBounds }
  | { kind: "key"; origin: ClipData; sel: KeySel[]; bone: string; channel: GraphChannelId; time: number; startX: number; startY: number; startV: number; startFrame: number; lock: "t" | "v" | null; moved: boolean }
  | { kind: "handle"; origin: ClipData; hit: Hit; moved: boolean }
  | null;

export interface GraphPanel {
  draw(): void;
  open: boolean;
  setOpen(on: boolean): void;
  channels(): GraphChannelId[];
  setChannels(ids: readonly GraphChannelId[]): void;
  toggleChannel(id: GraphChannelId): void;
  frameAll(): void;
  frameSelected(): void;
  zoom(factor: number, axis?: "t" | "v" | "both"): void;
  view(): GraphBounds;
  focus(): { bone: string; channel: GraphChannelId; time: number } | null;
  setFocus(bone: string, channel: GraphChannelId, time: number): void;
  setInterp(kind: "linear" | "stepped" | "bezier"): number;
  /** Smooth / flat / auto tangent at the selected keys' curves (both handles of the key). Returns how many keys changed. */
  setTangentMode(mode: TangentMode): number;
  /** Linked handles: dragging one handle of a key keeps the handle on its other side collinear. Broken handles move alone. */
  linked(): boolean;
  setLinked(on: boolean): void;
  setFocusValue(value: number): boolean;
  /** Client-space position of a key or handle, for scripted drags. */
  pointOf(bone: string, channel: GraphChannelId, frame: number, what?: "key" | "h1" | "h2"): { x: number; y: number } | null;
  curves(): { bone: string; channel: GraphChannelId; keys: GraphKey[] }[];
}

export function createGraphPanel(ctx: GraphCtx): GraphPanel {
  const canvas = ctx.canvas;
  let isOpen = false;
  let visible = new Set<GraphChannelId>(GRAPH_CHANNELS.map((c) => c.id));
  let bounds: GraphBounds = { t0: 0, t1: 1, v0: -1, v1: 1 };
  let framed = false;
  let hits: Hit[] = [];
  let drag: Drag = null;
  let focus: { bone: string; channel: GraphChannelId; time: number } | null = null;
  let linkedHandles = true;

  const plotW = () => Math.max(1, canvas.clientWidth - M_LEFT - M_RIGHT);
  const plotH = () => Math.max(1, canvas.clientHeight - M_TOP - M_BOTTOM);
  const tx = (t: number) => M_LEFT + ((t - bounds.t0) / (bounds.t1 - bounds.t0)) * plotW();
  const vy = (v: number) => M_TOP + (1 - (v - bounds.v0) / (bounds.v1 - bounds.v0)) * plotH();
  const xt = (x: number) => bounds.t0 + ((x - M_LEFT) / plotW()) * (bounds.t1 - bounds.t0);
  const yv = (y: number) => bounds.v0 + (1 - (y - M_TOP) / plotH()) * (bounds.v1 - bounds.v0);

  const shown = () => {
    const clip = ctx.getClip();
    const out: { bone: string; channel: GraphChannelId; keys: GraphKey[] }[] = [];
    for (const bone of ctx.bones())
      for (const c of GRAPH_CHANNELS) if (visible.has(c.id)) {
        const keys = channelKeys(clip, bone, c.id);
        if (keys.length) out.push({ bone, channel: c.id, keys });
      }
    return out;
  };

  function frameItems(items: { bone: string; channel: GraphChannelId }[]): void {
    const clip = ctx.getClip();
    bounds = frameBounds(clip, items);
    // A little air on both sides in time.
    const pad = (bounds.t1 - bounds.t0) * 0.04;
    bounds = { ...bounds, t0: bounds.t0 - pad, t1: bounds.t1 + pad };
    framed = true;
  }

  const api: GraphPanel = {
    get open() {
      return isOpen;
    },
    set open(v: boolean) {
      isOpen = v;
    },
    draw,
    setOpen(on) {
      isOpen = on;
      if (on) {
        // Opening follows the selection: switch on the channels the selected bones actually have keys on, then frame them.
        if (!shown().length) {
          const clip = ctx.getClip();
          for (const bone of ctx.bones()) for (const c of GRAPH_CHANNELS) if (channelKeys(clip, bone, c.id).length) visible.add(c.id);
        }
        if (ctx.keySel().length) api.frameSelected();
        else frameItems(shown());
        requestAnimationFrame(draw);
      }
    },
    channels: () => GRAPH_CHANNELS.filter((c) => visible.has(c.id)).map((c) => c.id),
    setChannels(ids) {
      visible = new Set(ids);
      ctx.changed();
      draw();
    },
    toggleChannel(id) {
      if (visible.has(id)) visible.delete(id);
      else visible.add(id);
      ctx.changed();
      draw();
    },
    frameAll() {
      frameItems(shown());
      draw();
    },
    frameSelected() {
      const sel = ctx.keySel();
      const clip = ctx.getClip();
      const items = shown().filter((s) => sel.some((k) => rowBone(k.row) === s.bone));
      if (!items.length) return api.frameAll();
      // Frame the value range of the selected keys only, plus the span between their first and last time.
      let lo = Infinity;
      let hi = -Infinity;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const it of items)
        for (const k of it.keys) {
          if (!boneKeySelected(sel, it.bone, propertyOf(it.channel), k.time)) continue;
          lo = Math.min(lo, k.value);
          hi = Math.max(hi, k.value);
          t0 = Math.min(t0, k.time);
          t1 = Math.max(t1, k.time);
        }
      if (!Number.isFinite(lo)) return api.frameAll();
      const vp = Math.max((hi - lo) * 0.2, 1);
      const tp = Math.max((t1 - t0) * 0.2, 2 / clipFps(clip));
      bounds = { t0: t0 - tp, t1: t1 + tp, v0: lo - vp, v1: hi + vp };
      draw();
    },
    zoom(factor, axis = "both") {
      bounds = zoomBounds(bounds, { t: axis === "v" ? 1 : factor, v: axis === "t" ? 1 : factor });
      draw();
    },
    view: () => ({ ...bounds }),
    focus: () => focus,
    setFocus(bone, channel, time) {
      focus = { bone, channel, time };
      ctx.changed();
    },
    setTangentMode(mode) {
      const clip = ctx.getClip();
      const sel = ctx.keySel();
      let next = clip;
      let n = 0;
      for (const s of shown()) {
        for (const k of s.keys) {
          if (!boneKeySelected(sel, s.bone, propertyOf(s.channel), k.time)) continue;
          const after = setTangent(next, s.bone, s.channel, k.time, mode);
          if (after !== next) n++;
          next = after;
        }
      }
      if (n) {
        ctx.preview(next);
        ctx.commit(clip, `${mode} tangent on ${n} curve key${n === 1 ? "" : "s"}`);
      }
      return n;
    },
    linked: () => linkedHandles,
    setLinked(on) {
      linkedHandles = on;
      ctx.changed();
    },
    setInterp(kind) {
      const clip = ctx.getClip();
      const sel = ctx.keySel();
      let next = clip;
      let n = 0;
      for (const s of shown()) {
        for (const k of s.keys) {
          if (!boneKeySelected(sel, s.bone, propertyOf(s.channel), k.time)) continue;
          const spec: CurveSpec | null = kind === "bezier" ? toBezier(k.curve) ?? toBezier("linear") : kind;
          if (!spec) continue;
          next = setChannelCurve(next, s.bone, s.channel, k.time, spec);
          n++;
        }
      }
      if (n) {
        ctx.preview(next);
        ctx.commit(clip, `${kind} on ${n} curve key${n === 1 ? "" : "s"}`);
      }
      return n;
    },
    setFocusValue(value) {
      if (!focus) return false;
      const clip = ctx.getClip();
      const next = setChannelValue(clip, focus.bone, focus.channel, focus.time, value);
      if (next === clip) return false;
      ctx.preview(next);
      ctx.commit(clip, `${focus.bone} ${channelById(focus.channel).label} = ${value}`);
      return true;
    },
    pointOf(bone, channel, frame, what = "key") {
      draw();
      const time = frameTime(ctx.getClip(), frame);
      const hit = hits.find((h) => h.bone === bone && h.channel === channel && h.kind === what && Math.abs(h.time - time) < KEY_EPSILON);
      if (!hit) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + hit.x, y: rect.top + hit.y };
    },
    curves: () => shown()
  };

  // ---------------------------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------------------------

  function draw(): void {
    if (!isOpen) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "11px Segoe UI, system-ui, sans-serif";
    const clip = ctx.getClip();
    const fps = clipFps(clip);
    hits = [];

    // Grid: value lines (nice steps) and frame lines.
    g.fillStyle = "#1b1f27";
    g.fillRect(0, 0, w, h);
    const vs = gridStep(bounds.v1 - bounds.v0, plotH() / 34);
    g.textAlign = "right";
    for (let v = Math.ceil(bounds.v0 / vs) * vs; v <= bounds.v1; v += vs) {
      const y = Math.round(vy(v)) + 0.5;
      g.strokeStyle = Math.abs(v) < vs * 1e-6 ? "#4a5468" : "#262c38";
      g.beginPath();
      g.moveTo(M_LEFT, y);
      g.lineTo(w - M_RIGHT, y);
      g.stroke();
      g.fillStyle = "#8c96a8";
      g.fillText(String(Math.round(v * 1e4) / 1e4), M_LEFT - 6, y + 4);
    }
    g.textAlign = "left";
    const framesShown = (bounds.t1 - bounds.t0) * fps;
    const fs = Math.max(1, gridStep(framesShown, plotW() / 54));
    g.fillStyle = "#222733";
    g.fillRect(M_LEFT, 0, plotW(), M_TOP);
    for (let f = Math.ceil((bounds.t0 * fps) / fs) * fs; f <= bounds.t1 * fps; f += fs) {
      const x = Math.round(tx(f / fps)) + 0.5;
      g.strokeStyle = "#262c38";
      g.beginPath();
      g.moveTo(x, M_TOP);
      g.lineTo(x, h - M_BOTTOM);
      g.stroke();
      g.strokeStyle = "#4a5468";
      g.beginPath();
      g.moveTo(x, M_TOP - 7);
      g.lineTo(x, M_TOP);
      g.stroke();
      g.fillStyle = "#8c96a8";
      g.fillText(String(Math.round(f)), x + 3, 13);
    }
    // Clip span.
    g.fillStyle = "rgba(0,0,0,0.28)";
    const x0 = tx(0);
    const x1 = tx(frameCount(clip) / fps);
    if (x0 > M_LEFT) g.fillRect(M_LEFT, M_TOP, x0 - M_LEFT, plotH());
    if (x1 < w - M_RIGHT) g.fillRect(x1, M_TOP, w - M_RIGHT - x1, plotH());

    g.save();
    g.beginPath();
    g.rect(M_LEFT, M_TOP, plotW(), plotH());
    g.clip();
    const selBone = ctx.selectedBone();
    const sel = ctx.keySel();
    const now = ctx.time();
    const curves = shown();
    for (const { bone, channel, keys } of curves) {
      const color = channelById(channel).color;
      g.globalAlpha = bone === selBone ? 1 : 0.5;
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(M_LEFT, vy(keys[0]!.value));
      g.lineTo(tx(keys[0]!.time), vy(keys[0]!.value));
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i]!;
        const b = keys[i + 1]!;
        if (a.curve === "stepped") {
          g.lineTo(tx(b.time), vy(a.value));
          g.lineTo(tx(b.time), vy(b.value));
        } else if (a.curve === "linear") g.lineTo(tx(b.time), vy(b.value));
        else {
          const steps = Math.max(8, Math.min(64, Math.ceil((tx(b.time) - tx(a.time)) / 4)));
          for (let s = 1; s <= steps; s++) {
            const t = a.time + ((b.time - a.time) * s) / steps;
            g.lineTo(tx(t), vy(sampleSegment(a, b, t)));
          }
        }
      }
      g.lineTo(w - M_RIGHT, vy(keys[keys.length - 1]!.value));
      g.stroke();
      // Playhead dot.
      const v = sampleChannel(keys, now);
      if (v !== undefined) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(tx(now), vy(v), 3, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      // Label at the last key.
      const last = keys[keys.length - 1]!;
      g.fillStyle = color;
      g.globalAlpha = bone === selBone ? 0.9 : 0.5;
      g.fillText(`${bone} ${channelById(channel).label}`, Math.min(tx(last.time) + 8, w - M_RIGHT - 90), vy(last.value) - 8);
      g.globalAlpha = 1;
    }
    // Handles first (under keys), then keys.
    for (const { bone, channel, keys } of curves) {
      const color = channelById(channel).color;
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i]!;
        const b = keys[i + 1]!;
        const hs = segmentHandles(a, b);
        if (!hs) continue;
        const sa = boneKeySelected(sel, bone, propertyOf(channel), a.time);
        const sb = boneKeySelected(sel, bone, propertyOf(channel), b.time);
        const pairs: [Hit["kind"], typeof hs.h1, GraphKey, boolean][] = [
          ["h1", hs.h1, a, sa],
          ["h2", hs.h2, b, sb]
        ];
        for (const [kind, p, anchor, on] of pairs) {
          if (!on) continue;
          const hx = tx(p.t);
          const hy = vy(p.v);
          g.strokeStyle = color;
          g.globalAlpha = 0.6;
          g.beginPath();
          g.moveTo(tx(anchor.time), vy(anchor.value));
          g.lineTo(hx, hy);
          g.stroke();
          g.globalAlpha = 1;
          g.fillStyle = "#1b1f27";
          g.strokeStyle = color;
          g.lineWidth = 1.6;
          g.beginPath();
          g.arc(hx, hy, 4, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          hits.push({ kind, bone, channel, time: a.time, next: b.time, x: hx, y: hy });
        }
      }
    }
    g.lineWidth = 1;
    for (const { bone, channel, keys } of curves) {
      const color = channelById(channel).color;
      for (const k of keys) {
        const x = tx(k.time);
        const y = vy(k.value);
        const chosen = boneKeySelected(sel, bone, propertyOf(channel), k.time);
        const isFocus = focus && focus.bone === bone && focus.channel === channel && Math.abs(focus.time - k.time) < KEY_EPSILON;
        const r = 5;
        g.fillStyle = Math.abs(k.time - now) < KEY_EPSILON ? "#f0b84a" : color;
        g.beginPath();
        if (k.curve === "stepped") g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
        else if (k.curve !== "linear") g.arc(x, y, r * 0.95, 0, Math.PI * 2);
        else {
          g.moveTo(x, y - r);
          g.lineTo(x + r, y);
          g.lineTo(x, y + r);
          g.lineTo(x - r, y);
          g.closePath();
        }
        g.fill();
        if (chosen) {
          g.strokeStyle = isFocus ? "#f0b84a" : "#ffffff";
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(x, y, r + 3, 0, Math.PI * 2);
          g.stroke();
          g.lineWidth = 1;
        }
        hits.push({ kind: "key", bone, channel, time: k.time, x, y });
      }
    }
    g.restore();

    if (!curves.length) {
      g.fillStyle = "#8c96a8";
      g.textAlign = "center";
      g.fillText("Select a bone with keys (or turn on a channel) to see its curves", M_LEFT + plotW() / 2, M_TOP + plotH() / 2);
      g.textAlign = "left";
    }
    // Playhead.
    const px = tx(now);
    if (px >= M_LEFT && px <= w - M_RIGHT) {
      g.strokeStyle = "#f0b84a";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, h - M_BOTTOM);
      g.stroke();
      g.lineWidth = 1;
      g.fillStyle = "#f0b84a";
      g.beginPath();
      g.moveTo(px - 6, 0);
      g.lineTo(px + 6, 0);
      g.lineTo(px, 8);
      g.closePath();
      g.fill();
    }
    g.fillStyle = "#2d3443";
    g.fillRect(M_LEFT, M_TOP, 1, plotH());
  }

  // ---------------------------------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------------------------------

  const at = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitAt = (p: { x: number; y: number }): Hit | null => {
    let best: Hit | null = null;
    let bestD = 8;
    // Handles win over keys they overlap (a flat bezier has the handle on the key line).
    for (const h of [...hits].reverse().sort((a, b) => (a.kind === "key" ? 1 : 0) - (b.kind === "key" ? 1 : 0))) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  };
  const clampFrame = (x: number) => Math.max(0, Math.min(frameCount(ctx.getClip()), Math.round(xt(x) * clipFps(ctx.getClip()))));

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    const p = at(e);
    canvas.setPointerCapture(e.pointerId);
    const clip = ctx.getClip();
    if (e.button === 1 || e.button === 2) {
      drag = { kind: "pan", x: p.x, y: p.y, view: { ...bounds } };
      return;
    }
    if (p.y < M_TOP) {
      drag = { kind: "scrub" };
      ctx.setTime(frameTime(clip, clampFrame(p.x)));
      return;
    }
    const hit = hitAt(p);
    if (!hit) {
      if (!e.shiftKey) ctx.setKeySelection([]);
      focus = null;
      ctx.changed();
      draw();
      return;
    }
    if (hit.kind !== "key") {
      drag = { kind: "handle", origin: clip, hit, moved: false };
      return;
    }
    const row = boneChannelRow(hit.bone, propertyOf(hit.channel));
    const already = boneKeySelected(ctx.keySel(), hit.bone, propertyOf(hit.channel), hit.time);
    if (e.shiftKey) ctx.setKeySelection(selectKeys(ctx.keySel(), [{ row, time: hit.time }], already ? "toggle" : "add"));
    else if (!already) ctx.setKeySelection(selectKeys(ctx.keySel(), [{ row, time: hit.time }], "replace"));
    focus = { bone: hit.bone, channel: hit.channel, time: hit.time };
    ctx.selectBone(hit.bone);
    ctx.setTime(hit.time);
    ctx.changed();
    const k = channelKeys(clip, hit.bone, hit.channel).find((q) => Math.abs(q.time - hit.time) < KEY_EPSILON)!;
    drag = {
      kind: "key",
      origin: clip,
      sel: [...ctx.keySel()],
      bone: hit.bone,
      channel: hit.channel,
      time: hit.time,
      startX: p.x,
      startY: p.y,
      startV: k.value,
      startFrame: timeToFrame(clip, hit.time),
      lock: null,
      moved: false
    };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = at(e);
    const clip0 = ctx.getClip();
    if (drag.kind === "scrub") {
      const f = clampFrame(p.x);
      if (f !== timeToFrame(clip0, ctx.time())) ctx.setTime(frameTime(clip0, f));
    } else if (drag.kind === "pan") {
      const dt = ((p.x - drag.x) / plotW()) * (drag.view.t1 - drag.view.t0);
      const dv = ((p.y - drag.y) / plotH()) * (drag.view.v1 - drag.view.v0);
      bounds = { t0: drag.view.t0 - dt, t1: drag.view.t1 - dt, v0: drag.view.v0 + dv, v1: drag.view.v1 + dv };
      draw();
    } else if (drag.kind === "key") {
      if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) < 3) return;
      drag.moved = true;
      let lock = drag.lock;
      if (e.shiftKey && !lock) lock = Math.abs(p.x - drag.startX) >= Math.abs(p.y - drag.startY) ? "t" : "v";
      if (!e.shiftKey) lock = null;
      drag.lock = lock;
      const fps = clipFps(drag.origin);
      const df = lock === "v" ? 0 : Math.round(xt(p.x) * fps) - drag.startFrame;
      const dv = lock === "t" ? 0 : yv(p.y) - yv(drag.startY);
      // Value first (at the keys' old times), then the time move.
      let next = drag.origin;
      if (dv !== 0)
        for (const s of drag.sel) {
          const bone = rowBone(s.row);
          if (!bone) continue;
          const k = channelKeys(drag.origin, bone, drag.channel).find((q) => Math.abs(q.time - s.time) < KEY_EPSILON);
          if (k) next = setChannelValue(next, bone, drag.channel, s.time, k.value + dv);
        }
      const moved = moveKeys(next, drag.sel, df);
      ctx.preview(moved.clip, moved.sel);
      if (focus && focus.bone === drag.bone && focus.channel === drag.channel) focus = { ...focus, time: frameTime(drag.origin, drag.startFrame + (moved.clip === drag.origin ? 0 : df)) };
    } else if (drag.kind === "handle") {
      const clip = drag.origin;
      const { hit } = drag;
      const keys = channelKeys(clip, hit.bone, hit.channel);
      const a = keys.find((q) => Math.abs(q.time - hit.time) < KEY_EPSILON);
      const b = keys.find((q) => Math.abs(q.time - (hit.next ?? 0)) < KEY_EPSILON);
      if (!a || !b) return;
      const spec = dragHandle(a, b, hit.kind === "h1" ? 1 : 2, { t: xt(p.x), v: yv(p.y) });
      if (!spec) return;
      drag.moved = true;
      let shownClip = setChannelCurve(clip, hit.bone, hit.channel, hit.time, spec);
      if (linkedHandles) shownClip = hit.kind === "h1" ? linkHandles(shownClip, hit.bone, hit.channel, hit.time, "out") : linkHandles(shownClip, hit.bone, hit.channel, hit.next ?? hit.time, "in");
      ctx.preview(shownClip);
    }
  });

  const finish = () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "key" && d.moved) {
      if (ctx.getClip() !== d.origin) ctx.commit(d.origin, `Moved ${d.sel.length} key${d.sel.length === 1 ? "" : "s"} in the graph`);
    } else if (d.kind === "handle" && d.moved) {
      if (ctx.getClip() !== d.origin) ctx.commit(d.origin, `Bezier handle on ${d.hit.bone} ${channelById(d.hit.channel).label}`);
    }
    ctx.changed();
    draw();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = at(e);
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const about = { t: (p.x - M_LEFT) / plotW(), v: 1 - (p.y - M_TOP) / plotH() };
      bounds = zoomBounds(bounds, e.shiftKey ? { v: f } : e.altKey ? { t: f, v: f } : { t: f }, about);
      draw();
    },
    { passive: false }
  );
  canvas.addEventListener("dblclick", () => api.frameAll());
  new ResizeObserver(() => draw()).observe(canvas);
  return api;
}
