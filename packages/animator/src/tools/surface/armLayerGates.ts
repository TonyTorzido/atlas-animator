/*
 * Atlas Animator: original implementation.
 *
 * Arm layer gates: the layered body's
 * contract measured on the final runtime (Skeleton), on the mirrored whole upper body.
 * - sheets: the declared sheet inventory, each one valid connected surface (one edge-connected
 *   component whose boundary is exactly its hull loop);
 * - geometry: flips, collapses, stretch and compression on EVERY triangle of every sheet (hidden cap
 *   material included), thresholds from the half rig's validation allowances, no waivers;
 * - closure: the shoulder overlap measured (replaces cross-shoulder partition equality): the
 *   arm's closing edge reaches at least `clearance` px into the torso sheet at every pose, and no
 *   background pixel is enclosed between torso and arm near the shoulder (raster, 1 canvas px);
 * - cap coverage (replaces the armpit / junction gates): the torso's completion under the cap is
 *   covered by the arm at every normal pose (rest, walk, idle range);
 * - ink: the closing edge is inked only where it leaves the torso sheet (buried: no line; exposed:
 *   inked); the arm's side contours stay inked over the chest in the across-body poses;
 * - paint: every sheet's texture is opaque and one flat colour under all of its triangles.
 * A gate with no measurement fails (`not measured` is never a pass).
 */
import { Skeleton } from "../../core/skeleton.js";
import { AnimationState, AnimationStateData } from "../../core/animationState.js";
import type { AnimDocument } from "../../core/format.js";
import type { MeshAttachment } from "../../core/attachments.js";
import type { CompiledContour } from "../../core/contours.js";
import type { Slot } from "../../core/slot.js";
import { singularValues, type DistortionAllowance } from "../validateGeometry.js";
import type { RgbaImage } from "../image.js";
import { softRender } from "../softRender.js";

export type Pose = Record<string, number>;
export interface ArmLayerPose {
  name: string;
  rotate: Pose;
  scale?: Record<string, { x: number; y: number }>;
  /** A clip frame instead of (before) the rotations: the clip applied at `time` from the setup pose (draw order, attachments included). */
  clip?: { name: string; time: number };
}
export interface GateResult {
  gate: string;
  ok: boolean;
  measured: number;
  detail: string;
}
type Pt = [number, number];

const origins = new WeakMap<Skeleton, AnimDocument["canvas"]>();
export function poseSkeleton(doc: AnimDocument, skins?: readonly string[]): Skeleton {
  const sk = new Skeleton(doc);
  origins.set(sk, doc.canvas);
  sk.setActiveSkins(skins ?? Object.keys(doc.skins));
  return sk;
}

const stateData = new WeakMap<Skeleton, AnimationStateData>();
export function applyPose(sk: Skeleton, pose: ArmLayerPose): void {
  sk.setToSetupPose();
  if (pose.clip) {
    let data = stateData.get(sk);
    if (!data) stateData.set(sk, (data = new AnimationStateData(sk.document as AnimDocument)));
    const st = new AnimationState(data);
    st.setAnimation(0, pose.clip.name, { loop: false });
    st.update(pose.clip.time);
    st.apply(sk);
  }
  for (const [bone, d] of Object.entries(pose.rotate)) {
    const b = sk.findBone(bone);
    if (!b) throw new Error(`arm layer pose '${pose.name}': no bone '${bone}'`);
    b.pose.rotation = b.data.rotation + d;
  }
  for (const [bone, s] of Object.entries(pose.scale ?? {})) {
    const b = sk.getBone(bone);
    b.pose.scaleX = b.data.scaleX * s.x;
    b.pose.scaleY = b.data.scaleY * s.y;
  }
  sk.updateWorldTransform("none");
}

/** A mesh in the document by `slot/attachment`, with its holder slot. */
function meshOf(sk: Skeleton, key: string): { slot: Slot; mesh: MeshAttachment } {
  const [slotName, att] = key.split("/") as [string, string];
  const slot = sk.getSlot(slotName);
  const mesh = sk.getAttachment(slot, att) as MeshAttachment | undefined;
  if (!mesh || mesh.type !== "mesh") throw new Error(`arm layer: no mesh '${key}'`);
  return { slot, mesh };
}

function world(sk: Skeleton, key: string): Pt[] {
  const { slot, mesh } = meshOf(sk, key);
  const w = sk.meshWorldVertices(mesh, slot.bone);
  const ox = (origins.get(sk) as AnimDocument["canvas"]).originX;
  const oy = (origins.get(sk) as AnimDocument["canvas"]).originY;
  const out: Pt[] = [];
  for (let i = 0; i < w.length / 2; i++) out.push([(w[i * 2] as number) + ox, (w[i * 2 + 1] as number) + oy]);
  return out;
}

function hullOf(sk: Skeleton, key: string, pts: readonly Pt[]): Pt[] {
  const h = meshOf(sk, key).mesh.geometry.hull;
  if (!h) throw new Error(`arm layer: '${key}' has no hull`);
  return pts.slice(0, h);
}

export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt;
    const b = poly[j] as Pt;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToPolyline(p: Pt, poly: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return d;
}

/** Signed depth of p in a polygon: positive inside (distance to its edge), negative outside. */
export function depthIn(p: Pt, poly: readonly Pt[]): number {
  const d = distToPolyline(p, poly);
  return pointInPolygon(p, poly) ? d : -d;
}

