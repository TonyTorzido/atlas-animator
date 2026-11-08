/*
 * Atlas Animator: original implementation.
 *
 * Chain joint handover. Two
 * contours of one mesh chained end to start are one ink, but each draws after its own owner slot.
 * When the later-drawn contour's slot also draws a group of the mesh (the forearm), that group's
 * skin is painted over the earlier contour's stroke (the upper arm's) wherever the posed group comes
 * within half a stroke width of it: near the joint, at a strong bend, the earlier stroke loses part
 * of its width (a step, a doubled cap and AA specks along the crease). The fix keeps the ink and its
 * shape and moves the chain joint of a limb joint (the later slot's bone a child of the earlier's): the earlier contour's points nearest the joint that the later
 * group reaches (within half a width + HANDOVER_CLEAR at any sampled pose of the bones moving them,
 * each limited bone at min / mid / max) are handed to the later contour, which draws them above that
 * skin. The centreline is unchanged (same mesh vertices), so the rest render is unchanged.
 */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";

/** Clearance (canvas px) past half a stroke width the later group must keep from a kept point. */
export const HANDOVER_CLEAR = 1;
/** Most limited bones sampled per joint (3 values each). */
const MAX_SAMPLED_BONES = 5;

export interface HandoverReport {
  /** `earlier slot/name -> later slot/name`: the mesh vertices handed over. */
  moved: Record<string, number[]>;
  poses: number;
}

interface ContourJson {
  mesh?: { skin?: string; slot: string; attachment: string };
  points?: number[];
  closed?: boolean;
  width: number;
}

export function handOverChainJoints(doc: any, skinName: string): HandoverReport {
  const contours = (doc.skins?.[skinName]?.contours ?? {}) as Record<string, Record<string, ContourJson>>;
  const list = Object.entries(contours).flatMap(([slot, byName]) => Object.entries(byName).map(([name, c]) => ({ slot, name, c })));
  const slotIndex = (name: string) => (doc.slots as { name: string }[]).findIndex((s) => s.name === name);
  const report: HandoverReport = { moved: {}, poses: 0 };
  const sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins([skinName]);
  for (const x of list) {
    for (const y of list) {
      const px = x.c.points;
      const py = y.c.points;
      if (x === y || !px || !py || !x.c.mesh || !y.c.mesh || x.c.closed || y.c.closed) continue;
      if (x.c.mesh.slot !== y.c.mesh.slot || x.c.mesh.attachment !== y.c.mesh.attachment || x.c.width !== y.c.width) continue;
      if (px[px.length - 1] !== py[0] || x.slot === y.slot) continue;
      const xLater = slotIndex(x.slot) > slotIndex(y.slot);
      const later = xLater ? x : y;
      const earlier = xLater ? y : x;
      // A limb joint only: the later slot's bone hangs from the earlier slot's bone (the bend between
      // them folds the later group over the earlier stroke). A torso edge meeting an arm is an
      // occlusion (the arm in front), not a fold, and keeps its joint.
      const boneOf = (slot: string) => (doc.slots as { name: string; bone: string }[]).find((s) => s.name === slot)?.bone;
      const laterBone = (doc.bones as { name: string; parent?: string }[]).find((b) => b.name === boneOf(later.slot));
      if (!laterBone || laterBone.parent !== boneOf(earlier.slot)) continue;
      const mesh = doc.skins[skinName].attachments[x.c.mesh.slot]?.[x.c.mesh.attachment];
      const ranges = mesh?.groups?.[later.slot] as [number, number][] | undefined;
      if (!mesh || !ranges || !mesh.bones) continue;
      // The earlier contour's points from the joint outward (the joint itself excluded).
      const away = xLater ? py.slice(1) : px.slice(0, -1).reverse();
      if (away.length < 2) continue;
      const tris: number[] = [];
      for (const [a, b] of ranges) for (let t = a; t < b; t++) tris.push(mesh.triangles[t * 3], mesh.triangles[t * 3 + 1], mesh.triangles[t * 3 + 2]);
      const poses = samplePoses(doc, mesh, [...px, ...py]);
      report.poses = Math.max(report.poses, poses.length);
      const half = x.c.width / 2 + HANDOVER_CLEAR;
      const near = new Array<number>(away.length).fill(Infinity);
      const slot = sk.getSlot(x.c.mesh.slot);
      const att = sk.getAttachment(slot, x.c.mesh.attachment) as Parameters<Skeleton["meshWorldVertices"]>[0];
      for (const pose of poses) {
        sk.setToSetupPose();
        for (const [bone, delta] of pose) {
          const b = sk.getBone(bone);
          b.pose.rotation = b.data.rotation + delta;
        }
        sk.updateWorldTransform("none");
        const w = sk.meshWorldVertices(att, slot.bone);
        away.forEach((v, k) => (near[k] = Math.min(near[k] as number, distanceToTriangles(w[v * 2] as number, w[v * 2 + 1] as number, w, tris))));
      }
      // Hand over the reached points and the first clear one (the new joint: the later stroke's cap
      // covers the earlier stroke's start there).
      let reached = 0;
      while (reached < away.length && (near[reached] as number) < half) reached++;
      if (!reached) continue;
      const k = Math.min(reached + 1, away.length - 1);
      const moved = away.slice(0, k);
      // the later contour keeps the earlier one's trims (what covers the earlier limb covers these)
      (later.c as ContourJson & { coverFrom?: string }).coverFrom = earlier.slot;
      if (xLater) {
        x.c.points = [...px, ...moved];
        y.c.points = py.slice(k);
      } else {
        x.c.points = px.slice(0, px.length - k);
        y.c.points = [...moved.slice().reverse(), ...py];
      }
      report.moved[`${xLater ? y.slot : x.slot}/${xLater ? y.name : x.name} -> ${later.slot}/${later.name}`] = moved;
    }
  }
  return report;
}

