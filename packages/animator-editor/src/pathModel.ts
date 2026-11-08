/*
 * Atlas Animator editor: path attachments and path constraints (Batch 12b; pure, no DOM).
 *
 * A path is a bezier spline stored as 3 vertices per control point (handle in, point, handle out), x, y pairs in the slot bone's space.
 * Plans are command batches (`attachment.add`, `attachment.set`, `constraint.add`, `constraint.set`) run with runBatch.
 */
import { boneNames, fail, isObj, listOf, r4, slotNames, uniqueName, type Command, type JsonObject } from "./setupModel.js";

export interface PathRef {
  skin: string;
  slot: string;
  name: string;
}

export interface PathPoint {
  inX: number;
  inY: number;
  x: number;
  y: number;
  outX: number;
  outY: number;
}

export const PATH_POSITION_MODES = ["fixed", "percent"] as const;
export const PATH_SPACING_MODES = ["length", "fixed", "percent", "proportional"] as const;
export const PATH_ROTATE_MODES = ["tangent", "chain", "chainScale"] as const;

export const PATH_MODE_LABEL: Record<string, string> = {
  fixed: "Fixed (distance)",
  percent: "Percent (share of the path)",
  length: "Length (bone lengths)",
  proportional: "Proportional",
  tangent: "Tangent",
  chain: "Chain",
  chainScale: "Chain scale"
};

function attsOf(raw: JsonObject, skin: string, slot: string): JsonObject {
  const skins = isObj(raw["skins"]) ? raw["skins"] : {};
  const s = isObj(skins[skin]) ? skins[skin] : {};
  const all = isObj(s["attachments"]) ? s["attachments"] : {};
  return isObj(all[slot]) ? all[slot] : {};
}

function pathAtt(raw: JsonObject, a: PathRef): JsonObject {
  const att = attsOf(raw, a.skin, a.slot)[a.name];
  if (!isObj(att)) return fail(`no attachment '${a.name}' on slot '${a.slot}'`);
  if (att["type"] !== "path") return fail(`'${a.name}' is a ${String(att["type"])}, not a path`);
  if (Array.isArray(att["bones"])) return fail("a weighted path is edited in the rig file; the editor moves unweighted paths");
  return att;
}

/** The control points of an unweighted path attachment. */
export function pathPoints(att: JsonObject): PathPoint[] {
  const v = Array.isArray(att["vertices"]) ? (att["vertices"] as number[]) : [];
  const out: PathPoint[] = [];
  for (let i = 0; i + 5 < v.length; i += 6) out.push({ inX: v[i] as number, inY: v[i + 1] as number, x: v[i + 2] as number, y: v[i + 3] as number, outX: v[i + 4] as number, outY: v[i + 5] as number });
  return out;
}

const flat = (pts: readonly PathPoint[]): number[] => pts.flatMap((p) => [p.inX, p.inY, p.x, p.y, p.outX, p.outY]).map(r4);

/** The default path: three points along the slot bone's length with a gentle arch and level handles. */
export function defaultPathPoints(raw: JsonObject, slot: string): PathPoint[] {
  const s = listOf(raw["slots"]).find((x) => x["name"] === slot);
  const b = s ? listOf(raw["bones"]).find((x) => x["name"] === s["bone"]) : undefined;
  const len = Math.max(60, Number(b?.["length"] ?? 0));
  const h = len / 6;
  return [
    { inX: -h, inY: 0, x: 0, y: 0, outX: h, outY: 0 },
    { inX: len / 2 - h, inY: -len / 5, x: len / 2, y: -len / 5, outX: len / 2 + h, outY: -len / 5 },
    { inX: len - h, inY: 0, x: len, y: 0, outX: len + h, outY: 0 }
  ];
}

export interface PathPlan {
  commands: Command[];
  attachment: string;
  slot: string;
}

