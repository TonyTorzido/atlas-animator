/*
 * Atlas Animator: original implementation.
 *
 * The humanoid preset (plan 4.6 step 3): the 24-bone skeleton, its fit to a front-facing A-pose
 * figure on the template canvas, and its review poses. (The part cut that fed the retired raster
 * rig went in.)
 *
 * Fit ("preset plus a fit pass on the alpha"): the figure's alpha is read row by row. The neck is
 * the narrowest row below the head's widest row; the armpits are the first rows where the arms
 * part from the torso; the crotch is the top of the gap between the legs. Limb axes come from the
 * principal axis of each free-hanging limb's pixels; wrists and ankles are the narrowest point of
 * the lower limb before the hand or foot widens. Proportions the alpha cannot show (where the
 * shoulder pivot sits, how far above the crotch the hips turn) are preset fractions, chosen so the
 * live template reproduces the pivots approved in the AtlasRig review
 * (packages/animator/README.md on feature/atlas-rig--from-t1502): the upper arm turns about the outer
 * top of the shoulder, raise 105 out and 15 in, elbow 70.
 *
 * Side naming follows the game's catalogue: `_l` is screen left (negative x), `_r` screen right.
 */
import type { AnimDocumentInput } from "../core/format.js";
import { connectedComponents, createMask, type Mask } from "./image.js";
import type { Point } from "./outline.js";
import type { ReviewPose } from "./review.js";
import type { BodyPreset } from "./bodyPreset.js";

export type Side = "l" | "r";
export const SIDES: readonly Side[] = ["l", "r"];

export type PartName = "head" | "torso" | "shorts" | "arm_l" | "arm_r" | "leg_l" | "leg_r";
export const PART_NAMES: readonly PartName[] = ["head", "torso", "shorts", "arm_l", "arm_r", "leg_l", "leg_r"];

export interface LimbLandmarks {
  /** Joint the limb chain turns about (upper arm: outer top of the shoulder; thigh: hip). */
  root: Point;
  /** Elbow / knee. */
  middle: Point;
  /** Wrist / ankle. */
  end: Point;
  /** Fist bottom / sole. */
  tip: Point;
  /** Half the limb's typical width. */
  radius: number;
  /** Half the width of the hand or foot. */
  tipRadius: number;
  /** Where the part is cut from the torso: a segment, normal pointing into the limb. */
  cut: { a: Point; b: Point; normal: Point };
  /**
   * Arms: the ball-and-socket cap, a disc round the shoulder joint centre (`root`) of the upper
   * arm's radius (the outline is added by the rig). The cap is drawn above the torso and spins in
   * place when the arm turns.
   */
  cap?: { center: Point; radius: number };
  /** Legs: the first row below the shorts' hem (the leg part starts here). */
  hemY?: number;
}

export interface HumanoidLandmarks {
  canvas: { width: number; height: number };
  /** Skeleton origin on the canvas: centre line at the soles. */
  origin: Point;
  centerX: number;
  topY: number;
  /** Narrowest neck row: head pivot and head cut. */
  neckY: number;
  neckHalfWidth: number;
  /** First row below the neck where the shoulders spread. */
  shoulderTopY: number;
  /** Hip centre height. */
  hipY: number;
  /** Top of the shorts' waistband (the shorts part starts here; the crotch line when unknown). */
  waistY: number;
  crotch: Point;
  torsoRadius: number;
  headRadius: number;
  arms: Record<Side, LimbLandmarks>;
  legs: Record<Side, LimbLandmarks>;
}

