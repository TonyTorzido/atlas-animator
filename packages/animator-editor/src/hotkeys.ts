/*
 * Atlas Animator editor: original implementation.
 *
 * The editor's keyboard map: one table drives the key handler and the "?" cheat sheet, so they cannot drift apart.
 */

import { chordMatches, chordsOfText, formatChord, type Bindings } from "./keymapModel.js";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export type HotkeyAction =
  | "rotate"
  | "move"
  | "scale"
  | "ik"
  | "shapeKeys"
  | "weightsTool"
  | "key"
  | "deleteKey"
  | "mirror"
  | "flipPose"
  | "breakdown"
  | "undo"
  | "redo"
  | "play"
  | "prevFrame"
  | "nextFrame"
  | "prevFrame5"
  | "nextFrame5"
  | "prevKey"
  | "nextKey"
  | "nudgeKeysBack"
  | "nudgeKeysForward"
  | "nudgeKeysBack5"
  | "nudgeKeysForward5"
  | "firstFrame"
  | "lastFrame"
  | "selectRoot"
  | "frameSelection"
  | "fitAll"
  | "save"
  | "copy"
  | "paste"
  | "selectAllKeys"
  | "selectAllBones"
  | "clearSelection"
  | "rangeIn"
  | "rangeOut"
  | "autoKey"
  | "compensate"
  | "bonesOverlay"
  | "boneView"
  | "phoneSize"
  | "facingRight"
  | "prevPose"
  | "nextPose"
  | "graph"
  | "gameView"
  | "home"
  | "palette"
  | "pinPose"
  | "unpinPose"
  | "ghostPose"
  | "swapPose"
  | "onion"
  | "onionStyle"
  | "gateHud"
  | "help";

export interface HotkeyDef {
  action: HotkeyAction;
  /** What the cheat sheet shows. */
  keys: string;
  label: string;
  group: "Tools" | "Keys" | "Timeline" | "View" | "Selection" | "File";
  /** Matches a key press (see `hotkeyAction`). */
  match: (e: Required<KeyLike>) => boolean;
}

