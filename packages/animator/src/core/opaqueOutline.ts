/*
 * Atlas Animator: original implementation.
 *
 * Opaque outlines (clothing model, close): a region's
 * opaque area as a simple polygon of (u, v) pairs in 0..1 of the image, either winding, convex or
 * concave. outlineProblem validates it (the format rejects what it reports); triangulateOutline
 * ear-clips it for coverage tests (a fan is only valid for convex outlines). No imports: the format
 * module uses it.
 */

/** Twice the signed area (shoelace) of the polygon `p` (x, y pairs). */
function doubleArea(p: ArrayLike<number>, n: number): number {
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += (p[i * 2] as number) * (p[j * 2 + 1] as number) - (p[j * 2] as number) * (p[i * 2 + 1] as number);
  }
  return area;
}

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** True when segments (a, b) and (c, d) intersect at a point that is not a shared endpoint. */
function segmentsCross(p: ArrayLike<number>, a: number, b: number, c: number, d: number): boolean {
  const x = (i: number) => p[i * 2] as number;
  const y = (i: number) => p[i * 2 + 1] as number;
  const d1 = cross(x(c), y(c), x(d), y(d), x(a), y(a));
  const d2 = cross(x(c), y(c), x(d), y(d), x(b), y(b));
  const d3 = cross(x(a), y(a), x(b), y(b), x(c), y(c));
  const d4 = cross(x(a), y(a), x(b), y(b), x(d), y(d));
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear overlap (touching segments of a simple polygon share only endpoints).
  const on = (dd: number, i: number, s: number, e: number) =>
    Math.abs(dd) < 1e-12 && Math.min(x(s), x(e)) - 1e-12 <= x(i) && x(i) <= Math.max(x(s), x(e)) + 1e-12 && Math.min(y(s), y(e)) - 1e-12 <= y(i) && y(i) <= Math.max(y(s), y(e)) + 1e-12;
  return (on(d1, a, c, d) && a !== c && a !== d) || (on(d2, b, c, d) && b !== c && b !== d) || (on(d3, c, a, b) && c !== a && c !== b) || (on(d4, d, a, b) && d !== a && d !== b);
}

/** Smallest |area| (normalized image units) an opaque outline may enclose. */
const MIN_AREA = 1e-6;

/** Why `points` is not a usable opaque outline, or null when it is. */
export function outlineProblem(points: ArrayLike<number>): string | null {
  if (points.length % 2 !== 0) return `needs complete u, v pairs (got ${points.length} numbers)`;
  const n = points.length / 2;
  if (n < 3) return `needs at least 3 vertices (got ${n})`;
  for (let i = 0; i < points.length; i++) if (!Number.isFinite(points[i] as number)) return `coordinate ${i} is not finite`;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const i2 = (i + 1) % n;
      const j2 = (j + 1) % n;
      if (i2 === j || j2 === i) continue; // neighbouring edges share a vertex
      if (segmentsCross(points, i, i2, j, j2)) return `is self-intersecting (edges ${i} and ${j} cross)`;
    }
  }
  if (!(Math.abs(doubleArea(points, n)) / 2 > MIN_AREA)) return "is degenerate (zero area)";
  if (!triangulateOutline(points)) return "cannot be triangulated (degenerate or self-touching)";
  return null;
}

/**
 * Ear-clipping triangulation of a simple polygon (x, y pairs, either winding): n - 2 triangles as
 * vertex indices, or null when no ear can be cut (self-intersecting or degenerate input).
 */
export function triangulateOutline(points: ArrayLike<number>): Uint16Array | null {
  const n = Math.floor(points.length / 2);
  if (n < 3 || points.length % 2 !== 0) return null;
  const area = doubleArea(points, n);
  if (!(Math.abs(area) > 0)) return null;
  const sign = area > 0 ? 1 : -1;
  const x = (i: number) => points[i * 2] as number;
  const y = (i: number) => points[i * 2 + 1] as number;
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(i);
  const out: number[] = [];
  while (ring.length > 3) {
    let cut = false;
    for (let k = 0; k < ring.length && !cut; k++) {
      const a = ring[(k + ring.length - 1) % ring.length] as number;
      const b = ring[k] as number;
      const c = ring[(k + 1) % ring.length] as number;
      if (!(cross(x(a), y(a), x(b), y(b), x(c), y(c)) * sign > 1e-14)) continue; // reflex or flat
      let blocked = false;
      for (const p of ring) {
        if (p === a || p === b || p === c) continue;
        const s1 = cross(x(a), y(a), x(b), y(b), x(p), y(p)) * sign;
        const s2 = cross(x(b), y(b), x(c), y(c), x(p), y(p)) * sign;
        const s3 = cross(x(c), y(c), x(a), y(a), x(p), y(p)) * sign;
        if (s1 >= 0 && s2 >= 0 && s3 >= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push(a, b, c);
      ring.splice(k, 1);
      cut = true;
    }
    if (!cut) return null;
  }
  const [a, b, c] = ring as [number, number, number];
  if (!(cross(x(a), y(a), x(b), y(b), x(c), y(c)) * sign > 0)) return null;
  out.push(a, b, c);
  return Uint16Array.from(out);
}
