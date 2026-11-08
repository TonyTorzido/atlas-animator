/*
 * Atlas Animator: original implementation.
 *
 * Sparse runtime proof. The dense solved surface stays an offline reference; the
 * runtime rig is the same build (buildSurface with a SurfaceReduction) on a subset of its skin
 * vertices and garment outline samples, chosen by error measured over motion:
 * - a removed hull vertex must stay within the silhouette tolerance of the chord between its kept
 *   hull neighbours at every solved sweep frame (and at bind);
 * - a removed interior or row vertex must stay within the texture tolerance of its barycentric
 *   point in the reduced bind triangulation at every frame (the texture it carried lands there);
 * - every new triangle keeps its posed/bind area ratio above the floor at every frame.
 * Semantic vertices are never candidates: apexes and anchors, row ends, group partition, contour
 * ends and junctions, silhouette corners, patch hand-offs. Garments are re-conformed and re-embedded
 * on the reduced skin by the build itself; correctives are rebaked from the dense targets restricted
 * to the kept vertices (ReferenceSolver), so the dense mesh is a build-time input only.
 * Nothing here names a template: tolerances come from the preset's `runtime` block.
 */
import { rigHash, type GeometryFinding } from "../validateGeometry.js";
import { bandData, measureContacts } from "./contacts.js";
import { loadAnimDocument } from "../../core/formatLoader.js";
import type { AnimDocument } from "../../core/format.js";
import { strokeVertexCount } from "../../core/contours.js";
import type { RgbaImage } from "../image.js";
import { AREA_FLOOR, buildSurface, embedInMesh, triangulate, type BuiltMesh, type BuiltSurface, type SurfaceReduction } from "./build.js";
import { joinPose, Poser, seedCorrectives, sweepClips, type Pose } from "./correctives.js";
import { dist, distanceToSegment, pointInPolygon, samplePath, segmentCross, type PathPoint, type Pt } from "./geometry.js";
import { fitInsideLimits, insideLimits } from "./limits.js";
import { junctionRegions } from "./junctionGate.js";
import { finalPoses, surfaceDistortion, validationCompanion } from "./validationCompanion.js";
import type { ValidationCompanion } from "../validateGeometry.js";
import type { SurfaceRig } from "./output.js";
import { SurfaceSolver, type PoseTarget, type SurfaceSolveOptions } from "./solver.js";

/** Runtime tolerances (game px) from the preset (`runtime`), with the plan's defaults. */
export function runtimeTolerances(preset: BuiltSurface["preset"]): { silhouette: number; texture: number; turn: number; gameScale: number; budget: { skin: number; garment: number } } {
  const r = preset.runtime;
  return { silhouette: r?.silhouette ?? 0.25, texture: r?.texture ?? 0.25, turn: r?.turn ?? 0.5, gameScale: preset.gamePixels / preset.figureHeight, budget: { skin: r?.budget?.skin ?? 160, garment: r?.budget?.garment ?? 100 } };
}

const nearestIndex = (pts: readonly Pt[], q: Pt, count = pts.length) => {
  let best = 0;
  for (let i = 1; i < count; i++) if (dist(pts[i] as Pt, q) < dist(pts[best] as Pt, q)) best = i;
  return best;
};

const cornerControls = (path: readonly PathPoint[], built: BuiltSurface): Pt[] =>
  path.flatMap((c) => (Array.isArray(c) ? [] : "at" in c && c.corner ? [c.at as Pt] : "s" in c && c.corner ? [built.chain.point(c.s, c.v)] : []));

/** Skin vertices the reduction never removes (semantic structure, not samples). */
export function protectedSkin(built: BuiltSurface): Set<number> {
  const skin = built.skin;
  const keep = new Set<number>();
  for (const a of built.apexes) keep.add(a.index);
  for (const a of built.anchors) keep.add(a.index);
  for (const r of built.rows) {
    keep.add(r.ids[0] as number);
    keep.add(r.ids[r.ids.length - 1] as number);
  }
  for (const v of built.partition) keep.add(v);
  for (const j of built.junctions) if (j.mesh === "skin") keep.add(j.index);
  for (const c of built.contours) {
    if (c.mesh !== "skin") continue;
    keep.add(c.points[0] as number);
    keep.add(c.points[c.points.length - 1] as number);
  }
  for (const p of cornerControls(built.preset.skin.silhouette as PathPoint[], built)) keep.add(nearestIndex(skin.points, p, skin.hull));
  for (const p of built.patches) {
    if (!p.chain.length) continue;
    keep.add(p.chain[0] as number);
    keep.add(p.chain[p.chain.length - 1] as number);
  }
  for (const spec of built.preset.skin.regions.patches) if (Array.isArray(spec.from)) keep.add(nearestIndex(skin.points, spec.from as Pt, skin.hull));
  // Hinge bands (`side: both` patches): their joint-area gate aggregates the band's own triangles, so
  // the band keeps its boundary (band vertices with a mesh neighbour outside the band): the region
  // covers the same skin on the reduced mesh.
  const hinges = new Set(built.preset.skin.regions.patches.filter((p) => p.side === "both").map((p) => p.name));
  const inBand = built.support.map((s) => Boolean(s && s.region.split("+").some((r) => hinges.has(r))));
  const tris = skin.triangles;
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [tris[t], tris[t + 1], tris[t + 2]] as number[];
    if (ids.some((v) => inBand[v]) && ids.some((v) => !inBand[v])) for (const v of ids) if (inBand[v]) keep.add(v);
  }
  // Declared junction / neck regions (cap patch `arc`): their gate measures shape over every sample.
  for (const r of junctionRegions(built)) for (const v of r.ids) keep.add(v);
  return keep;
}

/** Posed/bind signed-area ratio of triangle (a, b, c) at frame x. */
const areaRatio = (bind: readonly Pt[], x: readonly Pt[], a: number, b: number, c: number) => {
  const A = (p: readonly Pt[]) => ((p[b] as Pt)[0] - (p[a] as Pt)[0]) * ((p[c] as Pt)[1] - (p[a] as Pt)[1]) - ((p[c] as Pt)[0] - (p[a] as Pt)[0]) * ((p[b] as Pt)[1] - (p[a] as Pt)[1]);
  const b0 = A(bind);
  return Math.abs(b0) < 1e-9 ? 1 : A(x) / b0;
};

export interface SkinReduction {
  keep: number[];
  removedHull: number;
  removedInterior: number;
  /** Worst measured error over every frame (game px) of the removed vertices. */
  maxSilhouette: number;
  maxTexture: number;
  attempts: number;
  ms: number;
  /** Why candidates stayed (counted per rejected attempt) and how many vertices were never candidates. */
  rejected: { area: number; texture: number; silhouette: number; turn: number; crossing: number; exposed: number; triangulation: number; locked: number };
}

/**
 * Greedy error-driven vertex removal on the dense skin over the solved frames `frames` (dense skin
 * positions per frame; bind is added). Tolerances in canvas px.
 */
