import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { atlasPackSchema } from "../core/atlasPack.js";
import type { AnimDocumentInput } from "../core/format.js";
import { createImage, type MutableImage } from "./image.js";
import { readPng } from "./png.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { poseSkeleton } from "./review.js";
import { hairlines, samplePoses, texturesFromAtlas, validateRig, type ValidationCheck } from "./validate.js";

const fixture = (name: string) => new URL(`../../fixtures/rigs/${name}`, import.meta.url);
const threePart = () => JSON.parse(readFileSync(fixture("three-part.anim.json"), "utf8")) as AnimDocumentInput & Record<string, unknown>;
const threePartAtlas = () => atlasPackSchema.parse(JSON.parse(readFileSync(fixture("three-part.atlas.json"), "utf8")));
const threePartTextures = () => texturesFromAtlas(threePartAtlas(), new Map([["three-part.atlas.png", readPng(fileURLToPath(fixture("three-part.atlas.png")))]]));

function solid(width: number, height: number, rgb: readonly [number, number, number]): MutableImage {
  const image = createImage(width, height);
  for (let p = 0; p < image.data.length; p += 4) image.data.set([...rgb, 255], p);
  return image;
}

const checks = (report: ReturnType<typeof validateRig>, severity: "error" | "warning" = "error") =>
  new Set(report.issues.filter((issue) => issue.severity === severity).map((issue) => issue.check));

/**
 * Clipping fixture: a torso quad on bone `spine`, and a plate that covers it at rest. As a linked
 * mesh the plate bends with the torso (no clipping); as a region on the root it stays put while
 * the `bend` clip turns the spine, so the torso shows beside it (clipping).
 */
function clippingRig(plate: "linked" | "region"): AnimDocumentInput {
  const plateAttachment =
    plate === "linked"
      ? { type: "linkedMesh", path: "swag/plate", source: { skin: "body", slot: "torso", attachment: "torso" }, width: 60, height: 100 }
      : { type: "region", path: "swag/plate", x: 0, y: -60, width: 60, height: 100 };
  return {
    format: "atlas-anim@1",
    name: "clip",
    canvas: { width: 200, height: 200, originX: 100, originY: 170 },
    bones: [{ name: "root" }, { name: "spine", parent: "root", y: -10, rotation: -90, length: 100, limits: { min: -45, max: 45 } }],
    slots: [
      { name: "torso", bone: "spine", attachment: "torso" },
      { name: "plate", bone: plate === "linked" ? "spine" : "root", attachment: "plate" }
    ],
    skins: {
      body: {
        attachments: {
          torso: {
            torso: {
              type: "mesh",
              path: "body/torso",
              uvs: [0, 0, 1, 0, 1, 1, 0, 1],
              triangles: [0, 1, 2, 0, 2, 3],
              // spine local: x up the body, y to the right; the quad spans x 0..100, y -30..30.
              vertices: [100, -30, 100, 30, 0, 30, 0, -30],
              hull: 4,
              width: 60,
              height: 100
            }
          }
        }
      },
      plate: { attachments: { plate: { plate: plateAttachment } } }
    },
    animations: { bend: { duration: 1, bones: { spine: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 40 }] } } } }
  } as AnimDocumentInput;
}

const clippingTextures = () =>
  new Map([
    ["body/torso", solid(60, 100, [230, 180, 140])],
    ["swag/plate", solid(60, 100, [120, 120, 140])]
  ]);

