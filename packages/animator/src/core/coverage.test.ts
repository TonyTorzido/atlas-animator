import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTrimmedStroke, COVER_ALPHA, coverIntervals, joinedEndMask, mergeIntervals, trimmedStrokeCapacity, visibleRuns } from "./coverage.js";
import { AnimationState, AnimationStateData } from "./animationState.js";
import { loadAnimDocument } from "./formatLoader.js";
import { Skeleton } from "./skeleton.js";
import type { CompiledContour } from "./contours.js";

/*
 * Clothing model (close): local coverage intervals. Geometry first (synthetic), then the
 * probe rig: bare body, tunic over tank, pauldron over the arm stroke, a garment fading in another
 * slot, and a swap while posed.
 */

const square = (x0: number, y0: number, x1: number, y1: number) => ({ world: [x0, y0, x1, y0, x1, y1, x0, y1], tris: [0, 1, 2, 0, 2, 3] });

describe("coverage intervals (geometry)", () => {
  it("a stroke crossing a coverer is trimmed at the coverer's edges (no dilation across)", () => {
    const { world, tris } = square(30, -20, 60, 20);
    const iv: number[] = [];
    coverIntervals([0, 0, 100, 0], 2, false, 2, world, tris, iv);
    expect(iv.length).toBe(2);
    expect(iv[0]).toBeCloseTo(0.3, 2);
    expect(iv[1]).toBeCloseTo(0.6, 2);
  });

  it("a coincident boundary trims the whole stroke (no half-stroke leak); a stroke clear of the reach stays", () => {
    const { world, tris } = square(-10, 0, 110, 20);
    const on: number[] = [];
    coverIntervals([0, 0, 100, 0], 2, false, 5, world, tris, on);
    expect(on).toEqual([0, 1]);
    const outward: number[] = [];
    coverIntervals([0, -4, 100, -4], 2, false, 5, world, tris, outward);
    expect(outward).toEqual([0, 1]);
    const clear: number[] = [];
    coverIntervals([0, -6, 100, -6], 2, false, 5, world, tris, clear);
    expect(clear).toEqual([]);
  });

  it("visible runs: complement, nothing covered = null, everything = empty, closed runs wrap", () => {
    expect(visibleRuns([], 5, false)).toBeNull();
    expect(visibleRuns([0, 4], 5, false)).toEqual([]);
    const runs = visibleRuns([1.5, 2.5], 5, false) as number[];
    expect(runs).toEqual([0, 1.5, 2.5, 4]);
    const closed = visibleRuns([1.5, 2.5], 4, true) as number[];
    expect(closed).toEqual([2.5, 5.5]);
    const iv = [3, 4, 1, 2, 1.5, 2.5];
    expect(mergeIntervals(iv)).toBe(2);
    expect(iv).toEqual([1, 2.5, 3, 4]);
  });

  it("trimmed build: no ink in the gap, trimmed ends fade to 0 on the covered side, original round ends keep their caps", () => {
    const pts = [0, 0, 50, 0, 100, 0];
    const runs = visibleRuns([0.56, 1.24], 3, false) as number[];
    const cap = trimmedStrokeCapacity(3, false, true);
    const positions = new Float32Array(cap.vertices * 2);
    const uvs = new Float32Array(cap.vertices * 2);
    const indices = new Uint32Array(cap.indices);
    const fade = new Float32Array(cap.vertices);
    const counts = { vertices: 0, indices: 0 };
    const ramp = { u0: 0, u1: 1, v: 0, rampFraction: 1 };
    buildTrimmedStroke(pts, 3, false, true, 4, 1e-6, ramp, runs, positions, uvs, indices, counts, fade);
    expect(counts.vertices).toBeLessThanOrEqual(cap.vertices);
    expect(counts.indices).toBeLessThanOrEqual(cap.indices);
    for (let i = 0; i < counts.indices; i++) expect(indices[i]).toBeLessThan(counts.vertices);
    for (let v = 0; v < counts.vertices; v++) {
      const x = positions[v * 2] as number;
      // Fully inked vertices never sit inside the covered gap [28, 62] (only the fading feather).
      if ((fade[v] as number) >= 1) expect(x < 28 + 1e-3 || x > 62 - 1e-3).toBe(true);
    }
    // The faded vertices sit at the two trim points (28 and 62) or on their (hidden) caps.
    const faded = [...Array(counts.vertices).keys()].filter((v) => fade[v] === 0).map((v) => positions[v * 2] as number);
    expect(faded.length).toBeGreaterThan(0);
    // ... one feather (0.6 x 4 px) into the gap, or on the hidden caps there.
    for (const x of faded) expect(Math.min(Math.abs(x - 28), Math.abs(x - 62))).toBeLessThan(4.41);
    // The original ends (0 and 100) are inked and capped (a round cap reaches past the end point).
    const xs = [...Array(counts.vertices).keys()].filter((v) => (fade[v] as number) > 0).map((v) => positions[v * 2] as number);
    expect(Math.min(...xs)).toBeLessThan(-1.9);
    expect(Math.max(...xs)).toBeGreaterThan(101.9);
  });

  it("a joined end with a covered tail shorter than a feather keeps its capped end; an unjoined one stays trimmed", () => {
    //: a forearm line joined to the fist, its last px under the head (no room for the fade).
    const pts = [0, 0, 50, 0, 100, 0];
    const runs = visibleRuns([1.96, 2], 3, false) as number[]; // last 2 px covered, feather 2.4 px
    const build = (joinedEnds: number) => {
      const cap = trimmedStrokeCapacity(3, false, true);
      const positions = new Float32Array(cap.vertices * 2);
      const fade = new Float32Array(cap.vertices);
      const counts = { vertices: 0, indices: 0 };
      buildTrimmedStroke(pts, 3, false, true, 4, 1e-6, { u0: 0, u1: 1, v: 0, rampFraction: 1 }, runs, positions, new Float32Array(cap.vertices * 2), new Uint32Array(cap.indices), counts, fade, joinedEnds);
      return Math.max(...[...Array(counts.vertices).keys()].filter((v) => (fade[v] as number) > 0).map((v) => positions[v * 2] as number));
    };
    expect(build(2)).toBeGreaterThan(101.9); // the joined end: inked to its end and capped
    expect(build(1)).toBeLessThan(98.01); // only the start is joined: the end stays trimmed at 98
    expect(build(0)).toBeLessThan(98.01);
    expect(joinedEndMask([{ isA: true, endA: 1, endB: 0 }])).toBe(2);
    expect(joinedEndMask([{ isA: false, endA: 1, endB: 0 }])).toBe(1);
  });
});

