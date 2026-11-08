/*
 * Atlas Animator editor: original implementation.
 *
 * The History panel (browse the autosave versions of the clip being edited, preview one, restore it) and the Restore bar
 * shown at startup when an autosave is newer than the saved file. DOM only: the editor passes what each button does.
 */
import { ago, describeFlags, newerThanSaved, versionTime, type SavedTimes, type VersionInfo } from "./autosaveModel.js";

export interface Listing {
  clips: Record<string, VersionInfo[]>;
  saved: SavedTimes;
}

export interface HistoryHost {
  clipName(): string;
  /** The version being previewed (clip + id), if any. */
  previewing(): { clip: string; id: string } | null;
  autosaveInfo(): { intervalMs: number; writes: number; lastAt: number | null; failures: number };
  preview(clip: string, id: string): Promise<void>;
  exitPreview(): void;
  restore(clip: string, id: string, withRig: boolean): Promise<void>;
  saveNow(): Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  for (const c of children) node.append(c);
  return node;
};

export async function fetchListing(): Promise<Listing> {
  const res = await fetch("/api/autosave");
  if (!res.ok) throw new Error(`autosave list: HTTP ${res.status}`);
  return (await res.json()) as Listing;
}

/** Local clock time of a version, with the date when it is not today. */
export function whenLabel(time: number, now = Date.now()): string {
  const d = new Date(time);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? clock : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function createHistoryPanel(box: HTMLElement, host: HistoryHost) {
  let listing: Listing | null = null;
  let error: string | null = null;

  function render(): void {
    box.replaceChildren();
    const name = host.clipName();
    const info = host.autosaveInfo();
    const refresh = el("button", { textContent: "Refresh", title: "Reload the version list" });
    refresh.addEventListener("click", () => void load());
    const now = el("button", { id: "autosavenow", textContent: "Autosave now", title: "Write a version of the working clip and unsaved rig edits now (they are also written every minute and when you switch clips)" });
    now.addEventListener("click", () => void host.saveNow().then(load));
    box.append(el("h2", { textContent: "History" }), el("div", { className: "row", style: "margin-top: 0" }, now, refresh));
    box.append(
      el("div", { className: "note", id: "autosavenote", textContent: `Autosave every ${Math.round(info.intervalMs / 1000)} s and on clip switch, newest 30 per clip. ${info.writes} written this session${info.lastAt ? `, last ${ago(Date.now() - info.lastAt)}` : ""}${info.failures ? `, ${info.failures} failed` : ""}.` })
    );
    const previewing = host.previewing();
    if (previewing) {
      const exit = el("button", { id: "exitpreview", textContent: "Exit preview" });
      exit.addEventListener("click", () => host.exitPreview());
      box.append(el("div", { className: "gate", textContent: `Previewing ${previewing.clip} from ${whenLabel(versionTime(previewing.id))}. Editing is paused. ` }, exit));
    }
    if (error) {
      box.append(el("div", { className: "note", textContent: `History unavailable: ${error}` }));
      return;
    }
    const versions = listing?.clips[name] ?? [];
    const list = el("div", { className: "versionlist", id: "versionlist" });
    for (const v of versions) {
      const on = previewing?.clip === name && previewing.id === v.id;
      const row = el("div", { className: `version${on ? " on" : ""}` });
      row.dataset.version = v.id;
      const preview = el("button", { textContent: on ? "Previewing" : "Preview", title: "Show this version in the view and timeline without changing the clip" });
      preview.disabled = on;
      preview.addEventListener("click", () => void host.preview(name, v.id));
      const restore = el("button", { textContent: "Restore", title: "Replace the working clip with this version (one undo step; the current state is autosaved first)" });
      restore.addEventListener("click", () => void host.restore(name, v.id, false).then(load));
      const actions = el("div", { className: "row", style: "margin-top: 3px" }, preview, restore);
      if (v.flags.includes("s") || v.flags.includes("u")) {
        const withRig = el("button", { textContent: "Restore + rig edits", title: "Also bring back the unsaved skin / Setup edits stored with this version" });
        withRig.addEventListener("click", () => void host.restore(name, v.id, true).then(load));
        actions.append(withRig);
      }
      row.append(
        el("div", { className: "label", textContent: `${whenLabel(v.time)}  (${ago(Date.now() - v.time)})`, title: v.id }),
        el("div", { className: "note", textContent: `${describeFlags(v.flags)}, ${v.outfit}, ${(v.bytes / 1024).toFixed(1)} KB` }),
        actions
      );
      list.append(row);
    }
    if (!versions.length) list.append(el("div", { className: "note", textContent: listing ? `No autosaves of ${name} yet. They appear once the clip has unsaved changes.` : "Loading..." }));
    box.append(list);
  }

  async function load(): Promise<void> {
    try {
      listing = await fetchListing();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  }

  return { load, render, listing: () => listing };
}

export type HistoryPanel = ReturnType<typeof createHistoryPanel>;

export interface OfferItem {
  clip: string;
  version: VersionInfo;
  clipNewer: boolean;
  rigNewer: boolean;
}

/** The clips whose newest autosave is newer than the saved file (`rigDocumentOf` maps an outfit id to its rig document). */
export function offersFrom(listing: Listing, rigDocumentOf: (outfit: string) => string | null, dismissed: ReadonlySet<string>): OfferItem[] {
  const out: OfferItem[] = [];
  for (const [clip, versions] of Object.entries(listing.clips)) {
    const latest = versions[0];
    if (!latest || dismissed.has(`${clip}/${latest.id}`)) continue;
    const n = newerThanSaved(clip, latest, rigDocumentOf(latest.outfit), listing.saved);
    if (n.clip || n.rig) out.push({ clip, version: latest, clipNewer: n.clip, rigNewer: n.rig });
  }
  return out;
}

/** The bar at the top of the window: "Restore" brings the autosaved clips (and rig edits) back, "Dismiss" asks no more about these versions. */
export function showRestoreBar(bar: HTMLElement, items: OfferItem[], actions: { restore(items: OfferItem[]): Promise<void>; dismiss(items: OfferItem[]): void; history(): void }): void {
  bar.replaceChildren();
  bar.hidden = items.length === 0;
  if (!items.length) return;
  const names = items.map((i) => `${i.clip} (${whenLabel(i.version.time)}${i.rigNewer ? ", with rig edits" : ""})`).join(", ");
  const restore = el("button", { id: "restorebtn", textContent: "Restore" });
  restore.addEventListener("click", () => void actions.restore(items));
  const history = el("button", { id: "restorehistory", textContent: "History" });
  history.addEventListener("click", () => actions.history());
  const dismiss = el("button", { id: "restoredismiss", textContent: "Dismiss" });
  dismiss.addEventListener("click", () => actions.dismiss(items));
  bar.append(el("span", { id: "restoretext", textContent: `Unsaved work found: an autosave is newer than the saved file for ${names}. ` }), restore, history, dismiss);
}
