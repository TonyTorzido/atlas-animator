/*
 * Atlas Animator: original implementation.
 *
 * Arm layer (closure): where two trimmed strokes meet at an acute corner (the arm's closing
 * edge entering the torso it is drawn over, beside the torso's own outline entering the arm), the
 * background between their visible parts is a wedge whose tip narrows to a one-pixel staircase: a
 * light speck enclosed in ink at the armpit apex. Pixel art closes such a corner with ink. The
 * fillet is an extra short stroke piece (same width, butt ends) on the arc that rounds the wedge's
 * tip with radius `r`: its inner edge is that arc, its butt ends lie across both strokes' bands, so
 * it only adds ink inside the two strokes and the tip it fills (no ink on the fills past the corner).
 *
 * Geometry is local and exact enough for curved lines: the wedge tip T is the intersection of the
 * two visible runs' background-side offset polylines (half a width off each centreline); the arc is
 * tangent to the two offset lines at T's neighbourhood.
 */

/** Fillet radius (background side) in stroke widths, before the tip-coverage bound. */
export const FILLET_RADIUS_WIDTHS = 0.25;
/** Corners wider than this (degrees, between the two visible runs) get no fillet: no speck forms. */
export const FILLET_MAX_ANGLE = 60;
/** Arc segments of one fillet piece; a piece is FILLET_STEPS + 1 points. */
export const FILLET_STEPS = 8;
/** Most fillets one contour carries (one per trimmed end of an open contour, two ends). */
export const MAX_FILLETS = 2;

// Scratch (module scope, grown on demand: allocation-free once warm).
let oa = new Float64Array(64);
let ob = new Float64Array(64);
const pt = new Float64Array(2);

function at(points: ArrayLike<number>, count: number, t: number): void {
  let k = Math.floor(t);
  if (k >= count - 1) k = count - 2;
  if (k < 0) k = 0;
  const f = Math.min(1, Math.max(0, t - k));
  const ax = points[k * 2] as number;
  const ay = points[k * 2 + 1] as number;
  pt[0] = ax + ((points[k * 2 + 2] as number) - ax) * f;
  pt[1] = ay + ((points[k * 2 + 3] as number) - ay) * f;
}

/**
 * The visible run of an open polyline walked from parameter `t` in direction `dir` (+-1) up to
 * parameter `limit` or arc length `maxLen`: writes the points (the start point, then the vertices
 * passed) into `out` and returns how many.
 */
function walk(points: ArrayLike<number>, count: number, t: number, dir: number, limit: number, maxLen: number, out: Float64Array): number {
  at(points, count, t);
  out[0] = pt[0] as number;
  out[1] = pt[1] as number;
  let n = 1;
  let len = 0;
  let k = dir > 0 ? Math.floor(t + 1e-9) + 1 : Math.ceil(t - 1e-9) - 1;
  for (;;) {
    const done = dir > 0 ? k >= limit - 1e-9 : k <= limit + 1e-9;
    if (done) at(points, count, limit);
    else {
      pt[0] = points[k * 2] as number;
      pt[1] = points[k * 2 + 1] as number;
    }
    const x = pt[0] as number;
    const y = pt[1] as number;
    const px = out[n * 2 - 2] as number;
    const py = out[n * 2 - 1] as number;
    const seg = Math.hypot(x - px, y - py);
    if (seg > 1e-9) {
      if (len + seg >= maxLen) {
        const f = (maxLen - len) / seg;
        out[n * 2] = px + (x - px) * f;
        out[n * 2 + 1] = py + (y - py) * f;
        return n + 1;
      }
      out[n * 2] = x;
      out[n * 2 + 1] = y;
      n++;
      len += seg;
    }
    if (done || n * 2 + 2 > out.length) return n;
    k += dir;
  }
}

