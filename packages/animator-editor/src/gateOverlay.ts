/*
 * Atlas Animator editor: original implementation.
 *
 * The outline gate overlay (MESH-WEIGHTS-PLAN section 4, G2). A garment piece's outline must stay one unbroken ink line wherever it shows
 * (outlineGate.ts, the port of swag_outline_gate.py). This module runs that gate on what the editor shows:
 *
 *   - current pose: red marks over the ink breaks, recomputed about 250 ms after the pose stops changing. The full figure with the worn item
 *     and each garment piece alone are rendered off-screen at scale 1.0 through contactSheet's `createSheetRenderer` (the pro rigs read from
 *     disk, the open clip posed on them), then `gateFrame` compares them;
 *   - whole clip: "Check clip" renders every frame, puts a red tick on the timeline for each bad frame (`addTimelineDecorator`), lists them
 *     (click to jump) and hands one warning per frame to gates.ts (`setExternalGateIssues`), so the clip check reports them too;
 *   - the overlay has a toggle (remembered per browser).
 *
 * The sheet renderer paints on an opaque background, so a pixel's alpha is rebuilt from "differs from that background". Only the two pro
 * rigs are rendered, so the gate runs when the open rig is one of them and a swag item skin is worn. Unkeyed gizmo edits are not part of
 * the pose (the keyed clip is).
 */
import { Skeleton } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { frameCount, frameTime } from "./clipModel.js";
import { createSheetRenderer, loadViews, type SheetRenderer, type ViewData } from "./contactSheet.js";
import { setExternalGateIssues, clearExternalGateIssues, type GateIssue } from "./gates.js";
import { addTimelineDecorator, type EditorHost } from "./host.js";
import { cellCamera } from "./phoneDock.js";
import { gateFrame, gatedSlots, type RgbaImage } from "./outlineGate.js";
import { itemSkins, type ViewId } from "./swagModel.js";

const DELAY_MS = 250;
const SCALE = 1.0;
/** The sheet renderer's opaque background (contactSheet.ts BACKGROUND), as RGB. */
const BG = [0x26, 0x2b, 0x36] as const;
const BG_TOLERANCE = 4;
const STORE_KEY = "atlasEditor.gateOverlay";
const SOURCE = (clip: string): string => `outline:${clip}`;

const VIEW_OF_OUTFIT: Readonly<Record<string, ViewId>> = { "pro-turned": "turned" };

export interface FrameResult {
  /** Break count over all pieces. */
  breaks: number;
  longest: number;
  /** Where the breaks lie, in rig space (x, y, size). */
  marks: { x: number; y: number; size: number }[];
  pieces: string[];
}

export interface GateOverlayApi {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Recomputes the current pose now (the 250 ms wait skipped). */
  recompute(): Promise<FrameResult | null>;
  checkClip(): Promise<number[]>;
  /** The last whole-clip result: bad frames, or null when none is valid for the open clip. */
  badFrames(): number[] | null;
  marks(): FrameResult["marks"];
  status(): string;
  /** What the Swag judge bar shows: does the gate apply, is an item worn, this pose, the last whole-clip check. */
  summary(): GateSummary;
  /** Called after the panel state changes (pose result, clip check, toggles). Returns the unsubscribe. */
  onChange(fn: () => void): () => void;
}

export interface GateSummary {
  /** The open rig is a pro rig, so the gate can run. */
  applies: boolean;
  /** A swag item skin is worn. */
  worn: boolean;
  checking: boolean;
  /** Outline breaks on the current pose; null when it has not been computed (yet). */
  poseBreaks: number | null;
  /** Frames checked by the last whole-clip check and the bad ones; null when no check is valid for the open clip and items. */
  clip: { frames: number; bad: number[] } | null;
  message: string;
}

declare global {
  interface Window {
    atlasGate?: GateOverlayApi;
  }
}

const frameTick = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));

/** Pixel rows of a canvas as an RGBA image whose alpha says "is not the background". */
export function maskedImage(canvas: HTMLCanvasElement): RgbaImage {
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const same = Math.abs(d[i]! - BG[0]) <= BG_TOLERANCE && Math.abs(d[i + 1]! - BG[1]) <= BG_TOLERANCE && Math.abs(d[i + 2]! - BG[2]) <= BG_TOLERANCE;
    d[i + 3] = same ? 0 : 255;
  }
  return { width: img.width, height: img.height, data: d };
}

