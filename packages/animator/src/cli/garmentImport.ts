/*
 * Atlas Animator: original implementation.
 *
 * Plan: `animator garment import <rig.anim.json> <art.png> <out dir> [flags]` (also
 * `tsx src/cli/garmentImport.ts ...`). Construction pass 1: the garment is the body-derived surface of a declared domain
 * (tools/garmentSurface.ts) with flat fabric. Writes:
 * - `<name>.domain.json` (the domain in body material coordinates), derived from the art's cut
 *   lines when missing or with `--derive-domain`; `--domain <path>` reads/writes it elsewhere;
 * - rig/ (the dressed rig, margin + outlines), diag/core0/ (the zero-margin core, no strokes) and
 *   diag/bare/ (the bare body, hidden slots off), each with its atlas;
 * - `<name>.report.json`: the gates over the pose envelope (rest, walk, idle, the arm raise sweep,
 *   the `diag` poses: raises 0-100, flex 58/68, asymmetric): surface correspondence, zero-margin
 *   control (game px), offset deviation (game px), flips, protected gaps, contour integrity,
 *   coverage (exposed skin samples of the declared domain, no exemption), and the gate-integrity
 *   controls (missing triangle, wrong binding, broken contour: each must fail), and the garment
 *   closure (tools/garmentClosure.ts, 0.4 and 1x: no uninked garment edge, no dangling stroke, no body
 *   line inside the garment; failing frames cropped into closure/; damaged controls must fail);
 * - unless --no-render: (a) bare | (b) core | (c) garment sheets of the diag poses and the walk at
 *   3x and game size (nearest x3), from the production renderer; the painted garment sheets (idle,
 *   walk, raises, flex, asymmetric; 3x, game size and fractional placement) and 6x crops of the
 *   shoulders and flanks in the flex pose.
 * Pass 2 (tools/garmentPaint.ts): the art is the texture (silhouette/occlusion ink removed, hidden
 * material completed, padding), `<name>-texture.png` and `<name>-paint-classes.png`; `--flat` keeps
 * pass 1's flat fabric; `--derive-details` records the cuff/hem cut details into the domain.
 * Flags: --name <garment> (default jacket), --hides <slot,...>, --base <png> (the body art: the
 * derived margin), --margin <canvas px> (overrides the domain's), --game-scale <k> (default
 * 140/1074), --domain <path>, --derive-domain, --no-render. (--regions/--fold: the old fitted
 * path's, ignored.)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { decodePng, readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas } from "../tools/validate.js";
import { writeAtlas } from "../tools/surface/output.js";
import { softRender } from "../tools/softRender.js";
import { grid } from "../tools/review.js";
import { defaultInk } from "../tools/garmentImport.js";
import { artOutlineInk } from "../tools/garmentInk.js";
import { ARM_GAP_MIN, GAP_CLEAR, armGapClearance, mediumBulk, silhouetteBump, DEFAULT_GARMENT_STROKE, JOIN_DEV_MAX_GAME_PX, NECKLINE_DROP, OUTLINE_TURN_MAX_DEG, buildGarmentSurface, dropNecklines, contourGate, correspondenceGate, coveredTexelMask, deriveDomainFromArt, domainSamples, dressGarment, garmentPoseMetrics, lengthenHemDomain, materialRestOf, outlineZigDeg, type GarmentBuild, type GarmentDomain } from "../tools/garmentSurface.js";
import { SHADE_BESIDE_STROKE, deriveCutDetails, lengthenHemArt, paintGarmentTexture, silhouetteResidual } from "../tools/garmentPaint.js";
import { swagImportChecks } from "../tools/swagImportHook.js";
import { flankDarkMask, flankParallelLines, outlineStroke, withParallelStroke } from "../tools/flankLines.js";
import { closureControls, closureMinRun, renderClosure } from "../tools/garmentClosure.js";
import { GAP_MAX_PX, armDipIds, cuffWristGap, damagedShortCuff, sleevedArms, type CuffGapArm } from "../tools/cuffGap.js";
import { renderFrames, writeGif } from "./render.js";
import type { RgbaImage } from "../tools/image.js";

const FPS = 30;
/** Output scales of the garment closure gate: the 0.4 review view and 1x. */
export const CLOSURE_SCALES = [0.4, 1] as const;
type Flags = Map<string, string | true>;

function flag(flags: Flags, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * Per-bone key sign and cap of the arm clips, in the order [arm 0, arm 1, elbow 0, elbow 1]. The mirrored front
 * keys the right side with the opposite sign and no cap (MIRROR_SIDES); a full-body view (phase 2c) takes the pair
 * from the parts' partners and each bone's sign and cap from its own limits (sidesFromLimits).
 */
export interface ArmClipSides { sign: [number, number, number, number]; cap: [number, number, number, number] }
export const MIRROR_SIDES: ArmClipSides = { sign: [1, -1, 1, -1], cap: [Infinity, Infinity, Infinity, Infinity] };
const sideValue = (s: ArmClipSides, i: number, v: number) => (s.sign[i] as number) * Math.min(v, s.cap[i] as number);
/** Sign = the limit side with the larger reach (raise and fold go that way), cap = that limit. */
export function sidesFromLimits(raw: any, bones: [string, string, string, string]): ArmClipSides {
  const out: ArmClipSides = { sign: [1, 1, 1, 1], cap: [Infinity, Infinity, Infinity, Infinity] };
  bones.forEach((b, i) => {
    const lim = (raw.bones as any[]).find((x) => x.name === b)?.limits as { min: number; max: number } | undefined;
    if (!lim) return;
    const sign = lim.max >= -lim.min ? 1 : -1;
    out.sign[i] = sign;
    out.cap[i] = sign > 0 ? lim.max : -lim.min;
  });
  return out;
}

/** The parts of a full-body preset (tools/surface/fullBody.ts `*.body.json`): kind, depth, partner, chain bones, girdle r0. */
export interface BodyPart { name: string; kind: string; depth: string; partner?: string; chain: string[]; skin: MeshRef; girdle?: { bone: string; r0: number }; sheet?: MeshRef }
type MeshRef = { slot: string; attachment: string };
export function loadBodyParts(path: string): { parts: BodyPart[] } {
  const b = JSON.parse(readFileSync(path, "utf8"));
  return {
    parts: (b.parts as any[]).map((p) => {
      const f = JSON.parse(readFileSync(join(dirname(path), p.file), "utf8"));
      const sheet = f.assembly?.sheets?.[0];
      return { name: p.name, kind: p.kind, depth: p.depth, partner: p.partner, chain: f.chain.bones as string[], skin: { slot: f.skin.slot, attachment: f.skin.attachment }, ...(f.girdle ? { girdle: { bone: f.girdle.bone, r0: f.girdle.r0 } } : {}), ...(sheet ? { sheet: { slot: sheet.slot, attachment: sheet.attachment } } : {}) };
    })
  };
}

/**
 * The role of a garment piece in a full-body view (phase 2c): built on the near arm's mesh ("near"), the far arm's
 * ("far") or the trunk sheet ("sheet"); `other` = the mesh across the arm gap (the near arm for the sheet piece,
 * the torso sheet for either sleeve).
 */
export function pieceRole(raw: any, slot: string, near: BodyPart, far: BodyPart): { role: "sheet" | "near" | "far"; self: MeshRef; other: MeshRef } {
  const sheet = near.sheet as MeshRef;
  const skinKey = Object.keys(raw.skins)[0] as string;
  const self = { slot, attachment: Object.keys(raw.skins[skinKey].attachments[slot])[0] as string };
  if (slot === near.skin.slot) return { role: "near", self, other: sheet };
  if (slot === far.skin.slot) return { role: "far", self, other: sheet };
  return { role: "sheet", self, other: near.skin };
}

const posedMesh = (sk: Skeleton, m: MeshRef) => { const s = sk.getSlot(m.slot); return sk.meshWorldVertices(sk.getAttachment(s, m.attachment) as any, s.bone); };
function inMesh(x: number, y: number, v: ArrayLike<number>, T: readonly number[]): boolean {
  for (let t = 0; t < T.length; t += 3) {
    const a = (T[t] as number) * 2, b = (T[t + 1] as number) * 2, c = (T[t + 2] as number) * 2;
    const d1 = ((v[b] as number) - (v[a] as number)) * (y - (v[a + 1] as number)) - ((v[b + 1] as number) - (v[a + 1] as number)) * (x - (v[a] as number));
    const d2 = ((v[c] as number) - (v[b] as number)) * (y - (v[b + 1] as number)) - ((v[c + 1] as number) - (v[b + 1] as number)) * (x - (v[b] as number));
    const d3 = ((v[a] as number) - (v[c] as number)) * (y - (v[c + 1] as number)) - ((v[a + 1] as number) - (v[c + 1] as number)) * (x - (v[c] as number));
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
  }
  return false;
}
/** Boundary edges of a triangle list, as vertex index pairs. */
function boundaryEdges(T: readonly number[]): [number, number][] {
  const n = new Map<string, number>();
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) { const a = T[t + k] as number, b = T[t + ((k + 1) % 3)] as number; const key = a < b ? `${a},${b}` : `${b},${a}`; n.set(key, (n.get(key) ?? 0) + 1); }
  return [...n].filter(([, c]) => c === 1).map(([key]) => key.split(",").map(Number) as [number, number]);
}
const ptSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => { const dx = bx - ax, dy = by - ay; const l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0; return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const segSeg = (a: number[], b: number[], c: number[], d: number[]) => {
  const cr = (o: number[], p: number[], q: number[]) => ((p[0] as number) - (o[0] as number)) * ((q[1] as number) - (o[1] as number)) - ((p[1] as number) - (o[1] as number)) * ((q[0] as number) - (o[0] as number));
  if (cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0) return 0;
  return Math.min(ptSeg(a[0]!, a[1]!, c[0]!, c[1]!, d[0]!, d[1]!), ptSeg(b[0]!, b[1]!, c[0]!, c[1]!, d[0]!, d[1]!), ptSeg(c[0]!, c[1]!, a[0]!, a[1]!, b[0]!, b[1]!), ptSeg(d[0]!, d[1]!, a[0]!, a[1]!, b[0]!, b[1]!));
};

/**
 * Cross-piece arm/torso clearance, one pose (phase 2c, the armGapEveryFrame of separate pieces): the smallest
 * distance between this piece's visible garment strokes and the strokes across the gap (the other mesh's garment
 * piece when the rig already carries one, else that mesh's own body outline), over the stroke segments outside the
 * other body's silhouette whose nearest body boundary points are at least 2m + 1 + GAP_CLEAR apart (the rule of
 * armGapClearance: where the bodies overlap, a near arm drawn over the torso, the crossing is occlusion, not a gap).
 * The shoulder join: where a stroke enters the other body's silhouette (the arm outline running into the torso, the
 * torso outline or the torso jacket's edge running under the arm) the two outlines meet by construction, the
 * cross-piece form of the front's same-stretch rule: a pair where one segment lies within joinArc(m) of its own
 * line's entry point (along that line) and the other segment within joinArc(m) of that point is that join, not a gap.
 * `damage` (the control): a separate body's stroke laid on this piece's segment farthest from any join; the gate
 * must then read 0 (a real underarm gap is not excluded by the join rule).
 */
export const joinArc = (m: number) => 4 * m + 10;
export function pieceGapFrame(sk: Skeleton, raw: any, skinKey: string, self: MeshRef, other: MeshRef, garmentSlots: ReadonlySet<string>, m: number, damage = false): { pairs: number; min: number; at: number[] | null; joinPairs: number; control?: number } {
  const atts = raw.skins[skinKey].attachments as Record<string, Record<string, any>>;
  const Ts = atts[self.slot]?.[self.attachment].triangles as number[];
  const To = atts[other.slot]?.[other.attachment].triangles as number[];
  const vs = posedMesh(sk, self);
  const vo = posedMesh(sk, other);
  const bs = boundaryEdges(Ts);
  const bo = boundaryEdges(To);
  // the other side's strokes: contours drawn by a garment embedded on the other mesh, else by the mesh itself
  const sourceOf = (meshSlot: string) => { const a = Object.values(atts[meshSlot] ?? {})[0]; return a?.embed ? (a.embed.slot as string) : meshSlot; };
  const contourMesh = new Map<string, { slot: string; garment: boolean }>();
  for (const [drawSlot, byName] of Object.entries((raw.skins[skinKey].contours ?? {}) as Record<string, Record<string, any>>)) for (const c of Object.values(byName)) { const ms = (c.mesh?.slot as string | undefined) ?? drawSlot; contourMesh.set(drawSlot, { slot: sourceOf(ms), garment: !!Object.values(atts[ms] ?? {})[0]?.embed }); }
  const otherGarment = [...contourMesh.values()].some((x) => x.slot === other.slot && x.garment);
  const polys = (pick: (drawSlot: string) => boolean) => {
    const out: number[][][] = [];
    for (const c of sk.activeContours) {
      if (!sk.isContourVisible(c) || !pick(sk.contourSlot(c).data.name)) continue;
      const pts = new Float32Array(c.pointCount * 2);
      sk.computeContourPoints(c, pts);
      const line: number[][] = [];
      for (let i = 0; i < c.pointCount; i++) line.push([pts[i * 2] as number, pts[i * 2 + 1] as number]);
      out.push(line);
    }
    return out;
  };
  const mine = polys((s) => garmentSlots.has(s));
  const theirs = polys((s) => { const x = contourMesh.get(s); return !!x && !garmentSlots.has(s) && x.slot === other.slot && x.garment === otherGarment; });
  // the nearest point on the body's boundary edges (not the nearest boundary vertex: sparse vertices overstate the
  // distance between two outlines that run together)
  const nearest = (p: number[], v: ArrayLike<number>, b: [number, number][]) => {
    let best = Infinity;
    let q = [0, 0];
    for (const [i, j] of b) {
      const ax = v[i * 2] as number, ay = v[i * 2 + 1] as number, bx = v[j * 2] as number, by = v[j * 2 + 1] as number;
      const dx = bx - ax, dy = by - ay;
      const l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, (((p[0] as number) - ax) * dx + ((p[1] as number) - ay) * dy) / l)) : 0;
      const d = Math.hypot(ax + t * dx - (p[0] as number), ay + t * dy - (p[1] as number));
      if (d < best) { best = d; q = [ax + t * dx, ay + t * dy]; }
    }
    return q;
  };
  // each segment outside the other body, with its arc distance along its own line to the nearest entry point into
  // the other body's silhouette (the join) and that entry point
  type Seg = { line: number; a: number[]; b: number[]; body: number[]; joinArc: number; join: number[] | null };
  const L = joinArc(m);
  const segs = (lines: number[][][], outsideV: ArrayLike<number>, outsideT: number[], ownV: ArrayLike<number>, ownB: [number, number][]): Seg[] => lines.flatMap((ln, li) => {
    const inside = ln.map((p) => inMesh(p[0] as number, p[1] as number, outsideV, outsideT));
    const arc: number[] = [0];
    for (let i = 1; i < ln.length; i++) arc.push((arc[i - 1] as number) + Math.hypot((ln[i]![0] as number) - (ln[i - 1]![0] as number), (ln[i]![1] as number) - (ln[i - 1]![1] as number)));
    const entries: number[] = [];
    for (let i = 1; i < ln.length; i++) if (inside[i] !== inside[i - 1]) entries.push(i);
    return ln.slice(1).flatMap((q, i) => {
      const p = ln[i] as number[];
      const mid = [((p[0] as number) + (q[0] as number)) / 2, ((p[1] as number) + (q[1] as number)) / 2];
      if (inMesh(mid[0] as number, mid[1] as number, outsideV, outsideT)) return [];
      const s = ((arc[i] as number) + (arc[i + 1] as number)) / 2;
      let best = Infinity;
      let join: number[] | null = null;
      for (const e of entries) { const d = Math.abs(s - (arc[e] as number)); if (d < best) { best = d; join = ln[e] as number[]; } }
      return [{ line: li, a: p, b: q, body: nearest(mid, ownV, ownB), joinArc: best, join }];
    });
  });
  const A = segs(mine, vo, To, vs, bs);
  const measure = (B: Seg[]) => {
    let pairs = 0;
    let joinPairs = 0;
    let min = Infinity;
    let at: number[] | null = null;
    let worst: [Seg, Seg] | null = null;
    for (const x of A) for (const y of B) {
      if (Math.hypot((x.body[0] as number) - (y.body[0] as number), (x.body[1] as number) - (y.body[1] as number)) < 2 * m + 1 + GAP_CLEAR) continue;
      const atJoin = (u: Seg, v: Seg) => !!u.join && u.joinArc <= L && ptSeg(u.join[0] as number, u.join[1] as number, v.a[0] as number, v.a[1] as number, v.b[0] as number, v.b[1] as number) <= L;
      if (atJoin(x, y) || atJoin(y, x)) { joinPairs++; continue; }
      pairs++;
      const g = segSeg(x.a, x.b, y.a, y.b);
      if (g < min) { min = g; at = [((x.a[0] as number) + (y.a[0] as number)) / 2, ((x.a[1] as number) + (y.a[1] as number)) / 2]; worst = [x, y]; }
    }
    return { pairs, joinPairs, min, at, worst };
  };
  const B = segs(theirs, vs, Ts, vo, bo);
  const r = measure(B);
  let control: number | undefined;
  if (damage && A.length) {
    // the control: a stroke of a clearly separate body (its body point 2m + 1 + GAP_CLEAR + 1 px from this one's)
    // laid on this piece's segment farthest from any join; a real gap away from the joins must read 0
    const x = A.reduce((u, v) => (v.joinArc > u.joinArc ? v : u));
    const mid = [((x.a[0] as number) + (x.b[0] as number)) / 2, ((x.a[1] as number) + (x.b[1] as number)) / 2];
    const ox0 = (mid[0] as number) - (x.body[0] as number);
    const oy0 = (mid[1] as number) - (x.body[1] as number);
    const ol = Math.hypot(ox0, oy0) || 1;
    const away = 2 * m + 2 + GAP_CLEAR;
    const fake: Seg = { line: -1, a: x.a, b: x.b, body: [(x.body[0] as number) + (ox0 / ol) * away, (x.body[1] as number) + (oy0 / ol) * away], joinArc: Infinity, join: null };
    control = measure([...B, fake]).min;
  }
  return { pairs: r.pairs, min: r.min, at: r.at, joinPairs: r.joinPairs, ...(control !== undefined ? { control } : {}) };
}

