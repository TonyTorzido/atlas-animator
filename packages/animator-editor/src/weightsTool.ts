/*
 * Atlas Animator editor: original implementation.
 *
 * The Weights tool (Setup, tool "weights"; MESH-WEIGHTS-PLAN D2 and section 2). Registered through `registerSetupSubTool`, so it never
 * touches main.ts internals:
 *
 *  - Bind (chain from the slot bone to the selected bone, then auto), Auto (Heat / Distance / Sleeve profile with the named sliders), Apply.
 *  - Brush (Add / Subtract / Smooth / Set), `[` and `]` for the radius, strength, pressure, falloff; paints the active bone, picked on the
 *    canvas (Alt-click), in the bone list, or by a weight-row click in the Tree (`onActivePaintBone`). Locked bones keep their weight.
 *  - A virtualised table for the selected vertices, Cleanup (Normalise / Prune / Cap 1-4 with the dropped weight), a heat-map overlay,
 *    a Bend test on a scratch skeleton, and "same weights on variants" for the sleeve crease variants (`c###`).
 *  - Painting is live: the dense table is edited in place, `SkinPreview` re-skins an overlay Mesh over the (hidden) real slot, and on
 *    pointer-up ONE `weights.table` goes through `setup.run`, so a stroke is one undo step.
 */
import "./weightsTool.css";
import { Container, Graphics, Mesh, MeshGeometry, type Texture } from "pixi.js";
import { Skeleton, type Bone } from "@atlas-animator/core/core";
import { boneColor } from "./boneDraw.js";
import { getHost } from "./host.js";
import { HeatMesh, fillColors, type HeatMode } from "./heatMesh.js";
import { onActivePaintBone } from "./outliner.js";
import { registerSetupSubTool, type SetupToolContext } from "./setupMode.js";
import type { Command, JsonObject } from "./setupModel.js";
import { SkinPreview, packWorlds, type WorldMatrix } from "./skinPreview.js";
import { mirrorTable, parseBuildScripts, partnerSlot, restoreTable, type BuildScript } from "./weightsImport.js";
import { nameSide } from "./mirrorModel.js";
import { adjacency, boxSelect, clickSelect, growSelection, pickVertex, selectAll, shrinkSelection } from "./vertexSelect.js";
import {
  SLEEVE_DEFAULTS,
  StrokeSpacer,
  brushDab,
  cleanup,
  createTable,
  dabStep,
  distanceWeights,
  elbowZone,
  normalizeTable,
  pasteTable,
  setRowWeight,
  setSelection,
  sleeveBones,
  sleeveWeights,
  smoothTable,
  tableFromInfluences,
  tableInfluences,
  trimTable,
  toTableCommand,
  type BrushFalloff,
  type BrushMode,
  type MeshAddress,
  type SleeveArm,
  type SleeveParams,
  type WeightTable
} from "./weightModel.js";
import { weldWeights, type WeightBone } from "@atlas-animator/core/tools/autoWeights";

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** A mesh attachment as the rig document stores it. */
export interface RawMesh {
  vertices: number[];
  uvs: number[];
  triangles: number[];
  bones?: string[];
  hull?: number;
}

/** The weight table of a weighted mesh (columns = the mesh's bones), or null for an unweighted mesh. */
export function tableOfMesh(mesh: RawMesh): WeightTable | null {
  const names = mesh.bones;
  if (!names || names.length === 0) return null;
  const count = Math.floor(mesh.uvs.length / 2);
  const rows: { bone: number; weight: number }[][] = [];
  let i = 0;
  for (let v = 0; v < count; v++) {
    const n = mesh.vertices[i++] as number;
    const list: { bone: number; weight: number }[] = [];
    for (let k = 0; k < n; k++) {
      const bone = mesh.vertices[i] as number;
      const weight = mesh.vertices[i + 3] as number;
      i += 4;
      list.push({ bone, weight });
    }
    rows.push(list);
  }
  return tableFromInfluences(names, rows);
}

/** Rest-pose world positions (x, y per vertex) of a mesh, given a lookup of bone matrices by name. */
export function restPoints(mesh: RawMesh, slotBone: string, world: (name: string) => WorldMatrix | undefined): Float64Array {
  const count = Math.floor(mesh.uvs.length / 2);
  const out = new Float64Array(count * 2);
  const names = mesh.bones;
  if (!names || names.length === 0) {
    const m = world(slotBone);
    for (let v = 0; v < count; v++) {
      const x = mesh.vertices[v * 2] as number;
      const y = mesh.vertices[v * 2 + 1] as number;
      out[v * 2] = m ? m.a * x + m.b * y + m.x : x;
      out[v * 2 + 1] = m ? m.c * x + m.d * y + m.y : y;
    }
    return out;
  }
  let i = 0;
  for (let v = 0; v < count; v++) {
    const n = mesh.vertices[i++] as number;
    let wx = 0;
    let wy = 0;
    for (let k = 0; k < n; k++) {
      const m = world(names[mesh.vertices[i] as number] as string);
      const x = mesh.vertices[i + 1] as number;
      const y = mesh.vertices[i + 2] as number;
      const w = mesh.vertices[i + 3] as number;
      i += 4;
      if (!m) continue;
      wx += w * (m.a * x + m.b * y + m.x);
      wy += w * (m.c * x + m.d * y + m.y);
    }
    out[v * 2] = wx;
    out[v * 2 + 1] = wy;
  }
  return out;
}

const CREASE = /(^|[_.-])c\d{3}$/;
/** The name without its trailing crease-variant suffix (`sleeve_l_c012` -> `sleeve_l`). */
export const variantBase = (name: string): string => name.replace(CREASE, "");

/** Other attachments in the same skin and slot that share `name`'s base and vertex count: the crease variants to keep in step. */
export function variantNames(attachments: Record<string, { type?: string; uvs?: number[] }>, name: string): string[] {
  const own = attachments[name];
  if (!own || own.type !== "mesh" || !own.uvs) return [];
  const base = variantBase(name);
  return Object.keys(attachments).filter((n) => {
    if (n === name || variantBase(n) !== base || !(n === base || CREASE.test(n))) return false;
    const a = attachments[n];
    return a?.type === "mesh" && a.uvs?.length === own.uvs?.length;
  });
}

/** Chain of bone names from `from` (an ancestor) down to `to`, or just [from] when `to` is not below it. */
export function chainBetween(parentOf: (name: string) => string | null, from: string, to: string | null): string[] {
  if (!to || to === from) return [from];
  const up: string[] = [];
  let at: string | null = to;
  while (at && at !== from) {
    up.push(at);
    at = parentOf(at);
  }
  if (at !== from) return [from];
  return [from, ...up.reverse()];
}