export function reduceSkin(built: BuiltSurface, frames: readonly (readonly Pt[])[], tol: { silhouette: number; texture: number; probe?: number; turn?: number; window?: number }, probes: readonly Pt[] = []): SkinReduction {
  const started = Date.now();
  const bind = built.skin.points;
  const n = bind.length;
  const H = built.skin.hull;
  const all = [bind, ...frames];
  const locked = protectedSkin(built);
  const removed = new Uint8Array(n);
  // Interior row vertices: row index and position (row ends are locked).
  const rowOf = new Map<number, number>();
  built.rows.forEach((r, k) => r.ids.slice(1, -1).forEach((v) => rowOf.set(v, k)));
  const rowIds = built.rows.map((r) => r.ids);
  const keptRow = (k: number) => (rowIds[k] as number[]).filter((v) => !removed[v]);
  const hullPrev = (i: number) => {
    for (let k = 1; k < H; k++) {
      const j = (((i - k) % H) + H) % H;
      if (!removed[j]) return j;
    }
    return i;
  };
  const hullNext = (i: number) => {
    for (let k = 1; k < H; k++) {
      const j = (i + k) % H;
      if (!removed[j]) return j;
    }
    return i;
  };
  const triangulateKept = (): number[] => {
    const kept: number[] = [];
    for (let v = 0; v < n; v++) if (!removed[v]) kept.push(v);
    const local = new Map(kept.map((v, i) => [v, i]));
    const pts = kept.map((v) => bind[v] as Pt);
    const hk = kept.filter((v) => v < H).length;
    const edges: [number, number][] = Array.from({ length: hk }, (_, i) => [i, (i + 1) % hk]);
    for (let k = 0; k < rowIds.length; k++) {
      const ids = keptRow(k).map((v) => local.get(v) as number);
      for (let j = 0; j + 1 < ids.length; j++) edges.push([ids[j] as number, ids[j + 1] as number]);
    }
    return triangulate(pts, edges, hk).map((i) => kept[i] as number);
  };
  /** Constraint segments of the current reduction (hull and rows), as vertex pairs. */
  const constraints = (): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < H; i++) if (!removed[i]) out.push([i, hullNext(i)]);
    for (let k = 0; k < rowIds.length; k++) {
      const ids = keptRow(k);
      for (let j = 0; j + 1 < ids.length; j++) out.push([ids[j] as number, ids[j + 1] as number]);
    }
    return out;
  };
  const crossesAny = (a: number, b: number) =>
    constraints().some(([c, d]) => {
      if (c === a || c === b || d === a || d === b) return false;
      const x = segmentCross(bind[a] as Pt, bind[b] as Pt, bind[c] as Pt, bind[d] as Pt);
      return x !== null && x.t > 1e-6 && x.t < 1 - 1e-6 && x.u > 1e-6 && x.u < 1 - 1e-6;
    });
  const triKey = (a: number, b: number, c: number) => [a, b, c].sort((p, q) => p - q).join(",");
  // Removed interior vertex -> its embedding (triangle key, corners, weights).
  const embeds = new Map<number, { key: string; tri: [number, number, number]; w: [number, number, number] }>();
  // Probes (garment outline samples on the skin): id n + j, reference = their dense barycentric point.
  const probeRef = probes.map((p) => embedInMesh(bind, built.skin.triangles, p, 0.05));
  const bindOf = (id: number): Pt => (id < n ? (bind[id] as Pt) : (probes[id - n] as Pt));
  const refAt = (id: number, x: readonly Pt[]): Pt => {
    if (id < n) return x[id] as Pt;
    const e = probeRef[id - n] as NonNullable<(typeof probeRef)[number]>;
    const q: Pt = [0, 0];
    e.tri.forEach((v, k) => {
      q[0] += (e.weights[k] as number) * (x[v] as Pt)[0];
      q[1] += (e.weights[k] as number) * (x[v] as Pt)[1];
    });
    return q;
  };
  const tolOf = (id: number) => (id < n ? tol.texture : (tol.probe ?? tol.texture));
  const embedOne = (v: number, tris: readonly number[]) => {
    const e = embedInMesh(bind, tris, bindOf(v), v < n ? 1e-6 : 0.05);
    if (!e) return null;
    return { key: triKey(...e.tri), tri: e.tri, w: e.weights };
  };
  const textureError = (v: number, e: { tri: [number, number, number]; w: [number, number, number] }) => {
    let worst = 0;
    for (const x of all) {
      const p = refAt(v, x);
      const q: Pt = [0, 0];
      for (let k = 0; k < 3; k++) {
        const c = x[e.tri[k] as number] as Pt;
        q[0] += (e.w[k] as number) * c[0];
        q[1] += (e.w[k] as number) * c[1];
      }
      worst = Math.max(worst, dist(p, q));
      if (worst > tolOf(v)) break;
    }
    return worst;
  };
  const silhouetteError = (v: number) => {
    const a = hullPrev(v);
    const b = hullNext(v);
    let worst = 0;
    for (const x of all) {
      worst = Math.max(worst, distanceToSegment(x[v] as Pt, x[a] as Pt, x[b] as Pt));
      if (worst > tol.silhouette) break;
    }
    return worst;
  };
  // Visible turn (joint shape / kinks): a kept hull vertex may not turn more than the
  // dense hull turns over the window around it (+ tol.turn degrees) at any frame.
  const turnAt = (x: readonly Pt[], p: number, v: number, q: number) => {
    const a = x[p] as Pt, b = x[v] as Pt, c = x[q] as Pt;
    return Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) * (180 / Math.PI);
  };
  const half = (tol.window ?? 0) / 2;
  const windowTurn = all.map((x) => {
    const own = Array.from({ length: H }, (_, i) => turnAt(x, (i - 1 + H) % H, i, (i + 1) % H));
    return Array.from({ length: H }, (_, i) => {
      let sum = own[i] as number;
      for (const dir of [1, -1]) {
        let d = 0;
        for (let k = 1, j = i; k < H; k++) {
          const nj = (((j + dir) % H) + H) % H;
          d += dist(x[j] as Pt, x[nj] as Pt);
          if (d > half) break;
          sum += own[nj] as number;
          j = nj;
        }
      }
      return Math.abs(sum);
    });
  });
  const turnOk = (v: number) => {
    if (tol.turn === undefined || removed[v]) return true;
    const p = hullPrev(v), q = hullNext(v);
    for (let f = 0; f < all.length; f++) if (Math.abs(turnAt(all[f] as readonly Pt[], p, v, q)) > ((windowTurn[f] as number[])[v] as number) + tol.turn) return false;
    return true;
  };
  let tris = triangulateKept();
  probes.forEach((_, j) => {
    if (!probeRef[j]) return;
    const e = embedOne(n + j, tris);
    if (e) embeds.set(n + j, e);
  });
  let triSet = new Set<string>();
  const indexTris = () => {
    triSet = new Set<string>();
    for (let t = 0; t < tris.length; t += 3) triSet.add(triKey(tris[t] as number, tris[t + 1] as number, tris[t + 2] as number));
  };
  indexTris();
  // Candidates: hull samples by their chord error with the immediate neighbours, then the rest.
  const candidates: { v: number; cost: number }[] = [];
  for (let v = 0; v < n; v++) if (!locked.has(v)) candidates.push({ v, cost: v < H ? silhouetteError(v) : tol.texture });
  candidates.sort((p, q) => p.cost - q.cost);
  let attempts = 0;
  const rejected = { area: 0, texture: 0, silhouette: 0, turn: 0, crossing: 0, exposed: 0, triangulation: 0, locked: locked.size };
  let maxSil = 0;
  let maxTex = 0;
  for (let pass = 0; pass < 3; pass++) {
    let progress = 0;
    for (const { v } of candidates) {
      if (removed[v]) continue;
      attempts++;
      const row = rowOf.get(v);
      if (v < H) {
        const a = hullPrev(v);
        const b = hullNext(v);
        if (a === b || crossesAny(a, b)) { rejected.crossing++; continue; }
        // No kept vertex may fall outside the new hull edge.
        const tri: Pt[] = [bind[a] as Pt, bind[v] as Pt, bind[b] as Pt];
        let exposed = false;
        for (let u = H; u < n && !exposed; u++) if (!removed[u] && pointInPolygon(bind[u] as Pt, tri)) exposed = true;
        if (exposed) { rejected.exposed++; continue; }
      } else if (row !== undefined) {
        const ids = keptRow(row);
        const k = ids.indexOf(v);
        if (k <= 0 || k >= ids.length - 1 || crossesAny(ids[k - 1] as number, ids[k + 1] as number)) { rejected.crossing++; continue; }
      }
      removed[v] = 1;
      let ok = true;
      let next: number[] = [];
      try {
        next = triangulateKept();
      } catch {
        ok = false;
        rejected.triangulation++;
      }
      const nextSet = new Set<string>();
      for (let t = 0; ok && t < next.length; t += 3) nextSet.add(triKey(next[t] as number, next[t + 1] as number, next[t + 2] as number));
      // New triangles keep their area at every frame.
      for (let t = 0; ok && t < next.length; t += 3) {
        const a = next[t] as number, b = next[t + 1] as number, c = next[t + 2] as number;
        if (triSet.has(triKey(a, b, c))) continue;
        for (const x of frames) if (!(areaRatio(bind, x, a, b, c) > AREA_FLOOR + 0.05)) { ok = false; rejected.area++; break; }
      }
      // Errors: the silhouette chords this removal changes, and every texture point whose triangle changed.
      const updates = new Map<number, { key: string; tri: [number, number, number]; w: [number, number, number] }>();
      let sil = 0;
      let tex = 0;
      if (ok && v < H) {
        const a = hullPrev(v), b = hullNext(v);
        if (!turnOk(a) || !turnOk(b)) { ok = false; rejected.turn++; }
        for (let i = (a + 1) % H; ok && i !== b; i = (i + 1) % H) {
          const e = silhouetteError(i);
          sil = Math.max(sil, e);
          if (e > tol.silhouette) { ok = false; rejected.silhouette++; }
        }
      }
      if (ok) {
        const check = [...embeds.keys()].filter((u) => !nextSet.has((embeds.get(u) as { key: string }).key));
        if (v >= H) check.push(v);
        for (const u of check) {
          const e = embedOne(u, next);
          if (!e) { ok = false; rejected.texture++; break; }
          const err = textureError(u, e);
          if (u < n) tex = Math.max(tex, err);
          if (err > tolOf(u)) { ok = false; rejected.texture++; break; }
          updates.set(u, e);
        }
      }
      if (!ok) {
        removed[v] = 0;
        continue;
      }
      for (const [u, e] of updates) embeds.set(u, e);
      tris = next;
      triSet = nextSet;
      maxSil = Math.max(maxSil, sil);
      maxTex = Math.max(maxTex, tex);
      progress++;
    }
    if (!progress) break;
  }
  const keep: number[] = [];
  for (let v = 0; v < n; v++) if (!removed[v]) keep.push(v);
  let removedHull = 0;
  for (let v = 0; v < H; v++) removedHull += removed[v] as number;
  return { keep, removedHull, removedInterior: n - keep.length - removedHull, maxSilhouette: maxSil, maxTexture: maxTex, attempts, ms: Date.now() - started, rejected };
}

