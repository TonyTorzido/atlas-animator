import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A rig build solves every corrective target (pass 3b): several seconds per preset.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import type { MeshAttachment } from "../../core/attachments.js";
import { loadPreset } from "./preset.js";
import { buildRig, type SurfaceRig } from "./output.js";
import { canonicalRig } from "./testRigs.js";
import { Poser } from "./correctives.js";
import { segmentCross, type Pt } from "./geometry.js";
import { CONFORM_MERGE_GAME_PX, topologyRows } from "./build.js";

/*
 * Phase pass 2 (design review items 1, 2 and 8): the apex fan topology and embedded garment
 * vertices, proved on both presets (a humanoid shoulder and a creature hip), from data alone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, "../../../fixtures/canonical", `${name}.preset.json`);
// Shared across the surface test files (one build per process, see testRigs.ts).
const rigOf = (name: string): SurfaceRig => canonicalRig(name);

describe.each(["template7-shoulder", "creature-leg"])("surface builder: %s", (name) => {
  it("the notch apex is a hull vertex and the rows short of it fan into it", () => {
    const { built } = rigOf(name);
    expect(built.apexes.length).toBe(1);
    const apex = built.apexes[0] as (typeof built.apexes)[number];
    expect(apex.index).toBeLessThan(built.skin.hull);
    const fans = built.rows.filter((r) => r.fan);
    expect(fans.length).toBeGreaterThanOrEqual(2);
    for (const r of fans) expect(r.ids[0]).toBe(apex.index);
    // Every row up to the apex is a fan row; no plain row ends at the apex.
    for (const r of built.rows) if (r.s <= apex.s) expect(r.fan).toBe(true);
    for (const r of built.rows.filter((x) => !x.fan)) expect(r.ids).not.toContain(apex.index);
  });

  it("no row crosses another row or the apex", () => {
    const { built } = rigOf(name);
    const p = built.skin.points;
    const segs = built.rows.flatMap((r, ri) => r.ids.slice(1).map((b, k) => ({ ri, a: r.ids[k] as number, b })));
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const s = segs[i] as (typeof segs)[number];
        const t = segs[j] as (typeof segs)[number];
        if (s.ri === t.ri || s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue;
        const x = segmentCross(p[s.a] as Pt, p[s.b] as Pt, p[t.a] as Pt, p[t.b] as Pt);
        if (x && x.t > 1e-6 && x.t < 1 - 1e-6) crossings++;
      }
    }
    expect(crossings).toBe(0);
  });

  it("the apex stays on the body (root weight 0) and the inner silhouette ramps monotonically along s", () => {
    const { built } = rigOf(name);
    const apex = built.apexes[0] as (typeof built.apexes)[number];
    const alpha = built.skin.alphas[0] as number[];
    expect(alpha[apex.index]).toBe(0);
    const hull = built.skin.hull;
    let last = 0;
    for (let k = 1; k < hull; k++) {
      const i = (((apex.index + k * apex.walk) % hull) + hull) % hull;
      const s = (built.skin.chainSV?.[i] as { s: number }).s;
      if (s >= apex.s + apex.reach) break;
      expect(alpha[i] as number).toBeGreaterThanOrEqual(last - 1e-9);
      last = alpha[i] as number;
    }
  });

  it("embedded garment vertices are bit-identical to the skin point under them at every tested pose", () => {
    const rig = rigOf(name);
    const { built } = rig;
    const garment = built.garments.find((g) => g.embed);
    expect(garment).toBeDefined();
    const g = garment as NonNullable<typeof garment>;
    expect((g.embed?.vertices.length ?? 0) / g.points.length).toBeGreaterThan(0.8);
    const poser = new Poser(rig.document, built);
    const sk = poser.skeleton;
    const bones = built.preset.bones.filter((b) => b.limits);
    for (const t of [0, 0.25, 1]) {
      const pose = Object.fromEntries(bones.map((b) => [b.name, (b.limits as [number, number])[0] + t * ((b.limits as [number, number])[1] - (b.limits as [number, number])[0])]));
      poser.pose(pose);
      const skinSlot = sk.getSlot(built.skin.slot);
      const skin = sk.meshWorldVertices(sk.getAttachment(skinSlot, built.skin.attachment) as MeshAttachment, skinSlot.bone);
      const slot = sk.getSlot(g.slot);
      const world = sk.meshWorldVertices(sk.getAttachment(slot, g.attachment) as MeshAttachment, slot.bone);
      g.embed?.vertices.forEach((v, k) => {
        const point = g.embed?.points[k] as number | [number, number, number, number, number];
        const [a, b, c, wa, wb] = typeof point === "number" ? [point, point, point, 1, 0] : point;
        const wc = typeof point === "number" ? 0 : 1 - wa - wb;
        for (let comp = 0; comp < 2; comp++) {
          expect(world[v * 2 + comp]).toBe(Math.fround((skin[a * 2 + comp] as number) * wa + (skin[b * 2 + comp] as number) * wb + (skin[c * 2 + comp] as number) * wc));
        }
      });
    }
  });
});

describe("topologyRows", () => {
  it("keeps authored rows, fills cores and respects the minimum gap", () => {
    const rows = topologyRows({ from: 0, to: 100, halfWidth: 10, columns: 5, core: 20, minRowGap: 4, joints: [{ s: 50, band: 10, rows: 3 }], extraRows: [52] });
    expect(rows).toContain(52);
    for (let k = 1; k < rows.length; k++) expect((rows[k] as number) - (rows[k - 1] as number)).toBeGreaterThanOrEqual(4 - 1e-9);
    for (let k = 1; k < rows.length; k++) expect((rows[k] as number) - (rows[k - 1] as number)).toBeLessThanOrEqual(20 + 1e-9);
  });
});

/*
 * Plan 3d-1 fix review (the sandwich): a garment overlay is a band of the conform garment mesh
 * drawn right after its `above` group; it owns its trim; the draw order is derived from data.
 */
