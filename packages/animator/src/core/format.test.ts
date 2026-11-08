import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMAT_ID, meshDeformLength, scanWeightedVertices, type MeshAttachmentData } from "./format.js";
import {
  AnimFormatError,
  formatIssuePath,
  loadAnimDocument,
  parseAnimDocument,
  parseAnimDocumentJson,
  type RawDocument
} from "./formatLoader.js";

const fixturesDir = new URL("../../fixtures/", import.meta.url);
const readFixture = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, fixturesDir), "utf8"));

/** Every invalid fixture, the path its first issue must name, and words from the message. */
const INVALID_FIXTURES: Record<string, { path: string; message: string }> = {
  "missing-format": { path: "format", message: "missing or non-string 'format'" },
  "newer-version": { path: "format", message: "newer than this build understands" },
  "parent-after-child": { path: "bones[2].parent", message: "parent 'head' must be listed before 'chest'" },
  "slot-unknown-bone": { path: "slots[1].bone", message: "unknown bone 'spleen'" },
  "bad-color": { path: "slots[7].color", message: "8 hex digits" },
  "triangle-out-of-range": {
    path: "skins.body.attachments.torso.torso.triangles[5]",
    message: "vertex index 9 is out of range (mesh has 4 vertices)"
  },
  "too-many-influences": { path: "skins.body.attachments.torso.torso.vertices[0]", message: "influence count 5" },
  "key-after-duration": { path: "animations.idle.bones.upper_arm_r.rotate[1].time", message: "after the clip duration 2.4" },
  "unsorted-keys": { path: "animations.idle.bones.chest.translate[1].time", message: "strictly increasing time" },
  "ik-not-parent-child": { path: "ik[0].bones[1]", message: "'hand_r' to be a direct child of 'upper_arm_r'" },
  "limits-inverted": { path: "bones[4].limits.min", message: "min must not be greater than max" },
  "unknown-field": { path: "bones[0]", message: "unknown field 'rotate'" },
  "linked-mesh-source-missing": {
    path: "skins.tunic.attachments.torso_cloth.torso_cloth.source",
    message: "source mesh 'body/torso/chest' does not exist"
  },
  "deform-too-long": { path: "animations.idle.deform.body.torso.torso[1].vertices", message: "the mesh deform has 12 floats" },
  "undeclared-event": { path: "animations.idle.events[1].name", message: "event 'boom' is not declared" },
  "skin-bone-parent": { path: "bones[11].skin", message: "must be a skin bone because its parent 'cape_2' is one" },
  "bad-curve": { path: "animations.idle.bones.chest.translate[0].curve[0]", message: "Bezier x control points must be in 0..1" },
  "target-below-constrained": { path: "ik[0].target", message: "target 'hand_r' is below constrained bone 'upper_arm_r'" },
  "constraint-chain-gap": { path: "transform[0].bones[1]", message: "its parent 'forearm_r' must be listed too" }
};

describe("valid fixtures", () => {
  it("loads the minimal rig and fills defaults", () => {
    const doc = loadAnimDocument(readFixture("valid/minimal.anim.json"));
    expect(doc.format).toBe(FORMAT_ID);
    expect(doc.bones).toEqual([
      { name: "root", length: 0, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, inherit: "normal", skin: false }
    ]);
    expect(doc.slots).toEqual([]);
    expect(doc.skins).toEqual({});
    expect(doc.animations).toEqual({});
    expect(doc.drawOrder).toBeUndefined();
  });

  it("loads the humanoid rig that uses every section of the format", () => {
    const result = parseAnimDocument(readFixture("valid/humanoid.anim.json"));
    if (!result.ok) throw new Error(result.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("\n"));
    const doc = result.document;
    expect(result.sourceVersion).toBe(1);
    expect(doc.bones.map((bone) => bone.name)).toContain("cape_2");
    expect(doc.skins["tunic"]?.attachments["torso_cloth"]?.["torso_cloth"]).toMatchObject({ type: "linkedMesh", inheritDeform: true });
    expect(doc.physics[0]).toMatchObject({ fps: 60, limit: 5000, mass: 1, skin: true });
    expect(doc.transform[0]?.offset).toEqual({ rotation: 0, x: 0, y: -40, scaleX: 0, scaleY: 0, shearY: 0 });
    expect(doc.events["hit"]).toEqual({ int: 0, float: 0, string: "", audio: "" });
    expect(doc.animations["idle"]?.bones["chest"]?.translate?.[1]?.curve).toBe("linear");
  });
});

