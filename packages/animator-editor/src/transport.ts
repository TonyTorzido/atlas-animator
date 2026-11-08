/*
 * Atlas Animator editor: the transport (Batch 5; was the Animate bar). One toolbar row in the footer: play and step
 * buttons, the frame readout (the only one), Loop / Return, length / frames / fps, Auto key, a "Key" split button (click = key the
 * selected bones, the menu holds every other key action), a Mirror menu, Undo / Redo, Save and Mark done. The Key and Mirror menus
 * keep the ids of the buttons they took over, so main.ts handlers and hotkeys do not change. The dock bar under it holds Graph, Snap
 * to frames and the timeline zoom. With no clip open the whole toolbar is disabled and the Clip board card shows.
 * Entering Animate also sets the defaults: Auto key on, helpers off. Mark done writes clips/board.json through /api/board.
 */
import { keyPoseTip } from "./feedbackModel.js";
import { clipGates } from "./gates.js";
import { OUTFITS } from "./fixtures.js";
import { timeToFrame } from "./clipModel.js";
import { parseBoard, withDone } from "./clipBoard.js";
import { contactFrames, gameClipFor } from "./animateBarModel.js";
import { addTimelineDecorator, getHost, whenHost } from "./host.js";
import type { Workspaces } from "./workspace.js";

/** Ids of the controls this module owns or builds (each has an entry in tooltips.ts). */
export const TRANSPORT_IDS = ["key-menu-btn", "mirror-menu-btn", "ab-key", "ab-prevkey", "ab-nextkey", "ab-breakdown", "ab-done", "mm-mirror", "mm-flip", "mm-arm-nf", "mm-arm-fn", "mm-leg-nf", "mm-leg-fn", "scale-open", "save-export"] as const;

const SVG = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string> = {
  key: "M12 3l7 9-7 9-7-9z",
  play: "M8 5l11 7-11 7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  first: "M6 5v14M18 5l-9 7 9 7z",
  last: "M18 5v14M6 5l9 7-9 7z",
  prev: "M15 5l-8 7 8 7",
  next: "M9 5l8 7-8 7",
  prevkey: "M12 6l-6 6 6 6zM18 6l-6 6 6 6z",
  nextkey: "M12 6l6 6-6 6zM6 6l6 6-6 6z",
  mirror: "M12 3v18M9 7L3 12l6 5zM15 7l6 5-6 5z",
  chevD: "M6 9l6 6 6-6",
  undo: "M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 8",
  redo: "M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 8",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  done: "M5 12.5l4.5 4.5L19 7.5"
};
const FILLED = new Set(["play", "pause", "key"]);

function icon(name: string): SVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "tb-ico");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", ICONS[name]!);
  if (FILLED.has(name)) p.setAttribute("fill", "currentColor");
  else {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2.2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  }
  s.append(p);
  return s;
}

const $ = (id: string) => document.getElementById(id)!;

/** Opens a menu upward from its button (the footer is at the bottom of the window); Escape and an outside click close it. */
function menu(btn: HTMLElement, pop: HTMLElement, others: () => void): { close: () => void } {
  const close = (): void => {
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("on");
  };
  const open = (): void => {
    others();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("on");
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.bottom = `${innerHeight - r.top + 4}px`;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop.hidden) open();
    else close();
  });
  pop.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b && !b.disabled && !b.hasAttribute("data-keep") && !b.closest("#scalerow") && !b.closest("#bdrow")) close();
    else if (b?.id === "applyscale" && !b.disabled) close();
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      close();
      btn.focus();
    }
  });
  window.addEventListener("resize", close);
  return { close };
}

/** Play / Pause: the button's label and glyph follow the playing state (main.ts setPlaying and the slow check below call it). */
export function paintPlay(on: boolean): void {
  const b = document.getElementById("play");
  if (!b) return;
  b.classList.toggle("on", on);
  const label = b.querySelector(".tb-label");
  if (label) label.textContent = on ? "Pause" : "Play";
  b.querySelector("path")?.setAttribute("d", ICONS[on ? "pause" : "play"]!);
}

/** With no clip open the transport, the Key and Mirror menus and Undo / Redo are disabled (the Clip board card shows instead). */
export function setTransportEnabled(on: boolean): void {
  const set = document.getElementById("tb-set") as HTMLFieldSetElement | null;
  if (set) set.disabled = !on;
  document.body.classList.toggle("noclip", !on);
}

