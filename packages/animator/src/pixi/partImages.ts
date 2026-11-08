/*
 * Atlas Animator: original implementation.
 *
 * Where the dynamic atlas gets part images from. A PartImageProvider answers "the decoded image
 * for texture path P"; providers are built from prepacked pages (`atlas-pack@1`) or from
 * individual part images. Decoding is the caller's business (browserImages.ts in the browser,
 * pngjs in Node), so this module stays pure.
 */
import { atlasPackSchema, type AtlasPack } from "../core/atlasPack.js";
import type { SourceImage } from "./dynamicAtlas.js";
import type { RgbaImage } from "./imageOps.js";

export interface PartImageProvider {
  /** The image for a texture path, or undefined when this provider does not have it. */
  get(path: string): SourceImage | undefined;
}

/** Images on prepacked pages: `pages` maps each page file name to its decoded pixels. */
export function packedAtlasImages(pack: AtlasPack, pages: ReadonlyMap<string, RgbaImage>): PartImageProvider {
  const parsed = atlasPackSchema.parse(pack);
  const byPath = new Map<string, SourceImage>();
  for (const page of parsed.pages) {
    const pixels = pages.get(page.file);
    if (!pixels) throw new Error(`atlas page '${page.file}' was not provided`);
    if (pixels.width !== page.width || pixels.height !== page.height) {
      throw new Error(`atlas page '${page.file}' is ${pixels.width}x${pixels.height}, the pack says ${page.width}x${page.height}`);
    }
    for (const [path, rect] of Object.entries(page.regions)) byPath.set(path, { pixels, rect, pixelScale: parsed.scale });
  }
  return { get: (path) => byPath.get(path) };
}

/** Individual images per texture path, each a whole decoded image at `pixelScale`. */
export function separateImages(images: ReadonlyMap<string, RgbaImage>, pixelScale = 1): PartImageProvider {
  return {
    get(path) {
      const pixels = images.get(path);
      return pixels ? { pixels, rect: { x: 0, y: 0, width: pixels.width, height: pixels.height }, pixelScale } : undefined;
    }
  };
}

/** Tries providers in order (e.g. a swag item's own images, then the body pack). */
export function chainImages(...providers: readonly PartImageProvider[]): PartImageProvider {
  return {
    get(path) {
      for (const provider of providers) {
        const image = provider.get(path);
        if (image) return image;
      }
      return undefined;
    }
  };
}
