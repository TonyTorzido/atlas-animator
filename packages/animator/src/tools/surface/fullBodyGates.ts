/*
 * Atlas Animator: original implementation.
 *
 * Arm-layer gates on a composed full body (phase 2b milestone 2), never mirrored: every near arm
 * part runs the arm-layer gate set of tools/surface/armLayerGates.ts against the torso sheet it
 * draws over, posed one arm at a time in the part's own sign convention (its own limits); every far
 * arm part runs the under-join gate (its root, hidden under the torso at rest, stays hidden) and the
 * sheet and geometry gates; with a near and a far arm, the crossed-arms gate checks the near arm
 * draws wholly over the far one. All bones, slots and contours come from the presets.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadAnimDocument } from "../../core/formatLoader.js";
import type { AnimDocument } from "../../core/format.js";
import type { RgbaImage } from "../image.js";
import { insideLimits, type PoseLimit } from "./limits.js";
import type { DistortionAllowance } from "../validateGeometry.js";
import { applyPose, capCoverageGate, closureGate, crossedArmsGate, depthIn, edgeContinuityGate, geometryGate, inkGate, lineEndGate, openEndGate, poseSkeleton, sheetGate, torsoOutlineGate, wristGate, type ArmLayerPose, type Connection, type GateResult } from "./armLayerGates.js";
import type { SurfacePreset } from "./preset.js";
import type { FullBodyPartSpec } from "./fullBody.js";
import { softRender } from "../softRender.js";

type Pt = [number, number];

export interface GatePart {
  spec: FullBodyPartSpec;
  preset: SurfacePreset;
  /** Resolved build and clip limits of the part (buildRig). */
  limits: readonly PoseLimit[];
  allowanceOf: (key: string, t: number) => DistortionAllowance;
  gameScale: number;
}

function meshWorld(doc: AnimDocument, sk: ReturnType<typeof poseSkeleton>, key: string): { pts: Pt[]; hull: number } {
  const [slotName, att] = key.split("/") as [string, string];
  const slot = sk.getSlot(slotName);
  const mesh = sk.getAttachment(slot, att) as any;
  if (!mesh || mesh.type !== "mesh") throw new Error(`full body: no mesh '${key}'`);
  const w = sk.meshWorldVertices(mesh, slot.bone);
  const pts: Pt[] = [];
  for (let i = 0; i < w.length / 2; i++) pts.push([(w[i * 2] as number) + doc.canvas.originX, (w[i * 2 + 1] as number) + doc.canvas.originY]);
  return { pts, hull: mesh.geometry.hull as number };
}

/**
 * Under-join gate (a far arm drawn under the torso): the far sheet's vertices buried in the torso
 * sheet at the setup pose by >= `clearance` px stay inside the posed torso hull by >= `clearance`
 * at every pose. With `root` (far parts, phase 2b), only the ROOT vertices are held: those buried
 * at setup within `root.radius` px of the root joint (the shoulder), so the cut root never shows;
 * the rest of the far limb may swing out from behind the torso, and what it reveals is gated by
 * paintedRevealGate (painted material only). Without `root`, every buried vertex is held.
 */
export function underJoinGate(doc: AnimDocument, arm: string, under: string, poses: readonly ArmLayerPose[], clearance: number, root?: { bone: string; radius: number }): GateResult {
  const sk = poseSkeleton(doc);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const u0 = meshWorld(doc, sk, under);
  const a0 = meshWorld(doc, sk, arm);
  const hull0 = u0.pts.slice(0, u0.hull);
  const rb = root ? sk.findBone(root.bone) : null;
  if (root && !rb) throw new Error(`under join: no root bone '${root.bone}'`);
  const rootAt: Pt | null = rb ? [rb.world.x + doc.canvas.originX, rb.world.y + doc.canvas.originY] : null;
  const nearRoot = (p: Pt) => !rootAt || !root || Math.hypot(p[0] - rootAt[0], p[1] - rootAt[1]) <= root.radius;
  const ids = a0.pts.flatMap((p, i) => (depthIn(p, hull0) >= clearance && nearRoot(p) ? [i] : []));
  let worst = Infinity;
  let at = "";
  let measured = 0;
  for (const pose of poses) {
    applyPose(sk, pose);
    const u = meshWorld(doc, sk, under);
    const a = meshWorld(doc, sk, arm);
    const hull = u.pts.slice(0, u.hull);
    for (const i of ids) {
      const d = depthIn(a.pts[i] as Pt, hull);
      measured++;
      if (d < worst) {
        worst = d;
        at = `${pose.name} ${arm} v${i}`;
      }
    }
  }
  return { gate: `under join: ${arm} hidden root stays under ${under}`, ok: ids.length > 0 && measured > 0 && worst >= clearance, measured, detail: `${ids.length} vertices buried at setup${root ? ` within ${root.radius} px of ${root.bone}` : ""}, ${poses.length} poses; min depth inside ${under} ${Number.isFinite(worst) ? worst.toFixed(2) : "n/a"} px (${at}; need >= ${clearance})` };
}

