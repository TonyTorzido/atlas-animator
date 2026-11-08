/*
 * Plan: the
 * reproductions of the constraint, pruning, ambiguity and clamp findings, each failing on c658bce33.
 */
import { describe, expect, it } from "vitest";
import * as weightsModule from "./autoWeights.js";
import { autoWeightsTree, smoothWeights, type Influence, type WeightTree } from "./autoWeights.js";

/** A 9 x 9 grid (81 vertices) over 0..80, two triangles per cell. */
function grid(size = 9, step = 10, x0 = 0, y0 = 0) {
  const points: number[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) points.push(x0 + x * step, y0 + y * step);
  const triangles: number[] = [];
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const a = y * size + x;
      triangles.push(a, a + 1, a + size, a + 1, a + size + 1, a + size);
    }
  }
  return { points, triangles };
}

const bone = (name: string, parent: number, x0: number, y0: number, x1: number, y1: number, radius: number) => ({ name, parent, start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, radius });

/** A three-bone hub: a trunk and two children leaving its end at (40, 40). */
const hubTree = (): WeightTree => ({
  bones: [bone("hub", -1, 0, 40, 40, 40, 15), bone("leg_a", 0, 40, 40, 80, 10, 12), bone("leg_b", 0, 40, 40, 80, 70, 12)]
});

const has = (list: readonly Influence[], b: number) => list.some((inf) => inf.bone === b && inf.weight > 0);

describe("auto-weights constraints ()", () => {
  it("an excluded hub gets zero weight on an 81-vertex grid (parent insertion respects the domain)", () => {
    const mesh = grid();
    expect(mesh.points.length / 2).toBe(81);
    const result = autoWeightsTree(mesh, hubTree(), { allow: (k) => k !== 0, smooth: 0 });
    expect(result.weights.filter((list) => has(list, 0)).length).toBe(0);
    const smoothed = autoWeightsTree(mesh, hubTree(), { allow: (k) => k !== 0 });
    expect(smoothed.weights.filter((list) => has(list, 0)).length).toBe(0);
  });

  it("rejects an empty domain and honours an ineligible anchor", () => {
    expect(() => autoWeightsTree(grid(), hubTree(), { allow: () => false })).toThrow(/allows none/);
    const anchored: WeightTree = { ...hubTree(), anchor: { bone: { name: "body", start: { x: -40, y: 40 }, end: { x: 0, y: 40 }, radius: 15 }, cut: { a: { x: 0, y: 0 }, b: { x: 0, y: 80 } } } };
    const eligible = autoWeightsTree(grid(), anchored, { allow: () => true });
    expect(eligible.weights.some((list) => has(list, 0))).toBe(true);
    const ineligible = autoWeightsTree(grid(), anchored, { allow: () => true, allowAnchor: false });
    expect(ineligible.weights.filter((list) => has(list, 0)).length).toBe(0);
  });

  it("no vertex carries both children of an overlap connection (candidate-versus-candidate)", () => {
    for (const smooth of [0, 1, 2]) {
      const result = autoWeightsTree(grid(), hubTree(), { connections: [{ a: [1], b: [2], kind: "overlap" }], smooth });
      expect(result.weights.filter((list) => has(list, 1) && has(list, 2)).length).toBe(0);
    }
  });

  it("smoothing never imports an influence the vertex may not carry", () => {
    const neighbours = [new Set([1]), new Set([0])];
    const weights: Influence[][] = [[{ bone: 0, weight: 1 }], [{ bone: 1, weight: 1 }]];
    const out = smoothWeights(weights, neighbours, () => true, 2, (vertex, b) => b === vertex);
    expect(out[0]?.map((inf) => inf.bone)).toEqual([0]);
    expect(out[1]?.map((inf) => inf.bone)).toEqual([1]);
  });
});

