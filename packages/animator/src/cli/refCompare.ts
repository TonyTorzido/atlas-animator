/*
 * Atlas Animator: original implementation.
 *
 * `animator ref-compare <pose-refs.json> --refs <dir> --rig <rig.anim.json> --out <dir>` (
 * item 5, pass 3d-1 item 4): compares the rig against pose reference drawings. Report only, not a
 * gate: the drawings are style ground truth, not pixel truth.
 *
 * Per reference (data: the pose-refs JSON): body pivots measured from the image (head midline,
 * chin and crotch on the midline) align it to the rest drawing, which is the rig canvas (scale from
 * chin-to-crotch, translation from the chin; front-facing, no rotation). The hand-marked arm pivots
 * (shoulder, elbow, wrist) give the rig pose: shrug from the clavicle base to the shoulder, raise from
 * the upper arm (minus the shrug), elbow from the forearm against the upper arm, each relative to the
 * rig's setup and clamped to the bone limits. Output: side-by-side sheets (reference | rig through the
 * game's Pixi renderer at the same scale) for the full figure at 3x and a shoulder crop at 3x, and a
 * joint-region silhouette distance (boundary to boundary, both ways, inside a disk around the
 * shoulder on the arm's side of the midline) in canvas and game px.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decodePng, writePng } from "../tools/png.js";
import type { MutableImage, RgbaImage } from "../tools/image.js";
import { grid } from "../tools/review.js";
import { renderFrames } from "./render.js";

type Pt = [number, number];
interface RefSpec { name: string; file: string; shoulder?: Pt; elbow?: Pt; wrist?: Pt; note?: string; use?: "fit" | "compare"; nominal?: Record<string, number>; fit?: { axis?: { at: Pt; dir: Pt }; elbow?: Pt; wrist: Pt } }
interface RefsFile { rest: string; rig: { clavicle: string; upper: string; fore: string; shoulder: Pt; elbow: Pt; wrist: Pt; clavicleBase: Pt }; references: RefSpec[] }

const ang = (a: Pt, b: Pt) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
const norm = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const lum = (im: RgbaImage, x: number, y: number) => {
  const i = (Math.round(y) * im.width + Math.round(x)) * 4;
  const a = (im.data[i + 3] as number) / 255;
  // Composited on white.
  return ((0.3 * (im.data[i] as number) + 0.59 * (im.data[i + 1] as number) + 0.11 * (im.data[i + 2] as number)) * a + 255 * (1 - a));
};

/** Body pivots of a front-facing drawing: head midline (row 400, above any raised fist), chin and crotch on the midline (first dark outline pixel). */
export function bodyPivots(im: RgbaImage): { mid: number; chin: number; crotch: number } {
  const dark = (x: number, y: number) => lum(im, x, y) < 90;
  let l = 0;
  let r = im.width - 1;
  while (l < im.width && !dark(l, 400)) l++;
  while (r > 0 && !dark(r, 400)) r--;
  const mid = (l + r) / 2;
  let chin = 560;
  while (chin < im.height - 1 && !dark(mid, chin)) chin++;
  let crotch = Math.min(im.height - 1, 1150);
  while (crotch > chin && !dark(mid, crotch)) crotch--;
  return { mid, chin, crotch };
}

