/*
 * Atlas Animator editor: the Swag workshop (the design notes, section 3).
 *
 * Lives in the left column of the Swag workspace (the bone list is hidden there): every item skin of both pro rigs grouped by slot with a
 * thumbnail and per-view coverage, Wear it (canvas and phone dock through host.setActiveSkins), plain-English check chips, and the New
 * item flow (paper-doll slot picker, name, drop PNG pieces, auto-map by file name, drag leftovers onto a body part, nudge, save). The
 * item contact sheet opens over the canvas. Rendering is off-screen (contactSheet.ts); saving goes through planAttachImage,
 * /api/rig/save and /api/skins.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { clipRows, FRAME_LABELS, pageCount, pageOfRow, pageRows, ROW_GAP, rowHeightFor, rowsThatFit, SHEET_COLUMNS, sheetFrames, SHEET_SCALE, sweepRows, type SheetRow } from "./contactSheetModel.js";
import { createSheetRenderer, loadViews, type SheetRenderer, type ViewData } from "./contactSheet.js";
import { loadRgbaImage, type RgbaImage } from "@atlas-animator/core/pixi";
import { objOf, runBatch, type JsonObject } from "./setupModel.js";
import { frameTime, parseClip, timeToFrame } from "./clipModel.js";
import { clipGates, type GateIssue } from "./gates.js";
import { OUTFITS, SAVE_DIR } from "./fixtures.js";
import { getHost, whenHost } from "./host.js";
import { checkItem, ITEM_SLOT_MAP, itemCoverage, itemSkins, ITEM_SLOTS, rigSlotsOf, type ItemIssue, type ItemSlot, type ViewId } from "./swagModel.js";
import { boneWorlds, planTransfers, type Transfer } from "./swagTransfer.js";
import { dragMove, dragSize, dragTurn, handleSet, hitPiece, mul, pieceBone, type HandleKind, type Mat, type Placed } from "./swagHandles.js";
import { runGates, type GateRun } from "./swagGateRun.js";
import { garmentMask } from "./swagGates.js";
import { rigZones, ZONE_ORDER, type ZoneMap } from "./swagZones.js";
import { alignGrip, buildItemBatch, filterItems, issueChip, piecePixelAt, type PiecePixel, itemIdFrom, mapPieces, partLabel, pieceStem, SLOT_LABELS, skinsWithout, stillNeeded, VIEW_LABELS, wearList, type PieceSave } from "./swagWorkshopModel.js";
import type { Workspaces } from "./workspace.js";
import "./swagWorkshop.css";

// front view retired 2026-10-25: items exist in the turned view only.
const VIEWS: readonly ViewId[] = ["turned"];

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (typeof v === "boolean") e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

interface Item {
  name: string;
  slot: ItemSlot;
  item: string;
  turned: boolean;
  covText: string;
  complete: boolean;
  issues: ItemIssue[];
  thumb?: string;
}

interface Piece {
  id: number;
  stem: string;
  dataUrl: string;
  w: number;
  h: number;
  rigSlot: string | null;
  x: number;
  y: number;
  rot: number;
  /** Uniform size, 1 = as drawn. */
  scale: number;
  /** Bend with the body (a linked or own mesh with the body weights) instead of a rigid region; undefined = yes where the rig has a mesh to learn from. */
  bend?: boolean;
  /** Weapon pieces: the held pixel and the end pixel of the picture. */
  grip?: PiecePixel;
  tip?: PiecePixel;
}

/** One file the import skipped or could not read, with the reason and a way to try again. */
interface ImportNote {
  name: string;
  why: string;
  file: File;
}

interface Wizard {
  slot: ItemSlot | null;
  name: string;
  view: ViewId;
  pieces: Record<ViewId, Piece[]>;
  /** The full skin name of the item being edited (null for a new item). */
  editing: string | null;
  imports: ImportNote[];
  card: number | null;
  dragging: boolean;
  busy: boolean;
  msg: { text: string; kind: "" | "ok" | "bad" };
}

interface Cell {
  canvas: HTMLCanvasElement;
  hits: string[];
  error?: string;
}

interface Sheet {
  item: string;
  mode: "clips" | "sweep";
  rows: SheetRow[];
  page: number;
  /** Rows per page at the current window size. */
  per: number;
  cache: Map<string, Cell>;
  clips: Map<string, ClipData | null>;
  token: number;
  busy: string;
}

export interface SwagApi {
  refresh(): Promise<void>;
  /** The named target rig (an editor rig id), or "" when none is chosen. */
  target(): string;
  chooseTarget(id: string): Promise<void>;
  /** Reopens a saved item in the editor. */
  edit(name: string): Promise<void>;
  items(): Item[];
  worn(): string[];
  wear(name: string, on?: boolean): void;
  openSheet(item: string, mode?: "clips" | "sweep"): Promise<void>;
  /** Batch 10b: runs the garment gates (neck, shoulders, cuffs, ink) and returns the honest result; the last run is also shown in the Swag panel. */
  runGates(mode: "sample" | "full"): Promise<GateRun | null>;
  /** The last gate run (what the Swag panel and Ship's checklist show), or null before any run. */
  lastGates(): GateRun | null;
  sheetState(): { open: boolean; page: number; pages: number; rows: number; failing: number; cells: number; mode: string } | null;
}

declare global {
  interface Window {
    atlasSwag?: SwagApi;
  }
}

/** Height of the frame-name header row of the sheet grid (css .swgrid). */
const HEAD_ROW_H = 24;

const frameTick = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));

