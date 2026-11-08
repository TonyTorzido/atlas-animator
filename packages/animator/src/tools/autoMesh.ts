/*
 * Atlas Animator: original implementation.
 *
 * Auto-mesh (plan 4.6 step 2): an outline becomes a skinning mesh with evenly sized, well shaped
 * triangles and a vertex count inside the part's budget.
 *
 * 1. Hull: the outline is simplified further to suit the vertex budget, and each simplified edge
 *    is pushed outward by the largest amount the dropped points stuck out past it, so the hull
 *    always encloses the outline (a few transparent pixels inside the hull cost nothing; cut-off
 *    paint would). Long hull edges are subdivided at the lattice spacing.
 * 2. Interior: a triangular (hexagonal) lattice aligned with the part's principal axis, so limb
 *    meshes get rings across the limb that bend cleanly at joints. Lattice points closer than
 *    half a spacing to the hull are dropped (they would make slivers).
 * 3. Constrained Delaunay triangulation (cdt2d) of hull edges + interior points, exterior and
 *    holes removed.
 * 4. Quality: a few rounds of Laplacian smoothing of interior points; then triangles whose
 *    smallest angle is under `minAngle` are repaired by dropping the interior point nearest the
 *    hull, or by adding an inward point opposite an all-hull sliver.
 * The spacing is found by bisection so the vertex count lands on `targetVertices`.
 */
import cdt2d from "cdt2d";
import {
  distanceToOutline,
  pointInOutline,
  polygonArea,
  polygonPerimeter,
  segmentDistance,
  type Outline,
  type Point,
  type Polygon
} from "./outline.js";

export interface AutoMeshOptions {
  /** Vertex count to aim for (plan 4.6: 20-60 per limb, 60-90 torso, 20-30 head). Default 40. */
  targetVertices?: number;
  /** Fixed lattice spacing in pixels instead of a vertex target. */
  spacing?: number;
  /** Smallest acceptable triangle angle in degrees (default 20; the hard floor tested is 15). */
  minAngle?: number;
  /** Lattice direction in degrees (default: the outline's principal axis). */
  axis?: number;
  /**
   * Bridge narrow notches with the hull (default true). Off for cloth that opens at a notch (the
   * shorts' crotch): a bridging edge would stretch across the gap.
   */
  bridgeNotches?: boolean;
}

export interface AutoMesh {
  /** x, y per vertex, in the outline's pixel coordinates. The first `hull` are the outer hull in order. */
  points: Float64Array;
  triangles: Uint32Array;
  hull: number;
  /** Boundary edges (outer hull and holes) as vertex index pairs. */
  edges: Uint32Array;
  spacing: number;
  /** Smallest angle of any triangle, degrees. */
  minAngle: number;
  /** The enclosing hull polygon used (outer loop). */
  hullPolygon: Polygon;
}

const SQRT3_2 = Math.sqrt(3) / 2;

export function autoMesh(outline: Outline, options: AutoMeshOptions = {}): AutoMesh {
  const minAngle = options.minAngle ?? 20;
  const axis = options.axis ?? principalAxis(outline.outer);
  const bridge = options.bridgeNotches ?? true;
  if (options.spacing !== undefined) return buildMesh(outline, options.spacing, axis, minAngle, bridge);

  const target = options.targetVertices ?? 40;
  const area = Math.abs(polygonArea(outline.outer));
  const perimeter = polygonPerimeter(outline.outer);
  // Initial guess from count = perimeter / s + area / (s^2 sqrt(3)/2), then bisect on the real count.
  let low = 1;
  let high = Math.max(4, Math.sqrt(area), perimeter / 3);
  for (let i = 0; i < 40; i++) {
    const s = Math.sqrt(low * high);
    const count = perimeter / s + area / (s * s * SQRT3_2);
    if (count > target) low = s;
    else high = s;
  }
  let spacing = Math.sqrt(low * high);
  low = spacing / 2;
  high = spacing * 2;
  let best = buildMesh(outline, spacing, axis, minAngle, bridge);
  for (let i = 0; i < 12; i++) {
    const mesh = buildMesh(outline, spacing, axis, minAngle, bridge);
    const count = mesh.points.length / 2;
    if (score(mesh, target, minAngle) < score(best, target, minAngle)) best = mesh;
    if (count === target) break;
    if (count > target) low = spacing;
    else high = spacing;
    spacing = Math.sqrt(low * high);
  }
  return best;
}

