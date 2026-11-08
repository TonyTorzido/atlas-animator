/*
 * Atlas Animator: original implementation.
 *
 * Arm layer, milestones 1-3:
 * `tsx src/cli/armLayer.ts <preset.json> <out dir> [--evidence <dir>] [--current <upper rig dir>]`
 * builds the layered half body (surface builder: the arm skin plus the torso sheet), checks the
 * frozen required poses (inside every build and clip limit, mirrored), mirrors it (the torso welds,
 * each arm is a detached sheet reflected whole), runs the arm-layer gates on the whole upper body
 * (tools/surface/armLayerGates.ts) and writes `<name>.gates.json`; with --evidence renders the bare
 * body at 0.4 and 4x (rest, walk, raise, flex; beside the current single-sheet body with
 * --current), the across-body poses of both arms and the shoulder seam at 4x. Exit 1 on a failed gate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import type { AnimDocument } from "../core/format.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { loadPreset, type SurfacePreset } from "../tools/surface/preset.js";
import { buildRig, writeAtlas, writeRig } from "../tools/surface/output.js";
import { validationCompanion } from "../tools/surface/validationCompanion.js";
import { insideLimits, type PoseLimit } from "../tools/surface/limits.js";
import { mirrorRig } from "../tools/mirrorRig.js";
import { opaqueOutline } from "../tools/bodyContours.js";
import { joinExtremities } from "../tools/extremityJoin.js";
import { readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas } from "../tools/validate.js";
import { softRender } from "../tools/softRender.js";
import { grid } from "../tools/review.js";
import type { RgbaImage } from "../tools/image.js";
import { DEFAULT_ALLOWANCE, type DistortionAllowance } from "../tools/validateGeometry.js";
import { applyPose, capCoverageGate, lineEndGate, openEndGate, closureGate, crossedArmsGate, edgeContinuityGate, torsoOutlineGate, wristGate, geometryGate, inkGate, paintGate, poseSkeleton, sheetGate, type ArmLayerPose, type Connection, type GateResult } from "../tools/surface/armLayerGates.js";

const BG: [number, number, number] = [30, 36, 48];

/** Milestone 1 check: every required pose (and its mirror) inside every build and clip limit, unprojected. */
export function requiredPoseProblems(preset: SurfacePreset, limits: readonly PoseLimit[], mirroredLimits: readonly PoseLimit[], rename: (b: string) => string): string[] {
  const out: string[] = [];
  for (const { name, pose } of preset.assembly?.poses ?? []) {
    for (const [b, v] of Object.entries(pose)) {
      const lim = preset.bones.find((x) => x.name === b)?.limits;
      if (lim && (v < lim[0] - 1e-9 || v > lim[1] + 1e-9)) out.push(`${name}: ${b} ${v} outside the bone limits [${lim.join(", ")}]`);
    }
    if (!insideLimits(limits, pose)) out.push(`${name}: outside the pose limits (${limits.filter((l) => !insideLimits([l], pose)).map((l) => l.name).join(", ")})`);
    const far = Object.fromEntries(Object.entries(pose).map(([b, v]) => [rename(b), rename(b) === b ? v : -v]));
    if (!insideLimits(mirroredLimits, far)) out.push(`${name} (mirrored): outside the mirrored pose limits`);
  }
  return out;
}

function both(name: string, rotate: Record<string, number>, mirrorOf: (b: string) => string, extra: Record<string, number> = {}): ArmLayerPose {
  const r: Record<string, number> = { ...extra };
  for (const [b, v] of Object.entries(rotate)) {
    r[b] = v;
    const m = mirrorOf(b);
    if (m !== b) r[m] = -v;
  }
  return { name, rotate: r };
}

