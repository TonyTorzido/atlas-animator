import { describe, expect, it } from "vitest";
import { emptyClip } from "./clipModel.js";
import { ikLiveAt, keyHandIk } from "./handIkLive.js";

describe("live hand IK keys", () => {
  it("keys mix 1 at the frame, mix 0 at the start, and the target translate", () => {
    const c = keyHandIk(emptyClip(1, false), "hand_ik_near", "hand_near_target", 0.4, 12, -3);
    const ik = (c.ik as unknown as Record<string, { time: number; mix: number }[]>)["hand_ik_near"]!;
    expect(ik.map((k) => [k.time, k.mix])).toEqual([[0, 0], [0.4, 1]]);
    expect(c.bones["hand_near_target"]!.translate!.map((k) => [k.time, k.x, k.y])).toEqual([[0.4, 12, -3]]);
    expect(ikLiveAt(c, "hand_ik_near", 0.1)).toBe(false);
    expect(ikLiveAt(c, "hand_ik_near", 0.4)).toBe(true);
    expect(ikLiveAt(c, "hand_ik_near", 0.9)).toBe(true);
  });
  it("a second key at another frame keeps the mix and adds a target key; the source clip is untouched", () => {
    const base = keyHandIk(emptyClip(1, false), "i", "t", 0.2, 0, 0);
    const c = keyHandIk(base, "i", "t", 0.6, 30, 5);
    expect((c.ik as unknown as Record<string, unknown[]>)["i"]).toHaveLength(3);
    expect(c.bones["t"]!.translate).toHaveLength(2);
    expect((base.ik as unknown as Record<string, unknown[]>)["i"]).toHaveLength(2);
  });
});
