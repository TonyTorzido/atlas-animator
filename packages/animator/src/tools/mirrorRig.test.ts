import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MeshAttachment } from "../core/attachments.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { mirrorOwner, mirrorRig, symmetricPolygon } from "./mirrorRig.js";
import { readPng } from "./png.js";
import { canonicalPresetPath, canonicalRig } from "./surface/testRigs.js";
import { resolve } from "node:path";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/* Plan: the mirrored, welded whole upper body from the canonical template7 half rig. */
describe("mirrorRig ()", () => {
  const rig = canonicalRig("template7-shoulder");
  const preset = rig.built.preset;
  const rule = preset.mirror as NonNullable<typeof preset.mirror>;
  const centre = Object.fromEntries(preset.regions.map((r) => [r.texture, { image: readPng(resolve(dirname(canonicalPresetPath("template7-shoulder")), r.image)), crop: r.crop, keep: r.keep }]));
  const m = mirrorRig(rig.raw as Record<string, unknown>, rig.textures, rule, centre);
  const doc = loadAnimDocument(m.doc);
  const sk = new Skeleton(doc);
  sk.setActiveSkins(Object.keys(doc.skins));
  const pose = (p: Record<string, number>) => {
    sk.setToSetupPose();
    for (const [b, v] of Object.entries(p)) sk.getBone(b).pose.rotation = sk.getBone(b).data.rotation + v;
    sk.updateWorldTransform("none");
    const slot = sk.getSlot("torso");
    return sk.meshWorldVertices(sk.getAttachment(slot, "skin") as MeshAttachment, slot.bone).slice();
  };
  const X = rule.x - doc.canvas.originX;
  const skin = m.meshes["torso/skin"] as NonNullable<(typeof m.meshes)[string]>;

  it("mirrors the bones: names, limits [-max, -min], inherit carried", () => {
    const b = (n: string) => doc.bones.find((x) => x.name === n);
    expect(b("clavicle_r")?.inherit).toBe("noScale");
    expect([b("upper_arm_r")?.limits?.min, b("upper_arm_r")?.limits?.max]).toEqual([-105, 15]);
    expect(m.doc.drivenGrids.map((g: { name: string }) => g.name)).toEqual(["raise_shrug_l", "raise_shrug_r", "raise_elbow_l", "raise_elbow_r"]);
    expect(m.doc.poseLimits.length).toBe(2 * (rig.raw.poseLimits as unknown[]).length);
  });

  it("mirrors contact-band conditions and combined-limit drivers: right bones, ranges [-hi, -lo]", () => {
    const n = (rig.raw.contactBands as unknown[] | undefined)?.length ?? 0;
    const left = (m.doc.contactBands ?? []).slice(0, n) as { name: string; when?: Record<string, [number, number]> }[];
    const right = (m.doc.contactBands ?? []).slice(n) as { name: string; when?: Record<string, [number, number]> }[];
    expect(right.length).toBe(n);
    right.forEach((r, i) => {
      const l = left[i] as (typeof left)[number];
      for (const [b, [lo, hi]] of Object.entries(l.when ?? {})) {
        const rb = b.replace(/_l$/, "_r");
        expect(Object.keys(r.when ?? {})).toContain(rb);
        expect(r.when?.[rb]).toEqual([-hi + 0, -lo + 0]);
      }
      for (const b of Object.keys(r.when ?? {})) expect(b).not.toMatch(/_l$/);
    });
    if (n) expect(right.some((r) => Object.keys(r.when ?? {}).some((b) => /^(forearm|hand|clavicle)_r$/.test(b)))).toBe(true);
    // Combined limits: plus drivers mapped (centre bones stay themselves).
    for (const l of m.doc.poseLimits.slice((rig.raw.poseLimits as unknown[]).length) as { x: string; plus?: string[] }[]) for (const b of l.plus ?? []) expect(b).not.toMatch(/_l$/);
  });

  it("bind-symmetric to 1e-3 and symmetric at mirrored poses with correctives active (one welded skin)", () => {
    const bind = pose({});
    for (const [l, r] of skin.pairs) expect(Math.hypot(2 * X - (bind[l * 2] as number) - (bind[r * 2] as number), (bind[l * 2 + 1] as number) - (bind[r * 2 + 1] as number))).toBeLessThan(1e-3);
    const a = pose({ upper_arm_l: 60, clavicle_l: 3, forearm_l: 30, chest: 6 });
    const b = pose({ upper_arm_r: -60, clavicle_r: -3, forearm_r: -30, chest: -6 });
    let worst = 0;
    for (const [l, r] of skin.pairs) worst = Math.max(worst, Math.hypot(2 * X - (a[l * 2] as number) - (b[r * 2] as number), (a[l * 2 + 1] as number) - (b[r * 2 + 1] as number)));
    expect(worst).toBeLessThan(1e-3);
    // One arm moving leaves the other half and the centreline exactly where the trunk puts them.
    const rest = pose({});
    const left = pose({ upper_arm_l: 90, clavicle_l: 6 });
    for (const i of [...skin.centre, ...skin.pairs.map(([, r]) => r)]) expect(Math.abs((left[i * 2] as number) - (rest[i * 2] as number)) + Math.abs((left[i * 2 + 1] as number) - (rest[i * 2 + 1] as number))).toBeLessThan(1e-9);
  });

  it("welds the centreline: every centre edge has a triangle on each side; one hull loop; the neckline joins across", () => {
    const att = m.doc.skins.body.attachments.torso.skin;
    const c = new Set(skin.centre);
    const count = new Map<string, number>();
    const tris: number[] = att.triangles;
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e] as number;
      const b = tris[t + ((e + 1) % 3)] as number;
      if (c.has(a) && c.has(b)) count.set(`${Math.min(a, b)}-${Math.max(a, b)}`, (count.get(`${Math.min(a, b)}-${Math.max(a, b)}`) ?? 0) + 1);
    }
    expect(count.size).toBe(skin.centre.length - 1);
    expect([...count.values()].every((n) => n === 2)).toBe(true);
    expect(att.hull).toBe(2 * ((rig.raw as any).skins.body.attachments.torso.skin.hull - skin.centre.length + 2) - 2); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(m.report.some((r) => r.startsWith("contour tank/neckline: joined"))).toBe(true);
    expect(m.doc.skins.body.attachments.head.head.width).toBe(544);
  });

  it("symmetricPolygon closes a half polygon across the line", () => {
    expect(symmetricPolygon([[0, 0], [12, 0], [12, 10], [0, 10]], 10)).toEqual([[10, 10], [0, 10], [0, 0], [10, 0], [20, 0], [20, 10]]);
  });
});