/** Adds a zero column for `bone` (or returns the table when it exists). */
export function withColumn(table: WeightTable, bone: string): WeightTable {
  if (table.bones.includes(bone)) return table;
  const B = table.bones.length;
  const out = createTable([...table.bones, bone], table.vertexCount);
  for (let v = 0; v < table.vertexCount; v++) for (let b = 0; b < B; b++) out.data[v * (B + 1) + b] = table.data[v * B + b] as number;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tool state
// ---------------------------------------------------------------------------------------------

interface Session {
  raw: JsonObject;
  addr: MeshAddress;
  mesh: RawMesh;
  slotBone: string;
  weighted: boolean;
  table: WeightTable;
  rest: Float64Array;
  triangles: number[];
  uvs: number[];
  neighbours: Set<number>[];
  skin: SkinPreview;
  restWorlds: Float64Array;
  heat: HeatMesh | null;
  skinMesh: Mesh<MeshGeometry> | null;
  skinGeo: MeshGeometry | null;
  variants: string[];
}

interface WState {
  addr: MeshAddress | null;
  lastSlot: string | null;
  active: string | null;
  locks: Set<string>;
  tool: "paint" | "select";
  mode: BrushMode;
  radiusPx: number;
  strength: number;
  falloff: BrushFalloff;
  pressure: boolean;
  value: number;
  heat: "off" | HeatMode;
  bend: number;
  swing: boolean;
  sameVariants: boolean;
  select: Set<number>;
  auto: "heat" | "distance" | "sleeve";
  heatK: number;
  smoothPasses: number;
  power: number;
  sleeve: SleeveParams;
  side: string;
  cap: number;
  min: number;
  report: string;
  setValue: number;
  smoothAmount: number;
  weldTol: number;
}

const S: WState = {
  addr: null,
  lastSlot: null,
  active: null,
  locks: new Set(),
  tool: "paint",
  mode: "add",
  radiusPx: 34,
  strength: 0.35,
  falloff: "smooth",
  pressure: true,
  value: 1,
  heat: "active",
  bend: 0,
  swing: false,
  sameVariants: true,
  select: new Set(),
  auto: "heat",
  heatK: 0.2,
  smoothPasses: 1,
  power: 2,
  sleeve: { ...SLEEVE_DEFAULTS },
  side: "l",
  cap: 4,
  min: 0.02,
  report: "",
  setValue: 1,
  smoothAmount: 0.5,
  weldTol: 1
};

let session: Session | null = null;
let scratch: Skeleton | null = null;
let root: Container | null = null;
let hover: { x: number; y: number } | null = null;
let stroke: { spacer: StrokeSpacer; touched: Set<number>; points: Float32Array; col: number } | null = null;
let boxDrag: { x0: number; y0: number; x1: number; y1: number; sx: number; sy: number } | null = null;
let lastPressure = 1;
let swingFrame = 0;
let activeCtx: SetupToolContext | null = null;
let busyCommit = false;
let tableHost: HTMLElement | null = null;
let selRows: number[] = [];
const unsubs: (() => void)[] = [];

const rawList = (v: unknown): JsonObject[] => (Array.isArray(v) ? (v as JsonObject[]) : []);

function rawMeshOf(raw: JsonObject, a: MeshAddress): RawMesh | null {
  const skins = raw["skins"] as Record<string, { attachments?: Record<string, Record<string, Record<string, unknown>>> }> | undefined;
  const att = skins?.[a.skin]?.attachments?.[a.slot]?.[a.name];
  return att && att["type"] === "mesh" ? (att as unknown as RawMesh) : null;
}

function attachmentsOf(raw: JsonObject, a: MeshAddress): Record<string, { type?: string; uvs?: number[] }> {
  const skins = raw["skins"] as Record<string, { attachments?: Record<string, Record<string, { type?: string; uvs?: number[] }>> }> | undefined;
  return skins?.[a.skin]?.attachments?.[a.slot] ?? {};
}

function scratchFor(ctx: SetupToolContext): Skeleton | null {
  const live = ctx.host.skeleton();
  if (!live) return null;
  if (!scratch || scratch.document !== live.document) scratch = new Skeleton(live.document);
  return scratch;
}

function poseScratch(sk: Skeleton, bone: string | null, degrees: number): void {
  sk.setToSetupPose();
  if (bone && degrees) {
    const b = sk.findBone(bone) as Bone | undefined;
    if (b) b.pose.rotation = b.data.rotation + degrees;
  }
  sk.updateWorldTransform("pose");
}

const columnWorlds = (sk: Skeleton, names: readonly string[]): Float64Array =>
  packWorlds(names.map((n) => ({ world: (sk.findBone(n)?.world ?? { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }) as WorldMatrix })));

function pickDefaultMesh(ctx: SetupToolContext): MeshAddress | null {
  const slot = ctx.slot();
  const meshes = getHost()?.meshes() ?? [];
  const pool = slot ? meshes.filter((m) => m.slot === slot) : meshes;
  if (pool.length === 0) return null;
  const raw = ctx.host.rig()?.raw;
  const slotRaw = rawList(raw?.["slots"]).find((s) => s["name"] === (slot ?? pool[0]!.slot));
  const current = slotRaw?.["attachment"];
  const hit = pool.find((m) => m.attachment === current) ?? pool.find((m) => m.weighted) ?? pool[0]!;
  return { skin: hit.skin, slot: hit.slot, name: hit.attachment };
}

function ensureSession(ctx: SetupToolContext): Session | null {
  const rig = ctx.host.rig();
  if (!rig) return null;
  const slotNow = ctx.slot();
  if (slotNow !== S.lastSlot) {
    S.lastSlot = slotNow;
    // Follow a slot change only when the new slot holds a mesh (a commit re-selects the bone, which can hop to a slot with no mesh).
    if (slotNow && (getHost()?.meshes() ?? []).some((m) => m.slot === slotNow)) S.addr = null;
  }
  if (!S.addr) S.addr = pickDefaultMesh(ctx);
  if (!S.addr) return null;
  if (session && session.raw === rig.raw && session.addr.skin === S.addr.skin && session.addr.slot === S.addr.slot && session.addr.name === S.addr.name) return session;
  return rebuild(ctx);
}

function rebuild(ctx: SetupToolContext): Session | null {
  const rig = ctx.host.rig();
  const sk = scratchFor(ctx);
  const addr = S.addr;
  if (!rig || !sk || !addr) return null;
  const mesh = rawMeshOf(rig.raw, addr);
  if (!mesh) return null;
  disposeNodes();
  const slotBone = (rawList(rig.raw["slots"]).find((s) => s["name"] === addr.slot)?.["bone"] as string | undefined) ?? "root";
  poseScratch(sk, null, 0);
  const rest = restPoints(mesh, slotBone, (n) => sk.findBone(n)?.world as WorldMatrix | undefined);
  let table = tableOfMesh(mesh);
  const weighted = !!table;
  table ??= tableFromInfluences([slotBone], Array.from({ length: Math.floor(mesh.uvs.length / 2) }, () => [{ bone: 0, weight: 1 }]));
  if (S.active && !table.bones.includes(S.active) && (rig.raw["bones"] as JsonObject[]).some((b) => b["name"] === S.active)) table = withColumn(table, S.active);
  if (!S.active) {
    const picked = ctx.host.selected();
    S.active = picked && table.bones.includes(picked) ? picked : (table.bones[0] ?? null);
  }
  const restWorlds = columnWorlds(sk, table.bones);
  const preview = new SkinPreview(table, rest, restWorlds);
  const s: Session = {
    raw: rig.raw,
    addr: { ...addr },
    mesh,
    slotBone,
    weighted,
    table,
    rest,
    triangles: mesh.triangles,
    uvs: mesh.uvs,
    neighbours: adjacency(table.vertexCount, mesh.triangles),
    skin: preview,
    restWorlds,
    heat: null,
    skinMesh: null,
    skinGeo: null,
    variants: S.sameVariants ? variantNames(attachmentsOf(rig.raw, addr), addr.name) : []
  };
  session = s;
  S.select = new Set([...S.select].filter((v) => v < table.vertexCount));
  applyPose(ctx);
  return s;
}

/** Re-skins the preview at the current bend and refreshes the overlay arrays. */
function applyPose(ctx: SetupToolContext, partial?: Iterable<number>): void {
  const s = session;
  const sk = scratchFor(ctx);
  if (!s || !sk) return;
  poseScratch(sk, S.active, S.bend);
  s.skin.update(columnWorlds(sk, s.table.bones));
  if (s.skinGeo) {
    s.skinGeo.positions.set(s.skin.positions);
    s.skinGeo.getBuffer("aPosition").update();
  }
  if (s.heat && S.heat !== "off") {
    fillColors(s.table, S.heat, s.table.bones.indexOf(S.active ?? ""), s.heat.colors, 0.68, partial);
    s.heat.update();
  }
  syncSlotVisibility(ctx);
}

/** The slots that draw this mesh: its draw-group slots, or just its own slot. */
function slotsOf(s: Session): string[] {
  const groups = (s.mesh as RawMesh & { groups?: Record<string, unknown> }).groups;
  const names = groups ? Object.keys(groups) : [];
  return names.length ? names : [s.addr.slot];
}

/** Page UVs for the overlay: fits u = u0 + du * imageU (and v) from the real group meshes' vertices that sit at my rest positions. */
function pageUvs(character: CharacterLike, s: Session): { uvs: Float32Array; texture: Texture } | null {
  const key = (x: number, y: number) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
  const mine = new Map<string, number>();
  for (let v = 0; v < s.table.vertexCount; v++) mine.set(key(s.rest[v * 2] as number, s.rest[v * 2 + 1] as number), v);
  const names = new Set(slotsOf(s));
  const fit = { n: 0, su: 0, sd: 0, suu: 0, sud: 0, sv: 0, sdv: 0, svv: 0, svd: 0 };
  let texture: Texture | null = null;
  for (const m of character.slotMeshes) {
    if (!names.has(m.label)) continue;
    const pos = m.geometry.positions;
    const uv = m.geometry.uvs;
    for (let i = 0; i + 1 < uv.length && i + 1 < pos.length; i += 2) {
      const v = mine.get(key(pos[i] as number, pos[i + 1] as number));
      if (v === undefined) continue;
      const du = s.uvs[v * 2] as number;
      const dv = s.uvs[v * 2 + 1] as number;
      const pu = uv[i] as number;
      const pv = uv[i + 1] as number;
      fit.n++;
      fit.su += du; fit.sd += pu; fit.suu += du * du; fit.sud += du * pu;
      fit.sv += dv; fit.sdv += pv; fit.svv += dv * dv; fit.svd += dv * pv;
      texture ??= m.texture;
    }
  }
  if (fit.n < 3 || !texture) return null;
  const denU = fit.n * fit.suu - fit.su * fit.su;
  const denV = fit.n * fit.svv - fit.sv * fit.sv;
  if (Math.abs(denU) < 1e-9 || Math.abs(denV) < 1e-9) return null;
  const ku = (fit.n * fit.sud - fit.su * fit.sd) / denU;
  const ku0 = (fit.sd - ku * fit.su) / fit.n;
  const kv = (fit.n * fit.svd - fit.sv * fit.sdv) / denV;
  const kv0 = (fit.sdv - kv * fit.sv) / fit.n;
  const uvs = new Float32Array(s.uvs.length);
  for (let v = 0; v < s.table.vertexCount; v++) {
    uvs[v * 2] = ku0 + ku * (s.uvs[v * 2] as number);
    uvs[v * 2 + 1] = kv0 + kv * (s.uvs[v * 2 + 1] as number);
  }
  return { uvs, texture };
}

function skinVisible(): boolean {
  return !!session?.skinMesh && (S.bend !== 0 || !!stroke);
}

function syncSlotVisibility(ctx: SetupToolContext): void {
  const s = session;
  if (!s) return;
  for (const slot of slotsOf(s)) ctx.setSlotHidden(slot, skinVisible());
  if (s.skinMesh) s.skinMesh.visible = skinVisible();
  if (s.heat) s.heat.node.visible = S.heat !== "off";
}

function disposeNodes(): void {
  if (session) {
    for (const slot of slotsOf(session)) activeCtx?.setSlotHidden(slot, false);
    session.heat?.destroy();
    session.skinMesh?.destroy();
    session.heat = null;
    session.skinMesh = null;
    session.skinGeo = null;
  }
  root?.removeFromParent();
  root?.destroy({ children: true });
  root = null;
}

interface CharacterLike extends Container {
  slotMeshes: readonly Mesh<MeshGeometry>[];
}

/** Attaches the overlay nodes next to the character (called from drawOverlay, where the overlay Graphics' parent is known). */
function attachNodes(g: Graphics, ctx: SetupToolContext): void {
  const s = session;
  const parent = g.parent;
  if (!s || !parent) return;
  if (!root || root.destroyed) {
    root = new Container({ label: "weights-overlay" });
    s.skinMesh = null;
    s.heat = null;
  }
  const character = parent.children.find((c) => "slotMeshes" in c) as CharacterLike | undefined;
  const real0 = character?.slotMeshes.find((m) => m.label === s.addr.slot);
  dbg = { character: !!character, labels: character?.slotMeshes.map((m) => m.label).slice(0, 12) ?? [], real: !!real0, realUv: real0?.geometry.uvs.length ?? -1, want: s.uvs.length, tex: !!real0?.texture };
  if (root.parent !== parent) parent.addChildAt(root, Math.max(0, parent.getChildIndex(g)));
  if (character) root.setFromMatrix(character.localTransform);
  if (!s.skinMesh && character) {
    const fitted = pageUvs(character, s);
    if (fitted) {
      s.skinGeo = new MeshGeometry({ positions: new Float32Array(s.skin.positions), uvs: fitted.uvs, indices: Uint32Array.from(s.triangles) });
      s.skinMesh = new Mesh({ geometry: s.skinGeo, texture: fitted.texture });
      s.skinMesh.visible = false;
      root.addChildAt(s.skinMesh, 0);
    }
  }
  if (!s.heat) {
    s.heat = new HeatMesh(s.skin.positions, s.triangles, new URLSearchParams(location.search).has("heatgraphics"));
    root.addChild(s.heat.node);
    applyPose(ctx);
  }
  syncSlotVisibility(ctx);
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------

/** Sends the session's table (and its variants) as one `weights.table` batch: one undo step. */
async function commit(ctx: SetupToolContext, label: string, table: WeightTable | null = null): Promise<boolean> {
  const s = session;
  if (!s || busyCommit) return false;
  busyCommit = true;
  const t = table ?? s.table;
  try {
    const targets: MeshAddress[] = [s.addr, ...s.variants.map((name) => ({ ...s.addr, name }))];
    const ok = await ctx.run(label, (raw) => {
      const commands: unknown[] = [];
      for (const a of targets) {
        const m = rawMeshOf(raw, a);
        if (m && !m.bones?.length) commands.push({ op: "weights.bind", ...a, bone: s.slotBone });
        commands.push(toTableCommand(t, a));
      }
      return { commands: commands as Command[] };
    });
    if (ok) {
      session = null;
      const again = ensureSession(ctx);
      if (again) {
        attachNodesLater(ctx);
      }
    }
    return ok;
  } finally {
    busyCommit = false;
    ctx.renderPanel();
    ctx.redraw();
  }
}

let needAttach = false;
let dbg: unknown = null;
const attachNodesLater = (ctx: SetupToolContext): void => {
  needAttach = true;
  ctx.redraw();
};

// ---------------------------------------------------------------------------------------------
// Auto-weights
// ---------------------------------------------------------------------------------------------

function weightBones(sk: Skeleton, names: readonly string[], rest: Float64Array): WeightBone[] {
  const out = names.map((name) => {
    const b = sk.findBone(name) as Bone;
    const len = Math.max(1, b.data.length);
    const w = b.world;
    return { name, start: { x: w.x, y: w.y }, end: { x: w.x + len * w.a, y: w.y + len * w.c }, radius: 8 };
  });
  const V = rest.length / 2;
  const near: number[][] = out.map(() => []);
  for (let v = 0; v < V; v++) {
    let best = 0;
    let bd = Infinity;
    out.forEach((bn, i) => {
      const d = segDist(rest[v * 2] as number, rest[v * 2 + 1] as number, bn.start, bn.end);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    near[best]!.push(bd);
  }
  near.forEach((list, i) => {
    if (list.length === 0) return;
    list.sort((a, b) => a - b);
    out[i]!.radius = Math.max(4, list[Math.floor(list.length / 2)] as number);
  });
  return out;
}

function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function chainFor(ctx: SetupToolContext): string[] {
  const s = session;
  const sk = scratchFor(ctx);
  if (!s || !sk) return [];
  const sel = ctx.host.selected();
  return chainBetween((n) => sk.findBone(n)?.parent?.data.name ?? null, s.slotBone, sel);
}

function sleeveFor(ctx: SetupToolContext): WeightTable | string {
  const s = session;
  const sk = scratchFor(ctx);
  if (!s || !sk) return "No mesh selected.";
  poseScratch(sk, null, 0);
  const n = sleeveBones(S.side);
  const missing = Object.values(n).filter((name) => !sk.findBone(name));
  if (missing.length) return `Sleeve profile needs ${Object.values(n).join(", ")}; missing ${missing.join(", ")}.`;
  const at = (name: string) => sk.findBone(name)!.world;
  const tip = (name: string) => {
    const b = sk.findBone(name)!;
    return [b.world.x + b.data.length * b.world.a, b.world.y + b.data.length * b.world.c] as const;
  };
  const arm: SleeveArm = {
    S: [at(n.upperArm).x, at(n.upperArm).y],
    E: [at(n.elbow).x, at(n.elbow).y],
    W: tip(n.forearm),
    shoulderRadius: 24,
    centerX: sk.findBone("chest")?.world.x ?? sk.findBone("root")?.world.x ?? s.rest[0] ?? 0
  };
  const ux = arm.E[0] - arm.S[0];
  const uy = arm.E[1] - arm.S[1];
  const ul = Math.hypot(ux, uy) || 1;
  const fx = arm.W[0] - arm.E[0];
  const fy = arm.W[1] - arm.E[1];
  const fl = Math.hypot(fx, fy) || 1;
  const samples: { p: [number, number]; d: number }[] = [];
  const near: number[] = [];
  for (let v = 0; v < s.table.vertexCount; v++) {
    const p: [number, number] = [s.rest[v * 2] as number, s.rest[v * 2 + 1] as number];
    const du = ((p[0] - arm.E[0]) * ux + (p[1] - arm.E[1]) * uy) / ul;
    const d = du < 0 ? du : ((p[0] - arm.E[0]) * fx + (p[1] - arm.E[1]) * fy) / fl;
    samples.push({ p, d });
    if (Math.abs(d) < 6) near.push(Math.abs((p[0] - arm.E[0]) * (-uy / ul) + (p[1] - arm.E[1]) * (ux / ul)));
  }
  near.sort((a, b) => a - b);
  const width0 = near.length ? Math.max(8, 2 * (near[Math.floor(near.length / 2)] as number)) : 40;
  arm.shoulderRadius = width0 * 0.6;
  return sleeveWeights(arm, samples, elbowZone(width0, S.sleeve), S.side, S.sleeve);
}

async function bindAndAuto(ctx: SetupToolContext, bindFirst: boolean): Promise<void> {
  const s = ensureSession(ctx);
  if (!s) return ctx.host.status("Select a slot with a mesh first.", "bad");
  const chain = chainFor(ctx);
  const sk = scratchFor(ctx);
  if (!sk || chain.length === 0) return;
  const label = bindFirst ? `Bind to ${chain[chain.length - 1]}` : `Auto weights (${S.auto})`;
  if (S.auto === "heat") {
    const ok = await ctx.run(label, (raw) => {
      const commands: unknown[] = [];
      const m = rawMeshOf(raw, s.addr);
      if (m && !m.bones?.length) commands.push({ op: "weights.bind", ...s.addr, bone: chain[0] });
      commands.push({ op: "weights.auto", ...s.addr, bones: chain, heat: S.heatK, smooth: S.smoothPasses });
      return { commands: commands as Command[] };
    });
    if (ok) S.active = chain[chain.length - 1] ?? S.active;
  } else {
    poseScratch(sk, null, 0);
    let table: WeightTable;
    if (S.auto === "distance") table = distanceWeights(s.rest, weightBones(sk, chain, s.rest), { power: S.power });
    else {
      const r = sleeveFor(ctx);
      if (typeof r === "string") return ctx.host.status(r, "bad");
      table = r;
    }
    await commit(ctx, label, table);
  }
  session = null;
  ctx.renderPanel();
  ctx.redraw();
}

// ---------------------------------------------------------------------------------------------
// Pipeline weights and the near <-> far mirror (MESH-WEIGHTS-PLAN W3; maths in weightsImport.ts)
// ---------------------------------------------------------------------------------------------

let importReport = "";
let importBusy = false;

/** Writes one `weights.table` per target (binding an unweighted mesh first) in ONE `run`, so it is one undo step. */
async function commitMany(ctx: SetupToolContext, label: string, items: { addr: MeshAddress; table: WeightTable; slotBone: string }[], min?: number): Promise<boolean> {
  const ok = await ctx.run(label, (raw) => {
    const commands: unknown[] = [];
    for (const it of items) {
      const m = rawMeshOf(raw, it.addr);
      if (m && !m.bones?.length) commands.push({ op: "weights.bind", ...it.addr, bone: it.slotBone });
      commands.push(toTableCommand(it.table, it.addr, min === undefined ? {} : { min }));
    }
    return { commands: commands as Command[] };
  });
  session = null;
  if (ok) ensureSession(ctx);
  return ok;
}

const slotBoneOf = (raw: JsonObject, slot: string): string => (rawList(raw["slots"]).find((x) => x["name"] === slot)?.["bone"] as string | undefined) ?? "root";

/** Fetches the rig folder's build scripts from the dev server. */
export async function fetchBuildScripts(document: string): Promise<BuildScript[]> {
  const res = await fetch(`/api/rig/scripts?file=${encodeURIComponent(document)}`);
  const body = (await res.json()) as { files?: BuildScript[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `scripts request failed (${res.status})`);
  return body.files ?? [];
}

async function restorePipeline(ctx: SetupToolContext): Promise<void> {
  const s = ensureSession(ctx);
  const rig = ctx.host.rig();
  if (!s || !rig || importBusy) return;
  importBusy = true;
  try {
    const scripts = await fetchBuildScripts(rig.document);
    const pipeline = parseBuildScripts(scripts, s.addr);
    if (!pipeline) {
      importReport = scripts.length ? "The build scripts have no weights for this mesh." : "This rig has no build scripts.";
      return;
    }
    const own = restoreTable(pipeline, { uvs: s.uvs, triangles: s.triangles });
    if (typeof own === "string") {
      importReport = own;
      return;
    }
    const items = [{ addr: s.addr, table: own.table, slotBone: s.slotBone }];
    for (const name of s.variants) {
      const addr = { ...s.addr, name };
      const vm = rawMeshOf(rig.raw, addr);
      const vp = parseBuildScripts(scripts, addr);
      const vr = vm && vp ? restoreTable(vp, { uvs: vm.uvs, triangles: vm.triangles }) : null;
      items.push({ addr, table: vr && typeof vr !== "string" ? vr.table : own.table, slotBone: s.slotBone });
    }
    const ok = await commitMany(ctx, "Restore pipeline weights", items, 0);
    const how = own.exact ? "" : ` (carried over by UV position from ${pipeline.count} to ${own.table.vertexCount} vertices)`;
    importReport = ok ? `Restored ${items.length} mesh${items.length === 1 ? "" : "es"} from ${pipeline.files.join(", ")}${how}.` : "Restore failed.";
  } catch (error) {
    importReport = error instanceof Error ? error.message : String(error);
  } finally {
    importBusy = false;
    ctx.renderPanel();
    ctx.redraw();
  }
}

/** The mesh on the other side of the body for the open mesh (partner slot, same attachment name when it exists). */
function mirrorTarget(s: Session): MeshAddress | null {
  const slot = partnerSlot(s.addr.slot);
  if (!slot) return null;
  const pool = (getHost()?.meshes() ?? []).filter((m) => m.skin === s.addr.skin && m.slot === slot);
  const hit = pool.find((m) => m.attachment === s.addr.name) ?? (pool.length === 1 ? pool[0] : undefined);
  return hit ? { skin: hit.skin, slot: hit.slot, name: hit.attachment } : null;
}

async function mirrorAcross(ctx: SetupToolContext): Promise<void> {
  const s = ensureSession(ctx);
  const rig = ctx.host.rig();
  const sk = scratchFor(ctx);
  if (!s || !rig || !sk || importBusy) return;
  importBusy = true;
  try {
    const target = mirrorTarget(s);
    if (!target) {
      importReport = "No mesh with the same name on the other side of this slot.";
      return;
    }
    if (!s.weighted) {
      importReport = "Bind and weight this mesh first.";
      return;
    }
    const tm = rawMeshOf(rig.raw, target);
    if (!tm) return;
    poseScratch(sk, null, 0);
    const world = (n: string) => sk.findBone(n)?.world as WorldMatrix | undefined;
    const targetSlotBone = slotBoneOf(rig.raw, target.slot);
    const targetPoints = restPoints(tm, targetSlotBone, world);
    const rigBones = rawList(rig.raw["bones"]).map((b) => ({ name: b["name"] as string, parent: (b["parent"] as string | undefined) ?? null, x: b["x"] as number | undefined, y: b["y"] as number | undefined, rotation: b["rotation"] as number | undefined }));
    const both = new Float64Array(s.rest.length + targetPoints.length);
    both.set(s.rest);
    both.set(targetPoints, s.rest.length);
    const bones = weightBones(sk, rigBones.map((b) => b.name), both);
    const table = mirrorTable({ source: { points: s.rest, triangles: s.triangles, table: s.table }, targetPoints, bones, rigBones });
    const items = [{ addr: target, table, slotBone: targetSlotBone }];
    if (S.sameVariants) for (const name of variantNames(attachmentsOf(rig.raw, target), target.name)) items.push({ addr: { ...target, name }, table, slotBone: targetSlotBone });
    const ok = await commitMany(ctx, `Mirror weights to ${target.slot}`, items);
    importReport = ok ? `Mirrored ${s.addr.slot} onto ${target.slot}${items.length > 1 ? ` and ${items.length - 1} variant${items.length > 2 ? "s" : ""}` : ""}.` : "Mirror failed.";
  } catch (error) {
    importReport = error instanceof Error ? error.message : String(error);
  } finally {
    importBusy = false;
    ctx.renderPanel();
    ctx.redraw();
  }
}

function pipelineSection(root: HTMLElement, ctx: SetupToolContext, s: Session): void {
  const side = nameSide(s.addr.slot);
  const can = mirrorTarget(s) !== null;
  const sec = h("section", { className: "wt-sec", id: "wt-pipeline" }, h("h3", {}, "Pipeline and mirror"));
  sec.append(
    h("div", { className: "wt-line" }, h("button", { className: "btn sm", id: "wt-restore", type: "button", textContent: "Restore pipeline weights", on: { click: () => void restorePipeline(ctx) } })),
    h(
      "div",
      { className: "wt-line" },
      h("button", { className: "btn sm", id: "wt-mirror-far", type: "button", textContent: "Mirror near to far", title: "Mirror weights L↔R: copy this near-side mesh's weights onto the matching far-side mesh. One undo step", disabled: !(can && side === "near"), on: { click: () => void mirrorAcross(ctx) } }),
      h("button", { className: "btn sm", id: "wt-mirror-near", type: "button", textContent: "Mirror far to near", title: "Mirror weights L↔R: copy this far-side mesh's weights onto the matching near-side mesh. One undo step", disabled: !(can && side === "far"), on: { click: () => void mirrorAcross(ctx) } })
    ),
    h("div", { className: "note wt-report", id: "wt-import-report", textContent: importReport })
  );
  root.append(sec);
}

// ---------------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------------

const lockedIdx = (s: Session): Set<number> => new Set([...S.locks].map((n) => s.table.bones.indexOf(n)).filter((i) => i >= 0));

function activeColumn(ctx: SetupToolContext): number {
  const s = session;
  if (!s || !S.active) return -1;
  let col = s.table.bones.indexOf(S.active);
  if (col < 0) {
    // A bone outside the table: add a zero column (the table, its locals and the heat colours all follow).
    const sk = scratchFor(ctx);
    if (!sk?.findBone(S.active)) return -1;
    const table = withColumn(s.table, S.active);
    s.table = table;
    s.skin = new SkinPreview(table, s.rest, columnWorlds(sk, table.bones));
    if (s.heat) {
      s.heat.destroy();
      s.heat = null;
    }
    s.restWorlds = columnWorlds(sk, table.bones);
    col = table.bones.indexOf(S.active);
    attachNodesLater(ctx);
  }
  return col;
}

function brushOptions(ctx: SetupToolContext) {
  const zoom = ctx.host.zoom() || 1;
  return { mode: S.mode, radius: S.radiusPx / zoom, strength: S.strength, falloff: S.falloff, value: S.value };
}

function dabs(ctx: SetupToolContext, x: number, y: number): void {
  const s = session;
  if (!s || !stroke) return;
  const opts = brushOptions(ctx);
  const target = { points: stroke.points, neighbours: s.neighbours };
  const locked = lockedIdx(s);
  const changed = new Set<number>();
  for (const d of stroke.spacer.advance(x, y)) for (const v of brushDab(s.table, target, stroke.col, d.x, d.y, opts, S.pressure ? lastPressure : 1, locked)) changed.add(v);
  if (changed.size === 0) return;
  for (const v of changed) stroke.touched.add(v);
  applyPose(ctx, changed);
  ctx.redraw();
  scheduleTable();
}

let tableQueued = false;
function scheduleTable(): void {
  if (tableQueued) return;
  tableQueued = true;
  requestAnimationFrame(() => {
    tableQueued = false;
    renderRows();
  });
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

function pointerTrack(e: PointerEvent): void {
  lastPressure = e.pointerType === "pen" ? Math.max(0.05, e.pressure || 0.5) : 1;
}

registerSetupSubTool({
  id: "weights",
  label: "Weights",
  key: "W",
  hint: "Paint which bones move each mesh vertex. [ and ] change the brush size; Alt-click picks the bone under the pointer.",
  activate(ctx) {
    activeCtx = ctx;
    document.addEventListener("pointermove", pointerTrack, true);
    document.addEventListener("pointerdown", pointerTrack, true);
    unsubs.push(
      onActivePaintBone((e) => {
        S.addr = { skin: e.skin, slot: e.slot, name: e.attachment };
        S.active = e.bone;
        session = null;
        ctx.renderPanel();
        ctx.redraw();
      })
    );
    session = null;
    S.lastSlot = ctx.slot();
    S.addr = null;
    ensureSession(ctx);
    needAttach = true;
  },
  deactivate(ctx) {
    document.removeEventListener("pointermove", pointerTrack, true);
    document.removeEventListener("pointerdown", pointerTrack, true);
    while (unsubs.length) unsubs.pop()?.();
    cancelAnimationFrame(swingFrame);
    S.swing = false;
    S.bend = 0;
    stroke = null;
    boxDrag = null;
    hover = null;
    disposeNodes();
    session = null;
    activeCtx = null;
  },
  pointerDown(p, e, ctx) {
    const s = ensureSession(ctx);
    hover = p;
    if (!s) return ctx.host.status("Select a slot that holds a mesh first.", "bad");
    const px = 1 / (ctx.host.zoom() || 1);
    const points = s.skin.positions;
    if (e.altKey) {
      const v = pickVertex(points, p.x, p.y, 40 * px);
      if (v >= 0) {
        let best = 0;
        for (let b = 0; b < s.table.bones.length; b++) if ((s.table.data[v * s.table.bones.length + b] as number) > (s.table.data[v * s.table.bones.length + best] as number)) best = b;
        S.active = s.table.bones[best] ?? S.active;
        ctx.renderPanel();
        applyPose(ctx);
        ctx.redraw();
      }
      return true;
    }
    if (S.tool === "select") {
      boxDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, sx: p.sx, sy: p.sy };
      (boxDrag as { mods?: unknown }).mods = { shift: e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey) };
      return true;
    }
    if (!S.active) return ctx.host.status("Pick a bone to paint with first.", "bad");
    const col = activeColumn(ctx);
    if (col < 0) return ctx.host.status("That bone is not in the skeleton.", "bad");
    if (S.locks.has(S.active)) return ctx.host.status(`${S.active} is locked.`, "bad");
    stroke = { spacer: new StrokeSpacer(() => dabStep(brushOptions(ctx))), touched: new Set(), points: new Float32Array(s.skin.positions), col };
    syncSlotVisibility(ctx);
    dabs(ctx, p.x, p.y);
    return true;
  },
  pointerMove(p, ctx) {
    hover = p;
    if (stroke) dabs(ctx, p.x, p.y);
    else if (boxDrag) {
      boxDrag.x1 = p.x;
      boxDrag.y1 = p.y;
    }
    ctx.redraw();
    return !!stroke || !!boxDrag;
  },
  pointerUp(ctx) {
    const s = session;
    if (boxDrag && s) {
      const b = boxDrag;
      boxDrag = null;
      const mods = (b as { mods?: { shift: boolean; ctrl: boolean } }).mods ?? { shift: false, ctrl: false };
      const px = 1 / (ctx.host.zoom() || 1);
      const moved = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / px;
      S.select =
        moved < 4
          ? clickSelect(S.select, pickVertex(s.skin.positions, b.x0, b.y0, 14 * px), mods)
          : boxSelect(S.select, s.skin.positions, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, mods);
      refreshRows(ctx);
      ctx.redraw();
      return true;
    }
    if (stroke) {
      const done = stroke;
      stroke = null;
      if (done.touched.size > 0) void commit(ctx, "Paint weights");
      else {
        syncSlotVisibility(ctx);
        ctx.redraw();
      }
      return true;
    }
    return false;
  },
  drawOverlay(g, px, ctx) {
    const s = ensureSession(ctx);
    if (!s) return;
    needAttach = false;
    attachNodes(g, ctx);
    // Selected vertices and all vertex dots (small, faint) so the mesh reads while painting.
    const pts = s.skin.positions;
    const sel = S.select;
    for (let v = 0; v < s.table.vertexCount; v++) {
      if (sel.has(v)) continue;
      g.circle(pts[v * 2] as number, pts[v * 2 + 1] as number, 1.6 * px).fill({ color: 0xffffff, alpha: 0.35 });
    }
    for (const v of sel) g.circle(pts[v * 2] as number, pts[v * 2 + 1] as number, 3.2 * px).fill({ color: 0xf2b84b }).stroke({ width: px, color: 0x14110a });
    if (boxDrag) {
      const x = Math.min(boxDrag.x0, boxDrag.x1);
      const y = Math.min(boxDrag.y0, boxDrag.y1);
      g.rect(x, y, Math.abs(boxDrag.x1 - boxDrag.x0), Math.abs(boxDrag.y1 - boxDrag.y0)).fill({ color: 0xf2b84b, alpha: 0.12 }).stroke({ width: px, color: 0xf2b84b });
    }
    if (hover && S.tool === "paint") {
      const r = S.radiusPx * px;
      g.circle(hover.x, hover.y, r).stroke({ width: 1.5 * px, color: 0xffffff, alpha: 0.9 });
      g.circle(hover.x, hover.y, r * 0.5).stroke({ width: px, color: 0xffffff, alpha: S.falloff === "smooth" ? 0.35 : 0 });
    }
  },
  onKey(e, ctx) {
    if (e.key === "[" || e.key === "]") {
      S.radiusPx = Math.min(200, Math.max(4, S.radiusPx * (e.key === "]" ? 1.15 : 1 / 1.15)));
      ctx.renderPanel();
      ctx.redraw();
      return true;
    }
    const modeKeys: Record<string, WState["mode"]> = { "1": "add", "2": "subtract", "3": "smooth", "4": "set" };
    if (modeKeys[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
      S.mode = modeKeys[e.key]!;
      ctx.renderPanel();
      return true;
    }
    if (e.key === "Escape") {
      S.select = new Set();
      refreshRows(ctx);
      ctx.redraw();
      return false;
    }
    return false;
  },
  panel(box, ctx) {
    renderWeightsPanel(box, ctx);
  }
});

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === "className") e.className = String(v);
    else if (k === "on") for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) e.addEventListener(ev, fn);
    else if (k === "style") e.setAttribute("style", String(v));
    else if (k in e && k !== "list") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void, id?: string): HTMLElement {
  const out = h("span", { className: "wt-val", textContent: fmt(value) });
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), id, className: "wt-range" });
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  return h("label", { className: "wt-row" }, h("span", { className: "wt-lab", textContent: label }), input, out);
}

