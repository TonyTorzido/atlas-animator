/*
 * Atlas Animator: original implementation.
 *
 * DynamicAtlas: display-resolution texture pages filled on demand (plan 4.7).
 *
 * Characters acquire the images their outfit needs by texture path; the atlas box-downscales each
 * image to the display scale (0.5 of canvas by default), packs it onto a 2048 x 2048 page with a
 * shelf allocator and hands back the region. Every character drawing from the same pages batches
 * into the same draw calls. Released images stay resident (a cache hit when the next character
 * wears the same item) until space is needed: then the least recently released unreferenced
 * images are evicted. Pages beyond `budgetPages` are opened only when nothing can be evicted, and
 * are counted in stats so the perf page can see the budget being exceeded; `maxPages` is the hard
 * limit.
 *
 * Pages are premultiplied RGBA byte buffers uploaded through Pixi's buffer texture source; there
 * is no canvas, so the atlas also runs in Node tests. Uploads are coalesced: acquire only marks a
 * page dirty, and flush() uploads each dirty page once (Pixi uploads a buffer source in full on
 * every update, so per-acquire updates would re-upload 16 MB per new image). AnimatorCharacter
 * flushes before it draws; flushBeforeRender() also hooks the renderer's prerender step.
 */
import { BufferImageSource, Texture, type Renderer } from "pixi.js";
import { resampleToPremultiplied, type Rect, type RgbaImage } from "./imageOps.js";
import { ShelfAllocator, type ShelfAllocation } from "./shelfAllocator.js";

/** One image to pack: a rectangle of a decoded (straight-alpha) image. */
export interface SourceImage {
  readonly pixels: RgbaImage;
  /** The image's rectangle within `pixels` (whole pixels). */
  readonly rect: Rect;
  /** Source pixels per canvas pixel (1 for canvas-resolution parts, the pack's scale for packed pages). */
  readonly pixelScale: number;
}

export interface AtlasPage {
  readonly index: number;
  readonly texture: Texture;
  readonly size: number;
}

/**
 * Where an image landed. The image's [0, 1] x [0, 1] UV square maps to
 * [u0, u1] x [v0, v1] on `page`.
 */
export interface AtlasRegion {
  readonly key: string;
  readonly page: AtlasPage;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface DynamicAtlasOptions {
  /** Page edge in pixels (default 2048). */
  pageSize?: number;
  /** Page pixels per canvas pixel (default 0.5). Images are never upscaled. */
  scale?: number;
  /** Transparent gutter around each image, in page pixels (default 2), so filtering never bleeds. */
  padding?: number;
  /** Pages to fill before evicting released images (default 3). */
  budgetPages?: number;
  /** Hard page limit (default 16, Pixi's multi-texture batch size). */
  maxPages?: number;
}

export interface DynamicAtlasStats {
  readonly pages: number;
  readonly residentImages: number;
  readonly referencedImages: number;
  readonly evictions: number;
  /** Pages open beyond the budget. */
  readonly pagesOverBudget: number;
}

interface Entry {
  readonly region: AtlasRegion;
  readonly allocation: ShelfAllocation;
  readonly pageIndex: number;
  references: number;
  /** Release tick; smaller = released longer ago. */
  releasedAt: number;
}

interface Page extends AtlasPage {
  readonly allocator: ShelfAllocator;
  readonly data: Uint8Array;
  readonly source: BufferImageSource;
  dirty: boolean;
}

export class DynamicAtlas {
  readonly pageSize: number;
  readonly scale: number;
  readonly padding: number;
  readonly budgetPages: number;
  readonly maxPages: number;
  private readonly pageList: Page[] = [];
  private readonly entries = new Map<string, Entry>();
  private tick = 0;
  private evictions = 0;

  constructor(options: DynamicAtlasOptions = {}) {
    this.pageSize = options.pageSize ?? 2048;
    this.scale = options.scale ?? 0.5;
    this.padding = options.padding ?? 2;
    this.budgetPages = options.budgetPages ?? 3;
    this.maxPages = options.maxPages ?? 16;
    if (!(this.scale > 0 && this.scale <= 1)) throw new RangeError(`scale must be in (0, 1], got ${this.scale}`);
    if (this.budgetPages < 1 || this.maxPages < this.budgetPages) throw new RangeError("need 1 <= budgetPages <= maxPages");
  }

