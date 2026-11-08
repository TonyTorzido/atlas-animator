import { describe, expect, it } from "vitest";
import { loadAnimDocument, parseAnimDocument } from "../../core/formatLoader.js";
import { checkPoseLimits, type ValidationIssue } from "../validate.js";
import { limitPoint, nearestLegalPose, sampleClip } from "../liveLimits.js";
import { convexOutside, insideLimits, isConvex, reachAlong, shrinkToFree, type PoseLimit } from "./limits.js";
import type { Pt } from "./geometry.js";

/*
 * Plan pass 3d-1: combined pose limits (convex polygons in driver space, AND-ed), the auto
 * shrink to a collision-free convex set, and the validator flagging clips outside.
 */

const square: Pt[] = [[-10, 0], [100, 0], [100, 70], [-10, 70]];
const corner = (x: number, y: number) => x + y * 1.2 > 140; // a blocked corner at high x and y

describe("pose limits", () => {
  it("shrinks the limit rectangle to a convex set free of every blocked sample, keeping the setup", () => {
    const free: Pt[] = [];
    const blocked: Pt[] = [];
    for (let x = -10; x <= 100; x += 5) for (let y = 0; y <= 70; y += 5) (corner(x, y) ? blocked : free).push([x, y]);
    const poly = shrinkToFree(square, free, blocked, 2.5, [0, 0]);
    expect(isConvex(poly)).toBe(true);
    for (const b of blocked) expect(convexOutside(poly, b)).toBeGreaterThan(2.4);
    expect(convexOutside(poly, [0, 0])).toBeLessThanOrEqual(0);
    // Most free samples survive (the cut follows the straight boundary).
    const kept = free.filter((f) => convexOutside(poly, f) <= 1e-6).length;
    expect(kept / free.length).toBeGreaterThan(0.9);
  });

  it("ANDs polygons and reports the farthest reachable value along one driver", () => {
    const limits: PoseLimit[] = [
      { name: "a", x: "raise", y: "elbow", polygon: [[-15, 0], [105, 0], [105, 10], [60, 70], [-15, 70]], source: "declared" },
      { name: "b", x: "raise", y: "shrug", polygon: [[-15, -12], [100, -12], [100, 12], [-15, 12]], source: "declared" }
    ];
    expect(insideLimits(limits, { raise: 90 })).toBe(true);
    expect(insideLimits(limits, { raise: 90, elbow: 40 })).toBe(false);
    expect(insideLimits(limits, { raise: 102 })).toBe(false); // outside b only
    expect(reachAlong(limits, "raise", 105)).toBeCloseTo(100, 2);
    expect(reachAlong(limits, "elbow", 70)).toBe(70);
  });

  it("the validator flags a clip that leaves a pose limit and passes one inside", () => {
    const raw = (to: [number, number]) => ({
      format: "atlas-anim@1",
      name: "limits",
      canvas: { width: 100, height: 100, originX: 50, originY: 50 },
      bones: [
        { name: "root" },
        { name: "raise", parent: "root", length: 20, limits: { min: -15, max: 105 } },
        { name: "elbow", parent: "raise", x: 20, length: 20, limits: { min: 0, max: 70 } }
      ],
      poseLimits: [{ name: "reach", x: "raise", y: "elbow", polygon: [[-15, 0], [105, 0], [105, 10], [60, 70], [-15, 70]] }],
      animations: {
        swing: { duration: 1, loop: false, bones: { raise: { rotate: [{ time: 0, value: 0 }, { time: 1, value: to[0] }] }, elbow: { rotate: [{ time: 0, value: 0 }, { time: 1, value: to[1] }] } } }
      }
    });
    expect(parseAnimDocument(raw([90, 30])).ok).toBe(true);
    const issues = (to: [number, number]) => {
      const out: ValidationIssue[] = [];
      checkPoseLimits(loadAnimDocument(raw(to)), out);
      return out;
    };
    expect(issues([90, 20])).toHaveLength(0);
    const bad = issues([100, 60]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toMatch(/outside pose limit 'reach'/);
    // An unknown driver bone is a reference error.
    const unknown = parseAnimDocument({ ...raw([0, 0]), poseLimits: [{ name: "x", x: "nope", y: "elbow", polygon: [[0, 0], [1, 0], [0, 1]] }] });
    expect(unknown.ok).toBe(false);
  });

  it("a combined limit (b): y plus its 'plus' drivers, in the shrink, the live check and the validator", () => {
    // The lean limit: neck + head may not lean below -5 once the arm is past 60 (a keep line along the x axis).
    const lean: PoseLimit = { name: "lean", x: "raise", y: "neck", plus: ["head"], polygon: [[-15, -25], [60, -25], [105, -5], [105, 25], [-15, 25]], source: "declared" };
    expect(insideLimits([lean], { raise: 105, neck: -5, head: -5 })).toBe(false); // sum -10 (floor -5 at 105)
    expect(insideLimits([lean], { raise: 90, neck: -5, head: -3 })).toBe(true);
    expect(insideLimits([lean], { raise: 0, neck: -10, head: -15 })).toBe(true);
    // The projection keeps the lean one way: both drivers scale to the projected total.
    const legal = nearestLegalPose([lean], { raise: 105, neck: -10, head: -15 });
    expect(legal.head).toBeLessThan(0);
    expect(legal.neck).toBeLessThanOrEqual(0);
    expect(insideLimits([lean], legal)).toBe(true);
    expect(limitPoint(lean, { raise: 1, neck: 2, head: 3 })).toEqual([1, 5]);
    // Several keep points: the cut keeps the whole x axis.
    const free: Pt[] = [];
    const blocked: Pt[] = [];
    for (let x = -15; x <= 105; x += 5) for (let y = -25; y <= 25; y += 5) (x >= 55 && y <= -5 ? blocked : free).push([x, y]);
    const poly = shrinkToFree([[-15, -25], [105, -25], [105, 25], [-15, 25]], free, blocked, 2.5, [[0, 0], [-15, 0], [105, 0]], 360);
    for (const k of [[-15, 0], [105, 0]] as Pt[]) expect(convexOutside(poly, k)).toBeLessThanOrEqual(1e-6);
    for (const b of blocked) expect(convexOutside(poly, b)).toBeGreaterThan(2.4);
    const raw = (neck: number, head: number) => ({
      format: "atlas-anim@1",
      name: "lean",
      canvas: { width: 100, height: 100, originX: 50, originY: 50 },
      bones: [
        { name: "root" },
        { name: "raise", parent: "root", length: 20, limits: { min: -15, max: 105 } },
        { name: "neck", parent: "root", length: 10, limits: { min: -10, max: 10 } },
        { name: "head", parent: "neck", x: 10, length: 10, limits: { min: -15, max: 15 } }
      ],
      poseLimits: [{ name: "lean", x: "raise", y: "neck", plus: ["head"], polygon: lean.polygon }],
      animations: { tilt: { duration: 1, loop: false, bones: { raise: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 105 }] }, neck: { rotate: [{ time: 0, value: 0 }, { time: 1, value: neck }] }, head: { rotate: [{ time: 0, value: 0 }, { time: 1, value: head }] } } } }
    });
    const issues = (neck: number, head: number) => {
      const out: ValidationIssue[] = [];
      checkPoseLimits(loadAnimDocument(raw(neck, head)), out);
      return out;
    };
    expect(issues(-2, -2)).toHaveLength(0);
    expect(issues(-5, -5)[0]?.message).toMatch(/outside pose limit 'lean'/);
    expect(parseAnimDocument({ ...raw(0, 0), poseLimits: [{ name: "x", x: "raise", y: "neck", plus: ["nope"], polygon: [[0, 0], [1, 0], [0, 1]] }] }).ok).toBe(false);
  });

  it("a combined limit admits only same-side splits: counter-leans are outside everywhere", () => {
    const lean: PoseLimit = { name: "lean", x: "raise", y: "neck", plus: ["head"], polygon: [[-15, -25], [105, -25], [105, 25], [-15, 25]], source: "declared" };
    // neck +10 / head -10 keeps a "neutral" sum but moves the head sideways: never sampled, so outside.
    expect(insideLimits([lean], { raise: 90, neck: 10, head: -10 })).toBe(false);
    expect(insideLimits([lean], { raise: 90, neck: -10, head: 10 })).toBe(false);
    expect(insideLimits([lean], { raise: 90, neck: 6, head: -2 })).toBe(false);
    expect(insideLimits([lean], { raise: 90, neck: 6, head: 0 })).toBe(true);
    expect(insideLimits([lean], { raise: 90, neck: 0, head: 0 })).toBe(true);
    const doc = (neck: number, head: number) =>
      loadAnimDocument({
        format: "atlas-anim@1",
        name: "lean",
        canvas: { width: 100, height: 100, originX: 50, originY: 50 },
        bones: [
          { name: "root" },
          { name: "raise", parent: "root", length: 20, limits: { min: -15, max: 105 } },
          { name: "neck", parent: "root", length: 10, limits: { min: -10, max: 10 } },
          { name: "head", parent: "neck", x: 10, length: 10, limits: { min: -15, max: 15 } }
        ],
        poseLimits: [{ name: "lean", x: "raise", y: "neck", plus: ["head"], polygon: lean.polygon }],
        animations: { tilt: { duration: 1, loop: false, bones: { raise: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 90 }] }, neck: { rotate: [{ time: 0, value: 0 }, { time: 1, value: neck }] }, head: { rotate: [{ time: 0, value: 0 }, { time: 1, value: head }] } } } }
      });
    const errors = (neck: number, head: number) => {
      const out: ValidationIssue[] = [];
      checkPoseLimits(doc(neck, head), out);
      return out.filter((i) => i.check === "limits").length;
    };
    expect(errors(10, -10)).toBe(1);
    expect(errors(6, 4)).toBe(0);
    // Live authoring flags it too, and its nearest legal pose is a same-side split.
    const live = sampleClip(doc(10, -10), "tilt", [1]);
    expect(live[0]?.outside).toEqual(["lean"]);
    const legal = nearestLegalPose([lean], { raise: 90, neck: 10, head: -10 });
    expect(insideLimits([lean], legal)).toBe(true);
  });
});
