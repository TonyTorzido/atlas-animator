/*
 * Atlas Animator: original implementation.
 *
 * Pose-space shape targets for a continuous skin surface (pass 3b; consult 2, sections
 * 3, 4 and 6): procedural boundary curves plus a constrained interior solve.
 *
 * - Handles. Every skin vertex outside the joint patches that has no chain influence, every rigid
 *   core vertex, fixed body region and anchored apex follows its bone(s) exactly (linear blend of
 *   rigid transforms, i.e. the runtime skinning without correctives). On a limb side whose core has
 *   no hull vertex (patches cover it), the hull vertex nearest the core's middle is added as a rigid
 *   core anchor. Everything else is free.
 * - Boundary. The free hull vertices form runs between two handle anchors. Per run, a cubic
 *   Hermite curve joins the posed anchors with the anchors' tangents (bind hull tangents carried
 *   by the anchor's linear transform: tangent-continuous into the flank and the cores; a notch apex
 *   is a corner and takes its one-sided tangent). The bind run's detail relative to its own bind
 *   cubic is kept in the curve's moving frame at fixed curve parameters (bind arc-length
 *   fractions), so the zero pose reproduces the setup boundary exactly and vertex correspondence is
 *   fixed. A posed tangent is turned towards the chord when it leaves the chord by more than its
 *   limit (bind angle + 5 degrees, at least 35 for a corner and 80 otherwise), and the handle
 *   length shrinks while the curve reverses along its chord (no hook or extra lobe).
 * - Interior. Area-weighted rigidity (as-rigid-as-possible: sum A_t |F_t - c R_t|^2, R_t the
 *   closest rotation, c a per-joint scale that holds the joint region's aggregate area within
 *   its tolerance) plus stiff springs pulling the free hull vertices onto the curve targets; the
 *   global step is one prefactored linear solve. Every step keeps det(F_t) >= floor + margin on
 *   every triangle by backtracking (local injectivity from a valid start, as in SLIM).
 * - Continuation. From the valid setup mesh through small pose increments with warm starts; a step
 *   whose start is infeasible is halved, and a pose that cannot be reached (or whose result misses
 *   the boundary, area or validity bounds) is reported as a failure, never returned as a target.
 */
import { loadAnimDocument } from "../../core/formatLoader.js";
import { Poser, type Pose } from "./correctives.js";
import { KIND_ALLOWANCES } from "./validationCompanion.js";
import { dist, distanceToPolyline, pointInPolygon, segmentCross, signedArea, smoothstep, type Pt } from "./geometry.js";
import type { BuiltAnchor, BuiltSurface } from "./build.js";

/** A bone's world affine (runtime units; add the canvas origin for canvas px). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

/**
 * Permitted posed displacement of an anchored apex at the current pose (canvas px): the declared
 * base plus, with a girdle coupling, gain x the girdle's elevation of the joint pivot: how far the
 * girdle bone's own rotation carries the pivot away from the apex (the pivot where it would be
 * with the girdle bone at setup relative to its parent, compared with where it is; depression adds
 * nothing). `world`/`setup` give posed and setup world affines.
 */
export function apexAllowance(anchor: BuiltAnchor, world: (bone: string) => Affine, setup: (bone: string) => Affine, origin: Pt): number {
  return anchor.permittedMotion + (anchor.girdle ? anchor.girdle.gain * softRamp(girdleCarry(anchor, world, setup, origin).lift, GIRDLE_SOFT) : 0);
}

/**
 * Rounding (canvas px of elevation) of the girdle allowance's ramp at zero elevation: wide enough
 * that the allowance's curvature in the girdle driver stays below the temporal limit (the player template:
 * ~2.2 px of lift per shrug degree, curvature ~ 2.2^2 / (2k) px per degree^2).
 */
const GIRDLE_SOFT = 12;

/** C1 ramp above max(0, x): (x + k)^2 / (4k) for |x| < k (max(0, x) kinks the allowance at the zero shrug). */
const softRamp = (x: number, k: number) => (x <= -k ? 0 : x >= k ? x : ((x + k) * (x + k)) / (4 * k));

/** The girdle bone's own displacement of the joint pivot (canvas px) and its component away from the apex (`lift`); zero without a girdle coupling. */
export function girdleCarry(anchor: BuiltAnchor, world: (bone: string) => Affine, setup: (bone: string) => Affine, origin: Pt): { shift: Pt; lift: number } {
  const g = anchor.girdle;
  if (!g) return { shift: [0, 0], lift: 0 };
  const s = setup(g.parent);
  const w = world(g.parent);
  const carry = (p: Pt): Pt => {
    const x = p[0] - origin[0] - s.x;
    const y = p[1] - origin[1] - s.y;
    const det = s.a * s.d - s.b * s.c;
    const lx = (s.d * x - s.b * y) / det;
    const ly = (-s.c * x + s.a * y) / det;
    return [w.a * lx + w.b * ly + w.x + origin[0], w.c * lx + w.d * ly + w.y + origin[1]];
  };
  const j0 = carry(g.jointAt);
  const k0 = carry(g.apexAt);
  const jw = world(g.joint);
  const len = dist(j0, k0) || 1;
  const shift: Pt = [jw.x + origin[0] - j0[0], jw.y + origin[1] - j0[1]];
  return { shift, lift: (shift[0] * (j0[0] - k0[0]) + shift[1] * (j0[1] - k0[1])) / len };
}

// ---------------------------------------------------------------------------------------------
// Dense Cholesky (the free set is a few hundred vertices; one factorisation per surface)
// ---------------------------------------------------------------------------------------------

export class Cholesky {
  private readonly l: Float64Array;
  constructor(readonly n: number, matrix: Float64Array) {
    const l = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      let d = matrix[j * n + j] as number;
      for (let k = 0; k < j; k++) d -= (l[j * n + k] as number) ** 2;
      if (!(d > 0)) throw new Error(`cholesky: matrix not positive definite at ${j} (a free vertex with no path to a handle?)`);
      const ljj = Math.sqrt(d);
      l[j * n + j] = ljj;
      for (let i = j + 1; i < n; i++) {
        let s = matrix[i * n + j] as number;
        for (let k = 0; k < j; k++) s -= (l[i * n + k] as number) * (l[j * n + k] as number);
        l[i * n + j] = s / ljj;
      }
    }
    this.l = l;
  }
  solve(b: Float64Array): Float64Array {
    const { n, l } = this;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i] as number;
      for (let k = 0; k < i; k++) s -= (l[i * n + k] as number) * (y[k] as number);
      y[i] = s / (l[i * n + i] as number);
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i] as number;
      for (let k = i + 1; k < n; k++) s -= (l[k * n + i] as number) * (x[k] as number);
      x[i] = s / (l[i * n + i] as number);
    }
    return x;
  }
}

// ---------------------------------------------------------------------------------------------
// Generic constrained interior solver
// ---------------------------------------------------------------------------------------------

/** Handle positions for every vertex (exact for handles, a warm-start reference for free vertices) and spring targets for constrained free vertices. */
export interface SolveFrame {
  base: Pt[];
  springs: (Pt | null)[];
}

export interface InteriorOptions {
  /** det(F) floor (posed / bind signed area). */
  floor: number;
  /** Extra margin kept while solving. */
  margin: number;
  /** Spring stiffness, in units of the mean triangle area per px^2. */
  spring: number;
  /** Aggregate area regions (triangle lists) and their tolerance (fraction). */
  regions: { name: string; triangles: number[]; band?: [number, number] }[];
  areaTolerance: number;
}



export interface SolveState {
  x: Pt[];
  /** Per region: rigidity target scale (aggregate area control). */
  scale: number[];
}

export interface SolveOutcome {
  ok: boolean;
  x: Pt[];
  scale: number[];
  minRatio: number;
  /** Largest spring residual (canvas px). */
  springError: number;
  areas: number[];
  reason: string;
  steps: number;
}

const triArea = (a: Pt, b: Pt, c: Pt) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

export class InteriorSolver {
  readonly n: number;
  readonly freeIndex: Int32Array;
  readonly freeList: number[];
  private readonly g: Float64Array; // per triangle 3x2 gradient matrix, row-major
  private readonly area: Float64Array;
  private readonly bindSigned: Float64Array;
  private readonly chol: Cholesky;
  private readonly lFull: Map<number, number>[]; // free row -> handle col -> L entry
  private readonly springK: number;
  private readonly triRegions: number[][];
  readonly regionBind: number[];

  constructor(
    readonly points: readonly Pt[],
    readonly triangles: readonly number[],
    readonly free: readonly boolean[],
    readonly springMask: readonly boolean[],
    readonly options: InteriorOptions
  ) {
    this.n = points.length;
    this.freeList = points.flatMap((_, i) => (free[i] ? [i] : []));
    this.freeIndex = new Int32Array(this.n).fill(-1);
    this.freeList.forEach((v, k) => (this.freeIndex[v] = k));
    const T = triangles.length / 3;
    this.g = new Float64Array(T * 6);
    this.area = new Float64Array(T);
    this.bindSigned = new Float64Array(T);
    let meanArea = 0;
    for (let t = 0; t < T; t++) {
      const a = points[triangles[t * 3] as number] as Pt;
      const b = points[triangles[t * 3 + 1] as number] as Pt;
      const c = points[triangles[t * 3 + 2] as number] as Pt;
      const e1: Pt = [b[0] - a[0], b[1] - a[1]];
      const e2: Pt = [c[0] - a[0], c[1] - a[1]];
      const det = e1[0] * e2[1] - e2[0] * e1[1];
      this.bindSigned[t] = det / 2;
      this.area[t] = Math.abs(det) / 2;
      meanArea += Math.abs(det) / 2 / T;
      // D^-1 for D = [e1 e2] (columns).
      const i00 = e2[1] / det;
      const i01 = -e2[0] / det;
      const i10 = -e1[1] / det;
      const i11 = e1[0] / det;
      // G = B D^-1, B = [[-1,-1],[1,0],[0,1]].
      this.g.set([-(i00 + i10), -(i01 + i11), i00, i01, i10, i11], t * 6);
    }
    this.springK = options.spring * meanArea;
    const m = this.freeList.length;
    const mat = new Float64Array(m * m);
    this.lFull = this.freeList.map(() => new Map<number, number>());
    for (let t = 0; t < T; t++) {
      const A = this.area[t] as number;
      for (let j = 0; j < 3; j++) {
        const vj = triangles[t * 3 + j] as number;
        const fj = this.freeIndex[vj] as number;
        if (fj < 0) continue;
        for (let k = 0; k < 3; k++) {
          const vk = triangles[t * 3 + k] as number;
          const val = A * ((this.g[t * 6 + j * 2] as number) * (this.g[t * 6 + k * 2] as number) + (this.g[t * 6 + j * 2 + 1] as number) * (this.g[t * 6 + k * 2 + 1] as number));
          const fk = this.freeIndex[vk] as number;
          if (fk >= 0) mat[fj * m + fk] = (mat[fj * m + fk] as number) + val;
          else {
            const row = this.lFull[fj] as Map<number, number>;
            row.set(vk, (row.get(vk) ?? 0) + val);
          }
        }
      }
    }
    this.freeList.forEach((v, k) => {
      if (springMask[v]) mat[k * m + k] = (mat[k * m + k] as number) + this.springK;
    });
    this.chol = new Cholesky(m, mat);
    this.triRegions = Array.from({ length: T }, () => [] as number[]);
    options.regions.forEach((r, k) => r.triangles.forEach((t) => (this.triRegions[t] as number[]).push(k)));
    this.regionBind = options.regions.map((r) => r.triangles.reduce((s, t) => s + (this.area[t] as number), 0));
  }

  /** Posed / bind signed-area ratio of every triangle's minimum, and where. */
  minRatio(x: readonly Pt[]): { min: number; at: number } {
    let min = Infinity;
    let at = -1;
    const tr = this.triangles;
    for (let t = 0; t < tr.length / 3; t++) {
      const r = triArea(x[tr[t * 3] as number] as Pt, x[tr[t * 3 + 1] as number] as Pt, x[tr[t * 3 + 2] as number] as Pt) / (this.bindSigned[t] as number);
      if (r < min) {
        min = r;
        at = t;
      }
    }
    return { min, at };
  }

  regionAreas(x: readonly Pt[]): number[] {
    const tr = this.triangles;
    return this.options.regions.map((r, k) => {
      let s = 0;
      for (const t of r.triangles) s += Math.sign(this.bindSigned[t] as number) * triArea(x[tr[t * 3] as number] as Pt, x[tr[t * 3 + 1] as number] as Pt, x[tr[t * 3 + 2] as number] as Pt);
      return s / (this.regionBind[k] as number);
    });
  }

  private feasible(x: readonly Pt[], current = Infinity): boolean {
    const m = this.minRatio(x).min;
    return m >= this.options.floor + this.options.margin || (m > this.options.floor && m >= current - 1e-9);
  }

