/*
 * Atlas Animator: original implementation.
 *
 * `animator layers check`. Proposed initial project
 * thresholds, not universal standards:
 *
 * - Rest assembly: the layers composited back to front at native resolution against the source,
 *   in premultiplied 8-bit RGBA. Protected pixels (foreground union minus the declared boundary
 *   bands: the parts' uncertain masks, and their completion masks, which sit behind front pixels
 *   that may be a level or two short of opaque) must match within one level; at least 99% of
 *   band pixels within 3/255 per channel. Foreground and band denominators are separate and the
 *   transparent canvas never counts.
 * - Joint coverage, per joint and probe (the child's subtree rotated about the pivot): no
 *   background crack inside the joint's coverage region (rest coverage mask and its rotation), and
 *   no exposed cut cap (a layer edge that is not the source silhouette, drawn on top, next to
 *   background) near the joint.
 * - Outline continuity, on light and dark backgrounds: near each joint the posed silhouette keeps
 *   its outline (fraction of silhouette pixels that are ink, at most 10 points under the rest
 *   source's), interior ink does not grow (duplicate rim or buried seam: at most
 *   max(8, 15% of rest)), and no layer edge pixel outside the source's own pixels carries a
 *   foreign fringe colour (semi-transparent, far from the outline colour).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createImage, createMask, type Mask, type MutableImage, type RgbaImage } from "../image.js";
import { readPng, writePng } from "../png.js";
import { drawText } from "../review.js";
import { alphaAt, compositeLayers, distanceInside, inverseSample, luma, premul, readMaskPng, rotation, sha256File, type Rotation } from "./core.js";
import { inkMask, jointExpected, probeDegrees, staticHullMask, type OutlineMeasure } from "./plan.js";
import { isUnder, rigView } from "./rig.js";
import { readJson, readManifest, writeJson, writeManifest } from "./files.js";
import { resolveRef, type LayerManifest } from "./manifest.js";

export interface ProbeResult {
  name: string;
  degrees: number;
  cracks: number;
  exposedCaps: number;
  outline: { light: number; dark: number; baseline: number; pass: boolean };
  interiorInkDelta: number;
  pass: boolean;
}

export interface CheckReport {
  version: 1;
  manifest: { sha256: string };
  rest: {
    protected: { pixels: number; over1: number; maxDiff: number; pass: boolean };
    band: { pixels: number; within3: number; fraction: number; pass: boolean };
    pass: boolean;
  };
  joints: { parent: string; child: string; pivotBone: string; pivot: [number, number]; radius: number; probes: ProbeResult[]; coverage: boolean; outline: boolean }[];
  fringe: { pixels: number; pass: boolean };
  gates: { rest: boolean; coverage: boolean; outline: boolean; fringe: boolean };
  pass: boolean;
}

export interface CheckInputs {
  source: RgbaImage;
  layers: RgbaImage[];
  ids: string[];
  uncertain: Mask[];
  /** Completion masks: hidden at rest, but behind front pixels a few levels short of opaque. */
  completion: Mask[];
  joints: { parent: string; child: string; pivotBone: string; pivot: [number, number]; coverage: Mask; degrees: number[]; probeNames: string[]; moving: boolean[]; backMoving: boolean; staticHull: Mask }[];
  inkThreshold: number;
  outlineWidth: number;
  maxLineWidth: number;
  outlineColor: [number, number, number] | null;
}

const LIGHT: [number, number, number] = [240, 240, 236];
const DARK: [number, number, number] = [24, 26, 32];

