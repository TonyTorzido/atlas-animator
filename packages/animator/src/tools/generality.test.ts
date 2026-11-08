import { describe, expect, it } from "vitest";
import { autoMesh } from "./autoMesh.js";
import { autoWeightsTree, type WeightTree } from "./autoWeights.js";
import { shuffleSiblings, weightsByName } from "./generalityHelpers.js";
import { outlineImage } from "./outline.js";
import { capsule, paintShapes } from "./testFigures.js";

const bone = (name: string, parent: number, x0: number, y0: number, x1: number, y1: number, radius: number) => ({ name, parent, start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, radius });

describe("auto-weights tree: sibling order (item 1)", () => {
  it("two children sharing a start give identical weights whichever is listed first", () => {
    // A body with two branches leaving the same point at its end (an upper and a lower child).
    const image = paintShapes(260, 200, [
      [capsule(30, 100, 130, 100, 20), [200, 120, 60]],
      [capsule(130, 100, 220, 50, 14), [200, 120, 60]],
      [capsule(130, 100, 220, 150, 14), [200, 120, 60]]
    ]);
    const mesh = autoMesh(outlineImage(image), { targetVertices: 140 });
    const tree: WeightTree = { bones: [bone("body", -1, 30, 100, 130, 100, 20), bone("upper", 0, 130, 100, 220, 50, 14), bone("lower", 0, 130, 100, 220, 150, 14)] };
    const reversed: WeightTree = { bones: [tree.bones[0] as WeightTree["bones"][number], { ...(tree.bones[2] as WeightTree["bones"][number]) }, { ...(tree.bones[1] as WeightTree["bones"][number]) }] };
    const a = autoWeightsTree(mesh, tree);
    const b = autoWeightsTree(mesh, reversed);
    expect(weightsByName(b)).toEqual(weightsByName(a));
    expect(b.ambiguous).toBe(a.ambiguous);
    for (let seed = 1; seed <= 4; seed++) expect(weightsByName(autoWeightsTree(mesh, shuffleSiblings(tree, seed)))).toEqual(weightsByName(a));
  });
});
