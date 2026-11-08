/*
 * Atlas Animator editor: original implementation.
 *
 * Two drawing aids behind the rig, both Pixi sprites in the editor's stage:
 * - onion skin: the previous and next frames of the clip rendered into textures (the rig re-posed for each) and
 *   shown behind the live pose, faded by distance and tinted (previous blue, next orange);
 * - reference underlay: a faded image, or one frame of a horizontal sprite strip, behind the rig in rig space
 *   (so it follows zoom and pan), the strip frame following the playhead. A guide to draw against, not to trace.
 */
import { ColorMatrixFilter, Container, Graphics, Rectangle, RenderTexture, Sprite, Texture, type Application } from "pixi.js";

export const ONION_PREV_TINT = 0x5fb3ff;
export const ONION_NEXT_TINT = 0xff9f43;
/** Pinned pose A (Pose A / B compare) is drawn in this violet over the live pose. */
export const PIN_TINT = 0xb28dff;
/** Rig px below the skeleton origin the feet reach, and the figure height in rig px: where an underlay is placed by default. */
const FEET_BELOW = 262;
const FIGURE_HEIGHT = 1120;

/**
 * Frames to ghost around `frame`: for each distance 1..count the previous then the next frame (negative / positive
 * `dist`). A loop wraps around its `frames` frames; a one-shot has frames 0..frames inclusive and skips what is outside.
 */
export function onionPlan(frame: number, frames: number, count: number, loops: boolean): { frame: number; dist: number }[] {
  const out: { frame: number; dist: number }[] = [];
  for (let k = 1; k <= count; k++) {
    for (const sign of [-1, 1]) {
      let g = frame + sign * k;
      if (loops && frames > 0) g = ((g % frames) + frames) % frames;
      else if (g < 0 || g > frames) continue;
      if (g === frame || out.some((o) => o.frame === g && Math.abs(o.dist) <= k && o.dist !== sign * k)) continue;
      out.push({ frame: g, dist: sign * k });
    }
  }
  return out;
}

/** Onion skin settings: how many ghosts each side, which frames, how they are drawn, how fast they fade. */
export type OnionMode = "frames" | "keys";
export type OnionStyle = "tint" | "outline";
export type OnionScope = "all" | "selected";
export interface OnionOptions {
  enabled: boolean;
  /** Ghosts before / after the shown frame (0..MAX_ONION). */
  before: number;
  after: number;
  /** `frames`: every `step` frames; `keys`: the neighbouring keys of the clip, however far apart. */
  mode: OnionMode;
  step: number;
  /** `tint`: the whole ghost tinted (cool before, warm after); `outline`: only its silhouette edge. */
  style: OnionStyle;
  /** `all`: the whole character in every ghost; `selected`: only the slots on the selected bones (the rest of the character is left out). */
  scope?: OnionScope;
  /** Opacity of the nearest ghost, 0..1. */
  opacity: number;
  /** Share of opacity lost per ghost further out, 0..0.9 (0 = every ghost as strong as the first). */
  falloff: number;
}
export const MAX_ONION = 6;
export const ONION_DEFAULTS: OnionOptions = { enabled: false, before: 2, after: 2, mode: "frames", step: 1, style: "tint", scope: "all", opacity: 0.42, falloff: 0.5 };

export interface OnionGhost {
  frame: number;
  /** -1 = before the shown frame (cool), 1 = after (warm). */
  side: -1 | 1;
  /** 1 = the nearest ghost on its side. */
  rank: number;
  alpha: number;
}

/**
 * The ghosts to draw around `frame`: up to `before` / `after` frames on each side, every `step` frames or (keys mode) the neighbouring
 * keys of the clip. A loop wraps; a one-shot has frames 0..frames inclusive. Opacity falls off per rank: opacity * (1 - falloff)^(rank - 1).
 */
