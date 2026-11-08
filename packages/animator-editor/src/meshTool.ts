/*
 * Mesh tool for Setup mode (MESH-WEIGHTS-PLAN section 1, chunk M2). Registered as the Setup sub-tool "mesh".
 *
 * The tool never edits geometry itself: it opens the selected slot's attachment as a MeshModel (meshModel.ts), applies one model
 * operation per gesture, and turns the result into `mesh.edit` / `mesh.generate` / `attachment.set-uvs` commands that go through
 * `ctx.run`, so every committed operation is one undo step and saves with the rig like any other Setup edit. Between gestures the model
 * is re-read from the rig document, so the canvas always shows what the file holds.
 */
import type { Bone, Skeleton } from "@atlas-animator/core/core";
import { loadPackedAtlas, type RgbaImage } from "@atlas-animator/core/pixi";
import { outlineImage } from "@atlas-animator/core/tools/outline";
import type { Graphics } from "pixi.js";
import {
  addEdge, addVertex, compatibleVariants, deleteEdge, deleteVertices, findEdge, gridMeshForCount, insertHullVertex, keepRectangle, meshMinAngle, modelFromMesh, MeshModelError, moveVertices, opaqueCoverage,
  planMeshCommit, redrawHull, resetUvs, traceMesh, transformVertices, validateMesh, MAX_TRACE_VERTICES, MIN_TRACE_VERTICES, type MeshAddress, type MeshModel, type Point, type VariantTarget
} from "./meshModel.js";
import { registerSetupSubTool, type SetupToolContext } from "./setupMode.js";
import type { Command, JsonObject, JsonValue } from "./setupModel.js";
import { createUvView, type UvView } from "./uvView.js";
import { adjacency, clickSelect, growSelection, lassoSelect, pickVertex, selectAll, shrinkSelection, snapPoint, verticesInBox, applyHits } from "./vertexSelect.js";

type Mode = "points" | "lines" | "outline" | "hull";
type Pivot = "selection" | "picture" | "bone";
type Snap = { vertex: boolean; hull: boolean; outline: boolean; grid: boolean };
interface ToolPoint { x: number; y: number; sx: number; sy: number }
type Mods = { shiftKey: boolean; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean };

interface Target {
  address: MeshAddress;
  att: JsonObject;
  type: "mesh" | "region";
  width: number;
  height: number;
  path: string;
  bone: string;
}

type Gesture =
  | { kind: "move"; vertices: number[]; primary: number; start: Point; dx: number; dy: number; uvOnly: boolean; moved: boolean }
  | { kind: "box"; sx: number; sy: number; start: Point; cur: Point; mods: Mods }
  | { kind: "lasso"; sx: number; sy: number; pts: Point[]; mods: Mods }
  | { kind: "edge"; from: number; cur: Point; sx: number; sy: number; mods: Mods };

const isObj = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const objOf = (v: JsonValue | undefined): JsonObject => (isObj(v) ? v : {});
const listOf = (v: JsonValue | undefined): JsonObject[] => (Array.isArray(v) ? (v.filter(isObj) as JsonObject[]) : []);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  node.append(...kids);
  return node;
};

// ---------------------------------------------------------------------------------------------
// Tool state (one Setup session; reset when the slot or rig changes)
// ---------------------------------------------------------------------------------------------

let ctxRef: SetupToolContext | null = null;
let mode: Mode = "points";
const snap: Snap = { vertex: true, hull: true, outline: true, grid: true };
let sameOnVariants = true;
/** What a click does in Points mode: select only, add a point on empty space, or delete the point under the pointer. */
type PointAction = "select" | "add" | "delete";
let pointAction: PointAction = "add";
let density = 60;
let selection: Set<number> = new Set();
let selVersion = 0;
let gesture: Gesture | null = null;
let hover = -1;
let pickedName: string | null = null;
let cachedFor: JsonObject | null = null;
let cachedModel: MeshModel | null = null;
let picture: RgbaImage | null = null;
let pictureKey = "";
let pictureWanted = "";
let outlineLoops: Point[][] | null = null;
let outlineFor: RgbaImage | null = null;
let uv: UvView | null = null;
let uvSig = "";
let validCache: { model: MeshModel; picture: RgbaImage | null; value: Validity } | null = null;
/** Draw hull: the picture-pixel points clicked so far (empty when not drawing). */
let hullClicks: Point[] = [];
let hullCursor: Point | null = null;
let pivotKind: Pivot = "selection";
const xform = { angle: 0, scaleX: 1, scaleY: 1 };
let vertexFields: { x: HTMLInputElement; y: HTMLInputElement; u: HTMLInputElement; v: HTMLInputElement } | null = null;
let selectionCountEl: HTMLElement | null = null;
let validBox: HTMLElement | null = null;
const providers = new Map<string, Promise<{ get(path: string): { pixels: RgbaImage; rect: { x: number; y: number; width: number; height: number } } | undefined }>>();

interface Validity { minAngle: number | null; coverage: number | null; closed: boolean; messages: string[] }

// ---------------------------------------------------------------------------------------------
// Reading the rig
// ---------------------------------------------------------------------------------------------

function skinOf(raw: JsonObject, slot: string, preferred: string): { skin: string; attachments: JsonObject } | null {
  const skins = objOf(raw["skins"]);
  const first = objOf(objOf(skins[preferred])["attachments"])[slot];
  if (isObj(first) && Object.keys(first).length) return { skin: preferred, attachments: first };
  for (const [name, data] of Object.entries(skins)) {
    const found = objOf(objOf(data)["attachments"])[slot];
    if (isObj(found) && Object.keys(found).length) return { skin: name, attachments: found };
  }
  return null;
}

function target(ctx: SetupToolContext): Target | null {
  const rig = ctx.host.rig();
  const slot = ctx.slot();
  if (!rig || !slot) return null;
  const found = skinOf(rig.raw, slot, rig.skin);
  if (!found) return null;
  const slotRow = listOf(rig.raw["slots"]).find((s) => s["name"] === slot);
  const usable = Object.entries(found.attachments).filter(([, a]) => isObj(a) && (a["type"] === "mesh" || a["type"] === "region"));
  if (!usable.length) return null;
  const setupName = typeof slotRow?.["attachment"] === "string" ? slotRow["attachment"] : null;
  const name = [pickedName, setupName].find((n) => n && usable.some(([k]) => k === n)) ?? (usable.find(([, a]) => (a as JsonObject)["type"] === "mesh") ?? usable[0]!)[0];
  const att = found.attachments[name] as JsonObject;
  return {
    address: { skin: found.skin, slot, name },
    att,
    type: att["type"] === "mesh" ? "mesh" : "region",
    width: Number(att["width"] ?? 0),
    height: Number(att["height"] ?? 0),
    path: String(att["path"] ?? name),
    bone: String(slotRow?.["bone"] ?? "root")
  };
}

/** The sibling meshes (crease variants, other skins) of the target slot that could take the same edit. */
function variantTargets(ctx: SetupToolContext, t: Target): VariantTarget[] {
  const rig = ctx.host.rig();
  if (!rig) return [];
  const out: VariantTarget[] = [];
  for (const [skin, data] of Object.entries(objOf(rig.raw["skins"]))) {
    for (const [name, a] of Object.entries(objOf(objOf(objOf(objOf(data)["attachments"])[t.address.slot])))) {
      if (!isObj(a) || a["type"] !== "mesh" || (skin === t.address.skin && name === t.address.name)) continue;
      out.push({ skin, slot: t.address.slot, name, vertexCount: Array.isArray(a["uvs"]) ? a["uvs"].length / 2 : 0, width: Number(a["width"] ?? 0), height: Number(a["height"] ?? 0) });
    }
  }
  return out;
}

