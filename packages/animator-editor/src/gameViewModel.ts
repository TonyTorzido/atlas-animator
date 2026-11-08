/*
 * Atlas Animator editor: original implementation.
 *
 * Game view, the pure parts (no DOM, no Pixi; unit tested). The game view plays the clip being edited the way the project
 * shows a swing: on its own clock with the client's hit-stop (SwingEffectsState.sampleNowMs, the very code the overlay
 * uses), the client's flash / push / spark timings (hitFeedback.ts) and the slash fade (swingEffects.ts), driven by the
 * clip's own `hit` / `trailOn` / `trailOff` events. Everything here is a function of the clip and the clock.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { SwingEffectsState, arcFade } from "./preview/swingEffects.js";
import { HIT_TUNING, IMPACT_SPARK_MS, impactFlashAlpha, impactRedStrength, pushDurationMs, pushFraction, redTint, holdJitterPx } from "./preview/hitFeedback.js";
import { frameCount, frameTime, heldTime, timeToFrame } from "./clipModel.js";

/** Phone sizes the runtime draws the player at (CSS px per rig px), plus a 1x close-up. */
export const GAME_SCALES = [0.4, 0.471, 1] as const;
export type GameScale = (typeof GAME_SCALES)[number];

/** Blank space above the head and below the feet in a phone-size cell, CSS px. */
export const CELL_MARGIN = 45;

/**
 * CSS size of one view cell. A phone-size cell is as tall as the figure at that scale plus a margin, so the whole body shows;
 * the 1x cell is a fixed close-up crop around the torso (the whole figure would be over a thousand px tall). `span` is the
 * distance (rig px) the body and the target cover side by side.
 */
export function cellSize(scale: GameScale, figureHeight: number, span = 0): readonly [number, number] {
  if (scale === 1) return [520, 620];
  // A phone is about 390 CSS px wide; a swing that reaches further than that widens the cell so the body and the target both show.
  return [Math.max(390, Math.ceil(span * scale + 2 * 130)), Math.ceil(figureHeight * scale + 2 * CELL_MARGIN)];
}

/** Rest between two plays of the clip when it loops, seconds. */
export const LOOP_REST_S = 0.5;

export interface BiomeGround {
  id: string;
  label: string;
  ground: number;
  /** Tufts / speckles drawn over the ground, darker and lighter than `ground`. */
  dark: number;
  light: number;
}

/** Flat ground colours the project paints the map in (the view needs a base colour under the character, not a map). */
export const GROUNDS: readonly BiomeGround[] = [
  { id: "grass", label: "Grass", ground: 0x5d8c3a, dark: 0x4a7530, light: 0x78a64c },
  { id: "dirt", label: "Dirt", ground: 0x8a6a45, dark: 0x735637, light: 0xa08256 },
  { id: "sand", label: "Sand", ground: 0xd8c48a, dark: 0xc2ad72, light: 0xe8d8a4 },
  { id: "snow", label: "Snow", ground: 0xe3ecf0, dark: 0xc8d6de, light: 0xf8fcff },
  { id: "stone", label: "Stone", ground: 0x7a7f86, dark: 0x666b72, light: 0x90959c }
];

export type ClipEvent = ClipData["events"][number];

export interface TrailWindow {
  /** Seconds the trail starts / ends on. */
  on: number;
  off: number;
}

/** The trailOn / trailOff windows of a clip. A trailOn without a trailOff runs to the end of the clip. */
export function trailWindows(clip: Pick<ClipData, "events" | "duration">): TrailWindow[] {
  const on = clip.events.filter((e) => e.name === "trailOn").map((e) => e.time).sort((a, b) => a - b);
  const off = clip.events.filter((e) => e.name === "trailOff").map((e) => e.time).sort((a, b) => a - b);
  const out: TrailWindow[] = [];
  for (const start of on) {
    const end = off.find((t) => t > start) ?? clip.duration;
    if (out.length && out[out.length - 1]!.on === start) continue;
    out.push({ on: start, off: end });
  }
  return out;
}

/** Times of the clip's `hit` events, ascending. */
export function hitTimes(clip: Pick<ClipData, "events">): number[] {
  return clip.events.filter((e) => e.name === "hit").map((e) => e.time).sort((a, b) => a - b);
}

/** The events that fire when the clip clock moves from `prev` (exclusive) to `now` (inclusive). */
export function eventsCrossed(clip: Pick<ClipData, "events">, prev: number, now: number): ClipEvent[] {
  return clip.events.filter((e) => e.time > prev + 1e-9 && e.time <= now + 1e-9);
}

