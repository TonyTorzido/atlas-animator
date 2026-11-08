import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "../core/attachments.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimatorCharacter, COVERAGE_RAMP_KEY } from "./animatorCharacter.js";
import { DynamicAtlas } from "./dynamicAtlas.js";
import { packedAtlasImages } from "./partImages.js";

/*
 * Phase in the Pixi adapter: draw groups (one skinned mesh, one batched mesh per group slot,
 * identical boundary positions) and contours (a batched stroke mesh after the user slot, rebuilt
 * only when an owner bone moved, shifted on a pure skeleton move, hidden by level of detail).
 */

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const page = PNG.sync.read(readFileSync(fixture("three-part.atlas.png")));
const images = packedAtlasImages(pack, new Map([["three-part.atlas.png", { width: page.width, height: page.height, data: page.data }]]));

/** The three-part rig with its torso split into draw groups and two contours. */
function jointReadyDocument() {
  const raw = JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8")) as {
    slots: Record<string, unknown>[];
    skins: { body: { attachments: { torso: { torso: Record<string, unknown> } }; contours?: unknown } };
  };
  raw.slots.push({ name: "torso_upper", bone: "chest" }, { name: "outline", bone: "root" });
  // Torso triangles: four column strips of two; the lower two strips stay in `torso`.
  raw.skins.body.attachments.torso.torso["groups"] = { torso: [[0, 4]], torso_upper: [[4, 8]] };
  raw.skins.body.contours = {
    outline: {
      side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4], width: 3, color: "201810ff" },
      brow: { bones: ["head"], vertices: [1, 0, 30, -10, 1, 1, 0, 30, 10, 1], width: 2, visible: [{ bone: "head", min: -30, max: 30 }] }
    }
  };
  return loadAnimDocument(raw);
}

function make() {
  const skeleton = new Skeleton(jointReadyDocument());
  skeleton.setActiveSkins(["body"]);
  const atlas = new DynamicAtlas({ pageSize: 512 });
  const character = new AnimatorCharacter({ skeleton, atlas, images });
  character.contourPixelScale = 1;
  character.update();
  return { skeleton, atlas, character };
}

describe("draw groups in the Pixi adapter", () => {
  it("draws each group in its slot from one skinned mesh; boundary vertices coincide", () => {
    const { skeleton, character } = make();
    const meshes = new Map(character.slotMeshes.map((mesh) => [mesh.label, mesh]));
    const lower = meshes.get("torso")!;
    const upper = meshes.get("torso_upper")!;
    expect(lower.visible && upper.visible).toBe(true);
    expect(lower.geometry).not.toBe(upper.geometry);
    expect(lower.texture).toBe(upper.texture);
    // Each group has its own compact vertex list: 3 columns x 2 rows of the 5 x 2 torso.
    expect(lower.geometry.positions.length / 2).toBe(6);
    expect(upper.geometry.positions.length / 2).toBe(6);
    const mesh = skeleton.getAttachment(skeleton.getSlot("torso"), "torso") as MeshAttachment;
    const [lowerGroup, upperGroup] = mesh.geometry.groups!;
    const shared = [...lowerGroup!.vertices].filter((v) => upperGroup!.vertices.includes(v));
    expect(shared.sort()).toEqual([2, 7]);
    for (const bend of [0, 35, 70, -50]) {
      skeleton.setToSetupPose();
      skeleton.getBone("chest").pose.rotation += bend;
      character.update();
      for (const vertex of shared) {
        const i = lowerGroup!.vertices.indexOf(vertex);
        const j = upperGroup!.vertices.indexOf(vertex);
        const pick = (array: Float32Array, k: number) => [array[k * 2], array[k * 2 + 1]];
        expect(pick(upper.geometry.positions, j)).toEqual(pick(lower.geometry.positions, i));
        expect(pick(upper.geometry.uvs, j)).toEqual(pick(lower.geometry.uvs, i));
      }
    }
  });
});

