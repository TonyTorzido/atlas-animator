/*
 * Atlas Animator editor: the audio reference track (pure, no DOM). A clip can carry one wav / mp3 as a timing reference: the
 * dopesheet shows its waveform, playback plays it in sync (at the playback speed) and scrubbing plays a short burst. The sound
 * is not part of the clip file or the project: its settings live in the data folder's clip-meta.json (per clip) and the file in
 * <data>/audio (the design notes, ).
 */

export interface AudioMeta {
  /** File name in the data folder's audio folder (`<clip>.wav` or `<clip>.mp3`). */
  file: string;
  /** The name the file had when it was loaded (shown in the track header). */
  name: string;
  /** Seconds: the audio's start sits at this clip time (negative = the sound starts before the clip). */
  offset: number;
  /** 0 to 1. */
  volume: number;
  muted: boolean;
}

export type ClipMeta = Record<string, { audio?: AudioMeta }>;

export const MAX_OFFSET = 30;
/** Peak buckets stored per second of audio. */
export const PEAKS_PER_SECOND = 200;
/** How long a scrub burst plays (seconds of audio). */
export const SCRUB_BURST = 0.09;
/** Playback drifting further than this from the playhead restarts the sound (seconds). */
export const DRIFT_LIMIT = 0.12;

export const clampVolume = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, Math.round(v * 100) / 100)) : 1);
export const clampOffset = (s: number): number => (Number.isFinite(s) ? Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(s * 1000) / 1000)) : 0);

/** The file name stored for a clip: `<clip>.wav|mp3` from the picked file's extension, or null when it is neither. */
export function audioFileName(clip: string, picked: string): string | null {
  const m = /\.(wav|mp3)$/i.exec(picked);
  return m ? `${clip}.${m[1]!.toLowerCase()}` : null;
}

/** Where in the sound a clip time falls (seconds; negative = the sound has not started). */
export const audioPosition = (clipTime: number, offset: number): number => clipTime - offset;

/** Min / max per bucket over all channels, `PEAKS_PER_SECOND` buckets per second. */
export function computePeaks(channels: readonly Float32Array[], sampleRate: number): { min: Float32Array; max: Float32Array } {
  const length = channels[0]?.length ?? 0;
  const per = Math.max(1, Math.floor(sampleRate / PEAKS_PER_SECOND));
  const n = Math.ceil(length / per);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 0;
    let hi = 0;
    for (const ch of channels) {
      const end = Math.min(length, (b + 1) * per);
      for (let i = b * per; i < end; i++) {
        const v = ch[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/** The min / max of the sound between two audio positions (seconds), 0 / 0 outside it. */
export function peakRange(p: { min: Float32Array; max: Float32Array }, from: number, to: number): { lo: number; hi: number } {
  const a = Math.max(0, Math.floor(from * PEAKS_PER_SECOND));
  const b = Math.min(p.max.length - 1, Math.max(a, Math.ceil(to * PEAKS_PER_SECOND) - 1));
  if (from >= p.max.length / PEAKS_PER_SECOND || to <= 0) return { lo: 0, hi: 0 };
  let lo = 0;
  let hi = 0;
  for (let i = a; i <= b; i++) {
    if (p.min[i]! < lo) lo = p.min[i]!;
    if (p.max[i]! > hi) hi = p.max[i]!;
  }
  return { lo, hi };
}

/** Meta read from the server, dropping anything malformed. */
export function cleanMeta(raw: unknown): ClipMeta {
  const out: ClipMeta = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, m] of Object.entries(raw as Record<string, { audio?: Partial<AudioMeta> }>)) {
    const a = m?.audio;
    if (a && typeof a.file === "string" && typeof a.name === "string") out[id] = { audio: { file: a.file, name: a.name, offset: clampOffset(Number(a.offset)), volume: clampVolume(Number(a.volume)), muted: a.muted === true } };
  }
  return out;
}
