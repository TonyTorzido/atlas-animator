import { readFileSync } from "node:fs";
import { AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { clipsEquivalent, deleteKeys, parseClip, setVectorKey, writeClip } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { poseGates } from "./gates.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));
const empty = () => parseClip({ duration: 1, loop: false, fps: 30 });

function posed(clip: ReturnType<typeof empty>, time: number) {
  const rig = { ...doc, animations: { t: clip } };
  const skeleton = new Skeleton(rig);
  skeleton.setToSetupPose();
  const state = new AnimationState(new AnimationStateData(rig));
  state.setAnimation(0, "t", { loop: false });
  state.update(time);
  state.apply(skeleton);
  skeleton.updateWorldTransform("reset");
  return skeleton;
}

describe("scale and shear keys", () => {
  it("setVectorKey writes scale (multiplier) and shear (degrees) timelines that round-trip through the format", () => {
    let clip = setVectorKey(empty(), "chest", "scale", 0, 1.1, 0.9);
    clip = setVectorKey(clip, "chest", "shear", 0, 12, 0);
    const written = writeClip(clip) as { bones: { chest: { scale: { x: number; y: number }[]; shear: { x: number }[] } } };
    expect(written.bones.chest.scale[0]).toMatchObject({ x: 1.1, y: 0.9 });
    expect(written.bones.chest.shear[0]).toMatchObject({ x: 12 });
    expect(clipsEquivalent(written, writeClip(parseClip(written)))).toBe(true);
    expect(poseGates(doc, "t", clip, 0).filter((i) => i.kind === "format")).toEqual([]);
  });
  it("the runtime applies a scale key as a multiplier of setup and a shear key as an offset", () => {
    const clip = setVectorKey(setVectorKey(empty(), "chest", "scale", 0, 1.2, 0.8), "chest", "shear", 0, 10, 0);
    const sk = posed(clip, 0);
    const chest = sk.findBone("chest")!;
    expect(chest.pose.scaleX).toBeCloseTo(chest.data.scaleX * 1.2, 5);
    expect(chest.pose.scaleY).toBeCloseTo(chest.data.scaleY * 0.8, 5);
    expect(chest.pose.shearX).toBeCloseTo(chest.data.shearX + 10, 5);
  });
  it("deleteKeys removes a shear key by channel", () => {
    const clip = setVectorKey(setVectorKey(empty(), "chest", "scale", 0, 1.1, 1), "chest", "shear", 0, 5, 0);
    const next = deleteKeys(clip, "chest", 0, "shear");
    expect(next.bones.chest?.shear).toBeUndefined();
    expect(next.bones.chest?.scale).toHaveLength(1);
  });
});

describe("limb scale rule", () => {
  const limbScale = (clip: ReturnType<typeof empty>) => poseGates(doc, "t", clip, 0).filter((i) => i.kind === "limb scale");
  it("warns, never errors, when an arm or leg bone is scaled (even on a loop)", () => {
    for (const bone of ["upper_arm_l", "forearm_r", "thigh_l", "shin_r"]) {
      for (const loop of [false, true]) {
        const clip = { ...setVectorKey(empty(), bone, "scale", 0, 1.3, 1), loop };
        const hits = limbScale(clip);
        expect(hits.length, `${bone} loop=${loop}`).toBe(1);
        expect(hits[0]!.severity).toBe("warning");
        expect(hits[0]!.message).toContain(bone);
      }
    }
  });
  it("treats an unkeyed scale edit as if keyed", () => {
    expect(poseGates(doc, "t", empty(), 0, {}, {}, { forearm_l: { x: 1, y: 1.4 } }).some((i) => i.kind === "limb scale")).toBe(true);
  });
  it("allows torso, chest and head squash, and does not flag the arms a squashed chest carries", () => {
    let clip = empty();
    for (const bone of ["hips", "chest", "head"]) if (doc.bones.some((b) => b.name === bone)) clip = setVectorKey(clip, bone, "scale", 0, 1.08, 0.92);
    expect(limbScale(clip)).toEqual([]);
  });
  it("shear on a limb is not a stretch", () => {
    expect(limbScale(setVectorKey(empty(), "upper_arm_l", "shear", 0, 8, 0))).toEqual([]);
  });
});
