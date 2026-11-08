/*
 * Atlas Animator: original implementation.
 *
 * Armour: on the leather cuirass fixture, the belt strap (trim between two paints, within reach of
 * the hem stroke) survives the painter, and every kept trim line texel leaves it unchanged.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paintGarmentTexture } from "./garmentPaint.js";
import { buildGarmentSurface, type GarmentDomain } from "./garmentSurface.js";
import { readPng } from "./png.js";
import { DEFAULT_BODY_RIG } from "./swagTypes.js";

// the capped leather domain (tools/garmentCaps.ts, ABANDONED), kept frozen for this test
const DOMAIN = "fixtures/garments/leather-caps-r13-abandoned.domain.json";
const ART = "fixtures/garments/art/leather-cuirass-03.png";

// armour: the jerkin on the shirt template; its belt edges touch a pale metal buckle (read as cream),
// which put the whole edge lines under the cream rule and dropped the strap
const JERKIN_DOMAIN = "fixtures/garments/stock-leather.domain.json";
const JERKIN_ART = "fixtures/garments/art/leather-jerkin-05.png";

describe("garment paint on the leather cuirass", () => {
  it("keeps the belt strap and the trim lines", () => checkStrap(DOMAIN, ART), 120_000);
  it("keeps the jerkin's belt strap whose edges touch the buckle", () => checkStrap(JERKIN_DOMAIN, JERKIN_ART), 120_000);
});

function checkStrap(DOMAIN: string, ART: string): void {
  {
    expect(existsSync(DEFAULT_BODY_RIG) && existsSync(DOMAIN) && existsSync(ART), "fixtures missing").toBe(true);
    const raw = JSON.parse(readFileSync(DEFAULT_BODY_RIG, "utf8"));
    const domain = JSON.parse(readFileSync(DOMAIN, "utf8")) as GarmentDomain;
    const build = buildGarmentSurface(raw, domain, { name: "swag", margin: domain.margin, strokeWidth: 10, ...(domain.stroke?.color ? { strokeColor: domain.stroke.color } : {}), hides: ["tank", "tank_armhole", "tank_armhole_r"] });
    const art = readPng(ART);
    const { texture, report } = paintGarmentTexture(build, art, { strokeWidth: 10, margin: domain.margin });
    const [left, top] = report.rect as [number, number, number, number];
    const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
    const fabric = lum(...(report.fabricMedian as [number, number, number]));
    // the strap: opaque art texels in the waist band, clearly darker than the fabric but not outline-dark,
    // away from the side outlines (the middle 60% of the garment's width at that height)
    let strap = 0;
    let kept = 0;
    for (let y = 880; y < 960; y++) {
      const row: number[] = [];
      for (let x = 0; x < art.width; x++) if ((art.data[(y * art.width + x) * 4 + 3] as number) >= 250) row.push(x);
      if (!row.length) continue;
      const x0 = row[0] as number;
      const x1 = row[row.length - 1] as number;
      for (let x = Math.round(x0 + 0.2 * (x1 - x0)); x <= x1 - 0.2 * (x1 - x0); x++) {
        const o = (y * art.width + x) * 4;
        const l = lum(art.data[o] as number, art.data[o + 1] as number, art.data[o + 2] as number);
        if (l > fabric - 25 || l < 50) continue;
        const t = ((y - top) * texture.width + (x - left)) * 4;
        if (t < 0 || t >= texture.data.length) continue;
        strap++;
        if (Math.abs(lum(texture.data[t] as number, texture.data[t + 1] as number, texture.data[t + 2] as number) - l) <= 8) kept++;
      }
    }
    expect(strap).toBeGreaterThan(500);
    expect(kept / strap).toBeGreaterThanOrEqual(0.9);
    expect(report.trimLinePreserved).toBeGreaterThanOrEqual(0.98);
  }
}
