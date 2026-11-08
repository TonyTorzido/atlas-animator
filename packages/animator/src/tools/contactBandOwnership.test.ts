import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { checkPoseLimits, type ValidationIssue } from "./validate.js";
import { sampleClip } from "./liveLimits.js";

/*
 * Plan part c: contact bands follow contour ownership. A band measured between two contours
 * (`contours`) gates a displayed pose only while both draw, so a hidden garment's bands are off.
 */

const fixture = new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url);

function document(tunicShown: boolean, contours?: [string, string], robe = false) {
  const raw = JSON.parse(readFileSync(fixture, "utf8"));
  // A later skin overriding the tunic placeholder (a multi-skin document).
  if (robe) raw.skins.robe = { attachments: { tunic: { tunic: { type: "region", path: "swag/tunic/torso", width: 60, height: 120 } } } };
  if (!tunicShown) for (const s of raw.slots) if (s.name === "tunic") delete s.attachment;
  raw.skins.body.contours = { torso: { side: { mesh: { slot: "torso", attachment: "torso" }, points: [0, 1, 2, 3, 4], width: 3 } } };
  raw.skins.tunic.contours = { tunic: { hem: { mesh: { skin: "body", slot: "torso", attachment: "torso" }, points: [5, 6, 7, 8, 9], width: 3, owner: { slot: "tunic", attachment: "tunic" } } } };
  raw.contactBands = [{ name: "hem_side", x: "chest", y: "hips", size: [4, 4], cells: [[0, 0]], ...(contours ? { contours } : {}) }];
  raw.animations = { still: { duration: 0.1, bones: {} } };
  return loadAnimDocument(raw);
}

const contactErrors = (doc: ReturnType<typeof document>) => {
  const issues: ValidationIssue[] = [];
  checkPoseLimits(doc, issues);
  return issues.filter((i) => i.check === "contacts").length;
};

describe("contact bands follow contour ownership (part c)", () => {
  it("fires while both contours draw, not with the owning garment hidden", () => {
    expect(contactErrors(document(true, ["tunic/hem", "torso/side"]))).toBe(1);
    expect(contactErrors(document(false, ["tunic/hem", "torso/side"]))).toBe(0);
  });
  it("a band without a contour pair keeps gating (older documents)", () => {
    expect(contactErrors(document(false))).toBe(1);
  });
});

describe("contact-band ownership per outfit, live and batch", () => {
  it("an overridden garment's band still gates in the outfit that shows it", () => {
    expect(contactErrors(document(true, ["tunic/hem", "torso/side"], true))).toBe(1);
  });
  it("live authoring skips a hidden garment's band and keeps a shown one", () => {
    expect(sampleClip(document(false, ["tunic/hem", "torso/side"]), "still", [0])[0]?.contacts).toEqual([]);
    expect(sampleClip(document(true, ["tunic/hem", "torso/side"]), "still", [0])[0]?.contacts).toEqual(["hem_side"]);
    expect(sampleClip(document(true, ["tunic/hem", "torso/side"], true), "still", [0])[0]?.contacts).toEqual(["hem_side"]);
  });
});
