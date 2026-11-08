/*
 * Atlas Animator editor: "Files" (where the user's files live, the data folder setting, Back up now, Restore from backup), the
 * newer-stock-rig banner (Compare / Take theirs / Keep mine) and Ship's "Publish to project folder" dialog. Server side: vite.config.ts
 * (/api/data*, /api/rigs/stock, /api/publish), src/userData.ts and src/rigStore.ts.
 */
import "./dataPanel.css";
import { confirmDialog, openModal } from "./dialog";

interface Backup {
  name: string;
  kind: string;
  bytes: number;
  time: string;
}
interface DataInfo {
  dataDir: string;
  source: "env" | "settings" | "default" | "sandbox";
  defaultDir: string;
  nextStart: string;
  stockRoot: string;
  folders: Record<string, string>;
  userRigs: string[];
  backups: Backup[];
  migrations: { at: string; from: string; copied: Record<string, number>; skipped: number; errors: string[]; backup: string | null }[];
  note: string | null;
}
interface DocCounts {
  bones: number;
  slots: number;
  skins: number;
  animations: number;
  bytes: number;
}
interface StockStatus {
  dir: string;
  changes: { file: string; change: string }[];
  baseUnknown: boolean;
  docs: { file: string; mine: DocCounts | null; theirs: DocCounts | null }[];
}
interface PublishPlan {
  kind: "rig" | "clip";
  name: string;
  target: string;
  added: string[];
  changed: string[];
  unchanged: number;
  onlyInRepo: string[];
  hashes?: Record<string, string>;
  token?: string;
  written?: string[];
  snapshot?: string | null;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = h("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, init?.body === undefined ? { method: init?.method ?? "GET" } : { method: init.method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path} answered ${res.status}`);
  return json;
}
const size = (n: number): string => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string): string => new Date(iso).toLocaleString();

/** A modal with a title, a body and a Close button (src/dialog.ts: Esc closes it wherever focus is, focus returns to the opener). */
function modal(title: string, id: string): { body: HTMLElement; actions: HTMLElement; close: () => void } {
  const m = openModal({ id, title, className: "datapanel" });
  m.body.classList.add("dp-body");
  return { body: m.body, actions: m.actions, close: m.close };
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const s = h("section", "dp-sec");
  s.append(h("h3", "dp-h", title));
  parent.append(s);
  return s;
}

