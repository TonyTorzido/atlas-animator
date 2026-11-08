import { describe, expect, it } from "vitest";
import { ChainFrame } from "./geometry.js";
import { fitArmChain, fitCircle, migrateChain, type FitReference, type Pt } from "./pivotFit.js";

const at = (c: Pt, r: number, deg: number): Pt => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];

describe("pivot fit (checkpoint 1)", () => {
  it("recovers a circle from points and lines together", () => {
    const c: Pt = [440, 715];
    const points = [10, 60, 120, 170].map((d) => at(c, 110, d));
    const lines = [30, 80, 140].map((d) => ({ at: at(c, 150, d), dir: [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)] as Pt }));
    const f = fitCircle(points, lines);
    expect(f.center[0]).toBeCloseTo(440, 6);
    expect(f.center[1]).toBeCloseTo(715, 6);
    expect(f.radius).toBeCloseTo(110, 6);
    expect(fitCircle([], lines).center[0]).toBeCloseTo(440, 6);
  });

  it("fits a two-bone chain and measures drawn angles against the rest", () => {
    const S: Pt = [440, 715];
    const pose = (raise: number, bend: number) => {
      const E = at(S, 100, 120 + raise);
      return { E, W: at(E, 90, 120 + raise + bend) };
    };
    const refs: FitReference[] = [
      ...[0, 30, 60, 90].map((r) => {
        const { W } = pose(r, 0);
        const d = at([0, 0], 1, 120 + r);
        return { name: `raise${r}`, use: "fit" as const, fit: { axis: { at: W, dir: [-d[0], -d[1]] as Pt }, wrist: W } };
      }),
      ...[[0, 35], [30, 70], [60, 90]].map(([r, b]) => {
        const { E, W } = pose(r as number, b as number);
        return { name: `bent${r}-${b}`, use: "fit" as const, fit: { elbow: E, wrist: W } };
      })
    ];
    const rest = pose(0, 0);
    const d0 = at([0, 0], 1, 120);
    const fit = fitArmChain(refs, { axis: { at: rest.W, dir: [-d0[0], -d0[1]] }, wrist: rest.W });
    expect(fit.root.center[0]).toBeCloseTo(440, 4);
    expect(fit.lengths.proximal).toBeCloseTo(100, 3);
    expect(fit.lengths.distal).toBeCloseTo(90, 3);
    expect(fit.extremes.proximal[1]).toBeCloseTo(90, 3);
    expect(fit.extremes.distal?.[1]).toBeCloseTo(90, 3);
  });

  it("migrates chain-relative preset data without moving the canvas geometry", () => {
    const oldChain = new ChainFrame([[436, 729], [391.5, 809], [352, 893]], [40], -200, 600);
    const newChain = new ChainFrame([[441.6, 715.6], [391.5, 809], [352, 893]], [40], -200, 600);
    const skin = { silhouette: [{ s: 45, v: 40 }, { s: 140, v: -38 }], topology: { from: 4, joints: [{ s: oldChain.jointS[1] as number }] }, cores: [{ sMin: 20, sMax: oldChain.jointS[1] as number }] };
    const before = skin.silhouette.map((p) => oldChain.point(p.s, p.v));
    migrateChain(skin, oldChain, newChain);
    skin.silhouette.forEach((p, i) => {
      const q = newChain.point(p.s, p.v);
      expect(Math.hypot(q[0] - (before[i] as Pt)[0], q[1] - (before[i] as Pt)[1])).toBeLessThan(0.2);
    });
    expect(skin.topology.joints[0]?.s).toBeCloseTo(newChain.jointS[1] as number, 1);
    expect(skin.cores[0]?.sMax).toBeCloseTo(newChain.jointS[1] as number, 1);
  });
});
