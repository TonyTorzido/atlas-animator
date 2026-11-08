/*
 * Atlas Animator: original implementation.
 *
 * Clothing model, stroke side (close): local coverage intervals. A contour's stroke is
 * trimmed where a surface drawn after it covers its centreline, so a garment hides exactly the
 * strokes under it (a tunic over a tank hides only the covered tank strokes, a pauldron only the
 * sleeve stroke under the plate) and the body keeps its own contours everywhere else.
 *
 * - Coverage is geometric: a centreline point is covered when it lies inside a coverer's drawn
 *   triangles, or within `reach` (the stroke's outward half width) of a coverer edge it runs along,
 *   so a coincident boundary trims the whole stroke, not just its inner half (no half-stroke leak),
 *   while a stroke crossing a coverer's edge is trimmed at the edge itself. A rigid plate (region)
 *   keeps strokes running within 60 degrees of its outline a half width off it (no ink-to-ink slit
 *   under a chin); a stroke heading into it more steeply is trimmed at the outline. A contour with
 * `trimAtOutline` (garment strokes, armour) gets no such reach from a rigid plate: it is
 *   trimmed only where its centreline is under the plate, since its fabric reaches the centreline.
 * - Intervals are in contour parameter units: t in [0, n - 1] (open) or [0, n) (closed, wrapping),
 *   t = k + f on segment k. A coverer that rides the same surface as the contour (both on, or
 *   fully embedded in, one root mesh) covers the same parameter interval in every pose, so the
 *   skeleton computes it once per (contour, coverer) and reuses it; rigid coverers (pauldron
 *   plates) are evaluated per pose from their posed polygon.
 * - Trimmed run ends fade out over TRIM_FEATHER_WIDTHS stroke widths into the covered side (full
 *   ink up to the trim, the fade under the coverer), so a trim never ends in a hard step, a moving
 *   trim end does not pop, and a crack under a crossing stays inked.
 * - Opacity: a coverer trims while its effective alpha (slot alpha x driven alpha x attachment
 *   alpha) is at least COVER_ALPHA; below that the stroke under it is fully back (a threshold, not
 *   a progressive un-trim: one alpha per stroke mesh keeps strokes batched).
 */
import { buildStroke, STROKE_CAP_STEPS, strokeIndexCount, strokeVertexCount, type StrokeCounts, type StrokeRamp } from "./contours.js";
import { FILLET_STEPS, MAX_FILLETS } from "./trimFillet.js";

/** A coverer trims the strokes under it while its effective alpha is at least this. */
export const COVER_ALPHA = 0.5;
/** Fade length of a trimmed run end, in stroke widths. */
export const TRIM_FEATHER_WIDTHS = 0.6;
/** Most visible runs one stroke is built in; more are merged across their smallest gaps. */
export const MAX_TRIM_RUNS = 6;
/** Sampling step along the centreline (canvas px); interval ends are refined by bisection. */
const SAMPLE_STEP = 2;
const REFINE = 8;
const CAP = STROKE_CAP_STEPS + 2;

/** Parameter length of a contour: segments of an open polyline, points of a closed one. */
export function contourParamLength(count: number, closed: boolean): number {
  return closed ? count : Math.max(0, count - 1);
}

function pointAt(points: ArrayLike<number>, count: number, t: number, out: number[], o: number): void {
  const n = count;
  let k = Math.floor(t);
  let f = t - k;
  if (k >= n) k -= n;
  if (k < 0) k += n;
  const a = k % n;
  const b = (k + 1) % n;
  if (f < 0) f = 0;
  const ax = points[a * 2] as number;
  const ay = points[a * 2 + 1] as number;
  out[o] = ax + ((points[b * 2] as number) - ax) * f;
  out[o + 1] = ay + ((points[b * 2 + 1] as number) - ay) * f;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - ax - ex * t;
  const dy = py - ay - ey * t;
  return dx * dx + dy * dy;
}

