/*
 * Atlas Animator: original implementation.
 *
 * Held-item swag (swag-rules/STYLE.md, held-item): a weapon or tool held in one fist. Like the hard
 * plate it is NOT built from the body surface: it is one rigid region on a grip bone, a child of the
 * hand bone placed at the grip point, so it moves rigidly with the hand. The spec
 * (`fixtures/garments/*.held.json`, `atlas-held/1`) declares:
 * - the hand bone and the fist slot (whose region and outline are drawn again over the item's hilt, so
 *   the fist always covers the handle whatever the item's draw position);
 * - the grip: the canvas point at rest where the handle passes through the fist, and the setup angle
 *   of the item axis relative to the hand bone (the natural hold); clips may turn the item in the fist
 *   only by grip keys declared in the held clip file (`grip` keys, cli/heldImport.ts), held to
 *   `grip.curve` (max angular velocity, direction changes only on keys) by gripCurveGate;
 * - the art frame: the artist paints the item on the rig canvas with its handle through the fist at
 *   rest and its axis (pommel -> tip) at `art.axis` canvas degrees, inside a box along that axis;
 *   `handleHalfWidth` and `fistRadius` say how narrow the handle must be where the fist covers it.
 * The item slot is NOT anchored, so clips may move it (draw-order keys: behind the body for a
 * wind-up, in front of everything for a strike); the fist copy is anchored right after it and an
 * optional effect slot right before it, so both travel with it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { createImage, type MutableImage, type RgbaImage } from "./image.js";
import { checkSinglePiece } from "./hardPlate.js";
import { checkHolesAndSeeThrough, checkOutlineContrast, checkPaintOutsideAllowed, checkPaletteOutliers, type SwagCheckContext, type SwagCheckResult, type SwagChecksReport } from "./swagChecks.js";

export interface HeldSpec {
  format: "atlas-held/1";
  name: string;
  /** The hand bone the item rides and the fist slot drawn over its hilt (its region attachment and contours are copied). */
  hand: { bone: string; fistSlot: string };
  /**
   * Grip at rest (canvas px: where the handle passes through the fist) and the item axis angle relative to the hand
   * bone (degrees, clockwise). `curve`: how a clip's grip keys may turn the item in the fist (heldClipGates.ts
   * gripCurveGate): at most `maxDegPerSecond` between frames, direction changes only on a key and at least
   * `minReversalGapFrames` apart. Default: no limit given = 1800 deg/s and 3 frames.
   */
  grip: { at: [number, number]; angle: number; curve?: { maxDegPerSecond: number; minReversalGapFrames: number } };
  /**
   * The art frame: the item is painted on the rig canvas with its handle through `grip.at` and its axis
   * (pommel -> tip) at `axis` canvas degrees (90 = straight down). Allowed box along the axis: `behind`
   * px past the grip on the pommel side, `ahead` px on the tip side, `halfWidth` px each side.
   */
  art: { axis: number; behind: number; ahead: number; halfWidth: number; minAhead: number; fistRadius: number; handleHalfWidth: number };
  /** Setup draw position of the item slot: directly before this slot (the fist), so at setup the fist covers the hilt. */
  drawBefore: string;
  stroke?: { color: string };
  source?: Record<string, unknown>;
}

export function loadHeldSpec(path: string): HeldSpec {
  const s = JSON.parse(readFileSync(path, "utf8")) as HeldSpec;
  if (s.format !== "atlas-held/1") throw new Error(`${path}: not an atlas-held/1 spec`);
  if (!s.hand?.bone || !s.hand.fistSlot) throw new Error(`${path}: hand needs bone and fistSlot`);
  if (!Array.isArray(s.grip?.at) || typeof s.grip.angle !== "number") throw new Error(`${path}: grip needs at [x, y] and angle`);
  if (s.grip.curve && !(s.grip.curve.maxDegPerSecond > 0 && Number.isInteger(s.grip.curve.minReversalGapFrames) && s.grip.curve.minReversalGapFrames >= 1)) throw new Error(`${path}: grip.curve needs maxDegPerSecond > 0 and an integer minReversalGapFrames >= 1`);
  for (const k of ["axis", "behind", "ahead", "halfWidth", "minAhead", "fistRadius", "handleHalfWidth"] as const) if (typeof s.art?.[k] !== "number") throw new Error(`${path}: art.${k} must be a number`);
  if (!s.drawBefore) throw new Error(`${path}: drawBefore is required`);
  return s;
}

