import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "./format.js";
import { RAD_TO_DEG, wrapDegrees, type Affine2 } from "./math.js";
import { Skeleton } from "./skeleton.js";
import { expectAffine, testDocument, testSkeleton } from "./testHelpers.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;
type TransformInput = NonNullable<Sections["transform"]>[number];
type BoneInput = Sections["bones"][number];

const NO_MIX = { mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 };

/**
 * A target under a rotated parent (with scale and shear of its own) and a constrained bone under a
 * different parent, so world and local values all differ.
 */
function rig(constraint: Partial<TransformInput> = {}, bone: Partial<BoneInput> = {}, target: Partial<BoneInput> = {}): Skeleton {
  return testSkeleton({
    bones: [
      { name: "root" },
      { name: "tparent", parent: "root", x: 40, y: -10, rotation: 20 },
      { name: "target", parent: "tparent", x: 30, y: 5, rotation: 50, scaleX: 1.5, scaleY: 0.8, shearY: 10, length: 20, ...target },
      { name: "bparent", parent: "root", x: -20, y: 30, rotation: -35, scaleX: 1.2, scaleY: 1.2 },
      { name: "bone", parent: "bparent", x: 10, y: 0, rotation: 15, scaleX: 0.9, length: 20, ...bone },
      { name: "child", parent: "bone", x: 20 }
    ],
    transform: [{ name: "follow", bones: ["bone"], target: "target", ...constraint }]
  });
}

const angleX = (w: Affine2) => Math.atan2(w.c, w.a) * RAD_TO_DEG;
const shearAngle = (w: Affine2) => wrapDegrees((Math.atan2(w.d, w.b) - Math.atan2(w.c, w.a)) * RAD_TO_DEG);

