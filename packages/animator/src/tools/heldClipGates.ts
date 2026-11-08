/*
 * Atlas Animator: original implementation.
 *
 * Held-item attack clip gates (attack, 2026-10-17). Pure functions over per-frame samples
 * that cli/heldImport.ts takes from the dressed rig; each has a damaged control in
 * heldClipGates.test.ts and in the CLI run on the real rig.
 *
 * - gripCurveGate (replaces the round-1 grip lock, 2026-10-17): the item turns in the fist only along
 *   the grip keys the held clip file declares. The document's grip timeline must be exactly the
 *   declared keys (any other grip key or timeline fails); the grip's world turn against the hand
 *   must equal what the runtime applied (no drift), hit every key value on its frame and stay
 *   between the two neighbouring key values (no overshoot); a clip without grip keys must keep the
 *   grip at its setup angle (the old lock). Between frames the turn stays under the held spec's max
 *   angular velocity, and it may only change direction on a key, at least `minReversalGapFrames`
 *   apart (a smooth authored curve, not jitter).
 * - armFrontGate: in the declared arm-front phases, every slot of the holding arm (its sheet,
 *   faders, forearm, fist and the fist copy) draws after every slot of the other limb(s).
 * - hitGate: an attack clip has exactly one `hit` event, on a frame, at the declared contact time,
 *   and the pose is held (hitstop) for the declared frames from it.
 * - elbowInwardGate: every frame lies inside the rig's pose limits and each elbow only folds inward
 *   (the side its `elbow_never_outward*` limit allows at the arm-down pose), never outward.
 * - faderGate (attack): in arm-front frames each contour fader of the holding arm (the
 *   shoulder cap's across-outline and the front outlines) is fully hidden or fully shown, never
 *   half-faded (a half-faded cap reads as a faint ring on the shoulder).
 */

export interface GateResult {
  gate: string;
  ok: boolean;
  measured: number;
  detail: string;
}

interface BoneLike {
  name: string;
  parent?: string | undefined;
}
interface SlotLike {
  name: string;
  bone: string;
  drawAfter?: string | undefined;
  drawBefore?: string | undefined;
}

/** The bone chain from `hand` up to (and with) its first ancestor whose parent branches. */
function chainUp(bones: readonly BoneLike[], hand: string): string[] {
  const children = (n: string) => bones.filter((b) => b.parent === n).length;
  const byName = new Map(bones.map((b) => [b.name, b]));
  const out = [hand];
  let cur = byName.get(hand);
  while (cur?.parent) {
    const parent = byName.get(cur.parent);
    if (!parent || children(parent.name) !== 1) break;
    out.push(parent.name);
    cur = parent;
  }
  return out;
}

/** Bones of the single-child chain starting at `root` (root, its only child, ...), at most `n` long. */
function chainDown(bones: readonly BoneLike[], root: string, n: number): string[] {
  const out = [root];
  let cur = root;
  while (out.length < n) {
    const kids = bones.filter((b) => b.parent === cur);
    if (kids.length !== 1) break;
    cur = (kids[0] as BoneLike).name;
    out.push(cur);
  }
  return out;
}

/**
 * The holding arm and its sibling limbs: the arm is the single-child bone chain that ends at the
 * hand (clavicle -> upper arm -> forearm -> hand); a sibling limb is another child chain of the
 * arm root's parent with the same length (the other arm; the neck -> head chain is shorter).
 * Slots are matched by bone; `extra` names slots that belong to the arm too (the item's fist copy).
 */
export function armGroups(bones: readonly BoneLike[], slots: readonly SlotLike[], hand: string, extra: readonly string[] = []): { armBones: string[]; armSlots: string[]; otherSlots: string[] } {
  const armBones = chainUp(bones, hand);
  const root = armBones[armBones.length - 1] as string;
  const parent = bones.find((b) => b.name === root)?.parent;
  const siblings = bones.filter((b) => b.parent === parent && b.name !== root).map((b) => chainDown(bones, b.name, armBones.length)).filter((c) => c.length === armBones.length).flat();
  const armSlots = slots.filter((s) => armBones.includes(s.bone) || extra.includes(s.name)).map((s) => s.name);
  const otherSlots = slots.filter((s) => siblings.includes(s.bone)).map((s) => s.name);
  return { armBones, armSlots, otherSlots };
}

