import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { artOutlineInk, isInkBlend } from "./garmentInk.js";
import { defaultInk, distInside } from "./garmentImport.js";
import { createImage, type RgbaImage } from "./image.js";
import { readPng } from "./png.js";
import { SWAG_RULES_DIR } from "./swagTypes.js";

/*
 * Outline ink by position, not colour (pose rule: an outline may be any hue, as long as it is darker
 * than the item). regression: medium brown leather was stripped as ink (68,651 of 69,310 px).
 * The jacket and the test shirt use the body's red-brown ink: the new detector must agree with the old
 * colour test there, so neither regresses.
 */
const ART = (n: string) => fileURLToPath(new URL(`../../fixtures/garments/art/${n}`, import.meta.url));
const JACKET = `${SWAG_RULES_DIR}examples/good/kungfu-jacket-approved.png`;
const SHIRT = ART("test-shirt.png");
const LEATHER = ART("leather-cuirass-03.png");

function fixture(path: string): RgbaImage {
  if (!existsSync(path)) throw new Error(`missing fixture ${path}`);
  return readPng(path);
}

const rgb = (art: RgbaImage, i: number) => [art.data[i * 4] as number, art.data[i * 4 + 1] as number, art.data[i * 4 + 2] as number] as [number, number, number];
const near = (c: readonly number[], t: readonly number[], tol = 12) => Math.hypot(c[0]! - t[0]!, c[1]! - t[1]!, c[2]! - t[2]!) <= tol;

/** Counts over the art's fully opaque pixels. */
function stats(art: RgbaImage) {
  const ink = artOutlineInk(art);
  const n = art.width * art.height;
  let opaque = 0;
  let inked = 0;
  let old = 0;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if ((art.data[i * 4 + 3] as number) < 250) continue;
    opaque++;
    const o = defaultInk(...rgb(art, i));
    if (ink.mask[i]) inked++;
    if (o) { old++; if (ink.mask[i]) agree++; }
  }
  return { ink, opaque, inked, old, agree };
}

