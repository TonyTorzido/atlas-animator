/*
 * Atlas Animator: original implementation.
 *
 * Writes a built surface: the document (with correctives and sweep clips), an atlas-pack@1 page
 * of its fill textures and rigid regions, and an SVG view of the authored source (silhouette,
 * garment paths, fills and contour spans) for review.
 */
import { bandData, measureContacts, type ContactBand } from "./contacts.js";
import { validationCompanion } from "./validationCompanion.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadAnimDocument } from "../../core/formatLoader.js";
import type { AnimDocument } from "../../core/format.js";
import { readPng, writePng } from "../png.js";
import type { RgbaImage } from "../image.js";
import { buildSurface, type BuiltSurface } from "./build.js";
import { SurfaceSolver } from "./solver.js";
import { seedCorrectives, sweepClips, type BakeReport, type Pose } from "./correctives.js";
import type { PoseTarget } from "./solver.js";
import { pointInPolygon, samplePath, type FillImage, type Pt } from "./geometry.js";
import type { SurfacePreset } from "./preset.js";
import { reachAlong, resolvePoseLimits, type PoseLimit } from "./limits.js";

export interface SurfaceRig {
  built: BuiltSurface;
  document: AnimDocument;
  raw: Record<string, unknown>;
  textures: Map<string, RgbaImage>;
  frames: Record<string, Pose[]>;
  report: string[];
  /** Pass 3b: the surface solver, the bake report and the solved target of every sweep frame. */
  solver: SurfaceSolver;
  bake: BakeReport;
  targets: Record<string, PoseTarget[]>;
  /** Rig build wall time (ms): surface, target solve, bake, sweep targets. */
  buildMs: number;
  /** Resolved combined pose limits (pass 3d-1) and the sweep frames they removed. */
  limits: PoseLimit[];
  /** Clip-only limits (preset `scope: "clips"`): in the document's poseLimits, never a build bound. */
  clipLimits: PoseLimit[];
  /** Measured contact bands (preset `gates.clearance.contacts`), also in the document. */
  contacts?: ContactBand[];
  clipped: Record<string, number>;
}

/**
 * Side patches with a width range (pass 3b): the shortest transition in the declared
 * range whose solved targets reach both root limits (every limit pose solvable: validity, boundary,
 * area). The search runs the real solver, not a pure-rotation blend; when no ratio is feasible the
 * best one (highest worst determinant) is kept and reported infeasible.
 */
export function chooseExtents(preset: SurfacePreset, poseLimits: readonly PoseLimit[] = []): { built: BuiltSurface; solver: SurfaceSolver; search: string[] } {
  const ranged = preset.skin.regions.patches.filter((p) => typeof p.extent === "object" && p.extent !== null);
  const tolerance = (0.25 * preset.figureHeight) / preset.gamePixels;
  const tryRatio = (ratio: number | null) => {
    const copy: SurfacePreset = ratio === null ? preset : { ...preset, skin: { ...preset.skin, regions: { ...preset.skin.regions, patches: preset.skin.regions.patches.map((p) => (ranged.includes(p) ? { ...p, extent: { width: [Math.max(ratio, (p.extent as { width: [number, number] }).width[0]), Math.max(ratio, (p.extent as { width: [number, number] }).width[0])] as [number, number] } } : p)) } } };
    const built = buildSurface(copy);
    const solver = new SurfaceSolver(built, { silhouette: tolerance });
    const root = preset.chain.bones[0] as string;
    const limits = (preset.bones.find((b) => b.name === root)?.limits ?? [0, 0]).map((a) => reachAlong(poseLimits, root, a)).filter((a) => a !== 0);
    const results = limits.map((a) => solver.solve({ [root]: a }));
    return { built, solver, ok: results.every((r) => r.ok), min: Math.min(...results.map((r) => r.minRatio)), why: results.filter((r) => !r.ok).map((r) => r.reason.split(";")[0]).join("; ") };
  };
  if (!ranged.length) {
    const r = tryRatio(null);
    return { built: r.built, solver: r.solver, search: [] };
  }
  const lo = Math.min(...ranged.map((p) => (p.extent as { width: [number, number] }).width[0]));
  const hi = Math.max(...ranged.map((p) => (p.extent as { width: [number, number] }).width[1]));
  const search: string[] = [];
  let best: (ReturnType<typeof tryRatio> & { ratio: number }) | null = null;
  for (let j = 0; j <= 7; j++) {
    const ratio = Number((lo + ((hi - lo) * j) / 7).toFixed(4));
    const r = { ...tryRatio(ratio), ratio };
    search.push(`${ratio} W: ${r.ok ? "feasible" : `infeasible (${r.why})`}`);
    if (!best || (r.ok && !best.ok) || (r.ok === best.ok && r.min > best.min)) best = r;
    if (r.ok) break;
  }
  const pick = best as NonNullable<typeof best>;
  for (const p of pick.built.patches) {
    if (!ranged.some((r) => r.name === p.name)) continue;
    p.feasible = pick.ok;
    p.minBlendRatio = Number(pick.min.toFixed(3));
  }
  return { built: pick.built, solver: pick.solver, search };
}