describe("contours in the Pixi adapter", () => {
  it("adds one batched stroke mesh per contour right after its owner slot, textured by the ramp", () => {
    const { atlas, character } = make();
    const labels = character.children.map((child) => child.label);
    const outline = labels.indexOf("outline");
    expect(labels.slice(outline, outline + 3)).toEqual(["outline", "outline:side", "outline:brow"]);
    const [side] = character.contourMeshes;
    expect(side?.visible).toBe(true);
    expect(side?.geometry.batchMode).toBe("batch");
    expect(side?.texture).toBe(character.slotMeshes[1]?.texture); // the same atlas page as the body
    expect(atlas.references(COVERAGE_RAMP_KEY)).toBe(1);
    expect(side?.tint).toBe(0x201810);
  });

  it("builds the first frame's stroke for the display scale set before any render (stale worldTransform)", () => {
    const skeleton = new Skeleton(jointReadyDocument());
    skeleton.setActiveSkins(["body"]);
    const character = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 512 }), images });
    const stage = new Container();
    stage.scale.set(4);
    stage.addChild(character);
    character.scale.set(0.5);
    character.update(); // no render has refreshed worldTransform yet
    const positions = character.contourMeshes[0]!.geometry.getBuffer("aPosition").data as Float32Array;
    // Rim at w/2 + aa/2 with aa one display px: 3/2 + (1/2) / 2 canvas px from the centre.
    expect(Math.hypot(positions[2]! - positions[0]!, positions[3]! - positions[1]!)).toBeCloseTo(1.75, 4);
  });

  it("rebuilds a stroke only when an owner bone moved; a pure skeleton move shifts it", () => {
    const { skeleton, character } = make();
    const side = character.contourMeshes[0]!;
    const rebuilt = character.contourRebuilds;
    character.update();
    expect(character.contourRebuilds).toBe(rebuilt); // still pose: nothing rebuilt
    const before = Float32Array.from(side.geometry.positions);
    skeleton.x += 12.5;
    character.update();
    expect(character.contourRebuilds).toBe(rebuilt);
    // the geometry holds the stroke's capacity (constant size); its used prefix is what the indices reach
    const used = (Math.max(...side.geometry.indices) + 1) * 2;
    side.geometry.positions.subarray(0, used).forEach((value, i) => expect(value).toBeCloseTo(before[i]! + (i % 2 === 0 ? 12.5 : 0), 4));
    skeleton.getBone("head").pose.rotation += 10; // moves the brow only
    character.update();
    expect(character.contourRebuilds).toBe(rebuilt + 1);
    // a rebuild never resizes the batched geometry (a resize could keep a stale pixi batch layout)
    expect(side.geometry.positions.length).toBe(before.length);
    skeleton.getBone("chest").pose.rotation += 10; // moves both
    character.update();
    expect(character.contourRebuilds).toBe(rebuilt + 3);
  });

  it("level of detail and visibility rules hide a contour without rebuilding it", () => {
    const { skeleton, character } = make();
    const [side, brow] = character.contourMeshes;
    character.contourPixelScale = 0.1; // the 2-3 px strokes are under a third of a display pixel
    character.update();
    expect(side?.visible).toBe(false);
    expect(brow?.visible).toBe(false);
    character.contourPixelScale = 1;
    skeleton.getBone("head").pose.rotation += 45; // outside the brow's [-30, 30]
    character.update();
    expect(side?.visible).toBe(true);
    expect(brow?.visible).toBe(false);
  });

  it("follows the outfit: contours of an inactive skin are removed", () => {
    const { character, atlas } = make();
    character.setActiveSkins(["tunic"]);
    character.update();
    expect(character.contourMeshes).toHaveLength(0);
    character.destroy();
    expect(atlas.references(COVERAGE_RAMP_KEY)).toBe(0);
  });
});
