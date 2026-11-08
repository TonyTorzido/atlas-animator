/*
 * Atlas Animator editor: original implementation.
 *
 * The deform model ("Shape keys" in Animate, MESH-WEIGHTS-PLAN D3 and section 3): pure functions, no
 * DOM and no Pixi. A world-space drag at the current pose becomes bone-local deform offsets so the
 * vertex lands exactly under the cursor; the result is written into a clip's deform key.
 *
 * Deform layout (core skinning.ts): an unweighted mesh has 2 floats per vertex (slot bone local); a
 * weighted mesh has 2 floats per influence, in that influence bone's local space. World position of
 * a vertex is  sum_i w_i * M_i * (bind_i + d_i), so a world shift D is reached with
 * d_i = (linear part of M_i)^-1 * D for every influence (sum w_i = 1 makes the sum exactly D).
 */
import { computeGeometryWorldVertices, type Bone, type ClipData, type MeshGeometryData } from "@atlas-animator/core/core";
import { KEY_EPSILON, snapTime } from "./clipModel.js";

type DeformKey = ClipData["deform"][string][string][string][number];

/** The posed mesh the model works on. `bones` is the skeleton's bone array (only `world` is read). */
export interface DeformMesh {
  readonly geometry: MeshGeometryData;
  /** The bone of the slot holding the mesh (used by an unweighted mesh). */
  readonly slotBone: Pick<Bone, "world">;
  /** Skeleton bones, indexed like `geometry.influenceBones`. */
  readonly bones: readonly Pick<Bone, "world">[];
}

/** skin / slot / attachment, the address of a deform timeline in a clip. */
export interface DeformAddress {
  readonly skin: string;
  readonly slot: string;
  readonly attachment: string;
}

export interface DragResult {
  /** The new full-length deform array (the base with the drag added). */
  readonly deform: Float64Array;
  /** Deform float index -> new value, for every float the drag changed. */
  readonly edits: Map<number, number>;
  /** Vertices whose deform changed. */
  readonly touched: number[];
}

/** Deform values closer to 0 than this are treated as 0 when a key is trimmed. */
export const DEFORM_ZERO_EPSILON = 1e-6;
const SINGULAR = 1e-9;
const STORE_DIGITS = 5;

const storeRound = (v: number): number => {
  const f = 10 ** STORE_DIGITS;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

// ---------------------------------------------------------------------------------------------
// Layout and positions
// ---------------------------------------------------------------------------------------------

/** Index of each vertex's first deform float (length vertexCount + 1; the last entry is the deform length). */
export function vertexFloatStarts(geometry: MeshGeometryData): Uint32Array {
  const out = new Uint32Array(geometry.vertexCount + 1);
  let at = 0;
  for (let v = 0; v < geometry.vertexCount; v++) {
    out[v] = at;
    at += 2 * (geometry.weighted ? (geometry.counts[v] as number) : 1);
  }
  out[geometry.vertexCount] = at;
  return out;
}

/** World positions (x, y per vertex) of the mesh with `deform` (null = rest), straight from core skinning. */
export function worldPositions(mesh: DeformMesh, deform: ArrayLike<number> | null): Float64Array {
  const out = new Float64Array(mesh.geometry.vertexCount * 2);
  computeGeometryWorldVertices(mesh.geometry, mesh.slotBone as Bone, mesh.bones as readonly Bone[], deform, out);
  return out;
}

function inverseApply(m: { a: number; b: number; c: number; d: number }, dx: number, dy: number): [number, number] | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < SINGULAR) return null;
  return [(m.d * dx - m.b * dy) / det, (m.a * dy - m.c * dx) / det];
}

function influenceStart(g: MeshGeometryData, v: number): number {
  let at = 0;
  for (let i = 0; i < v; i++) at += g.counts[i] as number;
  return at;
}

/**
 * Bone-local offsets that move vertex `v` by the world shift (dx, dy): one (x, y) pair per influence
 * (a single pair for an unweighted vertex). Null when no influence can carry the move.
 */
