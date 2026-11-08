/*
 * Atlas Animator: original implementation.
 *
 * `animator export-spine <rig.anim.json> <outDir> [--name N] [--clips a,b] [--clips-from other.anim.json[,..]]
 *  [--spine-version 4.3.26] [--no-atlas]`
 *
 * Writes an `atlas-anim@1` rig as Spine 4.3 data (4.2 with `--spine-version 4.2.x`), so the rig opens in the Spine editor (Import Data)
 * and plays in the official runtimes:
 *
 *   <name>.json        skeleton: bones, slots, default skin (region / mesh / point attachments), constraints
 *                      (4.3: one ordered `constraints` array of type ik / transform; 4.2: `ik` and `transform` lists with `order`),
 *                      animations
 *   images/<slot>/<attachment>.png   one PNG per attachment image (the editor's images folder)
 *   <name>.atlas + <name>.png        Spine text atlas and its page, for runtime tests
 *   export-report.json               what could not be mapped and what was baked
 *
 * Conversions (this format is y down, clockwise-positive degrees; Spine is y up, counter-clockwise):
 * the whole skeleton is mirrored about the x axis, which is one rule for every local transform and every
 * point: y -> -y, rotation -> -rotation, shear -> -shear, scale unchanged, bone-local weights (x, y) ->
 * (x, -y). Region rotation and offset follow the same rule (the attachment's local frame mirrors with its
 * bone). UVs stay (v down in both). Units are canvas pixels in both.
 *
 * Not expressible in Spine, handled here:
 * - Driven keys (corrections keyed to a bone angle: the elbow / knee / fold swaps and the arm-cross draw
 *   order) have no Spine equivalent. The setup pose is exported as this runtime draws it (driven swaps
 *   evaluated at the setup angles), and every clip's slot attachment, slot colour and draw-order
 *   timelines are baked from the runtime at the clip's frame rate (stepped), so a clip plays the same
 *   swaps the game shows. Hand-posed bones in the editor do not switch pieces by themselves.
 * - Clip fps (held frames) maps to the skeleton fps and stepped keys; per-key curves convert exactly.
 * - The weapon: the `weapon` bone's origin is moved onto the weapon image's grip (the centre of its dark leather wrap, found from
 *   the pixels) and the region offset is rebuilt so the wrap sits on that origin with the haft along the bone's x axis; the bone's
 *   children are compensated, so every attachment stays where this runtime draws it and rotating `weapon` pivots about the grip.
 * - Negative attachment scales are baked into the image pixels (flipped PNG, positive scale): the 4.3 editor does not apply them like the runtimes.
 * - Weighted meshes list each vertex's influences in skeleton bone order. The Spine editor keeps one bone list per mesh and rejects
 *   (Index -2 out of bounds) a mesh whose vertices disagree on the order; the runtimes do not care.
 * See packages/animator/README.md for the user's steps.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { DEFAULT_CLIP_FPS, meshDeformLength, type AnimDocument, type ClipData, type CurveSpec, type MeshAttachmentData } from "../core/format.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { curveForChannel, evaluateCurve } from "../core/curves.js";
import { DEG_TO_RAD } from "../core/math.js";
import { computePathWorld, pathCurveLengths } from "../core/pathConstraint.js";
import type { PathAttachment } from "../core/attachments.js";
import { Skeleton } from "../core/skeleton.js";
import { createImage, type MutableImage } from "../tools/image.js";
import { readPng, writePng } from "../tools/png.js";

type Json = Record<string, unknown>;

export interface SpineExportOptions {
  document: string;
  outDir: string;
  /** atlas-pack@1 manifest; default `<rig>.atlas.json` beside the document. */
  atlas?: string;
  /** Output base name; default the document's name. */
  name?: string;
  /** Clips to export; default every clip except `review` (the probe sheet). */
  clips?: string[];
  /** Other documents of the same rig whose clips are merged in (same bone and slot names). */
  clipsFrom?: string[];
  spineVersion?: string;
  /** Skip the .atlas and page (the individual images are always written). */
  noAtlas?: boolean;
}

export interface SpineExportResult {
  json: string;
  atlas: string | null;
  images: number;
  clips: string[];
  warnings: string[];
  baked: Record<string, { frames: number; slots: string[]; drawOrderKeys: number }>;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * Grip of a weapon image in image pixels (y down): the haft's centre column and the middle of its longest dark band (the leather
 * wrap). Null when the image has no such band.
 */
function findGripWrap(image: MutableImage): { x: number; y: number } | null {
  const { width, height, data } = image;
  const alpha = (x: number, y: number): number => data[(y * width + x) * 4 + 3] as number;
  let centers = 0;
  let rows = 0;
  const narrow = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < width; x++) {
      if (alpha(x, y) > 128) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    const span = hi - lo + 1;
    if (lo >= 0 && span >= 8 && span <= width * 0.25) {
      centers += (lo + hi + 1) / 2;
      rows++;
      narrow[y] = 1;
    }
  }
  if (rows === 0) return null;
  // Snapped to the half pixel: the haft is symmetric about a pixel column or the gap between two.
  const cx = Math.round((centers / rows) * 2) / 2;
  const x0 = Math.max(0, Math.floor(cx - 36));
  const x1 = Math.min(width - 1, Math.ceil(cx + 36));
  // A row is leather when over half of the haft's pixels are dark (the outline alone is about a fifth); the grooves between the turns are lighter, so near runs are merged.
  const runs: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    if (!narrow[y]) continue;
    let dark = 0;
    let seen = 0;
    for (let x = x0; x <= x1; x++) {
      if (alpha(x, y) <= 200) continue;
      seen++;
      const i = (y * width + x) * 4;
      if (((data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number)) / 3 < 105) dark++;
    }
    if (dark < seen / 2) continue;
    const last = runs[runs.length - 1];
    if (last && y - last[1] <= 8) last[1] = y;
    else runs.push([y, y]);
  }
  let best: [number, number] | null = null;
  for (const run of runs) if (run[1] - run[0] + 1 >= 16 && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
  return best ? { x: cx, y: (best[0] + best[1] + 1) / 2 } : null;
}


/** The image on a transparent canvas just big enough to put pixel (gx, gy) at its centre (gx, gy are whole or half pixels). */
function centredOn(image: MutableImage, gx: number, gy: number): MutableImage {
  const { width, height } = image;
  const w = Math.round(2 * Math.max(gx, width - gx));
  const h = Math.round(2 * Math.max(gy, height - gy));
  const ox = Math.round(w / 2 - gx);
  const oy = Math.round(h / 2 - gy);
  const out = createImage(w, h);
  for (let y = 0; y < height; y++) out.data.set(image.data.subarray(y * width * 4, (y + 1) * width * 4), ((y + oy) * w + ox) * 4);
  return out;
}

function padImage(image: MutableImage, grip: { x: number; y: number } | undefined): MutableImage {
  return grip ? centredOn(image, grip.x, grip.y) : image;
}

/** The image mirrored horizontally and / or vertically (pixels only); unchanged without a flip. */
function mirrored(image: MutableImage, flip: { x: boolean; y: boolean } | undefined): MutableImage {
  if (!flip || (!flip.x && !flip.y)) return image;
  const { width, height } = image;
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((flip.y ? height - 1 - y : y) * width + (flip.x ? width - 1 - x : x)) * 4;
      out.data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/** Rounds to 6 decimals and drops negative zero. */
const num = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const neg = (v: number): number => num(-v);

/** Weapon bones exported as point attachments (grip, second hand, trail wrist, tip). */
const POINT_BONES: readonly [slot: string, bone: string][] = [
  ["pt_grip", "weapon"],
  ["pt_grip2", "weapon_grip2"],
  ["pt_grip2_wrist", "weapon_grip2_wrist"],
  ["pt_tip", "weapon_tip"]
];

function hex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
}

