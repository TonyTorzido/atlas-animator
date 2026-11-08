import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { solveStraightStance, swingIkMix, type StanceRig } from "./stancePolicy.js";

/** A straight-ish two-bone leg (thigh 100, shin 60, knee 3 deg) with the shin not inheriting scale. */
function rig(): { sk: Skeleton; r: StanceRig } {
  const doc = loadAnimDocument({
    format: "atlas-anim@1",
    name: "leg",
    canvas: { width: 200, height: 300, originX: 100, originY: 0 },
    bones: [
      { name: "root" },
      { name: "thigh", parent: "root", rotation: -90, length: 100 },
      { name: "shin", parent: "thigh", x: 100, rotation: 3, length: 60, inherit: "noScale" }
    ],
    slots: [],
    skins: { body: { attachments: {} } },
    animations: {}
  });
  const sk = new Skeleton(doc);
  const r: StanceRig = {
    pose(keys) {
      sk.setToSetupPose();
      for (const [k, v] of Object.entries(keys)) {
        const m = /^(.+)\.scaleX$/.exec(k);
        if (m) sk.getBone(m[1] as string).pose.scaleX = v;
        else sk.getBone(k).pose.rotation = sk.getBone(k).data.rotation + v;
      }
      sk.updateWorldTransform("none");
    },
    world(bone, lx = 0, ly = 0) {
      const o = { x: 0, y: 0 };
      sk.getBone(bone).localToWorld(lx, ly, o);
      return o;
    },
    rotation(bone) {
      return sk.getBone(bone).worldRotationX;
    }
  };
  return { sk, r };
}

describe("stance policy: foreshorten (r5)", () => {
  it("lands the ankle exactly on a closer or shifted plant, keeping the knee angle (no bow)", () => {
    const { sk, r } = rig();
    r.pose({});
    const ankle0 = r.world("shin", 60, 0);
    const knee0 = sk.getBone("shin").pose.rotation;
    for (const [dx, dy] of [[0, 6], [5, 10], [-7, 3], [0, 0]] as const) {
      // the hip drops / sways: the plant moves relative to the hip by (dx, dy)
      const keys: Record<string, number> = {};
      const target = { x: ankle0.x + dx, y: ankle0.y + dy };
      const res = solveStraightStance(r, keys, "thigh", "shin", 60, target);
      expect(res).toBeLessThan(1e-6);
      r.pose(keys);
      expect(sk.getBone("shin").pose.rotation).toBe(knee0);
      const e = r.world("shin", 60, 0);
      expect(Math.hypot(e.x - target.x, e.y - target.y)).toBeLessThan(1e-6);
      expect(keys["thigh.scaleX"]).toBeLessThanOrEqual(1.0001 + Math.abs(dy) * 0);
    }
  });
  it("blends IK in over the start of a swing and out before the plant", () => {
    expect(swingIkMix(0, 0.25)).toBe(0);
    expect(swingIkMix(0.5, 0.25)).toBe(1);
    expect(swingIkMix(1, 0.25)).toBe(0);
    expect(swingIkMix(0.125, 0.25)).toBeCloseTo(0.5, 6);
  });
});
