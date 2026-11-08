import {
  HIT_TUNING,
  HITSTOP_CATCHUP_MS,
  IMPACT_SPARK_MS,
  hitFeedbackStats,
  hitstopHeld,
  hitstopLag,
  holdJitterPx,
  pushDurationMs,
  pushFraction,
  type HitStrength
} from "./hitFeedback.js";
import {
  BOW_SHOT_PROFILE,
  SWING_MAX_TARGETS,
  SWING_TARGET_RADIUS_M,
  shotLineContains,
  type ProjectileTransform,
  type ShotProfile,
  swingArcContains,
  toLocalMeters,
  type LocalMetersOut
} from "./combatGeometry.js";

/**
 * Action-combat hit feel: pooled slash arcs and impact sparks, plus the per-entity hit effects (white flash, hitstop
 * with catch-up, push away from the attacker). Pure state with fixed pools so the overlay draws it into one Graphics
 * layer without per-frame allocation. Times are performance.now() milliseconds. Timing curves: hitFeedback.ts.
 */

export const ARC_POOL_SIZE = 8;
export const SPARK_POOL_SIZE = 16;
/** The slash arc fades out over this long. */
export const ARC_FADE_MS = 180;
/** Impact spark + slash mark at the contact point. */
export const SPARK_DURATION_MS = IMPACT_SPARK_MS;
/** The slash arc starts this long before the contact frame, so it is bright as the blade crosses. */
export const ARC_LEAD_MS = 40;
export const SHOT_POOL_SIZE = 8;
/** A bow arrow flies its whole length (to the hit point or the full range) in this long, whatever the distance. */
export const SHOT_FLIGHT_MS = 150;
/** Arcane blast and holy arc bolts fly at this constant speed, so a far target takes longer than a near one. */
export const BOLT_SPEED_M_PER_S = 600;
/** The shortest a bolt's flight is drawn (a point-blank target still shows the bolt leave the staff). */
export const BOLT_MIN_FLIGHT_MS = 120;
/** The arrow stays at the end point this long after landing (the impact spark plays meanwhile). */
export const SHOT_LINGER_MS = 120;
/** The arcane blast's impact burst (flash + ring) plays this long after the bolt lands. */
export const ARCANE_BLAST_BURST_MS = 240;
/**
 * Default arcane blast colour: the bolt glow, its trail and the impact ring are tinted with the slot's `tint`, which
 * defaults to this (a swag effect profile can pass its own). The core is always a near-white blend of it.
 */
export const ARCANE_BLAST_TINT = 0x9b6bff;
/**
 * The Cleric's holy arc (scepter): the same procedural bolt and impact burst as the arcane blast, in white-gold, and
 * a heal burst on every ally it heals. One colour constant tints all three.
 */
export const HOLY_ARC_TINT = 0xffe39a;
/** A holy arc heal burst (soft ring, rising plus) plays this long on the healed ally. */
export const HOLY_HEAL_BURST_MS = 420;
/**
 * A predicted hit stays on record this long so the server's DAMAGE flash (same hit) is absorbed
 * instead of flashing twice. Its own flash and push end sooner.
 */
export const PREDICTED_HIT_RECORD_MS = 500;

export type SwingArcSlot = {
  active: boolean;
  startMs: number;
  lat: number;
  lon: number;
  /** World compass bearing of the facing (0 = north, 90 = east). */
  bearingDeg: number;
  /** Combo finisher: bigger and brighter. */
  finisher: boolean;
  /** Swinging entity ("" = unknown): its hitstop holds the arc's fade too. */
  ownerId: string;
};

export type SwingSparkSlot = {
  active: boolean;
  startMs: number;
  lat: number;
  lon: number;
  entityId: string;
  /** Screen-space hit direction (x right, y down), unit length; 0,0 = none (rays only). */
  dirX: number;
  dirY: number;
  /** Finisher-sized spark and slash. */
  big: boolean;
};

