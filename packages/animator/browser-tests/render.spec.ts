import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CapeResult, ContourBenchResult, ContourCircleResult, SequenceResult, ThreePartOptions } from "./harness/main.js";

/*
 * Pixi adapter render tests. Phase 1: golden images of the 2-bone strip at 0/45/90 degrees
 * and of the hand-made three-part rig drawn from its fixture atlas, plus analytic pixel probes
 * (where the math says the strip and the head must be) and draw-call counts.
 *
 * Goldens are written by this test, never by hand: run with ANIMATOR_UPDATE_GOLDENS=1 to
 * (re)generate them, and review the PNGs before committing. Comparison: pixelmatch with
 * threshold 0.1 and anti-aliased pixels ignored (includeAA false); zero differing pixels allowed.
 */

const ORIGIN = "http://animator.test";
const harnessDir = fileURLToPath(new URL("./dist/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const goldensDir = new URL("./goldens/", import.meta.url);
const UPDATE = process.env.ANIMATOR_UPDATE_GOLDENS === "1";
const BACKGROUND: Rgb = [0x1e, 0x24, 0x30];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".png": "image/png"
};

type Rgb = [number, number, number];

async function openHarness(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, "");
    const file = path.startsWith("fixtures/") ? fixturesDir + path.slice("fixtures/".length) : harnessDir + (path || "index.html");
    if (!existsSync(file)) return route.fulfill({ status: 404, body: `not found: ${path}` });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => window.animatorHarness !== undefined || window.animatorHarnessError !== undefined);
  const error = await page.evaluate(() => window.animatorHarnessError);
  expect(error, "harness failed to start").toBeUndefined();
}

function decode(result: { png: string }): PNG {
  return PNG.sync.read(Buffer.from(result.png.replace(/^data:image\/png;base64,/, ""), "base64"));
}

function pixel(png: PNG, x: number, y: number): Rgb {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [png.data[i] as number, png.data[i + 1] as number, png.data[i + 2] as number];
}

function expectColour(png: PNG, x: number, y: number, expected: Rgb, tolerance: number, what: string): void {
  const actual = pixel(png, x, y);
  const distance = Math.max(...actual.map((v, i) => Math.abs(v - (expected[i] as number))));
  expect(distance, `${what}: pixel (${x.toFixed(1)}, ${y.toFixed(1)}) is ${actual.join(",")}, expected about ${expected.join(",")}`).toBeLessThanOrEqual(tolerance);
}

function expectNotBackground(png: PNG, x: number, y: number, what: string): void {
  const actual = pixel(png, x, y);
  const distance = Math.max(...actual.map((v, i) => Math.abs(v - (BACKGROUND[i] as number))));
  expect(distance, `${what}: pixel (${x.toFixed(1)}, ${y.toFixed(1)}) is background`).toBeGreaterThan(30);
}

function expectGolden(name: string, png: PNG, testInfo: TestInfo): void {
  const goldenUrl = new URL(`${name}.png`, goldensDir);
  if (UPDATE) {
    writeFileSync(goldenUrl, PNG.sync.write(png));
    testInfo.annotations.push({ type: "golden", description: `wrote ${name}.png` });
    return;
  }
  if (!existsSync(goldenUrl)) throw new Error(`golden ${name}.png is missing; generate it with ANIMATOR_UPDATE_GOLDENS=1`);
  const golden = PNG.sync.read(readFileSync(goldenUrl));
  expect([png.width, png.height], `${name} size`).toEqual([golden.width, golden.height]);
  const diff = new PNG({ width: png.width, height: png.height });
  const mismatched = pixelmatch(png.data, golden.data, diff.data, png.width, png.height, { threshold: 0.1, includeAA: false });
  if (mismatched > 0) {
    writeFileSync(testInfo.outputPath(`${name}-actual.png`), PNG.sync.write(png));
    writeFileSync(testInfo.outputPath(`${name}-diff.png`), PNG.sync.write(diff));
  }
  expect(mismatched, `${name}: pixels differing from the golden`).toBe(0);
}

