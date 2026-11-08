
/**
 * Hit feedback (punchy hit-stop crunch) layered on top of the existing sprites: hitstop, impact flash, visual push,
 * screen shake, damage pops and dodge cues. Purely visual. Nothing here delays input, network or prediction: the
 * hitstop only changes the clock that ANIMATIONS sample, and the push only offsets the drawn sprite.
 *
 * Every helper is a pure function of elapsed milliseconds so the overlay can sample it per frame without allocating.
 * Constants table: docs/plans/hit-feedback.md.
 */

export type HitStrength = "swing" | "finisher" | "shot" | "incoming";

type HitTuning = Readonly<{
  /** Animation sampling is frozen this long after the hit. */
  holdMs: number;
  /** Peak sprite push away from the attacker, in screen px. */
  pushPx: number;
}>;

export const HIT_TUNING: Readonly<Record<HitStrength, HitTuning>> = {
  swing: { holdMs: 60, pushPx: 8 },
  finisher: { holdMs: 90, pushPx: 12 },
  shot: { holdMs: 45, pushPx: 6 },
  /** The local player getting hit: lighter, so taking hits never feels sluggish. */
  incoming: { holdMs: 35, pushPx: 5 }
};

/** After the hold, animations run fast for this long to catch back up to the real clock (no permanent lag). */
export const HITSTOP_CATCHUP_MS = 90;
/** Share of the push applied at once on the impact frame (the rest eases out after the hold). */
export const PUSH_IMPACT_SHARE = 0.55;
export const PUSH_OUT_MS = 45;
export const PUSH_RETURN_MS = 170;
/** Victim tremble while frozen, in px (alternates every ~frame). */
export const HOLD_JITTER_PX = 1.5;
/** White additive flash: full during the hold, then fades over this long. */
export const IMPACT_FLASH_ALPHA = 0.85;
export const IMPACT_FLASH_FADE_MS = 80;
/** Red hit tint after the white flash (multiplied, 0..1 strength) and how long it fades. */
export const IMPACT_RED_STRENGTH = 0.55;
export const IMPACT_RED_MS = 220;
/** Impact spark + slash mark at the contact point. */
export const IMPACT_SPARK_MS = 190;
export const IMPACT_SLASH_MS = 140;

export type ShakeKind = "finisher" | "bigHit" | "signature" | "kill";
export const SHAKE_TUNING: Readonly<Record<ShakeKind, Readonly<{ amplitudePx: number; durationMs: number }>>> = {
  finisher: { amplitudePx: 3, durationMs: 140 },
  bigHit: { amplitudePx: 5, durationMs: 200 },
  signature: { amplitudePx: 6, durationMs: 240 },
  /** The killing blow: a bigger rumble than the finisher. */
  kill: { amplitudePx: 4.5, durationMs: 190 }
};

export type KickKind = "hit" | "kill" | "dash";
/** A one-shot directional screen kick along the swing: out fast, back eased. Scaled by the shake setting. */
export const KICK_TUNING: Readonly<Record<KickKind, Readonly<{ px: number; durationMs: number }>>> = {
  hit: { px: 1.5, durationMs: 90 },
  kill: { px: 4, durationMs: 150 },
  /** The dash burst: the view leans into the dash for a moment. */
  dash: { px: 3, durationMs: 130 }
};
/** Share of a kick spent travelling out (the rest eases back). */
export const KICK_OUT_SHARE = 0.25;

/** Kick distance 0..1 of its peak `elapsedMs` into a kick of `durationMs` (0 outside it). */
export function kickFraction(elapsedMs: number, durationMs: number): number {
  if (!(elapsedMs >= 0) || elapsedMs >= durationMs || durationMs <= 0) return 0;
  const u = elapsedMs / durationMs;
  if (u < KICK_OUT_SHARE) return easeOutCubic(u / KICK_OUT_SHARE);
  return 1 - easeInOutCubic((u - KICK_OUT_SHARE) / (1 - KICK_OUT_SHARE));
}
/** "Reduced" screen shake scales every shake by this. */
export const SHAKE_REDUCED_SCALE = 0.4;
/** An incoming hit at or above this share of max HP shakes the screen. */
export const BIG_HIT_HEALTH_SHARE = 0.12;

