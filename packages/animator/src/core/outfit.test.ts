import { describe, expect, it } from "vitest";
import { applyDrawOrderOffsets } from "./drawOrder.js";
import type { AnimDocumentInput } from "./format.js";
import { formatIssue, parseAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import { random, testDocument } from "./testHelpers.js";

type Sections = Omit<AnimDocumentInput, "format" | "name" | "canvas">;

const region = (path: string) => ({ type: "region" as const, path, width: 10, height: 10 });

/** A body with hair, a torso and a cloth slot; skins: body, tunic, helmet, cape (skin bone). */
const outfitSections: Sections = {
  bones: [
    { name: "root" },
    { name: "chest", parent: "root" },
    { name: "cape_1", parent: "chest", skin: true },
    { name: "cape_2", parent: "cape_1", skin: true }
  ],
  slots: [
    { name: "cape", bone: "cape_2", attachment: "cape" },
    { name: "torso", bone: "chest", attachment: "torso" },
    { name: "torso_cloth", bone: "chest", attachment: "torso_cloth" },
    { name: "hair", bone: "chest", attachment: "hair" }
  ],
  skins: {
    body: { attachments: { torso: { torso: region("body/torso") }, hair: { hair: region("body/hair"), bun: region("body/bun") } } },
    tunic: { attachments: { torso_cloth: { torso_cloth: region("swag/tunic") } } },
    plate: { attachments: { torso_cloth: { torso_cloth: region("swag/plate") } } },
    helmet: { attachments: { hair: { hair: region("swag/helmet-hair") } }, hides: ["hair"] },
    cape: { attachments: { cape: { cape: region("swag/cape") } }, bones: ["cape_2"] }
  }
};

function shown(skeleton: Skeleton): Record<string, string | null> {
  return Object.fromEntries(
    skeleton.slots.map((slot) => [slot.data.name, slot.attachment && (slot.attachment.type === "region" || slot.attachment.type === "mesh") ? slot.attachment.path : null])
  );
}

describe("outfits (active skin merge)", () => {
  it("shows nothing until skins are active", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    skeleton.updateWorldTransform();
    expect(shown(skeleton)).toEqual({ cape: null, torso: null, torso_cloth: null, hair: null });
  });

  it("resolves placeholders through the active skins", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    skeleton.setActiveSkins(["body", "tunic"]);
    expect(shown(skeleton)).toEqual({ cape: null, torso: "body/torso", torso_cloth: "swag/tunic", hair: "body/hair" });
  });

  it("a later skin wins where two define the same placeholder", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    skeleton.setActiveSkins(["body", "tunic", "plate"]);
    expect(shown(skeleton).torso_cloth).toBe("swag/plate");
    skeleton.setActiveSkins(["body", "plate", "tunic"]);
    expect(shown(skeleton).torso_cloth).toBe("swag/tunic");
  });

  it("hides apply while the hiding skin is active, whatever defines the slot", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    skeleton.setActiveSkins(["body", "helmet"]);
    expect(shown(skeleton).hair).toBeNull();
    expect(skeleton.getSlot("hair").hidden).toBe(true);
    skeleton.setActiveSkins(["body"]);
    expect(shown(skeleton).hair).toBe("body/hair");
  });

  it("skin bones activate with their skin, and a slot on an inactive bone shows nothing", () => {
    const skeleton = new Skeleton(testDocument({ ...outfitSections, skins: { ...outfitSections.skins, early: { attachments: { cape: { cape: region("swag/early-cape") } } } } }));
    // `early` defines the cape attachment but does not activate the cape bones.
    skeleton.setActiveSkins(["body", "early"]);
    expect(skeleton.getBone("cape_2").active).toBe(false);
    expect(shown(skeleton).cape).toBeNull();
    skeleton.setActiveSkins(["body", "cape"]);
    expect(skeleton.getBone("cape_1").active).toBe(true);
    expect(skeleton.getBone("cape_2").active).toBe(true);
    expect(shown(skeleton).cape).toBe("swag/cape");
  });

  it("the slot's placeholder picks among the skin's attachments", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    skeleton.setActiveSkins(["body"]);
    skeleton.getSlot("hair").placeholder = "bun";
    skeleton.updateWorldTransform();
    expect(shown(skeleton).hair).toBe("body/bun");
    skeleton.getSlot("hair").placeholder = "missing";
    skeleton.updateWorldTransform();
    expect(shown(skeleton).hair).toBeNull();
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();
    expect(shown(skeleton).hair).toBe("body/hair");
  });

  it("rejects unknown skins", () => {
    const skeleton = new Skeleton(testDocument(outfitSections));
    expect(() => skeleton.setActiveSkins(["nope"])).toThrow(/unknown skin 'nope'/);
  });

  it("shares one attachment library between skeletons of the same document", () => {
    const doc = testDocument(outfitSections);
    expect(new Skeleton(doc).attachments).toBe(new Skeleton(doc).attachments);
  });
});

