/*
 * Atlas Animator: original implementation.
 *
 * Browser image loading for the Pixi adapter: fetch PNGs, decode them to straight-alpha RGBA
 * bytes, and build part-image providers. Browser only (fetch, createImageBitmap, OffscreenCanvas).
 */
import { atlasPackSchema } from "../core/atlasPack.js";
import type { RgbaImage } from "./imageOps.js";
import { packedAtlasImages, type PartImageProvider } from "./partImages.js";

/** Fetches and decodes an image into straight-alpha RGBA bytes (no colour-space conversion). */
export async function loadRgbaImage(url: string): Promise<RgbaImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load ${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none"
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is not available");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}

/** Loads an `atlas-pack@1` manifest and its pages (page files resolve relative to the manifest). */
export async function loadPackedAtlas(manifestUrl: string): Promise<PartImageProvider> {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`failed to load ${manifestUrl}: ${response.status}`);
  const pack = atlasPackSchema.parse(await response.json());
  const base = new URL(manifestUrl, globalThis.location?.href);
  const pages = new Map<string, RgbaImage>();
  await Promise.all(
    pack.pages.map(async (page) => {
      pages.set(page.file, await loadRgbaImage(new URL(page.file, base).href));
    })
  );
  return packedAtlasImages(pack, pages);
}
