/*
 * Atlas Animator: original implementation.
 *
 * Pivot fit (checkpoint 1, addendum): the rig's chain pivots and bone lengths fitted to
 * pose reference drawings. Pure data in, data out: the `fit` blocks of a `<preset>.pose-refs.json`
 * (canvas px, already aligned to the rest drawing) and its `restFit`.
 *
 * - Root pivot: a least-squares circle fit whose centre also minimises the distance to every drawn
 *   upper-limb axis (straight-limb references draw an axis through the pivot; bent ones mark the
 *   next pivot, which lies on the circle). Lines and circle points are fitted together
 *   (Gauss-Newton on centre and radius).
 * - Next pivot: the distal end points (wrists) of every fitted reference in its own proximal-bone
 *   frame (origin the root pivot, x along that reference's proximal bone), circle-fitted: the centre
 *   is the next pivot in the bone frame, the radius the distal bone length.
 * - Drawn driver values per reference (proximal rotation from the rest axis, distal bend), and the
 *   drawn extremes per driver (the input to the limit fit).
 * - `migrateChain` re-expresses every chain-relative coordinate of a preset (s/v points, rows, cores,
 *   joint bands) for new pivots so the authored canvas geometry is unchanged.
 */
import { ChainFrame } from "./geometry.js";

export type Pt = [number, number];
export interface AxisLine { at: Pt; dir: Pt }
export interface CircleFit {
  center: Pt;
  /** Null when only lines were fitted. */
  radius: number | null;
  pointResiduals: number[];
  lineResiduals: number[];
  pointRms: number;
  lineRms: number;
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => [a[0] / len(a), a[1] / len(a)];
const deg = (a: Pt) => (Math.atan2(a[1], a[0]) * 180) / Math.PI;
const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const rms = (r: number[]) => (r.length ? Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length) : 0);

/** Solves the small symmetric system A x = b (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[p] as number[])[c] as number)) p = r;
    [M[c], M[p]] = [M[p] as number[], M[c] as number[]];
    const piv = (M[c] as number[])[c] as number;
    if (Math.abs(piv) < 1e-12) throw new Error("pivot fit: singular system (too few or degenerate references)");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = ((M[r] as number[])[c] as number) / piv;
      for (let k = c; k <= n; k++) (M[r] as number[])[k] = ((M[r] as number[])[k] as number) - f * ((M[c] as number[])[k] as number);
    }
  }
  return M.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** Least-squares circle through `points` whose centre also lies as close as possible to every line. */
export function fitCircle(points: readonly Pt[], lines: readonly AxisLine[] = []): CircleFit {
  const withR = points.length > 0;
  if (points.length + lines.length < (withR ? 3 : 2)) throw new Error("pivot fit: need at least 3 constraints");
  // Initial centre: the least-squares intersection of the lines, else the algebraic (Kasa) fit.
  let c: Pt;
  if (lines.length >= 2) {
    const A = [[0, 0], [0, 0]];
    const b = [0, 0];
    for (const l of lines) {
      const d = unit(l.dir);
      const m = [[1 - d[0] * d[0], -d[0] * d[1]], [-d[0] * d[1], 1 - d[1] * d[1]]];
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) (A[i] as number[])[j] = ((A[i] as number[])[j] as number) + ((m[i] as number[])[j] as number);
        b[i] = (b[i] as number) + ((m[i] as number[])[0] as number) * l.at[0] + ((m[i] as number[])[1] as number) * l.at[1];
      }
    }
    const x = solve(A, b);
    c = [x[0] as number, x[1] as number];
  } else {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    for (const p of points) {
      const row = [2 * p[0], 2 * p[1], 1];
      const rhs = p[0] * p[0] + p[1] * p[1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) (A[i] as number[])[j] = ((A[i] as number[])[j] as number) + (row[i] as number) * (row[j] as number);
        b[i] = (b[i] as number) + (row[i] as number) * rhs;
      }
    }
    const x = solve(A, b);
    c = [x[0] as number, x[1] as number];
  }
  let r = withR ? points.reduce((s, p) => s + len(sub(p, c)), 0) / points.length : 0;
  const n = withR ? 3 : 2;
  for (let it = 0; it < 100; it++) {
    const JtJ = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const Jtr = new Array<number>(n).fill(0);
    const add = (J: number[], res: number) => {
      for (let i = 0; i < n; i++) {
        Jtr[i] = (Jtr[i] as number) + (J[i] as number) * res;
        for (let j = 0; j < n; j++) (JtJ[i] as number[])[j] = ((JtJ[i] as number[])[j] as number) + (J[i] as number) * (J[j] as number);
      }
    };
    for (const p of points) {
      const d = sub(p, c);
      const l = Math.max(1e-9, len(d));
      add([-d[0] / l, -d[1] / l, -1], l - r);
    }
    for (const ln of lines) {
      const d = unit(ln.dir);
      add(withR ? [-d[1], d[0], 0] : [-d[1], d[0]], cross(d, sub(c, ln.at)));
    }
    const step = solve(JtJ, Jtr.map((v) => -v));
    c = [c[0] + (step[0] as number), c[1] + (step[1] as number)];
    if (withR) r += step[2] as number;
    if (Math.hypot(step[0] as number, step[1] as number) < 1e-7) break;
  }
  const pointResiduals = points.map((p) => len(sub(p, c)) - r);
  const lineResiduals = lines.map((l) => cross(unit(l.dir), sub(c, l.at)));
  return { center: c, radius: withR ? r : null, pointResiduals, lineResiduals, pointRms: rms(pointResiduals), lineRms: rms(lineResiduals) };
}

