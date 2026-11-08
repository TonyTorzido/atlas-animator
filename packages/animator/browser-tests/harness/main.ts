/*
 * Atlas Animator: original implementation.
 *
 * Render harness for the browser tests: a fixed-size Pixi 8 WebGL canvas and functions the tests
 * call through `window.animatorHarness`. Every render returns the canvas as a PNG data URL and
 * the number of WebGL draw calls the frame issued.
 */
import { Application, type WebGLRenderer } from "pixi.js";
import { AnimationState, AnimationStateData, BoneMask } from "../../src/core/animationState.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import { Skeleton } from "../../src/core/skeleton.js";
import { AnimatorCharacter } from "../../src/pixi/animatorCharacter.js";
import { loadPackedAtlas } from "../../src/pixi/browserImages.js";
import { AnimatorDebugOverlay } from "../../src/pixi/debugOverlay.js";
import { DynamicAtlas } from "../../src/pixi/dynamicAtlas.js";
import type { RgbaImage } from "../../src/pixi/imageOps.js";
import { chainImages, separateImages, type PartImageProvider } from "../../src/pixi/partImages.js";
import { CAPE_LINKS, CAPE_MESH_ROWS, CAPE_PATH, capeImage, withCape } from "./capeRig.js";
import { BENCH, benchDocument, benchImages, CIRCLE, circleDocument, circleImages } from "./contourRig.js";

export const VIEW = 320;
export const BACKGROUND = 0x1e2430;

export interface RenderResult {
  png: string;
  drawCalls: number;
  missingTextures: string[];
}

export interface ThreePartOptions {
  skins?: string[];
  pose?: Record<string, number>;
  /** Characters to draw (a grid at half size when more than one). */
  count?: number;
  overlay?: boolean;
}

/** One frame of the scripted sequence. */
export interface SequenceFrame {
  png: string;
  drawCalls: number;
  /** Canvas position of the head image's centre (where the face must be drawn). */
  head: [number, number];
  /** Attack entry track time on track 1, or null when no attack plays. */
  attackTime: number | null;
}

export interface SequenceResult {
  frames: SequenceFrame[];
  /** "frame N: <callback> <clip>[ <event>]" lines in dispatch order. */
  log: string[];
}

/** One captured frame of the Phase 3 cape clip. */
export interface CapeFrame {
  /** Seconds since the clip started. */
  time: number;
  png: string;
  /** The same frame with the bone and mesh overlay (review video). */
  overlayPng: string;
  drawCalls: number;
  /** World rotation of each cape link, degrees. */
  angles: number[];
  /**
   * Canvas position of a point on the cloth near the hem, beside the torso, from the skinned mesh
   * itself (barycentric point of one triangle), so a probe there must hit cape cloth.
   */
  cloth: [number, number];
}

export interface CapeResult {
  frames: CapeFrame[];
  /** World rotation of each cape link at rest (after the physics warm-up). */
  rest: number[];
  /** Simulation rate and capture rate. */
  simulationFps: number;
  captureFps: number;
}

/** Phase: the stroked circle on a bending strip, rendered at 3x on white. */
export interface ContourCircleResult extends RenderResult {
  /** Display scale (display pixels per canvas pixel). */
  scale: number;
  /** Nominal stroke width in display pixels. */
  width: number;
  /** The deformed centreline in display pixels (x, y per point, closed). */
  centreline: number[];
}

/** Phase: the 50-character contour bench. */
export interface ContourBenchResult {
  characters: number;
  contoursPerCharacter: number;
  pointsPerContour: number;
  frames: number;
  /** Mean ms per character per frame of character.update() (skeleton + sync incl. strokes). */
  updateMs: { animatedWithContours: number; animatedWithout: number; stillWithContours: number; stillWithout: number };
  /** Mean ms per character per frame of the whole render() call (batching + GL submission). */
  renderMs: { animatedWithContours: number; animatedWithout: number };
  /** Stroke rebuilds per character per frame while animated / still. */
  rebuildsPerFrame: { animated: number; still: number };
  drawCalls: number;
  png: string;
}

