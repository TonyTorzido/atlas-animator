import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData, BoneMask } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimatorCharacter } from "./animatorCharacter.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import { packedAtlasImages } from "./partImages.js";

/*
 * Allocation regression test (plan, Phase 2 review): in steady state update(), apply(),
 * updateWorldTransform() and syncFromSkeleton() allocate nothing, including the IK (one and two
 * bone, softness, stretch), transform (world and local) and physics constraints (Phase 3; a
 * five-bone cape chain on every channel, with keyed mixes and a reset key, while the skeleton
 * moves through the world), and the Phase joint-ready parts (the torso as two draw groups of
 * one skinned mesh, a mesh-bound and a bone-bound contour rebuilt as the pose changes, a two-driver
 * corrective grid on the torso). Warm up, force a GC, run 2000
 * frames (far less garbage than a young-generation scavenge would need to trigger, so any garbage
 * stays counted in heapUsed), and require less than 32 bytes of heap growth per frame. Needs
 * --expose-gc (vitest.config.ts passes it to the test workers); skipped without it.
 */

const gc = (globalThis as { gc?: () => void }).gc;
const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);

function scene() {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8")) as {
    bones: Record<string, unknown>[];
    skins: Record<string, unknown>;
    ik?: unknown[];
    transform?: unknown[];
    physics?: unknown[];
    animations: Record<string, unknown>;
    slots: Record<string, unknown>[];
    drivenGrids?: unknown[];
  };
  // Constraints (Phase 3): an IK arm reaching for a target, a one-bone aim, a hat that follows the
  // head in world space, a local relative follower, and a skin-gated five-bone physics cape.
  raw.bones.push(
    { name: "arm_u", parent: "chest", x: 50, rotation: 90, length: 30 },
    { name: "arm_l", parent: "arm_u", x: 30, length: 30 },
    { name: "eye", parent: "head", x: 30, length: 10 },
    { name: "hand_target", parent: "root", x: 40, y: -60 },
    { name: "hat", parent: "root" },
    { name: "follower", parent: "hips", x: 10 }
  );
  const capeBones: string[] = [];
  const capeConstraints: string[] = [];
  raw.physics = [];
  for (let i = 0; i < 5; i++) {
    const name = `cape${i}`;
    raw.bones.push({ name, parent: i === 0 ? "chest" : `cape${i - 1}`, x: i === 0 ? 55 : 20, rotation: i === 0 ? 180 : 0, length: 20, skin: true });
    raw.physics.push({ name, bone: name, x: 0.5, y: 0.5, rotate: 1, scaleX: 0.3, shearX: 0.2, inertia: 0.6, strength: 120, damping: 0.85, gravity: 400, wind: 30, skin: true });
    capeBones.push(name);
    capeConstraints.push(name);
  }
  raw.skins["cape"] = { attachments: {}, bones: capeBones, constraints: capeConstraints };
  raw.ik = [
    { name: "arm", bones: ["arm_u", "arm_l"], target: "hand_target", softness: 5, stretch: true },
    { name: "look", bones: ["eye"], target: "hand_target", compress: true, uniform: true }
  ];
  raw.transform = [
    { name: "hat", bones: ["hat"], target: "head", mixRotate: 0.5, offset: { y: -20 } },
    { name: "follow", bones: ["follower"], target: "chest", local: true, relative: true, mixX: 0.5 }
  ];
  // Phase: draw groups, contours (mesh-bound and bone-bound) and a corrective grid.
  raw.slots.push({ name: "torso_upper", bone: "chest" }, { name: "outline", bone: "root" });
  const body = raw.skins["body"] as { attachments: { torso: { torso: Record<string, unknown> } }; contours?: unknown };
  body.attachments.torso.torso["groups"] = { torso: [[0, 4]], torso_upper: [[4, 8]] };
  body.contours = {
    outline: {
      side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, [1, 2, 7, 0.5, 0.25], 3, 4], width: 3 },
      ring: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], closed: true, width: 2 },
      brow: { bones: ["head", "chest"], vertices: [1, 0, 30, -10, 1, 2, 0, 30, 10, 0.5, 1, 0, 0, 0.5], width: 2, visible: [{ bone: "head", min: -90, max: 90 }] }
    }
  };
  raw.drivenGrids = [
    {
      name: "torso_combo",
      x: { bone: "chest", at: [-20, 0, 20] },
      y: { bone: "hips", at: [-10, 10] },
      keys: [{}, { deform: { body: { torso: { torso: { offset: 2, vertices: [1, -1] } } } } }, {}, {}, {}, { deform: { body: { torso: { torso: { vertices: [2, 2] } } } } }]
    }
  ];
  // Exercise the other timeline kinds too: deform, slot colour, attachment, draw order.
  raw.animations["extras"] = {
    duration: 1,
    loop: true,
    deform: { body: { torso: { torso: [{ time: 0, vertices: [0, 0, 2, 1] }, { time: 0.5, offset: 4, vertices: [3, -2], curve: [0.42, 0, 0.58, 1] }, { time: 1, vertices: [0, 0] }] } } },
    slots: { tunic: { color: [{ time: 0, color: "ffffffff" }, { time: 0.5, color: "c0ffc0ff" }, { time: 1, color: "ffffffff" }] }, head: { attachment: [{ time: 0, name: "head" }] } },
    drawOrder: [{ time: 0, offsets: [{ slot: "head", offset: -1 }] }],
    ik: { arm: [{ time: 0, mix: 1 }, { time: 0.5, mix: 0.6, softness: 12 }, { time: 1, mix: 1 }] },
    transform: { hat: [{ time: 0, mixRotate: 0.5 }, { time: 0.5, mixRotate: 1 }, { time: 1, mixRotate: 0.5 }] },
    physics: { cape2: { mix: [{ time: 0, value: 1 }, { time: 0.5, value: 0.5 }, { time: 1, value: 1 }], reset: [{ time: 0.9 }] } }
  };
  const doc = loadAnimDocument(raw);
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
  const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
  const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["body", "tunic", "cape"]);
  const character = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });

  const state = new AnimationState(new AnimationStateData(doc));
  let events = 0;
  state.addListener({ event: () => events++, complete: () => events++ });
  state.setTrackMask(1, BoneMask.of(doc, ["chest"]));
  state.setAnimation(0, "walk");
  state.setAnimation(1, "attack", { loop: true });
  state.setAnimation(2, "extras", { blend: "add", alpha: 0.5 });
  let tick = 0;
  const frame = () => {
    state.update(1 / 60);
    skeleton.update(1 / 60);
    // Walk back and forth through the world, so physics has motion to react to.
    skeleton.x = 80 * Math.sin(++tick * 0.05);
    state.apply(skeleton);
    character.update(); // updateWorldTransform + syncFromSkeleton
  };
  frame();
  // A crossfade that stays in progress for the whole measurement (mixing path, rotation memory).
  state.setAnimation(0, "idle", { mix: 1000 });
  return { frame, events: () => events, skeleton, character };
}

