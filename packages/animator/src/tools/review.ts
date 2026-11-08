/*
 * Atlas Animator: original implementation.
 *
 * Review images for the user and the reviewer (plan 4.6 step 5, Phase 4 review): weight heat
 * overlays per bone, a weights overview, and contact sheets of bent poses at the joint limits
 * (full figure, and 1x close-ups of shoulders, elbows and hips). Drawn with the CPU rasteriser,
 * not the game's Pixi renderer: every tile's label says so, with its scale (output px per canvas
 * px), DPR and texture filter, so a "1x" sheet is never mistaken for a game-size or
 * production-renderer view.
 */
import type { MeshAttachment } from "../core/attachments.js";
import type { AnimDocument } from "../core/format.js";
import { Skeleton } from "../core/skeleton.js";
import type { Slot } from "../core/slot.js";
import { blendPixel, createImage, drawImage, type MutableImage, type RgbaImage } from "./image.js";
import { rigPoses } from "./rigPoses.js";
import { softRender, worldScratch } from "./softRender.js";

// ---------------------------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------------------------

/** A named pose: bone rotation offsets from the setup pose, in degrees (clamped by limits). */
export interface ReviewPose {
  name: string;
  rotate: Record<string, number>;
  /** Plan probes: scale factors per bone (over setup), translation per bone (local px), slot attachment changes (null hides). */
  scale?: Record<string, { x: number; y: number }>;
  translate?: Record<string, { x: number; y: number }>;
  attachments?: Record<string, string | null>;
  /** IK mix for every constraint (r3: generated poses run with IK released, 0); default the document's. */
  ikMix?: number;
}

export function poseSkeleton(doc: AnimDocument, skins: readonly string[], pose: ReviewPose | null): Skeleton {
  const skeleton = new Skeleton(doc);
  skeleton.x = doc.canvas.originX;
  skeleton.y = doc.canvas.originY;
  skeleton.setActiveSkins(skins);
  skeleton.setToSetupPose();
  for (const [name, degrees] of Object.entries(pose?.rotate ?? {})) {
    const bone = skeleton.findBone(name);
    if (bone) bone.pose.rotation = bone.data.rotation + degrees;
  }
  for (const [name, s] of Object.entries(pose?.scale ?? {})) {
    const bone = skeleton.findBone(name);
    if (bone) {
      bone.pose.scaleX = bone.data.scaleX * s.x;
      bone.pose.scaleY = bone.data.scaleY * s.y;
    }
  }
  for (const [name, t] of Object.entries(pose?.translate ?? {})) {
    const bone = skeleton.findBone(name);
    if (bone) {
      bone.pose.x = bone.data.x + t.x;
      bone.pose.y = bone.data.y + t.y;
    }
  }
  for (const [name, attachment] of Object.entries(pose?.attachments ?? {})) {
    const slot = skeleton.findSlot(name);
    if (slot) slot.placeholder = attachment;
  }
  if (pose?.ikMix !== undefined) for (const c of skeleton.ikConstraints) c.pose.mix = pose.ikMix;
  for (const bone of skeleton.bones) Object.assign(bone.applied, bone.pose);
  skeleton.updateWorldTransform("pose");
  return skeleton;
}

// ---------------------------------------------------------------------------------------------
// Render labels
// ---------------------------------------------------------------------------------------------

/** How a review image was made: recorded in every tile label. */
export interface RenderInfo {
  /** Output pixels per canvas pixel. */
  scale: number;
  /** Device pixel ratio (output pixels per CSS pixel). */
  dpr: number;
  /** Texture filtering. */
  filter: string;
  renderer: string;
}

/** The CPU rasteriser of these sheets (`softRender`): bilinear texels, no device pixel ratio. */
export const SOFT_RENDER: Omit<RenderInfo, "scale"> = { dpr: 1, filter: "bilinear", renderer: "cpu soft" };

/** e.g. "0.5x dpr1 bilinear cpu soft". */
export function renderTag(info: RenderInfo): string {
  return `${Number(info.scale.toFixed(3))}x dpr${Number(info.dpr.toFixed(3))} ${info.filter} ${info.renderer}`;
}