const renderStrip = (page: Page, theta: number) => page.evaluate((t) => window.animatorHarness!.renderStrip(t), theta);
const renderThreePart = (page: Page, options: ThreePartOptions = {}) =>
  page.evaluate((o) => window.animatorHarness!.renderThreePart(o), options);

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test.describe("2-bone strip", () => {
  // The strip's root sits at canvas (40, 120); `lower` starts 120 px along `upper`. A point at
  // distance u along `lower` lands at (40 + 120 + u cos t, 120 + u sin t) when lower is bent by t.
  const alongLower = (u: number, t: number): [number, number] => {
    const r = (t * Math.PI) / 180;
    return [160 + u * Math.cos(r), 120 + u * Math.sin(r)];
  };

  for (const theta of [0, 45, 90]) {
    test(`bent ${theta} degrees matches the analytic pose and its golden`, async ({ page }, testInfo) => {
      const result = await renderStrip(page, theta);
      const png = decode(result);
      expect(result.drawCalls).toBe(1);
      // The upper half never moves.
      expectNotBackground(png, 70, 120, "upper half");
      // Points along the bent lower half are covered...
      for (const u of [30, 60, 90]) expectNotBackground(png, ...alongLower(u, theta), `lower half at u=${u}`);
      // ...and where the straight strip would be is empty once bent.
      if (theta === 90) expectColour(png, 260, 120, BACKGROUND, 2, "straight strip position after bending");
      expectGolden(`strip-${theta}`, png, testInfo);
    });
  }
});

test.describe("three-part rig from the fixture atlas", () => {
  // Rig placement: skeleton origin at (160, 287.5), scale 1. Head centre in skeleton space is
  // (0, -185) at rest; base centre (0, -20); torso (0, -100).
  const FACE: Rgb = [240, 202, 162];
  const SKIN: Rgb = [232, 184, 146];
  const BASE: Rgb = [132, 84, 46];

  test("renders the bare rig: base, torso and head where the rig puts them, in one draw call", async ({ page }, testInfo) => {
    const result = await renderThreePart(page);
    const png = decode(result);
    expect(result.missingTextures).toEqual([]);
    expect(result.drawCalls).toBe(1);
    expectColour(png, 160, 287.5 - 185 + 8, FACE, 24, "head");
    expectColour(png, 160, 287.5 - 20 + 4, BASE, 24, "base");
    expectColour(png, 160 + 10, 287.5 - 100 + 6, SKIN, 24, "torso");
    expectColour(png, 160 + 90, 287.5 - 100, BACKGROUND, 2, "beside the torso");
    expectGolden("three-part-bare", png, testInfo);
  });

  test("the tunic skin draws its linked mesh over the torso", async ({ page }, testInfo) => {
    const png = decode(await renderThreePart(page, { skins: ["body", "tunic"] }));
    expectColour(png, 160 + 10, 287.5 - 70, [64, 152, 76], 30, "tunic over the lower torso");
    expectColour(png, 160 + 10, 287.5 - 152, SKIN, 24, "torso above the tunic"); // image row 8, between bands
    expectGolden("three-part-tunic", png, testInfo);
  });

  test("bending the chest carries the head and bends the torso mesh", async ({ page }, testInfo) => {
    const png = decode(await renderThreePart(page, { skins: ["body", "tunic"], pose: { chest: 60 } }));
    // chest at -30 degrees: head origin (0, -100) + 60 (cos -30, sin -30); centre 25 further on.
    const r = (-30 * Math.PI) / 180;
    const head: [number, number] = [160 + 85 * Math.cos(r), 287.5 - 100 + 85 * Math.sin(r)];
    expectColour(png, head[0], head[1] + 6, FACE, 24, "bent head");
    expectColour(png, 160, 287.5 - 185, BACKGROUND, 2, "rest head position");
    expectGolden("three-part-bent", png, testInfo);
  });

  test("sixteen characters sharing the atlas page draw in one draw call", async ({ page }, testInfo) => {
    const result = await renderThreePart(page, { skins: ["body", "tunic"], count: 16 });
    expect(result.drawCalls).toBe(1);
    expectGolden("three-part-crowd", decode(result), testInfo);
  });

  test("debug overlay: bones, wireframe and chest weights", async ({ page }, testInfo) => {
    const png = decode(await renderThreePart(page, { pose: { chest: 40 }, overlay: true }));
    expectGolden("three-part-overlay", png, testInfo);
  });
});