describe("transform constraint, world absolute", () => {
  it("at mix 1 the bone takes the target's world transform; at mix 0 it is unchanged", () => {
    const skeleton = rig();
    expectAffine(skeleton.getBone("bone").world, skeleton.getBone("target").world);
    // Children follow the constrained pose.
    const child = skeleton.getBone("child").world;
    const expected = skeleton.getBone("target").localToWorld(20, 0, { x: 0, y: 0 });
    expectAffine(child, expected);

    const free = rig(NO_MIX);
    const fk = new Skeleton(testDocument({ bones: [...free.document.bones] }));
    fk.updateWorldTransform();
    expectAffine(free.getBone("bone").world, fk.getBone("bone").world);
  });

  it("each channel mixes on its own (rotation the short way)", () => {
    const fk = rig(NO_MIX);
    const fkWorld = { ...fk.getBone("bone").world };
    const t = fk.getBone("target").world;

    const rotate = rig({ ...NO_MIX, mixRotate: 0.5 }).getBone("bone").world;
    expect(angleX(rotate)).toBeCloseTo(angleX(fkWorld) + wrapDegrees(angleX(t) - angleX(fkWorld)) / 2, 9);
    expect(Math.hypot(rotate.a, rotate.c)).toBeCloseTo(Math.hypot(fkWorld.a, fkWorld.c), 12);
    expect([rotate.x, rotate.y]).toEqual([fkWorld.x, fkWorld.y]);

    const move = rig({ ...NO_MIX, mixX: 0.25, mixY: 1 }).getBone("bone").world;
    expect(move.x).toBeCloseTo(fkWorld.x + (t.x - fkWorld.x) * 0.25, 9);
    expect(move.y).toBeCloseTo(t.y, 9);
    expect(move.a).toBeCloseTo(fkWorld.a, 12);

    const scale = rig({ ...NO_MIX, mixScaleX: 0.5, mixScaleY: 1 }).getBone("bone").world;
    const fkSx = Math.hypot(fkWorld.a, fkWorld.c);
    expect(Math.hypot(scale.a, scale.c)).toBeCloseTo(fkSx + (Math.hypot(t.a, t.c) - fkSx) / 2, 9);
    expect(Math.hypot(scale.b, scale.d)).toBeCloseTo(Math.hypot(t.b, t.d), 9);
    expect(angleX(scale)).toBeCloseTo(angleX(fkWorld), 9);

    const shear = rig({ ...NO_MIX, mixShearY: 1 }).getBone("bone").world;
    expect(shearAngle(shear)).toBeCloseTo(shearAngle(t), 9);
    expect(angleX(shear)).toBeCloseTo(angleX(fkWorld), 9);
  });

  it("turns the short way across 180 degrees", () => {
    // World angles: target 170, bone -170; half way is 180, not 0.
    const skeleton = testSkeleton({
      bones: [
        { name: "root" },
        { name: "target", parent: "root", rotation: 170 },
        { name: "bone", parent: "root", rotation: -170 }
      ],
      transform: [{ name: "t", bones: ["bone"], target: "target", ...NO_MIX, mixRotate: 0.5 }]
    });
    expect(Math.abs(skeleton.getBone("bone").worldRotationX)).toBeCloseTo(180, 9);
  });

  it("offsets: rotation adds to the target's angle, translation is a point in the target's space", () => {
    const skeleton = rig({ offset: { rotation: 30, x: 10, y: -5, scaleX: 0.5, scaleY: 0, shearY: 0 } });
    const t = skeleton.getBone("target");
    const w = skeleton.getBone("bone").world;
    expect(wrapDegrees(angleX(w) - angleX(t.world))).toBeCloseTo(30, 9);
    expectAffine(w, t.localToWorld(10, -5, { x: 0, y: 0 }));
    expect(Math.hypot(w.a, w.c)).toBeCloseTo(Math.hypot(t.world.a, t.world.c) + 0.5, 9);
  });

  it("a mirrored target turns rotation offsets the other way", () => {
    const skeleton = rig({ offset: { rotation: 30, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 }, mixShearY: 0, mixScaleY: 0, mixScaleX: 0 }, {}, { scaleY: -0.8 });
    const t = skeleton.getBone("target").world;
    expect(t.a * t.d - t.b * t.c).toBeLessThan(0);
    expect(wrapDegrees(angleX(skeleton.getBone("bone").world) - angleX(t))).toBeCloseTo(-30, 9);
  });

  it("moves a chain: a listed child is rebuilt from its moved parent before it is constrained", () => {
    const skeleton = testSkeleton({
      bones: [
        { name: "root" },
        { name: "target", parent: "root", rotation: 90 },
        { name: "a", parent: "root", x: 50, length: 30 },
        { name: "b", parent: "a", x: 30, rotation: 10 }
      ],
      transform: [{ name: "t", bones: ["a", "b"], target: "target", ...NO_MIX, mixRotate: 1 }]
    });
    // a turns to 90 degrees, so b's origin is 30 px below a's; b also turns to 90.
    expectAffine(skeleton.getBone("b").world, { x: 50, y: 30 });
    expect(skeleton.getBone("b").worldRotationX).toBeCloseTo(90, 9);
  });

  it("holds the bone's rotation limits (enforceLimits)", () => {
    const skeleton = rig({ ...NO_MIX, mixRotate: 1 }, { limits: { min: -5, max: 5 } });
    const bone = skeleton.getBone("bone");
    expect(bone.applied.rotation - 15).toBeGreaterThanOrEqual(-5 - 1e-9);
    expect(bone.applied.rotation - 15).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.abs(bone.applied.rotation - 15)).toBeCloseTo(5, 9); // the target is far outside
    const world = { ...bone.world };
    bone.updateWorldTransform();
    expectAffine(bone.world, world);
  });
});

describe("transform constraint, world relative", () => {
  it("adds the target's world rotation and skeleton-space position, independent of where the skeleton is", () => {
    const fk = rig(NO_MIX);
    const fkWorld = { ...fk.getBone("bone").world };
    const t = fk.getBone("target").world;
    const skeleton = rig({ relative: true, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 });
    const w = skeleton.getBone("bone").world;
    expect(wrapDegrees(angleX(w) - angleX(fkWorld))).toBeCloseTo(wrapDegrees(angleX(t)), 9);
    expect(w.x).toBeCloseTo(fkWorld.x + t.x, 9);
    expect(w.y).toBeCloseTo(fkWorld.y + t.y, 9);

    skeleton.x = 500;
    skeleton.y = -200;
    skeleton.updateWorldTransform();
    expect(skeleton.getBone("bone").world.x - 500).toBeCloseTo(fkWorld.x + t.x, 9);
    expect(skeleton.getBone("bone").world.y + 200).toBeCloseTo(fkWorld.y + t.y, 9);
  });

  it("scales by the target's axis lengths and shears by the target's shear", () => {
    const fk = rig(NO_MIX);
    const fkWorld = { ...fk.getBone("bone").world };
    const t = fk.getBone("target").world;
    const w = rig({ relative: true, mixRotate: 0, mixX: 0, mixY: 0 }).getBone("bone").world;
    expect(Math.hypot(w.a, w.c)).toBeCloseTo(Math.hypot(fkWorld.a, fkWorld.c) * Math.hypot(t.a, t.c), 9);
    expect(Math.hypot(w.b, w.d)).toBeCloseTo(Math.hypot(fkWorld.b, fkWorld.d) * Math.hypot(t.b, t.d), 9);
    expect(shearAngle(w)).toBeCloseTo(shearAngle(fkWorld) + shearAngle(t) - 90, 9);
  });
});

