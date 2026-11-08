import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimatorCharacter } from "./animatorCharacter.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import { packedAtlasImages } from "./partImages.js";

/*
 * Held-pose cache correctness (review, the design notes): every input
 * that changes what a miss would draw takes part in the cache identity, and nothing a miss draws
 * survives from an older pose.
 */

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));

/** The three-part rig with a contour along the torso mesh's top row and a deform / no-deform clip pair. */
function document() {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
  raw.skins.body.contours = { torso: { side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4], width: 3, color: "201810ff" } } };
  raw.animations = {
    bend: { duration: 1, deform: { body: { torso: { torso: [{ time: 0, offset: 0, vertices: [0, 10, 0, 10, 0, 10] }] } } } },
    still: { duration: 1, bones: {} }
  };
  return loadAnimDocument(raw);
}

function make(doc = document()) {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body"]);
  const c = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });
  c.contourPixelScale = 1;
  const state = new AnimationState(new AnimationStateData(doc));
  state.heldFrames = true;
  return { c, skeleton, state };
}

const stroke = (c: AnimatorCharacter) => {
  const mesh = c.contourMeshes[0]!;
  return Array.from(mesh.geometry.positions);
};

describe("held-pose cache: contour geometry dependencies", () => {
  it("removing animation deform rebuilds the stroke (no stale outline)", () => {
    const doc = document();
    const a = make(doc);
    a.state.setAnimation(0, "bend");
    a.c.updateHeld(a.state);
    const bent = stroke(a.c);
    a.state.setAnimation(0, "still");
    expect(a.c.updateHeld(a.state)).toBe(true);

    const b = make(doc);
    b.state.setAnimation(0, "still");
    b.c.updateHeld(b.state);
    expect(stroke(b.c)).not.toEqual(bent);
    expect(stroke(a.c)).toEqual(stroke(b.c));
  });
});

describe("held-pose cache: procedural hook, clock and motion, display scale", () => {
  it("onAfterApply edits survive a miss; proceduralVersion and replacing the hook miss", () => {
    const { c, skeleton, state } = make();
    state.setAnimation(0, "still");
    c.updateHeld(state);
    const setup = skeleton.getBone("chest").world.a;
    // The review's sequence: a direct edit, invalidate, updateHeld. The miss resets it (documented).
    skeleton.getBone("chest").pose.rotation += 40;
    c.invalidate();
    c.updateHeld(state);
    expect(skeleton.getBone("chest").world.a).toBeCloseTo(setup, 12);

    let aim = 40;
    c.onAfterApply = (s) => {
      s.getBone("chest").pose.rotation += aim;
    };
    expect(c.updateHeld(state)).toBe(true);
    const aimed = skeleton.getBone("chest").world.a;
    expect(aimed).not.toBeCloseTo(setup, 6);
    expect(c.updateHeld(state)).toBe(false);
    aim = 10;
    c.proceduralVersion++;
    expect(c.updateHeld(state)).toBe(true);
    expect(skeleton.getBone("chest").world.a).not.toBeCloseTo(aimed, 6);
    expect(c.updateHeld(state)).toBe(false);
    c.onAfterApply = null;
    expect(c.updateHeld(state)).toBe(true);
    expect(skeleton.getBone("chest").world.a).toBeCloseTo(setup, 12);
  });

  it("step advances the skeleton clock with the state; motion misses only on a physics rig", () => {
    const plain = make();
    plain.state.setAnimation(0, "still");
    plain.state.timeScale = 0; // a frozen pose: only the clock runs
    plain.c.step(plain.state, 1 / 60);
    expect(plain.skeleton.time).toBeCloseTo(1 / 60, 12);
    plain.c.moveWorld(5, 0);
    expect(plain.c.step(plain.state, 1 / 60)).toBe(false);
    expect(plain.skeleton.time).toBeCloseTo(2 / 60, 12);

    const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
    raw.animations = { still: { duration: 1, bones: {} } };
    raw.physics = [{ name: "sway", bone: "chest", x: 1, y: 1, inertia: 1, strength: 100, damping: 0.9 }];
    const p = make(loadAnimDocument(raw));
    p.state.setAnimation(0, "still");
    p.state.timeScale = 0;
    p.c.step(p.state, 1 / 60);
    p.c.step(p.state, 1 / 60);
    expect(p.c.step(p.state, 1 / 60)).toBe(false);
    const rest = p.skeleton.getBone("chest").world.x;
    // Mirrored and scaled container: the motion is converted to skeleton space (x flips, / 2).
    p.c.scale.set(-2, 2);
    p.c.invalidate();
    p.c.step(p.state, 1 / 60);
    p.c.moveWorld(40, 0);
    expect(p.c.step(p.state, 1 / 60)).toBe(true);
    // The world moved +x (screen) = -x in the mirrored skeleton: the cloth lags toward +x.
    expect(p.skeleton.getBone("chest").world.x).toBeGreaterThan(rest + 1);
  });

  it("display scale: the longer axis times displayResolution", () => {
    const { c, state } = make();
    c.contourPixelScale = null;
    c.contourScaleStep = 0;
    state.setAnimation(0, "still");
    c.scale.set(1, 3);
    c.updateHeld(state);
    const scale = (c as unknown as { displayScale(): number }).displayScale();
    expect(scale).toBeCloseTo(3, 12);
    c.displayResolution = 2;
    expect((c as unknown as { displayScale(): number }).displayScale()).toBeCloseTo(6, 12);
    expect(c.updateHeld(state)).toBe(true);
    expect(c.updateHeld(state)).toBe(false);
  });
});