function seg<T extends string>(items: readonly (readonly [T, string, string?])[], value: T, onPick: (v: T) => void, id?: string): HTMLElement {
  const wrap = h("div", { className: "seg wt-seg", id });
  for (const [v, label, tip] of items) {
    const b = h("button", { type: "button", textContent: label, className: v === value ? "on" : "", title: tip ?? "" });
    b.dataset["v"] = v;
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      onPick(v);
    });
    wrap.append(b);
  }
  return wrap;
}

const swatch = (name: string): HTMLElement => h("i", { className: "wt-dot", style: `background:#${boneColor(name).toString(16).padStart(6, "0")}` });

/** Which secondary groups the painter has opened or closed; the panel re-renders after every edit and must not snap them shut. */
const foldOpen = new Map<string, boolean>();

function renderWeightsPanel(box: HTMLElement, ctx: SetupToolContext): void {
  const s = ensureSession(ctx);
  const root = h("div", { className: "wt", id: "wt-root" });
  box.append(h("h2", {}, "Weights"), root);
  const meshes = getHost()?.meshes() ?? [];
  if (!s) {
    root.append(h("div", { className: "note", textContent: meshes.length ? "Select a slot that holds a mesh (or pick one below)." : "This rig has no mesh. Use Mesh to convert an image first." }));
    if (meshes.length) root.append(meshSelect(ctx, meshes));
    return;
  }
  const V = s.table.vertexCount;
  const fold = (title: string, open: boolean, id: string, ...kids: Child[]): HTMLElement => {
    const d = h("details", { className: "wt-fold", id, open: foldOpen.get(id) ?? open }, h("summary", {}, title), ...kids);
    d.addEventListener("toggle", () => foldOpen.set(id, d.open));
    return d;
  };

  // --- Mesh (one compact row: picker, then counts)
  root.append(meshSelect(ctx, meshes));
  root.append(
    h(
      "div",
      { className: "wt-chips" },
      h("span", { className: "chip", textContent: `${V} vertices` }),
      h("span", { className: s.weighted ? "chip chip-ok" : "chip chip-warn", textContent: s.weighted ? `${s.table.bones.length} bones` : "not weighted" }),
      s.variants.length ? h("span", { className: "chip chip-info", textContent: `${s.variants.length} variants`, title: s.variants.join(", ") }) : null
    )
  );

  // --- Bind and auto
  const sel = ctx.host.selected();
  const bindBox = h("section", { className: "wt-sec" }, h("h3", {}, "Bind and auto"));
  bindBox.append(
    h(
      "div",
      { className: "wt-line" },
      h("button", { id: "wt-bind", className: "btn sm", type: "button", textContent: s.weighted ? "Re-bind" : "Bind", title: "Bind to the chain from the slot bone to the selected bone, then auto-weight", on: { click: () => void bindAndAuto(ctx, true) } }),
      h("span", { className: "wt-dim", textContent: `${s.slotBone}${sel && sel !== s.slotBone ? " > " + sel : ""}` })
    )
  );
  const params = h("div", { className: "wt-params", id: "wt-auto-params" });
  const fillParams = () => {
    params.replaceChildren();
    if (S.auto === "heat") {
      params.append(slider("Heat", 0.05, 2, 0.05, S.heatK, (v) => v.toFixed(2), (v) => (S.heatK = v)), slider("Smooth", 0, 6, 1, S.smoothPasses, (v) => String(v), (v) => (S.smoothPasses = v)));
    } else if (S.auto === "distance") {
      params.append(slider("Power", 0.5, 6, 0.25, S.power, (v) => v.toFixed(2), (v) => (S.power = v)));
    } else {
      params.append(
        h("label", { className: "wt-row" }, h("span", { className: "wt-lab", textContent: "Side" }), h("input", { className: "in", value: S.side, style: "width:42px", on: { input: (ev: Event) => (S.side = (ev.target as HTMLInputElement).value || "l") } })),
        slider("ELBOW_K", 0.05, 0.6, 0.01, S.sleeve.ELBOW_K, (v) => v.toFixed(2), (v) => (S.sleeve.ELBOW_K = v)),
        slider("CLAV_MAX", 0, 1, 0.01, S.sleeve.CLAV_MAX, (v) => v.toFixed(2), (v) => (S.sleeve.CLAV_MAX = v)),
        slider("CLAV_T0", 0, 1, 0.01, S.sleeve.CLAV_T0, (v) => v.toFixed(2), (v) => (S.sleeve.CLAV_T0 = v)),
        slider("INNER_SHARP", 0, 1, 0.01, S.sleeve.INNER_SHARP, (v) => v.toFixed(2), (v) => (S.sleeve.INNER_SHARP = v)),
        slider("INNER_EDGE", 1, 16, 0.5, S.sleeve.INNER_EDGE, (v) => v.toFixed(1), (v) => (S.sleeve.INNER_EDGE = v))
      );
    }
  };
  fillParams();
  bindBox.append(
    h(
      "div",
      { className: "wt-line" },
      h("select", { className: "in", id: "wt-auto", on: { change: (ev: Event) => { S.auto = (ev.target as HTMLSelectElement).value as WState["auto"]; fillParams(); } } },
        ...(["heat", "distance", "sleeve"] as const).map((k) => h("option", { value: k, textContent: k === "heat" ? "Heat" : k === "distance" ? "Distance" : "Sleeve profile", selected: S.auto === k }))
      ),
      h("button", { id: "wt-apply", className: "btn sm", type: "button", textContent: "Apply", title: "Compute weights with the chosen method and save them", on: { click: () => void bindAndAuto(ctx, false) } })
    ),
    params
  );
  // Bind and auto sits under the paint view (open only while the mesh has no weights yet).

  // --- Brush
  const brush = h("section", { className: "wt-sec" }, h("h3", {}, "Brush"));
  brush.append(
    h("div", { className: "wt-line" },
      seg([["paint", "Paint", "Drag to paint the active bone"], ["select", "Select", "Click or drag a box to select vertices (Shift adds, Ctrl toggles)"]] as const, S.tool, (v) => { S.tool = v; ctx.redraw(); }, "wt-tool"),
      h("button", { className: "btn sm", id: "wt-normalise", type: "button", textContent: "Normalise", title: "Make every vertex's weights add up to 1. One undo step", on: { click: () => void runCleanup(ctx, "normalise") } })),
    seg([["add", "Add", "Add weight to the active bone (1)"], ["subtract", "Subtract", "Take weight from the active bone (2)"], ["smooth", "Smooth", "Blend each vertex toward its neighbours (3)"], ["set", "Set", "Set the active bone to the strength value (4)"]] as const, S.mode, (v) => (S.mode = v), "wt-mode"),
    slider("Radius", 4, 200, 1, Math.round(S.radiusPx), (v) => `${Math.round(v)} px`, (v) => { S.radiusPx = v; ctx.redraw(); }, "wt-radius"),
    slider("Strength", 0.02, 1, 0.01, S.strength, (v) => v.toFixed(2), (v) => (S.strength = v), "wt-strength"),
    h(
      "div",
      { className: "wt-line" },
      seg([["smooth", "Smooth fall"], ["hard", "Hard"]] as const, S.falloff, (v) => (S.falloff = v), "wt-falloff"),
      h("label", { className: "wt-check", title: "Pen pressure scales the strength" }, h("input", { type: "checkbox", checked: S.pressure, id: "wt-pressure", on: { change: (ev: Event) => (S.pressure = (ev.target as HTMLInputElement).checked) } }), "Pressure")
    )
  );
  if (s.variants.length || S.sameVariants)
    brush.append(
      h("label", { className: "wt-check", title: "Writes the same weights to the sleeve crease variants (c###)" }, h("input", { type: "checkbox", checked: S.sameVariants, id: "wt-variants", on: { change: (ev: Event) => { S.sameVariants = (ev.target as HTMLInputElement).checked; session = null; ctx.renderPanel(); } } }), "Same weights on variants")
    );
  root.append(brush);

  // --- Bones
  const bones = h("section", { className: "wt-sec" }, h("h3", {}, "Bones"));
  const list = h("div", { className: "wt-bones", id: "wt-bones" });
  s.table.bones.forEach((name, b) => {
    let total = 0;
    for (let v = 0; v < V; v++) total += s.table.data[v * s.table.bones.length + b] as number;
    const locked = S.locks.has(name);
    list.append(
      h(
        "div",
        { className: `wt-bone${S.active === name ? " on" : ""}`, title: "Make this the paint bone" },
        swatch(name),
        h("button", { className: "wt-bname", type: "button", textContent: name, on: { click: () => { S.active = name; ctx.renderPanel(); applyPose(ctx); ctx.redraw(); } } }),
        h("span", { className: "wt-dim", textContent: `${((total / Math.max(1, V)) * 100).toFixed(0)}%` }),
        h("button", { className: `wt-lock${locked ? " on" : ""}`, type: "button", textContent: locked ? "Locked" : "Lock", title: "A locked bone keeps its weights while you paint", on: { click: (ev: Event) => { ev.stopPropagation(); if (locked) S.locks.delete(name); else S.locks.add(name); ctx.renderPanel(); } } })
      )
    );
  });
  bones.append(list);
  const all = (getHost()?.setupRaw?.()?.["bones"] as JsonObject[] | undefined)?.map((b) => String(b["name"])) ?? [];
  const extra = all.filter((n) => !s.table.bones.includes(n));
  if (extra.length)
    bones.append(
      h("select", { className: "in", id: "wt-addbone", on: { change: (ev: Event) => { const v = (ev.target as HTMLSelectElement).value; if (v) { S.active = v; activeColumn(ctx); applyPose(ctx); ctx.renderPanel(); ctx.redraw(); } } } }, h("option", { value: "", textContent: "Add a bone to paint..." }), ...extra.map((n) => h("option", { value: n, textContent: n })))
    );
  root.append(bones);

  // --- Heat map and bend
  const view = h("section", { className: "wt-sec" }, h("h3", {}, "Heat map and bend test"));
  view.append(
    seg([["off", "Off"], ["active", "Active bone"], ["all", "All bones"]] as const, S.heat, (v) => { S.heat = v; applyPose(ctx); ctx.redraw(); }, "wt-heat"),
    slider("Bend", -120, 120, 1, S.bend, (v) => `${Math.round(v)}°`, (v) => { S.bend = v; applyPose(ctx); ctx.redraw(); }, "wt-bend"),
    h(
      "div",
      { className: "wt-line" },
      h("label", { className: "wt-check" }, h("input", { type: "checkbox", id: "wt-swing", checked: S.swing, on: { change: (ev: Event) => setSwing(ctx, (ev.target as HTMLInputElement).checked) } }), "Swing"),
      h("button", { className: "btn sm", type: "button", textContent: "Reset bend", on: { click: () => { S.bend = 0; S.swing = false; ctx.renderPanel(); applyPose(ctx); ctx.redraw(); } } })
    )
  );
  root.append(view);
  root.append(fold("Bind and auto-weight", !s.weighted, "wt-fold-bind", bindBox));

  // --- Table
  const tbl = h("section", { className: "wt-sec" }, h("h3", {}, `Selected vertices (${S.select.size})`));
  tbl.append(
    h(
      "div",
      { className: "wt-line" },
      h("button", { className: "btn sm", type: "button", textContent: "All", on: { click: () => { S.select = selectAll(s.skin.positions); refreshRows(ctx); ctx.redraw(); } } }),
      h("button", { className: "btn sm", type: "button", textContent: "None", on: { click: () => { S.select = new Set(); refreshRows(ctx); ctx.redraw(); } } }),
      h("button", { className: "btn sm", type: "button", textContent: "Grow", on: { click: () => { S.select = growSelection(S.select, s.neighbours); refreshRows(ctx); ctx.redraw(); } } }),
      h("button", { className: "btn sm", type: "button", textContent: "Shrink", on: { click: () => { S.select = shrinkSelection(S.select, s.neighbours); refreshRows(ctx); ctx.redraw(); } } })
    ),
    h(
      "div",
      { className: "wt-line" },
      h("input", { className: "in num", type: "number", min: "0", max: "100", step: "5", value: String(Math.round(S.setValue * 100)), id: "wt-setval", title: "The weight to give the active bone, in percent (100 = all of it)", on: { input: (ev: Event) => (S.setValue = Math.min(1, Math.max(0, Number((ev.target as HTMLInputElement).value) / 100))) } }),
      h("span", { className: "wt-dim", textContent: "%" }),
      h("button", { className: "btn sm", id: "wt-setsel", type: "button", textContent: "Set active % on selection", on: { click: () => void setOnSelection(ctx) } })
    )
  );
  tableHost = h("div", { className: "wt-table", id: "wt-table" });
  tbl.append(tableHost);
  root.append(tbl);
  selRows = [...S.select].sort((a, b) => a - b);
  buildTable(ctx);

  // --- Cleanup
  const clean = h("section", { className: "wt-sec" }, h("h3", {}, "Cleanup"));
  clean.append(
    h(
      "div",
      { className: "wt-line" },
      h("label", { className: "wt-lab" }, "Min", h("input", { className: "in num", type: "number", min: "0", max: "0.5", step: "0.01", value: String(S.min), id: "wt-min", on: { input: (ev: Event) => (S.min = Number((ev.target as HTMLInputElement).value)) } })),
      h("label", { className: "wt-lab" }, "Cap", h("select", { className: "in", id: "wt-cap", on: { change: (ev: Event) => (S.cap = Number((ev.target as HTMLSelectElement).value)) } }, ...[1, 2, 3, 4].map((n) => h("option", { value: String(n), textContent: String(n), selected: S.cap === n }))))
    ),
    h(
      "div",
      { className: "wt-line" },
      h("button", { className: "btn sm", id: "wt-prune", type: "button", textContent: "Prune", title: "Prune small weights: drop weights below Min and renormalise. One undo step", on: { click: () => void runCleanup(ctx, "prune") } }),
      h("button", { className: "btn sm", id: "wt-cap-go", type: "button", textContent: "Cap", on: { click: () => void runCleanup(ctx, "cap") } })
    ),
    h(
      "div",
      { className: "wt-line" },
      h("label", { className: "wt-lab", title: "How far each vertex moves toward its neighbours' weights (percent)" }, "Smooth %", h("input", { className: "in num", type: "number", min: "5", max: "100", step: "5", value: String(Math.round(S.smoothAmount * 100)), id: "wt-smooth-amount", on: { input: (ev: Event) => (S.smoothAmount = Math.min(1, Math.max(0.05, Number((ev.target as HTMLInputElement).value) / 100 || 0.5))) } })),
      h("button", { className: "btn sm", id: "wt-smooth", type: "button", textContent: "Smooth", title: "Smooth: blend the weights of the selected vertices (every vertex with none selected) toward their neighbours. One undo step", on: { click: () => void smoothWeights(ctx) } })
    ),
    h(
      "div",
      { className: "wt-line" },
      h("label", { className: "wt-lab", title: "Vertices of different meshes closer than this (pixels) are welded" }, "Weld px", h("input", { className: "in num", type: "number", min: "0.1", max: "20", step: "0.5", value: String(S.weldTol), id: "wt-weld-tol", on: { input: (ev: Event) => (S.weldTol = Math.max(0.1, Number((ev.target as HTMLInputElement).value) || 1)) } })),
      h("button", { className: "btn sm", id: "wt-weld", type: "button", textContent: "Weld / Merge", title: "Weld seams: vertices of different weighted meshes in this skin that sit within the tolerance share the average of their weights. One undo step", on: { click: () => void weldSeams(ctx) } })
    ),
    h(
      "div",
      { className: "wt-line" },
      h("button", { className: "btn sm", id: "wt-copy", type: "button", textContent: "Copy weights", disabled: !s.weighted, title: "Copy this mesh's weights (to paste onto another mesh with the same number of vertices)", on: { click: () => copyWeights(ctx) } }),
      h("button", { className: "btn sm", id: "wt-paste", type: "button", textContent: "Paste weights", disabled: !copied, title: "Paste the copied weights onto the selected vertices, or the whole mesh with none selected. One undo step", on: { click: () => void pasteWeights(ctx) } })
    ),
    h("div", { className: "note wt-report", id: "wt-report", textContent: S.report })
  );
  root.append(fold("Cleanup, mirror and restore", true, "wt-fold-clean", clean));
  pipelineSection(root, ctx, s);
}

