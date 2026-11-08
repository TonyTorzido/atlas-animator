import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton, type AnimDocument } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { parseClip } from "./clipModel.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { clipGates, poseGates } from "./gates.js";
import { EYE_PLACEHOLDERS_ALLOWED, EYES_WIDEN_TOLERANCE, FIST_DETACH_TOLERANCE, poseRuleHits, referenceOf, type RuleHit } from "./poseRules.js";

const load = (id: string): AnimDocument => {
  const o = ALL_OUTFITS.find((x) => x.id === id)!;
  const raw = JSON.parse(readFileSync(new URL(`../../../${o.document}`, import.meta.url), "utf8")) as { slots: { name: string; attachment?: string }[]; skins: Record<string, { attachments: Record<string, Record<string, unknown>> }> };
  // The pro rigs ship without clips and without a default weapon: show the first weapon attachment, as the editor does when it mounts one.
  const weapon = raw.slots.find((s) => s.name === "weapon")!;
  weapon.attachment ??= Object.keys(raw.skins[Object.keys(raw.skins)[0]!]!.attachments.weapon!)[0]!;
  return loadAnimDocument(raw);
};
/** The rigs ship no clips: a still one-second clip stands in for "the committed clip". */
const STILL = { duration: 1, loop: false, bones: {} };

const NEW_RULES = ["fist on own arm", "weapon across face", "eyes widen"];

/** A skeleton at setup with its reference, and a `hits()` of the new rules after `pose` edits. */
function rig(id: string) {
  const doc = load(id);
  const skeleton = new Skeleton(doc);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("reset");
  const reference = referenceOf(skeleton);
  const hits = (edit?: (s: Skeleton) => void): RuleHit[] => {
    skeleton.setToSetupPose();
    edit?.(skeleton);
    skeleton.updateWorldTransform("reset");
    return poseRuleHits(skeleton, reference).filter((h) => NEW_RULES.includes(h.rule));
  };
  return { skeleton, reference, hits };
}

describe.each(["pro-front", "pro-turned"])("new pose rules on %s", (id) => {
  const r = rig(id);

  it("builds a face ellipse inside the head", () => {
    expect(r.reference.face).not.toBeNull();
    expect(r.reference.face!.ax).toBeGreaterThan(20);
    expect(r.reference.face!.ay).toBeGreaterThan(20);
  });

  it("is silent on the rest pose", () => {
    expect(r.hits()).toEqual([]);
  });

  it("flags a fist pulled off its forearm, an error on any clip", () => {
    const hits = r.hits((s) => {
      s.getBone("hand_near").pose.x += FIST_DETACH_TOLERANCE + 12;
    });
    expect(hits.some((h) => h.rule === "fist on own arm" && h.severity === "error")).toBe(true);
    // just inside the tolerance is fine
    expect(
      r.hits((s) => {
        s.getBone("hand_far").pose.x += FIST_DETACH_TOLERANCE - 1;
      })
    ).toEqual([]);
  });

  it("flags the hand art riding another bone", () => {
    const hits = r.hits(() => {
      (r.skeleton.getSlot("skin_hand_near") as unknown as { bone: unknown }).bone = r.skeleton.getBone("hand_far");
    });
    expect(hits.some((h) => h.rule === "fist on own arm" && h.message.includes("skin_hand_near"))).toBe(true);
    // put it back for the other tests
    (r.skeleton.getSlot("skin_hand_near") as unknown as { bone: unknown }).bone = r.skeleton.getBone("hand_near");
  });

  it("flags a weapon dragged across the face", () => {
    const face = r.reference.face!;
    const head = r.skeleton.getBone("head").world;
    const target = [head.a * face.cx + head.b * face.cy + head.x, head.c * face.cx + head.d * face.cy + head.y];
    const hits = r.hits((s) => {
      const weapon = s.getBone("weapon");
      // the weapon art's centre now, then move the bone so that centre lands on the face
      const w = weapon.world;
      const slot = s.getSlot("weapon");
      const o = (s.attachments.get(Object.keys(s.document.skins)[0]!, "weapon", slot.placeholder!) as unknown as { offsets: ArrayLike<number> }).offsets;
      const lx = (o[0]! + o[2]! + o[4]! + o[6]!) / 4;
      const ly = (o[1]! + o[3]! + o[5]! + o[7]!) / 4;
      const cx = w.a * lx + w.b * ly + w.x;
      const cy = w.c * lx + w.d * ly + w.y;
      const p = weapon.parent!.world;
      const det = p.a * p.d - p.b * p.c;
      const dx = target[0]! - cx;
      const dy = target[1]! - cy;
      weapon.pose.x += (p.d * dx - p.b * dy) / det;
      weapon.pose.y += (-p.c * dx + p.a * dy) / det;
    });
    expect(hits.some((h) => h.rule === "weapon across face" && h.severity === "error")).toBe(true);
  });

  it("does not flag a hidden weapon slot", () => {

    const hits = r.hits((s) => {
      s.getSlot("weapon").hidden = true;
      s.getBone("weapon").pose.y += 5000;
    });
    expect(hits).toEqual([]);
  });

  it("flags eyes grown past +1% of the head, not a head at 102% nor shrinking", () => {
    // a scaled head carries the eyes with it: only the separate head rule may speak
    const scaledHead = r.hits((s) => (s.getBone("head").pose.scaleX *= 1.02));
    expect(scaledHead.filter((h) => h.rule === "eyes widen")).toEqual([]);
    expect(r.hits((s) => (s.getBone("head").pose.scaleX *= 0.9)).filter((h) => h.rule === "eyes widen")).toEqual([]);
  });

  it("flags an eye swap outside the allowed list, and accepts every allowed one", () => {
    expect(r.hits((s) => (s.getSlot("eyes").placeholder = "eyes_angry")).some((h) => h.rule === "eyes widen" && h.message.includes("eyes_angry"))).toBe(true);
    for (const p of EYE_PLACEHOLDERS_ALLOWED) expect(r.hits((s) => (s.getSlot("eyes").placeholder = p))).toEqual([]);
  });
});

