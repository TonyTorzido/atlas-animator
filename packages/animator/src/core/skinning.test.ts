import { describe, expect, it } from "vitest";
import type { MeshAttachment, PointAttachment, RegionAttachment } from "./attachments.js";
import type { AnimDocumentInput } from "./format.js";
import { computePointWorld, computeRegionWorldVertices } from "./skinning.js";
import { Skeleton } from "./skeleton.js";
import { random, testDocument } from "./testHelpers.js";

/*
 * Analytic skinning tests. Expected positions come from the definition of linear blend skinning
 * written out by hand for each case, never from running the implementation.
 */

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;

const COLUMNS = [0, 50, 100, 150, 200];

/**
 * A 200 x 20 strip on two bones: `upper` from (0, 0) to (100, 0), `lower` from (100, 0) on.
 * Vertex order is the hull: top row left to right (y = -10), then bottom row right to left.
 * Columns left of the joint follow `upper`, right of it `lower`, the joint column is 50/50.
 */
function stripVertices(): { x: number; y: number }[] {
  return [...COLUMNS.map((x) => ({ x, y: -10 })), ...[...COLUMNS].reverse().map((x) => ({ x, y: 10 }))];
}

function stripTriangles(): number[] {
  const bottom = (column: number) => 9 - column;
  const triangles: number[] = [];
  for (let j = 0; j < 4; j++) triangles.push(j, j + 1, bottom(j + 1), j, bottom(j + 1), bottom(j));
  return triangles;
}

function weightedStripVertices(): number[] {
  const out: number[] = [];
  for (const { x, y } of stripVertices()) {
    if (x < 100) out.push(1, 0, x, y, 1);
    else if (x > 100) out.push(1, 1, x - 100, y, 1);
    else out.push(2, 0, x, y, 0.5, 1, 0, y, 0.5);
  }
  return out;
}

function stripSections(extraSkins: Sections["skins"] = {}): Sections {
  return {
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", length: 100 },
      { name: "lower", parent: "upper", x: 100, length: 100 }
    ],
    slots: [
      { name: "strip", bone: "upper", attachment: "strip" },
      { name: "cloth", bone: "upper", attachment: "cloth" }
    ],
    skins: {
      body: {
        attachments: {
          strip: {
            strip: {
              type: "mesh",
              path: "test/strip",
              uvs: stripVertices().flatMap(({ x, y }) => [x / 200, (y + 10) / 20]),
              triangles: stripTriangles(),
              vertices: weightedStripVertices(),
              bones: ["upper", "lower"],
              hull: 10,
              width: 200,
              height: 20
            }
          }
        }
      },
      ...extraSkins
    }
  };
}

/** Where linear blend skinning puts each strip vertex with `lower` bent by theta degrees. */
function expectedStrip(theta: number): { x: number; y: number }[] {
  const r = (theta * Math.PI) / 180;
  const onLower = (u: number, v: number) => ({ x: 100 + u * Math.cos(r) - v * Math.sin(r), y: u * Math.sin(r) + v * Math.cos(r) });
  return stripVertices().map(({ x, y }) => {
    if (x < 100) return { x, y };
    if (x > 100) return onLower(x - 100, y);
    const b = onLower(0, y);
    return { x: 0.5 * x + 0.5 * b.x, y: 0.5 * y + 0.5 * b.y };
  });
}

function posedStrip(theta: number, sections: Sections = stripSections(), skins = ["body"]): Skeleton {
  const skeleton = new Skeleton(testDocument(sections));
  skeleton.setActiveSkins(skins);
  skeleton.getBone("lower").pose.rotation = theta;
  skeleton.updateWorldTransform();
  return skeleton;
}

function slotVertices(skeleton: Skeleton, slot: string): { x: number; y: number }[] {
  const out = new Float64Array(64);
  const count = skeleton.computeSlotWorldVertices(skeleton.getSlot(slot), out);
  return Array.from({ length: count }, (_, v) => ({ x: out[v * 2] as number, y: out[v * 2 + 1] as number }));
}

function expectPoints(actual: { x: number; y: number }[], expected: { x: number; y: number }[], digits = 9): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((point, v) => {
    expect(actual[v]?.x, `vertex ${v} x`).toBeCloseTo(point.x, digits);
    expect(actual[v]?.y, `vertex ${v} y`).toBeCloseTo(point.y, digits);
  });
}

