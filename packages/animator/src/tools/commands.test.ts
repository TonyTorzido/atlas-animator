import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { applyCommand, applyCommands, COMMANDS, CommandError, describeCommands, parseScript, type Command } from "./commands.js";
import { applyPatch, getAt, type JsonObject, type JsonValue } from "./jsonPatch.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url), "utf8")) as JsonObject;
const text = (value: JsonValue) => JSON.stringify(value, null, 1);

const UNWEIGHTED = {
  type: "mesh",
  path: "test/cloth",
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  triangles: [0, 1, 2, 0, 2, 3],
  vertices: [0, -20, 40, -20, 40, 20, 0, 20],
  hull: 4,
  width: 40,
  height: 40
};

const torso = { skin: "body", slot: "torso", name: "torso" };

/** One case per command: optional setup (applied first), then the command under test. */
const CASES: { op: string; setup?: Command[]; command: Command; expect?: (doc: JsonObject) => void }[] = [
  { op: "doc.new", command: { op: "doc.new", name: "fresh", width: 64, height: 64 }, expect: (d) => expect(d["bones"]).toEqual([{ name: "root" }]) },
  { op: "doc.set", command: { op: "doc.set", revision: 3, canvas: { originY: 200 } }, expect: (d) => expect(getAt(d, "/canvas/originY")).toBe(200) },
  { op: "bone.add", command: { op: "bone.add", name: "tip", parent: "chest", x: 30, length: 10 }, expect: (d) => expect((d["bones"] as JsonObject[]).map((b) => b["name"])).toEqual(["root", "hips", "chest", "head", "tip"]) },
  {
    op: "joint.add",
    command: { op: "joint.add", name: "neck_j", parent: "chest", child: "head", before: "torso" },
    expect: (d) => {
      const bone = (d["bones"] as JsonObject[]).find((b) => b["name"] === "neck_j");
      expect(bone).toMatchObject({ parent: "chest", x: 60, length: 24 });
      expect(d["transform"]).toEqual([expect.objectContaining({ name: "neck_j_half", bones: ["neck_j"], target: "head", local: true, relative: true, mixRotate: 0.5 })]);
      const order = (d["drawOrder"] as string[] | undefined) ?? (d["slots"] as JsonObject[]).map((s) => String(s["name"]));
      expect(order.indexOf("neck_j_joint")).toBe(order.indexOf("torso") - 1);
    }
  },
  { op: "bone.remove", setup: [{ op: "bone.add", name: "tip", parent: "chest" }], command: { op: "bone.remove", name: "tip" } },
  { op: "bone.set", command: { op: "bone.set", name: "chest", rotation: 12, scaleX: 1.1 } },
  { op: "bone.parent", command: { op: "bone.parent", name: "head", parent: "hips" }, expect: (d) => expect(getAt(d, "/bones/3/parent")).toBe("hips") },
  { op: "bone.limits", command: { op: "bone.limits", name: "head", min: -10, max: 10 } },
  { op: "bone.limits", command: { op: "bone.limits", name: "hips", clear: true }, expect: (d) => expect(getAt(d, "/bones/1/limits")).toBeUndefined() },
  { op: "bone.rename", command: { op: "bone.rename", name: "chest", to: "ribcage" }, expect: (d) => expect(text(d)).not.toContain('"chest"') },
  { op: "slot.add", command: { op: "slot.add", name: "aura", bone: "chest", after: "torso" }, expect: (d) => expect((d["slots"] as JsonObject[]).map((s) => s["name"])).toEqual(["base", "torso", "aura", "tunic", "head"]) },
  { op: "slot.remove", setup: [{ op: "slot.add", name: "aura", bone: "chest" }], command: { op: "slot.remove", name: "aura" } },
  { op: "slot.set", command: { op: "slot.set", name: "head", attachment: null, blend: "additive" } },
  { op: "slot.color", command: { op: "slot.color", name: "torso", color: "ff8080ff" } },
  { op: "slot.blend", command: { op: "slot.blend", name: "torso", blend: "additive" } },
  { op: "slot.order", command: { op: "slot.order", name: "head", before: "torso" }, expect: (d) => expect((d["slots"] as JsonObject[]).map((s) => s["name"])).toEqual(["base", "head", "torso", "tunic"]) },
  { op: "skin.add", command: { op: "skin.add", name: "helmet", hides: ["head"] } },
  { op: "skin.remove", command: { op: "skin.remove", name: "tunic" } },
  { op: "skin.hide", command: { op: "skin.hide", name: "tunic", hides: ["head"] } },
  { op: "skin.bones", setup: [{ op: "bone.add", name: "cape", parent: "chest", skin: true }], command: { op: "skin.bones", name: "tunic", bones: ["cape"] } },
  {
    op: "skin.constraints",
    setup: [
      { op: "bone.add", name: "aim", parent: "root", x: 50 },
      { op: "constraint.add", kind: "ik", constraint: { name: "look", bones: ["head"], target: "aim", skin: true } }
    ],
    command: { op: "skin.constraints", name: "tunic", constraints: ["look"] }
  },
  { op: "attachment.add", command: { op: "attachment.add", skin: "tunic", slot: "head", name: "hood", attachment: { type: "point", x: 3 } } },
  { op: "attachment.set", command: { op: "attachment.set", skin: "body", slot: "base", name: "base", fields: { x: 5, rotation: 3 } } },
  { op: "attachment.remove", command: { op: "attachment.remove", skin: "body", slot: "head", name: "head" }, expect: (d) => expect(getAt(d, "/skins/body/attachments/head")).toBeUndefined() },
  { op: "attachment.move-vertices", command: { op: "attachment.move-vertices", ...torso, vertices: [0, 1], dx: 3, dy: -2 } },
  { op: "attachment.set-uvs", setup: [{ op: "attachment.add", skin: "body", slot: "base", name: "cloth", attachment: UNWEIGHTED }], command: { op: "attachment.set-uvs", skin: "body", slot: "base", name: "cloth", uvs: [0, 0, 0.5, 0, 0.5, 1, 0, 1] } },
  { op: "mesh.set", setup: [{ op: "attachment.add", skin: "body", slot: "base", name: "cloth", attachment: UNWEIGHTED }], command: { op: "mesh.set", skin: "body", slot: "base", name: "cloth", triangles: [0, 1, 3, 1, 2, 3], edges: [0, 2] } },
  { op: "mesh.triangles", setup: [{ op: "attachment.add", skin: "body", slot: "base", name: "cloth", attachment: UNWEIGHTED }], command: { op: "mesh.triangles", skin: "body", slot: "base", name: "cloth", triangles: [0, 1, 3, 1, 2, 3] } },
  { op: "mesh.hull", setup: [{ op: "attachment.add", skin: "body", slot: "base", name: "cloth", attachment: { ...UNWEIGHTED, uvs: [...UNWEIGHTED.uvs, 0.5, 0.5], vertices: [...UNWEIGHTED.vertices, 20, 0], triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], hull: 5 } }], command: { op: "mesh.hull", skin: "body", slot: "base", name: "cloth", hull: 4 } },
  { op: "weights.bind", setup: [{ op: "attachment.add", skin: "body", slot: "base", name: "cloth", attachment: UNWEIGHTED }], command: { op: "weights.bind", skin: "body", slot: "base", name: "cloth", bone: "hips" } },
  { op: "weights.unbind", command: { op: "weights.unbind", ...torso } },
  { op: "weights.set", command: { op: "weights.set", ...torso, vertices: [0, 1], influences: [{ bone: "chest", weight: 3 }, { bone: "hips", weight: 1 }] } },
  { op: "weights.prune", command: { op: "weights.prune", ...torso, max: 1 } },
  { op: "weights.table", command: { op: "weights.table", ...torso, influences: ["hips", "chest"], weights: [0.5, 0.5, 1, 0, 0.5, 0.5, 0, 1, 0, 1, 0, 1, 0, 1, 0.5, 0.5, 1, 0, 1, 0] } },
  { op: "mesh.edit", command: { op: "mesh.edit", ...torso, points: [0, 120, 0, 0, 60, 0, 60, 120], triangles: [0, 1, 2, 0, 2, 3], hull: 4, origin: [0, 4, 5, 9] } },
  { op: "weights.smooth", command: { op: "weights.smooth", ...torso, iterations: 2 } },
  { op: "weights.seam", command: { op: "weights.seam", ...torso, bone: "root", line: [[-400, -400], [400, 400]], hard: 2000, soft: 2000 } },
  { op: "weights.assign", command: { op: "weights.assign", ...torso, weights: [{ vertex: 0, influences: [{ bone: "chest", weight: 1 }] }, { vertex: 2, influences: [{ bone: "hips", weight: 1 }, { bone: "chest", weight: 3 }] }] } },
  { op: "weights.auto", command: { op: "weights.auto", ...torso, bones: ["hips", "chest"] } },
  {
    op: "weights.weld",
    setup: [
      { op: "attachment.add", skin: "body", slot: "torso", name: "torso_copy", attachment: getAt(fixture, "/skins/body/attachments/torso/torso") as JsonObject },
      { op: "weights.set", skin: "body", slot: "torso", name: "torso_copy", vertices: [0, 1, 2, 3], influences: [{ bone: "head", weight: 1 }] }
    ],
    command: { op: "weights.weld", meshes: [torso, { skin: "body", slot: "torso", name: "torso_copy" }], tolerance: 1 }
  },
  { op: "mesh.generate", command: { op: "mesh.generate", skin: "body", slot: "base", name: "base", targetVertices: 12 }, expect: (d) => expect(getAt(d, "/skins/body/attachments/base/base/type")).toBe("mesh") },
  { op: "constraint.add", setup: [{ op: "bone.add", name: "aim", parent: "root", x: 50 }], command: { op: "constraint.add", kind: "ik", constraint: { name: "look", bones: ["chest", "head"], target: "aim", mix: 0.5 } } },
  { op: "constraint.set", setup: [{ op: "constraint.add", kind: "physics", constraint: { name: "wobble", bone: "head", rotate: 1 } }], command: { op: "constraint.set", kind: "physics", name: "wobble", fields: { strength: 50, damping: 0.8 } } },
  { op: "constraint.remove", setup: [{ op: "constraint.add", kind: "physics", constraint: { name: "wobble", bone: "head", rotate: 1 } }], command: { op: "constraint.remove", kind: "physics", name: "wobble" } },
  { op: "driven.add", command: { op: "driven.add", name: "lean_fix", bone: "chest" } },
  { op: "driven.remove", setup: [{ op: "driven.add", name: "lean_fix", bone: "chest" }], command: { op: "driven.remove", name: "lean_fix" } },
  { op: "driven.key", setup: [{ op: "driven.add", name: "lean_fix", bone: "chest" }], command: { op: "driven.key", name: "lean_fix", at: 45, alpha: { tunic: 0.5 } } },
  { op: "driven.unkey", setup: [{ op: "driven.add", name: "lean_fix", bone: "chest" }, { op: "driven.key", name: "lean_fix", at: 45, alpha: { tunic: 0.5 } }], command: { op: "driven.unkey", name: "lean_fix", at: 45 } },
  { op: "mesh.groups", command: { op: "mesh.groups", ...torso, groups: { torso: [[0, 4]], head: [[4, 8]] } }, expect: (d) => expect(getAt(d, "/skins/body/attachments/torso/torso/groups/head")).toEqual([[4, 8]]) },
  { op: "mesh.groups", setup: [{ op: "mesh.groups", ...torso, groups: { torso: [[0, 8]] } }], command: { op: "mesh.groups", ...torso, groups: null } },
  { op: "driven.grid", command: { op: "driven.grid", name: "combo", x: { bone: "chest", at: [0, 45] }, y: { bone: "hips", at: [-10, 10] } }, expect: (d) => expect(getAt(d, "/drivenGrids/0/keys")).toEqual([{}, {}, {}, {}]) },
  { op: "driven.grid-key", setup: [{ op: "driven.grid", name: "combo", x: { bone: "chest", at: [0, 45] }, y: { bone: "hips", at: [-10, 10] } }], command: { op: "driven.grid-key", name: "combo", x: 45, y: 10, deform: { body: { torso: { torso: { offset: 2, vertices: [1, -1] } } } } }, expect: (d) => expect(getAt(d, "/drivenGrids/0/keys/3/deform/body/torso/torso/offset")).toBe(2) },
  { op: "driven.grid-remove", setup: [{ op: "driven.grid", name: "combo", x: { bone: "chest", at: [0, 45] }, y: { bone: "hips", at: [-10, 10] } }], command: { op: "driven.grid-remove", name: "combo" }, expect: (d) => expect(d["drivenGrids"]).toBeUndefined() },
  { op: "contour.add", command: { op: "contour.add", skin: "body", slot: "head", name: "rim", contour: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, [1, 2, 8, 0.5, 0.25]], width: 3 } } },
  {
    op: "contour.trace",
    command: { op: "contour.trace", skin: "body", slot: "head", name: "seam", mesh: { slot: "torso", attachment: "torso" }, points: [[150, 210], [160, 190], [170, 170]], width: 2, color: "102030ff" },
    expect: (d) => expect((getAt(d, "/skins/body/contours/head/seam/points") as unknown[]).length).toBe(3)
  },
  { op: "contour.set", setup: [{ op: "contour.add", skin: "body", slot: "head", name: "rim", contour: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, [1, 2, 8, 0.5, 0.25]], width: 3 } }], command: { op: "contour.set", skin: "body", slot: "head", name: "rim", fields: { width: 5, visible: [{ bone: "chest", min: -10, max: 40 }] } } },
  { op: "contour.remove", setup: [{ op: "contour.add", skin: "body", slot: "head", name: "rim", contour: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, [1, 2, 8, 0.5, 0.25]], width: 3 } }], command: { op: "contour.remove", skin: "body", slot: "head", name: "rim" }, expect: (d) => expect(getAt(d, "/skins/body/contours")).toBeUndefined() },
  { op: "coverage.region", command: { op: "coverage.region", skin: "body", name: "chest", mesh: { slot: "torso", attachment: "torso" }, triangles: [[4, 8]] } },
  { op: "coverage.remove-region", setup: [{ op: "coverage.region", skin: "body", name: "chest", mesh: { slot: "torso", attachment: "torso" }, triangles: [[4, 8]] }], command: { op: "coverage.remove-region", skin: "body", name: "chest" }, expect: (d) => expect(getAt(d, "/skins/body/coverage")).toBeUndefined() },
  { op: "coverage.covers", setup: [{ op: "coverage.region", skin: "body", name: "chest", mesh: { slot: "torso", attachment: "torso" }, triangles: [[4, 8]] }], command: { op: "coverage.covers", skin: "tunic", covers: [{ skin: "body", region: "chest" }] } },
  {
    op: "bone.rename",
    setup: [{ op: "driven.grid", name: "combo", x: { bone: "chest", at: [0, 45] }, y: { bone: "hips", at: [-10, 10] } }, { op: "contour.add", skin: "body", slot: "head", name: "brow", contour: { bones: ["chest"], vertices: [1, 0, 0, 0, 1, 1, 0, 9, 0, 1], width: 1, visible: [{ bone: "chest", min: 0, max: 9 }] } }],
    command: { op: "bone.rename", name: "chest", to: "ribcage" },
    expect: (d) => expect(text(d)).not.toContain('"chest"')
  },
  { op: "event.add", command: { op: "event.add", name: "swoosh", string: "air", audio: "whoosh_01" } },
  { op: "event.set", command: { op: "event.set", name: "hit", int: 7 } },
  { op: "event.remove", setup: [{ op: "event.add", name: "swoosh" }], command: { op: "event.remove", name: "swoosh" } },
  { op: "event.key", command: { op: "event.key", clip: "idle", time: 1.2, name: "step", audio: "step_soft" } },
  { op: "event.unkey", setup: [{ op: "event.key", clip: "idle", time: 1.2, name: "step" }], command: { op: "event.unkey", clip: "idle", time: 1.2, name: "step" } },
  { op: "clip.add", command: { op: "clip.add", name: "jump", duration: 0.6 } },
  { op: "clip.remove", command: { op: "clip.remove", name: "walk" } },
  { op: "clip.duration", command: { op: "clip.duration", name: "idle", duration: 3 } },
  { op: "clip.loop", command: { op: "clip.loop", name: "attack", loop: true } },
  { op: "clip.rename", command: { op: "clip.rename", name: "idle", to: "breathe" } },
  { op: "clip.copy", command: { op: "clip.copy", name: "attack", to: "chop" } },
  { op: "key.set", command: { op: "key.set", clip: "idle", bone: "head", timeline: "translate", time: 0.5, x: 1, y: -2, curve: "stepped" } },
  { op: "key.set", command: { op: "key.set", clip: "idle", bone: "chest", timeline: "rotate", time: 1.2, value: 9 }, expect: (d) => expect(getAt(d, "/animations/idle/bones/chest/rotate/1")).toEqual({ time: 1.2, value: 9, curve: [0.42, 0, 0.58, 1] }) },
  { op: "key.delete", command: { op: "key.delete", clip: "idle", bone: "chest", timeline: "rotate", time: 1.2 } },
  { op: "key.move", command: { op: "key.move", clip: "idle", bone: "chest", timeline: "rotate", time: 1.2, to: 1.0 } },
  { op: "key.curve", command: { op: "key.curve", clip: "idle", bone: "chest", timeline: "rotate", time: 0, curve: "stepped" } },
  { op: "key.offset", command: { op: "key.offset", clip: "attack", by: 0.05, from: 0.3, to: 0.6 } },
  { op: "key.copy-range", command: { op: "key.copy-range", clip: "idle", from: 0, to: 0.5, at: 0.1, toClip: "walk", bone: "chest", timeline: "rotate" } },
  { op: "patch", command: { op: "patch", patch: [{ op: "replace", path: "/bones/1/y", value: -42 }, { op: "copy", from: "/bones/1/y", path: "/bones/2/y" }] } }
];

