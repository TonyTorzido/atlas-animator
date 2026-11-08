import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { sweepClip } from "../cli/garmentImport.js";
import { DIP_TO, GAP_MAX_PX, armDipIds, cuffWristGap, sleevedArms, wristDip } from "./cuffGap.js";
import { readPng } from "./png.js";
import { softRender } from "./softRender.js";
import { texturesFromAtlas } from "./validate.js";

/*
 * Occluded-arm pose for the cuff-to-wrist gate: at sweep@5.00 the left arm is raised with
 * the elbow bent, the fist sits under the head and part of the arm runs past the gate's render window.
 * Measured on the full composite in that window, the fist bulge is cut off and the wrist dip slides to
 * the search edge; measured on the arm alone (armDipIds) it stays on the rest-pose wrist.
 */
const RIG = new URL("../../fixtures/test-rigs/body/", import.meta.url);

function load() {
  const raw = JSON.parse(readFileSync(new URL("template7-shoulder-legs.bare.anim.json", RIG), "utf8"));
  raw.animations.sweep = sweepClip(["upper_arm_l", "upper_arm_r"], ["forearm_l", "forearm_r"]);
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(new URL("template7-shoulder-legs.atlas.json", RIG), "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(fileURLToPath(new URL(p.file, RIG)))] as const));
  const loaded = loadAnimDocument(raw);
  const sk = new Skeleton(loaded);
  sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
  const data = new AnimationStateData(loaded);
  const pose = (t: number) => {
    sk.setToSetupPose();
    const st = new AnimationState(data);
    st.setAnimation(0, "sweep", { loop: false });
    st.update(t);
    st.apply(sk);
    sk.updateWorldTransform("none");
  };
  return { raw, sk, pose, textures: texturesFromAtlas(pack, pages) };
}

describe("cuff gap wrist dip on an occluded arm", () => {
  const { raw, sk, pose, textures } = load();
  const [arm] = sleevedArms(raw, ["forearm"]);
  const { originX: ox, originY: oy, width: cw, height: ch } = raw.canvas as { originX: number; originY: number; width: number; height: number };
  const big = { width: cw + 400, height: ch + 400, left: -ox - 200, top: -oy - 200 };
  // the gate's dressed-render window (garmentImport: L 180, top 300, 720 x 820)
  const gateWin = { width: 720, height: 820, left: 180 - ox, top: 300 - oy };

  it("measures the same wrist dip at sweep@5.00 as at rest, though the head covers the fist", () => {
    if (!arm) throw new Error("no sleeved left arm in the rig");
    pose(0);
    const rest = wristDip(sk, armDipIds(sk, textures, arm, big), arm).uDip;
    pose(5);
    const armOnly = armDipIds(sk, textures, arm, big);
    const full = softRender(sk, textures, { ...big, scale: 1, ids: true }).topSlot as Int16Array;
    // the pose really is occluded: fist pixels of the arm-only render are another slot's in the composite
    const hand = sk.getSlot(arm.handSlot).index + 1;
    let covered = 0;
    for (let i = 0; i < full.length; i++) if (armOnly.topSlot[i] === hand && full[i] !== hand) covered++;
    expect(covered).toBeGreaterThan(200);
    const occluded = wristDip(sk, armOnly, arm).uDip;
    expect(occluded).toBeLessThan(DIP_TO);
    expect(Math.abs(occluded - rest)).toBeLessThanOrEqual(3);
    // the old measurement (full composite, gate window) loses the dip on this pose
    const gateIds = { topSlot: softRender(sk, textures, { ...gateWin, scale: 1, ids: true }).topSlot as Int16Array, ...gateWin };
    expect(Math.abs(wristDip(sk, gateIds, arm).uDip - rest)).toBeGreaterThan(3);
  });

  it("still flags a bare forearm above the dip on the occluded pose", () => {
    if (!arm) throw new Error("no sleeved left arm in the rig");
    pose(5);
    const gateIds = { topSlot: softRender(sk, textures, { ...gateWin, scale: 1, ids: true }).topSlot as Int16Array, ...gateWin };
    const [side] = cuffWristGap(sk, (a) => armDipIds(sk, textures, a, big), sk, gateIds, [arm]);
    expect(side?.exposedPx).toBeGreaterThan(GAP_MAX_PX);
    expect(side?.uDip).toBeLessThan(DIP_TO);
  });
});
