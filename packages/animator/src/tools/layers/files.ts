/*
 * Atlas Animator: original implementation.
 *
 * Layered-parts pipeline: the files of a layer folder, and the pixel operations of
 * `layers extract` and `layers enforce`.
 *
 *   <dir>/plan.json                    the plan (parts, joints, probes, outline measurements)
 *   <dir>/occlusion.json               occlusion graph (adjacent parts, front/back, joints)
 *   <dir>/overlay.png                  debug overlay (parts tinted, completion striped, uncertain
 *                                      white, seeds dark, bones black, joint discs yellow)
 *   <dir>/masks/<part>.{visible,completion,uncertain}.png, masks/joint-<parent>--<child>.coverage.png
 *   <dir>/layers/<part>.png            full-canvas part images (extract writes visible-only ones)
 *   <dir>/records/<part>.json          generation records
 *   <dir>/acceptance.json              the latest `layers check` report (a placeholder until then)
 *   <dir>/manifest.json                the LayerManifest
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImage, type Mask, type MutableImage, type RgbaImage } from "../image.js";
import { readPng, writePng } from "../png.js";
import { readMaskPng, sha256Bytes, sha256File, writeMaskPng } from "./core.js";
import { generationRecordSchema, IDENTITY, layerManifestSchema, resolveRef, type FileRef, type GenerationRecord, type LayerManifest } from "./manifest.js";
import type { LayerPlan, OutlineMeasure } from "./plan.js";

export interface PlanFile {
  version: 1;
  source: FileRef & { width: number; height: number };
  rig: FileRef & { offset: { x: number; y: number } };
  partsSpec: FileRef;
  skin: string;
  outline: OutlineMeasure | null;
  drawOrder: string[];
  parts: {
    id: string;
    label: string;
    bones: string[];
    bone: string;
    allowedBones: string[];
    pivot: [number, number];
    seeds: number;
    area: { visible: number; completion: number; uncertain: number };
    outline: OutlineMeasure | null;
    fills: string[];
    masks: { visible: string; completion: string; uncertain: string };
  }[];
  joints: {
    parent: string;
    child: string;
    pivotBone: string;
    kind: "overlap" | "welded" | "membrane";
    pivot: [number, number];
    radius: number;
    margin: number;
    front: string;
    back: string;
    probes: { name: string; degrees: number; cracks: number }[];
    coverageMask: string;
    exposedArea: number;
    unfillable: number;
  }[];
  occlusion: { front: string; back: string; boundaryPx: number }[];
  notes: string[];
}

const area = (m: Mask) => m.data.reduce((s, v) => s + v, 0);
const rel = (dir: string, path: string) => relative(dir, path).split("\\").join("/");
const ref = (dir: string, path: string): FileRef => ({ path: rel(dir, path), sha256: sha256File(path) });

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writePlanFolder(dir: string, plan: LayerPlan, inputs: { source: string; rig: string; partsSpec: string; skin: string }): PlanFile {
  mkdirSync(join(dir, "masks"), { recursive: true });
  const src = readPng(inputs.source);
  const parts: PlanFile["parts"] = plan.parts.map((part) => {
    const masks = { visible: `masks/${part.id}.visible.png`, completion: `masks/${part.id}.completion.png`, uncertain: `masks/${part.id}.uncertain.png` };
    writeMaskPng(join(dir, masks.visible), part.visible);
    writeMaskPng(join(dir, masks.completion), part.completion);
    writeMaskPng(join(dir, masks.uncertain), part.uncertain);
    return {
      id: part.id,
      label: part.label,
      bones: part.bones,
      bone: part.bone,
      allowedBones: part.allowedBones,
      pivot: part.pivot,
      seeds: part.seeds,
      area: { visible: area(part.visible), completion: area(part.completion), uncertain: area(part.uncertain) },
      outline: part.outline,
      fills: part.fills,
      masks
    };
  });
  const joints: PlanFile["joints"] = plan.joints.map((j) => {
    const coverageMask = `masks/joint-${j.parent}--${j.child}.coverage.png`;
    writeMaskPng(join(dir, coverageMask), j.coverage);
    return { parent: j.parent, child: j.child, pivotBone: j.pivotBone, kind: j.kind, pivot: j.pivot, radius: j.radius, margin: j.margin, front: j.front, back: j.back, probes: j.probes, coverageMask, exposedArea: j.exposedArea, unfillable: j.unfillable };
  });
  writePng(join(dir, "overlay.png"), plan.overlay);
  const file: PlanFile = {
    version: 1,
    source: { ...ref(dir, resolve(inputs.source)), width: src.width, height: src.height },
    rig: { ...ref(dir, resolve(inputs.rig)), offset: plan.offset },
    partsSpec: ref(dir, resolve(inputs.partsSpec)),
    skin: inputs.skin,
    outline: plan.outline,
    drawOrder: plan.drawOrder,
    parts,
    joints,
    occlusion: plan.occlusion,
    notes: plan.notes
  };
  writeJson(join(dir, "occlusion.json"), {
    drawOrder: plan.drawOrder,
    edges: plan.occlusion,
    joints: plan.joints.map((j) => ({ parent: j.parent, child: j.child, front: j.front, back: j.back, pivotBone: j.pivotBone }))
  });
  writeJson(join(dir, "plan.json"), file);
  return file;
}

/** A part's visible-only full-canvas layer: source pixels (alpha and antialiasing as they are) under the mask. */
export function extractPart(source: RgbaImage, visible: Mask): MutableImage {
  const out = createImage(source.width, source.height);
  for (let i = 0; i < visible.data.length; i++) {
    if (!visible.data[i]) continue;
    for (let c = 0; c < 4; c++) out.data[i * 4 + c] = source.data[i * 4 + c] as number;
  }
  return out;
}