describe("face bones", () => {
  it("flags scale and shear on a bone that carries only face slots", () => {
    const doc = load("pro-front");
    // a synthetic dedicated eyes bone: move the eyes slot onto a new child of the head
    const bones = [...doc.bones, { name: "eyes", parent: "head", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, length: 10 } as never];
    const slots = doc.slots.map((s) => (s.name === "eyes" ? { ...s, bone: "eyes" } : s));
    const skeleton = new Skeleton({ ...doc, bones, slots } as AnimDocument);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform("reset");
    const reference = referenceOf(skeleton);
    const run = (edit: (s: Skeleton) => void): string[] => {
      skeleton.setToSetupPose();
      edit(skeleton);
      skeleton.updateWorldTransform("reset");
      return poseRuleHits(skeleton, reference).filter((h) => h.rule === "eyes widen").map((h) => h.message);
    };
    expect(run(() => undefined)).toEqual([]);
    expect(run((s) => (s.getBone("eyes").pose.scaleX = 1.1)).some((m) => m.includes("scaled"))).toBe(true);
    expect(run((s) => (s.getBone("eyes").pose.shearX = 4)).some((m) => m.includes("sheared"))).toBe(true);
  });
});

describe("gates", () => {
  it.each(["pro-front", "pro-turned"])("a still %s clip raises none of the new rules, whole clip and pose", (id) => {
    const doc = load(id);
    const [name, clip] = ["still", parseClip(STILL)] as const;
    const issues = [...clipGates(doc, name, clip), ...poseGates(doc, name, clip, 0)];
    expect(issues.filter((i) => NEW_RULES.includes(i.kind))).toEqual([]);
  });
});

describe("eyes relative to the head", () => {
  it("flags a dedicated eyes bone grown past +1% of a 102% head, and ignores the head's own 102%", () => {
    const doc = load("pro-front");
    const eyesBone = { ...doc.bones.find((b) => b.name === "head")!, name: "eyes", parent: "head", x: 0, y: 0, length: 10, limits: undefined } as never;
    const bones = doc.bones.flatMap((b) => (b.name === "head" ? [b, eyesBone] : [b]));
    const slots = doc.slots.map((s) => (s.name === "eyes" ? { ...s, bone: "eyes" } : s));
    const skeleton = new Skeleton({ ...doc, bones, slots } as AnimDocument);
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform("reset");
    const reference = referenceOf(skeleton);
    const widen = (edit: (s: Skeleton) => void): boolean => {
      skeleton.setToSetupPose();
      edit(skeleton);
      skeleton.updateWorldTransform("reset");
      return poseRuleHits(skeleton, reference).some((h) => h.rule === "eyes widen" && h.message.startsWith("eyes scaled"));
    };
    expect(widen((s) => (s.getBone("head").pose.scaleX *= 1.02))).toBe(false);
    expect(widen((s) => (s.getBone("eyes").pose.scaleX *= 1.05))).toBe(true);
  });
});

describe.each(["pro-front", "pro-turned"])("old rules read near/far on %s", (id) => {
  const doc = load(id);
  const skeleton = new Skeleton(doc);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("reset");
  const reference = referenceOf(skeleton);
  const OLD = ["arm behind head", "upper arm thrown back", "limb stretch", "limb scale"];
  const run = (edit?: (s: Skeleton) => void): string[] => {
    skeleton.setToSetupPose();
    edit?.(skeleton);
    skeleton.updateWorldTransform("reset");
    return poseRuleHits(skeleton, reference).map((h) => h.rule).filter((r) => OLD.includes(r));
  };
  /** Sweeps a bone's rotation and reports whether any angle fires `rule`. */
  const sweep = (bone: string, rule: string, extra?: (s: Skeleton) => void): boolean => {
    for (let deg = -180; deg < 180; deg += 5) {
      if (run((s) => { extra?.(s); s.getBone(bone).pose.rotation += deg; }).includes(rule)) return true;
    }
    return false;
  };

  it("rest pose is clean", () => {
    expect(run()).toEqual([]);
  });
  it("arm behind head fires for each arm", () => {
    expect(sweep("upper_arm_near", "arm behind head")).toBe(true);
    expect(sweep("upper_arm_far", "arm behind head")).toBe(true);
  });
  it("upper arm thrown back fires on at least one arm of a turned rig (off on the straight front)", () => {
    const fired = sweep("upper_arm_near", "upper arm thrown back") || sweep("upper_arm_far", "upper arm thrown back");
    expect(fired).toBe(id === "pro-turned");
  });
  it("limb stretch fires when a forearm or shin is pulled out", () => {
    expect(run((s) => (s.getBone("forearm_near").pose.x *= 1.2))).toContain("limb stretch");
    expect(run((s) => (s.getBone("hand_far").pose.x *= 1.2))).toContain("limb stretch");
    expect(run((s) => (s.getBone("shin_near").pose.x *= 1.2))).toContain("limb stretch");
  });
  it("limb scale fires on a scaled limb bone", () => {
    expect(run((s) => (s.getBone("thigh_far").pose.scaleX *= 1.1))).toContain("limb scale");
    expect(run((s) => (s.getBone("upper_arm_near").pose.scaleY *= 0.8))).toContain("limb scale");
  });
});