/** Transform constraint mix channels, in the order the timelines key them. */
const mixChannels = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const;

const HELPER_COLOR = "5a5a5aff";
const SLOT_HELPER_COLOR = "6a6a6a80";
/** Bones the user poses get a bright colour; helper bones (driven discs, weapon points) are muted grey and hidden. */
const POSED_COLORS: [RegExp, string][] = [
  [/^(body|lean|pelvis|spine_1|spine_2|chest)$/, "ffd400ff"],
  [/^(neck|head|hair_[a-z0-9_]+)$/, "00d8ffff"],
  [/^(clavicle|upper_arm|forearm|hand)_near$/, "3cff3cff"],
  [/^(clavicle|upper_arm|forearm|hand)_far$/, "ff8a1cff"],
  [/^offhand$/, "ff8a1cff"],
  [/^(thigh|shin|foot)_near$/, "4f8bffff"],
  [/^(thigh|shin|foot)_far$/, "d36bffff"],
  [/^(foot|hand)_(near|far)_target$/, "ff5fb4ff"],
  [/^weapon$/, "ff3b3bff"]
];
const HELPER_BONE = /^((hip|knee|elbow|wrist)_(near|far)|weapon_grip2|weapon_grip2_wrist|weapon_tip)$/;

/** 4.3 reads the enum with its first letter capitalised; 4.2 wrote it lower camel case. */
function inheritName(mode: string, v43: boolean): string | undefined {
  let name: string;
  switch (mode) {
    case "normal":
      return undefined;
    case "noRotation":
      name = "noRotationOrReflection";
      break;
    default:
      name = mode;
  }
  return v43 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------

type KeyLike = { time: number; curve?: unknown };

/** The spec of one channel of a key's curve. */
function channelCurve(curve: unknown, channel: string): CurveSpec {
  if (curve === undefined) return "linear";
  if (typeof curve === "string" || Array.isArray(curve)) return curve as CurveSpec;
  return ((curve as Record<string, CurveSpec | undefined>)[channel] ?? "linear") as CurveSpec;
}

/**
 * Spine curve fields of the span key -> next key: nothing (linear), "stepped", or the bezier array
 * (per channel cx1, cy1, cx2, cy2 in absolute time and value). Returns null when the channels mix
 * stepped with smooth, which Spine cannot hold in one key.
 */
function curveFields(curve: unknown, channels: readonly string[], t0: number, t1: number, v0: readonly number[], v1: readonly number[]): Json | null {
  const specs = channels.map((c) => channelCurve(curve, c));
  const stepped = specs.map((s) => s === "stepped");
  if (stepped.every(Boolean)) return { curve: "stepped" };
  if (stepped.some(Boolean)) return null;
  if (specs.every((s) => s === "linear")) return {};
  const out: number[] = [];
  specs.forEach((spec, i) => {
    const dt = t1 - t0;
    const dv = (v1[i] as number) - (v0[i] as number);
    const [cx1, cy1, cx2, cy2] = spec === "linear" ? [1 / 3, 1 / 3, 2 / 3, 2 / 3] : (spec as [number, number, number, number]);
    out.push(num(t0 + cx1 * dt), num((v0[i] as number) + cy1 * dv), num(t0 + cx2 * dt), num((v0[i] as number) + cy2 * dv));
  });
  return { curve: out };
}

/**
 * Keys of a timeline with `channels` values each, as Spine key objects. `fields` names the JSON key of
 * each channel. Returns null when a key mixes stepped with smooth channels.
 */
function spineKeys(keys: readonly KeyLike[], channels: readonly string[], fields: readonly string[], values: (key: KeyLike) => number[]): Json[] | null {
  const out: Json[] = [];
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k] as KeyLike;
    const v = values(key);
    const entry: Json = { time: num(key.time) };
    fields.forEach((f, i) => {
      entry[f] = num(v[i] as number);
    });
    const next = keys[k + 1];
    if (next) {
      const fieldsOut = curveFields(key.curve, channels, key.time, next.time, v, values(next));
      if (!fieldsOut) return null;
      Object.assign(entry, fieldsOut);
    }
    out.push(entry);
  }
  return out;
}

/** Value of one channel of a key list at time t (curve of the span, first / last value outside the keys). */
function sampleKeys<K extends KeyLike>(keys: readonly K[], channel: string, value: (k: K) => number, t: number): number {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return 0;
  if (t <= first.time) return value(first);
  if (t >= last.time) return value(last);
  let k = 0;
  while ((keys[k + 1] as K).time <= t) k++;
  const a = keys[k] as K;
  const b = keys[k + 1] as K;
  const f = evaluateCurve(curveForChannel((a.curve ?? "linear") as CurveSpec, channel), (t - a.time) / (b.time - a.time));
  return value(a) + (value(b) - value(a)) * f;
}

// ---------------------------------------------------------------------------------------------
// Deform timelines
// ---------------------------------------------------------------------------------------------

/**
 * Where each float pair of a mesh's deform array lands in the exported layout: `map[i]` is the exported pair index of source
 * pair i (a pair is one vertex, or one influence of a weighted vertex). Weighted vertices export their influences sorted by
 * skeleton bone index (the order exportSpine writes `vertices` in), so the deform pairs must be permuted the same way or a
 * key would move the wrong bone's influence. Unweighted meshes keep their order.
 */
export function deformPairMap(mesh: Pick<MeshAttachmentData, "uvs" | "vertices" | "bones">, boneIndex: ReadonlyMap<string, number>): number[] {
  if (!mesh.bones) return Array.from({ length: mesh.vertices.length / 2 }, (_, i) => i);
  const table = mesh.bones.map((n) => {
    const index = boneIndex.get(n);
    if (index === undefined) throw new Error(`unknown bone '${n}'`);
    return index;
  });
  const map: number[] = [];
  let i = 0;
  let base = 0;
  while (i < mesh.vertices.length) {
    const n = mesh.vertices[i++] as number;
    const order = Array.from({ length: n }, (_, k) => k);
    const bones = order.map((k) => table[mesh.vertices[i + k * 4] as number] as number);
    order.sort((p, q) => (bones[p] as number) - (bones[q] as number) || p - q); // stable, like the vertex sort
    const target = new Array<number>(n);
    order.forEach((from, to) => {
      target[from] = base + to;
    });
    map.push(...target);
    i += n * 4;
    base += n;
  }
  return map;
}

/**
 * Deform keys of one mesh as Spine deform keys: sparse offsets expanded to the full array, pairs reordered to the exported
 * influence order, y negated, then trimmed (leading zeros -> `offset`, trailing zeros dropped, all zero -> a bare time key).
 * Curves go through the shared converter (one channel, the 0..1 blend amount).
 */
