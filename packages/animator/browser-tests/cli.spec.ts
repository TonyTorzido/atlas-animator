import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type TestInfo } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/*
 * Phase 5: the CLI's headless render (render-page/ through Playwright Chromium + SwiftShader).
 * The setup pose of the three-part fixture, rendered at the Phase 1 harness geometry, must equal
 * the Phase 1 golden; clip renders are deterministic and pinned by their own goldens; and
 * `animator render ... --mp4 --sheet --gif` works from a clean environment (no Studio, minimal env).
 * Regenerate goldens on purpose only: ANIMATOR_UPDATE_GOLDENS=1. The CLI runs as a child process
 * (Playwright's own TS transform does not load the core's class fields).
 */

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const fixture = (file: string) => join(packageDir, "fixtures", "rigs", file);
const goldensDir = new URL("./goldens/", import.meta.url);
const UPDATE = process.env.ANIMATOR_UPDATE_GOLDENS === "1";

/** The Phase 1 harness draws the 256 x 256 fixture on a 320 x 320 view at (origin * 320 / 256), scale 1. */
const HARNESS = ["--size", "320x320", "--origin", `${(128 * 320) / 256},${(230 * 320) / 256}`, "--scale", "1"];

/** Runs `animator <args>` in a child process with a minimal environment (a "clean shell"). */
function animator(args: string[]): { stdout: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ["--import", "tsx", join(packageDir, "src/cli/animator.ts"), ...args], { cwd: packageDir, env, encoding: "utf8", timeout: 110_000 });
  expect(result.status, `animator ${args.join(" ")}
${result.stdout}
${result.stderr}`).toBe(0);
  return { stdout: result.stdout };
}

function frames(dir: string): Buffer[] {
  return readdirSync(dir).filter((file) => file.endsWith(".png")).sort().map((file) => readFileSync(join(dir, file)));
}

let work = "";
test.beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "animator-cli-"));
});
test.afterEach(() => rmSync(work, { recursive: true, force: true }));
test.setTimeout(150_000);

function expectGolden(name: string, bytes: Buffer, testInfo: TestInfo): void {
  const png = PNG.sync.read(bytes);
  const goldenUrl = new URL(`${name}.png`, goldensDir);
  if (UPDATE && !name.startsWith("three-part")) {
    writeFileSync(goldenUrl, PNG.sync.write(png));
    return;
  }
  const golden = PNG.sync.read(readFileSync(goldenUrl));
  expect([png.width, png.height]).toEqual([golden.width, golden.height]);
  const diff = new PNG({ width: png.width, height: png.height });
  const mismatched = pixelmatch(png.data, golden.data, diff.data, png.width, png.height, { threshold: 0.1, includeAA: false });
  if (mismatched > 0) {
    writeFileSync(testInfo.outputPath(`${name}-actual.png`), PNG.sync.write(png));
    writeFileSync(testInfo.outputPath(`${name}-diff.png`), PNG.sync.write(diff));
  }
  expect(mismatched, `${name}: pixels differing from the golden`).toBe(0);
}

