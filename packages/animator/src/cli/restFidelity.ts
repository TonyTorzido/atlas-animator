/*
 * Atlas Animator: original implementation.
 *
 * Plan: the rest fidelity gate. The rig at its setup pose must reproduce the source
 * art. `tsx src/cli/restFidelity.ts <rig.anim.json> <source.png> <out prefix> [--controls]`
 * renders the setup pose 1:1 through the game's Pixi page (canvas size, DPR 1) transparent and on
 * three backdrops (dark, light, saturated) and runs four independent checks against the source:
 * - coverage: the alpha masks (alpha >= 128), independent of colour (an opaque pixel that happens
 *   to match the backdrop cannot hide a difference);
 * - colour: per backdrop, the composited colour of every foreground pixel within TOLERANCE;
 * - ink: the dark line map (outlines and interior strokes), source ink without rig ink within
 *   1 px and rig ink without source ink within 1 px;
 * - locality: the largest 8-connected cluster of failing pixels for each check (a missing chunk,
 *   a removed line, a hole or a shifted limb is a cluster, not a scatter).
 * The AA band is explicit and narrow: pixels within 1 px of an alpha edge of either image or of a
 * hard colour step in the source; it is excluded from the shares and the clusters, and its share
 * of the foreground is reported. `--controls` first runs the same metric on damaged copies of the
 * source (missing silhouette chunk, removed thin line, shifted limb, clothing hole: each must fail)
 * and on benign copies (1 px blur, half-pixel shift: each must pass).
 */
import { writeFileSync } from "node:fs";
import { decodePng, readPng, writePng } from "../tools/png.js";
import type { RgbaImage } from "../tools/image.js";
import { renderFrames } from "./render.js";

export const FIDELITY = {
  tolerance: 32,
  /** Neighbour colour step in the source that marks an AA edge (max channel, 0..255). */
  edge: 48,
  colourShare: 0.99,
  coverageShare: 0.01,
  maxCluster: 48,
  inkLuma: 90
} as const;
export const BACKDROPS: Record<string, [number, number, number]> = { dark: [0x2b, 0x2b, 0x2b], light: [0xf2, 0xf2, 0xf2], saturated: [0x2a, 0x7d, 0xe1] };

export interface FidelityReport {
  foreground: number;
  aaBandShare: number;
  coverage: { mismatch: number; share: number; maxCluster: number; at: number[]; pass: boolean };
  colour: Record<string, { share: number; maxCluster: number; at: number[]; pass: boolean }>;
  ink: { sourceInk: number; missing: number; extra: number; maxMissingCluster: number; missingAt: number[]; maxExtraCluster: number; extraAt: number[]; pass: boolean };
  pass: boolean;
}

/** Size of the largest 8-connected cluster (and its bounding box in `lastBox`). */
let lastBox: [number, number, number, number] = [0, 0, 0, 0];
function maxCluster(mask: Uint8Array, w: number, h: number): number {
  const seen = new Uint8Array(mask.length);
  let best = 0;
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let n = 0;
    let bx: [number, number, number, number] = [w, h, 0, 0];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop() as number;
      n++;
      const x = j % w;
      const y = (j - x) / w;
      bx = [Math.min(bx[0], x), Math.min(bx[1], y), Math.max(bx[2], x), Math.max(bx[3], y)];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (n > best) { best = n; lastBox = bx; }
  }
  return best;
}

/**
 * The metric. `rig` is the transparent render; `onBack` the renders on each backdrop (if absent,
 * the transparent render is composited, as for the controls, which are images, not renders).
 */