/** Preset proportions the alpha cannot show (fractions as described where used). */
export const HUMANOID_PRESET = {
  /** Shoulder pivot height between the shoulder-top row and the armpit row. */
  shoulderPivot: 0.22,
  /** Shoulder pivot inset from the outer edge, in limb radii. */
  shoulderInset: 0.04,
  /**
   * The shoulder joint centre (the arm's pivot and cap centre) from that outer-top point: inward
   * and down, in arm radii. Reproduces AtlasRig's shoulder centre on the live template (right arm
   * (684, 742) from the raise point (694, 716)).
   */
  shoulderCentreIn: 0.2,
  shoulderCentreDown: 0.52,
  /** Elbow position from the shoulder pivot to the wrist. */
  elbow: 0.5,
  /** Hip pivot above the crotch, in leg radii. */
  /** Hip pivot above the crotch, in leg radii. */
  hipAboveCrotch: 0.55,
  /** Knee position from the hip to the ankle. */
  knee: 0.6,
  /** Search window (fractions of the hanging limb length) for the wrist and the ankle. */
  wristWindow: [0.3, 0.75] as const,
  ankleWindow: [0.55, 0.9] as const,
  /** Rotation limits relative to setup, degrees (outward/flex signs mirror between sides). */
  limits: {
    // Root-to-head chain budget 50 degrees (Phase 4 review): a front-only chibi cannot show more.
    pelvis: [-5, 5],
    spine: [-10, 10],
    chest: [-10, 10],
    neck: [-10, 10],
    head: [-15, 15],
    shoulder_l: [-12, 12],
    shoulder_r: [-12, 12],
    // Outward is clockwise (positive) on the left, counter-clockwise on the right.
    upper_arm_l: [-15, 105],
    upper_arm_r: [-105, 15],
    forearm_l: [0, 70],
    forearm_r: [-70, 0],
    hand_l: [-40, 40],
    hand_r: [-40, 40],
    thigh_l: [-10, 30],
    thigh_r: [-30, 10],
    shin_l: [-20, 20],
    shin_r: [-20, 20],
    foot_l: [-25, 25],
    foot_r: [-25, 25]
  } as Record<string, readonly [number, number]>
} as const;

// ---------------------------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------------------------

interface Run {
  start: number;
  end: number;
}

function rowRuns(mask: Mask, y: number): Run[] {
  const runs: Run[] = [];
  const row = y * mask.width;
  let start = -1;
  for (let x = 0; x <= mask.width; x++) {
    const on = x < mask.width && mask.data[row + x] === 1;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      runs.push({ start, end: x - 1 });
      start = -1;
    }
  }
  return runs;
}

/** Runs of at least `minLength` pixels (ignores single-pixel specks in the outline). */
function solidRuns(mask: Mask, y: number, minLength = 3): Run[] {
  return rowRuns(mask, y).filter((run) => run.end - run.start + 1 >= minLength);
}

export class FitError extends Error {}

/**
 * Fits the humanoid landmarks to a figure mask (alpha >= 128, largest component). `ink(x, y)`
 * (dark outline pixels) finds the shorts' waistband and hems; without it the shorts are not split.
 */