/** The Files dialog. */
export async function openFilesDialog(): Promise<void> {
  const { body } = modal("Files and backups", "datapanel");
  const msg = h("div", "dp-msg");
  body.append(h("p", "dp-note", "Reading..."));
  let info: DataInfo;
  try {
    info = await api<DataInfo>("/api/data");
  } catch (error) {
    body.replaceChildren(h("p", "dp-msg bad", `Could not read the data folder: ${(error as Error).message}`));
    return;
  }
  body.replaceChildren();
  if (info.note) body.append(h("p", "dp-msg bad", info.note));

  const where = section(body, "Where your files live");
  const path = h("code", "dp-path", info.dataDir);
  path.id = "dp-datadir";
  const copy = button("Copy path", () => void navigator.clipboard?.writeText(info.dataDir));
  const row = h("div", "dp-row");
  row.append(path, copy);
  where.append(row);
  const how = { env: "set by ATLAS_EDITOR_DATA_DIR for this run", sandbox: "a throw-away sandbox (this editor was not started by the Atlas Animator launcher; your real files are not here)", settings: "chosen below", default: "the default folder" }[info.source];
  where.append(h("p", "dp-note", `This folder is ${how}. It is outside the project folder, so cleaning, resetting or deleting a worktree never touches it. Clips, history, autosave, poses, smears, exports and your rig working copies (rigs) are all in it.`));
  const list = h("ul", "dp-folders");
  for (const [k, v] of Object.entries(info.folders)) {
    const li = h("li");
    li.append(h("b", undefined, k), " ", h("span", "dp-dim", v));
    list.append(li);
  }
  where.append(list);

  const loc = section(body, "Data folder");
  const input = h("input", "in dp-input");
  input.id = "dp-location";
  input.value = info.nextStart;
  input.spellcheck = false;
  const locMsg = h("div", "dp-msg");
  const setLoc = async (dir: string | null): Promise<void> => {
    locMsg.className = "dp-msg";
    locMsg.textContent = "Saving...";
    try {
      const out = await api<{ dataDir: string; copied: number }>("/api/data/location", { body: { dir } });
      input.value = out.dataDir;
      locMsg.textContent = `Saved. The editor uses ${out.dataDir} after a restart (close this tab and the Start Atlas Animator window, then start it again).${out.copied ? ` Your ${out.copied} current files were copied there; the old folder was left as it is.` : ""}`;
    } catch (error) {
      locMsg.className = "dp-msg bad";
      locMsg.textContent = (error as Error).message;
    }
  };
  const use = button("Use this folder", () => void setLoc(input.value), "btn btn-primary");
  use.id = "dp-location-save";
  const reset = button("Use default", () => void setLoc(null));
  const locRow = h("div", "dp-row");
  locRow.append(input, use, reset);
  if (info.source === "env" || info.source === "sandbox") {
    input.disabled = use.disabled = reset.disabled = true;
    loc.append(locRow, h("p", "dp-note", info.source === "sandbox" ? "This is a sandbox run; the folder cannot be changed here. Start the editor with the Atlas Animator shortcut to use your real files." : "ATLAS_EDITOR_DATA_DIR chooses the folder for this run, so it cannot be changed here."));
  } else {
    loc.append(locRow, h("p", "dp-note", `Default: ${info.defaultDir}. A new, empty folder gets a copy of your current files.`), locMsg);
  }

  const bk = section(body, "Backups");
  bk.append(h("p", "dp-note", "A zip of the whole data folder is made automatically once a day when something changed (the newest 14 are kept). Back up now makes one any time; those are never removed automatically."));
  const now = button("Back up now", () => void doBackup(), "btn btn-primary");
  now.id = "dp-backup";
  const pick = h("select", "dp-select");
  pick.id = "dp-backups";
  const fill = (items: Backup[]): void => {
    pick.replaceChildren(...items.map((b) => {
      const o = h("option", undefined, `${when(b.time)}  ${b.kind}  ${size(b.bytes)}`);
      o.value = b.name;
      return o;
    }));
    if (!items.length) pick.append(h("option", undefined, "No backups yet"));
    restore.disabled = !items.length;
  };
  const restore = button("Restore from backup…", () => void doRestore());
  restore.id = "dp-restore";
  const bkRow = h("div", "dp-row");
  bkRow.append(now, pick, restore);
  bk.append(bkRow, msg);
  fill(info.backups);
  async function doBackup(): Promise<void> {
    msg.className = "dp-msg";
    msg.textContent = "Making the backup...";
    try {
      const b = await api<Backup & { files: number; path: string }>("/api/data/backup", { body: {} });
      msg.textContent = `Backed up ${b.files} files to ${b.path} (${size(b.bytes)}).`;
      fill((await api<DataInfo>("/api/data")).backups);
    } catch (error) {
      msg.className = "dp-msg bad";
      msg.textContent = (error as Error).message;
    }
  }
  async function doRestore(): Promise<void> {
    const name = pick.value;
    if (!name || !(await confirmDialog({ title: `Restore ${name}?`, message: 'Your current files are backed up first (a "before-restore" zip). Files in the backup replace the current files with the same name; files made since the backup stay. Reload the page afterwards.', confirmLabel: "Restore", id: "restore-confirm" }))) return;
    msg.className = "dp-msg";
    msg.textContent = "Restoring...";
    try {
      const r = await api<{ restored: number; before: string }>("/api/data/restore", { body: { name } });
      msg.textContent = `Restored ${r.restored} files from ${name}. Your files from just before are in ${r.before}. Reload the page to see them.`;
      fill((await api<DataInfo>("/api/data")).backups);
    } catch (error) {
      msg.className = "dp-msg bad";
      msg.textContent = (error as Error).message;
    }
  }

  if (info.migrations.length) {
    const mg = section(body, "Moved from the worktree");
    for (const m of info.migrations) {
      const counts = Object.entries(m.copied).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to move";
      mg.append(h("p", "dp-note", `${when(m.at)}: from ${m.from}: ${counts}${m.skipped ? `, ${m.skipped} already here` : ""}${m.errors.length ? `, ${m.errors.length} problem(s)` : ""}. The old files were left in place${m.backup ? `; a zip of them is ${m.backup}` : ""}.`));
    }
  }
}

