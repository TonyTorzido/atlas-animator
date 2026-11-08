/*
 * Atlas Animator: original implementation.
 *
 * `animator cap-arc-sheet <preset.json> --rig <rig.anim.json> --bone <bone> --at <v,v,...> --out <png>
 * [--crop l,t,r,b] [--refs <dir> --rest <file> --ref-file <pattern with {v}>]`: approval sheet for
 * a declared cap-run shoulder arc, BEFORE it is baked. Per driver value one row: the aligned
 * reference drawing (visual guide only, aligned as in ref-compare), the current rig through the
 * game's Pixi renderer, the skin's procedural target silhouette without the preset's `arc` and with
 * it, and a difference (blue: skin the arc adds, red: skin it removes), each at game size (shown x6
 * nearest) and at 3x (shown x2), cropped to `--crop` (default the preset's `frame`); then the whole
 * limb-top line at 3x over the preset frame (proposed outline black, current target red, the
 * junction-concavity gate's stretch blue). Prints, per value, the junction-concavity gate (worst
 * concave turn over 3 game px, junctionGate.ts) on the current rig (its committed document posed),
 * the current target and the proposed one, and the largest target move. Nothing about the preset
 * is assumed beyond its own data.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodePng, writePng } from "../tools/png.js";
import type { MutableImage, RgbaImage } from "../tools/image.js";
import { grid } from "../tools/review.js";
import { loadPreset, type SurfacePreset } from "../tools/surface/preset.js";
import { buildSurface } from "../tools/surface/build.js";
import { SurfaceSolver } from "../tools/surface/solver.js";
import { Poser } from "../tools/surface/correctives.js";
import { junctionGates, junctionRegions, orientation, windowNetTurns, JUNCTION_WINDOW, type JunctionFinding } from "../tools/surface/junctionGate.js";
import { loadAnimDocument } from "../core/formatLoader.js";
import { renderFrames } from "./render.js";
import { bodyPivots } from "./refCompare.js";

type Pt = [number, number];

/** Skin hull target polygon (free hull vertices on their procedural targets) and the cap runs' vertex ids. */
function targets(preset: SurfacePreset, poses: Record<string, number>[]): { hulls: Pt[][]; capIds: number[]; built: ReturnType<typeof buildSurface> } {
  const built = buildSurface(preset);
  const solver = new SurfaceSolver(built, { silhouette: 1 });
  const H = built.skin.hull;
  const capIds = solver.runs.flatMap((run, ri) => (solver.shapes[ri]?.kind === "cap" ? [run.a, ...run.ids, run.b] : []));
  const hulls = poses.map((pose) => {
    const f = solver.frame(pose);
    return Array.from({ length: H }, (_, i) => (f.springs[i] ?? f.base[i]) as Pt);
  });
  return { hulls, capIds, built };
}

/** Polygon fill (4x4 supersampled coverage) into a window [x0, y0, w, h] of canvas px at `scale`. */
function fill(poly: readonly Pt[], x0: number, y0: number, w: number, h: number, scale: number): Float32Array {
  const W = Math.ceil(w * scale);
  const Hh = Math.ceil(h * scale);
  const cov = new Float32Array(W * Hh);
  const ss = 4;
  for (let py = 0; py < Hh; py++) {
    for (let sy = 0; sy < ss; sy++) {
      const y = y0 + (py + (sy + 0.5) / ss) / scale;
      const xs: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i] as Pt;
        const b = poly[(i + 1) % poly.length] as Pt;
        if ((a[1] <= y) !== (b[1] <= y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let px = 0; px < W; px++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = x0 + (px + (sx + 0.5) / ss) / scale;
          let inside = false;
          for (const c of xs) if (c < x) inside = !inside;
          if (inside) (cov[py * W + px] as number) += 1 / (ss * ss);
        }
      }
    }
  }
  return cov;
}

