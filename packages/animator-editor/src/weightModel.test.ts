import { readFileSync } from "node:fs";
import { adjacency, type WeightBone } from "@atlas-animator/core/tools/autoWeights";
import { describe, expect, it } from "vitest";
import { makeMirrorRig } from "./mirrorModel.js";
import {
  brushDab,
  cleanup,
  createTable,
  dabStep,
  distanceWeights,
  mirrorWeights,
  normalizeRow,
  rowSum,
  setRowWeight,
  sleeveInfluence,
  StrokeSpacer,
  toTableCommand,
  type BrushOptions,
  type SleeveArm,
  type SleeveParams,
  type WeightTable
} from "./weightModel.js";

interface Fixture {
  side: string;
  z: number;
  S: [number, number];
  E: [number, number];
  W: [number, number];
  shoulderRadius: number;
  centerX: number;
  params: SleeveParams;
  samples: { p: [number, number]; d: number; expected: Record<string, number>; pipeline: boolean }[];
}
const fixture = JSON.parse(readFileSync(new URL("./sleeveProfile.fixture.json", import.meta.url), "utf8")) as Fixture;

describe("sleeve profile", () => {
  const arm: SleeveArm = { S: fixture.S, E: fixture.E, W: fixture.W, shoulderRadius: fixture.shoulderRadius, centerX: fixture.centerX };
  it("matches swag_rig.py's sleeve_infl within 1e-3 on sample vertices", () => {
    expect(fixture.samples.length).toBeGreaterThan(50);
    let blended = 0;
    for (const s of fixture.samples) {
      const got = new Map(sleeveInfluence(arm, s.p, s.d, fixture.z, fixture.side, fixture.params));
      if (got.size > 1) blended++;
      for (const name of new Set([...got.keys(), ...Object.keys(s.expected)])) expect(Math.abs((got.get(name) ?? 0) - (s.expected[name] ?? 0))).toBeLessThan(1e-3);
    }
    expect(blended).toBeGreaterThan(20);
  });
  it("responds to its parameters", () => {
    const off = { ...fixture.params, CLAV_MAX: 0, INNER_SHARP: 0 };
    let differs = 0;
    for (const s of fixture.samples) {
      const a = sleeveInfluence(arm, s.p, s.d, fixture.z, fixture.side, fixture.params);
      const b = sleeveInfluence(arm, s.p, s.d, fixture.z, fixture.side, off);
      expect(b.reduce((t, [, w]) => t + w, 0)).toBeCloseTo(1, 9);
      if (JSON.stringify(a) !== JSON.stringify(b)) differs++;
    }
    expect(differs).toBeGreaterThan(5);
  });
});

function grid(n: number): { points: number[]; triangles: number[] } {
  const points: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) points.push(i * 10, j * 10);
  const triangles: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      triangles.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
  }
  return { points, triangles };
}

function randomTable(V: number, B: number, seed = 1): WeightTable {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const t = createTable(Array.from({ length: B }, (_, i) => `b${i}`), V);
  for (let v = 0; v < V; v++) {
    for (let b = 0; b < B; b++) t.data[v * B + b] = rnd() < 0.5 ? rnd() : 0;
    if (rowSum(t, v) === 0) t.data[v * B] = 1;
    normalizeRow(t, v);
  }
  return t;
}

describe("brush", () => {
  const g = grid(9);
  const nb = adjacency(81, g.triangles);
  const target = { points: g.points, neighbours: nb };
  for (const mode of ["add", "subtract", "smooth", "set"] as const) {
    it(`${mode} keeps rows at 1 and locked bones untouched`, () => {
      const t = randomTable(81, 4);
      const before = new Float32Array(t.data);
      const locked = new Set([2]);
      const options: BrushOptions = { mode, radius: 35, strength: 0.8, falloff: "smooth", value: 0.7 };
      const spacer = new StrokeSpacer(() => dabStep(options));
      let dabs = 0;
      for (const [x, y] of [[10, 10], [60, 40], [40, 70]] as const) {
        for (const at of spacer.advance(x, y)) {
          brushDab(t, target, 0, at.x, at.y, options, 0.9, locked);
          dabs++;
        }
      }
      expect(dabs).toBeGreaterThan(5);
      let moved = 0;
      for (let v = 0; v < 81; v++) {
        expect(rowSum(t, v)).toBeCloseTo(1, 5);
        expect(t.data[v * 4 + 2]).toBe(before[v * 4 + 2]);
        for (let b = 0; b < 4; b++) {
          expect(t.data[v * 4 + b]).toBeGreaterThanOrEqual(0);
          if (t.data[v * 4 + b] !== before[v * 4 + b]) moved++;
        }
      }
      expect(moved).toBeGreaterThan(0);
    });
  }
  it("add pulls weight from the other unlocked bones in proportion", () => {
    const t = createTable(["a", "b", "c"], 1);
    t.data.set([0, 0.75, 0.25]);
    setRowWeight(t, 0, 0, 0.5);
    expect(Array.from(t.data)).toEqual([0.5, 0.375, 0.125]);
  });
  it("a hard falloff paints the whole disc, a smooth one fades", () => {
    const run = (falloff: "hard" | "smooth") => {
      const t = createTable(["a", "b"], 2);
      t.data.set([0, 1, 0, 1]);
      brushDab(t, { points: [0, 0, 8, 0] }, 0, 0, 0, { mode: "add", radius: 10, strength: 1, falloff }, 1);
      return [t.data[0]!, t.data[2]!];
    };
    expect(run("hard")).toEqual([1, 1]);
    expect(run("smooth")[1]).toBeLessThan(run("smooth")[0]!);
  });
  it("spaces dabs a quarter radius apart along a path", () => {
    const sp = new StrokeSpacer(() => 2.5);
    expect(sp.advance(0, 0)).toHaveLength(1);
    expect(sp.advance(10, 0).map((p) => p.x)).toEqual([2.5, 5, 7.5, 10]);
  });
});

