import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnimDocumentInput } from "./format.js";
import { loadAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import { expectAffine, random, testDocument, testSkeleton } from "./testHelpers.js";
import { planUpdateOrder, type OrderBone, type OrderConstraint, type UpdateStep } from "./updateOrder.js";

/** Compact form of an update list: "root", "ik:0", ... */
function describeSteps(skeleton: Skeleton): string[] {
  return skeleton.updateSteps.map((step) =>
    step.kind === "bone" ? (skeleton.bones[step.bone]?.data.name ?? "?") : `${step.kind}:${step.index}`
  );
}

/**
 * Checks the ordering rules independently of how the list was produced:
 * - only active bones appear, and every active bone appears;
 * - a bone is computed after the latest write to its parent, and the final write of a bone is
 *   not older than the final write of its parent;
 * - a constraint runs after its target and constrained bones were computed;
 * - every bone below a constrained bone (and not written by that constraint) is written again
 *   after the constraint.
 */
function checkOrderRules(
  bones: readonly OrderBone[],
  constraints: readonly OrderConstraint[],
  steps: readonly UpdateStep[],
  boneActive: readonly boolean[],
  constraintActive: readonly boolean[]
): void {
  const lastWrite = new Map<number, number>();
  const seen = new Set<number>();
  const isBelow = (bone: number, ancestor: number): boolean => {
    for (let b = bones[bone]?.parent ?? -1; b >= 0; b = bones[b]?.parent ?? -1) if (b === ancestor) return true;
    return false;
  };
  const constraintAt = (step: UpdateStep) => constraints.find((c) => c.kind === step.kind && c.index === (step as { index: number }).index);

  steps.forEach((step, k) => {
    if (step.kind === "bone") {
      expect(boneActive[step.bone], `bone ${step.bone} is active`).toBe(true);
      const parent = bones[step.bone]?.parent ?? -1;
      if (parent >= 0) expect(lastWrite.get(parent), `parent of bone ${step.bone} computed before step ${k}`).toBeLessThan(k);
      lastWrite.set(step.bone, k);
      seen.add(step.bone);
      return;
    }
    const constraint = constraintAt(step);
    expect(constraint, `constraint step ${k} exists`).toBeDefined();
    if (!constraint) return;
    expect(constraintActive[constraints.indexOf(constraint)]).toBe(true);
    if (constraint.target >= 0) expect(lastWrite.get(constraint.target), `target before step ${k}`).toBeLessThan(k);
    for (const bone of constraint.bones) {
      expect(lastWrite.get(bone), `constrained bone ${bone} before step ${k}`).toBeLessThan(k);
    }
    for (const bone of constraint.bones) lastWrite.set(bone, k);
    // Rule: descendants are rewritten after this constraint.
    bones.forEach((_, b) => {
      if (!boneActive[b] || constraint.bones.includes(b)) return;
      if (constraint.bones.some((c) => isBelow(b, c))) {
        const later = steps.slice(k + 1).some((s) => s.kind === "bone" && s.bone === b);
        expect(later, `bone ${b} below constrained bones is recomputed after step ${k}`).toBe(true);
      }
    });
  });

  boneActive.forEach((active, b) => expect(seen.has(b), `bone ${b} appears iff active`).toBe(active));
  for (const [bone, time] of lastWrite) {
    const parent = bones[bone]?.parent ?? -1;
    if (parent >= 0) expect(time, `final write of ${bone} not older than its parent's`).toBeGreaterThanOrEqual(lastWrite.get(parent) ?? -1);
  }
}

function checkSkeletonOrder(skeleton: Skeleton): void {
  const bones = skeleton.bones.map((bone) => ({ parent: bone.parent?.index ?? -1, skin: bone.data.skin }));
  const kinds = skeleton.constraints;
  const doc = skeleton.document;
  const index = (name: string) => skeleton.getBone(name).index;
  const constraints: OrderConstraint[] = kinds.map(({ kind, index: i, name }) => {
    if (kind === "physics") {
      const c = doc.physics[i];
      return { kind, index: i, name, skin: c?.skin ?? false, bones: [index(c?.bone ?? "")], target: -1 };
    }
    const c = (doc[kind] ?? [])[i];
    return { kind, index: i, name, skin: c?.skin ?? false, bones: (c?.bones ?? []).map(index), target: index(c?.target ?? "") };
  });
  checkOrderRules(
    bones,
    constraints,
    skeleton.updateSteps,
    skeleton.bones.map((bone) => bone.active),
    kinds.map((c) => skeleton.isConstraintActive(c.kind, c.index))
  );
}

const leg: Omit<AnimDocumentInput, "format" | "name" | "canvas"> = {
  bones: [
    { name: "root" },
    { name: "hip", parent: "root", y: -100 },
    { name: "thigh", parent: "hip", rotation: 90, length: 50 },
    { name: "shin", parent: "thigh", x: 50, length: 50 },
    { name: "foot", parent: "shin", x: 50, rotation: -90 },
    { name: "target", parent: "root", x: 30 }
  ],
  ik: [{ name: "leg", bones: ["thigh", "shin"], target: "target" }]
};

describe("update order", () => {
  it("computes the target and the chain, then the constraint, then the bones below the chain", () => {
    const skeleton = testSkeleton(leg);
    expect(describeSteps(skeleton)).toEqual(["root", "target", "hip", "thigh", "shin", "ik:0", "foot"]);
    checkSkeletonOrder(skeleton);
  });

  it("puts a transform constraint after its target", () => {
    const skeleton = testSkeleton({
      bones: [{ name: "root" }, { name: "hat", parent: "root" }, { name: "chest", parent: "root" }, { name: "head", parent: "chest" }],
      transform: [{ name: "follow", bones: ["hat"], target: "head" }]
    });
    expect(describeSteps(skeleton)).toEqual(["root", "chest", "head", "hat", "transform:0"]);
  });

  it("runs IK, then transform, then physics constraints, each in list order", () => {
    const skeleton = testSkeleton({
      bones: [
        { name: "root" },
        { name: "a", parent: "root" },
        { name: "b", parent: "root" },
        { name: "c", parent: "root" },
        { name: "t", parent: "root" }
      ],
      physics: [{ name: "p0", bone: "a" }, { name: "p1", bone: "b" }],
      transform: [{ name: "x0", bones: ["c"], target: "t" }],
      ik: [{ name: "k0", bones: ["b"], target: "t" }, { name: "k1", bones: ["a"], target: "t" }]
    });
    const constraintSteps = describeSteps(skeleton).filter((step) => step.includes(":"));
    expect(constraintSteps).toEqual(["ik:0", "ik:1", "transform:0", "physics:0", "physics:1"]);
    checkSkeletonOrder(skeleton);
  });

  describe("constraint order field", () => {
    // A transform constraint places the IK target on a driver bone.
    const aimed = (order?: number): Omit<AnimDocumentInput, "format" | "name" | "canvas"> => ({
      ...leg,
      bones: [...(leg.bones ?? []), { name: "driver", parent: "root", x: 80, y: -20 }],
      transform: [{ name: "aim", bones: ["target"], target: "driver", ...(order === undefined ? {} : { order }) }]
    });

    it("by default runs IK before transform, so IK would read the target before it moves", () => {
      const skeleton = testSkeleton(aimed());
      expect(describeSteps(skeleton)).toEqual(["root", "target", "hip", "thigh", "shin", "ik:0", "driver", "transform:0", "foot"]);
      checkSkeletonOrder(skeleton);
    });

    it("order -1 runs the transform first, so IK reads the placed target", () => {
      const skeleton = testSkeleton(aimed(-1));
      expect(describeSteps(skeleton)).toEqual(["root", "driver", "target", "transform:0", "hip", "thigh", "shin", "ik:0", "foot"]);
      expect(skeleton.constraints.map((c) => `${c.kind}:${c.index}@${c.order}`)).toEqual(["transform:0@-1", "ik:0@0"]);
      checkSkeletonOrder(skeleton);
    });

    it("the IK solver sees the target where the transform solver put it", () => {
      // Stand-in solvers: the transform snaps the target onto the driver; the IK records what it reads.
      const seen: number[] = [];
      const solvers = {
        transform: (s: Skeleton) => {
          const target = s.getBone("target");
          const driver = s.getBone("driver");
          target.world.x = driver.world.x;
          target.world.y = driver.world.y;
          target.updateAppliedTransform();
        },
        ik: (s: Skeleton) => {
          seen.push(s.getBone("target").world.x);
        }
      };
      testSkeleton(aimed(), { solvers });
      testSkeleton(aimed(-1), { solvers });
      expect(seen).toEqual([30, 80]); // default order reads the stale target; order -1 the driver
    });

    it("sorts by (order, kind, list index)", () => {
      const skeleton = testSkeleton({
        bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "b", parent: "root" }, { name: "t", parent: "root" }],
        ik: [{ name: "k0", bones: ["a"], target: "t", order: 1 }, { name: "k1", bones: ["b"], target: "t" }],
        transform: [{ name: "x0", bones: ["b"], target: "t" }],
        physics: [{ name: "p0", bone: "a", order: -5 }, { name: "p1", bone: "b" }]
      });
      expect(skeleton.constraints.map((c) => c.name)).toEqual(["p0", "k1", "k0", "x0", "p1"]);
      expect(describeSteps(skeleton).filter((step) => step.includes(":"))).toEqual(["physics:0", "ik:1", "ik:0", "transform:0", "physics:1"]);
      // The active lookup follows the sorted positions.
      for (const c of skeleton.constraints) expect(skeleton.isConstraintActive(c.kind, c.index)).toBe(true);
      expect(skeleton.isConstraintActive("ik", 7)).toBe(false);
      checkSkeletonOrder(skeleton);
    });
  });

  it("recomputes a child after a later constraint moves its parent again", () => {
    // physics on the thigh runs after the IK on thigh+shin, so the shin and foot are recomputed.
    const skeleton = testSkeleton({ ...leg, physics: [{ name: "wobble", bone: "thigh", rotate: 1 }] });
    expect(describeSteps(skeleton)).toEqual(["root", "target", "hip", "thigh", "shin", "ik:0", "physics:0", "shin", "foot"]);
    checkSkeletonOrder(skeleton);
  });

  it("satisfies the ordering rules on randomly generated rigs", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const count = 6 + Math.floor(next(0, 20));
      const bones: OrderBone[] = [{ parent: -1, skin: false }];
      for (let i = 1; i < count; i++) {
        const parent = Math.floor(next(0, i));
        bones.push({ parent, skin: (bones[parent]?.skin ?? false) || next(0, 1) < 0.2 });
      }
      const pick = () => Math.floor(next(1, count));
      const constraints: OrderConstraint[] = [];
      const kinds = ["ik", "transform", "physics"] as const;
      for (const kind of kinds) {
        const n = Math.floor(next(0, 4));
        for (let i = 0; i < n; i++) {
          let constrained = [pick()];
          if (kind === "ik" && next(0, 1) < 0.5) {
            const child = bones.findIndex((bone) => bone.parent === constrained[0]);
            if (child > 0) constrained = [constrained[0] ?? 0, child];
          } else if (kind === "transform" && next(0, 1) < 0.5) {
            // A second bone, kept only where the document rules allow it: unrelated to the first,
            // or its direct child listed after it.
            const first = constrained[0] ?? 0;
            const second = pick();
            const related = (x: number, y: number) => {
              for (let b = bones[x]?.parent ?? -1; b >= 0; b = bones[b]?.parent ?? -1) if (b === y) return true;
              return false;
            };
            if (bones[second]?.parent === first || (second !== first && !related(second, first) && !related(first, second))) {
              constrained.push(second);
            }
          }
          let target = kind === "physics" ? -1 : pick();
          while (constrained.includes(target)) target = pick();
          constraints.push({ kind, index: i, name: `${kind}${i}`, skin: next(0, 1) < 0.3, bones: constrained, target });
        }
      }
      const skinBones = new Set<number>();
      bones.forEach((bone, i) => {
        if (bone.skin && next(0, 1) < 0.5) skinBones.add(i);
      });
      const skinConstraints = new Set(constraints.filter(() => next(0, 1) < 0.6).map((c) => c.name));
      const plan = planUpdateOrder(bones, constraints, { bones: skinBones, constraints: skinConstraints });
      checkOrderRules(bones, constraints, plan.steps, plan.boneActive, plan.constraintActive);
    }
  });
});

