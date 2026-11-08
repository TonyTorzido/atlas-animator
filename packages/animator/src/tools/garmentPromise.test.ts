import { describe, expect, it } from "vitest";
import { denseAgreementOk, promisedCoverage } from "./garmentPromise.js";

/* review 6 / 7: coverage on an independent promised domain; dense agreement needs every bound. */
describe("garment promise verdicts", () => {
  const W = 12;
  const H = 12;
  const SKIN = 1;
  const TUNIC = 2;
  const frame = (hole: boolean) => {
    const maskAlpha = new Array(W * H).fill(0);
    const maskTop = new Array(W * H).fill(0);
    const fullTop = new Array(W * H).fill(SKIN);
    const fullAlpha = new Array(W * H).fill(255);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) {
      maskAlpha[y * W + x] = 255;
      maskTop[y * W + x] = SKIN;
      fullTop[y * W + x] = TUNIC;
    }
    // A missing garment triangle: the skin shows through, and the garment-only render is transparent there.
    if (hole) for (let y = 5; y < 7; y++) for (let x = 5; x < 7; x++) fullTop[y * W + x] = SKIN;
    return { width: W, height: H, maskAlpha, maskTop, fullTop, fullAlpha };
  };
  it("a hole in the garment is exposure inside the promise (a garment-derived domain would drop it)", () => {
    expect(promisedCoverage(frame(false)).exposedPx).toBe(0);
    expect(promisedCoverage(frame(true)).exposedPx).toBe(4);
    expect(promisedCoverage(frame(true)).domainPx).toBe(36);
  });
  it("a different part on top (a hand in front) is not exposure of the promised part", () => {
    const f = frame(false);
    f.fullTop[5 * W + 5] = 7;
    expect(promisedCoverage(f).exposedPx).toBe(0);
  });
  it("dense agreement needs correspondence and both maxima", () => {
    expect(denseAgreementOk({ unlocated: 0, outlineMaxGamePx: 0.2, interiorMaxGamePx: 0.2, tolerance: 0.25 })).toBe(true);
    expect(denseAgreementOk({ unlocated: 0, outlineMaxGamePx: 0.2, interiorMaxGamePx: 0.3, tolerance: 0.25 })).toBe(false);
    expect(denseAgreementOk({ unlocated: 2, outlineMaxGamePx: 0.2, interiorMaxGamePx: 0.2, tolerance: 0.25 })).toBe(false);
    expect(denseAgreementOk({ unlocated: 0, outlineMaxGamePx: 0.252, interiorMaxGamePx: 0.252, tolerance: 0.25 })).toBe(false);
  });
});