/** The grip-curve limits of a spec (gripCurveGate), with the defaults. */
export const gripCurveLimits = (spec: HeldSpec, fps: number): { fps: number; maxDegPerSecond: number; minReversalGapFrames: number } => ({ fps, maxDegPerSecond: spec.grip.curve?.maxDegPerSecond ?? 1800, minReversalGapFrames: spec.grip.curve?.minReversalGapFrames ?? 3 });

export const gripBoneName = (spec: HeldSpec): string => `${spec.name}_grip`;
export const fistSlotName = (spec: HeldSpec): string => `${spec.name}_fist`;
export const fxSlotName = (spec: HeldSpec): string => `${spec.name}_fx`;

const rad = (d: number) => (d * Math.PI) / 180;

/** Canvas point -> item frame (u along the art axis from the grip, v across: +v is 90 degrees clockwise of the axis). */
export function toItemFrame(spec: HeldSpec, x: number, y: number): [number, number] {
  const c = Math.cos(rad(spec.art.axis));
  const s = Math.sin(rad(spec.art.axis));
  const dx = x - spec.grip.at[0];
  const dy = y - spec.grip.at[1];
  return [c * dx + s * dy, -s * dx + c * dy];
}

/** The allowed box (1 inside), optionally grown by `pad` px. */
export function heldAreaMask(spec: HeldSpec, w: number, h: number, pad = 0): Uint8Array {
  const m = new Uint8Array(w * h);
  const { behind, ahead, halfWidth } = spec.art;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = toItemFrame(spec, x + 0.5, y + 0.5);
    if (u >= -behind - pad && u <= ahead + pad && Math.abs(v) <= halfWidth + pad) m[y * w + x] = 1;
  }
  return m;
}

/** Check context: allowed = the box; nothing is required (an item need not fill its box). */
export function heldCheckContext(spec: HeldSpec, w: number, h: number): SwagCheckContext {
  return { width: w, height: h, allowed: heldAreaMask(spec, w, h), overflow: new Uint8Array(w * h) };
}

/**
 * Grip registration: the item is held where the spec says. In the item frame, over the art's opaque
 * pixels: (1) the principal axis is within `maxAxisDeg` of the art axis; (2) the handle's centre line
 * passes within `maxOffsetPx` of the grip point (mean v over the fist span |u| <= fistRadius / 2);
 * (3) the handle is continuous through the whole fist span (every 2 px step of |u| <= fistRadius has
 * paint on the axis) and no wider than handleHalfWidth there, so the fist drawn over it hides it
 * across; (4) the item reaches at least `minAhead` px past the grip on the tip side and does not end
 * short behind it (some pommel shows past the fist).
 */