const lower = (e: KeyLike) => e.key.toLowerCase();
const plain = (e: Required<KeyLike>, k: string) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && lower(e) === k;
const mod = (e: Required<KeyLike>, k: string, shift = false) => (e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey === shift && lower(e) === k;
const bare = (e: Required<KeyLike>) => !e.ctrlKey && !e.metaKey && !e.altKey;
const altArrow = (e: Required<KeyLike>, key: string, shift: boolean) => e.altKey && !e.ctrlKey && !e.metaKey && e.shiftKey === shift && e.key === key;

export const HOTKEYS: readonly HotkeyDef[] = [
  { action: "rotate", keys: "R", label: "Rotate tool", group: "Tools", match: (e) => plain(e, "r") },
  { action: "move", keys: "T", label: "Translate (move) tool", group: "Tools", match: (e) => plain(e, "t") },
  { action: "scale", keys: "S", label: "Scale tool (squash and stretch the selected bone)", group: "Tools", match: (e) => plain(e, "s") },
  { action: "ik", keys: "H", label: "Hand IK tool", group: "Tools", match: (e) => plain(e, "h") },
  { action: "shapeKeys", keys: "D", label: "Shape keys tool (Animate): deform mesh vertices on this frame. In Setup, M is the Mesh tool", group: "Tools", match: (e) => plain(e, "d") },
  { action: "weightsTool", keys: "W", label: "Weights tool (switches to Setup mode and paints mesh weights)", group: "Tools", match: (e) => plain(e, "w") },
  { action: "compensate", keys: "C", label: "Compensate on / off (children stay put)", group: "Tools", match: (e) => plain(e, "c") },
  { action: "autoKey", keys: "A", label: "Auto key on / off", group: "Tools", match: (e) => plain(e, "a") },
  { action: "key", keys: "K", label: "Key selected bones: every changed channel (or rotate) at the playhead", group: "Keys", match: (e) => plain(e, "k") },
  { action: "deleteKey", keys: "Delete", label: "Delete the selected bones' keys here (or the selected dopesheet keys)", group: "Keys", match: (e) => bare(e) && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace") },
  { action: "mirror", keys: "M", label: "Mirror the selected bones onto their other side (near to far, or far to near); keys them", group: "Keys", match: (e) => plain(e, "m") },
  { action: "flipPose", keys: "Shift+M", label: "Flip the whole pose: swap near and far, mirror spine and head; keys it", group: "Keys", match: (e) => bare(e) && e.shiftKey && lower(e) === "m" },
  { action: "breakdown", keys: "N", label: "Breakdown: key the selected bones at the slider's % between their previous and next keys", group: "Keys", match: (e) => plain(e, "n") },
  { action: "copy", keys: "Ctrl+C", label: "Copy pose (or the selected keys)", group: "Keys", match: (e) => mod(e, "c") },
  { action: "paste", keys: "Ctrl+V", label: "Paste pose (or keys) at the playhead", group: "Keys", match: (e) => mod(e, "v") },
  { action: "undo", keys: "Ctrl+Z", label: "Undo", group: "Keys", match: (e) => mod(e, "z") },
  { action: "redo", keys: "Ctrl+Y / Ctrl+Shift+Z", label: "Redo", group: "Keys", match: (e) => mod(e, "y") || mod(e, "z", true) },
  { action: "play", keys: "Space", label: "Play / pause (a tap; Space + drag pans)", group: "Timeline", match: () => false },
  { action: "prevFrame", keys: "Left", label: "Previous frame", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "ArrowLeft" },
  { action: "nextFrame", keys: "Right", label: "Next frame", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "ArrowRight" },
  { action: "prevFrame5", keys: "Shift+Left", label: "Back 5 frames", group: "Timeline", match: (e) => bare(e) && e.shiftKey && e.key === "ArrowLeft" },
  { action: "nextFrame5", keys: "Shift+Right", label: "Forward 5 frames", group: "Timeline", match: (e) => bare(e) && e.shiftKey && e.key === "ArrowRight" },
  { action: "prevKey", keys: "Up", label: "Previous key of the selected bone", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "ArrowUp" },
  { action: "nextKey", keys: "Down", label: "Next key of the selected bone", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "ArrowDown" },
  { action: "nudgeKeysBack", keys: ", / Alt+Left", label: "Nudge the selected dopesheet keys 1 frame earlier", group: "Timeline", match: (e) => plain(e, ",") || altArrow(e, "ArrowLeft", false) },
  { action: "nudgeKeysForward", keys: ". / Alt+Right", label: "Nudge the selected dopesheet keys 1 frame later", group: "Timeline", match: (e) => plain(e, ".") || altArrow(e, "ArrowRight", false) },
  { action: "nudgeKeysBack5", keys: "Shift+, / Alt+Shift+Left", label: "Nudge the selected keys 5 frames earlier", group: "Timeline", match: (e) => (bare(e) && e.shiftKey && (e.key === "<" || e.key === ",")) || altArrow(e, "ArrowLeft", true) },
  { action: "nudgeKeysForward5", keys: "Shift+. / Alt+Shift+Right", label: "Nudge the selected keys 5 frames later", group: "Timeline", match: (e) => (bare(e) && e.shiftKey && (e.key === ">" || e.key === ".")) || altArrow(e, "ArrowRight", true) },
  { action: "firstFrame", keys: "Home", label: "First frame", group: "Timeline", match: (e) => bare(e) && e.key === "Home" },
  { action: "lastFrame", keys: "End", label: "Last frame", group: "Timeline", match: (e) => bare(e) && e.key === "End" },
  { action: "rangeIn", keys: "I", label: "Play range starts here", group: "Timeline", match: (e) => plain(e, "i") },
  { action: "rangeOut", keys: "O", label: "Play range ends here", group: "Timeline", match: (e) => plain(e, "o") },
  { action: "selectRoot", keys: "Shift+R", label: "Select the root (master) bone: moving, rotating or scaling it moves the whole character", group: "Selection", match: (e) => bare(e) && e.shiftKey && lower(e) === "r" },
  { action: "frameSelection", keys: "F", label: "Frame the selected bones (everything when none)", group: "View", match: (e) => plain(e, "f") },
  { action: "fitAll", keys: "Shift+F", label: "Fit the whole character", group: "View", match: (e) => bare(e) && e.shiftKey && lower(e) === "f" },
  { action: "bonesOverlay", keys: "B", label: "Show / hide the bone overlay", group: "View", match: (e) => plain(e, "b") },
  { action: "boneView", keys: "Shift+B", label: "Cycle the bone overlay: all bones, dimmed, selected chain only, hidden (remembered per workspace)", group: "View", match: (e) => bare(e) && e.shiftKey && lower(e) === "b" },
  { action: "phoneSize", keys: "P", label: "Phone size on / off: the character at the size a phone shows it (0.42 zoom); off fits the view", group: "View", match: (e) => plain(e, "p") },
  { action: "facingRight", keys: "X", label: "Preview facing right on / off (the mirror, look-only)", group: "View", match: (e) => plain(e, "x") },
  { action: "prevPose", keys: "[", label: "Previous pose: jump to the previous key of any bone (Swag: step through poses)", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "[" },
  { action: "nextPose", keys: "]", label: "Next pose: jump to the next key of any bone (Swag: step through poses)", group: "Timeline", match: (e) => bare(e) && !e.shiftKey && e.key === "]" },
  { action: "pinPose", keys: "Q", label: "Pin the current pose as A (any frame or clip) to compare against", group: "View", match: (e) => plain(e, "q") },
  { action: "unpinPose", keys: "Shift+Q", label: "Clear pinned pose A", group: "View", match: (e) => bare(e) && e.shiftKey && lower(e) === "q" },
  { action: "ghostPose", keys: "E", label: "Show / hide pinned pose A as a ghost over the live pose", group: "View", match: (e) => plain(e, "e") },
  { action: "swapPose", keys: "\\", label: "Swap A and B: show pinned pose A in place of the live pose B, press again to come back", group: "View", match: (e) => plain(e, "\\") },
  { action: "onion", keys: "Alt+O", label: "Onion skin on / off: cool ghosts before the frame, warm ghosts after (set the counts, keys-only and outline in Preview)", group: "View", match: (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && lower(e) === "o" },
  { action: "onionStyle", keys: "Alt+Shift+O", label: "Onion skin style: tinted ghosts or outline-only (silhouette edge)", group: "View", match: (e) => e.altKey && !e.ctrlKey && !e.metaKey && e.shiftKey && lower(e) === "o" },
  { action: "gateHud", keys: "Alt+G", label: "Live gate HUD on / off: outline, pose rules and IK reach, checked as you scrub and play", group: "View", match: (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && lower(e) === "g" },
  { action: "graph", keys: "G", label: "Show / hide the graph editor", group: "View", match: (e) => plain(e, "g") },
  { action: "gameView", keys: "V", label: "Show / hide the project view (the clip as the runtime draws it)", group: "View", match: (e) => plain(e, "v") },
  { action: "selectAllBones", keys: "Ctrl+Shift+A", label: "Select every bone", group: "Selection", match: (e) => mod(e, "a", true) },
  { action: "selectAllKeys", keys: "Ctrl+A", label: "Select every dopesheet key", group: "Selection", match: (e) => mod(e, "a") },
  { action: "clearSelection", keys: "Esc", label: "Clear the key selection, then the bone selection", group: "Selection", match: (e) => e.key === "Escape" },
  { action: "save", keys: "Ctrl+S", label: "Save the clip", group: "File", match: (e) => mod(e, "s") },
  { action: "home", keys: "Shift+H", label: "Back to the Home screen (plain H too in the Swag, Rig and Ship workspaces)", group: "File", match: (e) => bare(e) && e.shiftKey && lower(e) === "h" },
  { action: "palette", keys: "Ctrl+K", label: "Command palette: search every action, clip, bone and skin", group: "File", match: (e) => mod(e, "k") },
  { action: "help", keys: "? / F1", label: "This cheat sheet", group: "File", match: (e) => e.key === "?" || e.key === "F1" }
];

// ---------------------------------------------------------------------------------------------
// Rebinding (Batch 8b-2): keymap.json overrides, applied over the table above
// ---------------------------------------------------------------------------------------------

const DEFAULTS = new Map(HOTKEYS.map((h) => [h.action, { keys: h.keys, match: h.match }] as const));

/** Actions whose key is handled elsewhere (a Space tap plays; Space + drag pans), so a row here cannot be rebound. */
export const FIXED_ACTIONS: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>(["play"]);

/** Every action name (the keys a keymap.json may use). */
export const HOTKEY_ACTIONS: ReadonlySet<string> = new Set(HOTKEYS.map((h) => h.action));

/** The built-in keys text of an action ("Ctrl+Y / Ctrl+Shift+Z"). */
export const defaultKeys = (action: HotkeyAction): string => DEFAULTS.get(action)?.keys ?? "";

/**
 * Applies keymap overrides ({ action: keys text }): the rows' `keys` (cheat sheet, tooltips, palette) and `match` follow them, every action
 * not listed goes back to its built-in key. Unknown or fixed actions and keys that do not parse are ignored.
 */
export function applyKeymap(bindings: Bindings): void {
  for (const h of HOTKEYS) {
    const d = DEFAULTS.get(h.action)!;
    h.keys = d.keys;
    h.match = d.match;
    const text = bindings[h.action];
    if (text === undefined || FIXED_ACTIONS.has(h.action)) continue;
    const chords = chordsOfText(text);
    if (!chords.length) continue;
    h.keys = chords.map(formatChord).join(" / ");
    h.match = (e) => chords.some((c) => chordMatches(c, e));
  }
}

/** The rows whose keys differ from the built-in ones (what keymap.json stores). */
export function currentKeymap(): Bindings {
  const out: Bindings = {};
  for (const h of HOTKEYS) if (h.keys !== defaultKeys(h.action)) out[h.action] = h.keys;
  return out;
}

export type EditorMode = "animate" | "setup";

/**
 * The actions that also work in Setup mode. Every other row is Animate-only: Setup mode has its own tool keys (V, B, T, A below), which
 * would clash with game view (V), bone overlay (B), move (T) and auto key (A), so in Setup those rows are not looked up at all.
 */
export const SETUP_SHARED: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>(["selectRoot", "frameSelection", "fitAll", "help", "clearSelection", "save", "undo", "redo", "home", "palette"]);

/** The Setup-mode tool keys (setupMode.ts binds the same keys: a test keeps the two lists equal). */
export const SETUP_KEYS: readonly { keys: string; label: string }[] = [
  { keys: "V", label: "Select tool (Setup mode)" },
  { keys: "R", label: "Rotate tool (Setup mode)" },
  { keys: "T", label: "Move tool (Setup mode)" },
  { keys: "S", label: "Scale tool (Setup mode)" },
  { keys: "L", label: "Length tool (Setup mode)" },
  { keys: "B", label: "Draw bone tool (Setup mode)" },
  { keys: "A", label: "Image tool (Setup mode)" },
  { keys: "M", label: "Mesh tool (Setup mode; in Animate M mirrors, and D is Shape keys)" },
  { keys: "W", label: "Weights tool (Setup mode; also works from Animate)" }
];

/** The action for a key press in the given mode (Animate by default), or null. */
export function hotkeyAction(e: KeyLike, mode: EditorMode = "animate"): HotkeyAction | null {
  const full: Required<KeyLike> = { key: e.key, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey };
  for (const h of HOTKEYS) if ((mode === "animate" || SETUP_SHARED.has(h.action)) && h.match(full)) return h.action;
  return null;
}

/** The mouse and canvas gestures, listed under the keys in the cheat sheet. */
export const GESTURES: readonly { keys: string; label: string }[] = [
  { keys: "Click bone", label: "Select it (a click on empty space clears)" },
  { keys: "Shift / Ctrl click", label: "Add to / toggle in the selection (canvas and bone list)" },
  { keys: "Alt click", label: "Pick the next bone stacked under the pointer (repeat to cycle)" },
  { keys: "Drag empty space", label: "Box select bones (Shift / Ctrl adds)" },
  { keys: "Timeline: Shift / Ctrl click key", label: "Shift adds a key to the selection, Ctrl toggles it; a box drag with Shift / Ctrl adds" },
  { keys: "Timeline: Shift while dragging keys", label: "Snap the moved keys onto a neighbouring key (a guide line shows where)" },
  { keys: "Timeline: open a bone's arrow", label: "Under the bone's key rows, one mini value curve per channel (rotate, move X, move Y)" },
  { keys: "Timeline: click a curve segment", label: "Pick its easing from curve thumbnails; Shift / Ctrl click selects more segments and the pick sets them all" },
  { keys: "Timeline: right-click", label: "Key menu: copy, paste, delete, interpolation, move to playhead, mirror" },
  { keys: "Timeline: drag the top edge", label: "Resize the timeline (Up / Down when focused, double-click for tallest)" },
  { keys: "Drag bone / ring", label: "Rotate (or move, in the Move tool); the whole selection follows" },
  { keys: "Shift while rotating", label: "Snap to 15 degrees (a tick ring shows the steps)" },
  { keys: "Ctrl while rotating", label: "Snap to the previous key's angle or the mirror bone's angle (guides show both)" },
  { keys: "Type a number while dragging", label: "Set the exact angle (or X, Tab, Y when moving); Enter commits, Backspace edits, Esc cancels the drag" },
  { keys: "Wheel", label: "Zoom at the cursor" },
  { keys: "Middle / right / Space drag", label: "Pan" },
  { keys: "Canvas: right-click", label: "Bone menu (key, reset, children, mirror, copy / paste pose, hide) or view menu (fit, bones, onion)" },
  { keys: "Enter in a number", label: "Commit (Esc reverts)" }
];