/** Damage number pop: starts big, overshoots small, settles at 1. */
export const DAMAGE_POP_IN_MS = 90;
export const DAMAGE_POP_SETTLE_MS = 80;
export const DAMAGE_POP_START_SCALE = 1.7;
export const DAMAGE_POP_BIG_START_SCALE = 2.25;
export const DAMAGE_POP_INCOMING_START_SCALE = 1.5;
export const DAMAGE_POP_UNDERSHOOT = 0.9;
/** Finisher / big-hit numbers stay this much larger after settling. */
export const DAMAGE_BIG_SETTLED_SCALE = 1.15;
/** DODGE text: quick pop, short life. */
export const DODGE_VISIBLE_MS = 900;
/** i-frame shimmer cycles over the dash i-frames. */
export const IFRAME_SHIMMER_CYCLES = 2;

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  const v = clamp01(t);
  return v < 0.5 ? 4 * v * v * v : 1 - ((-2 * v + 2) ** 3) / 2;
}

/**
 * How far animation sampling lags the real clock `elapsedMs` after a hit: it grows with the clock during the hold
 * (sampling frozen), then shrinks to 0 over the catch-up (animations play slightly fast). The sampled time
 * (now - lag) never goes backwards.
 */
export function hitstopLag(elapsedMs: number, holdMs: number, catchUpMs = HITSTOP_CATCHUP_MS): number {
  if (!(elapsedMs >= 0) || holdMs <= 0) return 0;
  if (elapsedMs < holdMs) return elapsedMs;
  if (catchUpMs <= 0) return 0;
  const after = elapsedMs - holdMs;
  return after < catchUpMs ? holdMs * (1 - after / catchUpMs) : 0;
}

/** True while the hit's sampling is frozen (the hold, not the catch-up). */
export function hitstopHeld(elapsedMs: number, holdMs: number): boolean {
  return elapsedMs >= 0 && elapsedMs < holdMs;
}

/** Push 0..1 of `pushPx`: part at once on impact, the rest after the hold, then an eased return. */
export function pushFraction(elapsedMs: number, holdMs: number): number {
  if (!(elapsedMs >= 0)) return 0;
  if (elapsedMs < holdMs) return PUSH_IMPACT_SHARE;
  const out = elapsedMs - holdMs;
  if (out < PUSH_OUT_MS) return PUSH_IMPACT_SHARE + (1 - PUSH_IMPACT_SHARE) * easeOutCubic(out / PUSH_OUT_MS);
  const back = out - PUSH_OUT_MS;
  if (back < PUSH_RETURN_MS) return 1 - easeInOutCubic(back / PUSH_RETURN_MS);
  return 0;
}

export function pushDurationMs(holdMs: number): number {
  return holdMs + PUSH_OUT_MS + PUSH_RETURN_MS;
}

/** Tremble while frozen: +-HOLD_JITTER_PX, flipping roughly every frame (0 outside the hold). */
export function holdJitterPx(elapsedMs: number, holdMs: number): number {
  if (!hitstopHeld(elapsedMs, holdMs)) return 0;
  return (Math.floor(elapsedMs / 16) % 2 === 0 ? 1 : -1) * HOLD_JITTER_PX;
}

/** Additive white flash alpha: full during the hold, then a quick quadratic fade. */
export function impactFlashAlpha(elapsedMs: number, holdMs: number): number {
  if (!(elapsedMs >= 0)) return 0;
  if (elapsedMs < holdMs) return IMPACT_FLASH_ALPHA;
  const fade = 1 - (elapsedMs - holdMs) / IMPACT_FLASH_FADE_MS;
  return fade > 0 ? IMPACT_FLASH_ALPHA * fade * fade : 0;
}

/** Red multiply strength 0..1: rises as the white flash fades, then decays. */
export function impactRedStrength(elapsedMs: number, holdMs: number): number {
  if (!(elapsedMs >= 0) || elapsedMs >= holdMs + IMPACT_RED_MS) return 0;
  if (elapsedMs < holdMs) return IMPACT_RED_STRENGTH * 0.5;
  const u = (elapsedMs - holdMs) / IMPACT_RED_MS;
  return IMPACT_RED_STRENGTH * (1 - u) * (1 - u);
}

/** The warm red multiply tint for a strength 0..1 (0xffffff at 0); the existing mob hit tint uses the same ramp. */
export function redTint(strength: number): number {
  if (!(strength > 0)) return 0xffffff;
  const channel = Math.round(255 - 165 * Math.min(1, strength));
  return 0xff0000 | (channel << 8) | channel;
}

/** Darker of two tints per channel (multiply-style combine of two red tints without allocating). */
export function minTint(a: number, b: number): number {
  const r = Math.min((a >> 16) & 0xff, (b >> 16) & 0xff);
  const g = Math.min((a >> 8) & 0xff, (b >> 8) & 0xff);
  const bl = Math.min(a & 0xff, b & 0xff);
  return (r << 16) | (g << 8) | bl;
}