/** Damage applied to a far part's skin texture by the painted-reveal gate's controls. */
export type RevealDamage = "holes" | "flat" | "foreign";

/**
 * Painted-reveal gate (far parts, phase 2b): wherever the far part's skin material is the top
 * surface in any pose (its texture made solid for the render, so a hole counts as its own), the
 * texel there is painted material: opaque (no hole), inside the part's own palette (the quantised
 * colours of its texels visible at the setup pose, +-1 bin; no other part's colour) and not inside
 * a flat fill block (a FLAT x FLAT texel window of one exact colour; the painted art has none).
 * Pixels within EDGE px of the part's visible footprint edge are anti-aliasing and skipped.
 * Three damaged controls (punched holes, one flat colour, another part's texture copied in) must
 * each be caught on the setup pose and one swing pose, or the gate fails.
 */
export function paintedRevealGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, part: string, sheetSlot: string, slots: readonly string[], foreignPath: string, poses: readonly ArmLayerPose[]): GateResult {
  const FLAT = 6;
  const EDGE = 3;
  const Q = 4; // quantisation shift: 16 bins per channel
  const fillDoc = loadAnimDocument({ ...(doc as any), skins: Object.fromEntries(Object.entries(doc.skins as Record<string, any>).map(([k, s]) => [k, { ...s, contours: {}, contourContacts: undefined }])) });
  const sk = poseSkeleton(fillDoc);
  const skinAtt = Object.values((doc.skins as any)[Object.keys(doc.skins)[0] as string].attachments[sheetSlot] ?? {}).find((a: any) => a.type === "mesh") as any;
  if (!skinAtt) throw new Error(`painted reveal: no mesh on '${sheetSlot}'`);
  const path = skinAtt.path as string;
  const real = textures.get(path) as RgbaImage;
  // only slots that draw the part's skin texture: the top texel index is read in that texture (a
  // rigid region on the part, such as the fist, is the art's own crop in its own texture)
  const skinAtts = (doc.skins as any)[Object.keys(doc.skins)[0] as string].attachments as Record<string, Record<string, { path?: string }>>;
  const drawsSkin = (n: string) => Object.values(skinAtts[n] ?? {}).some((a) => a.path === path);
  const slotIdx = new Set(slots.filter(drawsSkin).map((n) => (fillDoc.slots as any[]).findIndex((x) => x.name === n) + 1).filter((i) => i > 0));
  const { width: W, height: H, originX: ox, originY: oy } = doc.canvas;
  const flatMask = (t: RgbaImage): Uint8Array => {
    const m = new Uint8Array(t.width * t.height);
    const key = (i: number) => ((t.data[i * 4] as number) << 16) | ((t.data[i * 4 + 1] as number) << 8) | (t.data[i * 4 + 2] as number);
    for (let y = 0; y + FLAT <= t.height; y++) for (let x = 0; x + FLAT <= t.width; x++) {
      const k0 = key(y * t.width + x);
      let flat = true;
      for (let dy = 0; dy < FLAT && flat; dy++) for (let dx = 0; dx < FLAT; dx++) {
        const i = (y + dy) * t.width + x + dx;
        if ((t.data[i * 4 + 3] as number) < 250 || key(i) !== k0) { flat = false; break; }
      }
      if (flat) for (let dy = 0; dy < FLAT; dy++) for (let dx = 0; dx < FLAT; dx++) m[(y + dy) * t.width + x + dx] = 1;
    }
    return m;
  };
  /** Texels of `path` that are the top surface (solid render), off the footprint edge, for a pose. */
  const visibleTexels = (pose: ArmLayerPose): Set<number> => {
    applyPose(sk, pose);
    const solid = { width: real.width, height: real.height, data: new Uint8Array(real.data) };
    for (let i = 0; i < real.width * real.height; i++) solid.data[i * 4 + 3] = 255;
    const tex = new Map(textures);
    tex.set(path, solid);
    const r = softRender(sk, tex, { width: W, height: H, left: -ox, top: -oy, ids: true });
    const top = r.topSlot as Int16Array;
    const tx = r.topTexel as Int32Array;
    const own = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) own[i] = slotIdx.has(top[i] as number) && (tx[i] as number) >= 0 ? 1 : 0;
    const out = new Set<number>();
    for (let y = EDGE; y < H - EDGE; y++) for (let x = EDGE; x < W - EDGE; x++) {
      const i = y * W + x;
      if (!own[i]) continue;
      let inner = true;
      for (let dy = -EDGE; dy <= EDGE && inner; dy++) for (let dx = -EDGE; dx <= EDGE; dx++) if (!own[i + dy * W + dx]) { inner = false; break; }
      if (inner) out.add(tx[i] as number);
    }
    return out;
  };
  const restPose = one("setup", {});
  const restTexels = visibleTexels(restPose);
  const bin = (t: RgbaImage, i: number) => [(t.data[i * 4] as number) >> Q, (t.data[i * 4 + 1] as number) >> Q, (t.data[i * 4 + 2] as number) >> Q] as const;
  const palette = new Set<number>();
  for (const i of restTexels) {
    if ((real.data[i * 4 + 3] as number) < 250) continue;
    const [r, g, b] = bin(real, i);
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) palette.add(((r + dr + 1) << 12) | ((g + dg + 1) << 6) | (b + db + 1));
  }
  const inPalette = (t: RgbaImage, i: number) => { const [r, g, b] = bin(t, i); return palette.has(((r + 1) << 12) | ((g + 1) << 6) | (b + 1)); };
  const cache = new Map<string, Set<number>>();
  const check = (t: RgbaImage, list: readonly ArmLayerPose[]) => {
    const flat = flatMask(t);
    let holes = 0, foreign = 0, flats = 0, texels = 0;
    let first = "";
    for (const pose of list) {
      let vis = cache.get(pose.name);
      if (!vis) cache.set(pose.name, (vis = visibleTexels(pose)));
      for (const i of vis) {
        texels++;
        const bad = (t.data[i * 4 + 3] as number) < 250 ? "hole" : flat[i] ? "flat" : inPalette(t, i) ? "" : "foreign";
        if (!bad) continue;
        if (bad === "hole") holes++;
        else if (bad === "flat") flats++;
        else foreign++;
        if (!first) first = `${pose.name} texel (${i % t.width}, ${Math.floor(i / t.width)}) ${bad}`;
      }
    }
    return { holes, foreign, flats, texels, first };
  };
  const res = check(real, poses);
  // damaged controls: the same check on a broken copy of the texture must fail
  const foreignTex = textures.get(foreignPath);
  const hist = new Map<number, number>();
  for (const i of restTexels) { const k = ((real.data[i * 4] as number) << 16) | ((real.data[i * 4 + 1] as number) << 8) | (real.data[i * 4 + 2] as number); hist.set(k, (hist.get(k) ?? 0) + 1); }
  const most = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const damage = (kind: RevealDamage): RgbaImage => {
    const d = { width: real.width, height: real.height, data: new Uint8Array(real.data) };
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      const o = (y * d.width + x) * 4;
      if ((real.data[o + 3] as number) === 0) continue;
      if (kind === "holes" && x % 24 < 8 && y % 24 < 8) d.data[o + 3] = 0;
      if (kind === "flat") d.data.set([(most >> 16) & 255, (most >> 8) & 255, most & 255], o);
      if (kind === "foreign" && foreignTex) {
        const fo = ((y % foreignTex.height) * foreignTex.width + (x % foreignTex.width)) * 4;
        if ((foreignTex.data[fo + 3] as number) >= 250) d.data.set(foreignTex.data.subarray(fo, fo + 3), o);
      }
    }
    return d;
  };
  const controlPoses = [restPose, poses[poses.length - 1] ?? restPose];
  const controls = (["holes", "flat", "foreign"] as RevealDamage[]).map((kind) => {
    const c = check(damage(kind), controlPoses);
    return { kind, caught: kind === "holes" ? c.holes : kind === "flat" ? c.flats : c.foreign };
  });
  const controlsFail = controls.every((c) => c.caught > 0);
  const ok = res.texels > 0 && res.holes + res.foreign + res.flats === 0 && controlsFail;
  return { gate: `painted reveal: ${part} material shown in any pose is painted (no holes, own palette, no flat fill)`, ok, measured: res.texels, detail: `${poses.length} poses, ${res.texels} visible texel-poses of ${path}; holes ${res.holes}, foreign colour ${res.foreign}, flat fill ${res.flats}${res.first ? ` (first: ${res.first})` : ""}; damaged controls caught: ${controls.map((c) => `${c.kind} ${c.caught}`).join(", ")}${controlsFail ? "" : " (a control was NOT caught)"}` };
}

