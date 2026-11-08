/*
 * Atlas Animator: original implementation.
 *
 * Physics constraint: a damped spring on one bone (capes, hair, skirts, pouches, trailing wing
 * edges). Cosmetic only, never networked. A chain is one constraint per bone, listed parents
 * first, so each link reacts to the swing of the one above it.
 *
 * Model. The animated pose is the spring's rest position. The simulation keeps offsets from it:
 * - translation (world px, x and y) for the `x` / `y` channels;
 * - an angle (radians) for the `rotate` and `shearX` channels;
 * - a relative length change for the `scaleX` channel.
 * Each frame, motion of the bone feeds the offsets (inertia), then fixed-size steps integrate the
 * springs, then the offsets are applied to the world matrix (times `mix` and each channel's
 * weight) and Bone.enforceLimits holds the rotation limits (plan 4.4).
 *
 * Inertia (0..1). The bone's mass lags behind its animated motion: when the bone's origin moves by
 * (dx, dy) the translation offset moves by -(dx, dy) * inertia; the angle offset turns by inertia
 * times the angle from where the bone points now to where its simulated tip was last frame (so a
 * moving or turning bone trails), and the length offset grows by inertia times the origin motion
 * along the bone, over its length. Motion beyond `limit` px per second (per axis) is ignored, so
 * a teleport is not an impulse; Skeleton.physicsTranslate / physicsRotate tell the simulation the
 * skeleton was moved on purpose, so nothing reacts at all.
 *
 * Springs, per step of h = 1 / fps seconds, semi-implicit Euler (velocity first, then position):
 *   v += (force - strength * offset) / mass * h;   offset += v * h;   v *= damping^(60 h)
 * - strength (1/s^2): stiffness; with mass 1 the spring rings at sqrt(strength) rad/s.
 * - damping (0..1): the fraction of velocity kept per 1/60 s (1 = no damping), so tuning does not
 *   depend on `fps`.
 * - mass: divides every acceleration (heavier = slower, lazier response; same rest offsets).
 * - stability (runtime contract F7): with s = strength * h^2 / mass and d = damping^(60 h), one
 *   step maps (offset, h * velocity) by [[1 - s, 1], [-d s, d]], whose eigenvalues satisfy
 *   L^2 - (1 + d - s) L + d = 0. They stay inside the unit circle iff s < 2 (1 + d); at or past
 *   that bound the spring diverges (springStability). The loader rejects such constraints; it
 *   warns when strength / mass > fps^2 (s > 1: rings within about six steps). At runtime a state
 *   that still turns non-finite or absurd (a document that bypassed the loader) is recovered:
 *   the channel snaps back to the pose (offsets and velocities cleared, `recoveries` counts it).
 * - wind (+x) and gravity (+y, down on the canvas), in px/s^2. Translation takes them directly.
 *   The angle takes the part of the force across the bone at its tip over the bone's world length
 *   (a point mass on the tip): (gravity * cos a - wind * sin a) / length for bone angle a, so a
 *   bone hanging straight down feels no gravity torque and a horizontal one droops. The length
 *   offset takes the part along the bone over its length.
 * The simulation is independent of `mix` and the channel weights, which only scale what is shown.
 *
 * Time. Skeleton.update(delta) advances the skeleton's clock (delta clamped to 0.25 s); each
 * constraint consumes the clock's advance since its last update in fixed steps through an
 * accumulator, at most 4 steps per update (time beyond that is dropped, so a slow device slows the
 * simulation down instead of spiralling). The advance counts whether the frames in between were
 * updated or skipped by a draw cache; the catch-up limit after a long gap is
 * max(0.25 s, 4 steps), so a 1-3 steps/s simulation still steps (catchUpLimit).
 * Sleep (runtime contract F2): after a step, a constraint falls asleep when every simulated channel
 * is at rest: its velocity, its residual force and its distance from equilibrium (residual /
 * strength) each move the bone's tip less than SETTLE_PIXELS. Asleep, it does not integrate (the
 * skipped steps would be no-ops) and only the current frame's time counts, so a cached and an
 * uncached run wake identically. It wakes on motion fed in (the skeleton moved or turned under it,
 * the shown origin changed), on a reset (reset key, resetPhysics, outfit activation) and when the
 * forces at the current pose no longer balance. Dropped time counts as a teleport: on such a frame the
 * motion fed to inertia is scaled by simulated time / frame time, so a long stall (a GC pause)
 * does not whip the cloth with a whole stall's displacement that only 4 steps of spring relax. Identical inputs give identical output on one engine.
 * Modes (Skeleton.updateWorldTransform): `update` simulates and applies; `pose` applies the
 * current offsets without simulating (no time is consumed and motion is ignored); `reset` snaps
 * to the pose first; `none` skips the constraint, which then snaps to the pose the next time it
 * runs (the same happens while `mix` is 0, after a reset key, and when a skin turns it on).
 */
