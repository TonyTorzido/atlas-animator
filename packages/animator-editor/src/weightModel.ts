/*
 * Atlas Animator editor: original implementation.
 *
 * Weight model (pure, MESH-WEIGHTS-PLAN D2 and section 2). The weights tool edits a dense V x B table (`Float32Array`, vertex-major, one
 * column per candidate bone) while a stroke is live, and writes it once at pointer-up as a `weights.table` command.
 *
 *  - Brush: add / subtract / smooth / set with radius, strength, pressure, smooth or hard falloff and dab spacing. Locked bones are never
 *    touched; after every dab the leftover weight is split among the unlocked bones in proportion to their current weights, so a row
 *    keeps summing to 1.
 *  - Cleanup: normalise, prune below a minimum and cap at 1..4 influences through the engine's `pruneByName`, reporting the dropped weight.
 *  - Auto-weights: heat (the engine's `autoWeights`), `distanceWeights`, and the sleeve profile (a port of `blend3` / `sleeve_infl` in
 *    swag_rig.py: upper arm -> elbow half-bone -> forearm smoothstep zones, the clavicle cap and the inner-elbow V).
 *  - Mirror near <-> far in chain space (nearest bone, t along it, side offset over limb radius), falling back to an x-mirror.
 *  - `toTableCommand` builds the `weights.table` command.
 */
import {
  autoWeights,
  pruneByName,
  PruneStats,
  weightsAtPoint,
  type AutoWeightOptions,
  type Influence,
  type MeshForWeights,
  type WeightBone,
  type WeightChain,
  type WeightDiagnostics
} from "@atlas-animator/core/tools/autoWeights";
import { segmentDistance } from "@atlas-animator/core/tools/outline";

// --- The table --------------------------------------------------------------------------------------

export interface WeightTable {
  readonly vertexCount: number;
  /** The columns: bone names, in table order. */
  readonly bones: readonly string[];
  /** vertexCount x bones.length, row-major. */
  readonly data: Float32Array;
}

export function createTable(bones: readonly string[], vertexCount: number): WeightTable {
  return { vertexCount, bones: [...bones], data: new Float32Array(vertexCount * bones.length) };
}

export function cloneTable(table: WeightTable): WeightTable {
  return { vertexCount: table.vertexCount, bones: [...table.bones], data: new Float32Array(table.data) };
}

/** A table from per-vertex influences (`bone` indexes `bones`). */
export function tableFromInfluences(bones: readonly string[], weights: readonly (readonly Influence[])[]): WeightTable {
  const table = createTable(bones, weights.length);
  const B = bones.length;
  weights.forEach((list, v) => {
    for (const inf of list) table.data[v * B + inf.bone] = (table.data[v * B + inf.bone] as number) + inf.weight;
  });
  return table;
}

/** The influences of one vertex, largest first (weights above zero only). */
export function rowInfluences(table: WeightTable, v: number): Influence[] {
  const B = table.bones.length;
  const out: Influence[] = [];
  for (let b = 0; b < B; b++) {
    const weight = table.data[v * B + b] as number;
    if (weight > 0) out.push({ bone: b, weight });
  }
  return out.sort((x, y) => y.weight - x.weight || x.bone - y.bone);
}

export const tableInfluences = (table: WeightTable): Influence[][] => Array.from({ length: table.vertexCount }, (_, v) => rowInfluences(table, v));

export const rowSum = (table: WeightTable, v: number): number => {
  const B = table.bones.length;
  let s = 0;
  for (let b = 0; b < B; b++) s += table.data[v * B + b] as number;
  return s;
};

/** Anything that says whether bone column `b` is locked. */
export type LockSet = ReadonlySet<number> | readonly boolean[] | null | undefined;
const isLocked = (locked: LockSet, b: number): boolean => (!locked ? false : "has" in locked ? locked.has(b) : !!locked[b]);

/**
 * Scales the unlocked bones of one row so the row sums to 1 (locked weights stay). An unlocked row with no weight at all is left alone
 * unless `fallback` names a column to receive the free mass.
 */
