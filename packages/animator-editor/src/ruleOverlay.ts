/*
 * Atlas Animator editor: the live rule checker overlay (the design notes, section 4).
 *
 * Shows the user's pose rules (poseRules.ts) where the animator is looking, in plain English:
 *   - red outlines and short labels on the canvas, on the bones that break a rule, redrawn on every `pose` event;
 *   - a strip of rule chips above the canvas, one per rule, green or red. A red chip says what is wrong and the first bad frame;
 *     clicking it jumps to that frame and selects the bone;
 *   - red ticks on the timeline at every bad frame, from a debounced whole-clip check after each commit.
 * It shows in the Animate and Pro workspaces and has one toggle. It reads the editor only through the host (host.ts) and never
 * edits a clip. The rules themselves live in poseRules.ts; this file only finds out which bones and frames break them.
 */
import { AnimationState, AnimationStateData, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { Graphics, Text } from "pixi.js";
import { frameCount, frameTime, timeToFrame } from "./clipModel.js";
import { withClip } from "./gates.js";
import { addTimelineDecorator, type EditorHost } from "./host.js";
import { poseRuleHits, referenceOf, type PoseRule, type Reference, type RuleHit } from "./poseRules.js";

/** One chip per rule, in this order. `chip` is the short name shown when the rule is fine. */
export const RULES: readonly { rule: PoseRule; chip: string }[] = [
  { rule: "fist on own arm", chip: "Fist on arm" },
  { rule: "weapon across face", chip: "Weapon clear of face" },
  { rule: "eyes widen", chip: "Eyes stay put" },
  { rule: "arm behind head", chip: "Arm not behind head" },
  { rule: "upper arm thrown back", chip: "Arm not thrown back" },
  { rule: "limb stretch", chip: "Limbs not stretched" },
  { rule: "limb scale", chip: "Limbs not scaled" },
  { rule: "head scale", chip: "Head size" }
];

/** A rule hit turned into something to show: plain words, and the bones to outline. */
export interface Finding {
  rule: PoseRule;
  text: string;
  bones: string[];
  /** The bone the label sits on and a click selects. */
  bone: string;
}

const SIDE_WORD: Record<string, string> = { l: "left", r: "right", near: "near", far: "far" };
const side = (s: string): string => SIDE_WORD[s] ?? s;
const PART_WORD: Record<string, string> = { upper_arm: "upper arm", forearm: "forearm", hand: "hand", thigh: "thigh", shin: "shin", foot: "foot" };

/** "upper_arm_near" -> "near upper arm". */
export function boneWords(bone: string): string {
  const m = /^([a-z_]+?)_(l|r|near|far)$/.exec(bone);
  return m ? `${side(m[2]!)} ${PART_WORD[m[1]!] ?? m[1]!.replace(/_/g, " ")}` : bone.replace(/_/g, " ");
}

/** The weapon's name for the sentence ("Axe"). */
export interface DescribeContext {
  weaponName: string;
}

const WEAPON_WORDS = ["axe", "sword", "katana", "bow", "staff", "mace", "spear", "hammer", "dagger", "shield", "wand"];

/** "Axe" from a weapon art name like "axe_a" or "weapon_katana"; "The weapon" when it is not a known kind. */
export function weaponNameOf(artName: string | null | undefined): string {
  const lower = (artName ?? "").toLowerCase();
  const kind = WEAPON_WORDS.find((w) => lower.includes(w));
  return kind ? kind[0]!.toUpperCase() + kind.slice(1) : "The weapon";
}

/** The side word of a limb bone ("hand_near" -> "near"); "near" for a bone with no side. */
const sideOf = (bone: string): string => side(/_(l|r|near|far)$/.exec(bone)?.[1] ?? "near");

/** Plain-English text for one rule hit; the hit's own `bones` say what to outline (the first is where the label sits). */
export function describeHit(hit: RuleHit, ctx: DescribeContext): Finding {
  const bones = hit.bones;
  const bone = bones[0] ?? "head";
  const m = hit.message;
  const say = (text: string): Finding => ({ rule: hit.rule, text, bones, bone });
  switch (hit.rule) {
    case "fist on own arm":
      return say(m.startsWith("skin_hand_") ? `The ${sideOf(bone)} fist art left its hand` : `Fist came off the ${sideOf(bone)} arm`);
    case "weapon across face":
      return say(`${ctx.weaponName} crosses the face`);
    case "eyes widen":
      if (m.startsWith("face bone")) return say(`The face got ${m.includes("is scaled") ? "stretched" : "slanted"} (${bone})`);
      return say(m.startsWith("eyes show") ? "The eyes show a look that is not allowed" : "The eyes got wider");
    case "arm behind head":
      return say(`The ${sideOf(bone)} arm goes behind the head`);
    case "upper arm thrown back":
      return say(`The ${sideOf(bone)} arm is thrown too far back`);
    case "limb stretch":
      return say(`The ${boneWords(bone)} is stretched too long`);
    case "limb scale":
      return say(`The ${boneWords(bone)} is scaled (limbs never stretch)`);
    case "head scale":
      return say("The head is the wrong size");
  }
}

function contextOf(skeleton: Skeleton): DescribeContext {
  const slot = skeleton.findSlot("weapon");
  return { weaponName: weaponNameOf(slot?.attachment?.name ?? slot?.drivenPlaceholder ?? slot?.placeholder ?? slot?.data.name) };
}

const references = new WeakMap<AnimDocument, Reference>();

/** The setup-pose numbers the rules compare with, built once per rig document. */
function referenceFor(doc: AnimDocument): Reference {
  let ref = references.get(doc);
  if (!ref) {
    const bare = new Skeleton(doc);
    bare.setToSetupPose();
    bare.updateWorldTransform("reset");
    ref = referenceOf(bare);
    references.set(doc, ref);
  }
  return ref;
}

/** Findings of the skeleton as it is posed now (the live pose, including unkeyed gizmo edits). */
export function liveFindings(skeleton: Skeleton, doc: AnimDocument): Finding[] {
  const ctx = contextOf(skeleton);
  return poseRuleHits(skeleton, referenceFor(doc)).map((h) => describeHit(h, ctx));
}

/** Every frame of `clip` that breaks a rule, with what breaks. Frame -> findings (frames that are fine are absent). */
export function clipFindings(doc: AnimDocument, name: string, clip: ClipData): Map<number, Finding[]> {
  // Remembered per clip object (a commit makes a new one): the rule overlay and the live gate HUD ask for the same result.
  const hit = wholeCache.get(clip);
  if (hit && hit.doc === doc && hit.name === name) return hit.result;
  const result = computeClipFindings(doc, name, clip);
  wholeCache.set(clip, { doc, name, result });
  return result;
}

const wholeCache = new WeakMap<ClipData, { doc: AnimDocument; name: string; result: Map<number, Finding[]> }>();

function computeClipFindings(doc: AnimDocument, name: string, clip: ClipData): Map<number, Finding[]> {
  const rig = withClip(doc, name, clip);
  const skeleton = new Skeleton(rig);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("reset");
  const reference = referenceFor(doc);
  const ctx = contextOf(skeleton);
  const data = new AnimationStateData(rig);
  const out = new Map<number, Finding[]>();
  const last = clip.loop ? frameCount(clip) - 1 : frameCount(clip);
  for (let f = 0; f <= last; f++) {
    skeleton.setToSetupPose();
    const state = new AnimationState(data);
    state.setAnimation(0, name, { loop: clip.loop });
    const t = frameTime(clip, f);
    state.update(clip.loop ? Math.min(t, Math.max(0, clip.duration - 1e-4)) : t);
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
    const hits = poseRuleHits(skeleton, reference);
    if (hits.length) out.set(f, hits.map((h) => describeHit(h, ctx)));
  }
  return out;
}

/** What a chip shows for each rule: its first bad frame (or null when the rule holds everywhere). */
export interface ChipState {
  rule: PoseRule;
  chip: string;
  /** Null = green. */
  bad: { text: string; frame: number; bone: string } | null;
}

/** Chips from the whole-clip result plus the live pose (a live-only break, not yet keyed, counts as the current frame). */
export function chipStates(whole: ReadonlyMap<number, Finding[]>, live: readonly Finding[], currentFrame: number): ChipState[] {
  const frames = [...whole.keys()].sort((a, b) => a - b);
  return RULES.map(({ rule, chip }) => {
    for (const f of frames) {
      const hit = whole.get(f)!.find((x) => x.rule === rule);
      if (hit) return { rule, chip, bad: { text: hit.text, frame: f, bone: hit.bone } };
    }
    const hit = live.find((x) => x.rule === rule);
    return { rule, chip, bad: hit ? { text: hit.text, frame: currentFrame, bone: hit.bone } : null };
  });
}

// ------------------------------------------------------------------------------------------------------------ the DOM part

const STORAGE_KEY = "atlas-editor-rules";
const RED = 0xff4d4d;

function readOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true; // storage can be unavailable
  }
}

