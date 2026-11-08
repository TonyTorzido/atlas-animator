/*
 * Atlas Animator editor: original implementation.
 *
 * The live gate HUD: three small chips in the corner of the canvas (Outline, Rules, IK reach) that show pass / warn / fail for the pose
 * under the playhead while you scrub and play. Click a chip to jump to the next frame that breaks it (Shift: the previous one) and select
 * the bone at fault. It is built to cost nothing while playing:
 *   - playing: the chips read the whole-clip results (computed once per clip edit, on idle time) by frame number, no skeleton work;
 *   - paused or scrubbing: the pose rules and IK reach of the live skeleton (unkeyed edits included), throttled to one run per 40 ms;
 *   - DOM is touched only when a chip's state changes, and the chips refresh at most every 100 ms during playback.
 * The outline gate (gateOverlay.ts) renders the figure to check ink breaks, so the HUD never runs it by itself: it shows that gate's own
 * result (this pose when paused, the "Check clip" result when playing) and a click on an unchecked chip starts the clip check.
 */
import { timeToFrame, frameTime } from "./clipModel.js";
import { clipIkFindingsCached, ikFindings, nextBadFrame, restReaches, type IkFinding } from "./liveGates.js";
import { clipFindings, liveFindings, type Finding } from "./ruleOverlay.js";
import { addTimelineDecorator, type EditorHost } from "./host.js";

type Level = "ok" | "warn" | "fail" | "idle";
interface ChipView {
  level: Level;
  /** Short value after the label. */
  value: string;
  title: string;
  /** Frames of the open clip where this check fails (for the jump and the count). */
  bad: number[];
  /** The bone to select when the current pose fails. */
  bone: string | null;
}
export interface HudState {
  outline: ChipView;
  rules: ChipView;
  ik: ChipView;
}

const STORE = "atlasEditor.gateHud";
const PLAY_GAP_MS = 100;
const SCRUB_GAP_MS = 40;

export interface GateHudApi {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  toggle(): void;
  state(): HudState;
  /** Recomputes and redraws now (the throttle skipped). */
  refresh(): void;
  /** Counters for the playback check: how many refreshes ran and the total ms they took. */
  stats(): { runs: number; ms: number; wholeRuns: number };
}

declare global {
  interface Window {
    atlasGateHud?: GateHudApi;
  }
}

const readOn = (): boolean => {
  try {
    return localStorage.getItem(STORE) !== "off";
  } catch {
    return true;
  }
};

function emptyState(): HudState {
  const idle: ChipView = { level: "idle", value: "", title: "", bad: [], bone: null };
  return { outline: { ...idle }, rules: { ...idle }, ik: { ...idle } };
}

