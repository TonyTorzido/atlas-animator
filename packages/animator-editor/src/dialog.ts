// One dialog layer for the whole editor (replaces every native prompt / confirm / alert).
//
//   bindDialog(root, remove)  - wires any overlay: Esc closes the topmost dialog (even when focus is outside it), Tab stays inside,
//                               and closing returns focus to the control that opened it. Returns the close function.
//   openModal({...})          - a titled modal (backdrop + .modal box + Close) built on bindDialog; Files, Versions, Publish use it.
//   confirmDialog / promptDialog / alertDialog - the promise versions of window.confirm / prompt / alert.
//
// Tests (qa-core "dialogs") press Esc on each dialog and check it is gone and focus is back; cssLint.test.ts also fails on any native
// prompt / confirm / alert left in src/*.ts.
const stack: Array<{ root: HTMLElement; close: () => void }> = [];
let installed = false;

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    "keydown",
    (e) => {
      while (stack.length && !stack[stack.length - 1]!.root.isConnected) stack.pop(); // removed without close()
      const top = stack[stack.length - 1];
      if (!top) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        top.close();
      } else if (e.key === "Tab") {
        const items = [...top.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (!items.length) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const at = document.activeElement;
        if (!top.root.contains(at)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && at === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true
  );
}

/**
 * Registers an overlay as a dialog. `remove` takes the element out of the page; the returned `close` calls it once, pops the dialog
 * from the stack and returns focus to whatever had it when the dialog opened.
 */
export function bindDialog(root: HTMLElement, remove: () => void = () => root.remove()): () => void {
  install();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let open = true;
  const entry = {
    root,
    close: (): void => {
      if (!open) return;
      open = false;
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      remove();
      if (opener && opener.isConnected) opener.focus();
    }
  };
  stack.push(entry);
  // Focus lands inside the dialog: the control marked data-autofocus, else the first field, else the first button.
  queueMicrotask(() => {
    if (!open || root.contains(document.activeElement)) return;
    (root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea") ?? root.querySelector<HTMLElement>("button"))?.focus();
  });
  return entry.close;
}

/** True while any dialog from this module is open (hotkeys can stand down). */
export const dialogOpen = (): boolean => stack.length > 0;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export interface ModalOptions {
  id?: string;
  title: string;
  /** Extra class on the .modal box. */
  className?: string;
  /** Label of the closing button; default "Close". Pass null for no button (the caller supplies its own actions). */
  closeLabel?: string | null;
  onClose?: () => void;
}

export interface ModalHandle {
  back: HTMLElement;
  box: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  close: () => void;
}

/** A titled modal: backdrop, .modal box, a body, an actions row. Esc, a backdrop click and the Close button all close it. */
export function openModal(o: ModalOptions): ModalHandle {
  if (o.id) document.getElementById(o.id)?.remove();
  const back = h("div", "modal-backdrop");
  if (o.id) back.id = o.id;
  const box = h("div", `modal ${o.className ?? ""}`.trim());
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", o.title);
  const body = h("div", "modal-body");
  const actions = h("div", "modal-actions");
  const close = bindDialog(back, () => {
    back.remove();
    o.onClose?.();
  });
  if (o.closeLabel !== null) {
    const b = h("button", "btn", o.closeLabel ?? "Close");
    b.type = "button";
    b.title = "Close this window (Esc)";
    b.addEventListener("click", close);
    actions.append(b);
  }
  box.append(h("h2", undefined, o.title), body, actions);
  back.append(box);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  // A dialog opened from another dialog (Versions -> confirm) must sit above it, whatever z-index that one has.
  const below = [...document.querySelectorAll<HTMLElement>(".modal-backdrop, .pu-layer")].map((n) => Number(getComputedStyle(n).zIndex) || 0);
  if (below.length) back.style.zIndex = String(Math.max(...below) + 1);
  document.body.append(back);
  return { back, box, body, actions, close };
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for deletes. */
  danger?: boolean;
  id?: string;
  /** A list shown under the message (what will be dropped, what changes); each entry is one line. */
  lines?: readonly string[];
}

/** Resolves true on the confirm button (or Enter), false on Cancel, Esc or a backdrop click. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((done) => {
    let result = false;
    const m = openModal({ id: o.id ?? "confirm-dialog", title: o.title ?? "Please confirm", className: "dialog-sm", closeLabel: null, onClose: () => done(result) });
    m.box.setAttribute("role", "alertdialog");
    const text = h("p", "dialog-text", o.message);
    m.body.append(text);
    if (o.lines?.length) {
      const list = h("ul", "dialog-list");
      list.id = `${o.id ?? "confirm-dialog"}-lines`;
      for (const line of o.lines) list.append(h("li", "", line));
      m.body.append(list);
    }
    const no = h("button", "btn", o.cancelLabel ?? "Cancel");
    no.type = "button";
    no.title = "Close this without changing anything (Esc)";
    no.dataset["act"] = "cancel";
    no.addEventListener("click", m.close);
    const yes = h("button", `btn ${o.danger ? "btn-danger" : "btn-primary"}`, o.confirmLabel ?? "OK");
    yes.type = "button";
    yes.title = o.confirmLabel ?? "OK";
    yes.setAttribute("data-autofocus", "");
    yes.dataset["act"] = "confirm";
    yes.addEventListener("click", () => {
      result = true;
      m.close();
    });
    m.actions.append(no, yes);
  });
}

export interface PromptOptions {
  title?: string;
  message?: string;
  value?: string;
  confirmLabel?: string;
  id?: string;
}

/** Resolves the typed text on OK / Enter, or null on Cancel / Esc. */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return new Promise((done) => {
    let result: string | null = null;
    const m = openModal({ id: o.id ?? "prompt-dialog", title: o.title ?? "Enter a value", className: "dialog-sm", closeLabel: null, onClose: () => done(result) });
    if (o.message) m.body.append(h("p", "dialog-text", o.message));
    const input = h("input", "in");
    input.type = "text";
    input.value = o.value ?? "";
    input.setAttribute("aria-label", o.title ?? "Value");
    input.title = o.message ?? "Type the value, then press Enter";
    input.setAttribute("data-autofocus", "");
    m.body.append(input);
    const no = h("button", "btn", "Cancel");
    no.type = "button";
    no.title = "Close this without changing anything (Esc)";
    no.addEventListener("click", m.close);
    const yes = h("button", "btn btn-primary", o.confirmLabel ?? "OK");
    yes.type = "button";
    yes.title = o.confirmLabel ?? "OK";
    yes.dataset["act"] = "confirm";
    no.dataset["act"] = "cancel";
    const accept = (): void => {
      result = input.value;
      m.close();
    };
    yes.addEventListener("click", accept);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        accept();
      }
    });
    m.actions.append(no, yes);
    queueMicrotask(() => input.select());
  });
}

/** A notice with one OK button (the replacement for window.alert). */
export function alertDialog(message: string, title = "Notice"): Promise<void> {
  return new Promise((done) => {
    const m = openModal({ id: "alert-dialog", title, className: "dialog-sm", closeLabel: "OK", onClose: () => done() });
    m.box.setAttribute("role", "alertdialog");
    m.body.append(h("p", "dialog-text", message));
  });
}