describe("linear blend skinning", () => {
  it("a 2-bone strip bent 90 degrees has every vertex at its analytic position", () => {
    // Worked by hand: a vertex bound to `lower` at (u, v) lands at (100 - v, u) once lower turns
    // 90 degrees clockwise (y down); joint vertices average that with their unmoved position.
    expectPoints(slotVertices(posedStrip(90), "strip"), [
      { x: 0, y: -10 },
      { x: 50, y: -10 },
      { x: 105, y: -5 }, // (0.5 * 100 + 0.5 * 110, 0.5 * -10 + 0.5 * 0)
      { x: 110, y: 50 },
      { x: 110, y: 100 },
      { x: 90, y: 100 },
      { x: 90, y: 50 },
      { x: 95, y: 5 }, // (0.5 * 100 + 0.5 * 90, 0.5 * 10 + 0.5 * 0)
      { x: 50, y: 10 },
      { x: 0, y: 10 }
    ]);
  });

  it("matches the closed form at any bend angle", () => {
    const next = random(11);
    for (let i = 0; i < 25; i++) {
      const theta = next(-150, 150);
      expectPoints(slotVertices(posedStrip(theta), "strip"), expectedStrip(theta));
    }
  });

  it("at rest reproduces the bind positions", () => {
    expectPoints(slotVertices(posedStrip(0), "strip"), stripVertices());
  });

  it("follows the skeleton origin and parent motion", () => {
    const skeleton = new Skeleton(testDocument(stripSections()));
    skeleton.setActiveSkins(["body"]);
    skeleton.x = 30;
    skeleton.y = -7;
    skeleton.getBone("upper").pose.rotation = 90;
    skeleton.updateWorldTransform();
    // Whole strip turned 90 degrees about the origin, then moved by (30, -7): (x, y) -> (-y + 30, x - 7).
    expectPoints(
      slotVertices(skeleton, "strip"),
      stripVertices().map(({ x, y }) => ({ x: -y + 30, y: x - 7 }))
    );
  });

  it("applies weighted deform per influence, in bone space", () => {
    const skeleton = posedStrip(90);
    const mesh = skeleton.getSlot("strip").attachment as MeshAttachment;
    // Influences in order: v0 (1), v1 (1), v2 (2: upper, lower), v3 (1), ...
    // Move v2's `lower` influence by (0, -4) in lower's space and v3's by (6, 0).
    const deform = skeleton.animationDeformFor(mesh);
    deform[2 * 3] = 0; // v2, influence 2 (lower) x
    deform[2 * 3 + 1] = -4; // y
    deform[2 * 4] = 6; // v3 x
    skeleton.updateWorldTransform();
    const expected = expectedStrip(90);
    // v2: the lower half of the blend moves by R90 * (0, -4) = (4, 0), weighted 0.5 -> (+2, 0).
    expected[2] = { x: (expected[2]?.x ?? 0) + 2, y: expected[2]?.y ?? 0 };
    // v3: R90 * (6, 0) = (0, 6).
    expected[3] = { x: expected[3]?.x ?? 0, y: (expected[3]?.y ?? 0) + 6 };
    expectPoints(slotVertices(skeleton, "strip"), expected);
  });

  it("deform is cleared by the setup pose", () => {
    const skeleton = posedStrip(45);
    skeleton.animationDeformFor(skeleton.getSlot("strip").attachment as MeshAttachment).fill(3);
    skeleton.setSlotsToSetupPose();
    skeleton.updateWorldTransform();
    expectPoints(slotVertices(skeleton, "strip"), expectedStrip(45));
  });

  it("an unweighted mesh rides its slot bone, with per-vertex deform", () => {
    const skeleton = new Skeleton(
      testDocument({
        bones: [{ name: "root" }, { name: "hand", parent: "root", x: 40, y: 10, rotation: 90, scaleX: 2 }],
        slots: [{ name: "tool", bone: "hand", attachment: "tool" }],
        skins: {
          gear: {
            attachments: {
              tool: {
                tool: {
                  type: "mesh",
                  path: "gear/tool",
                  uvs: [0, 0, 1, 0, 0, 1],
                  triangles: [0, 1, 2],
                  vertices: [0, 0, 10, 0, 0, 5],
                  hull: 3,
                  width: 10,
                  height: 5
                }
              }
            }
          }
        }
      })
    );
    skeleton.setActiveSkins(["gear"]);
    skeleton.updateWorldTransform();
    // hand: X axis (cos 90, sin 90) * 2 = (0, 2); Y axis (cos 180, sin 180) = (-1, 0).
    // (u, v) -> (40 - v, 10 + 2u).
    expectPoints(slotVertices(skeleton, "tool"), [
      { x: 40, y: 10 },
      { x: 40, y: 30 },
      { x: 35, y: 10 }
    ]);
    const deform = skeleton.animationDeformFor(skeleton.getSlot("tool").attachment as MeshAttachment);
    deform[2] = 1; // v1 x + 1 -> (11, 0)
    deform[5] = 1; // v2 y + 1 -> (0, 6)
    skeleton.updateWorldTransform();
    expectPoints(slotVertices(skeleton, "tool"), [
      { x: 40, y: 10 },
      { x: 40, y: 32 },
      { x: 34, y: 10 }
    ]);
  });
});

