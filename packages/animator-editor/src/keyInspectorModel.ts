/*
 * Atlas Animator editor: original implementation.
 *
 * Key inspector model (pure): what the selected key holds (value, curve, interpolation, event payload, attachment, colour, mixes), how
 * to change one field of it, and how to add a first key to a channel the dopesheet now shows (slot colour, transform / physics mix,
 * IK mix). Every result is a new clip.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, snapTime } from "./clipModel.js";
import { rowChannels, type RowId } from "./dopesheetModel.js";

export interface KeyField {
  id: string;
  label: string;
  kind: "number" | "text" | "bool" | "color" | "info" | "choice";
  /** Allowed values of a "choice" field. */
  options?: readonly string[];
  value: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface KeyChannelInfo {
  /** Channel name inside the row: rotate, translate, color, mix, attachment, ... */
  channel: string;
  fields: KeyField[];
  /** The key's curve to the next key (undefined for channels without one: attachments, events, draw order). */
  curve: unknown;
  hasCurve: boolean;
}

const FIELD_LABEL: Record<string, string> = {
  mode: "Mode",
  index: "Start frame",
  delay: "Delay (s per frame)",
  value: "Value",
  x: "X",
  y: "Y",
  mix: "Mix",
  position: "Position along path",
  spacing: "Spacing",
  mixRotate: "Mix rotate",
  mixX: "Mix X",
  mixY: "Mix Y",
  mixScaleX: "Mix scale X",
  mixScaleY: "Mix scale Y",
  mixShearY: "Mix shear Y",
  softness: "Softness",
  bendPositive: "Bend positive",
  stretch: "Stretch",
  compress: "Compress",
  name: "Name",
  int: "Int",
  float: "Float",
  string: "String",
  audio: "Audio",
  color: "Colour (rrggbbaa)",
  offset: "Offset"
};

/** A readable name for a curve spec: "linear", "stepped" or "bezier (x1, y1, x2, y2)" (per channel for object curves). */
export function describeCurve(curve: unknown): string {
  if (curve === undefined || curve === "linear") return "linear";
  if (curve === "stepped") return "stepped";
  if (Array.isArray(curve)) return `bezier (${curve.map((n) => Math.round((n as number) * 1000) / 1000).join(", ")})`;
  if (curve && typeof curve === "object") return Object.entries(curve as Record<string, unknown>).map(([k, v]) => `${k}: ${describeCurve(v)}`).join("; ");
  return String(curve);
}

/** The interpolation word for a curve: Linear / Stepped / Bezier / Per channel. */
export function interpolationOf(curve: unknown): "Linear" | "Stepped" | "Bezier" | "Per channel" {
  if (curve === undefined || curve === "linear") return "Linear";
  if (curve === "stepped") return "Stepped";
  if (Array.isArray(curve)) return "Bezier";
  return "Per channel";
}

function fieldFor(id: string, v: unknown): KeyField | null {
  const label = FIELD_LABEL[id] ?? id;
  if (typeof v === "number") {
    const unit = id.startsWith("mix") || id === "mix";
    return { id, label, kind: "number", value: v, ...(unit ? { min: 0, max: 1, step: 0.05 } : { step: id === "int" ? 1 : 0.1 }) };
  }
  if (typeof v === "boolean") return { id, label, kind: "bool", value: v };
  if (typeof v === "string" && id === "mode") return { id, label, kind: "choice", value: v, options: ["hold", "once", "loop", "pingpong"] };
  if (typeof v === "string") return { id, label, kind: id === "color" ? "color" : "text", value: v };
  if (v === null) return { id, label, kind: "text", value: "" };
  if (Array.isArray(v)) return { id, label, kind: "info", value: `${v.length} item${v.length === 1 ? "" : "s"}` };
  return null;
}

/** Every channel of the row that has a key at `time`, with its editable fields. */
export function keyChannels(clip: ClipData, row: RowId, time: number): KeyChannelInfo[] {
  const out: KeyChannelInfo[] = [];
  for (const ch of rowChannels(clip, row)) {
    const key = ch.keys.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
    if (!key) continue;
    const fields: KeyField[] = [];
    for (const [id, v] of Object.entries(key)) {
      if (id === "time" || id === "curve") continue;
      const f = fieldFor(id, v);
      if (f) fields.push(f);
    }
    // An event key always shows all four payload fields (a field the key does not set shows the empty default and writes on edit).
    if (row === "event") {
      for (const [id, empty] of [["int", 0], ["float", 0], ["string", ""], ["audio", ""]] as const) {
        if (!fields.some((f) => f.id === id)) {
          const f = fieldFor(id, empty);
          if (f) fields.push(f);
        }
      }
      const order = ["name", "int", "float", "string", "audio"];
      fields.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }
    out.push({ channel: ch.name, fields, curve: key.curve, hasCurve: "curve" in key });
  }
  return out;
}

/** Sets fields of the key (one channel of a row) at `time`. Unknown ids are ignored; numbers are clamped to the field's range. */
export function setKeyFields(clip: ClipData, row: RowId, time: number, channel: string, patch: Record<string, number | string | boolean>): ClipData {
  const next = structuredClone(clip);
  const ch = rowChannels(next, row).find((c) => c.name === channel);
  const key = ch?.keys.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (!ch || !key) return clip;
  for (const [id, v] of Object.entries(patch)) {
    if (id === "time" || !(id in key) && !(id in FIELD_LABEL)) continue;
    if (typeof v === "number") {
      const f = fieldFor(id, v);
      key[id] = f && f.min !== undefined ? Math.max(f.min, Math.min(f.max ?? Infinity, v)) : Math.round(v * 10000) / 10000;
      if (id === "int") key[id] = Math.round(v);
    } else key[id] = v;
  }
  return next;
}