export function spineDeformKeys(
  mesh: Pick<MeshAttachmentData, "uvs" | "vertices" | "bones">,
  keys: readonly { time: number; offset: number; vertices: readonly number[]; curve?: unknown }[],
  boneIndex: ReadonlyMap<string, number>
): Json[] {
  const length = meshDeformLength(mesh);
  const map = deformPairMap(mesh, boneIndex);
  const result: Json[] = [];
  keys.forEach((key, k) => {
    const src = new Array<number>(length).fill(0);
    key.vertices.forEach((v, i) => {
      const at = key.offset + i;
      if (at < length) src[at] = v;
    });
    const values = new Array<number>(length).fill(0);
    for (let pair = 0; pair < length / 2; pair++) {
      const to = map[pair] as number;
      values[to * 2] = num(src[pair * 2] as number);
      values[to * 2 + 1] = neg(src[pair * 2 + 1] as number);
    }
    const entry: Json = { time: num(key.time) };
    let first = 0;
    while (first < values.length && values[first] === 0) first++;
    let last = values.length;
    while (last > first && values[last - 1] === 0) last--;
    if (last > first) {
      if (first > 0) entry.offset = first;
      entry.vertices = values.slice(first, last);
    }
    const next = keys[k + 1];
    if (next) Object.assign(entry, curveFields(key.curve, ["value"], key.time, next.time, [0], [1]) ?? {});
    result.push(entry);
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Sampling (driven keys, attachments, colours and draw order, baked from the runtime)
// ---------------------------------------------------------------------------------------------

interface Frame {
  time: number;
  attachments: (string | null)[];
  colors: string[];
  order: number[];
}

function snapshot(skeleton: Skeleton, time: number): Frame {
  return {
    time,
    attachments: skeleton.slots.map((slot) => slot.effectivePlaceholder),
    colors: skeleton.slots.map((slot) => `${hex(slot.color.r)}${hex(slot.color.g)}${hex(slot.color.b)}${hex(slot.color.a * slot.drivenAlpha)}`),
    order: skeleton.drawOrder.map((slot) => slot.index)
  };
}

function setupFrame(doc: AnimDocument): Frame {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(Object.keys(doc.skins).slice(0, 1));
  skeleton.updateWorldTransform();
  // The Spine setup pose is the segmented rig (the document's own slot attachments): Spine has no driven keys, so
  // the straight-limb swaps the game applies at rest are left to the baked clips and the slots' attachment lists.
  const frame = snapshot(skeleton, 0);
  return { ...frame, attachments: doc.slots.map((slot) => slot.attachment) };
}

/** One frame per clip frame: 0..N-1 for a loop, 0..N for a one-shot (the last at the clip's end). */
function sampleClip(doc: AnimDocument, name: string): { frames: Frame[]; fps: number; duration: number; loop: boolean } {
  const clip = doc.animations[name] as ClipData;
  const fps = clip.fps ?? DEFAULT_CLIP_FPS;
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(Object.keys(doc.skins).slice(0, 1));
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, name);
  const steps = Math.max(1, Math.round(clip.duration * fps));
  const count = clip.loop ? steps : steps + 1;
  const dt = 1 / fps;
  const frames: Frame[] = [];
  for (let k = 0; k < count; k++) {
    if (k > 0) {
      state.update(dt);
      skeleton.update(dt);
    }
    state.apply(skeleton);
    skeleton.updateWorldTransform();
    frames.push(snapshot(skeleton, Math.min(k * dt, clip.duration)));
  }
  return { frames, fps, duration: clip.duration, loop: clip.loop };
}

/** Spine draw-order offsets (sorted by setup index) turning the setup order into `order`; [] = the setup order. */
function drawOrderOffsets(order: readonly number[]): { slot: number; offset: number }[] {
  const out: { slot: number; offset: number }[] = [];
  order.forEach((slot, position) => {
    if (slot !== position) out.push({ slot, offset: position - slot });
  });
  return out.sort((a, b) => a.slot - b.slot);
}

// ---------------------------------------------------------------------------------------------
// Images and atlas
// ---------------------------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function cropPage(page: MutableImage, rect: Rect): MutableImage {
  const out = createImage(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * page.width + rect.x) * 4;
    out.data.set(page.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

/**
 * Copies the colour of the nearest opaque pixel into transparent pixels within `iterations` of it (alpha
 * stays 0), so bilinear filtering at an image's edge does not pull black in.
 */
function bleed(image: MutableImage, iterations: number): MutableImage {
  const { width, height } = image;
  const data = Uint8Array.from(image.data);
  let colored = Uint8Array.from({ length: width * height }, (_, i) => ((data[i * 4 + 3] as number) > 0 ? 1 : 0));
  for (let it = 0; it < iterations; it++) {
    const nextColored = Uint8Array.from(colored);
    const nextData = Uint8Array.from(data);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (colored[y * width + x]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || !colored[ny * width + nx]) continue;
            const j = (ny * width + nx) * 4;
            r += data[j] as number;
            g += data[j + 1] as number;
            b += data[j + 2] as number;
            n++;
          }
        }
        if (n > 0) {
          const i = (y * width + x) * 4;
          nextData[i] = Math.round(r / n);
          nextData[i + 1] = Math.round(g / n);
          nextData[i + 2] = Math.round(b / n);
          nextColored[y * width + x] = 1;
        }
      }
    }
    data.set(nextData);
    colored = nextColored;
  }
  return { width, height, data };
}

interface Placed {
  name: string;
  image: MutableImage;
  x: number;
  y: number;
}

/** Shelf packer: images sorted by height, rows left to right, `pad` px apart; page width `width`, height rounded up to a power of two. */
function packShelves(images: { name: string; image: MutableImage }[], width: number, pad: number): { placed: Placed[]; width: number; height: number } {
  const sorted = [...images].sort((a, b) => b.image.height - a.image.height || a.name.localeCompare(b.name));
  const placed: Placed[] = [];
  let x = pad;
  let y = pad;
  let rowHeight = 0;
  for (const item of sorted) {
    if (item.image.width + 2 * pad > width) throw new Error(`image '${item.name}' (${item.image.width} px) is wider than the atlas page (${width})`);
    if (x + item.image.width + pad > width) {
      x = pad;
      y += rowHeight + pad;
      rowHeight = 0;
    }
    placed.push({ name: item.name, image: item.image, x, y });
    x += item.image.width + pad;
    rowHeight = Math.max(rowHeight, item.image.height);
  }
  const used = y + rowHeight + pad;
  let height = 1;
  while (height < used) height *= 2;
  return { placed, width, height };
}

function composePage(placed: readonly Placed[], width: number, height: number): MutableImage {
  const page = createImage(width, height);
  for (const p of placed) {
    // 1 px edge replication around each image (the bleed pass already coloured the transparent border).
    const { image } = p;
    for (let y = -1; y <= image.height; y++) {
      for (let x = -1; x <= image.width; x++) {
        const sx = Math.min(image.width - 1, Math.max(0, x));
        const sy = Math.min(image.height - 1, Math.max(0, y));
        const from = (sy * image.width + sx) * 4;
        const to = ((p.y + y) * width + (p.x + x)) * 4;
        const inside = x >= 0 && y >= 0 && x < image.width && y < image.height;
        page.data[to] = image.data[from] as number;
        page.data[to + 1] = image.data[from + 1] as number;
        page.data[to + 2] = image.data[from + 2] as number;
        page.data[to + 3] = inside ? (image.data[from + 3] as number) : 0;
      }
    }
  }
  return page;
}

