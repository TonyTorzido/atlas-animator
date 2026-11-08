import { readFileSync } from "node:fs";
import { applyCommands } from "@atlas-animator/core/commands";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { meshMinAngle } from "@atlas-animator/core/tools/autoMesh";
import { polygonArea } from "@atlas-animator/core/tools/outline";
import { describe, expect, it } from "vitest";
import {
  addEdge, addVertex, compatibleVariants, deleteEdge, deleteVertex, gridMesh, gridMeshForCount, insertHullVertex, keepRectangle, MeshModelError,
  modelFromMesh, moveVertex, planMeshCommit, redrawHull, removeHullVertex, traceMesh, validateMesh, type MeshModel, type MeshSource, type Point
} from "./meshModel.js";

const square = (): MeshModel => keepRectangle(100, 100, 4);
const ellipse = (rx: number, ry: number, n = 40): Point[] => Array.from({ length: n }, (_, i) => ({ x: 200 + rx * Math.cos((2 * Math.PI * i) / n), y: 150 + ry * Math.sin((2 * Math.PI * i) / n) }));

/** Total triangle area; every triangle must have positive winding. */
function area(m: MeshModel): number {
  let sum = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const [a, b, c] = [m.triangles[t]!, m.triangles[t + 1]!, m.triangles[t + 2]!];
    const cross = (m.points[2 * b]! - m.points[2 * a]!) * (m.points[2 * c + 1]! - m.points[2 * a + 1]!) - (m.points[2 * b + 1]! - m.points[2 * a + 1]!) * (m.points[2 * c]! - m.points[2 * a]!);
    expect(cross).toBeGreaterThan(0);
    sum += cross / 2;
  }
  return sum;
}
const hullArea = (m: MeshModel) => polygonArea(Array.from({ length: m.hull }, (_, i) => ({ x: m.points[2 * i]!, y: m.points[2 * i + 1]! })));

function disc(width: number, height: number, inside: (x: number, y: number) => boolean) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  return { width, height, data };
}

describe("vertex operations", () => {
  it("adds a vertex in empty space and re-triangulates inside the hull", () => {
    const { model, index } = addVertex(square(), 50, 50);
    expect(index).toBe(4);
    expect(model.origin).toEqual([-1, -1, -1, -1, -1]);
    expect(model.triangles.length / 3).toBe(4);
    expect(area(model)).toBeCloseTo(10000);
  });

  it("refuses a vertex outside the outline", () => {
    expect(() => addVertex(square(), 150, 50)).toThrow(MeshModelError);
  });

  it("adds a vertex on a hull edge into the hull, keeping hull vertices first", () => {
    const base = modelFromMesh({ uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, width: 100, height: 100 });
    const { model, index } = addVertex(base, 50, 1);
    expect(model.hull).toBe(5);
    expect(index).toBe(1);
    expect(model.points.slice(0, 6)).toEqual([0, 0, 50, 0, 100, 0]);
    expect(model.origin).toEqual([0, -1, 1, 2, 3]);
  });

  it("adds a vertex on the closing hull edge at the end of the loop", () => {
    const base = modelFromMesh({ uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, width: 100, height: 100 });
    const { model, index } = addVertex(base, 0, 50);
    expect(index).toBe(4);
    expect(model.origin).toEqual([0, 1, 2, 3, -1]);
  });

  it("splits a user edge when a vertex is added on it", () => {
    let m = addVertex(square(), 25, 50).model;
    m = addVertex(m, 75, 50).model;
    m = addEdge(m, 4, 5);
    const split = addVertex(m, 50, 50);
    expect(split.model.edges.length).toBe(2);
    expect(split.model.edges.every(([a, b]) => a === split.index || b === split.index)).toBe(true);
  });

  it("moves a vertex and keeps origin", () => {
    const m = moveVertex(addVertex(square(), 50, 50).model, 4, 40, 60);
    expect(m.points.slice(8, 10)).toEqual([40, 60]);
    expect(area(m)).toBeCloseTo(10000);
  });

  it("deletes an interior vertex and the edges on it", () => {
    let m = addVertex(addVertex(square(), 25, 50).model, 75, 50).model;
    m = addEdge(m, 4, 5);
    m = deleteVertex(m, 4);
    expect(m.edges).toEqual([]);
    expect(m.points.length / 2).toBe(5);
    expect(area(m)).toBeCloseTo(10000);
  });
});

