/*
 * Atlas Animator: original implementation.
 *
 * `animator pivot-fit <pose-refs.json> [--apply] [--limits <json>]` (checkpoint 1): fits the
 * chain's pivots and bone lengths to the references' `fit` data (src/tools/surface/pivotFit.ts) and
 * writes `<preset>.pivot-fit.json` beside the preset. `--apply` writes the fitted root pivot into the
 * preset (the root bone's `at`, its parent's `toward`, the girdle centre), re-expresses every
 * chain-relative coordinate for the new chain (the authored canvas geometry is unchanged) and updates
 * the pose-refs `rig` block. The distal pivots stay on the rest art unless `--distal` is given (plan
 * proportions option A: the template's own arm keeps its proportions; the fitted lengths are
 * reported). `--limits '{"bone":[lo,hi]}'` writes fitted limits (the largest drawn values that still
 * solve, chosen by the caller after a build).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ChainFrame } from "../tools/surface/geometry.js";
import { fitArmChain, migrateChain, type FitReference, type Pt, type RefFit } from "../tools/surface/pivotFit.js";

interface Bone { name: string; parent?: string; at?: Pt; toward?: Pt; limits?: [number, number] }
/** JSON in the presets' hand style: a value whose one-line form fits `width` stays on one line. */
export function compactJson(v: unknown, indent = 0, width = 140): string {
  const inline = (x: unknown): string =>
    Array.isArray(x) ? `[${x.map(inline).join(", ")}]` : x !== null && typeof x === "object" ? (Object.keys(x).length ? `{ ${Object.entries(x).map(([k, y]) => `${JSON.stringify(k)}: ${inline(y)}`).join(", ")} }` : "{}") : JSON.stringify(x);
  const one = inline(v);
  if (indent + one.length <= width || v === null || typeof v !== "object") return one;
  const pad = " ".repeat(indent + 2);
  const nl = String.fromCharCode(10);
  if (Array.isArray(v)) return `[${nl}${v.map((x) => pad + compactJson(x, indent + 2, width)).join(`,${nl}`)}${nl}${" ".repeat(indent)}]`;
  return `{${nl}${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${compactJson(x, indent + 2, width)}`).join(`,${nl}`)}${nl}${" ".repeat(indent)}}`;
}
const r1 = (v: number) => Math.round(v * 10) / 10;
const p1 = (p: Pt): Pt => [r1(p[0]), r1(p[1])];

export async function pivotFitCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [specPath] = positional;
  if (!specPath) {
    process.stderr.write("usage: animator pivot-fit <pose-refs.json> [--apply] [--distal] [--limits <json>]\n");
    return 2;
  }
  const spec = JSON.parse(readFileSync(resolve(specPath), "utf8")) as { rig: Record<string, unknown> & { clavicle: string; upper: string; fore: string }; references: FitReference[]; restFit?: RefFit };
  if (!spec.restFit) throw new Error("pivot-fit: the pose-refs file needs `restFit` (the rest drawing's fit data)");
  const presetPath = resolve(dirname(resolve(specPath)), basename(specPath).replace(/\.pose-refs\.json$/, ".preset.json"));
  const preset = JSON.parse(readFileSync(presetPath, "utf8")) as { bones: Bone[]; chain: { bones: string[] }; girdle?: { center: Pt }; skin: Record<string, unknown> & { topology: { joints: { band: number }[]; frameFrom?: number; frameTo?: number } } };
  const bone = (n: string) => preset.bones.find((b) => b.name === n) ?? (() => { throw new Error(`pivot-fit: bone '${n}' missing`); })();
  const upper = bone(spec.rig.upper);
  const fore = bone(spec.rig.fore);
  const fit = fitArmChain(spec.references, spec.restFit, flags.has("distal") ? undefined : { next: fore.at as Pt, end: fore.toward as Pt });
  const clav = bone(spec.rig.clavicle);
  const old = { root: upper.at as Pt, next: fore.at as Pt, end: fore.toward as Pt };
  const f = (v: number) => Number(v.toFixed(2));
  const report = {
    note: " checkpoint 1 pivot fit: root = circle/axis fit of the drawn upper-arm axes and marked elbows; next = circle fit of the wrists in each reference's upper-arm frame. Canvas px.",
    references: { fitted: spec.references.filter((r) => r.use !== "compare" && r.fit).map((r) => r.name), compareOnly: spec.references.filter((r) => r.use === "compare" || !r.fit).map((r) => r.name) },
    old: { ...old, lengths: { proximal: f(Math.hypot(old.next[0] - old.root[0], old.next[1] - old.root[1])), distal: f(Math.hypot(old.end[0] - old.next[0], old.end[1] - old.next[1])) } },
    fitted: { rest: { root: p1(fit.rest.root), next: p1(fit.rest.next), end: p1(fit.rest.end) }, lengths: { proximal: f(fit.lengths.proximal), proximalCircle: fit.lengths.proximalCircle === null ? null : f(fit.lengths.proximalCircle), distal: f(fit.lengths.distal) } },
    residuals: {
      root: { axisRms: f(fit.root.lineRms), elbowCircleRms: f(fit.root.pointRms), axes: fit.root.lineResiduals.map(f), elbows: fit.root.pointResiduals.map(f) },
      next: { wristCircleRms: f(fit.next.pointRms), wrists: fit.next.pointResiduals.map(f) }
    },
    reach: fit.reach ? { meanFistDistance: f(fit.reach.mean), spread: f(fit.reach.spread), restFistDistance: fit.reach.rest === null ? null : f(fit.reach.rest), optionA: fit.reach.rest === null ? null : { scale: f(fit.reach.rest / fit.reach.mean), proximal: f((fit.lengths.proximalCircle ?? fit.lengths.proximal) * (fit.reach.rest / fit.reach.mean)), distal: f(fit.lengths.distal * (fit.reach.rest / fit.reach.mean)) } } : null,
    drawn: fit.drawn.map((d) => ({ ...d, proximal: f(d.proximal), distal: d.distal === null ? null : f(d.distal) })),
    drawnExtremes: { [spec.rig.upper]: fit.extremes.proximal.map(f), [spec.rig.fore]: fit.extremes.distal?.map(f) ?? null, [spec.rig.clavicle]: null },
    limits: { [spec.rig.upper]: upper.limits ?? null, [spec.rig.fore]: fore.limits ?? null, [spec.rig.clavicle]: clav.limits ?? null }
  };
  if (flags.has("apply")) {
    const chainBones = preset.chain.bones.map(bone);
    const pivots = (): Pt[] => [...chainBones.map((b) => b.at as Pt), chainBones[chainBones.length - 1]?.toward as Pt];
    const topo = preset.skin.topology;
    const blends = topo.joints.map((j) => j.band);
    const oldChain = new ChainFrame(pivots(), blends, topo.frameFrom ?? -200, topo.frameTo ?? 600);
    const root = p1(fit.rest.root);
    upper.at = root;
    clav.toward = root;
    if (preset.girdle) preset.girdle.center = root;
    if (flags.has("distal")) {
      upper.toward = p1(fit.rest.next);
      fore.at = p1(fit.rest.next);
      fore.toward = p1(fit.rest.end);
      const hand = preset.bones.find((b) => b.parent === fore.name);
      if (hand) hand.at = p1(fit.rest.end);
    }
    const newChain = new ChainFrame(pivots(), blends, topo.frameFrom ?? -200, topo.frameTo ?? 600);
    migrateChain(preset.skin, oldChain, newChain);
    const limits = typeof flags.get("limits") === "string" ? (JSON.parse(flags.get("limits") as string) as Record<string, [number, number]>) : {};
    for (const [b, l] of Object.entries(limits)) bone(b).limits = l;
    writeFileSync(presetPath, `${compactJson(preset)}\n`);
    spec.rig.shoulder = upper.at;
    spec.rig.elbow = fore.at;
    spec.rig.wrist = fore.toward;
    spec.rig.clavicleBase = clav.at;
    writeFileSync(resolve(specPath), `${compactJson(spec)}\n`);
    Object.assign(report, { applied: { root, distal: flags.has("distal"), limits, newJointS: newChain.jointS.map(f) } });
  }
  const out = join(dirname(presetPath), basename(presetPath).replace(/\.preset\.json$/, ".pivot-fit.json"));
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ old: report.old, fitted: report.fitted, residuals: { root: { axisRms: report.residuals.root.axisRms, elbowCircleRms: report.residuals.root.elbowCircleRms }, next: { wristCircleRms: report.residuals.next.wristCircleRms } }, reach: report.reach, drawnExtremes: report.drawnExtremes })}\n${report.drawn.map((d) => `${d.name}: raise ${d.proximal}${d.distal === null ? "" : ` elbow ${d.distal}`}${d.nominal ? ` (nominal ${JSON.stringify(d.nominal)})` : ""}`).join("\n")}\nwrote ${out}\n`);
  return 0;
}
