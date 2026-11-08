/*
 * Atlas Animator: original implementation.
 *
 * `tsx src/cli/heldImport.ts <rig.anim.json> <held.png> <out dir> [--held <spec.held.json>]
 *  [--clips a.json,b.json] [--also <rig2.anim.json>,...] [--no-render]`
 * Held-item import (tools/heldItem.ts, swag-rules/STYLE.md held-item): builds the grip bone and the
 * item region from the art, dresses the rig (and each `--also` rig, e.g. the body in the jacket) with
 * the item, the fist copy and the effect slot, adds the held clips (`fixtures/clips/<name>-*.json` by
 * default: `{name, about, clip, drawPhases?, smears?}`, `clip` in the atlas-anim clip format) and
 * builds each clip's smear sprites from the motion itself (the area the blade's outer part sweeps
 * between two clip times, drawn on the root bone, keyed on for the strike frames). Gates, over every
 * 30 fps frame of every clip of every dressed rig:
 * - swagChecks: the held checks on the art;
 * - restRegistration: with the grip turned to the art's axis, the item renders over its art (IoU >= 0.985);
 * - attached: the grip bone's origin stays on the hand's grip point (< 0.001 px);
 * - rigid: the item's corner distances never change (< 0.001 px);
 * - handleInFist: the handle's centre line (|u| <= 0.8 fistRadius) stays inside the posed fist outline;
 * - fistOverItem: the fist copy is drawn right after the item, on exactly the fist's vertices, with the
 *   fist's contours;
 * - drawOrderSwitch: in each clip's declared phases the item is behind the body (before the first body
 *   slot) or in front of everything (after the head), and each declared order is really shown.
 * Writes `<out>/rig/<stem>-<item>.anim.json` per rig (one atlas each), `<item>.report.json`, and unless
 * --no-render the 0.4 30 fps GIFs, 8-frame sheets and 4x hand crops. Exit 1 when a gate fails.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { decodePng, readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas } from "../tools/validate.js";
import { writeAtlas } from "../tools/surface/output.js";
import { softRender } from "../tools/softRender.js";
import { grid } from "../tools/review.js";
import { createImage, type MutableImage, type RgbaImage } from "../tools/image.js";
import { distInside } from "../tools/garmentImport.js";
import { regionCorners, regionOpaquePolygon } from "../tools/hardPlate.js";
import { buildHeld, dressHeld, fistSlotName, fxSlotName, gripBoneName, gripCurveLimits, heldAreaMask, loadHeldSpec, runHeldChecks, toItemFrame, type HeldSpec } from "../tools/heldItem.js";
import { DEFAULT_HELD, flagStr, parseArgs } from "../tools/swagTypes.js";
import { armFrontGate, armGroups, elbowInwardGate, faderGate, faderSlots, gripCurveGate, hitGate, inwardSigns, offsetsFor, phaseOrder, type GateResult } from "../tools/heldClipGates.js";
import { crossedArmsGate, lineEndGate, openEndGate, wristGate, type ArmLayerPose } from "../tools/surface/armLayerGates.js";
import { insideLimits } from "../tools/surface/limits.js";
import { renderFrames, sampleIndices, writeGif } from "./render.js";

const FPS = 30;
const ANIMATOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLIPS_DIR = join(ANIMATOR_DIR, "fixtures/clips");

export interface HeldClipFile {
  name: string;
  about?: string;
  clip: any;
  /**
   * Draw position of the item per time range [from, to): behind the body, in front of everything, or `hand`: over the
   * body and the other arm but under the holding arm (the real fist draws over the hilt, no fist copy on top);
   * `arm: "front"` also moves the holding arm's slots after the other arm's (the attacking arm reads in front).
   */
  drawPhases?: { from: number; to: number; order: "back" | "front" | "hand"; arm?: "front" }[];
  /** Attack contact: a `hit` event at `time` (on a frame) and the pose held for `holdFrames` frames after it (hitstop). */
  hit?: { time: number; holdFrames: number };
  /**
   * Grip keys (the held-item template's way to turn the item in the fist): rotate offsets of the grip bone from its
   * setup angle (degrees), on frames, written to the grip bone's rotate timeline; gripCurveGate holds the clip to
   * exactly these keys and to the spec's `grip.curve`. No keys = the item stays at its grip angle.
   */
  grip?: { time: number; value: number; curve?: unknown }[];
  /**
   * Smear sprites: the blade's sweep between `from` and `to`, shown from `show` until `hide`. `style` "crescent" (the
   * default) fills between the tip path and an inner path at blade fractions `inner`; "swipe" is a thin trail along the
   * tip path only, `widthPx` (canvas px, default 18) wide at the leading end, tapering to nothing at the trailing end,
   * fading in from the trailing end, no outline.
   */
  smears?: { name: string; from: number; to: number; show: number; hide: number; inner?: [number, number]; style?: "crescent" | "swipe"; widthPx?: number }[];
}

function loadTextures(docPath: string): Map<string, RgbaImage> {
  const atlasPath = docPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  return texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
}

