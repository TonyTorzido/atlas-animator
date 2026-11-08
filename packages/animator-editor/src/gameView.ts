/*
 * Atlas Animator editor: original implementation.
 *
 * Game view: the clip being edited shown the way the project shows a swing. The character is drawn through the project's own
 * AnimatorCharacter at the phone scales (0.4, 0.471) and 1x, on a ground colour with a shadow under the feet, a
 * training post at weapon range, the slash trail along the weapon tip between the clip's trailOn / trailOff events,
 * and on the `hit` event the client's hit-stop, flash, red tint, push and impact spark (gameViewModel.ts, which calls
 * src/preview). The backing store uses the preview render resolution (full DPR; preview/renderQuality.ts).
 * It plays on its own clock (loop, or once), optionally with the walk underneath; paused, it follows the editor's playhead.
 */
import { AnimationState, BoneMask, type AnimDocument, type Bone, type ClipData, type Skeleton } from "@atlas-animator/core/core";
import type { AnimatorCharacter } from "@atlas-animator/core/pixi";
import { Container, Graphics, RenderTexture, type Application } from "pixi.js";
import { IMPACT_SLASH_MS } from "./preview/hitFeedback.js";
import { isReducedRenderQualityEnabled } from "./preview/renderQuality.js";
import { overlayRendererResolution } from "./preview/renderQuality.js";
import { compileClips, presetRoots } from "./trackModel.js";
import { frameTime, heldTime } from "./clipModel.js";
import {
  ATTACKER,
  cellSize,
  DUMMY_HALF_WIDTH,
  GAME_SCALES,
  GROUNDS,
  GameClock,
  LOOP_REST_S,
  cellView,
  dummyPlacement,
  hitLook,
  msSinceHit,
  reachFrame,
  ribbonOutline,
  shownTime,
  trailPoints,
  type BiomeGround,
  type GameScale,
  type Placement,
  type Step,
  type TrailPoint
} from "./gameViewModel.js";

export interface GameViewHost {
  app: Application;
  world: Container;
  viewEl: HTMLElement;
  character(): AnimatorCharacter | null;
  skeleton(): Skeleton | null;
  doc(): AnimDocument | null;
  rigId(): string;
  clipName(): string;
  clip(): ClipData;
  /** Every editable clip by name, the edited one as it is now. */
  clips(): Record<string, ClipData>;
  /** The editor's playhead (held), used while the project view is paused. */
  editorTime(): number;
  /** Poses the skeleton back to the editor's own pose (the project view poses it for its own frames). */
  restorePose(): void;
}

export interface GameViewOptions {
  scales: GameScale[];
  loop: boolean;
  walkUnder: boolean;
  mirror: boolean;
  dummy: boolean;
  trail: boolean;
  ground: string;
}

export interface GameView {
  toggle(open?: boolean): void;
  isOpen(): boolean;
  /** The editor's clip, playhead, rig or pose changed: redraw (paused) or keep playing with the new clip. */
  refresh(): void;
  play(on?: boolean): boolean;
  /** Starts the clip again from its first frame (clears hit-stop and effects). */
  replay(): void;
  /** Deterministic: restarts the cycle and steps the project clock in 1/60 s steps to `seconds` into it, then draws and pauses there. */
  seek(seconds: number): void;
  setOptions(patch: Partial<GameViewOptions>): GameViewOptions;
  info(): Record<string, unknown>;
}

