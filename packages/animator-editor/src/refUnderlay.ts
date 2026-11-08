/*
 * Atlas Animator editor: the reference video / image sequence underlay (see refModel.ts for the maths and the metadata).
 *
 * It extends the editor's image underlay (viewAids.ts): the same sprite behind the rig, the same opacity / scale / offsets, but the
 * picture comes from a local video (mp4 / webm) or a folder of numbered images and follows the clip timeline frame by frame. Scrubbing
 * the timeline seeks the source to the exact frame (a video is drawn to a canvas after each `seeked`, an image sequence swaps textures).
 * A box with handles on the canvas moves and scales it; Trace shows the reference at full opacity with the rig at half.
 * The path and transform are kept per clip in clips/refs.json (src/refsApi.ts), never in the rig or the clip.
 */
import { Texture } from "pixi.js";
import type { EditorHost } from "./host.js";
import { dragScale, isImagePath, isVideoPath, levels, newRef, normalizeRef, parseRefStore, refFrameIndex, refTimeAt, sequenceOrder, videoFrameCount, videoSeekTime, type RefKind, type RefMeta } from "./refModel.js";
import { apiError, showToast } from "./persistUi.js";

const mediaUrl = (path: string): string => `/api/refs/media?path=${encodeURIComponent(path)}`;
const isAbsolutePath = (p: string): boolean => /^([A-Za-z]:[\\/]|\/)/.test(p);

