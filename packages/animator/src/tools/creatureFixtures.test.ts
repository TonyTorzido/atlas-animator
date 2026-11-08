/*
 * Plan item 7: five behavioural fixtures (tiny synthetic rigs and meshes, not art), each
 * with authoring metadata, weighted through the command bus (`weights.auto`), checked by the
 * validator (authoring check) and by weights tests with shuffled sibling order where there are
 * siblings to shuffle. Plan: outcome checks instead of probe-name echoes,
 * the bat's negative control, the slime's deformation measured on the mesh, and the generic rest
 * render / exact-bind tests the raster rig's suite used to carry.
 */
import { describe, expect, it, vi } from "vitest";
import { FORMAT_ID, type AnimDocument, type AuthoringData } from "../core/format.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { autoMesh } from "./autoMesh.js";
import { autoWeightsTree, type WeightTree } from "./autoWeights.js";
import pixelmatch from "pixelmatch";
import { authoringJoints, validateAuthoring } from "./authoring.js";
import { applyCommands } from "./commands.js";
import type { JsonObject } from "./jsonPatch.js";
import { seeded, shuffleSiblings, weightsByName } from "./generalityHelpers.js";
import { outlineImage } from "./outline.js";
import { poseSkeleton } from "./review.js";
import { inferRoles, rigPoses } from "./rigPoses.js";
import { softRender } from "./softRender.js";
import { capsule, paintShapes, type Shape } from "./testFigures.js";

interface FixtureBone {
  name: string;
  parent: string | null;
  start: { x: number; y: number };
  end: { x: number; y: number };
  radius: number;
}

interface Fixture {
  name: string;
  shapes: Shape[];
  bones: FixtureBone[];
  /** weights.auto chains: the first is the trunk, the rest hang from a bone of an earlier chain. */
  chains: { bones: string[]; parent?: string }[];
  authoring: AuthoringData;
}

const W = 320;
const H = 240;
const ORIGIN = { x: 160, y: 230 };

function polygon(points: readonly [number, number][]): Shape {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [ax, ay] = points[i] as [number, number];
      const [bx, by] = points[j] as [number, number];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
}

const at = (x: number, y: number) => ({ x, y });
const b = (name: string, parent: string | null, start: { x: number; y: number }, end: { x: number; y: number }, radius: number): FixtureBone => ({ name, parent, start, end, radius });

/** Bone data (local transforms under a root at the canvas origin) for canvas-space segments. */
function documentOf(fixture: Fixture): JsonObject {
  const angle = (bone: FixtureBone) => Math.atan2(bone.end.y - bone.start.y, bone.end.x - bone.start.x);
  const byName = new Map(fixture.bones.map((bone) => [bone.name, bone]));
  const bones: Record<string, unknown>[] = [{ name: "root" }];
  for (const bone of fixture.bones) {
    const parent = bone.parent ? (byName.get(bone.parent) as FixtureBone) : null;
    const base = parent ? parent.start : ORIGIN;
    const turn = parent ? angle(parent) : 0;
    const dx = bone.start.x - base.x;
    const dy = bone.start.y - base.y;
    const x = dx * Math.cos(-turn) - dy * Math.sin(-turn);
    const y = dx * Math.sin(-turn) + dy * Math.cos(-turn);
    const rotation = ((angle(bone) - turn) * 180) / Math.PI;
    bones.push({ name: bone.name, parent: bone.parent ?? "root", x, y, rotation, length: Math.hypot(bone.end.x - bone.start.x, bone.end.y - bone.start.y) });
  }
  return {
    format: FORMAT_ID,
    name: fixture.name,
    canvas: { width: W, height: H, originX: ORIGIN.x, originY: ORIGIN.y },
    bones,
    slots: [{ name: "fig", bone: "root", attachment: "fig" }],
    skins: { body: { attachments: { fig: { fig: { type: "region", path: "body/fig", x: W / 2 - ORIGIN.x, y: H / 2 - ORIGIN.y, width: W, height: H } } } } },
    authoring: fixture.authoring
  } as unknown as JsonObject;
}

