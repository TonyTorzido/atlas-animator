/*
 * Atlas Animator editor: original implementation.
 *
 * Dopesheet edits (pure): a selection of keys, and move / scale / copy / paste / delete on it. A selected key is
 * a row plus a time: `bone:<name>` (every channel of the bone at that time), `ik:<name>`, `slot:<name>` (image swap keys), `color:<slot>` (colour / alpha
 * keys), `transform:<constraint>` (mix keys), `path:<constraint>` (position, spacing and mix keys), `physics:<constraint>` (mix and reset keys), `deform:<skin>/<slot>/<attachment>` (the shape keys of one mesh; names cannot contain "/") or `draw` (draw order keys). Times live on the clip's frame grid; every result is a new clip.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { frameCount, frameTime, KEY_EPSILON, timeToFrame } from "./clipModel.js";

export type RowId = `bone:${string}` | `ik:${string}` | `slot:${string}` | `color:${string}` | `seq:${string}` | `transform:${string}` | `path:${string}` | `physics:${string}` | `deform:${string}` | "draw" | "event";
export interface KeySel {
  row: RowId;
  time: number;
}

type Key = { time: number } & Record<string, unknown>;
interface Channel {
  name: string;
  get(): Key[] | undefined;
  set(keys: Key[]): void;
}

const same = (a: number, b: number) => Math.abs(a - b) < KEY_EPSILON;

/** The address of a deform row's timeline. */
export interface DeformRowAddress {
  skin: string;
  slot: string;
  attachment: string;
}

export const deformRowId = (a: DeformRowAddress): RowId => `deform:${a.skin}/${a.slot}/${a.attachment}`;

/** The mesh a `deform:` row id names, or null for any other row. */
export function parseDeformRow(row: RowId): DeformRowAddress | null {
  if (!row.startsWith("deform:")) return null;
  const parts = row.slice(7).split("/");
  return parts.length === 3 ? { skin: parts[0]!, slot: parts[1]!, attachment: parts[2]! } : null;
}

/** The deform rows of one slot (every skin), in clip order. */
export function deformRowsOfSlot(clip: ClipData, slot: string): DeformRowAddress[] {
  const out: DeformRowAddress[] = [];
  for (const [skin, slots] of Object.entries(clip.deform)) for (const attachment of Object.keys(slots[slot] ?? {})) out.push({ skin, slot, attachment });
  return out;
}

function rowName(row: RowId): string {
  if (row === "draw" || row === "event") return "";
  const name = row.slice(row.indexOf(":") + 1);
  return row.startsWith("bone:") ? name.split("#")[0]! : name;
}

/**
 * Per-property rows (): `bone:<name>#<property>` names ONE property of a bone (rotate, translate, scale, shear, or scaleShear for
 * the dopesheet's combined scale / shear row), so moving, deleting, copying or pasting a key there leaves the bone's other channels
 * alone. Plain `bone:<name>` is the bone summary row and still means every channel at that time. Bone names cannot contain "#".
 */
export type BoneProperty = "rotate" | "translate" | "scale" | "shear" | "scaleShear";
export const boneChannelRow = (bone: string, property: BoneProperty): RowId => `bone:${bone}#${property}`;
/** The bone of a `bone:` row (with or without a property), or null for any other row. */
export function rowBone(row: RowId): string | null {
  return row.startsWith("bone:") ? row.slice(5).split("#")[0]! : null;
}
/** The property of a `bone:<name>#<property>` row, or null for a bone summary row / any other row. */
export function rowProperty(row: RowId): BoneProperty | null {
  if (!row.startsWith("bone:")) return null;
  const p = row.split("#")[1];
  return p === "rotate" || p === "translate" || p === "scale" || p === "shear" || p === "scaleShear" ? p : null;
}
const PROPERTY_CHANNELS: Record<BoneProperty, readonly ("rotate" | "translate" | "scale" | "shear")[]> = {
  rotate: ["rotate"],
  translate: ["translate"],
  scale: ["scale"],
  shear: ["shear"],
  scaleShear: ["scale", "shear"]
};

