import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadPreset } from "./preset.js";
import { buildSurface } from "./build.js";
import { fadeDrivenSets } from "./output.js";
import { mirrorRig } from "../mirrorRig.js";
import { deriveBodyContours, opaqueOutline } from "../bodyContours.js";
import { loadAnimDocument } from "../../core/formatLoader.js";
import { applyPose, crossedArmsGate, edgeContinuityGate, inkGate, lineEndGate, openEndGate, poseSkeleton, sheetGate, torsoOutlineGate, wristGate } from "./armLayerGates.js";
import { joinExtremities } from "../extremityJoin.js";
import { readPng } from "../png.js";
import { pointInPolygon } from "./geometry.js";

const preset = loadPreset(resolve(__dirname, "../../../fixtures/canonical/template7-armlayer.preset.json"));

describe("arm layer", () => {
  const built = buildSurface(preset);
  it("builds the torso as a detached sheet with trunk weights only", () => {
    expect(built.sheets).toHaveLength(1);
    const torso = built.sheets[0]!;
    const limb = new Set(preset.chain.bones);
    for (const w of torso.weights) for (const [b] of w) expect(limb.has(torso.bones[b] as string)).toBe(false);
    expect(built.apexes).toHaveLength(0);
  });
  // as buildRig: the front-edge faders (cap_front, underside_front, outline_front) fade with the arm's raise
  const doc = { ...built.document, driven: [...((built.document as any).driven ?? []), ...fadeDrivenSets(built)], animations: {} } as Record<string, any>;
  const textures = new Map<string, any>(built.images as any);
  // The side regions (fists) use their real art (the wrist join cuts it); the head a blank opaque stand-in.
  for (const r of preset.regions) {
    if (!r.bone.endsWith("_l")) {
      textures.set(r.texture, { width: r.crop[2], height: r.crop[3], data: new Uint8Array(r.crop[2] * r.crop[3] * 4).fill(255) });
      continue;
    }
    const src = readPng(resolve(__dirname, "../../../fixtures/canonical", r.image));
    const [x0, y0, w, h] = r.crop;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (r.keep && !pointInPolygon([x0 + x + 0.5, y0 + y + 0.5], r.keep as [number, number][])) continue;
      const o = ((y0 + y) * src.width + x0 + x) * 4;
      data.set(src.data.subarray(o, o + 4), (y * w + x) * 4);
    }
    textures.set(r.texture, { width: w, height: h, data });
  }
  const centre = Object.fromEntries(preset.regions.filter((r) => !r.bone.endsWith("_l")).map((r) => [r.texture, { image: { width: preset.canvas.width, height: preset.canvas.height, data: new Uint8Array(preset.canvas.width * preset.canvas.height * 4).fill(255) }, crop: r.crop }]));
  const m = mirrorRig(doc, textures, preset.mirror!, centre);
  // as the CLI: rigid regions trim strokes only under their opaque art
  for (const bySlot of Object.values(m.doc.skins.body.attachments as Record<string, Record<string, any>>)) for (const att of Object.values(bySlot)) {
    if (att.type !== "region") continue;
    const img = m.textures.get(att.path);
    const outline = img ? opaqueOutline(img) : null;
    if (outline) att.opaque = outline;
  }
  it("mirrors: torso welded, each arm a detached reflected sheet with its closure contour", () => {
    expect(m.doc.skins.body.attachments.upper_arm_r.arm.groups).toHaveProperty("forearm_r");
    expect(m.doc.skins.body.contours.upper_arm_r.cap.coverUnder).toBe("torso");
    expect(m.doc.skins.body.contours.upper_arm_r.cap.mesh.slot).toBe("upper_arm_r");
    expect(m.meshes["upper_arm/arm"]?.far).toBe("upper_arm_r/arm");
    expect(m.meshes["torso/skin"]?.centre.length).toBeGreaterThan(1);
    const anim = loadAnimDocument(m.doc);
    expect(sheetGate(anim, ["torso/skin", "upper_arm/arm", "upper_arm_r/arm"]).ok).toBe(true);
  });
  it("inks the closing edge only where it leaves the torso; a missing coverUnder must fail", () => {
    const anim = loadAnimDocument(m.doc);
    const con = [{ closure: "upper_arm/cap", arm: "upper_arm/arm", under: "torso/skin", pivot: "upper_arm_l", clearance: 6 }];
    const poses = [-60, -20, 0, 45, 90].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a } }));
    expect(inkGate(anim, con, ["upper_arm/outline_front"], poses).ok).toBe(true);
    const bad = structuredClone(m.doc);
    delete bad.skins.body.contours.upper_arm.cap.coverUnder;
    expect(inkGate(loadAnimDocument(bad), con, ["upper_arm/outline_front"], poses).ok).toBe(false);
    //: the raised arm's outer edge must not run on over the shoulder (raise 105 stray line).
    const raised = [90, 105].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a, clavicle_l: 6 } }));
    expect(inkGate(anim, con, [], raised, ["upper_arm/outline", "upper_arm/underside"]).ok).toBe(true);
    const stray = structuredClone(m.doc);
    delete stray.skins.body.contours.upper_arm.outline.coverUnder;
    expect(inkGate(loadAnimDocument(stray), con, [], raised, ["upper_arm/outline", "upper_arm/underside"]).ok).toBe(false);
    const sk = poseSkeleton(anim);
    applyPose(sk, { name: "rest", rotate: {} });
    expect(sk.activeContours.some((c) => c.coverUnder === "torso")).toBe(true);
  });
  it("keeps both arm edges inked over the chest in across poses; dropping the front inner edge must fail", () => {
    const chains = (d: any) => {
      const across = (p: { rotate: Record<string, number> }) => (p.rotate.upper_arm_l ?? 0) <= -20;
      return [
        { name: "outer", contours: ["upper_arm/outline_front", "upper_arm/outline", "upper_arm/cap_front", "forearm/outline"], under: "torso/skin", skip: "hand", across },
        { name: "inner", contours: ["upper_arm/underside_front", "upper_arm/underside", "upper_arm/cap_front", "forearm/outline"], under: "torso/skin", skip: "hand", across }
      ].filter(() => d);
    };
    const poses = [-20, -40, -60].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a } }));
    expect(edgeContinuityGate(loadAnimDocument(m.doc), m.textures, chains(1), poses).ok).toBe(true);
    const bad = structuredClone(m.doc);
    bad.skins.body.contours.upper_arm.underside_front.points = bad.skins.body.contours.upper_arm.underside_front.points.slice(0, 3);
    expect(edgeContinuityGate(loadAnimDocument(bad), m.textures, chains(1), poses).ok).toBe(false);
  });
  it("outlines the torso silhouette wherever an arm leaves it exposed; a broken torso outline must fail", () => {
    const poses = [-20, -40, -60].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a, upper_arm_r: -a } }));
    const refs = Object.keys(m.doc.skins.body.contours.torso).map((n) => `torso/${n}`);
    expect(torsoOutlineGate(loadAnimDocument(m.doc), m.textures, "torso", "torso/skin", refs, poses).ok).toBe(true);
    const bad = structuredClone(m.doc);
    for (const c of Object.values(bad.skins.body.contours.torso) as any[]) c.points = c.points.slice(0, Math.ceil(c.points.length / 2));
    expect(torsoOutlineGate(loadAnimDocument(bad), m.textures, "torso", "torso/skin", refs, poses).ok).toBe(false);
  });
  it("ends every line over the body at full ink (round joins, hand-over bridges); dropping the torso outline must fail", () => {
    // The test rig has no correctives (buildSurface only): raise 90 is gated on the real rig by the CLI.
    const poses = [0, 15, 45, -40].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a, upper_arm_r: -a } }));
    const pivots = ["upper_arm_l", "upper_arm_r"];
    const good = lineEndGate(loadAnimDocument(m.doc), m.textures, pivots, poses);
    expect(good.ok, good.detail).toBe(true);
    // No torso line for the arm's trimmed ends to join or hand over to: they fade over the torso.
    const bad = structuredClone(m.doc);
    delete bad.skins.body.contours.torso;
    const broken = lineEndGate(loadAnimDocument(bad), m.textures, pivots, poses);
    expect(broken.ok, broken.detail).toBe(false);
    expect(broken.detail).toMatch(/upper_arm/);
  });
  it("inward folds: no open crease end, no feathered line end; no torso line must fail", () => {
    const folds = [-30, -60, -85].flatMap((e) => [0, 15].map((a) => ({ name: `raise ${a} fold ${e}`, rotate: { upper_arm_l: a, upper_arm_r: -a, forearm_l: e, forearm_r: -e } })));
    const elbows = ["forearm_l", "forearm_r"];
    const good = openEndGate(loadAnimDocument(m.doc), elbows, folds);
    expect(good.ok, good.detail).toBe(true);
    // The damaged control (the fold's OR fader group dropped must fail) runs in the CLI on the
    // corrected rig: this buildSurface rig has no correctives, so its folded inner elbow stays at the
    // silhouette beside the torso and no crease end lies inside the skin.
    // Line ends at the elbows in the fold poses: clean, and fail without the torso line.
    const pivots = ["upper_arm_l", "upper_arm_r", ...elbows];
    // (The clean fold line ends are gated on the corrected rig by the CLI: without correctives this
    // rig's folded elbow shows trim feathers, as raise 90 does.)
    const bare = structuredClone(m.doc);
    delete bare.skins.body.contours.torso;
    expect(lineEndGate(loadAnimDocument(bare), m.textures, pivots, folds).ok).toBe(false);
  });
  it("joins forearm and fist strokes in every across pose; dropped joins or the raw fist art must fail", () => {
    const fist = preset.regions.find((r) => r.keep && r.bone.endsWith("_l"))!;
    const joined = structuredClone(m.doc);
    const tex = new Map(m.textures);
    const lines = joinExtremities(joined, tex, [
      { slot: fist.slot, keep: fist.keep! },
      { slot: m.slots[fist.slot]!, keep: fist.keep!.map(([x, y]) => [2 * preset.mirror!.x - x!, y!]) }
    ]);
    expect(lines.every((l) => / 2 joins/.test(l))).toBe(true);
    const sides = [{ slots: ["upper_arm", "forearm", fist.slot], hand: fist.slot }];
    const poses = [0, -20, -40, -60].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a } }));
    const good = wristGate(loadAnimDocument(joined), tex, sides, poses);
    expect(good.ok, good.detail).toBe(true);
    const noJoins = structuredClone(joined);
    noJoins.skins.body.contourJoins = [];
    expect(wristGate(loadAnimDocument(noJoins), tex, sides, poses).ok).toBe(false);
    expect(wristGate(loadAnimDocument(m.doc), m.textures, sides, poses).ok).toBe(false);
  });
  it("draws the front arm wholly over the back arm when crossed; the back arm drawn on top must fail", () => {
    const near = (m.doc.slots as any[]).filter((s) => m.slots[s.name] && m.slots[s.name] !== s.name).map((s) => s.name as string);
    const far = near.map((n) => m.slots[n] as string);
    const poses = [-40, -60].map((a) => ({ name: `${a}`, rotate: { upper_arm_l: a, upper_arm_r: -a } }));
    const rect = [300, 640, 784, 1010] as const;
    const fist = preset.regions.find((r) => r.keep && r.bone.endsWith("_l"))!;
    const joined = structuredClone(m.doc);
    const tex = new Map(m.textures);
    joinExtremities(joined, tex, [
      { slot: fist.slot, keep: fist.keep! },
      { slot: m.slots[fist.slot]!, keep: fist.keep!.map(([x, y]) => [2 * preset.mirror!.x - x!, y!]) }
    ]);
    const good = crossedArmsGate(loadAnimDocument(joined), tex, far, near, poses, rect);
    expect(good.ok, good.detail).toBe(true);
    const swapped = structuredClone(joined);
    const moved = (swapped.slots as any[]).filter((s) => near.includes(s.name));
    const rest = (swapped.slots as any[]).filter((s) => !near.includes(s.name));
    const at = Math.max(...far.map((n) => rest.findIndex((s) => s.name === n)));
    swapped.slots = [...rest.slice(0, at + 1), ...moved, ...rest.slice(at + 1)];
    expect(crossedArmsGate(loadAnimDocument(swapped), tex, far, near, poses, rect).ok).toBe(false);
  });
  it("deriveBodyContours leaves declared buried edges and closure contours uninked", () => {
    const d = structuredClone(m.doc);
    const before = Object.keys(d.skins.body.contours.upper_arm ?? {}).length;
    const added = deriveBodyContours(d, "body", "upper_arm", "arm", [[0, 1]]);
    for (const a of added) expect(a.points.slice(0, 2)).not.toEqual([0, 1]);
    expect(Object.keys(d.skins.body.contours.upper_arm).length).toBe(before + added.length);
  });
});
