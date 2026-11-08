/*
 * Atlas Animator editor: mesh and weight transfer for swag pieces (Batch 10b, PL-04 /  / ).
 *
 * A piece dropped on a slot whose rig has a skinned mesh there must bend with the body, not sit on the bone as a flat rectangle.
 *   Tier A: the art is fitted to the base mesh (same pixel size, neutral placement, the mesh lives in the base skin) -> a LINKED mesh of it
 *           (shares vertices, UVs, weights and deforms; draws its own texture).
 *   Tier B: anything else with a mesh to learn from -> an OWN mesh: the source's topology and weights are copied, and the UVs are
 *           re-projected so the art lands where the Across / Down / Turn / Size placement puts it (same convention as a region).
 *   Region: no mesh anywhere for this slot -> the rigid region the wizard always wrote.
 * The source is, in order: the slot's mesh in the base skin, the slot's mesh in any item skin (a sleeve), the body "twin" mesh
 * (shirt_sleeve_* -> skin_arm_*). Pure and Node-safe (the dev server's /api/swag/import uses it): no engine or setupModel value imports.
 */
import type { JsonObject } from "./setupModel.js";

type Json = Record<string, unknown>;
const objOf = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const listOf = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null && !Array.isArray(x)) as Json[]) : []);
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

/** The placement of a piece in its slot bone's frame: the region is centred on (x, y), turned by rotation (degrees, y down), sized by scale. */
export interface Placement {
  width: number;
  height: number;
  x: number;
  y: number;
  rotation: number;
  scale?: number;
}