function atlasText(pageFile: string, width: number, height: number, placed: readonly Placed[]): string {
  const lines = [pageFile, `size:${width},${height}`, "filter:Linear,Linear", "pma:false"];
  for (const p of [...placed].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(p.name, `bounds:${p.x},${p.y},${p.image.width},${p.image.height}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Repacks every PNG under `imagesDir` (names = path relative to it, without .png) into `<name>.atlas` + `<name>.png` in `outDir`.
 *  For an export folder that was edited by hand (images added) so a runtime loader finds every region. */
export function repackImagesDir(imagesDir: string, outDir: string, name: string): { images: number; width: number; height: number } {
  const found: { name: string; image: MutableImage }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (prefix === "" && entry === "images") continue;     // a stray nested images/images copy (hand-moved folders) is not a region
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (/\.png$/i.test(entry)) found.push({ name: `${prefix}${entry.replace(/\.png$/i, "")}`, image: bleed(readPng(full) as MutableImage, 2) });
    }
  };
  walk(imagesDir, "");
  const packed = packShelves(found, 2048, 2);
  writePng(join(outDir, `${name}.png`), composePage(packed.placed, packed.width, packed.height));
  writeFileSync(join(outDir, `${name}.atlas`), atlasText(`${name}.png`, packed.width, packed.height, packed.placed));
  return { images: found.length, width: packed.width, height: packed.height };
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export function exportSpine(options: SpineExportOptions): SpineExportResult {
  const documentPath = resolve(options.document);
  const raw = JSON.parse(readFileSync(documentPath, "utf8")) as Record<string, unknown>;
  const warnings: string[] = [];
  const spineVersion = options.spineVersion ?? "4.3.26";
  const v43 = !/^4.[0-2]./.test(spineVersion);

  // Merge clips from other documents of the same rig.
  for (const other of options.clipsFrom ?? []) {
    const extra = JSON.parse(readFileSync(resolve(other), "utf8")) as { animations?: Record<string, unknown> };
    raw.animations = { ...(raw.animations as Record<string, unknown>), ...(extra.animations ?? {}) };
  }
  const doc = loadAnimDocument(raw, { source: documentPath });
  const name = options.name ?? doc.name;
  const outDir = resolve(options.outDir);
  const atlasPath = resolve(options.atlas ?? documentPath.replace(/\.anim\.json$/i, ".atlas.json"));
  if (!existsSync(atlasPath)) throw new Error(`no atlas pack at ${atlasPath}; pass --atlas <rig.atlas.json>`);
  const pack: AtlasPack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));

  // Unsupported features.
  if (doc.physics.length > 0) warnings.push(`physics constraints (${doc.physics.map((p) => p.name).join(", ")}) are not exported`);
  if ((doc.drivenGrids ?? []).length > 0) warnings.push("driven grids (two-driver correctives) are not exported");
  for (const bone of doc.bones) if (bone.limits) warnings.push(`bone '${bone.name}': rotation limits have no Spine equivalent`);
  for (const driven of doc.driven) {
    for (const key of driven.keys) {
      if (Object.keys(key.deform).length > 0) warnings.push(`driven set '${driven.name}': deform keys are not exported`);
      if (Object.keys(key.alpha).length > 0) warnings.push(`driven set '${driven.name}': alpha is baked into slot colour timelines only`);
    }
  }
  if ((doc.drawOrder ?? []).length > 0) warnings.push("a document-level drawOrder list is not exported (slot order is used)");

  let pathSetupSkeleton: Skeleton | null = null;
  const boneIndex = new Map(doc.bones.map((b, i) => [b.name, i] as const));
  const slotIndex = new Map(doc.slots.map((s, i) => [s.name, i] as const));

  // Atlas pages, read once: the attachment images and the weapon grip search both need them.
  const rectFor = new Map<string, { page: AtlasPack["pages"][number]; rect: Rect }>();
  for (const page of pack.pages) for (const [path, rect] of Object.entries(page.regions)) rectFor.set(path, { page, rect });
  const pageImages = new Map<string, MutableImage>();
  const textureImage = (path: string): MutableImage => {
    const found = rectFor.get(path);
    if (!found) throw new Error(`texture '${path}' is not in ${atlasPath}`);
    let page = pageImages.get(found.page.file);
    if (!page) {
      page = readPng(join(dirname(atlasPath), found.page.file));
      pageImages.set(found.page.file, page);
    }
    return cropPage(page, found.rect);
  };

  // ---- weapon grip: the `weapon` bone moves onto the grip, every world position stays ----------------
  // `grip` is the grip in the weapon bone's local frame (this format's y down).
  const weaponBone = doc.bones.find((b) => b.name === "weapon");
  let grip: { x: number; y: number } | null = null;
  let shownWeapon: { slot: string; name: string; wrap: { x: number; y: number }; width: number; height: number } | null = null;
  if (weaponBone) {
    const slot = doc.slots.find((s) => s.bone === "weapon" && s.attachment);
    const shown = slot?.attachment ? Object.values(doc.skins)[0]?.attachments[slot.name]?.[slot.attachment] : undefined;
    if (slot && shown?.type === "region") {
      const wrap = findGripWrap(textureImage(shown.path));
      const plain = weaponBone.scaleX === 1 && weaponBone.scaleY === 1 && !weaponBone.shearX && !weaponBone.shearY;
      if (!wrap) warnings.push(`weapon '${slot.attachment}': no leather wrap found in its image, the weapon bone stays where the rig has it`);
      else if (!plain) warnings.push("weapon bone is scaled or sheared: it is not moved onto the grip");
      else {
        const cos = Math.cos(shown.rotation * DEG_TO_RAD);
        const sin = Math.sin(shown.rotation * DEG_TO_RAD);
        // The grip's pixels from the image centre, scaled, turned by the attachment's rotation and offset by its position.
        const u = (wrap.x - shown.width / 2) * shown.scaleX;
        const v = (wrap.y - shown.height / 2) * shown.scaleY;
        grip = { x: shown.x + cos * u - sin * v, y: shown.y + sin * u + cos * v };
        shownWeapon = { slot: slot.name, name: slot.attachment ?? "", wrap, width: shown.width, height: shown.height };
      }
    }
  }

  // ---- bones -------------------------------------------------------------------------------
  const bones = doc.bones.map((b) => {
    const out: Json = { name: b.name };
    if (b.parent !== undefined) out.parent = b.parent;
    if (b.length) out.length = num(b.length);
    let bx = b.x;
    let by = b.y;
    if (grip && b.name === "weapon") {
      // Origin onto the grip: its local offset turned into the parent's frame by the bone's rotation.
      const r = b.rotation * DEG_TO_RAD;
      bx += Math.cos(r) * grip.x - Math.sin(r) * grip.y;
      by += Math.sin(r) * grip.x + Math.cos(r) * grip.y;
    } else if (grip && b.parent === "weapon") {
      bx -= grip.x;
      by -= grip.y;
    }
    if (bx) out.x = num(bx);
    if (by) out.y = neg(by);
    if (b.rotation) out.rotation = neg(b.rotation);
    if (b.scaleX !== 1) out.scaleX = num(b.scaleX);
    if (b.scaleY !== 1) out.scaleY = num(b.scaleY);
    if (b.shearX) out.shearX = neg(b.shearX);
    if (b.shearY) out.shearY = neg(b.shearY);
    const inherit = inheritName(b.inherit, v43);
    if (inherit) out.inherit = inherit;
    if (HELPER_BONE.test(b.name)) {
      out.color = HELPER_COLOR;
      out.visible = false;
    } else {
      const posed = POSED_COLORS.find(([re]) => re.test(b.name));
      if (posed) out.color = posed[1];
    }
    return out;
  });

  // ---- slots (setup pose as this runtime draws it) ------------------------------------------
  const setup = setupFrame(doc);
  const slots: Json[] = doc.slots.map((s, i) => {
    const out: Json = { name: s.name, bone: s.bone };
    const color = setup.colors[i] as string;
    if (color !== "ffffffff") out.color = color;
    const attachment = setup.attachments[i] ?? null;
    if (attachment !== null) out.attachment = attachment;
    if (s.blend === "additive") out.blend = "additive";
    return out;
  });
  for (const [slot, bone] of POINT_BONES) {
    if (boneIndex.has(bone)) slots.push({ name: slot, bone, attachment: slot, visible: false });
  }

  // ---- skins, attachments and images ---------------------------------------------------------
  const textureNames = new Map<string, string>();
  const imageOrder: string[] = [];
  const imageName = (texturePath: string, slot: string, attachment: string, skinPrefix = ""): string => {
    let imageNameValue = textureNames.get(texturePath);
    if (!imageNameValue) {
      imageNameValue = `${skinPrefix}${slot}/${attachment}`;    // a non-default skin's images live under its own folder (same slot/name as the default skin's must not collide)
      textureNames.set(texturePath, imageNameValue);
      imageOrder.push(texturePath);
    }
    return imageNameValue;
  };

  /** The texture paths a sequence attachment plays: its path plus the zero-padded frame numbers. */
  const sequenceTextures = (a: { path: string; sequence?: { count: number; start: number; digits: number } | undefined }): string[] | null =>
    a.sequence ? Array.from({ length: a.sequence.count }, (_, i) => `${a.path}${String((a.sequence as { start: number }).start + i).padStart((a.sequence as { digits: number }).digits, "0")}`) : null;
  /**
   * The Spine image path of an attachment. A sequence repacks every frame image as `<slot>/<attachment><frame number>` (what Spine's sequence
   * naming reads); when a frame is missing from the atlas only the base image is written, with a warning.
   */
  const attachmentImage = (a: { path: string; sequence?: { count: number; start: number; digits: number } | undefined }, slot: string, attName: string, skinPrefix: string): string => {
    const frames = sequenceTextures(a);
    if (frames && a.sequence) {
      if (frames.every((p) => rectFor.has(p))) {
        const base = `${skinPrefix}${slot}/${attName}`;
        frames.forEach((p, i) => {
          if (textureNames.has(p)) return;
          textureNames.set(p, `${base}${String((a.sequence as { start: number }).start + i).padStart((a.sequence as { digits: number }).digits, "0")}`);
          imageOrder.push(p);
        });
        return base;
      }
      warnings.push(`sequence ${slot}/${attName}: not every frame image (${a.path}<number>) is in the atlas; only the base image is written`);
    }
    return imageName(a.path, slot, attName, skinPrefix);
  };

  const flips = new Map<string, { x: boolean; y: boolean }>();
  const pads = new Map<string, { x: number; y: number }>();
  const skins: Json[] = Object.entries(doc.skins).map(([skinName, skin], skinIndex) => {
    const attachmentsOut: Record<string, Record<string, Json>> = {};
    for (const [slot, byName] of Object.entries(skin.attachments)) {
      for (const [attName, a] of Object.entries(byName)) {
        let out: Json | null = null;
        if (a.type === "region") {
          out = { name: attName, path: attachmentImage(a, slot, attName, skinIndex > 0 ? `${skinName}/` : "") };
          // Pieces on the weapon bone: its origin moved by the grip, so the offset is measured from the grip now.
          const onWeapon = grip !== null && doc.slots.some((s) => s.name === slot && s.bone === "weapon");
          const ax = a.x - (onWeapon && grip ? grip.x : 0);
          const ay = a.y - (onWeapon && grip ? grip.y : 0);
          // The shown weapon image is padded so the grip is its centre: the attachment offset is then zero and the editor's treatment
          // of offsets cannot move it; rotation and scale act about the grip.
          const padded = shownWeapon !== null && slot === shownWeapon.slot && attName === shownWeapon.name;
          if (!padded && ax) out.x = num(ax);
          if (!padded && ay) out.y = neg(ay);
          if (a.rotation) out.rotation = neg(a.rotation);
          // The editor applies a negative attachment scale differently from the runtimes: the mirror is baked into the image instead.
          const flip = { x: a.scaleX < 0, y: a.scaleY < 0 };
          if (flip.x || flip.y) {
            for (const tex of sequenceTextures(a) ?? [a.path]) {
              const prior = flips.get(tex);
              if (prior && (prior.x !== flip.x || prior.y !== flip.y)) warnings.push(`texture '${tex}' is used with different mirrors; the first is baked`);
              else flips.set(tex, flip);
            }
          }
          if (Math.abs(a.scaleX) !== 1) out.scaleX = num(Math.abs(a.scaleX));
          if (Math.abs(a.scaleY) !== 1) out.scaleY = num(Math.abs(a.scaleY));
          out.width = num(a.width);
          out.height = num(a.height);
          if (padded && shownWeapon) {
            const gx = a.scaleX < 0 ? shownWeapon.width - shownWeapon.wrap.x : shownWeapon.wrap.x;
            const gy = a.scaleY < 0 ? shownWeapon.height - shownWeapon.wrap.y : shownWeapon.wrap.y;
            pads.set(a.path, { x: gx, y: gy });
            out.width = Math.round(2 * Math.max(gx, a.width - gx));
            out.height = Math.round(2 * Math.max(gy, a.height - gy));
          }
        } else if (a.type === "mesh") {
          if (a.groups || a.embed) warnings.push(`mesh ${slot}/${attName}: draw groups / embedded vertices are not exported`);
          const vertices: number[] = [];
          if (!a.bones) {
            for (let i = 0; i < a.vertices.length; i += 2) vertices.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
          } else {
            const table = a.bones.map((n) => {
              const index = boneIndex.get(n);
              if (index === undefined) throw new Error(`mesh ${slot}/${attName}: unknown bone '${n}'`);
              return index;
            });
            let i = 0;
            while (i < a.vertices.length) {
              const n = a.vertices[i++] as number;
              vertices.push(n);
              // One bone order for the whole mesh (skeleton order): the editor keeps a single bone list per mesh.
              const influences: number[][] = [];
              for (let k = 0; k < n; k++, i += 4) {
                influences.push([table[a.vertices[i] as number] as number, num(a.vertices[i + 1] as number), neg(a.vertices[i + 2] as number), num(a.vertices[i + 3] as number)]);
              }
              influences.sort((p, q) => (p[0] as number) - (q[0] as number));
              for (const influence of influences) vertices.push(...influence);
            }
          }
          out = {
            name: attName,
            type: "mesh",
            path: attachmentImage(a, slot, attName, skinIndex > 0 ? `${skinName}/` : ""),
            uvs: a.uvs.map(num),
            triangles: a.triangles,
            vertices,
            hull: a.hull
          };
          // Spine edges are vertex index * 2 (pairs, hull edges included); ours are plain vertex indices.
          if (a.edges) out.edges = a.edges.map((v) => v * 2);
          out.width = num(a.width);
          out.height = num(a.height);
        } else if (a.type === "path") {
          const vertices: number[] = [];
          let lengths: number[];
          if (!a.bones) {
            for (let i = 0; i < a.vertices.length; i += 2) vertices.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
            lengths = pathCurveLengths(a.vertices, a.closed, a.vertexCount);
          } else {
            const table = a.bones.map((n) => {
              const index = boneIndex.get(n);
              if (index === undefined) throw new Error(`path ${slot}/${attName}: unknown bone '${n}'`);
              return index;
            });
            let i = 0;
            while (i < a.vertices.length) {
              const n = a.vertices[i++] as number;
              vertices.push(n);
              const influences: number[][] = [];
              for (let k = 0; k < n; k++, i += 4) {
                influences.push([table[a.vertices[i] as number] as number, num(a.vertices[i + 1] as number), neg(a.vertices[i + 2] as number), num(a.vertices[i + 3] as number)]);
              }
              influences.sort((p, q) => (p[0] as number) - (q[0] as number));
              for (const influence of influences) vertices.push(...influence);
            }
            // Spine recomputes the lengths of a constant-speed path itself; a weighted one is measured at the setup pose.
            const world = new Float64Array(a.vertexCount * 2);
            if (!pathSetupSkeleton) {
              pathSetupSkeleton = new Skeleton(doc);
              pathSetupSkeleton.updateWorldTransform("none");
            }
            const shape = { vertices: Float64Array.from(a.vertices), bones: a.bones, vertexCount: a.vertexCount } as unknown as PathAttachment;
            computePathWorld(pathSetupSkeleton, shape, pathSetupSkeleton.getSlot(slot).bone, world);
            lengths = pathCurveLengths(world, a.closed, a.vertexCount);
          }
          out = { type: "path", closed: a.closed, constantSpeed: a.constantSpeed, lengths: lengths.map(num), vertexCount: a.vertexCount, vertices };
        } else if (a.type === "point") {
          out = { type: "point", x: num(a.x), y: neg(a.y), rotation: neg(a.rotation) };
        } else if (a.type === "clipping" || a.type === "boundingbox") {
          const flipped: number[] = [];
          for (let i = 0; i < a.vertices.length; i += 2) flipped.push(num(a.vertices[i] as number), neg(a.vertices[i + 1] as number));
          out = { type: a.type, vertexCount: flipped.length / 2, vertices: flipped };
          if (a.type === "clipping" && a.end !== undefined) out.end = a.end;
        } else {
          const parentIndex = Object.keys(doc.skins).indexOf(a.source.skin);
          if (doc.skins[a.source.skin]?.attachments[a.source.slot]?.[a.source.attachment]?.type !== "mesh") {
            warnings.push(`linked mesh ${skinName}/${slot}/${attName}: source ${a.source.skin}/${a.source.slot}/${a.source.attachment} is not a mesh; not exported`);
          } else if (!v43 && a.source.slot !== slot) {
            // Before 4.3 Spine looks the parent up in the linked mesh's own slot.
            warnings.push(`linked mesh ${skinName}/${slot}/${attName}: source is in slot '${a.source.slot}' but Spine ${spineVersion} linked meshes share the parent's slot; not exported`);
          } else {
            out = {
              name: attName,
              type: "linkedmesh",
              path: imageName(a.path, slot, attName, skinIndex > 0 ? `${skinName}/` : ""),
              skin: parentIndex === 0 ? "default" : a.source.skin,
              width: num(a.width),
              height: num(a.height)
            };
            // 4.3 reads the link from `source` (+ `slot` when it is another slot's mesh); 4.2 and older read `parent`, which 4.3 ignores.
            if (v43) {
              out.source = a.source.attachment;
              if (a.source.slot !== slot) out.slot = a.source.slot;
            } else {
              out.parent = a.source.attachment;
            }
            if (a.inheritDeform === false) out.timelines = false;
          }
        }
        if (out) {
          if (a.type !== "point" && a.color !== "ffffffff") out.color = a.color;
          if ((a.type === "region" || a.type === "mesh" || a.type === "linkedMesh") && a.sequence) out.sequence = { count: a.sequence.count, start: a.sequence.start, digits: a.sequence.digits, setup: a.sequence.setup };
          (attachmentsOut[slot] ??= {})[attName] = out;
        }
      }
    }
    if (skinIndex === 0) {
      for (const [slot, bone] of POINT_BONES) {
        if (boneIndex.has(bone)) attachmentsOut[slot] = { [slot]: { type: "point", x: 0, y: 0, rotation: 0, color: SLOT_HELPER_COLOR } };
      }
    }
    return { name: skinIndex === 0 ? "default" : skinName, attachments: attachmentsOut };
  });

  // ---- animations -----------------------------------------------------------------------------
  const clipNames = options.clips ?? Object.keys(doc.animations).filter((n) => n !== "review");
  const animations: Record<string, Json> = {};
  const baked: SpineExportResult["baked"] = {};
  for (const clipName of clipNames) {
    const clip = doc.animations[clipName];
    if (!clip) throw new Error(`no clip '${clipName}'; clips: ${Object.keys(doc.animations).join(", ")}`);
    if (Object.keys(clip.physics).length > 0) warnings.push(`clip '${clipName}': physics timelines are not exported`);
    const out: Json = {};

    // Deform (shape keys), skin -> slot -> attachment -> { deform }, the 4.2+ `attachments` layout.
    const skinNames = Object.keys(doc.skins);
    const deformOut: Record<string, Record<string, Record<string, Json>>> = {};
    for (const [skinName, bySlot] of Object.entries(clip.deform)) {
      for (const [slot, byAtt] of Object.entries(bySlot)) {
        for (const [attName, keys] of Object.entries(byAtt)) {
          let target = doc.skins[skinName]?.attachments[slot]?.[attName];
          const exists = target !== undefined;
          if (target?.type === "linkedMesh") target = doc.skins[target.source.skin]?.attachments[target.source.slot]?.[target.source.attachment];
          if (!exists || !target || target.type !== "mesh") {
            warnings.push(`clip '${clipName}': deform timeline ${skinName}/${slot}/${attName} does not target a mesh; not exported`);
            continue;
          }
          const spineSkin = skinNames.indexOf(skinName) === 0 ? "default" : skinName;
          ((deformOut[spineSkin] ??= {})[slot] ??= {})[attName] = { deform: spineDeformKeys(target, keys, boneIndex) };
        }
      }
    }
    if (Object.keys(deformOut).length > 0) out.attachments = deformOut;

    // Bones.
    const boneTimelines: Record<string, Json> = {};
    for (const [bone, t] of Object.entries(clip.bones)) {
      const entry: Json = {};
      if (t.rotate) {
        entry.rotate = spineKeys(t.rotate, ["value"], ["value"], (k) => [neg((k as (typeof t.rotate)[number]).value)]);
      }
      const vector = (label: "translate" | "scale" | "shear", keys: NonNullable<typeof t.translate>, fx: (v: number) => number, fy: (v: number) => number) => {
        const values = (k: KeyLike) => [fx((k as (typeof keys)[number]).x), fy((k as (typeof keys)[number]).y)];
        const both = spineKeys(keys, ["x", "y"], ["x", "y"], values);
        if (both) {
          entry[label] = both;
          return;
        }
        // Mixed stepped / smooth channels: one single-channel timeline each.
        entry[`${label}x`] = spineKeys(keys, ["x"], ["value"], (k) => [values(k)[0] as number]);
        entry[`${label}y`] = spineKeys(keys, ["y"], ["value"], (k) => [values(k)[1] as number]);
      };
      if (bone === "weapon" && grip && weaponBone && t.rotate) {
        // The weapon's origin sits on the grip, so Spine rotates it about the grip; this runtime rotates it about the bone origin.
        // Translate keys at every clip frame (and every key) move the grip point where the runtime puts it.
        const rotateKeys = t.rotate;
        const translateKeys = t.translate ?? [];
        const fps = clip.fps ?? DEFAULT_CLIP_FPS;
        const times = new Set<number>([...rotateKeys.map((k) => k.time), ...translateKeys.map((k) => k.time)]);
        for (let f = 0; f <= Math.round(clip.duration * fps); f++) times.add(num(Math.min(f / fps, clip.duration)));
        const turn = (deg: number): [number, number] => [
          Math.cos(deg * DEG_TO_RAD) * grip.x - Math.sin(deg * DEG_TO_RAD) * grip.y,
          Math.sin(deg * DEG_TO_RAD) * grip.x + Math.cos(deg * DEG_TO_RAD) * grip.y
        ];
        const [sx, sy] = turn(weaponBone.rotation);
        entry.translate = [...times]
          .sort((p, q) => p - q)
          .map((time) => {
            const r = sampleKeys(rotateKeys, "value", (k) => k.value, time);
            const [rx, ry] = turn(weaponBone.rotation + r);
            const tx = translateKeys.length ? sampleKeys(translateKeys, "x", (k) => k.x, time) : 0;
            const ty = translateKeys.length ? sampleKeys(translateKeys, "y", (k) => k.y, time) : 0;
            return { time: num(time), x: num(tx - sx + rx), y: neg(ty - sy + ry) };
          });
        warnings.push(`clip '${clipName}': weapon rotation was baked into per-frame translate keys (Spine pivots about the grip)`);
      } else if (t.translate) vector("translate", t.translate, num, neg);
      if (t.scale) vector("scale", t.scale, num, num);
      if (t.shear) vector("shear", t.shear, neg, neg);
      if (Object.keys(entry).length > 0) boneTimelines[bone] = entry;
    }
    if (Object.keys(boneTimelines).length > 0) out.bones = boneTimelines;

    // Constraint mixes.
    const ikTimelines: Record<string, Json[]> = {};
    for (const [constraint, keys] of Object.entries(clip.ik)) {
      const data = doc.ik.find((c) => c.name === constraint);
      if (!data) continue;
      const result = spineKeys(keys, ["mix", "softness"], ["mix", "softness"], (k) => [(k as (typeof keys)[number]).mix ?? data.mix, (k as (typeof keys)[number]).softness ?? data.softness]);
      if (!result) {
        warnings.push(`clip '${clipName}' ik '${constraint}': mixed stepped / smooth curves were exported stepped`);
        continue;
      }
      keys.forEach((k, i) => {
        const entry = result[i] as Json;
        entry.bendPositive = !(k.bendPositive ?? data.bendPositive);
        if (k.stretch ?? data.stretch) entry.stretch = true;
        if (k.compress ?? data.compress) entry.compress = true;
      });
      ikTimelines[constraint] = result;
    }
    if (Object.keys(ikTimelines).length > 0) out.ik = ikTimelines;
    const transformTimelines: Record<string, Json[]> = {};
    for (const [constraint, keys] of Object.entries(clip.transform)) {
      const data = doc.transform.find((c) => c.name === constraint);
      if (!data) continue;
      const result = spineKeys(keys, mixChannels, mixChannels, (k) => mixChannels.map((c) => (k as (typeof keys)[number])[c] ?? data[c]));
      if (!result) {
        warnings.push(`clip '${clipName}' transform '${constraint}': mixed stepped / smooth curves are not exported`);
        continue;
      }
      transformTimelines[constraint] = result;
    }
    if (Object.keys(transformTimelines).length > 0) out.transform = transformTimelines;

    const pathTimelines: Record<string, Json> = {};
    for (const [constraint, keys] of Object.entries(clip.path)) {
      const data = doc.path.find((c) => c.name === constraint);
      if (!data) continue;
      const entry: Json = {};
      const typed = keys as unknown as Record<string, number | undefined>[];
      for (const [field, name] of [["position", "position"], ["spacing", "spacing"]] as const) {
        if (!typed.some((k) => k[field] !== undefined)) continue;
        const result = spineKeys(keys, [field], ["value"], (k) => [(k as Record<string, number | undefined>)[field] ?? data[field]]);
        if (result) entry[name] = result;
        else warnings.push(`clip '${clipName}' path '${constraint}': mixed stepped / smooth curves are not exported`);
      }
      const mixes = ["mixRotate", "mixX", "mixY"] as const;
      if (typed.some((k) => mixes.some((m) => k[m] !== undefined))) {
        const result = spineKeys(keys, mixes, mixes, (k) => mixes.map((m) => (k as Record<string, number | undefined>)[m] ?? data[m]));
        if (result) entry.mix = result;
        else warnings.push(`clip '${clipName}' path '${constraint}': mixed stepped / smooth curves are not exported`);
      }
      if (Object.keys(entry).length > 0) pathTimelines[constraint] = entry;
    }
    if (Object.keys(pathTimelines).length > 0) out.path = pathTimelines;

    // Slot attachments, slot colours and the draw order, baked from the runtime (driven keys included).
    const sampled = sampleClip(doc, clipName);
    const slotTimelines: Record<string, Json> = {};
    const bakedSlots: string[] = [];
    doc.slots.forEach((slot, s) => {
      const attachmentKeys: Json[] = [];
      const colorKeys: Json[] = [];
      let attachmentChanges = false;
      let colorChanges = false;
      let lastAttachment: string | null | undefined;
      let lastColor: string | undefined;
      for (const frame of sampled.frames) {
        const attachment = frame.attachments[s] ?? null;
        const color = frame.colors[s] as string;
        if (attachment !== (setup.attachments[s] ?? null)) attachmentChanges = true;
        if (color !== setup.colors[s]) colorChanges = true;
        if (attachment !== lastAttachment) attachmentKeys.push({ time: num(frame.time), name: attachment });
        if (color !== lastColor) colorKeys.push({ time: num(frame.time), color, curve: "stepped" });
        lastAttachment = attachment;
        lastColor = color;
      }
      const entry: Json = {};
      const sequenceKeys = clip.slots[slot.name]?.sequence;
      if (sequenceKeys && sequenceKeys.length > 0) entry.sequence = sequenceKeys.map((k) => ({ time: num(k.time), mode: k.mode, index: k.index, delay: num(k.delay) }));
      if (attachmentChanges) entry.attachment = attachmentKeys;
      if (colorChanges) {
        // The last key has no span after it.
        const last = colorKeys[colorKeys.length - 1] as Json;
        if (colorKeys.length === 1) delete last.curve;
        entry.rgba = colorKeys;
      }
      if (Object.keys(entry).length > 0) {
        slotTimelines[slot.name] = entry;
        bakedSlots.push(slot.name);
      }
    });
    if (Object.keys(slotTimelines).length > 0) out.slots = slotTimelines;

    const drawOrder: Json[] = [];
    let lastOffsets = "";
    sampled.frames.forEach((frame, f) => {
      const offsets = drawOrderOffsets(frame.order);
      const signature = JSON.stringify(offsets);
      if (signature === lastOffsets && !(f === 0 && offsets.length > 0)) return;
      if (f === 0 && offsets.length === 0) {
        lastOffsets = signature;
        return;
      }
      const slotsOut = offsets.map((o) => ({ slot: (doc.slots[o.slot] as { name: string }).name, offset: o.offset }));
      drawOrder.push(slotsOut.length > 0 ? { time: num(frame.time), offsets: slotsOut } : { time: num(frame.time) });
      lastOffsets = signature;
    });
    if (drawOrder.length > 0) out.drawOrder = drawOrder;

    if (clip.events.length > 0) {
      out.events = clip.events.map((e) => ({
        time: num(e.time),
        name: e.name,
        ...(e.int !== undefined ? { int: e.int } : {}),
        ...(e.float !== undefined ? { float: e.float } : {}),
        ...(e.string !== undefined ? { string: e.string } : {})
      }));
    }

    // A loop's closing key repeats its first frame; give the animation its duration with a no-op bone key if empty.
    animations[clipName] = out;
    baked[clipName] = { frames: sampled.frames.length, slots: bakedSlots, drawOrderKeys: drawOrder.length };
    if (clip.loop && sampled.frames.length > 0) {
      // Spine loops over the last key time; close every baked slot timeline at the clip's end so the loop wraps cleanly.
      const end = num(clip.duration);
      const first = sampled.frames[0] as Frame;
      for (const slotName of bakedSlots) {
        const s = slotIndex.get(slotName) as number;
        const entry = (out.slots as Record<string, Json>)[slotName] as Json;
        const att = entry.attachment as Json[] | undefined;
        if (att && (att[att.length - 1] as Json).name !== (first.attachments[s] ?? null)) att.push({ time: end, name: first.attachments[s] ?? null });
      }
      const dos = out.drawOrder as Json[] | undefined;
      if (dos) {
        const closing = drawOrderOffsets(first.order);
        const lastKey = dos[dos.length - 1] as Json;
        if (JSON.stringify(lastKey.offsets ?? []) !== JSON.stringify(closing.map((o) => ({ slot: (doc.slots[o.slot] as { name: string }).name, offset: o.offset })))) {
          dos.push(closing.length > 0 ? { time: end, offsets: closing.map((o) => ({ slot: (doc.slots[o.slot] as { name: string }).name, offset: o.offset })) } : { time: end });
        }
      }
    }
  }

  // ---- constraints, in this runtime's execution order -------------------------------------------
  const skeletonForOrder = new Skeleton(doc);
  const orderOf = new Map<string, number>();
  skeletonForOrder.constraints.forEach((c, position) => orderOf.set(`${c.kind}:${c.index}`, position));
  const mixProperty = { mixRotate: "rotate", mixX: "x", mixY: "y", mixScaleX: "scaleX", mixScaleY: "scaleY", mixShearY: "shearY" } as const;
  const ik = doc.ik.map((c, i) => {
    const out: Json = { name: c.name, order: orderOf.get(`ik:${i}`) ?? 0, ...(v43 ? { type: "ik" } : {}), bones: c.bones, target: c.target };
    if (c.mix !== 1) out.mix = num(c.mix);
    if (c.softness) out.softness = num(c.softness);
    // Mirroring the skeleton about x turns clockwise into counter-clockwise: the bend side flips.
    out.bendPositive = !c.bendPositive;
    if (c.compress) out.compress = true;
    if (c.stretch) out.stretch = true;
    if (c.uniform) {
      if (v43) out.scaleY = "uniform";
      else out.uniform = true;
    }
    return out;
  });
  const transform = doc.transform.map((c, i) => {
    const out: Json = { name: c.name, order: orderOf.get(`transform:${i}`) ?? 0, ...(v43 ? { type: "transform" } : {}), bones: c.bones };
    if (v43) {
      // 4.3: the target became the `source`; "local" reads and writes local transforms, "relative" is "additive"; each mix channel
      // is a source property mapped one to one onto the same target property, present only when the mix is ever non-zero.
      out.source = c.target;
      if (c.local) {
        out.localSource = true;
        out.localTarget = true;
      }
      if (c.relative) out.additive = true;
      const used = (channel: (typeof mixChannels)[number]): boolean =>
        c[channel] !== 0 || clipNames.some((n) => ((doc.animations[n]?.transform[c.name] ?? []) as unknown as Record<string, number | undefined>[]).some((k) => (k[channel] ?? c[channel]) !== 0));
      const properties: Record<string, Json> = {};
      for (const channel of mixChannels) if (used(channel)) properties[mixProperty[channel]] = { to: { [mixProperty[channel]]: {} } };
      out.properties = properties;
    } else {
      out.target = c.target;
      if (c.local) out.local = true;
      if (c.relative) out.relative = true;
    }
    if (c.offset.rotation) out.rotation = neg(c.offset.rotation);
    if (c.offset.x) out.x = num(c.offset.x);
    if (c.offset.y) out.y = neg(c.offset.y);
    if (c.offset.scaleX) out.scaleX = num(c.offset.scaleX);
    if (c.offset.scaleY) out.scaleY = num(c.offset.scaleY);
    if (c.offset.shearY) out.shearY = neg(c.offset.shearY);
    for (const channel of mixChannels) out[channel] = num(c[channel]);
    return out;
  });
  const pathConstraints = doc.path.map((c, i) => {
    const out: Json = { name: c.name, order: orderOf.get(`path:${i}`) ?? 0, ...(v43 ? { type: "path" } : {}), bones: c.bones, [v43 ? "slot" : "target"]: c.target };
    out.positionMode = c.positionMode;
    out.spacingMode = c.spacingMode;
    out.rotateMode = c.rotateMode; // Spine reads the name with its first letter capitalised: "chainScale" -> RotateMode.ChainScale (4.3.13 reader; "chain scale" would not resolve)
    if (c.offsetRotation) out.rotation = neg(c.offsetRotation);
    if (c.position) out.position = num(c.position);
    if (c.spacing) out.spacing = num(c.spacing);
    out.mixRotate = num(c.mixRotate);
    out.mixX = num(c.mixX);
    if (c.mixY !== c.mixX) out.mixY = num(c.mixY);
    return out;
  });
  // 4.3 has no `order`: the `constraints` array is the execution order.
  const constraints = [...ik, ...transform, ...pathConstraints].sort((a, b) => (a.order as number) - (b.order as number));
  if (v43) for (const c of constraints) delete c.order;

  // ---- images and atlas ------------------------------------------------------------------------
  const images: { name: string; image: MutableImage }[] = [];
  for (const path of imageOrder) images.push({ name: textureNames.get(path) as string, image: padImage(mirrored(textureImage(path), flips.get(path)), pads.get(path)) });
  mkdirSync(outDir, { recursive: true });
  for (const { name: imageNameValue, image } of images) writePng(join(outDir, "images", `${imageNameValue}.png`), image);

  let atlasFile: string | null = null;
  if (!options.noAtlas) {
    const bled = images.map(({ name: n, image }) => ({ name: n, image: bleed(image, 2) }));
    const packed = packShelves(bled, 2048, 2);
    const pageFile = `${name}.png`;
    writePng(join(outDir, pageFile), composePage(packed.placed, packed.width, packed.height));
    atlasFile = join(outDir, `${name}.atlas`);
    writeFileSync(atlasFile, atlasText(pageFile, packed.width, packed.height, packed.placed));
  }

  // ---- skeleton -------------------------------------------------------------------------------
  const { canvas } = doc;
  const skeleton: Json = {
    spine: spineVersion,
    x: num(-canvas.originX),
    y: num(canvas.originY - canvas.height),
    width: canvas.width,
    height: canvas.height,
    images: "./images/",
    fps: DEFAULT_CLIP_FPS
  };
  const eventDefs = Object.fromEntries(
    Object.entries(doc.events).map(([n, d]) => [n, { ...(d.int ? { int: d.int } : {}), ...(d.float ? { float: d.float } : {}), ...(d.string ? { string: d.string } : {}), ...(d.audio ? { audio: d.audio } : {}) }])
  );
  const eventsOut = Object.keys(eventDefs).length > 0 ? { events: eventDefs } : {};
  const data: Json = v43
    ? { skeleton, bones, slots, ...(constraints.length ? { constraints } : {}), skins, ...eventsOut, animations }
    : { skeleton, bones, slots, ...(ik.length ? { ik } : {}), ...(transform.length ? { transform } : {}), ...(pathConstraints.length ? { path: pathConstraints } : {}), skins, ...eventsOut, animations };
  const jsonPath = join(outDir, `${name}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(data)}\n`);

  const result: SpineExportResult = { json: jsonPath, atlas: atlasFile, images: images.length, clips: clipNames, warnings: [...new Set(warnings)], baked };
  writeFileSync(join(outDir, "export-report.json"), `${JSON.stringify({ source: basename(documentPath), ...result, json: basename(jsonPath), atlas: atlasFile ? basename(atlasFile) : null }, null, 2)}\n`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

export async function exportSpineCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [document, outDir] = positional;
  if (!document || !outDir) {
    process.stderr.write("usage: animator export-spine <rig.anim.json> <outDir> [--name N] [--atlas rig.atlas.json] [--clips a,b] [--clips-from other.anim.json[,..]] [--spine-version 4.3.26] [--no-atlas]\n");
    return 2;
  }
  const text = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const list = (name: string): string[] | undefined => text(name)?.split(",").map((s) => s.trim()).filter(Boolean);
  const options: SpineExportOptions = { document, outDir };
  const optional: [keyof SpineExportOptions, unknown][] = [
    ["atlas", text("atlas")],
    ["name", text("name")],
    ["clips", list("clips")],
    ["clipsFrom", list("clips-from")],
    ["spineVersion", text("spine-version")],
    ["noAtlas", flags.has("no-atlas") ? true : undefined]
  ];
  for (const [key, value] of optional) if (value !== undefined) (options as unknown as Record<string, unknown>)[key] = value;
  const result = exportSpine(options);
  process.stdout.write(`spine export: ${result.json}\n  ${result.images} image(s)${result.atlas ? `, atlas ${result.atlas}` : ""}\n  clips: ${result.clips.join(", ") || "none"}\n`);
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  return 0;
}