function modelOf(t: Target): MeshModel | null {
  if (t.type !== "mesh") return null;
  if (cachedFor === t.att && cachedModel) return cachedModel;
  try {
    cachedModel = modelFromMesh({
      uvs: t.att["uvs"] as number[],
      triangles: t.att["triangles"] as number[],
      hull: Number(t.att["hull"] ?? 0),
      width: t.width,
      height: t.height,
      edges: Array.isArray(t.att["edges"]) ? (t.att["edges"] as number[]) : undefined
    });
    cachedFor = t.att;
  } catch {
    cachedModel = null;
  }
  return cachedModel;
}

/** World (skeleton space) position of every vertex at the setup pose. */
function worldOf(sk: Skeleton, t: Target, model: MeshModel): Point[] {
  const out: Point[] = [];
  const vertices = t.att["vertices"] as number[];
  const count = model.points.length / 2;
  const tmp = { x: 0, y: 0 };
  const table = Array.isArray(t.att["bones"]) ? (t.att["bones"] as string[]).map((n) => sk.findBone(n)) : null;
  if (!table) {
    const bone = sk.findBone(t.bone);
    for (let v = 0; v < count; v++) {
      if (!bone) { out.push({ x: model.points[2 * v] as number, y: model.points[2 * v + 1] as number }); continue; }
      bone.localToWorld(vertices[2 * v] as number, vertices[2 * v + 1] as number, tmp);
      out.push({ x: tmp.x, y: tmp.y });
    }
    return out;
  }
  let i = 0;
  for (let v = 0; v < count; v++) {
    const n = vertices[i++] as number;
    let x = 0;
    let y = 0;
    for (let k = 0; k < n; k++) {
      const b = table[vertices[i] as number] as Bone | undefined;
      const lx = vertices[i + 1] as number;
      const ly = vertices[i + 2] as number;
      const w = vertices[i + 3] as number;
      i += 4;
      if (!b) continue;
      b.localToWorld(lx, ly, tmp);
      x += tmp.x * w;
      y += tmp.y * w;
    }
    out.push({ x, y });
  }
  return out;
}

/** Least-squares affine map between image pixels and world, the same fit `mesh.edit` uses to place new vertices. */
interface Affine { a: number; b: number; c: number; d: number; tx: number; ty: number; scale: number }
function fitAffine(px: readonly number[], world: readonly Point[]): Affine {
  const n = world.length;
  let mu = 0, mv = 0, mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mu += px[2 * i]!; mv += px[2 * i + 1]!; mx += world[i]!.x; my += world[i]!.y; }
  mu /= n; mv /= n; mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, sxu = 0, sxv = 0, syu = 0, syv = 0;
  for (let i = 0; i < n; i++) {
    const du = px[2 * i]! - mu, dv = px[2 * i + 1]! - mv, dx = world[i]!.x - mx, dy = world[i]!.y - my;
    suu += du * du; suv += du * dv; svv += dv * dv; sxu += dx * du; sxv += dx * dv; syu += dy * du; syv += dy * dv;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-9)) return { a: 1, b: 0, c: 0, d: 1, tx: mx - mu, ty: my - mv, scale: 1 };
  const a = (sxu * svv - sxv * suv) / det, b = (sxv * suu - sxu * suv) / det;
  const c = (syu * svv - syv * suv) / det, d = (syv * suu - syu * suv) / det;
  return { a, b, c, d, tx: mx - (a * mu + b * mv), ty: my - (c * mu + d * mv), scale: Math.sqrt(Math.abs(a * d - b * c)) || 1 };
}
const toWorld = (m: Affine, x: number, y: number): Point => ({ x: m.a * x + m.b * y + m.tx, y: m.c * x + m.d * y + m.ty });
function toPixels(m: Affine, x: number, y: number): Point {
  const det = m.a * m.d - m.b * m.c || 1;
  const wx = x - m.tx, wy = y - m.ty;
  return { x: (m.d * wx - m.b * wy) / det, y: (-m.c * wx + m.a * wy) / det };
}
const deltaToPixels = (m: Affine, dx: number, dy: number): Point => {
  const det = m.a * m.d - m.b * m.c || 1;
  return { x: (m.d * dx - m.b * dy) / det, y: (-m.c * dx + m.a * dy) / det };
};

// ---------------------------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------------------------

function resample(src: RgbaImage, width: number, height: number): RgbaImage {
  if (src.width === width && src.height === height) return src;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) / height) * src.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) / width) * src.width));
      data.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Loads the target's picture from the rig's atlas (once per path); the tool redraws when it arrives. */
function ensurePicture(ctx: SetupToolContext, t: Target): void {
  const rig = ctx.host.rig();
  if (!rig) return;
  const key = `${rig.atlas}|${t.path}|${t.width}x${t.height}`;
  if (key === pictureKey || key === pictureWanted) return;
  pictureWanted = key;
  let provider = providers.get(rig.atlas);
  if (!provider) {
    provider = loadPackedAtlas(`/repo/${rig.atlas}`) as never;
    providers.set(rig.atlas, provider as never);
  }
  void Promise.resolve(provider).then((p) => {
    const src = p.get(t.path);
    if (pictureWanted !== key) return;
    pictureKey = key;
    if (!src) { picture = null; outlineLoops = null; ctx.renderPanel(); ctx.redraw(); return; }
    const { pixels, rect } = src;
    const data = new Uint8Array(rect.width * rect.height * 4);
    for (let y = 0; y < rect.height; y++) data.set(pixels.data.subarray(((rect.y + y) * pixels.width + rect.x) * 4, ((rect.y + y) * pixels.width + rect.x + rect.width) * 4), y * rect.width * 4);
    picture = resample({ width: rect.width, height: rect.height, data }, t.width, t.height);
    outlineLoops = null;
    validCache = null;
    ctx.renderPanel();
    ctx.redraw();
  }).catch(() => { picture = null; });
}

function pictureOutline(): Point[][] {
  if (!picture) return [];
  if (outlineFor === picture && outlineLoops) return outlineLoops;
  outlineFor = picture;
  try {
    const o = outlineImage(picture);
    outlineLoops = [o.outer, ...o.holes];
  } catch {
    outlineLoops = [];
  }
  return outlineLoops;
}

// ---------------------------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------------------------

const status = (text: string, kind: "" | "bad" | "ok" = "") => ctxRef?.host.status(text, kind);

async function commitModel(ctx: SetupToolContext, label: string, model: MeshModel, select?: number[]): Promise<boolean> {
  const t = target(ctx);
  if (!t) return false;
  let commands: Command[];
  try {
    commands = planMeshCommit(model, t.address, { baseSize: { width: t.width, height: t.height }, variants: sameOnVariants ? variantTargets(ctx, t) : [] }) as unknown as Command[];
  } catch (e) {
    status(msg(e), "bad");
    return false;
  }
  const extra = sameOnVariants ? variantTargets(ctx, t).length : 0;
  return commitCommands(ctx, extra ? `${label} (+${extra} variant${extra === 1 ? "" : "s"})` : label, commands, select);
}

async function commitCommands(ctx: SetupToolContext, label: string, commands: Command[], select?: number[]): Promise<boolean> {
  cachedFor = null;
  validCache = null;
  const ok = await ctx.run(label, () => ({ commands }));
  if (ok) {
    selection = new Set(select ?? []);
    selVersion++;
    ctx.renderPanel();
    ctx.redraw();
  }
  return ok;
}

