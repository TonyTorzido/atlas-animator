/*
 * Atlas Animator editor: the honest-failure UI around saving (browser only).
 *
 * - toasts: non-blocking messages bottom-right; errors carry "Copy details" (installErrorToasts catches window errors and
 *   unhandled promise rejections so nothing fails silently);
 * - installUnloadGuard: the browser's "leave site?" prompt while there is unsaved work;
 * - conflictDialog: a clip save refused with 409 (another tab/window saved it): Reload theirs / Overwrite with mine / Save mine as a copy;
 * - versionsDialog: the rolling snapshots of a clip or rig file (GET /api/history) with Restore (POST /api/history/restore);
 * - apiError: the message of a failed API answer ({ error } JSON, or its text).
 */

import { bindDialog, confirmDialog as confirmBase } from "./dialog.js";

const STYLE = `
.pu-toasts{position:fixed;right:16px;bottom:16px;z-index:10050;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}
.pu-toast{pointer-events:auto;background:var(--panel);color:var(--text-hi);border:1px solid var(--line2);border-left:4px solid var(--accent2);border-radius:8px;padding:10px 12px;font:var(--fs-md)/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.pu-toast.bad{border-left-color:var(--bad)}.pu-toast.ok{border-left-color:var(--ok)}
.pu-toast-row{display:flex;gap:8px;margin-top:8px;justify-content:flex-end}
.pu-toast button,.pu-dialog button{font:var(--fs-sm) system-ui,sans-serif;height:var(--ctl-sm);padding:0 10px;border-radius:6px;border:1px solid var(--line3);background:var(--panel3);color:var(--text-hi);cursor:pointer}
.pu-toast button:hover,.pu-dialog button:hover{background:var(--line2)}
.pu-layer{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.pu-dialog{background:var(--panel);color:var(--text-hi);border:1px solid var(--line2);border-radius:10px;padding:16px 18px;width:min(520px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;font:var(--fs-md)/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.pu-dialog h3{margin:0 0 8px;font-size:var(--fs-lg)}
.pu-dialog p{margin:0 0 10px;color:var(--text2)}
.pu-dialog .pu-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:10px}
.pu-dialog button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.pu-dialog button.danger{background:var(--bad-bg);border-color:var(--bad-line);color:var(--bad-hi)}
.pu-list{overflow:auto;border:1px solid var(--line2);border-radius:6px;min-height:40px}
.pu-item{display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid var(--line)}
.pu-item:last-child{border-bottom:0}.pu-item span{flex:1}.pu-item small{color:var(--dim)}
`;

function ensureStyle(): void {
  if (document.getElementById("pu-style")) return;
  const s = document.createElement("style");
  s.id = "pu-style";
  s.textContent = STYLE;
  document.head.append(s);
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

function button(label: string, className = ""): HTMLButtonElement {
  const b = make("button", className, label);
  b.type = "button";
  return b;
}

/** Shows a toast. Errors stay until dismissed; others fade after a few seconds. */
export function showToast(message: string, kind: "" | "ok" | "bad" = "", details?: string): HTMLElement {
  ensureStyle();
  let box = document.querySelector<HTMLElement>(".pu-toasts");
  if (!box) {
    box = make("div", "pu-toasts");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  while (box.children.length >= 4) box.firstElementChild?.remove();
  const t = make("div", `pu-toast ${kind}`.trim());
  t.setAttribute("role", kind === "bad" ? "alert" : "status");
  t.append(make("div", "pu-toast-msg", message));
  const row = make("div", "pu-toast-row");
  if (details) {
    const copy = button("Copy details");
    copy.dataset.act = "copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(details).then(
        () => (copy.textContent = "Copied"),
        () => (copy.textContent = "Copy failed")
      );
    });
    row.append(copy);
  }
  const dismiss = button("Dismiss");
  dismiss.dataset.act = "dismiss";
  dismiss.addEventListener("click", () => t.remove());
  row.append(dismiss);
  t.append(row);
  box.append(t);
  if (kind !== "bad") setTimeout(() => t.remove(), 6000);
  return t;
}