/** A path lives in a slot of its own on the same bone (the slot's shown attachment is the path), placed just after the slot it was added from. */
export function planAddPath(raw: JsonObject, o: { skin: string; slot: string; name?: string }): PathPlan {
  if (!slotNames(raw).includes(o.slot)) fail(`no slot '${o.slot}'`);
  const src = listOf(raw["slots"]).find((x) => x["name"] === o.slot)!;
  const slot = uniqueName(slotNames(raw), `${o.slot}_path`);
  const name = o.name ?? "path";
  const vertices = flat(defaultPathPoints(raw, o.slot));
  return {
    commands: [
      { op: "slot.add", name: slot, bone: String(src["bone"]), attachment: name, drawAfter: o.slot },
      { op: "attachment.add", skin: o.skin, slot, name, attachment: { type: "path", closed: false, constantSpeed: true, vertexCount: vertices.length / 2, vertices } }
    ],
    attachment: name,
    slot
  };
}

function setVertices(a: PathRef, pts: readonly PathPoint[]): Command[] {
  const vertices = flat(pts);
  return [{ op: "attachment.set", ...a, fields: { vertices, vertexCount: vertices.length / 2 } }];
}

/** Moves one vertex (index = 3 * point + 0 handle in / 1 point / 2 handle out). Moving a point carries both its handles. */
export function planMovePathVertex(raw: JsonObject, a: PathRef, vertex: number, x: number, y: number): Command[] {
  const pts = pathPoints(pathAtt(raw, a));
  const i = Math.floor(vertex / 3);
  const part = vertex % 3;
  const p = pts[i];
  if (!p || vertex < 0) return fail(`no path vertex ${vertex}`);
  if (part === 1) {
    const dx = x - p.x;
    const dy = y - p.y;
    pts[i] = { inX: p.inX + dx, inY: p.inY + dy, x, y, outX: p.outX + dx, outY: p.outY + dy };
  } else if (part === 0) pts[i] = { ...p, inX: x, inY: y };
  else pts[i] = { ...p, outX: x, outY: y };
  return setVertices(a, pts);
}

/** Adds a control point after point `index`, splitting that curve in its middle (the shape stays). */
export function planInsertPathPoint(raw: JsonObject, a: PathRef, index: number): Command[] {
  const att = pathAtt(raw, a);
  const pts = pathPoints(att);
  const n = pts.length;
  if (n >= 256) return fail("a path may have at most 256 points");
  const closed = att["closed"] === true;
  const i = Math.max(0, Math.min(n - 1, index));
  if (!closed && i >= n - 1) return fail("an open path has no curve after its last point; pick an earlier point");
  const j = (i + 1) % n;
  const p0 = pts[i]!;
  const p3 = pts[j]!;
  const mid = (ax: number, ay: number, bx: number, by: number) => [(ax + bx) / 2, (ay + by) / 2] as const;
  const [abx, aby] = mid(p0.x, p0.y, p0.outX, p0.outY);
  const [bcx, bcy] = mid(p0.outX, p0.outY, p3.inX, p3.inY);
  const [cdx, cdy] = mid(p3.inX, p3.inY, p3.x, p3.y);
  const [dx, dy] = mid(abx, aby, bcx, bcy);
  const [ex, ey] = mid(bcx, bcy, cdx, cdy);
  const [mx, my] = mid(dx, dy, ex, ey);
  pts[i] = { ...p0, outX: abx, outY: aby };
  pts[j] = { ...p3, inX: cdx, inY: cdy };
  const fresh: PathPoint = { inX: dx, inY: dy, x: mx, y: my, outX: ex, outY: ey };
  pts.splice(j === 0 ? n : i + 1, 0, fresh);
  return setVertices(a, pts);
}