/** The checks over loaded inputs (layers in draw order, back to front). */
export function checkLayers(inp: CheckInputs): { report: Omit<CheckReport, "manifest">; sheet: MutableImage } {
  const { source, layers } = inp;
  const { width: w, height: h } = source;
  // --- rest -----------------------------------------------------------------------------------
  const rest = compositeLayers(layers, w, h);
  const band = createMask(w, h);
  for (const m of [...inp.uncertain, ...inp.completion]) for (let i = 0; i < band.data.length; i++) if (m.data[i]) band.data[i] = 1;
  let pPixels = 0;
  let over1 = 0;
  let maxDiff = 0;
  let bPixels = 0;
  let within3 = 0;
  const diff = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const sa = alphaAt(source, i);
    const ra = alphaAt(rest, i);
    if (sa === 0 && ra === 0) continue;
    let d = Math.abs(sa - ra);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(premul(source.data[i * 4 + c] as number, sa) - premul(rest.data[i * 4 + c] as number, ra)));
    diff[i] = d;
    if (band.data[i]) {
      bPixels++;
      if (d <= 3) within3++;
    } else {
      pPixels++;
      if (d > 1) over1++;
      maxDiff = Math.max(maxDiff, d);
    }
  }
  const fraction = bPixels > 0 ? within3 / bPixels : 1;
  const restReport = {
    protected: { pixels: pPixels, over1, maxDiff, pass: over1 === 0 },
    band: { pixels: bPixels, within3, fraction: Math.round(fraction * 1e5) / 1e5, pass: fraction >= 0.99 },
    pass: over1 === 0 && fraction >= 0.99
  };

  // --- per-layer cut edges (a layer edge that is not the source silhouette) --------------------
  const solid = (i: number) => alphaAt(source, i) >= 128;
  const cut = layers.map((layer) => {
    const m = createMask(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (alphaAt(layer, i) < 128) continue;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (alphaAt(layer, j) < 128 && solid(j)) m.data[i] = 1;
        }
      }
    }
    return m;
  });

  // --- joints -----------------------------------------------------------------------------------
  const isInkPx = (img: RgbaImage, i: number) => alphaAt(img, i) >= 128 && luma(img, i) < inp.inkThreshold;
  const jointReports: CheckReport["joints"] = [];
  const tiles: { label: string; image: MutableImage; marks?: { cracks: Mask; caps: Mask } }[] = [];
  const bounds = sourceBounds(source, 16);
  for (const joint of inp.joints) {
    const [px, py] = joint.pivot;
    let radius = 0;
    for (let i = 0; i < w * h; i++) if (joint.coverage.data[i]) radius = Math.max(radius, Math.hypot((i % w) + 0.5 - px, Math.floor(i / w) + 0.5 - py));
    const outer = Math.max(4, 2 * radius);
    const win = { x0: Math.max(0, Math.floor(px - outer - 2)), y0: Math.max(0, Math.floor(py - outer - 2)), x1: Math.min(w - 1, Math.ceil(px + outer + 2)), y1: Math.min(h - 1, Math.ceil(py + outer + 2)) };
    const inOuter = (x: number, y: number) => Math.hypot(x + 0.5 - px, y + 0.5 - py) <= outer;
    const baseline = windowMeasures(source, null, [source], [false], win, inOuter, inp, isInkPx);
    const probes: ProbeResult[] = [];
    let worst: { rot: Rotation; name: string; cracks: Mask; caps: Mask; score: number } | null = null;
    joint.degrees.forEach((degrees, k) => {
      const rot = rotation(px, py, degrees);
      const hullAt = (i: number) => joint.staticHull.data[i] === 1;
      const movingAt = (i: number) => joint.moving.some((m, l) => m && alphaAt(layers[l] as RgbaImage, i) >= 128);
      const staticAt = (i: number) => joint.moving.some((m, l) => !m && alphaAt(layers[l] as RgbaImage, i) >= 128);
      const sample = (layer: number, x: number, y: number) => inverseSample(joint.moving[layer] ? rot : null, w, h, x, y);
      const cracks = createMask(w, h);
      const caps = createMask(w, h);
      let nCracks = 0;
      let nCaps = 0;
      const coveredAt = (x: number, y: number) => {
        for (let l = 0; l < layers.length; l++) {
          const s = sample(l, x, y);
          if (s >= 0 && alphaAt(layers[l] as RgbaImage, s) >= 128) return true;
        }
        return false;
      };
      for (let y = win.y0; y <= win.y1; y++) {
        for (let x = win.x0; x <= win.x1; x++) {
          const i = y * w + x;
          const back = inverseSample(rot, w, h, x, y);
          const expected = jointExpected(joint.coverage, i, back, movingAt, staticAt, !joint.backMoving, hullAt);
          const covered = coveredAt(x, y);
          if (expected && !covered) {
            cracks.data[i] = 1;
            nCracks++;
          }
          if (!covered || !inOuter(x, y)) continue;
          // Topmost layer here: is its pixel a cut edge, next to background?
          for (let l = layers.length - 1; l >= 0; l--) {
            const s = sample(l, x, y);
            if (s < 0 || alphaAt(layers[l] as RgbaImage, s) < 128) continue;
            if ((cut[l] as Mask).data[s]) {
              const open = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => (nx as number) >= 0 && (ny as number) >= 0 && (nx as number) < w && (ny as number) < h && !coveredAt(nx as number, ny as number));
              if (open) {
                caps.data[i] = 1;
                nCaps++;
              }
            }
            break;
          }
        }
      }
      const posed = windowMeasures(source, sample, layers, joint.moving, win, inOuter, inp, isInkPx);
      const outlineOk = posed.light >= baseline.light - 0.1 && posed.dark >= baseline.dark - 0.1;
      const inkDelta = posed.interiorInk - baseline.interiorInk;
      const inkOk = inkDelta <= Math.max(8, 0.15 * baseline.interiorInk);
      const result: ProbeResult = {
        name: joint.probeNames[k] ?? `${joint.pivotBone} rotate ${degrees}`,
        degrees,
        cracks: nCracks,
        exposedCaps: nCaps,
        outline: { light: r3(posed.light), dark: r3(posed.dark), baseline: r3(baseline.light), pass: outlineOk && inkOk },
        interiorInkDelta: inkDelta,
        pass: nCracks === 0 && nCaps === 0 && outlineOk && inkOk
      };
      probes.push(result);
      const score = nCracks + nCaps;
      if (!worst || score > worst.score || (score === worst.score && Math.abs(degrees) > Math.abs(probeDegrees(worst.name) ?? 0))) worst = { rot, name: result.name, cracks, caps, score };
    });
    jointReports.push({
      parent: joint.parent,
      child: joint.child,
      pivotBone: joint.pivotBone,
      pivot: joint.pivot,
      radius: r3(radius),
      probes,
      coverage: probes.every((p) => p.cracks === 0 && p.exposedCaps === 0),
      outline: probes.every((p) => p.outline.pass)
    });
    if (worst) {
      const wst = worst as { rot: Rotation; name: string; cracks: Mask; caps: Mask; score: number };
      const sample = (layer: number, x: number, y: number) => inverseSample(joint.moving[layer] ? wst.rot : null, w, h, x, y);
      tiles.push({ label: `${joint.child} ${probeDegrees(wst.name) ?? ""} LIGHT ${wst.score}`, image: compositeLayers(layers, w, h, sample, LIGHT), marks: { cracks: wst.cracks, caps: wst.caps } });
      tiles.push({ label: `${joint.child} ${probeDegrees(wst.name) ?? ""} DARK`, image: compositeLayers(layers, w, h, sample, DARK), marks: { cracks: wst.cracks, caps: wst.caps } });
    }
  }

  // --- fringe -----------------------------------------------------------------------------------
  let fringe = 0;
  const oc = inp.outlineColor;
  if (oc) {
    for (const layer of layers) {
      for (let i = 0; i < w * h; i++) {
        const a = alphaAt(layer, i);
        if (a === 0 || a >= 240 || alphaAt(source, i) > 0) continue;
        const d = Math.max(Math.abs((layer.data[i * 4] as number) - oc[0]), Math.abs((layer.data[i * 4 + 1] as number) - oc[1]), Math.abs((layer.data[i * 4 + 2] as number) - oc[2]));
        if (d > 96) fringe++;
      }
    }
  }

  const coverage = jointReports.every((j) => j.coverage);
  const outline = jointReports.every((j) => j.outline);
  const gates = { rest: restReport.pass, coverage, outline, fringe: fringe === 0 };
  const diffImage = createImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.min(255, (diff[i] as number) * 32);
    diffImage.data[i * 4] = d > 0 ? 255 : 30;
    diffImage.data[i * 4 + 1] = d > 0 ? 255 - d : alphaAt(source, i) > 0 ? 70 : 30;
    diffImage.data[i * 4 + 2] = d > 0 ? 255 - d : 30;
    diffImage.data[i * 4 + 3] = 255;
  }
  const sheet = contactSheet(
    [
      { label: "SOURCE", image: compositeLayers([source], w, h, undefined, LIGHT) },
      { label: `REST ASSEMBLY ${restReport.pass ? "PASS" : "FAIL"}`, image: compositeLayers([rest], w, h, undefined, LIGHT) },
      { label: `REST DIFF X32 MAX ${maxDiff}`, image: diffImage },
      ...tiles
    ],
    bounds
  );
  return { report: { version: 1, rest: restReport, joints: jointReports, fringe: { pixels: fringe, pass: fringe === 0 }, gates, pass: Object.values(gates).every(Boolean) }, sheet };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The joint radius a coverage mask was grown with (its depth: the disc and contact band are that thick). */