describe("influence-cap pruning ()", () => {
  const { pruneByName, PruneStats } = weightsModule as unknown as {
    pruneByName: (w: Influence[][], bones: { name: string }[], max: number, min: number, stats?: unknown) => Influence[][];
    PruneStats: new (bones: unknown[], points: ArrayLike<number>, limitPx: number) => { summary(): { maxDiscarded: number; maxErrorPx: number; overVertices: number[] } };
  };
  const names = ["e", "d", "c", "b", "a"].map((name) => ({ name, start: { x: 0, y: 0 }, end: { x: 0, y: 10 }, radius: 5 }));

  it("never collapses a tie at the cap into one rigid weight", () => {
    const five = names.map((_, b) => ({ bone: b, weight: 0.2 }));
    const kept = (pruneByName([five], names, 4, 0.02)[0] ?? []) as Influence[];
    expect(kept.length).toBe(4);
    // Stable rule: by weight, then bone name ("a".."d" kept, "e" = bone 0 dropped).
    expect(kept.map((inf) => names[inf.bone]?.name).sort()).toEqual(["a", "b", "c", "d"]);
    for (const inf of kept) expect(inf.weight).toBeCloseTo(0.25, 5);
    const skewed = [0.4, 0.15, 0.15, 0.15, 0.15].map((weight, b) => ({ bone: b, weight }));
    const out = (pruneByName([skewed], names, 4, 0.02)[0] ?? []) as Influence[];
    expect(out.length).toBe(4);
    expect(out.find((inf) => inf.bone === 0)?.weight).toBeCloseTo(0.4 / 0.85, 4);
  });

  it("normalises before the relative threshold and measures dropped mass and posed error", () => {
    // Unnormalised input (sum 10): 0.15 is 1.5% of the total, under the 2% threshold.
    const list = [{ bone: 0, weight: 9.85 }, { bone: 1, weight: 0.15 }];
    expect((pruneByName([list], names, 4, 0.02)[0] ?? []).length).toBe(1);
    const stats = new PruneStats(names, [10, 0], 1);
    pruneByName([names.map((_, b) => ({ bone: b, weight: 0.2 }))], names, 4, 0.02, stats);
    const summary = stats.summary();
    expect(summary.maxDiscarded).toBeCloseTo(0.2, 9);
    expect(summary.maxErrorPx).toBeGreaterThan(1);
    expect(summary.overVertices).toEqual([0]);
  });

  it("a hub over the cap is reported, and rejected under hubPolicy reject", () => {
    // Five legs leaving one point: hub vertices blend six bones, more than four can carry.
    const tree: WeightTree = {
      bones: [bone("core", -1, 0, 40, 40, 40, 14), ...[-60, -30, 0, 30, 60].map((deg, k) => bone(`leg_${k}`, 0, 40, 40, 40 + 40 * Math.cos((deg * Math.PI) / 180), 40 + 40 * Math.sin((deg * Math.PI) / 180), 14))]
    };
    const result = autoWeightsTree(grid(), tree, { hubErrorPx: 0.25 });
    expect(result.diagnostics.pruning.maxDiscarded).toBeGreaterThan(0);
    expect(result.diagnostics.pruning.overVertices.length).toBeGreaterThan(0);
    expect(() => autoWeightsTree(grid(), tree, { hubErrorPx: 0.25, hubPolicy: "reject" })).toThrow(/need more than 4 influences/);
  });
});

describe("weight diagnostics ()", () => {
  it("an adjacent runner-up does not hide a non-adjacent competitor; ambiguities name vertex and top-3 bones", () => {
    // Owner `a` (3.4 px), runner-up its own child `a2` (3.54, adjacent), then sibling branch `b` (3.6, not adjacent).
    const tree: WeightTree = {
      bones: [bone("body", -1, 0, 0, 100, 0, 5), bone("a", 0, 100, 0, 100, 50, 5), bone("a2", 1, 100, 50, 100, 100, 5), bone("b", 0, 107, 0, 107, 100, 5)]
    };
    const mesh = grid(3, 1, 102.4, 48);
    const result = autoWeightsTree(mesh, tree);
    const centre = result.diagnostics.ambiguities.find((a) => a.vertex === 4);
    expect(centre?.owner).toBe(1);
    expect(centre?.competitors.map((c) => c.bone)).toEqual([3]);
    expect(result.ambiguous).toBe(result.diagnostics.ambiguities.length);
  });

  it("reports heat weights outside [0, 1] before the clamp, with the magnitude", () => {
    // A jittered grid (obtuse triangles: negative cotangent couplings) breaks the discrete maximum
    // principle; seed 3, jitter 6 px overshoots by about 0.27.
    let seed = 3;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const mesh = grid();
    const jitter = (k: number) => (k > 0 && k < 8 ? (rand() - 0.5) * 12 : 0);
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        mesh.points[(y * 9 + x) * 2] = x * 10 + jitter(x);
        mesh.points[(y * 9 + x) * 2 + 1] = y * 10 + jitter(y);
      }
    }
    const result = autoWeightsTree(mesh, hubTree(), { allow: () => true, smooth: 0 });
    expect(result.diagnostics.clamped.vertices.length).toBeGreaterThan(0);
    expect(result.diagnostics.clamped.maxMagnitude).toBeGreaterThan(0.1);
  });
});