export function fitHumanoid(mask: Mask, ink?: (x: number, y: number) => boolean): HumanoidLandmarks {
  const { width, height } = mask;
  let topY = -1;
  let bottomY = -1;
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    const runs = rowRuns(mask, y);
    if (runs.length === 0) continue;
    if (topY < 0) topY = y;
    bottomY = y;
    minX = Math.min(minX, (runs[0] as Run).start);
    maxX = Math.max(maxX, (runs[runs.length - 1] as Run).end);
  }
  if (topY < 0) throw new FitError("the figure is empty");
  const figureHeight = bottomY - topY + 1;
  const centerX = (minX + maxX + 1) / 2;
  const span = (y: number) => {
    const runs = solidRuns(mask, y);
    return runs.length === 0 ? 0 : (runs[runs.length - 1] as Run).end - (runs[0] as Run).start + 1;
  };

  // Head: scanning down, the widest row until the outline pinches below 60% of it (the neck);
  // neck: the narrowest row from there until the shoulders spread.
  let headWidestY = topY;
  let y = topY;
  for (; y < topY + figureHeight * 0.6; y++) {
    if (span(y) > span(headWidestY)) headWidestY = y;
    else if (span(y) < span(headWidestY) * 0.6) break;
  }
  let neckY = y;
  for (; y < bottomY && span(y) < span(headWidestY) * 0.6; y++) if (span(y) > 0 && span(y) < span(neckY)) neckY = y;
  const neckSpan = span(neckY);
  if (neckY <= headWidestY || neckSpan <= 0 || y >= bottomY) throw new FitError("no neck found below the head");
  let shoulderTopY = neckY;
  while (shoulderTopY < bottomY && span(shoulderTopY) < neckSpan * 1.8) shoulderTopY++;

  // Armpits: first row below the shoulders where both arms part from the torso.
  let armpitY = -1;
  for (let y = shoulderTopY; y < bottomY; y++) {
    if (solidRuns(mask, y).length >= 3) {
      armpitY = y;
      break;
    }
  }
  if (armpitY < 0) throw new FitError("the arms never part from the torso (expected an A-pose)");
  const armpitRuns = solidRuns(mask, armpitY);
  const firstRun = armpitRuns[0] as Run;
  const lastRun = armpitRuns[armpitRuns.length - 1] as Run;
  const torsoRun = armpitRuns.find((run) => run.start <= centerX && run.end >= centerX) ?? (armpitRuns[1] as Run);

  // Crotch: top of the transparent column between the legs.
  let crotchY = bottomY;
  while (crotchY > shoulderTopY && mask.data[crotchY * width + Math.round(centerX)] === 0) crotchY--;
  crotchY += 1;
  if (crotchY >= bottomY) throw new FitError("no gap between the legs");

  // Free-hanging limb pixels: components below the armpit / crotch.
  const lower = createMask(width, height);
  for (let y = armpitY; y <= bottomY; y++) for (let x = 0; x < width; x++) lower.data[y * width + x] = mask.data[y * width + x] as number;
  const { labels } = connectedComponents(lower);
  const labelAt = (x: number, y: number) => labels[y * width + x] as number;
  const armLabels: Record<Side, number> = {
    l: labelAt(firstRun.start + 1, armpitY),
    r: labelAt(lastRun.end - 1, armpitY)
  };
  const torsoLabel = labelAt(Math.round(centerX), armpitY + 2);
  for (const side of SIDES) {
    if (armLabels[side] === 0 || armLabels[side] === torsoLabel) {
      throw new FitError(`the ${side === "l" ? "left" : "right"} arm touches the torso below the armpit`);
    }
  }

  const torsoRadius = (torsoRun.end - torsoRun.start + 1) / 2;
  const armRadius = (side: Side) => (side === "l" ? firstRun.end - firstRun.start + 1 : lastRun.end - lastRun.start + 1) / 2;

  const arms = {} as Record<Side, LimbLandmarks>;
  for (const side of SIDES) {
    const pixels = componentPixels(labels, width, armLabels[side]);
    const axis = principalLine(pixels);
    const profile = widthProfile(pixels, axis);
    const [w0, w1] = HUMANOID_PRESET.wristWindow;
    const wristT = narrowest(profile, axis.tMin + w0 * (axis.tMax - axis.tMin), axis.tMin + w1 * (axis.tMax - axis.tMin));
    const wrist = axis.at(wristT);
    const tip = axis.at(axis.tMax);
    const radius = Math.max(armRadius(side), medianWidth(profile, axis.tMin, wristT) / 2);
    // Shoulder pivot: on the outer edge of the shoulder, a preset fraction down to the armpit.
    const pivotY = Math.round(shoulderTopY + HUMANOID_PRESET.shoulderPivot * (armpitY - shoulderTopY));
    const pivotRuns = solidRuns(mask, pivotY);
    const outerX = side === "l" ? (pivotRuns[0] as Run).start : (pivotRuns[pivotRuns.length - 1] as Run).end + 1;
    const inward = side === "l" ? 1 : -1;
    const inset = HUMANOID_PRESET.shoulderInset * radius * inward;
    // Ball and socket (Phase 4c decision): the arm turns about the shoulder joint centre.
    const root = {
      x: outerX + inset + HUMANOID_PRESET.shoulderCentreIn * radius * inward,
      y: pivotY + HUMANOID_PRESET.shoulderCentreDown * radius
    };
    const middle = lerpPoint(root, wrist, HUMANOID_PRESET.elbow);
    const gap = side === "l" ? { from: firstRun.end + 1, to: (armpitRuns[1] as Run).start } : { from: (armpitRuns[armpitRuns.length - 2] as Run).end + 1, to: lastRun.start };
    const armpit = { x: (gap.from + gap.to) / 2, y: armpitY };
    arms[side] = {
      root,
      middle,
      end: wrist,
      tip,
      radius,
      tipRadius: Math.max(...profile.filter((bin) => bin.t > wristT).map((bin) => bin.width), radius * 2) / 2,
      // The cut runs from the armpit up the torso side (the tank's outlined armhole edge) to the
      // shoulder pivot's height, then out to the pivot, so the shoulder cap above the pivot
      // belongs to the torso and its outline never moves (Phase 4 review, 4c).
      // The cut runs from the armpit up the torso side (the tank's outlined armhole edge) to the
      // neck row; the cap round the joint centre covers the shoulder above it.
      cut: { a: armpit, b: { x: armpit.x, y: neckY }, normal: { x: side === "l" ? -1 : 1, y: 0 } },
      cap: { center: root, radius }
    };
  }

  const legs = {} as Record<Side, LimbLandmarks>;
  const legMask = createMask(width, height);
  for (let y = crotchY; y <= bottomY; y++) for (let x = 0; x < width; x++) legMask.data[y * width + x] = mask.data[y * width + x] as number;
  const legComponents = connectedComponents(legMask);
  // The runs on either side of the gap (hands may hang lower than the crotch, further out).
  const crotchRuns = solidRuns(mask, Math.min(bottomY, crotchY + 2));
  const legRuns: Record<Side, Run | undefined> = {
    l: crotchRuns.filter((run) => run.end < centerX).pop(),
    r: crotchRuns.find((run) => run.start > centerX)
  };
  if (!legRuns.l || !legRuns.r) throw new FitError("the legs are not separate below the crotch");
  const legLabels: Record<Side, number> = {
    l: legComponents.labels[(crotchY + 2) * width + legRuns.l.start + 1] as number,
    r: legComponents.labels[(crotchY + 2) * width + legRuns.r.end - 1] as number
  };
  if (legLabels.l === 0 || legLabels.l === legLabels.r) throw new FitError("the legs are not separate below the crotch");
  let hipY = 0;
  for (const side of SIDES) {
    const pixels = componentPixels(legComponents.labels, width, legLabels[side]);
    const axis = principalLine(pixels);
    const profile = widthProfile(pixels, axis);
    const radius = medianWidth(profile, axis.tMin, axis.tMin + 0.5 * (axis.tMax - axis.tMin)) / 2;
    const [a0, a1] = HUMANOID_PRESET.ankleWindow;
    const ankleT = narrowest(profile, axis.tMin + a0 * (axis.tMax - axis.tMin), axis.tMin + a1 * (axis.tMax - axis.tMin));
    const ankle = axis.at(ankleT);
    const tip = axis.at(axis.tMax);
    const outer = side === "l" ? (legRuns.l as Run).start - 2 : (legRuns.r as Run).end + 3;
    const root = axis.atY(crotchY - HUMANOID_PRESET.hipAboveCrotch * radius);
    hipY += root.y / 2;
    // The shorts' hem: the first ink band down the leg's centre below the crotch, and its end.
    const column = Math.round(axis.atY(crotchY + 10).x);
    let row = crotchY;
    while (row < bottomY && !(ink?.(column, row) ?? false)) row++;
    while (row < bottomY && (ink?.(column, row) ?? false)) row++;
    const hemY = row < crotchY + 0.8 * radius ? row : crotchY;
    legs[side] = {
      root,
      middle: lerpPoint(root, ankle, HUMANOID_PRESET.knee),
      end: ankle,
      tip,
      radius,
      tipRadius: Math.max(...profile.filter((bin) => bin.t > ankleT).map((bin) => bin.width), radius * 2) / 2,
      cut: { a: { x: centerX, y: crotchY }, b: { x: outer, y: crotchY }, normal: { x: 0, y: 1 } },
      hemY
    };
  }
  // The shorts' waistband: the first ink band up the torso's side of the centre from the crotch.
  let waistY = crotchY;
  if (ink) {
    const column = Math.round(centerX - 0.5 * torsoRadius);
    let row = crotchY - 4;
    while (row > shoulderTopY && !ink(column, row)) row--;
    while (row > shoulderTopY && ink(column, row)) row--;
    if (row > shoulderTopY) waistY = row + 1;
  }

  return {
    canvas: { width, height },
    origin: { x: centerX, y: bottomY + 1 },
    centerX,
    topY,
    neckY,
    neckHalfWidth: neckSpan / 2,
    shoulderTopY,
    hipY,
    waistY,
    crotch: { x: centerX, y: crotchY },
    torsoRadius,
    headRadius: span(headWidestY) / 2,
    arms,
    legs
  };
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function componentPixels(labels: Int32Array, width: number, label: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== label) continue;
    const x = i % width;
    out.push({ x: x + 0.5, y: (i - x) / width + 0.5 });
  }
  return out;
}

