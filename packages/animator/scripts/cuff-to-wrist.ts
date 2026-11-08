/*
 * Atlas Animator: every
 * sleeve's cuff hem sits on the wrist dip, square to the forearm. For each forearm cuff cut of the given
 * domains (a cuff on a limb group whose bone carries the extremity, the fist), the cut moves onto the line
 * through the bare body's wrist dip (tools/cuffGap.ts wristDip, measured at rest) perpendicular to the
 * extremity bone: same point count, evenly spaced, the ends walked to the limb group's edge, first point on
 * the same side as before. The cut topology is unchanged (position and angle only). The garment's limb slot
 * draws over the fist (tools/garmentSurface.ts), so the hem overlaps the wrist and the hand comes out under it.
 * Both arms use the average of the domain's measured dips (the per-arm difference, a few px, is pixel noise),
 * so the sleeves stay mirror-symmetric. Re-running keeps the original `from` (the art's cut) recorded by the first run.
 *   npx tsx scripts/cuff-to-wrist.ts fixtures/garments/<a>.domain.json [...]
 * Writes each domain in place and records the move under source.cuffToWrist.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnimDocument } from "../src/core/formatLoader.js";
import { Skeleton } from "../src/core/skeleton.js";
import { atlasPackSchema } from "../src/core/atlasPack.js";
import { readPng } from "../src/tools/png.js";
import { texturesFromAtlas } from "../src/tools/validate.js";
import { softRender } from "../src/tools/softRender.js";
import { materialAt, materialRest, skinData, type GarmentDomain } from "../src/tools/garmentSurface.js";
import { sleevedArms, wristDip } from "../src/tools/cuffGap.js";

type Pt = [number, number];
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RIG = join(HERE, "../fixtures/test-rigs/body/template7-shoulder-legs.anim.json");
const raw = JSON.parse(readFileSync(RIG, "utf8"));
const pack = atlasPackSchema.parse(JSON.parse(readFileSync(RIG.replace(/\.anim\.json$/, ".atlas.json"), "utf8")));
const tex = texturesFromAtlas(pack, new Map(pack.pages.map((p) => [p.file, readPng(join(dirname(RIG), p.file))])) as any);
const sk = new Skeleton(loadAnimDocument({ ...raw, animations: {} }));
sk.setActiveSkins([Object.keys(raw.skins)[0] as string]);
sk.setToSetupPose();
sk.updateWorldTransform("none");
const ox = raw.canvas.originX as number;
const oy = raw.canvas.originY as number;
const W = raw.canvas.width ?? 1086;
const H = raw.canvas.height ?? 1448;
const ids = { topSlot: softRender(sk, tex, { width: W, height: H, left: -ox, top: -oy, ids: true }).topSlot as Int16Array, width: W, height: H, left: -ox, top: -oy };

for (const path of process.argv.slice(2)) {
  const domain: GarmentDomain = JSON.parse(readFileSync(path, "utf8"));
  const sd = skinData(raw, domain.skin);
  const moved: Record<string, unknown>[] = [];
  const prevMoved = new Map<string, any>((((domain as any).source?.cuffToWrist?.moved ?? []) as any[]).map((m) => [m.cut, m]));
  const cuffArms = domain.cuts.filter((c) => c.kind === "cuff" && c.groups.length === 1).flatMap((c) => sleevedArms(raw, c.groups));
  const dips = cuffArms.map((arm) => wristDip(sk, ids, arm).uDip);
  const uDip = dips.reduce((a, b) => a + b, 0) / dips.length;
  domain.cuts = domain.cuts.map((c) => {
    if (c.kind !== "cuff" || c.groups.length !== 1) return c;
    const arm = sleevedArms(raw, c.groups)[0];
    if (!arm) return c;
    const hb = sk.getBone(arm.handBone);
    const at = (v: number): Pt => { const w = hb.localToWorld(uDip, v, { x: 0, y: 0 }); return [w.x + ox, w.y + oy]; };
    const inside = (v: number) => materialAt(sd, at(v), c.groups) !== null;
    if (!inside(0)) throw new Error(`${path} ${c.name}: the dip centre is off ${c.groups.join(",")}`);
    const walk = (dir: 1 | -1) => { let v = 0; while (Math.abs(v) < 120 && inside(v + dir * 0.25)) v += dir * 0.25; return v; };
    const vA = walk(1);
    const vB = walk(-1);
    // keep the cut's direction: its first point stays on the same side of the forearm axis
    const first = materialRest(sd, c.points[0] as any);
    const fl = { x: 0, y: 0 };
    hb.worldToLocal(first[0] - ox, first[1] - oy, fl);
    const [v0, v1] = fl.y >= 0 ? [vA, vB] : [vB, vA];
    const n = c.points.length;
    const pts = Array.from({ length: n }, (_, i) => at(v0 + ((v1 - v0) * i) / (n - 1)));
    const points = pts.map((p) => {
      const mp = materialAt(sd, p, c.groups);
      if (!mp) throw new Error(`${path} ${c.name}: point ${p.map((x) => x.toFixed(1))} leaves ${c.groups.join(",")}`);
      return mp;
    });
    const from = prevMoved.get(c.name)?.from ?? [first.map(Math.round), materialRest(sd, c.points[n - 1] as any).map(Math.round)];
    moved.push({ cut: c.name, uDip, uDipMeasured: wristDip(sk, ids, arm).uDip, from, to: [pts[0]?.map(Math.round), pts[n - 1]?.map(Math.round)] });
    return { ...c, points };
  });
  if (!moved.length) { process.stdout.write(`${path}: no forearm cuff\n`); continue; }
  (domain as any).source = { ...((domain as any).source ?? {}), cuffToWrist: { rule: "scripts/cuff-to-wrist.ts: forearm cuff cuts on the bare wrist dip (tools/cuffGap.ts wristDip at rest, both arms at their average), square to the extremity bone, ends at the limb edge", moved } };
  writeFileSync(path, `${JSON.stringify(domain, null, 1)}\n`);
  process.stdout.write(`${path}: ${JSON.stringify(moved)}\n`);
}