// ---------------------------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface JointSheetOptions {
  skins?: readonly string[];
  poses?: readonly ReviewPose[];
  /** Full-figure tiles: world rectangle shown and scale (default: the canvas at 0.5). */
  frame?: Rect;
  scale?: number;
  columns?: number;
  /** Draw the mesh wireframe over the art. */
  wireframe?: boolean;
}

/** A grid of the figure in each pose, each tile labelled with the pose and how it was rendered. */
export function jointContactSheet(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, options: JointSheetOptions = {}): MutableImage {
  return grid(jointSheetTiles(doc, textures, options), options.columns ?? 4);
}

/** The tiles of `jointContactSheet`: the pose name, then the render tag on a second line. */
export function jointSheetTiles(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, options: JointSheetOptions = {}): { image: MutableImage; label: string }[] {
  const poses = options.poses ?? rigPoses(doc);
  const frame = options.frame ?? { x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height };
  const scale = options.scale ?? 0.5;
  const tag = renderTag({ scale, ...SOFT_RENDER });
  return poses.map((pose) => {
    const skeleton = poseSkeleton(doc, options.skins ?? ["body"], pose);
    const tile = softRender(skeleton, textures, {
      width: Math.round(frame.width * scale),
      height: Math.round(frame.height * scale),
      scale,
      left: frame.x,
      top: frame.y,
      background: [255, 255, 255]
    }).image;
    if (options.wireframe) drawWireframe(tile, skeleton, scale, frame.x, frame.y, [40, 90, 220, 120]);
    return { image: tile, label: `${pose.name}\n${tag}` };
  });
}

