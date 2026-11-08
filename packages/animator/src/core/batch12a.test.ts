import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { attachmentLibraryFor, attachmentTexturePaths, isDrawable, sequenceFramePath } from "./attachments.js";
import { attachmentSchema } from "./format.js";
import { findReferenceIssues } from "./formatReferences.js";
import { sequenceFrame } from "./sequence.js";
import { Skeleton } from "./skeleton.js";
import { pointInPolygon } from "./skinning.js";
import { createImage, type MutableImage } from "../tools/image.js";
import { softRender } from "../tools/softRender.js";
import { AnimationLibrary } from "./timelines.js";
import { testDocument } from "./testHelpers.js";

const SQUARE = [-10, -10, 10, -10, 10, 10, -10, 10];

const doc = testDocument({
  bones: [{ name: "root" }, { name: "arm", parent: "root", x: 50, y: 0, length: 20 }],
  slots: [
    { name: "mask", bone: "root", attachment: "clip" },
    { name: "body", bone: "root", attachment: "pic" },
    { name: "fx", bone: "root", attachment: "boom" },
    { name: "hit", bone: "arm", attachment: "box" }
  ],
  skins: {
    base: {
      attachments: {
        mask: { clip: { type: "clipping", vertices: SQUARE, end: "body" } },
        body: { pic: { type: "region", path: "body/pic", width: 20, height: 20 } },
        fx: { boom: { type: "region", path: "fx/boom_", width: 16, height: 16, sequence: { count: 4, start: 1, digits: 2, setup: 1 } } },
        hit: { box: { type: "boundingbox", vertices: SQUARE } }
      }
    }
  },
  animations: {
    play: {
      duration: 2,
      loop: false,
      slots: { fx: { sequence: [{ time: 0, mode: "loop", index: 0, delay: 0.25 }] } }
    },
    pong: {
      duration: 2,
      loop: false,
      slots: { fx: { sequence: [{ time: 0.5, mode: "pingpong", index: 1, delay: 0.1 }] } }
    }
  }
});

describe("clipping and bounding-box schema", () => {
  it("parses both types with their defaults", () => {
    const clip = attachmentSchema.parse({ type: "clipping", vertices: SQUARE });
    expect(clip.type === "clipping" && clip.end).toBeUndefined();
    const box = attachmentSchema.parse({ type: "boundingbox", vertices: SQUARE });
    expect(box.type === "boundingbox" && box.vertices.length).toBe(8);
  });
  it("rejects an odd count, fewer than 3 points and unknown keys", () => {
    expect(() => attachmentSchema.parse({ type: "boundingbox", vertices: [0, 0, 1, 1, 2] })).toThrow();
    expect(() => attachmentSchema.parse({ type: "clipping", vertices: [0, 0, 1, 1] })).toThrow();
    expect(() => attachmentSchema.parse({ type: "clipping", vertices: SQUARE, bogus: 1 })).toThrow();
  });
  it("a sequence needs a setup frame inside its count", () => {
    expect(() => attachmentSchema.parse({ type: "region", path: "a", width: 1, height: 1, sequence: { count: 2, setup: 2 } })).toThrow();
    expect(attachmentSchema.parse({ type: "region", path: "a", width: 1, height: 1, sequence: { count: 2 } })).toMatchObject({ sequence: { count: 2, start: 1, digits: 0, setup: 0 } });
  });
});

describe("attachment library", () => {
  const lib = attachmentLibraryFor(doc);
  it("clipping and bounding boxes are not drawable and add no textures", () => {
    expect(isDrawable(lib.get("base", "mask", "clip"))).toBe(false);
    expect(isDrawable(lib.get("base", "hit", "box"))).toBe(false);
    expect(lib.texturePaths).toContain("body/pic");
    expect(lib.texturePaths.filter((p) => p.startsWith("fx/"))).toEqual(["fx/boom_01", "fx/boom_02", "fx/boom_03", "fx/boom_04"]);
  });
  it("frame paths are the path plus the zero-padded number", () => {
    expect(sequenceFramePath("a_", { count: 12, start: 3, digits: 3, setup: 0 }, 2)).toBe("a_005");
    expect(sequenceFramePath("a", null, 5)).toBe("a");
    expect(attachmentTexturePaths({ path: "p", sequence: { count: 2, start: 0, digits: 0, setup: 0 } } as never)).toEqual(["p0", "p1"]);
  });
});

describe("sequenceFrame modes", () => {
  it("hold and a zero delay stay on the start frame", () => {
    expect(sequenceFrame("hold", 2, 0.1, 5, 9)).toBe(2);
    expect(sequenceFrame("loop", 2, 0, 5, 9)).toBe(2);
  });
  it("once stops on the last frame, loop wraps, pingpong bounces", () => {
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t) => sequenceFrame("once", 0, 0.1, 3, t))).toEqual([0, 1, 2, 2, 2, 2]);
    expect([0, 0.1, 0.2, 0.3, 0.4].map((t) => sequenceFrame("loop", 0, 0.1, 3, t))).toEqual([0, 1, 2, 0, 1]);
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => sequenceFrame("pingpong", 0, 0.1, 3, t))).toEqual([0, 1, 2, 1, 0, 1, 2]);
  });
  it("a start index past the end clamps", () => {
    expect(sequenceFrame("hold", 99, 0.1, 4, 0)).toBe(3);
  });
});

