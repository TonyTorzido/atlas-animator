/*
 * Atlas Animator: original implementation.
 *
 * Clothing model, skeleton side (close): which pieces cover a contour this frame and its
 * visible runs (core/coverage.ts does the geometry). Kept out of the Skeleton class: its state lives
 * in a per-skeleton holder (more Skeleton fields cost the hot paths, src/pixi/allocation.test.ts).
 */
import { isDrawable, isGroupedMesh, type Attachment, type MeshAttachment } from "./attachments.js";
import type { CompiledContour } from "./contours.js";
import { COVER_ALPHA, coverIntervals, mergeIntervals, visibleRuns } from "./coverage.js";
import { Skeleton } from "./skeleton.js";
import type { Slot } from "./slot.js";
import { appendHandover, appendTrimFillet, handoverCut, MAX_FILLETS } from "./trimFillet.js";

/*
 * Buffers: `posed` holds the contour's posed points for the rigid
 * coverers of one call (kept for the whole call); `setup` the setup-pose points of a skin-space
 * cache fill and `world` coverer vertices (both temporary: overwritten by the next coverer). They
 * never alias, so a cache fill in the middle of a call cannot change the points later coverers use.
 * Skin-space cache key: contour id, coverer attachment id and draw-group index, under the outfit
 * (activeSkins identity) the setup skeleton was built for; an outfit change drops the cache and
 * the setup skeleton. Ids past the key's fields are not cached (computed each call).
 */
interface CoverState {
  drawPositionVersion: number;
  drawPosition: Int32Array;
  cache: Map<number, number[]>;
  /** ridesOwnMaterial results (coverer id, group, contour slot), dropped with the cache. */
  material: Map<string, boolean>;
  skins: readonly string[] | null;
  posed: Float32Array;
  setup: Float32Array;
  world: Float32Array;
  scratch: number[];
  rigid: number[];
  opaque: Float32Array;
  bind: Skeleton | null;
  memo: { covered: number[]; runs: number[] | null; buf: number[] }[];
  fillets: number[];
  capped: number[];
  partner: Float32Array;
  /** handoversOf: per found end, its run index (pairs), end bit (0 start, 1 end) and cut parameter. */
  hand: number[];
  /** handoversOf: the bridge pieces of the over side (fillet layout). */
  bridges: number[];
  /** handoversOf scratch for the under side's discarded bridge points. */
  dropped: number[];
  /** contourHandoverRunsOf result. */
  handRuns: number[];
  handPartner: Float32Array;
}

const states = new WeakMap<Skeleton, CoverState>();

/*
 * Skin-space intervals by content. A rebuilt skeleton (every Setup edit remounts the rig) starts with
 * a cold per-skeleton cache, and filling it dominates the commit; but the intervals are a pure function
 * of the contour's setup points, the coverer's setup world vertices and triangles, and the reach, so
 * an edit that leaves those alone (a weights stroke keeps the setup pose) finds them here. Keys hash
 * the exact float bits twice (two independent 32-bit mixes) plus the sizes.
 */
let memoOn = false;
/** Turns the content memo on or off. Off by default: the per-frame playback path allocates nothing (allocation.test.ts); an editor in a static-pose mode (Setup) turns it on. */
export function setCoverMemo(on: boolean): void {
  memoOn = on;
  if (!on) intervalMemo.clear();
}
const intervalMemo = new Map<string, readonly number[]>();
const INTERVAL_MEMO_MAX = 6000;
const bitsF = new Float64Array(1);
const bitsU = new Uint32Array(bitsF.buffer);

function hashInto(h: Uint32Array, data: ArrayLike<number>, count: number): void {
  let a = h[0] as number;
  let b = h[1] as number;
  for (let i = 0; i < count; i++) {
    bitsF[0] = data[i] as number;
    a = Math.imul(a ^ (bitsU[0] as number), 0x01000193);
    a = Math.imul(a ^ (bitsU[1] as number), 0x01000193);
    b = Math.imul((b + (bitsU[0] as number)) ^ (b >>> 15), 0x85ebca6b);
    b = Math.imul((b ^ (bitsU[1] as number)) + 0x9e3779b9, 0xc2b2ae35);
  }
  h[0] = a;
  h[1] = b;
}