describe("skin gating", () => {
  const caped: Omit<AnimDocumentInput, "format" | "name" | "canvas"> = {
    bones: [
      { name: "root" },
      { name: "chest", parent: "root" },
      { name: "cape_1", parent: "chest", skin: true },
      { name: "cape_2", parent: "cape_1", skin: true },
      { name: "sword", parent: "chest", skin: true }
    ],
    physics: [
      { name: "cape_1_physics", bone: "cape_1", rotate: 1, skin: true },
      { name: "cape_2_physics", bone: "cape_2", rotate: 1, skin: true },
      // Not a skin constraint, but it touches a skin bone, so it only runs with that bone.
      { name: "sword_sway", bone: "sword", rotate: 1 }
    ],
    skins: {
      cape: { bones: ["cape_2"], constraints: ["cape_1_physics", "cape_2_physics"] },
      capeBonesOnly: { bones: ["cape_2"] },
      sword: { bones: ["sword"] }
    }
  };

  it("leaves skin bones and their constraints out while no skin is active", () => {
    const skeleton = testSkeleton(caped);
    expect(describeSteps(skeleton)).toEqual(["root", "chest"]);
    expect(skeleton.bones.map((bone) => bone.active)).toEqual([true, true, false, false, false]);
    expect([0, 1, 2].map((i) => skeleton.isConstraintActive("physics", i))).toEqual([false, false, false]);
    checkSkeletonOrder(skeleton);
  });

  it("activates a listed bone together with its parent chain, and the skin's constraints", () => {
    const skeleton = testSkeleton(caped);
    skeleton.setActiveSkins(["cape"]);
    expect(describeSteps(skeleton)).toEqual(["root", "chest", "cape_1", "physics:0", "cape_2", "physics:1"]);
    expect(skeleton.getBone("cape_1").active).toBe(true);
    expect(skeleton.getBone("sword").active).toBe(false);
    checkSkeletonOrder(skeleton);
  });

  it("keeps skin constraints off when the active skin does not list them", () => {
    const skeleton = testSkeleton(caped);
    skeleton.setActiveSkins(["capeBonesOnly"]);
    expect(describeSteps(skeleton)).toEqual(["root", "chest", "cape_1", "cape_2"]);
  });

  it("runs a non-skin constraint only while all its bones are active", () => {
    const skeleton = testSkeleton(caped);
    skeleton.setActiveSkins(["sword"]);
    expect(skeleton.isConstraintActive("physics", 2)).toBe(true);
    expect(describeSteps(skeleton)).toEqual(["root", "chest", "sword", "physics:2"]);
    skeleton.setActiveSkins([]);
    expect(skeleton.isConstraintActive("physics", 2)).toBe(false);
  });

  it("merges several skins (an outfit)", () => {
    const skeleton = testSkeleton(caped);
    skeleton.setActiveSkins(["sword", "cape"]);
    expect(skeleton.activeSkins).toEqual(["sword", "cape"]);
    expect(skeleton.bones.every((bone) => bone.active)).toBe(true);
    checkSkeletonOrder(skeleton);
  });

  it("rejects unknown skins without changing the active set", () => {
    const skeleton = testSkeleton(caped);
    skeleton.setActiveSkins(["cape"]);
    expect(() => skeleton.setActiveSkins(["cape", "jetpack"])).toThrowError("unknown skin 'jetpack'");
    expect(skeleton.activeSkins).toEqual(["cape"]);
  });

  it("orders the humanoid fixture correctly for every combination of skins", () => {
    const doc = loadAnimDocument(JSON.parse(readFileSync(new URL("../../fixtures/valid/humanoid.anim.json", import.meta.url), "utf8")));
    const skins = Object.keys(doc.skins);
    const skeleton = new Skeleton(doc);
    for (let mask = 0; mask < 1 << skins.length; mask++) {
      skeleton.setActiveSkins(skins.filter((_, i) => mask & (1 << i)));
      checkSkeletonOrder(skeleton);
    }
  });
});