export interface AnimatorHarness {
  renderContourCircle(bend: number): ContourCircleResult;
  benchContours(frames: number): ContourBenchResult;
  renderStrip(theta: number): RenderResult;
  renderThreePart(options?: ThreePartOptions): Promise<RenderResult>;
  renderSequence(): Promise<SequenceResult>;
  renderCape(): Promise<CapeResult>;
}

declare global {
  interface Window {
    animatorHarness?: AnimatorHarness;
    animatorHarnessError?: string;
  }
}

const app = new Application();
let drawCalls = 0;

async function start(): Promise<void> {
  await app.init({
    width: VIEW,
    height: VIEW,
    preference: "webgl",
    antialias: false,
    background: BACKGROUND,
    resolution: 1,
    autoDensity: false,
    autoStart: false,
    preserveDrawingBuffer: true
  });
  document.body.appendChild(app.canvas);
  const gl = (app.renderer as WebGLRenderer).gl;
  const drawElements = gl.drawElements.bind(gl);
  const drawArrays = gl.drawArrays.bind(gl);
  gl.drawElements = (...args: Parameters<typeof gl.drawElements>) => {
    drawCalls++;
    drawElements(...args);
  };
  gl.drawArrays = (...args: Parameters<typeof gl.drawArrays>) => {
    drawCalls++;
    drawArrays(...args);
  };
  window.animatorHarness = { renderStrip, renderThreePart, renderSequence, renderCape, renderContourCircle, benchContours };
}

function frame(characters: AnimatorCharacter[], atlas: DynamicAtlas): RenderResult {
  drawCalls = 0;
  app.renderer.render(app.stage);
  const result = {
    png: app.canvas.toDataURL("image/png"),
    drawCalls,
    missingTextures: [...new Set(characters.flatMap((c) => [...c.missingTextures]))]
  };
  for (const child of app.stage.removeChildren()) child.destroy({ children: true });
  atlas.destroy();
  return result;
}

// --- The 2-bone strip (same layout as the core skinning test, scaled up) -------------------------

const STRIP_LENGTH = 240;
const STRIP_HALF = 20;
const STRIP_COLUMNS = [0, 40, 80, 120, 160, 200, 240];

function stripDocument() {
  const top = STRIP_COLUMNS.map((x) => ({ x, y: -STRIP_HALF }));
  const bottom = [...STRIP_COLUMNS].reverse().map((x) => ({ x, y: STRIP_HALF }));
  const points = [...top, ...bottom];
  const n = STRIP_COLUMNS.length;
  const bottomIndex = (column: number) => 2 * n - 1 - column;
  const triangles: number[] = [];
  for (let j = 0; j < n - 1; j++) triangles.push(j, j + 1, bottomIndex(j + 1), j, bottomIndex(j + 1), bottomIndex(j));
  const joint = STRIP_LENGTH / 2;
  const vertices = points.flatMap(({ x, y }) =>
    x < joint ? [1, 0, x, y, 1] : x > joint ? [1, 1, x - joint, y, 1] : [2, 0, x, y, 0.5, 1, 0, y, 0.5]
  );
  return loadAnimDocument({
    format: "atlas-anim@1",
    name: "strip",
    canvas: { width: 320, height: 320, originX: 40, originY: 120 },
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", length: joint },
      { name: "lower", parent: "upper", x: joint, length: joint }
    ],
    slots: [{ name: "strip", bone: "upper", attachment: "strip" }],
    skins: {
      body: {
        attachments: {
          strip: {
            strip: {
              type: "mesh",
              path: "test/strip",
              bones: ["upper", "lower"],
              uvs: points.flatMap(({ x, y }) => [x / STRIP_LENGTH, (y + STRIP_HALF) / (2 * STRIP_HALF)]),
              triangles,
              vertices,
              hull: points.length,
              width: STRIP_LENGTH,
              height: 2 * STRIP_HALF
            }
          }
        }
      }
    }
  });
}