const hashScratch = new Uint32Array(2);
function intervalKey(points: ArrayLike<number>, pointCount: number, closed: boolean, reach: number, world: ArrayLike<number>, tris: ArrayLike<number>, any: boolean): string {
  // Only the vertices the triangles name matter (the world buffer may be a larger scratch with stale data past them).
  let top = 0;
  for (let i = 0; i < tris.length; i++) if ((tris[i] as number) > top) top = tris[i] as number;
  const used = Math.min(world.length, top * 2 + 2);
  hashScratch[0] = 0x811c9dc5;
  hashScratch[1] = 0x1234567;
  hashInto(hashScratch, points, pointCount * 2);
  hashInto(hashScratch, world, used);
  hashInto(hashScratch, tris, tris.length);
  hashInto(hashScratch, [reach], 1);
  return `${pointCount}:${closed ? 1 : 0}:${any ? 1 : 0}:${used}:${tris.length}:${hashScratch[0]}:${hashScratch[1]}`;
}

/** coverIntervals for the skin-space cache fill, reusing an earlier identical computation (see intervalMemo). */
function coverIntervalsMemo(points: ArrayLike<number>, pointCount: number, closed: boolean, reach: number, world: ArrayLike<number>, tris: ArrayLike<number>, out: number[], any = false): void {
  if (!memoOn) {
    coverIntervals(points, pointCount, closed, reach, world, tris, out, any);
    return;
  }
  const key = intervalKey(points, pointCount, closed, reach, world, tris, any);
  const hit = intervalMemo.get(key);
  if (hit) {
    for (let i = 0; i < hit.length; i++) out.push(hit[i] as number);
    return;
  }
  const mark = out.length;
  coverIntervals(points, pointCount, closed, reach, world, tris, out, any);
  if (intervalMemo.size >= INTERVAL_MEMO_MAX) intervalMemo.clear();
  intervalMemo.set(key, out.slice(mark));
}
const newState = (): CoverState => ({ drawPositionVersion: -1, drawPosition: new Int32Array(0), cache: new Map(), material: new Map(), skins: null, posed: new Float32Array(64), setup: new Float32Array(64), world: new Float32Array(256), scratch: [], rigid: [], opaque: new Float32Array(64), bind: null, memo: [], fillets: [], capped: [], partner: new Float32Array(64), hand: [], bridges: [], dropped: [], handRuns: [], handPartner: new Float32Array(64) });

/** A private skeleton of the same document at the setup pose (skin-space coverage). */
function bindSkeleton(sk: Skeleton, st: CoverState): Skeleton {
  let bind = st.bind;
  if (!bind) {
    bind = st.bind = new Skeleton(sk.document);
    bind.setActiveSkins(sk.activeSkins);
    bind.setToSetupPose();
    bind.updateWorldTransform("none");
  }
  return bind;
}

