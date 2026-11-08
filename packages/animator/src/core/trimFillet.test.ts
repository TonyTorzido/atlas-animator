import { describe, expect, it } from "vitest";
import { appendTrimFillet } from "./trimFillet.js";

/**
 * Two straight strokes (width 10) leave a corner P at angle phi; the background wedge between them
 * narrows to a one-pixel staircase. Raster at 1 px (pixel centres), 4-connected flood from the far
 * background: enclosed background pixels are specks. The fillet must close every tip (any angle up
 * to 60 degrees, any sub-pixel placement) and add ink only inside the two bands or the wedge.
 */
const W = 10;
type Seg = [number, number, number, number];
function distSeg(x: number, y: number, [ax, ay, bx, by]: Seg): number {
  const ex = bx - ax, ey = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(x - ax - ex * t, y - ay - ey * t);
}
function scene(phiDeg: number, ox: number, oy: number, rot: number, fillet: boolean) {
  const P: [number, number] = [40 + ox, 10 + oy];
  const dir = (a: number): [number, number] => [Math.cos(a), Math.sin(a)];
  const half = (phiDeg * Math.PI) / 360;
  const da = dir(Math.PI / 2 + rot - half);
  const db = dir(Math.PI / 2 + rot + half);
  const len = 90;
  // Polylines with vertices every 7 px, A from its far end to P (trimmed end at P), B from P outward.
  const n = 14;
  const a: number[] = [];
  for (let i = n; i >= 0; i--) a.push(P[0] + (da[0] * len * i) / n, P[1] + (da[1] * len * i) / n);
  const b: number[] = [];
  for (let i = 0; i <= n; i++) b.push(P[0] + (db[0] * len * i) / n, P[1] + (db[1] * len * i) / n);
  const pieces: number[] = [];
  const made = fillet && appendTrimFillet(a, n + 1, n, -1, 0, b, n + 1, 0, 1, n, W, pieces);
  const segA: Seg = [P[0], P[1], P[0] + da[0] * len, P[1] + da[1] * len];
  const segB: Seg = [P[0], P[1], P[0] + db[0] * len, P[1] + db[1] * len];
  const fsegs: Seg[] = [];
  for (let o = 0; o < pieces.length; ) {
    const k = pieces[o] as number;
    for (let i = 0; i + 1 < k; i++) fsegs.push([pieces[o + 1 + i * 2]!, pieces[o + 2 + i * 2]!, pieces[o + 3 + i * 2]!, pieces[o + 4 + i * 2]!]);
    o += 1 + k * 2;
  }
  return { P, da, db, segA, segB, fsegs, made, len };
}
function enclosed(phiDeg: number, ox: number, oy: number, rot: number, fillet: boolean): { holes: number; stray: number; made: boolean } {
  const s = scene(phiDeg, ox, oy, rot, fillet);
  const size = 80;
  const ink = new Uint8Array(size * size);
  let stray = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    const inA = distSeg(cx, cy, s.segA) <= W / 2;
    const inB = distSeg(cx, cy, s.segB) <= W / 2;
    const inF = s.fsegs.some((g) => distSeg(cx, cy, g) <= W / 2 - 1e-6);
    // Inside the wedge: on B's side of A's line and A's side of B's line, past P.
    const cross = (d: [number, number]) => d[0] * (cy - s.P[1]) - d[1] * (cx - s.P[0]);
    const inWedge = cross(s.da) * cross([s.db[0], s.db[1]]) < 0 && (cx - s.P[0]) * (s.da[0] + s.db[0]) + (cy - s.P[1]) * (s.da[1] + s.db[1]) > 0;
    if (inF && !inA && !inB && !inWedge) stray++;
    ink[y * size + x] = inA || inB || inF ? 1 : 0;
  }
  // Flood the background from the far end of the wedge (and the image border).
  const seen = new Uint8Array(size * size);
  const stack: number[] = [];
  for (let i = 0; i < size; i++) for (const p of [i, (size - 1) * size + i, i * size, i * size + size - 1]) if (!ink[p] && !seen[p]) (seen[p] = 1, stack.push(p));
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % size, y = (p - x) / size;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const q = ny * size + nx;
      if (ink[q] || seen[q]) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  // Only the wedge counts (the region beyond P on the far side is outside this toy scene).
  let holes = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = y * size + x;
    if (ink[p] || seen[p]) continue;
    const cx = x + 0.5, cy = y + 0.5;
    if ((cx - s.P[0]) * (s.da[0] + s.db[0]) + (cy - s.P[1]) * (s.da[1] + s.db[1]) > 0) holes++;
  }
  return { holes, stray, made: s.made };
}

describe("trim fillet (arm layer closure: acute corner of two trimmed strokes)", () => {
  const cases: [number, number, number, number][] = [];
  for (const phi of [12, 20, 25, 35, 50, 58]) for (const ox of [0, 0.25, 0.5, 0.75]) for (const oy of [0, 0.33, 0.66]) for (const rot of [-0.3, 0, 0.2]) cases.push([phi, ox, oy, rot]);
  it("closes every acute tip with ink and adds none outside the bands and the wedge", () => {
    let made = 0;
    for (const [phi, ox, oy, rot] of cases) {
      const r = enclosed(phi, ox, oy, rot, true);
      expect(r.made, `${phi} ${ox} ${oy} ${rot}`).toBe(true);
      made++;
      expect(r.holes, `holes at ${phi} ${ox} ${oy} ${rot}`).toBe(0);
      expect(r.stray, `stray ink at ${phi} ${ox} ${oy} ${rot}`).toBe(0);
    }
    expect(made).toBe(cases.length);
  });
  it("control: without the fillet some tips leave an enclosed speck", () => {
    const total = cases.reduce((s, [phi, ox, oy, rot]) => s + enclosed(phi, ox, oy, rot, false).holes, 0);
    expect(total).toBeGreaterThan(0);
  });
  it("leaves wide corners alone (no speck forms past 60 degrees)", () => {
    expect(enclosed(80, 0, 0, 0, true).made).toBe(false);
  });
});