test.describe("phase 2: scripted idle -> walk -> attack sequence", () => {
  // 3 s at 30 fps on the three-part rig (harness renderSequence): idle, walk from frame 24
  // (0.3 s crossfade), a chest-masked attack on track 1 at frame 45 with a 33 ms hitstop on `hit`.
  const FACE: Rgb = [240, 202, 162];

  test("renders a 3-second PNG sequence that follows the animation state", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const result: SequenceResult = await page.evaluate(() => window.animatorHarness!.renderSequence());
    const { frames, log } = result;
    expect(frames).toHaveLength(90);

    // The PNG sequence itself (review material, not compared): test-results/browser/.../sequence/.
    const dir = testInfo.outputPath("sequence");
    mkdirSync(dir, { recursive: true });
    const pngs = frames.map((frame, i) => {
      writeFileSync(`${dir}/frame-${String(i).padStart(3, "0")}.png`, Buffer.from(frame.png.replace(/^data:image\/png;base64,/, ""), "base64"));
      return decode(frame);
    });

    // Every frame: one draw call, and the face drawn exactly where the posed skeleton puts it.
    pngs.forEach((png, i) => {
      expect(frames[i]?.drawCalls, `frame ${i} draw calls`).toBe(1);
      const [x, y] = frames[i]?.head ?? [0, 0];
      expectColour(png, x, y, FACE, 24, `frame ${i} head centre`);
    });

    // It moves: the head travels during the attack, and idle and walk differ.
    const heads = frames.map((frame) => frame.head);
    const spread = (from: number, to: number) => {
      const xs = heads.slice(from, to).map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spread(45, 75)).toBeGreaterThan(40);
    expect(spread(30, 45)).toBeGreaterThan(5);

    // Callbacks in order, the hit exactly once, footsteps on the walk's beats.
    const lines = (pattern: RegExp) => log.filter((line) => pattern.test(line));
    expect(lines(/start|end|complete attack|hit/)).toEqual([
      "frame 0: start idle",
      "frame 24: start walk",
      "frame 33: end idle",
      "frame 45: start attack",
      // Track time after the update of frame k is (k - 44) / 30: 0.467 at frame 58 passes 0.45.
      "frame 58: event attack hit",
      // The queued fade starts at attack time 0.65 (0.9 - 0.25), shifted by the hitstop; from then
      // the attack is mixing out, so its end is not a `complete` (only current entries complete).
      "frame 65: start <empty>",
      "frame 73: end attack",
      "frame 73: end <empty>"
    ]);
    // Walk steps at track times 0, 0.4, 0.8, ... from frame 24 to 89 (2.2 s): 6 steps.
    expect(lines(/event walk step/)).toHaveLength(6);

    // The hitstop: the update after the hit freezes for 33 ms of its 33.3 ms step.
    const hitFrame = 58;
    const before = frames[hitFrame]?.attackTime ?? Number.NaN;
    const during = frames[hitFrame + 1]?.attackTime ?? Number.NaN;
    expect(during - before).toBeCloseTo(1 / 30 - 0.033, 6);
    expect(Math.hypot(...(heads[hitFrame + 1] ?? [0, 0]).map((v, i) => v - (heads[hitFrame]?.[i] ?? 0)))).toBeLessThan(0.5);

    for (const i of [0, 30, 58]) expectGolden(`sequence-${String(i).padStart(3, "0")}`, pngs[i] as PNG, testInfo);
  });
});

