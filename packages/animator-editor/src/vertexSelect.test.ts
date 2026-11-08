import { describe, expect, it } from "vitest";
import { adjacency, boxSelect, clickSelect, growSelection, lassoSelect, pickVertex, selectAll, shrinkSelection, snapPoint, verticesInLasso } from "./vertexSelect.js";

// 3x3 lattice, vertex id = row * 3 + col, spacing 10
const points = Array.from({ length: 9 }, (_, i) => [(i % 3) * 10, Math.floor(i / 3) * 10]).flat();
const triangles: number[] = [];
for (let r = 0; r < 2; r++) {
  for (let c = 0; c < 2; c++) {
    const a = r * 3 + c;
    triangles.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
  }
}

describe("click select", () => {
  it("replaces, adds with Shift, toggles with Ctrl, clears on empty space", () => {
    let s = clickSelect(new Set(), 1);
    expect([...s]).toEqual([1]);
    s = clickSelect(s, 2);
    expect([...s]).toEqual([2]);
    s = clickSelect(s, 4, { shift: true });
    expect([...s].sort()).toEqual([2, 4]);
    s = clickSelect(s, 2, { ctrl: true });
    expect([...s]).toEqual([4]);
    expect(clickSelect(s, -1, { shift: true }).size).toBe(1);
    expect(clickSelect(s, -1).size).toBe(0);
  });
  it("picks the nearest vertex in reach", () => {
    expect(pickVertex(points, 11, 9, 5)).toBe(4);
    expect(pickVertex(points, 15, 15, 3)).toBe(-1);
    expect(pickVertex(points, 10, 10, 5, new Set([4]))).toBe(-1);
  });
});

describe("box and lasso", () => {
  it("box selects inside inclusive and honours modifiers", () => {
    expect([...boxSelect(new Set(), points, { x0: 12, y0: -1, x1: -1, y1: 12 })].sort()).toEqual([0, 1, 3, 4]);
    expect([...boxSelect(new Set([8]), points, { x0: 0, y0: 0, x1: 0, y1: 0 }, { shift: true })].sort()).toEqual([0, 8]);
    expect([...boxSelect(new Set([0, 8]), points, { x0: 0, y0: 0, x1: 0, y1: 0 }, { ctrl: true })]).toEqual([8]);
  });

  it("lasso selects exactly the points inside a concave polygon", () => {
    // An L: x -1..12 for y -1..12, plus x -1..5 down to y 22. Covers 0,1,3,4 and 6 (0,20); not 7 (10,20).
    const poly = [{ x: -1, y: -1 }, { x: 12, y: -1 }, { x: 12, y: 12 }, { x: 5, y: 12 }, { x: 5, y: 22 }, { x: -1, y: 22 }];
    expect(verticesInLasso(points, poly).sort()).toEqual([0, 1, 3, 4, 6]);
    expect([...lassoSelect(new Set([8]), points, poly, { shift: true })].sort()).toEqual([0, 1, 3, 4, 6, 8]);
    expect(verticesInLasso(points, [{ x: 0, y: 0 }, { x: 5, y: 5 }])).toEqual([]);
  });

  it("select all", () => {
    expect(selectAll(points).size).toBe(9);
  });
});

describe("grow and shrink", () => {
  const nb = adjacency(9, triangles);
  it("grows one ring along edges", () => {
    expect([...growSelection(new Set([0]), nb)].sort()).toEqual([0, 1, 3]);
    expect(growSelection(new Set([4]), nb).size).toBe(7);
  });
  it("shrinks away selected vertices touching unselected ones", () => {
    expect([...shrinkSelection(selectAll(points), nb)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shrinkSelection(new Set([0, 1, 3, 4]), nb)]).toEqual([0]);
    expect([...shrinkSelection(new Set([0, 1, 2, 3, 4, 5, 6]), nb)].sort()).toEqual([0, 1, 2, 3]);
  });
  it("extra constraint edges count as neighbours", () => {
    expect(adjacency(9, triangles, [[0, 8]])[0]!.has(8)).toBe(true);
  });
});

describe("snapping", () => {
  const ctx = { points, hull: 4, outline: [[{ x: -5, y: -5 }, { x: 40, y: -5 }, { x: 40, y: 40 }, { x: -5, y: 40 }]], radius: 3 };
  it("snaps to a vertex first, then hull edge, outline, then the 1 px grid", () => {
    expect(snapPoint(10.8, 0.9, ctx)).toMatchObject({ kind: "vertex", vertex: 1, x: 10, y: 0 });
    const hullEdge = snapPoint(5, 1.5, ctx);
    expect(hullEdge.kind).toBe("hull");
    expect(hullEdge.y).toBeCloseTo(0);
    expect(snapPoint(41.7, 20.2, ctx)).toMatchObject({ kind: "outline", x: 40 });
    expect(snapPoint(25.4, 15.6, ctx)).toMatchObject({ kind: "grid", x: 25, y: 16 });
  });
  it("Ctrl suspends snapping and dragged vertices ignore themselves", () => {
    expect(snapPoint(10.8, 0.9, { ...ctx, ctrl: true })).toEqual({ x: 10.8, y: 0.9, kind: "none" });
    expect(snapPoint(10.2, 0.2, { ...ctx, ignore: new Set([1]) }).kind).not.toBe("vertex");
  });
});