/** The contour faders (preset contour `fade`) as document driven sets: the fader slot's alpha keyed on its driver bone. */
export function fadeDrivenSets(built: Pick<BuiltSurface, "fades">): { name: string; bone: string; channel: "rotation"; alphaOr?: string; keys: { at: number; deform: Record<string, never>; drawOrder: never[]; attachments: Record<string, never>; alpha: Record<string, number> }[] }[] {
  return built.fades.map((f) => ({ name: f.name, bone: f.bone, channel: "rotation" as const, ...(f.alphaOr ? { alphaOr: f.alphaOr } : {}), keys: f.keys.map((k) => ({ at: k.at, deform: {}, drawOrder: [], attachments: {}, alpha: { [f.slot]: k.alpha } })) }));
}

/** Builds the surface, seeds correctives and adds the sweep clips. `presetDir` resolves region images. */
export function buildRig(preset: SurfacePreset, presetDir: string): SurfaceRig {
  const started = Date.now();
  // Combined pose limits first (their auto form samples the plain surface's posed parts).
  const resolved = resolvePoseLimits(buildSurface(preset), presetDir);
  const limitReport = resolved.report;
  const limits = resolved.limits.filter((l) => l.scope !== "clips");
  const clipLimits = resolved.limits.filter((l) => l.scope === "clips");
  const { built, solver: chosen, search } = chooseExtents(preset, limits);
  const { document, report, bake, solver } = seedCorrectives(built, chosen, limits);
  if (search.length) report.unshift(`inner transition search (solver, both root limits): ${search.join("; ")}`);
  report.unshift(...limitReport);
  const contacts = measureContacts(built, loadAnimDocument({ ...document, animations: {} }), limits);
  for (const b of contacts) report.push(`contact band ${b.name} (${b.pair.join(" vs ")}): ${b.cells.length} of ${b.sampled} ${b.x} x ${b.y} samples`);
  const { clips, frames, clipped } = sweepClips(built, 30, limits, contacts);
  const cut = Object.entries(clipped).filter(([, n]) => n > 0);
  if (cut.length) report.push(`sweeps clipped to the pose limits: ${cut.map(([k, n]) => `${k} -${n} frames`).join(", ")}`);
  const targets: Record<string, PoseTarget[]> = {};
  for (const [name, poses] of Object.entries(frames)) targets[name] = solver.along(poses);
  const fadeSets = fadeDrivenSets(built);
  const raw = { ...document, ...(fadeSets.length ? { driven: [...((document as unknown as { driven?: unknown[] }).driven ?? []), ...fadeSets] } : {}), ...(limits.length + clipLimits.length ? { poseLimits: [...limits, ...clipLimits].map((l) => ({ name: l.name, x: l.x, y: l.y, ...(l.plus ? { plus: l.plus } : {}), polygon: l.polygon })) } : {}), ...(contacts.length ? { contactBands: bandData(contacts) } : {}), animations: clips };
  const textures = new Map<string, RgbaImage>(built.images as Map<string, FillImage>);
  for (const region of preset.regions) {
    const source = readPng(resolve(presetDir, region.image));
    const [x0, y0, w, h] = region.crop;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (region.keep && !pointInPolygon([x0 + x + 0.5, y0 + y + 0.5], region.keep)) continue;
        const s = ((y0 + y) * source.width + x0 + x) * 4;
        data.set(source.data.subarray(s, s + 4), (y * w + x) * 4);
      }
    }
    textures.set(region.texture, { width: w, height: h, data });
  }
  report.unshift(`skin: ${built.skin.points.length} vertices (${built.skin.hull} hull), ${built.skin.triangles.length / 3} triangles, groups ${JSON.stringify(built.skin.groups)}, ${built.partition.length} partition vertices`);
  for (const g of built.garments) report.push(`garment ${g.slot}: ${g.points.length} vertices, ${g.triangles.length / 3} triangles`);
  const buildMs = Date.now() - started;
  report.push(`rig build ${(buildMs / 1000).toFixed(1)} s (offline, at rig build time)`);
  return { built, document: loadAnimDocument(raw), raw, textures, frames, report, solver, bake, targets, buildMs, limits, clipLimits, clipped, contacts };
}

