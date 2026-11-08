import { MeshGeometry } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimatorCharacter } from "./animatorCharacter.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import type { PartImageProvider } from "./partImages.js";

/*
 * Runtime contract F3: outfit construction is transactional. A failed construction or replacement
 * releases every atlas reference and staged geometry it took; a failed replacement keeps the
 * previous outfit (skins, drawables, references).
 */

const region = (path: string) => ({ type: "region" as const, path, width: 6, height: 6 });
const doc = loadAnimDocument({
  format: "atlas-anim@1",
  name: "outfit",
  canvas: { width: 100, height: 100, originX: 0, originY: 0 },
  bones: [{ name: "root" }],
  slots: [
    { name: "a", bone: "root", attachment: "a" },
    { name: "b", bone: "root", attachment: "b" }
  ],
  skins: {
    base: { attachments: { a: { a: region("a") } } },
    gear: { attachments: { b: { b: region("b") } } },
    alt: { attachments: { a: { a: region("c") } } }
  }
});

const square = { pixels: { width: 6, height: 6, data: new Uint8Array(6 * 6 * 4).fill(255) }, rect: { x: 0, y: 0, width: 6, height: 6 }, pixelScale: 1 };
const images: PartImageProvider = { get: (path) => (["a", "b", "c"].includes(path) ? square : undefined) };
/** One 8 px page with a 1 px gutter: room for exactly one 6 x 6 image. */
const tinyAtlas = (pages = 1) => new DynamicAtlas({ pageSize: 8, padding: 1, scale: 1, budgetPages: pages, maxPages: pages });

function build(skins: string[], atlas: DynamicAtlas) {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(skins);
  return new AnimatorCharacter({ skeleton, atlas, images });
}

afterEach(() => vi.restoreAllMocks());

describe("outfit construction is transactional (F3)", () => {
  it("a failed initial construction releases the references and geometry it staged", () => {
    const atlas = tinyAtlas();
    const destroyed = vi.spyOn(MeshGeometry.prototype, "destroy");
    expect(() => build(["base", "gear"], atlas)).toThrow(/full/);
    expect(atlas.references("a")).toBe(0);
    expect(atlas.references("b")).toBe(0);
    expect(atlas.stats().referencedImages).toBe(0);
    // The staged drawable of image a and the shared empty geometry.
    expect(destroyed.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a failed replacement keeps the previous outfit, its skins and its reference counts", () => {
    const atlas = tinyAtlas();
    const c = build(["base"], atlas);
    c.update();
    expect(atlas.references("a")).toBe(1);
    const shown = c.slotMeshes.filter((mesh) => mesh.visible).map((mesh) => mesh.label);
    const destroyed = vi.spyOn(MeshGeometry.prototype, "destroy");
    expect(() => c.setActiveSkins(["base", "gear"])).toThrow(/full/);
    expect(atlas.references("a")).toBe(1);
    expect(atlas.references("b")).toBe(0);
    expect(c.skeleton.activeSkins).toEqual(["base"]);
    expect(destroyed).not.toHaveBeenCalled(); // nothing was staged before the failing acquire
    c.update();
    expect(c.slotMeshes.filter((mesh) => mesh.visible).map((mesh) => mesh.label)).toEqual(shown);
    c.destroy();
    expect(atlas.stats().referencedImages).toBe(0);
  });

  it("capacity pressure while old and new outfits coexist: fails cleanly at one page, swaps at two", () => {
    const tight = tinyAtlas();
    const c = build(["base"], tight);
    // Replacing image a by image c needs both resident at once (old released only on commit).
    expect(() => c.setActiveSkins(["alt"])).toThrow(/full/);
    expect(tight.references("a")).toBe(1);
    expect(tight.references("c")).toBe(0);
    expect(c.skeleton.activeSkins).toEqual(["base"]);

    const roomy = tinyAtlas(2);
    const d = build(["base"], roomy);
    d.setActiveSkins(["alt"]);
    expect(roomy.references("a")).toBe(0);
    expect(roomy.references("c")).toBe(1);
  });
});