/** The frames the trail draws up to clip time `t`: every frame of each window already reached. */
export function trailFrames(clip: Pick<ClipData, "events" | "duration" | "fps">, t: number): { frame: number; window: number }[] {
  const out: { frame: number; window: number }[] = [];
  const windows = trailWindows(clip);
  windows.forEach((w, index) => {
    const a = timeToFrame(clip, w.on);
    const b = timeToFrame(clip, Math.min(w.off, t));
    for (let f = a; f <= b; f++) out.push({ frame: f, window: index });
  });
  return out;
}

/** The trail is drawn like the client's slash arc: it fades over ARC_FADE_MS, here stretched by this much so a comet tail shows. */
export const TRAIL_LIFE_SCALE = 2;

export interface TrailPoint {
  x: number;
  y: number;
  /** 0..1 opacity of the ribbon at this point. */
  alpha: number;
  window: number;
}

/**
 * The trail ribbon at clip time `t`: the tip of each frame of the open window, fading with age (arcFade). The tail of a
 * window that already closed keeps fading out after its trailOff. Points are tip positions in skeleton space.
 */
export function trailPoints(
  clip: Pick<ClipData, "events" | "duration" | "fps">,
  t: number,
  tipAtFrame: (frame: number) => { x: number; y: number } | null
): TrailPoint[] {
  const out: TrailPoint[] = [];
  for (const { frame, window } of trailFrames(clip, t)) {
    const ageMs = Math.max(0, (t - frameTime(clip, frame)) * 1000);
    const alpha = arcFade(ageMs / TRAIL_LIFE_SCALE);
    if (alpha <= 0) continue;
    const tip = tipAtFrame(frame);
    if (tip) out.push({ x: tip.x, y: tip.y, alpha, window });
  }
  return out;
}

/** Ribbon quad strip for the points of one window: the spine and the half widths (tapered toward the tail). */
export function ribbonOutline(points: readonly { x: number; y: number; alpha: number }[], halfWidth: number): { left: [number, number][]; right: [number, number][] } {
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  points.forEach((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const w = halfWidth * p.alpha;
    left.push([p.x - dy * w, p.y + dx * w]);
    right.push([p.x + dy * w, p.y - dx * w]);
  });
  return { left, right };
}

export interface HitLook {
  /** Additive white flash alpha, red multiply tint and push distance in screen px, plus the spark progress 0..1. */
  flash: number;
  tint: number;
  pushPx: number;
  sparkProgress: number;
  held: boolean;
}

const NO_HIT: HitLook = { flash: 0, tint: 0xffffff, pushPx: 0, sparkProgress: 1, held: false };

/** What the target looks like `elapsedMs` after the client's swing hit (flash, red tint, push with tremble, spark). */
export function hitLook(elapsedMs: number): HitLook {
  const { holdMs, pushPx } = HIT_TUNING.swing;
  if (!(elapsedMs >= 0) || elapsedMs >= pushDurationMs(holdMs) + 60) return NO_HIT;
  const push = pushPx * pushFraction(elapsedMs, holdMs) + holdJitterPx(elapsedMs, holdMs);
  return {
    flash: impactFlashAlpha(elapsedMs, holdMs),
    tint: redTint(impactRedStrength(elapsedMs, holdMs)),
    pushPx: push,
    sparkProgress: Math.min(1, elapsedMs / IMPACT_SPARK_MS),
    held: elapsedMs < holdMs
  };
}

/** Milliseconds after the latest hit at or before clip time `t` (NaN when none yet). */
export function msSinceHit(clip: Pick<ClipData, "events">, t: number): number {
  let last = Number.NaN;
  for (const h of hitTimes(clip)) if (h <= t + 1e-9) last = h;
  return Number.isNaN(last) ? Number.NaN : (t - last) * 1000;
}

export const ATTACKER = "player";
export const TARGET = "dummy";

export interface Step {
  /** Clip seconds the pose is sampled at (hit-stop frozen, then caught up), held to the clip's frames by the caller. */
  t: number;
  /** Seconds into the cycle including the rest after the clip (the walk underneath keeps running through it). */
  cycleT: number;
  /** Events that fired in this step. */
  fired: ClipEvent[];
  /** A new cycle started (the clip looped or was restarted). */
  restarted: boolean;
  /** Milliseconds on the real clock since the cycle's last hit (NaN before the first hit). */
  sinceHitMs: number;
  /** True while the attacker's sampling is frozen by a hit-stop. */
  held: boolean;
  /** The clip is done and not looping: the pose holds its last frame. */
  finished: boolean;
}

/**
 * The game view's clock: the real clock `nowMs`, and the sampling clock after hit-stop (the client's SwingEffectsState
 * with the attacker held when a `hit` event fires). One cycle plays the clip, rests LOOP_REST_S, then restarts when looping.
 */