export function planRemovePathPoint(raw: JsonObject, a: PathRef, index: number): Command[] {
  const att = pathAtt(raw, a);
  const pts = pathPoints(att);
  const min = att["closed"] === true ? 3 : 2;
  if (pts.length <= min) return fail(`a ${att["closed"] === true ? "closed" : "open"} path needs at least ${min} points`);
  if (index < 0 || index >= pts.length) return fail(`no path point ${index}`);
  pts.splice(index, 1);
  return setVertices(a, pts);
}

/** Closed and constant-speed switches. */
export function planSetPathFlags(raw: JsonObject, a: PathRef, f: { closed?: boolean; constantSpeed?: boolean }): Command[] {
  const att = pathAtt(raw, a);
  if (f.closed === true && pathPoints(att).length < 3) return fail("a closed path needs at least 3 points: add a point first");
  const fields: Record<string, unknown> = {};
  if (f.closed !== undefined) fields["closed"] = f.closed;
  if (f.constantSpeed !== undefined) fields["constantSpeed"] = f.constantSpeed;
  return [{ op: "attachment.set", ...a, fields }];
}

// ---------------------------------------------------------------------------------------------
// Path constraints
// ---------------------------------------------------------------------------------------------

export interface PathConstraintView {
  name: string;
  bones: string[];
  target: string;
  positionMode: string;
  spacingMode: string;
  rotateMode: string;
  offsetRotation: number;
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
}

export function pathConstraints(raw: JsonObject): PathConstraintView[] {
  return listOf(raw["path"]).map((c) => ({
    name: String(c["name"]),
    bones: [...((c["bones"] as string[] | undefined) ?? [])],
    target: String(c["target"]),
    positionMode: String(c["positionMode"] ?? "percent"),
    spacingMode: String(c["spacingMode"] ?? "length"),
    rotateMode: String(c["rotateMode"] ?? "tangent"),
    offsetRotation: Number(c["offsetRotation"] ?? 0),
    position: Number(c["position"] ?? 0),
    spacing: Number(c["spacing"] ?? 0),
    mixRotate: Number(c["mixRotate"] ?? 1),
    mixX: Number(c["mixX"] ?? 1),
    mixY: Number(c["mixY"] ?? 1)
  }));
}

/** Slots that have a path attachment in any skin (the targets a path constraint can use). */
export function pathSlots(raw: JsonObject): string[] {
  const out: string[] = [];
  const skins = Object.keys(isObj(raw["skins"]) ? raw["skins"] : {});
  for (const s of listOf(raw["slots"])) {
    const name = String(s["name"]);
    if (skins.some((skin) => Object.values(attsOf(raw, skin, name)).some((x) => isObj(x) && x["type"] === "path"))) out.push(name);
  }
  return out;
}

const KNOWN_FIELDS = ["offsetRotation", "position", "spacing", "mixRotate", "mixX", "mixY", "positionMode", "spacingMode", "rotateMode", "target", "bones", "order", "skin"];

export function planPathConstraintSet(raw: JsonObject, name: string, fields: Record<string, unknown>): Command[] {
  if (!listOf(raw["path"]).some((c) => c["name"] === name)) return fail(`no path constraint '${name}'`);
  for (const [k, v] of Object.entries(fields)) {
    if (!KNOWN_FIELDS.includes(k)) fail(`unknown path constraint field '${k}'`);
    if (typeof v === "number" && !Number.isFinite(v)) fail(`${k} must be a number`);
    if (k.startsWith("mix") && typeof v === "number" && (v < 0 || v > 1)) fail(`${k} is between 0 and 1`);
    if (k === "positionMode" && !(PATH_POSITION_MODES as readonly unknown[]).includes(v)) fail(`unknown position mode '${String(v)}'`);
    if (k === "spacingMode" && !(PATH_SPACING_MODES as readonly unknown[]).includes(v)) fail(`unknown spacing mode '${String(v)}'`);
    if (k === "rotateMode" && !(PATH_ROTATE_MODES as readonly unknown[]).includes(v)) fail(`unknown rotate mode '${String(v)}'`);
    if (k === "target" && !slotNames(raw).includes(String(v))) fail(`no slot '${String(v)}'`);
    if (k === "bones") {
      const list = Array.isArray(v) ? (v as string[]) : [];
      if (!list.length) fail("a path constraint needs at least one bone");
      for (const b of list) if (!boneNames(raw).includes(b)) fail(`no bone '${b}'`);
    }
  }
  return [{ op: "constraint.set", kind: "path", name, fields }];
}

