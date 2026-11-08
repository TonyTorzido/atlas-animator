/*
 * Atlas Animator editor: the Keyboard shortcuts editor.
 *
 * Help > "Edit keyboard shortcuts": a searchable list of every hotkey. Rebind, then press the new key; a key another action already uses is
 * flagged with a choice to swap the two or cancel; Reset puts one row (or all) back to the built-in key. Only the rows that differ are
 * stored, in keymap.json in the data folder (GET / POST /api/keymap); hotkeys.ts applies them, so the key handler, the "?" sheet, the
 * tooltips and the command palette all follow. Pure parts: keymapModel.ts.
 */
import { openModal } from "./dialog.js";
import { applyKeymap, currentKeymap, defaultKeys, FIXED_ACTIONS, HOTKEY_ACTIONS, HOTKEYS, type HotkeyAction, type HotkeyDef } from "./hotkeys.js";
import { chordKey, chordOfEvent, chordsOfText, findConflicts, formatChord, parseKeymap, KEYMAP_VERSION, type Bindings, type Chord } from "./keymapModel.js";
import { showToast } from "./persistUi.js";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { id?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
};

/** Reads keymap.json from the data folder and applies it (a missing or unreadable file leaves the built-in keys). */
export async function loadKeymap(): Promise<void> {
  try {
    const r = await fetch("/api/keymap", { cache: "no-store" });
    if (!r.ok) return;
    applyKeymap(parseKeymap(await r.json(), HOTKEY_ACTIONS));
  } catch {
    /* built-in keys */
  }
}

