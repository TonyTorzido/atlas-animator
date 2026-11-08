import { describe, expect, it } from "vitest";
import { boneSelectable, layerFlag, moveArmAt, onRotateRing, projectMove, rulerStep, rulerTicks, setLayerFlag, sliderToZoom, zoomToSlider, ZOOM_MAX, ZOOM_MIN } from "./canvasTools.js";

// A bone rotated 90 degrees clockwise on screen (its x axis points down), under a parent rotated 30 degrees.
const rad = (d: number) => (d * Math.PI) / 180;
const rot = (d: number) => ({ a: Math.cos(rad(d)), b: -Math.sin(rad(d)), c: Math.sin(rad(d)), d: Math.cos(rad(d)) });
const parent = { world: rot(30) };
const bone = { world: rot(90), parent };
const origin = { x: 100, y: 50 };

describe("move gizmo arms", () => {
  it("projects a drag onto the grabbed arm of the space's frame", () => {
    const w = projectMove(bone, "world", "x", 10, 7);
    expect(w.dx).toBeCloseTo(10);
    expect(w.dy).toBeCloseTo(0);
    const l = projectMove(bone, "local", "x", 10, 7);
    // The bone's x axis points straight down on screen, so only the y part survives.
    expect(l.dx).toBeCloseTo(0);
    expect(l.dy).toBeCloseTo(7);
    const p = projectMove(bone, "parent", "y", 10, 7);
    const along = p.dx * -Math.sin(rad(30)) + p.dy * Math.cos(rad(30));
    expect(Math.hypot(p.dx, p.dy)).toBeCloseTo(Math.abs(along));
  });

  it("leaves a centre drag free", () => {
    expect(projectMove(bone, "local", "xy", 3, 4)).toEqual({ dx: 3, dy: 4 });
    expect(projectMove(bone, "local", null, 3, 4)).toEqual({ dx: 3, dy: 4 });
  });

  it("hits the arms of the chosen space, the centre, and nothing elsewhere", () => {
    // World space at zoom 1: the x arm runs right from the origin, y runs down.
    expect(moveArmAt(origin, bone, "world", 1, 130, 50)).toBe("x");
    expect(moveArmAt(origin, bone, "world", 1, 100, 80)).toBe("y");
    expect(moveArmAt(origin, bone, "world", 1, 104, 52)).toBe("xy");
    expect(moveArmAt(origin, bone, "world", 1, 130, 80)).toBeNull();
    // Local space: the bone's x axis points down, so the "x" arm is the one below the origin.
    expect(moveArmAt(origin, bone, "local", 1, 100, 80)).toBe("x");
    // Arms keep their screen length at any zoom.
    expect(moveArmAt(origin, bone, "world", 2, 100 + 40 / 2, 50)).toBe("x");
    expect(moveArmAt(origin, bone, "world", 2, 100 + 70 / 2, 50)).toBeNull();
  });
});

describe("rulers and zoom slider", () => {
  it("picks 1-2-5 steps that stay at least minPx apart", () => {
    for (const scale of [0.05, 0.3, 1, 2.5, 8]) {
      const step = rulerStep(scale);
      expect(step * scale).toBeGreaterThanOrEqual(56 - 1e-9);
      expect(step * scale).toBeLessThan(56 * 2.6);
      expect([1, 2, 5].includes(step / 10 ** Math.floor(Math.log10(step)))).toBe(true);
    }
  });

  it("lists ticks on multiples of the step inside the range", () => {
    expect(rulerTicks(-12, 33, 10)).toEqual([-10, 0, 10, 20, 30]);
    expect(rulerTicks(0.1, 0.9, 0.5)).toEqual([0.5]);
  });

  it("maps zoom to the slider and back, bottom = far out, top = close in", () => {
    expect(zoomToSlider(ZOOM_MIN)).toBeCloseTo(0);
    expect(zoomToSlider(ZOOM_MAX)).toBeCloseTo(1);
    for (const z of [0.1, 0.5, 1, 3]) expect(sliderToZoom(zoomToSlider(z))).toBeCloseTo(z, 6);
    expect(zoomToSlider(100)).toBeCloseTo(1);
  });
});

describe("Bones / Images / Others flags", () => {
  it("gate picking: helper bones follow Others, the rest follow Bones", () => {
    expect(boneSelectable(false)).toBe(true);
    setLayerFlag("bones", "selectable", false);
    expect(boneSelectable(false)).toBe(false);
    expect(boneSelectable(true)).toBe(true);
    setLayerFlag("bones", "selectable", true);
    setLayerFlag("others", "selectable", false);
    expect(boneSelectable(true)).toBe(false);
    setLayerFlag("others", "selectable", true);
    expect(layerFlag("others", "visible")).toBe(false);
  });
});

describe("rotate ring grab", () => {
  it("a press on the ring band grabs the selected bone, inside or far outside it does not", () => {
    // ring 70 screen px at zoom 0.5: the ring sits 140 skeleton units from the origin
    expect(onRotateRing(140, 70, 0.5)).toBe(true);
    expect(onRotateRing(140 + 20, 70, 0.5)).toBe(true);
    expect(onRotateRing(140 - 20, 70, 0.5)).toBe(true);
    expect(onRotateRing(0, 70, 0.5)).toBe(false);
    expect(onRotateRing(400, 70, 0.5)).toBe(false);
  });
});