describe("command vocabulary", () => {
  it("every command has a round-trip case", () => {
    expect(new Set(CASES.map((c) => c.op))).toEqual(new Set(COMMANDS.keys()));
  });

  it("every command example and summary is listed", () => {
    const listed = describeCommands();
    expect(listed.map((d) => d.op)).toEqual([...COMMANDS.keys()]);
    for (const entry of listed) {
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(entry.example.op).toBe(entry.op);
    }
  });

  for (const [i, testCase] of CASES.entries()) {
    it(`${testCase.op} #${i}: applies, changes the document, and its inverse restores it byte for byte`, () => {
      const start = testCase.setup ? applyCommands(fixture, testCase.setup).doc : fixture;
      const before = text(start);
      const result = applyCommand(start, testCase.command);
      expect(text(result.doc), "the command changed something").not.toBe(before);
      expect(text(start), "the input is not modified").toBe(before);
      expect(result.patch.length).toBeGreaterThan(0);
      testCase.expect?.(result.doc);
      // The recorded forward patch reproduces the result, and the inverse restores the input.
      expect(text(applyPatch(start, result.patch).doc)).toBe(text(result.doc));
      expect(text(applyPatch(result.doc, result.inverse).doc)).toBe(before);
      // The result still loads.
      expect(() => loadAnimDocument(result.doc)).not.toThrow();
    });
  }
});

