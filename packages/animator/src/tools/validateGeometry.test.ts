import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { geometryGates } from "./surface/gates.js";
import type { SurfaceRig } from "./surface/output.js";
import { canonicalRig } from "./surface/testRigs.js";
import { loadPreset } from "./surface/preset.js";
import { validationCompanion } from "./surface/validationCompanion.js";
import { mergeNearCoincident } from "./surface/featureMerge.js";
import { validateRig } from "./validate.js";
import { failing, findingKey, rigHash, singularValues, type GeometryFinding } from "./validateGeometry.js";

// Rig builds solve every corrective target: several seconds per preset; the gates run every sweep.
vi.setConfig({ testTimeout: 400_000, hookTimeout: 400_000 });

/*
 * Plan, unified validator: `animator validate` and the surface gates run the same geometry
 * evaluator on the same poses through the final runtime and emit the same finding IDs, on both
 * presets (a humanoid shoulder and a creature hip, data only), and both fail a deliberately wrong rig.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Shared across the surface test files (one build per process, see surface/testRigs.ts).
const rigOf = (name: string): SurfaceRig => canonicalRig(name);

/** Both paths on one rig: finding keys (ID@pose) over the companion poses. */
function bothPaths(rig: SurfaceRig): { gates: GeometryFinding[]; validate: GeometryFinding[]; stale: boolean } {
  const companion = validationCompanion(rig);
  const poses = new Set(companion.poses.map((p) => p.name));
  const gates = geometryGates(rig).distortion.findings;
  const report = validateRig(rig.raw, { companion, samples: 2 });
  return {
    gates,
    validate: report.geometry.findings.filter((f) => poses.has(f.pose)),
    stale: report.issues.some((issue) => issue.check === "geometry" && issue.message.includes("stale"))
  };
}

/**
 * A wrong rig (bad weights): on every fifth skin vertex with two influences, the weights are swapped
 * (bind position unchanged, the vertex follows the wrong bone), so the skin tears in motion.
 */
function wrongWeights(rig: SurfaceRig): SurfaceRig {
  const raw = structuredClone(rig.raw) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const built = rig.built;
  const mesh = Object.values(raw.skins as Record<string, any>).map((skin) => skin.attachments?.[built.skin.slot]?.[built.skin.attachment]).find(Boolean); // eslint-disable-line @typescript-eslint/no-explicit-any
  const v = mesh.vertices as number[];
  let pairs = 0;
  for (let i = 0; i < v.length; i += 1 + (v[i] as number) * 4) {
    if (v[i] !== 2 || Math.abs((v[i + 4] as number) - (v[i + 8] as number)) < 0.5 || pairs++ % 5) continue;
    [v[i + 4], v[i + 8]] = [v[i + 8] as number, v[i + 4] as number];
  }
  expect(pairs).toBeGreaterThan(0);
  return { ...rig, raw, document: loadAnimDocument(raw) };
}

describe("geometry evaluator", () => {
  it("separates directional distortion from area: 10x by 0.1x has det 1 but principal stretches 10 and 0.1", () => {
    const [s1, s2] = singularValues(10, 0, 0, 0.1);
    expect(s1 * s2).toBeCloseTo(1, 9);
    expect(s1).toBeCloseTo(10, 9);
    expect(s2).toBeCloseTo(0.1, 9);
    const [r1, r2] = singularValues(Math.cos(1) * 3, -Math.sin(1) * 0.5, Math.sin(1) * 3, Math.cos(1) * 0.5);
    expect(r1).toBeCloseTo(3, 9);
    expect(r2).toBeCloseTo(0.5, 9);
  });

  it("merges near-coincident outline features onto skin vertices (no blanket angle floor)", () => {
    const outline: [number, number][] = [[0, 0], [10, 0.2], [10, 10], [0, 10]];
    const mesh: [number, number][] = [[10, 0], [5, 0.05], [5, 5]];
    const merged = mergeNearCoincident(outline, mesh, 0.3);
    // The corner snaps onto the skin vertex, the skin vertex 0.05 px off the bottom edge joins it.
    expect(merged).toEqual([[0, 0], [5, 0.05], [10, 0], [10, 10], [0, 10]]);
    expect(mergeNearCoincident(outline, mesh, 0)).toEqual(outline);
  });
});

// The worker answers vitest RPC only between synchronous blocks (a block over 60 s is an unhandled
// "Timeout calling onTaskUpdate"): build the rig in its own block, then yield to the event loop.
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

describe.each(["template7-shoulder", "creature-leg"])("unified validator: %s", (name) => {
  beforeAll(async () => {
    rigOf(name);
    await yieldToEventLoop();
  }, 300_000);

  it("both validators emit the same finding IDs on the same poses (companion hash-checked)", async () => {
    await yieldToEventLoop();
    const rig = rigOf(name);
    const { gates, validate, stale } = bothPaths(rig);
    expect(stale).toBe(false);
    expect(validate.map(findingKey).sort()).toEqual(gates.map(findingKey).sort());
    expect(validate.length).toBe(new Set(validate.map(findingKey)).size);
  });

  it("a deliberately wrong rig (bad weights) fails both, with the same findings", () => {
    const bad = wrongWeights(rigOf(name));
    const { gates, validate } = bothPaths(bad);
    expect(failing(gates).length).toBeGreaterThan(0);
    expect(failing(validate).map(findingKey).sort()).toEqual(failing(gates).map(findingKey).sort());
  });

  it("a stale companion is an error", () => {
    const rig = rigOf(name);
    const companion = { ...validationCompanion(rig), rigHash: rigHash({ other: true }) };
    const report = validateRig(rig.raw, { companion, samples: 0, poses: [] });
    expect(report.issues.some((issue) => issue.severity === "error" && issue.message.includes("stale"))).toBe(true);
  });
});

describe("rigHash normalizes", () => {
  it("a raw document and its loaded form hash alike", async () => {
    const { readFileSync } = await import("node:fs");
    const { loadAnimDocument } = await import("../core/formatLoader.js");
    const { rigHash } = await import("./validateGeometry.js");
    const raw = JSON.parse(readFileSync(new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url), "utf8"));
    expect(rigHash(raw)).toBe(rigHash(loadAnimDocument(raw)));
    // Key order does not matter either.
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    expect(rigHash(reordered)).toBe(rigHash(raw));
  });
});
