import { describe, expect, it } from "vitest";
import { AnchoredDrawOrder, resolveSetupDrawOrder, type DrawOrderSlot } from "./drawOrder.js";
import type { AnimDocumentInput } from "./format.js";
import { formatIssue, parseAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import { testDocument } from "./testHelpers.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;

/**
 * back_arm, torso (+ cape before it, torso_cloth after it, torso_plate after the cloth),
 * front_arm, weapon. Unanchored: back_arm, torso, front_arm, weapon.
 */
const SLOTS: DrawOrderSlot[] = [
  { name: "back_arm" },
  { name: "torso" },
  { name: "torso_cloth", drawAfter: "torso" },
  { name: "torso_plate", drawAfter: "torso_cloth" },
  { name: "cape", drawBefore: "torso" },
  { name: "front_arm" },
  { name: "weapon" }
];
const index = (name: string) => SLOTS.findIndex((slot) => slot.name === name);

function resolve(offsets: Record<string, number>, setup: string[] = SLOTS.map((slot) => slot.name)): string[] {
  const resolver = new AnchoredDrawOrder(SLOTS, setup.map(index));
  const values = new Int32Array(SLOTS.length);
  for (const [name, offset] of Object.entries(offsets)) values[index(name)] = offset;
  const out = new Int32Array(SLOTS.length);
  resolver.resolve(values, out);
  return Array.from(out, (i) => SLOTS[i]?.name ?? "?");
}

describe("anchored draw order", () => {
  it("places anchored slots at their anchors in the setup order", () => {
    expect(resolve({})).toEqual(["back_arm", "cape", "torso", "torso_cloth", "torso_plate", "front_arm", "weapon"]);
  });

  it("an offset on the torso carries its anchored cloth, plate and cape with it", () => {
    // +2 places among the unanchored slots: back_arm, front_arm, weapon, torso.
    expect(resolve({ torso: 2 })).toEqual(["back_arm", "front_arm", "weapon", "cape", "torso", "torso_cloth", "torso_plate"]);
    // Moving the weapon behind the torso keeps the cloth and plate on the torso.
    expect(resolve({ weapon: -2 })).toEqual(["back_arm", "weapon", "cape", "torso", "torso_cloth", "torso_plate", "front_arm"]);
  });

  it("ignores offsets on anchored slots", () => {
    expect(resolve({ torso_cloth: 3, cape: -1 })).toEqual(resolve({}));
  });

  it("keeps slots anchored to the same slot in slot-list (merge) order, on both sides", () => {
    const slots: DrawOrderSlot[] = [
      { name: "torso" },
      { name: "a", drawAfter: "torso" },
      { name: "b", drawBefore: "torso" },
      { name: "c", drawAfter: "torso" },
      { name: "d", drawBefore: "torso" }
    ];
    expect(resolveSetupDrawOrder(slots)).toEqual(["b", "d", "torso", "a", "c"]);
  });

  it("ignores where the setup list puts an anchored slot", () => {
    expect(resolve({}, ["torso_plate", "weapon", "back_arm", "torso", "front_arm", "cape", "torso_cloth"])).toEqual([
      "weapon",
      "back_arm",
      "cape",
      "torso",
      "torso_cloth",
      "torso_plate",
      "front_arm"
    ]);
  });

  it("draws the slots of an anchor cycle last instead of looping", () => {
    const slots: DrawOrderSlot[] = [{ name: "a", drawAfter: "b" }, { name: "b", drawAfter: "a" }, { name: "c" }];
    expect(resolveSetupDrawOrder(slots)).toEqual(["c", "a", "b"]);
  });

  it("always yields a permutation for random offsets", () => {
    for (let trial = 0; trial < 50; trial++) {
      const offsets: Record<string, number> = {};
      for (const slot of SLOTS) offsets[slot.name] = ((trial * 7 + index(slot.name) * 3) % 9) - 4;
      expect([...resolve(offsets)].sort()).toEqual(SLOTS.map((slot) => slot.name).sort());
    }
  });
});

describe("anchored draw order in the skeleton and the loader", () => {
  const sections: Sections = {
    bones: [{ name: "root" }],
    slots: SLOTS.map((slot) => ({ ...slot, bone: "root" })),
    drawOrder: ["back_arm", "cape", "torso", "torso_cloth", "torso_plate", "front_arm", "weapon"]
  };

  it("the skeleton resolves animation and driven offsets through the anchors", () => {
    const skeleton = new Skeleton(testDocument(sections));
    skeleton.drawOrderOffsets[skeleton.getSlot("torso").index] = 2;
    skeleton.updateWorldTransform();
    expect(skeleton.drawOrder.map((slot) => slot.data.name)).toEqual([
      "back_arm",
      "front_arm",
      "weapon",
      "cape",
      "torso",
      "torso_cloth",
      "torso_plate"
    ]);
  });

  it("bounds offsets by the unanchored slot count and warns about misplaced anchored slots", () => {
    const result = parseAnimDocument({
      format: "atlas-anim@1",
      name: "t",
      canvas: { width: 1, height: 1, originX: 0, originY: 0 },
      ...sections,
      drawOrder: ["back_arm", "torso_plate", "cape", "torso", "torso_cloth", "front_arm", "weapon"],
      animations: { swap: { duration: 1, drawOrder: [{ time: 0, offsets: [{ slot: "torso", offset: 3 }] }] } }
    });
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      "animations.swap.drawOrder[0].offsets[0].offset: moves 'torso' to position 4 among the unanchored slots, outside 0..3",
      "warning: drawOrder[1]: anchored slot 'torso_plate' is drawn next to its anchor 'torso_cloth', not at this position"
    ]);
  });
});
