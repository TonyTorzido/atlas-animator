/*
 * Atlas Animator: original implementation.
 *
 * Plan phone bench: N characters (?count=N; default runs 50 and 20) through the shipping Pixi adapter with the held-pose cache
 * (30 fps held frames, 60 Hz display), at production game scale (template7 figure = 140 game px)
 * and the device's real DPR. Built into ONE self-contained HTML file by bench-page/build.mjs (Pixi,
 * the runtime, both rigs and their atlas pages inline; no network). Results go to
 * window.reportBenchResults(json) when the host page defines it, and are shown as a table + JSON.
 *
 * Per scenario (after warm-up): CPU ms per display frame (p50/p95/p99; split into pose, embed,
 * stroke, upload/submit = renderer.render), GPU ms via EXT_disjoint_timer_query_webgl2 (omitted
 * where unavailable), draw calls per frame (counted on the WebGL context), submitted vertices per
 * character, missed refreshes (lost refresh opportunities against the expected period 1000 / hz,
 * ?hz=N, default 60: an interval of k periods loses k - 1), cache hits/misses and the work done on
 * all-hit frames (must be zero). A run with any rAF gap over 250 ms, or hidden at any point, is
 * INVALID (interrupted or backgrounded) and says so in the table. The transition scenario switches
 * clips every TRANSITION_EVERY seconds; its transition windows (each switch frame through the end of
 * the crossfade) are reported separately, with the entry-change cost (the setAnimation calls, inside
 * the CPU timing) on its own. GPU timer queries follow the Khronos EXT_disjoint_timer_query_webgl2
 * rule: on a disjoint event every outstanding query is discarded. Long mode: one sustained
 * scenario (moving crowd + repeated transitions + zoom) for 5 min at 20 characters.
 *
 * CSP-safe (sandboxed pages run without 'unsafe-eval' and with connect-src 'none'): Pixi's
 * eval-free shader/uniform paths come from pixi.js/unsafe-eval, and the inline atlas pages are
 * decoded from their data URLs without fetch. The page's static UI renders without this script;
 * build.mjs adds an error handler that prints any failure on the page.
 */
import "pixi.js/unsafe-eval";
import { Application, Container, type WebGLRenderer } from "pixi.js";
import { atlasPackSchema } from "../src/core/atlasPack.js";
import { AnimationState, AnimationStateData, HELD_PHASES } from "../src/core/animationState.js";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import type { AnimDocument } from "../src/core/format.js";
import { Skeleton } from "../src/core/skeleton.js";
import { AnimatorCharacter } from "../src/pixi/animatorCharacter.js";
import { DynamicAtlas } from "../src/pixi/dynamicAtlas.js";
import type { RgbaImage } from "../src/pixi/imageOps.js";
import { packedAtlasImages, type PartImageProvider } from "../src/pixi/partImages.js";

interface EmbeddedRig {
  id: string;
  label: string;
  note: string;
  document: unknown;
  atlas: unknown;
  pages: Record<string, string>;
  /** Clips: [steady, transition target]; generated sway when absent from the document. */
  clips: [string, string];
  skins: string[];
  figureHeight: number;
}

declare global {
  interface Window {
    BENCH_RIGS: EmbeddedRig[];
    BENCH_BUILD: { commit: string; built: string };
    reportBenchResults?: (json: unknown) => void;
    showBenchError?: (text: string) => void;
    __benchResults?: unknown;
    __benchStart?: (mode: Mode) => Promise<unknown>;
  }
}