/** Runs a model operation, reporting a refusal in the status line instead of throwing. */
async function operate(ctx: SetupToolContext, label: string, make: (model: MeshModel) => { model: MeshModel; select?: number[] }): Promise<void> {
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  if (!t || !model) return;
  try {
    const next = make(model);
    await commitModel(ctx, label, next.model, next.select);
  } catch (e) {
    status(e instanceof MeshModelError ? `Can't do that: ${msg(e)}` : msg(e), "bad");
  }
}

async function convert(ctx: SetupToolContext, how: "trace" | "grid" | "rect"): Promise<void> {
  const t = target(ctx);
  if (!t) return;
  const wasMesh = t.type === "mesh";
  const model = modelOf(t);
  const base = model?.baseCount ?? 0;
  try {
    if (how === "trace" && !picture) throw new MeshModelError("the picture isn't loaded, so it can't be traced");
    if (wasMesh && model) {
      let next: MeshModel;
      if (how === "trace") next = traceMesh(picture!, density, base);
      else if (how === "rect") next = keepRectangle(t.width, t.height, base);
      else {
        const hull: Point[] = Array.from({ length: model.hull }, (_, i) => ({ x: model.points[2 * i]!, y: model.points[2 * i + 1]! }));
        next = gridMeshForCount(hull, density, base);
      }
      await commitModel(ctx, how === "trace" ? "Trace picture" : how === "grid" ? "Fill grid" : "Keep rectangle", next);
      return;
    }
    const address = t.address;
    const command: Record<string, unknown> = { op: "mesh.generate", ...address };
    if (how === "trace") {
      const o = outlineImage(picture!);
      const clamp = (p: Point): [number, number] => [Math.min(t.width, Math.max(0, p.x)), Math.min(t.height, Math.max(0, p.y))];
      command["outline"] = { outer: o.outer.map(clamp), holes: o.holes.map((h) => h.map(clamp)) };
      command["targetVertices"] = Math.round(density);
    } else if (how === "grid") command["spacing"] = Math.max(2, Math.sqrt((t.width * t.height) / density));
    else command["targetVertices"] = 4;
    await commitCommands(ctx, how === "trace" ? "Trace picture to mesh" : how === "grid" ? "Fill grid mesh" : "Region to rectangle mesh", [command as unknown as Command]);
  } catch (e) {
    status(e instanceof MeshModelError ? `Can't do that: ${msg(e)}` : `Convert failed: ${msg(e)}`, "bad");
  }
}

async function commitUvMove(ctx: SetupToolContext, vertices: number[], dx: number, dy: number): Promise<void> {
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  if (!t || !model || !vertices.length) return;
  const uvs = (t.att["uvs"] as number[]).slice();
  const move = new Set(vertices);
  for (const v of move) {
    uvs[2 * v] = Math.min(1, Math.max(0, Number((((model.points[2 * v]! + dx) / t.width)).toFixed(6))));
    uvs[2 * v + 1] = Math.min(1, Math.max(0, Number((((model.points[2 * v + 1]! + dy) / t.height)).toFixed(6))));
  }
  await commitCommands(ctx, "Move UVs", [{ op: "attachment.set-uvs", ...t.address, uvs } as unknown as Command], [...selection]);
}

// ---------------------------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------------------------

interface View { t: Target; model: MeshModel; world: Point[]; map: Affine; px: number }
function view(ctx: SetupToolContext): View | null {
  const t = target(ctx);
  const sk = ctx.host.skeleton();
  const model = t ? modelOf(t) : null;
  if (!t || !sk || !model) return null;
  const world = worldOf(sk, t, model);
  return { t, model, world, map: fitAffine(model.points, world), px: 1 / ctx.host.zoom() };
}

const flat = (pts: readonly Point[]): number[] => pts.flatMap((p) => [p.x, p.y]);

function snapped(v: View, imgX: number, imgY: number, ctrl: boolean, ignore?: ReadonlySet<number>): { x: number; y: number } {
  const radius = (8 * v.px) / v.map.scale;
  const hullOn = snap.hull;
  const ignored = snap.vertex ? ignore : new Set(Array.from({ length: v.model.points.length / 2 }, (_, i) => i));
  const r = snapPoint(imgX, imgY, {
    points: v.model.points,
    hull: hullOn ? v.model.hull : 0,
    ...(snap.outline ? { outline: pictureOutline() } : {}),
    radius,
    grid: snap.grid ? 1 : 0,
    ctrl,
    ...(ignored ? { ignore: ignored } : {})
  });
  return { x: r.x, y: r.y };
}

function setSelection(next: Set<number>): void {
  selection = next;
  selVersion++;
  refreshReadouts();
  refreshVertexFields();
  ctxRef?.redraw();
}

function pointerDown(p: ToolPoint, e: Mods, ctx: SetupToolContext): boolean {
  ctxRef = ctx;
  const v = view(ctx);
  if (!v) return true;
  if (mode === "hull") {
    hullClick(ctx, v, p, !!(e.ctrlKey || e.metaKey));
    return true;
  }
  const mods = { shift: e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey) };
  const reach = 9 * v.px;
  let hit = pickVertex(flat(v.world), p.x, p.y, reach);
  if (mode === "outline" && hit >= v.model.hull) hit = -1;
  if (hit >= 0) {
    if (mode === "points" && pointAction === "delete" && !mods.shift && !mods.ctrl) {
      const doomed = selection.has(hit) && selection.size > 1 ? [...selection] : [hit];
      void operate(ctx, doomed.length > 1 ? "Delete mesh points" : "Delete mesh point", (m) => ({ model: deleteVertices(m, doomed) }));
      return true;
    }
    if (mods.shift) {
      gesture = { kind: "edge", from: hit, cur: p, sx: p.sx, sy: p.sy, mods: e };
      return true;
    }
    if (mods.ctrl) {
      setSelection(clickSelect(selection, hit, mods));
      return true;
    }
    if (!selection.has(hit)) setSelection(new Set([hit]));
    gesture = { kind: "move", vertices: [...selection], primary: hit, start: p, dx: 0, dy: 0, uvOnly: e.altKey, moved: false };
    return true;
  }
  gesture = e.altKey ? { kind: "lasso", sx: p.sx, sy: p.sy, pts: [p], mods: e } : { kind: "box", sx: p.sx, sy: p.sy, start: p, cur: p, mods: e };
  return true;
}

function pointerMove(p: ToolPoint, ctx: SetupToolContext): boolean {
  ctxRef = ctx;
  const v = view(ctx);
  if (mode === "hull" && hullClicks.length) {
    hullCursor = { x: p.x, y: p.y };
    ctx.redraw();
    return false;
  }
  if (!gesture) {
    if (!v) return false;
    const h = pickVertex(flat(v.world), p.x, p.y, 9 * v.px);
    if (h !== hover) {
      hover = h;
      ctx.redraw();
    }
    return false;
  }
  if (gesture.kind === "move") {
    gesture.dx = p.x - gesture.start.x;
    gesture.dy = p.y - gesture.start.y;
    if (Math.hypot(gesture.dx, gesture.dy) / (v?.px ?? 1) >= 3) gesture.moved = true;
  } else if (gesture.kind === "box") gesture.cur = p;
  else if (gesture.kind === "lasso") gesture.pts.push(p);
  else gesture.cur = p;
  ctx.redraw();
  return true;
}

