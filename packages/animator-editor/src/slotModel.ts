/*
 * Atlas Animator editor: original implementation.
 *
 * Slot edits on the clip (pure, like clipModel.ts): attachment swaps (`slots.<slot>.attachment` keys,
 * stepped: a key shows its placeholder from its time on, `null` hides the slot) and draw order keys
 * (`drawOrder[]`, each key lists slot offsets from the setup order and holds until the next key).
 */
import type { ClipData } from "@atlas-animator/core/core";
import { KEY_EPSILON, snapTime } from "./clipModel.js";

export type DrawOffset = { slot: string; offset: number };

const clone = (clip: ClipData): ClipData => structuredClone(clip);
const same = (a: number, b: number) => Math.abs(a - b) < KEY_EPSILON;

/** The swap key of `slot` exactly at `time`, if any. */
export function attachmentKeyAt(clip: ClipData, slot: string, time: number): { time: number; name: string | null } | undefined {
  return clip.slots[slot]?.attachment?.find((k) => same(k.time, time));
}

/** The placeholder the clip shows in `slot` at `time` (the last swap key at or before it), or undefined before the first key. */
export function attachmentAt(clip: ClipData, slot: string, time: number): string | null | undefined {
  let out: string | null | undefined;
  for (const k of clip.slots[slot]?.attachment ?? []) if (k.time <= time + KEY_EPSILON) out = k.name;
  return out;
}

/** Sets (inserts or replaces) the swap key of `slot` at `time`; `name` null hides the slot. */
export function setAttachmentKey(clip: ClipData, slot: string, time: number, name: string | null): ClipData {
  const next = clone(clip);
  const t = snapTime(next, time);
  const timelines = (next.slots[slot] ??= {});
  const keys = (timelines.attachment ??= []);
  const at = keys.findIndex((k) => same(k.time, t));
  if (at >= 0) keys[at] = { time: keys[at]!.time, name };
  else keys.push({ time: t, name });
  keys.sort((a, b) => a.time - b.time);
  return next;
}

/** Removes the swap key of `slot` at `time`; an empty slot entry goes with it. */
export function deleteAttachmentKey(clip: ClipData, slot: string, time: number): ClipData {
  const next = clone(clip);
  const timelines = next.slots[slot];
  if (!timelines?.attachment) return next;
  const kept = timelines.attachment.filter((k) => !same(k.time, time));
  if (kept.length) timelines.attachment = kept;
  else delete timelines.attachment;
  if (!timelines.attachment && !timelines.color) delete next.slots[slot];
  return next;
}

/** The draw order offsets in force at `time`: the last draw order key at or before it, or none. */
export function drawOrderAt(clip: ClipData, time: number): DrawOffset[] {
  let out: DrawOffset[] = [];
  for (const k of clip.drawOrder) if (k.time <= time + KEY_EPSILON) out = k.offsets;
  return out.map((o) => ({ ...o }));
}

/** The draw order key exactly at `time`, if any. */
export function drawOrderKeyAt(clip: ClipData, time: number): { time: number; offsets: DrawOffset[] } | undefined {
  return clip.drawOrder.find((k) => same(k.time, time));
}

/**
 * Keys `slot` at `offset` places from its setup order at `time`. The key starts from the offsets already
 * in force (so earlier moves hold), then this slot's entry is replaced (0 removes it).
 */
export function setDrawOrderOffset(clip: ClipData, time: number, slot: string, offset: number): ClipData {
  const next = clone(clip);
  const t = snapTime(next, time);
  const base = drawOrderAt(next, t);
  const offsets = base.filter((o) => o.slot !== slot);
  if (offset !== 0) offsets.push({ slot, offset });
  const at = next.drawOrder.findIndex((k) => same(k.time, t));
  if (at >= 0) next.drawOrder[at] = { time: next.drawOrder[at]!.time, offsets };
  else next.drawOrder.push({ time: t, offsets });
  next.drawOrder.sort((a, b) => a.time - b.time);
  return next;
}

export function deleteDrawOrderKey(clip: ClipData, time: number): ClipData {
  const next = clone(clip);
  next.drawOrder = next.drawOrder.filter((k) => !same(k.time, time));
  return next;
}

/** Writes the draw order key at `time` as exactly `offsets` (replacing the key there, ignoring earlier keys): a named state. */
export function setDrawOrderKey(clip: ClipData, time: number, offsets: readonly DrawOffset[]): ClipData {
  const next = clone(clip);
  const t = snapTime(next, time);
  const key = { time: t, offsets: offsets.map((o) => ({ ...o })) };
  const at = next.drawOrder.findIndex((k) => same(k.time, t));
  if (at >= 0) next.drawOrder[at] = { time: next.drawOrder[at]!.time, offsets: key.offsets };
  else next.drawOrder.push(key);
  next.drawOrder.sort((a, b) => a.time - b.time);
  return next;
}