function writeOn(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // not remembered; the toggle still works
  }
}

/** Mounts the overlay. Called once, with the host, after Pixi is up. */
export function installRuleOverlay(host: EditorHost): void {
  const view = document.getElementById("view");
  if (!view) return;
  let on = readOn();
  let whole: Map<number, Finding[]> = new Map();
  let wholeFor = "";
  let live: Finding[] = [];
  let lastClip: ClipData | null = null;
  let lastZoom = 0;
  let signature = "";

  const strip = document.createElement("div");
  strip.id = "rulestrip";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "rules-toggle";
  toggle.textContent = "Turn rules off";
  toggle.className = "btn sm";
  const chips = document.createElement("div");
  chips.id = "rulechips";
  const row = document.createElement("div");
  row.id = "rulerow";
  const pill = document.createElement("button");
  pill.type = "button";
  pill.id = "rules-pill";
  row.append(pill);
  chips.className = "pop";
  strip.append(row, chips);
  let open = false;
  (document.getElementById("vmid") ?? view).append(strip);

  const gfx = new Graphics();
  gfx.label = "ruleOverlay";
  host.world.addChild(gfx);
  const labels: Text[] = [];

  const visible = (): boolean => on && (document.body.classList.contains("ws-animate") || document.body.classList.contains("ws-pro")) && !document.body.classList.contains("setup");
  const frameNow = (): number => timeToFrame(host.clip, host.time);

  function drawCanvas(): void {
    gfx.clear();
    for (const l of labels) l.visible = false;
    if (!visible() || !host.skeleton) return;
    const px = 1 / (host.zoom() || 1);
    lastZoom = host.zoom();
    const seen = new Set<string>();
    let n = 0;
    for (const f of live) {
      const labelBone = host.skeleton.findBone(f.bone);
      for (const name of f.bones) {
        const bone = host.skeleton.findBone(name);
        if (!bone || seen.has(name)) continue;
        seen.add(name);
        const w = bone.world;
        const len = bone.data.length * Math.hypot(w.a, w.c);
        const ox = w.x;
        const oy = w.y;
        if (len < 2) {
          gfx.circle(ox, oy, 20).fill({ color: RED, alpha: 0.12 }).stroke({ width: 3 * px, color: RED });
          continue;
        }
        const dx = (w.a * bone.data.length) / len;
        const dy = (w.c * bone.data.length) / len;
        const half = 15 + 2 * px;
        const pad = 8;
        const sx = ox - dx * pad;
        const sy = oy - dy * pad;
        const ex = ox + dx * (len + pad);
        const ey = oy + dy * (len + pad);
        gfx
          .poly([sx - dy * half, sy + dx * half, ex - dy * half, ey + dx * half, ex + dy * half, ey - dx * half, sx + dy * half, sy - dx * half])
          .fill({ color: RED, alpha: 0.12 })
          .stroke({ width: 3 * px, color: RED, join: "round" });
      }
      if (labelBone && n < 6) {
        let label = labels[n];
        if (!label) {
          label = new Text({ text: "", style: { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: 14, fontWeight: "700", fill: 0xffffff, stroke: { color: 0x7a1010, width: 4 } } });
          label.label = "ruleLabel";
          host.world.addChild(label);
          labels.push(label);
        }
        const w = labelBone.world;
        const len = labelBone.data.length * Math.hypot(w.a, w.c);
        label.text = f.text;
        label.scale.set(px);
        label.anchor.set(0.5, 1);
        label.position.set(w.x + (w.a * labelBone.data.length) / 2, w.y + (w.c * labelBone.data.length) / 2 - Math.max(24, len * 0.1) - n * 18 * px);
        label.visible = true;
        n++;
      }
    }
    host.world.addChild(gfx);
    for (const l of labels) host.world.addChild(l);
  }

  function renderChips(): void {
    const states = visible() || on ? chipStates(whole, live, frameNow()) : [];
    const sig = `${on}|${open}|${states.map((s) => (s.bad ? `${s.rule}:${s.bad.text}:${s.bad.frame}:${s.bad.bone}` : s.rule)).join("|")}`;
    if (sig === signature) return;
    signature = sig;
    chips.replaceChildren();
    const problems = states.filter((s) => s.bad).length;
    // ONE pill is the whole control: off, all OK, or N broken. It opens a popover under itself (a row per broken rule, and the off switch).
    pill.className = !on ? "chip" : problems ? "chip chip-bad bad" : "chip chip-ok ok";
    const caret = open ? "▴" : "▾";
    pill.textContent = !on ? "Rules: off" : problems ? `Rules: ${problems} broken ${caret}` : `Rules: all OK ${caret}`;
    pill.setAttribute("aria-expanded", String(on && open));
    pill.title = !on ? "Rule checker is off. Click to turn it on" : "Rule checker: click to list the broken rules or turn it off";
    chips.hidden = !on || !open;
    if (chips.hidden) return;
    if (!problems) chips.append(Object.assign(document.createElement("div"), { className: "rule-empty", textContent: "No broken rules on this frame" }));
    for (const s of states) {
      if (!s.bad) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `rule-chip ${s.bad ? "bad" : "ok"}`;
      b.dataset.rule = s.rule;
      if (s.bad) {
        b.dataset.frame = String(s.bad.frame);
        b.dataset.bone = s.bad.bone;
        for (const [cls, text] of [["rc-name", s.bad.text], ["rc-frame", `frame ${s.bad.frame}`], ["rc-go", "Go"]] as const) b.append(Object.assign(document.createElement("span"), { className: cls, textContent: text }));
        const { frame, bone } = s.bad;
        b.addEventListener("click", () => {
          host.setTime(frameTime(host.clip, frame));
          host.selectBone(bone);
        });
      } else {
        b.textContent = s.chip;
        b.disabled = true;
      }
      chips.append(b);
    }
    chips.append(toggle);
  }

  function refresh(): void {
    live = visible() && host.skeleton && host.doc ? liveFindings(host.skeleton, host.doc) : [];
    drawCanvas();
    renderChips();
  }

  // The whole-clip check: debounced, and only for what is on screen.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleWhole(delay = 300): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!visible() || !host.doc || !host.clipName) {
        whole = new Map();
        host.redrawTimeline();
        return;
      }
      try {
        whole = clipFindings(host.doc, host.clipName, host.clip);
      } catch (error) {
        console.error("rule check failed", error);
        whole = new Map();
      }
      wholeFor = host.clipName;
      lastClip = host.clip;
      host.redrawTimeline();
      refresh();
    }, delay);
  }

  host.on("pose", () => {
    // A new clip object means a commit (or undo / redo) happened since the last whole-clip check.
    if (visible() && host.clip !== lastClip) scheduleWhole();
    refresh();
  });
  host.on("clip", () => scheduleWhole(30));
  host.on("rig", () => scheduleWhole(60));
  host.on("time", () => renderChips());

  const setOn = (next: boolean) => {
    on = next;
    if (!on) open = false;
    writeOn(on);
    signature = "";
    scheduleWhole(0);
    refresh();
    host.redrawTimeline();
  };
  pill.addEventListener("click", () => {
    if (!on) return setOn(true);
    open = !open;
    signature = "";
    renderChips();
  });
  toggle.addEventListener("click", () => setOn(false));
  const close = () => {
    if (!open) return;
    open = false;
    signature = "";
    renderChips();
  };
  document.addEventListener("pointerdown", (e) => {
    if (open && !strip.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  new MutationObserver(() => {
    signature = "";
    scheduleWhole(30);
    refresh();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // Zoom changes redraw the outlines (their widths are in screen pixels).
  const watchZoom = (): void => {
    requestAnimationFrame(watchZoom);
    if (visible() && live.length && Math.abs(host.zoom() - lastZoom) > 1e-6) {
      drawCanvas();
      host.app.render();
    }
  };
  requestAnimationFrame(watchZoom);

  addTimelineDecorator((g, frameX, w, h, rulerH) => {
    if (!visible() || wholeFor !== host.clipName) return;
    const left = 150;
    g.save();
    g.beginPath();
    g.rect(left + 1, 0, Math.max(0, w - left - 1), h);
    g.clip();
    for (const f of whole.keys()) {
      const x = Math.round(frameX(f)) + 0.5;
      g.strokeStyle = "rgba(255,77,77,0.28)";
      g.beginPath();
      g.moveTo(x, rulerH);
      g.lineTo(x, h);
      g.stroke();
      g.fillStyle = "#ff4d4d";
      g.fillRect(x - 2, 0, 4, rulerH - 2);
    }
    g.restore();
  });

  scheduleWhole(0);
  refresh();
}
