/*
 * Atlas Animator editor: original implementation.
 *
 * The one action registry behind the command palette (Ctrl+K). Providers add actions: the hotkey table feeds it automatically (every
 * row of HOTKEYS becomes a palette row with its shortcut), and main.ts adds the dynamic ones (workspaces, clips, bones, skins, toggles).
 * A provider is read every time the palette opens, so a new clip or bone shows up with no extra wiring. Pure: no DOM.
 */
import { HOTKEYS, type HotkeyAction } from "./hotkeys.js";

export interface PaletteAction {
  /** Stable id (recents are stored by id). */
  id: string;
  label: string;
  /** The group caption: Tools, Workspace, Clip, Bone, Skin, Export, View ... */
  group: string;
  /** The shortcut text shown on the row. */
  keys?: string | undefined;
  /** Extra words the search matches (not shown). */
  keywords?: string | undefined;
  /** When set the row is shown dim with this reason and does not run. */
  disabled?: string | undefined;
  run: () => void;
}

export type ActionProvider = () => PaletteAction[];

const providers = new Map<string, ActionProvider>();

/** Adds (or replaces) a provider under `name`. Returns a function that removes it. */
export function registerActions(name: string, provider: ActionProvider): () => void {
  providers.set(name, provider);
  return () => void providers.delete(name);
}

/** Every action from every provider, the first of a repeated id winning. */
export function allActions(): PaletteAction[] {
  const seen = new Set<string>();
  const out: PaletteAction[] = [];
  for (const provider of providers.values()) {
    for (const a of provider()) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

/** Hotkey rows that are not worth a palette row (the palette itself). */
const SKIP: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>(["palette"]);

/** "Rotate tool", "Shape keys tool", "Key the selected bones at the playhead": the label up to its first aside. */
export function shortLabel(label: string): string {
  const cut = label.split(/ \(|: |; /)[0]!.trim();
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** One palette row per hotkey-table row, running through `run` (main.ts's runHotkey). New hotkeys appear with no further wiring. */
export function hotkeyActions(run: (action: HotkeyAction) => void, disabled?: (action: HotkeyAction) => string | undefined): PaletteAction[] {
  return HOTKEYS.filter((h) => !SKIP.has(h.action)).map((h) => ({
    id: `hotkey:${h.action}`,
    label: shortLabel(h.label),
    group: h.group,
    keys: h.keys,
    keywords: `${h.label} ${h.action}`,
    disabled: disabled?.(h.action),
    run: () => run(h.action)
  }));
}

const isWordStart = (t: string, i: number) => i === 0 || /[\s_\-.:/()]/.test(t[i - 1]!);

/**
 * A fuzzy score of `query` against `text` (higher is better), or null when it does not match. A substring beats a scattered subsequence;
 * word starts and runs score extra; spaces in the query are ignored.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const joined = fuzzyScoreJoined(query, text);
  if (joined !== null) return joined;
  // Several words ("pose a"): each word may match on its own, in any order.
  const words = query.trim().split(/\s+/);
  if (words.length < 2) return null;
  let total = 0;
  for (const w of words) {
    const one = fuzzyScoreJoined(w, text);
    if (one === null) return null;
    total += one;
  }
  return Math.min(total / words.length, 60) * 0.5 - 20; // always below a joined match
}

function fuzzyScoreJoined(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 200 + (at === 0 ? 40 : isWordStart(t, at) ? 25 : 0) - at * 0.5 - (t.length - q.length) * 0.15;
  let score = 0;
  let from = 0;
  let first = -1;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (first < 0) first = i;
    run = i === from && from > 0 ? run + 1 : 0;
    score += 4 + run * 3 + (isWordStart(t, i) ? 6 : 0) - Math.min(6, (i - from) * 0.5);
    from = i + 1;
  }
  // Letters scattered far apart across a long label are not a match ("rotate" is not in "Render contact sheets").
  if (from - first - (q.length - 1) > q.length + 2) return null;
  return score - t.length * 0.1;
}

export const RECENT_MAX = 12;

/** Moves `id` to the front of the recents list. */
export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
}

/**
 * The palette list for a query. With no query the recently used actions come first (most recent first), then the rest in registry
 * order. With a query the fuzzy score decides, with a small lift for recents so a habit wins a tie.
 */
export function rankActions(actions: readonly PaletteAction[], query: string, recent: readonly string[], limit = 60): PaletteAction[] {
  const rank = (a: PaletteAction) => recent.indexOf(a.id);
  if (!query.trim()) {
    const used = actions.filter((a) => rank(a) >= 0).sort((a, b) => rank(a) - rank(b));
    return [...used, ...actions.filter((a) => rank(a) < 0)].slice(0, limit);
  }
  const scored: { a: PaletteAction; s: number; i: number }[] = [];
  actions.forEach((a, i) => {
    const label = fuzzyScore(query, a.label);
    const other = fuzzyScore(query, `${a.group} ${a.keywords ?? ""}`);
    if (label === null && other === null) return;
    const base = label !== null ? label + 20 : (other ?? 0) - 40;
    const lift = rank(a) >= 0 ? (RECENT_MAX - rank(a)) * 1.5 : 0;
    scored.push({ a, s: base + lift, i });
  });
  return scored.sort((x, y) => y.s - x.s || x.i - y.i).slice(0, limit).map((x) => x.a);
}