export interface EnforceStats {
  /** Generated pixels kept (completion and uncertain areas). */
  kept: number;
  /** Trusted visible pixels restored from the source. */
  restored: number;
  /** Trusted pixels the generated image had changed (beyond 1/255 in premultiplied RGBA). */
  driftedTrusted: number;
  /** Generated opaque-ish pixels dropped outside every allowed area. */
  droppedOutside: number;
  /** Generated pixels in pieces not connected to the part's trusted pixels (shards), dropped. */
  droppedDetached: number;
}

/**
 * Keeps generated pixels only inside completion areas (and the uncertain band, with
 * bandFromGenerated) and restores the trusted visible pixels exactly; everything else is
 * transparent.
 */
export function enforcePart(source: RgbaImage, generated: RgbaImage, visible: Mask, completion: Mask, uncertain: Mask, options: { bandFromGenerated?: boolean } = {}): { image: MutableImage; stats: EnforceStats } {
  if (generated.width !== source.width || generated.height !== source.height) throw new Error(`the generated image is ${generated.width}x${generated.height}; it must be the source canvas ${source.width}x${source.height} (full canvas, original framing)`);
  const out = createImage(source.width, source.height);
  const stats: EnforceStats = { kept: 0, restored: 0, driftedTrusted: 0, droppedOutside: 0, droppedDetached: 0 };
  const pm = (img: RgbaImage, i: number, c: number) => (c === 3 ? (img.data[i * 4 + 3] as number) : Math.round(((img.data[i * 4 + c] as number) * (img.data[i * 4 + 3] as number)) / 255));
  for (let i = 0; i < visible.data.length; i++) {
    // By default the uncertain band keeps the source's own antialiasing too (rest stays exact);
    // bandFromGenerated lets the generated image re-matte it.
    const trusted = visible.data[i] === 1 && (!options.bandFromGenerated || uncertain.data[i] !== 1);
    if (trusted) {
      for (let c = 0; c < 4; c++) out.data[i * 4 + c] = source.data[i * 4 + c] as number;
      stats.restored++;
      for (let c = 0; c < 4; c++) {
        if (Math.abs(pm(source, i, c) - pm(generated, i, c)) > 1) {
          stats.driftedTrusted++;
          break;
        }
      }
    } else if (completion.data[i] === 1 || uncertain.data[i] === 1) {
      for (let c = 0; c < 4; c++) out.data[i * 4 + c] = generated.data[i * 4 + c] as number;
      if ((generated.data[i * 4 + 3] as number) > 0) stats.kept++;
    } else if ((generated.data[i * 4 + 3] as number) >= 8) stats.droppedOutside++;
  }
  // Shards: generated pieces that do not touch the part's own trusted pixels are dropped.
  const W = source.width;
  const reached = new Uint8Array(visible.data.length);
  const queue: number[] = [];
  // Connectivity over any coverage: a generated piece joined to the body through soft pixels
  // is still the body's.
  const solidAt = (j: number) => (out.data[j * 4 + 3] as number) > 0;
  for (let i = 0; i < visible.data.length; i++) {
    if (visible.data[i] && solidAt(i)) {
      reached[i] = 1;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q] as number;
    const x = i % W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const j = i + dy * W + dx;
        if (nx < 0 || nx >= W || j < 0 || j >= reached.length || reached[j] || !solidAt(j)) continue;
        reached[j] = 1;
        queue.push(j);
      }
    }
  }
  // Semi-transparent pixels stay when they touch the reached body or are the part's own.
  const nearReached = (i: number) => {
    const x = i % W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * W + dx;
      if (x + dx >= 0 && x + dx < W && j >= 0 && j < reached.length && reached[j]) return true;
    }
    return false;
  };
  for (let i = 0; i < reached.length; i++) {
    if (reached[i] || (out.data[i * 4 + 3] as number) === 0 || visible.data[i]) continue;
    if (!solidAt(i) && nearReached(i)) continue;
    out.data.fill(0, i * 4, i * 4 + 4);
    stats.droppedDetached++;
    stats.kept--;
  }
  return { image: out, stats };
}