export function worldDeltaToOffsets(mesh: DeformMesh, v: number, dx: number, dy: number): number[] | null {
  return offsetsAt(mesh, v, influenceStart(mesh.geometry, v), dx, dy);
}

function offsetsAt(mesh: DeformMesh, v: number, start: number, dx: number, dy: number): number[] | null {
  const g = mesh.geometry;
  if (!g.weighted) {
    const p = inverseApply(mesh.slotBone.world, dx, dy);
    return p ? [p[0], p[1]] : null;
  }
  const count = g.counts[v] as number;
  const usable: boolean[] = [];
  let carried = 0;
  for (let k = 0; k < count; k++) {
    const w = g.weights[start + k] as number;
    const world = (mesh.bones[g.influenceBones[start + k] as number] as Pick<Bone, "world">).world;
    const ok = w > 0 && inverseApply(world, 1, 0) !== null;
    usable.push(ok);
    if (ok) carried += w;
  }
  if (carried < SINGULAR) return null;
  // Weights are used as stored (the runtime does not renormalise), so scale by the weight that can actually move.
  const scale = 1 / carried;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    if (!usable[k]) {
      out.push(0, 0);
      continue;
    }
    const world = (mesh.bones[g.influenceBones[start + k] as number] as Pick<Bone, "world">).world;
    const p = inverseApply(world, dx * scale, dy * scale) as [number, number];
    out.push(p[0], p[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Soft selection
// ---------------------------------------------------------------------------------------------

/** 1 at distance 0 easing to 0 at `radius` (cosine ease; radius <= 0 affects only distance 0). */
export function falloff(distance: number, radius: number): number {
  if (distance <= 0) return 1;
  if (radius <= 0 || distance >= radius) return 0;
  return 0.5 + 0.5 * Math.cos(Math.PI * (distance / radius));
}

export type FalloffMode = "straight" | "edge";

/** Unique vertex pairs of a triangle list, flattened [a0, b0, a1, b1, ...]. */
export function edgesOfTriangles(triangles: ArrayLike<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = triangles[i + e] as number;
      const b = triangles[i + ((e + 1) % 3)] as number;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * 4294967296 + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lo, hi);
    }
  }
  return out;
}

type HeapItem = [number, number];

/** Distance from each vertex to the nearest selected vertex: straight line, or along the mesh edges. */
export function selectionDistances(
  positions: ArrayLike<number>,
  selection: Iterable<number>,
  mode: FalloffMode,
  triangles?: ArrayLike<number>
): Float64Array {
  const count = positions.length / 2;
  const sel = [...selection];
  const dist = new Float64Array(count).fill(Infinity);
  const gap = (a: number, b: number) =>
    Math.hypot((positions[a * 2] as number) - (positions[b * 2] as number), (positions[a * 2 + 1] as number) - (positions[b * 2 + 1] as number));
  if (mode === "straight" || !triangles) {
    for (let v = 0; v < count; v++) {
      let best = Infinity;
      for (const s of sel) best = Math.min(best, gap(v, s));
      dist[v] = best;
    }
    return dist;
  }
  const edges = edgesOfTriangles(triangles);
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < edges.length; i += 2) {
    adjacency[edges[i] as number]!.push(edges[i + 1] as number);
    adjacency[edges[i + 1] as number]!.push(edges[i] as number);
  }
  // Multi-source Dijkstra on a binary min-heap.
  const heap: HeapItem[] = [];
  const swap = (i: number, j: number) => {
    const t = heap[i] as HeapItem;
    heap[i] = heap[j] as HeapItem;
    heap[j] = t;
  };
  const push = (item: HeapItem) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] as HeapItem)[0] <= (heap[i] as HeapItem)[0]) break;
      swap(p, i);
      i = p;
    }
  };
  const pop = (): HeapItem => {
    const top = heap[0] as HeapItem;
    const last = heap.pop() as HeapItem;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l] as HeapItem)[0] < (heap[m] as HeapItem)[0]) m = l;
        if (r < heap.length && (heap[r] as HeapItem)[0] < (heap[m] as HeapItem)[0]) m = r;
        if (m === i) break;
        swap(m, i);
        i = m;
      }
    }
    return top;
  };
  for (const s of sel) {
    dist[s] = 0;
    push([0, s]);
  }
  while (heap.length > 0) {
    const [d, v] = pop();
    if (d > (dist[v] as number)) continue;
    for (const u of adjacency[v] as number[]) {
      const nd = d + gap(u, v);
      if (nd < (dist[u] as number)) {
        dist[u] = nd;
        push([nd, u]);
      }
    }
  }
  return dist;
}