function pointerUp(ctx: SetupToolContext): boolean {
  ctxRef = ctx;
  const g = gesture;
  gesture = null;
  if (!g) return false;
  const v = view(ctx);
  if (!v) return true;
  const world = flat(v.world);
  if (g.kind === "move") {
    if (!g.moved) {
      // A click on a vertex that was already part of a bigger selection narrows to it.
      if (selection.size > 1) setSelection(new Set([g.primary]));
      return true;
    }
    const d = deltaToPixels(v.map, g.dx, g.dy);
    if (g.uvOnly) {
      void commitUvMove(ctx, g.vertices, d.x, d.y);
      return true;
    }
    const orig = { x: v.model.points[2 * g.primary]!, y: v.model.points[2 * g.primary + 1]! };
    const target = snapped(v, orig.x + d.x, orig.y + d.y, false, new Set(g.vertices));
    void operate(ctx, g.vertices.length > 1 ? "Move mesh points" : "Move mesh point", (m) => ({ model: moveVertices(m, g.vertices, target.x - orig.x, target.y - orig.y), select: g.vertices }));
    return true;
  }
  if (g.kind === "edge") {
    const to = pickVertex(world, g.cur.x, g.cur.y, 9 * v.px);
    if (to >= 0 && to !== g.from) void operate(ctx, "Add mesh edge", (m) => ({ model: addEdge(m, g.from, to), select: [g.from, to] }));
    else if (Math.hypot(...p2(g.cur, g, v)) < 4) setSelection(clickSelect(selection, g.from, { shift: true }));
    return true;
  }
  const mods = { shift: g.mods.shiftKey, ctrl: !!(g.mods.ctrlKey || g.mods.metaKey) };
  if (g.kind === "lasso") {
    if (g.pts.length > 3) setSelection(lassoSelect(selection, world, g.pts, mods));
    return true;
  }
  const cur = g.cur;
  const screenMoved = Math.hypot((cur.x - g.start.x) / v.px, (cur.y - g.start.y) / v.px);
  if (screenMoved >= 4) {
    setSelection(applyHits(selection, verticesInBox(world, { x0: g.start.x, y0: g.start.y, x1: cur.x, y1: cur.y }), mods));
    return true;
  }
  emptyClick(ctx, v, g.start, mods);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Draw hull, numeric vertex fields, rotate / scale, Reset UVs (Batch 7b, )
// ---------------------------------------------------------------------------------------------

/** One click while drawing the hull: a click on the first point (or Close hull / Enter) closes it, any other click adds a point. */
function hullClick(ctx: SetupToolContext, v: View, p: ToolPoint, ctrl: boolean): void {
  const first = hullClicks[0];
  if (first && hullClicks.length >= 3) {
    const w = toWorld(v.map, first.x, first.y);
    if (Math.hypot(p.x - w.x, p.y - w.y) <= 10 * v.px) {
      void closeHull(ctx);
      return;
    }
  }
  const img = toPixels(v.map, p.x, p.y);
  const s = snapped(v, img.x, img.y, ctrl);
  hullClicks.push({ x: Number(s.x.toFixed(3)), y: Number(s.y.toFixed(3)) });
  hullCursor = null;
  ctx.renderPanel();
  ctx.redraw();
}

async function closeHull(ctx: SetupToolContext): Promise<void> {
  const clicks = hullClicks.slice();
  if (clicks.length < 3) {
    status("Draw at least 3 points, then close the hull", "bad");
    return;
  }
  hullClicks = [];
  hullCursor = null;
  await operate(ctx, `Draw hull (${clicks.length} points)`, (m) => ({ model: redrawHull(m, clicks) }));
  ctx.renderPanel();
  ctx.redraw();
}

function cancelHull(ctx: SetupToolContext): void {
  hullClicks = [];
  hullCursor = null;
  ctx.renderPanel();
  ctx.redraw();
}

/**
 * Reset UVs: every point (or the selected ones) goes back to the picture position its geometry sits at. The expected mapping is the best
 * fit between the other points' UVs and where they are in the view, so a UV-only move (Alt-drag, typed U / V) is undone while the shape stays.
 * With nothing selected only points more than 0.75 px off the fit are touched.
 */
async function resetAllUvs(ctx: SetupToolContext): Promise<void> {
  const v = view(ctx);
  if (!v) {
    status("Convert this image to a mesh first", "bad");
    return;
  }
  const { t, model, world } = v;
  const count = model.points.length / 2;
  const chosen = selection.size ? new Set([...selection].filter((i) => i < count)) : null;
  const fitIds = Array.from({ length: count }, (_, i) => i).filter((i) => !chosen || !chosen.has(i));
  const map = fitAffine(fitIds.flatMap((i) => [model.points[2 * i] as number, model.points[2 * i + 1] as number]), fitIds.map((i) => world[i] as Point));
  const old = t.att["uvs"] as number[];
  const uvs = old.slice();
  let changed = 0;
  for (let i = 0; i < count; i++) {
    const p = toPixels(map, (world[i] as Point).x, (world[i] as Point).y);
    const off = Math.hypot(p.x - (model.points[2 * i] as number), p.y - (model.points[2 * i + 1] as number));
    if (chosen ? !chosen.has(i) || off < 0.01 : off <= 0.75) continue;
    const [u, w] = resetUvs([p.x, p.y], t.width, t.height) as [number, number];
    uvs[2 * i] = u;
    uvs[2 * i + 1] = w;
    changed++;
  }
  if (!changed) {
    status("The UVs already match the picture", "ok");
    return;
  }
  await commitCommands(ctx, "Reset UVs", [{ op: "attachment.set-uvs", ...t.address, uvs } as unknown as Command], [...selection]);
  status(`Reset the UVs of ${changed} point${changed === 1 ? "" : "s"}`, "ok");
}

/** Where the selected vertices sit (image px): the centre of their bounding box, and the first one's UV. */
function selectionStats(model: MeshModel, t: Target): { x: number; y: number; u: number; v: number } | null {
  if (!selection.size) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of selection) {
    if (2 * i + 1 >= model.points.length) continue;
    minX = Math.min(minX, model.points[2 * i] as number);
    maxX = Math.max(maxX, model.points[2 * i] as number);
    minY = Math.min(minY, model.points[2 * i + 1] as number);
    maxY = Math.max(maxY, model.points[2 * i + 1] as number);
  }
  if (!Number.isFinite(minX)) return null;
  const first = Math.min(...selection);
  const uvs = t.att["uvs"] as number[];
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, u: uvs[2 * first] ?? 0, v: uvs[2 * first + 1] ?? 0 };
}

const shown3 = (n: number): string => String(Number(n.toFixed(3)));

function refreshVertexFields(): void {
  const f = vertexFields;
  const ctx = ctxRef;
  if (!f || !ctx) return;
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  const st = t && model ? selectionStats(model, t) : null;
  for (const input of [f.x, f.y, f.u, f.v]) input.disabled = !st;
  if (!st) {
    for (const input of [f.x, f.y, f.u, f.v]) input.value = "";
    return;
  }
  if (document.activeElement !== f.x) f.x.value = shown3(st.x);
  if (document.activeElement !== f.y) f.y.value = shown3(st.y);
  if (document.activeElement !== f.u) f.u.value = shown3(st.u);
  if (document.activeElement !== f.v) f.v.value = shown3(st.v);
}

/** Types a position for the selection: one point goes there; a group keeps its shape and its centre goes there. */
async function setSelectionPosition(ctx: SetupToolContext, axis: "x" | "y", value: number): Promise<void> {
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  const st = t && model ? selectionStats(model, t) : null;
  if (!t || !model || !st || !Number.isFinite(value)) return;
  const d = axis === "x" ? value - st.x : value - st.y;
  if (Math.abs(d) < 1e-9) return;
  const ids = [...selection];
  await operate(ctx, ids.length > 1 ? "Move mesh points (typed)" : "Move mesh point (typed)", (m) => ({ model: moveVertices(m, ids, axis === "x" ? d : 0, axis === "y" ? d : 0), select: ids }));
}