/** Far sleeve root (phase 2c): garment vertices within the far girdle's r0 of the upper arm's joint, under the torso sheet at setup. */
export function farRootVertices(raw: any, C: GarmentBuild, far: BodyPart, torso: MeshRef): number[] {
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const j = sk.getBone(far.chain[0] as string).world;
  const r0 = far.girdle?.r0 ?? 0;
  const a = C.attachment;
  const tv = posedMesh(sk, torso);
  const T = raw.skins[Object.keys(raw.skins)[0] as string].attachments[torso.slot][torso.attachment].triangles as number[];
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  const out: number[] = [];
  for (let i = 0; i < a.uvs.length / 2; i++) {
    const x = (a.uvs[i * 2] as number) * a.width + C.origin[0] - ox;
    const y = (a.uvs[i * 2 + 1] as number) * a.height + C.origin[1] - oy;
    if (Math.hypot(x - j.x, y - j.y) <= r0 && inMesh(x, y, tv, T)) out.push(i);
  }
  return out;
}
export function farRootFrame(sk: Skeleton, raw: any, C: GarmentBuild, torso: MeshRef, roots: number[]): { escapes: number; first: number } {
  const gs = sk.getSlot(C.ownerSlot);
  const gv = sk.meshWorldVertices(sk.getAttachment(gs, C.ownerSlot) as any, gs.bone);
  const tv = posedMesh(sk, torso);
  const T = raw.skins[Object.keys(raw.skins)[0] as string].attachments[torso.slot][torso.attachment].triangles as number[];
  let escapes = 0;
  let first = -1;
  for (const i of roots) if (!inMesh(gv[i * 2] as number, gv[i * 2 + 1] as number, tv, T)) { escapes++; if (first < 0) first = i; }
  return { escapes, first };
}

/** The arm-raise sweep (both arms; the right side mirrored): rest, full raise, raise with elbow bend, back. */
export function armRaiseClip(arm: [string, string], elbow: [string, string], raise = 100, bendRaise = 58, bend = 68, sides: ArmClipSides = MIRROR_SIDES): any {
  const keys = (pairs: [number, number][], i: number) => pairs.map(([time, value]) => ({ time, value: sideValue(sides, i, value) }));
  const up: [number, number][] = [[0, 0], [0.4, 0], [1.4, raise], [1.8, raise], [2.6, bendRaise], [3.0, bendRaise], [3.6, 30], [4.4, 0], [4.8, 0]];
  // Elbows never fold outward (pose rule, elbow_never_outward): the bend is undone before the arm is back below 45 deg.
  const el: [number, number][] = [[0, 0], [1.8, 0], [2.6, bend], [3.0, bend], [3.6, 30], [4.0, 0], [4.8, 0]];
  return {
    duration: 4.8,
    loop: true,
    fps: FPS,
    bones: {
      [arm[0]]: { rotate: keys(up, 0) },
      [arm[1]]: { rotate: keys(up, 1) },
      [elbow[0]]: { rotate: keys(el, 2) },
      [elbow[1]]: { rotate: keys(el, 3) }
    }
  };
}

/** The flex pose: both arms raised with the elbows bent, held. */
export function flexClip(arm: [string, string], elbow: [string, string], raise = 58, bend = 68, sides: ArmClipSides = MIRROR_SIDES): any {
  const hold = (i: number, v: number) => { const x = sideValue(sides, i, v); return [{ time: 0, value: x }, { time: 0.5, value: x }]; };
  return { duration: 0.5, loop: true, fps: FPS, bones: { [arm[0]]: { rotate: hold(0, raise) }, [arm[1]]: { rotate: hold(1, raise) }, [elbow[0]]: { rotate: hold(2, bend) }, [elbow[1]]: { rotate: hold(3, bend) } } };
}

/** The diagnostic poses (one per second, stepped): [label, left raise, left bend, right raise, right bend]. */
export const DIAG_POSES: [string, number, number, number, number][] = [
  ["rest", 0, 0, 0, 0],
  ["raise 25", 25, 0, 25, 0],
  ["raise 50", 50, 0, 50, 0],
  ["raise 75", 75, 0, 75, 0],
  ["raise 100", 100, 0, 100, 0],
  ["flex 58/68", 58, 68, 58, 68],
  ["asym 100 | 30/30", 100, 0, 30, 30],
  ["asym 58/68 | 0", 58, 68, 0, 0]
];

/** The gate pose envelope of a dressed document: the diag poses, then the arm, walk and idle clips it carries, sampled. */
export function envelopePoses(doc: any): { clip: string; t: number; label: string }[] {
  const poses: { clip: string; t: number; label: string }[] = [];
  DIAG_POSES.forEach((p, i) => poses.push({ clip: "diag", t: i, label: p[0] }));
  for (const [clip, step] of Object.entries({ arm_raise: 6, sweep: 6, walk_in_place: 4, walk_flat: 4, idle_weight_shift: 12 })) {
    const c = doc.animations[clip];
    if (!c) continue;
    const n = Math.round(c.duration * FPS);
    for (let f = 0; f <= n; f += step) poses.push({ clip, t: f / FPS, label: `${clip}@${(f / FPS).toFixed(2)}` });
  }
  return poses;
}

export function diagClip(arm: [string, string], elbow: [string, string], sides: ArmClipSides = MIRROR_SIDES): any {
  const keys = (col: number, k: number) => DIAG_POSES.map((p, i) => ({ time: i, value: sideValue(sides, k, p[col] as number), curve: "stepped" }));
  return { duration: DIAG_POSES.length, loop: false, fps: 1, bones: { [arm[0]]: { rotate: keys(1, 0) }, [elbow[0]]: { rotate: keys(2, 2) }, [arm[1]]: { rotate: keys(3, 1) }, [elbow[1]]: { rotate: keys(4, 3) } } };
}

/**
 * The slow motion envelope (one clip, 30 fps): the left arm sweeps 0 -> 100 slowly, holds, bends the
 * elbow 0 -> 68 and back while raised, sweeps back to 0 and holds; the right arm lags (asymmetric),
 * peaks at 58 with the elbow at 68, and reverses. Holds at the extremes.
 */
export function sweepClip(arm: [string, string], elbow: [string, string], sides: ArmClipSides = MIRROR_SIDES): any {
  const keys = (pairs: [number, number][], i: number) => pairs.map(([time, value]) => ({ time, value: sideValue(sides, i, value) }));
  return {
    duration: 12,
    loop: false,
    fps: FPS,
    bones: {
      [arm[0]]: { rotate: keys([[0, 0], [4, 100], [7, 100], [11, 0], [12, 0]], 0) },
      [elbow[0]]: { rotate: keys([[0, 0], [4, 0], [5, 68], [6, 68], [7, 0], [12, 0]], 2) },
      [arm[1]]: { rotate: keys([[0, 0], [1.5, 0], [5, 58], [8, 58], [10.5, 0], [12, 0]], 1) },
      [elbow[1]]: { rotate: keys([[0, 0], [3, 0], [5, 68], [8, 68], [9.8, 0], [12, 0]], 3) }
    }
  };
}

/** Skin colour (the body's light skin family), not the cream trim, the grey fabric or the ink. */
export const isSkinColour = (r: number, g: number, b: number): boolean => r > 170 && r - b > 60 && r - g > 20;

