import { describe, expect, it } from "vitest";
import { emptyClip, frameTime } from "./clipModel.js";
import { applyPoseRecord, makePose, parsePose, poseSummary, scopeDefaults } from "./poseModel.js";

const t = frameTime({ fps: 30 }, 6);

const full = () =>
  makePose({
    name: "full_state",
    bones: { root: { rotate: 3, translate: { x: 1, y: 2 }, scale: { x: 1, y: 1 } }, arm: { rotate: 20, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, shear: { x: 4, y: -2 } } },
    attachments: { eyes: "eyes_closed" },
    drawOrder: [],
    mixes: { ik: { arm_ik: 0.4 }, transform: { tc: { mixRotate: 0.5, mixX: 1 } } },
    colors: { eyes: "ff000080" },
    deform: [{ skin: "default", slot: "hair", attachment: "mesh", offset: 2, vertices: [1, 2, 3] }],
    includes: ["root", "shear", "mixes", "slots", "deforms"]
  });

describe("pose scopes ()", () => {
  it("the full scope turns every box on, selected only bones and shear", () => {
    expect(Object.values(scopeDefaults("full")).every(Boolean)).toBe(true);
    expect(scopeDefaults("selected")).toMatchObject({ root: false, mixes: false, slots: false, drawOrder: false, deforms: false, shear: true });
    expect(scopeDefaults("character").root).toBe(false);
  });

  it("round trips root, shear, mixes, colours and deforms through parsePose", () => {
    const p = full();
    expect(parsePose(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(poseSummary(p)).toMatch(/root.*shear.*2 mixes.*1 colours.*1 deforms/);
  });

  it("applying keys root, shear, mixes, colours and deforms at the playhead", () => {
    const r = applyPoseRecord(emptyClip(1, false), full(), t);
    const c = r.clip;
    expect(c.bones["root"]?.rotate?.[0]?.value).toBeCloseTo(3);
    expect(c.bones["arm"]?.shear?.[0]).toMatchObject({ x: 4, y: -2 });
    expect(c.ik["arm_ik"]?.[0]?.mix).toBeCloseTo(0.4);
    expect(c.transform["tc"]?.[0]?.mixRotate).toBeCloseTo(0.5);
    expect(c.slots["eyes"]?.color?.[0]?.color).toBe("ff000080");
    expect(c.deform["default"]?.["hair"]?.["mesh"]?.[0]).toMatchObject({ offset: 2, vertices: [1, 2, 3] });
    expect(r.extras).toEqual({ mixes: 2, colors: 1, deforms: 1 });
  });

  it("skips constraints and slots the target rig lacks, and an old pose still parses", () => {
    const r = applyPoseRecord(emptyClip(1, false), full(), t, { knownBones: new Set(["arm"]), knownSlots: new Set(["eyes"]), knownConstraints: new Set(["tc"]) });
    expect(r.skipped).toEqual(expect.arrayContaining(["bone root", "ik arm_ik", "deform hair/mesh"]));
    const old = parsePose({ format: "atlas-pose@1", name: "old", bones: { arm: { rotate: 1, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } } }, attachments: {}, drawOrder: [] });
    expect(old.mixes).toBeUndefined();
    expect(() => parsePose({ ...full(), colors: { eyes: "red" } })).toThrow(/colour/);
  });
});