/** The key arrays a row owns, with setters that keep the clip valid (empty timelines are removed). */
function channels(clip: ClipData, row: RowId): Channel[] {
  const name = rowName(row);
  if (row === "draw") {
    return [{ name: "draw", get: () => clip.drawOrder as unknown as Key[], set: (keys) => void (clip.drawOrder = keys as unknown as ClipData["drawOrder"]) }];
  }
  if (row === "event") {
    return [{ name: "event", get: () => clip.events as unknown as Key[], set: (keys) => void (clip.events = keys as unknown as ClipData["events"]) }];
  }
  const deform = parseDeformRow(row);
  if (deform) {
    return [
      {
        name: "deform",
        get: () => clip.deform[deform.skin]?.[deform.slot]?.[deform.attachment] as unknown as Key[] | undefined,
        set: (keys) => {
          if (keys.length) ((clip.deform[deform.skin] ??= {})[deform.slot] ??= {})[deform.attachment] = keys as unknown as ClipData["deform"][string][string][string];
          else {
            const slots = clip.deform[deform.skin];
            const atts = slots?.[deform.slot];
            if (!slots || !atts) return;
            delete atts[deform.attachment];
            if (!Object.keys(atts).length) delete slots[deform.slot];
            if (!Object.keys(slots).length) delete clip.deform[deform.skin];
          }
        }
      }
    ];
  }
  if (row.startsWith("ik:")) {
    return [
      {
        name: "ik",
        get: () => clip.ik[name] as unknown as Key[] | undefined,
        set: (keys) => {
          if (keys.length) clip.ik[name] = keys as unknown as ClipData["ik"][string];
          else delete clip.ik[name];
        }
      }
    ];
  }
  if (row.startsWith("slot:")) {
    return [
      {
        name: "attachment",
        get: () => clip.slots[name]?.attachment as unknown as Key[] | undefined,
        set: (keys: Key[]) => {
          const tl = (clip.slots[name] ??= {});
          if (keys.length) (tl as Record<string, unknown>).attachment = keys;
          else delete tl.attachment;
          if (!tl.attachment && !tl.color && !(tl as Record<string, unknown>).sequence) delete clip.slots[name];
        }
      }
    ];
  }
  if (row.startsWith("seq:")) {
    return [
      {
        name: "sequence",
        get: () => (clip.slots[name] as { sequence?: unknown } | undefined)?.sequence as unknown as Key[] | undefined,
        set: (keys: Key[]) => {
          const tl = (clip.slots[name] ??= {});
          if (keys.length) (tl as Record<string, unknown>).sequence = keys;
          else delete (tl as Record<string, unknown>).sequence;
          if (!tl.attachment && !tl.color && !(tl as Record<string, unknown>).sequence) delete clip.slots[name];
        }
      }
    ];
  }
  if (row.startsWith("color:")) {
    return [
      {
        name: "color",
        get: () => clip.slots[name]?.color as unknown as Key[] | undefined,
        set: (keys: Key[]) => {
          const tl = (clip.slots[name] ??= {});
          if (keys.length) (tl as Record<string, unknown>).color = keys;
          else delete tl.color;
          if (!tl.attachment && !tl.color) delete clip.slots[name];
        }
      }
    ];
  }
  if (row.startsWith("transform:")) {
    return [
      {
        name: "transform",
        get: () => clip.transform[name] as unknown as Key[] | undefined,
        set: (keys) => {
          if (keys.length) clip.transform[name] = keys as unknown as ClipData["transform"][string];
          else delete clip.transform[name];
        }
      }
    ];
  }
  if (row.startsWith("path:")) {
    return [
      {
        name: "path",
        get: () => (clip as { path?: Record<string, unknown> }).path?.[name] as unknown as Key[] | undefined,
        set: (keys) => {
          const store = ((clip as { path?: Record<string, unknown> }).path ??= {});
          if (keys.length) store[name] = keys;
          else delete store[name];
        }
      }
    ];
  }
  if (row.startsWith("physics:")) {
    return (["mix", "reset"] as const).map((ch) => ({
      name: ch,
      get: () => clip.physics[name]?.[ch] as unknown as Key[] | undefined,
      set: (keys: Key[]) => {
        const tl = (clip.physics[name] ??= {});
        if (keys.length) (tl as Record<string, unknown>)[ch] = keys;
        else delete tl[ch];
        if (!tl.mix && !tl.reset) delete clip.physics[name];
      }
    }));
  }
  const property = rowProperty(row);
  return (property ? PROPERTY_CHANNELS[property] : (["rotate", "translate", "scale", "shear"] as const)).map((ch) => ({
    name: ch,
    get: () => clip.bones[name]?.[ch] as unknown as Key[] | undefined,
    set: (keys: Key[]) => {
      const tl = (clip.bones[name] ??= {});
      if (keys.length) (tl as Record<string, unknown>)[ch] = keys;
      else delete tl[ch];
      if (!Object.keys(tl).length) delete clip.bones[name];
    }
  }));
}

