/*
 * Atlas Animator editor: the canvas-first layout state. The left bone list and the right panel each collapse to a thin rail (the
 * choice is remembered), the Animate workspace starts with the bone list open (the Tree, ), and the one-line canvas tip can be hidden for good (the ? keys sheet brings it back).
 * The pure rules are exported and unit tested; the DOM wiring is installLayout.
 */
import type { Workspaces, WorkspaceId } from "./workspace.js";

export type Side = "left" | "right";
export type PanelChoices = Partial<Record<Side, boolean>>;

/** Windows narrower than this start Animate with the phone dock on its rail (the bone list is open at every width now). */
export const WIDE_WINDOW = 1800;
const PANELS_KEY = "atlas-editor-panels";
const TIP_KEY = "atlas-editor-tip-hidden";

/** Whether a side panel starts collapsed (before the person has made a choice). */
export function defaultCollapsed(_side: Side, _ws: WorkspaceId, _width: number): boolean {
  // Animate opens with the Tree beside the canvas (): there is always a selection context. The choice is still remembered.
  return false;
}

/** The collapsed state to show: the person's remembered choice, else the default. */
export function collapsedFor(side: Side, ws: WorkspaceId, width: number, choices: PanelChoices): boolean {
  if (side === "left" && ws === "swag") return false; // the workshop lives in the left column
  if (side === "right" && ws === "swag") return true; // the preview groups (game view, onion, compare) are in the Overlays popover (Batch 8b)
  return choices[side] ?? defaultCollapsed(side, ws, width);
}

export function readPanelChoices(): PanelChoices {
  try {
    const v = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "{}") as Record<string, unknown>;
    return { ...(typeof v.left === "boolean" ? { left: v.left } : {}), ...(typeof v.right === "boolean" ? { right: v.right } : {}) };
  } catch {
    return {}; // storage can be unavailable
  }
}

function writePanelChoices(c: PanelChoices): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(c));
  } catch {
    // not remembered; the panel still collapses
  }
}

export function tipHidden(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return false;
  }
}

/** Hides or shows the one-line canvas tip, and remembers it. */
export function setTipHidden(hidden: boolean): void {
  document.body.classList.toggle("tip-off", hidden);
  try {
    if (hidden) localStorage.setItem(TIP_KEY, "1");
    else localStorage.removeItem(TIP_KEY);
  } catch {
    // not remembered; the tip still hides for this session
  }
}

export function installLayout(ws: Workspaces): void {
  const app = document.getElementById("app");
  if (!app) return;
  const choices = readPanelChoices();
  const apply = () => {
    app.classList.toggle("lcol", collapsedFor("left", ws.current(), window.innerWidth, choices));
    app.classList.toggle("rcol", collapsedFor("right", ws.current(), window.innerWidth, choices));
  };
  const choose = (side: Side, collapsed: boolean) => {
    choices[side] = collapsed;
    writePanelChoices(choices);
    apply();
  };
  document.getElementById("left-collapse")?.addEventListener("click", () => choose("left", true));
  document.getElementById("left-open")?.addEventListener("click", () => choose("left", false));
  document.getElementById("right-collapse")?.addEventListener("click", () => choose("right", true));
  document.getElementById("right-open")?.addEventListener("click", () => choose("right", false));
  ws.onChange(apply);
  window.addEventListener("resize", apply);
  apply();

  setTipHidden(tipHidden());
  document.getElementById("tipdismiss")?.addEventListener("click", () => setTipHidden(true));
}

/** Opens the right panel when a script or the app needs a control that lives in it. */
export function expandRight(): void {
  document.getElementById("app")?.classList.remove("rcol");
}