/**
 * Desired order of the unanchored slots for one draw phase: the item first (`back`, behind the body),
 * last (`front`, over everything) or just under the holding arm (`hand`: over the body and the other arm); with `armFront`, the arm's slots moved as one block to just
 * after the last slot of the other limb(s).
 */
export function phaseOrder(free: readonly string[], item: string, order: "back" | "front" | "hand", armFront: { arm: readonly string[]; other: readonly string[] } | null, arm: readonly string[] = armFront?.arm ?? []): string[] {
  let list = free.filter((n) => n !== item);
  if (armFront) {
    const block = list.filter((n) => armFront.arm.includes(n));
    const rest = list.filter((n) => !armFront.arm.includes(n));
    const after = Math.max(-1, ...armFront.other.map((n) => rest.indexOf(n)));
    list = [...rest.slice(0, after + 1), ...block, ...rest.slice(after + 1)];
  }
  if (order === "hand") {
    // in front of the body and the other arm, under the holding arm (its fist draws over the hilt)
    const first = list.findIndex((n) => arm.includes(n));
    if (first < 0) throw new Error("phaseOrder: 'hand' needs the holding arm's slots");
    return [...list.slice(0, first), item, ...list.slice(first)];
  }
  return order === "back" ? [item, ...list] : [...list, item];
}

