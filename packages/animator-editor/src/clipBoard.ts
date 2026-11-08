/*
 * Atlas Animator editor: the Clip board (the design notes, section 2).
 *
 * One screen that lists every clip the project wants for the player. A matrix (rows: generic + the six classes, columns: the six
 * weapons, three combo-step dots per cell), lists for Move, Gather, Guard and Other, a progress bar and filters. One click on a clip
 * mounts the right rig, faces left, wears the weapon art if the rig has it, opens the clip (or makes it from its template) and
 * goes to the Animate workspace. Status comes from gameClips.boardSummary: the saved clips/board.json (GET / POST /api/board) plus
 * the gate results of the clips opened this session. The pure helpers up top are tested; the DOM part talks to the editor only
 * through the host (host.ts).
 */
import { bindDialog } from "./dialog.js";
import { deletedClipsDialog } from "./persistUi.js";
import "./clipBoard.css";
import { clipGates } from "./gates.js";
import {
  boardSummary, clipStatus, CLASS_LABELS, CLASS_WEAPON, CLASSES, GAME_CLIPS, LEGACY_CLIP_ALIASES, matrixCell, WEAPON_LABELS, WEAPONS,
  type BoardState, type ClipGroup, type ClipStatus, type GameClip, type Klass, type RigId, type Weapon
} from "./gameClips.js";
import { templateFor } from "./clipTemplates.js";
import {
  addSlotsToSummary, attackSlotId, attackSlotLabel, clipLengthFps, clipNameError, customClipEntry, customClipNames, freeName, lengthFpsError, nextStep,
  parseBoardConfig, retimeClip, SLOT_CATEGORIES, SLOT_CATEGORY_LABELS, slotToGameClip, slugify, type BoardConfig, type CustomSlot, type SlotCategory
} from "./boardConfig.js";
import type { ClipData } from "@atlas-animator/core/core";
import { OUTFITS } from "./fixtures.js";
import { getHost, whenHost, type EditorHost } from "./host.js";
import { setClipBoardOpener } from "./home.js";
import { shownIn, type Workspaces } from "./workspace.js";

// ---- Pure helpers ---------------------------------------------------------------------------------------------------

export type Filter = "all" | "missing" | "draft" | "problems";

export const STATUS_LABEL: Readonly<Record<ClipStatus, string>> = {
  missing: "Missing",
  draft: "Draft",
  done: "Done",
  "needs-recheck": "Needs re-check",
  broken: "Broken"
};

export const STATUS_HELP: Readonly<Record<ClipStatus, string>> = {
  missing: "not made yet",
  draft: "made, not marked done",
  done: "marked done and passing the checks",
  "needs-recheck": "the rig changed since you marked it done",
  broken: "marked done but now failing a check"
};

export function passesFilter(status: ClipStatus, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "problems") return status === "needs-recheck" || status === "broken";
  return status === filter;
}

/** Rows of the matrix: the generic row first, then the six classes. */
export function matrixRows(): { klass: Klass | null; label: string }[] {
  return [{ klass: null, label: "Generic" }, ...CLASSES.map((k) => ({ klass: k as Klass | null, label: CLASS_LABELS[k] }))];
}

/** A class row only has a cell under its own weapon; the generic row has all six. */
export function cellUsed(klass: Klass | null, weapon: Weapon): boolean {
  return klass === null || CLASS_WEAPON[klass] === weapon;
}

/** The existing legacy clip a catalogue clip is played from ("idle" -> "idle_weight_shift"), or null. */
export function legacyAliasIn(id: string, have: ReadonlySet<string>): string | null {
  if (have.has(id)) return null;
  return LEGACY_CLIP_ALIASES[id]?.find((a) => have.has(a)) ?? null;
}

/** Attachment name each weapon has in the pro rig's weapon slot (only the axe is drawn so far). */
export const RIG_WEAPON_ATTACHMENT: Readonly<Partial<Record<Weapon, string>>> = { axe: "double_axe" };

type SkinsLike = Record<string, { attachments?: Record<string, Record<string, unknown>> }>;

/** Whether the mounted rig has drawn art for the weapon (otherwise the editor shows a stand-in). */
export function rigHasWeapon(skins: unknown, weapon: Weapon | null): boolean {
  if (!weapon) return true;
  const name = RIG_WEAPON_ATTACHMENT[weapon];
  if (!name) return false;
  return Object.values((skins ?? {}) as SkinsLike).some((s) => !!s.attachments?.weapon?.[name]);
}

/** Skins (by name) that are the weapon's own, to wear on top of the base skin. */
export function weaponSkins(skinNames: readonly string[], weapon: Weapon | null): string[] {
  if (!weapon) return [];
  return skinNames.filter((n) => n === weapon || n === `weapon/${weapon}` || n === `weapon_${weapon}`);
}

export function parseBoard(v: unknown): BoardState {
  const out: BoardState = {};
  if (!v || typeof v !== "object") return out;
  for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
    const x = e as { done?: unknown; rigHash?: unknown; updated?: unknown } | null;
    if (x && typeof x.done === "boolean" && typeof x.rigHash === "string") out[id] = { done: x.done, rigHash: x.rigHash, updated: typeof x.updated === "string" ? x.updated : "" };
  }
  return out;
}

export function withDone(board: BoardState, id: string, done: boolean, rigHash: string, now: string): BoardState {
  return { ...board, [id]: { done, rigHash, updated: now } };
}

/** Plain-words timing line for a tooltip. */
export function timingNote(c: GameClip): string {
  if (c.timing.source === "default") return "Timing not in project yet: the length is a placeholder.";
  if (c.timing.source === "profile") return `Length and hit come from the project's ${c.timing.styleId} attack.`;
  if (c.timing.source === "gather") return "Length and hit come from the project's gather timing.";
  return "Authored freely: no game timing drives it.";
}

export function clipTip(c: GameClip, s: ClipStatus, alias: string | null): string {
  const lines = [`${c.label}: ${STATUS_LABEL[s]} (${STATUS_HELP[s]})`, timingNote(c)];
  if (alias) lines.push(`Played from the older clip "${alias}".`);
  lines.push(s === "missing" ? "Click to create it from its template. The ... button or a right-click has more." : "Click to open. The ... button or a right-click has more: rename, duplicate, delete, length and fps, file path.");
  return lines.join("\n");
}

// ---- DOM helpers ----------------------------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Part {
  d: string;
  fill?: boolean;
  dash?: boolean;
}

function svg(parts: readonly Part[], cls?: string): SVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  for (const part of parts) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", part.d);
    if (part.fill) p.setAttribute("data-fill", "1");
    if (part.dash) p.setAttribute("stroke-dasharray", "3 3");
    s.append(p);
  }
  return s;
}

