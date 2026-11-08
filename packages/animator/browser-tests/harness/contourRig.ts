/*
 * Atlas Animator: original implementation.
 *
 * Phase harness rigs: a bending strip carrying a stroked circle (the 3x width-invariance
 * golden) and a three-bone body with ten contours (the 50-character bench). Built in code.
 */
import { bindPointToMesh } from "../../src/core/contours.js";
import { loadAnimDocument } from "../../src/core/formatLoader.js";
import type { AnimDocument } from "../../src/core/format.js";
import { Skeleton } from "../../src/core/skeleton.js";
import type { MeshAttachment } from "../../src/core/attachments.js";
import type { RgbaImage } from "../../src/pixi/imageOps.js";

/**
 * A strip mesh along +x: a grid of columns `step` px apart and rows `rowStep` px apart (hull first,
 * in order), weighted to a bone chain: rigid away from the joints, blending linearly over `blend`
 * px on each side of a joint (0: a 50/50 seam column).
 */
function stripMesh(bones: string[], segment: number, step: number, half: number, path: string, blend = 0, rowStep = 2 * half) {
  const length = segment * bones.length;
  const xs: number[] = [];
  for (let x = 0; x <= length + 1e-9; x += step) xs.push(x);
  const ys: number[] = [];
  for (let y = -half; y <= half + 1e-9; y += rowStep) ys.push(y);
  const nx = xs.length;
  const ny = ys.length;
  // Vertex order: the hull (top row, right column down, bottom row back, left column up), then the interior.
  const order: [number, number][] = [];
  for (let i = 0; i < nx; i++) order.push([i, 0]);
  for (let j = 1; j < ny; j++) order.push([nx - 1, j]);
  for (let i = nx - 2; i >= 0; i--) order.push([i, ny - 1]);
  for (let j = ny - 2; j >= 1; j--) order.push([0, j]);
  const hull = order.length;
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) order.push([i, j]);
  const index = new Map(order.map(([i, j], k) => [`${i},${j}`, k] as const));
  const at = (i: number, j: number) => index.get(`${i},${j}`) as number;
  const triangles: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) triangles.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  }
  const vertices = order.flatMap(([i, j]) => {
    const x = xs[i] as number;
    const y = ys[j] as number;
    const bone = Math.min(bones.length - 1, Math.floor(x / segment));
    const joint = Math.round(x / segment);
    if (joint > 0 && joint < bones.length) {
      const offset = x - joint * segment;
      const after = blend > 0 ? Math.min(1, Math.max(0, 0.5 + offset / (2 * blend))) : offset === 0 ? 0.5 : offset > 0 ? 1 : 0;
      if (after > 0 && after < 1) return [2, joint - 1, x - (joint - 1) * segment, y, 1 - after, joint, offset, y, after];
    }
    return [1, bone, x - bone * segment, y, 1];
  });
  return {
    type: "mesh",
    path,
    bones,
    uvs: order.flatMap(([i, j]) => [(xs[i] as number) / length, ((ys[j] as number) + half) / (2 * half)]),
    triangles,
    vertices,
    hull,
    width: length,
    height: 2 * half
  };
}

function solidImage(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

/** Binds canvas points (skeleton space) to a document's mesh at its setup pose. */
function bindPoints(doc: AnimDocument, slot: string, name: string, points: [number, number][]) {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(Object.keys(doc.skins));
  skeleton.updateWorldTransform("none");
  const owner = skeleton.getSlot(slot);
  const mesh = skeleton.getAttachment(owner, name) as MeshAttachment;
  const world = skeleton.meshWorldVertices(mesh, owner.bone);
  return points.map(([x, y]) => bindPointToMesh(world, mesh.geometry.triangles, x, y));
}

// --- The stroked circle on a bending strip --------------------------------------------------------

export const CIRCLE = { segment: 40, half: 14, radius: 9, width: 2, points: 72 } as const;

export function circleDocument(): AnimDocument {
  const raw = {
    format: "atlas-anim@1",
    name: "circle",
    canvas: { width: 320, height: 320, originX: 40, originY: 120 },
    bones: [{ name: "root" }, { name: "upper", parent: "root", length: CIRCLE.segment }, { name: "lower", parent: "upper", x: CIRCLE.segment, length: CIRCLE.segment }],
    // The strip is drawn transparent (slot alpha 0): only the stroke shows, for the width measurement.
    slots: [{ name: "strip", bone: "upper", attachment: "strip", color: "ffffff00" }, { name: "outline", bone: "root" }],
    skins: { body: { attachments: { strip: { strip: stripMesh(["upper", "lower"], CIRCLE.segment, 2, CIRCLE.half, "test/circle-strip", 14, 2) } } } }
  };
  const base = loadAnimDocument(raw);
  const ring: [number, number][] = Array.from({ length: CIRCLE.points }, (_, i) => {
    const t = (i / CIRCLE.points) * Math.PI * 2;
    return [CIRCLE.segment + CIRCLE.radius * Math.cos(t), CIRCLE.radius * Math.sin(t)];
  });
  const points = bindPoints(base, "strip", "strip", ring);
  return loadAnimDocument({
    ...raw,
    skins: { body: { ...raw.skins.body, contours: { outline: { ring: { mesh: { slot: "strip", attachment: "strip" }, points, closed: true, width: CIRCLE.width, color: "000000ff" } } } } }
  });
}

export function circleImages(): Map<string, RgbaImage> {
  return new Map([["test/circle-strip", solidImage(80, 28, [200, 120, 90])]]);
}

// --- The bench body: three bones, ten contours of sixteen points -------------------------------

export const BENCH = { segment: 40, half: 15, contours: 10, points: 16 } as const;

export function benchDocument(withContours: boolean): AnimDocument {
  const bones = ["b1", "b2", "b3"];
  const raw = {
    format: "atlas-anim@1",
    name: "bench",
    canvas: { width: 160, height: 60, originX: 20, originY: 30 },
    bones: [
      { name: "root" },
      { name: "b1", parent: "root", length: BENCH.segment },
      { name: "b2", parent: "b1", x: BENCH.segment, length: BENCH.segment },
      { name: "b3", parent: "b2", x: BENCH.segment, length: BENCH.segment }
    ],
    slots: [{ name: "body", bone: "b1", attachment: "body" }, { name: "outline", bone: "root" }],
    skins: { body: { attachments: { body: { body: stripMesh(bones, BENCH.segment, 10, BENCH.half, "test/bench-body") } } } }
  };
  if (!withContours) return loadAnimDocument(raw);
  const base = loadAnimDocument(raw);
  const length = BENCH.segment * bones.length;
  const contours: Record<string, unknown> = {};
  for (let k = 0; k < BENCH.contours; k++) {
    const y0 = -BENCH.half + 1.5 + (k * (2 * BENCH.half - 3)) / (BENCH.contours - 1);
    const line: [number, number][] = Array.from({ length: BENCH.points }, (_, i) => {
      const x = 3 + (i * (length - 6)) / (BENCH.points - 1);
      return [x, Math.max(-BENCH.half, Math.min(BENCH.half, y0 + 1.2 * Math.sin(x * 0.15 + k)))];
    });
    contours[`c${k}`] = { mesh: { slot: "body", attachment: "body" }, points: bindPoints(base, "body", "body", line), width: 1.5 + (k % 3) * 0.5, color: "1a1410ff" };
  }
  return loadAnimDocument({ ...raw, skins: { body: { ...raw.skins.body, contours: { outline: contours } } } });
}

export function benchImages(): Map<string, RgbaImage> {
  return new Map([["test/bench-body", solidImage(120, 30, [220, 170, 130])]]);
}
