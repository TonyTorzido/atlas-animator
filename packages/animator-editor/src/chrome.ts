/*
 * Atlas Animator editor: original implementation.
 *
 * The editor's frame: the right panel's tabs (the last tab is remembered) and the status bar (tool, selection, frame, save state).
 * Layout only; the panels themselves are built by main.ts and keep their ids.
 */

import { TABS, type TabId } from "./tooltips.js";
import { initDataPanel } from "./dataPanel.js";
import { ensureSprite } from "./icons.js";
import { tidyRightPanel } from "./rightPanelTidy.js";

const TAB_KEY = "atlas-editor-tab";

export type SaveState = "saved" | "unsaved" | "autosaving";

export interface StatusInfo {
  /** "Rotate", "Hand IK", "Setup: Create bone" ... */
  tool: string;
  /** Extra switches worth seeing at a glance ("Compensate", "Auto key"). */
  flags: string[];
  active: string | null;
  names: string[];
  clip: string;
  frame: number;
  frames: number;
  time: number;
  /** Clip fps, length in seconds and loop flag (shown after the frame, in the status bar). */
  fps?: number;
  duration?: number;
  loop?: boolean;
  save: SaveState;
}

/** "Bone: hand_l", "3 bones: hand_l + 2", "No bone selected". */
export function selectionText(active: string | null, names: readonly string[]): string {
  if (!names.length && !active) return "No bone selected";
  if (names.length <= 1) return `Bone: ${active ?? names[0]}`;
  const rest = names.length - 1;
  return `${names.length} bones: ${active ?? names[0]} + ${rest}`;
}

export function saveText(state: SaveState): string {
  return state === "autosaving" ? "Autosaving" : state === "unsaved" ? "Unsaved" : "Saved";
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Fills a collapsed-panel rail: a chevron drawn as SVG (pointing the way the panel opens) and the label running down the side. */
export function fillRail(btn: HTMLElement, label: string, dir: "left" | "right"): void {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", dir === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  const text = document.createElement("span");
  text.className = "rail-label";
  text.textContent = label;
  btn.replaceChildren(svg, text);
}

function readTab(): TabId {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (TABS.some((t) => t.id === v)) return v as TabId;
  } catch {
    // storage can be unavailable; the first tab opens
  }
  return TABS[0].id;
}

export interface Chrome {
  showTab(id: TabId): void;
  currentTab(): TabId;
  /** Opens the tab that holds the element (a selector or the element); a no-op for an element outside the tabs. */
  reveal(target: string | Element): boolean;
  /** Redraws the status bar from `getInfo()`. */
  refresh(): void;
  /** Limits the tab bar to these tabs (null = all of them) and moves to the first allowed one if the open tab is now hidden. */
  setAllowed(ids: readonly TabId[] | null): void;
  /** What `reveal` does for a control whose tab the workspace hides: the workspace code switches to Pro here. */
  onBlockedReveal(fn: () => void): void;
}

