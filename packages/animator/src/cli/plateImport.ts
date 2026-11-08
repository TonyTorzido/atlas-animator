/*
 * Atlas Animator: original implementation.
 *
 * `tsx src/cli/plateImport.ts <rig.anim.json> <left-plate.png> <out dir> --plate <spec.plate.json>
 *  [--bare <bare.anim.json>] [--no-render]`
 * Hard-plate import (tools/hardPlate.ts, swag-rules/STYLE.md hard-plate): builds the plate pair from
 * the left art, dresses the rig (the worn configuration, e.g. a body in leather armour) and, with
 * --bare, the bare body (plate alone), and certifies:
 * - restRegistration: at the setup pose each plate covers its art (right: mirrored) with IoU >= 0.985;
 * - rigid: over every 30 fps frame of the evidence clips, the plate's corner distances never change
 *   (< 0.001 px): no skin deformation;
 * - headOverlap: the posed plate outline never runs under the head's outline by more than the spec's
 *   maxHeadOverlapPx;
 * - onShoulder: each plate caps its shoulder joint in every frame: the joint (the arm bone's origin)
 *   stays inside the posed plate outline, and the plate's area centroid never passes the joint toward
 *   the body's midline by more than the spec's maxCentreInsideJointPx (default 6), so it cannot slide
 *   onto the upper chest beside the neck when the arm raises;
 * - overflowDeclared: the plate's paint past the worn rig's rest silhouette lies inside the spec's declared
 *   overflow zones (none declared: the plate stays on the body);
 * - drawOrder: each plate is drawn after its anchor slot and before the head in every frame;
 * - swapWhilePosed: detaching a plate mid arm raise and attaching it again gives exactly the frame of
 *   a plate never detached (production soft renderer, pixel equal).
 * Writes `<out>/rig/*.anim.json` per configuration (plates, plate-alone, one-side, swap) with one
 * atlas, `<name>.report.json` (gates, `certified`), and unless --no-render the 0.4 30 fps GIFs and
 * frame sheets. Exit 1 when any gate fails (after writing everything), 2 on bad input.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { buildPlates, checkPlateOverflow, dressPlates, loadPlateSpec, rigRestSilhouette, mirrorAxis, mirrorImage, plateAreaMask, polygonOverlapPx, regionCorners, regionOpaquePolygon, runPlateChecks, type PlatePiece } from "../tools/hardPlate.js";
import { flagStr, parseArgs } from "../tools/swagTypes.js";
import type { RgbaImage } from "../tools/image.js";
import { renderFrames, sampleIndices, writeGif } from "./render.js";

const FPS = 30;
const CLIPS = ["idle_weight_shift", "walk_in_place", "arm_raise", "flex"];
/** The swap clip: the arm raise, the left plate detached at 1.6 s (arm up) and attached at 2.2 s. */
const SWAP_OFF = 1.6;
const SWAP_ON = 2.2;

function loadTextures(docPath: string): Map<string, RgbaImage> {
  const atlasPath = docPath.replace(/\.anim\.json$/, ".atlas.json");
  const pack = atlasPackSchema.parse(JSON.parse(readFileSync(atlasPath, "utf8")));
  return texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(atlasPath), p.file))] as [string, RgbaImage])));
}