function gitCommit(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** `layers extract`: visible-only layers, extraction records, a placeholder acceptance report and the manifest. */
export function extractFolder(dir: string): { manifest: LayerManifest; written: string[] } {
  const plan = readJson(join(dir, "plan.json")) as PlanFile;
  const sourcePath = resolveRef(dir, plan.source);
  if (sha256File(sourcePath) !== plan.source.sha256) throw new Error(`${plan.source.path} changed since the plan: re-run layers plan`);
  const source = readPng(sourcePath);
  const written: string[] = [];
  const parts: LayerManifest["parts"] = plan.parts.map((part) => {
    const visible = readMaskPng(join(dir, part.masks.visible));
    const layerPath = join(dir, "layers", `${part.id}.png`);
    writePng(layerPath, extractPart(source, visible));
    written.push(layerPath);
    const recordPath = join(dir, "records", `${part.id}.json`);
    const record: GenerationRecord = { kind: "extracted", part: part.id, prompt: null, references: [{ path: plan.source.path, sha256: plan.source.sha256 }], tool: "animator layers extract", model: null, output: ref(dir, layerPath) };
    writeJson(recordPath, generationRecordSchema.parse(record));
    written.push(recordPath);
    return {
      id: part.id,
      image: ref(dir, layerPath),
      visibleMask: ref(dir, join(dir, part.masks.visible)),
      completionMask: ref(dir, join(dir, part.masks.completion)),
      uncertainMask: ref(dir, join(dir, part.masks.uncertain)),
      canvasFromLayer: [...IDENTITY],
      pivotCanvas: part.pivot,
      skin: plan.skin,
      slot: part.id,
      attachment: part.id,
      bone: part.bone,
      domainId: part.id,
      allowedBones: part.allowedBones,
      generationRecord: ref(dir, recordPath)
    };
  });
  const acceptance = join(dir, "acceptance.json");
  if (!existsSync(acceptance)) writeJson(acceptance, { status: "not-run", note: "run animator layers check" });
  const manifest: LayerManifest = layerManifestSchema.parse({
    version: 1,
    source: plan.source,
    coordinates: "source-pixels-top-left-y-down",
    rig: { path: plan.rig.path, sha256: plan.rig.sha256, codeCommit: gitCommit(dirname(fileURLToPath(import.meta.url))) },
    parts,
    drawOrder: plan.drawOrder,
    joints: plan.joints.map((j) => ({ parentPart: j.parent, childPart: j.child, pivotBone: j.pivotBone, kind: j.kind, coverageMask: ref(dir, join(dir, j.coverageMask)), marginSourcePx: j.margin, probeNames: j.probes.map((p) => p.name) })),
    acceptanceReport: ref(dir, acceptance)
  });
  writeJson(join(dir, "manifest.json"), manifest);
  written.push(join(dir, "manifest.json"));
  return { manifest, written };
}

export function readManifest(path: string): LayerManifest {
  return layerManifestSchema.parse(readJson(path));
}

export function writeManifest(path: string, manifest: LayerManifest): void {
  writeJson(path, layerManifestSchema.parse(manifest));
}

/**
 * `layers enforce`: applies enforcePart to a generated PNG for one part, writes the result into the
 * layer folder (`layers/<part>.png` unless `out` is given), a generation record, and updates the
 * manifest's image and record refs.
 */
export function enforceFile(manifestPath: string, partId: string, generatedPath: string, options: { out?: string; record?: Partial<GenerationRecord>; register?: boolean } = {}): { stats: EnforceStats; output: string; registration: Registration | null } {
  const dir = dirname(resolve(manifestPath));
  const manifest = readManifest(manifestPath);
  const part = manifest.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`no part '${partId}' in ${manifestPath} (parts: ${manifest.parts.map((p) => p.id).join(", ")})`);
  const source = readPng(resolveRef(dir, manifest.source));
  if (sha256File(resolveRef(dir, manifest.source)) !== manifest.source.sha256) throw new Error("the source PNG changed since the manifest was written");
  const generatedBytes = readFileSync(generatedPath);
  const visibleMask = readMaskPng(resolveRef(dir, part.visibleMask));
  const uncertainMask = readMaskPng(resolveRef(dir, part.uncertainMask));
  let generated: RgbaImage = readPng(generatedPath);
  let registration: Registration | null = null;
  const sizeDiffers = generated.width !== source.width || generated.height !== source.height;
  if (options.register || sizeDiffers) {
    // An image model may change the canvas size or shift the part: fit it before enforcing.
    const trusted = { width: source.width, height: source.height, data: visibleMask.data.map((v, i) => (v && !uncertainMask.data[i] ? 1 : 0)) };
    const fitted = registerToTarget(generated, readPng(resolveRef(dir, part.image)), trusted);
    generated = fitted.image;
    registration = fitted.registration;
  }
  const { image, stats } = enforcePart(source, generated, visibleMask, readMaskPng(resolveRef(dir, part.completionMask)), uncertainMask);
  const output = options.out ? resolve(options.out) : join(dir, "layers", `${partId}.png`);
  // Keep the generated input next to the layer (inputs are stored, never regenerated).
  const kept = join(dir, "generated", `${partId}.${sha256Bytes(generatedBytes).slice(0, 12)}${basename(generatedPath).toLowerCase().endsWith(".png") ? ".png" : ""}`);
  mkdirSync(dirname(kept), { recursive: true });
  if (resolve(generatedPath) !== kept) copyFileSync(generatedPath, kept);
  writePng(output, image);
  const recordPath = join(dir, "records", `${partId}.json`);
  const record: GenerationRecord = generationRecordSchema.parse({
    kind: "generated",
    part: partId,
    prompt: options.record?.prompt ?? null,
    references: [...(options.record?.references ?? []), ref(dir, kept)],
    tool: options.record?.tool ?? null,
    model: options.record?.model ?? null,
    output: ref(dir, output),
    notes: [...(registration ? [`registered: scale ${registration.scale}, offset (${registration.dx}, ${registration.dy}), trusted-pixel error ${registration.error}/255`] : []), `enforced: kept ${stats.kept} generated px, restored ${stats.restored} trusted px (${stats.driftedTrusted} drifted in the generated image), dropped ${stats.droppedOutside} px outside the allowed areas and ${stats.droppedDetached} detached px`]
  });
  writeJson(recordPath, record);
  part.image = ref(dir, output);
  part.generationRecord = ref(dir, recordPath);
  writeManifest(manifestPath, manifest);
  return { stats, output, registration };
}

