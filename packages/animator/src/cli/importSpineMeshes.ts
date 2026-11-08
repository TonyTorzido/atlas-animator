/*
 * Atlas Animator: original implementation.
 *
 * `animator import-spine <spine.json> --merge <rigdir|rig.anim.json> [--clips a,b] [--dry-run]`
 *
 * The inverse of export-spine for meshes: reads the mesh attachments (weighted or not), linked meshes and deform timelines of a Spine 4.x
 * skeleton JSON and merges the ones whose slot and attachment names match an attachment of the rig. Setup bones, slots, other attachments
 * and every other clip timeline are left alone; a backup of the document is written before it changes.
 *
 * Inverse conversions (see exportSpine.ts): y flipped back (vertex y, weighted influence y, deform y), `edges / 2`, `hull`, `uvs` and
 * `triangles` as they are, and for weighted meshes a per-mesh bone table built from the skeleton bone indices actually used (ascending).
 * Influences keep the order Spine stores them in, so Spine's deform arrays land in this format with no reordering (sparse `offset`
 * kept). A linked mesh's `source` / `parent` / `skin` / `slot` / `timelines: false` become `source` and `inheritDeform: false`.
 * The Spine skin named `default` is the rig's first skin.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAnimDocument } from "../core/formatLoader.js";
import { readCurve, resolveRigDocument } from "./importSpine.js";

type Json = Record<string, unknown>;

export interface SpineMeshImportOptions {
  spine: string;
  /** Rig directory or document to merge into. */
  merge: string;
  /** Spine animations whose deform to import; default all that the rig also has. */
  clips?: string[];
  dryRun?: boolean;
}

export interface SpineMeshImportResult {
  document: string;
  backup: string | null;
  dryRun: boolean;
  meshes: string[];
  linked: string[];
  deform: string[];
  /** Clipping masks, bounding boxes and image sequences read from the file (addresses). */
  extras: string[];
  warnings: string[];
}

const num = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const numbers = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null);

/** Spine skins as [name, slot -> attachment -> data] (4.x array form, or the older object form). */
function spineSkins(spine: Json): [string, Json][] {
  const skins = spine.skins;
  if (Array.isArray(skins)) return skins.filter(isObject).map((s): [string, Json] => [typeof s.name === "string" ? s.name : "default", isObject(s.attachments) ? s.attachments : {}]);
  if (isObject(skins)) return Object.entries(skins).map(([n, a]): [string, Json] => [n, isObject(a) ? a : {}]);
  return [];
}

/** A weighted / unweighted Spine mesh as this format's mesh fields, or why it cannot be read. */
/** Spine weighted vertex stream -> this format's (mesh-local bone table, y flipped); an error text when a bone is unknown. */
export function convertSpineWeighted(raw: readonly number[], boneNames: readonly string[]): { vertices: number[]; bones: string[] } | string {
  const used = new Set<number>();
  for (let i = 0; i < raw.length; ) {
    const n = raw[i++] as number;
    for (let k = 0; k < n; k++, i += 4) used.add(raw[i] as number);
  }
  const table = [...used].sort((a, b) => a - b);
  const names: string[] = [];
  for (const index of table) {
    const name = boneNames[index];
    if (name === undefined) return `bone index ${index} is not in the Spine skeleton`;
    names.push(name);
  }
  const at = new Map(table.map((b, i) => [b, i]));
  const vertices: number[] = [];
  for (let i = 0; i < raw.length; ) {
    const n = raw[i++] as number;
    vertices.push(n);
    for (let k = 0; k < n; k++, i += 4) vertices.push(at.get(raw[i] as number) as number, num(raw[i + 1] as number), num(-(raw[i + 2] as number)), num(raw[i + 3] as number));
  }
  return { vertices, bones: names };
}

