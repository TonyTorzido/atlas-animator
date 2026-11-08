import { describe, expect, it } from "vitest";
import { dataCodewords, dataWords, encodeQr, interleave, MAX_VERSION, qrSvg, rawDataModules, rsDivisor, rsRemainder } from "./phoneQr.js";

describe("phoneQr", () => {
  it("has the standard level-M data capacities for versions 1-10", () => {
    expect(Array.from({ length: MAX_VERSION }, (_, i) => dataCodewords(i + 1))).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
    expect(rawDataModules(1)).toBe(208);
    expect(rawDataModules(7)).toBe(1568);
  });

  it("matches the Reed-Solomon worked example (HELLO WORLD, 1-M)", () => {
    // The widely published 1-M example: data 32 91 11 120 209 114 220 77 67 64 236 17 236 17 236 17 -> ecc 196 35 39 119 235 215 231 226 93 23
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    expect(interleave(data, 1)).toEqual([...data, 196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("pads data to the version capacity", () => {
    const words = dataWords([...new TextEncoder().encode("http://192.168.1.20:5290/phone/abc/")], 4);
    expect(words).toHaveLength(64);
  });

  it("draws the three finder patterns, timing lines and a stable size", () => {
    const qr = encodeQr("http://192.168.100.100:5290/phone/0123456789abcdef0123456789abcdef/");
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.version).toBeGreaterThanOrEqual(4);
    const dark = (x: number, y: number) => qr.modules[y]![x]!;
    for (const [ox, oy] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]] as const) {
      expect(dark(ox, oy)).toBe(true);
      expect(dark(ox + 3, oy + 3)).toBe(true);
      expect(dark(ox + 1, oy + 1)).toBe(false);
      expect(dark(ox + 6, oy + 6)).toBe(true);
    }
    for (let i = 8; i < qr.size - 8; i++) expect(dark(i, 6)).toBe(i % 2 === 0);
    expect(qrSvg(qr)).toContain("<svg");
  });

  it("refuses text that does not fit", () => {
    expect(() => encodeQr("x".repeat(300))).toThrow();
  });
});
