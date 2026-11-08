/*
 * Atlas Animator: original implementation.
 *
 * Bilateral mirror of a finished half-body rig: the
 * solved, baked and reduced half is the offline solving unit; this compiles it and its mirror about
 * the vertical line x = rule.x (canvas px) into ONE skin per mesh. Exact by construction:
 * - a mirrored bone R of a left bone L has world transform M W_L S (M the canvas reflection,
 *   S = diag(1, -1)); a shared (centre) bone's own reflection is S_B = W_B^-1 M W_B at bind (it must
 *   sit on the line and be diag(+-1, -+1)). Local transforms follow: t_R = S_P t_L, linear
 *   S_P R(theta) S. Every rotation delta negates under the mirror, so limits [min, max] become
 *   [-max, -min] and driver keys, grid axes, pose-limit polygons and contact cells negate;
 * - bone-local vertex positions and corrective offsets (encoded per influence in its bone's frame)
 *   map through S_B of their bone, which holds at every mirrored pose, not just at bind;
 * - centreline vertices (|x - rule.x| <= tolerance at bind; trunk influences only, no corrective
 *   offsets) are welded: one vertex shared by both halves; mirrored triangles reverse winding;
 * - the hull is re-cut into one loop (the centre-cut edge becomes interior), contours that end on
 *   the centreline join their mirror into one contour, and midline regions (head art) are rebuilt
 *   full width from their source art; mesh textures are re-painted symmetric about the line.
 * Explicit left/right correspondence is returned (per mesh: pairs and centre vertices).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";
import type { MeshAttachment } from "../core/attachments.js";
import type { RgbaImage } from "./image.js";
import { opaqueOutline } from "./bodyContours.js";

export interface MirrorRule {
  /** The mirror line, canvas x. */
  x: number;
  /** Name suffix pairs, left first (e.g. ["_l", "_r"]). */
  rename: readonly (readonly [string, string])[];
  /** Slots the suffix rule cannot reach (left name -> right name). */
  slots?: Readonly<Record<string, string>>;
}

/** Source art for a region attachment on a centre bone, rebuilt full width (crop and keep in canvas px). */
export interface CentreRegionSource {
  image: RgbaImage;
  crop: readonly [number, number, number, number];
  keep?: readonly (readonly [number, number])[] | undefined;
  /** Use the art's own far side instead of mirroring the source side (breaks bind symmetry). */
  asymmetric?: boolean | undefined;
}

export interface MirrorCorrespondence {
  /** Final vertex indices: [left, right] pairs and the welded centre vertices. */
  pairs: [number, number][];
  centre: number[];
  /** Triangles [0, left) are the left half; [left, 2 left) their mirrors in the same order. */
  leftTriangles: number;
  /** Detached side sheet (arm layer): the reflected copy's `slot/attachment`; pairs are [i, i] across the two meshes. */
  far?: string;
}

export interface MirrorResult {
  doc: Record<string, any>;
  textures: Map<string, RgbaImage>;
  bones: Record<string, string>;
  slots: Record<string, string>;
  /** By `slot/attachment`. */
  meshes: Record<string, MirrorCorrespondence>;
  report: string[];
}

type M2 = [number, number, number, number];
const mul = (p: M2, q: M2): M2 => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const inv = (p: M2): M2 => {
  const det = p[0] * p[3] - p[1] * p[2];
  return [p[3] / det, -p[1] / det, -p[2] / det, p[0] / det];
};
const apply = (p: M2, x: number, y: number): [number, number] => [p[0] * x + p[1] * y, p[2] * x + p[3] * y];
const FLIP_Y: M2 = [1, 0, 0, -1];
const MIRROR: M2 = [-1, 0, 0, 1];
const r4 = (x: number) => Number(x.toFixed(4));
const r6 = (x: number) => Number(x.toFixed(6));

/** A contour visibility rule (format `visible`) on the mirrored side: right bone, range [-max, -min]. */
export function mirrorVisible(rules: readonly { bone: string; min: number; max: number }[] | undefined, bones: Readonly<Record<string, string>>): { bone: string; min: number; max: number }[] {
  return (rules ?? []).map((r) => ({ bone: bones[r.bone] ?? r.bone, min: -r.max + 0, max: -r.min + 0 }));
}

/** True when a contour's visibility reads the same on both halves (none, or centre bones with min = -max): only then may its halves join. */
export function joinableVisible(rules: readonly { bone: string; min: number; max: number }[] | undefined, bones: Readonly<Record<string, string>>): boolean {
  return (rules ?? []).every((r) => (bones[r.bone] ?? r.bone) === r.bone && Math.abs(r.min + r.max) < 1e-9);
}

/** A contour owner on the mirrored side: the slot through the slot map, a side-suffixed attachment name renamed. */
export function mirrorOwner(owner: { skin?: string; slot: string; attachment: string }, slots: Readonly<Record<string, string>>, rename: readonly (readonly [string, string])[]): { skin?: string; slot: string; attachment: string } {
  let attachment = owner.attachment;
  for (const [a, b] of rename) {
    if (attachment.endsWith(a)) {
      attachment = attachment.slice(0, attachment.length - a.length) + b;
      break;
    }
  }
  return { ...owner, slot: slots[owner.slot] ?? owner.slot, attachment };
}

