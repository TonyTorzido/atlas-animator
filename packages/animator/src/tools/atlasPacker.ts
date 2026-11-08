/*
 * Atlas Animator: original implementation.
 *
 * Offline atlas packer (plan 3, Tools): part images are box-downscaled to the page scale (0.5 of
 * the canvas by default) and shelf-packed onto pages of at most 2048 x 2048, tallest first. The
 * result is the page images plus their `atlas-pack@1` sidecar (core/atlasPack.ts), which the
 * runtime's dynamic atlas copies regions out of.
 *
 * Decision (left open by Phase 1): the rig document's `atlas.pages` keeps listing the page PNGs
 * and `atlas.scale`; the sidecar sits next to the document as `<name>.atlas.json`.
 */
import { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
import { resampleToPremultiplied, unpremultiply } from "../pixi/imageOps.js";
import { createImage, type MutableImage, type PixelRect, type RgbaImage } from "./image.js";

export interface PackItem {
  /** Texture path the attachments use (e.g. "body/torso"). */
  path: string;
  image: RgbaImage;
  /** Part of `image` to pack (default: all of it). */
  rect?: PixelRect;
}

export interface PackOptions {
  /** Base name of the page files: `<name>.<index>.png`. */
  name: string;
  /** Page pixels per canvas pixel (default 0.5). */
  scale?: number;
  /** Largest page side (default 2048). */
  pageSize?: number;
  /** Transparent pixels between regions and around the page edge (default 2). */
  padding?: number;
}

export interface PackedAtlas {
  pack: AtlasPack;
  pages: { file: string; image: MutableImage }[];
}

interface Placed {
  path: string;
  pixels: RgbaImage;
  page: number;
  x: number;
  y: number;
}

export function packAtlas(items: readonly PackItem[], options: PackOptions): PackedAtlas {
  const scale = options.scale ?? 0.5;
  const pageSize = options.pageSize ?? 2048;
  const padding = options.padding ?? 2;
  const seen = new Set<string>();
  const scaled = items.map((item) => {
    if (seen.has(item.path)) throw new Error(`atlas packer: texture path '${item.path}' is listed twice`);
    seen.add(item.path);
    const rect = item.rect ?? { x: 0, y: 0, width: item.image.width, height: item.image.height };
    const pixels = scale === 1 ? cropStraight(item.image, rect) : unpremultiply(resampleToPremultiplied(item.image, rect, scale));
    if (pixels.width + 2 * padding > pageSize || pixels.height + 2 * padding > pageSize) {
      throw new Error(`atlas packer: '${item.path}' is ${pixels.width}x${pixels.height} at scale ${scale}, larger than a ${pageSize} page`);
    }
    return { path: item.path, pixels };
  });

  // Tallest first, then widest, then by path (deterministic output).
  const order = scaled
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => b.pixels.height - a.pixels.height || b.pixels.width - a.pixels.width || (a.path < b.path ? -1 : 1));

  const placed: Placed[] = [];
  const pageExtents: { width: number; height: number }[] = [];
  let page = -1;
  let shelfY = 0;
  let shelfHeight = 0;
  let cursorX = 0;
  const newPage = () => {
    page += 1;
    pageExtents.push({ width: 0, height: 0 });
    shelfY = padding;
    shelfHeight = 0;
    cursorX = padding;
  };
  newPage();
  for (const entry of order) {
    const { width, height } = entry.pixels;
    if (cursorX + width + padding > pageSize) {
      shelfY += shelfHeight + padding;
      shelfHeight = 0;
      cursorX = padding;
    }
    if (shelfY + height + padding > pageSize) newPage();
    placed.push({ path: entry.path, pixels: entry.pixels, page, x: cursorX, y: shelfY });
    cursorX += width + padding;
    shelfHeight = Math.max(shelfHeight, height);
    const extent = pageExtents[page] as { width: number; height: number };
    extent.width = Math.max(extent.width, cursorX);
    extent.height = Math.max(extent.height, shelfY + height + padding);
  }

  // Pages are trimmed to their content, rounded up to a multiple of 4.
  const round4 = (value: number) => Math.min(pageSize, Math.ceil(value / 4) * 4);
  const pages = pageExtents.map((extent, i) => ({
    file: `${options.name}.${i}.png`,
    image: createImage(round4(extent.width), round4(extent.height))
  }));
  const regions: Record<string, { x: number; y: number; width: number; height: number }>[] = pages.map(() => ({}));
  for (const item of placed) {
    const target = (pages[item.page] as { image: MutableImage }).image;
    copyInto(target, item.pixels, item.x, item.y);
    (regions[item.page] as Record<string, { x: number; y: number; width: number; height: number }>)[item.path] = {
      x: item.x,
      y: item.y,
      width: item.pixels.width,
      height: item.pixels.height
    };
  }
  const pack = atlasPackSchema.parse({
    format: "atlas-pack@1",
    scale,
    pages: pages.map((p, i) => ({ file: p.file, width: p.image.width, height: p.image.height, regions: regions[i] }))
  });
  return { pack, pages };
}

function cropStraight(image: RgbaImage, rect: PixelRect): MutableImage {
  const out = createImage(rect.width, rect.height);
  copyRect(image, rect, out, 0, 0);
  return out;
}

function copyInto(target: MutableImage, source: RgbaImage, x: number, y: number): void {
  copyRect(source, { x: 0, y: 0, width: source.width, height: source.height }, target, x, y);
}

function copyRect(source: RgbaImage, rect: PixelRect, target: MutableImage, x: number, y: number): void {
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * source.width + rect.x) * 4;
    target.data.set(source.data.subarray(from, from + rect.width * 4), ((y + row) * target.width + x) * 4);
  }
}
