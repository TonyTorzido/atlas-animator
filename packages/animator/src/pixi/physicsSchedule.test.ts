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
 * Physics scheduling apart from the draw cache (the design notes
 * item 1): a cached run (updateHeld hits whenever it may) and an uncached run (invalidate() before
 * every frame) over the same time sequence give the same skeleton, at simulation rates of 1, 2, 3,
 * 30 and 60 steps/s.
 */

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));

const short = { duration: 0.1, bones: { chest: { rotate: [{ time: 0, value: 0 }, { time: 0.1, value: 5 }] } } };
const still = { duration: 1, loop: true, bones: {} };

function rig(physics: Record<string, unknown> | null, clip: string) {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
  raw.animations = { short, still };
  raw.physics = physics ? [{ name: "sway", bone: "chest", x: 1, y: 1, rotate: 1, inertia: 1, strength: 100, damping: 0.9, ...physics }] : [];
  const doc = loadAnimDocument(raw);
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body"]);
  const c = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });
  c.contourPixelScale = 1;
  const state = new AnimationState(new AnimationStateData(doc));
  state.heldFrames = true;
  state.setAnimation(0, clip);
  return { c, skeleton, state };
}

type Rig = ReturnType<typeof rig>;
interface Scenario {
  physics: Record<string, unknown>;
  clip: string;
  /** Called before frame `i` on both runs; returns that frame's delta (default 1/60). */
  before?: (r: Rig, i: number) => number | void;
}

const scenarios: Record<string, Scenario> = {
  "constant pose": { physics: { gravity: 80 }, clip: "still", before: (r) => void (r.state.timeScale = 0) },
  "stopped clip": { physics: { wind: 60 }, clip: "short" },
  "small persistent force": { physics: { gravity: 2, strength: 1, rotate: 0 }, clip: "short" },
  reset: { physics: { gravity: 80 }, clip: "still", before: (r, i) => void (i === 120 && r.skeleton.resetPhysics()) },
  "character movement": { physics: {}, clip: "still", before: (r, i) => void (i >= 20 && i < 50 && r.c.moveWorld(3, 0)) },
  "long pause": { physics: { gravity: 80 }, clip: "still", before: (_r, i) => (i === 90 ? 2 : undefined) }
};

const world = (s: Skeleton) => s.bones.flatMap((b) => [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y]);

describe("physics scheduling: cached vs uncached equivalence (item 1)", () => {
  for (const fps of [1, 2, 3, 30, 60]) {
    for (const [name, scenario] of Object.entries(scenarios)) {
      it(`${name} at ${fps} steps/s`, () => {
        // Springs stiff enough to move, inside the F7 stability bound at every rate.
        const physics = { fps, strength: Math.min(100, 1.5 * fps * fps), ...scenario.physics };
        const cached = rig(physics, scenario.clip);
        const plain = rig(physics, scenario.clip);
        let worst = 0;
        for (let i = 0; i < 300; i++) {
          const dt = scenario.before?.(cached, i) ?? 1 / 60;
          scenario.before?.(plain, i);
          cached.c.step(cached.state, dt);
          plain.c.invalidate();
          plain.c.step(plain.state, dt);
          const a = world(cached.skeleton);
          const b = world(plain.skeleton);
          for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
        }
        expect(worst).toBeLessThan(1e-6);
      });
    }
  }

  it("the simulation actually runs at 1 step/s under the cache (no stall behind the catch-up limit)", () => {
    const r = rig({ fps: 1, strength: 1.5, gravity: 80 }, "still");
    r.c.step(r.state, 1 / 60);
    const start = r.skeleton.getBone("chest").world.y;
    for (let i = 0; i < 180; i++) r.c.step(r.state, 1 / 60);
    expect(r.skeleton.getBone("chest").world.y - start).toBeGreaterThan(0.05);
  });

  it("asleep physics and static rigs keep their cache hits", () => {
    const r = rig({ gravity: 80 }, "still");
    r.state.timeScale = 0;
    for (let i = 0; i < 900; i++) r.c.step(r.state, 1 / 60);
    expect(r.skeleton.physicsSettled).toBe(true);
    const evaluations = r.c.stats.poseEvaluations;
    for (let i = 0; i < 60; i++) expect(r.c.step(r.state, 1 / 60)).toBe(false);
    expect(r.c.stats.poseEvaluations).toBe(evaluations);
    // Movement wakes it.
    r.c.moveWorld(10, 0);
    expect(r.c.step(r.state, 1 / 60)).toBe(true);
    expect(r.skeleton.physicsSettled).toBe(false);
  });

  it("a display-scale change rebuilds geometry without re-sampling the pose", () => {
    const r = rig(null, "still");
    r.state.timeScale = 0;
    r.c.step(r.state, 1 / 60);
    const samples = r.c.stats.poseSamples;
    const evaluations = r.c.stats.poseEvaluations;
    r.c.contourPixelScale = 3;
    expect(r.c.step(r.state, 1 / 60)).toBe(true);
    expect(r.c.stats.poseSamples).toBe(samples);
    expect(r.c.stats.poseEvaluations).toBe(evaluations);
  });
});

describe("per-stage counters (item 8, measurement only)", () => {
  it("sampling + constraints add up to pose time; uploads are counted on misses only", () => {
    const r = rig({ gravity: 80 }, "short");
    let t = 0;
    r.c.profiler = () => (t += 1); // every clock read advances 1 ms
    r.c.step(r.state, 1 / 60);
    const s = r.c.stats;
    expect(s.msSample).toBeGreaterThan(0);
    expect(s.msConstraints).toBeGreaterThan(0);
    expect(s.msSample + s.msConstraints).toBe(s.msPose);
    expect(s.uploadBytes).toBeGreaterThan(0);
    for (let i = 0; i < 900; i++) r.c.step(r.state, 1 / 60);
    const bytes = s.uploadBytes;
    expect(r.c.step(r.state, 1 / 60)).toBe(false);
    expect(s.uploadBytes).toBe(bytes);
  });
});
