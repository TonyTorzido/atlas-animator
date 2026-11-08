/*
 * Atlas Animator: original implementation.
 *
 * Garment closure: what a dressed character shows inside the
 * garment's promised coverage, read from a soft render with ids (tools/softRender.ts) at the
 * resolution the player sees (0.4 view and 1x). The leather passed every gate while the
 * short cap's lower stroke ended in a dark stub on the arm, with uninked arm skin between it and the
 * flank outline: nothing measured whether the garment's drawn outline is CLOSED.
 *
 * Pixel classes: garment fabric (G: a garment slot's texel), ink (I: any runtime contour, or a
 * caller-declared ink pixel such as the head's or a hard plate's painted outline), body fill (B: any other slot's
 * texel), background (O), neutral (N: ignored). Three checks:
 * - uninked edges: a G pixel 4-adjacent to a B or O pixel is an edge with no line between the
 *   garment and what is next to it (a stroke gap on the silhouette, or body skin drawn over the
 *   garment with no outline of its own, e.g. arm skin over the torso); runs of at least `minRun`
 *   such pixels (8-connected) count; a body pixel within 1 px of its own part's outline is that
 *   part's antialiased rim (the occluder's line is right there) and does not count;
 * - dangling stubs: the garment strokes joined end to end into paths (joinChains); along each
 *   path centreline, each end of a visible run (garment ink) must meet another line: where the run
 *   goes under another part, ink within half a stroke width + 1.5 px past the last garment ink
 *   sample (the occluder's own outline), or, at a junction, corner or true path end, other ink within
 *   one width + 1.5 px away from the path's own stroke; an end on a body line's end (the
 *   underarm apex, the body's own line end) is exempt; otherwise the stroke ends in open fabric,
 *   skin or air;
 * - body lines inside coverage: a body contour pixel with no body fill and no background within
 *   one body stroke width (+1 px) sits wholly inside the garment.
 */
import type { Skeleton } from "../core/skeleton.js";
import { softRender } from "./softRender.js";
import type { RgbaImage } from "./image.js";

export type ClosureClass = "G" | "I" | "B" | "O" | "N";

export interface ClosureChain {
  /** Centreline in output pixels (x, y pairs). */
  pts: ArrayLike<number>;
  n: number;
  closed: boolean;
  /** Stroke width in output pixels. */
  width: number;
}

export interface ClosureFrame {
  width: number;
  height: number;
  /** Per pixel class (see ClosureClass). */
  cls: Uint8Array;
  /** Per pixel: 1 where the ink belongs to the garment (its own strokes). */
  garmentInk: Uint8Array;
  chains: ClosureChain[];
  /** Per pixel: the top slot (index + 1; 0 = none), the user slot for ink. */
  slot?: Int16Array;
  /** Body stroke width in output pixels (for the body-line radius). */
  bodyStrokePx: number;
  /**
   * Where the body's own lines end (output px, e.g. the underarm slit apex): a garment path that
   * ends within one width + 1.5 px of one ends where the body's line does (the armpit), not a stub.
   */
  bodyLineEnds?: [number, number][];
}

export const CLS = { G: 1, I: 2, B: 3, O: 4, N: 0 } as const;

/** Luminance below which a texel of a non-garment slot is painted outline ink (the head, plates). */
export const PAINTED_INK_LUM = 90;

/** Minimum uninked edge run (pixels, 8-connected) per output scale: 2 at the 0.4 view, 3 at 1x. */
export const closureMinRun = (scale: number): number => (scale < 0.7 ? 2 : 3);

export interface ClosureResult {
  uninkedPx: number;
  uninkedRuns: { x: number; y: number; px: number }[];
  stubs: { x: number; y: number }[];
  bodyLinePx: number;
  bodyLineRuns: { x: number; y: number; px: number }[];
  /** Pixels to mark in review crops. */
  marks: number[];
  ok: boolean;
}

