/*
 * Atlas Animator: original implementation.
 *
 * PNG file input/output for the Node tools (pngjs). Images are straight-alpha RGBA.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import type { MutableImage, RgbaImage } from "./image.js";

export function decodePng(bytes: Uint8Array): MutableImage {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png, { colorType: 6 });
}

export function readPng(path: string): MutableImage {
  return decodePng(readFileSync(path));
}

export function writePng(path: string, image: RgbaImage): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(image));
}
