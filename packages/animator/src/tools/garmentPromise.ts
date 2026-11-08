/*
 * Atlas Animator: original implementation.
 *
 * Garment coverage and dense-agreement verdicts for the garment probe.
 * Coverage is judged on a promised domain built independently of the garment under test: the
 * declared body regions the garment promises (skin groups minus declared openings), rendered from the
 * skin with slot ids. Inside it, the promised skin part itself may never be the top surface, and the
 * frame must stay opaque. A missing garment triangle or a transparent hole therefore counts, where a
 * domain taken from the garment's own render would hide it.
 */

export interface PromiseBuffers {
  width: number;
  height: number;
  /** Alpha of the promise mask render (the declared, covered skin regions alone). */
  maskAlpha: ArrayLike<number>;
  /** Top slot id per pixel of the promise mask render (the promised skin part there). */
  maskTop: ArrayLike<number>;
  /** Top slot id and alpha per pixel of the full (dressed) render. */
  fullTop: ArrayLike<number>;
  fullAlpha: ArrayLike<number>;
}

/** Exposed pixels (the promised part itself on top) and cracks (alpha < 250) inside the promise mask, eroded by one px. */
export function promisedCoverage(b: PromiseBuffers): { domainPx: number; exposedPx: number; cracksPx: number } {
  let domainPx = 0;
  let exposedPx = 0;
  let cracksPx = 0;
  for (let y = 1; y < b.height - 1; y++) {
    for (let x = 1; x < b.width - 1; x++) {
      const i = y * b.width + x;
      let inside = true;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) if ((b.maskAlpha[i + dy * b.width + dx] as number) < 255) inside = false;
      if (!inside) continue;
      domainPx++;
      if ((b.fullAlpha[i] as number) < 250) cracksPx++;
      const want = b.maskTop[i] as number;
      if (want > 0 && b.fullTop[i] === want) exposedPx++;
    }
  }
  return { domainPx, exposedPx, cracksPx };
}

/** Dense agreement passes only with every sample located and both the outline and the interior maxima within tolerance. */
export function denseAgreementOk(r: { unlocated: number; outlineMaxGamePx: number; interiorMaxGamePx: number; tolerance: number }): boolean {
  return r.unlocated === 0 && r.outlineMaxGamePx <= r.tolerance && r.interiorMaxGamePx <= r.tolerance;
}