function makeChip(id: string, label: string) {
  const el = document.createElement("button");
  el.type = "button";
  el.id = `gatehud-${id}`;
  el.className = "gh-chip";
  el.dataset.chip = id;
  const dot = document.createElement("i");
  dot.className = "gh-dot";
  const name = document.createElement("span");
  name.className = "gh-name";
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "gh-val";
  el.append(dot, name, value);
  return { el, value };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function installLiveGateHud(host: EditorHost): void {
  const view = document.getElementById("view");
  if (!view) return;
  let on = readOn();
  let rulesWhole = new Map<number, Finding[]>();
  let ikWhole = new Map<number, IkFinding[]>();
  let wholeFor: unknown = null;
  let wholeToken = 0;
  let wholeRuns = 0;
  let runs = 0;
  let ms = 0;
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let sig = "";
  let state: HudState = emptyState();

  const root = document.createElement("div");
  root.id = "gatehud";
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Live gate checks");
  const chips = {
    outline: makeChip("outline", "Outline"),
    rules: makeChip("rules", "Rules"),
    ik: makeChip("ik", "IK reach")
  };
  root.append(chips.outline.el, chips.rules.el, chips.ik.el);
  view.append(root);

  const visible = (): boolean =>
    on && (document.body.classList.contains("ws-animate") || document.body.classList.contains("ws-pro")) && !document.body.classList.contains("setup") && !!host.skeleton && !!host.doc;

  // ---------------------------------------------------------------- whole clip, on idle time

  const idle = (fn: () => void): void => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(fn, { timeout: 600 });
    else setTimeout(fn, 60);
  };

  function scheduleWhole(delay = 250): void {
    const token = ++wholeToken;
    setTimeout(() => {
      if (token !== wholeToken) return;
      idle(() => {
        if (token !== wholeToken || !host.doc || !host.clipName) return;
        const clip = host.clip;
        try {
          rulesWhole = clipFindings(host.doc, host.clipName, clip);
          if (token !== wholeToken) return;
          ikWhole = clipIkFindingsCached(host.doc, host.clipName, clip);
        } catch (error) {
          console.warn("gate HUD clip check skipped (the clip does not fit this rig)", error);
          rulesWhole = new Map();
          ikWhole = new Map();
        }
        wholeFor = clip;
        wholeRuns++;
        host.redrawTimeline();
        refresh();
      });
    }, delay);
  }

  const wholeValid = (): boolean => wholeFor === host.clip;
  const frameNow = (): number => timeToFrame(host.clip, host.time);

  // ---------------------------------------------------------------- the three chips

  function ruleChip(frame: number): ChipView {
    const bad = wholeValid() ? [...rulesWhole.keys()] : [];
    if (host.playing && !wholeValid()) return { level: "idle", value: "...", title: "Checking the clip's pose rules...", bad, bone: null };
    // Paused: the live pose (unkeyed edits count). Playing: the clip result by frame.
    const here: readonly Finding[] = host.playing ? (rulesWhole.get(frame) ?? []) : host.skeleton && host.doc ? liveFindings(host.skeleton, host.doc) : [];
    if (here.length) {
      const more = bad.length ? `. ${plural(bad.length, "frame")} in the clip break a rule: click to jump.` : "";
      return { level: "fail", value: here.length > 1 ? `${here.length}` : "Fail", title: here.map((f) => f.text).join("; ") + more, bad, bone: here[0]!.bone };
    }
    const title = bad.length ? `Pose rules hold here. ${plural(bad.length, "frame")} elsewhere in the clip break one: click to jump.` : "Pose rules hold on every frame of the clip.";
    return { level: "ok", value: "OK", title, bad, bone: null };
  }

  function ikChip(frame: number): ChipView {
    const bad = wholeValid() ? [...ikWhole.keys()] : [];
    if (!host.doc?.ik.length) return { level: "idle", value: "none", title: "This rig has no IK chains", bad, bone: null };
    if (host.playing && !wholeValid()) return { level: "idle", value: "...", title: "Checking IK reach...", bad, bone: null };
    const here: readonly IkFinding[] = host.playing ? (ikWhole.get(frame) ?? []) : host.skeleton ? ikFindings(host.skeleton, restReaches(host.doc)) : [];
    if (here.length) {
      const fail = here.some((f) => f.level === "fail");
      const more = bad.length ? `. ${plural(bad.length, "frame")} in the clip reach full stretch: click to jump.` : "";
      return { level: fail ? "fail" : "warn", value: fail ? "Max" : "Near", title: here.map((f) => f.text).join("; ") + more, bad, bone: here[0]!.bone };
    }
    const title = bad.length ? `Every IK chain has slack here. ${plural(bad.length, "frame")} elsewhere reach full stretch: click to jump.` : "Every IK chain keeps slack on every frame of the clip.";
    return { level: "ok", value: "OK", title, bad, bone: null };
  }

  function outlineChip(frame: number): ChipView {
    const gate = window.atlasGate;
    const sum = gate?.summary();
    const quiet = (value: string, title: string, bad: number[] = []): ChipView => ({ level: "idle", value, title, bad, bone: null });
    if (!gate || !sum || !sum.applies) return quiet("n/a", "The outline gate checks the pro rigs");
    if (!sum.worn) return quiet("n/a", "Wear a swag item to check its outline");
    const clipBad = sum.clip?.bad ?? [];
    if (!gate.enabled()) return quiet("off", "Outline gate is off: click to turn it on", clipBad);
    if (host.playing) {
      if (!sum.clip) return quiet("unchecked", "Playing: the outline gate needs the whole clip checked. Click to check the clip");
      const failed = clipBad.includes(frame);
      return { level: failed ? "fail" : "ok", value: failed ? "Fail" : "OK", title: failed ? `Broken ink outline at frame ${frame}` : "Outline unbroken here (from the clip check)", bad: clipBad, bone: null };
    }
    if (sum.poseBreaks === null) return quiet("...", sum.checking ? "Checking the clip..." : "Checking this pose...", clipBad);
    if (sum.poseBreaks > 0) {
      const more = clipBad.length ? `; ${plural(clipBad.length, "frame")} in the clip` : "";
      return { level: "fail", value: `${sum.poseBreaks}`, title: `${plural(sum.poseBreaks, "outline break")} on this pose${more}`, bad: clipBad, bone: null };
    }
    const title = clipBad.length ? `Outline unbroken on this pose; ${plural(clipBad.length, "frame")} elsewhere break it: click to jump` : "Outline unbroken on this pose";
    return { level: "ok", value: "OK", title, bad: clipBad, bone: null };
  }

  const nameOf = (k: "outline" | "rules" | "ik") => (k === "ik" ? "IK reach" : k[0]!.toUpperCase() + k.slice(1));

  function paint(next: HudState): void {
    const shown = visible();
    const s = JSON.stringify(next) + `|${shown}`;
    if (s === sig) return;
    sig = s;
    root.classList.toggle("show", shown);
    for (const k of ["outline", "rules", "ik"] as const) {
      const c = next[k];
      const chip = chips[k];
      chip.el.dataset.level = c.level;
      chip.el.title = c.title;
      chip.el.setAttribute("aria-label", `${nameOf(k)}: ${c.value || c.level}. ${c.title}`);
      chip.value.textContent = c.bad.length && c.level !== "idle" ? `${c.value} · ${c.bad.length} f` : c.value;
    }
  }

  function refresh(): void {
    last = performance.now();
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    if (!visible()) {
      paint(state);
      return;
    }
    const t0 = performance.now();
    const frame = frameNow();
    try {
      state = { outline: outlineChip(frame), rules: ruleChip(frame), ik: ikChip(frame) };
    } catch (error) {
      console.error("gate HUD failed", error);
    }
    runs++;
    ms += performance.now() - t0;
    paint(state);
  }

  function request(): void {
    if (!on) return;
    const gap = host.playing ? PLAY_GAP_MS : SCRUB_GAP_MS;
    const wait = gap - (performance.now() - last);
    if (wait <= 0) refresh();
    else if (!pending) pending = setTimeout(refresh, wait);
  }

  // ---------------------------------------------------------------- clicks: jump to the next failing frame

  function activate(id: "outline" | "rules" | "ik", back: boolean): void {
    const chip = state[id];
    if (id === "outline") {
      const gate = window.atlasGate;
      const sum = gate?.summary();
      if (gate && sum?.applies && sum.worn && !gate.enabled()) {
        gate.setEnabled(true);
        return;
      }
      if (gate && sum?.applies && sum.worn && !sum.clip && !sum.checking) {
        host.status("Checking every frame for broken outlines...");
        void gate.checkClip().then(refresh);
        return;
      }
    }
    if (chip.bone) host.selectBone(chip.bone);
    const target = nextBadFrame(chip.bad, frameNow(), back ? -1 : 1);
    if (target === null) {
      if (!chip.bone) host.status(chip.level === "idle" ? chip.title : `${nameOf(id)}: nothing to fix in this clip`);
      return;
    }
    if (host.playing) host.pause();
    host.setTime(frameTime(host.clip, target), true);
  }
  for (const id of ["outline", "rules", "ik"] as const) chips[id].el.addEventListener("click", (e) => activate(id, e.shiftKey));

  // ---------------------------------------------------------------- wiring

  host.on("pose", () => {
    // A commit makes a new clip object: re-check it on idle time.
    if (on && wholeFor !== host.clip) scheduleWhole(300);
    request();
  });
  host.on("time", request);
  host.on("clip", () => {
    scheduleWhole(120);
    request();
  });
  host.on("rig", () => scheduleWhole(80));
  host.on("skins", request);
  window.atlasGate?.onChange(request);
  new MutationObserver(() => {
    scheduleWhole(60);
    refresh();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  addTimelineDecorator((g, frameX, w, h, rulerH) => {
    if (!visible() || !wholeValid()) return;
    g.save();
    g.beginPath();
    g.rect(151, 0, Math.max(0, w - 151), h);
    g.clip();
    for (const [f, hits] of ikWhole) {
      const x = Math.round(frameX(f)) + 0.5;
      g.fillStyle = hits.some((k) => k.level === "fail") ? "#d17bff" : "rgba(209,123,255,0.55)";
      g.beginPath();
      g.moveTo(x - 4, rulerH);
      g.lineTo(x + 4, rulerH);
      g.lineTo(x, rulerH - 6);
      g.closePath();
      g.fill();
    }
    g.restore();
  });

  const api: GateHudApi = {
    enabled: () => on,
    setEnabled(next) {
      on = next;
      try {
        localStorage.setItem(STORE, on ? "on" : "off");
      } catch {
        // not remembered
      }
      sig = "";
      if (on) scheduleWhole(0);
      refresh();
      host.redrawTimeline();
      host.status(on ? "Live gate HUD on" : "Live gate HUD off");
    },
    toggle: () => api.setEnabled(!on),
    state: () => state,
    refresh,
    stats: () => ({ runs, ms, wholeRuns })
  };
  window.atlasGateHud = api;
  scheduleWhole(0);
  refresh();
}
