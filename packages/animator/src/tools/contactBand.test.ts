import { describe, expect, it } from "vitest";
import { applyContact, applyContacts, type ContactInk } from "../core/contours.js";
import { parseAnimDocument } from "../core/formatLoader.js";
import { applyCommands, type Command } from "./commands.js";
import { inContactBand, nearestOutsideBands, type ContactBandData } from "./contactBand.js";
import { checkPoseLimits, displayedFrameTimes, type ValidationIssue } from "./validate.js";

const inDomain = (p: Record<string, number>) => Math.abs(p["a"] ?? 0) <= 2 && Math.abs(p["b"] ?? 0) <= 2;

describe("nearestOutsideBands", () => {
  // Two crossing rectangles in [-2,2]^2: a horizontal bar (|b| <= 1, |a| <= 2) and a vertical bar
  // (|a| <= 1, |b| <= 2). Every single-band edge escape from (0,0) lands in the other bar or outside the domain.
  const bars: ContactBandData[] = [
    { name: "h", x: "a", y: "b", size: [4, 2], cells: [[0, 0]] },
    { name: "v", x: "a", y: "b", size: [2, 4], cells: [[0, 0]] }
  ];

  it("finds the combined corner escape out of two crossing bands (review reproduction)", () => {
    const r = nearestOutsideBands(bars, { a: 0, b: 0 }, inDomain);
    expect(r.ok).toBe(true);
    expect(r.pose).not.toEqual({ a: 0, b: 0 });
    expect(bars.some((b) => inContactBand(b, r.pose))).toBe(false);
    expect(inDomain(r.pose)).toBe(true);
    expect(Math.abs(r.pose["a"] ?? 0)).toBeLessThan(1.1);
    expect(Math.abs(r.pose["b"] ?? 0)).toBeLessThan(1.1);
  });

  it("returns an explicit failure, never the forbidden pose, when nothing legal exists", () => {
    const tight = (p: Record<string, number>) => Math.abs(p["a"] ?? 0) <= 1 && Math.abs(p["b"] ?? 0) <= 1;
    const r = nearestOutsideBands(bars, { a: 0, b: 0 }, tight);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no legal pose/);
  });
});

describe("displayed-frame contact check (validator)", () => {
  const doc = (fps?: number, when?: Record<string, [number, number]>) => {
    const raw = applyCommands({}, [
      { op: "doc.new", name: "arm", width: 100, height: 100 },
      { op: "bone.add", name: "upper", parent: "root", length: 20 },
      { op: "bone.add", name: "fore", parent: "upper", x: 20, length: 20 },
      { op: "patch", patch: [{ op: "add", path: "/contactBands", value: [{ name: "crack", x: "upper", y: "fore", size: [10, 10], cells: [[48, 30]], ...(when ? { when } : {}) }] }] },
      { op: "clip.add", name: "swing", duration: 1 },
      { op: "key.set", clip: "swing", bone: "upper", timeline: "rotate", time: 0, value: 0 },
      { op: "key.set", clip: "swing", bone: "upper", timeline: "rotate", time: 1, value: 96 },
      { op: "key.set", clip: "swing", bone: "fore", timeline: "rotate", time: 0, value: 0 },
      { op: "key.set", clip: "swing", bone: "fore", timeline: "rotate", time: 1, value: 60 },
      ...(fps ? [{ op: "patch", patch: [{ op: "add", path: "/animations/swing/fps", value: fps }] } as Command] : [])
    ]).doc;
    const parsed = parseAnimDocument(raw);
    if (!parsed.ok) throw new Error("fixture does not parse");
    return parsed.document;
  };
  const contacts = (d: ReturnType<typeof doc>) => {
    const issues: ValidationIssue[] = [];
    checkPoseLimits(d, issues);
    return issues.filter((i) => i.check === "contacts");
  };

  it("flags an in-between pose the 30 fps cache displays inside a band (keys are clean)", () => {
    const found = contacts(doc());
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/30 fps/);
  });

  it("lets motion jump across a band between displayed frames", () => {
    expect(contacts(doc(1))).toHaveLength(0);
  });

  it("applies a band only under its measurement condition", () => {
    expect(contacts(doc(undefined, { root: [10, 10] }))).toHaveLength(0);
    expect(contacts(doc(undefined, { root: [0, 0] }))).toHaveLength(1);
  });

  it("samples every phase of a loop whose duration is not whole frames", () => {
    expect(displayedFrameTimes({ duration: 0.5, loop: true, fps: 24 })).toHaveLength(12);
    expect(displayedFrameTimes({ duration: 0.1, loop: true, fps: 24 })).toHaveLength(12);
    expect(displayedFrameTimes({ duration: 1, loop: false })).toHaveLength(31);
  });
});