/** Shake offset `elapsedMs` into a shake (quadratic decay, two incommensurate wobbles); writes into `out`. */
export function shakeOffset(elapsedMs: number, amplitudePx: number, durationMs: number, out: { x: number; y: number }): boolean {
  if (!(elapsedMs >= 0) || elapsedMs >= durationMs || amplitudePx <= 0) {
    out.x = 0;
    out.y = 0;
    return false;
  }
  const decay = (1 - elapsedMs / durationMs) ** 2;
  out.x = amplitudePx * decay * Math.sin(elapsedMs * 0.09);
  out.y = amplitudePx * decay * 0.8 * Math.sin(elapsedMs * 0.071 + 1.7);
  return true;
}

export type ScreenShakeSetting = "full" | "reduced" | "off";

export function shakeScale(setting: ScreenShakeSetting, reducedMotion: boolean): number {
  if (reducedMotion || setting === "off") return 0;
  return setting === "reduced" ? SHAKE_REDUCED_SCALE : 1;
}

/** One screen shake at a time (plus one directional kick); a new shake replaces the current only when it is stronger right now. */
export class ScreenShakeState {
  private startMs = 0;
  private amplitudePx = 0;
  private durationMs = 0;
  private kickStartMs = 0;
  private kickPx = 0;
  private kickDurationMs = 0;
  private kickDirX = 0;
  private kickDirY = 0;

  /**
   * A short push of the whole view along the screen direction (`dirX`, `dirY`, unit length), starting at `startMs`
   * (may be in the future: the contact frame). A stronger kick replaces a weaker one that is still running.
   */
  kick(startMs: number, dirX: number, dirY: number, kind: KickKind, scale: number): boolean {
    const tuning = KICK_TUNING[kind];
    const px = tuning.px * scale;
    if (px <= 0 || (dirX === 0 && dirY === 0)) return false;
    if (this.kickPx > px && startMs - this.kickStartMs < this.kickDurationMs) return false;
    this.kickStartMs = startMs;
    this.kickPx = px;
    this.kickDurationMs = tuning.durationMs;
    this.kickDirX = dirX;
    this.kickDirY = dirY;
    hitFeedbackStats.kicks += 1;
    return true;
  }

  start(nowMs: number, kind: ShakeKind, scale: number): boolean {
    const tuning = SHAKE_TUNING[kind];
    const amplitude = tuning.amplitudePx * scale;
    if (amplitude <= 0) return false;
    if (this.remainingAmplitude(nowMs) > amplitude) return false;
    this.startMs = nowMs;
    this.amplitudePx = amplitude;
    this.durationMs = tuning.durationMs;
    hitFeedbackStats.shakeStarts += 1;
    return true;
  }

  private remainingAmplitude(nowMs: number): number {
    const elapsed = nowMs - this.startMs;
    if (this.amplitudePx <= 0 || elapsed < 0 || elapsed >= this.durationMs) return 0;
    return this.amplitudePx * (1 - elapsed / this.durationMs) ** 2;
  }

  /** Writes the offset for `nowMs`; false (and 0,0) when no shake or kick is running. */
  sample(nowMs: number, out: { x: number; y: number }): boolean {
    let running = false;
    out.x = 0;
    out.y = 0;
    if (this.amplitudePx > 0) {
      // A shake that has not started yet (a contact frame ahead) waits; one that has finished is retired.
      if (nowMs >= this.startMs) {
        running = shakeOffset(nowMs - this.startMs, this.amplitudePx, this.durationMs, out);
        if (!running) this.amplitudePx = 0;
      }
    }
    if (this.kickPx > 0) {
      const elapsed = nowMs - this.kickStartMs;
      if (elapsed >= this.kickDurationMs) {
        this.kickPx = 0;
      } else {
        running = true;
        const magnitude = this.kickPx * kickFraction(elapsed, this.kickDurationMs);
        out.x += this.kickDirX * magnitude;
        out.y += this.kickDirY * magnitude;
      }
    }
    return running;
  }

  clear(): void {
    this.amplitudePx = 0;
    this.kickPx = 0;
  }
}

