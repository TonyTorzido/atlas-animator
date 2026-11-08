import { describe, expect, it } from "vitest";
import { emptyClip, frameTime } from "./clipModel.js";
import { DRAW_PRESETS, drawOrderState, resolveDrawPreset, runtimeOrder, type DrawPresetId } from "./drawOrderPresets.js";
import { drawOrderAt, setDrawOrderKey } from "./slotModel.js";

/** The stock player rig's slot order (with the stand-in weapon after hand_r). */
const STOCK = ["hips", "torso", "shorts", "pants", "tank", "upper_arm", "tank_armhole", "forearm", "hand", "upper_arm_r", "tank_armhole_r", "forearm_r", "hand_r", "weapon", "weapon_tip", "weapon_grip", "head", "eyes", "hair"];
/** The brief's far-arm-behind layout (section 1.5), with a cape. */
const KIT = ["cape_back", "arm_r_upper", "arm_r_lower", "hand_r", "leg_r", "waist", "chest", "chain", "head", "shoulder_l", "arm_l_upper", "arm_l_lower", "hand_l", "weapon", "cape_front"];

describe("draw order presets", () => {
  it("arm_l_behind sends the left arm group behind the whole body and nothing else moves relatively", () => {
    const r = resolveDrawPreset(STOCK, "arm_l_behind");
    expect(r.applicable).toBe(true);
    expect(r.order.slice(0, 4)).toEqual(["upper_arm", "tank_armhole", "forearm", "hand"]);
    expect(r.order.filter((s) => !["upper_arm", "tank_armhole", "forearm", "hand"].includes(s))).toEqual(STOCK.filter((s) => !["upper_arm", "tank_armhole", "forearm", "hand"].includes(s)));
  });
  it("weapon_behind moves the three weapon slots behind the body", () => {
    const r = resolveDrawPreset(STOCK, "weapon_behind");
    expect(r.order.slice(0, 3)).toEqual(["weapon", "weapon_tip", "weapon_grip"]);
    expect(r.offsets.map((o) => o.slot).sort()).toEqual(["weapon", "weapon_grip", "weapon_tip"]);
  });
  it("arm_r_front is already the stock order (no offsets) and cape_over_arms is not applicable without a cape", () => {
    expect(resolveDrawPreset(STOCK, "arm_r_front")).toMatchObject({ applicable: true, offsets: [] });
    const cape = resolveDrawPreset(STOCK, "cape_over_arms");
    expect(cape.applicable).toBe(false);
    expect(cape.reason).toContain("cape");
  });
  it("on the kit layout the far arm comes forward and the cape comes over the arms", () => {
    const front = resolveDrawPreset(KIT, "arm_r_front");
    expect(front.order.indexOf("hand_r")).toBeGreaterThan(front.order.indexOf("chain"));
    const cape = resolveDrawPreset(KIT, "cape_over_arms");
    expect(cape.order.indexOf("cape_back")).toBeGreaterThan(cape.order.indexOf("weapon"));
  });
  it("the offsets reproduce the order through the runtime's own draw order build, for every preset on both layouts", () => {
    for (const setup of [STOCK, KIT]) {
      for (const p of DRAW_PRESETS) {
        const r = resolveDrawPreset(setup, p.id);
        if (r.applicable) expect(runtimeOrder(setup, r.offsets)).toEqual(r.order);
      }
    }
  });
  it("names the state a key amounts to", () => {
    expect(drawOrderState(STOCK, [])).toBe("setup");
    for (const id of ["arm_l_behind", "weapon_behind"] as DrawPresetId[]) expect(drawOrderState(STOCK, resolveDrawPreset(STOCK, id).offsets)).toBe(id);
    expect(drawOrderState(STOCK, [{ slot: "hair", offset: -3 }])).toBe("custom");
  });
  it("setDrawOrderKey replaces the key at a time and ignores earlier keys", () => {
    let c = emptyClip(1);
    c = setDrawOrderKey(c, frameTime(c, 3), [{ slot: "hair", offset: -2 }]);
    c = setDrawOrderKey(c, frameTime(c, 6), [{ slot: "hand", offset: 1 }]);
    c = setDrawOrderKey(c, frameTime(c, 3), []);
    expect(c.drawOrder.map((k) => k.offsets.length)).toEqual([0, 1]);
    expect(drawOrderAt(c, frameTime(c, 7))).toEqual([{ slot: "hand", offset: 1 }]);
  });
});