/** Sets the curve of the key (one channel) at `time`. */
export function setKeyCurve(clip: ClipData, row: RowId, time: number, channel: string, curve: unknown): ClipData {
  const next = structuredClone(clip);
  const key = rowChannels(next, row).find((c) => c.name === channel)?.keys.find((k) => Math.abs(k.time - time) < KEY_EPSILON);
  if (!key) return clip;
  key.curve = curve;
  return next;
}

// ---------------------------------------------------------------------------------------------
// New keys on channels that had none
// ---------------------------------------------------------------------------------------------

export type NewKeyTarget =
  | { kind: "color"; slot: string }
  | { kind: "sequence"; slot: string }
  | { kind: "transform"; name: string }
  | { kind: "path"; name: string }
  | { kind: "physics"; name: string; channel: "mix" | "reset" }
  | { kind: "ik"; name: string };

export const PATH_KEY_FIELDS = ["position", "spacing", "mixRotate", "mixX", "mixY"] as const;
export const TRANSFORM_MIX_FIELDS = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const;

/** The dopesheet row a new-key target lives on. */
export function targetRow(t: NewKeyTarget): RowId {
  return t.kind === "color" ? `color:${t.slot}` : t.kind === "sequence" ? `seq:${t.slot}` : t.kind === "transform" ? `transform:${t.name}` : t.kind === "path" ? `path:${t.name}` : t.kind === "physics" ? `physics:${t.name}` : `ik:${t.name}`;
}

type AnyKey = { time: number } & Record<string, unknown>;

function put(keys: AnyKey[], key: AnyKey): AnyKey[] {
  const at = keys.findIndex((k) => Math.abs(k.time - key.time) < KEY_EPSILON);
  if (at >= 0) keys[at] = { ...keys[at]!, ...key };
  else keys.push(key);
  return keys.sort((a, b) => a.time - b.time);
}

/**
 * Adds (or updates) a key at the frame nearest `time` on a channel. `values` overrides the starting values; otherwise the value comes
 * from the nearest earlier key of the channel, then from `setup` (the constraint's or slot's setup values), then from the neutral value
 * (colour white, mixes 1). An existing key at that frame keeps its curve.
 */
export function addChannelKey(clip: ClipData, target: NewKeyTarget, time: number, values: Record<string, number | string> = {}, setup: Record<string, number | string> = {}): ClipData {
  const next = structuredClone(clip);
  const t = snapTime(next, time);
  const before = <K extends AnyKey>(keys: K[] | undefined): K | undefined => [...(keys ?? [])].reverse().find((k) => k.time <= t + KEY_EPSILON);
  if (target.kind === "sequence") {
    const tl = (next.slots[target.slot] ??= {}) as Record<string, unknown>;
    const keys = ((tl.sequence ??= []) as AnyKey[]);
    const prev = before(keys);
    put(keys, { time: t, mode: String(values.mode ?? prev?.mode ?? "loop"), index: Math.max(0, Math.round(Number(values.index ?? prev?.index ?? 0))), delay: Math.max(0, Number(values.delay ?? prev?.delay ?? 0.1)) });
  } else if (target.kind === "color") {
    const tl = (next.slots[target.slot] ??= {});
    const keys = (tl.color ??= []) as unknown as AnyKey[];
    const prev = before(keys);
    const color = String(values.color ?? prev?.color ?? setup.color ?? "ffffffff").toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(color)) return clip;
    put(keys, { time: t, color, curve: "linear" });
  } else if (target.kind === "transform") {
    const keys = (next.transform[target.name] ??= []) as unknown as AnyKey[];
    const prev = before(keys);
    const key: AnyKey = { time: t, curve: "linear" };
    for (const f of TRANSFORM_MIX_FIELDS) key[f] = Math.max(0, Math.min(1, Number(values[f] ?? prev?.[f] ?? setup[f] ?? 1)));
    put(keys, key);
  } else if (target.kind === "path") {
    const store = ((next as { path?: Record<string, unknown> }).path ??= {});
    const keys = ((store[target.name] ??= []) as AnyKey[]);
    const prev = before(keys);
    const key: AnyKey = { time: t, curve: "linear" };
    for (const f of PATH_KEY_FIELDS) {
      const v = Number(values[f] ?? prev?.[f] ?? setup[f] ?? (f.startsWith("mix") ? 1 : 0));
      key[f] = f.startsWith("mix") ? Math.max(0, Math.min(1, v)) : v;
    }
    put(keys, key);
  } else if (target.kind === "ik") {
    const keys = (next.ik[target.name] ??= []) as unknown as AnyKey[];
    const prev = before(keys);
    put(keys, { time: t, mix: Math.max(0, Math.min(1, Number(values.mix ?? prev?.mix ?? setup.mix ?? 1))), curve: "linear" });
  } else {
    const tl = (next.physics[target.name] ??= {});
    if (target.channel === "reset") {
      put((tl.reset ??= []) as unknown as AnyKey[], { time: t });
    } else {
      const keys = (tl.mix ??= []) as unknown as AnyKey[];
      const prev = before(keys);
      put(keys, { time: t, value: Math.max(0, Math.min(1, Number(values.value ?? prev?.value ?? setup.value ?? 1))), curve: "linear" });
    }
  }
  return next;
}