/** The killing blow: extra attacker hitstop (a swing's is 60 ms, the finisher's 90 ms). */
export const KILL_HITSTOP_MS = 110;
/**
 * Death ghost: the removed mob takes a soft white flash (DEATH_FLASH_RISE_MS up, DEATH_FLASH_FALL_MS back down, both eased),
 * then fades out from DEATH_FADE_START_MS on an ease-out curve ((1 - u)^1.75: soft start, long tail) while it shrinks to DEATH_SHRINK_TO and sinks a little.
 * Everything is a continuous function of the per-frame clock; alpha is 0 at DEATH_GHOST_MS, where the ghost is removed.
 */
export const DEATH_GHOST_MS = 600;
export const DEATH_FLASH_RISE_MS = 35;
export const DEATH_FLASH_FALL_MS = 60;
export const DEATH_FADE_START_MS = 60;
export const DEATH_SHRINK_TO = 0.85;
/** How far the ghost sinks over the fade, as a fraction of its drawn height. */
export const DEATH_SINK_FRACTION = 0.05;
/** The name, bar and badges fade out over this long at the start (they are not part of the sprite's slow fade). */
export const DEATH_LABEL_FADE_MS = 120;
/** How long a recorded kill waits for the mob's removal to be drawn before it is forgotten. */
export const DEATH_MARK_TTL_MS = 3_000;

export type DeathGhostLook = { flash: number; alpha: number; scale: number; sink: number; labels: number };

/**
 * How the mob that was just killed looks `elapsedMs` after its death beat starts (the contact frame of the killing blow):
 * untouched while the beat is still ahead, a soft white flash, then a fade, shrink and sink. Writes into `out` (no allocation).
 * Reduced motion fades without shrinking or sinking. Null once finished.
 */
export function deathGhostLook(elapsedMs: number, reducedMotion: boolean, out: DeathGhostLook): DeathGhostLook | null {
  if (elapsedMs >= DEATH_GHOST_MS) return null;
  if (!(elapsedMs > 0)) {
    out.flash = 0;
    out.alpha = 1;
    out.scale = 1;
    out.sink = 0;
    out.labels = 1;
    return out;
  }
  const flashEnd = DEATH_FLASH_RISE_MS + DEATH_FLASH_FALL_MS;
  out.flash = elapsedMs >= flashEnd
    ? 0
    : IMPACT_FLASH_ALPHA * (elapsedMs < DEATH_FLASH_RISE_MS
      ? easeInOutCubic(elapsedMs / DEATH_FLASH_RISE_MS)
      : 1 - easeInOutCubic((elapsedMs - DEATH_FLASH_RISE_MS) / DEATH_FLASH_FALL_MS));
  const u = clamp01((elapsedMs - DEATH_FADE_START_MS) / (DEATH_GHOST_MS - DEATH_FADE_START_MS));
  out.alpha = (1 - u) ** 1.75;
  const settle = 1 - (1 - u) * (1 - u);
  out.scale = reducedMotion ? 1 : 1 - (1 - DEATH_SHRINK_TO) * settle;
  out.sink = reducedMotion ? 0 : DEATH_SINK_FRACTION * settle;
  out.labels = 1 - easeInOutCubic(elapsedMs / DEATH_LABEL_FADE_MS);
  return out;
}

export type DamagePopKind = "outgoing" | "incoming" | "big";

/** Damage number scale `elapsedMs` after it appears: a punchy scale-in that undershoots, then settles. */
export function damagePopScale(elapsedMs: number, kind: DamagePopKind, reducedMotion = false): number {
  const settled = kind === "big" ? DAMAGE_BIG_SETTLED_SCALE : 1;
  if (reducedMotion || !(elapsedMs >= 0)) return settled;
  const start = kind === "big" ? DAMAGE_POP_BIG_START_SCALE : kind === "incoming" ? DAMAGE_POP_INCOMING_START_SCALE : DAMAGE_POP_START_SCALE;
  const low = settled * DAMAGE_POP_UNDERSHOOT;
  if (elapsedMs < DAMAGE_POP_IN_MS) return start + (low - start) * easeOutCubic(elapsedMs / DAMAGE_POP_IN_MS);
  const settle = elapsedMs - DAMAGE_POP_IN_MS;
  if (settle < DAMAGE_POP_SETTLE_MS) return low + (settled - low) * easeInOutCubic(settle / DAMAGE_POP_SETTLE_MS);
  return settled;
}

/** i-frame shimmer 0..1 over `durationMs` (a couple of soft pulses that fade out). */
export function iframeShimmer(elapsedMs: number, durationMs: number): number {
  if (!(elapsedMs >= 0) || elapsedMs >= durationMs || durationMs <= 0) return 0;
  const u = elapsedMs / durationMs;
  const pulse = 0.5 - 0.5 * Math.cos(u * Math.PI * 2 * IFRAME_SHIMMER_CYCLES);
  return pulse * (1 - u * 0.5);
}