export async function plateImportCommand(positional: readonly string[], flags: Map<string, string | true>): Promise<number> {
  const [rigPath, artPath, outDir] = positional as [string, string, string];
  const specPath = flagStr(flags, "plate");
  if (!rigPath || !artPath || !outDir || !specPath) {
    process.stderr.write("usage: plateImport <rig.anim.json> <left-plate.png> <out dir> --plate <spec.plate.json> [--bare <bare.anim.json>] [--no-render]\n");
    return 2;
  }
  const spec = loadPlateSpec(resolve(specPath));
  const raw = JSON.parse(readFileSync(rigPath, "utf8"));
  const skinKey = Object.keys(raw.skins)[0] as string;
  const art = readPng(artPath);
  const axis = mirrorAxis(spec, raw);
  const ox = raw.canvas.originX as number;
  const oy = raw.canvas.originY as number;
  const W = raw.canvas.width as number;
  const H = raw.canvas.height as number;
  const checks = runPlateChecks(art, spec, axis);
  // past the worn rig's rest outline only inside declared overflow (STYLE.md hard-plate)
  const overflow = checkPlateOverflow(art, rigRestSilhouette(rigPath), spec, axis);
  const pieces = buildPlates(raw, spec, art);
  const left = pieces.filter((p) => p.side === "l");
  const tex = new Map(loadTextures(rigPath));
  for (const p of pieces) tex.set(p.texturePath, p.texture);
  const bareRaw = flagStr(flags, "bare") ? JSON.parse(readFileSync(flagStr(flags, "bare") as string, "utf8")) : null;
  if (bareRaw) for (const [k, v] of loadTextures(flagStr(flags, "bare") as string)) if (!tex.has(k)) tex.set(k, v);

  // --- documents
  const withSwap = (d: any) => {
    const ar = d.animations.arm_raise;
    if (ar) d.animations.plate_swap = { ...structuredClone(ar), slots: { ...(ar.slots ?? {}), [`${spec.name}_l`]: { attachment: [{ time: 0, name: `${spec.name}_l` }, { time: SWAP_OFF, name: null }, { time: SWAP_ON, name: `${spec.name}_l` }] } } };
    return d;
  };
  const docs: Record<string, any> = {
    plates: withSwap(dressPlates(raw, pieces)),
    oneSide: dressPlates(raw, left),
    ...(bareRaw ? { plateAlone: dressPlates(bareRaw, pieces) } : {})
  };
  const rigDir = join(outDir, "rig");
  mkdirSync(rigDir, { recursive: true });
  const stem = `${basename(rigPath).replace(/\.anim\.json$/, "")}-${spec.name}`;
  writeAtlas(tex, rigDir, stem);
  const atlas = join(rigDir, `${stem}.atlas.json`);
  const paths: Record<string, string> = {};
  for (const [k, d] of Object.entries(docs)) {
    paths[k] = join(rigDir, `${stem}.${k}.anim.json`);
    writeFileSync(paths[k] as string, JSON.stringify(d));
    loadAnimDocument(d, { source: paths[k] });
  }

  // --- posed checks
  const make = (d: any) => {
    const loaded = loadAnimDocument(d);
    const sk = new Skeleton(loaded);
    sk.setActiveSkins([skinKey]);
    return { sk, data: new AnimationStateData(loaded) };
  };
  const sample = (m: ReturnType<typeof make>, clip: string | null, t: number) => {
    m.sk.setToSetupPose();
    if (clip) {
      const st = new AnimationState(m.data);
      st.setAnimation(0, clip, { loop: false });
      st.update(t);
      st.apply(m.sk);
    }
    m.sk.updateWorldTransform("none");
  };
  // rest registration
  const restReg: Record<string, number> = {};
  {
    const m = make(docs.plates);
    sample(m, null, 0);
    const slots = new Set(pieces.map((p) => m.sk.getSlot(p.slot.name)));
    const img = softRender(m.sk, tex, { width: W, height: H, left: -ox, top: -oy, slotFilter: (s) => slots.has(s) }).image;
    for (const [side, want] of [["l", art], ["r", mirrorImage(art, axis)]] as const) {
      const area = plateAreaMask(spec, W, H, side, axis, 1);
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < W * H; i++) {
        if (!area[i]) continue;
        const a = (img.data[i * 4 + 3] as number) >= 128;
        const b = (want.data[i * 4 + 3] as number) >= 128;
        if (a && b) inter++;
        if (a || b) uni++;
      }
      restReg[side] = Number((uni ? inter / uni : 0).toFixed(4));
    }
  }
  // rigidity, head overlap, draw order over every frame of the evidence clips (worn and alone)
  const headAtt = raw.skins[skinKey].attachments.head?.head;
  const headOpaque: number[] | undefined = headAtt?.opaque;
  const dist = (c: [number, number][]) => [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]].map(([i, j]) => Math.hypot(c[i as number]![0] - c[j as number]![0], c[i as number]![1] - c[j as number]![1]));
  let rigidMax = 0;
  let headMax = 0;
  const headWorst: string[] = [];
  let orderBad = 0;
  let frames = 0;
  // onShoulder: joint coverage and the plate centre against the joint
  const pointIn = (poly: readonly [number, number][], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i] as [number, number];
      const [xj, yj] = poly[j] as [number, number];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // the plate's area centroid, signed px past the joint toward the body's mirror axis (x)
  const shoulder = (m: { sk: Skeleton }, p: PlatePiece) => {
    const arm = m.sk.findBone(spec.sides[p.side].bone);
    if (!arm) throw new Error(`no bone ${spec.sides[p.side].bone}`);
    const jx = arm.world.x + ox;
    const jy = arm.world.y + oy;
    const poly = regionOpaquePolygon(m.sk, p.slot.name, p.attachment.opaque, ox, oy);
    let A = 0;
    let cx = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i] as [number, number];
      const [xj, yj] = poly[j] as [number, number];
      const c = xj * yi - xi * yj;
      A += c;
      cx += (xj + xi) * c;
    }
    cx /= 3 * A;
    const inward = (cx - jx) * (jx < axis ? 1 : -1);
    return { covered: pointIn(poly, jx, jy), inward };
  };
  const maxInward = spec.maxCentreInsideJointPx ?? 6;
  let inwardMax = -Infinity;
  let uncovered = 0;
  const shoulderWorst: string[] = [];
  const restInward: Record<string, number> = {};
  for (const cfg of Object.keys(docs).filter((k) => k !== "oneSide")) {
    const m = make(docs[cfg]);
    sample(m, null, 0);
    const rest = new Map(pieces.map((p) => [p.slot.name, dist(regionCorners(m.sk, p.slot.name, ox, oy))]));
    for (const p of pieces) restInward[`${cfg} ${p.side}`] = Number(shoulder(m, p).inward.toFixed(2));
    for (const clip of CLIPS) {
      const c = docs[cfg].animations[clip];
      if (!c) continue;
      const n = Math.round(c.duration * FPS);
      for (let f = 0; f <= n; f++) {
        sample(m, clip, f / FPS);
        frames++;
        const order = m.sk.drawOrder.map((s) => s.data.name);
        for (const p of pieces) {
          const dd = dist(regionCorners(m.sk, p.slot.name, ox, oy));
          (rest.get(p.slot.name) as number[]).forEach((v, i) => { rigidMax = Math.max(rigidMax, Math.abs(v - (dd[i] as number))); });
          const sh = shoulder(m, p);
          if (sh.inward > inwardMax) inwardMax = sh.inward;
          if (!sh.covered) uncovered++;
          if ((!sh.covered || sh.inward > maxInward) && shoulderWorst.length < 12) shoulderWorst.push(`${cfg} ${clip} f${f} ${p.side} ${sh.covered ? "" : "joint uncovered "}centre ${sh.inward.toFixed(1)}px inside the joint`);
          const io = order.indexOf(p.slot.name);
          if (!(io > order.indexOf(p.slot.drawAfter) && (order.indexOf("head") < 0 || io < order.indexOf("head")))) orderBad++;
          if (headOpaque) {
            const ov = polygonOverlapPx(regionOpaquePolygon(m.sk, p.slot.name, p.attachment.opaque, ox, oy), regionOpaquePolygon(m.sk, "head", headOpaque, ox, oy));
            if (ov > headMax) headMax = ov;
            if (ov > (spec.maxHeadOverlapPx ?? 0) && headWorst.length < 12) headWorst.push(`${cfg} ${clip} f${f} ${p.side} ${ov}px`);
          }
        }
      }
    }
  }
  // attach / detach while posed: the swap clip after re-attaching equals the never-detached frame
  let swapDiff = -1;
  if (docs.plates.animations.plate_swap) {
    const a = make(docs.plates);
    const t = SWAP_ON + 0.2;
    const render = (clip: string) => { sample(a, clip, t); return softRender(a.sk, tex, { width: W, height: H, left: -ox, top: -oy }).image; };
    const x = render("plate_swap");
    const y = render("arm_raise");
    swapDiff = 0;
    for (let i = 0; i < x.data.length; i++) if (x.data[i] !== y.data[i]) swapDiff++;
    // and while detached the plate really is off
    sample(a, "plate_swap", (SWAP_OFF + SWAP_ON) / 2);
    if (a.sk.getSlot(`${spec.name}_l`).attachment) swapDiff = -2;
  }
  const gates = {
    swagChecks: checks.passed,
    restRegistration: Object.values(restReg).every((v) => v >= 0.985),
    rigid: frames > 0 && rigidMax < 1e-3,
    headOverlap: !!headOpaque && headMax <= (spec.maxHeadOverlapPx ?? 0),
    onShoulder: frames > 0 && uncovered === 0 && inwardMax <= maxInward,
    overflowDeclared: overflow.pass,
    drawOrder: frames > 0 && orderBad === 0,
    swapWhilePosed: swapDiff === 0
  };
  const failedGates = Object.entries(gates).filter(([, v]) => v !== true).map(([k]) => k);
  const certified = failedGates.length === 0;
  const report = { spec: specPath, art: artPath, sides: pieces.map((p: PlatePiece) => ({ side: p.side, slot: p.slot, rest: p.rest, region: { ...p.attachment, opaque: `${p.attachment.opaque.length / 2} points` } })), swagChecks: checks, restRegistration: restReg, rigidMaxPx: rigidMax, framesChecked: frames, headOverlapMaxPx: headMax, headOverlapWorst: headWorst, onShoulder: { follow: spec.follow ?? 1, restCentreInsideJointPx: restInward, centreInsideJointMaxPx: Number(inwardMax.toFixed(2)), maxCentreInsideJointPx: maxInward, jointUncoveredFrames: uncovered, worst: shoulderWorst }, overflow, drawOrderViolations: orderBad, swapPixelDiff: swapDiff, docs: paths, gates, certified, failedGates };
  writeFileSync(join(outDir, `${spec.name}.report.json`), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify({ gates, certified, restRegistration: restReg, rigidMaxPx: rigidMax, headOverlapMaxPx: headMax, centreInsideJointMaxPx: Number(inwardMax.toFixed(2)), jointUncovered: uncovered, swapPixelDiff: swapDiff })}\n`);
  if (!certified) process.stderr.write(`NOT CERTIFIED: failed gates ${failedGates.join(", ")}\n`);
  const exitCode = certified ? 0 : 1;
  if (flags.has("no-render")) return exitCode;

  // --- evidence: 0.4 30 fps GIFs and frame sheets
  const bg = 0xb4b9c2;
  const gifs: [string, string][] = [];
  for (const cfg of ["plates", "plateAlone"]) if (paths[cfg]) for (const clip of CLIPS) gifs.push([cfg, clip]);
  gifs.push(["oneSide", "arm_raise"], ["oneSide", "flex"], ["plates", "plate_swap"]);
  for (const [cfg, clip] of gifs) {
    const r = await renderFrames({ document: paths[cfg] as string, atlas, clip, fps: FPS, scale: 0.4, background: bg });
    writeGif(r, join(outDir, `${spec.name}-${cfg}-${clip}-view040-30fps.gif`));
    const idx = sampleIndices(r.frames.length, 8);
    writePng(join(outDir, `${spec.name}-${cfg}-${clip}-frames-view040.png`), grid(idx.map((i) => ({ image: decodePng((r.frames[i] as { png: Buffer }).png), label: `${cfg} ${clip} f${i}` })), 4));
  }
  process.stdout.write("rendered GIFs and frame sheets\n");
  return exitCode;
}

const stemOf = (path: string) => resolve(path).replace(/\.[cm]?[jt]s$/, "");
if (process.argv[1] && stemOf(process.argv[1]) === stemOf(fileURLToPath(import.meta.url))) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  plateImportCommand(positional, flags).then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exit(1); });
}
