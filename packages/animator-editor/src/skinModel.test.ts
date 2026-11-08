import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton, type AttachmentData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { ALL_OUTFITS } from "./fixtures.js";
import {
  activeHides,
  activeList,
  baseSkin,
  copySkinAttachment,
  createSkin,
  deleteSkin,
  duplicateSkin,
  removeSkinAttachment,
  renameSkin,
  renameSkinInDocument,
  resolveActive,
  setSetupPlaceholder,
  setSkinAttachment,
  setSkinHide,
  slotPlaceholderSkins,
  tintedAttachment,
  uniqueSkinName
} from "./skinModel.js";
import { skinsToSpine } from "./skinSpine.js";

const pro = ALL_OUTFITS.find((o) => o.id === "pro-front")!;
const doc = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${pro.document}`, import.meta.url), "utf8")));
const BASE = baseSkin(doc.skins)!;

/** The demo outfit: the base shirt, tinted. */
const withShirt = () => {
  const shirt = doc.skins[BASE]!.attachments.shirt_torso!.torso as AttachmentData;
  return setSkinAttachment(createSkin(doc.skins, "test-shirt"), "test-shirt", "shirt_torso", "torso", tintedAttachment(shirt, "d9482bff"));
};

describe("skin list", () => {
  it("creates, duplicates, renames and deletes without touching the input", () => {
    const before = JSON.stringify(doc.skins);
    const existing = Object.keys(doc.skins); // the rig may ship more skins than the base (chest.leather)
    let skins = createSkin(doc.skins, "leather");
    expect(Object.keys(skins)).toEqual([...existing, "leather"]);
    skins = duplicateSkin(skins, "leather", "leather-2");
    expect(Object.keys(skins)).toEqual([...existing, "leather", "leather-2"]);
    skins = renameSkin(skins, "leather-2", "plate");
    expect(Object.keys(skins)).toEqual([...existing, "leather", "plate"]);
    skins = deleteSkin(skins, "plate");
    expect(Object.keys(skins)).toEqual([...existing, "leather"]);
    expect(JSON.stringify(doc.skins)).toBe(before);
  });
  it("refuses bad names, repeats, deleting the last skin, and unknown skins", () => {
    expect(() => createSkin(doc.skins, "bad name")).toThrow(/bad name/);
    expect(() => createSkin(doc.skins, BASE)).toThrow(/exists/);
    expect(() => deleteSkin({ [BASE]: doc.skins[BASE]! }, BASE)).toThrow(/at least one/);
    expect(() => renameSkin(doc.skins, "nope", "x")).toThrow(/no skin/);
    expect(uniqueSkinName(doc.skins, BASE)).toBe(`${BASE}-2`);
  });
  it("keeps the base first through a rename and follows linked mesh references", () => {
    const linked = { type: "linkedMesh", source: { skin: BASE, slot: "shirt_torso", attachment: "torso" } } as unknown as AttachmentData;
    let skins = setSkinAttachment(createSkin(doc.skins, "tunic"), "tunic", "shirt_torso", "torso", linked);
    expect(() => deleteSkin(skins, BASE)).toThrow(/used by tunic/);
    skins = renameSkin(skins, BASE, "naked");
    expect(Object.keys(skins)[0]).toBe("naked");
    expect((skins.tunic!.attachments.shirt_torso!.torso as { source: { skin: string } }).source.skin).toBe("naked");
  });
  it("renames document-level references too", () => {
    const next = renameSkinInDocument(doc, BASE, "naked");
    expect(Object.keys(next.skins)[0]).toBe("naked");
    expect(next.slots).toEqual(doc.slots);
  });
  it("a copy of a skin points its own references at itself", () => {
    const linked = { type: "linkedMesh", source: { skin: "tunic", slot: "a", attachment: "b" } } as unknown as AttachmentData;
    const skins = setSkinAttachment(createSkin(doc.skins, "tunic"), "tunic", "shirt_torso", "torso", linked);
    const copy = duplicateSkin(skins, "tunic", "tunic-2");
    expect((copy["tunic-2"]!.attachments.shirt_torso!.torso as { source: { skin: string } }).source.skin).toBe("tunic-2");
  });
});

describe("attachments per slot", () => {
  it("adds, copies and removes a placeholder; an emptied slot entry goes", () => {
    let skins = copySkinAttachment(createSkin(doc.skins, "t"), BASE, "pants_waist", "pants", "t");
    expect(Object.keys(skins.t!.attachments)).toEqual(["pants_waist"]);
    skins = copySkinAttachment(skins, BASE, "pants_waist", "pants", "t", "pants_short");
    expect(Object.keys(skins.t!.attachments.pants_waist!)).toEqual(["pants", "pants_short"]);
    skins = removeSkinAttachment(removeSkinAttachment(skins, "t", "pants_waist", "pants"), "t", "pants_waist", "pants_short");
    expect(skins.t!.attachments).toEqual({});
    expect(() => removeSkinAttachment(skins, "t", "pants_waist", "pants")).toThrow(/has no/);
  });
  it("lists which skins define each placeholder of a slot", () => {
    const skins = withShirt();
    const entries = [...slotPlaceholderSkins(skins, "shirt_torso")];
    expect(entries.map(([placeholder]) => placeholder)).toEqual(["torso"]);
    const defining = entries[0]![1];
    expect(defining[0]).toBe(BASE);
    expect(defining[defining.length - 1]).toBe("test-shirt");
    expect(defining.every((name) => skins[name]!.attachments.shirt_torso?.torso)).toBe(true);
  });
  it("tints region and mesh colours, leaves points", () => {
    expect((tintedAttachment(doc.skins[BASE]!.attachments.shirt_torso!.torso as AttachmentData, "d9482bff") as { color: string }).color).toBe("d9482bff");
    const point = { type: "point", x: 1, y: 2, rotation: 0 } as unknown as AttachmentData;
    expect(tintedAttachment(point, "ff0000ff")).toEqual(point);
  });
  it("hide lists add and remove", () => {
    const skins = setSkinHide(createSkin(doc.skins, "helm"), "helm", "hair_back", true);
    expect(skins.helm!.hides).toEqual(["hair_back"]);
    expect(setSkinHide(skins, "helm", "hair_back", false).helm!.hides).toEqual([]);
  });
  it("sets the setup placeholder of a slot", () => {
    const slots = setSetupPlaceholder(doc.slots, "shirt_strap_near", "fore_up");
    expect(slots.find((s) => s.name === "shirt_strap_near")!.attachment).toBe("fore_up");
    expect(setSetupPlaceholder(slots, "shirt_strap_near", null).find((s) => s.name === "shirt_strap_near")!.attachment).toBeNull();
    expect(doc.slots.find((s) => s.name === "shirt_strap_near")!.attachment).toBeNull();
    expect(() => setSetupPlaceholder(doc.slots, "nope", null)).toThrow(/no slot/);
  });
});

describe("active skins (base + mix)", () => {
  it("lists the base first, then mixed layers, then the worn skin, without repeats", () => {
    const skins = createSkin(createSkin(doc.skins, "a"), "b");
    expect(activeList(skins, null)).toEqual([BASE]);
    expect(activeList(skins, "a", ["b"])).toEqual([BASE, "b", "a"]);
    expect(activeList(skins, BASE, ["a", "a", "gone"])).toEqual([BASE, "a"]);
  });
  it("later skins win a placeholder and report what they cover; hides union", () => {
    const skins = setSkinHide(withShirt(), "test-shirt", "hair_back", true);
    const r = resolveActive(skins, [BASE, "test-shirt"]).find((x) => x.slot === "shirt_torso")!;
    expect(r).toEqual({ slot: "shirt_torso", placeholder: "torso", skin: "test-shirt", covers: [BASE] });
    expect(resolveActive(skins, [BASE]).find((x) => x.slot === "shirt_torso")!.skin).toBe(BASE);
    expect(activeHides(skins, [BASE, "test-shirt"])).toEqual(["hair_back"]);
  });
  it("matches what the engine shows for the same list", () => {
    const skins = withShirt();
    const next = { ...doc, skins };
    const sk = new Skeleton(next);
    const red = (): number => {
      const slot = sk.slots.find((s) => s.data.name === "shirt_torso")!;
      return (sk.getAttachment(slot, "torso") as unknown as { color: { r: number } }).color.r;
    };
    sk.setActiveSkins(activeList(skins, null));
    expect(red()).toBeCloseTo(1, 3);
    sk.setActiveSkins(activeList(skins, "test-shirt"));
    expect(red()).toBeCloseTo(0xd9 / 255, 3);
    sk.setActiveSkins(activeList(skins, null));
    expect(red()).toBeCloseTo(1, 3);
  });
});

describe("Spine skin export", () => {
  it("writes the base as default, the others by name, with the same image names and y flip", () => {
    const out = skinsToSpine({ ...doc, skins: withShirt() });
    expect(out.skins.map((s) => s.name)).toEqual(["default", ...Object.keys(doc.skins).slice(1), "test-shirt"]);
    const shirt = (out.skins.find((s) => s.name === "test-shirt")!.attachments as Record<string, Record<string, Record<string, unknown>>>).shirt_torso!.torso!;
    expect(shirt.type).toBe("mesh");
    expect(shirt.color).toBe("d9482bff");
    const baseShirt = (out.skins[0]!.attachments as Record<string, Record<string, Record<string, unknown>>>).shirt_torso!.torso!;
    expect(shirt.path).toBe(baseShirt.path);
    expect(shirt.vertices).toEqual(baseShirt.vertices);
    const eye = (out.skins[0]!.attachments as Record<string, Record<string, Record<string, unknown>>>).eyes!.eyes!;
    const src = doc.skins[BASE]!.attachments.eyes!.eyes as { y: number };
    expect(eye.y ?? 0).toBe(src.y ? -src.y : 0);
    expect(out.images[(doc.skins[BASE]!.attachments.shirt_torso!.torso as { path: string }).path]).toBe(baseShirt.path);
  });
  it("writes linked meshes as 4.3 linkedmesh (source, slot, skin, timelines)", () => {
    const link = (extra: object) => ({ type: "linkedMesh", path: "tunic/torso", source: { skin: BASE, slot: "shirt_torso", attachment: "torso" }, width: 40, height: 50, ...extra }) as unknown as AttachmentData;
    let skins = setSkinAttachment(createSkin(doc.skins, "tunic"), "tunic", "shirt_torso", "torso", link({}));
    skins = setSkinAttachment(skins, "tunic", "other_slot", "torso_copy", link({ inheritDeform: false }));
    const out = skinsToSpine({ ...doc, skins });
    const tunic = out.skins.find((s) => s.name === "tunic")!.attachments as Record<string, Record<string, Record<string, unknown>>>;
    expect(tunic.shirt_torso!.torso).toMatchObject({ type: "linkedmesh", source: "torso", skin: "default", width: 40, height: 50 });
    expect(tunic.shirt_torso!.torso).not.toHaveProperty("slot");
    expect(tunic.shirt_torso!.torso).not.toHaveProperty("timelines");
    expect(tunic.other_slot!.torso_copy).toMatchObject({ source: "torso", slot: "shirt_torso", timelines: false });
    expect(out.warnings.join()).not.toMatch(/linked mesh/);
  });
  it("reports a linked mesh whose source is not a mesh", () => {
    const linked = { type: "linkedMesh", path: "x", source: { skin: BASE, slot: "nope", attachment: "torso" }, width: 1, height: 1 } as unknown as AttachmentData;
    const skins = setSkinAttachment(createSkin(doc.skins, "tunic"), "tunic", "shirt_torso", "torso", linked);
    const out = skinsToSpine({ ...doc, skins });
    expect(out.warnings.join()).toMatch(/linked mesh tunic\/shirt_torso\/torso/);
    expect(out.skins.find((s) => s.name === "tunic")!.attachments).toEqual({});
  });
});