export function restFidelity(art: RgbaImage, rig: RgbaImage, onBack?: Record<string, RgbaImage>): { report: FidelityReport; heat: RgbaImage } {
  if (art.width !== rig.width || art.height !== rig.height) throw new Error(`size mismatch: art ${art.width}x${art.height}, rig ${rig.width}x${rig.height}`);
  const { width: w, height: h } = art;
  const N = w * h;
  const alpha = (img: RgbaImage, i: number) => img.data[i * 4 + 3] as number;
  const comp = (img: RgbaImage, i: number, c: number, back: readonly number[]) => {
    const a = alpha(img, i) / 255;
    return (img.data[i * 4 + c] as number) * a + (back[c] as number) * (1 - a);
  };
  const covA = new Uint8Array(N);
  const covR = new Uint8Array(N);
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    covA[i] = alpha(art, i) >= 128 ? 1 : 0;
    covR[i] = alpha(rig, i) >= 128 ? 1 : 0;
    fg[i] = alpha(art, i) >= 16 || alpha(rig, i) >= 16 ? 1 : 0;
  }
  // explicit AA band
  const band = new Uint8Array(N);
  const dark = FIDELITY.edge;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!fg[i]) continue;
    outer: for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = ny * w + nx;
      if (covA[k] !== covA[i] || covR[k] !== covR[i]) { band[i] = 1; break outer; }
      let cd = 0;
      for (let c = 0; c < 3; c++) cd = Math.max(cd, Math.abs(comp(art, i, c, BACKDROPS.dark as number[]) - comp(art, k, c, BACKDROPS.dark as number[])));
      if (cd > dark) { band[i] = 1; break outer; }
    }
  }
  let fgN = 0;
  let bandN = 0;
  for (let i = 0; i < N; i++) if (fg[i]) { fgN++; if (band[i]) bandN++; }
  const scored = fgN - bandN;
  // coverage
  const covBad = new Uint8Array(N);
  let covN = 0;
  for (let i = 0; i < N; i++) if (covA[i] !== covR[i] && !band[i]) { covBad[i] = 1; covN++; }
  const coverage = { mismatch: covN, share: +(covN / Math.max(1, scored)).toFixed(5), maxCluster: maxCluster(covBad, w, h), at: [...lastBox], pass: false };
  coverage.pass = coverage.share <= FIDELITY.coverageShare && coverage.maxCluster < FIDELITY.maxCluster;
  // colour per backdrop
  const colour: FidelityReport["colour"] = {};
  const heat = { width: w, height: h, data: new Uint8Array(N * 4) };
  for (const [name, back] of Object.entries(BACKDROPS)) {
    const img = onBack?.[name];
    const bad = new Uint8Array(N);
    let ok = 0;
    for (let i = 0; i < N; i++) {
      if (!fg[i] || band[i]) continue;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(comp(art, i, c, back) - (img ? (img.data[i * 4 + c] as number) : comp(rig, i, c, back))));
      if (d <= FIDELITY.tolerance) ok++;
      else bad[i] = 1;
    }
    const share = ok / Math.max(1, scored);
    const mc = maxCluster(bad, w, h);
    colour[name] = { share: +share.toFixed(5), maxCluster: mc, at: [...lastBox], pass: share >= FIDELITY.colourShare && mc < FIDELITY.maxCluster };
    if (name === "dark") for (let i = 0; i < N; i++) {
      const g = Math.round(comp(art, i, 0, back) * 0.15 + comp(art, i, 1, back) * 0.15 + comp(art, i, 2, back) * 0.15);
      heat.data.set(bad[i] ? [255, 0, 0, 255] : band[i] && fg[i] ? [70, 60, 20, 255] : [g, g, g, 255], i * 4);
    }
  }
  // ink map: dark opaque pixels (outlines and interior strokes)
  const ink = (img: RgbaImage, i: number) => {
    if (alpha(img, i) < 128) return false;
    const l = 0.3 * (img.data[i * 4] as number) + 0.59 * (img.data[i * 4 + 1] as number) + 0.11 * (img.data[i * 4 + 2] as number);
    return l < FIDELITY.inkLuma;
  };
  const inkA = new Uint8Array(N);
  const inkR = new Uint8Array(N);
  for (let i = 0; i < N; i++) { inkA[i] = ink(art, i) ? 1 : 0; inkR[i] = ink(rig, i) ? 1 : 0; }
  const near = (m: Uint8Array, x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) return true;
    }
    return false;
  };
  const miss = new Uint8Array(N);
  const extra = new Uint8Array(N);
  let srcInk = 0;
  let missN = 0;
  let extraN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (inkA[i]) { srcInk++; if (!near(inkR, x, y)) { miss[i] = 1; missN++; } }
    if (inkR[i] && !near(inkA, x, y)) { extra[i] = 1; extraN++; }
    if (miss[i]) heat.data.set([0, 220, 255, 255], i * 4);
    if (extra[i]) heat.data.set([255, 0, 255, 255], i * 4);
  }
  const inkR2 = { sourceInk: srcInk, missing: missN, extra: extraN, maxMissingCluster: maxCluster(miss, w, h), missingAt: [...lastBox], maxExtraCluster: maxCluster(extra, w, h), extraAt: [...lastBox], pass: false };
  inkR2.pass = inkR2.maxMissingCluster < FIDELITY.maxCluster && inkR2.maxExtraCluster < FIDELITY.maxCluster;
  const report: FidelityReport = {
    foreground: fgN, aaBandShare: +(bandN / Math.max(1, fgN)).toFixed(4), coverage, colour, ink: inkR2,
    pass: coverage.pass && Object.values(colour).every((c) => c.pass) && inkR2.pass
  };
  return { report, heat };
}

