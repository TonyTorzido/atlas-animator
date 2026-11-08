import { describe, expect, it } from "vitest";
import { createImage, type MutableImage } from "./image.js";
import { outlineImage, pointInOutline, polygonArea, simplifyClosed } from "./outline.js";

function paint(image: MutableImage, inside: (x: number, y: number) => number): MutableImage {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = inside(x + 0.5, y + 0.5);
      const p = (y * image.width + x) * 4;
      image.data[p] = 200;
      image.data[p + 1] = 150;
      image.data[p + 2] = 100;
      image.data[p + 3] = a;
    }
  }
  return image;
}

describe("outline", () => {
  it("outlines a rectangle sprite to 4-8 points that enclose it", () => {
    const image = paint(createImage(120, 80), (x, y) => (x > 20 && x < 100 && y > 10 && y < 70 ? 255 : 0));
    const outline = outlineImage(image);
    expect(outline.outer.length).toBeGreaterThanOrEqual(4);
    expect(outline.outer.length).toBeLessThanOrEqual(8);
    expect(outline.holes).toEqual([]);
    expect(polygonArea(outline.outer)).toBeGreaterThan(0);
    // Pixels 20..99 x 10..69, grown by 2 px each side; the contour runs on pixel edges.
    for (const [x, y] of [[20.5, 10.5], [99.5, 69.5], [60, 40]] as const) expect(pointInOutline(x, y, outline)).toBe(true);
    const xs = outline.outer.map((p) => p.x);
    const ys = outline.outer.map((p) => p.y);
    expect(Math.min(...xs)).toBe(18);
    expect(Math.max(...xs)).toBe(102);
    expect(Math.min(...ys)).toBe(8);
    expect(Math.max(...ys)).toBe(72);
  });

  it("keeps the largest region and drops specks", () => {
    const image = paint(createImage(100, 100), (x, y) => {
      if (x > 10 && x < 60 && y > 10 && y < 60) return 255;
      if (x > 80 && x < 84 && y > 80 && y < 84) return 255; // speck
      return 0;
    });
    const outline = outlineImage(image);
    expect(outline.outer.every((p) => p.x < 70 && p.y < 70)).toBe(true);
  });

  it("finds holes, oriented negative", () => {
    const image = paint(createImage(100, 100), (x, y) => {
      const outer = x > 10 && x < 90 && y > 10 && y < 90;
      const hole = x > 35 && x < 65 && y > 35 && y < 65;
      return outer && !hole ? 255 : 0;
    });
    const outline = outlineImage(image);
    expect(outline.holes).toHaveLength(1);
    expect(polygonArea(outline.holes[0] ?? [])).toBeLessThan(0);
    expect(pointInOutline(50, 50, outline)).toBe(false);
    expect(pointInOutline(20, 50, outline)).toBe(true);
  });

  it("ignores alpha below the threshold", () => {
    const image = paint(createImage(60, 60), (x, y) => (x > 10 && x < 50 && y > 10 && y < 50 ? (x < 30 ? 255 : 100) : 0));
    const outline = outlineImage(image, { padding: 0 });
    expect(Math.max(...outline.outer.map((p) => p.x))).toBeLessThan(32);
  });

  it("traces a disk within the simplification tolerance", () => {
    const image = paint(createImage(200, 200), (x, y) => (Math.hypot(x - 100, y - 100) < 70 ? 255 : 0));
    const outline = outlineImage(image, { padding: 0, tolerance: 1.5 });
    for (const p of outline.outer) expect(Math.abs(Math.hypot(p.x - 100, p.y - 100) - 70)).toBeLessThan(1.2);
    // Chord midpoints sit within tolerance + pixel rounding of the circle.
    outline.outer.forEach((p, i) => {
      const q = outline.outer[(i + 1) % outline.outer.length] ?? p;
      expect(70 - Math.hypot((p.x + q.x) / 2 - 100, (p.y + q.y) / 2 - 100)).toBeLessThan(2.2);
    });
    expect(outline.outer.length).toBeGreaterThanOrEqual(16);
    expect(outline.outer.length).toBeLessThan(80);
  });

  it("simplifyClosed drops collinear points", () => {
    const square = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }
    ];
    expect(simplifyClosed(square, 0.5)).toHaveLength(4);
  });
});