  get pages(): readonly AtlasPage[] {
    return this.pageList;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** References currently held on `key` (0 when released or not resident). */
  references(key: string): number {
    return this.entries.get(key)?.references ?? 0;
  }

  /**
   * Returns the region for `key`, packing the image on first use. `load` is called only on a
   * miss. Every acquire must be paired with a release.
   */
  acquire(key: string, load: () => SourceImage): AtlasRegion {
    const hit = this.entries.get(key);
    if (hit) {
      hit.references++;
      return hit.region;
    }
    const image = load();
    const factor = Math.min(1, this.scale / image.pixelScale);
    const resampled = resampleToPremultiplied(image.pixels, image.rect, factor);
    const padding = this.padding;
    const width = resampled.width + padding * 2;
    const height = resampled.height + padding * 2;
    if (width > this.pageSize || height > this.pageSize) {
      throw new RangeError(`image '${key}' is ${resampled.width}x${resampled.height} at display scale; pages are ${this.pageSize}px`);
    }

    const { page, allocation } = this.allocate(key, width, height);
    // Clear the whole cell (an evicted image may have left pixels) and copy the image in.
    const pageStride = this.pageSize * 4;
    for (let y = 0; y < height; y++) {
      const start = (allocation.y + y) * pageStride + allocation.x * 4;
      page.data.fill(0, start, start + width * 4);
    }
    const rowBytes = resampled.width * 4;
    for (let y = 0; y < resampled.height; y++) {
      const target = (allocation.y + padding + y) * pageStride + (allocation.x + padding) * 4;
      page.data.set(resampled.data.subarray(y * rowBytes, (y + 1) * rowBytes), target);
    }
    page.dirty = true;

    const x0 = allocation.x + padding;
    const y0 = allocation.y + padding;
    const region: AtlasRegion = {
      key,
      page,
      u0: x0 / this.pageSize,
      v0: y0 / this.pageSize,
      u1: (x0 + resampled.contentWidth) / this.pageSize,
      v1: (y0 + resampled.contentHeight) / this.pageSize
    };
    this.entries.set(key, { region, allocation, pageIndex: page.index, references: 1, releasedAt: 0 });
    return region;
  }

  /** Drops one reference. The image stays resident until its space is needed. */
  release(region: AtlasRegion): void {
    const entry = this.entries.get(region.key);
    if (!entry || entry.region !== region || entry.references <= 0) throw new Error(`release of '${region.key}' without a matching acquire`);
    entry.references--;
    if (entry.references === 0) entry.releasedAt = ++this.tick;
  }

  /** Uploads every page changed since the last flush (one source update per dirty page). */
  flush(): void {
    for (const page of this.pageList) {
      if (!page.dirty) continue;
      page.dirty = false;
      page.source.update();
    }
  }

  /**
   * Flushes automatically before each render of `renderer` (its prerender step). Returns a
   * function that removes the hook.
   */
  flushBeforeRender(renderer: Renderer): () => void {
    const hook = { prerender: () => this.flush() };
    renderer.runners.prerender.add(hook);
    return () => renderer.runners.prerender.remove(hook);
  }

  stats(): DynamicAtlasStats {
    let referenced = 0;
    for (const entry of this.entries.values()) if (entry.references > 0) referenced++;
    return {
      pages: this.pageList.length,
      residentImages: this.entries.size,
      referencedImages: referenced,
      evictions: this.evictions,
      pagesOverBudget: Math.max(0, this.pageList.length - this.budgetPages)
    };
  }

  destroy(): void {
    for (const page of this.pageList) page.texture.destroy(true);
    this.pageList.length = 0;
    this.entries.clear();
  }

  private allocate(key: string, width: number, height: number): { page: Page; allocation: ShelfAllocation } {
    const tryPages = () => {
      for (const page of this.pageList) {
        const allocation = page.allocator.allocate(width, height);
        if (allocation) return { page, allocation };
      }
      return null;
    };
    let found = tryPages();
    if (found) return found;
    if (this.pageList.length < this.budgetPages) return this.allocateOnNewPage(width, height);

    // Evict released images, least recently released first, until the image fits.
    const evictable = [...this.entries.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort((a, b) => a[1].releasedAt - b[1].releasedAt);
    for (const [evictKey, entry] of evictable) {
      const page = this.pageList[entry.pageIndex] as Page;
      page.allocator.free(entry.allocation);
      this.entries.delete(evictKey);
      this.evictions++;
      const allocation = page.allocator.allocate(width, height);
      if (allocation) return { page, allocation };
    }
    found = tryPages();
    if (found) return found;
    if (this.pageList.length < this.maxPages) return this.allocateOnNewPage(width, height);
    throw new Error(`dynamic atlas is full (${this.maxPages} pages of ${this.pageSize}px, every image in use) adding '${key}'`);
  }

  private allocateOnNewPage(width: number, height: number): { page: Page; allocation: ShelfAllocation } {
    const size = this.pageSize;
    const data = new Uint8Array(size * size * 4);
    const source = new BufferImageSource({
      resource: data,
      width: size,
      height: size,
      format: "rgba8unorm",
      alphaMode: "premultiplied-alpha",
      scaleMode: "linear",
      autoGenerateMipmaps: false,
      label: `animator-atlas-${this.pageList.length}`
    });
    const page: Page = {
      index: this.pageList.length,
      texture: new Texture({ source }),
      size,
      allocator: new ShelfAllocator(size, size),
      data,
      source,
      dirty: false
    };
    this.pageList.push(page);
    const allocation = page.allocator.allocate(width, height);
    if (!allocation) throw new Error("internal: an empty page refused an image that fits");
    return { page, allocation };
  }
}