async function setSelectionUv(ctx: SetupToolContext, axis: "u" | "v", value: number): Promise<void> {
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  const st = t && model ? selectionStats(model, t) : null;
  if (!t || !model || !st || !Number.isFinite(value)) return;
  const d = Math.min(1, Math.max(0, value)) - (axis === "u" ? st.u : st.v);
  if (Math.abs(d) < 1e-9) return;
  const uvs = (t.att["uvs"] as number[]).slice();
  for (const i of selection) {
    const k = 2 * i + (axis === "u" ? 0 : 1);
    uvs[k] = Math.min(1, Math.max(0, Number(((uvs[k] as number) + d).toFixed(6))));
  }
  await commitCommands(ctx, "Move UVs (typed)", [{ op: "attachment.set-uvs", ...t.address, uvs } as unknown as Command], [...selection]);
}

/** The pivot (image px) of the rotate / scale tool. */
function pivotPoint(ctx: SetupToolContext, t: Target, model: MeshModel): Point | null {
  if (pivotKind === "picture") return { x: t.width / 2, y: t.height / 2 };
  if (pivotKind === "bone") {
    const v = view(ctx);
    const b = ctx.host.skeleton()?.findBone(t.bone);
    return v && b ? toPixels(v.map, b.world.x, b.world.y) : null;
  }
  const st = selectionStats(model, t);
  return st ? { x: st.x, y: st.y } : null;
}

async function applyTransform(ctx: SetupToolContext): Promise<void> {
  const t = target(ctx);
  const model = t ? modelOf(t) : null;
  if (!t || !model) return;
  if (!selection.size) {
    status("Select the points to rotate or scale first", "bad");
    return;
  }
  const pivot = pivotPoint(ctx, t, model);
  if (!pivot) {
    status("No pivot to turn around", "bad");
    return;
  }
  const ids = [...selection];
  await operate(ctx, `Rotate / scale ${ids.length} point${ids.length === 1 ? "" : "s"}`, (m) => ({ model: transformVertices(m, ids, pivot, xform), select: ids }));
}

/** Distance (screen px) the edge gesture ended from the vertex it began at; keeps the shift-click path honest. */
function p2(cur: Point, g: { from: number }, v: View): [number, number] {
  const w = v.world[g.from]!;
  return [(cur.x - w.x) / v.px, (cur.y - w.y) / v.px];
}

function emptyClick(ctx: SetupToolContext, v: View, at: Point, mods: { shift: boolean; ctrl: boolean }): void {
  const img = toPixels(v.map, at.x, at.y);
  const tol = (6 * v.px) / v.map.scale;
  if (mode === "points") {
    if (pointAction !== "add" || img.x < 0 || img.y < 0 || img.x > v.t.width || img.y > v.t.height) {
      setSelection(clickSelect(selection, -1, mods));
      return;
    }
    const s = snapped(v, img.x, img.y, mods.ctrl);
    void operate(ctx, "Add mesh point", (m) => {
      const r = addVertex(m, s.x, s.y, tol);
      return { model: r.model, select: [r.index] };
    });
    return;
  }
  const hit = findEdge(v.model, img.x, img.y, tol);
  if (mode === "lines") {
    if (hit?.kind === "user") void operate(ctx, "Delete mesh edge", (m) => ({ model: deleteEdge(m, hit.a, hit.b) }));
    else setSelection(clickSelect(selection, -1, mods));
    return;
  }
  if (hit?.kind === "hull") {
    const edge = hit.b === (hit.a + 1) % v.model.hull ? hit.a : hit.b;
    const s = snapped(v, hit.x, hit.y, mods.ctrl);
    void operate(ctx, "Add outline point", (m) => {
      const r = insertHullVertex(m, edge, s.x, s.y);
      return { model: r.model, select: [r.index] };
    });
  } else setSelection(clickSelect(selection, -1, mods));
}

async function deleteSelected(ctx: SetupToolContext): Promise<void> {
  if (!selection.size) {
    status("Select vertices first, then press Delete", "");
    return;
  }
  const doomed = [...selection];
  await operate(ctx, doomed.length > 1 ? "Delete mesh points" : "Delete mesh point", (m) => ({ model: deleteVertices(m, doomed) }));
}

// Setup's own Delete handler deletes the selected bone before a sub-tool sees the key, so the tool takes Delete / Ctrl+A first.
const captureKeys = (e: KeyboardEvent): void => {
  const ctx = ctxRef;
  if (!ctx) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === "delete" || k === "backspace") {
    e.preventDefault();
    e.stopImmediatePropagation();
    void deleteSelected(ctx);
  } else if ((e.ctrlKey || e.metaKey) && k === "a") {
    const v = view(ctx);
    if (!v) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setSelection(selectAll(v.model.points));
  }
};

function onKey(e: KeyboardEvent, ctx: SetupToolContext): boolean {
  ctxRef = ctx;
  const k = e.key;
  if (mode === "hull" && hullClicks.length && (k === "Enter" || k === "Escape")) {
    if (k === "Enter") void closeHull(ctx);
    else cancelHull(ctx);
    return true;
  }
  if (k === "Escape") {
    gesture = null;
    if (selection.size) setSelection(new Set());
    return true;
  }
  const v = view(ctx);
  if (!v) return false;
  if ((k === "1" || k === "2" || k === "3") && !e.ctrlKey && !e.metaKey && !e.altKey && mode === "points") {
    pointAction = k === "1" ? "select" : k === "2" ? "add" : "delete";
    ctx.renderPanel();
    return true;
  }
  if (k === "]" || k === "[") {
    const nb = adjacency(v.model.points.length / 2, v.model.triangles, v.model.edges);
    setSelection(k === "]" ? growSelection(selection, nb) : shrinkSelection(selection, nb));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------------------------

const C = { tri: 0x8c96a8, hull: 0xffb347, edge: 0x5fb3ff, dot: 0xe8ecf4, sel: 0xf0b84a, ink: 0x1d1505, rubber: 0x6bd68f };

function drawOverlay(g: Graphics, px: number, ctx: SetupToolContext): void {
  ctxRef = ctx;
  const v = view(ctx);
  if (!v) return;
  ensurePicture(ctx, v.t);
  const shown = v.world.map((w, i) => {
    if (gesture?.kind === "move" && !gesture.uvOnly && gesture.moved && gesture.vertices.includes(i)) return { x: w.x + gesture.dx, y: w.y + gesture.dy };
    return w;
  });
  const { model } = v;
  for (let t = 0; t + 2 < model.triangles.length; t += 3) {
    const a = shown[model.triangles[t]!]!, b = shown[model.triangles[t + 1]!]!, c = shown[model.triangles[t + 2]!]!;
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).lineTo(c.x, c.y).lineTo(a.x, a.y);
  }
  g.stroke({ width: px, color: C.tri, alpha: 0.5 });
  for (const [a, b] of model.edges) g.moveTo(shown[a]!.x, shown[a]!.y).lineTo(shown[b]!.x, shown[b]!.y);
  g.stroke({ width: 2 * px, color: C.edge, alpha: 0.95 });
  for (let i = 0; i < model.hull; i++) {
    const a = shown[i]!, b = shown[(i + 1) % model.hull]!;
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  g.stroke({ width: 2.25 * px, color: C.hull, alpha: 0.95 });
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i]!;
    const isSel = selection.has(i);
    const base = i < model.hull ? C.hull : C.dot;
    if (isSel) {
      g.circle(p.x, p.y, 6.5 * px).fill({ color: C.ink, alpha: 0.9 });
      g.circle(p.x, p.y, 5 * px).fill({ color: C.sel });
    } else {
      g.circle(p.x, p.y, 3.8 * px).fill({ color: C.ink, alpha: 0.85 });
      g.circle(p.x, p.y, 2.7 * px).fill({ color: base });
    }
    if (i === hover && !isSel) g.circle(p.x, p.y, 7 * px).stroke({ width: 1.25 * px, color: C.sel, alpha: 0.9 });
  }
  if (mode === "hull" && hullClicks.length) {
    const pts = hullClicks.map((q) => toWorld(v.map, q.x, q.y));
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
    if (hullCursor) g.lineTo(hullCursor.x, hullCursor.y);
    g.stroke({ width: 2 * px, color: C.rubber, alpha: 0.95 });
    pts.forEach((q, i) => {
      g.circle(q.x, q.y, (i === 0 ? 6 : 4) * px).fill({ color: C.ink, alpha: 0.9 });
      g.circle(q.x, q.y, (i === 0 ? 4.5 : 2.8) * px).fill({ color: i === 0 ? C.sel : C.rubber });
    });
  }
  if (selection.size > 1 || (selection.size && pivotKind !== "selection")) {
    const pv = pivotPoint(ctx, v.t, v.model);
    if (pv) {
      const w = toWorld(v.map, pv.x, pv.y);
      g.moveTo(w.x - 7 * px, w.y).lineTo(w.x + 7 * px, w.y).moveTo(w.x, w.y - 7 * px).lineTo(w.x, w.y + 7 * px).stroke({ width: 1.5 * px, color: C.sel, alpha: 0.9 });
      g.circle(w.x, w.y, 4 * px).stroke({ width: 1.25 * px, color: C.sel, alpha: 0.9 });
    }
  }
  if (gesture?.kind === "box") {
    const a = gesture.start, b = gesture.cur;
    g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)).fill({ color: C.sel, alpha: 0.1 }).stroke({ width: px, color: C.sel, alpha: 0.9 });
  } else if (gesture?.kind === "lasso" && gesture.pts.length > 1) {
    g.moveTo(gesture.pts[0]!.x, gesture.pts[0]!.y);
    for (const q of gesture.pts.slice(1)) g.lineTo(q.x, q.y);
    g.closePath().fill({ color: C.sel, alpha: 0.08 }).stroke({ width: px, color: C.sel, alpha: 0.9 });
  } else if (gesture?.kind === "edge") {
    const a = shown[gesture.from]!;
    g.moveTo(a.x, a.y).lineTo(gesture.cur.x, gesture.cur.y).stroke({ width: 2 * px, color: C.rubber, alpha: 0.95 });
    const to = pickVertex(flat(shown), gesture.cur.x, gesture.cur.y, 9 * px);
    if (to >= 0 && to !== gesture.from) g.circle(shown[to]!.x, shown[to]!.y, 8 * px).stroke({ width: 1.5 * px, color: C.rubber });
  }
  syncUv(ctx, v);
}