/**
 * Builds a closure frame from a soft render with ids: `garmentSlot(top)` says whether a slot
 * (index + 1) is the garment's, `inkAt(i)` may declare extra ink (painted plate outlines) and
 * `neutralAt(i)` pixels to ignore.
 */
export function closureFrame(
  r: { width: number; height: number; topSlot: Int16Array; topTexel: Int32Array },
  garmentSlot: (top: number) => boolean,
  chains: ClosureChain[],
  bodyStrokePx: number,
  opts: { bodyLineEnds?: [number, number][]; inkAt?: (i: number) => boolean; neutralAt?: (i: number) => boolean } = {}
): ClosureFrame {
  const n = r.width * r.height;
  const cls = new Uint8Array(n);
  const garmentInk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const top = r.topSlot[i] as number;
    const texel = r.topTexel[i] as number;
    if (top <= 0) cls[i] = CLS.O;
    else if (texel < 0) { cls[i] = CLS.I; if (garmentSlot(top)) garmentInk[i] = 1; }
    else if (opts.inkAt?.(i)) cls[i] = CLS.I;
    else if (opts.neutralAt?.(i)) cls[i] = CLS.N;
    else cls[i] = garmentSlot(top) ? CLS.G : CLS.B;
  }
  return { width: r.width, height: r.height, cls, garmentInk, chains, slot: r.topSlot, bodyStrokePx, ...(opts.bodyLineEnds ? { bodyLineEnds: opts.bodyLineEnds } : {}) };
}

function clusters(width: number, idx: number[], minRun: number): { x: number; y: number; px: number; members: number[] }[] {
  const left = new Set(idx);
  const out: { x: number; y: number; px: number; members: number[] }[] = [];
  for (const seed of idx) {
    if (!left.has(seed)) continue;
    const comp = [seed];
    left.delete(seed);
    for (let k = 0; k < comp.length; k++) {
      const c = comp[k] as number;
      const cx = c % width;
      for (const d of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) {
        const q = c + d;
        if (!left.has(q) || Math.abs((q % width) - cx) > 1) continue;
        left.delete(q);
        comp.push(q);
      }
    }
    if (comp.length >= minRun) out.push({ x: comp[0] as number % width, y: Math.floor((comp[0] as number) / width), px: comp.length, members: comp });
  }
  return out;
}

/**
 * Garment strokes meeting end to end (within 1.5 px, same width) joined into longer paths, closed
 * when a path comes back to its start: a corner between two runs (cut -> side outline) is then the
 * inside of one path, not two ends.
 */
export function joinChains(chains: readonly ClosureChain[]): ClosureChain[] {
  const paths: { pts: number[]; width: number; closed: boolean }[] = chains.map((c) => ({ pts: Array.from(c.pts as ArrayLike<number>).slice(0, c.n * 2), width: c.width, closed: c.closed }));
  const end = (p: number[], last: boolean): [number, number] => (last ? [p[p.length - 2] as number, p[p.length - 1] as number] : [p[0] as number, p[1] as number]);
  const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1.5;
  const rev = (p: number[]) => { const o: number[] = []; for (let k = p.length - 2; k >= 0; k -= 2) o.push(p[k] as number, p[k + 1] as number); return o; };
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < paths.length && !merged; a++) {
      const A = paths[a]!;
      if (A.closed) continue;
      for (let b = 0; b < paths.length; b++) {
        if (b === a) continue;
        const B = paths[b]!;
        if (B.closed || Math.abs(B.width - A.width) > 1e-6) continue;
        let joined: number[] | null = null;
        if (close(end(A.pts, true), end(B.pts, false))) joined = [...A.pts, ...B.pts.slice(2)];
        else if (close(end(A.pts, true), end(B.pts, true))) joined = [...A.pts, ...rev(B.pts).slice(2)];
        else if (close(end(A.pts, false), end(B.pts, true))) joined = [...B.pts, ...A.pts.slice(2)];
        else if (close(end(A.pts, false), end(B.pts, false))) joined = [...rev(B.pts), ...A.pts.slice(2)];
        if (!joined) continue;
        A.pts = joined;
        paths.splice(b, 1);
        merged = true;
        break;
      }
    }
  }
  for (const p of paths) if (!p.closed && p.pts.length >= 6 && close(end(p.pts, false), end(p.pts, true))) { p.pts = p.pts.slice(0, -2); p.closed = true; }
  return paths.map((p) => ({ pts: p.pts, n: p.pts.length / 2, closed: p.closed, width: p.width }));
}