type Mode = "quick" | "full" | "long";
/** Character counts per run (?count=N runs one): 50 = the recorded stress case, 20 = total animated actors (players plus mobs). */
const DEFAULT_COUNTS = [50, 20];
const LONG_COUNT = 20;
const LONG_SECONDS = 300;
/** A refresh interval longer than this means the run was interrupted or backgrounded (invalid). */
const INTERRUPT_MS = 250;
/** Transition scenario: a clip switch (0.25 s crossfade) every this many seconds, alternating clips. */
const TRANSITION_EVERY = 3;
const TRANSITION_MIX = 0.25;
const GAME_PIXELS = 140; // template7 preset: figure height on screen in game (CSS) pixels
const TARGETS = { drawCalls: 100, vertsPerChar: 2500, cpuP95: 5, cpuP99: 8, missedPct: 1, gpuP95: 5 };
const SCENARIOS = ["synchronized", "phased", "moving-crowd", "transition", "zoom", "sustained"] as const;
/** Quick / Full run these; Long runs "sustained" only. */
const STANDARD_SCENARIOS: readonly ScenarioName[] = ["synchronized", "phased", "moving-crowd", "transition", "zoom"];
/** Zoom scenario: a continuous pinch-zoom 0.75x -> 1.5x -> 0.75x (log-linear) every ZOOM_PERIOD seconds, about the screen centre. */
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.5;
const ZOOM_PERIOD = 4;
type ScenarioName = (typeof SCENARIOS)[number];

const $ = (id: string) => document.getElementById(id) as HTMLElement;

// --- Rig loading ---------------------------------------------------------------------------------

/** A looping idle sway over every non-root, non-IK-target bone (for rigs without clips). */
function swayClip(doc: { bones: { name: string; parent?: string }[] }, period: number, amplitude: number) {
  const bones: Record<string, unknown> = {};
  doc.bones.forEach((bone, i) => {
    if (!bone.parent || /target/.test(bone.name)) return;
    const keys = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ time: Number((f * period).toFixed(4)), value: Number((amplitude * Math.sin(2 * Math.PI * f + i * 0.7)).toFixed(3)) }));
    bones[bone.name] = { rotate: keys };
  });
  return { duration: period, loop: true, bones };
}

interface LoadedRig {
  rig: EmbeddedRig;
  doc: AnimDocument;
  images: PartImageProvider;
}

async function loadRig(rig: EmbeddedRig): Promise<LoadedRig> {
  const raw = JSON.parse(JSON.stringify(rig.document)) as { bones: { name: string; parent?: string }[]; animations?: Record<string, { loop?: boolean }> };
  raw.animations ??= {};
  const [a, b] = rig.clips;
  if (!raw.animations[a]) raw.animations[a] = swayClip(raw, 1.6, 6);
  if (!raw.animations[b]) raw.animations[b] = swayClip(raw, 1.0, 14);
  raw.animations[a].loop = true;
  raw.animations[b].loop = true;
  const doc = loadAnimDocument(raw);
  const pack = atlasPackSchema.parse(rig.atlas);
  const pages = new Map<string, RgbaImage>();
  for (const page of pack.pages) pages.set(page.file, await dataUrlImage(rig.pages[page.file] as string));
  return { rig, doc, images: packedAtlasImages(pack, pages) };
}

/** Decodes an inline `data:image/png;base64,...` page to straight-alpha RGBA (no fetch: connect-src may be 'none'). */
async function dataUrlImage(url: string): Promise<RgbaImage> {
  const comma = url.indexOf(",");
  const type = /^data:([^;,]+)/.exec(url)?.[1] ?? "image/png";
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is not available");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally {
    bitmap.close();
  }
}

// --- Stats ---------------------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}
function dist(values: number[]) {
  const s = [...values].sort((x, y) => x - y);
  const mean = s.reduce((t, v) => t + v, 0) / Math.max(1, s.length);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { p50: r(quantile(s, 0.5)), p95: r(quantile(s, 0.95)), p99: r(quantile(s, 0.99)), max: r(s[s.length - 1] ?? Number.NaN), mean: r(mean), n: s.length };
}

// --- WebGL instrumentation -----------------------------------------------------------------------

interface GlCounters {
  calls: number;
  indices: number;
}

function instrument(gl: WebGL2RenderingContext): GlCounters {
  const counters: GlCounters = { calls: 0, indices: 0 };
  const g = gl as unknown as Record<string, (...args: number[]) => void>;
  for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"]) {
    const original = g[name];
    if (typeof original !== "function") continue;
    const countArg = name === "drawArrays" || name === "drawArraysInstanced" ? 2 : name === "drawRangeElements" ? 3 : 1;
    g[name] = function (this: unknown, ...args: number[]) {
      counters.calls++;
      counters.indices += args[countArg] as number;
      return original.apply(gl, args);
    };
  }
  return counters;
}

