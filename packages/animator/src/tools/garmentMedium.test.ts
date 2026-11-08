/*
 * Atlas Animator: original implementation.
 *
 *: the medium (bulky, padded) template on the simple template's construction: thicker free outline,
 * simple-thin at the neckline ends and beside the underarm gaps, a low-passed silhouette; the
 * armGapClearance and silhouetteBump measures behind the armGapEveryFrame and silhouetteSmooth gates.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { ARM_GAP_MIN, MEDIUM_BULK_DEFAULTS, armGapClearance, buildGarmentSurface, dressGarment, dropNecklines, mediumBulk, silhouetteBump, type GarmentBuild, type GarmentDomain } from "./garmentSurface.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = JSON.parse(readFileSync(join(ROOT, "fixtures/test-rigs/body/template7-shoulder-legs.anim.json"), "utf8"));
const medium: GarmentDomain = dropNecklines(raw, JSON.parse(readFileSync(join(ROOT, "fixtures/garments/medium-gambeson.domain.json"), "utf8")));
const hides = ["tank", "tank_armhole", "tank_armhole_r"];
const build = (d: GarmentDomain, margin = d.margin) => buildGarmentSurface(raw, d, { name: "g", margin, strokeWidth: 10, hides });
const atRest = (b: GarmentBuild) => {
  const sk = new Skeleton(loadAnimDocument(dressGarment(raw, b, hides)));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  return sk;
};
const margins = (b: GarmentBuild) => b.runs.flatMap((r) => r.dAt.map(Math.abs));

describe("medium template ()", () => {
  it("is declared per item with defaults; simple domains are untouched", () => {
    expect(mediumBulk(medium)).toEqual(MEDIUM_BULK_DEFAULTS);
    expect(mediumBulk({ ...medium, template: "simple" as const })).toBeNull();
    expect(mediumBulk({ ...medium, bulk: { gapMargin: 3 } })?.gapMargin).toBe(3);
  });

  it("is bulkier on the free outline, simple-thin at the neckline ends and the underarm apex", () => {
    const m = build(medium);
    const rep = m.report as any;
    expect(rep.template).toBe("medium");
    expect(rep.bulk.neckEnds).toBe(2);
    expect(rep.bulk.foldApexes).toBe(2);
    const d = margins(m);
    // most of the outline at the full margin (within the low-pass bound)
    expect(d.filter((x) => x >= medium.margin - MEDIUM_BULK_DEFAULTS.smoothDev).length / d.length).toBeGreaterThan(0.5);
    // each neckline end at the simple margin
    for (const r of m.runs) for (const i of [0, r.anchors.length - 1]) {
      const x = Math.abs(r.dAt[i] as number);
      if (x < medium.margin - 3) expect(x).toBeLessThanOrEqual(MEDIUM_BULK_DEFAULTS.neckMargin + 1e-6);
    }
    expect(rep.bulk.smoothShiftMax).toBeLessThanOrEqual(MEDIUM_BULK_DEFAULTS.smoothDev + 1e-6);
  });

  it("keeps the rest arm/torso gap at least as open as the simple template; a plain thick margin closes it", () => {
    const simple = build({ ...medium, template: "simple" as const }, 4.5);
    const plain = build({ ...medium, template: "simple" as const });
    const med = build(medium);
    const gap = (b: GarmentBuild) => Math.min(...armGapClearance(atRest(b), b, medium).map((g) => g.min));
    const [gs, gm, gp] = [gap(simple), gap(med), gap(plain)];
    expect(gm).toBeGreaterThanOrEqual(ARM_GAP_MIN);
    expect(gm).toBeGreaterThanOrEqual(gs - 0.5);
    // the control: the same thickness with no gap guard measured on the same pairs
    const plainOnMedPairs = Math.min(...armGapClearance(atRest(plain), plain, medium).map((g) => g.min));
    expect(plainOnMedPairs).toBe(gp);
    expect(gp).toBeLessThan(gm);
  });

  it("silhouetteBump: the medium rest outline passes its bound, a 2 px bump in it fails", () => {
    const m = build(medium);
    const ok = silhouetteBump(m);
    expect(ok.maxPx).toBeLessThanOrEqual(MEDIUM_BULK_DEFAULTS.maxBumpPx);
    // push one outer vertex of the longest run 2 px outward (along its offset)
    const bad = structuredClone(m) as GarmentBuild;
    const run = [...bad.runs].sort((a, b) => b.anchors.length - a.anchors.length)[0] as GarmentBuild["runs"][number];
    const a = bad.attachment;
    // the anchor nearest the run's middle whose outer neighbours sit at no more than the run's median spacing (a 2 px
    // bump of the outline's own sampling width; beside a long edge the push is a wide swell the local fit absorbs)
    const restOf = (v: number): [number, number] => [(a.uvs[v * 2] as number) * a.width, (a.uvs[v * 2 + 1] as number) * a.height];
    const gapAt = (k: number) => Math.hypot(restOf(run.outer[k] as number)[0] - restOf(run.outer[k + 1] as number)[0], restOf(run.outer[k] as number)[1] - restOf(run.outer[k + 1] as number)[1]);
    const gaps = run.outer.slice(1).map((_, k) => gapAt(k));
    const median = [...gaps].sort((p, q) => p - q)[Math.floor(gaps.length / 2)] as number;
    const mid = Math.floor(run.anchors.length / 2);
    const typical = (k: number) => k > 0 && k < run.outer.length - 1 && run.outer[k] !== run.anchors[k] && (gaps[k - 1] as number) <= median && (gaps[k] as number) <= median;
    const i = [...run.anchors.keys()].filter(typical).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))[0] as number;
    const [o, an] = [run.outer[i] as number, run.anchors[i] as number];
    const dx = (a.uvs[o * 2] - a.uvs[an * 2]) * a.width;
    const dy = (a.uvs[o * 2 + 1] - a.uvs[an * 2 + 1]) * a.height;
    const l = Math.hypot(dx, dy) || 1;
    a.uvs[o * 2] += ((dx / l) * 2) / a.width;
    a.uvs[o * 2 + 1] += ((dy / l) * 2) / a.height;
    expect(silhouetteBump(bad).maxPx).toBeGreaterThan(MEDIUM_BULK_DEFAULTS.maxBumpPx);
  });
});
