/*
 * Mesh model (MESH-WEIGHTS-PLAN section 1, chunk M1). Pure logic, no DOM: the editor's Mesh tool
 * edits a `MeshModel` and turns the result into `mesh.edit` commands.
 *
 * Conventions:
 * - `points` are image pixels (x, y per vertex), the unit `mesh.edit` takes.
 * - The first `hull` vertices are the outline loop, in order; the loop is closed (last joins first).
 * - `edges` are the user's extra constraint edges (the hull loop is implicit and never listed).
 * - `origin[i]` is the base mesh's index of vertex i, or -1 for a new vertex. It is kept up to date
 *   by every operation, so a commit hands the engine exactly what it needs to remap deform keys and
 *   references. `baseCount` is the base mesh's vertex count.
 * - Every operation returns a new model, re-triangulated with the hull and the user edges as
 *   constraints. Failures throw `MeshModelError` with a message for the person editing.
 */
import { autoMesh, meshMinAngle, principalAxis, triangleAngles } from "@atlas-animator/core/tools/autoMesh";
import { triangulate } from "@atlas-animator/core/tools/meshEdit";
import { outlineImage, pointInPolygon, polygonArea, segmentDistance, type Point } from "@atlas-animator/core/tools/outline";

export type { Point };

export class MeshModelError extends Error {}

export interface MeshModel {
  points: number[];
  hull: number;
  edges: [number, number][];
  triangles: number[];
  origin: number[];
  baseCount: number;
}

/** The mesh fields the model reads from an attachment (uvs are 0..1, `width`/`height` are the picture size). */
export interface MeshSource {
  uvs: readonly number[];
  triangles: readonly number[];
  hull: number;
  width: number;
  height: number;
  edges?: readonly number[] | undefined;
}

/** Skin / slot / attachment, the address every mesh command takes. */
export interface MeshAddress {
  skin: string;
  slot: string;
  name: string;
}

const SNAP_EPSILON = 1e-6;

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

