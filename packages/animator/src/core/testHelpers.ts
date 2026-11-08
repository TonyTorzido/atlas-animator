/*
 * Atlas Animator: original implementation.
 *
 * Test helpers shared by the core tests (not exported from the package index).
 */
import { expect } from "vitest";
import type { AnimDocumentInput } from "./format.js";
import { loadAnimDocument } from "./formatLoader.js";
import type { Affine2 } from "./math.js";
import { Skeleton, type SkeletonOptions } from "./skeleton.js";

export const COS30 = Math.sqrt(3) / 2;
export const SQRT1_2 = Math.SQRT1_2;

/** Loads a document built from partial sections (format, name and canvas filled in). */
export function testDocument(sections: Omit<AnimDocumentInput, "format" | "name" | "canvas">) {
  return loadAnimDocument({
    format: "atlas-anim@1",
    name: "test",
    canvas: { width: 100, height: 100, originX: 0, originY: 0 },
    ...sections
  });
}

/** A skeleton over the given bones (and optional other sections), world-updated once. */
export function testSkeleton(
  sections: Omit<AnimDocumentInput, "format" | "name" | "canvas">,
  options?: SkeletonOptions
): Skeleton {
  const skeleton = new Skeleton(testDocument(sections), options);
  skeleton.updateWorldTransform();
  return skeleton;
}

export function expectAffine(actual: Readonly<Affine2>, expected: Partial<Affine2>, digits = 9): void {
  for (const key of ["a", "b", "c", "d", "x", "y"] as const) {
    const value = expected[key];
    if (value !== undefined) expect(actual[key], `world.${key}`).toBeCloseTo(value, digits);
  }
}

/** Deterministic PRNG (mulberry32) so property-style tests are reproducible. */
export function random(seed: number): (min: number, max: number) => number {
  let state = seed >>> 0;
  return (min, max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + (max - min) * unit;
  };
}
