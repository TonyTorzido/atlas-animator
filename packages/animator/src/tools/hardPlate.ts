/*
 * Atlas Animator: original implementation.
 *
 * Hard-plate swag (swag-rules/STYLE.md, hard-plate): a rigid piece (pauldron, couter, plate) that
 * rides ONE bone, with no skin deformation. The plate spec (`fixtures/garments/*.plate.json`,
 * `atlas-plate/1`) declares the bone of each side, the slot it is drawn right after (explicit draw
 * order), the allowed area at rest (an ellipse in rig canvas px, left side) and the socket (the
 * joint the plate rides, shown on the guide). The artist paints the LEFT plate only, registered on
 * the rig canvas like every swag; the right plate is the left one mirrored about the body's axis.
 * The plate becomes one region attachment per side, placed so that at rest it lands on the art
 * pixel for pixel; posed, it moves rigidly with its bone. Its convex opaque outline lets it trim
 * the strokes under it (core/coverage.ts rigid coverers).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { createImage, type MutableImage, type RgbaImage } from "./image.js";
import { readPng } from "./png.js";
import { softRender } from "./softRender.js";
import { texturesFromAtlas } from "./validate.js";
import { runSwagChecks, type SwagCheckContext, type SwagCheckOptions, type SwagCheckResult, type SwagChecksReport } from "./swagChecks.js";

export type PlateSide = "l" | "r";

export interface PlateSpec {
  format: "atlas-plate/1";
  name: string;
  /** Per side: the bone the plate rides and the slot it is drawn directly after (draw order). */
  sides: Record<PlateSide, { bone: string; drawAfter: string }>;
  /** Canvas x of the body's mirror axis (default: the rig canvas originX). */
  mirrorAxisX?: number;
  /** Allowed area at rest, LEFT side, canvas px: an ellipse (rotation in degrees, clockwise). */
  area: { cx: number; cy: number; rx: number; ry: number; rotation: number };
  /** The joint the plate rides at rest (canvas px, left side): the guide marks it. */
  socket: [number, number];
  /**
   * Required core: the plate must cover the area scaled by this factor about its centre (a plate
   * smaller than its area is fine, a sliver is not). Default 0.55.
   */
  requiredScale?: number;
  /** Max head-overlap px (posed plate outline under the head's outline) over the evidence clips. */
  maxHeadOverlapPx?: number;
  /**
   * Partial follow: the plate rides a socket bone at the arm joint (a
   * sibling of `sides.*.bone`, coincident with it at rest) that turns by this share of the arm bone's
   * rotation (a world transform constraint: mixRotate = follow, translation 1, scale and shear 0), so
   * the plate caps the joint instead of swinging round it. Omitted: the plate rides the arm bone.
   */
  follow?: number;
  /**
   * onShoulder gate: how far (px) the posed plate's area centroid may pass its joint toward the body's
   * midline (x) in any frame. Default 6.
   */
  maxCentreInsideJointPx?: number;
  /**
   * Declared overflow (armour, STYLE.md hard-plate): where the plate may pass the silhouette of
   * the rig it is worn on, as canvas-px rectangles [x0, y0, x1, y1) of the LEFT side (mirrored for the
   * right). The geometry behind it is the plate's own region on its bone; the `overflowDeclared` gate
   * fails any plate paint past the worn silhouette outside these zones (no zone: the plate stays on the body).
   */
  overflow?: { name: string; rect: [number, number, number, number]; note?: string }[];
  stroke?: { color: string };
  source?: Record<string, unknown>;
}

export function loadPlateSpec(path: string): PlateSpec {
  const s = JSON.parse(readFileSync(path, "utf8")) as PlateSpec;
  if (s.format !== "atlas-plate/1") throw new Error(`${path}: not an atlas-plate/1 spec`);
  if (s.follow !== undefined && !(s.follow >= 0 && s.follow <= 1)) throw new Error(`${path}: follow must be in 0..1`);
  for (const side of ["l", "r"] as const) if (!s.sides?.[side]?.bone || !s.sides[side].drawAfter) throw new Error(`${path}: sides.${side} needs bone and drawAfter`);
  for (const z of s.overflow ?? []) {
    const r = z?.rect;
    if (!z?.name || !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || !(r[2] > r[0] && r[3] > r[1])) throw new Error(`${path}: overflow zones need a name and rect [x0, y0, x1, y1] with x1 > x0, y1 > y0`);
  }
  return s;
}

