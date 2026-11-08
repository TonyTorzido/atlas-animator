import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A rig build solves every corrective target (pass 3b): several seconds per preset.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { loadAnimDocument } from "../../core/formatLoader.js";
import { bakeResidual, Poser } from "./correctives.js";
import { rotateAbout, type Pt } from "./geometry.js";
import { canonicalRig } from "./testRigs.js";
import { loadPreset } from "./preset.js";
import { InteriorSolver, makeRun, runTargets, type SolveFrame } from "./solver.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, "../../../fixtures/canonical", `${name}.preset.json`);

/** A strip of nx x ny cells: left column fixed, right column a rigid handle; everything else free. */
function strip(nx: number, ny: number, size: number) {
  const points: Pt[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) points.push([i * size, j * size]);
  const id = (i: number, j: number) => j * (nx + 1) + i;
  const triangles: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      triangles.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      triangles.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  const handle = points.map((p) => p[0] === 0 || p[0] === nx * size);
  return { points, triangles, free: handle.map((h) => !h), right: points.map((p) => p[0] === nx * size) };
}

const minLinearBlend = (points: Pt[], triangles: number[], moved: (p: Pt, u: number) => Pt, nx: number, size: number) => {
  // Linear blend skinning of the strip: weight of the moving handle = x / length.
  const x = points.map((p) => {
    const w = p[0] / (nx * size);
    const q = moved(p, 1);
    return [p[0] * (1 - w) + q[0] * w, p[1] * (1 - w) + q[1] * w] as Pt;
  });
  let min = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [x[triangles[t] as number], x[triangles[t + 1] as number], x[triangles[t + 2] as number]] as [Pt, Pt, Pt];
    const [a0, b0, c0] = [points[triangles[t] as number], points[triangles[t + 1] as number], points[triangles[t + 2] as number]] as [Pt, Pt, Pt];
    const area = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
    min = Math.min(min, area(a, b, c) / area(a0, b0, c0));
  }
  return min;
};

describe("interior solver (pass 3b)", () => {
  it("never lets a triangle fall below the determinant floor where linear blending flips", () => {
    const nx = 8;
    const ny = 2;
    const size = 10;
    const { points, triangles, free, right } = strip(nx, ny, size);
    const pivot: Pt = [nx * size * 0.5, ny * size * 0.5];
    // The right handle swings 150 degrees about the strip's middle: a plain linear blend collapses the strip below the floor.
    const moved = (p: Pt, u: number): Pt => rotateAbout(p, pivot, 150 * u);
    expect(minLinearBlend(points, triangles, moved, nx, size)).toBeLessThan(0.05);
    const solver = new InteriorSolver(points, triangles, free, points.map(() => false), { floor: 0.2, margin: 0.05, spring: 400, regions: [], areaTolerance: 0.1 });
    const frameAt = (u: number): SolveFrame => ({
      base: points.map((p, i) => (right[i] ? moved(p, u) : p)),
      springs: points.map(() => null)
    });
    const res = solver.continuation({ x: points.map((p) => [p[0], p[1]] as Pt), scale: [] }, frameAt, { steps: 150 });
    expect(res.ok).toBe(true);
    expect(solver.minRatio(res.state.x).min).toBeGreaterThan(0.2);
    // The handles were honoured exactly.
    res.state.x.forEach((p, i) => {
      if (right[i]) expect(Math.hypot(p[0] - moved(points[i] as Pt, 1)[0], p[1] - moved(points[i] as Pt, 1)[1])).toBeLessThan(1e-9);
    });
  });

  it("reports a pose it cannot reach without inverting, instead of returning a folded target", () => {
    const nx = 4;
    const ny = 2;
    const size = 10;
    const { points, triangles, free, right } = strip(nx, ny, size);
    // The right handle is pushed through the left one (mirrored past it): no valid interior exists.
    const moved = (p: Pt, u: number): Pt => [p[0] - u * 2 * nx * size, p[1]];
    const solver = new InteriorSolver(points, triangles, free, points.map(() => false), { floor: 0.2, margin: 0.05, spring: 400, regions: [], areaTolerance: 0.1 });
    const frameAt = (u: number): SolveFrame => ({ base: points.map((p, i) => (right[i] ? moved(p, u) : p)), springs: points.map(() => null) });
    const res = solver.continuation({ x: points.map((p) => [p[0], p[1]] as Pt), scale: [] }, frameAt, { steps: 40 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/continuation stalled/);
    // What it kept is still valid: the failure is reported, the mesh is never folded.
    expect(solver.minRatio(res.state.x).min).toBeGreaterThan(0.2 - 1e-9);
  });

  it("boundary curves reproduce the setup boundary at the zero pose and keep their parameters", () => {
    const hull: Pt[] = [[0, 0], [10, 1], [20, 3], [30, 2], [40, 0], [40, 20], [0, 20]];
    const run = makeRun(hull, [1, 2, 3], 0, 4, false, false);
    const identity: [number, number, number, number] = [1, 0, 0, 1];
    const at0 = runTargets(run, hull[0] as Pt, hull[4] as Pt, identity, identity);
    at0.points.forEach((p, k) => expect(Math.hypot(p[0] - (hull[k + 1] as Pt)[0], p[1] - (hull[k + 1] as Pt)[1])).toBeLessThan(1e-9));
    expect(at0.lobe).toBe(false);
    // Rotating both anchors rigidly rotates the run rigidly (same curve parameters, same detail).
    const r = (p: Pt) => rotateAbout(p, [0, 0], 30);
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const turned = runTargets(run, r(hull[0] as Pt), r(hull[4] as Pt), [c, -s, s, c], [c, -s, s, c]);
    turned.points.forEach((p, k) => {
      const q = r(hull[k + 1] as Pt);
      expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-6);
    });
  });
});

