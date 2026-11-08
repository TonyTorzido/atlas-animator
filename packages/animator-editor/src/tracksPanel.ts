/*
 * Atlas Animator editor: original implementation.
 *
 * Layered preview panel: N tracks of the runtime's AnimationState (clip, alpha, loop, blend, speed, bone mask,
 * a clip crossfaded in after the first), with its own play / pause / scrub clock. While it is on, the stage shows
 * the combined result instead of the edited clip; the edited clip is never changed. The model is trackModel.ts.
 */
import type { AnimDocument, ClipData, Skeleton } from "@atlas-animator/core/core";
import { bakeMix, type BakeResult } from "./bakeModel.js";
import { defaultTrack, MASK_LABELS, MAX_PREVIEW_TRACKS, maskedBoneNames, maskFor, TrackSession, type MaskPreset, type TrackConfig } from "./trackModel.js";

export interface TracksHost {
  panel: HTMLElement;
  doc(): AnimDocument | null;
  /** Every editable clip by name, including the edited one as it is now. */
  clips(): Record<string, ClipData>;
  /** The clip being edited (the default for track 0). */
  editedClip(): string;
  /** The preview changed: pose and render again. */
  changed(): void;
  /** Frames per second the baked clip uses (the edited clip). */
  fps(): number;
  /** Adds a baked clip to the library under `name` and opens it; returns a problem text, or null when it was added. */
  adoptClip(name: string, clip: ClipData): string | null;
  /** Called just before the preview turns on, so the other stage preview (Transitions) can close. */
  beforeActivate?(): void;
}

export interface TracksPreview {
  active(): boolean;
  setActive(on: boolean): void;
  /** Advance the preview clock by `dt` real seconds while playing. */
  tick(dt: number): void;
  /** Poses `skeleton` with the combined result. */
  apply(skeleton: Skeleton): void;
  /** The clips or the rig changed. */
  invalidate(): void;
  play(on: boolean): void;
  seek(seconds: number): void;
  setTrack(index: number, patch: Partial<TrackConfig>): void;
  addTrack(config?: Partial<TrackConfig>): void;
  removeTrack(index: number): void;
  reset(): void;
  /** Bakes the combined result into a new clip named `name` (); throws with a readable message when it cannot. */
  bake(name: string, options?: { step?: number; slots?: boolean }): BakeResult;
  info(): {
    active: boolean;
    playing: boolean;
    time: number;
    span: number;
    repeat: boolean;
    tracks: (TrackConfig & { maskBoneNames: string[] | null })[];
  };
}

type Opt = [value: string, label: string];

