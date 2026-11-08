/*
 * Atlas Animator: original implementation.
 *
 * Rigid extremity joins for a rig document (the arm layer's fists; the same construction as the
 * full-body assembler's /5/8 extremities in cli/legsBody.ts, here on any anim document):
 * - limb strokes whose setup points lie under the region's keep polygon are split there (no stroke
 *   end can peek out from under the fist in motion);
 * - the region gets a runtime outline: one bone-bound open contour from one cut stroke end around
 *   the region's opaque silhouette (inset half a stroke width) to the other end, tangent-joined to
 *   both strokes, same width and colour, owned by the region;
 * - each stroke end and the outline end beside it become a runtime contour join (applyJoin);
 * - the region's art is cut to the outline: texels outside the closed outline (closed across the
 *   wrist a few px into the limb) are cleared, so no painted ink or skin wedge shows past the line,
 *   and texels darker than the skin within a stroke width of the line are repainted from the skin.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { RegionAttachment } from "../core/attachments.js";
import type { RgbaImage } from "./image.js";
import { distInside, smoothLoop, traceLoops } from "./garmentImport.js";
import { opaqueOutline } from "./bodyContours.js";

type P = [number, number];
const OVERLAP = 4;
/** Canvas px of the region's art cleared inside the wrist chord (the cuff stub). */
const WRIST_BAND = 18;