/* / review: conditional contours, draw anchors, skin contacts, skin-keyed meshes, owners, rejected inputs. */
describe("mirrorRig inputs (review fixes)", () => {
  const rig = canonicalRig("template7-shoulder");
  const preset = rig.built.preset;
  const rule = preset.mirror as NonNullable<typeof preset.mirror>;
  const centre = Object.fromEntries(preset.regions.map((r) => [r.texture, { image: readPng(resolve(dirname(canonicalPresetPath("template7-shoulder")), r.image)), crop: r.crop, keep: r.keep }]));
  const variant = (edit: (raw: any) => void) => {
    const raw = structuredClone(rig.raw) as any;
    edit(raw);
    return raw;
  };

  it("remaps every `visible` rule (right bone, [-max, -min]) and never joins a conditional centre-ending contour", () => {
    const raw = variant((r) => {
      r.skins.body.contours.upper_arm.outline.visible = [{ bone: "upper_arm_l", min: 20, max: 80 }];
      r.skins.body.contours.tank.neckline.visible = [{ bone: "upper_arm_l", min: 20, max: 80 }];
    });
    const m = mirrorRig(raw, rig.textures, rule, centre);
    const c = m.doc.skins.body.contours;
    expect(c.upper_arm.outline.visible).toEqual([{ bone: "upper_arm_l", min: 20, max: 80 }]);
    expect(c.upper_arm_r.outline.visible).toEqual([{ bone: "upper_arm_r", min: -80, max: -20 }]);
    // The neckline ends on the line: conditional, so its halves stay apart, each with its own rule.
    expect(c.tank.neckline.points.length).toBe(raw.skins.body.contours.tank.neckline.points.length);
    expect(c.tank.neckline_r.visible).toEqual([{ bone: "upper_arm_r", min: -80, max: -20 }]);
    // Unconditional: still joined (the control).
    const plain = mirrorRig(rig.raw as Record<string, unknown>, rig.textures, rule, centre).doc.skins.body.contours;
    expect(plain.tank.neckline_r).toBeUndefined();
  });

  it("mirrors draw anchors and skin contour contacts; keys meshes by skin", () => {
    const raw = variant((r) => {
      r.slots.find((s: any) => s.name === "forearm").drawAfter = "upper_arm";
      r.skins.body.contourContacts = [{ a: { slot: "forearm", name: "outline" }, b: { slot: "tank", name: "flank" }, gap: 2 }];
      r.skins.alt = { attachments: { torso: { skin: structuredClone(r.skins.body.attachments.torso.skin) } } };
    });
    const m = mirrorRig(raw, rig.textures, rule, centre);
    expect(m.doc.slots.find((s: any) => s.name === "forearm_r").drawAfter).toBe("upper_arm_r");
    expect(m.doc.skins.body.contourContacts).toEqual([
      { a: { slot: "forearm", name: "outline" }, b: { slot: "tank", name: "flank" }, gap: 2 },
      { a: { slot: "forearm_r", name: "outline" }, b: { slot: "tank", name: "flank_r" }, gap: 2 }
    ]);
    expect(Object.keys(m.meshes)).toContain("torso/skin");
    expect(Object.keys(m.meshes)).toContain("alt:torso/skin");
    expect(m.doc.skins.alt.attachments.torso.skin.uvs.length).toBe(m.doc.skins.body.attachments.torso.skin.uvs.length);
  });

  it("renames side-suffixed owner attachments with the slot; rejects coverage and skin constraints", () => {
    expect(mirrorOwner({ slot: "upper_arm", attachment: "cuff_l" }, { upper_arm: "upper_arm_r" }, rule.rename)).toEqual({ slot: "upper_arm_r", attachment: "cuff_r" });
    expect(mirrorOwner({ skin: "tunic", slot: "tank", attachment: "tank" }, { tank: "tank" }, rule.rename)).toEqual({ skin: "tunic", slot: "tank", attachment: "tank" });
    expect(() => mirrorRig(variant((r) => (r.skins.body.coverage = { regions: { chest: { mesh: { slot: "torso", attachment: "skin" }, triangles: [[0, 1]] } } })), rig.textures, rule, centre)).toThrow(/coverage/);
  });
});
