/*
 * Atlas Animator editor: the Home screen (the design notes, section 1).
 *
 * Four big cards (Animate a clip, Make a swag item, Rig, Ship), a "Continue" row for the clip last worked on and a strip of recent
 * clips. It talks to the editor only through the host (host.ts) and to the workspaces through `Workspaces`.
 */
import { getHost, whenHost, type EditorHost } from "./host.js";
import { boardSummary } from "./gameClips.js";
import type { WorkspaceId, Workspaces } from "./workspace.js";

const RECENT_KEY = "atlas-editor-recent";
const THUMB_KEY = "atlas-editor-thumbs";
const RECENT_MAX = 8;

/**
 * The hook the clip board (Phase 3) fills in. Until then the Animate card just opens the Animate workspace.
 * Later code: `setClipBoardOpener(() => clipBoard.open())`.
 */
let clipBoardOpener: (() => void) | null = null;
export function setClipBoardOpener(fn: (() => void) | null): void {
  clipBoardOpener = fn;
}
let newRigOpener: (() => void) | null = null;
export function setNewRigOpener(fn: (() => void) | null): void {
  newRigOpener = fn;
}

export function openClipBoard(): void {
  clipBoardOpener?.();
}

// ---- Pure helpers ---------------------------------------------------------------------------------------------------

/** Puts `name` first in the recent list (no duplicates, capped). */
export function pushRecent(list: readonly string[], name: string, max = RECENT_MAX): string[] {
  if (!name) return [...list];
  return [name, ...list.filter((n) => n !== name)].slice(0, max);
}

export interface ClipInfo {
  name: string;
  dirty: boolean;
}

// ---- Recent rigs ----

export interface RecentRig {
  id: string;
  label: string;
  /** The clip that was open in this rig, and the workspace it was last used in (Continue resumes both). */
  clip: string;
  ws: string;
  at: number;
}
const RIGS_KEY = "atlas-editor-recent-rigs";

/** Puts `entry` first (one row per rig id, capped). */
export function pushRecentRig(list: readonly RecentRig[], entry: RecentRig, max = RECENT_MAX): RecentRig[] {
  if (!entry.id) return [...list];
  return [entry, ...list.filter((r) => r.id !== entry.id)].slice(0, max);
}

/** Milestones for one project: what is made so far, so a custom rig is not measured against the stock clip list (). */
export interface MilestoneFacts {
  slots: number;
  bones: number;
  images: number;
  weighted: boolean;
  clips: number;
  checked: boolean;
}
export function milestones(f: MilestoneFacts): { label: string; done: boolean }[] {
  return [
    { label: "Artwork", done: f.images > 0 },
    { label: "Skeleton", done: f.bones > 1 },
    { label: "Weights", done: f.weighted },
    { label: "First clip", done: f.clips > 0 },
    { label: "Validated", done: f.checked }
  ];
}