/** See Skeleton.contourRuns. */
export function contourRunsOf(sk: Skeleton, contour: CompiledContour, points?: ArrayLike<number>): number[] | null {
  let st = states.get(sk);
  if (!st) states.set(sk, (st = newState()));
  if (st.skins !== sk.activeSkins) {
    // Outfit changed: the skin-space intervals and the setup skeleton belong to the old one.
    st.skins = sk.activeSkins;
    st.cache.clear();
    st.material.clear();
    st.bind = null;
  }
    if (st.drawPositionVersion !== sk.drawOrderVersion || st.drawPosition.length !== sk.slots.length) {
      if (st.drawPosition.length !== sk.slots.length) st.drawPosition = new Int32Array(sk.slots.length);
      for (let i = 0; i < sk.drawOrder.length; i++) st.drawPosition[(sk.drawOrder[i] as Slot).index] = i;
      st.drawPositionVersion = sk.drawOrderVersion;
    }
    const own = sk.contourSlot(contour)?.index ?? -1;
    if (own < 0) return null;
    const coverSlot = contour.coverFrom ? sk.findSlot(contour.coverFrom) : null;
    const from = Math.min(st.drawPosition[own] as number, coverSlot ? (st.drawPosition[coverSlot.index] as number) : Infinity) + 1;
    const covered = st.scratch;
    covered.length = 0;
    const reach = contour.width / 2;
    let pts: ArrayLike<number> | null = points ?? null;
    const mesh = contour.mesh;
    const surface = mesh ? surfaceRoot(mesh) : null;
    // Arm layer: the under-sheet slot (drawn earlier) is visited first, then the slots drawn after.
    const under = contour.coverUnder ? sk.findSlot(contour.coverUnder) : null;
    const underAt = under ? (st.drawPosition[under.index] as number) : -1;
    for (let i = underAt >= 0 && underAt < from ? from - 1 : from; i < sk.drawOrder.length; i++) {
      const slot = (i === from - 1 ? under : sk.drawOrder[i]) as Slot;
      if (slot.hidden || !slot.bone.active) continue;
      const group = slot.groupMesh;
      const attachment: Attachment | null = group ?? slot.attachment;
      if (!attachment || !isDrawable(attachment) || (!group && isGroupedMesh(attachment))) continue;
      if (slot.color.a * slot.drivenAlpha * attachment.color.a < COVER_ALPHA) continue;
      // A joined partner's slot (the fist whose outline continues this stroke) never trims it: the
      // join meets the partner's line, and a trim there opens a gap at the join.
      if (joinedSlot(contour, slot.data.name)) continue;
      if (mesh && attachment.type === "mesh" && (attachment === mesh || attachment.deformOwner === mesh.deformOwner)) continue;
      // The surface a contour rides never trims it: its other regions slide over it (an arm over the
      // torso) and painter's order handles that.
      if (surface && attachment.type === "mesh" && (attachment === surface || attachment.deformOwner === surface.deformOwner)) continue;
      const tris: ArrayLike<number> = group
        ? ((group.geometry.groups?.[slot.groupIndex]?.triangles ?? EMPTY_TRIS) as ArrayLike<number>)
        : attachment.type === "mesh"
          ? attachment.geometry.triangles
          : (attachment.opaqueTriangles ?? attachment.triangles);
      if (!tris.length) continue;
      const invariant = surface !== null && attachment.type === "mesh" && surfaceRoot(attachment) === surface && attachment.id < 65536 && contour.id < 65536 && (!group || slot.groupIndex < 63) && ridesOwnMaterial(st, surface, attachment, group ? slot.groupIndex : -1, sk.contourSlot(contour)?.data.name ?? "");
      const key = invariant ? (contour.id * 65536 + attachment.id) * 64 + (group ? slot.groupIndex + 1 : 0) : -1;
      let iv = invariant ? st.cache.get(key) : undefined;
      if (!iv && invariant) {
        // Skin space: both ride one surface, so the interval is taken at the setup pose (a private
        // setup-pose skeleton) and holds in every pose; sliding overlaps of other surface regions
        // (an arm over the torso) are painter's order, not trims.
        iv = [];
        const bind = bindSkeleton(sk, st);
        if (st.setup.length < contour.pointCount * 2) st.setup = new Float32Array(contour.pointCount * 2);
        bind.rawContourPoints(contour, st.setup);
        const source = attachment as MeshAttachment;
        const meshWorld = bind.meshWorldVertices(source, (bind.slots[(group ? sk.slots.find((s2) => s2.attachment === group) ?? slot : slot).index] as Slot).bone);
        let world: ArrayLike<number> = meshWorld;
        if (group) {
          const gv = (group.geometry.groups?.[slot.groupIndex]?.vertices ?? EMPTY_TRIS) as ArrayLike<number>;
          if (st.world.length < gv.length * 2) st.world = new Float32Array(gv.length * 4);
          for (let v = 0; v < gv.length; v++) {
            st.world[v * 2] = meshWorld[(gv[v] as number) * 2] as number;
            st.world[v * 2 + 1] = meshWorld[(gv[v] as number) * 2 + 1] as number;
          }
          world = st.world;
        }
        coverIntervalsMemo(st.setup, contour.pointCount, contour.closed, reach, world, tris, iv);
        st.cache.set(key, iv);
      }
      if (!iv) {
        iv = st.rigid;
        iv.length = 0;
        if (!pts) {
          if (st.posed.length < contour.pointCount * 2) st.posed = new Float32Array(contour.pointCount * 2);
          sk.computeContourPoints(contour, st.posed);
          pts = st.posed;
        }
        const floats = Math.max(sk.slotWorldFloats(slot), 8);
        if (st.world.length < floats) st.world = new Float32Array(floats * 2);
        let world: Float32Array = st.world;
        if (group) sk.computeGroupWorldVertices(slot, world);
        else sk.computeSlotWorldVertices(slot, world);
        if (attachment.type === "region" && attachment.opaque) {
          if (st.opaque.length < attachment.opaque.length) st.opaque = new Float32Array(attachment.opaque.length);
          world = opaqueWorld(world, attachment.opaque, st.opaque);
        }
        const rigid = attachment.type === "region";
        coverIntervalsMemo(pts, contour.pointCount, contour.closed, (rigid && contour.trimAtOutline) || slot === under || contour.coverTight ? 0 : reach, world, tris, iv, rigid);
      }
      for (let k = 0; k < iv.length; k++) covered.push(iv[k] as number);
    }
    if (!covered.length) return null;
    mergeIntervals(covered);
    let memo = st.memo[contour.id];
    if (memo && memo.covered.length === covered.length) {
      let same = true;
      for (let k = 0; k < covered.length && same; k++) if (Math.abs((memo.covered[k] as number) - (covered[k] as number)) > 1e-9) same = false;
      if (same) return memo.runs;
    }
    memo ??= st.memo[contour.id] = { covered: [], runs: null, buf: [] };
    memo.covered.length = 0;
    for (let k = 0; k < covered.length; k++) memo.covered.push(covered[k] as number);
    memo.runs = visibleRuns(covered, contour.pointCount, contour.closed, memo.buf);
    return memo.runs;
  }