/** A 240 x 40 checkerboard (20 px squares) with a 2 px dark border, built in code. */
function stripImage(): RgbaImage {
  const width = STRIP_LENGTH;
  const height = 2 * STRIP_HALF;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      const dark = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
      const colour = edge ? [20, 20, 28] : dark ? [214, 92, 64] : [244, 218, 160];
      data.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

let stripDoc: ReturnType<typeof stripDocument> | null = null;
let stripImages: PartImageProvider | null = null;

function renderStrip(theta: number): RenderResult {
  stripDoc ??= stripDocument();
  stripImages ??= separateImages(new Map([["test/strip", stripImage()]]));
  const skeleton = new Skeleton(stripDoc);
  skeleton.setActiveSkins(["body"]);
  skeleton.getBone("lower").pose.rotation = theta;
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const character = new AnimatorCharacter({ skeleton, atlas, images: stripImages });
  character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
  character.position.set(stripDoc.canvas.originX, stripDoc.canvas.originY);
  character.update();
  app.stage.addChild(character);
  return frame([character], atlas);
}

// --- The hand-made three-part rig from the fixture atlas ------------------------------------------

let threePart: { doc: ReturnType<typeof loadAnimDocument>; images: PartImageProvider } | null = null;

async function loadThreePart(): Promise<NonNullable<typeof threePart>> {
  if (!threePart) {
    const response = await fetch("fixtures/rigs/three-part.anim.json");
    threePart = { doc: loadAnimDocument(await response.json()), images: await loadPackedAtlas("fixtures/rigs/three-part.atlas.json") };
  }
  return threePart;
}

async function renderThreePart(options: ThreePartOptions = {}): Promise<RenderResult> {
  const { doc, images } = await loadThreePart();
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const count = options.count ?? 1;
  const columns = Math.ceil(Math.sqrt(count));
  const scale = count === 1 ? 1 : 1 / columns;
  const characters: AnimatorCharacter[] = [];
  for (let i = 0; i < count; i++) {
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(options.skins ?? ["body"]);
    for (const [bone, rotation] of Object.entries(options.pose ?? {})) skeleton.getBone(bone).pose.rotation += rotation;
    const character = new AnimatorCharacter({ skeleton, atlas, images });
    character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
    const cell = VIEW / columns;
    character.scale.set(scale);
    character.position.set(
      (i % columns) * cell + (doc.canvas.originX * VIEW) / doc.canvas.width / columns,
      Math.floor(i / columns) * cell + (doc.canvas.originY * VIEW) / doc.canvas.height / columns
    );
    character.update();
    app.stage.addChild(character);
    characters.push(character);
    if (options.overlay) {
      const overlay = new AnimatorDebugOverlay();
      overlay.position.copyFrom(character.position);
      overlay.scale.copyFrom(character.scale);
      overlay.draw(skeleton, { weightsFor: "chest" });
      app.stage.addChild(overlay);
    }
  }
  return frame(characters, atlas);
}

// --- Phase: contour width invariance at 3x, and the contour bench ---------------------------

let circleDoc: ReturnType<typeof circleDocument> | null = null;

function renderContourCircle(bend: number): ContourCircleResult {
  circleDoc ??= circleDocument();
  const scale = 3;
  const skeleton = new Skeleton(circleDoc);
  skeleton.setActiveSkins(["body"]);
  skeleton.getBone("lower").pose.rotation = bend;
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const character = new AnimatorCharacter({ skeleton, atlas, images: separateImages(circleImages()) });
  character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
  character.contourPixelScale = scale;
  character.scale.set(scale);
  character.position.set(40, 60);
  character.update();
  app.stage.addChild(character);
  const ring = skeleton.activeContours[0]!;
  const points = new Float32Array(ring.pointCount * 2);
  skeleton.computeContourPoints(ring, points);
  const centreline = Array.from(points, (value, i) => (i % 2 === 0 ? 40 : 60) + value * scale);
  const previous = app.renderer.background.color.toNumber();
  app.renderer.background.color = 0xffffff;
  const result = frame([character], atlas);
  app.renderer.background.color = previous;
  return { ...result, scale, width: CIRCLE.width * scale, centreline };
}

function benchContours(frames: number): ContourBenchResult {
  const count = 50;
  const columns = 5;
  // The baseline uses the same document and code path with the contours culled by level of detail
  // (contourMinPixels = Infinity), so the difference is exactly what drawing the contours costs.
  const doc = benchDocument(true);
  const run = (withContours: boolean, animated: boolean) => {
    const images = separateImages(benchImages());
    const atlas = new DynamicAtlas({ pageSize: 512 });
    const characters: AnimatorCharacter[] = [];
    for (let i = 0; i < count; i++) {
      const skeleton = new Skeleton(doc);
      skeleton.setActiveSkins(["body"]);
      const character = new AnimatorCharacter({ skeleton, atlas, images });
      character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
      character.contourPixelScale = 0.4;
      if (!withContours) character.contourMinPixels = Number.POSITIVE_INFINITY;
      character.scale.set(0.4);
      character.position.set((i % columns) * 64 + 8, Math.floor(i / columns) * 32 + 12);
      app.stage.addChild(character);
      characters.push(character);
    }
    const pose = (f: number) => {
      characters.forEach((character, i) => {
        const t = animated ? f * 0.07 + i : i;
        character.skeleton.getBone("b1").pose.rotation = 10 * Math.sin(t);
        character.skeleton.getBone("b2").pose.rotation = 25 * Math.sin(t * 1.3);
        character.skeleton.getBone("b3").pose.rotation = 35 * Math.sin(t * 0.9);
      });
    };
    // Warm up (JIT, buffers), then measure.
    for (let f = 0; f < 60; f++) {
      pose(f);
      for (const character of characters) character.update();
      app.renderer.render(app.stage);
    }
    const rebuildsBefore = characters.reduce((sum, c) => sum + c.contourRebuilds, 0);
    // Timed as whole blocks (performance.now is coarse in the browser): A = pose + update,
    // B = pose + update + render; render = B - A, update = A - pose alone.
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) pose(60 + f);
    const t1 = performance.now();
    for (let f = 0; f < frames; f++) {
      pose(60 + f);
      for (const character of characters) character.update();
    }
    const t2 = performance.now();
    for (let f = 0; f < frames; f++) {
      pose(60 + frames + f);
      for (const character of characters) character.update();
      drawCalls = 0;
      app.renderer.render(app.stage);
    }
    const t3 = performance.now();
    const update = (t2 - t1) - (t1 - t0);
    const render = (t3 - t2) - (t2 - t1);
    const rebuilds = (characters.reduce((sum, c) => sum + c.contourRebuilds, 0) - rebuildsBefore) / 2;
    const calls = drawCalls;
    const result = { update: update / frames / count, render: render / frames / count, rebuilds: rebuilds / frames / count, calls };
    return { result, characters, atlas };
  };
  const finish = (r: ReturnType<typeof run>, keep = false) => {
    if (keep) return r.result;
    for (const child of app.stage.removeChildren()) child.destroy({ children: true });
    r.atlas.destroy();
    return r.result;
  };
  const animatedWithout = finish(run(false, true));
  const stillWithout = finish(run(false, false));
  const stillWith = finish(run(true, false));
  const animated = run(true, true);
  const animatedWith = animated.result;
  const shot = frame(animated.characters, animated.atlas);
  return {
    characters: count,
    contoursPerCharacter: BENCH.contours,
    pointsPerContour: BENCH.points,
    frames,
    updateMs: { animatedWithContours: animatedWith.update, animatedWithout: animatedWithout.update, stillWithContours: stillWith.update, stillWithout: stillWithout.update },
    renderMs: { animatedWithContours: animatedWith.render, animatedWithout: animatedWithout.render },
    rebuildsPerFrame: { animated: animatedWith.rebuilds, still: stillWith.rebuilds },
    drawCalls: animatedWith.calls,
    png: shot.png
  };
}

