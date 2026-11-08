/*
 * Atlas Animator: original implementation.
 *
 * Asset commands of the CLI: any sprite, template or mob from PNGs, no hand JSON.
 *
 *   animator atlas import <doc> <png...> [--skin body] [--bone root] [--scale 1] [--padding 2]
 * Packs the PNGs, with every region of the existing atlas kept, into a new,
 * immutable asset bundle beside the document: `<doc stem>.b<V>.N.png` pages and
 *     `<doc stem>.b<V>.atlas.json`, written temp-then-rename and never over an existing file, only
 *     after every option and the batch validate, never on --dry-run. The document commit points at
 *     the bundle (its `atlas.pages` name the versioned pages), so undo and redo return to the
 *     previous bundle; `<doc stem>.atlas.json` is the current-bundle pointer that other readers
 *     use, re-synced from the document after every commit, undo and redo. A failed commit removes
 *     the new bundle (nothing refers to it). Then it edits the document through the command bus: doc.set
 *     atlas, a slot per PNG (slot.add, on --bone) when missing and a region attachment per PNG
 *     (attachment.add, which creates the skin when missing), all one logged, undoable batch.
 *     A PNG the canvas size is a part drawn in place: it is cropped to its opaque pixels and keeps
 *     its place. Any other PNG is cropped the same way and stands on the canvas origin (bottom centre).
 *     --swaps (cut-out swap sets): a PNG named `<slot>__<attachment>.png` becomes attachment
 *     <attachment> of slot <slot> (the slot is created on --bone when missing), so one slot holds a
 *     set of drawings to swap between. A sidecar `<same name>.pivot.json`, {"pivot": [x, y],
 *     "angle": deg}, imports a piece drawn in its own frame: image pixel `pivot` (in the PNG as
 *     given) sits on the slot bone's start and the drawn direction `angle` (canvas degrees, y down)
 *     lies along the bone's setup direction.
 *   animator outline trace <doc> <png> --slot S [--skin body] [--name N] [--target 320 | --spacing P] [--tolerance 2.5] [--components all|largest]
 *     Traces the PNG's opaque outline (tools/outline.ts) and turns the slot's region into a mesh
 *     with that hull (mesh.generate, logged). The PNG is the one imported for the slot: the same
 *     crop rule maps it to the region's image pixels.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { Command } from "../tools/commands.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { packAtlas, type PackItem } from "../tools/atlasPacker.js";
import { alphaMask, cropImage, maskBounds, type PixelRect, type RgbaImage } from "../tools/image.js";
import { outlineComponents } from "../tools/outline.js";
import { encodePng, readPng } from "../tools/png.js";

type Flags = ReadonlyMap<string, string | true>;

const text = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const num = (flags: Flags, name: string): number | undefined => {
  const value = text(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
};

/**
 * `animator atlas trim`: crops a source PNG to its opaque bounds (alpha >= 8, as import measures)
 * plus `pad` transparent pixels each side, so the canvas fits the art (second rig acceptance: the
 * mouse needed an outside crop script).
 */
export function trimPng(input: string, output: string, pad: number): { width: number; height: number; opaque: PixelRect; pad: number } {
  const image = readPng(input);
  const opaque = maskBounds(alphaMask(image, 8));
  if (!opaque) throw new Error(`${input} has no opaque pixels`);
  const margin = Math.max(0, Math.round(pad));
  const width = opaque.width + 2 * margin;
  const height = opaque.height + 2 * margin;
  const out = { width, height, data: new Uint8Array(width * height * 4) };
  const crop = cropImage(image, opaque);
  for (let y = 0; y < opaque.height; y++) out.data.set(crop.data.subarray(y * opaque.width * 4, (y + 1) * opaque.width * 4), ((y + margin) * width + margin) * 4);
  writeFileSync(output, encodePng(out));
  return { width, height, opaque, pad: margin };
}

/**
 * `animator atlas split`: cuts an appendage (a tail) off a PNG along a line, original pixels only
 * (no fill). The part is the opaque region connected to `seed` once the line is blocked; `rest`
 * keeps everything else. The part also gets an `overlap` band on the other side of the line made
 * of its own texels extruded across the cut: hidden when the part draws behind the rest, it fills
 * the seam when the part moves. Both outputs keep the input's size (canvas-size parts).
 * Intended for appendages; whole-creature filled splits stay out.
 */
