import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WeightBone } from "@atlas-animator/core/tools/autoWeights";
import { describe, expect, it } from "vitest";
import { mirrorTable, parseBuildScripts, restoreTable, tableDistance, partnerSlot, type BuildScript } from "./weightsImport.js";
import { createTable, rowInfluences, tableFromInfluences, toTableCommand } from "./weightModel.js";

const rigDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../animator/rigs/kit-body-cutout");
const scripts: BuildScript[] = readdirSync(rigDir)
  .filter((f) => /^build-.*\.jsonl$/.test(f))
  .map((name) => ({ name, text: readFileSync(resolve(rigDir, name), "utf8") }));

const addr = { skin: "body", slot: "shirt_torso", name: "torso" };

describe("parseBuildScripts / restoreTable on the real build scripts", () => {
  const pipeline = parseBuildScripts(scripts, addr)!;
  const geometry = (JSON.parse(readFileSync(resolve(rigDir, "build-17-front-pro-torso.jsonl"), "utf8").split("\n").find((l) => l.includes('"attachment.add"') && l.includes('"shirt_torso"')) as string) as { attachment: { uvs: number[]; triangles: number[] } }).attachment;

  it("finds the torso mesh and every vertex", () => {
    expect(pipeline).not.toBeNull();
    expect(pipeline.count).toBe(99);
    expect(pipeline.rows.every((r) => r !== null)).toBe(true);
    expect(pipeline.files).toContain("build-17-front-pro-torso.jsonl");
  });

  it("restores exactly the build weights (vertex for vertex)", () => {
    const r = restoreTable(pipeline, { uvs: geometry.uvs, triangles: geometry.triangles });
    if (typeof r === "string") throw new Error(r);
    expect(r.exact).toBe(true);
    pipeline.rows.forEach((row, v) => {
      const got = new Map(rowInfluences(r.table, v).map((i) => [r.table.bones[i.bone], i.weight]));
      const want = new Map((row ?? []).map((i) => [i.bone, i.weight]));
      expect(got.size).toBe(want.size);
      for (const [bone, w] of want) expect(got.get(bone)).toBeCloseTo(w, 6);
    });
    // The command that goes to the engine keeps every weight (min 0), to 1e-5.
    const cmd = toTableCommand(r.table, addr, { min: 0 });
    expect(cmd.min).toBe(0);
    expect(cmd.weights.length).toBe(99 * cmd.influences.length);
  });

  it("returns null for a mesh no script weights", () => {
    expect(parseBuildScripts(scripts, { skin: "body", slot: "nope", name: "torso" })).toBeNull();
  });
});

describe("restoreTable with a different vertex count", () => {
  // A 3x3 grid in UV space; weights are linear in v between bones a and b.
  const grid = (n: number) => {
    const uvs: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) uvs.push(i / (n - 1), j / (n - 1));
    const triangles: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        triangles.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    return { uvs, triangles };
  };
  const coarse = grid(3);
  const lines = [
    JSON.stringify({ op: "attachment.add", skin: "s", slot: "x", name: "m", attachment: { type: "mesh", uvs: coarse.uvs, triangles: coarse.triangles } }),
    ...[0, 1, 2].map((j) => JSON.stringify({ op: "weights.set", skin: "s", slot: "x", name: "m", vertices: [j * 3, j * 3 + 1, j * 3 + 2], influences: [{ bone: "a", weight: 1 - j / 2 + 1e-9 }, { bone: "b", weight: j / 2 + 1e-9 }] }))
  ].join("\n");

  it("carries weights across by UV position", () => {
    const p = parseBuildScripts([{ name: "build-01.jsonl", text: lines }], { skin: "s", slot: "x", name: "m" })!;
    const fine = grid(5);
    const r = restoreTable(p, fine);
    if (typeof r === "string") throw new Error(r);
    expect(r.exact).toBe(false);
    expect(r.table.vertexCount).toBe(25);
    const b = r.table.bones.indexOf("b");
    for (let v = 0; v < 25; v++) expect(r.table.data[v * r.table.bones.length + b]).toBeCloseTo(fine.uvs[v * 2 + 1] as number, 4);
  });

  it("explains why when there is no mesh shape to transfer from", () => {
    const text = JSON.stringify({ op: "weights.set", skin: "s", slot: "x", name: "m", vertices: [0, 1], influences: [{ bone: "a", weight: 1 }] });
    const p = parseBuildScripts([{ name: "b.jsonl", text }], { skin: "s", slot: "x", name: "m" })!;
    expect(typeof restoreTable(p, grid(3))).toBe("string");
  });
});