export function normalizeRow(table: WeightTable, v: number, locked?: LockSet, fallback = -1): void {
  const B = table.bones.length;
  const d = table.data;
  let lockedSum = 0;
  let freeSum = 0;
  for (let b = 0; b < B; b++) {
    const w = d[v * B + b] as number;
    if (isLocked(locked, b)) lockedSum += w;
    else freeSum += w;
  }
  const mass = Math.max(0, 1 - lockedSum);
  if (freeSum > 1e-12) {
    const k = mass / freeSum;
    for (let b = 0; b < B; b++) if (!isLocked(locked, b)) d[v * B + b] = (d[v * B + b] as number) * k;
  } else if (fallback >= 0 && !isLocked(locked, fallback)) {
    d[v * B + fallback] = mass;
  }
}

export function normalizeTable(table: WeightTable, locked?: LockSet): void {
  for (let v = 0; v < table.vertexCount; v++) normalizeRow(table, v, locked, 0);
}

/**
 * Sets bone `bone` of vertex `v` to `value` (clamped so the locked bones keep their share) and splits the leftover among the other
 * unlocked bones in proportion to their current weights. When no other unlocked bone carries weight the vertex is left as it was
 * (nothing can absorb the change), unless the new value fills the whole free mass. Returns whether the row changed.
 */
export function setRowWeight(table: WeightTable, v: number, bone: number, value: number, locked?: LockSet): boolean {
  if (isLocked(locked, bone)) return false;
  const B = table.bones.length;
  const d = table.data;
  let lockedSum = 0;
  let others = 0;
  for (let b = 0; b < B; b++) {
    if (b === bone) continue;
    const w = d[v * B + b] as number;
    if (isLocked(locked, b)) lockedSum += w;
    else others += w;
  }
  const mass = Math.max(0, 1 - lockedSum);
  const target = Math.min(mass, Math.max(0, value));
  const rest = mass - target;
  if (others <= 1e-12 && rest > 1e-9) return false;
  const before = d[v * B + bone] as number;
  d[v * B + bone] = target;
  if (others > 1e-12) {
    const k = rest / others;
    for (let b = 0; b < B; b++) if (b !== bone && !isLocked(locked, b)) d[v * B + b] = (d[v * B + b] as number) * k;
  }
  return Math.abs(before - target) > 1e-9;
}

// --- The brush --------------------------------------------------------------------------------------

export type BrushMode = "add" | "subtract" | "smooth" | "set";
export type BrushFalloff = "smooth" | "hard";

export interface BrushOptions {
  mode: BrushMode;
  /** Radius in the same units as the vertex points. */
  radius: number;
  /** 0..1, scaled by the pressure of each dab. */
  strength: number;
  falloff: BrushFalloff;
  /** Dab spacing as a fraction of the radius (default 1/4). */
  spacing?: number;
  /** "set" mode: the value painted (default 1). */
  value?: number;
}

export const DEFAULT_SPACING = 0.25;

/** Brush weight at `distance` from the centre: 0 outside, a smoothstep ("smooth") or a flat disc ("hard") inside. */
export function falloffAt(distance: number, radius: number, kind: BrushFalloff): number {
  if (!(radius > 0) || distance >= radius) return 0;
  if (kind === "hard") return 1;
  const t = 1 - distance / radius;
  return t * t * (3 - 2 * t);
}

export interface BrushTarget {
  /** x, y per vertex in the space the brush moves in. */
  points: ArrayLike<number>;
  /** Neighbour sets per vertex (`adjacency()` from the engine) for smoothing. */
  neighbours?: readonly ReadonlySet<number>[];
}

/**
 * One dab of the brush at (cx, cy) on the active bone column. Returns the vertices that changed. Every touched row still sums to 1 and
 * locked columns keep their values.
 */
