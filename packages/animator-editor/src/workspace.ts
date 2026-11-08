/*
 * Atlas Animator editor: workspaces (the design notes, section 1).
 *
 * A workspace is only a filter over the editor that already exists: a body class (`ws-home`, `ws-animate`, `ws-swag`, `ws-rig`,
 * `ws-ship`, `ws-pro`), an allowed-tabs list handed to chrome.ts, and which header groups show. Pro is the full layout. The Rig
 * workspace is Setup mode with the Rig and Skins tabs. The last workspace used is remembered; the editor opens on Home.
 */
import type { Chrome } from "./chrome.js";
import type { TabId } from "./tooltips.js";
import { buildShip } from "./ship.js";

export const WORKSPACE_IDS = ["home", "animate", "swag", "rig", "ship", "pro"] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];
export type WorkWorkspaceId = Exclude<WorkspaceId, "home">;

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  /** Right-panel tabs this workspace shows (null = all of them). */
  tabs: readonly TabId[] | null;
}

export const WORKSPACES: readonly WorkspaceDef[] = [
  { id: "home", label: "Home", tabs: null },
  { id: "animate", label: "Animate", tabs: ["pose", "keys", "library"] },
  { id: "swag", label: "Swag", tabs: ["preview"] },
  { id: "rig", label: "Rig", tabs: ["rig", "skins"] },
  { id: "ship", label: "Ship", tabs: ["export"] },
  { id: "pro", label: "Pro", tabs: null }
];

export function parseWorkspace(v: unknown): WorkspaceId | null {
  return WORKSPACE_IDS.find((id) => id === v) ?? null;
}

export function allowedTabs(id: WorkspaceId): readonly TabId[] | null {
  return WORKSPACES.find((w) => w.id === id)?.tabs ?? null;
}

/** Whether an element tagged `data-ws="animate pro"` shows in this workspace. */
export function shownIn(tag: string, id: WorkspaceId): boolean {
  return tag.split(/\s+/).includes(id);
}

/** Keys the Home layer leaves to the editor: the command palette (Ctrl+K), the cheat sheet (F1, ?) and the Alt+1..6 workspace jumps. */
export function homeKeepsKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") return true;
  if (e.key === "F1" || (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey)) return true;
  return e.altKey && !e.ctrlKey && !e.metaKey && /^[1-6]$/.test(e.key);
}

/** Plain H goes Home only where Hand IK (H) has no use; Shift+H goes Home everywhere. */
export function homeKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, ws: WorkspaceId): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "h" || ws === "home") return false;
  return e.shiftKey || ws === "swag" || ws === "rig" || ws === "ship";
}

const WS_KEY = "atlas-editor-ws";

export function readLastWorkspace(): WorkWorkspaceId | null {
  try {
    const v = parseWorkspace(localStorage.getItem(WS_KEY));
    return v && v !== "home" ? v : null;
  } catch {
    return null; // storage can be unavailable
  }
}

function remember(id: WorkWorkspaceId): void {
  try {
    localStorage.setItem(WS_KEY, id);
  } catch {
    // not remembered; the workspace still switches
  }
}

export interface Workspaces {
  current(): WorkspaceId;
  go(id: WorkspaceId): void;
  onChange(fn: (id: WorkspaceId, from: WorkspaceId | null) => void): void;
}

const $ = (id: string) => document.getElementById(id)!;

/** Wires the workspace bar, body classes, tabs and keys. `start` is the workspace to open on (Home by default). */
export function createWorkspaces(chrome: Chrome, start: WorkspaceId = "home"): Workspaces {
  let current: WorkspaceId | null = null;
  const listeners: ((id: WorkspaceId, from: WorkspaceId | null) => void)[] = [];
  const bar = $("wsbar");
  const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;

  // The Ship screen covers the whole work area (left, view, right, timeline), not just the canvas.
  document.getElementById("app")?.append($("soon"));

  for (const w of WORKSPACES) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.go = w.id;
    b.id = `ws-${w.id}`;
    b.setAttribute("role", "tab");
    b.textContent = w.label;
    b.addEventListener("click", () => go(w.id));
    bar.append(b);
  }

  let shipCleanup: (() => void) | null = null;
  /** The Ship screen (ship.ts): Check, Apply, Publish, then Also (Export Spine, Download, Render sheets). */
  function renderShip(id: WorkspaceId): void {
    const host = $("soon");
    host.hidden = id !== "ship";
    shipCleanup?.();
    shipCleanup = null;
    host.replaceChildren();
    if (id === "ship") shipCleanup = buildShip(host, go);
  }

  function go(id: WorkspaceId): void {
    if (id === current) return;
    const from = current;
    current = id;
    const body = document.body;
    for (const w of WORKSPACE_IDS) body.classList.toggle(`ws-${w}`, w === id);
    for (const b of bar.querySelectorAll<HTMLElement>("button")) {
      const on = b.dataset.go === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const e of document.querySelectorAll<HTMLElement>("[data-ws]")) e.hidden = !shownIn(e.dataset.ws ?? "", id);
    chrome.setAllowed(allowedTabs(id));
    // The Rig workspace is Setup mode; the task workspaces are Animate mode (Pro and Home leave the mode as it is).
    const wantSetup = id === "rig" ? true : id === "home" || id === "pro" ? null : false;
    if (wantSetup !== null && body.classList.contains("setup") !== wantSetup) {
      document.querySelector<HTMLElement>(`#modeseg [data-mode=${wantSetup ? "setup" : "animate"}]`)?.click();
    }
    $("home").hidden = id !== "home";
    renderShip(id);
    if (id !== "home") remember(id);
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const fn of listeners) fn(id, from);
  }

  chrome.onBlockedReveal(() => go("pro"));
  $("logo").addEventListener("click", () => go("home"));

  // Keys: Home swallows the editor's hotkeys (the editor behind it must not react); H / Shift+H go Home.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!current || typing(e.target)) return;
      if (homeKey(e, current)) {
        e.preventDefault();
        e.stopPropagation();
        go("home");
      } else if (current === "home" && !["Tab", "Enter", " "].includes(e.key) && !homeKeepsKey(e)) {
        e.stopPropagation();
      } else if (current === "home" && e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // The Home layer sits under the header, whatever height the header wraps to.
  const header = document.querySelector("header");
  const syncHeader = () => document.documentElement.style.setProperty("--hdr", `${header?.getBoundingClientRect().height ?? 44}px`);
  if (header && typeof ResizeObserver !== "undefined") new ResizeObserver(syncHeader).observe(header);
  syncHeader();

  go(start);
  return {
    current: () => current ?? start,
    go,
    onChange: (fn) => void listeners.push(fn)
  };
}