describe.skipIf(!gc)("steady-state allocation", () => {
  it("update + apply + updateWorldTransform + syncFromSkeleton allocate nothing per frame", () => {
    const { frame, events, skeleton, character } = scene();
    // Warm up until the optimizing compiler has taken every per-frame function (functions called
    // once a frame need about 10k frames; before that, baseline code boxes numbers it later keeps
    // unboxed), plans are built and lazily sized buffers exist.
    for (let i = 0; i < 15000; i++) frame();
    const firedBefore = events();
    const rebuildsBefore = character.contourRebuilds;
    const FRAMES = 2000;
    (gc as () => void)();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < FRAMES; i++) frame();
    const growth = process.memoryUsage().heapUsed - before;
    expect(events() - firedBefore, "events and completes fired during the measurement").toBeGreaterThan(50);
    // The constraints really ran: the cape is simulating and the arm reaches for its target.
    expect(skeleton.updateSteps.filter((step) => step.kind !== "bone")).toHaveLength(9);
    expect(Math.abs(skeleton.physicsConstraints[4]?.rotateOffset ?? 0)).toBeGreaterThan(1e-4);
    // The joint-ready parts really ran: both draw groups drawn, strokes rebuilt as the pose moved.
    expect(character.slotMeshes.filter((mesh) => mesh.label.startsWith("torso") && mesh.visible)).toHaveLength(2);
    expect(character.contourRebuilds - rebuildsBefore).toBeGreaterThan(FRAMES);
    expect(growth / FRAMES, `heap growth ${growth} bytes over ${FRAMES} frames`).toBeLessThan(32);
  });
});