export function onionGhosts(frame: number, frames: number, loops: boolean, o: OnionOptions, keyFrames: readonly number[] = []): OnionGhost[] {
  const out: OnionGhost[] = [];
  const taken = new Set<number>([frame]);
  const total = Math.max(0, frames);
  const alphaOf = (rank: number) => Math.max(0, Math.min(1, o.opacity * (1 - o.falloff) ** (rank - 1)));
  const wrap = (g: number): number | null => {
    if (loops && total > 0) return ((g % total) + total) % total;
    return g < 0 || g > total ? null : g;
  };
  const push = (g: number | null, side: -1 | 1, rank: number): boolean => {
    if (g === null || taken.has(g)) return false;
    taken.add(g);
    out.push({ frame: g, side, rank, alpha: alphaOf(rank) });
    return true;
  };
  const sides: [-1 | 1, number][] = [
    [-1, o.before],
    [1, o.after]
  ];
  if (o.mode === "keys") {
    const keys = [...new Set(keyFrames.map((k) => Math.round(k)))].sort((a, b) => a - b);
    for (const [side, count] of sides) {
      const ordered = side < 0 ? keys.filter((k) => k < frame).reverse() : keys.filter((k) => k > frame);
      // A loop continues past its end: the keys before frame 0 are the clip's last keys, the keys after the last frame its first.
      const wrapped = loops ? (side < 0 ? keys.filter((k) => k >= frame).reverse() : keys.filter((k) => k <= frame)) : [];
      let rank = 0;
      for (const k of [...ordered, ...wrapped]) {
        if (rank >= count) break;
        if (push(k, side, rank + 1)) rank++;
      }
    }
    return out.sort((a, b) => a.rank - b.rank || a.side - b.side);
  }
  const step = Math.max(1, Math.round(o.step));
  const max = Math.max(o.before, o.after);
  for (let k = 1; k <= max; k++) {
    for (const [side, count] of sides) if (k <= count) push(wrap(frame + side * k * step), side, k);
  }
  return out;
}

export interface AidsHost {
  app: Application;
  world: Container;
  overlay: Graphics;
  /** Poses the skeleton at a clip frame (without unkeyed edits) and updates the character. */
  poseAtFrame(frame: number): void;
  /** Puts the shown pose back (the playhead's, with unkeyed edits). */
  restorePose(): void;
  /** Poses the skeleton as pinned pose A (without unkeyed edits of the live pose); false when nothing is pinned or it does not fit this rig. */
  poseAsPin?(): boolean;
  frame(): number;
  frames(): number;
  loops(): boolean;
  /** Frames (whole numbers) that hold a key of any bone / slot, for the keys-only onion mode. */
  keyFrames?(): number[];
  /** Changes whenever what a ghost shows changes besides the frame: the clip, the worn skins, the rig, the view's zoom and pan. Cached ghosts are dropped then. */
  onionKey?(): string;
  /** The selected bones' scope for ghosts: hides everything else in the posed character; null when no bone is selected. `key` names the selection. */
  onionScope?(): { key: string; hide(): void } | null;
  playing(): boolean;
  fps(): number;
  time(): number;
}

export interface ViewAids {
  /** `count` sets both sides. */
  setOnion(options: Partial<OnionOptions> & { count?: number }): void;
  onionOptions(): OnionOptions;
  /**
   * Shows the ghosts for the current frame. Ghosts are rendered into cached textures (one per frame), so scrubbing back and forth and
   * every loop of a playback after the first cost no rendering. While playing at most one missing ghost is rendered per call.
   */
  renderOnion(): void;
  /** Pose A / B compare: shows pinned pose A as a tinted ghost over the live pose (same render-to-texture path as the onion ghosts). */
  setPinGhost(on: boolean): void;
  /** Re-renders the pinned-pose ghost for the current view (call after the shown pose or the view changed, not while playing). */
  renderPin(): void;
  /** Draws the underlay frame for the current time. */
  updateUnderlay(): void;
  loadUnderlay(file: File): Promise<void>;
  setUnderlay(options: { opacity?: number; scale?: number; x?: number; y?: number; frames?: number }): void;
  clearUnderlay(): void;
  /** Shows an external texture (a reference video frame ...) as the underlay: same sprite, opacity, scale and offsets as an image underlay. null removes it. */
  setUnderlaySource(texture: Texture | null): void;
  /** The underlay's box in rig space (left, top, width, height) and the point it scales from, or null when none is loaded. */
  underlayRect(): { x: number; y: number; w: number; h: number; anchorX: number; anchorY: number } | null;
  info(): {
    onion: OnionOptions & { count: number; frames: number[]; ghosts: number; tints: number[]; cached: number; renders: number; hits: number; composites: number; compositeMB: number; compositeHits: number; compositeBuilds: number };
    underlay: { loaded: boolean; frames: number; frame: number | null; opacity: number; scale: number; x: number; y: number };
    pin: { on: boolean; visible: boolean; tint: number };
  };
}

