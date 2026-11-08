/*
 * Atlas Animator: original implementation.
 *
 * Combined pose limits (pass 3d-1, `poseLimits`): convex polygons in driver space
 * (degrees, offsets from setup) over named driver pairs, AND-ed (`auto` polygons are convex; a declared
 * polygon may be any simple polygon, e.g. the elbow-inward Z region). A pose is reachable when its
 * (x, y) driver values lie inside every polygon. The `auto` form samples a declared collision on
 * the drivers' limit grid (a skin part's posed convex hull, dilated by `margin` canvas px, against
 * the opaque pixels of a rigid context region posed by its bone) and shrinks the limit rectangle by
 * half-plane cuts to a convex set free of every colliding sample (each cut keeps the most free
 * samples). Sweeps, corrective seeds, grid refinement, interpolation checks and the gates run only
 * inside; the validator flags clip poses outside; the runtime never clamps. Driver names, parts and
 * regions come from the preset only.
 */
import { resolve } from "node:path";
import { loadAnimDocument } from "../../core/formatLoader.js";
import { readPng } from "../png.js";
import { pointInPolygon, signedArea, type Pt } from "./geometry.js";
import type { BuiltSurface } from "./build.js";
import { Poser, type Pose } from "./correctives.js";
import { isSimplePolygon, leanSplitOk, outsideDistance } from "../liveLimits.js";

/** A resolved limit: a convex polygon (counter-clockwise in (x, y) driver space). */
export interface PoseLimit {
  name: string;
  x: string;
  y: string;
  /** Drivers added to y (a combined limit); absent = y alone. */
  plus?: string[];
  polygon: Pt[];
  /** How it was made (declared, or the auto sampling summary). */
  source: string;
  /** `clips`: written to the rig for the validator/live limits only; never bounds the build (preset `scope`). */
  scope?: "clips";
}

const EPS = 1e-6;

/** Signed distance of `p` outside a convex counter-clockwise polygon (<= 0 inside): the largest outward edge distance. */
export function convexOutside(poly: readonly Pt[], p: Pt): number {
  let worst = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    // Outward normal of a counter-clockwise edge (y up convention of the signed area): (ey, -ex).
    const d = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / len;
    worst = Math.max(worst, d);
  }
  return worst;
}

export function isConvex(poly: readonly Pt[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const c = poly[(i + 2) % poly.length] as Pt;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return sign !== 0;
}

const ccw = (poly: Pt[]): Pt[] => (signedArea(poly) < 0 ? [...poly].reverse() : poly);

export function convexHull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cr(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Clips a convex polygon to the half plane n . p <= c. */
function clipHalfPlane(poly: readonly Pt[], n: Pt, c: number): Pt[] {
  const out: Pt[] = [];
  const f = (p: Pt) => n[0] * p[0] + n[1] * p[1] - c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const fa = f(a);
    const fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * The convex polygon inside `rect` that excludes every blocked sample (by at least `gap`) and keeps
 * the most free samples: greedy half-plane cuts through blocked samples still inside, each choosing
 * the cut (blocked sample x normal direction) that keeps the most free samples, then the most area.
 * `keep` (the setup pose, or several points: a combined limit also keeps its x axis) must stay inside.
 */
export function shrinkToFree(rect: Pt[], free: readonly Pt[], blocked: readonly Pt[], gap: number, keep: Pt | readonly Pt[], directions = 72): Pt[] {
  const keeps: readonly Pt[] = typeof keep[0] === "number" ? [keep as Pt] : (keep as readonly Pt[]);
  let poly = ccw(rect);
  for (let round = 0; round < 512; round++) {
    const inside = blocked.filter((b) => convexOutside(poly, b) < gap - EPS);
    if (!inside.length) return poly;
    let best: { poly: Pt[]; kept: number; area: number } | null = null;
    for (const b of inside) {
      for (let k = 0; k < directions; k++) {
        const a = (k * 2 * Math.PI) / directions;
        const n: Pt = [Math.cos(a), Math.sin(a)];
        // Keep n . p <= n . b - gap: the blocked sample ends `gap` outside.
        const c = n[0] * b[0] + n[1] * b[1] - gap;
        if (keeps.some((k) => n[0] * k[0] + n[1] * k[1] > c)) continue;
        const next = clipHalfPlane(poly, n, c);
        if (next.length < 3) continue;
        const kept = free.filter((f) => convexOutside(next, f) <= EPS).length;
        const area = Math.abs(signedArea(next));
        if (!best || kept > best.kept || (kept === best.kept && area > best.area)) best = { poly: next, kept, area };
      }
    }
    if (!best) throw new Error("poseLimits: no convex cut keeps the setup pose (a collision at setup?)");
    poly = ccw(best.poly);
  }
  throw new Error("poseLimits: the limit polygon did not converge");
}

/**
 * True when every limit polygon contains the pose's driver pair (drivers absent = setup 0) and every
 * combined limit's drivers lean one way (leanSplitOk: the only splits the auto sampling covers).
 */
/**
 * Evidence refit (close, decision A: the smaller clavicle-held range is accepted): the
 * pose scaled toward rest on the limits' own axes (every bone a limit reads) until it is inside;
 * other channels (lean, breathing scale) are kept. Returns `pose` itself when already inside.
 */
export function fitInsideLimits(limits: readonly PoseLimit[], pose: Pose): Pose {
  if (insideLimits(limits, pose)) return pose;
  const axes = new Set(limits.flatMap((l) => [l.x, l.y, ...(l.plus ?? [])]));
  const at = (s: number, digits?: number): Pose =>
    Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, axes.has(k) ? (digits === undefined ? v * s : Number((v * s).toFixed(digits))) : v]));
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (insideLimits(limits, at(mid))) lo = mid;
    else hi = mid;
  }
  // Rounded to 3 decimals and stepped inward until the rounded pose is inside.
  for (let s = lo; s > 0; s -= 1e-3) {
    const p = at(s, 3);
    if (insideLimits(limits, p)) return p;
  }
  return at(0);
}