/**
 * See Skeleton.contourFillets. For a contour with `coverUnder`: each trimmed end of an open visible
 * run that meets a trimmed end of an under-sheet contour (within one width: the arm's closing edge
 * entering the torso beside the torso outline entering the arm) gets the fillet piece of that
 * corner (core/trimFillet.ts). Null when there is none. The returned array is owned and reused.
 */
export function contourFilletsOf(sk: Skeleton, contour: CompiledContour, points: ArrayLike<number>): number[] | null {
  if (!contour.coverUnder || contour.closed) return null;
  const runs = contourRunsOf(sk, contour, points);
  if (!runs || !runs.length) return null;
  const st = states.get(sk) as CoverState;
  const out = st.fillets;
  out.length = 0;
  const L = contour.pointCount - 1;
  const w = contour.width;
  let found = 0;
  for (const other of sk.activeContours) {
    if (found >= MAX_FILLETS) break;
    if (other === contour || other.slot !== contour.coverUnder || other.closed || !sk.isContourVisible(other)) continue;
    if (st.partner.length < other.pointCount * 2) st.partner = new Float32Array(other.pointCount * 4);
    const bPts = st.partner;
    sk.computeContourPoints(other, bPts);
    // Its runs (memo per contour: this contour's runs array stays valid).
    const bRuns = contourRunsOf(sk, other, bPts);
    if (!bRuns || !bRuns.length) continue;
    const LB = other.pointCount - 1;
    for (let r = 0; r + 1 < runs.length && found < MAX_FILLETS; r += 2) {
      for (let e = 0; e < 2 && found < MAX_FILLETS; e++) {
        const ta = runs[r + e] as number;
        if (e === 0 ? ta <= 1e-9 : ta >= L - 1e-9) continue;
        const limitA = runs[r + 1 - e] as number;
        const ax = pointX(points, contour.pointCount, ta);
        const ay = pointY;
        for (let q = 0; q + 1 < bRuns.length && found < MAX_FILLETS; q += 2) {
          for (let f = 0; f < 2; f++) {
            const tb = bRuns[q + f] as number;
            if (f === 0 ? tb <= 1e-9 : tb >= LB - 1e-9) continue;
            const bx = pointX(bPts, other.pointCount, tb);
            if (Math.hypot(bx - ax, pointY - ay) > w) continue;
            if (appendTrimFillet(points, contour.pointCount, ta, e === 0 ? 1 : -1, limitA, bPts, other.pointCount, tb, f === 0 ? 1 : -1, bRuns[q + 1 - f] as number, w, out)) found++;
          }
        }
      }
    }
  }
  // Hand-over bridges of the wide corners (the fillet takes the narrow ones).
  if (handoversOf(sk, contour, points, st) > 0) {
    const b = st.bridges;
    for (let o = 0; o < b.length && found < MAX_FILLETS; found++) {
      const n = b[o] as number;
      for (let k = 0; k <= n * 2; k++) out.push(b[o + k] as number);
      o += 1 + n * 2;
    }
  }
  return found ? out : null;
}