const image = (W: number, H: number, px: (i: number) => [number, number, number]): MutableImage => {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...px(i), 255], i * 4);
  return { width: W, height: H, data };
};
const zoom = (im: RgbaImage, z: number): MutableImage => {
  const o = { width: im.width * z, height: im.height * z, data: new Uint8Array(im.width * im.height * z * z * 4) };
  for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
    const s = (Math.floor(y / z) * im.width + Math.floor(x / z)) * 4;
    o.data.set(im.data.subarray(s, s + 4), (y * o.width + x) * 4);
  }
  return o;
};
const crop = (im: RgbaImage, x0: number, y0: number, w: number, h: number): MutableImage => {
  const o = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(im.width - 1, Math.max(0, x0 + x));
    const sy = Math.min(im.height - 1, Math.max(0, y0 + y));
    o.data.set(im.data.subarray((sy * im.width + sx) * 4, (sy * im.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return o;
};

/** Largest net turn, degrees, of one kind (`kind` -1 concave, +1 convex) over a `win` canvas px window along a polyline running with the hull's orientation. */
function worstTurn(path: readonly Pt[], orient: number, win: number, kind: number): number {
  let worst = 0;
  const arcs = [0];
  for (let i = 1; i < path.length; i++) arcs.push((arcs[i - 1] as number) + Math.hypot((path[i] as Pt)[0] - (path[i - 1] as Pt)[0], (path[i] as Pt)[1] - (path[i - 1] as Pt)[1]));
  const heading = (i: number) => Math.atan2((path[i + 1] as Pt)[1] - (path[i] as Pt)[1], (path[i + 1] as Pt)[0] - (path[i] as Pt)[0]);
  for (let i = 0; i < path.length - 1; i++) {
    let turn = 0;
    for (let j = i + 1; j < path.length - 1 && (arcs[j] as number) - (arcs[i] as number) <= win; j++) {
      let d = heading(j) - heading(j - 1);
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      turn += d;
      worst = Math.max(worst, (kind * turn * orient * 180) / Math.PI);
    }
  }
  return worst;
}

export async function capArcSheetCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [presetPath] = positional;
  const rigDoc = flags.get("rig");
  const bone = flags.get("bone");
  const at = flags.get("at");
  const out = flags.get("out");
  if (!presetPath || typeof rigDoc !== "string" || typeof bone !== "string" || typeof at !== "string" || typeof out !== "string") {
    process.stderr.write("usage: animator cap-arc-sheet <preset.json> --rig <rig.anim.json> --bone <bone> --at <v,v,...> --out <png> [--crop l,t,r,b] [--refs <dir> --rest <file> --ref-file <pattern with {v}>]\n");
    return 2;
  }
  const values = at.split(",").map(Number);
  const proposed = loadPreset(resolve(presetPath));
  if (!proposed.skin.regions.patches.some((p) => p.arc)) {
    process.stderr.write("cap-arc-sheet: the preset declares no cap `arc`\n");
    return 2;
  }
  const current = JSON.parse(JSON.stringify(proposed)) as SurfacePreset;
  for (const p of current.skin.regions.patches) delete p.arc;
  const poses = values.map((v) => ({ [bone]: v }));
  const now = targets(current, poses);
  const arc = targets(proposed, poses);
  const s1 = proposed.gamePixels / proposed.figureHeight;
  // Crop: `--crop left,top,right,bottom` (canvas px), default the preset's joint `frame`.
  const cropFlag = flags.get("crop");
  const c4 = typeof cropFlag === "string" ? cropFlag.split(",").map(Number) : null;
  const fr = c4 && c4.length === 4 ? { left: c4[0] as number, top: c4[1] as number, right: c4[2] as number, bottom: c4[3] as number } : proposed.frame;
  const [fx, fy, fw, fh] = [fr.left, fr.top, fr.right - fr.left, fr.bottom - fr.top];
  const orient = Math.sign(arc.hulls[0]?.reduce((s, p, i, a) => { const q = a[(i + 1) % a.length] as Pt; return s + p[0] * q[1] - q[0] * p[1]; }, 0) ?? 1);

  // Current rig: one single-key clip per value in a copy of the rig document.
  const raw = JSON.parse(readFileSync(resolve(rigDoc), "utf8")) as { canvas: { width: number; height: number; originX: number; originY: number }; animations?: Record<string, unknown> };
  const atlas = resolve(rigDoc).replace(/\.anim\.json$/, ".atlas.json");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const docPath = resolve(out).replace(/\.png$/, ".anim.json");
  const doc = { ...raw, animations: { ...(raw.animations ?? {}) } } as Record<string, unknown> & { animations: Record<string, unknown> };
  values.forEach((v, i) => (doc.animations[`arc_${i}`] = { duration: 0.1, loop: false, bones: { [bone]: { rotate: [{ time: 0, value: v }] } } }));
  writeFileSync(docPath, JSON.stringify(doc));
  // The current rig's own posed skin hull (its committed document: correctives as baked).
  const rigPoser = new Poser(loadAnimDocument(raw as never), arc.built);
  const rigHulls = poses.map((pose) => {
    rigPoser.pose(pose);
    return rigPoser.vertices(arc.built.skin).slice(0, arc.built.skin.hull);
  });
  const regions = junctionRegions(arc.built);
  const gateText = (fs: readonly JunctionFinding[]) => fs.map((g) => `${g.kind} ${g.excess.toFixed(1)}/${g.cap} deg over rest (${g.deg.toFixed(1)} vs rest ${g.bindDeg.toFixed(1)}) ${g.excess <= g.cap ? "PASS" : "FAIL"} at (${g.at[0].toFixed(0)}, ${g.at[1].toFixed(0)})`).join(", ");
  // Combination sweep (`--combo bone=v,v;bone=v,v`): the gates over every combination with the driver values.
  const comboFlag = flags.get("combo");
  if (typeof comboFlag === "string") {
    // The neck findings are listed by the first combo bone's value (the shrug, on a shoulder rig).
    const comboBone = comboFlag.split(";")[0]?.split("=")[0] ?? bone;
    let combos: Record<string, number>[] = values.map((v) => ({ [bone]: v }));
    for (const part of comboFlag.split(";")) {
      const [b, vs] = part.split("=");
      if (!b || !vs) continue;
      combos = combos.flatMap((c) => vs.split(",").map((x) => ({ ...c, [b]: Number(x) })));
    }
    const prop = targets(proposed, combos);
    const worst = (hulls: readonly (readonly Pt[])[]) => {
      const out = new Map<string, { f: JunctionFinding; pose: string }>();
      hulls.forEach((h, ci) => junctionGates(arc.built, regions, h, combos[ci]).forEach((f) => {
        const cur = out.get(f.kind);
        if (!cur || f.excess > cur.f.excess) out.set(f.kind, { f, pose: JSON.stringify(combos[ci]) });
      }));
      const failing = hulls.map((h, ci) => ({ ci, fs: junctionGates(arc.built, regions, h, combos[ci]).filter((f) => f.excess > f.cap) })).filter((x) => x.fs.length);
      const byKind = (k: string) => failing.filter((x) => x.fs.some((f) => f.kind === k));
      const fails = `junction ${byKind("junction").length} (${byKind("junction").slice(0, 6).map((x) => JSON.stringify(combos[x.ci])).join(" ")}), neck ${byKind("neck").length} (${comboBone} ${[...new Set(byKind("neck").map((x) => combos[x.ci]?.[comboBone]))].join("/")})`;
      return `${fails} of ${hulls.length} poses fail; ${[...out.values()].map(({ f, pose }) => `worst ${f.kind} ${f.excess.toFixed(1)}/${f.cap} at ${pose}`).join("; ")}`;
    };
    const rigCombo = combos.map((pose) => { rigPoser.pose(pose); return rigPoser.vertices(arc.built.skin).slice(0, arc.built.skin.hull); });
    process.stdout.write(`combos (${combos.length}): current rig ${worst(rigCombo)}\ncombos (${combos.length}): proposed ${worst(prop.hulls)}\n`);
  }
  const regionIds = new Set(regions.flatMap((r) => r.ids));
  const { canvas } = raw;
  const renderRig = async (clip: string, scale: number) => {
    const full = decodePng((await renderFrames({ document: docPath, atlas, clip, fps: 30, frames: 1, scale, width: Math.ceil(canvas.width * scale), height: Math.ceil(canvas.height * scale), x: canvas.originX * scale, y: canvas.originY * scale, background: 0xffffff })).frames[0]?.png as Buffer);
    return crop(full, Math.round(fx * scale), Math.round(fy * scale), Math.ceil(fw * scale), Math.ceil(fh * scale));
  };

  // References (optional): aligned to the rest drawing by body pivots, as in ref-compare.
  const refs = flags.get("refs");
  const rest = flags.get("rest");
  const pattern = flags.get("ref-file");
  const restPiv = typeof refs === "string" && typeof rest === "string" ? bodyPivots(decodePng(readFileSync(join(refs, rest)))) : null;
  const reference = (v: number, scale: number): MutableImage | null => {
    if (!restPiv || typeof refs !== "string" || typeof pattern !== "string") return null;
    let im: RgbaImage;
    try { im = decodePng(readFileSync(join(refs, pattern.replace("{v}", String(v))))); } catch { return null; }
    const piv = bodyPivots(im);
    const s = (restPiv.crotch - restPiv.chin) / (piv.crotch - piv.chin);
    const W = Math.ceil(fw * scale);
    const H = Math.ceil(fh * scale);
    return image(W, H, (i) => {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const cx = fx + ((i % W) + (sx + 0.5) / 3) / scale;
        const cy = fy + (Math.floor(i / W) + (sy + 0.5) / 3) / scale;
        const x = Math.min(im.width - 1, Math.max(0, Math.round((cx - restPiv.mid) / s + piv.mid)));
        const y = Math.min(im.height - 1, Math.max(0, Math.round((cy - restPiv.chin) / s + piv.chin)));
        const j = (y * im.width + x) * 4;
        const a = (im.data[j + 3] as number) / 255;
        for (let c = 0; c < 3; c++) (acc[c] as number) += ((im.data[j + c] as number) * a + 255 * (1 - a)) / 9;
      }
      return [Math.round(acc[0] as number), Math.round(acc[1] as number), Math.round(acc[2] as number)];
    });
  };
  const ink = (cov: Float32Array, W: number, H: number) => image(W, H, (i) => { const c = cov[i] as number; return [Math.round(255 - 205 * c), Math.round(255 - 215 * c), Math.round(255 - 220 * c)]; });

  const tiles: { image: RgbaImage; label: string }[] = [];
  const lines: string[] = [];
  for (const [i, v] of values.entries()) {
    const hNow = now.hulls[i] as Pt[];
    const hArc = arc.hulls[i] as Pt[];
    const move = Math.max(...arc.capIds.map((id) => Math.hypot((hArc[id] as Pt)[0] - (hNow[id] as Pt)[0], (hArc[id] as Pt)[1] - (hNow[id] as Pt)[1])));
    const capPath = (h: Pt[]) => arc.capIds.map((id) => h[id] as Pt);
    // The reference drawing's own valley through the junction stretch: rays from the pivot over the
    // stretch's angles, the silhouette's first exit outward from just inside the proposed outline,
    // then the worst concave turn over the gate window (the measure behind `arc.gateByRaise`).
    const refValley = (val: number, h: Pt[]): string => {
      const ref = reference(val, 1);
      const jr = regions.find((r) => r.kind === "junction");
      if (!ref || !jr) return "";
      const pts = jr.ids.map((id) => h[id] as Pt);
      const hullPoly = h.slice(0, arc.built.skin.hull);
      const inside = (q: Pt) => {
        let c = false;
        for (let k = 0, m = hullPoly.length - 1; k < hullPoly.length; m = k++) {
          const A = hullPoly[k] as Pt;
          const B = hullPoly[m] as Pt;
          if ((A[1] > q[1]) !== (B[1] > q[1]) && q[0] < ((B[0] - A[0]) * (q[1] - A[1])) / (B[1] - A[1]) + A[0]) c = !c;
        }
        return c;
      };
      const ink = (x: number, y: number) => {
        const X = Math.round(x - fx);
        const Y = Math.round(y - fy);
        if (X < 0 || Y < 0 || X >= ref.width || Y >= ref.height) return false;
        const k = (Y * ref.width + X) * 4;
        return Math.min(ref.data[k] as number, ref.data[k + 1] as number, ref.data[k + 2] as number) < 225;
      };
      // The drawing's upper silhouette over the stretch's columns: per column the first ink from 35 px
      // above the proposed outline, median-filtered over +-5 columns, in the stretch's walk order.
      const byX = [...pts].sort((p0, p1) => p0[0] - p1[0]);
      const yAt = (x: number) => {
        for (let k = 1; k < byX.length; k++) if (x <= (byX[k] as Pt)[0]) {
          const A = byX[k - 1] as Pt;
          const B = byX[k] as Pt;
          return A[1] + ((B[1] - A[1]) * (x - A[0])) / (B[0] - A[0] || 1);
        }
        return (byX[byX.length - 1] as Pt)[1];
      };
      const x0 = Math.ceil((byX[0] as Pt)[0]);
      const x1 = Math.floor((byX[byX.length - 1] as Pt)[0]) - 3;
      const col: Pt[] = [];
      for (let x = x0; x <= x1; x++) {
        let y = yAt(x) - 35;
        while (!ink(x, y) && y < yAt(x) + 35) y += 0.5;
        col.push([x, y]);
      }
      const med = col.map((c, k) => {
        const ys = col.slice(Math.max(0, k - 5), k + 6).map((q) => q[1]).sort((a, b) => a - b);
        return [c[0], ys[Math.floor(ys.length / 2)] as number] as Pt;
      });
      const line = (pts[0] as Pt)[0] > (pts[pts.length - 1] as Pt)[0] ? med.reverse() : med;
      // Column samples only describe a shallow outline: split where a column steps more than 1.5 px
      // (a steep or vertical edge, the neck or a hanging limb) and measure each shallow piece.
      const pieces: Pt[][] = [[]];
      line.forEach((q, k) => {
        if (k > 0 && Math.abs(q[1] - (line[k - 1] as Pt)[1]) > 1.5) pieces.push([]);
        (pieces[pieces.length - 1] as Pt[]).push(q);
      });
      const o = orientation(h.slice(0, arc.built.skin.hull));
      const win = JUNCTION_WINDOW / s1;
      const worst = Math.max(0, ...pieces.filter((pc) => pc.length > win).flatMap((pc) => windowNetTurns(pc, win).map((t) => (-t * o * 180) / Math.PI)));
      return `reference valley ${worst.toFixed(1)} deg; `;
    };
    void capPath;
    lines.push(`${bone} ${v}: ${refValley(v, hArc)}current rig ${gateText(junctionGates(arc.built, regions, rigHulls[i] as Pt[], { [bone]: v }))}; proposed ${gateText(junctionGates(arc.built, regions, hArc, { [bone]: v }))}; largest target move ${move.toFixed(2)} canvas px (${(move * s1).toFixed(2)} game px)`);
    for (const [scale, tag, z] of [[s1, "game px (x6)", 6], [3 * s1, "3x (x2)", 2]] as const) {
      const W = Math.ceil(fw * scale);
      const H = Math.ceil(fh * scale);
      const cNow = fill(hNow, fx, fy, fw, fh, scale);
      const cArc = fill(hArc, fx, fy, fw, fh, scale);
      const ref = reference(v, scale);
      const diff = image(W, H, (j) => {
        const a = cArc[j] as number;
        const b = cNow[j] as number;
        const base = 255 - 120 * Math.min(a, b);
        return a - b > 0.05 ? [40, 90, 255] : b - a > 0.05 ? [235, 40, 40] : [Math.round(base), Math.round(base), Math.round(base)];
      });
      const row = [
        { image: ref ?? image(W, H, () => [255, 255, 255]), label: `${v} ${tag}\nreference` },
        { image: await renderRig(`arc_${i}`, scale), label: `${v} ${tag}\ncurrent rig` },
        { image: ink(cNow, W, H), label: `${v} ${tag}\ncurrent target` },
        { image: ink(cArc, W, H), label: `${v} ${tag}\nproposed arc` },
        { image: diff, label: `${v} ${tag}\narc vs current` }
      ];
      for (const t of row) tiles.push({ image: z > 1 ? zoom(t.image, z) : t.image, label: t.label });
    }
    // The whole limb-top line at 3x over the preset frame.
    {
      const F = proposed.frame;
      const k3 = 3 * s1 * 2;
      const W = Math.ceil((F.right - F.left) * k3);
      const H = Math.ceil((F.bottom - F.top) * k3);
      const im = image(W, H, () => [255, 255, 255]);
      const plot = (poly: readonly Pt[], color: [number, number, number], r: number, only?: Set<number>) => {
        for (let q = 0; q < poly.length; q++) {
          if (only && !(only.has(q) && only.has((q + 1) % poly.length))) continue;
          const a = poly[q] as Pt;
          const b = poly[(q + 1) % poly.length] as Pt;
          const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * k3) + 1;
          for (let t = 0; t <= steps; t++) {
            const x = ((a[0] + ((b[0] - a[0]) * t) / steps) - F.left) * k3;
            const y = ((a[1] + ((b[1] - a[1]) * t) / steps) - F.top) * k3;
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
              const X = Math.round(x + dx);
              const Y = Math.round(y + dy);
              if (X >= 0 && Y >= 0 && X < W && Y < H) im.data.set(color, (Y * W + X) * 4);
            }
          }
        }
      };
      plot(hNow, [235, 120, 120], 1);
      plot(hArc, [30, 30, 30], 0);
      plot(hArc, [40, 90, 255], 1, regionIds);
      tiles.push({ image: im, label: `${v} 3x (x2) limb-top line\nblack proposed, red current` });
    }
  }
  writePng(resolve(out), grid(tiles, 11, 1));
  writeFileSync(resolve(out).replace(/\.png$/, ".txt"), `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