async function saveKeymap(bindings: Bindings): Promise<boolean> {
  try {
    const r = await fetch("/api/keymap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keymapVersion: KEYMAP_VERSION, bindings }) });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${r.status}`);
    return true;
  } catch (error) {
    showToast(`Could not save keymap.json: ${(error as Error).message}. The new keys work until you reload.`, "bad");
    return false;
  }
}

const chordsOf = (h: HotkeyDef): Chord[] => chordsOfText(h.keys);

/** The other actions that already use `chord`. */
export function usersOf(chord: Chord, except: HotkeyAction): HotkeyDef[] {
  const k = chordKey(chord);
  return HOTKEYS.filter((h) => h.action !== except && chordsOf(h).some((c) => chordKey(c) === k));
}

export function openKeymapEditor(): void {
  const m = openModal({ id: "keymap-dialog", title: "Keyboard shortcuts", className: "keymap-modal", closeLabel: "Close" });
  const search = el("input", { type: "search", id: "keymap-search", placeholder: "Search actions and keys", title: "Type to narrow the list: an action name, a group or a key" });
  search.setAttribute("aria-label", "Search keyboard shortcuts");
  const resetAll = el("button", { type: "button", id: "keymap-reset-all", className: "btn", textContent: "Reset all to defaults", title: "Put every shortcut back to the built-in key (keymap.json is emptied)" });
  const note = el("p", { className: "km-note", textContent: "Click Rebind, then press the new key. A key that is already taken asks whether to swap. Setup-mode tool keys (V, R, T, L...) are fixed. Changes are saved in keymap.json in your data folder." });
  const list = el("div", { className: "km-list", id: "keymap-list" });
  const live = el("div", { className: "km-live", id: "keymap-live", textContent: "" });
  live.setAttribute("aria-live", "polite");
  m.body.append(el("div", { className: "km-top" }, search, resetAll), note, live, list);

  let capturing: HotkeyAction | null = null;
  let pending: { action: HotkeyAction; chord: Chord; users: HotkeyDef[] } | null = null;
  let stop: (() => void) | null = null;

  const commit = async (next: Bindings, said: string): Promise<void> => {
    for (const [a, v] of Object.entries(next)) if (v === defaultKeys(a as HotkeyAction)) delete next[a];
    applyKeymap(next);
    live.textContent = said;
    render();
    await saveKeymap(next);
  };

  const endCapture = (): void => {
    stop?.();
    stop = null;
    capturing = null;
    pending = null;
  };

  const begin = (action: HotkeyAction): void => {
    endCapture();
    capturing = action;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        live.textContent = "Rebind cancelled";
        endCapture();
        render();
        return;
      }
      const chord = chordOfEvent(e);
      if (!chord) return;
      stop?.();
      stop = null;
      const users = usersOf(chord, action);
      if (users.length) {
        pending = { action, chord, users };
        live.textContent = `${formatChord(chord)} is already used by ${users.map((u) => u.label).join("; ")}`;
        render();
        return;
      }
      capturing = null;
      void commit({ ...currentKeymap(), [action]: formatChord(chord) }, `${HOTKEYS.find((h) => h.action === action)!.label}: ${formatChord(chord)}`);
    };
    window.addEventListener("keydown", onKey, true);
    stop = () => window.removeEventListener("keydown", onKey, true);
    live.textContent = "Press the new key (Esc cancels)";
    render();
  };

  const swap = (): void => {
    if (!pending) return;
    const { action, chord, users } = pending;
    const mine = HOTKEYS.find((h) => h.action === action)!;
    const next: Bindings = { ...currentKeymap(), [action]: formatChord(chord) };
    const clash = chordKey(chord);
    for (const u of users) {
      // The other action takes this one's old keys, minus anything that would clash again.
      const old = chordsOf(mine).filter((c) => chordKey(c) !== clash);
      next[u.action] = old.length ? old.map(formatChord).join(" / ") : defaultKeys(u.action);
    }
    const said = `Swapped: ${mine.label} is now ${formatChord(chord)}; ${users.map((u) => u.label).join(", ")} took ${mine.keys}`;
    endCapture();
    void commit(next, said);
  };

  const reset = (action: HotkeyAction): void => {
    const next = { ...currentKeymap() };
    delete next[action];
    endCapture();
    void commit(next, `${HOTKEYS.find((h) => h.action === action)!.label}: back to ${defaultKeys(action)}`);
  };

  function render(): void {
    const q = search.value.trim().toLowerCase();
    const changed = currentKeymap();
    const chordMap = new Map(HOTKEYS.map((h) => [h.action as string, chordsOf(h)] as const));
    const clashes = new Map<string, string[]>();
    for (const c of findConflicts(chordMap)) for (const a of c.actions) clashes.set(a, [...(clashes.get(a) ?? []), c.chord]);
    resetAll.disabled = Object.keys(changed).length === 0;
    list.replaceChildren();
    let group = "";
    for (const h of HOTKEYS) {
      const hay = `${h.label} ${h.group} ${h.keys} ${h.action}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (h.group !== group) {
        group = h.group;
        list.append(el("h3", { textContent: group }));
      }
      const isChanged = h.action in changed;
      const fixed = FIXED_ACTIONS.has(h.action);
      const row = el("div", { className: `km-row${isChanged ? " changed" : ""}${clashes.has(h.action) ? " conflict" : ""}${capturing === h.action ? " capturing" : ""}` });
      row.dataset["action"] = h.action;
      const keys = el("kbd", { textContent: capturing === h.action ? (pending ? formatChord(pending.chord) : "press a key...") : h.keys, title: `Current key${isChanged ? ` (built-in: ${defaultKeys(h.action)})` : ""}` });
      const label = el("span", { className: "km-label", textContent: h.label });
      const bind = el("button", { type: "button", className: "btn", textContent: capturing === h.action ? "Press a key..." : "Rebind", title: fixed ? "This key is handled by the timeline (a Space tap plays, Space + drag pans) and cannot be rebound" : `Rebind: click, then press the new key for "${h.label}"` });
      bind.dataset["rebind"] = h.action;
      bind.disabled = fixed;
      bind.addEventListener("click", () => begin(h.action));
      const back = el("button", { type: "button", className: "btn", textContent: "Reset", title: isChanged ? `Put this shortcut back to ${defaultKeys(h.action)}` : "Already the built-in key" });
      back.dataset["reset"] = h.action;
      back.disabled = !isChanged;
      back.addEventListener("click", () => reset(h.action));
      row.append(keys, label, bind, back);
      if (clashes.has(h.action) && !pending) row.append(el("span", { className: "km-flag", textContent: `Shared key ${clashes.get(h.action)!.join(", ")}`, title: "Two actions use this key: the first one in the list wins. Rebind one of them." }));
      if (pending && pending.action === h.action) {
        const msg = el("span", { className: "km-flag", textContent: `${formatChord(pending.chord)} is used by ${pending.users.map((u) => u.label).join("; ")}.` });
        const doSwap = el("button", { type: "button", className: "btn btn-primary", textContent: "Swap", title: `Give ${formatChord(pending.chord)} to this action and move its old key to the other` });
        doSwap.dataset["swap"] = h.action;
        doSwap.addEventListener("click", swap);
        const cancel = el("button", { type: "button", className: "btn", textContent: "Cancel", title: "Keep both as they were" });
        cancel.dataset["cancel"] = h.action;
        cancel.addEventListener("click", () => {
          endCapture();
          live.textContent = "Rebind cancelled";
          render();
        });
        row.append(msg, doSwap, cancel);
      }
      list.append(row);
    }
    if (!list.children.length) list.append(el("p", { className: "km-note", textContent: "No shortcut matches that search." }));
  }

  resetAll.addEventListener("click", () => {
    endCapture();
    void commit({}, "Every shortcut is back to its built-in key");
  });
  search.addEventListener("input", render);
  const closeObserver = new MutationObserver(() => {
    if (!document.body.contains(m.back)) {
      endCapture();
      closeObserver.disconnect();
    }
  });
  closeObserver.observe(document.body, { childList: true });
  render();
  search.focus();
}