/** Adds a path constraint driving `bones` along the first path slot (or `target`). Mixes start at 1, Percent position 0, Length spacing 0. */
export function planAddPathConstraint(raw: JsonObject, o: { bones: readonly string[]; target?: string; name?: string }): { commands: Command[]; constraint: string } {
  const have = boneNames(raw);
  if (!o.bones.length) fail("select a bone first");
  for (const b of o.bones) if (!have.includes(b)) fail(`no bone '${b}'`);
  const targets = pathSlots(raw);
  const target = o.target ?? targets[0] ?? fail("add a path to a slot first (slot page, + Path), then add the constraint");
  if (!targets.includes(target)) fail(`slot '${target}' has no path`);
  const taken = [...listOf(raw["ik"]), ...listOf(raw["transform"]), ...listOf(raw["path"]), ...listOf(raw["physics"])].map((c) => String(c["name"]));
  const constraint = uniqueName(taken, o.name ?? `${o.bones[0]}_path`);
  return { commands: [{ op: "constraint.add", kind: "path", constraint: { name: constraint, bones: [...o.bones], target, positionMode: "percent", spacingMode: "length", rotateMode: "tangent", position: 0, spacing: 0, mixRotate: 1, mixX: 1, mixY: 1 } }], constraint };
}

/** Channels of the path timeline the Animate tab keys. */
export const PATH_CHANNELS = [
  { key: "position", label: "Position", tip: "Position along the path (a distance, or 0 to 1 in Percent mode)", step: "0.05" },
  { key: "spacing", label: "Spacing", tip: "Gap between the bones along the path", step: "1" },
  { key: "mixRotate", label: "Mix rotate", tip: "How much the bones turn to follow the path, 0 to 1", step: "0.05" },
  { key: "mixX", label: "Mix X", tip: "How much the bones are pulled to the path along x, 0 to 1", step: "0.05" },
  { key: "mixY", label: "Mix Y", tip: "How much the bones are pulled to the path along y, 0 to 1", step: "0.05" }
] as const;
export type PathChannel = (typeof PATH_CHANNELS)[number]["key"];

/**
 * The bones a path constraint on `target` (a path slot) may still add to its chain `listed`: the engine refuses the bone the path's
 * slot rides on and every bone above it (they would move the curve they follow), and a bone below a listed bone needs its parent listed.
 */
export function addablePathBones(raw: JsonObject, target: string, listed: readonly string[]): string[] {
  const parentOf = new Map<string, string | undefined>();
  const order: string[] = [];
  for (const b of listOf(raw["bones"])) {
    const name = String(b["name"]);
    order.push(name);
    parentOf.set(name, typeof b["parent"] === "string" ? b["parent"] : undefined);
  }
  const slot = listOf(raw["slots"]).find((s) => s["name"] === target);
  const blocked = new Set<string>();
  for (let b = typeof slot?.["bone"] === "string" ? slot["bone"] : undefined; b !== undefined && !blocked.has(b); b = parentOf.get(b)) blocked.add(b);
  const isBelow = (bone: string, anc: string): boolean => {
    for (let b = parentOf.get(bone), n = 0; b !== undefined && n < 500; b = parentOf.get(b), n++) if (b === anc) return true;
    return false;
  };
  return order.filter((name) => {
    if (listed.includes(name) || blocked.has(name)) return false;
    if (!listed.some((l) => isBelow(name, l))) return true;
    const parent = parentOf.get(name);
    return parent !== undefined && listed.includes(parent);
  });
}
