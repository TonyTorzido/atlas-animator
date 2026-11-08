/*
 * Atlas Animator: original implementation.
 *
 * Debug overlays for the editor, the CLI's contact sheets and tests: bones, mesh wireframes,
 * point attachments and a weights heat map for one bone. Drawn with Pixi Graphics in the same
 * skeleton space as an AnimatorCharacter (add the overlay as a sibling with the same transform,
 * or as a child of the character). Debug only: redraws everything on each draw() call.
 */
import { Container, Graphics } from "pixi.js";
import type { MeshAttachment } from "../core/attachments.js";
import { computePointWorld, type PointWorld } from "../core/skinning.js";
import { computePathWorld, evalPathCurve, pathCurveCount } from "../core/pathConstraint.js";
import type { Skeleton } from "../core/skeleton.js";

export interface DebugOverlayOptions {
  bones?: boolean;
  wireframe?: boolean;
  points?: boolean;
  /** Draw the polygons of bounding-box (hit box) attachments (default true). */
  boxes?: boolean;
  /** Draw the polygons of clipping attachments (default true). */
  clips?: boolean;
  /** Bone name whose weights to show as a heat map (blue 0 -> red 1), or null for none. */
  weightsFor?: string | null;
  /** Line width in skeleton pixels (default 1.5). */
  lineWidth?: number;
}

const BONE_COLOR = 0xffc83c;
const WIRE_COLOR = 0x3cc8ff;
const POINT_COLOR = 0xff3cc8;
const PATH_COLOR = 0xff7f00;
const BOX_COLOR = 0x60f000;
const CLIP_COLOR = 0xce3a3a;

export class AnimatorDebugOverlay extends Container {
  private readonly graphics = new Graphics();
  private scratch = new Float32Array(512);
  private readonly point: PointWorld = { x: 0, y: 0, rotation: 0 };

  constructor() {
    super({ label: "AnimatorDebugOverlay" });
    this.addChild(this.graphics);
  }

  /** Redraws the overlay for the skeleton's current (already updated) pose. */
  draw(skeleton: Skeleton, options: DebugOverlayOptions = {}): void {
    const g = this.graphics;
    const width = options.lineWidth ?? 1.5;
    g.clear();

    const weightsBone = options.weightsFor ? skeleton.findBone(options.weightsFor) : undefined;
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.attachment;
      if (!attachment) continue;
      if (attachment.type === "clipping" || attachment.type === "boundingbox") {
        if ((attachment.type === "boundingbox" ? options.boxes : options.clips) !== false) {
          const world = skeleton.slotPolygonWorld(slot);
          if (world && world.length >= 6) {
            const color = attachment.type === "boundingbox" ? BOX_COLOR : CLIP_COLOR;
            g.poly(Array.from(world)).fill({ color, alpha: 0.18 }).stroke({ width, color });
          }
        }
        continue;
      }
      if (attachment.type === "point") {
        if (options.points !== false) {
          const p = computePointWorld(attachment, slot.bone, this.point);
          const r = (p.rotation * Math.PI) / 180;
          g.circle(p.x, p.y, 3 * width).stroke({ width, color: POINT_COLOR });
          g.moveTo(p.x, p.y).lineTo(p.x + Math.cos(r) * 12 * width, p.y + Math.sin(r) * 12 * width).stroke({ width, color: POINT_COLOR });
        }
        continue;
      }
      if (attachment.type === "path") {
        if (options.points !== false) {
          const w = new Float64Array(attachment.vertexCount * 2);
          computePathWorld(skeleton, attachment, slot.bone, w);
          const tmp = new Float64Array(3);
          for (let c = 0; c < pathCurveCount(attachment); c++) {
            for (let s = 0; s <= 24; s++) {
              evalPathCurve(w, attachment.vertexCount, c, s / 24, tmp, 0);
              if (s === 0) g.moveTo(tmp[0] as number, tmp[1] as number);
              else g.lineTo(tmp[0] as number, tmp[1] as number);
            }
          }
          g.stroke({ width, color: PATH_COLOR });
        }
        continue;
      }
      const triangles = attachment.type === "region" ? attachment.triangles : attachment.geometry.triangles;
      const count = attachment.type === "region" ? 4 : attachment.geometry.vertexCount;
      if (this.scratch.length < count * 2) this.scratch = new Float32Array(count * 2);
      const v = this.scratch;
      skeleton.computeSlotWorldVertices(slot, v);

      if (weightsBone && attachment.type === "mesh") {
        const weights = vertexWeights(attachment, weightsBone.index, slot.bone.index);
        for (let t = 0; t < triangles.length; t += 3) {
          const a = triangles[t] as number;
          const b = triangles[t + 1] as number;
          const c = triangles[t + 2] as number;
          const w = ((weights[a] as number) + (weights[b] as number) + (weights[c] as number)) / 3;
          g.poly([v[a * 2] as number, v[a * 2 + 1] as number, v[b * 2] as number, v[b * 2 + 1] as number, v[c * 2] as number, v[c * 2 + 1] as number]).fill({
            color: heat(w),
            alpha: 0.55
          });
        }
      }
      if (options.wireframe !== false) {
        for (let t = 0; t < triangles.length; t += 3) {
          const a = triangles[t] as number;
          const b = triangles[t + 1] as number;
          const c = triangles[t + 2] as number;
          g.moveTo(v[a * 2] as number, v[a * 2 + 1] as number)
            .lineTo(v[b * 2] as number, v[b * 2 + 1] as number)
            .lineTo(v[c * 2] as number, v[c * 2 + 1] as number)
            .closePath();
        }
        g.stroke({ width: width * 0.66, color: WIRE_COLOR, alpha: 0.8 });
      }
    }

    if (options.bones !== false) {
      for (const bone of skeleton.bones) {
        if (!bone.active) continue;
        const w = bone.world;
        const length = bone.data.length;
        g.circle(w.x, w.y, 3 * width).fill({ color: BONE_COLOR });
        if (length > 0) g.moveTo(w.x, w.y).lineTo(w.x + w.a * length, w.y + w.c * length).stroke({ width, color: BONE_COLOR });
      }
    }
  }
}

/** Weight of `bone` per vertex (unweighted meshes: 1 when it is the slot bone). */
export function vertexWeights(mesh: MeshAttachment, bone: number, slotBone: number): Float32Array {
  const geometry = mesh.geometry;
  const out = new Float32Array(geometry.vertexCount);
  if (!geometry.weighted) {
    if (bone === slotBone) out.fill(1);
    return out;
  }
  let influence = 0;
  for (let v = 0; v < geometry.vertexCount; v++) {
    const end = influence + (geometry.counts[v] as number);
    for (; influence < end; influence++) {
      if (geometry.influenceBones[influence] === bone) out[v] = (out[v] as number) + (geometry.weights[influence] as number);
    }
  }
  return out;
}

/** Blue (0) through green (0.5) to red (1). */
function heat(weight: number): number {
  const w = Math.min(1, Math.max(0, weight));
  const r = Math.round(255 * Math.min(1, Math.max(0, 2 * w - 0.5)));
  const g = Math.round(255 * (1 - Math.abs(2 * w - 1)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.5 - 2 * w)));
  return (r << 16) | (g << 8) | b;
}
