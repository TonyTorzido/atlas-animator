/*
 * Atlas Animator editor: motion paths (the trail a point of the body draws across the whole clip).
 *
 * For the selected bones, the weapon tip and a fist centre, the overlay draws one dot per frame. Key frames get bigger dots, the
 * current frame is ringed, and the line between dots is coloured by speed (the spacing of the dots), so ease-in and ease-out show
 * up as a colour shift. An optional onion range limits the path to the frames around the playhead. Clicking a dot jumps to its
 * frame.
 *
 * The paths are sampled with a private skeleton from the clip as it is committed (the same headless pose evaluation the rule
 * checker uses), so drawing them never disturbs the live pose. They recompute after a commit, debounced, never on every drag.
 * The maths (sampling, key frames, speed colours, the onion window) is pure and lives at the top; the Pixi / DOM part is below.
 */
import { AnimationState, AnimationStateData, Skeleton, type AnimDocument, type Bone, type ClipData } from "@atlas-animator/core/core";
import { Graphics } from "pixi.js";
import { frameCount, frameTime, timeToFrame } from "./clipModel.js";
import { withClip } from "./gates.js";
import type { EditorHost } from "./host.js";

/** A point on a bone: `along` is how far from its origin to its tip (0 = origin, 0.5 = middle, 1 = tip). */
export interface PathPoint {
  id: string;
  bone: string;
  along: number;
  label: string;
}

export interface PathSample {
  frame: number;
  x: number;
  y: number;
}

/** The point's world position on a posed skeleton, or null when the rig has no such bone. */
export function pointWorld(skeleton: Skeleton, p: PathPoint): { x: number; y: number } | null {
  const bone = skeleton.findBone(p.bone) as Bone | undefined | null;
  if (!bone) return null;
  const out = { x: 0, y: 0 };
  bone.localToWorld(bone.data.length * p.along, 0, out);
  return out;
}

/** A private skeleton for `clip` that can be posed at any frame. */
export interface Sampler {
  skeleton: Skeleton;
  poseFrame(frame: number): Skeleton;
}

export function makeSampler(doc: AnimDocument, name: string, clip: ClipData): Sampler {
  const rig = withClip(doc, name, clip);
  const skeleton = new Skeleton(rig);
  const data = new AnimationStateData(rig);
  return {
    skeleton,
    poseFrame(frame) {
      skeleton.setToSetupPose();
      const state = new AnimationState(data);
      state.setAnimation(0, name, { loop: clip.loop });
      const t = frameTime(clip, frame);
      state.update(clip.loop ? Math.min(t, Math.max(0, clip.duration - 1e-4)) : t);
      state.apply(skeleton);
      skeleton.updateWorldTransform("reset");
      return skeleton;
    }
  };
}

/** The last frame a path covers: a loop's final frame equals its first, so it is left out. */
export function lastPathFrame(clip: ClipData): number {
  return clip.loop ? frameCount(clip) - 1 : frameCount(clip);
}

/** One sample per frame for each point (points the rig lacks are left out of the result). */
export function samplePaths(doc: AnimDocument, name: string, clip: ClipData, points: readonly PathPoint[]): Map<string, PathSample[]> {
  const sampler = makeSampler(doc, name, clip);
  const out = new Map<string, PathSample[]>();
  const last = lastPathFrame(clip);
  for (let frame = 0; frame <= last; frame++) {
    const sk = sampler.poseFrame(frame);
    for (const p of points) {
      const w = pointWorld(sk, p);
      if (!w) continue;
      let list = out.get(p.id);
      if (!list) out.set(p.id, (list = []));
      list.push({ frame, x: w.x, y: w.y });
    }
  }
  return out;
}

