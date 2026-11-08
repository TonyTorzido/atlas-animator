import { describe, expect, it } from "vitest";
import { parseAnimDocument, loadAnimDocument } from "./formatLoader.js";
import { outlineProblem, triangulateOutline } from "./opaqueOutline.js";
import { pointCovered } from "./coverage.js";
import { Skeleton } from "./skeleton.js";
import type { CompiledContour } from "./contours.js";

/*
 * Coverage buffers and outlines: setup-space (skin-invariant cache
 * fill) and posed contour points use separate buffers, so the first evaluation equals the repeat;
 * opaque outlines are validated and triangulated correctly (concave ones by ear clipping).
 */

const COLUMNS = [0, 20, 40, 60, 80, 100, 120];
const n = COLUMNS.length;
const bottomIndex = (column: number) => 2 * n - 1 - column;

/**
 * A two-bone strip with a contour along its top row; draw order: strip, a rigid plate near x 10, a
 * band fully embedded on the strip near x 60 (skin-invariant coverer), a rigid plate near x 110.
 */
function raw(opaque?: number[]) {
  const top = COLUMNS.map((x) => ({ x, y: -10 }));
  const bottom = [...COLUMNS].reverse().map((x) => ({ x, y: 10 }));
  const points = [...top, ...bottom];
  const triangles: number[] = [];
  for (let j = 0; j < n - 1; j++) triangles.push(j, j + 1, bottomIndex(j + 1), j, bottomIndex(j + 1), bottomIndex(j));
  const vertices = points.flatMap(({ x, y }) => (x < 60 ? [1, 0, x, y, 1] : x > 60 ? [1, 1, x - 60, y, 1] : [2, 0, x, y, 0.5, 1, 0, y, 0.5]));
  const plate = (x: number) => ({ type: "region", path: "t/plate", x, y: -10, width: 12, height: 12, ...(opaque ? { opaque } : {}) });
  return {
    format: "atlas-anim@1",
    name: "cover",
    canvas: { width: 200, height: 100, originX: 20, originY: 50 },
    bones: [{ name: "root" }, { name: "upper", parent: "root", length: 60 }, { name: "lower", parent: "upper", x: 60, length: 60 }],
    slots: [
      { name: "skin", bone: "upper", attachment: "strip" },
      { name: "plateA", bone: "root", attachment: "plate" },
      { name: "band", bone: "root", attachment: "band" },
      { name: "plateC", bone: "root", attachment: "plate" }
    ],
    skins: {
      body: {
        attachments: {
          skin: { strip: { type: "mesh", path: "t/strip", bones: ["upper", "lower"], uvs: points.flatMap(({ x, y }) => [x / 120, (y + 10) / 20]), triangles, vertices, hull: points.length, width: 120, height: 20 } },
          plateA: { plate: plate(10) },
          plateC: { plate: plate(110) },
          band: {
            band: {
              type: "mesh",
              path: "t/band",
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              vertices: [50, -12, 70, -12, 70, 5, 50, 5],
              hull: 4,
              width: 20,
              height: 17,
              embed: { slot: "skin", attachment: "strip", vertices: [0, 1, 2, 3], points: [[2, 3, 10, 0.5, 0.6], [3, 4, 9, 0.5, 0.6], [3, 4, 9, 0.5, -0.25], [2, 3, 10, 0.5, -0.25]] }
            }
          }
        },
        contours: { skin: { top: { mesh: { slot: "skin", attachment: "strip" }, points: [0, 1, 2, 3, 4, 5, 6], width: 2, color: "000000ff" } } }
      }
    }
  };
}

function posed(doc = raw()) {
  const sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins(["body"]);
  sk.setToSetupPose();
  sk.getBone("lower").pose.rotation = -35; // the far plate no longer sits on the posed top row
  sk.updateWorldTransform("none");
  return sk;
}

describe("coverage: separate setup and posed buffers (item 3)", () => {
  it("the first evaluation equals the repeat and the precomputed-points call", () => {
    const sk = posed();
    const contour = sk.activeContours[0] as CompiledContour;
    const first = sk.contourRuns(contour)?.slice() ?? null;
    const repeat = sk.contourRuns(contour)?.slice() ?? null;
    const pts = new Float32Array(contour.pointCount * 2);
    sk.computeContourPoints(contour, pts);
    const fresh = posed();
    const given = fresh.contourRuns(fresh.activeContours[0] as CompiledContour, pts)?.slice() ?? null;
    expect(first).toEqual(repeat);
    expect(given).toEqual(repeat);
  });

  it("an outfit change re-takes skin-space intervals (no stale setup skeleton)", () => {
    const doc = raw();
    (doc.skins as Record<string, unknown>).bare = {};
    const sk = posed(doc);
    const contour = () => sk.activeContours[0] as CompiledContour;
    const dressed = sk.contourRuns(contour())?.slice() ?? null;
    sk.setActiveSkins(["body", "bare"]);
    sk.updateWorldTransform("none");
    const again = sk.contourRuns(contour())?.slice() ?? null;
    expect(again).toEqual(dressed);
  });
});

describe("opaque outlines: validation and triangulation (item 3)", () => {
  const issues = (opaque: number[]) => {
    const r = parseAnimDocument(raw(opaque));
    return r.ok ? "" : r.issues.map((i) => i.message).join("\n");
  };

  it("rejects incomplete, too-short, degenerate and self-intersecting outlines with clear errors", () => {
    expect(outlineProblem([0, 0, 1, 0, 1])).toMatch(/complete u, v pairs/);
    expect(outlineProblem([0, 0, 1, 0])).toMatch(/at least 3 vertices/);
    expect(outlineProblem([0, 0, 0.5, 0.5, 1, 1])).toMatch(/degenerate/);
    expect(outlineProblem([0, 0, 1, 1, 1, 0, 0, 1])).toMatch(/self-intersecting/);
    expect(issues([0, 0, 1, 0, 1])).toMatch(/opaque outline: .*complete u, v pairs/);
    expect(issues([0, 0, 1, 1, 1, 0, 0, 1])).toMatch(/opaque outline: .*self-intersecting/);
    expect(issues([0, 0, 1, 0, 1, 1, 0, 1])).toBe("");
  });

  it("a concave outline is ear-clipped: the notch is not covered (a fan from vertex 0 would cover it)", () => {
    // L shape starting next to the reflex corner (0.5, 0.5).
    const L = [1, 0.5, 0.5, 0.5, 0.5, 1, 0, 1, 0, 0, 1, 0];
    expect(outlineProblem(L)).toBeNull();
    const tris = triangulateOutline(L)!;
    expect(tris.length).toBe(12);
    expect(pointCovered(0.75, 0.75, L, tris, 0)).toBe(false); // the notch
    expect(pointCovered(0.25, 0.75, L, tris, 0)).toBe(true);
    expect(pointCovered(0.75, 0.25, L, tris, 0)).toBe(true);
  });
});
