/*
 * Atlas Animator editor: the bottom dock of the Rig workspace (the design notes, section 2.6).
 *
 * A 36 px tab strip at the lower edge of the stage that opens a drawer OVER the canvas (the canvas is never resized). Tabs:
 *   Images      the atlas image browser: a thumbnail grid cut from the rig's atlas pages, search, "show variants", "new slot on <bone>",
 *               "make default", Attach image and Import PNG. A thumbnail drags onto a Tree slot / draw-order / bone row to attach it there.
 *   Edits       the Setup command log (the last edits) and Revert rig to saved.
 *   Draw order  the slot draw order, front on top, drag a row to reorder.
 *
 * setupMode.ts owns the state and the commit path and hands this module a `DockCtx`; nothing here edits the rig except through it.
 */
import { iconHtml } from "./icons.js";
import { groupRegions, type AtlasRegion } from "./setupAttach.js";
import { drawOrderOf, planDrawOrderTo } from "./setupRigPlans.js";
import type { Command, JsonObject } from "./setupModel.js";

/** The drag type of a thumbnail (the Tree reads it on dragover / drop). */
export const IMAGE_DRAG_TYPE = "application/x-atlas-image";

/** The editor-only state of the Images tab (kept by setupMode.ts, shared with the old Attach block's callers). */
export interface AttachState {
  filter: string;
  pick: string;
  asNew: boolean;
  makeDefault: boolean;
  showVariants: boolean;
}

export interface DockCtx {
  /** A key that changes when another rig is open (thumbnails are cached per rig). */
  rigKey(): string;
  regions(): AtlasRegion[];
  /** The decoded pixels of a texture path and its rectangle on the page, or undefined. */
  image(path: string): { pixels: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }; rect: { x: number; y: number; width: number; height: number } } | undefined;
  attach: AttachState;
  /** Where Attach image goes: the slot the inspector shows (slot / image page), else a new slot on the selected bone. */
  target(): { slot: string | null; bone: string | null };
  attachRegion(path: string, o: { slot: string | null; bone?: string }): void;
  attachFile(file: File, o: { slot: string | null }): void;
  /** Makes one image-sequence attachment of the picked atlas images (numbered frames) on the selected slot. */
  makeSequence(paths: string[]): void;
  /** Imports several numbered PNG files (boom_01.png, boom_02.png ...) as atlas images and plays them as one image sequence. */
  attachSequenceFiles(files: File[], o: { slot: string | null }): void;
  status(text: string, kind?: "" | "bad" | "ok"): void;
  edits(): string[];
  unsaved(): number;
  revert(): void;
  raw(): JsonObject | null;
  run(label: string, make: (raw: JsonObject) => { commands: Command[] }): Promise<boolean>;
  /** Setup mode is on. */
  active(): boolean;
}

type Tab = "images" | "edits" | "order";
const STORE = "atlasEditor.imgdock.v1";

let getCtx: () => DockCtx | null = () => null;
let root: HTMLElement | null = null;
let open = false;
let tab: Tab = "images";
let thumbSig = "";
const thumbCache = new Map<string, string>();
let thumbRig = "";
/** Atlas paths picked with Ctrl / Shift-click, for Make sequence (the plain click still picks one image to attach). */
const multi = new Set<string>();

function load(): void {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}") as { open?: boolean; tab?: Tab };
    open = v.open === true;
    if (v.tab === "images" || v.tab === "edits" || v.tab === "order") tab = v.tab;
  } catch {
    /* storage blocked: the dock still works for this session */
  }
}
function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ open, tab }));
  } catch {
    /* ignore */
  }
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "class") n.className = String(v);
    else if (k === "html") n.innerHTML = String(v);
    else (n as unknown as Record<string, unknown>)[k] = v;
  }
  n.append(...kids);
  return n;
};