/** The key arrays a row owns (live references into `clip`), for the key inspector. */
export function rowChannels(clip: ClipData, row: RowId): { name: string; keys: Key[] }[] {
  return channels(clip, row).map((c) => ({ name: c.name, keys: c.get() ?? [] }));
}

/** Sorted unique key times of a row. */
export function rowKeyTimes(clip: ClipData, row: RowId): number[] {
  const out: number[] = [];
  for (const ch of channels(clip, row)) for (const k of ch.get() ?? []) if (!out.some((t) => same(t, k.time))) out.push(k.time);
  return out.sort((a, b) => a - b);
}

/** Every row that has keys, in the dopesheet's order: bones (clip order), IK, constraint mixes, physics, slot images, slot colours, deform (shape keys), draw order. */
export function keyedRows(clip: ClipData): RowId[] {
  const rows: RowId[] = [];
  for (const b of Object.keys(clip.bones)) rows.push(`bone:${b}`);
  for (const n of Object.keys(clip.ik)) rows.push(`ik:${n}`);
  for (const n of Object.keys(clip.transform)) rows.push(`transform:${n}`);
  for (const n of Object.keys((clip as { path?: Record<string, unknown> }).path ?? {})) rows.push(`path:${n}`);
  for (const n of Object.keys(clip.physics)) rows.push(`physics:${n}`);
  for (const [n, t] of Object.entries(clip.slots)) {
    if (t.attachment?.length) rows.push(`slot:${n}`);
    if (t.color?.length) rows.push(`color:${n}`);
    if ((t as { sequence?: unknown[] }).sequence?.length) rows.push(`seq:${n}`);
  }
  for (const [skin, slots] of Object.entries(clip.deform)) for (const [slot, atts] of Object.entries(slots)) for (const attachment of Object.keys(atts)) rows.push(deformRowId({ skin, slot, attachment }));
  if (clip.drawOrder.length) rows.push("draw");
  if (clip.events.length) rows.push("event");
  return rows;
}

/** Every key of the clip (all rows). */
export function allKeys(clip: ClipData): KeySel[] {
  return keyedRows(clip).flatMap((row) => rowKeyTimes(clip, row).map((time) => ({ row, time })));
}

/** Every key at one time across all rows (the "All keys" row's click). */
export function keysAtTime(clip: ClipData, time: number): KeySel[] {
  return allKeys(clip).filter((k) => same(k.time, time));
}

/** Keys within [from, to] seconds (inclusive), optionally limited to some rows. */
export function keysInRange(clip: ClipData, from: number, to: number, rows?: readonly RowId[]): KeySel[] {
  const lo = Math.min(from, to) - KEY_EPSILON;
  const hi = Math.max(from, to) + KEY_EPSILON;
  return allKeys(clip).filter((k) => k.time >= lo && k.time <= hi && (!rows || rows.includes(k.row)));
}

