import { describe, expect, it } from "vitest";
import { clipSchema } from "@atlas-animator/core/core";
import { emptyClip, setRotateKey } from "./clipModel.js";
import { assertWeaponSlot, invert, keySmear, pickByArc, renderSmear, smearTimes, type Affine, type RegionPlacement } from "./smearModel.js";
import { drawOrderAt } from "./slotModel.js";

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const rot = (deg: number, tx = 0, ty = 0): Affine => {
  const r = (deg * Math.PI) / 180;
  return { a: Math.cos(r), b: -Math.sin(r), c: Math.sin(r), d: Math.cos(r), tx, ty };
};
/** A 60 x 12 opaque red bar. */
const bar = (() => {
  const data = new Uint8Array(60 * 12 * 4);
  for (let i = 0; i < 60 * 12; i++) data.set([200, 30, 30, 255], i * 4);
  return { width: 60, height: 12, data };
})();
/** The bar lies along +x from the bone origin. */
const region: RegionPlacement = { x: 30, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 60, height: 12 };
const arc = (n: number, to: number) => Array.from({ length: n }, (_, i) => rot((to * i) / (n - 1)));

describe("smear render", () => {
  const base = { image: bar, region, steps: arc(6, 60), show: rot(60), travel: { x: -Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6) } };
  it("unions six sub-steps into a hull much bigger than one weapon", () => {
    const r = renderSmear(base);
    expect(r.hullPx).toBeGreaterThan(60 * 12 * 2.5);
    expect(r.image.width * r.image.height * 4).toBe(r.image.data.length);
  });
  it("inks the hull with the stock outline colour, opaque, centred on the edge", () => {
    const r = renderSmear(base);
    expect(r.inkPx).toBeGreaterThan(300);
    let ink = 0;
    for (let i = 0; i < r.image.data.length; i += 4) if (r.image.data[i] === 0x3a && r.image.data[i + 1] === 0x10 && r.image.data[i + 2] === 0x01 && r.image.data[i + 3] === 255) ink++;
    expect(ink).toBe(r.inkPx);
    // the corners of the image are empty ground
    expect(r.image.data[3]).toBe(0);
  });
  it("stretches about 15% along the arc and not when asked for none", () => {
    const span = (stretch: number) => {
      const r = renderSmear({ ...base, stretch });
      return Math.hypot(r.image.width, r.image.height);
    };
    expect(span(0.15)).toBeGreaterThan(span(0));
  });
  it("places the region in the show bone's space, unrotated and unscaled", () => {
    const r = renderSmear({ ...base, show: IDENTITY, steps: arc(6, 60), travel: { x: 0, y: 1 } });
    expect(r.region).toMatchObject({ rotation: 0, scaleX: 1, scaleY: 1, width: r.image.width, height: r.image.height });
    // a negligible opaque outline, so the smear trims no body stroke
    expect(r.region.opaque).toHaveLength(6);
    // the bar reaches +x from the origin, so the smear sits mostly to its right
    expect(r.region.x).toBeGreaterThan(0);
  });
  it("needs two sub-steps and refuses a collapsed transform", () => {
    expect(() => renderSmear({ ...base, steps: [IDENTITY] })).toThrow(/two sub-steps/);
    expect(() => invert({ ...IDENTITY, a: 0, d: 0 })).toThrow(/collapsed/);
  });
  it("inverts a transform", () => {
    const m = rot(33, 12, -7);
    const i = invert(m);
    const p = [m.a * 5 + m.b * 9 + m.tx, m.c * 5 + m.d * 9 + m.ty];
    expect(i.a * p[0]! + i.b * p[1]! + i.tx).toBeCloseTo(5);
    expect(i.c * p[0]! + i.d * p[1]! + i.ty).toBeCloseTo(9);
  });
});

describe("smear is a weapon part only", () => {
  it("refuses body, hand and arm slots or bones", () => {
    for (const [slot, bone] of [["hand_r", "hand_r"], ["hand", "hand_l"], ["forearm_r", "forearm_r"], ["torso", "chest"], ["weapon", "hand_r"], ["head", "weapon"]]) expect(() => assertWeaponSlot(slot!, bone!)).toThrow(/weapon slot/);
    expect(() => assertWeaponSlot("weapon", "weapon")).not.toThrow();
  });
  it("keys only the weapon slot's attachment (the smear, then the weapon back) and nothing else", () => {
    let c = emptyClip(1);
    c = setRotateKey(c, "upper_arm_r", 0, 10);
    const before = structuredClone(c);
    const next = keySmear(c, "weapon", "weapon", "weapon__smear_a", "axe", 6);
    expect(next.slots.weapon!.attachment!.map((k) => [Math.round(k.time * 30), k.name])).toEqual([[6, "weapon__smear_a"], [7, "axe"]]);
    expect({ ...next, slots: {} }).toEqual({ ...before, slots: {} });
    expect(Object.keys(next.slots)).toEqual(["weapon"]);
    expect(next.bones).toEqual(before.bones);
    expect(drawOrderAt(next, 0.2)).toEqual([]);
    expect(clipSchema.safeParse(next).success).toBe(true);
    expect(() => keySmear(c, "hand_r", "hand_r", "x", null, 3)).toThrow();
  });
  it("lists sub-step times from frame a to frame b", () => {
    const t = smearTimes(emptyClip(1), 6, 12);
    expect(t).toHaveLength(6);
    expect(t[0]).toBeCloseTo(0.2);
    expect(t[5]).toBeCloseTo(0.4);
  });
});

describe("sub-step picking", () => {
  const path = (n: number, f: (t: number) => number) => Array.from({ length: n + 1 }, (_, i) => ({ x: f(i / n) * 300, y: 0 }));
  it("spaces sub-steps evenly along the arc even when the motion is eased", () => {
    const tips = path(60, (t) => t * t * t);
    const idx = pickByArc(tips, 6, false);
    expect(idx).toHaveLength(6);
    expect(idx[0]).toBe(0);
    expect(idx[5]).toBe(60);
    const gaps = idx.slice(1).map((i, k) => tips[i]!.x - tips[idx[k]!]!.x);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(10);
  });
  it("adds sub-steps when six would leave gaps, but not past the cap", () => {
    expect(pickByArc(path(60, (t) => t), 6).length).toBeGreaterThan(6);
    expect(pickByArc(path(60, (t) => t * 50), 6).length).toBeLessThanOrEqual(40);
    expect(pickByArc(path(60, (t) => t * 0.2), 6)).toHaveLength(6);
  });
  it("copes with a standing weapon", () => {
    expect(pickByArc(path(10, () => 0), 6)).toHaveLength(6);
  });
});