/** Unit direction from the walk's start to its point at arc length `d` (or its last point). */
function chord(w: Float64Array, n: number, d: number, out: Float64Array): boolean {
  let len = 0;
  let x = w[0] as number;
  let y = w[1] as number;
  for (let i = 1; i < n; i++) {
    const nx = w[i * 2] as number;
    const ny = w[i * 2 + 1] as number;
    len += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    if (len >= d) break;
  }
  const dx = x - (w[0] as number);
  const dy = y - (w[1] as number);
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return false;
  out[0] = dx / l;
  out[1] = dy / l;
  return true;
}

/** Offsets each segment of a walk by `off` along its normal times `side` (in place into `seg`: 4 floats per segment). */
function offsetSegments(w: Float64Array, n: number, side: number, off: number, seg: Float64Array): number {
  let m = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = w[i * 2] as number;
    const ay = w[i * 2 + 1] as number;
    const bx = w[i * 2 + 2] as number;
    const by = w[i * 2 + 3] as number;
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-9) continue;
    const nx = (-(by - ay) / l) * side * off;
    const ny = ((bx - ax) / l) * side * off;
    seg[m * 4] = ax + nx;
    seg[m * 4 + 1] = ay + ny;
    seg[m * 4 + 2] = bx + nx;
    seg[m * 4 + 3] = by + ny;
    m++;
  }
  return m;
}

const da = new Float64Array(2);
const db = new Float64Array(2);
let wa = new Float64Array(128);
let wb = new Float64Array(128);

/**
 * Appends to `out` (layout: point count, then x, y per point) the fillet piece of the corner where
 * the visible run of A leaving parameter `ta` in direction `dirA` meets the visible run of B leaving
 * `tb` in direction `dirB` (both open polylines; `limitA` / `limitB` the far ends of those runs).
 * Returns false (nothing appended) when the corner is wider than FILLET_MAX_ANGLE, the offset lines
 * do not meet within reach, or the runs are too short to hold the arc.
 */