/**
 * Per-vertex influence 0..1 of a soft selection: selected vertices are 1, the rest follow `falloff`
 * of their distance to the selection (straight line or along the mesh's edge graph, measured on
 * `positions`, normally the posed world positions). Radius 0 affects the selection only.
 */
export function softSelectionWeights(
  mesh: DeformMesh,
  positions: ArrayLike<number>,
  selection: Iterable<number>,
  radius: number,
  mode: FalloffMode = "straight"
): Float64Array {
  const sel = [...selection];
  const dist = selectionDistances(positions, sel, mode, mesh.geometry.triangles);
  const out = new Float64Array(mesh.geometry.vertexCount);
  for (let v = 0; v < out.length; v++) out[v] = falloff(dist[v] as number, radius);
  for (const s of sel) out[s] = 1;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Moving vertices
// ---------------------------------------------------------------------------------------------

/**
 * Applies a world shift per vertex (`shifts[2v], shifts[2v+1]`; zero = untouched) on top of `base`
 * (the deform at drag start, full length; null = none). Each vertex lands exactly at its posed
 * position plus the shift.
 */
export function applyWorldShifts(mesh: DeformMesh, base: ArrayLike<number> | null, shifts: ArrayLike<number>): DragResult {
  const g = mesh.geometry;
  const starts = vertexFloatStarts(g);
  const deform = new Float64Array(g.deformLength);
  if (base) for (let i = 0; i < deform.length; i++) deform[i] = base[i] as number;
  const edits = new Map<number, number>();
  const touched: number[] = [];
  let influence = 0;
  for (let v = 0; v < g.vertexCount; v++) {
    const start = influence;
    if (g.weighted) influence += g.counts[v] as number;
    const dx = shifts[v * 2] as number;
    const dy = shifts[v * 2 + 1] as number;
    if (dx === 0 && dy === 0) continue;
    const offsets = offsetsAt(mesh, v, start, dx, dy);
    if (!offsets) continue;
    const at = starts[v] as number;
    for (let k = 0; k < offsets.length; k++) {
      deform[at + k] = (deform[at + k] as number) + (offsets[k] as number);
      edits.set(at + k, deform[at + k] as number);
    }
    touched.push(v);
  }
  return { deform, edits, touched };
}

/**
 * Drag: every vertex moves by the world delta (dx, dy) times its soft-selection influence
 * (`influence`, from softSelectionWeights); with no `influence`, only `selection` moves.
 */
export function dragVertices(
  mesh: DeformMesh,
  base: ArrayLike<number> | null,
  dx: number,
  dy: number,
  influence: ArrayLike<number> | null,
  selection: Iterable<number> = []
): DragResult {
  const n = mesh.geometry.vertexCount;
  const shifts = new Float64Array(n * 2);
  if (influence) {
    for (let v = 0; v < n; v++) {
      const f = influence[v] as number;
      shifts[v * 2] = dx * f;
      shifts[v * 2 + 1] = dy * f;
    }
  } else {
    for (const v of selection) {
      shifts[v * 2] = dx;
      shifts[v * 2 + 1] = dy;
    }
  }
  return applyWorldShifts(mesh, base, shifts);
}

export interface SelectionTransform {
  /** Rotation about the centre, radians (positive turns world x toward world y). */
  readonly rotate?: number;
  /** Scale along `axis` (1 = unchanged). Equal scaleX and scaleY is a uniform scale. */
  readonly scaleX?: number;
  /** Scale across `axis`; a value different from scaleX is the non-uniform "squash". */
  readonly scaleY?: number;
  /** Direction of scaleX in world space, radians (default 0 = world x). */
  readonly axis?: number;
}

/** Centroid of the selected vertices' positions, or null for an empty selection. */
export function selectionCentre(positions: ArrayLike<number>, selection: Iterable<number>): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const v of selection) {
    x += positions[v * 2] as number;
    y += positions[v * 2 + 1] as number;
    n++;
  }
  return n === 0 ? null : { x: x / n, y: y / n };
}

