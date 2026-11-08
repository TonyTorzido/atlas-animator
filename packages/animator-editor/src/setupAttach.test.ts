import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnimDocument } from "@atlas-animator/core/core";
import { atlasRegions, defaultRegion, importedPath, planAttachImage, planAttachmentTransform, planDefaultAttachment, planRemoveAttachment } from "./setupAttach.js";
import { ikConstraints, planAddTwoBoneIk, planConstraintSet, planRemoveConstraint, transformConstraints } from "./setupConstraints.js";
import { runBatch, setupSkeleton, SetupError, type JsonObject } from "./setupModel.js";

const DIR = new URL("../../animator/rigs/kit-body-front0/", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(new URL("kit-body-front0.anim.json", DIR), "utf8")) as JsonObject;
const atlas = JSON.parse(readFileSync(new URL("kit-body-front0.atlas.json", DIR), "utf8")) as unknown;
const valid = (raw: JsonObject) => expect(parseAnimDocument(raw).ok).toBe(true);
const attachments = (raw: JsonObject, skin: string, slot: string) => (((raw["skins"] as JsonObject)[skin] as JsonObject)["attachments"] as JsonObject)[slot] as JsonObject | undefined;
const slotOf = (raw: JsonObject, name: string) => (raw["slots"] as JsonObject[]).find((s) => s["name"] === name)!;

/** The pro rigs ship the weapon slot with no default: point it at the rig's own weapon attachment, as the editor does when it mounts one. */
const withWeaponDefault = (raw: JsonObject): string => {
  const name = Object.keys((((raw["skins"] as JsonObject)["body"] as JsonObject)["attachments"] as JsonObject)["weapon"] as JsonObject)[0]!;
  slotOf(raw, "weapon")["attachment"] = name;
  return name;
};

describe("attachments", () => {
  it("lists the atlas regions with their canvas size", () => {
    const regions = atlasRegions(atlas);
    expect(regions.length).toBeGreaterThan(50);
    expect(regions.find((r) => r.path === "body/weapon__double_axe")).toEqual({ path: "body/weapon__double_axe", width: 380, height: 671 });
  });
  it("attaches an atlas region to a new slot on the selected bone and makes it the default", () => {
    const raw = load();
    const plan = planAttachImage(raw, { skin: "body", slot: null, bone: "head", path: "body/hair_front__fringe", width: 438, height: 191, setDefault: true });
    const out = runBatch(raw, plan.commands).doc;
    valid(out);
    expect(slotOf(out, plan.slot)["bone"]).toBe("head");
    expect(slotOf(out, plan.slot)["attachment"]).toBe(plan.attachment);
    expect(attachments(out, "body", plan.slot)![plan.attachment]).toMatchObject({ type: "region", path: "body/hair_front__fringe", width: 438, height: 191 });
  });
  it("adds a second image to an existing slot without changing its default, then switches the default", () => {
    const raw = load();
    const before = slotOf(raw, "weapon")["attachment"];
    const plan = planAttachImage(raw, { skin: "body", slot: "weapon", path: "body/hair_front__fringe", width: 438, height: 191, setDefault: false, name: "fringe" });
    const out = runBatch(raw, plan.commands).doc;
    expect(slotOf(out, "weapon")["attachment"]).toBe(before);
    const switched = runBatch(out, planDefaultAttachment(out, "weapon", "fringe")).doc;
    expect(slotOf(switched, "weapon")["attachment"]).toBe("fringe");
    const none = runBatch(switched, planDefaultAttachment(switched, "weapon", null)).doc;
    expect(slotOf(none, "weapon")["attachment"]).toBeNull();
    expect(() => planDefaultAttachment(raw, "nope", null)).toThrow(SetupError);
  });
  it("imports an image as a new atlas page and registers it in the document", () => {
    const raw = load();
    const plan = planAttachImage(raw, { skin: "body", slot: null, bone: "body", name: "badge", imported: { rigName: "kit-body-front0" }, width: 64, height: 64, setDefault: true });
    const file = plan.page!;
    expect(plan.path).toBe(importedPath("body", "badge", "badge"));
    const out = runBatch(raw, plan.commands).doc;
    valid(out);
    expect((out["atlas"] as JsonObject)["pages"]).toEqual([...((raw["atlas"] as JsonObject)["pages"] as string[]), file]);
    expect(file).toMatch(/^kit-body-front0\.imp-badge\.png$/);
  });
  it("moves, rotates and scales a region relative to its bone", () => {
    const raw = load();
    const slot = "weapon";
    const name = withWeaponDefault(raw);
    const out = runBatch(raw, planAttachmentTransform(raw, { skin: "body", slot, name }, { x: 12.34567, y: -5, rotation: 30, scaleX: 1.5, scaleY: 1.5 })).doc;
    valid(out);
    expect(attachments(out, "body", slot)![name]).toMatchObject({ x: 12.3457, y: -5, rotation: 30, scaleX: 1.5, scaleY: 1.5 });
    expect(() => planAttachmentTransform(raw, { skin: "body", slot, name }, { scaleX: 0 })).toThrow(SetupError);
    expect(defaultRegion(out, "body", slot)?.name).toBe(name);
  });
  it("removes an attachment and clears the default that pointed at it", () => {
    const raw = load();
    const name = withWeaponDefault(raw);
    const out = runBatch(raw, planRemoveAttachment(raw, { skin: "body", slot: "weapon", name })).doc;
    valid(out);
    expect(slotOf(out, "weapon")["attachment"]).toBeNull();
  });
});

