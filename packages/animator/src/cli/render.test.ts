import { describe, expect, it } from "vitest";
import { createImage } from "../tools/image.js";
import { encodePng } from "../tools/png.js";
import { contactSheet, contactSheetTiles, type RenderResult } from "./render.js";

describe("render contact sheet", () => {
  it("labels every tile with its scale, DPR, filter and renderer (the Pixi page, not the CPU rasteriser)", () => {
    const png = encodePng(createImage(8, 8));
    const result: RenderResult = {
      frames: [0, 0.5, 1].map((time) => ({ time, png })),
      width: 8,
      height: 8,
      fps: 2,
      clip: "idle",
      renderer: "ANGLE (SwiftShader)",
      scale: 0.25,
      missingTextures: []
    };
    expect(contactSheetTiles(result).map((tile) => tile.label)).toEqual([
      "idle 0.00s\n0.25x dpr1 linear pixi webgl swiftshader",
      "idle 0.50s\n0.25x dpr1 linear pixi webgl swiftshader",
      "idle 1.00s\n0.25x dpr1 linear pixi webgl swiftshader"
    ]);
    expect(contactSheetTiles({ ...result, clip: null, scale: 3 }, 1).map((tile) => tile.label)).toEqual(["setup 0.00s\n3x dpr1 linear pixi webgl swiftshader"]);
    // Second rig acceptance: each tile is exactly its frame (--size) wide; the label is cut to fit.
    expect(contactSheet(result).width).toBe(3 * 8 + 4 * 6);
    const wide = { ...result, width: 300, frames: result.frames.map((f) => ({ ...f, png: encodePng(createImage(300, 8)) })) };
    expect(contactSheet(wide).width).toBe(3 * 300 + 4 * 6);
  });
});
