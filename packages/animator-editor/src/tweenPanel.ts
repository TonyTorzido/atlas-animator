/*
 * Atlas Animator editor: original implementation.
 *
 * The "Arc in-betweens" panel (tween.ts): pick the frame range and the effectors, the arc bias, the spacing preset and how many frames
 * to bake; the motion path (grey = the path as the clip stands, magenta = the planned arc, dots = frames that will be keyed, red rings =
 * frames that break an pose rule) is drawn on the canvas before anything is applied. Apply is one undo step through the editor's commit.
 * It only ever runs when the user presses Apply.
 */
import type { AnimDocument, ClipData } from "@atlas-animator/core/core";
import type { Graphics } from "pixi.js";
import { frameCount } from "./clipModel.js";
import { adjustArc, clearGenerated, exportMarks, generatedKeys, importMarks, generateTween, listEffectors, markGenerated, SPACING_IDS, SPACING_LABEL, type SpacingId, type TweenOptions, type TweenResult } from "./tween.js";
import { apiError, showToast } from "./persistUi.js";

export interface TweenPanelHost {
  box: HTMLElement;
  doc: () => AnimDocument | null;
  clipName: () => string;
  clip: () => ClipData;
  /** The play range in frames, or null. */
  playRange: () => { a: number; b: number } | null;
  /** Replaces the clip as one undo step. */
  commit: (next: ClipData, message: string) => void;
  status: (text: string, kind?: "" | "bad" | "ok") => void;
  /** Redraw the canvas overlay (the motion path). */
  redraw: () => void;
  /** True while the Paths overlay (motionPath.ts) is on: it already draws the path as the clip stands, so this panel draws only the planned arc. */
  pathsOn?: () => boolean;
}

export type TweenMode = "every" | "frames";

export interface TweenPanelState {
  a: number;
  b: number;
  effectors: string[];
  bias: number;
  spacing: SpacingId;
  mode: TweenMode;
  step: number;
  frames: number[];
  skip: number[];
  showPath: boolean;
}

export interface TweenPanel {
  render: () => void;
  state: () => TweenPanelState;
  set: (patch: Partial<TweenPanelState>) => void;
  /** The result of the current settings without applying them (null with no effector chosen). */
  preview: () => TweenResult | null;
  apply: () => TweenResult | null;
  /** Retries with other arc biases; sets the best one and returns it. */
  adjust: () => number | null;
  /** Leaves the frames that break a rule out. */
  skipFlagged: () => number[];
  clearGenerated: () => number;
  drawOverlay: (g: Graphics, px: number) => void;
}

const MAGENTA = 0xff5ec8;
const RED = 0xff5a5a;