function syncUv(ctx: SetupToolContext, v: View): void {
  if (!uv) return;
  const sig = `${v.t.address.skin}/${v.t.address.slot}/${v.t.address.name}|${v.model.points.join(",")}|${v.model.triangles.length}|${selVersion}|${picture ? 1 : 0}|${pictureKey}`;
  if (sig === uvSig) return;
  uvSig = sig;
  uv.update({ picture, width: v.t.width, height: v.t.height, points: v.model.points, triangles: v.model.triangles, hull: v.model.hull, edges: v.model.edges, selection });
  void ctx;
}

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

function validity(t: Target, model: MeshModel): Validity {
  if (validCache && validCache.model === model && validCache.picture === picture) return validCache.value;
  const issues = validateMesh(model, picture ? { picture } : {});
  const value: Validity = {
    minAngle: model.triangles.length ? meshMinAngle(model.points, model.triangles) : null,
    coverage: picture ? opaqueCoverage(model, picture) : null,
    closed: !issues.some((i) => i.kind === "hull"),
    messages: issues.map((i) => i.message)
  };
  validCache = { model, picture, value };
  void t;
  return value;
}

function refreshReadouts(): void {
  if (selectionCountEl) selectionCountEl.textContent = selection.size ? `${selection.size} selected` : "nothing selected";
}

function chip(text: string, kind: "ok" | "warn" | "bad" | "info", id?: string): HTMLElement {
  return el("span", { className: `chip-${kind}`, textContent: text, id });
}

function toggle(label: string, on: boolean, title: string, onClick: () => void, id: string): HTMLButtonElement {
  const b = el("button", { className: `btn sm${on ? " on" : ""}`, textContent: label, title, id, type: "button" });
  b.setAttribute("aria-pressed", String(on));
  b.addEventListener("click", onClick);
  return b;
}

