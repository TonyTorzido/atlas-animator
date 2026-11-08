/*
 * Atlas Animator: original implementation.
 *
 * ABANDONED (armour, pose rule): simple fitted armour reuses the jacket/shirt template (body-derived
 * core, neckline, cross-arm cuff cuts, hem). Do not use capCut for new garments; kept for the record.
 *
 * Short cap / sleeveless armhole cuts for fitted garments. The 
 * leather crossed the upper arm at 35% and, because the body has no boundary there (arm and torso
 * skin are one surface down to the underarm slit apex), continued the cut down the shoulder seam on
 * the TORSO side to the apex. The arm material between that seam cut and the apex was left uncovered:
 * at rest it is arm skin drawn over the torso garment with no line of its own (the arm's inner line
 * only starts at the apex), and the cap's stroke ends in a stub on the arm; on a raise the cut's
 * inner end stays with the torso while its outer end follows the arm, so the cap became a triangular
 * flap.
 *
 * A cap cut is built entirely on the limb's own material instead: from the limb's OUTER boundary at
 * `along` of shoulder -> elbow to the limb's own underarm boundary (the slit edge) `underarm` canvas
 * px below the slit apex. Every point lies on the limb group, so the whole cap rides the arm, the
 * cut's ends are on the body boundary (outer silhouette, underarm line), and the cap's stroke ends
 * where the body's arm line continues.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { materialAt, skinData, type GarmentCut, type MaterialPoint, type SkinData } from "./garmentSurface.js";

type Pt = [number, number];

export interface CapCutOptions {
  name: string;
  /** The limb draw group the cap covers the top of (e.g. upper_arm). */
  group: string;
  /** The next group down the limb (its slot's bone is the elbow), e.g. forearm. */
  next: string;
  /** Fraction of shoulder -> elbow where the cut meets the limb's outer boundary. */
  along: number;
  /** Canvas px along the limb's underarm boundary from the slit apex to the cut's inner end. */
  underarm: number;
  /** Sample spacing along the cut (canvas px), default 2. */
  step?: number;
}

const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Boundary edges of the skin (one triangle), with the group of that triangle. */
function boundaryEdges(sd: SkinData): { a: number; b: number; group: string }[] {
  const seen = new Map<string, { a: number; b: number; t: number; n: number }>();
  for (let t = 0; t < sd.nT; t++) for (let k = 0; k < 3; k++) {
    const a = sd.T[t * 3 + k] as number, b = sd.T[t * 3 + ((k + 1) % 3)] as number;
    const e = seen.get(ek(a, b));
    if (e) e.n++;
    else seen.set(ek(a, b), { a, b, t, n: 1 });
  }
  return [...seen.values()].filter((e) => e.n === 1).map((e) => ({ a: e.a, b: e.b, group: sd.groupOf[e.t] as string }));
}

/** Walks a boundary chain of `group` from vertex `start` (first edge `first`) for `len` px; returns the point. */
function walk(sd: SkinData, edges: { a: number; b: number; group: string }[], start: number, firstNext: number, len: number): Pt {
  let prev = start;
  let cur = firstNext;
  let left = len;
  for (let guard = 0; guard < 10000; guard++) {
    const p = sd.P[prev] as Pt, q = sd.P[cur] as Pt;
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l >= left) return [p[0] + ((q[0] - p[0]) * left) / l, p[1] + ((q[1] - p[1]) * left) / l];
    left -= l;
    const nxt = edges.find((e) => (e.a === cur || e.b === cur) && (e.a === cur ? e.b : e.a) !== prev);
    if (!nxt) return q;
    prev = cur;
    cur = nxt.a === cur ? nxt.b : nxt.a;
  }
  throw new Error("capCut: boundary walk did not end");
}