const IGNORED = /ResizeObserver loop|Script error\.?$/;
let installed = false;

/** Turns uncaught errors and unhandled promise rejections into an error toast (once per message within a second). */
export function installErrorToasts(): void {
  if (installed) return;
  installed = true;
  let last = "";
  let lastAt = 0;
  const report = (what: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
    if (IGNORED.test(message)) return;
    const now = Date.now();
    if (message === last && now - lastAt < 1000) return;
    last = message;
    lastAt = now;
    const stack = error instanceof Error && error.stack ? error.stack : "";
    const details = [`${what}: ${message}`, stack, `page: ${location.href}`, `time: ${new Date().toISOString()}`, `browser: ${navigator.userAgent}`].filter(Boolean).join("\n");
    const offline = /Failed to fetch|NetworkError|Load failed/i.test(message);
    showToast(offline ? "The editor server is not answering (is it still running?). Your work is still in this tab: do not close it." : `Something went wrong: ${message}`, "bad", details);
  };
  window.addEventListener("error", (e) => report("Error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => report("Unhandled promise rejection", e.reason));
}

/**
 * Asks the browser to confirm leaving while `hasUnsaved()` is true. Off under automation (navigator.webdriver: scripted demos reload
 * pages) unless window.__atlasForceUnloadGuard is set (the persistence QA turns it on to test the guard).
 */
export function installUnloadGuard(hasUnsaved: () => boolean): void {
  window.addEventListener("beforeunload", (e) => {
    if (navigator.webdriver && !(window as { __atlasForceUnloadGuard?: boolean }).__atlasForceUnloadGuard) return;
    let unsaved = false;
    try {
      unsaved = hasUnsaved();
    } catch {
      unsaved = true;
    }
    if (!unsaved) return;
    e.preventDefault();
    e.returnValue = "You have unsaved changes.";
  });
}

/** The message of a failed API answer. */
export async function apiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j?.error === "string") return j.error;
  } catch {
    // not JSON
  }
  return text || `${res.status} ${res.statusText}`;
}

function dialog(title: string, id: string, onEsc?: () => void): { layer: HTMLElement; box: HTMLElement; close: () => void } {
  ensureStyle();
  document.getElementById(id)?.parentElement?.remove();
  const layer = make("div", "pu-layer");
  const box = make("div", "pu-dialog");
  box.id = id;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.append(make("h3", "", title));
  layer.append(box);
  document.body.append(layer);
  const close = bindDialog(layer, () => {
    layer.remove();
    onEsc?.();
  });
  return { layer, box, close };
}

export type ConflictChoice = "reload" | "overwrite" | "copy" | "cancel";

/** The two-tabs dialog for a clip save refused with 409. */
export function conflictDialog(clip: string, detail: string): Promise<ConflictChoice> {
  return new Promise((done) => {
    const { box, close } = dialog("This clip changed in another tab/window", "pu-conflict", () => done("cancel"));
    box.append(make("p", "", `${clip}: ${detail}. Saving now would overwrite that version.`));
    box.append(make("p", "", "Reload theirs drops your edits here. Overwrite with mine replaces the file (the other version is kept under Versions). Save mine as a copy keeps both."));
    const row = make("div", "pu-row");
    const pick = (choice: ConflictChoice) => () => {
      done(choice);
      close();
    };
    for (const [label, choice, cls] of [
      ["Cancel", "cancel", ""],
      ["Reload theirs", "reload", ""],
      ["Save mine as a copy", "copy", ""],
      ["Overwrite with mine", "overwrite", "danger"]
    ] as const) {
      const b = button(label, cls);
      b.dataset.act = choice;
      b.addEventListener("click", pick(choice));
      row.append(b);
    }
    box.append(row);
    (row.querySelector('[data-act="copy"]') as HTMLButtonElement).focus();
  });
}

export type RigConflictChoice = "reload" | "overwrite" | "download" | "cancel";