function jointRadius(coverage: Mask): number {
  const d = distanceInside(coverage);
  let r = 0;
  for (let i = 0; i < d.length; i++) r = Math.max(r, d[i] as number);
  return Math.max(1, r);
}

function windowMeasures(
  source: RgbaImage,
  sample: ((layer: number, x: number, y: number) => number) | null,
  layers: readonly RgbaImage[],
  _moving: readonly boolean[],
  win: { x0: number; y0: number; x1: number; y1: number },
  inside: (x: number, y: number) => boolean,
  inp: CheckInputs,
  isInkPx: (img: RgbaImage, i: number) => boolean
): { light: number; dark: number; interiorInk: number } {
  const ww = win.x1 - win.x0 + 1;
  const wh = win.y1 - win.y0 + 1;
  const transparent = cropComposite(layers, source.width, win, sample, undefined);
  const light = cropComposite(layers, source.width, win, sample, LIGHT);
  const dark = cropComposite(layers, source.width, win, sample, DARK);
  const solid = createMask(ww, wh);
  for (let i = 0; i < ww * wh; i++) solid.data[i] = alphaAt(transparent, i) >= 128 ? 1 : 0;
  const depth = distanceInside(solid);
  const ink = inkMask(transparent, inp.inkThreshold, inp.maxLineWidth);
  void isInkPx;
  let edge = 0;
  let inkLight = 0;
  let inkDark = 0;
  let interior = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x;
      if (!solid.data[i] || !inside(x + win.x0, y + win.y0)) continue;
      if ((depth[i] as number) <= 1.01) {
        edge++;
        if (luma(light, i) < inp.inkThreshold) inkLight++;
        if (luma(dark, i) < inp.inkThreshold) inkDark++;
      } else if ((depth[i] as number) > inp.outlineWidth + 1 && ink.data[i]) interior++;
    }
  }
  return { light: edge > 0 ? inkLight / edge : 1, dark: edge > 0 ? inkDark / edge : 1, interiorInk: interior };
}