/**
 * Rotates and/or scales (uniform or squash) the selection around its centre. `positions` are the
 * posed world positions at drag start (matching `base`). Soft-selected vertices follow by their
 * influence: each moves by influence * (transformed position - position).
 */
export function transformVertices(
  mesh: DeformMesh,
  base: ArrayLike<number> | null,
  positions: ArrayLike<number>,
  selection: Iterable<number>,
  influence: ArrayLike<number> | null,
  transform: SelectionTransform,
  centre?: { x: number; y: number }
): DragResult {
  const sel = [...selection];
  const c = centre ?? selectionCentre(positions, sel);
  const n = mesh.geometry.vertexCount;
  const shifts = new Float64Array(n * 2);
  if (c) {
    const sx = transform.scaleX ?? 1;
    const sy = transform.scaleY ?? 1;
    const ca = Math.cos(transform.axis ?? 0);
    const sa = Math.sin(transform.axis ?? 0);
    const cr = Math.cos(transform.rotate ?? 0);
    const sr = Math.sin(transform.rotate ?? 0);
    const apply = (v: number, f: number) => {
      const qx = (positions[v * 2] as number) - c.x;
      const qy = (positions[v * 2 + 1] as number) - c.y;
      // into the axis frame, scale, back out, then rotate
      const su = (qx * ca + qy * sa) * sx;
      const sw = (-qx * sa + qy * ca) * sy;
      const px = su * ca - sw * sa;
      const py = su * sa + sw * ca;
      shifts[v * 2] = (px * cr - py * sr - qx) * f;
      shifts[v * 2 + 1] = (px * sr + py * cr - qy) * f;
    };
    if (influence) for (let v = 0; v < n; v++) apply(v, influence[v] as number);
    else for (const v of sel) apply(v, 1);
  }
  return applyWorldShifts(mesh, base, shifts);
}

// ---------------------------------------------------------------------------------------------
// Deform keys in a clip
// ---------------------------------------------------------------------------------------------

/** Trims leading and trailing zeros: the minimal `offset` and `vertices` span (all zero -> offset 0, no vertices). */
export function trimDeform(full: ArrayLike<number>): { offset: number; vertices: number[] } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < full.length; i++) {
    if (Math.abs(full[i] as number) > DEFORM_ZERO_EPSILON) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { offset: 0, vertices: [] };
  const vertices: number[] = [];
  for (let i = first; i <= last; i++) vertices.push(storeRound(full[i] as number));
  return { offset: first, vertices };
}

/** Expands a key to the full deform array (zeros outside its span). */
export function expandDeformKey(key: Pick<DeformKey, "offset" | "vertices">, length: number): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < key.vertices.length; i++) {
    const at = key.offset + i;
    if (at < length) out[at] = key.vertices[i] as number;
  }
  return out;
}

export function getDeformKeys(clip: ClipData, address: DeformAddress): DeformKey[] | undefined {
  return clip.deform[address.skin]?.[address.slot]?.[address.attachment];
}

/** The deform key at `time` (within KEY_EPSILON), if any. */
export function deformKeyAt(clip: ClipData, address: DeformAddress, time: number): DeformKey | undefined {
  return getDeformKeys(clip, address)?.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
}

