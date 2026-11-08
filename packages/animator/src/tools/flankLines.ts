/*
 * Atlas Animator: original implementation.
 *
 * Doubled flank line (the importer's flankSingleLine gate). The defect the gate exists for
 * is a second LINE beside the torso's side outline below the armpit: a thin dark run that follows the
 * outline's direction close to it, so the side reads as a doubled outline.
 * The earlier metric flagged any texel darker than the fabric within 3 stroke widths, which also
 * caught the design itself reaching the outline (a belt, quilt seams, mail rings) and pushed the art
 * to leave a blank strip on each flank.
 *
 * Here a dark texel counts only when it lies on a thin run (at most maxThick px across the local
 * outline direction) that runs at least minLen px ALONG the local outline direction (one-texel
 * antialiasing gaps bridged). The local direction is the principal axis of the outline (stroke)
 * texels near the texel's nearest stroke texel, so the measure follows a slanted flank as well as a
 * vertical one. A horizontal belt (wide across the flank), a diagonal quilt seam (its run along the
 * flank is short) and mail rings (short arcs) do not count; a parallel stroke a few px inside does.
 * Pure functions over window masks; the importer builds the windows from its rest render.
 */

/** One scan window beside a flank anchor: per-texel masks, row-major, width x height. */
export interface FlankWindow {
  readonly width: number;
  readonly height: number;
  /** darker than the local paint tone (flankDarkMask) and not the stroke or the stroke's antialiased edge */
  readonly dark: Uint8Array;
  /** the garment's outline stroke (outlineStroke: trim lines in the stroke colour are paint) */
  readonly stroke: Uint8Array;
  /** opaque, not stroke (where paint can sit) */
  readonly inside: Uint8Array;
}

export interface FlankLineOptions {
  /** a run along the outline at least this long (px) is a line */
  readonly minLen: number;
  /** a run wider than this across the outline is a shape (belt, panel), not a line */
  readonly maxThick: number;
  /** only texels within this distance of the outline count */
  readonly reach: number;
  /** flagged texels this close (px) belong to one line (default 1: 8-connected) */
  readonly bridge?: number;
}

export interface FlankLine {
  readonly x: number;
  readonly y: number;
  readonly length: number;
  readonly px: number;
  /** window rows the line occupies */
  readonly rows: number[];
}

export interface FlankLineResult {
  readonly lines: FlankLine[];
  /** longest along-outline run of any thin dark texel (for tuning and the report) */
  readonly maxThinRun: number;
  /** per texel: 1 = part of a flagged line (for crops) */
  readonly flagged: Uint8Array;
}

const DIR_RADIUS = 10;
/** A bridged gap joins texels at most this far apart across the outline direction (px). */
const BRIDGE_ACROSS = 4;

/** Unit direction of the outline at each stroke texel: principal axis of the stroke texels within DIR_RADIUS. */
function strokeDirs(pts: Int32Array, n: number): Float64Array {
  const dirs = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2] as number;
    const y0 = pts[i * 2 + 1] as number;
    let sx = 0, sy = 0, c = 0;
    for (let j = 0; j < n; j++) { const dx = (pts[j * 2] as number) - x0; const dy = (pts[j * 2 + 1] as number) - y0; if (dx * dx + dy * dy <= DIR_RADIUS * DIR_RADIUS) { sx += dx; sy += dy; c++; } }
    const mx = sx / c, my = sy / c;
    let xx = 0, xy = 0, yy = 0;
    for (let j = 0; j < n; j++) { const dx = (pts[j * 2] as number) - x0 - mx; const dy = (pts[j * 2 + 1] as number) - y0 - my; if ((dx + mx) ** 2 + (dy + my) ** 2 <= DIR_RADIUS * DIR_RADIUS) { xx += dx * dx; xy += dx * dy; yy += dy * dy; } }
    // major eigenvector of [[xx, xy], [xy, yy]]
    const th = 0.5 * Math.atan2(2 * xy, xx - yy);
    dirs[i * 2] = Math.cos(th);
    dirs[i * 2 + 1] = Math.sin(th);
  }
  return dirs;
}

