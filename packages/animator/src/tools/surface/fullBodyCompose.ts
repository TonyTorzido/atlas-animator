/*
 * Atlas Animator: original implementation.
 *
 * Full-body composition (phase 2b milestones 2-3): the independently built parts of a full-body
 * preset (tools/surface/fullBody.ts) merged into one document by name, never mirrored.
 * Bones: the union, shared names must agree at setup (one skeleton). Draw order, bottom to top:
 *   far arms (wholly under the body), far leg skins, near leg skins, the torso carrier's slots up to
 *   and including its under-sheets (the torso), every leg's remaining slots (leg garments: over the
 *   torso skin, under the arms), the torso carrier's remaining slots (the near arm over the torso:
 *   the arm-layer join), the other near arms.
 * Skins, driven sets, driven grids, pose limits and contact bands are concatenated; clips are not
 * merged (the composed rig gets the shared view clips). Slot or attachment clashes are errors.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RgbaImage } from "../image.js";
import type { FullBodyPartSpec } from "./fullBody.js";
import type { SurfacePreset } from "./preset.js";

export interface BuiltPart {
  spec: FullBodyPartSpec;
  preset: SurfacePreset;
  /** The part's built document (raw JSON, as buildRig returns it). */
  raw: Record<string, any>;
  textures: ReadonlyMap<string, RgbaImage>;
}

export interface ComposedBody {
  doc: Record<string, any>;
  textures: Map<string, RgbaImage>;
  /** Slots per part (composed names), bottom to top. */
  slotsOf: Record<string, string[]>;
  /** The torso under-sheet keys (`slot/attachment`) of the torso carrier. */
  sheets: string[];
  report: string[];
}

const BONE_KEYS = ["parent", "x", "y", "rotation", "length", "scaleX", "scaleY", "shearX", "shearY", "inherit", "limits"];
const MERGED = new Set(["format", "name", "canvas", "bones", "slots", "skins", "animations", "driven", "drivenGrids", "poseLimits", "contactBands"]);

export function composeFullBody(name: string, parts: readonly BuiltPart[]): ComposedBody {
  if (!parts.length) throw new Error("compose: no parts");
  const report: string[] = [];
  const canvas = JSON.stringify(parts[0]?.raw.canvas);
  const bones: any[] = [];
  const byName = new Map<string, { part: string; bone: any }>();
  for (const p of parts) {
    if (JSON.stringify(p.raw.canvas) !== canvas) throw new Error(`compose: part '${p.spec.name}' has another canvas`);
    for (const k of Object.keys(p.raw)) if (!MERGED.has(k)) throw new Error(`compose: part '${p.spec.name}' document field '${k}' is not merged`);
    for (const b of p.raw.bones as any[]) {
      const seen = byName.get(b.name);
      if (!seen) {
        if (b.parent && !byName.has(b.parent)) throw new Error(`compose: bone '${b.name}' of '${p.spec.name}' comes before its parent '${b.parent}'`);
        byName.set(b.name, { part: p.spec.name, bone: b });
        bones.push(structuredClone(b));
        continue;
      }
      for (const k of BONE_KEYS) if (JSON.stringify(seen.bone[k] ?? null) !== JSON.stringify(b[k] ?? null)) throw new Error(`compose: shared bone '${b.name}' differs in ${k} between '${seen.part}' and '${p.spec.name}'`);
    }
  }
  const carriers = parts.filter((p) => p.preset.assembly);
  if (carriers.length !== 1) throw new Error(`compose: exactly one part carries the torso sheet (found ${carriers.length})`);
  const carrier = carriers[0] as BuiltPart;
  const sheetSlots = new Set((carrier.preset.assembly?.sheets ?? []).map((s) => s.slot));
  const slotList = (p: BuiltPart) => (p.raw.slots as any[]).map((s) => s.name as string);
  const carrierSlots = slotList(carrier);
  const lastSheet = Math.max(...carrierSlots.map((s, i) => (sheetSlots.has(s) ? i : -1)));
  if (lastSheet < 0) throw new Error("compose: the torso carrier built no sheet slot");
  const legs = (depth: "near" | "far") => parts.filter((p) => p.spec.kind === "leg" && p.spec.depth === depth);
  const order: [BuiltPart, string[]][] = [];
  for (const p of parts.filter((q) => q.spec.depth === "far" && q.spec.kind !== "leg")) order.push([p, slotList(p)]);
  for (const p of [...legs("far"), ...legs("near")]) order.push([p, slotList(p).slice(0, 1)]);
  order.push([carrier, carrierSlots.slice(0, lastSheet + 1)]);
  for (const p of [...legs("far"), ...legs("near")]) order.push([p, slotList(p).slice(1)]);
  order.push([carrier, carrierSlots.slice(lastSheet + 1)]);
  for (const p of parts.filter((q) => q !== carrier && q.spec.depth === "near" && q.spec.kind !== "leg")) order.push([p, slotList(p)]);
  const slots: any[] = [];
  const seenSlot = new Set<string>();
  const slotsOf: Record<string, string[]> = {};
  for (const [p, names] of order) {
    for (const n of names) {
      if (seenSlot.has(n)) throw new Error(`compose: slot '${n}' is built by two parts`);
      seenSlot.add(n);
      slots.push(structuredClone((p.raw.slots as any[]).find((s) => s.name === n)));
      (slotsOf[p.spec.name] ??= []).push(n);
    }
  }
  const skins: Record<string, any> = {};
  for (const p of parts) {
    for (const [key, sk] of Object.entries(p.raw.skins as Record<string, any>)) {
      const target = (skins[key] ??= { attachments: {} });
      for (const k of Object.keys(sk)) if (k !== "attachments" && k !== "contours") throw new Error(`compose: skin field '${k}' of '${p.spec.name}' is not merged`);
      for (const [slot, atts] of Object.entries(sk.attachments ?? {})) {
        if (target.attachments[slot]) throw new Error(`compose: attachments of slot '${slot}' come from two parts`);
        target.attachments[slot] = structuredClone(atts);
      }
      for (const [slot, cs] of Object.entries(sk.contours ?? {})) {
        if (target.contours?.[slot]) throw new Error(`compose: contours of slot '${slot}' come from two parts`);
        (target.contours ??= {})[slot] = structuredClone(cs);
      }
    }
  }
  const cat = (k: string) => parts.flatMap((p) => structuredClone((p.raw[k] as any[]) ?? []));
  const doc: Record<string, any> = { format: parts[0]?.raw.format, name, canvas: structuredClone(parts[0]?.raw.canvas), bones, slots, skins, animations: {} };
  for (const k of ["driven", "drivenGrids", "poseLimits", "contactBands"]) {
    const v = cat(k);
    if (v.length) doc[k] = v;
  }
  const names = new Set<string>();
  for (const pl of (doc.poseLimits ?? []) as any[]) {
    if (names.has(pl.name)) throw new Error(`compose: pose limit '${pl.name}' declared by two parts`);
    names.add(pl.name);
  }
  const textures = new Map<string, RgbaImage>();
  for (const p of parts) for (const [k, v] of p.textures) {
    if (textures.has(k)) throw new Error(`compose: texture '${k}' comes from two parts`);
    textures.set(k, v);
  }
  report.push(`composed ${parts.length} parts: ${bones.length} bones, ${slots.length} slots (${slots.map((s) => s.name).join(" < ")})`);
  const sheets = (carrier.preset.assembly?.sheets ?? []).map((s) => `${s.slot}/${s.attachment}`);
  return { doc, textures, slotsOf, sheets, report };
}