/** Gate 1: the declared sheet inventory, each one connected valid surface bounded by its hull loop. */
export function sheetGate(doc: AnimDocument, sheets: readonly string[]): GateResult {
  const sk = poseSkeleton(doc);
  const problems: string[] = [];
  for (const key of sheets) {
    let mesh: MeshAttachment;
    try {
      mesh = meshOf(sk, key).mesh;
    } catch {
      problems.push(`${key}: missing`);
      continue;
    }
    const tris = mesh.geometry.triangles;
    const n = mesh.geometry.vertexCount;
    const parent = Array.from({ length: tris.length / 3 }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
    const edges = new Map<string, number[]>();
    for (let t = 0; t < tris.length / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k] as number;
        const b = tris[t * 3 + ((k + 1) % 3)] as number;
        const e = a < b ? `${a}-${b}` : `${b}-${a}`;
        (edges.get(e) ?? edges.set(e, []).get(e) as number[]).push(t);
      }
    }
    let boundary = 0;
    let nonManifold = 0;
    for (const ts of edges.values()) {
      if (ts.length === 1) boundary++;
      else if (ts.length > 2) nonManifold++;
      for (let k = 1; k < ts.length; k++) parent[find(ts[k] as number)] = find(ts[0] as number);
    }
    const comps = new Set(parent.map((_, i) => find(i))).size;
    const raw = (doc.skins as any);
    const [slotName, att] = key.split("/") as [string, string];
    const hull = Object.values(raw as Record<string, any>).map((s) => s.attachments?.[slotName]?.[att]?.hull).find((h) => h) as number;
    let hullEdges = 0;
    for (let i = 0; i < hull; i++) {
      const a = i;
      const b = (i + 1) % hull;
      const ts = edges.get(a < b ? `${a}-${b}` : `${b}-${a}`);
      if (ts?.length === 1) hullEdges++;
    }
    const used = new Set(tris as unknown as number[]);
    if (comps !== 1) problems.push(`${key}: ${comps} components`);
    if (nonManifold) problems.push(`${key}: ${nonManifold} non-manifold edges`);
    if (boundary !== hull || hullEdges !== hull) problems.push(`${key}: boundary ${boundary} edges, hull ${hull}, hull boundary edges ${hullEdges} (holes or a broken hull)`);
    if (used.size !== n) problems.push(`${key}: ${n - used.size} unused vertices`);
  }
  return { gate: "sheets: one valid connected surface per declared sheet", ok: problems.length === 0, measured: sheets.length, detail: problems.length ? problems.join("; ") : `${sheets.join(", ")}: each 1 component, boundary = hull loop, manifold` };
}

/**
 * Gate 2: per triangle deformation (validateGeometry's measures) on every sheet at every pose.
 * `allowanceOf(key, t)` picks the triangle's allowance (the half rig's validation regions).
 */
export function geometryGate(doc: AnimDocument, sheets: readonly string[], poses: readonly ArmLayerPose[], allowanceOf: (key: string, t: number) => DistortionAllowance, gameScale: number): GateResult & { worst: Record<string, string> } {
  const sk = poseSkeleton(doc);
  const findings = new Map<string, string>();
  const counts = { flip: 0, collapse: 0, overgrow: 0, stretch: 0, compress: 0 };
  let measured = 0;
  const worst: Record<string, string> = {};
  for (const key of sheets) {
    const { mesh } = meshOf(sk, key);
    const tris = mesh.geometry.triangles;
    sk.setToSetupPose();
    sk.updateWorldTransform("none");
    const bind = world(sk, key);
    let minDet = Infinity;
    let minS = Infinity;
    let maxS = 0;
    let at = "";
    for (const pose of poses) {
      applyPose(sk, pose);
      const p = world(sk, key);
      for (let t = 0; t < tris.length / 3; t++) {
        const [i, j, k] = [tris[t * 3] as number, tris[t * 3 + 1] as number, tris[t * 3 + 2] as number];
        const A = bind[i] as Pt, B = bind[j] as Pt, C = bind[k] as Pt;
        const a = p[i] as Pt, b = p[j] as Pt, c = p[k] as Pt;
        const e1: Pt = [B[0] - A[0], B[1] - A[1]], e2: Pt = [C[0] - A[0], C[1] - A[1]];
        const f1: Pt = [b[0] - a[0], b[1] - a[1]], f2: Pt = [c[0] - a[0], c[1] - a[1]];
        const det0 = e1[0] * e2[1] - e2[0] * e1[1];
        if (Math.abs(det0) < 1e-9) continue;
        // F = [f1 f2] [e1 e2]^-1
        const ia = e2[1] / det0, ib = -e2[0] / det0, ic = -e1[1] / det0, id = e1[0] / det0;
        const Fa = f1[0] * ia + f2[0] * ic, Fb = f1[0] * ib + f2[0] * id, Fc = f1[1] * ia + f2[1] * ic, Fd = f1[1] * ib + f2[1] * id;
        const det = Fa * Fd - Fb * Fc;
        const [s1, s2] = singularValues(Fa, Fb, Fc, Fd);
        const al = allowanceOf(key, t);
        const lens = [[A, B, a, b], [B, C, b, c], [C, A, c, a]].map(([P, Q, x, y]) => Math.abs(Math.hypot((y as Pt)[0] - (x as Pt)[0], (y as Pt)[1] - (x as Pt)[1]) - Math.hypot((Q as Pt)[0] - (P as Pt)[0], (Q as Pt)[1] - (P as Pt)[1])) * gameScale);
        const abs = Math.max(...lens);
        measured++;
        if (det < minDet) {
          minDet = det;
          at = `${pose.name} t${t}`;
        }
        minS = Math.min(minS, s2);
        maxS = Math.max(maxS, s1);
        const id_ = (kind: string) => `${kind}/${key}/t${t}`;
        if (det < 0) (counts.flip++, findings.set(id_("flip"), pose.name));
        else if (det < al.minDet) (counts.collapse++, findings.set(id_("collapse"), pose.name));
        else if (det > al.maxDet) (counts.overgrow++, findings.set(id_("overgrow"), pose.name));
        else if (s1 > al.maxStretch && abs > al.absGamePx) (counts.stretch++, findings.set(id_("stretch"), pose.name));
        else if (s2 < al.minStretch && abs > al.absGamePx) (counts.compress++, findings.set(id_("compress"), pose.name));
      }
    }
    worst[key] = `min det ${minDet.toFixed(3)} (${at}), stretch ${minS.toFixed(3)}..${maxS.toFixed(3)}`;
  }
  const errors = counts.flip + counts.collapse + counts.overgrow + counts.stretch + counts.compress;
  const sample = [...findings.entries()].slice(0, 8).map(([k, v]) => `${k} @ ${v}`).join(", ");
  return { gate: "geometry: flips, collapse, distortion on every sheet (hidden cap included)", ok: measured > 0 && errors === 0, measured, detail: `${poses.length} poses, ${measured} triangle-poses; flip ${counts.flip}, collapse ${counts.collapse}, overgrow ${counts.overgrow}, stretch ${counts.stretch}, compress ${counts.compress}${sample ? `; ${sample}` : ""}`, worst };
}

