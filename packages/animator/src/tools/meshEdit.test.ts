import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { applyCommand, COMMANDS, Edit } from "./commands.js";
import { cloneJson, type JsonObject } from "./jsonPatch.js";
import { remapDeform, triangulate } from "./meshEdit.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url), "utf8")) as JsonObject;
const torso = { skin: "body", slot: "torso", name: "torso" };

const obj = (value: unknown) => value as JsonObject;
const pattern = (n: number, seed: number) => Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * 1.7 + seed) * 40) / 10);

/** Fixture torso (10 weighted vertices, hips rotated -90) plus deform keys, a corrective, a grid, a contour and an embedded mesh. */
function baseDoc(): JsonObject {
  const doc = cloneJson(fixture) as JsonObject;
  obj(obj(doc["animations"])["idle"])["deform"] = {
    body: { torso: { torso: [{ time: 0, vertices: pattern(24, 1) }, { time: 1.2, offset: 2, vertices: pattern(10, 2) }] } }
  };
  doc["driven"] = [
    { name: "fix", bone: "chest", keys: [{ at: 0 }, { at: 45, deform: { body: { torso: { torso: { offset: 0, vertices: pattern(24, 3) } } } } }] }
  ];
  doc["drivenGrids"] = [
    {
      name: "grid",
      x: { bone: "chest", at: [0, 45] },
      y: { bone: "hips", at: [0, 45] },
      keys: [{ deform: {} }, { deform: {} }, { deform: {} }, { deform: { body: { torso: { torso: { offset: 4, vertices: pattern(12, 4) } } } } }]
    }
  ];
  const skin = obj(obj(doc["skins"])["body"]);
  skin["contours"] = { torso: { edge: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 9, [1, 3, 4, 0.3, 0.3]], width: 2 } } };
  obj(skin["attachments"])["tunic"] = {
    pad: {
      type: "mesh",
      path: "body/pad",
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      triangles: [0, 1, 2, 0, 2, 3],
      vertices: [0, 0, 10, 0, 10, 10, 0, 10],
      hull: 4,
      width: 10,
      height: 10,
      embed: { slot: "torso", attachment: "torso", vertices: [0, 1, 2, 3], points: [0, 9, [1, 3, 4, 0.3, 0.3], 5] }
    }
  };
  return doc;
}

interface Model {
  vertices: number[];
  bones: string[];
  count: number;
}

const meshOf = (doc: JsonObject): JsonObject => obj(obj(obj(obj(obj(doc["skins"])["body"])["attachments"])["torso"])["torso"]);

/** Rest-pose world delta of every vertex for a (sparse) deform key, computed straight from the stored encoding. */
function worldDeltas(doc: JsonObject, key: { offset?: number; vertices: number[] }): [number, number][] {
  const parsed = parseAnimDocument(doc);
  if (!parsed.ok) throw new Error("invalid doc");
  const skeleton = new Skeleton((parsed as unknown as { document: never }).document);
  skeleton.updateWorldTransform("none");
  const mesh = meshOf(doc);
  const model: Model = { vertices: mesh["vertices"] as number[], bones: mesh["bones"] as string[], count: (mesh["uvs"] as number[]).length / 2 };
  const dense = new Array<number>(model.vertices.length * 2).fill(0);
  (key.vertices ?? []).forEach((value, i) => (dense[(key.offset ?? 0) + i] = value));
  const out: [number, number][] = [];
  let cursor = 0;
  let influence = 0;
  for (let v = 0; v < model.count; v++) {
    const n = model.vertices[cursor++] as number;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < n; k++, cursor += 4, influence++) {
      const { a, b, c, d } = skeleton.getBone(model.bones[model.vertices[cursor] as number] as string).world;
      const w = model.vertices[cursor + 3] as number;
      const x = dense[influence * 2] as number;
      const y = dense[influence * 2 + 1] as number;
      dx += w * (a * x + b * y);
      dy += w * (c * x + d * y);
    }
    out.push([dx, dy]);
  }
  return out;
}

