/*
 * Atlas Animator: original implementation.
 *
 * Paint the rig from the art (rest fidelity), moved out of cli/legsBody.ts (phase 2b,
 * packages/animator/README.md) so the mirrored body and the full-body (turned side) build
 * share it. The skin and garment textures are canvas projections. Draw items are rasterised at the
 * setup pose in draw order (mesh groups in their slots, regions as rigid quads); the topmost item
 * owns each canvas pixel and takes the art there; texels hidden at rest (skin under a garment) keep
 * the built material, so the bare body and motion still show completed skin. Visible skin hull
 * vertices are first fitted onto the art's outline. Mirror mode only (`farSuffix`): the mirrored
 * side regions (far fists) are re-sampled from the art's own far side and the fist outlines built.
 * The skeleton must be at the setup pose. Mutates `doc` and `textures`; returns the bake report.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Bone } from "../../core/bone.js";
import type { Skeleton } from "../../core/skeleton.js";
import { embedWeights } from "../../core/attachments.js";
import { opaqueOutline } from "../bodyContours.js";
import { distInside, smoothLoop, traceLoops } from "../garmentImport.js";
import type { RgbaImage } from "../image.js";

type V = { x: number; y: number };

export interface PaintFromArtContext {
  doc: any;
  textures: Map<string, RgbaImage>;
  skinKey: string;
  /** Posed at the setup pose (IK off). */
  skeleton: Skeleton;
  /** The approved art on the rig canvas. */
  art: RgbaImage;
  /** World -> canvas, and the canvas -> world axis scales (canvas deltas move vertices). */
  toCanvas: (p: V) => V;
  sx: number;
  sy: number;
  /** Skin meshes whose visible hull is fitted to the art's outline ([slot, attachment]). */
  skinMeshes: readonly (readonly [string, string])[];
  /** Canvas boxes of rigid art regions (no hull fit there). */
  regionBoxes: readonly number[][];
  /** Keep polygons of side regions: limb strokes under them are dropped. */
  keeps: readonly number[][][];
  /** Mirror mode: the rename suffix of the mirrored side (far regions rebaked, fist outlines); null otherwise. */
  farSuffix: string | null;
  /** Contour join reach: this multiple of the rest bridge arc. */
  joinReachScale: number;
}