export function closureCheck(f: ClosureFrame, minRun: number): ClosureResult {
  const { width: W, height: H, cls } = f;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? CLS.N : (cls[y * W + x] as number));
  // a body pixel next to its own part's outline (within 1 px) is that part's antialiased rim: the
  // occluder's line is right there (a head over a sleeve), not an uninked edge
  const ownRim = (x: number, y: number): boolean => {
    if (!f.slot) return false;
    const s0 = f.slot[y * W + x] as number;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H && cls[Y * W + X] === CLS.I && !f.garmentInk[Y * W + X] && f.slot[Y * W + X] === s0) return true; }
    return false;
  };
  // uninked edges
  const edge: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (cls[y * W + x] !== CLS.G) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = at(x + dx, y + dy);
      if (c === CLS.O || (c === CLS.B && !ownRim(x + dx, y + dy))) { edge.push(y * W + x); break; }
    }
  }
  const runs = clusters(W, edge, minRun);
  // dangling stubs
  const stubs: { x: number; y: number }[] = [];
  const inkAt = (x: number, y: number) => at(Math.floor(x), Math.floor(y)) === CLS.I;
  const gInk = (x: number, y: number) => { const X = Math.floor(x), Y = Math.floor(y); return X >= 0 && Y >= 0 && X < W && Y < H && f.garmentInk[Y * W + X] === 1; };
  for (const ch of joinChains(f.chains)) {
    if (ch.n < 2) continue;
    const S: [number, number, number, number][] = []; // x, y, tx, ty
    const segs = ch.closed ? ch.n : ch.n - 1;
    for (let k = 0; k < segs; k++) {
      const a = k, b = (k + 1) % ch.n;
      const ax = ch.pts[a * 2] as number, ay = ch.pts[a * 2 + 1] as number;
      const bx = ch.pts[b * 2] as number, by = ch.pts[b * 2 + 1] as number;
      const l = Math.hypot(bx - ax, by - ay);
      if (l < 1e-6) continue;
      const steps = Math.max(1, Math.ceil(l / 0.5));
      for (let s = 0; s < steps; s++) S.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, (bx - ax) / l, (by - ay) / l]);
    }
    if (!ch.closed) { const e = S[S.length - 1]; if (e) S.push([ch.pts[(ch.n - 1) * 2] as number, ch.pts[(ch.n - 1) * 2 + 1] as number, e[2], e[3]]); }
    if (S.length < 2) continue;
    const vis = S.map((s) => gInk(s[0], s[1]));
    const w = ch.width;
    const meets = (i: number, dir: 1 | -1): boolean => {
      const s = S[i] as [number, number, number, number];
      // where the run goes under another part (or stops), that part's own line must be right there:
      // ink within half a width + 1.5 px of centreline past the last garment ink sample
      let first = -1;
      for (let j = i + dir; j >= 0 && j < S.length; j += dir) if (!vis[j]) { first = j; break; }
      if (first >= 0) {
        const reach = 0.5 * w + 1.5;
        for (let j = first; j >= 0 && j < S.length && Math.abs(j - i) * 0.5 <= reach; j += dir) {
          const q = S[j] as [number, number, number, number];
          if (inkAt(q[0], q[1])) return true;
        }
      }
      // else (a junction or corner, or a true path end): other ink within w + 1.5 px of the end, away
      // from the path's own stroke (pixels farther than w / 2 + 1 from its centreline, 3 widths back
      // and 1 ahead); an end where a body line ends (the armpit apex) is the body's own end
      if ((f.bodyLineEnds ?? []).some((e) => Math.hypot(e[0] - s[0], e[1] - s[1]) <= w + 1.5)) return true;
      const own: [number, number][] = [];
      for (let j = i, k = 0; j >= 0 && j < S.length && k * 0.5 <= 3 * w; j -= dir, k++) own.push([(S[j] as number[])[0] as number, (S[j] as number[])[1] as number]);
      for (let j = i + dir, k = 1; j >= 0 && j < S.length && k * 0.5 <= w; j += dir, k++) own.push([(S[j] as number[])[0] as number, (S[j] as number[])[1] as number]);
      const R = w + 1.5;
      const near = w / 2 + 1;
      for (let y = Math.floor(s[1] - R); y <= s[1] + R; y++) for (let x = Math.floor(s[0] - R); x <= s[0] + R; x++) {
        if ((x + 0.5 - s[0]) ** 2 + (y + 0.5 - s[1]) ** 2 > R * R || !inkAt(x, y)) continue;
        if (own.some((o) => (x + 0.5 - o[0]) ** 2 + (y + 0.5 - o[1]) ** 2 <= near * near)) continue;
        return true;
      }
      return false;
    };
    const offImage = (s: [number, number, number, number]) => s[0] < 2 || s[1] < 2 || s[0] >= W - 2 || s[1] >= H - 2;
    for (let i = 0; i < S.length; i++) {
      if (!vis[i]) continue;
      const startEnd = i === 0 ? !ch.closed : !vis[i - 1];
      const endEnd = i === S.length - 1 ? !ch.closed : !vis[i + 1];
      // a run shorter than one width is a speck under an occluder edge, not a stroke end
      if (startEnd) { let j = i; while (j < S.length - 1 && vis[j + 1]) j++; if ((j - i) * 0.5 < w * 0.5) { i = j; continue; } }
      const s = S[i] as [number, number, number, number];
      if (offImage(s)) continue;
      if (startEnd && !meets(i, -1)) stubs.push({ x: Math.round(s[0]), y: Math.round(s[1]) });
      if (endEnd && !meets(i, 1)) stubs.push({ x: Math.round(s[0]), y: Math.round(s[1]) });
    }
  }
  // body lines inside the coverage
  const r = Math.ceil(f.bodyStrokePx) + 1;
  const bodyLine: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (cls[i] !== CLS.I || f.garmentInk[i]) continue;
    let open = false;
    let garment = false;
    for (let dy = -r; dy <= r && !open; dy++) for (let dx = -r; dx <= r; dx++) {
      const c = at(x + dx, y + dy);
      if (c === CLS.B || c === CLS.O) { open = true; break; }
      if (c === CLS.G) garment = true;
    }
    if (!open && garment) bodyLine.push(i);
  }
  const bodyRuns = clusters(W, bodyLine, 1);
  const uninkedPx = runs.reduce((s, c) => s + c.px, 0);
  const bodyLinePx = bodyRuns.reduce((s, c) => s + c.px, 0);
  const marks = [...runs.flatMap((c) => c.members), ...bodyRuns.flatMap((c) => c.members), ...stubs.map((s) => s.y * W + s.x)];
  return {
    uninkedPx,
    uninkedRuns: runs.map(({ x, y, px }) => ({ x, y, px })),
    stubs,
    bodyLinePx,
    bodyLineRuns: bodyRuns.map(({ x, y, px }) => ({ x, y, px })),
    marks,
    ok: uninkedPx === 0 && stubs.length === 0 && bodyLinePx === 0
  };
}