/** Hooks the dock into the page once (setupMode.ts calls this when it is created). */
export function installImagesDock(provider: () => DockCtx | null): void {
  getCtx = provider;
  load();
  const view = document.getElementById("view");
  if (!view || root) return;
  root = h("section", { id: "imgdock", class: "idk", ariaLabel: "Images, edits and draw order" });
  root.setAttribute("aria-label", "Bottom dock: images, edits and draw order");
  view.append(root);
  build();
  refreshImagesDock();
}

/** Opens the dock on the Images tab (the inspector's Attach image buttons, the Tree menu). */
export function openImagesDock(): void {
  open = true;
  tab = "images";
  save();
  refreshImagesDock();
  root?.querySelector<HTMLInputElement>("#idk-search")?.focus({ preventScroll: true });
}

export function imagesDockState(): { open: boolean; tab: Tab; thumbs: number } {
  return { open, tab, thumbs: root?.querySelectorAll(".idk-th").length ?? 0 };
}

/** A thumbnail dropped on a Tree row: attach it to that slot, or as a new slot on that bone. */
export function dropImageOnTarget(path: string, target: { slot?: string; bone?: string }): void {
  const ctx = getCtx();
  if (!ctx) return;
  ctx.attachRegion(path, { slot: target.slot ?? null, ...(target.bone ? { bone: target.bone } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

interface Shell {
  fold: HTMLButtonElement;
  tabs: Record<Tab, HTMLButtonElement>;
  counts: Record<Tab, HTMLElement>;
  hint: HTMLElement;
  body: HTMLElement;
}
let shell: Shell | null = null;

const TAB_META: { id: Tab; label: string; icon: "images" | "history" | "draw"; tip: string }[] = [
  { id: "images", label: "Images", icon: "images", tip: "Images: browse the rig's atlas images as thumbnails and attach one to a slot, or drag one onto a slot row in the Tree" },
  { id: "edits", label: "Edits", icon: "history", tip: "Edits: the Setup edits of this rig and Revert rig to saved" },
  { id: "order", label: "Draw order", icon: "draw", tip: "Draw order: the slots from front to back; drag a row to reorder" }
];

function build(): void {
  if (!root) return;
  const fold = h("button", { type: "button", id: "idk-fold", class: "idk-fold btn-icon", title: "Show or hide the bottom panel (Images, Edits, Draw order)", html: iconHtml("chevU") });
  fold.dataset.action = "dock-fold";
  fold.setAttribute("aria-label", "Show or hide the bottom panel");
  const tabs = {} as Record<Tab, HTMLButtonElement>;
  const counts = {} as Record<Tab, HTMLElement>;
  const strip = h("div", { class: "idk-tabs", role: "tablist" }, fold);
  for (const t of TAB_META) {
    const ct = h("span", { class: "idk-ct" });
    const b = h("button", { type: "button", id: `idk-tab-${t.id}`, class: "idk-tab", title: t.tip, html: `${iconHtml(t.icon)}<span>${t.label}</span>` }, ct);
    b.setAttribute("role", "tab");
    b.dataset.tab = t.id;
    b.dataset.action = `dock-${t.id}`;
    b.addEventListener("click", () => {
      open = true;
      tab = t.id;
      save();
      refreshImagesDock();
    });
    tabs[t.id] = b;
    counts[t.id] = ct;
    strip.append(b);
  }
  const hint = h("span", { class: "idk-hint", id: "idk-hint" });
  strip.append(h("span", { class: "spacer" }), hint);
  fold.addEventListener("click", () => {
    open = !open;
    save();
    refreshImagesDock();
  });
  const body = h("div", { class: "idk-body", id: "idk-body" });
  body.hidden = true;
  root.append(body, strip);
  shell = { fold, tabs, counts, hint, body };
}

/** Re-draws the strip and the open tab (cheap; the thumbnail grid is rebuilt only when its inputs change). */
export function refreshImagesDock(): void {
  if (!root || !shell) return;
  const ctx = getCtx();
  const on = !!ctx?.active();
  root.hidden = !on;
  document.body.classList.toggle("idk-open", on && open);
  if (!ctx || !on) return;
  const regions = ctx.regions();
  const raw = ctx.raw();
  const slots = ((raw?.["slots"] as unknown[]) ?? []).length;
  const unsaved = ctx.unsaved();
  shell.counts.images.textContent = String(regions.length);
  shell.counts.edits.textContent = unsaved ? `${unsaved} unsaved` : String(ctx.edits().length);
  shell.counts.order.textContent = String(slots);
  for (const t of TAB_META) {
    const b = shell.tabs[t.id];
    b.classList.toggle("on", open && tab === t.id);
    b.setAttribute("aria-selected", String(open && tab === t.id));
  }
  shell.fold.classList.toggle("on", open);
  shell.fold.setAttribute("aria-expanded", String(open));
  shell.body.hidden = !open;
  root.classList.toggle("open", open);
  const t = ctx.target();
  shell.hint.textContent = tab === "images" ? (t.slot ? `Attach image goes to slot ${t.slot}` : t.bone ? `Attach image makes a new slot on ${t.bone}` : "Select a bone or a slot to attach to") : "";
  if (!open) return;
  if (tab === "images") renderImages(ctx);
  else if (tab === "edits") renderEdits(ctx);
  else renderOrder(ctx);
}

// ---------------------------------------------------------------------------------------------
// Images tab
// ---------------------------------------------------------------------------------------------

/** Cuts a region out of its page and scales it to fit 84 x 56 (cached as a PNG data URL per rig and path). */
function thumbUrl(ctx: DockCtx, path: string): string | null {
  const key = ctx.rigKey();
  if (key !== thumbRig) {
    thumbCache.clear();
    thumbRig = key;
  }
  const hit = thumbCache.get(path);
  if (hit) return hit;
  const src = ctx.image(path);
  if (!src) return null;
  const { pixels, rect } = src;
  const w = Math.max(1, Math.round(rect.width));
  const hgt = Math.max(1, Math.round(rect.height));
  const full = document.createElement("canvas");
  full.width = w;
  full.height = hgt;
  const fctx = full.getContext("2d");
  if (!fctx) return null;
  const img = fctx.createImageData(w, hgt);
  for (let y = 0; y < hgt; y++) {
    const from = ((Math.round(rect.y) + y) * pixels.width + Math.round(rect.x)) * 4;
    img.data.set(pixels.data.subarray(from, from + w * 4), y * w * 4);
  }
  fctx.putImageData(img, 0, 0);
  const sc = Math.min(1, 84 / w, 56 / hgt);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * sc));
  out.height = Math.max(1, Math.round(hgt * sc));
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(full, 0, 0, out.width, out.height);
  const url = out.toDataURL("image/png");
  thumbCache.set(path, url);
  return url;
}

let imagesParts: { grid: HTMLElement; search: HTMLInputElement; count: HTMLElement; newSlot: HTMLInputElement; newSlotLabel: HTMLElement; makeDefault: HTMLInputElement; variants: HTMLInputElement; attach: HTMLButtonElement } | null = null;

function ensureImagesParts(ctx: DockCtx): NonNullable<typeof imagesParts> {
  const body = shell!.body;
  if (imagesParts && body.contains(imagesParts.grid)) return imagesParts;
  body.replaceChildren();
  const grid = h("div", { class: "idk-thumbs", id: "idk-thumbs", role: "listbox", ariaLabel: "Atlas images" });
  grid.setAttribute("aria-label", "Atlas images");
  const search = h("input", { type: "search", id: "idk-search", class: "field", placeholder: "Search atlas images", title: "Search the atlas images by name or folder" });
  search.setAttribute("aria-label", "Search atlas images");
  search.dataset.action = "dock-search";
  const count = h("div", { class: "label", id: "idk-count" });
  const chk = (id: string, tip: string): HTMLInputElement => {
    const i = h("input", { type: "checkbox", id });
    i.title = tip;
    return i;
  };
  const variants = chk("idk-variants", "Crease (c###) and generated (g####) variants of the same image");
  const newSlot = chk("idk-newslot", "Put the image on a new slot on the selected bone instead of the selected slot");
  const makeDefault = chk("idk-default", "Make the image the slot's setup (default) image");
  const newSlotLabel = h("span", { id: "idk-newslot-text" });
  const attach = h("button", { type: "button", id: "idk-attach", class: "btn-primary", textContent: "Attach image", title: "Attach the picked image to the selected slot, or to a new slot on the selected bone (double-click a thumbnail does the same)" });
  attach.dataset.action = "dock-attach";
  const seqBtn = h("button", { type: "button", id: "idk-sequence", class: "btn", textContent: "Make sequence", title: "Make sequence: Ctrl-click (or Shift-click) two or more numbered images (boom_01, boom_02, ...) then press this to add them to the selected slot as one frame-by-frame image sequence" });
  seqBtn.dataset.action = "dock-sequence";
  seqBtn.disabled = true;
  seqBtn.addEventListener("click", () => {
    const c = getCtx();
    if (!c) return;
    if (multi.size < 2) return c.status("Ctrl-click two or more numbered images in the grid first", "bad");
    c.makeSequence([...multi]);
  });
  const seqFile = h("input", { type: "file", accept: "image/png", id: "idk-import-seq-file", multiple: true });
  seqFile.style.display = "none";
  const seqImp = h("button", { type: "button", id: "idk-import-seq", class: "btn", textContent: "Import PNG sequence...", title: "Import PNG sequence: pick several numbered PNG files (boom_01.png, boom_02.png ...). Each is stored in the rig as an atlas image and one image attachment plays them as frames, on the slot the inspector shows or on a new slot" });
  seqImp.dataset.action = "dock-import-sequence";
  seqImp.addEventListener("click", () => seqFile.click());
  seqFile.addEventListener("change", () => {
    const fs = [...(seqFile.files ?? [])];
    const c = getCtx();
    if (fs.length && c) c.attachSequenceFiles(fs, { slot: newSlot.checked || !c.target().slot ? null : c.target().slot });
    seqFile.value = "";
  });
  const file = h("input", { type: "file", accept: "image/png", id: "idk-import" });
  file.style.display = "none";
  const imp = h("button", { type: "button", id: "idk-import-btn", class: "btn", textContent: "Import PNG...", title: "Attach a PNG file; it is stored in the rig as a new atlas page when you save" });
  imp.dataset.action = "dock-import";
  imp.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    const c = getCtx();
    if (f && c) c.attachFile(f, { slot: newSlot.checked || !c.target().slot ? null : c.target().slot });
    file.value = "";
  });
  variants.addEventListener("change", () => {
    const c = getCtx();
    if (c) c.attach.showVariants = variants.checked;
    refreshImagesDock();
  });
  search.addEventListener("input", () => {
    const c = getCtx();
    if (c) c.attach.filter = search.value;
    refreshImagesDock();
  });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  newSlot.addEventListener("change", () => {
    const c = getCtx();
    if (c) c.attach.asNew = newSlot.checked;
  });
  makeDefault.addEventListener("change", () => {
    const c = getCtx();
    if (c) c.attach.makeDefault = makeDefault.checked;
  });
  attach.addEventListener("click", () => {
    const c = getCtx();
    if (c) attachPicked(c, newSlot.checked);
  });
  const side = h(
    "div",
    { class: "idk-side" },
    h("label", { class: "idk-search" }, search),
    count,
    h("label", { class: "chip-toggle" }, variants, " show variants"),
    h("label", { class: "chip-toggle" }, newSlot, " ", newSlotLabel),
    h("label", { class: "chip-toggle" }, makeDefault, " make default"),
    h("div", { class: "idk-btns" }, attach, seqBtn, imp, file, seqImp, seqFile)
  );
  body.append(grid, side);
  grid.addEventListener("click", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>(".idk-th");
    const c = getCtx();
    if (!th || !c) return;
    const path = th.dataset.path ?? "";
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (multi.size === 0 && c.attach.pick) multi.add(c.attach.pick);
      if (multi.has(path)) multi.delete(path);
      else multi.add(path);
    } else multi.clear();
    c.attach.pick = path;
    for (const n of grid.querySelectorAll(".idk-th.sel")) n.classList.remove("sel");
    if (multi.size > 0) for (const n of grid.querySelectorAll<HTMLElement>(".idk-th")) n.classList.toggle("sel", multi.has(n.dataset.path ?? ""));
    else th.classList.add("sel");
    seqBtn.disabled = multi.size < 2;
    seqBtn.textContent = multi.size >= 2 ? `Make sequence (${multi.size})` : "Make sequence";
  });
  grid.addEventListener("dblclick", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>(".idk-th");
    const c = getCtx();
    if (!th || !c) return;
    c.attach.pick = th.dataset.path ?? "";
    attachPicked(c, newSlot.checked);
  });
  grid.addEventListener("dragstart", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>(".idk-th");
    if (!th || !e.dataTransfer) return void e.preventDefault();
    e.dataTransfer.setData(IMAGE_DRAG_TYPE, th.dataset.path ?? "");
    e.dataTransfer.setData("text/plain", th.dataset.path ?? "");
    e.dataTransfer.effectAllowed = "copy";
  });
  imagesParts = { grid, search, count, newSlot, newSlotLabel, makeDefault, variants, attach };
  thumbSig = "";
  void ctx;
  return imagesParts;
}