describe("validators", () => {
  it("pass the fixture rig, including the clipping check over its clips", () => {
    // The hand-made fixture's 10-vertex torso is too coarse for the tears check (tested below).
    // Rest only: before the default review poses named humanoid bones, so this rig was only
    // ever judged at rest; the rig-derived poses take its chest to its declared +-90 limits, which
    // the 10-vertex torso cannot follow (asserted below, so the coarse fixture stays honest).
    const options = { atlas: threePartAtlas(), textures: threePartTextures(), budgets: { bodyVertices: 260 }, tears: false } as const;
    const derived = validateRig(threePart(), options);
    expect(derived.issues.some((issue) => issue.check === "geometry" && /torso\/torso.*limb depth 2/.test(issue.message))).toBe(true);
    const report = validateRig(threePart(), { ...options, poses: [{ name: "rest", rotate: {} }] });
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
    // The tunic is a linked mesh of the torso: it was checked at every sample and never clipped.
    expect(report.clipping.length).toBeGreaterThan(0);
    expect(report.clipping.every((entry) => entry.flagged === 0)).toBe(true);
  });

  it("flag a deliberately clipping swag piece and pass the linked one", () => {
    const linked = validateRig(clippingRig("linked"), { textures: clippingTextures() });
    expect(linked.ok).toBe(true);
    expect(linked.clipping.every((entry) => entry.flagged === 0)).toBe(true);

    const region = validateRig(clippingRig("region"), { textures: clippingTextures() });
    expect(region.ok).toBe(false);
    expect(checks(region)).toEqual(new Set<ValidationCheck>(["clipping"]));
    // At time 0 nothing moved; by the end the torso shows beside the plate.
    expect(region.clipping[0]?.flagged).toBe(0);
    expect(region.clipping.at(-1)?.flagged ?? 0).toBeGreaterThan(100);
  });

  it("sample clips at the reported time (the last step lands on the target, not the preceding 60 Hz step)", () => {
    const doc = loadAnimDocument(clippingRig("region"));
    const seen: { time: number; rotation: number }[] = [];
    samplePoses(doc, ["body"], 8, (skeleton, clip, time) => {
      if (clip !== null) seen.push({ time, rotation: (skeleton.findBone("spine") as { pose: { rotation: number } }).pose.rotation });
    });
    // Sevenths of a second are not whole 60 Hz steps.
    expect(seen.map((entry) => entry.time)).toEqual(Array.from({ length: 8 }, (_, k) => expect.closeTo(k / 7, 9)));
    // The clip turns the spine linearly 0 -> 40 degrees over 1 s from its setup rotation (-90).
    for (const entry of seen) expect(entry.rotation).toBeCloseTo(-90 + 40 * entry.time, 6);
  });

  it("check every declared outfit combination, besides the body alone and the body with each item", () => {
    const doc = clippingRig("region") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    doc.slots.push({ name: "cape", bone: "root", attachment: "cape" });
    doc.skins.cape = { attachments: { cape: { cape: { type: "region", path: "swag/plate", x: 0, y: -40, width: 20, height: 20 } } } };
    const plain = validateRig(doc, { textures: clippingTextures() });
    expect(new Set(plain.tears.map((entry) => entry.outfit))).toEqual(new Set(["body", "body+plate", "body+cape"]));
    const combined = validateRig(doc, { textures: clippingTextures(), outfits: [["plate", "cape"]] });
    expect(new Set(combined.tears.map((entry) => entry.outfit))).toEqual(new Set(["body", "body+plate", "body+cape", "body+plate+cape"]));
    expect(combined.clipping.some((entry) => entry.skin === "plate+cape" && entry.flagged > 0)).toBe(true);
    // A combination naming an unknown skin is a format error in the report (never a throw), and
    // that outfit is not checked.
    const unknown = validateRig(doc, { textures: clippingTextures(), outfits: [["plate", "missing"]] });
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.filter((issue) => issue.check === "format").map((issue) => issue.message)).toEqual([
      "declared outfit plate+missing names skin 'missing', which the document lacks (outfit not checked)"
    ]);
    expect(new Set(unknown.tears.map((entry) => entry.outfit))).toEqual(new Set(["body", "body+plate", "body+cape"]));
  });

  const broken: [string, (doc: Record<string, any>) => void, ValidationCheck][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["weights that do not sum to 1", (doc) => (doc.skins.body.attachments.torso.torso.vertices[4] = 0.7), "weights"],
    ["an orphan vertex", (doc) => {
      const mesh = doc.skins.body.attachments.torso.torso;
      mesh.uvs.push(0.5, 0.5);
      mesh.vertices.push(1, 0, 10, 0, 1);
    }, "weights"],
    ["a degenerate triangle", (doc) => doc.skins.body.attachments.torso.torso.triangles.push(0, 0, 1), "mesh"],
    ["a rotate key past the limits", (doc) => (doc.animations.attack.bones.chest.rotate[2].value = 95), "limits"],
    ["a vertex budget overrun", () => undefined, "budget"],
    ["a texture with no atlas region", (doc) => (doc.skins.tunic.attachments.tunic.tunic.path = "swag/missing"), "atlas"],
    ["a pose that leaves the canvas", (doc) => (doc.bones[1].y = -200), "bounds"]
  ];
  for (const [label, damage, check] of broken) {
    it(`fail ${label}`, () => {
      const doc = threePart();
      damage(doc);
      const report = validateRig(doc, { atlas: threePartAtlas(), budgets: { bodyVertices: label.includes("budget") ? 8 : 260 } });
      expect(report.ok, label).toBe(false);
      expect(checks(report), label).toContain(check);
    });
  }

  it("warn on slivers and unstable physics, and report loader errors as format errors", () => {
    const doc = threePart() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    doc.skins.body.attachments.torso.torso.uvs[2] = 0.02; // squashes the first triangle to a sliver
    doc.bones.push({ name: "tail", parent: "hips", length: 10 });
    doc.physics = [{ name: "tail", bone: "tail", rotate: 1, strength: 5000, fps: 60 }];
    const report = validateRig(doc);
    expect(checks(report, "warning")).toEqual(expect.objectContaining(new Set(["mesh", "physics"])));
    expect(report.issues.filter((issue) => issue.message.includes("fps^2"))).toHaveLength(1);

    const invalid = validateRig({ format: "atlas-anim@1", name: "x" });
    expect(invalid.ok).toBe(false);
    expect(checks(invalid)).toEqual(new Set(["format"]));
  });

  describe("tears", () => {
    // Two quads stacked on two bones. Unweighted, the upper quad turns rigidly about a pivot above it and
    // its foot leaves the lower quad; weighted, its foot stays on `lower` and the quad bends.
    function stack(weighted: boolean): AnimDocumentInput {
      const quad = (path: string, y0: number) => ({ type: "mesh", path, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], vertices: [y0 + 50, -30, y0 + 50, 30, y0, 30, y0, -30], hull: 4, width: 60, height: 50 });
      const upper = weighted
        ? { ...quad("body/upper", 0), bones: ["lower", "upper"], vertices: [1, 1, -50, -30, 1, 1, 1, -50, 30, 1, 1, 0, 50, 30, 1, 1, 0, 50, -30, 1] }
        : quad("body/upper", -100);
      return {
        format: "atlas-anim@1",
        name: "stack",
        canvas: { width: 300, height: 300, originX: 150, originY: 250 },
        bones: [
          { name: "root" },
          { name: "lower", parent: "root", rotation: -90, length: 50 },
          // The pivot sits 100 px above the upper quad: turning it swings the whole quad away.
          { name: "upper", parent: "lower", x: 150, length: 25, limits: { min: -60, max: 60 } }
        ],
        slots: [{ name: "lower", bone: "lower", attachment: "lower" }, { name: "upper", bone: "upper", attachment: "upper" }],
        skins: { body: { attachments: { lower: { lower: quad("body/lower", 0) }, upper: { upper } } } },
        animations: { bend: { duration: 1, bones: { upper: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 60 }] } } } }
      } as AnimDocumentInput;
    }
    const textures = () => new Map([["body/lower", solid(60, 50, [200, 150, 120])], ["body/upper", solid(60, 50, [120, 150, 200])]]);

    it("flag a joint that opens between two parts", () => {
      const report = validateRig(stack(false), { textures: textures(), poses: [], joints: [{ parent: "lower", child: "upper" }] });
      expect(report.ok).toBe(false);
      const messages = report.issues.filter((issue) => issue.check === "tears").map((issue) => issue.message);
      expect(messages.some((message) => message.includes("joint opened between 'lower' and 'upper'"))).toBe(true);
      expect(report.tears[0]?.errors).toBe(0); // time 0 is the rest pose
    });

    it("judge contact only for declared joints (no sidecar: no joint-contact rule)", () => {
      const report = validateRig(stack(false), { textures: textures(), poses: [] });
      expect(report.issues.filter((issue) => issue.message.includes("joint opened"))).toEqual([]);
    });

    it("flag a torn mesh in the geometry check (unified evaluator)", () => {
      // The upper quad's top vertices ride 'upper', its bottom ones 'lower': bending 60 degrees
      // about the joint keeps contact but a 90-degree pose stretches the diagonal far past 2.2x.
      const doc = stack(true) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      doc.skins.body.attachments.upper.upper.vertices = [1, 1, 50, -30, 1, 1, 1, 50, 30, 1, 1, 0, 50, 30, 1, 1, 0, 50, -30, 1];
      doc.bones[2].x = 0;
      doc.bones[2].limits = { min: -180, max: 180 };
      doc.animations.bend.bones.upper.rotate[1].value = 170;
      const report = validateRig(doc, { textures: textures(), poses: [] });
      // Judged by the unified geometry evaluator: principal stretch past 2.2x.
      // This quad has zero area at bind (its edges meet where the bones do), so it has no
      // deformation gradient: a collapse at every pose.
      expect(report.issues.some((issue) => issue.check === "geometry" && issue.severity === "error")).toBe(true);
      expect(report.geometry.findings.some((f) => f.mesh === "upper/upper" && f.severity === "error")).toBe(true);
    });

    it("flag a hairline speck at 3x that the 1x id buffer misses", () => {
      // One transparent texel inside the lower quad: too small for the hole check, a light speck
      // at 3x.
      const speck = textures();
      (speck.get("body/lower") as MutableImage).data[(25 * 60 + 30) * 4 + 3] = 0;
      const skeleton = poseSkeleton(loadAnimDocument(stack(true)), ["body"], null);
      expect(hairlines(skeleton, speck, { width: 300, height: 300 }).count).toBeGreaterThan(0);
      expect(hairlines(skeleton, textures(), { width: 300, height: 300 }).count).toBe(0);
      // A speck the rest pose already has is not exempt (no rest-hairline exemption).
      const atRest = validateRig(stack(true), { textures: speck, poses: [{ name: "rest", rotate: {} }], samples: 1 });
      expect(atRest.tears[0]?.hairlines ?? 0).toBeGreaterThan(0);
    });

    it("run the 3x hairline check on clip samples too", () => {
      const speck = textures();
      (speck.get("body/lower") as MutableImage).data[(25 * 60 + 30) * 4 + 3] = 0;
      const report = validateRig(stack(true), { textures: speck, poses: [], samples: 3 });
      const clipSamples = report.tears.filter((entry) => entry.pose.startsWith("'bend'"));
      expect(clipSamples).toHaveLength(3);
      expect(clipSamples.every((entry) => entry.hairlines > 0)).toBe(true);
    });

    it("flag a hairline gap between two parts near the silhouette (no near-edge exemption)", () => {
      // The upper quad starts half a canvas px above the lower one: a see-through seam across the
      // whole width, open to the outside at both ends.
      const doc = stack(false) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      doc.skins.body.attachments.upper.upper.vertices = [-49.5, -30, -49.5, 30, -99.5, 30, -99.5, -30];
      const skeleton = poseSkeleton(loadAnimDocument(doc as AnimDocumentInput), ["body"], null);
      expect(hairlines(skeleton, textures(), { width: 300, height: 300 }).count).toBeGreaterThan(0);
    });

    it("flag a rim hidden at rest that shows across a part's fill, and pass a revealed band of cloth", () => {
      // The lower quad carries an outline-coloured bar across its skin, hidden at rest under a
      // cover drawn above it; the pose swings the cover away and reveals the bar.
      const covered = (bar: readonly [number, number, number]): { doc: AnimDocumentInput; textures: Map<string, MutableImage> } => {
        const doc = stack(false) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        doc.bones.push({ name: "cover", parent: "root" });
        doc.slots.push({ name: "cover", bone: "cover", attachment: "cover" });
        doc.skins.body.attachments.cover = { cover: { type: "region", path: "body/cover", x: 0, y: -25, width: 30, height: 30 } };
        delete doc.animations;
        const skin = solid(60, 50, [235, 180, 140]);
        for (let y = 22; y < 28; y++) for (let x = 12; x < 48; x++) skin.data.set([...bar, 255], (y * 60 + x) * 4);
        // An outline round the quad, so the silhouette's own ink is the outline colour.
        for (let y = 0; y < 50; y++) for (let x = 0; x < 60; x++) if (x < 3 || y < 3 || x > 56 || y > 46) skin.data.set([58, 16, 2, 255], (y * 60 + x) * 4);
        const map = new Map([["body/lower", skin], ["body/upper", solid(60, 50, [120, 150, 200])], ["body/cover", solid(30, 30, [235, 180, 140])]]);
        return { doc: doc as AnimDocumentInput, textures: map };
      };
      const pose = [{ name: "cover away", rotate: { cover: 90 } }];
      const rim = covered([58, 16, 2]);
      const flagged = validateRig(rim.doc, { textures: rim.textures, poses: pose });
      expect(flagged.tears.find((entry) => entry.pose === "pose 'cover away'")?.buriedInk ?? 0).toBeGreaterThan(20);
      // A generated piece slot (`<part>.<piece>`) is judged like any part (no exemption).
      const piece = covered([58, 16, 2]) as { doc: Record<string, any>; textures: Map<string, MutableImage> }; // eslint-disable-line @typescript-eslint/no-explicit-any
      piece.doc.slots[0].name = "lower.rim";
      piece.doc.skins.body.attachments["lower.rim"] = piece.doc.skins.body.attachments.lower;
      delete piece.doc.skins.body.attachments.lower;
      const pieceReport = validateRig(piece.doc as AnimDocumentInput, { textures: piece.textures, poses: pose });
      expect(pieceReport.tears.find((entry) => entry.pose === "pose 'cover away'")?.buriedInk ?? 0).toBeGreaterThan(20);
      const band = covered([70, 70, 75]);
      const passed = validateRig(band.doc, { textures: band.textures, poses: pose });
      expect(passed.tears.find((entry) => entry.pose === "pose 'cover away'")?.buriedInk).toBe(0);
    });

    it("pass a mesh that bends without opening", () => {
      const report = validateRig(stack(true), { textures: textures(), poses: [] });
      expect(report.issues.filter((issue) => issue.check === "tears" && issue.severity === "error")).toEqual([]);
    });
  });
});