/** Pale blue multiply tint for an i-frame shimmer strength 0..1 (white at 0). */
export function shimmerTint(strength: number): number {
  if (!(strength > 0)) return 0xffffff;
  const s = Math.min(1, strength);
  const r = Math.round(255 - 95 * s);
  const g = Math.round(255 - 35 * s);
  return (r << 16) | (g << 8) | 0xff;
}

/**
 * Counters for tests and the perf probe (window.__ATLAS_ANIMATOR_HIT_FEEDBACK__). `disabled` turns every new effect off
 * (the perf comparison's baseline); it is never set by the game itself.
 */
export const hitFeedbackStats = {
  disabled: false,
  /** Draw world mobs with the old restart-on-every-delta glide instead of the snapshot buffer (the jitter comparison's baseline). */
  legacyMobSmoothing: false,
  /** Restore the old death (no ghost, the killing blow's number erased with its target, no extra kill hitstop or shake) for the before/after specs. */
  legacyDeathBeat: false,
  hitstops: 0,
  lastHitstopStartMs: Number.NaN,
  lastHitstopHoldMs: 0,
  incomingHits: 0,
  /** Death beat counters: floaters drawn while their target was already gone, ghosts started, the most alive at once. */
  orphanFloatersDrawn: 0,
  /** Every damage floater drawn (the labels list below keeps only the last 16). */
  floatersDrawnTotal: 0,
  deathGhostsStarted: 0,
  deathGhostsMaxActive: 0,
  /** When true, every drawn ghost frame is pushed to `deathGhostFrames` as [frameNowMs, alpha, scale, flash, x, y] (full-app specs). */
  deathGhostProbe: false,
  deathGhostFrames: [] as Array<[number, number, number, number, number, number]>,
  /** Labels of the last damage numbers drawn ("-12"), newest last (e2e: the killing blow's number). */
  floatersDrawn: [] as string[],
  shakeStarts: 0,
  kicks: 0,
  shakeFrames: 0,
  maxShakePx: 0,
  /** Frames during which at least one hitstop was holding an entity's sampling. */
  heldFrames: 0,
  /** Total ms spent in per-frame hit feedback work in the overlay, and frames counted. */
  frameWorkMs: 0,
  frames: 0,
  /** Total ms in the overlay's app.render() calls, and how many. */
  renderMs: 0,
  renders: 0
};

/** Per-frame drawn mob positions for the e2e jitter measurement (off by default; window.__ATLAS_ANIMATOR_MOB_PROBE__). */
export const mobRenderProbe = {
  enabled: false,
  /** [performance.now(), entityId, lat, lon] per mob per drawn frame. */
  frames: [] as Array<[number, string, number, number]>
};

if (typeof window !== "undefined") {
  (window as unknown as { __ATLAS_ANIMATOR_HIT_FEEDBACK__?: typeof hitFeedbackStats }).__ATLAS_ANIMATOR_HIT_FEEDBACK__ = hitFeedbackStats;
  (window as unknown as { __ATLAS_ANIMATOR_MOB_PROBE__?: typeof mobRenderProbe }).__ATLAS_ANIMATOR_MOB_PROBE__ = mobRenderProbe;
}

/** "Screen shake" setting, stored per device. Default full; OS reduced motion always turns shake off. */
const shakeKey = "atlasAnimator.screenShake.v1";
const shakeListeners = new Set<() => void>();

export function readStoredScreenShake(): ScreenShakeSetting {
  try {
    const stored = window.localStorage.getItem(shakeKey);
    return stored === "reduced" || stored === "off" ? stored : "full";
  } catch {
    return "full";
  }
}

let currentShake: ScreenShakeSetting = typeof window === "undefined" ? "full" : readStoredScreenShake();

export function screenShakeSetting(): ScreenShakeSetting {
  return currentShake;
}

export function setScreenShakeSetting(setting: ScreenShakeSetting): void {
  try { window.localStorage.setItem(shakeKey, setting); } catch { /* Still applies for this session. */ }
  currentShake = setting;
  for (const listener of shakeListeners) listener();
}

export function prefersReducedMotion(): boolean {
  try { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; }
}

/** The scale every shake is started with right now (setting x OS reduced motion). */
export function currentShakeScale(): number {
  return shakeScale(currentShake, prefersReducedMotion());
}