  /** Local-global iterations from a feasible `state` at `frame`; every accepted step stays feasible. */
  iterate(state: SolveState, frame: SolveFrame, iterations: number, tolerance = 1e-4): SolveState {
    let x = state.x.map((p, i) => (this.free[i] ? p : (frame.base[i] as Pt)));
    const scale = [...state.scale];
    const tr = this.triangles;
    const T = tr.length / 3;
    const m = this.freeList.length;
    const tol = this.options.areaTolerance;
    for (let it = 0; it < iterations; it++) {
      // Aggregate area control: nudge the per-region rigidity scale towards the declared band.
      const areas = this.regionAreas(x);
      areas.forEach((r, k) => {
        const band = this.options.regions[k]?.band ?? [1 - tol, 1 + tol];
        const lo = 1 - (1 - band[0]) * 0.8;
        const hi = 1 + (band[1] - 1) * 0.8;
        if (r > hi) scale[k] = Math.max(0.67, (scale[k] as number) * Math.pow(hi / r, 0.25));
        else if (r < lo) scale[k] = Math.min(1.5, (scale[k] as number) * Math.pow(lo / r, 0.25));
      });
      const bx = new Float64Array(m);
      const by = new Float64Array(m);
      for (let t = 0; t < T; t++) {
        const ia = tr[t * 3] as number;
        const ib = tr[t * 3 + 1] as number;
        const ic = tr[t * 3 + 2] as number;
        const fa = this.freeIndex[ia] as number;
        const fb = this.freeIndex[ib] as number;
        const fc = this.freeIndex[ic] as number;
        if (fa < 0 && fb < 0 && fc < 0) continue;
        const g = this.g;
        const o = t * 6;
        const pa = x[ia] as Pt;
        const pb = x[ib] as Pt;
        const pc = x[ic] as Pt;
        // F = X G (2x2).
        const f00 = pa[0] * (g[o] as number) + pb[0] * (g[o + 2] as number) + pc[0] * (g[o + 4] as number);
        const f01 = pa[0] * (g[o + 1] as number) + pb[0] * (g[o + 3] as number) + pc[0] * (g[o + 5] as number);
        const f10 = pa[1] * (g[o] as number) + pb[1] * (g[o + 2] as number) + pc[1] * (g[o + 4] as number);
        const f11 = pa[1] * (g[o + 1] as number) + pb[1] * (g[o + 3] as number) + pc[1] * (g[o + 5] as number);
        const th = Math.atan2(f10 - f01, f00 + f11);
        const regions = this.triRegions[t] as number[];
        let c = 1;
        if (regions.length) c = regions.reduce((s, k) => s + (scale[k] as number), 0) / regions.length;
        const r00 = c * Math.cos(th);
        let r01 = -c * Math.sin(th);
        const r10 = c * Math.sin(th);
        const r11 = c * Math.cos(th);
        const A = this.area[t] as number;
        for (let j = 0; j < 3; j++) {
          const fj = [fa, fb, fc][j] as number;
          if (fj < 0) continue;
          const gx = g[o + j * 2] as number;
          const gy = g[o + j * 2 + 1] as number;
          bx[fj] = (bx[fj] as number) + A * (r00 * gx + r01 * gy);
          by[fj] = (by[fj] as number) + A * (r10 * gx + r11 * gy);
        }
      }
      this.freeList.forEach((v, k) => {
        for (const [h, val] of this.lFull[k] as Map<number, number>) {
          const p = x[h] as Pt;
          bx[k] = (bx[k] as number) - val * p[0];
          by[k] = (by[k] as number) - val * p[1];
        }
        const s = frame.springs[v];
        if (s) {
          bx[k] = (bx[k] as number) + this.springK * s[0];
          by[k] = (by[k] as number) + this.springK * s[1];
        }
      });
      const sx = this.chol.solve(bx);
      const sy = this.chol.solve(by);
      // Per-vertex backtracking: the full step, except that the free vertices of a triangle the step
      // would push below the floor (or, below floor + margin, make worse) halve their step until no
      // triangle does; one pinned triangle never blocks the rest of the mesh.
      const floor = this.options.floor;
      const keepAbove = floor + this.options.margin;
      const now = new Float64Array(T);
      for (let t = 0; t < T; t++) now[t] = triArea(x[tr[t * 3] as number] as Pt, x[tr[t * 3 + 1] as number] as Pt, x[tr[t * 3 + 2] as number] as Pt) / (this.bindSigned[t] as number);
      const alpha = new Float64Array(m).fill(1);
      let next: Pt[] = x;
      let accepted = false;
      for (let round = 0; round < 40; round++) {
        next = x.map((p, i) => {
          const k = this.freeIndex[i] as number;
          if (k < 0) return p;
          const a = alpha[k] as number;
          return [p[0] + a * ((sx[k] as number) - p[0]), p[1] + a * ((sy[k] as number) - p[1])] as Pt;
        });
        let bad = 0;
        for (let t = 0; t < T; t++) {
          const r = triArea(next[tr[t * 3] as number] as Pt, next[tr[t * 3 + 1] as number] as Pt, next[tr[t * 3 + 2] as number] as Pt) / (this.bindSigned[t] as number);
          if (r >= keepAbove || (r > floor && r >= (now[t] as number) - 1e-12)) continue;
          bad++;
          for (let j = 0; j < 3; j++) {
            const k = this.freeIndex[tr[t * 3 + j] as number] as number;
            if (k >= 0) alpha[k] = (alpha[k] as number) < 1 / 512 ? 0 : (alpha[k] as number) / 2;
          }
        }
        if (bad === 0) {
          accepted = true;
          break;
        }
      }
      if (!accepted) break;
      let move = 0;
      for (const v of this.freeList) move = Math.max(move, dist(next[v] as Pt, x[v] as Pt));
      x = next;
      if (move < tolerance) break;
    }
    return { x, scale };
  }

  /**
   * Feasible continuation from `start` (solved for frameAt(0)) to frameAt(1): small steps, warm
   * starts carried by the base motion, halved when the carried start breaks the floor.
   */
  continuation(start: SolveState, frameAt: (u: number) => SolveFrame, opts: { steps: number; iterations?: number; polish?: number; minStep?: number }): { state: SolveState; ok: boolean; reason: string; steps: number; frame: SolveFrame } {
    let state = start;
    let prev = frameAt(0);
    let u = 0;
    let du = 1 / Math.max(1, opts.steps);
    const minStep = opts.minStep ?? du / 64;
    let steps = 0;
    while (u < 1 - 1e-12) {
      const u1 = Math.min(1, u + du);
      const f1 = frameAt(u1);
      const guess = state.x.map((p, i) => (this.free[i] ? ([p[0] + (f1.base[i] as Pt)[0] - (prev.base[i] as Pt)[0], p[1] + (f1.base[i] as Pt)[1] - (prev.base[i] as Pt)[1]] as Pt) : (f1.base[i] as Pt)));
      const floorOk = (x: Pt[]) => this.minRatio(x).min > this.options.floor;
      if (!floorOk(guess)) {
        // Try the previous free positions unchanged before shrinking the step.
        const still = state.x.map((p, i) => (this.free[i] ? p : (f1.base[i] as Pt)));
        if (!floorOk(still)) {
          du /= 2;
          if (du < minStep) {
            const r = this.minRatio(guess);
            return { state, ok: false, reason: `continuation stalled at u ${u.toFixed(4)} (carried start min det ${r.min.toFixed(3)} at t${r.at})`, steps, frame: prev };
          }
          continue;
        }
        state = this.iterate({ x: still, scale: state.scale }, f1, opts.iterations ?? 12);
      } else state = this.iterate({ x: guess, scale: state.scale }, f1, opts.iterations ?? 12);
      steps++;
      u = u1;
      prev = f1;
      du = Math.min(1 / Math.max(1, opts.steps), du * 1.5);
    }
    state = this.iterate(state, prev, opts.polish ?? 200, 1e-5);
    return { state, ok: true, reason: "", steps, frame: prev };
  }

  springError(x: readonly Pt[], frame: SolveFrame): number {
    let e = 0;
    frame.springs.forEach((s, i) => {
      if (s) e = Math.max(e, dist(s, x[i] as Pt));
    });
    return e;
  }
}

// ---------------------------------------------------------------------------------------------
// Procedural boundary curves
// ---------------------------------------------------------------------------------------------

export interface BoundaryRun {
  /** Free hull vertices in hull order (a -> b). */
  ids: number[];
  a: number;
  b: number;
  cornerA: boolean;
  cornerB: boolean;
  /** Fixed curve parameter of each run vertex (bind arc-length fraction from a). */
  params: number[];
  /** Bind tangents (unit, along the walk) at a and b. */
  tanA: Pt;
  tanB: Pt;
  limitA: number;
  limitB: number;
  /** Bind detail of each vertex in the bind curve's frame: [along, across]. */
  detail: Pt[];
  /** Corner anchors: the hull neighbour on the other branch and the bind signed angle from that branch to the run's tangent (the notch opening). */
  slitA?: { other: number; angle: number };
  slitB?: { other: number; angle: number };
  monotoneAtBind: boolean;
}

/** Crease fillet radius of a hinge path, as a fraction of the limb width. */
export const HINGE_FILLET = 0.08;

const hermite = (A: Pt, B: Pt, m0: Pt, m1: Pt, t: number): Pt => {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [h00 * A[0] + h10 * m0[0] + h01 * B[0] + h11 * m1[0], h00 * A[1] + h10 * m0[1] + h01 * B[1] + h11 * m1[1]];
};
const hermiteD = (A: Pt, B: Pt, m0: Pt, m1: Pt, t: number): Pt => {
  const t2 = t * t;
  const d00 = 6 * t2 - 6 * t;
  const d10 = 3 * t2 - 4 * t + 1;
  const d01 = -6 * t2 + 6 * t;
  const d11 = 3 * t2 - 2 * t;
  return [d00 * A[0] + d10 * m0[0] + d01 * B[0] + d11 * m1[0], d00 * A[1] + d10 * m0[1] + d01 * B[1] + d11 * m1[1]];
};
const unit = (p: Pt): Pt => {
  const l = Math.hypot(p[0], p[1]) || 1;
  return [p[0] / l, p[1] / l];
};
const angleBetween = (a: Pt, b: Pt) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / ((Math.hypot(a[0], a[1]) || 1) * (Math.hypot(b[0], b[1]) || 1)))));
const rotate = (p: Pt, r: number): Pt => [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r)];

/** Turns `t` towards `chord` until it is within `limit` radians of it. */
function clampTangent(t: Pt, chord: Pt, limit: number): Pt {
  const a = angleBetween(t, chord);
  if (a <= limit) return unit(t);
  const cross = chord[0] * t[1] - chord[1] * t[0];
  const ca = Math.atan2(chord[1], chord[0]);
  const r = ca + Math.sign(cross || 1) * limit;
  return [Math.cos(r), Math.sin(r)];
}

/** The curve of a run between posed anchors; `k` scales the Hermite tangents (1 = Bezier handles at chord/3). */
function runCurve(A: Pt, B: Pt, tA: Pt, tB: Pt, k: number) {
  const chord = dist(A, B);
  const m0: Pt = [tA[0] * chord * k, tA[1] * chord * k];
  const m1: Pt = [tB[0] * chord * k, tB[1] * chord * k];
  return { m0, m1 };
}

function monotone(A: Pt, B: Pt, m0: Pt, m1: Pt): boolean {
  const c: Pt = [B[0] - A[0], B[1] - A[1]];
  for (let s = 0; s <= 20; s++) {
    const d = hermiteD(A, B, m0, m1, s / 20);
    if (d[0] * c[0] + d[1] * c[1] <= 0) return false;
  }
  return true;
}

export function makeRun(hull: readonly Pt[], ids: number[], a: number, b: number, cornerA: boolean, cornerB: boolean): BoundaryRun {
  const H = hull.length;
  const P = (i: number) => hull[((i % H) + H) % H] as Pt;
  const A = P(a);
  const B = P(b);
  const first = P(ids[0] as number);
  const last = P(ids[ids.length - 1] as number);
  const tanA = cornerA ? unit([first[0] - A[0], first[1] - A[1]]) : unit([P(a + 1)[0] - P(a - 1)[0], P(a + 1)[1] - P(a - 1)[1]]);
  const tanB = cornerB ? unit([B[0] - last[0], B[1] - last[1]]) : unit([P(b + 1)[0] - P(b - 1)[0], P(b + 1)[1] - P(b - 1)[1]]);
  const chain = [A, ...ids.map(P), B];
  const arcs = [0];
  for (let i = 1; i < chain.length; i++) arcs.push((arcs[i - 1] as number) + dist(chain[i - 1] as Pt, chain[i] as Pt));
  const total = arcs[arcs.length - 1] as number;
  const params = ids.map((_, k) => (arcs[k + 1] as number) / total);
  const chord: Pt = [B[0] - A[0], B[1] - A[1]];
  const limitA = Math.max(angleBetween(tanA, chord) + (5 * Math.PI) / 180, ((cornerA ? 35 : 80) * Math.PI) / 180);
  const limitB = Math.max(angleBetween(tanB, chord) + (5 * Math.PI) / 180, ((cornerB ? 35 : 80) * Math.PI) / 180);
  const { m0, m1 } = runCurve(A, B, tanA, tanB, 1);
  const detail = ids.map((v, k) => {
    const t = params[k] as number;
    const c = hermite(A, B, m0, m1, t);
    const u = unit(hermiteD(A, B, m0, m1, t));
    const d: Pt = [P(v)[0] - c[0], P(v)[1] - c[1]];
    return [d[0] * u[0] + d[1] * u[1], -d[0] * u[1] + d[1] * u[0]] as Pt;
  });
  // The run leaves a corner through the notch side: the opposing branch is the hull neighbour outside the run.
  const signed = (from: Pt, to: Pt) => Math.atan2(from[0] * to[1] - from[1] * to[0], from[0] * to[0] + from[1] * to[1]);
  const slitA = cornerA ? { other: a - 1, angle: signed(unit([P(a - 1)[0] - A[0], P(a - 1)[1] - A[1]]), tanA) } : undefined;
  const slitB = cornerB ? { other: b + 1, angle: signed(unit([P(b + 1)[0] - B[0], P(b + 1)[1] - B[1]]), [-tanB[0], -tanB[1]]) } : undefined;
  return { ids, a, b, cornerA, cornerB, params, tanA, tanB, limitA, limitB, detail, monotoneAtBind: monotone(A, B, m0, m1), ...(slitA ? { slitA } : {}), ...(slitB ? { slitB } : {}) };
}

/** Keeps a corner's outgoing direction `t` at least half the bind opening away from the opposing branch `o` (same turning sense): the notch never closes past itself. */
function keepSlit(t: Pt, o: Pt, bindAngle: number): Pt {
  const signed = Math.atan2(o[0] * t[1] - o[1] * t[0], o[0] * t[0] + o[1] * t[1]);
  const keep = bindAngle * 0.5;
  if (Math.sign(signed) === Math.sign(bindAngle) && Math.abs(signed) >= Math.abs(keep)) return t;
  const r = Math.atan2(o[1], o[0]) + keep;
  return [Math.cos(r), Math.sin(r)];
}