export function splitPng(input: string, line: [number, number, number, number], seed: [number, number], restOut: string, partOut: string, overlap = 14): { part: number; rest: number; band: number } {
  const image = readPng(input);
  const { width: w, height: h } = image;
  const [ax, ay, bx, by] = line;
  const alpha = (i: number) => image.data[i * 4 + 3] as number;
  const blocked = new Uint8Array(w * h);
  const length = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(length * 2));
  for (let s = 0; s <= steps; s++) {
    const cx = ax + ((bx - ax) * s) / steps;
    const cy = ay + ((by - ay) * s) / steps;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
    }
  }
  const part = new Uint8Array(w * h);
  const start = Math.round(seed[1]) * w + Math.round(seed[0]);
  if (alpha(start) === 0 || blocked[start]) throw new Error(`atlas split: the seed ${seed.join(",")} is not an opaque pixel of the part`);
  const stack = [start];
  part[start] = 1;
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    for (const [qx, qy] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const j = qy * w + qx;
      if (part[j] || blocked[j] || alpha(j) === 0) continue;
      part[j] = 1;
      stack.push(j);
    }
  }
  for (let i = 0; i < w * h; i++) if (blocked[i] && alpha(i) > 0) part[i] = 1;
  let nx = (by - ay) / length;
  let ny = -(bx - ax) / length;
  if ((seed[0] - ax) * nx + (seed[1] - ay) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const rest = { width: w, height: h, data: new Uint8Array(image.data) };
  const cut = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  let partCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (!part[i]) continue;
    partCount++;
    rest.data.fill(0, i * 4, i * 4 + 4);
    cut.data.set(image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  let band = 0;
  const yFrom = Math.max(0, Math.floor(Math.min(ay, by) - 4));
  const yTo = Math.min(h, Math.ceil(Math.max(ay, by) + 4));
  const xFrom = Math.max(0, Math.floor(Math.min(ax, bx) - overlap - 4));
  const xTo = Math.min(w, Math.ceil(Math.max(ax, bx) + overlap + 4));
  for (let y = yFrom; y < yTo; y++) for (let x = xFrom; x < xTo; x++) {
    const i = y * w + x;
    const side = (x - ax) * nx + (y - ay) * ny;
    if (part[i] || alpha(i) === 0 || side > 0 || side <= -overlap) continue;
    const d = -side + 2;
    const qx = Math.round(x + d * nx);
    const qy = Math.round(y + d * ny);
    if (qx < 0 || qy < 0 || qx >= w || qy >= h || !part[qy * w + qx]) continue;
    cut.data.set(image.data.subarray((qy * w + qx) * 4, (qy * w + qx) * 4 + 4), i * 4);
    band++;
  }
  writeFileSync(restOut, encodePng(rest));
  writeFileSync(partOut, encodePng(cut));
  let restCount = 0;
  for (let i = 0; i < w * h; i++) if ((rest.data[i * 4 + 3] as number) > 0) restCount++;
  return { part: partCount, rest: restCount, band };
}

/** Slot / attachment name of a PNG: its file stem, made a valid name. */
export function partName(file: string): string {
  return basename(file).replace(/\.png$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Where a PNG's part sits on the canvas and which pixels of the PNG it is (see the file comment). */
export function partPlacement(image: RgbaImage, canvas: { width: number; height: number; originX: number; originY: number }): { source: PixelRect; canvas: PixelRect } {
  if (image.width === canvas.width && image.height === canvas.height) {
    const bounds = maskBounds(alphaMask(image, 8));
    if (!bounds) throw new Error("the PNG has no opaque pixels");
    return { source: bounds, canvas: bounds };
  }
  const source = maskBounds(alphaMask(image, 8));
  if (!source) throw new Error("the PNG has no opaque pixels");
  return { source, canvas: { x: Math.round(canvas.originX - source.width / 2), y: Math.round(canvas.originY - source.height), width: source.width, height: source.height } };
}

function setupSkeleton(raw: unknown): Skeleton {
  const doc = loadAnimDocument(raw);
  const skeleton = new Skeleton(doc);
  skeleton.x = doc.canvas.originX;
  skeleton.y = doc.canvas.originY;
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("pose");
  return skeleton;
}

export interface AssetPlan {
  commands: Command[];
  /**
   * Asset files (atlas pages and manifest) the plan needs written. Planning never writes
   *: the CLI validates the commands first, writes nothing on --dry-run, and writes
   * these only once the batch is known to apply.
   */
  files: { path: string; bytes: Uint8Array }[];
  /** Diagnostics for the operator (kept regions, traced components). */
  notes: string[];
}

/** Writes `bytes` to `path` through a temp file and a rename (a reader never sees a torn file). */
function writeAtomic(path: string, bytes: Uint8Array | string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

/**
 * Writes a plan's bundle files (after every option and the batch validated), temp-then-rename,
 * never over an existing file (a bundle is immutable); returns the paths written. The pointer
 * manifest is not written here: `syncAtlasPointer` writes it after the document commit.
 */
export function writePlanFiles(plan: AssetPlan): string[] {
  const written: string[] = [];
  try {
    for (const file of plan.files) {
      if (existsSync(file.path)) throw new Error(`${file.path} already exists: an asset bundle is never overwritten`);
      writeAtomic(file.path, file.bytes);
      written.push(file.path);
    }
  } catch (error) {
    removePlanFiles(written);
    throw error;
  }
  return written;
}

/** Removes bundle files a failed commit left unreferenced. */
export function removePlanFiles(paths: readonly string[]): void {
  for (const path of paths) rmSync(path, { force: true });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const docStem = (docPath: string) => basename(docPath).replace(/\.anim\.json$|\.json$/i, "");

/** The bundle version a document's atlas pages name (`<stem>.b<V>.N.png`), 0 for unversioned pages, null without an atlas. */
export function bundleVersionOf(docPath: string, rawDoc: Record<string, unknown>): number | null {
  const atlas = rawDoc["atlas"] as { pages?: string[] } | null | undefined;
  const first = atlas?.pages?.[0];
  if (!first) return null;
  const match = new RegExp(`^${escapeRegExp(docStem(docPath))}\\.b(\\d+)\\.`).exec(first);
  return match ? Number(match[1]) : 0;
}

/** The manifest of a bundle version (`<stem>.b<V>.atlas.json`). */
export const bundleManifestPath = (docPath: string, version: number) => join(dirname(docPath), `${docStem(docPath)}.b${version}.atlas.json`);

/** The current-bundle pointer manifest other readers use (`<stem>.atlas.json`). */
export const pointerManifestPath = (docPath: string) => join(dirname(docPath), `${docStem(docPath)}.atlas.json`);

/** The next free bundle version beside the document. */
function nextBundleVersion(docPath: string): number {
  const pattern = new RegExp(`^${escapeRegExp(docStem(docPath))}\\.b(\\d+)\\.`);
  let max = 0;
  for (const name of readdirSync(dirname(docPath))) {
    const match = pattern.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Makes the pointer manifest match the document's committed bundle: after an import
 * commit, an undo or a redo. A document without an atlas has no pointer (the bundles stay). An
 * unversioned atlas uses its snapshot `b0` when one was taken. Returns what it did, or null.
 */
export function syncAtlasPointer(docPath: string): string | null {
  const rawDoc = JSON.parse(readFileSync(docPath, "utf8")) as Record<string, unknown>;
  const version = bundleVersionOf(docPath, rawDoc);
  const pointer = pointerManifestPath(docPath);
  if (version === null) {
    const hasBundles = readdirSync(dirname(docPath)).some((name) => new RegExp(`^${escapeRegExp(docStem(docPath))}\\.b\\d+\\.atlas\\.json$`).test(name));
    if (existsSync(pointer) && hasBundles) {
      rmSync(pointer, { force: true });
      return `removed ${pointer} (the document has no atlas)`;
    }
    return null;
  }
  const source = bundleManifestPath(docPath, version);
  if (!existsSync(source)) return null;
  const bytes = readFileSync(source);
  if (existsSync(pointer) && readFileSync(pointer).equals(bytes)) return null;
  writeAtomic(pointer, bytes);
  return `${pointer} -> bundle b${version}`;
}

/**
 * Plans an atlas import (see the file comment). Incremental: when the document already has an
 * atlas, its manifest and pages are read and every region not being replaced is repacked beside
 * the new parts, so existing attachments keep their textures; an atlas whose manifest or pages are
 * missing, or whose scale differs from --scale, is rejected rather than overwritten. A PNG whose
 * slot already exists is placed in that slot's bone frame; an explicit --bone naming another bone
 * is rejected.
 */
export function atlasImport(docPath: string, rawDoc: Record<string, unknown>, pngs: readonly string[], flags: Flags): AssetPlan {
  if (pngs.length === 0) throw new Error("usage: animator atlas import <doc> <png...> [--skin body] [--bone root] [--scale 1] [--swaps]");
  const skin = text(flags, "skin") ?? "body";
  const explicitBone = text(flags, "bone");
  const scale = num(flags, "scale") ?? 1;
  const padding = num(flags, "padding") ?? 2;
  const canvas = rawDoc["canvas"] as { width: number; height: number; originX: number; originY: number };
  const skeleton = setupSkeleton(rawDoc);
  const slotBones = new Map(((rawDoc["slots"] as { name: string; bone: string }[] | undefined) ?? []).map((s) => [s.name, s.bone]));
  const swaps = flags.has("swaps");
  const parts = pngs.map((file) => {
    const image = readPng(file);
    const stemName = partName(file);
    const split = swaps ? stemName.indexOf("__") : -1;
    if (swaps && split <= 0) throw new Error(`--swaps: '${basename(file)}' is not named <slot>__<attachment>.png`);
    const name = split > 0 ? stemName.slice(0, split) : stemName;
    const attachment = split > 0 ? stemName.slice(split + 2) : stemName;
    const sidecar = file.replace(/\.png$/i, ".pivot.json");
    const pivot = existsSync(sidecar) ? (JSON.parse(readFileSync(sidecar, "utf8")) as { pivot: [number, number]; angle: number }) : null;
    if (pivot && !(Array.isArray(pivot.pivot) && pivot.pivot.length === 2 && pivot.pivot.every(Number.isFinite) && Number.isFinite(pivot.angle))) {
      throw new Error(`${sidecar}: needs {"pivot": [x, y], "angle": deg}`);
    }
    const existing = slotBones.get(name);
    if (existing !== undefined && explicitBone !== undefined && existing !== explicitBone) {
      throw new Error(`slot '${name}' exists on bone '${existing}', not --bone '${explicitBone}': move the slot first or drop --bone`);
    }
    const bone = existing ?? explicitBone ?? "root";
    const frame = skeleton.findBone(bone);
    if (!frame) throw new Error(`no bone '${bone}'`);
    return { name, attachment, pivot, image, place: partPlacement(image, canvas), path: `${skin}/${stemName}`, bone, frame, isNew: existing === undefined };
  });
  const names = parts.map((p) => `${p.name}/${p.attachment}`);
  if (new Set(names).size !== names.length) throw new Error(`two PNGs give the same part name: ${names.join(", ")}`);
  const newSlots = new Set<string>();
  const stem = docStem(docPath);
  const dir = dirname(docPath);
  // Plan: the kept regions come from the document's own committed bundle (the pointer only
  // for an unversioned atlas); the import writes a new bundle version.
  const currentVersion = bundleVersionOf(docPath, rawDoc);
  const manifestPath = currentVersion !== null && currentVersion > 0 ? bundleManifestPath(docPath, currentVersion) : pointerManifestPath(docPath);
  const version = nextBundleVersion(docPath);
  const notes: string[] = [];

  // Existing atlas: every region not being replaced, cropped from its page at page scale.
  const docAtlas = rawDoc["atlas"] as { pages: string[]; scale: number } | null | undefined;
  const replacing = new Set(parts.map((p) => p.path));
  const kept: PackItem[] = [];
  if (docAtlas || existsSync(manifestPath)) {
    if (!existsSync(manifestPath)) throw new Error(`the document has an atlas but its manifest ${manifestPath} is missing: an import would drop every existing region; restore it or import into a fresh document`);
    const manifest = atlasPackSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (Math.abs(manifest.scale - scale) > 1e-9) throw new Error(`the existing atlas is at scale ${manifest.scale}, not --scale ${scale}: an incremental import keeps one scale (pass --scale ${manifest.scale})`);
    for (const page of manifest.pages) {
      const pagePath = join(dir, page.file);
      if (!existsSync(pagePath)) throw new Error(`atlas page ${pagePath} is missing: an import would drop its regions`);
      const pixels = readPng(pagePath);
      for (const [path, region] of Object.entries(page.regions)) if (!replacing.has(path)) kept.push({ path, image: cropImage(pixels, region) });
    }
    notes.push(`atlas: kept ${kept.length} existing region(s), importing ${parts.length}`);
  }
  // New parts at atlas scale (the packer resamples once), then everything packed as is.
  const scaledParts: PackItem[] = parts.map((part) => {
    const one = packAtlas([{ path: part.path, image: part.image, rect: part.place.source }], { name: "import", scale, padding: 0 });
    const page = one.pages[0];
    const rect = one.pack.pages[0]?.regions[part.path];
    if (!page || !rect) throw new Error(`import: the packer produced no region for ${part.path}`);
    return { path: part.path, image: cropImage(page.image, rect) };
  });
  const packed = packAtlas([...kept, ...scaledParts], { name: `${stem}.b${version}`, scale: 1, padding });
  const pack = { ...packed.pack, scale };
  const files = packed.pages.map((page) => ({ path: join(dir, page.file), bytes: encodePng(page.image) as Uint8Array }));
  files.push({ path: bundleManifestPath(docPath, version), bytes: new TextEncoder().encode(`${JSON.stringify(pack, null, 1)}\n`) });
  // An unversioned atlas being replaced is snapshotted as bundle b0, so undo can return to it.
  if (currentVersion === 0 && existsSync(manifestPath) && !existsSync(bundleManifestPath(docPath, 0))) files.push({ path: bundleManifestPath(docPath, 0), bytes: readFileSync(manifestPath) });
  const commands: Command[] = [{ op: "doc.set", atlas: { pages: packed.pages.map((page) => page.file), scale } }];
  for (const part of parts) {
    if (part.isNew && !newSlots.has(part.name)) {
      commands.push({ op: "slot.add", name: part.name, bone: part.bone, attachment: part.attachment });
      newSlots.add(part.name);
    }
    let centre = { x: part.place.canvas.x + part.place.canvas.width / 2, y: part.place.canvas.y + part.place.canvas.height / 2 };
    let rotation = -part.frame.worldRotationX;
    if (part.pivot) {
      // drawn in its own frame: the pivot pixel on the bone's start, the drawn direction along the bone
      const turn = part.frame.worldRotationX - part.pivot.angle;
      const r = (turn * Math.PI) / 180;
      const src = part.place.source;
      const dx = src.x + src.width / 2 - part.pivot.pivot[0];
      const dy = src.y + src.height / 2 - part.pivot.pivot[1];
      centre = { x: part.frame.world.x + dx * Math.cos(r) - dy * Math.sin(r), y: part.frame.world.y + dx * Math.sin(r) + dy * Math.cos(r) };
      rotation = turn - part.frame.worldRotationX;
      rotation = ((((rotation + 180) % 360) + 360) % 360) - 180;
    }
    const local = { x: 0, y: 0 };
    part.frame.worldToLocal(centre.x, centre.y, local);
    commands.push({
      op: "attachment.add",
      skin,
      slot: part.name,
      name: part.attachment,
      attachment: { type: "region", path: part.path, x: round(local.x), y: round(local.y), ...(Math.abs(rotation) > 1e-9 ? { rotation: round(rotation) } : {}), width: part.place.canvas.width, height: part.place.canvas.height }
    });
  }
  return { commands, files, notes };
}

export function outlineTrace(rawDoc: Record<string, unknown>, png: string | undefined, flags: Flags): AssetPlan {
  const slot = text(flags, "slot");
  if (!png || !slot) throw new Error("usage: animator outline trace <doc> <png> --slot S [--skin body] [--name N] [--target 320 | --spacing P] [--tolerance 2.5]");
  const skin = text(flags, "skin") ?? "body";
  const name = text(flags, "name") ?? slot;
  const canvas = rawDoc["canvas"] as { width: number; height: number; originX: number; originY: number };
  const attachment = ((rawDoc["skins"] as Record<string, { attachments?: Record<string, Record<string, Record<string, unknown>>> }> | undefined)?.[skin]?.attachments?.[slot]?.[name]) as Record<string, unknown> | undefined;
  if (!attachment) throw new Error(`no attachment ${skin}/${slot}/${name}; import the PNG first (animator atlas import)`);
  const image = readPng(png);
  const { source } = partPlacement(image, canvas);
  if (source.width !== attachment["width"] || source.height !== attachment["height"]) {
    throw new Error(`the PNG's part is ${source.width}x${source.height} but ${skin}/${slot}/${name} is ${String(attachment["width"])}x${String(attachment["height"])}: trace the PNG it was imported from`);
  }
  // Plan: disconnected artwork is never dropped silently. --components all (default): each
  // component is its own hull, the largest on this attachment and every other one on a new slot
  // `<slot>_partN` (same bone, same texture region, its own mesh); --components largest keeps
  // only the largest. Either way the notes list every component (and specks under 16 px).
  const policy = text(flags, "components") ?? "all";
  if (policy !== "all" && policy !== "largest") throw new Error(`--components must be all or largest, not '${policy}'`);
  const { components, dropped } = outlineComponents(image, { padding: 2, tolerance: num(flags, "tolerance") ?? 2.5 });
  // The padded outline can run past the imported region (the part's opaque crop); mesh.generate
  // clamps UVs to the region, so a vertex outside it would stretch the edge texels outward. Clamp
  // the outline to the region and drop the repeats that clamping creates.
  const toImage = (p: { x: number; y: number }): [number, number] => [round(Math.min(source.width, Math.max(0, p.x - source.x))), round(Math.min(source.height, Math.max(0, p.y - source.y)))];
  const ring = (poly: { x: number; y: number }[]) => poly.map(toImage).filter((q, i, all) => { const r = all[(i + all.length - 1) % all.length] as [number, number]; return q[0] !== r[0] || q[1] !== r[1]; });
  const target = num(flags, "target") ?? 320;
  const spacing = num(flags, "spacing");
  const total = components.reduce((sum, c) => sum + c.pixels, 0);
  const describe = (c: { pixels: number; bounds: { x: number; y: number; width: number; height: number } }, k: number) => `#${k + 1} ${c.pixels} px at (${c.bounds.x}, ${c.bounds.y}) ${c.bounds.width}x${c.bounds.height}`;
  const notes = [`outline ${skin}/${slot}/${name}: ${components.length} component${components.length === 1 ? "" : "s"}: ${components.map(describe).join("; ")}`];
  if (dropped.length > 0) notes.push(`outline: dropped ${dropped.length} speck(s) under 16 px: ${dropped.map((d, k) => describe(d, k)).join("; ")}`);
  const kept = policy === "largest" ? components.slice(0, 1) : components;
  if (policy === "largest" && components.length > 1) notes.push(`outline: --components largest dropped ${components.length - 1} component(s): ${components.slice(1).map((c, k) => describe(c, k + 1)).join("; ")}`);
  if (kept.length > 1 && attachment["type"] !== "region") throw new Error(`${skin}/${slot}/${name} is a ${String(attachment["type"])}, not a region: tracing ${kept.length} components needs the imported region (re-import it), or pass --components largest`);
  const slotBone = ((rawDoc["slots"] as { name: string; bone: string }[] | undefined) ?? []).find((s) => s.name === slot)?.bone;
  const commands: Command[] = [];
  kept.forEach((outline, k) => {
    const targetSlot = k === 0 ? slot : `${slot}_part${k + 1}`;
    const targetName = k === 0 ? name : targetSlot;
    if (k > 0) {
      commands.push({ op: "slot.add", name: targetSlot, bone: slotBone ?? "root", attachment: targetName });
      commands.push({ op: "attachment.add", skin, slot: targetSlot, name: targetName, attachment: { ...attachment } });
    }
    commands.push({
      op: "mesh.generate",
      skin,
      slot: targetSlot,
      name: targetName,
      outline: { outer: ring(outline.outer), ...(outline.holes.length > 0 ? { holes: outline.holes.map(ring) } : {}) },
      ...(spacing !== undefined ? { spacing } : { targetVertices: kept.length === 1 ? target : Math.min(400, Math.max(8, Math.round((target * outline.pixels) / total))) })
    });
  });
  return { commands, files: [], notes };
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;

export function readDoc(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
