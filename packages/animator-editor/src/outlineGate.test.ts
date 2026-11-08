import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { edgeBreaks, erode, gatedSlots, gateFrame, type RgbaImage } from "./outlineGate.js";

const dir = new URL("./outlineGateFixtures/", import.meta.url);

/** Minimal PNG reader: 8-bit RGBA, non-interlaced (what the fixtures are). */
function readPng(file: string): RgbaImage {
  const b = readFileSync(new URL(file, dir));
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("fixture must be 8-bit RGBA, non-interlaced");
    } else if (type === "IDAT") idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = up;
      else if (f === 3) p = (a + up) >> 1;
      else if (f === 4) {
        const base = a + up - c;
        const pa = Math.abs(base - a);
        const pb = Math.abs(base - up);
        const pc = Math.abs(base - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = (v + p) & 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** The left half is the full frame, the right half the piece alone. */
function split(img: RgbaImage): { full: RgbaImage; piece: RgbaImage } {
  const w = img.width / 2;
  const half = (x0: number): RgbaImage => {
    const data = new Uint8Array(w * img.height * 4);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < w * 4; x++) data[y * w * 4 + x] = img.data[y * img.width * 4 + x0 * 4 + x]!;
    return { width: w, height: img.height, data };
  };
  return { full: half(0), piece: half(w) };
}

const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")) as { cases: Record<string, { breaks: number; longest: number; badPixels: number }> };

describe("outline continuity gate", () => {
  for (const [name, want] of Object.entries(expected.cases)) {
    it(`${name}: break count and longest break match the Python gate`, () => {
      const { full, piece } = split(readPng(`${name}.png`));
      const r = edgeBreaks(full, piece);
      expect(r.count).toBe(want.breaks);
      expect(r.longest).toBe(want.longest);
      expect(r.mask.reduce((s, v) => s + v, 0)).toBe(want.badPixels);
      expect(r.boxes.length).toBe(r.count);
    });
  }

  it("the fixtures cover a clean piece, several breaks and an occluded break", () => {
    expect(expected.cases["clean"]!.breaks).toBe(0);
    expect(expected.cases["gaps"]!.breaks).toBeGreaterThan(1);
    expect(expected.cases["occluded"]!.breaks).toBe(1);
  });

  it("a frame passes only when every piece is clean", () => {
    const clean = split(readPng("clean.png"));
    const gaps = split(readPng("gaps.png"));
    expect(gateFrame(clean.full, [{ name: "a", image: clean.piece }]).pass).toBe(true);
    const bad = gateFrame(gaps.full, [{ name: "a", image: gaps.piece }]);
    expect(bad.pass).toBe(false);
    expect(bad.pieces["a"]!.breaks).toBe(expected.cases["gaps"]!.breaks);
  });

  it("erosion treats outside the image as empty, like scipy", () => {
    const m = new Uint8Array(25).fill(1);
    expect(erode(m, 5, 5, 1).reduce((s, v) => s + v, 0)).toBe(9);
    expect(erode(m, 5, 5, 2).reduce((s, v) => s + v, 0)).toBe(1);
  });

  it("a larger maxBreak ignores shorter runs; mismatched sizes throw", () => {
    const { full, piece } = split(readPng("gaps.png"));
    expect(edgeBreaks(full, piece, { maxBreak: 100 }).count).toBe(0);
    expect(() => edgeBreaks({ width: 1, height: 1, data: [0, 0, 0, 0] }, piece)).toThrow();
  });
});

describe("gated slots on the real rigs", () => {
  const rigs = ["kit-body-cutout/kit-body-cutout.anim.json", "kit-body-front0/kit-body-front0.anim.json"];
  for (const rig of rigs) {
    for (const skin of ["chest.leather", "chest.jacket_b"]) {
      it(`${rig} ${skin}: only the sleeves and torso panel are gated, not the bare arm under the cuff`, () => {
        const doc = JSON.parse(readFileSync(new URL(`../../animator/rigs/${rig}`, import.meta.url), "utf8"));
        const all = Object.keys(doc.skins[skin].attachments);
        expect(all).toContain("skin_arm_near");
        expect(gatedSlots(all).sort()).toEqual(["shirt_sleeve_far", "shirt_sleeve_near", "shirt_torso"]);
      });
    }
  }
});
