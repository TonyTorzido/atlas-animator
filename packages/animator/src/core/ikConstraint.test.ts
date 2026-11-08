import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "./format.js";
import { DEG_TO_RAD, RAD_TO_DEG, wrapDegrees, type Vec2 } from "./math.js";
import type { Skeleton } from "./skeleton.js";
import { random, testSkeleton } from "./testHelpers.js";

/*
 * IK against the geometry: tip positions and elbow angles computed by hand (law of cosines,
 * softness formula), not snapshots of the solver.
 */

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;
type IkInput = NonNullable<Sections["ik"]>[number];
type BoneInput = Sections["bones"][number];

const L1 = 100;
const L2 = 80;
/** The upper arm's world origin (shoulder at (10, -20), upper at its origin). */
const ORIGIN = { x: 10, y: -20 };

function arm(ik: Partial<IkInput> = {}, shoulder: Partial<BoneInput> = {}, upper: Partial<BoneInput> = {}): Skeleton {
  return testSkeleton({
    bones: [
      { name: "root" },
      { name: "shoulder", parent: "root", x: ORIGIN.x, y: ORIGIN.y, ...shoulder },
      { name: "upper", parent: "shoulder", rotation: 30, length: L1, ...upper },
      { name: "lower", parent: "upper", x: L1, rotation: 20, length: L2 },
      { name: "target", parent: "root", x: 120, y: 60 }
    ],
    ik: [{ name: "arm", bones: ["upper", "lower"], target: "target", ...ik }]
  });
}

function aimAt(skeleton: Skeleton, x: number, y: number): void {
  const target = skeleton.getBone("target");
  target.pose.x = x;
  target.pose.y = y;
  skeleton.updateWorldTransform();
}

const point = (): Vec2 => ({ x: 0, y: 0 });
const tip = (skeleton: Skeleton): Vec2 => skeleton.getBone("lower").localToWorld(L2 * 1, 0, point());
const elbow = (skeleton: Skeleton): Vec2 => ({ x: skeleton.getBone("lower").world.x, y: skeleton.getBone("lower").world.y });
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
/** z of (elbow - origin) x (tip - elbow): positive when the chain turns clockwise on the canvas. */
function turn(skeleton: Skeleton, origin: Vec2): number {
  const e = elbow(skeleton);
  const t = tip(skeleton);
  return (e.x - origin.x) * (t.y - e.y) - (e.y - origin.y) * (t.x - e.x);
}
const worldAngle = (skeleton: Skeleton, bone: string) => skeleton.getBone(bone).worldRotationX;

