import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { ALL_OUTFITS } from "./fixtures.js";
import { withEventDefs } from "./eventModel.js";
import { defaultTrack, maskFor, maskedBoneNames, previewSpan, TrackSession, type TrackConfig } from "./trackModel.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const raw = JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")) as unknown;
const doc: AnimDocument = withEventDefs(loadAnimDocument(raw, { source: player.document }));
const clips = structuredClone(doc.animations) as Record<string, ClipData>;
const before = JSON.stringify(doc.animations);

const rotations = (sk: Skeleton) => Object.fromEntries(sk.bones.map((b) => [b.data.name, b.pose.rotation]));
function posed(tracks: TrackConfig[], t: number): Record<string, number> {
  const sk = new Skeleton(doc);
  const s = new TrackSession(doc, clips, tracks);
  s.seek(t);
  s.apply(sk);
  return rotations(sk);
}
const walk = (patch: Partial<TrackConfig> = {}): TrackConfig => ({ ...defaultTrack("walk_in_place"), ...patch });
const legs = (patch: Partial<TrackConfig> = {}): TrackConfig => ({ ...defaultTrack("fk_ik_fk"), loop: false, ...patch });

describe("bone masks", () => {
  it("upper body keeps chest and everything above it, none of the legs", () => {
    const names = maskedBoneNames(doc, maskFor(doc, { mask: "upper", maskBones: [] }));
    expect(names).toEqual(expect.arrayContaining(["chest", "head", "upper_arm_l", "hand_r"]));
    expect(names).not.toContain("thigh_l");
    expect(names).not.toContain("pelvis");
  });
  it("lower body keeps the legs only; none = null; unknown custom bones = null", () => {
    const names = maskedBoneNames(doc, maskFor(doc, { mask: "lower", maskBones: [] }));
    expect(names).toEqual(expect.arrayContaining(["thigh_l", "shin_r", "foot_l"]));
    expect(names).not.toContain("chest");
    expect(maskFor(doc, { mask: "none", maskBones: [] })).toBeNull();
    expect(maskFor(doc, { mask: "custom", maskBones: ["nope"] })).toBeNull();
    expect(maskedBoneNames(doc, maskFor(doc, { mask: "custom", maskBones: ["head"] }))).toContain("head");
  });
});

describe("layered tracks", () => {
  // fk_ik_fk keys the legs and pelvis, walk_in_place the arms, chest and head too.
  it("a masked top track changes only the masked bones, the base shows through the rest", () => {
    const base = posed([legs()], 0.4);
    const layered = posed([legs(), walk({ mask: "upper" })], 0.4);
    const walkOnly = posed([walk()], 0.4);
    expect(layered.thigh_l).toBeCloseTo(base.thigh_l!, 6);
    expect(layered.shin_r).toBeCloseTo(base.shin_r!, 6);
    expect(layered.upper_arm_l).toBeCloseTo(walkOnly.upper_arm_l!, 6);
    expect(layered.chest).toBeCloseTo(walkOnly.chest!, 6);
    expect(Math.abs(layered.upper_arm_l! - base.upper_arm_l!)).toBeGreaterThan(0.5);
  });
  it("alpha mixes between the base and the top track; 0 leaves the base", () => {
    const base = posed([legs()], 0.4);
    const top = posed([walk()], 0.4);
    const half = posed([legs(), walk({ alpha: 0.5 })], 0.4);
    const zero = posed([legs(), walk({ alpha: 0 })], 0.4);
    expect(zero.upper_arm_l).toBeCloseTo(base.upper_arm_l!, 6);
    expect(half.upper_arm_l).toBeCloseTo((base.upper_arm_l! + top.upper_arm_l!) / 2, 3);
  });
  it("crossfades into the second clip: first before, second after, a mix between", () => {
    const track = walk({ then: "diag", thenAt: 0.5, crossfade: 0.4 });
    const diag = (t: number) => posed([{ ...defaultTrack("diag"), loop: false }], t).thigh_l!;
    expect(posed([track], 0.3).thigh_l).toBeCloseTo(posed([walk()], 0.3).thigh_l!, 6);
    const mid = posed([track], 0.7).thigh_l!;
    const ends = [posed([walk()], 0.7).thigh_l!, diag(0.2)];
    expect(mid).toBeGreaterThanOrEqual(Math.min(...ends) - 1e-6);
    expect(mid).toBeLessThanOrEqual(Math.max(...ends) + 1e-6);
    expect(posed([track], 1.3).thigh_l).toBeCloseTo(diag(0.8), 3);
  });
  it("scrubbing backward replays to the same pose as a fresh preview", () => {
    const tracks = [legs(), walk({ mask: "arms", alpha: 0.7 })];
    const sk = new Skeleton(doc);
    const s = new TrackSession(doc, clips, tracks);
    s.seek(1.1);
    s.seek(0.35);
    s.apply(sk);
    expect(rotations(sk)).toEqual(posed(tracks, 0.35));
  });
  it("never changes the edited clip or the document's own animations", () => {
    posed([walk(), legs({ mask: "lower", alpha: 0.5, then: "diag" })], 0.6);
    expect(JSON.stringify(doc.animations)).toBe(before);
    expect(JSON.stringify(clips)).toBe(before);
  });
  it("span covers the longest track including a crossfaded clip", () => {
    expect(previewSpan(clips, [walk()])).toBeCloseTo(0.93333, 4);
    expect(previewSpan(clips, [walk({ then: "diag", thenAt: 0.5, crossfade: 0.4 })])).toBeCloseTo(0.9 + 8, 4);
    expect(previewSpan(clips, [defaultTrack("")])).toBe(0);
  });
});

describe("bone masks on the pro rig", () => {
  const pro = ALL_OUTFITS.find((o) => o.id === "pro-front")!;
  const proDoc: AnimDocument = loadAnimDocument(JSON.parse(readFileSync(new URL(`../../../${pro.document}`, import.meta.url), "utf8")) as unknown, { source: pro.document });
  it("upper body: chest, head, arms; no legs", () => {
    const names = maskedBoneNames(proDoc, maskFor(proDoc, { mask: "upper", maskBones: [] }));
    expect(names).toEqual(expect.arrayContaining(["chest", "head", "clavicle_near", "upper_arm_near", "hand_far"]));
    expect(names).not.toContain("thigh_near");
    expect(names).not.toContain("pelvis");
  });
  it("lower body: both legs only", () => {
    const names = maskedBoneNames(proDoc, maskFor(proDoc, { mask: "lower", maskBones: [] }));
    expect(names).toEqual(expect.arrayContaining(["thigh_near", "shin_far", "foot_near"]));
    expect(names).not.toContain("chest");
    expect(names).not.toContain("upper_arm_near");
  });
  it("arms: clavicles and upper arms of both sides", () => {
    const names = maskedBoneNames(proDoc, maskFor(proDoc, { mask: "arms", maskBones: [] }));
    expect(names).toEqual(expect.arrayContaining(["clavicle_far", "upper_arm_near", "forearm_far"]));
    expect(names).not.toContain("chest");
  });
});