/** Damaged and benign copies of the source for validating the metric (boxes from its own alpha). */
export function fidelityControls(art: RgbaImage): { name: string; expect: "fail" | "pass"; image: RgbaImage }[] {
  const { width: w, height: h } = art;
  const copy = () => ({ width: w, height: h, data: new Uint8Array(art.data) });
  const op = (x: number, y: number) => (art.data[(y * w + x) * 4 + 3] as number) >= 128;
  const lum = (img: RgbaImage, x: number, y: number) => 0.3 * (img.data[(y * w + x) * 4] as number) + 0.59 * (img.data[(y * w + x) * 4 + 1] as number) + 0.11 * (img.data[(y * w + x) * 4 + 2] as number);
  // bounding box of the opaque art, and the horizontal centre
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (op(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const cx = Math.round((x0 + x1) / 2);
  const out: { name: string; expect: "fail" | "pass"; image: RgbaImage }[] = [];
  // 1 missing silhouette chunk: the outermost opaque 14 x 14 px at the widest row (a fist edge)
  {
    const img = copy();
    let bestY = y0;
    let bestW = 0;
    for (let y = y0; y <= y1; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (op(x, y)) { if (a < 0) a = x; b = x; } if (b - a > bestW) { bestW = b - a; bestY = y; } }
    let xa = 0;
    while (!op(xa, bestY)) xa++;
    for (let y = bestY - 7; y < bestY + 7; y++) for (let x = xa; x < xa + 14; x++) img.data[(y * w + x) * 4 + 3] = 0;
    out.push({ name: "missing silhouette chunk", expect: "fail", image: img });
  }
  // 2 removed thin line: the first ink run of thickness <= 14 px met walking down a column left of
  // the centre from 60% height (a hem or seam line); its ink over a 40 px span becomes the pixel above
  {
    const img = copy();
    const colX = cx - 30;
    let yy = Math.round(y0 + (y1 - y0) * 0.6);
    let a = -1;
    let b = -1;
    for (; yy < y1; yy++) {
      const isInk = op(colX, yy) && lum(art, colX, yy) < FIDELITY.inkLuma;
      if (isInk && a < 0) a = yy;
      if (!isInk && a >= 0) { b = yy; if (b - a <= 18 && op(colX, a - 2) && op(colX, b + 1)) break; a = -1; b = -1; }
    }
    if (a < 0 || b < 0) throw new Error("controls: no thin line found on the probe column");
    let removed = 0;
    for (let x = colX - 20; x < colX + 20; x++) for (let y = a - 4; y <= b + 4; y++) {
      if (!(op(x, y) && lum(art, x, y) < FIDELITY.inkLuma)) continue;
      let sy = y;
      while (sy > 0 && lum(art, x, sy) < FIDELITY.inkLuma) sy--;
      img.data.set(art.data.subarray((sy * w + x) * 4, (sy * w + x) * 4 + 4), (y * w + x) * 4);
      removed++;
    }
    out.push({ name: `removed thin line (${removed} ink px at y ${a}..${b})`, expect: "fail", image: img });
  }
  // 3 shifted limb: the left third of the figure between 45% and 75% of its height moved 4 px
  {
    const img = copy();
    const ya = Math.round(y0 + (y1 - y0) * 0.45);
    const yb = Math.round(y0 + (y1 - y0) * 0.75);
    const xb = Math.round(x0 + (x1 - x0) * 0.25);
    for (let y = ya; y < yb; y++) for (let x = xb; x >= x0 - 6; x--) {
      const sx = x - 4;
      img.data.set(sx >= 0 ? art.data.subarray((y * w + sx) * 4, (y * w + sx) * 4 + 4) : [0, 0, 0, 0], (y * w + x) * 4);
    }
    out.push({ name: "shifted limb (4 px)", expect: "fail", image: img });
  }
  // 4 hole in the clothing: a 12 x 12 px patch in the backdrop colour on the first fully opaque,
  // light 12 x 12 block found walking down the centre-left column from 55% height
  {
    const img = copy();
    const colX = cx - 40;
    let yy = Math.round(y0 + (y1 - y0) * 0.55);
    const light = (x: number, y: number) => op(x, y) && lum(art, x, y) > 170;
    for (; yy < y1 - 12; yy++) {
      let all = true;
      for (let y = yy; y < yy + 12 && all; y++) for (let x = colX; x < colX + 12; x++) if (!light(x, y)) { all = false; break; }
      if (all) break;
    }
    for (let y = yy; y < yy + 12; y++) for (let x = colX; x < colX + 12; x++) img.data.set([0x2b, 0x2b, 0x2b, 255], (y * w + x) * 4);
    out.push({ name: `clothing hole (opaque, backdrop coloured, at ${colX},${yy})`, expect: "fail", image: img });
  }
  // 5 benign: 1 px binomial blur (anti-aliasing differences)
  {
    const img = copy();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += (art.data[((y + dy) * w + x + dx) * 4 + c] as number) * (dx ? 1 : 2) * (dy ? 1 : 2);
      img.data[(y * w + x) * 4 + c] = Math.round(s / 16);
    }
    out.push({ name: "benign 1 px blur", expect: "pass", image: img });
  }
  // 6 benign: half-pixel horizontal shift (average of neighbours)
  {
    const img = copy();
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) for (let c = 0; c < 4; c++) img.data[(y * w + x) * 4 + c] = Math.round(((art.data[(y * w + x) * 4 + c] as number) + (art.data[(y * w + x - 1) * 4 + c] as number)) / 2);
    out.push({ name: "benign half-pixel shift", expect: "pass", image: img });
  }
  return out;
}