/** Edges count for the reach only when the stroke runs along them: |cos| of the angle at least this. */
const ALONG_COS = 0.9;
/**
 * A rigid plate keeps strokes a half width off its outline when they run within 60 degrees of it
 * (no ink-to-ink slit under a chin); a stroke heading into the plate more steeply is trimmed at the
 * outline itself, so its cap tucks under the plate and two strokes meeting just outside the plate
 * leave no uncovered pocket between their caps (the tunic's underarm apex under a pauldron).
 */
const RIGID_ALONG_COS = 0.5;

function alongEdge(ax: number, ay: number, bx: number, by: number, tx: number, ty: number, minCos: number): boolean {
  const ex = bx - ax;
  const ey = by - ay;
  const l = Math.hypot(ex, ey);
  return l > 1e-9 && Math.abs(ex * tx + ey * ty) / l >= minCos;
}

/**
 * True when (px, py) is inside a triangle of `tris` (indices into `world`), or within `reach` of a
 * triangle edge the stroke runs along (unit tangent tx, ty; |cos| >= ALONG_COS): a coincident
 * boundary takes the whole stroke width, a stroke crossing a coverer's edge is trimmed at the edge
 * itself (the coverer hides the rest; no crack under a trimmed crossing).
 */
export function pointCovered(px: number, py: number, world: ArrayLike<number>, tris: ArrayLike<number>, reach: number, tx = 0, ty = 0, minCos = ALONG_COS): boolean {
  const r2 = reach * reach;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const i0 = (tris[t] as number) * 2;
    const i1 = (tris[t + 1] as number) * 2;
    const i2 = (tris[t + 2] as number) * 2;
    const x0 = world[i0] as number;
    const y0 = world[i0 + 1] as number;
    const x1 = world[i1] as number;
    const y1 = world[i1 + 1] as number;
    const x2 = world[i2] as number;
    const y2 = world[i2 + 1] as number;
    if (px < Math.min(x0, x1, x2) - reach || px > Math.max(x0, x1, x2) + reach || py < Math.min(y0, y1, y2) - reach || py > Math.max(y0, y1, y2) + reach) continue;
    const d0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
    const d1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    const d2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
    if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) return true;
    if (reach > 0) {
      const any = tx === 0 && ty === 0;
      if (segDist2(px, py, x0, y0, x1, y1) <= r2 && (any || alongEdge(x0, y0, x1, y1, tx, ty, minCos))) return true;
      if (segDist2(px, py, x1, y1, x2, y2) <= r2 && (any || alongEdge(x1, y1, x2, y2, tx, ty, minCos))) return true;
      if (segDist2(px, py, x2, y2, x0, y0) <= r2 && (any || alongEdge(x2, y2, x0, y0, tx, ty, minCos))) return true;
    }
  }
  return false;
}

// Sampling state of the coverIntervals call in progress (module scope: no closure per call, so the
// per-frame rigid-coverer path allocates nothing).
const sq = new Float64Array(2);
let sPoints: ArrayLike<number> = sq;
let sCount = 0;
let sClosed = false;
let sAny = false;
let sReach = 0;
let sWorld: ArrayLike<number> = sq;
let sTris: ArrayLike<number> = sq;
let sMinX = 0;
let sMinY = 0;
let sMaxX = 0;
let sMaxY = 0;

function sampleCovered(t: number): boolean {
  pointAtF(sPoints, sCount, t);
  const x = sq[0] as number;
  const y = sq[1] as number;
  if (x < sMinX || x > sMaxX || y < sMinY || y > sMaxY) return false;
  // The tangent of the segment t lies on (an end point takes the segment it starts).
  const k = Math.min(Math.floor(t), contourParamLength(sCount, sClosed) - 1);
  const a = (((k % sCount) + sCount) % sCount) * 2;
  const b = ((k + 1) % sCount) * 2;
  const dx = (sPoints[b] as number) - (sPoints[a] as number);
  const dy = (sPoints[b + 1] as number) - (sPoints[a + 1] as number);
  const l = Math.hypot(dx, dy);
  if (l <= 1e-9) return pointCovered(x, y, sWorld, sTris, sReach);
  return pointCovered(x, y, sWorld, sTris, sReach, dx / l, dy / l, sAny ? RIGID_ALONG_COS : ALONG_COS);
}