/**
 * Hand-over bridges (core/trimFillet.ts appendHandover) at this contour's trimmed ends: as the over
 * line (contour.coverUnder: its partners are the under sheet's open contours) and as the under line
 * (partners: open contours whose coverUnder is this contour's slot). Both sides find the same pairs
 * with the same arguments (over line first), so the two cuts and the one bridge agree. Fills st.hand
 * (per end: run index, end bit, cut parameter) and, for the over side only, st.bridges. Returns the
 * number of ends found.
 */
function handoversOf(sk: Skeleton, contour: CompiledContour, points: ArrayLike<number>, st: CoverState): number {
  const hand = st.hand;
  hand.length = 0;
  st.bridges.length = 0;
  if (contour.closed) return 0;
  const runs = contourRunsOf(sk, contour, points);
  if (!runs || !runs.length) return 0;
  const w = contour.width;
  for (const other of sk.activeContours) {
    if (other === contour || other.closed || other.skin !== contour.skin || other.width !== w || !sk.isContourVisible(other)) continue;
    const over = contour.coverUnder !== "" && other.slot === contour.coverUnder;
    if (!over && !(other.coverUnder !== "" && other.coverUnder === contour.slot)) continue;
    if (st.handPartner.length < other.pointCount * 2) st.handPartner = new Float32Array(other.pointCount * 4);
    const oPts = st.handPartner;
    sk.computeContourPoints(other, oPts);
    const oRuns = contourRunsOf(sk, other, oPts);
    if (!oRuns || !oRuns.length) continue;
    const aPts = over ? points : oPts;
    const bPts = over ? oPts : points;
    const aC = over ? contour : other;
    const bC = over ? other : contour;
    const aRuns = over ? runs : oRuns;
    const bRuns = over ? oRuns : runs;
    const LA = aC.pointCount - 1;
    const LB = bC.pointCount - 1;
    for (let r = 0; r + 1 < aRuns.length; r += 2) {
      for (let e = 0; e < 2; e++) {
        const ta = aRuns[r + e] as number;
        if (e === 0 ? ta <= 1e-9 : ta >= LA - 1e-9) continue;
        const ax = pointX(aPts, aC.pointCount, ta);
        const ay = pointY;
        for (let q = 0; q + 1 < bRuns.length; q += 2) {
          for (let f = 0; f < 2; f++) {
            const tb = bRuns[q + f] as number;
            if (f === 0 ? tb <= 1e-9 : tb >= LB - 1e-9) continue;
            if (Math.hypot(pointX(bPts, bC.pointCount, tb) - ax, pointY - ay) > w) continue;
            const sink = over ? st.bridges : st.dropped;
            const mark = sink.length;
            if (!appendHandover(aPts, aC.pointCount, ta, e === 0 ? 1 : -1, aRuns[r + 1 - e] as number, bPts, bC.pointCount, tb, f === 0 ? 1 : -1, bRuns[q + 1 - f] as number, w, sink)) continue;
            if (!over) sink.length = mark;
            hand.push(over ? r : q, over ? e : f, over ? (handoverCut[0] as number) : (handoverCut[1] as number));
          }
        }
      }
    }
  }
  return hand.length / 3;
}

/**
 * See Skeleton.contourHandoverRuns: the contour's visible runs with each hand-over end cut back to
 * its bridge end; null when it has none (draw the runs as they are). Owned and reused.
 */
export function contourHandoverRunsOf(sk: Skeleton, contour: CompiledContour, points: ArrayLike<number>): number[] | null {
  let st = states.get(sk);
  if (!st) states.set(sk, (st = newState()));
  if (handoversOf(sk, contour, points, st) === 0) return null;
  const runs = contourRunsOf(sk, contour, points) as number[];
  const out = st.handRuns;
  out.length = 0;
  for (let k = 0; k < runs.length; k++) out.push(runs[k] as number);
  const hand = st.hand;
  for (let h = 0; h < hand.length; h += 3) out[(hand[h] as number) + (hand[h + 1] as number)] = hand[h + 2] as number;
  return out;
}