test.describe("phase 3: physics cape swings and settles", () => {
  // The three-part rig wearing a five-link physics cape (harness/capeRig.ts) plays `cape_demo`:
  // the figure sways for 1.25 s, then stands still. 60 Hz game loop, every second frame captured.
  test("renders a 4-second clip: the cape swings, does not jitter at the root, and settles", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const result: CapeResult = await page.evaluate(() => window.animatorHarness!.renderCape());
    const { frames, rest, captureFps } = result;
    expect(frames).toHaveLength(120);

    // Review material: plain and overlay PNG sequences, and a side-by-side MP4 when ffmpeg exists.
    const dir = testInfo.outputPath("cape");
    mkdirSync(`${dir}/plain`, { recursive: true });
    mkdirSync(`${dir}/overlay`, { recursive: true });
    const pngs = frames.map((frame, i) => {
      const name = `frame-${String(i).padStart(3, "0")}.png`;
      writeFileSync(`${dir}/plain/${name}`, Buffer.from(frame.png.replace(/^data:image\/png;base64,/, ""), "base64"));
      writeFileSync(`${dir}/overlay/${name}`, Buffer.from(frame.overlayPng.replace(/^data:image\/png;base64,/, ""), "base64"));
      return decode(frame);
    });
    const video = encodeSideBySide(dir, captureFps);
    testInfo.annotations.push({ type: "video", description: video ?? "ffmpeg not found (set ANIMATOR_FFMPEG); PNG frames only" });
    if (video && (UPDATE || process.env.ANIMATOR_WRITE_DEMOS === "1")) {
      const demos = fileURLToPath(new URL("../../../docs/plans/atlas-animator-demos/", import.meta.url));
      mkdirSync(demos, { recursive: true });
      copyFileSync(video, `${demos}phase-3-cape.mp4`);
    }

    // Every frame: one draw call (cape and body share the atlas page). Near rest (every link within
    // 3 degrees, so the probe point is beside the torso, not swung behind it), cloth is drawn where
    // the skinned cape mesh says it is.
    let probed = 0;
    pngs.forEach((png, i) => {
      expect(frames[i]?.drawCalls, `frame ${i} draw calls`).toBe(1);
      if (frames[i]!.angles.some((angle, link) => Math.abs(angle - (rest[link] ?? 0)) > 3)) return;
      probed++;
      const [x, y] = frames[i]?.cloth ?? [0, 0];
      // Cape colours (cloth, folds, dark outline) are red with green below 60; the torso, the
      // stand and the background are not.
      const [r, g] = pixel(png, x, y);
      expect(r > g + 15 && g < 60 && r > 45, `frame ${i}: cloth pixel (${x.toFixed(1)}, ${y.toFixed(1)}) is ${pixel(png, x, y).join(",")}`).toBe(true);
    });

    expect(probed, "frames near rest that were probed").toBeGreaterThan(50);

    const deviation = (i: number, link: number) => Math.abs((frames[i]?.angles[link] ?? 0) - (rest[link] ?? 0));
    const maxDeviation = (from: number, to: number, link: number) => {
      let max = 0;
      frames.forEach((frame, i) => {
        if (frame.time >= from && frame.time < to) max = Math.max(max, deviation(i, link));
      });
      return max;
    };
    // At rest it hangs straight down from the chest.
    rest.forEach((angle) => expect(angle).toBeCloseTo(90, 6));
    frames[0]?.angles.forEach((angle, link) => expect(angle, `link ${link} at frame 0`).toBeCloseTo(rest[link] ?? 0, 6));

    // It swings: the hem trails well behind the sway, the shoulders a little.
    expect(maxDeviation(0, 2, 4)).toBeGreaterThan(20);
    expect(maxDeviation(0, 2, 0)).toBeGreaterThan(5);
    // No runaway: nothing swings past horizontal.
    for (let link = 0; link < rest.length; link++) expect(maxDeviation(0, 4, link)).toBeLessThan(80);

    // It settles once the figure stops (1.25 s): each half second smaller than the one before, and
    // still within half a degree over the last second.
    for (let link = 0; link < rest.length; link++) {
      const windows = [1.5, 2, 2.5, 3].map((from) => maxDeviation(from, from + 0.5, link));
      for (let w = 1; w < windows.length; w++) expect(windows[w], `link ${link} window ${w}`).toBeLessThan((windows[w - 1] ?? 0) + 1e-6);
      expect(maxDeviation(3, 4, link), `link ${link} after 3 s`).toBeLessThan(0.5);
    }

    // No jitter at the root: the shoulder link's angle is smooth (small second differences, no
    // frame-to-frame flicker), and quiet once settled.
    const root = frames.map((frame) => frame.angles[0] ?? 0);
    let flicker = 0;
    for (let i = 1; i + 1 < root.length; i++) {
      const second = Math.abs((root[i + 1] as number) - 2 * (root[i] as number) + (root[i - 1] as number));
      expect(second, `root link second difference at frame ${i}`).toBeLessThan(frames[i]!.time < 2 ? 4 : 0.2);
      const before = (root[i] as number) - (root[i - 1] as number);
      const after = (root[i + 1] as number) - (root[i] as number);
      if (before * after < 0 && Math.min(Math.abs(before), Math.abs(after)) > 0.05) flicker++;
    }
    // Direction changes happen only at the turning points of a swing (a few per second), never
    // frame to frame.
    expect(flicker).toBeLessThan(12);

    for (const i of [0, 18, 119]) expectGolden(`cape-${String(i).padStart(3, "0")}`, pngs[i] as PNG, testInfo);
  });
});

