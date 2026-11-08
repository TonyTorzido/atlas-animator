import { describe, expect, it } from "vitest";
import { cellCamera, cellWidthFor, MAX_W, cellHeightFor, CELL_W, DockFollower, dockFrameTime, dockModeFor, fitLabel, MARGIN, MAX_H, MIN_H } from "./phoneDock.js";

const clip = { fps: 30, duration: 1, events: [{ time: 0.5, name: "hit" }] } as never;

describe("dockModeFor", () => {
  it("is open in Animate and Swag, a rail in Pro, hidden elsewhere", () => {
    expect(dockModeFor("animate")).toBe("open");
    expect(dockModeFor("swag")).toBe("open");
    expect(dockModeFor("pro")).toBe("rail");
    for (const w of ["rig", "ship", "home"] as const) expect(dockModeFor(w)).toBe("hidden");
  });
});

describe("cellCamera", () => {
  const ext = { minX: -300, maxX: 220, minY: -770, maxY: 300 };

  it("is true size when the screen is big enough, feet above the bottom edge", () => {
    const cam = cellCamera(0.471, CELL_W, 700, ext);
    expect(cam.fit).toBe(1);
    expect(cam.scale).toBe(0.471);
    expect(cam.x).toBeCloseTo(CELL_W / 2 - ((ext.minX + ext.maxX) / 2) * 0.471);
    expect(cam.y + ext.maxY * cam.scale).toBeCloseTo(700 - MARGIN);
    expect(fitLabel(cam.fit)).toBe("true size");
  });

  it("scales down by the exact factor that fits, so the head, the feet and the weapon never crop", () => {
    for (const h of [260, 380, 450]) {
      for (const z of [0.4, 0.471]) {
        const cam = cellCamera(z, CELL_W, h, ext);
        expect(cam.fit).toBeLessThan(1);
        expect(cam.y + ext.minY * cam.scale).toBeGreaterThanOrEqual(MARGIN - 1e-6);
        expect(cam.y + ext.maxY * cam.scale).toBeLessThanOrEqual(h - MARGIN + 1e-6);
        expect(cam.x + ext.minX * cam.scale).toBeGreaterThanOrEqual(MARGIN - 1e-6);
        expect(cam.x + ext.maxX * cam.scale).toBeLessThanOrEqual(CELL_W - MARGIN + 1e-6);
        const flipped = cellCamera(z, CELL_W, h, ext, -1);
        expect(flipped.x - ext.maxX * flipped.scale).toBeGreaterThanOrEqual(MARGIN - 1e-6);
        expect(flipped.x - ext.minX * flipped.scale).toBeLessThanOrEqual(CELL_W - MARGIN + 1e-6);
      }
    }
    expect(fitLabel(0.8234)).toBe("fit 82%");
  });

  it("widens the screen to hold the weapon swing at true size, within the window's limits", () => {
    const wide = { minX: -382, maxX: 478, minY: -839, maxY: 307 };
    expect(cellWidthFor(0.471, wide, 1920)).toBe(440);
    expect(cellWidthFor(0.4, wide, 1920)).toBe(380);
    expect(cellWidthFor(0.4, { ...wide, minX: -50, maxX: 50 }, 1920)).toBe(CELL_W);
    expect(cellWidthFor(0.471, wide, 1280)).toBe(358);
    expect(cellWidthFor(1, wide, 5000)).toBe(MAX_W);
  });

  it("sizes the screen to the dock height within bounds", () => {
    expect(cellHeightFor(100)).toBe(MIN_H);
    expect(cellHeightFor(530)).toBe(370);
    expect(cellHeightFor(5000)).toBe(MAX_H);
  });
});

describe("DockFollower", () => {
  it("shows the held frame when paused", () => {
    const f = new DockFollower();
    expect(f.sample(clip, 0.2, false, 0).t).toBeCloseTo(dockFrameTime(clip, 0.2));
    expect(dockFrameTime(clip, 0.2)).toBeCloseTo(6 / 30);
  });

  it("plays from where play started and freezes through a hit-stop", () => {
    const f = new DockFollower();
    let now = 1000;
    f.sample(clip, 0.4, true, now);
    const seen: number[] = [];
    let held = false;
    for (let i = 0; i < 20; i++) {
      now += 16.7;
      const r = f.sample(clip, 0.4 + (i + 1) * 0.0167, true, now);
      seen.push(r.t);
      held ||= r.held;
    }
    expect(held).toBe(true);
    expect(seen[0]!).toBeGreaterThanOrEqual(0.4);
    expect(seen.some((t, i) => i > 0 && t === seen[i - 1] && t >= 0.5 - 1e-6)).toBe(true);
  });

  it("starts over when the editor time wraps", () => {
    const f = new DockFollower();
    f.sample(clip, 0.1, true, 0);
    f.sample(clip, 0.9, true, 800);
    const r = f.sample(clip, 0.05, true, 833);
    expect(r.t).toBeLessThan(0.2);
  });
});
