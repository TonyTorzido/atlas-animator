/*
 * Atlas Animator: original implementation.
 *
 * Plan: raster and outline helpers for garments made from art aligned with the rig canvas
 * (traced mask loops, simplification, distance fields, smooth centrelines, silhouette roughness)
 * and the rest/bind positions of a mesh. The fitted-garment construction itself is the
 * body-derived surface in tools/garmentSurface.ts (construction pass 1); the old art-driven fitted
 * path (panel ownership, negative-weight exterior binding, stable re-embedding, rigid fold zone and
 * its coverage exemption) is retired.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { MeshAttachment } from "../core/attachments.js";
import type { RgbaImage } from "./image.js";

type Pt = [number, number];
export type EmbedPoint = number | [number, number, number, number, number];

/** Default ink: the body outline colour family (rgb 53,15,2 / 58,16,1), not the grey fabric. */
export const defaultInk = (r: number, g: number, b: number): boolean => r - b > 25 && r > g + 12 && 0.3 * r + 0.59 * g + 0.11 * b < 120;

/** Bind (setup pose) canvas positions of a mesh attachment. */
export function bindPositions(raw: any, slot: string, attachment: string, pose: Record<string, number> = {}): Pt[] {
  const sk = new Skeleton(loadAnimDocument({ ...raw, animations: {} }));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  for (const [b, v] of Object.entries(pose)) sk.getBone(b).pose.rotation += v;
  sk.updateWorldTransform("none");
  const att = sk.getAttachment(sk.getSlot(slot), attachment) as MeshAttachment;
  const w = sk.meshWorldVertices(att, sk.getSlot(slot).bone);
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  return Array.from({ length: w.length / 2 }, (_, i) => [(w[i * 2] as number) + ox, (w[i * 2 + 1] as number) + oy]);
}

const area2 = (p: readonly Pt[]) => p.reduce((s, q, i) => s + q[0] * (p[(i + 1) % p.length] as Pt)[1] - (p[(i + 1) % p.length] as Pt)[0] * q[1], 0);

/** Closed boundary loops of a binary mask along pixel corners (interior on the left in image coordinates). */
export function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // directed edges keyed by start corner; corners indexed (w + 1) * y + x
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * (w + 1) + x0;
    const list = out.get(k) ?? [];
    list.push(y1 * (w + 1) + x1);
    out.set(k, list);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x + 1, y, x, y); // top edge, right to left
      if (!at(x - 1, y)) add(x, y, x, y + 1); // left edge, down
      if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1); // bottom edge, left to right
      if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y); // right edge, up
    }
  }
  const loops: Pt[][] = [];
  for (const start of [...out.keys()]) {
    while ((out.get(start)?.length ?? 0) > 0) {
      const loop: Pt[] = [];
      let cur = start;
      let guard = 0;
      do {
        loop.push([cur % (w + 1), Math.floor(cur / (w + 1))]);
        const list = out.get(cur) as number[];
        const nxt = list.pop() as number;
        cur = nxt;
      } while (cur !== start && (out.get(cur)?.length ?? 0) > 0 && guard++ < 1e7);
      // collapse collinear runs
      const pts = loop.filter((p, i) => {
        const a = loop[(i - 1 + loop.length) % loop.length] as Pt;
        const b = loop[(i + 1) % loop.length] as Pt;
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
      });
      if (pts.length >= 3) loops.push(pts);
    }
  }
  return loops;
}

/** Douglas-Peucker on a closed loop (keeps the two farthest-apart anchors). */
export function simplifyLoop(loop: readonly Pt[], tol: number): Pt[] {
  if (loop.length < 8) return [...loop];
  const n = loop.length;
  let a = 0;
  let b = Math.floor(n / 2);
  let best = 0;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 64))) {
    const d = Math.hypot((loop[i] as Pt)[0] - (loop[0] as Pt)[0], (loop[i] as Pt)[1] - (loop[0] as Pt)[1]);
    if (d > best) { best = d; b = i; }
  }
  const keep = new Uint8Array(n);
  keep[a] = 1;
  keep[b] = 1;
  const rec = (i: number, j: number) => {
    // i..j along the loop (j may wrap)
    const A = loop[i % n] as Pt;
    const B = loop[j % n] as Pt;
    let md = -1;
    let mk = -1;
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const l = Math.hypot(ex, ey) || 1;
    for (let k = i + 1; k < j; k++) {
      const P = loop[k % n] as Pt;
      const d = Math.abs((P[0] - A[0]) * ey - (P[1] - A[1]) * ex) / l;
      if (d > md) { md = d; mk = k; }
    }
    if (md > tol) {
      keep[mk % n] = 1;
      rec(i, mk);
      rec(mk, j);
    }
  };
  rec(a, b);
  rec(b, a + n);
  return loop.filter((_, i) => keep[i] === 1);
}

/** Chamfer (1, sqrt 2) distance from each mask pixel to the nearest pixel outside the mask (0 outside). */
export function distInside(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1e9 : 0;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i] as number;
    v = Math.min(v, x > 0 ? (d[i - 1] as number) + 1 : 1, y > 0 ? (d[i - w] as number) + 1 : 1);
    v = Math.min(v, x > 0 && y > 0 ? (d[i - w - 1] as number) + D2 : D2, x < w - 1 && y > 0 ? (d[i - w + 1] as number) + D2 : D2);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i] as number;
    v = Math.min(v, x < w - 1 ? (d[i + 1] as number) + 1 : 1, y < h - 1 ? (d[i + w] as number) + 1 : 1);
    v = Math.min(v, x < w - 1 && y < h - 1 ? (d[i + w + 1] as number) + D2 : D2, x > 0 && y < h - 1 ? (d[i + w - 1] as number) + D2 : D2);
    d[i] = v;
  }
  return d;
}