/** Rest, and every min / mid / max combination of the limited bones that weight the given vertices. */
function samplePoses(doc: any, mesh: any, vertices: number[]): [string, number][][] {
  const influences = new Set<string>();
  const count = mesh.uvs.length / 2;
  const want = new Set(vertices);
  let c = 0;
  for (let v = 0; v < count; v++) {
    const n = mesh.vertices[c++] as number;
    for (let j = 0; j < n; j++) {
      if (want.has(v) && (mesh.vertices[c + 3] as number) > 0) influences.add(mesh.bones[mesh.vertices[c] as number] as string);
      c += 4;
    }
  }
  const limited = (doc.bones as { name: string; limits?: { min: number; max: number } }[]).filter((b) => b.limits && influences.has(b.name)).slice(0, MAX_SAMPLED_BONES);
  let poses: [string, number][][] = [[]];
  for (const b of limited) {
    const { min, max } = b.limits as { min: number; max: number };
    poses = poses.flatMap((p) => [min, (min + max) / 2, max].map((v) => [...p, [b.name, v] as [string, number]]));
  }
  return poses;
}

/** Distance from (px, py) to the union of triangles (0 inside one). */
function distanceToTriangles(px: number, py: number, w: ArrayLike<number>, tris: number[]): number {
  let best = Infinity;
  for (let t = 0; t < tris.length; t += 3) {
    const ax = w[(tris[t] as number) * 2] as number;
    const ay = w[(tris[t] as number) * 2 + 1] as number;
    const bx = w[(tris[t + 1] as number) * 2] as number;
    const by = w[(tris[t + 1] as number) * 2 + 1] as number;
    const cx = w[(tris[t + 2] as number) * 2] as number;
    const cy = w[(tris[t + 2] as number) * 2 + 1] as number;
    const c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    const c3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    if ((c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0)) return 0;
    best = Math.min(best, segmentDistance(px, py, ax, ay, bx, by), segmentDistance(px, py, bx, by, cx, cy), segmentDistance(px, py, cx, cy, ax, ay));
  }
  return best;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * u, py - ay - dy * u);
}