/** Lays out labelled tiles in a grid with a label strip above each (one text line per line of the label). */
export function grid(tiles: readonly { image: RgbaImage; label: string }[], columns: number, fontScale = 2, fitImages = false): MutableImage {
  // fitImages (render sheets, second rig acceptance): a tile is exactly its frame's width (the
  // render --size); the label drops to the small font, then is cut, rather than widen the tile.
  if (fitImages) {
    const frame = Math.max(...tiles.map((t) => t.image.width));
    const longest = Math.max(...tiles.flatMap((t) => t.label.split("\n").map((line) => line.length)));
    if (6 * fontScale * (longest + 1) > frame) fontScale = 1;
    const room = Math.max(1, Math.floor(frame / (6 * fontScale)) - 1);
    tiles = tiles.map((t) => ({ image: t.image, label: t.label.split("\n").map((line) => (line.length > room ? `${line.slice(0, Math.max(1, room - 2))}..` : line)).join("\n") }));
  }
  const lines = Math.max(1, ...tiles.map((t) => t.label.split("\n").length));
  const lineHeight = 8 * fontScale;
  const labelHeight = 5 * fontScale + lineHeight * lines;
  const gap = 6;
  const cellWidth = Math.max(...tiles.map((t) => (fitImages ? t.image.width : Math.max(t.image.width, 6 * fontScale + 6 * fontScale * Math.max(...t.label.split("\n").map((line) => line.length))))));
  const cellHeight = Math.max(...tiles.map((t) => t.image.height)) + labelHeight;
  const cols = Math.min(columns, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const sheet = createImage(cols * cellWidth + (cols + 1) * gap, rows * cellHeight + (rows + 1) * gap);
  for (let p = 0; p < sheet.data.length; p += 4) sheet.data.set([200, 200, 205, 255], p);
  tiles.forEach((tile, i) => {
    const x = gap + (i % cols) * (cellWidth + gap);
    const y = gap + Math.floor(i / cols) * (cellHeight + gap);
    fillRect(sheet, x, y, cellWidth, labelHeight, [40, 40, 48]);
    tile.label.split("\n").forEach((line, k) => drawText(sheet, line, x + 3 * fontScale, y + 3 * fontScale + lineHeight * k, fontScale, [255, 255, 255]));
    drawImage(sheet, tile.image, x, y + labelHeight);
  });
  return sheet;
}

// ---------------------------------------------------------------------------------------------
// Weight overlays
// ---------------------------------------------------------------------------------------------

/** Weight of skeleton bone `bone` per vertex of a weighted mesh (0 for unweighted meshes). */
export function vertexWeightsOf(mesh: MeshAttachment, bone: number): Float64Array {
  const { geometry } = mesh;
  const out = new Float64Array(geometry.vertexCount);
  if (!geometry.weighted) return out;
  let influence = 0;
  for (let v = 0; v < geometry.vertexCount; v++) {
    const end = influence + (geometry.counts[v] as number);
    for (; influence < end; influence++) if (geometry.influenceBones[influence] === bone) out[v] = (out[v] as number) + (geometry.weights[influence] as number);
  }
  return out;
}

/** Heat ramp: 0 blue, 0.25 cyan, 0.5 green, 0.75 yellow, 1 red. */
export function heat(weight: number): [number, number, number] {
  const w = Math.max(0, Math.min(1, weight));
  const stops: [number, number, number][] = [[30, 40, 200], [0, 200, 230], [40, 200, 60], [250, 220, 0], [235, 30, 30]];
  const f = w * 4;
  const i = Math.min(3, Math.floor(f));
  const t = f - i;
  const a = stops[i] as [number, number, number];
  const b = stops[i + 1] as [number, number, number];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface WeightSheetOptions {
  skins?: readonly string[];
  /** Pose the overlay is drawn in (default rest). */
  pose?: ReviewPose | null;
  /** World rectangle per tile (default: the slot's setup bounds plus a margin). */
  margin?: number;
}

/**
 * One tile per bone that influences the slot's mesh: the heat of that bone's weight over the
 * art, with the wireframe. Returns null when the slot has no weighted mesh.
 */
export function weightHeatSheet(
  doc: AnimDocument,
  textures: ReadonlyMap<string, RgbaImage>,
  slotName: string,
  options: WeightSheetOptions = {}
): MutableImage | null {
  const skeleton = poseSkeleton(doc, options.skins ?? ["body"], options.pose ?? null);
  const slot = skeleton.findSlot(slotName);
  const mesh = slot?.attachment;
  if (!slot || !mesh || mesh.type !== "mesh" || !mesh.geometry.weighted) return null;
  const bones = [...new Set(Array.from(mesh.geometry.influenceBones))].sort((a, b) => a - b);
  const bounds = slotBounds(skeleton, slot, options.margin ?? 24);
  const tiles = bones.map((bone) => {
    const weights = vertexWeightsOf(mesh, bone);
    const colors = new Uint8Array(weights.length * 4);
    weights.forEach((w, v) => {
      const [r, g, b] = heat(w);
      colors.set([r, g, b, 190], v * 4);
    });
    const image = softRender(skeleton, textures, {
      width: Math.ceil(bounds.width),
      height: Math.ceil(bounds.height),
      left: bounds.x,
      top: bounds.y,
      background: [255, 255, 255],
      slotFilter: (s) => s === slot,
      vertexColors: (s) => (s === slot ? colors : null)
    }).image;
    drawWireframe(image, skeleton, 1, bounds.x, bounds.y, [20, 20, 20, 110], (s) => s === slot);
    drawBones(image, skeleton, 1, bounds.x, bounds.y, bone);
    return { image, label: `${(skeleton.bones[bone] as { data: { name: string } }).data.name}\n${renderTag({ scale: 1, ...SOFT_RENDER })}` };
  });
  return grid(tiles, Math.min(4, tiles.length));
}

/** Every weighted slot with each vertex coloured by the mix of its bones' colours. */
export function weightOverview(
  doc: AnimDocument,
  textures: ReadonlyMap<string, RgbaImage>,
  skins: readonly string[] = ["body"],
  /** Plan: vertices to mark per slot (the ambiguous vertices of `weights.auto`). */
  markers?: ReadonlyMap<string, readonly number[]>
): MutableImage {
  const skeleton = poseSkeleton(doc, skins, null);
  const palette: [number, number, number][] = [
    [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240],
    [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255], [170, 110, 40], [128, 0, 0],
    [170, 255, 195], [128, 128, 0], [255, 215, 180], [0, 0, 128], [128, 128, 128], [255, 255, 255]
  ];
  const colorsFor = (slot: Slot): Uint8Array | null => {
    const mesh = slot.attachment;
    if (!mesh || mesh.type !== "mesh" || !mesh.geometry.weighted) return null;
    const { geometry } = mesh;
    const colors = new Uint8Array(geometry.vertexCount * 4);
    let influence = 0;
    for (let v = 0; v < geometry.vertexCount; v++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const end = influence + (geometry.counts[v] as number);
      for (; influence < end; influence++) {
        const c = palette[(geometry.influenceBones[influence] as number) % palette.length] as [number, number, number];
        const w = geometry.weights[influence] as number;
        r += c[0] * w;
        g += c[1] * w;
        b += c[2] * w;
      }
      colors.set([r, g, b, 170], v * 4);
    }
    return colors;
  };
  const { width, height } = doc.canvas;
  const image = softRender(skeleton, textures, { width, height, background: [255, 255, 255], vertexColors: colorsFor }).image;
  drawWireframe(image, skeleton, 1, 0, 0, [20, 20, 20, 90]);
  drawBones(image, skeleton, 1, 0, 0, -1);
  for (const slot of skeleton.slots) {
    const marked = markers?.get(slot.data.name);
    const mesh = slot.attachment;
    if (!marked || marked.length === 0 || !mesh || mesh.type !== "mesh") continue;
    const world = new Float64Array(2 * mesh.geometry.vertexCount);
    skeleton.computeSlotWorldVertices(slot, world);
    for (const v of marked) {
      const x = Math.round(world[v * 2] as number);
      const y = Math.round(world[v * 2 + 1] as number);
      fillRect(image, x - 3, y - 3, 7, 7, [0, 0, 0]);
      fillRect(image, x - 2, y - 2, 5, 5, [255, 0, 40]);
    }
  }
  fillRect(image, 0, 0, 12 * renderTag({ scale: 1, ...SOFT_RENDER }).length + 12, 26, [40, 40, 48]);
  drawText(image, renderTag({ scale: 1, ...SOFT_RENDER }), 6, 6, 2, [255, 255, 255]);
  return image;
}

function slotBounds(skeleton: Skeleton, slot: Slot, margin: number): Rect {
  // computeSlotWorldVertices writes the whole attachment, also for a draw-group slot (whose
  // slotWorldFloats is its group's share only).
  const attachment = slot.attachment;
  const world = new Float64Array(attachment?.type === "mesh" ? 2 * attachment.geometry.vertexCount : skeleton.slotWorldFloats(slot));
  const count = skeleton.computeSlotWorldVertices(slot, world);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let v = 0; v < count; v++) {
    x0 = Math.min(x0, world[v * 2] as number);
    x1 = Math.max(x1, world[v * 2] as number);
    y0 = Math.min(y0, world[v * 2 + 1] as number);
    y1 = Math.max(y1, world[v * 2 + 1] as number);
  }
  return { x: Math.floor(x0 - margin), y: Math.floor(y0 - margin), width: x1 - x0 + 2 * margin, height: y1 - y0 + 2 * margin };
}

// ---------------------------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------------------------

export function drawLine(image: MutableImage, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let k = 0; k <= steps; k++) {
    const x = Math.floor(x0 + ((x1 - x0) * k) / steps);
    const y = Math.floor(y0 + ((y1 - y0) * k) / steps);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
    blendPixel(image, (y * image.width + x) * 4, color[0], color[1], color[2], color[3]);
  }
}