export class GameClock {
  readonly effects = new SwingEffectsState();
  nowMs = 0;
  private cycleStartMs = 0;
  private prevT = -1e-6;
  private lastHitMs = Number.NaN;
  /** Seconds the cycle has run on the real clock when the last step ended (walk-under keeps its own phase). */
  cycles = 0;

  restart(): void {
    this.effects.clear();
    this.cycleStartMs = this.nowMs;
    this.prevT = -1e-6;
    this.lastHitMs = Number.NaN;
    this.cycles += 1;
  }

  /** Sampling time of the attacker right now, seconds into the cycle (before events of this step). */
  private sampled(): number {
    return (this.effects.sampleNowMs(ATTACKER, this.nowMs) - this.cycleStartMs) / 1000;
  }

  step(dtMs: number, clip: Pick<ClipData, "events" | "duration">, loop: boolean): Step {
    this.nowMs += Math.max(0, dtMs);
    let restarted = false;
    let t = this.sampled();
    if (t >= clip.duration + LOOP_REST_S && loop) {
      this.restart();
      restarted = true;
      t = 0;
    }
    const finished = !loop && t >= clip.duration;
    const clamped = Math.min(t, clip.duration);
    const fired = eventsCrossed(clip, this.prevT, clamped);
    for (const e of fired) {
      if (e.name === "hit") {
        // The client's own call: hit-stop on the target and the attacker, flash and push on the target.
        this.effects.addPredictedHit(TARGET, ATTACKER, this.nowMs, 1, 0, "swing");
        this.lastHitMs = this.nowMs;
      }
    }
    this.prevT = Math.max(this.prevT, clamped);
    this.effects.prune(this.nowMs);
    const cycleT = this.sampled();
    return {
      t: Math.min(cycleT, clip.duration),
      cycleT,
      fired,
      restarted,
      sinceHitMs: Number.isNaN(this.lastHitMs) ? Number.NaN : this.nowMs - this.lastHitMs,
      held: this.effects.isHeld(ATTACKER, this.nowMs),
      finished
    };
  }
}

export interface Placement {
  /** Which way the weapon reaches in skeleton space (-1 left, 1 right). */
  side: -1 | 1;
  /** Skeleton-space x the target's centre stands at. */
  x: number;
}

/** Half width of the training post (rig px); the weapon tip touches its near face a little inside. */
export const DUMMY_HALF_WIDTH = 60;
export const DUMMY_OVERLAP = 18;
export const MIN_REACH = 240;

/** Where the dummy stands: on the side the weapon tip is at the hit, at weapon range from the body. */
export function dummyPlacement(bodyX: number, tipX: number, halfWidth = DUMMY_HALF_WIDTH): Placement {
  const dx = tipX - bodyX;
  const side: -1 | 1 = dx < 0 ? -1 : 1;
  const reach = Math.max(MIN_REACH, Math.abs(dx) + halfWidth - DUMMY_OVERLAP);
  return { side, x: bodyX + side * reach };
}

/** Frame of the clip's first hit (or of its trail window's middle, or of the middle of the clip) for placing the dummy. */
export function reachFrame(clip: Pick<ClipData, "events" | "duration" | "fps">): number {
  const hit = hitTimes(clip)[0];
  if (hit !== undefined) return timeToFrame(clip, hit);
  const w = trailWindows(clip)[0];
  if (w) return timeToFrame(clip, (w.on + w.off) / 2);
  return Math.round(frameCount(clip) / 2);
}

export interface CellView {
  /** Where the skeleton origin sits in the cell (CSS px) and the scale: world.position = (x, y), world.scale = scale. */
  x: number;
  y: number;
  scale: number;
}

/**
 * The cell's camera. Phone sizes stand the feet CELL_MARGIN above the bottom edge; the 1x close-up centres the cell on
 * the torso (a point `figureHeight * 0.55` above the feet).
 */
export function cellView(scale: GameScale, feetY: number, figureHeight: number, centreX = 0, mirror = false, span = 0): CellView {
  const [w, h] = cellSize(scale, figureHeight, span);
  const y = scale === 1 ? h / 2 - (feetY - figureHeight * 0.55) * scale : h - CELL_MARGIN - feetY * scale;
  // The camera centres on `centreX` (skeleton space; the midpoint of the body and the target keeps both in frame).
  return { x: w / 2 - (mirror ? -1 : 1) * centreX * scale, y, scale };
}

/** Held clip time for a sampled time: the frame the project would show (the clip's fps), never past the end. */
export function shownTime(clip: Pick<ClipData, "fps" | "duration">, t: number): number {
  return Math.min(clip.duration, heldTime(clip, Math.max(0, t)));
}

/** Frame index (clip fps) of a shown time, for readouts. */
export function shownFrame(clip: Pick<ClipData, "fps" | "duration">, t: number): number {
  return timeToFrame(clip, shownTime(clip, t));
}