/**
 * "arrow": the weapon's projectile sprite. "arcane": the procedural arcane blast (or holy arc) bolt + impact burst.
 * "heal": a holy arc heal burst on the ally `targetId` (no flight).
 */
export type ShotKind = "arrow" | "arcane" | "heal";

export type ShotSlot = {
  active: boolean;
  kind: ShotKind;
  /** Arcane blast colour (0xRRGGBB); unused by arrows. */
  tint: number;
  /** Holy arc shot: drawn with a darker outline so it reads on pale ground. False for the staff blast. */
  holy: boolean;
  startMs: number;
  lat: number;
  lon: number;
  /** World compass bearing of the shot (0 = north, 90 = east). */
  bearingDeg: number;
  /** Distance flown in metres (distance to the mob hit, or the full range on a miss). */
  distanceM: number;
  /** How long the flight over `distanceM` takes (arrows: SHOT_FLIGHT_MS; bolts: boltFlightMs). */
  flightMs: number;
  /** Mob the shot hits ("" for a miss, or once the server disowned the prediction). */
  targetId: string;
  assetKey: string;
  transform: ProjectileTransform | null;
};

export type PredictedHit = {
  startMs: number;
  /** Screen-space swing direction (x right, y down), unit length. */
  dirX: number;
  dirY: number;
  strength: HitStrength;
  holdMs: number;
  pushPx: number;
};

type HitstopRecord = { startMs: number; holdMs: number };

/** Push distance in px `elapsedMs` into a hit of `strength` (impact share, eased out after the hold, eased back). */
export function nudgeMagnitudePx(elapsedMs: number, strength: HitStrength = "swing"): number {
  const tuning = HIT_TUNING[strength];
  return tuning.pushPx * pushFraction(elapsedMs, tuning.holdMs);
}

/** Arc opacity 1..0 over its life (0 when finished). */
export function arcFade(elapsedMs: number): number {
  if (!(elapsedMs >= 0) || elapsedMs >= ARC_FADE_MS) return 0;
  return 1 - elapsedMs / ARC_FADE_MS;
}

function createArcSlot(): SwingArcSlot {
  return { active: false, startMs: 0, lat: 0, lon: 0, bearingDeg: 0, finisher: false, ownerId: "" };
}
function createSparkSlot(): SwingSparkSlot {
  return { active: false, startMs: 0, lat: 0, lon: 0, entityId: "", dirX: 0, dirY: 0, big: false };
}

function createShotSlot(): ShotSlot {
  return {
    active: false, kind: "arrow", tint: ARCANE_BLAST_TINT, holy: false, startMs: 0, lat: 0, lon: 0, bearingDeg: 0, distanceM: 0, flightMs: SHOT_FLIGHT_MS, targetId: "",
    assetKey: "", transform: null
  };
}

/** How long a shot slot stays drawn after it left: its flight plus the arrow linger or the arcane burst. */
export function shotLifetimeMs(shot: Readonly<Pick<ShotSlot, "kind" | "flightMs">>): number {
  if (shot.kind === "heal") return HOLY_HEAL_BURST_MS;
  return shot.flightMs + (shot.kind === "arcane" ? ARCANE_BLAST_BURST_MS : SHOT_LINGER_MS);
}

/** Flight time of an arcane/holy bolt over `distanceM` metres: constant speed, never under BOLT_MIN_FLIGHT_MS. */
export function boltFlightMs(distanceM: number): number {
  if (!(distanceM > 0)) return BOLT_MIN_FLIGHT_MS;
  return Math.max(BOLT_MIN_FLIGHT_MS, (distanceM / BOLT_SPEED_M_PER_S) * 1_000);
}