describe("draw order", () => {
  const order = (n: number, offsets: Record<number, number>) => {
    const setup = Array.from({ length: n }, (_, i) => i);
    const values = new Int32Array(n);
    for (const [slot, offset] of Object.entries(offsets)) values[Number(slot)] = offset;
    const out = new Int32Array(n);
    applyDrawOrderOffsets(setup, values, out, new Int32Array(n));
    return Array.from(out);
  };

  it("keeps the setup order without offsets", () => {
    expect(order(5, {})).toEqual([0, 1, 2, 3, 4]);
  });

  it("moves one slot by exactly its offset", () => {
    expect(order(5, { 1: 2 })).toEqual([0, 2, 3, 1, 4]);
    expect(order(5, { 3: -3 })).toEqual([3, 0, 1, 2, 4]);
  });

  it("clamps moves to the ends of the list", () => {
    expect(order(4, { 1: 10 })).toEqual([0, 2, 3, 1]);
    expect(order(4, { 2: -10 })).toEqual([2, 0, 1, 3]);
  });

  it("resolves two moves to one place deterministically (nearest free, moving direction first)", () => {
    // Slot 0 -> 2 and slot 3 -> 2: slot 0 claims 2, slot 3 (moving back) takes 1.
    expect(order(5, { 0: 2, 3: -1 })).toEqual([1, 3, 0, 2, 4]);
  });

  it("swaps neighbours", () => {
    expect(order(4, { 1: 1, 2: -1 })).toEqual([0, 2, 1, 3]);
  });

  it("always yields a permutation that keeps unmoved slots in order", () => {
    const next = random(5);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(next(0, 10));
      const offsets: Record<number, number> = {};
      for (let i = 0; i < n; i++) if (next(0, 1) < 0.3) offsets[i] = Math.round(next(-n, n));
      const result = order(n, offsets);
      expect([...result].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      const unmoved = result.filter((slot) => !offsets[slot]);
      expect(unmoved).toEqual([...unmoved].sort((a, b) => a - b));
    }
  });

  it("the skeleton applies animation offsets and bumps the version only on change", () => {
    const skeleton = new Skeleton(testDocument({ ...outfitSections, drawOrder: ["torso", "torso_cloth", "hair", "cape"] }));
    skeleton.updateWorldTransform();
    const names = () => skeleton.drawOrder.map((slot) => slot.data.name);
    expect(names()).toEqual(["torso", "torso_cloth", "hair", "cape"]);
    const version = skeleton.drawOrderVersion;
    skeleton.drawOrderOffsets[skeleton.getSlot("cape").index] = -3;
    skeleton.updateWorldTransform();
    expect(names()).toEqual(["cape", "torso", "torso_cloth", "hair"]);
    expect(skeleton.drawOrderVersion).toBe(version + 1);
    skeleton.updateWorldTransform();
    expect(skeleton.drawOrderVersion).toBe(version + 1);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();
    expect(names()).toEqual(["torso", "torso_cloth", "hair", "cape"]);
    expect(skeleton.drawOrderVersion).toBe(version + 2);
  });

  it("slots missing from the document's draw order are drawn last, in slot order", () => {
    const skeleton = new Skeleton(testDocument({ ...outfitSections, drawOrder: ["hair", "torso"] }));
    expect(skeleton.drawOrder.map((slot) => slot.data.name)).toEqual(["hair", "torso", "cape", "torso_cloth"]);
  });
});

describe("anchored slots (schema and reference checks)", () => {
  const doc = (slots: NonNullable<Sections["slots"]>, drawOrder?: NonNullable<Sections["drawOrder"]>) =>
    parseAnimDocument({
      format: "atlas-anim@1",
      name: "t",
      canvas: { width: 1, height: 1, originX: 0, originY: 0 },
      bones: [{ name: "root" }],
      slots,
      ...(drawOrder ? { drawOrder } : {}),
      driven: [{ name: "d", bone: "root", keys: [{ at: 0, drawOrder: [{ slot: "cloth", offset: 1 }] }] }]
    });
  const messages = (result: ReturnType<typeof doc>) =>
    result.ok ? result.warnings.map(formatIssue) : result.issues.map(formatIssue);

  it("accepts drawAfter or drawBefore and warns that offsets on anchored slots are ignored", () => {
    const result = doc([
      { name: "torso", bone: "root" },
      { name: "cloth", bone: "root", drawAfter: "torso" },
      { name: "cape", bone: "root", drawBefore: "torso" }
    ]);
    expect(result.ok).toBe(true);
    expect(messages(result)).toEqual([
      "warning: driven[0].keys[0].drawOrder[0].slot: 'cloth' is anchored (drawAfter/drawBefore) and moves with its anchor; this offset is ignored"
    ]);
  });

  it("rejects both anchors, unknown anchors, self anchors and anchor cycles", () => {
    const result = doc([
      { name: "torso", bone: "root", drawAfter: "torso" },
      { name: "cloth", bone: "root", drawAfter: "nowhere" },
      { name: "a", bone: "root", drawAfter: "b" },
      { name: "b", bone: "root", drawBefore: "a" }
    ]);
    expect(messages(result).filter((m) => !m.startsWith("warning"))).toEqual([
      "slots[0].drawAfter: slot 'torso' cannot be anchored to itself",
      "slots[1].drawAfter: unknown slot 'nowhere'",
      "slots[2].drawAfter: anchor chain from 'a' loops back to it (a -> b -> a)",
      "slots[3].drawBefore: anchor chain from 'b' loops back to it (b -> a -> b)"
    ]);
    const both = doc([
      { name: "torso", bone: "root" },
      { name: "cloth", bone: "root", drawAfter: "torso", drawBefore: "torso" }
    ]);
    expect(messages(both)).toEqual(["slots[1].drawBefore: give at most one of 'drawAfter' and 'drawBefore'"]);
  });
});