/** Posed run targets from posed anchors and anchor linear maps; `lobe` = still reversing at the smallest handle. */
export function runTargets(run: BoundaryRun, A: Pt, B: Pt, linA: [number, number, number, number], linB: [number, number, number, number], otherA?: Pt, otherB?: Pt): { points: Pt[]; lobe: boolean; clamped: boolean; k: number } {
  const map = (l: [number, number, number, number], p: Pt): Pt => [l[0] * p[0] + l[1] * p[1], l[2] * p[0] + l[3] * p[1]];
  const chord: Pt = [B[0] - A[0], B[1] - A[1]];
  let tA = unit(map(linA, run.tanA));
  let tB = unit(map(linB, run.tanB));
  const cA = clampTangent(tA, chord, run.limitA);
  const cB = clampTangent(tB, chord, run.limitB);
  let sA = cA;
  let sB = cB;
  if (run.slitA && otherA) sA = keepSlit(cA, unit([otherA[0] - A[0], otherA[1] - A[1]]), run.slitA.angle);
  if (run.slitB && otherB) {
    const back = keepSlit([-cB[0], -cB[1]], unit([otherB[0] - B[0], otherB[1] - B[1]]), run.slitB.angle);
    sB = [-back[0], -back[1]];
  }
  const clamped = dist(sA, tA) > 1e-9 || dist(sB, tB) > 1e-9;
  tA = sA;
  tB = sB;
  let k = 1;
  let curve = runCurve(A, B, tA, tB, k);
  let lobe = false;
  if (run.monotoneAtBind) {
    while (!monotone(A, B, curve.m0, curve.m1) && k > 0.15) {
      k *= 0.8;
      curve = runCurve(A, B, tA, tB, k);
    }
    lobe = !monotone(A, B, curve.m0, curve.m1);
  }
  const points = run.ids.map((_, i) => {
    const t = run.params[i] as number;
    const c = hermite(A, B, curve.m0, curve.m1, t);
    const u = unit(hermiteD(A, B, curve.m0, curve.m1, t));
    const [al, ac] = run.detail[i] as Pt;
    return [c[0] + al * u[0] - ac * u[1], c[1] + al * u[1] + ac * u[0]] as Pt;
  });
  return { points, lobe, clamped, k };
}

/**
 * Hinge path of a run inside a 'both' hinge patch. The run's anchor edges stay straight lines (the rigid
 * cores' edges carried by their bones); between them the opening side is a circular arc about the
 * joint pivot (the rounded outer elbow/knee point) and the closing side is the two edge lines meeting
 * at the crease point (their intersection, on the pivot's bisector) with a small fillet. Returns the
 * path as a dense polyline (canvas px) from A to B.
 */
export function hingePath(A: Pt, B: Pt, tA: Pt, tB: Pt, P: Pt, fillet: number): { path: Pt[]; opening: boolean; crease: Pt } {
  // Near straight the two sides differ (the opening side steps between offset edge lines through the
  // pivot's feet, the closing side cuts across at the crease point), so a hinge passing through
  // straight (the creature's knee at shin 44) switched paths and its vertices jumped along them
  // (pass 3d-2, temporal). Within HINGE_BLEND of straight the path is the arc-length
  // blend of both sides, half and half at straight: continuous through the switch.
  const phi = Math.atan2(tA[0] * tB[1] - tA[1] * tB[0], tA[0] * tB[0] + tA[1] * tB[1]);
  const side = Math.sign(tA[0] * (P[1] - A[1]) - tA[1] * (P[0] - A[0])) || 1;
  const m = phi * side;
  if (Math.abs(m) >= HINGE_BLEND) return hingeSide(A, B, tA, tB, P, fillet, m >= 0);
  const open = hingeSide(A, B, tA, tB, P, fillet, true);
  const close = hingeSide(A, B, tA, tB, P, fillet, false);
  const f = smooth01(0.5 + (0.5 * m) / HINGE_BLEND);
  const fr = Array.from({ length: HINGE_SAMPLES + 1 }, (_, i) => i / HINGE_SAMPLES);
  const po = alongPath(open.path, fr).points;
  const pc = alongPath(close.path, fr).points;
  const path = po.map((p, i) => [(pc[i] as Pt)[0] + ((p as Pt)[0] - (pc[i] as Pt)[0]) * f, (pc[i] as Pt)[1] + ((p as Pt)[1] - (pc[i] as Pt)[1]) * f] as Pt);
  return { path, opening: m >= 0, crease: close.crease };
}

/** Half-width (radians) of the blend between a hinge's opening and closing paths around straight. */
const HINGE_BLEND = (8 * Math.PI) / 180;
/** Arc-length samples of a blended hinge path. */
const HINGE_SAMPLES = 160;

function hingeSide(A: Pt, B: Pt, tA: Pt, tB: Pt, P: Pt, fillet: number, opening: boolean): { path: Pt[]; opening: boolean; crease: Pt } {
  const foot = (Q: Pt, t: Pt): Pt => {
    const k = (P[0] - Q[0]) * t[0] + (P[1] - Q[1]) * t[1];
    return [Q[0] + t[0] * k, Q[1] + t[1] * k];
  };
  const FA = foot(A, tA);
  const FB = foot(B, tB);
  const rA = dist(P, FA);
  const rB = dist(P, FB);
  const phi = Math.atan2(tA[0] * tB[1] - tA[1] * tB[0], tA[0] * tB[0] + tA[1] * tB[1]);
  const side = Math.sign(tA[0] * (P[1] - A[1]) - tA[1] * (P[0] - A[0])) || 1;
  // The walk turns towards the pivot on the opening side (the pivot is inside the turn); the caller
  // decides the side (phi * side >= 0), or asks for both around straight.
  const path: Pt[] = [A];
  const line = (from: Pt, to: Pt) => {
    const n = Math.max(1, Math.ceil(dist(from, to) / 1.5));
    for (let i = 1; i <= n; i++) path.push([from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
  };
  const uA: Pt = rA > 1e-9 ? [(FA[0] - P[0]) / rA, (FA[1] - P[1]) / rA] : [-tA[1] * side, tA[0] * side];
  const uB: Pt = rB > 1e-9 ? [(FB[0] - P[0]) / rB, (FB[1] - P[1]) / rB] : [-tB[1] * side, tB[0] * side];
  if (opening) {
    // Straight to the pivot's foot, an arc about the pivot (radius blended rA -> rB), straight to B.
    // A foot behind its anchor (the pivot projects outside the run) would make the walk double back
    // and flip the path frame of the samples there (pass 3d-2, the creature's knee jump):
    // the arc then starts (ends) at the anchor itself, which is continuous as the foot crosses it.
    const kA = (P[0] - A[0]) * tA[0] + (P[1] - A[1]) * tA[1];
    const kB = (P[0] - B[0]) * tB[0] + (P[1] - B[1]) * tB[1];
    let a0 = Math.atan2(uA[1], uA[0]);
    let r0 = rA;
    if (kA >= 0) line(A, FA);
    else {
      a0 = Math.atan2(A[1] - P[1], A[0] - P[0]);
      r0 = dist(A, P);
    }
    let a1 = Math.atan2(uB[1], uB[0]);
    let r1 = rB;
    if (kB > 0) {
      a1 = Math.atan2(B[1] - P[1], B[0] - P[0]);
      r1 = dist(B, P);
    }
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    if (sweep * phi < 0) sweep = 0;
    const n = Math.max(2, Math.ceil((Math.abs(sweep) * Math.max(r0, r1)) / 0.5));
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const a = a0 + sweep * u;
      const r = r0 + (r1 - r0) * u;
      path.push([P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r]);
    }
    if (kB <= 0) line(path[path.length - 1] as Pt, B);
    else path.push(B);
    return { path, opening, crease: [NaN, NaN] };
  }
  // Closing side: the crease point on the bisector at r / cos(phi / 2) from the pivot.
  const bis = unit([uA[0] + uB[0], uA[1] + uB[1]]);
  const r = (rA + rB) / 2;
  const reach = r / Math.max(0.2, Math.cos(phi / 2));
  const C: Pt = [P[0] + bis[0] * reach, P[1] + bis[1] * reach];
  const tau = fillet * Math.tan(Math.abs(phi) / 2);
  const TA: Pt = [C[0] - tA[0] * tau, C[1] - tA[1] * tau];
  const TB: Pt = [C[0] + tB[0] * tau, C[1] + tB[1] * tau];
  line(A, TA);
  const n = 8;
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    path.push([(1 - u) * (1 - u) * TA[0] + 2 * u * (1 - u) * C[0] + u * u * TB[0], (1 - u) * (1 - u) * TA[1] + 2 * u * (1 - u) * C[1] + u * u * TB[1]]);
  }
  line(TB, B);
  return { path, opening, crease: C };
}

/**
 * Crease path of a root run ending on a notch apex (pass 3d-1, the pose references: a
 * straight limb underside into a tight crease at the body). From the limb anchor B along the limb
 * edge line (direction `d`, towards the apex K) while K lies below that line (on the side away from
 * the limb, by g > 0), the path leaves the line at T, g / tan(CREASE_DESCENT) before K's foot, with a
 * fillet of radius <= `rhoMax`, and runs straight into K: a short web whose descent angle is fixed,
 * so the notch at K opens like the limb edge does and the body's skin above K stays the body's. When K
 * is on or above the line (the limb closes on the body), or T would fall behind B, the path is the
 * straight segment B -> K (continuous with the web as g -> 0). `inside` is the sign of cross(d, p - B) for
 * points p on the limb's side of the line. Returns the polyline from B to K and the turn at T.
 */
/** Distance of K from the limb edge line through B along d, positive away from the limb (`inside` as in creasePath). */
export function creaseGap(B: Pt, d: Pt, K: Pt, inside: number): number {
  return -inside * (d[0] * (K[1] - B[1]) - d[1] * (K[0] - B[0]));
}

export function creasePath(B: Pt, d: Pt, K: Pt, inside: number, rhoMax: number): { path: Pt[]; segs: Seg[]; turn: number; g: number } {
  const kb: Pt = [K[0] - B[0], K[1] - B[1]];
  const along = kb[0] * d[0] + kb[1] * d[1];
  // Distance of K from the line, positive on the side the run turns towards at the apex (away from the limb).
  const g = -inside * (d[0] * kb[1] - d[1] * kb[0]);
  const back = g / Math.tan(CREASE_DESCENT);
  // Where the web would start behind B, T stays a soft floor ahead of it (C1: exactly sAt above
  // CREASE_FLOOR, an exponential approach to 0 below), so the web steepens smoothly instead of
  // switching to a straight B -> K.
  const sAt = softFloor(along - back, CREASE_FLOOR);
  if (!(g > 1e-6) || !(along > 1e-6)) {
    // The web shrinks to K as g -> 0: the turn keeps the descent angle (continuous with the web).
    const segs: Seg[] = [{ kind: "line", a: B, b: K }];
    return { path: segsPolyline(segs), segs, turn: CREASE_DESCENT, g };
  }
  const T: Pt = [B[0] + d[0] * sAt, B[1] + d[1] * sAt];
  const e = unit([K[0] - T[0], K[1] - T[1]]);
  const turn = angleBetween(d, e);
  const half = Math.tan(turn / 2);
  // Fillet tangent length: a C-infinity soft minimum (p-norm) of the radius limit and the two
  // straight spans it may use (a hard min kinks the targets in raise and shrug where the binding
  // limit changes; the soft minimum stays below every limit).
  const tau = half > 1e-9 ? softMin3(rhoMax * half, sAt, dist(T, K) / 2) : 0;
  const rho = half > 1e-9 ? tau / half : 0;
  const TA: Pt = [T[0] - d[0] * tau, T[1] - d[1] * tau];
  const TB: Pt = [T[0] + e[0] * tau, T[1] + e[1] * tau];
  const segs: Seg[] = [{ kind: "line", a: B, b: TA }];
  if (rho > 1e-6) {
    const side = Math.sign(d[0] * e[1] - d[1] * e[0]) || 1;
    const O: Pt = [TA[0] - d[1] * side * rho, TA[1] + d[0] * side * rho];
    segs.push({ kind: "arc", O, r: rho, a0: Math.atan2(TA[1] - O[1], TA[0] - O[0]), sweep: side * turn });
  }
  segs.push({ kind: "line", a: TB, b: K });
  return { path: segsPolyline(segs), segs, turn, g };
}

/** Soft floor (canvas px) of the crease web's start ahead of the limb anchor. */
const CREASE_FLOOR = 3;

/** C1 positive floor: x above k, k exp(x / k - 1) below. */
const softFloor = (x: number, k: number) => (x >= k ? x : k * Math.exp(x / k - 1));

/** Soft minimum of three positive lengths (p-norm, p = 6): smooth, <= the minimum, >= 0.83 x it. */
function softMin3(a: number, b: number, c: number): number {
  const p = 6;
  if (!(a > 0) || !(b > 0) || !(c > 0)) return 0;
  const m = Math.min(a, b, c);
  return m * ((m / a) ** p + (m / b) ** p + (m / c) ** p) ** (-1 / p);
}

/**
 * Opening crease curve (underside crimp; patch `creaseArc`): one cubic from the limb
 * anchor B, tangent to the limb edge line `d`, to the apex K, arriving along `e` (the web's own
 * direction into the apex, so the skin kept at the armpit matches the web path). The web's turn
 * is spread over the whole run (G1 into the hinge band, no fillet corner); handles are a third of
 * the chord. Returns a dense polyline from B to K and its total turn (positive away from the limb).
 */
export function creaseCurvePath(B: Pt, d: Pt, K: Pt, e: Pt, inside: number): { path: Pt[]; turn: number } {
  const L = dist(B, K);
  const h = L / 3;
  const c1: Pt = [B[0] + d[0] * h, B[1] + d[1] * h];
  const c2: Pt = [K[0] - e[0] * h, K[1] - e[1] * h];
  const n = Math.max(8, Math.ceil(L / 1.5));
  const path: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    path.push([u * u * u * B[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * K[0], u * u * u * B[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * K[1]]);
  }
  const turn = -inside * Math.atan2(d[0] * e[1] - d[1] * e[0], d[0] * e[0] + d[1] * e[1]);
  return { path, turn };
}

/** An analytic path piece: a straight segment, or a circular arc (centre, radius, start angle, signed sweep). */
export type Seg = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; O: Pt; r: number; a0: number; sweep: number };

const segLength = (s: Seg) => (s.kind === "line" ? dist(s.a, s.b) : s.r * Math.abs(s.sweep));

/** Total arc length of an analytic path. */
export const segsLength = (segs: readonly Seg[]) => segs.reduce((sum, s) => sum + segLength(s), 0);

