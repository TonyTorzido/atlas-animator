/*
 * Atlas Animator editor: original implementation.
 *
 * Game-size preview: the posed character drawn at the scales the project uses on a phone, 0.4 and 0.471 CSS px per
 * rig px, one canvas pixel per CSS pixel (no smoothing, no zoom), always at the clip's held frame rate. Beside
 * them an optional reference: a video (kept in step with the playhead) or a horizontal sprite strip (one frame per
 * clip frame, looped), so a drawn version can be compared with the rig while editing.
 */
import { alertDialog } from "./dialog.js";
import { Container, Graphics, RenderTexture, type Application } from "pixi.js";

export const PREVIEW_SCALES = [0.4, 0.471] as const;
const W = 330;
const H = 560;
/** Rig px below the skeleton origin the feet reach (stock rig: IK targets sit 210 below, plus the foot). */
const FEET_BELOW = 262;
const GROUND_MARGIN = 30;

export interface PreviewHost {
  app: Application;
  world: Container;
  overlay: Graphics;
  viewEl: HTMLElement;
  background(): number;
  /** Held display time of the clip and its frame rate / frame count. */
  time(): number;
  fps(): number;
  frames(): number;
  playing(): boolean;
}

type Reference = { kind: "video"; el: HTMLVideoElement; url: string } | { kind: "strip"; img: HTMLImageElement; frames: number; url: string };

export interface GamePreview {
  toggle(open?: boolean): void;
  isOpen(): boolean;
  /** Draws both scales from the current pose of the stage (call after the character was updated). */
  render(): void;
  /** The editor's time moved or playback started / stopped: keep the reference in step. */
  sync(playing: boolean): void;
  loadReference(file: File): Promise<void>;
  clearReference(): void;
  info(): { open: boolean; scales: readonly number[]; size: [number, number]; reference: string | null; stripFrames: number | null; refFrame: number | null; videoTime: number | null };
}

