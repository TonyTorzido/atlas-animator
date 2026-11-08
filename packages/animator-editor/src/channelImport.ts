/*
 * Atlas Animator editor: original implementation.
 *
 * Imports the beat-timed channel specs in `packages/animator/fixtures/clips/` (the Bling emote's
 * reference timeline: `channels: { bone: [{ b: beat, v: degrees }] }`, `delay` in frames) as an
 * editable `atlas-anim@1` clip. Only plain bone channels whose name is a rig bone become rotate
 * keys (offsets from setup, as the extreme-arms test reads them); procedural channels (stance,
 * bounce, `knee`, `lift_*`, `kick_*`) and `bone.prop` channels have no agreed units in the rig and
 * are listed as skipped. Walk parameter files (`period`, `swing`, ...) are not clips: the rig
 * already carries their bake (`walk_in_place`).
 */
import type { ClipData } from "@atlas-animator/core/core";
import { frameTime, parseClip } from "./clipModel.js";

export interface ChannelSpec {
  name?: string;
  bpm: number;
  beats: number;
  fps?: number;
  frames?: number;
  delay?: Record<string, number>;
  channels: Record<string, { b: number; v: number }[]>;
}

export interface ChannelImport {
  clip: ClipData;
  imported: string[];
  skipped: string[];
}

export function isChannelSpec(raw: unknown): raw is ChannelSpec {
  const r = raw as Partial<ChannelSpec> | null;
  return !!r && typeof r === "object" && typeof r.bpm === "number" && typeof r.beats === "number" && !!r.channels && typeof r.channels === "object";
}

const round = (v: number, d: number) => {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Value of a looping beat channel at beat `b` (linear between keys, wrapping past the last key). */
function valueAt(keys: readonly { b: number; v: number }[], beats: number, b: number): number {
  const k = keys.findIndex((x) => x.b > b);
  if (k <= 0) {
    const a = keys[keys.length - 1]!;
    const c = keys[0]!;
    const span = beats - a.b + c.b;
    const d = b >= a.b ? b - a.b : b + beats - a.b;
    return a.v + (c.v - a.v) * (span > 0 ? d / span : 0);
  }
  const a = keys[k - 1]!;
  const c = keys[k]!;
  return a.v + ((c.v - a.v) * (b - a.b)) / (c.b - a.b);
}

export function importChannelSpec(spec: ChannelSpec, boneNames: readonly string[]): ChannelImport {
  const fps = spec.fps ?? 30;
  const frames = spec.frames ?? Math.round((spec.beats * 60 * fps) / spec.bpm);
  const clip = parseClip({ duration: frameTime({ fps }, frames), loop: true, fps });
  const bones = new Set(boneNames);
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [name, keys] of Object.entries(spec.channels)) {
    if (!bones.has(name) || !keys.length) {
      skipped.push(name);
      continue;
    }
    // Keys on the frame grid: each beat key moves later by the channel's delay (frames) and wraps.
    const lag = spec.delay?.[name] ?? 0;
    const byFrame = new Map<number, number>();
    for (const key of keys) {
      const frame = (((Math.round((key.b / spec.beats) * frames) + lag) % frames) + frames) % frames;
      byFrame.set(frame, key.v);
    }
    // Loop seam: the clip starts and ends on the channel's value at frame 0 (delay applied).
    const startBeat = (((((0 - lag) / frames) * spec.beats) % spec.beats) + spec.beats) % spec.beats;
    const seam = valueAt(keys, spec.beats, startBeat);
    if (!byFrame.has(0)) byFrame.set(0, seam);
    byFrame.set(frames, byFrame.get(0) ?? seam);
    const rotate = [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([f, v]) => ({ time: frameTime({ fps }, f), value: round(v, 4), curve: "linear" as const }));
    clip.bones[name] = { rotate };
    imported.push(name);
  }
  return { clip, imported, skipped };
}
