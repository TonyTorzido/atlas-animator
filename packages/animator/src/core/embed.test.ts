import { describe, expect, it } from "vitest";
import type { MeshAttachment } from "./attachments.js";
import { parseAnimDocument, loadAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";

/*
 * Phase: embedded mesh vertices (a garment vertex posed as a barycentric point of the skin
 * triangle under it, so the garment and the skin agree bit for bit at every pose).
 */

const COLUMNS = [0, 20, 40, 60, 80, 100, 120];
const HALF = 10;
const JOINT = 60;

function raw(embed: Record<string, unknown> | null = null, contours = false) {
  const top = COLUMNS.map((x) => ({ x, y: -HALF }));
  const bottom = [...COLUMNS].reverse().map((x) => ({ x, y: HALF }));
  const points = [...top, ...bottom];
  const n = COLUMNS.length;
  const bottomIndex = (column: number) => 2 * n - 1 - column;
  const triangles: number[] = [];
  for (let j = 0; j < n - 1; j++) triangles.push(j, j + 1, bottomIndex(j + 1), j, bottomIndex(j + 1), bottomIndex(j));
  const vertices = points.flatMap(({ x, y }) =>
    x < JOINT ? [1, 0, x, y, 1] : x > JOINT ? [1, 1, x - JOINT, y, 1] : [2, 0, x, y, 0.5, 1, 0, y, 0.5]
  );
  // A band over the joint: four vertices on the root bone (fallback weights), three embedded.
  const band = [
    [50, -12],
    [70, -12],
    [70, 5],
    [50, 5]
  ];
  return {
    format: "atlas-anim@1",
    name: "embed",
    canvas: { width: 200, height: 100, originX: 20, originY: 50 },
    bones: [
      { name: "root" },
      { name: "upper", parent: "root", length: JOINT },
      { name: "lower", parent: "upper", x: JOINT, length: JOINT }
    ],
    slots: [
      { name: "skin", bone: "upper", attachment: "strip" },
      { name: "band", bone: "root", attachment: "band" }
    ],
    skins: {
      body: {
        attachments: {
          skin: {
            strip: { type: "mesh", path: "t/strip", bones: ["upper", "lower"], uvs: points.flatMap(({ x, y }) => [x / 120, (y + HALF) / (2 * HALF)]), triangles, vertices, hull: points.length, width: 120, height: 20 }
          },
          band: {
            band: {
              type: "mesh",
              path: "t/band",
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              vertices: band.flat(),
              hull: 4,
              width: 20,
              height: 17,
              ...(embed ? { embed } : {})
            }
          }
        },
        ...(contours ? { contours: { band: { edge: { mesh: { slot: "band", attachment: "band" }, points: [0, 1], width: 2, color: "000000ff" } } } } : {})
      }
    }
  };
}

// Band vertex 1 (70, -12) lies 2 px above the strip's top edge: an affine extension of triangle (3, 4, 9).
const EMBED = { slot: "skin", attachment: "strip", vertices: [1, 2, 3], points: [[3, 4, 9, 0.6, 0.5], [3, 4, 9, 0.5, 0.25], 3] };

const issues = (doc: unknown) => {
  const r = parseAnimDocument(doc);
  return r.ok ? [] : r.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("embedded mesh vertices", () => {
  it("validates the embed block (counts, ranges, source)", () => {
    expect(issues(raw(EMBED))).toEqual([]);
    expect(issues(raw({ ...EMBED, points: [3, 3] })).join("\n")).toMatch(/one point per embedded vertex/);
    expect(issues(raw({ ...EMBED, vertices: [1, 2, 9] })).join("\n")).toMatch(/out of range/);
    expect(issues(raw({ ...EMBED, attachment: "nope" })).join("\n")).toMatch(/embed source 'body\/skin\/nope' does not exist/);
    expect(issues(raw({ ...EMBED, points: [[3, 4, 99, 0.5, 0.5], 3, 3] })).join("\n")).toMatch(/vertex index 99 is out of range/);
  });

  it("poses embedded vertices bit for bit from the posed source triangle, every pose", () => {
    const doc = loadAnimDocument(raw(EMBED));
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const skinSlot = skeleton.getSlot("skin");
    const bandSlot = skeleton.getSlot("band");
    const strip = skeleton.getAttachment(skinSlot, "strip") as MeshAttachment;
    const band = skeleton.getAttachment(bandSlot, "band") as MeshAttachment;
    expect(band.embedSource).toBe(strip);
    for (const [upper, lower] of [[0, 0], [30, 0], [0, 70], [-15, 45], [105, 70]] as const) {
      skeleton.setToSetupPose();
      skeleton.getBone("upper").pose.rotation = upper;
      skeleton.getBone("lower").pose.rotation = lower;
      skeleton.updateWorldTransform("none");
      const s = skeleton.meshWorldVertices(strip, skinSlot.bone);
      const out = new Float32Array(8);
      skeleton.computeSlotWorldVertices(bandSlot, out);
      const bary = (a: number, b: number, c: number, wa: number, wb: number, k: number) => Math.fround((s[a * 2 + k] as number) * wa + (s[b * 2 + k] as number) * wb + (s[c * 2 + k] as number) * (1 - wa - wb));
      expect(out[2]).toBe(bary(3, 4, 9, 0.6, 0.5, 0));
      expect(out[3]).toBe(bary(3, 4, 9, 0.6, 0.5, 1));
      expect(out[4]).toBe(bary(3, 4, 9, 0.5, 0.25, 0));
      expect(out[6]).toBe(s[6]);
      expect(out[7]).toBe(s[7]);
      // Vertex 0 is not embedded: it stays on its own (root) weights.
      expect(out[0]).toBeCloseTo(50, 5);
    }
  });

  it("a contour on an embedded mesh rebuilds when the source's bones move", () => {
    const doc = loadAnimDocument(raw(EMBED, true));
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const contour = skeleton.activeContours[0];
    expect(contour).toBeDefined();
    const owners = [...(contour?.ownerBones ?? [])].map((b) => doc.bones[b]?.name);
    expect(owners).toEqual(expect.arrayContaining(["upper", "lower"]));
  });
});

describe("contour geometry dependencies (review, held-pose cache)", () => {
  /** The band contour plus a strip-top contour (hidden when `lower` turns past 30) in contact with it; a clip deforming the strip. */
  function dependencyDoc() {
    const doc = raw(EMBED, true) as ReturnType<typeof raw> & { animations?: unknown };
    const body = doc.skins.body as Record<string, unknown>;
    (body["contours"] as Record<string, unknown>)["skin"] = {
      top: { mesh: { slot: "skin", attachment: "strip" }, points: [0, 1, 2, 3], width: 2, color: "000000ff", visible: [{ bone: "lower", min: -30, max: 30 }] }
    };
    body["contourContacts"] = [{ a: { slot: "band", name: "edge" }, b: { slot: "skin", name: "top" }, gap: 3 }];
    doc.animations = { bend: { duration: 1, deform: { body: { skin: { strip: [{ time: 0, offset: 0, vertices: [0, 5, 0, 5] }] } } } } };
    return loadAnimDocument(doc);
  }

  it("an embedded garment's contour sees its source mesh's animation deform; a contact contour sees its partner's", async () => {
    const { AnimationState, AnimationStateData } = await import("./animationState.js");
    const doc = loadAnimDocument({ ...raw(EMBED, true), animations: { bend: { duration: 1, deform: { body: { skin: { strip: [{ time: 0, offset: 0, vertices: [0, 5] }] } } } } } });
    const skeleton = new Skeleton(doc);
    skeleton.setActiveSkins(["body"]);
    const edge = skeleton.activeContours[0]!;
    expect(edge.dependencies.length).toBe(0);
    expect(skeleton.contourHasAnimatedDeform(edge)).toBe(false);
    const state = new AnimationState(new AnimationStateData(doc));
    state.setAnimation(0, "bend");
    state.apply(skeleton);
    expect(skeleton.contourHasAnimatedDeform(edge)).toBe(true);

    // Contacts: the partner's mesh deform counts too.
    const doc2 = dependencyDoc();
    const s2 = new Skeleton(doc2);
    s2.setActiveSkins(["body"]);
    const edge2 = s2.activeContours.find((c) => c.name === "edge")!;
    const top = s2.activeContours.find((c) => c.name === "top")!;
    expect([...edge2.dependencies]).toEqual([top.id]);
    expect([...top.dependencies]).toEqual([edge2.id]);
    s2.setToSetupPose();
    expect(s2.contourHasAnimatedDeform(top)).toBe(false);
    const state2 = new AnimationState(new AnimationStateData(doc2));
    state2.setAnimation(0, "bend");
    state2.apply(s2);
    // `top` sits on the strip (own deform); the band rides the strip (embed source) and contacts `top`.
    expect(s2.contourHasAnimatedDeform(top)).toBe(true);
    expect(s2.contourHasAnimatedDeform(edge2)).toBe(true);
  });

  it("a contact partner's visibility is part of the dependent contour's geometry state", () => {
    const skeleton = new Skeleton(dependencyDoc());
    skeleton.setActiveSkins(["body"]);
    const edge = skeleton.activeContours.find((c) => c.name === "edge")!;
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();
    const shown = skeleton.contourDependencyVisibility(edge);
    expect(shown).toBe(1);
    skeleton.getBone("lower").pose.rotation = 60;
    skeleton.updateWorldTransform();
    expect(skeleton.contourDependencyVisibility(edge)).toBe(0);
  });
});
