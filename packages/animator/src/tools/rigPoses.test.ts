import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { FORMAT_ID, type AnimDocumentInput } from "../core/format.js";
import { inferRoles, rigPoses } from "./rigPoses.js";

// A side-view quadruped skeleton: hips -> chest along +x, tail back off the hips, neck/head up and
// forward off the chest, two legs off each. One region slot per bone so every bone deforms.
function quadruped(extra: Partial<Record<string, Record<string, unknown>>> = {}): AnimDocumentInput {
  const bones: Record<string, unknown>[] = [
    { name: "root" },
    { name: "hips", parent: "root", length: 60, x: -40, y: -80 },
    { name: "chest", parent: "hips", length: 60, x: 60 },
    { name: "neck", parent: "chest", length: 30, x: 60, rotation: -40 },
    { name: "skull", parent: "neck", length: 30, x: 30, rotation: 20 },
    { name: "tail_1", parent: "hips", length: 30, rotation: 170 },
    { name: "tail_2", parent: "tail_1", length: 30, x: 30 },
    { name: "fl_upper", parent: "chest", length: 35, x: 50, rotation: 90 },
    { name: "fl_lower", parent: "fl_upper", length: 35, x: 35 },
    { name: "fr_upper", parent: "chest", length: 35, x: 45, rotation: 90 },
    { name: "fr_lower", parent: "fr_upper", length: 35, x: 35 },
    { name: "bl_upper", parent: "hips", length: 38, x: 5, rotation: 90 },
    { name: "bl_lower", parent: "bl_upper", length: 36, x: 38 },
    { name: "br_upper", parent: "hips", length: 38, x: 10, rotation: 90 },
    { name: "br_lower", parent: "br_upper", length: 36, x: 38 },
    { name: "paw_target", parent: "root" }
  ].map((b) => ({ ...b, ...(extra[b["name"] as string] ?? {}) }));
  const deforming = bones.filter((b) => b["name"] !== "root" && b["name"] !== "paw_target");
  return {
    format: FORMAT_ID,
    name: "quadruped",
    canvas: { width: 300, height: 200, originX: 150, originY: 190 },
    bones,
    slots: deforming.map((b) => ({ name: b["name"] as string, bone: b["name"] as string })),
    skins: { body: { attachments: Object.fromEntries(deforming.map((b) => [b["name"] as string, { [b["name"] as string]: { type: "region", path: "p", width: 10, height: 10 } }])) } }
  } as unknown as AnimDocumentInput;
}

