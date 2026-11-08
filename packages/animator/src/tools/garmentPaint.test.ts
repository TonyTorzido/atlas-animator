/*
 * Atlas Animator: original implementation.
 *
 * Plan: the paint's stroke-distance field covers every band that reads it, so the
 * beside-stroke shading easing fades out smoothly instead of stopping at a hard step.
 */
import { describe, expect, it } from "vitest";
import type { RgbaImage } from "./image.js";
import { BESIDE_SHADE_CAP, paintGarmentTexture } from "./garmentPaint.js";
import type { GarmentBuild } from "./garmentSurface.js";

describe("garment paint", () => {
  it("eases shading beside a straight stroke without a step", () => {
    // a 100 x 80 px rectangle garment (two triangles), fabric blue-grey with a broad darker band along its left edge
    // (the art's own form shading) and a still darker 8 px line hugging the stroke inside it
    const W = 100;
    const H = 80;
    const build = {
      attachment: { width: W, height: H, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], groups: { g: [[0, 2]] } },
      origin: [0, 0],
      runs: [],
      paintedEdges: [],
      insetCuts: []
    } as unknown as GarmentBuild;
    const art: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) art.data.set(x < 8 ? [40, 50, 80, 255] : x < 40 ? [60, 75, 110, 255] : [90, 110, 160, 255], (y * W + x) * 4);
    const { texture, report } = paintGarmentTexture(build, art, { strokeWidth: 10, margin: 4 });
    const L = (x: number) => { const o = (40 * W + x) * 4; return 0.299 * (texture.data[o] as number) + 0.587 * (texture.data[o + 1] as number) + 0.114 * (texture.data[o + 2] as number); };
    const row = Array.from({ length: 36 }, (_, x) => L(x + 2));
    const steps = row.slice(1).map((v, i) => Math.abs(v - (row[i] as number)));
    // the easing changes gradually from the stroke edge across the eased zone (no step of its own)
    expect(Math.max(...steps)).toBeLessThanOrEqual(8);
    // (local reference): the line hugging the stroke is lifted to within BESIDE_SHADE_CAP of the fabric just
    // inward (the band), not to the garment-wide median: the band's own shade and hue carry on up to the stroke
    const band = 0.299 * 60 + 0.587 * 75 + 0.114 * 110;
    const median = 0.299 * report.fabricMedian[0] + 0.587 * report.fabricMedian[1] + 0.114 * report.fabricMedian[2];
    expect(row[0]).toBeGreaterThan(band - BESIDE_SHADE_CAP);
    expect(row[0]).toBeLessThan(median - 2 * BESIDE_SHADE_CAP);
    expect(Math.abs((texture.data[(40 * W + 20) * 4 + 2] as number) - 110)).toBeLessThanOrEqual(4);
  });

  it("holds a dark side panel beside the stroke within BESIDE_SHADE_CAP of the fabric (armour)", () => {
    // tan leather with a dark 20 px side panel hugging the left edge (the leather cuirass flank). The defect:
    // the panel half-eased, a dark ramp ending in a hard step back to the fabric, read as a second outline beside the
    // flank stroke (flankSingleLine's doubled rows); a lift whose base blurs across the panel's inner edge gives the
    // same, a dark line on the panel side and a light one on the fabric side
    const W = 100;
    const H = 80;
    const build = {
      attachment: { width: W, height: H, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], groups: { g: [[0, 2]] } },
      origin: [0, 0],
      runs: [],
      paintedEdges: [],
      insetCuts: []
    } as unknown as GarmentBuild;
    const panel = [112, 64, 32];
    const art: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) art.data.set(x < 20 ? [...panel, 255] : [164, 100, 53, 255], (y * W + x) * 4);
    const { texture } = paintGarmentTexture(build, art, { strokeWidth: 10, margin: 4 });
    const lumOf = (c: ArrayLike<number>) => 0.299 * (c[0] as number) + 0.587 * (c[1] as number) + 0.114 * (c[2] as number);
    const row = Array.from({ length: 50 }, (_, x) => lumOf(texture.data.slice((40 * W + x) * 4, (40 * W + x) * 4 + 3)));
    // the local fabric: the art just inward of the eased zone
    const fabric = row[49] as number;
    // a second line beside the stroke: across the flank gate's window (3 stroke widths and the panel's edge), a texel
    // darker than the fabric by more than the cap, lighter than it by more than the cap, or a step over the cap
    const doubled = (r: number[]) => r.slice(5, 41).some((v, k) => v < fabric - BESIDE_SHADE_CAP - 1 || v > fabric + BESIDE_SHADE_CAP + 1 || Math.abs(v - (r[k + 4] as number)) > BESIDE_SHADE_CAP);
    expect(doubled(row)).toBe(false);
    // damaged control: the defect, the panel's inner 5 px left at the art's panel shade
    const damaged = row.map((v, x) => (x >= 15 && x < 20 ? lumOf(panel) : v));
    expect(doubled(damaged)).toBe(true);
  });

  it("keeps a belt strap and its trim lines beside a stroke (armour)", () => {
    // tan leather, a dark outline ring, and a dark strap edged by outline-coloured lines 8-25 px above the
    // bottom edge (the hem stroke): trim between two paints, inside the beside-stroke cap's reach
    const W = 120;
    const H = 90;
    const build = {
      attachment: { width: W, height: H, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], groups: { g: [[0, 2]] } },
      origin: [0, 0],
      runs: [],
      paintedEdges: [],
      insetCuts: []
    } as unknown as GarmentBuild;
    const tan = [164, 100, 53, 255];
    const strap = [110, 62, 32, 255];
    const line = [40, 16, 8, 255];
    const art: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ring = x < 4 || y < 4 || x >= W - 4 || y >= H - 4;
      const c = ring ? line : (y >= 62 && y <= 64) || (y >= 79 && y <= 81) ? line : y > 64 && y < 79 ? strap : tan;
      art.data.set(c, (y * W + x) * 4);
    }
    const { texture, report } = paintGarmentTexture(build, art, { strokeWidth: 10, margin: 4 });
    const at = (x: number, y: number) => Array.from(texture.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    const L = (c: number[]) => 0.299 * (c[0] as number) + 0.587 * (c[1] as number) + 0.114 * (c[2] as number);
    // the strap keeps its paint across the middle and the top edge line stays a line
    for (const x of [40, 60, 80]) {
      expect(Math.abs(L(at(x, 71)) - L(strap))).toBeLessThan(4);
      expect(L(at(x, 63))).toBeLessThan(L(strap) - 20);
    }
    expect(report.trimLinePreserved).toBeGreaterThanOrEqual(0.98);
  });

  it("never refills removed ink from near-ink shading (Jade C strap edge)", () => {
    // mail fabric with an outline ring; an interior piece-edge ink line (same paint on both sides: removed) runs
    // through a patch of near-ink shading whose two halves sit on opposite sides of the outline colour, each just
    // outside the line tolerance (not ink themselves) but averaging back into the ink colour
    const W = 240;
    const H = 200;
    const build = {
      attachment: { width: W, height: H, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], groups: { g: [[0, 2]] } },
      origin: [0, 0],
      runs: [],
      paintedEdges: [],
      insetCuts: []
    } as unknown as GarmentBuild;
    const O = [40, 30, 25];
    const mail = [120, 130, 150];
    const A = [72, 30, 25];
    const B = [8, 30, 25];
    const art: RgbaImage = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ring = x < 6 || y < 6 || x >= W - 6 || y >= H - 6;
      const patch = x >= 104 && x <= 136 && y >= 80 && y <= 120;
      const line = x >= 119 && x <= 121 && y >= 84 && y <= 116;
      const c = ring || line ? O : patch ? (y < 100 ? A : B) : mail;
      art.data.set([...c, 255], (y * W + x) * 4);
    }
    // damaged control: the plain 3x3 mean beside the line where the two shades meet is ink-coloured (within the
    // line tolerance of the outline), so a refill that reads the shading puts the ink back
    const mean = [0, 1, 2].map((k) => { let s = 0; for (const [dx, dy] of [[-1, -1], [-1, 0], [-1, 1]] as [number, number][]) s += art.data[((100 + dy) * W + 118 + dx) * 4 + k] as number; return s / 3; });
    expect(Math.hypot(mean[0]! - O[0]!, mean[1]! - O[1]!, mean[2]! - O[2]!)).toBeLessThanOrEqual(30);
    const { texture, report } = paintGarmentTexture(build, art, { strokeWidth: 10, margin: 4 });
    expect(report.inkRemovedPx).toBeGreaterThan(0);
    expect(report.residualOcclusionInk).toBe(0);
    // every refilled line texel is clear of the ink band (no ink-dark refill)
    for (let y = 84; y <= 116; y++) for (let x = 119; x <= 121; x++) {
      const o = (y * W + x) * 4;
      expect(Math.hypot((texture.data[o] as number) - O[0]!, (texture.data[o + 1] as number) - O[1]!, (texture.data[o + 2] as number) - O[2]!)).toBeGreaterThan(40);
    }
  });
});