/** `animator rest-fidelity <doc> <source.png> [--out prefix] [--controls]`: writes the report, returns the exit code. */
export async function restFidelityCommand(docPath: string, artPath: string, prefix: string, controlsToo: boolean): Promise<number> {
  const art = readPng(artPath);
  const out: Record<string, unknown> = { thresholds: FIDELITY };
  if (controlsToo) {
    const controls = fidelityControls(art).map((c) => {
      const { report } = restFidelity(art, c.image);
      const got = report.pass ? "pass" : "fail";
      return { name: c.name, expect: c.expect, got, ok: got === c.expect, failing: [!report.coverage.pass && "coverage", Object.entries(report.colour).filter(([, v]) => !v.pass).map(([k]) => `colour:${k}`).join(","), !report.ink.pass && "ink"].filter(Boolean) };
    });
    out.controls = controls;
    out.controlsOk = controls.every((c) => c.ok);
    process.stdout.write(`${JSON.stringify(controls)}\n`);
  }
  const res = await renderFrames({ document: docPath, clip: null, scale: 1, width: art.width, height: art.height, background: null });
  const rig = decodePng(res.frames[0]?.png as Buffer);
  const onBack: Record<string, RgbaImage> = {};
  for (const [name, b] of Object.entries(BACKDROPS)) {
    const r = await renderFrames({ document: docPath, clip: null, scale: 1, width: art.width, height: art.height, background: (b[0] << 16) | (b[1] << 8) | b[2] });
    onBack[name] = decodePng(r.frames[0]?.png as Buffer);
  }
  const { report, heat } = restFidelity(art, rig, onBack);
  out.rig = report;
  writeFileSync(`${prefix}.json`, `${JSON.stringify(out, null, 1)}\n`);
  writePng(`${prefix}-heatmap.png`, heat);
  const side = { width: art.width * 3, height: art.height, data: new Uint8Array(art.width * 3 * art.height * 4) };
  const dk = onBack.dark as RgbaImage;
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) {
    const i = y * art.width + x;
    const a = (art.data[i * 4 + 3] as number) / 255;
    for (let c = 0; c < 3; c++) side.data[(y * art.width * 3 + x) * 4 + c] = Math.round((art.data[i * 4 + c] as number) * a + 0x2b * (1 - a));
    side.data.set(dk.data.subarray(i * 4, i * 4 + 3), (y * art.width * 3 + art.width + x) * 4);
    side.data.set(heat.data.subarray(i * 4, i * 4 + 3), (y * art.width * 3 + 2 * art.width + x) * 4);
    for (let k = 0; k < 3; k++) side.data[(y * art.width * 3 + k * art.width + x) * 4 + 3] = 255;
  }
  writePng(`${prefix}-side.png`, side);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stdout.write(`rest fidelity ${report.pass ? "PASS" : "FAIL"}: coverage ${report.coverage.pass ? "ok" : `max cluster ${report.coverage.maxCluster} at ${report.coverage.at.join(",")}`}, ink ${report.ink.pass ? "ok" : `missing cluster ${report.ink.maxMissingCluster}, extra cluster ${report.ink.maxExtraCluster}`}, colour ${Object.entries(report.colour).map(([k, v]) => `${k} ${v.pass ? "ok" : `${(v.share * 100).toFixed(2)}% cluster ${v.maxCluster}`}`).join(" / ")}; wrote ${prefix}.json, -heatmap.png, -side.png\n`);
  return report.pass ? 0 : 1;
}

if (process.argv[1]?.endsWith("restFidelity.ts")) {
  const [docPath, artPath, prefix] = process.argv.slice(2) as [string, string, string];
  restFidelityCommand(docPath, artPath, prefix, process.argv.includes("--controls")).then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