export async function garmentImportCommand(positional: readonly string[], flags: Flags): Promise<number> {
  const [rigPath, artPath, outDir] = positional as [string, string, string];
  if (!rigPath || !artPath || !outDir) {
    process.stderr.write("usage: animator garment import <rig.anim.json> <art.png> <out dir> [--name jacket] [--hides tank] [--base <png>] [--margin px] [--domain <json>] [--derive-domain] [--game-scale k] [--no-render]\n");
    return 2;
  }
  if (flags.has("regions") || flags.has("fold")) process.stderr.write("note: --regions/--fold belong to the retired fitted path; the domain declares the groups\n");
  const name = flag(flags, "name") ?? "jacket";
  const hides = (flag(flags, "hides") ?? "").split(",").filter(Boolean);
  const gameScale = Number(flag(flags, "game-scale") ?? 140 / 1074);
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage]));
  const baseTextures = texturesFromAtlas(pack, pages);
  let art: RgbaImage = readPng(artPath);
  const skinKey = Object.keys(raw.skins)[0] as string;
  const meshes = Object.entries(raw.skins[skinKey].attachments as Record<string, Record<string, any>>)
    .flatMap(([slot, byName]) => Object.entries(byName).map(([an, a]) => ({ slot, attachment: an, a })))
    .filter((e) => e.a.type === "mesh" && !e.a.embed);
  // the domain's own skin mesh when it names one (a view garment piece: the side torso sheet has no groups, a
  // side sleeve's mesh is one arm), else the grouped mesh with the most groups (the welded front body)
  const domainPath0 = flag(flags, "domain");
  const declaredSkin = domainPath0 && existsSync(domainPath0) && !flags.has("derive-domain") ? (JSON.parse(readFileSync(domainPath0, "utf8")) as GarmentDomain).skin : null;
  const grouped = meshes.filter((e) => e.a.groups).sort((x, y) => Object.keys(y.a.groups).length - Object.keys(x.a.groups).length)[0];
  const skinEntry = (declaredSkin && grouped && (grouped.slot !== declaredSkin.slot || grouped.attachment !== declaredSkin.attachment) ? meshes.find((e) => e.slot === declaredSkin.slot && e.attachment === declaredSkin.attachment) : grouped) as (typeof meshes)[number] | undefined;
  if (!skinEntry) throw new Error("no grouped skin mesh in the rig");
  if (!skinEntry.a.groups) skinEntry.a = { ...skinEntry.a, groups: { [skinEntry.slot]: [[0, (skinEntry.a.triangles as number[]).length / 3]] } };
  mkdirSync(outDir, { recursive: true });

  // --- the domain (declared data; derived from the art's cut lines once)
  const domainPath = flag(flags, "domain") ?? join(outDir, `${name}.domain.json`);
  const base = flag(flags, "base");
  let domain: GarmentDomain;
  if (flags.has("derive-domain") || !existsSync(domainPath)) {
    domain = deriveDomainFromArt(raw, art, { name, skin: { slot: skinEntry.slot, attachment: skinEntry.attachment }, ...(base ? { base: readPng(base) } : {}), artPath: artPath.replace(/\\/g, "/").replace(/^.*art-drops\//, "ART_DROPS/") });
    mkdirSync(dirname(domainPath), { recursive: true });
    writeFileSync(domainPath, `${JSON.stringify(domain, null, 1)}\n`);
    process.stdout.write(`derived domain -> ${domainPath} (${domain.cuts.map((c) => `${c.name}:${c.points.length}`).join(", ")}; margin ${domain.margin})\n`);
  } else domain = JSON.parse(readFileSync(domainPath, "utf8"));
  // --lengthen-hem <px>: a longer-hem variant of the committed domain
  // and art, built in memory (the domain file is not rewritten): hem cuts moved down the body's
  // material, the art's hem trim moved with them and the fabric continued above it
  let hemEdit: { dy: number; insertRow: number; columns: [number, number] } | null = null;
  if (flag(flags, "lengthen-hem") !== undefined) {
    const dy = Math.round(Number(flag(flags, "lengthen-hem")));
    const moved = lengthenHemDomain(raw, domain, dy);
    domain = moved.domain;
    for (const h of moved.hems) { const e = lengthenHemArt(art, h.from, dy); art = e.art; hemEdit = { dy, insertRow: e.insertRow, columns: e.columns }; }
    writePng(join(outDir, `${name}-art-lengthened.png`), art);
    process.stdout.write(`lengthened hem by ${dy} px: ${JSON.stringify(hemEdit)}
`);
  }
  const margin = flag(flags, "margin") !== undefined ? Number(flag(flags, "margin")) : domain.margin;
  // declared overflow (canvas rectangles) has no garment geometry, binding or draw layer behind it: the
  // body-derived surface would silently drop that paint, so such an import is refused (review #8)
  const overflow = (domain as GarmentDomain & { overflow?: unknown[] }).overflow ?? [];
  if (overflow.length) {
    process.stderr.write(`unsupported: the domain declares ${overflow.length} overflow zone(s); overflow parts have no garment geometry yet (a rigid part past the body is a hard plate: swag:template --type hard-plate)\n`);
    return 2;
  }

  // body stroke style (the skin's own outline contours) and the flat fabric (the art's median fabric colour)
  const bodyContour = Object.values((raw.skins[skinKey].contours?.[skinEntry.slot] ?? {}) as Record<string, any>)[0];
  const strokeWidth = (bodyContour?.width as number | undefined) ?? 10;
  const bodyStrokeColor = (bodyContour?.color as string | undefined) ?? "3a1001ff";
  // the garment's outline colour is the garment's own (domain `stroke.color`, near-black by default);
  // the body keeps its outline
  const strokeColor = flag(flags, "stroke-color") ?? domain.stroke?.color ?? DEFAULT_GARMENT_STROKE;
  const fabric = ((): [number, number, number] => {
    const ch: number[][] = [[], [], []];
    const inkMask = artOutlineInk(art).mask;
    for (let i = 0; i < art.width * art.height; i += 7) {
      const o = i * 4;
      if ((art.data[o + 3] as number) < 250 || inkMask[i]) continue;
      for (let k = 0; k < 3; k++) (ch[k] as number[]).push(art.data[o + k] as number);
    }
    return ch.map((c) => c.sort((a, b) => a - b)[Math.floor(c.length / 2)] ?? 100) as [number, number, number];
  })();
  if (flags.has("derive-details")) {
    const C0 = buildGarmentSurface(raw, { ...domain, details: [] }, { name, margin, strokeWidth, strokeColor, fabric, hides });
    domain.details = deriveCutDetails(raw, domain, C0, art, strokeWidth);
    writeFileSync(domainPath, `${JSON.stringify(domain, null, 1)}\n`);
    process.stdout.write(`derived cut details -> ${domainPath}: ${JSON.stringify(domain.details)}\n`);
  }
  // each neckline sits its own `drop` (default NECKLINE_DROP) px below the art's top edge, in memory
  const necklineDrop = domain.cuts.filter((c) => c.kind === "neckline").map((c) => c.drop ?? NECKLINE_DROP);
  domain = dropNecklines(raw, domain);
  const C = buildGarmentSurface(raw, domain, { name, margin, strokeWidth, strokeColor, fabric, hides });
  const B = buildGarmentSurface(raw, domain, { name, margin: 0, noStrokes: true, fabric, hides });
  // pass 2: the painted art (the zero-margin control keeps flat fabric)
  const trunk = skinEntry.slot;
  const paint = flags.has("flat") ? null : paintGarmentTexture(C, art, { strokeWidth, margin, trunk });
  if (paint) {
    C.texture = paint.texture;
    writePng(join(outDir, `${name}-texture.png`), paint.texture);
    writePng(join(outDir, `${name}-paint-classes.png`), paint.classes);
  }

  // --- documents: (c) the product, (b) the zero-margin core, (a) the bare body
  const slotBone = (s: string) => (raw.slots as any[]).find((x) => x.name === s)?.bone as string;
  // the body's limb chains (the skin's groups, not the domain's: a vest that covers only the upper
  // arms still gets the arm raise and flex clips, which bend the elbows it does not cover)
  const limbs = Object.keys(skinEntry.a.groups as Record<string, unknown>).filter((g) => g !== trunk);
  let sideL = limbs.filter((g) => !g.endsWith("_r")).map(slotBone);
  let sideR = limbs.filter((g) => g.endsWith("_r")).map(slotBone);
  let sides = MIRROR_SIDES;
  // --body <body.json> (phase 2c, a full-body view, no mirror): the arm pair is the near arm part and its
  // `partner` (each chain's first two bones), every bone keyed with its own limits' sign and capped at that limit
  const body = flag(flags, "body") ? loadBodyParts(flag(flags, "body") as string) : null;
  const nearArm = body?.parts.find((p) => p.kind === "arm" && p.depth === "near");
  const farArm = nearArm && body?.parts.find((p) => p.name === nearArm.partner);
  if (body) {
    if (!nearArm || !farArm) throw new Error("--body: no near arm part with a partner");
    sideL = nearArm.chain.slice(0, 2);
    sideR = farArm.chain.slice(0, 2);
    sides = sidesFromLimits(raw, [sideL[0], sideR[0], sideL[1], sideR[1]] as [string, string, string, string]);
  }
  const withClips = (d: any) => {
    if (sideL.length >= 2 && sideR.length >= 2) {
      const arm: [string, string] = [sideL[0] as string, sideR[0] as string];
      const elbow: [string, string] = [sideL[1] as string, sideR[1] as string];
      d.animations.arm_raise = armRaiseClip(arm, elbow, 100, 58, 68, sides);
      d.animations.flex = flexClip(arm, elbow, 58, 68, sides);
      d.animations.diag = diagClip(arm, elbow, sides);
      d.animations.sweep = sweepClip(arm, elbow, sides);
    }
    return d;
  };
  const docC = withClips(dressGarment(raw, C, hides));
  const docB = withClips(dressGarment(raw, B, hides));
  const docA = withClips(structuredClone(raw));
  for (const h of hides) { const s = (docA.slots as any[]).find((x) => x.name === h); if (s) delete s.attachment; }
  const rigName = `${rigPath.replace(/\\/g, "/").split("/").pop()?.replace(/\.anim\.json$/, "")}-${name}`;
  const write = (doc: any, build: GarmentBuild | null, dir: string) => {
    mkdirSync(dir, { recursive: true });
    const tex = new Map(baseTextures);
    if (build) tex.set(build.attachment.path, build.texture);
    const docPath = join(dir, `${rigName}.anim.json`);
    writeFileSync(docPath, JSON.stringify(doc));
    writeAtlas(tex, dir, rigName);
    loadAnimDocument(doc, { source: docPath });
    return { docPath, atlas: join(dir, `${rigName}.atlas.json`), tex };
  };
  const outC = write(docC, C, join(outDir, "rig"));
  const outB = write(docB, B, join(outDir, "diag", "core0"));
  const outA = write(docA, null, join(outDir, "diag", "bare"));

  // --- pose envelope
  const states = new Map<Skeleton, AnimationStateData>();
  const makeSk = (d: any) => {
    const loaded = loadAnimDocument(d);
    const sk = new Skeleton(loaded);
    sk.setActiveSkins([skinKey]);
    states.set(sk, new AnimationStateData(loaded));
    return sk;
  };
  const sample = (sk: Skeleton, clip: string, t: number) => {
    sk.setToSetupPose();
    const st = new AnimationState(states.get(sk) as AnimationStateData);
    st.setAnimation(0, clip, { loop: false });
    st.update(t);
    st.apply(sk);
    sk.updateWorldTransform("none");
  };
  const poses = envelopePoses(docC);
  const skC = makeSk(docC);
  const skB = makeSk(docB);
  // the zero-margin silhouette control: (a) and (b) without any contours (fills only)
  const noContours = (d: any) => { const x = structuredClone(d); delete x.skins[skinKey].contours; return x; };
  const skA = makeSk(noContours(docA));
  const skB0 = makeSk(noContours(docB));
  const samples = domainSamples(raw, domain);
  const L = 180;
  const Tp = 300;
  const width = 720;
  const height = 820;
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  const ropts = { width, height, scale: 1, left: L - ox, top: Tp - oy };
  /** Exposed domain samples: the sample's own body group is the top slot at its posed pixel. */
  const exposure = (sk: Skeleton, tex: Map<string, RgbaImage>) => {
    const R = softRender(sk, tex, { ...ropts, ids: true });
    const top = R.topSlot as Int16Array;
    const slot = sk.getSlot(skinEntry.slot);
    const bw = sk.meshWorldVertices(sk.getAttachment(slot, skinEntry.attachment) as any, slot.bone);
    const T: number[] = skinEntry.a.triangles;
    let exposed = 0;
    let first = "";
    for (const s of samples) {
      let x = 0;
      let y = 0;
      for (let k = 0; k < 3; k++) { const v = T[s.tri * 3 + k] as number; x += (bw[v * 2] as number) * s.w[k]!; y += (bw[v * 2 + 1] as number) * s.w[k]!; }
      const px = Math.floor(x + ox - L);
      const py = Math.floor(y + oy - Tp);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      if (top[py * width + px] === sk.getSlot(s.group).index + 1) { exposed++; if (!first) first = `${s.group} t${s.tri} at ${px + L},${py + Tp}`; }
    }
    return { exposed, first, R };
  };
  const agg = { poses: poses.length, samples: samples.length, zeroMarginMaxGamePx: 0, offsetDevMaxGamePx: 0, joinDevMaxGamePx: 0, boundedJoinsMax: 0, apexMidpointsMax: 0, flipsCore: 0, flipsCoreInherited: 0, flipsStrip: 0, flipAt: [] as string[], webs: [] as string[], tapered: [] as string[], overlaps: [] as string[], exposedC: 0, exposedB: 0, exposedWorst: [] as string[], core0SilhouetteDiffPx: 0 };
  for (const pose of poses) {
    sample(skC, pose.clip, pose.t);
    sample(skB, pose.clip, pose.t);
    const mc = garmentPoseMetrics(skC, C, domain, raw, gameScale);
    const mb = garmentPoseMetrics(skB, B, domain, raw, gameScale);
    agg.zeroMarginMaxGamePx = Math.max(agg.zeroMarginMaxGamePx, mb.zeroMarginMaxGamePx, mc.zeroMarginMaxGamePx);
    agg.offsetDevMaxGamePx = Math.max(agg.offsetDevMaxGamePx, mc.offsetDevMaxGamePx);
    agg.joinDevMaxGamePx = Math.max(agg.joinDevMaxGamePx, mc.joinDevMaxGamePx);
    agg.boundedJoinsMax = Math.max(agg.boundedJoinsMax, mc.boundedJoins);
    agg.apexMidpointsMax = Math.max(agg.apexMidpointsMax, mc.apexMidpoints);
    agg.flipsCore += mc.flipsCore;
    agg.flipsCoreInherited += mc.flipsCoreInherited;
    agg.flipsStrip += mc.flipsStrip;
    for (const f of mc.flipAt) if (agg.flipAt.length < 12) agg.flipAt.push(`${pose.label} ${f}`);
    for (const g of mc.gaps) {
      if (g.verdict === "web") agg.webs.push(`${pose.label} ${g.name} body ${g.bodyGap} garment ${g.garmentGap}`);
      if (g.verdict === "tapered") agg.tapered.push(`${pose.label} ${g.name} body ${g.bodyGap} garment ${g.garmentGap}`);
      if (g.verdict === "overlap") agg.overlaps.push(`${pose.label} ${g.name} body ${g.bodyGap}`);
    }
    const ec = exposure(skC, outC.tex);
    const eb = exposure(skB, outB.tex);
    agg.exposedC += ec.exposed;
    agg.exposedB += eb.exposed;
    if ((ec.exposed || eb.exposed) && agg.exposedWorst.length < 12) agg.exposedWorst.push(`${pose.label} c ${ec.exposed} b ${eb.exposed} first ${ec.first || eb.first}`);
    if (pose.clip === "diag") {
      sample(skA, pose.clip, pose.t);
      sample(skB0, pose.clip, pose.t);
      const RA = softRender(skA, outA.tex, ropts);
      const RB = softRender(skB0, outB.tex, ropts);
      for (let i = 0; i < width * height; i++) {
        const a = RA.image.data[i * 4 + 3] as number;
        const b = RB.image.data[i * 4 + 3] as number;
        if ((b >= 128 && a < 64) || (a >= 128 && b < 64)) agg.core0SilhouetteDiffPx++;
      }
    }
  }

  // --- per-frame coverage: EVERY frame of every clip at 30 fps, pixel exact: a
  // pixel whose top texel is covered skin material (coveredTexelMask, read through the renderer's top
  // texel) is skin showing. Hits are cropped (3x, hits magenta) into coverage/, and the arm raise
  // gets per-frame elbow sheets (both elbows, every frame) to look at.
  const skinTex = baseTextures.get(skinEntry.a.path ?? skinEntry.attachment) as RgbaImage;
  const covMask = coveredTexelMask(raw, domain, skinTex.width, skinTex.height);
  const covDir = join(outDir, "coverage");
  rmSync(covDir, { recursive: true, force: true });
  mkdirSync(covDir, { recursive: true });
  const bodySlots = (sk: Skeleton) => new Set(domain.groups.map((g) => sk.getSlot(g).index + 1));
  const frameExposure = (sk: Skeleton, tex: Map<string, RgbaImage>) => {
    const R = softRender(sk, tex, { ...ropts, ids: true, background: [180, 185, 194] });
    const top = R.topSlot as Int16Array;
    const texel = R.topTexel as Int32Array;
    const slots = bodySlots(sk);
    const hits: number[] = [];
    for (let i = 0; i < top.length; i++) if (slots.has(top[i] as number) && (texel[i] as number) >= 0 && covMask[texel[i] as number]) hits.push(i);
    return { hits, R };
  };
  const cropAt = (img: RgbaImage, cx: number, cy: number, r: number, k: number, mark: number[] = []): RgbaImage => {
    const marked = new Set(mark);
    const w = 2 * r;
    const out = { width: w * k, height: w * k, data: new Uint8Array(w * w * k * k * 4) };
    for (let y = 0; y < w * k; y++) for (let x = 0; x < w * k; x++) {
      const X = Math.round(cx) - r + Math.floor(x / k);
      const Y = Math.round(cy) - r + Math.floor(y / k);
      if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
      const i = Y * img.width + X;
      out.data.set(marked.has(i) ? [255, 0, 255, 255] : img.data.subarray(i * 4, i * 4 + 4), (y * w * k + x) * 4);
    }
    return out;
  };
  const frameClips = ["arm_raise", "flex", docC.animations.walk_flat ? "walk_flat" : "walk_in_place", "idle_weight_shift", "sweep"].filter((c) => docC.animations[c]);
  // the production renderer too (pixi, the game's): skin colour it draws where the soft render (the
  // same frame, 1 px tolerance) has none is skin the runtime shows and the gates cannot see (the 
  // elbow sliver was a stale batch layout of a contour mesh)
  //
  const PROD_TOL = 1;
  const PROD_CLUMP = 8;
  const prodClips = new Set(["arm_raise", "flex", docC.animations.walk_flat ? "walk_flat" : "walk_in_place"]);
  const perFrame: Record<string, { frames: number; exposedFrames: number; exposedPx: number; maxPx: number; prodSkinOnlyFrames?: number; prodSkinOnlyMaxPx?: number; worst: string[] }> = {};
  const hitTiles: { image: RgbaImage; label: string }[] = [];
  const skF = makeSk(docC);
  const garmentSlotIdx = new Set(C.slots.map((x) => skF.getSlot(x.name).index + 1));
  // outline turn angle (notch gate): the worst zig-zag of the garment's posed strokes in every frame,
  // next to the body's own strokes in the same frames (the reference)
  const garmentSlotNames = new Set(C.slots.map((x) => x.name));
  const outlineTurn: Record<string, { garmentDeg: number; bodyDeg: number; worst: string; bodyWorst: string; flagged: number }> = {};
  const zigFrame = (sk: Skeleton, clip: string, f: number) => {
    const t = (outlineTurn[clip] ??= { garmentDeg: 0, bodyDeg: 0, worst: "", bodyWorst: "", flagged: 0 });
    let flagged = false;
    for (const c of sk.activeContours) {
      if (!sk.isContourVisible(c)) continue;
      const slot = sk.contourSlot(c).data.name;
      const pts = new Float32Array(c.pointCount * 2);
      sk.computeContourPoints(c, pts);
      const z = outlineZigDeg(pts, c.pointCount);
      const label = `f${f} ${slot} ${z.deg.toFixed(1)} at ${z.at.map((x) => Math.round(x)).join(",")}`;
      if (garmentSlotNames.has(slot)) {
        if (z.deg > OUTLINE_TURN_MAX_DEG) flagged = true;
        if (z.deg > t.garmentDeg) { t.garmentDeg = z.deg; t.worst = label; }
      } else if (z.deg > t.bodyDeg) { t.bodyDeg = z.deg; t.bodyWorst = label; }
    }
    if (flagged) t.flagged++;
  };
  // every frame: no flipped garment triangle (folds), and the arm/torso clearance read with each
  // anchor's own margin (armGapClearance) at least the bound, in every 30 fps frame of every clip
  const bulk = mediumBulk(domain);
  const armGapBound = bulk?.armGapMinPx ?? ARM_GAP_MIN;
  const everyFrame = { frames: 0, flips: 0, flipAt: [] as string[], armGapMin: Infinity, armGapAt: "", armGapPairs: 0 };
  // phase 2c, a full-body view (--body): the garment is one piece per body mesh (torso sheet, near arm, far arm),
  // so the arm/torso gap is read across pieces: the near pair (the torso piece against the near arm, the near sleeve
  // against the torso) by pieceGapFrame, the far arm (under the torso) by its root under-join (farRootFrame)
  const piece = body ? pieceRole(raw, skinEntry.slot, nearArm as BodyPart, farArm as BodyPart) : null;
  const pieceGap = { pairs: 0, joinPairs: 0, min: Infinity, at: "", farRoots: 0, farEscapes: 0, farAt: "", control: null as null | { at: string; min: number; failsAsRequired: boolean } };
  const farRoots = piece?.role === "far" ? farRootVertices(raw, C, farArm as BodyPart, (farArm as BodyPart).sheet ?? (nearArm as BodyPart).sheet as MeshRef) : [];
  const geomFrame = (sk: Skeleton, clip: string, f: number) => {
    everyFrame.frames++;
    const pm = garmentPoseMetrics(sk, C, domain, raw, gameScale);
    if (pm.flipsCore + pm.flipsStrip) { everyFrame.flips += pm.flipsCore + pm.flipsStrip; if (everyFrame.flipAt.length < 12) everyFrame.flipAt.push(`${clip} f${f} ${pm.flipAt[0] ?? "core"}`); }
    if (piece && piece.role !== "far") {
      // the damaged control on the full raise (arm_raise holds raise 100 from 1.4 to 1.8 s; f 48 = 1.6 s)
      const g = pieceGapFrame(sk, raw, skinKey, piece.self, piece.other, garmentSlotNames, margin, clip === "arm_raise" && f === 48);
      pieceGap.pairs += g.pairs;
      pieceGap.joinPairs += g.joinPairs;
      if (g.control !== undefined) pieceGap.control = { at: `${clip} f${f}`, min: Number(g.control.toFixed(2)), failsAsRequired: g.control < armGapBound };
      if (g.min < pieceGap.min) { pieceGap.min = g.min; pieceGap.at = `${clip} f${f}${g.at ? ` at ${Math.round((g.at[0] as number) + ox)},${Math.round((g.at[1] as number) + oy)}` : ""}`; }
    }
    if (piece?.role === "far") {
      const e = farRootFrame(sk, raw, C, piece.other, farRoots);
      pieceGap.farRoots += farRoots.length;
      pieceGap.farEscapes += e.escapes;
      if (e.escapes && !pieceGap.farAt) pieceGap.farAt = `${clip} f${f} v${e.first}`;
    }
    for (const g of armGapClearance(sk, C, domain)) {
      everyFrame.armGapPairs += g.pairs;
      if (g.min < everyFrame.armGapMin) { everyFrame.armGapMin = g.min; everyFrame.armGapAt = `${clip} f${f} ${g.name}${g.at ? ` at ${g.at.map((x) => Math.round(x)).join(",")}` : ""}`; }
    }
  };
  for (const clip of frameClips) {
    const n = Math.round((docC.animations[clip].duration as number) * FPS);
    const st: (typeof perFrame)[string] = { frames: n + 1, exposedFrames: 0, exposedPx: 0, maxPx: 0, worst: [] };
    const elbowTiles: { image: RgbaImage; label: string }[] = [];
    const prodFrames = prodClips.has(clip) ? (await renderFrames({ document: outC.docPath, atlas: outC.atlas, clip, fps: FPS, scale: 1, background: 0xb4b9c2 })).frames.map((fr) => decodePng(fr.png)) : [];
    if (prodFrames.length) { st.prodSkinOnlyFrames = 0; st.prodSkinOnlyMaxPx = 0; }
    for (let f = 0; f <= n; f++) {
      sample(skF, clip, f / FPS);
      zigFrame(skF, clip, f);
      geomFrame(skF, clip, f);
      const { hits: covHits, R } = frameExposure(skF, outC.tex);
      const P = prodFrames[f];
      const prodOnly: number[] = [];
      if (P) {
        const skinAt = (img: RgbaImage, x: number, y: number) => { const o = (y * img.width + x) * 4; return isSkinColour(img.data[o] as number, img.data[o + 1] as number, img.data[o + 2] as number); };
        for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
          if (!skinAt(P, x + L, y + Tp)) continue;
          let soft = false;
          for (let dy = -PROD_TOL; dy <= PROD_TOL && !soft; dy++) for (let dx = -PROD_TOL; dx <= PROD_TOL; dx++) if (y + dy >= 0 && y + dy < height && x + dx >= 0 && x + dx < width && skinAt(R.image, x + dx, y + dy)) { soft = true; break; }
          if (soft) continue;
          // on or next to the garment only (the body's own skin elsewhere is not this check's)
          let near = false;
          const top = R.topSlot as Int16Array;
          for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (y + dy >= 0 && y + dy < height && x + dx >= 0 && x + dx < width && garmentSlotIdx.has(top[(y + dy) * width + x + dx] as number)) { near = true; break; }
          if (near) prodOnly.push(y * width + x);
        }
        // antialiasing differs between the renderers by a pixel or two: only clumps of at least
        // PROD_CLUMP pixels (8-connected) count
        const left = new Set(prodOnly);
        const keep: number[] = [];
        for (const seed of prodOnly) {
          if (!left.has(seed)) continue;
          const comp = [seed];
          left.delete(seed);
          for (let k = 0; k < comp.length; k++) { const c = comp[k] as number; for (const d of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) if (left.has(c + d)) { left.delete(c + d); comp.push(c + d); } }
          if (comp.length >= PROD_CLUMP) keep.push(...comp);
        }
        prodOnly.length = 0;
        prodOnly.push(...keep);
        if (prodOnly.length) { st.prodSkinOnlyFrames = (st.prodSkinOnlyFrames ?? 0) + 1; st.prodSkinOnlyMaxPx = Math.max(st.prodSkinOnlyMaxPx ?? 0, prodOnly.length); }
      }
      const hits = [...covHits, ...prodOnly];
      if (hits.length) {
        if (covHits.length) { st.exposedFrames++; st.exposedPx += covHits.length; st.maxPx = Math.max(st.maxPx, covHits.length); }
        const xs = hits.map((i) => i % width);
        const ys = hits.map((i) => Math.floor(i / width));
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const label = `${clip} f${f} ${covHits.length}+${prodOnly.length}px at ${Math.round(cx + L)},${Math.round(cy + Tp)}`;
        if (st.worst.length < 12) st.worst.push(label);
        const image = cropAt(R.image, cx, cy, 40, 3, hits);
        writePng(join(covDir, `${clip}-f${String(f).padStart(3, "0")}.png`), image);
        if (hitTiles.length < 48) hitTiles.push({ image, label: `${clip} f${f} ${hits.length}px` });
      }
      if (clip === "arm_raise") for (const b of [sideL[1], sideR[1]] as string[]) {
        const bone = skF.getBone(b);
        // the production frame when there is one (what the game shows), else the soft one
        const img = P ?? R.image;
        const [dx0, dy0] = P ? [L, Tp] : [0, 0];
        elbowTiles.push({ image: cropAt(img, bone.world.x + ox - L + dx0, bone.world.y + oy - Tp + dy0, 60, 2, P ? hits.map((i) => (Math.floor(i / width) + Tp) * img.width + (i % width) + L) : hits), label: `f${f} ${b}${hits.length ? ` ${hits.length}px` : ""}` });
      }
    }
    for (let k = 0; k * 40 < elbowTiles.length; k++) writePng(join(covDir, `${clip}-elbows-${k}.png`), grid(elbowTiles.slice(k * 40, k * 40 + 40), 8, 1));
    perFrame[clip] = st;
  }
  if (hitTiles.length) writePng(join(covDir, "hits-sheet.png"), grid(hitTiles, 6, 1));
  for (const t of Object.values(outlineTurn)) { t.garmentDeg = Number(t.garmentDeg.toFixed(1)); t.bodyDeg = Number(t.bodyDeg.toFixed(1)); }
  process.stdout.write(`outline turn: ${JSON.stringify(outlineTurn)}
`);
  process.stdout.write(`per-frame coverage: ${JSON.stringify(perFrame)}
`);
  const bump = silhouetteBump(C);
  const smoothShift = (C.report.bulk as { smoothShiftMax?: number } | undefined)?.smoothShiftMax ?? 0;
  const silhouette17 = { template: domain.template ?? "simple", bumpPx: bump.maxPx, bumpAt: bump.at?.map((x) => Math.round(x)) ?? null, boundPx: bulk?.maxBumpPx ?? null, smoothShiftPx: Number(smoothShift.toFixed(3)), smoothDev: bulk?.smoothDev ?? null };
  process.stdout.write(`every frame: ${JSON.stringify({ ...everyFrame, armGapBound })} silhouette: ${JSON.stringify(silhouette17)}
`);

  // --- gate-integrity controls: each must FAIL its gate
  const controls: Record<string, unknown> = {};
  {
    // missing triangle: the largest core triangle dropped
    const att = structuredClone(C.attachment);
    const T: number[] = att.triangles;
    let worst = -1;
    let best = 0;
    for (let t = 0; t < T.length / 3; t++) {
      if ((C.parent[t] as number) < 0) continue;
      const p = [0, 1, 2].map((k) => [att.uvs[(T[t * 3 + k] as number) * 2] * att.width, att.uvs[(T[t * 3 + k] as number) * 2 + 1] * att.height]) as number[][];
      const ar = Math.abs(((p[1]![0]! - p[0]![0]!) * (p[2]![1]! - p[0]![1]!) - (p[2]![0]! - p[0]![0]!) * (p[1]![1]! - p[0]![1]!)) / 2);
      if (ar > best) { best = ar; worst = t; }
    }
    T.splice(worst * 3, 3);
    for (const r of Object.values(att.groups as Record<string, [number, number][]>)) for (const range of r) { if (range[0] > worst) range[0]--; if (range[1] > worst) range[1]--; }
    const docM = withClips(dressGarment(raw, { ...C, attachment: att }, hides));
    const skM = makeSk(docM);
    const texM = new Map(outC.tex);
    let exposed = 0;
    for (const pose of poses.filter((p) => p.clip === "diag")) { sample(skM, pose.clip, pose.t); exposed += exposure(skM, texM).exposed; }
    controls.missingTriangle = { removedTriangle: worst, areaPx: Number(best.toFixed(1)), exposedSamples: exposed, failsAsRequired: exposed > 0 };
  }
  {
    // wrong binding: one barycentric core vertex rebound to the next body triangle's first vertex
    const att = structuredClone(C.attachment);
    const k = (att.embed.points as any[]).findIndex((p) => Array.isArray(p) && p[3] > 0.2 && p[4] > 0.2);
    const pt = att.embed.points[k] as number[];
    att.embed.points[k] = (skinEntry.a.triangles as number[]).find((v) => v !== pt[0] && v !== pt[1] && v !== pt[2]) as number;
    const corr = correspondenceGate(raw, att, C.origin);
    const docW = withClips(dressGarment(raw, { ...C, attachment: att }, hides));
    const skW = makeSk(docW);
    let zm = 0;
    for (const pose of poses.filter((p) => p.clip === "diag")) { sample(skW, pose.clip, pose.t); zm = Math.max(zm, garmentPoseMetrics(skW, { ...C, attachment: att }, domain, raw, gameScale).zeroMarginMaxGamePx); }
    controls.wrongBinding = { vertex: att.embed.vertices[k], correspondence: corr, zeroMarginMaxGamePx: Number(zm.toFixed(3)), failsAsRequired: corr.noParent > 0 || corr.restMismatchMax > 0.01 || zm > 0.01 };
  }
  {
    // broken contour: a middle point removed from the longest stroke
    const cs = structuredClone(C.contours);
    const all = Object.values(cs).flatMap((byName) => Object.values(byName));
    const longest = all.sort((a, b) => b.points.length - a.points.length)[0];
    if (longest) longest.points.splice(Math.floor(longest.points.length / 2), 1);
    const g = contourGate(C.attachment, cs, C.paintedEdges);
    controls.brokenContour = { ...g, failsAsRequired: g.unstroked > 0 || g.doubled > 0 };
  }

  {
    // notched outline: a 2 px dip (three points across the middle segment, the middle one 2 px toward
    // the inside) in the longest visible garment stroke at the first arm_raise frame must fail the
    // outline turn bound
    const sk = makeSk(docC);
    sample(sk, frameClips[0] as string, 0);
    let best: { pts: Float32Array; n: number } | null = null;
    for (const c of sk.activeContours) {
      if (!sk.isContourVisible(c) || !garmentSlotNames.has(sk.contourSlot(c).data.name)) continue;
      if (best && best.n >= c.pointCount) continue;
      const pts = new Float32Array(c.pointCount * 2);
      sk.computeContourPoints(c, pts);
      best = { pts, n: c.pointCount };
    }
    let before = 0;
    let after = 0;
    if (best && best.n >= 4) {
      before = outlineZigDeg(best.pts, best.n).deg;
      const m = Math.floor(best.n / 2) - 1;
      const ax = best.pts[m * 2] as number, ay = best.pts[m * 2 + 1] as number;
      const bx = best.pts[m * 2 + 2] as number, by = best.pts[m * 2 + 3] as number;
      const l = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / l, ny = -(bx - ax) / l;
      const dip = [0.25, 0.5, 0.75].flatMap((u) => [ax + (bx - ax) * u + (u === 0.5 ? 2 * nx : 0), ay + (by - ay) * u + (u === 0.5 ? 2 * ny : 0)]);
      const out = Float32Array.from([...best.pts.slice(0, m * 2 + 2), ...dip, ...best.pts.slice(m * 2 + 2)]);
      after = outlineZigDeg(out, best.n + 3).deg;
    }
    controls.notchedOutline = { intactDeg: Number(before.toFixed(1)), notchedDeg: Number(after.toFixed(1)), boundDeg: OUTLINE_TURN_MAX_DEG, failsAsRequired: after > OUTLINE_TURN_MAX_DEG };
  }

  // shared boundaries: draw groups index one vertex array; no seam copies (two vertices with one binding)
  const sharedBoundaries = (() => {
    const att = C.attachment;
    const T: number[] = att.triangles;
    const groupsOf = new Map<number, Set<string>>();
    for (const [g, ranges] of Object.entries(att.groups as Record<string, [number, number][]>)) for (const [s0, e0] of ranges) for (let t = s0; t < e0; t++) for (let k = 0; k < 3; k++) { const v = T[t * 3 + k] as number; const set = groupsOf.get(v) ?? new Set<string>(); set.add(g); groupsOf.set(v, set); }
    const partition = [...groupsOf.values()].filter((x) => x.size > 1).length;
    const keys = new Map<string, number>();
    (att.embed.points as unknown[]).forEach((p) => { const k = JSON.stringify(p); keys.set(k, (keys.get(k) ?? 0) + 1); });
    ((att.embed.offsets?.points ?? []) as unknown[]).forEach((p) => { const k = `o${JSON.stringify(p)}`; keys.set(k, (keys.get(k) ?? 0) + 1); });
    const seamCopies = [...keys.values()].filter((n) => n > 1).length;
    return { partitionVertices: partition, seamCopies, ok: seamCopies === 0 };
  })();
  // runtime state while raised: equip -> remove (tank back) -> replace, against the fresh render
  const runtimeState = (() => {
    const sk = makeSk(docC);
    const iRaise = DIAG_POSES.findIndex((p) => p[0] === "raise 100");
    sample(sk, "diag", iRaise);
    const e1 = exposure(sk, outC.tex);
    // the runtime's own outfit path: slot placeholders, re-resolved by the skin activation (the draw
    // groups follow their owner), on the posed skeleton
    const owner = sk.getSlot(C.ownerSlot);
    const garmentSlots = new Set(C.slots.map((x) => sk.getSlot(x.name).index + 1));
    const reresolve = () => { sk.setActiveSkins([skinKey]); sk.updateWorldTransform("none"); };
    owner.placeholder = null;
    const tankBack: string[] = [];
    for (const h of hides) { const name0 = (raw.slots as any[]).find((x) => x.name === h)?.attachment as string | undefined; if (name0) { sk.getSlot(h).placeholder = name0; tankBack.push(h); } }
    reresolve();
    const R2 = softRender(sk, outC.tex, { ...ropts, ids: true });
    const top2 = R2.topSlot as Int16Array;
    let garmentPx = 0;
    let hiddenPx = 0;
    const hiddenIdx = new Set(tankBack.map((h) => sk.getSlot(h).index + 1));
    for (let i = 0; i < top2.length; i++) { if (garmentSlots.has(top2[i] as number)) garmentPx++; if (hiddenIdx.has(top2[i] as number)) hiddenPx++; }
    owner.placeholder = C.ownerSlot;
    for (const h of tankBack) sk.getSlot(h).placeholder = null;
    reresolve();
    const e3 = exposure(sk, outC.tex);
    let diffPx = 0;
    for (let i = 0; i < e1.R.image.data.length; i += 4) if (Math.abs((e1.R.image.data[i] as number) - (e3.R.image.data[i] as number)) + Math.abs((e1.R.image.data[i + 3] as number) - (e3.R.image.data[i + 3] as number)) > 2) diffPx++;
    // then a pose change after the replace (the coverage follows the new pose)
    sample(sk, "diag", DIAG_POSES.findIndex((p) => p[0] === "flex 58/68"));
    const e4 = exposure(sk, outC.tex);
    return { pose: "raise 100", equippedExposed: e1.exposed, removedGarmentPx: garmentPx, removedHiddenSlotVisiblePx: hiddenPx, replacedExposed: e3.exposed, replacedVsFreshDiffPx: diffPx, afterPoseChangeExposed: e4.exposed, ok: e1.exposed === 0 && garmentPx === 0 && (tankBack.length === 0 || hiddenPx > 0) && e3.exposed === 0 && diffPx === 0 && e4.exposed === 0 };
  })();
  // artwork: rest silhouette against the art (cuff/hem ends within tolerance after the declared
  // details; other excursions reported as declared deviations), trim and closures preserved
  // declared tolerance: painting lost past the runtime silhouette <= 3 px; the art inset inside it
  // <= the stroke half width (the runtime outline covers it)
  const SIL_TOL = 3;
  const SIL_TOL_IN = strokeWidth / 2;
  const silOk = (x: number) => x <= SIL_TOL && x >= -SIL_TOL_IN;
  const sil = silhouetteResidual(C, art, strokeWidth);
  const silFull = sil.filter((r) => !r.tapered);
  const silAbs = silFull.map((r) => Math.abs(r.residual)).sort((p, q) => p - q);
  const runTotal = C.runs.map((_, ri) => Math.max(0, ...sil.filter((r) => r.run === ri).map((r) => r.arc)));
  const cutKindAt = (r: (typeof sil)[number]) => {
    const run = C.runs[r.run];
    if (!run || run.cyclic) return null;
    const fromEnd = Math.min(r.arc, (runTotal[r.run] as number) - r.arc);
    // the end anchor itself is the corner the cut stroke's cap draws
    if (fromEnd > 20 || fromEnd < 3) return null;
    const endV = r.arc < (runTotal[r.run] as number) - r.arc ? run.anchors[0] : run.anchors[run.anchors.length - 1];
    const ep = [(C.attachment.uvs[(endV as number) * 2] as number) * C.attachment.width + C.origin[0], (C.attachment.uvs[(endV as number) * 2 + 1] as number) * C.attachment.height + C.origin[1]];
    let best: { kind: string; dd: number } | null = null;
    for (const c of domain.cuts) for (const mp of [c.points[0], c.points[c.points.length - 1]]) { const q = materialRestOf(raw, domain, mp as [number, number, number]); const dd = Math.hypot(q[0] - (ep[0] as number), q[1] - (ep[1] as number)); if (dd < 8 && (!best || dd < best.dd)) best = { kind: c.kind, dd }; }
    return best ? (best as { kind: string }).kind : null;
  };
  const cutEndRes = silFull.filter((r) => { const k = cutKindAt(r); return k === "cuff" || k === "hem"; });
  const excursions: { run: number; groups: string[]; restFrom: number[]; restTo: number[]; maxResidual: number; at: string }[] = [];
  for (const r of silFull) {
    if (Math.abs(r.residual) <= SIL_TOL) continue;
    const last = excursions[excursions.length - 1];
    if (last && last.run === r.run && Math.sign(last.maxResidual) === Math.sign(r.residual)) { last.restTo = r.rest.map(Math.round); if (!last.groups.includes(r.group)) last.groups.push(r.group); if (Math.abs(r.residual) > Math.abs(last.maxResidual)) last.maxResidual = r.residual; continue; }
    excursions.push({ run: r.run, groups: [r.group], restFrom: r.rest.map(Math.round), restTo: r.rest.map(Math.round), maxResidual: r.residual, at: cutKindAt(r) ?? "boundary" });
  }
  const silhouette = {
    toleranceCanvasPx: { out: SIL_TOL, in: SIL_TOL_IN },
    anchors: silFull.length,
    medianAbs: silAbs[Math.floor(silAbs.length / 2)] ?? null,
    p95Abs: silAbs[Math.floor(silAbs.length * 0.95)] ?? null,
    cutEndAnchors: cutEndRes.length,
    cutEndMaxAbs: Math.max(0, ...cutEndRes.map((r) => Math.abs(r.residual))),
    cutEndResiduals: cutEndRes.map((r) => ({ run: r.run, i: r.i, kind: cutKindAt(r), rest: r.rest.map(Math.round), residual: r.residual })),
    details: domain.details ?? [],
    declaredDeviations: excursions
  };
  // bare-skin ink debt (tracked apart, not a gate): ink-coloured texels of the bare body at rest away from its outline
  const bareInk = (() => {
    sample(skA, "diag", 0);
    const R = softRender(skA, outA.tex, { ...ropts, ids: true });
    const skinSlots = new Set([skinEntry.slot, ...Object.keys(skinEntry.a.groups ?? {})].map((n) => { try { return sk0Index(n); } catch { return -1; } }));
    function sk0Index(n: string) { return skA.getSlot(n).index + 1; }
    const top = R.topSlot as Int16Array;
    let n = 0;
    const al = (i: number) => R.image.data[i * 4 + 3] as number;
    const rad = Math.ceil(strokeWidth / 2) + 1;
    for (let i = 0; i < top.length; i++) {
      if (!skinSlots.has(top[i] as number)) continue;
      const o = i * 4;
      if (!defaultInk(R.image.data[o] as number, R.image.data[o + 1] as number, R.image.data[o + 2] as number)) continue;
      const x = i % width;
      const y = (i - x) / width;
      let edge = false;
      for (let dy = -rad; dy <= rad && !edge; dy++) for (let dx = -rad; dx <= rad; dx++) { const X = x + dx; const Y = y + dy; if (X < 0 || Y < 0 || X >= width || Y >= height || al(Y * width + X) < 128 || !skinSlots.has(top[Y * width + X] as number)) { edge = true; break; } }
      if (!edge) n++;
    }
    return n;
  })();
  // doubled flank line at rest: across each flank anchor (a trunk/limb
  // partition anchor inside the declared underarm taper), the rest render's window within 3 stroke
  // widths of the anchor holds no second LINE beside the outline: a thin dark run (paint darker than
  // the fabric median, not the stroke or its antialiased edge) running FLANK_LINE_MIN_LEN px or more
  // along the local outline direction (tools/flankLines.ts, the earlier "any dark texel"
  // rule also failed belts, quilting and mail reaching the outline). Damaged control: a 3 px stroke
  // FLANK_CONTROL_OFFSET px inside the outline in every window must be found.
  const STROKE_EDGE_TOL = 8;
  const FLANK_LINE_MIN_LEN = 24;
  const FLANK_CONTROL_OFFSET = 6;
  /** outline = stroke texels surviving an opening of this many stroke widths (radius): trim lines are thinner */
  const FLANK_OUTLINE_OPEN = 0.3;
  /** local tone radius (stroke widths) and how far below it a texel is dark (luminance) */
  const FLANK_LOCAL_TONE = 1.5;
  const FLANK_DARK_DELTA = 10;
  const flankDoubled = (() => {
    sample(skC, "diag", 0);
    const R = softRender(skC, outC.tex, ropts);
    // seam anchors (below) read the garment alone: beside an armpit-seam end the bare arm and its own
    // outline sit inside the scan window, and they are not the garment's paint
    const garmentSlotSet = new Set([C.ownerSlot, ...C.slots.map((s) => s.name)].map((n) => skC.getSlot(n)));
    // (the left-out slots do not trim the garment's strokes either: the resting arm covers the top of
    // the flank stroke, and a stroke trimmed under an arm that is not drawn read as a faded half-alpha
    // stroke over the fabric, armour)
    const restAlpha = skC.slots.filter((s) => !garmentSlotSet.has(s)).map((s) => [s, s.color.a] as const);
    for (const [s] of restAlpha) (s.color as { a: number }).a = 0;
    const RG = softRender(skC, outC.tex, { ...ropts, slotFilter: (s) => garmentSlotSet.has(s) });
    for (const [s, a] of restAlpha) (s.color as { a: number }).a = a;
    const gw = skC.meshWorldVertices(skC.getAttachment(skC.getSlot(C.ownerSlot), C.ownerSlot) as any, skC.getSlot(C.ownerSlot).bone);
    const sc = parseInt(strokeColor.slice(0, 6), 16);
    const isStroke = (o: number, I: Uint8Array | Uint8ClampedArray = R.image.data) => Math.abs((I[o] as number) - (sc >> 16)) + Math.abs((I[o + 1] as number) - ((sc >> 8) & 255)) + Math.abs((I[o + 2] as number) - (sc & 255)) < 30;
    const out = { anchors: 0, rows: 0, doubledRows: 0, at: [] as string[], minLen: FLANK_LINE_MIN_LEN, controlFails: true, windows: [] as { anchor: string; maxThinRun: number; lines: number; controlLines: number; controlMaxThinRun: number }[] };
    rmSync(join(outDir, "flank"), { recursive: true, force: true });
    if (!paint) return out;
    // the stroke's own antialiased edge: a texel beside a stroke texel whose colour lies on the blend
    // between the stroke colour and the fabric median (item 6: on the near-black jacket a
    // half-covered edge texel of the flank stroke, 35,32,32, read as a second dark line at y825)
    const sRgb = [sc >> 16, (sc >> 8) & 255, sc & 255] as const;
    const fRgb = paint.report.fabricMedian;
    const strokeEdge = (x: number, y: number, I: Uint8Array | Uint8ClampedArray = R.image.data) => {
      const o = (y * width + x) * 4;
      const d = [0, 1, 2].map((c) => (fRgb[c] as number) - (sRgb[c] as number));
      const q = [0, 1, 2].map((c) => (I[o + c] as number) - (sRgb[c] as number));
      const l2 = (d[0] as number) ** 2 + (d[1] as number) ** 2 + (d[2] as number) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((q[0] as number) * (d[0] as number) + (q[1] as number) * (d[1] as number) + (q[2] as number) * (d[2] as number)) / l2));
      if (Math.hypot((q[0] as number) - t * (d[0] as number), (q[1] as number) - t * (d[1] as number), (q[2] as number) - t * (d[2] as number)) > STROKE_EDGE_TOL) return false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < width && Y < height && isStroke((Y * width + X) * 4, I)) return true; }
      return false;
    };
    // the band beside the stroke the paint eases (SHADE_BESIDE_STROKE widths past its edge), measured
    // from the outline itself (the smoothed outer vertex): a darker texel further out is the
    // art's own fold shading, not a second outline
    //
    const reach = Math.max(3 * strokeWidth, Math.ceil(strokeWidth / 2 + strokeWidth * SHADE_BESIDE_STROKE));
    // a domain whose cut runs down the armpit seam (a capped vest: the cut divides trunk and limb) has no
    // trunk/limb partition on the flank; there the flank starts at that cut's end on the trunk run
    const seamEnds = domain.cuts.filter((c) => c.groups.includes(trunk) && c.groups.some((g) => g !== trunk) && c.points.length).flatMap((c) => [materialRestOf(raw, domain, c.points[0] as any), materialRestOf(raw, domain, c.points[c.points.length - 1] as any)]);
    const cappedLimbs = new Set(domain.cuts.filter((c) => c.kind === "cuff" && !c.groups.includes(trunk)).flatMap((c) => c.groups).filter((g) => domain.groups.includes(g)));
    // phase 2c, a full-body view's pieces: no underarm taper exists between separate pieces. A sleeve piece's
    // windows sit at its upper arm / forearm partition anchors (below them: the forearm's two edges); the torso
    // piece's along its back edge (the side figure faces screen-left, its back is +x), one anchor every 6 stroke
    // widths from the top of the outline to 6 stroke widths above its bottom (the outermost anchor of that row)
    const backAnchors = new Set<string>();
    if (piece?.role === "sheet") {
      const pos = C.runs.flatMap((run, ri) => run.anchors.map((v, i) => ({ ri, i, x: (gw[((run.outer[i] as number) ?? v) * 2] as number) + ox, y: (gw[((run.outer[i] as number) ?? v) * 2 + 1] as number) + oy })));
      const y0 = Math.min(...pos.map((p) => p.y));
      const y1 = Math.max(...pos.map((p) => p.y));
      for (let y = y0 + 6 * strokeWidth; y <= y1 - 6 * strokeWidth; y += 6 * strokeWidth) {
        const row = pos.filter((p) => Math.abs(p.y - y) < 4).sort((p, q) => q.x - p.x)[0];
        if (row) backAnchors.add(`${row.ri}:${row.i}`);
      }
    }
    C.runs.forEach((run, ri) => run.anchors.forEach((v, i) => {
      const g0 = run.cellGroup[i - 1];
      const g1 = run.cellGroup[i];
      if (piece && !(piece.role === "sheet" ? backAnchors.has(`${ri}:${i}`) : g0 && g1 && g0 !== g1)) return;
      // a capped limb (a cuff cut on the limb group itself: short caps): below the apex the bare
      // arm and its own outline sit in the scan window, as beside a seam end; read the garment alone too
      const capped = [g0, g1].some((g) => g && g !== trunk && cappedLimbs.has(g));
      const atSeam = (!run.cyclic && (i === 0 || i === run.anchors.length - 1) && (g0 ?? g1) === trunk && seamEnds.some((p) => Math.hypot((gw[v * 2] as number) + ox - p[0], (gw[v * 2 + 1] as number) + oy - p[1]) < 8));
      if (!piece && !atSeam && (!g0 || !g1 || g0 === g1 || ![g0, g1].includes(trunk) || Math.abs(run.dAt[i] as number) >= margin - 1e-6)) return;
      out.anchors++;
      const ov = (run.outer[i] as number) ?? v;
      const cx = Math.round((gw[ov * 2] as number) + ox - L);
      const cy = Math.round((gw[ov * 2 + 1] as number) + oy - Tp);
      // the scan window (unchanged area: rows strokeWidth..6 stroke widths below the anchor, reach either side)
      const I = atSeam || capped ? RG.image.data : R.image.data;
      const wx0 = Math.max(0, cx - reach), wx1 = Math.min(width - 1, cx + reach);
      const wy0 = Math.max(0, cy + Math.round(strokeWidth)), wy1 = Math.min(height - 1, cy + 6 * strokeWidth);
      if (wy1 < wy0) return;
      const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;
      // (root option a: the outline is the stroke-coloured texels a full stroke across, outlineStroke; a belt's
      // or band's dark trim lines are paint. Dark = darker than the LOCAL paint tone over 1.5 stroke widths,
      // flankDarkMask: against the garment median Mirror's lamellar plates read dark everywhere and the damaged
      // control merged into a wide blob at the left flank)
      const N = ww * wh;
      const lum = new Float32Array(N), opaqueM = new Uint8Array(N), strokeAll = new Uint8Array(N), edgeM = new Uint8Array(N);
      for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) {
        const o = (y * width + x) * 4;
        const k = (y - wy0) * ww + (x - wx0);
        const opaque = (I[o + 3] as number) > 200;
        opaqueM[k] = opaque ? 1 : 0;
        strokeAll[k] = opaque && isStroke(o, I) ? 1 : 0;
        edgeM[k] = opaque && !strokeAll[k] && strokeEdge(x, y, I) ? 1 : 0;
        lum[k] = 0.299 * (I[o] as number) + 0.587 * (I[o + 1] as number) + 0.114 * (I[o + 2] as number);
      }
      const stroke = outlineStroke(strokeAll, ww, wh, FLANK_OUTLINE_OPEN * strokeWidth);
      const inside = new Uint8Array(N);
      for (let k = 0; k < N; k++) inside[k] = opaqueM[k] && !stroke[k] ? 1 : 0;
      const dark = flankDarkMask(lum, inside, edgeM, ww, wh, FLANK_LOCAL_TONE * strokeWidth, FLANK_DARK_DELTA);
      const win = { width: ww, height: wh, dark, stroke, inside };
      // (flagged texels up to a line's allowed thickness apart are one line, so a line crossing a trim band
      // is not dropped as stubs; the damaged control crossing Wrap's obi edge went unfound)
      const opts = { minLen: FLANK_LINE_MIN_LEN, maxThick: Math.round(strokeWidth), reach, bridge: Math.round(strokeWidth) };
      const res = flankParallelLines(win, opts);
      const ctl = flankParallelLines(withParallelStroke(win, FLANK_CONTROL_OFFSET, 3), opts);
      const label = `${g0}|${g1}@${cx + L},${cy + Tp}`;
      out.rows += wh;
      const lineRows = new Set(res.lines.flatMap((ln) => ln.rows));
      out.doubledRows += lineRows.size;
      for (const ln of res.lines) if (out.at.length < 6) out.at.push(`${g0}|${g1} ${ln.x + wx0 + L},${ln.y + wy0 + Tp} len ${ln.length}`);
      out.windows.push({ anchor: label, maxThinRun: res.maxThinRun, lines: res.lines.length, controlLines: ctl.lines.length, controlMaxThinRun: ctl.maxThinRun });
      if (!ctl.lines.length) out.controlFails = false;
      // 4x crop of the window for review: flagged line texels magenta
      const K = 4;
      const crop = { width: ww * K, height: wh * K, data: new Uint8Array(ww * wh * K * K * 4) };
      for (let y = 0; y < wh * K; y++) for (let x = 0; x < ww * K; x++) {
        const k = Math.floor(y / K) * ww + Math.floor(x / K);
        const o = ((Math.floor(y / K) + wy0) * width + Math.floor(x / K) + wx0) * 4;
        const d = (y * ww * K + x) * 4;
        const m = res.flagged[k];
        crop.data[d] = m ? 255 : (I[o] as number); crop.data[d + 1] = m ? 0 : (I[o + 1] as number); crop.data[d + 2] = m ? 255 : (I[o + 2] as number); crop.data[d + 3] = 255;
      }
      writePng(join(outDir, "flank", `${(g0 ?? "x") + "-" + (g1 ?? "x")}-${cx + L}-${cy + Tp}.png`), crop);
    }));
    return out;
  })();
  // garment closure: what the player sees inside the garment's promised
  // coverage, at the 0.4 view and at 1x, over the pose envelope: no garment edge without a line
  // (silhouette stroke gaps, body skin drawn over the garment with no outline of its own), no
  // garment stroke ending in open space, no body line inside the garment; plus the damaged controls
  // on the rest frame (each must fail). Failing frames are cropped (marks magenta) into closure/.
  const closure = (() => {
    const dir = join(outDir, "closure");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const sk = makeSk(docC);
    const win = { left: L - ox, top: Tp - oy, width, height };
    const scales: Record<string, { frames: number; badFrames: number; uninkedPx: number; stubs: number; bodyLinePx: number; worst: string[]; controls: Record<string, unknown> }> = {};
    let controlsFail = true;
    for (const scale of CLOSURE_SCALES) {
      const st = { frames: 0, badFrames: 0, uninkedPx: 0, stubs: 0, bodyLinePx: 0, worst: [] as string[], controls: {} as Record<string, unknown> };
      for (const pose of poses) {
        sample(sk, pose.clip, pose.t);
        const { frame, result, image } = renderClosure(sk, outC.tex, win, scale, garmentSlotNames);
        st.frames++;
        if (pose.clip === "diag" && pose.t === 0) {
          const c = closureControls(frame, closureMinRun(scale));
          st.controls = c;
          if (!Object.values(c).every((x) => x?.failsAsRequired === true)) controlsFail = false;
        }
        if (result.ok) continue;
        st.badFrames++;
        st.uninkedPx += result.uninkedPx;
        st.stubs += result.stubs.length;
        st.bodyLinePx += result.bodyLinePx;
        const at = result.stubs[0] ?? result.uninkedRuns[0] ?? result.bodyLineRuns[0];
        const label = `${pose.label} x${scale}: uninked ${result.uninkedPx} stubs ${result.stubs.length} bodyLine ${result.bodyLinePx}${at ? ` at ${Math.round(at.x / scale + L)},${Math.round(at.y / scale + Tp)}` : ""}`;
        if (st.worst.length < 12) st.worst.push(label);
        if (at && st.badFrames <= 24) {
          const k = scale < 0.7 ? 4 : 2;
          writePng(join(dir, `${pose.label.replace(/[^a-z0-9.@]+/gi, "_")}-x${scale}.png`), cropAt(image, at.x, at.y, Math.round(36 * Math.max(1, scale / 0.5)), k, result.marks));
        }
      }
      scales[String(scale)] = st;
    }
    const ok = Object.values(scales).every((s) => s.badFrames === 0) && controlsFail;
    process.stdout.write(`garment closure: ${JSON.stringify(Object.fromEntries(Object.entries(scales).map(([k, v]) => [k, { badFrames: v.badFrames, frames: v.frames, worst: v.worst.slice(0, 3) }])))}
`);
    return { scales, controlsFail, ok };
  })();
  //: every forearm cuff reaches the bare
  // wrist dip on both sides in every pose (tools/cuffGap.ts: no limb or fist skin above the dip line), and the
  // short-cuff control (the dressed ids with the last 6 px above the dip handed to the fist) on the rest frame fails
  const cuffGap = (() => {
    const arms = sleevedArms(docC, domain.cuts.filter((c) => c.kind === "cuff" && c.groups.length === 1).flatMap((c) => c.groups));
    if (!arms.length) return null;
    const skG = makeSk(docC);
    const skBare = makeSk(docA);
    const garmentSlotIdxG = new Set(C.slots.map((x) => skG.getSlot(x.name).index + 1));
    const idsOf = (sk: Skeleton, tex: Map<string, RgbaImage>) => ({ topSlot: softRender(sk, tex, { ...ropts, ids: true }).topSlot as Int16Array, width, height, left: ropts.left, top: ropts.top });
    // the dip is measured on the bare arm alone (limb + extremity slots) over the whole canvas plus a margin, so
    // the head over a raised fist or the gate window's edge can't cut the fist bulge off the width profile
    const PAD = 200;
    const dipWin = { width: (raw.canvas.width as number) + 2 * PAD, height: (raw.canvas.height as number) + 2 * PAD, left: -ox - PAD, top: -oy - PAD };
    const dipIds = (arm: CuffGapArm) => armDipIds(skBare, outA.tex, arm, dipWin);
    const worst: Record<string, { exposedPx: number; depth: number; uDip: number; at: string }> = {};
    let control: ReturnType<typeof cuffWristGap> = [];
    for (const pose of poses) {
      sample(skG, pose.clip, pose.t);
      sample(skBare, pose.clip, pose.t);
      const gi = idsOf(skG, outC.tex);
      for (const sd of cuffWristGap(skBare, dipIds, skG, gi, arms)) {
        const w = worst[sd.arm];
        if (!w || sd.exposedPx > w.exposedPx) worst[sd.arm] = { exposedPx: sd.exposedPx, depth: sd.depth, uDip: sd.uDip, at: pose.label };
      }
      // (a full-body view: the control hands back only the wrist texels visible in the pose, phase 2c)
      const visible = body ? (arm: CuffGapArm, top: number) => garmentSlotIdxG.has(top) || top === skG.getSlot(arm.limbSlot).index + 1 || top === skG.getSlot(arm.handSlot).index + 1 : undefined;
      if (pose.clip === "diag" && pose.t === 0) control = cuffWristGap(skBare, dipIds, skG, damagedShortCuff(skBare, dipIds, skG, gi, arms, 6, visible), arms);
    }
    const controlFails = control.length === arms.length && control.every((c) => c.exposedPx > GAP_MAX_PX);
    const ok = Object.values(worst).every((w) => w.exposedPx <= GAP_MAX_PX) && controlFails;
    process.stdout.write(`cuff to wrist: ${JSON.stringify({ worst, control, controlFails, ok })}
`);
    return { maxPx: GAP_MAX_PX, worst, control, controlFails, ok };
  })();
  const corrC = correspondenceGate(raw, C.attachment, C.origin);
  const corrB = correspondenceGate(raw, B.attachment, B.origin);
  const contours = contourGate(C.attachment, C.contours, C.paintedEdges);
  const round = (x: number) => Number(x.toFixed(5));
  const gates = {
    correspondence: corrC.noParent === 0 && corrC.negativeWeights === 0 && corrC.restMismatchMax <= 0.01 && corrB.noParent === 0 && corrB.negativeWeights === 0,
    zeroMargin001: agg.zeroMarginMaxGamePx <= 0.01 && agg.core0SilhouetteDiffPx === 0,
    offset025: agg.offsetDevMaxGamePx <= 0.25,
    // bounded joins (miter-limited or reversed offsets) get their own bound
    joinDevBounded: agg.joinDevMaxGamePx <= JOIN_DEV_MAX_GAME_PX,
    noFlips: agg.flipsCore === 0 && agg.flipsStrip === 0,
    //: no fold (flipped garment triangle) in any 30 fps frame, and the arm/torso gap open in every frame
    noFlipsEveryFrame: everyFrame.frames > 0 && everyFrame.flips === 0,
    // (a full-body view's pieces: the near pair's cross-piece gap, the far piece's root under-join; phase 2c)
    armGapEveryFrame: !piece ? everyFrame.armGapPairs > 0 && everyFrame.armGapMin >= armGapBound
      : piece.role === "far" ? pieceGap.farRoots > 0 && pieceGap.farEscapes === 0
      : pieceGap.pairs > 0 && pieceGap.min >= armGapBound && !!pieceGap.control?.failsAsRequired,
    // medium template: the rest outline stays within maxBumpPx of its local fit, the low-pass within smoothDev
    ...(bulk ? { silhouetteSmooth: bump.maxPx <= bulk.maxBumpPx && smoothShift <= bulk.smoothDev + 1e-6 } : {}),
    noClosedGaps: agg.webs.length === 0,
    // the rest underarm slit is narrower than 2m + 1: the declared clearance taper keeps it open (no web)
    gapsTaperedOpen: agg.webs.length === 0 && C.report.clearanceTaper !== undefined,
    coverage0: agg.exposedC === 0 && agg.exposedB === 0,
    coverageEveryFrame: Object.values(perFrame).every((c) => c.exposedFrames === 0 && !c.prodSkinOnlyFrames),
    contours: contours.unstroked === 0 && contours.doubled === 0 && contours.interiorStroked === 0,
    // outline turn angle (notch gate): no garment stroke zig-zags beyond the bound in any clip frame
    outlineTurn: Object.values(outlineTurn).every((t) => t.garmentDeg <= OUTLINE_TURN_MAX_DEG) && (controls.notchedOutline as { failsAsRequired: boolean }).failsAsRequired,
    integrityControlsFail: [controls.missingTriangle, controls.wrongBinding, controls.brokenContour, controls.notchedOutline].every((c) => (c as { failsAsRequired: boolean }).failsAsRequired),
    sharedBoundaries: sharedBoundaries.ok,
    runtimeState: runtimeState.ok,
    garmentClosure: closure.ok,
    ...(cuffGap ? { cuffToWrist: cuffGap.ok } : {}),
    ...(paint ? {
      inkReplaced: paint.report.residualSilhouetteInk === 0 && paint.report.residualOcclusionInk === 0 && contours.unstroked === 0 && contours.doubled === 0,
      artworkTrim: paint.report.creamPreserved >= 0.98 && paint.report.trimLinePreserved >= 0.98,
      artworkCutEnds: cutEndRes.every((r) => silOk(r.residual)),
      //: texture and tone continuity across the last FLANK_BAND px inside the side outline (tools/flankBand.ts,
      // computed by the painter on the texture against the art's own outline band; damaged flat/dark controls must fail)
      flankTexture: !paint || paint.report.flankBand.ok,
      flankSingleLine: flankDoubled.anchors > 0 && flankDoubled.rows > 0 && flankDoubled.doubledRows === 0 && flankDoubled.controlFails
    } : {})
  };
  // --swag-checks: the Swag checks (tools/swagChecks.ts) on the art, next to the gates
  const swagChecks = flags.has("swag-checks") ? swagImportChecks(rigPath, domainPath, hides, art) : null;
  if (swagChecks) Object.assign(gates, { swagChecks: swagChecks.passed });
  const report = {
    swagChecks,
    domain: { path: domainPath, groups: domain.groups, cuts: domain.cuts.map((c) => ({ name: c.name, kind: c.kind, groups: c.groups, points: c.points.length })), seeds: domain.seeds.length, gaps: domain.gaps, margin: domain.margin, usedMargin: margin, necklineDrop },
    build: C.report,
    core0: B.report,
    rigs: { garment: outC.docPath, core0: outB.docPath, bare: outA.docPath },
    correspondence: { garment: corrC, core0: corrB },
    contours,
    matrix: { ...agg, zeroMarginMaxGamePx: round(agg.zeroMarginMaxGamePx), offsetDevMaxGamePx: round(agg.offsetDevMaxGamePx), joinDevMaxGamePx: round(agg.joinDevMaxGamePx), tapered: agg.tapered.slice(0, 12), taperedCount: agg.tapered.length, overlaps: agg.overlaps.slice(0, 12), overlapCount: agg.overlaps.length },
    controls,
    sharedBoundaries,
    runtimeState,
    paint: paint?.report ?? null,
    coverageEveryFrame: perFrame,
    outlineTurn: { boundDeg: OUTLINE_TURN_MAX_DEG, clips: outlineTurn },
    everyFrame: { ...everyFrame, armGapMin: Number(everyFrame.armGapMin.toFixed(2)), armGapBound, ...(piece ? { piece: { role: piece.role, self: piece.self, other: piece.other, ...pieceGap, min: Number(pieceGap.min.toFixed(2)) } } : {}) },
    silhouetteSmooth: silhouette17,
    silhouette,
    bareSkinInkPx: bareInk,
    flankDoubled,
    closure,
    cuffGap,
    gates
  };
  // certification (review #1): every gate must be present and true; a failed gate is a nonzero exit
  // (1), after the report (and the renders) are written, so scripts with `set -e` enforce acceptance
  const failedGates = Object.entries(gates).filter(([, v]) => v !== true).map(([k]) => k);
  const certified = failedGates.length === 0;
  Object.assign(report, { certified, failedGates });
  writeFileSync(join(outDir, `${name}.report.json`), JSON.stringify(report, null, 1));
  process.stdout.write(`${JSON.stringify({ build: C.report, matrix: report.matrix, controls, gates, certified })}\n`);
  if (!certified) process.stderr.write(`NOT CERTIFIED: failed gates ${failedGates.join(", ")}\n`);
  const exitCode = certified ? 0 : 1;
  if (flags.has("no-render")) return exitCode;

  // --- renders: (a) bare | (b) core | (c) garment, the diag poses and the walk, 3x and game size
  const [cx0, cy0, cw, ch] = [150, 340, 780, 680];
  const crop = (img: RgbaImage, k: number): RgbaImage => {
    const x0 = Math.floor(cx0 * k);
    const y0 = Math.floor(cy0 * k);
    const w = Math.ceil(cw * k);
    const h = Math.ceil(ch * k);
    const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let y = 0; y < h; y++) out.data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return out;
  };
  const nearest = (img: RgbaImage, k: number): RgbaImage => {
    const out = { width: img.width * k, height: img.height * k, data: new Uint8Array(img.width * k * img.height * k * 4) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(img.data.subarray((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4 + 4), (y * out.width + x) * 4);
    return out;
  };
  const variants = [["a bare", outA], ["b core m=0", outB], [`c garment m=${margin}`, outC]] as const;
  const frames = async (clip: string, fps: number, scale: number) => Promise.all(variants.map(async ([, o]) => (await renderFrames({ document: o.docPath, atlas: o.atlas, clip, fps, scale, background: 0xb4b9c2 })).frames.map((f) => decodePng(f.png))));
  for (const [scaleTag, k] of [["3x", 3], ["game", 1]] as const) {
    const diag = await frames("diag", 1, gameScale * k);
    const walk = await frames("walk_in_place", FPS, gameScale * k);
    const tile = (img: RgbaImage) => (k === 1 ? nearest(crop(img, gameScale), 3) : crop(img, gameScale * 3));
    for (const [sheet, idx] of [["raise", [0, 1, 2, 3, 4]], ["flex", [5, 6, 7]]] as const) {
      const tiles = (idx as readonly number[]).flatMap((i) => variants.map(([label], v) => ({ image: tile(diag[v]?.[i] as RgbaImage), label: `${label} ${DIAG_POSES[i]?.[0]}` })));
      writePng(join(outDir, `${name}-abc-${sheet}-${scaleTag}.png`), grid(tiles, 3));
    }
    const wi = [0, Math.floor((walk[0]?.length ?? 1) / 4), Math.floor((walk[0]?.length ?? 1) / 2)];
    writePng(join(outDir, `${name}-abc-walk-${scaleTag}.png`), grid(wi.flatMap((i) => variants.map(([label], v) => ({ image: tile(walk[v]?.[i] as RgbaImage), label: `${label} walk f${i}` }))), 3));
    process.stdout.write(`rendered ${scaleTag} sheets\n`);
  }
  if (paint) {
    // the painted garment: idle, walk, raises, flex, asymmetric (3x; game size nearest x3, also at a
    // fractional placement), and 6x crops of the shoulders and flanks in the flex pose
    const prod = async (clip: string, fps: number, scale: number, at?: { x: number; y: number }) => (await renderFrames({ document: outC.docPath, atlas: outC.atlas, clip, fps, scale, background: 0xb4b9c2, ...(at ?? {}) })).frames.map((f) => decodePng(f.png));
    const walkClip = docC.animations.walk_flat ? "walk_flat" : "walk_in_place";
    for (const [scaleTag, k] of [["3x", 3], ["game", 1]] as const) {
      const tile = (img: RgbaImage) => (k === 1 ? nearest(crop(img, gameScale), 3) : crop(img, gameScale * 3));
      const diag = await prod("diag", 1, gameScale * k);
      const idle = docC.animations.idle_weight_shift ? await prod("idle_weight_shift", FPS, gameScale * k) : [];
      const walk = await prod(walkClip, FPS, gameScale * k);
      const tiles: { image: RgbaImage; label: string }[] = [];
      if (idle.length) for (const i of [0, Math.floor(idle.length / 2)]) tiles.push({ image: tile(idle[i] as RgbaImage), label: `idle f${i}` });
      for (const i of [0, Math.floor(walk.length / 4), Math.floor(walk.length / 2)]) tiles.push({ image: tile(walk[i] as RgbaImage), label: `${walkClip} f${i}` });
      DIAG_POSES.forEach((p, i) => { if (i > 0) tiles.push({ image: tile(diag[i] as RgbaImage), label: p[0] }); });
      if (k === 1) {
        const frac = await prod("diag", 1, gameScale, { x: (raw.canvas.originX as number) * gameScale + 0.37, y: (raw.canvas.originY as number) * gameScale + 0.61 });
        for (const i of [4, 5]) tiles.push({ image: tile(frac[i] as RgbaImage), label: `${DIAG_POSES[i]?.[0]} frac +0.37,+0.61` });
      }
      writePng(join(outDir, `${name}-painted-${scaleTag}.png`), grid(tiles, 4));
    }
    // 6x crops: the shoulder (outer trunk/upper-arm partition) and flank (the underarm apex) anchors, posed
    const iFlex = DIAG_POSES.findIndex((p) => p[0] === "flex 58/68");
    sample(skC, "diag", iFlex);
    const gw = skC.meshWorldVertices(skC.getAttachment(skC.getSlot(C.ownerSlot), C.ownerSlot) as any, skC.getSlot(C.ownerSlot).bone);
    const marks: { label: string; v: number; dy: number }[] = [];
    C.runs.forEach((run) => run.anchors.forEach((v, i) => {
      const g0 = run.cellGroup[i - 1];
      const g1 = run.cellGroup[i];
      if (!g0 || !g1 || g0 === g1 || ![g0, g1].includes(trunk)) return;
      const limb = g0 === trunk ? g1 : g0;
      const side = limb.endsWith("_r") ? "right" : "left";
      const flank = Math.abs(run.dAt[i] as number) < margin - 1e-6;
      marks.push({ label: `${flank ? "flank" : "shoulder"}-${side}`, v, dy: flank ? 22 : 0 });
    }));
    const six = (await prod("diag", 1, gameScale * 6))[iFlex] as RgbaImage;
    const S = gameScale * 6;
    const box = 200;
    const crops: { image: RgbaImage; label: string }[] = [];
    for (const mk of marks) {
      const cx = ((gw[mk.v * 2] as number) + ox) * S;
      const cy = ((gw[mk.v * 2 + 1] as number) + oy + mk.dy) * S;
      const w = Math.round(box * S);
      const x0 = Math.max(0, Math.min(six.width - w, Math.round(cx - w / 2)));
      const y0 = Math.max(0, Math.min(six.height - w, Math.round(cy - w / 2)));
      const img = { width: w, height: w, data: new Uint8Array(w * w * 4) };
      for (let y = 0; y < w; y++) img.data.set(six.data.subarray(((y0 + y) * six.width + x0) * 4, ((y0 + y) * six.width + x0 + w) * 4), y * w * 4);
      writePng(join(outDir, `${name}-painted-flex-${mk.label}-6x.png`), img);
      crops.push({ image: nearest(img, 2), label: `flex ${mk.label} 6x (nearest x2)` });
    }
    if (crops.length) writePng(join(outDir, `${name}-painted-flex-crops-6x.png`), grid(crops, 2));
    // 30 fps GIFs of the production renderer at the game size and at a viewing size (0.4)
    for (const clip of ["arm_raise", walkClip, "flex"]) for (const [tag, k] of [["game", gameScale], ["view040", 0.4]] as const) {
      const r = await renderFrames({ document: outC.docPath, atlas: outC.atlas, clip, fps: FPS, scale: k, background: 0xb4b9c2 });
      writeGif(r, join(outDir, `${name}-painted-${clip}-${tag}-30fps.gif`));
    }
    // the garment outline: this garment's colour against the body's brown, on a light and a dark ground (0.4)
    const brownDoc = structuredClone(docC);
    for (const byName of Object.values(brownDoc.skins[skinKey].contours as Record<string, Record<string, any>>)) for (const c of Object.values(byName)) if ((c.mesh?.slot as string | undefined) === C.ownerSlot) c.color = bodyStrokeColor;
    const brownPath = join(dirname(outC.docPath), `${rigName}.outline-brown.anim.json`);
    writeFileSync(brownPath, JSON.stringify(brownDoc));
    const cmpTiles: { image: RgbaImage; label: string }[] = [];
    for (const [bgName, bg] of [["light", 0xb4b9c2], ["dark", 0x1c1e24]] as const) for (const [label, doc] of [[`#${strokeColor.slice(0, 6)}`, outC.docPath], [`body #${bodyStrokeColor.slice(0, 6)}`, brownPath]] as const) {
      const fr = (await renderFrames({ document: doc, atlas: outC.atlas, clip: "diag", fps: 1, scale: 0.4, background: bg })).frames.map((f) => decodePng(f.png));
      for (const i of [0, 4, 5]) cmpTiles.push({ image: crop(fr[i] as RgbaImage, 0.4), label: `${label} ${bgName} ${DIAG_POSES[i]?.[0]}` });
    }
    writePng(join(outDir, `${name}-outline-compare.png`), grid(cmpTiles, 6, 1));
    process.stdout.write("rendered painted sheets, gifs and the outline comparison\n");
  }
  return exitCode;
}

const stem = (path: string) => resolve(path).replace(/\.[cm]?[jt]s$/, "");
if (process.argv[1] && stem(process.argv[1]) === stem(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  garmentImportCommand(positional, flags).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exit(1); });
}
