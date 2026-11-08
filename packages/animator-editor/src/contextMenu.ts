/*
 * Atlas Animator editor: original implementation.
 *
 * One small context menu for the whole editor (the timeline first, the canvas next). Keyboard: Up / Down / Home / End move, Enter or
 * Space runs, Esc closes and gives focus back, a letter jumps to the item that starts with it. Styles: `.ctxmenu` in ui.css.
 */

export interface MenuItem {
  label: string;
  /** Shown right-aligned (a hotkey). */
  hint?: string;
  disabled?: boolean;
  /** A reason shown as the tooltip of a disabled item. */
  why?: string;
  run?: () => void;
  /** A caption row (a small group heading, not clickable). */
  caption?: boolean;
  /** Draws a rule above this item. */
  separator?: boolean;
  /** Marks the current choice (interpolation). */
  checked?: boolean;
}

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeContextMenu(): void {
  openMenu?.close();
}

export const contextMenuOpen = (): boolean => openMenu !== null;

/** Opens a menu at viewport coordinates. Returns the element (tests drive it). */
export function openContextMenu(x: number, y: number, items: readonly MenuItem[], restoreFocus?: HTMLElement | null): HTMLElement {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  menu.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  const finish = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", finish);
    window.removeEventListener("resize", finish);
    document.removeEventListener("wheel", finish, true);
    if (openMenu?.el === menu) openMenu = null;
  };
  const close = (refocus = true) => {
    finish();
    if (refocus) restoreFocus?.focus?.({ preventScroll: true });
  };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  for (const item of items) {
    if (item.separator) {
      const rule = document.createElement("div");
      rule.className = "ctx-sep";
      rule.setAttribute("role", "separator");
      menu.append(rule);
    }
    if (item.caption) {
      const cap = document.createElement("div");
      cap.className = "ctx-cap";
      cap.textContent = item.label;
      menu.append(cap);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item";
    b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
    const tick = document.createElement("span");
    tick.className = "ctx-tick";
    tick.textContent = item.checked ? "✓" : "";
    const text = document.createElement("span");
    text.className = "ctx-label";
    text.textContent = item.label;
    b.append(tick, text);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = item.hint;
      b.append(hint);
    }
    b.disabled = !!item.disabled;
    if (item.disabled && item.why) b.title = item.why;
    b.addEventListener("click", () => {
      close();
      item.run?.();
    });
    menu.append(b);
    buttons.push(b);
  }
  menu.addEventListener("keydown", (e) => {
    const live = buttons.filter((b) => !b.disabled);
    if (!live.length) return;
    const at = live.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => live[(i + live.length) % live.length]!.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape" || e.key === "Tab") close();
    else if (e.key.length === 1 && e.key.trim() !== "") {
      const hit = live.find((b) => b.querySelector(".ctx-label")!.textContent!.toLowerCase().startsWith(e.key.toLowerCase()));
      if (!hit) return;
      hit.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("blur", finish);
  window.addEventListener("resize", finish);
  document.addEventListener("wheel", finish, true);
  openMenu = { el: menu, close: () => close(false) };
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return menu;
}