export function brushDab(table: WeightTable, target: BrushTarget, active: number, cx: number, cy: number, options: BrushOptions, pressure = 1, locked?: LockSet): number[] {
  const changed: number[] = [];
  if (active < 0 || active >= table.bones.length || isLocked(locked, active)) return changed;
  const B = table.bones.length;
  const d = table.data;
  const pts = target.points;
  const strength = Math.min(1, Math.max(0, options.strength * pressure));
  const r = options.radius;
  for (let v = 0; v < table.vertexCount; v++) {
    const dx = (pts[v * 2] as number) - cx;
    if (dx > r || dx < -r) continue;
    const dy = (pts[v * 2 + 1] as number) - cy;
    const f = falloffAt(Math.hypot(dx, dy), r, options.falloff) * strength;
    if (f <= 0) continue;
    const cur = d[v * B + active] as number;
    let did = false;
    if (options.mode === "add") did = setRowWeight(table, v, active, cur + f, locked);
    else if (options.mode === "subtract") did = setRowWeight(table, v, active, cur - f, locked);
    else if (options.mode === "set") did = setRowWeight(table, v, active, cur + ((options.value ?? 1) - cur) * f, locked);
    else {
      const nb = target.neighbours?.[v];
      if (!nb || nb.size === 0) continue;
      const avg = new Float64Array(B);
      for (const n of nb) for (let b = 0; b < B; b++) avg[b] = (avg[b] as number) + (d[n * B + b] as number);
      let moved = false;
      for (let b = 0; b < B; b++) {
        if (isLocked(locked, b)) continue;
        const w = d[v * B + b] as number;
        const next = w + ((avg[b] as number) / nb.size - w) * f;
        if (Math.abs(next - w) > 1e-9) moved = true;
        d[v * B + b] = next;
      }
      if (moved) normalizeRow(table, v, locked, active);
      did = moved;
    }
    if (did) changed.push(v);
  }
  return changed;
}

/** Carries the distance left to the next dab across pointer moves, so dabs land evenly spaced along the path. */
export class StrokeSpacer {
  private carry = 0;
  private last: { x: number; y: number } | null = null;
  constructor(private readonly step: () => number) {}

  /** The dab positions between the last pointer position and (x, y); the first call returns the start point. */
  advance(x: number, y: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    if (!this.last) {
      this.last = { x, y };
      return [{ x, y }];
    }
    const step = Math.max(1e-6, this.step());
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const len = Math.hypot(dx, dy);
    let at = step - this.carry;
    while (at <= len + 1e-9) {
      out.push({ x: this.last.x + (dx * at) / len, y: this.last.y + (dy * at) / len });
      at += step;
    }
    this.carry = len - (at - step);
    this.last = { x, y };
    return out;
  }
}

/** The dab spacing of a brush in point units. */
export const dabStep = (o: Pick<BrushOptions, "radius" | "spacing">): number => o.radius * (o.spacing ?? DEFAULT_SPACING);

/** Sets bone `bone` to `value` on every listed vertex (the table's "set a value on the whole selection"). */
export function setSelection(table: WeightTable, vertices: Iterable<number>, bone: number, value: number, locked?: LockSet): number[] {
  const changed: number[] = [];
  for (const v of vertices) if (setRowWeight(table, v, bone, value, locked)) changed.push(v);
  return changed;
}

// --- Cleanup ----------------------------------------------------------------------------------------

export interface CleanupOptions {
  /** 1..4 (default 4). */
  max?: number;
  /** Weights below this share of a vertex are dropped (default 0.02). */
  min?: number;
  /** Bone geometry and vertex points (in the same order as the table's columns) turn on the pose-error report. */
  poseBones?: readonly WeightBone[];
  points?: ArrayLike<number>;
  /** The posed error beyond which a vertex is listed (px, default 1). */
  limitPx?: number;
}

export interface CleanupResult {
  table: WeightTable;
  dropped: { total: number; max: number; vertices: number };
  pruning?: WeightDiagnostics["pruning"];
}