/** The socket bone a plate side rides when the spec declares `follow`. */
export const socketBoneName = (spec: PlateSpec, side: PlateSide): string => `${spec.name}_socket_${side}`;

export const mirrorAxis = (spec: PlateSpec, raw: any): number => spec.mirrorAxisX ?? (raw.canvas.originX as number);

/** The ellipse mask (1 inside) of the area of `side`, scaled by `k` about its centre. */
export function plateAreaMask(spec: PlateSpec, w: number, h: number, side: PlateSide, axis: number, k = 1): Uint8Array {
  const { cx: cx0, cy, rx, ry, rotation } = spec.area;
  const cx = side === "l" ? cx0 : 2 * axis - cx0;
  const rot = ((side === "l" ? rotation : -rotation) * Math.PI) / 180;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const m = new Uint8Array(w * h);
  const R = Math.max(rx, ry) * k + 1;
  for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, Math.ceil(cy + R)); y++) for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, Math.ceil(cx + R)); x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = (c * dx + s * dy) / (rx * k);
    const v = (-s * dx + c * dy) / (ry * k);
    if (u * u + v * v <= 1) m[y * w + x] = 1;
  }
  return m;
}

/** The declared overflow mask (1 inside any zone) of `side`: the left rectangles, mirrored about `axis` for the right. */
export function plateOverflowMask(spec: PlateSpec, w: number, h: number, side: PlateSide, axis: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (const z of spec.overflow ?? []) {
    const [a0, y0, a1, y1] = z.rect;
    const [x0, x1] = side === "l" ? [a0, a1] : [2 * axis - a1, 2 * axis - a0];
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) m[y * w + x] = 1;
  }
  return m;
}

/**
 * overflowDeclared (STYLE.md hard-plate: plates may pass the body silhouette only through declared
 * overflow): the LEFT plate's opaque paint inside its area that lies past the worn rig's rest silhouette
 * (`silhouette`, 1 = body, grown by `tolerance` px for the anti-aliased edge) must lie inside a declared
 * overflow zone.
 */
export function checkPlateOverflow(art: RgbaImage, silhouette: Uint8Array, spec: PlateSpec, axis: number, tolerance = 2): SwagCheckResult {
  const { width: w, height: h } = art;
  const area = plateAreaMask(spec, w, h, "l", axis);
  const zone = plateOverflowMask(spec, w, h, "l", axis);
  const near = (x: number, y: number) => { for (let dy = -tolerance; dy <= tolerance; dy++) for (let dx = -tolerance; dx <= tolerance; dx++) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && silhouette[Y * w + X]) return true; } return false; };
  let past = 0;
  let undeclared = 0;
  let box = [w, h, -1, -1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!area[i] || (art.data[i * 4 + 3] as number) < 128 || near(x, y)) continue;
    past++;
    if (zone[i]) continue;
    undeclared++;
    box = [Math.min(box[0] as number, x), Math.min(box[1] as number, y), Math.max(box[2] as number, x), Math.max(box[3] as number, y)];
  }
  const metrics = { pastSilhouettePx: past, undeclaredPx: undeclared, zones: (spec.overflow ?? []).map((z) => z.name).join(",") };
  if (undeclared > 0) return { name: "overflowDeclared", pass: false, reason: `${undeclared} px of the plate lie past the body's outline outside any declared overflow zone (around x ${box[0]}-${box[2]}, y ${box[1]}-${box[3]}). The plate may pass the body's outline only inside the orange overflow boxes.`, metrics };
  return { name: "overflowDeclared", pass: true, reason: past ? `The plate passes the body's outline by ${past} px, all inside the declared overflow.` : "The plate stays on the body.", metrics };
}

