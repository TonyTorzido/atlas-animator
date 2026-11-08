/*
 * Atlas Animator: original implementation.
 * Stroke clearance rule (redefined): only sub-pixel cracks
 * (< 1 display px at DPR 1) between near-parallel contours count; never at held or end poses; in
 * motion a crack may last at most `transientDegrees` of the moving joint.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { crackStreaks, geometryGates, passThroughHolds, strokeClearance, type ClearanceViolation, type CrackFrame } from "./gates.js";
import type { Pose } from "./correctives.js";
import type { Pt } from "./geometry.js";
import { loadPreset } from "./preset.js";
import { buildRig } from "./output.js";

vi.setConfig({ testTimeout: 180_000 });

// template7: 1 display px at DPR 1 = 1074 / 140 canvas px.
const limit = { maxAngle: 15, minSpan: 3, minGap: 1074 / 140 };
const vertical = (x: number, y0 = 0, y1 = 100): Pt[] => [
  [x, y0],
  [x, y1]
];
const pair = (a: Pt[], b: Pt[]) => [
  { key: "arm/outline", points: a, width: 10 },
  { key: "tank/edge", points: b, width: 12 }
];

describe("strokeClearance", () => {
  it("flags a sub-pixel parallel slit of background between two strokes", () => {
    // Centre distance 14: inks 5 + 6 wide on each side leave a 3 canvas px slit (0.39 display px).
    const v = strokeClearance(pair(vertical(0), vertical(14)), limit);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.maxGap).toBeCloseTo(3, 1);
    expect(v[0]?.span).toBeGreaterThan(90);
  });

  it("flags a lens where a bulging stroke nearly touches a straight one", () => {
    // The shrug-down lens: a bowed edge 0.5..3.8 canvas px of background from the flank over ~50 px.
    const bow: Pt[] = Array.from({ length: 41 }, (_, i) => {
      const y = 890 + i * 2.5;
      const t = (y - 922) / 30;
      return [430 - 11 - 3.8 + 3.3 * Math.min(1, t * t), y] as Pt;
    });
    const v = strokeClearance(pair(bow, vertical(430, 860, 1010)), limit);
    expect(v.some((x) => x.maxGap < 4 && x.span >= 40)).toBe(true);
  });

  it("passes overlapping strokes, a gap of one display px or more, and a diverging wedge", () => {
    expect(strokeClearance(pair(vertical(0), vertical(8)), limit)).toEqual([]);
    // 8 canvas px of background (> 7.67): clean background, not a crack.
    expect(strokeClearance(pair(vertical(0), vertical(11 + 8)), limit)).toEqual([]);
    // Two strokes leaving a junction at 34 degrees: not near-parallel.
    const t = Math.tan((34 * Math.PI) / 180);
    expect(strokeClearance(pair([[0, 0], [-100 * t, 100]], vertical(0)), limit)).toEqual([]);
  });

  it("passes a gap whose middle lies on a mesh (a limb drawn over the body is not a slit)", () => {
    expect(strokeClearance(pair(vertical(0), vertical(14)), limit, () => true)).toEqual([]);
  });
});

describe("overlap seams (alpha in motion)", () => {
  it("collects near-parallel inks overlapping by less than one display px, not deeper overlaps or crossings", () => {
    const seamsOf = (a: Pt[], b: Pt[], covered = () => false) => {
      const seams: Pt[] = [];
      strokeClearance(pair(a, b), limit, covered, 1.5, [], seams);
      return seams;
    };
    // Centre distance 9: inks 5 + 6 overlap by 2 canvas px (0.26 display px): a seam.
    expect(seamsOf(vertical(0), vertical(9)).length).toBeGreaterThan(50);
    // Overlap 11 - 2 = 9 canvas px (> 7.67): solid ink, no seam.
    expect(seamsOf(vertical(0), vertical(2))).toEqual([]);
    // A seam over a mesh is no background seam.
    expect(seamsOf(vertical(0), vertical(9), () => true)).toEqual([]);
    const t = Math.tan((34 * Math.PI) / 180);
    expect(seamsOf([[0, 0], [-100 * t, 100]], vertical(0))).toEqual([]);
  });
});

describe("pass-through ranges (gates.clearance.passThrough)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const preset = loadPreset(resolve(here, "../../../fixtures/canonical/template7-shoulder.preset.json"));
  const combo = (elbow: number): Record<string, Pose[]> => ({
    raise_shrug_down_elbow40: [-15, -12, -9, 105].map((r) => ({ clavicle_l: -12, forearm_l: elbow, upper_arm_l: r }))
  });
  // template7 withdrew its declaration with the arm root under the tank (3d-1 fix); the mechanism stays, tested on the old range as data.
  const range = { joint: "forearm_l", range: [34, 39] as [number, number], at: { upper_arm_l: -15, clavicle_l: -12 } };
  const only: typeof preset = { ...preset, gates: { ...preset.gates, clearance: { maxAngle: 15, minSpan: 3, displayPx: 1, transientDegrees: 6, passThrough: [range] } }, sweeps: preset.sweeps.filter((s) => s.name === "raise_shrug_down_elbow40") };

  it("template7 declares no pass-through range (withdrawn); the old range holds the elbow at 40, outside it", () => {
    expect(preset.gates?.clearance?.passThrough).toBeUndefined();
    expect(only.sweeps[0]?.hold?.forearm_l).toBe(40);
    expect(passThroughHolds(only, combo(40))).toEqual([]);
  });

  it("errors when a sweep's held end pose falls inside a pass-through range", () => {
    const v = passThroughHolds(only, combo(35));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/raise_shrug_down_elbow40 frame 0 \(hold\): forearm_l 35 in pass-through \[34, 39\]/);
  });

  it("errors on a declared hold inside the range; motion frames and other poses pass", () => {
    const declared = structuredClone(only);
    const cl = declared.gates?.clearance;
    if (!cl) throw new Error("template7 declares gates.clearance");
    cl.holds = [{ upper_arm_l: -15, clavicle_l: -12, forearm_l: 36 }, { upper_arm_l: -15, forearm_l: 36 }];
    const v = passThroughHolds(declared, combo(40));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^declared hold 0/);
    // Frame 1 (raise -12) is motion, and raise -12 is not the declared pose anyway: a sweep through the range passes.
    expect(passThroughHolds(only, { raise_shrug_down_elbow40: [{ clavicle_l: -12, forearm_l: 0, upper_arm_l: -15 }, { clavicle_l: -12, forearm_l: 36, upper_arm_l: -15 }, { clavicle_l: -12, forearm_l: 70, upper_arm_l: -15 }] })).toEqual([]);
  });
});

describe("crackStreaks (time cap in motion)", () => {
  const crack: ClearanceViolation = { a: "arm/outline", b: "tank/edge", span: 40, maxGap: 3, minGap: 0.1, at: "x" };
  const sweep = (cracked: number[], step = 2, holds: number[] = []): CrackFrame[] =>
    Array.from({ length: 12 }, (_, f) => ({ pose: { upper_arm_l: -15 + f * step }, hold: f === 0 || f === 11 || holds.includes(f), crack: cracked.includes(f) ? crack : null }));

  it("measures a pass-through in degrees of the moving joint", () => {
    const s = crackStreaks(sweep([3, 4]));
    expect(s).toHaveLength(1);
    expect(s[0]?.frames).toBe(2);
    expect(s[0]?.degrees).toBe(4);
    expect(crackStreaks(sweep([3, 4, 5, 6], 2))[0]?.degrees).toBe(8);
  });

  it("splits streaks at frames without a crack and leaves held frames to the hold check", () => {
    expect(crackStreaks(sweep([2, 3, 6]))).toHaveLength(2);
    // A crack at a held or end frame is not a transient: it fails the hold check instead.
    expect(crackStreaks(sweep([0, 11, 5], 2, [5]))).toEqual([]);
  });
});

describe("clearance on template7 (reverted geometry)", () => {
  it("fails when a lens persists at a hold: the old elbow-35 shrug-down hold and the margin-6 head limits", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "../../../fixtures/canonical/template7-shoulder.preset.json");
    const preset = loadPreset(path);
    // (Shrug range +-6 since: the shrug-down hold, and so the pass-through point, is clavicle -6.)
    // Revert: the held elbow inside the 34..39 degree pass-through of the hand past the flank, and
    // the head limits that let the forearm end raise_shrug_up a sub-pixel crack from the tank strap.
    preset.sweeps = preset.sweeps.map((s) => (s.name === "raise_shrug_down_elbow40" ? { ...s, name: "raise_shrug_down_elbow35", hold: { ...s.hold, forearm_l: 35 } } : s));
    preset.sweeps.push({ name: "lens_hold", hold: { clavicle_l: -3 }, phases: [{ bone: "upper_arm_l", from: -5, to: -5, step: 1 }] });
    preset.poseLimits = (preset.poseLimits ?? []).filter((l) => !l.name.startsWith("forearm_")).map((l) => (l.auto ? { ...l, auto: { ...l.auto, margin: 6 } } : l));
    preset.gates = { ...preset.gates, clearance: { maxAngle: 15, minSpan: 3, displayPx: 1, transientDegrees: 6, passThrough: [{ joint: "forearm_l", range: [34, 39], at: { upper_arm_l: -15, clavicle_l: -6 } }] } };
    const geo = geometryGates(buildRig(preset, dirname(path)));
    const at = geo.clearance.violations.map((v) => v.at);
    // Under the +-6 shrug range the reverted elbow-35 hold no longer reaches the flank lens (it formed at
    // shrug -12); the gate must still catch a lens held inside the forearm/flank contact band, measured
    // at raise -5 / shrug -3 (gap ~0.5 canvas px), so that hold is added to the reverted preset.
    expect(at.some((a) => a.startsWith("lens_hold frame 0 (hold)"))).toBe(true);
    // (The margin-6 lens at raise_shrug_up frame 38 no longer forms: with the sandwich the arm outline
    // starts under the strap trim, which the clearance measure now reaches first; the limits stay.)
    // The declared pass-through flags the reverted hold on its own (data, before any crack is measured).
    expect(geo.clearance.passThroughHolds.some((h) => h.startsWith("raise_shrug_down_elbow35 frame 0 (hold): forearm_l 35"))).toBe(true);
    // No time cap since (stepped playback holds every shown frame): this reverted preset declares
    // no contact band, so the same contacts in motion fail as well; a declared band would make them
    // crossings (the canonical preset declares them).
    expect(geo.clearance.violations.some((v) => !v.at.includes("(hold)"))).toBe(true);
    expect(geo.clearance.contactCrossings).toBe(0);
  });
});