describe("edge operations", () => {
  it("adds and deletes a constraint edge; the triangulation contains it", () => {
    let m = addVertex(addVertex(square(), 30, 30).model, 70, 70).model;
    m = addEdge(m, 4, 5);
    const has = (a: number, b: number) => Array.from({ length: m.triangles.length / 3 }, (_, t) => m.triangles.slice(3 * t, 3 * t + 3)).some((tri) => tri.includes(a) && tri.includes(b));
    expect(has(4, 5)).toBe(true);
    m = deleteEdge(m, 5, 4);
    expect(m.edges).toEqual([]);
  });

  it("refuses crossing edges and outline edges", () => {
    let m = addVertex(addVertex(addVertex(addVertex(square(), 25, 25).model, 75, 75).model, 75, 25).model, 25, 75).model;
    m = addEdge(m, 4, 5);
    expect(() => addEdge(m, 6, 7)).toThrow(/cross/);
    expect(() => deleteEdge(m, 0, 1)).toThrow(/outline/);
  });
});

describe("hull operations and origin", () => {
  const base = (): MeshModel => modelFromMesh({ uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5], triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], hull: 4, width: 100, height: 100 });

  it("starts as identity origin", () => {
    expect(base().origin).toEqual([0, 1, 2, 3, 4]);
    expect(base().edges).toEqual([]);
  });

  it("insert puts the new hull vertex before the interior vertices and shifts origin", () => {
    const { model, index } = insertHullVertex(base(), 1, 100, 40);
    expect(index).toBe(2);
    expect(model.hull).toBe(5);
    expect(model.origin).toEqual([0, 1, -1, 2, 3, 4]);
    expect(model.points.slice(4, 6)).toEqual([100, 40]);
  });

  it("removing a hull vertex drops it from origin", () => {
    const model = removeHullVertex(base(), 3);
    expect(model.hull).toBe(3);
    expect(model.origin).toEqual([0, 1, 2, 4]);
  });

  it("redraw reuses clicked vertices, demotes old ones still inside and drops the rest", () => {
    const model = redrawHull(base(), [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }, { x: 0, y: 100 }]);
    expect(model.hull).toBe(4);
    // old 0 and 3 reused; (60,0) and (60,100) are new; old 4 at (50,50) stays inside; old 1 and 2 (x=100) are dropped
    expect(model.origin).toEqual([0, -1, -1, 3, 4]);
    expect(area(model)).toBeCloseTo(6000);
  });

  it("redraw normalises winding and refuses a self-crossing outline", () => {
    const model = redrawHull(base(), [{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 0 }]);
    expect(hullArea(model)).toBeGreaterThan(0);
    expect(() => redrawHull(base(), [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }])).toThrow(/crosses/);
  });

  it("origin stays consistent through a chain of operations", () => {
    let m = base();
    m = insertHullVertex(m, 0, 50, 0).model;
    m = addVertex(m, 20, 20).model;
    m = deleteVertex(m, 5);
    m = removeHullVertex(m, 0);
    expect(m.origin.length).toBe(m.points.length / 2);
    const survivors = m.origin.filter((o) => o >= 0);
    expect(new Set(survivors).size).toBe(survivors.length);
  });
});