function panel(box: HTMLElement, ctx: SetupToolContext): void {
  ctxRef = ctx;
  box.id = "mesh-panel";
  box.classList.add("mesh-panel");
  const t = target(ctx);
  syncHint(ctx, t);
  box.append(el("h2", {}, "Mesh ", el("span", { className: "mesh-slot", textContent: t ? `${t.address.slot}` : "no slot" })));
  if (!t) {
    box.append(el("div", { className: "note", textContent: "Pick a slot with an image in the slot list (or click one in the view), then edit its mesh here." }));
    return;
  }
  ensurePicture(ctx, t);
  const model = modelOf(t);

  // Attachment picker when the slot has more than one mesh or region
  const rig = ctx.host.rig()!;
  const found = skinOf(rig.raw, t.address.slot, rig.skin);
  const names = found ? Object.entries(found.attachments).filter(([, a]) => isObj(a) && (a["type"] === "mesh" || a["type"] === "region")).map(([n]) => n) : [];
  if (names.length > 1) {
    const sel = el("select", { id: "mesh-attachment", title: "The image of this slot whose mesh you are editing" });
    for (const n of names) sel.append(el("option", { value: n, textContent: n, selected: n === t.address.name }));
    sel.addEventListener("change", () => {
      pickedName = sel.value;
      selection = new Set();
      selVersion++;
      cachedFor = null;
      pictureKey = "";
      ctx.renderPanel();
      ctx.redraw();
    });
    box.append(el("div", { className: "mesh-row" }, el("span", { className: "mesh-label", textContent: "Image" }), sel));
  }
  box.append(
    el("div", { className: "mesh-sub" },
      chip(t.type === "mesh" ? `Mesh, ${model ? model.points.length / 2 : "?"} points` : "Region (no mesh yet)", t.type === "mesh" ? "info" : "warn", "mesh-kind"),
      el("span", { className: "mesh-dim", textContent: `${t.width} x ${t.height} px` }))
  );

  // --- Convert
  const slider = el("input", { type: "range", min: String(MIN_TRACE_VERTICES), max: String(MAX_TRACE_VERTICES), step: "1", value: String(density), id: "mesh-density", title: "How many points the new mesh gets" });
  const count = el("span", { className: "mesh-val", id: "mesh-density-val", textContent: String(density) });
  slider.addEventListener("input", () => {
    density = Number(slider.value);
    count.textContent = String(density);
  });
  const trace = el("button", { className: "btn-primary mesh-big", textContent: "Trace picture", id: "mesh-trace", type: "button", title: "Outline the picture's opaque pixels and fill it with a fresh mesh of about this many points" });
  trace.disabled = !picture;
  trace.addEventListener("click", () => void convert(ctx, "trace"));
  const grid = el("button", { className: "btn", textContent: "Fill grid", id: "mesh-grid", type: "button", title: "Keep the outline and fill the inside with an even grid of points" });
  grid.addEventListener("click", () => void convert(ctx, "grid"));
  const rect = el("button", { className: "btn", textContent: "Keep rectangle", id: "mesh-rect", type: "button", title: "Four corners of the picture and two triangles" });
  rect.addEventListener("click", () => void convert(ctx, "rect"));
  box.append(
    el("div", { className: "mesh-group" },
      el("div", { className: "mesh-cap", textContent: "Convert" }),
      el("div", { className: "mesh-row" }, el("span", { className: "mesh-label", textContent: "Density" }), slider, count),
      trace,
      el("div", { className: "mesh-row mesh-two" }, grid, rect),
      el("div", { className: "mesh-dim", textContent: picture ? "Replaces the mesh; weights and deform keys carry over." : "Loading the picture..." }))
  );

  // --- Mode
  const modes: [Mode, string, string][] = [["points", "Points", "Click to add a point, drag to move, Alt-drag moves the UV only, Delete removes"], ["lines", "Lines", "Shift-drag from point to point adds an edge; click an edge to delete it"], ["outline", "Outline", "Click the outline to add an outline point; drag outline points; Delete removes one"], ["hull", "Draw hull", "Click points around the picture to draw a new outline, then click the first point (or press Enter) to close it; points inside it stay"]];
  const seg = el("div", { className: "seg", id: "mesh-modes" });
  for (const [id, label, tip] of modes) {
    const b = el("button", { textContent: label, title: tip, type: "button" });
    b.id = `mesh-mode-${id}`;
    b.classList.toggle("on", mode === id);
    b.addEventListener("click", () => {
      if (id !== "hull") hullClicks = [];
      mode = id;
      ctx.renderPanel();
      ctx.redraw();
    });
    seg.append(b);
  }
  const actions: [PointAction, string, string, string][] = [["select", "Select", "1", "Click or drag a box to select points; clicking empty space adds nothing"], ["add", "Add", "2", "Click empty space to add a point"], ["delete", "Delete", "3", "Click a point to delete it (a selected group goes together)"]];
  const actSeg = el("div", { className: "seg", id: "mesh-actions" });
  for (const [id, label, key, tip] of actions) {
    const b = el("button", { textContent: label, title: `${tip} (${key})`, type: "button" });
    b.id = `mesh-action-${id}`;
    b.classList.toggle("on", pointAction === id);
    b.disabled = mode !== "points";
    b.addEventListener("click", () => { pointAction = id; ctx.renderPanel(); });
    actSeg.append(b);
  }
  const pointCount = model ? model.points.length / 2 : 0;
  box.append(el("div", { className: "mesh-group" },
    el("div", { className: "mesh-cap" }, "Mode ", el("span", { className: "mesh-val", id: "mesh-count", textContent: t.type === "mesh" ? `${pointCount} points` : "no mesh" })),
    seg,
    ...(mode === "points" ? [actSeg] : []),
    ...(mode === "hull" ? [hullBar(ctx)] : []),
    el("div", { className: "mesh-dim", textContent: mode === "points" ? actions.find((a) => a[0] === pointAction)![3] : modes.find((m) => m[0] === mode)![2] })));

  // --- Snapping + variants
  const snaps = el("div", { className: "mesh-chips" });
  for (const [key, label, tip] of [["vertex", "Points", "Snap to existing points"], ["hull", "Outline", "Snap onto the mesh outline"], ["outline", "Picture", "Snap onto the picture's edge"], ["grid", "1 px", "Snap to whole pixels"]] as const) {
    snaps.append(toggle(label, snap[key], `${tip} (hold Ctrl to suspend all snapping)`, () => {
      snap[key] = !snap[key];
      ctx.renderPanel();
    }, `mesh-snap-${key}`));
  }
  const variants = t.type === "mesh" && model ? compatibleVariants(model.baseCount, variantTargets(ctx, t)) : [];
  const same = el("input", { type: "checkbox", checked: sameOnVariants, id: "mesh-variants" });
  same.addEventListener("change", () => { sameOnVariants = same.checked; });
  box.append(
    el("div", { className: "mesh-group" },
      el("div", { className: "mesh-cap", textContent: "Snapping" }),
      snaps,
      el("label", { className: "mesh-check", title: "Repeat each edit on the sibling images (crease variants) that have the same number of points" }, same, ` Same edit on variants${variants.length ? ` (${variants.length} match)` : " (none match)"}`))
  );

  // --- Selection + validation
  selectionCountEl = el("span", { className: "mesh-val", id: "mesh-selected" });
  const del = el("button", { className: "btn-danger sm", textContent: "Delete", id: "mesh-delete", type: "button", title: "Delete the selected points (Delete)" });
  del.addEventListener("click", () => void deleteSelected(ctx));
  const all = el("button", { className: "btn sm", textContent: "All", id: "mesh-all", type: "button", title: "Select every point (Ctrl+A)" });
  all.addEventListener("click", () => model && setSelection(selectAll(model.points)));
  const grow = el("button", { className: "btn sm", textContent: "Grow", id: "mesh-grow", type: "button", title: "Grow the selection along edges (])" });
  const shrink = el("button", { className: "btn sm", textContent: "Shrink", id: "mesh-shrink", type: "button", title: "Shrink the selection ([)" });
  grow.addEventListener("click", () => model && setSelection(growSelection(selection, adjacency(model.points.length / 2, model.triangles, model.edges))));
  shrink.addEventListener("click", () => model && setSelection(shrinkSelection(selection, adjacency(model.points.length / 2, model.triangles, model.edges))));
  box.append(el("div", { className: "mesh-group" }, el("div", { className: "mesh-cap" }, "Selection ", selectionCountEl), el("div", { className: "mesh-chips" }, all, grow, shrink, del)));
  refreshReadouts();
  if (model) box.append(vertexGroup(ctx));

  validBox =el("div", { className: "mesh-valid", id: "mesh-valid" });
  if (model) {
    const v = validity(t, model);
    const angle = v.minAngle === null ? chip("no triangles", "bad") : chip(`${v.minAngle.toFixed(1)} deg`, v.minAngle >= 15 ? "ok" : "warn", "mesh-v-angle");
    const cover = v.coverage === null ? chip("unknown", "info", "mesh-v-cover") : chip(`${(v.coverage * 100).toFixed(1)}%`, v.coverage >= 0.98 ? "ok" : "warn", "mesh-v-cover");
    const closed = chip(v.closed ? "closed" : "broken", v.closed ? "ok" : "bad", "mesh-v-hull");
    validBox.append(
      el("div", { className: "mesh-row mesh-between" }, el("span", { className: "mesh-label", textContent: "Min angle" }), angle),
      el("div", { className: "mesh-row mesh-between" }, el("span", { className: "mesh-label", textContent: "Coverage" }), cover),
      el("div", { className: "mesh-row mesh-between" }, el("span", { className: "mesh-label", textContent: "Outline" }), closed)
    );
    for (const m of v.messages) validBox.append(el("div", { className: "mesh-warn", textContent: m }));
  } else validBox.append(el("div", { className: "mesh-dim", textContent: "Convert this image to a mesh to check it." }));
  box.append(el("div", { className: "mesh-group" }, el("div", { className: "mesh-cap", textContent: "Check" }), validBox));
  if (uv) box.append(el("div", { className: "mesh-group" }, el("div", { className: "mesh-cap", textContent: "UV view" }), uv.el));
}

/** The Draw hull controls: how many points are down, Close hull, Cancel. */
function hullBar(ctx: SetupToolContext): HTMLElement {
  const n = hullClicks.length;
  const close = el("button", { className: "btn-primary sm", textContent: "Close hull", id: "mesh-hull-close", type: "button", title: "Close the outline you are drawing and rebuild the mesh inside it (Enter, or click the first point)" });
  close.disabled = n < 3;
  close.addEventListener("click", () => void closeHull(ctx));
  const cancel = el("button", { className: "btn sm", textContent: "Cancel", id: "mesh-hull-cancel", type: "button", title: "Throw away the points you have drawn (Esc)" });
  cancel.disabled = n === 0;
  cancel.addEventListener("click", () => cancelHull(ctx));
  return el("div", { className: "mesh-row mesh-between", id: "mesh-hull-bar" }, el("span", { className: "mesh-val", id: "mesh-hull-count", textContent: n ? `${n} point${n === 1 ? "" : "s"} drawn` : "click to place the first point" }), close, cancel);
}

