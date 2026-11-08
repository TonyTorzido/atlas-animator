import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { outlineProblem } from "../core/opaqueOutline.js";
import { opaqueOutline } from "./bodyContours.js";
import type { RgbaImage } from "./image.js";
import { flipOpaqueV, mirrorRig } from "./mirrorRig.js";
import { readPng } from "./png.js";
import { canonicalPresetPath, canonicalRig } from "./surface/testRigs.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/*
 * Mirroring transforms pixels and coverage metadata together.
 */

const signedArea = (p: readonly number[]) => {
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += (p[i] as number) * (p[j + 1] as number) - (p[j] as number) * (p[i + 1] as number);
  }
  return a / 2;
};

/** Inside test for a convex polygon of either winding. */
const inside = (p: readonly number[], u: number, v: number) => {
  let sign = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    const c = ((p[j] as number) - (p[i] as number)) * (v - (p[i + 1] as number)) - ((p[j + 1] as number) - (p[i + 1] as number)) * (u - (p[i] as number));
    if (Math.abs(c) < 1e-12) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
};

/** 16 x 16, opaque only in the top half, in a slanted (asymmetric) trapezoid. */
function halfOpaque(): RgbaImage {
  const w = 16;
  const h = 16;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h / 2; y++) for (let x = 0; x < Math.min(w, 3 + y * 1.5); x++) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
}

const flipV = (img: RgbaImage): RgbaImage => {
  const data = new Uint8Array(img.data.length);
  const row = img.width * 4;
  for (let y = 0; y < img.height; y++) data.set(img.data.subarray((img.height - 1 - y) * row, (img.height - y) * row), y * row);
  return { ...img, data };
};

/** One build of the canonical shoulder rig shared by the tests (a full build takes about a minute). */
let shoulderCache: ReturnType<typeof canonicalRig> | null = null;
const shoulderRig = () => (shoulderCache ??= canonicalRig("template7-shoulder"));

describe("mirror: opaque outline follows the pixels (item 4)", () => {
  it("a v flip maps the outline v -> 1 - v, keeps the winding, and covers exactly the flipped opaque texels", () => {
    const img = halfOpaque();
    const outline = opaqueOutline(img)!;
    const flipped = flipOpaqueV(outline);
    expect(outlineProblem(flipped)).toBeNull();
    expect(Math.sign(signedArea(flipped))).toBe(Math.sign(signedArea(outline)));
    const art = flipV(img);
    // Texel for texel, the flipped outline covers the flipped art exactly as the source outline
    // covers the source art (the hull's own edge error is carried, not added to).
    const opaqueAt = (im: RgbaImage, x: number, y: number) => (im.data[(y * im.width + x) * 4 + 3] as number) >= 128;
    let before = 0;
    let after = 0;
    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        const u = (x + 0.5) / art.width;
        const v = (y + 0.5) / art.height;
        expect(inside(flipped, u, v)).toBe(inside(outline, u, 1 - v));
        if (inside(outline, u, v) !== opaqueAt(img, x, y)) before++;
        if (inside(flipped, u, v) !== opaqueAt(art, x, y)) after++;
      }
    }
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(art.height / 2);
    // The unflipped outline would cover the empty half: it does not match the flipped art.
    let stale = 0;
    for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) if (inside(outline, (x + 0.5) / art.width, (y + 0.5) / art.height) !== ((art.data[(y * art.width + x) * 4 + 3] as number) >= 128)) stale++;
    expect(stale).toBeGreaterThan(0);
  });

  it("a centre region rebuilt full width re-takes its opaque outline from the rebuilt art", () => {
    const rig = shoulderRig();
    const preset = rig.built.preset;
    const rule = preset.mirror as NonNullable<typeof preset.mirror>;
    const centre = Object.fromEntries(preset.regions.map((r) => [r.texture, { image: readPng(resolve(dirname(canonicalPresetPath("template7-shoulder")), r.image)), crop: r.crop, keep: r.keep }]));
    const raw = structuredClone(rig.raw) as { skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }> };
    const sided = (path: string) => preset.regions.some((r) => r.texture === path && rule.rename.some(([a]) => r.bone.endsWith(a)));
    let found: [string, string, string, string] | null = null;
    for (const [skin, s] of Object.entries(raw.skins))
      for (const [slot, atts] of Object.entries(s.attachments))
        for (const [name, att] of Object.entries(atts))
          if (att.type === "region" && typeof att.path === "string" && centre[att.path] && !sided(att.path)) {
            att.opaque = [0, 0, 0.5, 0, 0.5, 1, 0, 1]; // the source crop's left half
            found = [skin, slot, name, att.path];
          }
    expect(found).not.toBeNull();
    const [skin, slot, name, path] = found!;
    const m = mirrorRig(raw as Record<string, unknown>, rig.textures, rule, centre);
    const out = (m.doc as typeof raw).skins[skin]!.attachments[slot]![name]!;
    expect(out.opaque).toEqual(opaqueOutline(m.textures.get(path)!));
  });

  it("a side-bone region mirrors with its texture flipped in v and its opaque outline through flipOpaqueV", () => {
    // a minimal rig: a root on the mirror line (x = 100) and a side bone carrying an art region
    const img = halfOpaque();
    const raw = {
      format: "atlas-anim@1",
      name: "side-region",
      canvas: { width: 200, height: 200, originX: 100, originY: 100 },
      bones: [{ name: "root" }, { name: "hand_l", parent: "root", x: -40, y: 20, rotation: 30, length: 20 }],
      slots: [{ name: "hand", bone: "hand_l", attachment: "fist" }],
      skins: { body: { attachments: { hand: { fist: { type: "region", path: "fist", x: 5, y: 3, rotation: 12, width: 16, height: 16, opaque: [0.1, 0.05, 0.9, 0.1, 0.8, 0.45, 0.2, 0.4] } } } } },
      animations: {}
    };
    const m = mirrorRig(raw as Record<string, unknown>, new Map([["fist", img]]), { x: 100, rename: [["_l", "_r"]], slots: { hand: "hand_r" }, feather: 0 } as never, {});
    const out = (m.doc as unknown as { skins: Record<string, { attachments: Record<string, Record<string, Record<string, unknown>>> }> }).skins.body!.attachments;
    const near = out.hand!.fist!;
    const far = out.hand_r!.fist!;
    expect(near.opaque).toEqual([0.1, 0.05, 0.9, 0.1, 0.8, 0.45, 0.2, 0.4]);
    expect(far.opaque).toEqual(flipOpaqueV(near.opaque as number[]));
    expect(far.y).toBe(-3);
    expect(far.rotation).toBe(-12);
    const tex = m.textures.get(far.path as string)!;
    const px = (im: RgbaImage, x: number, y: number) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
    for (const [x, y] of [[3, 0], [8, 2], [12, 7]] as const) expect(px(tex, x, y)).toEqual(px(img, x, img.height - 1 - y));
  });
});