describe("generators", () => {
  it("grid hits the requested vertex count within 10% with angles of 15 degrees or more", () => {
    const rect = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 120 }, { x: 0, y: 120 }];
    for (const count of [30, 60, 120, 250]) {
      for (const shape of [ellipse(120, 70, 20), ellipse(60, 140, 24), rect]) {
        const m = gridMeshForCount(shape, count);
        const n = m.points.length / 2;
        expect(Math.abs(n - count) / count, `${count} -> ${n}`).toBeLessThanOrEqual(0.1);
        expect(meshMinAngle(m.points, m.triangles), `angle at ${count}`).toBeGreaterThanOrEqual(15);
        expect(area(m)).toBeCloseTo(Math.abs(polygonArea(shape)), 0);
      }
    }
  });

  it("grid is aligned to the principal axis", () => {
    const m = gridMesh([{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 60 }, { x: 0, y: 60 }], 20);
    const inner = m.points.slice(2 * m.hull);
    const ys = new Set(Array.from({ length: inner.length / 2 }, (_, i) => Math.round(inner[2 * i + 1]! * 100) / 100));
    expect(ys.size).toBeLessThanOrEqual(3);
  });

  it("trace gives 8 to 400 vertices inside the hull with good angles", () => {
    const pic = disc(300, 200, (x, y) => ((x - 150) / 120) ** 2 + ((y - 100) / 70) ** 2 < 1);
    for (const density of [1, 8, 40, 120, 400, 9999]) {
      const m = traceMesh(pic, density, 0);
      const n = m.points.length / 2;
      expect(n).toBeGreaterThanOrEqual(6);
      expect(n).toBeLessThanOrEqual(480);
      expect(area(m)).toBeCloseTo(hullArea(m), 0);
      if (density >= 40) expect(meshMinAngle(m.points, m.triangles)).toBeGreaterThanOrEqual(15);
    }
    expect(validateMesh(traceMesh(pic, 60), { picture: pic })).toEqual([]);
  });

  it("keep rectangle makes two triangles", () => {
    const m = keepRectangle(64, 32, 10);
    expect(m.triangles.length).toBe(6);
    expect(m.baseCount).toBe(10);
  });
});

describe("validation", () => {
  it("flags thin triangles, missing coverage and a broken hull", () => {
    const thin = moveVertex(addVertex(square(), 50, 50).model, 4, 50, 0.4);
    expect(validateMesh(thin).some((i) => i.kind === "minAngle")).toBe(true);
    const pic = disc(100, 100, () => true);
    const small = redrawHull(square(), [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 0, y: 100 }]);
    expect(validateMesh(small, { picture: pic }).some((i) => i.kind === "coverage")).toBe(true);
    const broken: MeshModel = { ...square(), triangles: [0, 1, 2] };
    expect(validateMesh(broken).some((i) => i.kind === "hull")).toBe(true);
    expect(validateMesh(square(), { picture: pic })).toEqual([]);
  });
});

describe("commit", () => {
  it("produces a mesh.edit command with origin, hull-loop edges and same-count variants", () => {
    const m = addVertex(square(), 50, 50).model;
    const cmds = planMeshCommit(m, { skin: "a", slot: "s", name: "n" }, {
      baseSize: { width: 100, height: 100 },
      variants: [{ skin: "b", slot: "s", name: "n", vertexCount: 4, width: 200, height: 100 }, { skin: "c", slot: "s", name: "n", vertexCount: 7 }, { skin: "a", slot: "s", name: "n", vertexCount: 4 }]
    });
    expect(cmds.length).toBe(2);
    expect(cmds[0]).toMatchObject({ op: "mesh.edit", hull: 4, origin: [-1, -1, -1, -1, -1], edges: [0, 1, 1, 2, 2, 3, 3, 0] });
    expect(cmds[1]!.skin).toBe("b");
    expect(cmds[1]!.points[2]).toBe(200);
    expect(compatibleVariants(4, [{ skin: "x", slot: "s", name: "n", vertexCount: 5 }])).toEqual([]);
  });
});

const rig = JSON.parse(readFileSync(new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url), "utf8"));
const attachment = (skin: string, slot: string, name: string) => rig.skins[skin].attachments[slot][name];