export interface Registration {
  scale: number;
  dx: number;
  dy: number;
  /** Mean max-channel difference over the sampled trusted pixels after registration (0..255). */
  error: number;
}

/**
 * Image models rarely keep the canvas: a generated part may come back at another size or
 * shifted. Fits a scale and translation (no rotation) that best lays the generated image over the
 * target's trusted pixels (colour difference, transparent counts as 255), coarse then fine, and
 * resamples it (bilinear, premultiplied) onto the source canvas. The trusted pixels themselves are
 * restored afterwards by enforcePart; this only places the completion.
 */
export function registerToTarget(generated: RgbaImage, target: RgbaImage, trusted: Mask): { image: MutableImage; registration: Registration } {
  const W = target.width;
  const H = target.height;
  const points: number[] = [];
  for (let i = 0; i < trusted.data.length; i++) if (trusted.data[i] && (target.data[i * 4 + 3] as number) >= 128) points.push(i);
  if (points.length === 0) throw new Error("the target has no trusted pixels to register against");
  const pick = (n: number) => {
    const out: number[] = [];
    const step = Math.max(1, Math.floor(points.length / n));
    for (let k = 0; k < points.length && out.length < n; k += step) out.push(points[k] as number);
    return out;
  };
  const score = (sample: number[], s: number, dx: number, dy: number, limit: number) => {
    let sum = 0;
    for (let k = 0; k < sample.length; k++) {
      const i = sample[k] as number;
      const x = i % W;
      const y = (i - x) / W;
      const gx = Math.floor((x + 0.5 - dx) / s);
      const gy = Math.floor((y + 0.5 - dy) / s);
      let d = 255;
      if (gx >= 0 && gy >= 0 && gx < generated.width && gy < generated.height) {
        const g = (gy * generated.width + gx) * 4;
        if ((generated.data[g + 3] as number) >= 128) d = Math.max(Math.abs((generated.data[g] as number) - (target.data[i * 4] as number)), Math.abs((generated.data[g + 1] as number) - (target.data[i * 4 + 1] as number)), Math.abs((generated.data[g + 2] as number) - (target.data[i * 4 + 2] as number)));
      }
      sum += d;
      if (sum > limit) return Infinity;
    }
    return sum / sample.length;
  };
  const base = Math.min(W / generated.width, H / generated.height);
  const coarse = pick(300);
  let best = { s: base, dx: 0, dy: 0, e: Infinity };
  for (let k = 0.8; k <= 1.25 + 1e-9; k += 0.025) {
    const s = base * k;
    // Centre-to-centre guess, then a translation search around it.
    const cx = (W - generated.width * s) / 2;
    const cy = (H - generated.height * s) / 2;
    for (let ty = -160; ty <= 160; ty += 4) {
      for (let tx = -160; tx <= 160; tx += 4) {
        const e = score(coarse, s, cx + tx, cy + ty, best.e * coarse.length);
        if (e < best.e) best = { s, dx: cx + tx, dy: cy + ty, e };
      }
    }
  }
  const fine = pick(3000);
  let refined = { ...best, e: score(fine, best.s, best.dx, best.dy, Infinity) };
  for (let ds = -0.03; ds <= 0.03 + 1e-9; ds += 0.005) {
    const s = best.s * (1 + ds);
    for (let ty = -6; ty <= 6; ty++) {
      for (let tx = -6; tx <= 6; tx++) {
        const e = score(fine, s, best.dx + tx, best.dy + ty, refined.e * fine.length);
        if (e < refined.e) refined = { s, dx: best.dx + tx, dy: best.dy + ty, e };
      }
    }
  }
  // Models usually just resample the whole canvas: prefer that plain fit (scale to the canvas,
  // centred) unless a moved fit is clearly better (by more than 1.5 levels).
  const plain = { s: base, dx: (W - generated.width * base) / 2, dy: (H - generated.height * base) / 2, e: 0 };
  plain.e = score(fine, plain.s, plain.dx, plain.dy, Infinity);
  if (plain.e <= refined.e + 1.5) refined = plain;
  const out = createImage(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (x + 0.5 - refined.dx) / refined.s - 0.5;
      const gy = (y + 0.5 - refined.dy) / refined.s - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sx, sy, wgt] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]] as const) {
        if (sx < 0 || sy < 0 || sx >= generated.width || sy >= generated.height || wgt === 0) continue;
        const p = (sy * generated.width + sx) * 4;
        const al = ((generated.data[p + 3] as number) / 255) * wgt;
        r += (generated.data[p] as number) * al;
        g += (generated.data[p + 1] as number) * al;
        b += (generated.data[p + 2] as number) * al;
        a += al;
      }
      const p = (y * W + x) * 4;
      if (a > 0) {
        out.data[p] = Math.round(r / a);
        out.data[p + 1] = Math.round(g / a);
        out.data[p + 2] = Math.round(b / a);
        out.data[p + 3] = Math.round(a * 255);
      }
    }
  }
  return { image: out, registration: { scale: Math.round(refined.s * 1e5) / 1e5, dx: Math.round(refined.dx * 100) / 100, dy: Math.round(refined.dy * 100) / 100, error: Math.round(refined.e * 100) / 100 } };
}