export function checkGripRegistration(art: RgbaImage, spec: HeldSpec, o: { maxAxisDeg?: number; maxOffsetPx?: number } = {}): SwagCheckResult {
  const name = "gripRegistration";
  const maxAxisDeg = o.maxAxisDeg ?? 3;
  const maxOffsetPx = o.maxOffsetPx ?? 4;
  const { width: w, height: h } = art;
  const { fistRadius, handleHalfWidth, minAhead } = spec.art;
  let n = 0, su = 0, sv = 0, suu = 0, svv = 0, suv = 0;
  let uMin = Infinity, uMax = -Infinity;
  const bins = new Map<number, { n: number; sv: number; vMin: number; vMax: number; onAxis: boolean }>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((art.data[(y * w + x) * 4 + 3] as number) < 128) continue;
    const [u, v] = toItemFrame(spec, x + 0.5, y + 0.5);
    n++; su += u; sv += v; suu += u * u; svv += v * v; suv += u * v;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (Math.abs(u) <= fistRadius) {
      const k = Math.floor(u / 2);
      const b = bins.get(k) ?? { n: 0, sv: 0, vMin: Infinity, vMax: -Infinity, onAxis: false };
      b.n++; b.sv += v; b.vMin = Math.min(b.vMin, v); b.vMax = Math.max(b.vMax, v);
      if (Math.abs(v) <= 3) b.onAxis = true;
      bins.set(k, b);
    }
  }
  if (n < 200) return { name, pass: false, reason: "There is almost no item in the image to register against the grip.", metrics: { itemPx: n } };
  const mu = su / n, mv = sv / n;
  const cuu = suu / n - mu * mu, cvv = svv / n - mv * mv, cuv = suv / n - mu * mv;
  // principal axis angle in the item frame (0 = along the art axis)
  const axisDeg = (0.5 * Math.atan2(2 * cuv, cuu - cvv) * 180) / Math.PI;
  let centre = 0, centreN = 0, gaps = 0, widest = 0;
  for (let k = Math.floor(-fistRadius / 2); k <= Math.floor(fistRadius / 2) - 1; k++) {
    const b = bins.get(k);
    if (b) { centre += b.sv; centreN += b.n; }
  }
  for (let k = Math.floor(-fistRadius / 2); k <= Math.floor(fistRadius / 2) - 1; k++) {
    const b = bins.get(k);
    if (!b || !b.onAxis) gaps++;
    else widest = Math.max(widest, Math.max(Math.abs(b.vMin), Math.abs(b.vMax)));
  }
  const offset = centreN ? centre / centreN : NaN;
  const metrics = { itemPx: n, axisDeg: Number(axisDeg.toFixed(2)), handleOffsetPx: Number(offset.toFixed(2)), handleGapSteps: gaps, handleHalfWidthPx: Number(widest.toFixed(1)), aheadPx: Math.round(uMax), behindPx: Math.round(-uMin) };
  const problems: string[] = [];
  if (Math.abs(axisDeg) > maxAxisDeg) problems.push(`the item is tilted ${Math.abs(axisDeg).toFixed(1)} degrees off the guide's axis line (at most ${maxAxisDeg}): keep it straight along the dashed cyan line`);
  if (!(Math.abs(offset) <= maxOffsetPx)) problems.push(Number.isNaN(offset) ? "there is no handle inside the cyan fist circle: the handle must run straight through it" : `the handle runs ${Math.abs(offset).toFixed(1)} px beside the grip point (at most ${maxOffsetPx}): centre the handle on the cyan cross`);
  if (gaps > 0) problems.push(`the handle is broken or missing inside the fist circle (${gaps} gaps along it): draw one solid handle straight through the whole circle`);
  if (widest > handleHalfWidth) problems.push(`the item is ${Math.round(2 * widest)} px wide inside the fist circle (the handle may be at most ${2 * handleHalfWidth} px wide there, so the fist hides it): keep the crossguard and pommel outside the circle`);
  if (uMax < minAhead) problems.push(`the item reaches only ${Math.round(uMax)} px past the grip on the tip side (at least ${minAhead}): make it longer, up to the end of the green box`);
  if (-uMin < fistRadius * 0.6) problems.push("nothing of the handle or pommel shows past the fist on the pommel side: add the pommel just past the fist circle");
  if (problems.length) return { name, pass: false, reason: `The item is not held at the grip: ${problems.join("; ")}.`, metrics };
  return { name, pass: true, reason: `The item is held at the grip (axis ${metrics.axisDeg} deg, handle ${metrics.handleOffsetPx} px off, ${Math.round(2 * widest)} px wide in the fist).`, metrics };
}