function meshSelect(ctx: SetupToolContext, meshes: ReturnType<NonNullable<ReturnType<typeof getHost>>["meshes"]>): HTMLElement {
  const cur = S.addr ? `${S.addr.skin}|${S.addr.slot}|${S.addr.name}` : "";
  return h(
    "select",
    { className: "in wt-mesh", id: "wt-mesh", on: { change: (ev: Event) => { const [skin, slot, name] = (ev.target as HTMLSelectElement).value.split("|"); S.addr = { skin: skin!, slot: slot!, name: name! }; session = null; getHost()?.selectSlot(slot!); S.lastSlot = slot!; ctx.renderPanel(); ctx.redraw(); } } },
    ...meshes.map((m) => h("option", { value: `${m.skin}|${m.slot}|${m.attachment}`, textContent: `${m.slot} / ${m.attachment}${m.weighted ? "" : " (unweighted)"} - ${m.vertexCount}`, selected: `${m.skin}|${m.slot}|${m.attachment}` === cur }))
  );
}

function setSwing(ctx: SetupToolContext, on: boolean): void {
  S.swing = on;
  cancelAnimationFrame(swingFrame);
  if (!on) {
    S.bend = Number((document.getElementById("wt-bend") as HTMLInputElement | null)?.value ?? 0);
    applyPose(ctx);
    ctx.redraw();
    return;
  }
  const amplitude = Math.abs(S.bend) < 5 ? 90 : S.bend;
  const t0 = performance.now();
  const tick = () => {
    if (!S.swing || activeCtx !== ctx) return;
    S.bend = amplitude * Math.sin(((performance.now() - t0) / 2200) * Math.PI * 2);
    applyPose(ctx);
    ctx.redraw();
    swingFrame = requestAnimationFrame(tick);
  };
  swingFrame = requestAnimationFrame(tick);
}

