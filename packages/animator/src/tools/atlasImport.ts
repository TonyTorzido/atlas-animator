/*
 * Atlas Animator: original implementation.
 *
 * From-canvas import (plan Phase 6, skins panel): a part drawn on the template canvas (a PNG the
 * size of the canvas with the part in place) is cropped to its opaque pixels and packed into the
 * rig's atlas next to the regions already there. The caller then adds the attachment with a
 * command (`attachment.add`), placed from the returned canvas rectangle, so the document edit is
 * logged and undoable like every other edit; the atlas pages are assets, not document state.
 */
import type { AtlasPack } from "../core/atlasPack.js";
import { packAtlas, type PackItem } from "./atlasPacker.js";
import { alphaMask, cropImage, maskBounds, type PixelRect } from "./image.js";
import { decodePng, encodePng } from "./png.js";

export interface CanvasPartImport {
  /** Rig name: page files are `<name>.<index>.png`. */
  name: string;
  /** The rig's current atlas manifest (null: the rig has no atlas yet). */
  manifest: AtlasPack | null;
  /** Page file -> PNG bytes for every page of `manifest`. */
  pages: ReadonlyMap<string, Uint8Array>;
  /** Texture path of the new (or replaced) region, e.g. `body/cape`. */
  region: string;
  /** The part on the canvas, PNG bytes. */
  png: Uint8Array;
  /** When given, the PNG must be exactly this size (so the part keeps its place). */
  canvas?: { width: number; height: number };
  /** Page pixels per canvas pixel. */
  scale: number;
  pageSize?: number;
}

export interface CanvasPartResult {
  manifest: AtlasPack;
  pages: { file: string; png: Buffer }[];
  /** Where the part sits on the canvas (canvas pixels, even-aligned). */
  rect: PixelRect;
}

export function importCanvasPart(input: CanvasPartImport): CanvasPartResult {
  const image = decodePng(input.png);
  if (input.canvas && (image.width !== input.canvas.width || image.height !== input.canvas.height)) {
    throw new Error(`the part PNG is ${image.width}x${image.height}; it must be the canvas size ${input.canvas.width}x${input.canvas.height} so the part keeps its place`);
  }
  const bounds = maskBounds(alphaMask(image, 8));
  if (!bounds) throw new Error("the part PNG has no opaque pixels");
  // Even canvas pixels, so a 0.5 atlas maps whole page pixels exactly (as the rig tool does).
  const x = Math.floor(bounds.x / 2) * 2;
  const y = Math.floor(bounds.y / 2) * 2;
  const rect = {
    x,
    y,
    width: Math.min(Math.ceil((bounds.x + bounds.width) / 2) * 2, image.width - (image.width % 2)) - x,
    height: Math.min(Math.ceil((bounds.y + bounds.height) / 2) * 2, image.height - (image.height % 2)) - y
  };
  if (rect.width <= 0 || rect.height <= 0) throw new Error("the part is too small to import");
  // The new part at atlas scale (the packer resamples), then every region already packed as is.
  const scaled = packAtlas([{ path: input.region, image, rect }], { name: "import", scale: input.scale, padding: 0, ...(input.pageSize ? { pageSize: input.pageSize } : {}) });
  const scaledPage = scaled.pages[0];
  const scaledRect = scaled.pack.pages[0]?.regions[input.region];
  if (!scaledPage || !scaledRect) throw new Error("import: the packer produced no region");
  const items: PackItem[] = [];
  for (const page of input.manifest?.pages ?? []) {
    const bytes = input.pages.get(page.file);
    if (!bytes) throw new Error(`import: atlas page ${page.file} is missing`);
    const pixels = decodePng(bytes);
    for (const [path, region] of Object.entries(page.regions)) {
      if (path === input.region) continue;
      items.push({ path, image: cropImage(pixels, region) });
    }
  }
  items.push({ path: input.region, image: cropImage(scaledPage.image, scaledRect) });
  const packed = packAtlas(items, { name: input.name, scale: 1, ...(input.pageSize ? { pageSize: input.pageSize } : {}) });
  const manifest: AtlasPack = { ...packed.pack, scale: input.scale };
  return { manifest, pages: packed.pages.map((page) => ({ file: page.file, png: encodePng(page.image) })), rect };
}
export { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
export { decodePng, encodePng } from "./png.js";