/** Shelf-packs the textures onto one page; returns the atlas manifest. */
export function writeAtlas(textures: Map<string, RgbaImage>, dir: string, name: string): string {
  const pad = 2;
  const entries = [...textures.entries()].sort((a, b) => b[1].height - a[1].height);
  const pageWidth = Math.max(512, ...entries.map(([, i]) => i.width + 2 * pad));
  let x = 0;
  let y = 0;
  let shelf = 0;
  const regions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [path, image] of entries) {
    if (x + image.width + pad > pageWidth) {
      x = 0;
      y += shelf + pad;
      shelf = 0;
    }
    regions[path] = { x: x + pad, y: y + pad, width: image.width, height: image.height };
    x += image.width + pad;
    shelf = Math.max(shelf, image.height + pad);
  }
  const pageHeight = y + shelf + pad;
  const page = { width: pageWidth, height: pageHeight, data: new Uint8Array(pageWidth * pageHeight * 4) };
  for (const [path, image] of entries) {
    const r = regions[path] as { x: number; y: number };
    for (let row = 0; row < image.height; row++) page.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((r.y + row) * pageWidth + r.x) * 4);
  }
  const file = `${name}.atlas.png`;
  writePng(join(dir, file), page);
  const manifest = join(dir, `${name}.atlas.json`);
  writeFileSync(manifest, `${JSON.stringify({ format: "atlas-pack@1", scale: 1, pages: [{ file, width: pageWidth, height: pageHeight, regions }] }, null, 2)}\n`);
  return manifest;
}

export function sourceSvg(rig: SurfaceRig): string {
  const { built } = rig;
  const p = built.preset;
  const poly = (pts: Pt[], attrs: string) => `<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" ${attrs}/>`;
  const line = (pts: Pt[], attrs: string) => `<polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" fill="none" ${attrs}/>`;
  const parts: string[] = [];
  parts.push(poly(built.skin.points.slice(0, built.skin.hull), `fill="#${p.skin.base}"`));
  for (const f of p.skin.fills) parts.push(`<g clip-path="url(#skin)">${poly(samplePath(f.polygon, built.chain, 2), `fill="#${f.color.slice(0, 6)}"`)}</g>`);
  p.garments.forEach((g, k) => {
    const mesh = built.garments[k];
    if (!mesh) return;
    parts.push(poly(mesh.points.slice(0, mesh.hull), `fill="#${g.base}"`));
    for (const f of g.fills) parts.push(poly(samplePath(f.polygon, built.chain, 2), `fill="#${f.color.slice(0, 6)}"`));
  });
  for (const c of built.contours) {
    const mesh = c.mesh === "skin" ? built.skin : built.garments[p.garments.findIndex((g) => g.name === c.mesh)];
    if (!mesh) continue;
    const spec = [...p.skin.contours, ...p.garments.flatMap((g) => g.contours)].find((s) => s.name === c.name && s.owner === c.owner);
    parts.push(line(c.points.map((i) => mesh.points[i] as Pt), `stroke="#${(spec?.color ?? "000000").slice(0, 6)}" stroke-width="${c.width}" stroke-linejoin="round" data-owner="${c.owner}" data-name="${c.name}"`));
  }
  const clip = `<clipPath id="skin">${poly(built.skin.points.slice(0, built.skin.hull), "")}</clipPath>`;
  const { left, top, right, bottom } = p.frame;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${right - left} ${bottom - top}" width="${right - left}" height="${bottom - top}"><!-- ${p.name}: authored source view (generated from the preset) --><defs>${clip}</defs>${parts.join("\n")}</svg>\n`;
}

export function writeRig(rig: SurfaceRig, dir: string): { document: string; atlas: string } {
  mkdirSync(dir, { recursive: true });
  const name = rig.built.preset.name;
  const document = join(dir, `${name}.anim.json`);
  writeFileSync(document, `${JSON.stringify(rig.raw)}\n`);
  const atlas = writeAtlas(rig.textures, dir, name);
  writeFileSync(join(dir, `${name}.source.svg`), sourceSvg(rig));
  // Validation regions, allowances, exceptions and poses, hash-checked by `animator validate`.
  writeFileSync(join(dir, `${name}.validation.json`), `${JSON.stringify(validationCompanion(rig))}
`);
  mkdirSync(dirname(document), { recursive: true });
  return { document, atlas };
}