async function setOnSelection(ctx: SetupToolContext): Promise<void> {
  const s = session;
  if (!s || S.select.size === 0 || !S.active) return;
  const col = activeColumn(ctx);
  if (col < 0) return;
  const changed = setSelection(s.table, S.select, col, S.setValue, lockedIdx(s));
  if (changed.length) await commit(ctx, `Set ${S.active} to ${Math.round(S.setValue * 100)}%`);
}

async function runCleanup(ctx: SetupToolContext, kind: "normalise" | "prune" | "cap"): Promise<void> {
  const s = session;
  if (!s) return;
  const next = { vertexCount: s.table.vertexCount, bones: s.table.bones, data: new Float32Array(s.table.data) } as WeightTable;
  let report = "";
  if (kind === "normalise") {
    normalizeTable(next);
    report = "Normalised: every vertex sums to 1.";
  } else {
    const r = cleanup(next, { max: kind === "cap" ? S.cap : 4, min: kind === "prune" ? S.min : 0 });
    next.data.set(r.table.data);
    report = `${kind === "cap" ? `Cap ${S.cap}` : `Prune below ${S.min}`}: dropped ${(r.dropped.total * 100).toFixed(2)}% of one vertex's weight in total over ${r.dropped.vertices} vertices (worst vertex ${(r.dropped.max * 100).toFixed(1)}%).`;
  }
  S.report = report;
  await commit(ctx, kind === "normalise" ? "Normalise weights" : kind === "prune" ? "Prune weights" : `Cap weights at ${S.cap}`, next);
  S.report = report;
  ctx.renderPanel();
}

