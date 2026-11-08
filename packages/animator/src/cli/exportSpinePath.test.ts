import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "spine-path-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Raw = {
  bones: Record<string, unknown>[];
  slots: Record<string, unknown>[];
  skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }>;
  animations: Record<string, unknown>;
  path?: Record<string, unknown>[];
};

const VERTICES = [-30, 0, 0, 0, 30, 0, 70, 20, 100, 20, 130, 20];

function rigWithPath(withPath: boolean): string {
  const raw = JSON.parse(readFileSync(join(RIG_DIR, `${RIG}.anim.json`), "utf8")) as Raw;
  const root = String((raw.bones[0] as Record<string, unknown>).name);
  raw.bones.push({ name: "tail_a", parent: root, length: 10 }, { name: "tail_b", parent: "tail_a", x: 10, length: 10 });
  raw.slots.push({ name: "rail", bone: root, attachment: "line" });
  const firstSkin = Object.keys(raw.skins)[0] as string;
  (raw.skins[firstSkin] as Raw["skins"][string]).attachments["rail"] = withPath ? { line: { type: "path", closed: false, constantSpeed: true, vertexCount: 6, vertices: VERTICES } } : {};
  if (withPath) {
    raw.path = [{ name: "tail_follow", bones: ["tail_a", "tail_b"], target: "rail", positionMode: "fixed", spacingMode: "fixed", spacing: 12, rotateMode: "chain", position: 5, mixRotate: 0.5, mixX: 0.75, mixY: 0.75 }];
    raw.animations["pathclip"] = { duration: 1, loop: false, path: { tail_follow: [{ time: 0, position: 0, mixRotate: 1, curve: "stepped" }, { time: 1, position: 80, mixRotate: 0 }] } };
  }
  const path = join(tempDir(), `${RIG}.anim.json`);
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

describe("Spine export and import of path attachments and constraints", () => {
  const document = rigWithPath(true);
  const result = exportSpine({ document, outDir: tempDir(), atlas: join(RIG_DIR, `${RIG}.atlas.json`), noAtlas: true });
  const json = JSON.parse(readFileSync(result.json, "utf8")) as {
    constraints?: Record<string, unknown>[];
    skins: { name: string; attachments: Record<string, Record<string, Record<string, unknown>>> }[];
    animations: Record<string, { path?: Record<string, Record<string, Record<string, unknown>[]>> }>;
  };


  it("writes the path with y flipped, the vertex count and measured lengths", () => {
    const line = json.skins.find((s) => s.name === "default")?.attachments["rail"]?.["line"];
    expect(line).toMatchObject({ type: "path", closed: false, constantSpeed: true, vertexCount: 6, vertices: [-30, 0, 0, 0, 30, 0, 70, -20, 100, -20, 130, -20] });
    expect((line?.["lengths"] as number[]).length).toBe(1);
    expect((line?.["lengths"] as number[])[0]).toBeGreaterThan(100);
  });

  it("writes the constraint in the ordered constraints list with Spine mode names", () => {
    const c = json.constraints?.find((k) => k["name"] === "tail_follow");
    expect(c).toMatchObject({ type: "path", bones: ["tail_a", "tail_b"], slot: "rail", positionMode: "fixed", spacingMode: "fixed", rotateMode: "chain", position: 5, spacing: 12, mixRotate: 0.5, mixX: 0.75 });
  });

  it("writes the position and mix timelines", () => {
    const timeline = json.animations["pathclip"]?.path?.["tail_follow"];
    expect(timeline?.["position"]).toEqual([{ time: 0, value: 0, curve: "stepped" }, { time: 1, value: 80 }]);
    expect(timeline?.["mix"]?.[1]).toMatchObject({ time: 1, mixRotate: 0 });
  });

  it("reads the path, the constraint and its timelines back into a rig without them", () => {
    const clean = rigWithPath(false);
    const imported = importSpineMeshes({ spine: result.json, merge: clean, dryRun: false });
    expect(imported.extras).toEqual(expect.arrayContaining(["path body/rail/line", "path constraint tail_follow"]));
    const merged = JSON.parse(readFileSync(clean, "utf8")) as Raw;
    const firstSkin = Object.keys(merged.skins)[0] as string;
    expect((merged.skins[firstSkin] as Raw["skins"][string]).attachments["rail"]?.["line"]).toMatchObject({ type: "path", vertexCount: 6, vertices: VERTICES });
    expect(merged.path?.[0]).toMatchObject({ name: "tail_follow", target: "rail", rotateMode: "chain", spacingMode: "fixed", positionMode: "fixed", position: 5, spacing: 12, mixRotate: 0.5, mixX: 0.75, mixY: 0.75 });
    const clips = importSpineClips({ spine: result.json, rig: clean, dryRun: false });
    expect(clips.clips.map((c) => c.name)).toContain("pathclip");
    const after = JSON.parse(readFileSync(clean, "utf8")) as { animations: Record<string, { path?: Record<string, { time: number; position: number; mixRotate: number; curve?: unknown }[]> }> };
    expect(after.animations["pathclip"]?.path?.["tail_follow"]).toMatchObject([{ time: 0, position: 0, mixRotate: 1, curve: expect.objectContaining({ position: "stepped", mixRotate: "stepped" }) }, { time: 1, position: 80, mixRotate: 0 }]);
  });
});