/** Decoded weighted mesh: per vertex, bone name -> weight. */
function meshWeights(doc: JsonObject): Record<string, number>[] {
  const mesh = (doc["skins"] as Record<string, { attachments: Record<string, Record<string, { bones: string[]; vertices: number[] }>> }>)["body"]?.attachments["fig"]?.["fig"];
  if (!mesh) throw new Error("no mesh");
  const out: Record<string, number>[] = [];
  for (let i = 0; i < mesh.vertices.length; ) {
    const n = mesh.vertices[i] as number;
    const entry: Record<string, number> = {};
    for (let k = 0; k < n; k++) entry[mesh.bones[mesh.vertices[i + 1 + k * 4] as number] as string] = mesh.vertices[i + 4 + k * 4] as number;
    out.push(Object.fromEntries(Object.entries(entry).sort(([p], [q]) => (p < q ? -1 : 1))));
    i += 1 + n * 4;
  }
  return out;
}

function build(fixture: Fixture, chains = fixture.chains) {
  const image = paintShapes(W, H, fixture.shapes.map((shape) => [shape, [200, 120, 60]] as const));
  const outline = outlineImage(image);
  const raw = documentOf(fixture);
  const result = applyCommands(raw, [
    { op: "mesh.generate", skin: "body", slot: "fig", name: "fig", outline: { outer: outline.outer.map((p) => [p.x, p.y]), ...(outline.holes.length > 0 ? { holes: outline.holes.map((h) => h.map((p) => [p.x, p.y])) } : {}) }, targetVertices: 220 },
    { op: "weights.auto", skin: "body", slot: "fig", name: "fig", ...(chains.length === 1 ? { bones: (chains[0] as { bones: string[] }).bones } : { chains }) }
  ]);
  const doc = loadAnimDocument(result.doc);
  return { image, outline, raw: result.doc as JsonObject, doc, notes: result.notes ?? [] };
}

/** The fixture's chains with every non-trunk chain in a shuffled order. */
function shuffledChains(fixture: Fixture, seed: number) {
  const rand = seeded(seed);
  const rest = fixture.chains.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand(0, i + 1));
    [rest[i], rest[j]] = [rest[j] as Fixture["chains"][number], rest[i] as Fixture["chains"][number]];
  }
  return [fixture.chains[0] as Fixture["chains"][number], ...rest];
}

/** The direct tree (no authoring options) for the sibling-shuffle test of autoWeightsTree. */
function treeOf(fixture: Fixture): WeightTree {
  const index = new Map(fixture.bones.map((bone, k) => [bone.name, k]));
  return { bones: fixture.bones.map((bone) => ({ name: bone.name, start: bone.start, end: bone.end, radius: bone.radius, parent: bone.parent ? (index.get(bone.parent) as number) : -1 })) };
}

function common(fixture: Fixture) {
  const built = build(fixture);
  // Bones sit where the fixture drew them.
  const skeleton = new Skeleton(built.doc);
  skeleton.x = ORIGIN.x;
  skeleton.y = ORIGIN.y;
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("pose");
  for (const bone of fixture.bones) {
    const world = { x: 0, y: 0 };
    skeleton.findBone(bone.name)?.localToWorld(0, 0, world);
    expect(Math.hypot(world.x - bone.start.x, world.y - bone.start.y), bone.name).toBeLessThan(1e-6);
  }
  // The validator's authoring check passes.
  expect(validateAuthoring(built.doc).filter((issue) => issue.severity === "error")).toEqual([]);
  // Shuffled sibling order: identical weights through the command bus (only with two or more
  // branch chains to reorder; a single chain has no sibling order, so no claim is made)...
  const weights = meshWeights(built.raw);
  if (fixture.chains.length > 2) for (let seed = 1; seed <= 3; seed++) expect(meshWeights(build(fixture, shuffledChains(fixture, seed)).raw)).toEqual(weights);
  // ...and through autoWeightsTree directly (only where some bone has two or more children).
  const childCounts = new Map<string, number>();
  for (const bone of fixture.bones) if (bone.parent) childCounts.set(bone.parent, (childCounts.get(bone.parent) ?? 0) + 1);
  if ([...childCounts.values()].some((n) => n >= 2)) {
    const mesh = autoMesh(built.outline, { targetVertices: 160 });
    const tree = treeOf(fixture);
    const reference = weightsByName(autoWeightsTree(mesh, tree));
    for (let seed = 1; seed <= 3; seed++) expect(weightsByName(autoWeightsTree(mesh, shuffleSiblings(tree, seed)))).toEqual(reference);
  }
  // Every review pose (probes included) poses the rig to finite transforms.
  const poses = rigPoses(built.doc);
  for (const pose of poses) {
    const posed = poseSkeleton(built.doc, ["body"], pose);
    for (const bone of posed.bones) {
      const world = { x: 0, y: 0 };
      bone.localToWorld(0, 0, world);
      expect(Number.isFinite(world.x) && Number.isFinite(world.y), `${pose.name} ${bone.data.name}`).toBe(true);
    }
  }
  return { ...built, weights, poses, vertices: built.doc.skins["body"]?.attachments["fig"]?.["fig"] as unknown as { uvs: number[] } };
}