const one = (name: string, rotate: Record<string, number>, extra: Record<string, number> = {}): ArmLayerPose => ({ name, rotate: { ...extra, ...rotate } });

/**
 * A clip frame for the gates (`frames` option): the pose is the clip applied at its time; `offsets` are the frame's
 * sampled local rotations from setup (degrees, per bone), which place it in a gate's pose class (normal, across) and
 * check it against the limits.
 */
export interface FramePose extends ArmLayerPose {
  clip: { name: string; time: number };
  offsets: Record<string, number>;
}

/** Clip frames inside every bone limit and pose limit of a part (the `required poses` gate on clip frames). */
export function framesInsideLimits(part: GatePart, frames: readonly FramePose[]): GateResult {
  const out: string[] = [];
  for (const f of frames) {
    for (const b of part.preset.bones) {
      const v = f.offsets[b.name] ?? 0;
      if (b.limits && (v < b.limits[0] - 1e-6 || v > b.limits[1] + 1e-6)) out.push(`${f.name}: ${b.name} ${v.toFixed(3)} outside [${b.limits.join(", ")}]`);
    }
    if (!insideLimits(part.limits, f.offsets)) out.push(`${f.name}: outside the pose limits`);
  }
  return { gate: `${part.spec.name}: clip frames inside every limit (not projected)`, ok: out.length === 0 && frames.length > 0, measured: frames.length, detail: out.length ? out.slice(0, 12).join("; ") : `${frames.length} frames` };
}