export function createSwagWorkshop(ws: Workspaces): SwagApi {
  const left = document.getElementById("left")!;
    const root = h("section", { id: "swagws", hidden: true, "aria-label": "Swag workshop" });
  left.append(root);
  const overlay = h("div", { id: "swagsheet", hidden: true });
  document.body.append(overlay);

  let views: Record<ViewId, ViewData> | null = null;
  let renderer: SheetRenderer | null = null;
  let items: Item[] = [];
  let selected: string | null = null;
  let worn: string[] = [];
  let wiz: Wizard | null = null;
  let sheet: Sheet | null = null;
  let loading = false;
  let pieceId = 0;
  let loadError = "";
  /** The rig Swag reads and writes: chosen explicitly (); adopted from the open rig only when nothing is chosen yet. */
  let target = "";
  let query = "";
  let slotFilter = "";
  const rgbaCache = new Map<string, RgbaImage>();
  let previewSeq = 0;
  /** On-canvas placement handles (Batch 12c): the selected piece and whether they show. */
  let selPiece = 0;
  let showHandles = true;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;

  // ------------------------------------------------------------------------------------------------ data

  const haveSkins = (): Set<string> => new Set(Object.keys(getHost()?.doc?.skins ?? {}));

  function buildItems(): void {
    if (!views) return;
    const names = new Map<string, ReturnType<typeof itemSkins>[number]>();
    for (const v of VIEWS) for (const s of itemSkins(views[v].doc.skins)) names.set(s.name, s);
    items = [...names.values()]
      .sort((a, b) => ITEM_SLOTS.indexOf(a.slot) - ITEM_SLOTS.indexOf(b.slot) || a.item.localeCompare(b.item))
      .map((s) => {
        const cov = itemCoverage(views!.turned.doc, s.name);
        const side = (c: typeof cov.turned): string => (c.absent ? "No art yet" : c.missing.length || c.noRigSlot.length ? `${c.missing.length + c.noRigSlot.length} part${c.missing.length + c.noRigSlot.length === 1 ? "" : "s"} missing` : "All parts present");
        return { ...s, turned: !cov.turned.absent, covText: side(cov.turned), complete: cov.complete, issues: checkItem(views!.turned.doc, s.name) };
      });
  }

  async function refresh(): Promise<void> {
    const host = getHost();
    if (!host || loading) return;
    if (!target) {
      views = null;
      renderer?.destroy();
      renderer = null;
      items = [];
      render();
      return;
    }
    loading = true;
    loadError = "";
    render();
    try {
      views = await loadViews(target);
      renderer?.destroy();
      renderer = await createSheetRenderer(host.app, views);
      buildItems();
      worn = worn.filter((n) => items.some((i) => i.name === n));
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    loading = false;
    render();
    void makeThumbs();
  }

  async function makeThumbs(): Promise<void> {
    for (const it of items) {
      if (it.thumb || !renderer) continue;
      try {
        await frameTick();
        // Rendered from the item's own slots (no body), cropped to its pixels: every item has its own picture.
        const canvas = renderer.renderItem("turned", it.name, 56);
        if (!canvas) continue;
        it.thumb = canvas.toDataURL("image/png");
        const img = root.querySelector<HTMLImageElement>(`img[data-thumb="${CSS.escape(it.name)}"]`);
        if (img) img.src = it.thumb;
      } catch {
        // no thumbnail; the row still works
      }
    }
  }

  function applyWorn(): void {
    const host = getHost();
    if (!host?.doc) return;
    host.setActiveSkins(wearList(worn, haveSkins()));
  }

  /** Sets the worn list outright (an undo / redo of a wear step). */
  function setWorn(list: string[]): void {
    worn = [...list];
    applyWorn();
    render();
  }

  function wear(name: string, on?: boolean): void {
    const isOn = worn.includes(name);
    const want = on ?? !isOn;
    const slot = name.slice(0, name.indexOf("."));
    const before = [...worn];
    worn = worn.filter((n) => n !== name && n.slice(0, n.indexOf(".")) !== slot);
    if (want) worn.push(name);
    const after = [...worn];
    applyWorn();
    render();
    if (before.join("|") !== after.join("|")) getHost()?.pushHistory(want ? `Wear ${name}` : `Take off ${name}`, () => setWorn(before), () => setWorn(after));
  }

  // ------------------------------------------------------------------------------------------------ list view

  function chips(issues: ItemIssue[]): HTMLElement {
    const box = h("div", { class: "swchips" });
    if (!issues.length) box.append(h("span", { class: "chip ok", text: "All checks pass" }));
    const seen = new Set<string>();
    for (const i of issues) {
      const c = issueChip(i);
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      box.append(h("span", { class: `chip ${c.tone}`, text: c.text }));
    }
    return box;
  }

  function listRows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (loadError) out.push(h("div", { class: "swnote bad", text: `Could not read the rigs: ${loadError}` }));
    if (loading && !items.length) out.push(h("div", { class: "swnote", text: "Reading the rig..." }));
    if (!loading && !loadError && !items.length) out.push(h("div", { class: "swnote", text: "No swag items yet. Make the first one with New item." }));
    const shown = filterItems(items, query, slotFilter);
    if (items.length && !shown.length) out.push(h("div", { class: "swnote", text: "No item matches. Clear the search or pick All slots." }));
    for (const slot of ITEM_SLOTS) {
      const group = shown.filter((i) => i.slot === slot);
      if (!group.length) continue;
      out.push(h("div", { class: "swgroup", text: SLOT_LABELS[slot] }));
      for (const it of group) {
        const on = worn.includes(it.name);
        out.push(
          h(
            "div",
            { class: `swrow${selected === it.name ? " sel" : ""}`, "data-item": it.name, tabindex: 0, title: on ? `${it.item}: worn now` : `Click to wear ${it.item}`, onclick: () => ((selected = it.name), on ? render() : wear(it.name, true)) },
            h("img", { class: "swthumb", "data-thumb": it.name, alt: "", ...(it.thumb ? { src: it.thumb } : {}) }),
            h("div", { class: "swmeta" }, h("div", { class: "swname", text: it.item }), h("div", { class: `swcov${it.complete ? " ok" : ""}`, text: it.covText })),
            h("button", { class: `swwear${on ? " on" : ""}`, "data-act": "wear", text: on ? "Wearing" : "Wear it", title: on ? "Worn now. Click to take it off" : `Wear ${it.item} on the character`, "aria-pressed": String(on), onclick: (e) => (e.stopPropagation(), (selected = it.name), wear(it.name)) })
          )
        );
      }
    }
    return out;
  }

  function listView(): HTMLElement {
    const box = h("div", { class: "swlist" });
    const body = h("div", { class: "swlistbody" });
    const count = h("span", { class: "swcount", id: "swcount" });
    const fill = (): void => {
      body.replaceChildren(...listRows());
      count.textContent = items.length ? `${filterItems(items, query, slotFilter).length} of ${items.length} items` : "";
    };
    const search = h("input", { type: "search", id: "swsearch", placeholder: "Search items", value: query, spellcheck: false, "aria-label": "Search items", title: "Search the items by name or slot. The list narrows as you type" });
    search.addEventListener("input", () => ((query = search.value), fill()));
    const slotSel = h("select", { id: "swslotfilter", "aria-label": "Show one slot", title: "Show only one slot" }, h("option", { value: "", text: "All slots" }), ...ITEM_SLOTS.map((s) => h("option", { value: s, text: SLOT_LABELS[s] })));
    slotSel.value = slotFilter;
    slotSel.addEventListener("change", () => ((slotFilter = slotSel.value), fill()));
    box.append(h("div", { class: "swfind" }, search, slotSel, count), body);
    fill();
    return box;
  }

  function detail(): HTMLElement | null {
    const it = items.find((i) => i.name === selected);
    if (!it) return null;
    const dangerOpen = root.dataset.confirm === it.name;
    return h(
      "div",
      { class: "swdetail" },
      h("div", { class: "swdtitle" }, h("b", { text: it.item }), h("span", { class: "swdslot", text: SLOT_LABELS[it.slot] })),
      chips(it.issues),
      h(
        "div",
        { class: "swactions" },
        h("button", { class: "primary btn-primary", "data-act": "sheet", text: "Check on every clip", title: "Draw the item on every frame of every clip and flag the ones that break a rule", onclick: () => void openSheet(it.name) }),
        h("button", { "data-act": "sweep", text: "Pose sweep", title: "See the item through the poses that stress it most", onclick: () => void openSheet(it.name, "sweep") }),
        h("button", { "data-act": "edit", id: "swedit", text: "Edit fit and art", title: `Reopen ${it.item}: move, turn or resize its pieces and replace its artwork`, onclick: () => void openEdit(it) }),
        dangerOpen
          ? h("button", { class: "danger", "data-act": "delete-yes", text: "Yes, delete it", title: "Delete this item from the rig for good", onclick: () => void deleteItem(it) })
          : h("button", { "data-act": "delete", text: "Delete", title: "Delete this item from the rig (asks first)", onclick: () => ((root.dataset.confirm = it.name), render()) })
      )
    );
  }

  async function deleteItem(it: Item): Promise<void> {
    delete root.dataset.confirm;
    try {
      for (const v of VIEWS) {
        const data = views?.[v];
        if (!data) continue;
        const raw = (await (await fetch(`/repo/${data.file}?v=${Date.now()}`)).json()) as { skins?: Record<string, unknown> };
        if (!raw.skins || !(it.name in raw.skins)) continue;
        const res = await fetch("/api/skins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: data.file, skins: skinsWithout(raw as never, it.name), setup: {} }) });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `save failed (${res.status})`);
      }
      worn = worn.filter((n) => n !== it.name);
      selected = null;
      await reloadOpenRig();
      await refresh();
      getHost()?.status(`Deleted ${it.name}`, "ok");
    } catch (e) {
      getHost()?.status(`Could not delete ${it.name}: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
  }

  async function reloadOpenRig(): Promise<void> {
    const host = getHost();
    const id = host?.rig?.outfit.id;
    if (host && id && id === target) await host.reloadOutfit(id);
    applyWorn();
  }

  /** Names the rig Swag edits and shows it on the canvas (the worn items apply to the open rig). */
  async function chooseTarget(id: string): Promise<void> {
    const host = getHost();
    if (!host || id === target) return;
    target = id;
    selected = null;
    worn = [];
    wiz = null;
    views = null;
    items = [];
    render();
    if (!id) return;
    try {
      if (host.rig?.outfit.id !== id) await host.mountOutfit(id);
    } catch (e) {
      host.status(`Could not open ${id}: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
    await refresh();
  }

  function adoptOpenRig(): void {
    const id = getHost()?.rig?.outfit.id;
    if (!target && id && OUTFITS.some((o) => o.id === id)) target = id;
  }

  // ------------------------------------------------------------------------------------------------ new item

  const DOLL = `<svg viewBox="0 0 200 270" role="group" aria-label="Pick where the item goes">
    <g class="zone" data-slot="cape" tabindex="0" role="button"><title>Cape</title><path d="M60 84h80l14 124H46z"/></g>
    <g class="zone" data-slot="pants" tabindex="0" role="button"><title>Pants</title><path d="M68 164h64l-6 62h-24l-2-44-2 44H74z"/></g>
    <g class="zone" data-slot="boots" tabindex="0" role="button"><title>Boots</title><path d="M70 230h28v18H64zM102 230h28l6 18h-34z"/></g>
    <g class="zone" data-slot="chest" tabindex="0" role="button"><title>Chest</title><path d="M66 86h68v76H66zM52 90l14-4v52l-14 4zM148 90l-14-4v52l14 4z"/></g>
    <g class="zone" data-slot="gloves" tabindex="0" role="button"><title>Gloves</title><circle cx="50" cy="154" r="11"/><circle cx="150" cy="154" r="11"/></g>
    <g class="zone" data-slot="chain" tabindex="0" role="button"><title>Chain</title><ellipse cx="100" cy="78" rx="22" ry="7"/></g>
    <g class="zone" data-slot="hair" tabindex="0" role="button"><title>Hair</title><path d="M70 42a30 30 0 0 1 60 0l-8-4q-22-10-44 0z M68 40h8v26h-8zM124 40h8v26h-8z"/></g>
    <g class="zone" data-slot="helmet" tabindex="0" role="button"><title>Helmet</title><path d="M68 34a32 30 0 0 1 64 0l-4 4H72z"/></g>
    <g class="zone" data-slot="face" tabindex="0" role="button"><title>Face</title><ellipse cx="100" cy="50" rx="17" ry="14"/></g>
    <g class="zone" data-slot="mask" tabindex="0" role="button"><title>Mask</title><path d="M82 56h36v10H82z"/></g>
    <g class="zone" data-slot="weapon" tabindex="0" role="button"><title>Weapon</title><path d="M170 96l10 4-20 130-10-2z"/></g>
  </svg>`;

  /** The picker drawn from the open rig: one zone per item slot, shaped by the rig's own slot art or bones (PL-12). Null when no rig is loaded yet. */
  function rigDoll(): { svg: string; off: { item: ItemSlot; need: string }[] } | null {
    const zm: ZoneMap | null = views ? rigZones(views.turned.raw) : null;
    if (!zm?.bounds) return null;
    const b = zm.bounds;
    const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04;
    const f = (n: number): string => String(Math.round(n * 10) / 10);
    const groups = ZONE_ORDER.flatMap((item) => {
      const z = zm.zones.find((q) => q.item === item);
      if (!z?.boxes.length) return [];
      const rects = z.boxes.map((q) => `<rect x="${f(q.x0)}" y="${f(q.y0)}" width="${f(q.x1 - q.x0)}" height="${f(q.y1 - q.y0)}" rx="${f(Math.min(q.x1 - q.x0, q.y1 - q.y0) / 5)}"/>`).join("");
      return [`<g class="zone" data-slot="${item}" tabindex="0" role="button" aria-label="${SLOT_LABELS[item]}"><title>${SLOT_LABELS[item]}</title>${rects}</g>`];
    });
    const off = zm.zones.filter((z) => !z.boxes.length).map((z) => ({ item: z.item, need: z.missingBones.join(", ") || "its slots" }));
    return { svg: `<svg viewBox="${f(b.x0 - pad)} ${f(b.y0 - pad)} ${f(b.x1 - b.x0 + 2 * pad)} ${f(b.y1 - b.y0 + 2 * pad)}" role="group" aria-label="Pick where the item goes, drawn from this rig">${groups.join("")}</svg>`, off };
  }

  function newWizard(): Wizard {
    return { slot: null, name: "", view: "turned", pieces: { turned: [] }, editing: null, imports: [], card: null, dragging: false, busy: false, msg: { text: "", kind: "" } };
  }

  /** Reads one PNG into a data URL and its size; throws a plain-English reason when it cannot. */
  async function readPng(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
    if (!/\.png$/i.test(file.name) && file.type !== "image/png") throw new Error("it is not a PNG");
    const dataUrl = await new Promise<string>((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => bad(new Error("the file could not be read"));
      r.readAsDataURL(file);
    });
    const size = await new Promise<{ w: number; h: number }>((ok, bad) => {
      const img = new Image();
      img.onload = () => ok({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => bad(new Error("it is not a readable PNG"));
      img.src = dataUrl;
    });
    return { dataUrl, ...size };
  }

  /** Adds PNG pieces. Each file is handled alone: a bad one is listed with its reason (and a retry) and the rest still land (). */
  async function addFiles(files: FileList | File[]): Promise<void> {
    if (!wiz?.slot) return;
    const w = wiz;
    const slot = w.slot!;
    const list = w.pieces[w.view];
    for (const file of [...files]) {
      w.imports = w.imports.filter((n) => n.file !== file);
      try {
        const stem = pieceStem(file.name);
        if (!stem) throw new Error("it has no usable file name");
        if (list.some((p) => p.stem === stem)) throw new Error("a piece with that name is already added");
        const png = await readPng(file);
        const taken = new Set(list.flatMap((p) => (p.rigSlot ? [p.rigSlot] : [])));
        const { mapped } = mapPieces(slot, [stem], taken);
        list.push({ id: ++pieceId, stem, dataUrl: png.dataUrl, w: png.w, h: png.h, rigSlot: mapped[stem] ?? null, x: 0, y: 0, rot: 0, scale: 1 });
      } catch (e) {
        w.imports.push({ name: file.name, why: e instanceof Error ? e.message : String(e), file });
      }
    }
    if (wiz === w) render();
  }

  /** Swaps one piece's artwork for a new PNG; where the piece sits (part, offset, turn, size) stays (). */
  async function replaceArt(p: Piece, file: File): Promise<void> {
    const w = wiz;
    if (!w) return;
    try {
      const png = await readPng(file);
      p.dataUrl = png.dataUrl;
      p.w = png.w;
      p.h = png.h;
      w.msg = { text: `Replaced the ${partLabel(p.rigSlot ?? p.stem).toLowerCase()} artwork with ${file.name}.`, kind: "ok" };
    } catch (e) {
      w.msg = { text: `Could not use ${file.name}: ${e instanceof Error ? e.message : String(e)}. The old artwork is kept.`, kind: "bad" };
    }
    if (wiz === w) render();
  }

  /** Reopens a saved item: every piece comes back with its artwork, part and placement (). */
  async function openEdit(it: Item): Promise<void> {
    const host = getHost();
    if (!views) return;
    try {
      const data = views.turned;
      const skin = objOf(objOf(data.raw["skins"])[it.name]);
      const attachments = objOf(skin["attachments"]);
      const manifest = (await (await fetch(`/repo/${data.atlas}?v=${Date.now()}`)).json()) as { pages?: { file: string; regions?: Record<string, { x: number; y: number; width: number; height: number }> }[] };
      const dir = data.atlas.slice(0, data.atlas.lastIndexOf("/") + 1);
      const pages = new Map<string, HTMLImageElement>();
      const pieces: Piece[] = [];
      for (const [rigSlot, atts] of Object.entries(attachments)) {
        const att = Object.values(objOf(atts as never)).map((a) => objOf(a as never)).find((a) => a["type"] === "region" || a["type"] === undefined);
        const path = att && typeof att["path"] === "string" ? att["path"] : "";
        const page = manifest.pages?.find((pg) => pg.regions?.[path]);
        const reg = page?.regions?.[path];
        if (!att || !page || !reg) continue;
        let img = pages.get(page.file);
        if (!img) {
          img = await new Promise<HTMLImageElement>((ok, bad) => {
            const i = new Image();
            i.onload = () => ok(i);
            i.onerror = () => bad(new Error(`the artwork page ${page.file} could not be read`));
            i.src = `/repo/${dir}${page.file}?v=${Date.now()}`;
          });
          pages.set(page.file, img);
        }
        const c = document.createElement("canvas");
        c.width = reg.width;
        c.height = reg.height;
        c.getContext("2d")!.drawImage(img, reg.x, reg.y, reg.width, reg.height, 0, 0, reg.width, reg.height);
        const piece: Piece = { id: ++pieceId, stem: rigSlot, dataUrl: c.toDataURL("image/png"), w: reg.width, h: reg.height, rigSlot, x: Number(att["x"] ?? 0), y: Number(att["y"] ?? 0), rot: Number(att["rotation"] ?? 0), scale: Number(att["scaleX"] ?? 1) };
        for (const key of ["grip", "tip"] as const) {
          const pt = objOf(atts as never)[key];
          const pa = pt && typeof pt === "object" && (pt as { type?: string }).type === "point" ? (pt as { x?: number; y?: number }) : null;
          if (pa) piece[key] = piecePixelAt({ width: piece.w, height: piece.h, x: piece.x, y: piece.y, rotation: piece.rot, scale: piece.scale }, Number(pa.x ?? 0), Number(pa.y ?? 0));
        }
        pieces.push(piece);
      }
      if (!pieces.length) throw new Error("it has no pieces that can be reopened");
      const w = newWizard();
      w.slot = it.slot;
      w.name = it.item;
      w.editing = it.name;
      w.pieces.turned = pieces;
      wiz = w;
      render();
      schedulePreview(0);
    } catch (e) {
      host?.status(`Could not reopen ${it.name}: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
  }

  function assign(pieceIdNum: number, rigSlot: string): void {
    if (!wiz) return;
    const list = wiz.pieces[wiz.view];
    const p = list.find((x) => x.id === pieceIdNum);
    if (!p) return;
    for (const o of list) if (o.rigSlot === rigSlot) o.rigSlot = null;
    p.rigSlot = rigSlot;
    wiz.card = null;
    wiz.dragging = false;
    render();
  }

  function wizardView(): HTMLElement {
    const w = wiz!;
    const box = h("div", { class: "swwiz" });
    box.append(
      h(
        "div",
        { class: "swpreview", id: "swpreviewbox" },
        h("div", { class: "swstagewrap", id: "swstagewrap" }, h("canvas", { id: "swpreview", "aria-label": "The item on the character, live", title: "The item on the character as you adjust it" }), handleLayer()),
        h("div", { class: "swpvmsg", id: "swpvmsg", text: "Drawing..." }),
        handleBar()
      )
    );
    if (w.editing) box.append(h("div", { class: "swnote", id: "swediting", text: `Editing ${w.editing}. Change a piece, replace its artwork, then Save changes. Undo puts the old version back.` }));
    box.append(h("div", { class: "swstep" }, h("span", { class: "n", text: "1" }), h("b", { text: "Where does it go?" }), w.slot ? h("span", { class: "swpicked", text: SLOT_LABELS[w.slot] }) : h("span", { class: "swhint", text: "Tap a body part" })));
    const doll = h("div", { class: "swdoll" });
    const drawn = rigDoll();
    doll.innerHTML = drawn ? drawn.svg : DOLL;
    doll.dataset["from"] = drawn ? "rig" : "fixed";
    for (const z of doll.querySelectorAll<SVGElement>(".zone")) {
      const slot = z.dataset["slot"] as ItemSlot;
      z.classList.toggle("on", w.slot === slot);
      const pick = () => {
        if (w.editing) return;
        w.slot = slot;
        for (const v of VIEWS) for (const p of w.pieces[v]) p.rigSlot = null;
        for (const v of VIEWS) {
          const { mapped } = mapPieces(slot, w.pieces[v].map((p) => p.stem));
          for (const p of w.pieces[v]) p.rigSlot = mapped[p.stem] ?? null;
        }
        render();
      };
      z.addEventListener("click", pick);
      z.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && pick());
    }
    box.append(doll);
    if (drawn?.off.length) {
      box.append(h("div", { class: "swzoneoff", id: "swzoneoff" }, ...drawn.off.map((o) => h("span", { class: "swzoneoffchip", "data-slot": o.item, text: `${SLOT_LABELS[o.item]}: no ${o.need} bone`, title: `This rig has no ${o.need} bone, so nothing can be worn as ${SLOT_LABELS[o.item].toLowerCase()} yet. Use Create missing in the Rig contract card (Rig workspace)` }))));
    }

    box.append(h("div", { class: "swstep" }, h("span", { class: "n", text: "2" }), h("b", { text: "Name it" })));
    const nameIn = h("input", { type: "text", id: "switemname", placeholder: "red-jerkin", value: w.name, maxlength: 40, spellcheck: false, "aria-label": "Item name", title: w.editing ? "The name stays the same while you edit" : "A short name; it becomes the item id, like red-jerkin", ...(w.editing ? { disabled: true } : {}) });
    nameIn.addEventListener("input", () => {
      w.name = nameIn.value;
      const sk = box.querySelector(".swskin");
      if (sk) sk.textContent = skinPreview(w);
      updateSave(box);
    });
    box.append(nameIn, h("div", { class: "swskin", text: skinPreview(w) }));

    box.append(h("div", { class: "swstep" }, h("span", { class: "n", text: "3" }), h("b", { text: w.editing ? "Add or replace PNG pieces" : "Drop the PNG pieces" })));
    // front view retired 2026-10-25: one view, so no view switch above the drop zone.
    const input = h("input", { type: "file", id: "swfiles", accept: "image/png", multiple: true, class: "swfile" });
    input.addEventListener("change", () => {
      void addFiles(input.files ?? []);
    });
    const drop = h("div", { class: `swdrop${w.slot ? "" : " off"}`, id: "swdrop", title: "Drop PNG files here or click to choose them" }, w.slot ? "Drop PNG files here, or click to choose. Name a file after its body part, like torso.png, and it lands there by itself." : "Pick where the item goes first.");
    drop.addEventListener("click", () => w.slot && input.click());
    drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      void addFiles(e.dataTransfer?.files ?? []);
    });
    box.append(drop, input);
    if (w.imports.length) {
      const log = h("div", { class: "swimports", id: "swimports", role: "status" });
      for (const n of w.imports) {
        log.append(
          h(
            "div",
            { class: "swimp" },
            h("span", { text: `${n.name}: ${n.why}` }),
            h("button", { text: "Retry", "data-act": "retry-file", title: `Try ${n.name} again`, onclick: () => void addFiles([n.file]) }),
            h("button", { text: "Dismiss", "data-act": "dismiss-file", title: `Forget ${n.name}`, onclick: () => ((w.imports = w.imports.filter((x) => x !== n)), render()) })
          )
        );
      }
      box.append(log);
    }

    const list = w.pieces[w.view];
    if (w.slot) {
      const slot = w.slot;
      const loose = list.filter((p) => !p.rigSlot);
      if (loose.length) {
        box.append(h("div", { class: "swsub", text: "These did not match a body part. Drag each onto its spot below." }));
        const cards = h("div", { class: "swcards" });
        for (const p of loose) {
          const c = h("div", { class: `swcard${w.card === p.id ? " sel" : ""}`, draggable: "true", "data-piece": p.stem, onclick: () => ((w.card = w.card === p.id ? null : p.id), render()) }, h("img", { src: p.dataUrl, alt: "" }), h("span", { text: p.stem }));
          c.addEventListener("dragstart", (e) => {
            e.dataTransfer?.setData("text/plain", String(p.id));
            w.dragging = true;
            box.classList.add("dragging");
          });
          c.addEventListener("dragend", () => ((w.dragging = false), box.classList.remove("dragging")));
          cards.append(c);
        }
        box.append(cards);
      }
      const parts = h("div", { class: "swparts" });
      for (const rs of rigSlotsOf(slot)) {
        const has = list.find((p) => p.rigSlot === rs);
        const required = ITEM_SLOT_MAP[slot].required.includes(rs);
        const part = h("div", { class: `swpart${has ? " full" : ""}${!has && (loose.length || w.card) ? " free" : ""}`, "data-part": rs }, h("span", { class: "pl", text: partLabel(rs) }), h("span", { class: "pr", text: has ? has.stem : required ? "needed" : "optional" }));
        part.addEventListener("dragover", (e) => e.preventDefault());
        part.addEventListener("drop", (e) => {
          e.preventDefault();
          const id = Number(e.dataTransfer?.getData("text/plain"));
          if (id) assign(id, rs);
        });
        part.addEventListener("click", () => w.card && assign(w.card, rs));
        parts.append(part);
      }
      box.append(h("div", { class: "swsub", text: `${VIEW_LABELS[w.view]} body parts` }), parts);

      const placed = list.filter((p) => p.rigSlot);
      if (placed.length) {
        box.append(h("div", { class: "swsub", text: "Place each piece: the picture above updates as you change a number" }));
        for (const p of placed) {
          const num = (key: "x" | "y" | "rot", label: string, step: number) => {
            const i = h("input", { type: "number", step, value: p[key], "data-nudge": key, "aria-label": `${p.stem} ${label}` });
            i.addEventListener("input", () => ((p[key] = Number(i.value) || 0), key === "rot" && regrip(p), drawHandles(), schedulePreview()));
            return h("label", { title: `${label}: move or turn the ${partLabel(p.rigSlot!).toLowerCase()}` }, label, i);
          };
          const size = h("input", { type: "number", step: 1, min: 10, max: 400, value: Math.round(p.scale * 100), "data-nudge": "scale", "aria-label": `${p.stem} size in percent`, title: "Size in percent of the drawn artwork" });
          size.addEventListener("input", () => ((p.scale = Math.min(4, Math.max(0.1, (Number(size.value) || 100) / 100))), regrip(p), drawHandles(), schedulePreview()));
          const pick = h("input", { type: "file", accept: "image/png", class: "swfile", "aria-label": `New artwork for ${p.stem}` });
          pick.addEventListener("change", () => pick.files?.[0] && void replaceArt(p, pick.files[0]));
          box.append(
            h(
              "div",
              { class: `swnudge${p.id === selPiece ? " sel" : ""}`, "data-piece": p.stem },
              h("img", { src: p.dataUrl, alt: "" }),
              h("div", { class: "nm" }, h("b", { text: partLabel(p.rigSlot!) }), h("span", { text: `${p.w} x ${p.h}` })),
              h("button", { text: "Handles", "data-act": "select-piece", title: `Show the move, turn and size handles for the ${partLabel(p.rigSlot!).toLowerCase()} on the picture above`, onclick: () => selectPiece(p.id) }),
              h("button", { text: "Replace art", "data-act": "replace-art", title: `Swap the ${partLabel(p.rigSlot!).toLowerCase()} artwork for another PNG; its place stays`, onclick: () => pick.click() }),
              h("button", { text: "Remove", title: "Take this piece out of the item", onclick: () => ((w.pieces[w.view] = w.pieces[w.view].filter((q) => q !== p)), render()) }),
              pick,
              h("div", { class: "nv" }, num("x", "Across", 1), num("y", "Down", 1), num("rot", "Turn", 0.5), h("label", { title: "Size in percent" }, "Size %", size))
            )
          );
          box.append(bendRow(p));
          if (slot === "weapon") box.append(gripRow(p));
        }
      }
      const need = VIEWS.map((v) => ({ v, miss: w.pieces[v].length ? stillNeeded(slot, w.pieces[v].flatMap((p) => (p.rigSlot ? [p.rigSlot] : []))) : [] })).filter((x) => x.miss.length);
      if (need.length) box.append(h("div", { class: "swchips" }, ...need.map((n) => h("span", { class: "chip warn", text: `${VIEW_LABELS[n.v]} still needs: ${n.miss.map(partLabel).join(", ")}` }))));
    }

    box.append(
      h("div", { class: "swstep" }, h("span", { class: "n", text: "4" }), h("b", { text: "Save" })),
      h(
        "div",
        { class: "swactions" },
        h("button", { class: "primary btn-primary", id: "swsave", "data-act": "save", text: w.busy ? "Saving..." : w.editing ? "Save changes" : "Save item", onclick: () => void saveWizard() }),
        h("button", { "data-act": "cancel", id: "swcancel", text: w.busy ? "Saving, please wait" : "Cancel", ...(w.busy ? { disabled: true } : {}), title: w.busy ? "The save is already running; it cannot be stopped, and the item is shown when it finishes" : w.editing ? "Close without saving the changes" : "Close without saving the item", onclick: () => ((wiz = null), render()) })
      ),
      h("div", { class: `swnote ${w.msg.kind}`, id: "swmsg", text: w.msg.text })
    );
    updateSave(box);
    schedulePreview();
    return box;
  }

  const skinPreview = (w: Wizard): string => (w.slot ? `Saved as ${w.slot}.${itemIdFrom(w.name) || "..."}` : "Saved as <slot>.<name>");

  function problems(w: Wizard): string[] {
    const out: string[] = [];
    if (!w.slot) out.push("Pick where the item goes.");
    if (!itemIdFrom(w.name)) out.push("Give the item a name.");
    if (!VIEWS.some((v) => w.pieces[v].some((p) => p.rigSlot))) out.push("Add at least one PNG piece and place it on a body part.");
    if (!w.editing && w.slot && itemIdFrom(w.name) && items.some((i) => i.name === `${w.slot}.${itemIdFrom(w.name)}`)) out.push("An item with that name already exists in this slot.");
    return out;
  }

  function updateSave(box: HTMLElement): void {
    const btn = box.querySelector<HTMLButtonElement>("#swsave");
    if (!btn || !wiz) return;
    const p = problems(wiz);
    btn.disabled = wiz.busy || p.length > 0;
    btn.title = p[0] ?? "Save the item into the rig";
  }

  const toSave = (p: Piece): PieceSave => ({ rigSlot: p.rigSlot!, width: p.w, height: p.h, png: p.dataUrl, x: p.x, y: p.y, rotation: p.rot, scale: p.scale, ...(p.grip ? { grip: p.grip } : {}), ...(p.tip ? { tip: p.tip } : {}) });

  /** Per piece: the "Bend with the body" switch and what the rig will do with it (). */
  function bendRow(p: Piece): HTMLElement {
    const t = views ? transfersFor(views.turned.raw, [{ ...p, bend: true }], `${wiz?.slot ?? ""}.zz-draft`)[p.rigSlot!] : undefined;
    const can = !!t && t.report.tier !== "region";
    const box = h("input", { type: "checkbox", id: `swbend-${p.stem}`, "data-act": "bend", "aria-label": `${p.stem} bends with the body`, ...(can && p.bend !== false ? { checked: true } : {}), ...(can ? {} : { disabled: true }) }) as HTMLInputElement;
    box.addEventListener("change", () => ((p.bend = box.checked), render()));
    const what = !t ? "" : p.bend === false || !can ? `Rigid: sits on the ${partLabel(p.rigSlot!).toLowerCase()} bone${can ? "" : ` (${t.report.reason})`}` : t.report.tier === "A" ? `Linked mesh: ${t.report.reason}` : `Bends: ${t.report.reason}, ${t.report.bones} bones`;
    return h("div", { class: "swbend", "data-piece": p.stem }, h("label", { title: can ? "On: the piece is a skinned mesh with the body's weights, so it bends at the elbow and knee. Off: it stays a flat rectangle on its bone" : "This rig has no mesh on this body part to learn from, so the piece stays rigid" }, box, " Bend with the body"), h("span", { class: "swbendinfo", text: what }));
  }

  /** "Sleeves bend (mesh, 4 bones); torso rigid" for the status line after a save. */
  function transferSummary(reports: readonly Transfer["report"][]): string {
    return reports.map((r) => `${partLabel(r.rigSlot)}: ${r.tier === "region" ? "rigid" : r.tier === "A" ? `linked mesh, ${r.bones} bones` : `own mesh, ${r.bones} bones`}`).join("; ");
  }

  /** After the grip is set, a new turn or size keeps the grip pixel on the hand: the piece offset is recomputed (Batch 10b). */
  function regrip(p: Piece): void {
    if (!p.grip) return;
    const o = alignGrip({ width: p.w, height: p.h, rotation: p.rot, scale: p.scale }, p.grip);
    p.x = o.x;
    p.y = o.y;
    syncInputs(p);
  }

  /** Writes a piece's numbers into its row's fields (the handles and the fields always show the same values). */
  function syncInputs(p: Piece): void {
    const row = document.querySelector<HTMLElement>(`.swnudge[data-piece="${p.stem}"]`);
    for (const key of ["x", "y", "rot"] as const) {
      const inp = row?.querySelector<HTMLInputElement>(`input[data-nudge="${key}"]`);
      if (inp) inp.value = String(p[key]);
    }
    const sz = row?.querySelector<HTMLInputElement>('input[data-nudge="scale"]');
    if (sz) sz.value = String(Math.round(p.scale * 100));
  }

  /** Weapon grip and tip registration: click the picture where the hand holds it, then where it ends ( / PL-06). */
  function gripRow(p: Piece): HTMLElement {
    let mode: "grip" | "tip" = p.grip ? "tip" : "grip";
    const pic = h("div", { class: "swgrippic", id: "swgrip-pic", title: "Click the picture: first where the hand holds it (Grip), then where the blade or head ends (Tip)" });
    const img = h("img", { src: p.dataUrl, alt: "", draggable: "false" });
    const dots = h("span", { class: "swgripdots" });
    const read = h("span", { class: "swgripread", id: "swgrip-read" });
    const paint = (): void => {
      dots.replaceChildren();
      for (const k of ["grip", "tip"] as const) {
        const q = p[k];
        if (q) dots.append(h("i", { class: `swgripdot ${k}`, style: `left:${(q.x / p.w) * 100}%;top:${(q.y / p.h) * 100}%`, title: k === "grip" ? "Grip" : "Tip" }));
      }
      read.textContent = p.grip ? `Grip ${Math.round(p.grip.x)}, ${Math.round(p.grip.y)} px${p.tip ? `   Tip ${Math.round(p.tip.x)}, ${Math.round(p.tip.y)} px` : "   (click again for the tip)"}` : "Click the picture where the hand holds it";
    };
    const pickBtn = (k: "grip" | "tip", text: string, tip: string): HTMLButtonElement => {
      const b = h("button", { text, id: `swgrip-${k}`, "data-act": `grip-${k}`, title: tip, onclick: () => ((mode = k), mark()) }) as HTMLButtonElement;
      return b;
    };
    const grip = pickBtn("grip", "Set grip", "Set grip: the next click on the picture marks where the hand holds the weapon; the piece moves so that spot sits on the hand");
    const tip = pickBtn("tip", "Set tip", "Set tip: the next click marks where the blade or head ends (the swing trail and hit effects start there)");
    const mark = (): void => {
      grip.classList.toggle("on", mode === "grip");
      tip.classList.toggle("on", mode === "tip");
    };
    pic.addEventListener("click", (e) => {
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const at: PiecePixel = { x: Math.max(0, Math.min(p.w, ((e.clientX - r.left) / r.width) * p.w)), y: Math.max(0, Math.min(p.h, ((e.clientY - r.top) / r.height) * p.h)) };
      p[mode] = at;
      if (mode === "grip") {
        const o = alignGrip({ width: p.w, height: p.h, rotation: p.rot, scale: p.scale }, at);
        p.x = o.x;
        p.y = o.y;
        mode = "tip";
        wiz && render();
        return;
      }
      paint();
      mark();
      schedulePreview();
    });
    pic.append(img, dots);
    paint();
    mark();
    return h("div", { class: "swgrip", "data-piece": p.stem }, pic, h("div", { class: "swgripctl" }, grip, tip, read));
  }

  interface SavedStep {
    file: string;
    atlas: string;
    commands: ReturnType<typeof buildItemBatch>["commands"];
    images: ReturnType<typeof buildItemBatch>["images"];
  }

  /** Runs one server save (optionally undoing saved batches first), then refreshes the list and the open rig. */
  async function serverStep(s: SavedStep, undo: number, redo: boolean): Promise<void> {
    const hash = ((await (await fetch(`/api/rig/hash?file=${encodeURIComponent(s.file)}`)).json()) as { hash: string }).hash;
    const res = await fetch("/api/rig/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: s.file, atlas: s.atlas, base: hash, undo, batches: redo ? [s.commands] : [], ...(redo ? { images: s.images } : {}) }) });
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `failed (${res.status})`);
    await reloadOpenRig();
    await refresh();
  }

  /** Makes a saved item a visible Undo / Redo step (the label says it changes the item's data and artwork, not what is worn). */
  function pushSaveStep(name: string, what: string, s: SavedStep): void {
    const run = (undo: number, redo: boolean, verb: string) => {
      void serverStep(s, undo, redo).then(
        () => getHost()?.status(`${verb} ${name}`, "ok"),
        (e) => getHost()?.status(`Could not ${verb.toLowerCase()} ${name}: ${e instanceof Error ? e.message : String(e)}`, "bad")
      );
    };
    getHost()?.pushHistory(`${what}: save ${name} (item data and artwork)`, () => run(1, false, "Took back"), () => run(0, true, "Saved again"));
  }

  // ------------------------------------------------------------------------------------------------ live placement preview

  async function rgbaOf(dataUrl: string): Promise<RgbaImage> {
    let r = rgbaCache.get(dataUrl);
    if (!r) {
      r = await loadRgbaImage(dataUrl);
      if (rgbaCache.size > 40) rgbaCache.clear();
      rgbaCache.set(dataUrl, r);
    }
    return r;
  }

  function schedulePreview(delay = 140): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void drawPreview(), delay);
  }

  /** Draws the draft item on the character from its pieces, without saving anything. */
  async function drawPreview(): Promise<void> {
    previewTimer = null;
    const w = wiz;
    const cv = root.querySelector<HTMLCanvasElement>("#swpreview");
    const msg = root.querySelector<HTMLElement>("#swpvmsg");
    if (!w || !cv || !msg) return;
    const say = (t: string) => {
      msg.textContent = t;
      msg.hidden = !t;
    };
    const placed = w.pieces[w.view].filter((p) => p.rigSlot);
    if (!w.slot || !placed.length || !renderer || !views) {
      cv.width = cv.height = 1;
      say(!w.slot ? "Pick where the item goes to see it on the character." : "Add a PNG piece and place it on a body part to see it on the character.");
      return;
    }
    const seq = ++previewSeq;
    try {
      const data = views.turned;
      const batch = buildItemBatch(data.raw, { slot: w.slot, item: "zz-draft", rigName: data.name, pieces: placed.map(toSave), replace: true, transfers: transfersFor(data.raw, placed, `${w.slot}.zz-draft`) });
      const doc = runBatch(structuredClone(data.raw) as JsonObject, batch.commands).doc;
      const images = new Map<string, RgbaImage>();
      for (const img of batch.images) images.set(img.path, await rgbaOf(img.png));
      if (seq !== previewSeq || wiz !== w) return;
      const out = renderer.renderDraft("turned", doc as JsonObject, batch.skin, images, 0.5);
      cv.width = out.width;
      cv.height = out.height;
      cv.getContext("2d")!.drawImage(out, 0, 0);
      say(templateOn ? ghostTemplate(cv, w.slot) : "");
      drawHandles();
    } catch (e) {
      if (seq === previewSeq) say(`Cannot draw it yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------------------------------ on-canvas handles (Batch 12c)

  const SVGNS = "http://www.w3.org/2000/svg";

  function handleLayer(): SVGSVGElement {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("id", "swhandles");
    svg.setAttribute("class", "swhandles");
    svg.setAttribute("aria-label", "Placement handles for the selected piece: drag the centre to move, the top dot to turn, the corner square to resize");
    svg.addEventListener("pointerdown", handleDown);
    return svg;
  }

  function handleBar(): HTMLElement {
    const on = h("input", { type: "checkbox", id: "swhandles-on", "data-act": "handles-on", ...(showHandles ? { checked: true } : {}), "aria-label": "Show placement handles" }) as HTMLInputElement;
    on.addEventListener("change", () => ((showHandles = on.checked), drawHandles()));
    return h(
      "div",
      { class: "swhandlebar", id: "swhandlebar" },
      h("label", { title: "Show handles on the picture for the selected piece: drag the centre to move, the top dot to turn (Shift = 15 degree steps), the corner square to resize (Shift = 10 percent steps; Shift while moving keeps one direction). Each drag is one Undo step" }, on, " Handles"),
      h("span", { class: "swhandleread", id: "swhandle-read", role: "status" })
    );
  }

  const placedOf = (p: Piece): Placed => ({ width: p.w, height: p.h, x: p.x, y: p.y, rotation: p.rot, scale: p.scale });

  function findPiece(id: number): Piece | null {
    for (const list of Object.values(wiz?.pieces ?? {})) for (const p of list) if (p.id === id) return p;
    return null;
  }

  /** Slot bone frame -> picture pixels for a piece of the draft (null before the first draw). */
  function toPicture(p: Piece): Mat | null {
    const map = renderer?.draftMap;
    const raw = views?.turned.raw;
    if (!map || !raw || !p.rigSlot) return null;
    const bone = pieceBone(raw, p.rigSlot);
    const bw = bone ? boneWorlds(raw).get(bone) : null;
    return bw ? mul(map, bw) : null;
  }

  function markSelected(id: number): void {
    const stem = findPiece(id)?.stem;
    for (const row of root.querySelectorAll<HTMLElement>(".swnudge")) row.classList.toggle("sel", row.getAttribute("data-piece") === stem);
  }

  function selectPiece(id: number): void {
    selPiece = id;
    markSelected(id);
    drawHandles();
  }

  function drawHandles(): void {
    const svg = root.querySelector<SVGSVGElement>("#swhandles");
    const cv = root.querySelector<HTMLCanvasElement>("#swpreview");
    const read = root.querySelector<HTMLElement>("#swhandle-read");
    if (!svg || !cv) return;
    svg.replaceChildren();
    const w = wiz;
    const placed = w ? w.pieces[w.view].filter((q) => q.rigSlot) : [];
    let p = placed.find((q) => q.id === selPiece) ?? null;
    if (!p && placed.length) {
      p = placed[0]!;
      selPiece = p.id;
      markSelected(p.id);
    }
    const m = p ? toPicture(p) : null;
    svg.setAttribute("viewBox", `0 0 ${cv.width} ${cv.height}`);
    svg.classList.toggle("off", !showHandles || !p || !m);
    if (read) read.textContent = p ? `${partLabel(p.rigSlot!)}: across ${p.x}, down ${p.y}, turn ${p.rot}, size ${Math.round(p.scale * 100)}%` : "Place a piece to get handles";
    if (!showHandles || !p || !m) return;
    const u = cv.width / (cv.clientWidth || cv.width) || 1;
    const set = handleSet(placedOf(p), m, 22 * u);
    const mk = (tag: string, attrs: Record<string, string | number>, tip?: string): SVGElement => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, String(v));
      if (tip) {
        const t = document.createElementNS(SVGNS, "title");
        t.textContent = tip;
        e.append(t);
      }
      return e;
    };
    svg.append(
      mk("polygon", { points: set.corners.map((c) => c.join(",")).join(" "), class: "swh-box" }),
      mk("line", { x1: set.centre[0], y1: set.centre[1], x2: set.turn[0], y2: set.turn[1], class: "swh-stalk" }),
      mk("circle", { cx: set.centre[0], cy: set.centre[1], r: 8 * u, class: "swh-move", "data-h": "move", "aria-label": "Move handle" }, "Move: drag to place the piece (Shift keeps one direction)"),
      mk("circle", { cx: set.turn[0], cy: set.turn[1], r: 7 * u, class: "swh-turn", "data-h": "turn", "aria-label": "Turn handle" }, "Turn: drag around the piece (Shift = 15 degree steps)"),
      mk("rect", { x: set.size[0] - 7 * u, y: set.size[1] - 7 * u, width: 14 * u, height: 14 * u, class: "swh-size", "data-h": "size", "aria-label": "Size handle" }, "Size: drag the corner (Shift = 10 percent steps)")
    );
  }

  function handleDown(ev: PointerEvent): void {
    const svg = ev.currentTarget as SVGSVGElement;
    const cv = root.querySelector<HTMLCanvasElement>("#swpreview");
    const w = wiz;
    if (!cv || !w || !showHandles || ev.button > 0) return;
    const rect = svg.getBoundingClientRect();
    const at = (e: PointerEvent): [number, number] => [((e.clientX - rect.left) / rect.width) * cv.width, ((e.clientY - rect.top) / rect.height) * cv.height];
    const kind = (ev.target as Element).getAttribute("data-h") as HandleKind | null;
    const [px, py] = at(ev);
    let p = findPiece(selPiece);
    let how: HandleKind | null = kind;
    if (!how) {
      // a press on the picture picks the top-most piece under it and starts moving it
      const hit = [...w.pieces[w.view]].reverse().find((q) => {
        const mm = q.rigSlot ? toPicture(q) : null;
        return mm && hitPiece(placedOf(q), mm, px, py);
      });
      if (!hit) return;
      selectPiece(hit.id);
      p = hit;
      how = "move";
    }
    const m = p ? toPicture(p) : null;
    if (!p || !m) return;
    ev.preventDefault();
    svg.setPointerCapture(ev.pointerId);
    const piece = p;
    const mode: HandleKind = how;
    const start = placedOf(piece);
    const centre = handleSet(start, m).centre;
    const a0 = (Math.atan2(py - centre[1], px - centre[0]) * 180) / Math.PI;
    const d0 = Math.hypot(px - centre[0], py - centre[1]);
    const before = { x: piece.x, y: piece.y, rot: piece.rot, scale: piece.scale };
    const move = (e: PointerEvent): void => {
      const [x, y] = at(e);
      if (mode === "move") {
        const r = dragMove(start, m, x - px, y - py, e.shiftKey);
        piece.x = r.x;
        piece.y = r.y;
      } else if (mode === "turn") {
        piece.rot = dragTurn(start, m, centre, a0, x, y, e.shiftKey);
        regrip(piece);
      } else {
        piece.scale = dragSize(start, centre, d0, x, y, e.shiftKey);
        regrip(piece);
      }
      syncInputs(piece);
      drawHandles();
      schedulePreview(30);
    };
    const up = (e: PointerEvent): void => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      const after = { x: piece.x, y: piece.y, rot: piece.rot, scale: piece.scale };
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const restore = (v: typeof before): void => {
        const q = findPiece(piece.id);
        if (!q) return;
        Object.assign(q, v);
        syncInputs(q);
        drawHandles();
        schedulePreview(30);
      };
      getHost()?.pushHistory(`Swag ${mode === "move" ? "move" : mode === "turn" ? "turn" : "resize"} ${partLabel(piece.rigSlot!).toLowerCase()} (handle)`, () => restore(before), () => restore(after));
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  }

  /** The mesh / weight transfer for the pieces that bend, planned on the client from the rig as the workshop read it (the live preview). */
  function transfersFor(raw: JsonObject, pieces: readonly Piece[], skin: string): Record<string, Transfer> {
    const bend = pieces.filter((p) => p.rigSlot && p.bend !== false);
    return bend.length ? planTransfers(raw, bend.map((p) => ({ rigSlot: p.rigSlot!, width: p.w, height: p.h, x: p.x, y: p.y, rotation: p.rot, scale: p.scale })), skin) : {};
  }

  /** POST /api/swag/import: the server plans the transfer against the rig file as it is on disk (what the save then writes). */
  async function importTransfers(file: string, skin: string, pieces: readonly Piece[]): Promise<Record<string, Transfer>> {
    const res = await fetch("/api/swag/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, skin, pieces: pieces.map((p) => ({ rigSlot: p.rigSlot, width: p.w, height: p.h, x: p.x, y: p.y, rotation: p.rot, scale: p.scale })) }) });
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `mesh transfer failed (${res.status})`);
    return ((await res.json()) as { transfers: Record<string, Transfer> }).transfers;
  }

  let lastTransfers: Transfer["report"][] = [];

  /** Ghosts the approved Jacket B template over the wizard picture (cyan, 45%): a chest piece should sit inside it. Returns a note for the picture, "" when drawn. */
  function ghostTemplate(cv: HTMLCanvasElement, slot: ItemSlot | null): string {
    if (slot !== "chest") return "The Jacket B template is a chest piece: pick Chest to compare.";
    if (!renderer || !views?.turned.doc.skins[TEMPLATE_SKIN]) return "This rig has no Jacket B template skin.";
    const probe = renderer.probe("turned", [TEMPLATE_SKIN], renderer.setupPose, "left", 0.5);
    const mask = garmentMask(probe.bare, probe.dressed);
    if (probe.dressed.width !== cv.width || probe.dressed.height !== cv.height) return "";
    const g = cv.getContext("2d")!;
    const img = g.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const o = i * 4;
      img.data[o] = Math.round(img.data[o]! * 0.55);
      img.data[o + 1] = Math.round(img.data[o + 1]! * 0.55 + 230 * 0.45);
      img.data[o + 2] = Math.round(img.data[o + 2]! * 0.55 + 255 * 0.45);
    }
    g.putImageData(img, 0, 0);
    return "";
  }

  async function saveWizard(): Promise<void> {
    const w = wiz;
    if (!w?.slot || w.busy || !views) return;
    const slot = w.slot;
    const item = w.editing ? w.editing.slice(w.editing.indexOf(".") + 1) : itemIdFrom(w.name);
    w.busy = true;
    w.msg = { text: "Saving...", kind: "" };
    let saved: SavedStep | null = null;
    render();
    try {
      for (const v of VIEWS) {
        const pieces: PieceSave[] = w.pieces[v].flatMap((p) => (p.rigSlot ? [toSave(p)] : []));
        if (!pieces.length) continue;
        const data = views[v];
        const raw = (await (await fetch(`/repo/${data.file}?v=${Date.now()}`)).json()) as never;
        const hash = ((await (await fetch(`/api/rig/hash?file=${encodeURIComponent(data.file)}`)).json()) as { hash: string }).hash;
        const bendPieces = w.pieces[v].filter((p) => p.rigSlot && p.bend !== false);
        const transfers = bendPieces.length ? await importTransfers(data.file, `${slot}.${item}`, bendPieces) : {};
        const batch = buildItemBatch(raw, { slot, item, rigName: data.name, pieces, replace: !!w.editing, transfers });
        lastTransfers = Object.values(transfers).map((t) => t.report);
        const res = await fetch("/api/rig/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: data.file, atlas: data.atlas, base: hash, undo: 0, batches: [batch.commands], images: batch.images }) });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `save failed (${res.status})`);
        saved = { file: data.file, atlas: data.atlas, commands: batch.commands, images: batch.images };
      }
      const name = `${slot}.${item}`;
      wiz = null;
      await reloadOpenRig();
      await refresh();
      selected = name;
      wear(name, true);
      if (saved) pushSaveStep(name, w.editing ? "Edit" : "New item", saved);
      getHost()?.status(`Saved ${name} and put it on${lastTransfers.length ? `. ${transferSummary(lastTransfers)}` : ""}`, "ok");
    } catch (e) {
      w.busy = false;
      w.msg = { text: e instanceof Error ? e.message : String(e), kind: "bad" };
      render();
    }
  }

  // ------------------------------------------------------------------------------------------------ contact sheet

  function viewIssues(itemName: string, v: ViewId): string[] {
    const it = items.find((i) => i.name === itemName);
    return (it?.issues ?? []).filter((i) => i.view === v).map((i) => issueChip(i).text);
  }

  async function haveClipNames(): Promise<Set<string>> {
    const host = getHost();
    const names = new Set<string>([...(host?.clips().map((c) => c.name) ?? []), ...(host?.saved() ?? [])]);
    return names;
  }

  async function clipData(s: Sheet, name: string): Promise<ClipData | null> {
    const host = getHost();
    if (s.clips.has(name)) return s.clips.get(name) ?? null;
    let data: ClipData | null = null;
    if (host && host.clipName === name) data = host.clip;
    else {
      try {
        const r = await fetch(`/repo/${SAVE_DIR}/${name}.clip.json?v=${Date.now()}`);
        if (r.ok) data = parseClip(await r.json());
      } catch {
        data = null;
      }
    }
    s.clips.set(name, data);
    return data;
  }

  async function openSheet(itemName: string, mode?: "clips" | "sweep"): Promise<void> {
    if (!renderer) await refresh();
    const clips = clipRows(await haveClipNames());
    const m = mode ?? (clips.length ? "clips" : "sweep");
    sheet = { item: itemName, mode: m, rows: m === "clips" ? clips : sweepRows(), page: 0, per: 1, cache: new Map(), clips: new Map(), token: 0, busy: "" };
    overlay.hidden = false;
    drawSheet();
  }

  function closeSheet(): void {
    if (sheet) sheet.token++;
    sheet = null;
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  const cellKey = (row: SheetRow, v: ViewId, f: number) => `${row.key}|${v}|${f}`;

  async function renderCell(s: Sheet, row: SheetRow, v: ViewId, f: number): Promise<Cell> {
    const key = cellKey(row, v, f);
    const have = s.cache.get(key);
    if (have) return have;
    let cell: Cell;
    try {
      if (!renderer) throw new Error("rigs not loaded");
      if (row.kind === "sweep") {
        const r = renderer.render(v, [s.item], renderer.sweepPose(row.sweep!, row.sweep!.values[f]!));
        cell = { canvas: r.canvas, hits: [...viewIssues(s.item, v), ...r.hits] };
      } else {
        const clip = await clipData(s, row.clipName!);
        if (!clip) throw new Error(`clip ${row.clipName} could not be read`);
        const t = sheetFrames(clip)[f]!.t;
        const r = renderer.render(v, [s.item], renderer.clipPose(v, row.clipName!, clip, t));
        cell = { canvas: r.canvas, hits: [...viewIssues(s.item, v), ...r.hits] };
      }
    } catch (e) {
      const canvas = document.createElement("canvas");
      canvas.width = 60;
      canvas.height = 80;
      cell = { canvas, hits: [], error: e instanceof Error ? e.message : String(e) };
    }
    s.cache.set(key, cell);
    return cell;
  }

  function sheetCounts(s: Sheet): { cells: number; failing: number } {
    const all = [...s.cache.values()];
    return { cells: all.length, failing: all.filter((c) => c.hits.length || c.error).length };
  }

  /** The small tag inside a cell: a sweep cell names the angle it shows. Same text on screen and in the PNG. */
  const cellTag = (row: SheetRow, f: number): string => (row.kind === "sweep" ? `${row.sweep!.values[f]! > 0 ? "+" : ""}${row.sweep!.values[f]}°` : "");
  const frameHead = (s: Sheet, f: number): string => (s.mode === "clips" ? FRAME_LABELS[f]! : `Pose ${f + 1}`);
  const reasonsOf = (cell: Cell): string[] => (cell.error ? [cell.error] : [...new Set(cell.hits)]);

  /** Every failing cell drawn so far, in sheet order. */
  function failingCells(s: Sheet): { row: SheetRow; f: number; reasons: string[] }[] {
    const out: { row: SheetRow; f: number; reasons: string[] }[] = [];
    for (const row of s.rows) {
      for (let f = 0; f < SHEET_COLUMNS; f++) {
        const cell = s.cache.get(cellKey(row, "turned", f));
        if (cell && (cell.hits.length || cell.error)) out.push({ row, f, reasons: reasonsOf(cell) });
      }
    }
    return out;
  }

  function updateFails(s: Sheet): void {
    const bar = overlay.querySelector<HTMLElement>(".swfails");
    if (!bar) return;
    const list = failingCells(s);
    const counts = sheetCounts(s);
    const sc = overlay.querySelector("#swscount");
    if (sc) sc.textContent = `${counts.cells} of ${s.rows.length * SHEET_COLUMNS} cells drawn, ${counts.failing} failing`;
    bar.replaceChildren();
    if (!list.length) {
      bar.append(h("span", { class: "swfok", text: counts.cells < s.rows.length * SHEET_COLUMNS ? "Drawing cells..." : "Every cell passes" }));
      return;
    }
    bar.append(h("span", { class: "swflabel", text: `Failing (${list.length})` }));
    for (const it of list.slice(0, 10)) {
      bar.append(
        h("button", {
          class: "chip-bad swfchip",
          "data-fail": `${it.row.key}|${it.f}`,
          title: `${it.row.label}, ${frameHead(s, it.f)}: ${it.reasons.join("; ")}. Click to go to the cell.`,
          text: `${it.row.label} · ${frameHead(s, it.f)}`,
          onclick: () => {
            s.page = pageOfRow(s.rows.indexOf(it.row), s.per);
            drawSheet();
            const cell = overlay.querySelector<HTMLElement>(`.swc[data-row="${CSS.escape(it.row.key)}"][data-frame="${it.f}"]`);
            cell?.classList.add("flash");
            cell?.scrollIntoView({ block: "nearest" });
          }
        })
      );
    }
    if (list.length > 10) bar.append(h("span", { class: "swfmore", text: `+${list.length - 10} more` }));
  }

  function drawSheet(): void {
    const s = sheet;
    if (!s) return;
    const token = ++s.token;
    const head = h(
      "div",
      { class: "swshead" },
      h("button", { class: "back", "data-act": "close-sheet", text: "‹ Back", onclick: closeSheet }),
      h("div", { class: "tt" }, h("b", { text: s.item }), h("span", { id: "swscount", text: "" })),
      h(
        "div",
        { class: "seg pill swseg" },
        h("button", { class: s.mode === "clips" ? "on" : "", "data-mode": "clips", text: "Clips", onclick: () => void openSheet(s.item, "clips") }),
        h("button", { class: s.mode === "sweep" ? "on" : "", "data-mode": "sweep", text: "Pose sweep", onclick: () => void openSheet(s.item, "sweep") })
      ),
      h("button", { "data-act": "download", text: s.busy || "Download PNG", disabled: !!s.busy, onclick: () => void downloadSheet() })
    );
    const body = h("div", { class: "swsbody" });
    const fails = h("div", { class: "swfails" });
    const nav = h("div", { class: "swsnav" });
    overlay.replaceChildren(head, body, fails, nav);
    if (!s.rows.length) {
      body.append(h("div", { class: "swnote", text: "No clips exist on the board yet. Use Pose sweep to see this item through the poses that stress it most." }, h("br"), h("button", { class: "primary btn-primary", text: "Pose sweep", onclick: () => void openSheet(s.item, "sweep") })));
      return;
    }
    // The page is as many rows as fit the window at a judgeable size; the rows then share the height exactly, so the whole page is visible.
    const cs = getComputedStyle(body);
    const availH = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - HEAD_ROW_H - ROW_GAP;
    s.per = rowsThatFit(availH, s.rows.length);
    const rowH = Math.min(rowHeightFor(availH, s.per), 420);
    const pages = pageCount(s.rows.length, s.per);
    s.page = Math.min(s.page, pages - 1);
    const grid = h("div", { class: "swgrid", style: `--rowh:${rowH}px;--aspect:${(renderer?.aspect("turned") ?? 0.6).toFixed(4)}` });
    grid.append(h("div", { class: "swcorner" }));
    for (let f = 0; f < SHEET_COLUMNS; f++) grid.append(h("div", { class: "swfh", text: frameHead(s, f) }));
    const rows = pageRows(s.rows, s.page, s.per);
    const slots = new Map<string, HTMLElement>();
    for (const row of rows) {
      grid.append(h("div", { class: "swrl", "data-row-label": row.key }, h("span", { text: row.label }), h("small", { text: row.kind === "sweep" ? row.sweep!.values.map((x) => `${x}°`).join("  ") : row.game?.group ?? "" })));
      for (let f = 0; f < SHEET_COLUMNS; f++) {
        const c = h("button", { class: "swc wait", "data-row": row.key, "data-view": "turned", "data-frame": f, "aria-label": `${row.label}, ${frameHead(s, f)}` });
        slots.set(cellKey(row, "turned", f), c);
        grid.append(c);
      }
    }
    body.append(grid);
    const fill = (el: HTMLElement, row: SheetRow, f: number, cell: Cell): void => {
      el.classList.remove("wait");
      const reasons = reasonsOf(cell);
      const tag = cellTag(row, f);
      el.replaceChildren(cell.canvas, ...(tag ? [h("span", { class: "swtag", text: tag })] : []), ...(reasons.length ? [h("span", { class: "swwhy", text: reasons[0]! })] : []));
      el.classList.toggle("bad", reasons.length > 0);
      el.title = reasons.length ? `Fails: ${reasons.join("; ")}` : "Passes";
      el.onclick = () => void openCell(s, row, "turned", f);
    };
    void (async () => {
      for (const row of rows) {
        for (let f = 0; f < SHEET_COLUMNS; f++) {
          if (sheet !== s || s.token !== token) return;
          if (!s.cache.has(cellKey(row, "turned", f))) await frameTick();
          const cell = await renderCell(s, row, "turned", f);
          if (sheet !== s || s.token !== token) return;
          fill(slots.get(cellKey(row, "turned", f))!, row, f, cell);
          updateFails(s);
        }
      }
    })();
    updateFails(s);
    nav.append(
      h("button", { "data-act": "prev", text: "‹", title: "Previous page", disabled: s.page <= 0, onclick: () => ((s.page = Math.max(0, s.page - 1)), drawSheet()) }),
      h("span", { id: "swspage", text: `Page ${s.page + 1} of ${pages}  (${s.rows.length} row${s.rows.length === 1 ? "" : "s"}, ${s.per} per page, scale ${SHEET_SCALE})` }),
      h("button", { "data-act": "next", text: "›", title: "Next page", disabled: s.page >= pages - 1, onclick: () => ((s.page = Math.min(pages - 1, s.page + 1)), drawSheet()) }),
      h("span", { class: "swlegend" }, h("i"), " red corner = fails an pose rule or an item check; the reason is on the cell and in the Failing list")
    );
  }

  async function openCell(s: Sheet, row: SheetRow, v: ViewId, f: number): Promise<void> {
    const host = getHost();
    if (!host || row.kind !== "clip" || !row.clipName) return;
    try {
      const outfit = views?.[v].outfit ?? target;
      if (outfit && host.rig?.outfit.id !== outfit) await host.mountOutfit(outfit);
      if (host.clips().some((c) => c.name === row.clipName)) host.switchClip(row.clipName);
      else await host.openSaved(`${row.clipName}.clip.json`);
      const clip = await clipData(s, row.clipName);
      if (clip) host.setTime(sheetFrames(clip)[f]!.t, true);
      applyWorn();
      closeSheet();
      ws.go("animate");
    } catch (e) {
      host.status(`Could not open ${row.clipName}: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
  }

  async function downloadSheet(): Promise<void> {
    const s = sheet;
    if (!s || !s.rows.length) return;
    try {
      s.busy = "Rendering...";
      const btn = overlay.querySelector<HTMLButtonElement>('[data-act="download"]');
      if (btn) (btn.textContent = s.busy), (btn.disabled = true);
      for (const row of s.rows) {
        for (let f = 0; f < SHEET_COLUMNS; f++) {
          if (!s.cache.has(cellKey(row, "turned", f))) await frameTick();
          await renderCell(s, row, "turned", f);
        }
      }
      // The same grid as the screen, every page in one image: label column, header row of frame names, one row per clip, the same
      // red corner and reason strip on failing cells, the same angle tags on sweep cells.
      const first = s.cache.get(cellKey(s.rows[0]!, "turned", 0));
      const cw = first?.canvas.width ?? 60;
      const ch = first?.canvas.height ?? 80;
      const pad = 12;
      const labelW = 170;
      const titleH = 40;
      const headH = 26;
      const W = pad + labelW + SHEET_COLUMNS * (cw + 4) + pad;
      const H = titleH + headH + s.rows.length * (ch + ROW_GAP) + pad;
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const g = out.getContext("2d")!;
      g.fillStyle = "#12151b";
      g.fillRect(0, 0, W, H);
      g.textBaseline = "alphabetic";
      g.fillStyle = "#f0b84a";
      g.font = "bold 16px sans-serif";
      g.fillText(`${s.item}: ${s.mode === "clips" ? "every clip" : "pose sweep"} (scale ${SHEET_SCALE})`, pad, 26);
      g.fillStyle = "#9aa3b5";
      g.font = "11px sans-serif";
      g.textAlign = "center";
      for (let f = 0; f < SHEET_COLUMNS; f++) g.fillText(frameHead(s, f), pad + labelW + f * (cw + 4) + cw / 2, titleH + 16);
      g.textAlign = "left";
      s.rows.forEach((row, ri) => {
        const y = titleH + headH + ri * (ch + ROW_GAP);
        g.fillStyle = "#d9dee8";
        g.font = "600 13px sans-serif";
        g.fillText(row.label, pad, y + 20);
        g.fillStyle = "#9aa3b5";
        g.font = "11px sans-serif";
        g.fillText(row.kind === "sweep" ? row.sweep!.values.map((x) => `${x}°`).join("  ") : row.game?.group ?? "", pad, y + 36);
        for (let f = 0; f < SHEET_COLUMNS; f++) {
          const x = pad + labelW + f * (cw + 4);
          const cell = s.cache.get(cellKey(row, "turned", f));
          if (!cell) continue;
          g.drawImage(cell.canvas, x, y);
          const tag = cellTag(row, f);
          if (tag) {
            g.font = "11px sans-serif";
            g.fillStyle = "rgba(18,21,27,0.8)";
            g.fillRect(x + 6, y + 6, g.measureText(tag).width + 12, 18);
            g.fillStyle = "#d9dee8";
            g.fillText(tag, x + 12, y + 19);
          }
          const reasons = reasonsOf(cell);
          if (reasons.length) {
            g.fillStyle = "#e5484d";
            g.beginPath();
            g.moveTo(x + cw, y);
            g.lineTo(x + cw - 22, y);
            g.lineTo(x + cw, y + 22);
            g.fill();
            g.fillStyle = "rgba(74,31,35,0.92)";
            g.fillRect(x, y + ch - 20, cw, 20);
            g.fillStyle = "#ffb3b6";
            g.font = "11px sans-serif";
            let text = reasons[0]!;
            while (text.length > 4 && g.measureText(text).width > cw - 12) text = `${text.slice(0, -2)}…`;
            g.fillText(text, x + 6, y + ch - 6);
          }
        }
      });
      const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, "image/png"));
      if (!blob) throw new Error("could not make the PNG");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${s.item}-${s.mode === "clips" ? "contact-sheet" : "pose-sweep"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      getHost()?.status(`Could not make the PNG: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      s.busy = "";
      if (sheet === s) {
        const btn = overlay.querySelector<HTMLButtonElement>('[data-act="download"]');
        if (btn) (btn.textContent = "Download PNG"), (btn.disabled = false);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ judge bar

  /**
   * The strip under the workshop title: the user's flow in one place. Phone size, Facing right, step through poses, and one pass / fail
   * chip per gate (a click on a failing chip jumps to the failing pose). Patched in place (never rebuilt), so a click never loses focus.
   */
  const judge = h("div", { id: "swjudge", class: "swjudge" });
  const jPhone = h("button", { id: "sw-phone", class: "swjtoggle", "data-act": "phone", text: "Phone size", onclick: () => (window.atlasPhone?.toggle(), updateJudge()) });
  const jFacing = h("button", { id: "sw-facing", class: "swjtoggle", "data-act": "facing", text: "Facing right", onclick: () => (getHost()?.setFacing(getHost()?.facing === "right" ? "left" : "right"), updateJudge()) });
  const jPrev = h("button", { id: "sw-prevpose", class: "swjstep", "data-act": "prev-pose", text: "‹", onclick: () => stepPose(-1) });
  const jPose = h("span", { id: "sw-pose", class: "swjpose", text: "" });
  const jNext = h("button", { id: "sw-nextpose", class: "swjstep", "data-act": "next-pose", text: "›", onclick: () => stepPose(1) });
  const jFit = h("button", { id: "sw-gate-fit", class: "swgate", "data-gate": "fit", onclick: () => gateClick("fit") });
  const jOutline = h("button", { id: "sw-gate-outline", class: "swgate", "data-gate": "outline", onclick: () => gateClick("outline") });
  const jRules = h("button", { id: "sw-gate-rules", class: "swgate", "data-gate": "rules", onclick: () => gateClick("rules") });
  const jNote = h("div", { id: "sw-judge-note", class: "swjnote", text: "" });
  const TEMPLATE_SKIN = "chest.jacket_b";
  let gateRun: GateRun | null = null;
  let gateBusy = "";
  let templateOn = false;
  const jSample = h("button", { id: "sw-gates-sample", "data-act": "gates-sample", text: "Sample gates", title: "Neck, shoulders and cuffs on a few poses (setup, a 60 degree elbow, four frames of the open clip), turned facing only. The result says Sampled.", onclick: () => void runGateCheck("sample") });
  const jFull = h("button", { id: "sw-gates-full", "data-act": "gates-full", text: "Full gate check", title: "Neck, shoulders and cuffs on EVERY frame of the open clip plus a 60 degree elbow, turned and mirrored, for the whole worn set and each worn item alone. Only this can say Full.", onclick: () => void runGateCheck("full") });
  const jTemplate = h("button", { id: "sw-template", "data-act": "template-overlay", class: "swjtoggle", text: "Template: Jacket B", title: "Ghost the approved Jacket B chest template over the wizard picture and the checked frame, so a chest piece can be compared with it", onclick: () => ((templateOn = !templateOn), jTemplate.classList.toggle("on", templateOn), jTemplate.setAttribute("aria-pressed", String(templateOn)), schedulePreview(), paintGateReport()) });
  jTemplate.setAttribute("aria-pressed", "false");
  const jReport = h("div", { id: "sw-gate-report", class: "swgreport", "aria-live": "polite" });
  judge.append(
    h("div", { class: "swjrow" }, jPhone, jFacing, h("span", { class: "swjsteps" }, jPrev, jPose, jNext)),
    h("div", { class: "swjrow swjgates" }, h("span", { class: "swjlabel", text: "Gates" }), jFit, jOutline, jRules),
    h("div", { class: "swjrow swjgates" }, h("span", { class: "swjlabel", text: "Garment" }), jSample, jFull, jTemplate),
    jReport,
    jNote
  );

  /** Runs the garment gates (neck, shoulders, cuffs, plus the live ink gate's state) and shows what was and was not covered. */
  async function runGateCheck(mode: "sample" | "full"): Promise<void> {
    const host = getHost();
    if (!renderer || !host || gateBusy) return;
    if (!worn.length) {
      gateRun = null;
      jReport.textContent = "Wear an item first: the garment gates judge what it does to the body.";
      return;
    }
    gateBusy = mode;
    paintGateReport();
    try {
      gateRun = await runGates({
        renderer,
        worn: [...worn],
        clipName: host.clipName || null,
        clip: host.clipName ? host.clip : null,
        mode,
        progress: (d, t) => {
          jReport.textContent = `Checking ${d} of ${t}...`;
        }
      });
    } catch (e) {
      gateRun = null;
      jReport.textContent = `The gate check could not run: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      gateBusy = "";
      window.dispatchEvent(new CustomEvent("atlas-gates"));
    }
    paintGateReport();
    updateJudge();
  }

  function paintGateReport(): void {
    if (gateBusy && !gateRun) return;
    jReport.replaceChildren();
    if (!gateRun) return;
    const run = gateRun;
    jReport.append(h("div", { class: "swgsource", text: `${run.mode === "full" ? "Full gate check" : "Sampled gate check"}: ${run.frames} pose${run.frames === 1 ? "" : "s"}. ${run.source}` }));
    for (const r of run.results) {
      const row = h("div", { class: `swgrow ${r.status}`, "data-gate": r.id, "data-state": r.status, "data-scope": r.coverage.scope }, h("b", { text: `${r.status === "pass" ? "Pass" : r.status === "fail" ? "Fail" : r.status === "n/a" ? "n/a" : "Idle"} ${r.label}` }), h("span", { text: ` ${r.coverage.scope === "full" ? "Full" : "Sampled"}: ${r.summary}`, title: `Frames: ${r.coverage.frames.join(", ") || "none"}. Worn combos: ${r.coverage.combos.join(" | ")}. Facings: ${r.coverage.facings.join(", ")}.` }));
      for (const f of r.findings.slice(0, 4)) {
        row.append(h("button", { class: "swgjump", "data-act": "gate-jump", text: `${f.frame} (${f.facing}): ${f.reason}`, title: "Jump the editor to this frame", onclick: () => f.time !== null && getHost()?.setTime(f.time, true) }));
      }
      jReport.append(row);
    }
    if (run.shot) {
      const c = document.createElement("canvas");
      c.width = run.shot.canvas.width;
      c.height = run.shot.canvas.height;
      c.id = "sw-gate-shot";
      c.title = `First failing picture: ${run.shot.label}. Red ring = where.`;
      const g = c.getContext("2d")!;
      g.drawImage(run.shot.canvas, 0, 0);
      if (run.shot.at) {
        g.strokeStyle = "#ff3b3b";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(run.shot.at.x, run.shot.at.y, 12, 0, Math.PI * 2);
        g.stroke();
      }
      jReport.append(c);
    }
  }

  interface GateState {
    tone: "ok" | "bad" | "idle";
    glyph: string;
    text: string;
    tip: string;
    /** Poses (seconds) a click on a failing chip visits, one per click. */
    poses: number[];
  }
  const cycle: Record<string, number> = { outline: 0, rules: 0 };
  let rulesCache: { clip: unknown; skins: string; issues: GateIssue[] } | null = null;

  const wornItems = (): Item[] => items.filter((i) => worn.includes(i.name));

  function fitGate(): GateState {
    const w = wornItems();
    if (!w.length) return { tone: "idle", glyph: "–", text: "Fit & neck", tip: "Wear an item to check its fit and neck cover", poses: [] };
    const bad = w.filter((i) => i.issues.length);
    if (!bad.length) return { tone: "ok", glyph: "✓", text: "Fit & neck", tip: `${w.map((i) => i.item).join(", ")}: parts are all there, sized to the body and covering the neck`, poses: [] };
    const n = bad.reduce((a, i) => a + i.issues.length, 0);
    return { tone: "bad", glyph: "!", text: `Fit & neck ${n}`, tip: `${bad[0]!.item}: ${bad[0]!.issues.map((i) => issueChip(i).text).join("; ")}. Click to see the item's checks.`, poses: [] };
  }

  function outlineGate(): GateState {
    const g = window.atlasGate?.summary();
    if (!g || !g.applies) return { tone: "idle", glyph: "–", text: "Outline", tip: "The outline gate runs on the pro rig", poses: [] };
    if (!g.worn) return { tone: "idle", glyph: "–", text: "Outline", tip: "Wear an item to check that its ink outline stays unbroken", poses: [] };
    const host = getHost();
    if (g.checking) return { tone: "idle", glyph: "…", text: "Checking", tip: g.message, poses: [] };
    if (g.clip) {
      if (g.clip.bad.length) {
        const times = g.clip.bad.map((f) => frameTime(host!.clip, f));
        return { tone: "bad", glyph: "!", text: `Outline ${g.clip.bad.length} frame${g.clip.bad.length === 1 ? "" : "s"}`, tip: `The ink outline breaks on ${g.clip.bad.length} of ${g.clip.frames} frames (red ticks on the timeline). Click to jump to the next one.`, poses: times };
      }
      return { tone: "ok", glyph: "✓", text: "Outline", tip: `All ${g.clip.frames} frames of this clip keep an unbroken outline`, poses: [] };
    }
    if (g.poseBreaks) return { tone: "bad", glyph: "!", text: "Outline here", tip: `${g.poseBreaks} outline break${g.poseBreaks === 1 ? "" : "s"} on this pose (red circles on the canvas). Click to check the whole clip.`, poses: [] };
    return { tone: "idle", glyph: g.poseBreaks === 0 ? "✓" : "–", text: "Check outline", tip: g.poseBreaks === 0 ? "This pose is clean. Click to check every frame of the clip." : "Click to check every frame of the open clip", poses: [] };
  }

  function rulesGate(): GateState {
    const host = getHost();
    if (!host?.doc || !host.clipName) return { tone: "idle", glyph: "–", text: "Pose rules", tip: "Open a clip to check its poses against the user rules", poses: [] };
    const skins = (host.skeleton?.activeSkins ?? []).join("+");
    if (!rulesCache || rulesCache.clip !== host.clip || rulesCache.skins !== skins) rulesCache = { clip: host.clip, skins, issues: clipGates(host.doc, host.clipName, host.clip).filter((i) => i.kind !== "outline" && i.severity !== "info") };
    const bad = rulesCache.issues;
    if (!bad.length) return { tone: "ok", glyph: "✓", text: "Pose rules", tip: "Every pose of this clip keeps the user rules (arms, head, limbs, eyes)", poses: [] };
    return { tone: "bad", glyph: "!", text: `Pose rules ${bad.length}`, tip: `${bad[0]!.message}. Click to jump to the pose.`, poses: bad.map((i) => i.time).filter((t): t is number => typeof t === "number") };
  }

  function paintGate(btn: HTMLButtonElement, st: GateState): void {
    btn.className = `swgate ${st.tone}`;
    btn.dataset.state = st.tone === "ok" ? "pass" : st.tone === "bad" ? "fail" : "idle";
    btn.textContent = `${st.glyph} ${st.text}`;
    btn.title = st.tip;
  }

  function gateClick(which: "fit" | "outline" | "rules"): void {
    const host = getHost();
    if (which === "fit") {
      const bad = wornItems().find((i) => i.issues.length);
      if (bad) {
        selected = bad.name;
        render();
        root.querySelector(".swdetail")?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    const st = which === "outline" ? outlineGate() : rulesGate();
    if (st.poses.length && host) {
      const i = cycle[which]! % st.poses.length;
      cycle[which] = i + 1;
      host.setTime(st.poses[i]!, true);
      return;
    }
    if (which === "outline" && st.tone === "idle" && st.text === "Check outline") void window.atlasGate?.checkClip().then(updateJudge);
    else if (which === "outline" && st.tone === "bad") void window.atlasGate?.checkClip().then(updateJudge);
  }

  function stepPose(dir: 1 | -1): void {
    getHost()?.jumpToKey(dir, true);
    updateJudge();
  }

  function updateJudge(): void {
    const host = getHost();
    judge.hidden = !!wiz || !host;
    if (judge.hidden || !host) return;
    const phone = window.atlasPhone?.on() ?? false;
    jPhone.classList.toggle("on", phone);
    jPhone.setAttribute("aria-pressed", String(phone));
    const right = host.facing === "right";
    jFacing.classList.toggle("on", right);
    jFacing.setAttribute("aria-pressed", String(right));
    const hasClip = !!host.clipName;
    jPrev.disabled = jNext.disabled = !hasClip;
    jPose.textContent = hasClip ? `Frame ${timeToFrame(host.clip, host.time)}` : "No clip";
    const fit = fitGate();
    const outline = outlineGate();
    const rules = rulesGate();
    paintGate(jFit, fit);
    paintGate(jOutline, outline);
    paintGate(jRules, rules);
    const states = [fit, outline, rules];
    const failing = states.filter((s) => s.tone === "bad").length;
    jNote.textContent = !worn.length ? "Pick an item below to wear it and judge it here." : failing ? `${failing} gate${failing === 1 ? "" : "s"} failing: click a red chip to jump to the pose.` : states.every((s) => s.tone === "ok") ? "Every gate passes." : "No failures so far. Click a grey chip to check it.";
  }
  let gateSub: (() => void) | null = null;
  let judgeTimer: ReturnType<typeof setTimeout> | null = null;
  const judgeSoon = (): void => {
    if (judgeTimer) return;
    judgeTimer = setTimeout(() => {
      judgeTimer = null;
      if (!root.hidden) updateJudge();
    }, 60);
  };

  // ------------------------------------------------------------------------------------------------ visible undo / redo

  const swUndo = h("button", { id: "sw-undo", "data-act": "undo", text: "Undo", onclick: () => getHost()?.undo() });
  const swRedo = h("button", { id: "sw-redo", "data-act": "redo", text: "Redo", onclick: () => getHost()?.redo() });
  /** Mirrors the editor's own Undo / Redo (state and the step's name in the tooltip), so the workspace shows what the next step is. */
  function syncHistory(): void {
    for (const [mine, id] of [[swUndo, "undo"], [swRedo, "redo"]] as const) {
      const src = document.getElementById(id) as HTMLButtonElement | null;
      mine.disabled = !src || src.disabled;
      mine.title = src?.title || (id === "undo" ? "Undo the last step" : "Redo the step you took back");
    }
  }
  for (const id of ["undo", "redo"]) {
    const src = document.getElementById(id);
    if (src) new MutationObserver(syncHistory).observe(src, { attributes: true, attributeFilter: ["disabled", "title"] });
  }

  // ------------------------------------------------------------------------------------------------ shell

  function render(): void {
    const scrollTop = root.querySelector<HTMLElement>(".swscroll")?.scrollTop ?? 0;
    const host = getHost();
    const head = h(
      "div",
      { class: "swhead" },
      h("div", {}, h("h2", { text: "Swag workshop" }), h("p", { text: wiz ? (wiz.editing ? `Editing ${wiz.editing}` : "Make a new item") : "Wear it, check it, ship it." })),
      wiz ? null : h("button", { class: "primary btn-primary", id: "swnew", "data-act": "new", text: "New item", ...(target && views ? {} : { disabled: true }), title: target ? "Make a new item on the target rig" : "Choose the target rig first", onclick: () => ((wiz = newWizard()), render()) })
    );
    const sel = h("select", { id: "swtarget", "aria-label": "Target rig", title: "The rig Swag edits. Items are read from this rig and saved into it. Nothing is picked for you if you have not chosen" }, h("option", { value: "", text: "Choose a rig..." }), ...OUTFITS.map((o) => h("option", { value: o.id, text: o.label })));
    sel.value = target;
    sel.disabled = !!wiz;
    sel.addEventListener("change", () => void chooseTarget(sel.value));
    const mismatch = target && host?.rig && host.rig.outfit.id !== target;
    const targetRow = h(
      "div",
      { class: "swtarget" },
      h("label", { for: "swtarget", text: "Target rig" }),
      sel,
      mismatch ? h("button", { id: "swshowtarget", "data-act": "show-target", text: "Show it", title: `The canvas shows ${host!.rig!.outfit.label}. Show the target rig there`, onclick: () => void host?.mountOutfit(target).then(() => (applyWorn(), render())) }) : null
    );
    const tools = h("div", { class: "swtools" }, targetRow, h("span", { class: "swhist", role: "group", "aria-label": "History" }, swUndo, swRedo));
    const body = h("div", { class: "swscroll" }, wiz ? wizardView() : h("div", {}, target ? listView() : h("div", { class: "swnote", id: "swpicknote", text: "Choose the rig this workshop edits. Its items, wearing and saving all happen on that rig." }), detail()));
    root.replaceChildren(head, tools, judge, body);
    syncHistory();
    updateJudge();
    body.scrollTop = scrollTop;
  }

  whenHost((host) => {
    for (const ev of ["time", "pose", "skins", "clip", "select", "tool"] as const) host.on(ev, judgeSoon);
    setInterval(() => {
      if (!gateSub && window.atlasGate) gateSub = window.atlasGate.onChange(judgeSoon);
      judgeSoon();
    }, 500);
    host.on("rig", () => {
      judgeSoon();
      if (!root.hidden && target && host.rig && !wiz && !loading) render();
      // A remount (a Setup edit, a reload) keeps what the rig already wears: adopt skins put on elsewhere (the Skins panel) instead of
      // wiping them with this list, which would make the character change on release of a Setup drag.
      const have = haveSkins();
      const now = host.wornSkins().filter((n) => have.has(n));
      if (now.length && now.join("+") !== wearList(worn, have).join("+")) {
        worn = now;
        render();
      } else applyWorn();
    });
  });
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sheet && !overlay.hidden) drawSheet();
    }, 150);
  });
  ws.onChange((id) => {
    root.hidden = id !== "swag";
    if (id === "swag") {
      adoptOpenRig();
      judgeSoon();
    }
    if (id !== "swag") closeSheet();
    else if (!views && !loading) void refresh();
    else if (views) render();
  });
  render();

  const api: SwagApi = {
    refresh,
    target: () => target,
    chooseTarget,
    edit: async (name) => {
      const it = items.find((i) => i.name === name);
      if (it) await openEdit(it);
    },
    items: () => items,
    worn: () => [...worn],
    wear,
    openSheet,
    async runGates(mode) {
      await runGateCheck(mode);
      return gateRun;
    },
    lastGates: () => gateRun,
    sheetState() {
      if (!sheet) return null;
      const c = sheetCounts(sheet);
      return { open: !overlay.hidden, page: sheet.page, pages: pageCount(sheet.rows.length), rows: sheet.rows.length, failing: c.failing, cells: c.cells, mode: sheet.mode };
    }
  };
  window.atlasSwag = api;
  return api;
}
