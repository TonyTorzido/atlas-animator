import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { buildHeld, checkGripRegistration, dressHeld, fistSlotName, gripBoneName, loadHeldSpec, runHeldChecks, toItemFrame, type HeldSpec } from "./heldItem.js";
import { createImage, type MutableImage } from "./image.js";
import { DEFAULT_BODY_RIG } from "./swagTypes.js";

/* Held items (STYLE.md held-item): checks on the art, a grip bone on the hand, the fist drawn over the hilt. */
const SPEC = fileURLToPath(new URL("../../fixtures/garments/sword.held.json", import.meta.url));

/** A flat synthetic sword along the spec's art frame; `tilt` (deg) and `handle` (half width) break it on purpose. */
function syntheticSword(spec: HeldSpec, w: number, h: number, o: { tilt?: number; handle?: number } = {}): MutableImage {
  const img = createImage(w, h);
  const t = ((o.tilt ?? 0) * Math.PI) / 180;
  const hw = o.handle ?? 18;
  const shape = (u: number, v: number, k: number) => {
    const a = Math.abs(v);
    return (u >= -78 + k && u <= -48 && a <= 15 - k) || (u >= -56 + k && u <= 52 && a <= hw - k) || (u >= 52 + k && u <= 76 - k && a <= 62 - k) || (u >= 70 && u <= 320 - k && a <= 25 - k);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u0, v0] = toItemFrame(spec, x + 0.5, y + 0.5);
    const u = Math.cos(t) * u0 + Math.sin(t) * v0;
    const v = -Math.sin(t) * u0 + Math.cos(t) * v0;
    if (!shape(u, v, 0)) continue;
    img.data.set(shape(u, v, 8) ? (u > 76 ? [196, 206, 218, 255] : [120, 72, 40, 255]) : [28, 31, 38, 255], (y * w + x) * 4);
  }
  return img;
}

describe("held item", () => {
  let raw: any;
  let spec: HeldSpec;
  beforeAll(() => {
    raw = JSON.parse(readFileSync(DEFAULT_BODY_RIG, "utf8"));
    spec = loadHeldSpec(SPEC);
  });

  it("a clean sword passes every check; tilted, wide-handled or short ones fail grip registration", () => {
    const { width: W, height: H } = raw.canvas;
    const ok = runHeldChecks(syntheticSword(spec, W, H), spec);
    expect(ok.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual([]);
    expect(checkGripRegistration(syntheticSword(spec, W, H, { tilt: 8 }), spec).pass).toBe(false);
    expect(checkGripRegistration(syntheticSword(spec, W, H, { handle: 34 }), spec).pass).toBe(false);
    const short = syntheticSword(spec, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (toItemFrame(spec, x + 0.5, y + 0.5)[0] > 200) short.data[(y * W + x) * 4 + 3] = 0;
    expect(checkGripRegistration(short, spec).pass).toBe(false);
  });

  it("rides a grip bone on the hand; the fist copy (region, contours, joins) is drawn right after the item wherever it goes", () => {
    const piece = buildHeld(raw, spec, syntheticSword(spec, raw.canvas.width, raw.canvas.height));
    expect(piece.attachment.opaque?.length).toBe(8);
    const doc = dressHeld(raw, piece, spec);
    const fist = fistSlotName(spec);
    const free = (doc.slots as any[]).filter((s) => !s.drawAfter && !s.drawBefore).map((s) => s.name);
    doc.animations.front = { duration: 1, drawOrder: [{ time: 0, offsets: [{ slot: spec.name, offset: free.length - 1 - free.indexOf(spec.name) }] }] };
    const loaded = loadAnimDocument(doc);
    const sk = new Skeleton(loaded);
    sk.setActiveSkins(["body"]);
    sk.setToSetupPose();
    sk.updateWorldTransform("none");
    let order = sk.drawOrder.map((s) => s.data.name);
    // setup: item, its fist copy, then the fist slot it was set up before
    expect(order.indexOf(fist)).toBe(order.indexOf(spec.name) + 1);
    expect(order.indexOf(spec.drawBefore)).toBe(order.indexOf(spec.name) + 2);
    // moved to the front by a draw-order key: the copy travels with it
    const st = new AnimationState(new AnimationStateData(loaded));
    st.setAnimation(0, "front", { loop: false });
    st.update(0.5);
    st.apply(sk);
    sk.updateWorldTransform("none");
    order = sk.drawOrder.map((s) => s.data.name);
    expect(order.indexOf(spec.name)).toBeGreaterThan(order.indexOf("head"));
    expect(order.indexOf(fist)).toBe(order.indexOf(spec.name) + 1);
    sk.setToSetupPose();
    sk.updateWorldTransform("none");
    // the grip bone sits on the fist's grip point at rest
    const g = sk.findBone(gripBoneName(spec))!.world;
    expect(Math.hypot(g.x + raw.canvas.originX - spec.grip.at[0], g.y + raw.canvas.originY - spec.grip.at[1])).toBeLessThan(1e-3);
    expect(doc.skins.body.contours[fist]).toEqual(doc.skins.body.contours[spec.hand.fistSlot]);
    expect((doc.skins.body.contourJoins as any[]).filter((j) => j.b.slot === fist).length).toBe((doc.skins.body.contourJoins as any[]).filter((j) => j.b.slot === spec.hand.fistSlot).length);
  });
});
