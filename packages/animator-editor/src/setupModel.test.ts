import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, parseAnimDocument, Skeleton, type ClipData } from "@atlas-animator/core/core";
import {
  applyOps,
  fixClips,
  registerClipFixer,
  planAddBone,
  planBoneProps,
  planDeleteBone,
  planRename,
  planReparent,
  planSetupTransform,
  runBatch,
  setupSkeleton,
  SetupError,
  type JsonObject
} from "./setupModel.js";

const RIG = new URL("../../animator/rigs/kit-body-front0/kit-body-front0.anim.json", import.meta.url);
const load = (): JsonObject => JSON.parse(readFileSync(RIG, "utf8")) as JsonObject;
const world = (raw: JsonObject, bone: string) => {
  const b = setupSkeleton(raw).getBone(bone);
  return { x: b.world.x, y: b.world.y, angle: b.worldRotationX };
};
const near = (a: number, b: number, eps = 1e-2) => expect(Math.abs(a - b)).toBeLessThan(eps);
const valid = (raw: JsonObject) => expect(parseAnimDocument(raw).ok).toBe(true);
const boneOf = (raw: JsonObject, name: string) => (raw["bones"] as JsonObject[]).find((b) => b["name"] === name)!;

describe("bones", () => {
  it("adds a bone from a drag, child of the selected parent, with the dragged start and tip", () => {
    const raw = load();
    const parentTip = setupSkeleton(raw).getBone("forearm_near");
    const from = { x: parentTip.world.x + 10, y: parentTip.world.y };
    const plan = planAddBone(raw, { parent: "forearm_near", from: [from.x, from.y], to: [from.x + 60, from.y + 80] });
    const out = runBatch(raw, plan.commands).doc;
    valid(out);
    const w = world(out, plan.bone);
    near(w.x, from.x);
    near(w.y, from.y);
    const bone = setupSkeleton(out).getBone(plan.bone);
    const tip = bone.localToWorld(bone.data.length, 0, { x: 0, y: 0 });
    near(tip.x, from.x + 60);
    near(tip.y, from.y + 80);
    expect(boneOf(out, plan.bone)["parent"]).toBe("forearm_near");
  });
  it("names the new bone uniquely and refuses a zero-length drag", () => {
    const raw = load();
    const a = planAddBone(raw, { parent: "root", from: [0, 0], to: [0, 20] });
    const b = planAddBone(runBatch(raw, a.commands).doc, { parent: "root", from: [0, 0], to: [0, 20] });
    expect(a.bone).toBe("bone");
    expect(b.bone).toBe("bone2");
    expect(() => planAddBone(raw, { parent: "root", from: [3, 3], to: [3, 3] })).toThrow(SetupError);
  });
  it("undoes and redoes a batch with its patches", () => {
    const raw = load();
    const plan = planAddBone(raw, { parent: "root", from: [0, 0], to: [50, 0] });
    const r = runBatch(raw, plan.commands);
    expect(applyOps(r.doc, r.inverse)).toEqual(raw);
    expect(applyOps(raw, r.patch)).toEqual(r.doc);
  });
  it("renames a bone and keeps the clips valid", () => {
    const raw = load();
    (raw["animations"] as JsonObject)["t"] = { duration: 1, loop: false, bones: { forearm_near: { rotate: [{ time: 0, value: 5 }, { time: 0.5, value: 20 }] } } } as never;
    const out = runBatch(raw, planRename(raw, "forearm_near", "forearm_front").commands).doc;
    valid(out);
    expect(Object.keys(((out["animations"] as JsonObject)["t"] as JsonObject)["bones"] as JsonObject)).toEqual(["forearm_front"]);
    expect(() => planRename(raw, "forearm_near", "bad name")).toThrow(SetupError);
  });
  it("re-parents a bone keeping its world position, or keeps the local values on request", () => {
    const raw = load();
    const before = world(raw, "hand_near");
    const kept = runBatch(raw, planReparent(raw, "hand_near", "body").commands).doc;
    valid(kept);
    const after = world(kept, "hand_near");
    near(after.x, before.x);
    near(after.y, before.y);
    near(after.angle, before.angle);
    const local = runBatch(raw, planReparent(raw, "hand_near", "body", false).commands).doc;
    const moved = world(local, "hand_near");
    expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeGreaterThan(1);
    expect(() => runBatch(raw, planReparent(raw, "body", "hand_near").commands)).toThrow(/subtree/);
  });
  it("edits the setup transform; children follow the bone, or stay with keep-images", () => {
    const raw = load();
    const childBefore = world(raw, "hand_near");
    const follow = runBatch(raw, planSetupTransform(raw, "forearm_near", { rotation: boneOf(raw, "forearm_near")["rotation"] as number + 20 }, false).commands).doc;
    expect(Math.hypot(world(follow, "hand_near").x - childBefore.x, world(follow, "hand_near").y - childBefore.y)).toBeGreaterThan(1);
    const keep = runBatch(raw, planSetupTransform(raw, "forearm_near", { rotation: (boneOf(raw, "forearm_near")["rotation"] as number) + 20 }, true).commands).doc;
    valid(keep);
    near(world(keep, "hand_near").x, childBefore.x);
    near(world(keep, "hand_near").y, childBefore.y);
    near(world(keep, "hand_near").angle, childBefore.angle);
    near(world(keep, "forearm_near").angle, world(raw, "forearm_near").angle + 20);
    const len = runBatch(raw, planSetupTransform(raw, "forearm_near", { length: 99 }, true).commands).doc;
    expect(setupSkeleton(len).getBone("forearm_near").data.length).toBe(99);
  });
  it("keeps the region images of the bone's slots in place", () => {
    const raw = load();
    const slot = (raw["slots"] as JsonObject[]).find((s) => s["bone"] === "head" && typeof s["attachment"] === "string")!;
    const skin = Object.keys(raw["skins"] as JsonObject)[0]!;
    const name = String(slot["attachment"]);
    const centre = (doc: JsonObject) => {
      const a = ((((doc["skins"] as JsonObject)[skin] as JsonObject)["attachments"] as JsonObject)[String(slot["name"])] as JsonObject)[name] as JsonObject;
      return setupSkeleton(doc).getBone("head").localToWorld(Number(a["x"] ?? 0), Number(a["y"] ?? 0), { x: 0, y: 0 });
    };
    const head = boneOf(raw, "head");
    const t = { x: Number(head["x"] ?? 0) + 12, y: Number(head["y"] ?? 0) - 9, rotation: Number(head["rotation"] ?? 0) + 15 };
    const before = centre(raw);
    const keep = runBatch(raw, planSetupTransform(raw, "head", t, true).commands).doc;
    near(centre(keep).x, before.x);
    near(centre(keep).y, before.y);
    const drift = runBatch(raw, planSetupTransform(raw, "head", t, false).commands).doc;
    expect(Math.hypot(centre(drift).x - before.x, centre(drift).y - before.y)).toBeGreaterThan(1);
  });
  it("keeps children and images separately (Compensate > Bones / Images)", () => {
    const raw = load();
    const slot = (raw["slots"] as JsonObject[]).find((s) => s["bone"] === "head" && typeof s["attachment"] === "string")!;
    const skin = Object.keys(raw["skins"] as JsonObject)[0]!;
    const centre = (doc: JsonObject) => {
      const a = ((((doc["skins"] as JsonObject)[skin] as JsonObject)["attachments"] as JsonObject)[String(slot["name"])] as JsonObject)[String(slot["attachment"])] as JsonObject;
      return setupSkeleton(doc).getBone("head").localToWorld(Number(a["x"] ?? 0), Number(a["y"] ?? 0), { x: 0, y: 0 });
    };
    const kid = (raw["bones"] as JsonObject[]).find((b) => b["parent"] === "head")!["name"] as string;
    const head = boneOf(raw, "head");
    const t = { x: Number(head["x"] ?? 0) + 12, y: Number(head["y"] ?? 0) - 9, rotation: Number(head["rotation"] ?? 0) + 15 };
    const img0 = centre(raw);
    const kid0 = world(raw, kid);
    const moved = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) > 1;
    const onlyBones = runBatch(raw, planSetupTransform(raw, "head", t, { bones: true, images: false }).commands).doc;
    near(world(onlyBones, kid).x, kid0.x);
    near(world(onlyBones, kid).y, kid0.y);
    expect(moved(centre(onlyBones), img0)).toBe(true);
    const onlyImages = runBatch(raw, planSetupTransform(raw, "head", t, { bones: false, images: true }).commands).doc;
    near(centre(onlyImages).x, img0.x);
    near(centre(onlyImages).y, img0.y);
    expect(moved(world(onlyImages, kid), kid0)).toBe(true);
    valid(onlyBones);
    valid(onlyImages);
  });
  it("deletes a bone: children and images move up in place; clips and constraints that use it go", () => {
    const raw = load();
    (raw["animations"] as JsonObject)["t"] = {
      duration: 1,
      loop: false,
      bones: { forearm_near: { rotate: [{ time: 0, value: 5 }] }, hand_near: { rotate: [{ time: 0, value: 7 }] } }
    } as never;
    const before = world(raw, "hand_near");
    const plan = planDeleteBone(raw, "forearm_near");
    const out = runBatch(raw, plan.commands).doc;
    valid(out);
    expect((out["bones"] as JsonObject[]).some((b) => b["name"] === "forearm_near")).toBe(false);
    expect(boneOf(out, "hand_near")["parent"]).toBe("upper_arm_near");
    near(world(out, "hand_near").x, before.x);
    near(world(out, "hand_near").y, before.y);
    near(world(out, "hand_near").angle, before.angle);
    expect(Object.keys(((out["animations"] as JsonObject)["t"] as JsonObject)["bones"] as JsonObject)).toEqual(["hand_near"]);
    expect((out["ik"] as JsonObject[]).some((c) => (c["bones"] as string[]).includes("forearm_near"))).toBe(false);
    expect(plan.bone).toBe("upper_arm_near");
  });
  it("deleting a bone hands the mesh arm's weights to its parent without moving a vertex", () => {
    const raw = load();
    const skin = (raw["skins"] as any).body.attachments.skin_arm_near.mesh;
    expect(skin.bones).toContain("forearm_near");
    // Vertices that touch elbow_near are left out: the elbow_near_half constraint follows forearm_near and goes with it, which moves the elbow by design.
    const skipped = new Set<number>();
    const worldOf = (doc: JsonObject): number[] => {
      const sk = setupSkeleton(doc);
      const att = (doc["skins"] as any).body.attachments.skin_arm_near.mesh;
      const out: number[] = [];
      let c = 0;
      for (let v = 0; v < att.uvs.length / 2; v++) {
        const n = att.vertices[c++] as number;
        let x = 0;
        let y = 0;
        for (let k = 0; k < n; k++, c += 4) {
          if (att.bones[att.vertices[c]] === "elbow_near") skipped.add(v);
          const w = sk.findBone(att.bones[att.vertices[c]])!.localToWorld(att.vertices[c + 1], att.vertices[c + 2], { x: 0, y: 0 });
          x += w.x * att.vertices[c + 3];
          y += w.y * att.vertices[c + 3];
        }
        out.push(x, y);
      }
      return out;
    };
    const before = worldOf(raw);
    const out = runBatch(raw, planDeleteBone(raw, "forearm_near").commands).doc;
    valid(out);
    expect((out["skins"] as any).body.attachments.skin_arm_near.mesh.bones).not.toContain("forearm_near");
    const after = worldOf(out);
    expect(skipped.size).toBeLessThan(before.length / 2);
    before.forEach((b, i) => skipped.has(i >> 1) || expect(Math.abs(b - after[i]!), "coord " + i).toBeLessThan(0.05));
  });
  it("sets a bone colour and helper flag, and clears them", () => {
    const raw = load();
    const set = runBatch(raw, planBoneProps(raw, "hand_near", { color: "FF8800FF", helper: true }).commands).doc;
    expect(boneOf(set, "hand_near")["color"]).toBe("ff8800ff");
    expect(boneOf(set, "hand_near")["helper"]).toBe(true);
    valid(set);
    const cleared = runBatch(set, planBoneProps(set, "hand_near", { color: null, helper: false }).commands).doc;
    expect(boneOf(cleared, "hand_near")["color"]).toBeUndefined();
    expect(boneOf(cleared, "hand_near")["helper"]).toBeUndefined();
    expect(() => runBatch(raw, [{ op: "bone.set", name: "hand_near", color: "red" }])).toThrow();
  });
});

