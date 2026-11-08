/*
 * Atlas Animator: original implementation.
 *
 * Test helpers for the tool tests (not exported from the package): synthetic sprites, and the path
 * of the bundled sample body template.
 */
import { fileURLToPath } from "node:url";
import { createImage, type MutableImage } from "./image.js";

/** The bundled sample body template. Read-only. */
export const LIVE_TEMPLATE_PATH = fileURLToPath(
  new URL("../../fixtures/body/template7-clean.png", import.meta.url)
);

export type Shape = (x: number, y: number) => boolean;

export const disk = (cx: number, cy: number, r: number): Shape => (x, y) => Math.hypot(x - cx, y - cy) <= r;
export const ellipse = (cx: number, cy: number, rx: number, ry: number): Shape => (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry) <= 1;
export const box = (x0: number, y0: number, x1: number, y1: number): Shape => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
export function capsule(ax: number, ay: number, bx: number, by: number, r: number): Shape {
  return (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= r;
  };
}

/** Paints shapes (later ones on top) with a colour per shape; anything else is transparent. */
export function paintShapes(width: number, height: number, shapes: readonly [Shape, readonly [number, number, number]][]): MutableImage {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = shapes.length - 1; k >= 0; k--) {
        const [shape, colour] = shapes[k] as [Shape, readonly [number, number, number]];
        if (!shape(x + 0.5, y + 0.5)) continue;
        const p = (y * width + x) * 4;
        image.data[p] = colour[0];
        image.data[p + 1] = colour[1];
        image.data[p + 2] = colour[2];
        image.data[p + 3] = 255;
        break;
      }
    }
  }
  return image;
}

/**
 * A chunky A-pose figure on a 400 x 600 canvas: head, neck, torso, arms hanging out at about 27
 * degrees with fists, legs apart with feet. Landmarks used by the tests are in the comments.
 */
export function syntheticFigure(): MutableImage {
  const skin = [240, 190, 150] as const;
  const shirt = [220, 220, 220] as const;
  return paintShapes(400, 600, [
    [ellipse(200, 120, 90, 95), skin], // head: top 25, widest at 120
    [box(180, 205, 220, 240), skin], // neck: 40 wide, rows 205..240
    [box(140, 236, 260, 420), shirt], // torso: 120 wide down to 420
    [capsule(146, 262, 80, 385, 22), skin], // left arm (screen left)
    [capsule(254, 262, 320, 385, 22), skin], // right arm
    [disk(78, 395, 28), skin], // left fist
    [disk(322, 395, 28), skin], // right fist
    [capsule(170, 410, 165, 540, 24), skin], // left leg; gap between legs below the torso
    [capsule(230, 410, 235, 540, 24), skin], // right leg
    [ellipse(162, 555, 32, 20), skin], // left foot
    [ellipse(238, 555, 32, 20), skin] // right foot
  ]);
}