/** Required acceptance poses of a part (assembly.poses): inside the bone and pose limits, never projected. */
export function requiredPoses(part: GatePart): GateResult {
  const out: string[] = [];
  for (const { name, pose } of part.preset.assembly?.poses ?? []) {
    for (const [b, v] of Object.entries(pose)) {
      const lim = part.preset.bones.find((x) => x.name === b)?.limits;
      if (lim && (v < lim[0] - 1e-9 || v > lim[1] + 1e-9)) out.push(`${name}: ${b} ${v} outside [${lim.join(", ")}]`);
    }
    if (!insideLimits(part.limits, pose)) out.push(`${name}: outside the pose limits`);
  }
  const n = part.preset.assembly?.poses.length ?? 0;
  return { gate: `${part.spec.name}: required poses inside every limit (not projected)`, ok: out.length === 0 && n > 0, measured: n, detail: out.length ? out.join("; ") : `${n} poses` };
}

/** The arm-layer gate set for one near arm over the torso sheet, posed one arm at a time. */
/**
 * With `frames` (clip frames, e.g. a held-item attack), every gate runs on all those frames instead of its swept
 * poses, except the two scoped to a pose class (cap coverage: normal raises -15..15; edge continuity: across poses),
 * which run on their swept class poses PLUS the clip frames inside the class (never on fewer poses than the rig's
 * own gate); the required-poses gate becomes clip frames inside every limit. `fistSlots`: extra slots that are part of the holding fist (a held item's fist copy, drawn
 * with the item on the fist's own vertices and contours), joined to the hand in the wrist gate as heldImport does.
 */