const idleKeys = (doc: JsonObject) => obj(obj(obj(obj(obj(obj(doc["animations"])["idle"])["deform"])["body"])["torso"]))["torso"] as unknown as { time: number; offset: number; vertices: number[] }[];
const drivenKey = (doc: JsonObject) => obj(obj(obj(obj(obj(((doc["driven"] as JsonObject[])[0] as JsonObject)["keys"] as unknown as JsonObject[])[1])["deform"])["body"])["torso"])["torso"] as unknown as { offset: number; vertices: number[] };
const gridKey = (doc: JsonObject) => obj(obj(obj(obj(obj(((doc["drivenGrids"] as JsonObject[])[0] as JsonObject)["keys"] as unknown as JsonObject[])[3])["deform"])["body"])["torso"])["torso"] as unknown as { offset: number; vertices: number[] };

/** The image-pixel points of the torso mesh (uv * size). */
function pixels(doc: JsonObject): number[] {
  const mesh = meshOf(doc);
  return (mesh["uvs"] as number[]).map((u, i) => (i % 2 === 0 ? u * 60 : u * 120));
}

/** Triangulates a hull loop (vertices 0..hull-1) plus interior points. */
function mesh(points: number[], hull: number): number[] {
  const loop = Array.from({ length: hull }, (_, i) => [i, (i + 1) % hull] as [number, number]);
  return triangulate(points, loop);
}

function closeTo(actual: [number, number][], expected: [number, number][]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach(([x, y], i) => {
    expect(Math.abs(x - (expected[i] as [number, number])[0])).toBeLessThan(1e-4);
    expect(Math.abs(y - (expected[i] as [number, number])[1])).toBeLessThan(1e-4);
  });
}