/** The path walked the other way. */
export const reverseSegs = (segs: readonly Seg[]): Seg[] => [...segs].reverse().map((s) => (s.kind === "line" ? { kind: "line", a: s.b, b: s.a } : { kind: "arc", O: s.O, r: s.r, a0: s.a0 + s.sweep, sweep: -s.sweep }));

/** Exact points and unit tangents at arc-length fractions of an analytic path (continuous in the path's parameters, unlike a sampled polyline). */
export function segsAlong(segs: readonly Seg[], params: readonly number[]): { points: Pt[]; tangents: Pt[] } {
  const total = segsLength(segs);
  const points: Pt[] = [];
  const tangents: Pt[] = [];
  for (const t of params) {
    let want = t * total;
    let k = 0;
    while (k < segs.length - 1 && want > segLength(segs[k] as Seg)) want -= segLength(segs[k++] as Seg);
    const s = segs[k] as Seg;
    if (s.kind === "line") {
      const len = segLength(s);
      const u = len > 1e-12 ? want / len : 0;
      points.push([s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u]);
      tangents.push(len > 1e-12 ? unit([s.b[0] - s.a[0], s.b[1] - s.a[1]]) : [1, 0]);
    } else {
      const sg = Math.sign(s.sweep) || 1;
      const a = s.a0 + (sg * want) / s.r;
      points.push([s.O[0] + Math.cos(a) * s.r, s.O[1] + Math.sin(a) * s.r]);
      tangents.push([-Math.sin(a) * sg, Math.cos(a) * sg]);
    }
  }
  return { points, tangents };
}

/** A dense polyline of an analytic path (drawing and diagnostics). */
function segsPolyline(segs: readonly Seg[]): Pt[] {
  const total = segsLength(segs);
  const n = Math.max(2, Math.ceil(total / 1.5));
  return segsAlong(segs, Array.from({ length: n + 1 }, (_, i) => i / n)).points;
}

/** Distance (canvas px) of the apex below the limb edge line over which a crease run blends in from the Hermite bend (a limb closing on the body keeps the bend). */
export const CREASE_BLEND = 40;

/** Descent angle of the crease web from the limb edge line into the apex. */
export const CREASE_DESCENT = (22 * Math.PI) / 180;



/** Smooth maximum: max(a, b) plus a bump of at most k / 4 where they are within k. */
export const smoothMax = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
};

/**
 * Cap envelope of an outer root run (pass 3d-1): `body` (posed without the chain, walk
 * order from the run's body anchor) and `arm` (rigid with the joint bone, walk order to the limb
 * anchor) in polar coordinates about the posed pivot P. Along the walk the polar angle runs one way
 * (`sense`); the boundary is r(angle) = the smooth maximum of the two sides where both are defined
 * (the limb edge rising out of the body line, bump <= k / 4), the side alone where one is, and a
 * linear radius ramp across a gap between them (an arc about the pivot: the rounded cap). Near the
 * two anchors the envelope blends into the anchor's own side so it starts and ends on them.
 * Returns the polyline, or null when a side does not run monotonically in angle. With `arc` (plan
 *) and a positive `arcWeight` the stretch about the crossover is one shoulder arc (`shoulderArc`).
 */
export function capEnvelope(P: Pt, body: readonly Pt[], arm: readonly Pt[], sense: number, refBody: readonly number[], refArm: readonly number[], k: number, arc?: CapArc, arcWeight = 0, through?: readonly Pt[], throughWeight = 0): Pt[] | null {
  const polar = (pts: readonly Pt[], ref: readonly number[]) =>
    pts.map((p, i) => {
      let a = Math.atan2(p[1] - P[1], p[0] - P[0]);
      const r0 = ref[i] as number;
      a += 2 * Math.PI * Math.round((r0 - a) / (2 * Math.PI));
      return [a * sense, Math.hypot(p[0] - P[0], p[1] - P[1])] as Pt;
    });
  const b = polar(body, refBody);
  const m = polar(arm, refArm);
  const mono = (c: Pt[]) => c.every((q, i) => i === 0 || q[0] > (c[i - 1] as Pt)[0] - 1e-9);
  if (!mono(b) || !mono(m)) return null;
  const at = (c: Pt[], phi: number): number | null => {
    if (phi < (c[0] as Pt)[0] - 1e-9 || phi > (c[c.length - 1] as Pt)[0] + 1e-9) return null;
    for (let i = 1; i < c.length; i++) {
      const p = c[i - 1] as Pt;
      const q = c[i] as Pt;
      if (phi <= q[0] + 1e-12) return q[0] - p[0] > 1e-12 ? p[1] + ((q[1] - p[1]) * (phi - p[0])) / (q[0] - p[0]) : q[1];
    }
    return (c[c.length - 1] as Pt)[1];
  };
  const start = (b[0] as Pt)[0];
  const end = (m[m.length - 1] as Pt)[0];
  if (!(end > start)) return null;
  const bEnd = b[b.length - 1] as Pt;
  const mStart = m[0] as Pt;
  const blend = (6 * Math.PI) / 180;
  const onset = (24 * Math.PI) / 180;
  const n = Math.max(8, Math.ceil((end - start) / ((0.5 * Math.PI) / 180)));
  const out: Pt[] = [];
  // Crossover (the shoulder arc's centre): the first sample where the limb side reaches the body side, or the gap opens.
  let crossover = -1;
  for (let i = 0; i <= n; i++) {
    const phi = start + ((end - start) * i) / n;
    const rb = at(b, phi);
    const rm = at(m, phi);
    if (crossover < 0 && i > 0 && (rb === null || (rm !== null && rm >= rb))) crossover = i;
    let r: number;
    if (rb !== null && rm !== null) {
      // The limb side emerges over `onset` of angle where it starts inside the body's range, and the
      // body side hands over to the limb over `onset` before it ends (no step either way).
      const emerge = rb + (smoothMax(rb, rm, k) - rb) * smooth01((phi - mStart[0]) / onset);
      r = rm + (emerge - rm) * smooth01((bEnd[0] - phi) / onset);
    }
    else if (rb !== null) r = rb;
    else if (rm !== null) r = rm;
    else r = bEnd[1] + ((mStart[1] - bEnd[1]) * (phi - bEnd[0])) / (mStart[0] - bEnd[0] || 1);
    // Start on the body anchor's side and end on the limb anchor's side.
    if (rb !== null && phi - start < blend) r = rb + (r - rb) * smooth01((phi - start) / blend);
    if (rm !== null && end - phi < blend) r = rm + (r - rm) * smooth01((end - phi) / blend);
    const a = phi * sense;
    out.push([P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r]);
  }
  if (!arc || crossover <= 0) return out;
  const shaped = arcWeight > 0 ? shoulderArc(P, out, sense, arc, crossover, arcWeight).path : out;
  if (!through || !(throughWeight > 0)) return shaped;
  // A strap ride: blended toward its curve (both sampled at the same polar angles).
  const ridden = shoulderArc(P, out, sense, arc, crossover, 1, through).path;
  return shaped.map((q, i) => [q[0] + ((ridden[i] as Pt)[0] - q[0]) * throughWeight, q[1] + ((ridden[i] as Pt)[1] - q[1]) * throughWeight] as Pt);
}

/** A declared shoulder arc (preset patch `arc`). */
export interface CapArc {
  /** Body hand-off: canvas px along the envelope from the run's body anchor (0 = the strap corner itself). */
  from: number;
  /** Limb hand-off: canvas px along the envelope past the crossover (onto the limb's top edge). */
  to: number;
  /** Hermite tangent length at both hand-offs, as a fraction of the chord. */
  tension: number;
  /** Joint rotation (degrees) over which the arc's weight ramps from 0 to 1 (smoothstep). */
  ramp: [number, number];
  /** Largest move (canvas px) of the envelope, either way, at full weight. */
  move: number;
  /** Junction-concavity gate: hull stretch gated (canvas px along the run at bind) and its concave cap (degrees). */
  region?: number | undefined;
  gate?: number | undefined;
  /** Per-raise junction limits ([joint degrees, degrees]) measured on the reference drawings. */
  gateByRaise?: [number, number][] | undefined;
  /** Strap/neck gate: hull stretch beyond the body anchor (canvas px) and its turn allowance over rest (degrees). */
  neck?: number | undefined;
  neckGate?: number | undefined;
  /**
   * Strap ride: one Hermite curve from the strap/neck side (the hull `neck` px before the body
   * anchor, leaving along the outline there) to the raised limb's top edge (`to` px along it from
   * the run's first limb vertex, along the edge), tangent lengths `tension` x the chord, eased in
   * by `ramp`. The strap corner and the non-free hull between it and the neck point move onto the
   * curve (at their polar angle about the pivot; the largest move at most `max` canvas px), the
   * non-free skin within `radius` of the corner follows its move with a smooth falloff (never a
   * fixed region), and the cap run follows the same curve: the shoulder rounds up as one sweep and
   * the embedded strap rides the skin.
   */
  ride?: { ramp: [number, number]; to: number; tension: number; max: number; radius: number } | undefined;
}

/**
 * Shoulder arc: the envelope `env` (a polyline running about P in direction `sense`,
 * from the body anchor to the limb anchor, crossover sample `at` where the limb side reaches the
 * body side) gets ONE curve from a body hand-off (`from` px from the strap corner) to a limb
 * hand-off (`to` px past the crossover, on the limb's top edge): a cubic Hermite matching the
 * envelope's position and direction at both ends, tangent lengths `tension` x the chord, so the
 * limb's top edge flows into the strap side in one sweep instead of the body's shoulder line
 * stepping onto it (the pinch). The curve is resampled at the envelope's own polar angles, blended
 * in by the joint rotation's weight `w` (0 at rest), and its largest radial move is scaled to at
 * most `move`. Outside the two hand-offs the envelope is unchanged. Returns the path and the move
 * after and before the bound (canvas px).
 */
export function shoulderArc(P: Pt, env: readonly Pt[], sense: number, arc: CapArc, at: number, w: number, through?: readonly Pt[]): { path: Pt[]; move: number; raw: number } {
  const n = env.length;
  const arcs = [0];
  for (let i = 1; i < n; i++) arcs.push((arcs[i - 1] as number) + dist(env[i - 1] as Pt, env[i] as Pt));
  const atArc = (s: number): number => {
    let i = 0;
    while (i < n - 1 && (arcs[i] as number) < s) i++;
    return i;
  };
  const a = through ? 0 : Math.min(atArc(arc.from), at);
  let b = through ? n - 1 : Math.max(atArc((arcs[at] as number) + arc.to), at);
  if (!(w > 0) || b - a < 3) return { path: [...env], move: 0, raw: 0 };
  const tangent = (i: number): Pt => {
    const p = env[Math.max(0, i - 1)] as Pt;
    const q = env[Math.min(n - 1, i + 1)] as Pt;
    return unit([q[0] - p[0], q[1] - p[1]]);
  };
  const A = env[a] as Pt;
  const B = env[b] as Pt;
  const L = dist(A, B) * arc.tension;
  const tA = tangent(a);
  const tB = tangent(b);
  const m = Math.max(32, 2 * (b - a));
  const curve: Pt[] = through ? [...through] : [];
  for (let k = 0; !through && k <= m; k++) {
    const t = k / m;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    curve.push([h00 * A[0] + h10 * L * tA[0] + h01 * B[0] + h11 * L * tB[0], h00 * A[1] + h10 * L * tA[1] + h01 * B[1] + h11 * L * tB[1]]);
  }
  const polar = (pts: readonly Pt[]) => {
    const out: Pt[] = [];
    for (const p of pts) {
      let ang = Math.atan2(p[1] - P[1], p[0] - P[0]) * sense;
      const prev = out[out.length - 1];
      if (prev) ang += 2 * Math.PI * Math.round((prev[0] - ang) / (2 * Math.PI));
      out.push([ang, Math.hypot(p[0] - P[0], p[1] - P[1])]);
    }
    return out;
  };
  const pe = polar(env);
  const pc = polar(curve);
  // The curve must run one way in angle about the pivot, as the envelope does.
  if (pc.some((q, i) => i > 0 && q[0] <= (pc[i - 1] as Pt)[0])) return { path: [...env], move: 0, raw: 0 };
  // A strap ride's curve ends on the limb's top edge: the envelope follows it up to its end angle.
  if (through) while (b > 0 && (pe[b] as Pt)[0] >= (pc[pc.length - 1] as Pt)[0]) b--;
  let c = 1;
  const delta = pe.map(([phi, r], i) => {
    if (i <= a || i >= b) return 0;
    while (c < pc.length - 1 && (pc[c] as Pt)[0] < phi) c++;
    const p = pc[c - 1] as Pt;
    const q = pc[c] as Pt;
    const u = q[0] - p[0] > 1e-12 ? Math.min(1, Math.max(0, (phi - p[0]) / (q[0] - p[0]))) : 1;
    return (p[1] + (q[1] - p[1]) * u - r) * w;
  });
  const raw = Math.max(0, ...delta.map(Math.abs));
  const scale = raw > arc.move ? arc.move / raw : 1;
  const path = pe.map(([phi, r], i) => {
    const rr = r + (delta[i] as number) * scale;
    const ang = phi * sense;
    return [P[0] + Math.cos(ang) * rr, P[1] + Math.sin(ang) * rr] as Pt;
  });
  return { path, move: raw * scale, raw };
}

/** C1 linear ramp 0 -> 1 over t in [0, 1] with quadratic rounding over SOFT_RAMP_K at each end (exactly linear between). */
const SOFT_RAMP_K = 0.15;
function softRamp01(t: number): number {
  const k = SOFT_RAMP_K;
  const r = (x: number) => (x >= k ? x : x <= -k ? 0 : (x + k) ** 2 / (4 * k));
  return r(t) - r(t - 1);
}

