/**
 *: the runtime silhouette
 * of a garment domain at rest, for art edge-fit passes (scripts/swag/fit-sleeve-fill.py). Builds the surface
 * the importer builds (cli/garmentImport.ts: the domain with its committed details, necklines dropped) and
 * writes, per boundary anchor with an offset vertex: the rest point (canvas = art px), the outward unit
 * direction, the distance the importer's silhouette check measures the art against (margin + half the
 * stroke: tools/garmentPaint.ts silhouetteResidual) and the anchor's group.
 *   npx tsx scripts/garment-edge.ts <rig.anim.json> <domain.json> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildGarmentSurface, dropNecklines, type GarmentDomain } from "../src/tools/garmentSurface.js";
import { restPositions } from "../src/tools/garmentPaint.js";

const [rigPath, domainPath, outPath] = process.argv.slice(2) as [string, string, string];
if (!rigPath || !domainPath || !outPath) {
  process.stderr.write("usage: garment-edge.ts <rig.anim.json> <domain.json> <out.json>\n");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(rigPath, "utf8"));
const domain = dropNecklines(raw, JSON.parse(readFileSync(domainPath, "utf8")) as GarmentDomain);
const skinKey = Object.keys(raw.skins)[0] as string;
const skinEntry = Object.entries(raw.skins[skinKey].attachments as Record<string, Record<string, any>>)
  .flatMap(([slot, byName]) => Object.entries(byName).map(([an, a]) => ({ slot, an, a })))
  .filter((e) => e.a.type === "mesh" && !e.a.embed && e.a.groups)
  .sort((x, y) => Object.keys(y.a.groups).length - Object.keys(x.a.groups).length)[0];
const bodyContour = Object.values((raw.skins[skinKey].contours?.[skinEntry?.slot ?? ""] ?? {}) as Record<string, any>)[0];
const strokeWidth = (bodyContour?.width as number | undefined) ?? 10;
const C = buildGarmentSurface(raw, domain, { name: "edge", margin: domain.margin, strokeWidth, strokeColor: "000000ff", fabric: [0, 0, 0], hides: [] });
const rest = restPositions(C);
const runs = C.runs.map((run) => ({
  cyclic: run.cyclic,
  anchors: run.anchors.flatMap((v, i) => {
    const o = run.outer[i] as number;
    if (o === v) return [];
    const p = rest[v] as [number, number];
    const q = rest[o] as [number, number];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [{ i, p, n: [(q[0] - p[0]) / l, (q[1] - p[1]) / l], target: Math.abs(run.dAt[i] as number) + strokeWidth / 2, group: run.cellGroup[Math.min(i, run.cellGroup.length - 1)] }];
  })
}));
writeFileSync(outPath, `${JSON.stringify({ strokeWidth, runs })}\n`);
process.stdout.write(`${outPath}: ${runs.length} runs, ${runs.reduce((s, r) => s + r.anchors.length, 0)} anchors\n`);