/**
 * Garment outline samples to keep: chord simplification of the closed outline over motion. Posed
 * outline points follow the dense skin (barycentric embedding); samples off the skin, corners,
 * contour / overlay / junction / coverage anchors and on/off-skin transitions are kept.
 */
export function reduceOutline(built: BuiltSurface, garment: BuiltSurface["preset"]["garments"][number], frames: readonly (readonly Pt[])[], tol: number, runtime?: { mesh: BuiltMesh; frames: readonly (readonly Pt[])[] }): { keep: number[]; total: number } {
  const gh = samplePath(garment.path, built.chain, garment.spacing, true);
  const skin = built.skin;
  const bindFrames = runtime ? [skin.points, ...runtime.frames] : [skin.points, ...frames];
  const onSkin = gh.map((p) => embedInMesh(skin.points, skin.triangles, p, garment.embedMargin ?? 0.05));
  const m0 = gh.length;
  // Off the skin: the sample inherits the motion of the nearest on-skin sample along the outline (as
  // the build's off-skin vertices inherit weights along the garment): that sample's skin triangle,
  // extrapolated (barycentric weights outside [0, 1]).
  const emb = gh.map((p, i) => {
    if (onSkin[i]) return onSkin[i];
    for (let k = 1; k < m0; k++) {
      for (const j of [(i + k) % m0, (i - k + m0 * 2) % m0]) {
        const e = onSkin[j];
        if (!e) continue;
        const [a, b, c] = e.tri.map((v) => skin.points[v] as Pt) as [Pt, Pt, Pt];
        const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
        const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
        return { ...e, weights: [wa, wb, 1 - wa - wb] as [number, number, number] };
      }
    }
    return null;
  });
  const runtimeOf = runtime
    ? gh.map((p) => {
        let best = 0;
        for (let v = 1; v < runtime.mesh.hull; v++) if (dist(runtime.mesh.points[v] as Pt, p) < dist(runtime.mesh.points[best] as Pt, p)) best = v;
        const q = runtime.mesh.points[best] as Pt;
        return { v: best, dx: p[0] - q[0], dy: p[1] - q[1] };
      })
    : null;
  const posed = (i: number, f: number): Pt => {
    if (runtimeOf && runtime) {
      const r = runtimeOf[i] as { v: number; dx: number; dy: number };
      const q = f === 0 ? (runtime.mesh.points[r.v] as Pt) : ((runtime.frames[f - 1] as readonly Pt[])[r.v] as Pt);
      return [q[0] + r.dx, q[1] + r.dy];
    }
    const e = emb[i];
    if (!e) return gh[i] as Pt;
    const x = bindFrames[f] as readonly Pt[];
    const q: Pt = [0, 0];
    e.tri.forEach((v, k) => {
      q[0] += (e.weights[k] as number) * (x[v] as Pt)[0];
      q[1] += (e.weights[k] as number) * (x[v] as Pt)[1];
    });
    return q;
  };
  const m = gh.length;
  const locked = new Set<number>();
  emb.forEach((e, i) => {
    if (!e || Boolean(onSkin[i]) !== Boolean(onSkin[(i + 1) % m]) || Boolean(onSkin[i]) !== Boolean(onSkin[(i - 1 + m) % m])) locked.add(i);
  });
  const anchors: Pt[] = [...cornerControls(garment.path as PathPoint[], built)];
  for (const c of garment.contours) for (const a of [c.from, c.to]) if (Array.isArray(a)) anchors.push(a as Pt);
  for (const j of built.preset.skin.junctions ?? []) for (const a of [j.at, j.toward]) if (Array.isArray(a)) anchors.push(a as Pt);
  for (const c of ((built.preset.gates as { coverage?: { from: Pt; to: Pt }[] } | undefined)?.coverage ?? [])) anchors.push(c.from, c.to);
  for (const a of anchors) locked.add(nearestIndex(gh, a));
  // Group partition under the garment: the outline keeps its samples near a partition vertex (a
  // chord there could uncover a group boundary the garment must hide).
  for (const v of built.partition) {
    const p = skin.points[v] as Pt;
    gh.forEach((q, i) => {
      if (dist(p, q) < 3 * garment.spacing) locked.add(i);
    });
  }
  const removed = new Uint8Array(m);
  const prev = (i: number) => { for (let k = 1; k < m; k++) { const j = (i - k + m * 2) % m; if (!removed[j]) return j; } return i; };
  const next = (i: number) => { for (let k = 1; k < m; k++) { const j = (i + k) % m; if (!removed[j]) return j; } return i; };
  const err = (i: number) => {
    const a = prev(i), b = next(i);
    let worst = 0;
    for (let f = 0; f < bindFrames.length && worst <= tol; f++) worst = Math.max(worst, distanceToSegment(posed(i, f), posed(a, f), posed(b, f)));
    return worst;
  };
  const order = gh.map((_, i) => i).filter((i) => !locked.has(i));
  order.sort((p, q) => err(p) - err(q));
  for (const i of order) {
    removed[i] = 1;
    const a = prev(i), b = next(i);
    let ok = true;
    for (let j = (a + 1) % m; ok && j !== b; j = (j + 1) % m) if (err(j) > tol) ok = false;
    if (!ok) removed[i] = 0;
  }
  return { keep: gh.flatMap((_, i) => (removed[i] ? [] : [i])), total: m };
}