describe("linked meshes", () => {
  const withCloth = (inheritDeform: boolean) =>
    stripSections({
      tunic: {
        attachments: {
          cloth: {
            cloth: {
              type: "linkedMesh",
              path: "swag/tunic/strip",
              source: { skin: "body", slot: "strip", attachment: "strip" },
              inheritDeform,
              width: 200,
              height: 20,
              color: "80ff40cc"
            }
          }
        }
      }
    });

  it("shares the source geometry and equals the source after deform", () => {
    const skeleton = posedStrip(60, withCloth(true), ["body", "tunic"]);
    const source = skeleton.getSlot("strip").attachment as MeshAttachment;
    const cloth = skeleton.getSlot("cloth").attachment as MeshAttachment;
    expect(cloth.geometry).toBe(source.geometry);
    expect(cloth.deformOwner).toBe(source);
    expect(cloth.path).toBe("swag/tunic/strip");
    expect(cloth.color).toEqual({ r: 128 / 255, g: 1, b: 64 / 255, a: 204 / 255 });

    const deform = skeleton.animationDeformFor(source);
    for (let i = 0; i < deform.length; i++) deform[i] = Math.sin(i) * 5;
    skeleton.updateWorldTransform();
    const body = slotVertices(skeleton, "strip");
    expect(body).not.toEqual(expectedStrip(60));
    expect(slotVertices(skeleton, "cloth")).toEqual(body);
  });

  it("with inheritDeform false keeps its own deform", () => {
    const skeleton = posedStrip(30, withCloth(false), ["body", "tunic"]);
    const source = skeleton.getSlot("strip").attachment as MeshAttachment;
    const cloth = skeleton.getSlot("cloth").attachment as MeshAttachment;
    expect(cloth.deformOwner).toBe(cloth);
    skeleton.animationDeformFor(source).fill(2);
    skeleton.updateWorldTransform();
    expectPoints(slotVertices(skeleton, "cloth"), expectedStrip(30));
    skeleton.animationDeformFor(source).fill(2);
    skeleton.animationDeformFor(cloth).fill(2);
    skeleton.updateWorldTransform();
    expect(slotVertices(skeleton, "cloth")).toEqual(slotVertices(skeleton, "strip"));
  });

  it("refuses animation deform on a mesh that inherits deform", () => {
    const skeleton = posedStrip(0, withCloth(true), ["body", "tunic"]);
    expect(() => skeleton.animationDeformFor(skeleton.getSlot("cloth").attachment as MeshAttachment)).toThrow(/inherits deform/);
  });
});

describe("regions and points", () => {
  const sections: Sections = {
    bones: [{ name: "root" }, { name: "hand", parent: "root", x: 10, y: 20, rotation: 90 }],
    slots: [
      { name: "sword", bone: "hand", attachment: "sword" },
      { name: "tip", bone: "hand", attachment: "tip" }
    ],
    skins: {
      gear: {
        attachments: {
          sword: { sword: { type: "region", path: "gear/sword", x: 5, y: 0, rotation: 90, scaleX: 2, width: 10, height: 4 } },
          tip: { tip: { type: "point", x: 30, y: 0, rotation: 45 } }
        }
      }
    }
  };

  it("a region's corners are its scaled, rotated rectangle on the bone", () => {
    const skeleton = new Skeleton(testDocument(sections));
    skeleton.setActiveSkins(["gear"]);
    skeleton.updateWorldTransform();
    const region = skeleton.getSlot("sword").attachment as RegionAttachment;
    const out = new Float64Array(8);
    computeRegionWorldVertices(region, skeleton.getBone("hand"), out);
    // Image corners (+-10, +-2) after scaleX 2; attachment rotation 90: (u, v) -> (-v, u), plus (5, 0);
    // bone rotation 90 the same way, plus (10, 20). Worked per corner:
    // top-left (-10, -2) -> attachment (2 + 5, -10) = (7, -10) -> bone (10 + 10, 20 + 7) = (20, 27).
    // top-right (10, -2) -> (7, 10) -> (0, 27). bottom-right (10, 2) -> (3, 10) -> (0, 23).
    // bottom-left (-10, 2) -> (3, -10) -> (20, 23).
    expect(Array.from(out).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([20, 27, 0, 27, 0, 23, 20, 23]);
    expect(Array.from(region.uvs)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(Array.from(region.triangles)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("a point gives a world position and direction", () => {
    const skeleton = new Skeleton(testDocument(sections));
    skeleton.setActiveSkins(["gear"]);
    skeleton.updateWorldTransform();
    const tip = skeleton.getSlot("tip").attachment as PointAttachment;
    const world = computePointWorld(tip, skeleton.getBone("hand"), { x: 0, y: 0, rotation: 0 });
    expect(world.x).toBeCloseTo(10, 9);
    expect(world.y).toBeCloseTo(50, 9);
    expect(world.rotation).toBeCloseTo(135, 9);
    expect(skeleton.computeSlotWorldVertices(skeleton.getSlot("tip"), new Float64Array(8))).toBe(0);
  });
});
