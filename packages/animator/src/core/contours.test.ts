import { describe, expect, it } from "vitest";
import { buildStroke, createStrokeTopology, strokeIndexCount, strokeVertexCount, type StrokeCounts, type StrokeRamp } from "./contours.js";

const RAMP: StrokeRamp = { u0: 0.1, u1: 0.4, v: 0.5, rampFraction: 8 / 256 };

function polygon(count: number, radius: number): Float32Array {
  const points = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    points[i * 2] = 50 + Math.cos(a) * radius;
    points[i * 2 + 1] = 50 + Math.sin(a) * radius;
  }
  return points;
}

/** A build of `count` points with buffers sized for `capacity` points, optionally reusing `topology`. */
function build(points: Float32Array, count: number, closed: boolean, capacity: number, topology?: ReturnType<typeof createStrokeTopology>) {
  const positions = new Float32Array(strokeVertexCount(capacity, true, true) * 2);
  const uvs = new Float32Array(positions.length);
  const indices = new Uint32Array(strokeIndexCount(capacity, true, true));
  const counts: StrokeCounts = { vertices: 0, indices: 0 };
  return { positions, uvs, indices, counts, run: () => buildStroke(points, count, closed, false, 4, 1, RAMP, positions, uvs, indices, counts, topology) };
}

describe("stroke topology identity (review, sameTopology)", () => {
  it("an open/closed switch or another point count rewrites uvs and indices", () => {
    // Gentle turns: every join is a single rim vertex per side, open or closed (identical sides).
    const points = polygon(64, 200);
    const cases: [number, boolean, number, boolean][] = [
      [64, false, 64, true],
      [64, true, 64, false],
      [60, false, 64, false],
      [64, false, 60, false]
    ];
    for (const [countA, closedA, countB, closedB] of cases) {
      const topology = createStrokeTopology(64);
      const reused = build(points, countA, closedA, 64, topology);
      reused.run();
      // Same buffers, same topology, the second shape.
      const second = { ...reused, run: () => buildStroke(points, countB, closedB, false, 4, 1, RAMP, reused.positions, reused.uvs, reused.indices, reused.counts, topology) };
      second.run();
      const fresh = build(points, countB, closedB, 64);
      fresh.run();
      expect(reused.counts.topologyChanged, `${countA}/${closedA} -> ${countB}/${closedB}`).toBe(true);
      expect(reused.counts.indices).toBe(fresh.counts.indices);
      expect(Array.from(reused.indices.subarray(0, fresh.counts.indices))).toEqual(Array.from(fresh.indices.subarray(0, fresh.counts.indices)));
      expect(Array.from(reused.uvs.subarray(0, fresh.counts.vertices * 2))).toEqual(Array.from(fresh.uvs.subarray(0, fresh.counts.vertices * 2)));
    }
  });

  it("the same shape again still skips uvs and indices", () => {
    const points = polygon(8, 30);
    const topology = createStrokeTopology(8);
    const b = build(points, 8, true, 8, topology);
    b.run();
    b.run();
    expect(b.counts.topologyChanged).toBe(false);
  });
});
