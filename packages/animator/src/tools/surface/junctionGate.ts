/*
 * Atlas Animator: original implementation.
 *
 * Junction gates, relative to the rest art. Along the skin outline of a cap patch that
 * declares an `arc`:
 * - `junction`: from the run's body anchor (the strap corner) `arc.region` canvas px along the run
 *   (the limb's top edge into the strap): the net CONCAVE turn over any JUNCTION_WINDOW game px
 *   window may exceed the rest outline's own concave turn at the same spot by at most the limit:
 *   `arc.gateByRaise` ([joint degrees, limit] rows, linear between rows: the limit measured on the
 *   reference drawings' own valley at that raise plus a margin), else `arc.gate` (default
 *   JUNCTION_CONCAVE); never more than JUNCTION_FLOOR: a pose may not add a pinch sharper than the
 *   drawn shoulder has.
 * - `neck`: from the anchor `arc.neck` px the other way (the strap/neck side, where a riding strap
 *   corner leaves its bend): the net turn of either sign may differ from the rest turn of the same
 *   window by at most `arc.neckGate` degrees (default NECK_TURN): a soft curve, no visible kink.
 * Everything is preset data (the cap patch's `from`/`toward` and its `arc`); nothing here knows a
 * template.
 */
import type { BuiltSurface } from "./build.js";
import { dist, type Pt } from "./geometry.js";

/** Window (game px), default junction concave allowance and neck turn allowance (degrees over rest). */
export const JUNCTION_WINDOW = 3;
export const JUNCTION_CONCAVE = 10;
export const NECK_TURN = 20;
/** No junction limit is ever looser than this (degrees over 3 game px). */
export const JUNCTION_FLOOR = 35;

export interface JunctionRegion {
  patch: string;
  kind: "junction" | "neck";
  /** Skin hull indices in walk order. */
  ids: number[];
  /** Allowance over the rest turn, degrees (the default when no per-raise table applies). */
  cap: number;
  /** Driver bone and per-raise limits ([degrees, limit]), junction kind only. */
  joint: string;
  table: [number, number][];
  /** Rest net turn (radians, signed by the walk) per id over the window. */
  bind: number[];
}

/** Net turn (radians) over windows of `window` canvas px centred on each vertex of an open polyline. */
export function windowNetTurns(line: readonly Pt[], window: number): number[] {
  const n = line.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push((s[i - 1] as number) + dist(line[i - 1] as Pt, line[i] as Pt));
  const turn = line.map((p, i) => {
    if (i === 0 || i === n - 1) return 0;
    const a = line[i - 1] as Pt;
    const b = line[i + 1] as Pt;
    if (dist(a, p) < 1e-9 || dist(p, b) < 1e-9) return 0;
    let t = Math.atan2(b[1] - p[1], b[0] - p[0]) - Math.atan2(p[1] - a[1], p[0] - a[0]);
    t -= 2 * Math.PI * Math.round(t / (2 * Math.PI));
    return t;
  });
  return line.map((_, i) => {
    let net = 0;
    for (let j = 0; j < n; j++) if (Math.abs((s[j] as number) - (s[i] as number)) <= window / 2) net += turn[j] as number;
    return net;
  });
}

/** Signed-area sign of a closed outline. */
export const orientation = (pts: readonly Pt[]): number =>
  Math.sign(pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length] as Pt; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) || 1;

const windowOf = (built: BuiltSurface) => JUNCTION_WINDOW / (built.preset.gamePixels / built.preset.figureHeight);

