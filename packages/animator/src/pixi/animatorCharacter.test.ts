import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "../core/attachments.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { AnimationState, AnimationStateData, heldClipTime, heldPhaseForSeed } from "../core/animationState.js";
import { Skeleton } from "../core/skeleton.js";
import { Container } from "pixi.js";
import { buildStroke, STROKE_JOIN_ERROR, strokeIndexCount, strokeJoinError, strokeVertexCount } from "../core/contours.js";
import { AnimatorCharacter, quantizeDisplayScale, setTint } from "./animatorCharacter.js";
import { AnimatorDebugOverlay, vertexWeights } from "./debugOverlay.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import { packedAtlasImages } from "./partImages.js";

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const rigDocument = loadAnimDocument(readFileSync(fixture("three-part.anim.json"), "utf8"));
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));

function character(skins = ["body"], atlas = new DynamicAtlas({ pageSize: 512 })) {
  const skeleton = new Skeleton(rigDocument);
  skeleton.setActiveSkins(skins);
  return { atlas, character: new AnimatorCharacter({ skeleton, atlas, images }) };
}

const names = (c: AnimatorCharacter) => c.slotMeshes.map((mesh) => mesh.label);

describe("AnimatorCharacter", () => {
  it("setTint matches Pixi's tint setter (localColor, update flag, render-group notification)", () => {
    for (const rgb of [0xffffff, 0xff8040, 0x102030, 0x000000, 0xc0ffc0]) {
      const viaSetter = new Container();
      const viaHelper = new Container();
      viaSetter.tint = rgb;
      setTint(viaHelper, rgb);
      expect(viaHelper.localColor).toBe(viaSetter.localColor);
      expect(viaHelper._updateFlags).toBe(viaSetter._updateFlags);
      expect(viaHelper.tint).toBe(rgb);
    }
  });

  it("builds one batched mesh per slot, in draw order, all on the shared atlas page", () => {
    const { atlas, character: c } = character(["body", "tunic"]);
    c.update();
    expect(names(c)).toEqual(["base", "torso", "tunic", "head"]);
    for (const mesh of c.slotMeshes) {
      expect(mesh.visible).toBe(true);
      expect(mesh.batched).toBe(true);
      expect(mesh.texture).toBe(atlas.pages[0]?.texture);
    }
    expect(atlas.stats()).toMatchObject({ pages: 1, residentImages: 4, referencedImages: 4 });
  });

  it("writes the skinned vertices into the mesh positions every update, in place", () => {
    const { character: c } = character();
    const torsoMesh = c.slotMeshes[1];
    const positions = torsoMesh?.geometry.positions;
    c.skeleton.getBone("chest").pose.rotation = 45;
    c.update();
    expect(torsoMesh?.geometry.positions).toBe(positions); // same buffer, no reallocation
    const expected = new Float32Array(20);
    c.skeleton.computeSlotWorldVertices(c.skeleton.getSlot("torso"), expected);
    expect(Array.from(positions ?? [])).toEqual(Array.from(expected));
    // Spot-check against the rig: the joint row sits between the straight hips and the bent chest.
    expect(positions?.[0]).toBeCloseTo(-30, 4); // v0 world (-30, -40)
    expect(positions?.[1]).toBeCloseTo(-40, 4);
  });

  it("maps image UVs onto the atlas region", () => {
    const { atlas, character: c } = character();
    c.update();
    const head = c.slotMeshes[3];
    expect(head?.label).toBe("head");
    const uvs = Array.from(head?.geometry.uvs ?? []);
    // body/head is 50x50 at scale 1, packed at 0.5 with a 2 px gutter: a 25 px square.
    const size = atlas.pageSize;
    const u0 = uvs[0] as number;
    const v0 = uvs[1] as number;
    expect(uvs).toEqual([u0, v0, u0 + 25 / size, v0, u0 + 25 / size, v0 + 25 / size, u0, v0 + 25 / size].map((v) => Math.fround(v)));
    expect((u0 * size) % 1).toBeCloseTo(0, 6);
  });

  it("follows slot colour and attachment colour, and hides slots that show nothing", () => {
    const { character: c } = character(["body", "tunic"]);
    const slot = c.skeleton.getSlot("head");
    slot.color.r = 0.5;
    slot.color.a = 0.25;
    c.syncFromSkeleton();
    const head = c.slotMeshes[3];
    expect(head?.tint).toBe(0x80ffff);
    expect(head?.alpha).toBe(0.25);
    slot.color.a = 0;
    c.syncFromSkeleton();
    expect(head?.visible).toBe(false);
    slot.color.a = 1;
    c.skeleton.getSlot("tunic").placeholder = null;
    c.update();
    expect(head?.visible).toBe(true);
    expect(c.slotMeshes[2]?.visible).toBe(false);
  });

  it("re-sorts its meshes only when the skeleton's draw order changes", () => {
    const { character: c } = character(["body", "tunic"]);
    c.skeleton.drawOrderOffsets[c.skeleton.getSlot("head").index] = -3;
    c.update();
    expect(names(c)).toEqual(["head", "base", "torso", "tunic"]);
    c.skeleton.setToSetupPose();
    c.update();
    expect(names(c)).toEqual(["base", "torso", "tunic", "head"]);
  });

  it("acquires textures for a new outfit and releases the old one", () => {
    const { atlas, character: c } = character(["body", "tunic"]);
    expect(atlas.references("swag/tunic/torso")).toBe(1);
    c.setActiveSkins(["body"]);
    expect(atlas.references("swag/tunic/torso")).toBe(0);
    expect(atlas.references("body/torso")).toBe(1);
    c.update();
    expect(c.slotMeshes[2]?.visible).toBe(false);
    c.destroy();
    expect(atlas.stats().referencedImages).toBe(0);
  });

  it("uploads the atlas page once for a whole outfit, on the first sync", () => {
    const atlas = new DynamicAtlas({ pageSize: 512 });
    atlas.acquire("warm-up", () => ({ pixels: { width: 1, height: 1, data: new Uint8Array(4) }, rect: { x: 0, y: 0, width: 1, height: 1 }, pixelScale: 1 }));
    atlas.flush();
    let updates = 0;
    atlas.pages[0]?.texture.source.on("update", () => updates++);
    const { character: c } = character(["body", "tunic"], atlas); // four new images, then a sync
    expect(updates).toBe(1);
    c.update();
    expect(updates).toBe(1);
  });

  it("characters share atlas regions", () => {
    const atlas = new DynamicAtlas({ pageSize: 512 });
    const a = character(["body"], atlas).character;
    const b = character(["body"], atlas).character;
    expect(atlas.references("body/torso")).toBe(2);
    expect(a.slotMeshes[1]?.texture).toBe(b.slotMeshes[1]?.texture);
    expect(Array.from(a.slotMeshes[1]?.geometry.uvs ?? [])).toEqual(Array.from(b.slotMeshes[1]?.geometry.uvs ?? []));
  });

  it("reports outfit textures no provider has", () => {
    const skeleton = new Skeleton(rigDocument);
    skeleton.setActiveSkins(["body", "tunic"]);
    const c = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images: { get: (path) => (path === "swag/tunic/torso" ? undefined : images.get(path)) } });
    expect(c.missingTextures).toEqual(["swag/tunic/torso"]);
    c.update();
    expect(c.slotMeshes[2]?.visible).toBe(false);
  });
});