export function insideLimits(limits: readonly PoseLimit[], pose: Pose): boolean {
  return limits.every((l) => outsideDistance(l.polygon, [pose[l.x] ?? 0, (pose[l.y] ?? 0) + (l.plus ?? []).reduce((s, b) => s + (pose[b] ?? 0), 0)]) <= EPS && leanSplitOk(l, pose));
}

/** Along one driver from 0 towards `end` (others 0): the farthest reachable value (the polygons contain the setup; a declared non-convex one must be star-shaped from it along each axis). */
export function reachAlong(limits: readonly PoseLimit[], bone: string, end: number): number {
  if (insideLimits(limits, { [bone]: end })) return end;
  let lo = 0;
  let hi = end;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (insideLimits(limits, { [bone]: mid })) lo = mid;
    else hi = mid;
  }
  return Number(lo.toFixed(3));
}

/** Resolves the preset's `poseLimits` (declared polygons checked; `auto` forms sampled on the built surface). */
export function resolvePoseLimits(built: BuiltSurface, presetDir: string): { limits: PoseLimit[]; report: string[] } {
  const preset = built.preset;
  const specs = preset.poseLimits ?? [];
  const limits: PoseLimit[] = [];
  const report: string[] = [];
  const boneLimits = (name: string): [number, number] => {
    const b = preset.bones.find((x) => x.name === name);
    if (!b) throw new Error(`poseLimits: no bone '${name}'`);
    if (!b.limits) throw new Error(`poseLimits: bone '${name}' has no limits`);
    return b.limits as [number, number];
  };
  let poser: Poser | null = null;
  for (const spec of specs) {
    const [x0, x1] = boneLimits(spec.x);
    const plus = spec.plus ?? [];
    const [yb0, yb1] = boneLimits(spec.y);
    // A combined y spans the sum of its drivers' limits.
    const y0 = yb0 + plus.reduce((s, b) => s + boneLimits(b)[0], 0);
    const y1 = yb1 + plus.reduce((s, b) => s + boneLimits(b)[1], 0);
    const extra = plus.length ? { plus: [...plus] } : {};
    const yName = plus.length ? [spec.y, ...plus].join(" + ") : spec.y;
    if (spec.polygon) {
      const poly = ccw(spec.polygon.map((p) => [p[0], p[1]] as Pt));
      // A declared polygon may be non-convex (the elbow-inward rule's Z region); it must be simple.
      if (!isSimplePolygon(poly)) throw new Error(`poseLimits '${spec.name}': polygon is not simple (edges cross)`);
      if (outsideDistance(poly, [0, 0]) > EPS) throw new Error(`poseLimits '${spec.name}': the setup pose is outside the polygon`);
      const clipsOnly = spec.scope === "clips";
      limits.push({ name: spec.name, x: spec.x, y: spec.y, ...extra, polygon: poly, source: clipsOnly ? "declared (clips only)" : "declared", ...(clipsOnly ? { scope: "clips" as const } : {}) });
      report.push(`pose limit ${spec.name} (${spec.x} x ${yName}): declared${clipsOnly ? " for clips only (not a build bound)" : ""}, ${poly.length} vertices`);
      continue;
    }
    const auto = spec.auto;
    if (!auto) throw new Error(`poseLimits '${spec.name}': needs 'polygon' or 'auto'`);
    poser ??= new Poser(loadAnimDocument({ ...built.document, driven: [], drivenGrids: [] }), built);
    const P = poser;
    const [partName, regionName] = auto.collide;
    const part = partVertices(built, partName);
    const region = preset.regions.find((r) => r.name === regionName);
    if (!region) throw new Error(`poseLimits '${spec.name}': no rigid region '${regionName}'`);
    // Opaque texels of the region inside its keep polygon (every 2nd canvas px), in canvas coordinates at setup.
    const img = readPng(resolve(presetDir, region.image));
    const [cx, cy, cw, ch] = region.crop;
    const texels: Pt[] = [];
    for (let y = 0; y < ch; y += 2) {
      for (let x = 0; x < cw; x += 2) {
        const p: Pt = [cx + x + 0.5, cy + y + 0.5];
        if (region.keep && !pointInPolygon(p, region.keep)) continue;
        if ((img.data[((cy + y) * img.width + cx + x) * 4 + 3] as number) > 128) texels.push(p);
      }
    }
    const { originX, originY } = P.doc.canvas;
    P.pose({});
    const setup = P.skeleton.getBone(region.bone).world;
    const sw = { a: setup.a, b: setup.b, c: setup.c, d: setup.d, x: setup.x, y: setup.y };
    const sdet = sw.a * sw.d - sw.b * sw.c;
    const local = texels.map(([px, py]) => {
      const x = px - originX - sw.x;
      const y = py - originY - sw.y;
      return [(sw.d * x - sw.b * y) / sdet, (-sw.c * x + sw.a * y) / sdet] as Pt;
    });
    const collides = (pose: Pose): boolean => {
      P.pose(pose);
      const v = P.vertices(built.skin);
      const hull = ccw(convexHull(part.map((i) => v[i] as Pt)));
      const w = P.skeleton.getBone(region.bone).world;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [hx, hy] of hull) {
        minX = Math.min(minX, hx);
        maxX = Math.max(maxX, hx);
        minY = Math.min(minY, hy);
        maxY = Math.max(maxY, hy);
      }
      for (const [lx, ly] of local) {
        const p: Pt = [w.a * lx + w.b * ly + w.x + originX, w.c * lx + w.d * ly + w.y + originY];
        if (p[0] < minX - auto.margin || p[0] > maxX + auto.margin || p[1] < minY - auto.margin || p[1] > maxY + auto.margin) continue;
        if (convexOutside(hull, p) <= auto.margin) return true;
      }
      return false;
    };
    const step = auto.step ?? 5;
    const axis = (lo: number, hi: number, s: number) => {
      const out: number[] = [];
      for (let a = lo; a < hi - 1e-9; a += s) out.push(Number(a.toFixed(4)));
      out.push(hi);
      return out;
    };
    const free: Pt[] = [];
    const blocked: Pt[] = [];
    // Held drivers: every value combination (inside the limits resolved so far, checked per pose).
    let holds: Pose[] = [{}];
    for (const [bone, values] of Object.entries(auto.hold ?? {})) {
      boneLimits(bone);
      holds = holds.flatMap((h) => values.map((v) => ({ ...h, [bone]: v })));
    }
    // Splits of a combined y value over its drivers (each on its limit grid at `step`, y's own bone takes the rest).
    const splits = (y: number): Pose[] => {
      let out: Pose[] = [{}];
      for (const b of plus) {
        const [lo, hi] = boneLimits(b);
        out = out.flatMap((p) => axis(lo, hi, step).map((v) => ({ ...p, [b]: v })));
      }
      return out
        .map((p) => ({ ...p, [spec.y]: Number((y - plus.reduce((s, b) => s + (p[b] ?? 0), 0)).toFixed(4)) }))
        .filter((p) => (p[spec.y] as number) >= yb0 - EPS && (p[spec.y] as number) <= yb1 + EPS)
        // A lean: every driver of the sum on the total's side (or 0). Counter-leaning splits (neck one
        // way, head the other) are not a lean of y; with them y = 0 can collide and no convex polygon
        // in (x, y) keeps both the setup and the raised arm. insideLimits rejects them (leanSplitOk).
        .filter((p) => [spec.y, ...plus].every((b) => (Math.abs(y) < EPS ? Math.abs(p[b] as number) < EPS : (p[b] as number) * y >= -EPS)));
    };
    // Held combinations usable at x: inside the earlier limits and free with y's drivers at setup.
    const neutralHits = new Set<string>();
    const usable = new Map<number, Pose[]>();
    const holdsAt = (x: number): Pose[] => {
      let out = usable.get(x);
      if (out) return out;
      out = holds.filter((h) => {
        if (!Object.keys(h).length) return true;
        const pose: Pose = { ...h, [spec.x]: x };
        if (!insideLimits(limits, pose)) return false;
        if (!collides(pose)) return true;
        neutralHits.add(JSON.stringify(pose));
        return false;
      });
      usable.set(x, out);
      return out;
    };
    const blockedAt = (x: number, y: number): boolean => {
      for (const s of splits(y)) for (const h of holdsAt(x)) if (collides({ ...h, ...s, [spec.x]: x })) return true;
      return false;
    };
    const sample = (s: number, within: Pt[] | null) => {
      for (const x of axis(x0, x1, s)) {
        for (const y of axis(y0, y1, s)) {
          if (within && convexOutside(within, [x, y]) > EPS) continue;
          (blockedAt(x, y) ? blocked : free).push([x, y]);
        }
      }
    };
    sample(step, null);
    if (collides({})) throw new Error(`poseLimits '${spec.name}': '${partName}' collides with '${regionName}' at the setup pose`);
    const rect: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    // A combined limit bounds the lean, never the arm: it keeps x's whole range at y = 0 (convexity
    // then trades lean range for it; a collision on that axis is a pairwise-limit matter).
    const keep: Pt[] = plus.length ? [[0, 0], [x0, 0], [x1, 0]].filter((k) => !blockedAt(k[0] as number, 0)) as Pt[] : [[0, 0]];
    // Kept axis points pin the cuts: 1 degree cut directions find the shallow edge between them.
    const dirs = plus.length ? 360 : 72;
    let poly = shrinkToFree(rect, free, blocked, step / 2, keep, dirs);
    // Verify at half the step inside the polygon; colliding samples found there cut again.
    for (let round = 0; round < 3; round++) {
      const before = blocked.length;
      sample(step / 2, poly);
      if (blocked.length === before) break;
      poly = shrinkToFree(rect, free, blocked, step / 4, keep, dirs);
    }
    poly = poly.map(([a, b]) => [Number(a.toFixed(3)), Number(b.toFixed(3))] as Pt);
    // Held poses that already collide with y's drivers at setup were left out of the sampling, so
    // the polygon says nothing about them: an earlier (pairwise) limit must exclude them (e.g. its
    // own `auto.hold`), else insideLimits would admit an unchecked collision. Fail closed.
    if (neutralHits.size) throw new Error(`poseLimits '${spec.name}': ${neutralHits.size} held poses inside the earlier limits collide with ${yName} at setup (${[...neutralHits].slice(0, 4).join(" ")}); exclude them in an earlier limit (auto.hold)`);
    const held = Object.keys(auto.hold ?? {}).length
      ? `, holding ${JSON.stringify(auto.hold)} (${neutralHits.size} held poses inside the earlier limits already collide with ${yName} at setup, skipped${neutralHits.size ? `: ${[...neutralHits].slice(0, 3).join(" ")}` : ""})`
      : "";
    limits.push({ name: spec.name, x: spec.x, y: spec.y, ...extra, polygon: poly, source: `auto: '${partName}' vs '${regionName}' margin ${auto.margin} px${held}, ${free.length + blocked.length} samples (${blocked.length} colliding)` });
    report.push(`pose limit ${spec.name} (${spec.x} x ${yName}): auto ${JSON.stringify(poly)} from ${free.length + blocked.length} samples, ${blocked.length} colliding ('${partName}' vs '${regionName}', margin ${auto.margin} px${held})`);
  }
  return { limits, report };
}

/** Skin vertices of a part: a core or patch name (support region), else the triangles of a skin draw group (slot). */
function partVertices(built: BuiltSurface, name: string): number[] {
  const byRegion = built.support.flatMap((s, i) => ((s?.region.split("+") ?? []).includes(name) ? [i] : []));
  if (byRegion.length) return byRegion;
  const g = built.groupSlots.indexOf(name);
  if (g < 0) throw new Error(`poseLimits: no skin part '${name}' (a core, patch or skin group slot)`);
  const out = new Set<number>();
  built.triangleGroups.forEach((group, t) => {
    if (group === g) for (let k = 0; k < 3; k++) out.add(built.skin.triangles[t * 3 + k] as number);
  });
  return [...out];
}
