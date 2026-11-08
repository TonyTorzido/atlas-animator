import { describe, expect, it } from "vitest";
import { measureNeck, neckReasons } from "./swagGates.js";

const W = 200;
const H = 240;
const CHIN = 60;
const NECK_X = 100;

/** A synthetic garment mask: `fill` returns true where the garment shows. Game scale 1 so a pixel is a game pixel. */
function mask(fill: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fill(x, y)) m[y * W + x] = 1;
  return m;
}
const reasons = (m: Uint8Array): string[] => neckReasons(measureNeck({ mask: m, width: W, height: H, chinY: CHIN, neckX: NECK_X, scale: 1 })).map((r) => r.reason);
const torso = (x: number, y: number, top = 62): boolean => y >= top && x >= 40 && x < 160;

describe("neck gate (the user's flat-neck rule)", () => {
  it("passes a collar band right under the chin", () => {
    expect(reasons(mask((x, y) => torso(x, y, 64)))).toEqual([]);
  });
  it("passes a little skin between the chin and the collar, and small pockets lower on the chest (buttons)", () => {
    const m = mask((x, y) => torso(x, y, 66) && !(y >= 100 && y < 106 && x >= 96 && x < 104));
    expect(reasons(m)).toEqual([]);
  });
  it("passes a garment that never reaches the neck (boots) as not reaching", () => {
    const m = mask((x, y) => y > 200 && x > 60 && x < 100);
    expect(measureNeck({ mask: m, width: W, height: H, chinY: CHIN, neckX: NECK_X, scale: 1 }).reaches).toBe(false);
  });
  it("fails a grey scoop hole cut out under the chin", () => {
    const m = mask((x, y) => torso(x, y, 62) && Math.hypot(x - NECK_X, y - 62) > 30);
    expect(reasons(m).some((r) => r.includes("scoop"))).toBe(true);
  });
  it("fails an enclosed ring / hole around the neck", () => {
    const m = mask((x, y) => torso(x, y, 62) && Math.hypot(x - NECK_X, y - 80) > 14);
    expect(reasons(m).some((r) => r.includes("hole or ring"))).toBe(true);
  });
  it("fails a dark slab under the chin (a thick column of collar above the shoulders)", () => {
    const m = mask((x, y) => (y >= 62 && y < 100 && x >= 80 && x < 120) || torso(x, y, 100));
    expect(reasons(m).some((r) => r.includes("slab"))).toBe(true);
  });
  it("fails garment showing above the chin", () => {
    const m = mask((x, y) => torso(x, y, 64) || (y >= 10 && y < 50 && x >= 80 && x < 120));
    expect(reasons(m).some((r) => r.includes("above the chin"))).toBe(true);
  });
});
