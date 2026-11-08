import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { buildPlates, checkPlateOverflow, checkSinglePiece, dressPlates, loadPlateSpec, mirrorAxis, mirrorImage, plateAreaMask, regionCorners, runPlateChecks, type PlateSpec } from "./hardPlate.js";
import { createImage, type MutableImage, type RgbaImage } from "./image.js";
import { readPng } from "./png.js";
import { softRender } from "./softRender.js";
import { DEFAULT_BODY_RIG } from "./swagTypes.js";
import { texturesFromAtlas } from "./validate.js";

/* Hard plates (STYLE.md hard-plate): registered at rest, rigid when posed, mirrored, checked. */
const SPEC = fileURLToPath(new URL("../../fixtures/garments/pauldron.plate.json", import.meta.url));

/** A flat synthetic plate: the area ellipse at 85%, a 9 px dark outline, one flat fill. */
function syntheticPlate(spec: PlateSpec, w: number, h: number, axis: number): MutableImage {
  const img = createImage(w, h);
  const outer = plateAreaMask(spec, w, h, "l", axis, 0.85);
  const inner = plateAreaMask(spec, w, h, "l", axis, 0.85 - 9 / Math.min(spec.area.rx, spec.area.ry));
  for (let i = 0; i < w * h; i++) if (outer[i]) img.data.set(inner[i] ? [150, 156, 168, 255] : [28, 31, 38, 255], i * 4);
  return img;
}

