/*
 * Atlas Animator: original implementation.
 *
 * World vertices of attachments: linear blend skinning on the CPU.
 *
 * Linear blend skinning (Magnenat-Thalmann et al. 1988; the standard "skeletal subspace
 * deformation"): a vertex bound to bones i = 1..n with weights w_i and bind positions p_i (the
 * vertex expressed in bone i's local space at bind time) lands at
 *
 *     world = sum_i  w_i * M_i * (p_i + d_i)
 *
 * where M_i is bone i's current world transform and d_i the deform offset for that influence.
 * Weights are used as stored (the tools normalise them; the runtime does not renormalise).
 * Unweighted meshes are the n = 1 case with the slot bone and weight 1.
 *
 * Deform offsets are in bind space: per influence for weighted meshes, per vertex for unweighted
 * ones, so a deform key moves a vertex along with whatever its bones do.
 *
 * Every function writes into a caller-owned array and allocates nothing.
 */
import type { BoundingBoxAttachment, ClippingAttachment, MeshAttachment, MeshEmbedData, MeshGeometryData, PointAttachment, RegionAttachment } from "./attachments.js";
import type { Bone } from "./bone.js";
import { DEG_TO_RAD, RAD_TO_DEG } from "./math.js";

/** Anything indexable by number that can be written (Float32Array, Float64Array, number[]). */
export interface NumberArray {
  [index: number]: number;
  readonly length: number;
}

/**
 * Writes the mesh's world vertices into `out` starting at `offset`, `stride` floats apart
 * (x at out[offset + v * stride], y right after it).
 *
 * @param slotBone the slot's bone (used by unweighted meshes)
 * @param bones    the skeleton's bones, indexed like the document (used by weighted meshes)
 * @param deform   deform offsets (geometry.deformLength floats) or null for none
 */
export function computeMeshWorldVertices(
  mesh: MeshAttachment,
  slotBone: Bone,
  bones: readonly Bone[],
  deform: ArrayLike<number> | null,
  out: NumberArray,
  offset = 0,
  stride = 2
): void {
  computeGeometryWorldVertices(mesh.geometry, slotBone, bones, deform, out, offset, stride);
}

export function computeGeometryWorldVertices(
  geometry: MeshGeometryData,
  slotBone: Bone,
  bones: readonly Bone[],
  deform: ArrayLike<number> | null,
  out: NumberArray,
  offset = 0,
  stride = 2
): void {
  const { bind, vertexCount } = geometry;

  if (!geometry.weighted) {
    const { a, b, c, d, x: tx, y: ty } = slotBone.world;
    for (let v = 0, o = offset; v < vertexCount; v++, o += stride) {
      const i = v * 2;
      let x = bind[i] as number;
      let y = bind[i + 1] as number;
      if (deform) {
        x += deform[i] as number;
        y += deform[i + 1] as number;
      }
      out[o] = a * x + b * y + tx;
      out[o + 1] = c * x + d * y + ty;
    }
    return;
  }

  const { counts, influenceBones, weights } = geometry;
  let influence = 0;
  for (let v = 0, o = offset; v < vertexCount; v++, o += stride) {
    let wx = 0;
    let wy = 0;
    const end = influence + (counts[v] as number);
    for (; influence < end; influence++) {
      const world = (bones[influenceBones[influence] as number] as Bone).world;
      const i = influence * 2;
      let x = bind[i] as number;
      let y = bind[i + 1] as number;
      if (deform) {
        x += deform[i] as number;
        y += deform[i + 1] as number;
      }
      const w = weights[influence] as number;
      wx += (world.a * x + world.b * y + world.x) * w;
      wy += (world.c * x + world.d * y + world.y) * w;
    }
    out[o] = wx;
    out[o + 1] = wy;
  }
}

/** Writes the region's four world corners (top-left, top-right, bottom-right, bottom-left). */
export function computeRegionWorldVertices(
  region: RegionAttachment,
  bone: Bone,
  out: NumberArray,
  offset = 0,
  stride = 2
): void {
  const { a, b, c, d, x: tx, y: ty } = bone.world;
  const offsets = region.offsets;
  for (let corner = 0, o = offset; corner < 4; corner++, o += stride) {
    const x = offsets[corner * 2] as number;
    const y = offsets[corner * 2 + 1] as number;
    out[o] = a * x + b * y + tx;
    out[o + 1] = c * x + d * y + ty;
  }
}

