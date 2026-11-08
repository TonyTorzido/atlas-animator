/*
 * Atlas Animator editor: the outline continuity gate, pure. A port of `edge_breaks` from swag_outline_gate.py: every garment piece's
 * outline must be one unbroken ink line wherever it shows. Works on RGBA ImageData-like buffers, no DOM.
 *
 *   ring = the piece's silhouette eroded once, minus the silhouette eroded three times (1 to 3 px inside its edge);
 *   top  = pixels where the full frame matches the piece rendered alone within 40 per channel, and the frame alpha > 200;
 *   ink  = pixels of the piece with every channel <= 40;
 *   a break = an 8-connected run of non-ink ring pixels in `top` whose extent along the edge is longer than 2 px.
 */

/** An ImageData-like buffer: RGBA, 4 bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export const MAX_BREAK = 2;
export const INK_MAX = 40;
export const TOP_TOLERANCE = 40;

/**
 * Which slots of a worn skin the outline gate checks: the garment pieces only (swag_outline_gate.py PIECES: the two sleeves and the
 * torso panel). A skin also carries the bare body slots it replaces (`skin_arm_*`, the hand and forearm under a sleeve); the sleeve
 * cuff deliberately overlaps the fist there, so the arm's edge is not an ink outline to hold to the garment rule.
 */
export const BODY_SLOT = /^(skin_|body_|hand_|head|hair|eyes|brows|nose|mouth)/;
export function gatedSlots(slots: readonly string[]): string[] {
  return slots.filter((s) => !BODY_SLOT.test(s));
}

export interface GateOptions {
  /** A run must be longer than this many px to count (default 2). */
  maxBreak?: number;
  /** Ink: every channel at most this (default 40). */
  inkMax?: number;
}

export interface EdgeBreaks {
  /** Number of breaks longer than `maxBreak`. */
  count: number;
  /** The longest break's extent in px (0 when none). */
  longest: number;
  /** One byte per pixel (width * height): 1 where a counted break lies. */
  mask: Uint8Array;
  /** Bounding boxes of the counted breaks (x0, y0 inclusive; x1, y1 exclusive), for drawing marks. */
  boxes: { x0: number; y0: number; x1: number; y1: number; length: number }[];
}

/** Binary erosion with a cross structuring element; pixels outside the image count as 0 (scipy's default border). */
export function erode(src: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = src;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Break count, longest break and mask for one piece `piece` (rendered alone) inside the full frame `full`. */
export function edgeBreaks(full: RgbaImage, piece: RgbaImage, o: GateOptions = {}): EdgeBreaks {
  const { width: w, height: h } = piece;
  if (full.width !== w || full.height !== h) throw new Error(`outline gate: frame ${full.width}x${full.height} and piece ${w}x${h} differ in size`);
  const maxBreak = o.maxBreak ?? MAX_BREAK;
  const inkMax = o.inkMax ?? INK_MAX;
  const n = w * h;
  const F = full.data;
  const G = piece.data;
  const A = new Uint8Array(n);
  for (let i = 0; i < n; i++) A[i] = G[i * 4 + 3]! > 127 ? 1 : 0;
  const e1 = erode(A, w, h, 1);
  const e3 = erode(A, w, h, 3);
  const bad = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(A[i] && !e3[i] && e1[i])) continue;
    const k = i * 4;
    const diff = Math.max(Math.abs(F[k]! - G[k]!), Math.abs(F[k + 1]! - G[k + 1]!), Math.abs(F[k + 2]! - G[k + 2]!));
    const top = diff < TOP_TOLERANCE && F[k + 3]! > 200;
    const ink = Math.max(G[k]!, G[k + 1]!, G[k + 2]!) <= inkMax;
    if (top && !ink) bad[i] = 1;
  }
  // 8-connected components.
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const boxes: EdgeBreaks["boxes"] = [];
  let longest = 0;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!bad[s] || seen[s]) continue;
    const comp: number[] = [];
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (bad[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    // The extent along the edge (the ring is 2 px thick): the larger side of the bounding box.
    const length = Math.max(y1 + 1 - y0, x1 + 1 - x0);
    if (length > maxBreak) {
      for (const i of comp) out[i] = 1;
      boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, length });
      longest = Math.max(longest, length);
    }
  }
  return { count: boxes.length, longest, mask: out, boxes };
}

export interface PieceInput {
  name: string;
  /** The piece rendered alone. */
  image: RgbaImage;
}

export interface FrameGate {
  pass: boolean;
  pieces: Record<string, { breaks: number; longest: number }>;
  /** The union of every piece's break mask. */
  mask: Uint8Array;
}

/** One pose: the gate for every garment piece against the full frame. Passes when no piece has a break. */
export function gateFrame(full: RgbaImage, pieces: readonly PieceInput[], o: GateOptions = {}): FrameGate {
  const mask = new Uint8Array(full.width * full.height);
  const rec: FrameGate["pieces"] = {};
  let pass = true;
  for (const p of pieces) {
    const r = edgeBreaks(full, p.image, o);
    rec[p.name] = { breaks: r.count, longest: r.longest };
    if (r.count) pass = false;
    for (let i = 0; i < mask.length; i++) if (r.mask[i]) mask[i] = 1;
  }
  return { pass, pieces: rec, mask };
}