/** Points of a mesh contour at the current pose (canvas). */
function contourPoints(sk: Skeleton, c: CompiledContour): Pt[] {
  const buf = new Float32Array(c.pointCount * 2);
  sk.computeContourPoints(c, buf);
  const ox = (origins.get(sk) as AnimDocument["canvas"]).originX;
  const oy = (origins.get(sk) as AnimDocument["canvas"]).originY;
  const out: Pt[] = [];
  for (let i = 0; i < c.pointCount; i++) out.push([(buf[i * 2] as number) + ox, (buf[i * 2 + 1] as number) + oy]);
  return out;
}

function findContour(sk: Skeleton, ref: string): CompiledContour {
  const [slot, name] = ref.split("/") as [string, string];
  const c = sk.activeContours.find((x) => x.slot === slot && x.name === name);
  if (!c) throw new Error(`arm layer: no contour '${ref}'`);
  return c;
}

export interface Connection {
  /** The arm's closing contour (`slot/name`), its sheet (`slot/attachment`), the under sheet and the arm's shoulder bone. */
  closure: string;
  arm: string;
  under: string;
  pivot: string;
  clearance: number;
}

/**
 * Gate 3: shoulder overlap and closure. Per pose: overlap depth = how far the closing edge reaches
 * into the under sheet (max signed depth of its points, must be >= clearance), and enclosed gaps =
 * background pixels near the pivot enclosed by torso + arm fills (raster at 1 canvas px).
 */
