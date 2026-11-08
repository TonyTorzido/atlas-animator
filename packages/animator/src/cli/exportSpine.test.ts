import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import type { MeshAttachment } from "../core/attachments.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { exportSpine, deformPairMap, spineDeformKeys } from "./exportSpine.js";

const RIG_DIR = resolve(import.meta.dirname, "../../fixtures/test-rigs/player-kit");
const RIGS = ["front-turn00-faceA", "front-turn15-faceA"];

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-export-test-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("spineDeformKeys", () => {
  // Skeleton order: root 0, upper 1, lower 2. The mesh's own table lists lower first, so its stream order is NOT ascending.
  const bones = new Map([["root", 0], ["upper", 1], ["lower", 2]]);
  const mesh = {
    uvs: [0, 0, 1, 0, 1, 1],
    bones: ["lower", "upper"],
    // v0: one influence (upper); v1: two influences, lower then upper; v2: one influence (lower)
    vertices: [1, 1, 0, 0, 1, 2, 0, 0, 0, 0.5, 1, 5, 0, 0.5, 1, 0, 0, 0, 1],
  };

  it("sorts each vertex's influence pairs into ascending bone order", () => {
    // Stream pairs: 0 = v0/upper, 1 = v1/lower, 2 = v1/upper, 3 = v2/lower. Exported v1 is (upper, lower).
    expect(deformPairMap(mesh, bones)).toEqual([0, 2, 1, 3]);
  });

  it("expands sparse offsets, reorders the pairs, negates y and trims", () => {
    // Sparse key: starts at float 2 (pair 1 = v1/lower) with (3, 4) then (5, 6) (pair 2 = v1/upper).
    const keys = spineDeformKeys(mesh, [{ time: 0.5, offset: 2, vertices: [3, 4, 5, 6] }], bones);
    // Full stream: [0,0, 3,4, 5,6, 0,0] -> exported order pairs [0, 2, 1, 3] = [0,0, 5,6, 3,4, 0,0] -> y negated -> trim.
    expect(keys).toEqual([{ time: 0.5, offset: 2, vertices: [5, -6, 3, -4] }]);
  });

  it("an all-zero key is a bare time key, and keys carry converted curves", () => {
    const keys = spineDeformKeys(
      mesh,
      [
        { time: 0, offset: 0, vertices: [], curve: [0.25, 0, 0.75, 1] },
        { time: 2, offset: 6, vertices: [1, 2] },
        { time: 4, offset: 0, vertices: [0, 0] }
      ],
      bones
    );
    expect(keys[0]).toEqual({ time: 0, curve: [0.5, 0, 1.5, 1] });
    expect(keys[1]).toEqual({ time: 2, offset: 6, vertices: [1, -2] });
    expect(keys[2]).toEqual({ time: 4 });
  });

  it("an unweighted mesh keeps its order and only flips y", () => {
    const flat = { uvs: [0, 0, 1, 0], vertices: [0, 0, 1, 1] };
    expect(spineDeformKeys(flat, [{ time: 0, offset: 0, vertices: [1, 2, 3, 4] }], bones)).toEqual([{ time: 0, vertices: [1, -2, 3, -4] }]);
  });
});


describe.each(RIGS)("Spine export of %s", (rig) => {
  const documentPath = join(RIG_DIR, `${rig}.anim.json`);
  const mesh = { skin: "body", slot: "torso", attachment: "skin" };

  function withDeformClip(): string {
    const raw = JSON.parse(readFileSync(documentPath, "utf8")) as Record<string, unknown> & { animations: Record<string, unknown> };
    // Deterministic pseudo-random deform: sparse start key, full end key with an ease.
    let state = 7;
    const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 12;
    const full = Array.from({ length: 200 }, next);
    raw.animations["deformtest"] = {
      duration: 1,
      bones: { pelvis: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 25 }] } },
      deform: {
        [mesh.skin]: {
          [mesh.slot]: {
            [mesh.attachment]: [
              { time: 0, offset: 31, vertices: Array.from({ length: 24 }, next) },
              { time: 0.6, offset: 0, vertices: full, curve: [0.3, 0.1, 0.7, 0.9] },
              { time: 1, offset: 100, vertices: Array.from({ length: 40 }, next) }
            ]
          }
        }
      }
    };
    const dir = tempDir();
    const path = join(dir, `${rig}.anim.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }



  it("exports the rig itself and the output still loads", () => {
    const outDir = tempDir();
    mkdirSync(outDir, { recursive: true });
    const result = exportSpine({ document: documentPath, outDir, atlas: join(RIG_DIR, `${rig}.atlas.json`), noAtlas: true });
    expect((JSON.parse(readFileSync(result.json, "utf8")) as { bones: unknown[] }).bones.length).toBeGreaterThan(0);
  });
});

describe("Spine export of linked meshes", () => {
  const rig = RIGS[0] as string;
  function linkedRig(): string {
    const raw = JSON.parse(readFileSync(join(RIG_DIR, `${rig}.anim.json`), "utf8")) as { skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }> };
    const torso = raw.skins["body"]!.attachments["torso"]!;
    const parent = torso["skin"] as { path: string; width: number; height: number };
    const source = { skin: "body", slot: "torso", attachment: "skin" };
    const link = (extra: object) => ({ type: "linkedMesh", path: parent.path, source, width: parent.width, height: parent.height, ...extra });
    torso["shared"] = link({});
    torso["own"] = link({ inheritDeform: false });
    raw.skins["body"]!.attachments["tank"]!["cross"] = link({});
    const path = join(tempDir(), `${rig}.anim.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  }
  type Out = { skins: { name: string; attachments: Record<string, Record<string, Record<string, unknown>>> }[] };


  it("4.2 writes parent and refuses a cross-slot link", () => {
    const result = exportSpine({ document: linkedRig(), outDir: tempDir(), atlas: join(RIG_DIR, `${rig}.atlas.json`), noAtlas: true, spineVersion: "4.2.43" });
    const json = JSON.parse(readFileSync(result.json, "utf8")) as Out;
    const attachments = json.skins[0]!.attachments;
    expect(attachments["torso"]!["shared"]).toMatchObject({ type: "linkedmesh", parent: "skin", skin: "default" });
    expect(attachments["torso"]!["shared"]).not.toHaveProperty("source");
    expect(attachments["tank"]).not.toHaveProperty("cross");
    expect(result.warnings.some((w) => /tank\/cross.*share the parent's slot/.test(w))).toBe(true);
  });
});
