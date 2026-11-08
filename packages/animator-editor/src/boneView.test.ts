import { describe, expect, it } from "vitest";
import { boneViewFor, boneWeight, chainBones, defaultBoneView, nextBoneView } from "./boneView.js";
import { cycleStack, rankBones, type PickBone } from "./selectionModel.js";

const b = (name: string, ox: number, oy: number, tx: number, ty: number, extra: Partial<PickBone> = {}): PickBone => ({ name, ox, oy, tx, ty, helper: false, hidden: false, ...extra });

describe("bone view", () => {
  it("starts hidden in Swag and full elsewhere, and a remembered choice wins", () => {
    expect(defaultBoneView("swag")).toBe("off");
    expect(defaultBoneView("animate")).toBe("full");
    expect(boneViewFor("swag", {})).toBe("off");
    expect(boneViewFor("swag", { swag: "dim" })).toBe("dim");
    expect(boneViewFor("rig", { swag: "off" })).toBe("full");
  });

  it("cycles all, dimmed, chain, hidden and round", () => {
    expect(["full", "dim", "chain", "off"].map((v) => nextBoneView(v as never))).toEqual(["dim", "chain", "off", "full"]);
  });

  it("dims plain bones, keeps the selection at full strength, and hides the rest in chain view", () => {
    expect(boneWeight("dim", 0, true)!.alpha).toBeLessThan(0.4);
    expect(boneWeight("dim", 3, true)!.alpha).toBe(1);
    expect(boneWeight("chain", 0, false)).toBeNull();
    expect(boneWeight("chain", 0, true)).not.toBeNull();
    expect(boneWeight("off", 3, true)).toBeNull();
  });

  it("the chain is the bone, its ancestors and its descendants", () => {
    const parent: Record<string, string | null> = { root: null, body: "root", chest: "body", head: "chest", arm: "chest", hand: "arm", leg: "body" };
    const set = chainBones((n) => parent[n] ?? null, Object.keys(parent), ["arm"]);
    expect([...set].sort()).toEqual(["arm", "body", "chest", "hand", "root"]);
  });
});

describe("generous picking", () => {
  it("a click on the head's tip picks the head, not the hair chain that starts there", () => {
    const bones = [b("head", 0, 0, 0, -40), b("hair_1", 0, -40, 10, -60)];
    expect(rankBones(bones, 0, -40, 18)[0]).toBe("head");
  });

  it("the selected bone wins a close call, and a helper loses it", () => {
    const bones = [b("a", 0, 0, 40, 0), b("b", 0, 6, 40, 6)];
    expect(rankBones(bones, 20, 4, 18, { selected: "a" })[0]).toBe("a");
    expect(rankBones(bones, 20, 4, 18)[0]).toBe("b");
    const helper = [b("a", 0, 0, 40, 0), b("target", 0, 2, 40, 2, { helper: true })];
    expect(rankBones(helper, 20, 2, 18)[0]).toBe("a");
  });

  it("finds a short bone from its tip within the pick radius", () => {
    expect(rankBones([b("chest", 0, 0, 10, 0)], 26, 0, 18)).toEqual(["chest"]);
    expect(rankBones([b("chest", 0, 0, 10, 0)], 30, 0, 18)).toEqual([]);
  });

  it("Alt+click walks the stack and wraps", () => {
    const stack = ["a", "b", "c"];
    expect(cycleStack(stack, null)).toBe("a");
    expect(cycleStack(stack, "a")).toBe("b");
    expect(cycleStack(stack, "c")).toBe("a");
    expect(cycleStack([], "a")).toBeNull();
  });
});