export function closureGate(doc: AnimDocument, fillDoc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, connections: readonly Connection[], poses: readonly ArmLayerPose[]): GateResult & { perPose: string[] } {
  const sk = poseSkeleton(doc);
  const skF = poseSkeleton(fillDoc);
  let worstDepth = Infinity;
  let worstAt = "";
  let holes = 0;
  let fillHoles = 0;
  let measured = 0;
  const perPose: string[] = [];
  const R = 75;
  for (const pose of poses) {
    applyPose(sk, pose);
    applyPose(skF, pose);
    for (const con of connections) {
      const under = hullOf(sk, con.under, world(sk, con.under));
      const pts = contourPoints(sk, findContour(sk, con.closure));
      const depth = Math.max(...pts.map((p) => depthIn(p, under)));
      measured++;
      if (depth < worstDepth) {
        worstDepth = depth;
        worstAt = `${pose.name} ${con.closure}`;
      }
      // Raster closure (a disk around the pivot, 1 canvas px): background pixels enclosed by torso and
      // arm. Visible = the final render (fills and ink), which gates; fills only is reported as well.
      const pv = sk.getBone(con.pivot);
      const cx = pv.world.x + doc.canvas.originX;
      const cy = pv.world.y + doc.canvas.originY;
      const slots = new Set([con.under.split("/")[0], con.arm.split("/")[0], ...sk.slots.filter((s) => s.data.name.startsWith(`${con.arm.split("/")[0]}_`)).map((s) => s.data.name)]);
      const enclosedIn = (skel: Skeleton): number => {
        const size = 2 * R;
        const img = softRender(skel, textures, { width: size, height: size, left: cx - R - doc.canvas.originX, top: cy - R - doc.canvas.originY, slotFilter: (s) => slots.has(s.data.name) }).image;
        const bg = new Uint8Array(size * size);
        for (let i = 0; i < size * size; i++) bg[i] = (img.data[i * 4 + 3] as number) < 128 ? 1 : 0;
        const seen = new Uint8Array(size * size);
        const stack: number[] = [];
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (Math.hypot(x + 0.5 - R, y + 0.5 - R) >= R - 1 && bg[y * size + x]) (seen[y * size + x] = 1, stack.push(y * size + x));
        while (stack.length) {
          const i = stack.pop() as number;
          const x = i % size;
          const y = (i - x) / size;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = ny * size + nx;
            if (!bg[j] || seen[j] || Math.hypot(nx + 0.5 - R, ny + 0.5 - R) > R) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
        let n = 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (bg[y * size + x] && !seen[y * size + x] && Math.hypot(x + 0.5 - R, y + 0.5 - R) < R) n++;
        return n;
      };
      const enclosed = enclosedIn(sk);
      const fillOnly = enclosedIn(skF);
      fillHoles += fillOnly;
      holes += enclosed;
      perPose.push(`${pose.name} ${con.closure}: overlap ${depth.toFixed(1)} px, enclosed gap ${enclosed} px (fills only ${fillOnly})`);
    }
  }
  const clearance = Math.min(...connections.map((c) => c.clearance));
  return { gate: "closure: measured shoulder overlap and no visible enclosed gap", ok: measured > 0 && worstDepth >= clearance && holes === 0, measured, detail: `${measured} pose-connections; min overlap depth ${worstDepth.toFixed(2)} px (${worstAt}; need >= ${clearance}); enclosed gap pixels (final render) ${holes}; fills-only diagnostic ${fillHoles} px (under the ink)`, perPose };
}

/**
 * Gate 4: cap coverage. The under sheet's completion beneath the cap (its hull vertices within
 * `radius` of the pivot at bind, and inside the arm at bind) stays inside the arm's posed hull by
 * >= `margin` px at every normal pose.
 */
export function capCoverageGate(doc: AnimDocument, connections: readonly Connection[], poses: readonly ArmLayerPose[], radius: number, margin: number): GateResult {
  const sk = poseSkeleton(doc);
  sk.setToSetupPose();
  sk.updateWorldTransform("none");
  const tracked = connections.map((con) => {
    const under = hullOf(sk, con.under, world(sk, con.under));
    const arm = hullOf(sk, con.arm, world(sk, con.arm));
    const pv = sk.getBone(con.pivot);
    const c: Pt = [pv.world.x + doc.canvas.originX, pv.world.y + doc.canvas.originY];
    const ids = under.flatMap((p, i) => (Math.hypot(p[0] - c[0], p[1] - c[1]) <= radius && depthIn(p, arm) > 0 ? [i] : []));
    return { con, ids };
  });
  let measured = 0;
  let worst = Infinity;
  let at = "";
  for (const pose of poses) {
    applyPose(sk, pose);
    for (const { con, ids } of tracked) {
      const under = world(sk, con.under);
      const arm = hullOf(sk, con.arm, world(sk, con.arm));
      for (const i of ids) {
        const d = depthIn(under[i] as Pt, arm);
        measured++;
        if (d < worst) {
          worst = d;
          at = `${pose.name} ${con.under} v${i}`;
        }
      }
    }
  }
  const n = tracked.reduce((s, t) => s + t.ids.length, 0);
  return { gate: "cap coverage: torso completion under the cap stays covered (normal poses)", ok: n > 0 && measured > 0 && worst >= margin, measured, detail: `${n} under-cap hull vertices, ${poses.length} poses; min depth inside the arm ${worst.toFixed(2)} px (${at}; need >= ${margin})` };
}

/**
 * Gate 5: closing-edge ink. Per pose and closure point: buried deeper than half the stroke width
 * plus 1 px must be trimmed; outside the under sheet by more than 1 px must be inked. And the arm's
 * side contours (`keep`) are never trimmed by the under sheet (an arm in front of the chest keeps
 * its outline).
 * `buried`: the arm's other edges that leave the torso (the outer edge over the shoulder
 * when raised, the underside): wherever one is visible and buried in the torso like a closure
 * point, it must be trimmed (no stray line inside the shoulder).
 */
export function inkGate(doc: AnimDocument, connections: readonly Connection[], keep: readonly string[], poses: readonly ArmLayerPose[], buried: readonly string[] = []): GateResult {
  const sk = poseSkeleton(doc);
  let wrongBuried = 0;
  let wrongExposed = 0;
  let measured = 0;
  let keptTrim = 0;
  let exposedSeen = 0;
  let buriedSeen = 0;
  let strayEdge = 0;
  const notes: string[] = [];
  const inRuns = (runs: number[] | null, t: number) => {
    if (runs === null) return true;
    for (let k = 0; k + 1 < runs.length; k += 2) if (t >= (runs[k] as number) - 1e-6 && t <= (runs[k + 1] as number) + 1e-6) return true;
    return false;
  };
  for (const pose of poses) {
    applyPose(sk, pose);
    for (const con of connections) {
      const c = findContour(sk, con.closure);
      const under = hullOf(sk, con.under, world(sk, con.under));
      const pts = contourPoints(sk, c);
      const runs = sk.contourRuns(c);
      pts.forEach((p, i) => {
        const d = depthIn(p, under);
        measured++;
        const inked = inRuns(runs, i);
        if (d > c.width / 2 + 1) {
          buriedSeen++;
          if (inked) wrongBuried++;
        } else if (d < -1) {
          exposedSeen++;
          if (!inked) {
            // A later piece (hand, head, the other arm) may legitimately cover it: only the under sheet matters here.
            wrongExposed++;
          }
        }
      });
      for (const ref of buried) {
        if (!ref.startsWith(`${con.closure.split("/")[0]}/`)) continue;
        const b = findContour(sk, ref);
        if (!sk.isContourVisible(b) || b.color.a * sk.contourOwnerAlpha(b) < 0.01) continue;
        const br = sk.contourRuns(b);
        contourPoints(sk, b).forEach((p, i) => {
          if (depthIn(p, under) <= b.width / 2 + 1) return;
          buriedSeen++;
          if (inRuns(br, i)) (wrongBuried++, strayEdge++);
        });
      }
      for (const ref of keep) {
        const k = findContour(sk, ref);
        const kp = contourPoints(sk, k);
        const kr = sk.contourRuns(k);
        kp.forEach((p, i) => {
          if (depthIn(p, under) > k.width / 2 + 1 && !inRuns(kr, i)) keptTrim++;
        });
      }
    }
  }
  if (wrongExposed) notes.push(`exposed closure points not inked ${wrongExposed}`);
  if (buried.length) notes.push(`other arm edges buried but inked ${strayEdge} (${buried.join(", ")})`);
  return {
    gate: "ink: closing edge inked only where exposed; arm outline kept over the chest",
    ok: measured > 0 && buriedSeen > 0 && exposedSeen > 0 && wrongBuried === 0 && wrongExposed === 0 && keptTrim === 0,
    measured,
    detail: `${measured} closure point-poses (buried ${buriedSeen}, exposed ${exposedSeen}); buried but inked ${wrongBuried}; arm side points over the torso trimmed ${keptTrim}${notes.length ? `; ${notes.join("; ")}` : ""}`
  };
}

/** Gate 6: paint. Every sheet's texture is opaque under its triangles and one flat colour. */
export function paintGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, sheets: readonly string[]): GateResult {
  const sk = poseSkeleton(doc);
  const problems: string[] = [];
  const colours = new Set<string>();
  let measured = 0;
  for (const key of sheets) {
    const { mesh } = meshOf(sk, key);
    const tex = textures.get(mesh.path);
    if (!tex) {
      problems.push(`${key}: no texture '${mesh.path}'`);
      continue;
    }
    const uv = mesh.geometry.uvs;
    const tris = mesh.geometry.triangles;
    for (let t = 0; t < tris.length / 3; t++) {
      for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]] as const) {
        const ids = [tris[t * 3] as number, tris[t * 3 + 1] as number, tris[t * 3 + 2] as number];
        const u = wa * (uv[ids[0]! * 2] as number) + wb * (uv[ids[1]! * 2] as number) + wc * (uv[ids[2]! * 2] as number);
        const v = wa * (uv[ids[0]! * 2 + 1] as number) + wb * (uv[ids[1]! * 2 + 1] as number) + wc * (uv[ids[2]! * 2 + 1] as number);
        const x = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
        const y = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
        const o = (y * tex.width + x) * 4;
        measured++;
        if ((tex.data[o + 3] as number) < 255) problems.push(`${key} t${t}: alpha ${tex.data[o + 3]}`);
        colours.add(`${tex.data[o]},${tex.data[o + 1]},${tex.data[o + 2]}`);
      }
    }
  }
  if (colours.size !== 1) problems.push(`${colours.size} colours under the sheets (${[...colours].slice(0, 4).join(" | ")})`);
  return { gate: "paint: each sheet completed (opaque) in one colour, no seam", ok: measured > 0 && problems.length === 0, measured, detail: problems.length ? problems.slice(0, 6).join("; ") : `${measured} samples, opaque, one colour ${[...colours][0]}` };
}

