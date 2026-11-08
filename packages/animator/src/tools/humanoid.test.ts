import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import {
  bonesFromSpecs,
  fitHumanoid,
  FitError,
  humanoidBoneSpecs,
  humanoidIk
} from "./humanoid.js";
import { alphaMask, createImage } from "./image.js";
import { largestComponent } from "./outline.js";
import { readPng } from "./png.js";
import { LIVE_TEMPLATE_PATH, syntheticFigure } from "./testFigures.js";

const near = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);

describe("humanoid fit", () => {
  it("finds the landmarks of a synthetic A-pose figure", () => {
    const figure = syntheticFigure();
    const landmarks = fitHumanoid(alphaMask(figure));
    near(landmarks.centerX, 200, 1);
    near(landmarks.topY, 25, 1);
    expect(landmarks.neckY).toBeGreaterThanOrEqual(213);
    expect(landmarks.neckY).toBeLessThanOrEqual(240);
    near(landmarks.shoulderTopY, 236, 2);
    near(landmarks.crotch.y, 420, 3);
    near(landmarks.origin.y, 576, 2);
    // Arms hang outward and down; the right arm mirrors the left.
    for (const side of ["l", "r"] as const) {
      const arm = landmarks.arms[side];
      const sign = side === "l" ? -1 : 1;
      expect(sign * (arm.tip.x - arm.root.x)).toBeGreaterThan(30);
      expect(arm.tip.y).toBeGreaterThan(arm.end.y);
      expect(arm.end.y).toBeGreaterThan(arm.middle.y);
      expect(arm.middle.y).toBeGreaterThan(arm.root.y);
      near(arm.radius, 22, 6);
      const leg = landmarks.legs[side];
      expect(leg.root.y).toBeLessThan(landmarks.crotch.y);
      expect(leg.end.y).toBeGreaterThan(leg.middle.y);
      near(leg.tip.y, 575, 3);
      near(leg.radius, 24, 5);
    }
    near(landmarks.arms.l.root.x + landmarks.arms.r.root.x, 400, 2);
    near(landmarks.legs.l.root.x + landmarks.legs.r.root.x, 400, 2);
  });

  it("rejects figures without the A-pose landmarks", () => {
    const empty = createImage(50, 50);
    expect(() => fitHumanoid(alphaMask(empty))).toThrow(FitError);
    const blob = createImage(100, 100);
    for (let i = 0; i < blob.data.length; i += 4) blob.data[i + 3] = 255;
    expect(() => fitHumanoid(alphaMask(blob))).toThrow(FitError);
  });

  it("builds a 24-bone skeleton whose setup pose puts every bone at its canvas joints", () => {
    const landmarks = fitHumanoid(alphaMask(syntheticFigure()));
    const specs = humanoidBoneSpecs(landmarks);
    expect(specs).toHaveLength(24);
    const doc = loadAnimDocument({
      format: "atlas-anim@1",
      name: "fit",
      canvas: { width: 400, height: 600, originX: landmarks.origin.x, originY: landmarks.origin.y },
      bones: bonesFromSpecs(specs, landmarks.origin),
      ik: humanoidIk()
    });
    const skeleton = new Skeleton(doc);
    skeleton.x = landmarks.origin.x;
    skeleton.y = landmarks.origin.y;
    skeleton.updateWorldTransform();
    for (const spec of specs) {
      const bone = skeleton.getBone(spec.name);
      near(bone.world.x, spec.start.x, 1e-2);
      near(bone.world.y, spec.start.y, 1e-2);
      if (spec.parent === null) continue;
      const length = bone.data.length;
      near(bone.world.x + bone.world.a * length, spec.end.x, 1e-2);
      near(bone.world.y + bone.world.c * length, spec.end.y, 1e-2);
    }
  });

  it("fits the live body template close to the pivots approved for AtlasRig", () => {
    const template = readPng(LIVE_TEMPLATE_PATH);
    expect([template.width, template.height]).toEqual([1086, 1448]);
    const landmarks = fitHumanoid(largestComponent(alphaMask(template)) ?? alphaMask(template));
    // AtlasRig (feature/atlas-rig--from-t1502, seed_live_rig.py): right shoulder centre
    // (684, 742) (the ball-and-socket pivot, 4c), hip (607, 990), knee (622, 1105); left mirrors.
    near(landmarks.centerX, 543, 2);
    near(landmarks.arms.r.root.x, 684, 12);
    near(landmarks.arms.r.root.y, 742, 12);
    near(landmarks.arms.l.root.x, 1086 - 684, 12);
    near(landmarks.legs.r.root.x, 607, 12);
    near(landmarks.legs.r.root.y, 990, 12);
    near(landmarks.legs.r.middle.y, 1105, 25);
  });
});