/**
 * The surface solver of the reduced rig whose targets are the dense solver's, restricted to the
 * kept vertices: the dense surface is the offline reference the runtime rig is baked from.
 */
export class ReferenceSolver extends SurfaceSolver {
  private static pending: { dense: SurfaceSolver; keep: readonly number[] } | null = null;
  private readonly ref: { dense: SurfaceSolver; keep: readonly number[] };
  constructor(built: BuiltSurface, options: SurfaceSolveOptions, dense: SurfaceSolver, keep: readonly number[]) {
    ReferenceSolver.pending = { dense, keep };
    super(built, options);
    this.ref = ReferenceSolver.pending;
    ReferenceSolver.pending = null;
  }
  private get reference() {
    return this.ref ?? (ReferenceSolver.pending as NonNullable<typeof ReferenceSolver.pending>);
  }
  private restrict(t: PoseTarget): PoseTarget {
    const { keep } = this.reference;
    const x = keep.map((v) => t.x[v] as Pt);
    const curve = keep.map((v) => t.curve[v] ?? null);
    const minRatio = this.solver.minRatio(x).min;
    const ok = t.ok && minRatio > this.floor;
    return { ...t, x, curve, minRatio, areas: this.solver.regionAreas(x), ok, reason: ok || !t.ok ? t.reason : `reduced mesh: min area ratio ${minRatio.toFixed(3)}` };
  }
  override solve(pose: Pose): PoseTarget {
    return this.restrict(this.reference.dense.solve(pose));
  }
  override along(poses: Pose[]): PoseTarget[] {
    return this.reference.dense.along(poses).map((t) => this.restrict(t));
  }
}

export interface SparseBuild {
  rig: SurfaceRig;
  reduction: SurfaceReduction;
  skin: SkinReduction;
  outlines: Record<string, { kept: number; total: number }>;
}

/**
 * Combined poses for the reducer (dense agreement): raise (the limit included) x shrug +-6 x
 * lean +-10 x breathing peak x elbow 0 / 30, plus arms crossed; each fitted inside the rig's limits.
 */
export function combinedPoses(dense: SurfaceRig): Pose[] {
  const preset = dense.built.preset;
  const [arm, elbow] = preset.chain.bones as [string, string];
  const girdle = preset.girdle?.bone;
  const lean = preset.base;
  const breathe = preset.gates?.combined?.breathe;
  const out: Pose[] = [];
  const seen = new Set<string>();
  const add = (p: Pose) => {
    const f = fitInsideLimits(dense.limits, p);
    if (!insideLimits(dense.limits, f)) return;
    const key = JSON.stringify(f);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const raise of [-15, 0, 15, 30, 60, 90, 95, 100])
    for (const shrug of girdle ? [-6, 0, 6] : [0])
      for (const tilt of [-10, 0, 10])
        for (const b of breathe ? [0, 1] : [0])
          for (const bend of [0, 30]) {
            const p: Pose = { [arm]: raise, [elbow]: bend };
            if (girdle && shrug) p[girdle] = shrug;
            if (tilt) p[lean] = tilt;
            if (b && breathe) {
              p[`${breathe.bone}.scaleX`] = breathe.x;
              p[`${breathe.bone}.scaleY`] = breathe.y;
            }
            add(p);
          }
  add({ [arm]: -15, [elbow]: 70 });
  return out;
}

