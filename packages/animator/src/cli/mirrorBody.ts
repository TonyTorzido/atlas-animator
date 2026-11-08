/*
 * Atlas Animator: original implementation.
 *
 * Plan (part b): the whole upper body from the certified half rig.
 * `tsx src/cli/mirrorBody.ts <half rig dir> <preset.json> <out dir> [--no-render]`
 * mirrors the half (tools/mirrorRig.ts), welds one skin, adds the evidence clips, writes the rig
 * and atlas, and certifies the merged rig: bind and pose symmetry, the centreline weld (raster
 * alpha along the welded line in every combined pose), and the unified validator (geometry on the
 * combined poses through a companion mapped from the half's, tears = raster alpha and seams).
 * Renders the clips through the game's Pixi page: game-size and 3x-nearest sheets, GIF of the idle.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { MeshAttachment } from "../core/attachments.js";
import { atlasPackSchema } from "../core/atlasPack.js";
import { mirrorRig } from "../tools/mirrorRig.js";
import { readPng, writePng } from "../tools/png.js";
import { texturesFromAtlas, validateRig } from "../tools/validate.js";
import { rigHash } from "../tools/validateGeometry.js";
import { bodyBudget, compareFindings, companionWithPoses, skinAloneDoc } from "../tools/mirrorCertify.js";
import { writeAtlas } from "../tools/surface/output.js";
import { loadPreset } from "../tools/surface/preset.js";
import { softRender } from "../tools/softRender.js";
import { fitInsideLimits, insideLimits, type PoseLimit } from "../tools/surface/limits.js";
import { deriveBodyContours, flattenUnderGarmentShading, opaqueOutline } from "../tools/bodyContours.js";
import { grid } from "../tools/review.js";
import { renderFrames, writeGif } from "./render.js";
import type { RgbaImage } from "../tools/image.js";

type Pose = Record<string, number>;
type Clip = { name: string; keys: { t: number; pose: Pose; scale?: number }[]; loop?: boolean };

async function main() {
  const [halfDir, presetPath, outDir] = process.argv.slice(2) as [string, string, string];
  const noRender = process.argv.includes("--no-render");
  const preset = loadPreset(resolve(presetPath));
  if (!preset.mirror) throw new Error("the preset declares no mirror rule");
  const name = preset.name;
  const raw = JSON.parse(readFileSync(join(halfDir, `${name}.anim.json`), "utf8"));
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(join(halfDir, `${name}.atlas.json`), "utf8")));
  const pages = new Map(pack.pages.map((p) => [p.file, readPng(join(halfDir, p.file))] as [string, RgbaImage]));
  const textures = texturesFromAtlas(pack, pages);
  const centre: Record<string, any> = {};
  const asym = new Set(preset.mirror.asymmetric ?? []);
  for (const r of preset.regions) centre[r.texture] = { image: readPng(resolve(dirname(resolve(presetPath)), r.image)), crop: r.crop, keep: r.keep, asymmetric: asym.has(r.name) };
  const m = mirrorRig(raw, textures, preset.mirror, centre);
  // Clothing model, body side (close): the body's own contours on every hull run no
  // skin contour strokes yet, and a bare-skin texture without garment-era shading.
  const bodySkinKey = Object.keys(m.doc.skins).find((k) => m.doc.skins[k].attachments?.[preset.skin.slot]?.[preset.skin.attachment]) as string;
  const bodyContours = deriveBodyContours(m.doc, bodySkinKey, preset.skin.slot, preset.skin.attachment);
  const skinPath = m.doc.skins[bodySkinKey].attachments[preset.skin.slot][preset.skin.attachment].path as string;
  const skinImage = m.textures.get(skinPath);
  // Rigid regions (the head) trim strokes only under their opaque art: outline from the texture.
  for (const sk of Object.values(m.doc.skins as Record<string, any>)) {
    for (const bySlot of Object.values((sk.attachments ?? {}) as Record<string, Record<string, any>>)) {
      for (const att of Object.values(bySlot)) {
        if (att.type !== "region" || att.opaque) continue;
        const img = m.textures.get(att.path);
        const outline = img ? opaqueOutline(img) : null;
        if (outline) att.opaque = outline;
      }
    }
  }
  let flattenedTexels = 0;
  if (skinImage) {
    const copy = { width: skinImage.width, height: skinImage.height, data: new Uint8Array(skinImage.data) };
    flattenedTexels = flattenUnderGarmentShading(copy);
    m.textures.set(skinPath, copy);
  }
  const R = (b: string) => m.bones[b] as string;
  // Driver names from the preset: the limb chain's root and middle bones, the girdle, the lean (base)
  // bone and the two branch bones above it (neck-like, head-like).
  const [ARM, ELBOW] = preset.chain.bones as [string, string];
  const GIRDLE = preset.girdle?.bone as string;
  const LEAN = preset.base;
  const above = preset.chain.branches?.find((b) => b.bones.includes(LEAN))?.bones ?? [];
  const [NECK, HEAD] = above.slice(above.indexOf(LEAN) + 1) as [string, string];
  const SKIN = `${preset.skin.slot}/${preset.skin.attachment}`;
  const gameScale = preset.gamePixels / preset.figureHeight;

  // --- evidence clips (30 fps, linear keys; right-arm values are negated left values) ------------
  const both = (raise: number, elbow = 0, shrug = 0): Pose => ({ [ARM]: raise, [R(ARM)]: -raise, [ELBOW]: elbow, [R(ELBOW)]: -elbow, [GIRDLE]: shrug, [R(GIRDLE)]: -shrug });
  const lr = (a: number, b: number, ea = 0, eb = 0): Pose => ({ [ARM]: a, [R(ARM)]: -b, [ELBOW]: ea, [R(ELBOW)]: -eb });
  // Head toward the left hand: the neck/head sign that moves the head top to smaller x.
  const probe = new Skeleton(loadAnimDocument({ ...m.doc, animations: {} }));
  probe.setToSetupPose();
  probe.getBone(NECK).pose.rotation += 10;
  probe.updateWorldTransform("none");
  const toLeft = probe.getBone(HEAD).world.x < 0 + (preset.mirror.x - (m.doc.canvas.originX as number)) ? 1 : -1;
  // Head leans stay inside the combined head x arm limits (b): scale the neck/head lean down until inside.
  const limits = ((m.doc.poseLimits ?? []) as PoseLimit[]).map((l) => ({ ...l, source: "" }));
  const fitLean = (p: Pose): Pose => {
    if (insideLimits(limits, p)) return p;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (insideLimits(limits, { ...p, [NECK]: (p[NECK] ?? 0) * mid, [HEAD]: (p[HEAD] ?? 0) * mid })) lo = mid;
      else hi = mid;
    }
    return { ...p, [NECK]: Number(((p[NECK] ?? 0) * lo).toFixed(3)), [HEAD]: Number(((p[HEAD] ?? 0) * lo).toFixed(3)) };
  };
  const headToLeft = fitLean({ ...lr(90, 0, 30, 0), [NECK]: 10 * toLeft, [HEAD]: 15 * toLeft });
  const clips: Clip[] = [
    { name: "left_raise", keys: [{ t: 0, pose: lr(0, 0) }, { t: 1.2, pose: lr(100, 0) }, { t: 1.5, pose: lr(100, 0) }] },
    { name: "right_raise", keys: [{ t: 0, pose: lr(0, 0) }, { t: 1.2, pose: lr(0, 100) }, { t: 1.5, pose: lr(0, 100) }] },
    { name: "both_raise", keys: [{ t: 0, pose: both(0) }, { t: 1.2, pose: both(100) }, { t: 1.5, pose: both(100) }] },
    { name: "high_low", keys: [{ t: 0, pose: lr(0, 0) }, { t: 1, pose: lr(100, 0) }, { t: 1.3, pose: lr(100, 0) }] },
    { name: "low_high", keys: [{ t: 0, pose: lr(0, 0) }, { t: 1, pose: lr(0, 100) }, { t: 1.3, pose: lr(0, 100) }] },
    { name: "elbows_bent", keys: [{ t: 0, pose: both(0, 0) }, { t: 0.8, pose: both(60, 0) }, { t: 1.6, pose: both(60, 70) }, { t: 1.9, pose: both(60, 70) }] },
    { name: "shrug", keys: [{ t: 0, pose: both(45, 0, -6) }, { t: 1, pose: both(45, 0, 6) }, { t: 1.3, pose: both(45, 0, 6) }] },
    { name: "lean", keys: [{ t: 0, pose: { ...both(60), [LEAN]: -10 } }, { t: 1.4, pose: { ...both(60), [LEAN]: 10 } }, { t: 1.7, pose: { ...both(60), [LEAN]: 10 } }] },
    { name: "head_to_left_hand", keys: [{ t: 0, pose: lr(0, 0) }, { t: 1, pose: headToLeft }, { t: 1.3, pose: headToLeft }] },
    {
      name: "idle_wave",
      loop: true,
      keys: [
        { t: 0, pose: both(0), scale: 1 },
        { t: 0.8, pose: both(80, 0), scale: 1.006 },
        { t: 1.2, pose: both(80, 40), scale: 1.012 },
        { t: 1.6, pose: both(80, 5), scale: 1.012 },
        { t: 2.0, pose: both(80, 40), scale: 1.006 },
        { t: 2.4, pose: both(80, 0), scale: 1 },
        { t: 3.2, pose: both(0), scale: 1 }
      ]
    }
  ];
  const breathe = preset.gates?.combined?.breathe ?? { bone: LEAN, x: 1.012, y: 1.01 };
  for (const c of clips) {
    const bones: Record<string, any> = {};
    // Evidence refit (decision A): every key inside the accepted limits (linear keys between inside
    // poses stay inside each convex limit polygon).
    for (const k of c.keys) k.pose = fitInsideLimits(limits, k.pose);
    const names = [...new Set(c.keys.flatMap((k) => Object.keys(k.pose)))];
    for (const b of names) bones[b] = { rotate: c.keys.map((k) => ({ time: k.t, value: k.pose[b] ?? 0 })) };
    if (c.keys.some((k) => k.scale !== undefined)) {
      const s = (k: { scale?: number }) => ((k.scale ?? 1) - 1) / (breathe.x - 1);
      (bones[breathe.bone] ??= {}).scale = c.keys.map((k) => ({ time: k.t, x: 1 + s(k) * (breathe.x - 1), y: 1 + s(k) * (breathe.y - 1) }));
    }
    m.doc.animations[c.name] = { duration: c.keys[c.keys.length - 1]?.t, loop: !!c.loop, fps: 30, bones };
  }
  mkdirSync(join(outDir, "rig"), { recursive: true });
  const rigName = `${name}-body`;
  const docPath = join(outDir, "rig", `${rigName}.anim.json`);
  writeFileSync(docPath, `${JSON.stringify(m.doc)}\n`);
  writeAtlas(m.textures, join(outDir, "rig"), rigName);
  writeFileSync(join(outDir, "rig", `${rigName}.mirror.json`), `${JSON.stringify({ rule: preset.mirror, bones: m.bones, slots: m.slots, meshes: m.meshes }, null, 1)}\n`);
  const doc = loadAnimDocument(m.doc);
  const report: Record<string, unknown> = { mirror: m.report };

  // --- combined poses (inside the declared limits) ---------------------------------------------
  const combined: { name: string; pose: Pose }[] = [];
  const add = (n: string, p: Pose) => combined.push({ name: n, pose: p });
  for (const raise of [-15, 30, 60, 90]) for (const shrug of [-6, 0, 6]) for (const chest of [-10, 0, 10]) for (const sc of [1, breathe.x]) {
    const p: Pose = { ...both(raise, raise >= 90 ? 30 : 0, shrug), [LEAN]: chest, ...(sc !== 1 ? { [`${breathe.bone}.scaleX`]: breathe.x, [`${breathe.bone}.scaleY`]: breathe.y } : {}) };
    add(`both raise ${raise} shrug ${shrug} lean ${chest}${sc !== 1 ? " breathe" : ""}`, p);
  }
  for (const [a, b] of [[100, -15], [-15, 100], [90, 30], [30, 90]] as const) for (const chest of [-10, 10]) add(`L ${a} R ${b} lean ${chest}`, { ...lr(a, b, a >= 90 ? 30 : 60, b >= 90 ? 30 : 60), [LEAN]: chest, [`${breathe.bone}.scaleX`]: breathe.x, [`${breathe.bone}.scaleY`]: breathe.y });
  for (const s of [-1, 1]) add(`head ${s > 0 ? "+" : "-"} with L raised`, fitLean({ ...lr(90, 0, 30, 0), [NECK]: 10 * s, [HEAD]: 15 * s, [LEAN]: 10 * s }));
  // Combined poses refit inside the accepted limits (decision A); any still outside are dropped.
  const refitPoses: string[] = [];
  for (const c of combined) {
    const f = fitInsideLimits(limits, c.pose);
    if (f !== c.pose) refitPoses.push(c.name);
    c.pose = f;
  }
  const outsideLimits = combined.filter((c) => !insideLimits(limits, c.pose)).map((c) => c.name);
  combined.splice(0, combined.length, ...combined.filter((c) => insideLimits(limits, c.pose)));
  const mirrorPose = (p: Pose): Pose => {
    const q: Pose = {};
    for (const [k, v] of Object.entries(p)) {
      if (k.includes(".scale")) q[k] = v;
      else q[m.bones[k] ?? Object.keys(m.bones).find((l) => m.bones[l] === k) ?? k] = -v;
    }
    return q;
  };

  // --- certification: symmetry and the centreline weld ------------------------------------------
  const sk = new Skeleton(doc);
  sk.setActiveSkins(Object.keys(doc.skins));
  const ox = doc.canvas.originX;
  const oy = doc.canvas.originY;
  // The weld raster runs on the skin alone (its slot and draw groups, no strokes): a dressed render
  // could hide a skin crack under the tank or the head.
  const skAlone = new Skeleton(loadAnimDocument(skinAloneDoc(m.doc, preset.skin.slot, preset.skin.attachment)));
  skAlone.setActiveSkins(Object.keys(doc.skins));
  const poseSk = (p: Pose, target: Skeleton = sk) => {
    const sk = target;
    sk.setToSetupPose();
    for (const [k, v] of Object.entries(p)) {
      const mm = /^(.+)\.scale([XY])$/.exec(k);
      if (mm) {
        const b = sk.getBone(mm[1] as string);
        if (mm[2] === "X") b.pose.scaleX = b.data.scaleX * v;
        else b.pose.scaleY = b.data.scaleY * v;
      } else sk.getBone(k).pose.rotation = sk.getBone(k).data.rotation + v;
    }
    sk.updateWorldTransform("none");
  };
  const verts = (key: string) => {
    const [slotName, att] = key.split("/") as [string, string];
    const slot = sk.getSlot(slotName);
    const w = sk.meshWorldVertices(sk.getAttachment(slot, att) as MeshAttachment, slot.bone);
    return (i: number): [number, number] => [(w[i * 2] as number) + ox, (w[i * 2 + 1] as number) + oy];
  };
  const X = preset.mirror.x;
  const sym: Record<string, { bind: number; poses: number }> = {};
  for (const [key, c] of Object.entries(m.meshes)) {
    poseSk({});
    const v = verts(key);
    let bind = 0;
    for (const [l, r] of c.pairs) bind = Math.max(bind, Math.hypot(2 * X - v(l)[0] - v(r)[0], v(l)[1] - v(r)[1]));
    for (const i of c.centre) bind = Math.max(bind, Math.abs(v(i)[0] - X));
    let poses = 0;
    for (const { pose } of combined) {
      poseSk(pose);
      const a = c.pairs.map(([l]) => verts(key)(l));
      poseSk(mirrorPose(pose));
      const vb = verts(key);
      c.pairs.forEach(([, r], k) => (poses = Math.max(poses, Math.hypot(2 * X - (a[k] as [number, number])[0] - vb(r)[0], (a[k] as [number, number])[1] - vb(r)[1]))));
    }
    sym[key] = { bind: Number(bind.toExponential(3)), poses: Number(poses.toExponential(3)) };
  }
  report.symmetry = { tolerance: 1e-3, meshes: sym, ok: Object.values(sym).every((s) => s.bind <= 1e-3 && s.poses <= 1e-3) };
  // Weld: every centre edge of the skin has a triangle on each side; raster alpha along the line.
  const skinKey = SKIN;
  const skinAtt = Object.values(m.doc.skins as Record<string, any>).find((sk) => sk.attachments?.[preset.skin.slot]?.[preset.skin.attachment])?.attachments[preset.skin.slot][preset.skin.attachment];
  const centreSet = new Set(m.meshes[skinKey]?.centre);
  const edgeTris = new Map<string, number>();
  const tris: number[] = skinAtt.triangles;
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e] as number;
    const b = tris[t + ((e + 1) % 3)] as number;
    if (centreSet.has(a) && centreSet.has(b)) edgeTris.set(`${Math.min(a, b)}-${Math.max(a, b)}`, (edgeTris.get(`${Math.min(a, b)}-${Math.max(a, b)}`) ?? 0) + 1);
  }
  const openEdges = [...edgeTris.entries()].filter(([, n]) => n !== 2).map(([e]) => e);
  const centreEdges = [...edgeTris.keys()].map((e) => e.split("-").map(Number) as [number, number]);
  const hull = new Set<number>([...Array(skinAtt.hull as number).keys()]);
  let worstAlpha = 255;
  let worstAt = "";
  let samples = 0;
  for (const { name: pn, pose } of combined) {
    poseSk(pose);
    poseSk(pose, skAlone);
    const v = verts(skinKey);
    for (const k of [1, 3]) {
      const scale = gameScale * k;
      const pts = centreEdges.flatMap(([a, b]) => (hull.has(a) && hull.has(b) ? [] : [0.25, 0.5, 0.75].map((t) => [v(a)[0] + (v(b)[0] - v(a)[0]) * t, v(a)[1] + (v(b)[1] - v(a)[1]) * t] as [number, number])));
      if (!pts.length) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const left = Math.min(...xs) - 20;
      const top = Math.min(...ys) - 20;
      const width = Math.ceil((Math.max(...xs) - left + 20) * scale);
      const height = Math.ceil((Math.max(...ys) - top + 20) * scale);
      const img = softRender(skAlone, m.textures, { width, height, scale, left: left - ox, top: top - oy }).image;
      for (const p of pts) {
        const px = Math.floor((p[0] - left) * scale);
        const py = Math.floor((p[1] - top) * scale);
        // Skip samples within 1.5 output px of the silhouette (edge anti-aliasing, not a crack).
        const nearHull = [...hull].some((h) => Math.hypot((v(h)[0] - p[0]) * scale, (v(h)[1] - p[1]) * scale) < 1.5);
        if (nearHull) continue;
        samples++;
        const a = img.data[(py * width + px) * 4 + 3] as number;
        if (a < worstAlpha) {
          worstAlpha = a;
          worstAt = `${pn} at ${k}x game scale, canvas (${p[0].toFixed(1)}, ${p[1].toFixed(1)})`;
        }
      }
    }
  }
  report.weld = { raster: "skin alone (its slot and draw groups, no strokes)", centreVertices: centreSet.size, centreEdges: centreEdges.length, openEdges, rasterSamples: samples, minAlpha: worstAlpha, worstAt, ok: openEdges.length === 0 && worstAlpha >= 250 };

  // --- unified validator: companion mapped from the half's, combined poses ------------------------
  const half = JSON.parse(readFileSync(join(halfDir, `${name}.validation.json`), "utf8"));
  const regions: Record<string, any> = {};
  for (const [key, r] of Object.entries(half.regions as Record<string, any>)) {
    const T = m.meshes[key]?.leftTriangles ?? 0;
    regions[key] = { ...r, triangles: Object.fromEntries(Object.entries(r.triangles as Record<string, number[]>).map(([j, ts]) => [j, [...ts, ...ts.map((t) => t + T)]])) };
  }
  const exceptions = [...half.exceptions, ...(half.exceptions as any[]).map((e) => {
    const id = String(e.id).replace(/t(\d+)$/, (_, t) => `t${Number(t) + (m.meshes[SKIN]?.leftTriangles ?? 0)}`);
    const poses = Object.fromEntries(Object.entries((e.poses ?? {}) as Record<string, [number, number]>).map(([b, [lo, hi]]) => [m.bones[b] ?? b, [-hi, -lo]]));
    return { ...e, id, poses };
  })].map((e) => ({ ...e, rigHash: rigHash(m.doc) }));
  const poses = combined.map((c) => {
    const rotate: Record<string, number> = {};
    const scale: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(c.pose)) {
      const mm = /^(.+)\.scale([XY])$/.exec(k);
      if (!mm) rotate[k] = v;
      else (scale[mm[1] as string] ??= { x: 1, y: 1 })[mm[2] === "X" ? "x" : "y"] = v;
    }
    return { name: c.name, rotate, ...(Object.keys(scale).length ? { scale } : {}) };
  });
  const companion = { ...half, rigHash: rigHash(m.doc), regions, exceptions, poses };
  writeFileSync(join(outDir, "rig", `${rigName}.validation.json`), `${JSON.stringify(companion)}\n`);
  const rightBones = new Set(Object.entries(m.bones).filter(([l, r]) => l !== r).map(([, r]) => r));
  const v = validateRig(m.doc, { companion, textures: m.textures, tears: true, poses });
  const errors = v.issues.filter((i) => i.severity === "error");
  const byCheck: Record<string, number> = {};
  for (const i of errors) byCheck[i.check] = (byCheck[i.check] ?? 0) + 1;
  // The half baseline: every combined pose projected onto the left side (right drivers dropped).
  const halfPoses = poses.map((p) => ({ ...p, rotate: Object.fromEntries(Object.entries(p.rotate).filter(([b]) => !rightBones.has(b))) }));
  // The half companion carries the projected poses: the validator prefers companion poses, so the
  // original half companion would evaluate its own 1,526 sweep poses instead.
  const halfV = validateRig(raw, { companion: companionWithPoses(half, halfPoses), textures, tears: true, poses: halfPoses });
  const halfErrors = halfV.issues.filter((i) => i.severity === "error");
  const halfByCheck: Record<string, number> = {};
  for (const i of halfErrors) halfByCheck[i.check] = (halfByCheck[i.check] ?? 0) + 1;
  report.validator = {
    combinedPoses: combined.length,
    combinedOutsideLimits: outsideLimits,
    combinedRefitInsideLimits: refitPoses,
    bodyContours: { derived: bodyContours.map((b) => `${b.ref} [${b.points[0]}..${b.points[b.points.length - 1]}]`), flattenedShadingTexels: flattenedTexels },
    halfBaselinePoses: halfPoses.length,
    headToLeftHand: headToLeft,
    errors: errors.length,
    byCheck,
    halfBaselineSamePoses: { errors: halfErrors.length, byCheck: halfByCheck },
    tears: v.tears.reduce((s, t) => ({ holes: s.holes + t.holes, hairlines: s.hairlines + t.hairlines, buriedInk: s.buriedInk + t.buriedInk }), { holes: 0, hairlines: 0, buriedInk: 0 }),
    halfTears: halfV.tears.reduce((s, t) => ({ holes: s.holes + t.holes, hairlines: s.hairlines + t.hairlines, buriedInk: s.buriedInk + t.buriedInk }), { holes: 0, hairlines: 0, buriedInk: 0 }),
    geometry: { findings: v.geometry.findings.length, worst: v.geometry.worst },
    halfGeometry: { findings: halfV.geometry.findings.length, worst: halfV.geometry.worst },
    // Per pose and per triangle (same pose names on both sides), not totals.
    geometryVsHalf: compareFindings(v.geometry.findings, halfV.geometry.findings, Object.fromEntries(Object.entries(m.meshes).map(([k, c]) => [k, c.leftTriangles])), new Set(poses.map((p) => p.name))),
    firstErrors: [...errors.filter((i) => i.check !== "geometry"), ...errors.filter((i) => i.check === "geometry")].slice(0, 40).map((i) => `${i.check}: ${i.message}`),
    halfFirstErrors: halfErrors.filter((i) => i.check !== "geometry").slice(0, 10).map((i) => `${i.check}: ${i.message}`)
  };
  // Whole-body runtime budget re-derived against the per-dressed-character figure.
  report.budget = bodyBudget(m.doc, preset.runtime?.budget, SKIN, m.meshes[SKIN]?.centre.length ?? 0);
  writeFileSync(join(outDir, `${rigName}.certify.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ symmetry: report.symmetry, weld: report.weld, budget: report.budget, validator: { ...(report.validator as any), firstErrors: undefined } }, null, 1)}\n`);

  // --- renders ----------------------------------------------------------------------------------
  if (noRender) return;
  const decode = (b: Buffer): RgbaImage => {
    const p = PNG.sync.read(b);
    return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
  };
  const nearest = (img: RgbaImage, k: number): RgbaImage => {
    const out = { width: img.width * k, height: img.height * k, data: new Uint8Array(img.width * k * img.height * k * 4) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(img.data.subarray((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4, (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4 + 4), (y * out.width + x) * 4);
    return out;
  };
  const crop = (img: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage => {
    const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let y = 0; y < h; y++) out.data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return out;
  };
  const atlasPath = join(outDir, "rig", `${rigName}.atlas.json`);
  // Figure bounds at game scale (canvas 150..934 x 120..1240 covers raised arms).
  const bx0 = 120;
  const by0 = 60;
  const bw = 845;
  const bh = 1100;
  for (const c of clips) {
    const res = await renderFrames({ document: docPath, atlas: atlasPath, clip: c.name, fps: 30, scale: gameScale, background: 0x2b2b2b });
    const frames = res.frames.map((f) => decode(f.png));
    const idx = Array.from({ length: 8 }, (_, i) => Math.round((i * (frames.length - 1)) / 7));
    const g = (img: RgbaImage) => crop(img, Math.floor(bx0 * gameScale), Math.floor(by0 * gameScale), Math.ceil(bw * gameScale), Math.ceil(bh * gameScale));
    writePng(join(outDir, `body-${c.name}-game.png`), grid(idx.map((i) => ({ image: g(frames[i] as RgbaImage), label: `${c.name} ${res.frames[i]?.time.toFixed(2)}s game` })), 8, 1));
    writePng(join(outDir, `body-${c.name}-x3nearest.png`), grid(idx.map((i) => ({ image: nearest(g(frames[i] as RgbaImage), 3), label: `${c.name} ${res.frames[i]?.time.toFixed(2)}s x3 nearest` })), 4, 2));
    if (c.name === "idle_wave") {
      const res3 = await renderFrames({ document: docPath, atlas: atlasPath, clip: c.name, fps: 30, scale: gameScale * 3, background: 0x2b2b2b });
      writeGif(res3, join(outDir, "body-idle_wave-3x-30fps.gif"));
      writeGif(res, join(outDir, "body-idle_wave-game-30fps.gif"));
      const f3 = res3.frames.map((f) => decode(f.png));
      const c3 = (img: RgbaImage) => crop(img, Math.floor(bx0 * gameScale * 3), Math.floor(by0 * gameScale * 3), Math.ceil(bw * gameScale * 3), Math.ceil(bh * gameScale * 3));
      writePng(join(outDir, "body-idle_wave-3x-sheet.png"), grid(idx.map((i) => ({ image: c3(f3[i] as RgbaImage), label: `idle_wave ${res3.frames[i]?.time.toFixed(2)}s dpr3` })), 4, 2));
    }
    process.stdout.write(`rendered ${c.name} (${frames.length} frames)\n`);
  }
  process.stdout.write(`done: ${basename(outDir)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