import type { Bone, SkeletonFrame } from "./bone.js";
import type { PhysicsPose } from "./constraintPose.js";
import type { PhysicsConstraintData } from "./format.js";
import { DEG_TO_RAD, rotateLinear, wrapRadians, vectorLength } from "./math.js";

/** How updateWorldTransform treats physics constraints this pass. */
export type PhysicsMode = "none" | "reset" | "update" | "pose";

/** The skeleton as physics sees it: where it is, the physics clock and this pass's mode. */
export interface PhysicsClock extends SkeletonFrame {
  readonly time: number;
  /** The clock's last advance (seconds, already clamped): the time an asleep constraint counts on waking. */
  readonly frameDelta: number;
  readonly physicsMode: PhysicsMode;
}

/** Longest frame (seconds) the physics clock advances by in one update. */
export const MAX_FRAME_DELTA = 0.25;
/** Most fixed simulation steps one constraint takes per frame. */
export const MAX_PHYSICS_STEPS = 4;

/**
 * Longest clock advance (seconds) one update consumes: MAX_FRAME_DELTA, but never less than
 * MAX_PHYSICS_STEPS steps, so a low-frequency simulation (1-3 steps/s) is not stalled by it.
 */
export function catchUpLimit(step: number): number {
  return Math.max(MAX_FRAME_DELTA, MAX_PHYSICS_STEPS * step);
}

/**
 * Stability of the spring integrator for `data` (see the module comment, F7): s = strength * h^2 /
 * mass with h = 1 / fps, and the bound 2 (1 + damping^(60 h)) that s must stay below.
 */
export function springStability(data: Pick<PhysicsConstraintData, "strength" | "mass" | "damping" | "fps">): { s: number; bound: number } {
  const h = 1 / data.fps;
  return { s: (data.strength * h * h) / data.mass, bound: 2 * (1 + Math.pow(data.damping, 60 * h)) };
}

/** Offsets (px, radians, relative length) or velocities beyond this count as a blown-up simulation (F7). */
export const MAX_PHYSICS_STATE = 1e6;

/** Below this many pixels a bone has no lever for forces or length changes. */
const MIN_LENGTH = 1e-4;
/** Accumulated-time slack, so frames that are whole multiples of the step never lose one to rounding. */
const STEP_SLACK = 1e-9;
/**
 * Settled threshold (runtime contract F2): the simulation counts as settled when the next step
 * would move every simulated channel by less than this many pixels (angles and length changes
 * measured at the bone's tip).
 */
export const SETTLE_PIXELS = 1e-3;

export class PhysicsConstraint {
  readonly data: PhysicsConstraintData;
  readonly pose: PhysicsPose;
  readonly bone: Bone;
  private readonly clock: PhysicsClock;

  // Simulation state (offsets from the animated pose and their velocities).
  /** Translation offset, world px. */
  offsetX = 0;
  offsetY = 0;
  velocityX = 0;
  velocityY = 0;
  /** Angle offset, radians (positive turns clockwise on the canvas). */
  rotateOffset = 0;
  rotateVelocity = 0;
  /** Relative length change (0 = rest length). */
  scaleOffset = 0;
  scaleVelocity = 0;