/** Normalises, prunes below `min` and caps at `max` influences with the engine's name-stable `pruneByName`. */
export function cleanup(table: WeightTable, options: CleanupOptions = {}): CleanupResult {
  const max = Math.min(4, Math.max(1, Math.round(options.max ?? 4)));
  const min = options.min ?? 0.02;
  const names = table.bones.map((name) => ({ name }));
  const stats = options.poseBones && options.points ? new PruneStats(options.poseBones, options.points, options.limitPx ?? 1) : undefined;
  const dense = tableInfluences(table);
  const kept = pruneByName(dense, names, max, min, stats);
  const out = tableFromInfluences(table.bones, kept);
  let total = 0;
  let worst = 0;
  let vertices = 0;
  for (let v = 0; v < table.vertexCount; v++) {
    const sum = dense[v]!.reduce((s, i) => s + i.weight, 0);
    const keptSet = new Set(kept[v]!.map((i) => i.bone));
    let lost = 0;
    for (const inf of dense[v]!) if (!keptSet.has(inf.bone)) lost += inf.weight / sum;
    total += lost;
    worst = Math.max(worst, lost);
    if (lost > 1e-9) vertices++;
  }
  const result: CleanupResult = { table: out, dropped: { total, max: worst, vertices } };
  if (stats) result.pruning = stats.summary();
  return result;
}

// --- Auto-weights -----------------------------------------------------------------------------------

/** Heat weights (the engine's `autoWeights`) as a table whose columns are the part's bones (anchor first, then the chain). */
export function heatWeights(mesh: MeshForWeights, chain: WeightChain, options: AutoWeightOptions = {}): WeightTable {
  const result = autoWeights(mesh, chain, options);
  return tableFromInfluences(result.bones.map((b) => b.name), result.weights);
}

export interface DistanceOptions {
  /** Falloff exponent: weight ~ 1 / (distance / radius + eps)^power (default 2; larger follows the nearest bone more sharply). */
  power?: number;
  /** Bones farther than this many radii from a vertex get no weight (default: no limit). */
  reach?: number;
  max?: number;
  min?: number;
}

/** Inverse-distance weights: each vertex follows the bones it is near, by distance to the bone segment over the bone's radius. */
export function distanceWeights(points: ArrayLike<number>, bones: readonly WeightBone[], options: DistanceOptions = {}): WeightTable {
  const power = options.power ?? 2;
  const V = points.length / 2;
  const B = bones.length;
  const table = createTable(bones.map((b) => b.name), V);
  const raw = new Float64Array(B);
  for (let v = 0; v < V; v++) {
    const x = points[v * 2] as number;
    const y = points[v * 2 + 1] as number;
    let sum = 0;
    let nearest = 0;
    let nearestD = Infinity;
    for (let b = 0; b < B; b++) {
      const bone = bones[b] as WeightBone;
      const rel = segmentDistance(x, y, bone.start, bone.end) / Math.max(1e-6, bone.radius);
      if (rel < nearestD) {
        nearestD = rel;
        nearest = b;
      }
      raw[b] = options.reach !== undefined && rel > options.reach ? 0 : 1 / Math.pow(rel + 1e-3, power);
      sum += raw[b] as number;
    }
    if (!(sum > 0)) {
      table.data[v * B + nearest] = 1;
      continue;
    }
    for (let b = 0; b < B; b++) table.data[v * B + b] = (raw[b] as number) / sum;
  }
  return cleanup(table, { max: options.max ?? 4, min: options.min ?? 0.02 }).table;
}

// --- Sleeve profile (port of blend3 / sleeve_infl in swag_rig.py) -------------------------------------

export interface SleeveParams {
  /** Elbow half-zone as a fraction of the sleeve width at the pivot (SWAG_ELBOW_K, 0.25). */
  ELBOW_K: number;
  /** Largest clavicle share at the top of the cap (0.9). */
  CLAV_MAX: number;
  /** The clavicle cap ends this fraction of the upper arm below the shoulder (0.35). */
  CLAV_T0: number;
  /** How much of the inner side turns into three near-rigid parts (1 = fully, 0 = off). */
  INNER_SHARP: number;
  /** Half-width in px of the transitions on the sharp inner side (4). */
  INNER_EDGE: number;
  /** Pushes the inner side's stations (0, off). */
  INNER_SHIFT: number;
}