describe("contour contact (merged rendering)", () => {
  // Two parallel horizontal lines, width 10, centres 14 apart: ink gap 4 (< gap 7.67): a sliver.
  const line = (y: number) => [0, y, 20, y, 40, y, 60, y];
  it("closes the sliver: the inks overlap after the symmetric move (each capped at 0.4 of its width)", () => {
    const a = line(0), b = line(14);
    const outA = [...a], outB = [...b];
    applyContact(outA, a, 4, false, 10, b, 4, false, 10, 7.67, Math.cos((15 * Math.PI) / 180), 7.67);
    applyContact(outB, b, 4, false, 10, a, 4, false, 10, 7.67, Math.cos((15 * Math.PI) / 180), 7.67);
    const gapAfter = (outB[1] as number) - (outA[1] as number) - 10;
    // (g + overlap) / 2 = 5.835 per side, capped at 4 (the stroke keeps covering its own fill edge).
    expect(gapAfter).toBeCloseTo(-4, 5);
  });
  const cosMax = Math.cos((15 * Math.PI) / 180);
  const spec = { gap: 7.67, cosMax, overlap: 7.67, minRun: 15.34, taper: 7.67 };
  const ink = (points: number[], chain: number): ContactInk => ({ points, count: points.length / 2, closed: false, width: 10, chain });
  it("scopes the merge to the contact run: short runs are dropped, run ends taper", () => {
    // b touches a only near x = 0..10 (a 10 px run < minRun 15.34): nothing moves.
    const a = [0, 0, 10, 0, 20, 0, 30, 0, 40, 0];
    const short = [-5, 14, 5, 14, 5, 60];
    const out = [...a];
    applyContacts(out, ink(a, 0), [{ other: 1, ...spec }], [null, ink(short, 1)]);
    expect(out).toEqual(a);
    // A long run (b parallel over x = 0..20, then leaving): x 0..30 merge (run 30 px); with a 20 px
    // taper the inner points move fully, x = 30 (10 px from the unmerged x = 40) moves half, x = 40 not.
    const long = [0, 14, 20, 14, 20, 100];
    const out2 = [...a];
    applyContacts(out2, ink(a, 0), [{ other: 1, ...spec, taper: 20 }], [null, ink(long, 1)]);
    expect(out2[1]).toBeCloseTo(4, 5);
    expect(out2[5]).toBeCloseTo(4, 5);
    expect(out2[7]).toBeCloseTo((0.5 * 4 * 14) / Math.hypot(10, 14), 5);
    expect(out2[9]).toBe(0);
  });
  it("leaves a three-way junction apart (a third ink's open end within reach of both)", () => {
    const a = Array.from({ length: 9 }, (_, k) => [k * 10, 0]).flat();
    const b = a.map((v, k) => (k % 2 ? 14 : v));
    const third = [40, 7, 40, 60];
    const out = [...a];
    applyContacts(out, ink(a, 0), [{ other: 1, ...spec }], [null, ink(b, 1), ink(third, 2)]);
    // x = 30..50 lie within reach of the third ink's end at (40, 7): left apart; x = 0..20 merge.
    expect(out[4 * 2 + 1]).toBe(0);
    expect(out[1]).toBeCloseTo(4, 5);
    // A third ink running alongside (no end near) is not a junction.
    const along = [-100, 7, 200, 7];
    const out2 = [...a];
    applyContacts(out2, ink(a, 0), [{ other: 1, ...spec }], [null, ink(b, 1), ink(along, 2)]);
    expect(out2[4 * 2 + 1]).toBeCloseTo(4, 5);
  });
  it("leaves pairs apart by the gap or more, and crossing (non-parallel) pairs, unchanged", () => {
    const a = line(0), far = line(18);
    const out = [...a];
    applyContact(out, a, 4, false, 10, far, 4, false, 10, 7.67, Math.cos((15 * Math.PI) / 180), 7.67);
    expect(out).toEqual(a);
    const cross = [30, -30, 30, 30];
    applyContact(out, a, 4, false, 10, cross, 2, false, 10, 7.67, Math.cos((15 * Math.PI) / 180), 7.67);
    expect(out).toEqual(a);
  });
});