function countsText(c: DocCounts | null): string {
  return c ? `${c.bones} bones, ${c.slots} slots, ${c.skins} skins, ${c.animations} clips, ${size(c.bytes)}` : "missing";
}

/** The newer-stock-rig banner; checked on load, on focus and every minute. */
export function initStockBanner(): void {
  const bar = h("div", "stockbar");
  bar.id = "stockbar";
  bar.hidden = true;
  bar.setAttribute("role", "status");
  document.body.append(bar);
  const dismissed = new Set<string>();
  let busy = false;
  const check = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { rigs } = await api<{ rigs: StockStatus[] }>("/api/rigs/stock");
      render(rigs.filter((r) => !dismissed.has(`${r.dir}:${r.changes.map((c) => c.file).join(",")}`)));
    } catch {
      // the banner is advisory; a failed check stays quiet
    } finally {
      busy = false;
    }
  };
  const render = (list: StockStatus[]): void => {
    bar.replaceChildren();
    bar.hidden = list.length === 0;
    for (const s of list) {
      const row = h("div", "stockbar-row");
      row.dataset["rig"] = s.dir;
      const out = h("div", "stockbar-out");
      const answer = async (choice: "theirs" | "mine"): Promise<void> => {
        if (choice === "theirs" && !(await confirmDialog({ title: `Take the stock version of ${s.dir}?`, message: "Your copy is moved to backups/replaced-rigs first (nothing is deleted). Reload the page afterwards.", confirmLabel: "Take stock version", id: "stock-confirm" }))) return;
        try {
          const r = await api<{ backup?: string }>("/api/rigs/stock", { body: { dir: s.dir, choice } });
          out.textContent = choice === "theirs" ? `Took the stock ${s.dir}. Your copy is in ${r.backup}. Reload the page to load it.` : `Kept your ${s.dir}. You will be asked again only if the stock version changes again.`;
          row.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
          if (choice === "theirs") row.append(button("Reload", () => location.reload(), "btn btn-primary"));
        } catch (error) {
          out.textContent = (error as Error).message;
        }
      };
      row.append(
        h("span", "stockbar-text", `A newer stock version of the rig "${s.dir}" exists${s.baseUnknown ? " (your copy's starting point is unknown)" : ""}.`),
        button("Compare", () => {
          out.replaceChildren(
            h("div", undefined, `Changed stock files: ${s.changes.map((c) => `${c.file} (${c.change})`).join(", ")}`),
            ...s.docs.map((d) => h("div", undefined, `${d.file}: yours ${countsText(d.mine)}; stock ${countsText(d.theirs)}`))
          );
        }),
        button("Take theirs", () => void answer("theirs")),
        button("Keep mine", () => void answer("mine"), "btn btn-primary"),
        button("Later", () => {
          dismissed.add(`${s.dir}:${s.changes.map((c) => c.file).join(",")}`);
          row.remove();
          bar.hidden = !bar.childElementCount;
        }),
        out
      );
      bar.append(row);
    }
  };
  void check();
  window.addEventListener("focus", () => void check());
  setInterval(() => void check(), 60_000);
}