export const SLEEVE_DEFAULTS: Readonly<SleeveParams> = { ELBOW_K: 0.25, CLAV_MAX: 0.9, CLAV_T0: 0.35, INNER_SHARP: 1, INNER_EDGE: 4, INNER_SHIFT: 0 };

/** The arm the profile reads: shoulder, elbow, wrist (canvas), the shoulder radius and the x of the body centre line. */
export interface SleeveArm {
  S: readonly [number, number];
  E: readonly [number, number];
  W: readonly [number, number];
  shoulderRadius: number;
  /** The inner (bend) side is the one facing this x (542 on the front view). */
  centerX: number;
}

export interface SleeveBones {
  upperArm: string;
  elbow: string;
  forearm: string;
  clavicle: string;
}

export const sleeveBones = (side: string): SleeveBones => ({ upperArm: `upper_arm_${side}`, elbow: `elbow_${side}`, forearm: `forearm_${side}`, clavicle: `clavicle_${side}` });

const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** The elbow half-zone in px from the sleeve width measured at the pivot. */
export const elbowZone = (width0: number, params: Pick<SleeveParams, "ELBOW_K"> = SLEEVE_DEFAULTS): number => params.ELBOW_K * width0;

/**
 * Upper arm -> elbow half-bone -> forearm along the arm: the elbow alone over |d| <= zc - h, smoothstep transitions of half-width h about
 * d = -zc and d = +zc. Returns [upperArm, elbow, forearm] weights.
 */
export function blend3(d: number, zc: number, h: number): [number, number, number] {
  if (d <= -zc - h) return [1, 0, 0];
  if (d < -zc + h) {
    const k = smoothstep((d + zc + h) / (2 * h));
    return [1 - k, k, 0];
  }
  if (d <= zc - h) return [0, 1, 0];
  if (d < zc + h) {
    const k = smoothstep((d - zc + h) / (2 * h));
    return [0, 1 - k, k];
  }
  return [0, 0, 1];
}

/**
 * The sleeve weights of one point `p` (canvas) at station `d` (px from the elbow pivot along the sleeve's centre line, negative up the
 * upper arm) with elbow half-zone `z`. Returns the normalised influences, largest first, by bone name.
 */