function attachPicked(ctx: DockCtx, asNew: boolean): void {
  if (!ctx.attach.pick) return ctx.status("Pick an atlas image in the grid first", "bad");
  const t = ctx.target();
  ctx.attachRegion(ctx.attach.pick, { slot: asNew || !t.slot ? null : t.slot, ...(t.bone ? { bone: t.bone } : {}) });
}

function renderImages(ctx: DockCtx): void {
  const p = ensureImagesParts(ctx);
  const t = ctx.target();
  p.search.value !== ctx.attach.filter && (p.search.value = ctx.attach.filter);
  p.variants.checked = ctx.attach.showVariants;
  p.makeDefault.checked = ctx.attach.makeDefault;
  p.newSlot.checked = ctx.attach.asNew || !t.slot;
  p.newSlot.disabled = !t.slot;
  p.newSlotLabel.textContent = `new slot on ${t.bone ?? "the bone"}`;
  const g = groupRegions(ctx.regions(), ctx.attach.filter, ctx.attach.showVariants, 500);
  p.count.textContent = `${g.shown}${g.matched > g.shown ? ` of ${g.matched}` : ""} images${g.hiddenVariants ? `, ${g.hiddenVariants} variants hidden` : ""}${g.matched === 0 ? " (nothing matches)" : ""}`;
  p.count.id = "idk-count";
  const sig = `${ctx.rigKey()}|${ctx.attach.filter}|${ctx.attach.showVariants}|${g.shown}|${ctx.regions().length}`;
  if (sig === thumbSig) {
    for (const n of p.grid.querySelectorAll<HTMLElement>(".idk-th")) n.classList.toggle("sel", n.dataset.path === ctx.attach.pick);
    return;
  }
  thumbSig = sig;
  const cells: HTMLElement[] = [];
  const pending: { img: HTMLImageElement; path: string }[] = [];
  for (const grp of g.groups) {
    cells.push(h("div", { class: "idk-fam label", textContent: `${grp.family} (${grp.items.length})` }));
    for (const r of grp.items) {
      const short = r.path.slice(grp.family === "(root)" ? 0 : grp.family.length + 1);
      const img = h("img", { alt: "", draggable: false });
      img.setAttribute("alt", r.path);
      const th = h("div", { class: `idk-th${r.path === ctx.attach.pick ? " sel" : ""}`, draggable: true, title: `${r.path} (${r.width}x${r.height}). Click to pick, double-click or Attach image to attach, drag onto a slot row in the Tree`, role: "option" }, h("div", { class: "idk-im" }, img), h("small", { class: "name", textContent: `${short}  ${r.width}x${r.height}` }));
      th.dataset.path = r.path;
      cells.push(th);
      pending.push({ img, path: r.path });
    }
  }
  p.grid.replaceChildren(...cells);
  // Cut the thumbnails a slice per frame so a big atlas never blocks the editor.
  const mine = sig;
  let at = 0;
  const step = (): void => {
    if (thumbSig !== mine) return;
    const end = Math.min(pending.length, at + 24);
    for (; at < end; at++) {
      const url = thumbUrl(ctx, pending[at]!.path);
      if (url) pending[at]!.img.src = url;
    }
    if (at < pending.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------------------------
// Edits tab
// ---------------------------------------------------------------------------------------------

function renderEdits(ctx: DockCtx): void {
  const body = shell!.body;
  imagesParts = null;
  const edits = ctx.edits();
  const list = h("div", { class: "idk-list", id: "idk-edits" });
  edits.slice(-12).reverse().forEach((label, i) => list.append(h("div", { class: "idk-row" }, h("span", { class: "idk-tag", textContent: String(edits.length - i) }), h("span", { class: "name", textContent: label }))));
  if (!edits.length) list.append(h("div", { class: "note", textContent: "No Setup edits yet." }));
  const n = ctx.unsaved();
  const revert = h("button", { type: "button", id: "idk-revert", class: "btn", textContent: "Revert rig to saved", disabled: n === 0, title: n ? `Throw away the ${n} unsaved Setup edit${n === 1 ? "" : "s"} and go back to the rig file as saved (Redo brings them back)` : "Nothing to revert: the rig matches its saved file" });
  revert.dataset.action = "dock-revert";
  revert.addEventListener("click", () => ctx.revert());
  body.replaceChildren(list, h("div", { class: "idk-side" }, h("div", { class: "note", textContent: "Setup edits go through the command log, so Undo works here. Save writes them into the rig document." }), h("div", { class: "idk-btns" }, revert)));
}

// ---------------------------------------------------------------------------------------------
// Draw order tab
// ---------------------------------------------------------------------------------------------

function renderOrder(ctx: DockCtx): void {
  const body = shell!.body;
  imagesParts = null;
  const raw = ctx.raw();
  const front = raw ? [...drawOrderOf(raw)].reverse() : [];
  const list = h("div", { class: "idk-cols", id: "idk-order" });
  let dragging = "";
  front.forEach((name, i) => {
    const row = h("div", { class: "idk-row idk-slotrow", draggable: true, title: `${name}: drag to change its draw order (front is on top)` }, h("span", { class: "idk-tag", textContent: String(front.length - i) }), h("span", { class: "ol-icon", html: iconHtml("slot") }), h("span", { class: "name", textContent: name }));
    row.dataset.slot = name;
    row.addEventListener("dragstart", (e) => {
      dragging = name;
      e.dataTransfer?.setData("text/plain", name);
    });
    row.addEventListener("dragover", (e) => {
      if (!dragging || dragging === name) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY < r.top + r.height / 2;
      row.classList.toggle("drop-above", after);
      row.classList.toggle("drop-below", !after);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-above", "drop-below"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const side = e.clientY < r.top + r.height / 2 ? "after" : "before";
      const moved = dragging;
      dragging = "";
      row.classList.remove("drop-above", "drop-below");
      if (moved && moved !== name) void ctx.run(`Draw order: ${moved}`, (rw) => planDrawOrderTo(rw, moved, name, side));
    });
    row.addEventListener("dragend", () => (dragging = ""));
    list.append(row);
  });
  body.replaceChildren(list, h("div", { class: "idk-side" }, h("div", { class: "note", textContent: "Front is on top. Drag a row, or use Up, Down, To front and To back on the slot's Draw order section." })));
}