class GpuTimer {
  readonly available: boolean;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Disjoint events seen, and the outstanding queries they discarded. */
  disjoint = 0;
  discarded = 0;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as GpuTimer["ext"];
    this.available = this.ext !== null;
  }
  begin(): void {
    if (!this.ext || this.pending.length > 8) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  /**
   * Collects finished queries (ms), oldest first. Khronos EXT_disjoint_timer_query_webgl2: the
   * disjoint flag is checked BEFORE any result is accepted, and when it is set every outstanding
   * query is discarded (their timings may be invalid), not just the one being read.
   */
  poll(out: number[] | null): void {
    if (!this.ext) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.disjoint++;
      this.discarded += this.pending.length;
      for (const q of this.pending) gl.deleteQuery(q);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length > 0) {
      const q = this.pending[0] as WebGLQuery;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
      out?.push(ns / 1e6);
    }
  }
}

// --- Scenario runner -----------------------------------------------------------------------------

interface Actor {
  character: AnimatorCharacter;
  state: AnimationState;
  baseX: number;
  baseY: number;
  speed: number;
}

interface FrameSample {
  cpu: number;
  pose: number;
  /** Per-stage split (item 8): sampling and constraints (pose = both), bytes marked for upload, batch breaks. */
  sample: number;
  constraints: number;
  uploadBytes: number;
  batchBreaks: number;
  embed: number;
  stroke: number;
  submit: number;
  update: number;
  drawCalls: number;
  indices: number;
  misses: number;
}