export function nearArmGates(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, part: GatePart, far: GatePart | null, farSlots: readonly string[], nearSlots: readonly string[], frames?: readonly FramePose[], fistSlots: readonly string[] = []): GateResult[] {
  const p = part.preset;
  const asm = p.assembly;
  if (!asm) throw new Error(`${part.spec.name}: no assembly`);
  const [root, elbow, hand] = p.chain.bones as [string, string, string];
  const girdle = p.girdle?.bone;
  const lean = p.base;
  const armSheet = `${p.skin.slot}/${p.skin.attachment}`;
  const sheetDef = asm.sheets[0] as { slot: string; attachment: string };
  const underKey = `${sheetDef.slot}/${sheetDef.attachment}`;
  const all = part.limits;
  const rootLim = p.bones.find((b) => b.name === root)?.limits ?? [0, 0];
  const elbowLim = p.bones.find((b) => b.name === elbow)?.limits ?? [0, 0];
  const elbows = [...new Set([elbowLim[0], elbowLim[0] / 2, 0, elbowLim[1] / 2, elbowLim[1]].map((v) => Math.round(v * 2) / 2))].sort((x, y) => x - y);
  const shrugs = girdle ? [-6, 0, 6] : [0];
  const pose = (a: number, e: number | null, g: number): Record<string, number> => ({ [root]: a, ...(e === null ? {} : { [elbow]: e }), ...(girdle ? { [girdle]: g } : {}) });
  const geo: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) for (const e of elbows) for (const g of shrugs) if (insideLimits(all, pose(a, e, g))) geo.push(one(`raise ${a} elbow ${e} shrug ${g}`, pose(a, e, g)));
  for (const a of [rootLim[0], 0, rootLim[1]]) for (const l of [-10, 10]) geo.push(one(`raise ${a} lean ${l}`, { [root]: a }, { [lean]: l }));
  for (const q of asm.poses) geo.push(one(q.name, q.pose));
  const shoulder: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) for (const g of shrugs) shoulder.push(one(`raise ${a} shrug ${g}`, pose(a, null, g)));
  for (const q of asm.poses) shoulder.push(one(q.name, q.pose));
  const normal: ArmLayerPose[] = [];
  for (const a of [-15, -10, -5, 0, 5, 10, 15]) for (const e of [0, elbowLim[1] / 2, elbowLim[1]]) for (const g of shrugs) for (const l of [-10, 0, 10]) if (insideLimits(all, pose(a, e, g))) normal.push(one(`normal raise ${a} elbow ${e} shrug ${g} lean ${l}`, pose(a, e, g), { [lean]: l }));
  const ink: ArmLayerPose[] = [...shoulder];
  const folds: ArmLayerPose[] = [];
  for (const e of [-15, -30, -60, -80, -85]) for (const a of [-20, 0, 15, 45]) if (insideLimits(all, { [root]: a, [elbow]: e })) folds.push(one(`raise ${a} fold ${e}`, { [root]: a, [elbow]: e }));
  ink.push(...folds);
  const across: ArmLayerPose[] = [];
  const acrossSign = Math.sign(rootLim[0]) || -1;
  for (let a = 20 * acrossSign; Math.abs(a) <= Math.abs(rootLim[0]) + 1e-9; a += 5 * acrossSign) for (const g of shrugs) for (const l of [-10, 0, 10]) across.push(one(`across ${a} shrug ${g} lean ${l}`, pose(a, null, g), { [lean]: l }));
  const conn: Connection[] = asm.connections.map((c) => {
    const sheet = asm.sheets.find((s) => s.name === c.under);
    if (!sheet) throw new Error(`connection '${c.name}': no sheet '${c.under}'`);
    return { closure: c.closure, arm: armSheet, under: `${sheet.slot}/${sheet.attachment}`, pivot: root, clearance: c.clearance };
  });
  const fillDoc = loadAnimDocument({ ...(doc as any), skins: Object.fromEntries(Object.entries(doc.skins as Record<string, any>).map(([k, s]) => [k, { ...s, contours: {}, contourContacts: undefined }])) });
  const fore = p.skin.groups[1]?.slot as string;
  const handSlot = p.regions.find((r) => r.bone === hand)?.slot as string;
  const rootOff = (q: ArmLayerPose) => (q as Partial<FramePose>).offsets?.[root] ?? q.rotate[root] ?? 0;
  const isAcross = (q: ArmLayerPose) => Math.sign(rootOff(q)) === acrossSign && Math.abs(rootOff(q)) >= 20;
  const edges = [
    { name: `${p.skin.slot} outer`, contours: [`${p.skin.slot}/outline_front`, `${p.skin.slot}/outline`, `${p.skin.slot}/cap_front`, `${fore}/outline`, `${fore}/outline_f1`, `${handSlot}/outline`], under: underKey, skip: handSlot, across: isAcross },
    { name: `${p.skin.slot} inner`, contours: [`${p.skin.slot}/underside_front`, `${p.skin.slot}/underside`, `${p.skin.slot}/cap_front`, `${fore}/outline`, `${fore}/outline_f1`, `${handSlot}/outline`], under: underKey, skip: handSlot, across: isAcross }
  ];
  const skin = [parseInt(p.skin.base.slice(0, 2), 16), parseInt(p.skin.base.slice(2, 4), 16), parseInt(p.skin.base.slice(4, 6), 16)] as const;
  const named = (name: string, r: GateResult): GateResult => ({ ...r, gate: `${part.spec.name}: ${r.gate}` });
  const walk = one("walk", { [root]: rootLim[1] > 0 ? 10 : -10, [elbow]: 8 });
  if (frames) {
    const fs = [...frames];
    const fr: GateResult[] = [
      framesInsideLimits(part, fs),
      named("sheets", sheetGate(doc, [underKey, armSheet])),
      named("geometry", geometryGate(doc, [underKey, armSheet], fs, part.allowanceOf, part.gameScale)),
      named("closure", closureGate(doc, fillDoc, textures, conn, fs)),
      named("cap", capCoverageGate(doc, conn, [...normal, ...fs.filter((q) => Math.abs(rootOff(q)) <= 15)], 45, 2)),
      named("ink", inkGate(doc, conn, [`${p.skin.slot}/underside_front`, `${p.skin.slot}/outline_front`], fs, [`${p.skin.slot}/outline`, `${p.skin.slot}/underside`])),
      named("edges", edgeContinuityGate(doc, textures, edges, [...across, ...fs.filter(isAcross)])),
      named("wrist", wristGate(doc, textures, [{ slots: [p.skin.slot, fore, handSlot, ...fistSlots], hand: handSlot }], fs, 45, skin)),
      named("line ends", lineEndGate(doc, textures, [root, elbow], fs)),
      named("open ends", openEndGate(doc, [elbow], fs)),
      named("torso outline", torsoOutlineGate(doc, textures, sheetDef.slot, underKey, Object.keys((doc.skins as any).body?.contours?.[sheetDef.slot] ?? {}).map((n) => `${sheetDef.slot}/${n}`), fs))
    ];
    if (far && farSlots.length) fr.push(named("crossed", crossedArmsGate(doc, textures, nearSlots, farSlots, fs, [0, 0, doc.canvas.width, doc.canvas.height])));
    return fr;
  }
  const out: GateResult[] = [
    requiredPoses(part),
    named("sheets", sheetGate(doc, [underKey, armSheet])),
    named("geometry", geometryGate(doc, [underKey, armSheet], geo, part.allowanceOf, part.gameScale)),
    named("closure", closureGate(doc, fillDoc, textures, conn, shoulder)),
    named("cap", capCoverageGate(doc, conn, normal, 45, 2)),
    named("ink", inkGate(doc, conn, [`${p.skin.slot}/underside_front`, `${p.skin.slot}/outline_front`], ink, [`${p.skin.slot}/outline`, `${p.skin.slot}/underside`])),
    named("edges", edgeContinuityGate(doc, textures, edges, across)),
    named("wrist", wristGate(doc, textures, [{ slots: [p.skin.slot, fore, handSlot], hand: handSlot }], [0, 20, 40, 60, 70].map((a) => one(`across ${a * acrossSign}`, { [root]: a * acrossSign })).filter((q) => insideLimits(all, q.rotate)), 45, skin)),
    named("line ends", lineEndGate(doc, textures, [root, elbow], [...shoulder, walk, ...folds])),
    named("open ends", openEndGate(doc, [elbow], [...folds, one("rest", {}), walk])),
    named("torso outline", torsoOutlineGate(doc, textures, sheetDef.slot, underKey, Object.keys((doc.skins as any).body?.contours?.[sheetDef.slot] ?? {}).map((n) => `${sheetDef.slot}/${n}`), [...across.filter((q) => / shrug 0 lean 0$/.test(q.name)), ...asm.poses.map((q) => one(q.name, q.pose))]))
  ];
  if (far && farSlots.length) {
    const [fr] = far.preset.chain.bones as [string];
    const fLim = far.preset.bones.find((b) => b.name === fr)?.limits ?? [0, 0];
    const poses: ArmLayerPose[] = [];
    for (const a of [rootLim[0], rootLim[0] / 2, 0, rootLim[1] / 2]) for (const b of [fLim[0], 0, fLim[1]]) poses.push(one(`near ${a} far ${b}`, { [root]: a, [fr]: b }));
    out.push(named("crossed", crossedArmsGate(doc, textures, nearSlots, farSlots, poses, [0, 0, doc.canvas.width, doc.canvas.height])));
  }
  return out;
}