/** Draw-order key offsets (format drawOrder timelines) that turn `setup` into `desired`. */
export function offsetsFor(setup: readonly string[], desired: readonly string[]): { slot: string; offset: number }[] {
  if (setup.length !== desired.length || desired.some((n) => !setup.includes(n))) throw new Error("offsetsFor: desired is not a permutation of setup");
  return desired.map((n, i) => ({ slot: n, offset: i - setup.indexOf(n) })).filter((o) => o.offset !== 0);
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export interface GripKey {
  time: number;
  value: number;
}

/** One held clip's grip data for gripCurveGate. */
export interface GripCurveClip {
  clip: string;
  /** Grip keys the held clip file declares (the authored curve; empty = the grip stays at its setup angle). */
  declared: readonly GripKey[];
  /** The grip bone's rotate keys in the document's clip (empty = none). */
  keyed: readonly GripKey[];
  /** The document's clip has a grip timeline other than rotate (translate, scale, shear). */
  otherTimelines: boolean;
  /** Per frame f (time f / fps): the grip's world angle minus the hand's minus the setup grip angle (degrees). */
  turn: readonly number[];
  /** Per frame: the grip bone's local rotation minus its setup rotation (what the runtime applied). */
  local: readonly number[];
}

/** Grip-curve limits (held spec `grip.curve`). */
export interface GripCurveLimits {
  fps: number;
  /** Largest turn of the grip against the hand between two frames, in degrees per second. */
  maxDegPerSecond: number;
  /** Fewest frames between two changes of the turn's direction (each must be on a key). */
  minReversalGapFrames: number;
}

/** Gate: the grip turns in the fist only along its declared, smooth keys (see the file header). */
export function gripCurveGate(clips: readonly GripCurveClip[], limits: GripCurveLimits): GateResult {
  const problems: string[] = [];
  let frames = 0;
  let worstDrift = 0;
  let worstKey = 0;
  let worstOver = 0;
  let worstSpeed = 0;
  let keyedClips = 0;
  const tol = 1e-3;
  for (const c of clips) {
    const n = c.turn.length;
    frames += n;
    if (c.declared.length) keyedClips++;
    const same = c.declared.length === c.keyed.length && c.declared.every((k, i) => Math.abs(k.time - (c.keyed[i] as GripKey).time) < 1e-6 && Math.abs(k.value - (c.keyed[i] as GripKey).value) < 1e-6);
    if (!same) problems.push(`${c.clip}: the grip timeline (${c.keyed.length} keys) is not the declared grip keys (${c.declared.length})`);
    if (c.otherTimelines) problems.push(`${c.clip}: the grip bone has a timeline other than its rotate keys`);
    // key times are written to 6 decimals (1/30 s = 0.033333), so "on a frame" allows that rounding
    const rawFrames = c.declared.map((k) => k.time * limits.fps);
    if (rawFrames.some((f) => Math.abs(f - Math.round(f)) > 1e-4)) problems.push(`${c.clip}: a grip key is not on a frame`);
    const keyFrames = rawFrames.map((f) => Math.round(f));
    for (let f = 0; f < n; f++) {
      const d = Math.abs(wrap((c.turn[f] as number) - (c.local[f] as number)));
      if (d > worstDrift) worstDrift = d;
      if (d > tol) { problems.push(`${c.clip} f${f}: the grip drifts ${d.toFixed(3)} deg from its keys`); break; }
    }
    if (!c.declared.length) {
      for (let f = 0; f < n; f++) {
        const d = Math.abs(wrap(c.turn[f] as number));
        if (d > worstKey) worstKey = d;
        if (d > tol) { problems.push(`${c.clip} f${f}: the grip turns ${d.toFixed(3)} deg with no grip keys`); break; }
      }
    } else {
      for (let i = 0; i < c.declared.length; i++) {
        const k = c.declared[i] as GripKey;
        const f = Math.round(k.time * limits.fps);
        if (f >= n) continue;
        const d = Math.abs(wrap((c.turn[f] as number) - k.value));
        if (d > worstKey) worstKey = d;
        if (d > tol) problems.push(`${c.clip} f${f}: the grip is ${d.toFixed(3)} deg off its key`);
        const next = c.declared[i + 1];
        if (!next) continue;
        const lo = Math.min(k.value, next.value);
        const hi = Math.max(k.value, next.value);
        for (let g = f + 1; g < Math.min(n, Math.round(next.time * limits.fps)); g++) {
          const v = k.value + wrap((c.turn[g] as number) - k.value);
          const over = Math.max(0, lo - v, v - hi);
          if (over > worstOver) worstOver = over;
          if (over > tol) { problems.push(`${c.clip} f${g}: the grip overshoots its keys by ${over.toFixed(3)} deg`); break; }
        }
      }
    }
    // speed and direction changes over the sampled turn
    let lastDir = 0;
    let lastMoveEnd = 0;
    let lastReversal = -Infinity;
    for (let f = 0; f + 1 < n; f++) {
      const step = wrap((c.turn[f + 1] as number) - (c.turn[f] as number));
      const speed = Math.abs(step) * limits.fps;
      if (speed > worstSpeed) worstSpeed = speed;
      if (speed > limits.maxDegPerSecond) problems.push(`${c.clip} f${f}-${f + 1}: the grip turns ${speed.toFixed(0)} deg/s (max ${limits.maxDegPerSecond})`);
      if (Math.abs(step) < 0.05) continue;
      const dir = Math.sign(step);
      if (lastDir !== 0 && dir !== lastDir) {
        const at = lastMoveEnd;
        if (!keyFrames.some((k) => Math.abs(k - at) < 1e-6)) problems.push(`${c.clip} f${at}: the grip changes direction off a key`);
        if (at - lastReversal < limits.minReversalGapFrames) problems.push(`${c.clip} f${at}: the grip changes direction again ${at - lastReversal} frames after f${lastReversal} (jitter; at least ${limits.minReversalGapFrames})`);
        lastReversal = at;
      }
      lastDir = dir;
      lastMoveEnd = f + 1;
    }
  }
  const ok = clips.length > 0 && frames > 0 && problems.length === 0;
  return {
    gate: "grip curve: the item turns in the fist only along its declared, smooth grip keys",
    ok,
    measured: frames,
    detail: `${clips.length} clips (${keyedClips} with grip keys), ${frames} frames; drift ${worstDrift.toFixed(4)} deg, off-key ${worstKey.toFixed(4)} deg, overshoot ${worstOver.toFixed(4)} deg, fastest ${worstSpeed.toFixed(0)} deg/s (max ${limits.maxDegPerSecond}), direction changes >= ${limits.minReversalGapFrames} frames apart on keys; problems ${problems.length}${problems.length ? ` (${problems.slice(0, 6).join("; ")})` : ""}`
  };
}

/** Gate: in arm-front frames the holding arm draws wholly after the other limb(s). */
export function armFrontGate(frames: readonly { label: string; order: readonly string[] }[], arm: readonly string[], other: readonly string[]): GateResult {
  let bad = 0;
  const where: string[] = [];
  for (const f of frames) {
    const armMin = Math.min(...arm.map((n) => f.order.indexOf(n)));
    const otherMax = Math.max(...other.map((n) => f.order.indexOf(n)));
    if (arm.some((n) => !f.order.includes(n)) || !(armMin > otherMax)) {
      bad++;
      if (where.length < 6) where.push(`${f.label}: arm from ${armMin}, other limb up to ${otherMax}`);
    }
  }
  const ok = frames.length > 0 && arm.length > 0 && other.length > 0 && bad === 0;
  return { gate: "arm front: the attacking arm draws over the other arm", ok, measured: frames.length, detail: `${frames.length} arm-front frames, ${arm.length} arm slots vs ${other.length} other-limb slots; frames out of order ${bad}${where.length ? ` (${where.join("; ")})` : ""}` };
}

/** Contour fader slots (arm layer `<owner>_<contour>_fade`) among the given slots. */
export const faderSlots = (slots: readonly string[]): string[] => slots.filter((n) => /_fade(_r)?$/.test(n));

/** Gate: in arm-front frames every fader of the holding arm shows its stroke at <= `tol` or >= 1 - `tol` opacity. */
export function faderGate(frames: readonly { label: string; faders: Record<string, number> }[], tol = 0.02): GateResult {
  let bad = 0;
  let worst = 0;
  let count = 0;
  const where: string[] = [];
  for (const f of frames) {
    for (const [slot, a] of Object.entries(f.faders)) {
      count++;
      const mid = Math.min(a, 1 - a);
      if (mid > tol) {
        bad++;
        worst = Math.max(worst, mid);
        if (where.length < 6) where.push(`${f.label}: ${slot} at ${a.toFixed(2)}`);
      }
    }
  }
  const ok = frames.length > 0 && count > 0 && bad === 0;
  return { gate: "faders: no half-faded arm stroke (shoulder ring) in arm-front frames", ok, measured: frames.length, detail: `${frames.length} arm-front frames, ${count} fader samples; half-faded ${bad} (worst ${worst.toFixed(2)} from off/on, allowed ${tol})${where.length ? ` (${where.join("; ")})` : ""}` };
}

export interface HitClipSample {
  clip: string;
  fps: number;
  /** Declared contact: the `hit` event time and the hitstop length in frames. */
  hit: { time: number; holdFrames: number };
  /** Event keys of the clip. */
  events: readonly { time: number; name: string }[];
  /** Per frame f (time f / fps): every bone's world transform, flattened. */
  frames: readonly Float64Array[];
}

/** Gate: one `hit` event on the declared contact frame, and the pose held for the hitstop. */
export function hitGate(clips: readonly HitClipSample[]): GateResult {
  const problems: string[] = [];
  for (const c of clips) {
    const hits = c.events.filter((e) => e.name === "hit");
    const f0 = Math.round(c.hit.time * c.fps);
    if (hits.length !== 1) problems.push(`${c.clip}: ${hits.length} hit events`);
    else if (Math.abs((hits[0] as { time: number }).time - c.hit.time) > 1e-6) problems.push(`${c.clip}: hit at ${(hits[0] as { time: number }).time} not the declared ${c.hit.time}`);
    if (Math.abs(f0 / c.fps - c.hit.time) > 1e-6) problems.push(`${c.clip}: contact ${c.hit.time} is not on a frame`);
    if (c.hit.holdFrames < 1) problems.push(`${c.clip}: no hitstop declared`);
    const ref = c.frames[f0];
    for (let f = f0 + 1; f <= f0 + c.hit.holdFrames; f++) {
      const cur = c.frames[f];
      if (!ref || !cur) { problems.push(`${c.clip}: hitstop frame ${f} missing`); break; }
      let d = 0;
      for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs((ref[i] as number) - (cur[i] as number)));
      if (d > 1e-6) { problems.push(`${c.clip}: frame ${f} moves ${d.toFixed(3)} during the hitstop`); break; }
    }
    // the frame after the hitstop must move again (a hold, not a freeze to the end)
    const after = c.frames[f0 + c.hit.holdFrames + 1];
    if (ref && after) {
      let d = 0;
      for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs((ref[i] as number) - (after[i] as number)));
      if (d <= 1e-6) problems.push(`${c.clip}: still frozen after the declared hitstop`);
    }
  }
  const ok = clips.length > 0 && problems.length === 0;
  return { gate: "hit event on the contact frame, hitstop held", ok, measured: clips.length, detail: `${clips.length} attack clips${clips.map((c) => ` ${c.clip}: hit ${c.hit.time.toFixed(3)} s (frame ${Math.round(c.hit.time * c.fps)}), hold ${c.hit.holdFrames} frames`).join(";")}; problems ${problems.length}${problems.length ? ` (${problems.slice(0, 6).join("; ")})` : ""}` };
}