describe("garment overlays", () => {
  it("template7: the armhole overlay draws after the upper arm and before the forearm, owns the trim and stays in its band", () => {
    const { built } = rigOf("template7-shoulder");
    expect(built.drawOrder).toEqual(["torso", "tank", "upper_arm", "tank_armhole", "forearm", "hand", "head"]); //  r3: the art fist region
    const o = built.overlays[0] as (typeof built.overlays)[number];
    expect(o).toMatchObject({ name: "tank_armhole", garment: "tank", above: "upper_arm", contours: ["edge"], fillBand: 8 });
    const tank = built.garments[0] as (typeof built.garments)[number];
    expect(Object.keys(tank.groups ?? {})).toEqual(["tank", "tank_armhole"]);
    expect(o.range[1] - o.range[0]).toBeGreaterThan(10);
    expect(built.contours.filter((c) => c.mesh === "tank").map((c) => `${c.owner}/${c.name}`)).toEqual(["tank/hem", "tank/flank", "tank_armhole/edge", "tank/neckline"]); //: the tank owns its hem stroke (over the shorts waistband)
    // Every overlay vertex lies within the trim's half width plus the fill band of the trim centreline,
    // plus the near-coincident merge: the drawn centreline is the merged outline, which may sit
    // up to the merge tolerance from the sampled one the band was offset from.
    const merge = (CONFORM_MERGE_GAME_PX * built.preset.figureHeight) / built.preset.gamePixels;
    const edge = (built.contours.find((c) => c.owner === "tank_armhole") as (typeof built.contours)[number]).points.map((i) => tank.points[i] as Pt);
    const near = (p: Pt) => Math.min(...edge.slice(1).map((b, k) => {
      const a = edge[k] as Pt;
      const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2)) : 0;
      return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1]));
    }));
    for (let t = o.range[0]; t < o.range[1]; t++) for (let k = 0; k < 3; k++) expect(near(tank.points[tank.triangles[t * 3 + k] as number] as Pt)).toBeLessThanOrEqual(6 + 8 + merge + 0.01);
    // The document draws the overlay as a group slot of the tank mesh.
    expect((built.document.slots as { name: string }[]).map((x) => x.name)).toEqual(built.drawOrder);
  });

  it("creature: the band's cuff overlay draws above the leg (non-humanoid input)", () => {
    const { built } = rigOf("creature-leg");
    expect(built.drawOrder).toEqual(["body", "band", "leg", "band_cuff", ...built.drawOrder.slice(4)]);
    expect(built.overlays.map((o) => `${o.name} above ${o.above}`)).toEqual(["band_cuff above leg"]);
  });

  it("fails the build when an overlay is listed in drawOrder", () => {
    const preset = loadPreset(fixture("template7-shoulder"));
    preset.drawOrder = ["torso", "tank", "upper_arm", "tank_armhole", "forearm", "head"];
    expect(() => buildRig(preset, dirname(fixture("template7-shoulder")))).toThrow(/is derived/);
  });
});

