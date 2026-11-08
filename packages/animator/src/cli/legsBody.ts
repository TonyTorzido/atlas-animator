/*
 * Atlas Animator: original implementation.
 *
 * Plan: the whole body with legs.
 * `tsx src/cli/legsBody.ts <leg half rig dir> <leg preset.json> <body anim.json> <body preset.json> <out dir> [--no-render]`
 * (every bone, slot and point comes from the two presets and the documents: no template names).
 * mirrors the one built leg (tools/mirrorRig.ts: one welded hips skin, the shorts as one mesh, the
 * crotch closed on the welded midline), merges the legs into the certified upper body by
 * name (shared root/pelvis, leg slots: hips under the torso, shorts over the tank; the upper body
 * is not re-merged), and bakes the evidence clips with planted feet: a two-bone solve per frame
 * places the ankle so the sole contact point (the setup-pose sole, foot kept at its setup world
 * angle) lands on a world-space plant; stance holds the plant in world space and re-derives the
 * skeleton-space target every frame; the knee keeps its outward bend side and never reaches full
 * extension (soft reach clamp); release and reacquire ease in and out (zero velocity at contact).
 * Measures sole drift and ground penetration in stance, reach clamping on unreachable targets,
 * knee stability near extension and FK -> IK transitions; renders GIFs and 8-frame sheets at game
 * size and 3x, bare and dressed (tank + shorts).
 *: runtime two-bone IK constraints (foot targets outside the chain, keyed per frame from
 * the world plant; the projected foreshortening is keyed as thigh scale so the runtime solve
 * reaches the target with a small constant outward bend), feet inherit translation only, live
 * measurement through AnimationState, the torso flows into the hips (bottom-edge stroke dropped,
 * body-owned hip contours), leg shading repainted to the art's light side, and the combined
 * validator run on the clips.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { handOverChainJoints } from "../tools/contourHandover.js";
import { repaintHiddenInk } from "../tools/hiddenInk.js";
import { Skeleton } from "../core/skeleton.js";
import type { Bone } from "../core/bone.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { deriveBodyContours } from "../tools/bodyContours.js";
import { mirrorRig } from "../tools/mirrorRig.js";
import { decodePng, readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas, validateRig } from "../tools/validate.js";
import { writeAtlas } from "../tools/surface/output.js";
import { loadPreset } from "../tools/surface/preset.js";
import { paintFromArt } from "../tools/surface/paintFromArt.js";
import { loadFullBody, partSlots, type FullBodyPart } from "../tools/surface/fullBody.js";
import { grid } from "../tools/review.js";
import { renderFrames, writeGif, type RenderResult } from "./render.js";
import { walkFrames, type WalkParams } from "../tools/walkCycle.js";
import { encodePng } from "../tools/png.js";
import { IK_SOFT_SHARE, MAX_IK_REACH } from "../tools/ikReach.js";
import { solveStraightStance, swingIkMix, type StanceRig } from "../tools/stancePolicy.js";
import type { RgbaImage } from "../tools/image.js";

type V = { x: number; y: number };
type Pose = Record<string, number>;
const FPS = 30;
/** IK softness (canvas px): clip targets sit exactly at the start of this zone (reached exactly, small constant bend). */
const IK_SOFTNESS = 0; // set from the rest chain length below (IK_SOFT_SHARE of it)
/** Hard IK: clip targets stay within this share of the chain reach. */
const MAX_REACH = MAX_IK_REACH;
/** Walk: foot lift and pelvis bob, canvas px (front view, projected). */
const WALK_LIFT = 30;
const WALK_BOB = 7;
const SIDES = ["l", "r"] as const;
/** Contour join reach: this multiple of the rest bridge arc (stroke end to silhouette). */
const JOIN_REACH_SCALE = 1;
type Side = (typeof SIDES)[number];