/** Frames where something that moves `bone` is keyed: the bone and its parents, and the IK constraints that drive them. */
export function keyFramesFor(doc: AnimDocument, clip: ClipData, bone: string): Set<number> {
  const chain = new Set<string>();
  const parentOf = new Map(doc.bones.map((b) => [b.name, b.parent as string | undefined]));
  for (let b: string | undefined = bone; b && !chain.has(b); b = parentOf.get(b)) chain.add(b);
  const times: number[] = [];
  const add = (keys: readonly { time: number }[] | undefined) => keys?.forEach((k) => times.push(k.time));
  for (const b of chain) {
    const tl = clip.bones[b];
    if (tl) for (const ch of ["rotate", "translate", "scale", "shear"] as const) add(tl[ch] as { time: number }[] | undefined);
  }
  for (const c of doc.ik) {
    if (!c.bones.some((b) => chain.has(b))) continue;
    add((clip.ik as unknown as Record<string, { time: number }[] | undefined>)[c.name]);
    const tl = clip.bones[c.target];
    if (tl) add(tl.translate as { time: number }[] | undefined);
  }
  return new Set(times.map((t) => timeToFrame(clip, t)));
}

/** Distance moved from each sample to the next (px per frame); one shorter than the list. */
export function segmentSpeeds(samples: readonly PathSample[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) out.push(Math.hypot(samples[i + 1]!.x - samples[i]!.x, samples[i + 1]!.y - samples[i]!.y));
  return out;
}

const SLOW = [0x3b82f6, 0x34d399, 0xfacc15, 0xff4d3d] as const;

/** Blue (slow, bunched dots) through green and yellow to red (fast, spread dots); `t` is speed over the fastest segment, 0..1. */
export function speedColor(t: number): number {
  const x = Math.min(1, Math.max(0, t)) * (SLOW.length - 1);
  const i = Math.min(SLOW.length - 2, Math.floor(x));
  const f = x - i;
  const mix = (shift: number) => Math.round(((SLOW[i]! >> shift) & 255) * (1 - f) + ((SLOW[i + 1]! >> shift) & 255) * f);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/** The frames a path shows: the whole clip, or `range` frames each side of `current`. */
export function onionWindow(current: number, last: number, range: "all" | number): { from: number; to: number } {
  if (range === "all") return { from: 0, to: last };
  return { from: Math.max(0, current - range), to: Math.min(last, current + range) };
}

/** Clips that swing a weapon get the weapon-tip path by default. */
export function isAttackClip(name: string): boolean {
  return /attack|swing|slash|strike|combo|shoot|stab|cast|smash|chop/i.test(name);
}

const TIP_BONES = ["weapon_tip", "tip"];

/** The weapon tip: a `weapon_tip` point bone when the rig has one, else the far end of the `weapon` bone. */
export function weaponTipPoint(doc: AnimDocument): PathPoint | null {
  const names = new Set(doc.bones.map((b) => b.name));
  const tip = TIP_BONES.find((n) => names.has(n));
  if (tip) return { id: "weapon-tip", bone: tip, along: 0, label: "Weapon tip" };
  return names.has("weapon") ? { id: "weapon-tip", bone: "weapon", along: 1, label: "Weapon tip" } : null;
}

/** Fist centre: the middle of the hand bone on the side that holds the weapon (the `weapon` bone's parent), else the near hand. */
export function fistPoint(doc: AnimDocument): PathPoint | null {
  const weapon = doc.bones.find((b) => b.name === "weapon");
  const hand = (weapon?.parent && /^hand/.test(weapon.parent) ? weapon.parent : null) ?? doc.bones.find((b) => /^hand_(near|l)$/.test(b.name))?.name ?? null;
  return hand ? { id: "fist", bone: hand as string, along: 0.5, label: "Fist centre" } : null;
}

// ------------------------------------------------------------------------------------------------------------ the overlay

/** Turns a toolbar button into a small icon button (name kept for screen readers and tooltips). */
export function setIcon(button: HTMLButtonElement, name: string, path: string): void {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  button.classList.add("tb-icon");
  button.setAttribute("aria-label", name);
  button.title = name;
  button.replaceChildren(svg);
}

/** The slot in the canvas toolbar (#pathstack) that holds the Paths and Pins buttons (shared with pins.ts). */
export function pathStack(view: HTMLElement | null): HTMLElement | null {
  if (!view) return null;
  let stack = document.getElementById("pathstack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "pathstack";
    view.append(stack);
  }
  return stack;
}

export interface PathSettings {
  on: boolean;
  selected: boolean;
  tip: boolean;
  fist: boolean;
  range: "all" | number;
}

const STORAGE_KEY = "atlas-editor-paths";

function readSettings(): PathSettings {
  const fallback: PathSettings = { on: false, selected: true, tip: false, fist: false, range: "all" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<PathSettings>) } : fallback;
  } catch {
    return fallback; // storage can be unavailable
  }
}

