/*
 * Atlas Animator: original implementation.
 *
 * Headless rendering for the CLI: builds the render page (render-page/, the game's Pixi adapter)
 * with Vite into a content-hashed cache, opens it in headless Chromium with SwiftShader (software
 * WebGL, no GPU or display needed), steps a clip at a fixed rate and collects PNG frames. Outputs:
 * PNG sequence, MP4 (H.264) and GIF (palettegen + paletteuse) through ffmpeg, and labelled
 * contact sheets.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import type { RgbaImage } from "../tools/image.js";
import { decodePng, writePng } from "../tools/png.js";
import { grid, renderTag } from "../tools/review.js";
import type { RenderPageGlobal, RenderPageInfo, RenderPageOptions } from "../../render-page/protocol.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ORIGIN = "http://animator.render";
/** Software WebGL in headless Chromium (research doc 6: never --disable-gpu). */
export const SWIFTSHADER_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
export const DEFAULT_BACKGROUND = 0x1e2430;

export interface RenderOptions {
  /** Plan: time this many frames (no readback) instead of returning PNGs; see RenderResult.bench. */
  bench?: number;
  document: string;
  /** atlas-pack@1 manifest; default `<rig>.atlas.json` beside the document. */
  atlas?: string;
  /** Clip on track 0; null/undefined = setup pose. */
  clip?: string | null;
  /** Clips queued after `clip` (each starts when the previous one ends): a real sequence render, e.g. idle -> attack -> idle. */
  queue?: string[];
  /** Active skins; default the document's first skin (the body). */
  skins?: string[];
  fps?: number;
  /** Frame count; default one loop of the clip (or duration + 1 frame), 1 for the setup pose. */
  frames?: number;
  /** Character scale (output pixels per canvas pixel). */
  scale?: number;
  /** Output size; default the canvas times scale. */
  width?: number;
  height?: number;
  /** Output position of the skeleton origin; default the canvas origin times scale. */
  x?: number;
  y?: number;
  /** 0xRRGGBB or null (transparent). */
  background?: number | null;
  /** Physics warm-up seconds before the first frame. */
  warmup?: number;
}

export interface RenderedFrame {
  time: number;
  png: Buffer;
}

export interface RenderResult {
  bench?: { msPerFrame: number; frames: number };
  frames: RenderedFrame[];
  width: number;
  height: number;
  fps: number;
  clip: string | null;
  renderer: string;
  /** Output pixels per canvas pixel. */
  scale: number;
  missingTextures: string[];
}

// ---------------------------------------------------------------------------------------------
// The page build (cached by the hash of its sources)
// ---------------------------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|html)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

export async function buildRenderPage(): Promise<string> {
  const hash = createHash("sha256");
  for (const dir of ["render-page", "src/core", "src/pixi"]) {
    for (const file of sourceFiles(join(PACKAGE_ROOT, dir)).sort()) hash.update(file.slice(PACKAGE_ROOT.length)).update(readFileSync(file));
  }
  const outDir = join(PACKAGE_ROOT, "node_modules", ".cache", "atlas-animator-render", hash.digest("hex").slice(0, 16));
  if (existsSync(join(outDir, "index.html"))) return outDir;
  await build({
    root: join(PACKAGE_ROOT, "render-page"),
    base: "./",
    logLevel: "warn",
    configFile: false,
    build: { outDir, emptyOutDir: true, sourcemap: false, target: "es2022", chunkSizeWarningLimit: 4096 }
  });
  return outDir;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };

export function defaultAtlasPath(documentPath: string): string {
  return documentPath.replace(/\.anim\.json$/i, ".atlas.json");
}

