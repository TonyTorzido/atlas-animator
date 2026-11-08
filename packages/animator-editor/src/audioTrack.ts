/*
 * Atlas Animator editor: the audio reference track under the dopesheet (). Load a wav / mp3, see its waveform lined up with
 * the frames, hear it while the clip plays (at the playback speed) and in a short burst while scrubbing. It is a reference for hand
 * timing only: the sound is never exported. Settings are per clip (clip-meta.json), the file lives in the data folder's audio folder
 * (routes in vite.config.ts). Maths and file naming: audioTrackModel.ts.
 */
import "./audioTrack.css";
import { apiError, confirmDialog, showToast } from "./persistUi.js";
import { audioFileName, audioPosition, cleanMeta, clampOffset, clampVolume, computePeaks, DRIFT_LIMIT, peakRange, SCRUB_BURST, type AudioMeta, type ClipMeta } from "./audioTrackModel.js";

export interface AudioTrackHost {
  clipName(): string;
  fps(): number;
  frames(): number;
  time(): number;
  playing(): boolean;
  speed(): number;
  /** Canvas x of a frame on a dopesheet `width` px wide. */
  frameX(frame: number, width: number): number;
  /** Width of the dopesheet label column (px). */
  labelWidth(): number;
  status(message: string, kind?: "ok" | "bad" | ""): void;
}

export interface AudioTrackState {
  open: boolean;
  loaded: boolean;
  clip: string;
  name: string;
  offset: number;
  volume: number;
  muted: boolean;
  peaks: number;
  /** A sound source is running for playback (not a scrub burst). */
  sounding: boolean;
  rate: number;
  starts: number;
  bursts: number;
  gain: number;
  inkColumns: number;
}

export interface AudioTrack {
  draw(): void;
  tick(): void;
  playChanged(on: boolean): void;
  scrub(): void;
  state(): AudioTrackState;
}