/** The gated hull stretches of every cap patch that declares an `arc` (bind geometry and rest turns). */
export function junctionRegions(built: BuiltSurface): JunctionRegion[] {
  const H = built.skin.hull;
  const hull = built.skin.points.slice(0, H) as Pt[];
  const out: JunctionRegion[] = [];
  for (const p of built.preset.skin.regions.patches) {
    if (p.boundary !== "cap" || !p.arc || !Array.isArray(p.from) || !Array.isArray(p.toward)) continue;
    const from = p.from as Pt;
    const toward = p.toward as Pt;
    let a = 0;
    for (let i = 1; i < H; i++) if (dist(hull[i] as Pt, from) < dist(hull[a] as Pt, from)) a = i;
    const step = dist(hull[(a + 1) % H] as Pt, toward) < dist(hull[(a - 1 + H) % H] as Pt, toward) ? 1 : -1;
    const walk = (dir: number, length: number): number[] => {
      const ids = [a];
      for (let s = 0, k = 1; s < length && ids.length < H / 2; k++) {
        const prev = ids[ids.length - 1] as number;
        const next = (((a + dir * k) % H) + H) % H;
        s += dist(hull[prev] as Pt, hull[next] as Pt);
        ids.push(next);
      }
      return ids;
    };
    const bindOf = (ids: number[]) => windowNetTurns(ids.map((i) => hull[i] as Pt), windowOf(built));
    const junction = walk(step, p.arc.region ?? 90);
    out.push({ patch: p.name, kind: "junction", ids: junction, cap: Math.min(JUNCTION_FLOOR, p.arc.gate ?? JUNCTION_CONCAVE), bind: bindOf(junction), joint: p.joint, table: [...(p.arc.gateByRaise ?? [])].sort((x, y) => x[0] - y[0]) as [number, number][] });
    const neck = walk(-step, p.arc.neck ?? 40).reverse();
    out.push({ patch: p.name, kind: "neck", ids: neck, cap: p.arc.neckGate ?? NECK_TURN, bind: bindOf(neck), joint: p.joint, table: [] });
  }
  return out;
}

export interface JunctionFinding {
  kind: "junction" | "neck";
  patch: string;
  /** Worst excess over the rest turn (degrees; > cap fails), the turn itself, the rest turn, where. */
  excess: number;
  cap: number;
  deg: number;
  bindDeg: number;
  at: Pt;
}

/** A region's limit at a pose: its per-raise table (linear, clamped at the ends) else its cap; never over JUNCTION_FLOOR for a junction. */
export function regionLimit(r: JunctionRegion, pose: Readonly<Record<string, number>> = {}): number {
  if (!r.table.length) return r.cap;
  const x = pose[r.joint] ?? 0;
  const t = r.table;
  let v = (t[t.length - 1] as [number, number])[1];
  if (x <= (t[0] as [number, number])[0]) v = (t[0] as [number, number])[1];
  else for (let k = 1; k < t.length; k++) {
    const [x0, y0] = t[k - 1] as [number, number];
    const [x1, y1] = t[k] as [number, number];
    if (x <= x1) { v = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1); break; }
  }
  return Math.min(JUNCTION_FLOOR, v);
}

/** Gate one posed skin hull at `pose`: per region its worst excess over the rest turn. */
export function junctionGates(built: BuiltSurface, regions: readonly JunctionRegion[], hull: readonly Pt[], pose: Readonly<Record<string, number>> = {}): JunctionFinding[] {
  const orient = orientation(hull.slice(0, built.skin.hull));
  return regions.map((r) => {
    const line = r.ids.map((i) => hull[i] as Pt);
    const turns = windowNetTurns(line, windowOf(built));
    // The rest turn "at that spot": the bind window at the same arc length from the region start (vertices slide along the run).
    const arcLen = (pts: readonly Pt[]) => pts.reduce<number[]>((acc, q, j) => (acc.push(j ? (acc[j - 1] as number) + dist(pts[j - 1] as Pt, q) : 0), acc), []);
    const sPose = arcLen(line);
    const sBind = arcLen(r.ids.map((i) => built.skin.points[i] as Pt));
    const bindAt = (sv: number) => {
      let best = 0;
      sBind.forEach((x, j) => { if (Math.abs(x - sv) < Math.abs((sBind[best] as number) - sv)) best = j; });
      return r.bind[best] as number;
    };
    let worst: JunctionFinding = { kind: r.kind, patch: r.patch, excess: -Infinity, cap: regionLimit(r, pose), deg: 0, bindDeg: 0, at: line[0] as Pt };
    turns.forEach((t, j) => {
      const b = bindAt(sPose[j] as number);
      // Concave degrees (junction: only added concavity counts; neck: any added turn).
      const deg = r.kind === "junction" ? (-t * orient * 180) / Math.PI : (t * orient * 180) / Math.PI;
      const bindDeg = r.kind === "junction" ? (-b * orient * 180) / Math.PI : (b * orient * 180) / Math.PI;
      const excess = r.kind === "junction" ? deg - Math.max(0, bindDeg) : Math.abs(deg - bindDeg);
      if (excess > worst.excess) worst = { ...worst, excess, deg, bindDeg, at: line[j] as Pt };
    });
    return worst;
  });
}