  /**
   * True when the last simulated update left the springs at rest (the next step would move every
   * channel by less than SETTLE_PIXELS), or the constraint shows nothing (mix 0, mode none). A
   * held-pose cache may skip a settled simulation; an unsettled one must keep being updated as its
   * clock runs (runtime contract F2). False after a reset until a step runs.
   */
  settled = false;
  /** Times the finite-state guard snapped a blown-up simulation back to the pose (F7). */
  recoveries = 0;
  private needsReset = true;
  /** This update's bone angle and length (inputs of fedMotion and resting). */
  private frameBase = 0;
  private frameLength = 0;
  private lastTime = 0;
  private remaining = 0;
  /** The bone's world origin last frame, before the translation offset (translation input). */
  private anchorX = 0;
  private anchorY = 0;
  /** The bone's world origin last frame, after the translation offset (angle and length input). */
  private shownX = 0;
  private shownY = 0;
  /** The simulated tip last frame, relative to (shownX, shownY). */
  private tipX = 0;
  private tipY = 0;

  constructor(data: PhysicsConstraintData, pose: PhysicsPose, bone: Bone, clock: PhysicsClock) {
    this.data = data;
    this.pose = pose;
    this.bone = bone;
    this.clock = clock;
  }

  /**
   * True when an update at clock time `time` would run at least one fixed step (or the pending
   * reset snap): the clock moved by a step or more since the last update, counting the carried
   * remainder. A 60 Hz frame between steps of a 30 fps simulation runs none (F2 cache gate).
   */
  stepDue(time: number): boolean {
    if (this.needsReset || this.pose.resetRequested) return true;
    if (this.settled) return false;
    const step = 1 / this.data.fps;
    const delta = Math.min(catchUpLimit(step), Math.max(0, time - this.lastTime));
    return this.remaining + delta + STEP_SLACK >= step;
  }

  /** Clears the simulation; the next update snaps to the pose it finds. */
  reset(): void {
    this.offsetX = 0;
    this.offsetY = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.rotateOffset = 0;
    this.rotateVelocity = 0;
    this.scaleOffset = 0;
    this.scaleVelocity = 0;
    this.remaining = 0;
    this.needsReset = true;
    this.settled = false;
  }

  /** The skeleton moved by (x, y) on purpose (teleport, respawn): no reaction. */
  translate(x: number, y: number): void {
    this.anchorX += x;
    this.anchorY += y;
    this.shownX += x;
    this.shownY += y;
  }

  /** The skeleton turned by `degrees` about world (x, y) on purpose: no reaction. */
  rotate(x: number, y: number, degrees: number): void {
    const r = degrees * DEG_TO_RAD;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    let dx = this.anchorX - x;
    let dy = this.anchorY - y;
    this.anchorX = x + cos * dx - sin * dy;
    this.anchorY = y + sin * dx + cos * dy;
    dx = this.shownX - x;
    dy = this.shownY - y;
    this.shownX = x + cos * dx - sin * dy;
    this.shownY = y + sin * dx + cos * dy;
    const tipX = this.tipX;
    this.tipX = cos * tipX - sin * this.tipY;
    this.tipY = sin * tipX + cos * this.tipY;
  }