/** Find the doubled-outline lines in one flank window. */
export function flankParallelLines(win: FlankWindow, o: FlankLineOptions): FlankLineResult {
  const { width: W, height: H, dark } = win;
  const flagged = new Uint8Array(W * H);
  // the local outline direction at each flagged texel (for the bridge and the line's length)
  const fdir = new Float64Array(W * H * 2);
  let n = 0;
  for (let i = 0; i < W * H; i++) if (win.stroke[i]) n++;
  if (!n) return { lines: [], maxThinRun: 0, flagged };
  const pts = new Int32Array(n * 2);
  for (let i = 0, k = 0; i < W * H; i++) if (win.stroke[i]) { pts[k * 2] = i % W; pts[k * 2 + 1] = Math.floor(i / W); k++; }
  const dirs = strokeDirs(pts, n);
  const isDark = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && dark[y * W + x] === 1;
  // run length from (x, y) along (dx, dy), not counting the start; gap = texels of non-dark bridged
  const walk = (x: number, y: number, dx: number, dy: number, gap: number) => {
    let last = 0, miss = 0;
    for (let k = 1; k < W + H; k++) {
      const X = Math.round(x + dx * k), Y = Math.round(y + dy * k);
      if (X < 0 || Y < 0 || X >= W || Y >= H) break;
      if (isDark(X, Y)) { last = k; miss = 0; } else if (++miss > gap) break;
    }
    return last;
  };
  let maxThinRun = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!dark[y * W + x]) continue;
    let best = -1, bd = Infinity;
    for (let j = 0; j < n; j++) { const d = ((pts[j * 2] as number) - x) ** 2 + ((pts[j * 2 + 1] as number) - y) ** 2; if (d < bd) { bd = d; best = j; } }
    if (Math.sqrt(bd) > o.reach) continue;
    const tx = dirs[best * 2] as number, ty = dirs[best * 2 + 1] as number;
    const across = 1 + walk(x, y, -ty, tx, 0) + walk(x, y, ty, -tx, 0);
    if (across > o.maxThick) continue;
    const along = 1 + walk(x, y, tx, ty, 1) + walk(x, y, -tx, -ty, 1);
    if (along > maxThinRun) maxThinRun = along;
    if (along >= o.minLen) { flagged[y * W + x] = 1; fdir[(y * W + x) * 2] = tx; fdir[(y * W + x) * 2 + 1] = ty; }
  }
  // flagged texels -> lines: texels within G px join (8-connected when G = 1). A line passing a trim band or art
  // touching it reads wide there and breaks into pieces; a gap along the outline no longer than a line may be thick
  // (maxThick), at the same distance from the outline, does not end it; scattered flecks around a stud do not join (a parallel stroke crossing a belt's edge was dropped as two stubs, the control unfound)
  const G = Math.max(1, Math.round(o.bridge ?? 1));
  const seen = new Uint8Array(W * H);
  const lines: FlankLine[] = [];
  const stubs: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!flagged[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let px = 0, y0 = H, y1 = -1, x0 = W, x1 = -1;
    const rows = new Set<number>();
    const members: number[] = [];
    while (stack.length) {
      const p = stack.pop() as number;
      members.push(p);
      const x = p % W, y = (p - x) / W;
      px++; rows.add(y);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      const ptx = fdir[p * 2] as number, pty = fdir[p * 2 + 1] as number;
      for (let dy = -G; dy <= G; dy++) for (let dx = -G; dx <= G; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H || dx * dx + dy * dy > G * G) continue;
        // beyond the 8 neighbours: only along the outline, at the same distance from it (within BRIDGE_ACROSS px)
        if ((Math.abs(dx) > 1 || Math.abs(dy) > 1) && Math.abs(dx * pty - dy * ptx) > BRIDGE_ACROSS) continue;
        const q = Y * W + X;
        if (flagged[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    // the line's length along the outline: the extent of its texels projected on their mean outline direction
    let mx = 0, my = 0;
    for (const q of members) { const ux = fdir[q * 2] as number, uy = fdir[q * 2 + 1] as number; const sg = ux * mx + uy * my < 0 ? -1 : 1; mx += sg * ux; my += sg * uy; }
    const ml = Math.hypot(mx, my) || 1;
    let pmin = Infinity, pmax = -Infinity;
    for (const q of members) { const pr = ((q % W) * mx + Math.floor(q / W) * my) / ml; pmin = Math.min(pmin, pr); pmax = Math.max(pmax, pr); }
    const length = Math.round(pmax - pmin) + 1;
    // the flagged texels themselves must span a line: the corner texels of a wide shape (a belt's top row
    // beside a slanted outline) read thin across the slant but form only a short stub
    if (length < o.minLen) { for (const q of members) stubs.push(q); continue; }
    lines.push({ x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), length, px, rows: [...rows].sort((a, b) => a - b) });
  }
  for (const q of stubs) flagged[q] = 0;
  return { lines, maxThinRun, flagged };
}

/**
 * Damaged control: the window with a dark stroke `thick` px wide painted parallel to the outline,
 * `offset` px inside it (texels whose distance to the nearest stroke texel lies in [offset, offset + thick)).
 */
export function withParallelStroke(win: FlankWindow, offset: number, thick: number): FlankWindow {
  const { width: W, height: H } = win;
  const dark = win.dark.slice();
  const pts: number[] = [];
  for (let i = 0; i < W * H; i++) if (win.stroke[i]) pts.push(i % W, Math.floor(i / W));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!win.inside[i]) continue;
    let bd = Infinity;
    for (let j = 0; j < pts.length; j += 2) bd = Math.min(bd, ((pts[j] as number) - x) ** 2 + ((pts[j + 1] as number) - y) ** 2);
    const d = Math.sqrt(bd);
    if (d >= offset && d < offset + thick) dark[i] = 1;
  }
  return { ...win, dark };
}

