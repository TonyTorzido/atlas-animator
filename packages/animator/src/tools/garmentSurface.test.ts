/*
 * Atlas Animator: original implementation.
 *
 * Plan design review: garment layering over underwear, the per-garment outline colour and the
 * covered-texel mask of the per-frame coverage check, on the committed body rig and jacket domain.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GARMENT_STROKE, buildGarmentSurface, coveredTexelMask, dressGarment, type GarmentDomain } from "./garmentSurface.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = JSON.parse(readFileSync(join(ROOT, "fixtures/test-rigs/body/template7-shoulder-legs.anim.json"), "utf8"));
const domain: GarmentDomain = JSON.parse(readFileSync(join(ROOT, "fixtures/garments/kungfu-jacket.domain.json"), "utf8"));
const slotNames = (doc: any) => (doc.slots as { name: string }[]).map((s) => s.name);

describe("garment surface", () => {
  it("draws the trunk above every underwear layer, hidden or not", () => {
    for (const hides of [["tank"], []]) {
      const build = buildGarmentSurface(raw, domain, { name: "jacket", margin: domain.margin, strokeWidth: 10, hides });
      const order = slotNames(dressGarment(raw, build, hides));
      expect(order.indexOf("jacket")).toBeGreaterThan(order.indexOf("shorts"));
      expect(order.indexOf("jacket")).toBeGreaterThan(order.indexOf("tank"));
      expect(order.indexOf("jacket")).toBeLessThan(order.indexOf("upper_arm"));
    }
  });

  it("draws a cuffed sleeve over the fist and fist copies but under a held item on the hand bone ()", () => {
    const rig = structuredClone(raw);
    const at = slotNames(rig).indexOf("hand");
    const skinKey = Object.keys(rig.skins)[0] as string;
    const atts = rig.skins[skinKey].attachments;
    rig.slots.splice(at + 1, 0, { name: "hand_copy", bone: "hand_l" }, { name: "blade", bone: "hand_l" }, { name: "hand_glow", bone: "hand_l" });
    atts.hand_copy = { fist: structuredClone(atts.hand.fist) };
    atts.blade = { blade: { type: "mesh", path: "blade", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 0, 10], hull: 3, width: 10, height: 10 } };
    atts.hand_glow = { fist: structuredClone(atts.hand.fist) };
    const build = buildGarmentSurface(rig, domain, { name: "jacket", margin: domain.margin, strokeWidth: 10, hides: ["tank"] });
    const order = slotNames(dressGarment(rig, build, ["tank"]));
    expect(order.indexOf("jacket_forearm")).toBeGreaterThan(order.indexOf("hand_copy"));
    expect(order.indexOf("jacket_forearm")).toBeLessThan(order.indexOf("blade"));
    expect(order.indexOf("jacket_forearm")).toBeLessThan(order.indexOf("hand_glow"));
    // without a held item the sleeve still covers the fist (the cuff hem overlaps the wrist)
    const plain = slotNames(dressGarment(raw, buildGarmentSurface(raw, domain, { name: "jacket", margin: domain.margin, strokeWidth: 10, hides: ["tank"] }), ["tank"]));
    expect(plain.indexOf("jacket_forearm")).toBeGreaterThan(plain.indexOf("hand"));
    expect(plain.indexOf("jacket_forearm_r")).toBeGreaterThan(plain.indexOf("hand_r"));
  });

  it("strokes the garment in its own outline colour (near-black by default)", () => {
    const colours = (d: GarmentDomain) => new Set(Object.values(buildGarmentSurface(raw, d, { name: "jacket", margin: d.margin, strokeWidth: 10, hides: ["tank"] }).contours).flatMap((byName) => Object.values(byName).map((c) => c.color as string)));
    expect([...colours(domain)]).toEqual([domain.stroke?.color]);
    const { stroke: _drop, ...plain } = domain;
    expect([...colours(plain as GarmentDomain)]).toEqual([DEFAULT_GARMENT_STROKE]);
  });

  it("masks the covered material of the skin texture only", () => {
    const skin = raw.skins[Object.keys(raw.skins)[0] as string].attachments[domain.skin.slot][domain.skin.attachment];
    const mask = coveredTexelMask(raw, domain, skin.width, skin.height);
    const covered = mask.reduce((n, v) => n + v, 0);
    expect(covered).toBeGreaterThan(1000);
    // the texture also holds uncovered material (past the cuffs, the hidden-group-free rim)
    expect(covered).toBeLessThan(mask.length);
  });

  it("blocks a cut that runs along an existing mesh edge and never drops a declared cut", () => {
    // a 40 px square of two triangles, cut along their shared diagonal (through both corners)
    const square = {
      format: "atlas-anim@1",
      name: "square",
      canvas: { width: 100, height: 100, originX: 10, originY: 10 },
      bones: [{ name: "root" }],
      slots: [{ name: "skin", bone: "root", attachment: "sq" }],
      skins: { body: { attachments: { skin: { sq: { type: "mesh", path: "t/sq", bones: ["root"], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], vertices: [1, 0, 0, 0, 1, 1, 0, 40, 0, 1, 1, 0, 40, 40, 1, 1, 0, 0, 40, 1], hull: 4, width: 40, height: 40 } } } } }
    };
    const dom = (points: [number, number, number][]): GarmentDomain => ({
      format: "atlas-garment-domain/1",
      name: "sq",
      skin: { slot: "skin", attachment: "sq" },
      groups: ["skin"],
      cuts: [{ name: "diag", kind: "cut", groups: ["skin"], points }],
      seeds: [{ group: "skin", point: [0, 0.25, 0.5] }],
      gaps: [],
      margin: 0
    });
    // corner (0,0) = vertex 0 of triangle 0, corner (40,40) = its vertex 2
    // the covered garment is the seed's half only: area 800 of 1600, every vertex on or right of the diagonal
    const half = (b: ReturnType<typeof buildGarmentSurface>) => {
      const a = b.attachment;
      const p = (v: number) => [(a.uvs[v * 2] as number) * a.width, (a.uvs[v * 2 + 1] as number) * a.height];
      const T = a.triangles as number[];
      let area = 0;
      for (let t = 0; t < T.length; t += 3) { const [A, B, C] = [p(T[t] as number), p(T[t + 1] as number), p(T[t + 2] as number)] as number[][]; area += Math.abs(((B as number[])[0]! - A![0]!) * (C![1]! - A![1]!) - (C![0]! - A![0]!) * (B![1]! - A![1]!)) / 2; }
      const right = T.every((v) => { const [x, y] = p(v) as [number, number]; return x - y >= -1e-3; });
      return { area: Math.round(area), right };
    };
    const along = buildGarmentSurface(square, dom([[0, 1, 0], [0, 0, 0]]), { name: "g", margin: 0, noStrokes: true });
    expect(along.report.coreTriangles).toBe(1);
    expect(half(along)).toEqual({ area: 800, right: true });
    // the same cut with a midpoint on the diagonal (a cut point on a shared edge splits it in both triangles)
    const mid = buildGarmentSurface(square, dom([[0, 1, 0], [0, 0.5, 0], [0, 0, 0]]), { name: "g", margin: 0, noStrokes: true });
    expect(half(mid)).toEqual({ area: 800, right: true });
    // a cut that misses its groups entirely is an error, not silently dropped
    const outside = structuredClone(dom([[0, 1, 0], [0, 0, 0]]));
    outside.cuts[0] = { ...(outside.cuts[0] as GarmentDomain["cuts"][number]), groups: ["none"] };
    expect(() => buildGarmentSurface(square, outside, { name: "g", margin: 0, noStrokes: true })).toThrow(/blocks no edge/);
  });
});
