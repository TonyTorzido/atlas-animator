import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { embedWeights, offsetNextFromTriangles } from "../core/attachments.js";
import { OFFSET_FLAG_CLIPPED, computeOffsetPoints, offsetChainsFromNext, offsetPoint } from "../core/skinning.js";
import { simplifyLoop, traceLoops } from "./garmentImport.js";
import { OUTLINE_TURN_MAX_DEG, buildGarmentSurface, contourGate, correspondenceGate, lengthenHemDomain, outlineZigDeg } from "./garmentSurface.js";

/*
 * Plan: garment helpers and the body-derived garment surface (construction pass 1). The
 * committed jacket rig must be exactly what the committed domain builds, with nonnegative
 * parent-triangle bindings (the one runtime embed convention, core/attachments.ts buildEmbed) and
 * one stroke per boundary; the gates fail on a wrong binding and a broken contour.
 */
const RIG = new URL("../../fixtures/test-rigs/jacket/template7-shoulder-legs-jacket.anim.json", import.meta.url);
const BODY = new URL("../../fixtures/test-rigs/body/template7-shoulder-legs.anim.json", import.meta.url);
const DOMAIN = new URL("../../fixtures/garments/kungfu-jacket.domain.json", import.meta.url);

describe("garment import", () => {
  it("traces a mask outline (outer loop negative in image coordinates) and simplifies it", () => {
    const w = 12;
    const h = 10;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 8; y++) for (let x = 3; x < 9; x++) mask[y * w + x] = 1;
    const loops = traceLoops(mask, w, h);
    expect(loops).toHaveLength(1);
    const loop = simplifyLoop(loops[0] as [number, number][], 0.5);
    expect(loop.map((p) => p.join(",")).sort()).toEqual(["3,2", "3,8", "9,2", "9,8"]);
  });

  it("embed weights follow the runtime convention", () => {
    expect(embedWeights(0.2, 0.3)).toEqual([0.2, 0.3, 0.5]);
  });

  it("a boundary offset point keeps distance d from both edges, and is bounded on the concave side", () => {
    const out = new Float64Array(2);
    // straight boundary along +x: the offset is d off the line
    expect(offsetPoint([0, 0, 10, 0, 20, 0], 1, 0, 2, 3, out)).toBeCloseTo(1);
    expect(Math.abs(out[1] as number)).toBeCloseTo(3);
    // a right-angle corner, convex side: the miter point is d from both edge lines
    offsetPoint([0, 0, 10, 0, 10, 10], 1, 0, 2, -3, out);
    expect(Math.abs((out[1] as number) - 0)).toBeCloseTo(3);
    expect(Math.abs((out[0] as number) - 10)).toBeCloseTo(3);
    // the concave side of a turn: the miter point, never shortened toward the body
    offsetPoint([0, 0, 10, 0, 10, 10], 1, 0, 2, -3, out);
    expect(out[0] as number).toBeCloseTo(7);
    expect(out[1] as number).toBeCloseTo(3);
  });

  it("concave turns with short edges clip onto the offset lines' corner: no crossing, no dip (notch fix)", () => {
    // a boundary along +x that turns sharply up through short edges (the shoulder top on a raise):
    // a left turn, so the offset side (d < 0, left of the walk, y-up) is inside it
    const A: [number, number][] = [[-20, 0], [-10, 0], [-1, 0], [0, 0.4], [0.6, 1.2], [0.8, 2], [0.8, 10], [0.8, 20]];
    const world = A.flat();
    const k = A.length;
    const d = -3;
    const refs: number[] = [];
    const dist: number[] = [];
    for (let i = 0; i < k; i++) { refs.push(i, Math.max(0, i - 1), Math.min(k - 1, i + 1)); dist.push(d); }
    const next = Array.from({ length: k }, (_, i) => (i + 1 < k ? i + 1 : -1));
    const out = new Float64Array(k * 2);
    const flags = new Uint8Array(k);
    computeOffsetPoints(world, refs, dist, offsetChainsFromNext(next), out, flags);
    const segDist = (px: number, py: number) => Math.min(...A.slice(1).map((b, i) => {
      const a = A[i] as [number, number];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / (ex * ex + ey * ey)));
      return Math.hypot(px - a[0] - ex * t, py - a[1] - ey * t);
    }));
    for (let i = 0; i < k; i++) {
      // never inside the margin (the old slide limit pulled these toward the body)
      expect(segDist(out[i * 2] as number, out[i * 2 + 1] as number)).toBeGreaterThan(Math.abs(d) - 0.05);
      if (i + 1 < k) {
        // every cell runs forward along its anchor edge (no crossing)
        const ex = A[i + 1]![0] - A[i]![0], ey = A[i + 1]![1] - A[i]![1];
        expect(((out[i * 2 + 2] as number) - (out[i * 2] as number)) * ex + ((out[i * 2 + 3] as number) - (out[i * 2 + 1] as number)) * ey).toBeGreaterThan(0);
      }
    }
    // the short-edge corner is clipped; the straight ends are plain offsets
    expect([...flags].some((f) => f & OFFSET_FLAG_CLIPPED)).toBe(true);
    expect((flags[0] as number) & OFFSET_FLAG_CLIPPED).toBe(0);
    expect(out[1] as number).toBeCloseTo(-d);
    // the clipped outline has no zig-zag (both turns of a notch would be large)
    expect(outlineZigDeg(out, k).deg).toBeLessThan(OUTLINE_TURN_MAX_DEG);
  });

  it("strip triangles give the runtime its offset chains", () => {
    // anchors 0, 1, 2; offsets 3, 4, 5 (entries 0, 1, 2); cells (a, b, ob), (a, ob, oa)
    const tris = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4];
    expect([...offsetNextFromTriangles(tris, [3, 4, 5], [0, 0, 1, 1, 0, 2, 2, 1, 2])]).toEqual([1, 2, -1]);
    const ch = offsetChainsFromNext([1, 2, -1]);
    expect([...ch.order]).toEqual([0, 1, 2]);
    expect([...ch.cyclic]).toEqual([0]);
  });

  it("the outline turn measure flags a 2 px dip and passes a smooth arc", () => {
    const arc = Array.from({ length: 20 }, (_, i) => [Math.cos(i * 0.1) * 60, Math.sin(i * 0.1) * 60]).flat();
    expect(outlineZigDeg(arc, 20).deg).toBe(0);
    const line = [0, 0, 4, 0, 5, 0, 6, -2, 7, 0, 8, 0, 12, 0];
    expect(outlineZigDeg(line, 7).deg).toBeGreaterThan(OUTLINE_TURN_MAX_DEG);
  });

  it("has its committed fixtures (a missing fixture fails, never skips)", () => {
    expect(existsSync(RIG)).toBe(true);
    expect(existsSync(DOMAIN)).toBe(true);
  });

  it("the jacket is one body-derived surface: nonnegative parent-triangle bindings, rest positions exact, every boundary stroked once", () => {
    const raw = JSON.parse(readFileSync(RIG, "utf8"));
    const atts = raw.skins[Object.keys(raw.skins)[0] as string].attachments as Record<string, Record<string, any>>;
    const pieces = Object.values(atts).flatMap((a) => Object.values(a)).filter((a) => a.type === "mesh" && String(a.path).startsWith("garment/"));
    expect(pieces.length).toBe(1);
    const g = pieces[0];
    expect(Object.keys(g.groups).length).toBeGreaterThanOrEqual(3);
    for (const p of g.embed.points) if (Array.isArray(p)) { expect(p[3]).toBeGreaterThanOrEqual(0); expect(p[4]).toBeGreaterThanOrEqual(0); expect(p[3] + p[4]).toBeLessThanOrEqual(1 + 1e-9); }
    expect(g.embed.vertices.length + (g.embed.offsets?.vertices.length ?? 0)).toBe(g.uvs.length / 2);
    // rebuilding from the committed domain reproduces the rig's garment exactly (the domain is the source)
    const bodyRaw = JSON.parse(readFileSync(BODY, "utf8"));
    const domain = JSON.parse(readFileSync(DOMAIN, "utf8"));
    const contours = raw.skins[Object.keys(raw.skins)[0] as string].contours as Record<string, Record<string, any>>;
    const strokeOf = Object.values(contours).flatMap((c) => Object.values(c)).find((c) => c.mesh?.slot === "jacket");
    const build = buildGarmentSurface(bodyRaw, domain, { name: "jacket", hides: ["tank"], strokeWidth: strokeOf.width, strokeColor: strokeOf.color, fabric: [0, 0, 0] });
    expect(build.attachment.triangles).toEqual(g.triangles);
    expect(build.attachment.embed).toEqual(g.embed);
    const corr = correspondenceGate(bodyRaw, g, build.origin);
    expect(corr.noParent).toBe(0);
    expect(corr.negativeWeights).toBe(0);
    expect(corr.restMismatchMax).toBeLessThan(0.01);
    const cg = contourGate(g, Object.fromEntries(Object.entries(contours).filter(([s]) => s === "jacket" || s.startsWith("jacket_"))), build.paintedEdges);
    expect(cg).toMatchObject({ unstroked: 0, doubled: 0, interiorStroked: 0, painted: 0 });
    // design review 9: every cut is stroked; the neckline inside the garment (barycentric points,
    // checked geometrically), with end pieces above the head; without it its edges are unstroked
    expect(build.paintedEdges).toEqual([]);
    expect(cg.inset).toBeGreaterThan(0);
    const garmentContours = Object.fromEntries(Object.entries(contours).filter(([s]) => s === "jacket" || s.startsWith("jacket_")));
    const neckName = Object.entries(garmentContours.jacket ?? {}).find(([, c]) => (c.points as unknown[]).some((q) => typeof q !== "number"))?.[0] as string;
    expect(neckName).toBeDefined();
    expect(Object.keys(contours.head ?? {}).filter((n) => /_tuck[01]$/.test(n)).length).toBeGreaterThanOrEqual(4);
    const noNeck = structuredClone(garmentContours);
    delete (noNeck.jacket as Record<string, unknown>)[neckName];
    expect(contourGate(g, noNeck).unstroked).toBe(cg.inset);
    // a neckline stroke cut short (its second half gone) leaves edges unstroked
    const shortNeck = structuredClone(garmentContours);
    const np = (shortNeck.jacket as Record<string, any>)[neckName].points as unknown[];
    np.splice(Math.ceil(np.length / 2));
    expect(contourGate(g, shortNeck).unstroked).toBeGreaterThan(0);
    // the longer-hem variant: every hem point moved down the body's material, the ends still on its boundary
    const long = lengthenHemDomain(bodyRaw, domain, 24);
    expect(long.hems.length).toBe(1);
    const h = long.hems[0] as { from: [number, number][]; to: [number, number][] };
    for (let i = 1; i + 1 < h.from.length; i++) expect((h.to[i] as [number, number])[1] - (h.from[i] as [number, number])[1]).toBeCloseTo(24, 6);
    expect(() => buildGarmentSurface(bodyRaw, long.domain, { name: "jacket", hides: ["tank"], strokeWidth: strokeOf.width, fabric: [0, 0, 0] })).not.toThrow();
    // gate integrity: a wrong binding and a broken contour fail
    const bad = structuredClone(g);
    const k = bad.embed.points.findIndex((p: any) => Array.isArray(p) && p[3] > 0.2 && p[4] > 0.2);
    bad.embed.points[k] = 0;
    const wrong = correspondenceGate(bodyRaw, bad, build.origin);
    expect(wrong.noParent + (wrong.restMismatchMax > 0.01 ? 1 : 0)).toBeGreaterThan(0);
    const broken = structuredClone(build.contours);
    const first = Object.values(broken).flatMap((c) => Object.values(c)).sort((a, b) => b.points.length - a.points.length)[0];
    first.points.splice(2, 1);
    expect(contourGate(g, broken).unstroked).toBeGreaterThan(0);
  });
});