function skeletonOf(): Skeleton {
  const skeleton = new Skeleton(doc);
  skeleton.setActiveSkins(["base"]);
  return skeleton;
}

function sampleFrame(clip: string, time: number): number {
  const skeleton = skeletonOf();
  const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
  state.setAnimation(0, clip, { loop: false });
  state.update(time);
  state.apply(skeleton);
  skeleton.updateWorldTransform();
  return skeleton.getSlot("fx").sequenceFrame;
}

describe("sequence timeline", () => {
  it("shows the setup frame with no clip, then follows the key", () => {
    const skeleton = skeletonOf();
    skeleton.updateWorldTransform();
    expect(skeleton.getSlot("fx").sequenceFrame).toBe(1);
    expect([0, 0.25, 0.5, 0.75, 1].map((t) => sampleFrame("play", t))).toEqual([0, 1, 2, 3, 0]);
  });
  it("before the first key the setup frame shows; pingpong starts at its index", () => {
    expect(sampleFrame("pong", 0.2)).toBe(1);
    expect([0.5, 0.6, 0.7, 0.8, 0.9].map((t) => sampleFrame("pong", t))).toEqual([1, 2, 3, 2, 1]);
  });
  it("a sequence key on a slot without a sequence is a load error", () => {
    expect(() =>
      new AnimationLibrary(
        testDocument({
          bones: [{ name: "root" }],
          slots: [{ name: "s", bone: "root" }],
          skins: {},
          animations: { a: { duration: 1, slots: { s: { sequence: [{ time: 0, mode: "loop", index: 0, delay: 0.1 }] } } } }
        })
      )
    ).toThrow();
  });
  it("reports a frame outside the sequence", () => {
    expect(() =>
      testDocument({
        bones: [{ name: "root" }],
        slots: [{ name: "fx", bone: "root", attachment: "boom" }],
        skins: { base: { attachments: { fx: { boom: { type: "region", path: "b", width: 4, height: 4, sequence: { count: 4 } } } } } },
        animations: { bad: { duration: 1, slots: { fx: { sequence: [{ time: 0, mode: "hold", index: 9, delay: 0 }] } } } }
      })
    ).toThrow(/outside the 4 frames/);
  });
});

describe("bounding-box hit test", () => {
  const skeleton = skeletonOf();
  skeleton.updateWorldTransform();
  it("point in polygon, either winding and concave", () => {
    expect(pointInPolygon(SQUARE, 4, 0, 0)).toBe(true);
    expect(pointInPolygon(SQUARE, 4, 11, 0)).toBe(false);
    const arrow = [0, 0, 10, 5, 0, 10, 4, 5];
    expect(pointInPolygon(arrow, 4, 2, 5)).toBe(false);
    expect(pointInPolygon(arrow, 4, 6, 5)).toBe(true);
  });
  it("hit boxes move with their bone", () => {
    expect(skeleton.hitBoundingBoxes(50, 0)).toEqual([{ slot: "hit", name: "box" }]);
    expect(skeleton.hitBoundingBoxes(0, 0)).toEqual([]);
    skeleton.getBone("arm").pose.x = 100;
    skeleton.updateWorldTransform();
    expect(skeleton.hitBoundingBoxes(50, 0)).toEqual([]);
    expect(skeleton.hitBoundingBoxes(100, 5)).toHaveLength(1);
  });
  it("clipping polygons come out in world space", () => {
    const polygon = skeleton.slotPolygonWorld(skeleton.getSlot("mask"));
    expect(Array.from(polygon ?? [])).toEqual(SQUARE);
  });
});

describe("clipping end slot", () => {
  it("an unknown end slot is an error; an end drawn before the clip is a warning", () => {
    expect(() =>
      testDocument({
        bones: [{ name: "root" }],
        slots: [{ name: "a", bone: "root", attachment: "c" }, { name: "b", bone: "root" }],
        skins: { s: { attachments: { a: { c: { type: "clipping", vertices: SQUARE, end: "nope" } } } } }
      })
    ).toThrow(/unknown end slot/);
    const before = testDocument({
      bones: [{ name: "root" }],
      slots: [{ name: "b", bone: "root" }, { name: "a", bone: "root", attachment: "c" }],
      skins: { s: { attachments: { a: { c: { type: "clipping", vertices: SQUARE, end: "b" } } } } }
    });
    expect(findReferenceIssues(before).some((i) => /clips nothing/.test(i.message) && i.severity === "warning")).toBe(true);
  });
});

