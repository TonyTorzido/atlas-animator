/*
 * Atlas Animator: original implementation.
 *
 * Clips compiled for playback: animated properties, timelines and the per-document library.
 *
 * Properties. Everything a clip can key is an "animated property" with a stable integer id per
 * document: each bone's rotate / translate / scale / shear, each slot's colour and attachment,
 * each IK constraint's mix+softness and its flags, each transform constraint's mixes, each
 * physics constraint's mix, each deform the user's offsets, and the draw order. AnimationState mixes
 * clips property by property (animationState.ts).
 *
 * Continuous properties carry numbers and a value rule that says what a key means and how the
 * "add" blend combines it (setup = the document's value, key = the timeline's sampled value,
 * x = the pose the track is applied on, a = alpha):
 *
 *   rule       keyed value        replace             add
 *   angle      setup + key        x -> value, short   x + key * a
 *                                 way round (degrees)
 *   relative   setup + key        lerp(x, value, a)   x + key * a
 *   scale      setup * key        lerp(x, value, a)   x * (1 + (key - 1) * a)
 *   absolute   key                lerp(x, value, a)   same as replace
 *
 * Bone rotate is "angle"; translate and shear are "relative"; scale is "scale"; colours,
 * constraint mixes and softness are "absolute"; deform offsets are "relative" with a setup of
 * zero (a deform key is the offset from the bind pose). So rotate/translate/shear keys are offsets
 * from the setup pose and scale keys are multipliers of it, as the plan's format draft shows.
 *
 * Discrete properties (slot attachment, IK flags, draw order) switch rather than blend; a
 * discrete timeline reports the key in effect at a time (-1 before its first key, meaning "not
 * keyed yet") and applies that key.
 *
 * Sampling a continuous timeline before its first key holds the first key; after the last key it
 * holds the last. Between keys k and k + 1 the value is v_k + (v_{k+1} - v_k) * f(u) with
 * u = (t - t_k) / (t_{k+1} - t_k) and f the key's curve for that channel (curves.ts).
 *
 * Everything here is immutable after construction and shared by every skeleton and
 * AnimationState of the same document. Sampling allocates nothing.
 */
import { attachmentLibraryFor, type AttachmentLibrary, type MeshAttachment } from "./attachments.js";
import { parseRgba } from "./color.js";
import { CurveSet, curveForChannel } from "./curves.js";
import { DEFAULT_CLIP_FPS, type AnimDocument, type ClipData, type CurveSpec, type SequenceMode } from "./format.js";
import type { Skeleton } from "./skeleton.js";

/** The parts of a document clips are compiled from. */
export type AnimationDocument = Pick<AnimDocument, "bones" | "slots" | "skins" | "ik" | "transform" | "physics" | "animations" | "events"> & Partial<Pick<AnimDocument, "path">>;

export type ValueRule = "angle" | "relative" | "scale" | "absolute";

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

/** A keyable number (or vector of numbers) of a skeleton. */
export abstract class ContinuousProperty {
  readonly discrete = false;
  constructor(
    readonly id: number,
    readonly label: string,
    readonly rule: ValueRule,
    readonly channels: number,
    /** Bone the track bone masks test, or -1 when masks never exclude this property. */
    readonly maskBone: number
  ) {}
  /** The skeleton's current value. */
  abstract read(skeleton: Skeleton, out: Float64Array): void;
  /** The document's setup value (rules "angle", "relative" and "scale"). */
  abstract setup(skeleton: Skeleton, out: Float64Array): void;
  abstract write(skeleton: Skeleton, values: Float64Array): void;
}

/** A keyable switch of a skeleton (attachment, IK flags, draw order). */
export class DiscreteProperty {
  readonly discrete = true;
  constructor(
    readonly id: number,
    readonly label: string,
    readonly maskBone: number
  ) {}
}

export type AnimatedProperty = ContinuousProperty | DiscreteProperty;

export type BoneChannel = "rotate" | "translate" | "scale" | "shear";
const BONE_CHANNELS: readonly BoneChannel[] = ["rotate", "translate", "scale", "shear"];

class BoneProperty extends ContinuousProperty {
  constructor(
    id: number,
    name: string,
    readonly bone: number,
    readonly channel: BoneChannel
  ) {
    super(
      id,
      `bone ${name} ${channel}`,
      channel === "rotate" ? "angle" : channel === "scale" ? "scale" : "relative",
      channel === "rotate" ? 1 : 2,
      bone
    );
  }

