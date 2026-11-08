/*
 * Atlas Animator editor: the phone page of "Phone preview" (see phoneLive.ts). Read-only: it polls the editor's current clip and rig
 * from /phone/<token>/state, draws the character through the project's own AnimatorCharacter at the project's draw scale (0.4 / 0.471
 * CSS px per rig px, full device resolution) on the project's grass, and loops the clip. Tap the ground to pause; the bar has a facing
 * toggle (right = the same left-facing character mirrored, src/facing.ts) and a scale toggle. It never sends anything to the editor.
 */
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { AnimatorCharacter, chainImages, DynamicAtlas, loadPackedAtlas, separateImages, type PartImageProvider, type RgbaImage } from "@atlas-animator/core/pixi";
import { Application, Container, Graphics } from "pixi.js";
import { withEventDefs } from "./eventModel.js";
import { STAND_IN_PATH, standInAxePixels, withStandInWeapon } from "./standInWeapon.js";
import { loopTime, nextScale, PHONE_GRASS, PHONE_POLL_MS, phoneLayout, PHONE_SCALES, tokenFromPath } from "./phoneModel.js";

interface RigMeta {
  document: string;
  atlas: string;
  standIn: boolean;
  skins: string[];
}
interface PhoneState {
  rev: number;
  rigRev: number;
  waiting?: boolean;
  clipName?: string;
  clip?: ClipData;
  facing?: "left" | "right";
  rigMeta?: RigMeta | null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const token = tokenFromPath(location.pathname);
const base = `/phone/${token}`;
const clientId = Math.random().toString(36).slice(2, 10);

const app = new Application();
const ground = new Graphics();
const shadow = new Graphics();
const stage = new Container();
const retired: { node: AnimatorCharacter; atlas: DynamicAtlas; ticks: number }[] = [];

let character: AnimatorCharacter | null = null;
let atlas: DynamicAtlas | null = null;
let skeleton: Skeleton | null = null;
let doc: AnimDocument | null = null;
let stateData: AnimationStateData | null = null;
let clip: ClipData | null = null;
let clipName = "";
let facing: "left" | "right" = "left";
let facingTouched = false;
let scale: number = PHONE_SCALES[0];
let paused = false;
let elapsed = 0;
let feetY = 262;
let rev = -1;
let rigRev = -1;
let lastOk = 0;
let rigLoading = false;
const atlasCache = new Map<string, Promise<PartImageProvider>>();

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The game's grass: a flat ground colour with deterministic dark and light blades. */
function drawGround(w: number, h: number): void {
  ground.clear();
  ground.rect(0, 0, w, h).fill({ color: PHONE_GRASS.ground });
  const rand = lcg(7);
  for (const [color, count] of [[PHONE_GRASS.dark, 160], [PHONE_GRASS.light, 100]] as const) {
    for (let i = 0; i < count; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const bh = 6 + rand() * 7;
      for (const dx of [-3, 0, 3]) ground.moveTo(x + dx, y).lineTo(x + dx * 1.6, y - bh * (dx === 0 ? 1 : 0.7));
    }
    ground.stroke({ color, width: 2, alpha: 0.85 });
  }
}

function place(): void {
  const w = app.screen.width;
  const h = app.screen.height;
  drawGround(w, h);
  const at = phoneLayout(w, h, feetY, scale);
  shadow.clear();
  shadow.ellipse(0, 0, 150 * scale, 38 * scale).fill({ color: 0x000000, alpha: 0.28 });
  shadow.position.set(at.x, at.groundY);
  if (character) {
    character.position.set(at.x, at.charY);
    character.scale.set((facing === "right" ? -1 : 1) * scale, scale);
  }
  $("scale").textContent = String(scale);
  $("face").textContent = `Facing: ${facing}`;
}

function note(text: string): void {
  $("note").textContent = text;
}

function recompile(): void {
  if (!doc || !clip || !clipName) {
    stateData = null;
    return;
  }
  // The runtime ties a state to the exact document object its skeleton was built from.
  const own = doc.animations;
  doc.animations = { [clipName]: clip };
  try {
    stateData = new AnimationStateData(new AnimationLibrary(doc));
  } finally {
    doc.animations = own;
  }
}

async function loadImages(meta: RigMeta, extra: Map<string, RgbaImage>): Promise<PartImageProvider> {
  let packed = atlasCache.get(meta.atlas);
  if (!packed) {
    packed = loadPackedAtlas(`${base}/repo/${meta.atlas}`);
    atlasCache.set(meta.atlas, packed);
    packed.catch(() => atlasCache.delete(meta.atlas));
  }
  return chainImages(separateImages(extra), await packed);
}

async function loadRig(meta: RigMeta): Promise<void> {
  const raw = (await (await fetch(`${base}/rig`, { cache: "no-store" })).json()) as unknown;
  const json = meta.standIn ? withStandInWeapon(raw) : raw;
  const next = withEventDefs(loadAnimDocument(structuredClone(json), { source: meta.document }));
  const extra = new Map<string, RgbaImage>();
  if (meta.standIn) extra.set(STAND_IN_PATH, standInAxePixels());
  const images = await loadImages(meta, extra);
  const sk = new Skeleton(next);
  if (meta.skins.length) sk.setActiveSkins(meta.skins);
  const at = new DynamicAtlas({ pageSize: 1024 });
  const ch = new AnimatorCharacter({ skeleton: sk, atlas: at, images });
  if (character && atlas) {
    stage.removeChild(character);
    retired.push({ node: character, atlas, ticks: 2 });
  }
  stage.addChild(ch);
  sk.setToSetupPose();
  ch.update();
  const b = ch.getLocalBounds();
  const height = b.maxY - b.minY;
  feetY = Number.isFinite(height) && height > 50 ? b.maxY : 262;
  character = ch;
  atlas = at;
  skeleton = sk;
  doc = next;
  recompile();
  place();
}

/** Poses the skeleton at `t` seconds into the looping clip. */
function pose(t: number): void {
  if (!skeleton || !stateData || !character || !clip || !clipName) return;
  const state = new AnimationState(stateData);
  const entry = state.setAnimation(0, clipName, { loop: clip.loop });
  entry.trackTime = loopTime(t, clip.duration);
  state.update(0);
  state.apply(skeleton);
  skeleton.updateWorldTransform();
  character.update();
}

function refreshTitle(): void {
  $("title").textContent = clipName ? `${clipName}${paused ? " (paused)" : ""}` : "Waiting for the editor...";
}

async function applyState(s: PhoneState): Promise<void> {
  if (s.waiting || !s.clip || !s.clipName || !s.rigMeta) {
    rev = s.rev;
    return;
  }
  if (s.rigRev !== rigRev && !rigLoading) {
    rigLoading = true;
    try {
      await loadRig(s.rigMeta);
      rigRev = s.rigRev;
    } finally {
      rigLoading = false;
    }
  }
  if (s.clipName !== clipName) elapsed = 0;
  clipName = s.clipName;
  clip = s.clip;
  if (!facingTouched && s.facing) facing = s.facing;
  rev = s.rev;
  recompile();
  place();
  refreshTitle();
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${base}/state?c=${clientId}`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const s = (await res.json()) as PhoneState;
    lastOk = performance.now();
    if (s.rev !== rev || (s.rigRev !== rigRev && !s.waiting)) await applyState(s);
    note(clipName ? "tap the ground to pause" : "open a clip in the editor");
  } catch {
    note(performance.now() - lastOk > 2500 ? "lost the editor: is the PC on and the link still running?" : "");
  }
}

async function main(): Promise<void> {
  if (!token) {
    note("this link has no token");
    return;
  }
  await app.init({ resizeTo: window, background: PHONE_GRASS.ground, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true, preference: "webgl" });
  document.body.prepend(app.canvas);
  app.stage.addChild(ground, shadow, stage);
  app.ticker.add((ticker) => {
    if (!paused) elapsed += ticker.deltaMS / 1000;
    pose(elapsed);
    for (let i = retired.length - 1; i >= 0; i--) {
      const r = retired[i]!;
      if (--r.ticks <= 0) {
        r.node.destroy({ children: true });
        r.atlas.destroy();
        retired.splice(i, 1);
      }
    }
  });
  window.addEventListener("resize", () => place());
  app.canvas.addEventListener("pointerdown", () => {
    paused = !paused;
    refreshTitle();
    note(paused ? "paused: tap to play" : "tap the ground to pause");
  });
  $("face").addEventListener("click", () => {
    facingTouched = true;
    facing = facing === "left" ? "right" : "left";
    place();
  });
  $("scale").addEventListener("click", () => {
    scale = nextScale(scale);
    place();
  });
  place();
  (window as unknown as { atlasPhone: unknown }).atlasPhone = {
    info: () => ({ clipName, rev, rigRev, paused, facing, scale, feetY, hasCharacter: !!character, clipSig: clip ? JSON.stringify(clip).length : 0, poseSig: skeleton ? Math.round(skeleton.bones.reduce((n, b) => n + b.world.x + b.world.y, 0)) : 0, bounds: character ? { ...character.getBounds() } : null, scaleX: character?.scale.x ?? null, missing: character?.missingTextures.length ?? null })
  };
  for (;;) {
    await poll();
    await new Promise((r) => setTimeout(r, PHONE_POLL_MS));
  }
}

void main();