describe("hard plate", () => {
  let raw: any;
  let spec: PlateSpec;
  let art: MutableImage;
  let axis: number;
  let base: Map<string, RgbaImage>;
  beforeAll(() => {
    raw = JSON.parse(readFileSync(DEFAULT_BODY_RIG, "utf8"));
    spec = loadPlateSpec(SPEC);
    axis = mirrorAxis(spec, raw);
    art = syntheticPlate(spec, raw.canvas.width, raw.canvas.height, axis);
    const atlasPath = DEFAULT_BODY_RIG.replace(/\.anim\.json$/, ".atlas.json");
    const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
    base = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(`${atlasPath.replace(/[^/\\]+$/, "")}${p.file}`)] as [string, RgbaImage])));
  });

  const posed = (doc: any, pose: Record<string, number>) => {
    const sk = new Skeleton(loadAnimDocument(doc));
    sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
    sk.setToSetupPose();
    for (const [b, r] of Object.entries(pose)) { const bone = sk.findBone(b); if (bone) bone.pose.rotation += r; }
    sk.updateWorldTransform("none");
    return sk;
  };

  it("lands on the art pixel for pixel at rest, both sides (right = mirrored left)", () => {
    const pieces = buildPlates(raw, spec, art);
    const doc = dressPlates(raw, pieces);
    const tex = new Map(base);
    for (const p of pieces) tex.set(p.texturePath, p.texture);
    const sk = posed(doc, {});
    const plateSlots = new Set(pieces.map((p) => sk.getSlot(p.slot.name)));
    const { width: w, height: h, originX: ox, originY: oy } = raw.canvas;
    const img = softRender(sk, tex, { width: w, height: h, left: -ox, top: -oy, slotFilter: (s) => plateSlots.has(s) }).image;
    for (const [side, want] of [["l", art], ["r", mirrorImage(art, axis)]] as const) {
      const area = plateAreaMask(spec, w, h, side, axis, 1);
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < w * h; i++) {
        if (!area[i]) continue;
        const a = (img.data[i * 4 + 3] as number) >= 128;
        const b = (want.data[i * 4 + 3] as number) >= 128;
        if (a && b) inter++;
        if (a || b) uni++;
      }
      expect(inter / uni).toBeGreaterThan(0.985);
    }
  });

  it("is rigid on its bone: corner distances are unchanged when the arm raises and bends", () => {
    const doc = dressPlates(raw, buildPlates(raw, spec, art));
    const { originX: ox, originY: oy } = raw.canvas;
    const dist = (c: [number, number][]) => [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]].map(([i, j]) => Math.hypot(c[i!]![0] - c[j!]![0], c[i!]![1] - c[j!]![1]));
    const rest = posed(doc, {});
    const raised = posed(doc, { upper_arm_l: 95, forearm_l: 60, upper_arm_r: -58, forearm_r: -68 });
    for (const s of ["pauldron_l", "pauldron_r"]) {
      const a = dist(regionCorners(rest, s, ox, oy));
      const b = dist(regionCorners(raised, s, ox, oy));
      a.forEach((v, i) => expect(Math.abs(v - (b[i] as number))).toBeLessThan(1e-3));
      expect(regionCorners(raised, s, ox, oy)[0]).not.toEqual(regionCorners(rest, s, ox, oy)[0]);
    }
  });

  it("partial follow: the socket sits on the joint and turns by `follow` of the arm's rotation", () => {
    expect(spec.follow).toBeGreaterThan(0.5);
    const doc = dressPlates(raw, buildPlates(raw, spec, art));
    const ang = (sk: any, b: string) => (Math.atan2(sk.findBone(b).world.c, sk.findBone(b).world.a) * 180) / Math.PI;
    const rest = posed(doc, {});
    const raised = posed(doc, { upper_arm_l: 60, upper_arm_r: -60 });
    for (const side of ["l", "r"]) {
      const arm = `upper_arm_${side}`;
      const sock = `pauldron_socket_${side}`;
      expect(Math.hypot(raised.findBone(sock)!.world.x - raised.findBone(arm)!.world.x, raised.findBone(sock)!.world.y - raised.findBone(arm)!.world.y)).toBeLessThan(1e-6);
      expect(Math.abs(ang(rest, sock) - ang(rest, arm))).toBeLessThan(1e-6);
      const dArm = ang(raised, arm) - ang(rest, arm);
      const dSock = ang(raised, sock) - ang(rest, sock);
      expect(dSock / dArm).toBeCloseTo(spec.follow as number, 3);
    }
  });

  it("draw order: each plate is anchored right after its side's slot; detached = empty slot", () => {
    const pieces = buildPlates(raw, spec, art);
    const doc = dressPlates(raw, pieces, false);
    expect(doc.slots.find((s: any) => s.name === "pauldron_l")).toEqual({ name: "pauldron_l", bone: "pauldron_socket_l", drawAfter: "hand" });
    expect(doc.slots.find((s: any) => s.name === "pauldron_r").drawAfter).toBe("hand_r");
    const one = dressPlates(raw, buildPlates(raw, spec, art, ["l"]));
    expect(one.slots.some((s: any) => s.name === "pauldron_r")).toBe(false);
  });

  it("checks: pass on a flat outlined plate; fail on a speck, a light outline, a plate outside its area", () => {
    expect(runPlateChecks(art, spec, axis).reasons).toEqual([]);
    const speck = { ...art, data: new Uint8Array(art.data) };
    for (let y = 700; y < 704; y++) for (let x = 420; x < 424; x++) speck.data.set([0, 0, 0, 0], (y * art.width + x) * 4);
    const w = art.width;
    // a detached rivet beside the plate (inside the area's rim, outside the plate)
    const rim = plateAreaMask(spec, w, art.height, "l", axis, 0.97);
    const plate = plateAreaMask(spec, w, art.height, "l", axis, 0.9);
    const at = rim.findIndex((v, i) => v === 1 && !plate[i] && !plate[i + 3] && !plate[i + 3 * w] && !plate[i + 3 * w + 3]);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) speck.data.set([28, 31, 38, 255], (at + y * w + x) * 4);
    expect(checkSinglePiece(speck).pass).toBe(false);
    const light = { ...art, data: new Uint8Array(art.data) };
    for (let i = 0; i < light.data.length; i += 4) if (light.data[i] === 28) light.data.set([160, 166, 178], i);
    expect(runPlateChecks(light, spec, axis).passed).toBe(false);
    const moved = createImage(art.width, art.height);
    for (let y = 0; y < art.height; y++) for (let x = 40; x < art.width; x++) moved.data.set(art.data.subarray((y * w + x - 40) * 4, (y * w + x - 40) * 4 + 4), (y * w + x) * 4);
    expect(runPlateChecks(moved, spec, axis).passed).toBe(false);
  });
});

describe("hard plate declared overflow ()", () => {
  it("passes plate paint past the body only inside a declared zone, and fails it outside", () => {
    const spec = loadPlateSpec(SPEC);
    const w = 1086;
    const h = 1448;
    const axis = 543;
    const art = syntheticPlate(spec, w, h, axis);
    // a body silhouette that ends at x 400: everything of the plate left of it is overhang
    const body = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 400; x < w; x++) body[y * w + x] = 1;
    const rect = spec.overflow?.[0]?.rect as [number, number, number, number];
    expect(rect).toBeDefined();
    const declared = checkPlateOverflow(art, body, { ...spec, overflow: [{ name: "all", rect: [0, 0, 400, h] }] }, axis);
    expect(declared.pass).toBe(true);
    expect(declared.metrics.pastSilhouettePx as number).toBeGreaterThan(0);
    const none = checkPlateOverflow(art, body, { ...spec, overflow: [] }, axis);
    expect(none.pass).toBe(false);
    expect(none.metrics.undeclaredPx).toBe(declared.metrics.pastSilhouettePx);
  });
});