const pointIn = (poly: readonly [number, number][], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

function poser(doc: any) {
  const loaded = loadAnimDocument(doc);
  const sk = new Skeleton(loaded);
  sk.setActiveSkins([Object.keys(doc.skins)[0] as string]);
  const data = new AnimationStateData(loaded);
  const pose = (clip: string | null, t: number) => {
    sk.setToSetupPose();
    if (clip) {
      const st = new AnimationState(data);
      st.setAnimation(0, clip, { loop: false });
      st.update(t);
      st.apply(sk);
    }
    sk.updateWorldTransform("none");
  };
  return { sk, pose };
}

/** World point of a bone-local point. */
const worldOf = (sk: Skeleton, bone: string, x: number, y: number): [number, number] => {
  const b = sk.findBone(bone);
  if (!b) throw new Error(`no bone ${bone}`);
  const w = b.world;
  return [w.a * x + w.b * y + w.x, w.c * x + w.d * y + w.y];
};

/**
 * Smear sprite for one sweep: the polygon between the tip path and an inner path (blade fraction
 * inner[0] at the trailing end -> inner[1] at the leading end, so the crescent widens toward the
 * blade), filled pale with a darker 5 px outline; returned with its canvas bbox.
 */
function smearSprite(m: ReturnType<typeof poser>, clip: string, s: NonNullable<HeldClipFile["smears"]>[number], grip: string, tipLen: number, ox: number, oy: number): { tex: MutableImage; cx: number; cy: number; opaque: number[] } {
  const steps = 32;
  const [fTrail, fLead] = s.inner ?? [0.9, 0.3];
  const tips: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const q = k / steps;
    m.pose(clip, s.from + (s.to - s.from) * q);
    const ease = q * q * (3 - 2 * q);
    const f = s.style === "swipe" ? 1 - ((s.widthPx ?? 18) * ease) / tipLen : fTrail + (fLead - fTrail) * ease;
    const [tx, ty] = worldOf(m.sk, grip, tipLen, 0);
    const [ix, iy] = worldOf(m.sk, grip, tipLen * f, 0);
    tips.push([tx + ox, ty + oy]);
    inner.push([ix + ox, iy + oy]);
  }
  const poly = [...tips, ...inner.reverse()];
  const pad = 4;
  const x0 = Math.floor(Math.min(...poly.map((p) => p[0]))) - pad;
  const y0 = Math.floor(Math.min(...poly.map((p) => p[1]))) - pad;
  const x1 = Math.ceil(Math.max(...poly.map((p) => p[0]))) + pad;
  const y1 = Math.ceil(Math.max(...poly.map((p) => p[1]))) + pad;
  const w = x1 - x0;
  const h = y1 - y0;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pointIn(poly, x0 + x + 0.5, y0 + y + 0.5)) mask[y * w + x] = 1;
  const d = distInside(mask, w, h);
  const tex = createImage(w, h);
  // conservative opaque triangle around the deepest fill pixel (a region without one trims every stroke under its rectangle)
  let deep = 0;
  for (let i = 1; i < w * h; i++) if ((d[i] as number) > (d[deep] as number)) deep = i;
  const r = Math.max(1, (d[deep] as number) * 0.5);
  const [dx, dy] = [deep % w + 0.5, Math.floor(deep / w) + 0.5];
  const opaque = [0, 1, 2].flatMap((k) => [Number(((dx + r * Math.cos((k * 2 * Math.PI) / 3)) / w).toFixed(5)), Number(((dy + r * Math.sin((k * 2 * Math.PI) / 3)) / h).toFixed(5))]);
  // swipe: alpha rises from the trailing end (first tip sample) to the leading end (last), by nearest tip sample
  const along = (x: number, y: number) => {
    let best = 0;
    let bd = Infinity;
    tips.forEach(([tx, ty], k) => { const dd = (tx - x) ** 2 + (ty - y) ** 2; if (dd < bd) { bd = dd; best = k; } });
    return best / steps;
  };
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    if (s.style === "swipe") tex.data.set([236, 244, 255, Math.round(50 + 180 * along(x0 + (i % w) + 0.5, y0 + Math.floor(i / w) + 0.5))], i * 4);
    else tex.data.set((d[i] as number) <= 5 ? [74, 104, 150, 255] : [236, 246, 255, 255], i * 4);
  }
  return { tex, cx: x0 + w / 2, cy: y0 + h / 2, opaque };
}

interface FrameSample {
  label: string;
  clip: string;
  frame: number;
  gripDeg: number;
  handDeg: number;
  /** The grip bone's local rotation minus its setup rotation (the applied grip key). */
  gripLocal: number;
  order: string[];
  pose: Record<string, number>;
  world: Float64Array;
  /** Stroke opacity (driven alpha times slot alpha) of every contour fader slot. */
  faders: Record<string, number>;
}

/** Every 30 fps frame of each held clip: grip/hand angles, draw order, bone offsets from setup, bone world transforms. */
function sampleClips(doc: any, clips: readonly HeldClipFile[], grip: string, hand: string): FrameSample[] {
  const m = poser(doc);
  const out: FrameSample[] = [];
  const deg = (b: { world: { a: number; c: number } }) => (Math.atan2(b.world.c, b.world.a) * 180) / Math.PI;
  for (const c of clips) {
    const clip = doc.animations[c.name];
    const n = Math.round(clip.duration * FPS);
    for (let f = 0; f <= n; f++) {
      m.pose(c.name, f / FPS);
      const pose: Record<string, number> = {};
      const world = new Float64Array(m.sk.bones.length * 6);
      m.sk.bones.forEach((b, i) => {
        const d = b.pose.rotation - b.data.rotation;
        if (Math.abs(d) > 1e-9) pose[b.data.name] = d;
        world.set([b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y], i * 6);
      });
      const faders: Record<string, number> = {};
      for (const s of m.sk.slots) if (faderSlots([s.data.name]).length) faders[s.data.name] = s.drivenAlpha * s.color.a;
      const gb = m.sk.findBone(grip)!;
      out.push({ label: `${c.name} f${f}`, clip: c.name, frame: f, gripDeg: deg(gb), handDeg: deg(m.sk.findBone(hand)!), gripLocal: gb.pose.rotation - gb.data.rotation, order: m.sk.drawOrder.map((s) => s.data.name), pose, world, faders });
    }
  }
  return out;
}