/** World vertices (x, y pairs) of a clipping or bounding-box polygon on its bone. Writes 2 floats per vertex into `out`. */
export function computePolygonWorld(polygon: ClippingAttachment | BoundingBoxAttachment, bone: Bone, out: NumberArray): number {
  const { a, b, c, d, x: tx, y: ty } = bone.world;
  const v = polygon.vertices;
  for (let i = 0; i < v.length; i += 2) {
    const x = v[i] as number;
    const y = v[i + 1] as number;
    out[i] = a * x + b * y + tx;
    out[i + 1] = c * x + d * y + ty;
  }
  return v.length / 2;
}

/** Even-odd point-in-polygon test of x, y pairs `world[0 .. count * 2)` (either winding, convex or concave). */
export function pointInPolygon(world: ArrayLike<number>, count: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = world[i * 2] as number;
    const yi = world[i * 2 + 1] as number;
    const xj = world[j * 2] as number;
    const yj = world[j * 2 + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface PointWorld {
  x: number;
  y: number;
  /** World direction of the point's X axis, degrees clockwise. */
  rotation: number;
}

/** World position and direction of a point attachment on its bone. */
export function computePointWorld(point: PointAttachment, bone: Bone, out: PointWorld): PointWorld {
  const { a, b, c, d, x: tx, y: ty } = bone.world;
  out.x = a * point.x + b * point.y + tx;
  out.y = c * point.x + d * point.y + ty;
  const r = point.rotation * DEG_TO_RAD;
  // The point's direction is a local vector; the bone's matrix (including any scale or shear)
  // maps it into the world.
  const dx = Math.cos(r);
  const dy = Math.sin(r);
  out.rotation = Math.atan2(c * dx + d * dy, a * dx + b * dy) * RAD_TO_DEG;
  return out;
}

/**
 * Overwrites the embedded vertices of `world` (2 floats per vertex) with their points on the
 * source mesh's posed vertices `source`: a posed-triangle embedding, evaluated exactly
 * like a mesh-bound contour point, so an embedded vertex and the surface point under it agree bit
 * for bit.
 */
export function computeEmbeddedVertices(embed: MeshEmbedData, source: ArrayLike<number>, world: NumberArray): void {
  const { vertices, refs, refWeights } = embed;
  for (let i = 0, r = 0; i < vertices.length; i++, r += 3) {
    const v = (vertices[i] as number) * 2;
    const a = (refs[r] as number) * 2;
    const b = (refs[r + 1] as number) * 2;
    const c = (refs[r + 2] as number) * 2;
    const wa = refWeights[r] as number;
    const wb = refWeights[r + 1] as number;
    const wc = refWeights[r + 2] as number;
    world[v] = (source[a] as number) * wa + (source[b] as number) * wb + (source[c] as number) * wc;
    world[v + 1] = (source[a + 1] as number) * wa + (source[b + 1] as number) * wb + (source[c + 1] as number) * wc;
  }
  const ov = embed.offsetVertices;
  if (!ov.length) return;
  const pos = embed.offsetScratch;
  computeOffsetPoints(world, embed.offsetRefs, embed.offsetDist, embed.offsetChains, pos, embed.offsetFlags);
  for (let i = 0; i < ov.length; i++) {
    const v = (ov[i] as number) * 2;
    world[v] = pos[i * 2] as number;
    world[v + 1] = pos[i * 2 + 1] as number;
  }
}

/** Longest miter of a boundary offset vertex, in offset distances (a sharper corner is a bounded join). */
export const OFFSET_MITER_LIMIT = 2;
/**
 * Offset chains (notch fix): the boundary offset entries in walk order, one chain per
 * boundary run. `order` lists entry indices chain by chain, chain c being order[starts[c] ..
 * starts[c + 1]); `cyclic[c]` = 1 when its last entry links back to its first.
 */
export interface OffsetChains {
  readonly order: Int32Array;
  readonly starts: Int32Array;
  readonly cyclic: Uint8Array;
}

/** Offset chains from per-entry successors (`next[i]` = the following entry on its run, or -1). */
export function offsetChainsFromNext(next: ArrayLike<number>): OffsetChains {
  const n = next.length;
  const hasPrev = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const j = next[i] as number; if (j >= 0 && j < n) hasPrev[j] = 1; }
  const seen = new Uint8Array(n);
  const order: number[] = [];
  const starts: number[] = [];
  const cyclic: number[] = [];
  const walk = (s: number, cyc: boolean) => {
    starts.push(order.length);
    cyclic.push(cyc ? 1 : 0);
    for (let i = s; i >= 0 && i < n && !seen[i]; i = next[i] as number) { seen[i] = 1; order.push(i); }
  };
  for (let i = 0; i < n; i++) if (!hasPrev[i] && !seen[i]) walk(i, false);
  for (let i = 0; i < n; i++) if (!seen[i]) walk(i, true); // what is left is cycles
  starts.push(order.length);
  return { order: Int32Array.from(order), starts: Int32Array.from(starts), cyclic: Uint8Array.from(cyclic) };
}

/** `computeOffsetPoints` flags per entry: on a clipped concave join / at a bounded convex miter. */
export const OFFSET_FLAG_CLIPPED = 1;
export const OFFSET_FLAG_MITER = 4;
const OFFSET_FLAG_CELL = 2; // internal: the cell from this entry to the next one is inside a clip
/**
 * Concave joins (notch fix): a cell (anchors i -> i+1 and their offset points) is folded
 * when either of its two strip triangles keeps less than this fraction of the straight cell's area
 * (or turns over). Folded cells are joined into a clip.
 */
export const OFFSET_CELL_MIN = 0.05;
/** Along a clipped corner, the offset points keep this fraction of their anchors' spacing. */
export const OFFSET_CLIP_SPREAD = 0.25;
/** A clip corner lies at most this many offset distances (plus half the clip's arc) from its anchors' midpoint. */
export const OFFSET_CLIP_REACH = 4;
const OFFSET_OUT = new Float64Array(2);

/**
 * The boundary offset point of anchor vertex `a`: the posed polyline p -> a -> n (p or n
 * = a at a branch end) offset by `d` along the miter of its two edge normals (right of the walk
 * direction for d > 0, y-up), so the offset polyline keeps distance d from both edges; the miter is
 * bounded at OFFSET_MITER_LIMIT. The offset is never shortened: on the concave side of a turn it is
 * the miter point, d from both edges (neighbours that cross are resolved per chain by
 * computeOffsetPoints, which never pulls a point toward the body). Writes `out` and returns the miter
 * scale used (1 on a straight boundary, OFFSET_MITER_LIMIT at a bounded miter). Shared by the runtime
 * and the garment tools, so both pose the margin identically.
 */
export function offsetPoint(world: ArrayLike<number>, a: number, p: number, n: number, d: number, out: NumberArray): number {
  const ax = world[a * 2] as number;
  const ay = world[a * 2 + 1] as number;
  let t1x = ax - (world[p * 2] as number);
  let t1y = ay - (world[p * 2 + 1] as number);
  let t2x = (world[n * 2] as number) - ax;
  let t2y = (world[n * 2 + 1] as number) - ay;
  let l1 = Math.hypot(t1x, t1y);
  let l2 = Math.hypot(t2x, t2y);
  if (l1 < 1e-9) { t1x = t2x; t1y = t2y; l1 = l2; }
  if (l2 < 1e-9) { t2x = t1x; t2y = t1y; l2 = l1; }
  if (l1 < 1e-9) { out[0] = ax; out[1] = ay; return 1; }
  const n1x = t1y / l1;
  const n1y = -t1x / l1;
  const n2x = t2y / l2;
  const n2y = -t2x / l2;
  let bx = n1x + n2x;
  let by = n1y + n2y;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-9) { bx = n1x; by = n1y; } else { bx /= bl; by /= bl; }
  const cosHalf = bx * n1x + by * n1y;
  const scale = cosHalf > 1 / OFFSET_MITER_LIMIT ? 1 / cosHalf : OFFSET_MITER_LIMIT;
  out[0] = ax + bx * d * scale;
  out[1] = ay + by * d * scale;
  return scale;
}

