import { describe, expect, it } from "vitest";
import { loopTime, nextScale, phoneLayout, PHONE_SCALES, stateKey, tokenFromPath } from "./phoneModel.js";

describe("phoneModel", () => {
  it("loops time inside the clip and never lands exactly on the duration", () => {
    expect(loopTime(0.25, 1)).toBeCloseTo(0.25);
    expect(loopTime(2.75, 1)).toBeCloseTo(0.75);
    expect(loopTime(1, 1)).toBe(0);
    expect(loopTime(5, 0)).toBe(0);
  });
  it("reads the token from a phone path", () => {
    expect(tokenFromPath("/phone/0123456789abcdef/")).toBe("0123456789abcdef");
    expect(tokenFromPath("/phone/0123456789abcdef")).toBe("0123456789abcdef");
    expect(tokenFromPath("/phone/short/")).toBeNull();
    expect(tokenFromPath("/")).toBeNull();
  });
  it("puts the feet on the ground line at the project scales", () => {
    expect(PHONE_SCALES).toEqual([0.4, 0.471]);
    const at = phoneLayout(390, 800, 262, 0.4);
    expect(at.x).toBe(195);
    expect(at.charY + 262 * 0.4).toBeCloseTo(at.groundY);
    expect(nextScale(0.4)).toBe(0.471);
    expect(nextScale(0.471)).toBe(0.4);
  });
  it("changes the state key when anything shown changes", () => {
    const a = { clipName: "c", clip: { duration: 1 }, facing: "left", rigKey: "1" };
    expect(stateKey(a)).toBe(stateKey({ ...a }));
    expect(stateKey(a)).not.toBe(stateKey({ ...a, clip: { duration: 2 } }));
    expect(stateKey(a)).not.toBe(stateKey({ ...a, facing: "right" }));
    expect(stateKey(a)).not.toBe(stateKey({ ...a, rigKey: "2" }));
  });
});
