import { readFileSync } from "node:fs";
import { AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip, setRotateKey, setVectorKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { applyMirror, makeMirrorRig, mirrorIkOps, mirrorOffsets, nameSide, partnerCandidate, planFlip, planLimb, planMirror, setIkMixKey, type MirrorOffsets } from "./mirrorModel.js";

const load = (id: string) => {
  const o = ALL_OUTFITS.find((x) => x.id === id)!;
  return loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${o.document}`, import.meta.url), "utf8")));
};
const pro = load("pro-front");
const rig = makeMirrorRig(pro.bones);
const empty = () => parseClip({ duration: 1, loop: false, fps: 30 });

/** The rig posed by the clip at `time` with the IK off (so a leg is plain FK, like an arm). */
function posed(clip: ReturnType<typeof empty>, time = 0) {
  const doc = { ...pro, animations: { t: clip } };
  const sk = new Skeleton(doc);
  sk.limitsEnforced = false;
  sk.setToSetupPose();
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, "t", { loop: false });
  state.update(time);
  state.apply(sk);
  for (const c of sk.ikConstraints) c.pose.mix = 0;
  sk.updateWorldTransform("reset");
  return sk;
}

const offsetsOf = (sk: Skeleton, name: string): MirrorOffsets => {
  const b = sk.findBone(name)!;
  return {
    rotate: b.pose.rotation - b.data.rotation,
    translate: { x: b.pose.x - b.data.x, y: b.pose.y - b.data.y },
    scale: { x: b.pose.scaleX / b.data.scaleX, y: b.pose.scaleY / b.data.scaleY },
    shear: { x: b.pose.shearX - b.data.shearX, y: b.pose.shearY - b.data.shearY }
  };
};
const worldAngle = (sk: Skeleton, name: string) => (Math.atan2(sk.findBone(name)!.world.c, sk.findBone(name)!.world.a) * 180) / Math.PI;
const wrap = (d: number) => d - 360 * Math.round(d / 360);

describe("bone pairing", () => {
  it("swaps one side token, in any position, keeping the case", () => {
    expect(partnerCandidate("upper_arm_near")).toBe("upper_arm_far");
    expect(partnerCandidate("thigh_far")).toBe("thigh_near");
    expect(partnerCandidate("hand_l")).toBe("hand_r");
    expect(partnerCandidate("hand_R")).toBe("hand_L");
    expect(partnerCandidate("hand_near_target")).toBe("hand_far_target");
    expect(partnerCandidate("hair_far_1")).toBe("hair_near_1");
    expect(partnerCandidate("head")).toBeNull();
    expect(partnerCandidate("near_far_x")).toBeNull();
    expect(partnerCandidate("weapon_grip2")).toBeNull();
    expect(nameSide("forearm_near")).toBe("near");
    expect(nameSide("forearm_r")).toBe("far");
    expect(nameSide("spine_1")).toBeNull();
  });

  it("pairs the pro rig's arms, legs, targets and hair, and leaves the weapon and the spine alone", () => {
    for (const [a, b] of [["clavicle_near", "clavicle_far"], ["thigh_near", "thigh_far"], ["foot_near_target", "foot_far_target"], ["hand_near_target", "hand_far_target"], ["hair_near_1", "hair_far_1"]] as const) {
      expect(rig.partner.get(a)).toBe(b);
      expect(rig.partner.get(b)).toBe(a);
    }
    expect(rig.partner.has("weapon")).toBe(false);
    expect(rig.partner.has("offhand")).toBe(false);
    for (const n of ["pelvis", "spine_1", "spine_2", "chest", "neck", "head", "hair_1", "body", "lean"]) expect(rig.center.has(n), n).toBe(true);
    for (const n of ["weapon", "weapon_tip", "offhand", "root", "thigh_near"]) expect(rig.center.has(n), n).toBe(false);
  });

  it("pairs the stock rig's _l / _r bones", () => {
    const stock = makeMirrorRig(load("turned-l").bones);
    expect(stock.partner.get("upper_arm_l")).toBe("upper_arm_r");
    expect(stock.partner.get("hand_r")).toBe("hand_l");
  });
});

describe("mirrored offsets", () => {
  it("accounts for the opposite setup orientation: the same raw offset on the far clavicle is not a mirror, the computed one is", () => {
    const o: MirrorOffsets = { rotate: 30, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, shear: { x: 0, y: 0 } };
    // setup -105.78 near / +105.78 far: the total angle -75.78 mirrors to +75.78, which is an offset of -30 from the far setup.
    expect(mirrorOffsets(rig, { from: "clavicle_near", to: "clavicle_far" }, o).rotate).toBeCloseTo(-30, 6);
  });

  it("is its own inverse for every pair and every axis bone, on both rigs", () => {
    const o: MirrorOffsets = { rotate: 37.5, translate: { x: 12, y: -7 }, scale: { x: 1.2, y: 0.9 }, shear: { x: 5, y: -3 } };
    const close = (a: MirrorOffsets, b: MirrorOffsets) => {
      expect(a.rotate).toBeCloseTo(b.rotate, 6);
      expect(a.translate.x).toBeCloseTo(b.translate.x, 6);
      expect(a.translate.y).toBeCloseTo(b.translate.y, 6);
      expect(a.scale).toEqual(b.scale);
      expect(a.shear.x).toBeCloseTo(b.shear.x, 6);
    };
    for (const r of [rig, makeMirrorRig(load("turned-l").bones), makeMirrorRig(load("turned-r").bones)]) {
      for (const b of r.bones) {
        const mate = r.partner.get(b.name) ?? (r.center.has(b.name) ? b.name : null);
        if (!mate) continue;
        const there = mirrorOffsets(r, { from: b.name, to: mate }, o);
        close(mirrorOffsets(r, { from: mate, to: b.name }, there), o);
      }
    }
  });

  it("mirrors the spine and head in place: rotation negated, translate reflected over the axis", () => {
    const o: MirrorOffsets = { rotate: 12, translate: { x: 10, y: 5 }, scale: { x: 1, y: 1 }, shear: { x: 0, y: 0 } };
    expect(mirrorOffsets(rig, { from: "head", to: "head" }, o).rotate).toBe(-12);
    expect(mirrorOffsets(rig, { from: "spine_1", to: "spine_1" }, o).rotate).toBe(-12);
    // body hangs off the root (screen x is its sideways): x flips, y stays. Spine bones sit in the pelvis's frame, which runs down the axis: y flips.
    const body = mirrorOffsets(rig, { from: "body", to: "body" }, o).translate;
    expect([body.x, body.y]).toEqual([-10, 5].map((v) => expect.closeTo(v, 6)));
    const spine = mirrorOffsets(rig, { from: "spine_1", to: "spine_1" }, o).translate;
    expect([spine.x, spine.y]).toEqual([10, -5].map((v) => expect.closeTo(v, 6)));
  });
});

describe("mirror looks mirrored (rig posed with the runtime)", () => {
  const armPose = () => {
    let c = empty();
    for (const [bone, v] of [["clavicle_near", 14], ["upper_arm_near", 52], ["forearm_near", -33], ["hand_near", 9]] as const) c = setRotateKey(c, bone, 0, v);
    return setVectorKey(c, "clavicle_near", "translate", 0, 4, -6);
  };

  it("the near arm copied onto the far arm ends as the exact reflection of it: joints at x -> -x, angles 180 - a", () => {
    const src = posed(armPose());
    const plan = planLimb(rig, "arm", "near");
    expect(plan.ops.map((o) => o.to)).toEqual(expect.arrayContaining(["clavicle_far", "upper_arm_far", "forearm_far", "hand_far", "hand_far_target"]));
    const r = applyMirror(empty(), rig, plan.ops, (n) => offsetsOf(src, n), 0);
    const out = posed(r.clip);
    for (const n of ["clavicle", "upper_arm", "forearm", "hand"]) {
      const a = src.findBone(`${n}_near`)!.world;
      const b = out.findBone(`${n}_far`)!.world;
      expect(b.x, `${n} x`).toBeCloseTo(-a.x, 3);
      expect(b.y, `${n} y`).toBeCloseTo(a.y, 3);
      expect(wrap(worldAngle(out, `${n}_far`) - (180 - worldAngle(src, `${n}_near`))), `${n} angle`).toBeCloseTo(0, 3);
    }
    // ...and it is a real change: the far arm moved off its setup pose, the near arm is untouched by the copy.
    expect(Math.abs(out.findBone("hand_far")!.world.y - posed(empty()).findBone("hand_far")!.world.y)).toBeGreaterThan(20);
    expect(r.keyed).not.toContain("upper_arm_near");
  });

  it("far onto near is the same reflection the other way", () => {
    let c = empty();
    for (const [bone, v] of [["upper_arm_far", -61], ["forearm_far", 28]] as const) c = setRotateKey(c, bone, 0, v);
    const src = posed(c);
    const r = applyMirror(empty(), rig, planLimb(rig, "arm", "far").ops, (n) => offsetsOf(src, n), 0);
    const out = posed(r.clip);
    for (const n of ["upper_arm", "forearm", "hand"]) {
      expect(out.findBone(`${n}_near`)!.world.x).toBeCloseTo(-src.findBone(`${n}_far`)!.world.x, 3);
      expect(out.findBone(`${n}_near`)!.world.y).toBeCloseTo(src.findBone(`${n}_far`)!.world.y, 3);
    }
  });

  it("the legs mirror too (to within the rig's own 1.5 px setup unevenness)", () => {
    let c = empty();
    for (const [bone, v] of [["thigh_near", -25], ["shin_near", 40], ["foot_near", 12]] as const) c = setRotateKey(c, bone, 0, v);
    const src = posed(c);
    const r = applyMirror(empty(), rig, planLimb(rig, "leg", "near").ops, (n) => offsetsOf(src, n), 0);
    const out = posed(r.clip);
    for (const n of ["thigh", "shin", "foot"]) {
      const a = src.findBone(`${n}_near`)!.world;
      const b = out.findBone(`${n}_far`)!.world;
      expect(Math.hypot(b.x + a.x, b.y - a.y), n).toBeLessThan(2.5);
    }
  });

  it("a flip swaps the sides in one go (reads before it writes) and flipping twice restores the pose", () => {
    let c = empty();
    for (const [bone, v] of [["upper_arm_near", 50], ["forearm_far", -20], ["head", 15], ["spine_1", -8]] as const) c = setRotateKey(c, bone, 0, v);
    const a = posed(c);
    const flipped = applyMirror(empty(), rig, planFlip(rig).ops, (n) => offsetsOf(a, n), 0);
    const b = posed(flipped.clip);
    // the near arm's raise is now on the far arm and vice versa, the head and spine lean the other way
    expect(b.findBone("hand_far")!.world.x).toBeCloseTo(-a.findBone("hand_near")!.world.x, 3);
    expect(b.findBone("hand_near")!.world.x).toBeCloseTo(-a.findBone("hand_far")!.world.x, 3);
    expect(b.findBone("head")!.world.x).toBeCloseTo(-a.findBone("head")!.world.x, 3);
    expect(b.findBone("head")!.world.x).not.toBeCloseTo(0, 1);
    const again = applyMirror(empty(), rig, planFlip(rig).ops, (n) => offsetsOf(b, n), 0);
    const d = posed(again.clip);
    for (const n of ["hand_near", "hand_far", "head", "foot_near", "foot_far"]) {
      expect(d.findBone(n)!.world.x, n).toBeCloseTo(a.findBone(n)!.world.x, 3);
      expect(d.findBone(n)!.world.y, n).toBeCloseTo(a.findBone(n)!.world.y, 3);
    }
  });
});

describe("planning", () => {
  it("copies the selection's side onto the other: the active bone decides when both sides are picked", () => {
    expect(planMirror(rig, ["upper_arm_near", "forearm_near"]).ops).toEqual([
      { from: "upper_arm_near", to: "upper_arm_far" },
      { from: "forearm_near", to: "forearm_far" }
    ]);
    expect(planMirror(rig, ["upper_arm_far"]).ops).toEqual([{ from: "upper_arm_far", to: "upper_arm_near" }]);
    const both = planMirror(rig, ["upper_arm_near", "forearm_far"], { active: "forearm_far" });
    expect(both.from).toBe("far");
    expect(both.ops).toEqual([{ from: "forearm_far", to: "forearm_near" }]);
  });

  it("mirrors axis bones in place, reports bones with no partner, and a limb brings what hangs below", () => {
    const p = planMirror(rig, ["head", "weapon", "upper_arm_near"]);
    expect(p.ops).toEqual(expect.arrayContaining([{ from: "head", to: "head" }, { from: "upper_arm_near", to: "upper_arm_far" }]));
    expect(p.unmatched).toEqual(["weapon"]);
    const limb = planMirror(rig, ["clavicle_near"], { limb: true });
    const to = limb.ops.map((o) => o.to);
    expect(to).toEqual(expect.arrayContaining(["clavicle_far", "upper_arm_far", "forearm_far", "hand_far"]));
    expect(to).not.toContain("thigh_far");
    expect(planMirror(rig, ["upper_arm_near"], { skip: new Set(["upper_arm_far"]) }).ops).toEqual([]);
  });

  it("an arm or leg plan takes only that limb, with its IK target", () => {
    const arm = planLimb(rig, "arm", "near").ops.map((o) => o.from);
    expect(arm).toEqual(expect.arrayContaining(["clavicle_near", "hand_near_target"]));
    expect(arm.some((n) => /thigh|foot|hair/.test(n))).toBe(false);
    const leg = planLimb(rig, "leg", "far").ops.map((o) => o.from);
    expect(leg).toEqual(expect.arrayContaining(["thigh_far", "shin_far", "foot_far", "foot_far_target"]));
    expect(leg.some((n) => /arm|hand|clavicle/.test(n))).toBe(false);
  });

  it("a flip pairs every bone both ways and keeps the skipped (IK-driven) bones out", () => {
    const all = planFlip(rig).ops;
    expect(all).toEqual(expect.arrayContaining([{ from: "thigh_near", to: "thigh_far" }, { from: "thigh_far", to: "thigh_near" }, { from: "pelvis", to: "pelvis" }]));
    expect(planFlip(rig, new Set(["thigh_far"])).ops.some((o) => o.to === "thigh_far" || o.from === "thigh_far")).toBe(false);
  });
});

describe("keys and IK", () => {
  it("keys only what matters: nothing on a rest pose, every animated channel otherwise", () => {
    const rest = applyMirror(empty(), rig, [{ from: "upper_arm_near", to: "upper_arm_far" }], () => ({ rotate: 0, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, shear: { x: 0, y: 0 } }), 0);
    expect(rest.clip.bones.upper_arm_far).toBeUndefined();
    const animated = setVectorKey(setRotateKey(empty(), "upper_arm_far", 0.5, 10), "upper_arm_far", "shear", 0.5, 2, 0);
    const r = applyMirror(animated, rig, [{ from: "upper_arm_near", to: "upper_arm_far" }], () => ({ rotate: 20, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, shear: { x: 3, y: 1 } }), 0.2);
    const tl = r.clip.bones.upper_arm_far!;
    expect(tl.rotate!.map((k) => k.time)).toEqual([0.2, 0.5].map((t) => expect.closeTo(t, 3)));
    expect(tl.rotate![0]!.value).toBeCloseTo(-20, 4);
    expect(tl.shear![0]).toMatchObject({ x: -3, y: -1 });
    expect(tl.translate).toBeUndefined();
  });

  it("flipping a rest pose writes no keys at all, even where the partner's setup is a little uneven (legs, 1.1 degrees)", () => {
    const rest = { rotate: 0, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, shear: { x: 0, y: 0 } };
    expect(mirrorOffsets(rig, { from: "thigh_near", to: "thigh_far" }, rest).rotate).not.toBeCloseTo(0, 2);
    const r = applyMirror(empty(), rig, planFlip(rig).ops, () => rest, 0);
    expect(r.clip.bones).toEqual({});
    expect(r.keyed).toEqual([]);
  });

  it("follows an IK pair: the target's constraint partner takes the mix, with a base key at 0 so earlier frames stay", () => {
    const ops = planLimb(rig, "arm", "near").ops;
    expect(mirrorIkOps(pro.ik, ops)).toEqual([{ from: "hand_ik_near", to: "hand_ik_far" }]);
    const c = setIkMixKey(empty(), "hand_ik_far", 0.5, 1, 0);
    expect(c.ik.hand_ik_far!.map((k) => [k.time, k.mix])).toEqual([[0, 0], [0.5, 1]]);
  });
});
