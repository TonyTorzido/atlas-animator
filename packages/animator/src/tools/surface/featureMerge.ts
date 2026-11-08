/*
 * Atlas Animator: original implementation.
 *
 * Near-coincident feature merge: before a conform garment clips the skin
 * triangulation, its outline is merged with skin features closer than a declared tolerance (canvas
 * px), so the clip retessellates through the skin's own vertices instead of leaving sliver
 * triangles between a skin vertex and an outline crossing a hair away from it. No minimum-angle
 * floor: conformity is kept exactly, because the outline is moved onto skin vertices (never the
 * skin onto the outline), so every clipped triangle still lies inside one skin triangle.
 *
 * - an outline vertex within `tolerance` of a skin vertex becomes that skin vertex;
 * - a skin vertex within `tolerance` of an outline segment (strictly inside it) is inserted into the
 *   outline, so the outline bends through it;
 * - consecutive outline points closer than `tolerance` collapse to one (a skin vertex wins).
 */
import { dist, distanceToSegment, type Pt } from "./geometry.js";

export function mergeNearCoincident(line: readonly Pt[], meshPoints: readonly Pt[], tolerance: number, closed = true): Pt[] {
  if (!(tolerance > 0) || line.length < 2) return line.map((p) => [p[0], p[1]] as Pt);
  const isMesh = new Set<Pt>();
  // 1. Outline vertices onto skin vertices.
  const snapped: Pt[] = line.map((p) => {
    let best: Pt | null = null;
    let bestD = tolerance;
    for (const q of meshPoints) {
      const d = dist(p, q);
      if (d < bestD) [best, bestD] = [q, d];
    }
    if (!best) return [p[0], p[1]] as Pt;
    const q: Pt = [best[0], best[1]];
    isMesh.add(q);
    return q;
  });
  // 2. Skin vertices next to a segment go into it, in order along it.
  const out: Pt[] = [];
  const segments = closed ? snapped.length : snapped.length - 1;
  for (let i = 0; i < snapped.length; i++) {
    const a = snapped[i] as Pt;
    out.push(a);
    if (i >= segments) continue;
    const b = snapped[(i + 1) % snapped.length] as Pt;
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (len2 === 0) continue;
    const inserts: { t: number; q: Pt }[] = [];
    for (const q of meshPoints) {
      if (distanceToSegment(q, a, b) >= tolerance) continue;
      const t = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / len2;
      if (t <= 0 || t >= 1 || dist(q, a) < 1e-9 || dist(q, b) < 1e-9) continue;
      inserts.push({ t, q });
    }
    inserts.sort((x, y) => x.t - y.t);
    for (const { q } of inserts) {
      const p: Pt = [q[0], q[1]];
      isMesh.add(p);
      out.push(p);
    }
  }
  // 3. Collapse runs of points closer than the tolerance (keeping a skin vertex when there is one).
  const merged: Pt[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && dist(last, p) < tolerance) {
      if (isMesh.has(p) && !isMesh.has(last)) merged[merged.length - 1] = p;
      continue;
    }
    merged.push(p);
  }
  if (closed && merged.length > 2 && dist(merged[0] as Pt, merged[merged.length - 1] as Pt) < tolerance) {
    const last = merged.pop() as Pt;
    if (isMesh.has(last) && !isMesh.has(merged[0] as Pt)) merged[0] = last;
  }
  return merged;
}

/** Smallest interior angle (degrees) of each triangle. */
export function minAngles(points: readonly Pt[], triangles: readonly number[]): number[] {
  const out: number[] = [];
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const p = [0, 1, 2].map((k) => points[triangles[t + k] as number] as Pt);
    let min = 180;
    for (let k = 0; k < 3; k++) {
      const a = p[k] as Pt, b = p[(k + 1) % 3] as Pt, c = p[(k + 2) % 3] as Pt;
      const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]];
      const ang = (Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) * 180) / Math.PI;
      min = Math.min(min, ang);
    }
    out.push(min);
  }
  return out;
}

/**
 * Lines and outlines merged into the skin's own features (follow-up) instead of running
 * a hair beside them: first merged with skin vertices like an outline, then a vertex within
 * `tolerance` of a skin edge (away from its ends) is dropped when its neighbours' chord stays within
 * `tolerance` of it (else kept), so the clip leaves no sliver between the edge and a vertex next to it. Open lines keep their ends. Shape change <= `tolerance`.
 */
export function mergeLineIntoMesh(line: readonly Pt[], meshPoints: readonly Pt[], meshTriangles: readonly number[], tolerance: number, closed = false): Pt[] {
  const merged = mergeNearCoincident(line, meshPoints, tolerance, closed);
  if (!(tolerance > 0) || merged.length < 3) return merged;
  const edges = new Map<string, [Pt, Pt]>();
  for (let t = 0; t + 2 < meshTriangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = meshTriangles[t + k] as number, b = meshTriangles[t + ((k + 1) % 3)] as number;
      edges.set(a < b ? `${a},${b}` : `${b},${a}`, [meshPoints[a] as Pt, meshPoints[b] as Pt]);
    }
  }
  const onMesh = new Set(meshPoints.map((p) => `${p[0]},${p[1]}`));
  const out: Pt[] = [];
  const n = merged.length;
  for (let i = 0; i < n; i++) {
    const p = merged[i] as Pt;
    if ((!closed && (i === 0 || i === n - 1)) || onMesh.has(`${p[0]},${p[1]}`)) {
      out.push(p);
      continue;
    }
    let edge: [Pt, Pt] | null = null;
    for (const [a, b] of edges.values()) {
      if (dist(p, a) < tolerance || dist(p, b) < tolerance) continue;
      if (distanceToSegment(p, a, b) < tolerance) {
        edge = [a, b];
        break;
      }
    }
    if (!edge) {
      out.push(p);
      continue;
    }
    const prev = (out[out.length - 1] ?? merged[n - 1]) as Pt;
    const next = merged[(i + 1) % n] as Pt;
    if (distanceToSegment(p, prev, next) >= tolerance) out.push(p);
  }
  return out;
}

/** Douglas-Peucker simplification of an open polyline: ends kept, every dropped point within `tolerance` of the result. */
export function simplifyLine(line: readonly Pt[], tolerance: number): Pt[] {
  if (line.length < 3 || !(tolerance > 0)) return line.map((p) => [p[0], p[1]] as Pt);
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(line[i] as Pt, line[a] as Pt, line[b] as Pt);
      if (d > worst) [worst, at] = [d, i];
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]).map((p) => [p[0], p[1]] as Pt);
}
