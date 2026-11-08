import { describe, expect, it } from "vitest";
import { autoMesh } from "./autoMesh.js";
import { autoWeights, autoWeightsTree, checkWeightTree, pruneWeights, weldWeights, zoneWeights, type Influence, type WeightChain, type WeightTree } from "./autoWeights.js";
import { outlineImage } from "./outline.js";
import { capsule, paintShapes } from "./testFigures.js";

// A straight limb along x: 20..220, radius 30, three bones 0-80, 80-160, 160-220 hung from an
// anchor through a cut at x = 20.
function limb() {
  // Cut square at x = 20 (where the part meets the body), rounded at the hand end.
  const image = paintShapes(260, 100, [[(x, y) => (x >= 20 && x <= 210 && Math.abs(y - 50) <= 30) || capsule(210, 50, 210, 50, 30)(x, y), [200, 150, 120]]]);
  const mesh = autoMesh(outlineImage(image), { targetVertices: 50 });
  const bone = (name: string, x0: number, x1: number) => ({ name, start: { x: x0, y: 50 }, end: { x: x1, y: 50 }, radius: 30 });
  const chain: WeightChain = {
    bones: [bone("upper", 20, 100), bone("lower", 100, 180), bone("hand", 180, 240)],
    anchor: { bone: bone("body", -40, 20), cut: { a: { x: 20, y: 0 }, b: { x: 20, y: 100 } } }
  };
  return { mesh, chain, result: autoWeights(mesh, chain) };
}

const weightOf = (list: readonly Influence[], bone: number) => list.find((inf) => inf.bone === bone)?.weight ?? 0;

