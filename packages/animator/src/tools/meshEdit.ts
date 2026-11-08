/*
 * Atlas Animator: original implementation.
 *
 * Mesh topology and weight-layout edits (plan MESH-WEIGHTS-PLAN, D1). Pure helpers behind the
 * `mesh.edit` and `weights.table` commands:
 *
 * - `triangulate`: constrained Delaunay triangulation (cdt2d) with hole loops.
 * - `remapDeform`: re-encodes deform offsets after the vertex set or the per-vertex influence
 *   layout changed. A deform offset d_i of influence i lands in the world as w_i * L_i * d_i (L_i the
 *   linear part of the bone's setup world transform), so a vertex moves by the rest-pose world
 *   delta  delta = sum_i w_i L_i d_i.  The new layout stores d_i' = L_i'^-1 delta, which reproduces
 *   delta exactly in the rest pose. Vertices whose influences did not change are copied as they
 *   were, so pose-dependent behaviour is kept where nothing moved.
 * - `planDeformRemap` / `planReferenceRemap`: the document writes (clip, driven and grid deform
 *   keys; contour and embed vertex references) a topology change owes.
 *
 * Nothing here touches the document: plans are lists of `{ path, value }` writes the command applies.
 */
import cdt2d from "cdt2d";
import type { JsonObject, JsonValue } from "./jsonPatch.js";

/** A refusal with a message written for the person editing (the command turns it into a CommandError). */
export class MeshEditError extends Error {}

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const objectAt = (value: JsonValue | undefined): JsonObject => (isObject(value) ? value : {});

// ---------------------------------------------------------------------------------------------
// triangulate
// ---------------------------------------------------------------------------------------------

/**
 * Splits every constraint edge at the vertices that lie on it. cdt2d cannot recover an edge that passes through a vertex, which dropped
 * the outline of the dense mesh arms (interior vertices on the outline) and left no triangles at all.
 */
function splitEdgesAtVertices(pts: readonly (readonly [number, number])[], edges: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of edges) {
    const pa = pts[a] as readonly [number, number];
    const pb = pts[b] as readonly [number, number];
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const len2 = dx * dx + dy * dy;
    const on: { v: number; t: number }[] = [];
    if (len2 > 0) {
      for (let v = 0; v < pts.length; v++) {
        if (v === a || v === b) continue;
        const p = pts[v] as readonly [number, number];
        const t = ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / len2;
        if (t <= 0 || t >= 1) continue;
        if (Math.hypot(pa[0] + t * dx - p[0], pa[1] + t * dy - p[1]) < 1e-3) on.push({ v, t });
      }
    }
    if (!on.length) {
      out.push([a, b]);
      continue;
    }
    on.sort((l, r) => l.t - r.t);
    const chain = [a, ...on.map((o) => o.v), b];
    for (let i = 0; i + 1 < chain.length; i++) out.push([chain[i] as number, chain[i + 1] as number]);
  }
  return out;
}

/**
 * Constrained Delaunay triangulation of `points` (flat x, y pairs). `constraintEdges` are vertex
 * pairs the result must contain; with `outline` loops the exterior is removed. Each entry of
 * `holes` is a closed loop of vertex indices whose inside is also removed. Returns flat triangle
 * indices, every triangle with positive shoelace area (clockwise on a y-down screen).
 */