/** A reference's fit data (canvas px): a straight limb draws `axis` (dir towards the root pivot); a bent one marks `elbow`. */
export interface RefFit { axis?: { at: Pt; dir: Pt }; elbow?: Pt; wrist: Pt; fist?: Pt }
export interface FitReference { name: string; use?: "fit" | "compare"; nominal?: Record<string, number>; fit?: RefFit }

export interface ChainFitResult {
  root: CircleFit;
  next: CircleFit;
  /** The fitted rest chain: root pivot, next pivot (elbow) and distal end (wrist), canvas px. */
  rest: { root: Pt; next: Pt; end: Pt };
  lengths: { proximal: number; proximalCircle: number | null; distal: number };
  /** Drawn driver values per reference (degrees, the rig's convention: rotation from the rest axis). */
  drawn: { name: string; proximal: number; distal: number | null; nominal?: Record<string, number> }[];
  extremes: { proximal: [number, number]; distal: [number, number] | null };
  /** Diagnostic: the fist circle about the fitted root (drawn straight-limb reach consistency). */
  reach: { mean: number; spread: number; rest: number | null } | null;
}

/** Fits the two-bone chain (root pivot, next pivot, distal length) to the `fit` references. */
export function fitArmChain(refs: readonly FitReference[], restFit: RefFit, rigRest?: { next: Pt; end: Pt }): ChainFitResult {
  const used = refs.filter((r) => r.use !== "compare" && r.fit);
  const elbows = used.flatMap((r) => (r.fit?.elbow ? [r.fit.elbow] : []));
  const axes = used.flatMap((r) => (r.fit?.axis && !r.fit.elbow ? [{ at: r.fit.axis.at, dir: r.fit.axis.dir }] : []));
  const root = fitCircle(elbows, axes);
  const S = root.center;
  /** Unit direction root -> distal along the proximal bone of a reference. */
  const proximalDir = (f: RefFit): Pt => (f.elbow ? unit(sub(f.elbow, S)) : unit([-(f.axis as AxisLine).dir[0], -(f.axis as AxisLine).dir[1]]));
  const local = (f: RefFit): Pt => {
    const u = proximalDir(f);
    const w = sub(f.wrist, S);
    return [dot(w, u), cross(u, w)];
  };
  // Bent references put the wrists on the circle; the elbow lies on the proximal bone's axis (the
  // local x axis), a line constraint that keeps the centre well conditioned with few bent poses.
  const bent = used.filter((r) => r.fit?.elbow);
  const next = fitCircle(bent.map((r) => local(r.fit as RefFit)), [{ at: [0, 0], dir: [1, 0] }]);
  const e = next.center;
  const u0 = proximalDir(restFit);
  const n0: Pt = [-u0[1], u0[0]];
  const elbowRest: Pt = [S[0] + e[0] * u0[0] + e[1] * n0[0], S[1] + e[0] * u0[1] + e[1] * n0[1]];
  const L = next.radius as number;
  const toWrist = unit(sub(restFit.wrist, elbowRest));
  const wristRest: Pt = [elbowRest[0] + L * toWrist[0], elbowRest[1] + L * toWrist[1]];
  // Drawn driver values are measured against the rig's rest chain when given (its own elbow and
  // wrist about the fitted root), else against the fitted rest chain.
  const restUpper = deg(sub(rigRest?.next ?? elbowRest, S));
  const restFore = norm180(deg(sub(rigRest?.end ?? wristRest, rigRest?.next ?? elbowRest)) - restUpper);
  const drawn = used.map((r) => {
    const f = r.fit as RefFit;
    const u = proximalDir(f);
    // The elbow of a straight limb is not drawn: its upper bone runs from the root along the fitted
    // bone-frame offset of the elbow.
    const E: Pt = f.elbow ?? [S[0] + e[0] * u[0] - e[1] * u[1], S[1] + e[0] * u[1] + e[1] * u[0]];
    // Raise from the drawn upper-arm direction; for a straight limb the axis itself.
    const upperAng = f.elbow ? deg(sub(E, S)) : deg(u);
    return { name: r.name, proximal: norm180(upperAng - restUpper), distal: f.elbow ? norm180(deg(sub(f.wrist, E)) - upperAng - restFore) : null, ...(r.nominal ? { nominal: r.nominal } : {}) };
  });
  const prox = drawn.map((d) => d.proximal);
  const dist = drawn.flatMap((d) => (d.distal === null ? [] : [d.distal]));
  const fists = used.flatMap((r) => (r.fit?.fist && !r.fit.elbow ? [len(sub(r.fit.fist, S))] : []));
  const restReach = restFit.fist ? len(sub(restFit.fist, S)) : null;
  const reachMean = fists.reduce((s, v) => s + v, 0) / Math.max(1, fists.length);
  return {
    root,
    next,
    rest: { root: S, next: elbowRest, end: wristRest },
    lengths: { proximal: len(e), proximalCircle: root.radius, distal: L },
    drawn,
    extremes: { proximal: [Math.min(...prox), Math.max(...prox)], distal: dist.length ? [Math.min(...dist), Math.max(...dist)] : null },
    reach: fists.length ? { mean: reachMean, spread: Math.max(...fists) - Math.min(...fists), rest: restReach } : null
  };
}