interface Line {
  cx: number;
  cy: number;
  /** Unit direction, pointing down (dy >= 0). */
  dx: number;
  dy: number;
  tMin: number;
  tMax: number;
  at(t: number): Point;
  /** The point on the line at height y. */
  atY(y: number): Point;
}

/** Principal axis of a pixel set, oriented downwards, with the pixels' extent along it. */
function principalLine(pixels: readonly Point[]): Line {
  const n = pixels.length;
  const cx = pixels.reduce((s, p) => s + p.x, 0) / n;
  const cy = pixels.reduce((s, p) => s + p.y, 0) / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const p of pixels) {
    xx += (p.x - cx) ** 2;
    yy += (p.y - cy) ** 2;
    xy += (p.x - cx) * (p.y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  if (dy < 0 || (dy === 0 && dx < 0)) {
    dx = -dx;
    dy = -dy;
  }
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of pixels) {
    const t = (p.x - cx) * dx + (p.y - cy) * dy;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  return {
    cx, cy, dx, dy, tMin, tMax,
    at: (t) => ({ x: cx + dx * t, y: cy + dy * t }),
    atY: (y) => {
      const t = Math.abs(dy) > 1e-9 ? (y - cy) / dy : 0;
      return { x: cx + dx * t, y: cy + dy * t };
    }
  };
}

interface WidthBin {
  t: number;
  width: number;
}

/** Width across the axis in 4 px bins along it. */
function widthProfile(pixels: readonly Point[], line: Line): WidthBin[] {
  const bin = 4;
  const count = Math.max(1, Math.ceil((line.tMax - line.tMin) / bin) + 1);
  const lo = new Array<number>(count).fill(Infinity);
  const hi = new Array<number>(count).fill(-Infinity);
  for (const p of pixels) {
    const t = (p.x - line.cx) * line.dx + (p.y - line.cy) * line.dy;
    const s = -(p.x - line.cx) * line.dy + (p.y - line.cy) * line.dx;
    const k = Math.min(count - 1, Math.floor((t - line.tMin) / bin));
    lo[k] = Math.min(lo[k] as number, s);
    hi[k] = Math.max(hi[k] as number, s);
  }
  const out: WidthBin[] = [];
  for (let k = 0; k < count; k++) {
    if ((hi[k] as number) >= (lo[k] as number)) out.push({ t: line.tMin + (k + 0.5) * bin, width: (hi[k] as number) - (lo[k] as number) + 1 });
  }
  return out;
}

function narrowest(profile: readonly WidthBin[], from: number, to: number): number {
  let best: WidthBin | null = null;
  for (const bin of profile) {
    if (bin.t < from || bin.t > to) continue;
    if (!best || bin.width < best.width) best = bin;
  }
  return best ? best.t : (from + to) / 2;
}

function medianWidth(profile: readonly WidthBin[], from: number, to: number): number {
  const widths = profile.filter((bin) => bin.t >= from && bin.t <= to).map((bin) => bin.width).sort((a, b) => a - b);
  return widths.length > 0 ? (widths[Math.floor(widths.length / 2)] as number) : 0;
}

// ---------------------------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------------------------

export interface HumanoidBoneSpec {
  name: string;
  parent: string | null;
  /** Canvas start and end (end defines direction and length). */
  start: Point;
  end: Point;
  /** Half-width of the body around this bone (weights: capsule radius and joint bands). */
  radius: number;
  limits?: readonly [number, number] | undefined;
}

/** The 24 bones in canvas space, parents first. */
export function humanoidBoneSpecs(landmarks: HumanoidLandmarks): HumanoidBoneSpec[] {
  const { centerX: cx, hipY, shoulderTopY, neckY, topY, torsoRadius, headRadius, origin } = landmarks;
  const limits = HUMANOID_PRESET.limits;
  const span = hipY - shoulderTopY;
  const pelvisTop = { x: cx, y: hipY - span * 0.33 };
  const spineTop = { x: cx, y: hipY - span * 0.66 };
  const neckBase = { x: cx, y: shoulderTopY };
  const neck = { x: cx, y: neckY };
  const specs: HumanoidBoneSpec[] = [
    { name: "root", parent: null, start: origin, end: { x: origin.x + 1, y: origin.y }, radius: 0 },
    { name: "pelvis", parent: "root", start: { x: cx, y: hipY }, end: pelvisTop, radius: torsoRadius, limits: limits.pelvis },
    { name: "spine", parent: "pelvis", start: pelvisTop, end: spineTop, radius: torsoRadius, limits: limits.spine },
    { name: "chest", parent: "spine", start: spineTop, end: neckBase, radius: torsoRadius, limits: limits.chest },
    { name: "neck", parent: "chest", start: neckBase, end: neck, radius: landmarks.neckHalfWidth, limits: limits.neck },
    { name: "head", parent: "neck", start: neck, end: { x: cx, y: topY }, radius: headRadius, limits: limits.head }
  ];
  for (const side of SIDES) {
    const arm = landmarks.arms[side];
    const sign = side === "l" ? -1 : 1;
    specs.push(
      {
        name: `shoulder_${side}`,
        parent: "chest",
        start: { x: cx + sign * landmarks.neckHalfWidth * 0.5, y: shoulderTopY + 4 },
        end: arm.root,
        radius: arm.radius,
        limits: limits[`shoulder_${side}`]
      },
      { name: `upper_arm_${side}`, parent: `shoulder_${side}`, start: arm.root, end: arm.middle, radius: arm.radius, limits: limits[`upper_arm_${side}`] },
      { name: `forearm_${side}`, parent: `upper_arm_${side}`, start: arm.middle, end: arm.end, radius: arm.radius, limits: limits[`forearm_${side}`] },
      { name: `hand_${side}`, parent: `forearm_${side}`, start: arm.end, end: arm.tip, radius: arm.tipRadius, limits: limits[`hand_${side}`] }
    );
  }
  for (const side of SIDES) {
    const leg = landmarks.legs[side];
    specs.push(
      { name: `thigh_${side}`, parent: "pelvis", start: leg.root, end: leg.middle, radius: leg.radius, limits: limits[`thigh_${side}`] },
      { name: `shin_${side}`, parent: `thigh_${side}`, start: leg.middle, end: leg.end, radius: leg.radius, limits: limits[`shin_${side}`] },
      { name: `foot_${side}`, parent: `shin_${side}`, start: leg.end, end: leg.tip, radius: leg.tipRadius, limits: limits[`foot_${side}`] }
    );
  }
  // IK targets (keyed by clips; the IK constraints start at mix 0 so the setup pose is unchanged).
  for (const side of SIDES) {
    specs.push({ name: `hand_${side}_target`, parent: "root", start: landmarks.arms[side].end, end: landmarks.arms[side].tip, radius: 0 });
  }
  for (const side of SIDES) {
    specs.push({ name: `foot_${side}_target`, parent: "root", start: landmarks.legs[side].end, end: landmarks.legs[side].tip, radius: 0 });
  }
  return specs;
}

/**
 * Document bones from canvas specs: local transforms under unit-scale parents, angles in degrees
 * clockwise (y down), positions relative to the parent's start in the parent's frame.
 */
export function bonesFromSpecs(specs: readonly HumanoidBoneSpec[], origin: Point): NonNullable<AnimDocumentInput["bones"]> {
  const world = new Map<string, { x: number; y: number; angle: number }>();
  const round = (value: number, digits = 3) => Number(value.toFixed(digits));
  return specs.map((spec) => {
    const angle = spec.parent === null ? 0 : (Math.atan2(spec.end.y - spec.start.y, spec.end.x - spec.start.x) * 180) / Math.PI;
    const length = spec.parent === null ? 0 : Math.hypot(spec.end.x - spec.start.x, spec.end.y - spec.start.y);
    const sx = spec.start.x - origin.x;
    const sy = spec.start.y - origin.y;
    world.set(spec.name, { x: sx, y: sy, angle });
    if (spec.parent === null) return { name: spec.name };
    const parent = world.get(spec.parent);
    if (!parent) throw new Error(`bone '${spec.name}': parent '${spec.parent}' is not listed before it`);
    const r = (-parent.angle * Math.PI) / 180;
    const dx = sx - parent.x;
    const dy = sy - parent.y;
    const bone: NonNullable<AnimDocumentInput["bones"]>[number] = {
      name: spec.name,
      parent: spec.parent,
      x: round(dx * Math.cos(r) - dy * Math.sin(r)),
      y: round(dx * Math.sin(r) + dy * Math.cos(r)),
      rotation: round(angle - parent.angle),
      length: round(length)
    };
    if (spec.limits) bone.limits = { min: spec.limits[0], max: spec.limits[1] };
    return bone;
  });
}

/** Two-bone IK for each arm and leg, at mix 0 (clips turn them on). */
export function humanoidIk(): NonNullable<AnimDocumentInput["ik"]> {
  return SIDES.flatMap((side) => [
    // Bend directions follow the flex limits: left elbow and right knee positive, etc.
    { name: `arm_${side}_ik`, bones: [`upper_arm_${side}`, `forearm_${side}`], target: `hand_${side}_target`, bendPositive: side === "l", mix: 0 },
    { name: `leg_${side}_ik`, bones: [`thigh_${side}`, `shin_${side}`], target: `foot_${side}_target`, bendPositive: side === "r", mix: 0 }
  ]);
}

/**
 * Humanoid review poses (preset data, plan 4.6 step 5): joint poses at and near the humanoid limits,
 * both sides. The validator derives its poses from the rig (rigPoses.ts); these remain the
 * humanoid preset's hand-picked review set.
 */
export const HUMANOID_REVIEW_POSES: readonly ReviewPose[] = [
  { name: "rest", rotate: {} },
  { name: "arms up 105", rotate: { upper_arm_l: 105, upper_arm_r: -105 } },
  { name: "arms out 60", rotate: { upper_arm_l: 60, upper_arm_r: -60 } },
  { name: "arms in 15", rotate: { upper_arm_l: -15, upper_arm_r: 15 } },
  { name: "elbows 70", rotate: { forearm_l: 70, forearm_r: -70 } },
  { name: "up 90 elbows 70", rotate: { upper_arm_l: 90, upper_arm_r: -90, forearm_l: 70, forearm_r: -70, hand_l: 30, hand_r: -30 } },
  { name: "hips out 30", rotate: { thigh_l: 30, thigh_r: -30 } },
  { name: "hips in 10 knees 20", rotate: { thigh_l: -10, thigh_r: 10, shin_l: 20, shin_r: -20, foot_l: -20, foot_r: 20 } },
  // Lean 15 = spine 8 + chest 7; the head adds 15 on top of the neck's 5.
  { name: "lean 15 head 15", rotate: { spine: 8, chest: 7, neck: 5, head: 15 } },
  { name: "swing", rotate: { chest: -10, upper_arm_r: -100, forearm_r: -60, upper_arm_l: -15, thigh_l: 20, thigh_r: 5, shin_l: -15 } },
  { name: "shrug", rotate: { shoulder_l: 12, shoulder_r: -12, upper_arm_l: 20, upper_arm_r: -20 } },
  { name: "stride", rotate: { thigh_l: 25, thigh_r: -8, shin_l: -20, shin_r: 15, upper_arm_l: 35, upper_arm_r: -10, pelvis: -6 } }
];

/**
 * The humanoid body preset (BodyPreset): its budgets (plan 4.7: body <= 260 vertices,
 * each swag item <= 40, 6 items worn, <= 500 dressed; Phase 4 chain budgets: a front-only chibi
 * shows at most 50 degrees root -> head and 190 chest -> hand) and its review poses. `animator rig`
 * writes the budgets into the document it builds.
 */
export const HUMANOID_BODY: BodyPreset = {
  name: "humanoid",
  budgets: {
    bodyVertices: 260,
    itemVertices: 40,
    dressedVertices: 500,
    maxItems: 6,
    chains: [
      { from: "root", to: "head", budget: 50 },
      { from: "chest", to: "hand_l", budget: 190 },
      { from: "chest", to: "hand_r", budget: 190 }
    ]
  },
  reviewPoses: HUMANOID_REVIEW_POSES,
  // Template canvas close-ups: the band from the neck to below the knees at 1x; the left shoulder,
  // the neck and the crotch at 3x.
  reviewCrops: [
    { name: "joints-closeups", frame: ({ width }) => ({ x: Math.round(width * 0.22), y: 620, width: Math.round(width * 0.56), height: 520 }), scale: 1, columns: 4 },
    { name: "joints-3x-shoulder", frame: ({ width }) => ({ x: Math.round(width * 0.3), y: 600, width: 230, height: 250 }), scale: 3, columns: 4 },
    { name: "joints-3x-neck", frame: ({ width }) => ({ x: Math.round(width * 0.4), y: 580, width: 220, height: 160 }), scale: 3, columns: 4 },
    { name: "joints-3x-hips", frame: ({ width }) => ({ x: Math.round(width * 0.4), y: 940, width: 220, height: 160 }), scale: 3, columns: 4 }
  ]
};
