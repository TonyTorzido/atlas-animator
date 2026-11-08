import { describe, expect, it } from "vitest";
import type { Bone } from "./bone.js";
import { INHERIT_MODES, type InheritMode } from "./format.js";
import { copyLocalTransform, createAffine, type LocalTransform } from "./math.js";
import type { Skeleton } from "./skeleton.js";
import { COS30, SQRT1_2, expectAffine, random, testSkeleton } from "./testHelpers.js";

type BoneInput = { name: string; parent?: string; inherit?: InheritMode } & Partial<LocalTransform> & {
  limits?: { min: number; max: number };
};

/** Root posed as given, plus one child posed as given; returns the child after a world update. */
function child(root: Partial<LocalTransform>, bone: Omit<BoneInput, "name" | "parent">): Bone {
  return testSkeleton({ bones: [{ name: "root", ...root }, { name: "child", parent: "root", ...bone }] }).getBone("child");
}

describe("root bone", () => {
  it("places the root in skeleton space offset by the skeleton position", () => {
    const skeleton = testSkeleton({ bones: [{ name: "root", x: 10, y: 20, rotation: 90, scaleX: 2, scaleY: 3 }] });
    skeleton.x = 100;
    skeleton.y = 50;
    skeleton.updateWorldTransform();
    // X axis: 2 * (cos 90, sin 90) = (0, 2); Y axis: 3 * (cos 180, sin 180) = (-3, 0).
    expectAffine(skeleton.getBone("root").world, { a: 0, c: 2, b: -3, d: 0, x: 110, y: 70 });
  });

  it("chains positions through parents", () => {
    const skeleton = testSkeleton({
      bones: [
        { name: "root", rotation: 90 },
        { name: "upper", parent: "root", x: 10, rotation: -90 },
        { name: "lower", parent: "upper", x: 5 }
      ]
    });
    // upper sits at R(90)(10, 0) = (0, 10) and points along +x again; lower is 5 further along x.
    expectAffine(skeleton.getBone("upper").world, { a: 1, b: 0, c: 0, d: 1, x: 0, y: 10 });
    expectAffine(skeleton.getBone("lower").world, { a: 1, b: 0, c: 0, d: 1, x: 5, y: 10 });
  });
});