export function createTracksPreview(host: TracksHost): TracksPreview {
  let on = false;
  let playing = false;
  let repeat = true;
  let time = 0;
  let tracks: TrackConfig[] = [];
  let session: TrackSession | null = null;
  let sessionDoc: AnimDocument | null = null;
  let stale = true;
  let seeded = false;

  const clipNames = (): string[] => Object.keys(host.clips());

  const ensureSession = (): TrackSession | null => {
    const doc = host.doc();
    if (!doc) return null;
    if (!session || sessionDoc !== doc) {
      session = new TrackSession(doc, host.clips(), tracks);
      sessionDoc = doc;
      stale = false;
    } else if (stale) {
      session.setClips(host.clips());
      session.setTracks(tracks);
      stale = false;
    }
    return session;
  };

  const seedTracks = (): void => {
    if (seeded) return;
    seeded = true;
    const names = clipNames();
    const first = names.includes(host.editedClip()) ? host.editedClip() : (names[0] ?? "");
    const other = names.find((n) => n !== first) ?? "";
    tracks = [defaultTrack(first), ...(other ? [{ ...defaultTrack(other), mask: "upper" as MaskPreset }] : [])];
  };

  const push = (): void => {
    if (session) session.setTracks(tracks);
    render();
    host.changed();
  };

  // --- DOM -----------------------------------------------------------------------------------

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const select = (opts: Opt[], value: string, title: string, onChange: (v: string) => void): HTMLSelectElement => {
    const s = node("select");
    s.title = title;
    for (const [v, label] of opts) {
      const o = node("option", "", label);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
  };
  const number = (value: number, title: string, step: string, min: string, max: string | null, onChange: (v: number) => void): HTMLInputElement => {
    const i = node("input");
    i.type = "number";
    i.title = title;
    i.step = step;
    i.min = min;
    if (max !== null) i.max = max;
    i.value = String(value);
    i.style.width = "62px";
    i.onchange = () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) onChange(v);
    };
    return i;
  };
  const labelled = (text: string, ...children: HTMLElement[]): HTMLElement => {
    const row = node("div", "row");
    row.append(node("span", "label", text), ...children);
    return row;
  };

  const readout = node("span", "readout");
  const scrub = node("input");
  scrub.type = "range";
  scrub.id = "trackscrub";
  scrub.title = "Scrub the combined result";
  scrub.min = "0";
  scrub.step = "0.0333333";
  scrub.style.flex = "1";
  scrub.style.minWidth = "80px";
  scrub.oninput = () => api.seek(Number(scrub.value));
  const playBtn = node("button", "", "Play");
  playBtn.id = "trackplay";
  playBtn.onclick = () => api.play(!playing);

  const cards = node("div");
  cards.id = "trackcards";

  function render(): void {
    const doc = host.doc();
    const sess = ensureSession();
    const span = sess?.span ?? 0;
    scrub.max = String(span);
    scrub.value = String(Math.min(time, span));
    readout.textContent = `${time.toFixed(2)} / ${span.toFixed(2)} s`;
    playBtn.textContent = playing ? "Pause" : "Play";
    playBtn.classList.toggle("on", playing);
    cards.replaceChildren();
    const clipOpts = (blank: string): Opt[] => [["", blank], ...clipNames().map((n): Opt => [n, n])];
    tracks.forEach((t, i) => {
      const card = node("div", "trackcard");
      card.style.cssText = "border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:8px;background:var(--panel2)";
      const head = node("div", "row");
      head.style.marginTop = "0";
      const title = node("span", "label", `Track ${i}`);
      const del = node("button", "", "Remove");
      del.title = "Remove this track";
      del.onclick = () => api.removeTrack(i);
      head.append(title, select(clipOpts("(empty)"), t.clip, "Clip on this track", (v) => api.setTrack(i, { clip: v })), del);
      head.children[1]!.setAttribute("style", "flex:1;min-width:0");
      const alpha = node("input");
      alpha.type = "range";
      alpha.min = "0";
      alpha.max = "1";
      alpha.step = "0.01";
      alpha.value = String(t.alpha);
      alpha.title = "Alpha: how much of this track is mixed over the tracks below it";
      alpha.style.flex = "1";
      alpha.oninput = () => api.setTrack(i, { alpha: Number(alpha.value) });
      const loop = node("button", t.loop ? "on" : "", "Loop");
      loop.onclick = () => api.setTrack(i, { loop: !t.loop });
      const blend = select(
        [
          ["replace", "Replace"],
          ["add", "Add"]
        ],
        t.blend,
        "Replace: blend toward this track's pose. Add: layer its motion on top of what is below",
        (v) => api.setTrack(i, { blend: v as TrackConfig["blend"] })
      );
      const mask = select(
        (Object.keys(MASK_LABELS) as MaskPreset[]).map((m): Opt => [m, MASK_LABELS[m]]),
        t.mask,
        "Which bones this track may animate",
        (v) => api.setTrack(i, { mask: v as MaskPreset })
      );
      const custom = node("input");
      custom.placeholder = "bones, comma separated";
      custom.value = t.maskBones.join(", ");
      custom.style.cssText = `width:130px;display:${t.mask === "custom" ? "" : "none"}`;
      custom.onchange = () => api.setTrack(i, { maskBones: custom.value.split(",").map((s) => s.trim()).filter(Boolean) });
      const m = doc ? maskFor(doc, t) : null;
      const count = node("span", "label", m && doc ? `${maskedBoneNames(doc, m).length} bones` : "all bones");
      card.append(
        head,
        labelled("Alpha", alpha, number(t.alpha, "Alpha 0..1", "0.05", "0", "1", (v) => api.setTrack(i, { alpha: v }))),
        labelled("Mode", loop, blend, number(t.timeScale, "Speed multiplier", "0.1", "0.1", "4", (v) => api.setTrack(i, { timeScale: v }))),
        labelled("Mask", mask, custom, count),
        labelled(
          "Then",
          select(clipOpts("(none)"), t.then, "A clip crossfaded in after this one", (v) => api.setTrack(i, { then: v })),
          number(t.crossfade, "Crossfade seconds", "0.05", "0", null, (v) => api.setTrack(i, { crossfade: v })),
          node("span", "label", "s fade")
        ),
        labelled(
          "At",
          number(t.thenAt ?? 0, "Seconds when the crossfade starts (0 = when the first clip ends)", "0.1", "0", null, (v) => api.setTrack(i, { thenAt: v > 0 ? v : null })),
          node("span", "label", "s (0 = at its end)")
        )
      );
      cards.append(card);
    });
    addBtn.disabled = tracks.length >= MAX_PREVIEW_TRACKS;
  }

  const addBtn = node("button", "", "Add track");
  addBtn.id = "trackadd";
  addBtn.onclick = () => api.addTrack();
  const resetBtn = node("button", "", "Reset");
  resetBtn.title = "Back to the start";
  resetBtn.onclick = () => api.seek(0);
  const repeatBtn = node("button", "on", "Repeat");
  repeatBtn.title = "Wrap at the end of the combined result";
  repeatBtn.onclick = () => {
    repeat = !repeat;
    repeatBtn.classList.toggle("on", repeat);
  };

  const h2 = node("h2");
  h2.append("Layered preview", node("span", "spacer"));
  h2.lastElementChild!.setAttribute("style", "flex:1");
  const toggle = node("button", "", "Off");
  toggle.id = "tracktoggle";
  toggle.title = "Show the combined tracks on the stage instead of the edited clip. The edited clip is not changed.";
  toggle.onclick = () => api.setActive(!on);
  h2.append(toggle);
  const transport = node("div", "row");
  transport.append(playBtn, resetBtn, repeatBtn, readout);
  const scrubRow = node("div", "row");
  scrubRow.append(scrub);
  const note = node("div", "note", "Preview only: the edited clip is never changed.");
  const body = node("div");
  body.style.display = "none";
  const addRow = node("div", "row");
  addRow.append(addBtn);
  // Bake (): the combined result becomes a normal, editable clip.
  const bakeName = node("input");
  bakeName.id = "bakename";
  bakeName.placeholder = "new_clip_name";
  bakeName.title = "Name of the new clip the combined result is baked into";
  bakeName.setAttribute("aria-label", "Name of the baked clip");
  bakeName.style.cssText = "flex:1;min-width:90px";
  const bakeStep = select(
    [
      ["1", "Every frame"],
      ["2", "Every 2nd frame"],
      ["3", "Every 3rd frame"],
      ["4", "Every 4th frame"]
    ],
    "1",
    "Sampling: how often the combined result is sampled into keys (fewer keys are easier to edit; straight runs are thinned out either way)",
    () => {}
  );
  bakeStep.id = "bakestep";
  bakeStep.setAttribute("aria-label", "Bake sampling");
  const bakeScope = select(
    [
      ["bones", "Bones only"],
      ["slots", "Bones and slots"]
    ],
    "bones",
    "Channels to bake: bone rotate / move / scale / shear, plus slot attachment swaps and colours",
    () => {}
  );
  bakeScope.id = "bakescope";
  bakeScope.setAttribute("aria-label", "Bake channels");
  const bakeBtn = node("button", "", "Bake to new clip");
  bakeBtn.id = "bakeclip";
  bakeBtn.title = "Sample the combined tracks into a new clip you can edit. The tracks and the edited clip are not changed";
  const bakeInfo = node("div", "note");
  bakeInfo.id = "bakeinfo";
  bakeBtn.onclick = () => {
    try {
      const r = api.bake(bakeName.value.trim(), { step: Number(bakeStep.value), slots: bakeScope.value === "slots" });
      bakeInfo.textContent = `Baked ${r.keys} keys on ${r.bones} bones over ${r.frames} frames into ${bakeName.value.trim()}.`;
    } catch (error) {
      bakeInfo.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  const bakeRow = node("div", "row");
  bakeRow.append(node("span", "label", "Bake"), bakeName, bakeStep, bakeScope, bakeBtn);
  body.append(transport, scrubRow, cards, addRow, bakeRow, bakeInfo, note);
  host.panel.append(h2, body);

  // --- API -----------------------------------------------------------------------------------

  const api: TracksPreview = {
    active: () => on,
    setActive(next) {
      if (next && !on) host.beforeActivate?.();
      on = next;
      if (on) seedTracks();
      if (!on) playing = false;
      toggle.textContent = on ? "On" : "Off";
      toggle.classList.toggle("on", on);
      body.style.display = on ? "" : "none";
      stale = true;
      render();
      host.changed();
    },
    tick(dt) {
      if (!on || !playing) return;
      const span = ensureSession()?.span ?? 0;
      time += dt;
      if (span > 0 && time > span) {
        if (repeat) time %= span;
        else {
          time = span;
          playing = false;
        }
      }
      readout.textContent = `${time.toFixed(2)} / ${span.toFixed(2)} s`;
      scrub.value = String(time);
      playBtn.textContent = playing ? "Pause" : "Play";
      playBtn.classList.toggle("on", playing);
    },
    apply(skeleton) {
      const sess = ensureSession();
      if (!sess) return;
      sess.seek(time);
      sess.apply(skeleton);
    },
    invalidate() {
      stale = true;
      if (on) {
        render();
        host.changed();
      }
    },
    play(next) {
      playing = next;
      if (next && !repeat && time >= (ensureSession()?.span ?? 0)) time = 0;
      render();
      host.changed();
    },
    seek(seconds) {
      time = Math.max(0, seconds);
      playing = false;
      render();
      host.changed();
    },
    setTrack(index, patch) {
      if (!tracks[index]) return;
      tracks = tracks.map((t, i) => (i === index ? { ...t, ...patch } : t));
      push();
    },
    addTrack(config = {}) {
      if (tracks.length >= MAX_PREVIEW_TRACKS) return;
      seeded = true;
      tracks = [...tracks, { ...defaultTrack(), ...config }];
      push();
    },
    removeTrack(index) {
      tracks = tracks.filter((_, i) => i !== index);
      push();
    },
    reset() {
      seeded = false;
      seedTracks();
      time = 0;
      playing = false;
      stale = true;
      render();
      host.changed();
    },
    bake(name, options = {}) {
      const doc = host.doc();
      if (!doc) throw new Error("Open a rig first");
      if (!name) throw new Error("Name the new clip first");
      const result = bakeMix(doc, host.clips(), tracks, { fps: host.fps(), step: options.step ?? 1, slots: options.slots ?? false });
      const problem = host.adoptClip(name, result.clip);
      if (problem) throw new Error(problem);
      return result;
    },
    info() {
      const doc = host.doc();
      const span = ensureSession()?.span ?? 0;
      return {
        active: on,
        playing,
        time,
        span,
        repeat,
        tracks: tracks.map((t) => {
          const m = doc ? maskFor(doc, t) : null;
          return { ...t, maskBoneNames: m && doc ? maskedBoneNames(doc, m) : null };
        })
      };
    }
  };
  return api;
}
