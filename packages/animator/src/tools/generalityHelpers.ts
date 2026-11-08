/*
 * Atlas Animator: original implementation.
 *
 * Test helpers for the generality fixtures: sibling-order shuffles of a weight tree
 * and name-keyed weight comparison. Not exported from the package index.
 */
import type { Influence, WeightTree } from "./autoWeights.js";

/**
 * The same tree with every bone's children listed in a shuffled order (parents still before
 * children). Seeded, so a failure reproduces.
 */
/** Seeded uniform [min, max) (mulberry32). */
export function seeded(seed: number): (min: number, max: number) => number {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min);
  };
}

export function shuffleSiblings(tree: WeightTree, seed: number): WeightTree {
  const rand = seeded(seed);
  const children = tree.bones.map(() => [] as number[]);
  const roots: number[] = [];
  tree.bones.forEach((bone, k) => (bone.parent < 0 ? roots : (children[bone.parent] as number[])).push(k));
  const shuffle = (list: number[]) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand(0, i + 1));
      [out[i], out[j]] = [out[j] as number, out[i] as number];
    }
    return out;
  };
  // Breadth-first with shuffled siblings: a different order whenever a bone has two children.
  const order: number[] = [];
  const queue = shuffle(roots);
  while (queue.length > 0) {
    const k = queue.shift() as number;
    order.push(k);
    queue.push(...shuffle(children[k] as number[]));
  }
  const at = new Map(order.map((k, i) => [k, i]));
  return {
    ...tree,
    bones: order.map((k) => {
      const bone = tree.bones[k] as WeightTree["bones"][number];
      return { ...bone, parent: bone.parent < 0 ? -1 : (at.get(bone.parent) as number) };
    })
  };
}

/** Per vertex, bone name -> weight (so two bone orders compare equal). */
export function weightsByName(result: { bones: readonly { name: string }[]; weights: readonly Influence[][] }): Record<string, number>[] {
  return result.weights.map((list) => Object.fromEntries(list.map((inf) => [(result.bones[inf.bone] as { name: string }).name, inf.weight]).sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1))));
}
