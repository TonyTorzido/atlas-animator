/*
 * Atlas Animator: original implementation.
 *
 * Live pose limits: key commands are checked against the document's `poseLimits`
 * while authoring, not only by `animator validate`. A clip is sampled through the runtime (its key
 * times and 8 steps between them, so interpolation curves, IK and constraints are included) and
 * each sample's driver pair is tested against every limit polygon. A command is blamed only for
 * samples it moved outside (inside before, outside after, at the same time). The nearest legal
 * pose is the projection of the sampled drivers onto the limit polygons (alternating projections
 * when several polygons share a driver). Pure: usable in the browser (no node imports).
 */
import { ikReachViolationsInOutfits } from "./ikReach.js";
import { inContactBand, nearestOutsideBands } from "./contactBand.js";
import { bandEligible, bandOutfits } from "./bandOwnership.js";
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import { drivenValue } from "../core/driven.js";
import type { AnimDocument } from "../core/format.js";
import { parseAnimDocument } from "../core/formatLoader.js";
import { Skeleton } from "../core/skeleton.js";

/** off: no check; warn: report and apply; reject: refuse the command (or batch). */
export type LimitMode = "off" | "warn" | "reject";

type Pt = readonly [number, number];
type Limit = NonNullable<AnimDocument["poseLimits"]>[number];

/** Steps between consecutive key times (as `animator validate`). */
const STEPS = 8;
/** Outside tolerance in degrees (matches the validator's on-edge tolerance). */
const TOLERANCE = 1e-4;

export interface LimitSample {
  time: number;
  /** Driver values of every limited bone at this time. */
  drivers: Record<string, number>;
  /** Names of the limits this sample is outside. */
  outside: string[];
  /** Contact bands the sample sits in (only a keyed pose may not: motion crosses bands). */
  contacts: string[];
}

export interface LimitViolation {
  clip: string;
  time: number;
  /** True when the sample sits on a key time of the command (the keyed pose), false for an in-between. */
  keyed: boolean;
  limits: string[];
  drivers: Record<string, number>;
  /**
   * Nearest pose inside every limit (driver values; only the limited drivers), offered only when it
   * resolves every violation of the sample: absent for an IK reach violation (driver values do not
   * move an IK target) and when the projection is not verified legal.
   */
  nearest?: Record<string, number>;
  /** Set when no verified legal pose (inside every limit, outside the contact bands) was found. */
  noLegalPose?: true;
}

/** A limit's (x, y) point for driver values: y adds the limit's `plus` drivers (absent drivers = 0). */
export function limitPoint(limit: Pick<Limit, "x" | "y" | "plus">, values: Readonly<Record<string, number>>): [number, number] {
  return [values[limit.x] ?? 0, (values[limit.y] ?? 0) + (limit.plus ?? []).reduce((s, b) => s + (values[b] ?? 0), 0)];
}

/**
 * The combined-lean rule: a combined limit's y is a lean, so every
 * driver of the sum (y and each `plus`) leans the total's way or is 0, and a total of 0 means every
 * driver at 0. The auto limit samples only such splits; a counter-leaning split (neck one way, head
 * the other) moves the head sideways with a "neutral" sum and is outside the limit.
 */
export function leanSplitOk(limit: Pick<Limit, "y" | "plus">, values: Readonly<Record<string, number>>, tol = 1e-4): boolean {
  const plus = limit.plus ?? [];
  if (!plus.length) return true;
  const parts = [limit.y, ...plus].map((b) => values[b] ?? 0);
  const total = parts.reduce((s, v) => s + v, 0);
  if (Math.abs(total) < tol) return parts.every((v) => Math.abs(v) < tol);
  return parts.every((v) => v * Math.sign(total) >= -tol);
}

/**
 * Signed distance outside a simple polygon of either winding (<= 0 inside): the distance to the nearest
 * edge, negative inside (even-odd). Pose limits may be non-convex (plan: elbow-inward rule, a Z-shaped
 * upper arm x forearm region); for a convex polygon this equals the half-plane form inside.
 */
