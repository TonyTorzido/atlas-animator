/*
 * Atlas Animator editor: the rebindable keymap.
 *
 * Pure parts: chords ("Ctrl+Shift+K"), parsing the keys text of a HOTKEYS row, the override file (`keymap.json`:
 * { keymapVersion: 1, bindings: { <action>: "J" or "J / Alt+J" } }), and conflict detection. hotkeys.ts applies the overrides;
 * keymapEditor.ts is the visible editor (Help menu); the dev server stores the file in the user data folder.
 */

export interface Chord {
  /** Lower-case key name as `KeyboardEvent.key` reports it (letters lower-cased; "ArrowLeft", "Delete", " " ...). */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export const KEYMAP_VERSION = 1;

const NAMED: Record<string, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  delete: "Delete",
  backspace: "Backspace",
  esc: "Escape",
  escape: "Escape",
  space: " ",
  home: "Home",
  end: "End",
  enter: "Enter",
  tab: "Tab",
  f1: "F1"
};
const SHOWN: Record<string, string> = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", " ": "Space" };

/** "Ctrl+Shift+K" to a chord; null when it is not one key with optional modifiers. */
export function parseChord(text: string): Chord | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t === "+" ? ["+"] : t.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  if (!key) return null;
  const c: Chord = { key: "", ctrl: false, shift: false, alt: false };
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === "ctrl" || l === "cmd" || l === "meta") c.ctrl = true;
    else if (l === "shift") c.shift = true;
    else if (l === "alt") c.alt = true;
    else return null;
  }
  const named = NAMED[key.toLowerCase()];
  if (named) c.key = named;
  else if (key.length === 1) c.key = key.toLowerCase();
  else return null;
  return c;
}

export function formatChord(c: Chord): string {
  const k = SHOWN[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return [c.ctrl ? "Ctrl" : "", c.alt ? "Alt" : "", c.shift ? "Shift" : "", k].filter(Boolean).join("+");
}

/** The chords of a keys text such as "Ctrl+Y / Ctrl+Shift+Z" or ", / Alt+Left" (a part that is not one chord is skipped). */
export function chordsOfText(keys: string): Chord[] {
  const out: Chord[] = [];
  for (const part of keys.split(" / ")) {
    const c = parseChord(part);
    if (c) out.push(c);
  }
  return out;
}

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const isLetter = (k: string): boolean => k.length === 1 && k.toLowerCase() !== k.toUpperCase();

/** Whether a key press is this chord. Shift is compared for letters and named keys; a symbol (? , . [ ]) already carries it. */
export function chordMatches(c: Chord, e: KeyEventLike): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key !== c.key) return false;
  if (c.ctrl !== !!(e.ctrlKey || e.metaKey) || c.alt !== !!e.altKey) return false;
  return c.key.length > 1 || isLetter(c.key) ? c.shift === !!e.shiftKey : true;
}

export const chordKey = (c: Chord): string => `${c.ctrl ? "c" : ""}${c.alt ? "a" : ""}${c.shift ? "s" : ""}:${c.key}`;

/** The chord a key press makes, or null for a bare modifier. */
export function chordOfEvent(e: KeyEventLike): Chord | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { key, ctrl: !!(e.ctrlKey || e.metaKey), shift: e.key.length > 1 || isLetter(e.key) ? !!e.shiftKey : false, alt: !!e.altKey };
}

export type Bindings = Record<string, string>;

/** A keymap.json body from untrusted JSON: only { action: "keys text" } rows whose chords all parse survive. */
export function parseKeymap(raw: unknown, known: ReadonlySet<string>): Bindings {
  const src = raw && typeof raw === "object" ? (raw as { bindings?: unknown }).bindings : null;
  if (!src || typeof src !== "object") return {};
  const out: Bindings = {};
  for (const [action, v] of Object.entries(src as Record<string, unknown>)) {
    if (!known.has(action) || typeof v !== "string") continue;
    const parts = v.split(" / ").map((p) => p.trim()).filter(Boolean);
    const chords = parts.map(parseChord);
    if (!chords.length || chords.some((c) => !c)) continue;
    out[action] = chords.map((c) => formatChord(c!)).join(" / ");
  }
  return out;
}

export interface Conflict {
  chord: string;
  actions: string[];
}

/** Chords used by more than one action. `chords` maps action to its effective chords. */
export function findConflicts(chords: ReadonlyMap<string, readonly Chord[]>): Conflict[] {
  const by = new Map<string, { chord: string; actions: string[] }>();
  for (const [action, list] of chords) {
    for (const c of list) {
      const k = chordKey(c);
      const row = by.get(k) ?? { chord: formatChord(c), actions: [] };
      if (!row.actions.includes(action)) row.actions.push(action);
      by.set(k, row);
    }
  }
  return [...by.values()].filter((r) => r.actions.length > 1).sort((a, b) => a.chord.localeCompare(b.chord));
}