// --- Phase 2 exit: a scripted idle -> walk -> attack sequence, 3 s at 30 fps ----------------------

export const SEQUENCE_FPS = 30;
export const SEQUENCE_FRAMES = 90;

/**
 * Track 0: idle, then walk from 0.8 s (0.3 s crossfade). Track 1, masked to the chest and
 * everything above it: attack at 1.5 s (0.1 s mix in), faded out by a queued empty animation
 * that ends with the clip. The attack's `hit` event triggers a 33 ms hitstop, as the game does.
 * The attack also keys a red flash on the tunic slot, which sits on the hips: the chest mask
 * leaves it out, so the tunic stays green in every frame (the goldens pin that).
 * Fixed 1/30 s steps, so every frame is deterministic.
 */
async function renderSequence(): Promise<SequenceResult> {
  const { doc, images } = await loadThreePart();
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body", "tunic"]);
  const character = new AnimatorCharacter({ skeleton, atlas, images });
  character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
  character.position.set((doc.canvas.originX * VIEW) / doc.canvas.width, (doc.canvas.originY * VIEW) / doc.canvas.height);
  app.stage.addChild(character);

  const data = new AnimationStateData(doc);
  data.setMix("idle", "walk", 0.3);
  const state = new AnimationState(data);
  state.setTrackMask(1, BoneMask.of(doc, ["chest"]));
  let frameIndex = 0;
  const log: string[] = [];
  state.addListener({
    start: (entry) => log.push(`frame ${frameIndex}: start ${entry.clip.name}`),
    end: (entry) => log.push(`frame ${frameIndex}: end ${entry.clip.name}`),
    complete: (entry) => log.push(`frame ${frameIndex}: complete ${entry.clip.name}`),
    event: (entry, event) => {
      log.push(`frame ${frameIndex}: event ${entry.clip.name} ${event.name}`);
      if (event.name === "hit") state.hitstop(33);
    }
  });

  const frames: SequenceFrame[] = [];
  const head = skeleton.getBone("head");
  const centre = { x: 0, y: 0 };
  for (frameIndex = 0; frameIndex < SEQUENCE_FRAMES; frameIndex++) {
    if (frameIndex === 0) state.setAnimation(0, "idle");
    if (frameIndex === 24) state.setAnimation(0, "walk");
    if (frameIndex === 45) {
      state.setAnimation(1, "attack", { mix: 0.1 });
      state.addEmptyAnimation(1, 0.25);
    }
    state.update(frameIndex === 0 ? 0 : 1 / SEQUENCE_FPS);
    state.apply(skeleton);
    character.update();
    drawCalls = 0;
    app.renderer.render(app.stage);
    head.localToWorld(25, 0, centre);
    const attack = state.getCurrent(1);
    frames.push({
      png: app.canvas.toDataURL("image/png"),
      drawCalls,
      head: [character.position.x + centre.x, character.position.y + centre.y],
      attackTime: attack && attack.clip.name === "attack" ? attack.trackTime : attack?.mixingFrom?.clip.name === "attack" ? attack.mixingFrom.trackTime : null
    });
  }
  for (const child of app.stage.removeChildren()) child.destroy({ children: true });
  atlas.destroy();
  return { frames, log };
}