export function isSelected(sel: readonly KeySel[], row: RowId, time: number): boolean {
  return sel.some((s) => s.row === row && same(s.time, time));
}

/** Whether a bone's key of one property at `time` is selected: through its property row, the combined scale / shear row or the bone row. */
export function boneKeySelected(sel: readonly KeySel[], bone: string, property: "rotate" | "translate" | "scale" | "shear", time: number): boolean {
  return isSelected(sel, `bone:${bone}`, time) || isSelected(sel, boneChannelRow(bone, property), time) || ((property === "scale" || property === "shear") && isSelected(sel, boneChannelRow(bone, "scaleShear"), time));
}

/** Selection with `add` toggled in (used for shift-click) or replacing it. */
export function selectKeys(sel: readonly KeySel[], add: readonly KeySel[], mode: "replace" | "toggle" | "add"): KeySel[] {
  if (mode === "replace") return dedupe(add);
  if (mode === "add") return dedupe([...sel, ...add]);
  const out = sel.filter((s) => !isSelected(add, s.row, s.time));
  for (const a of add) if (!isSelected(sel, a.row, a.time)) out.push(a);
  return out;
}

function dedupe(sel: readonly KeySel[]): KeySel[] {
  const out: KeySel[] = [];
  for (const s of sel) if (!isSelected(out, s.row, s.time)) out.push({ ...s });
  return out;
}

/** The selection limited to keys that exist in the clip. */
export function liveSelection(clip: ClipData, sel: readonly KeySel[]): KeySel[] {
  return sel.filter((s) => rowKeyTimes(clip, s.row).some((t) => same(t, s.time)));
}

function rowsOf(sel: readonly KeySel[]): RowId[] {
  return [...new Set(sel.map((s) => s.row))];
}

/** Remaps every selected key's time through `mapFrame` (frames in, frames out; null drops the key). */
function remap(clip: ClipData, sel: readonly KeySel[], mapFrame: (frame: number) => number | null): { clip: ClipData; sel: KeySel[] } {
  const next = structuredClone(clip);
  const out: KeySel[] = [];
  for (const row of rowsOf(sel)) {
    const times = sel.filter((s) => s.row === row).map((s) => s.time);
    for (const ch of channels(next, row)) {
      const keys = ch.get();
      if (!keys) continue;
      const picked = keys.filter((k) => times.some((t) => same(t, k.time)));
      if (!picked.length) continue;
      const rest = keys.filter((k) => !picked.includes(k));
      const moved: Key[] = [];
      for (const k of picked) {
        const f = mapFrame(timeToFrame(next, k.time));
        if (f === null) continue;
        const t = frameTime(next, f);
        // Two keys landing on one frame: the later one (further in the original order) wins.
        // Events may share a frame (two names at one time); every other channel holds one key per frame.
        const at = ch.name === "event" ? -1 : moved.findIndex((m) => same(m.time, t));
        if (at >= 0) moved.splice(at, 1);
        moved.push({ ...k, time: t });
      }
      const merged = [...(ch.name === "event" ? rest : rest.filter((r) => !moved.some((m) => same(m.time, r.time)))), ...moved].sort((a, b) => a.time - b.time);
      ch.set(merged);
      for (const m of moved) if (!isSelected(out, row, m.time)) out.push({ row, time: m.time });
    }
  }
  return { clip: next, sel: out };
}

/** Moves the selected keys by `deltaFrames`, held inside the clip (the whole group stops at either end). */
export function moveKeys(clip: ClipData, sel: readonly KeySel[], deltaFrames: number): { clip: ClipData; sel: KeySel[] } {
  const frames = liveSelection(clip, sel).map((s) => timeToFrame(clip, s.time));
  if (!frames.length) return { clip, sel: [...sel] };
  const n = frameCount(clip);
  const d = Math.max(-Math.min(...frames), Math.min(n - Math.max(...frames), Math.round(deltaFrames)));
  if (d === 0) return { clip, sel: liveSelection(clip, sel) };
  return remap(clip, liveSelection(clip, sel), (f) => f + d);
}