export function createTweenPanel(host: TweenPanelHost): TweenPanel {
  const s: TweenPanelState = { a: 0, b: 12, effectors: [], bias: 0.25, spacing: "attack", mode: "every", step: 1, frames: [], skip: [], showPath: true };
  let rangeTouched = false;
  /** The arc follows the clip's own natural bulge until the user sets it by hand. */
  let autoBias = true;
  let cache: { clip: ClipData; doc: AnimDocument; key: string; result: TweenResult } | null = null;
  let built = false;
  let effBox: HTMLElement;
  let effSig = "";
  let readout: HTMLElement;
  let problems: HTMLElement;
  let buttons: Record<"apply" | "adjust" | "skip" | "reset" | "clear", HTMLButtonElement>;
  const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  const options = (): TweenOptions => ({
    a: s.a,
    b: s.b,
    effectors: s.effectors,
    bias: s.bias,
    spacing: s.spacing,
    ...(s.mode === "frames" ? { frames: s.frames } : { step: s.step }),
    skip: s.skip
  });

  function preview(): TweenResult | null {
    const doc = host.doc();
    const clip = host.clip();
    if (!doc || !s.effectors.length) return null;
    const key = JSON.stringify([host.clipName(), options()]);
    if (cache && cache.clip === clip && cache.doc === doc && cache.key === key) return cache.result;
    let result: TweenResult;
    try {
      result = generateTween(doc, host.clipName(), clip, options());
    } catch (error) {
      result = { clip, keyed: {}, keys: 0, plans: [], maxError: 0, violations: [], flagged: [], notes: [`Could not build the in-betweens: ${error instanceof Error ? error.message : String(error)}`] };
    }
    cache = { clip, doc, key, result };
    if (autoBias && result.plans.length) {
      const nat = Math.min(1, Math.round(Math.max(...result.plans.map((p) => p.natural)) * 100) / 100);
      if (Math.abs(nat - s.bias) > 0.004) {
        s.bias = nat;
        return preview();
      }
    }
    return result;
  }

  /** Remembers which keys are generated next to the clips, so the markers survive a reload. Failure only costs the markers. */
  function saveMarks(): void {
    void fetch("/api/tween-marks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exportMarks()) })
      .then(async (r) => {
        if (!r.ok) showToast(`In-between markers not saved: ${await apiError(r)}`, "bad");
      })
      .catch(() => showToast("In-between markers not saved: the editor server is not answering", "bad"));
  }
  let marksLoaded = false;
  function loadMarks(): void {
    if (marksLoaded) return;
    marksLoaded = true;
    void fetch("/api/tween-marks")
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        importMarks(m);
        host.redraw();
        render();
      })
      .catch(() => undefined);
  }

  function apply(): TweenResult | null {
    const r = preview();
    if (!r || !r.keys) {
      host.status(r?.notes[0] ?? (s.effectors.length ? "Nothing to generate in this range" : "Tick an effector first"), "bad");
      return r;
    }
    markGenerated(host.clipName(), r.clip, r);
    saveMarks();
    const frames = new Set(r.plans.flatMap((p) => p.generated)).size;
    host.commit(r.clip, `Arc in-betweens: ${r.keys} keys on ${frames} frame${frames === 1 ? "" : "s"} (${r.plans.map((p) => p.label).join(", ")})${r.flagged.length ? `; ${r.flagged.length} frame${r.flagged.length === 1 ? "" : "s"} flagged` : ""}`);
    host.redraw();
    return r;
  }

  function adjust(): number | null {
    const doc = host.doc();
    if (!doc || !s.effectors.length) return null;
    const found = adjustArc(doc, host.clipName(), host.clip(), options(), preview() ?? undefined);
    if (!found) {
      host.status("Adjust arc: no other arc bias is cleaner than this one", "bad");
      return null;
    }
    autoBias = false;
    s.bias = found.bias;
    host.status(`Arc bias ${found.bias}: ${found.result.violations.length ? `${found.result.flagged.length} frames still flagged` : "no rule breaks"}`, found.result.violations.length ? "" : "ok");
    render();
    host.redraw();
    return found.bias;
  }

  function skipFlagged(): number[] {
    const r = preview();
    if (!r) return [];
    s.skip = [...new Set([...s.skip, ...r.flagged])];
    host.status(`Skipping ${s.skip.length} flagged frame${s.skip.length === 1 ? "" : "s"}`);
    render();
    host.redraw();
    return s.skip;
  }

  function clear(): number {
    const name = host.clipName();
    const r = clearGenerated(name, host.clip());
    if (!r.removed) {
      host.status("No generated keys to clear", "bad");
      return 0;
    }
    saveMarks();
    host.commit(r.clip, `Cleared ${r.removed} generated keys`);
    return r.removed;
  }

  function set(patch: Partial<TweenPanelState>): void {
    if (patch.a !== undefined || patch.b !== undefined) rangeTouched = true;
    if (patch.bias !== undefined) autoBias = false;
    const changed = (Object.keys(patch) as (keyof TweenPanelState)[]).some((k) => k !== "showPath" && JSON.stringify(patch[k]) !== JSON.stringify(s[k]));
    Object.assign(s, patch);
    if (changed && !("skip" in patch)) {
      // A new range or effector set invalidates the frames chosen to skip.
      if ("a" in patch || "b" in patch || "effectors" in patch) s.skip = [];
    }
    render();
    host.redraw();
  }

  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...kids);
    return node;
  };
  const label = (text: string, title?: string) => mk("span", { className: "label", textContent: text, ...(title ? { title } : {}) });

  function build(): void {
    built = true;
    const { box } = host;
    box.replaceChildren();
    box.append(mk("h2", { textContent: "Arc in-betweens" }));
    box.append(mk("div", { className: "note", textContent: "Fills the frames between your keys so a hand, foot or the weapon tip follows a clean arc. Runs only when you press Apply, as one undo step." }));
    const num = (id: string, title: string, key: "a" | "b" | "step", min: number) => {
      const input = mk("input", { type: "number", id: `tween-${id}`, title, min: String(min), step: "1" });
      input.className = "in num";
      input.addEventListener("change", () => set({ [key]: Math.max(min, Math.round(Number(input.value) || 0)) } as Partial<TweenPanelState>));
      inputs[id] = input;
      return input;
    };
    const range = mk("div", { className: "row" }, label("Frames"), num("a", "First frame of the range (a key or not)", "a", 0), label("to"), num("b", "Last frame of the range", "b", 1));
    const useRange = mk("button", { textContent: "Play range", title: "Use the play range (set it with the range controls under the timeline)" });
    useRange.addEventListener("click", () => {
      const r = host.playRange();
      if (r) {
        rangeTouched = false;
        set({ a: r.a, b: r.b });
        rangeTouched = true;
      } else host.status("No play range is set", "bad");
    });
    range.append(useRange);
    box.append(range);
    effBox = mk("div", { id: "tween-effectors" });
    box.append(effBox);

    const bias = mk("input", { type: "range", id: "tween-bias", min: "-1", max: "1", step: "0.05", title: "How far each span bows sideways, away from the shoulder or hip (0 = the plain spline)" });
    const biasNum = mk("input", { type: "number", id: "tween-bias-n", min: "-2", max: "2", step: "0.05" });
    biasNum.className = "in num";
    bias.addEventListener("input", () => set({ bias: Number(bias.value) }));
    biasNum.addEventListener("change", () => set({ bias: Math.max(-2, Math.min(2, Number(biasNum.value) || 0)) }));
    inputs["bias"] = bias;
    inputs["bias-n"] = biasNum;
    const natural = mk("button", { textContent: "Natural", id: "tween-natural", title: "Use the bow the clip's own path already has, so the arc keeps its shape (this is the default until you move the slider)" });
    natural.addEventListener("click", () => {
      autoBias = true;
      cache = null;
      render();
      host.redraw();
    });
    box.append(mk("div", { className: "row" }, label("Arc"), bias, biasNum, natural));

    const spacing = mk("select", { id: "tween-spacing", title: "How the effector's speed is spread over each key-to-key span" });
    for (const id of SPACING_IDS) spacing.append(mk("option", { value: id, textContent: SPACING_LABEL[id] }));
    spacing.addEventListener("change", () => set({ spacing: spacing.value as SpacingId }));
    inputs["spacing"] = spacing;
    box.append(mk("div", { className: "row" }, label("Spacing"), spacing));

    const mode = mk("select", { id: "tween-mode", title: "Key every Nth frame, or only the frames you list (breakdowns)" });
    mode.append(mk("option", { value: "every", textContent: "Key every N frames" }), mk("option", { value: "frames", textContent: "Only at frames" }));
    mode.addEventListener("change", () => set({ mode: mode.value as TweenMode }));
    inputs["mode"] = mode;
    const step = num("step", "Key every Nth in-between frame (1 = every frame)", "step", 1);
    const list = mk("input", { type: "text", id: "tween-frames", placeholder: "e.g. 4, 8", title: "Frames to key (inside the range)" });
    list.style.width = "90px";
    list.addEventListener("change", () => set({ frames: list.value.split(/[ ,;]+/).map(Number).filter((n) => Number.isFinite(n) && list.value.trim() !== "").map(Math.round) }));
    inputs["frames"] = list;
    box.append(mk("div", { className: "row" }, label("Bake"), mode, step, list));

    const show = mk("input", { type: "checkbox", id: "tween-show" });
    show.checked = s.showPath;
    show.addEventListener("change", () => set({ showPath: show.checked }));
    inputs["show"] = show;
    box.append(mk("div", { className: "row" }, mk("label", { className: "label", title: "Draw the motion path on the canvas: grey = the clip now, magenta = the planned arc" }, show, " Show motion path")));

    readout = mk("div", { className: "note", id: "tween-readout" });
    problems = mk("div", { className: "note", id: "tween-problems" });
    const button = (text: string, id: string, title: string, fn: () => void) => {
      const b = mk("button", { textContent: text, id, title });
      b.addEventListener("click", fn);
      return b;
    };
    buttons = {
      apply: button("Apply in-betweens", "tween-apply", "Bake the keys (one undo step). Generated keys show in magenta on the timeline.", () => void apply()),
      adjust: button("Adjust arc", "tween-adjust", "Try other arc biases and keep the one with the fewest rule breaks", () => void adjust()),
      skip: button("Skip flagged frames", "tween-skip", "Leave the flagged frames out (they stay as the clip interpolates them)", () => void skipFlagged()),
      reset: button("Reset skips", "tween-reset", "Include every frame again", () => set({ skip: [] })),
      clear: button("Clear generated keys", "tween-clear", "Remove only the keys this tool made and you have not changed since (one undo step)", () => void clear())
    };
    buttons.apply.classList.add("btn-primary");
    box.append(readout, problems, mk("div", { className: "row" }, buttons.apply, buttons.adjust, buttons.skip, buttons.reset, buttons.clear));
  }

  function renderEffectors(): void {
    const doc = host.doc();
    const list = doc ? listEffectors(doc, host.clip()) : [];
    const sig = JSON.stringify(list.map((e) => [e.id, e.unavailable ?? ""]));
    if (sig === effSig) {
      for (const input of effBox.querySelectorAll<HTMLInputElement>("input[data-eff]")) input.checked = s.effectors.includes(input.dataset.eff!);
      return;
    }
    effSig = sig;
    effBox.replaceChildren();
    s.effectors = s.effectors.filter((id) => list.some((e) => e.id === id && !e.unavailable));
    for (const e of list) {
      const box = mk("input", { type: "checkbox", id: `tween-eff-${e.id}`, disabled: !!e.unavailable, checked: s.effectors.includes(e.id), title: e.unavailable ?? e.label });
      box.dataset.eff = e.id;
      box.addEventListener("change", () => set({ effectors: box.checked ? [...new Set([...s.effectors, e.id])] : s.effectors.filter((x) => x !== e.id) }));
      effBox.append(mk("div", { className: "row", style: "margin-top:2px" } as never, mk("label", { className: "label", title: e.unavailable ?? "" }, box, ` ${e.label}${e.unavailable ? " (off: IK)" : ""}`)));
    }
    if (!list.length) effBox.append(mk("div", { className: "note", textContent: "This rig has no arm or leg chains." }));
  }

  function render(): void {
    if (!built) {
      build();
      loadMarks();
    }
    const clip = host.clip();
    if (!rangeTouched) {
      const r = host.playRange();
      s.a = r ? r.a : 0;
      s.b = r ? r.b : frameCount(clip);
    }
    renderEffectors();
    const put = (id: string, value: string) => {
      const input = inputs[id]!;
      if (document.activeElement !== input) (input as HTMLInputElement).value = value;
    };
    put("a", String(s.a));
    put("b", String(s.b));
    put("bias", String(s.bias));
    put("bias-n", String(s.bias));
    put("spacing", s.spacing);
    put("mode", s.mode);
    put("step", String(s.step));
    put("frames", s.frames.join(", "));
    (inputs["step"] as HTMLInputElement).style.display = s.mode === "every" ? "" : "none";
    (inputs["frames"] as HTMLInputElement).style.display = s.mode === "frames" ? "" : "none";
    (inputs["show"] as HTMLInputElement).checked = s.showPath;
    const r = preview();
    const gen = generatedKeys(host.clipName(), clip).length;
    buttons.clear.disabled = gen === 0;
    buttons.clear.style.display = gen === 0 ? "none" : "";
    buttons.clear.textContent = gen ? `Clear generated keys (${gen})` : "Clear generated keys";
    buttons.reset.style.display = s.skip.length ? "" : "none";
    problems.replaceChildren();
    if (!r) {
      readout.textContent = s.effectors.length ? "" : "Tick the weapon tip, a fist or a foot to preview its arc.";
      buttons.apply.disabled = true;
      buttons.adjust.disabled = true;
      buttons.skip.disabled = true;
      buttons.adjust.style.display = "none";
      buttons.skip.style.display = "none";
      return;
    }
    const frames = new Set(r.plans.flatMap((p) => p.generated)).size;
    readout.textContent = r.keys
      ? `${r.keys} keys on ${frames} frame${frames === 1 ? "" : "s"}; the effector lands within ${r.maxError.toFixed(2)} px of the arc.${s.skip.length ? ` ${s.skip.length} skipped.` : ""}`
      : (r.notes[0] ?? "Nothing to generate in this range.");
    for (const n of r.notes.slice(r.keys ? 0 : 1)) problems.append(mk("div", { textContent: n }));
    const shown = r.violations.slice(0, 6);
    for (const v of shown) problems.append(mk("div", { style: "color:#ff8a8a", textContent: `Frame ${v.frame}: ${v.rule === "unreachable" ? "out of reach" : v.rule} - ${v.message}` } as never));
    if (r.violations.length > shown.length) problems.append(mk("div", { textContent: `...and ${r.violations.length - shown.length} more` }));
    buttons.apply.disabled = r.keys === 0;
    buttons.adjust.disabled = r.violations.length === 0;
    buttons.skip.disabled = r.flagged.length === 0;
    buttons.adjust.style.display = buttons.adjust.disabled ? "none" : "";
    buttons.skip.style.display = buttons.skip.disabled ? "none" : "";
  }

  function drawOverlay(g: Graphics, px: number): void {
    if (!s.showPath || !s.effectors.length) return;
    const r = preview();
    if (!r) return;
    for (const plan of r.plans) {
      const o = plan.original;
      if (o.length > 1 && !host.pathsOn?.()) {
        g.moveTo(o[0]!.x, o[0]!.y);
        for (let i = 1; i < o.length; i++) g.lineTo(o[i]!.x, o[i]!.y);
        g.stroke({ width: 1.5 * px, color: 0xb8c0cf, alpha: 0.55 });
      }
      const c = plan.curve;
      if (c.length > 1) {
        g.moveTo(c[0]![0], c[0]![1]);
        for (let i = 1; i < c.length; i++) g.lineTo(c[i]![0], c[i]![1]);
        g.stroke({ width: 2.5 * px, color: MAGENTA, alpha: 0.9 });
      }
      for (const f of plan.generated) {
        const p = plan.planned[f - plan.planned[0]!.frame];
        if (p) g.circle(p.x, p.y, 4 * px).fill({ color: MAGENTA }).stroke({ width: px, color: 0x14171d, alpha: 0.8 });
      }
      for (const f of plan.waypoints) {
        const p = plan.planned[f - plan.planned[0]!.frame];
        if (p) g.circle(p.x, p.y, 6 * px).stroke({ width: 2 * px, color: 0xffffff });
      }
      for (const f of r.flagged) {
        const p = plan.planned[f - plan.planned[0]!.frame];
        if (p && plan.generated.includes(f)) g.circle(p.x, p.y, 10 * px).stroke({ width: 2.5 * px, color: RED });
      }
    }
  }

  return {
    render,
    state: () => ({ ...s, effectors: [...s.effectors], frames: [...s.frames], skip: [...s.skip] }),
    set,
    preview,
    apply,
    adjust,
    skipFlagged,
    clearGenerated: clear,
    drawOverlay
  };
}
