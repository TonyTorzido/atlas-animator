/*
 * Vertex selection and snapping (MESH-WEIGHTS-PLAN section 1, chunk M1), shared by the Mesh,
 * Weights and Shape-keys tools. Pure logic, no DOM: pointers and modifier keys are translated by the
 * tool; everything here takes plain numbers.
 *
 * Selections are `Set<number>` of vertex indices. Every function returns a new set.
 */
import { pointInPolygon, segmentDistance, type Point, type Polygon } from "@atlas-animator/core/tools/outline";

export type Selection = ReadonlySet<number>;

/** Modifier keys: Shift adds, Ctrl toggles, neither replaces. */
export interface SelectModifiers {
  shift?: boolean;
  ctrl?: boolean;
}

export const EMPTY_SELECTION: Selection = new Set<number>();

const vertexCount = (points: ArrayLike<number>): number => Math.floor(points.length / 2);

/** Combines a set of hit vertices with the current selection under the modifier rule. */
export function applyHits(selection: Selection, hits: Iterable<number>, mods: SelectModifiers = {}): Set<number> {
  const hit = new Set(hits);
  if (mods.ctrl) {
    const out = new Set(selection);
    for (const v of hit) {
      if (out.has(v)) out.delete(v);
      else out.add(v);
    }
    return out;
  }
  if (mods.shift) return new Set([...selection, ...hit]);
  return hit;
}

/** The nearest vertex to (x, y) within `radius`, or -1. `ignore` vertices are skipped. */
export function pickVertex(points: ArrayLike<number>, x: number, y: number, radius: number, ignore?: Selection): number {
  let best = -1;
  let bestDistance = radius;
  for (let v = 0; v < vertexCount(points); v++) {
    if (ignore?.has(v)) continue;
    const d = Math.hypot((points[2 * v] as number) - x, (points[2 * v + 1] as number) - y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  return best;
}

/** Click: `hit` is the vertex under the pointer (-1 for empty space). Empty space clears unless Shift or Ctrl is held. */
export function clickSelect(selection: Selection, hit: number, mods: SelectModifiers = {}): Set<number> {
  if (hit < 0) return mods.shift || mods.ctrl ? new Set(selection) : new Set();
  return applyHits(selection, [hit], mods);
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Vertices inside a box (corners in any order, edges inclusive). */
export function verticesInBox(points: ArrayLike<number>, box: Box): number[] {
  const minX = Math.min(box.x0, box.x1);
  const maxX = Math.max(box.x0, box.x1);
  const minY = Math.min(box.y0, box.y1);
  const maxY = Math.max(box.y0, box.y1);
  const out: number[] = [];
  for (let v = 0; v < vertexCount(points); v++) {
    const x = points[2 * v] as number;
    const y = points[2 * v + 1] as number;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(v);
  }
  return out;
}

/** Vertices inside a lasso polygon (even-odd). A lasso under 3 points selects nothing. */
export function verticesInLasso(points: ArrayLike<number>, lasso: readonly Point[]): number[] {
  if (lasso.length < 3) return [];
  const polygon: Polygon = lasso.slice();
  const out: number[] = [];
  for (let v = 0; v < vertexCount(points); v++) if (pointInPolygon(points[2 * v] as number, points[2 * v + 1] as number, polygon)) out.push(v);
  return out;
}

export const boxSelect = (selection: Selection, points: ArrayLike<number>, box: Box, mods: SelectModifiers = {}): Set<number> => applyHits(selection, verticesInBox(points, box), mods);

export const lassoSelect = (selection: Selection, points: ArrayLike<number>, lasso: readonly Point[], mods: SelectModifiers = {}): Set<number> => applyHits(selection, verticesInLasso(points, lasso), mods);

/** Ctrl+A. */
export function selectAll(points: ArrayLike<number>): Set<number> {
  return new Set(Array.from({ length: vertexCount(points) }, (_, i) => i));
}

// ---------------------------------------------------------------------------------------------
// Grow and shrink along edges
// ---------------------------------------------------------------------------------------------

/** Neighbours of every vertex through triangle edges and extra constraint edges. */
export function adjacency(count: number, triangles: ArrayLike<number>, edges: readonly (readonly [number, number])[] = []): Set<number>[] {
  const out = Array.from({ length: count }, () => new Set<number>());
  const link = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || a >= count || b >= count) return;
    out[a]?.add(b);
    out[b]?.add(a);
  };
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    link(a, b);
    link(b, c);
    link(c, a);
  }
  for (const [a, b] of edges) link(a, b);
  return out;
}