/** Where pixel (px, py) of a piece sits in the slot bone's frame. */
export function pieceLocalPoint(p: Placement, px: number, py: number): { x: number; y: number } {
  const s = p.scale ?? 1;
  const dx = (px - p.width / 2) * s;
  const dy = (py - p.height / 2) * s;
  const a = (p.rotation * Math.PI) / 180;
  return { x: p.x + dx * Math.cos(a) - dy * Math.sin(a), y: p.y + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** The piece's pixel under a bone-frame point (the inverse of pieceLocalPoint). */
export function piecePixelAt(p: Placement, lx: number, ly: number): { x: number; y: number } {
  const s = p.scale ?? 1;
  const a = (p.rotation * Math.PI) / 180;
  const dx = lx - p.x;
  const dy = ly - p.y;
  return { x: p.width / 2 + (dx * Math.cos(a) + dy * Math.sin(a)) / s, y: p.height / 2 + (-dx * Math.sin(a) + dy * Math.cos(a)) / s };
}

// ------------------------------------------------------------------------------------------------------------------ bones

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

/** Setup-pose world matrices of the bones (normal inheritance, the engine's `composeLocalLinear` convention). */
export function boneWorlds(raw: JsonObject): Map<string, Affine> {
  const out = new Map<string, Affine>();
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  for (const b of listOf(raw["bones"])) {
    const rot = num(b["rotation"], 0);
    const xa = ((rot + num(b["shearX"], 0)) * Math.PI) / 180;
    const ya = ((rot + 90 + num(b["shearY"], 0)) * Math.PI) / 180;
    const sx = num(b["scaleX"], 1);
    const sy = num(b["scaleY"], 1);
    const l = { a: Math.cos(xa) * sx, c: Math.sin(xa) * sx, b: Math.cos(ya) * sy, d: Math.sin(ya) * sy };
    const x = num(b["x"], 0);
    const y = num(b["y"], 0);
    const p = typeof b["parent"] === "string" ? out.get(b["parent"]) : undefined;
    out.set(
      String(b["name"]),
      p
        ? { a: p.a * l.a + p.b * l.c, b: p.a * l.b + p.b * l.d, c: p.c * l.a + p.d * l.c, d: p.c * l.b + p.d * l.d, x: p.a * x + p.b * y + p.x, y: p.c * x + p.d * y + p.y }
        : { ...l, x, y }
    );
  }
  return out;
}

const apply = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];
function invert(m: Affine, wx: number, wy: number): [number, number] {
  const det = m.a * m.d - m.b * m.c || 1;
  const dx = wx - m.x;
  const dy = wy - m.y;
  return [(m.d * dx - m.b * dy) / det, (-m.c * dx + m.a * dy) / det];
}

/** Rest (setup pose) positions of a mesh's vertices in the slot bone's frame, flat [x0, y0, x1, y1, ...]. */
export function restLocal(mesh: Json, slotBone: string, worlds: ReadonlyMap<string, Affine>): number[] {
  const verts = (mesh["vertices"] as number[]) ?? [];
  const names = Array.isArray(mesh["bones"]) ? (mesh["bones"] as string[]) : null;
  const sb = worlds.get(slotBone);
  if (!sb) return [];
  const out: number[] = [];
  if (!names) {
    for (let i = 0; i + 1 < verts.length; i += 2) out.push(verts[i]!, verts[i + 1]!);
    return out;
  }
  for (let i = 0; i < verts.length; ) {
    const n = verts[i++]!;
    let wx = 0;
    let wy = 0;
    for (let k = 0; k < n; k++, i += 4) {
      const bw = worlds.get(names[verts[i]!] ?? "");
      if (!bw) continue;
      const [px, py] = apply(bw, verts[i + 1]!, verts[i + 2]!);
      wx += px * verts[i + 3]!;
      wy += py * verts[i + 3]!;
    }
    const [lx, ly] = invert(sb, wx, wy);
    out.push(lx, ly);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ sources

export interface MeshRef {
  skin: string;
  slot: string;
  attachment: string;
  mesh: Json;
  /** True when the mesh is in the base skin (stable to link to). */
  base: boolean;
  /** Which search step found it. */
  how: "base" | "item" | "twin";
}

/** Body meshes that show the same limb as a garment slot: where the garment has no mesh of its own to learn from. */
export const TWIN_SLOTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^shirt_sleeve_(near|far)$/, "skin_arm_$1"],
  [/^pants_(?:thigh|shin|cuff|knee|hip)_(near|far)$/, "pants_leg_$1"],
  [/^boots_(?:foot|shin)_(near|far)$/, "pants_leg_$1"]
];

const meshesOf = (raw: Json, skin: string, slot: string): [string, Json][] =>
  Object.entries(objOf(objOf(objOf(objOf(raw["skins"])[skin])["attachments"])[slot])).filter(([, a]) => objOf(a)["type"] === "mesh") as [string, Json][];

/** The mesh a piece for `slot` learns its geometry and weights from (see the header), or null. `exclude` is the skin being written. */
export function findSource(raw: JsonObject, slot: string, placeholder: string, exclude = "", fit: { width: number; height: number } | null = null): MeshRef | null {
  const skins = Object.keys(objOf(raw["skins"]));
  const baseName = skins[0];
  if (!baseName) return null;
  const pick = (skin: string, s: string, how: MeshRef["how"], prefer?: string): MeshRef | null => {
    const all = meshesOf(raw, skin, s);
    const hit = all.find(([n]) => n === prefer) ?? all[0];
    return hit ? { skin, slot: s, attachment: hit[0], mesh: hit[1], base: skin === baseName, how } : null;
  };
  const own = pick(baseName, slot, "base", placeholder);
  const others = skins.slice(1).sort().filter((k) => k !== exclude);
  const fits = (m: Json): boolean => !!fit && Number(m["width"]) === fit.width && Number(m["height"]) === fit.height;
  // A piece the exact size of the base mesh was fitted to it (linked mesh). Failing that, an item whose mesh on this slot is exactly the size of the
  // piece was cut for that mesh (a Leather sleeve rebuilt from its own art): learn from it before falling back to the base mesh of another size.
  if (own && fits(own.mesh)) return own;
  if (fit) {
    for (const skin of others) {
      const hit = meshesOf(raw, skin, slot).find(([, m]) => fits(m));
      if (hit) return { skin, slot, attachment: hit[0], mesh: hit[1], base: false, how: "item" };
    }
  }
  if (own) return own;
  for (const skin of others) {
    const hit = pick(skin, slot, "item", placeholder);
    if (hit) return hit;
  }
  for (const [re, tpl] of TWIN_SLOTS) {
    const m = re.exec(slot);
    if (!m) continue;
    const hit = pick(baseName, tpl.replace("$1", m[1]!), "twin");
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ transfer

export type Tier = "A" | "B" | "region";

export interface TransferReport {
  rigSlot: string;
  tier: Tier;
  source: { skin: string; slot: string; attachment: string } | null;
  /** Distinct influencing bones of the produced mesh (0 for a region). */
  bones: number;
  vertices: number;
  /** Vertices whose projected UV fell outside the art (clamped). */
  outside: number;
  reason: string;
}

export interface Transfer {
  /** The attachment body without `path` (the caller adds the atlas path). null for a region: keep the region the wizard wrote. */
  attachment: Json | null;
  report: TransferReport;
}

export interface TransferInput extends Placement {
  rigSlot: string;
  /** The slot's setup attachment name (what the item's art is stored under). */
  placeholder: string;
}

/** The placeholder name an item piece must carry: what the slot shows in setup, else the base skin's first attachment on it, else the slot's own name. */
export function placeholderOf(raw: JsonObject, rigSlot: string): string {
  const slot = listOf(raw["slots"]).find((s) => s["name"] === rigSlot);
  if (slot && typeof slot["attachment"] === "string") return slot["attachment"];
  const skins = objOf(raw["skins"]);
  const base = objOf(objOf(skins[Object.keys(skins)[0] ?? ""])["attachments"]);
  return Object.keys(objOf(base[rigSlot]))[0] ?? rigSlot;
}

/** Plans every piece of an item (the /api/swag/import answer): rig slot -> transfer. */
export function planTransfers(raw: JsonObject, pieces: readonly (Placement & { rigSlot: string })[], skin = ""): Record<string, Transfer> {
  const out: Record<string, Transfer> = {};
  for (const p of pieces) out[p.rigSlot] = planTransfer(raw, { ...p, placeholder: placeholderOf(raw, p.rigSlot) }, skin);
  return out;
}

const NEUTRAL_EPS = 1;

/** Plans the attachment for one piece. `skin` is the item skin being (re)written, so it never serves as its own source. */
export function planTransfer(raw: JsonObject, piece: TransferInput, skin = ""): Transfer {
  const slotDef = listOf(raw["slots"]).find((s) => s["name"] === piece.rigSlot);
  const none = (reason: string): Transfer => ({ attachment: null, report: { rigSlot: piece.rigSlot, tier: "region", source: null, bones: 0, vertices: 0, outside: 0, reason } });
  if (!slotDef) return none("the rig has no such slot yet");
  const src = findSource(raw, piece.rigSlot, piece.placeholder, skin, { width: piece.width, height: piece.height });
  if (!src) return none("no mesh on this slot or its body twin: the piece stays a flat region");
  const m = src.mesh;
  const source = { skin: src.skin, slot: src.slot, attachment: src.attachment };
  const neutral = Math.abs(piece.x) <= NEUTRAL_EPS && Math.abs(piece.y) <= NEUTRAL_EPS && Math.abs(piece.rotation) < 0.01 && Math.abs((piece.scale ?? 1) - 1) < 0.005;
  const fitted = Number(m["width"]) === piece.width && Number(m["height"]) === piece.height;
  const nverts = ((m["uvs"] as number[]) ?? []).length / 2;
  const bones = Array.isArray(m["bones"]) ? new Set(m["bones"] as string[]).size : 0;
  if (src.how === "base" && fitted && neutral) {
    return {
      attachment: { type: "linkedMesh", source, inheritDeform: true, width: piece.width, height: piece.height },
      report: { rigSlot: piece.rigSlot, tier: "A", source, bones, vertices: nverts, outside: 0, reason: `linked to the base ${src.slot} mesh (the art is fitted to it)` }
    };
  }
  const rest = restLocal(m, String(slotDef["bone"]), boneWorlds(raw));
  if (rest.length / 2 !== nverts) return none("the source mesh could not be read");
  const uvs: number[] = [];
  let outside = 0;
  const keepUvs = src.slot === piece.rigSlot && fitted && neutral;
  for (let i = 0; i < nverts; i++) {
    if (keepUvs) {
      uvs.push((m["uvs"] as number[])[i * 2]!, (m["uvs"] as number[])[i * 2 + 1]!);
      continue;
    }
    const px = piecePixelAt(piece, rest[i * 2]!, rest[i * 2 + 1]!);
    const u = px.x / piece.width;
    const v = px.y / piece.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) outside++;
    uvs.push(r6(Math.min(1, Math.max(0, u))), r6(Math.min(1, Math.max(0, v))));
  }
  const mesh: Json = {
    type: "mesh",
    uvs,
    triangles: [...(m["triangles"] as number[])],
    vertices: [...(m["vertices"] as number[])],
    hull: m["hull"],
    ...(Array.isArray(m["edges"]) ? { edges: [...(m["edges"] as number[])] } : {}),
    ...(Array.isArray(m["bones"]) ? { bones: [...(m["bones"] as string[])] } : {}),
    width: piece.width,
    height: piece.height
  };
  const from = src.how === "twin" ? `the weights of the body ${src.slot} mesh` : src.how === "item" ? `the ${src.skin} ${src.slot} mesh` : `the base ${src.slot} mesh`;
  return {
    attachment: mesh,
    report: { rigSlot: piece.rigSlot, tier: "B", source, bones, vertices: nverts, outside, reason: `own mesh, ${from} copied and the art re-projected${outside ? ` (${outside} of ${nverts} vertices fall outside the art)` : ""}` }
  };
}