export function createViewAids(host: AidsHost): ViewAids {
  const { app, world } = host;
  const ghostLayer = new Container({ label: "onion" });
  app.stage.addChildAt(ghostLayer, 0);
  const underlayLayer = new Container({ label: "underlay" });
  world.addChildAt(underlayLayer, 0);

  const onion: OnionOptions = { ...ONION_DEFAULTS };
  const ghosts: Sprite[] = [];
  let ghostFrames: number[] = [];

  // Ghost cache: one render texture per ghost frame, valid while the signature (view size, host key, style) is unchanged.
  /** A cached ghost: the render texture, and the sub-texture of just the figure's box (the sprite draws only that, so a ghost costs a fraction of a full-screen quad). */
  interface GhostEntry {
    tex: RenderTexture;
    sub: Texture;
    x: number;
    y: number;
    used: number;
  }
  const cache = new Map<string, GhostEntry>();
  const freeTex: RenderTexture[] = [];
  let cacheSig = "";
  let useClock = 0;
  let renders = 0;
  let hits = 0;
  const CACHE_MAX = 40;
  // Composite cache: all the ghosts of one playhead frame drawn into ONE cropped texture, so playback draws a single quad.
  // An LRU bounded by an estimated byte budget (width x height x resolution^2 x 4), so a bigger DPR holds fewer composites.
  interface Composite {
    tex: RenderTexture;
    x: number;
    y: number;
    bytes: number;
    used: number;
    tints: number[];
  }
  const composites = new Map<string, Composite>();
  let compositeBytes = 0;
  let compositeHits = 0;
  let compositeBuilds = 0;
  const compSprite = new Sprite();
  compSprite.visible = false;
  ghostLayer.addChild(compSprite);
  const compBuild = new Container();
  let shownTints: number[] = [];
  let scratch: RenderTexture | null = null;
  let edge: { cont: Container; sprites: Sprite[]; erase: Sprite; filter: ColorMatrixFilter } | null = null;

  const viewSize = () => ({ w: Math.max(2, Math.round(app.screen.width)), h: Math.max(2, Math.round(app.screen.height)), res: app.renderer.resolution });
  const takeTex = (): RenderTexture => {
    const { w, h, res } = viewSize();
    const t = freeTex.pop() ?? RenderTexture.create({ width: w, height: h, resolution: res });
    if (t.width !== w || t.height !== h) t.resize(w, h, res);
    return t;
  };
  const release = (e: GhostEntry): void => {
    e.sub.destroy(false);
    freeTex.push(e.tex);
  };
  const dropComposites = (): void => {
    for (const c of composites.values()) c.tex.destroy(true);
    composites.clear();
    compositeBytes = 0;
    compSprite.visible = false;
  };
  const dropCache = (): void => {
    dropComposites();
    for (const e of cache.values()) release(e);
    cache.clear();
    while (freeTex.length > CACHE_MAX) freeTex.pop()!.destroy(true);
  };
  const syncCache = (): void => {
    const { w, h, res } = viewSize();
    const sig = `${w}x${h}@${res}|${host.onionKey?.() ?? ""}|${onion.style}|${onion.scope === "selected" ? (host.onionScope?.()?.key ?? "all") : "all"}`;
    if (sig !== cacheSig) {
      cacheSig = sig;
      dropCache();
    }
  };
  const ensureSprites = (n: number): void => {
    while (ghosts.length < n) {
      const s = new Sprite();
      ghosts.push(s);
      ghostLayer.addChild(s);
    }
  };

  /** Silhouette edge of `raw` in `color`, 2 css px wide, drawn outside the shape: a flat-coloured copy at eight offsets, the shape itself erased. */
  const buildOutline = (raw: RenderTexture, out: RenderTexture, color: number): void => {
    if (!edge) {
      const cont = new Container();
      const sprites = Array.from({ length: 8 }, () => new Sprite(raw));
      cont.addChild(...sprites);
      const filter = new ColorMatrixFilter();
      cont.filters = [filter];
      const erase = new Sprite(raw);
      erase.blendMode = "erase";
      edge = { cont, sprites, erase, filter };
    }
    const t = 2;
    const dirs: [number, number][] = [[-t, 0], [t, 0], [0, -t], [0, t], [-t, -t], [t, -t], [-t, t], [t, t]];
    edge.sprites.forEach((sp, i) => {
      sp.texture = raw;
      sp.position.set(dirs[i]![0], dirs[i]![1]);
    });
    edge.erase.texture = raw;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    // Flat colour, alpha kept.
    edge.filter.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0];
    app.renderer.render({ container: edge.cont, target: out, clear: true, clearColor: [0, 0, 0, 0] });
    app.renderer.render({ container: edge.erase, target: out, clear: false });
  };

  const COMPOSITE_BUDGET = 64 * 1024 * 1024;
  const buildComposite = (ckey: string, plan: OnionGhost[], keyOf: (p: OnionGhost) => string): Composite | null => {
    const entries = plan.map((p) => ({ p, e: cache.get(keyOf(p))! }));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const { e } of entries) {
      x0 = Math.min(x0, e.x);
      y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.sub.frame.width);
      y1 = Math.max(y1, e.y + e.sub.frame.height);
    }
    const w = Math.ceil(x1 - x0);
    const h = Math.ceil(y1 - y0);
    if (!(w > 0 && h > 0)) return null;
    const res = app.renderer.resolution;
    const bytes = Math.round(w * res * (h * res) * 4);
    // Evict least recently used composites until the new one fits the budget.
    while (composites.size && compositeBytes + bytes > COMPOSITE_BUDGET) {
      let oldest: [string, number] | null = null;
      for (const [k, c] of composites) if (!oldest || c.used < oldest[1]) oldest = [k, c.used];
      const c = composites.get(oldest![0])!;
      c.tex.destroy(true);
      composites.delete(oldest![0]);
      compositeBytes -= c.bytes;
    }
    const tex = RenderTexture.create({ width: w, height: h, resolution: res });
    const tints: number[] = [];
    const sprites = entries.map(({ p, e }) => {
      const s = new Sprite(e.sub);
      const tint = onion.style === "outline" ? 0xffffff : p.side < 0 ? ONION_PREV_TINT : ONION_NEXT_TINT;
      tints.push(tint);
      s.tint = tint;
      s.alpha = onion.style === "outline" ? Math.min(1, p.alpha * 1.9) : p.alpha;
      s.position.set(e.x - x0, e.y - y0);
      return s;
    });
    compBuild.addChild(...sprites);
    app.renderer.render({ container: compBuild, target: tex, clear: true, clearColor: [0, 0, 0, 0] });
    compBuild.removeChildren();
    for (const s of sprites) s.destroy();
    const comp: Composite = { tex, x: x0, y: y0, bytes, used: ++useClock, tints };
    composites.set(ckey, comp);
    compositeBytes += bytes;
    compositeBuilds++;
    return comp;
  };

  const renderOnion = (): void => {
    if (!onion.enabled) {
      compSprite.visible = false;
      ghostLayer.visible = false;
      ghostFrames = [];
      return;
    }
    const playing = host.playing();
    syncCache();
    const plan = onionGhosts(host.frame(), host.frames(), host.loops(), onion, onion.mode === "keys" ? (host.keyFrames?.() ?? []) : []);
    ghostFrames = plan.map((p) => p.frame);
    const keyOf = (p: OnionGhost) => (onion.style === "outline" ? `${p.frame}:${p.side}` : String(p.frame));
    let budget = playing ? 1 : Infinity;
    const missing = plan.filter((p) => !cache.has(keyOf(p)));
    if (missing.length) {
      ghostLayer.visible = false;
      const overlayWas = host.overlay.visible;
      const pinWas = pinLayer.visible;
      const underWas = underlayLayer.visible;
      host.overlay.visible = false;
      pinLayer.visible = false;
      underlayLayer.visible = false;
      try {
        for (const p of missing) {
          if (budget-- <= 0) break;
          // Evict the least recently used ghost that this plan does not need.
          if (cache.size >= CACHE_MAX) {
            const needed = new Set(plan.map(keyOf));
            let oldest: [string, number] | null = null;
            for (const [k, e] of cache) if (!needed.has(k) && (!oldest || e.used < oldest[1])) oldest = [k, e.used];
            if (oldest) {
              release(cache.get(oldest[0])!);
              cache.delete(oldest[0]);
            }
          }
          host.poseAtFrame(p.frame);
          if (onion.scope === "selected") host.onionScope?.()?.hide();
          const tex = takeTex();
          if (onion.style === "outline") {
            if (!scratch) scratch = RenderTexture.create({ width: tex.width, height: tex.height, resolution: tex.source.resolution });
            else if (scratch.width !== tex.width || scratch.height !== tex.height) scratch.resize(tex.width, tex.height, tex.source.resolution);
            app.renderer.render({ container: app.stage, target: scratch, clear: true, clearColor: [0, 0, 0, 0] });
            buildOutline(scratch, tex, p.side < 0 ? ONION_PREV_TINT : ONION_NEXT_TINT);
          } else app.renderer.render({ container: app.stage, target: tex, clear: true, clearColor: [0, 0, 0, 0] });
          // The figure's box on screen at this pose (the overlay and the underlay are hidden), padded for the outline and the tint's edge.
          const bounds = world.getBounds();
          const pad = 8;
          const x0 = Math.max(0, Math.floor(bounds.x - pad));
          const y0 = Math.max(0, Math.floor(bounds.y - pad));
          const x1 = Math.min(tex.width, Math.ceil(bounds.x + bounds.width + pad));
          const y1 = Math.min(tex.height, Math.ceil(bounds.y + bounds.height + pad));
          const ok = bounds.width > 0 && bounds.height > 0 && x1 > x0 && y1 > y0;
          const frame = ok ? new Rectangle(x0, y0, x1 - x0, y1 - y0) : new Rectangle(0, 0, tex.width, tex.height);
          cache.set(keyOf(p), { tex, sub: new Texture({ source: tex.source, frame }), x: frame.x, y: frame.y, used: ++useClock });
          renders++;
        }
      } finally {
        host.overlay.visible = overlayWas;
        pinLayer.visible = pinWas;
        underlayLayer.visible = underWas;
        host.restorePose();
      }
    }
    // One composite per playhead frame and ghost set: when every ghost is cached, draw them once into a single texture and show that.
    const ready = plan.length > 0 && plan.every((p) => cache.has(keyOf(p)));
    if (ready) {
      const ckey = `${host.frame()}|${plan.map((p) => `${p.frame}:${p.side}:${p.alpha.toFixed(3)}`).join(",")}`;
      let comp: Composite | null | undefined = composites.get(ckey);
      if (!comp) comp = buildComposite(ckey, plan, keyOf);
      if (comp) {
        compositeHits++;
        comp.used = ++useClock;
        compSprite.texture = comp.tex;
        compSprite.position.set(comp.x, comp.y);
        compSprite.visible = true;
        for (const g of ghosts) g.visible = false;
        shownTints = comp.tints;
        ghostLayer.visible = true;
        return;
      }
    }
    compSprite.visible = false;
    ensureSprites(plan.length);
    shownTints = plan.map((p) => (onion.style === "outline" ? 0xffffff : p.side < 0 ? ONION_PREV_TINT : ONION_NEXT_TINT));
    ghosts.forEach((s, i) => {
      const p = plan[i];
      const entry = p ? cache.get(keyOf(p)) : undefined;
      s.visible = !!entry;
      if (!p || !entry) return;
      hits++;
      entry.used = ++useClock;
      s.texture = entry.sub;
      s.tint = onion.style === "outline" ? 0xffffff : p.side < 0 ? ONION_PREV_TINT : ONION_NEXT_TINT;
      // A one-pixel-wide edge needs more opacity than a filled ghost to read as the same strength.
      s.alpha = onion.style === "outline" ? Math.min(1, p.alpha * 1.9) : p.alpha;
      s.position.set(entry.x, entry.y);
    });
    ghostLayer.visible = plan.length > 0;
  };

  // Pinned pose A: one sprite on top of the stage, fed by its own render texture.
  const pinLayer = new Container({ label: "pose-a" });
  app.stage.addChild(pinLayer);
  pinLayer.visible = false;
  let pinTarget: RenderTexture | null = null;
  let pinSprite: Sprite | null = null;
  let pinOn = false;

  const renderPin = (): void => {
    if (!pinOn || host.playing() || !host.poseAsPin) {
      pinLayer.visible = false;
      return;
    }
    const w = Math.max(2, Math.round(app.screen.width));
    const h = Math.max(2, Math.round(app.screen.height));
    const res = app.renderer.resolution;
    if (!pinTarget) {
      pinTarget = RenderTexture.create({ width: w, height: h, resolution: res });
      pinSprite = new Sprite(pinTarget);
      pinSprite.tint = PIN_TINT;
      pinSprite.alpha = 0.55;
      pinLayer.addChild(pinSprite);
    } else if (pinTarget.width !== w || pinTarget.height !== h) pinTarget.resize(w, h, res);
    pinLayer.visible = false;
    ghostLayer.visible = false;
    const overlayWas = host.overlay.visible;
    host.overlay.visible = false;
    let ok = false;
    try {
      ok = host.poseAsPin();
      if (ok) app.renderer.render({ container: app.stage, target: pinTarget, clear: true, clearColor: [0, 0, 0, 0] });
    } finally {
      host.overlay.visible = overlayWas;
      host.restorePose();
    }
    ghostLayer.visible = onion.enabled && ghostFrames.length > 0;
    pinLayer.visible = ok;
  };

  // Underlay
  let base: Texture | null = null;
  let frames = 1;
  let textures: Texture[] = [];
  let sprite: Sprite | null = null;
  let opacity = 0.35;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  let shownFrame: number | null = null;
  let url: string | null = null;
  /** True while the sprite shows a texture somebody else owns (it is never destroyed here). */
  let external = false;

  const rebuildTextures = (): void => {
    if (!base) return;
    const w = base.width / frames;
    const h = base.height;
    textures = Array.from({ length: frames }, (_, i) => (frames === 1 ? base! : new Texture({ source: base!.source, frame: new Rectangle(Math.round(i * w), 0, Math.round(w), h) })));
    shownFrame = null;
  };

  const place = (): void => {
    if (!sprite || !sprite.texture) return;
    // A rig mounted after the underlay is added at index 0 (main.ts): the underlay must stay behind it.
    if (world.getChildIndex(underlayLayer) !== 0) world.setChildIndex(underlayLayer, 0);
    const h = sprite.texture.height || 1;
    const k = (FIGURE_HEIGHT * scale) / h;
    sprite.scale.set(k);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(offX, FEET_BELOW + offY);
    sprite.alpha = opacity;
  };

  const updateUnderlay = (): void => {
    if (!sprite || !textures.length) return;
    const frame = ((Math.floor(host.time() * host.fps() + 1e-3) % frames) + frames) % frames;
    if (frame !== shownFrame) {
      shownFrame = frame;
      sprite.texture = textures[frame]!;
    }
    place();
  };

  const clearUnderlay = (): void => {
    external = false;
    sprite?.destroy();
    sprite = null;
    textures = [];
    base = null;
    shownFrame = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };

  return {
    setOnion(o) {
      const n = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
      const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      if (o.enabled !== undefined) onion.enabled = o.enabled;
      if (o.count !== undefined) onion.before = onion.after = n(o.count, 0, MAX_ONION);
      if (o.before !== undefined) onion.before = n(o.before, 0, MAX_ONION);
      if (o.after !== undefined) onion.after = n(o.after, 0, MAX_ONION);
      if (o.mode !== undefined) onion.mode = o.mode === "keys" ? "keys" : "frames";
      if (o.step !== undefined) onion.step = n(o.step, 1, 12);
      if (o.style !== undefined) onion.style = o.style === "outline" ? "outline" : "tint";
      if (o.scope !== undefined) onion.scope = o.scope === "selected" ? "selected" : "all";
      if (o.opacity !== undefined) onion.opacity = c(o.opacity, 0.05, 1);
      if (o.falloff !== undefined) onion.falloff = c(o.falloff, 0, 0.9);
      if (!onion.enabled) ghostLayer.visible = false;
    },
    onionOptions: () => ({ ...onion }),
    renderOnion,
    setPinGhost(on) {
      pinOn = on;
      if (!on) pinLayer.visible = false;
    },
    renderPin,
    updateUnderlay,
    async loadUnderlay(file) {
      clearUnderlay();
      url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      base = Texture.from(img);
      sprite = new Sprite(base);
      underlayLayer.addChild(sprite);
      rebuildTextures();
      updateUnderlay();
    },
    setUnderlay(o) {
      if (o.opacity !== undefined) opacity = Math.max(0, Math.min(1, o.opacity));
      if (o.scale !== undefined) scale = Math.max(0.05, o.scale);
      if (o.x !== undefined) offX = o.x;
      if (o.y !== undefined) offY = o.y;
      if (o.frames !== undefined && Math.round(o.frames) !== frames) {
        frames = Math.max(1, Math.round(o.frames));
        rebuildTextures();
      }
      updateUnderlay();
    },
    clearUnderlay,
    setUnderlaySource(texture) {
      if (!texture) {
        if (external) clearUnderlay();
        return;
      }
      if (!external) clearUnderlay();
      external = true;
      frames = 1;
      textures = [texture];
      shownFrame = null;
      if (!sprite) {
        sprite = new Sprite(texture);
        underlayLayer.addChild(sprite);
      } else sprite.texture = texture;
      place();
    },
    underlayRect() {
      if (!sprite || !sprite.texture) return null;
      const h = sprite.texture.height || 1;
      const k = (FIGURE_HEIGHT * scale) / h;
      const w = (sprite.texture.width || 1) * k;
      const hh = h * k;
      return { x: offX - w / 2, y: FEET_BELOW + offY - hh, w, h: hh, anchorX: offX, anchorY: FEET_BELOW + offY };
    },
    info: () => ({
      onion: { ...onion, count: Math.max(onion.before, onion.after), frames: ghostFrames, ghosts: ghostLayer.visible ? (compSprite.visible ? shownTints.length : ghosts.filter((g) => g.visible).length) : 0, tints: ghostLayer.visible ? (compSprite.visible ? shownTints : ghosts.filter((g) => g.visible).map((g) => g.tint as number)) : [], cached: cache.size, renders, hits, composites: composites.size, compositeMB: +(compositeBytes / 1048576).toFixed(1), compositeHits, compositeBuilds },
      underlay: { loaded: !!sprite, frames, frame: shownFrame, opacity, scale, x: offX, y: offY },
      pin: { on: pinOn, visible: pinLayer.visible, tint: PIN_TINT }
    })
  };
}
