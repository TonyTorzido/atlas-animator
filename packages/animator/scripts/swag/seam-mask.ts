// Geometric arm/torso seam mask for the seam-darkness check (polish-seam-ink.py check), generated from a garment
// domain on the committed body rig. The rest footprints of the torso group and of each upper-arm group
// are rasterised on the canvas; the interface between them (the arm/torso seam the runtime draws no line on), smoothed
// along its rows (the mesh boundary zigzags with the strip triangles), is drawn as a WIDTH px band, kept SIL px inside
// the garment silhouette (the silhouette outline band is not a seam).
//   npx tsx scripts/swag/seam-mask.ts <domain.json> <out.png> [--rig <anim.json>] [--outset px]
// Committed outputs: fixtures/garments/seams/<template>-arm-seam-mask.png (simple from stock-cloth, medium from
// medium-gambeson). Run from packages/animator.
import { readFileSync } from "node:fs";
import { writePng } from "../../src/tools/png.js";
import { buildGarmentSurface, dropNecklines } from "../../src/tools/garmentSurface.js";
import { restPositions } from "../../src/tools/garmentPaint.js";

const WIDTH = 6;
const SIL = 8;
const SMOOTH = 15; // rows: running median then mean half-window
/** px the band is moved from the footprint interface toward the sleeve: the drawn arm/torso seam of the arts sits
 * there (calibrated on the simple template against the leather r14 drawn-seam mask, see the README in fixtures/garments/seams). */
const OUTSET_DEFAULT = 6;
const CW = 1086;
const CH = 1448;
const args = process.argv.slice(2);
const rigAt = args.indexOf("--rig");
const outAt = args.indexOf("--outset");
const OUTSET = outAt >= 0 ? Number(args[outAt + 1]) : OUTSET_DEFAULT;
const rig = rigAt >= 0 ? (args[rigAt + 1] as string) : "fixtures/test-rigs/body/template7-shoulder-legs.anim.json";
const flagged = new Set([rigAt, outAt].filter((v) => v >= 0).flatMap((v) => [v, v + 1]));
const [domainPath, outPath] = args.filter((_, i) => !flagged.has(i)) as [string, string];
const raw = JSON.parse(readFileSync(rig, "utf8"));
const domain = dropNecklines(raw, JSON.parse(readFileSync(domainPath, "utf8")));
const C = buildGarmentSurface(raw, domain, { name: "seam", margin: domain.margin, strokeWidth: 10, strokeColor: "000000ff", fabric: [100, 100, 100], hides: ["tank", "tank_armhole", "tank_armhole_r"] });
const a = C.attachment as unknown as { triangles: number[]; groups: Record<string, [number, number][]> };
const rest = restPositions(C);
const T = a.triangles;
const names = Object.keys(a.groups);
const torso = names.find((g) => !/_(upper_arm|forearm)(_r)?$/.test(g)) as string;
const sides = names.filter((g) => /_upper_arm(_r)?$/.test(g));
const foot = new Uint8Array(CW * CH); // 0 none, 1 torso, 2+k upper arm k, 255 other
for (const [g, rs] of Object.entries(a.groups)) {
  const v = g === torso ? 1 : sides.includes(g) ? 2 + sides.indexOf(g) : 255;
  for (const [s, e] of rs) for (let t = s; t < e; t++) {
    const [p0, p1, p2] = [0, 1, 2].map((k) => rest[T[t * 3 + k] as number] as [number, number]) as [[number, number], [number, number], [number, number]];
    const den = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1]))); y <= Math.min(CH - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1]))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0]))); x <= Math.min(CW - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0]))); x++) {
        const l1 = ((x + 0.5 - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (y + 0.5 - p0[1])) / den;
        const l2 = ((p1[0] - p0[0]) * (y + 0.5 - p0[1]) - (x + 0.5 - p0[0]) * (p1[1] - p0[1])) / den;
        if (l1 < -0.02 || l2 < -0.02 || l1 + l2 > 1.02) continue;
        if (!foot[y * CW + x] || v === 1) foot[y * CW + x] = v; // the torso is drawn under the sleeves: keep torso where both
      }
  }
}
// distance inside the whole footprint (chamfer), for the SIL clearance
const din = new Float32Array(CW * CH).fill(0);
for (let i = 0; i < CW * CH; i++) din[i] = foot[i] ? 1e9 : 0;
for (const pass of [0, 1]) for (let yy = 0; yy < CH; yy++) for (let xx = 0; xx < CW; xx++) {
  const y = pass ? CH - 1 - yy : yy;
  const x = pass ? CW - 1 - xx : xx;
  const i = y * CW + x;
  if (!din[i]) continue;
  const st = pass ? 1 : -1;
  for (const [dx, dy, w] of [[st, 0, 1], [0, st, 1], [st, st, 1.414], [-st, st, 1.414]] as const) {
    const X = x + dx;
    const Y = y + dy;
    const v = X < 0 || Y < 0 || X >= CW || Y >= CH ? w : (din[Y * CW + X] as number) + w;
    if (v < (din[i] as number)) din[i] = v;
  }
}
const out = { width: CW, height: CH, data: new Uint8Array(CW * CH * 4) };
const report: string[] = [];
sides.forEach((_, k) => {
  // per row: mean x of torso texels 4-adjacent to this sleeve (the interface)
  const rows = new Map<number, number>();
  for (let y = 1; y < CH - 1; y++) {
    let s = 0;
    let n = 0;
    for (let x = 1; x < CW - 1; x++) {
      const i = y * CW + x;
      if (foot[i] !== 1) continue;
      if ([i - 1, i + 1, i - CW, i + CW].some((j) => foot[j] === 2 + k)) { s += x; n++; }
    }
    if (n) rows.set(y, s / n);
  }
  const ys = [...rows.keys()].sort((p, q) => p - q);
  const med = ys.map((y) => { const w = ys.filter((z) => Math.abs(z - y) <= SMOOTH).map((z) => rows.get(z) as number).sort((p, q) => p - q); return w[Math.floor(w.length / 2)] as number; });
  const sm = ys.map((y, i) => { let s = 0; let n = 0; ys.forEach((z, j) => { if (Math.abs(z - y) <= SMOOTH) { s += med[j] as number; n++; } }); return [y, s / n] as [number, number]; });
  // toward the sleeve: the side of the interface the sleeve footprint lies on
  let sx = 0;
  let sn = 0;
  for (let i = 0; i < CW * CH; i++) if (foot[i] === 2 + k) { sx += i % CW; sn++; }
  const ix = sm.reduce((t, [, x]) => t + x, 0) / Math.max(1, sm.length);
  const dir = sn && sx / sn < ix ? -1 : 1;
  let px = 0;
  for (const [y, cx] of sm.map(([y, x]) => [y, x + dir * OUTSET] as [number, number])) for (let x = Math.round(cx - WIDTH / 2); x < Math.round(cx - WIDTH / 2) + WIDTH; x++) {
    const i = y * CW + x;
    if ((din[i] as number) <= SIL) continue;
    out.data.set([255, 255, 255, 255], i * 4);
    px++;
  }
  report.push(`${sides[k]}: rows ${ys[0]}-${ys[ys.length - 1]}, ${px} px`);
});
for (let i = 0; i < CW * CH; i++) if (!out.data[i * 4]) out.data[i * 4 + 3] = 255;
writePng(outPath, out);
console.log(domainPath, "->", outPath, report.join("; "));