describe("debug overlay", () => {
  it("draws without throwing and computes per-vertex weights of a bone", () => {
    const { character: c } = character(["body", "tunic"]);
    c.update();
    const overlay = new AnimatorDebugOverlay();
    overlay.draw(c.skeleton, { weightsFor: "chest" });
    const torso = c.skeleton.getSlot("torso").attachment as MeshAttachment;
    expect(Array.from(vertexWeights(torso, c.skeleton.getBone("chest").index, c.skeleton.getBone("hips").index))).toEqual([
      0, 0, 0.5, 1, 1, 1, 1, 0.5, 0, 0
    ]);
  });
});

describe("AnimatorCharacter held-pose cache ()", () => {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
  raw.animations = {
    sway: { duration: 1, loop: true, bones: { chest: { rotate: [{ time: 0, value: 0 }, { time: 0.5, value: 30 }, { time: 1, value: 0 }] } } },
    lean: { duration: 1, loop: true, fps: 10, bones: { chest: { rotate: [{ time: 0, value: -20 }, { time: 1, value: -20 }] } } }
  };
  const doc = loadAnimDocument(raw);
  const setup = () => {
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const c = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });
    const state = new AnimationState(new AnimationStateData(doc));
    state.heldFrames = true;
    state.setAnimation(0, "sway");
    return { c, state };
  };

  it("held phases spread a synchronized crowd's refreshes over display frames; each shows certified frames for exactly 1 / fps", () => {
    const states = [0, 0.5].map((phase) => {
      const { c, state } = setup();
      state.heldPhase = phase;
      c.updateHeld(state);
      return { c, state, switches: [] as number[] };
    });
    for (let i = 1; i <= 24; i++) {
      for (const s of states) {
        s.state.update(1 / 60);
        if (s.c.updateHeld(s.state)) s.switches.push(i);
      }
    }
    const [a, b] = states as [(typeof states)[number], (typeof states)[number]];
    // Phase 0 refreshes on even display frames, phase 1/2 on odd ones: never together.
    expect(a.switches.every((f) => f % 2 === 0)).toBe(true);
    expect(b.switches.every((f) => f % 2 === 1)).toBe(true);
    expect(a.switches).toHaveLength(12);
    expect(b.switches).toHaveLength(12);
    // Each switch is exactly one held frame (2 display frames) after the last, and only grid frames are shown.
    for (let k = 1; k < b.switches.length; k++) expect(b.switches[k]! - b.switches[k - 1]!).toBe(2);
    expect(heldClipTime(24 / 60, 1, true, 30, 0.5) * 30).toBeCloseTo(Math.round(heldClipTime(24 / 60, 1, true, 30, 0.5) * 30), 9);
  });

  it("held phases are deterministic per character: seed hash, explicit option, else 0", () => {
    const data = new AnimationStateData(doc);
    expect(new AnimationState(data).heldPhase).toBe(0);
    expect(new AnimationState(data, { phaseSeed: 7, heldPhase: 0 }).heldPhase).toBe(0);
    const phases = Array.from({ length: 50 }, (_, i) => new AnimationState(data, { phaseSeed: i }).heldPhase);
    // Same seed, same phase, whatever the creation order.
    expect(Array.from({ length: 50 }, (_, i) => new AnimationState(data, { phaseSeed: 49 - i }).heldPhase).reverse()).toEqual(phases);
    expect(new AnimationState(data, { phaseSeed: "player:abc" }).heldPhase).toBe(heldPhaseForSeed("player:abc"));
    const half = phases.filter((p) => p === 0.5).length;
    expect(phases.every((p) => p === 0 || p === 0.5)).toBe(true);
    expect(half).toBeGreaterThan(15);
    expect(half).toBeLessThan(35);
  });

  it("evaluates once per displayed frame (30 fps default) and does zero work on hits", () => {
    const { c, state } = setup();
    c.updateHeld(state);
    const before = { ...c.stats, rebuilds: c.contourRebuilds };
    // 60 display frames of 1/60 s: 30 held frames, so 30 misses and 30 hits.
    for (let i = 0; i < 60; i++) {
      state.update(1 / 60);
      c.updateHeld(state);
    }
    expect(c.stats.cacheMisses - before.cacheMisses).toBe(30);
    expect(c.stats.cacheHits - before.cacheHits).toBe(30);
    expect(c.stats.poseEvaluations - before.poseEvaluations).toBe(30);
    // A hit touches nothing: no evaluation, no buffer update, no stroke rebuild.
    const mid = { ...c.stats, rebuilds: c.contourRebuilds };
    expect(c.updateHeld(state)).toBe(false);
    expect(c.stats.poseEvaluations).toBe(mid.poseEvaluations);
    expect(c.stats.bufferUpdates).toBe(mid.bufferUpdates);
    expect(c.contourRebuilds).toBe(mid.rebuilds);
  });

  it("holds the sampled pose between frames and matches exact sampling at frame times", () => {
    const { c, state } = setup();
    state.update(0.1 + 0.01); // frame 3 (t = 0.1)
    c.updateHeld(state);
    expect(c.skeleton.getBone("chest").pose.rotation).toBeCloseTo(6, 9);
  });

  it("a container move hits; outfit, display scale and invalidate() miss", () => {
    const { c, state } = setup();
    c.updateHeld(state);
    c.position.set(40, 25);
    expect(c.updateHeld(state)).toBe(false);
    c.scale.set(2);
    expect(c.updateHeld(state)).toBe(true);
    c.invalidate();
    expect(c.updateHeld(state)).toBe(true);
    c.setActiveSkins(["body", "tunic"]);
    expect(c.updateHeld(state)).toBe(true);
    expect(c.updateHeld(state)).toBe(false);
  });

  it("a pinch-zoom misses only when it crosses a display-scale step; between steps the strokes scale", () => {
    const { c, state } = setup();
    c.updateHeld(state);
    const misses: number[] = [];
    // 0.75x -> 1.5x -> 0.75x over 240 display frames (no animation time: only the zoom changes).
    for (let i = 1; i <= 240; i++) {
      const f = i <= 120 ? i / 120 : (240 - i) / 120;
      c.scale.set(0.75 * 2 ** f);
      if (c.updateHeld(state)) misses.push(i);
    }
    // One octave is 8 steps of 1/8: 8 crossings up and 8 down (the turn-around frame may add one).
    expect(misses.length).toBeGreaterThanOrEqual(15);
    expect(misses.length).toBeLessThanOrEqual(17);
    c.contourScaleStep = 0; // exact: every scale change misses
    let exact = 0;
    for (let i = 1; i <= 20; i++) {
      c.scale.set(1 + i / 1000);
      if (c.updateHeld(state)) exact++;
    }
    expect(exact).toBe(20);
  });

  it("quantized strokes stay inside the stroke/AA gates at the worst in-step scale", () => {
    const step = 1 / 8;
    const ramp = { u0: 0, u1: 1, v: 0, rampFraction: 1 / 64 }; // no clamp at the centre for these widths
    const positions = new Float32Array(strokeVertexCount(2, false, false) * 2);
    const uvs = new Float32Array(positions.length);
    const indices = new Uint32Array(strokeIndexCount(2, false, false));
    for (let k = 0; k <= 400; k++) {
      const s = 0.3 * 2 ** (k / 100); // 0.3 .. 4.8, dense inside every step
      const q = quantizeDisplayScale(s, step);
      // Rounded up, by less than one step: the displayed AA band (s / q display px) is in (2^-step, 1].
      expect(q).toBeGreaterThanOrEqual(s * (1 - 1e-12));
      expect(s / q).toBeGreaterThan(2 ** -step);
      // Join error in display px at the displayed scale: within the budget wherever an exact build is
      // (very sharp turns exceed it at STROKE_MAX_ARC_STEPS either way; never by more than exact).
      for (const width of [1.5, 3, 8]) {
        const radiusDisplayBuilt = (width / 2 + 1 / q / 2) * q;
        const radiusDisplayExact = (width / 2 + 1 / s / 2) * s;
        for (let turn = 0.05; turn < Math.PI; turn += 0.05) {
          const exact = strokeJoinError(turn, radiusDisplayExact);
          expect(strokeJoinError(turn, radiusDisplayBuilt) * (s / q)).toBeLessThanOrEqual(Math.max(STROKE_JOIN_ERROR, exact) + 1e-12);
        }
      }
      // Coverage-integrated width of a straight stroke built for q, shown at s: exactly w (display px).
      const width = 3;
      buildStroke([0, 0, 10, 0], 2, false, false, width, 1 / q, ramp, positions, uvs, indices);
      let rim = 0;
      for (let v = 1; v < positions.length; v += 2) rim = Math.max(rim, Math.abs(positions[v]!));
      const uRim = 0;
      let uCentre = 0;
      for (let v = 0; v < positions.length; v += 2) if (Math.abs(positions[v + 1]!) < 1e-6) uCentre = Math.max(uCentre, uvs[v]!);
      const alpha = (u: number) => Math.min(1, Math.max(0, (u - ramp.u0) / ((ramp.u1 - ramp.u0) * ramp.rampFraction)));
      const n = 4000;
      let covered = 0;
      for (let j = 0; j < n; j++) {
        const d = ((j + 0.5) / n) * rim; // distance from the centreline, canvas px
        covered += alpha(uCentre + ((uRim - uCentre) * d) / rim) * (rim / n) * s;
      }
      expect(Math.abs(2 * covered - width * s)).toBeLessThan(1e-3);
    }
  });

  it("a clip transition steps the crossfade on the frame grid and invalidates", () => {
    const { c, state } = setup();
    c.updateHeld(state);
    state.setAnimation(0, "lean", { mix: 0.2 });
    expect(c.updateHeld(state)).toBe(true); // new entry
    state.update(0.05); // lean is 10 fps: mix still on step 0 at 0.05 s, sway moves frame
    expect(c.updateHeld(state)).toBe(true);
    let misses = 0;
    for (let i = 0; i < 30; i++) {
      state.update(1 / 60);
      if (c.updateHeld(state)) misses++;
    }
    expect(misses).toBeGreaterThan(0);
    expect(misses).toBeLessThan(30);
  });
});