/** cross(q - p, r - p) (twice the signed triangle area). */
function area2(px: number, py: number, qx: number, qy: number, rx: number, ry: number): number {
  return (qx - px) * (ry - py) - (rx - px) * (qy - py);
}

/**
 * All boundary offset points of a mesh (notch fix), 2 floats per entry into `out`:
 * entry i = offsetPoint of refs [3i] (anchor), [3i+1] (prev), [3i+2] (next) at dist[i]. Then, per
 * chain, cells whose offset points crossed or nearly met (a concave turn whose miter slides exceed
 * the short edges between them: the shoulder top on a raise) are joined into clips. A clip's points
 * move onto the clipped intersection of the two offset lines bounding it (the line of the edge
 * entering its first entry and of the edge leaving its last), spread along those lines around the
 * corner in walk order (OFFSET_CLIP_SPREAD of the anchors' spacing). The lines are offset by the margins of
 * the entries just outside the clip (they share those edges), so a clip point is a declared margin from
 * both bounding lines and on the neighbours' offset curve: never pulled toward the body, no step;
 * a clip grows until its neighbouring cells unfold.
 * `flags` (one per entry) receives OFFSET_FLAG_CLIPPED / OFFSET_FLAG_MITER. Allocates nothing.
 */
export function computeOffsetPoints(world: ArrayLike<number>, refs: ArrayLike<number>, dist: ArrayLike<number>, chains: OffsetChains, out: NumberArray, flags: Uint8Array): void {
  const count = dist.length;
  for (let i = 0; i < count; i++) {
    const scale = offsetPoint(world, refs[i * 3] as number, refs[i * 3 + 1] as number, refs[i * 3 + 2] as number, dist[i] as number, OFFSET_OUT);
    out[i * 2] = OFFSET_OUT[0] as number;
    out[i * 2 + 1] = OFFSET_OUT[1] as number;
    flags[i] = scale >= OFFSET_MITER_LIMIT - 1e-9 ? OFFSET_FLAG_MITER : 0;
  }
  const { order, starts, cyclic } = chains;
  for (let c = 0; c + 1 < starts.length; c++) {
    const s0 = starts[c] as number;
    const m = (starts[c + 1] as number) - s0;
    const cyc = cyclic[c] === 1;
    const cells = cyc ? m : m - 1;
    if (cells < 1) continue;
    for (let pass = 0; pass <= cells; pass++) {
      // fold test on every cell not yet in a clip
      let grew = false;
      for (let k = 0; k < cells; k++) {
        const i = chainAt(order, s0, m, cyc, k);
        if ((flags[i] as number) & OFFSET_FLAG_CELL) continue;
        const j = chainAt(order, s0, m, cyc, k + 1);
        const ai = (refs[i * 3] as number) * 2;
        const aj = (refs[j * 3] as number) * 2;
        const ax = world[ai] as number;
        const ay = world[ai + 1] as number;
        const bx = world[aj] as number;
        const by = world[aj + 1] as number;
        const oix = out[i * 2] as number;
        const oiy = out[i * 2 + 1] as number;
        const ojx = out[j * 2] as number;
        const ojy = out[j * 2 + 1] as number;
        // a straight cell's strip triangles (a_i a_j o_j), (a_i o_j o_i) have area2 = -d |a_j - a_i|
        const sig = (dist[i] as number) > 0 ? -1 : 1;
        const need = OFFSET_CELL_MIN * Math.hypot(bx - ax, by - ay) * Math.abs(dist[i] as number);
        const ex = bx - ax;
        const ey = by - ay;
        // and the offset edge must keep running forward along its anchor edge (a reversed or stalled one is a fold too)
        const ahead = (ojx - oix) * ex + (ojy - oiy) * ey > OFFSET_CELL_MIN * (ex * ex + ey * ey);
        if (ahead && sig * area2(ax, ay, bx, by, ojx, ojy) > need && sig * area2(ax, ay, ojx, ojy, oix, oiy) > need) continue;
        flags[i] = (flags[i] as number) | OFFSET_FLAG_CELL;
        grew = true;
      }
      if (!grew) break;
      // place each maximal run of clipped cells (entries k0 .. k1) on its clipped corner
      let k = 0;
      if (cyc) {
        let free = -1;
        for (let q = 0; q < cells; q++) if (!((flags[chainAt(order, s0, m, cyc, q)] as number) & OFFSET_FLAG_CELL)) { free = q; break; }
        if (free < 0) break; // every cell folded: keep the miter points
        k = free;
      }
      for (let seen = 0; seen < cells; ) {
        if (!((flags[chainAt(order, s0, m, cyc, k)] as number) & OFFSET_FLAG_CELL)) { k++; seen++; continue; }
        const k0 = k;
        while (seen < cells && (flags[chainAt(order, s0, m, cyc, k)] as number) & OFFSET_FLAG_CELL) { k++; seen++; }
        placeClip(world, refs, dist, out, flags, order, s0, m, cyc, k0, k);
      }
    }
  }
}