describe("inherit modes against hand-computed matrices", () => {
  // Parent used by several cases: rotation 90, scale (2, 1) => P = [0 -1; 2 0].
  const turnedParent = { rotation: 90, scaleX: 2 };

  it("normal: W = P * L", () => {
    // P * R(90) = [0 -1; 2 0][0 -1; 1 0] = [-1 0; 0 -2]; position P * (10, 0) = (0, 20).
    expectAffine(child(turnedParent, { x: 10, rotation: 90 }).world, { a: -1, b: 0, c: 0, d: -2, x: 0, y: 20 });
  });

  it("onlyTranslation: position from the parent, linear part is L alone", () => {
    expectAffine(child(turnedParent, { x: 10, rotation: 30, inherit: "onlyTranslation" }).world, {
      a: COS30,
      b: -0.5,
      c: 0.5,
      d: COS30,
      x: 0,
      y: 20
    });
  });

  describe("noRotation", () => {
    // Parent rotation 90, scale (2, 3): P = [0 -3; 2 0]. Its X axis points down (phi = 90) with
    // length 2, and |det P| / 2 = 3, so E = R(90) diag(2, 3) R(-90) = diag(3, 2).
    const parent = { rotation: 90, scaleX: 2, scaleY: 3 };

    it("keeps the parent's stretch along the parent's axes but not its rotation", () => {
      expectAffine(child(parent, { x: 5, inherit: "noRotation" }).world, { a: 3, b: 0, c: 0, d: 2, x: 0, y: 10 });
    });

    it("applies the child's own rotation inside the stretch", () => {
      // diag(3, 2) * R(90) = [0 -3; 2 0]
      expectAffine(child(parent, { rotation: 90, inherit: "noRotation" }).world, { a: 0, b: -3, c: 2, d: 0 });
    });

    it("drops the parent's reflection", () => {
      // P = diag(-2, 3): X axis points left (phi = 180) with length 2, |det| / 2 = 3,
      // E = R(180) diag(2, 3) R(-180) = diag(2, 3). E * R(30) = [2cos30 -1; 1.5 3cos30].
      expectAffine(child({ scaleX: -2, scaleY: 3 }, { rotation: 30, inherit: "noRotation" }).world, {
        a: 2 * COS30,
        b: -1,
        c: 1.5,
        d: 3 * COS30
      });
    });
  });

  describe("noScale", () => {
    it("adds rotations and drops a uniform parent scale", () => {
      // Parent R(30) scaled 2: the child's 15 degrees map to a world direction of 45 degrees.
      expectAffine(child({ rotation: 30, scaleX: 2, scaleY: 2 }, { rotation: 15, inherit: "noScale" }).world, {
        a: SQRT1_2,
        b: -SQRT1_2,
        c: SQRT1_2,
        d: SQRT1_2
      });
    });

    it("applies the child's own scale after the frame", () => {
      // R(45) * diag(1.5, 0.5)
      expectAffine(
        child({ rotation: 30, scaleX: 2, scaleY: 2 }, { rotation: 15, scaleX: 1.5, scaleY: 0.5, inherit: "noScale" }).world,
        { a: 1.5 * SQRT1_2, b: -0.5 * SQRT1_2, c: 1.5 * SQRT1_2, d: 0.5 * SQRT1_2 }
      );
    });

    it("follows the parent-mapped direction under non-uniform parent scale", () => {
      // Parent diag(2, 1) maps (cos45, sin45) to a direction with tan = 1/2.
      const s5 = Math.sqrt(5);
      expectAffine(child({ scaleX: 2 }, { rotation: 45, inherit: "noScale" }).world, {
        a: 2 / s5,
        b: -1 / s5,
        c: 1 / s5,
        d: 2 / s5
      });
    });

    it("keeps the position scaled by the parent", () => {
      expectAffine(child({ scaleX: 3, scaleY: 3 }, { x: 10, inherit: "noScale" }).world, { a: 1, b: 0, c: 0, d: 1, x: 30, y: 0 });
    });

    it("keeps a mirrored parent's reflection", () => {
      // Parent diag(-1, 1), child 30: X axis (-cos30, sin30), Y axis mirrored (sin30, cos30).
      expectAffine(child({ scaleX: -1 }, { rotation: 30, inherit: "noScale" }).world, {
        a: -COS30,
        b: 0.5,
        c: 0.5,
        d: COS30
      });
    });
  });

  it("noScaleOrReflection: same direction as noScale but a proper rotation (R(150))", () => {
    const world = child({ scaleX: -1 }, { rotation: 30, inherit: "noScaleOrReflection" }).world;
    expectAffine(world, { a: -COS30, b: -0.5, c: 0.5, d: -COS30 });
    expect(world.a * world.d - world.b * world.c).toBeCloseTo(1, 12);
  });

  it("modes agree with normal when the parent is a pure rotation", () => {
    // With P = R(40) there is nothing to drop except rotation, so normal/noScale/noScaleOrReflection
    // are identical, while noRotation and onlyTranslation both ignore the parent's 40 degrees.
    const pose = { x: 3, y: -2, rotation: 25, scaleX: 1.3, scaleY: 0.7, shearY: 10 };
    const normal = child({ rotation: 40 }, pose).world;
    for (const inherit of ["noScale", "noScaleOrReflection"] as const) {
      expectAffine(child({ rotation: 40 }, { ...pose, inherit }).world, normal);
    }
    const only = child({ rotation: 40 }, { ...pose, inherit: "onlyTranslation" }).world;
    expectAffine(child({ rotation: 40 }, { ...pose, inherit: "noRotation" }).world, only);
  });
});

