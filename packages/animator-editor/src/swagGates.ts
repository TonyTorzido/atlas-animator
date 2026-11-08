/*
 * Atlas Animator editor: the Swag garment gates as pure functions (Batch 10b, PL-08 / ).
 *
 * The user's template rules, measured on a rendered frame pair (the character bare, and wearing the item) plus a few anchor points taken from the
 * posed rig. Each gate reports a status and the pixel to jump to; `GateCoverage` says honestly what was covered (sampled or full, which frames,
 * worn combos and facings), so a green chip never claims more than was checked.
 *
 *  Neck       flat 2D: nothing of the garment shows above the chin line, no hole or ring around the neck, the collar is a thin band under the chin
 *             (not a slab or a dome), and the garment's side lines stop at the chin.
 *  Shoulders  the garment covers the shoulder (the bare skin around each clavicle is not left showing).
 *  Cuffs      a sleeve that reaches past the elbow reaches the wrist (the engine's cuff gap, `cuffGap.ts`, as a distance).
 */

export interface GateRgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Pt {
  x: number;
  y: number;
}

export type GateId = "neck" | "shoulders" | "cuffs" | "ink";
export type GateStatus = "pass" | "fail" | "idle" | "n/a";

export interface GateCoverage {
  /** "full" = every frame of the clip, every worn combo, both facings; "sampled" = anything less. */
  scope: "full" | "sampled";
  frames: string[];
  framesTotal: number;
  combos: string[];
  facings: string[];
}

export interface GateFinding {
  /** Clip time in seconds (null for the setup pose). */
  time: number | null;
  frame: string;
  facing: string;
  combo: string;
  reason: string;
  /** Canvas pixel of the failure in that frame's picture. */
  at: Pt | null;
}

export interface GateResult {
  id: GateId;
  label: string;
  status: GateStatus;
  coverage: GateCoverage;
  findings: GateFinding[];
  summary: string;
}

/** Tunables (game units are the rig's own pixels; masks are in canvas pixels at the render scale). */
export const NECK_ABOVE_CHIN_PX = 24; // game px of garment allowed above the chin line before it counts
export const NECK_ABOVE_MAX = 12; // canvas pixels above the chin that fail the gate (after the allowance)
export const NECK_HOLE_MIN = 40; // game px squared of an enclosed gap just under the chin that reads as a hole / ring
export const NECK_HOLE_HALF = 30; // game px either side of the neck centre where an enclosed gap counts
export const NECK_HOLE_DEPTH = 34; // game px under the chin where an enclosed gap counts
export const NECK_OPEN_MAX = 20; // game px of bare neck (the whole width of the neck) that may show between the chin and the collar before it is a scoop
export const NECK_BAND_MAX = 24; // game px: how far under the chin a narrow collar column may reach (a thin band, not a slab)
export const SHOULDER_EXPOSED_MAX = 0.12; // share of bare shoulder skin left showing
export const SHOULDER_RADIUS = 42; // game px around the clavicle that must be covered
export const CUFF_GAP_MAX = 14; // game px between the sleeve end and the wrist

const diffThreshold = 28;

/** Pixels that differ between the bare and the dressed picture: the garment as it shows. */
export function garmentMask(bare: GateRgba, dressed: GateRgba): Uint8Array {
  const n = Math.min(bare.data.length, dressed.data.length) / 4;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.abs(bare.data[o]! - dressed.data[o]!) + Math.abs(bare.data[o + 1]! - dressed.data[o + 1]!) + Math.abs(bare.data[o + 2]! - dressed.data[o + 2]!);
    if (d > diffThreshold) m[i] = 1;
  }
  return m;
}

/** Background pixels of `mask` that do not connect to the image border, as components {area, cx, cy}. */
export function enclosedGaps(mask: Uint8Array, w: number, h: number): { area: number; cx: number; cy: number }[] {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number): void => {
    if (!seen[i] && !mask[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out: { area: number; cx: number; cy: number }[] = [];
  const done = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (mask[s] || seen[s] || done[s]) continue;
    let area = 0;
    let sx = 0;
    let sy = 0;
    const st = [s];
    done[s] = 1;
    while (st.length) {
      const i = st.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      area++;
      sx += x;
      sy += y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !mask[j] && !seen[j] && !done[j]) {
          done[j] = 1;
          st.push(j);
        }
      }
    }
    out.push({ area, cx: sx / area, cy: sy / area });
  }
  return out;
}

