import { readFileSync } from "node:fs";
import { loadAnimDocument, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { emptyClip, frameTime, setRotateKey, setVectorKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { fistPoint, isAttackClip, keyFramesFor, makeSampler, onionWindow, pointsFor, pointWorld, samplePaths, segmentSpeeds, speedColor, weaponTipPoint } from "./motionPath.js";

const load = (id: string): AnimDocument => loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${ALL_OUTFITS.find((o) => o.id === id)!.document}`, import.meta.url), "utf8")));
const doc = load("pro-front");

/** A swing: the upper arm turns through 90 degrees with the body travelling a little. */
function swing(): ClipData {
  let c = emptyClip(1);
  c = setRotateKey(c, "upper_arm_near", frameTime(c, 0), 0);
  c = setRotateKey(c, "upper_arm_near", frameTime(c, 10), -60);
  c = setRotateKey(c, "upper_arm_near", frameTime(c, 20), 30);
  c = setVectorKey(c, "body", "translate", frameTime(c, 0), 0, 0);
  c = setVectorKey(c, "body", "translate", frameTime(c, 20), 14, -3);
  return c;
}

describe("motion path sampling", () => {
  it("finds the weapon tip point bone and the fist centre in the pro rig", () => {
    expect(weaponTipPoint(doc)).toMatchObject({ bone: "weapon_tip", along: 0 });
    expect(fistPoint(doc)).toMatchObject({ bone: "hand_near", along: 0.5 });
  });

  it("matches the pose at every frame: the sample is the point's world position when that frame is posed", () => {
    const clip = swing();
    const tip = weaponTipPoint(doc)!;
    const fist = fistPoint(doc)!;
    const paths = samplePaths(doc, "swing", clip, [tip, fist]);
    const sampler = makeSampler(doc, "swing", clip);
    for (const p of [tip, fist]) {
      const list = paths.get(p.id)!;
      expect(list).toHaveLength(31);
      for (const s of list) {
        const w = pointWorld(sampler.poseFrame(s.frame), p)!;
        expect(Math.hypot(w.x - s.x, w.y - s.y)).toBeLessThan(1e-6);
      }
    }
    const tipList = paths.get(tip.id)!;
    expect(Math.hypot(tipList[10]!.x - tipList[0]!.x, tipList[10]!.y - tipList[0]!.y)).toBeGreaterThan(20);
  });

  it("drops the loop's duplicate last frame and skips points the rig lacks", () => {
    const clip = { ...swing(), loop: true };
    expect(samplePaths(doc, "swing", clip, [weaponTipPoint(doc)!]).get("weapon-tip")).toHaveLength(30);
    expect(samplePaths(doc, "swing", clip, [{ id: "x", bone: "nope", along: 0, label: "x" }]).size).toBe(0);
  });

  it("marks the key frames of the bone and its parents", () => {
    const keys = keyFramesFor(doc, swing(), "weapon_tip");
    expect([...keys].sort((a, b) => a - b)).toEqual([0, 10, 20]);
    expect(keyFramesFor(doc, swing(), "head").has(10)).toBe(false);
  });
});

describe("path styling and settings", () => {
  it("colours slow segments blue and fast ones red", () => {
    expect(speedColor(0)).toBe(0x3b82f6);
    expect(speedColor(1)).toBe(0xff4d3d);
    expect(speedColor(0.5)).not.toBe(speedColor(0.1));
    expect(segmentSpeeds([{ frame: 0, x: 0, y: 0 }, { frame: 1, x: 3, y: 4 }, { frame: 2, x: 3, y: 4 }])).toEqual([5, 0]);
  });
  it("windows the onion range around the playhead", () => {
    expect(onionWindow(10, 30, "all")).toEqual({ from: 0, to: 30 });
    expect(onionWindow(1, 30, 4)).toEqual({ from: 0, to: 5 });
    expect(onionWindow(29, 30, 4)).toEqual({ from: 25, to: 30 });
  });
  it("turns the weapon tip on for attack clips and picks points from the settings", () => {
    expect(isAttackClip("attack_slash_1")).toBe(true);
    expect(isAttackClip("walk")).toBe(false);
    const s = { on: true, selected: true, tip: true, fist: false, range: "all" as const };
    expect(pointsFor(doc, s, ["hand_near", "root"]).map((p) => p.id)).toEqual(["bone:hand_near", "weapon-tip"]);
  });
});
