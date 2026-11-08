import { describe, expect, it, vi } from "vitest";
import { testSkeleton } from "../../core/testHelpers.js";
type BoneInput = Parameters<typeof testSkeleton>[0]["bones"][number];
import { boneTable, buildSurface, bendShare } from "./build.js";
import { Poser } from "./correctives.js";
import { regionCovers } from "./gates.js";
import type { Pt } from "./geometry.js";
import type { SurfacePreset } from "./preset.js";
import { canonicalRig } from "./testRigs.js";
import { companionPoses, finalPoses } from "./validationCompanion.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/*
 * review: one regression test per
 * defect, plus the scale-capable Poser and the higher-order final-runtime poses.
 */

type Affine = { a: number; b: number; c: number; d: number; x: number; y: number };
const apply = (w: Affine, p: Pt): Pt => [w.a * p[0] + w.b * p[1] + w.x, w.c * p[0] + w.d * p[1] + w.y];
const invert = (w: Affine): Affine => {
  const det = w.a * w.d - w.b * w.c;
  const a = w.d / det, b = -w.b / det, c = -w.c / det, d = w.a / det;
  return { a, b, c, d, x: -(a * w.x + b * w.y), y: -(c * w.x + d * w.y) };
};

describe(" review defects", () => {
  it("1: rigid-region coverage follows the region bone (head tilt +15), not the bind polygon", () => {
    const rig = canonicalRig("template7-shoulder");
    const head = rig.built.preset.regions.find((r) => r.bone === "head");
    expect(head?.keep).toBeDefined();
    const poser = new Poser(rig.document, rig.built);
    const o: Pt = [rig.document.canvas.originX, rig.document.canvas.originY];
    poser.pose({});
    const bind = { ...poser.skeleton.getBone("head").world };
    const q: Pt = [510, 650];
    const at = (pose: Record<string, number>) => {
      poser.pose(pose);
      return (regionCovers(rig, poser.skeleton).find((c) => c.name === head?.name) as { covers: (p: Pt) => boolean }).covers;
    };
    expect(at({})(q)).toBe(true);
    const tilted = at({ head: 15 });
    // The bind point is no longer under the head art; the point the art carried it to is.
    expect(tilted(q)).toBe(false);
    const w = poser.skeleton.getBone("head").world;
    const local = apply(invert(bind), [q[0] - o[0], q[1] - o[1]]);
    const moved = apply(w, local);
    expect(tilted([moved[0] + o[0], moved[1] + o[1]])).toBe(true);
    // Alpha: a keep-polygon point over transparent art does not cover (bounding-box corner of the crop).
    const [x0, y0] = head?.crop as [number, number, number, number];
    expect(at({})([x0 + 0.5, y0 + 0.5])).toBe(false);
  });

  it("2: bind transforms follow the runtime's inheritance semantics (onlyTranslation, noRotation, noScale, normal)", () => {
    for (const inherit of ["normal", "noScale", "onlyTranslation", "noRotation"] as const) {
      const preset = {
        canvas: { width: 400, height: 400, originX: 100, originY: 100 },
        bones: [
          { name: "root" },
          { name: "parent", parent: "root", at: [150, 150], toward: [200, 200] },
          { name: "child", parent: "parent", at: [180, 160], toward: [230, 160], inherit },
          { name: "tip", parent: "child", at: [200, 160], toward: [210, 160] }
        ]
      } as unknown as SurfacePreset;
      const { table, raw } = boneTable(preset);
      const skeleton = testSkeleton({ bones: raw as unknown as BoneInput[] });
      for (const name of ["parent", "child", "tip"]) {
        const w = skeleton.getBone(name).world;
        const t = table.get(name) as { at: Pt; rotation: number };
        expect((Math.atan2(w.c, w.a) * 180) / Math.PI, `${inherit} ${name} rotation`).toBeCloseTo(t.rotation, 3);
        expect(w.x + 100, `${inherit} ${name} x`).toBeCloseTo(t.at[0], 3);
        expect(w.y + 100, `${inherit} ${name} y`).toBeCloseTo(t.at[1], 3);
      }
      // The requested world placement is what the runtime computes.
      const tip = skeleton.getBone("tip").world;
      expect([tip.x + 100, tip.y + 100].map((v) => Number(v.toFixed(3)))).toEqual([200, 160]);
      expect((Math.atan2(skeleton.getBone("child").world.c, skeleton.getBone("child").world.a) * 180) / Math.PI).toBeCloseTo(0, 3);
    }
  });

  it("3: a bend may not hand weight to a bone a vertex's support mask forbids", () => {
    const rig = canonicalRig("template7-shoulder");
    const preset = structuredClone(rig.built.preset);
    const built = rig.built;
    const to = preset.chain.branches?.flatMap((b) => b.bones).find((b) => b === "neck") as string;
    const from = preset.base;
    const fromIndex = built.skin.bones.indexOf(from);
    const toIndex = built.skin.bones.indexOf(to);
    const fixed = new Set(preset.skin.regions.fixed.map((f) => f.name));
    const hasFrom = (i: number) => (built.skin.weights[i] as [number, number][]).some(([b]) => b === fromIndex);
    // A narrow strip from a masked vertex (a patch or core that forbids the neck); the first vertex in
    // index order the strip reaches with a base share must be that vertex.
    let probe: { a: Pt; b: Pt } | undefined;
    for (let v = 0; v < built.support.length && !probe; v++) {
      const s = built.support[v];
      if (!s || fixed.has(s.region) || s.allowed.includes(toIndex) || !hasFrom(v)) continue;
      const p = built.skin.points[v] as Pt;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const bend = { name: "probe", from, to, a: [p[0] - dx, p[1] - dy] as Pt, b: [p[0] + dx, p[1] + dy] as Pt, r0: 0, r1: 0.5 };
        const first = built.skin.points.findIndex((q, i) => bendShare(bend, q) > 0 && hasFrom(i));
        if (first === v) { probe = bend; break; }
      }
    }
    expect(probe).toBeDefined();
    const bends = [...(preset.skin.regions.bends ?? []), { name: "probe", from, to, a: probe?.a as Pt, b: probe?.b as Pt, r0: 0, r1: 0.5 }];
    expect(() => buildSurface({ ...preset, skin: { ...preset.skin, regions: { ...preset.skin.regions, bends } } })).toThrow(/bend 'probe' reaches vertex \d+ .* in support region '.+', which does not allow 'neck'/);
  });

  it("4: Poser takes scale (noScale children keep their size); the final poses hold higher-order and breathing combinations", () => {
    const rig = canonicalRig("template7-shoulder");
    const poser = new Poser(rig.document, rig.built);
    poser.pose({ "chest.scaleX": 1.1, "chest.scaleY": 1.05 });
    const chest = poser.skeleton.getBone("chest").world;
    expect(Math.hypot(chest.a, chest.c)).toBeCloseTo(1.1, 6);
    const neck = poser.skeleton.getBone("neck").world;
    expect(Math.hypot(neck.a, neck.c)).toBeCloseTo(1, 6);
    const poses = finalPoses(rig);
    const breathing = poses.filter((p) => p.pose["chest.scaleX"] === 1.012 && p.pose["chest.scaleY"] === 1.01);
    expect(breathing.length).toBeGreaterThan(10);
    expect(poses.some((p) => p.origin.includes("others at high"))).toBe(true);
    // Combined: an arm driver, the lean and breathing in one pose.
    expect(breathing.some((p) => (p.pose.upper_arm_l ?? 0) !== 0 && (p.pose.chest ?? 0) !== 0)).toBe(true);
    const companion = companionPoses(rig).find((p) => p.scale?.chest);
    expect(companion?.scale?.chest).toEqual({ x: 1.012, y: 1.01 });
    expect(Object.keys(companion?.rotate ?? {}).some((k) => k.includes("."))).toBe(false);
  });
});
