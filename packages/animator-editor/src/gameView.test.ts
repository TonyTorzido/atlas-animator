import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { buildGround, findTip, upperBodyBones, walkClipName } from "./gameView.js";
import { GROUNDS } from "./gameViewModel.js";

const rigs = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../animator/rigs");
const load = (file: string) => loadAnimDocument(JSON.parse(readFileSync(resolve(rigs, file), "utf8")) as unknown);

describe("weapon tip", () => {
  it("follows the weapon_tip bone of the pro rigs", () => {
    const doc = load("kit-body-front0/kit-body-front0.anim.json");
    const sk = new Skeleton(doc);
    sk.setToSetupPose();
    sk.updateWorldTransform();
    const tip = findTip(sk, doc)!;
    const bone = sk.findBone("weapon_tip")!;
    expect(tip()).toEqual({ x: bone.world.x, y: bone.world.y });
    // Rotating the arm moves the tip.
    const before = tip();
    sk.findBone("upper_arm_near")!.pose.rotation += 50;
    sk.updateWorldTransform();
    expect(tip()).not.toEqual(before);
  });

  it("falls back to a hand tip when the rig has no weapon", () => {
    const doc = load("player/front-turn15-faceA.anim.json");
    const sk = new Skeleton(doc);
    sk.setToSetupPose();
    sk.updateWorldTransform();
    expect(findTip(sk, doc)).not.toBeNull();
  });
});

describe("walk under", () => {
  it("picks walk_in_place, else another walk clip, never the edited one", () => {
    expect(walkClipName({ walk_in_place: 1, chop: 1 }, "chop")).toBe("walk_in_place");
    expect(walkClipName({ jog_walk: 1, chop: 1 }, "chop")).toBe("jog_walk");
    expect(walkClipName({ walk_in_place: 1 }, "walk_in_place")).toBeNull();
    expect(walkClipName({ chop: 1 }, "chop")).toBeNull();
  });

  it("keeps the torso, arms and hand targets for the clip, not the legs", () => {
    const doc = load("kit-body-front0/kit-body-front0.anim.json");
    const names = upperBodyBones(doc);
    for (const n of ["chest", "clavicle_near", "weapon", "hand_near_target"]) expect(names, n).toContain(n);
    expect(names).not.toContain("thigh_near");
  });

  it("a state with the entry's track time set directly poses the way state.update(t) does", () => {
    const doc = load("player/front-turn15-faceA.anim.json");
    const walk = Object.keys(doc.animations).find((n) => n === "walk_in_place") ?? Object.keys(doc.animations)[0]!;
    const sk = new Skeleton(doc);
    const data = new AnimationStateData(new AnimationLibrary(doc));
    const ref = new AnimationState(data);
    ref.setAnimation(0, walk, { loop: true });
    ref.update(0.3);
    ref.apply(sk);
    sk.updateWorldTransform();
    const expected = sk.bones.map((b) => b.world.x + b.world.y);
    const state = new AnimationState(data);
    state.setAnimation(0, walk, { loop: true }).trackTime = 0.3;
    state.update(0);
    state.apply(sk);
    sk.updateWorldTransform();
    expect(sk.bones.map((b) => b.world.x + b.world.y)).toEqual(expected);
  });
});

describe("ground", () => {
  it("builds every biome ground without throwing", () => {
    for (const biome of GROUNDS) buildGround(new Graphics(), biome);
    expect(GROUNDS.map((g) => g.id)).toContain("grass");
  });
});