describe("existing clips keep working", () => {
  const sample = (doc: JsonObject, clip: string, t: number) => {
    const loaded = loadAnimDocument(doc);
    const state = new AnimationState(new AnimationStateData(new AnimationLibrary(loaded)));
    state.setAnimation(0, clip, { loop: false });
    const sk = new Skeleton(loaded);
    sk.setActiveSkins(Object.keys(loaded.skins));
    state.update(t);
    state.apply(sk);
    sk.updateWorldTransform("none");
    return sk.getBone("hand_near").world.x;
  };
  it("a clip poses the same after unrelated setup edits (new bone, colour)", () => {
    const raw = load();
    (raw["animations"] as JsonObject)["t"] = { duration: 1, loop: false, bones: { upper_arm_near: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 30 }] } } } as never;
    const base = sample(raw, "t", 0.6);
    const plan = planAddBone(raw, { parent: "body", from: [0, 0], to: [30, 0] });
    const props = planBoneProps(raw, "head", { color: "00ff00ff" });
    const out = runBatch(raw, [...plan.commands, ...props.commands]).doc;
    near(sample(out, "t", 0.6), base, 1e-6);
  });
  it("fixClips renames and drops timelines in the editor's clips", () => {
    const clip = { duration: 1, loop: false, bones: { a: { rotate: [] }, b: { rotate: [] } }, slots: {}, ik: { solve: [] }, transform: {}, physics: {}, deform: {}, drawOrder: [], events: [] } as unknown as ClipData;
    const lib = new Map([["c", clip]]);
    const renamed = fixClips(lib, [{ op: "bone.rename", name: "a", to: "z" }]);
    expect(Object.keys(renamed.get("c")!.bones)).toEqual(["b", "z"]);
    expect(Object.keys(lib.get("c")!.bones)).toEqual(["a", "b"]);
    const dropped = fixClips(lib, [{ op: "bone.remove", name: "b" }, { op: "constraint.remove", kind: "ik", name: "solve" }]);
    expect(Object.keys(dropped.get("c")!.bones)).toEqual(["a"]);
    expect(dropped.get("c")!.ik).toEqual({});
  });
});