export function paintFromArt(ctx: PaintFromArtContext): Record<string, number> {
  const { doc, textures, skinKey, skeleton, toCanvas, sx, sy } = ctx;
  const artImg = ctx.art;
  const JOIN_REACH_SCALE = ctx.joinReachScale;
  const B = (n: string): Bone => skeleton.getBone(n);
  const W = (bone: Bone, lx = 0, ly = 0): V => {
    const o = { x: 0, y: 0 };
    bone.localToWorld(lx, ly, o);
    return { x: o.x, y: o.y };
  };
  const bakeReport: Record<string, number> = {};
  const cw0 = doc.canvas.width;
  const ch0 = doc.canvas.height;
    type Item = { slot: string; att: any; tris: number[]; pos: V[]; quad?: boolean };
  const items: Item[] = [];
  const sk0 = doc.skins[skinKey].attachments as Record<string, Record<string, any>>;
  const meshPos = (att: any): V[] => {
    const out: V[] = [];
    const v = att.vertices as number[];
    for (let i = 0; i < v.length; ) {
      const n = v[i++] as number;
      let x = 0;
      let y = 0;
      for (let k = 0; k < n; k++, i += 4) {
        const w = W(B(att.bones[v[i] as number]), v[i + 1] as number, v[i + 2] as number);
        x += w.x * (v[i + 3] as number);
        y += w.y * (v[i + 3] as number);
      }
      out.push(toCanvas({ x, y }));
    }
    return out;
  };
  const raster = (a: V, b: V, c: V, fn: (x: number, y: number, l: [number, number, number]) => void) => {
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(cw0 - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(ch0 - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const l0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / den;
      const l1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 >= -1e-6 && l1 >= -1e-6 && l2 >= -1e-6) fn(x, y, [l0, l1, l2]);
    }
  };
  const owner = new Int32Array(cw0 * ch0).fill(-1);
  const layout = () => {
    items.length = 0;
    owner.fill(-1);
    // The resolved setup draw list: only each slot's active (setup)
    // attachment, mesh draw groups in the slot they name, rigid regions as their posed quads; a
    // piece owns a canvas pixel only where its own texture is opaque there (alpha >= 128).
    const slotBoneOf = (name: string) => (doc.slots as any[]).find((x) => x.name === name)?.bone as string;
    const active = (doc.slots as any[]).flatMap((sl) => {
      const a = sl.attachment ? sk0[sl.name]?.[sl.attachment] : undefined;
      if (!a) return [];
      if (a.type === "mesh") return [{ slot: sl.name as string, att: a, pos: meshPos(a), quad: false }];
      if (a.type === "region") {
        const r = ((a.rotation ?? 0) * Math.PI) / 180;
        const corner = (u: number, v: number) => {
          const lx = u * a.width * (a.scaleX ?? 1);
          const ly = v * a.height * (a.scaleY ?? 1);
          return toCanvas(W(B(slotBoneOf(sl.name)), (a.x ?? 0) + lx * Math.cos(r) - ly * Math.sin(r), (a.y ?? 0) + lx * Math.sin(r) + ly * Math.cos(r)));
        };
        return [{ slot: sl.name as string, att: a, pos: [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)], quad: true }];
      }
      return [];
    });
    for (const slot of doc.slots as any[]) {
      for (const m0 of active) {
        if (m0.quad) {
          if (m0.slot === slot.name) items.push({ slot: slot.name, att: m0.att, tris: [0, 1], pos: m0.pos, quad: true });
          continue;
        }
        const ranges: [number, number][] = m0.att.groups ? (m0.att.groups[slot.name] ?? []) : m0.slot === slot.name ? [[0, m0.att.triangles.length / 3]] : [];
        const tris: number[] = [];
        for (const [a, b] of ranges) for (let t = a; t < b; t++) tris.push(t);
        if (tris.length) items.push({ slot: slot.name, att: m0.att, tris, pos: m0.pos });
      }
    }
    const QUAD = [0, 1, 2, 0, 2, 3];
    const QUV = [0, 0, 1, 0, 1, 1, 0, 1];
    items.forEach((it, k) => {
      const tex = textures.get(it.att.path) as RgbaImage | undefined;
      const tri = it.quad ? QUAD : (it.att.triangles as number[]);
      const uv = it.quad ? QUV : (it.att.uvs as number[]);
      const alphaAt = (idx: number[], l: [number, number, number], flip: boolean) => {
        if (!tex) return 255;
        let u = 0;
        let v = 0;
        idx.forEach((i, j) => { u += (uv[i * 2] as number) * l[j]!; v += (uv[i * 2 + 1] as number) * l[j]!; });
        if (flip) v = 1 - v;
        const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
        const ty = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
        return tex.data[(ty * tex.width + tx) * 4 + 3] as number;
      };
      for (const t of it.tris) {
        const idx = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]] as number[];
        raster(it.pos[idx[0] as number] as V, it.pos[idx[1] as number] as V, it.pos[idx[2] as number] as V, (x, y, l) => {
          // a region's v direction is checked later (vSign): either orientation opaque claims the pixel
          const a = it.quad ? Math.max(alphaAt(idx, l, false), alphaAt(idx, l, true)) : alphaAt(idx, l, false);
          if (a >= 128) owner[y * cw0 + x] = k;
        });
      }
    });
  };
  layout();
  // --- outline fit: every visible skin hull vertex moves onto the centre of the art's
  // outline along its normal (<= HULL_FIT px), on each side independently (the art is not
  // symmetric: the far arm gets its own outline, not the mirror), smoothed along the hull and
  // fading into the interior; uvs follow (canvas projection), contours ride the hull indices.
  const HULL_FIT = 10;
  const regionBoxes = ctx.regionBoxes;
  const inRegion = (p: V) => regionBoxes.some(([a, b, c, d]) => p.x >= (a as number) && p.x <= (c as number) && p.y >= (b as number) && p.y <= (d as number));
  const inkAt = (x: number, y: number) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= artImg.width || py >= artImg.height) return false;
    const o = (py * artImg.width + px) * 4;
    if ((artImg.data[o + 3] as number) < 128) return false;
    return 0.3 * (artImg.data[o] as number) + 0.59 * (artImg.data[o + 1] as number) + 0.11 * (artImg.data[o + 2] as number) < 90;
  };
  const fitReport: Record<string, { moved: number; maxPx: number }> = {};
  const skinMeshes = ctx.skinMeshes.map(([sl, an]) => sk0[sl as string]?.[an as string]).filter(Boolean);
  /** Moves mesh vertices by canvas deltas: every influence by the same world delta; uvs follow the canvas projection. */
  const applyDelta = (att: any, pos: V[], delta: V[]) => {
    const v = att.vertices as number[];
    const tw = att.width as number;
    const th = att.height as number;
    const ox = (pos[0] as V).x - (att.uvs[0] as number) * tw;
    const oy = (pos[0] as V).y - (att.uvs[1] as number) * th;
    let moved = 0;
    let maxPx = 0;
    for (let i = 0, vi = 0; vi < v.length; i++) {
      const n = v[vi++] as number;
      const d = (delta[i] ?? { x: 0, y: 0 }) as V;
      const m = Math.hypot(d.x, d.y);
      if (m > 0.05) { moved++; maxPx = Math.max(maxPx, m); }
      for (let q = 0; q < n; q++, vi += 4) {
        if (m <= 0.05) continue;
        const bone = B(att.bones[v[vi] as number]);
        const wpt = W(bone, v[vi + 1] as number, v[vi + 2] as number);
        const o = { x: 0, y: 0 };
        bone.worldToLocal(wpt.x + d.x * sx, wpt.y + d.y * sy, o);
        v[vi + 1] = +o.x.toFixed(4);
        v[vi + 2] = +o.y.toFixed(4);
      }
      if (m > 0.05) {
        att.uvs[i * 2] = +(((pos[i] as V).x + d.x - ox) / tw).toFixed(6);
        att.uvs[i * 2 + 1] = +(((pos[i] as V).y + d.y - oy) / th).toFixed(6);
      }
    }
    return { moved, maxPx };
  };
  for (const att of skinMeshes) {
    const k = items.findIndex((it) => it.att === att);
    const pos = (items[k] as Item).pos;
    const H = att.hull as number;
    const own = new Set(items.map((it, i) => (it.att === att ? i : -1)).filter((i) => i >= 0));
    const delta: V[] = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < H; i++) {
      const p = pos[i] as V;
      const a = pos[(i - 1 + H) % H] as V;
      const c = pos[(i + 1) % H] as V;
      let nx = -(c.y - a.y);
      let ny = c.x - a.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      // visible at rest: this mesh owns a pixel next to the vertex, and no rigid art region is there
      let vis = false;
      for (let dy = -2; dy <= 2 && !vis; dy++) for (let dx = -2; dx <= 2; dx++) if (own.has(owner[(py + dy) * cw0 + px + dx] as number)) { vis = true; break; }
      if (!vis || inRegion(p)) continue;
      // ink runs along the normal; take the run whose centre is nearest the vertex
      let best: number | null = null;
      let runA: number | null = null;
      for (let t = -HULL_FIT - 6; t <= HULL_FIT + 6.01; t += 0.5) {
        const ink = inkAt(p.x + nx * t, p.y + ny * t);
        if (ink && runA === null) runA = t;
        if ((!ink || t > HULL_FIT + 6) && runA !== null) {
          const cMid = (runA + t - 0.5) / 2;
          if (t - runA >= 3 && Math.abs(cMid) <= HULL_FIT && (best === null || Math.abs(cMid) < Math.abs(best))) best = cMid;
          runA = null;
        }
      }
      if (best !== null) delta[i] = { x: nx * best, y: ny * best };
    }
    // smooth along the hull (one pass)
    for (let pass = 0; pass < 1; pass++) {
      const d0 = delta.slice(0, H).map((d) => ({ ...d }));
      for (let i = 0; i < H; i++) {
        const a = d0[(i - 1 + H) % H] as V;
        const b = d0[i] as V;
        const c = d0[(i + 1) % H] as V;
        delta[i] = { x: 0.25 * a.x + 0.5 * b.x + 0.25 * c.x, y: 0.25 * a.y + 0.5 * b.y + 0.25 * c.y };
      }
    }
    // interior: fade the nearest hull delta over 12 px
    for (let i = H; i < pos.length; i++) {
      let bd = Infinity;
      let bi = -1;
      for (let j = 0; j < H; j++) { const d = Math.hypot((pos[i] as V).x - (pos[j] as V).x, (pos[i] as V).y - (pos[j] as V).y); if (d < bd) { bd = d; bi = j; } }
      const f = Math.max(0, 1 - bd / 12);
      delta[i] = { x: (delta[bi] as V).x * f, y: (delta[bi] as V).y * f };
    }
    const { moved, maxPx } = applyDelta(att, pos, delta);
    fitReport[`${att.path}`] = { moved, maxPx: +maxPx.toFixed(2) };
    // garments embedded in this skin: their bind follows the moved surface (posed = bind at rest)
    for (const g of Object.values(sk0).flatMap((a) => Object.values(a))) {
      if (g.type !== "mesh" || !g.embed || sk0[g.embed.slot]?.[g.embed.attachment] !== att) continue;
      const gpos = meshPos(g);
      const gd: V[] = gpos.map(() => ({ x: 0, y: 0 }));
      (g.embed.vertices as number[]).forEach((vix, k) => {
        const pk = (g.embed.points as unknown[])[k];
        if (typeof pk === "number") { gd[vix] = { ...(delta[pk] as V) }; return; }
        if (!Array.isArray(pk) || pk.length < 5) return;
        const [a0, b0, c0, u, w] = pk as number[];
        const tri = [a0, b0, c0] as number[];
        const bw = embedWeights(u as number, w as number);
        let x = 0;
        let y = 0;
        tri.forEach((t, j) => { x += (delta[t] as V).x * (bw[j] as number); y += (delta[t] as V).y * (bw[j] as number); });
        gd[vix] = { x, y };
      });
      const r = applyDelta(g, gpos, gd);
      fitReport[`${g.path}`] = { moved: r.moved, maxPx: +r.maxPx.toFixed(2) };
    }
  }
  bakeReport.hullFit = fitReport as unknown as number;
  layout();
  // Strokes under a rigid side region (the art fists): contour points whose setup position lies
  // inside the region's keep polygon are dropped (runs split), so no stroke end can peek out from
  // under the fist in motion; the region's own art outline is the visible edge there.
  const pip = (p: V, poly: readonly (readonly number[])[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i] as [number, number];
      const [xj, yj] = poly[j] as [number, number];
      if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const keeps = ctx.keeps;
  let strokePointsDropped = 0;
  // the ends of runs cut by a region (the wrist): the region's runtime outline starts there
  const regionEnds: { pos: V; dir: V; width: number; color: string; slot: string; name: string; end: "start" | "end" }[] = [];
  for (const [slot, byName] of Object.entries((doc.skins[skinKey].contours ?? {}) as Record<string, Record<string, any>>)) {
    for (const [name, c] of Object.entries(byName)) {
      const att = sk0[c.mesh?.slot]?.[c.mesh?.attachment];
      const it = items.find((x) => x.att === att);
      if (!it) continue;
      const runs: number[][] = [[]];
      for (const p of c.points as number[]) {
        if (keeps.some((k) => pip(it.pos[p] as V, k))) { strokePointsDropped++; if ((runs[runs.length - 1] as number[]).length) runs.push([]); }
        else (runs[runs.length - 1] as number[]).push(p);
      }
      const kept = runs.filter((r) => r.length >= 2);
      if (kept.length === 1 && kept[0]?.length === c.points.length) continue;
      const pts0 = c.points as number[];
      for (const r of kept) {
        const i0 = pts0.indexOf(r[0] as number);
        const i1 = pts0.indexOf(r[r.length - 1] as number);
        // the end and its outward tangent (toward the cut), so the region's outline leaves it tangent
        const runName = kept.indexOf(r) ? `${name}_f${kept.indexOf(r)}` : name;
        const endOf = (e: number, prev: number, end: "start" | "end") => {
          const p = it.pos[e] as V;
          const q = it.pos[prev] as V;
          const l = Math.hypot(p.x - q.x, p.y - q.y) || 1;
          return { pos: p, dir: { x: (p.x - q.x) / l, y: (p.y - q.y) / l }, width: c.width, color: c.color, slot, name: runName, end };
        };
        if (i0 > 0) regionEnds.push(endOf(r[0] as number, r[1] as number, "start"));
        if (i1 < pts0.length - 1) regionEnds.push(endOf(r[r.length - 1] as number, r[r.length - 2] as number, "end"));
      }
      delete byName[name];
      kept.forEach((r, i) => (byName[i ? `${name}_f${i}` : name] = { ...c, points: r }));
    }
  }
  bakeReport.strokePointsUnderRegions = strokePointsDropped;
  // regions own their opaque art pixels (the head, the fists) over everything drawn before them
  // Garment strokes drawn above the skin cover skin texels at rest: those texels keep the built
  // skin (no garment ink from the art), so the bare body shows no garment lines and the dressed
  // rest is unchanged (the stroke covers them there).
  const strokeCover = new Int32Array(cw0 * ch0).fill(-1);
  {
    const slotIndex = (name: string) => (doc.slots as any[]).findIndex((x) => x.name === name);
    for (const [cslot, byName] of Object.entries((doc.skins[skinKey].contours ?? {}) as Record<string, Record<string, any>>)) {
      const si = slotIndex(cslot);
      for (const c of Object.values(byName)) {
        const att = sk0[c.mesh?.slot]?.[c.mesh?.attachment];
        if (!att?.embed) continue;
        const it = items.find((x) => x.att === att);
        if (!it) continue;
        const r = (c.width as number) / 2 + 3; // the art line plus its anti-aliased rim
        const pts = (c.points as number[]).map((q) => it.pos[q] as V);
        for (let j = 0; j + 1 < pts.length; j++) {
          const a0 = pts[j] as V;
          const b0 = pts[j + 1] as V;
          const x0 = Math.max(0, Math.floor(Math.min(a0.x, b0.x) - r));
          const x1 = Math.min(cw0 - 1, Math.ceil(Math.max(a0.x, b0.x) + r));
          const y0 = Math.max(0, Math.floor(Math.min(a0.y, b0.y) - r));
          const y1 = Math.min(ch0 - 1, Math.ceil(Math.max(a0.y, b0.y) + r));
          const dx = b0.x - a0.x;
          const dy = b0.y - a0.y;
          const ll = dx * dx + dy * dy || 1;
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const t = Math.max(0, Math.min(1, ((x + 0.5 - a0.x) * dx + (y + 0.5 - a0.y) * dy) / ll));
            const ex = a0.x + dx * t - (x + 0.5);
            const ey = a0.y + dy * t - (y + 0.5);
            if (ex * ex + ey * ey <= r * r) strokeCover[y * cw0 + x] = Math.max(strokeCover[y * cw0 + x] as number, si);
          }
        }
      }
    }
  }
  // Garment ink belongs to the garment: the art's dark
  // line pixels within GARMENT_INK_REACH px of a garment's rest coverage are the garment's painted
  // outline even where the rig's garment mesh stops short of them, so skin texels there keep the
  // built skin (the bare body and a removed garment leave no ink; the body's own outline is a stroke).
  const GARMENT_INK_REACH = 10;
  const garmentInk = new Uint8Array(cw0 * ch0);
  // (jacket review, bare skin): faint garment lines on the skin near a garment (the tank's
  // neckline and armhole rims, lighter than the ink cutoff) are completed from the surrounding skin:
  // a 7x7 median over the visible or hidden skin texels within GARMENT_LINE_REACH px of the garment's rest
  // coverage, applied only where a texel stands out from that median (a thin line; broad shading
  // and the shading edges survive a median).
  const GARMENT_LINE_REACH = 18;
  const garmentDist = new Int16Array(cw0 * ch0).fill(32767);
  {
    const dist = garmentDist;
    const q: number[] = [];
    for (let i = 0; i < owner.length; i++) {
      const k = owner[i] as number;
      if (k >= 0 && (items[k] as Item).att.embed) { dist[i] = 0; q.push(i); }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h] as number;
      const d = dist[i] as number;
      if (d >= GARMENT_LINE_REACH) continue;
      const x = i % cw0;
      for (const j of [x > 0 ? i - 1 : -1, x < cw0 - 1 ? i + 1 : -1, i - cw0, i + cw0]) {
        if (j < 0 || j >= dist.length || (dist[j] as number) <= d + 1) continue;
        dist[j] = d + 1;
        q.push(j);
      }
    }
    for (let i = 0; i < garmentInk.length; i++) {
      if ((dist[i] as number) > GARMENT_INK_REACH) continue;
      const x = i % cw0;
      const y = Math.floor(i / cw0);
      if (x >= artImg.width || y >= artImg.height) continue;
      const o = (y * artImg.width + x) * 4;
      if ((artImg.data[o + 3] as number) >= 8 && 0.3 * (artImg.data[o] as number) + 0.59 * (artImg.data[o + 1] as number) + 0.11 * (artImg.data[o + 2] as number) < 185) garmentInk[i] = 1; // the line and its anti-aliased rim
    }
  }
  bakeReport.garmentInkPx = garmentInk.reduce((a, b) => a + b, 0);
  // The skin's base colour (the art's most common light skin colour where skin is on top): skin
  // texels hidden under a garment at rest that carry old line ink are completed with it.
  const skinBase = (() => {
    const hist = new Map<number, number>();
    for (let i = 0; i < owner.length; i++) {
      const k = owner[i] as number;
      if (k < 0 || (items[k] as Item).att.embed || (items[k] as Item).quad) continue;
      const x = i % cw0;
      const y = Math.floor(i / cw0);
      const o = (y * artImg.width + x) * 4;
      if ((artImg.data[o + 3] as number) < 255) continue;
      const key = ((artImg.data[o] as number) << 16) | ((artImg.data[o + 1] as number) << 8) | (artImg.data[o + 2] as number);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
    const best = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0xf7c49e;
    return [(best >> 16) & 255, (best >> 8) & 255, best & 255, 255];
  })();
  let completedHidden = 0;
  const slotIdx = new Map((doc.slots as any[]).map((x, i) => [x.name as string, i]));
  const copies = new Map<string, RgbaImage & { data: Uint8Array }>();
  // texels of each skin texture baked from the art (visible at rest)
  const paintedOf = new Map<string, Set<number>>();
  items.forEach((it, k) => {
    if (it.quad) return;
    const tex = textures.get(it.att.path) as RgbaImage;
    let copy = copies.get(it.att.path);
    if (!copy) { copy = { width: tex.width, height: tex.height, data: new Uint8Array(tex.data) }; copies.set(it.att.path, copy); }
    let n = 0;
    const nearLine: number[] = [];
    const uv = it.att.uvs as number[];
    for (const t of it.tris) {
      const idx = [it.att.triangles[t * 3], it.att.triangles[t * 3 + 1], it.att.triangles[t * 3 + 2]] as number[];
      const T = idx.map((i) => ({ x: (uv[i * 2] as number) * tex.width, y: (uv[i * 2 + 1] as number) * tex.height }));
      raster(T[0] as V, T[1] as V, T[2] as V, (tx, ty, l) => {
        let cx = 0;
        let cy = 0;
        idx.forEach((i, j) => { cx += (it.pos[i] as V).x * l[j]!; cy += (it.pos[i] as V).y * l[j]!; });
        const px = Math.floor(cx);
        const py = Math.floor(cy);
        if (px < 0 || py < 0 || px >= cw0 || py >= ch0) return;
        const ow = owner[py * cw0 + px] as number;
        // visible skin near a garment, and skin hidden under one at rest (the faint rims sit there)
        if (!it.att.embed && (ow === k || (ow >= 0 && (items[ow] as Item).att.embed)) && (garmentDist[py * cw0 + px] as number) <= GARMENT_LINE_REACH) nearLine.push(ty * tex.width + tx);
        if (ow !== k) {
          // hidden at rest under a garment: built material, but no line ink (bare / removed garment)
          if (!it.att.embed && ow >= 0 && (items[ow] as Item).att.embed) {
            const t0 = (ty * tex.width + tx) * 4;
            const d = (copy as { data: Uint8Array }).data;
            if ((d[t0 + 3] as number) > 0 && 0.3 * (d[t0] as number) + 0.59 * (d[t0 + 1] as number) + 0.11 * (d[t0 + 2] as number) < 185) { d.set(skinBase, t0); completedHidden++; }
          }
          return;
        }
        if (!it.att.embed && (strokeCover[py * cw0 + px] as number) > (slotIdx.get(it.slot) ?? -1)) return;
        if (!it.att.embed && garmentInk[py * cw0 + px]) return;
        const s0 = (py * artImg.width + px) * 4;
        if ((artImg.data[s0 + 3] as number) < 8) return;
        (copy as { data: Uint8Array }).data.set(artImg.data.subarray(s0, s0 + 4), (ty * tex.width + tx) * 4);
        if (!it.att.embed) { let ps = paintedOf.get(it.att.path); if (!ps) paintedOf.set(it.att.path, (ps = new Set())); ps.add(ty * tex.width + tx); }
        n++;
      });
    }
    if (nearLine.length) {
      const c = copy as { data: Uint8Array };
      const snap = new Uint8Array(c.data);
      let lines = 0;
      for (const t0 of nearLine) {
        const x = t0 % tex.width;
        const y = (t0 - x) / tex.width;
        const ch: number[][] = [[], [], []];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= tex.width || yy >= tex.height) continue;
          const o = (yy * tex.width + xx) * 4;
          if ((snap[o + 3] as number) < 255) continue;
          for (let q = 0; q < 3; q++) (ch[q] as number[]).push(snap[o + q] as number);
        }
        if ((ch[0] as number[]).length < 25) continue;
        const med = ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1] as number);
        const o = t0 * 4;
        if ((snap[o + 3] as number) < 255) continue;
        if (Math.max(...[0, 1, 2].map((q) => Math.abs((snap[o + q] as number) - (med[q] as number)))) <= 6) continue;
        c.data.set(med, o);
        lines++;
      }
      bakeReport[`${it.slot}:garmentLinesCompleted`] = lines;
    }
    bakeReport[`${it.slot}:${it.att.path}`] = n;
  });
  // Full-body mode (phase 2b): skin material hidden at rest (the far arm's and far leg's inner halves,
  // the torso under the near arm) is completed from the part's own painted texels so a swing reveals
  // painted material, not the built flat fill: each hidden texel takes the colour of the nearest
  // painted fill texel reflected back into the painted area (its texture, shading and palette), never
  // line ink or its anti-aliased rim, never another part's texels.
  if (ctx.farSuffix === null) {
    let textured = 0;
    let alongAxis = 0;
    // the limb axes of each skin texture, in texel space: the setup segments of the bones weighting
    // its mesh (texture space is the canvas translated and scaled: uv * size against the rest positions)
    const axesOf = new Map<string, [V, V][]>();
    for (const it of items) {
      if (it.quad || it.att.embed || !Array.isArray(it.att.bones) || axesOf.has(it.att.path)) continue;
      const tex = textures.get(it.att.path) as RgbaImage;
      const uv = it.att.uvs as number[];
      const pos = it.pos;
      let far = 0;
      for (let i = 1; i < pos.length; i++) if (Math.hypot((pos[i] as V).x - (pos[0] as V).x, (pos[i] as V).y - (pos[0] as V).y) > Math.hypot((pos[far] as V).x - (pos[0] as V).x, (pos[far] as V).y - (pos[0] as V).y)) far = i;
      const t0: V = { x: (uv[0] as number) * tex.width, y: (uv[1] as number) * tex.height };
      const t1: V = { x: (uv[far * 2] as number) * tex.width, y: (uv[far * 2 + 1] as number) * tex.height };
      const p0 = pos[0] as V;
      const p1 = pos[far] as V;
      const sc = Math.hypot(t1.x - t0.x, t1.y - t0.y) / Math.max(1e-9, Math.hypot(p1.x - p0.x, p1.y - p0.y));
      const toTex = (c: V): V => ({ x: t0.x + (c.x - p0.x) * sc, y: t0.y + (c.y - p0.y) * sc });
      const segs: [V, V][] = [];
      for (const name of new Set(it.att.bones as string[])) {
        const len = ((doc.bones as any[]).find((b) => b.name === name)?.length as number | undefined) ?? 0;
        if (len < 4) continue;
        segs.push([toTex(toCanvas(W(B(name), 0, 0))), toTex(toCanvas(W(B(name), len, 0)))]);
      }
      axesOf.set(it.att.path, segs);
    }
    for (const [path, painted] of paintedOf) {
      const img = copies.get(path) as RgbaImage & { data: Uint8Array };
      const tw = img.width;
      const th = img.height;
      const lum = (i: number) => 0.3 * (img.data[i * 4] as number) + 0.59 * (img.data[i * 4 + 1] as number) + 0.11 * (img.data[i * 4 + 2] as number);
      const ink = new Uint8Array(tw * th);
      for (const i of painted) if (lum(i) < 185) ink[i] = 1;
      // fill sources: painted, opaque, at least RIM texels from any line ink or its rim
      const RIM = 4;
      const src = new Uint8Array(tw * th);
      for (const i of painted) {
        if ((img.data[i * 4 + 3] as number) < 255 || ink[i]) continue;
        const x = i % tw;
        const y = (i - x) / tw;
        let clear = true;
        for (let dy = -RIM; dy <= RIM && clear; dy++) for (let dx = -RIM; dx <= RIM; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= tw || yy >= th || ink[yy * tw + xx] || !painted.has(yy * tw + xx)) { clear = false; break; }
        }
        if (clear) src[i] = 1;
      }
      // the axis extension's sources: painted fill texels off the line ink by AXIS_RIM (a thin painted
      // sliver, such as the far arm's strip beside the torso, has almost no RIM-clear texel)
      const AXIS_RIM = 2;
      const axisSrc = new Uint8Array(tw * th);
      for (const i of painted) {
        if ((img.data[i * 4 + 3] as number) < 255 || ink[i]) continue;
        const x = i % tw;
        const y = (i - x) / tw;
        let clear = true;
        for (let dy = -AXIS_RIM; dy <= AXIS_RIM && clear; dy++) for (let dx = -AXIS_RIM; dx <= AXIS_RIM; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= tw || yy >= th || ink[yy * tw + xx] || !painted.has(yy * tw + xx)) { clear = false; break; }
        }
        if (clear) axisSrc[i] = 1;
      }
      // nearest source per texel (two-pass chamfer propagation of the nearest source index)
      const near = new Int32Array(tw * th).fill(-1);
      for (let i = 0; i < tw * th; i++) if (src[i]) near[i] = i;
      const d2 = (i: number, j: number) => { const ax = i % tw, ay = (i - ax) / tw, bx = j % tw, by = (j - bx) / tw; return (ax - bx) ** 2 + (ay - by) ** 2; };
      const relax = (i: number, j: number) => { const c = near[j] as number; if (c < 0) return; const o = near[i] as number; if (o < 0 || d2(i, c) < d2(i, o)) near[i] = c; };
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = y * tw + x; if (x > 0) relax(i, i - 1); if (y > 0) { relax(i, i - tw); if (x > 0) relax(i, i - tw - 1); if (x < tw - 1) relax(i, i - tw + 1); } }
      for (let y = th - 1; y >= 0; y--) for (let x = tw - 1; x >= 0; x--) { const i = y * tw + x; if (x < tw - 1) relax(i, i + 1); if (y < th - 1) { relax(i, i + tw); if (x < tw - 1) relax(i, i + tw + 1); if (x > 0) relax(i, i + tw - 1); } }
      const snap = new Uint8Array(img.data);
      const segs = axesOf.get(path) ?? [];
      const BAND = 6; // the painted-reveal gate's flat window
      const alongLimb = (tx: number, ty: number): number => {
        let best: [V, V] | null = null;
        let bd = Infinity;
        for (const [a, b] of segs) {
          const vx = b.x - a.x, vy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((tx - a.x) * vx + (ty - a.y) * vy) / (vx * vx + vy * vy)));
          const d = Math.hypot(tx - a.x - t * vx, ty - a.y - t * vy);
          if (d < bd) { bd = d; best = [a, b]; }
        }
        if (!best) return -1;
        const len = Math.hypot(best[1].x - best[0].x, best[1].y - best[0].y);
        const ax = (best[1].x - best[0].x) / len, ay = (best[1].y - best[0].y) / len;
        const at = (k: number, sgn: number) => { const rx = Math.round(tx + sgn * ax * k), ry = Math.round(ty + sgn * ay * k); return rx < 0 || ry < 0 || rx >= tw || ry >= th ? -2 : axisSrc[ry * tw + rx] ? ry * tw + rx : -1; };
        for (let k = 1; k < 400; k++) for (const sgn of [1, -1]) {
          if (at(k, sgn) < 0) continue;
          let L = 0;
          while (L < 400 && at(k + L + 1, sgn) >= 0) L++;
          let q = k % (2 * L + 1);
          if (q > L) q = 2 * L + 1 - q;
          const hit = at(k + q, sgn);
          return hit >= 0 ? hit : (at(k, sgn) as number);
        }
        return -1;
      };
      for (let i = 0; i < tw * th; i++) {
        if (painted.has(i) || (snap[i * 4 + 3] as number) === 0) continue;
        const sI = near[i] as number;
        if (sI < 0) continue;
        const tx = i % tw, ty = (i - tx) / tw, sx0 = sI % tw, sy0 = (sI - sx0) / tw;
        // reflect across the painted edge, folding back and forth inside the painted band (period 2L
        // along the ray, L = the band's depth there), so neighbouring hidden texels take distinct texels
        const dd = Math.hypot(sx0 - tx, sy0 - ty) || 1;
        const ux = (sx0 - tx) / dd;
        const uy = (sy0 - ty) / dd;
        let L = 0;
        while (L < 400) {
          const rx = Math.round(sx0 + ux * (L + 1));
          const ry = Math.round(sy0 + uy * (L + 1));
          if (rx < 0 || ry < 0 || rx >= tw || ry >= th || !src[ry * tw + rx]) break;
          L++;
        }
        let pick = sI;
        if (L >= BAND) {
          let q = dd % (2 * L);
          if (q > L) q = 2 * L - q;
          const rx = Math.round(sx0 + ux * q);
          const ry = Math.round(sy0 + uy * q);
          if (rx >= 0 && ry >= 0 && rx < tw && ry < th && src[ry * tw + rx]) pick = ry * tw + rx;
        } else {
          // no painted band behind the nearest source (a corner or a sliver of the painted area, under
          // BAND texels deep): the reflection would repeat one or a few texels over the whole hidden
          // region (flat fill). Extend the
          // material along the limb axis instead: walk both ways along the nearest bone's direction to
          // the nearest painted source and fold inside the painted band there (the limb's own texture
          // continued along its length).
          const axis = alongLimb(tx, ty);
          if (axis >= 0) { pick = axis; alongAxis++; }
          else if (L > 0) {
            let q = dd % (2 * L);
            if (q > L) q = 2 * L - q;
            const rx = Math.round(sx0 + ux * q);
            const ry = Math.round(sy0 + uy * q);
            if (rx >= 0 && ry >= 0 && rx < tw && ry < th && src[ry * tw + rx]) pick = ry * tw + rx;
          }
        }
        img.data.set(snap.subarray(pick * 4, pick * 4 + 3), i * 4);
        textured++;
      }
    }
    bakeReport.hiddenTexturedCompletion = textured;
    bakeReport.hiddenAlongLimbAxis = alongAxis;
  }
  for (const [path, img] of copies) textures.set(path, img);
  bakeReport.hiddenInkCompleted = completedHidden;
  // Far-side rigid regions (mirrored fists) take the art's own far side: each texel is mapped
  // through the region's setup placement to the canvas (texel v direction checked on the near
  // copy, whose texture is the art crop) and re-sampled from the art where the art is opaque.
  // Mirror mode only: full-body parts cut their regions from their own art and join their fists
  // in cli/fullBody.ts.
  if (ctx.farSuffix !== null) {
    const suffix = ctx.farSuffix;
    const regs = Object.entries(sk0).flatMap(([slot, atts]) => Object.values(atts).filter((a) => a.type === "region").map((a) => ({ slot, att: a })));
    const boneOf = (slot: string) => (doc.slots as any[]).find((x) => x.name === slot)?.bone as string;
    const mapTexel = (slot: string, att: any, tw: number, th: number, tx: number, ty: number, vSign: number): V => {
      const u = (tx + 0.5) / tw - 0.5;
      const v = ((ty + 0.5) / th - 0.5) * vSign;
      const r = ((att.rotation ?? 0) * Math.PI) / 180;
      const lx = u * att.width * (att.scaleX ?? 1);
      const ly = v * att.height * (att.scaleY ?? 1);
      const p = W(B(boneOf(slot)), (att.x ?? 0) + lx * Math.cos(r) - ly * Math.sin(r), (att.y ?? 0) + lx * Math.sin(r) + ly * Math.cos(r));
      return toCanvas(p);
    };
    const near = regs.find((r) => !r.att.path.endsWith(suffix) && regs.some((q) => q.att.path === `${r.att.path}${suffix}`));
    let vSign = -1;
    if (near) {
      const tex = textures.get(near.att.path) as RgbaImage;
      const errFor = (sg: number) => {
        let e = 0;
        for (let ty = 0; ty < tex.height; ty += 4) for (let tx = 0; tx < tex.width; tx += 4) {
          const c = mapTexel(near.slot, near.att, tex.width, tex.height, tx, ty, sg);
          const px = Math.floor(c.x);
          const py = Math.floor(c.y);
          if (px < 0 || py < 0 || px >= artImg.width || py >= artImg.height) { e += 255; continue; }
          for (let k = 0; k < 4; k++) e += Math.abs((tex.data[(ty * tex.width + tx) * 4 + k] as number) - (artImg.data[(py * artImg.width + px) * 4 + k] as number));
        }
        return e;
      };
      vSign = errFor(-1) <= errFor(1) ? -1 : 1;
    }
    let rebaked = 0;
    for (const r of regs.filter((x) => x.att.path.endsWith(suffix))) {
      const tex = textures.get(r.att.path) as RgbaImage;
      const img = { width: tex.width, height: tex.height, data: new Uint8Array(tex.data) };
      for (let ty = 0; ty < tex.height; ty++) for (let tx = 0; tx < tex.width; tx++) {
        if ((tex.data[(ty * tex.width + tx) * 4 + 3] as number) < 8) continue;
        const c = mapTexel(r.slot, r.att, tex.width, tex.height, tx, ty, vSign);
        const px = Math.floor(c.x);
        const py = Math.floor(c.y);
        if (px < 0 || py < 0 || px >= artImg.width || py >= artImg.height) continue;
        const o = (py * artImg.width + px) * 4;
        if ((artImg.data[o + 3] as number) < 8) continue;
        img.data.set(artImg.data.subarray(o, o + 4), (ty * tex.width + tx) * 4);
        rebaked++;
      }
      textures.set(r.att.path, img);
    }
    bakeReport.farRegionTexels = rebaked;
    bakeReport.regionVSign = vSign;
    // Rigid extremities: a region that cut a limb's strokes (the fists)
    // gets a runtime outline continuing them: one bone-bound open contour from one cut stroke end
    // around the region's silhouette (inset half a stroke width) to the other end, same width and
    // colour, drawn above the region; the soft painted ring under it is completed with the region's
    // skin, and the region overlaps the limb a few px past its cut (no light seam at the wrist).
    const extremityOutlines: Record<string, number> = {};
    const extremityTexels: Record<string, { cleared: number; repainted: number }> = {};
    // the mirrored side regions (the fists); the head keeps its painted outline (recorded, plan)
    for (const r of regs.filter((x) => x.att.path.endsWith(suffix) || regs.some((q) => q.att.path === `${x.att.path}${suffix}`))) {
      const tex = textures.get(r.att.path) as RgbaImage;
      const tw = tex.width;
      const th = tex.height;
      const at = (tx: number, ty: number) => mapTexel(r.slot, r.att, tw, th, tx - 0.5, ty - 0.5, vSign); // texel corner coords
      const o0 = at(0, 0);
      const ex = at(1, 0);
      const ey = at(0, 1);
      const ax = { x: ex.x - o0.x, y: ex.y - o0.y };
      const ay = { x: ey.x - o0.x, y: ey.y - o0.y };
      const det = ax.x * ay.y - ax.y * ay.x;
      const toTex = (p: V) => ({ x: ((p.x - o0.x) * ay.y - (p.y - o0.y) * ay.x) / det, y: (ax.x * (p.y - o0.y) - ax.y * (p.x - o0.x)) / det });
      const ends = regionEnds.filter((e) => { const t = toTex(e.pos); return t.x > -24 && t.y > -24 && t.x < tw + 24 && t.y < th + 24; });
      if (ends.length !== 2) continue;
      const width = ends[0]?.width as number;
      const half = width / 2;
      const mask = new Uint8Array(tw * th);
      for (let i = 0; i < tw * th; i++) mask[i] = (tex.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
      const dist = distInside(mask, tw, th);
      const inset = new Uint8Array(tw * th);
      for (let i = 0; i < tw * th; i++) inset[i] = (dist[i] as number) >= half ? 1 : 0;
      const loop = smoothLoop(traceLoops(inset, tw, th).sort((p, q) => q.length - p.length)[0] ?? [], 3, 2, 400);
      if (loop.length < 8) continue;
      const ti = ends.map((e) => toTex(e.pos)) as [{ x: number; y: number }, { x: number; y: number }];
      const nearestOn = (t: { x: number; y: number }) => {
        let best = 0;
        let bd = Infinity;
        loop.forEach((p, i) => { const d = Math.hypot((p[0] as number) - t.x, (p[1] as number) - t.y); if (d < bd) { bd = d; best = i; } });
        return best;
      };
      const i0 = nearestOn(ti[0]);
      const i1 = nearestOn(ti[1]);
      const n = loop.length;
      const fwd = (i1 - i0 + n) % n;
      const path: (readonly number[])[] = [];
      if (fwd >= n - fwd) for (let k = 0; k <= fwd; k++) path.push(loop[(i0 + k) % n] as readonly number[]);
      else for (let k = 0; k <= n - fwd; k++) path.push(loop[(i0 - k + n) % n] as readonly number[]);
      // bone-local positions: the region placement (texel -> bone space); the ends through toTex
      const ra = ((r.att.rotation ?? 0) * Math.PI) / 180;
      const local = (tx: number, ty: number): [number, number] => {
        const u = tx / tw - 0.5;
        const v = (ty / th - 0.5) * vSign;
        const lx = u * r.att.width * (r.att.scaleX ?? 1);
        const ly = v * r.att.height * (r.att.scaleY ?? 1);
        return [(r.att.x ?? 0) + lx * Math.cos(ra) - ly * Math.sin(ra), (r.att.y ?? 0) + lx * Math.sin(ra) + ly * Math.cos(ra)];
      };
      // tangent joins: from each stroke end a quadratic curve leaves along the stroke's own
      // direction and lands on the silhouette path, so the line has no kink where the limb's stroke
      // hands over to the region's outline (just past the cuff on a dressed arm)
      const join = (e: (typeof ends)[number], t: { x: number; y: number }, land: readonly number[]): [number, number][] => {
        const d1 = toTex({ x: e.pos.x + e.dir.x, y: e.pos.y + e.dir.y });
        const dx = d1.x - t.x;
        const dy = d1.y - t.y;
        const dl = Math.hypot(dx, dy) || 1;
        const L = 0.6 * Math.hypot((land[0] as number) - t.x, (land[1] as number) - t.y);
        const cx = t.x + (dx / dl) * L;
        const cy = t.y + (dy / dl) * L;
        const out: [number, number][] = [];
        for (let k = 0; k < 4; k++) {
          const u = k / 4;
          out.push([(1 - u) * (1 - u) * t.x + 2 * (1 - u) * u * cx + u * u * (land[0] as number), (1 - u) * (1 - u) * t.y + 2 * (1 - u) * u * cy + u * u * (land[1] as number)]);
        }
        return out;
      };
      const head = join(ends[0] as (typeof ends)[number], ti[0], path[0] as readonly number[]);
      const tail = join(ends[1] as (typeof ends)[number], ti[1], path[path.length - 1] as readonly number[]).reverse();
      const pts = [...head, ...path.map((q) => [q[0] as number, q[1] as number] as [number, number]), ...tail].map(([x, y]) => local(x, y));
      const vertices = pts.flatMap(([x, y]) => [1, 0, Number(x.toFixed(3)), Number(y.toFixed(3)), 1]);
      const contours = (doc.skins[skinKey].contours ??= {}) as Record<string, Record<string, any>>;
      const attName = Object.entries(sk0[r.slot] ?? {}).find(([, a]) => a === r.att)?.[0] as string;
      (contours[r.slot] ??= {}).outline = { bones: [boneOf(r.slot)], vertices, closed: false, width, color: ends[0]?.color, caps: "round", owner: { slot: r.slot, attachment: attName } };
      extremityOutlines[r.slot] = pts.length;
      //: each limb stroke end and the outline's end beside it are one line at any wrist angle
      // (runtime contour join: cut at the crossing on the inner side of a bend, bridged on the outer)
      const arc = (q: [number, number][]) => q.reduce((s2, p, i) => (i ? s2 + Math.hypot(p[0] - (q[i - 1] as [number, number])[0], p[1] - (q[i - 1] as [number, number])[1]) : 0), 0);
      const joins = ((doc.skins[skinKey].contourJoins ??= []) as any[]);
      ends.forEach((e, k) => {
        const land = (k ? path[path.length - 1] : path[0]) as readonly number[];
        const bridge = (k ? [[land[0], land[1]] as [number, number], ...tail] : [...head, [land[0], land[1]] as [number, number]]).map(([x, y]) => local(x as number, y as number));
        const reach = Number((JOIN_REACH_SCALE * Math.max(arc(bridge), width)).toFixed(2));
        joins.push({ a: { slot: e.slot, name: e.name, end: e.end }, b: { slot: r.slot, name: "outline", end: k ? "end" : "start" }, reach });
      });
      //:
      // the region's art ends at the outline's centreline. Texels outside the closed outline (the
      // stroke path, closed across the cut OVERLAP + 2 px beyond it) are cleared, so no painted ink
      // or skin corner shows past the stroke; inside, any texel darker than the skin within a stroke
      // width + 6 px of the line is repainted from the skin further in (no painted ring stacking
      // under the stroke, no ink patch at the cut corners when the joins move the line).
      const OVERLAP = 4;
      const cutSide = (ti[0].y + ti[1].y) / 2 < th / 2 ? -1 : 1;
      const line = [...head, ...path.map((q) => [q[0] as number, q[1] as number] as [number, number]), ...tail];
      const poly = [...line, [ti[1].x, ti[1].y + cutSide * (OVERLAP + 2)], [ti[0].x, ti[0].y + cutSide * (OVERLAP + 2)]] as [number, number][];
      const inside = new Uint8Array(tw * th);
      const lineDist = new Float32Array(tw * th);
      for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        let inPoly = false;
        for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
          const [xa, ya] = poly[a] as [number, number];
          const [xb, yb] = poly[b] as [number, number];
          if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inPoly = !inPoly;
        }
        let d = Infinity;
        for (let k = 1; k < line.length; k++) {
          const [x0, y0] = line[k - 1] as [number, number];
          const [x1, y1] = line[k] as [number, number];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const l2 = dx * dx + dy * dy;
          const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
          d = Math.min(d, Math.hypot(x - x0 - dx * u, y - y0 - dy * u));
        }
        inside[ty * tw + tx] = inPoly ? 1 : 0;
        lineDist[ty * tw + tx] = d;
      }
      const img = { width: tw, height: th, data: new Uint8Array(tex.data) };
      const lum = (i: number) => 0.3 * (tex.data[i * 4] as number) + 0.59 * (tex.data[i * 4 + 1] as number) + 0.11 * (tex.data[i * 4 + 2] as number);
      const band = width + 6;
      let cleared = 0;
      let repainted = 0;
      // the limb strokes' last px (drawn before the region) stay uncovered: region texels within half
      // a width + 1 of them are cleared too (else the region's edge crosses the stroke at the join)
      const limbEnds = ends.map((e) => {
        const L = 3 * width;
        const p0 = toTex(e.pos);
        const p1 = toTex({ x: e.pos.x - e.dir.x * L, y: e.pos.y - e.dir.y * L });
        return [p0, p1] as const;
      });
      const nearLimb = (x: number, y: number) => limbEnds.some(([a0, b0]) => {
        const dx = b0.x - a0.x;
        const dy = b0.y - a0.y;
        const l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - a0.x) * dx + (y - a0.y) * dy) / l2));
        return Math.hypot(x - a0.x - dx * u, y - a0.y - dy * u) < half + 1;
      });
      for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const i = ty * tw + tx;
        if (!inside[i] || nearLimb(tx + 0.5, ty + 0.5)) {
          inside[i] = 0;
          if ((img.data[i * 4 + 3] as number) > 0) cleared++;
          img.data.set([0, 0, 0, 0], i * 4);
          continue;
        }
        if (!mask[i] || (lineDist[i] as number) > band) continue;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let cnt = 0;
        for (let R = 6; R <= 18 && !cnt; R += 6) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const X = tx + dx;
          const Y = ty + dy;
          if (X < 0 || Y < 0 || X >= tw || Y >= th) continue;
          const j = Y * tw + X;
          if (!inside[j] || !mask[j] || (lineDist[j] as number) < band || lum(j) < 150) continue;
          s0 += tex.data[j * 4] as number;
          s1 += tex.data[j * 4 + 1] as number;
          s2 += tex.data[j * 4 + 2] as number;
          cnt++;
        }
        if (!cnt) continue;
        if (lum(i) > (0.9 * (0.3 * s0 + 0.59 * s1 + 0.11 * s2)) / cnt) continue;
        img.data.set([Math.round(s0 / cnt), Math.round(s1 / cnt), Math.round(s2 / cnt), 255], i * 4);
        repainted++;
      }
      extremityTexels[r.slot] = { cleared, repainted };
      // the cut edge: rows just past the region's opaque edge between the two stroke ends repeat an
      // inner texel, opaque (the region overlaps the limb; no anti-aliased seam at the wrist)
      const lo = Math.min(ti[0].x, ti[1].x);
      const hi = Math.max(ti[0].x, ti[1].x);
      for (let tx = Math.max(0, Math.ceil(lo)); tx <= Math.min(tw - 1, Math.floor(hi)); tx++) {
        let edge = -1;
        if (cutSide < 0) { for (let ty = 0; ty < th; ty++) if (mask[ty * tw + tx]) { edge = ty; break; } }
        else for (let ty = th - 1; ty >= 0; ty--) if (mask[ty * tw + tx]) { edge = ty; break; }
        if (edge < 0) continue;
        const src = (Math.min(th - 1, Math.max(0, edge - cutSide * 2)) * tw + tx) * 4;
        for (let k = 0; k <= OVERLAP; k++) {
          const y = edge + cutSide * k;
          if (y < 0 || y >= th) break;
          if (!inside[y * tw + tx]) continue;
          img.data.set([img.data[src] as number, img.data[src + 1] as number, img.data[src + 2] as number, 255], (y * tw + tx) * 4);
        }
      }
      textures.set(r.att.path, img);
      // the region's opaque outline (strokes drawn before it are trimmed under it) follows the new art
      const opaque = opaqueOutline(img);
      if (opaque) r.att.opaque = opaque;
    }
    bakeReport.extremityOutlines = extremityOutlines as unknown as number;
    bakeReport.extremityTexels = extremityTexels as unknown as number;
  }
  return bakeReport;
}