test("the setup pose rendered by the CLI renderer equals the Phase 1 golden", async () => {
  const testInfo = test.info();
  const { stdout } = animator(["render", fixture("three-part.anim.json"), ...HARNESS, "--skins", "body", "--png", join(work, "setup.png")]);
  expect(stdout).toMatch(/rendered 1 frame\(s\) of the setup pose at 320x320, 30 fps \(.*SwiftShader/);
  expect(stdout).not.toMatch(/missing textures/);
  expectGolden("three-part-bare", readFileSync(join(work, "setup.png")), testInfo);
});

test("clip renders are deterministic and match their goldens", async () => {
  const testInfo = test.info();
  const args = ["render", fixture("three-part.anim.json"), "--clip", "attack", "--fps", "30", ...HARNESS, "--skins", "body,tunic"];
  animator([...args, "--png-dir", join(work, "a")]);
  animator([...args, "--png-dir", join(work, "b")]);
  const first = frames(join(work, "a"));
  const second = frames(join(work, "b"));
  expect(first).toHaveLength(Math.round(0.9 * 30) + 1);
  first.forEach((frame, i) => expect(frame.equals(second[i] as Buffer), `frame ${i} bytes`).toBe(true));
  for (const i of [0, 9, 14, 27]) expectGolden(`cli-attack-${String(i).padStart(3, "0")}`, first[i] as Buffer, testInfo);
  expect((first[0] as Buffer).equals(first[14] as Buffer), "the pose moves").toBe(false);
});

test("animator render writes MP4, GIF and a contact sheet from a clean environment", async () => {
  for (const file of ["three-part.anim.json", "three-part.atlas.json", "three-part.atlas.png"]) copyFileSync(fixture(file), join(work, file));
  const { stdout } = animator(["render", join(work, "three-part.anim.json"), "--clip", "idle", "--mp4", join(work, "out.mp4"), "--gif", join(work, "out.gif"), "--sheet", join(work, "sheet.png"), "--scale", "1"]);
  expect(stdout).toMatch(/rendered 72 frame\(s\) of idle at 256x256, 30 fps/);
  for (const file of ["out.mp4", "out.gif", "sheet.png"]) expect(existsSync(join(work, file)), file).toBe(true);
  expect(readFileSync(join(work, "out.mp4")).subarray(4, 8).toString("latin1")).toBe("ftyp");
  expect(readFileSync(join(work, "out.gif")).subarray(0, 6).toString("latin1")).toBe("GIF89a");
  const sheet = PNG.sync.read(readFileSync(join(work, "sheet.png")));
  expect(sheet.width).toBeGreaterThan(4 * 256);
  expect(sheet.height).toBeGreaterThan(2 * 256);
});

/*
 * Plan: the CPU review rasteriser (softRender: validators, weight overviews, contact sheets)
 * must register art exactly where the Pixi page draws it. The fox (fixtures/rigs/fox, from
 * mob-rig-test-01) remeshed past 1024 vertices used to lose every triangle past the CPU's fixed
 * world buffer. Both renders of the setup pose, alpha >= 128 silhouettes, must agree.
 */
test("the CPU review renderer and the Pixi page give the same fox silhouette (dense mesh)", async ({}, testInfo) => {
  for (const file of ["fox.anim.json", "fox.atlas.json", "fox.atlas.png"]) copyFileSync(join(packageDir, "fixtures", "rigs", "fox", file), join(work, file));
  const doc = join(work, "fox.anim.json");
  animator(["apply", doc, JSON.stringify({ op: "mesh.generate", skin: "body", slot: "fox", name: "fox", spacing: 9 })]);
  const vertices = (JSON.parse(readFileSync(doc, "utf8")).skins.body.attachments.fox.fox.uvs as number[]).length / 2;
  expect(vertices).toBeGreaterThan(1024);
  animator(["render", doc, "--png", join(work, "pixi.png"), "--background", "transparent", "--scale", "1"]);
  const cpu = spawnSync(process.execPath, ["--import", "tsx", join(packageDir, "browser-tests/tools/cpuRender.ts"), doc, join(work, "fox.atlas.json"), join(work, "cpu.png")], { cwd: packageDir, encoding: "utf8", timeout: 110_000 });
  expect(cpu.status, cpu.stderr).toBe(0);
  const pixi = PNG.sync.read(readFileSync(join(work, "pixi.png")));
  const soft = PNG.sync.read(readFileSync(join(work, "cpu.png")));
  expect([soft.width, soft.height]).toEqual([pixi.width, pixi.height]);
  let both = 0;
  let either = 0;
  for (let p = 3; p < pixi.data.length; p += 4) {
    const a = (pixi.data[p] as number) >= 128;
    const b = (soft.data[p] as number) >= 128;
    if (a && b) both++;
    if (a || b) either++;
  }
  await testInfo.attach("pixi.png", { path: join(work, "pixi.png"), contentType: "image/png" });
  await testInfo.attach("cpu.png", { path: join(work, "cpu.png"), contentType: "image/png" });
  expect(either).toBeGreaterThan(50_000);
  expect(both / either).toBeGreaterThan(0.98);
});

test("the browser render draws the tunic's own flank strokes in the body ink (garment probe)", async ({}, testInfo) => {
  // The probe's tunic owns its outline as mesh-bound strokes (edge_* contours) and has no painted
  // edge band, so the dark line on its flank in the Pixi page is the stroke itself.
  const rig = join(packageDir, "fixtures/test-rigs/probe");
  const doc = join(rig, "template7-shoulder-probe-tunic.anim.json");
  const raw = JSON.parse(readFileSync(doc, "utf8"));
  const strokes = Object.values(raw.skins[Object.keys(raw.skins)[0] as string].contours as Record<string, Record<string, { color: string }>>).flatMap((byName) => Object.entries(byName).filter(([name]) => name.startsWith("edge_")).map(([, c]) => c));
  expect(strokes.length, "tunic edge strokes in the probe document").toBeGreaterThan(0);
  const hex = (strokes[0] as { color: string }).color;
  const ink: [number, number, number] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const background: [number, number, number] = [0x2b, 0x2b, 0x2b];
  const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(Math.abs((a[0] as number) - (b[0] as number)), Math.abs((a[1] as number) - (b[1] as number)), Math.abs((a[2] as number) - (b[2] as number)));
  expect(dist(ink, background), "stroke ink must read against the review backdrop").toBeGreaterThan(24);
  animator(["render", doc, "--atlas", join(rig, "template7-shoulder-probe.atlas.json"), "--clip", "idle_wave", "--frames", "1", "--scale", "1", "--background", "2b2b2b", "--png", join(work, "tunic.png")]);
  await testInfo.attach("tunic.png", { path: join(work, "tunic.png"), contentType: "image/png" });
  const png = PNG.sync.read(readFileSync(join(work, "tunic.png")));
  const checker = [[62, 126, 140], [232, 214, 168]];
  // Rows whose left silhouette is the tunic: background, then >= 5 px of stroke ink, then the
  // checker fill (rows where the arm hangs beside the torso start with the arm instead).
  let flankRows = 0;
  for (let y = 0; y < png.height; y++) {
    let x = 0;
    const at = (px: number) => png.data.subarray((y * png.width + px) * 4, (y * png.width + px) * 4 + 3);
    while (x < png.width && dist(at(x), background) <= 24) x++;
    if (x >= png.width) continue;
    let run = 0;
    while (x < png.width && dist(at(x), ink) <= 24) {
      run++;
      x++;
    }
    while (x < png.width && run >= 5 && !checker.some((c) => dist(at(x), c) <= 40) && dist(at(x), ink) > 24 && x < png.width - 1 && run < 40) x++;
    if (run >= 5 && x < png.width && checker.some((c) => dist(at(x), c) <= 40)) flankRows++;
  }
  expect(flankRows, "rows with the tunic flank stroke drawn between backdrop and fill").toBeGreaterThan(60);
});
