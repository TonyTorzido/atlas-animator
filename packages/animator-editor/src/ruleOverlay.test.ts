import { readFileSync } from "node:fs";
import { loadAnimDocument, type AnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { emptyClip, setVectorKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { boneWords, chipStates, clipFindings, describeHit, RULES, weaponNameOf, type DescribeContext } from "./ruleOverlay.js";

const load = (id: string): AnimDocument => loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${ALL_OUTFITS.find((o) => o.id === id)!.document}`, import.meta.url), "utf8")));
const ctx: DescribeContext = { weaponName: "Axe" };

describe("plain-English findings", () => {
  it("names the side and the part", () => {
    expect(boneWords("upper_arm_near")).toBe("near upper arm");
    expect(boneWords("forearm_l")).toBe("left forearm");
    expect(describeHit({ rule: "fist on own arm", bones: ["hand_near", "forearm_near"], message: "near fist is 9.0 px off the end of its forearm (maximum 3)" }, ctx)).toMatchObject({ text: "Fist came off the near arm", bone: "hand_near" });
    expect(describeHit({ rule: "weapon across face", bones: ["weapon", "head"], message: "the weapon crosses the face" }, ctx).text).toBe("Axe crosses the face");
    expect(describeHit({ rule: "limb stretch", bones: ["forearm_far"], message: "forearm_far stretched 12% past its length" }, ctx)).toMatchObject({ text: "The far forearm is stretched too long", bone: "forearm_far" });
    expect(weaponNameOf("axe_a")).toBe("Axe");
    expect(weaponNameOf("x")).toBe("The weapon");
  });

  it("makes one chip per rule, red with the first bad frame", () => {
    const whole = new Map([
      [4, [{ rule: "weapon across face" as const, text: "Axe crosses the face", bones: ["weapon"], bone: "weapon" }]],
      [2, [{ rule: "weapon across face" as const, text: "Axe crosses the face", bones: ["weapon"], bone: "weapon" }]]
    ]);
    const chips = chipStates(whole, [], 0);
    expect(chips).toHaveLength(RULES.length);
    expect(chips.filter((c) => c.bad).map((c) => [c.rule, c.bad!.frame])).toEqual([["weapon across face", 2]]);
  });
});

describe("whole-clip findings on the pro turned rig", () => {
  it("is clean for an empty clip and flags a pulled-off fist at the frame that breaks it", () => {
    const doc = load("pro-turned");
    const clean = emptyClip(0.5, false);
    expect(clipFindings(doc, "t", clean).size).toBe(0);
    const bad = setVectorKey(clean, "hand_near", "translate", 0.2, 40, 0);
    const found = clipFindings(doc, "t", bad);
    expect([...found.values()].flat().some((f) => f.rule === "fist on own arm")).toBe(true);
  });
});
