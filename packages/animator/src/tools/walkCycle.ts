/*
 * Atlas Animator: original implementation.
 *
 * A reusable front-facing walk-in-place template (r5): parameters in data (game px,
 * degrees, seconds; fixtures/clips/*.json), sampled per frame into rig-neutral intents (pelvis
 * offset, per-foot lift and toe tilt, torso and head tilt, arm/elbow/hand swing) that an assembler
 * turns into keys with its leg stance policy. Design: a light chibi step, not a stamp. A low lift
 * with an early peak (ease-out on the lift, long ease-in on the touchdown, zero vertical speed at
 * contact); the foot peels with a slight toe-down and lands flat; the body is lowest just after
 * contact and highest at passing; a gentle weight shift toward the planted foot with a small torso
 * and head counter-tilt; the arms swing opposite the legs with follow-through (hands trail the
 * shoulders). No holds: double support is short and every channel keeps moving.
 */
export interface WalkParams {
  /** Cycle length (s): two steps. */
  period: number;
  /** Share of the cycle each foot is in the air (the overlap of the planted spans is double support). */
  swing: number;
  /** Foot lift at its peak (game px). */
  lift: number;
  /** Where in the swing the lift peaks (0..1; below 0.5 = quick lift, long soft touchdown). */
  liftPeak: number;
  /** Toe-down tilt at lift-off (deg), eased back to flat by mid-swing. */
  toeDown: number;
  /** Pelvis bob, peak to peak (game px). */
  bob: number;
  /** Lowest pelvis this long after each contact (share of the cycle). */
  bobLag: number;
  /** Side weight shift toward the planted foot (game px, either way). */
  sway: number;
  /** Torso and head counter-tilt (deg). */
  torsoTilt: number;
  headTilt: number;
  /** Arm swing (deg either way) around armBase; elbow and hand follow-through (deg) and delays (frames). */
  arm: number;
  armBase: number;
  elbow: number;
  elbowBase: number;
  hand: number;
  armDelay: number;
  elbowDelay: number;
  handDelay: number;
  fps: number;
  /**
   * Depth stride (front view): a leg stepping toward the viewer scales up by depthScale (0.06 = 6%)
   * and its foot sits depthDrop game px lower on screen; going back it shrinks and sits higher. The
   * swing carries the leg from back to front (eased); during stance the planted foot recedes slowly
   * from front to back as the body passes over it (locked to the ground in depth: on screen it
   * shrinks and rises). Both legs are neutral at passing. 0 disables.
   */
  depthScale?: number;
  depthDrop?: number;
}

export interface WalkFoot {
  /** Lift (game px, up). */
  lift: number;
  /** Toe-down tilt (deg). */
  tilt: number;
  /** Swing progress 0..1, null while planted. */
  swingU: number | null;
  /** Depth phase -1 (back, far) .. +1 (forward, near); 0 at passing. */
  depth: number;
}

export interface WalkFrame {
  t: number;
  /** Pelvis offset in game px (x toward the screen right, y down). */
  pelvis: { x: number; y: number };
  foot: { l: WalkFoot; r: WalkFoot };
  torso: number;
  head: number;
  /** Near-side angles for each arm (a mirrored far bone takes the negated value). */
  arm: { l: { raise: number; elbow: number; hand: number }; r: { raise: number; elbow: number; hand: number } };
}

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

/** Lift profile over a swing (u 0..1): zero height and zero speed at both ends, peak at `peak`. */
export function liftCurve(u: number, peak: number): number {
  if (u <= 0 || u >= 1) return 0;
  const w = u < peak ? (u / peak) * 0.5 : 0.5 + ((u - peak) / (1 - peak)) * 0.5;
  return Math.sin(Math.PI * w) ** 2;
}

/** Samples one cycle: the near foot (l) swings from phase 0, the far foot (r) half a cycle later. */
export function walkFrames(p: WalkParams): WalkFrame[] {
  const n = Math.round(p.period * p.fps);
  const out: WalkFrame[] = [];
  const step = 1 / n;
  for (let i = 0; i < n; i++) {
    const c = i / n;
    const swingOf = (offset: number) => {
      const u = frac(c - offset) / p.swing;
      return u < 1 ? u : null;
    };
    const depthOf = (offset: number) => {
      const q = frac(c - offset);
      return q < p.swing ? -Math.cos((Math.PI * q) / p.swing) : Math.cos((Math.PI * (q - p.swing)) / (1 - p.swing));
    };
    const foot = (u: number | null, depth: number): WalkFoot => ({
      depth,
      lift: u === null ? 0 : p.lift * liftCurve(u, p.liftPeak),
      tilt: u === null ? 0 : p.toeDown * Math.cos(Math.min(1, u / 0.5) * (Math.PI / 2)) ** 2 * Math.min(1, u * 6),
      swingU: u
    });
    // contacts at phase swing (near) and 0.5 + swing (far): lowest just after, highest at passing
    const low = p.swing + p.bobLag;
    const bob = (p.bob / 2) * Math.cos(2 * TAU * (c - low));
    // weight toward the planted foot: the far foot is planted while the near one swings
    const toward = Math.cos(TAU * (c - p.swing / 2)); // +1 at the near foot's mid swing
    const phase = (delayFrames: number) => TAU * (c - p.swing / 2 - delayFrames * step);
    out.push({
      t: i / p.fps,
      pelvis: { x: p.sway * toward, y: bob },
      foot: { l: foot(swingOf(0), depthOf(0)), r: foot(swingOf(0.5), depthOf(0.5)) },
      torso: -p.torsoTilt * toward,
      head: p.headTilt * toward,
      arm: {
        l: {
          raise: p.armBase - p.arm * Math.cos(phase(p.armDelay)),
          elbow: p.elbowBase + p.elbow * Math.max(0, -Math.cos(phase(p.armDelay + p.elbowDelay))),
          hand: -p.hand * Math.cos(phase(p.armDelay + p.elbowDelay + p.handDelay))
        },
        r: {
          raise: p.armBase + p.arm * Math.cos(phase(p.armDelay)),
          elbow: p.elbowBase + p.elbow * Math.max(0, Math.cos(phase(p.armDelay + p.elbowDelay))),
          hand: p.hand * Math.cos(phase(p.armDelay + p.elbowDelay + p.handDelay))
        }
      }
    });
  }
  return out;
}
