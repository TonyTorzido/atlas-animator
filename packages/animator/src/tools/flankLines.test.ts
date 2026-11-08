import { describe, expect, it } from "vitest";
import { flankDarkMask, flankParallelLines, outlineStroke, withParallelStroke, type FlankWindow } from "./flankLines.js";

/**
 * A 60 x 52 flank window (the importer's size at stroke width 10): the torso's side outline is a 3 px
 * stroke near the left edge, leaning `slope` px per row (0 = vertical); fabric to its right.
 */
function flank(slope = 0, paint?: (x: number, y: number, sx: number) => boolean): FlankWindow {
  const W = 60, H = 52;
  const dark = new Uint8Array(W * H), stroke = new Uint8Array(W * H), inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sx = 6 + slope * y;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x >= Math.round(sx) && x < Math.round(sx) + 3) stroke[i] = 1;
      else if (x >= Math.round(sx) + 3) { inside[i] = 1; if (paint?.(x, y, sx + 3)) dark[i] = 1; }
    }
  }
  return { width: W, height: H, dark, stroke, inside };
}
// the importer's options at stroke width 10 (bridge)
const opts = { minLen: 24, maxThick: 10, reach: 30, bridge: 10 };

describe("flank parallel lines (flankSingleLine)", () => {
  it("fails a dark stroke parallel to the flank about 6 px inside it (damaged control)", () => {
    const r = flankParallelLines(flank(0, (x, _y, sx) => x - sx >= 6 && x - sx < 9), opts);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.maxThinRun).toBeGreaterThanOrEqual(48);
  });
  it("fails a parallel line beside a slanted flank", () => {
    const r = flankParallelLines(flank(0.3, (x, _y, sx) => x - sx >= 6 && x - sx < 9), opts);
    expect(r.lines.length).toBeGreaterThan(0);
  });
  it("the importer's control stroke is found in a clean window", () => {
    const w = flank(0.2);
    expect(flankParallelLines(w, opts).lines).toHaveLength(0);
    expect(flankParallelLines(withParallelStroke(w, 6, 3), opts).lines.length).toBeGreaterThan(0);
  });
  it("finds the control stroke where it crosses a trim band and art touching it (Wrap obi)", () => {
    // a 5 px horizontal trim band across the window and short dark flecks beside the control's path: the control
    // reads wide there and breaks into pieces shorter than minLen; joined across up to maxThick px it is one line
    const w = flank(0.1, (x, y, sx) => (y >= 19 && y < 24) || (y >= 30 && y < 34 && x - sx >= 7 && x - sx < 17));
    expect(flankParallelLines(w, opts).lines).toHaveLength(0);
    const ctl = withParallelStroke(w, 6, 3);
    expect(flankParallelLines(ctl, opts).lines.length).toBeGreaterThan(0);
    // (8-connected grouping alone drops it as stubs: the defect the bridge fixes)
    expect(flankParallelLines(ctl, { ...opts, bridge: 1 }).lines).toHaveLength(0);
  });
  it("passes diagonal quilt seams running to the outline", () => {
    // 2 px seams at +-45 degrees, 18 px apart
    const r = flankParallelLines(flank(0.1, (x, y) => ((x + y) % 18) < 2 || ((x - y + 180) % 18) < 2), opts);
    expect(r.lines).toHaveLength(0);
  });
  it("passes a horizontal belt reaching the outline", () => {
    // a 26 px dark belt with a 2 px darker edge line above and below
    const r = flankParallelLines(flank(0.1, (_x, y) => y >= 14 && y < 40), opts);
    expect(r.lines).toHaveLength(0);
  });
  it("passes mail texture (rows of small scallop rings) up to the outline", () => {
    const ring = (x: number, y: number) => {
      const row = Math.floor(y / 7);
      const cx = ((x + (row % 2) * 5) % 10) - 5, cy = (y % 7) - 1;
      const d = Math.hypot(cx, cy);
      return cy >= 0 && d >= 3 && d < 4.5;
    };
    const r = flankParallelLines(flank(0.15, ring), opts);
    expect(r.lines).toHaveLength(0);
  });
  it("passes plain fabric", () => {
    expect(flankParallelLines(flank(0), opts).lines).toHaveLength(0);
  });
});

/**
 *: a 60 x 52 window by luminance. A 10 px outline stroke (lum 26) near the left edge; paint to its right
 * at `tone(x, y)`; stroke-coloured trim lines where `trim(x, y)`. Builds the window the importer builds.
 */
function lumWindow(tone: (x: number, y: number) => number, trim: (x: number, y: number) => boolean = () => false): FlankWindow {
  const W = 60, H = 52, N = W * H;
  const lum = new Float32Array(N), all = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, sx = 4 + Math.round(0.1 * y);
    if (x >= sx && x < sx + 10) { all[i] = 1; lum[i] = 26; } else if (x >= sx + 10 && trim(x, y)) { all[i] = 1; lum[i] = 26; } else lum[i] = x < sx ? 0 : tone(x, y);
  }
  const stroke = outlineStroke(all, W, H, 3);
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = lum[i] && !stroke[i] ? 1 : 0;
  return { width: W, height: H, stroke, inside, dark: flankDarkMask(lum, inside, new Uint8Array(N), W, H, 15, 10) };
}

describe("flank window by local tone (Mirror's lamellar flank)", () => {
  // lamellar plates: tone 70 (the garment median elsewhere ~150), 2 px gaps at 50 between 8 px plates in staggered
  // rows 6 px apart
  const lamellar = (x: number, y: number) => ((x + (Math.floor(y / 6) % 2) * 5) % 10 < 2 || y % 6 === 0 ? 50 : 70);
  it("a darker material at the flank is not all dark, and the control there is found", () => {
    const w = lumWindow(lamellar);
    let dark = 0, inside = 0;
    for (let i = 0; i < w.width * w.height; i++) { if (w.inside[i]) inside++; if (w.dark[i]) dark++; }
    expect(dark / inside).toBeLessThan(0.5);
    expect(flankParallelLines(w, opts).lines).toHaveLength(0);
    expect(flankParallelLines(withParallelStroke(w, 6, 3), opts).lines.length).toBeGreaterThan(0);
  });
  it("a real second line on that material is found", () => {
    const w = lumWindow((x, y) => { const sx = 14 + 0.1 * y; return x - sx >= 6 && x - sx < 9 ? 20 : lamellar(x, y); });
    expect(flankParallelLines(w, opts).lines.length).toBeGreaterThan(0);
  });
  it("a belt's stroke-coloured trim lines are paint, not outline", () => {
    // a belt (rows 20..33, tone 110) with 2 px trim lines in the stroke colour along its top and bottom edges
    const trim = (_x: number, y: number) => y === 20 || y === 21 || y === 32 || y === 33;
    const w = lumWindow((_x, y) => (y >= 20 && y < 34 ? 110 : 150), trim);
    for (let x = 30; x < 60; x++) { expect(w.stroke[20 * 60 + x]).toBe(0); expect(w.inside[20 * 60 + x]).toBe(1); }
    expect(w.stroke[40 * 60 + 12]).toBe(1);
    expect(flankParallelLines(w, opts).lines).toHaveLength(0);
    expect(flankParallelLines(withParallelStroke(w, 6, 3), opts).lines.length).toBeGreaterThan(0);
  });
});
