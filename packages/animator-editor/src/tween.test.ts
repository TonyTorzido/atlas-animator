import { readFileSync } from "node:fs";
import { AnimationState, AnimationStateData, loadAnimDocument, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { clipsEquivalent, emptyClip, setRotateKey } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { withStandInWeapon } from "./standInWeapon.js";
import { exportMarks, importMarks, adjustArc, buildPath, clearGenerated, forgetGenerated, generatedKeys, generateTween, isGeneratedKey, listEffectors, markGenerated, pathPoint, spacingAt, spanOf, type TweenOptions } from "./tween.js";

const load = (id: string): AnimDocument => {
  const o = ALL_OUTFITS.find((x) => x.id === id)!;
  const raw = JSON.parse(readFileSync(new URL(`../../../${o.document}`, import.meta.url), "utf8"));
  return loadAnimDocument(o.standInWeapon ? withStandInWeapon(raw) : raw);
};

/** Axe raised at frame 0, swung down at frame 12 (a 30 fps non-looping clip). */
function swingClip(): ClipData {
  let c = emptyClip(1, false);
  for (const [t, v] of [
    [0, { upper_arm_r: -75, forearm_r: -20, hand_r: -10, chest: -6 }],
    [12 / 30, { upper_arm_r: 30, forearm_r: -5, hand_r: 15, chest: 8 }]
  ] as const)
    for (const [bone, deg] of Object.entries(v)) c = setRotateKey(c, bone, t, deg);
  return c;
}
const OPTS: TweenOptions = { a: 0, b: 12, effectors: ["weapon-tip"], bias: 0.25, spacing: "attack" };

function posed(doc: AnimDocument, clip: ClipData, frame: number): Skeleton {
  const rig = { ...doc, animations: { t: clip } } as AnimDocument;
  const sk = new Skeleton(rig);
  sk.setToSetupPose();
  const st = new AnimationState(new AnimationStateData(rig));
  st.setAnimation(0, "t", { loop: false });
  st.update(frame / (clip.fps ?? 30));
  st.apply(sk);
  sk.updateWorldTransform("reset");
  return sk;
}

describe("spacing presets", () => {
  it("run from 0 to 1 and never go backwards", () => {
    for (const id of ["linear", "ease-in", "ease-out", "slow-in-out", "attack"] as const) {
      expect(spacingAt(id, 0)).toBeCloseTo(0, 6);
      expect(spacingAt(id, 1)).toBeCloseTo(1, 6);
      let last = -1;
      for (let i = 0; i <= 50; i++) {
        const q = spacingAt(id, i / 50);
        expect(q).toBeGreaterThanOrEqual(last - 1e-9);
        expect(q).toBeLessThanOrEqual(1 + 1e-9);
        last = q;
      }
    }
  });
  it("attack holds first and snaps in the middle", () => {
    expect(spacingAt("attack", 0.3)).toBeLessThan(0.06);
    expect(spacingAt("attack", 0.72) - spacingAt("attack", 0.4)).toBeGreaterThan(0.8);
    expect(spacingAt("ease-in", 0.5)).toBeLessThan(0.5);
    expect(spacingAt("ease-out", 0.5)).toBeGreaterThan(0.5);
  });
});

describe("path", () => {
  it("passes through the waypoints and bows away from the root", () => {
    const path = buildPath([0, 6, 12], [[0, 0], [100, 0], [200, 50]], [[0, 100], [0, 100], [0, 100]], [0, 0, 0], 0.3);
    expect(pathPoint(path, 0, 0)).toEqual([0, 0]);
    expect(pathPoint(path, 0, 1)[0]).toBeCloseTo(100, 6);
    expect(pathPoint(path, 1, 1)[1]).toBeCloseTo(50, 6);
    expect(pathPoint(path, 0, 0.5)[1]).toBeLessThan(-5); // the root is below (y 100): the bow goes up
    expect(spanOf(path, 9)).toEqual({ j: 1, p: 0.5 });
  });
});

describe.each(["turned-l-axe"])("arc in-betweens on %s", (id) => {
  const doc = load(id);
  const clip = swingClip();
  const before = JSON.stringify(clip);

  it("lists the weapon tip, fists and feet", () => {
    const ids = listEffectors(doc).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["weapon-tip", "hand-l", "hand-r", "foot-l", "foot-r"]));
  });

  it("lands the weapon tip on the spline (1 px) at every generated frame, and keeps limbs rigid", () => {
    const r = generateTween(doc, "t", clip, OPTS);
    expect(r.keys).toBe(33); // 11 frames x 3 bones
    expect(r.maxError).toBeLessThan(1);
    const plan = r.plans[0]!;
    const unreachable = new Set(r.violations.filter((v) => v.rule === "unreachable").map((v) => v.frame));
    expect(plan.generated.length - unreachable.size).toBeGreaterThanOrEqual(8);
    const setup = new Skeleton(doc);
    setup.setToSetupPose();
    setup.updateWorldTransform("reset");
    const len = (sk: Skeleton, a: string, b: string) => Math.hypot(sk.findBone(a)!.world.x - sk.findBone(b)!.world.x, sk.findBone(a)!.world.y - sk.findBone(b)!.world.y);
    for (const f of plan.generated.filter((x) => !unreachable.has(x))) {
      const sk = posed(doc, r.clip, f);
      const tip = sk.findSlot("weapon_tip")!.bone.localToWorld(290, 0, { x: 0, y: 0 });
      const want = plan.planned[f]!;
      expect(Math.hypot(tip.x - want.x, tip.y - want.y)).toBeLessThan(1);
      expect(len(sk, "upper_arm_r", "forearm_r")).toBeCloseTo(len(setup, "upper_arm_r", "forearm_r"), 6);
      expect(len(sk, "forearm_r", "hand_r")).toBeCloseTo(len(setup, "forearm_r", "hand_r"), 6);
    }
  });

  it("pins a chain bone that had no key at the range ends, so the pose at the ends does not change", () => {
    const noHand = swingClip();
    delete noHand.bones.hand_r;
    const r = generateTween(doc, "t", noHand, OPTS);
    expect(r.keys).toBe(35); // 33 + two pins
    for (const f of [0, 12]) {
      const a = posed(doc, noHand, f).findBone("hand_r")!.world;
      const b = posed(doc, r.clip, f).findBone("hand_r")!.world;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-3);
    }
  });

  it("bows the tip path off the straight chord when the bias is set, and not when it is 0", () => {
    const bowed = generateTween(doc, "t", clip, OPTS).plans[0]!;
    const plain = generateTween(doc, "t", clip, { ...OPTS, bias: 0 }).plans[0]!;
    const sag = (pts: { x: number; y: number }[]) => {
      const a = pts[0]!;
      const z = pts[pts.length - 1]!;
      const L = Math.hypot(z.x - a.x, z.y - a.y);
      return Math.max(...pts.map((p) => Math.abs((z.x - a.x) * (a.y - p.y) - (a.x - p.x) * (z.y - a.y)) / L));
    };
    expect(sag(bowed.planned)).toBeGreaterThan(sag(plain.planned) + 5);
  });

  it("leaves keys outside the range, other bones and the source clip untouched", () => {
    const r = generateTween(doc, "t", clip, OPTS);
    expect(JSON.stringify(clip)).toBe(before);
    expect(r.clip.bones.chest).toEqual(clip.bones.chest);
    for (const bone of ["upper_arm_r", "forearm_r", "hand_r"]) {
      for (const k of clip.bones[bone]!.rotate!) expect(r.clip.bones[bone]!.rotate).toContainEqual(k);
    }
    const partial = generateTween(doc, "t", clip, { ...OPTS, a: 3, b: 9 });
    for (const bone of ["upper_arm_r", "forearm_r", "hand_r"]) {
      const times = partial.clip.bones[bone]!.rotate!.map((k) => Math.round(k.time * 30));
      expect(times.filter((f) => f < 3 || f > 9)).toEqual([0, 12]);
    }
  });

  it("bakes breakdowns only at the chosen frames, and every N frames", () => {
    expect(generateTween(doc, "t", clip, { ...OPTS, frames: [4, 8] }).plans[0]!.generated).toEqual([4, 8]);
    expect(generateTween(doc, "t", clip, { ...OPTS, step: 3 }).plans[0]!.generated).toEqual([3, 6, 9]);
    expect(generateTween(doc, "t", clip, { ...OPTS, skip: [5] }).plans[0]!.generated).not.toContain(5);
  });

  it("marks generated keys, and clearing removes exactly them and restores the clip", () => {
    forgetGenerated();
    const r = generateTween(doc, "t", clip, OPTS);
    markGenerated("t", r.clip, r);
    expect(generatedKeys("t", r.clip)).toHaveLength(33);
    expect(isGeneratedKey("t", r.clip, "upper_arm_r", 5 / 30)).toBe(true);
    expect(isGeneratedKey("t", r.clip, "upper_arm_r", 0)).toBe(false);
    const edited = setRotateKey(r.clip, "upper_arm_r", 5 / 30, 1); // the user re-keys one
    expect(generatedKeys("t", edited)).toHaveLength(32);
    const cleared = clearGenerated("t", r.clip);
    expect(cleared.removed).toBe(33);
    expect(clipsEquivalent(cleared.clip, clip)).toBe(true);
    expect(JSON.stringify(cleared.clip)).toBe(before);
  });

  it("the markers survive a save and load (a reload)", () => {
    forgetGenerated();
    const r = generateTween(doc, "t", clip, OPTS);
    markGenerated("t", r.clip, r);
    const saved = JSON.parse(JSON.stringify(exportMarks()));
    forgetGenerated();
    expect(generatedKeys("t", r.clip)).toHaveLength(0);
    importMarks(saved);
    expect(generatedKeys("t", r.clip)).toHaveLength(33);
    expect(isGeneratedKey("t", r.clip, "forearm_r", 7 / 30)).toBe(true);
  });

  it("reports rule violations at generated frames, and adjustArc never does worse", () => {
    const wild = { ...OPTS, bias: 1.6 };
    const r = generateTween(doc, "t", clip, wild);
    const adj = adjustArc(doc, "t", clip, wild, r);
    if (r.violations.length) {
      expect(r.violations[0]!.message.length).toBeGreaterThan(0);
      if (adj) expect(adj.result.violations.length).toBeLessThan(r.violations.length);
      const skipped = generateTween(doc, "t", clip, { ...wild, skip: r.flagged });
      expect(skipped.flagged.every((f) => !r.flagged.includes(f))).toBe(true);
    } else expect(adj).toBeNull();
  });
});

