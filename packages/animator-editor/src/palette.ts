/*
 * Atlas Animator editor: original implementation.
 *
 * The command palette (Ctrl+K / Cmd+K): a centred search box over a list of every action in the registry (actionRegistry.ts), each row
 * with its shortcut. Keyboard first: type to filter, Up / Down / Home / End move, Enter runs, Esc closes and gives focus back. The most
 * recently used actions come first. Styles: `.palette` in ui.css.
 */
import { allActions, pushRecent, rankActions, type PaletteAction } from "./actionRegistry.js";

const STORE = "atlas-editor-palette-recent";

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(ids));
  } catch {
    // storage can be unavailable (private window); recents just do not persist
  }
}

let current: { close: () => void } | null = null;

export const paletteOpen = (): boolean => current !== null;

export function closePalette(): void {
  current?.close();
}

/** Opens the palette. `actions` defaults to the registry; `after` runs once the palette is closed and focus is back (tests drive it). */
export function openPalette(actions: () => PaletteAction[] = allActions): HTMLElement {
  closePalette();
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.createElement("div");
  root.className = "palette-scrim";
  root.id = "palette";
  const box = document.createElement("div");
  box.className = "palette";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Command palette");
  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = "Search actions, clips, bones, skins";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "palette-list";
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>";
  box.append(input, list, foot);
  root.append(box);

  const all = actions();
  const recent = readRecent();
  let rows: PaletteAction[] = [];
  let active = 0;

  const paint = () => {
    rows = rankActions(all, input.value, recent);
    active = Math.min(active, Math.max(0, rows.length - 1));
    list.replaceChildren();
    if (!rows.length) {
      const none = document.createElement("div");
      none.className = "palette-empty";
      none.textContent = `Nothing matches "${input.value.trim()}"`;
      list.append(none);
      input.removeAttribute("aria-activedescendant");
      return;
    }
    let lastGroup = "";
    rows.forEach((a, i) => {
      const isRecent = !input.value.trim() && recent.includes(a.id);
      const group = isRecent ? "Recent" : input.value.trim() ? "" : a.group;
      if (group && group !== lastGroup) {
        const cap = document.createElement("div");
        cap.className = "palette-cap";
        cap.textContent = group;
        list.append(cap);
      }
      lastGroup = group;
      const row = document.createElement("div");
      row.className = "palette-row";
      row.id = `palette-row-${i}`;
      row.setAttribute("role", "option");
      row.dataset.id = a.id;
      if (a.disabled) {
        row.classList.add("off");
        row.setAttribute("aria-disabled", "true");
      }
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = a.label;
      const tag = document.createElement("span");
      tag.className = "palette-group";
      tag.textContent = a.disabled ?? (input.value.trim() ? a.group : "");
      row.append(label, tag);
      if (a.keys) {
        const keys = document.createElement("span");
        keys.className = "palette-keys";
        for (const k of a.keys.split(" / ")) {
          const kbd = document.createElement("kbd");
          kbd.textContent = k;
          keys.append(kbd);
        }
        row.append(keys);
      }
      row.addEventListener("pointermove", () => {
        if (active !== i) {
          active = i;
          mark(false);
        }
      });
      row.addEventListener("click", () => run(i));
      list.append(row);
    });
    mark(true);
  };

  const mark = (scroll: boolean) => {
    list.querySelectorAll<HTMLElement>(".palette-row").forEach((r, i) => {
      const on = i === active;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", String(on));
      if (on) {
        input.setAttribute("aria-activedescendant", r.id);
        if (scroll) r.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const close = () => {
    if (current?.close !== close) return;
    current = null;
    root.remove();
    document.removeEventListener("keydown", onKey, true);
    restore?.focus?.({ preventScroll: true });
  };

  const run = (i: number) => {
    const a = rows[i];
    if (!a || a.disabled) return;
    writeRecent(pushRecent(recent, a.id));
    close();
    a.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // Ctrl+K again closes it; every other key stays inside the palette.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End" || e.key === "PageDown" || e.key === "PageUp") {
      if (!rows.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Home") active = 0;
      else if (e.key === "End") active = rows.length - 1;
      else active = Math.max(0, Math.min(rows.length - 1, active + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? 8 : -8)));
      mark(true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      run(active);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      return;
    }
    // Typing goes to the field; nothing leaks to the editor's hotkeys underneath.
    e.stopPropagation();
  };

  input.addEventListener("input", () => {
    active = 0;
    paint();
  });
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });
  document.addEventListener("keydown", onKey, true);
  current = { close };
  document.body.append(root);
  paint();
  input.focus();
  return root;
}