describe("bone trees in the surface builder ()", () => {
  const creature = () => loadPreset(resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/canonical/creature-leg.preset.json"));

  it("refuses a malformed tree by name: a limb-chain bone in a branch, a broken parent link", async () => {
    const { buildSurface } = await import("./build.js");
    const preset = creature();
    const limb = preset.chain.bones[0] as string;
    const parent = preset.bones.find((b) => b.name === limb)?.parent as string;
    expect(() => buildSurface({ ...preset, chain: { ...preset.chain, branches: [{ parent, bones: [limb] }] } })).toThrow(/already in the limb chain/);
    const other = preset.bones.find((b) => b.name !== limb && b.parent !== undefined && b.parent !== preset.bones[0]?.name && !preset.chain.bones.includes(b.name));
    if (other) expect(() => buildSurface({ ...preset, chain: { ...preset.chain, branches: [{ parent: preset.bones[0]?.name as string, bones: [other.name] }] } })).toThrow(/hangs from/);
  });

  it("a bend names only skin influences or branch bones", async () => {
    const { buildSurface } = await import("./build.js");
    const preset = loadPreset(fixture("template7-shoulder"));
    const bends = [{ name: "bad", from: preset.base, to: "nowhere", a: [0, 0] as [number, number], b: [0, 10] as [number, number] }];
    expect(() => buildSurface({ ...preset, skin: { ...preset.skin, regions: { ...preset.skin.regions, bends } } })).toThrow(/neither the base, the girdle nor a chain.branches bone/);
  });

  it("bendShare: 0 before a, 1 past b, eased between, cut off across the axis past r1", async () => {
    const { bendShare } = await import("./build.js");
    const bend = { name: "n", from: "x", to: "y", a: [0, 100] as [number, number], b: [0, 0] as [number, number], r0: 10, r1: 20 };
    expect(bendShare(bend, [0, 120])).toBe(0);
    expect(bendShare(bend, [0, -5])).toBe(1);
    expect(bendShare(bend, [0, 50])).toBeCloseTo(0.5, 6);
    expect(bendShare(bend, [5, -5])).toBe(1);
    expect(bendShare(bend, [25, -5])).toBe(0);
  });

  it("template7 trunk: the limb and girdle shares are exactly those of the build without bends; the neck stub is rigid on the neck (the head art rides on top)", async () => {
    const { buildSurface } = await import("./build.js");
    // The shared canonical build (testRigs) is the tree; only the bend-free variant is built here.
    const { built: a } = rigOf("template7-shoulder");
    const tree = a.preset;
    expect(tree.chain.branches?.length).toBeGreaterThan(0);
    // The same (extent-searched) preset as the canonical build, minus the bends.
    const plain = structuredClone(tree);
    delete plain.skin.regions.bends;
    const b = buildSurface(plain);
    expect(a.skin.points).toEqual(b.skin.points);
    const limb = [...(tree.girdle ? [tree.girdle.bone] : []), ...tree.chain.bones];
    const share = (w: [number, number][], bones: readonly string[], name: string) => w.find(([j]) => bones[j] === name)?.[1] ?? 0;
    a.skin.weights.forEach((w, i) => {
      for (const name of limb) expect(share(w, a.skin.bones, name)).toBeCloseTo(share(b.skin.weights[i] as [number, number][], b.skin.bones, name), 12);
      expect(w.length).toBeLessThanOrEqual(4);
    });
    const neck = (tree.skin.regions.bends ?? []).find((x) => tree.chain.branches?.some((br) => br.bones.includes(x.to) && br.bones.indexOf(x.to) > br.bones.indexOf(tree.base)));
    expect(neck).toBeDefined();
    // Past the zone's end, near its axis: (almost) rigid on the bend's bone, the base share gone.
    const near = Math.max(neck?.r0 ?? 0, 0.15 * (neck?.r1 ?? 0));
    const past = a.skin.points.flatMap((p, i) => (p[1] < (neck?.b[1] as number) - 2 && Math.abs(p[0] - (neck?.b[0] as number)) <= near ? [i] : []));
    expect(past.length).toBeGreaterThan(3);
    for (const v of past) {
      const w = a.skin.weights[v] as [number, number][];
      expect(share(w, a.skin.bones, neck?.to as string)).toBeGreaterThan(0.9);
    }
  });
});