/** Speckle layout of the ground, deterministic so a screenshot repeats. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function buildGround(g: Graphics, biome: BiomeGround): void {
  g.clear();
  g.rect(-1600, -1400, 3200, 2600).fill({ color: biome.ground });
  const rand = lcg(7);
  for (const [color, count] of [[biome.dark, 360], [biome.light, 220]] as const) {
    for (let i = 0; i < count; i++) {
      const x = -1500 + rand() * 3000;
      const y = -1300 + rand() * 2400;
      const h = 16 + rand() * 14;
      for (const dx of [-7, 0, 7]) g.moveTo(x + dx, y).lineTo(x + dx * 1.6, y - h * (dx === 0 ? 1 : 0.7));
    }
    g.stroke({ color, width: 5, alpha: 0.85 });
  }
}

const OUTLINE = 0x3a1001;
const WOOD = 0x8a5a2b;
const STRAW = 0xc9a24a;

/** The training post, feet at (0, 0), about 420 rig px tall, facing the viewer. */
export function drawDummy(g: Graphics, flat?: number): void {
  const fill = (c: number) => (flat ?? c);
  const line = flat === undefined ? { color: OUTLINE, width: 8, join: "round" as const } : undefined;
  const shape = (draw: () => void, color: number): void => {
    draw();
    g.fill({ color: fill(color) });
    if (line) {
      draw();
      g.stroke(line);
    }
  };
  shape(() => g.roundRect(-22, -330, 44, 330, 6), WOOD);
  shape(() => g.roundRect(-96, -330, 192, 34, 8), WOOD);
  shape(() => g.roundRect(-DUMMY_HALF_WIDTH, -400, DUMMY_HALF_WIDTH * 2, 230, 26), STRAW);
  shape(() => g.circle(0, -452, 44), STRAW);
  if (flat === undefined) {
    g.circle(0, -452, 26).stroke({ color: 0xb8322a, width: 9 });
    g.circle(0, -452, 8).fill({ color: 0xb8322a });
  }
}

/** Where the weapon tip is on the posed skeleton (skeleton space), or null when the rig has no weapon or hand to follow. */
export function findTip(sk: Skeleton, doc: Pick<AnimDocument, "skins">): (() => { x: number; y: number }) | null {
  const tipBone = sk.findBone("weapon_tip");
  if (tipBone) return () => ({ x: tipBone.world.x, y: tipBone.world.y });
  const slot = sk.findSlot("weapon_tip");
  if (slot) {
    let att = slot.attachment?.type === "point" ? slot.attachment : undefined;
    if (!att) {
      for (const skin of Object.values(doc.skins)) {
        const found = Object.keys(skin.attachments["weapon_tip"] ?? {}).map((n) => sk.getAttachment(slot, n)).find((a) => a?.type === "point");
        if (found?.type === "point") att = found;
      }
    }
    if (att) {
      const point = att;
      return () => {
        const p = slot.bone.localToWorld(point.x, point.y, { x: 0, y: 0 });
        return { x: p.x, y: p.y };
      };
    }
  }
  const end = (bone: Bone) => () => {
    const p = bone.localToWorld(bone.data.length, 0, { x: 0, y: 0 });
    return { x: p.x, y: p.y };
  };
  const weapon = sk.findBone("weapon");
  if (weapon) return end(weapon);
  for (const name of ["hand_near", "hand_r", "hand_l"]) {
    const hand = sk.findBone(name);
    if (hand) return end(hand);
  }
  return null;
}

/** The clip that plays under the edited one: walk_in_place, else any other clip with "walk" in its name. */
export function walkClipName(clips: Readonly<Record<string, unknown>>, edited: string): string | null {
  const names = Object.keys(clips).filter((n) => n !== edited);
  return names.find((n) => n === "walk_in_place") ?? names.find((n) => /walk/i.test(n)) ?? null;
}

/** The bones the edited clip keeps while the walk plays under it: the torso and up, the arms, hand targets and the weapon. */
export function upperBodyBones(doc: Pick<AnimDocument, "bones">): string[] {
  const roots = [...presetRoots(doc, "upper"), ...presetRoots(doc, "arms")];
  for (const b of doc.bones) if (/^(weapon|offhand)/.test(b.name) || /^hand_.*target$/.test(b.name) || b.name === "lean") roots.push(b.name);
  return [...new Set(roots)];
}

interface Metrics {
  feetY: number;
  figureHeight: number;
}

interface PoseKey {
  doc: AnimDocument;
  clip: ClipData;
  walk: ClipData | null;
}