describe("rotation limits", () => {
  const limited = () =>
    testSkeleton({
      bones: [
        { name: "root" },
        { name: "arm", parent: "root", rotation: 10, limits: { min: -20, max: 40 } }
      ]
    });

  it("clamps the posed rotation relative to setup before building the world matrix", () => {
    const skeleton = limited();
    const arm = skeleton.getBone("arm");
    arm.pose.rotation = 100;
    skeleton.updateWorldTransform();
    expect(arm.applied.rotation).toBe(50);
    expect(arm.worldRotationX).toBeCloseTo(50, 12);
    expect(arm.pose.rotation).toBe(100); // the animated value itself is left alone

    arm.pose.rotation = -90;
    skeleton.updateWorldTransform();
    expect(arm.applied.rotation).toBe(-10);
  });

  it("leaves rotations inside the limits alone", () => {
    const skeleton = limited();
    const arm = skeleton.getBone("arm");
    arm.pose.rotation = 33;
    skeleton.updateWorldTransform();
    expect(arm.applied.rotation).toBe(33);
  });

  it("also clamps values written by constraints", () => {
    const arm = limited().getBone("arm");
    arm.updateWorldTransformWith(0, 0, 400, 1, 1, 0, 0); // 400 = 40 = setup + 30: inside
    expect(arm.applied.rotation).toBe(400);
    arm.updateWorldTransformWith(0, 0, 300, 1, 1, 0, 0); // 300 = -60 = setup - 70: past min
    expect(arm.applied.rotation).toBe(-10);
  });
});

describe("world to local decomposition (updateAppliedTransform)", () => {
  const next = random(7);
  const sign = () => (next(0, 1) < 0.5 ? -1 : 1);

  function randomParent(): Partial<LocalTransform> {
    return {
      x: next(-50, 50),
      y: next(-50, 50),
      rotation: next(-180, 180),
      scaleX: sign() * next(0.3, 3),
      scaleY: sign() * next(0.3, 3),
      shearX: next(-30, 30),
      shearY: next(-30, 30)
    };
  }

  function rebuild(root: Partial<LocalTransform>, pose: Partial<LocalTransform>, inherit: InheritMode): Skeleton {
    return testSkeleton({ bones: [{ name: "root", ...root }, { name: "child", parent: "root", inherit, ...pose }] });
  }

  for (const inherit of INHERIT_MODES) {
    it(`${inherit}: decompose(compose(x)) == x for canonical local transforms`, () => {
      for (let i = 0; i < 200; i++) {
        const pose: LocalTransform = {
          x: next(-100, 100),
          y: next(-100, 100),
          rotation: next(-179.9, 180),
          scaleX: next(0.2, 3),
          scaleY: sign() * next(0.2, 3),
          shearX: 0,
          shearY: next(-80, 80)
        };
        const bone = rebuild(randomParent(), pose, inherit).getBone("child");
        copyLocalTransform({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }, bone.applied);
        bone.updateAppliedTransform();
        for (const key of ["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"] as const) {
          expect(bone.applied[key], `${inherit} ${key} (case ${i})`).toBeCloseTo(pose[key], 7);
        }
      }
    });

    it(`${inherit}: compose(decompose(W)) == W for any local transform`, () => {
      for (let i = 0; i < 200; i++) {
        const pose = {
          x: next(-100, 100),
          y: next(-100, 100),
          rotation: next(-720, 720),
          scaleX: sign() * next(0.2, 3),
          scaleY: sign() * next(0.2, 3),
          shearX: next(-60, 60),
          shearY: next(-60, 60)
        };
        const bone = rebuild(randomParent(), pose, inherit).getBone("child");
        const expected = { ...bone.world };
        bone.updateAppliedTransform();
        bone.updateWorldTransform();
        expectAffine(bone.world, expected, 7);
      }
    });
  }

  it("root: recovers position relative to the skeleton origin", () => {
    const skeleton = testSkeleton({ bones: [{ name: "root", x: 4, y: -6, rotation: 120, scaleX: 2 }] });
    skeleton.x = 30;
    skeleton.y = 40;
    skeleton.updateWorldTransform();
    const root = skeleton.getBone("root");
    root.updateAppliedTransform();
    expect(root.applied.x).toBeCloseTo(4, 12);
    expect(root.applied.y).toBeCloseTo(-6, 12);
    expect(root.applied.rotation).toBeCloseTo(120, 12);
    expect(root.applied.scaleX).toBeCloseTo(2, 12);
  });

  it("keeps the previous values when the parent is singular", () => {
    const bone = child({ scaleX: 0, scaleY: 0 }, { x: 5, rotation: 20 });
    bone.updateAppliedTransform();
    expect(bone.applied).toMatchObject({ x: 5, rotation: 20 });
  });
});