describe("invalid fixtures", () => {
  const files = readdirSync(new URL("invalid/", fixturesDir)).filter((file) => file.endsWith(".anim.json"));

  it("has an expectation for every invalid fixture (and at least 10 of them)", () => {
    expect(files.map((file) => file.replace(".anim.json", "")).sort()).toEqual(Object.keys(INVALID_FIXTURES).sort());
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const [name, expected] of Object.entries(INVALID_FIXTURES)) {
    it(`rejects ${name} naming ${expected.path}`, () => {
      const result = parseAnimDocument(readFixture(`invalid/${name}.anim.json`));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const issues = result.issues.map((issue) => ({
        path: formatIssuePath(issue.path),
        message: issue.message,
        severity: issue.severity
      }));
      expect(issues).toContainEqual({ path: expected.path, message: expect.stringContaining(expected.message), severity: "error" });
    });
  }

  it("throws an AnimFormatError whose message lists the path", () => {
    const raw = readFixture("invalid/slot-unknown-bone.anim.json");
    expect(() => loadAnimDocument(raw, { source: "rig.anim.json" })).toThrowError(AnimFormatError);
    expect(() => loadAnimDocument(raw, { source: "rig.anim.json" })).toThrowError(
      /rig\.anim\.json: invalid atlas-anim document \(1 error\)\n {2}slots\[1\]\.bone: unknown bone 'spleen'/
    );
  });
});

describe("loader severities", () => {
  type Rig = {
    drawOrder: string[];
    slots: { name: string; attachment?: string }[];
    bones: { name: string }[];
    animations: { idle: { slots: { weapon: { attachment: { time: number; name: string | null }[] } } } };
  };
  const humanoid = () => readFixture("valid/humanoid.anim.json") as Rig;
  const unfinished = (): Rig => {
    const rig = humanoid();
    rig.drawOrder.pop(); // 'aura' left out
    const arm = rig.slots[3];
    if (arm) arm.attachment = "arm_r_new"; // placeholder not drawn yet
    const key = rig.animations.idle.slots.weapon.attachment[0];
    if (key) key.name = "axe"; // no skin defines it yet
    return rig;
  };
  const expectedWarnings = [
    { path: "slots[3].attachment", message: expect.stringContaining("no skin defines attachment 'arm_r_new'") },
    { path: "drawOrder", message: expect.stringContaining("slot 'aura' is missing from the draw order") },
    { path: "animations.idle.slots.weapon.attachment[0].name", message: expect.stringContaining("no skin defines attachment 'axe'") }
  ];

  it("loads an unfinished rig and reports its gaps as warnings", () => {
    const result = parseAnimDocument(unfinished());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.every((issue) => issue.severity === "warning")).toBe(true);
    expect(result.warnings.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }))).toEqual(expectedWarnings);
    expect(() => loadAnimDocument(unfinished())).not.toThrow();
  });

  it("warns about unstable physics (strength > fps^2) and rotation channels on a zero-length bone", () => {
    const result = parseAnimDocument({
      format: "atlas-anim@1",
      name: "physics",
      canvas: { width: 10, height: 10, originX: 0, originY: 0 },
      bones: [{ name: "root" }, { name: "tail", parent: "root", length: 20 }, { name: "stub", parent: "root" }],
      physics: [
        { name: "stiff", bone: "tail", rotate: 1, strength: 4000, fps: 60 },
        { name: "ok", bone: "tail", rotate: 1, strength: 3600, fps: 60 },
        { name: "stub", bone: "stub", rotate: 1 },
        { name: "slide", bone: "stub", x: 1 }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((issue) => formatIssuePath(issue.path))).toEqual(["physics[0].strength", "physics[2].bone"]);
    expect(result.warnings[0]?.message).toContain("exceeds fps^2 (3600)");
  });

  it("returns no warnings for a finished rig", () => {
    const result = parseAnimDocument(humanoid());
    expect(result.ok && result.warnings).toEqual([]);
  });

  it("fails on errors and lists warnings after them", () => {
    const rig = unfinished();
    rig.bones.push({ name: "root" }); // duplicate bone name: an error
    const result = parseAnimDocument(rig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.severity)).toEqual(["error", "warning", "warning", "warning"]);
    expect(() => loadAnimDocument(rig)).toThrowError(
      /\(1 error\)\n {2}bones\[11\]\.name: duplicate bone name 'root'\n {2}warning: slots\[3\]\.attachment/
    );
  });

  it("keeps deform keys on an inheriting linked mesh an error", () => {
    const rig = humanoid() as Rig & { animations: { idle: { deform: Record<string, unknown> } } };
    rig.animations.idle.deform["tunic"] = { torso_cloth: { torso_cloth: [{ time: 0, vertices: [1] }] } };
    const result = parseAnimDocument(rig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: ["animations", "idle", "deform", "tunic", "torso_cloth", "torso_cloth"],
        message: expect.stringContaining("key the source mesh instead"),
        severity: "error"
      });
    }
  });
});

