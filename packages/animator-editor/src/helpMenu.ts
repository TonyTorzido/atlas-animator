/*
 * Atlas Animator editor: the Help menu under the header "Help" button (the "?" key and F1 still open the key sheet directly).
 *   User guide          the user guide, rendered in the editor (server: GET /api/help/guide and /api/help/shot/<name>.png)
 *   Keyboard shortcuts  the existing hotkey and controls sheet
 *   Troubleshooting     the guide, scrolled to its Troubleshooting section
 *   Open data folder path  shows the data folder and copies its path (a browser cannot open Explorer)
 *   About               version, commit, data folder and log file, with "Copy details" for a bug report
 * Pure rendering lives in helpMarkdown.ts.
 */
import "./help.css";
import { bindDialog } from "./dialog.js";
import { renderMarkdown } from "./helpMarkdown.js";
import { openKeymapEditor } from "./keymapEditor.js";
import { showToast } from "./persistUi.js";

interface About {
  name: string;
  version: string;
  commit: string;
  branch: string;
  dataDir: string;
  logFile: string;
  source: string;
  node: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { id?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
};

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied: ${text}`, "ok");
  } catch {
    showToast(`Could not copy to the clipboard. ${what}: ${text}`, "bad", text);
  }
}

async function getAbout(): Promise<About> {
  const r = await fetch("/api/help/about");
  if (!r.ok) throw new Error(`about: ${r.status}`);
  return (await r.json()) as About;
}

/** One overlay for the guide and About: a title, a Close button and a scrolling body. Escape and a click outside close it. */
function openView(id: string, title: string): { body: HTMLElement; close: () => void } {
  document.getElementById("helpview")?.remove();
  const layer = el("div", { id: "helpview" });
  const card = el("div", { id, className: "hv-card" });
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", title);
  const close = bindDialog(layer);
  const closeBtn = el("button", { id: "helpview-close", type: "button", textContent: "Close", title: "Close (Esc)" });
  closeBtn.addEventListener("click", close);
  const body = el("div", { className: "hv-body" });
  card.append(el("div", { className: "hv-head" }, el("h2", { textContent: title }), closeBtn), body);
  layer.append(card);
  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) close();
  });
  document.body.append(layer);
  closeBtn.focus();
  return { body, close };
}

/** Opens the guide; `anchor` (a heading id such as "troubleshooting") scrolls to that section. */
export async function openGuide(anchor?: string): Promise<void> {
  const { body } = openView("guideview", "Atlas Animator user guide");
  body.classList.add("guide");
  body.textContent = "Loading the guide...";
  try {
    const r = await fetch("/api/help/guide");
    if (!r.ok) throw new Error(r.status === 404 ? "the guide file is missing from this checkout" : `the server answered ${r.status}`);
    body.innerHTML = renderMarkdown(await r.text());
    // In-guide links (#section) scroll inside the overlay instead of changing the page address.
    body.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      const href = a?.getAttribute("href") ?? "";
      if (a && href.startsWith("#")) {
        e.preventDefault();
        body.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: "start" });
      }
    });
    if (anchor) body.querySelector(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: "start" });
  } catch (error) {
    body.textContent = `Could not load the guide: ${(error as Error).message}. The same file is in the design notes`;
  }
}

/** Plain text for a bug report: what is running and where its files and log are. */
export const aboutText = (a: About): string =>
  [`${a.name} ${a.version}`, `Commit: ${a.commit} (${a.branch})`, `Data folder: ${a.dataDir} (${a.source})`, `Log file: ${a.logFile}`, `Node: ${a.node}`, `Browser: ${navigator.userAgent}`].join("\n");

async function openAbout(): Promise<void> {
  const { body } = openView("aboutview", "About Atlas Animator");
  body.textContent = "Loading...";
  try {
    const a = await getAbout();
    const row = (label: string, value: string, copy?: string): HTMLElement => {
      const r = el("div", { className: "hv-row" }, el("span", { className: "hv-k", textContent: label }), el("code", { textContent: value }));
      if (copy) {
        const b = el("button", { type: "button", textContent: "Copy path", title: `Copy the ${label.toLowerCase()} to the clipboard` });
        b.addEventListener("click", () => void copyText(copy, label));
        r.append(b);
      }
      return r;
    };
    const details = el("button", { id: "about-copy", type: "button", className: "btn-primary", textContent: "Copy details", title: "Copy the version, commit, data folder and log path to paste into a bug report" });
    details.addEventListener("click", () => void copyText(aboutText(a), "Details"));
    body.replaceChildren(
      row("Version", a.version),
      row("Commit", `${a.commit} (${a.branch})`),
      row("Data folder", a.dataDir, a.dataDir),
      row("Log file", a.logFile, a.logFile),
      el("p", { className: "hv-note", textContent: "To report a bug: press Copy details, paste it into your message, and attach the log file." }),
      details
    );
  } catch (error) {
    body.textContent = `Could not read the version details: ${(error as Error).message}`;
  }
}

async function copyDataPath(): Promise<void> {
  try {
    const r = await fetch("/api/data");
    if (!r.ok) throw new Error(String(r.status));
    const info = (await r.json()) as { dataDir: string };
    await copyText(info.dataDir, "Data folder path");
  } catch (error) {
    showToast(`Could not read the data folder path: ${(error as Error).message}`, "bad");
  }
}

export interface HelpMenuHooks {
  /** Opens the key sheet (main.ts toggleHelp). */
  keys(): void;
}

export function initHelpMenu(hooks: HelpMenuHooks): void {
  const btn = document.getElementById("helpbtn") as HTMLButtonElement | null;
  if (!btn) return;
  const menu = el("div", { id: "helpmenu", hidden: true });
  menu.setAttribute("role", "menu");
  const close = (): void => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("on");
  };
  const item = (id: string, label: string, title: string, run: () => void): void => {
    const b = el("button", { id, type: "button", textContent: label, title });
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      close();
      run();
    });
    menu.append(b);
  };
  item("help-guide", "User guide", "Open the Atlas Animator user guide in the editor", () => void openGuide());
  item("help-keys", "Keyboard shortcuts", "Hotkeys, mouse gestures and every control (also ? or F1)", hooks.keys);
  item("help-keymap", "Edit keyboard shortcuts", "Rebind any hotkey: search the list, click Rebind and press a key; conflicts ask to swap; Reset restores the built-in key", openKeymapEditor);
  item("help-trouble", "Troubleshooting", "The guide's Troubleshooting section: editor will not open, not saved, two tabs, restore, bug reports", () => void openGuide("troubleshooting"));
  item("help-datapath", "Open data folder path", "Shows where your files are and copies the folder path (paste it into the Windows address bar)", () => void copyDataPath());
  item("help-about", "About", "Version, commit hash, data folder and log file", () => void openAbout());
  document.body.append(menu);
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  const open = (): void => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("on");
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      // Closing the menu must not also clear the bone selection (the global Escape hotkey).
      e.stopPropagation();
      close();
    }
  }, true);
  window.addEventListener("resize", close);
}
