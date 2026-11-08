/*
 * Atlas Animator: original implementation.
 *
 * AnimationState: plays clips on tracks and mixes them into a skeleton's pose.
 *
 * Tracks. Track 0 is applied first, then track 1 on top, and so on (the game uses 0 for
 * locomotion, 1 for masked upper-body actions, 2 for additive flinches, 3 for wings). A track has
 * one current entry, a queue of entries waiting to start, and an optional bone mask: properties
 * of bones outside the mask (and of slots, meshes and constraints on those bones) are not touched
 * by that track.
 *
 * The pose is a function of the state. apply() first resets the skeleton to its setup pose,
 * then applies every track. So nothing an earlier frame wrote can leak into this one, and an
 * entry that keys a property only partly (alpha < 1, a fade) blends against a defined base:
 * the setup pose on track 0, the result of the tracks below on higher tracks. Game code that
 * adjusts the pose procedurally does so after apply() and before updateWorldTransform().
 *
 * Mixing model (per property; our own formulation). An entry E is an operator on a property's
 * value x (the value below the track):
 *
 *   own_E(x) = x                                   if E's clip does not key the property
 *            = replace: x -> keyed value by alpha  (see the value rules in timelines.ts)
 *            = add:     x + key offset * alpha
 *
 * A crossfade from an older chain C into a newer entry E with mix fraction m (mix time / mix
 * duration, 0..1) gives
 *
 *   chain_E(x) = lerp(chain_C(x), own_E(base), m),   base = chain_C(x) if E.holdPrevious, else x.
 *
 * A chain is applied oldest first, so A -> B -> C (C interrupting B while B still fades in from
 * A) nests naturally, and each entry's own mix keeps advancing. Consequences:
 * - a property both clips key moves from A's value to B's value;
 * - a property only the old clip keys fades back to the pose below the track; only the new clip
 *   keys it, it fades in from that pose;
 * - holdPrevious keeps the old clip's values at full weight under the new one for properties the
 *   new clip does not key (until the mix ends and the old entry is dropped);
 * - an "add" entry fading out (mix into the empty clip) fades its offset out.
 * When the newest mix reaches 1 the older entries contribute nothing (unless holdPrevious) and
 * are dropped on the next update with an `end` event.
 *
 * Rotations take the short way round, and stay on the side they started on: every angular blend
 * (alpha blend and crossfade) remembers its last unwrapped difference per entry and bone, and a
 * new difference is unwrapped to the equivalent closest to the last one. So a crossfade whose
 * shortest path would flip from +179 to -179 degrees mid-mix keeps turning the same way.
 *
 * Discrete properties (attachments, IK flags, draw order) switch: an entry takes the decision
 * only when it has a key in effect for the property (alpha > 0, at or after its first key); the
 * oldest entry decides at once, newer ones once their mix fraction reaches their
 * `discreteThreshold` (default 0: immediately). An entry that does not key the property (or is
 * before its first key) leaves the older chain's decision in place until that chain is dropped;
 * then the pose below (the setup value on track 0) applies.
 *
 * Time. update(dt) advances every entry by dt * state.timeScale * entry.timeScale and every mix
 * by dt * state.timeScale. hitstop(ms) freezes the whole state for exactly that much real time:
 * the frozen part of a dt is consumed first and the rest advances normally. Queued entries start
 * exactly when the entry before them reaches their delay; the overshoot is carried into the new
 * entry, so timing does not depend on the frame rate.
 *
 * Events. Each update scans the half-open track-time range (last, now] of an entry. An event key
 * at clip time t fires at track times t + n * duration (n >= 0) for looping entries and at t
 * otherwise, so every key fires exactly once per pass, across loop wraps, including keys at 0 and
 * at the duration, independent of frame boundaries. `complete` fires at the end of every loop
 * cycle (or once when a non-looping clip reaches its end), ordered with the events. The current
 * entry fires events; an entry being mixed out fires a key only if the newer entry's mix fraction,
 * at the moment the old entry reaches that key, is at or below the old entry's `eventThreshold`
 * (default 0: never). Eligibility is computed at the key's own position within the fade, so it does
 * not depend on how the elapsed time is split into updates (F5). Boundary rule: the old entry's key at track time t fires iff t <= T_b + EVENT_EPSILON, where T_b is
 * the old entry's track time when the newer mix reaches the threshold, computed in the step where
 * that happens (it may round past the old entry's own track time; the window then extends to it,
 * and the next scan starts after it, so a key fires once and none later than the epsilon). Physics reset keys follow the
 * same rule and become reset requests on the skeleton at the next apply().
 *
 * Callbacks (start, interrupt, end, complete, event) are queued while the state changes and
 * dispatched at the end of the public call that caused them (update, setAnimation, ...), entry
 * listener first, then state listeners. A listener may call back into the state; nested calls
 * queue and the outer dispatch delivers them in order.
 *
 * Allocation: update() and apply() allocate nothing in steady state. Starting entries
 * (setAnimation, addAnimation, a queued entry starting) allocates the entry and, on the next
 * apply(), the track's mixing plan.
 */
import type { AnimDocument } from "./format.js";
import type { Skeleton } from "./skeleton.js";
import {
  AnimationLibrary,
  animationLibraryFor,
  type AnimationDocument,
  type AnimationEvent,
  type Clip,
  type ContinuousProperty,
  type ContinuousTimeline,
  type DiscreteProperty,
  type DiscreteTimeline
} from "./timelines.js";

export type MixBlend = "replace" | "add";

/** Highest track index + 1. */
export const MAX_TRACKS = 8;
/**
 * Longest crossfade chain per track. Interrupting faster than mixes finish grows the chain; past
 * this many entries the oldest is dropped (a last resort; its weight is already the smallest).
 */
/**
 * Seconds of float tolerance at the outgoing-event boundary (item 6): a key this close past the
 * boundary still fires (summed frame times round), anything later never does.
 */
export const EVENT_EPSILON = 1e-9;

export const MAX_MIX_CHAIN = 4;
/** Pose-signature doubles per entry: serial, alpha, discreteThreshold, sampled clip time, mix. */
const SIG_PER_ENTRY = 5;

export interface AnimationStateListener {
  /** The entry became the track's current entry. */
  start?(entry: TrackEntry): void;
  /** Another entry replaced this one as current (it may still be mixing out). */
  interrupt?(entry: TrackEntry): void;
  /** The entry will never be applied again. */
  end?(entry: TrackEntry): void;
  /** A loop cycle finished, or a non-looping clip reached its end. */
  complete?(entry: TrackEntry): void;
  event?(entry: TrackEntry, event: AnimationEvent): void;
}

