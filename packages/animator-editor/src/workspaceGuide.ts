/*
 * Atlas Animator editor: discoverability.
 *
 * One table of "the keys you use most" per workspace, drawn from the hotkey table (hotkeys.ts) so it cannot drift from the cheat sheet. It
 * feeds three things: the first-run card (shown once per workspace, remembered), the top section of the "?" sheet, and the Alt+1..6
 * workspace keys. The empty-state card on the Animate canvas (no clip open) also lives here. The pure rules are exported and unit tested.
 */
import { HOTKEYS, type HotkeyAction } from "./hotkeys.js";
import { getHost, whenHost } from "./host.js";
import { WORKSPACES, type WorkspaceId, type Workspaces } from "./workspace.js";

export interface GuideKey {
  keys: string;
  label: string;
}

export interface WorkspaceGuide {
  title: string;
  blurb: string;
  /** A hotkey-table action (its keys and label are looked up) or a fixed pair for keys outside the table. */
  keys: readonly (HotkeyAction | GuideKey)[];
}

const SHORT: Partial<Record<HotkeyAction, string>> = {
  rotate: "Rotate tool",
  move: "Move tool",
  ik: "Hand IK tool",
  key: "Key the selected bones",
  mirror: "Mirror the pose to the other side",
  breakdown: "Breakdown between two keys",
  undo: "Undo",
  play: "Play / pause",
  autoKey: "Auto key on / off",
  prevKey: "Previous key",
  nextKey: "Next key",
  nudgeKeysForward: "Nudge selected keys later",
  fitAll: "Fit the whole character",
  frameSelection: "Frame the selected bones",
  bonesOverlay: "Show / hide bones",
  boneView: "Cycle the bone overlay",
  graph: "Graph editor",
  gameView: "Game view",
  save: "Save",
  help: "All keys",
  home: "Back to Home",
  prevPose: "Previous pose",
  nextPose: "Next pose",
  facingRight: "Preview facing right",
  phoneSize: "Phone size on / off",
  weightsTool: "Weights tool",
  copy: "Copy pose",
  paste: "Paste pose"
};

export const GUIDES: Record<WorkspaceId, WorkspaceGuide> = {
  home: {
    title: "Home",
    blurb: "Pick a job; each one shows only the tools it needs.",
    keys: [{ keys: "Alt+1 to Alt+6", label: "Jump to a workspace" }, "help", "home"]
  },
  animate: {
    title: "Animate",
    blurb: "Pose the player and key it. Auto key is on, so a move on a bone keys it.",
    keys: ["key", "play", "prevKey", "nextKey", "mirror", "breakdown", "undo", "fitAll", "gameView", { keys: "Alt+Up / Alt+Down", label: "Taller / shorter timeline" }]
  },
  swag: {
    title: "Swag",
    blurb: "Wear an item and judge it on every pose.",
    keys: ["prevPose", "nextPose", "play", "facingRight", "phoneSize", "fitAll", "home"]
  },
  rig: {
    title: "Rig",
    blurb: "Build bones, slots and skins. Edits go to the rig, not to a clip.",
    keys: [{ keys: "V B T A M W", label: "Select, Create bone, Transform, Image, Mesh, Weights" }, "frameSelection", "fitAll", "undo", "save", "home"]
  },
  ship: {
    title: "Ship",
    blurb: "Check the board, then send the clips to your project.",
    keys: ["save", "home", "help"]
  },
  pro: {
    title: "Pro",
    blurb: "Every tab and tool in one place.",
    keys: ["rotate", "move", "ik", "key", "mirror", "graph", "boneView", "copy", "paste", "undo", "save"]
  }
};

/** The keys to show for a workspace, with the labels short enough for a small card. */
export function guideKeys(id: WorkspaceId): GuideKey[] {
  return GUIDES[id].keys.map((k) => {
    if (typeof k !== "string") return k;
    const def = HOTKEYS.find((h) => h.action === k);
    return { keys: def?.keys.split(" / ")[0] ?? k, label: SHORT[k] ?? def?.label ?? k };
  });
}

/** Alt+1 .. Alt+6 pick a workspace in bar order; null for anything else. */
export function workspaceForKey(e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): WorkspaceId | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null);
  if (!digit) return null;
  return WORKSPACES[Number(digit) - 1]?.id ?? null;
}

const SEEN_KEY = "atlas-editor-guide-seen";