function chainAt(order: Int32Array, s0: number, m: number, cyc: boolean, k: number): number {
  return order[s0 + (cyc ? ((k % m) + m) % m : k)] as number;
}

/** Places chain entries k0 .. k1 on the clipped corner of their two bounding offset lines. */
function placeClip(world: ArrayLike<number>, refs: ArrayLike<number>, dist: ArrayLike<number>, out: NumberArray, flags: Uint8Array, order: Int32Array, s0: number, m: number, cyc: boolean, k0: number, k1: number): void {
  const e0 = chainAt(order, s0, m, cyc, k0);
  const e1 = chainAt(order, s0, m, cyc, k1);
  // line 1: the edge entering e0 (prev -> anchor); line 2: the edge leaving e1 (anchor -> next)
  const a0 = (refs[e0 * 3] as number) * 2;
  const p0 = (refs[e0 * 3 + 1] as number) * 2;
  const a1 = (refs[e1 * 3] as number) * 2;
  const n1 = (refs[e1 * 3 + 2] as number) * 2;
  // the bounding edges are shared with the entries just outside the clip (the edge entering e0 leaves
  // the entry before it): offset them by those entries' margins, so the clip corner lies on the
  // neighbours' own offset lines and the outline runs on without a step where margins vary
  const before = cyc || k0 > 0 ? chainAt(order, s0, m, cyc, k0 - 1) : -1;
  const after = cyc || k1 + 1 < m ? chainAt(order, s0, m, cyc, k1 + 1) : -1;
  const d0 = before >= 0 && before !== e1 ? (dist[before] as number) : (dist[e0] as number);
  const d1 = after >= 0 && after !== e0 ? (dist[after] as number) : (dist[e1] as number);
  const A0x = world[a0] as number;
  const A0y = world[a0 + 1] as number;
  const A1x = world[a1] as number;
  const A1y = world[a1 + 1] as number;
  let u1x = A0x - (world[p0] as number);
  let u1y = A0y - (world[p0 + 1] as number);
  let u2x = (world[n1] as number) - A1x;
  let u2y = (world[n1 + 1] as number) - A1y;
  const l1 = Math.hypot(u1x, u1y);
  const l2 = Math.hypot(u2x, u2y);
  let arc = 0;
  for (let k = k0; k < k1; k++) {
    const i = (refs[chainAt(order, s0, m, cyc, k) * 3] as number) * 2;
    const j = (refs[chainAt(order, s0, m, cyc, k + 1) * 3] as number) * 2;
    arc += Math.hypot((world[j] as number) - (world[i] as number), (world[j + 1] as number) - (world[i + 1] as number));
  }
  const mx = (A0x + A1x) / 2;
  const my = (A0y + A1y) / 2;
  let Xx = 0;
  let Xy = 0;
  let corner = false;
  if (l1 > 1e-9 && l2 > 1e-9) {
    u1x /= l1;
    u1y /= l1;
    u2x /= l2;
    u2y /= l2;
    // offset lines q + s u, n(u) = (u.y, -u.x) (right of the walk for d > 0)
    const q1x = A0x + d0 * u1y;
    const q1y = A0y - d0 * u1x;
    const q2x = A1x + d1 * u2y;
    const q2y = A1y - d1 * u2x;
    const den = u1x * u2y - u1y * u2x;
    // concave: the turn from u1 to u2 is toward the offset side (d > 0: a right turn, den < 0)
    if (Math.abs(den) > 0.05 && d0 * den < 0) {
      const s = ((q2x - q1x) * u2y - (q2y - q1y) * u2x) / den;
      Xx = q1x + u1x * s;
      Xy = q1y + u1y * s;
      const r = Math.hypot(Xx - mx, Xy - my);
      const reach = OFFSET_CLIP_REACH * Math.max(Math.abs(d0), Math.abs(d1)) + arc / 2;
      if (r > reach) {
        Xx = mx + ((Xx - mx) * reach) / r;
        Xy = my + ((Xy - my) * reach) / r;
      }
      corner = true;
    }
  }
  if (!corner) {
    // no clip corner (near-parallel or convex bounding lines): the mean of the clip's miter points,
    // spread along the anchors' chord
    let sx = 0;
    let sy = 0;
    for (let k = k0; k <= k1; k++) { const e = chainAt(order, s0, m, cyc, k); sx += out[e * 2] as number; sy += out[e * 2 + 1] as number; }
    Xx = sx / (k1 - k0 + 1);
    Xy = sy / (k1 - k0 + 1);
    const cl = Math.hypot(A1x - A0x, A1y - A0y) || 1;
    u1x = u2x = (A1x - A0x) / cl;
    u1y = u2y = (A1y - A0y) / cl;
  }
  let s = 0;
  for (let k = k0; k <= k1; k++) {
    const e = chainAt(order, s0, m, cyc, k);
    if (k > k0) {
      const i = (refs[chainAt(order, s0, m, cyc, k - 1) * 3] as number) * 2;
      const j = (refs[e * 3] as number) * 2;
      s += Math.hypot((world[j] as number) - (world[i] as number), (world[j + 1] as number) - (world[i + 1] as number));
    }
    const t = (s - arc / 2) * OFFSET_CLIP_SPREAD;
    out[e * 2] = Xx + (t < 0 ? u1x : u2x) * t;
    out[e * 2 + 1] = Xy + (t < 0 ? u1y : u2y) * t;
    flags[e] = (flags[e] as number) | OFFSET_FLAG_CLIPPED;
  }
}