export function sleeveInfluence(arm: SleeveArm, p: readonly [number, number], d: number, z: number, side: string, params: SleeveParams = SLEEVE_DEFAULTS): [string, number][] {
  const names = sleeveBones(side);
  const [S, E, W] = [arm.S, arm.E, arm.W];
  const Lu = Math.hypot(E[0] - S[0], E[1] - S[1]);
  const tU = ((p[0] - S[0]) * (E[0] - S[0]) + (p[1] - S[1]) * (E[1] - S[1])) / Lu / Lu;
  const tUpx = tU * Lu;
  const ax = d >= 0 ? [W[0] - E[0], W[1] - E[1]] : [E[0] - S[0], E[1] - S[1]];
  const al = Math.hypot(ax[0]!, ax[1]!);
  let nx = -ax[1]! / al;
  let ny = ax[0]! / al;
  if (nx * (arm.centerX - E[0]) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const vin = ((p[0] - E[0]) * nx + (p[1] - E[1]) * ny) / Math.max((z / params.ELBOW_K) * 0.5, 1);
  const dd = d - params.INNER_SHIFT * z * smoothstep(vin);
  const m = params.INNER_SHARP * smoothstep((vin - 0.2) / 0.8);
  let up = 0;
  let el = 0;
  let fo = 0;
  for (const [wt, zz, hh] of [[1 - m, 0.5 * z, 0.5 * z], [m, z, params.INNER_EDGE]] as const) {
    if (wt <= 0) continue;
    const [a, b, c] = blend3(dd, zz, hh);
    up += wt * a;
    el += wt * b;
    fo += wt * c;
  }
  const t0 = params.CLAV_T0 * Lu;
  const wc = params.CLAV_MAX * smoothstep((t0 - tUpx) / (t0 + 0.8 * arm.shoulderRadius));
  let cl = 0;
  if (wc > 0.001) {
    up *= 1 - wc;
    el *= 1 - wc;
    fo *= 1 - wc;
    cl = wc;
  }
  const list: [string, number][] = [[names.upperArm, up], [names.elbow, el], [names.forearm, fo], [names.clavicle, cl]];
  const kept = list.filter(([, w]) => w > 0.0005);
  const total = kept.reduce((s, [, w]) => s + w, 0);
  return kept.map(([n, w]): [string, number] => [n, w / total]).sort((a, b) => b[1] - a[1]);
}

export interface SleeveSample {
  /** Canvas position of the vertex. */
  p: readonly [number, number];
  /** Station along the sleeve centre line. */
  d: number;
}

/** The sleeve profile over a set of vertices as a table with the four sleeve bones as columns. */
export function sleeveWeights(arm: SleeveArm, samples: readonly SleeveSample[], z: number, side: string, params: SleeveParams = SLEEVE_DEFAULTS): WeightTable {
  const n = sleeveBones(side);
  const table = createTable([n.upperArm, n.elbow, n.forearm, n.clavicle], samples.length);
  samples.forEach((s, v) => {
    for (const [name, w] of sleeveInfluence(arm, s.p, s.d, z, side, params)) table.data[v * 4 + table.bones.indexOf(name)] = w;
  });
  return table;
}

// --- Mirror near <-> far ------------------------------------------------------------------------------

export interface MirrorSource {
  /** The source mesh. */
  mesh: MeshForWeights;
  table: WeightTable;
}

export interface MirrorContext {
  /** Bone geometry of the whole rig (rest pose, same space as the mesh points). */
  bones: readonly WeightBone[];
  /** Partner bone name per bone (`makeMirrorRig(...).partner` in mirrorModel.ts). A bone without a partner mirrors onto itself. */
  partner: ReadonlyMap<string, string>;
  /** World x of the symmetry axis (`MirrorRig.axisX`). */
  axisX: number;
  /** A vertex farther than this many radii from every bone mirrors by x instead (default 2.5). */
  reachRadii?: number;
}

/** The dense weight row of a mesh at a point: barycentric inside a triangle, else the nearest vertex. */
export function sampleRow(mesh: MeshForWeights, table: WeightTable, x: number, y: number, out: Float64Array): void {
  const B = table.bones.length;
  const p = mesh.points;
  const tri = mesh.triangles;
  out.fill(0);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t] as number;
    const b = tri[t + 1] as number;
    const c = tri[t + 2] as number;
    const ax = p[a * 2] as number;
    const ay = p[a * 2 + 1] as number;
    const bx = p[b * 2] as number;
    const by = p[b * 2 + 1] as number;
    const cx = p[c * 2] as number;
    const cy = p[c * 2 + 1] as number;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const wa = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
    const wb = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    for (let k = 0; k < B; k++) out[k] = wa * (table.data[a * B + k] as number) + wb * (table.data[b * B + k] as number) + wc * (table.data[c * B + k] as number);
    return;
  }
  let nearest = 0;
  let best = Infinity;
  for (let v = 0; v < table.vertexCount; v++) {
    const dd = Math.hypot((p[v * 2] as number) - x, (p[v * 2 + 1] as number) - y);
    if (dd < best) {
      best = dd;
      nearest = v;
    }
  }
  for (let k = 0; k < B; k++) out[k] = table.data[nearest * B + k] as number;
}

/**
 * Mirrors the weights of `source` onto a mesh with vertices `targetPoints` (the other side's mesh, or the same mesh for a symmetric
 * one). Each target vertex finds its nearest bone, the distance t along it and its side offset over the bone's radius; the source point
 * is the partner bone's point at the same t and (mirrored) offset, and the weights there are sampled and carried over to the partner
 * bones. A vertex with no bone within reach, or whose bone has no partner on the other side of the axis, falls back to an x-mirror about
 * `axisX` and `weightsAtPoint`. Returns a table whose columns are the partner bone names.
 */