describe("two-bone IK", () => {
  it("reaches every reachable target within 1e-4 and bends the asked way", () => {
    const rand = random(7);
    for (const bendPositive of [true, false]) {
      const skeleton = arm({ bendPositive });
      for (let i = 0; i < 200; i++) {
        const angle = rand(-Math.PI, Math.PI);
        const d = rand(L1 - L2 + 0.5, L1 + L2 - 0.5);
        const target = { x: ORIGIN.x + Math.cos(angle) * d, y: ORIGIN.y + Math.sin(angle) * d };
        aimAt(skeleton, target.x, target.y);
        expect(distance(tip(skeleton), target), `target ${i}`).toBeLessThan(1e-4);
        // Bone lengths are kept, so the elbow angle is the law-of-cosines one.
        expect(distance(elbow(skeleton), ORIGIN)).toBeCloseTo(L1, 9);
        const bend = Math.abs(wrapDegrees(worldAngle(skeleton, "lower") - worldAngle(skeleton, "upper")));
        expect(bend).toBeCloseTo(Math.acos((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2)) * RAD_TO_DEG, 6);
        // Bend side: clockwise (positive) turn for bendPositive, in world and in local terms.
        expect(Math.sign(turn(skeleton, ORIGIN))).toBe(bendPositive ? 1 : -1);
        expect(Math.sign(wrapDegrees(skeleton.getBone("lower").applied.rotation))).toBe(bendPositive ? 1 : -1);
      }
    }
  });

  it("points straight at an unreachable target and does not stretch by default", () => {
    const skeleton = arm();
    aimAt(skeleton, ORIGIN.x + 240, ORIGIN.y + 180); // 300 px away
    const t = tip(skeleton);
    expect(t.x).toBeCloseTo(ORIGIN.x + 0.8 * (L1 + L2), 9);
    expect(t.y).toBeCloseTo(ORIGIN.y + 0.6 * (L1 + L2), 9);
    expect(skeleton.getBone("upper").applied.scaleX).toBeCloseTo(1, 12);
  });

  it("stretches the parent to reach an unreachable target only when stretch is on", () => {
    const skeleton = arm({ stretch: true });
    aimAt(skeleton, ORIGIN.x + 240, ORIGIN.y + 180);
    expect(distance(tip(skeleton), { x: ORIGIN.x + 240, y: ORIGIN.y + 180 })).toBeLessThan(1e-4);
    const upper = skeleton.getBone("upper").applied;
    expect(upper.scaleX).toBeCloseTo(300 / (L1 + L2), 9);
    expect(upper.scaleY).toBeCloseTo(1, 12);
    // Reachable targets never stretch.
    aimAt(skeleton, ORIGIN.x + 60, ORIGIN.y + 80);
    expect(skeleton.getBone("upper").applied.scaleX).toBeCloseTo(1, 12);
    expect(distance(tip(skeleton), { x: ORIGIN.x + 60, y: ORIGIN.y + 80 })).toBeLessThan(1e-4);
  });

  it("uniform stretch scales both axes of the parent", () => {
    const skeleton = arm({ stretch: true, uniform: true });
    aimAt(skeleton, ORIGIN.x, ORIGIN.y + 360);
    expect(distance(tip(skeleton), { x: ORIGIN.x, y: ORIGIN.y + 360 })).toBeLessThan(1e-4);
    const upper = skeleton.getBone("upper").applied;
    expect(upper.scaleX).toBeCloseTo(2, 9);
    expect(upper.scaleY).toBeCloseTo(2, 9);
  });

  it("softness pulls the chain back before full extension", () => {
    const soft = 20;
    const full = L1 + L2;
    const skeleton = arm({ softness: soft });
    const solvedDistance = (d: number) => {
      aimAt(skeleton, ORIGIN.x + d, ORIGIN.y);
      const t = tip(skeleton);
      expect(t.y).toBeCloseTo(ORIGIN.y, 9); // on the line to the target
      return distance(t, ORIGIN);
    };
    // Outside the soft zone the target is reached exactly.
    expect(solvedDistance(150)).toBeCloseTo(150, 9);
    // Inside it, the analytic eased distance: r = L - s * exp((L - s - d) / s).
    for (const d of [165, 175, full, 200, 400]) {
      const expected = full - soft * Math.exp((full - soft - d) / soft);
      expect(solvedDistance(d), `d = ${d}`).toBeCloseTo(expected, 9);
      expect(solvedDistance(d)).toBeLessThan(Math.min(d, full));
    }
    // Continuous at the start of the zone, and the elbow is still bent at full reach.
    expect(solvedDistance(full - soft + 1e-6)).toBeCloseTo(full - soft, 5);
    solvedDistance(full);
    expect(Math.abs(wrapDegrees(worldAngle(skeleton, "lower") - worldAngle(skeleton, "upper")))).toBeGreaterThan(5);
  });

  it("softness with stretch reaches the target and keeps the soft bend", () => {
    const soft = 20;
    const full = L1 + L2;
    const skeleton = arm({ softness: soft, stretch: true });
    for (const d of [175, 260]) {
      aimAt(skeleton, ORIGIN.x, ORIGIN.y - d);
      expect(distance(tip(skeleton), { x: ORIGIN.x, y: ORIGIN.y - d }), `d = ${d}`).toBeLessThan(1e-4);
      const soft_ = full - soft * Math.exp((full - soft - d) / soft);
      expect(skeleton.getBone("upper").applied.scaleX).toBeCloseTo(d / soft_, 6);
      expect(Math.abs(wrapDegrees(worldAngle(skeleton, "lower") - worldAngle(skeleton, "upper")))).toBeGreaterThan(1);
    }
  });

  it("mix 0 leaves the incoming pose, mix 1 solves, and mix blends each bone's world turn", () => {
    const fk = arm({ mix: 0 });
    aimAt(fk, 60, 90);
    const solved = arm();
    aimAt(solved, 60, 90);
    expect(worldAngle(fk, "upper")).toBeCloseTo(30, 9);
    expect(worldAngle(fk, "lower")).toBeCloseTo(50, 9);

    const half = arm({ mix: 0.5 });
    aimAt(half, 60, 90);
    const upperTurn = wrapDegrees(worldAngle(solved, "upper") - 30);
    expect(wrapDegrees(worldAngle(half, "upper") - 30)).toBeCloseTo(upperTurn / 2, 9);
    // The child's bend (relative to the parent) moves half way too.
    const fkBend = 20;
    const solvedBend = wrapDegrees(worldAngle(solved, "lower") - worldAngle(solved, "upper"));
    expect(wrapDegrees(worldAngle(half, "lower") - worldAngle(half, "upper"))).toBeCloseTo(fkBend + (solvedBend - fkBend) / 2, 9);
  });

  it("solves under a rotated, uniformly scaled parent and keeps the bend side in local terms when mirrored", () => {
    const scaled = arm({}, { rotation: 40, scaleX: 1.5, scaleY: 1.5 });
    const target = { x: ORIGIN.x + 120, y: ORIGIN.y + 150 }; // within 1.5 * [20, 180]
    aimAt(scaled, target.x, target.y);
    expect(distance(tip(scaled), target)).toBeLessThan(1e-4);
    expect(distance(elbow(scaled), ORIGIN)).toBeCloseTo(1.5 * L1, 9);

    for (const bendPositive of [true, false]) {
      const mirrored = arm({ bendPositive }, { scaleX: -1 });
      aimAt(mirrored, ORIGIN.x - 90, ORIGIN.y + 70);
      expect(distance(tip(mirrored), { x: ORIGIN.x - 90, y: ORIGIN.y + 70 })).toBeLessThan(1e-4);
      // Local bend sign follows bendPositive; in world the mirror flips it.
      expect(Math.sign(wrapDegrees(mirrored.getBone("lower").applied.rotation))).toBe(bendPositive ? 1 : -1);
      expect(Math.sign(turn(mirrored, ORIGIN))).toBe(bendPositive ? -1 : 1);
    }
  });

  it("reaches exactly under a non-uniformly scaled parent", () => {
    const skeleton = arm({}, {}, { scaleY: 0.6 });
    const rand = random(11);
    for (let i = 0; i < 50; i++) {
      const angle = rand(-Math.PI, Math.PI);
      const d = rand(60, 150);
      const target = { x: ORIGIN.x + Math.cos(angle) * d, y: ORIGIN.y + Math.sin(angle) * d };
      aimAt(skeleton, target.x, target.y);
      expect(distance(tip(skeleton), target), `target ${i}`).toBeLessThan(1e-4);
    }
  });

  it("holds rotation limits on both bones (enforceLimits) and keeps applied consistent with world", () => {
    const skeleton = testSkeleton({
      bones: [
        { name: "root" },
        { name: "upper", parent: "root", rotation: 30, length: L1, limits: { min: -10, max: 10 } },
        { name: "lower", parent: "upper", x: L1, rotation: 20, length: L2, limits: { min: 0, max: 45 } },
        { name: "target", parent: "root", x: -50, y: 150 }
      ],
      ik: [{ name: "arm", bones: ["upper", "lower"], target: "target" }]
    });
    const upper = skeleton.getBone("upper");
    const lower = skeleton.getBone("lower");
    expect(upper.applied.rotation - 30).toBeGreaterThanOrEqual(-10 - 1e-9);
    expect(upper.applied.rotation - 30).toBeLessThanOrEqual(10 + 1e-9);
    expect(lower.applied.rotation - 20).toBeGreaterThanOrEqual(-1e-9);
    expect(lower.applied.rotation - 20).toBeLessThanOrEqual(45 + 1e-9);
    // A limit was hit (the target is far outside the allowed arc), and world matches applied.
    expect(upper.applied.rotation).toBeCloseTo(40, 9);
    const world = { ...lower.world };
    lower.updateWorldTransform();
    for (const key of ["a", "b", "c", "d", "x", "y"] as const) expect(lower.world[key]).toBeCloseTo(world[key], 9);
  });

  it("does not accumulate across frames", () => {
    const skeleton = arm({ softness: 10, stretch: true });
    aimAt(skeleton, 150, 40);
    const first = { ...skeleton.getBone("lower").world };
    skeleton.updateWorldTransform();
    skeleton.updateWorldTransform();
    expect(skeleton.getBone("lower").world).toEqual(first);
  });

  it("handles degenerate chains: a child at the parent's origin aims alone, a child without length turns the parent", () => {
    const stacked = testSkeleton({
      bones: [
        { name: "root" },
        { name: "upper", parent: "root", length: 50 },
        { name: "lower", parent: "upper", length: 40 },
        { name: "target", parent: "root", x: 0, y: 100 }
      ],
      ik: [{ name: "arm", bones: ["upper", "lower"], target: "target" }]
    });
    expect(stacked.getBone("lower").worldRotationX).toBeCloseTo(90, 9);
    expect(stacked.getBone("upper").worldRotationX).toBeCloseTo(0, 9);

    const stub = testSkeleton({
      bones: [
        { name: "root" },
        { name: "upper", parent: "root", length: 50 },
        { name: "lower", parent: "upper", x: 50 },
        { name: "target", parent: "root", x: 0, y: -100 }
      ],
      ik: [{ name: "arm", bones: ["upper", "lower"], target: "target" }]
    });
    expect(stub.getBone("upper").worldRotationX).toBeCloseTo(-90, 9);
    expect(Number.isFinite(stub.getBone("lower").world.a)).toBe(true);
  });
});