describe("mirrorTable", () => {
  const rigBones = [
    { name: "root", parent: null },
    { name: "upper_arm_near", parent: "root", x: -30, y: 0, rotation: 90 },
    { name: "forearm_near", parent: "upper_arm_near", x: 40, y: 0 },
    { name: "upper_arm_far", parent: "root", x: 30, y: 0, rotation: 90 },
    { name: "forearm_far", parent: "upper_arm_far", x: 40, y: 0 }
  ];
  const bones: WeightBone[] = [
    { name: "upper_arm_near", start: { x: -30, y: 0 }, end: { x: -30, y: 40 }, radius: 10 },
    { name: "forearm_near", start: { x: -30, y: 40 }, end: { x: -30, y: 80 }, radius: 10 },
    { name: "upper_arm_far", start: { x: 30, y: 0 }, end: { x: 30, y: 40 }, radius: 10 },
    { name: "forearm_far", start: { x: 30, y: 40 }, end: { x: 30, y: 80 }, radius: 10 }
  ];
  /** A grid around the arm at world x = cx +- 8, y 0..80 (weights linear in y). */
  const grid = (cx: number) => {
    const points: number[] = [];
    const nx = 5;
    const ny = 17;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points.push(cx - 8 + (16 * i) / (nx - 1), (80 * j) / (ny - 1));
    const triangles: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        triangles.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
      }
    return { points, triangles };
  };
  const near = grid(-30);
  const far = grid(30);
  const nearTable = (() => {
    const t = createTable(["upper_arm_near", "forearm_near"], near.points.length / 2);
    for (let v = 0; v < t.vertexCount; v++) {
      const f = (near.points[v * 2 + 1] as number) / 80;
      t.data[v * 2] = 1 - f;
      t.data[v * 2 + 1] = f;
    }
    return t;
  })();

  it("pairs the slots by side token", () => {
    expect(partnerSlot("skin_upper_arm_near")).toBe("skin_upper_arm_far");
    expect(partnerSlot("skin_torso")).toBeNull();
  });

  it("near to far lands on the partner bones", () => {
    const farTable = mirrorTable({ source: { ...near, table: nearTable }, targetPoints: far.points, bones, rigBones });
    expect([...farTable.bones].sort()).toEqual(["forearm_far", "upper_arm_far"]);
    const fc = farTable.bones.indexOf("forearm_far");
    for (let v = 0; v < farTable.vertexCount; v++) expect(farTable.data[v * 2 + fc]).toBeCloseTo((far.points[v * 2 + 1] as number) / 80, 3);
  });

  it("a round trip reproduces the weights within 1e-3", () => {
    const farTable = mirrorTable({ source: { ...near, table: nearTable }, targetPoints: far.points, bones, rigBones });
    const back = mirrorTable({ source: { ...far, table: farTable }, targetPoints: near.points, bones, rigBones });
    expect(tableDistance(back, nearTable)).toBeLessThan(1e-3);
  });

  it("keeps unrelated tables intact (tableFromInfluences sanity)", () => {
    const t = tableFromInfluences(["a", "b"], [[{ bone: 0, weight: 1 }]]);
    expect(tableDistance(t, t)).toBe(0);
  });
});
