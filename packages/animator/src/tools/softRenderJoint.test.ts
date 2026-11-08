import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { createImage } from "./image.js";
import { softRender } from "./softRender.js";

/*
 * Phase in the CPU soft renderer (validators and review sheets): grouped meshes draw per
 * group at each group's slot, contours draw after their owner slot as flat stroke polygons whose
 * pixels carry the user slot in the id buffer (texel -1).
 */

function document() {
  const raw = JSON.parse(readFileSync(new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url), "utf8")) as {
    slots: Record<string, unknown>[];
    skins: { body: { attachments: { torso: { torso: Record<string, unknown> } }; contours?: unknown } };
  };
  raw.slots.push({ name: "torso_upper", bone: "chest" }, { name: "outline", bone: "root" });
  raw.skins.body.attachments.torso.torso["groups"] = { torso: [[0, 4]], torso_upper: [[4, 8]] };
  // The torso's left edge (local y = -30 on the upward hips/chest chain: world x = -30).
  raw.skins.body.contours = { outline: { side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4], width: 3, color: "102030ff" } } };
  return loadAnimDocument(raw);
}

describe("soft renderer: draw groups and contours", () => {
  it("draws each group at its slot and each contour over its owner slot, with ids", () => {
    const doc = document();
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    skeleton.updateWorldTransform();
    const textures = new Map(
      skeleton.attachments.texturePaths.map((path) => {
        const image = createImage(16, 16);
        image.data.fill(255);
        return [path, image] as const;
      })
    );
    const { image, topSlot, topTexel } = softRender(skeleton, textures, { width: 256, height: 256, left: -128, top: -230, ids: true });
    const id = (name: string) => skeleton.getSlot(name).index + 1;
    const at = (x: number, y: number) => ({ slot: topSlot![y * 256 + x], texel: topTexel![y * 256 + x] });
    // World (10, -70) is in the lower group, (10, -130) in the upper one (pixel = world + origin).
    expect(at(138, 160).slot).toBe(id("torso"));
    expect(at(138, 100).slot).toBe(id("torso_upper"));
    expect(at(138, 100).texel).toBeGreaterThanOrEqual(0);
    // The contour along world x = -30 is drawn (dark) over the torso and owned by `outline`.
    expect(at(98, 115)).toEqual({ slot: id("outline"), texel: -1 });
    expect(image.data[(115 * 256 + 98) * 4]).toBeLessThan(40);
    // Outside the 3 px stroke the torso shows again.
    expect(at(103, 115).slot).toBe(id("torso_upper"));
  });

  it("a hidden owner slot hides its contour", () => {
    const skeleton = new Skeleton(document());
    skeleton.setActiveSkins(["body"]);
    skeleton.updateWorldTransform();
    skeleton.getSlot("outline").hidden = true;
    const { topSlot } = softRender(skeleton, new Map(), { width: 256, height: 256, left: -128, top: -230, ids: true });
    expect([...topSlot!].includes(skeleton.getSlot("outline").index + 1)).toBe(false);
  });
});
