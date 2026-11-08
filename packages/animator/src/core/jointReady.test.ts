import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "./attachments.js";
import { bindPointToMesh, buildStroke, strokeIndexCount, strokeVertexCount, STROKE_MAX_ARC_STEPS, strokeJoinError, strokeJoinSteps } from "./contours.js";
import { parseAnimDocument, loadAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";

/*
 * Phase: mesh draw groups, contours, two-driver corrective grids and coverage regions (format,
 * references and core runtime). The Pixi side and the 3x width golden live in src/pixi and
 * browser-tests.
 */

const COLUMNS = [0, 20, 40, 60, 80, 100, 120];
const HALF = 10;
const JOINT = 60;

/** A 120 x 20 strip on two bones, cut into draw groups `upper` and `lower` at the joint. */
function stripRaw(extra: Record<string, unknown> = {}) {
  const top = COLUMNS.map((x) => ({ x, y: -HALF }));
  const bottom = [...COLUMNS].reverse().map((x) => ({ x, y: HALF }));
  const points = [...top, ...bottom];
  const n = COLUMNS.length;
  const bottomIndex = (column: number) => 2 * n - 1 - column;
  const triangles: number[] = [];
  for (let j = 0; j < n - 1; j++) triangles.push(j, j + 1, bottomIndex(j + 1), j, bottomIndex(j + 1), bottomIndex(j));
  const vertices = points.flatMap(({ x, y }) =>
    x < JOINT ? [1, 0, x, y, 1] : x > JOINT ? [1, 1, x - JOINT, y, 1] : [2, 0, x, y, 0.5, 1, 0, y, 0.5]
  );
  return {
    format: "atlas-anim@1",
    name: "strip",
    canvas: { width: 200, height: 100, originX: 20, originY: 50 },
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", length: JOINT },
      { name: "lower", parent: "upper", x: JOINT, length: JOINT },
      { name: "shrug", parent: "root", y: -20, length: 10 }
    ],
    slots: [
      { name: "upper", bone: "upper", attachment: "strip" },
      { name: "lower", bone: "lower" },
      { name: "outline", bone: "root" }
    ],
    skins: {
      body: {
        attachments: {
          upper: {
            strip: {
              type: "mesh",
              path: "test/strip",
              bones: ["upper", "lower"],
              uvs: points.flatMap(({ x, y }) => [x / 120, (y + HALF) / (2 * HALF)]),
              triangles,
              vertices,
              hull: points.length,
              groups: { upper: [[0, 6]], lower: [[6, 12]] },
              width: 120,
              height: 20
            }
          }
        },
        ...extra
      }
    }
  };
}