describe("arc in-betweens on the pro turned rig", () => {
  const doc = (() => {
    const o = ALL_OUTFITS.find((x) => x.id === "pro-turned")!;
    const raw = JSON.parse(readFileSync(new URL(`../../../${o.document}`, import.meta.url), "utf8"));
    const weapon = raw.slots.find((s: { name: string }) => s.name === "weapon");
    weapon.attachment ??= Object.keys(raw.skins[Object.keys(raw.skins)[0]!].attachments.weapon)[0];
    return loadAnimDocument(raw);
  })();
  let clip = emptyClip(1, false);
  for (const [t, v] of [
    [0, { upper_arm_near: -30, forearm_near: -45, chest: -2 }],
    [12 / 30, { upper_arm_near: 25, forearm_near: 0, chest: 2 }]
  ] as const)
    for (const [bone, deg] of Object.entries(v)) clip = setRotateKey(clip, bone, t, deg);
  const opts: TweenOptions = { a: 0, b: 12, effectors: ["weapon-tip"], bias: 0.3, spacing: "attack" };

  it("lands the tip on the arc and keeps the elbow continuous (no frame-to-frame elbow jump over 30 degrees)", () => {
    const r = generateTween(doc, "t", clip, opts);
    expect(r.maxError).toBeLessThan(1);
    expect(r.flagged).toEqual([]);
    const fore = r.clip.bones.forearm_near!.rotate!.map((k) => k.value);
    for (let i = 1; i < fore.length; i++) expect(Math.abs(fore[i]! - fore[i - 1]!)).toBeLessThan(30);
  });
});