describe("clip fixer hooks", () => {
  it("runs registered fixers with the batch and the rig before / after, and can be unregistered", () => {
    const lib = new Map([["walk", { bones: {}, slots: {}, ik: {}, transform: {}, physics: {}, duration: 1, loop: true } as never]]);
    const seen: string[] = [];
    const off = registerClipFixer((clip, ctx) => {
      seen.push(`${ctx.name}:${ctx.commands.length}:${String(ctx.before["v"])}>${String(ctx.after["v"])}`);
      return { ...clip, duration: 2 };
    });
    const out = fixClips(lib, [{ op: "bone.remove", name: "x" }], { v: 1 }, { v: 2 });
    expect(seen).toEqual(["walk:1:1>2"]);
    expect(out.get("walk")!.duration).toBe(2);
    off();
    expect(fixClips(lib, [{ op: "bone.remove", name: "x" }], {}, {}).size).toBe(0);
  });
});

describe("commit parse reuse", () => {
  it("hands back the parsed result document, and chained commits keep rejecting what they would break", () => {
    const raw = load();
    const first = runBatch(raw, [{ op: "bone.add", name: "extra_a", parent: "root", x: 5, y: 5 } as never]);
    expect(first.parsed?.bones.some((b) => b.name === "extra_a")).toBe(true);
    // The next commit starts from the returned document (its parse is reused) and sees the first commit's bone.
    const second = runBatch(first.doc, [{ op: "bone.add", name: "extra_b", parent: "extra_a", x: 1, y: 1 } as never]);
    expect(second.parsed?.bones.map((b) => b.name)).toEqual(expect.arrayContaining(["extra_a", "extra_b"]));
    // A multi-command batch whose second command depends on the first, and one that breaks the document, still behave.
    expect(() => runBatch(first.doc, [{ op: "bone.add", name: "extra_c", parent: "extra_a", x: 0, y: 0 } as never, { op: "bone.add", name: "extra_d", parent: "nope", x: 0, y: 0 } as never])).toThrow();
    valid(second.doc);
  });
});