/** Reduces a built dense rig to its sparse runtime rig (same code path for every preset). */
export function buildSparseRig(dense: SurfaceRig): SparseBuild {
  const started = Date.now();
  const preset = dense.built.preset;
  const t = runtimeTolerances(preset);
  const toCanvas = (gamePx: number) => gamePx / t.gameScale;
  const frames: (readonly Pt[])[] = Object.values(dense.targets).flat().filter((x) => x.ok).map((x) => x.x);
  //: the combined underarm poses (raise to the limit with shrug, lean and breathing together)
  // that the single-driver sweeps never reach; the reference is the dense rig document itself (what
  // the whole-body probe compares the reduced rig against), so the underarm patch follows it there.
  const combined = combinedPoses(dense);
  const densePoser = new Poser(dense.document, dense.built);
  for (const pose of combined) {
    densePoser.pose(pose);
    frames.push(densePoser.vertices(dense.built.skin));
  }
  // Garment outline samples are probes of the skin field: half the silhouette budget for the skin
  // reduction under them, half for the outline chords (reduceOutline), so the sum stays in budget.
  const probes = preset.garments.flatMap((g) => samplePath(g.path, dense.built.chain, g.spacing, true));
  const skin = reduceSkin(dense.built, frames, { silhouette: toCanvas(t.silhouette), texture: toCanvas(t.texture), probe: toCanvas(t.silhouette / 2), turn: t.turn, window: toCanvas(3) }, probes);
  const garments: Record<string, number[]> = {};
  const outlines: SparseBuild["outlines"] = {};
  // The garment's dense runtime (every sweep frame): the reference its reduced outline must follow.
  const poser = new Poser(dense.document, dense.built);
  const sweepPoses = Object.values(dense.frames).flat();
  const garmentFrames = dense.built.garments.map(() => [] as Pt[][]);
  for (const pose of sweepPoses) {
    poser.pose(pose);
    dense.built.garments.forEach((g, k) => (garmentFrames[k] as Pt[][]).push(poser.vertices(g)));
  }
  for (const [k, g] of preset.garments.entries()) {
    const r = reduceOutline(dense.built, g, frames, toCanvas(t.silhouette / 2), { mesh: dense.built.garments[k] as BuiltMesh, frames: garmentFrames[k] as Pt[][] });
    garments[g.name] = r.keep;
    outlines[g.name] = { kept: r.keep.length, total: r.total };
  }
  const reduction: SurfaceReduction = { skin: skin.keep, garments };
  const built = buildSurface(preset, reduction);
  built.patches.forEach((p, k) => {
    const d = dense.built.patches[k];
    if (d) Object.assign(p, { feasible: d.feasible, minBlendRatio: d.minBlendRatio });
  });
  built.skin.points.forEach((p, i) => {
    const q = dense.built.skin.points[skin.keep[i] as number] as Pt;
    if (dist(p, q) > 1e-9) throw new Error(`sparse skin vertex ${i} is not dense vertex ${skin.keep[i]}`);
  });
  const solver = new ReferenceSolver(built, { silhouette: toCanvas(0.25) }, dense.solver, skin.keep);
  const { document, report, bake } = seedCorrectives(built, solver, dense.limits);
  const contacts = measureContacts(built, loadAnimDocument({ ...document, animations: {} }), dense.limits);
  for (const b of contacts) report.push(`contact band ${b.name} (${b.pair.join(" vs ")}): ${b.cells.length} of ${b.sampled} ${b.x} x ${b.y} samples`);
  const { clips, frames: sweepFrames, clipped } = sweepClips(built, 30, dense.limits, contacts);
  const targets: Record<string, PoseTarget[]> = {};
  for (const [name, poses] of Object.entries(sweepFrames)) targets[name] = solver.along(poses);
  const raw = { ...document, ...(dense.limits.length + dense.clipLimits.length ? { poseLimits: [...dense.limits, ...dense.clipLimits].map((l) => ({ name: l.name, x: l.x, y: l.y, ...(l.plus ? { plus: l.plus } : {}), polygon: l.polygon })) } : {}), ...(contacts.length ? { contactBands: bandData(contacts) } : {}), animations: clips };
  const textures = new Map<string, RgbaImage>(dense.textures);
  for (const [k, v] of built.images) textures.set(k, v as RgbaImage);
  report.unshift(
    `sparse runtime (): skin ${dense.built.skin.points.length} -> ${built.skin.points.length} vertices (${dense.built.skin.hull} -> ${built.skin.hull} hull; removed ${skin.removedHull} hull, ${skin.removedInterior} interior; worst removed-vertex error over ${frames.length} frames: silhouette ${(skin.maxSilhouette * t.gameScale).toFixed(3)} / texture ${(skin.maxTexture * t.gameScale).toFixed(3)} game px; tolerances ${t.silhouette} / ${t.texture})`,
    ...dense.built.garments.map((g, k) => `garment ${g.slot}: ${g.points.length} -> ${built.garments[k]?.points.length} vertices (outline samples ${outlines[preset.garments[k]?.name ?? ""]?.kept}/${outlines[preset.garments[k]?.name ?? ""]?.total})`)
  );
  const buildMs = dense.buildMs + (Date.now() - started);
  const rj = skin.rejected;
  report.push(`sparse rejections: area floor ${rj.area} / texture ${rj.texture} / silhouette ${rj.silhouette} / turn ${rj.turn} / crossing ${rj.crossing + rj.exposed} / triangulation ${rj.triangulation}; protected lock ${rj.locked} vertices`);
  report.push(`sparse rig build ${((Date.now() - started) / 1000).toFixed(1)} s on top of the dense build (offline)`);
  return { rig: { built, document: loadAnimDocument(raw), raw, textures, frames: sweepFrames, report, solver, bake, targets, buildMs, limits: dense.limits, clipLimits: dense.clipLimits, clipped, contacts }, reduction, skin, outlines };
}

// --- measurement ---------------------------------------------------------------------------------

/** Max distance (canvas px) between two closed polylines, both ways, sampled at their vertices. */
function polygonGap(a: readonly Pt[], b: readonly Pt[]): number {
  const one = (p: Pt, poly: readonly Pt[]) => {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distanceToSegment(p, poly[i] as Pt, poly[(i + 1) % poly.length] as Pt));
    return best;
  };
  let worst = 0;
  for (const p of a) worst = Math.max(worst, one(p, b));
  for (const p of b) worst = Math.max(worst, one(p, a));
  return worst;
}

/**
 * The shared final-runtime pose set (finalPoses) of every rig given (dense and sparse grids may refine
 * differently): the silhouette comparison judges the same poses as the distortion gates.
 */
export function comparisonPoses(...rigs: SurfaceRig[]): { label: string; pose: Pose }[] {
  const out = new Map<string, { label: string; pose: Pose }>();
  for (const rig of rigs) for (const p of finalPoses(rig)) if (!out.has(p.label)) out.set(p.label, { label: `${p.origin} (${p.label})`, pose: p.pose });
  return [...out.values()];
}

const drawnMeshes = (built: BuiltSurface): BuiltMesh[] => [built.skin, ...built.garments];

/** Fill vertices submitted per frame: every mesh draw group / overlay range submits the vertices its triangles use. */
function submitted(built: BuiltSurface): { fill: number; ranges: number } {
  let fill = 0;
  let ranges = 0;
  for (const mesh of drawnMeshes(built)) {
    const groups = mesh.groups ? Object.values(mesh.groups).flat() : [[0, mesh.triangles.length / 3] as [number, number]];
    for (const [a, b] of groups) {
      const used = new Set<number>();
      for (let t = a * 3; t < b * 3; t++) used.add(mesh.triangles[t] as number);
      fill += used.size;
      ranges++;
    }
  }
  return { fill, ranges };
}