export function createGamePreview(host: PreviewHost): GamePreview {
  const panel = document.createElement("div");
  panel.id = "gamepreview";
  panel.className = "hud br";
  panel.style.display = "none";
  const head = document.createElement("div");
  head.className = "pvhead";
  const title = document.createElement("span");
  title.className = "label";
  title.textContent = "Game size, held frames, 1 canvas px = 1 CSS px";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "video/*,image/*";
  fileInput.id = "refinput";
  fileInput.title = "Reference: a video, or a horizontal sprite strip image (one frame per clip frame)";
  const framesInput = document.createElement("input");
  framesInput.type = "number";
  framesInput.min = "1";
  framesInput.step = "1";
  framesInput.value = "30";
  framesInput.id = "refframes";
  framesInput.title = "Frames in the sprite strip";
  framesInput.style.display = "none";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Remove reference";
  clearBtn.style.display = "none";
  head.append(title, fileInput, framesInput, clearBtn);
  const row = document.createElement("div");
  row.className = "pvrow";
  panel.append(head, row);

  const canvases: HTMLCanvasElement[] = [];
  for (const s of PREVIEW_SCALES) {
    const cell = document.createElement("div");
    cell.className = "pvcell";
    const cap = document.createElement("div");
    cap.className = "label";
    cap.textContent = `${s}`;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.id = `preview-${s}`;
    cell.append(cap, c);
    row.append(cell);
    canvases.push(c);
  }
  const refCell = document.createElement("div");
  refCell.className = "pvcell";
  refCell.style.display = "none";
  const refCap = document.createElement("div");
  refCap.className = "label";
  refCap.textContent = "Reference";
  const refCanvas = document.createElement("canvas");
  refCanvas.width = W;
  refCanvas.height = H;
  refCanvas.id = "refcanvas";
  refCell.append(refCap, refCanvas);
  row.append(refCell);
  host.viewEl.append(panel);

  let open = false;
  let rt: RenderTexture | null = null;
  let reference: Reference | null = null;
  let lastRefFrame: number | null = null;
  let lastDrawn = -1;

  const drawReference = (): void => {
    const g = refCanvas.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#14171d";
    g.fillRect(0, 0, W, H);
    if (!reference) return;
    g.imageSmoothingEnabled = false;
    const src = reference.kind === "video" ? reference.el : reference.img;
    let sx = 0;
    let sy = 0;
    let sw = reference.kind === "video" ? reference.el.videoWidth : reference.img.naturalWidth;
    let sh = reference.kind === "video" ? reference.el.videoHeight : reference.img.naturalHeight;
    if (reference.kind === "strip") {
      const n = Math.max(1, reference.frames);
      const frame = ((Math.floor(host.time() * host.fps() + 1e-3) % n) + n) % n;
      lastRefFrame = frame;
      sw = reference.img.naturalWidth / n;
      sx = frame * sw;
    }
    if (!sw || !sh) return;
    const k = Math.min(W / sw, H / sh);
    g.drawImage(src, sx, sy, sw, sh, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  };

  const render = (): void => {
    if (!open) return;
    // While playing the pose only changes with the held frame: draw each frame once (the reference still redraws).
    const frameKey = Math.floor(host.time() * host.fps() + 1e-3);
    if (host.playing() && frameKey === lastDrawn) {
      drawReference();
      return;
    }
    lastDrawn = frameKey;
    const { app, world, overlay } = host;
    const saved = { x: world.position.x, y: world.position.y, sx: world.scale.x, sy: world.scale.y, overlay: overlay.visible };
    overlay.visible = false;
    if (!rt) rt = RenderTexture.create({ width: W, height: H, resolution: 1 });
    try {
      PREVIEW_SCALES.forEach((s, i) => {
        world.scale.set(s);
        world.position.set(W / 2, H - GROUND_MARGIN - FEET_BELOW * s);
        app.renderer.render({ container: app.stage, target: rt!, clear: true, clearColor: host.background() });
        const out = app.renderer.extract.canvas(rt!) as unknown as CanvasImageSource;
        const g = canvases[i]!.getContext("2d")!;
        g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, W, H);
        g.drawImage(out, 0, 0);
      });
    } finally {
      world.position.set(saved.x, saved.y);
      world.scale.set(saved.sx, saved.sy);
      overlay.visible = saved.overlay;
    }
    drawReference();
  };

  const clearReference = (): void => {
    if (reference) {
      if (reference.kind === "video") reference.el.pause();
      URL.revokeObjectURL(reference.url);
    }
    reference = null;
    lastRefFrame = null;
    refCell.style.display = "none";
    framesInput.style.display = "none";
    clearBtn.style.display = "none";
    fileInput.value = "";
    drawReference();
  };

  const loadReference = async (file: File): Promise<void> => {
    clearReference();
    const url = URL.createObjectURL(file);
    if (file.type.startsWith("video/")) {
      const el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = "auto";
      el.src = url;
      await new Promise<void>((resolve, reject) => {
        el.onloadeddata = () => resolve();
        el.onerror = () => reject(new Error("the reference video could not be decoded"));
      });
      el.onseeked = () => drawReference();
      reference = { kind: "video", el, url };
    } else {
      const img = new Image();
      img.src = url;
      await img.decode();
      const frames = Math.max(1, Math.round(Number(framesInput.value)) || host.frames() || 1);
      framesInput.value = String(frames);
      reference = { kind: "strip", img, frames, url };
      framesInput.style.display = "";
    }
    refCell.style.display = "";
    clearBtn.style.display = "";
    sync(false);
    drawReference();
  };

  const sync = (playing: boolean): void => {
    if (!reference) return;
    if (reference.kind === "video") {
      const v = reference.el;
      const d = v.duration || 1;
      if (playing) {
        if (v.paused) {
          v.currentTime = host.time() % d;
          void v.play().catch(() => undefined);
        }
      } else {
        if (!v.paused) v.pause();
        v.currentTime = host.time() % d;
      }
    }
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void loadReference(f).catch((e: unknown) => void alertDialog(String(e instanceof Error ? e.message : e), "Could not load the reference"));
  });
  framesInput.addEventListener("change", () => {
    if (reference?.kind === "strip") {
      reference.frames = Math.max(1, Math.round(Number(framesInput.value)) || 1);
      drawReference();
    }
  });
  clearBtn.addEventListener("click", clearReference);

  return {
    toggle(next) {
      open = next ?? !open;
      panel.style.display = open ? "" : "none";
      lastDrawn = -1;
      if (open) render();
    },
    isOpen: () => open,
    render,
    sync,
    loadReference,
    clearReference,
    info: () => ({
      open,
      scales: PREVIEW_SCALES,
      size: [W, H],
      reference: reference ? reference.kind : null,
      stripFrames: reference?.kind === "strip" ? reference.frames : null,
      refFrame: lastRefFrame,
      videoTime: reference?.kind === "video" ? reference.el.currentTime : null
    })
  };
}