/** The stale-rig dialog for a Save rig refused with 409 (): every choice acts on this tab's unsaved Setup edits. */
export function rigConflictDialog(rig: string, detail: string): Promise<RigConflictChoice> {
  return new Promise((done) => {
    const { box, close } = dialog("This rig changed in another tab/window", "pu-rig-conflict", () => done("cancel"));
    box.append(make("p", "", `${rig}: ${detail}. Your unsaved Setup edits are still in this tab.`));
    box.append(
      make("p", "", "Download my edits saves them as a recovery file and keeps them here. Apply mine on theirs replays your edits on top of the newer file (refused as a whole if they no longer fit). Reload theirs keeps an autosave of this tab in History, then reloads.")
    );
    const row = make("div", "pu-row");
    for (const [label, choice, cls, tip] of [
      ["Cancel", "cancel", "", "Keep the edits here unsaved and do nothing"],
      ["Download my edits", "download", "", "Download the unsaved Setup edits, imported images and skins as a recovery JSON file"],
      ["Reload theirs", "reload", "", "Autosave this tab to History, then reload the page to read the newer rig"],
      ["Apply mine on theirs", "overwrite", "danger", "Replay the unsaved Setup edits on top of the newer rig file"]
    ] as const) {
      const b = button(label, cls);
      b.dataset.act = choice;
      b.title = tip;
      b.addEventListener("click", () => {
        done(choice);
        close();
      });
      row.append(b);
    }
    box.append(row);
    (row.querySelector('[data-act="download"]') as HTMLButtonElement).focus();
  });
}

/** Downloads `data` as a pretty JSON file. */
export function downloadJson(file: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 1)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A yes/no confirm in the same style; resolves true on the confirm button. */
export function confirmDialog(title: string, text: string, confirm: string, danger = true, o: { lines?: readonly string[]; id?: string } = {}): Promise<boolean> {
  return confirmBase({ title, message: text, confirmLabel: confirm, danger, id: o.id ?? "pu-confirm", ...(o.lines ? { lines: o.lines } : {}) });
}