export function mirrorWeights(source: MirrorSource, targetPoints: ArrayLike<number>, ctx: MirrorContext): WeightTable {
  const { bones, partner } = ctx;
  const reach = ctx.reachRadii ?? 2.5;
  const byName = new Map(bones.map((b) => [b.name, b]));
  const sB = source.table.bones.length;
  const columnOf = new Map<string, number>();
  const columns: string[] = [];
  const column = (name: string) => {
    let k = columnOf.get(name);
    if (k === undefined) {
      k = columns.length;
      columnOf.set(name, k);
      columns.push(name);
    }
    return k;
  };
  const mapTo = source.table.bones.map((name) => column(partner.get(name) ?? name));
  const V = targetPoints.length / 2;
  const inf: Influence[][] = [];
  const dense = new Float64Array(sB);
  const sourceInfluences = tableInfluences(source.table);
  for (let v = 0; v < V; v++) {
    const x = targetPoints[v * 2] as number;
    const y = targetPoints[v * 2 + 1] as number;
    // Nearest bone by distance over radius.
    let best: WeightBone | null = null;
    let bestRel = Infinity;
    let bestT = 0;
    for (const bone of bones) {
      const dx = bone.end.x - bone.start.x;
      const dy = bone.end.y - bone.start.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - bone.start.x) * dx + (y - bone.start.y) * dy) / l2)) : 0;
      const rel = Math.hypot(x - (bone.start.x + t * dx), y - (bone.start.y + t * dy)) / Math.max(1e-6, bone.radius);
      if (rel < bestRel) {
        bestRel = rel;
        best = bone;
        bestT = t;
      }
    }
    const mate = best ? byName.get(partner.get(best.name) ?? best.name) : undefined;
    const onAxis = best && !partner.has(best.name);
    let list: Influence[] | null = null;
    if (best && mate && bestRel <= reach && (partner.has(best.name) || onAxis)) {
      const dx = best.end.x - best.start.x;
      const dy = best.end.y - best.start.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const offset = ((x - (best.start.x + bestT * dx)) * nx + (y - (best.start.y + bestT * dy)) * ny) / Math.max(1e-6, best.radius);
      const mx = mate.end.x - mate.start.x;
      const my = mate.end.y - mate.start.y;
      const mlen = Math.hypot(mx, my) || 1;
      // Reflection flips handedness, so the same outward side is the opposite sign of the left normal.
      const sign = -1;
      const sx = mate.start.x + bestT * mx + (-my / mlen) * sign * offset * mate.radius;
      const sy = mate.start.y + bestT * my + (mx / mlen) * sign * offset * mate.radius;
      sampleRow(source.mesh, source.table, sx, sy, dense);
      list = [];
      for (let k = 0; k < sB; k++) if ((dense[k] as number) > 0) list.push({ bone: k, weight: dense[k] as number });
    } else {
      list = weightsAtPoint(source.mesh, sourceInfluences, 2 * ctx.axisX - x, y);
    }
    inf.push(list);
  }
  const out = createTable(columns, V);
  const C = columns.length;
  inf.forEach((list, v) => {
    for (const i of list) out.data[v * C + (mapTo[i.bone] as number)] = (out.data[v * C + (mapTo[i.bone] as number)] as number) + i.weight;
    normalizeRow(out, v, null, 0);
  });
  return out;
}

// --- The command --------------------------------------------------------------------------------------

export interface WeightsTableCommand {
  op: "weights.table";
  skin: string;
  slot: string;
  name: string;
  influences: string[];
  weights: number[];
  max?: number;
  min?: number;
}

export interface MeshAddress {
  skin: string;
  slot: string;
  name: string;
}

/**
 * The `weights.table` command for a table. Columns with no weight anywhere are left out, values are rounded to 1e-5 (the engine
 * normalises and prunes), and `max` / `min` pass through.
 */