export function createGameView(host: GameViewHost): GameView {
  const opt: GameViewOptions = { scales: [0.4, 0.471, 1], loop: true, walkUnder: false, mirror: false, dummy: true, trail: true, ground: "grass" };
  let open = false;
  let playing = true;
  let lastRaf = 0;
  let rafId = 0;
  let clock = new GameClock();
  let lastStep: Step | null = null;
  let lastDrawKey = "";
  let drawnFrames = 0;
  let walkBase = 0;
  let lastClipName = "";
  let fires = { hit: 0, trailOn: 0, trailOff: 0, held: 0 };
  let facing: -1 | 1 = 1;
  let trailCount = 0;
  let placement: Placement = { side: 1, x: 300 };
  let lastTip: { x: number; y: number } | null = null;
  let lastLook = hitLook(Number.NaN);
  let lastError = "";

  // --- scene layers inside the editor's world container --------------------------------------------------------------
  const back = new Container({ label: "gameview-back" });
  const front = new Container({ label: "gameview-front" });
  const groundG = new Graphics();
  const shadowG = new Graphics();
  const dummy = new Container({ label: "gameview-dummy" });
  const dummyShadow = new Graphics();
  const dummyBody = new Graphics();
  const dummyFlash = new Graphics();
  dummyFlash.blendMode = "add";
  drawDummy(dummyBody);
  drawDummy(dummyFlash, 0xffffff);
  dummy.addChild(dummyShadow, dummyBody, dummyFlash);
  const trailG = new Graphics();
  const sparkG = new Graphics();
  back.addChild(groundG, shadowG, dummy);
  front.addChild(trailG, sparkG);
  dummyShadow.ellipse(0, 0, 105, 26).fill({ color: 0x000000, alpha: 0.3 });
  let builtGround = "";

  // --- panel ---------------------------------------------------------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "gameview";
  panel.className = "hud";
  panel.style.cssText = "display:none;right:10px;top:52px;flex-direction:column;align-items:stretch;z-index:6;max-width:calc(100% - 20px);max-height:calc(100% - 64px);overflow:auto;background:rgba(20,23,29,0.94)";
  const head = document.createElement("div");
  head.className = "pvhead";
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { title?: string }, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  };
  const toggle = (id: string, label: string, title: string, checked: boolean, on: (v: boolean) => void): HTMLLabelElement => {
    const input = mk("input", { type: "checkbox", id, checked });
    input.addEventListener("change", () => on(input.checked));
    return mk("label", { title, style: "display:flex;gap:3px;align-items:center;font-size:12px" } as never, input, label);
  };
  const playBtn = mk("button", { id: "gv-play", textContent: "Pause", title: "Play / pause the project view on its own clock (paused, it follows the editor's playhead)" });
  const replayBtn = mk("button", { id: "gv-replay", textContent: "Replay", title: "Start the clip again" });
  const groundSel = mk("select", { id: "gv-ground", title: "Ground" });
  for (const g of GROUNDS) groundSel.append(mk("option", { value: g.id, textContent: g.label }));
  const walkLabel = toggle("gv-walk", "Walk under", "Play the walk under the clip: the walk drives the legs and body, the clip the torso, arms and weapon", opt.walkUnder, (v) => setOptions({ walkUnder: v }));
  head.append(
    mk("span", { className: "label", textContent: "Game view" }),
    playBtn,
    replayBtn,
    toggle("gv-loop", "Loop", "Repeat the clip with a short rest; off plays it once and holds the last frame", opt.loop, (v) => setOptions({ loop: v })),
    walkLabel,
    toggle("gv-mirror", "Mirror", "Face the other way (the target stands on the other side)", opt.mirror, (v) => setOptions({ mirror: v })),
    toggle("gv-dummy", "Target", "Training post at weapon range; flashes on the hit event", opt.dummy, (v) => setOptions({ dummy: v })),
    toggle("gv-trail", "Trail", "Slash trail between trailOn and trailOff", opt.trail, (v) => setOptions({ trail: v })),
    groundSel
  );
  const sizeRow = mk("div", { className: "pvhead" });
  for (const s of GAME_SCALES) sizeRow.append(toggle(`gv-size-${s}`, s === 1 ? "1x close-up" : `${s}`, `Show the ${s} size`, opt.scales.includes(s), (v) => setOptions({ scales: GAME_SCALES.filter((x) => (x === s ? v : opt.scales.includes(x))) })));
  const infoEl = mk("span", { className: "label", id: "gv-info" });
  sizeRow.append(infoEl);
  const row = mk("div", { className: "pvrow", style: "flex-wrap:wrap" } as never);
  panel.append(head, sizeRow, row);
  const cells = new Map<GameScale, { cell: HTMLElement; canvas: HTMLCanvasElement }>();
  for (const s of GAME_SCALES) {
    const [w, h] = cellSize(s, 1000);
    const canvas = mk("canvas", { id: `gameview-${s}` });
    canvas.style.cssText = `width:${w}px;height:${h}px;display:block;border:1px solid var(--line)`;
    const cell = mk("div", { className: "pvcell" }, mk("div", { className: "label", textContent: s === 1 ? "1x" : `${s}` }), canvas);
    row.append(cell);
    cells.set(s, { cell, canvas });
  }
  // The panel takes the phone dock's column while open (workspace.css, #app.gvopen), so it never sits over the posing canvas.
  const appEl = host.viewEl.closest("#app") ?? host.viewEl;
  appEl.append(panel);

  // --- posing --------------------------------------------------------------------------------------------------------
  let stateKey: PoseKey | null = null;
  let stateData: ReturnType<typeof compileClips> | null = null;
  let mask: BoneMask | null = null;
  let metricsFor: AnimatorCharacter | null = null;
  let metrics: Metrics = { feetY: 262, figureHeight: 1000 };
  let tipFn: (() => { x: number; y: number }) | null = null;
  let tipFor: Skeleton | null = null;
  const poseCache = new Map<string, { tip: { x: number; y: number } | null; body: number }>();
  let poseCacheKey = "";

  const walkClip = (): ClipData | null => {
    if (!opt.walkUnder) return null;
    const clips = host.clips();
    const name = walkClipName(clips, host.clipName());
    return name ? (clips[name] ?? null) : null;
  };

  const ensureState = (doc: AnimDocument, clip: ClipData, walk: ClipData | null): void => {
    if (stateKey && stateKey.doc === doc && stateKey.clip === clip && stateKey.walk === walk && stateData) return;
    const clips = { ...host.clips(), [host.clipName()]: clip };
    stateData = compileClips(doc, clips);
    stateKey = { doc, clip, walk };
    mask = walk ? (upperBodyBones(doc).length ? BoneMask.of(doc, upperBodyBones(doc)) : null) : null;
    poseCache.clear();
  };

  /** Poses the skeleton (world transform included) at clip time `clipT` and walk time `walkT`. */
  const poseSkeleton = (clipT: number, walkT: number): void => {
    const sk = host.skeleton();
    const doc = host.doc();
    const clip = host.clip();
    if (!sk || !doc || !stateData) return;
    const state = new AnimationState(stateData);
    const walk = stateKey?.walk ?? null;
    const walkName = walk ? walkClipName(host.clips(), host.clipName()) : null;
    if (walk && walkName) {
      const base = state.setAnimation(0, walkName, { loop: true });
      base.trackTime = walkT;
      const top = state.setAnimation(1, host.clipName(), { loop: false });
      top.trackTime = Math.min(clipT, clip.duration);
      state.setTrackMask(1, mask);
    } else {
      const entry = state.setAnimation(0, host.clipName(), { loop: clip.loop });
      entry.trackTime = clip.loop ? Math.min(clipT, Math.max(0, clip.duration - 1e-4)) : Math.min(clipT, clip.duration);
    }
    state.update(0);
    state.apply(sk);
    sk.updateWorldTransform();
  };

  const bodyX = (sk: Skeleton): number => (sk.findBone("pelvis") ?? sk.findBone("root"))?.world.x ?? 0;

  /** Tip and body x at a clip frame (cached while the clip, rig and walk phase stay the same). */
  const sample = (frame: number, walkOffset: number): { tip: { x: number; y: number } | null; body: number } => {
    const clip = host.clip();
    const key = `${frame}|${walkOffset.toFixed(4)}`;
    const hit = poseCache.get(key);
    if (hit) return hit;
    const t = frameTime(clip, frame);
    poseSkeleton(t, walkOffset + t);
    const sk = host.skeleton()!;
    const out = { tip: tipFn ? tipFn() : null, body: bodyX(sk) };
    poseCache.set(key, out);
    return out;
  };

  const measure = (): void => {
    const ch = host.character();
    const sk = host.skeleton();
    if (!ch || !sk || metricsFor === ch) return;
    metricsFor = ch;
    sk.setToSetupPose();
    ch.update();
    const b = ch.getLocalBounds();
    const height = b.maxY - b.minY;
    metrics = Number.isFinite(height) && height > 50 ? { feetY: b.maxY, figureHeight: height } : { feetY: 262, figureHeight: 1000 };
  };

  // --- drawing -------------------------------------------------------------------------------------------------------
  const drawFx = (s: GameScale, shown: number, walkOffset: number, sinceHitMs: number): void => {
    const clip = host.clip();
    const k = 1 / s;
    const { feetY } = metrics;
    const biome = GROUNDS.find((g) => g.id === opt.ground) ?? GROUNDS[0]!;
    if (builtGround !== biome.id) {
      buildGround(groundG, biome);
      builtGround = biome.id;
    }
    const sk = host.skeleton()!;
    const cx = bodyX(sk);
    shadowG.clear().ellipse(cx, feetY, 150, 36).fill({ color: 0x000000, alpha: 0.3 });
    const look = hitLook(sinceHitMs);
    lastLook = look;
    dummy.visible = opt.dummy;
    dummy.scale.set(dummyScale());
    // Push away from the attacker, in screen px (constant on screen at every size).
    dummy.position.set(placement.x + placement.side * look.pushPx * k, feetY);
    dummy.tint = look.tint;
    dummyFlash.alpha = look.flash;
    trailG.clear();
    sparkG.clear();
    if (opt.trail) {
      const pts = trailPoints(clip, shown, (f) => sample(f, walkOffset).tip);
      trailCount = pts.length;
      const byWindow = new Map<number, TrailPoint[]>();
      for (const p of pts) byWindow.set(p.window, [...(byWindow.get(p.window) ?? []), p]);
      for (const list of byWindow.values()) {
        if (list.length < 2) continue;
        const { left, right } = ribbonOutline(list, 11 * k);
        for (let i = 0; i + 1 < list.length; i++) {
          const a = (list[i]!.alpha + list[i + 1]!.alpha) / 2;
          trailG.poly([...left[i]!, ...left[i + 1]!, ...right[i + 1]!, ...right[i]!]).fill({ color: 0xe8f2ff, alpha: 0.7 * 0.55 * a });
          trailG.moveTo(list[i]!.x, list[i]!.y).lineTo(list[i + 1]!.x, list[i + 1]!.y).stroke({ color: 0xffffff, width: 3 * k, alpha: 0.95 * 0.7 * a });
        }
      }
    } else trailCount = 0;
    if (opt.dummy && look.sparkProgress < 1) {
      // The client's impact: a 4-point star for the first third, rays, and a slash mark square to the swing.
      const side = placement.side;
      const cxs = placement.x - side * DUMMY_HALF_WIDTH * dummyScale() * 0.8;
      const cys = feetY - 250 * dummyScale();
      const p = look.sparkProgress;
      if (p < 0.35) {
        const burst = p / 0.35;
        const outer = (9 + 8 * burst) * k;
        const inner = outer * 0.3;
        sparkG
          .poly([cxs, cys - outer, cxs + inner, cys - inner, cxs + outer, cys, cxs + inner, cys + inner, cxs, cys + outer, cxs - inner, cys + inner, cxs - outer, cys, cxs - inner, cys - inner])
          .fill({ color: 0xffffff, alpha: 1 - burst * burst });
      }
      const near = (4 + 8 * p) * k;
      const far = (12 + 16 * p) * k;
      for (let ray = 0; ray < 8; ray++) {
        const a = (ray / 8) * Math.PI * 2 + 0.2;
        sparkG.moveTo(cxs + Math.cos(a) * near, cys + Math.sin(a) * near).lineTo(cxs + Math.cos(a) * far, cys + Math.sin(a) * far);
      }
      sparkG.stroke({ color: 0xffe9a8, width: 2 * k, alpha: 1 - p });
      const slash = sinceHitMs / IMPACT_SLASH_MS;
      if (slash < 1) {
        const len = 30 * k * Math.min(1, slash * 3);
        const ux = 0.35 * side;
        sparkG.moveTo(cxs - ux * len * 0.5, cys - len * 0.5).lineTo(cxs + ux * len * 0.5, cys + len * 0.5).stroke({ color: 0xffffff, width: 3 * k * (1 - slash * 0.6), alpha: 1 - slash * slash });
      }
    }
  };

  /** The post is about half the figure's height, so it reads as a mob next to the player at the project's scales. */
  const dummyScale = (): number => Math.max(0.6, (metrics.figureHeight * 0.5) / 450);

  const resolution = (): number => overlayRendererResolution();
  const targets = new Map<GameScale, { rt: RenderTexture; res: number }>();

  /** Rig px the body and the target cover side by side (the cells widen to show both). */
  const spanRig = (): number => (opt.dummy ? Math.abs(placement.x - bodyX(host.skeleton()!)) + DUMMY_HALF_WIDTH * dummyScale() + 200 : 0);

  /** Camera centre (skeleton x): phone sizes frame the body and the target together, the 1x close-up the contact point. */
  const centreFor = (s: GameScale): number => {
    const body = bodyX(host.skeleton()!);
    if (!opt.dummy) return body;
    if (s === 1) return placement.x - placement.side * DUMMY_HALF_WIDTH * dummyScale();
    return (body + placement.x) / 2;
  };

  const renderCells = (shown: number, walkOffset: number, sinceHitMs: number): void => {
    const { app, world } = host;
    const res = resolution();
    const stageKids = app.stage.children.map((c) => [c, c.visible] as const);
    const worldKids = world.children.map((c) => [c, c.visible] as const);
    const ch = host.character();
    const savedFilters = ch?.filters ? [...(ch.filters as readonly never[])] : [];
    const saved = { x: world.position.x, y: world.position.y, sx: world.scale.x, sy: world.scale.y };
    try {
      for (const [c] of stageKids) c.visible = c === world;
      world.addChildAt(back, 0);
      world.addChild(front);
      for (const [c] of worldKids) c.visible = c === ch;
      back.visible = true;
      front.visible = true;
      if (ch) ch.filters = [];
      const biome = GROUNDS.find((g) => g.id === opt.ground) ?? GROUNDS[0]!;
      for (const s of GAME_SCALES) {
        const entry = cells.get(s)!;
        entry.cell.style.display = opt.scales.includes(s) ? "" : "none";
        if (!opt.scales.includes(s)) continue;
        const [w, h] = cellSize(s, metrics.figureHeight, spanRig());
        entry.canvas.style.width = `${w}px`;
        entry.canvas.style.height = `${h}px`;
        let target = targets.get(s);
        if (!target || target.res !== res) {
          target?.rt.destroy(true);
          target = { rt: RenderTexture.create({ width: w, height: h, resolution: res }), res };
          targets.set(s, target);
        }
        drawFx(s, shown, walkOffset, sinceHitMs);
        const view = cellView(s, metrics.feetY, metrics.figureHeight, centreFor(s), opt.mirror, spanRig());
        world.scale.set(view.scale * (opt.mirror ? -1 : 1), view.scale);
        world.position.set(view.x, view.y);
        app.renderer.render({ container: app.stage, target: target.rt, clear: true, clearColor: biome.ground });
        const out = app.renderer.extract.canvas(target.rt) as unknown as CanvasImageSource;
        const canvas = entry.canvas;
        if (canvas.width !== w * res || canvas.height !== h * res) {
          canvas.width = w * res;
          canvas.height = h * res;
        }
        const g = canvas.getContext("2d")!;
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.drawImage(out, 0, 0);
      }
    } finally {
      world.position.set(saved.x, saved.y);
      world.scale.set(saved.sx, saved.sy);
      for (const [c, v] of stageKids) c.visible = v;
      for (const [c, v] of worldKids) c.visible = v;
      back.visible = false;
      front.visible = false;
      if (ch) ch.filters = savedFilters;
    }
  };

  /** Draws one frame: `t` seconds into the clip (sampled, before holding), `walkOffset` seconds the walk is ahead of the clip. */
  const draw = (t: number, walkOffset: number, sinceHitMs: number): void => {
    const doc = host.doc();
    const sk = host.skeleton();
    const ch = host.character();
    const clip = host.clip();
    if (!doc || !sk || !ch || !host.clipName()) return;
    try {
      measure();
      if (tipFor !== sk) {
        tipFor = sk;
        tipFn = findTip(sk, doc);
        poseCache.clear();
      }
      const walk = walkClip();
      ensureState(doc, clip, walk);
      const key = `${host.rigId()}|${host.clipName()}|${walkOffset.toFixed(4)}|${walk ? 1 : 0}`;
      if (key !== poseCacheKey) {
        poseCacheKey = key;
        poseCache.clear();
      }
      const shown = shownTime(clip, t);
      // Dummy: at the weapon's reach on the hit frame (or mid-trail), on the side the weapon swings to.
      const reach = sample(reachFrame(clip), walkOffset);
      if (reach.tip) {
        placement = dummyPlacement(reach.body, reach.tip.x, DUMMY_HALF_WIDTH * dummyScale());
        facing = placement.side;
      }
      // Trail points are sampled inside drawFx (they pose the skeleton), so the final pose comes after a dry run of it.
      if (opt.trail) trailPoints(clip, shown, (f) => sample(f, walkOffset).tip);
      poseSkeleton(shown, walkOffset + shown);
      ch.update();
      lastTip = tipFn ? tipFn() : null;
      // The trail draws from cached samples now; the final pose stays on the character for the render.
      renderCells(shown, walkOffset, sinceHitMs);
      drawnFrames += 1;
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error("game view failed", error);
    } finally {
      host.restorePose();
    }
    updateInfo(t);
  };

  const updateInfo = (t: number): void => {
    const clip = host.clip();
    const frameIx = Math.round(shownTime(clip, t) * (clip.fps ?? 30));
    infoEl.textContent = `${host.clipName()} frame ${frameIx}  facing ${facing > 0 ? "right" : "left"}${opt.mirror ? " (mirrored)" : ""}  ${resolution()}x${isReducedRenderQualityEnabled() ? " low" : ""}${lastStep?.held ? "  HIT-STOP" : ""}`;
  };

  // --- playback ------------------------------------------------------------------------------------------------------
  const frameKeyOf = (clip: ClipData, t: number): number => Math.floor(heldTime(clip, t) * (clip.fps ?? 30) + 0.5);

  const noteFired = (step: Step): void => {
    for (const e of step.fired) {
      if (e.name === "hit") fires.hit += 1;
      else if (e.name === "trailOn") fires.trailOn += 1;
      else if (e.name === "trailOff") fires.trailOff += 1;
    }
    if (step.held) fires.held += 1;
  };

  const advance = (dtMs: number): void => {
    const clip = host.clip();
    if (host.clipName() !== lastClipName) {
      lastClipName = host.clipName();
      clock = new GameClock();
      walkBase = 0;
    }
    const step = clock.step(dtMs, clip, opt.loop);
    if (step.restarted) walkBase += clip.duration + LOOP_REST_S;
    lastStep = step;
    noteFired(step);
    const fx = Number.isFinite(step.sinceHitMs) && step.sinceHitMs < 500;
    const key = `${frameKeyOf(clip, step.t)}|${step.restarted ? 1 : 0}`;
    if (!fx && key === lastDrawKey && !step.held) return;
    lastDrawKey = key;
    draw(step.t, walkBase + (step.cycleT - step.t), step.sinceHitMs);
  };

  const tick = (now: number): void => {
    rafId = open ? requestAnimationFrame(tick) : 0;
    const dt = lastRaf ? Math.min(100, now - lastRaf) : 16;
    lastRaf = now;
    if (!open || !playing) return;
    try {
      advance(dt);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  };

  const renderPaused = (): void => {
    const clip = host.clip();
    const t = Math.min(clip.duration, host.editorTime());
    const since = msSinceHit(clip, t);
    lastStep = null;
    draw(t, 0, since);
  };

  const refresh = (): void => {
    if (!open) return;
    if (!playing) renderPaused();
    // Playing: the next tick draws the edited clip as it is now; a new clip name restarts the cycle there.
    else {
      lastDrawKey = "";
      stateKey = null;
      poseCache.clear();
    }
  };

  function setOptions(patch: Partial<GameViewOptions>): GameViewOptions {
    Object.assign(opt, patch);
    if (patch.scales) opt.scales = [...patch.scales];
    stateKey = null;
    poseCache.clear();
    lastDrawKey = "";
    if (patch.mirror !== undefined || patch.loop !== undefined) lastDrawKey = "";
    // The controls follow a patch made through the API.
    const set = (id: string, v: boolean) => {
      const input = panel.querySelector<HTMLInputElement>(`[id="${id}"]`);
      if (input) input.checked = v;
    };
    set("gv-loop", opt.loop);
    set("gv-walk", opt.walkUnder);
    set("gv-mirror", opt.mirror);
    set("gv-dummy", opt.dummy);
    set("gv-trail", opt.trail);
    for (const s of GAME_SCALES) set(`gv-size-${s}`, opt.scales.includes(s));
    groundSel.value = opt.ground;
    if (open) {
      if (playing) lastDrawKey = "";
      else renderPaused();
    }
    return { ...opt, scales: [...opt.scales] };
  }

  function play(on?: boolean): boolean {
    playing = on ?? !playing;
    playBtn.textContent = playing ? "Pause" : "Play";
    if (playing) {
      lastDrawKey = "";
    } else if (open) renderPaused();
    return playing;
  }

  function replay(): void {
    clock = new GameClock();
    walkBase = 0;
    lastClipName = host.clipName();
    lastDrawKey = "";
    fires = { hit: 0, trailOn: 0, trailOff: 0, held: 0 };
    if (open && !playing) play(true);
  }

  function seek(seconds: number): void {
    if (!open) return;
    playing = false;
    playBtn.textContent = "Play";
    replay();
    playing = false;
    lastClipName = host.clipName();
    const stepMs = 1000 / 60;
    let last: Step | null = null;
    for (let ms = 0; ms < seconds * 1000 - 1e-6; ms += stepMs) {
      last = clock.step(stepMs, host.clip(), opt.loop);
      if (last.restarted) walkBase += host.clip().duration + LOOP_REST_S;
      noteFired(last);
    }
    if (!last) last = clock.step(0, host.clip(), opt.loop);
    lastStep = last;
    draw(last.t, walkBase + (last.cycleT - last.t), last.sinceHitMs);
  }

  playBtn.addEventListener("click", () => play());
  replayBtn.addEventListener("click", () => replay());
  groundSel.addEventListener("change", () => setOptions({ ground: groundSel.value }));

  return {
    toggle(next) {
      open = next ?? !open;
      panel.style.display = open ? "flex" : "none";
      appEl.classList.toggle("gvopen", open);
      if (open) {
        lastRaf = 0;
        lastDrawKey = "";
        if (!rafId) rafId = requestAnimationFrame(tick);
        if (!playing) renderPaused();
      }
    },
    isOpen: () => open,
    refresh,
    play,
    replay,
    seek,
    setOptions,
    info: () => ({
      open,
      playing,
      options: { ...opt, scales: [...opt.scales] },
      scales: GAME_SCALES,
      sizes: Object.fromEntries(GAME_SCALES.map((s) => [s, cellSize(s, metrics.figureHeight, spanRig())])),
      resolution: resolution(),
      reducedQuality: isReducedRenderQualityEnabled(),
      facing: facing > 0 ? "right" : "left",
      tip: lastTip,
      dummy: { x: placement.x, side: placement.side, flash: lastLook.flash, pushPx: lastLook.pushPx, tint: lastLook.tint, sparkProgress: lastLook.sparkProgress },
      step: lastStep,
      trailPoints: trailCount,
      walkClip: walkClipName(host.clips(), host.clipName()),
      walkActive: !!stateKey?.walk,
      fired: { ...fires },
      drawnFrames,
      attacker: ATTACKER,
      error: lastError
    })
  };
}