/**
 * The outline stroke alone: the stroke-coloured texels that survive an opening by a disk of `radius` px.
 * The outline is a full stroke width across; trim lines painted in the stroke colour inside the garment (a belt's
 * or band's dark edge lines, 2 to 4 px) do not survive, so they neither bend the local outline direction nor count
 * as the outline the damaged control is painted beside. They are paint (see flankDarkMask).
 */
export function outlineStroke(stroke: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const W = width, H = height, r = Math.max(1, Math.round(radius));
  const disk: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) disk.push(dx, dy);
  // off-window texels count as stroke (the outline runs on past the window's edge)
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || stroke[y * W + x] === 1;
  const core = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!stroke[y * W + x]) continue;
    let all = true;
    for (let k = 0; k < disk.length && all; k += 2) all = at(x + (disk[k] as number), y + (disk[k + 1] as number));
    if (all) core[y * W + x] = 1;
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!core[y * W + x]) continue;
    for (let k = 0; k < disk.length; k += 2) { const X = x + (disk[k] as number), Y = y + (disk[k + 1] as number); if (X >= 0 && Y >= 0 && X < W && Y < H && stroke[Y * W + X]) out[Y * W + X] = 1; }
  }
  return out;
}

/**
 * Dark paint relative to the LOCAL tone: a paint texel is dark when its luminance lies more than `delta`
 * below the median luminance of the paint texels within `radius` px (about 1.5 stroke widths). Against the
 * garment-wide median a darker material at the flank (Mirror's lamellar plates) read dark everywhere, and the
 * damaged control merged into one wide blob there; against the local tone only a line darker than what surrounds
 * it counts. `paint`: texels that hold paint (opaque, not the outline stroke); `skip`: paint texels never dark
 * (the stroke's own antialiased edge).
 */
export function flankDarkMask(lum: Float32Array, paint: Uint8Array, skip: Uint8Array, width: number, height: number, radius: number, delta: number): Uint8Array {
  const W = width, H = height, r = Math.max(1, Math.round(radius));
  const dark = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!paint[i] || skip[i]) continue;
    hist.fill(0);
    let c = 0;
    for (let dy = -r; dy <= r; dy++) {
      const Y = y + dy;
      if (Y < 0 || Y >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const X = x + dx;
        if (X < 0 || X >= W || dx * dx + dy * dy > r * r || !paint[Y * W + X]) continue;
        (hist[Math.max(0, Math.min(255, Math.round(lum[Y * W + X] as number)))] as number)++;
        c++;
      }
    }
    let s = 0, med = 0;
    for (let v = 0; v < 256; v++) { s += hist[v] as number; if (s * 2 >= c) { med = v; break; } }
    if ((lum[i] as number) < med - delta) dark[i] = 1;
  }
  return dark;
}