type El = HTMLElement;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { title?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

export interface RefApi {
  load(path: string, kind?: RefKind): Promise<void>;
  loadFiles(files: File[]): Promise<void>;
  set(patch: { opacity?: number; scale?: number; x?: number; y?: number; offsetFrames?: number; speed?: number; fps?: number; trace?: boolean }): void;
  clear(): void;
  /** Resolves when the source frame for the current time is on screen. */
  settled(): Promise<void>;
  info(): { loaded: boolean; kind: RefKind | null; path: string | null; frame: number | null; wanted: number | null; count: number; meta: RefMeta | null };
}

export function installRefUnderlay(host: EditorHost): RefApi | null {
  const view = document.getElementById("view");
  const pane = document.getElementById("pane-preview");
  if (!view || !pane) return null;

  let store: Record<string, RefMeta> = {};
  const storeReady = fetch("/api/refs")
    .then((r) => r.json())
    .then((raw) => void (store = parseRefStore(raw)))
    .catch(() => undefined);

  let meta: RefMeta | null = null;
  let loadedKey = "";
  let loadToken = 0;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let videoTex: Texture | null = null;
  let videoDuration = 0;
  let seq: { urls: string[]; cache: Map<number, Texture>; pending: Map<number, Promise<Texture>> } | null = null;
  let count = 0;
  let shown = -1;
  let target = -1;
  let busy = false;
  const waiters: (() => void)[] = [];
  let adjust = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let localUrls: string[] = [];

  // ---- panel ----
  const section = el("section", { id: "refpanel", className: "detail" });
  const status = el("div", { id: "refstatus", className: "note", textContent: "No reference for this clip." });
  const pathInput = el("input", { id: "refpath", type: "text", placeholder: "C:\\refs\\swing.webm  or  a folder of frames", title: "Absolute path of a video (mp4 / webm) or of a folder of numbered images" });
  const loadBtn = el("button", { id: "refload", textContent: "Load", title: "Load the reference at this path for the clip being edited" });
  const picker = el("input", { id: "refpick", type: "file", accept: "video/*,image/*", multiple: true, title: "Pick a video, or several numbered images, for this session" });
  picker.style.display = "none";
  const pickBtn = el("button", { id: "refbrowse", textContent: "Browse", title: "Pick a local video or image sequence (kept for this session; type its path to keep it with the clip)" });
  const num = (id: string, tip: string, step: string, width = 56): HTMLInputElement => {
    const i = el("input", { id, type: "number", step, title: tip }) as HTMLInputElement;
    i.style.width = `${width}px`;
    return i;
  };
  const opacity = el("input", { id: "refopacity", type: "range", min: "0", max: "100", title: "How visible the reference is (Trace mode overrides it)" }) as HTMLInputElement;
  const scale = num("refscale", "Size of the reference in percent of the figure height", "5");
  const px = num("refx", "Move the reference sideways (rig units)", "5");
  const py = num("refy", "Move the reference up or down (rig units)", "5");
  const offset = num("refoffset", "Clip frame at which the reference's first frame plays", "1");
  const speed = num("refspeed", "Reference seconds per clip second (0.5 = half speed)", "0.05");
  const fps = num("reffps", "Frames per second of the source video or image sequence", "1");
  const trace = el("button", { id: "reftrace", textContent: "Trace", title: "Trace mode: the reference at full opacity, the rig at 50%" });
  const adjustBtn = el("button", { id: "refadjust", textContent: "Handles", title: "Show a box on the canvas: drag its edges to move the reference, its corners to scale it" });
  const clearBtn = el("button", { id: "refclear", textContent: "Clear", title: "Remove the reference from this clip (the file itself is not touched)" });
  const cell = (label: string, ...kids: El[]): El[] => [el("span", { className: "label", textContent: label }), el("div", { className: "refcell" }, ...kids)];
  const small = (text: string): El => el("span", { className: "help", textContent: text });
  const grid = el("div", { className: "refgrid" });
  grid.append(
    ...cell("Open", loadBtn, pickBtn, picker),
    ...cell("Look", opacity, small("Size %"), scale),
    ...cell("Place", small("X"), px, small("Y"), py),
    ...cell("Offset", offset, small("frames")),
    ...cell("Speed", speed, small("x the clip")),
    ...cell("Source", fps, small("fps"))
  );
  // The reference video is optional, so the section starts folded (the person's own fold choice wins once they make one).
  section.classList.add("collapsed");
  section.append(
    el("h2", { textContent: "Reference video" }),
    pathInput,
    grid,
    el("div", { className: "row" }, trace, adjustBtn, clearBtn),
    status
  );
  pane.append(section);

  // ---- handles on the canvas ----
  const box = el("div", { id: "refbox" });
  const corners = (["nw", "ne", "sw", "se"] as const).map((c) => {
    const h = el("div", { className: `refhandle corner ${c}`, title: "Drag to scale the reference" });
    h.dataset.kind = "scale";
    h.dataset.corner = c;
    return h;
  });
  const edges = (["n", "e", "s", "w"] as const).map((c) => {
    const h = el("div", { className: `refhandle edge ${c}`, title: "Drag to move the reference" });
    h.dataset.kind = "move";
    return h;
  });
  box.append(...edges, ...corners);
  view.append(box);

  const aids = () => host.aids;
  const redraw = (): void => host.redraw();

  function paintInputs(): void {
    const m = meta;
    const t = m?.transform;
    pathInput.value = m?.path ?? "";
    opacity.value = String(Math.round((t?.opacity ?? 0.5) * 100));
    scale.value = String(Math.round((t?.scale ?? 1) * 100));
    px.value = String(Math.round(t?.x ?? 0));
    py.value = String(Math.round(t?.y ?? 0));
    offset.value = String(m?.offsetFrames ?? 0);
    speed.value = String(m?.speed ?? 1);
    fps.value = String(m?.fps ?? 30);
    trace.classList.toggle("on", !!m?.trace);
    adjustBtn.classList.toggle("on", adjust);
    for (const c of [opacity, scale, px, py, offset, speed, fps, trace, adjustBtn, clearBtn]) c.toggleAttribute("disabled", !m);
  }

  function applyLook(): void {
    const a = aids();
    const m = meta;
    const ch = host.character;
    if (!m) {
      if (ch) ch.alpha = 1;
      return;
    }
    const lv = levels(m);
    a?.setUnderlay({ opacity: lv.reference, scale: m.transform.scale, x: m.transform.x, y: m.transform.y });
    if (ch) ch.alpha = lv.rig;
    redraw();
  }

  function save(): void {
    clearTimeout(saveTimer);
    const clip = host.clipName;
    const m = meta;
    if (!clip || (m && !isAbsolutePath(m.path))) return;
    saveTimer = setTimeout(() => {
      store = m ? { ...store, [clip]: m } : Object.fromEntries(Object.entries(store).filter(([k]) => k !== clip));
      void fetch(`/api/refs/${encodeURIComponent(clip)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m ? { ...m, transform: { ...m.transform } } : null) })
        .then(async (r) => {
          if (!r.ok) showToast(`Reference settings not saved: ${await apiError(r)}`, "bad");
        })
        .catch(() => showToast("Reference settings not saved: the editor server is not answering", "bad"));
    }, 250);
  }

  function change(patch: (m: RefMeta) => void): void {
    if (!meta) return;
    const next = structuredClone(meta);
    patch(next);
    meta = normalizeRef(next);
    paintInputs();
    applyLook();
    sync();
    save();
  }

  // ---- media ----
  function dispose(): void {
    loadToken++;
    video?.removeAttribute("src");
    video?.load();
    video = null;
    canvas = null;
    videoTex?.destroy(true);
    videoTex = null;
    for (const t of seq?.cache.values() ?? []) t.destroy(true);
    seq = null;
    count = 0;
    shown = -1;
    target = -1;
    loadedKey = "";
    for (const u of localUrls) URL.revokeObjectURL(u);
    localUrls = [];
    aids()?.setUnderlaySource(null);
    const ch = host.character;
    if (ch) ch.alpha = 1;
  }

  const once = (node: EventTarget, ok: string, ms = 4000): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${ok}`)), ms);
      node.addEventListener(
        ok,
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      node.addEventListener("error", () => reject(new Error("the media could not be loaded")), { once: true });
    });

  async function openVideo(src: string, token: number): Promise<void> {
    const v = el("video", { muted: true, playsInline: true, preload: "auto" });
    v.src = src;
    await once(v, "loadeddata", 15000);
    if (token !== loadToken) return;
    video = v;
    videoDuration = v.duration || 0;
    canvas = el("canvas", { width: v.videoWidth || 2, height: v.videoHeight || 2 });
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    videoTex = Texture.from(canvas);
    count = videoFrameCount(videoDuration, meta?.fps ?? 30);
    aids()?.setUnderlaySource(videoTex);
  }

  async function openSequence(urls: string[], token: number): Promise<void> {
    if (!urls.length) throw new Error("no images in that folder");
    seq = { urls, cache: new Map(), pending: new Map() };
    count = urls.length;
    const first = await seqTexture(0);
    if (token !== loadToken) return;
    aids()?.setUnderlaySource(first);
  }

  function seqTexture(i: number): Promise<Texture> {
    const s = seq!;
    const have = s.cache.get(i);
    if (have) return Promise.resolve(have);
    let p = s.pending.get(i);
    if (!p) {
      p = (async () => {
        const img = new Image();
        img.src = s.urls[i]!;
        await img.decode();
        const tex = Texture.from(img);
        s.cache.set(i, tex);
        // Keep a window of textures, not the whole sequence.
        if (s.cache.size > 90) {
          const far = [...s.cache.keys()].sort((a, b) => Math.abs(b - i) - Math.abs(a - i))[0]!;
          s.cache.get(far)?.destroy(true);
          s.cache.delete(far);
        }
        s.pending.delete(i);
        return tex;
      })();
      s.pending.set(i, p);
    }
    return p;
  }

  async function render(idx: number): Promise<void> {
    if (video && canvas && videoTex && meta) {
      const t = videoSeekTime(idx, meta.fps, videoDuration);
      if (Math.abs(video.currentTime - t) > 1e-4) {
        const done = once(video, "seeked", 5000).catch(() => undefined);
        video.currentTime = t;
        await done;
      }
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      videoTex.source.update();
    } else if (seq) {
      const tex = await seqTexture(idx);
      aids()?.setUnderlaySource(tex);
      void seqTexture(Math.min(count - 1, idx + 1)).catch(() => undefined);
    }
  }

  async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (target !== shown && target >= 0) {
        const want = target;
        try {
          await render(want);
        } catch {
          /* a frame that cannot load is skipped */
        }
        shown = want;
        host.redraw();
      }
    } finally {
      busy = false;
      for (const w of waiters.splice(0)) w();
    }
  }

  function sync(): void {
    if (!meta || !(video || seq)) return;
    const idx = refFrameIndex(refTimeAt(meta, host.time, host.clip.fps || 30), meta.fps, count);
    if (idx === target && idx === shown) return;
    target = idx;
    void pump();
  }

  async function open(m: RefMeta, urls?: string[] | string): Promise<void> {
    dispose();
    const token = loadToken;
    meta = m;
    loadedKey = `${m.kind}|${m.path}`;
    paintInputs();
    status.textContent = "Loading the reference...";
    status.classList.remove("bad");
    try {
      if (m.kind === "video") await openVideo(typeof urls === "string" ? urls : mediaUrl(m.path), token);
      else {
        let list = Array.isArray(urls) ? urls : undefined;
        if (!list) {
          const res = (await fetch(`/api/refs/dir?path=${encodeURIComponent(m.path)}`).then((r) => r.json())) as { files?: string[]; error?: string };
          if (!res.files) throw new Error(res.error ?? "no such folder");
          list = res.files.map(mediaUrl);
        }
        await openSequence(list, token);
      }
      if (token !== loadToken) return;
      status.textContent = m.kind === "video" ? `Video, ${videoDuration.toFixed(2)} s (${count} frames at ${m.fps} fps).` : `Image sequence, ${count} frames at ${m.fps} fps.`;
      applyLook();
      sync();
    } catch (error) {
      if (token !== loadToken) return;
      status.textContent = `Could not load the reference: ${error instanceof Error ? error.message : String(error)}`;
      status.classList.add("bad");
      loadedKey = "";
    }
  }

  async function loadPath(path: string, kind?: RefKind): Promise<void> {
    const p = path.trim();
    if (!p) return;
    const k = kind ?? (isVideoPath(p) ? "video" : isImagePath(p) ? "sequence" : "sequence");
    // A single image file means its folder is the sequence.
    const folder = k === "sequence" && isImagePath(p) ? p.replace(/[\\/][^\\/]*$/, "") : p;
    const keep = meta && loadedKey ? meta : null;
    const m = newRef(k, folder);
    if (keep) Object.assign(m, { fps: keep.fps, offsetFrames: keep.offsetFrames, speed: keep.speed, transform: keep.transform, trace: keep.trace });
    await open(m);
    save();
  }

  async function loadFiles(files: File[]): Promise<void> {
    const videos = files.filter((f) => f.type.startsWith("video/") || isVideoPath(f.name));
    const images = files.filter((f) => !videos.includes(f)).sort((a, b) => sequenceOrder(a.name, b.name));
    if (videos[0]) {
      const url = URL.createObjectURL(videos[0]);
      await open(newRef("video", videos[0].name), url);
      localUrls = [url];
    } else if (images.length) {
      const urls = images.map((f) => URL.createObjectURL(f));
      await open(newRef("sequence", `${images[0]!.name} (+${images.length - 1})`), urls);
      localUrls = urls;
    }
    if (meta) status.textContent += " Loaded for this session; type its path to keep it with the clip.";
  }

  function clear(): void {
    meta = null;
    dispose();
    paintInputs();
    status.textContent = "No reference for this clip.";
    status.classList.remove("bad");
    redraw();
    save();
  }

  // ---- panel wiring ----
  loadBtn.addEventListener("click", () => void loadPath(pathInput.value));
  pathInput.addEventListener("keydown", (e) => e.key === "Enter" && void loadPath(pathInput.value));
  pickBtn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    void loadFiles([...(picker.files ?? [])]);
    picker.value = "";
  });
  opacity.addEventListener("input", () => change((m) => (m.transform.opacity = Number(opacity.value) / 100)));
  scale.addEventListener("change", () => change((m) => (m.transform.scale = (Number(scale.value) || 100) / 100)));
  px.addEventListener("change", () => change((m) => (m.transform.x = Number(px.value) || 0)));
  py.addEventListener("change", () => change((m) => (m.transform.y = Number(py.value) || 0)));
  offset.addEventListener("change", () => change((m) => (m.offsetFrames = Number(offset.value) || 0)));
  speed.addEventListener("change", () => change((m) => (m.speed = Number(speed.value) || 1)));
  fps.addEventListener("change", () => {
    change((m) => (m.fps = Number(fps.value) || 30));
    if (video) count = videoFrameCount(videoDuration, meta?.fps ?? 30);
    shown = -1;
    sync();
  });
  trace.addEventListener("click", () => change((m) => (m.trace = !m.trace)));
  adjustBtn.addEventListener("click", () => {
    adjust = !adjust;
    paintInputs();
  });
  clearBtn.addEventListener("click", clear);

  // ---- handle dragging ----
  let drag: { kind: "move" | "scale"; sx: number; sy: number; x: number; y: number; scale: number; anchor: { x: number; y: number } } | null = null;

  function toClient(rx: number, ry: number): { x: number; y: number } {
    const g = host.world.toGlobal({ x: rx, y: ry });
    const cr = host.app.canvas.getBoundingClientRect();
    return { x: cr.left + (g.x * cr.width) / host.app.screen.width, y: cr.top + (g.y * cr.height) / host.app.screen.height };
  }

  box.addEventListener("pointerdown", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".refhandle");
    const a = aids()?.underlayRect();
    if (!t || !meta || !a) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag = { kind: t.dataset.kind === "scale" ? "scale" : "move", sx: e.clientX, sy: e.clientY, x: meta.transform.x, y: meta.transform.y, scale: meta.transform.scale, anchor: toClient(a.anchorX, a.anchorY) };
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag || !meta) return;
    const d = drag;
    if (d.kind === "move") {
      const z = host.zoom() || 1;
      change((m) => {
        m.transform.x = d.x + (e.clientX - d.sx) / z;
        m.transform.y = d.y + (e.clientY - d.sy) / z;
      });
    } else change((m) => (m.transform.scale = dragScale(d.scale, d.anchor, { x: d.sx, y: d.sy }, { x: e.clientX, y: e.clientY })));
  });
  const endDrag = (): void => void (drag = null);
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  let lastBox = "";
  function placeBox(): void {
    const a = meta && adjust ? aids()?.underlayRect() : null;
    if (!a) {
      if (lastBox !== "off") box.style.display = "none";
      lastBox = "off";
      return;
    }
    const p0 = toClient(a.x, a.y);
    const p1 = toClient(a.x + a.w, a.y + a.h);
    const vr = view!.getBoundingClientRect();
    const css = `${Math.round(p0.x - vr.left)}|${Math.round(p0.y - vr.top)}|${Math.round(p1.x - p0.x)}|${Math.round(p1.y - p0.y)}`;
    if (css === lastBox) return;
    lastBox = css;
    box.style.display = "block";
    box.style.left = `${Math.round(p0.x - vr.left)}px`;
    box.style.top = `${Math.round(p0.y - vr.top)}px`;
    box.style.width = `${Math.round(p1.x - p0.x)}px`;
    box.style.height = `${Math.round(p1.y - p0.y)}px`;
  }
  const loop = (): void => {
    placeBox();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // ---- clip changes and the timeline ----
  let lastClip = "";
  async function attachForClip(): Promise<void> {
    await storeReady;
    const name = host.clipName;
    if (name === lastClip) return;
    lastClip = name;
    const m = store[name];
    if (!m) {
      if (meta || loadedKey) {
        meta = null;
        dispose();
        paintInputs();
        status.textContent = "No reference for this clip.";
        redraw();
      }
      return;
    }
    if (loadedKey === `${m.kind}|${m.path}` && meta) {
      meta = structuredClone(m);
      paintInputs();
      applyLook();
      sync();
      return;
    }
    await open(structuredClone(m));
  }
  host.on("clip", () => void attachForClip());
  host.on("time", sync);
  host.on("pose", sync);
  void attachForClip();
  paintInputs();

  const api: RefApi = {
    load: loadPath,
    loadFiles,
    set(p) {
      change((m) => {
        if (p.opacity !== undefined) m.transform.opacity = p.opacity;
        if (p.scale !== undefined) m.transform.scale = p.scale;
        if (p.x !== undefined) m.transform.x = p.x;
        if (p.y !== undefined) m.transform.y = p.y;
        if (p.offsetFrames !== undefined) m.offsetFrames = p.offsetFrames;
        if (p.speed !== undefined) m.speed = p.speed;
        if (p.fps !== undefined) m.fps = p.fps;
        if (p.trace !== undefined) m.trace = p.trace;
      });
    },
    clear,
    settled: () => (busy || target !== shown ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    info: () => ({ loaded: !!(video || seq), kind: meta?.kind ?? null, path: meta?.path ?? null, frame: shown >= 0 ? shown : null, wanted: target >= 0 ? target : null, count, meta: meta ? structuredClone(meta) : null })
  };
  (window as unknown as { atlasRefs?: RefApi }).atlasRefs = api;
  return api;
}
