import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";

/**
 * The pro kit rigs (rigs/kit-body-front0, rigs/kit-body-cutout): arm layering under every cross mode. Each bare arm is ONE
 * weighted mesh, shoulder ball to wrist (skin_arm_<s>, kit_arm_mesh.py), in its arm's block (wrist disc, arm mesh, fist); the
 * near (holding) block draws wholly over the far one, a fist never under its own arm, and the held weapon draws over every slot
 * except the near hand's fingers (between its grip back and fingers). Arms over the chest: every arm draws
 * over the tank and over that side's strap tip in every pose, always with the whole shoulder ball; no front bands, no strap
 * cover pieces. The jointed skin arm slots stay in the rig, empty (KIT_ARM_MESH=0 builds the rigid arms instead).
 */
const rigs = join(dirname(fileURLToPath(import.meta.url)), "../../rigs");

function skeletonOf(name: string): Skeleton {
  const path = join(rigs, name, `${name}.anim.json`);
  const skeleton = new Skeleton(loadAnimDocument(readFileSync(path, "utf8"), { source: path }));
  skeleton.setActiveSkins(["body"]);
  return skeleton;
}

function posed(skeleton: Skeleton, rotations: Record<string, number>): Map<string, number> {
  for (const bone of Object.keys(rotations)) skeleton.getBone(bone).pose.rotation = skeleton.getBone(bone).data.rotation + (rotations[bone] as number);
  skeleton.updateWorldTransform();
  skeleton.updateWorldTransform();
  return new Map(skeleton.drawOrder.map((slot, i) => [slot.data.name, i]));
}

/** Slots drawn over the weapon other than the holding hand's fingers (should be none). */
function weaponUnder(at: Map<string, number>): string[] {
  const w = at.get("weapon") as number;
  return [...at.entries()].filter(([name, i]) => i > w && name !== "skin_hand_near").map(([name]) => name);
}

const MODES: Record<string, Record<string, number>> = {
  neither: {},
  hands_meet: { forearm_near: -100, forearm_far: 100 },
  slightly_in: { upper_arm_near: -3, upper_arm_far: 3, forearm_near: -60, forearm_far: 60 },
  arms_out: { upper_arm_near: 20, upper_arm_far: -20 },
  near_crossed: { upper_arm_near: -30, forearm_near: -90 },
  far_crossed: { upper_arm_far: 30, forearm_far: 90 },
  both_crossed: { upper_arm_near: -22, upper_arm_far: 22, forearm_near: -35, forearm_far: 20 },
  both_crossed_deep: { upper_arm_near: -35, upper_arm_far: 35, forearm_near: -110, forearm_far: 110 }
};

describe.each(["kit-body-front0", "kit-body-cutout"])("%s arm layering", (rig) => {
  it.each(Object.entries(MODES))("%s", (_mode, rotations) => {
    const at = posed(skeletonOf(rig), rotations);
    const index = (name: string) => at.get(name) as number;
    // the near (holding) block: wrist disc, forearm, palm back; its fingers sit above the weapon
    const block = (side: string) =>
      [`skin_wrist_${side}`, `skin_arm_${side}`, side === "near" ? "skin_hand_near_back" : "skin_hand_far"].map(index);
    const near = block("near");
    const far = block("far");
    // one block wholly over the other: no slot of one arm sits between slots of the other
    const nearOver = Math.min(...near) > Math.max(...far);
    const farOver = Math.min(...far) > Math.max(...near);
    expect(nearOver || farOver).toBe(true);
    for (const side of ["near", "far"]) {
      expect(index(`skin_wrist_${side}`)).toBeLessThan(index(`skin_arm_${side}`));
      expect(index(`skin_arm_${side}`)).toBeLessThan(index(`skin_hand_${side}`));
    }
    // the weapon sandwiches the near hand and draws over every other slot
    expect(index("skin_hand_near_back")).toBeLessThan(index("weapon"));
    expect(index("weapon")).toBeLessThan(index("skin_hand_near"));
    expect(weaponUnder(at)).toEqual([]);
    // arms over the chest: every arm draws over the tank, its strap tip and the pants in every pose
    for (const side of ["near", "far"]) {
      expect(index(`skin_arm_${side}`)).toBeGreaterThan(index("shirt_torso"));
      expect(index(`skin_arm_${side}`)).toBeGreaterThan(index(`shirt_tip_${side}`));
      expect(index(`skin_arm_${side}`)).toBeGreaterThan(index("pants_waist"));
      expect(index(`shirt_tip_${side}`)).toBeLessThan(index("shirt_torso"));
    }
    // the near (holding) arm's block is always over the far arm's (it rides right under the weapon)
    expect(nearOver).toBe(true);
  });

  it("draws the weapon over every slot but the holding fingers in every driven draw-order state", () => {
    const skeleton = skeletonOf(rig);
    for (let near = -60; near <= 60; near += 3)
      for (let far = -60; far <= 60; far += 3)
        for (const fore of [0, 60, 110]) {
          const at = posed(skeleton, { upper_arm_near: near, upper_arm_far: far, forearm_near: -fore, forearm_far: fore });
          expect(weaponUnder(at), `near ${near} far ${far} forearm ${fore}`).toEqual([]);
        }
  });

  it("shows the arm mesh in every pose, its crease variant picked by the bend (the jointed pieces stay empty)", () => {
    const skeleton = skeletonOf(rig);
    const slot = (name: string) => skeleton.slots.find((s) => s.data.name === name);
    const att = (name: string) => slot(name)?.attachment?.name;
    for (const side of ["near", "far"]) {
      const sg = side === "near" ? -1 : 1; // the near elbow bends with negative forearm rotation
      for (const swing of [-40, -10, 0, 10, 40])
        for (const [bend, want] of [[0, "mesh"], [10, "mesh"], [-20, "mesh"], [20, "c020"], [60, "c060"], [62, "c060"], [90, "c090"], [120, "c120"], [150, "c140"]] as const) {
          posed(skeleton, { [`upper_arm_${side}`]: swing, [`forearm_${side}`]: sg * bend });
          expect(att(`skin_arm_${side}`), `${side} swing ${swing} bend ${bend}`).toBe(want);
          for (const off of ["skin_upper_arm", "skin_elbow", "skin_forearm", "skin_arm_straight"]) expect(att(`${off}_${side}`)).toBeUndefined();
          expect(att(`shirt_tip_${side}`)).toBe("tip");
          expect(att(`skin_hand_${side}`)).toBe("fist_c");
        }
      posed(skeleton, { [`upper_arm_${side}`]: 0, [`forearm_${side}`]: 0 });
    }
  });
});