/** One shape per status, so colour is never the only signal: dashed ring, diamond, check disc, triangle, solid warning triangle. */
const STATUS_SHAPE: Record<ClipStatus, Part[]> = {
  missing: [{ d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", dash: true }],
  draft: [{ d: "M12 2.5 21.5 12 12 21.5 2.5 12z", fill: true }],
  done: [{ d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", fill: true }, { d: "M7.6 12.4l3 3 5.8-6.4" }],
  "needs-recheck": [{ d: "M12 3.2 21.4 20H2.6z" }, { d: "M12 9.4v5M12 17.2v.1" }],
  broken: [{ d: "M12 3.2 21.4 20H2.6z", fill: true }, { d: "M12 9.4v5M12 17.2v.1" }]
};

export function statusShape(s: ClipStatus): SVGElement {
  return svg(STATUS_SHAPE[s], `cb-shape s-${s}`);
}

const WEAPON_ICON: Record<Weapon, Part[]> = {
  sword: [{ d: "M18.5 3.5 20.5 5.5 9.8 16.2 7.8 14.2z" }, { d: "M6.5 15.5l2 2M5 19l-1.5 1.5M4.2 15.2l4.6 4.6" }],
  axe: [{ d: "M6 20 16.5 5.5" }, { d: "M12.5 5.2c3-2.2 6.2-1.4 7.5.6-.4 3.2-3 5.4-6 5.2z" }],
  hammer_shield: [{ d: "M3.5 8h8v6.5c0 2.600-1.800 4.300-4 5.500-2.200-1.200-4-2.900-4-5.500z" }, { d: "M17 20V8M13.500 4h7v4h-7z" }],
  scepter_relic: [{ d: "M6 20 15 9" }, { d: "M15.500 3v7M12.500 5.500h6" }, { d: "M17 15.500l2.500-2.500 2.500 2.500-2.500 2.500z" }],
  bow: [{ d: "M6 4c9 2 12 8 12 8s-3 6-12 8" }, { d: "M6 4v16M9.5 12H21M18.5 9.5 21 12l-2.5 2.5" }],
  staff: [{ d: "M6 20 15 9" }, { d: "M15.500 3.500a3.500 3.500 0 1 1-.1 0z" }]
};

const CLASS_ICON: Record<Klass | "generic", Part[]> = {
  generic: [{ d: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" }, { d: "M4.5 20.5c0-4.2 3.4-7 7.500-7s7.500 2.800 7.500 7z" }],
  ronin: [{ d: "M3 12.5 12 5l9 7.5z" }, { d: "M7 12.5V19M17 12.5V19M7 16h10" }],
  warrior: [{ d: "M5 12a7 7 0 0 1 14 0v8H5z" }, { d: "M9 13h6M12 13v5" }],
  paladin: [{ d: "M12 3 20 6v6c0 4.5-3.4 7.500-8 9-4.600-1.500-8-4.500-8-9V6z" }, { d: "M12 8v8M8.500 11.500h7" }],
  cleric: [{ d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" }, { d: "M12 7.500v9M7.500 11h9" }],
  ranger: [{ d: "M5 19C5 10 11 5 20 4c0 9-5 15-14 15z" }, { d: "M5 19 13 11" }],
  mage: [{ d: "M12 2.5 14.600 9.400 22 9.800l-5.800 4.600 2 7.100L12 17.300 5.800 21.500l2-7.100L2 9.800l7.400-.4z" }]
};

const weaponIcon = (w: Weapon) => svg(WEAPON_ICON[w], "cb-icon");
const classIcon = (k: Klass | null) => svg(CLASS_ICON[k ?? "generic"], "cb-icon");


// ---- The board ------------------------------------------------------------------------------------------------------

type SectionDef = { group: ClipGroup[]; title: string; category: SlotCategory; wide?: boolean };
const SECTIONS: SectionDef[] = [
  { group: ["move"], title: "Move", category: "move" },
  { group: ["gather"], title: "Gather", category: "gather" },
  { group: ["guard"], title: "Guard", category: "guard" },
  { group: ["react", "emote", "carry"], title: "Other", category: "other", wide: true }
];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "missing", label: "Missing" },
  { id: "draft", label: "Draft" },
  { id: "problems", label: "Problems" }
];

type MenuAct = "done" | "duplicate" | "reset";

const DOTS: Part[] = [{ d: "M5 12h.01M12 12h.01M19 12h.01" }];
const PLUS: Part[] = [{ d: "M12 5v14M5 12h14" }];

export function createClipBoard(ws: Workspaces): { open(): void; close(): void } {
  const root = h("div");
  root.id = "clipboard";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Clip board");
  document.body.append(root);

  let board: BoardState = {};
  let config: BoardConfig = { slots: [] };
  let clipsDir = "packages/animator-editor/clips";
  const rigHashes: Partial<Record<RigId, string>> = {};
  const gateErrors: Record<string, number> = {};
  let filter: Filter = "all";
  let notice: { text: string; kind: "" | "bad" | "ok" } | null = null;
  let busy = false;

  // The Clips button in the Animate header, and the stand-in weapon chip beside it.
  const headBtn = h("button", undefined, "Clips");
  headBtn.id = "clips-open";
  headBtn.type = "button";
  headBtn.dataset.ws = "animate pro";
  headBtn.title = "Clip board: the sample clip list with status. Make a new clip, rename, duplicate or delete one.";
  document.getElementById("clip")?.after(headBtn);
  headBtn.addEventListener("click", () => open());
  // Manage: rename, duplicate, delete and set length / fps for the clip that is open, from the Animate header (same dialogs and routes as the board's "..." menu).
  const manageBtn = h("button", undefined, "Manage");
  manageBtn.id = "clip-manage";
  manageBtn.type = "button";
  manageBtn.dataset.ws = "animate pro";
  manageBtn.title = "Manage this clip: rename, duplicate, delete, set length and fps";
  manageBtn.setAttribute("aria-haspopup", "menu");
  headBtn.after(manageBtn);
  const chip = h("span", "cb-standin");
  chip.id = "cb-standin";
  chip.hidden = true;
  manageBtn.after(chip);
  const syncHead = () => {
    const on = shownIn(headBtn.dataset.ws ?? "", ws.current());
    headBtn.hidden = !on;
    manageBtn.hidden = !on;
    if (!on) chip.hidden = true;
  };
  syncHead();
  ws.onChange(() => {
    syncHead();
    if (ws.current() === "home") close();
  });

  // The autosave banner ("Unsaved work found") is fixed at the top of the window; while the board is up the board sits below it.
  const bar = document.getElementById("restorebar");
  const syncBanner = () => root.style.setProperty("--cb-banner", bar && !bar.hidden ? `${Math.ceil(bar.getBoundingClientRect().height)}px` : "0px");
  if (bar && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(syncBanner).observe(bar);
    new MutationObserver(syncBanner).observe(bar, { attributes: true, attributeFilter: ["hidden"], childList: true });
  }

  const have = (host: EditorHost | null) => new Set(host ? [...host.clips().map((c) => c.name), ...host.saved()] : []);
  const slotClips = () => config.slots.map(slotToGameClip);
  const allEntries = () => [...GAME_CLIPS, ...slotClips()];

  /** Opens a clip that exists either in the library or as a saved file. */
  async function openExisting(host: EditorHost, id: string): Promise<void> {
    if (host.clips().some((c) => c.name === id)) host.switchClip(id);
    else await host.openSaved(`${id}.clip.json`);
  }
  const inputs = () => ({ rigHashes, gateErrors });
  const summary = () => {
    const names = have(getHost());
    return addSlotsToSummary(boardSummary(names, board, inputs()), config.slots, names, board, inputs());
  };

  async function loadBoard(): Promise<void> {
    try {
      const r = await fetch("/api/board");
      if (r.ok) board = parseBoard(await r.json());
    } catch {
      // no dev server: the board shows what it knows
    }
    try {
      const r = await fetch("/api/board-config");
      if (r.ok) {
        const body = (await r.json()) as { clipsDir?: unknown };
        config = parseBoardConfig(body);
        if (typeof body.clipsDir === "string") clipsDir = body.clipsDir;
      }
    } catch {
      // no config file yet
    }
    for (const rid of ["pro-turned"] as const) {
      const file = OUTFITS.find((o) => o.id === rid)?.document;
      if (!file || rigHashes[rid]) continue;
      try {
        const r = await fetch(`/api/rig/hash?file=${encodeURIComponent(file)}`);
        if (r.ok) rigHashes[rid] = ((await r.json()) as { hash: string }).hash;
      } catch {
        // hash unknown: needs-re-check is not reported
      }
    }
  }

  async function postJson(path: string, body: unknown): Promise<boolean> {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return r.ok;
    } catch {
      return false;
    }
  }
  const saveBoard = () => postJson("/api/board", board);
  const saveConfig = () => postJson("/api/board-config", { slots: config.slots });

  /** Deletes the saved file of a clip. True when it is gone (a clip that was never saved counts). */
  async function deleteFile(id: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/clips/${encodeURIComponent(`${id}.clip.json`)}`, { method: "DELETE" });
      return r.ok || r.status === 404;
    } catch {
      return false;
    }
  }
  const editorHandle = () => (window.atlasEditor ?? {}) as { dropClip?: (n: string) => void; refreshSaved?: () => Promise<void>; clipVersions?: (n: string) => Promise<void> };
  const refreshSaved = () => editorHandle().refreshSaved?.() ?? Promise.resolve();

  /** Gate errors of the clip that is open now (the only clip whose data the host hands out). */
  function noteGates(): void {
    const host = getHost();
    if (!host?.doc || !host.clipName) return;
    try {
      gateErrors[host.clipName] = clipGates(host.doc, host.clipName, host.clip).filter((i) => i.severity === "error").length;
    } catch {
      // a clip mid-edit can fail the check; the next event retries
    }
  }
  whenHost((host) => {
    host.on("clip", noteGates);
    host.on("save", noteGates);
  });

  function say(text: string, kind: "" | "bad" | "ok" = ""): void {
    notice = { text, kind };
    getHost()?.status(text, kind);
    if (!root.hidden && !root.classList.contains("solo")) render();
  }

  function setChip(entry: GameClip | null): void {
    const host = getHost();
    const lacks = !!entry?.weapon && !!host?.doc && !rigHasWeapon(host.doc.skins, entry.weapon);
    chip.hidden = !lacks;
    chip.textContent = lacks ? `Stand-in weapon: ${WEAPON_LABELS[entry!.weapon!].toLowerCase()}` : "";
    chip.title = lacks ? `The rig has no drawn ${WEAPON_LABELS[entry!.weapon!].toLowerCase()} yet, so poses are made without that art.` : "";
  }

  async function ensureRig(host: EditorHost, rig: RigId = "pro-turned"): Promise<void> {
    if (host.rig?.outfit.id !== rig) await host.mountOutfit(rig);
  }

  /** The one-click flow: rig, facing left, weapon art, clip (existing or from its template), game view, Animate workspace. */
  async function openEntry(entry: GameClip): Promise<void> {
    const host = getHost();
    if (!host || busy) return;
    busy = true;
    try {
      await ensureRig(host, entry.rig);
      host.setFacing("left");
      const skinNames = Object.keys(host.doc?.skins ?? {});
      const own = weaponSkins(skinNames, entry.weapon);
      if (own.length) host.setActiveSkins([skinNames[0]!, ...own]);
      const names = have(host);
      const alias = legacyAliasIn(entry.id, names);
      if (names.has(entry.id) || alias) await openExisting(host, alias ?? entry.id);
      else {
        const err = host.newClip(entry.id, templateFor(entry));
        if (err) return say(err, "bad");
        // A new slot clip is saved at once so it is a real file, and so it shows as a draft on the board.
        if (entry.custom && !(await host.saveClip())) say(`${entry.id} is open but NOT saved yet: see the status line`, "bad");
      }
      setChip(entry);
      noteGates();
      close();
      ws.go("animate");
      // An attack opens with the project view on (the hit frame is judged at game size); narrow windows open the phone dock instead.
      if (entry.group === "attack") {
        const gv = document.getElementById("gameviewbtn");
        const dockOpen = document.getElementById("dock-open");
        if (window.innerWidth >= 1600) {
          if (gv && !gv.classList.contains("on")) gv.click();
        } else if (dockOpen && document.getElementById("app")?.classList.contains("dockrail")) dockOpen.click();
      }
    } catch (e) {
      say(`Could not open ${entry.id}: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      busy = false;
    }
  }

  // ---- Dialog helper ----

  interface ModalSpec {
    title: string;
    intro?: string;
    fields?: HTMLElement[];
    confirm: string;
    danger?: boolean;
    /** Runs on confirm; returns an error text to keep the dialog open, or null to close it. */
    run: () => Promise<string | null> | string | null;
    id?: string;
    noCancel?: boolean;
  }
  interface Modal {
    layer: HTMLElement;
    ok: HTMLButtonElement;
    error(text: string): void;
  }

  function modal(spec: ModalSpec): Modal {
    root.querySelector(".cb-menu")?.remove();
    const layer = h("div", "cb-confirm-layer");
    const box = h("div", "cb-confirm");
    box.setAttribute("role", "alertdialog");
    if (spec.id) box.id = spec.id;
    const err = h("p", "cb-err");
    err.setAttribute("role", "alert");
    err.hidden = true;
    const row = h("div", "cb-confirm-row");
    const no = h("button", "cb-cancel", spec.noCancel ? "Close" : "Cancel");
    no.type = "button";
    no.title = "Close this without changing anything (Esc)";
    const yes = h("button", `cb-go ${spec.danger ? "cb-danger" : "btn-primary"}`, spec.confirm);
    yes.type = "button";
    yes.title = spec.confirm;
    const closeLayer = bindDialog(layer);
    no.addEventListener("click", closeLayer);
    const go = async () => {
      if (yes.disabled) return;
      yes.disabled = true;
      let msg: string | null;
      try {
        msg = await spec.run();
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      if (msg) {
        err.textContent = msg;
        err.hidden = false;
        yes.disabled = false;
      } else closeLayer();
    };
    yes.addEventListener("click", () => void go());
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "checkbox") {
        e.preventDefault();
        void go();
      }
    });
    row.append(no);
    if (spec.confirm) row.append(yes);
    box.append(h("h3", undefined, spec.title));
    if (spec.intro) box.append(h("p", undefined, spec.intro));
    box.append(...(spec.fields ?? []), err, row);
    layer.append(box);
    root.append(layer);
    (box.querySelector("input, select") as HTMLElement | null)?.focus();
    if (!box.querySelector("input, select")) yes.focus();
    return {
      layer,
      ok: yes,
      error: (text) => {
        err.textContent = text;
        err.hidden = !text;
      }
    };
  }

  function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const wrap = h("label", "cb-field");
    wrap.append(h("span", "cb-field-label", label), control);
    if (hint) wrap.append(h("span", "cb-field-hint", hint));
    return wrap;
  }

  function input(id: string, value: string, title: string, type = "text"): HTMLInputElement {
    const i = h("input", "in");
    i.id = id;
    i.type = type;
    i.value = value;
    i.title = title;
    i.autocomplete = "off";
    i.spellcheck = false;
    return i;
  }

  function select(id: string, title: string, options: [value: string, label: string][]): HTMLSelectElement {
    const s = h("select");
    s.id = id;
    s.title = title;
    for (const [v, l] of options) s.append(new Option(l, v));
    return s;
  }

  function checkbox(id: string, label: string, checked: boolean, title: string): HTMLElement {
    const wrap = h("label", "cb-check");
    const c = h("input");
    c.type = "checkbox";
    c.id = id;
    c.checked = checked;
    c.title = title;
    wrap.append(c, h("span", undefined, label));
    return wrap;
  }

  /** Live validation: the OK button follows `check`, and the message shows under the fields. */
  function validate(m: Modal, inputs: HTMLElement[], check: () => string | null): void {
    const run = () => {
      const msg = check();
      m.error(msg ?? "");
      m.ok.disabled = !!msg;
    };
    for (const i of inputs) i.addEventListener("input", run);
    for (const i of inputs) i.addEventListener("change", run);
    run();
  }

  const takenNames = () => have(getHost());

  // ---- Create, duplicate, rename ----

  /** Puts `data` in the library under `name`, opens it, writes the file and checks the write landed. Returns an error text or null. */
  async function createSaved(host: EditorHost, name: string, data: ClipData, rig: RigId = "pro-turned"): Promise<string | null> {
    await ensureRig(host, rig);
    host.setFacing("left");
    const err = host.newClip(name, data);
    if (err) return err;
    if (!(await host.saveClip())) return `${name} could not be saved. See the status line.`;
    await refreshSaved();
    if (!host.saved().includes(name)) return `${name} could not be written to ${clipsDir}. See the status line.`;
    return null;
  }

  function newClipDialog(): void {
    const host = getHost();
    if (!host) return;
    const nameIn = input("cb-new-name", "", "Clip name: letters, digits, _ . - (it becomes <name>.clip.json)");
    nameIn.placeholder = "my_new_clip";
    const fromSel = h("select");
    fromSel.id = "cb-new-from";
    fromSel.title = "What the clip starts as: empty, one of the project's templates (length and event markers filled in), or a copy of a clip you already made";
    fromSel.append(new Option("Blank clip", "blank"));
    const tplGroup = h("optgroup");
    tplGroup.label = "Game template (length and events filled in)";
    for (const e of allEntries()) if (!e.custom) tplGroup.append(new Option(e.label, `tpl:${e.id}`));
    fromSel.append(tplGroup);
    const names = [...takenNames()].sort();
    if (names.length) {
      const dupGroup = h("optgroup");
      dupGroup.label = "Copy of an existing clip";
      for (const n of names) dupGroup.append(new Option(n, `dup:${n}`));
      fromSel.append(dupGroup);
    }
    const lenIn = input("cb-new-length", "1", "Length in seconds (rounded to whole frames)", "number");
    lenIn.step = "0.05";
    lenIn.min = "0.05";
    const fpsIn = input("cb-new-fps", "30", "Frames per second (30 matches the project)", "number");
    fpsIn.step = "1";
    const loopWrap = checkbox("cb-new-loop", "Loop", false, "A looping clip repeats; a one-shot plays once and stops");
    const loopIn = loopWrap.querySelector("input") as HTMLInputElement;
    const touched = new Set<string>();
    for (const [el, k] of [[lenIn, "len"], [fpsIn, "fps"], [loopIn, "loop"]] as const) el.addEventListener("input", () => touched.add(k));
    const hint = h("span", "cb-field-hint");
    const applyDefaults = () => {
      const v = fromSel.value;
      touched.clear();
      hint.textContent = "";
      if (v.startsWith("tpl:")) {
        const e = allEntries().find((x) => x.id === v.slice(4));
        if (!e) return;
        const t = templateFor(e);
        const lf = clipLengthFps(t);
        lenIn.value = String(lf.seconds);
        fpsIn.value = String(lf.fps);
        loopIn.checked = t.loop;
        hint.textContent = "Filled in from the template. Change a number to override it.";
      } else if (v.startsWith("dup:")) {
        hint.textContent = "Length, fps and loop come from the original unless you change them here.";
      } else {
        lenIn.value = "1";
        fpsIn.value = "30";
        loopIn.checked = false;
      }
    };
    fromSel.addEventListener("change", applyDefaults);
    const m = modal({
      id: "cb-new-dialog",
      title: "New clip",
      intro: "Make a clip of your own. It is saved as a file right away and opens in Animate.",
      fields: [
        field("Name", nameIn),
        field("Start from", fromSel),
        h("div", "cb-field-row"),
        hint
      ],
      confirm: "Create and open",
      run: async () => {
        const name = nameIn.value.trim();
        const err = clipNameError(name, takenNames());
        if (err) return err;
        const lf = lengthFpsError(Number(lenIn.value), Number(fpsIn.value));
        if (lf && (fromSel.value === "blank" || touched.has("len") || touched.has("fps"))) return lf;
        const h2 = getHost();
        if (!h2) return "The editor is not ready.";
        await ensureRig(h2);
        let data: ClipData;
        const from = fromSel.value;
        if (from.startsWith("dup:")) {
          await openExisting(h2, from.slice(4));
          data = structuredClone(h2.clip);
        } else if (from.startsWith("tpl:")) {
          const e = allEntries().find((x) => x.id === from.slice(4));
          data = e ? templateFor(e) : retimeClip(structuredClone(h2.clip), 1, 30).clip;
        } else data = retimeClip(templateFor(customClipEntry(name)), Number(lenIn.value), Number(fpsIn.value)).clip;
        const wantRetime = from === "blank" ? false : touched.has("len") || touched.has("fps");
        if (wantRetime) {
          const base = clipLengthFps(data);
          data = retimeClip(data, touched.has("len") ? Number(lenIn.value) : base.seconds, touched.has("fps") ? Number(fpsIn.value) : base.fps).clip;
        }
        data = from === "blank" || touched.has("loop") ? { ...data, loop: loopIn.checked } : data;
        const bad = await createSaved(h2, name, data);
        if (bad) return bad;
        setChip(null);
        noteGates();
        close();
        ws.go("animate");
        say(`Created ${name}`, "ok");
        return null;
      }
    });
    // The loop checkbox sits with the length and fps in one row.
    const row = h("div", "cb-field-row");
    row.append(field("Length (s)", lenIn), field("Frames per second", fpsIn), loopWrap);
    m.layer.querySelector(".cb-field-row")?.replaceWith(row);
    validate(m, [nameIn, fromSel, lenIn, fpsIn], () => {
      const e = clipNameError(nameIn.value, takenNames());
      if (e) return nameIn.value.trim() ? e : null;
      const needsNumbers = fromSel.value === "blank" || touched.has("len") || touched.has("fps");
      return needsNumbers ? lengthFpsError(Number(lenIn.value), Number(fpsIn.value)) : null;
    });
    m.ok.disabled = true;
  }

  /** Copies a clip into a new name and saves it (Duplicate and Rename both use this). */
  async function copyClipTo(host: EditorHost, source: string, name: string): Promise<string | null> {
    await openExisting(host, source);
    const data = structuredClone(host.clip);
    return createSaved(host, name, data);
  }

  function duplicateDialog(entry: GameClip): void {
    const host = getHost();
    if (!host) return;
    const names = takenNames();
    const src = legacyAliasIn(entry.id, names) ?? entry.id;
    const nameIn = input("cb-dup-name", freeName(`${entry.id}_copy`, names), "Name for the copy");
    const m = modal({
      id: "cb-dup-dialog",
      title: `Duplicate ${entry.label}`,
      intro: "The copy has the same poses, events, length and fps. It is saved as its own file under My clips.",
      fields: [field("Name of the copy", nameIn)],
      confirm: "Duplicate",
      run: async () => {
        const name = nameIn.value.trim();
        const err = clipNameError(name, takenNames());
        if (err) return err;
        const h2 = getHost();
        if (!h2) return "The editor is not ready.";
        const bad = await copyClipTo(h2, src, name);
        if (bad) return bad;
        say(`Duplicated ${entry.label} as ${name}`, "ok");
        return null;
      }
    });
    validate(m, [nameIn], () => clipNameError(nameIn.value, takenNames()));
    nameIn.select();
  }

  function renameDialog(entry: GameClip): void {
    const host = getHost();
    if (!host) return;
    const nameIn = input("cb-rename-name", entry.id, "New name (the file is renamed too)");
    const m = modal({
      id: "cb-rename-dialog",
      title: `Rename ${entry.id}`,
      intro: "Saves the clip under the new name and removes the old file. Done marks move with it.",
      fields: [field("New name", nameIn)],
      confirm: "Rename",
      run: async () => {
        const name = nameIn.value.trim();
        const err = clipNameError(name, takenNames(), entry.id);
        if (err) return err;
        if (name === entry.id) return null;
        const h2 = getHost();
        if (!h2) return "The editor is not ready.";
        const bad = await copyClipTo(h2, entry.id, name);
        if (bad) return bad;
        if (!(await deleteFile(entry.id))) return `${name} was saved, but the old file ${entry.id}.clip.json could not be deleted.`;
        editorHandle().dropClip?.(entry.id);
        await refreshSaved();
        const old = board[entry.id];
        if (old) {
          const { [entry.id]: _drop, ...rest } = board;
          board = { ...rest, [name]: old };
          await saveBoard();
        }
        say(`Renamed ${entry.id} to ${name}`, "ok");
        return null;
      }
    });
    validate(m, [nameIn], () => clipNameError(nameIn.value, takenNames(), entry.id));
    nameIn.select();
  }

  function deleteDialog(entry: GameClip): void {
    const isSlot = !!entry.custom && !entry.mine;
    const m = modal({
      id: "cb-delete-dialog",
      title: `Delete ${entry.label}?`,
      intro: `This deletes the file ${entry.id}.clip.json from ${clipsDir}. Its last saved versions stay under Recently deleted on this board (the newest 50), so you can restore it.${
        isSlot || !entry.custom ? " The slot stays on the board and shows as Missing." : ""
      }`,
      confirm: "Delete clip",
      danger: true,
      run: async () => {
        if (!(await deleteFile(entry.id))) return "The file could not be deleted. Is the editor server running?";
        editorHandle().dropClip?.(entry.id);
        if (board[entry.id]) {
          const { [entry.id]: _drop, ...rest } = board;
          board = rest;
          await saveBoard();
        }
        await refreshSaved();
        say(`Deleted ${entry.id}`, "ok");
        return null;
      }
    });
    m.ok.title = `Delete ${entry.id}.clip.json (it can be restored from Recently deleted)`;
  }

  async function lengthDialog(entry: GameClip): Promise<void> {
    const host = getHost();
    if (!host) return;
    const id = legacyAliasIn(entry.id, takenNames()) ?? entry.id;
    await openExisting(host, id);
    const original = structuredClone(host.clip);
    const cur = clipLengthFps(original);
    const lenIn = input("cb-len-length", String(cur.seconds), "Length in seconds (rounded to whole frames)", "number");
    lenIn.step = "0.05";
    const fpsIn = input("cb-len-fps", String(cur.fps), "Frames per second", "number");
    const info = h("p", "cb-field-hint");
    const m = modal({
      id: "cb-length-dialog",
      title: `Length and fps of ${entry.id}`,
      intro: `Now ${cur.seconds} s at ${cur.fps} fps (${Math.round(cur.seconds * cur.fps)} frames).`,
      fields: [(() => {
        const row = h("div", "cb-field-row");
        row.append(field("Length (s)", lenIn), field("Frames per second", fpsIn));
        return row;
      })(), info],
      confirm: "Apply and save",
      run: async () => {
        const bad = lengthFpsError(Number(lenIn.value), Number(fpsIn.value));
        if (bad) return bad;
        const h2 = getHost();
        if (!h2) return "The editor is not ready.";
        await openExisting(h2, id);
        const next = retimeClip(h2.clip, Number(lenIn.value), Number(fpsIn.value));
        h2.commit(next.clip, "Set length and fps");
        if (!(await h2.saveClip())) return `${entry.id}: the new length is set here but NOT saved. See the status line.`;
        noteGates();
        say(`${entry.id}: ${lenIn.value} s at ${fpsIn.value} fps${next.dropped ? `, ${next.dropped} key${next.dropped === 1 ? "" : "s"} past the end removed` : ""}`, "ok");
        return null;
      }
    });
    validate(m, [lenIn, fpsIn], () => {
      const bad = lengthFpsError(Number(lenIn.value), Number(fpsIn.value));
      if (bad) return bad;
      const r = retimeClip(original, Number(lenIn.value), Number(fpsIn.value));
      info.textContent = r.dropped ? `${r.dropped} key${r.dropped === 1 ? "" : "s"} past the new end will be removed.` : "No keys are lost.";
      return null;
    });
  }

  function revealDialog(entry: GameClip): void {
    const host = getHost();
    const id = legacyAliasIn(entry.id, takenNames()) ?? entry.id;
    const onDisk = !!host?.saved().includes(id);
    const path = `${clipsDir.replace(/[\\/]+$/, "")}/${id}.clip.json`;
    const pathIn = input("cb-path", path, "The clip file on disk");
    pathIn.readOnly = true;
    pathIn.addEventListener("focus", () => pathIn.select());
    const copy = h("button", "cb-cancel", "Copy path");
    copy.type = "button";
    copy.id = "cb-path-copy";
    copy.title = "Copy the full file path to the clipboard";
    copy.addEventListener("click", () => {
      pathIn.select();
      void navigator.clipboard?.writeText(path).then(
        () => (copy.textContent = "Copied"),
        () => (copy.textContent = "Press Ctrl+C")
      );
    });
    modal({
      id: "cb-path-dialog",
      title: `File of ${entry.id}`,
      intro: onDisk ? "This is where the clip is saved." : "Not saved yet: this is where it will be written when you save it.",
      fields: [pathIn, copy],
      confirm: "",
      noCancel: true,
      run: () => null
    });
  }

  // ---- Custom slots ----

  function addSlotDialog(category: SlotCategory = "other"): void {
    const catSel = select("cb-slot-category", "Which list on the board the new required clip goes in", SLOT_CATEGORIES.map((c) => [c, SLOT_CATEGORY_LABELS[c]]));
    catSel.value = category;
    const labelIn = input("cb-slot-label", "", "What the clip is called on the board, e.g. Emote: dance");
    labelIn.placeholder = "Emote: dance";
    const idIn = input("cb-slot-id", "", "The clip's file name; the project looks the clip up by it");
    const rowSel = select("cb-slot-row", "Which class row of the attack matrix. Generic lets you pick the weapon.", [["", "Generic"], ...CLASSES.map((k) => [k, CLASS_LABELS[k]] as [string, string])]);
    const weaponSel = select("cb-slot-weapon", "Which weapon column of the attack matrix", WEAPONS.map((w) => [w, WEAPON_LABELS[w]]));
    const stepOut = h("span", "cb-field-hint");
    const lenIn = input("cb-slot-length", "1", "How long the clip should be, in seconds", "number");
    lenIn.step = "0.05";
    const loopWrap = checkbox("cb-slot-loop", "Loop", false, "A looping clip repeats; a one-shot plays once");
    const loopIn = loopWrap.querySelector("input") as HTMLInputElement;
    const labelField = field("Label", labelIn);
    const idField = field("Clip name", idIn);
    const attackFields = h("div", "cb-field-row");
    attackFields.append(field("Row", rowSel), field("Weapon", weaponSel));
    let idTouched = false;
    idIn.addEventListener("input", () => (idTouched = true));
    const slotIds = () => new Set([...config.slots.map((s) => s.id)]);
    const sync = () => {
      const attack = catSel.value === "attack";
      attackFields.hidden = !attack;
      stepOut.hidden = !attack;
      labelField.hidden = attack;
      idField.hidden = attack;
      if (attack) {
        const klass = (rowSel.value || null) as Klass | null;
        weaponSel.disabled = !!klass;
        if (klass) weaponSel.value = CLASS_WEAPON[klass];
        const step = nextStep(config.slots, weaponSel.value as Weapon, klass);
        stepOut.textContent = `Adds ${attackSlotLabel(weaponSel.value as Weapon, klass, step)} (${attackSlotId(weaponSel.value as Weapon, klass, step)}) as step ${step}.`;
        loopIn.checked = false;
      } else if (!idTouched) idIn.value = slugify(labelIn.value);
    };
    for (const el of [catSel, rowSel, weaponSel, labelIn]) el.addEventListener("input", sync);
    const m = modal({
      id: "cb-slot-dialog",
      title: "Add a slot",
      intro: "A slot is a clip the project needs. It shows on the board with a status like the built-in ones, and you can remove it again.",
      fields: [
        field("Category", catSel),
        labelField,
        idField,
        attackFields,
        stepOut,
        (() => {
          const row = h("div", "cb-field-row");
          row.append(field("Length (s)", lenIn), loopWrap);
          return row;
        })()
      ],
      confirm: "Add slot",
      run: async () => {
        const cat = catSel.value as SlotCategory;
        const dur = Number(lenIn.value);
        const bad = lengthFpsError(dur, 30);
        if (bad) return bad;
        let slot: CustomSlot;
        if (cat === "attack") {
          const klass = (rowSel.value || null) as Klass | null;
          const weapon = weaponSel.value as Weapon;
          const step = nextStep(config.slots, weapon, klass);
          slot = { id: attackSlotId(weapon, klass, step), label: attackSlotLabel(weapon, klass, step), category: cat, weapon, klass, step, loop: false, durationS: dur };
        } else {
          const id = idIn.value.trim();
          const err = clipNameError(id, slotIds());
          const clash = err && !err.startsWith("A clip with that name") ? err : null;
          if (clash) return clash;
          if (slotIds().has(id)) return "There is already a slot with that clip name.";
          if (!labelIn.value.trim()) return "Give the slot a label.";
          slot = { id, label: labelIn.value.trim(), category: cat, loop: loopIn.checked, durationS: dur };
        }
        const before = config;
        config = { slots: [...config.slots, slot] };
        if (!(await saveConfig())) {
          config = before;
          return "Could not save clips/board-config.json. Is the editor server running?";
        }
        say(`Added slot ${slot.label}`, "ok");
        return null;
      }
    });
    sync();
    validate(m, [catSel, rowSel, weaponSel, labelIn, idIn, lenIn], () => {
      const bad = lengthFpsError(Number(lenIn.value), 30);
      if (bad) return bad;
      if (catSel.value === "attack") return null;
      if (!labelIn.value.trim()) return null;
      const err = clipNameError(idIn.value, slotIds());
      if (err && !err.startsWith("A clip with that name")) return err;
      return slotIds().has(idIn.value.trim()) ? "There is already a slot with that clip name." : null;
    });
    m.ok.disabled = true;
  }

  function removeSlotDialog(entry: GameClip): void {
    modal({
      id: "cb-removeslot-dialog",
      title: `Remove the slot ${entry.label}?`,
      intro: "Only the slot leaves the board. The clip file, if there is one, is not touched and moves to My clips.",
      confirm: "Remove slot",
      run: async () => {
        const before = config;
        config = { slots: config.slots.filter((s) => s.id !== entry.id) };
        if (!(await saveConfig())) {
          config = before;
          return "Could not save clips/board-config.json. Is the editor server running?";
        }
        say(`Removed slot ${entry.label}`, "ok");
        return null;
      }
    });
  }

  // ---- Mark done, reset, copy poses in (each confirms first) ----

  async function runAct(entry: GameClip, act: MenuAct, source?: string): Promise<void> {
    const host = getHost();
    if (!host) return;
    const names = have(host);
    const id = legacyAliasIn(entry.id, names) ?? entry.id;
    await ensureRig(host, entry.rig);
    if (act === "done") {
      const was = board[entry.id]?.done === true;
      await openExisting(host, id);
      // Mark done only records a clip whose save completed ().
      if (!was && !(await host.saveClip())) return say(`${entry.label}: not marked done, the clip did not save`, "bad");
      noteGates();
      await loadBoard();
      board = withDone(board, entry.id, !was, rigHashes[entry.rig] ?? "", new Date().toISOString());
      const ok = await saveBoard();
      say(ok ? `${entry.label}: ${was ? "marked not done" : "marked done"}` : "Could not save the board file", ok ? "ok" : "bad");
    } else if (act === "reset") {
      if (names.has(id)) await openExisting(host, id);
      else host.newClip(id, templateFor(entry));
      host.commit(templateFor(entry), "Reset to template");
      say(`${entry.label}: reset to its template`, "ok");
    } else if (source) {
      await openExisting(host, source);
      const data = structuredClone(host.clip);
      if (names.has(id)) {
        await openExisting(host, id);
        host.commit(data, `Copy poses from ${source}`);
      } else {
        const err = host.newClip(id, data);
        if (err) return say(err, "bad");
      }
      say(`${entry.label}: copied from ${source}`, "ok");
    }
  }

  function confirmDialog(entry: GameClip, act: MenuAct): void {
    const host = getHost();
    const names = have(host);
    const exists = names.has(entry.id) || !!legacyAliasIn(entry.id, names);
    const isDone = board[entry.id]?.done === true;
    let sel: HTMLSelectElement | null = null;
    let body: string;
    if (act === "done") body = exists ? `${entry.label} is saved, then ${isDone ? "taken off the done list" : "counted as done while it passes the checks"}.` : `${entry.label} is not made yet. Open it first.`;
    else if (act === "reset") body = `Replace everything in ${entry.label} with a fresh template: the length and event markers the project expects, and no poses.`;
    else body = `${entry.label} takes the poses and events of the clip you pick${exists ? ", replacing what it has now" : ""}.`;
    if (act === "duplicate") {
      sel = h("select");
      sel.id = "cb-dup-src";
      sel.title = "The clip whose poses and events are copied in";
      for (const n of [...names].sort()) if (n !== entry.id) sel.append(new Option(n, n));
      if (!sel.options.length) {
        sel.append(new Option("No other clips yet", ""));
        sel.disabled = true;
      }
    }
    const picked = sel;
    const m = modal({
      title: act === "done" ? (isDone ? "Mark as not done?" : "Mark as done?") : act === "reset" ? "Reset to template?" : "Copy poses in from another clip?",
      intro: body,
      fields: picked ? [picked] : [],
      confirm: act === "done" ? "Yes, do it" : act === "reset" ? "Reset it" : "Copy it",
      run: () => {
        void runAct(entry, act, picked?.value);
        return null;
      }
    });
    m.ok.disabled = (act === "done" && !exists) || (!!picked && picked.disabled);
  }

  // ---- The menu: the same list from the "..." button and from a right-click ----

  function showMenu(entry: GameClip, x: number, y: number, only?: readonly string[]): void {
    root.querySelector(".cb-menu")?.remove();
    const host = getHost();
    const names = have(host);
    const id = legacyAliasIn(entry.id, names) ?? entry.id;
    const exists = names.has(entry.id) || !!legacyAliasIn(entry.id, names);
    const saved = !!host?.saved().includes(id);
    const inLibrary = !!host?.clips().some((c) => c.name === id);
    const isMine = !!entry.mine;
    const isSlot = !!entry.custom && !entry.mine;
    const canDelete = saved || host?.clips().some((c) => c.name === id && c.origin === "new");
    const menu = h("div", "cb-menu");
    menu.setAttribute("role", "menu");
    menu.append(h("div", "cb-menu-title", entry.label));
    type Item = { label: string; act: string; run: () => void; off?: string | undefined; danger?: boolean };
    const items: (Item | "sep")[] = [
      { act: "open", label: exists ? "Open" : "Create and open", run: () => void openEntry(entry) },
      { act: "rename", label: "Rename...", run: () => renameDialog(entry), off: !isMine ? "Project clips and slots keep their name so the project can find them." : undefined },
      { act: "duplicate-copy", label: "Duplicate...", run: () => duplicateDialog(entry), off: !exists ? "Not made yet: nothing to duplicate." : undefined },
      { act: "delete", label: "Delete...", run: () => deleteDialog(entry), danger: true, off: !canDelete ? (inLibrary ? "This clip comes from the rig, not from a saved file." : "Not saved on disk: nothing to delete.") : undefined },
      { act: "length", label: "Set length / fps...", run: () => void lengthDialog(entry), off: !exists ? "Not made yet: create it first." : undefined },
      { act: "reveal", label: "Reveal file path", run: () => revealDialog(entry) },
      { act: "versions", label: "Versions...", run: () => void editorHandle().clipVersions?.(id) },
      "sep",
      { act: "done", label: board[entry.id]?.done ? "Mark not done" : "Mark done", run: () => confirmDialog(entry, "done") },
      { act: "duplicate", label: "Copy poses in from...", run: () => confirmDialog(entry, "duplicate") },
      { act: "reset", label: "Reset to template", run: () => confirmDialog(entry, "reset") },
      ...(isSlot ? (["sep", { act: "removeslot", label: "Remove slot...", run: () => removeSlotDialog(entry), danger: true }] as (Item | "sep")[]) : [])
    ];
    for (const it of items) {
      if (only && (it === "sep" || !only.includes(it.act))) continue;
      if (it === "sep") {
        menu.append(h("div", "cb-menu-sep"));
        continue;
      }
      const b = h("button", `cb-menu-item${it.danger ? " danger" : ""}`, it.label);
      b.type = "button";
      b.dataset.act = it.act;
      b.setAttribute("role", "menuitem");
      b.title = it.off ?? it.label.replace("...", "");
      if (it.off) {
        b.disabled = true;
        b.classList.add("off");
      }
      b.addEventListener("click", () => {
        menu.remove();
        it.run();
      });
      menu.append(b);
    }
    root.append(menu);
    const r = root.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x - r.left, r.width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y - r.top, r.height - menu.offsetHeight - 8))}px`;
    (menu.querySelector(".cb-menu-item:not(:disabled)") as HTMLElement | null)?.focus();
  }

  // ---- Manage the open clip from the Animate header: the same menu and dialogs, shown over the editor without the board ----

  let soloTimer = 0;
  const endSolo = () => {
    if (!root.classList.contains("solo")) return;
    if (root.querySelector(".cb-menu, .cb-confirm-layer")) return;
    root.classList.remove("solo");
    root.hidden = true;
    root.replaceChildren();
  };
  new MutationObserver(() => {
    if (!root.classList.contains("solo")) return;
    window.clearTimeout(soloTimer);
    soloTimer = window.setTimeout(endSolo, 160);
  }).observe(root, { childList: true });

  async function manageCurrent(): Promise<void> {
    const host = getHost();
    const name = host?.clipName;
    if (!host || !name) return;
    const names = have(host);
    const entry = allEntries().find((e) => e.id === name || legacyAliasIn(e.id, names) === name) ?? customClipEntry(name);
    // Rename and Delete rewrite the board's done marks: load them first so nothing is saved over a board that was never read.
    await loadBoard();
    const r = manageBtn.getBoundingClientRect();
    root.hidden = false;
    root.classList.add("solo");
    syncBanner();
    root.replaceChildren();
    showMenu(entry, r.left, r.bottom + 4, ["rename", "duplicate-copy", "delete", "length"]);
  }
  manageBtn.addEventListener("click", () => void manageCurrent());

  // ---- Rendering ----

  function moreButton(entry: GameClip, cls: string): HTMLButtonElement {
    const b = h("button", `cb-more ${cls}`);
    b.type = "button";
    b.dataset.more = entry.id;
    b.title = `More for ${entry.label}: open, rename, duplicate, delete, set length / fps, reveal file path`;
    b.setAttribute("aria-label", `More actions for ${entry.label}`);
    b.setAttribute("aria-haspopup", "menu");
    b.append(svg(DOTS, "cb-icon"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      showMenu(entry, r.right - 8, r.bottom + 4);
    });
    return b;
  }

  function clipButton(entry: GameClip, s: ClipStatus, names: ReadonlySet<string>, cls: string): HTMLButtonElement {
    const b = h("button", `${cls} s-${s}${passesFilter(s, filter) ? "" : " dim"}`);
    b.type = "button";
    b.dataset.clip = entry.id;
    b.dataset.status = s;
    b.title = clipTip(entry, s, legacyAliasIn(entry.id, names));
    b.setAttribute("aria-label", `${entry.label}, ${STATUS_LABEL[s]}`);
    b.addEventListener("click", () => void openEntry(entry));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(entry, e.clientX, e.clientY);
    });
    return b;
  }

  function createPill(): HTMLElement {
    const p = h("span", "cb-create");
    p.append(svg(PLUS, "cb-icon"), "Create");
    return p;
  }

  function renderMatrix(sum: ReturnType<typeof summary>, names: ReadonlySet<string>): HTMLElement {
    const wrap = h("section", "cb-matrix");
    const head = h("h3", "cb-h");
    head.append("Attack combos", addSlotButton("attack", "Add a combo step"));
    wrap.append(head);
    const grid = h("div", "cb-grid");
    grid.append(h("span", "cb-corner"));
    for (const w of WEAPONS) {
      const colhead = h("div", "cb-colhead");
      colhead.append(weaponIcon(w), h("span", "cb-colname", WEAPON_LABELS[w]));
      const tags = h("div", "cb-tags");
      if (!RIG_WEAPON_ATTACHMENT[w]) {
        const tag = h("span", "cb-tag", "stand-in");
        tag.title = `The rig has no drawn ${WEAPON_LABELS[w].toLowerCase()} yet: its clips use a stand-in weapon.`;
        tags.append(tag);
      }
      if (matrixRows().some((row) => cellUsed(row.klass, w) && matrixCell(row.klass, w).some((c) => c.timing.source === "default"))) {
        const tag = h("span", "cb-tag", "timing?");
        tag.title = "Timing not in project yet: these lengths are placeholders until the project has an attack profile for this weapon.";
        tags.append(tag);
      }
      if (tags.childElementCount) colhead.append(tags);
      grid.append(colhead);
    }
    const extra = slotClips().filter((c) => c.group === "attack");
    for (const row of matrixRows()) {
      const label = h("div", "cb-rowhead");
      label.append(classIcon(row.klass), h("span", "cb-rowname", row.label));
      grid.append(label);
      for (const w of WEAPONS) {
        if (!cellUsed(row.klass, w)) {
          grid.append(h("div", "cb-cell unused"));
          continue;
        }
        const clips = [...matrixCell(row.klass, w), ...extra.filter((c) => c.weapon === w && c.klass === row.klass)];
        const cell = h("div", "cb-cell");
        cell.dataset.cell = `${row.klass ?? "generic"}:${w}`;
        const dots = h("div", `cb-dots${clips.length > 3 ? " many" : ""}`);
        for (const c of clips) {
          const s = sum.status[c.id]!;
          const wrapDot = h("div", "cb-dotwrap");
          const b = clipButton(c, s, names, "cb-dot");
          b.append(statusShape(s), h("span", "cb-step", String(c.step)));
          if (s === "missing") {
            const plus = h("span", "cb-plus");
            plus.append(svg(PLUS, "cb-icon"));
            b.append(plus);
          }
          wrapDot.append(b, moreButton(c, "cb-more-dot"));
          dots.append(wrapDot);
        }
        cell.append(dots);
        grid.append(cell);
      }
    }
    wrap.append(grid);
    return wrap;
  }

  function addSlotButton(category: SlotCategory, what: string): HTMLButtonElement {
    const b = h("button", "cb-addslot");
    b.type = "button";
    b.dataset.addslot = category;
    b.title = `${what}: add a new required clip to the board. It is saved in clips/board-config.json and can be removed again.`;
    b.append(svg(PLUS, "cb-icon"), "Add slot");
    b.addEventListener("click", () => addSlotDialog(category));
    return b;
  }

  function chipRow(c: GameClip, s: ClipStatus, names: ReadonlySet<string>): HTMLElement {
    const row = h("div", "cb-row");
    const b = clipButton(c, s, names, "cb-chip");
    b.append(statusShape(s), h("span", "cb-chip-name", c.label));
    const alias = legacyAliasIn(c.id, names);
    if (alias) {
      const t = h("span", "cb-badge", "old name");
      t.title = `Played from the older clip "${alias}".`;
      b.append(t);
    } else if (c.timing.source === "default") {
      const t = h("span", "cb-badge", "timing?");
      t.title = "Timing not in project yet: the length is a placeholder.";
      b.append(t);
    } else if (c.custom && !c.mine) {
      const t = h("span", "cb-badge cb-badge-custom", "custom");
      t.title = "A slot you added. Remove it from the ... menu.";
      b.append(t);
    }
    if (s === "missing") b.append(createPill());
    row.append(b, moreButton(c, "cb-more-row"));
    return row;
  }

  function renderLists(sum: ReturnType<typeof summary>, names: ReadonlySet<string>): HTMLElement {
    const wrap = h("section", "cb-lists");
    const customSlots = slotClips().filter((c) => c.group !== "attack");
    for (const sec of SECTIONS) {
      const clips = [...GAME_CLIPS, ...customSlots].filter((c) => sec.group.includes(c.group));
      const box = h("div", `cb-sec${sec.wide ? " wide" : ""}`);
      const done = clips.filter((c) => sum.status[c.id] === "done").length;
      const head = h("h3", "cb-h");
      const left = h("span", "cb-h-title");
      left.append(sec.title, h("span", "cb-sec-count", `${done}/${clips.length}`));
      head.append(left, addSlotButton(sec.category, `Add a ${sec.title.toLowerCase()} clip`));
      box.append(head);
      const list = h("div", "cb-list");
      for (const c of clips) list.append(chipRow(c, sum.status[c.id]!, names));
      box.append(list);
      wrap.append(box);
    }
    wrap.append(renderMine(names));
    return wrap;
  }

  function renderMine(names: ReadonlySet<string>): HTMLElement {
    const host = getHost();
    const own = customClipNames([...(host?.saved() ?? []), ...(host?.clips().filter((c) => c.origin === "new").map((c) => c.name) ?? [])], config.slots);
    const box = h("div", "cb-sec wide cb-mine");
    const head = h("h3", "cb-h");
    const left = h("span", "cb-h-title");
    left.title = "Clips you made yourself. They are not required by the project, so they do not count toward the progress bar.";
    left.append("My clips", h("span", "cb-sec-count", String(own.length)));
    head.append(left, newClipButton("cb-new-clip-sec", true));
    box.append(head);
    const list = h("div", "cb-list");
    if (!own.length) {
      const empty = h("div", "cb-empty");
      empty.append(h("p", undefined, "Nothing here yet. Clips you make with + New clip, and clips saved under any other name, show up here."));
      list.append(empty);
    }
    for (const n of own) {
      const e = customClipEntry(n);
      list.append(chipRow(e, clipStatus(e, names, board, inputs()), names));
    }
    box.append(list);
    return box;
  }

  function newClipButton(id: string, small = false): HTMLButtonElement {
    const b = h("button", small ? "cb-addslot" : "cb-new btn-primary");
    b.type = "button";
    b.id = id;
    b.title = "New clip: name it, start blank, from a game template or from a copy, set length and fps, then it opens in Animate";
    b.append(svg(PLUS, "cb-icon"), "New clip");
    b.addEventListener("click", newClipDialog);
    return b;
  }

  function render(): void {
    const names = have(getHost());
    const sum = summary();
    const top = h("div", "cb-top");
    const back = h("button", "cb-back");
    back.id = "cb-close";
    back.type = "button";
    back.title = "Back to the editor (Esc)";
    back.append(svg([{ d: "M15 5l-7 7 7 7" }], "cb-icon"), "Back to the editor");
    back.addEventListener("click", close);
    const title = h("div", "cb-title");
    title.append(h("h2", undefined, "Clip board"), h("p", undefined, "A sample set of clips for a humanoid action character (an optional checklist: ignore it, or add your own required clips with Add slot). Click one to start animating it."));

    const prog = h("div", "cb-progress");
    const barEl = h("div", "cb-bar");
    barEl.setAttribute("role", "progressbar");
    barEl.setAttribute("aria-valuenow", String(sum.counts.done));
    barEl.setAttribute("aria-valuemax", String(sum.total));
    const seg = (cls: string, n: number) => {
      const s = h("span", cls);
      s.style.flexGrow = String(n);
      return s;
    };
    barEl.append(seg("done", sum.counts.done), seg("problem", sum.problems), seg("draft", sum.counts.draft), seg("rest", sum.counts.missing));
    const text = h("div", "cb-progress-text");
    text.id = "cb-progress-text";
    text.append(h("b", undefined, `${sum.counts.done} of ${sum.total} done`), ` ${sum.counts.draft} drafts, ${sum.counts.missing} missing${sum.problems ? `, ${sum.problems} need a look` : ""}`);
    prog.append(text, barEl);

    const filters = h("div", "seg pill cb-filters");
    filters.setAttribute("role", "group");
    for (const f of FILTERS) {
      const n = f.id === "all" ? sum.total : f.id === "problems" ? sum.problems : sum.counts[f.id];
      const b = h("button", `cb-filter${filter === f.id ? " on" : ""}`);
      b.type = "button";
      b.dataset.filter = f.id;
      b.title = f.id === "all" ? "Show every clip" : f.id === "problems" ? "Dim everything except clips that need a re-check or fail a check" : `Dim everything except ${f.label.toLowerCase()} clips`;
      b.append(f.label, h("span", "cb-n", String(n)));
      b.addEventListener("click", () => {
        filter = f.id;
        render();
      });
      filters.append(b);
    }
    const actions = h("div", "cb-actions");
    const addSlot = h("button", "cb-addslot-top");
    addSlot.type = "button";
    addSlot.id = "cb-add-slot";
    addSlot.title = "Add slot: add a new required clip (an emote, a combo step, a move) to the board. Saved in clips/board-config.json; removable.";
    addSlot.append(svg(PLUS, "cb-icon"), "Add slot");
    addSlot.addEventListener("click", () => addSlotDialog());
    const deleted = h("button", "cb-addslot-top");
    deleted.type = "button";
    deleted.id = "cb-deleted";
    deleted.title = "Recently deleted: restore a clip you deleted from its saved versions (the newest 50 of each clip are kept)";
    deleted.append("Recently deleted");
    deleted.addEventListener("click", () => void deletedClipsDialog(async () => { await refreshSaved(); }));
    actions.append(newClipButton("cb-new-clip"), addSlot, deleted);
    const right = h("div", "cb-right");
    right.append(actions, filters);
    top.append(back, title, prog, right);

    const body = h("div", "cb-body");
    body.append(renderMatrix(sum, names), renderLists(sum, names));

    const legend = h("div", "cb-legend");
    for (const s of ["missing", "draft", "done", "needs-recheck", "broken"] as const) {
      const item = h("span", "cb-key");
      item.append(statusShape(s), h("span", undefined, STATUS_LABEL[s]));
      item.title = `${STATUS_LABEL[s]}: ${STATUS_HELP[s]}`;
      legend.append(item);
    }
    legend.append(h("span", "cb-key note", "timing? = timing not in project yet"));
    if (notice) {
      const n = h("span", `cb-notice ${notice.kind}`, notice.text);
      n.id = "cb-notice";
      n.setAttribute("role", "status");
      legend.append(n);
    }
    root.replaceChildren(top, body, legend);
  }

  function open(): void {
    root.classList.remove("solo");
    root.hidden = false;
    document.body.classList.add("cb-open");
    notice = null;
    syncBanner();
    render();
    void loadBoard().then(() => {
      noteGates();
      if (!root.hidden) render();
    });
  }
  function close(): void {
    root.classList.remove("solo");
    root.hidden = true;
    document.body.classList.remove("cb-open");
    root.replaceChildren();
  }

  // Keys: the board swallows the editor's hotkeys while it is up; Esc closes the menu / dialog first, then the board.
  window.addEventListener(
    "keydown",
    (e) => {
      if (root.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const layer = root.querySelector(".cb-confirm-layer, .cb-menu");
        if (layer) layer.remove();
        else close();
      } else if (!["Tab", "Enter", " "].includes(e.key) && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLInputElement)) e.stopPropagation();
      else if (e.target instanceof HTMLInputElement && e.key !== "Enter" && e.key !== "Tab") e.stopPropagation();
    },
    true
  );
  root.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".cb-menu")) root.querySelector(".cb-menu")?.remove();
  });
  root.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("[data-clip]")) e.preventDefault();
  });

  setClipBoardOpener(open);
  return { open, close };
}