/** Gates of a far arm drawn under the torso sheet. */
export function farArmGates(doc: AnimDocument, part: GatePart, underKey: string, clearance: number, frames?: readonly FramePose[]): GateResult[] {
  const p = part.preset;
  const [root, elbow] = p.chain.bones as [string, string];
  const girdle = p.girdle?.bone;
  const armSheet = `${p.skin.slot}/${p.skin.attachment}`;
  const rootLim = p.bones.find((b) => b.name === root)?.limits ?? [0, 0];
  const elbowLim = p.bones.find((b) => b.name === elbow)?.limits ?? [0, 0];
  const poses: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) for (const e of [elbowLim[0], 0, elbowLim[1]]) for (const g of girdle ? [-6, 0, 6] : [0]) {
    const q = { [root]: a, [elbow]: e, ...(girdle ? { [girdle]: g } : {}) };
    if (insideLimits(part.limits, q)) poses.push(one(`raise ${a} elbow ${e} shrug ${g}`, q));
  }
  for (const l of [-10, 10]) poses.push(one(`lean ${l}`, {}, { [p.base]: l }));
  if (frames) poses.splice(0, poses.length, ...frames);
  const named = (r: GateResult): GateResult => ({ ...r, gate: `${part.spec.name}: ${r.gate}` });
  // the root is the shoulder: the vertices within the girdle's inner radius of the upper arm's joint
  const rootRadius = p.girdle?.r0 ?? p.skin.topology.halfWidth;
  return [...(frames ? [framesInsideLimits(part, frames)] : []), named(sheetGate(doc, [armSheet])), named(geometryGate(doc, [armSheet], poses, part.allowanceOf, part.gameScale)), named(underJoinGate(doc, armSheet, underKey, poses, clearance, { bone: root, radius: rootRadius }))];
}