export interface NeckInput {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Canvas y of the chin (the bottom of the head art). */
  chinY: number;
  /** Canvas x of the neck centre. */
  neckX: number;
  /** Canvas pixels per game pixel. */
  scale: number;
}

export interface NeckMeasure {
  above: number;
  aboveAt: Pt | null;
  holes: number;
  holeAt: Pt | null;
  /** Rows under the chin (game px) where only a narrow column of garment shows: a slab or dome of collar. */
  bandRows: number;
  bandAt: Pt | null;
  /** Game px of the neck left open straight under the chin (the shallowest column across the neck): a scoop, not a collar. */
  openDepth: number;
  openAt: Pt | null;
  /** The garment reaches the neck / upper chest at all (a pair of boots does not, so the gate does not judge it). */
  reaches: boolean;
}

/** The three neck measurements on a garment mask. */
export function measureNeck(i: NeckInput): NeckMeasure {
  const { mask, width: w, height: h, chinY, neckX, scale } = i;
  const chin = Math.round(chinY);
  const allow = NECK_ABOVE_CHIN_PX * scale;
  let above = 0;
  let aboveAt: Pt | null = null;
  const half = Math.round(70 * scale);
  // 1. nothing of the garment shows above the chin, beside or under the head (a window of +-70 game px about the neck)
  for (let y = 0; y < Math.min(h, Math.floor(chin - allow)); y++) {
    for (let x = Math.max(0, Math.round(neckX) - half); x < Math.min(w, Math.round(neckX) + half); x++) {
      if (mask[y * w + x]) {
        above++;
        aboveAt ??= { x, y };
      }
    }
  }
  // 2. no hole or ring around the neck. Measured only below the chin (the head hides the garment above it), and only in the neck window:
  //    (a) an enclosed gap of the garment mask there (a ring), and (b) a scoop, the neck left open straight down from the chin across its whole
  //    width. A little bare skin between the chin and a thin collar is fine, and so are small pockets lower on the chest (buttons, stitching).
  let holes = 0;
  let holeAt: Pt | null = null;
  const minArea = NECK_HOLE_MIN * scale * scale;
  for (const g of enclosedGaps(mask, w, h)) {
    if (g.area >= minArea && Math.abs(g.cx - neckX) < NECK_HOLE_HALF * scale && g.cy >= chinY && g.cy < chinY + NECK_HOLE_DEPTH * scale) {
      holes += g.area / (scale * scale);
      holeAt ??= { x: Math.round(g.cx), y: Math.round(g.cy) };
    }
  }
  let openDepth = Infinity;
  const x0 = Math.max(0, Math.round(neckX - 12 * scale));
  const x1 = Math.min(w - 1, Math.round(neckX + 12 * scale));
  for (let x = x0; x <= x1; x++) {
    let y = chin;
    while (y < h && !mask[y * w + x]) y++;
    openDepth = Math.min(openDepth, (y - chin) / scale);
  }
  if (!Number.isFinite(openDepth)) openDepth = 0;
  let reaches = false;
  for (let y = chin; y < Math.min(h, chin + Math.round(60 * scale)) && !reaches; y++) {
    for (let x = Math.max(0, Math.round(neckX - half)); x < Math.min(w, Math.round(neckX + half)); x++) {
      if (mask[y * w + x]) {
        reaches = true;
        break;
      }
    }
  }
  // 3. the collar is a thin band: under the chin the garment must widen to the shoulders quickly; rows with only a narrow centre column are a slab
  let widest = 0;
  const widths: number[] = [];
  for (let y = chin; y < Math.min(h, chin + Math.round(NECK_BAND_MAX * 2 * scale)); y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += mask[y * w + x]!;
    widths.push(n);
    widest = Math.max(widest, n);
  }
  let bandRows = 0;
  let bandAt: Pt | null = null;
  if (widest > 0) {
    for (let k = 0; k < widths.length; k++) {
      if (widths[k]! > 0 && widths[k]! < widest * 0.35) {
        bandRows++;
        bandAt ??= { x: Math.round(neckX), y: chin + k };
      } else if (widths[k]! >= widest * 0.35) break;
    }
  }
  return { above, aboveAt, holes, holeAt, bandRows: bandRows / scale, bandAt, openDepth, openAt: { x: Math.round(neckX), y: chin + Math.round((Math.min(openDepth, 60) * scale) / 2) }, reaches };
}

