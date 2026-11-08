import { describe, expect, it } from "vitest";
import { onionGhosts, onionPlan } from "./viewAids.js";

describe("onion plan", () => {
  it("lists the previous then the next frame at each distance", () => {
    expect(onionPlan(5, 30, 2, false)).toEqual([
      { frame: 4, dist: -1 },
      { frame: 6, dist: 1 },
      { frame: 3, dist: -2 },
      { frame: 7, dist: 2 }
    ]);
  });
  it("skips frames outside a one-shot (0..frames inclusive)", () => {
    expect(onionPlan(0, 10, 2, false).map((p) => p.frame)).toEqual([1, 2]);
    expect(onionPlan(10, 10, 1, false).map((p) => p.frame)).toEqual([9]);
  });
  it("wraps around a loop and never ghosts the shown frame itself", () => {
    expect(onionPlan(0, 28, 1, true).map((p) => p.frame)).toEqual([27, 1]);
    expect(onionPlan(27, 28, 2, true).map((p) => p.frame)).toEqual([26, 0, 25, 1]);
    expect(onionPlan(0, 2, 3, true).every((p) => p.frame !== 0)).toBe(true);
  });
});

describe("onion ghosts", () => {
  const o = { enabled: true, before: 2, after: 2, mode: "frames" as const, step: 1, style: "tint" as const, opacity: 0.4, falloff: 0.5 };
  it("counts each side separately and fades by rank", () => {
    const g = onionGhosts(10, 30, false, { ...o, before: 3, after: 1 });
    expect(g.filter((x) => x.side < 0).map((x) => x.frame)).toEqual([9, 8, 7]);
    expect(g.filter((x) => x.side > 0).map((x) => x.frame)).toEqual([11]);
    expect(g.find((x) => x.frame === 8)!.alpha).toBeCloseTo(0.2);
  });
  it("steps every N frames and wraps a loop", () => {
    expect(onionGhosts(1, 30, true, { ...o, step: 3 }).map((x) => x.frame).sort((a, b) => a - b)).toEqual([4, 7, 25, 28]);
  });
  it("keys mode ghosts the neighbouring keys, however far", () => {
    const g = onionGhosts(12, 30, false, { ...o, mode: "keys", before: 2, after: 1 }, [0, 8, 12, 24]);
    expect(g.map((x) => `${x.side}:${x.frame}`).sort()).toEqual(["-1:0", "-1:8", "1:24"]);
  });
});