export function installGateOverlay(host: EditorHost): void {
  let enabled = true;
  try {
    enabled = localStorage.getItem(STORE_KEY) !== "off";
  } catch {
    // no storage: the default
  }
  let views: Record<ViewId, ViewData> | null = null;
  let renderer: SheetRenderer | null = null;
  let loading: Promise<boolean> | null = null;
  let loadError = "";
  const extents = new Map<ViewId, { minX: number; maxX: number; minY: number; maxY: number }>();
  let current: FrameResult | null = null;
  let message = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let token = 0;
  let checked: { clip: string; ref: unknown; skins: string; frames: number; bad: number[]; counts: Map<number, number> } | null = null;
  const listeners = new Set<() => void>();
  let checking = false;

  // ---------------------------------------------------------------- rendering

  function ensureRenderer(): Promise<boolean> {
    if (renderer) return Promise.resolve(true);
    loading ??= (async () => {
      try {
        views = await loadViews("pro-turned");
        renderer = await createSheetRenderer(host.app, views);
        loadError = "";
        return true;
      } catch (e) {
        loadError = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /** The gate only applies where a worn item is judged: Animate, Swag and Pro (GL-10: its marks must not outlive a workspace change). */
  const gateWorkspace = (): boolean => ["ws-animate", "ws-swag", "ws-pro"].some((c) => document.body.classList.contains(c));
  const viewOf = (): ViewId | null => (gateWorkspace() ? (VIEW_OF_OUTFIT[host.rig?.outfit.id ?? ""] ?? null) : null);

  /** The worn swag item skins that exist in the shown rig, and the slots they cover. */
  function worn(view: ViewId): { skins: string[]; slots: string[] } {
    const doc = views?.[view].doc;
    const active = host.skeleton?.activeSkins ?? [];
    const names = new Set(itemSkins(host.doc?.skins ?? {}).map((s) => s.name));
    const skins = active.filter((n) => names.has(n) && doc?.skins[n]);
    const slots = gatedSlots([...new Set(skins.flatMap((n) => Object.keys(doc!.skins[n]!.attachments)))]);
    return { skins, slots };
  }

  /** Rig-space extent of the figure, the way the sheet renderer works it out. */
  function extentOf(view: ViewId): { minX: number; maxX: number; minY: number; maxY: number } {
    let ext = extents.get(view);
    if (!ext) {
      const sk = new Skeleton(views![view].doc);
      sk.setToSetupPose();
      sk.updateWorldTransform("reset");
      const pts = sk.bones.filter((b) => !/_target$|^offhand$|^root$|^weapon/.test(b.data.name)).map((b) => [b.world.x, b.world.y] as const);
      ext = {
        minX: Math.min(...pts.map((p) => p[0])) - 280,
        maxX: Math.max(...pts.map((p) => p[0])) + 280,
        minY: Math.min(...pts.map((p) => p[1])) - 480,
        maxY: Math.max(...pts.map((p) => p[1])) + 140
      };
      extents.set(view, ext);
    }
    return ext;
  }

  /** Renders the figure and each piece at `time` and runs the gate. Null when the gate does not apply. */
  async function analyse(time: number): Promise<FrameResult | null> {
    const view = viewOf();
    if (!view || !renderer || !views) return null;
    const { skins, slots } = worn(view);
    if (!skins.length || !slots.length) return null;
    const pose = renderer.clipPose(view, host.clipName, host.clip, time);
    const full = renderer.render(view, skins, pose, SCALE);
    const fullImage = maskedImage(full.canvas);
    const pieces = slots.map((slot) => {
      const only = (sk: Skeleton) => {
        pose(sk);
        for (const s of sk.slots) if (s.data.name !== slot) s.color.a = 0;
      };
      return { name: slot, image: maskedImage(renderer!.render(view, skins, only, SCALE).canvas) };
    });
    const gate = gateFrame(fullImage, pieces);
    const cam = cellCamera(SCALE, fullImage.width, fullImage.height, extentOf(view));
    const marks: FrameResult["marks"] = [];
    // Merge the per-piece break boxes into marks: scan the union mask for connected blobs through a coarse flood.
    const w = fullImage.width;
    const h = fullImage.height;
    const seen = new Uint8Array(w * h);
    for (let s = 0; s < gate.mask.length; s++) {
      if (!gate.mask[s] || seen[s]) continue;
      let x0 = w;
      let y0 = h;
      let x1 = 0;
      let y1 = 0;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        const y = (i - x) / w;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (gate.mask[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      marks.push({ x: ((x0 + x1 + 1) / 2 - cam.x) / cam.scale, y: ((y0 + y1 + 1) / 2 - cam.y) / cam.scale, size: Math.max(x1 - x0 + 1, y1 - y0 + 1) / cam.scale });
    }
    let breaks = 0;
    let longest = 0;
    for (const p of Object.values(gate.pieces)) {
      breaks += p.breaks;
      longest = Math.max(longest, p.longest);
    }
    return { breaks, longest, marks, pieces: slots };
  }

  // ---------------------------------------------------------------- red marks on the canvas

  const layer = new Graphics({ label: "outline-gate-marks" });
  layer.eventMode = "none";

  function drawMarks(): void {
    layer.clear();
    const ch = host.character;
    if (!enabled || !current || !ch) {
      layer.visible = false;
      host.app.render();
      return;
    }
    if (layer.parent !== host.world) host.world.addChild(layer);
    layer.position.set(ch.position.x, ch.position.y);
    layer.scale.set(ch.scale.x, ch.scale.y);
    layer.visible = true;
    const px = 1 / Math.max(host.zoom(), 1e-6);
    for (const m of current.marks) {
      const r = Math.max(m.size * 0.5 + 5 * px, 9 * px);
      layer.circle(m.x, m.y, r).fill({ color: 0xff2b2b, alpha: 0.18 }).stroke({ width: 2.5 * px, color: 0xff2b2b, alpha: 0.95 });
      layer.circle(m.x, m.y, 2 * px).fill({ color: 0xff2b2b });
    }
    host.app.render();
  }

  // ---------------------------------------------------------------- the panel

  const box = document.createElement("div");
  box.id = "gate-overlay";
  // GL-11: no floating card. The gate's controls are the "Outline gate" section of the Overlays popover (#ov-gate); the live gate HUD chips are the glanceable state.
  box.setAttribute("style", "display:flex;flex-direction:column;align-items:stretch;gap:4px;width:100%;");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.id = "gate-toggle";
  const toggleLabel = document.createElement("label");
  toggleLabel.style.cssText = "display:flex;gap:6px;align-items:center;cursor:pointer";
  toggleLabel.title = "Outline gate: red marks where a garment piece's ink outline is broken on this pose";
  toggleLabel.append(toggle, "Outline gate");
  const note = document.createElement("div");
  note.id = "gate-status";
  note.className = "note";
  const checkBtn = document.createElement("button");
  checkBtn.id = "gate-check";
  checkBtn.textContent = "Check clip";
  checkBtn.title = "Render every frame and mark the ones with a broken outline on the timeline";
  const list = document.createElement("div");
  list.id = "gate-frames";
  list.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;max-height:70px;overflow:hidden";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:space-between";
  head.append(toggleLabel, checkBtn);
  const legend = document.createElement("div");
  legend.className = "note";
  legend.style.cssText = "display:flex;gap:6px;align-items:center";
  const dot = document.createElement("i");
  dot.style.cssText = "display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid #ff2b2b;background:rgba(255,43,43,0.18);flex:none";
  legend.append(dot, "Red circle = broken ink outline");
  legend.title = "Where a garment piece's ink outline is broken on this pose";
  note.style.cssText = "min-height:2.6em";
  box.append(head, note, list, legend);

  function mountPanel(): void {
    const slot = document.getElementById("ov-gate");
    if (slot && box.parentElement !== slot) slot.append(box);
  }

  const valid = (): boolean => !!checked && checked.clip === host.clipName && checked.ref === host.clip && checked.skins === wornKey();
  const wornKey = (): string => (host.skeleton?.activeSkins ?? []).join("+");

  function refreshPanel(): void {
    mountPanel();
    toggle.checked = enabled;
    note.textContent = message;
    checkBtn.disabled = checking || !viewOf();
    list.replaceChildren();
    if (valid() && checked!.bad.length) {
      const shown = checked!.bad.slice(0, 18);
      for (const f of shown) {
        const b = document.createElement("button");
        b.dataset.frame = String(f);
        b.textContent = `f${f}`;
        b.title = `${checked!.counts.get(f)} break(s) at frame ${f}: click to jump`;
        b.style.cssText = "padding:1px 6px;border-color:#ff5a5a;color:#ff9a9a";
        b.onclick = () => host.setTime(frameTime(host.clip, f), true);
        list.append(b);
      }
      if (checked!.bad.length > shown.length) {
        const more = document.createElement("span");
        more.className = "note";
        more.textContent = `+${checked!.bad.length - shown.length} more (red ticks on the timeline)`;
        list.append(more);
      }
    }
    for (const fn of listeners) fn();
  }

  function wornNow(): boolean {
    const names = new Set(itemSkins(host.doc?.skins ?? {}).map((s) => s.name));
    return (host.skeleton?.activeSkins ?? []).some((n) => names.has(n));
  }

  // ---------------------------------------------------------------- current pose

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    token++;
    if (!valid()) clearExternalGateIssues(SOURCE(host.clipName));
    if (!enabled || host.playing || !viewOf()) {
      current = null;
      message = enabled && viewOf() ? "" : enabled ? "Only the pro rigs can be checked." : "";
      drawMarks();
      refreshPanel();
      return;
    }
    // Marks of the pose that was just left would sit in the wrong place: drop them now, show the new ones after the wait.
    current = null;
    drawMarks();
    timer = setTimeout(() => void recompute(), DELAY_MS);
    refreshPanel();
  }

  async function recompute(): Promise<FrameResult | null> {
    const mine = ++token;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!viewOf()) return null;
    if (!(await ensureRenderer())) {
      message = `Outline gate unavailable: ${loadError}`;
      refreshPanel();
      return null;
    }
    if (mine !== token) return null;
    const result = await analyse(host.time);
    if (mine !== token) return null;
    current = result;
    message = !result ? "Wear a swag item to check its outline." : result.breaks ? `${result.breaks} outline break${result.breaks === 1 ? "" : "s"} on this pose (longest ${result.longest}px)` : "Outline is unbroken on this pose.";
    drawMarks();
    refreshPanel();
    return result;
  }

  // ---------------------------------------------------------------- whole clip

  async function checkClip(): Promise<number[]> {
    if (checking || !viewOf()) return checked?.bad ?? [];
    checking = true;
    const clip = host.clip;
    const name = host.clipName;
    const skins = wornKey();
    const frames = frameCount(clip) + (clip.loop ? 0 : 1);
    const bad: number[] = [];
    const counts = new Map<number, number>();
    const issues: GateIssue[] = [];
    try {
      if (!(await ensureRenderer())) {
        message = `Outline gate unavailable: ${loadError}`;
        return [];
      }
      for (let f = 0; f < frames; f++) {
        message = `Checking frame ${f + 1} of ${frames}...`;
        refreshPanel();
        await frameTick();
        const time = Math.min(clip.duration, frameTime(clip, f));
        const r = await analyse(time);
        if (!r) {
          message = "Wear a swag item to check its outline.";
          return [];
        }
        if (r.breaks) {
          bad.push(f);
          counts.set(f, r.breaks);
          issues.push({ kind: "outline", severity: "warning", time, message: `Outline broken at frame ${f}: ${r.breaks} break${r.breaks === 1 ? "" : "s"} (longest ${r.longest}px)` });
        }
      }
      checked = { clip: name, ref: clip, skins, frames, bad, counts };
      setExternalGateIssues(SOURCE(name), issues);
      message = bad.length ? `${bad.length} of ${frames} frames have a broken outline.` : `All ${frames} frames keep an unbroken outline.`;
      return bad;
    } finally {
      checking = false;
      host.redrawTimeline();
      refreshPanel();
    }
  }

  // ---------------------------------------------------------------- wiring

  addTimelineDecorator((g, frameX, width, height, rulerH) => {
    if (!valid() || !checked!.bad.length) return;
    g.save();
    for (const f of checked!.bad) {
      const x = frameX(f);
      if (x < 150 || x > width) continue;
      g.fillStyle = "rgba(255,59,59,0.22)";
      g.fillRect(x - 0.5, rulerH, 1, Math.max(0, height - rulerH));
      g.fillStyle = "#ff3b3b";
      g.fillRect(x - 2, rulerH - 8, 4, 8);
    }
    g.restore();
  });

  toggle.onchange = () => {
    enabled = toggle.checked;
    try {
      localStorage.setItem(STORE_KEY, enabled ? "on" : "off");
    } catch {
      // not remembered
    }
    schedule();
  };
  checkBtn.onclick = () => void checkClip().then(() => host.checkWholeClip());

  for (const ev of ["pose", "time", "skins", "rig", "clip"] as const) host.on(ev, schedule);
  host.on("tool", refreshPanel);
  // GL-10: a workspace change drops the marks at once (the Swag circle must not stay on the Rig / Animate canvas); the new workspace recomputes if the gate applies.
  let lastWorkspace = [...document.body.classList].find((c) => c.startsWith("ws-")) ?? "";
  new MutationObserver(() => {
    const now = [...document.body.classList].find((c) => c.startsWith("ws-")) ?? "";
    if (now !== lastWorkspace) {
      lastWorkspace = now;
      current = null;
      message = "";
      drawMarks();
      schedule();
    }
    refreshPanel();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  mountPanel();
  refreshPanel();
  schedule();

  window.atlasGate = {
    enabled: () => enabled,
    setEnabled(on) {
      toggle.checked = on;
      toggle.onchange?.(new Event("change"));
    },
    recompute,
    checkClip,
    badFrames: () => (valid() ? [...checked!.bad] : null),
    marks: () => [...(current?.marks ?? [])],
    status: () => message,
    summary: () => ({
      applies: !!viewOf(),
      worn: wornNow(),
      checking,
      poseBreaks: current ? current.breaks : null,
      clip: valid() ? { frames: checked!.frames, bad: [...checked!.bad] } : null,
      message
    }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
