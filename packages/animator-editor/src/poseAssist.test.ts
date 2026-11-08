import { describe, expect, it } from "vitest";
import { MAGNET, assistRotation, fmtDeg, fmtDelta, moveReadout, rotateReadout, typeKey, typedValue } from "./poseAssist.js";

const base = { shift: false, ctrl: false, prevKey: null, mirror: null };

describe("assistRotation", () => {
  it("passes the raw angle through with no modifier", () => {
    expect(assistRotation({ ...base, raw: 37.3 })).toEqual({ value: 37.3, snap: null, guides: [] });
  });
  it("snaps to 15 degrees with Shift", () => {
    expect(assistRotation({ ...base, raw: 37.3, shift: true }).value).toBe(30);
    expect(assistRotation({ ...base, raw: 38, shift: true }).value).toBe(45);
    expect(assistRotation({ ...base, raw: -4, shift: true }).value).toBe(0);
  });
  it("pulls onto the previous key or the mirror angle with Ctrl, only inside the magnet", () => {
    const r = assistRotation({ ...base, raw: 50, ctrl: true, prevKey: 40, mirror: 80 });
    expect(r.value).toBe(40);
    expect(r.snap).toBe("key");
    expect(r.guides.map((g) => g.kind)).toEqual(["key", "mirror"]);
    expect(assistRotation({ ...base, raw: 70, ctrl: true, prevKey: 40, mirror: 80 })).toMatchObject({ value: 80, snap: "mirror" });
    const far = assistRotation({ ...base, raw: 40 + MAGNET + 5, ctrl: true, prevKey: 40, mirror: null });
    expect(far.snap).toBeNull();
    expect(far.value).toBe(40 + MAGNET + 5);
    expect(far.guides).toHaveLength(1);
  });
  it("has nothing to snap to without a key or a mirror", () => {
    expect(assistRotation({ ...base, raw: 10, ctrl: true })).toEqual({ value: 10, snap: null, guides: [] });
  });
});

describe("typed numbers", () => {
  it("builds a number key by key", () => {
    let b = "";
    for (const k of ["-", "4", "5", ".", "5"]) b = typeKey(b, k)!;
    expect(b).toBe("-45.5");
    expect(typedValue(b)).toBe(-45.5);
    expect(typeKey("-45.5", "Backspace")).toBe("-45.");
    expect(typeKey("12", "-")).toBe("-12");
    expect(typeKey("-12", "-")).toBe("12");
    expect(typeKey("1.5", ".")).toBe("1.5");
    expect(typeKey("", "x")).toBeNull();
  });
  it("is not a number until it has a digit", () => {
    expect(typedValue("")).toBeNull();
    expect(typedValue("-")).toBeNull();
    expect(typedValue(".")).toBeNull();
    expect(typedValue("0.")).toBe(0);
  });
});

describe("readouts", () => {
  it("writes angle and change", () => {
    expect(fmtDeg(-12.34)).toBe("−12.3°");
    expect(fmtDelta(5)).toBe("+5.0°");
    expect(rotateReadout(42, 30, null, null)).toMatchObject({ main: "42.0°", sub: "+12.0°", typing: false });
    expect(rotateReadout(45, 30, "step", null).sub).toContain("snap 15");
    expect(rotateReadout(45, 30, null, "4").typing).toBe(true);
  });
  it("writes x and y", () => {
    expect(moveReadout(10, -2, 4, 0, null).main).toBe("x 10.0   y −2.0");
    expect(moveReadout(0, 0, 0, 0, { x: "5", y: "", field: "x" }).main).toContain("5▏");
  });
});