/** Arm-front frames of the clips: inside a phase declared `arm: "front"`. */
const armFrontFrames = (samples: readonly FrameSample[], clips: readonly HeldClipFile[]) =>
  samples.filter((s) => (clips.find((c) => c.name === s.clip)?.drawPhases ?? []).some((p) => p.arm === "front" && s.frame / FPS >= p.from - 1e-9 && s.frame / FPS < p.to - 1e-9));

/** The attack gates (heldClipGates.ts) on one dressed rig's clips. */
function attackGatesOf(doc: any, clips: readonly HeldClipFile[], spec: HeldSpec): GateResult[] {
  const grip = gripBoneName(spec);
  const samples = sampleClips(doc, clips, grip, spec.hand.bone);
  const gb = (doc.bones as any[]).find((b) => b.name === grip);
  const gripClips = clips.map((c) => {
    const tl = doc.animations[c.name]?.bones?.[grip] ?? {};
    const own = samples.filter((s) => s.clip === c.name);
    return {
      clip: c.name,
      declared: (c.grip ?? []).map((k) => ({ time: k.time, value: k.value })),
      keyed: ((tl.rotate ?? []) as any[]).map((k) => ({ time: k.time as number, value: (k.value ?? 0) as number })),
      otherTimelines: Object.keys(tl).some((k) => k !== "rotate"),
      turn: own.map((s) => s.gripDeg - s.handDeg - (gb.rotation as number)),
      local: own.map((s) => s.gripLocal)
    };
  });
  const free = (doc.slots as any[]).filter((s) => !s.drawAfter && !s.drawBefore).map((s) => s.name as string);
  const groups = armGroups(doc.bones, doc.slots, spec.hand.bone);
  const out = [gripCurveGate(gripClips, gripCurveLimits(spec, FPS))];
  if (clips.some((c) => (c.drawPhases ?? []).some((p) => p.arm === "front"))) out.push(armFrontGate(armFrontFrames(samples, clips), groups.armSlots.filter((n) => free.includes(n)), groups.otherSlots.filter((n) => free.includes(n))));
  const armFaders = faderSlots(groups.armSlots);
  if (armFaders.length && clips.some((c) => (c.drawPhases ?? []).some((p) => p.arm === "front"))) out.push(faderGate(armFrontFrames(samples, clips).map((s) => ({ label: s.label, faders: Object.fromEntries(armFaders.map((n) => [n, s.faders[n] ?? 1])) }))));
  const attacks = clips.filter((c) => c.hit);
  if (attacks.length) out.push(hitGate(attacks.map((c) => ({ clip: c.name, fps: FPS, hit: c.hit as { time: number; holdFrames: number }, events: doc.animations[c.name].events ?? [], frames: samples.filter((s) => s.clip === c.name).map((s) => s.world) }))));
  const limits = (doc.poseLimits ?? []) as any[];
  if (limits.length) out.push(elbowInwardGate(samples.map((s) => ({ label: s.label, pose: s.pose, inside: insideLimits(limits, s.pose) })), inwardSigns(limits)));
  return out;
}

