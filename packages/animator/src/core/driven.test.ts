import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "./attachments.js";
import type { AnimDocumentInput } from "./format.js";
import { parseAnimDocument } from "./formatLoader.js";
import { drivenValue } from "./driven.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;

/**
 * An arm: `upper` (setup rotation 10) carrying `fore`. The sleeve mesh is unweighted on `fore`
 * with three vertices; driven keys on fore's angle push vertex 1 outwards and swap the sleeve in
 * front of the torso past 60 degrees.
 */
function armSections(driven: Sections["driven"], extra: Partial<Sections> = {}): Sections {
  return {
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", rotation: 10, length: 50 },
      { name: "fore", parent: "upper", x: 50, rotation: 0, length: 40 }
    ],
    slots: [
      { name: "sleeve", bone: "fore", attachment: "sleeve" },
      { name: "torso", bone: "root", attachment: "torso" },
      { name: "glove", bone: "fore", attachment: "glove" }
    ],
    skins: {
      body: {
        attachments: {
          sleeve: {
            sleeve: {
              type: "mesh",
              path: "body/sleeve",
              uvs: [0, 0, 1, 0, 0, 1],
              triangles: [0, 1, 2],
              vertices: [0, 0, 40, 0, 0, 10],
              hull: 3,
              width: 40,
              height: 10
            }
          },
          torso: { torso: { type: "region", path: "body/torso", width: 10, height: 10 } },
          glove: {
            glove: { type: "region", path: "body/glove", width: 4, height: 4 },
            fist: { type: "region", path: "body/fist", width: 4, height: 4 }
          }
        }
      },
      ...extra.skins
    },
    driven,
    ...(extra.bones ? { bones: extra.bones } : {})
  };
}

const elbowFix: Sections["driven"] = [
  {
    name: "elbow_fix",
    bone: "fore",
    keys: [
      { at: 0 },
      {
        at: 70,
        deform: { body: { sleeve: { sleeve: { offset: 2, vertices: [8, -4] } } } },
        drawOrder: [{ slot: "sleeve", offset: 1 }],
        attachments: { glove: "fist" }
      }
    ]
  }
];

function posed(sections: Sections, foreRotation: number, skins = ["body"]): Skeleton {
  const skeleton = new Skeleton(testDocument(sections));
  skeleton.setActiveSkins(skins);
  skeleton.getBone("fore").pose.rotation = foreRotation;
  skeleton.updateWorldTransform();
  return skeleton;
}

function sleeveDeform(skeleton: Skeleton): number[] | null {
  const deform = skeleton.deformFor(skeleton.getSlot("sleeve").attachment as MeshAttachment);
  return deform ? Array.from(deform) : null;
}

const order = (skeleton: Skeleton) => skeleton.drawOrder.map((slot) => slot.data.name);
const glove = (skeleton: Skeleton) => {
  const attachment = skeleton.getSlot("glove").attachment;
  return attachment && (attachment.type === "region" || attachment.type === "mesh") ? attachment.path : null;
};