export function convertSpineMesh(att: Json, boneNames: readonly string[]): Json | string {
  const uvs = numbers(att.uvs);
  const triangles = numbers(att.triangles);
  const raw = numbers(att.vertices);
  if (!uvs || !triangles || !raw) return "uvs / triangles / vertices missing";
  const hull = typeof att.hull === "number" ? att.hull : 0;
  const out: Json = { uvs: uvs.map(num), triangles, hull };
  if (raw.length === uvs.length) {
    out.vertices = raw.map((v, i) => num(i % 2 === 1 ? -v : v));
  } else {
    const used = new Set<number>();
    for (let i = 0; i < raw.length; ) {
      const n = raw[i++] as number;
      for (let k = 0; k < n; k++, i += 4) used.add(raw[i] as number);
    }
    const table = [...used].sort((a, b) => a - b);
    const names: string[] = [];
    for (const index of table) {
      const name = boneNames[index];
      if (name === undefined) return `bone index ${index} is not in the Spine skeleton`;
      names.push(name);
    }
    const at = new Map(table.map((b, i) => [b, i]));
    const vertices: number[] = [];
    for (let i = 0; i < raw.length; ) {
      const n = raw[i++] as number;
      vertices.push(n);
      for (let k = 0; k < n; k++, i += 4) vertices.push(at.get(raw[i] as number) as number, num(raw[i + 1] as number), num(-(raw[i + 2] as number)), num(raw[i + 3] as number));
    }
    out.vertices = vertices;
    out.bones = names;
  }
  const edges = numbers(att.edges);
  if (edges && edges.length > 0) out.edges = edges.map((e) => e / 2);
  return out;
}

/** Sparse y-flipped deform keys from a Spine deform timeline; null when a key does not fit the mesh. */
export function convertSpineDeform(keys: unknown, length: number, warn: (m: string) => void, where: string): Json[] | null {
  const list = (Array.isArray(keys) ? keys : []).filter(isObject).sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
  const out: Json[] = [];
  for (let k = 0; k < list.length; k++) {
    const key = list[k] as Json;
    const time = num(typeof key.time === "number" ? key.time : 0);
    const vertices = numbers(key.vertices) ?? [];
    const offset = typeof key.offset === "number" ? key.offset : 0;
    if (offset + vertices.length > length) {
      warn(`${where}: key at ${time}s has ${offset + vertices.length} values but the mesh takes ${length}; timeline skipped`);
      return null;
    }
    // y is every odd float of the full array; the offset can start on either.
    const entry: Json = { time, vertices: vertices.map((v, i) => num((offset + i) % 2 === 1 ? -v : v)) };
    if (offset) entry.offset = offset;
    const next = list[k + 1];
    if (next) {
      const t1 = num(typeof next.time === "number" ? next.time : 0);
      const curve = readCurve(key, 0, time, t1, 0, 1, warn, `${where} @${time}`);
      if (curve !== "linear") entry.curve = curve;
    }
    out.push(entry);
  }
  return out;
}

/** Influence layout of a mesh: what a deform array's meaning depends on. */
function layout(mesh: Json): string {
  const v = mesh.vertices as number[];
  const bones = mesh.bones as string[] | undefined;
  if (!bones) return `u${v.length}`;
  const parts: string[] = [];
  for (let i = 0; i < v.length; ) {
    const n = v[i++] as number;
    const row: string[] = [];
    for (let k = 0; k < n; k++, i += 4) row.push(bones[v[i] as number] as string);
    parts.push(row.join(","));
  }
  return parts.join("|");
}

function deformLength(mesh: Json): number {
  const v = mesh.vertices as number[];
  if (!mesh.bones) return v.length;
  let n = 0;
  for (let i = 0; i < v.length; ) {
    const c = v[i++] as number;
    n += c * 2;
    i += c * 4;
  }
  return n;
}