/** Composite of full-canvas layers over a window (sample gives full-canvas indices). */
function cropComposite(layers: readonly RgbaImage[], width: number, win: { x0: number; y0: number; x1: number; y1: number }, sample: ((layer: number, x: number, y: number) => number) | null, bg: [number, number, number] | undefined): MutableImage {
  const ww = win.x1 - win.x0 + 1;
  const wh = win.y1 - win.y0 + 1;
  const out = createImage(ww, wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      let r = bg ? bg[0] : 0;
      let g = bg ? bg[1] : 0;
      let b = bg ? bg[2] : 0;
      let a = bg ? 255 : 0;
      for (let l = 0; l < layers.length; l++) {
        const s = sample ? sample(l, x + win.x0, y + win.y0) : (y + win.y0) * width + x + win.x0;
        if (s < 0) continue;
        const layer = layers[l] as RgbaImage;
        const la = layer.data[s * 4 + 3] as number;
        if (la === 0) continue;
        const inv = (255 - la) / 255;
        r = (layer.data[s * 4] as number) * (la / 255) + r * inv;
        g = (layer.data[s * 4 + 1] as number) * (la / 255) + g * inv;
        b = (layer.data[s * 4 + 2] as number) * (la / 255) + b * inv;
        a = la + a * inv;
      }
      const p = (y * ww + x) * 4;
      out.data[p + 3] = Math.round(a);
      if (a > 0) {
        out.data[p] = Math.min(255, Math.round((r * 255) / a));
        out.data[p + 1] = Math.min(255, Math.round((g * 255) / a));
        out.data[p + 2] = Math.min(255, Math.round((b * 255) / a));
      }
    }
  }
  return out;
}

