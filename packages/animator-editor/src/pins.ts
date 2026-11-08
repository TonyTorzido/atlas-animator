/*
 * Atlas Animator editor: pins (Moho / Toon Boom style, IK based).
 *
 * Pinning a hand or foot plants it at its current world position over a frame range: the limb's IK mix is keyed to 1 over the range
 * (one blend frame in and out, so the edges have clean keys) and the IK target bone is keyed so the end stays on the spot while the
 * body or spine moves. Unpin removes those keys and the limb goes back to its FK keys. "Hand to weapon grip" turns on the rig's
 * far-hand grip constraint (`trail_grip`, whose target rides on the weapon) over the range, which keeps the far hand on the haft
 * for a two-handed hold. Pins are read back from the clip's IK mix keys (a range where the mix is 1 at both ends), the same shape
 * the foot lock writes, so a foot lock shows as a pin and the other way round.
 *
 * The maths is pure and sits at the top; the pin icons on the canvas, the range bar on the timeline and the small panel are below.
 */
import type { AnimDocument, ClipData } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { KEY_EPSILON, frameCount, frameTime, setVectorKey, timeToFrame } from "./clipModel.js";
import { footLockRanges, lockFoot, maxDrift, unlockFoot } from "./footLockModel.js";
import { addTimelineDecorator, getHost, type EditorHost } from "./host.js";
import { lastPathFrame, makeSampler, pathStack, setIcon } from "./motionPath.js";

export type PinKind = "hand" | "foot" | "grip";

/** One thing that can be pinned: an IK constraint, the bone whose spot is held and (hand / foot) the target bone that is keyed. */
export interface PinSlot {
  ik: string;
  kind: PinKind;
  label: string;
  /** The bone the icon sits on and whose world position is held. */
  end: string;
  /** The IK target bone. */
  target: string;
}

const SIDE_WORD: Record<string, string> = { l: "left", r: "right", near: "near", far: "far" };

/** The pinnable limbs of a rig, found by the `hand_<side>_target` / `foot_<side>_target` convention, plus the weapon grip hold. */
export function pinSlots(doc: AnimDocument): PinSlot[] {
  const out: PinSlot[] = [];
  for (const c of doc.ik) {
    const m = /^(hand|foot)_(.+)_target$/.exec(c.target);
    if (m) {
      const side = SIDE_WORD[m[2]!] ?? m[2]!;
      out.push({ ik: c.name, kind: m[1] as PinKind, label: `${m[1] === "hand" ? "Hand" : "Foot"} ${side}`, end: `${m[1]}_${m[2]}`, target: c.target });
    } else if (/grip/i.test(c.name) || /grip/i.test(c.target)) {
      out.push({ ik: c.name, kind: "grip", label: "Hand to weapon grip", end: c.target, target: c.target });
    }
  }
  return out;
}

type IkKey = { time: number; mix?: number; curve?: unknown };

const near = (a: number, b: number) => Math.abs(a - b) < KEY_EPSILON;

/** Where the pinned end stands in the world at `frame`, as the clip poses it. */
export function endAt(doc: AnimDocument, name: string, clip: ClipData, slot: PinSlot, frame: number): { x: number; y: number } | null {
  const bone = makeSampler(doc, name, clip).poseFrame(frame).findBone(slot.end);
  return bone ? { x: bone.world.x, y: bone.world.y } : null;
}

/**
 * Pins `slot` over frames a..b at the spot the end stands on at frame a. The target is keyed on the first and last frame and on
 * every frame between where the target's parent moved (so a root that travels does not drag the pin).
 */