// --- the probe rig ------------------------------------------------------------------------------
const rigDir = new URL("../../fixtures/test-rigs/probe/", import.meta.url);
const probeDoc = (config: string) => JSON.parse(readFileSync(new URL(`template7-shoulder-probe-${config}.anim.json`, rigDir), "utf8"));
const haveProbe = existsSync(new URL("template7-shoulder-probe-layered.anim.json", rigDir));

function posed(config: string, clip?: string, time = 0) {
  const raw = probeDoc(config);
  const doc = loadAnimDocument(raw);
  const sk = new Skeleton(doc);
  sk.setActiveSkins(Object.keys(raw.skins));
  sk.setToSetupPose();
  if (clip) poseAt(sk, doc, clip, time);
  sk.updateWorldTransform("none");
  return { sk, doc, raw };
}
function poseAt(sk: Skeleton, doc: ReturnType<typeof loadAnimDocument>, clip: string, time: number) {
  sk.setToSetupPose();
  const state = new AnimationState(new AnimationStateData(doc));
  state.setAnimation(0, clip);
  state.update(time);
  state.apply(sk);
  sk.updateWorldTransform("none");
}
const byRef = (sk: Skeleton, ref: string) => sk.activeContours.find((c) => `${c.slot}/${c.name}` === ref) as CompiledContour;
const coveredFraction = (c: CompiledContour, runs: number[] | null) => {
  if (runs === null) return 0;
  const L = c.closed ? c.pointCount : c.pointCount - 1;
  let visible = 0;
  for (let i = 0; i < runs.length; i += 2) visible += (runs[i + 1] as number) - (runs[i] as number);
  return 1 - visible / L;
};