  read(skeleton: Skeleton, out: Float64Array): void {
    const pose = (skeleton.bones[this.bone] as Skeleton["bones"][number]).pose;
    switch (this.channel) {
      case "rotate":
        out[0] = pose.rotation;
        return;
      case "translate":
        out[0] = pose.x;
        out[1] = pose.y;
        return;
      case "scale":
        out[0] = pose.scaleX;
        out[1] = pose.scaleY;
        return;
      case "shear":
        out[0] = pose.shearX;
        out[1] = pose.shearY;
        return;
    }
  }

  setup(skeleton: Skeleton, out: Float64Array): void {
    const data = (skeleton.bones[this.bone] as Skeleton["bones"][number]).data;
    switch (this.channel) {
      case "rotate":
        out[0] = data.rotation;
        return;
      case "translate":
        out[0] = data.x;
        out[1] = data.y;
        return;
      case "scale":
        out[0] = data.scaleX;
        out[1] = data.scaleY;
        return;
      case "shear":
        out[0] = data.shearX;
        out[1] = data.shearY;
        return;
    }
  }

  write(skeleton: Skeleton, values: Float64Array): void {
    const pose = (skeleton.bones[this.bone] as Skeleton["bones"][number]).pose;
    switch (this.channel) {
      case "rotate":
        pose.rotation = values[0] as number;
        return;
      case "translate":
        pose.x = values[0] as number;
        pose.y = values[1] as number;
        return;
      case "scale":
        pose.scaleX = values[0] as number;
        pose.scaleY = values[1] as number;
        return;
      case "shear":
        pose.shearX = values[0] as number;
        pose.shearY = values[1] as number;
        return;
    }
  }
}