// --- Phase 3 exit: a five-link physics cape swings and settles, 4 s ------------------------------

export const CAPE_SIMULATION_FPS = 60;
export const CAPE_CAPTURE_FPS = 30;
export const CAPE_SECONDS = 4;

/**
 * The three-part rig wearing the cape skin plays `cape_demo` (the figure sways for 1.25 s, then
 * stands still). The game loop runs at 60 Hz with fixed 1/60 s frames (state, physics clock,
 * apply, updateWorldTransform); every second frame is captured, plain and with the debug overlay.
 * Physics is warmed up on the first pose so the cape starts at rest.
 */
async function renderCape(): Promise<CapeResult> {
  const { doc: threePartDoc, images: bodyImages } = await loadThreePart();
  const raw = (await (await fetch("fixtures/rigs/three-part.anim.json")).json()) as Parameters<typeof withCape>[0];
  const doc = loadAnimDocument(withCape(raw));
  const images = chainImages(separateImages(new Map([[CAPE_PATH, capeImage()]])), bodyImages);
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body", "cape"]);
  const character = new AnimatorCharacter({ skeleton, atlas, images });
  character.contourScaleStep = 0; // exact display scale: goldens and gates measure the unquantized AA band
  character.position.set((threePartDoc.canvas.originX * VIEW) / threePartDoc.canvas.width, (threePartDoc.canvas.originY * VIEW) / threePartDoc.canvas.height);
  app.stage.addChild(character);
  const overlay = new AnimatorDebugOverlay();
  overlay.position.copyFrom(character.position);

  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, "cape_demo");
  state.apply(skeleton);
  skeleton.updateWorldTransform();
  skeleton.warmUpPhysics(1);

  const links = Array.from({ length: CAPE_LINKS }, (_, i) => skeleton.getBone(`cape${i}`));
  const rest = links.map((bone) => bone.worldRotationX);
  const capeSlot = skeleton.getSlot("cape");
  const vertices = new Float32Array(4 * CAPE_MESH_ROWS);
  // Triangle (left row 8, left row 9, right row 9): 45/45/10 is ~80% of the way to the left edge,
  // about 100 px down the cape (outside the torso's width, above the hem).
  const [a, b, c] = [8, 9, 2 * CAPE_MESH_ROWS - 1 - 9];
  const frames: CapeFrame[] = [];
  const total = CAPE_SECONDS * CAPE_SIMULATION_FPS;
  const every = CAPE_SIMULATION_FPS / CAPE_CAPTURE_FPS;
  for (let i = 0; i < total; i++) {
    if (i > 0) {
      state.update(1 / CAPE_SIMULATION_FPS);
      skeleton.update(1 / CAPE_SIMULATION_FPS);
    }
    state.apply(skeleton);
    character.update();
    if (i % every !== 0) continue;
    drawCalls = 0;
    app.renderer.render(app.stage);
    const png = app.canvas.toDataURL("image/png");
    const calls = drawCalls;
    overlay.draw(skeleton, { bones: true, wireframe: true, points: false, weightsFor: null });
    app.stage.addChild(overlay);
    app.renderer.render(app.stage);
    const overlayPng = app.canvas.toDataURL("image/png");
    app.stage.removeChild(overlay);
    skeleton.computeSlotWorldVertices(capeSlot, vertices);
    const vx = (k: number) => vertices[2 * k] as number;
    const vy = (k: number) => vertices[2 * k + 1] as number;
    frames.push({
      time: i / CAPE_SIMULATION_FPS,
      png,
      overlayPng,
      drawCalls: calls,
      angles: links.map((bone) => bone.worldRotationX),
      cloth: [
        character.position.x + 0.45 * vx(a) + 0.45 * vx(b) + 0.1 * vx(c),
        character.position.y + 0.45 * vy(a) + 0.45 * vy(b) + 0.1 * vy(c)
      ]
    });
  }
  overlay.destroy({ children: true });
  for (const child of app.stage.removeChildren()) child.destroy({ children: true });
  atlas.destroy();
  return { frames, rest, simulationFps: CAPE_SIMULATION_FPS, captureFps: CAPE_CAPTURE_FPS };
}

start().catch((error: unknown) => {
  window.animatorHarnessError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
});
