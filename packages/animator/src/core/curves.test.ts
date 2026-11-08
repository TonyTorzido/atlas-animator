import { describe, expect, it } from "vitest";
import { CurveSet, curveForChannel, evaluateCurve } from "./curves.js";
import { random } from "./testHelpers.js";

/** Reference: y(x) of the unit cubic Bezier by bisection on x(s) to machine precision. */
function reference(cx1: number, cy1: number, cx2: number, cy2: number, x: number): number {
  const at = (c1: number, c2: number, s: number) => 3 * (1 - s) * (1 - s) * s * c1 + 3 * (1 - s) * s * s * c2 + s * s * s;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i++) {
    const middle = (low + high) / 2;
    if (at(cx1, cx2, middle) < x) low = middle;
    else high = middle;
  }
  return at(cy1, cy2, (low + high) / 2);
}

describe("curves", () => {
  it("a symmetric Bezier is exactly 0.5 at u = 0.5", () => {
    for (const spec of [
      [0.25, 0.1, 0.75, 0.9],
      [0.42, 0, 0.58, 1],
      [0.9, -0.3, 0.1, 1.3]
    ] as const) {
      expect(evaluateCurve([...spec], 0.5)).toBeCloseTo(0.5, 12);
    }
  });

  it("linear is the identity and stepped holds at 0 until the next key", () => {
    for (const u of [0, 0.2, 0.5, 0.999]) {
      expect(evaluateCurve("linear", u)).toBeCloseTo(u, 15);
      expect(evaluateCurve("stepped", u)).toBe(0);
    }
  });

  it("a Bezier with its controls on the diagonal is linear", () => {
    for (const u of [0.1, 0.33, 0.8]) expect(evaluateCurve([0.3, 0.3, 0.7, 0.7], u)).toBeCloseTo(u, 15);
  });

  it("starts at 0 and ends at 1, overshoot included", () => {
    expect(evaluateCurve([0.3, 2, 0.7, -1], 0)).toBe(0);
    expect(evaluateCurve([0.3, 2, 0.7, -1], 1)).toBe(1);
  });

  it("matches the exact curve within 1e-6 for random control points", () => {
    const next = random(7);
    let worst = 0;
    for (let trial = 0; trial < 300; trial++) {
      const cx1 = next(0, 1);
      const cx2 = next(0, 1);
      const cy1 = next(-0.5, 1.5);
      const cy2 = next(-0.5, 1.5);
      for (let i = 1; i < 40; i++) {
        const u = i / 40;
        worst = Math.max(worst, Math.abs(evaluateCurve([cx1, cy1, cx2, cy2], u) - reference(cx1, cy1, cx2, cy2, u)));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("is exact enough for the common eases (CSS ease-in-out within 1e-5)", () => {
    for (let i = 1; i < 100; i++) {
      const u = i / 100;
      expect(Math.abs(evaluateCurve([0.42, 0, 0.58, 1], u) - reference(0.42, 0, 0.58, 1, u))).toBeLessThan(1e-5);
    }
  });

  it("a curve set holds a curve per key and channel", () => {
    const set = new CurveSet(2, 2);
    set.set(0, 0, "stepped");
    set.set(0, 1, [0.25, 0.1, 0.75, 0.9]);
    set.set(1, 0, "linear");
    set.set(1, 1, "linear");
    expect(set.fraction(0, 0, 0.7)).toBe(0);
    expect(set.fraction(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(set.fraction(1, 0, 0.7)).toBeCloseTo(0.7, 15);
  });

  it("resolves per-channel curve objects (missing channels are linear)", () => {
    expect(curveForChannel("stepped", "x")).toBe("stepped");
    expect(curveForChannel({ y: "stepped" }, "y")).toBe("stepped");
    expect(curveForChannel({ y: "stepped" }, "x")).toBe("linear");
    expect(curveForChannel([0.1, 0.2, 0.3, 0.4], "x")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});