export function appendTrimFillet(
  aPts: ArrayLike<number>, aCount: number, ta: number, dirA: number, limitA: number,
  bPts: ArrayLike<number>, bCount: number, tb: number, dirB: number, limitB: number,
  width: number, out: number[]
): boolean {
  const reach = 12 * width;
  const need = (Math.max(aCount, bCount) + 4) * 2;
  if (wa.length < need) (wa = new Float64Array(need * 2)), (wb = new Float64Array(need * 2));
  const na = walk(aPts, aCount, ta, dirA, limitA, reach, wa);
  const nb = walk(bPts, bCount, tb, dirB, limitB, reach, wb);
  if (na < 2 || nb < 2) return false;
  if (!chord(wa, na, width, da) || !chord(wb, nb, width, db)) return false;
  const cos0 = (da[0] as number) * (db[0] as number) + (da[1] as number) * (db[1] as number);
  if (cos0 < Math.cos((FILLET_MAX_ANGLE * Math.PI) / 180)) return false;
  // Background side: A's normal toward B's run, B's toward A's.
  const sideA = -(da[1] as number) * (db[0] as number) + (da[0] as number) * (db[1] as number) >= 0 ? 1 : -1;
  const sideB = -(db[1] as number) * (da[0] as number) + (db[0] as number) * (da[1] as number) >= 0 ? 1 : -1;
  if (oa.length < na * 4) oa = new Float64Array(na * 8);
  if (ob.length < nb * 4) ob = new Float64Array(nb * 8);
  const ma = offsetSegments(wa, na, sideA, width / 2, oa);
  const mb = offsetSegments(wb, nb, sideB, width / 2, ob);
  // Wedge tip: the first crossing of the two offset polylines (nearest the corner).
  let best = Infinity;
  let tx = 0;
  let ty = 0;
  let ia = -1;
  let ib = -1;
  for (let i = 0; i < ma; i++) {
    const ax = oa[i * 4] as number, ay = oa[i * 4 + 1] as number, ex = (oa[i * 4 + 2] as number) - ax, ey = (oa[i * 4 + 3] as number) - ay;
    for (let j = 0; j < mb; j++) {
      if (i + j >= best) break;
      const bx = ob[j * 4] as number, by = ob[j * 4 + 1] as number, fx = (ob[j * 4 + 2] as number) - bx, fy = (ob[j * 4 + 3] as number) - by;
      const den = ex * fy - ey * fx;
      if (Math.abs(den) < 1e-12) continue;
      const u = ((bx - ax) * fy - (by - ay) * fx) / den;
      const v = ((bx - ax) * ey - (by - ay) * ex) / den;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      best = i + j;
      tx = ax + ex * u;
      ty = ay + ey * u;
      ia = i;
      ib = j;
    }
  }
  if (ia < 0) return false;
  // Local edge directions at the tip (away from the corner) and the corner angle there.
  const lA = Math.hypot((oa[ia * 4 + 2] as number) - (oa[ia * 4] as number), (oa[ia * 4 + 3] as number) - (oa[ia * 4 + 1] as number));
  const lB = Math.hypot((ob[ib * 4 + 2] as number) - (ob[ib * 4] as number), (ob[ib * 4 + 3] as number) - (ob[ib * 4 + 1] as number));
  const eax = ((oa[ia * 4 + 2] as number) - (oa[ia * 4] as number)) / lA;
  const eay = ((oa[ia * 4 + 3] as number) - (oa[ia * 4 + 1] as number)) / lA;
  const ebx = ((ob[ib * 4 + 2] as number) - (ob[ib * 4] as number)) / lB;
  const eby = ((ob[ib * 4 + 3] as number) - (ob[ib * 4 + 1] as number)) / lB;
  const cos = Math.max(-1, Math.min(1, eax * ebx + eay * eby));
  const phi = Math.acos(cos);
  if (phi < 1e-3 || phi > (FILLET_MAX_ANGLE * Math.PI) / 180) return false;
  const s = Math.sin(phi / 2);
  // The arc stroke covers radii [r, r + width] about its centre: the tip (r / s from the centre)
  // must lie inside that band, so a narrow corner gets a smaller radius.
  let r = Math.min(FILLET_RADIUS_WIDTHS * width, (0.9 * width * s) / (1 - s));
  // The tangent points must stay on the walked runs (with half a width to spare for the butt ends).
  const room = Math.min(remaining(oa, ma, ia, tx, ty), remaining(ob, mb, ib, tx, ty)) - width / 2;
  const tanHalf = Math.tan(phi / 2);
  if (room <= 0) return false;
  r = Math.min(r, room * tanHalf);
  if (r < 0.05 * width) return false;
  const dT = r / tanHalf;
  let bx = eax + ebx;
  let by = eay + eby;
  const bl = Math.hypot(bx, by);
  bx /= bl;
  by /= bl;
  const cx = tx + (bx * r) / s;
  const cy = ty + (by * r) / s;
  const a0 = Math.atan2(ty + eay * dT - cy, tx + eax * dT - cx);
  let a1 = Math.atan2(ty + eby * dT - cy, tx + ebx * dT - cx);
  // The short arc (it subtends pi - phi and passes the tip's side).
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const rc = r + width / 2;
  out.push(FILLET_STEPS + 1);
  for (let k = 0; k <= FILLET_STEPS; k++) {
    const ang = a0 + ((a1 - a0) * k) / FILLET_STEPS;
    out.push(cx + rc * Math.cos(ang), cy + rc * Math.sin(ang));
  }
  return true;
}

/** Arc length of the offset polyline from the point (x, y) on segment i to its end. */
function remaining(seg: Float64Array, m: number, i: number, x: number, y: number): number {
  let len = Math.hypot((seg[i * 4 + 2] as number) - x, (seg[i * 4 + 3] as number) - y);
  for (let k = i + 1; k < m; k++) len += Math.hypot((seg[k * 4 + 2] as number) - (seg[k * 4] as number), (seg[k * 4 + 3] as number) - (seg[k * 4 + 1] as number));
  return len;
}