/** The held-item checks: outline contrast, palette, paint outside the box, holes, grip registration, one piece. */
export function runHeldChecks(art: RgbaImage, spec: HeldSpec): SwagChecksReport {
  const ctx = heldCheckContext(spec, art.width, art.height);
  const checks = [checkOutlineContrast(art, ctx), checkPaletteOutliers(art, ctx), checkPaintOutsideAllowed(art, ctx), checkHolesAndSeeThrough(art, ctx), checkGripRegistration(art, spec), checkSinglePiece(art)];
  return { passed: checks.every((c) => c.pass), checks, reasons: checks.filter((c) => !c.pass).map((c) => c.reason) };
}

export interface HeldPiece {
  bone: { name: string; parent: string; x: number; y: number; rotation: number };
  attachment: any;
  texturePath: string;
  texture: MutableImage;
  /** The art's opaque bbox on the canvas (x, y, w, h). */
  rest: [number, number, number, number];
}

/**
 * Builds the grip bone and the item region from the art: the opaque pixels inside the box (2 px
 * tolerance) cropped with a 2 px pad. The grip bone sits at `grip.at` (hand-local at the setup pose)
 * turned `grip.angle` from the hand; the region is placed in the grip bone's frame so the art's grip
 * lands on the bone origin and the art axis on the bone's x axis. At setup the item is therefore held
 * at the spec's angle, not where it was painted; posed, it moves rigidly with the hand.
 */
export function buildHeld(raw: any, spec: HeldSpec, art: RgbaImage): HeldPiece {
  const W = raw.canvas.width as number;
  const H = raw.canvas.height as number;
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  if (art.width !== W || art.height !== H) throw new Error(`held art is ${art.width}x${art.height}, the rig canvas is ${W}x${H}`);
  const near = heldAreaMask(spec, W, H, 2);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((art.data[(y * W + x) * 4 + 3] as number) > 0 && near[y * W + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) throw new Error("held art has no paint in its box");
  const pad = 2;
  const tw = x1 - x0 + 1 + 2 * pad;
  const th = y1 - y0 + 1 + 2 * pad;
  const tex = createImage(tw, th);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!near[y * W + x]) continue;
    const o = (y * W + x) * 4;
    tex.data.set(art.data.subarray(o, o + 4), ((y - y0 + pad) * tw + (x - x0 + pad)) * 4);
  }
  const sk = new Skeleton(loadAnimDocument(raw));
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const hand = sk.findBone(spec.hand.bone);
  if (!hand) throw new Error(`no bone ${spec.hand.bone}`);
  const { a, b, c, d, x: tx, y: ty } = hand.world;
  const det = a * d - b * c;
  const gx = spec.grip.at[0] - ox - tx;
  const gy = spec.grip.at[1] - oy - ty;
  const lx = (d * gx - b * gy) / det;
  const ly = (-c * gx + a * gy) / det;
  // region centre in the item frame; the canvas x axis turned into the item frame is -axis
  const [cu, cv] = toItemFrame(spec, x0 - pad + tw / 2, y0 - pad + th / 2);
  // conservative opaque polygon (a region without one trims every stroke under its whole rectangle):
  // the longest straight run of the blade past the fist that is opaque across |v| <= h
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && (art.data[(Math.round(y) * W + Math.round(x)) * 4 + 3] as number) >= 250;
  const ca = Math.cos((spec.art.axis * Math.PI) / 180);
  const sa = Math.sin((spec.art.axis * Math.PI) / 180);
  const canvasOf = (u: number, v: number): [number, number] => [spec.grip.at[0] + ca * u - sa * v, spec.grip.at[1] + sa * u + ca * v];
  const half: number[] = [];
  for (let u = 0; u <= spec.art.ahead; u++) { let h = 0; while (h < spec.art.halfWidth && op(...canvasOf(u, h + 1)) && op(...canvasOf(u, -h - 1))) h++; half.push(h); }
  let best = { u0: 0, u1: -1, h: 0 };
  const minH = 8;
  for (let u0 = Math.ceil(spec.art.fistRadius); u0 < half.length; u0++) {
    if ((half[u0] as number) < minH) continue;
    let h = half[u0] as number;
    let u1 = u0;
    while (u1 + 1 < half.length && (half[u1 + 1] as number) >= minH) { u1++; h = Math.min(h, half[u1] as number); }
    if ((u1 - u0) * h > (best.u1 - best.u0) * best.h) best = { u0, u1, h };
    u0 = u1;
  }
  const opaque = best.u1 > best.u0 ? ([[best.u0, -best.h + 1], [best.u1, -best.h + 1], [best.u1, best.h - 1], [best.u0, best.h - 1]] as const).flatMap(([u, v]) => { const [cx, cy] = canvasOf(u, v); return [Number(((cx - (x0 - pad)) / tw).toFixed(5)), Number(((cy - (y0 - pad)) / th).toFixed(5))]; }) : undefined;
  const path = `swag/${spec.name}`;
  return {
    bone: { name: gripBoneName(spec), parent: spec.hand.bone, x: Number(lx.toFixed(4)), y: Number(ly.toFixed(4)), rotation: spec.grip.angle },
    attachment: { type: "region", path, x: Number(cu.toFixed(4)), y: Number(cv.toFixed(4)), rotation: Number((-spec.art.axis).toFixed(5)), scaleX: 1, scaleY: 1, width: tw, height: th, ...(opaque ? { opaque } : {}) },
    texturePath: path,
    texture: tex,
    rest: [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
  };
}