class SlotColorProperty extends ContinuousProperty {
  constructor(id: number, name: string, readonly slot: number, maskBone: number) {
    super(id, `slot ${name} color`, "absolute", 4, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    const color = (skeleton.slots[this.slot] as Skeleton["slots"][number]).color;
    out[0] = color.r;
    out[1] = color.g;
    out[2] = color.b;
    out[3] = color.a;
  }
  setup(): void {}
  write(skeleton: Skeleton, values: Float64Array): void {
    const color = (skeleton.slots[this.slot] as Skeleton["slots"][number]).color;
    // Bezier overshoot may leave 0..1; colours cannot.
    color.r = Math.min(1, Math.max(0, values[0] as number));
    color.g = Math.min(1, Math.max(0, values[1] as number));
    color.b = Math.min(1, Math.max(0, values[2] as number));
    color.a = Math.min(1, Math.max(0, values[3] as number));
  }
}

class IkMixProperty extends ContinuousProperty {
  constructor(id: number, name: string, readonly constraint: number, maskBone: number) {
    super(id, `ik ${name} mix`, "absolute", 2, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    const pose = skeleton.ikPoses[this.constraint] as Skeleton["ikPoses"][number];
    out[0] = pose.mix;
    out[1] = pose.softness;
  }
  setup(): void {}
  write(skeleton: Skeleton, values: Float64Array): void {
    const pose = skeleton.ikPoses[this.constraint] as Skeleton["ikPoses"][number];
    pose.mix = Math.min(1, Math.max(0, values[0] as number));
    pose.softness = Math.max(0, values[1] as number);
  }
}

export const TRANSFORM_MIX_CHANNELS = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const;

class TransformMixProperty extends ContinuousProperty {
  constructor(id: number, name: string, readonly constraint: number, maskBone: number) {
    super(id, `transform ${name} mix`, "absolute", 6, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    const pose = skeleton.transformPoses[this.constraint] as Skeleton["transformPoses"][number];
    out[0] = pose.mixRotate;
    out[1] = pose.mixX;
    out[2] = pose.mixY;
    out[3] = pose.mixScaleX;
    out[4] = pose.mixScaleY;
    out[5] = pose.mixShearY;
  }
  setup(): void {}
  write(skeleton: Skeleton, values: Float64Array): void {
    const pose = skeleton.transformPoses[this.constraint] as Skeleton["transformPoses"][number];
    pose.mixRotate = Math.min(1, Math.max(0, values[0] as number));
    pose.mixX = Math.min(1, Math.max(0, values[1] as number));
    pose.mixY = Math.min(1, Math.max(0, values[2] as number));
    pose.mixScaleX = Math.min(1, Math.max(0, values[3] as number));
    pose.mixScaleY = Math.min(1, Math.max(0, values[4] as number));
    pose.mixShearY = Math.min(1, Math.max(0, values[5] as number));
  }
}

export const PATH_CHANNELS = ["position", "spacing", "mixRotate", "mixX", "mixY"] as const;

class PathProperty extends ContinuousProperty {
  constructor(id: number, name: string, readonly constraint: number, maskBone: number) {
    super(id, `path ${name}`, "absolute", 5, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    const pose = skeleton.pathPoses[this.constraint] as Skeleton["pathPoses"][number];
    out[0] = pose.position;
    out[1] = pose.spacing;
    out[2] = pose.mixRotate;
    out[3] = pose.mixX;
    out[4] = pose.mixY;
  }
  setup(): void {}
  write(skeleton: Skeleton, values: Float64Array): void {
    const pose = skeleton.pathPoses[this.constraint] as Skeleton["pathPoses"][number];
    pose.position = values[0] as number;
    pose.spacing = values[1] as number;
    pose.mixRotate = Math.min(1, Math.max(0, values[2] as number));
    pose.mixX = Math.min(1, Math.max(0, values[3] as number));
    pose.mixY = Math.min(1, Math.max(0, values[4] as number));
  }
}

class PhysicsMixProperty extends ContinuousProperty {
  constructor(id: number, name: string, readonly constraint: number, maskBone: number) {
    super(id, `physics ${name} mix`, "absolute", 1, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    out[0] = (skeleton.physicsPoses[this.constraint] as Skeleton["physicsPoses"][number]).mix;
  }
  setup(): void {}
  write(skeleton: Skeleton, values: Float64Array): void {
    (skeleton.physicsPoses[this.constraint] as Skeleton["physicsPoses"][number]).mix = Math.min(1, Math.max(0, values[0] as number));
  }
}

/** Deform offsets of one deform owner (setup = zero offsets). */
class DeformProperty extends ContinuousProperty {
  constructor(id: number, readonly owner: MeshAttachment, maskBone: number) {
    super(id, `deform ${owner.skin}/${owner.slot}/${owner.name}`, "relative", owner.geometry.deformLength, maskBone);
  }
  read(skeleton: Skeleton, out: Float64Array): void {
    // Activates (zero-filled) the user's animation deform for this frame; it is written below.
    const deform = skeleton.animationDeformFor(this.owner);
    for (let i = 0; i < this.channels; i++) out[i] = deform[i] as number;
  }
  setup(_skeleton: Skeleton, out: Float64Array): void {
    out.fill(0, 0, this.channels);
  }
  write(skeleton: Skeleton, values: Float64Array): void {
    const deform = skeleton.animationDeformFor(this.owner);
    for (let i = 0; i < this.channels; i++) deform[i] = values[i] as number;
  }
}

/**
 * Every animated property of a document, by id. Ids are laid out as: 4 per bone (rotate,
 * translate, scale, shear), 2 per slot (colour, attachment), 2 per IK constraint (mix+softness,
 * flags), 1 per transform constraint, 1 per physics constraint, 1 per deform owner, then the
 * draw order.
 */
export class AnimationProperties {
  readonly all: readonly AnimatedProperty[];
  /** Most channels any continuous property has (sizes mixing scratch buffers). */
  readonly maxChannels: number;
  readonly drawOrder: DiscreteProperty;
  /** Slot index -> its image-sequence property (appended after the draw order; only slots showing a sequence). */
  private readonly sequenceProps = new Map<number, DiscreteProperty>();
  private readonly slotBase: number;
  private readonly ikBase: number;
  private readonly transformBase: number;
  private readonly pathBase: number;
  private readonly physicsBase: number;
  private readonly deformBase: number;