function sourceBounds(source: RgbaImage, pad: number): { x: number; y: number; width: number; height: number } {
  let x0 = source.width;
  let y0 = source.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (alphaAt(source, y * source.width + x) === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return { x: 0, y: 0, width: source.width, height: source.height };
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  return { x, y, width: Math.min(source.width, x1 + pad + 1) - x, height: Math.min(source.height, y1 + pad + 1) - y };
}

/** Tiles of the crop, box-downscaled to at most 360 px wide, labelled, four per row. */
function contactSheet(tiles: { label: string; image: MutableImage; marks?: { cracks: Mask; caps: Mask } }[], crop: { x: number; y: number; width: number; height: number }): MutableImage {
  const scale = Math.min(1, 360 / crop.width);
  const tw = Math.max(1, Math.round(crop.width * scale));
  const th = Math.max(1, Math.round(crop.height * scale));
  const cols = Math.min(4, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const labelH = 18;
  const gap = 6;
  const sheet = createImage(cols * (tw + gap) + gap, rows * (th + labelH + gap) + gap);
  for (let i = 0; i < sheet.data.length; i += 4) {
    sheet.data[i] = 200;
    sheet.data[i + 1] = 200;
    sheet.data[i + 2] = 205;
    sheet.data[i + 3] = 255;
  }
  tiles.forEach((tile, k) => {
    const ox = gap + (k % cols) * (tw + gap);
    const oy = gap + Math.floor(k / cols) * (th + labelH + gap);
    const src = tile.image;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const sx0 = crop.x + Math.floor(x / scale);
        const sy0 = crop.y + Math.floor(y / scale);
        const sx1 = Math.max(sx0 + 1, crop.x + Math.floor((x + 1) / scale));
        const sy1 = Math.max(sy0 + 1, crop.y + Math.floor((y + 1) / scale));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        let mark: [number, number, number] | null = null;
        for (let sy = sy0; sy < Math.min(sy1, src.height); sy++) {
          for (let sx = sx0; sx < Math.min(sx1, src.width); sx++) {
            const i = sy * src.width + sx;
            r += src.data[i * 4] as number;
            g += src.data[i * 4 + 1] as number;
            b += src.data[i * 4 + 2] as number;
            n++;
            if (tile.marks?.caps.data[i]) mark = [255, 0, 255];
            else if (tile.marks?.cracks.data[i] && !mark) mark = [255, 0, 0];
          }
        }
        const p = ((oy + labelH + y) * sheet.width + ox + x) * 4;
        const c = mark ?? (n > 0 ? [r / n, g / n, b / n] : [0, 0, 0]);
        sheet.data[p] = Math.round(c[0] as number);
        sheet.data[p + 1] = Math.round(c[1] as number);
        sheet.data[p + 2] = Math.round(c[2] as number);
      }
    }
    for (let y = 0; y < labelH - 2; y++) {
      for (let x = 0; x < tw; x++) {
        const p = ((oy + y) * sheet.width + ox + x) * 4;
        sheet.data[p] = 36;
        sheet.data[p + 1] = 38;
        sheet.data[p + 2] = 46;
      }
    }
    drawText(sheet, tile.label.slice(0, Math.floor((tw - 4) / 12)), ox + 3, oy + 2, 2, [240, 240, 240]);
  });
  return sheet;
}