/**
 * A trim end closer than half a width plus this (canvas px) to another visible line is capped (see
 * contourCappedEndsOf): its ink touches that line's band.
 */
const CAP_REACH = 1.5;

/**
 * See Skeleton.contourCappedEnds. Per visible run, bit 0 / bit 1 when its start / end is a trim
 * touching a visible, fully opaque run of another open contour of the same skin and width (within
 * half a width + CAP_REACH of its centreline: a trim at an under-sheet line, or a trim half a width
 * short of a coverer's edge that the coverer's own line runs along): where two lines meet, a
 * feather would show beside the other line (an under-sheet line is drawn earlier; an oblique
 * coverer edge leaves the feather's corner outside it), while a full round cap is the round join
 * of the two lines (or lies under the later one). Null when there is none.
 */
export function contourCappedEndsOf(sk: Skeleton, contour: CompiledContour, points: ArrayLike<number>): number[] | null {
  if (contour.closed) return null;
  const runs = contourRunsOf(sk, contour, points);
  if (!runs || !runs.length) return null;
  const st = states.get(sk) as CoverState;
  const out = st.capped;
  out.length = runs.length / 2;
  out.fill(0);
  const L = contour.pointCount - 1;
  let any = false;
  // A tight contour (coverTight: trimmed at each coverer's outline, mesh or opaque region) caps every
  // trim end: the run stops on the coverer's edge, the cap's far half lies under the coverer drawn
  // later, and no feather is left beside an edge the coverer's art may not fill to (the torso line
  // under the head's neck, line-end gate).
  if (contour.coverTight) {
    for (let r = 0; r + 1 < runs.length; r += 2) {
      if ((runs[r] as number) > 1e-9) out[r / 2] = (out[r / 2] as number) | 1;
      if ((runs[r + 1] as number) < L - 1e-9) out[r / 2] = (out[r / 2] as number) | 2;
    }
    any = true;
  }
  for (const other of sk.activeContours) {
    if (other === contour || other.skin !== contour.skin || other.closed || other.width !== contour.width || !sk.isContourVisible(other)) continue;
    if (other.color.a * sk.contourOwnerAlpha(other) < 0.99) continue;
    if (st.partner.length < other.pointCount * 2) st.partner = new Float32Array(other.pointCount * 4);
    const bPts = st.partner;
    sk.computeContourPoints(other, bPts);
    const bRuns = contourRunsOf(sk, other, bPts);
    if (bRuns && !bRuns.length) continue;
    for (let r = 0; r + 1 < runs.length; r += 2) {
      for (let e = 0; e < 2; e++) {
        const t = runs[r + e] as number;
        if (e === 0 ? t <= 1e-9 : t >= L - 1e-9) continue;
        const x = pointX(points, contour.pointCount, t);
        const y = pointY;
        if (distToRuns(bPts, other.pointCount, bRuns, x, y) <= contour.width / 2 + CAP_REACH) {
          out[r / 2] = (out[r / 2] as number) | (1 << e);
          any = true;
        }
      }
    }
  }
  // A hand-over end continues into its bridge (full ink, the cap under the bridge's band).
  if (handoversOf(sk, contour, points, st) > 0) {
    const hand = st.hand;
    for (let h = 0; h < hand.length; h += 3) out[(hand[h] as number) / 2] = (out[(hand[h] as number) / 2] as number) | (1 << (hand[h + 1] as number));
    any = true;
  }
  return any ? out : null;
}

/** Distance from (x, y) to the visible runs (null: all) of an open polyline. */
function distToRuns(pts: ArrayLike<number>, count: number, runs: readonly number[] | null, x: number, y: number): number {
  let best = Infinity;
  const n = runs ? runs.length : 2;
  for (let q = 0; q + 1 < n; q += 2) {
    const r0 = runs ? (runs[q] as number) : 0;
    const r1 = runs ? (runs[q + 1] as number) : count - 1;
    for (let k = Math.floor(r0); k < Math.ceil(r1) && k < count - 1; k++) {
      const t0 = Math.max(r0, k);
      const t1 = Math.min(r1, k + 1);
      if (t1 < t0) continue;
      const ax = pointX(pts, count, t0);
      const ay = pointY;
      const bx = pointX(pts, count, t1);
      const by = pointY;
      const ex = bx - ax;
      const ey = by - ay;
      const l2 = ex * ex + ey * ey;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - ex * u, y - ay - ey * u));
    }
  }
  return best;
}