  constructor(doc: AnimationDocument, library: AttachmentLibrary) {
    const boneIndex = new Map(doc.bones.map((bone, i) => [bone.name, i] as const));
    const slotBone = doc.slots.map((slot) => boneIndex.get(slot.bone) ?? -1);
    const slotIndex = new Map(doc.slots.map((slot, i) => [slot.name, i] as const));
    const all: AnimatedProperty[] = [];
    doc.bones.forEach((bone, b) => {
      for (const channel of BONE_CHANNELS) all.push(new BoneProperty(all.length, bone.name, b, channel));
    });
    this.slotBase = all.length;
    doc.slots.forEach((slot, s) => {
      all.push(new SlotColorProperty(all.length, slot.name, s, slotBone[s] as number));
      all.push(new DiscreteProperty(all.length, `slot ${slot.name} attachment`, slotBone[s] as number));
    });
    this.ikBase = all.length;
    doc.ik.forEach((ik, i) => {
      const mask = boneIndex.get(ik.bones[0] as string) ?? -1;
      all.push(new IkMixProperty(all.length, ik.name, i, mask));
      all.push(new DiscreteProperty(all.length, `ik ${ik.name} flags`, mask));
    });
    this.transformBase = all.length;
    doc.transform.forEach((t, i) => all.push(new TransformMixProperty(all.length, t.name, i, boneIndex.get(t.bones[0] as string) ?? -1)));
    this.pathBase = all.length;
    (doc.path ?? []).forEach((p, i) => all.push(new PathProperty(all.length, p.name, i, boneIndex.get(p.bones[0] as string) ?? -1)));
    this.physicsBase = all.length;
    doc.physics.forEach((p, i) => all.push(new PhysicsMixProperty(all.length, p.name, i, boneIndex.get(p.bone) ?? -1)));
    this.deformBase = all.length;
    for (const owner of library.deformOwners) {
      const slot = slotIndex.get(owner.slot);
      all.push(new DeformProperty(all.length, owner, slot === undefined ? -1 : (slotBone[slot] as number)));
    }
    this.drawOrder = new DiscreteProperty(all.length, "draw order", -1);
    all.push(this.drawOrder);
    const sequenceSlots = new Set(library.attachments.filter((a) => (a.type === "region" || a.type === "mesh") && a.sequence).map((a) => slotIndex.get(a.slot)));
    doc.slots.forEach((slot, s) => {
      if (!sequenceSlots.has(s)) return;
      const property = new DiscreteProperty(all.length, `slot ${slot.name} sequence`, slotBone[s] as number);
      this.sequenceProps.set(s, property);
      all.push(property);
    });
    this.all = all;
    this.maxChannels = all.reduce((max, p) => (p.discrete ? max : Math.max(max, p.channels)), 1);
  }

  bone(bone: number, channel: BoneChannel): ContinuousProperty {
    return this.all[bone * 4 + BONE_CHANNELS.indexOf(channel)] as ContinuousProperty;
  }
  slotColor(slot: number): ContinuousProperty {
    return this.all[this.slotBase + slot * 2] as ContinuousProperty;
  }
  slotAttachment(slot: number): DiscreteProperty {
    return this.all[this.slotBase + slot * 2 + 1] as DiscreteProperty;
  }
  /** The image-sequence property of a slot, or undefined when no attachment of that slot is a sequence. */
  slotSequence(slot: number): DiscreteProperty | undefined {
    return this.sequenceProps.get(slot);
  }
  ikMix(constraint: number): ContinuousProperty {
    return this.all[this.ikBase + constraint * 2] as ContinuousProperty;
  }
  ikFlags(constraint: number): DiscreteProperty {
    return this.all[this.ikBase + constraint * 2 + 1] as DiscreteProperty;
  }
  transformMix(constraint: number): ContinuousProperty {
    return this.all[this.transformBase + constraint] as ContinuousProperty;
  }
  pathProperty(constraint: number): ContinuousProperty {
    return this.all[this.pathBase + constraint] as ContinuousProperty;
  }
  physicsMix(constraint: number): ContinuousProperty {
    return this.all[this.physicsBase + constraint] as ContinuousProperty;
  }
  deform(owner: MeshAttachment): ContinuousProperty {
    return this.all[this.deformBase + owner.deformIndex] as ContinuousProperty;
  }
}

// ---------------------------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------------------------

/**
 * Stepped keys (attachment swaps, IK flags, draw order), events and physics resets count as reached when the clock is within this many
 * seconds before them. Key times are written with 5 decimals (frame 4 at 30 fps is 0.13333, frame 5 is 0.16667), so a frame's own exact
 * time (5 / 30) can sit up to 5e-6 s before a key that belongs to it; 1e-4 s is far below a frame (0.033 s) and absorbs that.
 */
export const KEY_TIME_EPSILON = 1e-4;

/** Index of the last key at or before `time`, or -1 when `time` is before the first key. */
export function keyAtOrBefore(times: Float64Array, time: number): number {
  sampleClock[0] = time;
  return keyAtClock(times, sampleClock, 0);
}

/** keyAtOrBefore with the time read from clock[index] (no number argument to box). */
function keyAtClock(times: Float64Array, clock: Float64Array, index: number, epsilon = 0): number {
  const time = (clock[index] as number) + epsilon;
  const last = times.length - 1;
  if (last < 0 || time < (times[0] as number)) return -1;
  if (time >= (times[last] as number)) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((times[middle] as number) <= time) low = middle;
    else high = middle;
  }
  return low;
}

/** Keys of one continuous property: times, values (channels per key) and curves. */
export class ContinuousTimeline {
  readonly property: ContinuousProperty;
  readonly times: Float64Array;
  /** keyCount * property.channels values. */
  readonly values: Float64Array;
  /** keyCount * curveChannels curves; a single curve channel eases every value channel. */
  readonly curves: CurveSet;

