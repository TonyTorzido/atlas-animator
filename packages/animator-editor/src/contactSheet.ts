/*
 * Atlas Animator editor: off-screen rendering for the item contact sheet and the workshop thumbnails.
 *
 * The workshop reads the turned pro rig straight from disk (fresh each time), builds one skeleton and character per view, and renders
 * any item on any pose into a small canvas through the editor's own Pixi renderer (a render texture; nothing touches the stage,
 * so the main view, the dock and the clip being edited stay as they are). Scale is the project's 0.4.
 */
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { AnimatorCharacter, chainImages, DynamicAtlas, loadPackedAtlas, separateImages, type PartImageProvider, type RgbaImage } from "@atlas-animator/core/pixi";
import { RenderTexture, type Application } from "pixi.js";
import { withEventDefs } from "./eventModel.js";
import { applyFacing } from "./facing.js";
import { OUTFITS } from "./fixtures.js";
import { poseRuleHits, referenceOf, type Reference } from "./poseRules.js";
import { cellCamera, type Extent } from "./phoneDock.js";
import { SHEET_SCALE, type SweepRow } from "./contactSheetModel.js";
import type { JsonObject } from "./setupModel.js";
import { baseSkin } from "./skinModel.js";
import type { ViewId } from "./swagModel.js";
import type { CuffInput, GateRgba, Pt } from "./swagGates.js";

// front view retired 2026-10-25: one view slot ("turned"); the rig it holds is the workshop's explicit target (Batch 8b, ).

export interface ViewData {
  view: ViewId;
  /** The editor rig (outfit) id this data was read from: the workshop's named target. */
  outfit: string;
  file: string;
  atlas: string;
  /** The rig document name without `.anim.json` (imported atlas pages are named after it). */
  name: string;
  raw: JsonObject;
  doc: AnimDocument;
}

/** Reads one view's rig document from disk (never the editor's cached copy). */
async function loadView(view: ViewId, stamp: number, outfitId: string): Promise<ViewData> {
  const outfit = OUTFITS.find((o) => o.id === outfitId);
  if (!outfit) throw new Error(`no rig called ${outfitId}`);
  const raw = (await (await fetch(`/repo/${outfit.document}?v=${stamp}`)).json()) as JsonObject;
  const doc = withEventDefs(loadAnimDocument(structuredClone(raw), { source: outfit.document }));
  return { view, outfit: outfit.id, file: outfit.document, atlas: outfit.atlas, name: outfit.document.split("/").pop()!.replace(/\.anim\.json$/, ""), raw, doc };
}

export async function loadViews(outfitId: string): Promise<Record<ViewId, ViewData>> {
  const stamp = Date.now();
  return { turned: await loadView("turned", stamp, outfitId) };
}

export interface RenderedCell {
  canvas: HTMLCanvasElement;
  /** pose rule hits at this pose (plain messages). */
  hits: string[];
}

export type Poser = (skeleton: Skeleton) => void;

/** One frame measured for the garment gates: the bare and the dressed picture plus the anchors of the posed rig, all in canvas pixels. */
export interface GateProbe {
  scale: number;
  bare: GateRgba;
  dressed: GateRgba;
  chinY: number;
  neckX: number;
  clavicles: Pt[];
  cuffs: CuffInput[];
  /** The dressed picture, for showing the failing frame. */
  canvas: HTMLCanvasElement;
}

interface ViewRig {
  data: ViewData;
  skeleton: Skeleton;
  character: AnimatorCharacter;
  reference: Reference;
  extent: Extent;
  base: string;
}

export interface SheetRenderer {
  views: Record<ViewId, ViewData>;
  /** Wears `skins` (item skin names) and renders view `view` at the pose; `scale` defaults to your project's 0.4. */
  render(view: ViewId, skins: readonly string[], pose: Poser, scale?: number, facing?: "left" | "right"): RenderedCell;
  /** A pose that plays `clip` (named `name`) at time `t` on this view's rig. */
  clipPose(view: ViewId, name: string, clip: ClipData, t: number): Poser;
  /** A pose that rotates a bone from its setup value (the sweep rows). */
  sweepPose(row: SweepRow, value: number): Poser;
  setupPose: Poser;
  /** Renders the character bare and wearing `skins` at a pose and facing, and measures the anchors the garment gates need. */
  probe(view: ViewId, skins: readonly string[], pose: Poser, facing: "left" | "right", scale?: number): GateProbe;
  /** One item drawn alone (no body) on a transparent ground, cropped to its own pixels and fitted into a `size` square: the item's thumbnail. */
  renderItem(view: ViewId, skin: string, size: number): HTMLCanvasElement | null;
  /** The character wearing a draft item that is not saved yet: `raw` is the rig document with the draft skin added, `images` its pieces by texture path. */
  renderDraft(view: ViewId, raw: JsonObject, skin: string, images: ReadonlyMap<string, RgbaImage>, scale: number): HTMLCanvasElement;
  /** Rig world -> picture pixels of the last renderDraft (the placement handles sit on it), or null before the first draw. */
  draftMap: { a: number; b: number; c: number; d: number; x: number; y: number } | null;
  /** Width over height of one rendered cell (the figure's extent), so a sheet can size its columns to the figure. */
  aspect(view: ViewId): number;
  destroy(): void;
}