/** Wires the transport toolbar in the footer and the Animate defaults. */
export function installTransport(ws: Workspaces): void {
  // Icons: every button marked data-ico gets its glyph in front of any label.
  for (const el of document.querySelectorAll<HTMLElement>("#transport [data-ico]")) el.prepend(icon(el.dataset.ico!));
  const play = $("play");
  const key = $("setkey");
  const done = $("ab-done") as HTMLButtonElement;
  const keyPose = $("ab-key");
  const keyBtn = $("key-menu-btn");
  const mirrorBtn = $("mirror-menu-btn");
  const keyMenu = menu(keyBtn, $("key-menu"), () => mirrorMenu.close());
  const mirrorMenu = menu(mirrorBtn, $("mirror-menu"), () => keyMenu.close());
  // The Export tab keeps a Save button too (the same action as the transport's).
  $("save-export").addEventListener("click", () => $("save").click());
  // "Scale timing..." opens its input row inside the menu.
  const scaleOpen = $("scale-open");
  const scaleRow = $("scalerow");
  scaleOpen.addEventListener("click", () => {
    scaleRow.hidden = !scaleRow.hidden;
    scaleOpen.setAttribute("aria-expanded", String(!scaleRow.hidden));
    if (!scaleRow.hidden) $("scalepct").focus();
  });
  const bdOpen = $("bd-open");
  const bdRow = $("bdrow");
  bdOpen.addEventListener("click", () => {
    bdRow.hidden = !bdRow.hidden;
    bdOpen.setAttribute("aria-expanded", String(!bdRow.hidden));
  });
  $("key-menu-btn").addEventListener("click", () => {
    scaleRow.hidden = true;
    scaleOpen.setAttribute("aria-expanded", "false");
  });
  // The Mirror menu items run the same handlers as the Pose tab's buttons (main.ts wires those ids).
  for (const [id, target] of [["mm-mirror", "mirrorsel"], ["mm-arm-nf", "mirror-arm-nf"], ["mm-arm-fn", "mirror-arm-fn"], ["mm-leg-nf", "mirror-leg-nf"], ["mm-leg-fn", "mirror-leg-fn"]] as const) {
    $(id).addEventListener("click", () => $(target).click());
  }
  $("mm-flip").addEventListener("click", () => {
    const h = getHost();
    if (!h) return;
    h.flipPose();
    // Show the result on the right-facing side in the phone dock (the runtime flips the left view for the right side).
    const dockMirror = document.getElementById("dock-mirror");
    if (dockMirror && !dockMirror.classList.contains("on")) dockMirror.click();
  });

  // ---- State shown ----
  let keyBase: string | null = null;
  let doneNow = false;
  let doneFor = "";
  let busy = false;
  // Bumped by every Mark done toggle: a board read that started before a toggle (the clip event Save fires) must not overwrite its result.
  let rev = 0;

  const active = () => document.body.classList.contains("ws-animate");
  void play;
  void mirrorBtn;

  // The contact frame: a red line through the dopesheet with a "hit" tag in the ruler (the old scrubber carried a 9.5 px flag).
  addTimelineDecorator((g, frameX, width, height, rulerH) => {
    if (!active()) return;
    const h = getHost();
    if (!h) return;
    g.save();
    g.font = "600 11px Segoe UI, system-ui, sans-serif";
    g.textAlign = "left";
    for (const f of contactFrames(h.clip)) {
      const x = Math.round(frameX(f)) + 0.5;
      if (x < 190 || x > width) continue;
      g.fillStyle = "#ff6b6b";
      g.fillRect(x - 0.5, rulerH, 1, height - rulerH);
      const w = g.measureText("hit").width + 8;
      g.fillStyle = "#2b1719";
      g.fillRect(x, 2, w, 15);
      g.fillStyle = "#ff6b6b";
      g.fillRect(x - 0.5, 2, 2, 15);
      g.fillText("hit", x + 5, 14);
    }
    g.restore();
  });

  function refresh(): void {
    const h = getHost();
    if (!h || !active()) return;
    const playing = h.playing;
    paintPlay(playing);
    const un = h.unkeyed.length;
    key.classList.toggle("has-unkeyed", un > 0);
    key.dataset.unkeyed = un > 0 ? String(un) : "";
    if (keyBase === null) keyBase = keyPose.title;
    keyPose.title = keyPoseTip(keyBase, un);
    const entry = gameClipFor(h.clipName);
    const isDone = doneNow && doneFor === h.clipName;
    done.disabled = !entry || busy;
    done.classList.toggle("is-done", isDone);
    done.querySelector(".tb-label")!.textContent = isDone ? "Done" : "Mark done";
    done.title = entry ? (isDone ? `${entry.label} is marked done. Click to take it off the done list.` : `Save ${entry.label} and mark it done on the clip board.`) : "This clip is not on the project clip board, so it cannot be marked done.";
  }

  async function loadDone(): Promise<void> {
    const h = getHost();
    const entry = h ? gameClipFor(h.clipName) : null;
    if (!h || !entry) {
      doneNow = false;
      doneFor = "";
      return refresh();
    }
    const mine = rev;
    try {
      const r = await fetch("/api/board");
      if (r.ok) {
        const done = parseBoard(await r.json())[entry.id]?.done === true;
        if (mine !== rev || busy) return;
        doneNow = done;
        doneFor = h.clipName;
      }
    } catch {
      if (mine === rev && !busy) doneNow = false;
    }
    refresh();
  }

  async function toggleDone(): Promise<void> {
    const h = getHost();
    const entry = h ? gameClipFor(h.clipName) : null;
    if (!h || !entry || busy) return;
    busy = true;
    rev++;
    refresh();
    try {
      let board = {};
      try {
        const r = await fetch("/api/board");
        if (r.ok) board = parseBoard(await r.json());
      } catch {
        // no board file yet
      }
      const was = (board as Record<string, { done: boolean }>)[entry.id]?.done === true;
      // Mark done only records a clip whose save completed ().
      if (!was && !(await h.saveClip())) return h.status("Not marked done: the clip did not save (see the message above)", "bad");
      let hash = "";
      const file = OUTFITS.find((o) => o.id === entry.rig)?.document;
      if (file) {
        try {
          const r = await fetch(`/api/rig/hash?file=${encodeURIComponent(file)}`);
          if (r.ok) hash = ((await r.json()) as { hash: string }).hash;
        } catch {
          // hash unknown: the board will not report "needs re-check"
        }
      }
      const next = withDone(board, entry.id, !was, hash, new Date().toISOString());
      const r = await fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (!r.ok) return h.status("Could not save the board file", "bad");
      doneNow = !was;
      doneFor = h.clipName;
      let note = "";
      if (!was && h.doc) {
        try {
          const errs = clipGates(h.doc, h.clipName, h.clip).filter((i) => i.severity === "error").length;
          if (errs) note = `, but ${errs} rule check${errs === 1 ? " fails" : "s fail"}: it will show as needing a look`;
        } catch {
          // a clip mid-edit can fail the check
        }
      }
      h.status(`${entry.label}: ${was ? "marked not done" : `marked done${note}`}`, note ? "" : "ok");
    } finally {
      busy = false;
      rev++;
      refresh();
    }
  }

  // ---- Buttons ----
  keyPose.addEventListener("click", () => {
    const h = getHost();
    if (!h) return;
    const n = h.keyPose();
    if (n) h.status(`Keyed ${n} bone${n === 1 ? "" : "s"} at frame ${timeToFrame(h.clip, h.time)}`, "ok");
    else h.status("Pick a bone first, or open a clip", "bad");
  });
  $("ab-prevkey").addEventListener("click", () => getHost()?.jumpToKey(-1));
  $("ab-nextkey").addEventListener("click", () => getHost()?.jumpToKey(1));
  $("ab-breakdown").addEventListener("click", () => getHost()?.breakdown());
  done.addEventListener("click", () => void toggleDone());

  // ---- Defaults and live updates ----
  function enter(): void {
    const auto = document.getElementById("autokey");
    if (auto && !auto.classList.contains("on")) auto.click();
    const helpers = document.getElementById("helpersvis");
    if (helpers?.classList.contains("on")) helpers.click();
    void loadDone();
    refresh();
  }
  ws.onChange((id) => {
    if (id === "animate") enter();
  });
  if (ws.current() === "animate") enter();
  whenHost((h) => {
    h.on("clip", () => {
      void loadDone();
    });
    for (const ev of ["time", "pose", "save", "rig"] as const) h.on(ev, refresh);
  });
  // Play / pause can change without an event the bar sees (Space on the canvas): a slow check keeps the label true.
  window.setInterval(refresh, 300);
}
