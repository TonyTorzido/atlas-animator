import { describe, expect, it } from "vitest";
import { applyJoin, type ContourJoin } from "./contours.js";

/*
 * Contour joins are continuous: the joined centrelines move by a bounded amount
 * for a small move of either input, through the overlap / bridge / hairpin transitions. Slow
 * forward and reverse sweeps measure the largest move of the joined strokes per input step (the
 * symmetric Hausdorff distance of each centreline: vertices may slide along a line).
 */

const JOIN: ContourJoin = { other: 1, isA: true, endA: 1, endB: 0, reach: 10, fillet: 5, width: 10, otherSlot: "b" };

/** A: along +x ending at the origin (5 px spacing); B: from `start`, heading along `dir`, 2 px spacing. */
function lines(start: [number, number], angle: number, bend = 0): { a: Float32Array; b: Float32Array } {
  const a = new Float32Array(24);
  for (let i = 0; i < 12; i++) a[i * 2] = -55 + i * 5;
  const b = new Float32Array(60);
  let x = start[0];
  let y = start[1];
  let t = angle;
  for (let j = 0; j < 30; j++) {
    b[j * 2] = x;
    b[j * 2 + 1] = y;
    x += 2 * Math.cos(t);
    y += 2 * Math.sin(t);
    t += bend;
  }
  return { a, b };
}

function joined(a: Float32Array, b: Float32Array): [Float32Array, Float32Array] {
  const outA = Float32Array.from(a);
  const outB = Float32Array.from(b);
  applyJoin(outA, true, a, 12, b, 30, JOIN);
  applyJoin(outB, false, a, 12, b, 30, { ...JOIN, isA: false });
  return [outA, outB];
}

/** Distance from (x, y) to a polyline. */
function toLine(x: number, y: number, p: Float32Array): number {
  let d = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const x0 = p[i - 2] as number;
    const y0 = p[i - 1] as number;
    const dx = (p[i] as number) - x0;
    const dy = (p[i + 1] as number) - y0;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(x - x0 - dx * u, y - y0 - dy * u));
  }
  return d;
}

/** Symmetric Hausdorff distance between two centrelines (vertices and segment midpoints): the stroke moved by this much. */
function moved(p: Float32Array, q: Float32Array): number {
  let d = 0;
  for (const [s, t] of [[p, q], [q, p]] as const) {
    for (let i = 0; i < s.length; i += 2) {
      d = Math.max(d, toLine(s[i] as number, s[i + 1] as number, t));
      if (i + 2 < s.length) d = Math.max(d, toLine(((s[i] as number) + (s[i + 2] as number)) / 2, ((s[i + 1] as number) + (s[i + 3] as number)) / 2, t));
    }
  }
  return d;
}

function maxStep(sweep: (t: number) => { a: Float32Array; b: Float32Array }, from: number, to: number, steps: number): { step: number; at: number } {
  let prev: [Float32Array, Float32Array] | null = null;
  let worst = { step: 0, at: from };
  for (let k = 0; k <= steps; k++) {
    const t = from + ((to - from) * k) / steps;
    const { a, b } = sweep(t);
    const cur = joined(a, b);
    if (prev) {
      const d = Math.max(moved(cur[0], prev[0]), moved(cur[1], prev[1]));
      if (d > worst.step) worst = { step: d, at: t };
    }
    prev = cur;
  }
  return worst;
}

describe("contour joins: continuous in their inputs", () => {
  it("the review repro: one B point across the old overlap threshold moves the output by about as much", () => {
    const at = (y: number) => {
      const { a, b } = lines([0, 0], 0.5 * Math.PI);
      b[5 * 2 + 1] = y; // one point of B (x = 0) at distance y from A's extension
      b[5 * 2] = 4;
      return joined(a, b);
    };
    const p = at(9.99);
    const q = at(10.01);
    expect(Math.max(moved(p[0], q[0]), moved(p[1], q[1]))).toBeLessThan(0.2);
  });

  it("sweeping B's offset across A (overlap -> bridge) and back", () => {
    const sweep = (y: number) => lines([2, y], 0);
    for (const [from, to] of [[-20, 20], [20, -20]] as const) expect(maxStep(sweep, from, to, 4000).step).toBeLessThan(0.25);
  });

  it("sweeping B's start along A's line (crossing -> gap -> hairpin) and back", () => {
    const sweep = (x: number) => lines([x, -8], 0.6 * Math.PI, -0.05);
    for (const [from, to] of [[-30, 30], [30, -30]] as const) expect(maxStep(sweep, from, to, 6000).step).toBeLessThan(0.25);
  });

  it("sweeping B's direction a full turn", () => {
    const sweep = (t: number) => lines([3, 6], t, 0.04);
    expect(maxStep(sweep, 0, 2 * Math.PI, 6000).step).toBeLessThan(0.25);
  });
});
