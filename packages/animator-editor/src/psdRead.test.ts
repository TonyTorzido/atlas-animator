import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groundOf, layoutParts, opaqueBounds, partName, psdCanvas, psdOffset, suggestRigId } from "./newRigModel.js";
import { readPsd } from "./psdRead.js";

// Optional local art kit: set ATLAS_RIG_PRACTICE_KIT to its folder (defaults to ~/Desktop/rig-practice-kit); the test skips without it.
const KIT = join(process.env.ATLAS_RIG_PRACTICE_KIT ?? join(homedir(), "Desktop", "rig-practice-kit"), "kit-body-cutout_layers.psd");

describe("psd reader", () => {
  it.skipIf(!existsSync(KIT))("reads the practice kit: 23 layers, bottom first, at their canvas positions", () => {
    const psd = readPsd(readFileSync(KIT));
    expect([psd.width, psd.height, psd.layers.length]).toEqual([1086, 1448, 23]);
    expect(psd.layers[0]!.name).toBe("00_skin_foot_near");
    expect(psd.layers[22]!.name).toBe("22_skin_hand_near");
    const foot = psd.layers[0]!;
    expect([foot.left, foot.top, foot.width, foot.height]).toEqual([366, 1116, 147, 127]);
    const ground = groundOf(psd.layers)!;
    expect(ground.y).toBeGreaterThan(1200);
    expect(ground.y).toBeLessThan(1260);
    expect(Math.abs(ground.x - 543)).toBeLessThan(40);
    const canvas = psdCanvas(psd.width, psd.height, ground);
    expect(psdOffset(foot, canvas)).toEqual({ x: 366 - ground.x, y: 1116 - ground.y });
    expect(foot.rgba.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });
  it("rejects non-PSD data", () => {
    expect(() => readPsd(new Uint8Array(40))).toThrow(/not a PSD/);
  });
});

describe("new rig model", () => {
  it("names parts without the order prefix", () => {
    expect(partName("04_pants_leg_far.png")).toBe("pants_leg_far");
    expect(suggestRigId("Test Blob!")).toBe("test-blob");
  });
  it("lays unpositioned parts in wrapped shelves standing on the ground", () => {
    const sizes = Array.from({ length: 6 }, () => ({ width: 300, height: 100 }));
    const at = layoutParts(sizes);
    expect(new Set(at.map((a) => a.y)).size).toBe(3);
    expect(Math.max(...at.map((a, i) => a.y + sizes[i]!.height))).toBe(0);
    for (const a of at) expect(Math.abs(a.x)).toBeLessThanOrEqual(450);
  });
});

describe("ground point", () => {
  const px = (w: number, h: number, rows: [number, number][]) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (const [from, to] of rows) for (let y = from; y < to; y++) for (let x = 0; x < w; x++) a[(y * w + x) * 4 + 3] = 255;
    return a;
  };
  it("finds the opaque bounds and the ground under the lowest opaque pixel", () => {
    const a = px(10, 10, [[2, 6]]);
    expect(opaqueBounds(a, 10, 10)).toEqual({ left: 0, top: 2, right: 10, bottom: 6 });
    const g = groundOf([{ left: 100, top: 50, width: 10, height: 10, rgba: a }, { left: 120, top: 80, width: 10, height: 10, rgba: px(10, 10, [[0, 4]]) }]);
    expect(g).toEqual({ x: 115, y: 84 });
  });
  it("stands loose parts on their lowest opaque pixel", () => {
    const at = layoutParts([{ width: 20, height: 40, opaqueBottom: 30 }, { width: 20, height: 40 }]);
    expect(at[1]!.y + 40).toBe(0);
    expect(at[0]!.y + 30).toBe(0);
  });
});