export function parseSeen(raw: string | null): WorkspaceId[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is WorkspaceId => typeof x === "string" && x in GUIDES) : [];
  } catch {
    return [];
  }
}

/** The first-run card shows once per work workspace (never on Home, which explains itself). */
export function needsFirstRun(seen: readonly WorkspaceId[], id: WorkspaceId): boolean {
  return id !== "home" && !seen.includes(id);
}

/** Whether the Animate canvas shows its empty-state card: Animate, no clip open. */
export function showAnimateEmpty(ws: WorkspaceId, clipName: string | undefined | null, setup: boolean): boolean {
  return ws === "animate" && !setup && !clipName;
}

function readSeen(): WorkspaceId[] {
  try {
    return parseSeen(localStorage.getItem(SEEN_KEY));
  } catch {
    return [];
  }
}

function writeSeen(list: readonly WorkspaceId[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {
    // not remembered: the card shows again next time
  }
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The "keys for this workspace" block, used by the first-run card and the top of the "?" sheet. */
export function guideBlock(id: WorkspaceId, cls: string): HTMLElement {
  const g = GUIDES[id];
  const box = h("section", cls);
  box.append(h("h3", "wg-title", `${g.title}: the keys you use most`), h("p", "wg-blurb", g.blurb));
  const list = h("div", "wg-keys");
  for (const k of guideKeys(id)) list.append(h("kbd", undefined, k.keys), h("span", undefined, k.label));
  box.append(list);
  return box;
}

export interface GuideApi {
  /** Shows the first-run card for a workspace now (also what a script calls). */
  show(id?: WorkspaceId): void;
  hide(): void;
}

/** Wires the first-run card, the Animate empty state and the Alt+1..6 keys. */
export function installWorkspaceGuide(ws: Workspaces, openHelp: () => void): GuideApi {
  const view = document.getElementById("view")!;
  let seen = readSeen();
  let card: HTMLElement | null = null;

  const hide = () => {
    card?.remove();
    card = null;
  };
  const show = (id: WorkspaceId = ws.current()) => {
    hide();
    card = h("aside", "wg-card");
    card.id = "wg-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", `${GUIDES[id].title}: key shortcuts`);
    card.append(guideBlock(id, "wg-sec"));
    const row = h("div", "wg-actions");
    const ok = h("button", "btn btn-primary sm", "Got it");
    ok.type = "button";
    ok.id = "wg-ok";
    ok.title = "Close this card; it will not come back for this workspace (the ? sheet lists every key)";
    ok.addEventListener("click", () => {
      if (!seen.includes(id)) {
        seen = [...seen, id];
        writeSeen(seen);
      }
      hide();
    });
    const all = h("button", "btn sm", "All keys");
    all.type = "button";
    all.id = "wg-all";
    all.title = "Open the full cheat sheet (?)";
    all.addEventListener("click", () => {
      ok.click();
      openHelp();
    });
    row.append(all, ok);
    card.append(row);
    document.body.append(card);
    ok.focus({ preventScroll: true });
  };

  // Empty state on the Animate canvas: no clip is open, so say what to do next.
  const empty = h("div", "wg-empty");
  empty.id = "animempty";
  empty.hidden = true;
  empty.append(h("h3", undefined, "No clip open"), h("p", undefined, "Pick a project clip from the Clip board, then pose the player and press K to key it."));
  const board = h("button", "btn btn-primary", "Open the Clip board");
  board.type = "button";
  board.id = "animempty-board";
  board.title = "Open the sample clip list and pick a clip";
  board.addEventListener("click", () => document.getElementById("clips-open")?.click());
  empty.append(board);
  view.append(empty);
  const syncEmpty = () => {
    empty.hidden = !showAnimateEmpty(ws.current(), getHost()?.clipName, document.body.classList.contains("setup"));
  };
  whenHost((host) => {
    host.on("clip", syncEmpty);
    syncEmpty();
  });

  ws.onChange((id) => {
    hide();
    syncEmpty();
    // Not under automation: scripted runs click straight through, and a floating card would sit on their targets.
    if (!navigator.webdriver && needsFirstRun(seen, id)) window.setTimeout(() => ws.current() === id && show(id), 600);
  });
  syncEmpty();

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && card) {
        hide();
        return;
      }
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      const id = workspaceForKey(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      ws.go(id);
    },
    true
  );
  return { show, hide };
}