describe("driven keys", () => {
  it("a driven key at 50% of the angle range blends 50%", () => {
    expect(sleeveDeform(posed(armSections(elbowFix), 35))).toEqual([0, 0, 4, -2, 0, 0]);
  });

  it("blends linearly in between and holds the end keys outside the range", () => {
    const at = (angle: number) => sleeveDeform(posed(armSections(elbowFix), angle));
    expect(at(0)).toEqual([0, 0, 0, 0, 0, 0]);
    const quarter = at(17.5) as number[];
    expect(quarter[2]).toBeCloseTo(2, 6);
    expect(quarter[3]).toBeCloseTo(-1, 6);
    expect(at(70)).toEqual([0, 0, 8, -4, 0, 0]);
    expect(at(100)).toEqual([0, 0, 8, -4, 0, 0]);
    expect(at(-40)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("reads the applied rotation relative to the setup rotation", () => {
    const sections = armSections(elbowFix);
    sections.bones = sections.bones?.map((bone) => (bone.name === "fore" ? { ...bone, rotation: 20 } : bone));
    // Setup 20, posed 55: driver 35 -> 50%.
    expect(sleeveDeform(posed(sections, 55))).toEqual([0, 0, 4, -2, 0, 0]);
  });

  it("reads the rotation after rotation limits", () => {
    const sections = armSections(elbowFix);
    sections.bones = sections.bones?.map((bone) => (bone.name === "fore" ? { ...bone, limits: { min: -10, max: 35 } } : bone));
    // Posed at 90 but clamped to 35 -> 50%.
    expect(sleeveDeform(posed(sections, 90))).toEqual([0, 0, 4, -2, 0, 0]);
  });

  it("moves the vertices it deforms", () => {
    const skeleton = posed(armSections(elbowFix), 35);
    const out = new Float64Array(6);
    skeleton.computeSlotWorldVertices(skeleton.getSlot("sleeve"), out);
    // fore world rotation = 10 + 35 = 45 degrees, origin at upper's tip (50 cos 10, 50 sin 10).
    const r = (45 * Math.PI) / 180;
    const ox = 50 * Math.cos((10 * Math.PI) / 180);
    const oy = 50 * Math.sin((10 * Math.PI) / 180);
    const [u, v] = [40 + 4, 0 - 2];
    expect(out[2]).toBeCloseTo(ox + u * Math.cos(r) - v * Math.sin(r), 9);
    expect(out[3]).toBeCloseTo(oy + u * Math.sin(r) + v * Math.cos(r), 9);
  });

  it("switches draw order and attachments stepwise at the key", () => {
    const below = posed(armSections(elbowFix), 69.9);
    expect(order(below)).toEqual(["sleeve", "torso", "glove"]);
    expect(glove(below)).toBe("body/glove");
    const past = posed(armSections(elbowFix), 70);
    expect(order(past)).toEqual(["torso", "sleeve", "glove"]);
    expect(glove(past)).toBe("body/fist");
  });

  it("adds onto animation deform and draw-order offsets", () => {
    const skeleton = new Skeleton(testDocument(armSections(elbowFix)));
    skeleton.setActiveSkins(["body"]);
    skeleton.getBone("fore").pose.rotation = 35;
    const mesh = skeleton.getSlot("sleeve").attachment as MeshAttachment;
    skeleton.animationDeformFor(mesh).set([1, 1, 1, 1, 1, 1]);
    skeleton.updateWorldTransform();
    expect(sleeveDeform(skeleton)).toEqual([1, 1, 5, -1, 1, 1]);
  });

  it("sums several sets and lets the later set win an attachment override", () => {
    const second: Sections["driven"] = [
      ...(elbowFix ?? []),
      {
        name: "second",
        bone: "fore",
        keys: [{ at: -10, deform: { body: { sleeve: { sleeve: { vertices: [1, 1] } } } }, attachments: { glove: null } }]
      }
    ];
    const skeleton = posed(armSections(second), 35);
    expect(sleeveDeform(skeleton)).toEqual([1, 1, 4, -2, 0, 0]);
    expect(glove(skeleton)).toBeNull();
  });

  it("is idempotent across frames (no accumulation)", () => {
    const skeleton = posed(armSections(elbowFix), 35);
    skeleton.updateWorldTransform();
    skeleton.updateWorldTransform();
    expect(sleeveDeform(skeleton)).toEqual([0, 0, 4, -2, 0, 0]);
    skeleton.getBone("fore").pose.rotation = 0;
    skeleton.updateWorldTransform();
    expect(sleeveDeform(skeleton)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("a skin-gated set applies only while its skin is active", () => {
    const gated: Sections["driven"] = [{ ...(elbowFix?.[0] as NonNullable<Sections["driven"]>[number]), skin: "pauldron" }];
    const sections = armSections(gated, { skins: { pauldron: {} } });
    expect(sleeveDeform(posed(sections, 35, ["body"]))).toBeNull();
    expect(sleeveDeform(posed(sections, 35, ["body", "pauldron"]))).toEqual([0, 0, 4, -2, 0, 0]);
  });

  it("the loader rejects a skin gate naming an unknown skin", () => {
    const gated: Sections["driven"] = [{ ...(elbowFix?.[0] as NonNullable<Sections["driven"]>[number]), skin: "ghost" }];
    const result = parseAnimDocument({ format: "atlas-anim@1", name: "t", canvas: { width: 1, height: 1, originX: 0, originY: 0 }, ...armSections(gated) });
    expect(result.ok ? [] : result.issues.map((issue) => issue.message)).toEqual(["unknown skin 'ghost'"]);
  });

  it("uses the raw driver value for a bone with limits (no wrap past 180)", () => {
    const sections = armSections([
      { name: "wide", bone: "fore", keys: [{ at: 0 }, { at: 200, deform: { body: { sleeve: { sleeve: { vertices: [10] } } } } }] }
    ]);
    sections.bones = sections.bones?.map((bone) => (bone.name === "fore" ? { ...bone, limits: { min: 0, max: 200 } } : bone));
    const skeleton = posed(sections, 190);
    expect(drivenValue(skeleton.getBone("fore"))).toBe(190);
    expect(sleeveDeform(skeleton)?.[0]).toBeCloseTo(9.5, 5);
  });

  it("wraps the driver value for a bone without limits", () => {
    expect(drivenValue(posed(armSections(elbowFix), 190).getBone("fore"))).toBe(-170);
  });

  it("the schema bounds key positions to [-360, 360]", () => {
    const result = parseAnimDocument({
      format: "atlas-anim@1",
      name: "t",
      canvas: { width: 1, height: 1, originX: 0, originY: 0 },
      ...armSections([{ name: "far", bone: "fore", keys: [{ at: 361 }] }])
    });
    expect(result.ok ? [] : result.issues.map((issue) => issue.path.join("."))).toEqual(["driven.0.keys.0.at"]);
  });

  describe("alpha channel", () => {
    const fade = (keys: { at: number; alpha?: Record<string, number> }[], name = "fade"): NonNullable<Sections["driven"]>[number] => ({
      name,
      bone: "fore",
      keys
    });
    const gussetFade = [fade([{ at: 0, alpha: { glove: 0 } }, { at: 10, alpha: { glove: 1 } }])];

    it("blends opacity linearly between keys and holds the ends", () => {
      const alpha = (angle: number) => posed(armSections(gussetFade), angle).getSlot("glove").drivenAlpha;
      expect(alpha(-20)).toBe(0);
      expect(alpha(0)).toBe(0);
      expect(alpha(5)).toBeCloseTo(0.5, 6);
      expect(alpha(10)).toBe(1);
      expect(alpha(60)).toBe(1);
      // Slots no set names stay opaque.
      expect(posed(armSections(gussetFade), 5).getSlot("torso").drivenAlpha).toBe(1);
    });

    it("a key that does not name the slot gives it 1, and several sets multiply", () => {
      const sets = [
        fade([{ at: 0, alpha: { glove: 0.5 } }, { at: 10 }], "a"),
        fade([{ at: 0, alpha: { glove: 0.5 } }, { at: 10, alpha: { glove: 0.5 } }], "b")
      ];
      expect(posed(armSections(sets), 0).getSlot("glove").drivenAlpha).toBeCloseTo(0.25, 6);
      expect(posed(armSections(sets), 10).getSlot("glove").drivenAlpha).toBeCloseTo(0.5, 6);
    });

    it("alphaOr groups: a group multiplies its sets, the slot takes the largest group (damaged control: plain sets AND)", () => {
      // Group "a" shows the glove at fore >= 10 (the fold); group "b" at fore <= -10 gated by upper (its driver is 0 here: open).
      const showFold = { ...fade([{ at: 0, alpha: { glove: 0 } }, { at: 10, alpha: { glove: 1 } }], "fold"), alphaOr: "a" };
      const showOther = { ...fade([{ at: -10, alpha: { glove: 1 } }, { at: 0, alpha: { glove: 0 } }], "other"), alphaOr: "b" };
      const gate = { name: "gate", bone: "upper", alphaOr: "b", keys: [{ at: -5, alpha: { glove: 1 } }, { at: 5, alpha: { glove: 1 } }] };
      const sets = [showFold, showOther, gate];
      const alpha = (s: typeof sets, angle: number) => posed(armSections(s as never), angle).getSlot("glove").drivenAlpha;
      expect(alpha(sets, 20)).toBe(1);
      expect(alpha(sets, -20)).toBe(1);
      expect(alpha(sets, 0)).toBe(0);
      expect(alpha(sets, 5)).toBeCloseTo(0.5, 6);
      // A plain multiply would hide the slot on both sides (damaged control).
      const plain = sets.map(({ alphaOr: _drop, ...rest }) => rest);
      expect(alpha(plain as never, 20)).toBe(0);
      expect(alpha(plain as never, -20)).toBe(0);
      // A closed gate in group b closes only that group.
      const closed = [showFold, showOther, { ...gate, keys: [{ at: -5, alpha: { glove: 0 } }, { at: 5, alpha: { glove: 0 } }] }];
      expect(alpha(closed, -20)).toBe(0);
      expect(alpha(closed, 20)).toBe(1);
      // Plain sets still multiply the OR result; slots no group names stay 1.
      expect(alpha([...sets, fade([{ at: -90, alpha: { glove: 0.5 } }, { at: 90, alpha: { glove: 0.5 } }], "half")] as never, 20)).toBeCloseTo(0.5, 6);
      expect(posed(armSections(sets as never), 20).getSlot("torso").drivenAlpha).toBe(1);
    });

    it("does not change the slot colour and does not accumulate across frames", () => {
      const skeleton = posed(armSections(gussetFade), 5);
      skeleton.updateWorldTransform();
      skeleton.updateWorldTransform();
      expect(skeleton.getSlot("glove").drivenAlpha).toBeCloseTo(0.5, 6);
      expect(skeleton.getSlot("glove").color.a).toBe(1);
    });

    it("the loader rejects unknown slots and values outside 0..1", () => {
      const bad = (alpha: Record<string, number>) => parseAnimDocument({ format: "atlas-anim@1", name: "x", canvas: { width: 10, height: 10, originX: 0, originY: 0 }, ...armSections([fade([{ at: 0, alpha }])]) });
      expect(bad({ glove: 0.3 }).ok).toBe(true);
      expect(bad({ nope: 0.3 }).ok).toBe(false);
      expect(bad({ glove: 1.5 }).ok).toBe(false);
    });
  });
});
