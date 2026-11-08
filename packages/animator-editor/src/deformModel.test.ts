import { describe, expect, it } from "vitest";
import type { MeshGeometryData } from "@atlas-animator/core/core";
import { emptyClip } from "./clipModel.js";
import {
  clearDeformTimeline,
  clearVerticesOnFrame,
  deformKeyAt,
  deleteDeformKey,
  dragVertices,
  expandDeformKey,
  mergeDeformKey,
  selectionDistances,
  setDeformKey,
  softSelectionWeights,
  transformVertices,
  trimDeform,
  vertexFloatStarts,
  worldPositions,
  type DeformAddress,
  type DeformMesh
} from "./deformModel.js";

const affine = (deg: number, sx: number, sy: number, x: number, y: number) => {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { world: { a: cos * sx, b: -sin * sy, c: sin * sx, d: cos * sy, x, y } };
};

// Bones at a rotated, scaled pose.
const bones = [affine(0, 1, 1, 0, 0), affine(63, 1.3, 0.8, 40, 10), affine(-110, 0.9, 1.1, 80, -20)];

/** 5 vertices in a row with 1, 2, 3, 2 and 1 influences; triangles form a fan strip. */
function weightedGeometry(): MeshGeometryData {
  const counts = [1, 2, 3, 2, 1];
  const inf = [1, 1, 2, 0, 1, 2, 0, 2, 1];
  const w = [1, 0.4, 0.6, 0.2, 0.5, 0.3, 0.5, 0.5, 1];
  const bind = [5, 3, -4, 6, 7, 1, 0, 2, 9, -3, 2, 2, -8, 4, 3, 3, 6, 6];
  return {
    vertexCount: 5,
    weighted: true,
    bind: Float64Array.from(bind),
    counts: Uint8Array.from(counts),
    influenceBones: Uint16Array.from(inf),
    weights: Float64Array.from(w),
    triangles: Uint16Array.from([0, 1, 2, 1, 2, 3, 2, 3, 4]),
    uvs: new Float32Array(10),
    hull: 5,
    deformLength: bind.length,
    groups: null,
    embed: null
  };
}

function plainGeometry(): MeshGeometryData {
  const bind = [0, 0, 10, 0, 20, 0, 30, 0];
  return {
    vertexCount: 4,
    weighted: false,
    bind: Float64Array.from(bind),
    counts: new Uint8Array(0),
    influenceBones: new Uint16Array(0),
    weights: new Float64Array(0),
    triangles: Uint16Array.from([0, 1, 2, 1, 2, 3]),
    uvs: new Float32Array(8),
    hull: 4,
    deformLength: 8,
    groups: null,
    embed: null
  };
}

const weighted: DeformMesh = { geometry: weightedGeometry(), slotBone: bones[1]!, bones };
const plain: DeformMesh = { geometry: plainGeometry(), slotBone: bones[1]!, bones };
const ADDR: DeformAddress = { skin: "default", slot: "s", attachment: "m" };

describe("drag lands under the cursor", () => {
  it("weighted vertices at a rotated pose land exactly at pose + drag, against core skinning", () => {
    const base = Float64Array.from({ length: weighted.geometry.deformLength }, (_, i) => Math.sin(i) * 2);
    const before = worldPositions(weighted, base);
    const moved = dragVertices(weighted, base, 13.5, -7.25, null, [0, 2, 3]);
    const after = worldPositions(weighted, moved.deform);
    for (const v of [0, 2, 3]) {
      expect(after[v * 2]).toBeCloseTo(before[v * 2]! + 13.5, 4);
      expect(after[v * 2 + 1]).toBeCloseTo(before[v * 2 + 1]! - 7.25, 4);
    }
    for (const v of [1, 4]) {
      expect(after[v * 2]).toBeCloseTo(before[v * 2]!, 9);
      expect(after[v * 2 + 1]).toBeCloseTo(before[v * 2 + 1]!, 9);
    }
    expect(moved.touched).toEqual([0, 2, 3]);
  });

  it("an unweighted vertex lands under the cursor through the slot bone", () => {
    const before = worldPositions(plain, null);
    const moved = dragVertices(plain, null, -4, 9, null, [1]);
    const after = worldPositions(plain, moved.deform);
    expect(after[2]).toBeCloseTo(before[2]! - 4, 4);
    expect(after[3]).toBeCloseTo(before[3]! + 9, 4);
    expect(moved.deform.length).toBe(8);
  });

  it("weights that do not sum to 1 still land exactly", () => {
    const g = weightedGeometry();
    const off: DeformMesh = { ...weighted, geometry: { ...g, weights: g.weights.map((w) => w * 0.7) } };
    const before = worldPositions(off, null);
    const after = worldPositions(off, dragVertices(off, null, 6, 3, null, [2]).deform);
    expect(after[4]).toBeCloseTo(before[4]! + 6, 4);
    expect(after[5]).toBeCloseTo(before[5]! + 3, 4);
  });

  it("soft selection scales the move by the falloff", () => {
    const pos = worldPositions(weighted, null);
    const infl = softSelectionWeights(weighted, pos, [2], 1e6, "straight");
    const before = worldPositions(weighted, null);
    const after = worldPositions(weighted, dragVertices(weighted, null, 10, 0, infl).deform);
    expect(after[4]).toBeCloseTo(before[4]! + 10, 4);
    for (const v of [0, 1, 3, 4]) {
      expect(after[v * 2]! - before[v * 2]!).toBeCloseTo(10 * infl[v]!, 4);
    }
  });
});