function contourVertices(raw: Record<string, unknown>): { points: number; vertices: number; strokes: number } {
  let points = 0, vertices = 0, strokes = 0;
  for (const skin of Object.values((raw.skins ?? {}) as Record<string, { contours?: Record<string, Record<string, { points: number[]; caps?: string }>> }>)) {
    for (const owner of Object.values(skin.contours ?? {})) {
      for (const c of Object.values(owner)) {
        points += c.points.length;
        vertices += strokeVertexCount(c.points.length, false, c.caps === "round");
        strokes++;
      }
    }
  }
  return { points, vertices, strokes };
}

function correctiveData(raw: Record<string, unknown>): { floats: number; keys: number; drivers: number; grids: number; jsonBytes: number } {
  let floats = 0, keys = 0;
  const count = (deform: unknown) => {
    JSON.stringify(deform ?? {}, (k, v) => {
      if (k === "vertices" && Array.isArray(v)) floats += v.length;
      return v;
    });
  };
  const driven = (raw.driven ?? []) as { keys?: { deform?: unknown }[] }[];
  const grids = (raw.drivenGrids ?? []) as { keys?: { deform?: unknown }[] }[];
  for (const d of [...driven, ...grids]) for (const k of d.keys ?? []) { keys++; count(k.deform); }
  return { floats, keys, drivers: driven.length, grids: grids.length, jsonBytes: JSON.stringify({ driven: raw.driven, drivenGrids: raw.drivenGrids }).length };
}

/** Mean CPU time (µs) of one runtime pose (skeleton + skinning + correctives) over the poses, with and without correctives. */
function poseCost(rig: SurfaceRig, poses: readonly Pose[]): { withCorrectives: number; without: number } {
  const time = (doc: AnimDocument) => {
    const poser = new Poser(doc, rig.built);
    const meshes = drawnMeshes(rig.built);
    for (let r = 0; r < 2; r++) for (const p of poses.slice(0, 20)) { poser.pose(p); meshes.forEach((m) => poser.vertices(m)); }
    const t0 = process.hrtime.bigint();
    let n = 0;
    for (let r = 0; r < 3; r++) for (const p of poses) { poser.pose(p); meshes.forEach((m) => poser.vertices(m)); n++; }
    return Number(process.hrtime.bigint() - t0) / 1000 / n;
  };
  const bare = loadAnimDocument({ ...rig.raw, driven: [], drivenGrids: [] });
  return { withCorrectives: Number(time(rig.document).toFixed(1)), without: Number(time(bare).toFixed(1)) };
}

/** Overdraw of the submitted fill triangles at a pose: covered samples summed over triangles / union (pixel centres at `scale` px per canvas px). */
function overdraw(rig: SurfaceRig, pose: Pose, scale: number): number {
  const poser = new Poser(rig.document, rig.built);
  poser.pose(pose);
  const cover = new Map<number, number>();
  let total = 0;
  for (const mesh of drawnMeshes(rig.built)) {
    const x = poser.vertices(mesh).map(([a, b]) => [a * scale, b * scale] as Pt);
    const groups = mesh.groups ? Object.values(mesh.groups).flat() : [[0, mesh.triangles.length / 3] as [number, number]];
    for (const [a, b] of groups) {
      for (let t = a; t < b; t++) {
        const p = x[mesh.triangles[t * 3] as number] as Pt, q = x[mesh.triangles[t * 3 + 1] as number] as Pt, r = x[mesh.triangles[t * 3 + 2] as number] as Pt;
        const x0 = Math.floor(Math.min(p[0], q[0], r[0])), x1 = Math.ceil(Math.max(p[0], q[0], r[0]));
        const y0 = Math.floor(Math.min(p[1], q[1], r[1])), y1 = Math.ceil(Math.max(p[1], q[1], r[1]));
        const e = (u: Pt, v: Pt, px: number, py: number) => (v[0] - u[0]) * (py - u[1]) - (v[1] - u[1]) * (px - u[0]);
        const area = e(p, q, r[0], r[1]);
        if (Math.abs(area) < 1e-9) continue;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const cx = xx + 0.5, cy = yy + 0.5;
            const w0 = e(q, r, cx, cy) / area, w1 = e(r, p, cx, cy) / area, w2 = e(p, q, cx, cy) / area;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const key = yy * 100000 + xx;
            cover.set(key, (cover.get(key) ?? 0) + 1);
            total++;
          }
        }
      }
    }
  }
  return cover.size ? total / cover.size : 1;
}

export interface SparseReport {
  vertices: { mesh: string; dense: number; sparse: number; denseEmbedded: number; sparseEmbedded: number; denseTriangles: number; sparseTriangles: number }[];
  skinnedPlusEmbedded: { dense: number; sparse: number };
  budget: { skin: { count: number; budget: number }; garment: { count: number; budget: number }; met: boolean; source: string };
  correctives: { dense: ReturnType<typeof correctiveData>; sparse: ReturnType<typeof correctiveData>; poseMicros: { dense: ReturnType<typeof poseCost>; sparse: ReturnType<typeof poseCost> } };
  submitted: { dense: { fill: number; contour: number; contourPoints: number }; sparse: { fill: number; contour: number; contourPoints: number } };
  drawSubmissions: { dense: number; sparse: number; note: string };
  overdraw: { dense: number; sparse: number; poses: number };
  silhouette: { poses: number; maxGamePx: number; worstAt: string; perMesh: Record<string, { maxGamePx: number; worstAt: string }> ; pass: boolean };
  visibleDistortion: { dense: ReturnType<typeof visibleDistortion>; sparse: ReturnType<typeof visibleDistortion> };
  reduction: { removedHull: number; removedInterior: number; maxSilhouetteGamePx: number; maxTextureGamePx: number; attempts: number; ms: number; outlines: SparseBuild["outlines"]; rejected: SkinReduction["rejected"] };
}