/** Adds every neighbour of the selection (one ring). */
export function growSelection(selection: Selection, neighbours: readonly Set<number>[]): Set<number> {
  const out = new Set(selection);
  for (const v of selection) for (const n of neighbours[v] ?? []) out.add(n);
  return out;
}

/** Drops selected vertices that touch an unselected vertex (one ring, the inverse of grow). */
export function shrinkSelection(selection: Selection, neighbours: readonly Set<number>[]): Set<number> {
  const out = new Set<number>();
  for (const v of selection) {
    let inner = true;
    for (const n of neighbours[v] ?? []) if (!selection.has(n)) inner = false;
    if (inner) out.add(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------------------------

export type SnapKind = "vertex" | "hull" | "outline" | "grid" | "none";

export interface SnapResult {
  x: number;
  y: number;
  kind: SnapKind;
  /** The vertex snapped to (kind "vertex"). */
  vertex?: number;
}

export interface SnapContext {
  points: ArrayLike<number>;
  /** Number of leading hull vertices (their loop is closed). */
  hull: number;
  /** The picture outline loops (outer and holes), image px. */
  outline?: readonly (readonly Point[])[];
  /** Snap reach in image px (the tool passes screen radius / zoom). Default 6. */
  radius?: number;
  /** Grid pitch in image px (default 1). */
  grid?: number;
  /** Ctrl suspends all snapping. */
  ctrl?: boolean;
  /** Vertices being dragged: they never snap to themselves. */
  ignore?: Selection;
}

function nearestOnLoop(x: number, y: number, loop: readonly Point[]): { x: number; y: number; distance: number } | null {
  let best: { x: number; y: number; distance: number } | null = null;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] as Point;
    const b = loop[(i + 1) % loop.length] as Point;
    const distance = segmentDistance(x, y, a, b);
    if (best && distance >= best.distance) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    best = { x: a.x + t * dx, y: a.y + t * dy, distance };
  }
  return best;
}

/**
 * Snaps a pointer position. Priority: an existing vertex, a hull edge, the picture outline, then
 * the 1 px grid (which always applies, so positions land on whole pixels). With Ctrl held nothing
 * snaps and the position comes back untouched.
 */
export function snapPoint(x: number, y: number, ctx: SnapContext): SnapResult {
  if (ctx.ctrl) return { x, y, kind: "none" };
  const radius = ctx.radius ?? 6;
  const vertex = pickVertex(ctx.points, x, y, radius, ctx.ignore);
  if (vertex >= 0) return { x: ctx.points[2 * vertex] as number, y: ctx.points[2 * vertex + 1] as number, kind: "vertex", vertex };
  if (ctx.hull >= 2) {
    const loop: Point[] = Array.from({ length: ctx.hull }, (_, i) => ({ x: ctx.points[2 * i] as number, y: ctx.points[2 * i + 1] as number }));
    const hit = nearestOnLoop(x, y, loop);
    if (hit && hit.distance <= radius) return { x: hit.x, y: hit.y, kind: "hull" };
  }
  let outlineHit: { x: number; y: number; distance: number } | null = null;
  for (const loop of ctx.outline ?? []) {
    const hit = nearestOnLoop(x, y, loop);
    if (hit && (!outlineHit || hit.distance < outlineHit.distance)) outlineHit = hit;
  }
  if (outlineHit && outlineHit.distance <= radius) return { x: outlineHit.x, y: outlineHit.y, kind: "outline" };
  const pitch = ctx.grid ?? 1;
  if (pitch > 0) return { x: Math.round(x / pitch) * pitch, y: Math.round(y / pitch) * pitch, kind: "grid" };
  return { x, y, kind: "none" };
}
