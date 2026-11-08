import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { createImage } from "./image.js";
import { readPng } from "./png.js";
import { grid, jointSheetTiles, renderTag, SOFT_RENDER } from "./review.js";
import { texturesFromAtlas } from "./validate.js";

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);

describe("review sheets", () => {
  const doc = loadAnimDocument(JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8")));
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
  const textures = texturesFromAtlas(pack, new Map([["three-part.atlas.png", readPng(fileURLToPath(fixture("three-part.atlas.png")))]]));

  it("label every joint tile with its scale, DPR, filter and renderer", () => {
    const poses = [{ name: "rest", rotate: {} }, { name: "bent", rotate: { chest: 20 } }];
    const half = jointSheetTiles(doc, textures, { poses });
    expect(half.map((tile) => tile.label)).toEqual(["rest\n0.5x dpr1 bilinear cpu soft", "bent\n0.5x dpr1 bilinear cpu soft"]);
    const triple = jointSheetTiles(doc, textures, { poses, scale: 3, frame: { x: 0, y: 0, width: 40, height: 30 } });
    expect(triple.every((tile) => tile.label.endsWith("\n3x dpr1 bilinear cpu soft"))).toBe(true);
    expect(renderTag({ scale: 1 / 3, dpr: 3, filter: "linear", renderer: "pixi webgl" })).toBe("0.333x dpr3 linear pixi webgl");
    expect(SOFT_RENDER.renderer).toBe("cpu soft");
  });

  it("grow the label strip for two-line labels and fit the longest line", () => {
    const tile = createImage(20, 20);
    const one = grid([{ image: tile, label: "a" }], 1);
    const two = grid([{ image: tile, label: "a\n0.5x dpr1 bilinear cpu soft" }], 1);
    expect(two.height - one.height).toBe(16);
    expect(two.width).toBeGreaterThanOrEqual(12 * "0.5x dpr1 bilinear cpu soft".length);
  });
});