function pip(p: P, poly: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface ExtremityRegion {
  /** The region's slot (e.g. the fist). */
  slot: string;
  /** Canvas polygon at the setup pose: limb stroke points inside it are dropped. */
  keep: readonly (readonly number[])[];
  /** Only contours owned by these slots (the limb's own strokes) are split; default: every contour. */
  contourSlots?: readonly string[];
}

/** Applies the joins in place (doc JSON and textures). Returns one report line per region. */
export function joinExtremities(doc: Record<string, any>, textures: Map<string, RgbaImage>, regions: readonly ExtremityRegion[], skinName = "body"): string[] {
  const report: string[] = [];
  const skin = doc.skins[skinName];
  const contours = (skin.contours ??= {}) as Record<string, Record<string, any>>;
  const joins = (skin.contourJoins ??= []) as any[];
  for (const reg of regions) {
    const anim = loadAnimDocument(doc);
    const sk = new Skeleton(anim);
    sk.setActiveSkins(Object.keys(anim.skins));
    sk.setToSetupPose();
    sk.updateWorldTransform("none");
    const ox = anim.canvas.originX;
    const oy = anim.canvas.originY;
    const slot = sk.getSlot(reg.slot);
    const attName = Object.keys(skin.attachments[reg.slot] ?? {})[0] as string;
    const region = sk.getAttachment(slot, attName) as RegionAttachment;
    if (!region || region.type !== "region") throw new Error(`extremity '${reg.slot}': no region attachment`);
    const tex = textures.get(region.path);
    if (!tex) throw new Error(`extremity '${reg.slot}': no texture '${region.path}'`);
    const tw = tex.width;
    const th = tex.height;
    // texel <-> canvas at setup, from the region's world corners and uvs
    const corners = new Float64Array(16);
    sk.computeSlotWorldVertices(slot, corners);
    const uv = region.uvs;
    const W = (k: number): P => [(corners[k * 2] as number) + ox, (corners[k * 2 + 1] as number) + oy];
    const U = (k: number): P => [(uv[k * 2] as number) * tw, (uv[k * 2 + 1] as number) * th];
    // affine canvas = M * tex + t, from corners 0, 1, 2
    const [t0, t1, t2] = [U(0), U(1), U(2)];
    const [w0, w1, w2] = [W(0), W(1), W(2)];
    const du1: P = [t1[0] - t0[0], t1[1] - t0[1]];
    const du2: P = [t2[0] - t0[0], t2[1] - t0[1]];
    const dw1: P = [w1[0] - w0[0], w1[1] - w0[1]];
    const dw2: P = [w2[0] - w0[0], w2[1] - w0[1]];
    const den = du1[0] * du2[1] - du2[0] * du1[1];
    const M = [(dw1[0] * du2[1] - dw2[0] * du1[1]) / den, (dw2[0] * du1[0] - dw1[0] * du2[0]) / den, (dw1[1] * du2[1] - dw2[1] * du1[1]) / den, (dw2[1] * du1[0] - dw1[1] * du2[0]) / den] as const;
    const toCanvas = (t: P): P => [w0[0] + M[0] * (t[0] - t0[0]) + M[1] * (t[1] - t0[1]), w0[1] + M[2] * (t[0] - t0[0]) + M[3] * (t[1] - t0[1])];
    const detM = M[0] * M[3] - M[1] * M[2];
    const toTex = (p: P): P => {
      const dx = p[0] - w0[0];
      const dy = p[1] - w0[1];
      return [t0[0] + (M[3] * dx - M[1] * dy) / detM, t0[1] + (-M[2] * dx + M[0] * dy) / detM];
    };
    const bw = slot.bone.world;
    const bdet = bw.a * bw.d - bw.b * bw.c;
    const toLocal = (p: P): P => {
      const dx = p[0] - ox - bw.x;
      const dy = p[1] - oy - bw.y;
      return [(bw.d * dx - bw.b * dy) / bdet, (-bw.c * dx + bw.a * dy) / bdet];
    };

    // --- split limb strokes under the keep polygon ---------------------------------------------
    const ends: { pos: P; dir: P; width: number; color: string; slot: string; name: string; end: "start" | "end" }[] = [];
    let dropped = 0;
    for (const c of sk.activeContours) {
      if (!c.mesh) continue;
      if (reg.contourSlots && !reg.contourSlots.includes(c.slot)) continue;
      const raw = contours[c.slot]?.[c.name];
      if (!raw?.points) continue;
      const buf = new Float32Array(c.pointCount * 2);
      sk.rawContourPoints(c, buf);
      const pos: P[] = [];
      for (let i = 0; i < c.boundCount; i++) pos.push([(buf[i * 2] as number) + ox, (buf[i * 2 + 1] as number) + oy]);
      const inside = pos.map((p) => pip(p, reg.keep));
      if (!inside.some(Boolean)) continue;
      const runs: number[][] = [[]];
      inside.forEach((isIn, i) => {
        if (isIn) {
          dropped++;
          if ((runs[runs.length - 1] as number[]).length) runs.push([]);
        } else (runs[runs.length - 1] as number[]).push(i);
      });
      const kept = runs.filter((r) => r.length >= 2);
      delete contours[c.slot]?.[c.name];
      kept.forEach((r, k) => {
        const name = k ? `${c.name}_f${k}` : c.name;
        (contours[c.slot] as Record<string, any>)[name] = { ...raw, points: r.map((i) => raw.points[i]) };
        const endOf = (e: number, prev: number, end: "start" | "end") => {
          const p = pos[e] as P;
          const q = pos[prev] as P;
          const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
          return { pos: p, dir: [(p[0] - q[0]) / l, (p[1] - q[1]) / l] as P, width: c.width, color: raw.color, slot: c.slot, name, end };
        };
        if ((r[0] as number) > 0) ends.push(endOf(r[0] as number, r[1] as number, "start"));
        if ((r[r.length - 1] as number) < pos.length - 1) ends.push(endOf(r[r.length - 1] as number, r[r.length - 2] as number, "end"));
      });
    }
    if (ends.length !== 2) {
      report.push(`${reg.slot}: ${ends.length} cut stroke ends (need 2), not joined`);
      continue;
    }

    // --- the region's runtime outline -------------------------------------------------------------
    const width = ends[0]?.width as number;
    const half = width / 2;
    const mask = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) mask[i] = (tex.data[i * 4 + 3] as number) >= 128 ? 1 : 0;
    const dist = distInside(mask, tw, th);
    const inset = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) inset[i] = (dist[i] as number) >= half ? 1 : 0;
    const loop = smoothLoop(traceLoops(inset, tw, th).sort((p, q) => q.length - p.length)[0] ?? [], 3, 2, 400) as P[];
    if (loop.length < 8) {
      report.push(`${reg.slot}: no silhouette loop`);
      continue;
    }
    const ti = ends.map((e) => toTex(e.pos)) as [P, P];
    const nearestOn = (t: P) => {
      let best = 0;
      let bd = Infinity;
      loop.forEach((p, i) => {
        const d = Math.hypot(p[0] - t[0], p[1] - t[1]);
        if (d < bd) (bd = d), (best = i);
      });
      return best;
    };
    const i0 = nearestOn(ti[0]);
    const i1 = nearestOn(ti[1]);
    const n = loop.length;
    const fwd = (i1 - i0 + n) % n;
    // around the fist (the longer way), not across the wrist
    const path: P[] = [];
    if (fwd >= n - fwd) for (let k = 0; k <= fwd; k++) path.push(loop[(i0 + k) % n] as P);
    else for (let k = 0; k <= n - fwd; k++) path.push(loop[(i0 - k + n) % n] as P);
    // tangent joins: from each stroke end a quadratic leaves along the stroke's own direction
    const join = (e: (typeof ends)[number], t: P, land: P): P[] => {
      const d1 = toTex([e.pos[0] + e.dir[0], e.pos[1] + e.dir[1]]);
      const dx = d1[0] - t[0];
      const dy = d1[1] - t[1];
      const dl = Math.hypot(dx, dy) || 1;
      const L = 0.6 * Math.hypot(land[0] - t[0], land[1] - t[1]);
      const cx = t[0] + (dx / dl) * L;
      const cy = t[1] + (dy / dl) * L;
      const out: P[] = [];
      for (let k = 0; k < 4; k++) {
        const u = k / 4;
        out.push([(1 - u) * (1 - u) * t[0] + 2 * (1 - u) * u * cx + u * u * land[0], (1 - u) * (1 - u) * t[1] + 2 * (1 - u) * u * cy + u * u * land[1]]);
      }
      return out;
    };
    const head = join(ends[0] as (typeof ends)[number], ti[0], path[0] as P);
    const tail = join(ends[1] as (typeof ends)[number], ti[1], path[path.length - 1] as P).reverse();
    const line = [...head, ...path, ...tail];
    const local = line.map((t) => toLocal(toCanvas(t)));
    (contours[reg.slot] ??= {}).outline = { bones: [slot.bone.data.name], vertices: local.flatMap(([x, y]) => [1, 0, Number(x.toFixed(3)), Number(y.toFixed(3)), 1]), closed: false, width, color: ends[0]?.color, caps: "round", owner: { slot: reg.slot, attachment: attName } };
    const arc = (q: P[]) => q.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - (q[i - 1] as P)[0], p[1] - (q[i - 1] as P)[1]) : 0), 0);
    const texScale = Math.sqrt(Math.abs(detM));
    ends.forEach((e, k) => {
      const land = (k ? path[path.length - 1] : path[0]) as P;
      const bridge = k ? [land, ...tail] : [...head, land];
      joins.push({ a: { slot: e.slot, name: e.name, end: e.end }, b: { slot: reg.slot, name: "outline", end: k ? "end" : "start" }, reach: Number(Math.max(arc(bridge) * texScale, width).toFixed(2)) });
    });

    // --- cut the art to the outline ---------------------------------------------------------------
    const back = ends.map((e, k) => {
      const t = ti[k] as P;
      const b = toTex([e.pos[0] - e.dir[0] * (OVERLAP + 2), e.pos[1] - e.dir[1] * (OVERLAP + 2)]);
      return [t, b] as const;
    });
    const poly: P[] = [...line, (back[1] as readonly [P, P])[1], (back[0] as readonly [P, P])[1]];
    const limbEnds = ends.map((e) => [toTex(e.pos), toTex([e.pos[0] - e.dir[0] * 3 * width, e.pos[1] - e.dir[1] * 3 * width])] as const);
    const nearLimb = (x: number, y: number) =>
      limbEnds.some(([a, b]) => {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(x - a[0] - dx * u, y - a[1] - dy * u) < (half + 1) / texScale;
      });
    // The wrist chord (between the two cut ends): the art's wrist stub past it, on the limb's side,
    // is the forearm's skin, not the fist's. Cleared beyond
    // OVERLAP px, so the region overlaps the limb only that much.
    const ch0 = ti[0];
    const ch1 = ti[1];
    const side = (x: number, y: number) => ((ch1[0] - ch0[0]) * (y - ch0[1]) - (ch1[1] - ch0[1]) * (x - ch0[0])) / (Math.hypot(ch1[0] - ch0[0], ch1[1] - ch0[1]) || 1);
    const cen = loop.reduce((s2, p) => [s2[0] + p[0] / loop.length, s2[1] + p[1] / loop.length] as P, [0, 0] as P);
    const fistSign = Math.sign(side(cen[0], cen[1])) || 1;
    // The art's wrist stub (a shaded cuff band just inside the chord) swings out over the forearm when
    // the wrist bends: it is cleared too, WRIST_BAND px into the fist; the limb sheet's own hand end
    // (it continues under the fist) shows there instead, same skin.
    const pastWrist = (x: number, y: number) => side(x, y) * fistSign < WRIST_BAND / texScale;
    const img = { width: tw, height: th, data: new Uint8Array(tex.data) };
    const inside = new Uint8Array(tw * th);
    const lineDist = new Float32Array(tw * th);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      let d = Infinity;
      for (let k = 1; k < line.length; k++) {
        const [x0, y0] = line[k - 1] as P;
        const [x1, y1] = line[k] as P;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const l2 = dx * dx + dy * dy;
        const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
        d = Math.min(d, Math.hypot(x - x0 - dx * u, y - y0 - dy * u));
      }
      inside[ty * tw + tx] = pip([x, y], poly) ? 1 : 0;
      lineDist[ty * tw + tx] = d;
    }
    const lum = (i: number) => 0.3 * (tex.data[i * 4] as number) + 0.59 * (tex.data[i * 4 + 1] as number) + 0.11 * (tex.data[i * 4 + 2] as number);
    const band = (width + 6) / texScale;
    let cleared = 0;
    let repainted = 0;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const i = ty * tw + tx;
      if (!inside[i] || nearLimb(tx + 0.5, ty + 0.5) || pastWrist(tx + 0.5, ty + 0.5)) {
        if ((img.data[i * 4 + 3] as number) > 0) cleared++;
        img.data.set([0, 0, 0, 0], i * 4);
        inside[i] = 0;
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
      if (!cnt || lum(i) > (0.9 * (0.3 * s0 + 0.59 * s1 + 0.11 * s2)) / cnt) continue;
      img.data.set([Math.round(s0 / cnt), Math.round(s1 / cnt), Math.round(s2 / cnt), 255], i * 4);
      repainted++;
    }
    textures.set(region.path, img);
    const att = skin.attachments[reg.slot][attName];
    const opaque = opaqueOutline(img);
    if (opaque) att.opaque = opaque;
    report.push(`${reg.slot}: ${dropped} stroke points dropped under the keep polygon, outline ${line.length} points, 2 joins, art ${cleared} texels cleared, ${repainted} repainted`);
  }
  return report;
}