/** Vertex-count error, with any triangle under the angle floor heavily penalised. */
function score(mesh: AutoMesh, target: number, minAngle: number): number {
  return Math.abs(mesh.points.length / 2 - target) + (mesh.minAngle < Math.min(minAngle, 15) ? 1000 : 0);
}

// ---------------------------------------------------------------------------------------------

type Kind = "hull" | "hole" | "interior";

interface WorkPoint {
  x: number;
  y: number;
  kind: Kind;
}

function buildMesh(outline: Outline, spacing: number, axis: number, minAngle: number, bridge: boolean): AutoMesh {
  // Bumps are kept to spacing/8 (then pushed out); notches narrower than ~spacing/3 are bridged
  // (they only add transparent area, and would otherwise force sliver triangles).
  const tolerance = Math.max(1.5, spacing / 8);
  const notchTolerance = bridge ? Math.max(tolerance, spacing / 3) : Math.max(1.5, tolerance / 2);
  const minEdge = spacing * 0.35;
  const hullPolygon = mergeShortEdges(enclosingSimplify(outline.outer, tolerance, notchTolerance), minEdge);
  const holePolygons = outline.holes
    .map((hole) => mergeShortEdges(enclosingSimplify(hole, tolerance, notchTolerance), minEdge))
    .filter((hole) => hole.length >= 3);
  const hullOutline: Outline = { outer: hullPolygon, holes: holePolygons };

  const boundary: WorkPoint[] = [];
  const edges: [number, number][] = [];
  const addLoop = (loop: Polygon, kind: Kind) => {
    const start = boundary.length;
    const resampled = subdivide(loop, spacing);
    for (const p of resampled) boundary.push({ x: p.x, y: p.y, kind });
    for (let i = 0; i < resampled.length; i++) edges.push([start + i, start + ((i + 1) % resampled.length)]);
  };
  addLoop(hullPolygon, "hull");
  for (const hole of holePolygons) addLoop(hole, "hole");

  let points = [...boundary, ...latticePoints(hullOutline, spacing, axis)];
  let triangles = triangulate(points, edges);

  // Smoothing: move interior points towards the centroid of their neighbours, then re-triangulate.
  for (let round = 0; round < 4; round++) {
    const neighbours = adjacency(points.length, triangles);
    let moved = false;
    for (let i = boundary.length; i < points.length; i++) {
      const list = neighbours[i] as Set<number>;
      if (list.size === 0) continue;
      let cx = 0;
      let cy = 0;
      for (const n of list) {
        cx += (points[n] as WorkPoint).x;
        cy += (points[n] as WorkPoint).y;
      }
      cx /= list.size;
      cy /= list.size;
      const p = points[i] as WorkPoint;
      if (pointInOutline(cx, cy, hullOutline) && distanceToOutline(cx, cy, hullOutline) >= spacing * 0.35) {
        moved ||= Math.abs(cx - p.x) + Math.abs(cy - p.y) > 1e-3;
        p.x = cx;
        p.y = cy;
      }
    }
    if (!moved) break;
    triangles = triangulate(points, edges);
  }

  // Repair: fix triangles under the angle target one at a time.
  for (let round = 0; round < 64; round++) {
    const bad = worstTriangle(points, triangles);
    if (!bad || bad.angle >= minAngle) break;
    const [a, b, c] = bad.vertices;
    const interiorVertices = [a, b, c].filter((v) => (points[v] as WorkPoint).kind === "interior");
    if (interiorVertices.length > 0) {
      // Drop the interior vertex closest to the boundary.
      let drop = interiorVertices[0] as number;
      let dropDistance = Infinity;
      for (const v of interiorVertices) {
        const p = points[v] as WorkPoint;
        const d = distanceToOutline(p.x, p.y, hullOutline);
        if (d < dropDistance) {
          dropDistance = d;
          drop = v;
        }
      }
      points = points.filter((_, i) => i !== drop);
    } else {
      // All-boundary sliver: add a point inward from its obtuse vertex.
      const added = inwardPoint(points, bad.vertices, hullOutline, spacing);
      if (!added) break;
      points = [...points, added];
    }
    triangles = triangulate(points, edges);
  }

  const flat = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    flat[i * 2] = p.x;
    flat[i * 2 + 1] = p.y;
  });
  const hullCount = boundary.filter((p) => p.kind === "hull").length;
  return {
    points: flat,
    triangles: Uint32Array.from(triangles.flat()),
    hull: hullCount,
    edges: Uint32Array.from(edges.flat()),
    spacing,
    minAngle: meshMinAngle(flat, triangles.flat()),
    hullPolygon
  };
}