/** A cap cut on `group` (see the module comment). Throws when a cut point leaves the group. */
export function capCut(raw: any, skin: { slot: string; attachment: string }, o: CapCutOptions): GarmentCut {
  const sd = skinData(raw, skin);
  const trunk = skin.slot;
  const doc = loadAnimDocument(raw);
  const sk = new Skeleton(doc);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const ox = raw.canvas.originX as number, oy = raw.canvas.originY as number;
  const boneAt = (slot: string): Pt => { const b = sk.getSlot(slot).bone; return [b.world.x + ox, b.world.y + oy]; };
  const sh = boneAt(o.group);
  const el = boneAt(o.next);
  const axis: Pt = [el[0] - sh[0], el[1] - sh[1]];
  const axisLen = Math.hypot(axis[0], axis[1]);
  const u: Pt = [axis[0] / axisLen, axis[1] / axisLen];
  const proj = (p: Pt) => ((p[0] - sh[0]) * u[0] + (p[1] - sh[1]) * u[1]) / axisLen;
  const edges = boundaryEdges(sd);
  const limbE = edges.filter((e) => e.group === o.group);
  const trunkV = new Set(edges.filter((e) => e.group === trunk).flatMap((e) => [e.a, e.b]));
  // limb boundary vertices shared with the trunk's boundary: the shoulder-top junction and the slit apex
  const shared = [...new Set(limbE.flatMap((e) => [e.a, e.b]))].filter((v) => trunkV.has(v));
  if (shared.length < 2) throw new Error(`capCut ${o.name}: ${o.group} meets the ${trunk} boundary at ${shared.length} vertices (want the shoulder top and the underarm apex)`);
  const dEl = (v: number) => Math.hypot((sd.P[v] as Pt)[0] - el[0], (sd.P[v] as Pt)[1] - el[1]);
  shared.sort((a, b) => dEl(a) - dEl(b));
  const apex = shared[0] as number;
  const top = shared[shared.length - 1] as number;
  const nextOf = (v: number) => limbE.filter((e) => e.a === v || e.b === v).map((e) => (e.a === v ? e.b : e.a));
  // underarm: from the apex along the limb's own boundary (the slit edge)
  const apexNext = nextOf(apex);
  if (!apexNext.length) throw new Error(`capCut ${o.name}: no ${o.group} boundary at the apex`);
  const inner = walk(sd, limbE, apex, apexNext[0] as number, o.underarm);
  // outer: from the shoulder-top junction down the limb's outer boundary to the projection `along`
  const topNext = nextOf(top);
  let outer: Pt | null = null;
  for (const first of topNext) {
    let prev = top;
    let cur = first;
    for (let guard = 0; guard < 10000 && !outer; guard++) {
      const p = sd.P[prev] as Pt, q = sd.P[cur] as Pt;
      const tp = proj(p), tq = proj(q);
      if ((tp - o.along) * (tq - o.along) <= 0 && tq !== tp) { const s = (o.along - tp) / (tq - tp); outer = [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s]; break; }
      const nxt = limbE.find((e) => (e.a === cur || e.b === cur) && (e.a === cur ? e.b : e.a) !== prev);
      if (!nxt || cur === apex) break;
      prev = cur;
      cur = nxt.a === cur ? nxt.b : nxt.a;
    }
    if (outer) break;
  }
  if (!outer) throw new Error(`capCut ${o.name}: the outer boundary of ${o.group} never reaches ${o.along} of shoulder -> elbow`);
  // the straight cut, nudged onto the group at the ends (boundary points can round outside it)
  const step = o.step ?? 2;
  const len = Math.hypot(inner[0] - outer[0], inner[1] - outer[1]);
  const n = Math.max(2, Math.ceil(len / step));
  const points: MaterialPoint[] = [];
  for (let k = 0; k <= n; k++) {
    const s = k / n;
    const p: Pt = [outer[0] + (inner[0] - outer[0]) * s, outer[1] + (inner[1] - outer[1]) * s];
    let mp = materialAt(sd, p, [o.group]);
    for (let e = 0.05; !mp && e <= 1; e += 0.05) {
      const c: Pt = [p[0] + ((outer[0] + inner[0]) / 2 - p[0]) * (e / Math.max(1, len / 2)), p[1] + ((outer[1] + inner[1]) / 2 - p[1]) * (e / Math.max(1, len / 2))];
      mp = materialAt(sd, c, [o.group]);
    }
    if (!mp) throw new Error(`capCut ${o.name}: point ${p.map((v) => v.toFixed(1))} is not on ${o.group}`);
    points.push(mp);
  }
  return { name: o.name, kind: "cuff", groups: [o.group], points };
}