export function mirrorRig(raw: Record<string, any>, textures: ReadonlyMap<string, RgbaImage>, rule: MirrorRule, centreRegions: Readonly<Record<string, CentreRegionSource>> = {}, tolerance = 1e-3): MirrorResult {
  const report: string[] = [];
  const doc0 = loadAnimDocument(raw);
  const ox = doc0.canvas.originX;
  const oy = doc0.canvas.originY;
  const skeleton = new Skeleton(doc0);
  skeleton.setActiveSkins(Object.keys(doc0.skins));
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("none");
  const suffix = (n: string): string | null => {
    for (const [a, b] of rule.rename) if (n.endsWith(a)) return n.slice(0, n.length - a.length) + b;
    return null;
  };
  const otherName = (n: string): string => suffix(n) ?? `${n}${rule.rename[0]?.[1] ?? "_r"}`;
  // Inputs this mirror does not carry yet are rejected, not silently dropped.
  for (const [skinName, sk] of Object.entries(raw.skins as Record<string, any>)) {
    if (sk.coverage && Object.keys(sk.coverage.regions ?? {}).length) throw new Error(`mirror: skin '${skinName}' declares coverage regions; mirroring coverage is not supported yet`);
    if ((sk.constraints ?? []).length) throw new Error(`mirror: skin '${skinName}' activates constraints; mirroring skin constraints is not supported yet`);
  }

  // --- bones ------------------------------------------------------------------------------------
  const bones: Record<string, string> = {};
  const S = new Map<string, M2>();
  const rawBones: any[] = raw.bones;
  for (const b of rawBones) {
    const r = suffix(b.name);
    if (r) {
      bones[b.name] = r;
      S.set(b.name, FLIP_Y);
      continue;
    }
    bones[b.name] = b.name;
    const w = skeleton.getBone(b.name).world;
    if (Math.abs(w.x + ox - rule.x) > tolerance) throw new Error(`mirror: shared bone '${b.name}' is off the mirror line (x ${(w.x + ox).toFixed(3)} vs ${rule.x}); give it a ${rule.rename[0]?.[0]} name or move it onto the line`);
    const W: M2 = [w.a, w.b, w.c, w.d];
    const s = mul(inv(W), mul(MIRROR, W));
    const diag = Math.abs(s[1]) < 1e-6 && Math.abs(s[2]) < 1e-6 && Math.abs(Math.abs(s[0]) - 1) < 1e-6 && Math.abs(s[0] + s[3]) < 1e-6;
    if (!diag) throw new Error(`mirror: shared bone '${b.name}' is not aligned with the mirror line (reflection in its frame ${s.map((v) => v.toFixed(3)).join(", ")})`);
    S.set(b.name, [Math.sign(s[0]), 0, 0, Math.sign(s[3])]);
  }
  const newBones: any[] = [];
  for (const b of rawBones) {
    if (!suffix(b.name)) continue;
    for (const k of ["scaleX", "scaleY", "shearX", "shearY"]) if (b[k] !== undefined && b[k] !== (k.startsWith("scale") ? 1 : 0)) throw new Error(`mirror: bone '${b.name}' has a setup ${k}; not supported`);
    const sp = b.parent ? (S.get(b.parent) as M2) : MIRROR;
    const t = apply(sp, b.x ?? 0, b.y ?? 0);
    const th = ((b.rotation ?? 0) * Math.PI) / 180;
    const lin = mul(sp, mul([Math.cos(th), -Math.sin(th), Math.sin(th), Math.cos(th)], FLIP_Y));
    const rot = (Math.atan2(lin[2], lin[0]) * 180) / Math.PI;
    const e: any = { ...b, name: bones[b.name], ...(b.parent ? { parent: bones[b.parent] } : {}) };
    delete e.x;
    delete e.y;
    delete e.rotation;
    if (Math.abs(t[0]) > 1e-9) e.x = r4(t[0]);
    if (Math.abs(t[1]) > 1e-9) e.y = r4(t[1]);
    if (Math.abs(rot) > 1e-9) e.rotation = r4(rot);
    if (b.limits) e.limits = { min: -b.limits.max, max: -b.limits.min };
    // Keep the key order of the source for readability.
    newBones.push(Object.fromEntries(Object.keys({ name: 0, parent: 0, x: 0, y: 0, rotation: 0, ...b, ...e }).filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
  }

  // --- slots ------------------------------------------------------------------------------------
  const slots: Record<string, string> = {};
  for (const s of raw.slots as any[]) slots[s.name] = rule.slots?.[s.name] ?? suffix(s.name) ?? (suffix(s.bone) ? otherName(s.name) : s.name);
  const slotList: any[] = [];
  // Draw anchors follow the slot map (a right slot draws after the right partner of its left anchor).
  const mirroredSlots = (raw.slots as any[]).filter((s) => slots[s.name] !== s.name).map((s) => ({ ...s, name: slots[s.name], bone: bones[s.bone], ...(s.drawAfter ? { drawAfter: slots[s.drawAfter] ?? s.drawAfter } : {}), ...(s.drawBefore ? { drawBefore: slots[s.drawBefore] ?? s.drawBefore } : {}) }));
  const lastSide = Math.max(...(raw.slots as any[]).map((s, i) => (slots[s.name] !== s.name ? i : -1)));
  (raw.slots as any[]).forEach((s, i) => {
    slotList.push(s);
    if (i === lastSide) slotList.push(...mirroredSlots);
  });

  // --- meshes -----------------------------------------------------------------------------------
  /** `far`: a detached side sheet (arm layer), reflected whole into this slot instead of welded. */
  type MeshInfo = { key: string; skin: string; slot: string; name: string; n: number; right: number[]; perm: number[]; boneOf: (b: number) => number; infl: { b: number; x: number; y: number; w: number }[][]; T: number; far?: string };
  const meshes = new Map<string, MeshInfo>();
  const out = structuredClone(raw);
  out.bones = [...rawBones, ...newBones];
  out.slots = slotList;
  const outTextures = new Map(textures);
  const corr: Record<string, MirrorCorrespondence> = {};
  const skinNames = Object.keys(raw.skins);
  // First pass: geometry of every weighted mesh.
  for (const skinName of skinNames) {
    for (const [slotName, atts] of Object.entries(raw.skins[skinName].attachments as Record<string, Record<string, any>>)) {
      for (const [attName, m] of Object.entries(atts)) {
        if (m.type === "region") {
          const boneName = (raw.slots as any[]).find((s) => s.name === slotName)?.bone as string;
          if (suffix(boneName)) {
            // Side region (r3: an art fist on the hand): R = M W_L S, so the far copy
            // sits at local (x, -y), rotation -r on the mirrored bone, its texture flipped in v.
            const tex = textures.get(m.path);
            if (!tex) throw new Error(`mirror: no texture '${m.path}'`);
            const img = { width: tex.width, height: tex.height, data: new Uint8Array(tex.data.length) };
            for (let y = 0; y < tex.height; y++) img.data.set(tex.data.subarray((tex.height - 1 - y) * tex.width * 4, (tex.height - y) * tex.width * 4), y * tex.width * 4);
            const path = `${m.path}${rule.rename[0]?.[1] ?? "_r"}`;
            outTextures.set(path, img);
            const far = slots[slotName] as string;
            ((out.skins[skinName].attachments[far] ??= {}) as Record<string, any>)[attName] = { ...m, path, y: r4(-(m.y ?? 0)), rotation: r4(-(m.rotation ?? 0)), ...(Array.isArray(m.opaque) ? { opaque: flipOpaqueV(m.opaque) } : {}) };
            report.push(`region ${slotName}/${attName}: mirrored onto ${far} (local y and rotation negated, texture and opaque outline flipped in v)`);
            continue;
          }
          const src = centreRegions[m.path];
          if (!src) throw new Error(`mirror: centre region '${m.path}' needs its source art (full-width rebuild)`);
          const [cx, cy, cw, ch] = src.crop;
          const x0 = Math.min(cx, 2 * rule.x - (cx + cw));
          const x1 = Math.max(cx + cw, 2 * rule.x - cx);
          const keep = src.keep ? symmetricPolygon(src.keep, rule.x, tolerance) : null;
          const w = Math.round(x1 - x0);
          const img = { width: w, height: ch, data: new Uint8Array(w * ch * 4) };
          for (let y = 0; y < ch; y++) {
            for (let x = 0; x < w; x++) {
              const cxp = Math.round(x0) + x + 0.5;
              if (keep && !inPolygon(cxp, cy + y + 0.5, keep)) continue;
              // Bilateral art: the far side is the mirror of the source side, so the rig is symmetric
              // at bind and the pose limits measured on the solved side hold on the mirrored one.
              const px = Math.floor(src.asymmetric || (cxp < rule.x) === (cx + cw / 2 < rule.x) ? cxp : 2 * rule.x - cxp);
              if (px < 0 || px >= src.image.width) continue;
              const s = ((cy + y) * src.image.width + px) * 4;
              img.data.set(src.image.data.subarray(s, s + 4), (y * w + x) * 4);
            }
          }
          outTextures.set(m.path, img);
          const wb = skeleton.getBone(boneName).world;
          const dl = apply(inv([wb.a, wb.b, wb.c, wb.d]), x0 + w / 2 - (cx + cw / 2), 0);
          // Pixels and coverage metadata change together: an opaque outline of the source crop is
          // re-taken from the rebuilt full-width art (its u, v would name the old crop's texels).
          const opaque = m.opaque ? opaqueOutline(img) : null;
          const rebuilt: Record<string, unknown> = { ...m, x: r4(m.x + dl[0]), y: r4(m.y + dl[1]), width: w };
          if (opaque) rebuilt.opaque = opaque;
          else delete rebuilt.opaque;
          out.skins[skinName].attachments[slotName][attName] = rebuilt;
          report.push(`region ${slotName}/${attName}: rebuilt full width ${w} x ${ch} (canvas x ${x0}..${x1}, ${src.asymmetric ? "own far-side art" : "far side mirrored from the source side"})${keep ? `, keep ${keep.length} points` : ""}`);
          continue;
        }
        if (m.type === "point") {
          // A side point (a contour fader): the far copy sits at local (x, -y), rotation negated.
          const boneName = (raw.slots as any[]).find((s) => s.name === slotName)?.bone as string;
          if (suffix(boneName)) ((out.skins[skinName].attachments[slots[slotName] as string] ??= {}) as Record<string, any>)[attName] = { ...m, ...(m.y ? { y: r4(-m.y) } : {}), ...(m.rotation ? { rotation: r4(-m.rotation) } : {}) };
          continue;
        }
        if (m.type !== "mesh") continue;
        if (!m.bones) throw new Error(`mirror: mesh '${slotName}/${attName}' is not weighted`);
        const key = `${slotName}/${attName}`;
        const slot = skeleton.getSlot(slotName);
        const att = skeleton.getAttachment(slot, attName) as MeshAttachment;
        const world = skeleton.meshWorldVertices(att, slot.bone);
        const meshBones: string[] = m.bones;
        const outBones = [...meshBones];
        for (const b of meshBones) if (!outBones.includes(bones[b] as string)) outBones.push(bones[b] as string);
        const boneOf = (b: number) => outBones.indexOf(bones[meshBones[b] as string] as string);
        // Parse the weighted vertices.
        const infl: { b: number; x: number; y: number; w: number }[][] = [];
        const v: number[] = m.vertices;
        for (let k = 0; k < v.length; ) {
          const c = v[k++] as number;
          const list = [];
          for (let j = 0; j < c; j++, k += 4) list.push({ b: v[k] as number, x: v[k + 1] as number, y: v[k + 2] as number, w: v[k + 3] as number });
          infl.push(list);
        }
        const n = infl.length;
        const pos = infl.map((_, i) => [(world[i * 2] as number) + ox, (world[i * 2 + 1] as number) + oy] as [number, number]);
        const isCentre = pos.map((p) => Math.abs(p[0] - rule.x) <= tolerance);
        if (!isCentre.some(Boolean) && slots[slotName] !== slotName) {
          // Detached side sheet: no centre cut to weld, so the whole sheet is
          // reflected into the mirrored slot as a separate attachment: side bones renamed, bone-local
          // offsets reflected, winding reversed, texture flipped in u, draw groups renamed.
          const far = slots[slotName] as string;
          const n = infl.length;
          if (meshBones.some((b) => !suffix(b) && infl.some((l) => l.some((f) => meshBones[f.b] === b && f.w > 0)))) report.push(`mesh ${key}: detached sheet carries trunk weights (reflected about their own frames)`);
          const verts: number[] = [];
          for (const l of infl) {
            verts.push(l.length);
            for (const f of l) {
              const [x, y] = apply(S.get(meshBones[f.b] as string) as M2, f.x, f.y);
              verts.push(boneOf(f.b), r4(x) + 0, r4(y) + 0, f.w);
            }
          }
          const tris: number[] = m.triangles;
          const T = tris.length / 3;
          const flipped: number[] = [];
          for (let t = 0; t < T; t++) flipped.push(tris[t * 3] as number, tris[t * 3 + 2] as number, tris[t * 3 + 1] as number);
          const tex = textures.get(m.path);
          if (!tex) throw new Error(`mirror: no texture '${m.path}'`);
          const img = { width: tex.width, height: tex.height, data: new Uint8Array(tex.data.length) };
          for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) img.data.set(tex.data.subarray((y * tex.width + (tex.width - 1 - x)) * 4, (y * tex.width + (tex.width - x)) * 4), (y * tex.width + x) * 4);
          const path = `${m.path}${rule.rename[0]?.[1] ?? "_r"}`;
          outTextures.set(path, img);
          const uv: number[] = m.uvs;
          const groups = m.groups ? Object.fromEntries(Object.entries(m.groups as Record<string, [number, number][]>).map(([g, r]) => [slots[g] ?? g, r])) : undefined;
          ((out.skins[skinName].attachments[far] ??= {}) as Record<string, any>)[attName] = { ...m, path, bones: outBones, uvs: uv.map((x, i) => (i % 2 === 0 ? r6(1 - x) : x)), triangles: flipped, vertices: verts, ...(groups ? { groups } : {}) };
          const identity = [...Array(n).keys()];
          meshes.set(`${skinName}/${key}`, { key, skin: skinName, slot: slotName, name: attName, n, right: identity, perm: identity, boneOf, infl, T, far });
          corr[corr[key] ? `${skinName}:${key}` : key] = { pairs: identity.map((i) => [i, i] as [number, number]), centre: [], leftTriangles: T, far: `${far}/${attName}` };
          report.push(`mesh ${key}: detached side sheet reflected onto ${far}/${attName} (${n} vertices, ${T} triangles, texture flipped in u)`);
          continue;
        }
        isCentre.forEach((c, i) => {
          if (!c) return;
          const bad = (infl[i] as { b: number }[]).find((f) => suffix(meshBones[f.b] as string));
          if (bad) throw new Error(`mirror: centreline vertex ${i} of '${key}' is weighted to side bone '${meshBones[bad.b]}' (the weld needs trunk weights only; end the girdle before the line)`);
        });
        const right: number[] = [];
        let next = n;
        for (let i = 0; i < n; i++) right.push(isCentre[i] ? i : next++);
        // Merged influences (pre-permutation order: left, then the right copies).
        const all: { b: number; x: number; y: number; w: number }[][] = infl.map((l) => l.map((f) => ({ ...f })));
        for (let i = 0; i < n; i++) {
          if (isCentre[i]) continue;
          all.push((infl[i] as { b: number; x: number; y: number; w: number }[]).map((f) => {
            const [x, y] = apply(S.get(meshBones[f.b] as string) as M2, f.x, f.y);
            return { b: boneOf(f.b), x: r4(x), y: r4(y), w: f.w };
          }));
        }
        const tris: number[] = m.triangles;
        const T = tris.length / 3;
        const mergedTris = [...tris];
        for (let t = 0; t < T; t++) mergedTris.push(right[tris[t * 3] as number] as number, right[tris[t * 3 + 2] as number] as number, right[tris[t * 3 + 1] as number] as number);
        // Hull: one loop; the centre-cut run becomes interior.
        const H: number = m.hull;
        const runIdx = [...Array(H).keys()].filter((i) => isCentre[i]);
        if (runIdx.length < 2) throw new Error(`mirror: '${key}' hull touches the mirror line at ${runIdx.length} vertices (needs a centre-cut edge)`);
        let rs = -1;
        for (let i = 0; i < H; i++) if (isCentre[i] && !isCentre[(i - 1 + H) % H]) {
          if (rs >= 0) throw new Error(`mirror: '${key}' hull crosses the mirror line more than once`);
          rs = i;
        }
        let re = rs;
        while (isCentre[(re + 1) % H]) re = (re + 1) % H;
        const path: number[] = [];
        for (let i = re; ; i = (i + 1) % H) {
          path.push(i);
          if (i === rs) break;
        }
        const loop = [...path, ...path.slice(1, -1).reverse().map((i) => right[i] as number)];
        const inLoop = new Set(loop);
        const order = [...loop, ...[...Array(all.length).keys()].filter((i) => !inLoop.has(i))];
        const perm: number[] = new Array(all.length);
        order.forEach((old, ni) => (perm[old] = ni));
        // UVs from the bind canvas positions on a texture re-painted symmetric about the line.
        const tex = textures.get(m.path);
        if (!tex) throw new Error(`mirror: no texture '${m.path}'`);
        const uv: number[] = m.uvs;
        const tox = (pos[0] as [number, number])[0] - (uv[0] as number) * m.width;
        const toy = (pos[0] as [number, number])[1] - (uv[1] as number) * m.height;
        let uvErr = 0;
        pos.forEach((p, i) => (uvErr = Math.max(uvErr, Math.abs(p[0] - tox - (uv[i * 2] as number) * m.width), Math.abs(p[1] - toy - (uv[i * 2 + 1] as number) * m.height))));
        if (uvErr > 0.75) throw new Error(`mirror: '${key}' uvs are not a canvas projection of the bind mesh (off by ${uvErr.toFixed(2)} px)`);
        const nx0 = Math.floor(Math.min(tox, 2 * rule.x - (tox + m.width)));
        const nx1 = Math.ceil(Math.max(tox + m.width, 2 * rule.x - tox));
        const nw = nx1 - nx0;
        const img = { width: nw, height: tex.height, data: new Uint8Array(nw * tex.height * 4) };
        for (let y = 0; y < tex.height; y++) {
          for (let x = 0; x < nw; x++) {
            const cxp = nx0 + x + 0.5;
            const srcX = Math.floor((cxp < rule.x ? cxp : 2 * rule.x - cxp) - tox);
            const sx = Math.min(tex.width - 1, Math.max(0, srcX));
            const s = (y * tex.width + sx) * 4;
            img.data.set(tex.data.subarray(s, s + 4), (y * nw + x) * 4);
          }
        }
        outTextures.set(m.path, img);
        const mergedPos = [...pos, ...pos.flatMap((p, i) => (isCentre[i] ? [] : [[2 * rule.x - p[0], p[1]] as [number, number]]))];
        const uvs: number[] = new Array(all.length * 2);
        const verts: number[] = [];
        const finalInfl = order.map((old) => all[old] as { b: number; x: number; y: number; w: number }[]);
        order.forEach((old, ni) => {
          const p = mergedPos[old] as [number, number];
          uvs[ni * 2] = r6((p[0] - nx0) / nw);
          uvs[ni * 2 + 1] = r6((p[1] - toy) / m.height);
        });
        for (const l of finalInfl) {
          verts.push(l.length);
          for (const f of l) verts.push(f.b, f.x, f.y, f.w);
        }
        const groups: Record<string, [number, number][]> = {};
        for (const [g, ranges] of Object.entries((m.groups ?? {}) as Record<string, [number, number][]>)) {
          (groups[g] ??= []).push(...ranges);
          (groups[slots[g] ?? g] ??= []).push(...ranges.map(([a, b]) => [a + T, b + T] as [number, number]));
        }
        const om: any = { ...m, bones: outBones, uvs, triangles: mergedTris.map((i) => perm[i] as number), vertices: verts, hull: loop.length, width: nw };
        if (m.groups) om.groups = groups;
        out.skins[skinName].attachments[slotName][attName] = om;
        // The mesh map is keyed by skin too (two skins may fill the same placeholder); the result keys
        // by slot/attachment, prefixed `skin:` when another skin already took that key.
        meshes.set(`${skinName}/${key}`, { key, skin: skinName, slot: slotName, name: attName, n, right, perm, boneOf, infl, T });
        corr[corr[key] ? `${skinName}:${key}` : key] = { pairs: [...Array(n).keys()].filter((i) => !isCentre[i]).map((i) => [perm[i] as number, perm[right[i] as number] as number]), centre: [...Array(n).keys()].filter((i) => isCentre[i]).map((i) => perm[i] as number), leftTriangles: T };
        report.push(`mesh ${key}: ${n} -> ${all.length} vertices (${runIdx.length} hull + ${isCentre.filter(Boolean).length - runIdx.length} interior welded on the line), ${T} -> ${2 * T} triangles, hull ${H} -> ${loop.length}`);
      }
    }
  }
  // Embeds (garments posed on the skin) after every mesh is known.
  const mapPoint = (mi: MeshInfo, p: any, side: "left" | "right"): any => {
    const f = (i: number) => mi.perm[side === "left" ? i : (mi.right[i] as number)] as number;
    return typeof p === "number" ? f(p) : [f(p[0]), f(p[1]), f(p[2]), p[3], p[4]];
  };
  // A mesh by skin (default: the referring skin, else the only skin with that placeholder).
  const findMesh = (skin: string | undefined, slot: string, att: string, from: string): MeshInfo | undefined => {
    if (skin) return meshes.get(`${skin}/${slot}/${att}`);
    const own = meshes.get(`${from}/${slot}/${att}`);
    if (own) return own;
    const any = [...meshes.values()].filter((m) => m.slot === slot && m.name === att);
    if (any.length > 1) throw new Error(`mirror: '${slot}/${att}' is ambiguous (skins ${any.map((m) => m.skin).join(", ")}); name the skin`);
    return any[0];
  };
  for (const mi of meshes.values()) {
    if (mi.far) {
      if ((raw.skins[mi.skin].attachments[mi.slot][mi.name] as any).embed) throw new Error(`mirror: detached sheet '${mi.key}' is embedded; not supported`);
      continue;
    }
    const om = out.skins[mi.skin].attachments[mi.slot][mi.name];
    const e = (raw.skins[mi.skin].attachments[mi.slot][mi.name] as any).embed;
    if (!e) continue;
    const host = findMesh(e.skin, e.slot, e.attachment, mi.skin);
    if (!host) throw new Error(`mirror: embed host '${e.slot}/${e.attachment}' is not a mirrored mesh`);
    const vertices: number[] = [];
    const points: any[] = [];
    (e.vertices as number[]).forEach((v, k) => {
      vertices.push(mi.perm[v] as number);
      points.push(mapPoint(host, e.points[k], "left"));
      if (mi.right[v] !== v) {
        vertices.push(mi.perm[mi.right[v] as number] as number);
        points.push(mapPoint(host, e.points[k], "right"));
      }
    });
    om.embed = { ...e, vertices, points };
  }

  // --- deform (driven keys and grids) ------------------------------------------------------------
  const deformSide = (deform: any, side: "left" | "right"): any => {
    const res: any = {};
    for (const [skinName, bySlot] of Object.entries(deform ?? {}) as [string, any][]) {
      for (const [slotName, byAtt] of Object.entries(bySlot) as [string, any][]) {
        for (const [attName, d] of Object.entries(byAtt) as [string, any][]) {
          const mi = meshes.get(`${skinName}/${slotName}/${attName}`);
          if (!mi) throw new Error(`mirror: deform on '${slotName}/${attName}', not a mirrored mesh`);
          const counts = mi.infl.map((l) => l.length);
          const total = counts.reduce((s, c) => s + c, 0) * 2;
          const full = new Array<number>(total).fill(0);
          (d.vertices as number[]).forEach((x, k) => (full[(d.offset ?? 0) + k] = x));
          if (mi.far) {
            // Detached sheet: the left key deforms the sheet as authored, the right key its reflection.
            if (side === "left") ((res[skinName] ??= {})[slotName] ??= {})[attName] = { offset: 0, vertices: full };
            else {
              const srcBones = raw.skins[mi.skin].attachments[mi.slot][mi.name].bones as string[];
              const outV: number[] = [];
              let k = 0;
              for (const l of mi.infl) {
                for (const f of l) {
                  const [x, y] = apply(S.get(srcBones[f.b] as string) as M2, full[k] as number, full[k + 1] as number);
                  outV.push(r4(x) + 0, r4(y) + 0);
                  k += 2;
                }
              }
              ((res[skinName] ??= {})[mi.far] ??= {})[attName] = { offset: 0, vertices: outV };
            }
            continue;
          }
          // Per merged (pre-permutation) vertex: its offsets.
          const chunks: number[][] = [];
          let at = 0;
          const leftChunks = counts.map((c) => {
            const ch = full.slice(at, at + c * 2);
            at += c * 2;
            return ch;
          });
          leftChunks.forEach((ch, i) => {
            const centre = mi.right[i] === i;
            if (centre && ch.some((x) => Math.abs(x) > tolerance)) throw new Error(`mirror: centreline vertex ${i} of '${mi.key}' carries a corrective offset (${Math.max(...ch.map(Math.abs)).toFixed(4)}); the weld needs none`);
            chunks.push(side === "left" && !centre ? ch : ch.map(() => 0));
          });
          leftChunks.forEach((ch, i) => {
            if (mi.right[i] === i) return;
            if (side === "left") return chunks.push(ch.map(() => 0));
            const l = mi.infl[i] as { b: number }[];
            const outCh: number[] = [];
            l.forEach((f, j) => {
              const [x, y] = apply(S.get((raw.skins[mi.skin].attachments[mi.slot][mi.name].bones as string[])[f.b] as string) as M2, ch[j * 2] as number, ch[j * 2 + 1] as number);
              outCh.push(r4(x) + 0, r4(y) + 0);
            });
            chunks.push(outCh);
          });
          const ordered: number[] = [];
          const inverse: number[] = new Array(chunks.length);
          mi.perm.forEach((ni, old) => (inverse[ni] = old));
          for (const old of inverse) ordered.push(...(chunks[old] as number[]));
          ((res[skinName] ??= {})[slotName] ??= {})[attName] = { offset: 0, vertices: ordered };
        }
      }
    }
    return res;
  };
  if (raw.driven) {
    out.driven = [];
    for (const d of raw.driven as any[]) {
      out.driven.push({ ...d, keys: d.keys.map((k: any) => ({ ...k, deform: deformSide(k.deform, "left") })) });
      const alphaSide = (a: Record<string, number> | undefined) => (a ? Object.fromEntries(Object.entries(a).map(([s, v]) => [slots[s] ?? s, v])) : a);
      out.driven.push({ ...d, name: otherName(d.name), bone: bones[d.bone], ...(d.alphaOr ? { alphaOr: otherName(d.alphaOr) } : {}), keys: [...d.keys].reverse().map((k: any) => ({ ...k, at: -k.at, deform: deformSide(k.deform, "right"), ...(k.alpha ? { alpha: alphaSide(k.alpha) } : {}) })) });
    }
  }
  if (raw.drivenGrids) {
    out.drivenGrids = [];
    for (const g of raw.drivenGrids as any[]) {
      out.drivenGrids.push({ ...g, keys: g.keys.map((k: any) => ({ ...k, deform: deformSide(k.deform, "left") })) });
      // Both axes negate: reversing both axes of a row-major grid reverses its flat key list.
      const axis = (a: any) => ({ ...a, bone: bones[a.bone], at: [...a.at].reverse().map((x: number) => -x) });
      out.drivenGrids.push({ ...g, name: otherName(g.name), x: axis(g.x), y: axis(g.y), keys: [...g.keys].reverse().map((k: any) => ({ ...k, deform: deformSide(k.deform, "right") })) });
    }
  }
  if (raw.poseLimits) {
    const area = (p: number[][]) => p.reduce((s, q, i) => s + (q[0] as number) * ((p[(i + 1) % p.length] as number[])[1] as number) - ((p[(i + 1) % p.length] as number[])[0] as number) * (q[1] as number), 0);
    out.poseLimits = [...raw.poseLimits, ...(raw.poseLimits as any[]).map((l) => {
      let polygon = (l.polygon as number[][]).map(([a, b]) => [-(a as number) + 0, -(b as number) + 0]);
      if (Math.sign(area(polygon)) !== Math.sign(area(l.polygon))) polygon = polygon.reverse();
      return { ...l, name: otherName(l.name), x: bones[l.x], y: bones[l.y], ...(l.plus ? { plus: (l.plus as string[]).map((b) => bones[b] ?? b) } : {}), polygon };
    })];
  }
  // A band's measurement condition (`when`) gates on the mirrored drivers with negated ranges [-hi, -lo].
  const mirrorWhen = (when: Record<string, [number, number]> | undefined) => (when ? Object.fromEntries(Object.entries(when).map(([b, [lo, hi]]) => [bones[b] ?? b, [-hi + 0, -lo + 0]])) : undefined);
  if (raw.contactBands) out.contactBands = [...raw.contactBands, ...(raw.contactBands as any[]).map((b) => ({ ...b, name: otherName(b.name), x: bones[b.x], y: bones[b.y], ...(b.when ? { when: mirrorWhen(b.when) } : {}), cells: (b.cells as number[][]).map(([a, c]) => [-(a as number) + 0, -(c as number) + 0]) }))];
  out.animations = {};

  // --- contours -----------------------------------------------------------------------------------
  // Contour refs (`owner/name`) of the right side, for the mirrored contact bands' `contours`.
  const contourRef = new Map<string, string>();
  for (const skinName of skinNames) {
    const src = raw.skins[skinName].contours as Record<string, Record<string, any>> | undefined;
    if (!src) continue;
    const dst: Record<string, Record<string, any>> = {};
    for (const [slotName, byName] of Object.entries(src)) {
      for (const [name, c] of Object.entries(byName)) {
        const mi = findMesh(c.mesh.skin, c.mesh.slot, c.mesh.attachment, skinName);
        if (!mi) throw new Error(`mirror: contour '${slotName}/${name}' is on '${c.mesh.slot}/${c.mesh.attachment}', not a mirrored mesh`);
        const pts: any[] = c.points;
        if (mi.far) {
          // Detached sheet: the far copy has the same vertex order, on the mirrored slot's attachment.
          (dst[slotName] ??= {})[name] = c;
          const rs = slots[slotName] ?? slotName;
          const rn = rs === slotName ? otherName(name) : name;
          (dst[rs] ??= {})[rn] = { ...c, mesh: { ...c.mesh, slot: mi.far }, ...(c.visible ? { visible: mirrorVisible(c.visible, bones) } : {}), ...(c.owner ? { owner: mirrorOwner(c.owner, slots, rule.rename) } : {}), ...(c.coverUnder ? { coverUnder: slots[c.coverUnder] ?? c.coverUnder } : {}) };
          contourRef.set(`${slotName}/${name}`, `${rs}/${rn}`);
          continue;
        }
        const centre = (p: any) => typeof p === "number" && mi.right[p] === p;
        const L = pts.map((p) => mapPoint(mi, p, "left"));
        const R = pts.map((p) => mapPoint(mi, p, "right"));
        // Visibility rules (format `visible`, an array) negate onto the right bones.
        const vis = mirrorVisible(c.visible, bones);
        if (pts.every(centre)) {
          report.push(`contour ${slotName}/${name}: lies on the mirror line (a centre-cut stroke), dropped`);
          continue;
        }
        // Halves join only when their visibility reads the same on both sides.
        if (joinableVisible(c.visible, bones) && (centre(pts[pts.length - 1]) || centre(pts[0]))) {
          const joined = centre(pts[pts.length - 1]) ? [...L, ...R.slice(0, -1).reverse()] : [...R.slice(1).reverse(), ...L];
          (dst[slotName] ??= {})[name] = { ...c, points: joined };
          contourRef.set(`${slotName}/${name}`, `${slotName}/${name}`);
          report.push(`contour ${slotName}/${name}: joined with its mirror across the line (${pts.length} -> ${joined.length} points)`);
          continue;
        }
        (dst[slotName] ??= {})[name] = { ...c, points: L };
        const rs = slots[slotName] ?? slotName;
        const rn = rs === slotName ? otherName(name) : name;
        (dst[rs] ??= {})[rn] = { ...c, points: R, ...(c.visible ? { visible: vis } : {}), ...(c.owner ? { owner: mirrorOwner(c.owner, slots, rule.rename) } : {}) };
        contourRef.set(`${slotName}/${name}`, `${rs}/${rn}`);
      }
    }
    out.skins[skinName].contours = dst;
    // Contour contacts: each pair with a mirrored side gets its mirror pair (joined contours map to themselves).
    const contacts = raw.skins[skinName].contourContacts as any[] | undefined;
    if (contacts?.length) {
      const ref = (e: { slot: string; name: string }) => {
        const r = contourRef.get(`${e.slot}/${e.name}`) ?? `${e.slot}/${e.name}`;
        const i = r.indexOf("/");
        return { slot: r.slice(0, i), name: r.slice(i + 1) };
      };
      const same = (x: { slot: string; name: string }, y: { slot: string; name: string }) => x.slot === y.slot && x.name === y.name;
      const mirrored = contacts.map((k) => ({ ...k, a: ref(k.a), b: ref(k.b) })).filter((k, i) => !(same(k.a, contacts[i].a) && same(k.b, contacts[i].b)));
      out.skins[skinName].contourContacts = [...contacts, ...mirrored];
    }
  }
  // Mirrored bands name the right side's contours (a joined centre contour stays itself).
  if (out.contactBands) {
    const half = (out.contactBands as any[]).length / 2;
    (out.contactBands as any[]).forEach((b, i) => {
      if (i < half || !b.contours) return;
      b.contours = (b.contours as string[]).map((r) => contourRef.get(r) ?? r);
    });
  }
  return { doc: out, textures: outTextures, bones, slots, meshes: corr, report };
}

/** A half polygon (one side of the line, closed along it) made whole: the off-line chain and its mirror. */
/**
 * A region's opaque outline (format `opaque`: u, v pairs in 0..1 of the image) for its texture
 * flipped in v (rows reversed), the side-region mirror's image transform: v -> 1 - v per vertex, and
 * the vertex order reversed so the outline keeps its winding (a v flip alone reverses it). Use it
 * whenever the texture is flipped, so the coverage outline follows the pixels.
 */
export function flipOpaqueV(opaque: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = opaque.length - 2; i >= 0; i -= 2) out.push(opaque[i] as number, r4(1 - (opaque[i + 1] as number)));
  return out;
}

export function symmetricPolygon(poly: readonly (readonly [number, number])[], x: number, tolerance = 1e-3): [number, number][] {
  const side = Math.sign(poly.reduce((s, p) => s + (p[0] - x), 0));
  // Clamp to the line (a crop may overhang it by a few px), then cut out the on-line run.
  const p = poly.map(([a, b]) => [side < 0 ? Math.min(a, x) : Math.max(a, x), b] as [number, number]);
  const on = p.map((q) => Math.abs(q[0] - x) <= tolerance);
  const n = p.length;
  let start = -1;
  for (let i = 0; i < n; i++) if (on[i] && !on[(i + 1) % n]) start = i;
  if (start < 0) throw new Error("symmetricPolygon: the polygon does not touch the mirror line");
  const chain: [number, number][] = [];
  for (let k = 0, i = start; k < n; k++, i = (i + 1) % n) {
    chain.push(p[i] as [number, number]);
    if (k > 0 && on[i]) break;
  }
  return [...chain, ...chain.slice(1, -1).reverse().map(([a, b]) => [2 * x - a, b] as [number, number])];
}

function inPolygon(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