function loadRig(dir: string, name: string): { raw: any; textures: Map<string, RgbaImage> } {
  const raw = JSON.parse(readFileSync(join(dir, `${name}.anim.json`), "utf8"));
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(join(dir, `${name}.atlas.json`), "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(dir, p.file))] as [string, RgbaImage]));
  return { raw, textures: texturesFromAtlas(pack, pages) };
}

/** Merges the mirrored legs into the upper body by name: shared bones must agree at setup. */
export function mergeLegs(body: any, legs: any): { doc: any; report: Record<string, unknown> } {
  const doc = structuredClone(body);
  const names = new Set(doc.bones.map((b: any) => b.name));
  const shared: string[] = [];
  for (const b of legs.bones) {
    if (names.has(b.name)) {
      const o = doc.bones.find((x: any) => x.name === b.name);
      for (const k of ["x", "y", "rotation", "length", "parent"]) if (JSON.stringify(o[k] ?? null) !== JSON.stringify(b[k] ?? null)) throw new Error(`shared bone ${b.name} differs in ${k}`);
      shared.push(b.name);
    } else doc.bones.push(structuredClone(b));
  }
  const slotNames = new Set(doc.slots.map((s: any) => s.name));
  for (const s of legs.slots) if (slotNames.has(s.name)) throw new Error(`slot ${s.name} exists in the body`);
  const [first, ...rest] = legs.slots.map((s: any) => structuredClone(s));
  // hips (the leg skin) under everything: the torso covers the waist overlap and flows into it;
  // the leg garment slots go right below the body's torso garment (the tank hem over the waistband).
  doc.slots.unshift(first);
  // below the body's first embedded garment (the torso garment)
  const embedded = (slot: string) => Object.values(doc.skins as Record<string, any>).some((sk) => Object.values(sk.attachments?.[slot] ?? {}).some((a: any) => a.embed));
  const at = doc.slots.findIndex((s: any) => embedded(s.name));
  // an undressed upper body (the arm layer has no torso garment): right above the torso skin, under the arms
  doc.slots.splice(at < 0 ? 2 : at, 0, ...rest);
  for (const [key, sk] of Object.entries(legs.skins as Record<string, any>)) {
    const target = (doc.skins[key] ??= { attachments: {} });
    for (const [slot, atts] of Object.entries(sk.attachments ?? {})) target.attachments[slot] = structuredClone(atts);
    for (const [slot, cs] of Object.entries(sk.contours ?? {})) (target.contours ??= {})[slot] = structuredClone(cs);
    for (const k of Object.keys(sk)) if (k !== "attachments" && k !== "contours") throw new Error(`leg skin field ${k} not merged`);
  }
  doc.driven = [...(doc.driven ?? []), ...structuredClone(legs.driven ?? [])];
  doc.drivenGrids = [...(doc.drivenGrids ?? []), ...structuredClone(legs.drivenGrids ?? [])];
  for (const k of Object.keys(legs)) if (!["format", "name", "canvas", "bones", "slots", "skins", "animations", "driven", "drivenGrids"].includes(k)) throw new Error(`leg document field ${k} not merged`);
  doc.name = `${body.name}-legs`;
  doc.animations = {};
  return { doc, report: { shared, bones: doc.bones.length, slots: doc.slots.map((s: any) => s.name) } };
}

/** Removes garment attachments (and their contours) for the bare-body renders. */
function bareDoc(doc: any): any {
  const out = structuredClone(doc);
  const removed = new Set<string>();
  for (const sk of Object.values(out.skins as Record<string, any>)) {
    for (const [slot, atts] of Object.entries((sk.attachments ?? {}) as Record<string, Record<string, any>>)) {
      if (!Object.values(atts).some((a) => a.embed)) continue;
      delete sk.attachments[slot];
      delete sk.contours?.[slot];
      removed.add(slot);
    }
    // overlay contours drawn from a removed garment's mesh go with it
    for (const cs of Object.values((sk.contours ?? {}) as Record<string, Record<string, any>>)) for (const [n, c] of Object.entries(cs)) if (removed.has(c.mesh?.slot)) delete cs[n];
  }
  return out;
}

/**
 * Splits every contour on the mesh at its bottom row (the hull vertices at the largest bind y):
 * the run along the bottom edge goes, the flank runs keep their bottom corners. Returns the count.
 */
function dropBottomEdge(doc: any, slot: string, attachment: string): number {
  let dropped = 0;
  for (const sk of Object.values(doc.skins as Record<string, any>)) {
    const mesh = sk.attachments?.[slot]?.[attachment];
    if (!mesh || mesh.type !== "mesh") continue;
    const v = (i: number) => (mesh.uvs[i * 2 + 1] as number) * mesh.height;
    let vmax = -Infinity;
    for (let i = 0; i < mesh.hull; i++) vmax = Math.max(vmax, v(i));
    const bottom = (i: number) => i < mesh.hull && v(i) > vmax - 0.5;
    const byName = (sk.contours?.[slot] ?? {}) as Record<string, any>;
    for (const [name, c] of Object.entries(byName)) {
      if (c.mesh?.slot !== slot || c.mesh?.attachment !== attachment) continue;
      const pts = c.points as number[];
      // split between consecutive bottom-row points (the bottom edge), keep runs that leave it
      const runs: number[][] = [[]];
      pts.forEach((p, k) => {
        if (k > 0 && bottom(p) && bottom(pts[k - 1] as number)) runs.push([]);
        (runs[runs.length - 1] as number[]).push(p);
      });
      const kept = runs.filter((r) => r.some((p) => !bottom(p)) && r.length >= 2);
      if (kept.length === 1 && kept[0]?.length === pts.length) continue;
      dropped += pts.length - kept.reduce((t, r) => t + r.length, 0);
      delete byName[name];
      kept.forEach((r, i) => (byName[i ? `${name}_${i}` : name] = { ...c, points: r }));
    }
  }
  return dropped;
}

type Preset = ReturnType<typeof loadPreset>;

/**
 * What the body pipeline reads per side (phase 2b, packages/animator/README.md). Side "l" is
 * the leg preset's own chain with the body preset's arm; side "r" is its partner. Mirror mode derives
 * "r" from the reflection (names from the mirror renames, key signs -1, the sole reflected about
 * mirror.x, sided region boxes and fist keeps reflected); full-body mode takes it from the partner
 * parts (their own chains, silhouettes and regions, signs from the root bones' limits). The pipeline
 * reads the mirror only through these fields.
 */
export interface BodyInputs {
  doc: any;
  textures: Map<string, RgbaImage>;
  /** Side "l" leg preset (base, chain, skin, canvas scale, ik policy). */
  preset: Preset;
  /** Side "l" arm / upper-body preset (arm chain, lean base, branches). */
  bodyPreset: Preset;
  /** Leg bone of side "l" -> the same bone of side "r". */
  legPair: Record<string, string>;
  /** Arm chain bone of side "l" -> side "r". */
  armPair: Record<string, string>;
  /** Key sign of each side's leg and arm rotations (a reflected side turns the other way). */
  legSign: Record<Side, number>;
  armSign: Record<Side, number>;
  /** Each leg's sole contact point on the canvas: the mean x of its lowest silhouette points, that row. */
  sole: Record<Side, [number, number]>;
  /** Mirror mode only: the reflection axis (far-leg shading repaint, far fist rebake and fist outlines). */
  mirrorX: number | null;
  /** The torso mesh whose bottom-edge stroke flows into the hips. */
  torso: { slot: string; attachment: string };
  /** Skin meshes whose visible hull is fitted to the art outline. */
  skinMeshes: [string, string][];
  /** Canvas boxes of rigid art regions (no hull fit there). */
  regionBoxes: number[][];
  /** Keep polygons of side regions: limb strokes under them are dropped (the region outline is the edge). */
  keeps: number[][][];
  /** The approved art the rest pose is painted from. */
  artPath: string | null;
  /** The leg slots (leg geometry findings). */
  legSlots: string[];
  /** Knee bend side: away from the body midline (front view) or toward the toes (turned side). */
  bend: "outward" | "toe";
  report: Record<string, unknown>;
}

/** The lowest silhouette points' mean x and row (the sole contact on the canvas). */
function soleOfSilhouette(silhouette: readonly unknown[]): [number, number] {
  const sil = (silhouette as any[]).map((q) => (Array.isArray(q) ? q : q.at)).filter((q) => Array.isArray(q)) as [number, number][];
  const low = Math.max(...sil.map((q) => q[1]));
  const lows = sil.filter((q) => q[1] > low - 0.75);
  return [lows.reduce((t, q) => t + q[0], 0) / lows.length, low];
}

/** Mirror mode (front view): the built leg half is reflected and merged into the upper body. */
function mirrorInputs(legDir: string, presetPath: string, bodyPath: string, bodyPresetPath: string): BodyInputs {
  const preset = loadPreset(resolve(presetPath));
  if (!preset.mirror) throw new Error("the leg preset declares no mirror rule");
  const leg = loadRig(legDir, preset.name);
  const m = mirrorRig(leg.raw, leg.textures, preset.mirror, {});
  const body = loadRig(dirname(resolve(bodyPath)), basename(bodyPath).replace(/\.anim\.json$/, ""));
  const bodyPreset = loadPreset(resolve(bodyPresetPath));
  const { doc, report: mergeReport } = mergeLegs(body.raw, m.doc);
  const mx = preset.mirror.x;
  const rename = preset.mirror.rename;
  const BR = (b: string) => rename.reduce((n, [a, z]) => n.replace(a, z), b);
  const sided = (bone: string) => rename.some(([a]) => bone.endsWith(a));
  const [soleX, low] = soleOfSilhouette(preset.skin.silhouette);
  const artRel = bodyPreset.regions[0]?.image;
  return {
    doc,
    textures: new Map([...body.textures, ...m.textures]),
    preset,
    bodyPreset,
    legPair: m.bones as Record<string, string>,
    armPair: Object.fromEntries(bodyPreset.chain.bones.map((b) => [b, BR(b)])),
    legSign: { l: 1, r: -1 },
    armSign: { l: 1, r: -1 },
    sole: { l: [soleX, low], r: [2 * mx - soleX, low] },
    mirrorX: mx,
    torso: { slot: bodyPreset.skin.slot, attachment: bodyPreset.skin.attachment },
    skinMeshes: [[bodyPreset.skin.slot, bodyPreset.skin.attachment], [preset.skin.slot, preset.skin.attachment]],
    regionBoxes: bodyPreset.regions.flatMap((r) => {
      const [x, y, w0, h0] = r.crop;
      return sided(r.bone) ? [[x, y, x + w0, y + h0], [2 * mx - x - w0, y, 2 * mx - x, y + h0]] : [[x, y, x + w0, y + h0]];
    }),
    keeps: bodyPreset.regions.filter((r) => r.keep && sided(r.bone)).flatMap((r) => [r.keep as number[][], (r.keep as number[][]).map(([x, y]) => [2 * mx - (x as number), y as number])]),
    artPath: artRel ? resolve(dirname(resolve(bodyPresetPath)), artRel) : null,
    legSlots: m.doc.slots.map((s: any) => s.name as string),
    bend: "outward",
    report: { merge: mergeReport, mirror: m.report }
  };
}

/** Rotation key sign of a partner chain: -1 when its root's limits are the reflection of side "l"'s. */
function partnerSign(lRoot: { limits?: [number, number] } | undefined, rRoot: { limits?: [number, number] } | undefined): number {
  const a = lRoot?.limits;
  const b = rRoot?.limits;
  return a && b && a[0] !== -a[1] && b[0] === -a[1] && b[1] === -a[0] ? -1 : 1;
}

/**
 * Full-body mode (turned side, phase 2b): the composed rig written by cli/fullBody.ts and its
 * parts. Side "l" = the near leg with the near arm, side "r" = their partners (far leg, far arm);
 * each side's names, signs, sole and regions come from its own part, never from a reflection.
 */
function fullInputs(bodyFile: string, composedDir: string): BodyInputs {
  const body = loadFullBody(resolve(bodyFile));
  const rig = loadRig(composedDir, body.spec.name);
  const doc = structuredClone(rig.raw);
  doc.name = `${body.spec.name}-legs`;
  doc.animations = {};
  const near = (kind: "arm" | "leg") => body.parts.find((p) => p.spec.kind === kind && p.spec.depth === "near");
  const partnerOf = (p: FullBodyPart) => body.parts.find((q) => q.spec.name === p.spec.partner || q.spec.partner === p.spec.name);
  const lLeg = near("leg");
  const lArm = near("arm");
  if (!lLeg || !lArm) throw new Error("full body: a near leg and a near arm are required");
  const rLeg = partnerOf(lLeg);
  const rArm = partnerOf(lArm);
  if (!rLeg || !rArm) throw new Error("full body: the near leg and the near arm need partners");
  const pairChains = (a: FullBodyPart, b: FullBodyPart) => {
    const out: Record<string, string> = {};
    a.preset.chain.bones.forEach((n, i) => { const o = b.preset.chain.bones[i]; if (o) out[n] = o; });
    if (a.preset.girdle && b.preset.girdle) out[a.preset.girdle.bone] = b.preset.girdle.bone;
    return out;
  };
  const rootOf = (p: FullBodyPart) => p.preset.bones.find((b) => b.name === p.preset.chain.bones[0]) as { limits?: [number, number] } | undefined;
  const sheet = lArm.preset.assembly?.sheets[0];
  if (!sheet) throw new Error("full body: the near arm carries no torso sheet");
  const legParts = body.parts.filter((p) => p.spec.kind === "leg");
  return {
    doc,
    textures: rig.textures,
    preset: lLeg.preset,
    bodyPreset: lArm.preset,
    legPair: pairChains(lLeg, rLeg),
    armPair: pairChains(lArm, rArm),
    legSign: { l: 1, r: partnerSign(rootOf(lLeg), rootOf(rLeg)) },
    armSign: { l: 1, r: partnerSign(rootOf(lArm), rootOf(rArm)) },
    sole: { l: soleOfSilhouette(lLeg.preset.skin.silhouette), r: soleOfSilhouette(rLeg.preset.skin.silhouette) },
    mirrorX: null,
    torso: { slot: sheet.slot, attachment: sheet.attachment },
    skinMeshes: [[sheet.slot, sheet.attachment], ...body.parts.map((p) => [p.preset.skin.slot, p.preset.skin.attachment] as [string, string])],
    regionBoxes: body.parts.flatMap((p) => p.preset.regions.map((r) => { const [x, y, w0, h0] = r.crop; return [x, y, x + w0, y + h0]; })),
    // the fist joins are made by cli/fullBody.ts (tools/extremityJoin.ts) before this step
    keeps: [],
    artPath: body.spec.art ? resolve(body.dir, body.spec.art) : null,
    legSlots: legParts.flatMap((p) => partSlots(p.preset)),
    bend: "toe",
    report: { compose: `${body.spec.name}: ${body.parts.map((p) => `${p.spec.name} (${p.spec.depth} ${p.spec.kind})`).join(", ")}` }
  };
}

async function main() {
  const full = process.argv.indexOf("--full");
  const wi = process.argv.indexOf("--walk");
  const noRender = process.argv.includes("--no-render");
  const walkParams: WalkParams | null = wi > 0 ? JSON.parse(readFileSync(resolve(process.argv[wi + 1] as string), "utf8")) : null;
  // `--full <body.json> <composed rig dir> <out dir>` (turned side), or the mirror mode's five paths first
  const args = process.argv.slice(2);
  const inp = full > 0 ? fullInputs(process.argv[full + 1] as string, process.argv[full + 2] as string) : mirrorInputs(args[0] as string, args[1] as string, args[2] as string, args[3] as string);
  const outDir = (full > 0 ? process.argv[full + 3] : args[4]) as string;
  await pipeline(inp, outDir, noRender, walkParams);
}

async function pipeline(inp: BodyInputs, outDir: string, noRender: boolean, walkParams: WalkParams | null) {
  const { doc, preset, bodyPreset, textures } = inp;
  const BASE = preset.base;
  const ROOT = doc.bones[0].name as string;
  const [THIGH, SHIN, FOOT] = preset.chain.bones as [string, string, string];
  const R = (b: string) => (inp.legPair[b] ?? b) as string;
  const side = (b: string, s: Side) => (s === "l" ? b : R(b));
  const [ARM, ELBOW] = bodyPreset.chain.bones as [string, string];
  const LEAN = bodyPreset.base;
  const BR = (b: string) => inp.armPair[b] ?? b;
  const skinKey = Object.keys(doc.skins)[0] as string;
  const HIPS = preset.skin.slot;

  // --- bare-body continuity: the torso flows into the hips ------------------------------------
  // The torso's bottom-edge stroke goes (the hips continue the body there); the hips get the
  // body-owned outline on every hull run the leg contours do not stroke (flanks through the hips
  // down to the hem junction; the crotch is the welded centre, no run there).
  // Full-body mode: the torso sheet carries the garment down to its hem (the shorts are painted on it) and the legs
  // keep their own outlines, so its bottom edge is the exposed hem over the legs and keeps its stroke.
  const torsoDropped = inp.mirrorX !== null ? dropBottomEdge(doc, inp.torso.slot, inp.torso.attachment) : 0;
  // mirror mode: one welded hips skin (the full-body legs keep their own part outlines)
  const hipContours = inp.mirrorX !== null ? deriveBodyContours(doc, skinKey, HIPS, preset.skin.attachment) : [];

  // --- leg shading as the art lights it (not mirrored) ------------------------------------------
  // The mirrored skin texture is a canvas projection; the far leg is repainted from the built leg
  // by a per-row translation (outer edge to outer edge), so both legs keep the art's light side.
  let repainted = 0;
  if (inp.mirrorX !== null) {
    const mx = inp.mirrorX;
    const hipsMesh = doc.skins[skinKey].attachments[HIPS][preset.skin.attachment];
    const tex = textures.get(hipsMesh.path) as RgbaImage;
    const sil = (preset.skin.silhouette as any[]).map((q) => (Array.isArray(q) ? q : q.at)).filter((q) => Array.isArray(q)) as [number, number][];
    const nx0 = mx - tex.width / 2;
    const hemY = Math.max(...((preset.garments[0]?.path ?? []) as any[]).map((q) => (Array.isArray(q) ? q[1] : q.at?.[1] ?? 0)));
    const yTop = Math.min(...sil.map((q) => q[1]));
    const toy = yTop - Math.min(...(hipsMesh.uvs as number[]).filter((_, i) => i % 2 === 1)) * hipsMesh.height;
    // the built leg's outer chain (top corner down to the sole) and inner chain (sole up to the crotch)
    const lowest = sil.reduce((bi, q, i) => (q[1] > (sil[bi] as [number, number])[1] ? i : bi), 0);
    const outerChain = sil.slice(1, lowest + 1);
    const innerChain = sil.slice(lowest).reverse();
    const xAt = (chain: [number, number][], y: number) => {
      for (let i = 1; i < chain.length; i++) {
        const [x0, y0] = chain[i - 1] as [number, number];
        const [x1, y1] = chain[i] as [number, number];
        if ((y - y0) * (y - y1) <= 0 && y1 !== y0) return x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
      }
      return Number.NaN;
    };
    {
      const copy = { width: tex.width, height: tex.height, data: new Uint8Array(tex.data) };
      for (let ty = 0; ty < tex.height; ty++) {
        const cy = toy + ty + 0.5;
        if (cy < hemY - 12) continue;
        const lo = xAt(outerChain, cy);
        const li = xAt(innerChain, cy);
        if (Number.isNaN(lo) || Number.isNaN(li)) continue;
        const shift = 2 * mx - lo - li;
        for (let tx = 0; tx < tex.width; tx++) {
          const cx = nx0 + tx + 0.5;
          if (cx <= mx + 0.5) continue;
          const sxp = Math.floor(cx - shift - nx0);
          if (sxp < 0 || sxp >= tex.width || cx - shift >= mx) continue;
          if (cx < 2 * mx - li - 6 || cx > 2 * mx - lo + 6) continue;
          const s = (ty * tex.width + sxp) * 4;
          copy.data.set(tex.data.subarray(s, s + 4), (ty * tex.width + tx) * 4);
          repainted++;
        }
      }
      textures.set(hipsMesh.path, copy);
    }
  }

  // --- runtime IK: targets outside the chain, feet keep their world angle -----------------------
  const segs = new Set([SHIN, R(SHIN)]);
  for (const b of doc.bones) if (segs.has(b.name)) b.inherit = "noScale";
  let sk = new Skeleton(loadAnimDocument(doc));
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const W = (bone: Bone, lx = 0, ly = 0): V => {
    const o = { x: 0, y: 0 };
    bone.localToWorld(lx, ly, o);
    return { x: o.x, y: o.y };
  };
  const target: Record<Side, string> = { l: `${FOOT}_target`, r: `${R(FOOT)}_target` };
  for (const s of SIDES) {
    const foot = sk.getBone(side(FOOT, s));
    const a = W(foot);
    // the foot inherits normally (it follows the shin in FK poses); clips key it flat (footFlat)
    const o = { x: 0, y: 0 };
    sk.getBone(ROOT).worldToLocal(a.x, a.y, o);
    doc.bones.push({ name: target[s], parent: ROOT, x: +o.x.toFixed(4), y: +o.y.toFixed(4) });
  }
  const before = SIDES.map((s) => sk.getBone(side(FOOT, s)).world);
  (doc.ik ??= []).push(...SIDES.map((s) => ({ name: `${side(FOOT, s)}_ik`, bones: [side(THIGH, s), side(SHIN, s)], target: target[s], bendPositive: true, softness: IK_SOFTNESS })));
  sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins(Object.keys(doc.skins));
  const B = (n: string): Bone => sk.getBone(n);
  // the setup pose must be unchanged by the inherit switch (the mesh binds rely on it)
  type Mix = number | Record<Side, number>;
  const mixFor = (mix: Mix, s: Side) => (typeof mix === "number" ? mix : mix[s]);
  const setIk = (mix: Mix) => { for (const c of (sk as any).ikConstraints ?? []) c.pose.mix = mixFor(mix, c.data.name === `${R(FOOT)}_ik` ? "r" : "l"); };
  const apply = (pose: Pose, ikMix: Mix = 0) => {
    sk.setToSetupPose();
    for (const [k, v] of Object.entries(pose)) {
      const mm = /^(.+)\.(scaleX|scaleY|x|y)$/.exec(k);
      if (mm) {
        const b = B(mm[1] as string);
        const f = mm[2] as "scaleX" | "scaleY" | "x" | "y";
        (b.pose as any)[f] = f === "x" || f === "y" ? (b.data as any)[f] + v : (b.data as any)[f] * v;
      } else B(k).pose.rotation = B(k).data.rotation + v;
    }
    setIk(ikMix);
    sk.updateWorldTransform("none");
  };
  apply({});
  const setupDrift = Math.max(...SIDES.map((s, i) => { const w = B(side(FOOT, s)).world; const b0 = before[i] as any; return Math.max(Math.abs(w.a - b0.a), Math.abs(w.b - b0.b), Math.abs(w.c - b0.c), Math.abs(w.d - b0.d)); }));
  if (setupDrift > 1e-6) throw new Error(`foot setup transform changed by the inherit switch (${setupDrift})`);
  // Bend side per leg: the knee goes outward (away from the midline) when the pelvis drops.
  {
    const mid = W(B(BASE)).x;
    const down = Math.sign(W(B(FOOT)).y - W(B(BASE)).y);
    // toe side of each foot (turned side): the foot bone's own direction
    const toe = (s: Side) => { const f = B(side(FOOT, s)); return Math.sign(W(f, f.data.length || 1, 0).x - W(f).x) || 1; };
    for (const s of SIDES) {
      const c = doc.ik.find((x: any) => x.name === `${side(FOOT, s)}_ik`);
      const out: number[] = [];
      for (const bend of [true, false]) {
        c.bendPositive = bend;
        const t = new Skeleton(loadAnimDocument(doc));
        t.setToSetupPose();
        t.getBone(BASE).pose.y += down * 12;
        t.updateWorldTransform("none");
        const k = { x: 0, y: 0 };
        t.getBone(side(SHIN, s)).localToWorld(0, 0, k);
        out.push(inp.bend === "outward" ? Math.abs(k.x - mid) : (k.x - mid) * toe(s));
      }
      c.bendPositive = (out[0] as number) >= (out[1] as number);
    }
    sk = new Skeleton(loadAnimDocument(doc));
    sk.setActiveSkins(Object.keys(doc.skins));
  }
  apply({});

  // Canvas -> world from preset bone origins (axis-aligned scale + offset).
  const at = (n: string) => (preset.bones.find((b) => b.name === n) as any).at as [number, number];
  const [cx0, cy0] = at(BASE);
  const wp = W(B(BASE));
  const sx = (W(B(THIGH)).x - wp.x) / (at(THIGH)[0] - cx0);
  const sy = (W(B(FOOT)).y - wp.y) / (at(FOOT)[1] - cy0);
  const toWorld = (x: number, y: number): V => ({ x: wp.x + (x - cx0) * sx, y: wp.y + (y - cy0) * sy });
  const up = Math.sign(-sy);
  const soleLocal: Record<Side, V> = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } };
  const soleToAnkle: Record<Side, V> = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } };
  for (const s of SIDES) {
    const sw = toWorld(inp.sole[s][0], inp.sole[s][1]);
    B(side(FOOT, s)).worldToLocal(sw.x, sw.y, soleLocal[s]);
    const a = W(B(side(FOOT, s)));
    soleToAnkle[s] = { x: a.x - sw.x, y: a.y - sw.y };
  }
  const soleOf = (s: Side): V => W(B(side(FOOT, s)), soleLocal[s].x, soleLocal[s].y);
  const rest: Record<Side, V> = { l: soleOf("l"), r: soleOf("r") };
  const footSetupRotW: Record<Side, number> = { l: B(side(FOOT, "l")).worldRotationX, r: B(side(FOOT, "r")).worldRotationX };
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const ground = rest.l.y;
  const L: Record<Side, number> = { l: 0, r: 0 };
  const Lseg: Record<Side, { l1: number; l2: number }> = { l: { l1: 0, l2: 0 }, r: { l1: 0, l2: 0 } };
  for (const s of SIDES) {
    const h = W(B(side(THIGH, s)));
    const k = W(B(side(SHIN, s)));
    const a = W(B(side(FOOT, s)));
    Lseg[s] = { l1: Math.hypot(k.x - h.x, k.y - h.y), l2: Math.hypot(a.x - k.x, a.y - k.y) };
    L[s] = Lseg[s].l1 + Lseg[s].l2;
  }
  const gpx = preset.gamePixels / preset.figureHeight / Math.abs(sy); // world px -> game px
  // IK softness: only the last IK_SOFT_SHARE of the rest chain reach (no pop near extension)
  for (const c of doc.ik) c.softness = +(IK_SOFT_SHARE * Math.min(L.l, L.r)).toFixed(4);
  // the setup pose is the art: IK is off in the setup data (mix 0); every clip keys its mix
  for (const c of doc.ik) c.mix = 0;
  sk = new Skeleton(loadAnimDocument(doc));
  sk.setActiveSkins(Object.keys(doc.skins));
  apply({});
  /** Keys each foot so its world angle stays the setup angle at this frame's solved pose (IK mix as keyed). */
  const footFlat = (pose: Pose, mix: Mix, tilt: Record<Side, number> = { l: 0, r: 0 }) => {
    for (const s of SIDES) {
      const fb = side(FOOT, s);
      for (let it = 0; it < 3; it++) {
        apply(pose, mix);
        const w0 = B(fb).worldRotationX;
        const err = wrap(footSetupRotW[s] + inp.legSign[s] * tilt[s] - w0);
        if (Math.abs(err) < 1e-4) break;
        const r0 = pose[fb] ?? 0;
        pose[fb] = r0 + 1;
        apply(pose, mix);
        const slope = wrap(B(fb).worldRotationX - w0) || 1;
        pose[fb] = wrap(r0 + err / slope);
        // keep the key inside the bone's limits (the runtime would clamp it anyway)
        const lim = (doc.bones.find((b: any) => b.name === fb) as any)?.limits;
        if (lim) pose[fb] = Math.min(lim.max, Math.max(lim.min, pose[fb] as number));
      }
    }
    apply(pose, mix);
  };

  // --- rest fidelity: every mesh texel visible at the setup pose comes from the source art -------
  // The skin and garment textures are canvas projections. Draw items are rasterised at the setup
  // pose in draw order (mesh groups in their slots, regions as rigid quads); the topmost item owns
  // each canvas pixel and takes the art there; texels hidden at rest (skin under the tank or the
  // shorts) keep the built material, so the bare body and motion still show completed skin.
  const artImg = inp.artPath ? readPng(inp.artPath) : null;
  const bakeReport: Record<string, number> = {};
  if (artImg) {
    apply({}, 0);
    Object.assign(bakeReport, paintFromArt({
      doc, textures, skinKey, skeleton: sk, art: artImg, sx, sy,
      toCanvas: (p: V): V => ({ x: cx0 + (p.x - wp.x) / sx, y: cy0 + (p.y - wp.y) / sy }),
      skinMeshes: inp.skinMeshes, regionBoxes: inp.regionBoxes, keeps: inp.keeps,
      farSuffix: inp.mirrorX !== null ? (preset.mirror?.rename[0]?.[1] ?? "_r") : null,
      joinReachScale: JOIN_REACH_SCALE
    }));
  }

  /**
   * Keys for a planted (or lifted) foot: the target bone at the ankle for the world contact
   * (re-derived in skeleton space from the posed root every frame) and the projected
   * foreshortening of the chain (front view: a knee coming toward the viewer shortens the leg on
   * screen). The scale puts the target exactly at the start of the IK softness zone, so the
   * runtime solve reaches it with a small, constant outward bend: never fully extended, no
   * lateral swing.
   */
  const footKeys = (pose: Pose, s: Side, contact: V) => {
    apply(pose, 0);
    const ank = { x: contact.x + soleToAnkle[s].x, y: contact.y + soleToAnkle[s].y };
    const o = { x: 0, y: 0 };
    B(ROOT).worldToLocal(ank.x, ank.y, o);
    const tb = B(target[s]);
    pose[`${target[s]}.x`] = o.x - tb.data.x;
    pose[`${target[s]}.y`] = o.y - tb.data.y;
    const hip = W(B(side(THIGH, s)));
    const d = Math.hypot(ank.x - hip.x, ank.y - hip.y);
    // the thigh carries the foreshortening (it turns toward the viewer as the knee lifts); the
    // shin keeps its length so the ankle blend never shears against the translation-only foot
    // hard IK: the chain is keyed so the target sits at exactly MAX_REACH of it (the thigh
    // foreshortens when the foot lifts and lengthens slightly in stance: never fully extended)
    const sc = (d / (MAX_REACH - 0.002) - Lseg[s].l2) / Lseg[s].l1; // a hair inside the cap
    pose[`${side(THIGH, s)}.scaleX`] = sc;
  };
  const arms = (swing: number, lean: number, breathe: number): Pose => ({
    // near the rest angle, small opposite swing (front view: forward/back reads as a small raise)
    [ARM]: 2 + swing, [BR(ARM)]: inp.armSign.r * (2 - swing), [ELBOW]: 6 + 0.5 * Math.max(0, swing), [BR(ELBOW)]: inp.armSign.r * (6 + 0.5 * Math.max(0, -swing)),
    [LEAN]: lean, [`${LEAN}.scaleX`]: 1 + 0.012 * breathe, [`${LEAN}.scaleY`]: 1 + 0.01 * breathe
  });
  // --- stance policy (preset ik.stance): foreshorten = straight planted leg, IK only in swing ---
  const stanceMode = preset.ik?.stance ?? "bend";
  const BLEND = preset.ik?.blend ?? 0.2;
  const rigFor = (mix: Mix): StanceRig => ({ pose: (k) => apply(k as Pose, mix), world: (b, lx = 0, ly = 0) => W(B(b), lx, ly), rotation: (b) => B(b).worldRotationX });
  const stanceResidual = { max: 0 };
  /** A planted foot by policy; returns the IK mix for that leg (0 = straight foreshortened FK). */
  const plantKeys = (pose: Pose, s: Side, contact: V): number => {
    footKeys(pose, s, contact);
    if (stanceMode !== "foreshorten") return 1;
    const fs = pose[`${side(FOOT, s)}.scaleX`] ?? 1;
    const ank = { x: contact.x + soleToAnkle[s].x * fs, y: contact.y + soleToAnkle[s].y * fs };
    const res = solveStraightStance(rigFor(0), pose, side(THIGH, s), side(SHIN, s), B(side(SHIN, s)).data.length, ank);
    stanceResidual.max = Math.max(stanceResidual.max, res);
    return 0;
  };
  /** A lifted foot: IK keys (target, reach scale) blended over the swing with the straight solution. */
  const swingKeys = (pose: Pose, s: Side, contact: V, u: number): number => {
    footKeys(pose, s, contact);
    if (stanceMode !== "foreshorten") return 1;
    const scIk = pose[`${side(THIGH, s)}.scaleX`] as number;
    const ank = { x: contact.x + soleToAnkle[s].x, y: contact.y + soleToAnkle[s].y };
    solveStraightStance(rigFor(0), pose, side(THIGH, s), side(SHIN, s), B(side(SHIN, s)).data.length, ank);
    const m = swingIkMix(u, BLEND);
    const scFk = pose[`${side(THIGH, s)}.scaleX`] as number;
    pose[`${side(THIGH, s)}.scaleX`] = scFk + (scIk - scFk) * m;
    return m;
  };
  const ease = (u: number) => (1 - Math.cos(2 * Math.PI * Math.min(1, Math.max(0, u)))) / 2;

  type Frame = { pose: Pose; ik: Mix; stance: Record<Side, V | null> };
  const clips: Record<string, { frames: Frame[]; loop: boolean }> = {};
  const lift = WALK_LIFT * Math.abs(sy);
  {
    // walk in place, 1 s: each foot swings 0.4 s with a raised-cosine lift; arms swing opposite.
    const frames: Frame[] = [];
    for (let i = 0; i < 30; i++) {
      const t = i / 30;
      const u = { l: t < 0.4 ? t / 0.4 : -1, r: t >= 0.5 && t < 0.9 ? (t - 0.5) / 0.4 : -1 } as Record<Side, number>;
      const pose: Pose = {};
      // bob: low at each foot strike (t 0.4, 0.9), high mid-swing
      pose[`${BASE}.y`] = -up * Math.abs(sy) * WALK_BOB * (0.5 + 0.5 * Math.cos(4 * Math.PI * (t - 0.4)));
      pose[`${BASE}.x`] = sx * 3 * Math.sin(2 * Math.PI * (t - 0.45));
      const legPhase = Math.cos(2 * Math.PI * (t - 0.2)); // +1 left leg up, -1 right leg up
      Object.assign(pose, arms(-4 * legPhase, 1.5 * legPhase, 0.5 + 0.5 * Math.sin(2 * Math.PI * t)));
      const stance = { l: null, r: null } as Record<Side, V | null>;
      const mix = { l: 0, r: 0 } as Record<Side, number>;
      for (const s of SIDES) {
        const uu = u[s] as number;
        if (uu >= 0) mix[s] = swingKeys(pose, s, { x: rest[s].x, y: rest[s].y + up * lift * ease(uu) }, uu);
        else { mix[s] = plantKeys(pose, s, rest[s]); stance[s] = rest[s]; }
      }
      footFlat(pose, mix);
      frames.push({ pose: { ...pose }, ik: mix, stance });
    }
    clips[walkParams ? "walk_v1" : "walk_in_place"] = { frames, loop: true };
  }
  const templateWalk = (wp: WalkParams): Frame[] => {
    // template walk (fixtures/clips/*.json, tools/walkCycle.ts): game px -> canvas px -> world
    const gs = preset.gamePixels / preset.figureHeight;
    const above = bodyPreset.chain.branches?.find((b) => b.bones.includes(LEAN))?.bones ?? [];
    const HEADB = above[above.length - 1];
    const HAND = bodyPreset.chain.bones[2];
    const frames: Frame[] = [];
    for (const wf of walkFrames(wp)) {
      const pose: Pose = {};
      pose[`${BASE}.x`] = sx * (wf.pelvis.x / gs);
      // the bob only ever lowers the pelvis (the straight planted leg never stretches past rest)
      pose[`${BASE}.y`] = -up * Math.abs(sy) * ((wf.pelvis.y + wp.bob / 2) / gs);
      pose[LEAN] = wf.torso;
      pose[`${LEAN}.scaleX`] = 1.004;
      pose[`${LEAN}.scaleY`] = 1.003;
      if (HEADB && HEADB !== LEAN) pose[HEADB] = wf.head;
      pose[ARM] = wf.arm.l.raise;
      pose[BR(ARM)] = inp.armSign.r * wf.arm.r.raise;
      pose[ELBOW] = wf.arm.l.elbow;
      pose[BR(ELBOW)] = inp.armSign.r * wf.arm.r.elbow;
      if (HAND) { pose[HAND] = wf.arm.l.hand; pose[BR(HAND)] = inp.armSign.r * wf.arm.r.hand; }
      const stance = { l: null, r: null } as Record<Side, V | null>;
      const mix = { l: 0, r: 0 } as Record<Side, number>;
      for (const s of SIDES) {
        const f = wf.foot[s];
        // depth stride: near = bigger and lower on screen, far = smaller and higher (eased phase)
        const sd = 1 + (wp.depthScale ?? 0) * f.depth;
        const drop = (wp.depthDrop ?? 0) * f.depth;
        pose[`${side(THIGH, s)}.scaleY`] = sd;
        pose[`${side(SHIN, s)}.scaleY`] = sd;
        pose[`${side(FOOT, s)}.scaleX`] = sd;
        // the lifted foot rises by foreshortening the straight leg toward the viewer (no knee bow)
        const contact = { x: rest[s].x, y: rest[s].y + up * Math.abs(sy) * ((f.lift - drop) / gs) };
        mix[s] = plantKeys(pose, s, contact);
        if (f.swingU === null) stance[s] = contact;
      }
      footFlat(pose, mix, { l: wf.foot.l.tilt, r: wf.foot.r.tilt });
      frames.push({ pose: { ...pose }, ik: mix, stance });
    }
    return frames;
  };
  if (walkParams) {
    clips.walk_flat = { frames: templateWalk({ ...walkParams, depthScale: 0, depthDrop: 0 }), loop: true };
    clips.walk_in_place = { frames: templateWalk(walkParams), loop: true };
    const k10 = 0.1 / Math.max(1e-9, walkParams.depthScale ?? 0.06);
    clips.walk_depth10 = { frames: templateWalk({ ...walkParams, depthScale: 0.1, depthDrop: (walkParams.depthDrop ?? 0) * k10 }), loop: true };
  }
  {
    // idle with weight shift, 3.2 s: pelvis over each foot, chest counter-lean, breathing.
    const frames: Frame[] = [];
    for (let i = 0; i < 96; i++) {
      const t = i / 96;
      const w = Math.sin(2 * Math.PI * t);
      const pose: Pose = { [`${BASE}.x`]: 7 * sx * w, [`${BASE}.y`]: -up * Math.abs(sy) * 2 * Math.abs(w), ...arms(1.5 * w, -2 * w, 0.5 - 0.5 * Math.cos(4 * Math.PI * t)) };
      const mix = { l: plantKeys(pose, "l", rest.l), r: plantKeys(pose, "r", rest.r) };
      footFlat(pose, mix);
      frames.push({ pose: { ...pose }, ik: mix, stance: { l: rest.l, r: rest.r } });
    }
    clips.idle_weight_shift = { frames, loop: true };
  }
  {
    // FK -> IK -> FK with the root moving: FK legs (hip out, knee in) 0..0.4 s, mix up 0.4..0.7,
    // planted IK 0.7..1.1, mix down 1.1..1.4, FK to 1.7 s.
    const frames: Frame[] = [];
    for (let i = 0; i <= 51; i++) {
      const t = i / FPS;
      const pose: Pose = { [`${ROOT}.x`]: 8 * sx * Math.min(1, t / 1.7), [`${BASE}.y`]: -up * Math.abs(sy) * 4 };
      Object.assign(pose, { [THIGH]: 6, [SHIN]: -10, [R(THIGH)]: inp.legSign.r * 6, [R(SHIN)]: -inp.legSign.r * 10 });
      const ramp = (a: number, b: number) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
      const mix = t < 1.1 ? ramp(0.4, 0.7) : 1 - ramp(1.1, 1.4);
      // the plant is held in world space while the root moves: targets re-derived per frame
      for (const s of SIDES) footKeys(pose, s, rest[s]);
      footFlat(pose, mix);
      frames.push({ pose, ik: mix, stance: mix >= 1 ? { l: rest.l, r: rest.r } : { l: null, r: null } });
    }
    clips.fk_ik_fk = { frames, loop: false };
  }
  if (inp.mirrorX === null) {
    // Full-body (turned side) only: the side's own arm_raise and knee_bend, inside each bone's side limits.
    const limitOf = (n: string) => (doc.bones.find((b: any) => b.name === n) as any)?.limits as { min: number; max: number } | undefined;
    const lerpKeys = (keys: [number, number][], t: number) => {
      for (let i = 1; i < keys.length; i++) {
        const [t1, v1] = keys[i] as [number, number];
        const [t0, v0] = keys[i - 1] as [number, number];
        if (t <= t1) { const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1; return v0 + (v1 - v0) * (u * u * (3 - 2 * u)); }
      }
      return (keys[keys.length - 1] as [number, number])[1];
    };
    {
      // arm_raise on the shared timing spec (garmentImport armRaiseClip: 4.8 s; rest, raise, raise with the elbow bent,
      // back; the elbow is undone before the arm is back below 45 deg). Each arm's raise is scaled into its own root
      // limit (side: near arm -70..105, far arm -35..40), the elbow bend into the elbow's (0..70: toward the toes only).
      const RAISE = 100, BEND_RAISE = 58, BEND = 68;
      const frames: Frame[] = [];
      const armKeys = (arm: string, sign: number) => {
        const lim = limitOf(arm);
        const room = lim ? (sign > 0 ? lim.max : -lim.min) : RAISE;
        const k = Math.min(1, room / RAISE);
        return [[0, 0], [0.4, 0], [1.4, RAISE * k], [1.8, RAISE * k], [2.6, BEND_RAISE * k], [3.0, BEND_RAISE * k], [3.6, 30 * k], [4.4, 0], [4.8, 0]] as [number, number][];
      };
      const elKeys = (elbow: string) => {
        const lim = limitOf(elbow);
        const b = Math.min(BEND, lim ? lim.max : BEND);
        return [[0, 0], [1.8, 0], [2.6, b], [3.0, b], [3.6, Math.min(30, b)], [4.0, 0], [4.8, 0]] as [number, number][];
      };
      const tracks: [string, [number, number][], number][] = [
        [ARM, armKeys(ARM, 1), 1], [BR(ARM), armKeys(BR(ARM), inp.armSign.r), inp.armSign.r],
        [ELBOW, elKeys(ELBOW), 1], [BR(ELBOW), elKeys(BR(ELBOW)), inp.armSign.r]
      ];
      for (let i = 0; i < 4.8 * FPS; i++) {
        const t = i / FPS;
        const pose: Pose = {};
        for (const [bone, keys, sign] of tracks) pose[bone] = sign * lerpKeys(keys, t);
        frames.push({ pose, ik: 0, stance: { l: rest.l, r: rest.r } });
      }
      clips.arm_raise = { frames, loop: true };
    }
    {
      // knee_bend, 3.2 s: the near leg then the far leg bends at the knee (FK, IK off; the other foot stays planted):
      // the thigh swings toward the toes to its limit, the shin folds back to its limit, the foot is keyed flat.
      apply({});
      const toeDir = (s: Side) => { const f = B(side(FOOT, s)); return Math.sign(W(f, f.data.length || 1, 0).x - W(f).x) || 1; };
      const pick = (bone: string, probe: () => number) => {
        // the limit whose direction makes probe() (a signed screen x) largest
        const lim = limitOf(bone) ?? { min: -10, max: 10 };
        const val = (v: number) => { apply({ [bone]: v }); return probe(); };
        return val(lim.max) >= val(lim.min) ? lim.max : lim.min;
      };
      // directions probed on the near leg (its foot bone gives the toe side); the partner takes them with its key sign
      const thigh = pick(THIGH, () => toeDir("l") * W(B(SHIN)).x);
      const shin = pick(SHIN, () => -toeDir("l") * W(B(FOOT)).x);
      const legPeak: Record<Side, Pose> = { l: { [THIGH]: thigh, [SHIN]: shin }, r: { [R(THIGH)]: inp.legSign.r * thigh, [R(SHIN)]: inp.legSign.r * shin } };
      apply({});
      const env = (t: number, t0: number) => lerpKeys([[t0, 0], [t0 + 0.5, 1], [t0 + 0.9, 1], [t0 + 1.4, 0]], Math.max(t0, t));
      const frames: Frame[] = [];
      for (let i = 0; i < 3.2 * FPS; i++) {
        const t = i / FPS;
        const pose: Pose = {};
        const w = { l: env(t, 0.1), r: env(t, 1.7) } as Record<Side, number>;
        for (const s of SIDES) for (const [k, v] of Object.entries(legPeak[s])) pose[k] = (v as number) * w[s];
        footFlat(pose, 0);
        frames.push({ pose: { ...pose }, ik: 0, stance: { l: w.l > 0 ? null : rest.l, r: w.r > 0 ? null : rest.r } });
      }
      clips.knee_bend = { frames, loop: true };
    }
  }
  // (unreachable targets are rejected, not softened: the validator and live limits flag any
  // two-bone target past MAX_IK_REACH; no clip here goes past it.)

  // --- write the clips -------------------------------------------------------------------------
  for (const [name, c] of Object.entries(clips)) {
    const keys = new Set(c.frames.flatMap((f) => Object.keys(f.pose)));
    const bones: Record<string, any> = {};
    const t = (i: number) => +(i / FPS).toFixed(5);
    for (const k of keys) {
      const mm = /^(.+)\.(scaleX|scaleY|x|y)$/.exec(k);
      const bone = mm ? (mm[1] as string) : k;
      const e = (bones[bone] ??= {});
      if (!mm) e.rotate = c.frames.map((f, i) => ({ time: t(i), value: +(f.pose[k] ?? 0).toFixed(4) }));
      else if (mm[2] === "x" || mm[2] === "y") e.translate ??= c.frames.map((f, i) => ({ time: t(i), x: +(f.pose[`${bone}.x`] ?? 0).toFixed(4), y: +(f.pose[`${bone}.y`] ?? 0).toFixed(4) }));
      else e.scale ??= c.frames.map((f, i) => ({ time: t(i), x: +(f.pose[`${bone}.scaleX`] ?? 1).toFixed(5), y: +(f.pose[`${bone}.scaleY`] ?? 1).toFixed(5) }));
    }
    const ik: Record<string, any[]> = {};
    for (const s of SIDES) ik[`${side(FOOT, s)}_ik`] = c.frames.map((f, i) => ({ time: t(i), mix: +mixFor(f.ik, s).toFixed(5) }));
    const duration = c.loop ? c.frames.length / FPS : (c.frames.length - 1) / FPS;
    if (c.loop) {
      for (const e of Object.values(bones)) for (const tl of Object.values(e as Record<string, any[]>)) tl.push({ ...tl[0], time: +duration.toFixed(5) });
      for (const tl of Object.values(ik)) tl.push({ ...tl[0], time: +duration.toFixed(5) });
    }
    doc.animations[name] = { duration: +duration.toFixed(5), loop: c.loop, fps: FPS, bones, ik };
  }

  // --- live measurement: the runtime plays each clip (IK constraints solve every frame) ---------
  const live = loadAnimDocument(doc);
  const data = new AnimationStateData(live);
  const lsk = new Skeleton(live);
  const LB = (n: string) => lsk.getBone(n);
  const LW = (b: Bone, x = 0, y = 0): V => { const o = { x: 0, y: 0 }; b.localToWorld(x, y, o); return { x: o.x, y: o.y }; };
  const metrics: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(clips)) {
    let drift = 0;
    let pen = 0;
    let step = 0;
    let kneeOut = 0;
    let kneeStep = 0;
    let minBend = Infinity;
    let prev: Record<Side, V> | null = null;
    let prevBend: Record<Side, number> | null = null;
    for (let i = 0; i < c.frames.length; i++) {
      lsk.setToSetupPose();
      const st = new AnimationState(data);
      st.setAnimation(0, name, { loop: false });
      st.update(i / FPS);
      st.apply(lsk);
      lsk.updateWorldTransform("reset");
      const f = c.frames[i] as Frame;
      const now = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } } as Record<Side, V>;
      const bend = { l: 0, r: 0 } as Record<Side, number>;
      for (const s of SIDES) {
        const p = LW(LB(side(FOOT, s)), soleLocal[s].x, soleLocal[s].y);
        now[s] = p;
        pen = Math.max(pen, (p.y - ground) * -up);
        const stp = f.stance[s];
        if (stp) drift = Math.max(drift, Math.hypot(p.x - stp.x, p.y - stp.y));
        const h = LW(LB(side(THIGH, s)));
        const k = LW(LB(side(SHIN, s)));
        const a = LW(LB(side(FOOT, s)));
        // lateral knee offset from the hip-ankle line (screen), and the knee's bend angle
        const lx = a.x - h.x;
        const ly = a.y - h.y;
        const len = Math.hypot(lx, ly);
        kneeOut = Math.max(kneeOut, Math.abs(((k.x - h.x) * ly - (k.y - h.y) * lx) / len));
        bend[s] = Math.abs(((Math.atan2(a.y - k.y, a.x - k.x) - Math.atan2(k.y - h.y, k.x - h.x)) * 180) / Math.PI);
        minBend = Math.min(minBend, bend[s]);
        if (prev) step = Math.max(step, Math.hypot(p.x - prev[s].x, p.y - prev[s].y));
        if (prevBend) kneeStep = Math.max(kneeStep, Math.abs(bend[s] - prevBend[s]));
      }
      prev = now;
      prevBend = bend;
    }
    metrics[name] = {
      frames: c.frames.length, stanceSoleDriftGamePx: +(drift * gpx).toFixed(4), penetrationGamePx: +(Math.max(0, pen) * gpx).toFixed(4),
      maxSoleStepGamePxPerFrame: +(step * gpx).toFixed(4), maxKneeOffLineGamePx: +(kneeOut * gpx).toFixed(3), minKneeBendDeg: +minBend.toFixed(2), maxKneeBendStepDegPerFrame: +kneeStep.toFixed(3)
    };
  }
  const lim: Record<string, [number, number]> = {};
  for (const b of preset.bones) if ((b as any).limits) {
    const [lo, hi] = (b as any).limits as [number, number];
    lim[b.name] = [lo, hi];
    lim[R(b.name)] = inp.legSign.r < 0 ? [-hi, -lo] : [lo, hi];
  }
  metrics.stancePolicy = { mode: stanceMode, blend: BLEND, maxSolveResidualGamePx: +(stanceResidual.max * gpx).toExponential(2) };
  metrics.walkLiftGamePx = +(lift * gpx).toFixed(3);
  metrics.walkBobGamePx = +(WALK_BOB * Math.abs(sy) * gpx).toFixed(3);

  // --- write ---------------------------------------------------------------------------------
  // chain joints the later slot's skin can paint over move along the chain (elbow crease)
  bakeReport.chainHandover = handOverChainJoints(doc, skinKey) as unknown as number;
  // art ink hidden at rest (under strokes, regions, the torso) is skin, not specks in a bend
  bakeReport.hiddenInkRepainted = repaintHiddenInk(doc, textures, skinKey) as unknown as number;
  mkdirSync(join(outDir, "rig"), { recursive: true });
  const rigName = `${doc.name}`;
  const docPath = join(outDir, "rig", `${rigName}.anim.json`);
  writeFileSync(docPath, `${JSON.stringify(doc)}\n`);
  writeAtlas(textures, join(outDir, "rig"), rigName);
  const bare = bareDoc(doc);
  const barePath = join(outDir, "rig", `${rigName}.bare.anim.json`);
  writeFileSync(barePath, `${JSON.stringify(bare)}\n`);

  // --- combined gate: arms + stride + lean + breathing through the unified validator ------------
  const combined: Record<string, unknown> = {};
  for (const [variant, d] of [["dressed", doc], ["bare", bare]] as const) {
    const v = validateRig(d, { textures, tears: true });
    const byCheck: Record<string, number> = {};
    for (const i of v.issues) if (i.severity === "error") byCheck[i.check] = (byCheck[i.check] ?? 0) + 1;
    const legSlots = new Set(inp.legSlots);
    const legFindings = v.geometry.findings.filter((f) => f.severity === "error" && [...legSlots].some((s) => f.mesh.startsWith(`${s}/`)));
    // tank hem: garment triangles within 66 canvas px of the hem (bind, from the canvas-projected uvs)
    let hemWorst = 0;
    const garmentSlot = doc.slots.find((s: any) => Object.values(doc.skins[skinKey].attachments[s.name] ?? {}).some((a: any) => a.embed && !legSlots.has(s.name)))?.name;
    const gm = garmentSlot ? (Object.values(doc.skins[skinKey].attachments[garmentSlot]) as any[])[0] : null;
    if (gm) {
      const vy = (i: number) => (gm.uvs[i * 2 + 1] as number) * gm.height;
      const ymax = Math.max(...Array.from({ length: gm.uvs.length / 2 }, (_, i) => vy(i)));
      const hemTris = new Set<number>();
      for (let t = 0; t < gm.triangles.length / 3; t++) {
        const cyy = (vy(gm.triangles[t * 3]) + vy(gm.triangles[t * 3 + 1]) + vy(gm.triangles[t * 3 + 2])) / 3;
        if (cyy > ymax - 66) hemTris.add(t);
      }
      for (const f of v.geometry.findings) {
        const mm = /^stretch\/[^/]+\/[^/]+\/t(\d+)$/.exec(f.id);
        if (mm && f.mesh.startsWith(`${garmentSlot}/`) && hemTris.has(Number(mm[1]))) hemWorst = Math.max(hemWorst, f.value);
      }
    }
    combined[variant] = { errors: Object.values(byCheck).reduce((a, b) => a + b, 0), byCheck, legGeometryErrors: legFindings.length, legWorst: legFindings.slice(0, 3).map((f) => `${f.id} ${f.value.toFixed(3)} @ ${f.pose}`), tankHemWorstStretchFinding: +hemWorst.toFixed(3) };
  }
  metrics.combined = combined;
  const report = { merge: inp.report.merge ?? inp.report.compose, artBake: bakeReport, mirror: inp.report.mirror, torsoBottomPointsDropped: torsoDropped, hipContours: hipContours.map((c) => c.ref), repaintedTexels: repainted, ik: doc.ik, canvasToWorld: { sx, sy }, metrics };
  writeFileSync(join(outDir, `${rigName}.report.json`), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ torsoDropped, hipContours: hipContours.length, repainted, ik: doc.ik.map((c: any) => [c.name, c.bendPositive]), metrics }, null, 1)}\n`);
  if (noRender) return;

  // --- renders -------------------------------------------------------------------------------------
  const gameScale = preset.gamePixels / preset.figureHeight;
  const atlasPath = join(outDir, "rig", `${rigName}.atlas.json`);
  const crop = (img: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage => {
    const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let y = 0; y < h; y++) out.data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return out;
  };
  const nearest = (img: RgbaImage, k: number): RgbaImage => {
    const out = { width: img.width * k, height: img.height * k, data: new Uint8Array(img.width * k * img.height * k * 4) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(img.data.subarray((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4 + 4), (y * out.width + x) * 4);
    return out;
  };
  const cw = doc.canvas.width;
  const ch = doc.canvas.height;
  const [bx0, by0, bw, bh] = [cw * 0.23, ch * 0.097, cw * 0.543, ch * 0.787];
  const cropAt = (k: number) => (img: RgbaImage) => crop(img, Math.floor(bx0 * gameScale * k), Math.floor(by0 * gameScale * k), Math.ceil(bw * gameScale * k), Math.ceil(bh * gameScale * k));
  // the source art at the same crop, for the rest comparison
    const scaleDown = (img: RgbaImage, k: number): RgbaImage => {
    const w = Math.round(img.width * k);
    const h = Math.round(img.height * k);
    const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y / k); yy < Math.min(img.height, Math.floor((y + 1) / k)); yy++) for (let xx = Math.floor(x / k); xx < Math.min(img.width, Math.floor((x + 1) / k)); xx++) {
        const s = (yy * img.width + xx) * 4;
        const a = (img.data[s + 3] as number) / 255;
        for (let c = 0; c < 3; c++) acc[c] = (acc[c] as number) + (img.data[s + c] as number) * a + 0x2b * (1 - a);
        n++;
      }
      for (let c = 0; c < 3; c++) out.data[(y * w + x) * 4 + c] = Math.round((acc[c] as number) / Math.max(1, n));
      out.data[(y * w + x) * 4 + 3] = 255;
    }
    return out;
  };
  for (const [variant, path] of [["dressed", docPath], ["bare", barePath]] as const) {
    const r1 = await renderFrames({ document: path, atlas: atlasPath, clip: null, scale: gameScale, background: 0x2b2b2b });
    const r3 = await renderFrames({ document: path, atlas: atlasPath, clip: null, scale: gameScale * 3, background: 0x2b2b2b });
    const tiles = [
      { image: nearest(cropAt(1)(decodePng(r1.frames[0]?.png as Buffer)), 3), label: `${variant} rest game x3 nearest` },
      { image: cropAt(3)(decodePng(r3.frames[0]?.png as Buffer)), label: `${variant} rest dpr3` }
    ];
    if (artImg) {
      tiles.push({ image: nearest(cropAt(1)(scaleDown(artImg, gameScale)), 3), label: "source art game x3 nearest" });
      tiles.push({ image: cropAt(3)(scaleDown(artImg, gameScale * 3)), label: "source art 3x" });
    }
    writePng(join(outDir, `${variant}-rest.png`), grid(tiles, 4, 2));
    const trio = ["walk_flat", "walk_in_place", "walk_depth10"].filter((x) => clips[x]);
    if (trio.length === 3) {
      for (const [tag, k] of [["game", 1], ["3x", 3]] as const) {
        const n = 56;
        const rs: RenderResult[] = [];
        for (const name of trio) rs.push(await renderFrames({ document: path, atlas: atlasPath, clip: name, fps: FPS, frames: n, scale: gameScale * k, background: 0x2b2b2b }));
        const frames = (rs[0] as RenderResult).frames.map((f0, i) => {
          const parts = rs.map((r) => cropAt(k)(decodePng((r.frames[i] as { png: Buffer }).png)));
          const pw = (parts[0] as RgbaImage).width;
          const ph = (parts[0] as RgbaImage).height;
          const gap = 4 * k;
          const img = { width: pw * 3 + gap * 2, height: ph, data: new Uint8Array((pw * 3 + gap * 2) * ph * 4).fill(255) };
          parts.forEach((pt, j) => { for (let y = 0; y < ph; y++) img.data.set(pt.data.subarray(y * pw * 4, (y + 1) * pw * 4), (y * img.width + j * (pw + gap)) * 4); });
          return { time: f0.time, png: encodePng(img) };
        });
        writeGif({ ...(rs[0] as RenderResult), frames }, join(outDir, `${variant}-walk-flat-depth6-depth10-${tag}-30fps.gif`));
      }
    }
    for (const name of ["walk_in_place", "walk_flat", "walk_depth10", "idle_weight_shift", "fk_ik_fk", "arm_raise", "knee_bend"].filter((x) => clips[x])) {
      const res = await renderFrames({ document: path, atlas: atlasPath, clip: name, fps: FPS, scale: gameScale, background: 0x2b2b2b });
      const res3 = await renderFrames({ document: path, atlas: atlasPath, clip: name, fps: FPS, scale: gameScale * 3, background: 0x2b2b2b });
      const f1 = res.frames.map((f) => decodePng(f.png));
      const f3 = res3.frames.map((f) => decodePng(f.png));
      const idx = Array.from({ length: 8 }, (_, i) => Math.round((i * (f1.length - 1)) / 7));
      writePng(join(outDir, `${variant}-${name}-game-sheet.png`), grid(idx.map((i) => ({ image: cropAt(1)(f1[i] as RgbaImage), label: `${name} ${res.frames[i]?.time.toFixed(2)}s game` })), 8, 1));
      writePng(join(outDir, `${variant}-${name}-game-x3nearest-sheet.png`), grid(idx.map((i) => ({ image: nearest(cropAt(1)(f1[i] as RgbaImage), 3), label: `${name} ${res.frames[i]?.time.toFixed(2)}s game x3n` })), 4, 2));
      writePng(join(outDir, `${variant}-${name}-3x-sheet.png`), grid(idx.map((i) => ({ image: cropAt(3)(f3[i] as RgbaImage), label: `${name} ${res3.frames[i]?.time.toFixed(2)}s dpr3` })), 4, 2));
      writeGif(res, join(outDir, `${variant}-${name}-game-30fps.gif`));
      writeGif(res3, join(outDir, `${variant}-${name}-3x-30fps.gif`));
      process.stdout.write(`rendered ${variant} ${name} (${f1.length} frames)\n`);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