let pointY = 0;
/** x of an open polyline at parameter t (y left in pointY). */
function pointX(points: ArrayLike<number>, count: number, t: number): number {
  let k = Math.floor(t);
  if (k >= count - 1) k = count - 2;
  if (k < 0) k = 0;
  const f = Math.min(1, Math.max(0, t - k));
  pointY = (points[k * 2 + 1] as number) + ((points[k * 2 + 3] as number) - (points[k * 2 + 1] as number)) * f;
  return (points[k * 2] as number) + ((points[k * 2 + 2] as number) - (points[k * 2] as number)) * f;
}

/**
 * Material coverage: a coverer that shares the contour's surface root
 * keeps its setup-pose interval in every pose only when it rides the contour's own material, i.e.
 * every surface vertex its (group's) embedded vertices reference belongs to the root's draw group
 * drawn in the contour's slot. A coverer of other material (a sleeve over the torso flank at rest)
 * is a transient overlap: posed coverage. An ungrouped root is one material. Cached per state.
 */
function ridesOwnMaterial(st: CoverState, root: MeshAttachment, coverer: MeshAttachment, groupIndex: number, contourSlot: string): boolean {
  const rootGroups = root.geometry.groups;
  if (!rootGroups) return true;
  const key = `${coverer.id}:${groupIndex}:${contourSlot}`;
  const known = st.material.get(key);
  if (known !== undefined) return known;
  let ok = false;
  const own = rootGroups.find((g) => g.slot === contourSlot);
  const embed = coverer.geometry.embed;
  if (own && embed && coverer.embedSource === root) {
    const inGroup = new Uint8Array(root.geometry.vertexCount);
    for (let i = 0; i < own.vertices.length; i++) inGroup[own.vertices[i] as number] = 1;
    const at = new Int32Array(coverer.geometry.vertexCount).fill(-1);
    for (let i = 0; i < embed.vertices.length; i++) at[embed.vertices[i] as number] = i;
    const used = groupIndex >= 0 ? (coverer.geometry.groups?.[groupIndex]?.vertices ?? new Uint32Array(0)) : Uint32Array.from({ length: coverer.geometry.vertexCount }, (_, i) => i);
    ok = true;
    for (let i = 0; i < used.length && ok; i++) {
      const e = at[used[i] as number] as number;
      if (e < 0) { ok = false; break; }
      for (let k = 0; k < 3; k++) if ((embed.refWeights[e * 3 + k] as number) !== 0 && !inGroup[embed.refs[e * 3 + k] as number]) ok = false;
    }
  }
  st.material.set(key, ok);
  return ok;
}

/** The mesh a mesh's vertices ultimately ride: itself, or (fully embedded) its embed source's root. */
function surfaceRoot(mesh: MeshAttachment): MeshAttachment | null {
  let m: MeshAttachment = mesh;
  for (let depth = 0; depth < 8; depth++) {
    const source = m.embedSource;
    if (!source) return m;
    const embed = m.geometry.embed;
    if (!embed || embed.vertices.length !== m.geometry.vertexCount) return null;
    m = source;
  }
  return null;
}

const EMPTY_TRIS = new Uint16Array(0);

/** A region's opaque outline (u, v of the image) in world space from its posed corners TL, TR, BR, BL. */
function opaqueWorld(corners: ArrayLike<number>, opaque: Float32Array, out: Float32Array): Float32Array {
  const x0 = corners[0] as number;
  const y0 = corners[1] as number;
  const ux = (corners[2] as number) - x0;
  const uy = (corners[3] as number) - y0;
  const vx = (corners[6] as number) - x0;
  const vy = (corners[7] as number) - y0;
  for (let i = 0; i < opaque.length; i += 2) {
    const u = opaque[i] as number;
    const v = opaque[i + 1] as number;
    out[i] = x0 + ux * u + vx * v;
    out[i + 1] = y0 + uy * u + vy * v;
  }
  return out;
}

function joinedSlot(contour: CompiledContour, slot: string): boolean {
  const joins = contour.joins;
  for (let i = 0; i < joins.length; i++) if ((joins[i] as { otherSlot: string }).otherSlot === slot) return true;
  return false;
}
