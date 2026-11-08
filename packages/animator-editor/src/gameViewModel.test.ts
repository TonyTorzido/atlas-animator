import { describe, expect, it } from "vitest";
import { ARC_FADE_MS } from "./preview/swingEffects.js";
import { HIT_TUNING } from "./preview/hitFeedback.js";
import { emptyClip } from "./clipModel.js";
import {
  CELL_MARGIN,
  GameClock,
  LOOP_REST_S,
  TRAIL_LIFE_SCALE,
  cellSize,
  cellView,
  dummyPlacement,
  eventsCrossed,
  hitLook,
  hitTimes,
  msSinceHit,
  reachFrame,
  ribbonOutline,
  trailFrames,
  trailPoints,
  trailWindows
} from "./gameViewModel.js";

/** A 1 s, 30 fps swing: windup 0, trail 9..17, hit 12 (0.4 s), ready 26. */
function swing() {
  const clip = emptyClip(1);
  clip.events = [
    { time: 0, name: "windup" },
    { time: 9 / 30, name: "trailOn" },
    { time: 12 / 30, name: "hit" },
    { time: 17 / 30, name: "trailOff" },
    { time: 26 / 30, name: "ready" }
  ];
  return clip;
}

describe("events", () => {
  it("pairs trailOn with the next trailOff, and runs an unmatched trailOn to the end of the clip", () => {
    expect(trailWindows(swing())).toEqual([{ on: 9 / 30, off: 17 / 30 }]);
    const open = emptyClip(1);
    open.events = [{ time: 0.2, name: "trailOn" }];
    expect(trailWindows(open)).toEqual([{ on: 0.2, off: 1 }]);
    expect(trailWindows(emptyClip(1))).toEqual([]);
  });

  it("lists the hits and the events a clock step crosses (exclusive start, inclusive end)", () => {
    const clip = swing();
    expect(hitTimes(clip)).toEqual([12 / 30]);
    expect(eventsCrossed(clip, 11 / 30, 12 / 30).map((e) => e.name)).toEqual(["hit"]);
    expect(eventsCrossed(clip, 12 / 30, 13 / 30)).toEqual([]);
    expect(eventsCrossed(clip, -1e-6, 0).map((e) => e.name)).toEqual(["windup"]);
  });

  it("measures the time since the last hit", () => {
    const clip = swing();
    expect(msSinceHit(clip, 0.3)).toBeNaN();
    expect(msSinceHit(clip, 0.4)).toBeCloseTo(0, 6);
    expect(msSinceHit(clip, 0.5)).toBeCloseTo(100, 6);
  });
});

describe("the project clock (the client's hit-stop)", () => {
  const run = (loop: boolean, seconds: number) => {
    const clock = new GameClock();
    const clip = swing();
    const steps: ReturnType<GameClock["step"]>[] = [];
    for (let ms = 0; ms < seconds * 1000 - 1e-6; ms += 1000 / 60) steps.push(clock.step(1000 / 60, clip, loop));
    return steps;
  };

  it("fires the hit once per cycle", () => {
    const steps = run(true, 1.0);
    expect(steps.flatMap((s) => s.fired).filter((e) => e.name === "hit")).toHaveLength(1);
  });

  it("freezes the sampled time on the hit for the swing's hold, then catches up to the real clock", () => {
    const steps = run(true, 1.0);
    const at = steps.findIndex((s) => s.fired.some((e) => e.name === "hit"));
    const hold = HIT_TUNING.swing.holdMs;
    const frozen = steps[at]!.t;
    const mid = steps[at + Math.floor(hold / (1000 / 60)) - 1]!;
    expect(mid.held).toBe(true);
    expect(mid.t).toBeCloseTo(frozen, 6);
    // Sampling never goes backwards, and once the catch-up is over it is on the real clock again.
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.t).toBeGreaterThanOrEqual(steps[i - 1]!.t - 1e-9);
    const last = steps[steps.length - 1]!;
    expect(last.cycleT).toBeCloseTo(steps.length / 60, 3);
  });

  it("loops after the clip plus its rest and fires the events again; a one-shot holds the last frame", () => {
    const looping = run(true, 1 + LOOP_REST_S + 0.6);
    expect(looping.some((s) => s.restarted)).toBe(true);
    expect(looping.flatMap((s) => s.fired).filter((e) => e.name === "hit")).toHaveLength(2);
    const once = run(false, 2);
    expect(once.some((s) => s.restarted)).toBe(false);
    expect(once[once.length - 1]!.finished).toBe(true);
    expect(once[once.length - 1]!.t).toBe(1);
    expect(once.flatMap((s) => s.fired).filter((e) => e.name === "hit")).toHaveLength(1);
  });

  it("reports the time since the hit on the real clock", () => {
    const steps = run(true, 0.7);
    const at = steps.findIndex((s) => s.fired.some((e) => e.name === "hit"));
    expect(steps[at]!.sinceHitMs).toBeCloseTo(0, 6);
    expect(steps[at + 6]!.sinceHitMs).toBeCloseTo((6 * 1000) / 60, 6);
    expect(steps[0]!.sinceHitMs).toBeNaN();
  });
});