/*
 * Hand-over bridge (arm layer). Where the two trimmed lines meet at a wide corner (wider
 * than FILLET_MAX_ANGLE: the shoulder, where the arm's closing line leaves the torso nearly in line
 * with the torso's own outline, about half a width deeper), each line ends at the crossing with a
 * round cap and the silhouette keeps a notch on the background side and a step on the fill side: a
 * knob instead of one line. The bridge replaces the last `s` of both visible runs next to the
 * crossing with one smooth curve (a cubic tangent to both lines where it leaves them): the runs are
 * cut back to the bridge ends (handoverCut) and keep full ink and their caps there. The background
 * between the two visible runs is the wedge between their departing directions, so a curve cutting
 * the corner lies on the background side: its ink lands only on background or on the lines' own
 * bands, never deeper into the fills than the lines. Rejected when a bridge sample lies more than
 * HANDOVER_SKIN_TOLERANCE on the fill side of the line it is nearest, or when the replaced corner
 * lies more than HANDOVER_MAX_DEPTH_WIDTHS off the bridge (background could open under it).
 */

/** Bridge reach along each line (arc length from the crossing), in widths, longest first. */
export const HANDOVER_REACH_WIDTHS = [1.5, 1.25, 1, 0.75, 0.5] as const;
/**
 * Nearly straight-through hand-overs (the lines meet within HANDOVER_JOG_ANGLE of straight, offset
 * sideways: the flexed shoulder, where the arm's top line runs just below the torso's) are an S
 * between two parallel lines: its reach grows to HANDOVER_JOG_SPREAD x that sideways jog (at most
 * HANDOVER_MAX_REACH_WIDTHS widths) so the S stays a gentle ramp, not a bump within 1.5 widths.
 */
export const HANDOVER_JOG_ANGLE = 45;
export const HANDOVER_JOG_SPREAD = 2.25;
export const HANDOVER_MAX_REACH_WIDTHS = 3;
const reaches = new Float64Array(HANDOVER_REACH_WIDTHS.length + 1);
/** Largest distance (widths) of the replaced corner from the bridge centreline. */
export const HANDOVER_MAX_DEPTH_WIDTHS = 0.4;
/** Largest depth (canvas px) of a bridge sample on the fill side of the line it is nearest. */
export const HANDOVER_SKIN_TOLERANCE = 0.35;
/** Parameters of the bridge ends on A and B after a successful appendHandover. */
export const handoverCut = new Float64Array(2);

/** Parameter of the open polyline at arc length `len` from `t` in direction `dir` (clamped to `limit`). */
function paramAlong(points: ArrayLike<number>, count: number, t: number, dir: number, limit: number, len: number): number {
  let cur = t;
  let left = len;
  for (;;) {
    const next = dir > 0 ? Math.min(limit, Math.floor(cur + 1e-9) + 1) : Math.max(limit, Math.ceil(cur - 1e-9) - 1);
    at(points, count, cur);
    const x0 = pt[0] as number;
    const y0 = pt[1] as number;
    at(points, count, next);
    const seg = Math.hypot((pt[0] as number) - x0, (pt[1] as number) - y0);
    if (seg >= left && seg > 1e-12) return cur + ((next - cur) * left) / seg;
    left -= seg;
    if (Math.abs(next - limit) < 1e-9) return limit;
    cur = next;
  }
}

const tg = new Float64Array(2);
/** Unit tangent of the polyline at parameter t, oriented along `dir`, into tg. */
function tangentAt(points: ArrayLike<number>, count: number, t: number, dir: number): void {
  let k = dir > 0 ? Math.floor(t + 1e-9) : Math.ceil(t - 1e-9) - 1;
  if (k > count - 2) k = count - 2;
  if (k < 0) k = 0;
  const ex = ((points[k * 2 + 2] as number) - (points[k * 2] as number)) * dir;
  const ey = ((points[k * 2 + 3] as number) - (points[k * 2 + 1] as number)) * dir;
  const l = Math.hypot(ex, ey) || 1;
  tg[0] = ex / l;
  tg[1] = ey / l;
}