function drawWireframe(
  image: MutableImage,
  skeleton: Skeleton,
  scale: number,
  left: number,
  top: number,
  color: readonly [number, number, number, number],
  filter?: (slot: Slot) => boolean
): void {
  const scratch = worldScratch();
  let world = new Float64Array(0);
  for (const slot of skeleton.drawOrder) {
    const attachment = slot.attachment;
    if (!attachment || attachment.type !== "mesh" || (filter && !filter(slot))) continue;
    skeleton.computeSlotWorldVertices(slot, (world = scratch(skeleton, slot)));
    const t = attachment.geometry.triangles;
    const at = (v: number) => [((world[v * 2] as number) - left) * scale, ((world[v * 2 + 1] as number) - top) * scale] as const;
    for (let i = 0; i + 2 < t.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const [ax, ay] = at(t[i + k] as number);
        const [bx, by] = at(t[i + ((k + 1) % 3)] as number);
        drawLine(image, ax, ay, bx, by, color);
      }
    }
  }
}

/** Bones as lines with a dot at the start; `highlight` (skeleton index) drawn red, others grey. */
function drawBones(image: MutableImage, skeleton: Skeleton, scale: number, left: number, top: number, highlight: number): void {
  for (const bone of skeleton.bones) {
    if (!bone.active || bone.data.length <= 0) continue;
    const x0 = (bone.world.x - left) * scale;
    const y0 = (bone.world.y - top) * scale;
    const x1 = (bone.world.x + bone.world.a * bone.data.length - left) * scale;
    const y1 = (bone.world.y + bone.world.c * bone.data.length - top) * scale;
    const color: [number, number, number, number] = bone.index === highlight ? [200, 0, 0, 255] : [60, 60, 60, 200];
    for (const offset of [-1, 0, 1]) drawLine(image, x0 + offset, y0, x1 + offset, y1, color);
    fillRect(image, Math.round(x0) - 3, Math.round(y0) - 3, 7, 7, [color[0], color[1], color[2]]);
  }
}

