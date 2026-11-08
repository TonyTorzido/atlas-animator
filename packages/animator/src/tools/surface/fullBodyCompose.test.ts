import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadFullBody } from "./fullBody.js";
import { buildSurface } from "./build.js";
import { fadeDrivenSets } from "./output.js";
import { composeFullBody, type BuiltPart } from "./fullBodyCompose.js";
import { underJoinGate } from "./fullBodyGates.js";
import { loadAnimDocument } from "../../core/formatLoader.js";

const body = loadFullBody(resolve(__dirname, "../../../fixtures/canonical/template7-fullbody-test.body.json"));

describe("full-body composition, non-mirrored (phase 2b milestones 2-3)", () => {
  // the surface build only (no solver bake): enough for composition and the under-join geometry
  const built: BuiltPart[] = body.parts.map((p) => {
    const b = buildSurface(p.preset);
    const raw = { ...(b.document as any), driven: [...((b.document as any).driven ?? []), ...fadeDrivenSets(b)], animations: {} };
    return { spec: p.spec, preset: p.preset, raw, textures: new Map(b.images as any) };
  });
  const c = composeFullBody(body.spec.name, built);
  const order = (c.doc.slots as any[]).map((s) => s.name as string);
  const at = (part: string, k = 0) => order.indexOf((c.slotsOf[part] as string[])[k] as string);
  const sheet = c.sheets[0]!.split("/")[0]!;
  it("draws the far arm under everything, leg skins under the torso, the near arm over it", () => {
    const farArm = c.slotsOf.far_arm!;
    expect(order.slice(0, farArm.length)).toEqual(farArm);
    expect(at("far_leg")).toBeLessThan(at("near_leg"));
    expect(at("near_leg")).toBeLessThan(order.indexOf(sheet));
    // leg garments over the torso skin, under the near arm
    expect(at("far_leg", 1)).toBeGreaterThan(order.indexOf(sheet));
    expect(at("near_leg", 1)).toBeLessThan(order.indexOf(body.parts[0]!.preset.skin.slot));
    expect(order.indexOf(body.parts[0]!.preset.skin.slot)).toBeGreaterThan(order.indexOf(sheet));
  });
  it("merges two independent legs and both arms on one skeleton, no mirror, no weld", () => {
    const names = (c.doc.bones as any[]).map((b) => b.name);
    for (const p of body.parts) for (const b of p.preset.chain.bones) expect(names).toContain(b);
    expect(new Set(names).size).toBe(names.length);
    for (const p of body.parts) expect(c.doc.skins.body.attachments[p.preset.skin.slot]).toBeDefined();
    expect(() => loadAnimDocument(c.doc)).not.toThrow();
  });
  it("rejects a shared bone that differs and a slot built twice", () => {
    const bad = structuredClone(built.map((b) => ({ ...b, textures: new Map() })));
    (bad[2]!.raw.bones as any[]).find((b) => b.name === body.parts[2]!.preset.base).x = 12345;
    expect(() => composeFullBody("x", bad)).toThrow(/differs/);
    const twice = built.map((b) => ({ ...b, textures: new Map() }));
    twice[3] = { ...twice[3]!, raw: { ...twice[3]!.raw, slots: [...(twice[2]!.raw.slots as any[])] } };
    expect(() => composeFullBody("x", twice)).toThrow(/two parts/);
  });
  it("under join: the far arm's buried root holds at rest and fails when raised out from under the torso", () => {
    const doc = loadAnimDocument(c.doc);
    const far = body.parts[1]!.preset;
    const arm = `${far.skin.slot}/${far.skin.attachment}`;
    const rest = underJoinGate(doc, arm, c.sheets[0]!, [{ name: "rest", rotate: {} }], 6);
    expect(rest.ok).toBe(true);
    const raised = underJoinGate(doc, arm, c.sheets[0]!, [{ name: "raise", rotate: { [far.chain.bones[0]!]: 65 } }], 6);
    expect(raised.ok).toBe(false);
  });
});
