import { describe, expect, it } from "vitest";
import { arcStats, arcTangent, arcTargetSpec, classifyStep, parseArcTarget, stepColor, type ArcPoint } from "./arcModel.js";
import { standInAxePixels, withStandInWeapon } from "./standInWeapon.js";

const line = (n: number, step = 10): ArcPoint[] => Array.from({ length: n }, (_, i) => ({ frame: i, x: i * step, y: 0 }));

describe("arc stats", () => {
  it("reads a straight even line as bulge 0 and no uneven steps", () => {
    const s = arcStats(line(10));
    expect(s.length).toBeCloseTo(90);
    expect(s.bulge).toBeCloseTo(0);
    expect(s.uneven).toEqual([]);
    expect(s.peakRatio).toBeCloseTo(1);
  });
  it("measures the bulge of a semicircle as half the chord", () => {
    const pts: ArcPoint[] = Array.from({ length: 21 }, (_, i) => {
      const a = Math.PI * (i / 20);
      return { frame: i, x: 100 - Math.cos(a) * 100, y: -Math.sin(a) * 100 };
    });
    expect(arcStats(pts).bulge).toBeCloseTo(0.5, 1);
  });
  it("flags holds and fast steps against the median", () => {
    const xs = [0, 10, 20, 20.5, 21, 60, 70, 80];
    const s = arcStats(xs.map((x, i) => ({ frame: i, x, y: 0 })));
    expect(s.classes[2]).toBe("hold");
    expect(s.classes[4]).toBe("fast");
    expect(s.uneven).toEqual([2, 3, 4]);
  });
  it("classifies ratios and colours them", () => {
    expect(classifyStep(0.05)).toBe("hold");
    expect(classifyStep(0.4)).toBe("slow");
    expect(classifyStep(1)).toBe("even");
    expect(classifyStep(2.5)).toBe("fast");
    expect(stepColor(0)).not.toBe(stepColor(2.4));
  });
  it("gives the tangent and handles a stationary point", () => {
    expect(arcTangent(line(5), 2)).toEqual({ x: 1, y: 0 });
    expect(arcTangent([{ frame: 0, x: 1, y: 1 }, { frame: 1, x: 1, y: 1 }], 0)).toBeNull();
  });
  it("round-trips target specs", () => {
    for (const spec of ["bone:hand_r", "tip:forearm_r", "point:weapon_tip"]) expect(arcTargetSpec(parseArcTarget(spec)!)).toBe(spec);
    expect(parseArcTarget("nope")).toBeNull();
  });
});

describe("stand-in weapon", () => {
  const base = { bones: [{ name: "root" }, { name: "hand_r", parent: "root" }], slots: [{ name: "hand_r", bone: "hand_r" }, { name: "head", bone: "root" }], skins: { body: { attachments: {} } } };
  it("adds a bone, three slots after hand_r and their attachments without touching the input", () => {
    const out = withStandInWeapon(base) as typeof base & { slots: { name: string }[] };
    expect(out.slots.map((s) => s.name)).toEqual(["hand_r", "weapon", "weapon_tip", "weapon_grip", "head"]);
    expect(out.bones.at(-1)).toMatchObject({ name: "weapon", parent: "hand_r" });
    expect(base.slots).toHaveLength(2);
    expect(Object.keys((out.skins.body.attachments as Record<string, unknown>).weapon_grip as object)).toEqual(["grip", "grip2"]);
  });
  it("draws an inked axe with opaque pixels", () => {
    const img = standInAxePixels();
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 255) opaque++;
    expect(img.data.length).toBe(img.width * img.height * 4);
    expect(opaque).toBeGreaterThan(4000);
  });
});