describe("cleanup and command", () => {
  it("caps influences, reports the dropped weight and builds a weights.table command", () => {
    const t = createTable(["a", "b", "c", "d", "e"], 2);
    t.data.set([0.4, 0.3, 0.2, 0.06, 0.04, 0.5, 0.5, 0, 0, 0]);
    const r = cleanup(t, { max: 3, min: 0.05 });
    expect(r.dropped.total).toBeCloseTo(0.1, 5);
    expect(r.dropped.vertices).toBe(1);
    for (let v = 0; v < 2; v++) expect(rowSum(r.table, v)).toBeCloseTo(1, 4);
    expect(r.table.data[4]).toBe(0);
    const cmd = toTableCommand(r.table, { skin: "body", slot: "torso", name: "torso" }, { max: 3 });
    expect(cmd.op).toBe("weights.table");
    expect(cmd.influences).toEqual(["a", "b", "c"]);
    expect(cmd.weights).toHaveLength(6);
    expect(cmd.max).toBe(3);
  });
});

describe("mirror near <-> far", () => {
  const bone = (name: string, x: number, y0: number, y1: number): WeightBone => ({ name, start: { x, y: y0 }, end: { x, y: y1 }, radius: 30 });
  const near = [bone("upper_arm_near", -100, 0, 100), bone("forearm_near", -100, 100, 200)];
  const far = [bone("upper_arm_far", 100, 0, 100), bone("forearm_far", 100, 100, 200)];
  const rig = makeMirrorRig([
    { name: "root" },
    { name: "upper_arm_near", parent: "root", x: -100, y: 0, rotation: 90 },
    { name: "upper_arm_far", parent: "root", x: 100, y: 0, rotation: 90 },
    { name: "forearm_near", parent: "upper_arm_near", x: 100, y: 0 },
    { name: "forearm_far", parent: "upper_arm_far", x: 100, y: 0 }
  ]);
  const cols = 9;
  const rows = 15;
  const mesh = (sign: number) => {
    const points: number[] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) points.push(sign * (100 + (i - 4) * 8), j * (200 / (rows - 1)));
    const triangles: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        triangles.push(a, a + 1, a + cols + 1, a, a + cols + 1, a + cols);
      }
    }
    return { points, triangles };
  };
  const nearMesh = mesh(-1);
  const farMesh = mesh(1);
  const ctx = { bones: [...near, ...far], partner: rig.partner, axisX: rig.axisX };
  const nearTable = distanceWeights(nearMesh.points, near, { power: 2 });

  it("finds the axis and pairs", () => {
    expect(rig.axisX).toBeCloseTo(0, 6);
    expect(rig.partner.get("upper_arm_near")).toBe("upper_arm_far");
  });
  it("a round trip near -> far -> near reproduces the weights", () => {
    const toFar = mirrorWeights({ mesh: nearMesh, table: nearTable }, farMesh.points, ctx);
    expect([...toFar.bones].sort()).toEqual(["forearm_far", "upper_arm_far"]);
    const expectedFar = distanceWeights(farMesh.points, far, { power: 2 });
    for (let v = 0; v < toFar.vertexCount; v++) {
      for (const name of toFar.bones) {
        const a = toFar.data[v * toFar.bones.length + toFar.bones.indexOf(name)]!;
        const b = expectedFar.data[v * 2 + expectedFar.bones.indexOf(name)]!;
        expect(Math.abs(a - b)).toBeLessThan(1e-3);
      }
    }
    const back = mirrorWeights({ mesh: farMesh, table: toFar }, nearMesh.points, ctx);
    for (let v = 0; v < back.vertexCount; v++) {
      for (const name of nearTable.bones) {
        const a = back.data[v * back.bones.length + back.bones.indexOf(name)]!;
        const b = nearTable.data[v * 2 + nearTable.bones.indexOf(name)]!;
        expect(Math.abs(a - b)).toBeLessThan(1e-3);
      }
    }
  });
  it("falls back to an x-mirror far from every bone", () => {
    const out = mirrorWeights({ mesh: nearMesh, table: nearTable }, [900, 50], { ...ctx, reachRadii: 0.1 });
    expect(rowSum(out, 0)).toBeCloseTo(1, 5);
  });
});
