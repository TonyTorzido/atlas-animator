/*
 * Atlas Animator: original implementation.
 *
 * Second rig acceptance (nest mouse): weights.auto domains follow the mesh, not straight lines.
 * A U-shaped part (a body column, a gap, a tail curled back up beside it): the inner edge of the
 * body is nearer the curled tail in a straight line, across the gap, but along the mesh it is the
 * body's.
 */
import { describe, expect, it } from "vitest";
import { autoWeightsTree, geodesicBoneDistances, type MeshForWeights, type WeightTree } from "./autoWeights.js";
import { segmentDistance } from "./outline.js";

/** A grid mesh over the cells `inside(x, y)` accepts (cell origin), step `s`. */
function gridMesh(width: number, height: number, s: number, inside: (x: number, y: number) => boolean): MeshForWeights {
  const index = new Map<string, number>();
  const points: number[] = [];
  const at = (x: number, y: number) => {
    const k = `${x},${y}`;
    let i = index.get(k);
    if (i === undefined) {
      i = points.length / 2;
      index.set(k, i);
      points.push(x, y);
    }
    return i;
  };
  const triangles: number[] = [];
  for (let y = 0; y < height; y += s)
    for (let x = 0; x < width; x += s) {
      if (!inside(x, y)) continue;
      const a = at(x, y);
      const b = at(x + s, y);
      const c = at(x + s, y + s);
      const d = at(x, y + s);
      triangles.push(a, b, c, a, c, d);
    }
  return { points, triangles };
}

// Body column x 0..100, gap x 100..130, tail column x 130..170, joined by a bottom bar y 250..300.
const uMesh = gridMesh(170, 300, 10, (x, y) => x < 100 || x >= 130 || y >= 250);
const tree: WeightTree = {
  bones: [
    { name: "body", start: { x: 20, y: 0 }, end: { x: 20, y: 275 }, radius: 40, parent: -1 },
    { name: "tail_1", start: { x: 20, y: 275 }, end: { x: 150, y: 275 }, radius: 20, parent: 0 },
    { name: "tail_2", start: { x: 150, y: 275 }, end: { x: 150, y: 20 }, radius: 20, parent: 1 }
  ]
};
const vertexAt = (mesh: MeshForWeights, x: number, y: number) => {
  for (let i = 0; i < mesh.points.length / 2; i++) if (mesh.points[i * 2] === x && mesh.points[i * 2 + 1] === y) return i;
  throw new Error(`no vertex at ${x},${y}`);
};

describe("weights.auto geodesic domains", () => {
  it("keeps the body's inner edge off a curled tail across the gap", () => {
    const v = vertexAt(uMesh, 100, 60);
    // Straight-line distance says tail_2 (50 px across the gap) beats the body (80 px).
    expect(segmentDistance(100, 60, tree.bones[2]!.start, tree.bones[2]!.end)).toBeLessThan(segmentDistance(100, 60, tree.bones[0]!.start, tree.bones[0]!.end));
    const result = autoWeightsTree(uMesh, tree);
    for (let y = 0; y <= 150; y += 10) expect(tree.bones[result.domains[vertexAt(uMesh, 100, y)]!]!.name).toBe("body");
    // The tail column is still the tail's, and nothing there is ambiguous with the body.
    expect(tree.bones[result.domains[vertexAt(uMesh, 130, 60)]!]!.name).toBe("tail_2");
    expect(result.diagnostics.ambiguities.filter((a) => (uMesh.points[a.vertex * 2] as number) === 100 && (uMesh.points[a.vertex * 2 + 1] as number) <= 150)).toEqual([]);
    expect(result.weights[v]!.every((inf) => result.bones[inf.bone]!.name === "body")).toBe(true);
    // The branched-tree solve (not the single-chain shortcut) gives the same ownership.
    const branched = autoWeightsTree(uMesh, tree, { jointWidth: new Map() });
    for (let y = 0; y <= 150; y += 10) expect(tree.bones[branched.domains[vertexAt(uMesh, 100, y)]!]!.name).toBe("body");
  });

  it("equals the straight-line distance on a convex mesh", () => {
    const square = gridMesh(100, 100, 10, () => true);
    const bones = [{ start: { x: 10, y: 10 }, end: { x: 90, y: 30 } }, { start: { x: 50, y: 50 }, end: { x: 50, y: 95 } }];
    const geo = geodesicBoneDistances(square, bones);
    bones.forEach((bone, k) => {
      for (let i = 0; i < square.points.length / 2; i++) expect(geo[k]![i]).toBeCloseTo(segmentDistance(square.points[i * 2]!, square.points[i * 2 + 1]!, bone.start, bone.end), 9);
    });
  });

  it("a side branch's reach keeps a wide body's far edge on the trunk (the mouse's back edge and the thigh)", () => {
    // A 300 x 200 body; the trunk runs up its left side, a short thigh hangs off it near the
    // middle-bottom. The far right edge is nearer the thigh than the trunk in a straight line.
    const body = gridMesh(300, 200, 20, () => true);
    const bones = (reach?: number): WeightTree => ({
      bones: [
        { name: "trunk", start: { x: 10, y: 190 }, end: { x: 10, y: 10 }, radius: 40, parent: -1 },
        { name: "thigh", start: { x: 150, y: 180 }, end: { x: 180, y: 195 }, radius: 15, parent: 0, ...(reach !== undefined ? { reach } : {}) }
      ]
    });
    const far = vertexAt(body, 300, 40);
    expect(bones().bones[autoWeightsTree(body, bones(), { jointWidth: new Map() }).domains[far]!]!.name).toBe("thigh");
    expect(bones().bones[autoWeightsTree(body, bones(34), { jointWidth: new Map() }).domains[far]!]!.name).toBe("trunk");
    // Vertices on the thigh itself stay the thigh's.
    expect(autoWeightsTree(body, bones(34), { jointWidth: new Map() }).domains[vertexAt(body, 160, 180)]).toBe(1);
  });
});
