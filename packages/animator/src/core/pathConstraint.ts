/*
 * Atlas Animator: original implementation.
 *
 * Path constraint: places the constrained bones along the cubic bezier path the target slot shows,
 * each bone's origin on the curve and (by rotate mode) its X axis along the tangent or toward the
 * next bone. A path constraint written for this engine.
 *
 * Path layout: control point k has three vertices, handle in, point, handle out. An open path of
 * n curves has n + 1 control points, curve i runs from point i through its handle out and the next
 * handle in to point i + 1; a closed path of n curves has n control points and curve n - 1 returns
 * to point 0.
 *
 * Positions: `position` is a distance along the path (fixed) or a share of its length (percent);
 * the bones are placed at position, position + space[1], ... where the spaces come from the spacing
 * mode (length: bone length + spacing, fixed: spacing, percent: spacing x path length,
 * proportional: bone lengths scaled so the whole chain spans `spacing` x path length). On an open
 * path positions past either end continue along the end tangent. With constant speed the distance
 * is true arc length; without it, the distance picks the curve by its share and runs along the
 * curve by parameter (cheaper, uneven speed).
 *
 * Rotate modes: tangent (each bone along the path tangent at its origin), chain (each bone toward
 * the next bone's origin, the last keeps its length to the tip), chainScale (chain, and each bone
 * stretches to reach the next origin). Mixes: mixRotate blends the rotation (and scale), mixX /
 * mixY blend the origin.
 *
 * The update allocates nothing once its scratch arrays have grown to the chain length.
 */
import type { Attachment, PathAttachment } from "./attachments.js";
import type { Bone } from "./bone.js";
import type { PathConstraintData } from "./format.js";
import { DEG_TO_RAD, EPSILON, wrapRadians } from "./math.js";
import type { Slot } from "./slot.js";

export interface PathPose {
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
}

export function createPathPose(data: PathConstraintData): PathPose {
  return resetPathPose({ position: 0, spacing: 0, mixRotate: 0, mixX: 0, mixY: 0 }, data);
}

export function resetPathPose(pose: PathPose, data: PathConstraintData): PathPose {
  pose.position = data.position;
  pose.spacing = data.spacing;
  pose.mixRotate = data.mixRotate;
  pose.mixX = data.mixX;
  pose.mixY = data.mixY;
  return pose;
}

/** What the constraint needs from its skeleton. */
export interface PathHost {
  getAttachment(slot: Slot, placeholder: string): Attachment | undefined;
  findBone(name: string): Bone | undefined;
}

const SAMPLES = 32;

/** The path attachment a slot would show now (the effective placeholder resolved through the active skins), or null. */
export function pathOfSlot(host: PathHost, slot: Slot): PathAttachment | null {
  const name = slot.effectivePlaceholder;
  if (name === null || slot.hidden || !slot.bone.active) return null;
  const attachment = host.getAttachment(slot, name);
  return attachment && attachment.type === "path" ? attachment : null;
}

/**
 * World positions of the path's vertices (x, y per vertex, 3 per control point) into `out`
 * (length >= 2 * vertexCount). Weighted paths blend their bones' world matrices.
 */
export function computePathWorld(host: PathHost, path: PathAttachment, slotBone: Bone, out: Float64Array, cache?: Map<PathAttachment, (Bone | null)[]>): void {
  const v = path.vertices;
  if (!path.bones) {
    const { a, b, c, d, x: tx, y: ty } = slotBone.world;
    for (let i = 0; i < path.vertexCount * 2; i += 2) {
      const x = v[i] as number;
      const y = v[i + 1] as number;
      out[i] = a * x + b * y + tx;
      out[i + 1] = c * x + d * y + ty;
    }
    return;
  }
  // The attachment is shared by every skeleton of the document, so the resolved bones live with the caller.
  let table = cache?.get(path);
  if (!table) {
    table = path.bones.map((name) => host.findBone(name) ?? null);
    cache?.set(path, table);
  }
  let cursor = 0;
  for (let vertex = 0; vertex < path.vertexCount; vertex++) {
    const count = v[cursor++] as number;
    let wx = 0;
    let wy = 0;
    for (let k = 0; k < count; k++, cursor += 4) {
      const bone = table[v[cursor] as number];
      if (!bone) continue;
      const x = v[cursor + 1] as number;
      const y = v[cursor + 2] as number;
      const weight = v[cursor + 3] as number;
      const m = bone.world;
      wx += (m.a * x + m.b * y + m.x) * weight;
      wy += (m.c * x + m.d * y + m.y) * weight;
    }
    out[vertex * 2] = wx;
    out[vertex * 2 + 1] = wy;
  }
}