describe("rig-agnostic review poses", () => {
  it("infers spine, limbs, head and tail on a quadruped without any bone-name convention", () => {
    const { roles } = inferRoles(loadAnimDocument(quadruped()));
    expect(Object.fromEntries(roles)).toMatchObject({
      hips: "spine",
      chest: "spine",
      neck: "head",
      skull: "head",
      tail_1: "tail",
      tail_2: "tail",
      fl_upper: "limb",
      fl_lower: "limb",
      br_upper: "limb",
      br_lower: "limb"
    });
    expect(roles.has("root")).toBe(false);
    expect(roles.has("paw_target")).toBe(false);
  });

  it("a declared role wins and is inherited by descendants", () => {
    const { roles } = inferRoles(loadAnimDocument(quadruped({ tail_1: { role: "limb" } })));
    expect(roles.get("tail_1")).toBe("limb");
    expect(roles.get("tail_2")).toBe("limb");
  });

  it("every posed bone reaches both ends of its range (limits, else the role default)", () => {
    const doc = loadAnimDocument(quadruped({ fl_lower: { limits: { min: -5, max: 80 } } }));
    const poses = rigPoses(doc);
    const { roles } = inferRoles(doc);
    for (const bone of roles.keys()) {
      const values = poses.map((p) => p.rotate[bone] ?? 0);
      const limits = doc.bones.find((b) => b.name === bone)?.limits;
      expect(Math.max(...values), bone).toBe(limits ? limits.max : bone.startsWith("tail") ? 30 : /upper|lower/.test(bone) ? 45 : bone === "neck" || bone === "skull" ? 15 : 8);
      expect(Math.min(...values), bone).toBe(limits ? limits.min : -Math.max(...values));
    }
    expect(poses.map((p) => p.name)).toContain("limb depth 1 max");
    expect(poses.map((p) => p.name)).toContain("stride");
  });

  it("multi-bone poses respect the per-chain cumulative bend cap; joints still reach their own ends", () => {
    const wide = { limits: { min: -40, max: 40 } };
    const cumulative = (rotate: Record<string, number>, bones: string[]) => bones.reduce((sum, b) => sum + Math.abs(rotate[b] ?? 0), 0);
    // Default spine cap 30: hips + chest at 40 each would stack to 80.
    let doc = loadAnimDocument(quadruped({ hips: wide, chest: wide, neck: wide, skull: wide }));
    let poses = rigPoses(doc);
    // The cap binds poses that move two or more bones of a chain; a joint alone may reach its own limit.
    const both = (rotate: Record<string, number>, bones: string[]) => bones.every((b) => (rotate[b] ?? 0) !== 0);
    for (const pose of poses) {
      if (both(pose.rotate, ["hips", "chest"])) expect(cumulative(pose.rotate, ["hips", "chest"]), pose.name).toBeLessThanOrEqual(30 + 1e-9);
      if (both(pose.rotate, ["neck", "skull"])) expect(cumulative(pose.rotate, ["neck", "skull"]), pose.name).toBeLessThanOrEqual(30 + 1e-9);
    }
    for (const bone of ["hips", "chest", "neck", "skull"]) {
      expect(Math.max(...poses.map((p) => p.rotate[bone] ?? 0)), bone).toBe(40);
      expect(Math.min(...poses.map((p) => p.rotate[bone] ?? 0)), bone).toBe(-40);
    }
    expect(poses.find((p) => p.name === "spine curl")?.rotate).toEqual({ hips: 15, chest: 15 });
    // The document's budgets.bend overrides the default; options override the document.
    doc = loadAnimDocument({ ...quadruped({ hips: wide, chest: wide }), budgets: { bend: { spine: 50 } } } as AnimDocumentInput);
    expect(rigPoses(doc).find((p) => p.name === "spine curl")?.rotate).toEqual({ hips: 25, chest: 25 });
    poses = rigPoses(doc, { bend: { spine: 80 } });
    expect(poses.find((p) => p.name === "spine curl")?.rotate).toEqual({ hips: 40, chest: 40 });
    // Limbs are uncapped by default: a limb curl is every joint at its limit.
    expect(poses.find((p) => p.name === "limb curl")?.rotate["fl_lower"]).toBe(45);
  });

  it("every root tree gets chains, with its non-deforming controllers posed (item 4)", () => {
    // A second, smaller root tree: a bare root, a non-deforming controller hub, two two-bone arms.
    const raw = quadruped() as unknown as { bones: Record<string, unknown>[]; slots: Record<string, unknown>[]; skins: { body: { attachments: Record<string, unknown> } } };
    raw.bones.push({ name: "prop_root" }, { name: "prop_ctrl", parent: "prop_root", length: 10 });
    for (const side of ["a", "b"]) {
      raw.bones.push({ name: `prop_${side}`, parent: "prop_ctrl", length: 20, rotation: side === "a" ? 30 : -30 }, { name: `prop_${side}2`, parent: `prop_${side}`, length: 20, x: 20 });
      for (const name of [`prop_${side}`, `prop_${side}2`]) {
        raw.slots.push({ name, bone: name });
        raw.skins.body.attachments[name] = { [name]: { type: "region", path: "p", width: 10, height: 10 } };
      }
    }
    const doc = loadAnimDocument(raw as unknown as AnimDocumentInput);
    const { roles, chains } = inferRoles(doc);
    expect(roles.get("prop_ctrl")).toBe("spine");
    expect(roles.get("prop_a2")).toBe("limb");
    const arms = chains.filter((c) => c.path[0] === "prop_a" || c.path[0] === "prop_b");
    expect(arms).toHaveLength(2);
    expect(chains[chains.indexOf(arms[0] as (typeof chains)[number])]?.twin).toBe(chains.indexOf(arms[1] as (typeof chains)[number]));
    // The first tree is unchanged.
    expect(chains.find((c) => c.role === "spine")?.path).toEqual(["hips", "chest"]);
    const poses = rigPoses(doc);
    expect(Math.max(...poses.map((p) => p.rotate["prop_a2"] ?? 0))).toBe(45);
  });

  it("an unbranched rig (the canonical creature leg) is one limb", () => {
    const raw = JSON.parse(readFileSync(new URL("../../fixtures/canonical/creature-leg/creature-leg.anim.json", import.meta.url), "utf8"));
    const doc = loadAnimDocument(raw);
    const { roles, chains } = inferRoles(doc);
    expect(chains).toHaveLength(1);
    expect([...new Set(roles.values())]).toEqual(["limb"]);
    expect(rigPoses(doc).length).toBeGreaterThan(4);
  });

  describe("head chain ()", () => {
    // The quadruped with two ear bones on the skull: the walked spine would run on through neck and
    // skull (the skull branches); it must end at the chest (the last hub with a twin pair of 2+-bone
    // chains) and neck + skull + ears become the head chain.
    const withEars = (extra: Partial<Record<string, Record<string, unknown>>> = {}) => {
      const doc = quadruped(extra) as unknown as { bones: Record<string, unknown>[]; slots: Record<string, unknown>[]; skins: { body: { attachments: Record<string, unknown> } } };
      for (const [name, rotation] of [["ear_a", -60], ["ear_b", -100]] as const) {
        doc.bones.push({ name, parent: "skull", length: 14, x: 20, rotation, ...(extra[name] ?? {}) });
        doc.slots.push({ name, bone: name });
        doc.skins.body.attachments[name] = { [name]: { type: "region", path: "p", width: 10, height: 10 } };
      }
      return loadAnimDocument(doc as unknown as AnimDocumentInput);
    };

    it("capped side branches reach their own limits (item 2)", () => {
      // Head chain capped at 30 degrees; the ears are side members with +-80: the curl is scaled to
      // the cap, so they need their own endpoint probes.
      const doc = withEars({ ear_a: { limits: { min: -80, max: 80 } }, ear_b: { limits: { min: -80, max: 80 } } });
      const poses = rigPoses(doc);
      for (const ear of ["ear_a", "ear_b"]) {
        const values = poses.map((p) => p.rotate[ear] ?? 0);
        expect(Math.max(...values), ear).toBe(80);
        expect(Math.min(...values), ear).toBe(-80);
      }
      expect(poses.map((p) => p.name)).toContain("head side 0 max");
    });

    it("ends the spine at the last twin hub; neck, skull and ears are the head chain", () => {
      const { roles, chains } = inferRoles(withEars());
      expect(chains.find((c) => c.role === "spine")?.path).toEqual(["hips", "chest"]);
      const head = chains.filter((c) => c.role === "head");
      expect(head).toHaveLength(1);
      expect(head[0]?.path).toEqual(["neck", "skull"]);
      expect([...(head[0]?.members ?? [])].sort()).toEqual(["ear_a", "ear_b", "neck", "skull"]);
      for (const bone of ["neck", "skull", "ear_a", "ear_b"]) expect(roles.get(bone), bone).toBe("head");
      expect(roles.get("fl_upper")).toBe("limb");
      expect(roles.get("tail_2")).toBe("tail");
    });

    it("a declared role head re-chains: the spine is cut at the declaring bone", () => {
      // Declared on the chest: the spine is hips only, the chest's subtree (front legs included)
      // is the head chain's membership.
      const { chains } = inferRoles(withEars({ chest: { role: "head" } }));
      expect(chains.find((c) => c.role === "spine")?.path).toEqual(["hips"]);
      const head = chains.find((c) => c.role === "head");
      expect(head?.path[0]).toBe("chest");
      expect(head?.members).toContain("skull");
    });
  });
});
