import { describe, expect, it } from "vitest";
import { atlasPackSchema } from "../core/atlasPack.js";
import { packedAtlasImages } from "../pixi/partImages.js";
import { packAtlas } from "./atlasPacker.js";
import { createImage, type MutableImage } from "./image.js";

function solid(width: number, height: number, value: number): MutableImage {
  const image = createImage(width, height);
  for (let p = 0; p < image.data.length; p += 4) {
    image.data[p] = value;
    image.data[p + 1] = 255 - value;
    image.data[p + 2] = 7;
    image.data[p + 3] = 255;
  }
  return image;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("atlas packer", () => {
  it("packs downscaled regions without overlaps and writes a valid sidecar", () => {
    const items = [
      { path: "body/torso", image: solid(300, 420, 10) },
      { path: "body/head", image: solid(440, 480, 50) },
      { path: "body/arm_l", image: solid(160, 330, 90) },
      { path: "body/arm_r", image: solid(160, 330, 130) },
      { path: "body/leg_l", image: solid(140, 240, 170) }
    ];
    const { pack, pages } = packAtlas(items, { name: "rig", scale: 0.5 });
    expect(atlasPackSchema.parse(pack)).toEqual(pack);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.file).toBe("rig.0.png");
    const regions = Object.entries(pack.pages[0]?.regions ?? {});
    expect(regions.map(([path]) => path).sort()).toEqual(items.map((item) => item.path).sort());
    for (const [path, rect] of regions) {
      const item = items.find((i) => i.path === path);
      expect(rect.width).toBe(Math.ceil((item?.image.width ?? 0) * 0.5));
      expect(rect.height).toBe(Math.ceil((item?.image.height ?? 0) * 0.5));
      for (const [otherPath, other] of regions) if (otherPath !== path) expect(overlaps(rect, other), `${path} vs ${otherPath}`).toBe(false);
      // At least the padding from the page edge.
      expect(rect.x).toBeGreaterThanOrEqual(2);
      expect(rect.y).toBeGreaterThanOrEqual(2);
    }
  });

  it("round-trips through the runtime's packed-image provider", () => {
    const items = [{ path: "a", image: solid(64, 32, 200) }, { path: "b", image: solid(10, 90, 40) }];
    const { pack, pages } = packAtlas(items, { name: "rt", scale: 0.5 });
    const provider = packedAtlasImages(pack, new Map(pages.map((p) => [p.file, p.image])));
    const a = provider.get("a");
    expect(a?.pixelScale).toBe(0.5);
    expect(a?.rect).toMatchObject({ width: 32, height: 16 });
    // A solid image stays the same colour after the box filter.
    const page = pages[0]?.image as MutableImage;
    const rect = pack.pages[0]?.regions.a ?? { x: 0, y: 0 };
    const p = ((rect.y + 3) * page.width + rect.x + 3) * 4;
    expect([...page.data.subarray(p, p + 4)]).toEqual([200, 55, 7, 255]);
  });

  it("box-filters at half scale (2x2 average in premultiplied alpha)", () => {
    const image = createImage(2, 2);
    // Two opaque white pixels, two transparent: the average is white at half alpha.
    image.data.set([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
    const { pack, pages } = packAtlas([{ path: "x", image }], { name: "box", padding: 0 });
    const rect = pack.pages[0]?.regions.x ?? { x: 0, y: 0 };
    const page = pages[0]?.image as MutableImage;
    const p = (rect.y * page.width + rect.x) * 4;
    expect([...page.data.subarray(p, p + 4)]).toEqual([255, 255, 255, 128]);
  });

  it("opens more pages when one is full, and rejects images larger than a page", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ path: `p${i}`, image: solid(200, 200, i * 20) }));
    const { pack } = packAtlas(items, { name: "multi", scale: 1, pageSize: 420 });
    expect(pack.pages.length).toBeGreaterThan(1);
    expect(pack.pages.flatMap((page) => Object.keys(page.regions)).sort()).toEqual(items.map((i) => i.path).sort());
    expect(() => packAtlas([{ path: "big", image: solid(500, 10, 0) }], { name: "big", scale: 1, pageSize: 420 })).toThrow(/larger than/);
    expect(() => packAtlas([items[0] as (typeof items)[number], items[0] as (typeof items)[number]], { name: "dup" })).toThrow(/twice/);
  });
});