/** Canvas position of each mesh vertex (from its UVs on the full-canvas region). */
const positions = (built: { vertices: { uvs: number[] } }) => {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < built.vertices.uvs.length; i += 2) out.push({ x: (built.vertices.uvs[i] as number) * W, y: (built.vertices.uvs[i + 1] as number) * H });
  return out;
};

/** The two-headed boss fixture (two head chains off one torso, a tail lying over the torso). */
function boss(): Fixture {
  const top = at(160, 120);
  return {
    name: "boss",
    shapes: [capsule(160, 210, 160, 120, 32), capsule(160, 120, 110, 70, 12), capsule(110, 70, 95, 35, 14), capsule(160, 120, 210, 70, 12), capsule(210, 70, 225, 35, 14), capsule(150, 200, 260, 215, 8)],
    bones: [
      b("torso", null, at(160, 210), top, 32),
      b("neck_a", "torso", top, at(110, 70), 12),
      b("head_a", "neck_a", at(110, 70), at(95, 35), 14),
      b("neck_b", "torso", top, at(210, 70), 12),
      b("head_b", "neck_b", at(210, 70), at(225, 35), 14),
      b("tail", "torso", at(150, 200), at(260, 215), 8)
    ],
    chains: [{ bones: ["torso"] }, { bones: ["neck_a", "head_a"], parent: "torso" }, { bones: ["neck_b", "head_b"], parent: "torso" }, { bones: ["tail"], parent: "torso" }],
    authoring: {
      chains: [
        { id: "torso", bones: ["torso"], role: "spine" },
        { id: "head_a", bones: ["neck_a", "head_a"], parent: "torso", role: "head", symmetry: "heads" },
        { id: "head_b", bones: ["neck_b", "head_b"], parent: "torso", role: "head", symmetry: "heads" },
        { id: "tail", bones: ["tail"], parent: "torso", role: "tail" }
      ],
      connections: [{ between: ["tail", "torso"], kind: "overlap" }],
      probes: [{ name: "heads", kind: "relative", chains: ["head_a", "head_b"], amount: 25 }]
    }
  };
}

/** The fixture mesh of a loaded document (UVs, triangles). */
const figMesh = (doc: AnimDocument) => doc.skins["body"]?.attachments["fig"]?.["fig"] as unknown as { uvs: number[]; triangles: number[] };

/** World vertices of the fixture mesh under a review pose (null = setup pose). */
function posedVertices(doc: AnimDocument, pose: Parameters<typeof poseSkeleton>[2]): { x: number; y: number }[] {
  const skeleton = poseSkeleton(doc, ["body"], pose);
  const slot = skeleton.findSlot("fig");
  if (!slot) throw new Error("no fig slot");
  const world = new Float64Array(skeleton.slotWorldFloats(slot));
  const count = skeleton.computeSlotWorldVertices(slot, world);
  return Array.from({ length: count }, (_, v) => ({ x: world[v * 2] as number, y: world[v * 2 + 1] as number }));
}