export function pinClip(doc: AnimDocument, name: string, clip: ClipData, slot: PinSlot, a: number, b: number): ClipData {
  if (!(b >= a)) throw new Error("the pin range ends before it starts");
  if (slot.kind === "grip") return holdGrip(clip, slot.ik, a, b);
  const sampler = makeSampler(doc, name, clip);
  const spot = (() => {
    const end = sampler.poseFrame(a).findBone(slot.end);
    return end ? { x: end.world.x, y: end.world.y } : null;
  })();
  if (!spot) throw new Error(`the rig has no bone ${slot.end}`);
  const locals: { frame: number; x: number; y: number }[] = [];
  for (let f = a; f <= b; f++) {
    const target = sampler.poseFrame(f).findBone(slot.target);
    if (!target) throw new Error(`the rig has no bone ${slot.target}`);
    const local = { x: 0, y: 0 };
    target.worldToParent(spot.x, spot.y, local);
    locals.push({ frame: f, x: local.x - target.data.x, y: local.y - target.data.y });
  }
  const first = locals[0]!;
  let next = lockFoot(clip, { ik: slot.ik, target: slot.target, a, b, x: first.x, y: first.y });
  let prev = first;
  for (const p of locals.slice(1)) {
    if (p.frame === b || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.01) {
      next = setVectorKey(next, slot.target, "translate", frameTime(next, p.frame), p.x, p.y);
      prev = p;
    }
  }
  return next;
}

/** Mix 1 over a..b with a blend frame each side and nothing else keyed (the grip's target rides on the weapon bone). */
export function holdGrip(clip: ClipData, ik: string, a: number, b: number): ClipData {
  const next = structuredClone(clip);
  const rec = next.ik as unknown as Record<string, IkKey[]>;
  const ta = frameTime(next, a);
  const tb = frameTime(next, b);
  const keys = (rec[ik] ??= []).filter((k) => k.time <= ta + KEY_EPSILON || k.time >= tb - KEY_EPSILON);
  const put = (time: number, mix: number, onlyIfFree: boolean) => {
    const at = keys.findIndex((k) => near(k.time, time));
    if (at >= 0) {
      if (!onlyIfFree) keys[at] = { ...keys[at]!, mix };
    } else keys.push({ time, mix, curve: "linear" });
  };
  put(ta, 1, false);
  put(tb, 1, false);
  if (a - 1 >= 0) put(frameTime(next, a - 1), 0, true);
  if (b + 1 <= frameCount(next)) put(frameTime(next, b + 1), 0, true);
  keys.sort((p, q) => p.time - q.time);
  rec[ik] = keys;
  return next;
}

/** Removes a pin: its IK mix keys (and, for a hand or foot, the target keys) from a - 1 to b + 1. FK takes over again. */
export function unpinClip(clip: ClipData, slot: PinSlot, a: number, b: number): ClipData {
  if (slot.kind !== "grip") return unlockFoot(clip, slot.ik, slot.target, a, b);
  const next = structuredClone(clip);
  const rec = next.ik as unknown as Record<string, IkKey[] | undefined>;
  const from = frameTime(next, a - 1) - KEY_EPSILON;
  const to = frameTime(next, b + 1) + KEY_EPSILON;
  const kept = (rec[slot.ik] ?? []).filter((k) => k.time < from || k.time > to);
  if (kept.length) rec[slot.ik] = kept;
  else delete rec[slot.ik];
  return next;
}

export interface Pin {
  slot: PinSlot;
  a: number;
  b: number;
}

/** Every pin in the clip, by start frame. */
export function pinsOf(doc: AnimDocument, clip: ClipData): Pin[] {
  const out: Pin[] = [];
  for (const slot of pinSlots(doc)) for (const r of footLockRanges(clip, slot.ik)) out.push({ slot, ...r });
  return out.sort((p, q) => p.a - q.a || p.b - q.b);
}

/** How far the pinned end wanders over a..b (px), measured on the posed clip. Near zero when the pin holds. */
export function pinDrift(doc: AnimDocument, name: string, clip: ClipData, slot: PinSlot, a: number, b: number): number {
  const sampler = makeSampler(doc, name, clip);
  const samples: { x: number; y: number }[] = [];
  for (let f = a; f <= Math.min(b, lastPathFrame(clip)); f++) {
    const bone = sampler.poseFrame(f).findBone(slot.end);
    if (bone) samples.push({ x: bone.world.x, y: bone.world.y });
  }
  return maxDrift(samples);
}