export function fillRect(image: MutableImage, x: number, y: number, width: number, height: number, color: readonly [number, number, number]): void {
  for (let yy = Math.max(0, y); yy < Math.min(image.height, y + height); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(image.width, x + width); xx++) image.data.set([color[0], color[1], color[2], 255], (yy * image.width + xx) * 4);
  }
}

// 5x7 bitmap glyphs, rows top to bottom, '#' = ink.
const GLYPHS: Record<string, string> = {
  A: ".###.#...##...#######...##...##...#", B: "####.#...##...#####.#...##...#####.", C: ".#####....#....#....#....#.....####",
  D: "####.#...##...##...##...##...#####.", E: "######....#....####.#....#....#####", F: "######....#....####.#....#....#....",
  G: ".#####....#....#.####...##...#.###.", H: "#...##...##...#######...##...##...#", I: "#####..#....#....#....#....#..#####",
  J: "..###...#....#....#....##..#..##...", K: "#...##..#.#.#..##...#.#..#..#.#...#", L: "#....#....#....#....#....#....#####",
  M: "#...###.###.#.##.#.##...##...##...#", N: "#...###..##.#.##..###...##...##...#", O: ".###.#...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....", Q: ".###.#...##...##...##.#.##..#..##.#", R: "####.#...##...#####.#.#..#..#.#...#",
  S: ".#####....#.....###.....#....#####.", T: "#####..#....#....#....#....#....#..", U: "#...##...##...##...##...##...#.###.",
  V: "#...##...##...##...##...#.#.#...#..", W: "#...##...##...##.#.##.#.###.###...#", X: "#...##...#.#.#...#...#.#.#...##...#",
  Y: "#...##...#.#.#...#....#....#....#..", Z: "#####....#...#...#...#...#....#####",
  "0": ".###.#...##..###.#.###..##...#.###.", "1": "..#...##....#....#....#....#...###.", "2": ".###.#...#....#...#...#...#...#####",
  "3": "####.....#....#.###.....#....#####.", "4": "...#...##..#.#.#..#.#####...#....#.", "5": "######....####.....#....##...#.###.",
  "6": ".###.#....#....####.#...##...#.###.", "7": "#####....#...#...#...#....#....#...", "8": ".###.#...##...#.###.#...##...#.###.",
  "9": ".###.#...##...#.####....#....#.###.", " ": ".".repeat(35), "-": "...............#####...............",
  "+": ".......#....#..#####..#....#.......", _: "..............................#####", ".": "................................#..",
  ":": ".......#....#..........#....#......", "/": "....#....#...#...#...#...#....#....", "(": "...#...#...#....#....#.....#.....#.",
  ")": ".#.....#.....#....#....#...#...#...", "=": "..........#####.....#####..........", "%": "##..###.#....#...#...#....#.###..##"
};

/** Draws text with the 5x7 font at `size` pixels per font pixel. Unknown characters are blank. */
export function drawText(image: MutableImage, text: string, x: number, y: number, size: number, color: readonly [number, number, number]): void {
  let cursor = x;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "] as string;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) if (glyph[row * 5 + col] === "#") fillRect(image, cursor + col * size, y + row * size, size, size, color);
    }
    cursor += 6 * size;
  }
}