const sd = new Float64Array(2);
/** sd[0]: signed distance from (x, y) to the walk (positive on side `side` of its left normal); sd[1]: the distance. */
function sideDistance(w: Float64Array, n: number, side: number, x: number, y: number): void {
  let best = Infinity;
  let signed = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = w[i * 2] as number;
    const ay = w[i * 2 + 1] as number;
    const ex = (w[i * 2 + 2] as number) - ax;
    const ey = (w[i * 2 + 3] as number) - ay;
    const l2 = ex * ex + ey * ey;
    if (l2 < 1e-12) continue;
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
    const d = Math.hypot(x - ax - ex * u, y - ay - ey * u);
    if (d < best) {
      best = d;
      signed = ((-ey * (x - ax) + ex * (y - ay)) / Math.sqrt(l2)) * side;
    }
  }
  sd[0] = signed;
  sd[1] = best;
}

/** Distance from (x, y) to an open polyline of n points packed in `p`. */
function polyDistance(p: Float64Array, n: number, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < n; i++) {
    const ax = p[i * 2] as number;
    const ay = p[i * 2 + 1] as number;
    const ex = (p[i * 2 + 2] as number) - ax;
    const ey = (p[i * 2 + 3] as number) - ay;
    const l2 = ex * ex + ey * ey;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - ex * u, y - ay - ey * u));
  }
  return best;
}

function walkLength(w: Float64Array, n: number): number {
  let len = 0;
  for (let i = 0; i + 1 < n; i++) len += Math.hypot((w[i * 2 + 2] as number) - (w[i * 2] as number), (w[i * 2 + 3] as number) - (w[i * 2 + 1] as number));
  return len;
}

const bridge = new Float64Array((FILLET_STEPS + 1) * 2);

/**
 * Appends to `out` (fillet layout: point count, then x, y per point) the hand-over bridge of the
 * wide corner where the visible run of A leaving `ta` in direction `dirA` meets the visible run of B
 * leaving `tb` in direction `dirB`, and writes the cut parameters into handoverCut ([A, B]).
 * Returns false (nothing appended) for a corner the fillet handles (<= FILLET_MAX_ANGLE), or when
 * no reach passes the fill-side and depth checks.
 */