async function main() {
  const [presetPath, outDir] = process.argv.slice(2) as [string, string];
  const flag = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const evidence = flag("--evidence");
  const current = flag("--current");
  const preset = loadPreset(resolve(presetPath));
  if (!preset.assembly || !preset.mirror) throw new Error("the preset declares no assembly or no mirror rule");
  const presetDir = dirname(resolve(presetPath));
  const failures: string[] = [];

  // --- half body ------------------------------------------------------------------------------
  const rig = buildRig(preset, presetDir);
  const halfDir = join(outDir, "half");
  writeRig(rig, halfDir);
  const order = preset.assembly.order;
  const drawn = rig.built.drawOrder.filter((s) => order.includes(s));
  if (drawn.join(",") !== order.join(",")) failures.push(`assembly order ${order.join(" < ")} differs from drawOrder ${drawn.join(" < ")}`);

  // --- whole upper body -----------------------------------------------------------------------
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(join(halfDir, `${preset.name}.atlas.json`), "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(halfDir, p.file))] as [string, RgbaImage]));
  const centre: Record<string, any> = {};
  const asym = new Set(preset.mirror.asymmetric ?? []);
  for (const r of preset.regions) centre[r.texture] = { image: readPng(resolve(presetDir, r.image)), crop: r.crop, keep: r.keep, asymmetric: asym.has(r.name) };
  const m = mirrorRig(rig.raw as Record<string, any>, texturesFromAtlas(pack, pages), preset.mirror, centre);
  // Rigid regions (fists, head) trim strokes only under their opaque art (as mirrorBody does).
  for (const sk of Object.values(m.doc.skins as Record<string, any>)) for (const bySlot of Object.values((sk.attachments ?? {}) as Record<string, Record<string, any>>)) for (const att of Object.values(bySlot)) {
    if (att.type !== "region" || att.opaque) continue;
    const img = m.textures.get(att.path);
    const outline = img ? opaqueOutline(img) : null;
    if (outline) att.opaque = outline;
  }
  // Fist joins (the full-body assembler's rigid-extremity construction, on the arm-layer sheets):
  // forearm strokes split under the fist, a runtime fist outline joined to both, the art cut to it.
  if (!process.argv.includes("--no-extremity")) {
    const extremities = preset.regions.filter((r) => r.keep && preset.mirror?.rename.some(([a]) => r.bone.endsWith(a))).flatMap((r) => [
      { slot: r.slot, keep: r.keep as number[][] },
      { slot: (m.slots[r.slot] ?? r.slot) as string, keep: (r.keep as number[][]).map(([x, y]) => [2 * (preset.mirror?.x as number) - (x as number), y as number]) }
    ]);
    m.report.push(...joinExtremities(m.doc, m.textures, extremities).map((l) => `extremity ${l}`));
  }
  // Arm-vs-arm order (assembly.frontArm): the front arm's whole assembly draws after the back arm's.
  const nearArm = (m.doc.slots as any[]).filter((s) => m.slots[s.name] && m.slots[s.name] !== s.name).map((s) => s.name as string);
  const farArm = nearArm.map((n) => m.slots[n] as string);
  if (preset.assembly.frontArm === "near") {
    const slotsList = m.doc.slots as any[];
    const moved = slotsList.filter((s) => nearArm.includes(s.name));
    const rest = slotsList.filter((s) => !nearArm.includes(s.name));
    const after = Math.max(...farArm.map((n) => rest.findIndex((s) => s.name === n)));
    m.doc.slots = [...rest.slice(0, after + 1), ...moved, ...rest.slice(after + 1)];
  }
  const [frontSlots, backSlots] = preset.assembly.frontArm === "near" ? [nearArm, farArm] : [farArm, nearArm];
  const upperDir = join(outDir, "upper");
  mkdirSync(upperDir, { recursive: true });
  const name = `${preset.name}-body`;
  writeFileSync(join(upperDir, `${name}.anim.json`), `${JSON.stringify(m.doc)}\n`);
  writeAtlas(m.textures, upperDir, name);
  writeFileSync(join(upperDir, `${name}.mirror.json`), `${JSON.stringify({ report: m.report, meshes: m.meshes }, null, 2)}\n`);
  const doc = loadAnimDocument(m.doc);
  const fillDoc = loadAnimDocument({ ...m.doc, skins: Object.fromEntries(Object.entries(m.doc.skins as Record<string, any>).map(([k, s]) => [k, { ...s, contours: {}, contourContacts: undefined }])) });
  const mirrorOf = (b: string) => m.bones[b] ?? b;
  const mirroredLimits: PoseLimit[] = (m.doc.poseLimits ?? []).map((l: any) => ({ ...l }));
  const problems = requiredPoseProblems(preset, [...rig.limits, ...rig.clipLimits], mirroredLimits, mirrorOf);
  const required: GateResult = { gate: "required poses: present, inside every limit, mirrored (not projected)", ok: problems.length === 0 && preset.assembly.poses.length > 0, measured: preset.assembly.poses.length, detail: problems.length ? problems.join("; ") : `${preset.assembly.poses.length} poses: ${preset.assembly.poses.map((p) => p.name).join(", ")}` };

  // --- gates ----------------------------------------------------------------------------------
  const armSheet = `${preset.skin.slot}/${preset.skin.attachment}`;
  const farSlot = (m.slots[preset.skin.slot] ?? preset.skin.slot) as string;
  const sheets = [...preset.assembly.sheets.map((s) => `${s.slot}/${s.attachment}`), armSheet, `${farSlot}/${preset.skin.attachment}`];
  const companion = validationCompanion(rig);
  const regionOf = new Map<number, string>();
  for (const [region, ids] of Object.entries(companion.regions[armSheet]?.triangles ?? {})) for (const t of ids as number[]) regionOf.set(t, region);
  const allowanceOf = (key: string, t: number): DistortionAllowance => {
    if (key.endsWith(`/${preset.skin.attachment}`) && (key === armSheet || key.startsWith(`${farSlot}/`))) return (companion.allowances[regionOf.get(t) ?? "default"] ?? companion.allowances.default ?? DEFAULT_ALLOWANCE) as DistortionAllowance;
    return (companion.allowances.default ?? DEFAULT_ALLOWANCE) as DistortionAllowance;
  };
  const connections: Connection[] = preset.assembly.connections.flatMap((c) => {
    const [owner, cname] = c.closure.split("/") as [string, string];
    const sheet = preset.assembly?.sheets.find((s) => s.name === c.under);
    if (!sheet) throw new Error(`connection '${c.name}': no sheet '${c.under}'`);
    const under = `${sheet.slot}/${sheet.attachment}`;
    const root = preset.chain.bones[0] as string;
    return [
      { closure: `${owner}/${cname}`, arm: armSheet, under, pivot: root, clearance: c.clearance },
      { closure: `${m.slots[owner] ?? owner}/${cname}`, arm: `${farSlot}/${preset.skin.attachment}`, under, pivot: mirrorOf(root), clearance: c.clearance }
    ];
  });
  const root = preset.chain.bones[0] as string;
  const elbow = preset.chain.bones[1] as string;
  const girdle = preset.girdle?.bone as string;
  const rootLim = preset.bones.find((b) => b.name === root)?.limits ?? [0, 0];
  const breathe = preset.gates?.combined?.breathe;
  const all = [...rig.limits, ...rig.clipLimits];
  // Elbow samples from the elbow's build range: both ends, straight, and the half-way bends of each sign.
  const elbowLim = preset.bones.find((b) => b.name === elbow)?.limits ?? [0, 70];
  const elbows = [...new Set([elbowLim[0], elbowLim[0] / 2, 0, elbowLim[1] / 2, elbowLim[1]].map((v) => Math.round(v * 2) / 2))].sort((x, y) => x - y);
  const geoPoses: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) {
    for (const e of elbows) for (const g of [-6, 0, 6]) {
      const pose = { [root]: a, [elbow]: e, [girdle]: g };
      if (!insideLimits(all, pose)) continue;
      geoPoses.push(both(`raise ${a} elbow ${e} shrug ${g}`, pose, mirrorOf));
    }
  }
  for (const a of [-60, 0, 90]) for (const lean of [-10, 10]) geoPoses.push(both(`raise ${a} lean ${lean}`, { [root]: a }, mirrorOf, { chest: lean }));
  if (breathe) for (const a of [-60, 0, 90]) geoPoses.push({ ...both(`raise ${a} breathe`, { [root]: a }, mirrorOf), scale: { [breathe.bone]: { x: breathe.x, y: breathe.y } } });
  for (const p of preset.assembly.poses) geoPoses.push(both(p.name, p.pose, mirrorOf));
  const shoulderPoses: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) for (const g of [-6, 0, 6]) shoulderPoses.push(both(`raise ${a} shrug ${g}`, { [root]: a, [girdle]: g }, mirrorOf));
  for (const a of [-60, -40, 0, 45, 90]) for (const lean of [-10, 10]) shoulderPoses.push(both(`raise ${a} lean ${lean}`, { [root]: a }, mirrorOf, { chest: lean }));
  if (breathe) for (const a of [-60, 0, 90]) shoulderPoses.push({ ...both(`raise ${a} breathe`, { [root]: a }, mirrorOf), scale: { [breathe.bone]: { x: breathe.x, y: breathe.y } } });
  for (const p of preset.assembly.poses) shoulderPoses.push(both(p.name, p.pose, mirrorOf));
  const normalPoses: ArmLayerPose[] = [];
  for (const a of [-15, -10, -5, 0, 5, 10, 15]) for (const e of [0, 35, 70]) for (const g of [-6, 0, 6]) for (const lean of [-10, 0, 10]) {
    const pose = { [root]: a, [elbow]: e, [girdle]: g };
    if (insideLimits(all, pose)) normalPoses.push(both(`normal raise ${a} elbow ${e} shrug ${g} lean ${lean}`, pose, mirrorOf, { chest: lean }));
  }
  // Ink: one arm at a time (with both arms crossing, the far arm legitimately covers the near one's lines).
  const inkPoses: ArmLayerPose[] = [];
  for (let a = rootLim[0]; a <= rootLim[1] + 1e-9; a += 5) for (const g of [-6, 0, 6]) {
    inkPoses.push({ name: `left raise ${a} shrug ${g}`, rotate: { [root]: a, [girdle]: g } });
    inkPoses.push({ name: `right raise ${a} shrug ${g}`, rotate: { [mirrorOf(root)]: -a, [mirrorOf(girdle)]: -g } });
  }
  for (const a of [-60, -40, 0, 90]) for (const lean of [-10, 10]) inkPoses.push({ name: `left raise ${a} lean ${lean}`, rotate: { [root]: a, chest: lean } });
  // Inward elbow folds (milestone 4): both arms and one arm, a few raises, inside every limit.
  const foldPoses: ArmLayerPose[] = [];
  for (const e of [-15, -30, -60, -80, -85]) for (const a of [-20, 0, 15, 45]) {
    if (!insideLimits(all, { [root]: a, [elbow]: e })) continue;
    foldPoses.push(both(`both raise ${a} fold ${e}`, { [root]: a, [elbow]: e }, mirrorOf));
    foldPoses.push({ name: `left raise ${a} fold ${e}`, rotate: { [root]: a, [elbow]: e } });
    foldPoses.push({ name: `right raise ${a} fold ${e}`, rotate: { [mirrorOf(root)]: -a, [mirrorOf(elbow)]: -e } });
  }
  inkPoses.push(...foldPoses.filter((p) => !p.name.startsWith("both")));
  // Arm edges over the torso (review): one arm at a time, every across pose, shrug and lean.
  const acrossPoses: ArmLayerPose[] = [];
  for (let a = -20; a >= rootLim[0] - 1e-9; a -= 5) for (const g of [-6, 0, 6]) for (const lean of [-10, 0, 10]) {
    acrossPoses.push({ name: `left across ${a} shrug ${g} lean ${lean}`, rotate: { [root]: a, [girdle]: g, chest: lean } });
    acrossPoses.push({ name: `right across ${a} shrug ${g} lean ${lean}`, rotate: { [mirrorOf(root)]: -a, [mirrorOf(girdle)]: -g, chest: lean } });
  }
  const walkPose = both("walk", {}, mirrorOf, { [root]: 10, [elbow]: 8, [mirrorOf(root)]: 6, [mirrorOf(elbow)]: -4 });
  const sheetName = preset.assembly.sheets[0] as { slot: string; attachment: string };
  const underKey = `${sheetName.slot}/${sheetName.attachment}`;
  const fore = preset.skin.groups[1]?.slot as string;
  const handSlot = preset.regions.find((r) => r.bone === preset.chain.bones[2])?.slot as string;
  const edgeChains = [preset.skin.slot, farSlot].flatMap((armSlot) => {
    const f = armSlot === preset.skin.slot ? fore : ((m.slots[fore] ?? fore) as string);
    const h = armSlot === preset.skin.slot ? handSlot : ((m.slots[handSlot] ?? handSlot) as string);
    const near = armSlot === preset.skin.slot;
    const across = (p: ArmLayerPose) => (near ? (p.rotate[root] ?? 0) <= -20 : (p.rotate[mirrorOf(root)] ?? 0) >= 20);
    return [
      { name: `${armSlot} outer`, contours: [`${armSlot}/outline_front`, `${armSlot}/outline`, `${armSlot}/cap_front`, `${f}/outline`, `${f}/outline_f1`, `${h}/outline`], under: underKey, skip: h, across },
      { name: `${armSlot} inner`, contours: [`${armSlot}/underside_front`, `${armSlot}/underside`, `${armSlot}/cap_front`, `${f}/outline`, `${f}/outline_f1`, `${h}/outline`], under: underKey, skip: h, across }
    ];
  });
  const textures = m.textures;
  // The always-inked across-body edges (outline_front, underside_front; `outline` and `underside` are
  // trimmed where buried in the torso: the raised arm's outer edge over the shoulder).
  const keep = [`${preset.skin.slot}/underside_front`, `${preset.skin.slot}/outline_front`, `${farSlot}/underside_front`, `${farSlot}/outline_front`];
  const results: GateResult[] = [
    required,
    sheetGate(doc, sheets),
    geometryGate(doc, sheets, geoPoses, allowanceOf, companion.gameScale),
    closureGate(doc, fillDoc, textures, connections, shoulderPoses),
    capCoverageGate(doc, connections, normalPoses, 45, 2),
    inkGate(doc, connections, keep, inkPoses, [preset.skin.slot, farSlot].flatMap((a) => [`${a}/outline`, `${a}/underside`])),
    paintGate(doc, textures, sheets),
    edgeContinuityGate(doc, textures, edgeChains, acrossPoses),
    wristGate(doc, textures, [preset.skin.slot, farSlot].map((armSlot) => {
      const near = armSlot === preset.skin.slot;
      const f = near ? fore : ((m.slots[fore] ?? fore) as string);
      const h = near ? handSlot : ((m.slots[handSlot] ?? handSlot) as string);
      return { slots: [armSlot, f, h], hand: h };
    }), [
      ...[0, -20, -40, -60, -70].map((a) => ({ name: `left ${a}`, rotate: { [root]: a } })),
      ...[0, -20, -40, -60, -70].map((a) => ({ name: `right ${a}`, rotate: { [mirrorOf(root)]: -a } })),
      ...[-20, -40, -60].map((a) => both(`both ${a}`, { [root]: a }, mirrorOf)),
      both("flex", { [root]: 58, [elbow]: 68 }, mirrorOf),
      both("wrist +30", { [root]: -40, [preset.chain.bones[2] as string]: 30 }, mirrorOf),
      both("wrist -30", { [root]: -40, [preset.chain.bones[2] as string]: -30 }, mirrorOf)
    ], 45, [parseInt(preset.skin.base.slice(0, 2), 16), parseInt(preset.skin.base.slice(2, 4), 16), parseInt(preset.skin.base.slice(4, 6), 16)]),
    crossedArmsGate(doc, textures, frontSlots, backSlots, [-20, -30, -40, -50, -60, -70].flatMap((a) => [both(`crossed ${a}`, { [root]: a }, mirrorOf), both(`crossed ${a} shrug +6`, { [root]: a, [girdle]: 6 }, mirrorOf), both(`crossed ${a} wrist 30`, { [root]: a, [preset.chain.bones[2] as string]: 30 }, mirrorOf)]), [300, 640, 784, 1010]),
    lineEndGate(doc, textures, [root, mirrorOf(root), elbow, mirrorOf(elbow)], [
      ...shoulderPoses,
      walkPose,
      ...foldPoses,
      ...[0, 35, 70].flatMap((e) => [15, 45, 58, 90, 105].map((a) => both(`raise ${a} elbow ${e}`, { [root]: a, [elbow]: e }, mirrorOf))).filter((p) => insideLimits(all, Object.fromEntries(Object.entries(p.rotate).filter(([b]) => b === root || b === elbow))))
    ]),
    openEndGate(doc, [elbow, mirrorOf(elbow)], [...foldPoses, both("rest", {}, mirrorOf), walkPose, both("flex", { [root]: 58, [elbow]: 68 }, mirrorOf)]),
    torsoOutlineGate(doc, textures, sheetName.slot, underKey, Object.entries((m.doc.skins as Record<string, any>).body?.contours?.[sheetName.slot] ?? {}).map(([n]) => `${sheetName.slot}/${n}`), [
      ...acrossPoses.filter((p) => /shrug 0 lean 0$/.test(p.name)),
      ...[-60, -40, -20].map((a) => both(`both across ${a}`, { [root]: a }, mirrorOf)),
      ...preset.assembly.poses.map((p) => both(p.name, p.pose, mirrorOf))
    ])
  ];
  // Damaged control of the open-end gate on this rig: drop the forearm-fold OR group of the front
  // edge faders (only the raise fade left); the folded crease ends must then be reported open.
  {
    const noFold = structuredClone(m.doc);
    noFold.driven = (noFold.driven as any[]).filter((d) => !d.alphaOr || /_or0(_r)?$/.test(d.alphaOr)).map(({ alphaOr: _g, ...d }) => d);
    const control = openEndGate(loadAnimDocument(noFold), [elbow, mirrorOf(elbow)], foldPoses);
    results.push({ gate: "open ends damaged control (fold fader dropped) fails", ok: !control.ok, measured: control.measured, detail: control.detail });
  }
  for (const r of results) if (!r.ok) failures.push(`${r.gate}: ${r.detail}`);
  const report = { preset: preset.name, rig: { half: rig.report, mirror: m.report }, gates: results, failures };
  writeFileSync(join(outDir, `${preset.name}.gates.json`), `${JSON.stringify(report, null, 2)}\n`);
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${r.gate}: ${r.detail}\n`);

  // --- evidence -------------------------------------------------------------------------------
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    const render = (d: AnimDocument, tex: ReadonlyMap<string, RgbaImage>, pose: ArmLayerPose, rect: [number, number, number, number], scale: number, skins?: string[]) => {
      const sk = poseSkeleton(d, skins);
      for (const s of sk.slots) if (/tank/.test(s.data.name)) s.hidden = true;
      applyPose(sk, pose);
      const [x0, y0, x1, y1] = rect;
      return softRender(sk, tex, { width: Math.round((x1 - x0) * scale), height: Math.round((y1 - y0) * scale), scale, left: x0 - d.canvas.originX, top: y0 - d.canvas.originY, background: BG }).image;
    };
    let cur: { doc: AnimDocument; tex: Map<string, RgbaImage>; skins: string[] } | null = null;
    if (current) {
      const base = (readdirSync(current).find((f) => f.endsWith(".anim.json")) ?? "").replace(/\.anim\.json$/, "");
      if (!base) throw new Error(`--current ${current}: no .anim.json`);
      const file = readFileSync(join(current, `${base}.anim.json`), "utf8");
      const cdoc = loadAnimDocument(JSON.parse(file));
      const cpack = atlasPackSchema.parse(JSON.parse(readFileSync(join(current, `${base}.atlas.json`), "utf8")));
      const cpages = new Map(cpack.pages.map((p) => [p.file, readPng(join(current, p.file))] as [string, RgbaImage]));
      cur = { doc: cdoc, tex: texturesFromAtlas(cpack, cpages), skins: ["body"] };
    }
    const walk = walkPose;
    const named: ArmLayerPose[] = [both("rest", {}, mirrorOf), walk, both("raise 90", { [root]: 90 }, mirrorOf), both("flex 58/68", { [root]: 58, [elbow]: 68 }, mirrorOf)];
    const full: [number, number, number, number] = [250, 380, 834, 1040];
    const shoulder: [number, number, number, number] = [340, 630, 560, 860];
    for (const [label, rect, scale] of [["0.4", full, 0.4], ["4x", shoulder, 4]] as const) {
      const tiles: { image: RgbaImage; label: string }[] = [];
      for (const p of named) {
        if (cur) tiles.push({ image: render(cur.doc, cur.tex, p, rect as any, scale, cur.skins), label: `current ${p.name}` });
        tiles.push({ image: render(doc, textures, p, rect as any, scale), label: `arm layer ${p.name}` });
      }
      writePng(join(evidence, `bare-${label}.png`), grid(tiles, cur ? 2 : 4, label === "4x" ? 3 : 1));
    }
    const across: { image: RgbaImage; label: string }[] = [];
    const wide: [number, number, number, number] = [300, 560, 784, 1000];
    for (const side of ["left", "right", "both"] as const) {
      for (const a of [-20, -40, -60]) {
        const rot: Record<string, number> = {};
        if (side !== "right") rot[root] = a;
        if (side !== "left") rot[mirrorOf(root)] = -a;
        across.push({ image: render(doc, textures, { name: `${side} ${a}`, rotate: rot }, wide, 1), label: `${side} arm ${a}` });
      }
    }
    writePng(join(evidence, "across-1x.png"), grid(across, 3, 2));
    const across4: { image: RgbaImage; label: string }[] = [];
    for (const a of [-20, -40, -60]) across4.push({ image: render(doc, textures, { name: `left ${a}`, rotate: { [root]: a } }, [390, 690, 610, 990], 4), label: `left arm ${a} (4x)` });
    writePng(join(evidence, "across-4x.png"), grid(across4, 3, 3));
    // Milestone 4: the elbow folds inward (negative forearm with the arm down), -15 / -30 / -60 / -85.
    const folds = [-15, -30, -60, -85];
    const fold04: { image: RgbaImage; label: string }[] = [];
    for (const e of folds) fold04.push({ image: render(doc, textures, both(`fold ${e}`, { [elbow]: e }, mirrorOf), full, 0.4), label: `both arms fold ${e}` });
    writePng(join(evidence, "inward-fold-0.4.png"), grid(fold04, 4, 1));
    const fold4: { image: RgbaImage; label: string }[] = [];
    for (const e of folds) fold4.push({ image: render(doc, textures, { name: `fold ${e}`, rotate: { [elbow]: e } }, [330, 740, 520, 930], 4), label: `left elbow ${e} (4x)` });
    writePng(join(evidence, "inward-fold-4x.png"), grid(fold4, 2, 3));
    // Fists at 4x: one arm and both arms at -20 / -40 / -60, crop centred on the fist(s).
    const fists: { image: RgbaImage; label: string }[] = [];
    const handBone = preset.chain.bones[2] as string;
    for (const sideName of ["left", "right", "both"] as const) {
      for (const a of [-20, -40, -60]) {
        const rot: Record<string, number> = {};
        if (sideName !== "right") rot[root] = a;
        if (sideName !== "left") rot[mirrorOf(root)] = -a;
        const pose = { name: `${sideName} ${a}`, rotate: rot };
        const sk = poseSkeleton(doc);
        applyPose(sk, pose);
        const hs = (sideName === "left" ? [handBone] : sideName === "right" ? [mirrorOf(handBone)] : [handBone, mirrorOf(handBone)]).map((b) => sk.getBone(b).world);
        const cx = hs.reduce((s2, h) => s2 + h.x, 0) / hs.length + doc.canvas.originX;
        const cy = hs.reduce((s2, h) => s2 + h.y, 0) / hs.length + doc.canvas.originY + 20;
        const hw = sideName === "both" ? 120 : 75;
        fists.push({ image: render(doc, textures, pose, [cx - hw, cy - 75, cx + hw, cy + 75], 4), label: `${sideName} arm ${a} fist(s) 4x` });
      }
    }
    writePng(join(evidence, "fists-4x.png"), grid(fists, 3, 3));
    // Crossed arms (assembly.frontArm): the full render, the front arm alone and the back arm alone.
    const crossed: { image: RgbaImage; label: string }[] = [];
    for (const a of [-40, -60]) {
      const pose = both(`crossed ${a}`, { [root]: a }, mirrorOf);
      const sk = poseSkeleton(doc);
      applyPose(sk, pose);
      const cr: [number, number, number, number] = [432, 840, 652, 990];
      const one = (filter: (n: string) => boolean) => {
        const s2 = poseSkeleton(doc);
        applyPose(s2, pose);
        return softRender(s2, textures, { width: 880, height: 600, scale: 4, left: cr[0] - doc.canvas.originX, top: cr[1] - doc.canvas.originY, background: BG, slotFilter: (s) => filter(s.data.name) }).image;
      };
      crossed.push({ image: one(() => true), label: `crossed ${a}: full` });
      crossed.push({ image: one((n) => frontSlots.includes(n)), label: `crossed ${a}: front arm (${preset.assembly.frontArm})` });
      crossed.push({ image: one((n) => backSlots.includes(n)), label: `crossed ${a}: back arm` });
    }
    writePng(join(evidence, "crossed-4x.png"), grid(crossed, 3, 3));
    const flank: { image: RgbaImage; label: string }[] = [];
    for (const [label, rot] of [["left -40", { [root]: -40 }], ["left -60", { [root]: -60 }], ["both -60", { [root]: -60, [mirrorOf(root)]: 60 }]] as const) flank.push({ image: render(doc, textures, { name: label, rotate: rot }, [400, 700, 520, 1010], 4), label: `${label}: screen-left flank (4x)` });
    writePng(join(evidence, "torso-flank-4x.png"), grid(flank, 3, 3));
    const across04 = across.map((t, i) => {
      const a = [-20, -40, -60][i % 3] as number;
      const side = Math.floor(i / 3);
      const rot: Record<string, number> = {};
      if (side !== 1) rot[root] = a;
      if (side !== 0) rot[mirrorOf(root)] = -a;
      return { ...t, image: render(doc, textures, { name: t.label, rotate: rot }, full, 0.4) };
    });
    writePng(join(evidence, "across-0.4.png"), grid(across04, 3, 1));
    const seam: { image: RgbaImage; label: string }[] = [];
    const crop: [number, number, number, number] = [370, 640, 520, 800];
    for (const p of [both("rest", {}, mirrorOf), both("raise 45", { [root]: 45 }, mirrorOf), both("raise 105 shrug +6", { [root]: 105, [girdle]: 6 }, mirrorOf), both("across -40", { [root]: -40 }, mirrorOf), both("across -60", { [root]: -60 }, mirrorOf), both("across -60 shrug -6 lean 10", { [root]: -60, [girdle]: -6 }, mirrorOf, { chest: 10 })]) seam.push({ image: render(doc, textures, p, crop, 4), label: p.name });
    writePng(join(evidence, "seam-4x.png"), grid(seam, 3, 3));
  }
  if (failures.length) {
    process.stderr.write(`arm layer: ${failures.length} gate failure(s)\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