interface LimitLike {
  name: string;
  x: string;
  y: string;
  polygon: readonly (readonly number[])[];
}

/** The inward sign of each elbow from its `elbow_never_outward*` limit: the longer side of the polygon at x = 0. */
export function inwardSigns(limits: readonly LimitLike[]): { bone: string; sign: 1 | -1 }[] {
  return limits.filter((l) => l.name.startsWith("elbow_never_outward")).map((l) => {
    let lo = Infinity;
    let hi = -Infinity;
    const p = l.polygon;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i] as [number, number];
      const [x2, y2] = p[(i + 1) % p.length] as [number, number];
      if ((x1 <= 0 && x2 >= 0) || (x2 <= 0 && x1 >= 0)) {
        const y = x1 === x2 ? Math.min(y1, y2) : y1 + ((0 - x1) / (x2 - x1)) * (y2 - y1);
        const yy = x1 === x2 ? Math.max(y1, y2) : y;
        lo = Math.min(lo, y, yy);
        hi = Math.max(hi, y, yy);
      }
    }
    return { bone: l.y, sign: Math.abs(lo) > Math.abs(hi) ? -1 : 1 };
  });
}

/** Gate: every frame inside the pose limits, every elbow folded inward (or straight) only. */
export function elbowInwardGate(frames: readonly { label: string; pose: Record<string, number>; inside: boolean }[], signs: readonly { bone: string; sign: 1 | -1 }[]): GateResult {
  let outside = 0;
  let outward = 0;
  let worst = 0;
  const where: string[] = [];
  for (const f of frames) {
    if (!f.inside) { outside++; if (where.length < 6) where.push(`${f.label}: outside the pose limits`); }
    for (const s of signs) {
      const v = (f.pose[s.bone] ?? 0) * s.sign;
      if (v < -1e-6) {
        outward++;
        worst = Math.max(worst, -v);
        if (where.length < 6) where.push(`${f.label}: ${s.bone} ${(f.pose[s.bone] ?? 0).toFixed(1)} outward`);
      }
    }
  }
  const ok = frames.length > 0 && signs.length > 0 && outside === 0 && outward === 0;
  return { gate: "pose limits, elbows fold inward only", ok, measured: frames.length, detail: `${frames.length} frames, ${signs.length} elbows; outside the limits ${outside}; outward elbow frames ${outward} (worst ${worst.toFixed(1)} deg)${where.length ? ` (${where.join("; ")})` : ""}` };
}