/** The rest silhouette (1 = opaque) of a rig. */
export function rigRestSilhouette(rigPath: string): Uint8Array {
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const tex = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const img = softRender(sk, tex, { width: raw.canvas.width, height: raw.canvas.height, left: -raw.canvas.originX, top: -raw.canvas.originY }).image;
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) m[i] = (img.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
  return m;
}

/** The image mirrored about the canvas x `axis` (pixel x -> 2 axis - 1 - x). */
export function mirrorImage(img: RgbaImage, axis: number): MutableImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = Math.round(2 * axis - 1 - x);
    if (sx < 0 || sx >= img.width) continue;
    out.data.set(img.data.subarray((y * img.width + sx) * 4, (y * img.width + sx) * 4 + 4), (y * img.width + x) * 4);
  }
  return out;
}

/** The check context of a plate: allowed = the area, required = the scaled core, no overflow. */
export function plateCheckContext(spec: PlateSpec, w: number, h: number, axis: number): SwagCheckContext {
  return { width: w, height: h, allowed: plateAreaMask(spec, w, h, "l", axis), overflow: new Uint8Array(w * h), required: plateAreaMask(spec, w, h, "l", axis, spec.requiredScale ?? 0.55) };
}

/**
 * Plate check options (STYLE.md hard-plate): a plate need not fill its whole area (the area is the
 * limit, not the shape), so registration asks for 70% coverage and a 30% scale band; the other
 * limits are the shared ones.
 */
export const PLATE_CHECK_OPTIONS: SwagCheckOptions = { minCoverage: 0.7, scaleBand: 0.3 };

/** One solid piece: no second opaque component (a stray speck, a detached rivet) of 4 px or more. */
export function checkSinglePiece(art: RgbaImage): SwagCheckResult {
  const { width: w, height: h } = art;
  const op = new Uint8Array(w * h);
  for (let i = 0; i < op.length; i++) op[i] = (art.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
  const seen = new Uint8Array(w * h);
  const sizes: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!op[s] || seen[s]) continue;
    let n = 0;
    const st = [s];
    seen[s] = 1;
    while (st.length) {
      const i = st.pop() as number;
      n++;
      const x = i % w;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || !op[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        st.push(j);
      }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  const extra = sizes.slice(1).filter((n) => n >= 4);
  const metrics = { pieces: sizes.length, extraPieces: extra.length, mainPx: sizes[0] ?? 0 };
  if (!sizes.length) return { name: "singlePiece", pass: false, reason: "The image is empty: draw the plate.", metrics };
  if (extra.length) return { name: "singlePiece", pass: false, reason: `The plate is not one solid piece: ${extra.length} separate bit${extra.length === 1 ? "" : "s"} (${extra.join(", ")} px) float apart from it. A plate is one rigid piece: rivets and trim sit on it, nothing detached.`, metrics };
  return { name: "singlePiece", pass: true, reason: "The plate is one solid piece.", metrics };
}

/** The plate swag checks: the shared five (outline contrast, palette, outside, holes and cracks, registration) plus one solid piece. */
export function runPlateChecks(art: RgbaImage, spec: PlateSpec, axis: number): SwagChecksReport {
  const ctx = plateCheckContext(spec, art.width, art.height, axis);
  const base = runSwagChecks(art, ctx, PLATE_CHECK_OPTIONS);
  const checks = [...base.checks, checkSinglePiece(art)];
  return { passed: checks.every((c) => c.pass), checks, reasons: checks.filter((c) => !c.pass).map((c) => c.reason) };
}

/** Convex hull (monotone chain) of points, counter-clockwise in y-down coordinates order irrelevant. */
function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2] as [number, number], lo[lo.length - 1] as [number, number], q) <= 0) lo.pop(); lo.push(q); }
  const up: [number, number][] = [];
  for (const q of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2] as [number, number], up[up.length - 1] as [number, number], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