/**
 * Gate 7 (review): arm-edge outline continuity over the torso. In every
 * across pose, each arm edge chain (the outer edge, the inner edge) is inked at full opacity and one
 * width wherever it lies over the under sheet (deeper than half its width + 1 px), except under the
 * arm's own later piece (`skip`: the fist slot, its posed quad). A missing, faded, trimmed or
 * narrower stroke is a gap; a chain with no point over the torso is unmeasured (fails).
 */
export function edgeContinuityGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, chains: readonly { name: string; contours: readonly string[]; under: string; skip: string; across: (pose: ArmLayerPose) => boolean }[], poses: readonly ArmLayerPose[]): GateResult {
  const sk = poseSkeleton(doc);
  let over = 0;
  let gaps = 0;
  const widths = new Set<number>();
  const where: string[] = [];
  const unmeasured = new Set(chains.map((c) => c.name));
  for (const pose of poses) {
    applyPose(sk, pose);
    for (const chain of chains) {
      if (!chain.across(pose)) continue;
      const under = hullOf(sk, chain.under, world(sk, chain.under));
      // The fist's opaque art (a later piece of the same arm) legitimately hides the edge under it.
      const hand = sk.getSlot(chain.skip);
      const o = origins.get(sk) as AnimDocument["canvas"];
      const W = 240;
      const hx = Math.round(hand.bone.world.x) - W / 2;
      const hy = Math.round(hand.bone.world.y) - W / 2;
      const mask = softRender(sk, textures, { width: W, height: W, left: hx, top: hy, slotFilter: (s) => s === hand }).image;
      // Within 3 px of the fist's opaque art: its outline polygon (the trim) is a 32-point approximation.
      const underFist = (p: Pt) => {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (dx * dx + dy * dy > 9) continue;
          const x = Math.floor(p[0] - o.originX - hx) + dx;
          const y = Math.floor(p[1] - o.originY - hy) + dy;
          if (x >= 0 && y >= 0 && x < W && y < W && (mask.data[(y * W + x) * 4 + 3] as number) > 128) return true;
        }
        return false;
      };
      // Every point of the chain over the torso must be inked by at least one member at full alpha.
      // Members absent from this rig (a fist outline before the extremity joins) are skipped.
      const members = chain.contours.flatMap((ref) => sk.activeContours.filter((x) => `${x.slot}/${x.name}` === ref));
      for (const c of members) widths.add(c.width);
      const inked = (p: Pt): boolean =>
        members.some((c) => {
          if (!sk.isContourVisible(c) || c.color.a * sk.contourOwnerAlpha(c) < 0.99) return false;
          const pts = contourPoints(sk, c);
          const runs = sk.contourRuns(c);
          for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i] as Pt;
            const b = pts[i + 1] as Pt;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
            if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) > 0.5) continue;
            const param = i + t;
            if (runs === null) return true;
            for (let k = 0; k + 1 < runs.length; k += 2) if (param >= (runs[k] as number) - 1e-6 && param <= (runs[k + 1] as number) + 1e-6) return true;
          }
          return false;
        });
      for (const c of members) {
        for (const p of contourPoints(sk, c)) {
          if (depthIn(p, under) <= c.width / 2 + 1 || underFist(p)) continue;
          over++;
          unmeasured.delete(chain.name);
          if (!inked(p)) {
            gaps++;
            if (where.length < 6) where.push(`${pose.name} ${chain.name} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`);
          }
        }
      }
    }
  }
  const ok = gaps === 0 && over > 0 && unmeasured.size === 0 && widths.size === 1;
  return { gate: "arm edges over the torso: continuous, full opacity, one width (across poses)", ok, measured: over, detail: `${poses.length} poses, ${over} edge points over the torso; gaps ${gaps}${where.length ? ` (${where.join("; ")})` : ""}; widths ${[...widths].join("/")}${unmeasured.size ? `; unmeasured ${[...unmeasured].join(", ")}` : ""}` };
}

/**
 * Gate 8 (review): the torso silhouette outline. In every pose, each point
 * of the torso's outline contours that is exposed (no other piece drawn over it there: the arms,
 * fists, head; rendered without the torso) is inked at full opacity, so the torso keeps its outline
 * wherever an arm swings away and hands over to the arm's own outline where the arm covers it.
 */