export async function renderFrames(options: RenderOptions): Promise<RenderResult> {
  const documentPath = resolve(options.document);
  const atlasPath = resolve(options.atlas ?? defaultAtlasPath(documentPath));
  if (!existsSync(atlasPath)) throw new Error(`no atlas at ${atlasPath}; pass --atlas <rig.atlas.json>`);
  const doc = loadAnimDocument(JSON.parse(readFileSync(documentPath, "utf8")), { source: documentPath });
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const clip = options.clip ?? null;
  if (clip !== null && !doc.animations[clip]) throw new Error(`no clip '${clip}'; clips: ${Object.keys(doc.animations).join(", ") || "none"}`);
  const fps = options.fps ?? 30;
  if (!(fps > 0 && fps <= 120)) throw new Error("fps must be in (0, 120]");
  const scale = options.scale ?? 0.5;
  const width = Math.round(options.width ?? doc.canvas.width * scale);
  const height = Math.round(options.height ?? doc.canvas.height * scale);
  const clipData = clip === null ? null : doc.animations[clip];
  const frames = options.frames ?? (clipData ? Math.max(1, clipData.loop ? Math.round(clipData.duration * fps) : Math.round(clipData.duration * fps) + 1) : 1);
  if (!(Number.isInteger(frames) && frames >= 1 && frames <= 3600)) throw new Error("frames must be an integer from 1 to 3600");

  // Only the page build, the document and the atlas files are served (no other disk access).
  const pageDir = await buildRenderPage();
  const files = new Map<string, string>([
    ["/data/document.json", documentPath],
    ["/data/atlas.json", atlasPath],
    ...pack.pages.map((page): [string, string] => [`/data/${page.file}`, join(dirname(atlasPath), page.file)])
  ]);

  const browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(width, 1), height: Math.max(height, 1) }, deviceScaleFactor: 1 });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname);
      const file = path.startsWith("/data/") ? files.get(path) : resolve(pageDir, path.replace(/^\/+/, "") || "index.html");
      const allowed = file !== undefined && (path.startsWith("/data/") || file.startsWith(resolve(pageDir)));
      if (!allowed || !existsSync(file) || !statSync(file).isFile()) return route.fulfill({ status: 404, body: `not found: ${path}` });
      return route.fulfill({ status: 200, body: readFileSync(file), contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => (globalThis as unknown as RenderPageGlobal).animatorRender !== undefined, undefined, { timeout: 30_000 }).catch(() => {
      throw new Error(`render page failed to start${errors.length ? `: ${errors.join("; ")}` : ""}`);
    });
    const pageOptions: RenderPageOptions = {
      documentUrl: `${ORIGIN}/data/document.json`,
      atlasUrl: `${ORIGIN}/data/atlas.json`,
      clip,
      ...(options.queue?.length ? { queue: options.queue } : {}),
      // Default: the first skin (the body), so a wardrobe document does not render every item stacked.
      skins: options.skins ?? Object.keys(doc.skins).slice(0, 1),
      fps,
      warmup: options.warmup ?? (doc.physics.length > 0 ? 1 : 0),
      width,
      height,
      x: options.x ?? doc.canvas.originX * scale,
      y: options.y ?? doc.canvas.originY * scale,
      scale,
      background: options.background === undefined ? DEFAULT_BACKGROUND : options.background
    };
    const info: RenderPageInfo = await page.evaluate((o) => (globalThis as unknown as RenderPageGlobal).animatorRender!.prepare(o), pageOptions);
    if (!/swiftshader/i.test(`${info.renderer} ${info.vendor}`)) throw new Error(`expected SwiftShader WebGL, got '${info.renderer}' (${info.vendor})`);
    if (options.bench) {
      const bench = await page.evaluate((n) => (globalThis as unknown as RenderPageGlobal).animatorRender!.bench(n), options.bench);
      return { frames: [], width, height, fps, clip, renderer: info.renderer, scale, missingTextures: info.missingTextures, bench };
    }
    const out: RenderedFrame[] = [];
    let missing: string[] = info.missingTextures;
    for (let i = 0; i < frames; i++) {
      const frame = await page.evaluate(() => (globalThis as unknown as RenderPageGlobal).animatorRender!.next());
      out.push({ time: frame.time, png: Buffer.from(frame.png.replace(/^data:image\/png;base64,/, ""), "base64") });
      missing = frame.missingTextures;
    }
    await page.evaluate(() => (globalThis as unknown as RenderPageGlobal).animatorRender!.dispose());
    return { frames: out, width, height, fps, clip, renderer: info.renderer, scale, missingTextures: missing };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

/** ffmpeg: ANIMATOR_FFMPEG, else `ffmpeg` on PATH. */
export function ffmpegPath(): string {
  return process.env.ANIMATOR_FFMPEG ?? "ffmpeg";
}

function runFfmpeg(args: string[]): void {
  const result = spawnSync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.error) throw new Error(`could not run ffmpeg (${ffmpegPath()}): ${result.error.message}; install ffmpeg or set ANIMATOR_FFMPEG`);
  if (result.status !== 0) throw new Error(`ffmpeg failed (exit ${result.status}): ${result.stderr.trim()}`);
}

export function writePngSequence(result: RenderResult, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return result.frames.map((frame, i) => {
    const path = join(dir, `frame-${String(i).padStart(4, "0")}.png`);
    writeFileSync(path, frame.png);
    return path;
  });
}

function withFrames<T>(result: RenderResult, use: (pattern: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "atlas-animator-"));
  try {
    writePngSequence(result, dir);
    return use(join(dir, "frame-%04d.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeMp4(result: RenderResult, path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  withFrames(result, (pattern) =>
    runFfmpeg(["-framerate", String(result.fps), "-i", pattern, "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", resolve(path)])
  );
}

export function writeGif(result: RenderResult, path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  withFrames(result, (pattern) =>
    runFfmpeg(["-framerate", String(result.fps), "-i", pattern, "-filter_complex", "split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none", "-loop", "0", resolve(path)])
  );
}

/** Evenly spaced frame indices (first and last included). */
export function sampleIndices(total: number, count: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count <= 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1))))];
}

export function contactSheet(result: RenderResult, options: { count?: number; columns?: number } = {}): RgbaImage {
  const tiles = contactSheetTiles(result, options.count ?? 8);
  return grid(tiles, options.columns ?? Math.min(4, tiles.length), 2, true);
}

/** The tiles of `contactSheet`: label "<clip> <time>s", then the render tag on a second line. */
export function contactSheetTiles(result: RenderResult, count = 8): { image: RgbaImage; label: string }[] {
  // The page renders at resolution 1 with deviceScaleFactor 1 and linear texture sampling.
  const tag = renderTag({ scale: result.scale, dpr: 1, filter: "linear", renderer: "pixi webgl swiftshader" });
  return sampleIndices(result.frames.length, count).map((i) => {
    const frame = result.frames[i] as RenderedFrame;
    return { image: decodePng(frame.png), label: `${result.clip ?? "setup"} ${frame.time.toFixed(2)}s\n${tag}` };
  });
}

export function writeSheet(result: RenderResult, path: string, options: { count?: number; columns?: number } = {}): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writePng(resolve(path), contactSheet(result, options));
}