/**
 * The damaged controls, made from a frame that passes: each must FAIL its check.
 * - gap: the garment ink within one stroke width of the middle of the longest chain's visible part
 *   becomes background (a stroke gap on the silhouette);
 * - stub: a stroke 3 widths long starting deep in the fabric (a fragment ending in open fabric);
 * - bodyLine: a body contour bar (1 x 4 body stroke widths) deep inside the fabric;
 * - skin: a disc of body fill (radius 2 stroke widths) deep inside the fabric (exposed skin).
 * Returns null for a control when the frame has no place for it.
 */
export function closureControls(f: ClosureFrame, minRun: number): Record<"gap" | "stub" | "bodyLine" | "skin", { failsAsRequired: boolean; at: string } | null> {
  const { width: W, height: H } = f;
  const clone = (): ClosureFrame => ({ ...f, cls: f.cls.slice(), garmentInk: f.garmentInk.slice(), chains: [...f.chains] });
  // the deepest fabric pixel (the largest distance to a non-fabric pixel, chessboard)
  const dist = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = f.cls[i] === CLS.G ? 1 << 20 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!dist[i]) continue; const up = y ? (dist[i - W] as number) : 0; const lf = x ? (dist[i - 1] as number) : 0; dist[i] = Math.min(dist[i] as number, up + 1, lf + 1); }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (!dist[i]) continue; const dn = y < H - 1 ? (dist[i + W] as number) : 0; const rt = x < W - 1 ? (dist[i + 1] as number) : 0; dist[i] = Math.min(dist[i] as number, dn + 1, rt + 1); }
  let deep = -1;
  for (let i = 0; i < W * H; i++) if (deep < 0 || (dist[i] as number) > (dist[deep] as number)) deep = i;
  const w = Math.max(1, ...f.chains.map((c) => c.width));
  const dx0 = deep % W, dy0 = Math.floor(deep / W);
  const out: Record<"gap" | "stub" | "bodyLine" | "skin", { failsAsRequired: boolean; at: string } | null> = { gap: null, stub: null, bodyLine: null, skin: null };
  if (deep >= 0 && (dist[deep] as number) > 2 * w + 1) {
    {
      const c = clone();
      const len = 3 * w;
      const pts = [dx0 - len / 2, dy0, dx0 + len / 2, dy0];
      for (let y = Math.floor(dy0 - w / 2); y <= dy0 + w / 2; y++) for (let x = Math.floor(dx0 - len / 2); x <= dx0 + len / 2; x++) { c.cls[y * W + x] = CLS.I; c.garmentInk[y * W + x] = 1; }
      c.chains.push({ pts, n: 2, closed: false, width: w });
      const r = closureCheck(c, minRun);
      out.stub = { failsAsRequired: r.stubs.length > 0, at: `${dx0},${dy0}` };
    }
    {
      const c = clone();
      const bw = Math.max(1, Math.round(f.bodyStrokePx));
      for (let y = dy0 - bw; y <= dy0 + bw; y++) for (let x = dx0 - Math.floor(bw / 2); x <= dx0 + Math.floor(bw / 2); x++) c.cls[y * W + x] = CLS.I;
      const r = closureCheck(c, minRun);
      out.bodyLine = { failsAsRequired: r.bodyLinePx > 0, at: `${dx0},${dy0}` };
    }
    {
      const c = clone();
      const rr = 2 * w;
      for (let y = Math.floor(dy0 - rr); y <= dy0 + rr; y++) for (let x = Math.floor(dx0 - rr); x <= dx0 + rr; x++) if ((x - dx0) ** 2 + (y - dy0) ** 2 <= rr * rr) c.cls[y * W + x] = CLS.B;
      const r = closureCheck(c, minRun);
      out.skin = { failsAsRequired: r.uninkedPx > 0, at: `${dx0},${dy0}` };
    }
  }
  // gap: the visible middle of the longest chain
  let best: ClosureChain | null = null;
  for (const ch of f.chains) if (!best || ch.n > best.n) best = ch;
  if (best) {
    const vis: [number, number][] = [];
    for (let k = 0; k < best.n; k++) { const x = best.pts[k * 2] as number, y = best.pts[k * 2 + 1] as number; const X = Math.floor(x), Y = Math.floor(y); if (X >= 0 && Y >= 0 && X < W && Y < H && f.garmentInk[Y * W + X]) vis.push([x, y]); }
    const m = vis[Math.floor(vis.length / 2)];
    if (m) {
      const c = clone();
      const rr = best.width + 1;
      for (let y = Math.floor(m[1] - rr); y <= m[1] + rr; y++) for (let x = Math.floor(m[0] - rr); x <= m[0] + rr; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (f.garmentInk[i] && (x - m[0]) ** 2 + (y - m[1]) ** 2 <= rr * rr) { c.cls[i] = CLS.O; c.garmentInk[i] = 0; }
      }
      const r = closureCheck(c, minRun);
      out.gap = { failsAsRequired: r.uninkedPx > 0 || r.stubs.length > 0, at: `${Math.round(m[0])},${Math.round(m[1])}` };
    }
  }
  return out;
}

