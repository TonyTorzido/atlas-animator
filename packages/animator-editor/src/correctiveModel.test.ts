import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { runBatch, applyOps, type JsonObject } from "./setupModel.js";
import { correctiveSets, keyDeformOf, newSetName, planCorrectiveKey, planDeleteCorrectiveKey, roundAngle } from "./correctiveModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const apply = (raw: JsonObject, commands: Parameters<typeof runBatch>[1]) => {
  const r = runBatch(raw, commands);
  expect(parseAnimDocument(r.doc).ok).toBe(true);
  return r;
};
const a = { skin: "body", slot: "skin_arm_far", attachment: "mesh" };

describe("correctives (Batch 7b-2, )", () => {
  it("creates a set with a key, adds a second angle in order, merges meshes into one key and undoes", () => {
    const raw = load();
    const bone = "forearm_far";
    const set = newSetName(raw, bone);
    const full = new Float64Array(16);
    full[4] = 3;
    full[5] = -2;
    const one = apply(raw, planCorrectiveKey(raw, { set, bone, at: 70, address: a, full }));
    const s1 = correctiveSets(one.doc, bone).find((x) => x.name === set)!;
    expect(s1.keys.map((k) => k.at)).toEqual([70]);
    expect(s1.keys[0]!.meshes).toEqual(["skin_arm_far/mesh"]);
    const two = apply(one.doc, planCorrectiveKey(one.doc, { set, bone, at: 30, address: a, full }));
    expect(correctiveSets(two.doc, bone).find((x) => x.name === set)!.keys.map((k) => k.at)).toEqual([30, 70]);
    const other = { skin: "body", slot: "skin_arm_near", attachment: "mesh" };
    const three = apply(two.doc, planCorrectiveKey(two.doc, { set, bone, at: 70, address: other, full }));
    expect(correctiveSets(three.doc, bone).find((x) => x.name === set)!.keys.find((k) => k.at === 70)!.meshes.length).toBe(2);
    expect(keyDeformOf(three.doc, set, 70, a, 16)![4]).toBe(3);
    expect(applyOps(three.doc, three.inverse)).toEqual(two.doc);
  });
  it("a zero deform removes the mesh, deleting the last key removes the set, and a bad set or angle is refused", () => {
    const raw = load();
    const bone = "forearm_far";
    const set = newSetName(raw, bone);
    const full = new Float64Array(8);
    full[0] = 1;
    const one = apply(raw, planCorrectiveKey(raw, { set, bone, at: 45, address: a, full }));
    const cleared = apply(one.doc, planCorrectiveKey(one.doc, { set, bone, at: 45, address: a, full: new Float64Array(8) }));
    expect(correctiveSets(cleared.doc, bone).find((x) => x.name === set)!.keys[0]!.meshes).toEqual([]);
    const gone = apply(one.doc, planDeleteCorrectiveKey(one.doc, set, 45));
    expect(correctiveSets(gone.doc, bone).some((x) => x.name === set)).toBe(false);
    expect(() => planDeleteCorrectiveKey(one.doc, set, 10)).toThrow(/no key/);
    expect(() => planDeleteCorrectiveKey(one.doc, "nope", 10)).toThrow(/no corrective set/);
    expect(() => planCorrectiveKey(one.doc, { set, bone: "forearm_near", at: 5, address: a, full })).toThrow(/driven by/);
    expect(roundAngle(1000)).toBe(360);
    expect(Object.is(roundAngle(-0.001), 0)).toBe(true);
  });
});