export function importSpineMeshes(options: SpineMeshImportOptions): SpineMeshImportResult {
  const warnings: string[] = [];
  const warn = (m: string): void => void warnings.push(m);
  const documentPath = resolveRigDocument(options.merge);
  const raw = JSON.parse(readFileSync(documentPath, "utf8")) as Json;
  const merged = JSON.parse(JSON.stringify(raw)) as Json;
  const spine = JSON.parse(readFileSync(resolve(options.spine), "utf8")) as Json;
  const version = isObject(spine.skeleton) && typeof spine.skeleton.spine === "string" ? spine.skeleton.spine : "";
  if (version && !/^4\./.test(version)) warn(`Spine version ${version}: only 4.x JSON is read`);
  const boneNames = (Array.isArray(spine.bones) ? spine.bones : []).filter(isObject).map((b) => String(b.name));
  const rigBones = new Set((Array.isArray(merged.bones) ? merged.bones : []).filter(isObject).map((b) => String(b.name)));

  const rigSkins = isObject(merged.skins) ? merged.skins : {};
  const firstSkin = Object.keys(rigSkins)[0];
  const toRigSkin = (name: string): string | undefined => (name === "default" ? firstSkin : name in rigSkins ? name : undefined);
  const rigAttachment = (skin: string, slot: string, name: string): Json | undefined => {
    const s = rigSkins[skin];
    const bySlot = isObject(s) && isObject(s.attachments) ? s.attachments[slot] : undefined;
    const a = isObject(bySlot) ? bySlot[name] : undefined;
    return isObject(a) ? a : undefined;
  };
  const resolveMesh = (a: Json | undefined): Json | undefined => {
    if (a?.type === "linkedMesh" && isObject(a.source)) {
      const s = a.source;
      return resolveMesh(rigAttachment(String(s.skin), String(s.slot), String(s.attachment)));
    }
    return a?.type === "mesh" ? a : undefined;
  };

  // What every mesh looked like before, to find deform keys that would go stale.
  const before = new Map<string, string>();
  for (const [skin, s] of Object.entries(rigSkins)) {
    for (const [slot, byAtt] of Object.entries(isObject(s) && isObject(s.attachments) ? s.attachments : {})) {
      for (const name of Object.keys(isObject(byAtt) ? byAtt : {})) {
        const m = resolveMesh(rigAttachment(skin, slot, name));
        if (m) before.set(`${skin}/${slot}/${name}`, layout(m));
      }
    }
  }

  const meshes: string[] = [];
  const linked: string[] = [];
  const deformDone: string[] = [];

  // ---- meshes and linked meshes ----
  const pending: { skin: string; slot: string; name: string; att: Json }[] = [];
  for (const [spineSkin, bySlot] of spineSkins(spine)) {
    const skin = toRigSkin(spineSkin);
    for (const [slot, byAtt] of Object.entries(bySlot)) {
      if (!isObject(byAtt)) continue;
      for (const [key, att] of Object.entries(byAtt)) {
        if (!isObject(att) || (att.type !== "mesh" && att.type !== "linkedmesh")) continue;
        const name = typeof att.name === "string" ? att.name : key;
        if (skin === undefined) {
          if (firstSkin !== undefined) warn(`${spineSkin}/${slot}/${name}: the rig has no skin '${spineSkin}', skipped`);
          continue;
        }
        if (rigAttachment(skin, slot, name)) pending.push({ skin, slot, name, att });
      }
    }
  }
  for (const { skin, slot, name, att } of pending) {
    const label = `${skin}/${slot}/${name}`;
    const target = rigAttachment(skin, slot, name) as Json;
    if (att.type === "mesh") {
      if (target.type !== "mesh") {
        warn(`${label}: Spine has a mesh but the rig attachment is '${String(target.type)}', skipped`);
        continue;
      }
      const converted = convertSpineMesh(att, boneNames);
      if (typeof converted === "string") {
        warn(`${label}: ${converted}, skipped`);
        continue;
      }
      const missing = ((converted.bones as string[] | undefined) ?? []).filter((b) => !rigBones.has(b));
      if (missing.length > 0) {
        warn(`${label}: weights use bones the rig does not have (${missing.join(", ")}), skipped`);
        continue;
      }
      if ((target.triangles as number[]).length !== (converted.triangles as number[]).length && (target.groups || target.embed)) {
        warn(`${label}: topology changed, draw groups / embedded vertices were dropped`);
        delete target.groups;
        delete target.embed;
      }
      delete target.bones;
      delete target.edges;
      Object.assign(target, converted);
      meshes.push(label);
    } else {
      if (target.type !== "linkedMesh") {
        warn(`${label}: Spine has a linked mesh but the rig attachment is '${String(target.type)}', skipped`);
        continue;
      }
      const srcName = String(att.source ?? att.parent ?? "");
      const srcSkin = typeof att.skin === "string" ? toRigSkin(att.skin) : skin;
      const srcSlot = typeof att.slot === "string" ? att.slot : slot;
      if (!srcName || srcSkin === undefined) {
        warn(`${label}: linked mesh source not understood, skipped`);
        continue;
      }
      if (!resolveMesh(rigAttachment(srcSkin, srcSlot, srcName))) {
        warn(`${label}: linked mesh source ${srcSkin}/${srcSlot}/${srcName} is not a mesh in the rig, skipped`);
        continue;
      }
      target.source = { skin: srcSkin, slot: srcSlot, attachment: srcName };
      target.inheritDeform = att.timelines !== false;
      linked.push(label);
    }
  }

  // ---- clipping masks, bounding boxes and image sequences (Batch 12a) ----
  const extras: string[] = [];
  const rigSlotNames = new Set((Array.isArray(merged.slots) ? merged.slots : []).filter(isObject).map((s) => String(s.name)));
  for (const [spineSkin, bySlot] of spineSkins(spine)) {
    const skin = toRigSkin(spineSkin);
    if (skin === undefined) continue;
    for (const [slot, byAtt] of Object.entries(bySlot)) {
      if (!isObject(byAtt) || !rigSlotNames.has(slot)) continue;
      for (const [key, att] of Object.entries(byAtt)) {
        if (!isObject(att)) continue;
        const name = typeof att.name === "string" ? att.name : key;
        const label = `${skin}/${slot}/${name}`;
        if (att.type === "clipping" || att.type === "boundingbox") {
          const vertices = numbers(att.vertices);
          if (!vertices || vertices.length !== Number(att.vertexCount) * 2 || vertices.length < 6) {
            warn(`${label}: ${String(att.type)} with weighted or missing vertices is not supported, skipped`);
            continue;
          }
          const out: Json = { type: att.type, vertices: vertices.map((v, i) => num(i % 2 === 1 ? -v : v)) };
          if (att.type === "clipping" && typeof att.end === "string") {
            if (rigSlotNames.has(att.end)) out.end = att.end;
            else warn(`${label}: end slot '${att.end}' is not in the rig, the mask runs to the end of the draw order`);
          }
          if (typeof att.color === "string" && /^[0-9a-fA-F]{8}$/.test(att.color)) out.color = att.color;
          const skinObj = (merged.skins as Json)[skin] as Json;
          const slotMap = ((skinObj.attachments as Json)[slot] ??= {}) as Json;
          slotMap[name] = out;
          extras.push(`${att.type} ${label}`);
        } else if ((att.type === "region" || att.type === "mesh" || att.type === "linkedmesh" || att.type === undefined) && isObject(att.sequence)) {
          const target = rigAttachment(skin, slot, name);
          const count = Number(att.sequence.count);
          if (!target || !["region", "mesh", "linkedMesh"].includes(String(target.type)) || !Number.isInteger(count) || count < 1) continue;
          const setup = Math.max(0, Math.min(count - 1, Math.round(Number(att.sequence.setup ?? 0))));
          target.sequence = { count, start: Math.max(0, Math.round(Number(att.sequence.start ?? 1))), digits: Math.max(0, Math.round(Number(att.sequence.digits ?? 0))), setup };
          extras.push(`sequence ${label}`);
        }
      }
    }
  }

  // ---- path attachments and path constraints ----
  for (const [spineSkin, bySlot] of spineSkins(spine)) {
    const skin = toRigSkin(spineSkin);
    if (skin === undefined) continue;
    for (const [slot, byAtt] of Object.entries(bySlot)) {
      if (!isObject(byAtt) || !rigSlotNames.has(slot)) continue;
      for (const [key, att] of Object.entries(byAtt)) {
        if (!isObject(att) || att.type !== "path") continue;
        const name = typeof att.name === "string" ? att.name : key;
        const label = `${skin}/${slot}/${name}`;
        const raw = numbers(att.vertices);
        const count = Number(att.vertexCount);
        if (!raw || !Number.isInteger(count) || count % 3 !== 0 || count < 6) {
          warn(`${label}: path vertices are missing or not whole control points, skipped`);
          continue;
        }
        const out: Json = { type: "path", closed: att.closed === true, constantSpeed: att.constantSpeed !== false, vertexCount: count };
        if (raw.length === count * 2) out.vertices = raw.map((v, i) => num(i % 2 === 1 ? -v : v));
        else {
          const weighted = convertSpineWeighted(raw, boneNames);
          if (typeof weighted === "string") {
            warn(`${label}: ${weighted}, skipped`);
            continue;
          }
          out.vertices = weighted.vertices;
          out.bones = weighted.bones;
        }
        if (typeof att.color === "string" && /^[0-9a-fA-F]{8}$/.test(att.color)) out.color = att.color;
        const skinObj = (merged.skins as Json)[skin] as Json;
        const slotMap = ((skinObj.attachments as Json)[slot] ??= {}) as Json;
        slotMap[name] = out;
        extras.push(`path ${label}`);
      }
    }
  }
  const spineConstraints: Json[] = [
    ...(Array.isArray(spine.constraints) ? spine.constraints.filter(isObject).filter((c) => c.type === "path") : []),
    ...(Array.isArray(spine.path) ? spine.path.filter(isObject) : [])
  ];
  for (const c of spineConstraints) {
    const cname = String(c.name);
    const target = String(c.slot ?? c.target);
    const bonesList = (Array.isArray(c.bones) ? c.bones : []).map(String);
    if (!rigSlotNames.has(target) || bonesList.length === 0 || bonesList.some((b) => !rigBones.has(b))) {
      warn(`path constraint '${cname}': slot '${target}' or its bones are not in the rig, skipped`);
      continue;
    }
    const existing = Array.isArray(merged.path) ? (merged.path as Json[]) : [];
    if (existing.some((p) => p.name === cname)) {
      warn(`path constraint '${cname}' already exists in the rig, kept`);
      continue;
    }
    const rotateMode = String(c.rotateMode ?? "tangent");
    const out: Json = {
      name: cname,
      bones: bonesList,
      target,
      positionMode: c.positionMode === "fixed" ? "fixed" : "percent",
      spacingMode: ["length", "fixed", "percent", "proportional"].includes(String(c.spacingMode)) ? c.spacingMode : "length",
      rotateMode: rotateMode === "chain scale" || rotateMode === "chainScale" ? "chainScale" : rotateMode === "chain" ? "chain" : "tangent"
    };
    if (typeof c.rotation === "number" && c.rotation) out.offsetRotation = num(-c.rotation);
    if (typeof c.position === "number") out.position = num(c.position);
    if (typeof c.spacing === "number") out.spacing = num(c.spacing);
    const mixRotate = typeof c.mixRotate === "number" ? c.mixRotate : 1;
    const mixX = typeof c.mixX === "number" ? c.mixX : 1;
    out.mixRotate = mixRotate;
    out.mixX = mixX;
    out.mixY = typeof c.mixY === "number" ? c.mixY : mixX;
    merged.path = [...existing, out];
    extras.push(`path constraint ${cname}`);
  }

  // ---- deform ----
  const spineAnims = isObject(spine.animations) ? spine.animations : {};
  const rigAnims = isObject(merged.animations) ? merged.animations : {};
  const names = options.clips ?? Object.keys(spineAnims).filter((n) => n in rigAnims);
  for (const n of names) {
    if (!(n in spineAnims)) throw new Error(`no animation '${n}' in ${options.spine}; animations: ${Object.keys(spineAnims).join(", ") || "none"}`);
    if (!(n in rigAnims)) warn(`clip '${n}': the rig has no such clip, its deform was not imported`);
  }
  const replaced = new Set<string>();
  for (const clipName of names) {
    const clip = rigAnims[clipName];
    const anim = spineAnims[clipName];
    if (!isObject(clip) || !isObject(anim)) continue;
    const tree = isObject(anim.attachments) ? anim.attachments : isObject(anim.deform) ? anim.deform : {};
    for (const [spineSkin, bySlot] of Object.entries(tree)) {
      const skin = toRigSkin(spineSkin);
      if (!isObject(bySlot) || skin === undefined) continue;
      for (const [slot, byAtt] of Object.entries(bySlot)) {
        if (!isObject(byAtt)) continue;
        for (const [name, tl] of Object.entries(byAtt)) {
          const keys = isObject(tl) ? tl.deform : tl;
          if (!Array.isArray(keys) || !rigAttachment(skin, slot, name)) continue;
          const label = `clip '${clipName}' ${skin}/${slot}/${name}`;
          const mesh = resolveMesh(rigAttachment(skin, slot, name));
          if (!mesh) {
            warn(`${label}: not a mesh in the rig, skipped`);
            continue;
          }
          const converted = convertSpineDeform(keys, deformLength(mesh), warn, label);
          if (!converted) continue;
          const deform = (isObject(clip.deform) ? clip.deform : (clip.deform = {})) as Json;
          const bySkin = (isObject(deform[skin]) ? deform[skin] : (deform[skin] = {})) as Json;
          const bySl = (isObject(bySkin[slot]) ? bySkin[slot] : (bySkin[slot] = {})) as Json;
          bySl[name] = converted;
          replaced.add(`${clipName}/${skin}/${slot}/${name}`);
          deformDone.push(label);
        }
      }
    }
  }
  // Keys of a mesh whose layout changed that Spine did not replace would move the wrong vertices: drop them.
  for (const [clipName, clip] of Object.entries(rigAnims)) {
    if (!isObject(clip) || !isObject(clip.deform)) continue;
    for (const [skin, bySlot] of Object.entries(clip.deform)) {
      if (!isObject(bySlot)) continue;
      for (const [slot, byAtt] of Object.entries(bySlot)) {
        if (!isObject(byAtt)) continue;
        for (const name of Object.keys(byAtt)) {
          const was = before.get(`${skin}/${slot}/${name}`);
          const mesh = resolveMesh(rigAttachment(skin, slot, name));
          if (was === undefined || !mesh || replaced.has(`${clipName}/${skin}/${slot}/${name}`)) continue;
          if (was !== layout(mesh)) {
            delete byAtt[name];
            warn(`clip '${clipName}' ${skin}/${slot}/${name}: the mesh's vertices / weights changed and Spine has no deform for it; the old deform keys were dropped`);
          }
        }
      }
    }
  }

  // Validate before anything is written.
  loadAnimDocument(JSON.parse(JSON.stringify(merged)), { source: documentPath });
  let backup: string | null = null;
  if (!options.dryRun) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    backup = `${documentPath}.bak-${stamp}`;
    copyFileSync(documentPath, backup);
    writeFileSync(documentPath, `${JSON.stringify(merged, null, 1)}\n`);
  }
  return { document: documentPath, backup, dryRun: options.dryRun === true, meshes, linked, deform: deformDone, extras, warnings: [...new Set(warnings)] };
}

export async function importSpineMeshesCommand(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const [spine] = positional;
  const merge = flags.get("merge");
  if (!spine || typeof merge !== "string") {
    process.stderr.write("usage: animator import-spine <spine.json> --merge <rigdir|rig.anim.json> [--clips a,b] [--dry-run]\n");
    return 2;
  }
  const options: SpineMeshImportOptions = { spine, merge };
  const clips = flags.get("clips");
  if (typeof clips === "string") options.clips = clips.split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.has("dry-run")) options.dryRun = true;
  const r = importSpineMeshes(options);
  process.stdout.write(`spine mesh import${r.dryRun ? " (dry run, nothing written)" : ""}: ${r.document}\n`);
  if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
  process.stdout.write(`  ${r.meshes.length} mesh(es), ${r.linked.length} linked mesh(es), ${r.deform.length} deform timeline(s)\n`);
  for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
  return 0;
}