/**
 * Puts the item into a document: the grip bone (right after the hand bone), the item slot on it
 * (unanchored, set up directly before `spec.drawBefore`), the fist copy slot on the hand bone anchored
 * right after the item (the fist slot's setup attachment and contours, copied), and with `fx` an effect
 * slot anchored right before the item (empty at setup; clips key its attachment).
 */
export function dressHeld(doc: any, piece: HeldPiece, spec: HeldSpec, opts: { attached?: boolean; fx?: { bone: string; attachments: Record<string, any> } } = {}): any {
  const out = structuredClone(doc);
  const skinKey = Object.keys(out.skins)[0] as string;
  const skin = out.skins[skinKey];
  const atts = skin.attachments as Record<string, Record<string, any>>;
  const fistSlot = (out.slots as any[]).find((s) => s.name === spec.hand.fistSlot);
  if (!fistSlot) throw new Error(`fist slot ${spec.hand.fistSlot} is not in the document`);
  const fistAttName = fistSlot.attachment as string | undefined;
  const fistAtt = fistAttName ? atts[spec.hand.fistSlot]?.[fistAttName] : undefined;
  if (!fistAtt) throw new Error(`fist slot ${spec.hand.fistSlot} has no setup attachment in skin ${skinKey}`);
  const bones = (out.bones as any[]).filter((b) => b.name !== piece.bone.name);
  const hi = bones.findIndex((b) => b.name === piece.bone.parent);
  if (hi < 0) throw new Error(`hand bone ${piece.bone.parent} is not in the document`);
  bones.splice(hi + 1, 0, { name: piece.bone.name, parent: piece.bone.parent, x: piece.bone.x, y: piece.bone.y, rotation: piece.bone.rotation, length: 0 });
  out.bones = bones;
  const item = spec.name;
  const fist = fistSlotName(spec);
  const fx = fxSlotName(spec);
  const slots = (out.slots as any[]).filter((s) => ![item, fist, fx].includes(s.name));
  const at = slots.findIndex((s) => s.name === spec.drawBefore);
  if (at < 0) throw new Error(`drawBefore slot ${spec.drawBefore} is not in the document`);
  slots.splice(at, 0, { name: item, bone: piece.bone.name, ...(opts.attached === false ? {} : { attachment: item }), color: "ffffffff" });
  slots.push({ name: fist, bone: fistSlot.bone, drawAfter: item, attachment: fistAttName, color: "ffffffff" });
  if (opts.fx) slots.push({ name: fx, bone: opts.fx.bone, drawBefore: item, color: "ffffffff" });
  out.slots = slots;
  if (out.drawOrder) out.drawOrder = (out.drawOrder as string[]).filter((n) => ![item, fist, fx].includes(n));
  atts[item] = { [item]: piece.attachment };
  atts[fist] = { [fistAttName as string]: structuredClone(fistAtt) };
  if (opts.fx) atts[fx] = structuredClone(opts.fx.attachments);
  const contours = skin.contours?.[spec.hand.fistSlot];
  if (contours) skin.contours[fist] = structuredClone(contours);
  // the fist's contour joins (limb stroke -> fist outline) hold for the copy too: the copy's outline is
  // redrawn exactly like the fist's, and a joined slot never trims the limb stroke it continues
  if (Array.isArray(skin.contourJoins)) {
    const own = (skin.contourJoins as any[]).filter((j) => j.a.slot !== fist && j.b.slot !== fist);
    const copies = own.filter((j) => j.a.slot === spec.hand.fistSlot || j.b.slot === spec.hand.fistSlot).map((j) => ({ ...structuredClone(j), a: j.a.slot === spec.hand.fistSlot ? { ...j.a, slot: fist } : j.a, b: j.b.slot === spec.hand.fistSlot ? { ...j.b, slot: fist } : j.b }));
    skin.contourJoins = [...own, ...copies];
  }
  return out;
}

