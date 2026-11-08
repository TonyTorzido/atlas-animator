import { describe, expect, it } from "vitest";
import { autoMesh, enclosingSimplify, meshMinAngle, principalAxis, triangleAngles } from "./autoMesh.js";
import { createImage, type MutableImage } from "./image.js";
import { outlineImage, pointInPolygon, polygonArea, type Outline, type Point } from "./outline.js";

function sprite(width: number, height: number, inside: (x: number, y: number) => boolean): MutableImage {
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.data[(y * width + x) * 4 + 3] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  }
  return image;
}

/** Sum of triangle areas, to check the triangulation tiles the hull without overlaps. */
function triangleArea(points: Float64Array, triangles: Uint32Array): number {
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = (triangles[t] as number) * 2;
    const b = (triangles[t + 1] as number) * 2;
    const c = (triangles[t + 2] as number) * 2;
    const cross =
      ((points[b] as number) - (points[a] as number)) * ((points[c + 1] as number) - (points[a + 1] as number)) -
      ((points[b + 1] as number) - (points[a + 1] as number)) * ((points[c] as number) - (points[a] as number));
    expect(cross, `triangle ${t / 3} winding`).toBeGreaterThan(0);
    sum += cross / 2;
  }
  return sum;
}

function hullPoints(mesh: { points: Float64Array; hull: number }): Point[] {
  return Array.from({ length: mesh.hull }, (_, i) => ({ x: mesh.points[i * 2] as number, y: mesh.points[i * 2 + 1] as number }));
}

describe("auto-mesh", () => {
  it("meshes a 200x60 limb with 20-60 vertices and no sliver triangles", () => {
    // A rounded limb: a capsule 200 long, 60 wide.
    const limb = sprite(240, 100, (x, y) => {
      const cx = Math.max(50, Math.min(190, x));
      return Math.hypot(x - cx, y - 50) < 30;
    });
    const mesh = autoMesh(outlineImage(limb), { targetVertices: 40 });
    const vertices = mesh.points.length / 2;
    expect(vertices).toBeGreaterThanOrEqual(20);
    expect(vertices).toBeLessThanOrEqual(60);
    expect(mesh.minAngle).toBeGreaterThan(15);
    expect(meshMinAngle(mesh.points, mesh.triangles)).toBe(mesh.minAngle);
    // The triangles tile the hull exactly.
    expect(triangleArea(mesh.points, mesh.triangles)).toBeCloseTo(polygonArea(hullPoints(mesh)), 3);
    // The lattice follows the limb: rings across it, so interior points span the length.
    expect(Math.abs(principalAxis(mesh.hullPolygon))).toBeLessThan(2);
  });

  it("meshes a rectangle 200x60 within budget and with good angles", () => {
    const rectangle = sprite(240, 100, (x, y) => x > 20 && x < 220 && y > 20 && y < 80);
    const mesh = autoMesh(outlineImage(rectangle), { targetVertices: 40 });
    expect(mesh.points.length / 2).toBeGreaterThanOrEqual(20);
    expect(mesh.points.length / 2).toBeLessThanOrEqual(60);
    expect(mesh.minAngle).toBeGreaterThan(15);
  });

  it("hits different vertex targets and keeps every triangle above 15 degrees", () => {
    const blob = sprite(300, 300, (x, y) => Math.hypot((x - 150) / 120, (y - 150) / 90) < 1 || Math.hypot(x - 230, y - 230) < 40);
    for (const target of [24, 40, 75]) {
      const mesh = autoMesh(outlineImage(blob), { targetVertices: target });
      expect(Math.abs(mesh.points.length / 2 - target), `target ${target}`).toBeLessThanOrEqual(Math.max(4, target * 0.15));
      expect(mesh.minAngle, `target ${target}`).toBeGreaterThan(15);
    }
  });

  it("the hull encloses every opaque pixel", () => {
    const blob = sprite(300, 300, (x, y) => Math.hypot((x - 150) / 120, (y - 150) / 90) < 1);
    const mesh = autoMesh(outlineImage(blob), { targetVertices: 24 });
    const hull = hullPoints(mesh);
    for (let y = 0; y < 300; y += 3) {
      for (let x = 0; x < 300; x += 3) {
        if (Math.hypot((x + 0.5 - 150) / 120, (y + 0.5 - 150) / 90) < 1) expect(pointInPolygon(x + 0.5, y + 0.5, hull)).toBe(true);
      }
    }
  });

  it("meshes around holes", () => {
    const ring = sprite(200, 200, (x, y) => {
      const r = Math.hypot(x - 100, y - 100);
      return r < 90 && r > 35;
    });
    const outline = outlineImage(ring);
    expect(outline.holes).toHaveLength(1);
    const mesh = autoMesh(outline, { targetVertices: 60 });
    expect(mesh.minAngle).toBeGreaterThan(15);
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const cx = [0, 1, 2].reduce((s, k) => s + (mesh.points[(mesh.triangles[t + k] as number) * 2] as number), 0) / 3;
      const cy = [0, 1, 2].reduce((s, k) => s + (mesh.points[(mesh.triangles[t + k] as number) * 2 + 1] as number), 0) / 3;
      expect(Math.hypot(cx - 100, cy - 100)).toBeGreaterThan(30);
    }
  });

  it("enclosingSimplify keeps every original point inside", () => {
    const circle: Point[] = Array.from({ length: 200 }, (_, i) => ({
      x: 100 + 60 * Math.cos((i / 200) * 2 * Math.PI),
      y: 100 + 60 * Math.sin((i / 200) * 2 * Math.PI)
    }));
    const outline: Outline = { outer: circle, holes: [] };
    const hull = enclosingSimplify(outline.outer, 4);
    expect(hull.length).toBeLessThan(30);
    for (const p of circle) {
      // On or inside (a tiny inward nudge avoids the on-edge ambiguity of the even-odd test).
      expect(pointInPolygon(100 + (p.x - 100) * 0.999, 100 + (p.y - 100) * 0.999, hull)).toBe(true);
    }
  });

  it("triangleAngles sum to 180", () => {
    const angles = triangleAngles(0, 0, 4, 0, 0, 3);
    expect(angles.reduce((a, b) => a + b, 0)).toBeCloseTo(180, 9);
    expect(angles[0]).toBeCloseTo(90, 9);
  });
});