  /** Runs in update order, after the bone's world transform is current. */
  update(): void {
    const pose = this.pose;
    const clock = this.clock;
    const mode = clock.physicsMode;
    if (pose.resetRequested) {
      pose.resetRequested = false;
      this.reset();
    }
    if (mode === "none" || pose.mix <= 0) {
      this.reset();
      // Nothing is simulated or shown; it snaps to the pose when it runs again.
      this.settled = true;
      return;
    }
    if (mode === "reset") this.reset();

    const data = this.data;
    const bone = this.bone;
    const w = bone.world;
    const translates = data.x > 0 || data.y > 0;
    const turns = data.rotate > 0 || data.shearX > 0;
    const scales = data.scaleX > 0;
    const length = bone.data.length * vectorLength(w.a, w.c);
    const base = Math.atan2(w.c, w.a);
    const mix = pose.mix;

    if (this.needsReset) {
      this.needsReset = false;
      this.lastTime = clock.time;
      this.anchorX = this.shownX = w.x;
      this.anchorY = this.shownY = w.y;
      this.tipX = Math.cos(base) * length;
      this.tipY = Math.sin(base) * length;
      return;
    }

    const step = 1 / data.fps;
    const accel = step / data.mass;
    const asleep = this.settled;
    let delta = mode === "pose" ? 0 : clock.time - this.lastTime;
    this.lastTime = clock.time;
    if (!(delta > 0)) delta = 0;
    // Asleep, the skipped steps were no-ops: only this frame's time counts, whether the frames in
    // between were updated or skipped by a draw cache.
    else if (asleep) delta = Math.min(delta, clock.frameDelta);
    else delta = Math.min(delta, catchUpLimit(step));
    const maxMove = data.limit * delta;
    const inertia = data.inertia;
    // Stays asleep while nothing feeds motion in and the forces at this pose still balance.
    // (Inputs go through fields: doubles passed to a call that is not inlined are boxed per frame.)
    this.frameBase = base;
    this.frameLength = length;
    const dozing = asleep && !this.fedMotion() && this.resting();

    // Fixed steps this frame.
    let steps = 0;
    /** Fraction of this frame's motion fed to inertia (below 1 only when steps were dropped). */
    let moveScale = 1;
    if (dozing) {
      this.remaining = 0;
    } else if (delta > 0) {
      let remaining = this.remaining + delta;
      while (remaining + STEP_SLACK >= step && steps < MAX_PHYSICS_STEPS) {
        remaining -= step;
        steps++;
      }
      if (remaining < 0) remaining = 0;
      else if (remaining >= step) {
        // Over the step cap: drop whole steps, and treat the dropped time like a teleport.
        const kept = remaining % step;
        moveScale = (delta - (remaining - kept)) / delta;
        remaining = kept;
      }
      this.remaining = remaining;
    }
    const damping = Math.pow(data.damping, 60 * step);
    const strength = data.strength;
    const gravity = data.gravity;
    const wind = data.wind;
    /** Share of the input motion fed in (0 while dozing: below the wake threshold). */
    const feed = dozing ? 0 : inertia;

    // The bone's own displacement since last frame; the part from dropped time is ignored below.
    const droppedX = (this.anchorX - w.x) * (1 - moveScale);
    const droppedY = (this.anchorY - w.y) * (1 - moveScale);

    // Translation: input, springs, apply.
    if (translates) {
      let moveX = this.anchorX - w.x;
      let moveY = this.anchorY - w.y;
      if (moveX > maxMove) moveX = maxMove;
      else if (moveX < -maxMove) moveX = -maxMove;
      if (moveY > maxMove) moveY = maxMove;
      else if (moveY < -maxMove) moveY = -maxMove;
      moveX *= moveScale;
      moveY *= moveScale;
      let offsetX = this.offsetX + moveX * feed;
      let offsetY = this.offsetY + moveY * feed;
      let velocityX = this.velocityX;
      let velocityY = this.velocityY;
      for (let i = 0; i < steps; i++) {
        velocityX += (wind - strength * offsetX) * accel;
        offsetX += velocityX * step;
        velocityX *= damping;
        velocityY += (gravity - strength * offsetY) * accel;
        offsetY += velocityY * step;
        velocityY *= damping;
      }
      // Finite-state guard (F7): NaN fails the comparison too.
      if (!(Math.abs(offsetX) + Math.abs(offsetY) + Math.abs(velocityX) + Math.abs(velocityY) < MAX_PHYSICS_STATE)) {
        offsetX = offsetY = velocityX = velocityY = 0;
        this.recoveries++;
      }
      this.offsetX = offsetX;
      this.offsetY = offsetY;
      this.velocityX = velocityX;
      this.velocityY = velocityY;
    }
    this.anchorX = w.x;
    this.anchorY = w.y;
    if (translates) {
      w.x += this.offsetX * mix * data.x;
      w.y += this.offsetY * mix * data.y;
    }

    // Angle and length: input from where the simulated tip was, springs, apply.
    if (turns || scales) {
      // Shown origin motion (bone displacement plus the change of the translation offset).
      let moveX = this.shownX - w.x - droppedX;
      let moveY = this.shownY - w.y - droppedY;
      if (moveX > maxMove) moveX = maxMove;
      else if (moveX < -maxMove) moveX = -maxMove;
      if (moveY > maxMove) moveY = maxMove;
      else if (moveY < -maxMove) moveY = -maxMove;
      let angle = this.rotateOffset;
      let angleVelocity = this.rotateVelocity;
      let stretch = this.scaleOffset;
      let stretchVelocity = this.scaleVelocity;
      if (length > MIN_LENGTH) {
        if (delta > 0 && feed !== 0) {
          if (turns) angle += wrapRadians(Math.atan2(this.tipY + moveY, this.tipX + moveX) - (base + angle)) * feed;
          if (scales) stretch += ((moveX * Math.cos(base + angle) + moveY * Math.sin(base + angle)) * feed) / length;
        }
        for (let i = 0; i < steps; i++) {
          const cos = Math.cos(base + angle);
          const sin = Math.sin(base + angle);
          if (turns) {
            angleVelocity += ((gravity * cos - wind * sin) / length - strength * angle) * accel;
            angle += angleVelocity * step;
            angleVelocity *= damping;
          }
          if (scales) {
            stretchVelocity += ((wind * cos + gravity * sin) / length - strength * stretch) * accel;
            stretch += stretchVelocity * step;
            stretchVelocity *= damping;
          }
        }
      } else {
        // No lever: only the springs act.
        for (let i = 0; i < steps; i++) {
          angleVelocity -= strength * angle * accel;
          angle += angleVelocity * step;
          angleVelocity *= damping;
          stretchVelocity -= strength * stretch * accel;
          stretch += stretchVelocity * step;
          stretchVelocity *= damping;
        }
      }
      if (!(Math.abs(angle) + Math.abs(angleVelocity) + Math.abs(stretch) + Math.abs(stretchVelocity) < MAX_PHYSICS_STATE)) {
        angle = angleVelocity = stretch = stretchVelocity = 0;
        this.recoveries++;
      }
      this.rotateOffset = angle;
      this.rotateVelocity = angleVelocity;
      this.scaleOffset = stretch;
      this.scaleVelocity = stretchVelocity;
      this.tipX = Math.cos(base + angle) * length;
      this.tipY = Math.sin(base + angle) * length;

      if (turns) {
        const shown = angle * mix;
        if (data.shearX > 0) {
          // Shear turns the X axis further than the Y axis.
          turnColumn(w, shown * (data.rotate + data.shearX), true);
          turnColumn(w, shown * data.rotate, false);
        } else {
          rotateLinear(w, shown * data.rotate);
        }
      }
      if (scales) {
        const factor = 1 + stretch * mix * data.scaleX;
        w.a *= factor;
        w.c *= factor;
      }
    }
    this.shownX = w.x;
    this.shownY = w.y;
    if (steps > 0) {
      // Falls asleep only after a step, when every channel is at rest (velocity, residual force and
      // distance from equilibrium); the leftover velocity and step phase are cleared with it, so
      // the nap is exactly a no-op whether its frames run or are skipped.
      this.settled = this.resting();
      if (this.settled) {
        this.velocityX = this.velocityY = this.rotateVelocity = this.scaleVelocity = 0;
        this.remaining = 0;
      }
    } else if (!dozing && (delta > 0 || asleep)) {
      // Time without a step, or motion fed in: awake until a step finds it at rest.
      this.settled = false;
    }
    bone.enforceLimits();
  }