/** Area of the fixture mesh's triangles at the given vertex positions. */
function meshArea(doc: AnimDocument, points: readonly { x: number; y: number }[]): number {
  const { triangles } = figMesh(doc);
  let area = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b2, c] = [0, 1, 2].map((k) => points[triangles[t + k] as number] as { x: number; y: number }) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    area += Math.abs((b2.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b2.y - a.y)) / 2;
  }
  return area;
}

// Each fixture auto-meshes, weights and soft-renders a figure: ~1-2 s alone, past vitest's 5 s
// default under full-suite load (59 files in parallel forks). A per-file budget, not a lighter fixture:
// the fixtures' sizes are what the generality checks measure.
vi.setConfig({ testTimeout: 30_000 });

describe("creature fixtures (item 7)", () => {
  it("bat wing: a membrane lets sibling fingers blend away from their hub", () => {
    const hub = at(120, 120);
    const fingers = [at(250, 40), at(280, 120), at(250, 200)];
    const fixture: Fixture = {
      name: "bat",
      shapes: [capsule(40, 120, 120, 120, 12), polygon([[hub.x, hub.y], [fingers[0]!.x, fingers[0]!.y], [fingers[1]!.x, fingers[1]!.y], [fingers[2]!.x, fingers[2]!.y]]), ...fingers.map((f) => capsule(hub.x, hub.y, f.x, f.y, 6))],
      bones: [b("arm", null, at(40, 120), hub, 12), ...fingers.map((f, k) => b(`finger_${k}`, "arm", hub, f, 6))],
      chains: [{ bones: ["arm"] }, ...fingers.map((_, k) => ({ bones: [`finger_${k}`], parent: "arm" }))],
      authoring: {
        chains: [{ id: "arm", bones: ["arm"] }, ...fingers.map((_, k) => ({ id: `f${k}`, bones: [`finger_${k}`], parent: "arm" }))],
        connections: [
          { between: ["f0", "f1"], kind: "membrane" },
          { between: ["f1", "f2"], kind: "membrane" }
        ],
        domains: [{ id: "wing", slot: "fig", bones: ["arm", "finger_0", "finger_1", "finger_2"] }],
        probes: [{ name: "fold", kind: "rotate", bones: ["finger_0", "finger_2"], amount: 30 }]
      }
    };
    const built = common(fixture);
    // Membrane vertices well away from the hub carry two fingers.
    const blendedFar = (raw: JsonObject) => {
      const where = positions({ vertices: figMesh(loadAnimDocument(raw)) });
      return meshWeights(raw).filter((w, v) => Math.hypot((where[v] as { x: number }).x - hub.x, (where[v] as { y: number }).y - hub.y) > 60 && (w["finger_0"] ?? 0) > 0.1 && (w["finger_1"] ?? 0) > 0.1).length;
    };
    expect(blendedFar(built.raw)).toBeGreaterThan(0);
    // Negative control: the same wing without the membrane connections never blends the fingers there.
    const control = build({ ...fixture, authoring: { ...fixture.authoring, connections: [] } });
    expect(blendedFar(control.raw)).toBe(0);
  });

  // A single chain: no sibling order to shuffle, so the shuffle claim is not made (see common()).
  it("snake: 17 bones in one chain (no authoring cap), travelling-wave probe", () => {
    const bones = Array.from({ length: 17 }, (_, k) => b(`s${k}`, k === 0 ? null : `s${k - 1}`, at(24 + k * 16, 120), at(40 + k * 16, 120), 9));
    const fixture: Fixture = {
      name: "snake",
      shapes: [capsule(24, 120, 296, 120, 9)],
      bones,
      chains: [{ bones: bones.map((bone) => bone.name) }],
      authoring: { chains: [{ id: "body", bones: bones.map((bone) => bone.name), role: "spine", range: 20 }], probes: [{ name: "slither", kind: "wave", chain: "body", amount: 15, steps: 8 }] }
    };
    const built = common(fixture);
    const wave = built.poses.filter((p) => p.name.startsWith("slither"));
    expect(wave).toHaveLength(8);
    // A travelling wave: the sign pattern along the body shifts between steps.
    const signs = (p: (typeof wave)[number]) => bones.map((bone) => Math.sign(p.rotate[bone.name] ?? 0)).join("");
    expect(new Set(wave.map(signs)).size).toBeGreaterThan(2);
    const used = new Set(built.weights.flatMap((w) => Object.keys(w)));
    expect(used.size).toBe(17);
  });

  it("spider: eight legs off one hub stay independent; symmetry groups pair them", () => {
    const hub = at(160, 120);
    const legs = Array.from({ length: 8 }, (_, k) => {
      const a = ((k + 0.5) / 8) * 2 * Math.PI;
      const knee = at(hub.x + 45 * Math.cos(a), hub.y + 45 * Math.sin(a) * 0.8);
      const tip = at(hub.x + 95 * Math.cos(a), hub.y + 95 * Math.sin(a) * 0.8);
      return { knee, tip };
    });
    const fixture: Fixture = {
      name: "spider",
      shapes: [capsule(140, 120, 180, 120, 18), ...legs.flatMap(({ knee, tip }) => [capsule(hub.x, hub.y, knee.x, knee.y, 5), capsule(knee.x, knee.y, tip.x, tip.y, 4)])],
      bones: [b("body", null, at(140, 120), at(180, 120), 18), ...legs.flatMap(({ knee, tip }, k) => [b(`leg${k}_a`, "body", hub, knee, 5), b(`leg${k}_b`, `leg${k}_a`, knee, tip, 4)])],
      chains: [{ bones: ["body"] }, ...legs.map((_, k) => ({ bones: [`leg${k}_a`, `leg${k}_b`], parent: "body" }))],
      authoring: {
        chains: [{ id: "body", bones: ["body"], role: "spine" }, ...legs.map((_, k) => ({ id: `leg${k}`, bones: [`leg${k}_a`, `leg${k}_b`], parent: "body", symmetry: `pair${k % 4}` }))],
        domains: [{ id: "spider", slot: "fig", bones: ["body", ...legs.flatMap((_, k) => [`leg${k}_a`, `leg${k}_b`])] }]
      }
    };
    const built = common(fixture);
    const where = positions(built);
    // Vertices on a leg's outer half carry only that leg (no other leg, wherever the legs are listed).
    let checked = 0;
    legs.forEach(({ knee, tip }, k) => {
      const mid = at((knee.x + tip.x) / 2, (knee.y + tip.y) / 2);
      built.weights.forEach((w, v) => {
        const p = where[v] as { x: number; y: number };
        if (Math.hypot(p.x - mid.x, p.y - mid.y) > 10) return;
        checked++;
        for (const bone of Object.keys(w)) expect(bone.startsWith(`leg${k}_`) || bone === "body", `leg ${k} vertex ${v}: ${bone}`).toBe(true);
      });
    });
    expect(checked).toBeGreaterThan(8);
    const { chains } = inferRoles(built.doc);
    expect(chains.filter((c) => c.twin !== undefined)).toHaveLength(8);
    // A domain without leg0_b: no vertex is influenced by it, and the validator still passes.
    const narrowed = { ...fixture, authoring: { ...fixture.authoring, domains: [{ id: "spider", slot: "fig", bones: (fixture.authoring.domains?.[0]?.bones ?? []).filter((bone) => bone !== "leg0_b") }] } };
    const without = build(narrowed);
    expect(meshWeights(without.raw).some((w) => "leg0_b" in w)).toBe(false);
    expect(validateAuthoring(without.doc).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("slime: no anatomical skeleton, deform / scale / translate probes", () => {
    const fixture: Fixture = {
      name: "slime",
      shapes: [(x, y) => ((x - 160) / 60) ** 2 + ((y - 150) / 45) ** 2 <= 1],
      bones: [b("core", null, at(160, 190), at(160, 110), 50)],
      chains: [{ bones: ["core"] }],
      authoring: {
        chains: [{ id: "core", bones: ["core"], role: "other" }],
        domains: [{ id: "blob", slot: "fig", bones: ["core"] }],
        probes: [
          { name: "wobble", kind: "deform", bones: ["core"], amount: 1.3 },
          { name: "swell", kind: "scale", bones: ["core"], x: 1.2, y: 1.2 },
          { name: "hop", kind: "translate", bones: ["core"], y: -12 },
          { name: "hide", kind: "attachment", slot: "fig", attachment: null }
        ]
      }
    };
    const built = common(fixture);
    const pose = (name: string) => {
      const found = built.poses.find((p) => p.name === name);
      if (!found) throw new Error(`no pose ${name}`);
      return found;
    };
    // Outcomes on the skinned mesh (one bone, weight 1 everywhere): area and extent under each probe.
    const rest = posedVertices(built.doc, null);
    const restArea = meshArea(built.doc, rest);
    const extent = (points: readonly { x: number; y: number }[], axis: "x" | "y") => Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis]));
    const centroid = (points: readonly { x: number; y: number }[]) => ({ x: points.reduce((t, p) => t + p.x, 0) / points.length, y: points.reduce((t, p) => t + p.y, 0) / points.length });
    // Swell: uniform 1.2 scale, area x1.44.
    expect(meshArea(built.doc, posedVertices(built.doc, pose("swell"))) / restArea).toBeCloseTo(1.44, 3);
    // Squash/stretch: constant area; the bone points up, so its x axis is the canvas vertical.
    const squash = posedVertices(built.doc, pose("wobble squash"));
    expect(meshArea(built.doc, squash) / restArea).toBeCloseTo(1, 3);
    expect(extent(squash, "y") / extent(rest, "y")).toBeCloseTo(1.3, 3);
    expect(extent(squash, "x") / extent(rest, "x")).toBeCloseTo(1 / 1.3, 3);
    const stretch = posedVertices(built.doc, pose("wobble stretch"));
    expect(extent(stretch, "y") / extent(rest, "y")).toBeCloseTo(1 / 1.3, 3);
    // Hop: the whole mesh moves 12 px, shape unchanged.
    const hop = posedVertices(built.doc, pose("hop +"));
    const [c0, c1] = [centroid(rest), centroid(hop)];
    expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeCloseTo(12, 6);
    expect(meshArea(built.doc, hop) / restArea).toBeCloseTo(1, 6);
    expect(poseSkeleton(built.doc, ["body"], pose("hide")).findSlot("fig")?.placeholder).toBeNull();
  });

  it("two-headed boss: two head chains, relative-motion probe, an overlapping tail kept apart", () => {
    const fixture = boss();
    const built = common(fixture);
    // Overlap: the tail's capsule lies over the torso, yet no vertex carries both.
    expect(built.weights.some((w) => "tail" in w && "torso" in w)).toBe(false);
    // Without the overlap connection the same mesh does blend them (the connection is what holds).
    const control = build({ ...fixture, authoring: { ...fixture.authoring, connections: [] } });
    expect(meshWeights(control.raw).some((w) => "tail" in w && "torso" in w)).toBe(true);
  });

  it("rest render matches the reference image (softRender + pixelmatch, <= 0.5% of the figure)", () => {
    const fixture = boss();
    const built = build(fixture);
    const textures = new Map([["body/fig", built.image]]);
    const rendered = softRender(poseSkeleton(built.doc, ["body"], null), textures, { width: W, height: H }).image;
    const mismatched = pixelmatch(built.image.data, rendered.data, undefined, W, H, { threshold: 0.1, includeAA: false });
    let figure = 0;
    for (let i = 3; i < built.image.data.length; i += 4) if ((built.image.data[i] as number) > 0) figure++;
    expect(figure).toBeGreaterThan(1000);
    expect(mismatched / figure).toBeLessThanOrEqual(0.005);
  });

  it("setup pose binds exactly: every skinned vertex lands on its canvas position", () => {
    const built = build(boss());
    const uvs = figMesh(built.doc).uvs;
    const rest = posedVertices(built.doc, null);
    expect(rest.length * 2).toBe(uvs.length);
    rest.forEach((p, v) => {
      expect(p.x, `vertex ${v} x`).toBeCloseTo((uvs[v * 2] as number) * W, 3);
      expect(p.y, `vertex ${v} y`).toBeCloseTo((uvs[v * 2 + 1] as number) * H, 3);
    });
  });
});