describe("clothing model on the probe rig", () => {
  it("has the probe rig fixtures (a missing fixture fails, never skips)", () => {
    expect(haveProbe).toBe(true);
  });

  it("bare body: its own flank/waist contours draw whole; nothing but the head trims the body", () => {
    const { sk } = posed("bare");
    const derived = sk.activeContours.filter((c) => c.name.startsWith("body_edge_"));
    expect(derived.length).toBeGreaterThanOrEqual(3);
    const flank = derived.reduce((a, b) => (a.pointCount > b.pointCount ? a : b));
    expect(sk.isContourVisible(flank)).toBe(true);
    expect(sk.contourRuns(flank)).toBeNull();
    for (const c of sk.activeContours) if (c.slot.startsWith("upper_arm") || c.slot.startsWith("forearm")) expect(sk.contourRuns(c)).toBeNull();
  });

  it("tank: the body flank under the tank is trimmed (the tank draws its own flank)", () => {
    const { sk } = posed("control");
    const flank = sk.activeContours.filter((c) => c.name.startsWith("body_edge_")).reduce((a, b) => (a.pointCount > b.pointCount ? a : b));
    expect(coveredFraction(flank, sk.contourRuns(flank))).toBeGreaterThan(0.5);
    // The tank's own strokes are not trimmed by the skin it rides (sliding regions: painter's order).
    expect(sk.contourRuns(byRef(sk, "tank/flank"))).toBeNull();
  });

  it("tunic over tank: only the covered tank-stroke intervals go; the result is the same in every pose (swap while posed)", () => {
    const rest = posed("layered");
    const refs = rest.sk.activeContours.filter((c) => c.ownerSlot === "tank" || c.slot.startsWith("tank")).map((c) => `${c.slot}/${c.name}`);
    expect(refs.length).toBeGreaterThan(0);
    const atRest = refs.map((r) => rest.sk.contourRuns(byRef(rest.sk, r))?.slice() ?? null);
    // The tank flanks lie wholly under the tunic: trimmed away entirely.
    expect(atRest.some((r) => r !== null && r.length === 0)).toBe(true);
    // Posed (idle_wave at its wave) with the tunic taken off, then put back while posed.
    const { sk, doc } = posed("layered");
    expect(doc.animations.idle_wave).toBeDefined();
    const tunic = sk.getSlot("tunic");
    const shown = tunic.attachment;
    for (const t of [0.4, 1.2]) {
      poseAt(sk, doc, "idle_wave", t);
      tunic.attachment = null;
      const off = refs.map((r) => sk.contourRuns(byRef(sk, r))?.slice() ?? null);
      // Without the tunic the tank strokes come back where only the tunic covered them.
      expect(off.some((r, i) => JSON.stringify(r) !== JSON.stringify(atRest[i] ?? null))).toBe(true);
      tunic.attachment = shown;
      const on = refs.map((r) => sk.contourRuns(byRef(sk, r))?.slice() ?? null);
      // The same as a skeleton that never swapped, in the same pose (rigid coverers such as the head
      // move with the pose; the tunic's skin-space intervals do not).
      const fresh = posed("layered", "idle_wave", t);
      const never = refs.map((r) => fresh.sk.contourRuns(byRef(fresh.sk, r))?.slice() ?? null);
      on.forEach((r, i) => {
        const expected = never[i] ?? null;
        if (expected === null) expect(r).toBeNull();
        else {
          expect(r?.length).toBe(expected.length);
          for (let k = 0; k < expected.length; k++) expect((r as number[])[k]).toBeCloseTo(expected[k] as number, 6);
        }
      });
    }
  });

  it("pauldron over the arm stroke: only the interval under the plate goes, per pose", () => {
    const { sk, doc } = posed("pauldrons");
    const arm = byRef(sk, "upper_arm/outline");
    const plate = sk.getSlot("pauldron_l");
    const shown = plate.attachment;
    for (const t of [0, 1.2]) {
      poseAt(sk, doc, "idle_wave", t);
      plate.attachment = shown;
      const withPlate = coveredFraction(arm, sk.contourRuns(arm));
      plate.attachment = null;
      const without = coveredFraction(arm, sk.contourRuns(arm));
      // The plate trims a local interval; most of the arm stroke stays.
      expect(withPlate - without).toBeGreaterThan(0.02);
      expect(withPlate).toBeLessThan(0.9);
    }
  });

  it("a garment fading in another slot: its strokes fade with it and un-trim below COVER_ALPHA", () => {
    const { sk } = posed("control");
    // A garment fade animates every slot the garment draws in (its slot and its draw-group slots).
    const tankSlots = ["tank", "tank_armhole", "tank_armhole_r"].map((n) => sk.getSlot(n));
    const setAlpha = (a: number) => tankSlots.forEach((s2) => (s2.color.a = a));
    const edge = byRef(sk, "tank_armhole/edge");
    const flank = sk.activeContours.filter((c) => c.name.startsWith("body_edge_")).reduce((a, b) => (a.pointCount > b.pointCount ? a : b));
    expect(sk.contourOwnerAlpha(edge)).toBe(1);
    setAlpha(COVER_ALPHA + 0.1);
    expect(sk.contourOwnerAlpha(edge)).toBeCloseTo(COVER_ALPHA + 0.1, 6);
    expect(sk.contourRuns(flank)).not.toBeNull();
    setAlpha(COVER_ALPHA - 0.1);
    expect(sk.contourRuns(flank)).toBeNull();
    setAlpha(0);
    // Fully faded owner: the stroke's alpha is 0 (the renderers skip it; band eligibility too).
    expect(sk.contourOwnerAlpha(edge)).toBe(0);
  });
});