export function toTableCommand(table: WeightTable, address: MeshAddress, options: { max?: number; min?: number } = {}): WeightsTableCommand {
  const B = table.bones.length;
  const used: number[] = [];
  for (let b = 0; b < B; b++) {
    for (let v = 0; v < table.vertexCount; v++) {
      if ((table.data[v * B + b] as number) > 1e-6) {
        used.push(b);
        break;
      }
    }
  }
  if (used.length === 0) throw new Error("the weight table has no weight at all");
  const weights: number[] = [];
  for (let v = 0; v < table.vertexCount; v++) {
    for (const b of used) {
      const w = Math.round((table.data[v * B + b] as number) * 1e5) / 1e5;
      weights.push(w > 0 ? w : 0);
    }
  }
  const command: WeightsTableCommand = { op: "weights.table", ...address, influences: used.map((b) => table.bones[b] as string), weights };
  if (options.max !== undefined) command.max = options.max;
  if (options.min !== undefined) command.min = options.min;
  return command;
}

// --- Smooth, copy and paste of whole rows ------------------------------------------------------------------

/**
 * Smooths the weights of `vertices` (every vertex when null): each row moves `amount` (0..1) of the way to the average of its
 * neighbours' rows, then sums back to 1. Returns a new table; the input is not touched.
 */
export function smoothTable(table: WeightTable, neighbours: readonly ReadonlySet<number>[], vertices: Iterable<number> | null, amount = 0.5): WeightTable {
  const out = cloneTable(table);
  const B = table.bones.length;
  const list = vertices === null ? Array.from({ length: table.vertexCount }, (_, v) => v) : [...vertices];
  for (const v of list) {
    const near = neighbours[v];
    if (!near || near.size === 0 || v < 0 || v >= table.vertexCount) continue;
    for (let b = 0; b < B; b++) {
      let sum = 0;
      for (const n of near) sum += table.data[n * B + b] as number;
      const own = table.data[v * B + b] as number;
      out.data[v * B + b] = own + (sum / near.size - own) * amount;
    }
    normalizeRow(out, v);
  }
  return out;
}

/**
 * Pastes `source` rows over `target` (only `vertices` when given). Both meshes must have the same vertex count. The result has
 * the target's bones plus any the source uses, matched by bone name. Returns null when the vertex counts differ.
 */
export function pasteTable(target: WeightTable, source: WeightTable, vertices: Iterable<number> | null): WeightTable | null {
  if (target.vertexCount !== source.vertexCount) return null;
  const bones = [...target.bones];
  for (const b of source.bones) if (!bones.includes(b)) bones.push(b);
  const B = bones.length;
  const out = createTable(bones, target.vertexCount);
  const tb = target.bones.length;
  const sb = source.bones.length;
  const pick = vertices === null ? null : new Set(vertices);
  for (let v = 0; v < target.vertexCount; v++) {
    if (pick === null || pick.has(v)) for (let b = 0; b < sb; b++) out.data[v * B + bones.indexOf(source.bones[b] as string)] = source.data[v * sb + b] as number;
    else for (let b = 0; b < tb; b++) out.data[v * B + b] = target.data[v * tb + b] as number;
  }
  return out;
}

/** Drops the columns no vertex uses (after a paste or weld) so the saved mesh only lists bones it is skinned to. */
export function trimTable(table: WeightTable, keep: readonly string[] = []): WeightTable {
  const B = table.bones.length;
  const used: number[] = [];
  for (let b = 0; b < B; b++) {
    let any = keep.includes(table.bones[b] as string);
    for (let v = 0; v < table.vertexCount && !any; v++) if ((table.data[v * B + b] as number) > 0) any = true;
    if (any) used.push(b);
  }
  const out = createTable(used.map((b) => table.bones[b] as string), table.vertexCount);
  used.forEach((b, i) => {
    for (let v = 0; v < table.vertexCount; v++) out.data[v * used.length + i] = table.data[v * B + b] as number;
  });
  return out;
}
