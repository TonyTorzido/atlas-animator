import { readFileSync } from "node:fs";
import { loadAnimDocument, type AnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip } from "./clipModel.js";
import { applyFacing, facingSign, mirroredDoc, mirrorGates, mirrorStaticIssues, spineFacing } from "./facing.js";
import { ALL_OUTFITS } from "./fixtures.js";

/** The pro rigs ship no clips: a still one-second clip stands in for the committed one. */
const STILL = { duration: 1, loop: false, bones: {} };
const load = (id: string): AnimDocument => loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${ALL_OUTFITS.find((o) => o.id === id)!.document}`, import.meta.url), "utf8")));

describe("facing right", () => {
  it("is a root scaleX flip, never a separate clip", () => {
    expect(facingSign("left")).toBe(1);
    expect(facingSign("right")).toBe(-1);
    const node = { scale: { x: 1 } };
    applyFacing(node, "right");
    expect(node.scale.x).toBe(-1);
    applyFacing(node, "left");
    expect(node.scale.x).toBe(1);
    const zoomed = { scale: { x: 2 } };
    applyFacing(zoomed, "right");
    expect(zoomed.scale.x).toBe(-2);
    expect(spineFacing("right")).toEqual({ scaleX: -1 });
    expect(spineFacing("left")).toEqual({ scaleX: 1 });
  });

  it("mirroredDoc flips only the root bones", () => {
    const doc = load("pro-turned");
    const flipped = mirroredDoc(doc);
    doc.bones.forEach((b, i) => expect(flipped.bones[i]!.scaleX).toBe(b.parent ? b.scaleX : -b.scaleX));
  });

  it("flags a weapon bone under a hand, an unpaired side bone and an inherit mode that refuses the reflection", () => {
    const base = load("pro-turned");
    const doc: AnimDocument = {
      ...base,
      bones: [
        ...base.bones,
        { ...base.bones[1]!, name: "weapon", parent: "hand_l", inherit: "normal" },
        { ...base.bones[1]!, name: "cape_l", parent: base.bones[0]!.name, inherit: "noScaleOrReflection" }
      ]
    };
    const msgs = mirrorStaticIssues(doc).map((i) => i.message);
    expect(msgs.some((m) => m.includes("weapon-hand assumption") && m.includes("weapon"))).toBe(true);
    expect(msgs.some((m) => m.includes("cape_l has no cape_r twin"))).toBe(true);
    expect(msgs.some((m) => m.includes("cape_l inherits 'noScaleOrReflection'"))).toBe(true);
  });

  it("the posed check catches a bone that refuses the reflection", () => {
    const base = load("pro-turned");
    const root = base.bones[0]!.name;
    const doc: AnimDocument = { ...base, bones: [...base.bones, { ...base.bones[1]!, name: "fixed_piece", parent: root, x: 80, y: 20, length: 30, rotation: 0, inherit: "noScaleOrReflection" }] };
    const issues = mirrorGates(doc, "still", parseClip(STILL), [0]);
    expect(issues.some((i) => i.message.startsWith("fixed_piece does not mirror"))).toBe(true);
  });

  it("the stock pro rig: every issue is a mirror warning, and the posed walk mirrors exactly", () => {
    const doc = load("pro-turned");
    const issues = mirrorGates(doc, "still", parseClip(STILL), [0, 0.1, 0.2]);
    expect(issues.every((i) => i.kind === "mirror" && i.severity === "warning")).toBe(true);
    expect(issues.filter((i) => i.message.includes("does not mirror"))).toEqual([]);
  });
});
