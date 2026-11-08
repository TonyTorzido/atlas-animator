import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportSpine } from "./exportSpine.js";
import { importSpineClips } from "./importSpine.js";
import { importSpineMeshes } from "./importSpineMeshes.js";

const RIG_DIR = resolve(import.meta.dirname, "../../fixtures/test-rigs/player-kit");
const RIG = "front-turn00-faceA";

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-12a-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Doc = { skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }>; animations: Record<string, unknown> };

function rigWith12a(): string {
  const raw = JSON.parse(readFileSync(join(RIG_DIR, `${RIG}.anim.json`), "utf8")) as Doc;
  const torso = (raw.skins["body"] as Doc["skins"][string]).attachments["torso"] as Record<string, Record<string, unknown>>;
  torso["cut"] = { type: "clipping", vertices: [-5, -5, 5, -5, 5, 8, -5, 8], end: "torso" };
  torso["hit"] = { type: "boundingbox", vertices: [0, 0, 10, 0, 10, 20] };
  (torso["skin"] as Record<string, unknown>)["sequence"] = { count: 3, start: 1, digits: 2, setup: 0 };
  raw.animations["seq"] = { duration: 1, loop: false, slots: { torso: { sequence: [{ time: 0, mode: "pingpong", index: 1, delay: 0.1 }] } } };
  const dir = tempDir();
  const path = join(dir, `${RIG}.anim.json`);
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

describe("Spine export and import of clipping, bounding boxes and sequences", () => {
  const document = rigWith12a();
  const result = exportSpine({ document, outDir: tempDir(), atlas: join(RIG_DIR, `${RIG}.atlas.json`), noAtlas: true });
  const json = JSON.parse(readFileSync(result.json, "utf8")) as {
    skins: { name: string; attachments: Record<string, Record<string, Record<string, unknown>>> }[];
    animations: Record<string, { slots?: Record<string, { sequence?: Record<string, unknown>[] }> }>;
  };
  const torso = json.skins.find((s) => s.name === "default")?.attachments["torso"] ?? {};

  it("writes a clipping and a bounding box with y flipped and the vertex count", () => {
    expect(torso["cut"]).toMatchObject({ type: "clipping", vertexCount: 4, vertices: [-5, 5, 5, 5, 5, -8, -5, -8], end: "torso" });
    expect(torso["hit"]).toMatchObject({ type: "boundingbox", vertexCount: 3, vertices: [0, 0, 10, 0, 10, -20] });
  });

  it("writes the sequence block and the sequence timeline", () => {
    expect(torso["skin"]).toMatchObject({ sequence: { count: 3, start: 1, digits: 2, setup: 0 } });
    expect(json.animations["seq"]?.slots?.["torso"]?.sequence).toEqual([{ time: 0, mode: "pingpong", index: 1, delay: 0.1 }]);
  });

  it("reads them back into a rig that lacks them (and the loss report no longer needs to drop them)", () => {
    const clean = join(tempDir(), `${RIG}.anim.json`);
    const original = JSON.parse(readFileSync(join(RIG_DIR, `${RIG}.anim.json`), "utf8")) as Doc;
    ((original.skins["body"] as Doc["skins"][string]).attachments["torso"] as Record<string, Record<string, unknown>>)["skin"]!["sequence"] = undefined;
    writeFileSync(clean, JSON.stringify(original));
    const imported = importSpineMeshes({ spine: result.json, merge: clean, dryRun: false });
    expect(imported.extras.sort()).toEqual(["boundingbox body/torso/hit", "clipping body/torso/cut", "sequence body/torso/skin"]);
    const merged = JSON.parse(readFileSync(clean, "utf8")) as Doc;
    const att = (merged.skins["body"] as Doc["skins"][string]).attachments["torso"] as Record<string, Record<string, unknown>>;
    expect(att["cut"]).toMatchObject({ type: "clipping", vertices: [-5, -5, 5, -5, 5, 8, -5, 8], end: "torso" });
    expect(att["skin"]).toMatchObject({ sequence: { count: 3, start: 1, digits: 2, setup: 0 } });
    copyFileSync(clean, clean + ".keep");
    const clips = importSpineClips({ spine: result.json, rig: clean, dryRun: false });
    expect(clips.clips.map((c) => c.name)).toContain("seq");
    const after = JSON.parse(readFileSync(clean, "utf8")) as { animations: Record<string, { slots?: Record<string, { sequence?: unknown[] }> }> };
    expect(after.animations["seq"]?.slots?.["torso"]?.sequence).toEqual([{ time: 0, mode: "pingpong", index: 1, delay: 0.1 }]);
  });
});
