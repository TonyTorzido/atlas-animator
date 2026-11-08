import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A rig build solves every corrective target (pass 3b): several seconds per preset.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { loadPreset, type SurfacePreset } from "./preset.js";
import { buildRig, type SurfaceRig } from "./output.js";
import { canonicalRig } from "./testRigs.js";
import { conformToSkin, inheritAlongMesh } from "./build.js";
import { FLANK_TOLERANCE, garmentPieces, geometryGates, meshTopology, pieceDepth, structureGates, type GarmentPiece } from "./gates.js";
import { dist, distanceToPolyline, pointInPolygon, type Pt } from "./geometry.js";

/*
 * Phase pass 3a: preset regions and hard support masks, polygon draw groups, conform
 * garments, junction-trimmed contours and their gates, proved on both presets from data alone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, "../../../fixtures/canonical", `${name}.preset.json`);
const presetOf = (name: string): SurfacePreset => loadPreset(fixture(name));
// Shared across the surface test files (one build per process, see testRigs.ts).
const rigOf = (name: string): SurfaceRig => canonicalRig(name);

describe.each(["template7-shoulder", "creature-leg"])("pass 3a regions: %s", (name) => {
  it("support masks: every regioned vertex has only its allowed influences, forbidden ones exactly zero", () => {
    const { built } = rigOf(name);
    let regioned = 0;
    built.skin.weights.forEach((inf, i) => {
      const sup = built.support[i];
      if (!sup) return;
      regioned++;
      for (const [b] of inf) expect(sup.allowed).toContain(b);
      expect(inf.reduce((s, [, w]) => s + w, 0)).toBeCloseTo(1, 9);
    });
    expect(regioned).toBeGreaterThan(built.skin.points.length / 2);
    expect(structureGates(built).support.violations).toBe(0);
  });

  it("fixed regions and the anchored apex are exactly the base bone; hinge bands carry no body influence; the root patches no distal one", () => {
    const { built } = rigOf(name);
    const preset = built.preset;
    const bones = built.skin.bones;
    for (const f of preset.skin.regions.fixed) {
      expect((built.fixedVertices[f.name] ?? []).length).toBeGreaterThan(3);
      for (const v of built.fixedVertices[f.name] ?? []) expect(built.skin.weights[v]).toEqual([[bones.indexOf(f.bone), 1]]);
    }
    expect(built.anchors.length).toBe(1);
    for (const a of built.anchors) expect(built.skin.weights[a.index]).toEqual([[bones.indexOf(preset.base), 1]]);
    const body = new Set([bones.indexOf(preset.base), ...(preset.girdle ? [bones.indexOf(preset.girdle.bone)] : [])]);
    const chain = preset.chain.bones;
    built.support.forEach((sup, i) => {
      if (!sup) return;
      const names = sup.region.split("+");
      const inf = built.skin.weights[i] as [number, number][];
      const hit = preset.skin.regions.patches.filter((x) => names.includes(x.name));
      const inBand = hit.some((x) => x.side === "both");
      for (const p of hit) {
        if (p.side === "both") for (const [b] of inf) expect(body.has(b)).toBe(false);
        else if (!inBand) for (const [b] of inf) expect(chain.indexOf(bones[b] as string)).toBeLessThan(1);
      }
    });
    // Patches may overlap geometrically (a root patch running into a hinge band); there the band's mask applies.
    built.support.forEach((sup, i) => {
      if (!sup || !sup.region.includes("+")) return;
      const names = sup.region.split("+");
      if (preset.skin.regions.patches.some((x) => x.side === "both" && names.includes(x.name))) for (const [b] of built.skin.weights[i] as [number, number][]) expect(body.has(b)).toBe(false);
    });
  });

  it("the inner transition is searched within the declared W range by the solver and ends before the first hinge band", () => {
    const { built } = rigOf(name);
    const inner = built.patches.find((p) => p.side === "inner");
    expect(inner).toBeDefined();
    const p = inner as NonNullable<typeof inner>;
    const declared = (built.preset.skin.regions.patches.find((x) => x.name === p.name)?.extent as { width: [number, number] }).width;
    expect(p.ratio).toBeGreaterThanOrEqual(declared[0]);
    expect(p.ratio).toBeLessThanOrEqual(declared[1]);
    // Pass 3b: chosen by solving both root limits (the shortest feasible ratio).
    expect(p.feasible).toBe(true);
    expect(p.extent).toBeCloseTo((p.ratio as number) * (p.width as number), 1);
    const band = built.preset.skin.regions.patches.find((x) => x.side === "both" && x.joint === built.preset.chain.bones[1]);
    // On its own (fold) side the hinge band is short: the inner transition ends before it.
    expect(band?.fold).toBeDefined();
    // It ends before the hinge band reaches back on the inner (notch) side of the limb.
    const apexSign = built.apexes[0]?.sign ?? -1;
    const half = (band?.fold === "-" ? -1 : 1) === apexSign ? (band?.foldBand as number) : (band?.band as number);
    expect(p.sEnd).toBeLessThan((band?.s as number) - half);
    // Outer and inner bands differ (asymmetric): the outer chain is longer.
    const outer = built.patches.find((x) => x.side === "outer");
    expect((outer?.extent ?? 0) > p.extent * 2).toBe(true);
  });

  it("draw groups come from the preset polygons and the limb group carries the whole limb outline", () => {
    const { built } = rigOf(name);
    const groups = built.preset.skin.groups;
    // Limb segments (upper arm, forearm: one polygon, split by chain range) are the polygon groups.
    const limbs = groups.flatMap((g, i) => (g.polygon ? [i] : []));
    const limb = limbs[0] as number;
    expect(limb).toBeGreaterThan(0);
    const poly = groups[limb]?.polygon as Pt[];
    built.triangleGroups.forEach((g, t) => {
      const c = [0, 1, 2].reduce<Pt>((acc, k) => {
        const p = built.skin.points[built.skin.triangles[t * 3 + k] as number] as Pt;
        return [acc[0] + p[0] / 3, acc[1] + p[1] / 3];
      }, [0, 0]);
      expect(limbs.includes(g)).toBe(pointInPolygon(c, poly));
    });
    const s = structureGates(built);
    expect(s.ownership.ownerMismatch).toBe(0);
    expect(s.ownership.looseEnds).toEqual([]);
    expect(s.ownership.sharedSpans).toBe(0);
  });

  it("the limb outline chain starts hidden under the garment overlay and ends at the apex", () => {
    const { built } = rigOf(name);
    const limbs = new Set(built.preset.skin.groups.filter((g) => g.polygon).map((g) => g.slot));
    const pieces = built.contours.filter((c) => limbs.has(c.owner) && c.mesh === "skin");
    expect(pieces.length).toBeGreaterThan(0);
    // One chain: each piece starts where another ends, except the first.
    const starts = pieces.filter((c) => !pieces.some((o) => o !== c && o.points[o.points.length - 1] === c.points[0]));
    expect(starts.length).toBe(1);
    expect(pieces.some((c) => c.points[c.points.length - 1] === built.apexes[0]?.index)).toBe(true);
    // The chain's first vertex lies inside the overlay's opaque footprint at bind (hidden, not a junction start).
    const start = built.skin.points[(starts[0] as (typeof pieces)[number]).points[0] as number] as Pt;
    const overlay = garmentPieces(built).find((p) => p.slot === built.overlays[0]?.name) as GarmentPiece;
    expect(pieceDepth(overlay, [built.skin.points, ...built.garments.map((g) => g.points)], start)).toBeGreaterThan(0);
  });

  it("conform garments: every vertex embedded (on the skin) or inheriting along the garment mesh (off it), every triangle inside one skin triangle", () => {
    const { built } = rigOf(name);
    const conform = built.garments.filter((g) => g.conform);
    expect(conform.length).toBe(1);
    for (const g of conform) {
      expect((g.embed?.vertices.length ?? 0) + (g.offSkin?.length ?? 0)).toBe(g.points.length);
      expect((g.embed?.vertices.length ?? 0) / g.points.length).toBeGreaterThan(0.8);
      // An off-skin vertex carries exactly the weights of an embedded vertex of the same garment.
      for (const v of g.offSkin ?? []) expect(g.embed?.vertices.some((e) => JSON.stringify(g.weights[e]) === JSON.stringify(g.weights[v]))).toBe(true);
    }
    const reg = structureGates(built).registration.conformCrossings;
    for (const r of reg) {
      expect(r.triangles).toBeGreaterThan(10);
      expect(r.crossing).toBe(0);
    }
  });

  it("connectivity: the skin and garments are single manifold surfaces bounded by their hulls", () => {
    const { built } = rigOf(name);
    for (const m of structureGates(built).connectivity.meshes) expect(m).toMatchObject({ components: 1, nonManifold: 0, boundaryMismatch: 0 });
  });

  it("fixed flank, apex anchor, occlusion and doubled-at-rest gates hold over every sweep", () => {
    const geo = geometryGates(rigOf(name));
    expect(geo.flankLock.vertices).toBeGreaterThan(3);
    expect(geo.flankLock.maxDeviation).toBeLessThanOrEqual(FLANK_TOLERANCE);
    // Riding apexes stay within their pose-dependent allowance (base + girdle elevation when coupled).
    for (const a of geo.apexMotion) expect(a.excess).toBeLessThanOrEqual(FLANK_TOLERANCE);
    expect(geo.occlusion.length).toBe(1);
    for (const o of geo.occlusion) expect(o.maxDepth).toBeLessThanOrEqual(o.limit);
    expect(geo.doubledAtRest).toEqual([]);
  });
});

describe("pass 3a review fixes", () => {
  it("the doubled gate counts a stroke stacked on another even when one occludes the other", () => {
    const preset = presetOf("template7-shoulder");
    // The torso outline carried on along the strap top, under the tank's edge (drawn later, so
    // the torso stroke is occluded there): a shared span, which must read as doubled.
    const torso = preset.skin.contours.find((c) => c.owner === "torso") as { to: unknown };
    torso.to = [432, 680];
    // Without the strap-corner contact zone (where the arm outline leaves the trim).
    preset.skin.junctions = (preset.skin.junctions ?? []).filter((j) => j.name !== "shoulder_top");
    (preset.skin.contours.find((c) => c.owner === "upper_arm") as { from: unknown }).from = [421, 682.5];
    const rig = buildRig(preset, dirname(fixture("template7-shoulder")));
    const geo = geometryGates({ ...rig, built: { ...rig.built, preset: { ...rig.built.preset, sweeps: [] } } });
    expect(geo.doubledAtRest.some((d) => [d.a, d.b].includes("torso/outline") && [d.a, d.b].includes("tank_armhole/edge"))).toBe(true);
  });

  it("hinge bands are asymmetric: long on the closing (fold) side, short on the opening side (pass 3b finding)", () => {
    const { built } = rigOf("template7-shoulder");
    const elbow = built.preset.skin.regions.patches.find((p) => p.name === "elbow") as { s: number; band: number; foldBand: number; fold: "+" | "-" };
    // Positive forearm rotation turns the forearm towards +v: +v is the closing side.
    expect(elbow.fold).toBe("+");
    const sign = elbow.fold === "-" ? -1 : 1;
    let openReach = 0;
    let foldReach = 0;
    built.support.forEach((sup, i) => {
      if (!sup?.region.split("+").includes("elbow")) return;
      const c = built.skin.chainSV?.[i] as { s: number; v: number };
      const d = elbow.s - c.s;
      if (c.v * sign > built.preset.skin.topology.halfWidth / 2) foldReach = Math.max(foldReach, d);
      if (c.v * sign < -built.preset.skin.topology.halfWidth / 2) openReach = Math.max(openReach, d);
    });
    expect(openReach).toBeLessThanOrEqual(elbow.band + 1e-9);
    // Compact hinge: the closing band covers the crease (r tan(70/2) ~ 28 px) and stays under half the limb width.
    expect(foldReach).toBeGreaterThan(elbow.band);
    expect(foldReach).toBeLessThanOrEqual(elbow.foldBand + 1e-9);
    expect(elbow.foldBand).toBeLessThan(built.preset.skin.topology.halfWidth);
    expect(foldReach).toBeLessThanOrEqual(elbow.foldBand + 1e-9);
  });

  it("inheritAlongMesh: every vertex takes its nearest source along the edges, not across a gap", () => {
    // A U-shaped strip: 0-1-2 along the bottom, 3 up the right, 4 top right; source 0 and 4.
    const points: Pt[] = [[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [0, 10]];
    const tris = [0, 1, 5, 1, 2, 3, 1, 3, 5, 3, 4, 5];
    const from = inheritAlongMesh(points, tris, new Set([0, 4]));
    expect(from[0]).toBe(0);
    expect(from[4]).toBe(4);
    expect(from[1]).toBe(0);
    expect(from[3]).toBe(4);
  });
});

describe("pass 3a gates catch the failures they exist for", () => {
  it("occlusion: a limb group that starts at the forearm lets the upper arm slide under the tank at -15", () => {
    const preset = presetOf("template7-shoulder");
    const arm = preset.skin.groups[1] as { polygon?: Pt[] };
    // Only the distal arm (the pass-2 'from = 136' split) above the tank.
    arm.polygon = [[250, 860], [420, 860], [420, 1100], [250, 1100]];
    const rig = buildRig(preset, dirname(fixture("template7-shoulder")));
    const geo = geometryGates({ ...rig, built: { ...rig.built, preset: { ...rig.built.preset, sweeps: [] } } });
    const tank = geo.occlusion[0] as { maxDepth: number; limit: number };
    expect(tank.maxDepth).toBeGreaterThan(tank.limit);
    // ... and the outline now runs over two groups (ownership).
    expect(structureGates(rig.built).ownership.ownerMismatch).toBeGreaterThan(0);
  });

  it("support: a patch whose bones omit an influence the field generates still ends with that influence exactly zero", () => {
    const preset = presetOf("creature-leg");
    const knee = preset.skin.regions.patches.find((p) => p.name === "knee") as { bones: string[] };
    knee.bones = ["shin"];
    const { built } = buildRig(preset, dirname(fixture("creature-leg")));
    const thigh = built.skin.bones.indexOf("thigh");
    built.support.forEach((sup, i) => {
      if (sup?.region.split("+").includes("knee")) expect((built.skin.weights[i] as [number, number][]).some(([b]) => b === thigh)).toBe(false);
    });
  });

  it("meshTopology finds a hole and a split surface", () => {
    // A 2x1 strip of two quads (hull 0..5), then the same with the middle triangles removed.
    const full = [0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4];
    expect(meshTopology("strip", full, 6)).toMatchObject({ components: 1, nonManifold: 0, boundaryMismatch: 0 });
    const split = [0, 1, 5, 2, 3, 4];
    const r = meshTopology("split", split, 6);
    expect(r.components).toBe(2);
    expect(r.boundaryMismatch).toBeGreaterThan(0);
  });

  it("conformToSkin clips a triangulation to an outline without crossing its edges", () => {
    // Two triangles of a unit square; an outline square crossing the diagonal.
    const points: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const tris = [0, 1, 2, 0, 2, 3];
    const c = conformToSkin([[2, 2], [8, 2], [8, 8], [2, 8]], points, tris);
    // Hull: 4 corners (two on the diagonal, which become hull vertices); no interior skin vertex.
    expect(c.hull).toBe(4);
    let area = 0;
    for (let t = 0; t < c.triangles.length; t += 3) {
      const [a, b, d] = [0, 1, 2].map((k) => c.points[c.triangles[t + k] as number] as Pt) as [Pt, Pt, Pt];
      area += Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2;
      // No output triangle straddles the diagonal x = y.
      const side = [a, b, d].map((p) => Math.sign(Math.round((p[0] - p[1]) * 1e6)));
      expect(side.includes(1) && side.includes(-1)).toBe(false);
    }
    expect(area).toBeCloseTo(36, 6);
    // An outline crossing the diagonal mid-edge gets the crossing as a hull vertex.
    const d = conformToSkin([[1, 4], [6, 4], [6, 9], [1, 9]], points, tris);
    expect(d.points.slice(0, d.hull).some((p) => Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[1] - 4) < 1e-9)).toBe(true);
    expect(d.points.slice(0, d.hull).some((p) => Math.abs(p[0] - 6) < 1e-9 && Math.abs(p[1] - 6) < 1e-9)).toBe(true);
  });
});
