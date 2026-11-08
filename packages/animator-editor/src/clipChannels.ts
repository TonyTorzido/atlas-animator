/*
 * Atlas Animator editor: original implementation.
 *
 * Every timed key array of a clip, in one list (pure): bone channels, slot attachment and colour, IK, transform-constraint mix,
 * physics mix and reset, deform, draw order and events. Retiming (fps), trimming (duration) and insert / delete frames walk this list,
 * so no channel is forgotten (). Each entry can replace its keys; an emptied continuous timeline is removed, because
 * the format rejects an empty one.
 */
import type { ClipData } from "@atlas-animator/core/core";

export type ChannelKind = "bone" | "slotAttachment" | "slotColor" | "ik" | "transform" | "path" | "physicsMix" | "physicsReset" | "deform" | "drawOrder" | "event";

export type TimedKey = { time: number } & Record<string, unknown>;

export interface TimedArray {
  /** Human label, e.g. "bone chest rotate", "transform hair_tc", "slot eyes colour". */
  label: string;
  kind: ChannelKind;
  keys: TimedKey[];
  /** Replaces the keys (sorted by the caller); an empty list removes a continuous timeline. */
  set(keys: TimedKey[]): void;
}

/** Whether a channel kind may hold several keys at one time (events), so retiming must not merge them. */
export const MULTI_AT_TIME: ReadonlySet<ChannelKind> = new Set<ChannelKind>(["event"]);

/** The largest frame rate the engine format accepts (`clipSchema.fps`). */
export const MAX_CLIP_FPS = 60;

export function timedArrays(clip: ClipData): TimedArray[] {
  const out: TimedArray[] = [];
  for (const [bone, tl] of Object.entries(clip.bones)) {
    for (const ch of ["rotate", "translate", "scale", "shear"] as const) {
      const keys = tl[ch] as unknown as TimedKey[] | undefined;
      if (!keys) continue;
      out.push({
        label: `bone ${bone} ${ch}`,
        kind: "bone",
        keys,
        set: (next) => {
          const t = clip.bones[bone];
          if (!t) return;
          if (next.length) (t as Record<string, unknown>)[ch] = next;
          else delete t[ch];
          if (!Object.keys(t).length) delete clip.bones[bone];
        }
      });
    }
  }
  for (const [slot, tl] of Object.entries(clip.slots)) {
    for (const ch of ["attachment", "color"] as const) {
      const keys = tl[ch] as unknown as TimedKey[] | undefined;
      if (!keys) continue;
      out.push({
        label: `slot ${slot} ${ch === "color" ? "colour" : "attachment"}`,
        kind: ch === "color" ? "slotColor" : "slotAttachment",
        keys,
        set: (next) => {
          const t = clip.slots[slot];
          if (!t) return;
          if (next.length) (t as Record<string, unknown>)[ch] = next;
          else delete t[ch];
          if (!t.attachment && !t.color) delete clip.slots[slot];
        }
      });
    }
  }
  for (const [name, keys] of Object.entries(clip.ik)) {
    out.push({
      label: `IK ${name}`,
      kind: "ik",
      keys: keys as unknown as TimedKey[],
      set: (next) => void (next.length ? (clip.ik[name] = next as unknown as typeof keys) : delete clip.ik[name])
    });
  }
  for (const [name, keys] of Object.entries(clip.transform)) {
    out.push({
      label: `transform ${name}`,
      kind: "transform",
      keys: keys as unknown as TimedKey[],
      set: (next) => void (next.length ? (clip.transform[name] = next as unknown as typeof keys) : delete clip.transform[name])
    });
  }
  for (const [name, keys] of Object.entries((clip as { path?: Record<string, unknown[]> }).path ?? {})) {
    out.push({
      label: `path ${name}`,
      kind: "path",
      keys: keys as unknown as TimedKey[],
      set: (next) => void (next.length ? ((clip as { path: Record<string, unknown[]> }).path[name] = next) : delete (clip as { path: Record<string, unknown[]> }).path[name])
    });
  }
  for (const [name, tl] of Object.entries(clip.physics)) {
    for (const ch of ["mix", "reset"] as const) {
      const keys = tl[ch] as unknown as TimedKey[] | undefined;
      if (!keys) continue;
      out.push({
        label: `physics ${name} ${ch}`,
        kind: ch === "mix" ? "physicsMix" : "physicsReset",
        keys,
        set: (next) => {
          const t = clip.physics[name];
          if (!t) return;
          if (next.length) (t as Record<string, unknown>)[ch] = next;
          else delete t[ch];
          if (!t.mix && !t.reset) delete clip.physics[name];
        }
      });
    }
  }
  for (const [skin, slots] of Object.entries(clip.deform)) {
    for (const [slot, atts] of Object.entries(slots)) {
      for (const [att, keys] of Object.entries(atts)) {
        out.push({
          label: `deform ${slot}/${att}`,
          kind: "deform",
          keys: keys as unknown as TimedKey[],
          set: (next) => {
            if (next.length) {
              atts[att] = next as unknown as typeof keys;
              return;
            }
            delete atts[att];
            if (!Object.keys(atts).length) delete slots[slot];
            if (!Object.keys(slots).length) delete clip.deform[skin];
          }
        });
      }
    }
  }
  out.push({ label: "draw order", kind: "drawOrder", keys: clip.drawOrder as unknown as TimedKey[], set: (next) => void (clip.drawOrder = next as unknown as ClipData["drawOrder"]) });
  out.push({ label: "events", kind: "event", keys: clip.events as unknown as TimedKey[], set: (next) => void (clip.events = next as unknown as ClipData["events"]) });
  return out;
}

/** Total number of keys over every channel. */
export function countKeys(clip: ClipData): number {
  return timedArrays(clip).reduce((n, a) => n + a.keys.length, 0);
}