export async function refCompareCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [specPath] = positional;
  const refs = flags.get("refs");
  const rigDoc = flags.get("rig");
  const out = flags.get("out");
  if (!specPath || typeof refs !== "string" || typeof rigDoc !== "string" || typeof out !== "string") {
    process.stderr.write("usage: animator ref-compare <pose-refs.json> --refs <dir> --rig <rig.anim.json> --out <dir>\n");
    return 2;
  }
  const started = Date.now() - 1000;
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as RefsFile;
  const raw = JSON.parse(readFileSync(resolve(rigDoc), "utf8")) as { canvas: { width: number; height: number; originX: number; originY: number }; bones: { name: string; limits?: [number, number] }[]; animations?: Record<string, unknown> };
  const atlas = resolve(rigDoc).replace(/\.anim\.json$/, ".atlas.json");
  const presetPath = resolve(dirname(resolve(specPath)), basename(specPath).replace(/\.pose-refs\.json$/, ".preset.json"));
  const preset = JSON.parse(readFileSync(presetPath, "utf8")) as { gamePixels: number; figureHeight: number; bones: { name: string; limits?: [number, number] }[] };
  const s1 = preset.gamePixels / preset.figureHeight;
  const k = 3 * s1;
  const limit = (bone: string) => preset.bones.find((b) => b.name === bone)?.limits ?? [-180, 180];
  const clamp = (bone: string, v: number) => Math.min(limit(bone)[1], Math.max(limit(bone)[0], v));
  const { canvas } = raw;
  const restImage = decodePng(readFileSync(join(refs, spec.rest)));
  const restPivots = bodyPivots(restImage);
  const R = spec.rig;
  mkdirSync(resolve(out), { recursive: true });

  // One single-key clip per reference in a copy of the rig document.
  const poses = spec.references.map((ref) => {
    const image = decodePng(readFileSync(join(refs, ref.file)));
    const piv = bodyPivots(image);
    const s = (restPivots.crotch - restPivots.chin) / (piv.crotch - piv.chin);
    const map = (p: Pt): Pt => [(p[0] - piv.mid) * s + restPivots.mid, (p[1] - piv.chin) * s + restPivots.chin];
    // Arm pivots: the reference's `fit` data when it is a fit reference
    // (canvas px; a straight arm's elbow on its drawn axis at the rig's upper-arm length from the
    // fitted shoulder); else hand-marked pivots (reference px, mapped); else the nominal pose.
    const upperLen = Math.hypot(R.elbow[0] - R.shoulder[0], R.elbow[1] - R.shoulder[1]);
    const fromFit = (f: NonNullable<RefSpec["fit"]>): [Pt, Pt, Pt] => {
      if (f.elbow) return [R.shoulder, f.elbow, f.wrist];
      const d = f.axis?.dir ?? [0, -1];
      const l = Math.hypot(d[0], d[1]);
      return [R.shoulder, [R.shoulder[0] - (d[0] / l) * upperLen, R.shoulder[1] - (d[1] / l) * upperLen], f.wrist];
    };
    const marked = ref.fit && ref.use !== "compare" ? fromFit(ref.fit) : ref.shoulder && ref.elbow && ref.wrist ? ([map(ref.shoulder), map(ref.elbow), map(ref.wrist)] as [Pt, Pt, Pt]) : null;
    if (!marked) {
      const nominal = ref.nominal ?? {};
      const pose = { [R.clavicle]: clamp(R.clavicle, nominal[R.clavicle] ?? 0), [R.upper]: clamp(R.upper, nominal[R.upper] ?? 0), [R.fore]: clamp(R.fore, nominal[R.fore] ?? 0) };
      return { ref, image, piv, s, map, shoulder: R.shoulder, pose, measured: { nominal: true, ...nominal } as Record<string, unknown> };
    }
    const [S, E, W] = marked;
    const shrugRaw = norm(ang(R.clavicleBase, S) - ang(R.clavicleBase, R.shoulder));
    const raiseRaw = norm(ang(S, E) - ang(R.shoulder, R.elbow) - clamp(R.clavicle, shrugRaw));
    const elbowRaw = norm(ang(E, W) - ang(S, E) - (ang(R.elbow, R.wrist) - ang(R.shoulder, R.elbow)));
    const pose = { [R.clavicle]: clamp(R.clavicle, shrugRaw), [R.upper]: clamp(R.upper, raiseRaw), [R.fore]: clamp(R.fore, elbowRaw) };
    const round = (v: number) => Number(v.toFixed(1));
    return { ref, image, piv, s, map, shoulder: S, pose: Object.fromEntries(Object.entries(pose).map(([b, v]) => [b, round(v)])), measured: { [R.clavicle]: round(shrugRaw), [R.upper]: round(raiseRaw), [R.fore]: round(elbowRaw) } as Record<string, unknown> };
  });
  const doc = { ...raw, animations: { ...(raw.animations ?? {}) } } as Record<string, unknown> & { animations: Record<string, unknown> };
  for (const p of poses) doc.animations[`ref_${p.ref.name}`] = { duration: 0.1, loop: false, bones: Object.fromEntries(Object.entries(p.pose).map(([b, v]) => [b, { rotate: [{ time: 0, value: v }] }])) };
  const docPath = join(resolve(out), "ref-compare.anim.json");
  writeFileSync(docPath, JSON.stringify(doc));

  const render = async (clip: string, scale: number, background: number | null) =>
    decodePng((await renderFrames({ document: docPath, atlas, clip, fps: 30, frames: 1, scale, width: Math.ceil(canvas.width * scale), height: Math.ceil(canvas.height * scale), x: canvas.originX * scale, y: canvas.originY * scale, background })).frames[0]?.png as Buffer);
  /** The reference resampled into the rig canvas frame at `scale` (3x3 box filter per output pixel). */
  const resample = (p: (typeof poses)[number], scale: number): MutableImage => {
    const w = Math.ceil(canvas.width * scale);
    const h = Math.ceil(canvas.height * scale);
    const img = { width: w, height: h, data: new Uint8Array(w * h * 4) };
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const acc = [0, 0, 0];
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            const cx = (u + (sx + 0.5) / 3) / scale;
            const cy = (v + (sy + 0.5) / 3) / scale;
            const x = Math.min(p.image.width - 1, Math.max(0, Math.round((cx - restPivots.mid) / p.s + p.piv.mid)));
            const y = Math.min(p.image.height - 1, Math.max(0, Math.round((cy - restPivots.chin) / p.s + p.piv.chin)));
            const i = (y * p.image.width + x) * 4;
            const a = (p.image.data[i + 3] as number) / 255;
            for (let c = 0; c < 3; c++) (acc[c] as number) += ((p.image.data[i + c] as number) * a + 255 * (1 - a)) / 9;
          }
        }
        img.data.set([Math.round(acc[0] as number), Math.round(acc[1] as number), Math.round(acc[2] as number), 255], (v * w + u) * 4);
      }
    }
    return img;
  };
  const crop = (im: RgbaImage, x0: number, y0: number, w: number, h: number, zoom: number): MutableImage => {
    const o = { width: w * zoom, height: h * zoom, data: new Uint8Array(w * h * zoom * zoom * 4) };
    for (let y = 0; y < h * zoom; y++) {
      for (let x = 0; x < w * zoom; x++) {
        const sx = Math.min(im.width - 1, Math.max(0, x0 + Math.floor(x / zoom)));
        const sy = Math.min(im.height - 1, Math.max(0, y0 + Math.floor(y / zoom)));
        o.data.set(im.data.subarray((sy * im.width + sx) * 4, (sy * im.width + sx) * 4 + 4), (y * w * zoom + x) * 4);
      }
    }
    return o;
  };

  // Crop framing: the rig covers only part of its canvas (the preset's half body ends at the
  // midline), so the shoulder window is shifted left until its right edge sits at the rig's right
  // extent (rest pose, opaque pixels, + 12 canvas px); the reference is cropped with the same window.
  const restRig = decodePng((await renderFrames({ document: docPath, atlas, clip: null, frames: 1, scale: 1, width: canvas.width, height: canvas.height, x: canvas.originX, y: canvas.originY, background: null })).frames[0]?.png as Buffer);
  let rigRight = 0;
  for (let y = 0; y < restRig.height; y++) for (let x = rigRight; x < restRig.width; x++) if ((restRig.data[(y * restRig.width + x) * 4 + 3] as number) > 0) rigRight = x + 1;
  rigRight = Math.min(canvas.width, rigRight + 12);
  const report: Record<string, unknown>[] = [];
  const allTiles: { image: RgbaImage; label: string }[] = [];
  for (const p of poses) {
    const clip = `ref_${p.ref.name}`;
    const tag = `${p.ref.name}: ${Object.entries(p.pose).map(([b, v]) => `${b} ${v}`).join(", ")}`;
    // Full figure and the shoulder crop at 3x (same scale both sides).
    const ref3 = resample(p, k);
    const rig3 = await render(clip, k, 0xffffff);
    const half = 200;
    const cx = Math.round(Math.max(0, Math.min(p.shoulder[0] - half, rigRight - 2 * half)) * k);
    const cy = Math.round((p.shoulder[1] - half) * k);
    const cw = Math.round(2 * half * k);
    const fullTiles = [
      { image: ref3, label: `reference (aligned)\n3x full` },
      { image: rig3, label: `rig pixi\n3x full` }
    ];
    const cropTiles = [
      { image: crop(ref3, cx, cy, cw, cw, 2), label: `reference\n3x shoulder (x2 nearest)` },
      { image: crop(rig3, cx, cy, cw, cw, 2), label: `rig pixi\n3x shoulder (x2 nearest)` }
    ];
    writePng(join(resolve(out), `${p.ref.name}-full-x3.png`), grid(fullTiles, 2, 1));
    writePng(join(resolve(out), `${p.ref.name}-shoulder-x3.png`), grid(cropTiles, 2, 1));
    allTiles.push({ image: cropTiles[0]?.image as RgbaImage, label: `${p.ref.name}\nreference` }, { image: cropTiles[1]?.image as RgbaImage, label: `${tag.split(": ")[1]}\nrig` });
    // Silhouette distance at canvas scale inside the joint disk, arm side of the midline.
    const ref1 = resample(p, 1);
    const rig1 = await render(clip, 1, null);
    const W = ref1.width;
    const H = ref1.height;
    const inRegion = (x: number, y: number) => Math.hypot(x - p.shoulder[0], y - p.shoulder[1]) <= 160 && x < restPivots.mid - 10;
    const refMask = (x: number, y: number) => Math.min(ref1.data[(y * W + x) * 4] as number, ref1.data[(y * W + x) * 4 + 1] as number, ref1.data[(y * W + x) * 4 + 2] as number) < 245;
    const rigMask = (x: number, y: number) => (rig1.data[(y * rig1.width + x) * 4 + 3] as number) > 127;
    const boundary = (m: (x: number, y: number) => boolean) => {
      const pts: Pt[] = [];
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (inRegion(x, y) && m(x, y) && (!m(x - 1, y) || !m(x + 1, y) || !m(x, y - 1) || !m(x, y + 1))) pts.push([x, y]);
      return pts;
    };
    const a = boundary(refMask);
    const b = boundary(rigMask);
    const nearest = (from: Pt[], to: Pt[]) => from.map((q) => to.reduce((m, t) => Math.min(m, (q[0] - t[0]) ** 2 + (q[1] - t[1]) ** 2), Infinity)).map(Math.sqrt).sort((x, y) => x - y);
    const stats = (d: number[]) => ({ mean: Number((d.reduce((s, v) => s + v, 0) / Math.max(1, d.length)).toFixed(2)), p95: Number((d[Math.floor(d.length * 0.95)] ?? 0).toFixed(2)), max: Number((d[d.length - 1] ?? 0).toFixed(2)) });
    const refToRig = stats(nearest(a, b));
    const rigToRef = stats(nearest(b, a));
    report.push({
      name: p.ref.name,
      note: p.ref.note,
      bodyPivots: { reference: p.piv, rest: restPivots, scale: Number(p.s.toFixed(4)) },
      armPivots: p.ref.shoulder && p.ref.elbow && p.ref.wrist ? { reference: { shoulder: p.ref.shoulder, elbow: p.ref.elbow, wrist: p.ref.wrist }, canvas: { shoulder: p.map(p.ref.shoulder).map((v) => Number(v.toFixed(1))), elbow: p.map(p.ref.elbow).map((v) => Number(v.toFixed(1))), wrist: p.map(p.ref.wrist).map((v) => Number(v.toFixed(1))) } } : p.ref.fit ? { fit: p.ref.fit } : "nominal pose",
      measuredPose: p.measured,
      rigPose: p.pose,
      silhouette: { region: "disk r 160 canvas px around the shoulder pivot, arm side of the midline", boundaryPixels: { reference: a.length, rig: b.length }, canvasPx: { referenceToRig: refToRig, rigToReference: rigToRef }, gamePx: { meanSymmetric: Number((((refToRig.mean + rigToRef.mean) / 2) * s1).toFixed(2)), p95Max: Number((Math.max(refToRig.p95, rigToRef.p95) * s1).toFixed(2)) } }
    });
    process.stdout.write(`${tag} (measured ${JSON.stringify(p.measured)}): silhouette mean ${refToRig.mean}/${rigToRef.mean} p95 ${refToRig.p95}/${rigToRef.p95} canvas px\n`);
  }
  // The combined sheet is rebuilt from this run's rig tiles (overlay review: it once stayed
  // byte-identical to an older run): the stale file goes first, and the rig tiles' content hash is
  // recorded and checked against the per-pose shoulder sheets written above.
  const combined = join(resolve(out), "ref-compare-shoulders-x3.png");
  rmSync(combined, { force: true });
  writePng(combined, grid(allTiles, 4, 1));
  const rigTiles = allTiles.filter((_, i) => i % 2 === 1).map((t) => createHash("sha256").update(t.image.data).digest("hex").slice(0, 16));
  const written = decodePng(readFileSync(combined));
  if (written.width === 0 || statSync(combined).mtimeMs < started) throw new Error("ref-compare: the combined sheet was not rewritten");
  writeFileSync(join(resolve(out), "ref-compare.json"), `${JSON.stringify({ note: "report, not a gate (item 5): drawings are style ground truth, not pixel truth", gameScale: s1, rig: resolve(rigDoc), combinedSheet: { file: "ref-compare-shoulders-x3.png", rigTileSha256: rigTiles }, references: report }, null, 2)}\n`);
  return 0;
}
