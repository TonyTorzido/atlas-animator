import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { softRender } from "../tools/softRender.js";
import { AnimatorCharacter } from "./animatorCharacter.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import { packedAtlasImages } from "./partImages.js";

/*
 * Plan part c: garment-owned outlines. A contour draws only while its owning attachment is
 * displayed (the bound mesh, or `owner`), in the core rule (Skeleton.isContourVisible), the Pixi
 * renderer and the software renderer; a garment swap switches the outline sets in the same frame.
 */

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));

/**
 * The three-part rig: the body's own outline on the torso mesh (bound mesh = owner), a tunic
 * outline drawn on the torso mesh but owned by the tunic (explicit `owner`), a skin replacing the
 * torso with a region (the body outline must go) and one replacing it with a linked mesh of it
 * (same deform: the outline stays). Clip `strip`: tunic removed then replaced while posed.
 */
function document(tunicShown = true) {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8"));
  if (!tunicShown) for (const s of raw.slots) if (s.name === "tunic") delete s.attachment;
  raw.skins.body.contours = { torso: { side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4], width: 3, color: "201810ff" } } };
  raw.skins.tunic.contours = { tunic: { hem: { mesh: { skin: "body", slot: "torso", attachment: "torso" }, points: [5, 6, 7, 8, 9], width: 3, color: "404040ff", owner: { slot: "tunic", attachment: "tunic" } } } };
  raw.skins.bare = { attachments: { torso: { torso: { type: "region", path: "body/base", width: 10, height: 10 } } } };
  raw.skins.linked = { attachments: { torso: { torso: { type: "linkedMesh", path: "body/torso", source: { skin: "body", slot: "torso", attachment: "torso" }, width: 60, height: 120 } } } };
  raw.animations = {
    strip: {
      duration: 1,
      bones: { chest: { rotate: [{ time: 0, value: 25 }] } },
      slots: { tunic: { attachment: [{ time: 0.3, name: null }, { time: 0.6, name: "tunic" }] } }
    }
  };
  return loadAnimDocument(raw);
}

function make(skins: string[], tunicShown = true) {
  const doc = document(tunicShown);
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(skins);
  const c = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });
  c.contourPixelScale = 1;
  const state = new AnimationState(new AnimationStateData(doc));
  return { c, skeleton, state };
}

const drawn = (s: Skeleton) => s.activeContours.filter((k) => s.isContourVisible(k)).map((k) => `${k.slot}/${k.name}`);
const visibleMeshes = (c: AnimatorCharacter) => c.contourMeshes.map((m) => m.visible);

describe("contour ownership (part c)", () => {
  it("garment shown: its outline draws; hidden: it does not; the body outline is untouched", () => {
    const { c, skeleton } = make(["body", "tunic"]);
    c.update();
    expect(drawn(skeleton)).toEqual(["torso/side", "tunic/hem"]);
    expect(visibleMeshes(c)).toEqual([true, true]);
    const off = make(["body", "tunic"], false);
    off.c.update();
    expect(drawn(off.skeleton)).toEqual(["torso/side"]);
    expect(visibleMeshes(off.c)).toEqual([true, false]);
  });

  it("a slot hide of the user hides the outline even though another slot owns its draw position", () => {
    const { skeleton } = make(["body", "tunic"]);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform("none");
    skeleton.getSlot("tunic").hidden = true;
    expect(drawn(skeleton)).toEqual(["torso/side"]);
  });

  it("bare torso (a region replaces the mesh): the mesh's outline goes; a linked mesh of it keeps it", () => {
    const bare = make(["body", "bare"]);
    bare.c.update();
    expect(drawn(bare.skeleton)).toEqual([]);
    const linked = make(["body", "linked"]);
    linked.c.update();
    expect(drawn(linked.skeleton)).toEqual(["torso/side"]);
  });

  it("an outfit swap switches the outline sets in one transaction (same frame)", () => {
    const { c, skeleton } = make(["body", "tunic"]);
    c.update();
    expect(drawn(skeleton)).toEqual(["torso/side", "tunic/hem"]);
    c.setActiveSkins(["body", "bare"]);
    c.update();
    expect(drawn(skeleton)).toEqual([]);
    expect(visibleMeshes(c).every((v) => !v)).toBe(true);
    c.setActiveSkins(["body", "tunic"]);
    c.update();
    expect(visibleMeshes(c)).toEqual([true, true]);
  });

  it("removed and replaced while posed: hidden on the removal frame, rebuilt on return (no stale stroke)", () => {
    const { c, skeleton, state } = make(["body", "tunic"]);
    state.setAnimation(0, "strip");
    const at = (t: number) => {
      state.update(t);
      state.apply(skeleton);
      c.update();
    };
    at(0.1);
    const before = Array.from(c.contourMeshes[1]!.geometry.positions);
    at(0.3);
    expect(visibleMeshes(c)).toEqual([true, false]);
    at(0.3);
    expect(visibleMeshes(c)).toEqual([true, true]);
    expect(Array.from(c.contourMeshes[1]!.geometry.positions)).toEqual(before);
  });

  it("the software renderer follows the same rule (no tunic ink with the tunic hidden)", () => {
    const { skeleton } = make(["body", "tunic"]);
    const ink = (hide: boolean) => {
      skeleton.setToSetupPose();
      skeleton.updateWorldTransform("none");
      if (hide) skeleton.getSlot("tunic").attachment = null;
      const img = softRender(skeleton, new Map(), { width: 200, height: 260, scale: 1, left: -100, top: -200 }).image;
      let grey = 0;
      for (let p = 0; p < img.data.length; p += 4) if (img.data[p] === 0x40 && img.data[p + 1] === 0x40 && img.data[p + 2] === 0x40 && (img.data[p + 3] as number) > 0) grey++;
      return grey;
    };
    expect(ink(false)).toBeGreaterThan(0);
    expect(ink(true)).toBe(0);
  });
});
