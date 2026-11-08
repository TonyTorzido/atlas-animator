import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liftCurve, walkFrames, type WalkParams } from "./walkCycle.js";

const params = JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/clips/walk-front-chibi.json", import.meta.url)), "utf8")) as WalkParams;

describe("walk template: light front-facing step (r5)", () => {
  const frames = walkFrames(params);
  it("cycles in 0.9..1.0 s at 30 fps with no holds", () => {
    expect(frames.length / params.fps).toBeGreaterThanOrEqual(0.9);
    expect(frames.length / params.fps).toBeLessThanOrEqual(1.0);
    for (let i = 0; i < frames.length; i++) {
      const a = frames[i]!;
      const b = frames[(i + 1) % frames.length]!;
      const moved = Math.abs(a.pelvis.x - b.pelvis.x) + Math.abs(a.pelvis.y - b.pelvis.y) + Math.abs(a.arm.l.raise - b.arm.l.raise);
      expect(moved).toBeGreaterThan(1e-3);
    }
  });
  it("lifts low with an early peak and lands with zero vertical speed", () => {
    const peak = Math.max(...frames.map((f) => f.foot.l.lift));
    expect(peak).toBeLessThanOrEqual(params.lift + 1e-9);
    expect(peak).toBeGreaterThan(params.lift * 0.9);
    expect(liftCurve(0.999, params.liftPeak)).toBeLessThan(1e-4);
    expect(liftCurve(params.liftPeak, params.liftPeak)).toBeCloseTo(1, 6);
  });
  it("bobs 0.5..0.7 game px, lowest just after a contact", () => {
    const ys = frames.map((f) => f.pelvis.y);
    const range = Math.max(...ys) - Math.min(...ys);
    expect(range).toBeGreaterThanOrEqual(0.5 - 0.02);
    expect(range).toBeLessThanOrEqual(0.7 + 1e-6);
    const lowAt = frames[ys.indexOf(Math.max(...ys))]!.t / params.period;
    expect([lowAt - params.swing, lowAt - params.swing - 0.5, lowAt - params.swing + 0.5].some((d) => d >= 0 && d < 0.12)).toBe(true);
  });
  it("shifts the weight toward the planted foot and swings the near arm against the near leg", () => {
    const mid = frames[Math.round(frames.length * params.swing * 0.5)]!;
    expect(mid.foot.r.swingU).toBeNull();
    expect(mid.pelvis.x).toBeGreaterThan(0);
    expect(mid.arm.l.raise).toBeLessThan(params.armBase);
  });
  it("depth stride: the swing carries a leg back to front, stance recedes it slowly; neutral at passing", () => {
    for (const f of frames) for (const s of ["l", "r"] as const) expect(Math.abs(f.foot[s].depth)).toBeLessThanOrEqual(1 + 1e-9);
    const landing = frames.find((f, i) => i > 0 && f.foot.l.swingU === null && frames[i - 1]!.foot.l.swingU !== null)!;
    expect(landing.foot.l.depth).toBeGreaterThan(0.9); // lands forward (near)
    const mid = frames[Math.round(frames.length * params.swing * 0.5)]!; // near foot passing
    expect(Math.abs(mid.foot.l.depth)).toBeLessThan(0.2);
    expect(Math.abs(mid.foot.r.depth)).toBeLessThan(0.35);
  });
});