export interface PlayOptions {
  /** Default: the clip's own `loop`. */
  loop?: boolean;
  /** Crossfade seconds from the entry it replaces. Default: AnimationStateData's mix table. */
  mix?: number;
  /** Weight of the entry, 0..1. Default 1. */
  alpha?: number;
  /** Default "replace". */
  blend?: MixBlend;
  /** Keep the previous entry at full weight under this one while mixing. Default false. */
  holdPrevious?: boolean;
  /** Playback speed of this entry. Default 1. */
  timeScale?: number;
  /** While being mixed out, fire events until the newer entry's mix reaches this. Default 0. */
  eventThreshold?: number;
  /** Mix fraction at which this entry's discrete keys take over from the older chain. Default 0. */
  discreteThreshold?: number;
  listener?: AnimationStateListener;
}

export interface QueueOptions extends PlayOptions {
  /**
   * When to start, in seconds of the previous entry's track time from its start (finite, >= 0).
   * Default: so the mix (real, state-scaled seconds) ends when the previous entry ends (its clip
   * end, or the end of its current loop cycle when queued), at whatever speed the previous entry
   * plays when it gets there (runtime contract F8).
   */
  delay?: number;
}

/** Mix durations between clips, and the compiled clips of one document. */
export class AnimationStateData {
  readonly library: AnimationLibrary;
  private defaultMixSeconds = 0;
  private readonly mixes = new Map<string, number>();

  constructor(source: AnimationDocument | AnimationLibrary) {
    this.library = source instanceof AnimationLibrary ? source : animationLibraryFor(source);
  }

  /** Crossfade seconds where no pair is set (finite, >= 0). */
  get defaultMix(): number {
    return this.defaultMixSeconds;
  }

  set defaultMix(seconds: number) {
    this.defaultMixSeconds = checkSeconds("defaultMix", seconds);
  }

  setMix(from: string, to: string, seconds: number): void {
    this.library.get(from);
    this.library.get(to);
    this.mixes.set(`${from} ${to}`, checkSeconds(`mix ${from} -> ${to}`, seconds));
  }

  getMix(from: Clip, to: Clip): number {
    return this.mixes.get(`${from.name} ${to.name}`) ?? this.defaultMixSeconds;
  }
}

/** Which bones a track may animate. */
export class BoneMask {
  /** Per bone index: 1 when included. */
  readonly bones: Uint8Array;

  constructor(bones: Uint8Array) {
    this.bones = bones;
  }

  /**
   * A mask of the named bones, by default with all their descendants (`upper_body` = chest and
   * everything below it).
   */
  static of(doc: Pick<AnimDocument, "bones">, names: readonly string[], options: { descendants?: boolean } = {}): BoneMask {
    const index = new Map(doc.bones.map((bone, i) => [bone.name, i] as const));
    const bones = new Uint8Array(doc.bones.length);
    for (const name of names) {
      const i = index.get(name);
      if (i === undefined) throw new Error(`bone mask: unknown bone '${name}'`);
      bones[i] = 1;
    }
    if (options.descendants ?? true) {
      // Bones are listed parents-first, so one pass propagates down the hierarchy.
      doc.bones.forEach((bone, i) => {
        if (bone.parent !== undefined && bones[index.get(bone.parent) as number] === 1) bones[i] = 1;
      });
    }
    return new BoneMask(bones);
  }

  /** Every bone this mask leaves out. */
  inverted(): BoneMask {
    return new BoneMask(this.bones.map((included) => (included === 1 ? 0 : 1)));
  }

  includes(bone: number): boolean {
    return bone < 0 || this.bones[bone] === 1;
  }
}

/** One clip playing (or queued, or mixing out) on a track. */
let entrySerial = 0;

/** Held-frame phase slots (AnimationState.heldPhase): 30 fps clips on a 60 Hz display refresh half the crowd per frame. */
export const HELD_PHASES = 2;

/**
 * The held phase of a character with id or instance seed `seed`: a hash of the seed
 * onto the HELD_PHASES slots, so a character keeps its phase across reloads, clients and creation
 * order (no module-global counter). A crowd with distinct seeds splits about evenly.
 */
export function heldPhaseForSeed(seed: number | string): number {
  let h: number;
  if (typeof seed === "number" && Number.isInteger(seed)) {
    h = seed | 0;
  } else {
    // FNV-1a over the UTF-16 code units of the string form.
    const text = String(seed);
    h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  // fmix32 (avalanche), so consecutive ids land on unrelated slots.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) % HELD_PHASES) / HELD_PHASES;
}

export interface AnimationStateOptions {
  /** Character id or instance seed: heldPhase = heldPhaseForSeed(phaseSeed). */
  phaseSeed?: number | string;
  /** Explicit held phase in [0, 1) (wins over phaseSeed); 0 lines held frames up with the clock (attack cadences). */
  heldPhase?: number;
}

/** Development asserts: on under Node unless NODE_ENV is "production" (tests, tools); off in browser builds. */
const DEV_ASSERTS = (() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env !== undefined && env.NODE_ENV !== "production";
})();

/** Small offset so a frame time computed as k / fps lands in frame k despite rounding. */
const HELD_EPSILON = 1e-6;

/**
 * Clip time of the frame the held-frame cache displays at `trackTime`: frame
 * k = floor(trackTime * fps) shows clip time k / fps (wrapped for a loop); a non-looping clip
 * shows its end pose once the track time reaches the duration. Mirrors the validator's
 * displayedFrameTimes, so every displayed pose is a certified one.
 */
export function heldClipTime(trackTime: number, duration: number, loop: boolean, fps: number, phase = 0): number {
  if (duration <= 0) return 0;
  if (!loop && trackTime >= duration) return duration;
  const t = Math.floor(trackTime * fps + phase + HELD_EPSILON) / fps;
  if (loop) return t % duration;
  return t < duration ? t : duration;
}

/** Crossfade fraction on the newer entry's 1 / fps grid (held-frame playback). */
function heldMix(entry: TrackEntry, phase: number): number {
  if (entry._mixDuration <= 0) return 1;
  const fps = entry.clip.fps;
  const m = Math.floor(entry.mixTime * fps + phase + HELD_EPSILON) / fps / entry._mixDuration;
  return m < 1 ? m : 1;
}

