import { readFileSync } from "node:fs";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip, setRotateKey, setVectorKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { clipGates, poseGates } from "./gates.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")));

const loopClip = (bone: string, value: number, loop = true) => setRotateKey(parseClip({ duration: 1, loop, fps: 30 }), bone, 0, value);

describe("live gates", () => {
  it("the committed walk is clean at its first frame", () => {
    const issues = poseGates(doc, "walk_in_place", doc.animations.walk_in_place!, 0);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  it("the committed walk and idle pass the user rules on every sample", () => {
    for (const name of ["walk_in_place", "idle_weight_shift"]) {
      expect(clipGates(doc, name, doc.animations[name]!).filter((i) => i.severity === "error"), name).toEqual([]);
    }
  });
  it("flags a bone past its declared range (head is -15..15), as an error on a loop", () => {
    const issues = poseGates(doc, "test", loopClip("head", 40), 0);
    expect(issues.some((i) => i.kind === "bone limit" && i.severity === "error" && i.message.startsWith("head"))).toBe(true);
  });
  it("only warns on a non-loop (combat) clip", () => {
    const issues = poseGates(doc, "test", loopClip("head", 40, false), 0);
    expect(issues.some((i) => i.kind === "bone limit")).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  it("checks unkeyed edits as if keyed", () => {
    const clip = parseClip({ duration: 1, loop: true, fps: 30 });
    expect(poseGates(doc, "test", clip, 0, { head: 40 }).some((i) => i.kind === "bone limit")).toBe(true);
  });
  it("reports unknown bones as reference errors, even on a non-loop clip", () => {
    const clip = setRotateKey(parseClip({ duration: 1, loop: false, fps: 30 }), "no_such_bone", 0, 1);
    expect(poseGates(doc, "test", clip, 0).some((i) => i.kind === "reference" && i.severity === "error")).toBe(true);
  });
  it("flags an arm raised into the head", () => {
    // left arm up past the shoulder: the fist reaches the head's silhouette
    const issues = poseGates(doc, "test", setRotateKey(loopClip("upper_arm_l", 105), "forearm_l", 0, 70), 0);
    expect(issues.some((i) => i.kind === "arm behind head" || i.kind === "upper arm thrown back")).toBe(true);
  });
  it("sees a swing past the bone range on a combat clip (not clamped) and only warns", () => {
    // upper_arm_l 150: the arm points straight up beside the head
    const issues = poseGates(doc, "test", loopClip("upper_arm_l", 150, false), 0);
    expect(issues.some((i) => i.kind === "arm behind head" && i.severity === "warning")).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  it("flags an upper arm reaching to the rear side (screen-right in the L view) past 60 degrees from down", () => {
    // -119 points the left upper arm at 0 degrees (screen-right, horizontal)
    const back = poseGates(doc, "test", loopClip("upper_arm_l", -119, false), 0);
    expect(back.some((i) => i.kind === "upper arm thrown back" && i.severity === "warning")).toBe(true);
    // forward swing (toward screen-left, horizontal) and a small rearward swing are fine
    expect(poseGates(doc, "test", loopClip("upper_arm_l", 60, false), 0).some((i) => i.kind === "upper arm thrown back")).toBe(false);
    expect(poseGates(doc, "test", loopClip("upper_arm_l", -20, false), 0).some((i) => i.kind === "upper arm thrown back")).toBe(false);
  });
  it("the rule is off on the straight front rig", () => {
    const front = loadAnimDocument(JSON.parse(readFileSync(new URL("../../../packages/animator/rigs/player/front-turn00-faceA.anim.json", import.meta.url), "utf8")));
    expect(poseGates(front, "test", loopClip("upper_arm_l", -119, false), 0).some((i) => i.kind === "upper arm thrown back")).toBe(false);
  });
  it("flags a scaled head (+-3%) and a stretched limb", () => {
    const head = parseClip({ duration: 1, loop: true, fps: 30, bones: { head: { scale: [{ time: 0, x: 1.06, y: 1.06 }] } } });
    expect(poseGates(doc, "test", head, 0).some((i) => i.kind === "head scale")).toBe(true);
    const stretch = parseClip({ duration: 1, loop: true, fps: 30, bones: { forearm_l: { translate: [{ time: 0, x: 20, y: 0 }] } } });
    expect(poseGates(doc, "test", stretch, 0).some((i) => i.kind === "limb stretch")).toBe(true);
  });
  it("a hips / chest lunge (translate keys) is clean; a hand offset along the arm is a limb stretch; unkeyed moves are checked as keyed", () => {
    const lunge = setVectorKey(setVectorKey(parseClip({ duration: 1, loop: false, fps: 30 }), "pelvis", "translate", 0, 30, 6), "chest", "translate", 0, 10, 0);
    expect(poseGates(doc, "test", lunge, 0)).toEqual([]);
    const hand = setVectorKey(parseClip({ duration: 1, loop: false, fps: 30 }), "hand_l", "translate", 0, 30, 0);
    expect(poseGates(doc, "test", hand, 0).some((i) => i.kind === "limb stretch")).toBe(true);
    const empty = parseClip({ duration: 1, loop: false, fps: 30 });
    expect(poseGates(doc, "test", empty, 0, {}, { hand_l: { x: 30, y: 0 } }).some((i) => i.kind === "limb stretch")).toBe(true);
  });
  it("runs the whole-clip check on a committed clip", () => {
    const issues = clipGates(doc, "fk_ik_fk", doc.animations.fk_ik_fk!);
    expect(Array.isArray(issues)).toBe(true);
  });
});