/**
 * A closed pixel-corner loop as a smooth centreline: resampled at 1 px, smoothed (three passes of a
 * circular moving average of +-`radius` samples, about a Gaussian of sigma 0.8 radius, which removes
 * the pixel staircase), then resampled at `step` px (more if the loop would exceed `maxPoints`).
 */
export function smoothLoop(loop: readonly Pt[], radius = 5, step = 5, maxPoints = 250): Pt[] {
  const resample = (pts: readonly Pt[], s: number): Pt[] => {
    const n = pts.length;
    let per = 0;
    for (let i = 0; i < n; i++) per += Math.hypot((pts[(i + 1) % n] as Pt)[0] - (pts[i] as Pt)[0], (pts[(i + 1) % n] as Pt)[1] - (pts[i] as Pt)[1]);
    const m = Math.max(3, Math.round(per / s));
    const ds = per / m;
    const out: Pt[] = [];
    let k = 0;
    let acc = 0;
    let segLen = Math.hypot((pts[1 % n] as Pt)[0] - (pts[0] as Pt)[0], (pts[1 % n] as Pt)[1] - (pts[0] as Pt)[1]);
    for (let j = 0; j < m; j++) {
      const target = j * ds;
      while (acc + segLen < target && k < n) { acc += segLen; k++; segLen = Math.hypot((pts[(k + 1) % n] as Pt)[0] - (pts[k % n] as Pt)[0], (pts[(k + 1) % n] as Pt)[1] - (pts[k % n] as Pt)[1]); }
      const a = pts[k % n] as Pt;
      const b = pts[(k + 1) % n] as Pt;
      const t = segLen > 0 ? (target - acc) / segLen : 0;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return out;
  };
  let p = resample(loop, 1);
  for (let pass = 0; pass < 3; pass++) {
    const n = p.length;
    const q: Pt[] = [];
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      for (let k = -radius; k <= radius; k++) { const r = p[(i + k + n) % n] as Pt; sx += r[0]; sy += r[1]; }
      q.push([sx / (2 * radius + 1), sy / (2 * radius + 1)]);
    }
    p = q;
  }
  let per = 0;
  for (let i = 0; i < p.length; i++) per += Math.hypot((p[(i + 1) % p.length] as Pt)[0] - (p[i] as Pt)[0], (p[(i + 1) % p.length] as Pt)[1] - (p[i] as Pt)[1]);
  return resample(p, Math.max(step, per / maxPoints));
}


/**
 * Edge roughness of a rendered silhouette (check): the outer loop of the pixels whose alpha
 * is at least half (the AA midpoint), resampled at 1 px, minus its own smooth version (three passes
 * of a +-3 px moving average); returns the RMS and p99 of that residual in output px, over the whole
 * loop. A smooth anti-aliased stroke edge and a jagged or spiky texture edge differ here at once; the
 * pixel staircase floor is the same for both, so values compare between renders of the same scale.
 */
export function silhouetteRoughness(img: RgbaImage, minAlpha = 128): { rms: number; p99: number; max: number; length: number; corners?: number } {
  const { width: w, height: h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = (img.data[i * 4 + 3] as number) >= minAlpha ? 1 : 0;
  const loops = traceLoops(mask, w, h).filter((l) => area2(l) < 0);
  const outer = loops.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)))[0];
  if (!outer) return { rms: 0, p99: 0, max: 0, length: 0 };
  const res = smoothLoop(outer, 0, 1, 1e9);
  const n = res.length;
  // the smooth version, index for index (three passes of a +-3 sample circular moving average)
  let sm: Pt[] = res;
  for (let pass = 0; pass < 3; pass++) {
    const q: Pt[] = [];
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      for (let k = -3; k <= 3; k++) { const t = sm[(i + k + n) % n] as Pt; sx += t[0]; sy += t[1]; }
      q.push([sx / 7, sy / 7]);
    }
    sm = q;
  }
  const r: number[] = [];
  let corners = 0;
  for (let i = 0; i < n; i++) {
    // designed corners (the smooth curve turns more than 45 deg over +-6 px) are left out for both
    // renders alike: the measure is jaggedness along the edges, not the garment's cut
    const a0 = sm[(i - 6 + n) % n] as Pt;
    const a1 = sm[i] as Pt;
    const a2 = sm[(i + 6) % n] as Pt;
    const t1 = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]);
    const t2 = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]);
    const turn = Math.abs(((t2 - t1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (turn > Math.PI / 4) { corners++; continue; }
    const p = res[i] as Pt;
    let best = Infinity;
    for (let k = -4; k <= 4; k++) {
      const a = sm[(i + k + n) % n] as Pt;
      const c = sm[(i + k + 1 + n) % n] as Pt;
      const ex = c[0] - a[0];
      const ey = c[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey || 1)));
      best = Math.min(best, Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ey * t));
    }
    r.push(best);
  }
  r.sort((a, b) => a - b);
  const rms = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / Math.max(1, r.length));
  return { rms: Number(rms.toFixed(3)), p99: Number((r[Math.floor(0.99 * (r.length - 1))] ?? 0).toFixed(3)), max: Number((r[r.length - 1] ?? 0).toFixed(3)), length: n, corners };
}