describe("loader", () => {
  const minimal = (): RawDocument => readFixture("valid/minimal.anim.json") as RawDocument;

  it("rejects non-objects and broken JSON with a document-level issue", () => {
    for (const raw of [null, 3, "x", [1]]) {
      const result = parseAnimDocument(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.path).toEqual([]);
    }
    const broken = parseAnimDocumentJson("{ nope");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues[0]?.message).toMatch(/^not valid JSON/);
  });

  it("rejects foreign formats", () => {
    const result = parseAnimDocument({ ...minimal(), format: "other-anim@1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual([{ path: ["format"], message: expect.stringContaining('unknown format "other-anim@1"'), severity: "error" }]);
  });

  it("runs the migration table step by step and stamps the new version", () => {
    const old = { ...minimal(), format: "atlas-anim@0", title: "renamed" } as RawDocument;
    delete old["name"];
    const result = parseAnimDocument(old, {
      migrations: {
        0: (doc) => {
          doc["name"] = doc["title"];
          delete doc["title"];
          return doc;
        }
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceVersion).toBe(0);
      expect(result.document.name).toBe("renamed");
      expect(result.document.format).toBe(FORMAT_ID);
    }
    // The caller's object is never modified.
    expect(old["title"]).toBe("renamed");
    expect(old["format"]).toBe("atlas-anim@0");
  });

  it("reports a missing migration step", () => {
    const result = parseAnimDocument({ ...minimal(), format: "atlas-anim@0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toBe("no migration from atlas-anim@0 to atlas-anim@1");
  });

  it("reports missing required fields by path", () => {
    const raw = minimal();
    delete raw["canvas"];
    const result = parseAnimDocument(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual([{ path: ["canvas"], message: "required object is missing", severity: "error" }]);
  });

  it("formats issue paths for any key", () => {
    expect(formatIssuePath([])).toBe("(document)");
    expect(formatIssuePath(["bones", 3, "parent"])).toBe("bones[3].parent");
    expect(formatIssuePath(["skins", "tunic-green", "hides", 0])).toBe('skins["tunic-green"].hides[0]');
  });
});

describe("weighted vertex encoding", () => {
  const mesh = (vertices: number[], bones = ["a", "b"]): Pick<MeshAttachmentData, "uvs" | "vertices" | "bones"> => ({
    uvs: [0, 0, 1, 0, 0, 1],
    vertices,
    bones
  });

  it("counts influences across vertices", () => {
    const vertices = [1, 0, 0, 0, 1, 2, 0, 1, 1, 0.25, 1, 2, 2, 0.75, 1, 1, 5, 5, 1];
    expect(scanWeightedVertices(vertices, 3, 2)).toEqual({ ok: true, influences: 4 });
    expect(meshDeformLength(mesh(vertices))).toBe(8);
  });

  it("uses 2 deform floats per vertex for unweighted meshes", () => {
    const unweighted = { uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1] };
    expect(meshDeformLength(unweighted)).toBe(6);
  });

  it("finds truncated data, bad bone indices, bad weights and leftovers", () => {
    expect(scanWeightedVertices([1, 0, 0, 0, 1], 2, 1)).toMatchObject({ ok: false, at: 5 });
    expect(scanWeightedVertices([1, 2, 0, 0, 1], 1, 2)).toMatchObject({ ok: false, at: 1, message: expect.stringContaining("bone index 2") });
    expect(scanWeightedVertices([1, 0, 0, 0, 1.5], 1, 1)).toMatchObject({ ok: false, at: 4, message: expect.stringContaining("weight 1.5") });
    expect(scanWeightedVertices([1, 0, 0, 0, 1, 9], 1, 1)).toMatchObject({ ok: false, at: 5, message: expect.stringContaining("1 values left over") });
    expect(scanWeightedVertices([0], 1, 1)).toMatchObject({ ok: false, message: expect.stringContaining("influence count 0") });
  });
});