describe("auto-weights", () => {
  it("weights sum to 1 with at most 4 bones per vertex", () => {
    const { result } = limb();
    for (const list of result.weights) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(4);
      expect(list.reduce((s, inf) => s + inf.weight, 0)).toBeCloseTo(1, 9);
      for (const inf of list) expect(inf.weight).toBeGreaterThan(0);
    }
  });

  it("a vertex at a bone's middle is at least 0.95 that bone", () => {
    const { mesh, result } = limb();
    // Bones in the result: 0 body (anchor), 1 upper, 2 lower, 3 hand.
    for (const [bone, middle] of [[1, 60], [2, 140], [3, 210]] as const) {
      let best = -1;
      let distance = Infinity;
      for (let v = 0; v < mesh.points.length / 2; v++) {
        const d = Math.hypot((mesh.points[v * 2] as number) - middle, (mesh.points[v * 2 + 1] as number) - 50);
        if (d < distance) {
          distance = d;
          best = v;
        }
      }
      expect(weightOf(result.weights[best] ?? [], bone), `bone ${bone}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("pins the root ring to the anchor and keeps rigid zones exact", () => {
    const { mesh, result } = limb();
    for (let v = 0; v < mesh.points.length / 2; v++) {
      const x = mesh.points[v * 2] as number;
      const list = result.weights[v] ?? [];
      if (x <= 28) {
        expect(result.kinds[v]).toBe("pinned");
        expect(weightOf(list, 0)).toBe(1);
      }
      if (result.kinds[v] === "rigid") expect(list).toHaveLength(1);
    }
  });

  it("blends monotonically across the elbow along the axis", () => {
    const { mesh, result } = limb();
    // Along the centre line, the lower bone's weight never decreases from 60 to 140.
    const samples: [number, number][] = [];
    for (let v = 0; v < mesh.points.length / 2; v++) {
      const x = mesh.points[v * 2] as number;
      const y = mesh.points[v * 2 + 1] as number;
      if (Math.abs(y - 50) < 12 && x >= 60 && x <= 140) samples.push([x, weightOf(result.weights[v] ?? [], 2)]);
    }
    samples.sort((a, b) => a[0] - b[0]);
    expect(samples.length).toBeGreaterThan(2);
    for (let i = 1; i < samples.length; i++) expect((samples[i] as [number, number])[1]).toBeGreaterThanOrEqual((samples[i - 1] as [number, number])[1] - 0.05);
    // And the elbow ring is a real blend, not a step.
    expect(samples.some(([, w]) => w > 0.2 && w < 0.8)).toBe(true);
  });

  it("a one-bone chain is rigid", () => {
    const image = paintShapes(100, 100, [[capsule(30, 50, 70, 50, 20), [1, 2, 3]]]);
    const mesh = autoMesh(outlineImage(image), { targetVertices: 20 });
    const result = autoWeights(mesh, { bones: [{ name: "head", start: { x: 50, y: 90 }, end: { x: 50, y: 10 }, radius: 40 }] });
    for (const list of result.weights) expect(list).toEqual([{ bone: 0, weight: 1 }]);
  });

  it("prune keeps the 4 largest, drops tiny weights and normalises", () => {
    const [pruned] = pruneWeights([[0.4, 0.3, 0.2, 0.05, 0.04, 0.01].map((weight, bone) => ({ bone, weight }))], 4, 0.02);
    expect(pruned?.map((inf) => inf.bone)).toEqual([0, 1, 2, 3]);
    expect(pruned?.reduce((s, inf) => s + inf.weight, 0)).toBeCloseTo(1, 9);
  });

  it("weld gives coincident vertices of different meshes the same weights", () => {
    const a = { points: [0, 0, 10, 0], weights: [[{ bone: 0, weight: 1 }], [{ bone: 0, weight: 1 }]] };
    const b = { points: [0, 0.2, 50, 50], weights: [[{ bone: 1, weight: 1 }], [{ bone: 1, weight: 1 }]] };
    expect(weldWeights([a, b], 0.5)).toBe(2);
    expect(a.weights[0]).toEqual(b.weights[0]);
    expect(a.weights[0]?.map((inf) => inf.weight)).toEqual([0.5, 0.5]);
    expect(b.weights[1]).toEqual([{ bone: 1, weight: 1 }]);
  });

  it("weld groups transitively: a pair joining two groups found earlier merges them (union-find)", () => {
    // Sorted by x: P-R pair first, then Q-S, then R-S joins the two groups. The old grouping
    // relabelled S only and left Q (within tolerance of S) behind in its own group.
    const p = { points: [0, 0, 0.5, 0.45], weights: [[{ bone: 0, weight: 1 }], [{ bone: 3, weight: 1 }]] }; // P, S
    const r = { points: [0.4, 0], weights: [[{ bone: 1, weight: 1 }]] }; // R
    const q = { points: [0.2, 0.6], weights: [[{ bone: 2, weight: 1 }]] }; // Q
    expect(weldWeights([p, r, q], 0.5)).toBe(4);
    const all = [p.weights[0], p.weights[1], r.weights[0], q.weights[0]];
    for (const list of all) expect(list).toEqual(all[0]);
    expect(all[0]?.map((inf) => inf.weight)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("zone weights reject a free component that touches no zone (it would get no weights)", () => {
    // Two separate triangles: the left one is zoned to bone 0 at one corner, the right one is all free.
    const mesh = { points: [0, 0, 10, 0, 0, 10, 50, 0, 60, 0, 50, 10], triangles: [0, 1, 2, 3, 4, 5] };
    const zoneOf = (x: number, y: number) => (x === 0 && y === 0 ? 0 : -1);
    expect(() => zoneWeights(mesh, 2, zoneOf)).toThrow(/touches no zone/);
  });

  it("zone weights seed an isolated free component from the nearest zone when asked", () => {
    const mesh = { points: [0, 0, 10, 0, 0, 10, 50, 0, 60, 0, 50, 10, 100, 0, 110, 0, 100, 10], triangles: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
    const zoneOf = (x: number, y: number) => (x === 0 && y === 0 ? 0 : x === 110 ? 1 : -1);
    const weights = zoneWeights(mesh, 2, zoneOf, 4, { isolated: "nearest" });
    // The middle triangle is nearer the left zone (bone 0) than the right one (bone 1).
    for (const v of [3, 4, 5]) expect(weights[v]).toEqual([{ bone: 0, weight: 1 }]);
    for (const list of weights) expect(list.reduce((sum, inf) => sum + inf.weight, 0)).toBeCloseTo(1, 9);
  });
});

// A side-view quadruped (the fox finding): body 40..220 along y = 60, a neck and head
// up and forward from the chest end, a front and a back leg down. One mesh, a branched tree.
function quadruped() {
  const image = paintShapes(280, 190, [
    [capsule(50, 60, 210, 60, 22), [200, 120, 60]],
    [capsule(205, 55, 245, 15, 14), [200, 120, 60]],
    [capsule(195, 70, 195, 165, 11), [200, 120, 60]],
    [capsule(60, 70, 60, 165, 11), [200, 120, 60]]
  ]);
  const mesh = autoMesh(outlineImage(image), { targetVertices: 160 });
  const bone = (name: string, parent: number, x0: number, y0: number, x1: number, y1: number, radius: number) => ({ name, parent, start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, radius });
  const tree: WeightTree = {
    bones: [
      bone("hips", -1, 40, 60, 130, 60, 22),
      bone("chest", 0, 130, 60, 215, 60, 22),
      bone("neck", 1, 205, 55, 245, 15, 14),
      bone("front_upper", 1, 195, 70, 195, 120, 11),
      bone("front_lower", 3, 195, 120, 195, 170, 11),
      bone("back_upper", 0, 60, 70, 60, 120, 11),
      bone("back_lower", 5, 60, 120, 60, 170, 11)
    ]
  };
  return { mesh, tree, result: autoWeightsTree(mesh, tree) };
}

describe("auto-weights on a bone tree", () => {
  it("keeps each branch's own influence domain: no bleeding between legs, head and other legs", () => {
    const { mesh, tree, result } = quadruped();
    const index = (name: string) => tree.bones.findIndex((b) => b.name === name);
    const front = new Set([index("front_upper"), index("front_lower")]);
    const back = new Set([index("back_upper"), index("back_lower")]);
    const head = index("neck");
    result.weights.forEach((list, v) => {
      const y = mesh.points[v * 2 + 1] as number;
      const bones = new Set(list.map((inf) => inf.bone));
      const touches = (set: Set<number>) => [...bones].some((b) => set.has(b));
      // Nothing mixes the two legs, or a leg with the head.
      expect(touches(front) && touches(back)).toBe(false);
      expect(touches(front) && bones.has(head)).toBe(false);
      expect(touches(back) && bones.has(head)).toBe(false);
      // Paws (well below the body) are wholly their own leg.
      if (y > 140) {
        const x = mesh.points[v * 2] as number;
        expect(list).toHaveLength(1);
        expect(list[0]?.bone).toBe(x > 130 ? index("front_lower") : index("back_lower"));
      }
    });
    expect(result.ambiguous).toBe(0);
  });

  it("blends a leg into the body only around the shared joint", () => {
    const { mesh, tree, result } = quadruped();
    const chest = tree.bones.findIndex((b) => b.name === "chest");
    const frontUpper = tree.bones.findIndex((b) => b.name === "front_upper");
    let blended = 0;
    result.weights.forEach((list, v) => {
      const has = (b: number) => list.some((inf) => inf.bone === b);
      if (!(has(chest) && has(frontUpper))) return;
      blended++;
      const x = mesh.points[v * 2] as number;
      const y = mesh.points[v * 2 + 1] as number;
      expect(Math.hypot(x - 195, y - 70)).toBeLessThan(50);
    });
    expect(blended).toBeGreaterThan(0);
  });

  it("a tree that is one chain gives exactly the chain weights", () => {
    const { mesh, chain, result } = limb();
    const tree: WeightTree = { bones: chain.bones.map((b, k) => ({ ...b, parent: k - 1 })), ...(chain.anchor ? { anchor: chain.anchor } : {}) };
    expect(autoWeightsTree(mesh, tree).weights).toEqual(result.weights);
  });

  it("rejects a tree with two roots or a child listed before its parent", () => {
    const b = (name: string, parent: number) => ({ name, parent, start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, radius: 4 });
    expect(() => checkWeightTree({ bones: [b("a", -1), b("b", -1)] })).toThrow(/exactly one root/);
    expect(() => checkWeightTree({ bones: [b("a", -1), b("b", 2), b("c", 0)] })).toThrow(/listed before/);
  });
});