/** Scales the selected keys' times about `pivotFrame` by `factor` (rounded to frames, kept inside the clip). */
export function scaleKeys(clip: ClipData, sel: readonly KeySel[], factor: number, pivotFrame: number): { clip: ClipData; sel: KeySel[] } {
  if (!(factor > 0)) return { clip, sel: [...sel] };
  const n = frameCount(clip);
  return remap(clip, liveSelection(clip, sel), (f) => Math.max(0, Math.min(n, Math.round(pivotFrame + (f - pivotFrame) * factor))));
}

/** Deletes the selected keys. */
export function deleteSelectedKeys(clip: ClipData, sel: readonly KeySel[]): ClipData {
  return remap(clip, liveSelection(clip, sel), () => null).clip;
}

/** Copied keys: each key's channel data, with its time relative to the earliest selected key. */
export interface KeyClipboard {
  entries: { row: RowId; channel: string; rel: number; key: Record<string, unknown> }[];
  frames: number;
}

export function copyKeys(clip: ClipData, sel: readonly KeySel[]): KeyClipboard | null {
  const live = liveSelection(clip, sel);
  if (!live.length) return null;
  const first = Math.min(...live.map((s) => s.time));
  const last = Math.max(...live.map((s) => s.time));
  const entries: KeyClipboard["entries"] = [];
  for (const row of rowsOf(live)) {
    const times = live.filter((s) => s.row === row).map((s) => s.time);
    for (const ch of channels(clip, row)) {
      for (const k of ch.get() ?? []) {
        if (!times.some((t) => same(t, k.time))) continue;
        const { time, ...rest } = k;
        entries.push({ row, channel: ch.name, rel: time - first, key: structuredClone(rest) });
      }
    }
  }
  return { entries, frames: Math.round((last - first) * (clip.fps ?? 30)) };
}

/** Pastes copied keys with the earliest one at `atTime` (keys landing past the end are dropped; same-frame keys are replaced). */
export function pasteKeys(clip: ClipData, board: KeyClipboard, atTime: number): { clip: ClipData; sel: KeySel[] } {
  const next = structuredClone(clip);
  const n = frameCount(next);
  const base = timeToFrame(next, atTime);
  const out: KeySel[] = [];
  const fps = clip.fps ?? 30;
  for (const e of board.entries) {
    const f = base + Math.round(e.rel * fps);
    if (f < 0 || f > n) continue;
    const t = frameTime(next, f);
    const ch = channels(next, e.row).find((c) => c.name === e.channel);
    if (!ch) continue;
    const keys = (ch.get() ?? []).filter((k) => !same(k.time, t));
    keys.push({ ...structuredClone(e.key), time: t } as Key);
    keys.sort((a, b) => a.time - b.time);
    ch.set(keys);
    if (!isSelected(out, e.row, t)) out.push({ row: e.row, time: t });
  }
  return { clip: next, sel: out };
}

/**
 * Scales the whole clip's timing: every key and the duration, by `factor` about frame 0 (the keys land on frames).
 * The result is at least one frame long.
 */
export function scaleClipTiming(clip: ClipData, factor: number): ClipData {
  if (!(factor > 0)) return clip;
  const fps = clip.fps ?? 30;
  const frames = Math.max(1, Math.round(frameCount(clip) * factor));
  const scaled = remap(clip, allKeys(clip), (f) => Math.min(frames, Math.round(f * factor))).clip;
  scaled.duration = frames / fps;
  return scaled;
}

// ---------------------------------------------------------------------------------------------
// Frame operations (Batch 6): insert / delete frames at the playhead, reverse selected keys.
// ---------------------------------------------------------------------------------------------