/** Number of curves of a path. */
export function pathCurveCount(path: Pick<PathAttachment, "closed" | "vertexCount">): number {
  const points = path.vertexCount / 3;
  return path.closed ? points : points - 1;
}

/**
 * Evaluates curve `curve` of the world vertices `w` at parameter t: writes x, y and the tangent
 * angle (radians) to out[o .. o + 2].
 */
export function evalPathCurve(w: ArrayLike<number>, vertexCount: number, curve: number, t: number, out: Float64Array, o: number): void {
  const points = vertexCount / 3;
  const i0 = curve % points;
  const i1 = (curve + 1) % points;
  const x0 = w[i0 * 6 + 2] as number;
  const y0 = w[i0 * 6 + 3] as number;
  const x1 = w[i0 * 6 + 4] as number;
  const y1 = w[i0 * 6 + 5] as number;
  const x2 = w[i1 * 6] as number;
  const y2 = w[i1 * 6 + 1] as number;
  const x3 = w[i1 * 6 + 2] as number;
  const y3 = w[i1 * 6 + 3] as number;
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  out[o] = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3;
  out[o + 1] = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3;
  let dx = 3 * u * u * (x1 - x0) + 6 * u * t * (x2 - x1) + 3 * t * t * (x3 - x2);
  let dy = 3 * u * u * (y1 - y0) + 6 * u * t * (y2 - y1) + 3 * t * t * (y3 - y2);
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
    // Coincident handles: fall back to the chord.
    dx = x3 - x0;
    dy = y3 - y0;
  }
  out[o + 2] = Math.atan2(dy, dx);
}

/** Arc length of each curve of a path from its world (or local) vertices; allocates (setup tools, export, editor overlays). */
export function pathCurveLengths(w: ArrayLike<number>, closed: boolean, vertexCount: number): number[] {
  const curves = closed ? vertexCount / 3 : vertexCount / 3 - 1;
  const tmp = new Float64Array(3);
  const out: number[] = [];
  for (let c = 0; c < curves; c++) {
    evalPathCurve(w, vertexCount, c, 0, tmp, 0);
    let px = tmp[0] as number;
    let py = tmp[1] as number;
    let acc = 0;
    for (let s = 1; s <= SAMPLES; s++) {
      evalPathCurve(w, vertexCount, c, s / SAMPLES, tmp, 0);
      acc += Math.hypot((tmp[0] as number) - px, (tmp[1] as number) - py);
      px = tmp[0] as number;
      py = tmp[1] as number;
    }
    out.push(acc);
  }
  return out;
}

export class PathConstraint {
  readonly data: PathConstraintData;
  readonly pose: PathPose;
  readonly bones: readonly Bone[];
  readonly slot: Slot;
  private readonly host: PathHost;

  private world = new Float64Array(0);
  private readonly spaces: Float64Array;
  private readonly lengths: Float64Array;
  private positions: Float64Array;
  /** Cumulative arc length per curve sample: SAMPLES + 1 entries per curve. */
  private table = new Float64Array(0);
  /** Cumulative length at the end of each curve. */
  private curveEnds = new Float64Array(0);
  private readonly tmp = new Float64Array(3);
  private readonly boneTables = new Map<PathAttachment, (Bone | null)[]>();

  constructor(data: PathConstraintData, pose: PathPose, bones: readonly Bone[], slot: Slot, host: PathHost) {
    this.data = data;
    this.pose = pose;
    this.bones = bones;
    this.slot = slot;
    this.host = host;
    this.spaces = new Float64Array(bones.length + 1);
    this.lengths = new Float64Array(bones.length);
    this.positions = new Float64Array(3 * (bones.length + 1) + 3);
  }