  /**
   * True when this update would feed motion in beyond WAKE_PIXELS: the bone's origin moved since
   * the last update, the shown origin changed (translation offset or mix), or the bone turned or
   * changed length under the simulated tip.
   */
  private fedMotion(): boolean {
    const data = this.data;
    const w = this.bone.world;
    const x = w.x;
    const y = w.y;
    const base = this.frameBase;
    const length = this.frameLength;
    const mix = this.pose.mix;
    let motion = Math.abs(this.anchorX - x) + Math.abs(this.anchorY - y);
    if (data.rotate > 0 || data.shearX > 0 || data.scaleX > 0) {
      const shownX = x + (data.x > 0 ? this.offsetX * mix * data.x : 0);
      const shownY = y + (data.y > 0 ? this.offsetY * mix * data.y : 0);
      motion += Math.abs(this.shownX - shownX) + Math.abs(this.shownY - shownY);
      if (length > MIN_LENGTH) {
        motion += Math.abs(wrapRadians(Math.atan2(this.tipY, this.tipX) - (base + this.rotateOffset))) * length;
        motion += Math.abs(vectorLength(this.tipX, this.tipY) - length);
      }
    }
    return !(motion < WAKE_PIXELS);
  }

  /**
   * Sleep criterion: every simulated channel moves the bone's tip less than SETTLE_PIXELS by its
   * velocity over a step, by its residual force over a step, and by its distance from equilibrium
   * (residual / strength; with no spring any residual force keeps it awake).
   */
  private resting(): boolean {
    const data = this.data;
    const base = this.frameBase;
    const length = this.frameLength;
    const step = 1 / data.fps;
    const accel = step / data.mass;
    const strength = data.strength;
    const gravity = data.gravity;
    const wind = data.wind;
    if (data.x > 0 || data.y > 0) {
      restArgs[0] = this.velocityX; restArgs[1] = wind - strength * this.offsetX; restArgs[2] = strength; restArgs[3] = step; restArgs[4] = accel; restArgs[5] = 1;
      if (!channelAtRest()) return false;
      restArgs[0] = this.velocityY; restArgs[1] = gravity - strength * this.offsetY;
      if (!channelAtRest()) return false;
    }
    const turns = data.rotate > 0 || data.shearX > 0;
    const scales = data.scaleX > 0;
    if (turns || scales) {
      const lever = length > MIN_LENGTH ? length : 1;
      const cos = Math.cos(base + this.rotateOffset);
      const sin = Math.sin(base + this.rotateOffset);
      const torque = length > MIN_LENGTH ? (gravity * cos - wind * sin) / length : 0;
      const pull = length > MIN_LENGTH ? (wind * cos + gravity * sin) / length : 0;
      restArgs[2] = strength; restArgs[3] = step; restArgs[4] = accel; restArgs[5] = lever;
      if (turns) {
        restArgs[0] = this.rotateVelocity; restArgs[1] = torque - strength * this.rotateOffset;
        if (!channelAtRest()) return false;
      }
      if (scales) {
        restArgs[0] = this.scaleVelocity; restArgs[1] = pull - strength * this.scaleOffset;
        if (!channelAtRest()) return false;
      }
    }
    return true;
  }
}