/** Smooth: each selected vertex (all of them with nothing selected) moves part of the way toward its neighbours' weights. One undo step. */
async function smoothWeights(ctx: SetupToolContext): Promise<void> {
  const s = session;
  if (!s) return;
  const picked = S.select.size > 0;
  const next = smoothTable(s.table, s.neighbours, picked ? S.select : null, S.smoothAmount);
  const report = `Smoothed ${picked ? `${S.select.size} selected vertices` : "every vertex"} by ${Math.round(S.smoothAmount * 100)}%.`;
  await commit(ctx, "Smooth weights", next);
  S.report = report;
  ctx.renderPanel();
}

/** Weld: vertices of different weighted meshes of this skin that sit within the tolerance (px) share the average of their weights. */
async function weldSeams(ctx: SetupToolContext): Promise<void> {
  const s = ensureSession(ctx);
  const rig = ctx.host.rig();
  const sk = scratchFor(ctx);
  if (!s || !rig || !sk || importBusy) return;
  importBusy = true;
  try {
    poseScratch(sk, null, 0);
    const world = (n: string) => sk.findBone(n)?.world as WorldMatrix | undefined;
    const names = rawList(rig.raw["bones"]).map((b) => b["name"] as string);
    const items: { addr: MeshAddress; table: WeightTable; slotBone: string; points: Float64Array; weights: { bone: number; weight: number }[][] }[] = [];
    for (const m of getHost()?.meshes() ?? []) {
      if (m.skin !== s.addr.skin || !m.weighted) continue;
      const addr = { skin: m.skin, slot: m.slot, name: m.attachment };
      const raw = rawMeshOf(rig.raw, addr);
      const table = raw ? tableOfMesh(raw) : null;
      if (!raw || !table) continue;
      const slotBone = slotBoneOf(rig.raw, m.slot);
      const weights = tableInfluences(table).map((row) => row.map((inf) => ({ bone: names.indexOf(table.bones[inf.bone] as string), weight: inf.weight })));
      items.push({ addr, table, slotBone, points: restPoints(raw, slotBone, world), weights });
    }
    if (items.length < 2) {
      S.report = "Weld needs at least two weighted meshes in this skin.";
      return;
    }
    const welded = weldWeights(items, S.weldTol);
    if (welded === 0) {
      S.report = `No vertices of different meshes within ${S.weldTol} px of each other.`;
      return;
    }
    const out = items.map((it) => ({ addr: it.addr, slotBone: it.slotBone, table: trimTable(tableFromInfluences(names, it.weights), it.table.bones) }));
    const ok = await commitMany(ctx, "Weld mesh seams", out);
    S.report = ok ? `Welded ${welded} vertices across ${items.length} meshes (within ${S.weldTol} px).` : "Weld failed.";
  } catch (error) {
    S.report = error instanceof Error ? error.message : String(error);
  } finally {
    importBusy = false;
    ctx.renderPanel();
    ctx.redraw();
  }
}