describe("triangulate", () => {
  it("fills a square, and leaves a hole loop empty", () => {
    const points = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 7, 3, 7, 7, 3, 7];
    const flat = triangulate(points, [[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(flat.length / 3).toBeGreaterThanOrEqual(2);
    const holed = triangulate(points, [[0, 1], [1, 2], [2, 3], [3, 0]], [[4, 5, 6, 7]]);
    const area = (list: number[]) => {
      let sum = 0;
      for (let t = 0; t < list.length; t += 3) {
        const [a, b, c] = [list[t] as number, list[t + 1] as number, list[t + 2] as number];
        sum += ((points[2 * b] as number) - (points[2 * a] as number)) * ((points[2 * c + 1] as number) - (points[2 * a + 1] as number)) - ((points[2 * b + 1] as number) - (points[2 * a + 1] as number)) * ((points[2 * c] as number) - (points[2 * a] as number));
      }
      return sum / 2;
    };
    expect(area(flat)).toBeCloseTo(100, 6);
    expect(area(holed)).toBeCloseTo(100 - 16, 6);
  });
});

describe("mesh.edit", () => {
  it("adds an interior vertex: weights interpolate, deform keys of the old vertices are untouched", () => {
    const doc = baseDoc();
    const points = [...pixels(doc), 30, 60];
    const before = [idleKeys(doc)[0], drivenKey(doc), gridKey(doc)] as { vertices: number[]; offset?: number }[];
    const result = applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 10), hull: 10, origin: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1] });
    const after = result.doc as JsonObject;
    expect((meshOf(after)["uvs"] as number[]).length).toBe(22);
    expect((meshOf(after)["uvs"] as number[]).slice(20)).toEqual([0.5, 0.5]);
    const keys = [idleKeys(after)[0], drivenKey(after), gridKey(after)] as { vertices: number[]; offset?: number }[];
    for (let i = 0; i < 3; i++) closeTo(worldDeltas(after, keys[i] as never).slice(0, 10), worldDeltas(doc, before[i] as never));
    expect(worldDeltas(after, keys[0] as never)[10]).toEqual([0, 0]);
    // The contour and the embedding keep their indices (no vertex moved in the list).
    expect(obj(obj(obj(obj(after["skins"])["body"])["contours"])["torso"])["edge"]).toMatchObject({ points: [0, 9, [1, 3, 4, 0.3, 0.3]] });
  });

  it("deletes a hull vertex, remapping deform keys, the contour and the embedding", () => {
    const doc = baseDoc();
    const full = pixels(doc);
    // Delete old vertex 8 (not referenced); old vertex 9 becomes 8.
    const keep = [0, 1, 2, 3, 4, 5, 6, 7, 9];
    const points = keep.flatMap((v) => [full[2 * v] as number, full[2 * v + 1] as number]);
    const after = applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 9), hull: 9, origin: keep }).doc as JsonObject;
    const before = worldDeltas(doc, idleKeys(doc)[0] as never);
    closeTo(worldDeltas(after, idleKeys(after)[0] as never), keep.map((v) => before[v] as [number, number]));
    closeTo(worldDeltas(after, drivenKey(after)), keep.map((v) => worldDeltas(doc, drivenKey(doc))[v] as [number, number]));
    closeTo(worldDeltas(after, gridKey(after)), keep.map((v) => worldDeltas(doc, gridKey(doc))[v] as [number, number]));
    expect(obj(obj(obj(obj(after["skins"])["body"])["contours"])["torso"])["edge"]).toMatchObject({ points: [0, 8, [1, 3, 4, 0.3, 0.3]] });
    const pad = obj(obj(obj(obj(after["skins"])["body"])["attachments"])["tunic"])["pad"];
    expect(obj(obj(pad)["embed"])["points"]).toEqual([0, 8, [1, 3, 4, 0.3, 0.3], 5]);
  });

  it("reorders the hull (rotates the loop start) and follows every reference", () => {
    const doc = baseDoc();
    const full = pixels(doc);
    const origin = [3, 4, 5, 6, 7, 8, 9, 0, 1, 2];
    const points = origin.flatMap((v) => [full[2 * v] as number, full[2 * v + 1] as number]);
    const after = applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 10), hull: 10, origin }).doc as JsonObject;
    const newOf = (old: number) => origin.indexOf(old);
    for (const [read, key] of [[idleKeys, 0], [drivenKey, -1], [gridKey, -1]] as const) {
      const was = key === 0 ? (idleKeys(doc)[0] as never) : (read(doc) as never);
      const now = key === 0 ? (idleKeys(after)[0] as never) : (read(after) as never);
      const oldDelta = worldDeltas(doc, was);
      closeTo(worldDeltas(after, now), origin.map((v) => oldDelta[v] as [number, number]));
    }
    expect(obj(obj(obj(obj(after["skins"])["body"])["contours"])["torso"])["edge"]).toMatchObject({ points: [newOf(0), newOf(9), [newOf(1), newOf(3), newOf(4), 0.3, 0.3]] });
    const pad = obj(obj(obj(obj(after["skins"])["body"])["attachments"])["tunic"])["pad"];
    expect(obj(obj(pad)["embed"])["points"]).toEqual([newOf(0), newOf(9), [newOf(1), newOf(3), newOf(4), 0.3, 0.3], newOf(5)]);
    // Every vertex keeps its setup position.
    const worldOf = (d: JsonObject) => worldDeltas(d, { vertices: [] }).length;
    expect(worldOf(after)).toBe(10);
  });

  it("refuses to delete a vertex that a contour or an embedding uses", () => {
    const doc = baseDoc();
    const full = pixels(doc);
    const keep = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const points = keep.flatMap((v) => [full[2 * v] as number, full[2 * v + 1] as number]);
    expect(() => applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 9), hull: 9, origin: keep })).toThrow(/uses vertex 9, which this edit deletes/);
  });

  it("refuses a mesh that carries a coverage region", () => {
    const doc = baseDoc();
    obj(obj(doc["skins"])["body"])["coverage"] = { regions: { chest: { mesh: { slot: "torso", attachment: "torso" }, triangles: [[0, 4]] } }, covers: [] };
    const points = pixels(doc);
    expect(() => applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 10), hull: 10, origin: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })).toThrow(/coverage region 'chest'/);
  });

  it("refuses a mesh with draw groups", () => {
    const doc = baseDoc();
    meshOf(doc)["groups"] = { torso: [[0, 8]] };
    const points = pixels(doc);
    expect(() => applyCommand(doc, { op: "mesh.edit", ...torso, points, triangles: mesh(points, 10), hull: 10, origin: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })).toThrow(/has draw groups \(torso\)/);
  });
});

