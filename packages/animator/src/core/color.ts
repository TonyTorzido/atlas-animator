/*
 * Atlas Animator: original implementation.
 *
 * RGBA colours as four floats in 0..1, parsed from the document's "rrggbbaa" hex strings.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function createRgba(r = 1, g = 1, b = 1, a = 1): Rgba {
  return new RgbaColor(r, g, b, a);
}

/**
 * The runtime's colour objects. A class rather than an object literal: V8 shares one hidden-class
 * tree among all `{ r, g, b, a }` literals in the process (Pixi's colour parser makes them too),
 * and once anything widens a field there, every store of a fractional channel allocates a boxed
 * number. Class instances get their own hidden class, keep unboxed double fields, and so slot
 * colours can animate every frame without allocating (src/pixi/allocation.test.ts).
 */
class RgbaColor implements Rgba {
  // `declare`: no class-field initialisers (they would store `undefined` first and widen the fields).
  declare r: number;
  declare g: number;
  declare b: number;
  declare a: number;
  constructor(r: number, g: number, b: number, a: number) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
}

/** Parses "rrggbbaa" into `out`. The schema guarantees the format; anything else reads as white. */
export function parseRgba(hex: string, out: Rgba = createRgba()): Rgba {
  const value = /^[0-9a-fA-F]{8}$/.test(hex) ? Number.parseInt(hex, 16) >>> 0 : 0xffffffff;
  out.r = ((value >>> 24) & 0xff) / 255;
  out.g = ((value >>> 16) & 0xff) / 255;
  out.b = ((value >>> 8) & 0xff) / 255;
  out.a = (value & 0xff) / 255;
  return out;
}

export function copyRgba(from: Readonly<Rgba>, to: Rgba): Rgba {
  to.r = from.r;
  to.g = from.g;
  to.b = from.b;
  to.a = from.a;
  return to;
}

/** 0xRRGGBB of three 0..1 channels (clamped), the form Pixi's `tint` takes. */
export function rgb24(r: number, g: number, b: number): number {
  return (channelByte(r) << 16) | (channelByte(g) << 8) | channelByte(b);
}

/** 0xRRGGBB of a colour (alpha dropped). */
export function rgbaToRgb24(color: Readonly<Rgba>): number {
  return rgb24(color.r, color.g, color.b);
}

function channelByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}
