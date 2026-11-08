/*
 * Atlas Animator editor: original implementation.
 *
 * The pose library (pure): a named pose is the whole look of one frame, not just bone angles: every bone's offsets from
 * setup, the attachment swaps in force (eyes closed, a smear, a fist for an open hand) and the draw order. Saved poses
 * apply to any clip at its playhead (blocking: place a library pose on a key frame, then tune), and across rigs of the
 * same template: bones and slots the target rig lacks are skipped and reported.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, pastePose, snapTime, type PoseCopy } from "./clipModel.js";
import { addChannelKey } from "./keyInspectorModel.js";
import { drawOrderAt, setAttachmentKey, setDrawOrderKey, type DrawOffset } from "./slotModel.js";

/** One captured deform: the span of floats a deform key holds for a mesh attachment. */
export interface PoseDeform {
  skin: string;
  slot: string;
  attachment: string;
  offset: number;
  vertices: number[];
}

/** Constraint mixes: IK mix per constraint, transform constraint mixes per field. */
export interface PoseMixes {
  ik: Record<string, number>;
  transform: Record<string, Record<string, number>>;
}

/** What a capture takes (the checklist in the Pose library). Bones are always the base. */
export interface PoseInclude {
  /** The root bone's own offsets (the whole character's move). */
  root: boolean;
  shear: boolean;
  mixes: boolean;
  /** Attachment swaps and slot colours. */
  slots: boolean;
  drawOrder: boolean;
  deforms: boolean;
}

export type PoseScope = "selected" | "character" | "full";

/** The checklist each scope starts from; the user can change single boxes after picking one. */
export function scopeDefaults(scope: PoseScope): PoseInclude {
  if (scope === "selected") return { root: false, shear: true, mixes: false, slots: false, drawOrder: false, deforms: false };
  if (scope === "character") return { root: false, shear: true, mixes: false, slots: true, drawOrder: true, deforms: false };
  return { root: true, shear: true, mixes: true, slots: true, drawOrder: true, deforms: true };
}

export const INCLUDE_LABEL: Record<keyof PoseInclude, string> = { root: "Root", shear: "Shear", mixes: "Constraint mixes", slots: "Slots", drawOrder: "Draw order", deforms: "Deforms" };

export const POSE_FORMAT = "atlas-pose@1";
export const POSE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;

export interface PoseRecord {
  format: typeof POSE_FORMAT;
  name: string;
  /** Rotate / translate / scale offsets from setup, per bone. */
  bones: PoseCopy;
  /** The attachment shown per slot where it differs from the setup or the clip keys it (null = hidden). */
  attachments: Record<string, string | null>;
  /** Draw order offsets from the setup order. */
  drawOrder: DrawOffset[];
  /** Constraint mixes in force (captured with "Constraint mixes"). */
  mixes?: PoseMixes | undefined;
  /** Slot colours (rrggbbaa) where they differ from the setup (captured with "Slots"). */
  colors?: Record<string, string> | undefined;
  /** Deform spans in force (captured with "Deforms"). */
  deform?: PoseDeform[] | undefined;
  /** The checklist this pose was captured with (for the list; absent on poses made before the scopes). */
  includes?: (keyof PoseInclude)[] | undefined;
  /** Free text for the library list (what the pose is for). */
  note?: string | undefined;
  /** Shipped with the editor (the starter library): read-only, the server refuses to overwrite or delete it. */
  builtin?: boolean | undefined;
  /** The rig (outfit id, e.g. "pro-front") a built-in pose was made for; absent on poses that suit any rig. */
  rig?: string | undefined;
  /** Library tags (guard, wind-up, follow-through, contact, idle ...) for the grid's filter. */
  tags?: string[] | undefined;
}

