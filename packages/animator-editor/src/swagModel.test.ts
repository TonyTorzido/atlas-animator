import { readFileSync } from "node:fs";
import { loadAnimDocument, type AnimDocument, type AttachmentData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { ALL_OUTFITS } from "./fixtures.js";
import { resolveActive, activeHides, setSkinAttachment, tintedAttachment, SKIN_NAME } from "./skinModel.js";
import {
  checkItem,
  createItemSkin,
  ITEM_SLOT_MAP,
  ITEM_SLOTS,
  itemCoverage,
  itemSkinName,
  itemSkins,
  missingRigSlots,
  NEW_RIG_SLOTS,
  parseItemSkin,
  PIECE_SIZE_TOLERANCE,
  PIVOT_DRIFT_TOLERANCE_PX,
  rigSlotsOf
} from "./swagModel.js";

const load = (id: string): AnimDocument => {
  const o = ALL_OUTFITS.find((x) => x.id === id)!;
  return loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${o.document}`, import.meta.url), "utf8")));
};
const turned = load("pro-turned");
const BASE = Object.keys(turned.skins)[0]!;

/** A chest item in both views: the base torso piece, tinted. */
function withChest(doc: AnimDocument, name: string, scale = 1): AnimDocument {
  const torso = doc.skins[BASE]!.attachments.shirt_torso!.torso as AttachmentData;
  const piece = { ...tintedAttachment(torso, "d9482bff"), width: (torso as { width: number }).width * scale, height: (torso as { height: number }).height * scale } as AttachmentData;
  const skins = setSkinAttachment(createItemSkin(doc.skins, "chest", name.split(".")[1]!), name, "shirt_torso", "torso", piece);
  return { ...doc, skins };
}

describe("naming", () => {
  it("builds and parses <slot>.<item>, valid as a skin name", () => {
    const n = itemSkinName("chest", "red-jerkin");
    expect(n).toBe("chest.red-jerkin");
    expect(SKIN_NAME.test(n)).toBe(true);
    expect(parseItemSkin(n)).toEqual({ slot: "chest", item: "red-jerkin" });
    for (const s of ITEM_SLOTS) expect(parseItemSkin(`${s}.x1`)?.slot).toBe(s);
  });
  it("rejects bad slots, ids and the base skin", () => {
    expect(() => itemSkinName("chest", "bad name")).toThrow();
    expect(() => itemSkinName("chest", "")).toThrow();
    expect(() => itemSkinName("chest", "a.b")).toThrow();
    expect(() => itemSkinName("tail" as never, "x")).toThrow();
    expect(parseItemSkin("body")).toBeNull();
    expect(parseItemSkin("tail.x")).toBeNull();
    expect(parseItemSkin("chest.")).toBeNull();
  });
  it("lists item skins of a document", () => {
    const shipped = itemSkins(turned.skins).map((s) => s.name); // the pro rig ships the leather chest skin
    expect([...shipped].sort()).toEqual(["chest.jacket_b", "chest.leather"]); // listed in document order, which the rig sync may change
    expect(itemSkins(withChest(turned, "chest.a").skins).map((s) => s.name).sort()).toEqual([...shipped, "chest.a"].sort());
  });
});

describe("the shipped mesh-arm chest items", () => {
  it("raise no stray, hide or side warnings in the turned view (and no size warning on the leather chest)", () => {
    for (const skin of ["chest.leather", "chest.jacket_b"]) {
      expect(checkItem(turned, skin).filter((i) => ["stray piece", "size", "hides", "wrong side", "placeholder", "missing piece"].includes(i.kind)), skin).toEqual([]);
    }
  });
  it("still flags a skin arm that is not on its own side, and a stray old-rig slot", () => {
    const near = turned.skins["chest.leather"]!;
    const bad = { ...turned.skins, "chest.x": { ...near, attachments: { ...near.attachments, shirt_upper_arm_near: near.attachments["shirt_sleeve_near"]! } } };
    expect(checkItem({ ...turned, skins: bad }, "chest.x").some((i) => i.kind === "stray piece" && i.slot === "shirt_upper_arm_near")).toBe(true);
  });
});

describe("slot map against the real pro rigs", () => {
  it("every 'existing' rig slot exists in both pro rigs; every 'added' slot exists in neither", () => {
    for (const doc of [turned]) {
      const have = new Set(doc.slots.map((s) => s.name));
      for (const s of ITEM_SLOTS) {
        for (const n of ITEM_SLOT_MAP[s].existing) expect(have.has(n), `${s}: ${n}`).toBe(true);
        for (const n of ITEM_SLOT_MAP[s].added) expect(have.has(n), `${s}: ${n}`).toBe(false);
      }
      expect(missingRigSlots(doc)).toEqual([...NEW_RIG_SLOTS]);
    }
  });
  it("required pieces are owned by their slot", () => {
    for (const s of ITEM_SLOTS) for (const r of ITEM_SLOT_MAP[s].required) expect(rigSlotsOf(s)).toContain(r);
  });
});

describe("helmet hides hair", () => {
  it("createItemSkin sets the hides, and they resolve through activeHides", () => {
    const skins = createItemSkin(turned.skins, "helmet", "iron");
    expect(skins["helmet.iron"]!.hides.sort()).toEqual(["hair_back", "hair_front"]);
    expect(activeHides(skins, [BASE, "helmet.iron"]).sort()).toEqual(["hair_back", "hair_front"]);
    expect(activeHides(createItemSkin(turned.skins, "chest", "a"), [BASE, "chest.a"])).toEqual([]);
  });
});

describe("itemCoverage", () => {
  it("reports a chest missing in the view that lacks it", () => {
    const t = { ...turned, skins: createItemSkin(turned.skins, "chest", "a") };
    const cov = itemCoverage(t, "chest.a");
    expect(cov.turned.missing).toEqual(["shirt_torso"]);
    expect(cov.complete).toBe(false);
    expect(itemCoverage(withChest(turned, "chest.a"), "chest.a").complete).toBe(true);
  });
  it("marks an absent skin, a rig lacking the slot, and stray pieces", () => {
    expect(itemCoverage(turned, "chest.a").turned.absent).toBe(true);
    const helm = itemCoverage(turned, "helmet.iron");
    expect(helm.turned.noRigSlot).toEqual(["helmet"]);
    expect(helm.complete).toBe(false);
    const stray = setSkinAttachment(createItemSkin(turned.skins, "chest", "a"), "chest.a", "weapon", "w", { type: "point", x: 0, y: 0 } as AttachmentData);
    expect(itemCoverage({ ...turned, skins: stray }, "chest.a").turned.stray).toEqual(["weapon"]);
  });
  it("throws on a non-item name", () => {
    expect(() => itemCoverage(turned, "body")).toThrow();
  });
});

describe("checkItem", () => {
  it("a tinted copy of the base piece is clean", () => {
    expect(checkItem(withChest(turned, "chest.a"), "chest.a")).toEqual([]);
  });
  it("flags size beyond the tolerance and accepts just inside", () => {
    const inside = 1 + PIECE_SIZE_TOLERANCE - 0.01;
    expect(checkItem(withChest(turned, "chest.a", inside), "chest.a")).toEqual([]);
    const issues = checkItem(withChest(turned, "chest.a", 1 + PIECE_SIZE_TOLERANCE + 0.05), "chest.a");
    expect(issues.filter((i) => i.kind === "size").map((i) => i.view)).toContain("turned");
  });
  it("allows a chest mesh to extend above the neck line (collar), however it is skinned, but not genuinely oversized art", () => {
    const sized = (skin: string, w: number, h: number, bones: string[]): AnimDocument => {
      const base = turned.skins[BASE]!.attachments.shirt_torso!.torso as AttachmentData & { width: number; height: number };
      const piece = { ...base, width: Math.round(base.width * w), height: Math.round(base.height * h), bones } as AttachmentData;
      return { ...turned, skins: setSkinAttachment(createItemSkin(turned.skins, "chest", skin), `chest.${skin}`, "shirt_torso", "torso", piece) };
    };
    const sizeIssues = (doc: AnimDocument, skin: string) => checkItem(doc, `chest.${skin}`).filter((i) => i.kind === "size");
    expect(sizeIssues(sized("n", 1, 1.28, ["chest", "neck"]), "n")).toEqual([]); // jacket_b-like: 128% tall, covers the neck
    expect(sizeIssues(sized("m", 1, 1.28, ["chest"]), "m")).toEqual([]); // the synced Jacket B collar is skinned to chest and clavicles (no neck bone): same allowance
    expect(sizeIssues(sized("p", 1, 1.6, ["chest"]), "p").length).toBeGreaterThan(0); // still oversized without the neck bone
    expect(sizeIssues(sized("o", 1, 1.6, ["chest", "neck"]), "o").length).toBeGreaterThan(0); // oversized even after the allowance
    expect(sizeIssues(sized("w", 1.3, 1, ["chest", "neck"]), "w").length).toBeGreaterThan(0); // width is never relaxed
  });
  it("flags pivot drift of a region piece", () => {
    const strap = turned.skins[BASE]!.attachments.shirt_strap_near!.fore_up as AttachmentData & { x: number };
    const skins = setSkinAttachment(createItemSkin(turned.skins, "chest", "a"), "chest.a", "shirt_strap_near", "fore_up", { ...strap, x: strap.x + PIVOT_DRIFT_TOLERANCE_PX + 5 } as AttachmentData);
    const issues = checkItem({ ...turned, skins }, "chest.a");
    expect(issues.some((i) => i.kind === "pivot drift" && i.slot === "shirt_strap_near" && i.view === "turned")).toBe(true);
  });
  it("flags a piece on the wrong side's bone", () => {
    const strap = turned.skins[BASE]!.attachments.shirt_strap_near!.fore_up as AttachmentData;
    const skins = setSkinAttachment(createItemSkin(turned.skins, "chest", "a"), "chest.a", "shirt_strap_near", "fore_up", strap);
    const bad = { ...turned, skins, slots: turned.slots.map((s) => (s.name === "shirt_strap_near" ? { ...s, bone: "upper_arm_far" } : s)) } as AnimDocument;
    expect(checkItem(bad, "chest.a").some((i) => i.kind === "wrong side")).toBe(true);
  });
  it("flags a helmet that forgets to hide the hair, and a chest that hides something", () => {
    const withSlot = (doc: AnimDocument): AnimDocument => ({ ...doc, slots: [...doc.slots, { name: "helmet", bone: "head", attachment: null } as never] });
    const f = withSlot(turned);
    const bareHelm = setSkinAttachment({ ...f.skins, "helmet.iron": { attachments: {}, hides: [], bones: [], constraints: [] } } as never, "helmet.iron", "helmet", "h", { type: "point", x: 0, y: 0 } as AttachmentData);
    expect(checkItem({ ...f, skins: bareHelm }, "helmet.iron").filter((i) => i.kind === "hides").map((i) => i.slot).sort()).toEqual(["hair_back", "hair_front"]);
    const good = setSkinAttachment(createItemSkin(f.skins, "helmet", "iron"), "helmet.iron", "helmet", "h", { type: "point", x: 0, y: 0 } as AttachmentData);
    expect(checkItem({ ...f, skins: good }, "helmet.iron")).toEqual([]);
    const hidingChest = createItemSkin(turned.skins, "chest", "a");
    hidingChest["chest.a"]!.hides = ["eyes"];
    expect(checkItem({ ...turned, skins: hidingChest }, "chest.a").some((i) => i.kind === "hides" && i.slot === "eyes")).toBe(true);
  });
  it("flags a missing required piece and a bad name", () => {
    const f = { ...turned, skins: createItemSkin(turned.skins, "chest", "a") };
    expect(checkItem(f, "chest.a").some((i) => i.kind === "missing piece" && i.slot === "shirt_torso" && i.view === "turned")).toBe(true);
    expect(checkItem(turned, "body")[0]!.kind).toBe("name");
  });
  it("resolves like any skin (the item wins over the base)", () => {
    const doc = withChest(turned, "chest.a");
    expect(resolveActive(doc.skins, [BASE, "chest.a"]).find((r) => r.slot === "shirt_torso")!.skin).toBe("chest.a");
  });
});