/** The arm-layer per-pose gates (wrist / fist join, crossed arms, line ends, open ends) on every clip frame. */
function armLayerGatesOf(path: string, doc: any, clips: readonly HeldClipFile[], spec: HeldSpec, tex: ReadonlyMap<string, RgbaImage>): GateResult[] {
  const free = (doc.slots as any[]).filter((s) => !s.drawAfter && !s.drawBefore).map((s) => s.name as string);
  const near = armGroups(doc.bones, doc.slots, spec.hand.bone);
  if (!near.otherSlots.length) return [];
  const otherHand = (doc.bones as any[]).find((b) => near.otherSlots.some((n) => (doc.slots as any[]).find((s) => s.name === n).bone === b.name) && !(doc.bones as any[]).some((c) => c.parent === b.name))?.name as string;
  const far = armGroups(doc.bones, doc.slots, otherHand);
  const loaded = loadAnimDocument(doc, { source: path });
  const poses: ArmLayerPose[] = clips.flatMap((c) => Array.from({ length: Math.round(doc.animations[c.name].duration * FPS) + 1 }, (_, f) => ({ name: `${c.name} f${f}`, rotate: {}, clip: { name: c.name, time: f / FPS } })));
  const frontFrames = new Set(clips.flatMap((c) => poses.filter((p) => p.clip?.name === c.name && (c.drawPhases ?? []).some((ph) => ph.arm === "front" && (p.clip as { time: number }).time >= ph.from - 1e-9 && (p.clip as { time: number }).time < ph.to - 1e-9)).map((p) => p.name)));
  // the arm's flat skin: the most common opaque colour of its sheet texture
  const sheetSlot = (doc.slots as any[]).find((s) => s.bone === near.armBones[near.armBones.length - 2])?.name as string;
  const sheetAtt = Object.values(doc.skins[Object.keys(doc.skins)[0] as string].attachments[sheetSlot] ?? {})[0] as any;
  const img = tex.get(sheetAtt?.path ?? "") as RgbaImage | undefined;
  const counts = new Map<number, number>();
  if (img) for (let i = 0; i < img.width * img.height; i++) if ((img.data[i * 4 + 3] as number) === 255) { const k = ((img.data[i * 4] as number) << 16) | ((img.data[i * 4 + 1] as number) << 8) | (img.data[i * 4 + 2] as number); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const skin: [number, number, number] = [(top >> 16) & 255, (top >> 8) & 255, top & 255];
  // the fist copy is part of the holding fist: drawn with the item (over everything in a front phase) it trims the
  // real fist's outline, and its own identical outline carries the line there
  const side = (g: typeof near) => {
    const slots = g.armSlots.filter((n) => free.includes(n) && !n.includes("_fade"));
    const hand = (doc.slots as any[]).find((s) => s.bone === g.armBones[0] && slots.includes(s.name))?.name as string;
    return { slots: g === near ? [...slots, fistSlotName(spec)] : slots, hand };
  };
  const fronts = poses.filter((p) => frontFrames.has(p.name));
  const rest = poses.filter((p) => !frontFrames.has(p.name));
  const rect: [number, number, number, number] = [250, 560, 834, 1100];
  const elbows = [near.armBones[1], far.armBones[1]] as string[];
  const out = [
    wristGate(loaded, tex, [side(near), side(far)], poses, 45, skin),
    lineEndGate(loaded, tex, [near.armBones[2], far.armBones[2], ...elbows] as string[], poses),
    openEndGate(loaded, elbows, poses)
  ];
  const nearFront = [...near.armSlots, fistSlotName(spec)];
  if (fronts.length) out.push({ ...crossedArmsGate(loaded, tex, nearFront, far.armSlots, fronts, rect), gate: "crossed arms (arm-front frames): the attacking arm draws wholly over the other arm" });
  // outside the arm-front phases the rig's own order holds: its front arm is the one whose slots draw later in the
  // setup order (the front view's mirrored arm; the turned side's near arm, which may be the holding arm)
  const slotAt = (n: string) => (doc.slots as any[]).findIndex((s) => s.name === n);
  const holdingFront = Math.min(...near.armSlots.map(slotAt)) > Math.max(...far.armSlots.map(slotAt));
  if (rest.length) out.push({ ...(holdingFront ? crossedArmsGate(loaded, tex, nearFront, far.armSlots, rest, rect) : crossedArmsGate(loaded, tex, far.armSlots, nearFront, rest, rect)), gate: "crossed arms (other frames): the rig's front arm draws wholly over the other arm" });
  return out;
}

export async function heldImportCommand(positional: readonly string[], flags: Map<string, string | true>): Promise<number> {
  const [rigPath, artPath, outDir] = positional as [string, string, string];
  if (!rigPath || !artPath || !outDir) {
    process.stderr.write("usage: heldImport <rig.anim.json> <held.png> <out dir> [--held <spec>] [--clips a.json,b.json] [--also rig2.anim.json,...] [--no-render]\n");
    return 2;
  }
  const specPath = resolve(flagStr(flags, "held") ?? DEFAULT_HELD);
  const spec: HeldSpec = loadHeldSpec(specPath);
  const clipPaths = (flagStr(flags, "clips")?.split(",").filter(Boolean).map((p) => resolve(p))) ?? (existsSync(CLIPS_DIR) ? readdirSync(CLIPS_DIR).filter((n) => n.startsWith(`${spec.name}-`) && n.endsWith(".json")).map((n) => join(CLIPS_DIR, n)) : []);
  const clips: HeldClipFile[] = clipPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  const rigs = [rigPath, ...(flagStr(flags, "also")?.split(",").filter(Boolean) ?? [])].map((p) => resolve(p));
  const art = readPng(artPath);
  const checks = runHeldChecks(art, spec);
  const item = spec.name;
  const fist = fistSlotName(spec);
  const fx = fxSlotName(spec);
  const grip = gripBoneName(spec);
  // tip length: the art's farthest opaque pixel along the axis
  let tipLen = 0;
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) if ((art.data[(y * art.width + x) * 4 + 3] as number) >= 128) tipLen = Math.max(tipLen, toItemFrame(spec, x + 0.5, y + 0.5)[0]);

  const rigDir = join(outDir, "rig");
  mkdirSync(rigDir, { recursive: true });
  const docs: { name: string; path: string; atlas: string; doc: any; tex: Map<string, RgbaImage> }[] = [];
  let restIoU = 0;
  for (const rp of rigs) {
    const raw = JSON.parse(readFileSync(rp, "utf8"));
    const ox = raw.canvas.originX as number;
    const oy = raw.canvas.originY as number;
    const piece = buildHeld(raw, spec, art);
    const tex = new Map(loadTextures(rp));
    tex.set(piece.texturePath, piece.texture);
    let doc = dressHeld(raw, piece, spec, { fx: { bone: (raw.bones as any[])[0].name, attachments: {} } });
    // clips; the draw-order keys come from drawPhases, as offsets among this rig's unanchored slots
    const free = (doc.slots as any[]).filter((s) => !s.drawAfter && !s.drawBefore).map((s) => s.name as string);
    const groups = armGroups(doc.bones, doc.slots, spec.hand.bone);
    const armFront = { arm: groups.armSlots.filter((n) => free.includes(n)), other: groups.otherSlots.filter((n) => free.includes(n)) };
    for (const c of clips) {
      const clip = structuredClone(c.clip);
      if (c.drawPhases?.length) clip.drawOrder = c.drawPhases.map((p) => ({ time: p.from, offsets: offsetsFor(free, phaseOrder(free, item, p.order, p.arm === "front" && armFront.other.length ? armFront : null, armFront.arm)) }));
      if (c.hit) {
        clip.events = [{ time: c.hit.time, name: "hit" }];
        doc.events = { ...(doc.events ?? {}), hit: {} };
      }
      if (c.grip?.length) clip.bones = { ...(clip.bones ?? {}), [grip]: { ...(clip.bones?.[grip] ?? {}), rotate: c.grip.map((k) => ({ time: k.time, value: k.value, curve: k.curve ?? "linear" })) } };
      doc.animations[c.name] = clip;
    }
    // smears from the motion (needs the dressed, clipped rig)
    const m0 = poser(doc);
    for (const c of clips) {
      const keys: { time: number; name: string | null }[] = [];
      for (const s of c.smears ?? []) {
        const sp = smearSprite(m0, c.name, s, grip, tipLen, ox, oy);
        const name = `${c.name}_${s.name}`;
        const path = `fx/${item}_${name}`;
        tex.set(path, sp.tex);
        doc.skins[Object.keys(doc.skins)[0] as string].attachments[fx][name] = { type: "region", path, x: Number((sp.cx - ox).toFixed(3)), y: Number((sp.cy - oy).toFixed(3)), rotation: 0, width: sp.tex.width, height: sp.tex.height, opaque: sp.opaque };
        keys.push({ time: s.show, name }, { time: s.hide, name: null });
      }
      if (keys.length) {
        keys.sort((a, b) => a.time - b.time || (a.name === null ? -1 : 1));
        const merged = keys.filter((k, i) => !(i + 1 < keys.length && Math.abs((keys[i + 1] as { time: number }).time - k.time) < 1e-9));
        doc.animations[c.name].slots = { ...(doc.animations[c.name].slots ?? {}), [fx]: { attachment: merged[0]?.time === 0 ? merged : [{ time: 0, name: null }, ...merged] } };
      }
    }
    const stem = `${basename(rp).replace(/\.anim\.json$/, "")}-${item}`;
    writeAtlas(tex, rigDir, stem);
    const path = join(rigDir, `${stem}.anim.json`);
    writeFileSync(path, JSON.stringify(doc));
    loadAnimDocument(doc, { source: path });
    docs.push({ name: stem, path, atlas: join(rigDir, `${stem}.atlas.json`), doc, tex });
    // rest registration (first rig): the grip turned to the art axis, the item alone against the art
    if (rp === rigs[0]) {
      const reg = structuredClone(doc);
      const m = poser(reg);
      m.pose(null, 0);
      const handRot = (Math.atan2(m.sk.findBone(spec.hand.bone)!.world.c, m.sk.findBone(spec.hand.bone)!.world.a) * 180) / Math.PI;
      (reg.bones as any[]).find((b) => b.name === grip).rotation = spec.art.axis - handRot;
      const mr = poser(reg);
      mr.pose(null, 0);
      const W = raw.canvas.width as number;
      const H = raw.canvas.height as number;
      const slot = mr.sk.getSlot(item);
      const img = softRender(mr.sk, tex, { width: W, height: H, left: -ox, top: -oy, slotFilter: (s) => s === slot }).image;
      const box = heldAreaMask(spec, W, H, 2);
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < W * H; i++) {
        if (!box[i]) continue;
        const a = (img.data[i * 4 + 3] as number) >= 128;
        const b = (art.data[i * 4 + 3] as number) >= 128;
        if (a && b) inter++;
        if (a || b) uni++;
      }
      restIoU = uni ? inter / uni : 0;
    }
  }

  // --- posed gates over every frame of every clip of every rig
  let frames = 0;
  let attachedMax = 0;
  let rigidMax = 0;
  let handleOut = 0;
  let fistBad = 0;
  let orderBad = 0;
  const worst: string[] = [];
  const switched: Record<string, { back: number; front: number; hand: number }> = {};
  for (const d of docs) {
    const skinKey = Object.keys(d.doc.skins)[0] as string;
    const fistAttName = (d.doc.slots as any[]).find((s) => s.name === spec.hand.fistSlot).attachment as string;
    const fistOpaque: number[] | undefined = d.doc.skins[skinKey].attachments[spec.hand.fistSlot][fistAttName].opaque;
    const contoursSame = JSON.stringify(d.doc.skins[skinKey].contours?.[spec.hand.fistSlot] ?? null) === JSON.stringify(d.doc.skins[skinKey].contours?.[fist] ?? null);
    const joinsOf = (slot: string) => JSON.stringify(((d.doc.skins[skinKey].contourJoins ?? []) as any[]).filter((j) => j.a.slot === slot || j.b.slot === slot).map((j) => ({ ...j, a: { ...j.a, slot: j.a.slot === slot ? "F" : j.a.slot }, b: { ...j.b, slot: j.b.slot === slot ? "F" : j.b.slot } })));
    if (!contoursSame || joinsOf(spec.hand.fistSlot) !== joinsOf(fist)) fistBad++;
    const m = poser(d.doc);
    const ox = d.doc.canvas.originX as number;
    const oy = d.doc.canvas.originY as number;
    m.pose(null, 0);
    const dist = (c: [number, number][]) => [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]].map(([i, j]) => Math.hypot(c[i as number]![0] - c[j as number]![0], c[i as number]![1] - c[j as number]![1]));
    const rest = dist(regionCorners(m.sk, item, ox, oy));
    const gb = (d.doc.bones as any[]).find((b) => b.name === grip);
    const bodySlots = (d.doc.slots as any[]).map((s) => s.name).filter((n: string) => ![item, fist, fx].includes(n));
    const firstBody = bodySlots[0] as string;
    const dGroups = armGroups(d.doc.bones, d.doc.slots, spec.hand.bone);
    const fistW = new Float32Array(8);
    const copyW = new Float32Array(8);
    for (const [clipName, clip] of Object.entries(d.doc.animations as Record<string, any>)) {
      const phases = clips.find((c) => c.name === clipName)?.drawPhases ?? [];
      const n = Math.round(clip.duration * FPS);
      for (let f = 0; f <= n; f++) {
        const t = f / FPS;
        m.pose(clipName, t);
        frames++;
        const g = m.sk.findBone(grip)!.world;
        const [hx, hy] = worldOf(m.sk, spec.hand.bone, gb.x, gb.y);
        attachedMax = Math.max(attachedMax, Math.hypot(g.x - hx, g.y - hy));
        dist(regionCorners(m.sk, item, ox, oy)).forEach((v, i) => { rigidMax = Math.max(rigidMax, Math.abs(v - (rest[i] as number))); });
        if (fistOpaque) {
          const poly = regionOpaquePolygon(m.sk, spec.hand.fistSlot, fistOpaque, ox, oy);
          for (let u = -0.8 * spec.art.fistRadius; u <= 0.8 * spec.art.fistRadius; u += 4) {
            const [px, py] = worldOf(m.sk, grip, u, 0);
            if (!pointIn(poly, px + ox, py + oy)) { handleOut++; if (worst.length < 12) worst.push(`${d.name} ${clipName} f${f}: handle point u ${u.toFixed(0)} outside the fist`); break; }
          }
        } else handleOut++;
        const order = m.sk.drawOrder.map((s) => s.data.name);
        const io = order.indexOf(item);
        if (order.indexOf(fist) !== io + 1) { fistBad++; if (worst.length < 12) worst.push(`${d.name} ${clipName} f${f}: fist copy not right after the item`); }
        m.sk.computeSlotWorldVertices(m.sk.getSlot(spec.hand.fistSlot), fistW);
        m.sk.computeSlotWorldVertices(m.sk.getSlot(fist), copyW);
        for (let i = 0; i < 8; i++) if (Math.abs((fistW[i] as number) - (copyW[i] as number)) > 1e-6) { fistBad++; break; }
        const ph = phases.find((p) => t >= p.from - 1e-9 && t < p.to - 1e-9);
        if (ph) {
          const key = `${d.name} ${clipName}`;
          switched[key] ??= { back: 0, front: 0, hand: 0 };
          const armMin = Math.min(...dGroups.armSlots.filter((n) => order.includes(n) && n !== fist).map((n) => order.indexOf(n)));
          const otherMax = Math.max(-1, ...dGroups.otherSlots.map((n) => order.indexOf(n)));
          const ok = ph.order === "back" ? io < order.indexOf(firstBody) : ph.order === "hand" ? io > order.indexOf(firstBody) && io > otherMax && io < armMin : io > order.indexOf("head");
          if (ok) switched[key][ph.order]++;
          else { orderBad++; if (worst.length < 12) worst.push(`${d.name} ${clipName} f${f}: item not ${ph.order} (index ${io})`); }
        }
      }
    }
  }
  const phased = clips.filter((c) => (c.drawPhases ?? []).length);
  const gates = {
    swagChecks: checks.passed,
    restRegistration: restIoU >= 0.985,
    attached: frames > 0 && attachedMax < 1e-3,
    rigid: frames > 0 && rigidMax < 1e-3,
    handleInFist: frames > 0 && handleOut === 0,
    fistOverItem: frames > 0 && fistBad === 0,
    drawOrderSwitch: phased.length > 0 && orderBad === 0 && docs.every((d) => phased.every((c) => [...new Set((c.drawPhases ?? []).map((p) => p.order))].every((o) => (switched[`${d.name} ${c.name}`]?.[o] ?? 0) > 0)))
  };
  // attack gates (heldClipGates.ts) and the arm-layer per-pose gates on every clip frame, per rig
  const attack: { rig: string; results: GateResult[] }[] = docs.map((d) => ({ rig: d.name, results: [...attackGatesOf(d.doc, clips, spec), ...armLayerGatesOf(d.path, d.doc, clips, spec, d.tex)] }));
  for (const a of attack) for (const r of a.results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${a.rig}: ${r.gate}: ${r.detail}
`);
  // damaged controls on the first rig: each must FAIL its gate
  const controls: { control: string; gate: string; failed: boolean; detail: string }[] = [];
  if (docs.length && clips.length) {
    const d0 = docs[0] as (typeof docs)[number];
    const gateOf = (doc: any, name: string, cs: readonly HeldClipFile[] = clips) => attackGatesOf(doc, cs, spec).find((r) => r.gate.startsWith(name)) as GateResult | undefined;
    const control = (label: string, name: string, damage: (doc: any, cs: HeldClipFile[]) => void) => {
      const doc = structuredClone(d0.doc);
      const cs = structuredClone(clips) as HeldClipFile[];
      damage(doc, cs);
      const r = gateOf(doc, name, cs);
      if (r) controls.push({ control: label, gate: r.gate, failed: !r.ok, detail: r.detail });
    };
    const c0 = clips.find((c) => c.hit) ?? (clips[0] as HeldClipFile);
    const idle = clips.find((c) => !c.grip?.length) ?? c0;
    control("unkeyed grip spin: the grip turned a full 360 deg over a clip, no declared grip keys", "grip curve", (doc) => {
      const dur = doc.animations[idle.name].duration as number;
      const bones = doc.animations[idle.name].bones ?? {};
      bones[grip] = { rotate: [{ time: 0, value: 0 }, { time: Number((dur / 2).toFixed(6)), value: 180 }, { time: dur, value: 360 }] };
      doc.animations[idle.name].bones = bones;
    });
    control("unkeyed grip roll: 30 deg mid-clip added to the attack clip's grip timeline only (the first-pass spin)", "grip curve", (doc) => {
      const dur = doc.animations[c0.name].duration as number;
      const rot = ((doc.animations[c0.name].bones?.[grip]?.rotate ?? []) as any[]).filter((k) => Math.abs(k.time - dur / 2) > 1e-6);
      rot.push({ time: Number((dur / 2).toFixed(6)), value: 30, curve: "linear" });
      rot.sort((a, b) => a.time - b.time);
      doc.animations[c0.name].bones = { ...(doc.animations[c0.name].bones ?? {}), [grip]: { rotate: rot } };
    });
    control("keyed grip jitter: +-8 deg on alternate frames, declared and keyed alike", "grip curve", (doc, cs) => {
      const c = cs.find((x) => x.name === c0.name) as HeldClipFile;
      const dur = doc.animations[c0.name].duration as number;
      const n = Math.round(dur * FPS);
      const base = new Map((c.grip ?? []).map((k) => [Math.round(k.time * FPS), k.value]));
      // the authored curve sampled on every frame (from the undamaged rig), plus the jitter
      const m = poser(d0.doc);
      const keys: { time: number; value: number; curve: string }[] = [];
      for (let f = 0; f <= n; f++) {
        m.pose(c0.name, f / FPS);
        const g = m.sk.findBone(grip)!;
        const v = base.get(f) ?? g.pose.rotation - g.data.rotation;
        keys.push({ time: Number((f / FPS).toFixed(6)), value: Number((v + (f > 0 && f < n ? (f % 2 ? 8 : -8) : 0)).toFixed(4)), curve: "linear" });
      }
      c.grip = keys;
      doc.animations[c0.name].bones = { ...(doc.animations[c0.name].bones ?? {}), [grip]: { rotate: keys } };
    });
    control("grip drift: the grip bone stops inheriting the hand's rotation", "grip curve", (doc) => {
      (doc.bones as any[]).find((b) => b.name === grip).inherit = "noRotation";
    });
    if (clips.some((c) => (c.drawPhases ?? []).some((p) => p.arm === "front"))) control("arm-front draw-order keys dropped (item keys only)", "arm front", (doc) => {
      const free = (doc.slots as any[]).filter((s: any) => !s.drawAfter && !s.drawBefore).map((s: any) => s.name as string);
      for (const c of clips) if (c.drawPhases?.length) doc.animations[c.name].drawOrder = c.drawPhases.map((p) => ({ time: p.from, offsets: offsetsFor(free, phaseOrder(free, item, p.order, null, armGroups(doc.bones, doc.slots, spec.hand.bone).armSlots.filter((n) => free.includes(n)))) }));
    });
    control("arm fader ramps widened back to 14 deg (the round-1 shoulder ring)", "faders", (doc) => {
      // every two-key fader ramp of the holding arm stretched to 14 deg about its midpoint (the old preset's -20..-6)
      const arm = new Set(faderSlots(armGroups(doc.bones, doc.slots, spec.hand.bone).armSlots));
      for (const set of (doc.driven ?? []) as any[]) {
        if (set.keys?.length !== 2 || !Object.keys(set.keys[0].alpha ?? {}).some((n) => arm.has(n))) continue;
        const mid = (set.keys[0].at + set.keys[1].at) / 2;
        const dir = Math.sign(set.keys[1].at - set.keys[0].at) || 1;
        set.keys[0].at = mid - 7 * dir;
        set.keys[1].at = mid + 7 * dir;
      }
    });
    if (c0.hit) {
      control("hit event one frame late", "hit event", (doc) => { doc.animations[c0.name].events = [{ time: Number(((c0.hit as { time: number }).time + 1 / FPS).toFixed(6)), name: "hit" }]; });
      control("hitstop hold removed (pelvis nudged on the held frame)", "hit event", (doc) => {
        const t = Number(((c0.hit as { time: number }).time + 1 / FPS).toFixed(6));
        const root = (doc.bones as any[])[1].name as string;
        doc.animations[c0.name].bones = { ...(doc.animations[c0.name].bones ?? {}), [root]: { ...(doc.animations[c0.name].bones?.[root] ?? {}), translate: [{ time: 0, x: 0, y: 0 }, { time: t, x: 0, y: 3 }, { time: doc.animations[c0.name].duration, x: 0, y: 0 }] } };
      });
    }
    control("one elbow keyed outward (+12) mid-clip", "pose limits", (doc) => {
      const elbow = armGroups(doc.bones, doc.slots, spec.hand.bone).armBones[1] as string;
      const sign = inwardSigns(doc.poseLimits ?? []).find((s) => s.bone === elbow)?.sign ?? -1;
      const dur = doc.animations[c0.name].duration as number;
      doc.animations[c0.name].bones = { ...(doc.animations[c0.name].bones ?? {}), [elbow]: { rotate: [{ time: 0, value: 0 }, { time: Number((dur / 2).toFixed(6)), value: -12 * sign }, { time: dur, value: 0 }] } };
    });
  }
  for (const c of controls) process.stdout.write(`${c.failed ? "control FAILS as it must" : "CONTROL PASSES (gate too weak)"}: ${c.control}: ${c.detail}
`);
  (gates as Record<string, boolean>).attackGates = attack.every((a) => a.results.every((r) => r.ok));
  (gates as Record<string, boolean>).attackControls = controls.length > 0 && controls.every((c) => c.failed);
  const failedGates = Object.entries(gates).filter(([, v]) => v !== true).map(([k]) => k);
  const certified = failedGates.length === 0;
  const report = { spec: specPath, art: artPath, clips: clipPaths, rigs: docs.map((d) => d.path), swagChecks: checks, restIoU: Number(restIoU.toFixed(4)), tipLengthPx: Number(tipLen.toFixed(1)), framesChecked: frames, attachedMaxPx: attachedMax, rigidMaxPx: rigidMax, handleOutFrames: handleOut, fistViolations: fistBad, drawOrderViolations: orderBad, drawPhaseFrames: switched, worst, attack, controls, gates, certified, failedGates };
  writeFileSync(join(outDir, `${item}.report.json`), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ gates, certified, restIoU: report.restIoU, frames, attachedMaxPx: attachedMax, rigidMaxPx: rigidMax, handleOutFrames: handleOut })}\n`);
  if (!certified) process.stderr.write(`NOT CERTIFIED: failed gates ${failedGates.join(", ")}\n`);
  const exitCode = certified ? 0 : 1;
  if (flags.has("no-render")) return exitCode;

  // --- evidence: 0.4 30 fps GIFs, 8-frame sheets, 4x crops of the sword hand
  const bg = 0xb4b9c2;
  const s = 0.4;
  const extra = 160;
  for (const d of docs) {
    const W = d.doc.canvas.width as number;
    const H = d.doc.canvas.height as number;
    const ox = d.doc.canvas.originX as number;
    const oy = d.doc.canvas.originY as number;
    const view = { scale: s, width: Math.round((W + extra) * s), height: Math.round(H * s), x: Math.round((ox + extra) * s), y: Math.round(oy * s) };
    for (const c of clips) {
      const r = await renderFrames({ document: d.path, atlas: d.atlas, clip: c.name, fps: FPS, background: bg, ...view });
      writeGif(r, join(outDir, `${d.name}-${c.name}-view040-30fps.gif`));
      const idx = sampleIndices(r.frames.length, 8);
      writePng(join(outDir, `${d.name}-${c.name}-view040-8f-sheet.png`), grid(idx.map((i) => ({ image: decodePng((r.frames[i] as { png: Buffer }).png), label: `${c.name} f${i}` })), 4));
    }
    // 4x of the 0.4 view (1.6 output px per canvas px), 150 canvas px around the fist, every frame of each clip
    const z = 4 * s;
    const half = 95;
    const m = poser(d.doc);
    for (const c of clips) {
      const r = await renderFrames({ document: d.path, atlas: d.atlas, clip: c.name, fps: FPS, background: bg, scale: z, width: Math.round((W + extra) * z), height: Math.round(H * z), x: Math.round((ox + extra) * z), y: Math.round(oy * z) });
      const tiles: { image: RgbaImage; label: string }[] = [];
      r.frames.forEach((fr, i) => {
        m.pose(c.name, i / FPS);
        const [gx, gy] = worldOf(m.sk, grip, 0, 0);
        const img = decodePng(fr.png);
        const cx = Math.round((gx + ox + extra) * z);
        const cy = Math.round((gy + oy) * z);
        const size = Math.round(2 * half * z);
        const crop = createImage(size, size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const sx = cx - size / 2 + x;
          const sy = cy - size / 2 + y;
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
          crop.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * size + x) * 4);
        }
        tiles.push({ image: crop, label: `${c.name} f${i}` });
      });
      writePng(join(outDir, `${d.name}-${c.name}-hand-4x-view040.png`), grid(tiles, 6));
    }
  }
  process.stdout.write("rendered GIFs, sheets and hand crops\n");
  return exitCode;
}

const stemOf = (path: string) => resolve(path).replace(/\.[cm]?[jt]s$/, "");
if (process.argv[1] && stemOf(process.argv[1]) === stemOf(fileURLToPath(import.meta.url))) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  heldImportCommand(positional, flags).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exit(1); });
}
