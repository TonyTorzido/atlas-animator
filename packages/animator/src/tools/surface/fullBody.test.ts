import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPreset, surfacePresetSchema } from "./preset.js";
import { fullBodyProblems, fullBodySchema, loadFullBody, loadPart, partSlots } from "./fullBody.js";

const canonical = (f: string) => resolve(__dirname, "../../../fixtures/canonical", f);
const BODY = canonical("template7-fullbody-test.body.json");

describe("full-body non-mirrored preset (phase 2b milestone 1)", () => {
  const body = loadFullBody(BODY);
  it("loads several chains as ordinary single-chain surface presets that inherit the canvas", () => {
    expect(body.parts.map((p) => [p.spec.name, p.spec.depth, p.spec.kind])).toEqual([
      ["near_arm", "near", "arm"],
      ["far_arm", "far", "arm"],
      ["far_leg", "far", "leg"],
      ["near_leg", "near", "leg"]
    ]);
    for (const p of body.parts) {
      expect(p.preset.mirror).toBeUndefined();
      expect(p.preset.canvas).toEqual(body.spec.canvas);
      expect(p.preset.figureHeight).toBe(body.spec.figureHeight);
      expect(p.preset.gamePixels).toBe(body.spec.gamePixels);
    }
  });
  it("a part equals its mirrored source preset minus the mirror rule (same chain, sheets, outline)", () => {
    const src = loadPreset(canonical("template7-armlayer.preset.json"));
    const near = body.parts[0]!.preset;
    const { mirror: _m, name: _n, description: _d, ...rest } = src;
    const { name: _n2, description: _d2, ...nearRest } = near;
    expect(nearRest).toEqual(rest);
    expect(near.assembly?.sheets).toHaveLength(1);
  });
  it("the mirrored presets still load unchanged with their mirror rule", () => {
    for (const f of ["template7-armlayer.preset.json", "template7-leg.preset.json", "template7-shoulder.preset.json"]) {
      const raw = JSON.parse(readFileSync(canonical(f), "utf8"));
      const p = loadPreset(canonical(f));
      expect(p.mirror?.x).toBe(raw.mirror.x);
      expect(surfacePresetSchema.parse(raw)).toEqual(p);
    }
  });

  const parts = body.parts.map((p) => ({ spec: p.spec, preset: structuredClone(p.preset) }));
  const problems = (edit: (ps: typeof parts) => void) => {
    const ps = structuredClone(parts);
    edit(ps);
    return fullBodyProblems(ps).join("; ");
  };
  it("accepts the fixture", () => expect(fullBodyProblems(parts)).toEqual([]));
  it("rejects a mirrored part", () => expect(problems((ps) => (ps[2]!.preset.mirror = { x: 542, rename: [["_l", "_r"]], slots: {}, feather: 24 }))).toMatch(/never mirrored/));
  it("rejects a bone that differs between parts (one shared skeleton)", () => expect(problems((ps) => (ps[2]!.preset.bones.find((b) => b.parent === undefined && b.name !== ps[2]!.preset.base)!.at = [1, 2]))).toMatch(/differs between parts/));
  it("rejects a limb bone in two chains", () => expect(problems((ps) => (ps[2]!.preset.chain.bones = [...ps[0]!.preset.chain.bones]))).toMatch(/is in the chains of/));
  it("rejects a slot built by two parts", () => expect(problems((ps) => (ps[2]!.preset.skin.slot = ps[0]!.preset.skin.slot))).toMatch(/is built by/));
  it("rejects a far part with an assembly and a near arm without one", () => {
    expect(problems((ps) => (ps[2]!.spec.kind = "arm") && (ps[2]!.preset.assembly = ps[0]!.preset.assembly))).toMatch(/far part draws under the torso/);
    expect(problems((ps) => delete ps[0]!.preset.assembly)).toMatch(/near arm carries the torso sheet/);
  });
  it("rejects a partner that is not another part", () => expect(problems((ps) => (ps[0]!.spec.partner = "nope"))).toMatch(/partner/));
  it("a part may not redeclare the inherited canvas", () => {
    const spec = fullBodySchema.parse(JSON.parse(readFileSync(BODY, "utf8")));
    expect(() => loadPart({ ...spec.parts[0]!, file: "template7-armlayer.preset.json" }, spec, canonical("."))).toThrow(/declared by the full body/);
  });
  it("partSlots lists the skin, groups, sheets and regions", () => {
    const s = partSlots(body.parts[0]!.preset);
    expect(s).toContain(body.parts[0]!.preset.skin.slot);
    expect(s).toContain(body.parts[0]!.preset.assembly!.sheets[0]!.slot);
  });
});