/** Dense vs sparse: counts, corrective cost, submitted geometry, overdraw, runtime silhouettes over motion. */
export function sparseReport(dense: SurfaceRig, sparse: SparseBuild): SparseReport {
  const budget = runtimeTolerances(dense.built.preset).budget;
  const s = sparse.rig;
  const gameScale = dense.built.preset.gamePixels / dense.built.preset.figureHeight;
  const vertices = drawnMeshes(dense.built).map((m, k) => {
    const sm = drawnMeshes(s.built)[k] as BuiltMesh;
    return { mesh: m.slot, dense: m.points.length, sparse: sm.points.length, denseEmbedded: m.embed?.vertices.length ?? 0, sparseEmbedded: sm.embed?.vertices.length ?? 0, denseTriangles: m.triangles.length / 3, sparseTriangles: sm.triangles.length / 3 };
  });
  const sum = (key: "dense" | "sparse") => vertices.reduce((a, v) => a + v[key], 0);
  const garmentCount = vertices.slice(1).reduce((a, v) => a + v.sparse, 0);
  const skinCount = vertices[0]?.sparse ?? 0;
  // Silhouettes over motion: posed hull polygons of every mesh, dense runtime vs sparse runtime.
  const poses = comparisonPoses(dense, s);
  const dp = new Poser(dense.document, dense.built);
  const sp = new Poser(s.document, s.built);
  const perMesh: SparseReport["silhouette"]["perMesh"] = {};
  let maxGap = 0;
  let worstAt = "";
  for (const { label, pose } of poses) {
    dp.pose(pose);
    sp.pose(pose);
    drawnMeshes(dense.built).forEach((m, k) => {
      const sm = drawnMeshes(s.built)[k] as BuiltMesh;
      const gap = polygonGap(dp.vertices(m).slice(0, m.hull), sp.vertices(sm).slice(0, sm.hull)) * gameScale;
      const entry = (perMesh[m.slot] ??= { maxGamePx: 0, worstAt: "" });
      if (gap > entry.maxGamePx) Object.assign(entry, { maxGamePx: Number(gap.toFixed(3)), worstAt: label });
      if (gap > maxGap) { maxGap = gap; worstAt = `${m.slot} ${label}`; }
    });
  }
  const sweepPoses = Object.values(dense.frames).flat();
  const odPoses = [{}, ...sweepPoses.filter((_, i) => i % Math.max(1, Math.floor(sweepPoses.length / 12)) === 0)];
  const od = (rig: SurfaceRig) => Number((odPoses.reduce((a, p) => a + overdraw(rig, p, 3 * gameScale), 0) / odPoses.length).toFixed(3));
  const draws = (rig: SurfaceRig) => submitted(rig.built).ranges + rig.built.preset.regions.length + contourVertices(rig.raw).strokes;
  const cv = (rig: SurfaceRig) => {
    const c = contourVertices(rig.raw);
    return { fill: submitted(rig.built).fill, contour: c.vertices, contourPoints: c.points };
  };
  return {
    vertices,
    skinnedPlusEmbedded: { dense: sum("dense"), sparse: sum("sparse") },
    budget: { skin: { count: skinCount, budget: budget.skin }, garment: { count: garmentCount, budget: budget.garment }, met: skinCount <= budget.skin && garmentCount <= budget.garment, source: "preset runtime.budget (provisional guards)" },
    correctives: { dense: correctiveData(dense.raw), sparse: correctiveData(s.raw), poseMicros: { dense: poseCost(dense, sweepPoses), sparse: poseCost(s, sweepPoses) } },
    submitted: { dense: cv(dense), sparse: cv(s) },
    drawSubmissions: { dense: draws(dense), sparse: draws(s), note: "mesh draw ranges + region attachments + contour strokes, before any renderer batching" },
    overdraw: { dense: od(dense), sparse: od(s), poses: odPoses.length },
    visibleDistortion: { dense: visibleDistortion(dense), sparse: visibleDistortion(s) },
    silhouette: { poses: poses.length, maxGamePx: Number(maxGap.toFixed(3)), worstAt, perMesh, pass: maxGap <= 0.25 + 1e-9 },
    reduction: { removedHull: sparse.skin.removedHull, removedInterior: sparse.skin.removedInterior, maxSilhouetteGamePx: Number((sparse.skin.maxSilhouette * gameScale).toFixed(3)), maxTextureGamePx: Number((sparse.skin.maxTexture * gameScale).toFixed(3)), attempts: sparse.skin.attempts, ms: sparse.skin.ms, outlines: sparse.outlines, rejected: sparse.skin.rejected }
  };
}

// --- visible distortion (note: hard gate from) -----------------------------------

/** Per triangle: the largest colour step between neighbouring texels inside its bind area (0..1). */
export function triangleContrast(mesh: BuiltMesh): number[] {
  const { image, origin } = mesh;
  const at = (x: number, y: number, k: number) => image.data[(y * image.width + x) * 4 + k] as number;
  const out: number[] = [];
  for (let t = 0; t < mesh.triangles.length / 3; t++) {
    const tri = [0, 1, 2].map((k) => {
      const p = mesh.points[mesh.triangles[t * 3 + k] as number] as Pt;
      return [p[0] - origin[0], p[1] - origin[1]] as Pt;
    });
    const x0 = Math.max(0, Math.floor(Math.min(...tri.map((p) => p[0])))), x1 = Math.min(image.width - 2, Math.ceil(Math.max(...tri.map((p) => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...tri.map((p) => p[1])))), y1 = Math.min(image.height - 2, Math.ceil(Math.max(...tri.map((p) => p[1]))));
    let worst = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!pointInPolygon([x + 0.5, y + 0.5], tri)) continue;
        let dx = 0, dy = 0;
        for (let k = 0; k < 3; k++) {
          dx += Math.abs(at(x + 1, y, k) - at(x, y, k));
          dy += Math.abs(at(x, y + 1, k) - at(x, y, k));
        }
        worst = Math.max(worst, dx / 765, dy / 765);
      }
    }
    out.push(worst);
  }
  return out;
}

/** Texture-contrast threshold (0..1) above which a triangle counts as textured. */
export const TEXTURED_CONTRAST = 0.06;
/** Visible-distortion allowances (note): textured outside / inside joint regions; flat triangles may only not collapse. */
export const VISIBLE_ALLOWANCES = {
  textured: { minDet: 0.2, maxDet: 5, maxStretch: 1.5, minStretch: 0.67, absGamePx: 0.25 },
  joint: { minDet: 0.2, maxDet: 5, maxStretch: 2, minStretch: 0.5, absGamePx: 0.25 },
  flat: { minDet: 0.2, maxDet: 1e9, maxStretch: 1e9, minStretch: 0, absGamePx: 0 }
};

/**
 * The validation companion re-split for the visible-distortion gate:
 * - flat: texture contrast at or below TEXTURED_CONTRAST (may stretch; may not collapse);
 * - opening:<name>:<region>: textured triangles whose three bind vertices all lie inside a
 *   preset-declared opening polygon (gates.visibleDistortion.openings): parked texture debt,
 *   reported, never passing;
 * - textured:<region>: everything else, limited (1.5 / 0.67, joint regions 2.0 / 0.5).
 * Hidden is not a static region: it is decided per finding on the posed rig (visibleDistortion).
 */