/** A sensible default range: from the playhead for eight frames, inside the clip. */
export function defaultPinRange(clip: ClipData, frame: number): { a: number; b: number } {
  const last = frameCount(clip);
  const a = Math.min(Math.max(0, frame), Math.max(0, last - 1));
  return { a, b: Math.min(last, a + 8) };
}

// ------------------------------------------------------------------------------------------------------------ canvas, timeline, panel

const KIND_COLOR: Record<PinKind, string> = { hand: "#f0b84a", foot: "#6bd68f", grip: "#5fb3ff" };
const KIND_HEX: Record<PinKind, number> = { hand: 0xf0b84a, foot: 0x6bd68f, grip: 0x5fb3ff };

/** Pin bars under the timeline ruler: a coloured bar per pin, stacked when they overlap, a head at the first frame. */
function drawPinBars(host: EditorHost): Parameters<typeof addTimelineDecorator>[0] {
  return (g, frameX, _w, _h, rulerH) => {
    const doc = host.doc;
    if (!doc || !host.clipName) return;
    const rows: number[] = [];
    for (const pin of pinsOf(doc, host.clip)) {
      let row = rows.findIndex((end) => end < pin.a);
      if (row < 0) row = rows.push(0) - 1;
      rows[row] = pin.b;
      const x0 = frameX(pin.a);
      const x1 = frameX(pin.b);
      const y = rulerH + 2 + row * 7;
      g.fillStyle = KIND_COLOR[pin.slot.kind];
      g.globalAlpha = 0.85;
      g.fillRect(x0, y, Math.max(3, x1 - x0), 5);
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(x0, y + 2.5, 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#101216";
      g.lineWidth = 1;
      g.stroke();
    }
  };
}

/** Mounts the pin icons, the timeline bars and the panel. Called once, with the host, after Pixi is up. */
export function installPins(host: EditorHost): void {
  const view = document.getElementById("view");
  const gfx = new Graphics();
  gfx.label = "pins";
  host.world.addChild(gfx);
  addTimelineDecorator(drawPinBars(host));

  const bar = document.createElement("div");
  bar.id = "pinsbar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "pins-toggle";
  setIcon(toggle, "Pins", "M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10zM12 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z");
  const body = document.createElement("div");
  body.id = "pins-body";
  const from = document.createElement("input");
  const to = document.createElement("input");
  for (const [el, id] of [[from, "pins-from"], [to, "pins-to"]] as const) {
    el.id = id;
    el.type = "number";
    el.min = "0";
    el.step = "1";
  }
  let touched = false;
  from.addEventListener("input", () => (touched = true));
  to.addEventListener("input", () => (touched = true));
  const adds = document.createElement("div");
  adds.id = "pins-add";
  const list = document.createElement("div");
  list.id = "pins-list";
  const rangeRow = document.createElement("div");
  rangeRow.className = "pins-row";
  rangeRow.append("Frames ", from, " to ", to);
  body.append(rangeRow, adds, list);
  bar.append(toggle, body);
  pathStack(view)?.append(bar);
  let open = false;
  let listSig = "";

  toggle.addEventListener("click", () => {
    open = !open;
    bar.classList.toggle("open", open);
    toggle.classList.toggle("on", open);
    toggle.setAttribute("aria-pressed", String(open));
    refresh();
  });

  function frameNow(): number {
    return timeToFrame(host.clip, host.time);
  }

  function pinned(slot: PinSlot, a: number, b: number): void {
    const doc = host.doc;
    if (!doc) return;
    try {
      const next = pinClip(doc, host.clipName, host.clip, slot, a, b);
      host.commit(next, `Pinned ${slot.label.toLowerCase()}, frames ${a}-${b}`);
      const drift = slot.kind === "grip" ? 0 : pinDrift(doc, host.clipName, next, slot, a, b);
      if (drift > 0.5) host.status(`${slot.label} pinned, but the arm or leg cannot reach: it drifts ${drift.toFixed(1)} px`, "bad");
      else host.status(`${slot.label} pinned, frames ${a}-${b}`, "ok");
    } catch (error) {
      host.status(String((error as Error).message), "bad");
    }
    touched = false;
  }

  function refresh(): void {
    const doc = host.doc;
    if (!doc || !host.clipName) {
      gfx.clear();
      return;
    }
    const slots = pinSlots(doc);
    if (!touched) {
      const r = defaultPinRange(host.clip, frameNow());
      from.value = String(r.a);
      to.value = String(r.b);
    }
    const pins = pinsOf(doc, host.clip);
    const sig = `${open}|${slots.map((s) => s.ik).join(",")}|${pins.map((p) => `${p.slot.ik}:${p.a}-${p.b}`).join(",")}`;
    if (open && sig !== listSig) {
      listSig = sig;
      adds.replaceChildren();
      for (const slot of slots) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pin-add";
        b.dataset.kind = slot.kind;
        b.textContent = slot.kind === "grip" ? slot.label : `Pin ${slot.label.toLowerCase()}`;
        b.addEventListener("click", () => pinned(slot, Math.max(0, Math.round(Number(from.value) || 0)), Math.max(0, Math.round(Number(to.value) || 0))));
        adds.append(b);
      }
      list.replaceChildren();
      for (const p of pins) {
        const row = document.createElement("div");
        row.className = "pin-row";
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "pin-chip";
        chip.dataset.kind = p.slot.kind;
        chip.textContent = `${p.slot.label} ${p.a}-${p.b}`;
        chip.addEventListener("click", () => host.setTime(frameTime(host.clip, p.a), true));
        const off = document.createElement("button");
        off.type = "button";
        off.className = "pin-unpin";
        off.textContent = "Unpin";
        off.addEventListener("click", () => {
          host.commit(unpinClip(host.clip, p.slot, p.a, p.b), `Unpinned ${p.slot.label.toLowerCase()}, frames ${p.a}-${p.b}`);
          host.status(`${p.slot.label} is back on its FK keys`, "ok");
        });
        row.append(chip, off);
        list.append(row);
      }
    }
    draw(pins);
  }

  /** A pin icon on every pinned end whose range covers the playhead. */
  function draw(pins: Pin[]): void {
    gfx.clear();
    host.world.addChild(gfx);
    const sk = host.skeleton;
    if (!sk) return;
    const px = 1 / Math.max(0.01, host.zoom());
    const f = frameNow();
    for (const p of pins) {
      if (f < p.a || f > p.b) continue;
      const bone = sk.findBone(p.slot.end);
      if (!bone) continue;
      const { x, y } = bone.world;
      const color = KIND_HEX[p.slot.kind];
      gfx.moveTo(x, y).lineTo(x, y - 16 * px).stroke({ width: 3 * px, color: 0x101216, alpha: 1 });
      gfx.circle(x, y - 24 * px, 9 * px).fill({ color, alpha: 1 }).stroke({ width: 2 * px, color: 0x101216, alpha: 1 });
      gfx.circle(x - 3 * px, y - 27 * px, 2.6 * px).fill({ color: 0xffffff, alpha: 0.85 });
    }
  }

  host.on("pose", refresh);
  host.on("time", refresh);
  host.on("clip", () => {
    touched = false;
    listSig = "";
    refresh();
  });
  host.on("rig", () => {
    listSig = "";
    refresh();
  });
  refresh();
}

/** Re-exported for the demo and the tests. */
export function pinsNow(): Pin[] {
  const host = getHost();
  return host?.doc ? pinsOf(host.doc, host.clip) : [];
}