export class TrackEntry {
  /** Unique per entry (pose cache identity). */
  readonly serial = ++entrySerial;
  readonly track: number;
  readonly clip: Clip;
  loop: boolean;
  readonly blend: MixBlend;
  readonly holdPrevious: boolean;
  listener: AnimationStateListener | null;
  /** @internal Backing fields of the validated controls below (read directly on the hot path). */
  _alpha = 1;
  /** @internal */
  _timeScale = 1;
  /** @internal */
  _eventThreshold = 0;
  /** @internal */
  _discreteThreshold = 0;
  /** @internal */
  _mixDuration = 0;
  /** Seconds mixed so far. */
  mixTime = 0;
  /** Seconds this entry has played (scaled by its timeScale), unbounded across loops. */
  trackTime = 0;
  /**
   * Queued entries: start when the previous entry's track time reaches this (track-time units of
   * the previous entry). For an automatic delay it is refreshed every update from the previous
   * entry's current speed (see autoEnd).
   */
  delay = 0;
  /**
   * @internal Automatic delay (QueueOptions.delay omitted): the previous entry's track time at which
   * it ends; NaN for an explicit delay. Mix durations are real (state-scaled) seconds and the
   * previous entry covers mixDuration * its timeScale of track time during the fade, so
   * delay = autoEnd - mixDuration * previous.timeScale (F8).
   */
  autoEnd = Number.NaN;
  /** The track clears itself when the entry reaches this track time (empty-clip fades). */
  trackEnd = Number.POSITIVE_INFINITY;
  /** The older entry this one is mixing from. */
  mixingFrom: TrackEntry | null = null;
  /** The newer entry this one is mixing into. */
  mixingTo: TrackEntry | null = null;
  /** The entry queued after this one. */
  next: TrackEntry | null = null;

  /** @internal Exclusive lower bound of the next event scan (-1: from the start). */
  eventsFrom = -1;
  /** @internal True once apply() used this entry. */
  applied = false;
  /** @internal True once the entry ended (or was dropped from the queue). */
  ended = false;
  /** @internal Per bone: last unwrapped rotation difference of the alpha blend [2b] and the crossfade [2b + 1]. */
  readonly rotationMemory: Float64Array;

  constructor(track: number, clip: Clip, options: PlayOptions, mixDuration: number, boneCount: number) {
    this.track = track;
    this.clip = clip;
    this.loop = options.loop ?? clip.loop;
    this.alpha = options.alpha ?? 1;
    this.blend = options.blend ?? "replace";
    this.holdPrevious = options.holdPrevious ?? false;
    this.timeScale = options.timeScale ?? 1;
    this.eventThreshold = options.eventThreshold ?? 0;
    this.discreteThreshold = options.discreteThreshold ?? 0;
    this.listener = options.listener ?? null;
    this.mixDuration = mixDuration;
    this.rotationMemory = new Float64Array(boneCount * 2).fill(Number.NaN);
  }

  /** Weight of the entry, 0..1. */
  get alpha(): number {
    return this._alpha;
  }

  set alpha(value: number) {
    this._alpha = checkUnit("alpha", value);
  }

  /**
   * Playback speed of this entry: finite and >= 0 (0 holds the clip time; there is no reverse
   * playback, so negative speeds are rejected: runtime contract F4).
   */
  get timeScale(): number {
    return this._timeScale;
  }

  set timeScale(value: number) {
    this._timeScale = checkSpeed("entry timeScale", value);
  }

  /** While being mixed out, fire events until the newer entry's mix reaches this (0..1). */
  get eventThreshold(): number {
    return this._eventThreshold;
  }

  set eventThreshold(value: number) {
    this._eventThreshold = checkUnit("eventThreshold", value);
  }

  /** Mix fraction (0..1) at which this entry's discrete keys take over from the older chain. */
  get discreteThreshold(): number {
    return this._discreteThreshold;
  }

  set discreteThreshold(value: number) {
    this._discreteThreshold = checkUnit("discreteThreshold", value);
  }

  /** Crossfade seconds from the entry this one replaced (finite, >= 0). */
  get mixDuration(): number {
    return this._mixDuration;
  }

  set mixDuration(value: number) {
    this._mixDuration = checkSeconds("mixDuration", value);
  }

  /** Clip time the entry is at (looped, or held at the end). */
  get animationTime(): number {
    const duration = this.clip.duration;
    if (duration <= 0) return 0;
    if (this.loop) return this.trackTime % duration;
    return this.trackTime < duration ? this.trackTime : duration;
  }

  /** Crossfade progress 0..1 (1 when not mixing). */
  get mixFraction(): number {
    if (this.mixDuration <= 0) return 1;
    const m = this.mixTime / this.mixDuration;
    return m < 1 ? m : 1;
  }

  /** True once a non-looping clip has reached its end. */
  get isComplete(): boolean {
    return !this.loop && this.trackTime >= this.clip.duration;
  }
}

/** Callback kinds in the queue. */
const QueueType = { Start: 0, Interrupt: 1, End: 2, Complete: 3, Event: 4 } as const;
type QueueType = (typeof QueueType)[keyof typeof QueueType];

/** The mixing plan of one track: the chain and every property its clips key. */
class TrackPlan {
  readonly levels: TrackEntry[];
  readonly continuous: ContinuousProperty[] = [];
  /** continuous.length x levels.length, row per property. */
  readonly continuousTimelines: (ContinuousTimeline | null)[] = [];
  readonly discrete: DiscreteProperty[] = [];
  readonly discreteTimelines: (DiscreteTimeline | null)[] = [];
  readonly clipTime: Float64Array;
  readonly mix: Float64Array;

  constructor(current: TrackEntry, mask: BoneMask | null) {
    const levels: TrackEntry[] = [];
    for (let entry: TrackEntry | null = current; entry; entry = entry.mixingFrom) levels.unshift(entry);
    this.levels = levels;
    const count = levels.length;
    this.clipTime = new Float64Array(count);
    this.mix = new Float64Array(count);

    const continuousRow = new Map<number, number>();
    const discreteRow = new Map<number, number>();
    levels.forEach((entry, level) => {
      for (const timeline of entry.clip.continuous) {
        const property = timeline.property;
        if (mask && !mask.includes(property.maskBone)) continue;
        let row = continuousRow.get(property.id);
        if (row === undefined) {
          row = this.continuous.length;
          continuousRow.set(property.id, row);
          this.continuous.push(property);
          for (let k = 0; k < count; k++) this.continuousTimelines.push(null);
        }
        this.continuousTimelines[row * count + level] = timeline;
      }
      for (const timeline of entry.clip.discrete) {
        const property = timeline.property;
        if (mask && !mask.includes(property.maskBone)) continue;
        let row = discreteRow.get(property.id);
        if (row === undefined) {
          row = this.discrete.length;
          discreteRow.set(property.id, row);
          this.discrete.push(property);
          for (let k = 0; k < count; k++) this.discreteTimelines.push(null);
        }
        this.discreteTimelines[row * count + level] = timeline;
      }
    });
  }
}

class Track {
  current: TrackEntry | null = null;
  mask: BoneMask | null = null;
  plan: TrackPlan | null = null;
  dirty = true;
}