export interface PlatePiece {
  side: PlateSide;
  slot: { name: string; bone: string; drawAfter: string };
  /** With `follow`: the socket bone the slot rides (a sibling of `arm`, coincident at rest). */
  socket?: { bone: string; arm: string; follow: number };
  attachment: any;
  texturePath: string;
  texture: MutableImage;
  /** The art's opaque bbox on the canvas at rest (x, y, w, h). */
  rest: [number, number, number, number];
}

/**
 * Builds the region attachment of each side from the left art: the opaque pixels inside the side's
 * area (2 px tolerance) cropped with a 2 px transparent pad, centred where they sit at rest, turned
 * so the image is upright on the canvas at the setup pose (bone world matrix inverted; a mirrored
 * bone frame gets scaleY -1), with the convex hull of its opaque pixels as `opaque`.
 */
export function buildPlates(raw: any, spec: PlateSpec, artLeft: RgbaImage, sides: readonly PlateSide[] = ["l", "r"]): PlatePiece[] {
  const W = raw.canvas.width as number;
  const H = raw.canvas.height as number;
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  if (artLeft.width !== W || artLeft.height !== H) throw new Error(`plate art is ${artLeft.width}x${artLeft.height}, the rig canvas is ${W}x${H}`);
  const axis = mirrorAxis(spec, raw);
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  return sides.map((side) => {
    const art = side === "l" ? artLeft : mirrorImage(artLeft, axis);
    const area = plateAreaMask(spec, W, H, side, axis, 1);
    // the area with a 2 px tolerance (the checks allow anti-aliased edge pixels)
    const near = (x: number, y: number) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; const yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && area[yy * W + xx]) return true; } return false; };
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((art.data[(y * W + x) * 4 + 3] as number) > 0 && near(x, y)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 < 0) throw new Error(`plate art has no paint in the ${side} area`);
    const pad = 2;
    const tw = x1 - x0 + 1 + 2 * pad;
    const th = y1 - y0 + 1 + 2 * pad;
    const tex = createImage(tw, th);
    const pts: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const o = (y * W + x) * 4;
      if (!near(x, y)) continue;
      tex.data.set(art.data.subarray(o, o + 4), ((y - y0 + pad) * tw + (x - x0 + pad)) * 4);
      if ((art.data[o + 3] as number) >= 128) for (const [cx, cy] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) pts.push([(x - x0 + pad + cx) / tw, (y - y0 + pad + cy) / th]);
    }
    const opaque = hull(pts).flatMap(([u, v]) => [Number(Math.min(1, Math.max(0, u)).toFixed(5)), Number(Math.min(1, Math.max(0, v)).toFixed(5))]);
    const bone = sk.findBone(spec.sides[side].bone);
    if (!bone) throw new Error(`no bone ${spec.sides[side].bone}`);
    const { a, b, c, d, x: tx, y: ty } = bone.world;
    const det = a * d - b * c;
    const inv = [d / det, -b / det, -c / det, a / det];
    const cxw = x0 - pad + tw / 2 - ox;
    const cyw = y0 - pad + th / 2 - oy;
    const lx = inv[0]! * (cxw - tx) + inv[1]! * (cyw - ty);
    const ly = inv[2]! * (cxw - tx) + inv[3]! * (cyw - ty);
    // R(rot) S = inv, S = diag(1, +-1): the first column of inv is R's first column
    const rotation = (Math.atan2(inv[2]!, inv[0]!) * 180) / Math.PI;
    const scaleY = det > 0 ? 1 : -1;
    const path = `swag/${spec.name}_${side}`;
    const slotName = `${spec.name}_${side}`;
    // with follow, the slot rides the socket bone; it is coincident with the arm bone at rest, so the
    // region placement computed from the arm bone's setup matrix is the same
    const socket = spec.follow !== undefined ? { bone: socketBoneName(spec, side), arm: spec.sides[side].bone, follow: spec.follow } : undefined;
    return {
      side,
      slot: { name: slotName, bone: socket ? socket.bone : spec.sides[side].bone, drawAfter: spec.sides[side].drawAfter },
      ...(socket ? { socket } : {}),
      attachment: { type: "region", path, x: Number(lx.toFixed(4)), y: Number(ly.toFixed(4)), rotation: Number(rotation.toFixed(5)), scaleX: 1, scaleY, width: tw, height: th, opaque },
      texturePath: path,
      texture: tex,
      rest: [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
    };
  });
}