/** `layers check <manifest>`: report JSON and contact sheet next to the manifest; updates its acceptanceReport ref. */
export function checkManifestFile(manifestPath: string, options: { out?: string; inkThreshold?: number; maxLineWidth?: number } = {}): { report: CheckReport; reportPath: string; sheetPath: string } {
  const dir = dirname(resolve(manifestPath));
  const manifest: LayerManifest = readManifest(manifestPath);
  const source = readPng(resolveRef(dir, manifest.source));
  const rig = rigView(JSON.parse(readFileSync(resolveRef(dir, manifest.rig), "utf8")), source);
  const byId = new Map(manifest.parts.map((p) => [p.id, p]));
  const ordered = manifest.drawOrder.map((id) => byId.get(id) as LayerManifest["parts"][number]);
  const layers = ordered.map((p) => readPng(resolveRef(dir, p.image)));
  let outline: OutlineMeasure | null = null;
  try {
    outline = (readJson(join(dir, "plan.json")) as { outline: OutlineMeasure | null }).outline;
  } catch {
    outline = null;
  }
  const rgb = outline ? ([1, 3, 5].map((k) => parseInt(outline.color.slice(k, k + 2), 16)) as [number, number, number]) : null;
  const visibles = ordered.map((p) => readMaskPng(resolveRef(dir, p.visibleMask)));
  const joints = manifest.joints.map((j) => {
    const child = byId.get(j.childPart) as LayerManifest["parts"][number];
    const pivotBone = rig.bones.get(j.pivotBone);
    if (!pivotBone) throw new Error(`joint ${j.parentPart} -> ${j.childPart}: no bone '${j.pivotBone}'`);
    return {
      parent: j.parentPart,
      child: j.childPart,
      pivotBone: j.pivotBone,
      pivot: [pivotBone.x0, pivotBone.y0] as [number, number],
      coverage: readMaskPng(resolveRef(dir, j.coverageMask)),
      degrees: j.probeNames.map((n) => probeDegrees(n) ?? 0),
      probeNames: j.probeNames,
      moving: ordered.map((p) => isUnder(rig, p.bone, j.pivotBone)),
      backMoving: manifest.drawOrder.indexOf(j.childPart) < manifest.drawOrder.indexOf(j.parentPart),
      staticHull: staticHullMask(visibles, ordered.map((p) => isUnder(rig, p.bone, j.pivotBone)), jointRadius(readMaskPng(resolveRef(dir, j.coverageMask)))),
      childBone: child.bone
    };
  });
  const { report, sheet } = checkLayers({
    source,
    layers,
    ids: ordered.map((p) => p.id),
    uncertain: ordered.map((p) => readMaskPng(resolveRef(dir, p.uncertainMask))),
    completion: ordered.map((p) => readMaskPng(resolveRef(dir, p.completionMask))),
    joints,
    inkThreshold: options.inkThreshold ?? 90,
    outlineWidth: outline?.widthPx ?? 2,
    maxLineWidth: options.maxLineWidth ?? 8,
    outlineColor: rgb
  });
  const outDir = options.out ? resolve(options.out) : dir;
  const reportPath = join(outDir, "acceptance.json");
  const sheetPath = join(outDir, "acceptance-sheet.png");
  const full: CheckReport = { ...report, manifest: { sha256: sha256File(manifestPath) } };
  writeJson(reportPath, full);
  writePng(sheetPath, sheet);
  if (resolve(reportPath) === resolve(resolveRef(dir, manifest.acceptanceReport))) {
    manifest.acceptanceReport = { path: manifest.acceptanceReport.path, sha256: sha256File(reportPath) };
    writeManifest(manifestPath, manifest);
  }
  return { report: full, reportPath, sheetPath };
}