export class AnimationState {
  readonly data: AnimationStateData;
  private speed = 1;
  /**
   * Held-frame playback. When true, apply() samples every entry at its displayed frame
   * (heldClipTime) and steps crossfade fractions on the same 1 / fps grid, so the pose is a function
   * of `poseVersion`: AnimatorCharacter.updateHeld skips all pose work while it is unchanged.
   * False (default, for tools and tests): exact continuous sampling.
   */
  heldFrames = false;
  /**
   * Where this state's held frames switch, as a fraction of a held frame in [0, 1) (
   * iPhone run 1: 50 characters switching on the same display frame spiked CPU). The switch from
   * frame k to k + 1 happens `heldPhase` of a frame early; every displayed pose is still a frame
   * k / fps of the clip (certified) and shown for exactly 1 / fps, so only the work moves.
   * Deterministic per character: options.heldPhase, else heldPhaseForSeed(options.phaseSeed) (0 or
   * 1/2 at the default 30 fps on 60 Hz: half of a seeded crowd refreshes on each display frame),
   * else 0. Force 0 (option or assignment) where poses must line up with a clock, e.g. an attack
   * cadence. A phase-1/2 state shows frame 0 for only 1/60 s on every new entry (the switch to
   * frame 1 comes half a frame early); the displayed frame leads the clip time, and events, by at
   * most 1 / 60 s, so VFX synced to the displayed frame use heldClipTime(..., heldPhase).
   */
  heldPhase: number;

  private structureVersion = 0;
  /** Counts physics reset requests queued by update(); part of the pose signature (F2). */
  private resetSerial = 0;
  private version = 0;
  private signatureLength = -1;
  private signatureChanged = false;
  private readonly signature = new Float64Array(MAX_TRACKS * (MAX_MIX_CHAIN + 2) * SIG_PER_ENTRY + 8);

  private readonly tracks: Track[] = [];
  private readonly listeners: AnimationStateListener[] = [];
  private hitstopLeft = 0;
  private readonly boneCount: number;
  private readonly pendingResets: Uint8Array;

  // Event queue (records reused; grows to the largest burst, then stays).
  private queueTypes: QueueType[] = [];
  private queueEntries: (TrackEntry | null)[] = [];
  private queueEvents: (AnimationEvent | null)[] = [];
  private queueLength = 0;
  private draining = false;

  /**
   * Numbers handed between the per-frame methods. Doubles passed as arguments to (or returned
   * from) calls the engine does not inline are boxed on the heap; through this array they are
   * not, which keeps update() and apply() allocation-free (src/pixi/allocation.test.ts).
   */
  private readonly num = new Float64Array(NUM_SLOTS);

  // Mixing scratch: value below the track, chain result, entry result, sampled key, setup.
  private readonly x: Float64Array;
  private readonly result: Float64Array;
  private readonly own: Float64Array;
  private readonly sampled: Float64Array;
  private readonly setup: Float64Array;

  constructor(data: AnimationStateData, options: AnimationStateOptions = {}) {
    this.data = data;
    this.heldPhase = options.heldPhase ?? (options.phaseSeed === undefined ? 0 : heldPhaseForSeed(options.phaseSeed));
    const doc = data.library.document;
    this.boneCount = doc.bones.length;
    this.pendingResets = new Uint8Array(doc.physics.length);
    const n = data.library.properties.maxChannels;
    this.x = new Float64Array(n);
    this.result = new Float64Array(n);
    this.own = new Float64Array(n);
    this.sampled = new Float64Array(n);
    this.setup = new Float64Array(n);
  }

  /** Speed of the whole state (after hitstop): finite and >= 0 (runtime contract F4). */
  get timeScale(): number {
    return this.speed;
  }

  set timeScale(value: number) {
    this.speed = checkSpeed("state timeScale", value);
  }

  // -------------------------------------------------------------------------------------------
  // Playback control
  // -------------------------------------------------------------------------------------------

  /** Plays `clip` on `track` now, crossfading from whatever plays there. Clears the track's queue. */
  setAnimation(track: number, clip: string | Clip, options: PlayOptions = {}): TrackEntry {
    const entry = this.setInternal(track, this.clipOf(clip), options);
    this.drain();
    return entry;
  }

  /** Queues `clip` after the last entry of `track` (plays now when the track is empty and no delay is given). */
  addAnimation(track: number, clip: string | Clip, options: QueueOptions = {}): TrackEntry {
    const entry = this.addInternal(track, this.clipOf(clip), options);
    this.drain();
    return entry;
  }

  /** Fades `track` out over `mix` seconds (to the pose below it), then clears it. */
  setEmptyAnimation(track: number, mix: number): TrackEntry {
    const entry = this.setInternal(track, this.data.library.empty, { mix });
    entry.trackEnd = mix;
    this.drain();
    return entry;
  }

  /** Queues a fade-out of `track` over `mix` seconds (by default ending when the previous entry ends). */
  addEmptyAnimation(track: number, mix: number, delay?: number): TrackEntry {
    const entry = this.addInternal(track, this.data.library.empty, delay === undefined ? { mix } : { mix, delay });
    entry.trackEnd = mix;
    this.drain();
    return entry;
  }

  /** Stops `track` at once (its properties return to the pose below on the next apply). */
  clearTrack(track: number): void {
    this.structureVersion++;
    const t = this.tracks[track];
    if (!t?.current) return;
    this.dropQueue(t.current);
    this.endChain(t.current);
    t.current = null;
    t.dirty = true;
    this.drain();
  }