function issuesOf(raw: unknown): string[] {
  const result = parseAnimDocument(raw);
  return result.ok ? result.warnings.map((w) => `${w.path.join(".")}: ${w.message}`) : result.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("format: groups, contours, grids, coverage", () => {
  it("accepts a grouped mesh with contours, coverage and a grid", () => {
    const raw = stripRaw({
      contours: { outline: { rim: { mesh: { slot: "upper", attachment: "strip" }, points: [0, 1, [2, 3, 11, 0.5, 0.25]], width: 2 } } },
      coverage: { regions: { forearm: { mesh: { slot: "upper", attachment: "strip" }, triangles: [[6, 12]] } } }
    });
    const result = parseAnimDocument({
      ...raw,
      drivenGrids: [{ name: "combo", x: { bone: "lower", at: [0, 45, 90] }, y: { bone: "shrug", at: [0, 20] }, keys: Array.from({ length: 6 }, () => ({})) }]
    });
    expect(result.ok, issuesOf(raw).join("\n")).toBe(true);
  });

  it("groups must partition the triangles and name real slots", () => {
    const overlap = stripRaw();
    (overlap.skins.body.attachments.upper.strip as { groups: unknown }).groups = { upper: [[0, 7]], lower: [[6, 12]] };
    expect(issuesOf(overlap).join("\n")).toMatch(/triangle 6 is already in group 'upper'/);
    const gap = stripRaw();
    (gap.skins.body.attachments.upper.strip as { groups: unknown }).groups = { upper: [[0, 5]], lower: [[6, 12]] };
    expect(issuesOf(gap).join("\n")).toMatch(/triangle 5 is in no group/);
    const unknown = stripRaw();
    (unknown.skins.body.attachments.upper.strip as { groups: unknown }).groups = { upper: [[0, 6]], forearm: [[6, 12]] };
    expect(issuesOf(unknown).join("\n")).toMatch(/groups\.forearm: unknown slot 'forearm'/);
  });

  it("contours: one binding, vertex refs in range, barycentric weights at most 1", () => {
    const both = stripRaw({ contours: { outline: { a: { mesh: { slot: "upper", attachment: "strip" }, points: [0, 1], bones: ["root"], vertices: [1, 0, 0, 0, 1, 1, 0, 1, 0, 1], width: 1 } } } });
    expect(issuesOf(both).join("\n")).toMatch(/either to a mesh/);
    const range = stripRaw({ contours: { outline: { a: { mesh: { slot: "upper", attachment: "strip" }, points: [0, 99], width: 1 } } } });
    expect(issuesOf(range).join("\n")).toMatch(/vertex index 99 is out of range/);
    const weights = stripRaw({ contours: { outline: { a: { mesh: { slot: "upper", attachment: "strip" }, points: [0, [1, 2, 3, 0.7, 0.6]], width: 1 } } } });
    expect(issuesOf(weights).join("\n")).toMatch(/exceed 1/);
    const short = stripRaw({ contours: { outline: { a: { bones: ["root"], vertices: [1, 0, 0, 0, 1, 1, 0, 5, 0, 1], closed: true, width: 1 } } } });
    expect(issuesOf(short).join("\n")).toMatch(/closed contour needs at least 3 points/);
    const owner = stripRaw({ contours: { nowhere: { a: { bones: ["root"], vertices: [1, 0, 0, 0, 1, 1, 0, 5, 0, 1], width: 1 } } } });
    expect(issuesOf(owner).join("\n")).toMatch(/unknown owner slot 'nowhere'/);
  });

  it("grids: key count, the 30-key cap (6x5), sorted axes, two different bones", () => {
    const base = stripRaw();
    const grid = (g: Record<string, unknown>) => issuesOf({ ...base, drivenGrids: [{ name: "g", x: { bone: "lower", at: [0, 90] }, y: { bone: "shrug", at: [0, 20] }, keys: [{}, {}, {}, {}], ...g }] }).join("\n");
    expect(grid({ keys: [{}, {}, {}] })).toMatch(/needs 4 keys/);
    expect(grid({ x: { bone: "lower", at: [0, 30, 60, 90] }, y: { bone: "shrug", at: [0, 10, 20, 30] }, keys: Array.from({ length: 16 }, () => ({})) })).not.toMatch(/at most/);
    expect(grid({ x: { bone: "lower", at: [0, 15, 30, 60, 75, 90] }, y: { bone: "shrug", at: [0, 5, 10, 20, 25, 30] }, keys: Array.from({ length: 36 }, () => ({})) })).toMatch(/at most 30 keys/);
    expect(grid({ x: { bone: "lower", at: [0, 0] } })).toMatch(/strictly increasing/);
    expect(grid({ y: { bone: "lower", at: [0, 20] } })).toMatch(/both axes are driven by 'lower'/);
  });

  it("coverage: covers must name a declared region of an existing skin", () => {
    const raw = stripRaw();
    (raw.skins as Record<string, unknown>)["sleeve"] = { coverage: { covers: [{ skin: "body", region: "forearm" }, { skin: "cape", region: "x" }] } };
    const text = issuesOf(raw).join("\n");
    expect(text).toMatch(/skin 'body' declares no coverage region 'forearm'/);
    expect(text).toMatch(/unknown skin 'cape'/);
  });
});

describe("draw groups", () => {
  it("a boundary vertex has the identical world position and UV in both groups at every pose", () => {
    const doc = loadAnimDocument({
      ...stripRaw(),
      drivenGrids: [
        {
          name: "combo",
          x: { bone: "lower", at: [0, 90] },
          y: { bone: "shrug", at: [0, 30] },
          keys: [{}, { deform: { body: { upper: { strip: { offset: 6, vertices: [3, -2, 1, 1] } } } } }, {}, {}]
        }
      ]
    });
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const upper = skeleton.getSlot("upper");
    const lower = skeleton.getSlot("lower");
    const mesh = skeleton.getAttachment(upper, "strip") as MeshAttachment;
    const groups = mesh.geometry.groups!;
    // Mesh vertices in both groups: the joint column (x = 60: vertices 3 and 10).
    const shared = [...groups[0]!.vertices].filter((v) => groups[1]!.vertices.includes(v));
    expect(shared.sort((a, b) => a - b)).toEqual([3, 10]);
    const a = new Float32Array(groups[0]!.vertices.length * 2);
    const b = new Float32Array(groups[1]!.vertices.length * 2);
    let checked = 0;
    for (const bend of [-120, -45, 0, 10, 37.5, 90, 150]) {
      for (const shrug of [0, 15, 30]) {
        skeleton.setToSetupPose();
        skeleton.getBone("lower").pose.rotation = bend;
        skeleton.getBone("shrug").pose.rotation = shrug;
        skeleton.x = 7.25;
        skeleton.updateWorldTransform();
        expect(upper.groupMesh).toBe(mesh);
        expect(lower.groupMesh).toBe(mesh);
        expect([upper.groupIndex, lower.groupIndex]).toEqual([0, 1]);
        expect(lower.groupOwner).toBe(upper);
        expect(skeleton.computeGroupWorldVertices(upper, a)).toBe(groups[0]!.vertices.length);
        expect(skeleton.computeGroupWorldVertices(lower, b)).toBe(groups[1]!.vertices.length);
        for (const vertex of shared) {
          const i = groups[0]!.vertices.indexOf(vertex);
          const j = groups[1]!.vertices.indexOf(vertex);
          expect([a[i * 2], a[i * 2 + 1]]).toEqual([b[j * 2], b[j * 2 + 1]]);
          expect([groups[0]!.uvs[i * 2], groups[0]!.uvs[i * 2 + 1]]).toEqual([groups[1]!.uvs[j * 2], groups[1]!.uvs[j * 2 + 1]]);
          checked++;
        }
        // The groups read the one skinned result: equal to skinning the whole mesh.
        const whole = new Float32Array(mesh.geometry.vertexCount * 2);
        skeleton.computeSlotWorldVertices(upper, whole);
        groups[1]!.vertices.forEach((vertex, k) => {
          expect(b[k * 2]).toBe(whole[vertex * 2]);
          expect(b[k * 2 + 1]).toBe(whole[vertex * 2 + 1]);
        });
      }
    }
    expect(checked).toBe(7 * 3 * 2);
  });

  it("a hidden or inactive group shows nothing: the user slot showing no mesh clears every group", () => {
    const skeleton = new Skeleton(loadAnimDocument(stripRaw()));
    skeleton.setActiveSkins(["body"]);
    const upper = skeleton.getSlot("upper");
    upper.placeholder = null;
    skeleton.updateWorldTransform();
    expect(skeleton.getSlot("lower").groupMesh).toBeNull();
    expect(skeleton.computeGroupWorldVertices(skeleton.getSlot("lower"), new Float32Array(64))).toBe(0);
  });
});

describe("two-driver corrective grids", () => {
  it("blend bilinearly between the four surrounding keys and hold at the edges", () => {
    const at = (x: number, y: number) => ({ deform: { body: { upper: { strip: { offset: 0, vertices: [x, y] } } } } });
    // Key value at (xi, yj) = (10 * i + 100 * j, j) on a 3 x 2 grid.
    const doc = loadAnimDocument({
      ...stripRaw(),
      drivenGrids: [{ name: "combo", x: { bone: "lower", at: [0, 40, 80] }, y: { bone: "shrug", at: [0, 20] }, keys: [at(0, 0), at(10, 0), at(20, 0), at(100, 1), at(110, 1), at(120, 1)] }]
    });
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const mesh = skeleton.getAttachment(skeleton.getSlot("upper"), "strip") as MeshAttachment;
    const sample = (x: number, y: number) => {
      skeleton.setToSetupPose();
      skeleton.getBone("lower").pose.rotation = x;
      skeleton.getBone("shrug").pose.rotation = y;
      skeleton.updateWorldTransform();
      const deform = skeleton.deformFor(mesh)!;
      return [deform[0], deform[1]] as const;
    };
    const expected = (x: number, y: number) => {
      const cx = Math.min(Math.max(x, 0), 80);
      const cy = Math.min(Math.max(y, 0), 20);
      return [cx / 4 + 100 * (cy / 20), cy / 20];
    };
    for (const [x, y] of [[0, 0], [20, 10], [40, 5], [60, 15], [80, 20], [-30, -5], [120, 40], [10, 25]] as const) {
      const [dx, dy] = sample(x, y);
      expect(dx).toBeCloseTo(expected(x, y)[0] as number, 4);
      expect(dy).toBeCloseTo(expected(x, y)[1] as number, 4);
    }
    // A bilinear (not separable-additive) blend: the cross term shows up mid-cell.
    const [mid] = sample(20, 10);
    expect(mid).toBeCloseTo(5 + 50, 4);
  });

  it("is skin-gated like driven sets", () => {
    const doc = loadAnimDocument({
      ...stripRaw(),
      skins: { ...stripRaw().skins, armour: {} },
      drivenGrids: [{ name: "g", skin: "armour", x: { bone: "lower", at: [0, 90] }, y: { bone: "shrug", at: [0, 20] }, keys: [{}, { deform: { body: { upper: { strip: { vertices: [5] } } } } }, {}, {}] }]
    });
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const mesh = skeleton.getAttachment(skeleton.getSlot("upper"), "strip") as MeshAttachment;
    skeleton.getBone("lower").pose.rotation = 90;
    skeleton.updateWorldTransform();
    expect(skeleton.deformFor(mesh)).toBeNull();
    skeleton.setActiveSkins(["body", "armour"]);
    skeleton.updateWorldTransform();
    expect(skeleton.deformFor(mesh)?.[0]).toBeCloseTo(5, 5);
  });
});

describe("contours", () => {
  function circleDoc() {
    const raw = stripRaw();
    const setup = new Skeleton(loadAnimDocument(raw));
    setup.setActiveSkins(["body"]);
    setup.updateWorldTransform();
    const mesh = setup.getAttachment(setup.getSlot("upper"), "strip") as MeshAttachment;
    const world = setup.meshWorldVertices(mesh, setup.getSlot("upper").bone);
    const points = Array.from({ length: 16 }, (_, i) => {
      const t = (i / 16) * Math.PI * 2;
      return bindPointToMesh(world, mesh.geometry.triangles, JOINT + 7 * Math.cos(t), 7 * Math.sin(t));
    });
    return loadAnimDocument({
      ...raw,
      skins: {
        body: {
          ...raw.skins.body,
          contours: {
            outline: {
              ring: { mesh: { slot: "upper", attachment: "strip" }, points, closed: true, width: 2, visible: [{ bone: "lower", min: -10, max: 100 }] },
              tick: { bones: ["upper"], vertices: [1, 0, 10, 0, 1, 1, 0, 30, 0, 1], width: 1.5, color: "202020ff" }
            }
          }
        }
      }
    });
  }

  it("a mesh-bound centreline follows the deformed mesh exactly (barycentric on the skinned vertices)", () => {
    const skeleton = new Skeleton(circleDoc());
    skeleton.setActiveSkins(["body"]);
    const [ring, tick] = skeleton.activeContours;
    expect(ring?.name).toBe("ring");
    expect([...ring!.ownerBones]).toEqual([1, 2]); // upper, lower (the joint ring touches both)
    skeleton.getBone("lower").pose.rotation = 70;
    skeleton.updateWorldTransform();
    const mesh = ring!.mesh!;
    const world = new Float32Array(mesh.geometry.vertexCount * 2);
    skeleton.computeSlotWorldVertices(skeleton.getSlot("upper"), world);
    const points = new Float32Array(ring!.pointCount * 2);
    skeleton.computeContourPoints(ring!, points);
    for (let p = 0; p < ring!.pointCount; p++) {
      let x = 0;
      let y = 0;
      for (let k = 0; k < 3; k++) {
        const v = ring!.refs[p * 3 + k] as number;
        x += (world[v * 2] as number) * (ring!.refWeights[p * 3 + k] as number);
        y += (world[v * 2 + 1] as number) * (ring!.refWeights[p * 3 + k] as number);
      }
      expect(points[p * 2]).toBeCloseTo(x, 4);
      expect(points[p * 2 + 1]).toBeCloseTo(y, 4);
    }
    // Bone-bound: a tick on the upper bone from x 10 to 30.
    const tickPoints = new Float32Array(4);
    skeleton.computeContourPoints(tick!, tickPoints);
    expect([...tickPoints]).toEqual([10, 0, 30, 0]);
  });

  it("end extensions prolong an open centreline along the posed end tangents; closed contours refuse them", () => {
    const raw = stripRaw();
    const withTick = (tick: Record<string, unknown>) => ({ ...raw, skins: { body: { ...raw.skins.body, contours: { outline: { tick } } } } });
    const skeleton = new Skeleton(loadAnimDocument(withTick({ bones: ["upper"], vertices: [1, 0, 10, 0, 1, 1, 0, 30, 0, 1], width: 1.5, extend: [2, 5] })));
    skeleton.setActiveSkins(["body"]);
    skeleton.updateWorldTransform();
    const tick = skeleton.activeContours[0]!;
    expect([tick.boundCount, tick.pointCount, tick.extendStart, tick.extendEnd]).toEqual([2, 4, 2, 5]);
    expect(tick.vertexCount).toBe(strokeVertexCount(4, false, true));
    const points = new Float32Array(tick.pointCount * 2);
    skeleton.computeContourPoints(tick, points);
    expect([...points]).toEqual([8, 0, 10, 0, 30, 0, 35, 0]);
    // Posed: the upper bone rotated 90 degrees carries the extensions along its tangent.
    skeleton.getBone("upper").pose.rotation = 90;
    skeleton.updateWorldTransform();
    skeleton.computeContourPoints(tick, points);
    expect(points[7]! - points[5]!).toBeCloseTo(5, 4);
    expect(points[1]! - points[3]!).toBeCloseTo(-2, 4);
    expect(() => loadAnimDocument(withTick({ bones: ["upper"], vertices: [1, 0, 10, 0, 1, 1, 0, 30, 0, 1, 1, 0, 30, 9, 1], closed: true, width: 1.5, extend: [0, 3] }))).toThrow(/closed contour has no ends to extend/);
  });

  it("visibility rules and owner-slot hiding", () => {
    const skeleton = new Skeleton(circleDoc());
    skeleton.setActiveSkins(["body"]);
    const ring = skeleton.activeContours[0]!;
    skeleton.updateWorldTransform();
    expect(skeleton.isContourVisible(ring)).toBe(true);
    skeleton.getBone("lower").pose.rotation = 120;
    skeleton.updateWorldTransform();
    expect(skeleton.isContourVisible(ring)).toBe(false);
    skeleton.getBone("lower").pose.rotation = 0;
    skeleton.getSlot("outline").hidden = true;
    expect(skeleton.isContourVisible(ring)).toBe(false);
  });

  it("owner bones include the drivers of the bound mesh's correctives", () => {
    const doc = circleDoc();
    const withGrid = loadAnimDocument({ ...doc, drivenGrids: [{ name: "g", x: { bone: "lower", at: [0, 90] }, y: { bone: "shrug", at: [0, 20] }, keys: [{}, { deform: { body: { upper: { strip: { vertices: [1] } } } } }, {}, {}] }] });
    const skeleton = new Skeleton(withGrid);
    skeleton.setActiveSkins(["body"]);
    expect([...skeleton.activeContours[0]!.ownerBones]).toEqual([1, 2, 3]);
  });
});

describe("stroke builder", () => {
  const ramp = { u0: 0.25, u1: 0.75, v: 0.5, rampFraction: 0.125 };

  function strokeOf(points: number[], closed: boolean, width: number, aa: number, roundCaps = true) {
    const count = points.length / 2;
    const positions = new Float32Array(strokeVertexCount(count, closed, roundCaps) * 2);
    const uvs = new Float32Array(positions.length);
    const all = new Uint32Array(strokeIndexCount(count, closed, roundCaps));
    const counts = { vertices: 0, indices: 0 };
    const vertices = buildStroke(points, count, closed, roundCaps, width, aa, ramp, positions, uvs, all, counts);
    expect(counts.vertices).toBe(vertices);
    return { positions, uvs, indices: all.subarray(0, counts.indices), vertices };
  }

  /** Per point (centre vertices carry the centre u): the centre and its rim vertices, in layout order. */
  function pointsOf(positions: Float32Array, uvs: Float32Array, vertices: number, uCentre: number) {
    const out: { cx: number; cy: number; rim: [number, number][] }[] = [];
    for (let v = 0; v < vertices; v++) {
      const x = positions[v * 2] as number;
      const y = positions[v * 2 + 1] as number;
      if (Math.abs((uvs[v * 2] as number) - uCentre) < 1e-6) out.push({ cx: x, cy: y, rim: [] });
      else out[out.length - 1]!.rim.push([x, y]);
    }
    return out;
  }

  it("puts every rim vertex at w/2 + aa/2 from its centre (join polygons within the error budget) and maps the ramp so coverage is 0.5 at w/2", () => {
    const n = 48;
    const points = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      return [30 * Math.cos(t), 14 * Math.sin(t)]; // an ellipse: curvature varies along it
    }).flat();
    const width = 4;
    const aa = 0.5;
    const radius = width / 2 + aa / 2;
    const uCentre = ramp.u0 + (ramp.u1 - ramp.u0) * ramp.rampFraction * (radius / aa);
    const { positions, uvs, indices, vertices } = strokeOf(points, true, width, aa);
    expect(Math.max(...indices)).toBeLessThan(vertices);
    const per = pointsOf(positions, uvs, vertices, uCentre);
    expect(per).toHaveLength(n);
    for (const { cx, cy, rim } of per) {
      expect(rim.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of rim) {
        const d = Math.hypot(x - cx, y - cy);
        // Outer join polygons at most STROKE_JOIN_ERROR display px outside the radius; inner rims at the miter (at least the radius).
        expect(d).toBeGreaterThanOrEqual(radius - 1e-4);
        expect(d).toBeLessThanOrEqual(radius * 1.1);
      }
    }
    for (let v = 0; v < vertices; v++) {
      const u = uvs[v * 2] as number;
      expect(Math.abs(u - uCentre) < 1e-6 || u === ramp.u0).toBe(true);
    }
  });

  it("joins by pixel error: a miter on smooth turns, a clipped miter at moderate corners, a fan only at sharp ones; the outer rim within the budget", () => {
    const width = 4;
    const aa = 1; // radius 2.5 display px
    const radius = width / 2 + aa / 2;
    const uCentre = ramp.u0 + (ramp.u1 - ramp.u0) * Math.min(1, ramp.rampFraction * (radius / aa));
    const outerCounts: number[] = [];
    for (const degrees of [5, 30, 45, 90, 150]) {
      const t = (degrees * Math.PI) / 180;
      const { positions, uvs, vertices } = strokeOf([-10, 0, 0, 0, 10 * Math.cos(t), 10 * Math.sin(t)], false, width, aa, false);
      const middle = pointsOf(positions, uvs, vertices, uCentre)[1]!;
      // The left turn's outer side is the right rim (-n): the last run of the point.
      const outer = middle.rim.slice(1);
      outerCounts.push(outer.length);
      expect(outer.length).toBe(strokeJoinSteps(t, radius / aa));
      // Circumscribed: every outer vertex at the same distance, its error the vertex excess over the radius.
      let worst = 0;
      for (const [x, y] of outer) worst = Math.max(worst, (Math.hypot(x - middle.cx, y - middle.cy) - radius) / aa);
      expect(worst).toBeLessThanOrEqual(Math.max(0.125, strokeJoinError(t, radius / aa)) + 1e-6);
      if (degrees <= 90) expect(worst).toBeLessThanOrEqual(0.125 + 1e-6);
      // The first and last outer vertices lie on the adjoining segments' offset lines (segments stay exact).
      const [fx, fy] = outer[0]!;
      const [lx, ly] = outer[outer.length - 1]!;
      expect(fy).toBeCloseTo(-radius, 4);
      expect(-Math.sin(t) * (lx - middle.cx) + Math.cos(t) * (ly - middle.cy)).toBeCloseTo(-radius, 4);
      expect(fx).toBeGreaterThanOrEqual(middle.cx - 1e-6); // the incoming offset edge runs on past the point to the polygon
    }
    expect(outerCounts[0]).toBe(1); // smooth: a miter
    expect(outerCounts[4]).toBeGreaterThan(2); // sharp: a fan
    expect(outerCounts).toEqual([...outerCounts].sort((x, y) => x - y));
  });

  it("compacts: a smooth closed curve uses 3 vertices per point, well under half the capacity", () => {
    const n = 64;
    const points = Array.from({ length: n }, (_, i) => [40 * Math.cos((i / n) * Math.PI * 2), 40 * Math.sin((i / n) * Math.PI * 2)]).flat();
    const { vertices, indices } = strokeOf(points, true, 3, 1);
    expect(vertices).toBe(3 * n);
    expect(vertices).toBeLessThanOrEqual(strokeVertexCount(n, true, true) / 2);
    // Two half-quads per side per segment, no fan triangles (each join is a single vertex per side).
    expect(indices.length).toBe(3 * 4 * n);
    expect(STROKE_MAX_ARC_STEPS).toBe(4);
  });

  it("covers a straight segment as a rectangle with round caps", () => {
    const { positions, vertices } = strokeOf([0, 0, 10, 0], false, 2, 1);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < vertices; v++) {
      minX = Math.min(minX, positions[v * 2] as number);
      maxX = Math.max(maxX, positions[v * 2] as number);
      minY = Math.min(minY, positions[v * 2 + 1] as number);
      maxY = Math.max(maxY, positions[v * 2 + 1] as number);
    }
    expect([minX, maxX, minY, maxY].map((v) => Math.round(v * 1000) / 1000)).toEqual([-1.5, 11.5, -1.5, 1.5]);
  });

  it("binds a canvas point barycentrically and reproduces it at setup", () => {
    const world = [0, 0, 10, 0, 0, 10];
    const bound = bindPointToMesh(world, [0, 1, 2], 2, 3);
    expect(Array.isArray(bound)).toBe(true);
    const [a, b, c, wa, wb] = bound as [number, number, number, number, number];
    const x = world[a * 2]! * wa + world[b * 2]! * wb + world[c * 2]! * (1 - wa - wb);
    const y = world[a * 2 + 1]! * wa + world[b * 2 + 1]! * wb + world[c * 2 + 1]! * (1 - wa - wb);
    expect([x, y].map((v) => Math.round(v * 1e5) / 1e5)).toEqual([2, 3]);
    expect(bindPointToMesh(world, [0, 1, 2], 10, 0)).toBe(1);
  });
});