/** Small seeded PRNG (mulberry32): the same random start times on every run and device. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function runScenario(
  app: Application,
  gl: WebGL2RenderingContext,
  counters: GlCounters,
  gpu: GpuTimer,
  loaded: LoadedRig,
  scenario: ScenarioName,
  count: number,
  seconds: number,
  warmup: number,
  expectedMs: number,
  progress: (fraction: number) => void
) {
  const COUNT = count;
  const { doc, images, rig } = loaded;
  const dpr = app.renderer.resolution;
  const width = app.screen.width;
  const height = app.screen.height;
  const scale = GAME_PIXELS / rig.figureHeight;
  const atlas = new DynamicAtlas({ pageSize: 1024 });
  const layer = new Container();
  app.stage.addChild(layer);
  const data = new AnimationStateData(doc);
  const [clipA, clipB] = rig.clips;
  const columns = 10;
  const rows = Math.ceil(COUNT / columns);
  const figure = GAME_PIXELS;
  const actors: Actor[] = [];
  const random = mulberry32(0x4d4f);
  for (let i = 0; i < COUNT; i++) {
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(rig.skins);
    const character = new AnimatorCharacter({ skeleton, atlas, images });
    character.scale.set(scale);
    character.contourPixelScale = scale * dpr; // device pixels per canvas pixel (the AA band is in device px)
    character.profiler = () => performance.now();
    // Held phase from the character's seed (deterministic, as in game): about half the crowd per phase.
    const state = new AnimationState(data, { phaseSeed: i });
    state.heldFrames = true;
    state.setAnimation(0, clipA);
    // Synchronized: every clip at the same time (only the held phases split the refreshes).
    // Every other scenario: independent random start times (seeded), so the clips are truly out of step.
    if (scenario !== "synchronized") state.update(random() * (state.getCurrent(0)?.clip.duration ?? 1));
    const baseX = ((i % columns) + 0.5) * (width / columns);
    const baseY = (Math.floor(i / columns) + 0.5) * (height / rows) + figure * 0.35;
    character.position.set(baseX, baseY);
    layer.addChild(character);
    actors.push({ character, state, baseX, baseY, speed: 20 + ((i * 37) % 60) });
  }

  const samples: FrameSample[] = [];
  const intervals: number[] = [];
  const gpuMs: number[] = [];
  const allHit = { frames: 0, poseEvaluations: 0, bufferUpdates: 0, strokeRebuilds: 0 };
  const total = { hits: 0, misses: 0, poseEvaluations: 0, strokeRebuilds: 0, bufferUpdates: 0 };
  let verts = 0;
  let vertsMax = 0;
  let contourVerts = 0;
  let last = await nextFrame();
  const start = last;
  const transitions = scenario === "transition" || scenario === "sustained";
  let nextTransition = warmup + 1;
  let transitionCount = 0;
  let windowUntil = -1;
  const windowCpu: number[] = [];
  const entryChangeMs: number[] = [];
  let maxGap = 0;
  let hidden = document.visibilityState === "hidden";
  const onVisibility = () => {
    if (document.visibilityState === "hidden") hidden = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  let elapsed = 0;
  const totalSeconds = warmup + seconds;
  while (elapsed < totalSeconds) {
    const now = await nextFrame();
    const dt = Math.min(0.1, (now - last) / 1000);
    const measuring = elapsed >= warmup;
    if (measuring) {
      intervals.push(now - last);
      if (now - last > maxGap) maxGap = now - last;
    }
    last = now;
    elapsed = (now - start) / 1000;
    progress(Math.min(1, elapsed / totalSeconds));

    if (scenario === "zoom" || scenario === "sustained") {
      const f = ((elapsed % ZOOM_PERIOD) / ZOOM_PERIOD) * 2;
      const zoom = ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (f <= 1 ? f : 2 - f);
      for (const actor of actors) {
        actor.character.scale.set(scale * zoom);
        actor.character.contourPixelScale = scale * zoom * dpr;
        actor.character.position.set(width / 2 + (actor.baseX - width / 2) * zoom, height / 2 + (actor.baseY - height / 2) * zoom);
      }
    }
    if (scenario === "moving-crowd" || scenario === "sustained") {
      for (const actor of actors) {
        const x = (actor.baseX + elapsed * actor.speed) % (width + figure) - figure / 2;
        const y = actor.baseY + 6 * Math.sin(elapsed * 3 + actor.speed);
        const p = actor.character.position;
        // Physics motion policy: report the container move (a no-op, still a hit, without physics).
        actor.character.moveWorld(x - p.x, y - p.y);
        p.set(x, y);
      }
    }

    const before = snapshot(actors);
    const t0 = performance.now();
    let inWindow = false;
    if (transitions && elapsed >= nextTransition) {
      // Entry change inside the CPU timing; also reported on its own.
      nextTransition += TRANSITION_EVERY;
      const clip = transitionCount++ % 2 === 0 ? clipB : clipA;
      for (const actor of actors) actor.state.setAnimation(0, clip, { mix: TRANSITION_MIX });
      if (measuring) entryChangeMs.push(performance.now() - t0);
      windowUntil = elapsed + TRANSITION_MIX + 1 / 30;
    }
    if (elapsed <= windowUntil) inWindow = true;
    let misses = 0;
    for (const actor of actors) {
      // step(): the state and the skeleton's physics clock advance together.
      if (actor.character.step(actor.state, dt)) misses++;
    }
    const t1 = performance.now();
    counters.calls = 0;
    counters.indices = 0;
    gpu.begin();
    app.renderer.render(app.stage);
    gpu.end();
    const t2 = performance.now();
    gpu.poll(measuring ? gpuMs : null);
    const after = snapshot(actors);
    if (!measuring) continue;
    const d = (k: keyof ReturnType<typeof snapshot>) => after[k] - before[k];
    if (inWindow) windowCpu.push(t2 - t0);
    samples.push({
      cpu: t2 - t0,
      update: t1 - t0,
      pose: d("msPose"),
      sample: d("msSample"),
      constraints: d("msConstraints"),
      uploadBytes: d("uploadBytes"),
      // A batch break ends one draw call and starts the next (painter's order kept): calls - 1.
      batchBreaks: Math.max(0, counters.calls - 1),
      embed: d("msEmbed"),
      stroke: d("msStroke"),
      submit: t2 - t1,
      drawCalls: counters.calls,
      indices: counters.indices,
      misses
    });
    total.hits += d("cacheHits");
    total.misses += d("cacheMisses");
    total.poseEvaluations += d("poseEvaluations");
    total.strokeRebuilds += d("rebuilds");
    total.bufferUpdates += d("bufferUpdates");
    if (misses === 0) {
      allHit.frames++;
      allHit.poseEvaluations += d("poseEvaluations");
      allHit.bufferUpdates += d("bufferUpdates");
      allHit.strokeRebuilds += d("rebuilds");
    }
    if (samples.length % 30 === 1) {
      const v = actors.reduce((s, a) => s + a.character.submittedVertices, 0) / COUNT;
      verts = Math.max(verts, v);
      vertsMax = Math.max(vertsMax, ...actors.map((a) => a.character.submittedVertices));
      const strokes = actors.reduce((sum, a) => sum + a.character.contourMeshes.reduce((t, m) => t + (m.visible ? m.geometry.positions.length / 2 : 0), 0), 0) / COUNT;
      contourVerts = Math.max(contourVerts, strokes);
    }
  }
  gpu.poll(gpuMs);
  document.removeEventListener("visibilitychange", onVisibility);

  // Lost refresh opportunities against the expected display period: an interval of k periods
  // (rounded) lost k - 1 refreshes, so a steady 30 Hz run on a 60 Hz display loses half, and a long
  // stall counts every period it swallowed.
  let lost = 0;
  let opportunities = 0;
  for (const v of intervals) {
    const periods = Math.max(1, Math.round(v / expectedMs));
    lost += periods - 1;
    opportunities += periods;
  }
  const interrupted = maxGap > INTERRUPT_MS || hidden;
  const result = {
    rig: rig.id,
    scenario,
    characters: COUNT,
    seconds,
    valid: !interrupted,
    invalidReason: interrupted ? (hidden ? "page hidden (backgrounded) during the run" : `rAF gap ${Math.round(maxGap)} ms > ${INTERRUPT_MS} ms (interrupted)`) : null,
    maxRafGapMs: Math.round(maxGap * 10) / 10,
    frames: samples.length,
    cpuMs: dist(samples.map((s) => s.cpu)),
    split: {
      poseMs: dist(samples.map((s) => s.pose)),
      // Per-stage timing counters:
      // sampling + constraints = pose, skinning = embed, contours = stroke.
      stages: {
        samplingMs: dist(samples.map((s) => s.sample)),
        constraintsMs: dist(samples.map((s) => s.constraints)),
        skinningMs: dist(samples.map((s) => s.embed)),
        contoursMs: dist(samples.map((s) => s.stroke)),
        uploadBytes: dist(samples.map((s) => s.uploadBytes)),
        batchBreaks: dist(samples.map((s) => s.batchBreaks))
      },
      embedMs: dist(samples.map((s) => s.embed)),
      strokeMs: dist(samples.map((s) => s.stroke)),
      updateMs: dist(samples.map((s) => s.update)),
      uploadSubmitMs: dist(samples.map((s) => s.submit))
    },
    gpuMs: gpu.available ? dist(gpuMs) : "unavailable",
    gpuDisjoint: gpu.disjoint,
    gpuDiscardedQueries: gpu.discarded,
    drawCalls: dist(samples.map((s) => s.drawCalls)),
    drawCallsPerCharacter: Math.round((dist(samples.map((s) => s.drawCalls)).p95 / COUNT) * 1000) / 1000,
    indicesPerCharacter: Math.round(dist(samples.map((s) => s.indices)).p50 / COUNT),
    vertsPerCharacter: Math.round(verts),
    vertsPerCharacterMax: vertsMax,
    contourVertsPerCharacter: Math.round(contourVerts),
    rafIntervalMs: dist(intervals),
    expectedPeriodMs: Math.round(expectedMs * 1000) / 1000,
    missedRefreshes: lost,
    missedPct: Math.round((lost / Math.max(1, opportunities)) * 10000) / 100,
    transition: transitions ? { switches: entryChangeMs.length, windowCpuMs: dist(windowCpu), entryChangeMs: dist(entryChangeMs) } : null,
    missesPerFrame: dist(samples.map((s) => s.misses)),
    cache: { ...total, allHitFrames: allHit.frames, workOnAllHitFrames: { poseEvaluations: allHit.poseEvaluations, bufferUpdates: allHit.bufferUpdates, strokeRebuilds: allHit.strokeRebuilds } }
  };
  layer.destroy({ children: true });
  atlas.destroy();
  return result;
}

function snapshot(actors: Actor[]) {
  const s = { msPose: 0, msSample: 0, msConstraints: 0, uploadBytes: 0, msEmbed: 0, msStroke: 0, cacheHits: 0, cacheMisses: 0, poseEvaluations: 0, bufferUpdates: 0, rebuilds: 0 };
  for (const { character: c } of actors) {
    s.msPose += c.stats.msPose;
    s.msSample += c.stats.msSample;
    s.msConstraints += c.stats.msConstraints;
    s.uploadBytes += c.stats.uploadBytes;
    s.msEmbed += c.stats.msEmbed;
    s.msStroke += c.stats.msStroke;
    s.cacheHits += c.stats.cacheHits;
    s.cacheMisses += c.stats.cacheMisses;
    s.poseEvaluations += c.stats.poseEvaluations;
    s.bufferUpdates += c.stats.bufferUpdates;
    s.rebuilds += c.contourRebuilds;
  }
  return s;
}

type ScenarioResult = Awaited<ReturnType<typeof runScenario>>;

function verdicts(r: ScenarioResult) {
  const gpu = typeof r.gpuMs === "string" ? null : r.gpuMs.p95;
  const hitWork = r.cache.workOnAllHitFrames;
  return {
    drawCalls: r.drawCalls.p95 <= TARGETS.drawCalls,
    vertsPerChar: r.vertsPerCharacterMax <= TARGETS.vertsPerChar,
    cpuP95: r.cpuMs.p95 <= TARGETS.cpuP95,
    cpuP99: r.cpuMs.p99 <= TARGETS.cpuP99,
    missed: r.missedPct < TARGETS.missedPct,
    valid: r.valid,
    gpuP95: gpu === null ? null : gpu <= TARGETS.gpuP95,
    zeroWorkOnHits: hitWork.poseEvaluations === 0 && hitWork.bufferUpdates === 0 && hitWork.strokeRebuilds === 0 && r.cache.poseEvaluations === r.cache.misses
  };
}

// --- Page ----------------------------------------------------------------------------------------

async function deviceInfo(gl: WebGL2RenderingContext) {
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    dpr: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
    renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
    vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    timerQuery: gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null,
    timerResolutionMs: timerResolution()
  };
}

function timerResolution(): number {
  let min = Infinity;
  let last = performance.now();
  for (let i = 0; i < 20000 && min > 0.001; i++) {
    const now = performance.now();
    if (now > last) min = Math.min(min, now - last);
    last = now;
  }
  return Math.round(min * 10000) / 10000;
}

let running = false;

async function start(mode: Mode): Promise<unknown> {
  if (running) return null;
  running = true;
  const query = new URLSearchParams(location.search);
  // ?seconds=N overrides the scenario length (smoke runs of the harness only).
  const override = Number(query.get("seconds"));
  const seconds = override > 0 ? override : mode === "quick" ? 15 : mode === "full" ? 60 : LONG_SECONDS;
  const warmup = override > 0 ? 1 : mode === "quick" ? 3 : 5;
  // ?count=N runs one count; default: 50 (recorded stress case) then 20 (the total-actor target). Long: 20.
  const countParam = Math.floor(Number(query.get("count")));
  const counts = countParam > 0 ? [countParam] : mode === "long" ? [LONG_COUNT] : DEFAULT_COUNTS;
  const hz = Number(query.get("hz")) > 0 ? Number(query.get("hz")) : 60;
  const expectedMs = 1000 / hz;
  document.body.classList.add("running");
  $("results").innerHTML = "";
  const app = new Application();
  await app.init({
    resizeTo: window,
    preference: "webgl",
    antialias: false,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    autoStart: false,
    background: 0x30343a,
    powerPreference: "high-performance"
  });
  $("stage").appendChild(app.canvas);
  const gl = (app.renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  const counters = instrument(gl);
  const gpu = new GpuTimer(gl);
  const device = await deviceInfo(gl);
  const rigs = await Promise.all(window.BENCH_RIGS.map(loadRig));
  // ?rig=<id>&scenario=<name> restrict the run (profiling one scenario); default: every rig x scenario.
  const only = new URLSearchParams(location.search);
  const scenarios = mode === "long" ? (["sustained"] as ScenarioName[]) : STANDARD_SCENARIOS;
  const plan = counts
    .flatMap((count) => rigs.flatMap((rig) => scenarios.map((scenario) => ({ rig, scenario, count }))))
    .filter((step) => (!only.get("rig") || step.rig.rig.id === only.get("rig")) && (!only.get("scenario") || step.scenario === only.get("scenario")));
  const results: ScenarioResult[] = [];
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i] as (typeof plan)[number];
    $("status").textContent = `${step.count} x ${step.rig.rig.label}: ${step.scenario} (${i + 1}/${plan.length})`;
    results.push(
      await runScenario(app, gl, counters, gpu, step.rig, step.scenario, step.count, seconds, warmup, expectedMs, (f) => {
        ($("bar") as HTMLElement).style.width = `${(((i + f) / plan.length) * 100).toFixed(1)}%`;
      })
    );
  }
  app.destroy(true, { children: true });
  const json = {
    bench: "atlas-animator ",
    build: window.BENCH_BUILD,
    mode,
    secondsPerScenario: seconds,
    warmupSeconds: warmup,
    characters: counts,
    expectedRefreshHz: hz,
    interruptGapMs: INTERRUPT_MS,
    valid: results.every((r) => r.valid),
    gameScale: { figureGamePixels: GAME_PIXELS, dpr: device.dpr },
    playback: { clipFps: 30, poseCacheHz: 30, heldPhases: HELD_PHASES, display: "rAF (60 Hz expected)" },
    device,
    targets: TARGETS,
    scenarios: results.map((r) => ({ ...r, pass: verdicts(r) })),
    rigs: window.BENCH_RIGS.map((r) => ({ id: r.id, label: r.label, note: r.note, clips: r.clips }))
  };
  window.__benchResults = json;
  try {
    window.reportBenchResults?.(json);
  } catch (error) {
    console.error("reportBenchResults failed", error);
  }
  document.body.classList.remove("running");
  renderResults(json);
  running = false;
  return json;
}

function cell(value: string, pass: boolean | null, label = ""): string {
  const cls = pass === null ? "na" : pass ? "pass" : "fail";
  return `<td class="${cls}" data-label="${label}">${value}</td>`;
}

function renderResults(json: { device: Awaited<ReturnType<typeof deviceInfo>>; scenarios: (ScenarioResult & { pass: ReturnType<typeof verdicts> })[]; rigs: { id: string; label: string; note: string }[] }): void {
  const d = json.device;
  const rows = json.scenarios
    .map((s) => {
      const gpu = typeof s.gpuMs === "string" ? "n/a" : `${s.gpuMs.p95.toFixed(2)}`;
      const all = Object.values(s.pass).every((v) => v !== false);
      const verdict = s.valid ? (all ? "PASS" : "FAIL") : `INVALID<br><small>${s.invalidReason}</small>`;
      return `<tr><th>${s.rig} x${s.characters}<br><small>${s.scenario}</small></th>${cell(`${s.cpuMs.p95.toFixed(2)} / ${s.cpuMs.p99.toFixed(2)}`, s.pass.cpuP95 && s.pass.cpuP99, "CPU p95/p99 ms")}${cell(`${s.drawCalls.p95}`, s.pass.drawCalls, "Draw calls")}${cell(`${s.vertsPerCharacter}`, s.pass.vertsPerChar, "Verts/char")}${cell(`${s.missedPct}%`, s.pass.missed, "Missed")}${cell(gpu, s.pass.gpuP95, "GPU p95 ms")}${cell(`${s.cache.hits}/${s.cache.misses}`, s.pass.zeroWorkOnHits, "Hits/misses")}${cell(verdict, all, "Verdict")}</tr>`;
    })
    .join("");
  const split = json.scenarios
    .map((s) => `<tr><th>${s.rig} x${s.characters}<br><small>${s.scenario}</small></th><td data-label="Pose">${s.split.poseMs.p95.toFixed(2)}</td><td data-label="Embed">${s.split.embedMs.p95.toFixed(2)}</td><td data-label="Stroke">${s.split.strokeMs.p95.toFixed(2)}</td><td data-label="Upload/submit">${s.split.uploadSubmitMs.p95.toFixed(2)}</td><td data-label="CPU p50">${s.cpuMs.p50.toFixed(2)}</td></tr>`)
    .join("");
  $("results").innerHTML = `
    <h2>Results</h2>
    <p class="device">${d.renderer}<br>DPR ${d.dpr}, ${d.screen.width}x${d.screen.height}, ${d.cores ?? "?"} cores, timer ${d.timerResolutionMs} ms</p>
    <div class="table"><table>
      <thead><tr><th>Scenario</th><th>CPU p95 / p99 ms<br><small>&le;5 / &le;8</small></th><th>Draw calls<br><small>&le;100</small></th><th>Verts/char<br><small>&le;2500</small></th><th>Missed<br><small>&lt;1%</small></th><th>GPU p95<br><small>&le;5</small></th><th>Hits/misses<br><small>0 work on hits</small></th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h3>CPU split, p95 ms per frame (whole crowd)</h3>
    <div class="table"><table><thead><tr><th>Scenario</th><th>Pose</th><th>Embed</th><th>Stroke</th><th>Upload/submit</th><th>CPU p50</th></tr></thead><tbody>${split}</tbody></table></div>
    ${transitionsTable(json.scenarios)}
    <p class="note">${json.rigs.map((r) => `<b>${r.id}</b>: ${r.note}`).join("<br>")}</p>
    <details><summary>Result JSON</summary><pre>${JSON.stringify(json, null, 2).replace(/</g, "&lt;")}</pre></details>`;
}

function transitionsTable(scenarios: ScenarioResult[]): string {
  const rows = scenarios
    .filter((s) => s.transition)
    .map((s) => {
      const t = s.transition as NonNullable<ScenarioResult["transition"]>;
      return `<tr><th>${s.rig} x${s.characters}<br><small>${s.scenario}</small></th><td data-label="Switches">${t.switches}</td><td data-label="Window CPU p95">${t.windowCpuMs.p95.toFixed(2)}</td><td data-label="Window CPU max">${t.windowCpuMs.max.toFixed(2)}</td><td data-label="setAnimation p95">${t.entryChangeMs.p95.toFixed(3)}</td></tr>`;
    })
    .join("");
  if (!rows) return "";
  return `<h3>Transition windows (switch frame to end of the ${TRANSITION_MIX * 1000} ms crossfade), ms</h3>
    <div class="table"><table><thead><tr><th>Scenario</th><th>Switches</th><th>Window CPU p95</th><th>Window CPU max</th><th>setAnimation p95</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function run(mode: Mode): void {
  start(mode).catch((error: unknown) => {
    running = false;
    document.body.classList.remove("running");
    window.showBenchError?.(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error));
  });
}

window.__benchStart = start;
$("quick").addEventListener("click", () => run("quick"));
$("full").addEventListener("click", () => run("full"));
document.getElementById("long")?.addEventListener("click", () => run("long"));
$("pageStatus").textContent = "Ready. Tap Quick, Full or Long.";
$("build").textContent = `build ${window.BENCH_BUILD.commit} (${window.BENCH_BUILD.built})`;
const params = new URLSearchParams(location.search);
const auto = params.get("autostart");
if (auto) run(auto === "full" ? "full" : auto === "long" ? "long" : "quick");