describe("budgets from the preset or the document ()", () => {
  const budgetIssues = (report: ReturnType<typeof validateRig>) => report.issues.filter((issue) => issue.check === "budget").map((issue) => `${issue.severity}: ${issue.message}`);

  it("no generic vertex budget: undeclared = a warning, never a humanoid default", () => {
    const issues = budgetIssues(validateRig(threePart(), { tears: false }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^warning: no vertex budget declared/);
  });

  it("the document's budgets apply; the preset is under the document; explicit options win", () => {
    const declared = { ...threePart(), budgets: { bodyVertices: 8 } };
    expect(budgetIssues(validateRig(declared, { tears: false }))).toEqual([expect.stringMatching(/^error: the body has \d+ vertices \(budget 8\)/)]);
    const preset = { name: "test", budgets: { bodyVertices: 4, chains: [{ from: "root", to: "nowhere", budget: 1 }] } };
    expect(budgetIssues(validateRig(declared, { tears: false, preset }))).toEqual([expect.stringMatching(/\(budget 8\)/)]);
    expect(budgetIssues(validateRig(threePart(), { tears: false, preset }))).toEqual([expect.stringMatching(/\(budget 4\)/)]);
    expect(budgetIssues(validateRig(declared, { tears: false, budgets: { bodyVertices: 10_000 } }))).toEqual([]);
  });

  it("chain budgets come from the declared budgets (none by default)", () => {
    const doc = threePart() as AnimDocumentInput;
    const bones = (doc.bones ?? []).map((b) => b.name);
    const [from, to] = [bones[0] as string, bones[bones.length - 1] as string];
    expect(validateRig(doc, { tears: false }).issues.filter((i) => i.check === "chains")).toEqual([]);
    const tight = { ...doc, budgets: { bodyVertices: 10_000, chains: [{ from, to, budget: 0.001 }] } };
    const chainIssues = validateRig(tight, { tears: false }).issues.filter((i) => i.check === "chains");
    // A chain with limited bones between its ends warns; one without has nothing to sum.
    expect(chainIssues.every((i) => i.severity === "warning")).toBe(true);
  });
});