export function torsoOutlineGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, torsoSlot: string, sheet: string, contours: readonly string[], poses: readonly ArmLayerPose[]): GateResult {
  const sk = poseSkeleton(doc);
  const o = origins.get(sk) as AnimDocument["canvas"];
  let exposed = 0;
  let gaps = 0;
  const where: string[] = [];
  for (const pose of poses) {
    applyPose(sk, pose);
    const members = contours.map((ref) => findContour(sk, ref));
    const all = members.flatMap((c) => contourPoints(sk, c));
    const x0 = Math.floor(Math.min(...all.map((p) => p[0]))) - 8;
    const y0 = Math.floor(Math.min(...all.map((p) => p[1]))) - 8;
    const w = Math.ceil(Math.max(...all.map((p) => p[0]))) + 8 - x0;
    const h = Math.ceil(Math.max(...all.map((p) => p[1]))) + 8 - y0;
    const others = softRender(sk, textures, { width: w, height: h, left: x0 - o.originX, top: y0 - o.originY, slotFilter: (s) => s.data.name !== torsoSlot }).image;
    const covered = (p: Pt) => {
      const x = Math.floor(p[0] - x0);
      const y = Math.floor(p[1] - y0);
      return x >= 0 && y >= 0 && x < w && y < h && (others.data[(y * w + x) * 4 + 3] as number) > 8;
    };
    // The torso's posed hull (not the contour points: a missing contour must count as a gap).
    const hull = hullOf(sk, sheet, world(sk, sheet));
    const inked = (p: Pt): boolean =>
      members.some((c) => {
        if (!sk.isContourVisible(c) || c.color.a * sk.contourOwnerAlpha(c) < 0.99) return false;
        const pts = contourPoints(sk, c);
        const runs = sk.contourRuns(c);
        for (let i = 0; i + 1 < pts.length; i++) {
          const a2 = pts[i] as Pt;
          const b2 = pts[i + 1] as Pt;
          const dx = b2[0] - a2[0];
          const dy = b2[1] - a2[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a2[0]) * dx + (p[1] - a2[1]) * dy) / (dx * dx + dy * dy || 1)));
          if (Math.hypot(p[0] - a2[0] - t * dx, p[1] - a2[1] - t * dy) > 0.5) continue;
          if (runs === null) return true;
          for (let k = 0; k + 1 < runs.length; k += 2) if (i + t >= (runs[k] as number) - 1e-6 && i + t <= (runs[k + 1] as number) + 1e-6) return true;
        }
        return false;
      });
    const reach = Math.max(...members.map((c) => c.width), 10);
    for (const p of hull) {
      // Hull on the mirror line (the waist and neck cuts) is not silhouette; points within a stroke
      // width of a covering piece are the hand-over zone (the trim end).
      let near = false;
      for (let dy = -reach; dy <= reach && !near; dy += 2) for (let dx = -reach; dx <= reach && !near; dx += 2) if (dx * dx + dy * dy <= reach * reach && covered([p[0] + dx, p[1] + dy])) near = true;
      if (near || Math.abs(p[1] - Math.max(...hull.map((q) => q[1]))) < 1 || Math.abs(p[1] - Math.min(...hull.map((q) => q[1]))) < 1) continue;
      exposed++;
      if (!inked(p)) {
        gaps++;
        if (where.length < 6) where.push(`${pose.name} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`);
      }
    }
  }
  return { gate: "torso silhouette: outlined wherever exposed (every pose)", ok: exposed > 0 && gaps === 0, measured: exposed, detail: `${poses.length} poses, ${exposed} exposed outline points; gaps ${gaps}${where.length ? ` (${where.join("; ")})` : ""}` };
}

/**
 * Gate 9: the wrist / fist join. Per pose and arm, within `radius` canvas
 * px of the wrist (the hand bone's pivot): (a) no open stroke end: every visible run end of the
 * arm's and fist's strokes lies on another visible stroke of that arm (within half a width); (b) no
 * exposed skin: rendering the arm and fist alone, no skin pixel (opaque, light) touches transparency
 * directly (every edge of the arm + fist union is ink).
 */
export function wristGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, sides: readonly { slots: readonly string[]; hand: string }[], poses: readonly ArmLayerPose[], radius = 45, skin?: readonly [number, number, number]): GateResult {
  const sk = poseSkeleton(doc);
  const o = origins.get(sk) as AnimDocument["canvas"];
  let openEnds = 0;
  let skinPx = 0;
  let fistPast = 0;
  let missingFist = 0;
  let ends = 0;
  const where: string[] = [];
  for (const pose of poses) {
    applyPose(sk, pose);
    for (const side of sides) {
      const handBone = sk.getSlot(side.hand).bone;
      const wx = handBone.world.x + o.originX;
      const wy = handBone.world.y + o.originY;
      const strokes = sk.activeContours
        .filter((c) => side.slots.includes(c.slot) && sk.isContourVisible(c) && c.color.a * sk.contourOwnerAlpha(c) >= 0.5)
        .map((c) => {
          const pts = contourPoints(sk, c);
          const runs = sk.contourRuns(c) ?? [0, pts.length - 1];
          return { c, pts, runs };
        });
      const at = (pts: Pt[], t: number): Pt => {
        const i = Math.min(pts.length - 2, Math.max(0, Math.floor(t)));
        const f = t - i;
        const a = pts[i] as Pt;
        const b = pts[i + 1] as Pt;
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      };
      const onOther = (p: Pt, self: (typeof strokes)[number], selfRun: number) =>
        strokes.some((s) => {
          for (let k = 0; k + 1 < s.runs.length; k += 2) {
            if (s === self && k === selfRun) continue;
            const lo = s.runs[k] as number;
            const hi = s.runs[k + 1] as number;
            for (let t = lo; t < hi; t += 0.25) {
              const q = at(s.pts, t);
              if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= s.c.width / 2) return true;
            }
          }
          return false;
        });
      for (const s of strokes) {
        for (let k = 0; k + 1 < s.runs.length; k += 2) {
          for (const t of [s.runs[k] as number, s.runs[k + 1] as number]) {
            const p = at(s.pts, t);
            if (Math.hypot(p[0] - wx, p[1] - wy) > radius) continue;
            ends++;
            if (!onOther(p, s, k)) {
              openEnds++;
              if (where.length < 6) where.push(`${pose.name} open end ${s.c.slot}/${s.c.name} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`);
            }
          }
        }
      }
      const R = radius;
      const size = 2 * R;
      const img = softRender(sk, textures, { width: size, height: size, left: wx - R - o.originX, top: wy - R - o.originY, slotFilter: (sl) => side.slots.some((n) => sl.data.name === n || sl.data.name.startsWith(`${n}_`)) }).image;
      const a = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : (img.data[(y * size + x) * 4 + 3] as number));
      let here = 0;
      let first = "";
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if ((img.data[i + 3] as number) < 200 || Math.hypot(x - R, y - R) > R - 2) continue;
        const lum = 0.3 * (img.data[i] as number) + 0.59 * (img.data[i + 1] as number) + 0.11 * (img.data[i + 2] as number);
        if (lum < 140) continue;
        if (a(x + 1, y) < 20 || a(x - 1, y) < 20 || a(x, y + 1) < 20 || a(x, y - 1) < 20) {
          here++;
          first ||= `(${(x + wx - R).toFixed(0)}, ${(y + wy - R).toFixed(0)})`;
        }
      }
      skinPx += here;
      // (c) the fist's art stays inside its outline: opaque fist pixels past the stroke's outer edge (half a width) outside
      // the fist outline closed across the wrist (the tan wrist wedge of the raw art fails this).
      const fo = sk.activeContours.find((c) => c.slot === side.hand && c.name === "outline");
      let past = 0;
      let pastAt = "";
      if (!fo) {
        missingFist++;
        if (where.length < 6) where.push(`${pose.name} ${side.hand}: no fist outline`);
      } else {
        const loop = contourPoints(sk, fo);
        const fist = softRender(sk, textures, { width: size, height: size, left: wx - R - o.originX, top: wy - R - o.originY, slotFilter: (sl) => sl.data.name === side.hand, }).image;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const fi = (y * size + x) * 4;
          if ((fist.data[fi + 3] as number) < 128) continue;
          // the wrist band repainted with the limb's own flat skin is invisible over the forearm it overlaps
          if (skin && Math.abs((fist.data[fi] as number) - skin[0]) + Math.abs((fist.data[fi + 1] as number) - skin[1]) + Math.abs((fist.data[fi + 2] as number) - skin[2]) <= 9) continue;
          const p: Pt = [x + 0.5 + wx - R, y + 0.5 + wy - R];
          // the region overlaps the limb up to 6 px past the wrist chord (the cut's declared overlap)
          if (pointInPolygon(p, loop) || distToPolyline(p, loop) <= fo.width / 2 || distToPolyline(p, [loop[0] as Pt, loop[loop.length - 1] as Pt]) <= 6) continue;
          past++;
          pastAt ||= `(${p[0].toFixed(0)}, ${p[1].toFixed(0)}) chord (${(loop[0] as Pt)[0].toFixed(0)}, ${(loop[0] as Pt)[1].toFixed(0)})-(${(loop[loop.length - 1] as Pt)[0].toFixed(0)}, ${(loop[loop.length - 1] as Pt)[1].toFixed(0)})`;
        }
        fistPast += past;
        if (past && where.length < 6) where.push(`${pose.name} ${side.hand}: ${past} fist px past its outline, first ${pastAt}`);
      }
      if (here && where.length < 6) where.push(`${pose.name} ${side.hand}: ${here} skin px at the edge, first ${first}`);
    }
  }
  return { gate: "wrist / fist join: no open stroke end, no skin past the strokes", ok: ends > 0 && openEnds === 0 && skinPx === 0 && fistPast === 0 && missingFist === 0, measured: ends, detail: `${poses.length} poses; ${ends} stroke ends near the wrists, open ${openEnds}; exposed skin edge px ${skinPx}; fist art px past the fist outline ${fistPast}; missing fist outlines ${missingFist}${where.length ? ` (${where.join("; ")})` : ""}` };
}