describe("bone helpers", () => {
  it("maps points between world and bone space", () => {
    const bone = child({ rotation: 90, scaleX: 2 }, { x: 10, rotation: 90 }); // W = [-1 0; 0 -2] at (0, 20)
    const p = bone.localToWorld(3, 4, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(-3, 12);
    expect(p.y).toBeCloseTo(12, 12);
    const back = { x: 0, y: 0 };
    expect(bone.worldToLocal(p.x, p.y, back)).toBe(true);
    expect(back.x).toBeCloseTo(3, 12);
    expect(back.y).toBeCloseTo(4, 12);
    // In the parent's space the bone's own world origin is its (x, y).
    expect(bone.worldToParent(bone.world.x, bone.world.y, back)).toBe(true);
    expect(back.x).toBeCloseTo(10, 12);
    expect(back.y).toBeCloseTo(0, 12);
  });

  it("reports world rotation and scale", () => {
    const bone = child({ rotation: 30, scaleX: 2, scaleY: 2 }, { rotation: 15, scaleX: 1.5 });
    expect(bone.worldRotationX).toBeCloseTo(45, 12);
    expect(bone.worldRotationY).toBeCloseTo(135, 12);
    expect(bone.worldScaleX).toBeCloseTo(3, 12);
    expect(bone.worldScaleY).toBeCloseTo(2, 12);
  });

  it("rotates in world space, and the applied rotation follows after decomposition", () => {
    const bone = child({ rotation: 40, scaleX: 2, scaleY: 2 }, { x: 7, rotation: 20 });
    const position = { x: bone.world.x, y: bone.world.y };
    bone.rotateWorld(30);
    expect(bone.worldRotationX).toBeCloseTo(90, 12);
    expect(bone.world.x).toBe(position.x);
    expect(bone.world.y).toBe(position.y);
    bone.updateAppliedTransform();
    expect(bone.applied.rotation).toBeCloseTo(50, 9);
    expect(bone.applied.x).toBeCloseTo(7, 9);
  });

  it("starts from the setup pose and returns to it", () => {
    const bone = child({}, { x: 1, y: 2, rotation: 3, scaleX: 4, scaleY: 5, shearX: 6, shearY: 7 });
    expect(bone.pose).toEqual({ x: 1, y: 2, rotation: 3, scaleX: 4, scaleY: 5, shearX: 6, shearY: 7 });
    bone.pose.rotation = 99;
    bone.setToSetupPose();
    expect(bone.pose.rotation).toBe(3);
    expect(createAffine()).toEqual({ a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 });
  });
});

describe("Bone.enforceLimits", () => {
  const limited = () =>
    testSkeleton({ bones: [{ name: "root" }, { name: "b", parent: "root", rotation: -90, limits: { min: -120, max: 20 } }] }).getBone("b");

  it("re-reads applied from a world write and clamps outside the limits (world rebuilt)", () => {
    const bone = limited();
    bone.rotateWorld(10); // -80: 10 past setup, inside
    bone.enforceLimits();
    expect(bone.applied.rotation).toBeCloseTo(-80, 9);
    bone.rotateWorld(60); // -20: 70 past setup, outside, nearer the max (20)
    bone.enforceLimits();
    expect(bone.applied.rotation).toBeCloseTo(-70, 9);
    expect(bone.worldRotationX).toBeCloseTo(-70, 9);
  });

  it("writes an in-range full-turn equivalent so applied - setup stays within the limits", () => {
    const bone = limited();
    bone.rotateWorld(-110); // world -200 == 160; setup + (-110) is inside, 160 - (-90) = 250 is not
    bone.enforceLimits();
    expect(bone.applied.rotation - -90).toBeCloseTo(-110, 9);
    expect(bone.worldRotationX).toBeCloseTo(160, 9);
  });
});