describe("held-pose cache: physics progression and pending resets (runtime contract F2)", () => {
  /** Three-part rig with a physics constraint on the chest and the given clips. */
  function physicsRig(physics: Record<string, unknown> | null, animations: Record<string, unknown>) {
    const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
    raw.animations = animations;
    raw.physics = physics ? [{ name: "sway", bone: "chest", x: 1, y: 1, strength: 100, damping: 0.9, ...physics }] : [];
    return make(loadAnimDocument(raw));
  }
  const short = { duration: 0.1, bones: { chest: { rotate: [{ time: 0, value: 0 }, { time: 0.1, value: 5 }] } } };

  it("wind physics keeps moving after a clip finished (held pose), then settles and hits again", () => {
    const p = physicsRig({ wind: 60 }, { short });
    p.state.setAnimation(0, "short");
    for (let i = 0; i < 12; i++) p.c.step(p.state, 1 / 60);
    const version = p.state.poseVersion;
    const before = p.skeleton.getBone("chest").world.x;
    for (let i = 0; i < 10; i++) p.c.step(p.state, 1 / 60);
    expect(p.state.poseVersion).toBe(version);
    expect(Math.abs(p.skeleton.getBone("chest").world.x - before)).toBeGreaterThan(0.05);
    // Damped springs settle; then the held pose hits again.
    for (let i = 0; i < 600; i++) p.c.step(p.state, 1 / 60);
    const evaluations = p.c.stats.poseEvaluations;
    for (let i = 0; i < 10; i++) expect(p.c.step(p.state, 1 / 60)).toBe(false);
    expect(p.c.stats.poseEvaluations).toBe(evaluations);
  });

  it("gravity physics under a constant pose and under a frozen state keeps simulating", () => {
    for (const freeze of [false, true]) {
      const p = physicsRig({ gravity: 80 }, { still: { duration: 1, loop: true, bones: {} } });
      p.state.setAnimation(0, "still");
      if (freeze) p.state.timeScale = 0;
      p.c.step(p.state, 1 / 60);
      const start = p.skeleton.getBone("chest").world.y;
      for (let i = 0; i < 10; i++) p.c.step(p.state, 1 / 60);
      expect(p.skeleton.getBone("chest").world.y - start).toBeGreaterThan(0.05);
    }
  });

  it("a reset key between display samples (1/60 s loop, 30 fps held frames) reaches the physics", () => {
    const p = physicsRig({}, { blip: { duration: 1 / 60, loop: true, bones: {}, physics: { sway: { reset: [{ time: 0.01 }] } } } });
    let resets = 0;
    const constraint = p.skeleton.physicsConstraints[0]!;
    const reset = constraint.reset.bind(constraint);
    constraint.reset = () => {
      resets++;
      reset();
    };
    p.state.setAnimation(0, "blip");
    p.c.step(p.state, 1 / 60);
    resets = 0;
    for (let i = 0; i < 4; i++) p.c.step(p.state, 1 / 60);
    expect(resets).toBeGreaterThanOrEqual(4);
  });

  it("a static rig without physics keeps the full cache benefit", () => {
    const p = physicsRig(null, { short });
    p.state.setAnimation(0, "short");
    for (let i = 0; i < 12; i++) p.c.step(p.state, 1 / 60);
    const evaluations = p.c.stats.poseEvaluations;
    for (let i = 0; i < 60; i++) expect(p.c.step(p.state, 1 / 60)).toBe(false);
    expect(p.c.stats.poseEvaluations).toBe(evaluations);
  });
});
