import { describe, expect, it } from "vitest";
import { fillColors, heatRamp } from "./heatMesh.js";
import { SkinPreview } from "./skinPreview.js";
import { chainBetween, restPoints, tableOfMesh, variantBase, variantNames, withColumn } from "./weightsTool.js";
import { brushDab, createTable, dabStep, normalizeRow, StrokeSpacer, type BrushOptions } from "./weightModel.js";
import { adjacency } from "./vertexSelect.js";

const identity = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };

describe("weights tool helpers", () => {
  it("reads a weighted mesh into a table and its rest points", () => {
    const mesh = { bones: ["a", "b"], uvs: [0, 0, 1, 1], triangles: [], vertices: [2, 0, 1, 2, 0.25, 1, 3, 4, 0.75, 1, 1, 5, 6, 1] };
    const table = tableOfMesh(mesh)!;
    expect(table.bones).toEqual(["a", "b"]);
    expect(Array.from(table.data)).toEqual([0.25, 0.75, 0, 1]);
    const world = (n: string) => (n === "a" ? { ...identity, x: 10 } : { ...identity, y: 20 });
    const pts = restPoints(mesh, "a", world);
    expect(pts[0]).toBeCloseTo(0.25 * 11 + 0.75 * 3, 6);
    expect(pts[1]).toBeCloseTo(0.25 * 2 + 0.75 * (4 + 20), 6);
    expect(tableOfMesh({ uvs: [0, 0], vertices: [0, 0], triangles: [] })).toBeNull();
  });

  it("finds crease variants and the bone chain", () => {
    const att = { sleeve: { type: "mesh", uvs: [0, 0, 1, 1] }, sleeve_c001: { type: "mesh", uvs: [0, 0, 1, 1] }, sleeve_c002: { type: "mesh", uvs: [0, 0] }, other: { type: "mesh", uvs: [0, 0, 1, 1] } };
    expect(variantBase("sleeve_l_c012")).toBe("sleeve_l");
    expect(variantNames(att, "sleeve")).toEqual(["sleeve_c001"]);
    expect(variantNames(att, "sleeve_c001")).toEqual(["sleeve"]);
    expect(variantNames(att, "other")).toEqual([]);
    const parents: Record<string, string | null> = { chest: "root", clav: "chest", arm: "clav", fore: "arm" };
    expect(chainBetween((n) => parents[n] ?? null, "chest", "fore")).toEqual(["chest", "clav", "arm", "fore"]);
    expect(chainBetween((n) => parents[n] ?? null, "arm", "chest")).toEqual(["arm"]);
  });

  it("adds a zero column", () => {
    const t = createTable(["a"], 2);
    t.data.set([1, 1]);
    const w = withColumn(t, "b");
    expect(w.bones).toEqual(["a", "b"]);
    expect(Array.from(w.data)).toEqual([1, 0, 1, 0]);
  });

  it("colours: ramp ends, active and blended modes", () => {
    expect(heatRamp(0)[2]).toBeGreaterThan(heatRamp(0)[0]);
    expect(heatRamp(1)[0]).toBeGreaterThan(heatRamp(1)[2]);
    const t = createTable(["upper_arm_l", "forearm_l"], 2);
    t.data.set([1, 0, 0.5, 0.5]);
    const out = new Float32Array(8);
    fillColors(t, "active", 0, out);
    expect(out[3]).toBeCloseTo(0.7, 5);
    expect(out[0]).toBeGreaterThan(out[4]!);
    fillColors(t, "all", 0, out);
    expect(out[7]).toBeCloseTo(0.7, 5);
  });
});

describe("brush speed", () => {
  it("one dab + re-skin on an 840-vertex, 10-bone mesh costs well under one 60 fps frame", () => {
    const W = 28;
    const H = 30;
    const V = W * H;
    const B = 10;
    const table = createTable(Array.from({ length: B }, (_, i) => `b${i}`), V);
    const pts = new Float32Array(V * 2);
    const tris: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = y * W + x;
        pts[v * 2] = x * 6;
        pts[v * 2 + 1] = y * 6;
        table.data[v * B + Math.min(B - 1, Math.floor((y / H) * B))] = 1;
        if (x + 1 < W && y + 1 < H) tris.push(v, v + 1, v + W, v + 1, v + W + 1, v + W);
      }
    }
    for (let v = 0; v < V; v++) normalizeRow(table, v);
    const worlds = new Float64Array(B * 6);
    for (let b = 0; b < B; b++) worlds.set([1, 0, 0, 1, 0, 0], b * 6);
    const skin = new SkinPreview(table, pts, worlds);
    const opts: BrushOptions = { mode: "smooth", radius: 40, strength: 0.5, falloff: "smooth" };
    const target = { points: pts, neighbours: adjacency(V, tris) };
    const spacer = new StrokeSpacer(() => dabStep(opts));
    const colors = new Float32Array(V * 4);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      for (const d of spacer.advance(10 + i * 0.8, 80 + 60 * Math.sin(i / 9))) {
        const changed = brushDab(table, target, 3, d.x, d.y, opts);
        skin.update(worlds);
        fillColors(table, "active", 3, colors, 0.7, changed);
      }
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`BENCH ${V} vertices x ${B} bones: mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)} ms, p95 ${p95.toFixed(3)} ms per pointer move`);
    expect(p95).toBeLessThan(16.7);
  });
});
