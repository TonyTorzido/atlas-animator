/*
 * Atlas Animator: original implementation.
 *
 * Draws the fixture atlas page of the hand-made three-part test rig
 * (fixtures/rigs/three-part.atlas.png, regions in three-part.atlas.json). Deterministic: rerun
 * with `pnpm exec tsx browser-tests/tools/makeThreePartAtlas.ts` only when the art should change.
 */
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";

type Rgba = readonly [number, number, number, number];
const SIZE = 256;
const png = new PNG({ width: SIZE, height: SIZE });
png.data.fill(0);

function put(x: number, y: number, [r, g, b, a]: Rgba): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

/** Fills a region rectangle with colour(x, y) in region-local pixels; null leaves it transparent. */
function paint(left: number, top: number, width: number, height: number, colour: (x: number, y: number) => Rgba | null): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colour(x, y);
      if (c) put(left + x, top + y, c);
    }
  }
}

const OUTLINE: Rgba = [34, 24, 20, 255];
const border = (x: number, y: number, width: number, height: number, thickness: number) =>
  x < thickness || y < thickness || x >= width - thickness || y >= height - thickness;

// body/base: a wooden stand, 120 x 40.
paint(0, 0, 120, 40, (x, y) => (border(x, y, 120, 40, 3) ? OUTLINE : y < 12 ? [168, 112, 64, 255] : [132, 84, 46, 255]));

// body/torso: 60 x 120, skin with horizontal bands every 15 px so bending is visible.
paint(128, 0, 60, 120, (x, y) => (border(x, y, 60, 120, 3) ? OUTLINE : y % 15 < 4 ? [196, 132, 104, 255] : [232, 184, 146, 255]));

// body/head: a round face, 50 x 50, two eyes.
paint(192, 0, 50, 50, (x, y) => {
  const d = Math.hypot(x + 0.5 - 25, y + 0.5 - 25);
  if (d > 23) return null;
  if (d > 20) return OUTLINE;
  if (Math.hypot(x + 0.5 - 17, y + 0.5 - 22) < 3.5 || Math.hypot(x + 0.5 - 33, y + 0.5 - 22) < 3.5) return OUTLINE;
  return [240, 202, 162, 255];
});

// swag/tunic/torso: 60 x 120 on the torso's canvas; covers the lower 70 px (belt line at 50).
paint(0, 48, 60, 120, (x, y) => {
  if (y < 50) return null;
  if (border(x, y - 50, 60, 70, 3)) return OUTLINE;
  return x % 12 < 2 ? [44, 112, 56, 255] : [64, 152, 76, 255];
});

const out = new URL("../../fixtures/rigs/three-part.atlas.png", import.meta.url);
writeFileSync(out, PNG.sync.write(png));
console.log(`wrote ${out.pathname}`);