describe("transform constraint, local", () => {
  it("absolute: the bone's local channels take the target's, plus offsets", () => {
    const skeleton = rig({ local: true, offset: { rotation: 5, x: 1, y: 2, scaleX: 0.1, scaleY: 0, shearY: 0 } });
    const t = skeleton.getBone("target").applied;
    const a = skeleton.getBone("bone").applied;
    expect(a.rotation).toBeCloseTo(t.rotation + 5, 9);
    expect([a.x, a.y]).toEqual([t.x + 1, t.y + 2]);
    expect(a.scaleX).toBeCloseTo(t.scaleX + 0.1, 12);
    expect(a.scaleY).toBeCloseTo(t.scaleY, 12);
    expect(a.shearY).toBeCloseTo(t.shearY, 12);
    // The world is rebuilt from those local values under the bone's own parent.
    const check = new Skeleton(testDocument({ bones: [...skeleton.document.bones] }));
    Object.assign(check.getBone("bone").pose, a);
    check.updateWorldTransform();
    expectAffine(skeleton.getBone("bone").world, check.getBone("bone").world);
  });

  it("absolute at mix 0.5 lands half way; rotation the short way", () => {
    const skeleton = rig({ local: true, mixRotate: 0.5, mixX: 0.5, mixY: 0.5, mixScaleX: 0.5, mixScaleY: 0.5, mixShearY: 0.5 }, { rotation: -170 }, { rotation: 170 });
    const a = skeleton.getBone("bone").applied;
    expect(Math.abs(wrapDegrees(a.rotation))).toBeCloseTo(180, 9);
    expect(a.x).toBeCloseTo((10 + 30) / 2, 12);
    expect(a.scaleX).toBeCloseTo((0.9 + 1.5) / 2, 12);
    expect(a.shearY).toBeCloseTo(5, 12);
  });

  it("relative: the target's local channels are added (scale multiplies)", () => {
    const skeleton = rig({ local: true, relative: true });
    const a = skeleton.getBone("bone").applied;
    expect(a.rotation).toBeCloseTo(15 + 50, 9);
    expect([a.x, a.y]).toEqual([10 + 30, 0 + 5]);
    expect(a.scaleX).toBeCloseTo(0.9 * 1.5, 12);
    expect(a.scaleY).toBeCloseTo(0.8, 12);
    expect(a.shearY).toBeCloseTo(10, 12);
  });

  it("local modes hold the rotation limits", () => {
    const skeleton = rig({ local: true, relative: true }, { limits: { min: -20, max: 20 } });
    expect(skeleton.getBone("bone").applied.rotation).toBeCloseTo(15 + 20, 9);
  });
});

describe("constraint order with real solvers", () => {
  it("an order -1 transform places the IK target before the IK reads it", () => {
    const doc = (order?: number) =>
      testSkeleton({
        bones: [
          { name: "root" },
          { name: "driver", parent: "root", x: 60, y: 60 },
          { name: "target", parent: "root", x: 200, y: 0 },
          { name: "upper", parent: "root", length: 50 },
          { name: "lower", parent: "upper", x: 50, length: 50 }
        ],
        ik: [{ name: "arm", bones: ["upper", "lower"], target: "target" }],
        transform: [{ name: "place", bones: ["target"], target: "driver", ...NO_MIX, mixX: 1, mixY: 1, ...(order === undefined ? {} : { order }) }]
      });
    const tipOf = (s: Skeleton) => s.getBone("lower").localToWorld(50, 0, { x: 0, y: 0 });
    const placed = doc(-1);
    expect(tipOf(placed).x).toBeCloseTo(60, 6);
    expect(tipOf(placed).y).toBeCloseTo(60, 6);
    // Default order runs IK first: it chases the stale target (out of reach: chain straight along +x).
    const stale = doc();
    expect(tipOf(stale).x).toBeCloseTo(100, 6);
    expect(stale.getBone("target").world.x).toBeCloseTo(60, 9);
  });
});