const MAX_BYTES = 40 * 1024 * 1024;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createAudioTrack(host: AudioTrackHost): AudioTrack {
  const root = byId<HTMLElement>("audiotrack");
  const canvas = byId<HTMLCanvasElement>("audiowave");
  const toggle = byId<HTMLButtonElement>("audiobtn");
  const fileInput = byId<HTMLInputElement>("audiofile");
  const loadBtn = byId<HTMLButtonElement>("audioload");
  const nameLabel = byId<HTMLElement>("audioname");
  const offsetInput = byId<HTMLInputElement>("audiooffset");
  const volumeInput = byId<HTMLInputElement>("audiovolume");
  const muteBtn = byId<HTMLButtonElement>("audiomute");
  const removeBtn = byId<HTMLButtonElement>("audioremove");
  const controls = [...root.querySelectorAll<HTMLElement>("[data-needs-audio]")];

  let meta: ClipMeta = {};
  let open = false;
  let loadedFor = "";
  let loadedFile = "";
  let buffer: AudioBuffer | null = null;
  let peaks: { min: Float32Array; max: Float32Array } | null = null;
  let token = 0;
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let cur: { src: AudioBufferSourceNode | null; ctxStart: number; clipTime: number; rate: number; burst: boolean } | null = null;
  let starts = 0;
  let bursts = 0;
  let lastInk = 0;
  let lastRestart = 0;

  const current = (): AudioMeta | undefined => meta[host.clipName()]?.audio;

  async function saveMeta(): Promise<boolean> {
    const res = await fetch("/api/clip-meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) }).catch(() => null);
    if (!res?.ok) {
      const message = res ? await apiError(res) : "the editor server is not answering";
      host.status(`Audio settings not saved: ${message}`, "bad");
      showToast(`Audio settings not saved: ${message}`, "bad");
      return false;
    }
    return true;
  }

  const metaReady: Promise<void> = fetch("/api/clip-meta")
    .then((r) => r.json())
    .then((j) => void (meta = cleanMeta(j)))
    .catch(() => void (meta = {}));

  // ---- sound ----
  function applyGain(): void {
    const a = current();
    if (gain) gain.gain.value = a && !a.muted ? clampVolume(a.volume) : 0;
  }

  function ensureCtx(): AudioContext {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.connect(ctx.destination);
    }
    applyGain();
    return ctx;
  }

  function stopSource(): void {
    if (cur?.src) {
      try {
        cur.src.onended = null;
        cur.src.stop();
      } catch {
        // already stopped
      }
      cur.src.disconnect();
    }
    cur = null;
  }

  /** Starts the sound at a clip time: for playback (follows the speed) or as a short scrub burst. */
  function startAt(clipTime: number, burst: boolean): void {
    stopSource();
    const a = current();
    if (!buffer || !a || a.muted || a.volume <= 0) return;
    const c = ensureCtx();
    void c.resume().catch(() => {});
    const rate = burst ? 1 : host.speed();
    const pos = audioPosition(clipTime, a.offset);
    cur = { src: null, ctxStart: c.currentTime, clipTime, rate, burst };
    if (pos >= buffer.duration) return;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(gain!);
    const when = c.currentTime + (pos < 0 ? -pos / rate : 0);
    const from = Math.max(0, pos);
    if (burst) src.start(when, from, SCRUB_BURST);
    else src.start(when, from);
    cur.src = src;
    if (burst) bursts++;
    else starts++;
  }

  async function loadBuffer(): Promise<void> {
    await metaReady;
    const clipId = host.clipName();
    const a = current();
    if (loadedFor === clipId && loadedFile === (a?.file ?? "")) return;
    loadedFor = clipId;
    loadedFile = a?.file ?? "";
    const mine = ++token;
    stopSource();
    buffer = null;
    peaks = null;
    syncUi();
    if (!a) return;
    try {
      const bytes = await fetch(`/api/audio/${encodeURIComponent(a.file)}?v=${Date.now()}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`audio file missing (${r.status})`))));
      const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
      if (mine !== token) return;
      buffer = decoded;
      peaks = computePeaks(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)), decoded.sampleRate);
    } catch (error) {
      if (mine === token) host.status(`Audio reference for ${clipId} not loaded: ${error instanceof Error ? error.message : String(error)}`, "bad");
    }
    if (mine === token) {
      syncUi();
      draw();
      if (host.playing()) startAt(host.time(), false);
    }
  }

  // ---- panel ----
  function syncUi(): void {
    const a = current();
    root.hidden = !open && !a;
    toggle.classList.toggle("on", !root.hidden);
    toggle.setAttribute("aria-pressed", String(!root.hidden));
    for (const c of controls) c.hidden = !a;
    nameLabel.textContent = a ? a.name : "No audio loaded";
    if (a) {
      if (document.activeElement !== offsetInput) offsetInput.value = String(Math.round(a.offset * 1000));
      volumeInput.value = String(Math.round(a.volume * 100));
      muteBtn.classList.toggle("on", a.muted);
      muteBtn.setAttribute("aria-pressed", String(a.muted));
      muteBtn.textContent = a.muted ? "Unmute" : "Mute";
    }
    applyGain();
  }

  toggle.addEventListener("click", () => {
    // The strip stays while a clip has audio; the button only opens or closes the empty strip (the Load button).
    open = root.hidden;
    syncUi();
    draw();
  });
  loadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const clipId = host.clipName();
    if (!clipId) return host.status("Open a clip first: the audio reference belongs to a clip", "bad");
    const stored = audioFileName(clipId, file.name);
    if (!stored) return host.status("Pick a .wav or .mp3 file", "bad");
    if (file.size > MAX_BYTES) return host.status(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB; the audio reference limit is ${MAX_BYTES / 1048576} MB`, "bad");
    const bytes = await file.arrayBuffer();
    try {
      await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0));
    } catch {
      return host.status(`${file.name} could not be read as audio`, "bad");
    }
    const old = current();
    const res = await fetch(`/api/audio/${encodeURIComponent(stored)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: toBase64(bytes) }) }).catch(() => null);
    if (!res?.ok) {
      const message = res ? await apiError(res) : "the editor server is not answering";
      host.status(`Audio not saved: ${message}`, "bad");
      return void showToast(`Audio not saved: ${message}`, "bad");
    }
    if (old && old.file !== stored) void fetch(`/api/audio/${encodeURIComponent(old.file)}`, { method: "DELETE" }).catch(() => null);
    meta = { ...meta, [clipId]: { audio: { file: stored, name: file.name, offset: old?.offset ?? 0, volume: old?.volume ?? 1, muted: false } } };
    open = true;
    loadedFile = "";
    if (await saveMeta()) host.status(`Audio reference ${file.name} loaded for ${clipId} (kept in the data folder; it is not part of the clip or the project)`, "ok");
    await loadBuffer();
  });
  offsetInput.addEventListener("change", () => {
    const a = current();
    if (!a) return;
    a.offset = clampOffset(Number(offsetInput.value) / 1000);
    syncUi();
    draw();
    void saveMeta();
    if (host.playing()) startAt(host.time(), false);
  });
  volumeInput.addEventListener("input", () => {
    const a = current();
    if (!a) return;
    a.volume = clampVolume(Number(volumeInput.value) / 100);
    applyGain();
  });
  volumeInput.addEventListener("change", () => void saveMeta());
  muteBtn.addEventListener("click", () => {
    const a = current();
    if (!a) return;
    a.muted = !a.muted;
    syncUi();
    void saveMeta();
    if (a.muted) stopSource();
    else if (host.playing()) startAt(host.time(), false);
  });
  removeBtn.addEventListener("click", async () => {
    const a = current();
    const clipId = host.clipName();
    if (!a || !(await confirmDialog(`Remove the audio reference of ${clipId}?`, `This removes ${a.name} from the clip audio track and deletes its copy in the data folder. The original file you loaded is not touched.`, "Remove"))) return;
    stopSource();
    const next = { ...meta };
    delete next[clipId];
    meta = next;
    buffer = null;
    peaks = null;
    loadedFile = "";
    await fetch(`/api/audio/${encodeURIComponent(a.file)}`, { method: "DELETE" }).catch(() => null);
    await saveMeta();
    syncUi();
    draw();
    host.status(`Audio reference removed from ${clipId}`, "ok");
  });

  // ---- waveform ----
  function draw(): void {
    void loadBuffer();
    if (root.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(document.documentElement);
    const col = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col("--panel2", "#1a1d23");
    g.fillRect(0, 0, w, h);
    const a = current();
    const labelW = host.labelWidth();
    g.fillStyle = col("--dim", "#8a93a3");
    g.font = "12px sans-serif";
    g.textBaseline = "middle";
    g.fillText(a ? (buffer ? a.name : `${a.name} (loading)`) : "Audio reference", 8, h / 2, labelW - 14);
    const n = host.frames();
    const x0 = host.frameX(0, w);
    const x1 = host.frameX(n, w);
    let ink = 0;
    if (a && peaks && buffer && x1 > x0 && n > 0) {
      const secPerPx = n / host.fps() / (x1 - x0);
      g.fillStyle = col("--accent2", "#5fb3ff");
      const mid = h / 2;
      const amp = h / 2 - 3;
      for (let x = Math.max(labelW + 1, Math.floor(x0)); x <= Math.min(w - 1, Math.ceil(x1)); x++) {
        const t = (x - x0) * secPerPx;
        const r = peakRange(peaks, audioPosition(t, a.offset), audioPosition(t + secPerPx, a.offset));
        if (r.hi === 0 && r.lo === 0) continue;
        const top = mid - Math.min(1, r.hi) * amp;
        const bot = mid - Math.max(-1, r.lo) * amp;
        g.fillRect(x, top, 1, Math.max(1, bot - top));
        ink++;
      }
    }
    lastInk = ink;
    g.fillStyle = col("--line", "#2b303a");
    g.fillRect(labelW, 0, 1, h);
    const px = host.frameX(host.time() * host.fps(), w);
    g.fillStyle = col("--accent", "#ffb454");
    g.fillRect(Math.round(px), 0, 1, h);
  }

  new ResizeObserver(() => draw()).observe(canvas);

  return {
    draw,
    tick() {
      if (!cur || cur.burst || !host.playing() || !ctx) return;
      const expected = cur.clipTime + (ctx.currentTime - cur.ctxStart) * cur.rate;
      const now = performance.now();
      if ((cur.rate !== host.speed() || Math.abs(host.time() - expected) > DRIFT_LIMIT) && now - lastRestart > 150) {
        lastRestart = now;
        startAt(host.time(), false);
      }
    },
    playChanged(on) {
      if (!on) return stopSource();
      if (buffer) return startAt(host.time(), false);
      void loadBuffer().then(() => host.playing() && startAt(host.time(), false));
    },
    scrub() {
      if (host.playing() || !buffer) return;
      startAt(host.time(), true);
    },
    state() {
      const a = current();
      return {
        open: !root.hidden,
        loaded: !!buffer,
        clip: host.clipName(),
        name: a?.name ?? "",
        offset: a?.offset ?? 0,
        volume: a?.volume ?? 1,
        muted: a?.muted ?? false,
        peaks: peaks?.max.length ?? 0,
        sounding: !!cur && !cur.burst && !!cur.src,
        rate: cur?.rate ?? 0,
        starts,
        bursts,
        gain: gain?.gain.value ?? 0,
        inkColumns: lastInk
      };
    }
  };
}