const BACKGROUND = 0x262b36;

export async function createSheetRenderer(app: Application, views: Record<ViewId, ViewData>): Promise<SheetRenderer> {
  const rigs = {} as Record<ViewId, ViewRig>;
  const packs = {} as Record<ViewId, PartImageProvider>;
  const buildRig = (data: ViewData, doc: AnimDocument, images: PartImageProvider): ViewRig => {
    const skeleton = new Skeleton(doc);
    const base = baseSkin(doc.skins) ?? Object.keys(doc.skins)[0]!;
    skeleton.setActiveSkins([base]);
    const character = new AnimatorCharacter({ skeleton, atlas: new DynamicAtlas({ pageSize: 1024 }), images });
    applyFacing(character, "left");
    skeleton.setToSetupPose();
    character.update();
    const reference = referenceOf(skeleton);
    // The extent covers the figure: the bones' setup positions plus room for the head, the soles, the weapon and arms swinging out.
    const pts = skeleton.bones.filter((b) => !/_target$|^offhand$|^root$|^weapon/.test(b.data.name)).map((b) => [b.world.x, b.world.y] as const);
    const extent: Extent = {
      minX: Math.min(...pts.map((p) => p[0])) - 280,
      maxX: Math.max(...pts.map((p) => p[0])) + 280,
      minY: Math.min(...pts.map((p) => p[1])) - 480,
      maxY: Math.max(...pts.map((p) => p[1])) + 140
    };
    return { data, skeleton, character, reference, extent, base };
  };
  for (const view of ["turned"] as const) {
    const data = views[view];
    packs[view] = await loadPackedAtlas(`/repo/${data.atlas}?v=${Date.now()}`);
    rigs[view] = buildRig(data, data.doc, chainImages(separateImages(new Map()), packs[view]));
  }
  const textures = new Map<string, RenderTexture>();

  const setupPose: Poser = (sk) => sk.setToSetupPose();

  const draw = (r: ViewRig, skins: readonly string[], pose: Poser, scale: number, facing: "left" | "right" = "left"): RenderedCell => {
    r.character.setActiveSkins([r.base, ...skins]);
    r.skeleton.setToSetupPose();
    pose(r.skeleton);
    r.character.update();
    const hits = poseRuleHits(r.skeleton, r.reference).map((h) => h.message);
    const w = Math.ceil((r.extent.maxX - r.extent.minX) * scale) + 4;
    const h = Math.ceil((r.extent.maxY - r.extent.minY) * scale) + 4;
    const key = `${w}x${h}`;
    let rt = textures.get(key);
    if (!rt) textures.set(key, (rt = RenderTexture.create({ width: w, height: h, resolution: 1 })));
    const cam = cellCamera(scale, w, h, r.extent);
    r.character.scale.set(cam.scale);
    applyFacing(r.character, facing);
    r.character.position.set(cam.x, cam.y);
    app.renderer.render({ container: r.character, target: rt, clear: true, clearColor: BACKGROUND });
    const out = app.renderer.extract.canvas(rt) as unknown as HTMLCanvasElement;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    g.drawImage(out as unknown as CanvasImageSource, 0, 0);
    return { canvas, hits };
  };

  const out: SheetRenderer = {
    views,
    draftMap: null,
    render(view, skins, pose, scale = SHEET_SCALE, facing = "left") {
      return draw(rigs[view], skins, pose, scale, facing);
    },
    renderItem(view, skin, size) {
      const r = rigs[view];
      r.character.setActiveSkins([skin]);
      r.skeleton.setToSetupPose();
      r.character.update();
      const scale = 0.6;
      const w = Math.ceil((r.extent.maxX - r.extent.minX) * scale) + 4;
      const h = Math.ceil((r.extent.maxY - r.extent.minY) * scale) + 4;
      const rt = RenderTexture.create({ width: w, height: h, resolution: 1 });
      try {
        const cam = cellCamera(scale, w, h, r.extent);
        r.character.scale.set(cam.scale);
        applyFacing(r.character, "left");
        r.character.position.set(cam.x, cam.y);
        app.renderer.render({ container: r.character, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
        const src = app.renderer.extract.canvas(rt) as unknown as HTMLCanvasElement;
        const flat = document.createElement("canvas");
        flat.width = w;
        flat.height = h;
        const g = flat.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(src as unknown as CanvasImageSource, 0, 0);
        const px = g.getImageData(0, 0, w, h).data;
        let x0 = w;
        let y0 = h;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (px[(y * w + x) * 4 + 3]! <= 8) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        if (x1 < 0) return null;
        const bw = x1 - x0 + 1;
        const bh = y1 - y0 + 1;
        const k = Math.min(size / bw, size / bh, 3);
        const out = document.createElement("canvas");
        out.width = size;
        out.height = size;
        const og = out.getContext("2d")!;
        og.imageSmoothingQuality = "high";
        og.drawImage(flat, x0, y0, bw, bh, (size - bw * k) / 2, (size - bh * k) / 2, bw * k, bh * k);
        return out;
      } finally {
        rt.destroy(true);
      }
    },
    renderDraft(view, raw, skin, images, scale) {
      const data = views[view];
      const doc = withEventDefs(loadAnimDocument(structuredClone(raw), { source: data.file }));
      const rig = buildRig(data, doc, chainImages(separateImages(images), packs[view]));
      try {
        const cell = draw(rig, [skin], (sk) => sk.setToSetupPose(), scale);
        const o = rig.character.toGlobal({ x: 0, y: 0 });
        const ex = rig.character.toGlobal({ x: 1, y: 0 });
        const ey = rig.character.toGlobal({ x: 0, y: 1 });
        out.draftMap = { a: ex.x - o.x, b: ey.x - o.x, c: ex.y - o.y, d: ey.y - o.y, x: o.x, y: o.y };
        return cell.canvas;
      } finally {
        rig.character.destroy();
      }
    },
    clipPose(view, name, clip, t) {
      return (sk) => {
        const doc = rigs[view].data.doc;
        doc.animations = { [name]: clip };
        const state = new AnimationState(new AnimationStateData(new AnimationLibrary(doc)));
        state.setAnimation(0, name, { loop: clip.loop });
        state.update(clip.loop ? Math.min(t, Math.max(0, clip.duration - 1e-4)) : t);
        state.apply(sk);
      };
    },
    sweepPose(row, value) {
      return (sk) => {
        const bone = sk.findBone(row.bone);
        if (bone) bone.pose.rotation = bone.data.rotation + value;
      };
    },
    setupPose,
    probe(view, skins, pose, facing, scale = SHEET_SCALE) {
      const r = rigs[view];
      const grab = (c: HTMLCanvasElement): GateRgba => {
        const img = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
        return { width: img.width, height: img.height, data: img.data };
      };
      const bare = grab(draw(r, [], pose, scale, facing).canvas);
      const dressedCell = draw(r, skins, pose, scale, facing);
      const dressed = grab(dressedCell.canvas);
      const sk = r.skeleton;
      const world = (name: string): Pt | null => {
        const b = sk.findBone(name);
        if (!b) return null;
        const g = r.character.toGlobal({ x: b.world.x, y: b.world.y });
        return { x: g.x, y: g.y };
      };
      const slotVerts = (name: string): Pt[] => {
        const slot = sk.findSlot(name);
        if (!slot) return [];
        const n = sk.slotWorldFloats(slot);
        if (!n) return [];
        const buf = new Float32Array(n);
        const c = sk.computeSlotWorldVertices(slot, buf, 0, 2);
        return Array.from({ length: c }, (_, i) => ({ x: buf[i * 2]!, y: buf[i * 2 + 1]! }));
      };
      const head = slotVerts("head");
      const headTop = head.reduce((m, p) => Math.max(m, p.y), -1e9);
      const headMid = head.length ? head.reduce((m, p) => m + p.x, 0) / head.length : 0;
      const chin = r.character.toGlobal({ x: headMid, y: headTop });
      const cuffs: CuffInput[] = (["near", "far"] as const).map((side) => {
        const wrist = sk.findBone(`hand_${side}`);
        const elbow = sk.findBone(`forearm_${side}`);
        const verts = slotVerts(`shirt_sleeve_${side}`);
        if (!wrist || !elbow || !verts.length) return { side, sleeveToWrist: null, forearm: 0, at: null };
        const wp = { x: wrist.world.x, y: wrist.world.y };
        const near = verts.reduce((m, p) => Math.min(m, Math.hypot(p.x - wp.x, p.y - wp.y)), 1e9);
        return { side, sleeveToWrist: near, forearm: Math.hypot(elbow.world.x - wp.x, elbow.world.y - wp.y), at: world(`hand_${side}`) };
      });
      return {
        scale: r.character.scale.x ? Math.abs(r.character.scale.x) : scale,
        bare,
        dressed,
        chinY: chin.y,
        neckX: chin.x,
        clavicles: (["clavicle_near", "clavicle_far"] as const).flatMap((n) => world(n) ?? []),
        cuffs,
        canvas: dressedCell.canvas
      };
    },
    aspect(view) {
      const e = rigs[view].extent;
      return (e.maxX - e.minX) / (e.maxY - e.minY);
    },
    destroy() {
      for (const rt of textures.values()) rt.destroy(true);
      textures.clear();
      for (const r of Object.values(rigs)) r.character.destroy();
    }
  };
  return out;
}