/** Weight of a shoulder arc at joint rotation `deg` (smoothstep over its `ramp`). */
export const capArcWeight = (arc: CapArc, deg: number): number => smooth01((deg - arc.ramp[0]) / (arc.ramp[1] - arc.ramp[0] || 1));

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Points (and unit tangents) at arc-length fractions `params` along a polyline. */
export function alongPath(path: readonly Pt[], params: readonly number[], smooth = false): { points: Pt[]; tangents: Pt[] } {
  const arcs = [0];
  // Smooth: tangents interpolated between the polyline's vertex tangents (C0 along the path), so a
  // sample crossing a vertex of a dense curve does not step its frame.
  const vt = (i: number): Pt => {
    const a = path[Math.max(0, i - 1)] as Pt;
    const b = path[i] as Pt;
    const c = path[Math.min(path.length - 1, i + 1)] as Pt;
    const u = unit([b[0] - a[0], b[1] - a[1]]);
    const v = unit([c[0] - b[0], c[1] - b[1]]);
    const s: Pt = [u[0] + v[0], u[1] + v[1]];
    return Math.hypot(s[0], s[1]) > 1e-6 ? unit(s) : Math.hypot(v[0], v[1]) > 0 ? v : u;
  };
  for (let i = 1; i < path.length; i++) arcs.push((arcs[i - 1] as number) + dist(path[i - 1] as Pt, path[i] as Pt));
  const total = arcs[arcs.length - 1] as number;
  const points: Pt[] = [];
  const tangents: Pt[] = [];
  let k = 1;
  for (const t of params) {
    const want = t * total;
    while (k < path.length - 1 && (arcs[k] as number) < want) k++;
    const a = path[k - 1] as Pt;
    const b = path[k] as Pt;
    const len = (arcs[k] as number) - (arcs[k - 1] as number);
    const u = len > 1e-12 ? (want - (arcs[k - 1] as number)) / len : 0;
    points.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    if (smooth) {
      const ta = vt(k - 1);
      const tb = vt(k);
      const m: Pt = [ta[0] + (tb[0] - ta[0]) * u, ta[1] + (tb[1] - ta[1]) * u];
      tangents.push(Math.hypot(m[0], m[1]) > 1e-6 ? unit(m) : unit([b[0] - a[0], b[1] - a[1]]));
    } else tangents.push(unit([b[0] - a[0], b[1] - a[1]]));
  }
  return { points, tangents };
}

// ---------------------------------------------------------------------------------------------
// Surface setup: handles, anchors, runs, joint regions
// ---------------------------------------------------------------------------------------------

export interface SurfaceSolveOptions {
  /** det(F) floor; default 0.2 (the gate). */
  floor?: number;
  margin?: number;
  /** Silhouette tolerance (canvas px): a target whose boundary misses its curve by more is a failure. */
  silhouette: number;
  areaTolerance?: number;
  /** Continuation step (degrees of the largest driver change). */
  stepDegrees?: number;
}

export interface PoseTarget {
  pose: Pose;
  ok: boolean;
  reason: string;
  /** Solved skin positions (canvas). */
  x: Pt[];
  /** Procedural boundary targets of the free hull vertices (null elsewhere). */
  curve: (Pt | null)[];
  minRatio: number;
  springError: number;
  /** Per joint region: posed/bind aggregate area. */
  areas: number[];
  lobes: number;
  clamped: number;
}

/** Smoothing width (canvas px) of the cap envelope's maximum: the bump where the sides cross stays <= CAP_SMOOTH / 4 = 2 px. */
export const CAP_SMOOTH = 8;

export type RunShape =
  | { kind: "crease"; apexAtB: boolean; K: number; B: number; f: Pt; d: Pt; inside: number; rho: number; bindTurn: number; detail: Pt[]; bindLength: number; homeA: boolean[]; arc?: { joint: string; ramp: [number, number]; spread: number; spreadRamp: [number, number]; linear: boolean } }
  | { kind: "cap"; joint: string; body: number[]; arm: number[]; sense: number; refBody: number[]; refArm: number[]; detail: Pt[]; bindLength: number; homeA: boolean[]; arc?: CapArc };

/** Arc length of a polyline. */
const polylineLength = (path: readonly Pt[]) => path.reduce((sum, p, i) => (i ? sum + dist(path[i - 1] as Pt, p) : 0), 0);

/**
 * Curve parameters of a shaped run on a posed path (a -> b) of length `posed`: each vertex keeps its
 * bind arc distance from its home end (`homeA`: the a end, else the b end), so vertices ride rigidly
 * with their side and the length a pose adds goes to the span between the two sides (a crease web,
 * the cap); when the path is shorter than at bind, every distance shrinks by the same factor.
 */
/** Half width of the soft minimum in homeParams (fraction of the bind length). */
const HOME_SOFT = 0.02;

function homeParams(run: BoundaryRun, bindLength: number, posed: number, homeA: readonly boolean[]): number[] {
  // C1 soft minimum of 1 and the length ratio (a hard min kinks the targets where the posed run
  // passes its bind length, at the zero pose for a run whose path is as long as the hull).
  const r = posed / bindLength;
  const c = r <= 1 - HOME_SOFT ? r : r >= 1 + HOME_SOFT ? 1 : r - (r - (1 - HOME_SOFT)) ** 2 / (4 * HOME_SOFT);
  return run.params.map((f, k) => {
    const d = f * bindLength;
    const u = homeA[k] ? d * c : posed - (bindLength - d) * c;
    return Math.min(1, Math.max(0, u / posed));
  });
}

/** Bind detail of a run's vertices against a path (a -> b) at parameters `params`, in the path frame. */
/** Points and tangents along a polyline or an analytic path. */
const sampleAlong = (path: readonly Pt[] | readonly Seg[], params: readonly number[]) =>
  path.length && !Array.isArray(path[0]) ? segsAlong(path as readonly Seg[], params) : alongPath(path as readonly Pt[], params);

function runDetail(run: BoundaryRun, path: readonly Pt[] | readonly Seg[], hull: readonly Pt[], params: readonly number[]): Pt[] {
  const { points, tangents } = sampleAlong(path, params);
  return run.ids.map((v, k) => {
    const d: Pt = [(hull[v] as Pt)[0] - (points[k] as Pt)[0], (hull[v] as Pt)[1] - (points[k] as Pt)[1]];
    const u = tangents[k] as Pt;
    return [d[0] * u[0] + d[1] * u[1], -d[0] * u[1] + d[1] * u[0]] as Pt;
  });
}

/** Run targets: points along `path` (a -> b) at `params` plus `scale` x the bind detail in the path frame. */
function placeOnPath(path: readonly Pt[] | readonly Seg[], params: readonly number[], detail: readonly Pt[], scale: number): Pt[] {
  const { points, tangents } = sampleAlong(path, params);
  return params.map((_, k) => {
    const [al, ac] = detail[k] as Pt;
    const u = tangents[k] as Pt;
    const c = points[k] as Pt;
    return [c[0] + scale * (al * u[0] - ac * u[1]), c[1] + scale * (al * u[1] + ac * u[0])] as Pt;
  });
}

/**
 * Driver degrees over which a crease-led apex ride is gated in from the driver ramp. The shrug
 * turns the limb like a raise does, so the ride's and the blend's fronts run diagonally in
 * raise x shrug; wide transitions (gate 40 degrees, lead over 2 x the allowance, crease blend
 * 40 px) keep their curvature low enough for the bilinear grid (pass 3d-1, pass 3).
 */
const RIDE_GATE = 40;

/** The crease-led ride saturates over RIDE_LEAD x the allowance of the meeting point's travel. */
const RIDE_LEAD = 2;

/** The ride's target stays this far (canvas px) inside the allowance, so baked interpolation never crosses it. */
const RIDE_MARGIN = 0.5;

/** Rounding (canvas px) of the soft maximum between the ramp ride and the crease-led ride. */
const RIDE_SOFT = 3;

/**
 * C1 maximum that is exact where |a - b| >= k and never above max(a, b) (so it stays inside any bound
 * both sides respect): (a + b) / 2 + k x^2 (2 - x) / 2 with x = |a - b| / k < 1.
 */
const softMaxBelow = (a: number, b: number, k: number) => {
  const x = Math.abs(a - b) / k;
  return x >= 1 ? Math.max(a, b) : (a + b) / 2 + (k * x * x * (2 - x)) / 2;
};

/** Bind detail of a crease run fades as its crease turn leaves the bind turn (gone 30 degrees away): a posed crease is the clean path. */
const CREASE_DETAIL_FADE = (30 * Math.PI) / 180;

/** Piecewise-linear key lookup (x -> value), 0 outside the keys. */
function keyed(keys: readonly [number, number][], x: number): number {
  const ks = [...keys].sort((a, b) => a[0] - b[0]);
  const first = ks[0] as [number, number];
  const last = ks[ks.length - 1] as [number, number];
  if (x < first[0] || x > last[0]) return 0;
  for (let i = 1; i < ks.length; i++) {
    const [x0, y0] = ks[i - 1] as [number, number];
    const [x1, y1] = ks[i] as [number, number];
    if (x <= x1) return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
  }
  return last[1];
}

/** Softness (spacing ratio) of the squash floor's smooth maximum. */
const SQUASH_SOFT = 0.06;

/**
 * Squash spreading along a boundary run (patch envelope `squash`): the run's vertices slide along
 * their own posed polyline (the silhouette is kept; the ends stay) so no edge's posed / bind length
 * ratio falls below its floor (`floors` per edge; a shorter list repeats its last): each edge's
 * ratio is raised by a smooth maximum with its floor, and the edges' excess over their floors shrinks
 * in proportion to pay for it (total length unchanged). Where the run is shorter than the floors
 * allow, the edges share it in proportion to bind length x floor. Returns null when no edge is below the floor's soft band (unchanged).
 */