let copied: { table: WeightTable; label: string } | null = null;

function copyWeights(ctx: SetupToolContext): void {
  const s = session;
  if (!s || !s.weighted) return;
  copied = { table: { vertexCount: s.table.vertexCount, bones: [...s.table.bones], data: new Float32Array(s.table.data) }, label: `${s.addr.slot}/${s.addr.name}` };
  S.report = `Copied the weights of ${copied.label} (${copied.table.vertexCount} vertices).`;
  ctx.renderPanel();
}

/** Paste: onto the selected vertices, or the whole mesh with nothing selected. Needs the same vertex count as the copy. */
async function pasteWeights(ctx: SetupToolContext): Promise<void> {
  const s = session;
  if (!s || !copied) return;
  const next = pasteTable(s.table, copied.table, S.select.size > 0 ? S.select : null);
  if (!next) {
    S.report = `Cannot paste: ${copied.label} has ${copied.table.vertexCount} vertices, this mesh has ${s.table.vertexCount}.`;
    ctx.renderPanel();
    return;
  }
  const report = `Pasted the weights of ${copied.label} onto ${S.select.size > 0 ? `${S.select.size} selected vertices` : "the whole mesh"}.`;
  await commit(ctx, "Paste weights", trimTable(next, s.table.bones));
  S.report = report;
  ctx.renderPanel();
}