function refineEdge(lo: number, hi: number, loCovered: boolean): number {
  for (let i = 0; i < REFINE; i++) {
    const mid = (lo + hi) / 2;
    if (sampleCovered(mid) === loCovered) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function pointAtF(points: ArrayLike<number>, count: number, t: number): void {
  let k = Math.floor(t);
  let f = t - k;
  if (k >= count) k -= count;
  if (k < 0) k += count;
  const a = k % count;
  const b = (k + 1) % count;
  if (f < 0) f = 0;
  const ax = points[a * 2] as number;
  const ay = points[a * 2 + 1] as number;
  sq[0] = ax + ((points[b * 2] as number) - ax) * f;
  sq[1] = ay + ((points[b * 2 + 1] as number) - ay) * f;
}

/**
 * Appends to `out` (pairs t0, t1, ascending, disjoint) the parameter intervals of the centreline
 * covered by the triangles `tris` of `world` (inside, or within `reach` of an edge the stroke runs
 * along). Allocation-free apart from `out` growing.
 */
export function coverIntervals(points: ArrayLike<number>, count: number, closed: boolean, reach: number, world: ArrayLike<number>, tris: ArrayLike<number>, out: number[], anyDirection = false): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < tris.length; t++) {
    const i = (tris[t] as number) * 2;
    const x = world[i] as number;
    const y = world[i + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  sPoints = points;
  sCount = count;
  sClosed = closed;
  sReach = reach;
  sWorld = world;
  sTris = tris;
  sAny = anyDirection;
  sMinX = minX - reach;
  sMinY = minY - reach;
  sMaxX = maxX + reach;
  sMaxY = maxY + reach;
  const segments = contourParamLength(count, closed);
  let start = -1;
  let prevT = 0;
  let prev = sampleCovered(0);
  if (prev) start = 0;
  for (let k = 0; k < segments; k++) {
    const a = k * 2;
    const b = ((k + 1) % count) * 2;
    const len = Math.hypot((points[b] as number) - (points[a] as number), (points[b + 1] as number) - (points[a + 1] as number));
    const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    for (let s = 1; s <= steps; s++) {
      const t = k + s / steps;
      const c = sampleCovered(t);
      if (c !== prev) {
        const edge = refineEdge(prevT, t, prev);
        if (c) start = edge;
        else {
          out.push(start, edge);
          start = -1;
        }
      }
      prev = c;
      prevT = t;
    }
  }
  if (start >= 0) out.push(start, segments);
  sPoints = sWorld = sTris = sq;
}

/** Sorts and merges interval pairs in place (allocation-free); returns the merged pair count. */
export function mergeIntervals(iv: number[]): number {
  const n = iv.length >> 1;
  for (let i = 1; i < n; i++) {
    const a = iv[i * 2] as number;
    const b = iv[i * 2 + 1] as number;
    let j = i - 1;
    while (j >= 0 && (iv[j * 2] as number) > a) {
      iv[j * 2 + 2] = iv[j * 2] as number;
      iv[j * 2 + 3] = iv[j * 2 + 1] as number;
      j--;
    }
    iv[j * 2 + 2] = a;
    iv[j * 2 + 3] = b;
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a = iv[i * 2] as number;
    const b = iv[i * 2 + 1] as number;
    if (w > 0 && a <= (iv[w * 2 - 1] as number) + 1e-9) {
      if (b > (iv[w * 2 - 1] as number)) iv[w * 2 - 1] = b;
    } else {
      iv[w * 2] = a;
      iv[w * 2 + 1] = b;
      w++;
    }
  }
  iv.length = w * 2;
  return w;
}

/**
 * The visible runs (pairs t0, t1 with t0 < t1; a closed contour's run may pass its end: t1 > L
 * wraps) left by the merged covered intervals `covered`. Returns null when nothing is covered
 * (draw the whole stroke) and an empty array when everything is.
 */
export function visibleRuns(covered: readonly number[], count: number, closed: boolean, out: number[] = []): number[] | null {
  if (covered.length === 0) return null;
  const L = contourParamLength(count, closed);
  const runs = out;
  runs.length = 0;
  let at = 0;
  for (let i = 0; i < covered.length; i += 2) {
    const a = covered[i] as number;
    const b = covered[i + 1] as number;
    if (a > at + 1e-9) runs.push(at, a);
    at = Math.max(at, b);
  }
  if (at < L - 1e-9) runs.push(at, L);
  if (closed && runs.length >= 4 && (runs[0] as number) <= 1e-9 && (runs[runs.length - 1] as number) >= L - 1e-9) {
    // The run through the closing point: one run past L.
    const firstEnd = runs[1] as number;
    for (let i = 2; i < runs.length; i++) runs[i - 2] = runs[i] as number;
    runs.length -= 2;
    runs[runs.length - 1] = L + firstEnd;
  }
  // Too many runs: bridge the smallest covered gaps (keeps the buffers bounded).
  while (runs.length / 2 > MAX_TRIM_RUNS) {
    let best = 1;
    for (let i = 1; i + 2 < runs.length; i += 2) if ((runs[i + 1] as number) - (runs[i] as number) < (runs[best + 1] as number) - (runs[best] as number)) best = i;
    for (let i = best + 2; i < runs.length; i++) runs[i - 2] = runs[i] as number;
    runs.length -= 2;
  }
  return runs;
}

/** Vertex and index capacity that holds any trimmed build of a contour (and its untrimmed one). */
export function trimmedStrokeCapacity(points: number, closed: boolean, roundCaps: boolean, fillets = 0): { vertices: number; indices: number } {
  const m = points + 1 + 4 * MAX_TRIM_RUNS;
  const capIdx = strokeIndexCount(2, false, true) - strokeIndexCount(2, false, false);
  return {
    vertices: Math.max(strokeVertexCount(points, closed, roundCaps), strokeVertexCount(m, false, true) + (MAX_TRIM_RUNS - 1) * 2 * CAP) + fillets * strokeVertexCount(FILLET_STEPS + 1, false, false),
    indices: Math.max(strokeIndexCount(points, closed, roundCaps), strokeIndexCount(m, false, true) + (MAX_TRIM_RUNS - 1) * capIdx) + fillets * strokeIndexCount(FILLET_STEPS + 1, false, false)
  };
}

/** Fillet pieces a contour's trimmed stroke may carry (trimmedStrokeCapacity's `fillets`). */
export function filletCapacity(contour: { readonly coverUnder: string; readonly closed: boolean }): number {
  return contour.coverUnder && !contour.closed ? MAX_FILLETS : 0;
}

let scratchPoints = new Float32Array(256);
let scratchCount = 0;
const runCounts: StrokeCounts = { vertices: 0, indices: 0 };
let runPositions = new Float32Array(512);
let runUvs = new Float32Array(512);
let runIndices = new Uint32Array(1024);
let bPoints: ArrayLike<number> = scratchPoints;
let bCount = 0;
let bFeather = 0;

function pushAt(t: number): void {
  pointAtF(bPoints, bCount, t);
  const x = sq[0] as number;
  const y = sq[1] as number;
  const m = scratchCount;
  if (m > 0 && Math.abs((scratchPoints[m * 2 - 2] as number) - x) < 1e-6 && Math.abs((scratchPoints[m * 2 - 1] as number) - y) < 1e-6) return;
  scratchPoints[m * 2] = x;
  scratchPoints[m * 2 + 1] = y;
  scratchCount = m + 1;
}

/** Bit 0: the contour's start is a join end; bit 1: its end is (see buildTrimmedStroke). */
export function joinedEndMask(joins: readonly { readonly isA: boolean; readonly endA: 0 | 1; readonly endB: 0 | 1 }[]): number {
  let mask = 0;
  for (const j of joins) mask |= 1 << (j.isA ? j.endA : j.endB);
  return mask;
}

/** Arc length (canvas px) of the open polyline between parameters t0 <= t1. */
function polyLength(points: ArrayLike<number>, t0: number, t1: number): number {
  let len = 0;
  let t = t0;
  while (t < t1 - 1e-9) {
    const next = Math.min(t1, Math.floor(t + 1e-9) + 1);
    pointAtF(points, bCount, t);
    const x = sq[0] as number;
    const y = sq[1] as number;
    pointAtF(points, bCount, next);
    len += Math.hypot((sq[0] as number) - x, (sq[1] as number) - y);
    t = next;
  }
  return len;
}

/** The parameter one feather from t along the polyline (dir +-1), clamped to its segment and to `limit`. */
function featherAlong(t: number, dir: number, limit: number): number {
  const k = dir > 0 ? Math.floor(t + 1e-9) : Math.ceil(t - 1e-9) - 1;
  pointAtF(bPoints, bCount, k);
  const ax = sq[0] as number;
  const ay = sq[1] as number;
  pointAtF(bPoints, bCount, k + 1);
  const len = Math.hypot((sq[0] as number) - ax, (sq[1] as number) - ay);
  const step = len > 1e-9 ? bFeather / len : 1;
  const target = t + dir * step;
  return dir > 0 ? Math.min(target, k + 1, limit) : Math.max(target, k, limit);
}

/**
 * Builds the stroke of `runs` (visibleRuns) into the buffers: one open stroke per run, appended;
 * an end made by a trim fades to alpha 0 over TRIM_FEATHER_WIDTHS widths (its centre UV goes to
 * the ramp start; `fade`, when given, receives the per-vertex factor 0..1 for renderers without
 * the ramp). Ends that are the contour's own open ends keep their caps. Stores the totals in
 * `counts` (topologyChanged true) and returns the vertex count. `joinedEnds` (joinedEndMask) marks
 * the open ends a contour join continues. `fillets` (Skeleton.contourFillets) appends each fillet
 * piece as one more open stroke with butt ends and full ink. `cappedEnds` (per run: bit 0 its
 * start, bit 1 its end) marks trimmed ends drawn with full ink and their cap, no feather.
 */
export function buildTrimmedStroke(
  points: ArrayLike<number>,
  count: number,
  closed: boolean,
  roundCaps: boolean,
  width: number,
  aa: number,
  ramp: StrokeRamp,
  runs: readonly number[],
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array | Uint16Array,
  counts: StrokeCounts,
  fade?: Float32Array,
  joinedEnds = 0,
  fillets: ArrayLike<number> | null = null,
  cappedEnds: ArrayLike<number> | null = null
): number {
  const L = contourParamLength(count, closed);
  bPoints = points;
  bCount = count;
  bFeather = width * TRIM_FEATHER_WIDTHS;
  let vBase = 0;
  let iBase = 0;
  for (let r = 0; r + 1 < runs.length; r += 2) {
    let a = runs[r] as number;
    let b = runs[r + 1] as number;
    // A joined end (the line continues in its partner) whose covered tail is shorter than one feather
    // has no room for the fade: the trim would cut the line hard at the coverer's edge, and where that
    // edge crosses it obliquely one corner of the cut stays outside the coverer (a sliver of
    // background between the cut and the coverer's line; the forearm line joined to the fist,
    // ending at the head's outline). The coverer is drawn above, so the joined end keeps its cap and
    // the coverer hides what it covers. Unjoined ends keep the trim (the plate reach rule under a
    // chin needs it).
    if (!closed && (joinedEnds & 1) !== 0 && r === 0 && a > 1e-9 && polyLength(points, 0, a) < bFeather) a = 0;
    if (!closed && (joinedEnds & 2) !== 0 && r + 2 >= runs.length && b < L - 1e-9 && polyLength(points, b, L) < bFeather) b = L;
    // A capped trim end (Skeleton.contourCappedEnds: the stroke meets a visible line of the sheet
    // drawn under it) keeps full ink and its round cap: it merges into that line as a round join
    // instead of fading over the sheet, where no later piece would hide the fade.
    const capBits = cappedEnds ? ((cappedEnds[r / 2] as number) ?? 0) : 0;
    const trimStart = (closed || a > 1e-9) && (capBits & 1) === 0;
    const trimEnd = (closed || b < L - 1e-9) && (capBits & 2) === 0;
    const need = (Math.ceil(b) - Math.floor(a) + 8) * 2;
    if (scratchPoints.length < need) scratchPoints = new Float32Array(need * 2);
    scratchCount = 0;
    // Feather on the covered side: full ink up to the trim, fading to 0 one feather into the covered
    // interval (under the coverer), never into a neighbouring run or past an open end.
    const prevEnd = r > 0 ? (runs[r - 1] as number) : closed ? (runs[runs.length - 1] as number) - L : 0;
    const nextStart = r + 2 < runs.length ? (runs[r + 2] as number) : closed ? (runs[0] as number) + L : L;
    const a0 = trimStart ? featherAlong(a, -1, (prevEnd + a) / 2) : a;
    const b0 = trimEnd ? featherAlong(b, 1, (b + nextStart) / 2) : b;
    pushAt(a0);
    if (a0 < a - 1e-9) pushAt(a);
    for (let k = Math.floor(a0) + 1; k < b0 - 1e-9; k++) if (k > a + 1e-9 && k < b - 1e-9) pushAt(k);
    pushAt(b);
    if (b0 > b + 1e-9) pushAt(b0);
    const m = scratchCount;
    if (m < 2) continue;
    const caps = roundCaps;
    const cap = strokeVertexCount(m, false, caps);
    if (runPositions.length < cap * 2) {
      runPositions = new Float32Array(cap * 4);
      runUvs = new Float32Array(cap * 4);
    }
    const capI = strokeIndexCount(m, false, caps);
    if (runIndices.length < capI) runIndices = new Uint32Array(capI * 2);
    const nv = buildStroke(scratchPoints, m, false, caps, width, aa, ramp, runPositions, runUvs, runIndices, runCounts);
    for (let i = 0; i < nv * 2; i++) {
      positions[vBase * 2 + i] = runPositions[i] as number;
      uvs[vBase * 2 + i] = runUvs[i] as number;
    }
    for (let i = 0; i < runCounts.indices; i++) indices[iBase + i] = (runIndices[i] as number) + vBase;
    if (fade) fade.fill(1, vBase, vBase + nv);
    const uv = uvs;
    const off = vBase;
    const capBase = caps ? nv - 2 * CAP : nv;
    if (trimStart) {
      hideVertices(uv, fade, off, 0, 3, ramp.u0);
      if (caps) hideVertices(uv, fade, off, capBase, capBase + CAP, ramp.u0);
    }
    if (trimEnd) {
      hideVertices(uv, fade, off, capBase - 3, capBase, ramp.u0);
      if (caps) hideVertices(uv, fade, off, capBase + CAP, capBase + 2 * CAP, ramp.u0);
    }
    vBase += nv;
    iBase += runCounts.indices;
  }
  if (fillets) {
    for (let o = 0; o < fillets.length; ) {
      const n = fillets[o] as number;
      if (scratchPoints.length < n * 2) scratchPoints = new Float32Array(n * 4);
      for (let k = 0; k < n * 2; k++) scratchPoints[k] = fillets[o + 1 + k] as number;
      o += 1 + n * 2;
      const cap = strokeVertexCount(n, false, false);
      if (runPositions.length < cap * 2) {
        runPositions = new Float32Array(cap * 4);
        runUvs = new Float32Array(cap * 4);
      }
      const capI = strokeIndexCount(n, false, false);
      if (runIndices.length < capI) runIndices = new Uint32Array(capI * 2);
      const nv = buildStroke(scratchPoints, n, false, false, width, aa, ramp, runPositions, runUvs, runIndices, runCounts);
      for (let i = 0; i < nv * 2; i++) {
        positions[vBase * 2 + i] = runPositions[i] as number;
        uvs[vBase * 2 + i] = runUvs[i] as number;
      }
      for (let i = 0; i < runCounts.indices; i++) indices[iBase + i] = (runIndices[i] as number) + vBase;
      if (fade) fade.fill(1, vBase, vBase + nv);
      vBase += nv;
      iBase += runCounts.indices;
    }
  }
  counts.vertices = vBase;
  counts.indices = iBase;
  counts.topologyChanged = true;
  bPoints = scratchPoints;
  return vBase;
}

function hideVertices(uv: Float32Array, fade: Float32Array | undefined, base: number, from: number, to: number, u0: number): void {
  for (let v = from; v < to; v++) {
    uv[(base + v) * 2] = u0;
    if (fade) fade[base + v] = 0;
  }
}