  clearTracks(): void {
    this.structureVersion++;
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (!t?.current) continue;
      this.dropQueue(t.current);
      this.endChain(t.current);
      t.current = null;
      t.dirty = true;
    }
    this.drain();
  }

  getCurrent(track: number): TrackEntry | null {
    return this.tracks[track]?.current ?? null;
  }

  /** Restricts `track` to the bones of `mask` (null = every bone). */
  setTrackMask(track: number, mask: BoneMask | null): void {
    this.structureVersion++;
    const t = this.trackAt(track);
    if (mask && mask.bones.length !== this.boneCount) throw new Error(`bone mask has ${mask.bones.length} bones; the rig has ${this.boneCount}`);
    t.mask = mask;
    t.dirty = true;
  }

  getTrackMask(track: number): BoneMask | null {
    return this.tracks[track]?.mask ?? null;
  }

  /**
   * Freezes every track (clip time, mixes, events) for `ms` milliseconds of real time. A call
   * during a hitstop extends it to whichever ends later; it never stacks.
   */
  hitstop(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error(`hitstop ms must be a finite number (got ${ms})`);
    if (!(ms > 0)) return;
    this.hitstopLeft = Math.max(this.hitstopLeft, ms / 1000);
  }

  /** Milliseconds of hitstop left. */
  get hitstopRemaining(): number {
    return this.hitstopLeft * 1000;
  }

  addListener(listener: AnimationStateListener): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  removeListener(listener: AnimationStateListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  // -------------------------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------------------------

  /**
   * Changes whenever the pose apply() would produce changes: entries, their sampled clip times
   * (held frames when heldFrames is on), crossfade fractions, alphas, discrete thresholds and track
   * masks, and physics reset keys passed since the last apply(). Physics progression and
   * procedural changes made outside this state are not covered (AnimatorCharacter checks
   * Skeleton.physicsSettled; procedural edits use onAfterApply / invalidate).
   * Allocation-free.
   */
  get poseVersion(): number {
    const held = this.heldFrames;
    this.signatureChanged = false;
    let n = this.sigPut(0, this.structureVersion);
    // A reset key passed since the last apply() must reach the skeleton even when the sampled pose
    // is unchanged (a reset between two held frames): count it as a pose change (F2).
    n = this.sigPut(n, this.resetSerial);
    for (let i = 0; i < this.tracks.length; i++) {
      let entry = (this.tracks[i] as Track).current;
      if (!entry) continue;
      n = this.sigPut(n, i);
      // Newest first: the current entry, then the chain it mixes from.
      while (entry) {
        n = this.sigPut(n, entry.serial);
        n = this.sigPut(n, entry._alpha);
        // Mutable: decides which entry's attachments / IK flags / draw order win mid-crossfade.
        n = this.sigPut(n, entry._discreteThreshold);
        n = this.sigPut(n, held ? heldClipTime(entry.trackTime, entry.clip.duration, entry.loop, entry.clip.fps, this.heldPhase) : entry.animationTime);
        n = this.sigPut(n, held ? heldMix(entry, this.heldPhase) : entry.mixFraction);
        entry = entry.mixingFrom;
      }
    }
    if (n !== this.signatureLength) {
      this.signatureLength = n;
      this.signatureChanged = true;
    }
    if (this.signatureChanged) this.version++;
    return this.version;
  }

  private sigPut(n: number, value: number): number {
    const sig = this.signature;
    if (n < sig.length) {
      if (sig[n] !== value) {
        sig[n] = value;
        this.signatureChanged = true;
      }
    } else {
      // Past the signature (cannot happen within MAX_TRACKS and MAX_MIX_CHAIN): a value that is
      // not stored cannot be compared, so count it as a change (a miss, never a stale pose).
      if (DEV_ASSERTS) throw new Error(`AnimationState pose signature overflow: write ${n} past ${sig.length} doubles`);
      this.signatureChanged = true;
    }
    return n + 1;
  }

  /**
   * Advances time by `delta` seconds of real time and dispatches the callbacks that caused.
   * `delta` must be finite (NaN and infinities throw); a negative delta counts as 0. A large
   * finite delta is consumed in full, not clamped (runtime contract, "Large deltas"): queued
   * entries start in order, every event key in the last 1000 loop cycles of each entry fires, and
   * older cycles' events are dropped.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta)) throw new Error(`AnimationState.update: delta must be a finite number of seconds (got ${delta})`);
    let dt = delta > 0 ? delta : 0;
    if (this.hitstopLeft > 0) {
      const frozen = Math.min(dt, this.hitstopLeft);
      this.hitstopLeft -= frozen;
      if (this.hitstopLeft < 1e-12) this.hitstopLeft = 0;
      dt -= frozen;
    }
    dt *= this.speed;
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i] as Track;
      if (!track.current) continue;
      this.dropFinishedMixes(track);
      this.num[N_STEP] = dt;
      this.advanceTrack(track);
    }
    this.drain();
  }

  /**
   * Poses `skeleton` (made from this state's document): resets it to the setup pose, then
   * applies every track in order. Call updateWorldTransform afterwards.
   */
  apply(skeleton: Skeleton): void {
    if ((skeleton.document as unknown) !== (this.data.library.document as unknown)) {
      throw new Error("AnimationState.apply: the skeleton was built from a different document");
    }
    skeleton.setToSetupPose();
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i] as Track;
      if (!track.current) continue;
      if (track.dirty || !track.plan) {
        track.plan = new TrackPlan(track.current, track.mask);
        track.dirty = false;
      }
      this.applyPlan(skeleton, track.plan);
    }
    skeleton.limitsEnforced = this.allLooping();
    const resets = this.pendingResets;
    for (let i = 0; i < resets.length; i++) {
      if (resets[i] === 1) {
        (skeleton.physicsPoses[i] as Skeleton["physicsPoses"][number]).resetRequested = true;
        resets[i] = 0;
      }
    }
  }

  /** True when every posed entry loops (bone rotation limits clamp the pose); a non-looping clip lifts them. */
  private allLooping(): boolean {
    for (let i = 0; i < this.tracks.length; i++) {
      const plan = (this.tracks[i] as Track).plan;
      if (!plan || !(this.tracks[i] as Track).current) continue;
      for (let k = 0; k < plan.levels.length; k++) if (!(plan.levels[k] as TrackEntry).loop) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Mixing
  // -------------------------------------------------------------------------------------------

  private applyPlan(skeleton: Skeleton, plan: TrackPlan): void {
    const levels = plan.levels;
    const count = levels.length;
    for (let k = 0; k < count; k++) {
      const entry = levels[k] as TrackEntry;
      entry.applied = true;
      // animationTime and mixFraction written out: getters returning numbers box them when the
      // engine does not inline the call.
      const duration = entry.clip.duration;
      const time = entry.trackTime;
      if (this.heldFrames) plan.clipTime[k] = heldClipTime(time, duration, entry.loop, entry.clip.fps, this.heldPhase);
      else plan.clipTime[k] = duration <= 0 ? 0 : entry.loop ? time % duration : time < duration ? time : duration;
      const mix = k === 0 ? 1 : this.heldFrames ? heldMix(entry, this.heldPhase) : entry._mixDuration <= 0 ? 1 : entry.mixTime / entry._mixDuration;
      plan.mix[k] = mix < 1 ? mix : 1;
    }

    const x = this.x;
    const result = this.result;
    const own = this.own;
    const continuous = plan.continuous;
    for (let p = 0; p < continuous.length; p++) {
      const property = continuous[p] as ContinuousProperty;
      property.read(skeleton, x);
      if (property.rule !== "absolute") property.setup(skeleton, this.setup);
      const row = p * count;
      for (let k = 0; k < count; k++) {
        const entry = levels[k] as TrackEntry;
        const timeline = plan.continuousTimelines[row + k] ?? null;
        if (k === 0) {
          this.entryValue(property, entry, timeline, plan.clipTime, k, x, result);
          continue;
        }
        this.entryValue(property, entry, timeline, plan.clipTime, k, entry.holdPrevious ? result : x, own);
        this.crossfade(property, entry, result, own, plan.mix, k);
      }
      property.write(skeleton, result);
    }

    const discrete = plan.discrete;
    for (let p = 0; p < discrete.length; p++) {
      const row = p * count;
      let winner = -1;
      let winnerKey = -1;
      for (let k = 0; k < count; k++) {
        const entry = levels[k] as TrackEntry;
        const timeline = plan.discreteTimelines[row + k] ?? null;
        if (!timeline || entry._alpha <= 0) continue;
        // Only an entry with a key in effect takes the decision (level 0 at once, newer entries
        // from their discreteThreshold on); otherwise the older chain's decision stands.
        if (k > 0 && (plan.mix[k] as number) < entry._discreteThreshold) continue;
        const key = timeline.keyAtClock(plan.clipTime, k);
        if (key < 0) continue;
        winner = k;
        winnerKey = key;
      }
      if (winner >= 0) (plan.discreteTimelines[row + winner] as DiscreteTimeline).applyKey(skeleton, winnerKey, plan.clipTime, winner);
    }
  }

  /** out = own_E(base): the entry's keyed value at clock[level] blended onto `base` by its alpha and blend. */
  private entryValue(
    property: ContinuousProperty,
    entry: TrackEntry,
    timeline: ContinuousTimeline | null,
    clock: Float64Array,
    level: number,
    base: Float64Array,
    out: Float64Array
  ): void {
    const n = property.channels;
    const alpha = entry._alpha;
    if (!timeline || alpha <= 0) {
      if (out !== base) for (let c = 0; c < n; c++) out[c] = base[c] as number;
      return;
    }
    const key = this.sampled;
    timeline.sampleAt(clock, level, key);
    const setup = this.setup;
    const add = entry.blend === "add";
    switch (property.rule) {
      case "angle": {
        const offset = key[0] as number;
        if (add) {
          out[0] = (base[0] as number) + offset * alpha;
          return;
        }
        const num = this.num;
        num[N_A] = base[0] as number;
        num[N_B] = (setup[0] as number) + offset;
        num[N_W] = alpha;
        this.angularLerp(entry.rotationMemory, property.maskBone * 2);
        out[0] = num[N_A] as number;
        return;
      }
      case "relative":
        for (let c = 0; c < n; c++) {
          const b = base[c] as number;
          const k = key[c] as number;
          out[c] = add ? b + k * alpha : alpha >= 1 ? (setup[c] as number) + k : b + ((setup[c] as number) + k - b) * alpha;
        }
        return;
      case "scale":
        for (let c = 0; c < n; c++) {
          const b = base[c] as number;
          const k = key[c] as number;
          out[c] = add ? b * (1 + (k - 1) * alpha) : alpha >= 1 ? (setup[c] as number) * k : b + ((setup[c] as number) * k - b) * alpha;
        }
        return;
      case "absolute":
        for (let c = 0; c < n; c++) {
          const b = base[c] as number;
          out[c] = alpha >= 1 ? (key[c] as number) : b + ((key[c] as number) - b) * alpha;
        }
        return;
    }
  }

  /** older = lerp(older, newer, m) per channel with m = mix[level] (angles the short, remembered way). */
  private crossfade(
    property: ContinuousProperty,
    entry: TrackEntry,
    older: Float64Array,
    newer: Float64Array,
    mix: Float64Array,
    level: number
  ): void {
    const m = mix[level] as number;
    if (property.rule === "angle") {
      const num = this.num;
      num[N_A] = older[0] as number;
      num[N_B] = newer[0] as number;
      num[N_W] = m;
      this.angularLerp(entry.rotationMemory, property.maskBone * 2 + 1);
      older[0] = num[N_A] as number;
      return;
    }
    for (let c = 0; c < property.channels; c++) {
      const a = older[c] as number;
      older[c] = m >= 1 ? (newer[c] as number) : m <= 0 ? a : a + ((newer[c] as number) - a) * m;
    }
  }

  /**
   * num[N_A] = from angle num[N_A] towards num[N_B] by num[N_W], the short way round, continuing
   * the side the last call on this memory slot took (so the path never flips while the angles
   * drift across 180). Exact at weight 0 (a) and 1 (b).
   */
  private angularLerp(memory: Float64Array, slot: number): void {
    const num = this.num;
    const a = num[N_A] as number;
    const b = num[N_B] as number;
    const w = num[N_W] as number;
    if (w <= 0) return;
    if (w >= 1) {
      num[N_A] = b;
      return;
    }
    // Shortest difference in (-180, 180] (wrapDegrees, written out so nothing returns a number).
    let diff = (b - a) % 360;
    if (diff > 180) diff -= 360;
    else if (diff <= -180) diff += 360;
    const last = memory[slot] as number;
    if (!Number.isNaN(last)) diff += 360 * Math.round((last - diff) / 360);
    memory[slot] = diff;
    num[N_A] = a + diff * w;
  }

  // -------------------------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------------------------

  private dropFinishedMixes(track: Track): void {
    for (let entry = track.current; entry && entry.mixingFrom; entry = entry.mixingFrom) {
      if (entry.mixTime >= entry._mixDuration) {
        const from = entry.mixingFrom;
        entry.mixingFrom = null;
        from.mixingTo = null;
        this.endChain(from);
        track.dirty = true;
        return;
      }
    }
  }

  /** Advances the track by num[N_STEP] seconds. */
  private advanceTrack(track: Track): void {
    const num = this.num;
    let current = track.current as TrackEntry;
    let remaining = num[N_STEP] as number;
    // Start queued entries whose delay comes within this step, carrying the overshoot.
    for (let next = current.next; next; next = current.next) {
      const rate = current._timeScale;
      // Automatic delays follow the previous entry's current speed (a speed change after queuing).
      if (next.autoEnd === next.autoEnd) next.delay = autoDelayFor(next.autoEnd, next._mixDuration, rate);
      const gap = next.delay - current.trackTime;
      const needed = gap <= 0 ? 0 : rate > 0 ? gap / rate : Number.POSITIVE_INFINITY;
      if (needed > remaining) break;
      num[N_DT] = needed;
      this.advanceChain(track);
      remaining -= needed;
      current.next = null;
      this.makeCurrent(track, next, current, true);
      current = next;
    }
    num[N_DT] = remaining;
    this.advanceChain(track);
    if (current.trackTime >= current.trackEnd && !current.mixingFrom && !current.next) {
      this.endChain(current);
      track.current = null;
      track.dirty = true;
    }
  }

  /** Advances every entry of the track's chain by num[N_DT] (oldest first, so events stay in order). */
  private advanceChain(track: Track): void {
    const current = track.current;
    if (current) this.advanceEntry(current, true, track.mask);
  }

  private advanceEntry(entry: TrackEntry, isCurrent: boolean, mask: BoneMask | null): void {
    if (entry.mixingFrom) this.advanceEntry(entry.mixingFrom, false, mask);
    const num = this.num;
    const dt = num[N_DT] as number;
    const from = entry.eventsFrom;
    const start = entry.trackTime;
    entry.trackTime += dt * entry._timeScale;
    let to = entry.trackTime;
    entry.eventsFrom = to;
    if (entry.mixingFrom) entry.mixTime += dt;
    if (!isCurrent) {
      // Mixing out (runtime contract F5): a key fires when the newer entry's mix fraction is at or
      // below eventThreshold at the moment this entry reaches it, wherever the frame boundaries
      // fall. The newer mix has not advanced yet (older entries advance first), so it reaches the
      // threshold `gap` seconds into this step: scan only up to the track time reached by then.
      const newer = entry.mixingTo;
      if (newer === null || newer._mixDuration <= 0) return;
      const gap = entry._eventThreshold * newer._mixDuration - newer.mixTime;
      // Already past the boundary (beyond float noise): no key of this step is eligible.
      if (!(gap > -EVENT_EPSILON)) return;
      if (gap < dt + EVENT_EPSILON) {
        // The boundary falls in this step: scan up to it (plus the epsilon), even when the summed
        // track time rounds a hair short of it, and never rescan that window.
        to = start + gap * entry._timeScale + EVENT_EPSILON;
        if (to > entry.eventsFrom) entry.eventsFrom = to;
      }
    }
    if (to > from) {
      num[N_FROM] = from;
      num[N_TO] = to;
      this.scanKeys(entry, isCurrent, mask);
    }
  }

  /** Queues the events, completes and physics resets of `entry` in track time (num[N_FROM], num[N_TO]]. */
  private scanKeys(entry: TrackEntry, complete: boolean, mask: BoneMask | null): void {
    const num = this.num;
    const from = num[N_FROM] as number;
    const to = num[N_TO] as number;
    const clip = entry.clip;
    const duration = clip.duration;
    const events = clip.events;
    if (!entry.loop || duration <= 0) {
      for (let i = 0; i < events.length; i++) {
        const event = events[i] as AnimationEvent;
        const at = event.time > 0 ? event.time - EVENT_TIME_SLACK : event.time;
        if (at > from && at <= to) this.enqueue(QueueType.Event, entry, event);
      }
      num[N_BASE] = 0;
      this.scanResets(clip, mask);
      if (complete && duration > from && duration <= to) this.enqueue(QueueType.Complete, entry, null);
      return;
    }
    // Cycle c covers track times [c * duration, (c + 1) * duration]. Start one cycle early so
    // that whether a key fires depends only on its own track time, never on rounding here.
    // Catch-up is bounded to the latest MAX_CATCHUP_CYCLES cycles, and the loop counts
    // iterations rather than cycles: past 2^53 a cycle number + 1 rounds back to itself, and an
    // unbounded `cycle++` would never terminate (runtime contract F4).
    const last = Math.floor(to / duration);
    const first = from < 0 ? 0 : Math.max(0, Math.floor(from / duration) - 1);
    const count = last - first > MAX_CATCHUP_CYCLES ? MAX_CATCHUP_CYCLES : last - first;
    for (let i = 0; i <= count; i++) {
      const base = (last - count + i) * duration;
      for (let i = 0; i < events.length; i++) {
        const event = events[i] as AnimationEvent;
        const at = base + (event.time > 0 ? event.time - EVENT_TIME_SLACK : 0);
        if (at > from && at <= to) this.enqueue(QueueType.Event, entry, event);
      }
      num[N_BASE] = base;
      this.scanResets(clip, mask);
      const end = base + duration;
      if (complete && end > from && end <= to) this.enqueue(QueueType.Complete, entry, null);
    }
  }

  /** Physics reset keys at track time num[N_BASE] + t inside (num[N_FROM], num[N_TO]]. */
  private scanResets(clip: Clip, mask: BoneMask | null): void {
    const resets = clip.physicsResets;
    if (resets.length === 0) return;
    const base = this.num[N_BASE] as number;
    const from = this.num[N_FROM] as number;
    const to = this.num[N_TO] as number;
    for (let r = 0; r < resets.length; r++) {
      const timeline = resets[r] as Clip["physicsResets"][number];
      if (mask && !mask.includes(timeline.maskBone)) continue;
      const times = timeline.times;
      for (let i = 0; i < times.length; i++) {
        const at = base + ((times[i] as number) > 0 ? (times[i] as number) - EVENT_TIME_SLACK : 0);
        if (at > from && at <= to) {
          this.pendingResets[timeline.constraint] = 1;
          this.resetSerial++;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Entries and chains
  // -------------------------------------------------------------------------------------------

  /*
   * Transactional: each operation validates every option and builds
   * its entry (the TrackEntry constructor validates alpha, timeScale and thresholds; newEntry the
   * mix) before it touches the queue, a chain or a track, so a rejected call changes nothing.
   */
  private setInternal(index: number, clip: Clip, options: PlayOptions): TrackEntry {
    const track = this.trackAt(index);
    let previous = track.current;
    // The entry mixes from what is on screen: a current entry never applied is replaced outright.
    const from = previous && !previous.applied ? previous.mixingFrom : previous;
    const entry = this.newEntry(index, clip, options, from?.clip ?? null);
    let interrupt = true;
    if (previous) {
      this.dropQueue(previous);
      if (!previous.applied) {
        // Never shown: replace it outright and mix from what was actually on screen.
        const older = previous.mixingFrom;
        previous.mixingFrom = null;
        if (older) older.mixingTo = null;
        this.endEntry(previous);
        previous = older;
        interrupt = false;
      }
    }
    this.makeCurrent(track, entry, previous, interrupt);
    return entry;
  }

  private addInternal(index: number, clip: Clip, options: QueueOptions): TrackEntry {
    if (options.delay !== undefined) checkSeconds("delay", options.delay);
    const track = this.trackAt(index);
    let tail = track.current;
    if (!tail && !(options.delay !== undefined && options.delay > 0)) return this.setInternal(index, clip, options);
    if (tail) while (tail.next) tail = tail.next;
    // Built (validated) before the track changes; a delayed start on an empty track queues after
    // the empty clip that holds the track until then.
    const entry = this.newEntry(index, clip, options, tail ? tail.clip : this.data.library.empty);
    if (!tail) tail = this.setInternal(index, this.data.library.empty, { mix: 0 });
    if (options.delay !== undefined) entry.delay = options.delay;
    else {
      entry.autoEnd = tailEnd(tail);
      entry.delay = autoDelayFor(entry.autoEnd, entry._mixDuration, tail._timeScale);
    }
    tail.next = entry;
    return entry;
  }

  private newEntry(index: number, clip: Clip, options: PlayOptions, previous: Clip | null): TrackEntry {
    const mix = options.mix ?? (previous ? this.data.getMix(previous, clip) : 0);
    checkSeconds("mix", mix);
    // The entry's setters validate alpha, timeScale and the thresholds (runtime contract F4).
    return new TrackEntry(index, clip, options, mix, this.boneCount);
  }

  private makeCurrent(track: Track, entry: TrackEntry, previous: TrackEntry | null, interrupt: boolean): void {
    if (previous) {
      if (interrupt) this.enqueue(QueueType.Interrupt, previous, null);
      if (entry._mixDuration > 0) {
        entry.mixingFrom = previous;
        previous.mixingTo = entry;
        entry.mixTime = 0;
        this.limitChain(entry);
      } else {
        this.endChain(previous);
      }
    }
    track.current = entry;
    track.dirty = true;
    this.enqueue(QueueType.Start, entry, null);
  }

  /** Drops the oldest entries of a chain longer than MAX_MIX_CHAIN. */
  private limitChain(current: TrackEntry): void {
    let length = 1;
    let oldest = current;
    while (oldest.mixingFrom) {
      oldest = oldest.mixingFrom;
      length++;
    }
    while (length > MAX_MIX_CHAIN) {
      const newer = oldest.mixingTo as TrackEntry;
      newer.mixingFrom = null;
      oldest.mixingTo = null;
      this.endEntry(oldest);
      oldest = newer;
      length--;
    }
  }

  /** Ends an entry and every entry it is mixing from. */
  private endChain(entry: TrackEntry): void {
    for (let e: TrackEntry | null = entry; e; ) {
      const older: TrackEntry | null = e.mixingFrom;
      e.mixingFrom = null;
      e.mixingTo = null;
      this.endEntry(e);
      e = older;
    }
  }

  private endEntry(entry: TrackEntry): void {
    if (entry.ended) return;
    entry.ended = true;
    this.enqueue(QueueType.End, entry, null);
  }

  /** Discards the entries queued after `entry` (they never started, so no callbacks). */
  private dropQueue(entry: TrackEntry): void {
    let next = entry.next;
    entry.next = null;
    while (next) {
      next.ended = true;
      const after: TrackEntry | null = next.next;
      next.next = null;
      next = after;
    }
  }

  private trackAt(index: number): Track {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_TRACKS) {
      throw new Error(`track must be an integer from 0 to ${MAX_TRACKS - 1} (got ${index})`);
    }
    while (this.tracks.length <= index) this.tracks.push(new Track());
    return this.tracks[index] as Track;
  }

  private clipOf(clip: string | Clip): Clip {
    return typeof clip === "string" ? this.data.library.get(clip) : clip;
  }

  // -------------------------------------------------------------------------------------------
  // Callback queue
  // -------------------------------------------------------------------------------------------

  private enqueue(type: QueueType, entry: TrackEntry, event: AnimationEvent | null): void {
    const i = this.queueLength++;
    if (i < this.queueTypes.length) {
      this.queueTypes[i] = type;
      this.queueEntries[i] = entry;
      this.queueEvents[i] = event;
    } else {
      this.queueTypes.push(type);
      this.queueEntries.push(entry);
      this.queueEvents.push(event);
    }
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // Listeners may queue more (nested calls); the loop picks those up in order.
      for (let i = 0; i < this.queueLength; i++) {
        const type = this.queueTypes[i] as QueueType;
        const entry = this.queueEntries[i] as TrackEntry;
        const event = this.queueEvents[i] ?? null;
        this.queueEntries[i] = null;
        this.queueEvents[i] = null;
        this.dispatch(entry.listener, type, entry, event);
        for (let l = 0; l < this.listeners.length; l++) this.dispatch(this.listeners[l] as AnimationStateListener, type, entry, event);
      }
    } finally {
      this.queueLength = 0;
      this.draining = false;
    }
  }

  private dispatch(listener: AnimationStateListener | null, type: QueueType, entry: TrackEntry, event: AnimationEvent | null): void {
    if (!listener) return;
    switch (type) {
      case QueueType.Start:
        listener.start?.(entry);
        return;
      case QueueType.Interrupt:
        listener.interrupt?.(entry);
        return;
      case QueueType.End:
        listener.end?.(entry);
        return;
      case QueueType.Complete:
        listener.complete?.(entry);
        return;
      case QueueType.Event:
        if (event) listener.event?.(entry, event);
        return;
    }
  }
}

// Slots of AnimationState.num.
const N_STEP = 0; // seconds to advance the current track by
const N_DT = 1; // seconds to advance a chain by
const N_FROM = 2; // event scan: exclusive start (track time)
const N_TO = 3; // event scan: inclusive end
const N_BASE = 4; // event scan: start of the loop cycle
const N_A = 5; // angular blend: from (and the result)
const N_B = 6; // angular blend: to
const N_W = 7; // angular blend: weight
const NUM_SLOTS = 8;

/**
 * An event (or physics reset) is reached when the clock is within this many seconds before it. A clock built by summing 1/30 s steps
 * lands a few ulps (about 1e-16 s) short of an exact frame time such as 6/30, which would fire a frame-6 event on frame 7; 1e-9 s
 * absorbs that and is far below any authored spacing. (Stepped keys use the larger KEY_TIME_EPSILON for 5-decimal files.)
 */
const EVENT_TIME_SLACK = 1e-9;

/** Most loop cycles one update scans for events, completes and physics resets (long-pause catch-up bound). */
export const MAX_CATCHUP_CYCLES = 1000;

/** `value` if it is a finite number of seconds >= 0, else throws naming `what`. */
function checkSeconds(what: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) throw new Error(`${what} must be a finite number of seconds >= 0 (got ${value})`);
  return value;
}

/** `value` if it is a finite speed >= 0 (no reverse playback), else throws naming `what`. */
function checkSpeed(what: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) throw new Error(`${what} must be a finite speed >= 0 (got ${value}); reverse playback is not supported`);
  return value;
}

/** `value` if it is in 0..1, else throws naming `what`. */
function checkUnit(what: string, value: number): number {
  if (!(value >= 0 && value <= 1)) throw new Error(`${what} must be in 0..1 (got ${value})`);
  return value;
}

/** Track time at which `tail` ends: its clip end, or the end of its current loop cycle. */
function tailEnd(tail: TrackEntry): number {
  const duration = tail.clip.duration;
  return tail.loop && duration > 0 ? duration * (Math.floor(tail.trackTime / duration) + 1) : Math.max(duration, tail.trackTime);
}

/**
 * Default delay (previous entry's track time) so a mix of `mix` real seconds ends when the
 * previous entry, playing at `rate`, reaches `end` (F8). Rate 0: the previous entry never ends.
 */
function autoDelayFor(end: number, mix: number, rate: number): number {
  const delay = end - mix * rate;
  return delay > 0 ? delay : 0;
}