describe("falloff distances", () => {
  const positions = [0, 0, 10, 0, 10, 10, 20, 10]; // a bent chain 0-1-2-3
  it("straight line ignores the mesh, edge distance follows it", () => {
    const tris = [0, 1, 2, 1, 2, 3];
    const straight = selectionDistances(positions, [0], "straight", tris);
    const edge = selectionDistances(positions, [0], "edge", tris);
    expect(straight[2]).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(edge[2]).toBeCloseTo(Math.hypot(10, 10), 9); // 0-2 is an edge of triangle 0
    expect(edge[3]).toBeCloseTo(Math.hypot(10, 10) + 10, 9);
    expect(straight[3]).toBeCloseTo(Math.hypot(20, 10), 9);
    // no 0-3 shortcut: edge >= straight
    expect(edge[3]).toBeGreaterThanOrEqual(straight[3]!);
  });

  it("edge mode does not leak across a gap in the mesh", () => {
    const pos = [0, 0, 10, 0, 5, 1, 6, 0]; // vertex 2 sits next to vertex 0 in space but is joined only via 1
    const tris = [0, 1, 3, 1, 2, 3]; // 0 and 2 share no edge
    expect(selectionDistances(pos, [0], "edge", tris)[2]).toBeGreaterThan(selectionDistances(pos, [0], "straight", tris)[2]!);
  });
});

describe("transform selection", () => {
  it("scales and rotates the selection about its centre, landing exactly (core skinning)", () => {
    const pos = worldPositions(weighted, null);
    const sel = [0, 2, 4];
    const c = { x: (pos[0]! + pos[4]! + pos[8]!) / 3, y: (pos[1]! + pos[5]! + pos[9]!) / 3 };
    const rotate = 0.4;
    const res = transformVertices(weighted, null, pos, sel, null, { rotate, scaleX: 1.5, scaleY: 1.5 });
    const after = worldPositions(weighted, res.deform);
    for (const v of sel) {
      const qx = pos[v * 2]! - c.x;
      const qy = pos[v * 2 + 1]! - c.y;
      const ex = c.x + 1.5 * (qx * Math.cos(rotate) - qy * Math.sin(rotate));
      const ey = c.y + 1.5 * (qx * Math.sin(rotate) + qy * Math.cos(rotate));
      expect(after[v * 2]).toBeCloseTo(ex, 4);
      expect(after[v * 2 + 1]).toBeCloseTo(ey, 4);
    }
  });

  it("squash scales along one axis only", () => {
    const pos = worldPositions(plain, null);
    const res = transformVertices(plain, null, pos, [0, 1, 2, 3], null, { scaleX: 2, scaleY: 1, axis: 0 });
    const after = worldPositions(plain, res.deform);
    const cx = (pos[0]! + pos[2]! + pos[4]! + pos[6]!) / 4;
    const cy = (pos[1]! + pos[3]! + pos[5]! + pos[7]!) / 4;
    for (let v = 0; v < 4; v++) {
      expect(after[v * 2]).toBeCloseTo(cx + 2 * (pos[v * 2]! - cx), 4);
      expect(after[v * 2 + 1]).toBeCloseTo(pos[v * 2 + 1]!, 4);
    }
    expect(cy).toBeDefined();
  });
});