export interface PoseCapture {
  name: string;
  bones: PoseCopy;
  attachments: Record<string, string | null>;
  drawOrder: DrawOffset[];
  mixes?: PoseMixes | undefined;
  colors?: Record<string, string> | undefined;
  deform?: PoseDeform[] | undefined;
  includes?: readonly (keyof PoseInclude)[] | undefined;
  note?: string | undefined;
  builtin?: boolean | undefined;
  rig?: string | undefined;
  tags?: readonly string[] | undefined;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

export function makePose(c: PoseCapture): PoseRecord {
  if (!POSE_NAME.test(c.name)) throw new Error(`pose names use letters, digits, '_' and '-' (up to 48 characters): '${c.name}'`);
  const bones: PoseCopy = {};
  for (const [bone, o] of Object.entries(c.bones)) {
    bones[bone] = { rotate: round(o.rotate), translate: { x: round(o.translate.x), y: round(o.translate.y) }, scale: { x: round(o.scale.x), y: round(o.scale.y) }, ...(o.shear ? { shear: { x: round(o.shear.x), y: round(o.shear.y) } } : {}) };
  }
  const mixes = c.mixes && (Object.keys(c.mixes.ik).length || Object.keys(c.mixes.transform).length) ? { ik: { ...c.mixes.ik }, transform: Object.fromEntries(Object.entries(c.mixes.transform).map(([k, v]) => [k, { ...v }])) } : undefined;
  return { format: POSE_FORMAT, name: c.name, bones, attachments: { ...c.attachments }, drawOrder: c.drawOrder.map((d) => ({ ...d })), ...(mixes ? { mixes } : {}), ...(c.colors && Object.keys(c.colors).length ? { colors: { ...c.colors } } : {}), ...(c.deform?.length ? { deform: c.deform.map((d) => ({ ...d, vertices: [...d.vertices] })) } : {}), ...(c.includes?.length ? { includes: [...c.includes] } : {}), ...(c.note ? { note: c.note } : {}), ...(c.builtin ? { builtin: true } : {}), ...(c.rig ? { rig: c.rig } : {}), ...(c.tags?.length ? { tags: [...c.tags] } : {}) };
}

/** Validates a parsed pose file, throwing with the first problem. */
export function parsePose(raw: unknown): PoseRecord {
  const r = raw as Partial<PoseRecord> | null;
  if (!r || typeof r !== "object" || r.format !== POSE_FORMAT) throw new Error(`not an ${POSE_FORMAT} pose`);
  if (typeof r.name !== "string" || !POSE_NAME.test(r.name)) throw new Error("the pose has no valid name");
  if (!r.bones || typeof r.bones !== "object") throw new Error("the pose has no bones");
  for (const [bone, o] of Object.entries(r.bones)) {
    const ok = o && Number.isFinite(o.rotate) && Number.isFinite(o.translate?.x) && Number.isFinite(o.translate?.y) && Number.isFinite(o.scale?.x) && Number.isFinite(o.scale?.y);
    if (!ok) throw new Error(`bone '${bone}' has a malformed pose entry`);
  }
  for (const [bone, o] of Object.entries(r.bones)) if (o.shear !== undefined && !(Number.isFinite(o.shear.x) && Number.isFinite(o.shear.y))) throw new Error(`bone '${bone}' has a malformed shear`);
  for (const [slot, c] of Object.entries(r.colors ?? {})) if (!/^[0-9a-f]{8}$/.test(c)) throw new Error(`slot '${slot}' has a malformed colour`);
  for (const d of r.deform ?? []) if (typeof d.slot !== "string" || typeof d.attachment !== "string" || !Array.isArray(d.vertices) || !d.vertices.every(Number.isFinite)) throw new Error("the pose has a malformed deform");
  for (const [slot, a] of Object.entries(r.attachments ?? {})) if (a !== null && typeof a !== "string") throw new Error(`slot '${slot}' has a malformed attachment`);
  for (const d of r.drawOrder ?? []) if (typeof d.slot !== "string" || !Number.isInteger(d.offset)) throw new Error("the pose has a malformed draw order offset");
  return makePose({ name: r.name, bones: r.bones, attachments: r.attachments ?? {}, drawOrder: r.drawOrder ?? [], mixes: r.mixes, colors: r.colors, deform: r.deform, includes: Array.isArray(r.includes) ? r.includes : undefined, note: r.note, builtin: r.builtin === true, rig: typeof r.rig === "string" ? r.rig : undefined, tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : undefined });
}

export interface ApplyOptions {
  bones?: boolean;
  attachments?: boolean;
  order?: boolean;
  /** Constraint mixes, slot colours and deforms the pose carries (default on). */
  mixes?: boolean;
  colors?: boolean;
  deform?: boolean;
  /** Apply only these bones (a track, e.g. the upper body); attachments and draw order are unaffected by it. */
  only?: readonly string[];
  /** The target rig's bones and slots: unknown names are skipped and reported. Absent: no filtering. */
  knownBones?: ReadonlySet<string>;
  knownSlots?: ReadonlySet<string>;
  /** IK and transform constraint names of the target rig (mixes of others are skipped and reported). */
  knownConstraints?: ReadonlySet<string>;
}

export interface ApplyResult {
  clip: ClipData;
  bones: number;
  slots: number;
  order: boolean;
  /** Constraint mixes, slot colours and deforms keyed. */
  extras: { mixes: number; colors: number; deforms: number };
  skipped: string[];
}

/** Keys a library pose into a clip at `time` (every part the options leave on). */
export function applyPoseRecord(clip: ClipData, pose: PoseRecord, time: number, options: ApplyOptions = {}): ApplyResult {
  const { bones: withBones = true, attachments: withSwaps = true, order: withOrder = true } = options;
  const t = snapTime(clip, time);
  const skipped: string[] = [];
  let next = clip;
  let boneCount = 0;
  if (withBones) {
    const picked: PoseCopy = {};
    for (const [bone, o] of Object.entries(pose.bones)) {
      if (options.only && !options.only.includes(bone)) continue;
      if (options.knownBones && !options.knownBones.has(bone)) {
        skipped.push(`bone ${bone}`);
        continue;
      }
      picked[bone] = o;
    }
    next = pastePose(next, picked, t);
    boneCount = Object.keys(picked).length;
  }
  let slotCount = 0;
  if (withSwaps) {
    for (const [slot, name] of Object.entries(pose.attachments)) {
      if (options.knownSlots && !options.knownSlots.has(slot)) {
        skipped.push(`slot ${slot}`);
        continue;
      }
      next = setAttachmentKey(next, slot, t, name);
      slotCount++;
    }
  }
  let orderWritten = false;
  if (withOrder) {
    const offsets = pose.drawOrder.filter((d) => !options.knownSlots || options.knownSlots.has(d.slot));
    for (const d of pose.drawOrder) if (options.knownSlots && !options.knownSlots.has(d.slot)) skipped.push(`draw order ${d.slot}`);
    // An empty order only needs a key when an earlier key of the clip is still in force and has to be undone.
    if (offsets.length || drawOrderAt(next, t).length) {
      next = setDrawOrderKey(next, t, offsets);
      orderWritten = true;
    }
  }
  const extras = { mixes: 0, colors: 0, deforms: 0 };
  if ((options.mixes ?? true) && pose.mixes) {
    for (const [name, mix] of Object.entries(pose.mixes.ik)) {
      if (options.knownConstraints && !options.knownConstraints.has(name)) skipped.push(`ik ${name}`);
      else (next = addChannelKey(next, { kind: "ik", name }, t, { mix }), extras.mixes++);
    }
    for (const [name, fields] of Object.entries(pose.mixes.transform)) {
      if (options.knownConstraints && !options.knownConstraints.has(name)) skipped.push(`transform ${name}`);
      else (next = addChannelKey(next, { kind: "transform", name }, t, fields), extras.mixes++);
    }
  }
  if ((options.colors ?? true) && pose.colors) {
    for (const [slot, color] of Object.entries(pose.colors)) {
      if (options.knownSlots && !options.knownSlots.has(slot)) skipped.push(`colour ${slot}`);
      else (next = addChannelKey(next, { kind: "color", slot }, t, { color }), extras.colors++);
    }
  }
  if ((options.deform ?? true) && pose.deform?.length) {
    next = structuredClone(next);
    for (const d of pose.deform) {
      if (options.knownSlots && !options.knownSlots.has(d.slot)) {
        skipped.push(`deform ${d.slot}/${d.attachment}`);
        continue;
      }
      const keys = (((next.deform[d.skin] ??= {})[d.slot] ??= {})[d.attachment] ??= []);
      const at = keys.findIndex((k) => Math.abs(k.time - t) < KEY_EPSILON);
      const key = { time: at >= 0 ? keys[at]!.time : t, offset: d.offset, vertices: [...d.vertices], curve: at >= 0 ? keys[at]!.curve : ("linear" as const) };
      if (at >= 0) keys[at] = key;
      else (keys.push(key), keys.sort((a, b) => a.time - b.time));
      extras.deforms++;
    }
  }
  return { clip: next, bones: boneCount, slots: slotCount, order: orderWritten, extras, skipped };
}

/** One line for the library list. */
export function poseSummary(p: PoseRecord): string {
  const moved = Object.values(p.bones).filter((o) => Math.abs(o.rotate) > 0.05).length;
  const swaps = Object.keys(p.attachments).length;
  const more = [
    p.bones["root"] ? "root" : "",
    Object.values(p.bones).some((o) => o.shear && (Math.abs(o.shear.x) > 0.05 || Math.abs(o.shear.y) > 0.05)) ? "shear" : "",
    p.mixes ? `${Object.keys(p.mixes.ik).length + Object.keys(p.mixes.transform).length} mixes` : "",
    p.colors ? `${Object.keys(p.colors).length} colours` : "",
    p.deform?.length ? `${p.deform.length} deforms` : ""
  ].filter(Boolean);
  return `${moved} bones posed, ${swaps} swap${swaps === 1 ? "" : "s"}, ${p.drawOrder.length ? "custom draw order" : "setup draw order"}${more.length ? `, ${more.join(", ")}` : ""}`;
}