function writeKeys(next: ClipData, address: DeformAddress, keys: DeformKey[]): void {
  const { skin, slot, attachment } = address;
  if (keys.length > 0) {
    ((next.deform[skin] ??= {})[slot] ??= {})[attachment] = keys;
    return;
  }
  const slots = next.deform[skin];
  const attachments = slots?.[slot];
  if (slots && attachments) {
    delete attachments[attachment];
    if (Object.keys(attachments).length === 0) delete slots[slot];
    if (Object.keys(slots).length === 0) delete next.deform[skin];
  }
}

/**
 * Sets the deform key at `time` from a full-length deform array, stored as the minimal nonzero span.
 * An existing key keeps its curve; a new key uses `curve` (default linear).
 */
export function setDeformKey(clip: ClipData, address: DeformAddress, time: number, full: ArrayLike<number>, curve: DeformKey["curve"] = "linear"): ClipData {
  const next = structuredClone(clip);
  const t = snapTime(next, time);
  const keys = [...(getDeformKeys(next, address) ?? [])];
  const at = keys.findIndex((k) => Math.abs(k.time - t) < KEY_EPSILON);
  const old = at >= 0 ? keys[at] : undefined;
  const key: DeformKey = { time: old?.time ?? t, ...trimDeform(full), curve: old?.curve ?? curve };
  if (at >= 0) keys[at] = key;
  else {
    keys.push(key);
    keys.sort((a, b) => a.time - b.time);
  }
  writeKeys(next, address, keys);
  return next;
}

/**
 * Merges `edits` (deform float index -> value) into the key at `time`. Floats the edits do not name
 * keep the key's existing values; when the frame has no key yet they come from `sampled` (the deform
 * showing on that frame, so creating the key does not move anything else), else 0.
 */
export function mergeDeformKey(
  clip: ClipData,
  address: DeformAddress,
  time: number,
  length: number,
  edits: ReadonlyMap<number, number>,
  sampled?: ArrayLike<number> | null
): ClipData {
  const t = snapTime(clip, time);
  const existing = deformKeyAt(clip, address, t);
  let full: Float64Array;
  if (existing) full = expandDeformKey(existing, length);
  else {
    full = new Float64Array(length);
    if (sampled) for (let i = 0; i < length; i++) full[i] = (sampled[i] as number | undefined) ?? 0;
  }
  for (const [i, v] of edits) if (i >= 0 && i < length) full[i] = v;
  return setDeformKey(clip, address, t, full);
}

/**
 * Clear 1: zeroes the selected vertices on this frame (the key stays, those vertices keyed at 0).
 * With no key on the frame, the other vertices keep `sampled`.
 */
export function clearVerticesOnFrame(
  clip: ClipData,
  address: DeformAddress,
  time: number,
  geometry: MeshGeometryData,
  selection: Iterable<number>,
  sampled?: ArrayLike<number> | null
): ClipData {
  const starts = vertexFloatStarts(geometry);
  const edits = new Map<number, number>();
  for (const v of selection) {
    if (v < 0 || v >= geometry.vertexCount) continue;
    for (let i = starts[v] as number; i < (starts[v + 1] as number); i++) edits.set(i, 0);
  }
  return mergeDeformKey(clip, address, time, geometry.deformLength, edits, sampled);
}

/** Clear 2: deletes the key on this frame. Empty timelines are removed (the format rejects them). */
export function deleteDeformKey(clip: ClipData, address: DeformAddress, time: number): ClipData {
  const t = snapTime(clip, time);
  if (!deformKeyAt(clip, address, t)) return clip;
  const next = structuredClone(clip);
  writeKeys(next, address, (getDeformKeys(next, address) ?? []).filter((k) => Math.abs(k.time - t) >= KEY_EPSILON));
  return next;
}

/** Clear 3: removes the whole deform timeline of the attachment. */
export function clearDeformTimeline(clip: ClipData, address: DeformAddress): ClipData {
  if (!getDeformKeys(clip, address)) return clip;
  const next = structuredClone(clip);
  writeKeys(next, address, []);
  return next;
}