  constructor(property: ContinuousProperty, times: Float64Array, values: Float64Array, curves: CurveSet) {
    // Invariant (runtime contract F1): an empty timeline has no value to sample and would write
    // NaN into the pose. The loader rejects it; this guards callers that bypass the loader.
    if (times.length === 0) throw new Error("a continuous timeline needs at least one key (omit the timeline instead)");
    if (values.length !== times.length * property.channels) {
      throw new Error(`continuous timeline: ${values.length} values for ${times.length} keys x ${property.channels} channels`);
    }
    this.property = property;
    this.times = times;
    this.values = values;
    this.curves = curves;
  }

  /** Writes the keyed value(s) at clip time `time` into `out`. */
  sample(time: number, out: Float64Array): void {
    sampleClock[0] = time;
    this.sampleAt(sampleClock, 0, out);
  }

  /**
   * sample() for the playback hot path: the clip time is read from clock[index]. Numbers passed
   * through typed arrays are never boxed, so this allocates nothing even when not inlined.
   */
  sampleAt(clock: Float64Array, index: number, out: Float64Array): void {
    const time = clock[index] as number;
    const n = this.property.channels;
    const values = this.values;
    const times = this.times;
    const key = keyAtClock(times, clock, index);
    const last = times.length - 1;
    if (key < 0 || key === last) {
      // Before the first key: hold the first; after the last: hold the last.
      const at = (key < 0 ? 0 : key) * n;
      for (let c = 0; c < n; c++) out[c] = values[at + c] as number;
      return;
    }
    const t0 = times[key] as number;
    const u = (time - t0) / ((times[key + 1] as number) - t0);
    const from = key * n;
    const to = from + n;
    const curves = this.curves;
    const io = easeScratch;
    if (curves.channels === 1) {
      io[0] = u;
      curves.easeInPlace(key, 0, io);
      const f = io[0] as number;
      for (let c = 0; c < n; c++) {
        const a = values[from + c] as number;
        out[c] = a + ((values[to + c] as number) - a) * f;
      }
      return;
    }
    for (let c = 0; c < n; c++) {
      io[0] = u;
      curves.easeInPlace(key, c, io);
      const a = values[from + c] as number;
      out[c] = a + ((values[to + c] as number) - a) * (io[0] as number);
    }
  }
}

// Scratch for passing numbers without boxing (one thread; never held across calls).
const sampleClock = new Float64Array(1);
const easeScratch = new Float64Array(1);

/** Keys of one discrete property. */
export abstract class DiscreteTimeline {
  readonly property: DiscreteProperty;
  readonly times: Float64Array;

  constructor(property: DiscreteProperty, times: Float64Array) {
    this.property = property;
    this.times = times;
  }

  /** The key in effect at `time`, or -1 before the first key. */
  keyAt(time: number): number {
    return keyAtOrBefore(this.times, time + KEY_TIME_EPSILON);
  }

  /** keyAt() for the playback hot path: the clip time is read from clock[index] (no boxing). */
  keyAtClock(clock: Float64Array, index: number): number {
    return keyAtClock(this.times, clock, index, KEY_TIME_EPSILON);
  }