const hullLoop = (hull: number): [number, number][] => Array.from({ length: hull }, (_, i) => [i, (i + 1) % hull] as [number, number]);
const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Opens an existing attachment as a model (every vertex has itself as origin). User edges are the stored edges minus the hull loop. */
export function modelFromMesh(source: MeshSource): MeshModel {
  const count = source.uvs.length / 2;
  const points: number[] = [];
  for (let v = 0; v < count; v++) points.push((source.uvs[2 * v] as number) * source.width, (source.uvs[2 * v + 1] as number) * source.height);
  const loop = new Set(hullLoop(source.hull).map(([a, b]) => edgeKey(a, b)));
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const stored = source.edges ?? [];
  for (let i = 0; i + 1 < stored.length; i += 2) {
    const a = stored[i] as number;
    const b = stored[i + 1] as number;
    const key = edgeKey(a, b);
    if (a === b || loop.has(key) || seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }
  return { points, hull: source.hull, edges, triangles: Array.from(source.triangles), origin: Array.from({ length: count }, (_, i) => i), baseCount: count };
}

/** A fresh mesh (no vertex descends from the base): used by the generators. */
function freshModel(points: number[], hull: number, edges: [number, number][], baseCount: number): MeshModel {
  const model: MeshModel = { points, hull, edges, triangles: [], origin: Array.from({ length: points.length / 2 }, () => -1), baseCount };
  model.triangles = retriangulate(model);
  return model;
}

function retriangulate(model: Pick<MeshModel, "points" | "hull" | "edges">): number[] {
  if (model.hull < 3) throw new MeshModelError("the outline needs at least 3 vertices");
  try {
    return triangulate(model.points, [...hullLoop(model.hull), ...model.edges]);
  } catch (error) {
    throw new MeshModelError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// Work records: hull ring and interior as objects so reordering can't lose track of origin or edges
// ---------------------------------------------------------------------------------------------

interface Rec {
  x: number;
  y: number;
  o: number;
}
interface Work {
  hull: Rec[];
  inner: Rec[];
  edges: [Rec, Rec][];
  baseCount: number;
}

function open(model: MeshModel): Work {
  const recs: Rec[] = model.origin.map((o, i) => ({ x: model.points[2 * i] as number, y: model.points[2 * i + 1] as number, o }));
  return {
    hull: recs.slice(0, model.hull),
    inner: recs.slice(model.hull),
    edges: model.edges.map(([a, b]) => [recs[a] as Rec, recs[b] as Rec] as [Rec, Rec]),
    baseCount: model.baseCount
  };
}

/** Lays the work out hull first, drops edges that vanished or duplicate the hull loop, and re-triangulates. */
function close(work: Work): MeshModel {
  const recs = [...work.hull, ...work.inner];
  const index = new Map<Rec, number>(recs.map((r, i) => [r, i]));
  const loop = new Set(hullLoop(work.hull.length).map(([a, b]) => edgeKey(a, b)));
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const [ra, rb] of work.edges) {
    const a = index.get(ra);
    const b = index.get(rb);
    if (a === undefined || b === undefined || a === b) continue;
    const key = edgeKey(a, b);
    if (loop.has(key) || seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }
  const model: MeshModel = { points: recs.flatMap((r) => [r.x, r.y]), hull: work.hull.length, edges, triangles: [], origin: recs.map((r) => r.o), baseCount: work.baseCount };
  model.triangles = retriangulate(model);
  return model;
}

function hullPolygon(model: Pick<MeshModel, "points" | "hull">): Point[] {
  return Array.from({ length: model.hull }, (_, i) => ({ x: model.points[2 * i] as number, y: model.points[2 * i + 1] as number }));
}

function checkIndex(model: MeshModel, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v >= model.points.length / 2) throw new MeshModelError(`there is no vertex ${v}`);
}

// ---------------------------------------------------------------------------------------------
// Vertex operations
// ---------------------------------------------------------------------------------------------

export interface EdgeHit {
  kind: "hull" | "user" | "triangle";
  a: number;
  b: number;
  /** The closest point on the edge. */
  x: number;
  y: number;
  distance: number;
}

function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { x: number; y: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { x: ax + t * dx, y: ay + t * dy, t };
}

/** The nearest edge within `tolerance` px of (x, y): hull edges win ties over user edges, which win over plain triangle edges. */
export function findEdge(model: MeshModel, x: number, y: number, tolerance: number): EdgeHit | null {
  const candidates: EdgeHit[] = [];
  const consider = (kind: EdgeHit["kind"], a: number, b: number) => {
    const p = model.points;
    const hit = closestOnSegment(x, y, p[2 * a] as number, p[2 * a + 1] as number, p[2 * b] as number, p[2 * b + 1] as number);
    const distance = Math.hypot(hit.x - x, hit.y - y);
    if (distance <= tolerance) candidates.push({ kind, a, b, x: hit.x, y: hit.y, distance });
  };
  const done = new Set<string>();
  for (const [a, b] of hullLoop(model.hull)) {
    done.add(edgeKey(a, b));
    consider("hull", a, b);
  }
  for (const [a, b] of model.edges) {
    done.add(edgeKey(a, b));
    consider("user", a, b);
  }
  for (let t = 0; t + 2 < model.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = model.triangles[t + k] as number;
      const b = model.triangles[t + ((k + 1) % 3)] as number;
      const key = edgeKey(a, b);
      if (done.has(key)) continue;
      done.add(key);
      consider("triangle", a, b);
    }
  }
  const rank = { hull: 0, user: 1, triangle: 2 };
  candidates.sort((p, q) => (Math.abs(p.distance - q.distance) < 0.25 ? rank[p.kind] - rank[q.kind] : p.distance - q.distance));
  return candidates[0] ?? null;
}

/** Nearest vertex within `radius` px, or -1. */
export function findVertex(model: MeshModel, x: number, y: number, radius: number): number {
  let best = -1;
  let bestDistance = radius;
  for (let v = 0; v < model.points.length / 2; v++) {
    const d = Math.hypot((model.points[2 * v] as number) - x, (model.points[2 * v + 1] as number) - y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  return best;
}

/**
 * Adds a vertex. On an edge (within `tolerance`, default 4 px) it lands on the edge: a hull edge
 * grows the outline, a user edge is split in two, a plain triangle edge just gains an interior
 * vertex. In empty space it must be inside the outline. Returns the new model and the new index.
 */
export function addVertex(model: MeshModel, x: number, y: number, tolerance = 4): { model: MeshModel; index: number } {
  const hit = findEdge(model, x, y, tolerance);
  const work = open(model);
  const rec: Rec = { x, y, o: -1 };
  if (hit) {
    rec.x = hit.x;
    rec.y = hit.y;
    if (findVertex(model, rec.x, rec.y, SNAP_EPSILON) >= 0) throw new MeshModelError("there is already a vertex there");
    if (hit.kind === "hull") {
      const a = hit.a;
      const b = hit.b;
      // Hull edge (a, b): b follows a around the loop (the wrap pair is (hull - 1, 0)).
      const at = b === 0 && a === model.hull - 1 ? model.hull : Math.max(a, b);
      work.hull.splice(at, 0, rec);
    } else {
      work.inner.push(rec);
      if (hit.kind === "user") {
        const ra = work.hull.concat(work.inner)[hit.a] as Rec;
        const rb = work.hull.concat(work.inner)[hit.b] as Rec;
        work.edges = work.edges.filter(([p, q]) => !((p === ra && q === rb) || (p === rb && q === ra)));
        work.edges.push([ra, rec], [rec, rb]);
      }
    }
  } else {
    if (!pointInPolygon(x, y, hullPolygon(model))) throw new MeshModelError("a new vertex has to be inside the outline (use Outline to change the outline)");
    if (findVertex(model, x, y, SNAP_EPSILON) >= 0) throw new MeshModelError("there is already a vertex there");
    work.inner.push(rec);
  }
  const next = close(work);
  return { model: next, index: indexOfRec(work, rec) };
}

function indexOfRec(work: Work, rec: Rec): number {
  const hull = work.hull.indexOf(rec);
  return hull >= 0 ? hull : work.hull.length + work.inner.indexOf(rec);
}

/** Moves vertices by a delta (one undo step for a drag). */
export function moveVertices(model: MeshModel, vertices: Iterable<number>, dx: number, dy: number): MeshModel {
  const points = model.points.slice();
  for (const v of vertices) {
    checkIndex(model, v);
    points[2 * v] = (points[2 * v] as number) + dx;
    points[2 * v + 1] = (points[2 * v + 1] as number) + dy;
  }
  const next: MeshModel = { ...model, points, edges: model.edges, origin: model.origin, triangles: [] };
  next.triangles = retriangulate(next);
  return next;
}

/**
 * Rotates (degrees, clockwise on screen) and scales the listed vertices around a pivot, all in picture pixels.
 * Topology and origins stay; the triangles are rebuilt like after a move.
 */
export function transformVertices(model: MeshModel, vertices: Iterable<number>, pivot: Point, t: { angle?: number; scaleX?: number; scaleY?: number }): MeshModel {
  const sx = t.scaleX ?? 1;
  const sy = t.scaleY ?? 1;
  if (!(Number.isFinite(sx) && Number.isFinite(sy)) || sx === 0 || sy === 0) throw new MeshModelError("scale cannot be zero");
  const a = ((t.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const points = model.points.slice();
  for (const v of vertices) {
    checkIndex(model, v);
    const dx = ((points[2 * v] as number) - pivot.x) * sx;
    const dy = ((points[2 * v + 1] as number) - pivot.y) * sy;
    points[2 * v] = Number((pivot.x + dx * cos - dy * sin).toFixed(4));
    points[2 * v + 1] = Number((pivot.y + dx * sin + dy * cos).toFixed(4));
  }
  const next: MeshModel = { ...model, points, triangles: [] };
  next.triangles = retriangulate(next);
  if (!next.triangles.length) throw new MeshModelError("the outline would cross itself");
  return next;
}

/** UVs that put every vertex on its own picture position (0..1 of the picture). */
export function resetUvs(points: readonly number[], width: number, height: number): number[] {
  if (!(width > 0 && height > 0)) throw new MeshModelError("the picture has no size");
  return points.map((v, i) => Math.min(1, Math.max(0, Number((v / (i % 2 === 0 ? width : height)).toFixed(6)))));
}

/** Moves one vertex to an absolute position. */
export function moveVertex(model: MeshModel, v: number, x: number, y: number): MeshModel {
  checkIndex(model, v);
  return moveVertices(model, [v], x - (model.points[2 * v] as number), y - (model.points[2 * v + 1] as number));
}

/**
 * Deletes vertices. A hull vertex leaves the outline (the neighbours join up); the outline keeps
 * at least 3. Edges that used a deleted vertex go with it.
 */
export function deleteVertices(model: MeshModel, vertices: Iterable<number>): MeshModel {
  const doomed = new Set<number>();
  for (const v of vertices) {
    checkIndex(model, v);
    doomed.add(v);
  }
  if (doomed.size === 0) return model;
  const work = open(model);
  const all = [...work.hull, ...work.inner];
  const gone = new Set<Rec>([...doomed].map((v) => all[v] as Rec));
  const hull = work.hull.filter((r) => !gone.has(r));
  if (hull.length < 3) throw new MeshModelError("the outline needs at least 3 vertices");
  work.hull = hull;
  work.inner = work.inner.filter((r) => !gone.has(r));
  work.edges = work.edges.filter(([a, b]) => !gone.has(a) && !gone.has(b));
  return close(work);
}

export const deleteVertex = (model: MeshModel, v: number): MeshModel => deleteVertices(model, [v]);

// ---------------------------------------------------------------------------------------------
// Edge operations
// ---------------------------------------------------------------------------------------------

function properlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const at = (model: MeshModel, v: number): Point => ({ x: model.points[2 * v] as number, y: model.points[2 * v + 1] as number });

/** Adds a constraint edge between two vertices. A no-op for an edge that already exists as a constraint or outline edge; refuses edges that cross another constraint. */
export function addEdge(model: MeshModel, a: number, b: number): MeshModel {
  checkIndex(model, a);
  checkIndex(model, b);
  if (a === b) throw new MeshModelError("an edge needs two different vertices");
  const key = edgeKey(a, b);
  if (model.edges.some(([p, q]) => edgeKey(p, q) === key) || hullLoop(model.hull).some(([p, q]) => edgeKey(p, q) === key)) return model;
  const pa = at(model, a);
  const pb = at(model, b);
  for (const [p, q] of [...hullLoop(model.hull), ...model.edges]) {
    if (p === a || p === b || q === a || q === b) continue;
    if (properlyCross(pa, pb, at(model, p), at(model, q))) throw new MeshModelError("that edge would cross another edge");
  }
  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  if (!pointInPolygon(mid.x, mid.y, hullPolygon(model))) throw new MeshModelError("that edge would leave the outline");
  const next: MeshModel = { ...model, edges: [...model.edges, [a, b]], triangles: [] };
  next.triangles = retriangulate(next);
  return next;
}

/** Deletes a user constraint edge. Outline edges can't be deleted (remove a vertex or redraw the outline). */
export function deleteEdge(model: MeshModel, a: number, b: number): MeshModel {
  const key = edgeKey(a, b);
  if (hullLoop(model.hull).some(([p, q]) => edgeKey(p, q) === key)) throw new MeshModelError("an outline edge can't be deleted; delete a vertex or redraw the outline");
  const edges = model.edges.filter(([p, q]) => edgeKey(p, q) !== key);
  if (edges.length === model.edges.length) throw new MeshModelError("that is not a constraint edge (it comes from the triangulation)");
  const next: MeshModel = { ...model, edges, triangles: [] };
  next.triangles = retriangulate(next);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Hull operations
// ---------------------------------------------------------------------------------------------

/** Inserts an outline vertex on hull edge `edge` (joining hull vertex `edge` to the next), at (x, y) or the middle. */
export function insertHullVertex(model: MeshModel, edge: number, x?: number, y?: number): { model: MeshModel; index: number } {
  if (!Number.isInteger(edge) || edge < 0 || edge >= model.hull) throw new MeshModelError(`there is no outline edge ${edge}`);
  const a = at(model, edge);
  const b = at(model, (edge + 1) % model.hull);
  const work = open(model);
  const rec: Rec = { x: x ?? (a.x + b.x) / 2, y: y ?? (a.y + b.y) / 2, o: -1 };
  work.hull.splice(edge + 1, 0, rec);
  return { model: close(work), index: edge + 1 };
}

/** Removes an outline vertex (the neighbours join up). */
export const removeHullVertex = (model: MeshModel, v: number): MeshModel => {
  if (v < 0 || v >= model.hull) throw new MeshModelError(`vertex ${v} is not on the outline`);
  return deleteVertices(model, [v]);
};

/** Self-intersection test for a closed polygon. */
export function isSimplePolygon(polygon: readonly Point[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (properlyCross(polygon[i] as Point, polygon[(i + 1) % n] as Point, polygon[j] as Point, polygon[(j + 1) % n] as Point)) return false;
    }
  }
  return true;
}

/**
 * Redraws the outline from clicked points. A click on an existing vertex (within `snap` px) reuses
 * it, so its origin and weights survive; other clicks are new vertices. Old vertices that fall
 * inside the new outline become interior vertices; the rest (and edges on them) are dropped.
 */
export function redrawHull(model: MeshModel, clicks: readonly Point[], snap = 0.5): MeshModel {
  if (clicks.length < 3) throw new MeshModelError("the outline needs at least 3 points");
  let polygon = clicks.slice();
  if (!isSimplePolygon(polygon)) throw new MeshModelError("the outline crosses itself");
  if (polygonArea(polygon) < 0) polygon = polygon.reverse();
  const old = open(model);
  const oldAll = [...old.hull, ...old.inner];
  const used = new Set<Rec>();
  const hull: Rec[] = polygon.map((p) => {
    let best: Rec | undefined;
    let bestD = snap;
    for (const r of oldAll) {
      const d = Math.hypot(r.x - p.x, r.y - p.y);
      if (d <= bestD && !used.has(r)) {
        best = r;
        bestD = d;
      }
    }
    if (best) {
      used.add(best);
      return best;
    }
    return { x: p.x, y: p.y, o: -1 };
  });
  const inner = oldAll.filter((r) => !used.has(r) && pointInPolygon(r.x, r.y, polygon) && !polygon.some((p) => Math.hypot(p.x - r.x, p.y - r.y) < SNAP_EPSILON));
  const alive = new Set<Rec>([...hull, ...inner]);
  return close({ hull, inner, edges: old.edges.filter(([a, b]) => alive.has(a) && alive.has(b)), baseCount: old.baseCount });
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

export const MIN_TRACE_VERTICES = 8;
export const MAX_TRACE_VERTICES = 400;

/** The picture, as far as the generators and validation need it (straight alpha RGBA). */
export interface PictureLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

function clampedPoints(flat: ArrayLike<number>, width: number, height: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(Math.min(width, Math.max(0, flat[i] as number)), Math.min(height, Math.max(0, flat[i + 1] as number)));
  return out;
}

/** Trace picture: the alpha outline plus the engine's auto-mesh, `density` = vertex count (8-400). `baseCount` is the mesh being replaced. */
export function traceMesh(picture: PictureLike, density: number, baseCount = 0, options: { threshold?: number } = {}): MeshModel {
  const target = Math.round(Math.min(MAX_TRACE_VERTICES, Math.max(MIN_TRACE_VERTICES, density)));
  let built;
  try {
    built = autoMesh(outlineImage(picture, options.threshold === undefined ? {} : { threshold: options.threshold }), { targetVertices: target });
  } catch (error) {
    throw new MeshModelError(`couldn't trace the picture: ${error instanceof Error ? error.message : String(error)}`);
  }
  const points = clampedPoints(built.points, picture.width, picture.height);
  const loop = new Set(hullLoop(built.hull).map(([a, b]) => edgeKey(a, b)));
  const edges: [number, number][] = [];
  for (let i = 0; i + 1 < built.edges.length; i += 2) {
    const a = built.edges[i] as number;
    const b = built.edges[i + 1] as number;
    if (!loop.has(edgeKey(a, b))) edges.push([a, b]);
  }
  return freshModel(points, built.hull, edges, baseCount);
}

/** Splits long outline edges so none is longer than `spacing * 1.25` (keeps the grid's rim triangles reasonable). */
function resampleLoop(polygon: readonly Point[], spacing: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    const parts = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
    for (let k = 0; k < parts; k++) out.push({ x: a.x + ((b.x - a.x) * k) / parts, y: a.y + ((b.y - a.y) * k) / parts });
  }
  return out;
}

/**
 * Fill grid: the outline (resampled to about `spacing`) with interior vertices on a square lattice
 * of that spacing, rotated to the outline's principal axis. Lattice points closer than half a
 * spacing to the outline are skipped so the rim triangles stay fat.
 */
export function gridMesh(hull: readonly Point[], spacing: number, baseCount = 0, options: { axis?: number; offset?: Point } = {}): MeshModel {
  const { points, hull: count } = gridPoints(hull, spacing, options);
  return freshModel(points, count, [], baseCount);
}

/** The vertices of a fill grid (outline first), without triangulating. */
function gridPoints(hull: readonly Point[], spacing: number, options: { axis?: number; offset?: Point }): { points: number[]; hull: number } {
  if (!(spacing > 0)) throw new MeshModelError("the grid spacing must be above 0");
  if (hull.length < 3) throw new MeshModelError("the outline needs at least 3 points");
  let loop = hull.slice();
  if (!isSimplePolygon(loop)) throw new MeshModelError("the outline crosses itself");
  if (polygonArea(loop) < 0) loop = loop.reverse();
  loop = resampleLoop(loop, spacing);
  const axis = ((options.axis ?? principalAxis(loop)) * Math.PI) / 180;
  const cos = Math.cos(axis);
  const sin = Math.sin(axis);
  const lattice = loop.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  const minX = Math.min(...lattice.map((p) => p.x));
  const maxX = Math.max(...lattice.map((p) => p.x));
  const minY = Math.min(...lattice.map((p) => p.y));
  const maxY = Math.max(...lattice.map((p) => p.y));
  const ox = options.offset?.x ?? spacing / 2;
  const oy = options.offset?.y ?? spacing / 2;
  const points = loop.flatMap((p) => [p.x, p.y]);
  const margin = spacing * 0.5;
  for (let gy = minY + oy; gy < maxY; gy += spacing) {
    for (let gx = minX + ox; gx < maxX; gx += spacing) {
      const x = gx * cos - gy * sin;
      const y = gx * sin + gy * cos;
      if (!pointInPolygon(x, y, loop)) continue;
      let near = Infinity;
      for (let i = 0; i < loop.length; i++) near = Math.min(near, segmentDistance(x, y, loop[i] as Point, loop[(i + 1) % loop.length] as Point));
      if (near >= margin) points.push(x, y);
    }
  }
  return { points, hull: loop.length };
}

/** Fill grid by vertex count (never below the outline's own vertex count: outline edges are only subdivided, never merged). Bisects the spacing, then tries nearby spacings and lattice phases for the count closest to `count`. */
export function gridMeshForCount(hull: readonly Point[], count: number, baseCount = 0, options: { axis?: number } = {}): MeshModel {
  if (!(count >= 4)) throw new MeshModelError("a mesh needs at least 4 vertices");
  let loop = hull.slice();
  if (polygonArea(loop) < 0) loop = loop.reverse();
  const vertices = (spacing: number, phase: number) => gridPoints(loop, spacing, { ...options, offset: { x: spacing * phase, y: spacing * phase } });
  const countAt = (spacing: number, phase = 0.5) => vertices(spacing, phase).points.length / 2;
  let low = 0.05;
  let high = Math.sqrt(Math.abs(polygonArea(loop))) * 2;
  for (let i = 0; i < 30; i++) {
    const mid = Math.sqrt(low * high);
    if (countAt(mid) > count) low = mid;
    else high = mid;
  }
  const centre = Math.sqrt(low * high);
  let best = { spacing: centre, phase: 0.5, error: Infinity };
  for (let k = -10; k <= 10; k++) {
    const spacing = centre * (1 + k * 0.01);
    for (const phase of [0.5, 0.3, 0.7]) {
      const error = Math.abs(countAt(spacing, phase) - count);
      if (error < best.error) best = { spacing, phase, error };
    }
  }
  const built = vertices(best.spacing, best.phase);
  return freshModel(built.points, built.hull, [], baseCount);
}

/** Keep rectangle: four corners of the picture (or any rectangle) and two triangles. */
export function keepRectangle(width: number, height: number, baseCount = 0, rect?: { x: number; y: number; width: number; height: number }): MeshModel {
  const r = rect ?? { x: 0, y: 0, width, height };
  return freshModel([r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height], 4, [], baseCount);
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------

export interface MeshEditCommand extends MeshAddress {
  op: "mesh.edit";
  points: number[];
  triangles: number[];
  hull: number;
  edges?: number[];
  origin: number[];
}

/** A sibling attachment (crease variant, other skin) that could take the same edit. */
export interface VariantTarget extends MeshAddress {
  /** Its vertex count; only meshes with the same count as the base can take the same edit. */
  vertexCount: number;
  /** Its picture size, when it differs from the base's the points are scaled to match. */
  width?: number;
  height?: number;
}

export interface CommitOptions {
  /** The picture size the model's points are measured in (needed only to scale onto variants of another size). */
  baseSize?: { width: number; height: number };
  /** Variants to repeat the edit on (the "Same edit on variants" tick). Targets with another vertex count are skipped. */
  variants?: readonly VariantTarget[];
}

/** Variants that can take the same edit as a base mesh with `vertexCount` vertices. */
export function compatibleVariants(vertexCount: number, siblings: readonly VariantTarget[]): VariantTarget[] {
  return siblings.filter((s) => s.vertexCount === vertexCount);
}

function commandFor(model: MeshModel, address: MeshAddress, scaleX: number, scaleY: number): MeshEditCommand {
  const points = scaleX === 1 && scaleY === 1 ? model.points.slice() : model.points.map((v, i) => v * (i % 2 === 0 ? scaleX : scaleY));
  const edges = [...hullLoop(model.hull), ...model.edges].flatMap(([a, b]) => [a, b]);
  return { op: "mesh.edit", skin: address.skin, slot: address.slot, name: address.name, points, triangles: model.triangles.slice(), hull: model.hull, edges, origin: model.origin.slice() };
}

/**
 * The `mesh.edit` commands for a model: one for `address`, then one per compatible variant (same
 * vertex count as the base mesh). All go through one `run()` so they undo together.
 */
export function planMeshCommit(model: MeshModel, address: MeshAddress, options: CommitOptions = {}): MeshEditCommand[] {
  if (model.origin.length !== model.points.length / 2) throw new MeshModelError("origin and points disagree");
  if (model.hull < 3) throw new MeshModelError("the outline needs at least 3 vertices");
  const commands = [commandFor(model, address, 1, 1)];
  for (const variant of compatibleVariants(model.baseCount, options.variants ?? [])) {
    if (variant.skin === address.skin && variant.slot === address.slot && variant.name === address.name) continue;
    const sx = options.baseSize && variant.width ? variant.width / options.baseSize.width : 1;
    const sy = options.baseSize && variant.height ? variant.height / options.baseSize.height : 1;
    commands.push(commandFor(model, variant, sx, sy));
  }
  return commands;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export interface MeshIssue {
  kind: "minAngle" | "coverage" | "hull";
  message: string;
  value?: number;
}

export interface ValidateOptions {
  /** Warn below this smallest triangle angle (default 15 degrees). */
  minAngle?: number;
  /** The picture, to check opaque-pixel coverage. */
  picture?: PictureLike;
  /** Alpha at or above this is opaque (default 128). */
  threshold?: number;
  /** Warn below this covered fraction of opaque pixels (default 0.98). */
  minCoverage?: number;
}

/** Fraction of opaque pixels whose centre lies in a triangle of the mesh (1 when the picture is empty). */
export function opaqueCoverage(model: Pick<MeshModel, "points" | "triangles">, picture: PictureLike, threshold = 128): number {
  const covered = new Uint8Array(picture.width * picture.height);
  for (let t = 0; t + 2 < model.triangles.length; t += 3) {
    const a = at(model as MeshModel, model.triangles[t] as number);
    const b = at(model as MeshModel, model.triangles[t + 1] as number);
    const c = at(model as MeshModel, model.triangles[t + 2] as number);
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(picture.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(picture.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area === 0) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9) covered[y * picture.width + x] = 1;
      }
    }
  }
  let opaque = 0;
  let hit = 0;
  for (let i = 0; i < covered.length; i++) {
    if ((picture.data[i * 4 + 3] as number) >= threshold) {
      opaque++;
      if (covered[i]) hit++;
    }
  }
  return opaque === 0 ? 1 : hit / opaque;
}

/** Warnings for the Mesh tool: closed outline, smallest angle, opaque coverage. An empty list means all good. */
export function validateMesh(model: MeshModel, options: ValidateOptions = {}): MeshIssue[] {
  const issues: MeshIssue[] = [];
  const polygon = hullPolygon(model);
  const loop = hullLoop(model.hull);
  // Closed hull: a simple polygon whose every edge borders exactly one triangle.
  const uses = new Map<string, number>();
  for (let t = 0; t + 2 < model.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(model.triangles[t + k] as number, model.triangles[t + ((k + 1) % 3)] as number);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  if (model.hull < 3 || !isSimplePolygon(polygon) || polygonArea(polygon) === 0) issues.push({ kind: "hull", message: "the outline is not a closed loop (it crosses itself or has fewer than 3 vertices)" });
  else if (loop.some(([a, b]) => uses.get(edgeKey(a, b)) !== 1)) issues.push({ kind: "hull", message: "some outline edges are not borders of the mesh (the loop is broken)" });
  if (model.triangles.length === 0) issues.push({ kind: "hull", message: "the mesh has no triangles" });
  else {
    const limit = options.minAngle ?? 15;
    const angle = meshMinAngle(model.points, model.triangles);
    if (angle < limit) issues.push({ kind: "minAngle", message: `thin triangles: the smallest angle is ${angle.toFixed(1)} degrees (aim for ${limit} or more)`, value: angle });
  }
  if (options.picture) {
    const limit = options.minCoverage ?? 0.98;
    const coverage = opaqueCoverage(model, options.picture, options.threshold ?? 128);
    if (coverage < limit) issues.push({ kind: "coverage", message: `${((1 - coverage) * 100).toFixed(1)}% of the opaque pixels are outside the mesh`, value: coverage });
  }
  return issues;
}

export { triangleAngles, meshMinAngle };