/**
 * Puts plates into a document: one slot per piece (anchored with `drawAfter`, so the draw order is
 * explicit and travels with its anchor), the region in the first skin; `attached` sets the slot's
 * setup attachment (false: the slot is there, empty, for attach/detach while posed).
 */
export function dressPlates(doc: any, pieces: readonly PlatePiece[], attached = true): any {
  const out = structuredClone(doc);
  const skinKey = Object.keys(out.skins)[0] as string;
  const atts = out.skins[skinKey].attachments as Record<string, Record<string, any>>;
  for (const p of pieces) {
    if (!(out.slots as any[]).some((s) => s.name === p.slot.drawAfter)) throw new Error(`plate anchor slot ${p.slot.drawAfter} is not in the document`);
    if (p.socket) {
      // socket bone: a copy of the arm bone's setup (same parent, same local transform, so it sits on
      // the joint), inserted right after the arm bone; a world transform constraint turns it by
      // `follow` of the arm's rotation and keeps it on the joint
      const bones = (out.bones as any[]).filter((b) => b.name !== p.socket?.bone);
      const ai = bones.findIndex((b) => b.name === p.socket?.arm);
      if (ai < 0) throw new Error(`plate arm bone ${p.socket.arm} is not in the document`);
      const { name: _n, length: _l, ...setup } = bones[ai];
      bones.splice(ai + 1, 0, { ...setup, name: p.socket.bone });
      out.bones = bones;
      const name = `${p.socket.bone}_follow`;
      out.transform = [...((out.transform ?? []) as any[]).filter((c) => c.name !== name), { name, bones: [p.socket.bone], target: p.socket.arm, mixRotate: p.socket.follow, mixX: 1, mixY: 1, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 }];
    }
    out.slots = (out.slots as any[]).filter((s) => s.name !== p.slot.name);
    out.slots.push({ name: p.slot.name, bone: p.slot.bone, drawAfter: p.slot.drawAfter, ...(attached ? { attachment: p.slot.name } : {}) });
    atts[p.slot.name] = { [p.slot.name]: p.attachment };
  }
  return out;
}

/** Posed world corners (canvas px) of a slot's region. */
export function regionCorners(sk: Skeleton, slotName: string, ox: number, oy: number): [number, number][] {
  const out = new Float32Array(8);
  sk.computeSlotWorldVertices(sk.getSlot(slotName), out);
  return [0, 1, 2, 3].map((i) => [(out[i * 2] as number) + ox, (out[i * 2 + 1] as number) + oy] as [number, number]);
}

/** The posed opaque polygon (canvas px) of a region on its slot (uv outline through the corners). */
export function regionOpaquePolygon(sk: Skeleton, slotName: string, opaque: readonly number[], ox: number, oy: number): [number, number][] {
  const [p0, p1, , p3] = regionCorners(sk, slotName, ox, oy) as [[number, number], [number, number], [number, number], [number, number]];
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < opaque.length; i += 2) {
    const u = opaque[i] as number;
    const v = opaque[i + 1] as number;
    pts.push([p0[0] + (p1[0] - p0[0]) * u + (p3[0] - p0[0]) * v, p0[1] + (p1[1] - p0[1]) * u + (p3[1] - p0[1]) * v]);
  }
  return pts;
}