describe("updateWorldTransform", () => {
  it("runs constraint solvers in order so children follow the solved pose", () => {
    // A stand-in IK solver that bends the thigh +90 degrees.
    const solved = testSkeleton(leg, {
      solvers: {
        ik: (skeleton) => {
          const thigh = skeleton.getBone("thigh");
          const t = thigh.applied;
          thigh.updateWorldTransformWith(t.x, t.y, t.rotation + 90, t.scaleX, t.scaleY, t.shearX, t.shearY);
          skeleton.getBone("shin").updateWorldTransform();
        }
      }
    });
    const posed = new Skeleton(testDocument({ bones: leg.bones }));
    posed.getBone("thigh").pose.rotation += 90;
    posed.updateWorldTransform();
    for (const name of ["thigh", "shin", "foot"]) expectAffine(solved.getBone(name).world, posed.getBone(name).world);
    // Hand check: thigh points along 180 degrees from (0, -100); the shin sits 50 further left.
    expectAffine(solved.getBone("shin").world, { x: -50, y: -100 });
  });

  it("restarts from the pose every frame (constraints do not accumulate)", () => {
    const skeleton = testSkeleton(leg, {
      solvers: { ik: (s) => s.getBone("thigh").rotateWorld(10) }
    });
    const first = { ...skeleton.getBone("foot").world };
    skeleton.updateWorldTransform();
    skeleton.updateWorldTransform();
    expectAffine(skeleton.getBone("foot").world, first);
  });

  it("returns to the setup pose", () => {
    const skeleton = testSkeleton({ bones: leg.bones });
    const setup = { ...skeleton.getBone("foot").world };
    skeleton.getBone("thigh").pose.rotation = 0;
    skeleton.updateWorldTransform();
    expect(skeleton.getBone("foot").world.x).not.toBeCloseTo(setup.x, 6);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();
    expectAffine(skeleton.getBone("foot").world, setup);
  });
});

describe("construction", () => {
  it("finds bones by name", () => {
    const skeleton = testSkeleton(leg);
    expect(skeleton.findBone("shin")?.parent?.data.name).toBe("thigh");
    expect(skeleton.findBone("tail")).toBeUndefined();
    expect(() => skeleton.getBone("tail")).toThrowError("unknown bone 'tail'");
    expect(skeleton.getBone("hip").children.map((bone) => bone.data.name)).toEqual(["thigh"]);
  });

  it("refuses unvalidated documents whose bones are out of order", () => {
    const doc = testDocument(leg);
    const broken = { ...doc, bones: [...doc.bones].reverse() };
    expect(() => new Skeleton(broken)).toThrowError(/is not listed before it/);
  });
});