export function spreadSquash(posed: readonly Pt[], bind: readonly Pt[], floors: readonly number[]): Pt[] | null {
  const n = posed.length - 1;
  if (n < 2) return null;
  const cur: number[] = [];
  const ref: number[] = [];
  for (let k = 0; k < n; k++) {
    cur.push(dist(posed[k] as Pt, posed[k + 1] as Pt));
    ref.push(Math.max(1e-9, dist(bind[k] as Pt, bind[k + 1] as Pt)));
  }
  const fl = (k: number) => floors[Math.min(k, floors.length - 1)] as number;
  if (cur.every((c, k) => c / (ref[k] as number) >= fl(k) + 4 * SQUASH_SOFT)) return null;
  const total = cur.reduce((a, b) => a + b, 0);
  const floorTotal = ref.reduce((sum, d, k) => sum + d * fl(k), 0);
  // Smooth maximum of the ratio with the floor (softplus), then the excess over the floor rescaled.
  const raised = cur.map((c, k) => {
    const r = c / (ref[k] as number);
    return fl(k) + SQUASH_SOFT * Math.log1p(Math.exp((r - fl(k)) / SQUASH_SOFT));
  });
  const excess = raised.reduce((sum, r, k) => sum + (r - fl(k)) * (ref[k] as number), 0);
  const room = total - floorTotal;
  const want = room > 0 && excess > 1e-12 ? raised.map((r, k) => (fl(k) + ((r - fl(k)) * room) / excess) * (ref[k] as number)) : ref.map((d, k) => (d * fl(k) * total) / floorTotal);
  // Resample the posed polyline at the new cumulative arc lengths.
  const arcs = [0];
  for (const c of cur) arcs.push((arcs[arcs.length - 1] as number) + c);
  const out: Pt[] = [posed[0] as Pt];
  let s = 0;
  let j = 0;
  for (let k = 0; k < n - 1; k++) {
    s += want[k] as number;
    while (j < n - 1 && (arcs[j + 1] as number) < s) j++;
    const a = posed[j] as Pt;
    const b = posed[j + 1] as Pt;
    const len = cur[j] as number;
    const u = len > 1e-12 ? Math.min(1, Math.max(0, (s - (arcs[j] as number)) / len)) : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  out.push(posed[n] as Pt);
  return out;
}

export class SurfaceSolver {
  readonly poser: Poser;
  readonly solver: InteriorSolver;
  readonly runs: BoundaryRun[];
  /** Per run: the hinge joint bone when every run vertex is in that joint's 'both' patch (hinge path), else null; with its bind detail. */
  readonly hinges: ({ joint: string; fillet: number; detail: Pt[]; squash?: number[] } | null)[];
  readonly free: boolean[];
  /** Per run: a declared root-run shape (crease or cap), else null. */
  readonly shapes: (RunShape | null)[];
  /** Riding notch apexes: vertex -> joint, unit direction (up the body branch), largest motion, driver range. */
  readonly rides: Map<number, { joint: string; dir: Pt; amount: number; range: [number, number]; bindT: number; anchor: BuiltAnchor }>;
  /** Hull vertices made rigid core anchors (vertex -> bone). */
  readonly coreAnchors: Map<number, string>;
  readonly regions: { name: string; joint: string; triangles: number[]; band: [number, number] }[];
  readonly floor: number;
  readonly margin: number;
  readonly silhouette: number;
  readonly areaTolerance: number;
  readonly stepDegrees: number;
  private readonly cache = new Map<string, PoseTarget>();
  private readonly setupWorld = new Map<string, { a: number; b: number; c: number; d: number; x: number; y: number }>();
  private readonly hullPts: Pt[];
  /** Angle-keyed edge pushes (patch `push`): joint, keys, per hull vertex weight. */
  private readonly pushes: { joint: string; keys: [number, number][]; f: number[] }[];
  /** Outward normal of the hull walk: +1 = the tangent's (t.y, -t.x), -1 = the opposite. */
  private readonly outSign: number;

  constructor(readonly built: BuiltSurface, options: SurfaceSolveOptions) {
    this.floor = options.floor ?? 0.2;
    this.margin = options.margin ?? 0.05;
    this.silhouette = options.silhouette;
    this.areaTolerance = options.areaTolerance ?? 0.1;
    this.stepDegrees = options.stepDegrees ?? 1;
    const doc = loadAnimDocument({ ...built.document, driven: [], drivenGrids: [] });
    this.poser = new Poser(doc, built);
    this.poser.pose({});
    for (const b of built.preset.bones) {
      const w = this.poser.skeleton.getBone(b.name).world;
      this.setupWorld.set(b.name, { a: w.a, b: w.b, c: w.c, d: w.d, x: w.x, y: w.y });
    }
    const skin = built.skin;
    const H = skin.hull;
    this.hullPts = skin.points.slice(0, H);
    const chainBones = new Set(built.preset.chain.bones);
    const patchNames = new Set(built.patches.map((p) => p.name));
    const inPatch = (i: number) => (built.support[i]?.region.split("+") ?? []).some((r) => patchNames.has(r));
    const chainInfluence = (i: number) => (skin.weights[i] as [number, number][]).some(([b]) => chainBones.has(skin.bones[b] as string));
    const coreNames = new Map(built.preset.skin.regions.cores.map((c) => [c.name, c]));
    this.free = skin.points.map((_, i) => {
      const region = built.support[i]?.region;
      if (region && (coreNames.has(region) || region === "apex" || built.preset.skin.regions.fixed.some((f) => f.name === region))) return false;
      return inPatch(i) || chainInfluence(i);
    });
    // Rigid core anchors: a limb side whose core has no handle on the hull gets its middle hull vertex.
    this.coreAnchors = new Map();
    const sv = skin.chainSV ?? [];
    for (const core of built.preset.skin.regions.cores) {
      for (const side of [1, -1]) {
        const onSide = Array.from({ length: H }, (_, i) => i).filter((i) => {
          const c = sv[i] as { s: number; v: number };
          return c.s >= core.sMin && c.s <= core.sMax && c.v * side > 0 && Math.abs(c.v) <= built.preset.skin.topology.halfWidth + built.preset.skin.topology.columns;
        });
        if (!onSide.length || onSide.some((i) => built.support[i]?.region === core.name)) continue;
        onSide.splice(0, onSide.length, ...onSide.filter((i) => this.free[i]));
        if (!onSide.length) continue;
        // Halfway between where the proximal joint's patches end and the distal joint's begin on
        // this side (they may overlap), else the middle of the free span.
        const sOf = (i: number) => (sv[i] as { s: number }).s;
        const chainList = built.preset.chain.bones;
        const next = chainList[chainList.indexOf(core.bone) + 1];
        const jointOf = (i: number) => new Set((built.support[i]?.region.split("+") ?? []).map((r) => built.patches.find((p) => p.name === r)?.joint));
        const prox = onSide.filter((i) => jointOf(i).has(core.bone)).map(sOf);
        const dist2 = onSide.filter((i) => next !== undefined && jointOf(i).has(next)).map(sOf);
        const ss = onSide.map(sOf);
        const mid = prox.length && dist2.length ? (Math.max(...prox) + Math.min(...dist2)) / 2 : (Math.min(...ss) + Math.max(...ss)) / 2;
        const pick = onSide.reduce((best, i) => (Math.abs((sv[i] as { s: number }).s - mid) < Math.abs((sv[best] as { s: number }).s - mid) ? i : best), onSide[0] as number);
        this.coreAnchors.set(pick, core.bone);
        this.free[pick] = false;
      }
    }
    // Runs of free hull vertices between handle anchors.
    const apexSet = new Set(built.apexes.map((a) => a.index));
    const startHandle = Array.from({ length: H }, (_, i) => i).find((i) => !this.free[i]);
    if (startHandle === undefined) throw new Error("solver: the skin hull has no handle vertex");
    this.runs = [];
    let current: number[] = [];
    let anchor = startHandle;
    for (let k = 1; k <= H; k++) {
      const i = (startHandle + k) % H;
      if (this.free[i]) current.push(i);
      else {
        if (current.length) this.runs.push(makeRun(this.hullPts, current, anchor, i, apexSet.has(anchor), apexSet.has(i)));
        current = [];
        anchor = i;
      }
    }
    // Hinge runs: every vertex in one limb hinge patch (hinge path, not a Hermite bend).
    // A hinge patch with a declared width envelope is a limb hinge (constant-width limb either side);
    // a band without one (a paw or hand blob) keeps the Hermite bend.
    const bandJoint = new Map(built.preset.skin.regions.patches.filter((p) => p.side === "both" && p.envelope?.width).map((p) => [p.name, p.joint]));
    this.hinges = this.runs.map((run) => {
      const joints = run.ids.map((i) => (built.support[i]?.region.split("+") ?? []).map((r) => bandJoint.get(r)).find((j) => j !== undefined));
      const joint = joints[0];
      if (!joint || !joints.every((j) => j === joint)) return null;
      const P = this.pivot(joint);
      const A = this.hullPts[run.a] as Pt;
      const B = this.hullPts[run.b] as Pt;
      const fillet = HINGE_FILLET * 2 * built.preset.skin.topology.halfWidth;
      // The anchor edges are the limb's straight edges into the crease: the chord from each anchor to
      // the run vertex on the joint's row (nearest the pivot's chain s). The hull tangent at the anchor
      // stands in for it only while the core edge runs straight into the band; where the anchor sits on
      // a bulge (a far shoulder seen past the flank) the tangent line can pass through the pivot, and
      // the hinge path degenerates (bind detail of tens of px, no reachable fold target).
      const sv = built.skin.chainSV ?? [];
      const jointS = sv.length ? this.chainJointS(joint) : NaN;
      const atRow = Number.isFinite(jointS) ? run.ids.reduce((best, v) => (Math.abs((sv[v] as { s: number }).s - jointS) < Math.abs((sv[best] as { s: number }).s - jointS) ? v : best), run.ids[0] as number) : -1;
      const chord = (from: Pt, to: Pt, sign: 1 | -1, fallback: Pt): Pt => {
        const d: Pt = [(to[0] - from[0]) * sign, (to[1] - from[1]) * sign];
        const l = Math.hypot(d[0], d[1]);
        return l > 1e-6 ? [d[0] / l, d[1] / l] : fallback;
      };
      const C = atRow >= 0 ? (this.hullPts[atRow] as Pt) : null;
      run.tanA = C ? chord(A, C, 1, run.tanA) : run.tanA;
      run.tanB = C ? chord(C, B, 1, run.tanB) : run.tanB;
      const { path } = hingePath(A, B, run.tanA, run.tanB, P, fillet);
      const { points, tangents } = alongPath(path, run.params, true);
      // Bind detail against the bind hinge path (the zero pose reproduces the setup exactly).
      const detail = run.ids.map((v, k) => {
        const d: Pt = [(this.hullPts[v] as Pt)[0] - (points[k] as Pt)[0], (this.hullPts[v] as Pt)[1] - (points[k] as Pt)[1]];
        const u = tangents[k] as Pt;
        return [d[0] * u[0] + d[1] * u[1], -d[0] * u[1] + d[1] * u[0]] as Pt;
      });
      const squash = Math.max(0, ...built.preset.skin.regions.patches.filter((p) => p.joint === joint && p.envelope?.squash).map((p) => p.envelope?.squash as number));
      return { joint, fillet, detail, ...(squash > 0 ? { squash: [squash] } : {}) };
    });
    // Root-run shapes declared by their patch (`boundary`): crease (a run ending on a notch apex) and
    // cap (an outer run from a body anchor to a limb core anchor). Bind detail against the bind path.
    const W = 2 * built.preset.skin.topology.halfWidth;
    const declared = new Map(built.preset.skin.regions.patches.filter((p) => p.boundary && p.side !== "both").map((p) => [p.name, p]));
    const chainFrom = (joint: string) => new Set(built.preset.chain.bones.slice(Math.max(0, built.preset.chain.bones.indexOf(joint))));
    this.shapes = this.runs.map((run, ri) => {
      if (this.hinges[ri]) return null;
      const patch = run.ids.map((i) => (built.support[i]?.region.split("+") ?? []).map((r) => declared.get(r)).find((p) => p !== undefined)).find((p) => p !== undefined);
      if (!patch) return null;
      const H = skin.hull;
      if (patch.boundary === "crease") {
        const apexAtB = apexSet.has(run.b);
        if (!apexAtB && !apexSet.has(run.a)) return null;
        const K = apexAtB ? run.b : run.a;
        const B = apexAtB ? run.a : run.b;
        const other = apexAtB ? (run.b + 1) % H : (run.a - 1 + H) % H;
        const Kp = this.hullPts[K] as Pt;
        const f = unit([Kp[0] - (this.hullPts[other] as Pt)[0], Kp[1] - (this.hullPts[other] as Pt)[1]]);
        const d: Pt = apexAtB ? run.tanA : [-run.tanB[0], -run.tanB[1]];
        const rho = (patch.fillet ?? 0.15) * W;
        // The limb's side of its edge line: the hull interior's side of the walk (d runs against the walk when the apex is at a).
        const inside = Math.sign(signedArea(this.hullPts)) * (apexAtB ? 1 : -1);
        const bind = creasePath(this.hullPts[B] as Pt, d, Kp, inside, rho);
        const bindLength = polylineLength([this.hullPts[run.a] as Pt, ...run.ids.map((i) => this.hullPts[i] as Pt), this.hullPts[run.b] as Pt]);
        // Every crease vertex is the limb's: measured from the limb anchor.
        const homeA = run.ids.map(() => apexAtB);
        const shape: RunShape = { kind: "crease", apexAtB, K, B, f, d, inside, rho, bindTurn: bind.turn, detail: [], bindLength, homeA, ...(patch.creaseArc ? { arc: { joint: patch.joint, ramp: patch.creaseArc.ramp, spread: patch.creaseArc.spread, spreadRamp: patch.creaseArc.spreadRamp ?? patch.creaseArc.ramp, linear: patch.creaseArc.linear } } : {}) };
        const path = apexAtB ? bind.segs : reverseSegs(bind.segs);
        shape.detail = runDetail(run, path, this.hullPts, homeParams(run, bindLength, segsLength(path), homeA));
        return shape;
      }
      // cap: body vertices (no weight on the joint's chain) from the body anchor, then limb vertices.
      const limb = chainFrom(patch.joint);
      const limbShare = (i: number) => (skin.weights[i] as [number, number][]).reduce((sum, [b, w]) => sum + (limb.has(skin.bones[b] as string) ? w : 0), 0);
      const walk = [run.a, ...run.ids, run.b];
      const isLimb = walk.map((i, k) => (k === walk.length - 1 && this.coreAnchors.has(i)) || limbShare(i) >= 0.5);
      const split = isLimb.indexOf(true);
      if (split <= 0 || isLimb.slice(split).some((x) => !x) || limbShare(run.a) > 1e-9) return null;
      this.poser.pose({});
      const P0 = this.pivot(patch.joint);
      const ang = (i: number) => Math.atan2((this.hullPts[i] as Pt)[1] - P0[1], (this.hullPts[i] as Pt)[0] - P0[0]);
      // Unwrapped bind angles along the walk.
      const angles: number[] = [];
      for (const i of walk) {
        let a = ang(i);
        const prev = angles[angles.length - 1];
        if (prev !== undefined) a += 2 * Math.PI * Math.round((prev - a) / (2 * Math.PI));
        angles.push(a);
      }
      const sense = Math.sign((angles[angles.length - 1] as number) - (angles[0] as number)) || 1;
      const bindLength = polylineLength(walk.map((i) => this.hullPts[i] as Pt));
      const body = walk.slice(0, split);
      const shape: RunShape = { kind: "cap", joint: patch.joint, body, arm: walk.slice(split), sense, refBody: angles.slice(0, split), refArm: angles.slice(split), detail: [], bindLength, homeA: run.ids.map((i) => body.includes(i)), ...(patch.arc ? { arc: patch.arc } : {}) };
      const env = capEnvelope(P0, shape.body.map((i) => this.hullPts[i] as Pt), shape.arm.map((i) => this.hullPts[i] as Pt), sense, shape.refBody, shape.refArm, CAP_SMOOTH, shape.arc);
      if (!env) return null;
      shape.detail = runDetail(run, env, this.hullPts, homeParams(run, bindLength, polylineLength(env), shape.homeA));
      return shape;
    });
    // Riding apexes: anchors with a permitted motion move along their body branch (up the flank).
    this.rides = new Map();
    for (const a of built.anchors) {
      if (!(a.permittedMotion > 0)) continue;
      const apex = built.apexes.findIndex((x) => x.index === a.index);
      const patch = built.preset.skin.regions.patches.find((p) => p.from && !Array.isArray(p.from) && (p.from as { apex: number }).apex === apex);
      if (!patch) continue;
      const H = skin.hull;
      const nb = [(a.index + 1) % H, (a.index - 1 + H) % H].find((j) => !this.free[j] && !this.coreAnchors.has(j));
      if (nb === undefined) continue;
      const Kp = this.hullPts[a.index] as Pt;
      const lim = built.preset.bones.find((b) => b.name === patch.joint)?.limits as [number, number] | undefined;
      const range = (patch.apexRide as [number, number] | undefined) ?? [0, lim?.[1] ?? 90];
      const dir = unit([Kp[0] - (this.hullPts[nb] as Pt)[0], Kp[1] - (this.hullPts[nb] as Pt)[1]]);
      // Where the bind limb edge line meets the body line (the ride is measured from it: zero at setup).
      const crease = this.shapes.find((sh): sh is Extract<RunShape, { kind: "crease" }> => sh?.kind === "crease" && sh.K === a.index);
      let bindT = 0;
      if (crease) {
        const B = this.hullPts[crease.B] as Pt;
        const den = crease.d[0] * dir[1] - crease.d[1] * dir[0];
        bindT = Math.abs(den) > 1e-9 ? ((Kp[0] - B[0]) * crease.d[1] - (Kp[1] - B[1]) * crease.d[0]) / den : 0;
      }
      this.rides.set(a.index, { joint: patch.joint, dir, amount: a.permittedMotion, range, bindT, anchor: a });
    }
    // Joint regions: triangles with at least two vertices in a patch of the joint.
    const joints = [...new Set(built.patches.map((p) => p.joint))];
    this.regions = joints.map((joint) => {
      const names = new Set(built.patches.filter((p) => p.joint === joint).map((p) => p.name));
      // A hinge region excludes vertices shared with a root (inner/outer) patch: on a short limb the
      // root patch reaches the hinge band, and the root's skin opening is the root region's area.
      const hinge = built.preset.skin.regions.patches.some((p) => p.joint === joint && p.side === "both");
      const rootNames = new Set(built.preset.skin.regions.patches.filter((p) => p.side !== "both").map((p) => p.name));
      const inJoint = (i: number) => {
        const rs = built.support[i]?.region.split("+") ?? [];
        return rs.some((r) => names.has(r)) && !(hinge && rs.some((r) => rootNames.has(r)));
      };
      const triangles: number[] = [];
      for (let t = 0; t < skin.triangles.length / 3; t++) {
        let n = 0;
        for (let k = 0; k < 3; k++) if (inJoint(skin.triangles[t * 3 + k] as number)) n++;
        if (n >= 2) triangles.push(t);
      }
      // Declared aggregate area band: the widest of the joint's patches (default +-areaTolerance).
      const declared = built.preset.skin.regions.patches.filter((p) => p.joint === joint && p.envelope?.area).map((p) => p.envelope?.area as [number, number]);
      const band: [number, number] = declared.length ? [Math.min(...declared.map((d) => d[0])), Math.max(...declared.map((d) => d[1]))] : [1 - this.areaTolerance, 1 + this.areaTolerance];
      return { name: [...names].join("+"), joint, triangles, band };
    });
    // Edge pushes: chain side x trapezoid along the chain, every hull vertex (hinge runs, core anchors, distal bands).
    this.pushes = built.preset.skin.regions.patches.flatMap((p) => {
      if (!p.push) return [];
      const sv = skin.chainSV ?? [];
      const sign = p.push.side === "+" ? 1 : -1;
      const [s0, s1, s2, s3] = p.push.s;
      const f = this.hullPts.map((_, i) => {
        const c = sv[i] as { s: number; v: number } | undefined;
        if (!c || c.v * sign <= 0) return 0;
        return smoothstep(s0, s1, c.s) * (1 - smoothstep(s2, s3, c.s));
      });
      return [{ joint: p.joint, keys: p.push.keys as [number, number][], f }];
    });
    {
      let votes = 0;
      for (let i = 0; i < H; i++) {
        const a = this.hullPts[(i - 1 + H) % H] as Pt;
        const b = this.hullPts[(i + 1) % H] as Pt;
        const t = unit([b[0] - a[0], b[1] - a[1]]);
        const q = this.hullPts[i] as Pt;
        votes += pointInPolygon([q[0] + t[1] * 0.5, q[1] - t[0] * 0.5], this.hullPts) ? -1 : 1;
      }
      this.outSign = votes >= 0 ? 1 : -1;
    }
    // Squash floors per run edge: the declared floor inside the joint region; an edge whose triangle
    // lies outside it (the band's rigid ends) keeps the same margin over the default skin allowance.
    const scaleOut = KIND_ALLOWANCES.default.minStretch / KIND_ALLOWANCES.joint.minStretch;
    this.hinges.forEach((hinge, ri) => {
      if (!hinge?.squash) return;
      const run = this.runs[ri] as BoundaryRun;
      const region = new Set(this.regions.find((r) => r.joint === hinge.joint)?.triangles ?? []);
      const chain = [run.a, ...run.ids, run.b];
      const floor = hinge.squash[0] as number;
      hinge.squash = chain.slice(1).map((v, k) => {
        const u = chain[k] as number;
        let inside = false;
        for (let t = 0; t < skin.triangles.length / 3 && !inside; t++) {
          const tri = [skin.triangles[t * 3], skin.triangles[t * 3 + 1], skin.triangles[t * 3 + 2]];
          if (tri.includes(u) && tri.includes(v)) inside = region.has(t);
        }
        return inside ? floor : floor * scaleOut;
      });
    });
    const springMask = skin.points.map((_, i) => i < H && this.free[i] === true);
    this.solver = new InteriorSolver(skin.points, skin.triangles, this.free, springMask, {
      floor: this.floor,
      margin: this.margin,
      spring: 400,
      regions: this.regions,
      areaTolerance: this.areaTolerance
    });
  }

  /** Chain arc length s of a chain joint at bind (the chain's bone heads, canvas px); NaN off the chain. */
  private chainJointS(bone: string): number {
    const chain = this.built.preset.chain.bones;
    const k = chain.indexOf(bone);
    if (k < 0) return NaN;
    let s = 0;
    for (let j = 0; j < k; j++) {
      const a = this.built.preset.bones.find((b) => b.name === chain[j])?.at;
      const b = this.built.preset.bones.find((x) => x.name === chain[j + 1])?.at;
      if (!a || !b) return NaN;
      s += dist(a as Pt, b as Pt);
    }
    return s;
  }

  /** Posed world pivot of a bone, canvas px (the poser's current pose). */
  private pivot(bone: string): Pt {
    const w = this.poser.skeleton.getBone(bone).world;
    return [w.x + this.poser.doc.canvas.originX, w.y + this.poser.doc.canvas.originY];
  }

  /** Permitted apex motion at the poser's current pose (girdle-coupled when declared). */
  private allowance(anchor: BuiltAnchor): number {
    const { originX, originY } = this.poser.doc.canvas;
    return apexAllowance(anchor, (b) => this.poser.skeleton.getBone(b).world, (b) => this.setupWorld.get(b) as Affine, [originX, originY]);
  }

  private linear(bone: string): [number, number, number, number] {
    const s = this.setupWorld.get(bone) as { a: number; b: number; c: number; d: number };
    const w = this.poser.skeleton.getBone(bone).world;
    const det = s.a * s.d - s.b * s.c;
    // W * S^-1
    const i00 = s.d / det;
    const i01 = -s.b / det;
    const i10 = -s.c / det;
    const i11 = s.a / det;
    return [w.a * i00 + w.b * i10, w.a * i01 + w.b * i11, w.c * i00 + w.d * i10, w.c * i01 + w.d * i11];
  }

  private rigid(bone: string, p: Pt): Pt {
    const s = this.setupWorld.get(bone) as { a: number; b: number; c: number; d: number; x: number; y: number };
    const w = this.poser.skeleton.getBone(bone).world;
    const { originX, originY } = this.poser.doc.canvas;
    const x = p[0] - originX - s.x;
    const y = p[1] - originY - s.y;
    const det = s.a * s.d - s.b * s.c;
    const lx = (s.d * x - s.b * y) / det;
    const ly = (-s.c * x + s.a * y) / det;
    return [w.a * lx + w.b * ly + w.x + originX, w.c * lx + w.d * ly + w.y + originY];
  }

  /** Handle positions (LBS without correctives; core anchors rigid) and boundary spring targets at a pose. */
  frame(pose: Pose): SolveFrame & { lobes: number; clamped: number } {
    const skin = this.built.skin;
    // Cap runs: the body side posed without the chain (the limb at its setup rotation).
    let bodyOnly: Pt[] | null = null;
    if (this.shapes.some((sh) => sh?.kind === "cap")) {
      const chain = new Set(this.built.preset.chain.bones);
      this.poser.pose(Object.fromEntries(Object.entries(pose).filter(([b]) => !chain.has(b))));
      bodyOnly = this.poser.vertices(skin);
    }
    this.poser.pose(pose);
    const base = this.poser.vertices(skin);
    for (const [v, bone] of this.coreAnchors) base[v] = this.rigid(bone, skin.points[v] as Pt);
    const lin = (v: number): [number, number, number, number] => {
      const bone = this.coreAnchors.get(v);
      if (bone) return this.linear(bone);
      const out: [number, number, number, number] = [0, 0, 0, 0];
      for (const [b, w] of skin.weights[v] as [number, number][]) {
        const l = this.linear(skin.bones[b] as string);
        for (let k = 0; k < 4; k++) out[k] = (out[k] as number) + w * (l[k] as number);
      }
      return out;
    };
    // Riding apexes: with a crease run, the apex rides up its body line to where the limb edge line
    // meets it (the crease follows the limb), smoothly capped at the permitted motion, which grows
    // with the girdle's elevation (apexGirdle: a shrug lifts the limb and the crease rides up with
    // it); otherwise it ramps over the declared driver range. Gated by the joint's ramp near rest.
    const unridden = new Map<number, Pt>();
    for (const [v, ride] of this.rides) {
      const l = this.linear(this.built.preset.base);
      const dir = unit([l[0] * ride.dir[0] + l[1] * ride.dir[1], l[2] * ride.dir[0] + l[3] * ride.dir[1]]);
      const cap = this.allowance(ride.anchor);
      let move: number;
      const crease = this.shapes.find((sh): sh is Extract<RunShape, { kind: "crease" }> => sh?.kind === "crease" && sh.K === v);
      if (crease) {
        const lb = lin(crease.B);
        const d = unit([lb[0] * crease.d[0] + lb[1] * crease.d[1], lb[2] * crease.d[0] + lb[3] * crease.d[1]]);
        const B = base[crease.B] as Pt;
        const K = base[v] as Pt;
        // K + t dir on the line through B along d.
        const den = d[0] * dir[1] - d[1] * dir[0];
        const t = Math.abs(den) > 1e-9 ? ((K[0] - B[0]) * d[1] - (K[1] - B[1]) * d[0]) / den : 0;
        // Gated by the joint's own ramp near rest, where the two lines are nearly parallel and the
        // meeting point moves fast; the driver ramp alone is the floor.
        const [r0, r1] = ride.range;
        const a = pose[ride.joint] ?? 0;
        const ramp = r1 > r0 ? smooth01((a - r0) / (r1 - r0)) : 0;
        const gate = smooth01((a - r0) / RIDE_GATE);
        // Smooth maximum that never exceeds the larger (both stay within the allowance).
        move = softMaxBelow((ride.amount - RIDE_MARGIN) * ramp, gate * (cap - RIDE_MARGIN) * smooth01((t - ride.bindT) / (RIDE_LEAD * cap)), RIDE_SOFT);
      } else {
        const [r0, r1] = ride.range;
        const a = pose[ride.joint] ?? 0;
        move = ride.amount * (r1 > r0 ? smooth01((a - r0) / (r1 - r0)) : 0);
      }
      unridden.set(v, base[v] as Pt);
      base[v] = [(base[v] as Pt)[0] + dir[0] * move, (base[v] as Pt)[1] + dir[1] * move];
    }
    // Strap rides: one curve from the strap/neck side onto the raised limb's top edge.
    const throughs = new Map<number, { curve: Pt[]; w: number }>();
    for (let ri = 0; ri < this.runs.length; ri++) {
      const shape = this.shapes[ri];
      const ride = shape?.kind === "cap" ? shape.arc?.ride : undefined;
      if (shape?.kind !== "cap" || !ride || !shape.arc) continue;
      const wr = smooth01(((pose[shape.joint] ?? 0) - ride.ramp[0]) / (ride.ramp[1] - ride.ramp[0] || 1));
      if (!(wr > 0)) continue;
      const run = this.runs[ri] as BoundaryRun;
      const H = skin.hull;
      const dir = run.ids[0] === (run.a + 1) % H ? 1 : -1;
      // Neck-side stretch (bind length `neck`), walking from the corner away from the run.
      const neckIds: number[] = [];
      for (let s0 = 0, k = 1; s0 < (shape.arc.neck ?? 40) && k < H / 4; k++) {
        const prev = (((run.a - dir * (k - 1)) % H) + H) % H;
        const v = (((run.a - dir * k) % H) + H) % H;
        s0 += dist(skin.points[prev] as Pt, skin.points[v] as Pt);
        neckIds.push(v);
      }
      const N = neckIds[neckIds.length - 1] as number;
      const Nout = (((N - dir) % H) + H) % H;
      const P = this.pivot(shape.joint);
      const armPts = shape.arm.map((i) => (i === run.b ? (base[i] as Pt) : this.rigid(shape.joint, skin.points[i] as Pt)));
      let acc = 0;
      let kb = 1;
      while (kb < armPts.length - 1 && acc + dist(armPts[kb - 1] as Pt, armPts[kb] as Pt) < ride.to) acc += dist(armPts[kb - 1] as Pt, armPts[kb] as Pt), kb++;
      const NP = base[N] as Pt;
      const BP = armPts[kb] as Pt;
      const tN = unit([NP[0] - (base[Nout] as Pt)[0], NP[1] - (base[Nout] as Pt)[1]]);
      const tB = unit([(armPts[Math.min(armPts.length - 1, kb + 1)] as Pt)[0] - (armPts[kb - 1] as Pt)[0], (armPts[Math.min(armPts.length - 1, kb + 1)] as Pt)[1] - (armPts[kb - 1] as Pt)[1]]);
      const L = dist(NP, BP) * ride.tension;
      const curve: Pt[] = [];
      for (let k = 0; k <= 64; k++) {
        const t = k / 64;
        const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
        const h10 = t ** 3 - 2 * t ** 2 + t;
        const h01 = -2 * t ** 3 + 3 * t ** 2;
        const h11 = t ** 3 - t ** 2;
        curve.push([h00 * NP[0] + h10 * L * tN[0] + h01 * BP[0] + h11 * L * tB[0], h00 * NP[1] + h10 * L * tN[1] + h01 * BP[1] + h11 * L * tB[1]]);
      }
      // Closest point of the curve (the neck side runs against the cap's polar sweep, so no polar map here).
      const onCurve = (q: Pt): { at: Pt; k: number } => {
        let best = { at: curve[0] as Pt, k: 0, d: Infinity };
        for (let k = 1; k < curve.length; k++) {
          const c0 = curve[k - 1] as Pt;
          const c1 = curve[k] as Pt;
          const ex = c1[0] - c0[0];
          const ey = c1[1] - c0[1];
          const u = Math.min(1, Math.max(0, ((q[0] - c0[0]) * ex + (q[1] - c0[1]) * ey) / (ex * ex + ey * ey || 1)));
          const at: Pt = [c0[0] + ex * u, c0[1] + ey * u];
          const d = dist(at, q);
          if (d < best.d) best = { at, k, d };
        }
        return best;
      };
      const moves = new Map<number, Pt>();
      for (const v of [run.a, ...neckIds.slice(0, -1)]) {
        if (v !== run.a && this.free[v]) continue;
        const q = base[v] as Pt;
        const c = onCurve(q).at;
        moves.set(v, [(c[0] - q[0]) * wr, (c[1] - q[1]) * wr]);
      }
      const big = Math.max(0, ...[...moves.values()].map((d) => Math.hypot(d[0], d[1])));
      const scale = big > ride.max ? ride.max / big : 1;
      const dA = moves.get(run.a) ?? [0, 0];
      const bindA = skin.points[run.a] as Pt;
      const fixedNames = new Set(this.built.preset.skin.regions.fixed.map((f) => f.name));
      const shift = (arr: Pt[], i: number, d: Pt, f: number) => (arr[i] = [(arr[i] as Pt)[0] + d[0] * scale * f, (arr[i] as Pt)[1] + d[1] * scale * f]);
      for (const [v, d] of moves) {
        shift(base, v, d, 1);
        if (bodyOnly) shift(bodyOnly, v, d, 1);
      }
      skin.points.forEach((q, i) => {
        if (i < H || this.free[i] || this.coreAnchors.has(i) || fixedNames.has(this.built.support[i]?.region ?? "")) return;
        const f = 1 - smooth01(dist(q, bindA) / ride.radius);
        if (f > 0) shift(base, i, dA, f);
      });
      // The cap run follows the curve from the (moved) corner on.
      const A1 = base[run.a] as Pt;
      throughs.set(ri, { curve: [A1, ...curve.slice(onCurve(A1).k)], w: wr });
    }
    const springs: (Pt | null)[] = skin.points.map(() => null);
    let lobes = 0;
    let clamped = 0;
    for (const [ri, run] of this.runs.entries()) {
      const H = this.built.skin.hull;
      const hinge = this.hinges[ri];
      if (hinge) {
        const map = (l: [number, number, number, number], p: Pt): Pt => unit([l[0] * p[0] + l[1] * p[1], l[2] * p[0] + l[3] * p[1]]);
        const { path } = hingePath(base[run.a] as Pt, base[run.b] as Pt, map(lin(run.a), run.tanA), map(lin(run.b), run.tanB), this.pivot(hinge.joint), hinge.fillet);
        const { points, tangents } = alongPath(path, run.params, true);
        run.ids.forEach((v, k) => {
          const [al, ac] = hinge.detail[k] as Pt;
          const u = tangents[k] as Pt;
          const c = points[k] as Pt;
          springs[v] = [c[0] + al * u[0] - ac * u[1], c[1] + al * u[1] + ac * u[0]];
        });
        if (hinge.squash) {
          const chain = [run.a, ...run.ids, run.b];
          const posed = chain.map((v, k) => (k === 0 || k === chain.length - 1 ? (base[v] as Pt) : (springs[v] as Pt)));
          const spread = spreadSquash(posed, chain.map((v) => skin.points[v] as Pt), hinge.squash as number[]);
          if (spread) run.ids.forEach((v, k) => (springs[v] = spread[k + 1] as Pt));
        }
        continue;
      }
      const shape = this.shapes[ri];
      if (shape?.kind === "crease") {
        const map = (l: [number, number, number, number], p: Pt): Pt => unit([l[0] * p[0] + l[1] * p[1], l[2] * p[0] + l[3] * p[1]]);
        const c = creasePath(base[shape.B] as Pt, map(lin(shape.B), shape.d), base[shape.K] as Pt, shape.inside, shape.rho);
        // C1 in the turn (smoothstep of |delta|: zero slope at the bind turn and where it is gone).
        const fade = 1 - smooth01(Math.abs(c.turn - shape.bindTurn) / CREASE_DETAIL_FADE);
        const cpath = shape.apexAtB ? c.segs : reverseSegs(c.segs);
        const crease = placeOnPath(cpath, homeParams(run, shape.bindLength, segsLength(cpath), shape.homeA), shape.detail, fade);
        // Opening crease curve (patch `creaseArc`, underside crimp): ramped in over the
        // joint's rotation, the run becomes one cubic tangent to the limb edge at B and to the web
        // at the apex (G1 into the hinge band, no fillet corner); with `spread` its vertices move from their
        // home spacing to even arc-length fractions, so no long chord runs into the apex.
        const arcRamp = (r: [number, number]) => {
          const t = ((pose[(shape.arc as { joint: string }).joint] ?? 0) - r[0]) / (r[1] - r[0] || 1);
          return (shape.arc as { linear: boolean }).linear ? softRamp01(t) : smooth01(t);
        };
        const wa = shape.arc ? arcRamp(shape.arc.ramp) : 0;
        if (shape.arc && wa > 0) {
          const last = c.segs[c.segs.length - 1] as Seg;
          const e = last.kind === "line" && dist(last.a, last.b) > 1e-9 ? unit([last.b[0] - last.a[0], last.b[1] - last.a[1]]) : map(lin(shape.B), shape.d);
          const ca = creaseCurvePath(base[shape.B] as Pt, map(lin(shape.B), shape.d), base[shape.K] as Pt, e, shape.inside);
          const apath = shape.apexAtB ? ca.path : [...ca.path].reverse();
          const home = homeParams(run, shape.bindLength, polylineLength(apath), shape.homeA);
          const ws = arcRamp(shape.arc.spreadRamp) * shape.arc.spread;
          const params = home.map((h, k) => h + ((run.params[k] as number) - h) * ws);
          const afade = 1 - smooth01(Math.abs(ca.turn - shape.bindTurn) / CREASE_DETAIL_FADE);
          placeOnPath(apath, params, shape.detail, afade).forEach((q, k) => {
            const p = crease[k] as Pt;
            crease[k] = [p[0] + (q[0] - p[0]) * wa, p[1] + (q[1] - p[1]) * wa];
          });
        }
        // Where the limb closes on the body (the apex on or above the limb edge line) the run keeps
        // the Hermite bend with its notch guard; the crease blends in over CREASE_BLEND px.
        // Measured from the apex before its ride (the ride follows the limb edge and would close g
        // again: a non-monotonic blend), so the blend grows monotonically as the limb opens.
        // With a girdle coupling the gap is also measured without the girdle's carry of the limb:
        // the blend then follows the limb's own opening (the raise), not the shrug's translation.
        const K0 = unridden.get(shape.K);
        const ride = this.rides.get(shape.K);
        const { originX, originY } = this.poser.doc.canvas;
        const carry = ride ? girdleCarry(ride.anchor, (b) => this.poser.skeleton.getBone(b).world, (b) => this.setupWorld.get(b) as Affine, [originX, originY]).shift : ([0, 0] as Pt);
        const Bb: Pt = [(base[shape.B] as Pt)[0] - carry[0], (base[shape.B] as Pt)[1] - carry[1]];
        const g = K0 ? creaseGap(Bb, map(lin(shape.B), shape.d), K0, shape.inside) : c.g;
        const w = smooth01(g / CREASE_BLEND);
        if (w < 1) {
          const h = runTargets(run, base[run.a] as Pt, base[run.b] as Pt, lin(run.a), lin(run.b), run.slitA ? (base[(run.slitA.other + H) % H] as Pt) : undefined, run.slitB ? (base[run.slitB.other % H] as Pt) : undefined);
          if (h.lobe) lobes++;
          crease.forEach((p, k) => {
            const q = h.points[k] as Pt;
            crease[k] = [q[0] + (p[0] - q[0]) * w, q[1] + (p[1] - q[1]) * w];
          });
        }
        crease.forEach((p, k) => (springs[run.ids[k] as number] = p));
        continue;
      }
      if (shape?.kind === "cap") {
        const P = this.pivot(shape.joint);
        const l = this.linear(shape.joint);
        const alpha = Math.atan2(l[2], l[0]);
        const body = shape.body.map((i) => (i === run.a ? (base[i] as Pt) : ((bodyOnly as Pt[])[i] as Pt)));
        const arm = shape.arm.map((i) => (i === run.b ? (base[i] as Pt) : this.rigid(shape.joint, skin.points[i] as Pt)));
        const arcW = shape.arc ? capArcWeight(shape.arc, pose[shape.joint] ?? 0) : 0;
        const through = throughs.get(ri);
        const env = capEnvelope(P, body, arm, shape.sense, shape.refBody, shape.refArm.map((a) => a + alpha), CAP_SMOOTH, shape.arc, arcW, through?.curve, through?.w ?? 0);
        if (env) {
          // Under a shoulder arc the bind detail (the rest outline's own notch at the strap) fades out with the arc's weight.
          placeOnPath(env, homeParams(run, shape.bindLength, polylineLength(env), shape.homeA), shape.detail, 1 - arcW).forEach((p, k) => (springs[run.ids[k] as number] = p));
          continue;
        }
        lobes++;
      }
      const r = runTargets(run, base[run.a] as Pt, base[run.b] as Pt, lin(run.a), lin(run.b), run.slitA ? (base[(run.slitA.other + H) % H] as Pt) : undefined, run.slitB ? (base[run.slitB.other % H] as Pt) : undefined);
      if (r.lobe) lobes++;
      if (r.clamped) clamped++;
      run.ids.forEach((v, k) => (springs[v] = r.points[k] as Pt));
    }
    // Angle-keyed edge pushes: off the limb along the posed hull's outward normal (free vertices'
    // spring targets, handle vertices' positions), so the corrective bakes the moved edge.
    for (const push of this.pushes) {
      const amount = keyed(push.keys, pose[push.joint] ?? 0);
      if (amount === 0) continue;
      const H = skin.hull;
      const moves: [number, Pt][] = [];
      for (let i = 0; i < H; i++) {
        const w = amount * (push.f[i] as number);
        if (w === 0) continue;
        const a = base[(i - 1 + H) % H] as Pt;
        const b = base[(i + 1) % H] as Pt;
        const t = unit([b[0] - a[0], b[1] - a[1]]);
        moves.push([i, [this.outSign * t[1] * w, -this.outSign * t[0] * w]]);
      }
      for (const [i, d] of moves) {
        const sp = springs[i];
        if (sp) springs[i] = [sp[0] + d[0], sp[1] + d[1]];
        else base[i] = [(base[i] as Pt)[0] + d[0], (base[i] as Pt)[1] + d[1]];
      }
    }
    return { base, springs, lobes, clamped };
  }

  /** Straight-line interpolation between two poses. */
  private static lerp(a: Pose, b: Pose, u: number): Pose {
    const out: Pose = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * u;
    return out;
  }

  static key(pose: Pose): string {
    return Object.entries(pose)
      .filter(([, v]) => Math.abs(v) > 1e-9)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${Number(v.toFixed(4))}`)
      .join(",");
  }

  private finish(pose: Pose, state: SolveState, ok: boolean, reason: string): PoseTarget {
    const f = this.frame(pose);
    const r = this.solver.minRatio(state.x);
    const springError = this.solver.springError(state.x, f);
    const areas = this.solver.regionAreas(state.x);
    const reasons: string[] = reason ? [reason] : [];
    if (r.min < this.floor) reasons.push(`det ${r.min.toFixed(3)} < ${this.floor} at t${r.at}`);
    if (springError > this.silhouette) reasons.push(`boundary misses its curve by ${springError.toFixed(2)} px (> ${this.silhouette.toFixed(2)})`);
    areas.forEach((a, k) => {
      const r = this.regions[k] as { joint: string; band: [number, number] };
      if (a < r.band[0] - 1e-9 || a > r.band[1] + 1e-9) reasons.push(`joint '${r.joint}' area ${a.toFixed(3)} outside [${r.band.join(", ")}]`);
    });
    if (f.lobes) reasons.push(`${f.lobes} boundary curve(s) still reverse along their chord`);
    return { pose, ok: ok && reasons.length === 0, reason: reasons.join("; "), x: state.x, curve: f.springs, minRatio: r.min, springError, areas, lobes: f.lobes, clamped: f.clamped, ...{ scale: state.scale } } as PoseTarget;
  }

  private states = new Map<string, SolveState>();

  /** The target at `pose` reached from `from` (a solved pose) by straight-line continuation. */
  private reach(from: Pose, to: Pose): PoseTarget {
    const key = SurfaceSolver.key(to);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const fromKey = SurfaceSolver.key(from);
    const known = this.states.get(fromKey);
    if (!known && fromKey !== "") return this.reach({}, to);
    const start = known ?? { x: this.built.skin.points.map((p) => [p[0], p[1]] as Pt), scale: this.regions.map(() => 1) };
    const span = Math.max(0, ...Object.keys({ ...from, ...to }).map((k) => Math.abs((to[k] ?? 0) - (from[k] ?? 0))));
    const steps = Math.max(1, Math.ceil(span / this.stepDegrees));
    const res = this.solver.continuation(start, (u) => this.frame(SurfaceSolver.lerp(from, to, u)), { steps });
    const out = this.finish(to, res.state, res.ok, res.reason);
    if (res.ok) this.states.set(key, res.state);
    this.cache.set(key, out);
    return out;
  }

  /** Canonical target of a pose: every driver ramped together from the setup pose (one continuation). */
  solve(pose: Pose): PoseTarget {
    return this.reach({}, pose);
  }

  /** Targets along a sequence of poses (a sweep): the first canonically, then continuation frame to frame. */
  along(poses: Pose[]): PoseTarget[] {
    const out: PoseTarget[] = [];
    poses.forEach((pose, i) => {
      const key = SurfaceSolver.key(pose);
      const hit = this.cache.get(key);
      if (hit) out.push(hit);
      else if (i === 0) out.push(this.solve(pose));
      else out.push(this.reach(poses[i - 1] as Pose, pose));
    });
    return out;
  }

  /** Free hull vertices: distance of runtime positions `x` to the target's curve points (correspondence) and to the target hull polyline (shape). */
  silhouetteError(x: readonly Pt[], target: PoseTarget): { vertex: number; shape: number; at: number } {
    const H = this.built.skin.hull;
    const hull = target.x.slice(0, H);
    let vertex = 0;
    let shape = 0;
    let at = -1;
    for (let i = 0; i < H; i++) {
      if (!target.curve[i]) continue;
      const v = dist(x[i] as Pt, target.x[i] as Pt);
      vertex = Math.max(vertex, v);
      const s = distanceToPolyline(x[i] as Pt, hull, true);
      if (s > shape) {
        shape = s;
        at = i;
      }
    }
    return { vertex, shape, at };
  }
}

/** Posed boundary loops of a triangle set: number of crossings between non-adjacent boundary edges (self-intersection of the patch). */
export function patchSelfIntersections(x: readonly Pt[], triangles: readonly number[], tris: readonly number[]): number {
  const uses = new Map<string, [number, number, number]>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t * 3 + k] as number;
      const b = triangles[t * 3 + ((k + 1) % 3)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const u = uses.get(key);
      if (u) u[2]++;
      else uses.set(key, [a, b, 1]);
    }
  }
  const edges = [...uses.values()].filter((e) => e[2] === 1);
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i] as [number, number, number];
    for (let j = i + 1; j < edges.length; j++) {
      const [c, d] = edges[j] as [number, number, number];
      if (a === c || a === d || b === c || b === d) continue;
      const hit = segmentCross(x[a] as Pt, x[b] as Pt, x[c] as Pt, x[d] as Pt);
      if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9 && hit.u > 1e-9 && hit.u < 1 - 1e-9) crossings++;
    }
  }
  return crossings;
}