export function triangulate(
  points: ArrayLike<number>,
  constraintEdges: readonly (readonly [number, number])[] = [],
  holes: readonly (readonly number[])[] = []
): number[] {
  const count = points.length / 2;
  const edges: [number, number][] = constraintEdges.map(([a, b]) => [a, b]);
  for (const loop of holes) {
    if (loop.length < 3) throw new MeshEditError("a hole needs at least 3 vertices");
    for (let i = 0; i < loop.length; i++) edges.push([loop[i] as number, loop[(i + 1) % loop.length] as number]);
  }
  for (const [a, b] of edges) {
    if (!(a >= 0 && a < count && b >= 0 && b < count)) throw new MeshEditError(`an edge uses vertex ${a < 0 || a >= count ? a : b}, but there are only ${count} vertices`);
  }
  const pts: [number, number][] = [];
  for (let v = 0; v < count; v++) pts.push([points[2 * v] as number, points[2 * v + 1] as number]);
  const cells = cdt2d(pts, splitEdgesAtVertices(pts, edges), { exterior: false });
  const out: number[] = [];
  for (const [a, b, c] of cells) {
    const pa = pts[a] as [number, number];
    const pb = pts[b] as [number, number];
    const pc = pts[c] as [number, number];
    const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    if (cross >= 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Deform layout
// ---------------------------------------------------------------------------------------------

/** The linear part of a bone's setup world transform (what a deform offset passes through). */
interface LinearPart {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** What `remapDeform` needs of the setup skeleton (core `Skeleton` satisfies it). */
export interface RestSkeleton {
  getBone(name: string): { world: LinearPart };
}

/** A mesh's vertex data as stored: `vertices` plus the optional `bones` table, in the document's encoding. */
export interface DeformGeom {
  /** Vertex count. */
  count: number;
  /** The `vertices` array (2 per vertex, or the weighted encoding when `bones` is given). */
  vertices: readonly number[];
  /** The mesh's bone table; absent for an unweighted mesh. */
  bones?: readonly string[] | undefined;
  /** The slot's bone (the single influence of an unweighted mesh). */
  slotBone: string;
}

interface Influence {
  bone: string;
  weight: number;
  lin: LinearPart;
}

/** Per vertex, the influences in storage order. */
function layoutOf(geom: DeformGeom, skeleton: RestSkeleton): Influence[][] {
  const out: Influence[][] = [];
  const linear = new Map<string, LinearPart>();
  const lin = (name: string): LinearPart => {
    let found = linear.get(name);
    if (!found) {
      const { a, b, c, d } = skeleton.getBone(name).world;
      found = { a, b, c, d };
      linear.set(name, found);
    }
    return found;
  };
  if (!geom.bones) {
    const slot = lin(geom.slotBone);
    for (let v = 0; v < geom.count; v++) out.push([{ bone: geom.slotBone, weight: 1, lin: slot }]);
    return out;
  }
  let cursor = 0;
  for (let v = 0; v < geom.count; v++) {
    const n = geom.vertices[cursor++] as number;
    const list: Influence[] = [];
    for (let k = 0; k < n; k++, cursor += 4) {
      const name = geom.bones[geom.vertices[cursor] as number] as string;
      list.push({ bone: name, weight: geom.vertices[cursor + 3] as number, lin: lin(name) });
    }
    out.push(list);
  }
  return out;
}

function sameInfluences(a: readonly Influence[], b: readonly Influence[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Influence;
    const y = b[i] as Influence;
    if (x.bone !== y.bone || Math.abs(x.weight - y.weight) > 1e-9) return false;
  }
  return true;
}

export interface DeformValues {
  offset: number;
  vertices: number[];
}

export type DeformRemapper = (values: { offset?: number; vertices: readonly number[] }) => DeformValues;

/**
 * Builds the function that re-encodes one deform key (`offset`, `vertices`) from the old layout to
 * the new one. `origin[n]` is the old index of new vertex n (-1 for a new vertex, which gets no
 * deform). Every vertex keeps its rest-pose world delta; see the file header.
 */
export function remapDeform(oldGeom: DeformGeom, newGeom: DeformGeom, origin: readonly number[], skeleton: RestSkeleton): DeformRemapper {
  if (origin.length !== newGeom.count) throw new MeshEditError(`origin needs one entry per new vertex (${newGeom.count}), got ${origin.length}`);
  const oldLayout = layoutOf(oldGeom, skeleton);
  const newLayout = layoutOf(newGeom, skeleton);
  const oldStart: number[] = [];
  let oldTotal = 0;
  for (const list of oldLayout) {
    oldStart.push(oldTotal);
    oldTotal += list.length;
  }
  const newStart: number[] = [];
  let newTotal = 0;
  for (const list of newLayout) {
    newStart.push(newTotal);
    newTotal += list.length;
  }
  return (values) => {
    const dense = new Float64Array(oldTotal * 2);
    const offset = values.offset ?? 0;
    for (let i = 0; i < values.vertices.length; i++) if (offset + i < dense.length) dense[offset + i] = values.vertices[i] as number;
    const next = new Float64Array(newTotal * 2);
    for (let n = 0; n < origin.length; n++) {
      const o = origin[n] as number;
      if (o < 0 || o >= oldLayout.length) continue;
      const before = oldLayout[o] as Influence[];
      const after = newLayout[n] as Influence[];
      const from = oldStart[o] as number;
      const to = newStart[n] as number;
      if (sameInfluences(before, after)) {
        for (let k = 0; k < before.length; k++) {
          next[(to + k) * 2] = dense[(from + k) * 2] as number;
          next[(to + k) * 2 + 1] = dense[(from + k) * 2 + 1] as number;
        }
        continue;
      }
      let dx = 0;
      let dy = 0;
      for (let k = 0; k < before.length; k++) {
        const inf = before[k] as Influence;
        const x = dense[(from + k) * 2] as number;
        const y = dense[(from + k) * 2 + 1] as number;
        dx += inf.weight * (inf.lin.a * x + inf.lin.b * y);
        dy += inf.weight * (inf.lin.c * x + inf.lin.d * y);
      }
      for (let k = 0; k < after.length; k++) {
        const { a, b, c, d } = (after[k] as Influence).lin;
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-12) continue;
        next[(to + k) * 2] = (d * dx - b * dy) / det;
        next[(to + k) * 2 + 1] = (a * dy - c * dx) / det;
      }
    }
    let first = -1;
    let last = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== 0) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return { offset: 0, vertices: [] };
    const vertices: number[] = [];
    for (let i = first; i <= last; i++) vertices.push(Math.round((next[i] as number) * 1e6) / 1e6 + 0);
    return { offset: first, vertices };
  };
}

// ---------------------------------------------------------------------------------------------
// Document plans
// ---------------------------------------------------------------------------------------------

export interface MeshAddressLike {
  skin: string;
  slot: string;
  name: string;
}

export interface PlannedWrite {
  path: (string | number)[];
  value: JsonValue;
}

/** The mesh and every linked mesh that names it as source (their own deform keys share its layout). */
function deformAddresses(doc: JsonObject, address: MeshAddressLike): MeshAddressLike[] {
  const out: MeshAddressLike[] = [address];
  for (const [skin, skinValue] of Object.entries(objectAt(doc["skins"]))) {
    for (const [slot, list] of Object.entries(objectAt(objectAt(skinValue)["attachments"]))) {
      for (const [name, attachment] of Object.entries(objectAt(list))) {
        const a = objectAt(attachment);
        if (a["type"] !== "linkedMesh") continue;
        const source = objectAt(a["source"]);
        if (source["skin"] === address.skin && source["slot"] === address.slot && source["attachment"] === address.name) out.push({ skin, slot, name });
      }
    }
  }
  return out;
}

/**
 * Writes that re-encode every deform key of the mesh: clip deform timelines, driven (corrective)
 * keys and grid correctives. Nothing is planned for a timeline that does not exist.
 */
export function planDeformRemap(doc: JsonObject, address: MeshAddressLike, remap: DeformRemapper): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  const convert = (values: JsonValue | undefined): JsonObject => {
    const v = objectAt(values);
    const mapped = remap({ offset: typeof v["offset"] === "number" ? v["offset"] : 0, vertices: Array.isArray(v["vertices"]) ? (v["vertices"] as number[]) : [] });
    return { ...v, offset: mapped.offset, vertices: mapped.vertices };
  };
  for (const target of deformAddresses(doc, address)) {
    const at = (container: JsonValue | undefined): JsonValue | undefined => objectAt(objectAt(objectAt(container)[target.skin])[target.slot])[target.name];
    for (const [clip, clipValue] of Object.entries(objectAt(doc["animations"]))) {
      const keys = at(objectAt(clipValue)["deform"]);
      if (!Array.isArray(keys)) continue;
      writes.push({ path: ["animations", clip, "deform", target.skin, target.slot, target.name], value: keys.map((key) => convert(key)) });
    }
    const driven = doc["driven"];
    if (Array.isArray(driven)) {
      driven.forEach((set, i) => {
        const keys = objectAt(set)["keys"];
        if (!Array.isArray(keys)) return;
        keys.forEach((key, j) => {
          const values = at(objectAt(key)["deform"]);
          if (values !== undefined) writes.push({ path: ["driven", i, "keys", j, "deform", target.skin, target.slot, target.name], value: convert(values) });
        });
      });
    }
    const grids = doc["drivenGrids"];
    if (Array.isArray(grids)) {
      grids.forEach((grid, i) => {
        const keys = objectAt(grid)["keys"];
        if (!Array.isArray(keys)) return;
        keys.forEach((key, j) => {
          const values = at(objectAt(key)["deform"]);
          if (values !== undefined) writes.push({ path: ["drivenGrids", i, "keys", j, "deform", target.skin, target.slot, target.name], value: convert(values) });
        });
      });
    }
  }
  return writes;
}

/** old vertex -> first new vertex that came from it (undefined when the vertex is deleted). */
export function oldToNewMap(origin: readonly number[]): Map<number, number> {
  const map = new Map<number, number>();
  origin.forEach((old, n) => {
    if (old >= 0 && !map.has(old)) map.set(old, n);
  });
  return map;
}

/**
 * Writes that remap vertex references to the mesh: contour points bound to it and embed points of
 * other meshes of its skin. A reference to a deleted vertex is refused (edit the contour or the
 * embedding first).
 */
export function planReferenceRemap(doc: JsonObject, address: MeshAddressLike, origin: readonly number[]): PlannedWrite[] {
  const map = oldToNewMap(origin);
  const writes: PlannedWrite[] = [];
  const point = (value: JsonValue, where: string): JsonValue => {
    const index = (old: number): number => {
      const next = map.get(old);
      if (next === undefined) throw new MeshEditError(`${where} uses vertex ${old}, which this edit deletes; move or remove that reference first`);
      return next;
    };
    if (typeof value === "number") return index(value);
    if (Array.isArray(value)) return [index(value[0] as number), index(value[1] as number), index(value[2] as number), ...value.slice(3)];
    return value;
  };
  for (const [skin, skinValue] of Object.entries(objectAt(doc["skins"]))) {
    const skinObject = objectAt(skinValue);
    for (const [owner, group] of Object.entries(objectAt(skinObject["contours"]))) {
      for (const [name, contourValue] of Object.entries(objectAt(group))) {
        const contour = objectAt(contourValue);
        const ref = objectAt(contour["mesh"]);
        if (ref["slot"] !== address.slot || ref["attachment"] !== address.name || (typeof ref["skin"] === "string" ? ref["skin"] : skin) !== address.skin) continue;
        if (!Array.isArray(contour["points"])) continue;
        const where = `contour '${name}' on slot '${owner}'`;
        writes.push({ path: ["skins", skin, "contours", owner, name, "points"], value: contour["points"].map((p) => point(p, where)) });
      }
    }
    if (skin !== address.skin) continue;
    for (const [slot, list] of Object.entries(objectAt(skinObject["attachments"]))) {
      for (const [name, attachment] of Object.entries(objectAt(list))) {
        const a = objectAt(attachment);
        const embed = objectAt(a["embed"]);
        if (a["type"] !== "mesh" || embed["slot"] !== address.slot || embed["attachment"] !== address.name || !Array.isArray(embed["points"])) continue;
        const where = `the embedding of ${skin}/${slot}/${name}`;
        writes.push({ path: ["skins", skin, "attachments", slot, name, "embed", "points"], value: embed["points"].map((p) => point(p, where)) });
      }
    }
  }
  return writes;
}

/** Plain refusals for the cases v1 does not handle: coverage regions, draw groups, and an own embedding. */
export function checkMeshEditable(doc: JsonObject, address: MeshAddressLike, mesh: JsonObject): void {
  const where = `${address.skin}/${address.slot}/${address.name}`;
  const groups = objectAt(mesh["groups"]);
  if (Object.keys(groups).length > 0) {
    throw new MeshEditError(`${where} has draw groups (${Object.keys(groups).join(", ")}) that point at its triangle numbers; remove the groups (mesh.groups with null) before editing its triangles, then set them again`);
  }
  if (mesh["embed"] !== undefined) {
    throw new MeshEditError(`${where} is embedded on another mesh, so its vertices are placed by that mesh; edit the mesh it lies on instead`);
  }
  for (const [skin, skinValue] of Object.entries(objectAt(doc["skins"]))) {
    const regions = objectAt(objectAt(objectAt(skinValue)["coverage"])["regions"]);
    for (const [region, value] of Object.entries(regions)) {
      const ref = objectAt(objectAt(value)["mesh"]);
      if (skin === address.skin && ref["slot"] === address.slot && ref["attachment"] === address.name) {
        throw new MeshEditError(`${where} carries the coverage region '${region}' of skin '${skin}' (triangle ranges that this edit would shift); remove the region before editing the mesh, then declare it again`);
      }
    }
  }
}