describe("garment outline ink by position", () => {
  it("leather: the brown paint stays, only the outline band and outline-ink line work are ink", () => {
    const art = fixture(LEATHER);
    const { ink, opaque, inked, old } = stats(art);
    // the old colour test took nearly everything
    expect(old / opaque).toBeGreaterThan(0.9);
    expect(ink.outline).not.toBeNull();
    expect(inked / opaque).toBeLessThan(0.3);
    const op = new Uint8Array(art.width * art.height);
    for (let i = 0; i < op.length; i++) op[i] = (art.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
    const d = distInside(op, art.width, art.height);
    let fill = 0, fillInk = 0, panel = 0, panelInk = 0, core = 0, coreInk = 0;
    for (let i = 0; i < op.length; i++) {
      if ((art.data[i * 4 + 3] as number) < 250) continue;
      const c = rgb(art, i);
      if (near(c, [160, 96, 48])) { fill++; if (ink.mask[i]) fillInk++; }
      if (near(c, [112, 64, 32])) { panel++; if (ink.mask[i]) panelInk++; }
      if ((d[i] as number) >= 2 && (d[i] as number) <= 4 && near(c, ink.outline as number[], 20)) { core++; if (ink.mask[i]) coreInk++; }
    }
    expect(fill).toBeGreaterThan(30000);
    expect(fillInk).toBe(0);
    // the darker leather (collar band, belt, seams, flank panels) is paint away from the edge; in the
    // 12 px band it may be taken only where it is the outline's own antialiased blend (none here)
    expect(panel).toBeGreaterThan(5000);
    expect(panelInk / panel).toBeLessThan(0.02);
    expect(coreInk / core).toBeGreaterThan(0.99);
  });

  for (const [name, path] of [["jacket", JACKET], ["test shirt", SHIRT]] as const) {
    it(`${name}: agrees with the old red-brown ink test (no regression)`, () => {
      const art = fixture(path);
      const { ink, inked, old, agree } = stats(art);
      expect(ink.outline).not.toBeNull();
      // every old ink pixel is still ink (the interior line work included) ...
      expect(agree / old).toBeGreaterThan(0.995);
      // ... and the new mask adds only antialiased blends of that ink
      expect((inked - agree) / old).toBeLessThan(0.03);
    });
  }

  it("jacket: grey fabric, its shade tone and the cream trim are never ink", () => {
    const art = fixture(JACKET);
    const { ink } = stats(art);
    for (let i = 0; i < art.width * art.height; i++) {
      if ((art.data[i * 4 + 3] as number) < 250 || !ink.mask[i]) continue;
      const c = rgb(art, i);
      expect(near(c, [40, 40, 48], 6) || near(c, [32, 32, 40], 6) || near(c, [240, 224, 200], 30)).toBe(false);
    }
  });

  it("trim line work: the leather belt and collar lines are kept, the jacket's armhole lines are not (only the cream trim lines are trim there)", () => {
    const leather = fixture(LEATHER);
    const L = artOutlineInk(leather);
    let belt = 0;
    let collar = 0;
    for (let i = 0; i < L.trimLine.length; i++) {
      if (!L.trimLine[i]) continue;
      const y = Math.floor(i / leather.width);
      if (y >= 905 && y <= 950) belt++;
      if (y >= 680 && y <= 700) collar++;
    }
    expect(belt).toBeGreaterThan(800);
    expect(collar).toBeGreaterThan(150);
    expect([...L.trimLine].filter((v) => v).length / L.linePx).toBeGreaterThan(0.95);
    const jacket = fixture(JACKET);
    const J = artOutlineInk(jacket);
    const W = jacket.width;
    const cream = (j: number) => (jacket.data[j * 4] as number) > 175 && (jacket.data[j * 4 + 1] as number) > 155 && (jacket.data[j * 4 + 2] as number) > 130 && (jacket.data[j * 4 + 3] as number) > 200;
    let trim = 0;
    let removedLine = 0;
    for (let i = 0; i < J.mask.length; i++) {
      if (J.trimLine[i]) {
        trim++;
        const x = i % W;
        const y = (i - x) / W;
        let ok = false;
        for (let dy = -20; dy <= 20 && !ok; dy++) for (let dx = -20; dx <= 20 && !ok; dx++) if (cream((y + dy) * W + x + dx)) ok = true;
        expect(ok).toBe(true);
      } else if (J.mask[i] && J.linePx) removedLine++;
    }
    expect(trim).toBeGreaterThan(5000);
    // the armhole and flank piece edges (grey on both sides) stay removable interior ink
    expect(J.linePx - trim).toBeGreaterThan(1500);
    expect(removedLine).toBeGreaterThan(0);
  });

  it("any hue: a blue outline round a brown item is ink, a brown interior stripe darker than the fill is not", () => {
    const w = 120, h = 120;
    const art = createImage(w, h);
    for (let y = 10; y < 110; y++) for (let x = 10; x < 110; x++) {
      const edge = x < 19 || x >= 101 || y < 19 || y >= 101;
      const stripe = x >= 55 && x < 61;
      art.data.set(edge ? [20, 30, 90, 255] : stripe ? [110, 62, 30, 255] : [165, 100, 50, 255], (y * w + x) * 4);
    }
    const ink = artOutlineInk(art);
    expect(ink.outline).toEqual([20, 30, 90]);
    expect(ink.mask[(50 * w + 12)]).toBe(1);
    expect(ink.mask[(50 * w + 57)]).toBe(0);
    expect(ink.mask[(50 * w + 40)]).toBe(0);
    // an outline no darker than the fill is not ink at all
    const pale = createImage(w, h);
    for (let y = 10; y < 110; y++) for (let x = 10; x < 110; x++) pale.data.set([150, 150, 150, 255], (y * w + x) * 4);
    expect(artOutlineInk(pale).outline).toBeNull();
    // blends between the outline and the fabric are recognised, the fabric itself is not
    expect(isInkBlend(ink, [165, 100, 50], 92, 65, 70)).toBe(true);
    expect(isInkBlend(ink, [165, 100, 50], 165, 100, 50)).toBe(false);
  });
  it("a belt's ink-like end cap is a trim edge against the fabric; a line hugging the outline is not (Jade C)", () => {
    const w = 120, h = 120;
    const art = createImage(w, h);
    for (let y = 10; y < 110; y++) for (let x = 10; x < 110; x++) {
      const edge = x < 19 || x >= 101 || y < 19 || y >= 101;
      const belt = y >= 50 && y < 80 && x >= 34 && x < 101;
      const beltLine = belt && (y < 53 || y >= 77 || x < 38);
      const cap = belt && x < 52;
      // a 3 px ink line just inside the right outline, above the belt (the inner fringe of a thick outline)
      const hug = !edge && x >= 96 && x < 99 && y < 45;
      const c = edge ? [17, 18, 19] : beltLine || hug ? [17, 18, 19] : cap ? [38, 40, 42] : belt ? [70, 72, 76] : [40, 140, 100];
      art.data.set([...c, 255], (y * w + x) * 4);
    }
    const ink = artOutlineInk(art);
    expect(ink.outline).toEqual([17, 18, 19]);
    // the cap's 4 px ink edge line (left, away from its square corners): ink-like cap paint the whole reach on one side,
    // fabric on the other (before: no settled paint on the cap side, no vote, the edge was removed)
    for (const y of [60, 64, 68]) for (const x of [34, 36]) expect(ink.trimLine[y * w + x]).toBe(1);
    // the belt's own edge lines stay trim
    expect(ink.trimLine[51 * w + 80]).toBe(1);
    // a line in the fabric hugging the outline: one side walks into the outline band, no dark material, no trim
    expect(ink.mask[30 * w + 97]).toBe(1);
    expect(ink.trimLine[30 * w + 97]).toBe(0);
  });
});

