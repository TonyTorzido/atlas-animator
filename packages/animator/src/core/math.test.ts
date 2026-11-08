import { describe, expect, it } from "vitest";
import {
  clampRotationToLimits,
  composeLinear,
  createAffine,
  decomposeLinear,
  inverseTransformPoint,
  multiplyLinear,
  transformPoint,
  wrapDegrees,
  type LinearDecomposition
} from "./math.js";
import { COS30, expectAffine, random } from "./testHelpers.js";

const decomposition = (): LinearDecomposition => ({ rotation: 0, scaleX: 0, scaleY: 0, shearX: 0, shearY: 0 });

describe("wrapDegrees", () => {
  it("maps onto (-180, 180]", () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(540)).toBe(180);
    expect(wrapDegrees(-721)).toBe(-1);
  });
});

describe("composeLinear", () => {
  it("is a clockwise (y-down) rotation scaled per axis", () => {
    // R(30) * diag(2, 3) = [2cos30, -3sin30; 2sin30, 3cos30]
    expectAffine(composeLinear(30, 2, 3, 0, 0, createAffine()), { a: 2 * COS30, b: -1.5, c: 1, d: 3 * COS30 });
  });

  it("turns each axis by its own shear", () => {
    // X axis at 0 + 0, Y axis at 0 + 90 + 30 = 120 degrees.
    expectAffine(composeLinear(0, 1, 1, 0, 30, createAffine()), { a: 1, c: 0, b: -0.5, d: COS30 });
    // X axis at 20 + 40 = 60 degrees, length 2.
    expectAffine(composeLinear(20, 2, 1, 40, 0, createAffine()), { a: 1, c: 2 * COS30 });
  });

  it("multiplies linear parts in order", () => {
    const m = composeLinear(90, 1, 1, 0, 0, createAffine()); // [0 -1; 1 0]
    const n = composeLinear(0, 2, 3, 0, 0, createAffine()); // diag(2, 3)
    expectAffine(multiplyLinear(m, n, createAffine()), { a: 0, b: -3, c: 2, d: 0 });
    expectAffine(multiplyLinear(n, m, createAffine()), { a: 0, b: -2, c: 3, d: 0 });
  });
});

describe("decomposeLinear", () => {
  it("recovers canonical inputs exactly: decompose(compose(x)) == x", () => {
    const next = random(1);
    for (let i = 0; i < 500; i++) {
      const input = {
        rotation: next(-179.9, 180),
        scaleX: next(0.05, 4),
        scaleY: (next(0, 1) < 0.5 ? -1 : 1) * next(0.05, 4),
        shearX: 0,
        shearY: next(-80, 80)
      };
      const m = composeLinear(input.rotation, input.scaleX, input.scaleY, 0, input.shearY, createAffine());
      const out = decomposeLinear(m.a, m.b, m.c, m.d, decomposition());
      for (const key of ["rotation", "scaleX", "scaleY", "shearX", "shearY"] as const) {
        expect(out[key], `${key} (case ${i})`).toBeCloseTo(input[key], 9);
      }
    }
  });

  it("reproduces any matrix: compose(decompose(m)) == m", () => {
    const next = random(2);
    for (let i = 0; i < 500; i++) {
      const m = { a: next(-3, 3), b: next(-3, 3), c: next(-3, 3), d: next(-3, 3), x: 0, y: 0 };
      const s = decomposeLinear(m.a, m.b, m.c, m.d, decomposition());
      expect(s.shearX).toBe(0);
      expect(s.scaleX).toBeGreaterThanOrEqual(0);
      expectAffine(composeLinear(s.rotation, s.scaleX, s.scaleY, s.shearX, s.shearY, createAffine()), m, 9);
    }
  });

  it("puts a reflection into scaleY", () => {
    // Mirror on X: diag(-1, 1) is a 180 degree turn with scaleY = -1.
    const s = decomposeLinear(-1, 0, 0, 1, decomposition());
    expect(s.rotation).toBeCloseTo(180, 12);
    expect(s.scaleX).toBeCloseTo(1, 12);
    expect(s.scaleY).toBeCloseTo(-1, 12);
    expect(s.shearY).toBeCloseTo(0, 12);
  });

  it("reads orientation from the Y axis when X has collapsed", () => {
    // X axis zero, Y axis pointing along world -x: rotation = 180 - 90 = 90.
    const s = decomposeLinear(0, -2, 0, 0, decomposition());
    expect(s).toEqual({ rotation: 90, scaleX: 0, scaleY: 2, shearX: 0, shearY: 0 });
  });
});

describe("points", () => {
  it("transforms and inverse-transforms", () => {
    const m = composeLinear(90, 2, 1, 0, 0, createAffine());
    m.x = 10;
    m.y = 20;
    // (3, 4) -> R(90) diag(2,1) (3,4) + (10, 20) = (-4, 6) + (10, 20)
    const p = transformPoint(m, 3, 4, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(6, 12);
    expect(p.y).toBeCloseTo(26, 12);
    const back = { x: 0, y: 0 };
    expect(inverseTransformPoint(m, p.x, p.y, back)).toBe(true);
    expect(back.x).toBeCloseTo(3, 12);
    expect(back.y).toBeCloseTo(4, 12);
  });

  it("refuses to invert a singular matrix", () => {
    const out = { x: 7, y: 7 };
    expect(inverseTransformPoint({ a: 1, b: 2, c: 2, d: 4, x: 0, y: 0 }, 1, 1, out)).toBe(false);
    expect(out).toEqual({ x: 7, y: 7 });
  });
});

describe("clampRotationToLimits", () => {
  // Setup rotation 10, may turn from -20 to +40 relative to it: absolute range [-10, 50].
  const clamp = (rotation: number) => clampRotationToLimits(rotation, 10, -20, 40);

  it("leaves rotations inside the limits untouched", () => {
    expect(clamp(10)).toBe(10);
    expect(clamp(-10)).toBe(-10);
    expect(clamp(50)).toBe(50);
    expect(clamp(33.3)).toBe(33.3);
  });

  it("clamps to the nearer bound", () => {
    expect(clamp(100)).toBe(50);
    expect(clamp(-30)).toBe(-10);
  });

  it("compares angles, not numbers: a full turn away is the same pose", () => {
    // A full turn away is still inside the limits, so the value is kept as given.
    expect(clamp(370)).toBe(370);
    expect(clamp(-345)).toBe(-345);
    // delta 200 = -160: 140 degrees from the min bound, 160 from the max bound.
    expect(clamp(210)).toBe(-10);
    // delta 190 = -170: 150 from min, 150 from max... ties go to min.
    expect(clamp(200)).toBe(-10);
    // delta -150: 130 from min, 170 from max.
    expect(clamp(-140)).toBe(-10);
    // delta 120: 80 from max, 140 from min.
    expect(clamp(130)).toBe(50);
  });

  it("handles ranges that cross +-180 relative to setup", () => {
    // Allowed deltas [100, 260] (i.e. 100..180 and -180..-100).
    expect(clampRotationToLimits(-150, 0, 100, 260)).toBe(-150);
    expect(clampRotationToLimits(210, 0, 100, 260)).toBe(210);
    expect(clampRotationToLimits(-90, 0, 100, 260)).toBe(260);
    expect(clampRotationToLimits(90, 0, 100, 260)).toBe(100);
  });
});