function readRigs(): RecentRig[] {
  try {
    const v = JSON.parse(localStorage.getItem(RIGS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .flatMap((x): RecentRig[] => {
        const o = x as Partial<RecentRig> | null;
        return o && typeof o.id === "string" && typeof o.label === "string" ? [{ id: o.id, label: o.label, clip: typeof o.clip === "string" ? o.clip : "", ws: typeof o.ws === "string" ? o.ws : "animate", at: typeof o.at === "number" ? o.at : 0 }] : [];
      })
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
function writeRigs(list: readonly RecentRig[]): void {
  try {
    localStorage.setItem(RIGS_KEY, JSON.stringify(list));
  } catch {
    // not remembered
  }
}
const ago = (t: number): string => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Recent names that still exist in the editor's library, newest first. */
export function recentClips(recent: readonly string[], clips: readonly ClipInfo[]): ClipInfo[] {
  const byName = new Map(clips.map((c) => [c.name, c]));
  return recent.flatMap((n) => {
    const c = byName.get(n);
    return c ? [c] : [];
  });
}

/** "unsaved draft" / "saved". */
export function clipState(c: ClipInfo): string {
  return c.dirty ? "unsaved draft" : "saved";
}

// ---- Storage (all wrapped: storage can be unavailable) ----------------------------------------------------------------

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // not remembered
  }
}

function readThumbs(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(THUMB_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeThumb(name: string, url: string, keep: readonly string[]): void {
  try {
    const all = readThumbs();
    all[name] = url;
    for (const k of Object.keys(all)) if (!keep.includes(k) && k !== name) delete all[k];
    localStorage.setItem(THUMB_KEY, JSON.stringify(all));
  } catch {
    // quota or storage unavailable: tiles fall back to the glyph
  }
}

/** A small picture of the character as it stands in the open clip; null when the renderer cannot make one. */
async function captureThumb(host: EditorHost): Promise<string | null> {
  const ch = host.character;
  if (!ch || !host.clipName) return null;
  try {
    const url = await host.app.renderer.extract.base64({ target: ch, resolution: 0.3 });
    const img = new Image();
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error("thumbnail did not load"));
      img.src = url;
    });
    const size = 128;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    if (!g || !img.width || !img.height) return null;
    const k = Math.min(size / img.width, size / img.height);
    g.imageSmoothingEnabled = false;
    g.drawImage(img, (size - img.width * k) / 2, (size - img.height * k) / 2, img.width * k, img.height * k);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

// ---- DOM ------------------------------------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
  animate: ["M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z", "M10 9l5 3-5 3z", "M7 22h10"],
  swag: ["M8.5 3.5 3 6.5l2 4.2 2.2-1V20h9.6V9.7l2.2 1L21 6.5l-5.5-3C15 5 13.8 5.8 12 5.8S9 5 8.5 3.5z"],
  rig: ["M7 7.5l9.5 1.6M7.8 9l2.6 6.4", "M6 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M18 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M10 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"],
  ship: ["M4 8.5 12 4.5l8 4v8l-8 4-8-4z", "M4 8.5l8 4 8-4", "M12 12.5v8"]
};

function icon(kind: string): SVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  for (const d of ICONS[kind] ?? []) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface CardDef {
  go: WorkspaceId;
  title: string;
  blurb: string;
  cta: string;
}

const CARDS: readonly CardDef[] = [
  { go: "animate", title: "Animate a clip", blurb: "Pose the open rig and key a clip.", cta: "Open the animator" },
  { go: "swag", title: "Make a swag item", blurb: "Drop in art and see it on every clip.", cta: "Open the workshop" },
  { go: "rig", title: "Rig", blurb: "Bones, slots and skins for any character.", cta: "Open the rig" },
  { go: "ship", title: "Ship", blurb: "Check, apply, then copy to your project repo.", cta: "Open ship" }
];

/** Builds the Home screen into #home and keeps it current. */
export function createHome(ws: Workspaces): { render(): void } {
  const root = document.getElementById("home")!;
  let recent = readRecent();
  let thumbs = readThumbs();
  let lastWs: WorkspaceId | null = null;
  let rigs = readRigs();

  const open = (name: string) => {
    getHost()?.switchClip(name);
    ws.go("animate");
  };

  function tile(c: ClipInfo, large: boolean): HTMLButtonElement {
    const b = h("button", large ? "home-clip home-clip-large" : "home-clip");
    b.type = "button";
    b.dataset.clip = c.name;
    const pic = h("span", "home-thumb");
    const url = thumbs[c.name];
    if (url) {
      const img = h("img");
      img.src = url;
      img.alt = "";
      pic.append(img);
    } else pic.append(icon("animate"));
    const name = h("span", "home-clip-name", c.name);
    const meta = h("span", c.dirty ? "home-clip-meta dirty" : "home-clip-meta", clipState(c));
    const text = h("span", "home-clip-text");
    text.append(name, meta);
    b.append(pic, text);
    b.addEventListener("click", () => open(c.name));
    return b;
  }

  async function fillProgress(el: HTMLElement): Promise<void> {
    const host = getHost();
    let board: Record<string, never> = {};
    try {
      const r = await fetch("/api/board");
      if (r.ok) {
        const j = (await r.json()) as unknown;
        if (j && typeof j === "object") board = j as Record<string, never>;
      }
    } catch {
      // no dev server: progress comes from the clips alone
    }
    const names = host ? [...host.clips().map((c) => c.name), ...host.saved()] : [];
    const sum = boardSummary(names, board);
    el.textContent = `${sum.counts.done} of ${sum.total} project clips done`;
  }

  function render(): void {
    const host = getHost();
    const clips: ClipInfo[] = host ? host.clips().map((c) => ({ name: c.name, dirty: c.dirty })) : [];
    const list = recentClips(recent, clips);
    const current = host?.clipName ? clips.find((c) => c.name === host.clipName) : undefined;
    const resume = list[0] ?? current;

    const wrap = h("div", "home-inner");
    const hero = h("div", "home-hero");
    hero.append(h("h2", undefined, "What are we making?"), h("p", undefined, "Pick a job. Each one shows only the tools it needs."));
    wrap.append(hero);

    const cards = h("div", "home-cards five");
    for (const def of CARDS) {
      const b = h("button", `home-card c-${def.go}`);
      b.type = "button";
      b.dataset.go = def.go;
      const badge = h("span", "home-badge");
      badge.append(icon(def.go));
      const title = h("span", "home-card-title", def.title);
      const blurb = h("span", "home-card-blurb", def.blurb);
      const cta = h("span", "home-card-cta", def.cta);
      b.append(badge, title, blurb, cta);
      b.addEventListener("click", () => {
        ws.go(def.go);
        if (def.go === "animate") openClipBoard();
      });
      cards.append(b);
    }
    {
      // New rig is the fifth job card: one of the two things a rigger does first.
      const b = h("button", "home-card c-rig home-card-new");
      b.type = "button";
      b.id = "home-newrig";
      b.dataset.go = "newrig";
      b.title = "Make a new rig from PNG parts or a PSD, on a blank skeleton or the player skeleton";
      const badge = h("span", "home-badge");
      badge.append(icon("rig"));
      b.append(badge, h("span", "home-card-title", "New rig"), h("span", "home-card-blurb", "Start a character from your own art: PNG parts or a PSD."), h("span", "home-card-cta", "Create a rig"));
      b.addEventListener("click", () => {
        ws.go("rig");
        newRigOpener?.();
      });
      cards.append(b);
    }
    wrap.append(cards);

    const resumeRig = rigs[0];
    if (resumeRig || resume) {
      const sec = h("section", "home-continue");
      sec.id = "home-continue";
      sec.append(h("span", "home-label", "Continue where you left off"));
      if (resumeRig) {
        const b = h("button", "btn btn-primary home-continue-rig", `Continue: ${resumeRig.label}${resumeRig.clip ? `, clip ${resumeRig.clip}` : ""}, in ${resumeRig.ws[0]!.toUpperCase()}${resumeRig.ws.slice(1)}`);
        b.type = "button";
        b.id = "home-continue-rig";
        b.title = "Opens this rig, then the clip and workspace you last used it in";
        b.addEventListener("click", () => void resumeFrom(resumeRig));
        sec.append(b);
      } else if (resume) {
        const t = tile(resume, true);
        t.classList.add("home-continue-btn");
        sec.append(t);
      }
      wrap.append(sec);
    }

    // Recent rigs (): name, last opened, clip, and whether it has unsaved work.
    const rigSec = h("section", "home-recent");
    rigSec.id = "home-recent-rigs";
    rigSec.append(h("span", "home-label", "Recent rigs"));
    const rigRow = h("div", "home-recent-row");
    const nowRig = host?.rig?.outfit.id;
    const st = host?.shipState();
    if (!rigs.length) rigRow.append(h("span", "home-empty", "No rigs opened yet. Make one with New rig, or open a rig in the Rig workspace."));
    for (const r of rigs) {
      const b = h("button", "home-clip");
      b.type = "button";
      b.dataset.rig = r.id;
      b.title = `Open ${r.label}${r.clip ? ` and clip ${r.clip}` : ""} in ${r.ws}`;
      const pic = h("span", "home-thumb");
      pic.append(icon("rig"));
      const text = h("span", "home-clip-text");
      const open = r.id === nowRig;
      const unsaved = open && !!st?.rigUnsaved;
      text.append(h("span", "home-clip-name", r.label), h("span", unsaved ? "home-clip-meta dirty" : "home-clip-meta", `${open ? "open now" : ago(r.at)}${r.clip ? `, clip ${r.clip}` : ""}${unsaved ? ", unsaved edits" : ""}`));
      b.append(pic, text);
      b.addEventListener("click", () => void resumeFrom(r));
      rigRow.append(b);
    }
    rigSec.append(rigRow);
    wrap.append(rigSec);

    const rest = list.filter((c) => c.name !== resume?.name);
    const strip = h("section", "home-recent");
    strip.append(h("span", "home-label", "Recent clips"));
    const row = h("div", "home-recent-row");
    if (rest.length) for (const c of rest) row.append(tile(c, false));
    else {
      // Nothing to list: point at the controls that make clips, and show where the board stands.
      row.classList.add("home-recent-empty");
      const none = h("span", "home-empty", list.length ? "Open other clips and they will line up here." : "No clips opened yet. The Clip board lists a sample set of clips (optional); open one there, or use New clip.");
      const go = h("button", "btn btn-primary", "Open the Clip board");
      go.type = "button";
      go.id = "home-open-board";
      go.addEventListener("click", () => {
        ws.go("animate");
        openClipBoard();
      });
      const prog = h("span", "chip home-progress", "Reading the board...");
      prog.id = "home-progress";
      row.append(none, go, prog);
      void fillProgress(prog);
    }
    strip.append(row);
    wrap.append(strip);

    if (!list.length && !current) {
      // First run: the three steps, so the cards above are not the only hint.
      const steps = h("section", "home-steps");
      steps.append(h("span", "home-label", "How a clip gets to your project"));
      const ol = h("ol", "home-steps-list");
      for (const [n, title, text] of [
        ["1", "Pick a clip", "The Clip board lists a sample set of clips. Open one to start, or make your own with New clip."],
        ["2", "Pose and key", "Move a bone, press K to key it, Space to play. Every key is in the ? sheet."],
        ["3", "Mark done and ship", "Mark done on the Animate bar, then Ship sends it to your project."]
      ] as const) {
        const li = h("li", "home-step");
        li.append(h("span", "home-step-n", n), h("span", "home-step-title", title), h("span", "home-step-text", text));
        ol.append(li);
      }
      steps.append(ol);
      wrap.append(steps);
    }

    // Recovery and per-project progress (PR-07): what can I get back, and how far along is this rig.
    const rec = h("section", "home-recent");
    rec.id = "home-recovery";
    rec.append(h("span", "home-label", "Recover and progress"));
    const recRow = h("div", "home-recent-row home-recovery-row");
    const auto = h("button", "btn", "Recover autosave");
    auto.type = "button";
    auto.id = "home-recover";
    auto.title = "Looks for autosaves newer than your saved files and offers them back (nothing is restored until you choose)";
    const note = h("span", "home-empty");
    note.id = "home-recover-note";
    auto.addEventListener("click", () => {
      const e = window.atlasEditor as { offerRestore?: () => Promise<unknown[]> } | undefined;
      void e?.offerRestore?.().then((items) => {
        note.textContent = items.length ? `${items.length} autosave(s) offered in the bar at the top.` : "No autosave is newer than your saved files.";
      });
    });
    const del = h("button", "btn", "Recently deleted clips");
    del.type = "button";
    del.id = "home-deleted";
    del.title = "Restore a clip you deleted, from its saved versions (the newest 50 of each are kept)";
    del.addEventListener("click", () => {
      ws.go("animate");
      openClipBoard();
      window.setTimeout(() => document.getElementById("cb-deleted")?.click(), 150);
    });
    recRow.append(auto, del, note);
    rec.append(recRow);
    const ms = h("div", "home-milestones");
    ms.id = "home-milestones";
    if (host?.rig) {
      const doc = host.rig.doc as unknown as { slots?: unknown[]; bones?: unknown[]; skins?: Record<string, Record<string, Record<string, unknown>>> };
      const images = Object.values(doc.skins ?? {}).reduce((n, sk) => n + Object.values(sk ?? {}).reduce((m, s) => m + Object.keys(s ?? {}).length, 0), 0);
      const weighted = host.meshes().some((m) => (m as { weighted?: boolean }).weighted ?? false);
      const facts: MilestoneFacts = { slots: doc.slots?.length ?? 0, bones: doc.bones?.length ?? 0, images, weighted, clips: clips.length + host.saved().length, checked: false };
      ms.append(h("span", "home-label", `Progress for ${host.rig.outfit.label}`));
      for (const m of milestones(facts)) {
        const c = h("span", m.done ? "chip-ok" : "chip", `${m.done ? "Done" : "To do"}: ${m.label}`);
        c.dataset.milestone = m.label;
        ms.append(c);
      }
      rec.append(ms);
    }
    wrap.append(rec);

    const foot = h("p", "home-foot");
    const pro = h("button", "btn btn-ghost sm", "Open Pro");
    pro.type = "button";
    pro.id = "home-pro";
    pro.title = "Pro: every tab and tool in one place";
    pro.addEventListener("click", () => ws.go("pro"));
    foot.append(
      "Shift+H comes back here from anywhere; Alt+1 to Alt+6 jump between workspaces. ",
      lastWs ? `Last workspace: ${lastWs[0]!.toUpperCase()}${lastWs.slice(1)}. ` : "",
      "Pro has every tool: ",
      pro
    );
    wrap.append(foot);

    root.replaceChildren(wrap);
  }

  async function resumeFrom(r: RecentRig): Promise<void> {
    const host = getHost();
    if (!host) return;
    if (host.rig?.outfit.id !== r.id) await host.mountOutfit(r.id);
    if (r.clip && host.clips().some((c) => c.name === r.clip)) host.switchClip(r.clip);
    ws.go((["animate", "swag", "rig", "ship", "pro"].includes(r.ws) ? r.ws : "animate") as WorkspaceId);
  }

  // Remember clips and rigs as they are opened.
  whenHost((host) => {
    const note = () => {
      if (host.rig) {
        const here = ws.current();
        const where = here !== "home" ? here : (lastWs ?? "animate");
        rigs = pushRecentRig(rigs, { id: host.rig.outfit.id, label: host.rig.outfit.label, clip: host.clipName, ws: where, at: Date.now() });
        writeRigs(rigs);
      }
      if (!host.clipName) return;
      recent = pushRecent(recent, host.clipName);
      writeRecent(recent);
    };
    note();
    host.on("clip", note);
    host.on("rig", note);
  });

  ws.onChange((id, from) => {
    // Phone preview needs a clip: not on Home.
    const phone = document.getElementById("phonebtn");
    if (phone) phone.hidden = id === "home";
    if (from && from !== "home") lastWs = from;
    const hh = getHost();
    if (id !== "home" && hh?.rig) {
      // The workspace in use is part of the resume context.
      rigs = pushRecentRig(rigs, { id: hh.rig.outfit.id, label: hh.rig.outfit.label, clip: hh.clipName, ws: id, at: Date.now() });
      writeRigs(rigs);
    }
    if (id === "home") {
      rigs = readRigs();
      render();
      const host = getHost();
      // A thumbnail of the clip just left, drawn once the screen is up.
      if (host && from && from !== "home") {
        const name = host.clipName;
        void captureThumb(host).then((url) => {
          if (!url || !name) return;
          thumbs[name] = url;
          writeThumb(name, url, recent);
          if (ws.current() === "home") render();
        });
      }
    }
  });

  return { render };
}