describe("render: clip mask and sequence on the rendered pose (pixel checks)", () => {
  const HALF = [-5, -5, 5, -5, 5, 5, -5, 5];
  const solid = (r: number, g: number, b: number) => {
    const image = createImage(4, 4);
    for (let p = 0; p < image.data.length; p += 4) image.data.set([r, g, b, 255], p);
    return image;
  };
  const textures = new Map([
    ["body/pic", solid(255, 0, 0)],
    ["side/pic", solid(0, 0, 255)],
    ["fx/boom_01", solid(10, 10, 10)],
    ["fx/boom_02", solid(0, 255, 0)],
    ["fx/boom_03", solid(0, 0, 255)],
    ["fx/boom_04", solid(255, 255, 0)]
  ]);
  // body is a 20 x 20 region at the origin, fx a 16 x 16 sequence on top of it; the mask is a 10 x 10 square.
  const world = (end: string | undefined, clipAnimation = false) =>
    testDocument({
      bones: [{ name: "root" }],
      slots: [
        { name: "mask", bone: "root", attachment: "clip" },
        { name: "body", bone: "root", attachment: "pic" },
        { name: "fx", bone: "root", attachment: "boom" }
      ],
      skins: {
        base: {
          attachments: {
            mask: { clip: { type: "clipping", vertices: HALF, ...(end ? { end } : {}) } },
            body: { pic: { type: "region", path: "body/pic", width: 20, height: 20 } },
            fx: { boom: { type: "region", path: "fx/boom_", width: 16, height: 16, sequence: { count: 4, start: 1, digits: 2, setup: 0 } } }
          }
        }
      },
      animations: {
        play: { duration: 2, loop: false, slots: { fx: { sequence: [{ time: 0, mode: "loop", index: 0, delay: 0.25 }] }, ...(clipAnimation ? { mask: { attachment: [{ time: 0.5, name: null }] } } : {}) } }
      }
    });
  const render = (document: ReturnType<typeof world>, time: number): MutableImage => {
    const skeleton = new Skeleton(document);
    skeleton.setActiveSkins(["base"]);
    const state = new AnimationState(new AnimationStateData(new AnimationLibrary(document)));
    state.setAnimation(0, "play", { loop: false });
    state.update(time);
    state.apply(skeleton);
    skeleton.updateWorldTransform();
    return softRender(skeleton, textures, { width: 40, height: 40, left: -20, top: -20 }).image as MutableImage;
  };
  const pixel = (image: MutableImage, x: number, y: number) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  const opaque = (image: MutableImage) => {
    let n = 0;
    for (let p = 3; p < image.data.length; p += 4) if ((image.data[p] as number) > 0) n++;
    return n;
  };

  it("a clip mask with its end slot cuts the covered slots to the polygon and leaves later slots whole", () => {
    const image = render(world("body"), 0);
    // body (20 x 20) is cut to the 10 x 10 square; fx (16 x 16, after the end slot) is whole.
    expect(pixel(image, 20, 20)).toEqual([10, 10, 10, 255]);
    const bodyOnly = render(world("fx"), 0);
    expect(pixel(bodyOnly, 20, 20)).toEqual([10, 10, 10, 255]);
    expect(opaque(image)).toBe(16 * 16);
    // With the end at fx everything is cut to the square.
    expect(opaque(bodyOnly)).toBe(10 * 10);
    expect(pixel(bodyOnly, 14, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(bodyOnly, 16, 20)).toEqual([10, 10, 10, 255]);
  });

  it("the mask clips the body visibly: red shows only inside the square, and the whole body shows without it", () => {
    const clippedBody = render(world("body"), 0);
    // Hide fx so only the body remains.
    const noFx = testDocument({
      bones: [{ name: "root" }],
      slots: [{ name: "mask", bone: "root", attachment: "clip" }, { name: "body", bone: "root", attachment: "pic" }],
      skins: { base: { attachments: { mask: { clip: { type: "clipping", vertices: HALF, end: "body" } }, body: { pic: { type: "region", path: "body/pic", width: 20, height: 20 } } } } },
      animations: { play: { duration: 1, loop: false } }
    });
    const inside = render(noFx, 0);
    expect(opaque(inside)).toBe(100);
    expect(pixel(inside, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(inside, 12, 20)).toEqual([0, 0, 0, 0]);
    void clippedBody;
    const open = testDocument({
      bones: [{ name: "root" }],
      slots: [{ name: "body", bone: "root", attachment: "pic" }],
      skins: { base: { attachments: { body: { pic: { type: "region", path: "body/pic", width: 20, height: 20 } } } } },
      animations: { play: { duration: 1, loop: false } }
    });
    expect(opaque(render(open, 0))).toBe(400);
  });

  it("an omitted end slot clips every later slot; hiding the mask slot (attachment key) stops the clipping", () => {
    expect(opaque(render(world(undefined), 0))).toBe(100);
    const hidden = render(world(undefined, true), 0.6);
    expect(opaque(hidden)).toBe(20 * 20);
    expect(opaque(render(world(undefined, true), 0.4))).toBe(100);
  });

  it("the sequence advances frames on the rendered pose", () => {
    const document = world("body");
    const colors = [0, 0.25, 0.5, 0.75, 1].map((t) => pixel(render(document, t), 20, 20));
    expect(colors).toEqual([[10, 10, 10, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [10, 10, 10, 255]]);
  });
});