/** 0..1 flight progress `elapsedMs` after the shot left (1 once it has landed). */
export function shotFlightProgress(elapsedMs: number, flightMs: number = SHOT_FLIGHT_MS): number {
  if (!(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / flightMs);
}

export class SwingEffectsState {
  readonly shots: ShotSlot[] = Array.from({ length: SHOT_POOL_SIZE }, createShotSlot);
  readonly arcs: SwingArcSlot[] = Array.from({ length: ARC_POOL_SIZE }, createArcSlot);
  readonly sparks: SwingSparkSlot[] = Array.from({ length: SPARK_POOL_SIZE }, createSparkSlot);
  /** Predicted hit effects by mob id: the overlay's flash and nudge read this. */
  readonly predictedHits = new Map<string, PredictedHit>();
  /** Manual-aim sector shown at the player's feet while the attack button is dragged (one reused slot). */
  readonly aimIndicator = { active: false, lat: 0, lon: 0, bearingDeg: 0 };
  /** Hitstop by entity id (the hit mobs, the attacker, the local player when hit). */
  private readonly stops = new Map<string, HitstopRecord>();

  private takeSlot<T extends { active: boolean; startMs: number }>(pool: T[]): T {
    let oldest = pool[0]!;
    for (const slot of pool) {
      if (!slot.active) return slot;
      if (slot.startMs < oldest.startMs) oldest = slot;
    }
    return oldest;
  }

  spawnArc(nowMs: number, lat: number, lon: number, bearingDeg: number, finisher: boolean, ownerId = ""): void {
    const slot = this.takeSlot(this.arcs);
    slot.ownerId = ownerId;
    slot.active = true;
    slot.startMs = nowMs;
    slot.lat = lat;
    slot.lon = lon;
    slot.bearingDeg = bearingDeg;
    slot.finisher = finisher;
  }

  /** A pooled projectile flight from (lat, lon) along `bearingDeg` for `distanceM`; `targetId` is the mob it hits ("" for none). */
  spawnShot(nowMs: number, lat: number, lon: number, bearingDeg: number, distanceM: number, targetId: string, assetKey: string, transform: ProjectileTransform): void {
    const slot = this.takeSlot(this.shots);
    slot.active = true;
    slot.kind = "arrow";
    slot.startMs = nowMs;
    slot.lat = lat;
    slot.lon = lon;
    slot.bearingDeg = bearingDeg;
    slot.distanceM = distanceM;
    slot.flightMs = SHOT_FLIGHT_MS;
    slot.targetId = targetId;
    slot.assetKey = assetKey;
    slot.transform = transform;
  }

  /**
   * A pooled arcane blast (staff, wand): a glowing bolt drawn procedurally along the same flight as an arrow, then an
   * impact burst on the mob it hits (`targetId`, "" for a miss: a small fizzle at the end point), in `tint`.
   */
  spawnArcaneBlast(nowMs: number, lat: number, lon: number, bearingDeg: number, distanceM: number, targetId: string, tint = ARCANE_BLAST_TINT, holy = false): void {
    const slot = this.takeSlot(this.shots);
    slot.active = true;
    slot.kind = "arcane";
    slot.tint = tint;
    slot.holy = holy;
    slot.startMs = nowMs;
    slot.lat = lat;
    slot.lon = lon;
    slot.bearingDeg = bearingDeg;
    slot.distanceM = distanceM;
    slot.flightMs = boltFlightMs(distanceM);
    slot.targetId = targetId;
    slot.assetKey = "";
    slot.transform = null;
  }

  /** A pooled holy arc heal burst on the healed ally `targetId`, starting at `nowMs` (drawn only while they are drawn). */
  spawnHealBurst(nowMs: number, targetId: string, tint = HOLY_ARC_TINT): void {
    const slot = this.takeSlot(this.shots);
    slot.active = true;
    slot.kind = "heal";
    slot.tint = tint;
    slot.holy = true;
    slot.startMs = nowMs;
    slot.lat = 0;
    slot.lon = 0;
    slot.bearingDeg = 0;
    slot.distanceM = 0;
    slot.flightMs = 0;
    slot.targetId = targetId;
    slot.assetKey = "";
    slot.transform = null;
  }

  setAimIndicator(lat: number, lon: number, bearingDeg: number): void {
    const aim = this.aimIndicator;
    aim.active = true;
    aim.lat = lat;
    aim.lon = lon;
    aim.bearingDeg = bearingDeg;
  }

  clearAimIndicator(): void {
    this.aimIndicator.active = false;
  }

  spawnSpark(nowMs: number, lat: number, lon: number, entityId: string, dirX = 0, dirY = 0, big = false): void {
    const slot = this.takeSlot(this.sparks);
    slot.active = true;
    slot.startMs = nowMs;
    slot.lat = lat;
    slot.lon = lon;
    slot.entityId = entityId;
    slot.dirX = dirX;
    slot.dirY = dirY;
    slot.big = big;
  }

  private setStop(entityId: string, nowMs: number, holdMs: number): void {
    const existing = this.stops.get(entityId);
    if (existing) {
      existing.startMs = nowMs;
      existing.holdMs = holdMs;
    } else {
      this.stops.set(entityId, { startMs: nowMs, holdMs });
    }
  }

  /** A predicted hit: flash and push on the mob, hitstop on the mob and the attacker (longer on the finisher). */
  addPredictedHit(mobId: string, attackerId: string, nowMs: number, screenDirX: number, screenDirY: number, strength: HitStrength = "swing"): void {
    const tuning = HIT_TUNING[strength];
    this.predictedHits.set(mobId, { startMs: nowMs, dirX: screenDirX, dirY: screenDirY, strength, holdMs: tuning.holdMs, pushPx: tuning.pushPx });
    if (hitFeedbackStats.disabled) return;
    this.setStop(mobId, nowMs, tuning.holdMs);
    this.setStop(attackerId, nowMs, tuning.holdMs);
    hitFeedbackStats.hitstops += 1;
    hitFeedbackStats.lastHitstopStartMs = nowMs;
    hitFeedbackStats.lastHitstopHoldMs = tuning.holdMs;
  }

  /**
   * The local player was hit (server DAMAGE): a lighter hitstop on the player and the attacker and a short push
   * away from the attacker (screen direction `dirX`, `dirY`; 0,0 = no push).
   */
  addIncomingHit(targetId: string, sourceId: string | null, nowMs: number, screenDirX: number, screenDirY: number): void {
    const tuning = HIT_TUNING.incoming;
    this.predictedHits.set(targetId, { startMs: nowMs, dirX: screenDirX, dirY: screenDirY, strength: "incoming", holdMs: tuning.holdMs, pushPx: tuning.pushPx });
    hitFeedbackStats.incomingHits += 1;
    if (hitFeedbackStats.disabled) return;
    this.setStop(targetId, nowMs, tuning.holdMs);
    if (sourceId) this.setStop(sourceId, nowMs, tuning.holdMs);
  }

  /** The server missed this predicted hit: drop its flash, nudge, hitstop and spark right away. */
  cancelPredictedHit(mobId: string): boolean {
    for (const shot of this.shots) {
      if (shot.active && shot.targetId === mobId) shot.targetId = "";
    }
    const had = this.predictedHits.delete(mobId);
    this.stops.delete(mobId);
    for (const spark of this.sparks) {
      if (spark.active && spark.entityId === mobId) spark.active = false;
    }
    return had;
  }

  /** ms since the predicted hit on the mob; NaN when there is none (or it was cancelled). */
  hitElapsedMs(mobId: string, nowMs: number): number {
    const hit = this.predictedHits.get(mobId);
    return hit ? nowMs - hit.startMs : Number.NaN;
  }

  /**
   * The killing blow lands at `atMs` (its contact frame, possibly still ahead): the attacker holds longer than for a plain
   * hit. Safe on top of the swing's own hold, which starts at the same moment.
   */
  addKillHitstop(attackerId: string, atMs: number, holdMs: number): void {
    if (hitFeedbackStats.disabled) return;
    const existing = this.stops.get(attackerId);
    if (existing && existing.startMs === atMs && existing.holdMs >= holdMs) return;
    // Only restart a hold that has not ended; never rewind one that already finished.
    this.setStop(attackerId, atMs, holdMs);
    hitFeedbackStats.hitstops += 1;
    hitFeedbackStats.lastHitstopHoldMs = holdMs;
  }

  /** ms until the entity's predicted melee hit reaches its contact frame (0 when there is none or it has landed). */
  contactWaitMs(mobId: string, nowMs: number): number {
    const hit = this.predictedHits.get(mobId);
    if (!hit || hit.strength === "incoming" || hit.strength === "shot") return 0;
    return Math.max(0, hit.startMs - nowMs);
  }

  /** The live hit record on the entity (flash and push timing), or undefined. */
  hitRecord(entityId: string): Readonly<PredictedHit> | undefined {
    return this.predictedHits.get(entityId);
  }

  /**
   * Writes the current push offset (px) into `out`: part of the push on impact plus a frame-by-frame tremble while
   * frozen, the rest eased out after the hold, then eased back. False when there is none. Render-only.
   */
  nudge(mobId: string, nowMs: number, out: { x: number; y: number }, reducedMotion = false): boolean {
    const hit = this.predictedHits.get(mobId);
    if (!hit || hitFeedbackStats.disabled) return false;
    const elapsed = nowMs - hit.startMs;
    if (!(elapsed >= 0) || elapsed >= pushDurationMs(hit.holdMs)) return false;
    const magnitude = hit.pushPx * pushFraction(elapsed, hit.holdMs) * (reducedMotion ? 0.35 : 1) +
      (reducedMotion ? 0 : holdJitterPx(elapsed, hit.holdMs));
    if (magnitude === 0) return false;
    out.x = hit.dirX * magnitude;
    out.y = hit.dirY * magnitude;
    return true;
  }

  /** True while the entity's hitstop hold is running (its rendered motion is frozen). */
  isHeld(entityId: string, nowMs: number): boolean {
    const stop = this.stops.get(entityId);
    return stop !== undefined && hitstopHeld(nowMs - stop.startMs, stop.holdMs);
  }

  /** True while any hitstop hold is running (perf/test counters). */
  anyHeld(nowMs: number): boolean {
    if (this.stops.size === 0) return false;
    for (const stop of this.stops.values()) if (hitstopHeld(nowMs - stop.startMs, stop.holdMs)) return true;
    return false;
  }

  /** How far animation sampling lags the real clock for the entity (0 outside a hitstop and its catch-up). */
  hitstopLagMs(entityId: string, nowMs: number): number {
    const stop = this.stops.get(entityId);
    if (stop === undefined) return 0;
    return hitstopLag(nowMs - stop.startMs, stop.holdMs);
  }

  /** The clock animations should sample: frozen during the hold, catching up after it, the real clock otherwise. */
  sampleNowMs(entityId: string, nowMs: number): number {
    return nowMs - this.hitstopLagMs(entityId, nowMs);
  }

  /** Arc age on its swinger's sampled clock (it holds through the swinger's hitstop). */
  arcElapsedMs(arc: SwingArcSlot, nowMs: number): number {
    return (arc.ownerId ? this.sampleNowMs(arc.ownerId, nowMs) : nowMs) - arc.startMs;
  }

  hasActive(nowMs: number): boolean {
    if (this.aimIndicator.active) return true;
    for (const arc of this.arcs) if (arc.active && this.arcElapsedMs(arc, nowMs) < ARC_FADE_MS) return true;
    for (const spark of this.sparks) if (spark.active && nowMs - spark.startMs < SPARK_DURATION_MS) return true;
    return this.activeShotCount(nowMs) > 0;
  }

  activeShotCount(nowMs: number): number {
    let count = 0;
    for (const shot of this.shots) if (shot.active && nowMs - shot.startMs < shotLifetimeMs(shot)) count += 1;
    return count;
  }

  activeArcCount(nowMs: number): number {
    let count = 0;
    for (const arc of this.arcs) if (arc.active && this.arcElapsedMs(arc, nowMs) < ARC_FADE_MS) count += 1;
    return count;
  }

  activeSparkCount(nowMs: number): number {
    let count = 0;
    for (const spark of this.sparks) if (spark.active && nowMs - spark.startMs < SPARK_DURATION_MS) count += 1;
    return count;
  }

  /** Retires finished slots and old records. Cheap when nothing is live. */
  prune(nowMs: number): void {
    for (const arc of this.arcs) if (arc.active && this.arcElapsedMs(arc, nowMs) >= ARC_FADE_MS) arc.active = false;
    for (const spark of this.sparks) if (spark.active && nowMs - spark.startMs >= SPARK_DURATION_MS) spark.active = false;
    for (const shot of this.shots) if (shot.active && nowMs - shot.startMs >= shotLifetimeMs(shot)) shot.active = false;
    if (this.predictedHits.size > 0) {
      for (const [id, hit] of this.predictedHits) {
        if (nowMs - hit.startMs >= PREDICTED_HIT_RECORD_MS) this.predictedHits.delete(id);
      }
    }
    if (this.stops.size > 0) {
      for (const [id, stop] of this.stops) {
        if (nowMs - stop.startMs >= stop.holdMs + HITSTOP_CATCHUP_MS) this.stops.delete(id);
      }
    }
  }

  clear(): void {
    for (const arc of this.arcs) arc.active = false;
    for (const spark of this.sparks) spark.active = false;
    for (const shot of this.shots) shot.active = false;
    this.predictedHits.clear();
    this.stops.clear();
    this.aimIndicator.active = false;
  }
}

export type SwingCandidate = Readonly<{ id: string; lat: number; lon: number; radiusM?: number }>;

const localScratch: LocalMetersOut = { x: 0, y: 0 };

/**
 * Client prediction of which mobs a swing hits: the shared arc test against the RENDERED mob positions,
 * nearest `SWING_MAX_TARGETS` first by edge distance (the server's cleave rule). Returns the ids, nearest first.
 */
export function predictSwingHits(
  origin: Readonly<{ lat: number; lon: number }>,
  dirX: number,
  dirY: number,
  candidates: Iterable<SwingCandidate>
): string[] {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const found: Array<{ id: string; distanceM: number }> = [];
  for (const candidate of candidates) {
    toLocalMeters(origin.lat, origin.lon, cosLat, candidate.lat, candidate.lon, localScratch);
    if (!swingArcContains(dirX, dirY, localScratch.x, localScratch.y, candidate.radiusM ?? SWING_TARGET_RADIUS_M)) continue;
    found.push({ id: candidate.id, distanceM: Math.max(0, Math.hypot(localScratch.x, localScratch.y) - Math.max(0, candidate.radiusM ?? SWING_TARGET_RADIUS_M)) });
  }
  found.sort((a, b) => a.distanceM - b.distanceM);
  return found.slice(0, SWING_MAX_TARGETS).map((entry) => entry.id);
}

/**
 * Client prediction of a ranged shot: the shared hitscan line test against the RENDERED mob positions.
 * Only the first mob on the line is hit; returns it with the distance along the line, or null on a miss.
 */
export function predictShotHit(
  origin: Readonly<{ lat: number; lon: number }>,
  dirX: number,
  dirY: number,
  candidates: Iterable<SwingCandidate>,
  profile: ShotProfile = BOW_SHOT_PROFILE
): { id: string; distanceM: number } | null {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  let best: { id: string; distanceM: number } | null = null;
  for (const candidate of candidates) {
    toLocalMeters(origin.lat, origin.lon, cosLat, candidate.lat, candidate.lon, localScratch);
    const along = shotLineContains(dirX, dirY, localScratch.x, localScratch.y, candidate.radiusM ?? SWING_TARGET_RADIUS_M, profile);
    if (along === null) continue;
    if (!best || along < best.distanceM) best = { id: candidate.id, distanceM: along };
  }
  return best;
}