/** Motion (px) below which an asleep constraint ignores its input and stays asleep. */
const WAKE_PIXELS = 1e-6;

/**
 * Inputs of channelAtRest: velocity, residual, strength, step, accel, lever. Passed through an array
 * because doubles handed to a call that V8 does not inline are boxed on the heap every frame
 * (src/pixi/allocation.test.ts).
 */
const restArgs = new Float64Array(6);

/** One channel of the sleep criterion (PhysicsConstraint.resting), reading restArgs; `lever` converts to tip pixels. */
function channelAtRest(): boolean {
  const velocity = restArgs[0] as number;
  const residual = restArgs[1] as number;
  const strength = restArgs[2] as number;
  const step = restArgs[3] as number;
  const accel = restArgs[4] as number;
  const lever = restArgs[5] as number;
  if (!(Math.abs(velocity) * step * lever < SETTLE_PIXELS)) return false;
  if (!(Math.abs(residual) * accel * step * lever < SETTLE_PIXELS)) return false;
  const distance = strength > 0 ? Math.abs(residual) / strength : Math.abs(residual) > 0 ? Infinity : 0;
  return distance * lever < SETTLE_PIXELS;
}

/** Turns one column of a world matrix: the X axis (a, c) or the Y axis (b, d). */
function turnColumn(w: Bone["world"], radians: number, xAxis: boolean): void {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  if (xAxis) {
    const a = w.a;
    w.a = cos * a - sin * w.c;
    w.c = sin * a + cos * w.c;
  } else {
    const b = w.b;
    w.b = cos * b - sin * w.d;
    w.d = sin * b + cos * w.d;
  }
}