export interface VersionsSpec {
  kind: "clip" | "rig";
  /** `<name>.clip.json`, or the repo-relative rig document. */
  file: string;
  /** Extra warning in the restore confirm (e.g. unsaved edits that the restore replaces). */
  restoreNote?: () => string;
  /** Runs after the confirm and before the restore request; false cancels the restore (e.g. the unsaved work could not be kept). */
  beforeRestore?: () => Promise<boolean>;
  /** Called after a restore with the new file hash. */
  onRestored?: (hash: string) => void | Promise<void>;
}

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** Lists the saved versions (snapshots) of a clip or rig and restores one. */
export async function versionsDialog(spec: VersionsSpec): Promise<void> {
  const name = spec.file.split("/").pop() ?? spec.file;
  const { box, close } = dialog(`Versions of ${name}`, "pu-versions");
  box.append(make("p", "", "A copy is kept each time the file is overwritten (newest 50). Restoring keeps the current file as a version too."));
  const list = make("div", "pu-list");
  list.append(make("div", "pu-item", "Loading..."));
  box.append(list);
  const row = make("div", "pu-row");
  const done = button("Close");
  done.dataset.act = "close";
  done.addEventListener("click", close);
  row.append(done);
  box.append(row);
  done.focus();
  const load = async (): Promise<void> => {
    const res = await fetch(`/api/history?kind=${spec.kind}&file=${encodeURIComponent(spec.file)}`);
    if (!res.ok) {
      list.replaceChildren(make("div", "pu-item", `Could not list versions: ${await apiError(res)}`));
      return;
    }
    const { versions } = (await res.json()) as { versions: { id: string; time: string; size: number }[] };
    list.replaceChildren();
    if (!versions.length) list.append(make("div", "pu-item", "No versions yet: one is kept the next time this file is overwritten."));
    for (const v of versions) {
      const item = make("div", "pu-item");
      item.dataset.id = v.id;
      const label = make("span", "", new Date(v.time).toLocaleString());
      const restore = button("Restore");
      restore.dataset.act = "restore";
      restore.addEventListener("click", () => {
        void (async () => {
          const note = spec.restoreNote?.() ?? "";
          if (!(await confirmDialog(`Restore ${name}?`, `Replace the saved file with the version from ${new Date(v.time).toLocaleString()}? The current file is kept as a version.${note ? ` ${note}` : ""}`, "Restore", false))) return;
          if (spec.beforeRestore && !(await spec.beforeRestore())) return;
          const r = await fetch("/api/history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: spec.kind, file: spec.file, id: v.id }) });
          if (!r.ok) {
            showToast(`Restore failed: ${await apiError(r)}`, "bad");
            return;
          }
          const { hash } = (await r.json()) as { hash: string };
          showToast(`Restored ${name} to ${new Date(v.time).toLocaleString()}`, "ok");
          close();
          await spec.onRestored?.(hash);
        })();
      });
      item.append(label, make("small", "", fmtSize(v.size)), restore);
      list.append(item);
    }
  };
  await load().catch((error: unknown) => list.replaceChildren(make("div", "pu-item", `Could not list versions: ${error instanceof Error ? error.message : String(error)}`)));
}

/**
 * Recently deleted clips (): the clips whose file is gone but whose rolling versions (clips/.history/, newest 50 each) are still
 * on disk. Restore writes the newest version back as the clip file; Versions... opens that clip's full version list instead.
 */
export async function deletedClipsDialog(onRestored: (file: string) => void | Promise<void>): Promise<void> {
  const { box, close } = dialog("Recently deleted clips", "pu-deleted");
  box.append(make("p", "", "Deleting a clip keeps its last saved versions (the newest 50). Restore brings the newest one back as the clip file; Versions... lets you pick an older one."));
  const list = make("div", "pu-list");
  list.append(make("div", "pu-item", "Loading..."));
  box.append(list);
  const row = make("div", "pu-row");
  const done = button("Close");
  done.dataset.act = "close";
  done.addEventListener("click", close);
  row.append(done);
  box.append(row);
  done.focus();
  const load = async (): Promise<void> => {
    const res = await fetch("/api/history/deleted");
    if (!res.ok) {
      list.replaceChildren(make("div", "pu-item", `Could not list deleted clips: ${await apiError(res)}`));
      return;
    }
    const { deleted } = (await res.json()) as { deleted: { file: string; time: string; versions: number }[] };
    list.replaceChildren();
    if (!deleted.length) list.append(make("div", "pu-item", "Nothing deleted lately: a deleted clip shows up here with its saved versions."));
    for (const d of deleted) {
      const item = make("div", "pu-item");
      item.dataset.file = d.file;
      const name = make("span", "", d.file.replace(/\.clip\.json$/, ""));
      const when = make("small", "", `${new Date(d.time).toLocaleString()} (${d.versions} version${d.versions === 1 ? "" : "s"})`);
      const restore = button("Restore");
      restore.dataset.act = "restore";
      restore.title = `Bring ${d.file} back from its newest saved version`;
      restore.addEventListener("click", () => {
        void (async () => {
          const vres = await fetch(`/api/history?kind=clip&file=${encodeURIComponent(d.file)}`);
          const id = vres.ok ? ((await vres.json()) as { versions: { id: string }[] }).versions[0]?.id : undefined;
          if (!id) return void showToast(`No saved version of ${d.file} was found`, "bad");
          const r = await fetch("/api/history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "clip", file: d.file, id }) });
          if (!r.ok) return void showToast(`Restore failed: ${await apiError(r)}`, "bad");
          showToast(`Restored ${d.file}`, "ok");
          item.remove();
          await onRestored(d.file);
        })();
      });
      const versions = button("Versions...");
      versions.dataset.act = "versions";
      versions.title = `Pick an older saved version of ${d.file}`;
      versions.addEventListener("click", () => {
        close();
        void versionsDialog({ kind: "clip", file: d.file, onRestored: () => onRestored(d.file) });
      });
      item.append(name, when, versions, restore);
      list.append(item);
    }
  };
  await load().catch((error: unknown) => list.replaceChildren(make("div", "pu-item", `Could not list deleted clips: ${error instanceof Error ? error.message : String(error)}`)));
}