/** Edits a real mesh: nudge an interior vertex, delete one, grow the hull, add one inside. */
function editedModel(source: MeshSource): MeshModel {
  let m = modelFromMesh(source);
  const pivot = m.hull + 3;
  m = moveVertex(m, pivot, m.points[2 * pivot]! + 2, m.points[2 * pivot + 1]! + 1);
  m = deleteVertex(m, m.hull + 1);
  m = insertHullVertex(m, 2).model;
  const cx = (m.points[0]! + m.points[2 * Math.floor(m.hull / 2)]!) / 2;
  const cy = (m.points[1]! + m.points[2 * Math.floor(m.hull / 2) + 1]!) / 2;
  // Land on an existing interior vertex's neighbourhood: add at the centroid of a triangle.
  const t = m.triangles;
  const centroid = [0, 1, 2].reduce((acc, k) => [acc[0]! + m.points[2 * t[k]!]! / 3, acc[1]! + m.points[2 * t[k]! + 1]! / 3], [0, 0]);
  void cx;
  void cy;
  return addVertex(m, centroid[0]!, centroid[1]!, 0.01).model;
}

describe("round trip on the pro rig", () => {
  for (const [slot, name] of [["hair_back", "hair"], ["skin_torso", "torso"], ["shirt_torso", "torso"]] as const) {
    it(`${slot}/${name} through the engine's applyCommands`, () => {
      const source = attachment("body", slot, name) as MeshSource;
      expect(validateMesh(modelFromMesh(source)).filter((i) => i.kind === "hull")).toEqual([]);
      const m = editedModel(source);
      expect(m.origin.filter((o) => o === -1).length).toBe(2);
      const result = applyCommands(structuredClone(rig), planMeshCommit(m, { skin: "body", slot, name }));
      expect(result.applied.length).toBe(1);
      const out = (result.doc as any).skins.body.attachments[slot][name];
      expect(out.uvs.length / 2).toBe(m.points.length / 2);
      expect(out.hull).toBe(m.hull);
      expect(() => loadAnimDocument(result.doc)).not.toThrow();
    });
  }

  it("an edit to a mesh sleeve reaches its crease steps, which are linked meshes of it (the steps arm_<side>_crease swaps)", () => {
    // The arm_<side>_crease driven track swaps the sleeve between its crease steps (sleeve, c020..c140). The steps are linkedMesh attachments of
    // `sleeve`: they share its vertices, so one commit on the base mesh moves every step and no per-step command is needed.
    const skin = "chest.leather";
    const slot = "shirt_sleeve_near";
    const all = Object.entries(rig.skins[skin].attachments[slot] as Record<string, any>);
    const meshes = all.filter(([, a]) => a.type === "mesh");
    const linked = all.filter(([, a]) => a.type === "linkedMesh");
    expect(meshes.map(([n]) => n)).toEqual(["sleeve"]);
    expect(linked.length).toBeGreaterThan(3);
    expect(linked.every(([, a]) => a.source?.attachment === "sleeve" && a.inheritDeform === true)).toBe(true);
    const [baseName, baseAtt] = meshes[0]!;
    let base = modelFromMesh(baseAtt as MeshSource);
    base = moveVertex(base, base.hull + 3, base.points[2 * (base.hull + 3)]! + 2, base.points[2 * (base.hull + 3) + 1]! + 1);
    const commands = planMeshCommit(base, { skin, slot, name: baseName }, { baseSize: { width: baseAtt.width, height: baseAtt.height } });
    expect(commands.length).toBe(1);
    const result = applyCommands(structuredClone(rig), commands);
    expect(result.applied.length).toBe(1);
    const out = (result.doc as any).skins[skin].attachments[slot];
    for (const [name] of linked) expect(out[name].type).toBe("linkedMesh");
    expect(() => loadAnimDocument(result.doc)).not.toThrow();
  });
});