/**
 * `layers sheet <manifest>`: review renders. `rest-<scale>x.png`: the source and the rest
 * assembly side by side, nearest-neighbour at `scale` (default 3). `probes.png`: every joint at
 * both ends of its probe range on light and dark backgrounds (a leg lifted either way, the head
 * turned, the tail swung, the ears moved), the child's subtree rotated about its pivot.
 */
export function writeReviewSheets(manifestPath: string, options: { out?: string; scale?: number } = {}): { rest: string; probes: string } {
  const dir = dirname(resolve(manifestPath));
  const manifest: LayerManifest = readManifest(manifestPath);
  const source = readPng(resolveRef(dir, manifest.source));
  const { width: w, height: h } = source;
  const rig = rigView(JSON.parse(readFileSync(resolveRef(dir, manifest.rig), "utf8")), source);
  const byId = new Map(manifest.parts.map((p) => [p.id, p]));
  const ordered = manifest.drawOrder.map((id) => byId.get(id) as LayerManifest["parts"][number]);
  const layers = ordered.map((p) => readPng(resolveRef(dir, p.image)));
  const crop = sourceBounds(source, 12);
  const scale = Math.max(1, Math.round(options.scale ?? 3));
  const panels = [
    { label: "SOURCE", image: compositeLayers([source], w, h, undefined, LIGHT) },
    { label: "REST ASSEMBLY", image: compositeLayers(layers, w, h, undefined, LIGHT) }
  ];
  const labelH = 8 * scale;
  const rest = createImage(crop.width * scale * 2 + scale * 4, crop.height * scale + labelH);
  rest.data.fill(255);
  panels.forEach((panel, k) => {
    const ox = k * (crop.width * scale + scale * 4);
    for (let y = 0; y < crop.height * scale; y++) {
      for (let x = 0; x < crop.width * scale; x++) {
        const s = ((crop.y + Math.floor(y / scale)) * w + crop.x + Math.floor(x / scale)) * 4;
        const p = ((labelH + y) * rest.width + ox + x) * 4;
        rest.data[p] = panel.image.data[s] as number;
        rest.data[p + 1] = panel.image.data[s + 1] as number;
        rest.data[p + 2] = panel.image.data[s + 2] as number;
        rest.data[p + 3] = 255;
      }
    }
    drawText(rest, panel.label, ox + scale, scale, Math.max(1, scale - 1), [20, 20, 30]);
  });
  const tiles: { label: string; image: MutableImage }[] = [];
  for (const j of manifest.joints) {
    const pivot = rig.bones.get(j.pivotBone);
    if (!pivot) continue;
    const degrees = j.probeNames.map((n) => probeDegrees(n) ?? 0);
    const ends = [Math.min(...degrees), Math.max(...degrees)];
    const moving = ordered.map((p) => isUnder(rig, p.bone, j.pivotBone));
    for (const deg of ends) {
      const rot = rotation(pivot.x0, pivot.y0, deg);
      const sample = (l: number, x: number, y: number) => inverseSample(moving[l] ? rot : null, w, h, x, y);
      tiles.push({ label: `${j.childPart} ${deg} LIGHT`, image: compositeLayers(layers, w, h, sample, LIGHT) });
      tiles.push({ label: `${j.childPart} ${deg} DARK`, image: compositeLayers(layers, w, h, sample, DARK) });
    }
  }
  const outDir = options.out ? resolve(options.out) : dir;
  const restPath = join(outDir, `rest-${scale}x.png`);
  const probesPath = join(outDir, "probes.png");
  writePng(restPath, rest);
  writePng(probesPath, contactSheet(tiles, sourceBounds(source, 40)));
  return { rest: restPath, probes: probesPath };
}