describe("constraints", () => {
  it("lists IK and transform constraints with defaults", () => {
    const raw = load();
    const ik = ikConstraints(raw);
    expect(ik.find((c) => c.name === "leg_ik_near")).toMatchObject({ bones: ["thigh_near", "shin_near"], target: "foot_near_target", bendPositive: false, mix: 1 });
    const tc = transformConstraints(raw);
    expect(tc[0]!.mixes.mixRotate).toBeDefined();
    expect(Object.keys(tc[0]!.offset)).toEqual(["rotation", "x", "y", "scaleX", "scaleY", "shearY"]);
  });
  it("edits IK mix, bend and softness", () => {
    const raw = load();
    const out = runBatch(raw, planConstraintSet(raw, "ik", "leg_ik_near", { mix: 0.5, bendPositive: true, softness: 4 })).doc;
    valid(out);
    expect(ikConstraints(out).find((c) => c.name === "leg_ik_near")).toMatchObject({ mix: 0.5, bendPositive: true, softness: 4 });
    expect(() => planConstraintSet(raw, "ik", "leg_ik_near", { mix: 2 })).toThrow(SetupError);
    expect(() => planConstraintSet(raw, "ik", "nope", { mix: 1 })).toThrow(SetupError);
  });
  it("edits transform mixes and merges offsets", () => {
    const raw = load();
    const name = transformConstraints(raw)[0]!.name;
    const out = runBatch(raw, [...planConstraintSet(raw, "transform", name, { mixRotate: 0.25 }), ...planConstraintSet(raw, "transform", name, { offset: { rotation: 7 } })]).doc;
    valid(out);
    const c = transformConstraints(out).find((x) => x.name === name)!;
    expect(c.mixes.mixRotate).toBe(0.25);
    expect(c.offset.rotation).toBe(7);
  });
  it("removes a constraint and its clip timelines", () => {
    const raw = load();
    (raw["animations"] as JsonObject)["t"] = { duration: 1, loop: false, ik: { hand_ik_near: [{ time: 0, mix: 1 }] } } as never;
    const out = runBatch(raw, planRemoveConstraint(raw, "ik", "hand_ik_near")).doc;
    valid(out);
    expect(ikConstraints(out).some((c) => c.name === "hand_ik_near")).toBe(false);
    expect(((out["animations"] as JsonObject)["t"] as JsonObject)["ik"]).toEqual({});
  });
  it("adds a 2-bone IK on a limb: target at the tip, setup pose kept, mix 0, the bend that matches the pose", () => {
    const raw0 = load();
    const raw = runBatch(raw0, planRemoveConstraint(raw0, "ik", "hand_ik_near")).doc;
    const tipOf = (doc: JsonObject) => {
      const b = setupSkeleton(doc).getBone("forearm_near");
      return b.localToWorld(b.data.length, 0, { x: 0, y: 0 });
    };
    const before = tipOf(raw);
    const plan = planAddTwoBoneIk(raw, "forearm_near");
    const out = runBatch(raw, plan.commands).doc;
    valid(out);
    const c = ikConstraints(out).find((x) => x.name === plan.constraint)!;
    expect(c).toMatchObject({ bones: ["upper_arm_near", "forearm_near"], target: plan.target, mix: 0 });
    const target = setupSkeleton(out).getBone(plan.target);
    expect(Math.hypot(target.world.x - before.x, target.world.y - before.y)).toBeLessThan(0.05);
    expect((out["bones"] as JsonObject[]).find((b) => b["name"] === plan.target)!["helper"]).toBe(true);
    // at mix 1 the limb still reaches the target where it already is (the chosen bend reproduces the pose)
    const solved = runBatch(out, planConstraintSet(out, "ik", plan.constraint, { mix: 1 })).doc;
    const after = tipOf(solved);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.5);
    expect(() => planAddTwoBoneIk(out, "forearm_near")).toThrow(SetupError);
    expect(() => planAddTwoBoneIk(raw, "root")).toThrow(SetupError);
  });
});

import { groupRegions, isVariantPath } from "./setupAttach.js";
describe("groupRegions", () => {
  const regions = [
    { path: "body/skin_arm_far", width: 10, height: 10 },
    { path: "body/skin_arm_far__c020", width: 10, height: 10 },
    { path: "body/skin_arm_far__g0004", width: 10, height: 10 },
    { path: "hair/front_1", width: 10, height: 10 }
  ];
  it("hides crease and generated variants until asked, groups by folder, and filters", () => {
    expect(isVariantPath("body/skin_arm_far__c020")).toBe(true);
    expect(isVariantPath("body/skin_arm_far")).toBe(false);
    const g = groupRegions(regions, "", false);
    expect(g.groups.map((x) => [x.family, x.items.length])).toEqual([["body", 1], ["hair", 1]]);
    expect(g.hiddenVariants).toBe(2);
    expect(groupRegions(regions, "ARM", true).matched).toBe(3);
    expect(groupRegions(regions, "", true, 2).shown).toBe(2);
  });
});