/** Pixel count of the overlap of two polygons (even-odd rasterised at pixel centres). */
export function polygonOverlapPx(a: readonly [number, number][], b: readonly [number, number][]): number {
  const inside = (poly: readonly [number, number][], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i] as [number, number];
      const [xj, yj] = poly[j] as [number, number];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const bb = (p: readonly [number, number][]) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
  const [ax0, ay0, ax1, ay1] = bb(a) as [number, number, number, number];
  const [bx0, by0, bx1, by1] = bb(b) as [number, number, number, number];
  let n = 0;
  for (let y = Math.floor(Math.max(ay0, by0)); y <= Math.ceil(Math.min(ay1, by1)); y++) for (let x = Math.floor(Math.max(ax0, bx0)); x <= Math.ceil(Math.min(ax1, bx1)); x++) if (inside(a, x + 0.5, y + 0.5) && inside(b, x + 0.5, y + 0.5)) n++;
  return n;
}

/** The rig rendered at its setup pose on a white background (the guide's body). */
export function renderRigRest(rigPath: string): MutableImage {
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const atlasPath = rigPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  const tex = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  return softRender(sk, tex, { width: raw.canvas.width, height: raw.canvas.height, left: -raw.canvas.originX, top: -raw.canvas.originY, background: [255, 255, 255] }).image;
}

/**
 * The plate guide: the body at rest, the left area tinted pale green with a 3 px magenta edge, the
 * required core (the area at `requiredScale`, which the plate must cover completely) as a dashed
 * magenta edge, the socket as a cyan cross, the mirrored right area as a grey dashed edge (the
 * engine's copy: paint nothing there), declared overflow zones as orange dashed boxes. For the artist to read; none of it may appear in the art.
 */
export function renderPlateGuide(body: RgbaImage, spec: PlateSpec, axis: number): MutableImage {
  const { width: w, height: h } = body;
  const out = createImage(w, h);
  out.data.set(body.data);
  const put = (i: number, r: number, g: number, b: number, a: number) => {
    const o = i * 4;
    for (const [k, v] of [[0, r], [1, g], [2, b]] as const) out.data[o + k] = Math.round((out.data[o + k] as number) * (1 - a) + v * a);
    out.data[o + 3] = 255;
  };
  const edge = (m: Uint8Array, t: number) => {
    const e = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!m[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      let near = false;
      for (let dy = -t; dy <= t && !near; dy++) for (let dx = -t; dx <= t && !near; dx++) { const xx = x + dx; const yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h || !m[yy * w + xx]) near = true; }
      if (near) e[i] = 1;
    }
    return e;
  };
  const L = plateAreaMask(spec, w, h, "l", axis);
  const R = plateAreaMask(spec, w, h, "r", axis);
  for (let i = 0; i < w * h; i++) if (L[i]) put(i, 120, 220, 130, 0.35);
  const le = edge(L, 3);
  for (let i = 0; i < w * h; i++) if (le[i]) put(i, 230, 0, 200, 1);
  const core = edge(plateAreaMask(spec, w, h, "l", axis, spec.requiredScale ?? 0.55), 2);
  for (let i = 0; i < w * h; i++) if (core[i] && Math.floor(((i % w) + Math.floor(i / w)) / 6) % 2 === 0) put(i, 230, 0, 200, 1);
  const re = edge(R, 2);
  for (let i = 0; i < w * h; i++) if (re[i] && Math.floor(((i % w) + Math.floor(i / w)) / 6) % 2 === 0) put(i, 130, 130, 130, 1);
  // declared overflow zones: orange dashed boxes (as the simple-template guide draws them)
  const ov = edge(plateOverflowMask(spec, w, h, "l", axis), 2);
  for (let i = 0; i < w * h; i++) if (ov[i] && Math.floor(((i % w) + Math.floor(i / w)) / 6) % 2 === 0) put(i, 255, 140, 0, 1);
  const [sx, sy] = spec.socket;
  for (let k = -9; k <= 9; k++) for (let t = -1; t <= 1; t++) for (const [x, y] of [[sx + k, sy + t], [sx + t, sy + k]] as const) if (x >= 0 && y >= 0 && x < w && y < h) put(Math.round(y) * w + Math.round(x), 0, 200, 230, 1);
  return out;
}