describe("deform keys", () => {
  const len = weighted.geometry.deformLength;

  it("stores the minimal nonzero span", () => {
    const full = new Float64Array(len);
    full[6] = 1.5;
    full[9] = -2;
    expect(trimDeform(full)).toEqual({ offset: 6, vertices: [1.5, 0, 0, -2] });
    expect(trimDeform(new Float64Array(len))).toEqual({ offset: 0, vertices: [] });
    const clip = setDeformKey(emptyClip(1), ADDR, 0.5, full);
    const key = deformKeyAt(clip, ADDR, 0.5)!;
    expect(key.offset).toBe(6);
    expect(key.vertices).toHaveLength(4);
    expect(expandDeformKey(key, len)[9]).toBe(-2);
  });

  it("merging keeps the other vertices' offsets and the key's curve", () => {
    const starts = vertexFloatStarts(weighted.geometry);
    let clip = emptyClip(1);
    const first = dragVertices(weighted, null, 5, 5, null, [0]);
    clip = setDeformKey(clip, ADDR, 0.5, first.deform, [0.25, 0.1, 0.75, 0.9]);
    const second = dragVertices(weighted, deformKeyAt(clip, ADDR, 0.5) ? expandDeformKey(deformKeyAt(clip, ADDR, 0.5)!, len) : null, -3, 2, null, [3]);
    clip = mergeDeformKey(clip, ADDR, 0.5, len, second.edits);
    const full = expandDeformKey(deformKeyAt(clip, ADDR, 0.5)!, len);
    for (const i of [...first.edits.keys()]) expect(full[i]).toBeCloseTo(first.deform[i]!, 4);
    for (const i of [...second.edits.keys()]) expect(full[i]).toBeCloseTo(second.deform[i]!, 4);
    expect(deformKeyAt(clip, ADDR, 0.5)!.curve).toEqual([0.25, 0.1, 0.75, 0.9]);
    expect(starts[5]).toBe(len);
  });

  it("a new key on a frame keeps the sampled deform of the other vertices", () => {
    const sampled = Float64Array.from({ length: len }, (_, i) => (i === 12 ? 4 : 0));
    const res = dragVertices(weighted, sampled, 2, 2, null, [0]);
    const clip = mergeDeformKey(emptyClip(1), ADDR, 0.5, len, res.edits, sampled);
    expect(expandDeformKey(deformKeyAt(clip, ADDR, 0.5)!, len)[12]).toBe(4);
  });

  it("clearing vertices only affects the selection", () => {
    const all = dragVertices(weighted, null, 6, -2, null, [0, 1, 2, 3, 4]);
    let clip = setDeformKey(emptyClip(1), ADDR, 0.5, all.deform);
    const before = expandDeformKey(deformKeyAt(clip, ADDR, 0.5)!, len);
    clip = clearVerticesOnFrame(clip, ADDR, 0.5, weighted.geometry, [1, 3]);
    const after = expandDeformKey(deformKeyAt(clip, ADDR, 0.5)!, len);
    const starts = vertexFloatStarts(weighted.geometry);
    for (let v = 0; v < 5; v++) {
      for (let i = starts[v]!; i < starts[v + 1]!; i++) {
        if (v === 1 || v === 3) expect(after[i]).toBe(0);
        else expect(after[i]).toBeCloseTo(before[i]!, 5);
      }
    }
    expect(deformKeyAt(clip, ADDR, 0.5)).toBeDefined(); // the key stays
  });

  it("clears the key on a frame, then the whole timeline, removing empty records", () => {
    let clip = setDeformKey(emptyClip(1), ADDR, 0.2, Float64Array.of(1, 2));
    clip = setDeformKey(clip, ADDR, 0.6, Float64Array.of(3, 4));
    const one = deleteDeformKey(clip, ADDR, 0.2);
    expect(one.deform.default!.s!.m!.map((k) => k.time)).toEqual([0.6]);
    expect(clip.deform.default!.s!.m).toHaveLength(2); // input untouched
    expect(deleteDeformKey(one, ADDR, 0.6).deform).toEqual({});
    expect(clearDeformTimeline(clip, ADDR).deform).toEqual({});
    expect(deleteDeformKey(clip, ADDR, 0.9)).toBe(clip);
  });
});