export function visibleCompanion(rig: SurfaceRig): ValidationCompanion {
  const base = validationCompanion(rig);
  const built = rig.built;
  const regions: ValidationCompanion["regions"] = {};
  const allowances: ValidationCompanion["allowances"] = { flat: VISIBLE_ALLOWANCES.flat };
  const openings = built.preset.gates?.visibleDistortion?.openings ?? [];
  const openingAt = (mesh: BuiltMesh, t: number): string | null => {
    for (const o of openings) if ([0, 1, 2].every((k) => pointInPolygon(mesh.points[mesh.triangles[t * 3 + k] as number] as Pt, o.polygon as Pt[]))) return o.name;
    return null;
  };
  for (const mesh of drawnMeshes(built)) {
    const key = `${mesh.slot}/${mesh.attachment}`;
    const declared = base.regions[key];
    const contrast = triangleContrast(mesh);
    const regionOf = (t: number) => {
      for (const [name, list] of Object.entries(declared?.triangles ?? {})) if (list.includes(t)) return name;
      return declared?.default ?? "default";
    };
    const tri: Record<string, number[]> = {};
    contrast.forEach((c, t) => {
      const open = c > TEXTURED_CONTRAST ? openingAt(mesh, t) : null;
      const name = !(c > TEXTURED_CONTRAST) ? "flat" : open ? `opening:${open}:${regionOf(t)}` : `textured:${regionOf(t)}`;
      allowances[name] ??= name.includes(":joint:") ? VISIBLE_ALLOWANCES.joint : VISIBLE_ALLOWANCES.textured;
      (tri[name] ??= []).push(t);
    });
    regions[key] = { default: "flat", triangles: tri };
  }
  return { ...base, regions, allowances, exceptions: [] };
}

/**
 * Visible distortion over the shared final-runtime pose set: error findings, distinct triangles,
 * textured triangle count and the worst. A finding is hidden (dropped, counted) only when, at that
 * pose, all three posed vertices lie inside the posed outline of a garment drawn above the
 * triangle's group (skin), or inside triangles of any group drawn above it (any mesh: a garment's
 * body piece under its own overlay piece). Findings in declared openings are parked (reported, not passing).
 */
export function visibleDistortion(rig: SurfaceRig): { errors: number; triangles: number; textured: number; worst: string; opening: { errors: number; triangles: number; worst: string; declared: string[] }; hidden: { findings: number; triangles: number }; excused: { findings: number; ids: string[] } } {
  const companion = visibleCompanion(rig);
  const { findings } = surfaceDistortion(rig, companion);
  const built = rig.built;
  const declared = (built.preset.gates?.visibleDistortion?.exceptions ?? []).filter((e) => !e.rigHash || e.rigHash === rigHash(rig.document));
  const window = (label: string) => Object.fromEntries(label === "setup" ? [] : label.split(",").map((kv) => [kv.split("=")[0] as string, Number(kv.split("=")[1])]));
  const excusedBy = (f: GeometryFinding) =>
    declared.find((e) => e.id === f.id && Object.entries(e.poses).every(([bone, [lo, hi]]) => {
      const v = window(f.pose)[bone] ?? 0;
      return v >= lo - 1e-6 && v <= hi + 1e-6;
    }));
  // Posed visibility, cached per pose.
  const skinKey = `${built.skin.slot}/${built.skin.attachment}`;
  const poseOf = new Map(companion.poses.map((p) => [p.name, joinPose(p.rotate, p.scale)]));
  const order = built.drawOrder;
  const poser = new Poser(rig.document, built);
  const posed = new Map<string, { skin: Pt[]; hulls: { at: number; hull: Pt[] }[]; meshes: Pt[][] }>();
  // Every drawn mesh with its triangles' draw slots (a garment overlay is a group of its garment).
  const meshes = [built.skin, ...built.garments];
  const slotOf = (m: BuiltMesh, t: number): string => {
    for (const [slot, ranges] of Object.entries(m.groups ?? {})) if (ranges.some(([lo, hi]) => t >= lo && t < hi)) return slot;
    return m.slot;
  };
  const drawAt = meshes.map((m) => Array.from({ length: m.triangles.length / 3 }, (_, t) => order.indexOf(slotOf(m, t))));
  const inTriangle = (q: Pt, a: Pt, b: Pt, c: Pt) => pointInPolygon(q, [a, b, c]);
  const posedAt = (label: string) => {
    let p = posed.get(label);
    if (!p) {
      poser.pose(poseOf.get(label) ?? {});
      p = { skin: poser.vertices(built.skin), hulls: built.garments.map((g) => ({ at: order.indexOf(g.slot), hull: poser.vertices(g).slice(0, g.hull) })), meshes: meshes.map((m) => poser.vertices(m)) };
      posed.set(label, p);
    }
    return p;
  };
  const hiddenAt = (f: GeometryFinding): boolean => {
    const t = Number(f.id.slice(f.id.lastIndexOf("/t") + 2));
    const p = posedAt(f.pose);
    if (f.mesh === skinKey) {
      const at = order.indexOf(built.groupSlots[built.triangleGroups[t] as number] as string);
      if (p.hulls.some((g) => g.at > at && [0, 1, 2].every((k) => pointInPolygon(p.skin[built.skin.triangles[t * 3 + k] as number] as Pt, g.hull)))) return true;
    }
    // Any mesh: all three posed vertices inside triangles drawn above it (e.g. a garment's body-piece
    // triangle under its own overlay piece).
    const mi = meshes.findIndex((m) => `${m.slot}/${m.attachment}` === f.mesh);
    const m = meshes[mi];
    if (!m) return false;
    const own = drawAt[mi]?.[t] ?? -1;
    return [0, 1, 2].every((k) => {
      const q = (p.meshes[mi] as Pt[])[m.triangles[t * 3 + k] as number] as Pt;
      return meshes.some((om, oi) => {
        const ov = p.meshes[oi] as Pt[];
        const at = drawAt[oi] as number[];
        for (let u = 0; u < at.length; u++) if ((at[u] as number) > own && inTriangle(q, ov[om.triangles[u * 3] as number] as Pt, ov[om.triangles[u * 3 + 1] as number] as Pt, ov[om.triangles[u * 3 + 2] as number] as Pt)) return true;
        return false;
      });
    });
  };
  const excused = findings.filter((f) => f.severity === "error" && excusedBy(f));
  const live = findings.filter((f) => f.severity === "error" && !excusedBy(f));
  const hiddenSet = new Set(live.filter(hiddenAt));
  const hidden = [...hiddenSet];
  const all = live.filter((f) => !hiddenSet.has(f));
  const inOpening = all.filter((f) => f.region.startsWith("opening:"));
  const errors = all.filter((f) => !f.region.startsWith("opening:"));
  const worstOf = (list: typeof all) => {
    const w = list.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    return w ? `${w.id} @ ${w.pose}: ${w.kind} ${w.value} (${w.absGamePx} game px)` : "";
  };
  const opening = { errors: inOpening.length, triangles: new Set(inOpening.map((f) => f.id)).size, worst: worstOf(inOpening), declared: (built.preset.gates?.visibleDistortion?.openings ?? []).map((o) => `${o.name} (${o.debt})`) };
  const textured = Object.values(companion.regions).reduce((a, r) => a + Object.entries(r.triangles).filter(([k]) => k.startsWith("textured:")).reduce((b, [, l]) => b + l.length, 0), 0);
  return { errors: errors.length, triangles: new Set(errors.map((f) => f.id)).size, textured, worst: worstOf(errors), opening, hidden: { findings: hidden.length, triangles: new Set(hidden.map((f) => f.id)).size }, excused: { findings: excused.length, ids: [...new Set(excused.map((f) => f.id))] } };
}