  /** The clip time the key was found at is clock[index] (sequence keys advance with it; read there so no number is boxed per call). */
  abstract applyKey(skeleton: Skeleton, key: number, clock: Float64Array, index: number): void;
}

/** Image-sequence keys of one slot: mode, start frame and delay from each key on. */
export class SequenceTimeline extends DiscreteTimeline {
  constructor(
    property: DiscreteProperty,
    times: Float64Array,
    readonly slot: number,
    readonly keys: readonly { readonly mode: SequenceMode; readonly index: number; readonly delay: number }[]
  ) {
    super(property, times);
  }
  applyKey(skeleton: Skeleton, key: number, clock: Float64Array, index: number): void {
    const slot = skeleton.slots[this.slot] as Skeleton["slots"][number];
    const k = this.keys[key];
    if (!k) return;
    slot.sequenceMode = k.mode;
    slot.sequenceIndex = k.index;
    slot.sequenceDelay = k.delay;
    slot.sequenceElapsed = Math.max(0, (clock[index] as number) - (this.times[key] as number));
  }
}

export class AttachmentTimeline extends DiscreteTimeline {
  constructor(
    property: DiscreteProperty,
    times: Float64Array,
    readonly slot: number,
    /** Placeholder shown from each key on (null = nothing). */
    readonly names: readonly (string | null)[]
  ) {
    super(property, times);
  }
  applyKey(skeleton: Skeleton, key: number): void {
    (skeleton.slots[this.slot] as Skeleton["slots"][number]).placeholder = this.names[key] ?? null;
  }
}

export class IkFlagsTimeline extends DiscreteTimeline {
  constructor(
    property: DiscreteProperty,
    times: Float64Array,
    readonly constraint: number,
    /** Per key: bendPositive, stretch, compress as 0/1. */
    readonly flags: Uint8Array
  ) {
    super(property, times);
  }
  applyKey(skeleton: Skeleton, key: number): void {
    const pose = skeleton.ikPoses[this.constraint] as Skeleton["ikPoses"][number];
    pose.bendPositive = this.flags[key * 3] === 1;
    pose.stretch = this.flags[key * 3 + 1] === 1;
    pose.compress = this.flags[key * 3 + 2] === 1;
  }
}

export class DrawOrderTimeline extends DiscreteTimeline {
  constructor(
    property: DiscreteProperty,
    times: Float64Array,
    /** Per key: moved slot indices and their offsets (no entries = setup order). */
    readonly keys: readonly { readonly slots: Int32Array; readonly offsets: Int32Array }[]
  ) {
    super(property, times);
  }
  applyKey(skeleton: Skeleton, key: number): void {
    const offsets = skeleton.drawOrderOffsets;
    offsets.fill(0);
    const entry = this.keys[key];
    if (!entry) return;
    for (let i = 0; i < entry.slots.length; i++) offsets[entry.slots[i] as number] = entry.offsets[i] as number;
  }
}

/** A named moment of a clip with its payload (the declaration's defaults where the key omits them). */
export interface AnimationEvent {
  readonly name: string;
  /** Clip time in seconds. */
  readonly time: number;
  readonly int: number;
  readonly float: number;
  readonly string: string;
  /** Sound name ("" for none). */
  readonly audio: string;
}

/** Physics reset keys of one physics constraint. */
export interface PhysicsResetTimeline {
  readonly constraint: number;
  readonly maskBone: number;
  readonly times: Float64Array;
}

// ---------------------------------------------------------------------------------------------
// Clips and the library
// ---------------------------------------------------------------------------------------------

export class Clip {
  constructor(
    readonly name: string,
    readonly duration: number,
    readonly loop: boolean,
    readonly continuous: readonly ContinuousTimeline[],
    readonly discrete: readonly DiscreteTimeline[],
    /** Sorted by time (keys at the same time keep their document order). */
    readonly events: readonly AnimationEvent[],
    readonly physicsResets: readonly PhysicsResetTimeline[],
    /** Held-frame playback rate (clip `fps`, DEFAULT_CLIP_FPS when absent): see AnimationState.heldFrames. */
    readonly fps: number = DEFAULT_CLIP_FPS
  ) {}

  /** True when this clip keys `property`. */
  keys(property: AnimatedProperty): boolean {
    return property.discrete
      ? this.discrete.some((timeline) => timeline.property === property)
      : this.continuous.some((timeline) => timeline.property === property);
  }
}

/** Name of the clip that keys nothing (used to fade a track in or out). */
export const EMPTY_CLIP_NAME = "<empty>";

/** Compiled clips and animated properties of one document, shared by all its skeletons. */
export class AnimationLibrary {
  readonly document: AnimationDocument;
  readonly properties: AnimationProperties;
  readonly clips: ReadonlyMap<string, Clip>;
  /** The clip that keys nothing. */
  readonly empty: Clip;

  /** `doc` must be validated (loadAnimDocument): references are assumed to resolve. */
  constructor(doc: AnimationDocument) {
    this.document = doc;
    const attachments = attachmentLibraryFor(doc);
    this.properties = new AnimationProperties(doc, attachments);
    const compiler = new ClipCompiler(doc, this.properties, attachments);
    this.clips = new Map(Object.entries(doc.animations).map(([name, data]) => [name, compiler.compile(name, data)] as const));
    this.empty = new Clip(EMPTY_CLIP_NAME, 0, false, [], [], [], []);
  }