/**
 * Painted-reveal gates of every far part (arms and legs) on the PAINTED rig (after the paint bake):
 * the far arm swept over its root and elbow limits (girdle shrug held at 0), the far leg over its
 * thigh and shin limits. `underKey` is the torso sheet (its texture is the damaged control's foreign colour).
 */
export function farRevealGates(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, parts: readonly { spec: FullBodyPartSpec; preset: SurfacePreset; slots: readonly string[] }[], underKey: string, frames?: readonly FramePose[]): GateResult[] {
  const underTex = (doc.skins as any)[Object.keys(doc.skins)[0] as string].attachments[underKey.split("/")[0] as string]?.[underKey.split("/")[1] as string]?.path as string;
  const out: GateResult[] = [];
  for (const { spec, preset: p, slots } of parts.filter((x) => x.spec.depth === "far")) {
    const [a, b] = p.chain.bones as [string, string];
    const la = p.bones.find((x) => x.name === a)?.limits ?? [0, 0];
    const lb = p.bones.find((x) => x.name === b)?.limits ?? [0, 0];
    const poses: ArmLayerPose[] = [];
    const steps = spec.kind === "arm" ? 10 : 5;
    for (let i = 0; i <= steps; i++) for (const k of [lb[0], (lb[0] + lb[1]) / 2, lb[1]]) {
      const v = la[0] + ((la[1] - la[0]) * i) / steps;
      poses.push(one(`${a} ${v.toFixed(1)} ${b} ${k}`, { [a]: v, [b]: k }));
    }
    if (frames) poses.splice(0, poses.length, ...frames);
    const r = paintedRevealGate(doc, textures, spec.name, p.skin.slot, slots, underTex, poses);
    out.push({ ...r, gate: `${spec.name}: ${r.gate}` });
  }
  return out;
}