describe("authoring validator (item 6)", () => {
  it("rejects unordered chains, unknown references, influences outside a domain and crossed overlaps", () => {
    const fixture: Fixture = {
      name: "pair",
      shapes: [capsule(60, 120, 260, 120, 14)],
      bones: [b("upper", null, at(60, 120), at(160, 120), 14), b("lower", "upper", at(160, 120), at(260, 120), 14)],
      chains: [{ bones: ["upper", "lower"] }],
      authoring: { chains: [{ id: "arm", bones: ["upper", "lower"] }] }
    };
    const built = build(fixture);
    expect(validateAuthoring(built.doc)).toEqual([]);
    const broken = loadAnimDocument({
      ...built.raw,
      authoring: {
        chains: [
          { id: "a", bones: ["upper"] },
          { id: "b", bones: ["lower"], parent: "a" },
          { id: "c", bones: ["lower", "upper"] }
        ],
        domains: [{ id: "d", slot: "fig", bones: ["upper"] }],
        connections: [{ between: ["a", "b"], kind: "overlap" }],
        probes: [{ name: "w", kind: "wave", chain: "a" }]
      }
    });
    const messages = validateAuthoring(broken as AnimDocument).filter((i) => i.severity === "error").map((i) => i.message).join("\n");
    expect(messages).toMatch(/'lower' is in chains 'b' and 'c'/);
    expect(messages).toMatch(/chain 'c' is not ordered/);
    expect(messages).toMatch(/influence\(s\) from 'lower', outside the domain/);
    expect(messages).toMatch(/is overlap, but \d+ vertex\(es\)/);
    expect(messages).toMatch(/travelling wave needs a chain of three/);
  });

  const pair = (): Fixture => ({
    name: "pair",
    shapes: [capsule(60, 120, 260, 120, 14)],
    bones: [b("upper", null, at(60, 120), at(160, 120), 14), b("lower", "upper", at(160, 120), at(260, 120), 14)],
    chains: [{ bones: ["upper", "lower"] }],
    authoring: { chains: [{ id: "arm", bones: ["upper", "lower"] }] }
  });

  it("warns on a deforming bone outside every chain and on an odd symmetry group ()", () => {
    const built = build(pair());
    const warnings = (authoring: unknown, extraBones: unknown[] = []) =>
      validateAuthoring(loadAnimDocument({ ...built.raw, bones: [...(built.raw["bones"] as unknown[]), ...extraBones], authoring }) as AnimDocument)
        .filter((i) => i.severity === "warning")
        .map((i) => i.message)
        .join("\n");
    expect(warnings({ chains: [{ id: "a", bones: ["upper"] }] })).toMatch(/deforming bone\(s\) outside every declared chain.*'lower'/);
    expect(warnings({ chains: [{ id: "arm", bones: ["upper", "lower"] }] })).toBe("");
    const odd = { chains: [{ id: "arm", bones: ["upper", "lower"], symmetry: "s" }, { id: "x", bones: ["x0"], symmetry: "s" }, { id: "y", bones: ["y0"], symmetry: "s" }] };
    expect(warnings(odd, [{ name: "x0", parent: "root" }, { name: "y0", parent: "root" }])).toMatch(/symmetry group 's' has 3 chains \(odd\): 'y' has no twin/);
  });

  it("a partial declaration keeps an undeclared leg posed: fallback chain, rotation probe and a warning ()", () => {
    const built = build({
      name: "body-leg",
      shapes: [capsule(60, 120, 260, 120, 14), capsule(160, 130, 160, 225, 10)],
      bones: [b("body", null, at(60, 120), at(260, 120), 14), b("leg", "body", at(160, 130), at(160, 225), 10)],
      chains: [{ bones: ["body"] }, { bones: ["leg"], parent: "body" }],
      authoring: { chains: [{ id: "torso", bones: ["body"] }] }
    });
    const doc = built.doc as AnimDocument;
    const { chains } = inferRoles(doc);
    expect(chains.some((chain) => chain.fallback === true && chain.members.includes("leg"))).toBe(true);
    expect(chains.filter((chain) => chain.members.includes("body")).map((chain) => chain.id)).toEqual(["torso"]);
    const legPoses = rigPoses(doc).filter((pose) => (pose.rotate["leg"] ?? 0) !== 0);
    expect(legPoses.length).toBeGreaterThan(0);
    expect(legPoses.some((pose) => /^fallback chain leg (max|min)$/.test(pose.name))).toBe(true);
    const warnings = validateAuthoring(doc).filter((i) => i.severity === "warning").map((i) => i.message).join("\n");
    expect(warnings).toMatch(/outside every declared chain.*'leg'/);
  });

  it("rejects a non-positive deform amount at the schema, so squash/stretch stays finite (item 7)", () => {
    const built = build(pair());
    const load = (amount: number) => () => loadAnimDocument({ ...built.raw, authoring: { chains: [{ id: "arm", bones: ["upper", "lower"] }], probes: [{ name: "squash", kind: "deform", chain: "arm", amount }] } });
    expect(load(0)).toThrow();
    expect(load(-1.3)).toThrow();
    expect(load(1.3)).not.toThrow();
  });

  it("rejects gait/phase and mis-shaped probes at the schema (probes are a union by kind)", () => {
    const built = build(pair());
    const load = (authoring: unknown) => () => loadAnimDocument({ ...built.raw, authoring });
    expect(load({ chains: [{ id: "arm", bones: ["upper", "lower"], gait: "walk", phase: 0.5 }] })).toThrow();
    expect(load({ probes: [{ name: "r", kind: "relative", chain: "arm" }] })).toThrow();
    expect(load({ probes: [{ name: "a", kind: "attachment", bones: ["upper"] }] })).toThrow();
    expect(load({ probes: [{ name: "r", kind: "relative", chains: ["arm", "arm"], amount: 10 }] })).not.toThrow();
  });

  // The bus rejects an invalid document before geometry edits; weights.auto keeps its own guard too.
  it("weights.auto fails on an authoring block that does not parse (never ignores it)", () => {
    const built = build(pair());
    const raw = { ...built.raw, authoring: { chains: [{ id: "arm", bones: [] }] } } as unknown as JsonObject;
    expect(() => applyCommands(raw, [{ op: "weights.auto", skin: "body", slot: "fig", name: "fig", bones: ["upper", "lower"] }])).toThrow(/authoring/);
  });

  it("derives the validator's joints from declared joints and welded/overlap connections, not membranes", () => {
    const doc = (connections: unknown, joints?: unknown) =>
      loadAnimDocument({
        format: FORMAT_ID,
        name: "joints",
        canvas: { width: W, height: H, originX: ORIGIN.x, originY: ORIGIN.y },
        bones: [{ name: "root" }, { name: "upper", parent: "root", length: 50 }, { name: "lower", parent: "upper", x: 50, length: 50 }, { name: "tip", parent: "lower", x: 50, length: 20 }],
        slots: [{ name: "upper_s", bone: "upper" }, { name: "lower_s", bone: "lower" }, { name: "tip_s", bone: "tip" }],
        authoring: { chains: [{ id: "a", bones: ["upper"] }, { id: "b", bones: ["lower", "tip"], parent: "a" }], connections, ...(joints ? { joints } : {}) }
      });
    expect(authoringJoints(doc([{ between: ["a", "b"], kind: "welded" }]))).toEqual([{ parent: "upper_s", child: "lower_s" }, { parent: "upper_s", child: "tip_s" }]);
    expect(authoringJoints(doc([{ between: ["a", "b"], kind: "overlap" }]))).toHaveLength(2);
    expect(authoringJoints(doc([{ between: ["a", "b"], kind: "membrane" }]))).toEqual([]);
    const declared = authoringJoints(doc([{ between: ["a", "b"], kind: "welded" }], [{ parent: "lower_s", child: "upper_s", pivotBone: "lower", radius: 8 }]));
    expect(declared).toEqual([{ parent: "lower_s", child: "upper_s", pivotBone: "lower", radius: 8 }, { parent: "upper_s", child: "tip_s" }]);
  });
});