const numField = (id: string, title: string, value: string, step: string, onChange: (v: number) => void): HTMLInputElement => {
  const i = el("input", { type: "number", className: "field num", id, title, step, value });
  i.addEventListener("change", () => {
    if (i.value.trim() !== "") onChange(Number(i.value));
  });
  return i;
};
const labelled = (text: string, input: HTMLElement, title: string): HTMLElement => el("label", { className: "mesh-lab", title }, el("span", { textContent: text }), input);

/** Typed X / Y / U / V for the selection, Rotate / scale around a pivot, and Reset UVs. */
function vertexGroup(ctx: SetupToolContext): HTMLElement {
  const x = numField("mesh-vx", "X of the selected point in picture pixels (a group moves together: its centre goes here)", "", "0.5", (n) => void setSelectionPosition(ctx, "x", n));
  const y = numField("mesh-vy", "Y of the selected point in picture pixels (a group moves together: its centre goes here)", "", "0.5", (n) => void setSelectionPosition(ctx, "y", n));
  const u = numField("mesh-vu", "U of the selected point: where on the picture it samples, 0 to 1 across", "", "0.01", (n) => void setSelectionUv(ctx, "u", n));
  const v = numField("mesh-vv", "V of the selected point: where on the picture it samples, 0 to 1 down", "", "0.01", (n) => void setSelectionUv(ctx, "v", n));
  vertexFields = { x, y, u, v };
  refreshVertexFields();
  const reset = el("button", { className: "btn", textContent: "Reset UVs", id: "mesh-reset-uvs", type: "button", title: "Reset UVs: put every point's UV back on its own place in the picture (undoes UV-only moves)" });
  reset.addEventListener("click", () => void resetAllUvs(ctx));
  const angle = numField("mesh-rot", "Rotate the selected points by this many degrees around the pivot", String(xform.angle), "1", (n) => { xform.angle = n; });
  const sx = numField("mesh-sx", "Scale the selected points across (1 = unchanged, 1.1 = 10% wider, negative flips)", String(xform.scaleX), "0.05", (n) => { xform.scaleX = n; });
  const sy = numField("mesh-sy", "Scale the selected points down (1 = unchanged)", String(xform.scaleY), "0.05", (n) => { xform.scaleY = n; });
  const pivot = el("select", { className: "field", id: "mesh-pivot", title: "Pivot: the point the rotation and scale turn around (drawn as a cross in the view)" });
  for (const [id, label] of [["selection", "Selection centre"], ["picture", "Picture centre"], ["bone", "Bone origin"]] as const) pivot.append(el("option", { value: id, textContent: label, selected: pivotKind === id }));
  pivot.addEventListener("change", () => {
    pivotKind = pivot.value as Pivot;
    ctx.redraw();
  });
  const go = el("button", { className: "btn", textContent: "Apply rotate / scale", id: "mesh-xform-go", type: "button", title: "Rotate and scale the selected points around the pivot. One undo step" });
  go.addEventListener("click", () => void applyTransform(ctx));
  return el("div", { className: "mesh-group", id: "mesh-vertex" },
    el("div", { className: "mesh-cap", textContent: "Selected point" }),
    el("div", { className: "mesh-row mesh-two" }, labelled("X", x, x.title), labelled("Y", y, y.title)),
    el("div", { className: "mesh-row mesh-two" }, labelled("U", u, u.title), labelled("V", v, v.title)),
    el("div", { className: "mesh-cap", textContent: "Rotate and scale" }),
    el("div", { className: "mesh-row mesh-two" }, labelled("Turn", angle, angle.title), labelled("Pivot", pivot, pivot.title)),
    el("div", { className: "mesh-row mesh-two" }, labelled("Scale X", sx, sx.title), labelled("Scale Y", sy, sy.title)),
    el("div", { className: "mesh-chips" }, go, reset));
}

/** A region slot has no mesh yet: say so on the canvas, with Trace picture as the one obvious next step. */
function syncHint(ctx: SetupToolContext, t: ReturnType<typeof target>): void {
  const old = document.getElementById("mesh-hint");
  if (!t || t.type === "mesh") {
    old?.remove();
    return;
  }
  const view = document.getElementById("view");
  if (!view || old) return;
  const go = el("button", { className: "btn-primary", textContent: "Trace picture", type: "button", id: "mesh-hint-trace", title: "Outline the picture's opaque pixels and fill it with a mesh (T)" });
  go.addEventListener("click", () => void convert(ctx, "trace"));
  view.append(el("div", { className: "mesh-hint", id: "mesh-hint" }, el("span", { textContent: "This image has no mesh yet." }), go));
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

registerSetupSubTool({
  id: "mesh",
  label: "Mesh",
  key: "M",
  hint: "Edit the selected slot's mesh: click to add a point, drag to move (Alt-drag moves the UV only), Shift-drag between points for an edge, Delete removes.",
  activate(ctx) {
    ctxRef = ctx;
    gesture = null;
    selection = new Set();
    selVersion++;
    cachedFor = null;
    window.addEventListener("keydown", captureKeys, true);
    if (!uv) {
      // Docked in the Mesh panel (collapsed until asked for), not floating over the character.
      uv = createUvView({
        parent: document.createElement("div"),
        onPick: (hits, mods) => setSelection(applyHits(selection, hits, mods)),
        onMove: (vertices, dx, dy) => { if (ctxRef) void commitUvMove(ctxRef, vertices, dx, dy); }
      });
      uvSig = "";
      uv.setOpen(false);
    }
  },
  deactivate() {
    document.getElementById("mesh-hint")?.remove();
    window.removeEventListener("keydown", captureKeys, true);
    uv?.destroy();
    uv = null;
    uvSig = "";
    gesture = null;
    selectionCountEl = null;
    vertexFields = null;
    hullClicks = [];
    hullCursor = null;
    validBox = null;
  },
  pointerDown,
  pointerMove,
  pointerUp,
  drawOverlay,
  panel,
  onKey
});

declare global {
  interface Window {
    atlasMesh?: unknown;
  }
}

/** Debug / QA hooks: the tool's state and screen positions of picture pixels, so a harness can click real mesh points. */
if (typeof window !== "undefined") {
  window.atlasMesh = {
    state: () => {
      const ctx = ctxRef;
      const t = ctx ? target(ctx) : null;
      const model = t ? modelOf(t) : null;
      return { mode, selection: [...selection], hullClicks: hullClicks.length, points: model ? model.points.length / 2 : 0, hull: model?.hull ?? 0, width: t?.width ?? 0, height: t?.height ?? 0, address: t?.address ?? null };
    },
    /** Client (page) pixels of a picture pixel of the current mesh. */
    client: (x: number, y: number) => {
      const ctx = ctxRef;
      const v = ctx ? view(ctx) : null;
      if (!ctx || !v) return null;
      const w = toWorld(v.map, x, y);
      return ctx.host.toClient(w.x, w.y);
    },
    /** Client pixels of vertex `i`. */
    vertex: (i: number) => {
      const ctx = ctxRef;
      const v = ctx ? view(ctx) : null;
      if (!ctx || !v || !v.world[i]) return null;
      return ctx.host.toClient(v.world[i]!.x, v.world[i]!.y);
    },
    select: (ids: number[]) => setSelection(new Set(ids))
  };
}