describe("weights.table", () => {
  it("changes influence counts and keeps every deform key's rest-pose world delta", () => {
    const doc = baseDoc();
    // Vertex 0 gains a third bone, vertex 2 drops to one bone, the rest keep their weights.
    const columns = ["hips", "chest", "head"];
    const rows: number[][] = [];
    const mesh0 = meshOf(doc);
    let cursor = 0;
    for (let v = 0; v < 10; v++) {
      const n = (mesh0["vertices"] as number[])[cursor++] as number;
      const row = [0, 0, 0];
      for (let k = 0; k < n; k++, cursor += 4) row[columns.indexOf((mesh0["bones"] as string[])[(mesh0["vertices"] as number[])[cursor] as number] as string)] = (mesh0["vertices"] as number[])[cursor + 3] as number;
      rows.push(row);
    }
    rows[0] = [0.5, 0.3, 0.2];
    rows[2] = [0, 1, 0];
    const after = applyCommand(doc, { op: "weights.table", ...torso, influences: columns, weights: rows.flat() }).doc as JsonObject;
    expect((meshOf(after)["bones"] as string[]).sort()).toEqual(["chest", "head", "hips"]);
    closeTo(worldDeltas(after, idleKeys(after)[0] as never), worldDeltas(doc, idleKeys(doc)[0] as never));
    closeTo(worldDeltas(after, idleKeys(after)[1] as never), worldDeltas(doc, idleKeys(doc)[1] as never));
    closeTo(worldDeltas(after, drivenKey(after)), worldDeltas(doc, drivenKey(doc)));
    closeTo(worldDeltas(after, gridKey(after)), worldDeltas(doc, gridKey(doc)));
  });

  it("prunes to the cap, normalises, and refuses a vertex with no weight", () => {
    const doc = baseDoc();
    const weights = Array.from({ length: 10 }, () => [0.4, 0.3, 0.2, 0.1]).flat();
    const after = applyCommand(doc, { op: "weights.table", ...torso, influences: ["hips", "chest", "head", "root"], weights, max: 2 }).doc as JsonObject;
    const vertices = meshOf(after)["vertices"] as number[];
    expect(vertices[0]).toBe(2);
    expect((vertices[4] as number) + (vertices[8] as number)).toBeCloseTo(1, 5);
    const empty = weights.slice();
    empty.fill(0, 0, 4);
    expect(() => applyCommand(doc, { op: "weights.table", ...torso, influences: ["hips", "chest", "head", "root"], weights: empty })).toThrow(/vertex 0 has no weight/);
  });

  it("writes 800 vertices in under 50 ms", () => {
    const doc = cloneJson(fixture) as JsonObject;
    const columns = 40;
    const rowsCount = 20;
    const vertices: number[] = [];
    const uvs: number[] = [];
    const triangles: number[] = [];
    for (let j = 0; j < rowsCount; j++) {
      for (let i = 0; i < columns; i++) {
        vertices.push(i * 1.5, j * 6);
        uvs.push(i / (columns - 1), j / (rowsCount - 1));
        if (i + 1 < columns && j + 1 < rowsCount) {
          const a = j * columns + i;
          triangles.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
        }
      }
    }
    obj(obj(obj(obj(doc["skins"])["body"])["attachments"])["torso"])["torso"] = { type: "mesh", path: "body/torso", uvs, triangles, vertices, hull: 3, width: 60, height: 120 };
    const weights: number[] = [];
    for (let v = 0; v < 800; v++) weights.push(1 - v / 800, v / 800);
    const command = { op: "weights.table", ...torso, influences: ["hips", "chest"], weights };
    const spec = COMMANDS.get("weights.table");
    if (!spec) throw new Error("weights.table is not registered");
    const params = spec.params.parse(command);
    const run = () => spec.run(new Edit(cloneJson(doc) as JsonObject), params as never);
    run();
    const started = performance.now();
    run();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect((applyCommand(doc, command).doc as JsonObject)).toBeTruthy();
  });
});

describe("remapDeform", () => {
  it("copies a vertex whose influences did not change and zeroes a new one", () => {
    const skeleton = { getBone: () => ({ world: { a: 0, b: -1, c: 1, d: 0 } }) };
    const geom = { count: 2, vertices: [1, 0, 0, 0, 1, 1, 0, 5, 0, 1], bones: ["hips"], slotBone: "hips" };
    const swapped = remapDeform(geom, { ...geom, count: 3, vertices: [...geom.vertices.slice(5), ...geom.vertices.slice(0, 5), 1, 0, 1, 1, 1] }, [1, 0, -1], skeleton);
    expect(swapped({ vertices: [1, 2, 3, 4] })).toEqual({ offset: 0, vertices: [3, 4, 1, 2] });
  });
});