export function appendHandover(
  aPts: ArrayLike<number>, aCount: number, ta: number, dirA: number, limitA: number,
  bPts: ArrayLike<number>, bCount: number, tb: number, dirB: number, limitB: number,
  width: number, out: number[]
): boolean {
  const reach = 4 * width;
  const need = (Math.max(aCount, bCount) + 4) * 2;
  if (wa.length < need) (wa = new Float64Array(need * 2)), (wb = new Float64Array(need * 2));
  const na = walk(aPts, aCount, ta, dirA, limitA, reach, wa);
  const nb = walk(bPts, bCount, tb, dirB, limitB, reach, wb);
  if (na < 2 || nb < 2) return false;
  if (!chord(wa, na, width, da) || !chord(wb, nb, width, db)) return false;
  const cos0 = (da[0] as number) * (db[0] as number) + (da[1] as number) * (db[1] as number);
  if (cos0 >= Math.cos((FILLET_MAX_ANGLE * Math.PI) / 180)) return false;
  const sideA = -(da[1] as number) * (db[0] as number) + (da[0] as number) * (db[1] as number) >= 0 ? 1 : -1;
  const sideB = -(db[1] as number) * (da[0] as number) + (db[0] as number) * (da[1] as number) >= 0 ? 1 : -1;
  const lenA = walkLength(wa, na);
  const lenB = walkLength(wb, nb);
  const maxDepth = HANDOVER_MAX_DEPTH_WIDTHS * width;
  let nr = 0;
  if (cos0 < -Math.cos((HANDOVER_JOG_ANGLE * Math.PI) / 180)) {
    // sideways jog: B's line 1.5 widths out, measured off A's line through A's trim end
    at(bPts, bCount, paramAlong(bPts, bCount, tb, dirB, limitB, (HANDOVER_REACH_WIDTHS[0] as number) * width));
    const jog = Math.abs(-(da[1] as number) * ((pt[0] as number) - (wa[0] as number)) + (da[0] as number) * ((pt[1] as number) - (wa[1] as number)));
    const sLong = Math.min(HANDOVER_MAX_REACH_WIDTHS * width, HANDOVER_JOG_SPREAD * jog);
    if (sLong > (HANDOVER_REACH_WIDTHS[0] as number) * width) reaches[nr++] = sLong;
  }
  for (const k of HANDOVER_REACH_WIDTHS) reaches[nr++] = k * width;
  for (let ki = 0; ki < nr; ki++) {
    const s = reaches[ki] as number;
    if (lenA < s + width / 2 || lenB < s + width / 2) continue;
    const pa = paramAlong(aPts, aCount, ta, dirA, limitA, s);
    const pb = paramAlong(bPts, bCount, tb, dirB, limitB, s);
    at(aPts, aCount, pa);
    const ax = pt[0] as number;
    const ay = pt[1] as number;
    tangentAt(aPts, aCount, pa, dirA);
    const tax = tg[0] as number;
    const tay = tg[1] as number;
    at(bPts, bCount, pb);
    const bx = pt[0] as number;
    const by = pt[1] as number;
    tangentAt(bPts, bCount, pb, dirB);
    const tbx = tg[0] as number;
    const tby = tg[1] as number;
    // Cubic from B's bridge end (heading back toward the crossing) to A's (heading away from it).
    const h = 0.38 * Math.hypot(ax - bx, ay - by);
    const c1x = bx - tbx * h;
    const c1y = by - tby * h;
    const c2x = ax - tax * h;
    const c2y = ay - tay * h;
    let ok = true;
    for (let i = 0; i <= FILLET_STEPS; i++) {
      const u = i / FILLET_STEPS;
      const v = 1 - u;
      const x = v * v * v * bx + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ax;
      const y = v * v * v * by + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ay;
      bridge[i * 2] = x;
      bridge[i * 2 + 1] = y;
      // Fill side, against the nearer line (its background side faces the other line's run).
      sideDistance(wa, na, sideA, x, y);
      const sA = sd[0] as number;
      const dA = sd[1] as number;
      sideDistance(wb, nb, sideB, x, y);
      const signed = dA <= (sd[1] as number) ? sA : (sd[0] as number);
      if (signed < -HANDOVER_SKIN_TOLERANCE) ok = false;
    }
    // The replaced corner (both runs from the crossing to the bridge ends) stays under the bridge's ink.
    for (let side = 0; side < 2 && ok; side++) {
      const w = side === 0 ? wa : wb;
      const n = side === 0 ? na : nb;
      let len = 0;
      for (let i = 0; i + 1 < n && ok && len < s; i++) {
        const x0 = w[i * 2] as number;
        const y0 = w[i * 2 + 1] as number;
        const ex = (w[i * 2 + 2] as number) - x0;
        const ey = (w[i * 2 + 3] as number) - y0;
        const seg = Math.hypot(ex, ey);
        const steps = Math.max(1, Math.ceil(seg / 0.5));
        for (let q = 0; q <= steps && ok; q++) {
          if (len + (seg * q) / steps > s) break;
          if (polyDistance(bridge, FILLET_STEPS + 1, x0 + (ex * q) / steps, y0 + (ey * q) / steps) > maxDepth) ok = false;
        }
        len += seg;
      }
    }
    if (!ok) continue;
    out.push(FILLET_STEPS + 1);
    for (let i = 0; i < (FILLET_STEPS + 1) * 2; i++) out.push(bridge[i] as number);
    handoverCut[0] = pa;
    handoverCut[1] = pb;
    return true;
  }
  return false;
}