/**
 * Gate 10 (review): crossed arms. When the arms overlap, the front arm (its
 * sheet, strokes and fist; `front` slot names) draws wholly in front of the back arm (`back`): inside
 * the front arm's own footprint (rendered alone), the full render equals the render without the
 * back arm (no back stroke or fist art shows through or over it).
 */
export function crossedArmsGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, front: readonly string[], back: readonly string[], poses: readonly ArmLayerPose[], rect: readonly [number, number, number, number]): GateResult {
  const sk = poseSkeleton(doc);
  const o = origins.get(sk) as AnimDocument["canvas"];
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const inList = (list: readonly string[], name: string) => list.includes(name);
  let measured = 0;
  let through = 0;
  const where: string[] = [];
  for (const pose of poses) {
    applyPose(sk, pose);
    const opts = { width: w, height: h, left: x0 - o.originX, top: y0 - o.originY };
    const full = softRender(sk, textures, opts).image;
    const noBack = softRender(sk, textures, { ...opts, slotFilter: (s) => !inList(back, s.data.name) }).image;
    const frontOnly = softRender(sk, textures, { ...opts, slotFilter: (s) => inList(front, s.data.name) }).image;
    // The front arm's footprint: its opaque pixels plus any hole they enclose (a hole inside the
    // front fist is part of the front arm; the back arm showing through it is a failure).
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = (frontOnly.data[i * 4 + 3] as number) >= 250 ? 1 : 0;
    const outside = new Uint8Array(w * h);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (!solid[y * w + x]) (outside[y * w + x] = 1, stack.push(y * w + x));
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (!solid[y * w + x] && !outside[y * w + x]) (outside[y * w + x] = 1, stack.push(y * w + x));
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (solid[j] || outside[j]) continue;
        outside[j] = 1;
        stack.push(j);
      }
    }
    let here = 0;
    for (let i = 0; i < w * h; i++) {
      if (outside[i]) continue;
      measured++;
      let d = 0;
      for (let k = 0; k < 4; k++) d += Math.abs((full.data[i * 4 + k] as number) - (noBack.data[i * 4 + k] as number));
      if (d > 12) here++;
    }
    through += here;
    if (here && where.length < 6) where.push(`${pose.name}: ${here} px`);
  }
  return { gate: "crossed arms: the front arm draws wholly over the back arm", ok: measured > 0 && through === 0, measured, detail: `${poses.length} poses, ${measured} front-arm px; back arm showing through or over the front arm ${through} px${where.length ? ` (${where.join("; ")})` : ""}` };
}

/**
 * Gate 11 (review): line ends. Where a stroke ends over the body, it
 * must join the line it meets at full ink or be wholly hidden: no visible feathered (partial
 * alpha) ink end. Per pose, the final render around each shoulder pivot (radius `radius` canvas px,
 * all slots drawn) records the feather of the topmost stroke per pixel (softRender partialInk); a
 * pixel whose topmost ink is more than 10 % short of full ink because of a trim feather is a fault.
 */
