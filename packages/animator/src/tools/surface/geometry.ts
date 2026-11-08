/*
 * Atlas Animator: original implementation.
 *
 * Plane geometry for the continuous-surface builder: authored vector paths (control
 * points, chain-relative points, arcs; centripetal Catmull-Rom with corner breaks), resampling,
 * polygon tests, a bone-chain coordinate frame (s along the chain, v across it) and a supersampled
 * polygon fill. Template-neutral: every number comes from the caller's preset.
 */

export type Pt = [number, number];

export const smoothstep = (a: number, b: number, x: number): number => {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const rad = (deg: number): number => (deg * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;

/** Rotates p about c by `degrees` (clockwise on screen: y down). */
export function rotateAbout(p: Pt, c: Pt, degrees: number): Pt {
  const r = rad(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
}

export function signedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt;
    const b = poly[j] as Pt;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distanceToPolyline(p: Pt, line: readonly Pt[], closed: boolean): number {
  let best = Infinity;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, distanceToSegment(p, line[i] as Pt, line[(i + 1) % line.length] as Pt));
  return best;
}

/** Parameter t on segment a-b where it crosses segment c-d (null if they do not cross). */
export function segmentCross(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

// ---------------------------------------------------------------------------------------------
// Bone-chain frame
// ---------------------------------------------------------------------------------------------

export interface ChainJointBlend {
  /** Chain coordinate of the joint. */
  s: number;
  /** Half length of the direction blend. */
  band: number;
}

/**
 * Coordinates along a chain of pivots: s is arc length along a centreline that runs straight
 * along each segment and turns smoothly across each joint band; v is the signed distance along
 * the left normal n = (-u.y, u.x) (screen coordinates, y down). Extrapolated straight past both
 * ends.
 */
export class ChainFrame {
  readonly lengths: number[];
  readonly jointS: number[];
  private readonly table: { s: number; x: number; y: number; ux: number; uy: number }[] = [];
  private readonly step = 0.25;
  readonly sMin: number;

  constructor(readonly pivots: readonly Pt[], blends: readonly number[], sMin: number, sMax: number) {
    const dirs: Pt[] = [];
    this.lengths = [];
    this.jointS = [0];
    for (let i = 0; i + 1 < pivots.length; i++) {
      const a = pivots[i] as Pt;
      const b = pivots[i + 1] as Pt;
      const l = dist(a, b);
      this.lengths.push(l);
      dirs.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
      this.jointS.push((this.jointS[i] as number) + l);
    }
    const dirAt = (s: number): Pt => {
      let x = (dirs[0] as Pt)[0];
      let y = (dirs[0] as Pt)[1];
      for (let j = 1; j < dirs.length; j++) {
        const w = smoothstep((this.jointS[j] as number) - (blends[j - 1] ?? 0), (this.jointS[j] as number) + (blends[j - 1] ?? 0), s);
        x += w * ((dirs[j] as Pt)[0] - (dirs[j - 1] as Pt)[0]);
        y += w * ((dirs[j] as Pt)[1] - (dirs[j - 1] as Pt)[1]);
      }
      const l = Math.hypot(x, y);
      return [x / l, y / l];
    };
    this.sMin = sMin;
    const start = pivots[0] as Pt;
    const d0 = dirs[0] as Pt;
    let x = start[0] + sMin * d0[0];
    let y = start[1] + sMin * d0[1];
    for (let s = sMin; s <= sMax + 1e-9; s += this.step) {
      const u = dirAt(s);
      this.table.push({ s, x, y, ux: u[0], uy: u[1] });
      const u2 = dirAt(s + this.step / 2);
      x += u2[0] * this.step;
      y += u2[1] * this.step;
    }
  }

  private sample(s: number) {
    const f = (s - this.sMin) / this.step;
    const i = Math.max(0, Math.min(this.table.length - 2, Math.floor(f)));
    const a = this.table[i] as { s: number; x: number; y: number; ux: number; uy: number };
    const b = this.table[i + 1] as typeof a;
    const t = f - i;
    const ux = a.ux + (b.ux - a.ux) * t;
    const uy = a.uy + (b.uy - a.uy) * t;
    const l = Math.hypot(ux, uy);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ux: ux / l, uy: uy / l };
  }

  point(s: number, v: number): Pt {
    const c = this.sample(s);
    return [c.x - c.uy * v, c.y + c.ux * v];
  }

  direction(s: number): Pt {
    const c = this.sample(s);
    return [c.ux, c.uy];
  }

  /** (s, v) of the nearest centreline sample (exact on the straight parts). */
  coords(p: Pt): { s: number; v: number } {
    let best = Infinity;
    let bi = 0;
    for (let i = 0; i < this.table.length; i += 4) {
      const e = this.table[i] as { x: number; y: number };
      const d = (p[0] - e.x) ** 2 + (p[1] - e.y) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    for (let i = Math.max(0, bi - 4); i <= Math.min(this.table.length - 1, bi + 4); i++) {
      const e = this.table[i] as { x: number; y: number };
      const d = (p[0] - e.x) ** 2 + (p[1] - e.y) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    const e = this.table[bi] as { s: number; x: number; y: number; ux: number; uy: number };
    const dx = p[0] - e.x;
    const dy = p[1] - e.y;
    return { s: e.s + dx * e.ux + dy * e.uy, v: -dx * e.uy + dy * e.ux };
  }
}

// ---------------------------------------------------------------------------------------------
// Authored paths
// ---------------------------------------------------------------------------------------------

/** A control point: canvas [x, y]; {at, corner}; chain-relative {s, v, corner}; or an arc. */
export type PathPoint =
  | Pt
  | { at: Pt; corner?: boolean | undefined; straight?: boolean | undefined }
  | { s: number; v: number; corner?: boolean | undefined; straight?: boolean | undefined }
  | { arc: { center?: Pt | undefined; s?: number | undefined; r: number; from: number; to: number; step?: number | undefined } };

interface Control {
  p: Pt;
  corner: boolean;
  /** The edge to the next control is one straight segment with no samples between its ends. */
  straight?: boolean;
}

export function resolveControls(path: readonly PathPoint[], chain: ChainFrame | null): Control[] {
  const out: Control[] = [];
  for (const item of path) {
    if (Array.isArray(item)) out.push({ p: [item[0], item[1]], corner: false });
    else if ("at" in item) out.push({ p: [item.at[0], item.at[1]], corner: item.corner ?? false, ...(item.straight ? { straight: true } : {}) });
    else if ("s" in item) {
      if (!chain) throw new Error("chain-relative path point without a chain");
      out.push({ p: chain.point(item.s, item.v), corner: item.corner ?? false, ...(item.straight ? { straight: true } : {}) });
    } else {
      const { r, from, to } = item.arc;
      const center = item.arc.center ?? (chain && item.arc.s !== undefined ? chain.point(item.arc.s, 0) : null);
      if (!center) throw new Error("arc needs a center or a chain s");
      const step = item.arc.step ?? 15;
      const n = Math.max(1, Math.round(Math.abs(to - from) / step));
      for (let k = 0; k <= n; k++) {
        const a = rad(from + ((to - from) * k) / n);
        out.push({ p: [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)], corner: false });
      }
    }
  }
  // both ends of a straight edge are corners (the curve neither bends into it nor out of it)
  out.forEach((c, i) => {
    if (!c.straight) return;
    c.corner = true;
    (out[(i + 1) % out.length] as Control).corner = true;
  });
  return out;
}

/** Centripetal Catmull-Rom through the controls (closed loop), broken at corners, densely sampled. */
function densify(controls: readonly Control[], closed: boolean): { p: Pt; corner: boolean; straight?: boolean }[] {
  const n = controls.length;
  const out: { p: Pt; corner: boolean; straight?: boolean }[] = [];
  const segments = closed ? n : n - 1;
  const at = (i: number) => controls[((i % n) + n) % n] as Control;
  for (let i = 0; i < segments; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const p0 = p1.corner || (!closed && i === 0) ? p1 : at(i - 1);
    const p3 = p2.corner || (!closed && i === segments - 1) ? p2 : at(i + 2);
    if (p1.straight) {
      out.push({ p: p1.p, corner: true, straight: true });
      continue;
    }
    out.push({ p: p1.p, corner: p1.corner });
    const len = dist(p1.p, p2.p);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.max(1e-6, dist(p0.p, p1.p)));
    const t2 = t1 + Math.sqrt(Math.max(1e-6, len));
    const t3 = t2 + Math.sqrt(Math.max(1e-6, dist(p2.p, p3.p)));
    for (let k = 1; k < steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const w = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = lerp(p0.p, p1.p, t0, t1);
      const a2 = lerp(p1.p, p2.p, t1, t2);
      const a3 = lerp(p2.p, p3.p, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push({ p: lerp(b1, b2, t1, t2), corner: false });
    }
  }
  if (!closed) out.push({ p: (controls[n - 1] as Control).p, corner: true });
  return out;
}

/**
 * Samples a path at about `spacing` along its length, keeping every corner and every pinned
 * point exactly. Returns the polyline (closed: last point not repeated).
 */
export function samplePath(path: readonly PathPoint[], chain: ChainFrame | null, spacing: number, closed = true): Pt[] {
  const dense = densify(resolveControls(path, chain), closed);
  // Split at corners, resample each run uniformly.
  const corners = dense.map((d, i) => (d.corner || (!closed && (i === 0 || i === dense.length - 1)) ? i : -1)).filter((i) => i >= 0);
  if (closed && corners.length === 0) corners.push(0);
  const out: Pt[] = [];
  const runs = closed ? corners.length : corners.length - 1;
  for (let r = 0; r < runs; r++) {
    const a = corners[r] as number;
    const b = r + 1 < corners.length ? (corners[r + 1] as number) : (corners[0] as number) + dense.length;
    const run: Pt[] = [];
    for (let i = a; i <= b; i++) run.push((dense[i % dense.length] as { p: Pt }).p);
    const cum = [0];
    for (let i = 1; i < run.length; i++) cum.push((cum[i - 1] as number) + dist(run[i - 1] as Pt, run[i] as Pt));
    const total = cum[cum.length - 1] as number;
    const count = (dense[a % dense.length] as { straight?: boolean }).straight ? 1 : Math.max(1, Math.round(total / spacing));
    let j = 0;
    for (let k = 0; k < count; k++) {
      const target = (total * k) / count;
      while (j < cum.length - 2 && (cum[j + 1] as number) < target) j++;
      const seg = (cum[j + 1] as number) - (cum[j] as number);
      const w = seg > 0 ? (target - (cum[j] as number)) / seg : 0;
      const p = run[j] as Pt;
      const q = run[j + 1] as Pt;
      out.push([p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w]);
    }
  }
  if (!closed) out.push((dense[dense.length - 1] as { p: Pt }).p);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Raster fill
// ---------------------------------------------------------------------------------------------

export interface FillImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parseColor(hex: string): [number, number, number, number] {
  const h = hex.replace(/^#/, "");
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), h.length >= 8 ? v(6) : 255];
}

/** Composites an opaque polygon of `color` (4x4 supersampled coverage) over the image; x0/y0 = canvas of pixel (0,0). */
export function fillPolygon(image: FillImage, poly: readonly Pt[], color: string, x0: number, y0: number): void {
  const [r, g, b] = parseColor(color);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0] - x0);
    maxX = Math.max(maxX, p[0] - x0);
    minY = Math.min(minY, p[1] - y0);
    maxY = Math.max(maxY, p[1] - y0);
  }
  const SS = 4;
  for (let py = Math.max(0, Math.floor(minY)); py <= Math.min(image.height - 1, Math.ceil(maxY)); py++) {
    // Scanline crossings per sub-row.
    const cover = new Float32Array(image.width);
    for (let sy = 0; sy < SS; sy++) {
      const y = py + (sy + 0.5) / SS + y0;
      const xs: number[] = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i] as Pt;
        const c = poly[j] as Pt;
        if (a[1] > y !== c[1] > y) xs.push(a[0] + ((y - a[1]) * (c[0] - a[0])) / (c[1] - a[1]) - x0);
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k] as number;
        const xb = xs[k + 1] as number;
        for (let sx = 0; sx < image.width * SS; sx++) {
          const x = (sx + 0.5) / SS;
          if (x < xa) continue;
          if (x >= xb) break;
          cover[Math.floor(sx / SS)] = (cover[Math.floor(sx / SS)] as number) + 1 / (SS * SS);
        }
      }
    }
    for (let px = 0; px < image.width; px++) {
      const c = cover[px] as number;
      if (c <= 0) continue;
      const o = (py * image.width + px) * 4;
      image.data[o] = Math.round((image.data[o] as number) * (1 - c) + r * c);
      image.data[o + 1] = Math.round((image.data[o + 1] as number) * (1 - c) + g * c);
      image.data[o + 2] = Math.round((image.data[o + 2] as number) * (1 - c) + b * c);
      image.data[o + 3] = 255;
    }
  }
}