describe("residual baking (pass 3b)", () => {
  const rig = canonicalRig("creature-leg");

  it("single-driver keys reproduce the solved target exactly; with the grids on top they stay within the silhouette tolerance", () => {
    const singlesOnly = new Poser(loadAnimDocument({ ...(rig.raw as object), drivenGrids: [] }), rig.built);
    const final = new Poser(rig.document, rig.built);
    for (const c of rig.bake.singles) {
      for (const at of c.seeds) {
        const pose = at === 0 ? {} : { [c.bone]: at };
        const target = rig.solver.solve(pose);
        expect(target.ok).toBe(true);
        const worstOf = (poser: Poser) => {
          poser.pose(pose);
          const got = poser.vertices(rig.built.skin);
          return Math.max(...got.map((p, i) => Math.hypot(p[0] - (target.x[i] as Pt)[0], p[1] - (target.x[i] as Pt)[1])));
        };
        expect(worstOf(singlesOnly)).toBeLessThan(0.01); // offsets stored to 1e-4 in bone space, as float32
        expect(rig.solver.silhouetteError((final.pose(pose), final.vertices(rig.built.skin)), target).shape).toBeLessThan(rig.solver.silhouette);
      }
    }
  });

  it("a residual baked against a document is zero against that document plus the bake", () => {
    const base = loadAnimDocument({ ...(rig.built.document as object), driven: [], drivenGrids: [] });
    const target = rig.solver.solve({ thigh: 45, shin: 20 });
    expect(target.ok).toBe(true);
    const first = bakeResidual(base, rig.built, target);
    expect(first.max).toBeGreaterThan(0.5); // linear blend skinning alone misses the target
    const skinName = rig.built.preset.skinName ?? "body";
    const deform = { [skinName]: { [rig.built.skin.slot]: { [rig.built.skin.attachment]: { offset: 0, vertices: first.encoded } } } };
    const baked = loadAnimDocument({ ...(rig.built.document as object), driven: [], drivenGrids: [{ name: "probe", x: { bone: "thigh", at: [0, 45] }, y: { bone: "shin", at: [0, 20] }, keys: [{ deform: {} }, { deform: {} }, { deform: {} }, { deform }] }] });
    expect(bakeResidual(baked, rig.built, target).max).toBeLessThan(0.01);
  });

  it("every gate-relevant key and cell sample passed adaptive refinement on the creature", () => {
    expect(rig.bake.unsolved).toEqual([]);
    expect(rig.bake.interpolation.samples).toBeGreaterThan(100);
    expect(rig.bake.interpolation.failing).toBe(0);
    expect(rig.bake.interpolation.minRatio).toBeGreaterThan(0.2);
  });
});