test.describe(": dynamic contours", () => {
  /**
   * Coverage-aware local width along the deformed centreline, read from the anti-aliased edge
   * pixels themselves: a pixel whose coverage c is strictly between 0 and 1 lies in the 1-pixel
   * ramp, so its centre's distance r to the centreline (nearest point of the polyline, i.e.
   * perpendicular to the curve) gives that side's half width exactly as r + (c - 0.5) * aa.
   * Each side is averaged over the edge pixels whose nearest centreline point falls within
   * +-WINDOW px of arc of a vertex, and the width is the sum of both sides. No image
   * reconstruction is involved, so there is no sub-pixel phase or orientation bias (line or area
   * integrals through the sampled 1-pixel edge read up to 1-1.5% thin at some angles).
   */
  const WINDOW = 4;
  const widths = (result: ContourCircleResult, png: PNG): number[] => {
    const c = result.centreline;
    const n = c.length / 2;
    const aa = 1; // one display pixel (contourPixelScale = the render scale)
    const arcAt: number[] = [0];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      arcAt.push((arcAt[i] as number) + Math.hypot((c[next * 2] as number) - (c[i * 2] as number), (c[next * 2 + 1] as number) - (c[i * 2 + 1] as number)));
    }
    const total = arcAt[n] as number;
    const samples: { arc: number; side: number; half: number }[] = [];
    const xs = c.filter((_, i) => i % 2 === 0);
    const ys = c.filter((_, i) => i % 2 === 1);
    const margin = result.width / 2 + 3;
    for (let py = Math.floor(Math.min(...ys) - margin); py < Math.ceil(Math.max(...ys) + margin); py++) {
      for (let px = Math.floor(Math.min(...xs) - margin); px < Math.ceil(Math.max(...xs) + margin); px++) {
        const value = 1 - (png.data[(py * png.width + px) * 4] as number) / 255;
        if (value <= 0.03 || value >= 0.97) continue;
        const x = px + 0.5;
        const y = py + 0.5;
        let best = Infinity;
        let bestArc = 0;
        let side = 0;
        for (let i = 0; i < n; i++) {
          const next = (i + 1) % n;
          const ax = c[i * 2] as number;
          const ay = c[i * 2 + 1] as number;
          const dx = (c[next * 2] as number) - ax;
          const dy = (c[next * 2 + 1] as number) - ay;
          const length2 = dx * dx + dy * dy;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
          const d = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
          if (d < best) {
            best = d;
            bestArc = (arcAt[i] as number) + t * Math.sqrt(length2);
            side = dx * (y - ay) - dy * (x - ax) > 0 ? 1 : -1;
          }
        }
        samples.push({ arc: bestArc, side, half: Math.sqrt(best) + (value - 0.5) * aa });
      }
    }
    return arcAt.slice(0, n).map((at) => {
      const near = samples.filter((sample) => {
        const d = Math.abs(sample.arc - at);
        return Math.min(d, total - d) <= WINDOW;
      });
      const mean = (side: number) => {
        const list = near.filter((sample) => sample.side === side);
        return list.reduce((sum, sample) => sum + sample.half, 0) / list.length;
      };
      return mean(1) + mean(-1);
    });
  };

  for (const bend of [0, 90]) {
    test(`a stroked circle bent ${bend} degrees keeps its width within 1% at 3x`, async ({ page }, testInfo) => {
      const result: ContourCircleResult = await page.evaluate((b) => window.animatorHarness!.renderContourCircle(b), bend);
      const png = decode(result);
      expect(result.drawCalls).toBe(1);
      writeFileSync(testInfo.outputPath(`contour-circle-bend-${bend}.png`), PNG.sync.write(png));
      const measured = widths(result, png);
      const errors = measured.map((w) => w / result.width - 1);
      const worst = Math.max(...errors.map(Math.abs));
      const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
      testInfo.annotations.push({ type: "width", description: `bend ${bend}: nominal ${result.width} px, mean error ${(mean * 100).toFixed(3)}%, worst ${(worst * 100).toFixed(3)}% over ${measured.length} points` });
      // The circle really deforms when bent (else the test proves nothing): radii from its centroid spread.
      const cl = result.centreline;
      const m = cl.length / 2;
      const cx = cl.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / m;
      const cy = cl.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / m;
      const radii = Array.from({ length: m }, (_, i) => Math.hypot(cl[i * 2]! - cx, cl[i * 2 + 1]! - cy));
      const spread = Math.max(...radii) - Math.min(...radii);
      testInfo.annotations.push({ type: "deformation", description: `bend ${bend}: radius spread ${spread.toFixed(2)} display px` });
      if (bend === 90) expect(spread, "radius spread of the bent circle").toBeGreaterThan(2);
      expect(worst, `worst width error ${(worst * 100).toFixed(3)}%`).toBeLessThanOrEqual(0.01);
      expectGolden(`contour-circle-bend-${bend}`, png, testInfo);
    });
  }

  test("bench: 50 characters with 10 contours each", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const result: ContourBenchResult = await page.evaluate(() => window.animatorHarness!.benchContours(240));
    const contourCost = result.updateMs.animatedWithContours - result.updateMs.animatedWithout;
    const summary = {
      ...result,
      png: undefined,
      contourCostMsPerCharacter: contourCost,
      renderCostMsPerCharacter: result.renderMs.animatedWithContours - result.renderMs.animatedWithout,
      renderer: "pixi webgl swiftshader (headless chromium); CPU-side timings, relative only: SwiftShader is not a phone GPU",
      baseline: "same document and path, contours culled by LOD (contourMinPixels = Infinity)",
      note: "update = skeleton.updateWorldTransform + syncFromSkeleton; animated = every bone moves every frame, so every stroke rebuilds"
    };
    writeFileSync(testInfo.outputPath("contour-bench.json"), JSON.stringify(summary, null, 2));
    writeFileSync(testInfo.outputPath("contour-bench.png"), Buffer.from(result.png.replace(/^data:image\/png;base64,/, ""), "base64"));
    testInfo.annotations.push({ type: "bench", description: JSON.stringify(summary) });
    console.log(`contour bench: ${JSON.stringify(summary)}`);
    expect(result.rebuildsPerFrame.animated).toBeCloseTo(result.contoursPerCharacter, 5);
    expect(result.rebuildsPerFrame.still).toBe(0);
    expect(result.drawCalls).toBe(1);
    // The exit gate on the desktop SwiftShader proxy: <= 0.3 ms per character for the contours,
    // counting both the stroke rebuild/sync (update) and the extra render (batching) they cause.
    const total = contourCost + summary.renderCostMsPerCharacter;
    expect(total, `contour cost ${contourCost.toFixed(4)} update + ${summary.renderCostMsPerCharacter.toFixed(4)} render ms per character`).toBeLessThanOrEqual(0.3);
  });
});

/** Writes cape/cape.mp4: plain and overlay sequences side by side, scaled 2x (nearest). */
function encodeSideBySide(dir: string, fps: number): string | null {
  const ffmpeg = process.env.ANIMATOR_FFMPEG ?? "ffmpeg";
  const probe = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  const out = `${dir}/cape.mp4`;
  const run = spawnSync(
    ffmpeg,
    [
      "-y",
      "-loglevel", "error",
      "-framerate", String(fps), "-i", `${dir}/plain/frame-%03d.png`,
      "-framerate", String(fps), "-i", `${dir}/overlay/frame-%03d.png`,
      "-filter_complex", "[0:v][1:v]hstack=inputs=2,scale=iw*2:ih*2:flags=neighbor[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
      out
    ],
    { encoding: "utf8" }
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  return out;
}