type Json = unknown;
/**
 * Re-expresses a preset's chain-relative data for a new chain so the authored canvas geometry is
 * unchanged: `{s, v}` points, arc centres on the axis (`arc.s`), scalar rows (`s`, `sMin`, `sMax`,
 * `row`, `extraRows`, a group's `s` span, topology `from`/`to`) map through the axis; joint `s`
 * values that sat on an old pivot snap to the new pivot. Unbounded sentinels (|s| >= 1000) are kept.
 */
export function migrateChain(skin: Record<string, Json>, oldChain: ChainFrame, newChain: ChainFrame): void {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const mapS = (s: number) => {
    if (Math.abs(s) >= 1000) return s;
    const j = oldChain.jointS.findIndex((js) => Math.abs(js - s) < 0.05);
    if (j >= 0) return r1(newChain.jointS[j] as number);
    return r1(newChain.coords(oldChain.point(s, 0)).s);
  };
  const mapSV = (o: { s: number; v: number }) => {
    const c = newChain.coords(oldChain.point(o.s, o.v));
    o.s = r1(c.s);
    o.v = r1(c.v);
  };
  const walk = (node: Json, key?: string): void => {
    if (Array.isArray(node)) {
      if (key === "extraRows" || (key === "s" && node.length === 2 && node.every((x) => typeof x === "number"))) {
        node.forEach((x, i) => (node[i] = mapS(x as number)));
        return;
      }
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, Json>;
    if (typeof o.s === "number" && typeof o.v === "number") {
      mapSV(o as { s: number; v: number });
    } else {
      for (const k of ["s", "sMin", "sMax", "row"]) if (typeof o[k] === "number") o[k] = mapS(o[k] as number);
    }
    for (const [k, v] of Object.entries(o)) if (typeof v === "object") walk(v, k);
  };
  const topo = skin.topology as Record<string, Json> | undefined;
  if (topo) for (const k of ["from", "to"]) if (typeof topo[k] === "number") topo[k] = mapS(topo[k] as number);
  walk(skin);
}