// --- The virtualised table ---------------------------------------------------------------------

const ROW_H = 22;
function refreshRows(ctx: SetupToolContext): void {
  selRows = [...S.select].sort((a, b) => a - b);
  ctx.renderPanel();
}

function tableCols(s: Session): number[] {
  const B = s.table.bones.length;
  const used = new Set<number>();
  const a = S.active ? s.table.bones.indexOf(S.active) : -1;
  if (a >= 0) used.add(a);
  for (const v of selRows.slice(0, 400)) for (let b = 0; b < B; b++) if ((s.table.data[v * B + b] as number) > 0.0005) used.add(b);
  return [...used].sort((x, y) => x - y).slice(0, 8);
}

function buildTable(ctx: SetupToolContext): void {
  const s = session;
  const host = tableHost;
  if (!host || !s) return;
  host.replaceChildren();
  if (selRows.length === 0) {
    host.append(h("div", { className: "note", textContent: "Switch to Select, then click or drag a box over vertices to edit their weights here." }));
    return;
  }
  const cols = tableCols(s);
  const head = h("div", { className: "wt-trow wt-thead", style: `grid-template-columns:44px repeat(${cols.length},minmax(0,1fr))` }, h("span", { textContent: "Vtx %" }));
  for (const c of cols) head.append(h("span", { className: `wt-tcol${s.table.bones[c] === S.active ? " on" : ""}`, textContent: s.table.bones[c], title: s.table.bones[c] }));
  const body = h("div", { className: "wt-tbody", id: "wt-tbody" });
  const spacer = h("div", { style: `height:${selRows.length * ROW_H}px;position:relative` });
  body.append(spacer);
  host.append(head, body);
  const paint = () => {
    const top = body.scrollTop;
    const view = body.clientHeight || 176;
    const first = Math.max(0, Math.floor(top / ROW_H) - 2);
    const last = Math.min(selRows.length, Math.ceil((top + view) / ROW_H) + 2);
    spacer.replaceChildren();
    const B = s.table.bones.length;
    for (let i = first; i < last; i++) {
      const v = selRows[i] as number;
      const row = h("div", { className: "wt-trow", style: `position:absolute;left:0;right:0;top:${i * ROW_H}px;grid-template-columns:44px repeat(${cols.length},minmax(0,1fr))` }, h("span", { className: "wt-dim", textContent: String(v) }));
      for (const c of cols) {
        const input = h("input", { className: "in wt-cell", type: "number", min: "0", max: "100", step: "5", value: String(Number(((s.table.data[v * B + c] as number) * 100).toFixed(1))), title: `${s.table.bones[c]} weight of vertex ${v}, in percent; the other bones give or take the difference` });
        input.addEventListener("change", () => {
          const locked = lockedIdx(s);
          if (setRowWeight(s.table, v, c, Number(input.value) / 100, locked)) void commit(ctx, `Set vertex ${v} weight`);
          else {
            ctx.host.status("That change is not possible (locked bones or no other bone to take the weight).", "bad");
            input.value = String(Number(((s.table.data[v * B + c] as number) * 100).toFixed(1)));
          }
        });
        row.append(input);
      }
      spacer.append(row);
    }
  };
  body.addEventListener("scroll", paint);
  (host as HTMLElement & { _paint?: () => void })._paint = paint;
  paint();
  requestAnimationFrame(paint);
}

function renderRows(): void {
  (tableHost as (HTMLElement & { _paint?: () => void }) | null)?._paint?.();
}

// ---------------------------------------------------------------------------------------------
// Debug / demo hooks
// ---------------------------------------------------------------------------------------------

declare global {
  interface Window {
    atlasWeights?: unknown;
  }
}

if (typeof window !== "undefined") window.atlasWeights = {
  state: () => ({
    addr: S.addr,
    active: S.active,
    bend: S.bend,
    heat: S.heat,
    heatKind: session?.heat?.kind ?? null,
    skinOverlay: !!session?.skinMesh,
    vertices: session?.table.vertexCount ?? 0,
    bones: session?.table.bones ?? [],
    selected: S.select.size,
    dbg,
    variants: session?.variants ?? []
  }),
  setActive: (bone: string) => {
    S.active = bone;
    activeCtx?.renderPanel();
    if (activeCtx) applyPose(activeCtx);
    activeCtx?.redraw();
  },
  setBend: (deg: number) => {
    S.bend = deg;
    activeCtx?.renderPanel();
    if (activeCtx) applyPose(activeCtx);
    activeCtx?.redraw();
  },
  setHeat: (mode: "off" | HeatMode) => {
    S.heat = mode;
    activeCtx?.renderPanel();
    if (activeCtx) applyPose(activeCtx);
    activeCtx?.redraw();
  },
  selectAll: () => {
    if (session && activeCtx) {
      S.select = selectAll(session.skin.positions);
      refreshRows(activeCtx);
    }
  },
  /** Client (page) pixels of a skeleton-space point. */
  client: (x: number, y: number) => activeCtx?.host.toClient(x, y) ?? null,
  /** Rest-pose world position of a bone's pivot. */
  bone: (name: string) => {
    const b = activeCtx ? scratchFor(activeCtx)?.findBone(name) : undefined;
    return b ? [b.world.x, b.world.y] : null;
  },
  /** Largest weight jump of the active bone across one mesh edge (a crease shows as a big number). */
  roughness: (cx?: number, cy?: number, r = 1e9) => {
    const s = session;
    const col = s ? s.table.bones.indexOf(S.active ?? "") : -1;
    if (!s || col < 0) return null;
    const B = s.table.bones.length;
    let worst = 0;
    let sum = 0;
    let n = 0;
    const near = (v: number) => cx === undefined || cy === undefined || Math.hypot((s.rest[v * 2] as number) - cx, (s.rest[v * 2 + 1] as number) - cy) <= r;
    s.neighbours.forEach((set, a) => set.forEach((b) => near(a) && near(b) && a < b && ((n++, (sum += ((s.table.data[a * B + col] as number) - (s.table.data[b * B + col] as number)) ** 2)), (worst = Math.max(worst, Math.abs((s.table.data[a * B + col] as number) - (s.table.data[b * B + col] as number)))))));
    return { max: worst, rms: n ? Math.sqrt(sum / n) : 0, edges: n };
  },
  setBrush: (o: { mode?: BrushMode; radiusPx?: number; strength?: number; tool?: "paint" | "select" }) => {
    Object.assign(S, o);
    activeCtx?.renderPanel();
  },
  /** World position of vertex `v` at the current bend (skeleton space). */
  vertex: (v: number) => (session ? [session.skin.positions[v * 2], session.skin.positions[v * 2 + 1]] : null),
  /** Vertices nearest to a point (skeleton space), for aiming the brush in demos. */
  nearest: (x: number, y: number) => (session ? pickVertex(session.skin.positions, x, y, 1e9) : -1),
  weights: (v: number) => {
    const s = session;
    if (!s) return null;
    const B = s.table.bones.length;
    return Object.fromEntries(s.table.bones.map((n, b) => [n, Number((s.table.data[v * B + b] as number).toFixed(4))]).filter(([, w]) => (w as number) > 0));
  },
  /**
   * Times `n` brush dabs on the loaded mesh without saving: brushDab + re-skin + heat colours + buffer uploads (and a redraw when
   * `render` is true). Returns the per-dab milliseconds.
   */
  bench: (n = 200, render = false) => {
    const ctx = activeCtx;
    const s = session;
    if (!ctx || !s) return null;
    const col = activeColumn(ctx);
    if (col < 0) return null;
    const backup = new Float32Array(s.table.data);
    const opts = { ...brushOptions(ctx), strength: 0.2 };
    const pts = s.skin.positions;
    const xs: number[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < s.table.vertexCount; v++) {
      minX = Math.min(minX, pts[v * 2] as number);
      maxX = Math.max(maxX, pts[v * 2] as number);
      minY = Math.min(minY, pts[v * 2 + 1] as number);
      maxY = Math.max(maxY, pts[v * 2 + 1] as number);
    }
    opts.radius = Math.max(maxX - minX, maxY - minY) * 0.12;
    const target = { points: new Float32Array(pts), neighbours: s.neighbours };
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const f = i / n;
      const changed = brushDab(s.table, target, col, minX + (maxX - minX) * f, minY + (maxY - minY) * (0.5 + 0.4 * Math.sin(f * 12)), opts, 1, null);
      applyPose(ctx, changed);
      if (render) ctx.redraw();
      xs.push(performance.now() - t0);
    }
    s.table.data.set(backup);
    applyPose(ctx);
    xs.sort((a, b) => a - b);
    return { vertices: s.table.vertexCount, bones: s.table.bones.length, dabs: n, meanMs: xs.reduce((a, b) => a + b, 0) / n, p95Ms: xs[Math.floor(n * 0.95)], maxMs: xs[n - 1] };
  }
};
