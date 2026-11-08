/*
 * Atlas Animator editor: original implementation.
 *
 * Layered animation preview, the pure parts (no DOM, no Pixi; unit tested). A preview is N tracks of the
 * runtime's own AnimationState: per track a clip, an alpha (mix weight), loop, blend mode, an optional bone
 * mask and an optional second clip crossfaded in. The preview owns its state and clock; it never touches
 * the clip being edited. Playback is deterministic: seeking back (a scrub) rebuilds the state and replays
 * from zero, seeking forward just advances it.
 */
import { AnimationLibrary, AnimationState, AnimationStateData, BoneMask, type AnimDocument, type ClipData, type MixBlend, type Skeleton } from "@atlas-animator/core/core";

export const MAX_PREVIEW_TRACKS = 8;

export type MaskPreset = "none" | "upper" | "lower" | "arms" | "custom";
export const MASK_LABELS: Record<MaskPreset, string> = { none: "Whole body", upper: "Upper body", lower: "Lower body", arms: "Arms", custom: "Custom bones" };

export interface TrackConfig {
  /** Clip name; "" leaves the track empty. */
  clip: string;
  /** Weight of the track over what is below it, 0..1. */
  alpha: number;
  loop: boolean;
  blend: MixBlend;
  timeScale: number;
  mask: MaskPreset;
  /** Bone names (and their descendants) of a "custom" mask. */
  maskBones: string[];
  /** A second clip crossfaded in after the first; "" for none. */
  then: string;
  /** Seconds at which the crossfade starts; null = when the first clip ends (its loop cycle end when looping). */
  thenAt: number | null;
  /** Crossfade seconds from the first clip to `then`. */
  crossfade: number;
}

export function defaultTrack(clip = ""): TrackConfig {
  return { clip, alpha: 1, loop: true, blend: "replace", timeScale: 1, mask: "none", maskBones: [], then: "", thenAt: null, crossfade: 0.2 };
}

const NAME_GROUPS: Record<"upper" | "lower" | "arms", RegExp> = {
  upper: /^(chest|spine_2)$/,
  lower: /^(thigh|hip|knee)/,
  arms: /^(clavicle|upper_arm)/
};

/** The bones a mask preset names (before descendants are added); empty when the rig lacks them. */
export function presetRoots(doc: Pick<AnimDocument, "bones">, preset: Exclude<MaskPreset, "none" | "custom">): string[] {
  return doc.bones.filter((b) => NAME_GROUPS[preset].test(b.name)).map((b) => b.name);
}

/** The track mask of a config: null (every bone), or the named bones with all their descendants. */
export function maskFor(doc: Pick<AnimDocument, "bones">, config: Pick<TrackConfig, "mask" | "maskBones">): BoneMask | null {
  if (config.mask === "none") return null;
  const known = new Set(doc.bones.map((b) => b.name));
  const names = (config.mask === "custom" ? config.maskBones : presetRoots(doc, config.mask)).filter((n) => known.has(n));
  if (!names.length) return null;
  return BoneMask.of(doc, names);
}

/** Names of the bones a mask lets through. */
export function maskedBoneNames(doc: Pick<AnimDocument, "bones">, mask: BoneMask | null): string[] {
  return doc.bones.filter((_, i) => !mask || mask.includes(i)).map((b) => b.name);
}

/** Compiles every clip of `clips` against `doc` into a state data, leaving the document's own animations as they were. */
export function compileClips(doc: AnimDocument, clips: Readonly<Record<string, ClipData>>): AnimationStateData {
  const own = doc.animations;
  doc.animations = { ...clips };
  try {
    return new AnimationStateData(new AnimationLibrary(doc));
  } finally {
    doc.animations = own;
  }
}

function playOptions(t: TrackConfig) {
  return { loop: t.loop, alpha: Math.max(0, Math.min(1, t.alpha)), blend: t.blend, timeScale: t.timeScale, mix: 0 };
}

/** Seconds of preview time that show every track's clips once (the loop length of the combined result). */
export function previewSpan(clips: Readonly<Record<string, ClipData>>, tracks: readonly TrackConfig[]): number {
  let span = 0;
  for (const t of tracks) {
    const a = clips[t.clip];
    if (!a) continue;
    const speed = t.timeScale > 0 ? t.timeScale : 1;
    let end = a.duration / speed;
    const b = t.then ? clips[t.then] : undefined;
    if (b) end = Math.max(end, (t.thenAt ?? a.duration / speed) + t.crossfade + b.duration / speed);
    span = Math.max(span, end);
  }
  return span;
}

/** A running layered preview of one rig document. */
export class TrackSession {
  private data: AnimationStateData;
  private state: AnimationState | null = null;
  private at = 0;
  private dirty = true;

  constructor(
    private readonly doc: AnimDocument,
    private clips: Record<string, ClipData>,
    private tracks: TrackConfig[]
  ) {
    this.data = compileClips(doc, clips);
  }

  /** The clips changed (an edit, another outfit): recompile and replay from the same time. */
  setClips(clips: Record<string, ClipData>): void {
    this.clips = clips;
    this.data = compileClips(this.doc, clips);
    this.dirty = true;
  }

  setTracks(tracks: TrackConfig[]): void {
    this.tracks = tracks;
    this.dirty = true;
  }

  get span(): number {
    return previewSpan(this.clips, this.tracks);
  }

  get time(): number {
    return this.at;
  }

  private build(): AnimationState {
    const state = new AnimationState(this.data);
    this.tracks.slice(0, MAX_PREVIEW_TRACKS).forEach((t, i) => {
      if (!t.clip || !this.clips[t.clip]) return;
      state.setAnimation(i, t.clip, playOptions(t));
      state.setTrackMask(i, maskFor(this.doc, t));
      if (t.then && this.clips[t.then]) {
        const opts = { ...playOptions(t), mix: Math.max(0, t.crossfade) };
        state.addAnimation(i, t.then, t.thenAt === null ? opts : { ...opts, delay: t.thenAt });
      }
    });
    return state;
  }

  /** Moves the preview clock to `t` seconds (forward: advance; backward or after a change: replay from zero). */
  seek(t: number): void {
    const target = Math.max(0, t);
    if (this.dirty || !this.state || target < this.at) {
      this.state = this.build();
      this.at = 0;
      this.dirty = false;
    }
    // Replay in steps no longer than a frame at 30 fps so queued crossfades start on time.
    let left = target - this.at;
    while (left > 1e-9) {
      const step = Math.min(left, 1 / 30);
      this.state.update(step);
      left -= step;
    }
    this.at = target;
  }

  /** Poses `skeleton` (built from this session's document) with the combined result. */
  apply(skeleton: Skeleton): void {
    if (!this.state || this.dirty) this.seek(this.at);
    this.state!.apply(skeleton);
  }
}