/** Builds the tab bar in #tabs (the panes are already in index.html) and wires the status bar. */
export function createChrome(getInfo: () => StatusInfo): Chrome {
  const bar = byId("tabs")!;
  const panes = [...document.querySelectorAll<HTMLElement>("#panes > .pane")];
  let current: TabId = readTab();
  let beforeSetup: TabId | null = null;
  let allowed: ReadonlySet<TabId> | null = null;
  let blockedReveal: (() => void) | null = null;
  const inSetup = () => document.body.classList.contains("setup");
  /** Setup mode limits the bar to Rig, except in the Rig workspace, which lists its own tabs (Rig + Skins). */
  const setupLimits = () => inSetup() && !document.body.classList.contains("ws-rig");
  const tabShown = (id: TabId) => (allowed === null || allowed.has(id) || (inSetup() && id === "rig")) && (!setupLimits() || id === "rig" || id === "skins");
  const firstShown = (): TabId => TABS.find((t) => tabShown(t.id))?.id ?? TABS[0].id;
  function applyAllowed(): void {
    for (const b of bar.querySelectorAll<HTMLElement>("button")) b.hidden = !tabShown(b.dataset.tab as TabId);
  }

  for (const t of TABS) {
    const b = document.createElement("button");
    b.dataset.tab = t.id;
    b.id = `tab-${t.id}`;
    b.setAttribute("role", "tab");
    if ("short" in t) {
      // Narrow windows show the short name; both are in the button so the label never needs a font-size trick.
      const full = document.createElement("span");
      full.className = "tab-full";
      full.textContent = t.label;
      const short = document.createElement("span");
      short.className = "tab-short";
      short.textContent = t.short;
      short.setAttribute("aria-hidden", "true");
      b.append(full, short);
      b.setAttribute("aria-label", t.label);
    } else b.textContent = t.label;
    b.title = `${t.label} tab: ${t.tip}`;
    b.addEventListener("click", () => showTab(t.id));
    bar.append(b);
  }

  function showTab(want: TabId): void {
    const id = tabShown(want) ? want : firstShown();
    current = id;
    for (const b of bar.querySelectorAll<HTMLElement>("button")) {
      const on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const p of panes) p.classList.toggle("active", p.dataset.tab === id);
    // The right rail names the tab it will open.
    const rail = byId("right-open");
    if (rail) fillRail(rail, TABS.find((t) => t.id === id)?.label ?? "Panel", "left");
    // Setup mode shows only the Rig tab; do not remember that as the user's choice.
    if (inSetup() || allowed !== null) return;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // not remembered; the tab still switches
    }
  }

  // Setup mode owns the right panel: open Rig, and put the user's tab back afterwards.
  const syncSetup = () => {
    const on = inSetup();
    applyAllowed();
    if (on && beforeSetup === null) {
      beforeSetup = current;
      showTab("rig");
    } else if (!on && beforeSetup !== null) {
      const back = beforeSetup;
      beforeSetup = null;
      showTab(back);
    }
    refresh();
  };
  new MutationObserver(syncSetup).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const hud = byId("setuphud");
  if (hud) new MutationObserver(() => refresh()).observe(hud, { attributes: true, subtree: true, attributeFilter: ["class"] });

  function reveal(target: string | Element): boolean {
    const node = typeof target === "string" ? document.querySelector(target) : target;
    const pane = node?.closest<HTMLElement>(".pane");
    if (!pane?.dataset.tab) return false;
    const id = pane.dataset.tab as TabId;
    if (setupLimits() && id !== "rig" && id !== "skins") return false;
    if (!tabShown(id)) blockedReveal?.();
    document.getElementById("app")?.classList.remove("rcol");
    showTab(id);
    return true;
  }

  const sbTool = byId("sb-tool");
  const sbSel = byId("sb-sel");
  const sbFrame = byId("sb-frame");
  const sbSave = byId("sb-save");
  sbSave?.addEventListener("click", () => {
    if (sbSave.dataset.state === "unsaved") byId("save")?.click();
  });

  function refresh(): void {
    const i = getInfo();
    if (sbTool) {
      sbTool.replaceChildren();
      const label = document.createElement("span");
      label.className = "dim";
      label.textContent = "Tool";
      const name = document.createElement("b");
      name.textContent = i.tool;
      sbTool.append(label, name);
      for (const f of i.flags) {
        const chip = document.createElement("span");
        chip.className = "dim";
        chip.textContent = f;
        sbTool.append(chip);
      }
    }
    if (sbSel) {
      sbSel.textContent = selectionText(i.active, i.names);
      // The breadcrumb next to it names a single selected bone: do not say it twice.
      const crumb = byId("bonecrumb");
      sbSel.hidden = !!i.active && i.names.length <= 1 && !!crumb && crumb.style.display !== "none" && getComputedStyle(crumb).display !== "none";
    }
    if (sbFrame) {
      // Setup (the Rig workspace, Pro Setup mode) edits the rig, not a clip: no frame / fps readout there.
      const inSetupNow = document.body.classList.contains("setup");
      // The frame / length / fps readout lives in the transport only (GL-16).
      sbFrame.textContent = i.clip;
      void inSetupNow;
    }
    if (sbSave) {
      sbSave.dataset.state = i.save;
      sbSave.replaceChildren();
      const dot = document.createElement("span");
      dot.className = "dot";
      sbSave.append(dot, saveText(i.save));
      sbSave.title = i.save === "unsaved" ? "Unsaved changes: click to save (Ctrl+S)" : i.save === "autosaving" ? "Autosaving the clip" : "Everything is saved";
    }
  }

  function setAllowed(ids: readonly TabId[] | null): void {
    allowed = ids ? new Set(ids) : null;
    applyAllowed();
    showTab(tabShown(current) ? current : firstShown());
  }

  const leftRail = byId("left-open");
  if (leftRail) fillRail(leftRail, "Bones", "right");
  showTab(current);
  ensureSprite();
  initDataPanel();
  tidyRightPanel();
  return { showTab, currentTab: () => current, reveal, refresh, setAllowed, onBlockedReveal: (fn) => void (blockedReveal = fn) };
}