  /** The compiled clip, or throws naming the clips that exist. */
  get(name: string): Clip {
    const clip = this.clips.get(name);
    if (!clip) throw new Error(`unknown clip '${name}' (clips: ${[...this.clips.keys()].join(", ") || "none"})`);
    return clip;
  }
}

const libraries = new WeakMap<AnimationDocument, AnimationLibrary>();

/** The shared animation library of a document (built on first use, cached per document object). */
export function animationLibraryFor(doc: AnimationDocument): AnimationLibrary {
  let library = libraries.get(doc);
  if (!library) libraries.set(doc, (library = new AnimationLibrary(doc)));
  return library;
}

type KeyCurve = CurveSpec | Readonly<Record<string, CurveSpec | undefined>>;

class ClipCompiler {
  private readonly boneIndex: Map<string, number>;
  private readonly slotIndex: Map<string, number>;
  private readonly ikIndex: Map<string, number>;
  private readonly transformIndex: Map<string, number>;
  private readonly physicsIndex: Map<string, number>;
  private readonly pathIndex: Map<string, number>;

  constructor(
    private readonly doc: AnimationDocument,
    private readonly properties: AnimationProperties,
    private readonly attachments: AttachmentLibrary
  ) {
    const indexOf = (items: readonly { name: string }[]) => new Map(items.map((item, i) => [item.name, i] as const));
    this.boneIndex = indexOf(doc.bones);
    this.slotIndex = indexOf(doc.slots);
    this.ikIndex = indexOf(doc.ik);
    this.transformIndex = indexOf(doc.transform);
    this.physicsIndex = indexOf(doc.physics);
    this.pathIndex = indexOf(doc.path ?? []);
  }