describe("hit look (the client's flash, tint and push)", () => {
  it("flashes at full strength in the hold, then fades out and rests", () => {
    const hold = HIT_TUNING.swing.holdMs;
    expect(hitLook(0).flash).toBeCloseTo(0.85, 6);
    expect(hitLook(0).held).toBe(true);
    expect(hitLook(hold + 20).flash).toBeLessThan(0.85);
    expect(hitLook(hold + 20).held).toBe(false);
    expect(hitLook(2000).flash).toBe(0);
    expect(hitLook(2000).tint).toBe(0xffffff);
    expect(hitLook(Number.NaN).sparkProgress).toBe(1);
  });

  it("pushes the target away and tints it red after the flash", () => {
    const look = hitLook(HIT_TUNING.swing.holdMs + 10);
    expect(look.pushPx).toBeGreaterThan(0);
    expect(look.tint).not.toBe(0xffffff);
  });
});

describe("trail", () => {
  it("covers the frames of the open window up to the playhead", () => {
    const clip = swing();
    expect(trailFrames(clip, 8 / 30)).toEqual([]);
    expect(trailFrames(clip, 11 / 30).map((f) => f.frame)).toEqual([9, 10, 11]);
    expect(trailFrames(clip, 0.9).map((f) => f.frame)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("fades old points like the client's slash arc and drops them after the (stretched) fade", () => {
    const clip = swing();
    const tip = (f: number) => ({ x: f * 10, y: 0 });
    const early = trailPoints(clip, 12 / 30, tip);
    expect(early.map((p) => p.x)).toEqual([90, 100, 110, 120]);
    expect(early[3]!.alpha).toBe(1);
    expect(early[0]!.alpha).toBeLessThan(early[3]!.alpha);
    const late = trailPoints(clip, 17 / 30 + (ARC_FADE_MS * TRAIL_LIFE_SCALE) / 1000, tip);
    expect(late).toEqual([]);
  });

  it("builds a tapered ribbon about the points", () => {
    const { left, right } = ribbonOutline([{ x: 0, y: 0, alpha: 1 }, { x: 10, y: 0, alpha: 1 }, { x: 20, y: 0, alpha: 0.5 }], 4);
    expect(left[0]).toEqual([0, 4]);
    expect(right[0]).toEqual([0, -4]);
    expect(left[2]![1]).toBe(2);
  });
});

describe("placement and cells", () => {
  it("stands the target on the side the weapon reaches, at weapon range", () => {
    expect(dummyPlacement(0, -400).side).toBe(-1);
    expect(dummyPlacement(0, -400).x).toBeLessThan(-400);
    expect(dummyPlacement(0, 400).side).toBe(1);
    expect(dummyPlacement(0, 10).x).toBeGreaterThanOrEqual(240);
  });

  it("puts the hit frame first, then the middle of the trail, then the middle of the clip", () => {
    expect(reachFrame(swing())).toBe(12);
    const trailOnly = swing();
    trailOnly.events = trailOnly.events.filter((e) => e.name !== "hit");
    expect(reachFrame(trailOnly)).toBe(13);
    expect(reachFrame(emptyClip(1))).toBe(15);
  });

  it("sizes a phone cell to the figure and widens it for a long reach; the 1x cell is a fixed close-up", () => {
    expect(cellSize(0.4, 1000)).toEqual([390, 1000 * 0.4 + 2 * CELL_MARGIN]);
    expect(cellSize(0.4, 1000, 1400)[0]).toBeGreaterThan(390);
    expect(cellSize(1, 1000)).toEqual([520, 620]);
  });

  it("stands the feet above the cell's bottom margin and centres the camera on a point (mirrored: the other way)", () => {
    const v = cellView(0.4, 500, 1000, 100, false);
    expect(v.y).toBeCloseTo(cellSize(0.4, 1000)[1] - CELL_MARGIN - 500 * 0.4, 6);
    expect(v.x).toBeCloseTo(195 - 40, 6);
    expect(cellView(0.4, 500, 1000, 100, true).x).toBeCloseTo(195 + 40, 6);
  });
});
