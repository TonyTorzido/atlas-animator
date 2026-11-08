import { computeGeometryWorldVertices, type Bone, type MeshGeometryData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { packWorlds, restLocals, SkinPreview, skinVertices, type WorldMatrix } from "./skinPreview.js";
import { createTable, normalizeRow } from "./weightModel.js";

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function bone(angle: number, x: number, y: number, scale = 1): { world: WorldMatrix } {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return { world: { a: c, b: s, c: -s, d: c, x, y } };
}

function scene(V: number, B: number) {
  const names = Array.from({ length: B }, (_, i) => `b${i}`);
  const table = createTable(names, V);
  for (let v = 0; v < V; v++) {
    for (let k = 0; k < 4; k++) table.data[v * B + Math.floor(rnd() * B)] = rnd();
    normalizeRow(table, v, null, 0);
  }
  const rest = Array.from({ length: V * 2 }, () => rnd() * 400);
  const restBones = Array.from({ length: B }, () => bone(rnd() * 6, rnd() * 300, rnd() * 300));
  const posed = restBones.map(() => bone(rnd() * 6, rnd() * 300, rnd() * 300, 0.8 + rnd() * 0.4));
  return { table, rest, restBones, posed };
}

describe("skin preview", () => {
  it("matches the core computeGeometryWorldVertices within 1e-4", () => {
    const { table, rest, restBones, posed } = scene(120, 10);
    const B = 10;
    const worlds = packWorlds(restBones);
    const locals = restLocals(rest, worlds, B);
    const counts: number[] = [];
    const influenceBones: number[] = [];
    const weights: number[] = [];
    const bind: number[] = [];
    for (let v = 0; v < table.vertexCount; v++) {
      let n = 0;
      for (let b = 0; b < B; b++) {
        const w = table.data[v * B + b]!;
        if (w <= 0) continue;
        n++;
        influenceBones.push(b);
        weights.push(w);
        bind.push(locals[(v * B + b) * 2]!, locals[(v * B + b) * 2 + 1]!);
      }
      counts.push(n);
    }
    const geometry = {
      vertexCount: table.vertexCount,
      weighted: true,
      bind: Float64Array.from(bind),
      counts: Uint8Array.from(counts),
      influenceBones: Uint16Array.from(influenceBones),
      weights: Float64Array.from(weights)
    } as unknown as MeshGeometryData;
    const expected = new Float64Array(table.vertexCount * 2);
    computeGeometryWorldVertices(geometry, posed[0] as unknown as Bone, posed as unknown as Bone[], null, expected);
    const preview = new SkinPreview(table, rest, worlds);
    const got = preview.update(packWorlds(posed));
    for (let i = 0; i < expected.length; i++) expect(Math.abs(got[i]! - expected[i]!)).toBeLessThan(1e-4);
  });

  it("reproduces the rest positions at the rest pose", () => {
    const { table, rest, restBones } = scene(50, 6);
    const worlds = packWorlds(restBones);
    const got = new SkinPreview(table, rest, worlds).update(worlds);
    for (let i = 0; i < rest.length; i++) expect(Math.abs(got[i]! - rest[i]!)).toBeLessThan(1e-3);
  });

  it("skins 840 vertices x 10 bones in at most 2 ms", () => {
    const { table, rest, restBones, posed } = scene(840, 10);
    const locals = restLocals(rest, packWorlds(restBones), 10);
    const worlds = packWorlds(posed);
    const out = new Float32Array(840 * 2);
    for (let i = 0; i < 50; i++) skinVertices(table, locals, worlds, out);
    const runs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      skinVertices(table, locals, worlds, out);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    expect(runs[Math.floor(runs.length / 2)]!).toBeLessThan(2);
  });
});