function writeSettings(s: PathSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // not remembered; the controls still work
  }
}

/** The points a settings object asks for, given the rig and the selection. */
export function pointsFor(doc: AnimDocument, s: PathSettings, selected: readonly string[]): PathPoint[] {
  const out: PathPoint[] = [];
  if (s.selected) {
    for (const b of selected) if (b !== "root") out.push({ id: `bone:${b}`, bone: b, along: 0, label: b });
  }
  const tip = s.tip ? weaponTipPoint(doc) : null;
  if (tip) out.push(tip);
  const fist = s.fist ? fistPoint(doc) : null;
  if (fist && !out.some((p) => p.bone === fist.bone && p.along === fist.along)) out.push(fist);
  return out;
}

/** Mounts the overlay and its controls. Called once, with the host, after Pixi is up. */
export function installMotionPaths(host: EditorHost): { hit(clientX: number, clientY: number): boolean } {
  const view = document.getElementById("view");
  const settings = readSettings();
  let paths = new Map<string, PathSample[]>();
  let keyFrames = new Map<string, Set<number>>();
  let sig = "";
  let lastClip: ClipData | null = null;
  let lastName = "";
  let timer = 0;
  let autoFor = "";
  const gfx = new Graphics();
  gfx.label = "motionPaths";
  host.world.addChild(gfx);

  const bar = document.createElement("div");
  bar.id = "pathsbar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "paths-toggle";
  setIcon(toggle, "Paths", "M3 19c3-9 6 3 9-6s6-4 9-9M3 19h.01M12 13h.01M21 4h.01");
  const checks = document.createElement("div");
  checks.id = "paths-opts";
  const mk = (id: string, text: string, key: "selected" | "tip" | "fist") => {
    const label = document.createElement("label");
    label.id = id;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings[key];
    box.addEventListener("change", () => {
      settings[key] = box.checked;
      writeSettings(settings);
      recompute();
    });
    label.append(box, ` ${text}`);
    return label;
  };
  const range = document.createElement("select");
  range.id = "paths-range";
  for (const [value, text] of [["all", "Whole clip"], ["2", "±2 frames"], ["4", "±4 frames"], ["8", "±8 frames"]] as const) range.append(new Option(text, value));
  range.value = settings.range === "all" ? "all" : String(settings.range);
  range.addEventListener("change", () => {
    settings.range = range.value === "all" ? "all" : Number(range.value);
    writeSettings(settings);
    draw();
  });
  checks.append(mk("paths-sel", "Selected", "selected"), mk("paths-tip", "Weapon tip", "tip"), mk("paths-fist", "Fist centre", "fist"), range);
  bar.append(toggle, checks);
  pathStack(view)?.append(bar);

  function syncControls(): void {
    toggle.classList.toggle("on", settings.on);
    toggle.setAttribute("aria-pressed", String(settings.on));
    bar.classList.toggle("open", settings.on);
    (document.querySelector("#paths-tip input") as HTMLInputElement).checked = settings.tip;
  }
  toggle.addEventListener("click", () => {
    settings.on = !settings.on;
    writeSettings(settings);
    syncControls();
    recompute();
  });

  function frameNow(): number {
    return timeToFrame(host.clip, host.time);
  }

  function recompute(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const doc = host.doc;
      paths = new Map();
      keyFrames = new Map();
      if (doc && settings.on && host.clipName) {
        const points = pointsFor(doc, settings, host.selectedBones());
        paths = samplePaths(doc, host.clipName, host.clip, points);
        for (const p of points) keyFrames.set(p.id, keyFramesFor(doc, host.clip, p.bone));
      }
      draw();
    }, 40);
  }

  function draw(): void {
    gfx.clear();
    host.world.addChild(gfx);
    if (!settings.on) return;
    const px = 1 / Math.max(0.01, host.zoom());
    const cur = frameNow();
    const win = onionWindow(cur, lastPathFrame(host.clip), settings.range);
    for (const [id, all] of paths) {
      const samples = all.filter((s) => s.frame >= win.from && s.frame <= win.to);
      if (samples.length < 1) continue;
      const speeds = segmentSpeeds(samples);
      const top = Math.max(1e-6, ...speeds);
      for (let i = 0; i < speeds.length; i++) {
        gfx.moveTo(samples[i]!.x, samples[i]!.y).lineTo(samples[i + 1]!.x, samples[i + 1]!.y).stroke({ width: 2.2 * px, color: speedColor(speeds[i]! / top), alpha: 0.95, cap: "round" });
      }
      const keys = keyFrames.get(id);
      for (const s of samples) {
        const key = keys?.has(s.frame) ?? false;
        gfx.circle(s.x, s.y, (key ? 4.2 : 2.2) * px).fill({ color: key ? 0xffffff : 0x1a1d24, alpha: 1 }).stroke({ width: (key ? 1.6 : 1) * px, color: key ? 0x101216 : 0xdfe6f2, alpha: 1 });
      }
      const here = samples.find((s) => s.frame === cur);
      if (here) gfx.circle(here.x, here.y, 7.5 * px).stroke({ width: 2.4 * px, color: 0xf0b84a, alpha: 1 });
    }
  }

  /** The path dot under a screen point, if any. */
  function dotAt(clientX: number, clientY: number): number | null {
    if (!settings.on) return null;
    const rect = host.app.canvas.getBoundingClientRect();
    const win = onionWindow(frameNow(), lastPathFrame(host.clip), settings.range);
    let best: { frame: number; d: number } | null = null;
    for (const all of paths.values()) {
      for (const s of all) {
        if (s.frame < win.from || s.frame > win.to) continue;
        const g = host.world.toGlobal({ x: s.x, y: s.y });
        const d = Math.hypot(rect.left + g.x - clientX, rect.top + g.y - clientY);
        if (d <= 8 && (!best || d < best.d)) best = { frame: s.frame, d };
      }
    }
    return best ? best.frame : null;
  }

  // A press on a dot jumps to its frame and is swallowed before the canvas can start a drag.
  view?.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("#pathsbar")) return;
      const frame = dotAt(e.clientX, e.clientY);
      if (frame === null) return;
      e.stopPropagation();
      e.preventDefault();
      host.setTime(frameTime(host.clip, frame), true);
    },
    true
  );

  function onChange(): void {
    const name = host.clipName;
    if (name !== autoFor) {
      autoFor = name;
      if (isAttackClip(name) && host.doc && weaponTipPoint(host.doc)) {
        settings.on = true;
        settings.tip = true;
        syncControls();
      }
    }
    const rigSig = host.doc ? host.doc.name : "";
    const next = `${name}|${rigSig}|${host.selectedBones().join(",")}`;
    if (host.clip !== lastClip || name !== lastName || next !== sig) {
      lastClip = host.clip;
      lastName = name;
      sig = next;
      recompute();
    } else draw();
  }
  // Scripted demos read the dot positions from here to click them.
  (window as unknown as { atlasPaths?: unknown }).atlasPaths = {
    dots: () => {
      const rect = host.app.canvas.getBoundingClientRect();
      return [...paths].map(([id, list]) => ({
        id,
        dots: list.map((s) => {
          const g = host.world.toGlobal({ x: s.x, y: s.y });
          return { frame: s.frame, x: rect.left + g.x, y: rect.top + g.y, key: keyFrames.get(id)?.has(s.frame) ?? false };
        })
      }));
    },
    settings: () => ({ ...settings })
  };
  host.on("clip", onChange);
  host.on("rig", onChange);
  host.on("select", onChange);
  host.on("pose", onChange);
  host.on("time", draw);
  syncControls();
  onChange();
  return { hit: (x, y) => dotAt(x, y) !== null };
}