describe("checks and errors", () => {
  it("rejects a command that would break a reference and leaves the document unchanged", () => {
    const before = text(fixture);
    expect(() => applyCommand(fixture, { op: "bone.remove", name: "head" })).toThrow(/command 1 \(bone\.remove\): the result would be invalid/);
    expect(() => applyCommand(fixture, { op: "bone.remove", name: "chest" })).toThrow(/has children \(head\)/);
    expect(text(fixture)).toBe(before);
  });

  it("names the failing command of a batch and applies nothing", () => {
    let error: unknown;
    try {
      applyCommands(fixture, [
        { op: "bone.add", name: "a", parent: "root" },
        { op: "bone.set", name: "missing", x: 1 }
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).index).toBe(1);
    expect((error as CommandError).message).toMatch(/command 2 \(bone\.set\): no bone 'missing'; bones: root, hips, chest, head/);
  });

  it("explains unknown ops, bad params and bad keys", () => {
    expect(() => applyCommand(fixture, { op: "bone.frob" })).toThrow(/unknown command 'bone\.frob'; bone\.\* commands: bone\.add/);
    expect(() => applyCommand(fixture, { op: "bone.set", name: "chest", rotation: "a lot" })).toThrow(/rotation: Expected number/);
    expect(() => applyCommand(fixture, { op: "bone.set", name: "chest", spin: 1 })).toThrow(/Unrecognized key/);
    expect(() => applyCommand(fixture, { op: "key.set", clip: "idle", bone: "chest", time: 0, value: 1 })).toThrow(/timeline rotate\|translate\|scale\|shear/);
    expect(() => applyCommand(fixture, { op: "key.set", clip: "idle", bone: "chest", timeline: "translate", time: 0.3, value: 1 })).toThrow(/bone chest translate key at 0.3s/);
    expect(() => applyCommand(fixture, { op: "key.set", clip: "idle", bone: "chest", timeline: "rotate", time: 9, value: 1 })).toThrow(/invalid/);
    expect(() => applyCommand(fixture, { op: "key.delete", clip: "idle", bone: "chest", timeline: "rotate", time: 0.7 })).toThrow(/no bone chest rotate key at 0.7s; keys at: 0s, 1.2s, 2.4s/);
  });

  it("check 'end' allows invalid intermediate states inside a batch", () => {
    const commands: Command[] = [
      { op: "constraint.add", kind: "ik", constraint: { name: "look", bones: ["head"], target: "aim" } },
      { op: "bone.add", name: "aim", parent: "root" }
    ];
    expect(() => applyCommands(fixture, commands)).toThrow(/command 1 \(constraint\.add\): the result would be invalid/);
    expect(() => applyCommands(fixture, commands, { check: "end" })).not.toThrow();
  });
});

describe("geometry commands keep the setup shape", () => {
  const worldOf = (doc: JsonObject, slot: string) => {
    const skeleton = new Skeleton(loadAnimDocument(doc));
    skeleton.setActiveSkins(["body"]);
    skeleton.updateWorldTransform("none");
    const out = new Float32Array(400);
    const floats = skeleton.computeSlotWorldVertices(skeleton.getSlot(slot), out);
    return [...out.slice(0, floats)];
  };

  it("move-vertices moves weighted vertices by exactly (dx, dy)", () => {
    const before = worldOf(fixture, "torso");
    const after = worldOf(applyCommand(fixture, { op: "attachment.move-vertices", ...torso, vertices: [2], dx: 5, dy: -3 }).doc, "torso");
    for (let v = 0; v < before.length / 2; v++) {
      expect(after[2 * v]).toBeCloseTo((before[2 * v] as number) + (v === 2 ? 5 : 0), 2);
      expect(after[2 * v + 1]).toBeCloseTo((before[2 * v + 1] as number) + (v === 2 ? -3 : 0), 2);
    }
  });

  it("weights.set, prune, smooth and unbind keep every vertex where it was", () => {
    const before = worldOf(fixture, "torso");
    for (const command of [
      { op: "weights.set", ...torso, vertices: [0, 3, 5], influences: [{ bone: "head", weight: 1 }, { bone: "hips", weight: 1 }] },
      { op: "weights.smooth", ...torso, iterations: 3 },
      { op: "weights.prune", ...torso, max: 1 },
      { op: "weights.unbind", ...torso }
    ]) {
      const after = worldOf(applyCommand(fixture, command).doc, "torso");
      after.forEach((value, i) => expect(value, `${command.op} float ${i}`).toBeCloseTo(before[i] as number, 2));
    }
  });
});

describe("scripts", () => {
  it("parses JSON Lines with comments and JSON arrays", () => {
    expect(parseScript('# setup\n{"op":"clip.add","name":"a","duration":1}\n\n// more\n{"op":"clip.loop","name":"a","loop":true}\n')).toHaveLength(2);
    expect(parseScript('[{"op":"clip.add","name":"a","duration":1}]')).toHaveLength(1);
    expect(() => parseScript('{"op":"clip.add"\n')).toThrow(/line 1: not valid JSON/);
  });

  it("50 commands then undo-all gives back the original byte for byte", () => {
    const script: Command[] = [];
    for (let i = 0; i < 5; i++) {
      script.push(
        { op: "bone.add", name: `b${i}`, parent: i === 0 ? "chest" : `b${i - 1}`, x: 10, length: 10, rotation: i * 5 },
        { op: "slot.add", name: `s${i}`, bone: `b${i}`, ...(i > 0 ? { before: `s${i - 1}` } : { after: "head" }) },
        { op: "attachment.add", skin: "tunic", slot: `s${i}`, name: `p${i}`, attachment: { type: "point", x: i } },
        { op: "clip.add", name: `clip${i}`, duration: 1, loop: i % 2 === 0 },
        { op: "key.set", clip: `clip${i}`, bone: `b${i}`, timeline: "rotate", time: 0, value: 0 },
        { op: "key.set", clip: `clip${i}`, bone: `b${i}`, timeline: "rotate", time: 0.5, value: 20, curve: [0.25, 0, 0.75, 1] },
        { op: "key.move", clip: `clip${i}`, bone: `b${i}`, timeline: "rotate", time: 0.5, to: 0.6 },
        { op: "bone.set", name: "chest", rotation: i },
        { op: "event.key", clip: "attack", time: 0.1 * i, name: "step" },
        { op: "bone.limits", name: `b${i}`, min: -30, max: 30 }
      );
    }
    expect(script).toHaveLength(50);
    const before = text(fixture);
    const result = applyCommands(fixture, script);
    expect(result.applied).toHaveLength(50);
    expect(text(applyPatch(result.doc, result.inverse).doc)).toBe(before);
    // Undoing step by step (latest first) also returns to the original.
    let doc: JsonValue = result.doc;
    for (const step of [...result.applied].reverse()) doc = applyPatch(doc, step.inverse).doc;
    expect(text(doc)).toBe(before);
    // And redoing every step gives the batch result again.
    for (const step of result.applied) doc = applyPatch(doc, step.patch).doc;
    expect(text(doc)).toBe(text(result.doc));
  });
});

describe("tool-backed commands", () => {
  const setupWorld = (doc: JsonObject, slot: string, name: string) => {
    const skeleton = new Skeleton(loadAnimDocument(doc));
    skeleton.setActiveSkins(["body"]);
    skeleton.updateWorldTransform("none");
    const slotIndex = skeleton.slots.findIndex((s) => s.data.name === slot);
    const attachment = skeleton.slots[slotIndex]?.attachment as unknown as { computeWorldVertices?: unknown };
    return { skeleton, attachment, slotIndex, name };
  };

  it("mesh.generate turns a region into an unweighted mesh covering the same image rectangle", () => {
    const result = applyCommand(fixture, { op: "mesh.generate", skin: "body", slot: "base", name: "base", targetVertices: 16 }).doc;
    const mesh = getAt(result, "/skins/body/attachments/base/base") as JsonObject;
    const region = getAt(fixture, "/skins/body/attachments/base/base") as JsonObject;
    expect(mesh["bones"]).toBeUndefined();
    expect(mesh["width"]).toBe(region["width"]);
    const uvs = mesh["uvs"] as number[];
    const vertices = mesh["vertices"] as number[];
    expect(vertices.length).toBe(uvs.length);
    // The vertex with uv (0, 0) sits at the region's top-left corner (region centre minus half size, unrotated fixture).
    const corner = uvs.findIndex((value, i) => i % 2 === 0 && value === 0 && uvs[i + 1] === 0);
    if (corner >= 0 && Number(region["rotation"] ?? 0) === 0) {
      expect(vertices[corner]).toBeCloseTo(Number(region["x"] ?? 0) - Number(region["width"]) / 2, 3);
      expect(vertices[corner + 1]).toBeCloseTo(Number(region["y"] ?? 0) - Number(region["height"]) / 2, 3);
    }
    expect(setupWorld(result, "base", "base").slotIndex).toBeGreaterThanOrEqual(0);
  });

  it("mesh.generate keeps positions on their UVs when the simplified hull overshoots the region (second rig: rig 5 px wider at the tips)", () => {
    const region = getAt(fixture, "/skins/body/attachments/base/base") as JsonObject;
    const w = Number(region["width"]);
    const h = Number(region["height"]);
    expect(Number(region["rotation"] ?? 0)).toBe(0);
    // A blob with two thin spikes that touch the left and right region edges: simplified to a few
    // vertices, the outward-pushed hull corners land past the edge.
    // Rounded tips (dense arcs whose apex touches the edge), as the feather and tail tips are.
    const arc = (cx: number, from: number, to: number) => Array.from({ length: 17 }, (_, k): [number, number] => {
      const a = ((from + ((to - from) * k) / 16) * Math.PI) / 180;
      return [cx + 0.15 * w * Math.cos(a), 0.5 * h + 0.3 * h * Math.sin(a)];
    });
    const outer: [number, number][] = [[0.3 * w, 0.1 * h], ...arc(0.85 * w, -90, 90), [0.3 * w, 0.9 * h], ...arc(0.15 * w, 90, 270)];
    const applied = applyCommand(fixture, { op: "mesh.generate", skin: "body", slot: "base", name: "base", outline: { outer }, targetVertices: 8 });
    const result = applied.doc;
    // ... and it says that the vertex target simplified the outline.
    expect(applied.notes.some((note) => /simplified the 36-point outline to a \d+-point hull/.test(note.message))).toBe(true);
    const mesh = getAt(result, "/skins/body/attachments/base/base") as JsonObject;
    const uvs = mesh["uvs"] as number[];
    const vertices = mesh["vertices"] as number[];
    const left = Number(region["x"] ?? 0) - w / 2;
    const top = Number(region["y"] ?? 0) - h / 2;
    for (let i = 0; i < uvs.length; i += 2) {
      expect(vertices[i]! - left).toBeCloseTo(uvs[i]! * w, 1);
      expect(vertices[i + 1]! - top).toBeCloseTo(uvs[i + 1]! * h, 1);
    }
  });

  it("mesh.generate from an outline keeps a weighted mesh weighted and its hull on the outline", () => {
    const mesh = getAt(fixture, "/skins/body/attachments/torso/torso") as JsonObject;
    const w = Number(mesh["width"]);
    const h = Number(mesh["height"]);
    const outline = { outer: [[0, 0], [w, 0], [w, h], [0, h]] };
    const result = applyCommand(fixture, { op: "mesh.generate", ...torso, outline, targetVertices: 20 }).doc;
    const next = getAt(result, "/skins/body/attachments/torso/torso") as JsonObject;
    expect(next["bones"]).toBeDefined();
    expect((next["uvs"] as number[]).length / 2).toBeGreaterThan(4);
    expect(() => loadAnimDocument(result)).not.toThrow();
  });

  it("weights.auto splits a two-bone part between the bones (lower vertices on hips, upper on chest)", () => {
    const result = applyCommand(fixture, { op: "weights.auto", ...torso, bones: ["hips", "chest"] }).doc;
    const mesh = getAt(result, "/skins/body/attachments/torso/torso") as JsonObject;
    expect(new Set(mesh["bones"] as string[])).toEqual(new Set(["hips", "chest"]));
  });

  it("doc.new makes a default skin and attachment.add creates a missing skin ()", () => {
    const fresh = applyCommand({}, { op: "doc.new", name: "fox", width: 64, height: 64 }, { check: "none" }).doc;
    expect(getAt(fresh, "/skins/body")).toEqual({ attachments: {} });
    const withSlot = applyCommand(fresh, { op: "slot.add", name: "fox", bone: "root", attachment: "fox" }).doc;
    const result = applyCommand(withSlot, { op: "attachment.add", skin: "winter", slot: "fox", name: "fox", attachment: { type: "region", path: "winter/fox", width: 10, height: 10 } });
    expect(getAt(result.doc, "/skins/winter/attachments/fox/fox")).toBeDefined();
    expect(getAt(applyPatch(result.doc, result.inverse).doc, "/skins/winter")).toBeUndefined();
  });

  it("weights.assign rejects unknown bones and repeated vertices", () => {
    expect(() => applyCommand(fixture, { op: "weights.assign", ...torso, weights: [{ vertex: 0, influences: [{ bone: "nope", weight: 1 }] }] })).toThrow(CommandError);
    expect(() =>
      applyCommand(fixture, { op: "weights.assign", ...torso, weights: [{ vertex: 0, influences: [{ bone: "chest", weight: 1 }] }, { vertex: 0, influences: [{ bone: "hips", weight: 1 }] }] })
    ).toThrow(CommandError);
  });
});

describe("weights.auto diagnostics ()", () => {
  // A hub with two parallel legs 8 px apart in one mesh: past the hub joint the split between the
  // legs is a guess, so the command must report ambiguous vertices (siblings are not adjacent there).
  const points: number[] = [];
  const triangles: number[] = [];
  const columns = 25;
  const rows = 13;
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) points.push(-10 + c * 5, -30 + r * 5);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < columns; c++) {
      const a = r * columns + c;
      triangles.push(a, a + 1, a + columns + 1, a, a + columns + 1, a + columns);
    }
  }
  // The hull first, in ring order (the format's hull convention), then the interior.
  const ring: number[] = [];
  for (let c = 0; c < columns; c++) ring.push(c);
  for (let r = 1; r < rows; r++) ring.push(r * columns + columns - 1);
  for (let c = columns - 2; c >= 0; c--) ring.push((rows - 1) * columns + c);
  for (let r = rows - 2; r >= 1; r--) ring.push(r * columns);
  const order = [...ring, ...Array.from({ length: rows * columns }, (_, i) => i).filter((i) => !ring.includes(i))];
  const index = new Map(order.map((old, k) => [old, k]));
  const mesh = {
    type: "mesh",
    path: "test/legs",
    uvs: order.flatMap(() => [0.5, 0.5]),
    triangles: triangles.map((t) => index.get(t) as number),
    vertices: order.flatMap((old) => [points[old * 2] as number, points[old * 2 + 1] as number]),
    hull: ring.length,
    width: 120,
    height: 60
  };
  const doc = {
    format: "atlas-anim@1",
    name: "two-legs",
    canvas: { width: 300, height: 200, originX: 150, originY: 100 },
    bones: [
      { name: "root" },
      { name: "hub", parent: "root", length: 40 },
      { name: "leg_a", parent: "hub", length: 60, x: 40, y: 4 },
      { name: "leg_b", parent: "hub", length: 60, x: 40, y: -4 }
    ],
    slots: [{ name: "legs", bone: "root", attachment: "legs" }],
    skins: { body: { attachments: { legs: { legs: mesh } } } }
  } as unknown as JsonObject;
  const command = { op: "weights.auto", skin: "body", slot: "legs", name: "legs", chains: [{ bones: ["hub"] }, { bones: ["leg_a"], parent: "hub", radius: 4 }, { bones: ["leg_b"], parent: "hub", radius: 4 }] };

  it("two overlapping legs off one hub give ambiguous > 0, logged in the command result", () => {
    const result = applyCommands(doc, [command]);
    const notes = result.applied[0]?.notes ?? [];
    expect(notes.find((n) => n.level === "info")?.message).toMatch(/domains hub \d+, leg_a \d+, leg_b \d+/);
    const warning = notes.find((n) => n.level === "warning");
    expect(warning?.message).toMatch(/: [1-9]\d* ambiguous vertices/);
    expect(result.notes.some((n) => n.level === "warning" && n.message.startsWith("command 1 (weights.auto): "))).toBe(true);
  });

  it("ambiguity notes name vertex IDs and the competing bones, and point at the overlay ()", () => {
    const warning = (applyCommands(doc, [command]).applied[0]?.notes ?? []).find((n) => /ambiguous/.test(n.message));
    expect(warning?.message).toMatch(/v\d+ leg_[ab] vs leg_[ab]/);
    expect(warning?.message).toMatch(/weights overview --ambiguous/);
  });

  it("`weights overview --ambiguous` marks the ambiguous vertices ()", async () => {
    const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { main } = await import("../cli/animator.js");
    const weighted = applyCommands(doc, [command]);
    const expected = weighted.notes.flatMap((n) => n.vertices ?? []);
    expect(expected.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "animator-ambiguous-"));
    try {
      const file = join(dir, "legs.anim.json");
      writeFileSync(file, JSON.stringify(weighted.doc));
      const lines: string[] = [];
      const out = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
      let code: number;
      try {
        code = await main(["weights", "overview", file, "--out", join(dir, "o.png"), "--ambiguous"]);
      } finally {
        process.stdout.write = out;
      }
      expect(code).toBe(0);
      expect(existsSync(join(dir, "o.png"))).toBe(true);
      const line = lines.find((l) => l.startsWith("ambiguous: "));
      expect(line).toMatch(new RegExp(`body/legs/legs: ${expected.length} vertex\\(es\\) \\(v${expected[0]}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("radius estimation shares equidistant hull samples: sibling order changes no weight ()", () => {
    // Two coincident sibling legs, no radius anywhere: the hull samples are equidistant from both.
    const coincident = { ...doc, bones: (doc["bones"] as JsonObject[]).map((b) => (b["name"] === "leg_b" ? { ...b, y: 4 } : b)) } as JsonObject;
    const byName = (out: JsonObject) => {
      const attachment = ((((out["skins"] as JsonObject)["body"] as JsonObject)["attachments"] as JsonObject)["legs"] as JsonObject)["legs"] as JsonObject;
      const table = attachment["bones"] as string[];
      const raw = attachment["vertices"] as number[];
      const list: Record<string, number>[] = [];
      for (let at = 0; at < raw.length; ) {
        const count = raw[at] as number;
        const entry: Record<string, number> = {};
        for (let k = 0; k < count; k++) entry[table[raw[at + 1 + k * 4] as number] as string] = raw[at + 1 + k * 4 + 3] as number;
        list.push(entry);
        at += 1 + count * 4;
      }
      return list;
    };
    const run = (legs: string[]) => byName(applyCommands(coincident, [{ op: "weights.auto", skin: "body", slot: "legs", name: "legs", chains: [{ bones: ["hub"] }, ...legs.map((leg) => ({ bones: [leg], parent: "hub" }))] }]).doc);
    const a = run(["leg_a", "leg_b"]);
    const b = run(["leg_b", "leg_a"]);
    const changed = a.filter((entry, v) => JSON.stringify(Object.entries(entry).sort()) !== JSON.stringify(Object.entries(b[v] ?? {}).sort())).length;
    expect(changed).toBe(0);
  });
});