function triangulate(points: readonly WorkPoint[], edges: readonly [number, number][]): [number, number, number][] {
  const cells = cdt2d(
    points.map((p) => [p.x, p.y] as [number, number]),
    edges.map((e) => [e[0], e[1]] as [number, number]),
    { exterior: false }
  );
  // Consistent winding: positive shoelace area (clockwise on a y-down screen).
  return cells.map(([a, b, c]) => {
    const pa = points[a] as WorkPoint;
    const pb = points[b] as WorkPoint;
    const pc = points[c] as WorkPoint;
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    return cross >= 0 ? [a, b, c] : [a, c, b];
  });
}

function adjacency(count: number, triangles: readonly [number, number, number][]): Set<number>[] {
  const out = Array.from({ length: count }, () => new Set<number>());
  for (const [a, b, c] of triangles) {
    (out[a] as Set<number>).add(b).add(c);
    (out[b] as Set<number>).add(a).add(c);
    (out[c] as Set<number>).add(a).add(b);
  }
  return out;
}

/** The three angles of a triangle in degrees. */
export function triangleAngles(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number, number] {
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const angle = (adjacent1: number, adjacent2: number, opposite: number) => {
    if (adjacent1 === 0 || adjacent2 === 0) return 0;
    const cos = (adjacent1 * adjacent1 + adjacent2 * adjacent2 - opposite * opposite) / (2 * adjacent1 * adjacent2);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  return [angle(ab, ca, bc), angle(ab, bc, ca), angle(bc, ca, ab)];
}

/** Smallest angle (degrees) of any triangle of a mesh given as flat x, y points. */
export function meshMinAngle(points: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let min = 180;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = (triangles[t] as number) * 2;
    const b = (triangles[t + 1] as number) * 2;
    const c = (triangles[t + 2] as number) * 2;
    const angles = triangleAngles(
      points[a] as number, points[a + 1] as number,
      points[b] as number, points[b + 1] as number,
      points[c] as number, points[c + 1] as number
    );
    min = Math.min(min, ...angles);
  }
  return min;
}

function worstTriangle(
  points: readonly WorkPoint[],
  triangles: readonly [number, number, number][]
): { vertices: [number, number, number]; angle: number } | null {
  let worst: { vertices: [number, number, number]; angle: number } | null = null;
  for (const t of triangles) {
    const [a, b, c] = t.map((i) => points[i] as WorkPoint) as [WorkPoint, WorkPoint, WorkPoint];
    const angle = Math.min(...triangleAngles(a.x, a.y, b.x, b.y, c.x, c.y));
    if (!worst || angle < worst.angle) worst = { vertices: t, angle };
  }
  return worst;
}