/** Why the neck fails, or [] when it holds. */
export function neckReasons(m: NeckMeasure): { reason: string; at: Pt | null }[] {
  const out: { reason: string; at: Pt | null }[] = [];
  if (m.above > NECK_ABOVE_MAX) out.push({ reason: `garment shows ${m.above} px above the chin: the chin must be the only border`, at: m.aboveAt });
  if (m.holes > 0) out.push({ reason: `a ${Math.round(m.holes)} px hole or ring around the neck: the neck must be flat, no hole`, at: m.holeAt });
  if (m.openDepth > NECK_OPEN_MAX) out.push({ reason: `the neck is open ${Math.round(m.openDepth)} px under the chin (a scoop): the collar must sit right under the chin`, at: m.openAt });
  if (m.bandRows > NECK_BAND_MAX) out.push({ reason: `the collar is a ${Math.round(m.bandRows)} px slab under the chin: it must be a thin band`, at: m.bandAt });
  return out;
}

export interface ShoulderInput {
  bare: GateRgba;
  mask: Uint8Array;
  /** Canvas position of each clavicle. */
  clavicles: Pt[];
  scale: number;
  /** Rows above this canvas y belong to the head / neck and are not shoulder. */
  chinY: number;
}

/** Share of the bare skin within SHOULDER_RADIUS of a clavicle that the garment leaves showing, per shoulder. */
export function measureShoulders(i: ShoulderInput): { exposed: number; at: Pt | null }[] {
  const { bare, mask, scale } = i;
  const R = SHOULDER_RADIUS * scale;
  return i.clavicles.map((c) => {
    let body = 0;
    let left = 0;
    let at: Pt | null = null;
    for (let y = Math.max(Math.round(c.y - R), Math.ceil(i.chinY)); y <= Math.min(bare.height - 1, Math.round(c.y + R)); y++) {
      for (let x = Math.max(0, Math.round(c.x - R)); x <= Math.min(bare.width - 1, Math.round(c.x + R)); x++) {
        if ((x - c.x) ** 2 + (y - c.y) ** 2 > R * R) continue;
        const px = y * bare.width + x;
        if (bare.data[px * 4 + 3]! < 200) continue;
        body++;
        if (!mask[px]) {
          left++;
          at ??= { x, y };
        }
      }
    }
    return { exposed: body ? left / body : 0, at };
  });
}

export interface CuffInput {
  side: string;
  /** Game-pixel distance from the sleeve's nearest vertex to the wrist, or null when there is no sleeve there. */
  sleeveToWrist: number | null;
  /** Game-pixel length of the forearm (elbow to wrist). */
  forearm: number;
  at: Pt | null;
}

/** A sleeve that reaches past the elbow must reach the wrist; a short sleeve (ending above the elbow) or no sleeve is not judged. */
export function cuffVerdict(c: CuffInput): { judged: boolean; gap: number; ok: boolean } {
  if (c.sleeveToWrist === null || c.sleeveToWrist > c.forearm) return { judged: false, gap: 0, ok: true };
  return { judged: true, gap: c.sleeveToWrist, ok: c.sleeveToWrist <= CUFF_GAP_MAX };
}

/** Folds per-frame findings into one honest gate result. */
export function foldGate(id: GateId, label: string, o: { coverage: GateCoverage; findings: GateFinding[]; judged: number }): GateResult {
  const cov = o.coverage;
  const where = `${cov.scope === "full" ? "full check" : "sampled"}: ${cov.frames.length} of ${cov.framesTotal} frame${cov.framesTotal === 1 ? "" : "s"}, ${cov.combos.length} worn combo${cov.combos.length === 1 ? "" : "s"}, ${cov.facings.join(" + ")}`;
  if (o.judged === 0) return { id, label, status: "n/a", coverage: cov, findings: [], summary: `${label}: not applicable here (${where})` };
  if (o.findings.length) return { id, label, status: "fail", coverage: cov, findings: o.findings, summary: `${label}: ${o.findings.length} failing (${where}). ${o.findings[0]!.reason}` };
  return { id, label, status: "pass", coverage: cov, findings: [], summary: `${label}: passes (${where})` };
}