/**
 * The held-item guide: the body at rest, the allowed box tinted pale green with a 3 px magenta edge,
 * the axis as a dashed cyan line (pommel -> tip), the grip as a cyan cross, the fist circle as a dashed
 * cyan circle and the handle band (the most the handle may be wide inside the circle) as two short
 * cyan lines. For the artist to read; none of it may appear in the art.
 */
export function renderHeldGuide(body: RgbaImage, spec: HeldSpec): MutableImage {
  const { width: w, height: h } = body;
  const out = createImage(w, h);
  out.data.set(body.data);
  const put = (x: number, y: number, r: number, g: number, bl: number, a: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const o = (yi * w + xi) * 4;
    for (const [k, v] of [[0, r], [1, g], [2, bl]] as const) out.data[o + k] = Math.round((out.data[o + k] as number) * (1 - a) + v * a);
    out.data[o + 3] = 255;
  };
  const box = heldAreaMask(spec, w, h);
  const inner = heldAreaMask(spec, w, h, -3);
  for (let i = 0; i < w * h; i++) {
    if (!box[i]) continue;
    if (inner[i]) put(i % w, Math.floor(i / w), 120, 220, 130, 0.35);
    else put(i % w, Math.floor(i / w), 230, 0, 200, 1);
  }
  const c = Math.cos(rad(spec.art.axis));
  const s = Math.sin(rad(spec.art.axis));
  const at = (u: number, v: number): [number, number] => [spec.grip.at[0] + c * u - s * v, spec.grip.at[1] + s * u + c * v];
  const { behind, ahead, fistRadius, handleHalfWidth } = spec.art;
  for (let u = -behind; u <= ahead; u += 0.5) if (Math.floor((u + behind) / 8) % 2 === 0) for (let t = -1; t <= 1; t++) put(...at(u, t), 0, 200, 230, 1);
  for (let k = 0; k < 720; k++) if (Math.floor(k / 12) % 2 === 0) for (let t = -1; t <= 1; t++) { const a = (k / 720) * 2 * Math.PI; put(spec.grip.at[0] + (fistRadius + t) * Math.cos(a), spec.grip.at[1] + (fistRadius + t) * Math.sin(a), 0, 200, 230, 1); }
  for (const side of [-1, 1]) for (let u = -fistRadius; u <= fistRadius; u += 0.5) for (let t = 0; t <= 1; t++) put(...at(u, side * (handleHalfWidth + t)), 0, 200, 230, 1);
  for (let k = -12; k <= 12; k++) for (let t = -1; t <= 1; t++) { put(spec.grip.at[0] + k, spec.grip.at[1] + t, 0, 200, 230, 1); put(spec.grip.at[0] + t, spec.grip.at[1] + k, 0, 200, 230, 1); }
  return out;
}