/** Ship's "Publish to project folder": pick an user rig or a saved clip, see what changes, then copy it into the project folder (no git). */
export async function openPublishDialog(): Promise<void> {
  const { body, actions } = modal("Publish to project folder", "publishdlg");
  body.append(h("p", "dp-note", "Copies one of your rigs or clips from your data folder into your project folder, so you can commit and ship it. It shows what will change first and keeps a copy of the files it replaces. It does not commit or push."));
  let info: DataInfo;
  let clips: string[];
  try {
    [info, clips] = await Promise.all([api<DataInfo>("/api/data"), api<string[]>("/api/clips")]);
  } catch (error) {
    body.append(h("p", "dp-msg bad", (error as Error).message));
    return;
  }
  const pick = h("select", "dp-select");
  pick.id = "publish-what";
  for (const r of info.userRigs) {
    const o = h("option", undefined, `Rig: ${r}`);
    o.value = `rig:${r}`;
    pick.append(o);
  }
  for (const c of clips) {
    const o = h("option", undefined, `Clip: ${c.replace(/\.clip\.json$/, "")}`);
    o.value = `clip:${c}`;
    pick.append(o);
  }
  if (!pick.options.length) pick.append(h("option", undefined, "Nothing to publish yet (edit a rig or save a clip first)"));
  const plan = h("div", "dp-plan");
  plan.id = "publish-plan";
  const go = button("Publish", () => void doPublish(), "btn btn-primary");
  go.id = "publish-go";
  go.disabled = true;
  const check = button("Check what changes", () => void preview());
  check.id = "publish-check";
  const row = h("div", "dp-row");
  row.append(pick, check);
  body.append(row, plan);
  actions.prepend(go);
  const parse = (): { kind: string; name: string } | null => {
    const m = /^(rig|clip):(.+)$/.exec(pick.value);
    return m ? { kind: m[1]!, name: m[2]! } : null;
  };
  pick.addEventListener("change", () => {
    go.disabled = true;
    plan.replaceChildren();
  });
  const describe = (p: PublishPlan): HTMLElement[] => [
    h("div", undefined, `Target: ${info.stockRoot}\\${p.target.split("/").join("\\")}`),
    h("div", undefined, `New files: ${p.added.length ? p.added.join(", ") : "none"}`),
    h("div", undefined, `Changed files: ${p.changed.length ? p.changed.join(", ") : "none"}`),
    h("div", "dp-dim", `Hashes (sha1): ${Object.entries(p.hashes ?? {}).map(([f, x]) => `${f} ${x}`).join(", ") || "none"}`),
    h("div", "dp-dim", `${p.unchanged} unchanged${p.onlyInRepo.length ? `; ${p.onlyInRepo.length} file(s) only in the project folder are left alone` : ""}.`)
  ];
  let token = "";
  async function preview(): Promise<void> {
    const sel = parse();
    if (!sel) return;
    try {
      const p = await api<PublishPlan>(`/api/publish?kind=${sel.kind}&name=${encodeURIComponent(sel.name)}`);
      token = p.token ?? "";
      plan.replaceChildren(...describe(p));
      go.disabled = p.added.length + p.changed.length === 0;
      if (go.disabled) plan.append(h("div", "dp-msg", "The repo already has exactly this; nothing to publish."));
    } catch (error) {
      plan.replaceChildren(h("div", "dp-msg bad", (error as Error).message));
    }
  }
  async function doPublish(): Promise<void> {
    const sel = parse();
    if (!sel) return;
    go.disabled = true;
    try {
      const p = await api<PublishPlan>("/api/publish", { body: { ...sel, token } });
      plan.replaceChildren(
        h("div", "dp-ok", `Wrote ${p.written?.length ?? 0} file(s) into the project folder:`),
        ...(p.written ?? []).map((f) => h("div", "dp-dim", f)),
        h("div", undefined, p.snapshot ? `The repo files it replaced were copied to ${p.snapshot}.` : "No repo files were replaced."),
        h("div", "dp-msg", "Not committed or pushed. A developer commits and pushes these files to ship them in the project.")
      );
    } catch (error) {
      plan.replaceChildren(h("div", "dp-msg bad", (error as Error).message));
      go.disabled = true;
    }
  }
}

/** The header's Files button and the stock banner. */
export function initDataPanel(): void {
  document.getElementById("filesbtn")?.addEventListener("click", () => void openFilesDialog());
  initStockBanner();
}