export function lineEndGate(doc: AnimDocument, textures: ReadonlyMap<string, RgbaImage>, pivots: readonly string[], poses: readonly ArmLayerPose[], radius = 90): GateResult & { where: string[] } {
  const sk = poseSkeleton(doc);
  let faults = 0;
  let measured = 0;
  const where: string[] = [];
  const size = 2 * radius;
  const partialInk = new Float32Array(size * size);
  const partialSource = new Int32Array(size * size);
  const byContour = new Map<string, number>();
  for (const pose of poses) {
    applyPose(sk, pose);
    for (const pivot of pivots) {
      const pv = sk.getBone(pivot).world;
      softRender(sk, textures, { width: size, height: size, left: pv.x - radius, top: pv.y - radius, partialInk, partialSource });
      measured++;
      let n = 0;
      let fx = 0;
      let fy = 0;
      for (let i = 0; i < partialInk.length; i++) if ((partialInk[i] as number) > 0.1) {
        const c = sk.activeContours.find((x) => x.id === (partialSource[i] as number) - 1);
        const key = c ? `${c.slot}/${c.name}` : "?";
        byContour.set(key, (byContour.get(key) ?? 0) + 1);
        if (!n) (fx = (i % size) + pv.x - radius + doc.canvas.originX), (fy = Math.floor(i / size) + pv.y - radius + doc.canvas.originY);
        n++;
      }
      if (n) {
        faults += n;
        if (where.length < 8) where.push(`${pose.name} ${pivot}: ${n} px (first at ${fx.toFixed(0)}, ${fy.toFixed(0)})`);
      }
    }
  }
  return { gate: "line ends: no visible feathered ink end (joins at full ink or hidden)", ok: measured > 0 && faults === 0, measured, detail: `${poses.length} poses, ${measured} shoulder renders; visible feathered ink px ${faults}${byContour.size ? ` [${[...byContour].map(([k, v]) => `${k} ${v}`).join(", ")}]` : ""}${where.length ? ` (${where.join("; ")})` : ""}`, where };
}

/**
 * Gate 12 (inward elbow fold): open line ends. Within `radius` of each pivot (the
 * elbows), every end of a visible run of a full-ink open contour (a contour end or a trim end) must
 * meet another visible full-ink line (within half a width + 1.5 px of its centreline: a chain
 * continuation, a join, a hand-over or a T against a line) or lie outside every skin (at the
 * silhouette, where the background takes over). An end inside the skin with no line to meet is an
 * open crease end (the -60 / -85 forearm edge ending in the arm before the fold fader).
 */
export function openEndGate(doc: AnimDocument, pivots: readonly string[], poses: readonly ArmLayerPose[], radius = 70): GateResult & { where: string[] } {
  const sk = poseSkeleton(doc);
  let ends = 0;
  let open = 0;
  const where: string[] = [];
  const ox = doc.canvas.originX;
  const oy = doc.canvas.originY;
  for (const pose of poses) {
    applyPose(sk, pose);
    const lines: { c: CompiledContour; pts: Float32Array; runs: number[] }[] = [];
    for (const c of sk.activeContours) {
      if (c.closed || !sk.isContourVisible(c) || c.color.a * sk.contourOwnerAlpha(c) < 0.99) continue;
      const pts = new Float32Array(c.pointCount * 2);
      sk.computeContourPoints(c, pts);
      const r = sk.contourHandoverRuns(c, pts) ?? sk.contourRuns(c, pts);
      lines.push({ c, pts, runs: r ? [...r] : [0, c.pointCount - 1] });
    }
    // Skin silhouettes (posed meshes and opaque regions) for the inside test.
    const skins: Pt[][] = [];
    for (const slot of sk.drawOrder) {
      if (slot.hidden || !slot.bone.active) continue;
      const att = slot.attachment;
      if (!att || att.type !== "mesh") continue;
      const v = world(sk, `${slot.data.name}/${att.name}`).map(([x, y]) => [x - ox, y - oy] as Pt);
      const tris = att.geometry.triangles;
      for (let t = 0; t + 2 < tris.length; t += 3) skins.push([v[tris[t] as number] as Pt, v[tris[t + 1] as number] as Pt, v[tris[t + 2] as number] as Pt]);
    }
    const at = (pts: Float32Array, n: number, t: number): Pt => {
      const k = Math.max(0, Math.min(Math.floor(t), n - 2));
      const f = t - k;
      return [(pts[k * 2] as number) + ((pts[k * 2 + 2] as number) - (pts[k * 2] as number)) * f, (pts[k * 2 + 1] as number) + ((pts[k * 2 + 3] as number) - (pts[k * 2 + 1] as number)) * f];
    };
    const centres = pivots.map((p) => sk.getBone(p).world);
    for (const a of lines) {
      for (let r = 0; r + 1 < a.runs.length; r += 2) for (let e = 0; e < 2; e++) {
        const p = at(a.pts, a.c.pointCount, a.runs[r + e] as number);
        if (!centres.some((cv) => Math.hypot(p[0] - cv.x, p[1] - cv.y) <= radius)) continue;
        ends++;
        const reach = a.c.width / 2 + 1.5;
        const met = lines.some((b) => {
          if (b === a) return false;
          for (let q = 0; q + 1 < b.runs.length; q += 2) {
            const r0 = b.runs[q] as number;
            const r1 = b.runs[q + 1] as number;
            for (let t = r0; t <= r1 + 1e-9; t = t + 0.25 > r1 && t < r1 ? r1 : t + 0.25) {
              const s = at(b.pts, b.c.pointCount, t);
              if (Math.hypot(s[0] - p[0], s[1] - p[1]) <= reach) return true;
              if (t >= r1) break;
            }
          }
          return false;
        });
        if (met) continue;
        // Inside the skin: the end's point lies inside some posed skin triangle by more than half a width.
        const inside = skins.some((tri) => pointInPolygon(p, tri)) && [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
          const q: Pt = [p[0] + Math.cos((k * Math.PI) / 4) * reach, p[1] + Math.sin((k * Math.PI) / 4) * reach];
          return skins.some((tri) => pointInPolygon(q, tri));
        });
        if (!inside) continue;
        open++;
        if (where.length < 8) where.push(`${pose.name}: ${a.c.slot}/${a.c.name} ${e ? "end" : "start"} at (${(p[0] + ox).toFixed(0)}, ${(p[1] + oy).toFixed(0)})`);
      }
    }
  }
  return { gate: "open ends: every line end near the elbows meets another line or the silhouette", ok: ends > 0 && open === 0, measured: ends, detail: `${poses.length} poses, ${ends} line ends near ${pivots.join(", ")}; open in skin ${open}${where.length ? ` (${where.join("; ")})` : ""}`, where };
}