/**
 * Renders the posed skeleton at `scale` over the window (world left/top, size in world px) and
 * runs the closure check. Garment slots: names in `garmentSlots`; their visible contours are the
 * chains. `inkSlots` (e.g. hard plates): their dark painted pixels (luminance < 90) are ink, the
 * rest neutral.
 */
export function renderClosure(
  sk: Skeleton,
  tex: ReadonlyMap<string, RgbaImage>,
  win: { left: number; top: number; width: number; height: number },
  scale: number,
  garmentSlots: ReadonlySet<string>,
  opts: { inkSlots?: ReadonlySet<string>; bodyStroke?: number } = {}
): { frame: ClosureFrame; result: ClosureResult; image: RgbaImage } {
  const W = Math.round(win.width * scale);
  const H = Math.round(win.height * scale);
  const R = softRender(sk, tex, { width: W, height: H, scale, left: win.left, top: win.top, ids: true, background: [180, 185, 194] });
  const gIdx = new Set<number>();
  const plateIdx = new Set<number>();
  for (const s of sk.slots) { if (garmentSlots.has(s.data.name)) gIdx.add(s.index + 1); if (opts.inkSlots?.has(s.data.name)) plateIdx.add(s.index + 1); }
  const chains: ClosureChain[] = [];
  let bodyStroke = opts.bodyStroke ?? 0;
  const bodyLineEnds: [number, number][] = [];
  for (const c of sk.activeContours) {
    const garment = garmentSlots.has(sk.contourSlot(c).data.name);
    if (!garment && c.closed) continue;
    if (garment && !sk.isContourVisible(c)) continue;
    const pts = new Float32Array(c.pointCount * 2);
    sk.computeContourPoints(c, pts);
    for (let k = 0; k < c.pointCount; k++) { pts[k * 2] = ((pts[k * 2] as number) - win.left) * scale; pts[k * 2 + 1] = ((pts[k * 2 + 1] as number) - win.top) * scale; }
    if (!garment) {
      // the body's open lines, visible or under the garment: their ends
      if (sk.isContourVisible(c)) bodyStroke = Math.max(bodyStroke, c.width);
      bodyLineEnds.push([pts[0] as number, pts[1] as number], [pts[(c.pointCount - 1) * 2] as number, pts[(c.pointCount - 1) * 2 + 1] as number]);
      continue;
    }
    chains.push({ pts, n: c.pointCount, closed: c.closed, width: c.width * scale });
  }
  const top = R.topSlot as Int16Array;
  const img = R.image;
  const isPlate = (i: number) => plateIdx.has(top[i] as number);
  const lum = (i: number) => 0.299 * (img.data[i * 4] as number) + 0.587 * (img.data[i * 4 + 1] as number) + 0.114 * (img.data[i * 4 + 2] as number);
  const frame = closureFrame({ width: W, height: H, topSlot: top, topTexel: R.topTexel as Int32Array }, (t) => gIdx.has(t), chains, bodyStroke * scale, {
    bodyLineEnds,
    // painted outlines of non-garment art (the head is a region with its outline in its texture, a hard
    // plate's outline is painted): dark texels of any other slot are ink
    inkAt: (i) => !gIdx.has(top[i] as number) && lum(i) < PAINTED_INK_LUM,
    neutralAt: (i) => isPlate(i)
  });
  return { frame, result: closureCheck(frame, closureMinRun(scale)), image: img };
}