  compile(name: string, clip: ClipData): Clip {
    const continuous: ContinuousTimeline[] = [];
    const discrete: DiscreteTimeline[] = [];
    const props = this.properties;
    const doc = this.doc;

    for (const [boneName, timelines] of Object.entries(clip.bones)) {
      const bone = this.lookup(this.boneIndex, boneName, "bone", name);
      if (timelines.rotate) {
        continuous.push(build(props.bone(bone, "rotate"), timelines.rotate, ["value"], (key) => [key.value]));
      }
      for (const channel of ["translate", "scale", "shear"] as const) {
        const keys = timelines[channel];
        if (keys) continuous.push(build(props.bone(bone, channel), keys, ["x", "y"], (key) => [key.x, key.y]));
      }
    }

    for (const [slotName, timelines] of Object.entries(clip.slots)) {
      const slot = this.lookup(this.slotIndex, slotName, "slot", name);
      if (timelines.color) {
        continuous.push(
          build(props.slotColor(slot), timelines.color, ["r", "g", "b", "a"], (key) => {
            const c = parseRgba(key.color);
            return [c.r, c.g, c.b, c.a];
          })
        );
      }
      if (timelines.sequence && timelines.sequence.length > 0) {
        const property = props.slotSequence(slot);
        if (!property) throw new Error(`clip '${name}': slot '${slotName}' shows no image sequence, so it cannot have sequence keys`);
        discrete.push(new SequenceTimeline(property, times(timelines.sequence), slot, timelines.sequence.map((key) => ({ mode: key.mode, index: key.index, delay: key.delay }))));
      }
      if (timelines.attachment) {
        discrete.push(
          new AttachmentTimeline(
            props.slotAttachment(slot),
            times(timelines.attachment),
            slot,
            timelines.attachment.map((key) => key.name)
          )
        );
      }
    }

    for (const [ikName, keys] of Object.entries(clip.ik)) {
      const index = this.lookup(this.ikIndex, ikName, "ik constraint", name);
      const setup = doc.ik[index] as AnimDocument["ik"][number];
      continuous.push(build(props.ikMix(index), keys, ["mix", "softness"], (key) => [key.mix ?? setup.mix, key.softness ?? setup.softness]));
      const flags = new Uint8Array(keys.length * 3);
      keys.forEach((key, k) => {
        flags[k * 3] = (key.bendPositive ?? setup.bendPositive) ? 1 : 0;
        flags[k * 3 + 1] = (key.stretch ?? setup.stretch) ? 1 : 0;
        flags[k * 3 + 2] = (key.compress ?? setup.compress) ? 1 : 0;
      });
      discrete.push(new IkFlagsTimeline(props.ikFlags(index), times(keys), index, flags));
    }

    for (const [transformName, keys] of Object.entries(clip.transform)) {
      const index = this.lookup(this.transformIndex, transformName, "transform constraint", name);
      const setup = doc.transform[index] as AnimDocument["transform"][number];
      continuous.push(build(props.transformMix(index), keys, TRANSFORM_MIX_CHANNELS, (key) => TRANSFORM_MIX_CHANNELS.map((c) => key[c] ?? setup[c])));
    }

    for (const [pathName, keys] of Object.entries(clip.path ?? {})) {
      const index = this.lookup(this.pathIndex, pathName, "path constraint", name);
      const setup = (doc.path ?? [])[index] as NonNullable<AnimDocument["path"]>[number];
      continuous.push(build(props.pathProperty(index), keys, PATH_CHANNELS, (key) => PATH_CHANNELS.map((c) => key[c] ?? setup[c])));
    }

    const physicsResets: PhysicsResetTimeline[] = [];
    for (const [physicsName, timelines] of Object.entries(clip.physics)) {
      const index = this.lookup(this.physicsIndex, physicsName, "physics constraint", name);
      const property = props.physicsMix(index);
      if (timelines.mix) continuous.push(build(property, timelines.mix, ["value"], (key) => [key.value]));
      if (timelines.reset && timelines.reset.length > 0) {
        physicsResets.push({ constraint: index, maskBone: property.maskBone, times: times(timelines.reset) });
      }
    }

    for (const [skin, slots] of Object.entries(clip.deform)) {
      for (const [slot, attachments] of Object.entries(slots)) {
        for (const [attachment, keys] of Object.entries(attachments)) {
          const target = this.attachments.get(skin, slot, attachment);
          if (!target || target.type !== "mesh" || target.deformIndex < 0) {
            throw new Error(`clip '${name}': deform target '${skin}/${slot}/${attachment}' is not a mesh that owns its deform`);
          }
          const length = target.geometry.deformLength;
          continuous.push(
            build(props.deform(target), keys, ["value"], (key) => {
              const dense = new Array<number>(length).fill(0);
              key.vertices.forEach((value, i) => {
                if (key.offset + i < length) dense[key.offset + i] = value;
              });
              return dense;
            })
          );
        }
      }
    }

    if (clip.drawOrder.length > 0) {
      discrete.push(
        new DrawOrderTimeline(
          props.drawOrder,
          times(clip.drawOrder),
          clip.drawOrder.map((key) => ({
            slots: Int32Array.from(key.offsets.map((entry) => this.lookup(this.slotIndex, entry.slot, "slot", name))),
            offsets: Int32Array.from(key.offsets.map((entry) => entry.offset))
          }))
        )
      );
    }

    const events = clip.events
      .map((key, order) => {
        const declared = doc.events[key.name];
        const event: AnimationEvent = Object.freeze({
          name: key.name,
          time: key.time,
          int: key.int ?? declared?.int ?? 0,
          float: key.float ?? declared?.float ?? 0,
          string: key.string ?? declared?.string ?? "",
          audio: key.audio ?? declared?.audio ?? ""
        });
        return { event, order };
      })
      .sort((a, b) => a.event.time - b.event.time || a.order - b.order)
      .map(({ event }) => event);

    return new Clip(name, clip.duration, clip.loop, continuous, discrete, events, physicsResets, clip.fps ?? DEFAULT_CLIP_FPS);
  }

  private lookup(map: ReadonlyMap<string, number>, key: string, what: string, clip: string): number {
    const index = map.get(key);
    if (index === undefined) throw new Error(`clip '${clip}': unknown ${what} '${key}'`);
    return index;
  }
}

function times(keys: readonly { time: number }[]): Float64Array {
  return Float64Array.from(keys, (key) => key.time);
}

function build<K extends { time: number; curve?: KeyCurve }>(
  property: ContinuousProperty,
  keys: readonly K[],
  curveChannels: readonly string[],
  valuesOf: (key: K) => readonly number[]
): ContinuousTimeline {
  const n = property.channels;
  const values = new Float64Array(keys.length * n);
  const curves = new CurveSet(keys.length, curveChannels.length);
  keys.forEach((key, k) => {
    const v = valuesOf(key);
    for (let c = 0; c < n; c++) values[k * n + c] = v[c] ?? 0;
    curveChannels.forEach((channel, c) => curves.set(k, c, curveForChannel(key.curve ?? "linear", channel)));
  });
  return new ContinuousTimeline(property, times(keys), values, curves);
}