function inwardPoint(
  points: readonly WorkPoint[],
  vertices: [number, number, number],
  outline: Outline,
  spacing: number
): WorkPoint | null {
  const [a, b, c] = vertices.map((i) => points[i] as WorkPoint) as [WorkPoint, WorkPoint, WorkPoint];
  const angles = triangleAngles(a.x, a.y, b.x, b.y, c.x, c.y);
  const order = [0, 1, 2].sort((i, j) => (angles[j] as number) - (angles[i] as number));
  const corners = [a, b, c];
  const obtuse = corners[order[0] as number] as WorkPoint;
  const p = corners[order[1] as number] as WorkPoint;
  const q = corners[order[2] as number] as WorkPoint;
  // Direction from the obtuse vertex away from the opposite edge, then flip to the inside.
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  let dx = obtuse.x - mx;
  let dy = obtuse.y - my;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  for (const sign of [-1, 1]) {
    for (const distance of [0.6, 0.45, 0.8]) {
      const x = obtuse.x + sign * dx * spacing * distance;
      const y = obtuse.y + sign * dy * spacing * distance;
      if (!pointInOutline(x, y, outline) || distanceToOutline(x, y, outline) < spacing * 0.3) continue;
      if (points.some((other) => Math.hypot(other.x - x, other.y - y) < spacing * 0.4)) continue;
      return { x, y, kind: "interior" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Hull and lattice
// ---------------------------------------------------------------------------------------------

/**
 * RDP-simplifies a closed loop, keeping points that stick out past an edge by more than
 * `tolerance` or dip into the material by more than `notchTolerance`, then moves every kept edge
 * outward (away from the material: the (dy, -dx) side of a positive outer loop and of a negative
 * hole loop) by the largest distance any dropped point stuck out past it, so the result encloses
 * the original.
 */
export function enclosingSimplify(loop: readonly Point[], tolerance: number, notchTolerance = tolerance): Polygon {
  const n = loop.length;
  if (n <= 3) return loop.slice();
  const keep = rdpIndices(loop, tolerance, notchTolerance);
  const m = keep.length;
  if (m < 3) return loop.slice();
  const lines: { nx: number; ny: number; offset: number; a: Point }[] = [];
  for (let k = 0; k < m; k++) {
    const i0 = keep[k] as number;
    const i1 = keep[(k + 1) % m] as number;
    const a = loop[i0] as Point;
    const b = loop[i1] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (b.y - a.y) / length;
    const ny = -(b.x - a.x) / length;
    let offset = 0;
    for (let i = i0; i !== i1; i = (i + 1) % n) {
      const p = loop[i] as Point;
      offset = Math.max(offset, (p.x - a.x) * nx + (p.y - a.y) * ny);
    }
    lines.push({ nx, ny, offset, a });
  }
  const out: Polygon = [];
  for (let k = 0; k < m; k++) {
    const prev = lines[(k - 1 + m) % m] as (typeof lines)[number];
    const next = lines[k] as (typeof lines)[number];
    const vertex = loop[keep[k] as number] as Point;
    const point = intersectOffsetLines(prev, next, vertex);
    const last = out[out.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.5) out.push(point);
  }
  const first = out[0] as Point;
  const last = out[out.length - 1] as Point;
  if (out.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) <= 0.5) out.pop();
  return out;
}

function intersectOffsetLines(
  l1: { nx: number; ny: number; offset: number; a: Point },
  l2: { nx: number; ny: number; offset: number; a: Point },
  vertex: Point
): Point {
  // Line i: n_i . p = n_i . a_i + offset_i.
  const c1 = l1.nx * l1.a.x + l1.ny * l1.a.y + l1.offset;
  const c2 = l2.nx * l2.a.x + l2.ny * l2.a.y + l2.offset;
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  const largest = Math.max(l1.offset, l2.offset);
  if (Math.abs(det) > 1e-6) {
    const x = (c1 * l2.ny - l1.ny * c2) / det;
    const y = (l1.nx * c2 - c1 * l2.nx) / det;
    // Keep miters short at very sharp turns.
    if (Math.hypot(x - vertex.x, y - vertex.y) <= Math.max(largest * 3, 1e-9)) return { x, y };
  }
  const mx = l1.nx + l2.nx;
  const my = l1.ny + l2.ny;
  const length = Math.hypot(mx, my) || 1;
  return { x: vertex.x + (mx / length) * largest, y: vertex.y + (my / length) * largest };
}

/**
 * Ramer-Douglas-Peucker over a closed loop with separate tolerances for points outside the
 * chord (the (dy, -dx) side) and inside it. Returns the kept indices in loop order.
 */
function rdpIndices(loop: readonly Point[], outward: number, inward: number): number[] {
  const n = loop.length;
  const first = loop[0] as Point;
  let far = 0;
  let farDistance = -1;
  loop.forEach((p, i) => {
    const d = (p.x - first.x) ** 2 + (p.y - first.y) ** 2;
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  });
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const chain = (from: number, count: number) => {
    const at = (k: number) => loop[(from + k) % n] as Point;
    const stack: [number, number][] = [[0, count]];
    while (stack.length > 0) {
      const [s, e] = stack.pop() as [number, number];
      const a = at(s);
      const b = at(e);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      let worst = -1;
      let worstExcess = 0;
      for (let k = s + 1; k < e; k++) {
        const p = at(k);
        const distance = segmentDistance(p.x, p.y, a, b);
        // Side: positive outside the chord.
        const side = length > 0 ? ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / length : 1;
        const excess = distance / (side >= 0 ? outward : inward);
        if (excess > 1 && excess > worstExcess) {
          worstExcess = excess;
          worst = k;
        }
      }
      if (worst >= 0) {
        keep[(from + worst) % n] = 1;
        stack.push([s, worst], [worst, e]);
      }
    }
  };
  chain(0, far);
  chain(far, (n - far) % n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Removes hull edges shorter than `minLength` (they force thin triangles at corners): the two end
 * vertices become one, where the neighbouring edges' lines meet, when that point lies outside the
 * short edge (so the hull still encloses everything) and not too far away.
 */
export function mergeShortEdges(loop: readonly Point[], minLength: number): Polygon {
  const out = loop.map((p) => ({ x: p.x, y: p.y }));
  for (let guard = 0; guard < loop.length && out.length > 3; guard++) {
    let merged = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const n = out.length;
      const a = out[(i - 1 + n) % n] as Point;
      const b = out[i] as Point;
      const c = out[(i + 1) % n] as Point;
      const d = out[(i + 2) % n] as Point;
      const length = Math.hypot(c.x - b.x, c.y - b.y);
      if (length >= minLength) continue;
      const q = lineIntersection(a, b, c, d);
      if (!q) continue;
      // Outside the short edge: on its (dy, -dx) side.
      const side = (q.x - b.x) * (c.y - b.y) - (q.y - b.y) * (c.x - b.x);
      if (side < -1e-9 || Math.hypot(q.x - b.x, q.y - b.y) > minLength * 3) continue;
      out.splice(i, 1, q);
      out.splice((i + 1) % out.length, 1);
      merged = true;
      break;
    }
    if (!merged) break;
  }
  return out;
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** Splits edges longer than 1.3 spacings into equal pieces near the spacing. */
function subdivide(loop: readonly Point[], spacing: number): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] as Point;
    const b = loop[(i + 1) % loop.length] as Point;
    out.push({ x: a.x, y: a.y });
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const pieces = length > spacing * 1.3 ? Math.round(length / spacing) : 1;
    for (let k = 1; k < pieces; k++) out.push({ x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces });
  }
  return out;
}

function latticePoints(outline: Outline, spacing: number, axisDegrees: number): WorkPoint[] {
  const angle = (axisDegrees * Math.PI) / 180;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  // Lattice frame: u along the axis, v across it, centred on the outline's centroid.
  const { x: cx, y: cy } = polygonCentroid(outline.outer);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of outline.outer) {
    const u = (p.x - cx) * ux + (p.y - cy) * uy;
    const v = -(p.x - cx) * uy + (p.y - cy) * ux;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  // Rows run along the axis (constant u) so each row is a ring across a limb.
  const rowStep = spacing * SQRT3_2;
  const out: WorkPoint[] = [];
  const firstRow = Math.floor(uMin / rowStep) - 1;
  const lastRow = Math.ceil(uMax / rowStep) + 1;
  for (let row = firstRow; row <= lastRow; row++) {
    const u = row * rowStep;
    const shift = (row & 1) === 0 ? 0 : spacing / 2;
    for (let column = Math.floor(vMin / spacing) - 1; column <= Math.ceil(vMax / spacing) + 1; column++) {
      const v = column * spacing + shift;
      const x = cx + u * ux - v * uy;
      const y = cy + u * uy + v * ux;
      if (!pointInOutline(x, y, outline)) continue;
      if (distanceToOutline(x, y, outline) < spacing * 0.5) continue;
      out.push({ x, y, kind: "interior" });
    }
  }
  return out;
}

export function polygonCentroid(polygon: readonly Point[]): Point {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as Point;
    const b = polygon[i] as Point;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    const n = polygon.length || 1;
    return { x: polygon.reduce((s, p) => s + p.x, 0) / n, y: polygon.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/** Direction (degrees, y down) of the polygon area's major principal axis. */
export function principalAxis(polygon: readonly Point[]): number {
  const c = polygonCentroid(polygon);
  let area = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as Point;
    const b = polygon[i] as Point;
    const ax = a.x - c.x;
    const ay = a.y - c.y;
    const bx = b.x - c.x;
    const by = b.y - c.y;
    const cross = ax * by - bx * ay;
    area += cross / 2;
    xx += ((ax * ax + ax * bx + bx * bx) * cross) / 12;
    yy += ((ay * ay + ay * by + by * by) * cross) / 12;
    xy += ((ax * by + 2 * ax * ay + 2 * bx * by + bx * ay) * cross) / 24;
  }
  if (area < 0) {
    xx = -xx;
    yy = -yy;
    xy = -xy;
  }
  return (0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI;
}