  /** Target slot bone and the constrained bones must be up to date. */
  update(): void {
    const pose = this.pose;
    const mixRotate = pose.mixRotate;
    const mixX = pose.mixX;
    const mixY = pose.mixY;
    if (mixRotate === 0 && mixX === 0 && mixY === 0) return;
    const path = pathOfSlot(this.host, this.slot);
    if (!path) return;
    const data = this.data;
    const bones = this.bones;
    const boneCount = bones.length;
    const tangents = data.rotateMode === "tangent";
    const scale = data.rotateMode === "chainScale";
    const spacesCount = tangents ? boneCount : boneCount + 1;
    const spaces = this.spaces;
    const lengths = this.lengths;
    spaces[0] = 0;
    const spacing = pose.spacing;

    switch (data.spacingMode) {
      case "percent":
        if (scale) {
          for (let i = 0; i < spacesCount - 1; i++) lengths[i] = this.boneLength(bones[i] as Bone);
        }
        for (let i = 1; i < spacesCount; i++) spaces[i] = spacing;
        break;
      case "proportional": {
        let sum = 0;
        for (let i = 0; i < spacesCount - 1; ) {
          const bone = bones[i] as Bone;
          if (bone.data.length < EPSILON) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const dist = this.boneLength(bone);
            if (scale) lengths[i] = dist;
            spaces[++i] = dist;
            sum += dist;
          }
        }
        if (sum > 0) {
          const k = (spacesCount / sum) * spacing;
          for (let i = 1; i < spacesCount; i++) spaces[i] = (spaces[i] as number) * k;
        }
        break;
      }
      default: {
        const lengthSpacing = data.spacingMode === "length";
        for (let i = 0; i < spacesCount - 1; ) {
          const bone = bones[i] as Bone;
          const setupLength = bone.data.length;
          if (setupLength < EPSILON) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const dist = this.boneLength(bone);
            if (scale) lengths[i] = dist;
            spaces[++i] = ((lengthSpacing ? setupLength + spacing : spacing) * dist) / setupLength;
          }
        }
      }
    }

    const positions = this.computePositions(path, spacesCount);
    if (!positions) return;
    let boneX = positions[0] as number;
    let boneY = positions[1] as number;
    let offsetRotation = data.offsetRotation * DEG_TO_RAD;
    let tip: boolean;
    if (offsetRotation === 0) tip = data.rotateMode === "chain";
    else {
      tip = false;
      const p = this.slot.bone.world;
      offsetRotation *= p.a * p.d - p.b * p.c > 0 ? 1 : -1;
    }
    for (let i = 0, p = 3; i < boneCount; i++, p += 3) {
      const bone = bones[i] as Bone;
      if (i > 0) bone.updateWorldTransform();
      const w = bone.world;
      w.x += (boneX - w.x) * mixX;
      w.y += (boneY - w.y) * mixY;
      const x = positions[p] as number;
      const y = positions[p + 1] as number;
      const dx = x - boneX;
      const dy = y - boneY;
      if (scale) {
        const length = lengths[i] as number;
        if (length !== 0) {
          const s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
          w.a *= s;
          w.c *= s;
        }
      }
      boneX = x;
      boneY = y;
      if (mixRotate > 0) {
        const a = w.a;
        const b = w.b;
        const c = w.c;
        const d = w.d;
        let r: number;
        if (tangents) r = positions[p - 1] as number;
        else if ((spaces[i + 1] as number) === 0) r = positions[p + 2] as number;
        else r = Math.atan2(dy, dx);
        r -= Math.atan2(c, a);
        if (tip) {
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          const length = bone.data.length;
          boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
          boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
        } else r += offsetRotation;
        r = wrapRadians(r) * mixRotate;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        w.a = cos * a - sin * c;
        w.b = cos * b - sin * d;
        w.c = sin * a + cos * c;
        w.d = sin * b + cos * d;
      }
      bone.enforceLimits();
      bone.updateAppliedTransform();
    }
  }

  private boneLength(bone: Bone): number {
    const setupLength = bone.data.length;
    const x = setupLength * bone.world.a;
    const y = setupLength * bone.world.c;
    return Math.sqrt(x * x + y * y);
  }

  /**
   * Samples of the chain along the path: x, y, tangent angle per space (plus one padding sample).
   * Null when the path has no length.
   */
  private computePositions(path: PathAttachment, spacesCount: number): Float64Array | null {
    const data = this.data;
    const spaces = this.spaces;
    const need = 3 * spacesCount + 3;
    if (this.positions.length < need) this.positions = new Float64Array(need);
    const out = this.positions;
    out.fill(0);
    const vertexCount = path.vertexCount;
    if (this.world.length < vertexCount * 2) this.world = new Float64Array(vertexCount * 2);
    const world = this.world;
    computePathWorld(this.host, path, this.slot.bone, world, this.boneTables);

    const closed = path.closed;
    const curveCount = pathCurveCount(path);
    if (this.curveEnds.length < curveCount) this.curveEnds = new Float64Array(curveCount);
    if (this.table.length < curveCount * (SAMPLES + 1)) this.table = new Float64Array(curveCount * (SAMPLES + 1));
    const table = this.table;
    const ends = this.curveEnds;
    const tmp = this.tmp;
    let total = 0;
    for (let c = 0; c < curveCount; c++) {
      const base = c * (SAMPLES + 1);
      table[base] = 0;
      evalPathCurve(world, vertexCount, c, 0, tmp, 0);
      let px = tmp[0] as number;
      let py = tmp[1] as number;
      let acc = 0;
      for (let s = 1; s <= SAMPLES; s++) {
        evalPathCurve(world, vertexCount, c, s / SAMPLES, tmp, 0);
        const x = tmp[0] as number;
        const y = tmp[1] as number;
        acc += Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
        table[base + s] = acc;
        px = x;
        py = y;
      }
      total += acc;
      ends[c] = total;
    }
    const pathLength = total;
    if (pathLength < EPSILON) return null;

    let position = this.pose.position;
    if (data.positionMode === "percent") position *= pathLength;
    let multiplier = 1;
    if (data.spacingMode === "percent") multiplier = pathLength;
    else if (data.spacingMode === "proportional") multiplier = pathLength / spacesCount;
    const constantSpeed = path.constantSpeed;

    for (let i = 0, o = 0; i < spacesCount; i++, o += 3) {
      position += (spaces[i] as number) * (i === 0 ? 0 : multiplier);
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
      } else if (p < 0) {
        // Before the start: continue along the first tangent.
        evalPathCurve(world, vertexCount, 0, 0, tmp, 0);
        const r = tmp[2] as number;
        out[o] = (tmp[0] as number) + p * Math.cos(r);
        out[o + 1] = (tmp[1] as number) + p * Math.sin(r);
        out[o + 2] = r;
        continue;
      } else if (p > pathLength) {
        evalPathCurve(world, vertexCount, curveCount - 1, 1, tmp, 0);
        const r = tmp[2] as number;
        const over = p - pathLength;
        out[o] = (tmp[0] as number) + over * Math.cos(r);
        out[o + 1] = (tmp[1] as number) + over * Math.sin(r);
        out[o + 2] = r;
        continue;
      }
      // The curve holding p.
      let curve = 0;
      while (curve < curveCount - 1 && p > (ends[curve] as number)) curve++;
      const start = curve === 0 ? 0 : (ends[curve - 1] as number);
      const length = (ends[curve] as number) - start;
      const local = length > EPSILON ? Math.min(1, Math.max(0, (p - start) / length)) : 0;
      let t = local;
      if (constantSpeed) {
        // Arc-length distance -> parameter through the sample table.
        const base = curve * (SAMPLES + 1);
        const target = local * (table[base + SAMPLES] as number);
        let s = 1;
        while (s < SAMPLES && (table[base + s] as number) < target) s++;
        const lo = table[base + s - 1] as number;
        const hi = table[base + s] as number;
        const f = hi - lo > EPSILON ? (target - lo) / (hi - lo) : 0;
        t = (s - 1 + f) / SAMPLES;
      }
      evalPathCurve(world, vertexCount, curve, t, out, o);
    }
    return out;
  }
}