/**
 * Inserts `count` empty frames at `atFrame`: every key at or after that frame (all rows) moves later by `count` and the clip grows by
 * `count` frames. Keys before it stay. The result is a new clip.
 */
export function insertFrames(clip: ClipData, atFrame: number, count: number): ClipData {
  const n = Math.max(0, Math.round(count));
  const at = Math.max(0, Math.round(atFrame));
  if (!n) return clip;
  const shifted = remap(clip, allKeys(clip), (f) => (f >= at ? f + n : f)).clip;
  const fps = shifted.fps ?? 30;
  shifted.duration = (frameCount(clip) + n) / fps;
  return shifted;
}

/**
 * Deletes `count` frames starting at `atFrame`: keys inside [atFrame, atFrame + count) are removed (reported), keys after them move
 * earlier by `count`, and the clip shrinks by `count` frames (at least one frame stays).
 */
export function deleteFrames(clip: ClipData, atFrame: number, count: number): { clip: ClipData; removed: number } {
  const total = frameCount(clip);
  const at = Math.max(0, Math.round(atFrame));
  const n = Math.max(0, Math.min(Math.round(count), Math.max(0, total - 1)));
  if (!n) return { clip, removed: 0 };
  const removed = allKeys(clip).filter((k) => {
    const f = timeToFrame(clip, k.time);
    return f >= at && f < at + n;
  }).length;
  const shifted = remap(clip, allKeys(clip), (f) => (f < at ? f : f < at + n ? null : f - n)).clip;
  const fps = shifted.fps ?? 30;
  shifted.duration = Math.max(1, total - n) / fps;
  return { clip: shifted, removed };
}

const mirrorCurve = (c: unknown): unknown => {
  if (Array.isArray(c) && c.length === 4) return [1 - (c[2] as number), 1 - (c[3] as number), 1 - (c[0] as number), 1 - (c[1] as number)];
  if (c && typeof c === "object") return Object.fromEntries(Object.entries(c as Record<string, unknown>).map(([k, v]) => [k, mirrorCurve(v)]));
  return c;
};

/**
 * Reverses the selected keys in time: within each row the first selected key trades places with the last, and so on, so the motion
 * between them plays backwards. A segment's curve is mirrored with it (an ease-in becomes an ease-out). Rows with fewer than two
 * selected times are left alone. Returns the new clip and the selection (times are unchanged as a set).
 */
export function reverseKeys(clip: ClipData, sel: readonly KeySel[]): { clip: ClipData; sel: KeySel[] } {
  const live = liveSelection(clip, sel);
  const next = structuredClone(clip);
  for (const row of rowsOf(live)) {
    const times = live.filter((s) => s.row === row).map((s) => s.time).sort((a, b) => a - b);
    if (times.length < 2) continue;
    for (const ch of channels(next, row)) {
      const keys = ch.get();
      if (!keys) continue;
      const picked = keys.filter((k) => times.some((t) => same(t, k.time))).sort((a, b) => a.time - b.time);
      if (picked.length < 2) continue;
      const rest = keys.filter((k) => !picked.includes(k));
      const slots = picked.map((k) => k.time);
      const m = picked.length;
      const hasCurve = picked.some((k) => "curve" in k);
      const curves = picked.map((k) => k.curve);
      const out = picked.map((k, i) => {
        const j = m - 1 - i; // the key that now sits at slots[j]
        const copy: Key = { ...k, time: slots[j]! };
        if (hasCurve) {
          // The segment starting at the new key j was segment (m - 2 - j) of the original, played backwards.
          const from = m - 2 - j;
          if (from >= 0) copy.curve = mirrorCurve(curves[from]);
          else copy.curve = curves[m - 1];
        }
        return copy;
      });
      ch.set([...rest, ...out].sort((a, b) => a.time - b.time));
    }
  }
  return { clip: next, sel: live.map((s) => ({ ...s })) };
}