describe("one-bone IK", () => {
  function single(ik: Partial<IkInput> = {}, bone: Partial<BoneInput> = {}): Skeleton {
    return testSkeleton({
      bones: [
        { name: "root" },
        { name: "parent", parent: "root", x: 20, y: 10, rotation: 35 },
        { name: "bone", parent: "parent", x: 10, rotation: -15, length: 100, ...bone },
        { name: "target", parent: "root" }
      ],
      ik: [{ name: "aim", bones: ["bone"], target: "target", ...ik }]
    });
  }
  const origin = (skeleton: Skeleton) => ({ x: skeleton.getBone("bone").world.x, y: skeleton.getBone("bone").world.y });

  it("points the bone's X axis at the target, by mix", () => {
    const skeleton = single();
    const o = origin(skeleton);
    aimAt(skeleton, o.x - 30, o.y + 40);
    expect(worldAngle(skeleton, "bone")).toBeCloseTo(Math.atan2(40, -30) * RAD_TO_DEG, 9);
    expect(skeleton.getBone("bone").applied.scaleX).toBeCloseTo(1, 12);

    const half = single({ mix: 0.5 });
    aimAt(half, o.x - 30, o.y + 40);
    const start = 35 - 15;
    expect(worldAngle(half, "bone")).toBeCloseTo(start + wrapDegrees(Math.atan2(40, -30) * RAD_TO_DEG - start) / 2, 9);
  });

  it("stretches and compresses only when asked, uniformly on request", () => {
    const check = (ik: Partial<IkInput>, d: number, scaleX: number, scaleY: number) => {
      const skeleton = single(ik);
      const o = origin(skeleton);
      aimAt(skeleton, o.x + d * Math.cos(DEG_TO_RAD * 70), o.y + d * Math.sin(DEG_TO_RAD * 70));
      const applied = skeleton.getBone("bone").applied;
      expect(applied.scaleX, JSON.stringify(ik) + ` d=${d}`).toBeCloseTo(scaleX, 9);
      expect(applied.scaleY).toBeCloseTo(scaleY, 9);
      if (scaleX !== 1 && ik.mix === undefined) expect(distance(skeleton.getBone("bone").localToWorld(100, 0, point()), {
        x: o.x + d * Math.cos(DEG_TO_RAD * 70),
        y: o.y + d * Math.sin(DEG_TO_RAD * 70)
      })).toBeLessThan(1e-9);
    };
    check({}, 150, 1, 1);
    check({ stretch: true }, 150, 1.5, 1);
    check({ stretch: true }, 50, 1, 1);
    check({ compress: true }, 50, 0.5, 1);
    check({ compress: true }, 150, 1, 1);
    check({ stretch: true, uniform: true }, 150, 1.5, 1.5);
    check({ stretch: true, mix: 0.5 }, 150, 1.25, 1);
  });

  it("aims a negatively scaled bone by its drawn direction", () => {
    const skeleton = single({}, { scaleX: -1 });
    const o = origin(skeleton);
    aimAt(skeleton, o.x + 50, o.y + 50);
    expect(distance(skeleton.getBone("bone").localToWorld(100, 0, point()), o)).toBeCloseTo(100, 9);
    const t = skeleton.getBone("bone").localToWorld(100, 0, point());
    expect(Math.atan2(t.y - o.y, t.x - o.x) * RAD_TO_DEG).toBeCloseTo(45, 9);
  });
});