export function outsideDistance(poly: readonly Pt[], p: Pt): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as Pt;
    const b = poly[i] as Pt;
    if ((b[1] > p[1]) !== (a[1] > p[1]) && p[0] < ((a[0] - b[0]) * (p[1] - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
    best = Math.min(best, Math.hypot(a[0] + ex * t - p[0], a[1] + ey * t - p[1]));
  }
  return inside ? -best : best;
}

/** True when no two non-adjacent edges of the polygon cross (a simple polygon; convexity not required). */
export function isSimplePolygon(poly: readonly Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = poly[i] as Pt, b = poly[(i + 1) % n] as Pt, c = poly[j] as Pt, d = poly[(j + 1) % n] as Pt;
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
    }
  }
  return true;
}

/** The nearest point of a (simple) polygon to `p` (p itself when inside). */
export function projectToConvex(poly: readonly Pt[], p: Pt): [number, number] {
  if (outsideDistance(poly, p) <= 0) return [p[0], p[1]];
  let best: [number, number] = [p[0], p[1]];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
    const q: [number, number] = [a[0] + ex * t, a[1] + ey * t];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * The nearest legal pose: the drivers projected onto every limit polygon (cyclic projections,
 * which converge into the intersection of convex sets; a non-convex limit projects to its nearest edge), nudged a hair inside so it passes again.
 */
export function nearestLegalPose(limits: readonly Limit[], drivers: Readonly<Record<string, number>>): Record<string, number> {
  const pose: Record<string, number> = { ...drivers };
  const at = (name: string) => pose[name] ?? 0;
  for (let round = 0; round < 200; round++) {
    let moved = false;
    for (const limit of limits) {
      const p: Pt = limitPoint(limit, pose);
      if (outsideDistance(limit.polygon, p) <= TOLERANCE / 2 && leanSplitOk(limit, pose)) continue;
      const q = outsideDistance(limit.polygon, p) <= TOLERANCE / 2 ? p : projectToConvex(limit.polygon, p);
      // Step slightly past the edge, into the polygon, so the result is strictly inside (the probe
      // direction that lands inside; a non-convex limit has no centroid that is always inside).
      let c: [number, number] = [q[0], q[1]];
      for (let k = 0; k < 16; k++) {
        const an = (k / 16) * 2 * Math.PI;
        const t: Pt = [q[0] + Math.cos(an) * 0.01, q[1] + Math.sin(an) * 0.01];
        if (outsideDistance(limit.polygon, t) < outsideDistance(limit.polygon, c)) c = [t[0], t[1]];
      }
      pose[limit.x] = c[0];
      const y = c[1];
      const plus = limit.plus ?? [];
      if (!plus.length) pose[limit.y] = y;
      else {
        // A combined y keeps its lean one way (leanSplitOk): the counter-leaning drivers go to 0 and
        // the drivers on the total's side scale to the projected total (or y's own bone takes it all).
        const names = [limit.y, ...plus];
        const side = Math.sign(y);
        for (const n of names) if (at(n) * side < 0 || side === 0) pose[n] = 0;
        const same = names.reduce((s, n) => s + at(n), 0);
        if (same !== 0 && Math.sign(same) === side) for (const n of names) pose[n] = at(n) * (y / same);
        else pose[limit.y] = y;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return pose;
}

function keyTimes(value: unknown, out: Set<number>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object" && typeof (entry as { time?: unknown }).time === "number") out.add((entry as { time: number }).time);
      else keyTimes(entry, out);
    }
  } else if (value && typeof value === "object") for (const child of Object.values(value)) keyTimes(child, out);
}

/** Sample times of a clip: 0, the duration, every bone / constraint key time and STEPS between. */
export function clipSampleTimes(doc: AnimDocument, clip: string): number[] {
  const data = doc.animations[clip];
  if (!data) return [];
  const times = new Set<number>([0, data.duration]);
  keyTimes([data.bones, data.ik, data.transform, data.physics], times);
  const sorted = [...times].filter((t) => t >= 0 && t <= data.duration).sort((a, b) => a - b);
  const samples: number[] = [];
  sorted.forEach((t, i) => {
    const next = sorted[i + 1];
    for (let k = 0; k < (next === undefined ? 1 : STEPS); k++) samples.push(next === undefined ? t : t + ((next - t) * k) / STEPS);
  });
  return samples;
}

/** Plays a clip at each time through the runtime and tests the limited drivers. */
export function sampleClip(doc: AnimDocument, clip: string, times: readonly number[]): LimitSample[] {
  const limits = doc.poseLimits ?? [];
  const bands = doc.contactBands ?? [];
  if ((!limits.length && !bands.length && !doc.ik.length) || !doc.animations[clip]) return [];
  const drivers = [...new Set([...limits.flatMap((l) => [l.x, l.y, ...(l.plus ?? [])]), ...bands.flatMap((b) => [b.x, b.y, ...Object.keys(b.when ?? {})])])];
  const skeleton = new Skeleton(doc);
  const data = new AnimationStateData(doc);
  const outfits = bandOutfits(doc);
  return times.map((time) => {
    skeleton.setToSetupPose();
    const state = new AnimationState(data);
    state.setAnimation(0, clip, { loop: false });
    state.update(time);
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
    const values: Record<string, number> = {};
    for (const name of drivers) {
      const bone = skeleton.findBone(name);
      values[name] = bone ? drivenValue(bone) : 0;
    }
    const outside = limits.filter((l) => outsideDistance(l.polygon, limitPoint(l, values)) > TOLERANCE || !leanSplitOk(l, values)).map((l) => l.name);
    // Hard IK reach (r3): a two-bone target past MAX_IK_REACH of the chain is outside,
    // in any outfit (the batch validator's rule: active constraints only, every bandOutfits outfit).
    if (doc.ik.length) {
      const skins = [...skeleton.activeSkins];
      const pose = () => {
        skeleton.setToSetupPose();
        const st = new AnimationState(data);
        st.setAnimation(0, clip, { loop: false });
        st.update(time);
        st.apply(skeleton);
        skeleton.updateWorldTransform("reset");
      };
      for (const r of ikReachViolationsInOutfits(skeleton, outfits, pose)) outside.push(`ik reach ${r.name}`);
      skeleton.setActiveSkins(skins);
    }
    // Outfit-aware eligibility, as the batch validator (bandOwnership.ts): a band with a contour pair
    // holds only in an outfit where both contours draw; the pose is re-applied per outfit.
    const gated = bands.some((b) => b.contours);
    const contacts = gated
      ? bands
          .filter((b) =>
            outfits.some((outfit) => {
              skeleton.setActiveSkins(outfit);
              skeleton.setToSetupPose();
              const st = new AnimationState(data);
              st.setAnimation(0, clip, { loop: false });
              st.update(time);
              st.apply(skeleton);
              skeleton.updateWorldTransform("reset");
              return bandEligible(skeleton, b, values);
            })
          )
          .map((b) => b.name)
      : bands.filter((b) => inContactBand(b, values)).map((b) => b.name);
    return { time, drivers: values, outside, contacts };
  });
}

/** Parses a JSON document for limit checks (null when it does not parse or has no limits). */
export function limitDocument(json: unknown): AnimDocument | null {
  const parsed = parseAnimDocument(json);
  if (!parsed.ok || (!parsed.document.poseLimits?.length && !parsed.document.contactBands?.length && !parsed.document.ik.length)) return null;
  return parsed.document;
}

/**
 * Poses of `clips` that `after` puts outside a limit and `before` had inside (same sample times:
 * the union of both documents' key-time samples). `keyTimes` marks samples that are keyed poses.
 */
export function newViolations(before: AnimDocument | null, after: AnimDocument, clips: readonly string[], keyed: readonly number[] = []): LimitViolation[] {
  const limits = after.poseLimits ?? [];
  const bands = after.contactBands ?? [];
  if (!limits.length && !bands.length && !after.ik.length) return [];
  const out: LimitViolation[] = [];
  const isKeyed = (t: number) => keyed.some((k) => Math.abs(k - t) < 1e-6);
  const nearest = (drivers: Record<string, number>) => {
    const out = nearestOutsideBands(bands, drivers, (p) => limits.every((l) => outsideDistance(l.polygon, limitPoint(l, p)) <= TOLERANCE));
    const pose = nearestLegalPose(limits, out.pose);
    // Verified: inside every limit (lean split too) and outside every band.
    const legal = limits.every((l) => outsideDistance(l.polygon, limitPoint(l, pose)) <= TOLERANCE && leanSplitOk(l, pose)) && !bands.some((b) => inContactBand(b, pose));
    return { pose, found: out.ok && legal };
  };
  for (const clip of new Set(clips)) {
    if (!after.animations[clip]) continue;
    const times = [...new Set([...clipSampleTimes(after, clip), ...(before ? clipSampleTimes(before, clip) : [])])]
      .filter((t) => t <= (after.animations[clip]?.duration ?? 0) + 1e-9)
      .sort((a, b) => a - b);
    const now = sampleClip(after, clip, times);
    if (!now.some((s) => s.outside.length || (s.contacts.length && isKeyed(s.time)))) continue;
    // Same sample times, outfits, activation rules and tolerances as `now`.
    const then = before && before.animations[clip] && ((before.poseLimits ?? []).length || (before.contactBands ?? []).length || before.ik.length) ? sampleClip(before, clip, times) : [];
    now.forEach((sample, i) => {
      const was = new Set([...(then[i]?.outside ?? []), ...(then[i]?.contacts ?? [])]);
      const keyedHere = isKeyed(sample.time);
      // A keyed pose may not sit in a contact band; in-betweens cross bands freely.
      const added = [...sample.outside, ...(keyedHere ? sample.contacts : [])].filter((name) => !was.has(name));
      if (!added.length) return;
      out.push({
        clip,
        time: sample.time,
        keyed: keyedHere,
        limits: added,
        drivers: sample.drivers,
        ...(() => {
          // A correction only when it resolves every added violation: driver values never resolve an
          // IK reach, and an unverified projection is not offered.
          if (added.some((name) => name.startsWith("ik reach "))) return {};
          const n = nearest(sample.drivers);
          return n.found ? { nearest: n.pose } : { noLegalPose: true as const };
        })()
      });
    });
  }
  return out;
}

const fmt = (v: number) => (Math.abs(v) < 0.05 ? "0" : v.toFixed(1));
const pose = (values: Record<string, number>, names: readonly string[]) => names.map((n) => `${n} ${fmt(values[n] ?? 0)}`).join(", ");

/** One line per violated limit: the first (keyed pose first) offending sample and its nearest legal pose. */
export function describeViolations(violations: readonly LimitViolation[]): string[] {
  const byLimit = new Map<string, LimitViolation[]>();
  for (const v of violations) for (const name of v.limits) byLimit.set(`${v.clip}\u0000${name}`, [...(byLimit.get(`${v.clip}\u0000${name}`) ?? []), v]);
  const lines: string[] = [];
  for (const [key, list] of byLimit) {
    const [clip, name] = key.split("\u0000") as [string, string];
    const first = list.find((v) => v.keyed) ?? (list[0] as LimitViolation);
    const fix = first.nearest;
    const names = fix ? Object.keys(first.drivers).filter((n) => Math.abs((fix[n] ?? 0) - (first.drivers[n] ?? 0)) > 1e-3) : [];
    const shown = names.length ? names : Object.keys(first.drivers);
    const keyed = list.filter((v) => v.keyed).length;
    const between = list.length - keyed;
    const what = [keyed ? "the keyed pose" : "", between ? `${between} in-between pose${between === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    lines.push(
      `clip '${clip}': ${what} outside pose limit '${name}' (${first.keyed ? "key" : "first"} t ${first.time.toFixed(3)}s: ${pose(first.drivers, shown)}); ${
        fix
          ? `nearest legal pose: ${pose(fix, shown)}`
          : name.startsWith("ik reach ")
            ? "IK is hard: bring the target inside the chain reach (no driver correction resolves it)"
            : "no verified legal pose found inside the limits and outside the contact bands"
      }`
    );
  }
  return lines;
}

/** Clips a command's key/clip edits touch (empty for every other command). */
export function clipsTouched(command: Record<string, unknown>): string[] {
  const op = String(command["op"] ?? "");
  const names: unknown[] = [];
  if (op.startsWith("key.")) names.push(command["clip"], command["toClip"]);
  else if (op === "clip.duration") names.push(command["name"]);
  else if (op === "clip.copy") names.push(command["to"]);
  return names.filter((n): n is string => typeof n === "string");
}

/** Key times a command writes (its keyed poses). */
export function keyedTimes(command: Record<string, unknown>): number[] {
  const op = String(command["op"] ?? "");
  if (op === "key.set" || op === "key.curve") return typeof command["time"] === "number" ? [command["time"]] : [];
  if (op === "key.move") return typeof command["to"] === "number" ? [command["to"]] : [];
  return [];
}
