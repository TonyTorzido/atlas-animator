import { describe, expect, it } from "vitest";
import { CLS, closureCheck, closureControls, joinChains, type ClosureChain, type ClosureFrame } from "./garmentClosure.js";

/**
 * A 60 x 60 frame: background, a garment square (10..50) outlined by a 2 px garment stroke (closed
 * chain on the square's edge), and optionally body skin drawn over its lower left corner.
 */
function square(opts: { skinOver?: boolean; skinOutlined?: boolean; cutStub?: boolean } = {}): ClosureFrame {
  const W = 60, H = 60;
  const cls = new Uint8Array(W * H).fill(CLS.O);
  const garmentInk = new Uint8Array(W * H);
  for (let y = 10; y <= 50; y++) for (let x = 10; x <= 50; x++) cls[y * W + x] = CLS.G;
  const chain: ClosureChain = { pts: [10, 10, 50, 10, 50, 50, 10, 50], n: 4, closed: true, width: 2 };
  const ink = (x: number, y: number, garment: boolean) => { cls[y * W + x] = CLS.I; garmentInk[y * W + x] = garment ? 1 : 0; };
  for (let k = 9; k <= 51; k++) for (const d of [-1, 0]) { ink(k, 10 + d, true); ink(k, 50 + d, true); ink(10 + d, k, true); ink(50 + d, k, true); }
  const chains = [chain];
  if (opts.skinOver) {
    // skin over the lower left corner: x 0..25, y 35..59
    for (let y = 35; y < 60; y++) for (let x = 0; x <= 25; x++) cls[y * W + x] = CLS.B;
    if (opts.skinOutlined) { for (let y = 34; y < 60; y++) { ink(26, y, false); ink(27, y, false); } for (let x = 0; x <= 27; x++) { ink(x, 34, false); ink(x, 33, false); } }
  }
  if (opts.cutStub) {
    // a cut stroke from the left side into the fabric, ending at (30, 30) in open fabric
    for (let x = 10; x <= 30; x++) { ink(x, 30, true); ink(x, 31, true); }
    chains.push({ pts: [10, 30, 30, 30], n: 2, closed: false, width: 2 });
  }
  return { width: W, height: H, cls, garmentInk, chains, bodyStrokePx: 2 };
}

describe("garment closure", () => {
  it("passes a closed outlined garment", () => {
    const r = closureCheck(square(), 3);
    expect(r.ok).toBe(true);
  });
  it("flags body skin drawn over the garment without its own outline (the cap/armpit wedge)", () => {
    const r = closureCheck(square({ skinOver: true }), 3);
    expect(r.uninkedPx).toBeGreaterThan(0);
    expect(closureCheck(square({ skinOver: true, skinOutlined: true }), 3).uninkedPx).toBe(0);
  });
  it("flags a stroke ending in open fabric", () => {
    const r = closureCheck(square({ cutStub: true }), 3);
    expect(r.stubs.length).toBe(1);
    expect(r.stubs[0]).toEqual({ x: 30, y: 30 });
  });
  it("joins strokes meeting end to end into one path (a corner is not two ends)", () => {
    const j = joinChains([{ pts: [0, 0, 10, 0], n: 2, closed: false, width: 2 }, { pts: [10, 10, 10, 0.5], n: 2, closed: false, width: 2 }]);
    expect(j.length).toBe(1);
    expect(j[0]?.n).toBe(3);
  });
  it("every damaged control fails on a passing frame", () => {
    const c = closureControls(square(), 3);
    for (const k of ["gap", "stub", "bodyLine", "skin"] as const) expect(c[k]?.failsAsRequired, k).toBe(true);
  });
});
