import { SystemRunner, type Renderer } from "pixi.js";
import { describe, expect, it } from "vitest";
import { random } from "../core/testHelpers.js";
import { DynamicAtlas, type SourceImage } from "./dynamicAtlas.js";
import { resampleToPremultiplied, unpremultiply, type RgbaImage } from "./imageOps.js";
import { packedAtlasImages, separateImages } from "./partImages.js";
import { ShelfAllocator, type ShelfAllocation } from "./shelfAllocator.js";

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("box resampling", () => {
  it("halves by averaging 2x2 blocks", () => {
    // Opaque 4x2: left 2x2 block black/white checker, right block solid (200, 100, 0).
    const src = image(4, 2, (x, y) => (x < 2 ? ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]) : [200, 100, 0, 255]));
    const out = resampleToPremultiplied(src, { x: 0, y: 0, width: 4, height: 2 }, 0.5);
    expect([out.width, out.height, out.contentWidth, out.contentHeight]).toEqual([2, 1, 2, 1]);
    expect(px(out, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(px(out, 1, 0)).toEqual([200, 100, 0, 255]);
  });

  it("averages in premultiplied alpha, so transparent neighbours do not darken colour", () => {
    // A red opaque pixel next to three fully transparent black ones.
    const src = image(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const out = resampleToPremultiplied(src, { x: 0, y: 0, width: 2, height: 2 }, 0.5);
    expect(px(out, 0, 0)).toEqual([64, 0, 0, 64]); // premultiplied quarter-covered red
    expect(px(unpremultiply(out), 0, 0)).toEqual([255, 0, 0, 64]); // still pure red
  });

  it("works on a sub-rectangle and keeps total coverage for fractional scales", () => {
    const src = image(10, 10, (x, y) => (x >= 2 && x < 7 && y >= 3 && y < 6 ? [10, 20, 30, 255] : [255, 255, 255, 0]));
    const out = resampleToPremultiplied(src, { x: 2, y: 3, width: 5, height: 3 }, 0.4);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(out.contentWidth).toBeCloseTo(2, 9);
    expect(out.contentHeight).toBeCloseTo(1.2, 9);
    // Total alpha (in destination pixel units) equals the covered area 2 x 1.2.
    let alpha = 0;
    for (let i = 3; i < out.data.length; i += 4) alpha += (out.data[i] as number) / 255;
    expect(alpha).toBeCloseTo(2.4, 1);
  });

  it("copies exactly at scale 1", () => {
    const src = image(3, 2, (x, y) => [x * 50, y * 70, 9, 255]);
    const out = resampleToPremultiplied(src, { x: 1, y: 0, width: 2, height: 2 }, 1);
    expect(px(out, 0, 1)).toEqual([50, 70, 9, 255]);
    expect(px(out, 1, 0)).toEqual([100, 0, 9, 255]);
  });

  it("rejects rectangles outside the image and upscaling", () => {
    const src = image(2, 2, () => [0, 0, 0, 0]);
    expect(() => resampleToPremultiplied(src, { x: 1, y: 0, width: 2, height: 2 }, 1)).toThrow(RangeError);
    expect(() => resampleToPremultiplied(src, { x: 0, y: 0, width: 2, height: 2 }, 2)).toThrow(RangeError);
  });
});

describe("shelf allocator", () => {
  const overlaps = (a: ShelfAllocation, b: ShelfAllocation) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("packs rectangles inside the page without overlap, and frees for reuse", () => {
    const allocator = new ShelfAllocator(256, 256);
    const next = random(3);
    const live: ShelfAllocation[] = [];
    for (let round = 0; round < 400; round++) {
      if (live.length > 0 && next(0, 1) < 0.4) {
        const [freed] = live.splice(Math.floor(next(0, live.length)), 1);
        allocator.free(freed as ShelfAllocation);
        continue;
      }
      const a = allocator.allocate(Math.ceil(next(4, 60)), Math.ceil(next(4, 60)));
      if (!a) continue;
      expect(a.x >= 0 && a.y >= 0 && a.x + a.width <= 256 && a.y + a.height <= 256).toBe(true);
      for (const other of live) expect(overlaps(a, other), `${JSON.stringify(a)} overlaps ${JSON.stringify(other)}`).toBe(false);
      live.push(a);
    }
    expect(allocator.usedArea).toBe(live.reduce((sum, a) => sum + a.width * a.height, 0));
    for (const a of live) allocator.free(a);
    expect(allocator.usedArea).toBe(0);
    expect(allocator.shelfCount).toBe(0);
    // Everything was returned: a full-page allocation fits again.
    expect(allocator.allocate(256, 256)).not.toBeNull();
  });

  it("reuses a freed span in place and refuses what cannot fit", () => {
    const allocator = new ShelfAllocator(100, 100);
    const a = allocator.allocate(60, 50) as ShelfAllocation;
    const b = allocator.allocate(40, 50) as ShelfAllocation;
    const c = allocator.allocate(100, 50) as ShelfAllocation;
    expect([a.y, b.x, b.y, c.y]).toEqual([0, 60, 0, 50]);
    expect(allocator.allocate(10, 10)).toBeNull();
    allocator.free(a);
    const d = allocator.allocate(50, 40) as ShelfAllocation;
    expect([d.x, d.y]).toEqual([0, 0]);
    expect(() => allocator.free(a)).toThrow(/already freed/);
  });
});

describe("dynamic atlas", () => {
  const solid = (size: number, rgba: [number, number, number, number]): SourceImage => ({
    pixels: image(size, size, () => rgba),
    rect: { x: 0, y: 0, width: size, height: size },
    pixelScale: 1
  });

  it("packs at display scale with a gutter and maps the image's UV square onto it", () => {
    const atlas = new DynamicAtlas({ pageSize: 64, scale: 0.5, padding: 2 });
    const region = atlas.acquire("a", () => solid(20, [255, 0, 0, 255]));
    expect(region.page.index).toBe(0);
    expect([region.u0, region.v0, region.u1, region.v1]).toEqual([2 / 64, 2 / 64, 12 / 64, 12 / 64]);
    expect(atlas.pages[0]?.texture.source.alphaMode).toBe("premultiplied-alpha");
  });

  it("coalesces uploads: N acquires on one page cause one source update at flush", () => {
    const atlas = new DynamicAtlas({ pageSize: 128 });
    atlas.acquire("first", () => solid(8, [1, 1, 1, 255]));
    const source = atlas.pages[0]?.texture.source;
    let updates = 0;
    source?.on("update", () => updates++);
    for (let i = 0; i < 5; i++) atlas.acquire(`img${i}`, () => solid(8, [i, i, i, 255]));
    expect(atlas.pages).toHaveLength(1);
    expect(updates).toBe(0);
    atlas.flush();
    expect(updates).toBe(1);
    atlas.flush();
    atlas.acquire("img0", () => solid(8, [0, 0, 0, 255])); // a hit changes no pixels
    atlas.flush();
    expect(updates).toBe(1);
  });

  it("flushBeforeRender hooks the renderer's prerender step until removed", () => {
    const atlas = new DynamicAtlas({ pageSize: 64 });
    const prerender = new SystemRunner("prerender");
    const remove = atlas.flushBeforeRender({ runners: { prerender } } as unknown as Renderer);
    atlas.acquire("a", () => solid(8, [1, 1, 1, 255]));
    let updates = 0;
    atlas.pages[0]?.texture.source.on("update", () => updates++);
    prerender.emit();
    expect(updates).toBe(1);
    remove();
    atlas.acquire("b", () => solid(8, [1, 1, 1, 255]));
    prerender.emit();
    expect(updates).toBe(1);
  });

  it("returns the same region for the same key and counts references", () => {
    const atlas = new DynamicAtlas({ pageSize: 64 });
    let loads = 0;
    const load = () => {
      loads++;
      return solid(8, [1, 2, 3, 255]);
    };
    const first = atlas.acquire("a", load);
    expect(atlas.acquire("a", load)).toBe(first);
    expect(loads).toBe(1);
    expect(atlas.references("a")).toBe(2);
    atlas.release(first);
    atlas.release(first);
    expect(atlas.references("a")).toBe(0);
    expect(atlas.has("a")).toBe(true); // stays resident
    expect(() => atlas.release(first)).toThrow(/without a matching acquire/);
  });

  it("evicts the least recently released images first when the budget is full", () => {
    // 32px page, scale 1, padding 0: four 16x16 images fill one page.
    const atlas = new DynamicAtlas({ pageSize: 32, scale: 1, padding: 0, budgetPages: 1, maxPages: 2 });
    const regions = ["a", "b", "c", "d"].map((key) => atlas.acquire(key, () => solid(16, [9, 9, 9, 255])));
    atlas.release(regions[2] as never); // c released first
    atlas.release(regions[0] as never); // then a
    atlas.acquire("e", () => solid(16, [7, 7, 7, 255]));
    expect(atlas.has("c")).toBe(false);
    expect(atlas.has("a")).toBe(true);
    expect(atlas.stats()).toMatchObject({ pages: 1, residentImages: 4, referencedImages: 3, evictions: 1, pagesOverBudget: 0 });
  });

  it("opens pages beyond the budget only when nothing can be evicted, up to the hard limit", () => {
    const atlas = new DynamicAtlas({ pageSize: 16, scale: 1, padding: 0, budgetPages: 1, maxPages: 2 });
    atlas.acquire("a", () => solid(16, [1, 1, 1, 255]));
    atlas.acquire("b", () => solid(16, [1, 1, 1, 255]));
    expect(atlas.stats()).toMatchObject({ pages: 2, pagesOverBudget: 1 });
    expect(() => atlas.acquire("c", () => solid(16, [1, 1, 1, 255]))).toThrow(/dynamic atlas is full/);
  });

  it("clears a reused cell (gutter included) before writing the new image", () => {
    const atlas = new DynamicAtlas({ pageSize: 8, scale: 1, padding: 1, budgetPages: 1, maxPages: 1 });
    const big = atlas.acquire("big", () => solid(6, [255, 255, 255, 255])); // cell 8x8, content (1..6, 1..6)
    atlas.release(big);
    atlas.acquire("small", () => solid(2, [10, 20, 30, 255])); // cell 4x4 at (0, 0), content (1..2, 1..2)
    const data = atlas.pages[0]?.texture.source.resource as Uint8Array;
    const at = (x: number, y: number) => Array.from(data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
    expect(at(1, 1)).toEqual([10, 20, 30, 255]);
    expect(at(3, 1)).toEqual([0, 0, 0, 0]); // was white, now the new image's gutter
    expect(atlas.stats().evictions).toBe(1);
  });
});

describe("part image providers", () => {
  it("a packed atlas serves each path's rectangle at the pack's scale", () => {
    const page = image(8, 4, (x) => [x * 30, 0, 0, 255]);
    const provider = packedAtlasImages(
      {
        format: "atlas-pack@1",
        scale: 0.5,
        pages: [{ file: "p.png", width: 8, height: 4, regions: { "body/a": { x: 4, y: 0, width: 4, height: 4 } } }]
      },
      new Map([["p.png", page]])
    );
    expect(provider.get("body/a")).toEqual({ pixels: page, rect: { x: 4, y: 0, width: 4, height: 4 }, pixelScale: 0.5 });
    expect(provider.get("body/b")).toBeUndefined();
    expect(() => packedAtlasImages({ format: "atlas-pack@1", scale: 1, pages: [{ file: "q.png", width: 1, height: 1, regions: {} }] }, new Map())).toThrow(
      /'q.png' was not provided/
    );
  });

  it("separate images cover the whole image", () => {
    const img = image(3, 5, () => [0, 0, 0, 255]);
    expect(separateImages(new Map([["x", img]])).get("x")?.rect).toEqual({ x: 0, y: 0, width: 3, height: 5 });
  });
});
