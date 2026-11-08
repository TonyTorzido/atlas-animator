/*
 * Atlas Animator editor: the canvas view HUD.
 *
 * Batch 2: the floating icon row is gone. Its buttons now live in the stage context bar (#vtop: zoom, Fit, Bones, Helpers) and in the Overlays popover
 * (#ctx-pop, built statically in index.html): View (Game view, Facing right, Phone size, Pan, Frame selected), Onion skin (with its settings), Compare poses A / B,
 * Selection and snapping (Select all, Select branch, 15 degree snap, Snap to key). Every button has a visible text label there; the popover also
 * holds the Background swatches, Paths / Pins, the pose-rules pill, the Layers grid, Rulers, Zoom and the outline gate (filled by their own modules).
 * Most buttons drive the existing controls (the Preview tab's buttons) so there is one behaviour behind each; the state is mirrored back.
 * Also builds the header's command palette button and the Select all / Select branch buttons in the Bones list header.
 */
import { getHost, whenHost } from "./host.js";
import { iconEl, type IconName } from "./icons.js";
import { openPalette } from "./palette.js";
import { tipText } from "./tooltips.js";
import type { HotkeyAction } from "./hotkeys.js";
import { onPolyFlags, polyFlags, setPolyFlag, type PolyFlags } from "./polyOverlay.js";
import { onViewModes, setViewMode, viewModes, type ViewModes } from "./viewModes.js";

const $ = (id: string) => document.getElementById(id);

function mk(id: string, ic: IconName, label: string, tip: string, action?: HotkeyAction, keys?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "vh-btn";
  b.setAttribute("aria-label", label);
  b.title = tipText({ sel: "", tip, ...(action ? { action } : {}), ...(keys ? { keys } : {}) });
  const t = document.createElement("span");
  t.className = "vh-txt";
  t.textContent = label;
  b.append(iconEl(ic), t);
  return b;
}

/** Keeps `dst` showing the on / disabled state of `src` (the existing control that does the work). */
function mirror(src: HTMLElement | null, dst: HTMLButtonElement): void {
  if (!src) return;
  const sync = () => {
    const on = src.classList.contains("on");
    dst.classList.toggle("on", on);
    dst.setAttribute("aria-pressed", String(on));
    dst.disabled = (src as HTMLButtonElement).disabled === true;
  };
  new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ["class", "disabled", "aria-pressed"] });
  sync();
}

function proxy(id: string, srcId: string, ic: IconName, label: string, tip: string, action?: HotkeyAction, keys?: string): HTMLButtonElement {
  const b = mk(id, ic, label, tip, action, keys);
  b.addEventListener("click", () => $(srcId)?.click());
  mirror($(srcId), b);
  return b;
}

/** An inline block inside the Overlays popover, shown and hidden by its anchor button (the Onion and Compare settings). */
function disclosure(anchor: HTMLElement, id: string, label: string, onOpen: () => void): HTMLElement {
  const block = document.createElement("div");
  block.className = "vh-block";
  block.id = id;
  block.hidden = true;
  block.setAttribute("role", "group");
  block.setAttribute("aria-label", label);
  anchor.setAttribute("aria-expanded", "false");
  anchor.addEventListener("click", () => {
    if (!block.hidden) {
      block.hidden = true;
      anchor.setAttribute("aria-expanded", "false");
      return;
    }
    onOpen();
    block.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
  });
  return block;
}

/** The Overlays button opens the one popover of view options (a fixed card under the button, closed by Escape or a click elsewhere). */
function installOverlaysPopover(): void {
  const btn = $("ctx-overlays");
  const pop = $("ctx-pop");
  if (!btn || !pop) return;
  document.body.append(pop);
  const close = () => {
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("on");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pop.hidden) return close();
    pop.hidden = false;
    const a = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.min(a.bottom + 4, Math.max(8, window.innerHeight - pop.offsetHeight - 8))}px`;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("on");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !btn.contains(e.target as Node)) close();
  });
  // Capture phase: Esc closes the popover and stops there (it must not also clear the bone selection).
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || pop.hidden) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    },
    true
  );
}

const row = (label: string, ...kids: HTMLElement[]): HTMLElement => {
  const r = document.createElement("div");
  r.className = "vh-row";
  const l = document.createElement("span");
  l.className = "vh-lbl";
  l.textContent = label;
  r.append(l, ...kids);
  return r;
};

function seg(items: Array<[string, string]>, pick: (v: string) => void): { el: HTMLElement; set(v: string): void } {
  const el = document.createElement("span");
  el.className = "seg";
  el.setAttribute("role", "group");
  const bs = items.map(([v, text]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.dataset.v = v;
    b.addEventListener("click", () => pick(v));
    return b;
  });
  el.append(...bs);
  return { el, set: (v) => bs.forEach((b) => b.classList.toggle("on", b.dataset.v === v)) };
}

/** Proxies a number input to the Preview tab's own field (the editor reads that one on change). */
function num(srcId: string, label: string, min: number, max: number): { el: HTMLInputElement; pull(): void } {
  const el = document.createElement("input");
  el.type = "number";
  el.className = "in num";
  el.min = String(min);
  el.max = String(max);
  el.step = "1";
  el.setAttribute("aria-label", label);
  el.title = label;
  el.addEventListener("change", () => {
    const src = $(srcId) as HTMLInputElement | null;
    if (!src) return;
    src.value = el.value;
    src.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return { el, pull: () => void (el.value = ($(srcId) as HTMLInputElement | null)?.value ?? el.value) };
}

export function installViewHud(): void {
  const view = $("view");
  if (!view || $("vh-game")) return;
  installOverlaysPopover();

  // ---- Command palette button in the header ----
  const help = $("helpbtn");
  if (help && !$("palette-open")) {
    const p = document.createElement("button");
    p.type = "button";
    p.id = "palette-open";
    p.className = "btn";
    p.setAttribute("aria-label", "Search commands and assets");
    p.title = tipText({ sel: "", tip: "Search every action, clip, bone and skin", action: "palette" });
    const t = document.createElement("span");
    t.textContent = "Search";
    const k = document.createElement("span");
    k.className = "kbd";
    k.textContent = "Ctrl+K";
    p.append(iconEl("search"), t, k);
    p.addEventListener("click", () => void openPalette());
    help.before(p);
  }

  // ---- The buttons ----
  const game = proxy("vh-game", "gameviewbtn", "game", "Game view", "Show the clip the way the runtime draws it", "gameView");
  const facing = proxy("vh-facing", "facingbtn", "facing", "Facing right", "Preview facing right (look-only mirror)", "facingRight");
  const phone = mk("vh-phone", "phone", "Phone size", "Phone size: the character at the size a phone shows it", "phoneSize");
  phone.addEventListener("click", () => (window as { atlasPhone?: { toggle(): void } }).atlasPhone?.toggle());
  const onion = proxy("vh-onion", "onionbtn", "onion", "Onion skin", "Onion skin on / off: ghosts of the frames around this one", "onion");
  const onionSet = mk("vh-onion-set", "chevD", "Onion settings", "Onion skin settings: counts, keys or frames, tint or outline");
  const ab = mk("vh-ab", "compare", "Compare poses A / B", "Compare pose A and B: pin, ghost, swap", "pinPose");
  const pan = mk("vh-pan", "hand", "Pan", "Hand tool: a plain drag pans the canvas (Space + drag or the middle button does the same)");
  const frame = mk("vh-frame", "frame", "Frame selected", "Frame the selected bones (everything when none)", "frameSelection");
  const selAll = mk("vh-selall", "selAll", "Select all bones", "Select every bone", "selectAllBones");
  const branch = mk("vh-branch", "branch", "Select branch", "Select the active bone and every bone below it");
  const snap15 = mk("vh-snap15", "snapAngle", "15° snap", "Snap rotation drags to 15 degree steps (holding Shift does the same)");
  const snapKey = mk("vh-snapkey", "snapKey", "Snap to key", "Snap rotation drags to the previous key's angle or the mirror bone's (holding Ctrl does the same)");

  const toggles: Array<[HTMLButtonElement, keyof ViewModes]> = [[pan, "pan"], [snap15, "rot15"], [snapKey, "snapKey"]];
  for (const [b, k] of toggles) b.addEventListener("click", () => setViewMode(k, !viewModes[k]));
  const syncModes = () => {
    for (const [b, k] of toggles) {
      b.classList.toggle("on", viewModes[k]);
      b.setAttribute("aria-pressed", String(viewModes[k]));
    }
    document.body.classList.toggle("pan-tool", viewModes.pan);
  };
  onViewModes(syncModes);
  syncModes();

  frame.addEventListener("click", () => getHost()?.frameSelection());
  selAll.addEventListener("click", () => getHost()?.selectAllBones());
  branch.addEventListener("click", () => getHost()?.selectBranch());

  $("ov-view")?.append(game, facing, phone, pan, frame);
  $("ov-onion")?.append(onion, onionSet);
  $("ov-compare")?.append(ab);
  $("ov-select")?.append(selAll, branch, snap15, snapKey);

  // ---- Hit boxes and clip masks (Batch 12a): whether their polygons are tinted on the stage ----
  const polyToggles: Array<[HTMLButtonElement, keyof PolyFlags]> = [];
  for (const [id, key, text, tip] of [
    ["vh-boxes", "boxes", "Hit boxes", "Show the hit box polygons (green) on the stage; the selected one always shows"],
    ["vh-clips", "clips", "Clip masks", "Show the clip mask polygons (red) on the stage; the selected one always shows"],
    ["vh-paths", "paths", "Path curves", "Show the path curves (orange) that path constraints move bones along; the selected one always shows, with its points and handles"]
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "btn";
    b.textContent = text;
    b.title = tip;
    b.addEventListener("click", () => setPolyFlag(key, !polyFlags()[key]));
    polyToggles.push([b, key]);
  }
  const syncPolys = () => {
    for (const [b, k] of polyToggles) {
      b.classList.toggle("on", polyFlags()[k]);
      b.setAttribute("aria-pressed", String(polyFlags()[k]));
    }
    getHost()?.redraw();
  };
  onPolyFlags(syncPolys);
  $("ov-polys")?.append(...polyToggles.map(([b]) => b));
  for (const [b, k] of polyToggles) {
    b.classList.toggle("on", polyFlags()[k]);
    b.setAttribute("aria-pressed", String(polyFlags()[k]));
  }

  // ---- Onion settings (an inline block under the Onion button) ----
  const mode = seg([["frames", "Frames"], ["keys", "Keys"]], (v) => $("onionmode")?.querySelector<HTMLElement>(`[data-v="${v}"]`)?.click());
  const style = seg([["tint", "Tint"], ["outline", "Outline"]], (v) => $("onionstyle")?.querySelector<HTMLElement>(`[data-v="${v}"]`)?.click());
  const scope = seg([["all", "Whole character"], ["selected", "Selected bones"]], (v) => $("onionscope")?.querySelector<HTMLElement>(`[data-v="${v}"]`)?.click());
  const before = num("onionbefore", "Ghosts before the frame", 0, 6);
  const after = num("onionafter", "Ghosts after the frame", 0, 6);
  const every = num("onionstep", "Frames between ghosts", 1, 12);
  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "5";
  opacity.max = "100";
  opacity.setAttribute("aria-label", "Ghost opacity");
  opacity.title = "Ghost opacity";
  opacity.addEventListener("input", () => {
    const src = $("onionopacity") as HTMLInputElement | null;
    if (!src) return;
    src.value = opacity.value;
    src.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const pullOnion = () => {
    before.pull();
    after.pull();
    every.pull();
    opacity.value = ($("onionopacity") as HTMLInputElement | null)?.value ?? "42";
    const on = (id: string) => $(id)?.querySelector("button.on")?.getAttribute("data-v") ?? "";
    mode.set(on("onionmode"));
    style.set(on("onionstyle"));
    scope.set(on("onionscope"));
    every.el.disabled = on("onionmode") === "keys";
  };
  const onionPop = disclosure(onionSet, "vh-onion-pop", "Onion skin settings", pullOnion);
  $("ov-onion")?.append(onionPop);
  onionPop.append(row("Show", mode.el), row("Style", style.el), row("Ghosts of", scope.el), row("Before", before.el), row("After", after.el), row("Every", every.el), row("Opacity", opacity));
  onionPop.addEventListener("click", () => window.setTimeout(pullOnion, 0));

  // ---- Compare poses (an inline block under the Compare button) ----
  const infoEl = document.createElement("div");
  infoEl.className = "vh-info";
  const info = () => void (infoEl.textContent = $("abinfo")?.textContent ?? "");
  const abBtn = (id: string, srcId: string, label: string, tip: string, action: HotkeyAction): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.textContent = label;
    b.title = tipText({ sel: "", tip, action });
    b.addEventListener("click", () => {
      $(srcId)?.click();
      window.setTimeout(info, 0);
    });
    mirror($(srcId), b);
    return b;
  };
  const abPop = disclosure(ab, "vh-ab-pop", "Compare poses A and B", info);
  $("ov-compare")?.append(abPop);
  const abRow = document.createElement("div");
  abRow.className = "vh-btnrow";
  abRow.append(
    abBtn("vh-abpin", "abpin", "Pin A", "Pin the current pose as A to compare against", "pinPose"),
    abBtn("vh-abghost", "abghost", "Ghost", "Show pinned pose A as a ghost over the live pose", "ghostPose"),
    abBtn("vh-abswap", "abswap", "Swap A / B", "Show pinned pose A in place of the live pose; press again to come back", "swapPose"),
    abBtn("vh-abclear", "abclear", "Clear", "Clear pinned pose A", "unpinPose")
  );
  abPop.append(abRow, infoEl);

  // ---- Select buttons in the Bones list header ----
  const head = document.querySelector<HTMLElement>("#left .head");
  const filter = $("bonefilter");
  if (head && filter && !$("selallbones")) {
    const a = mk("selallbones", "selAll", "Select all", "Select every bone", "selectAllBones");
    const b = mk("selbranch", "branch", "Branch", "Select the active bone and every bone below it");
    a.classList.add("vh-mini");
    b.classList.add("vh-mini");
    a.addEventListener("click", () => getHost()?.selectAllBones());
    b.addEventListener("click", () => getHost()?.selectBranch());
    filter.before(a, b);
  }

  // The branch buttons need a bone with children.
  const syncBranch = () => {
    const h = getHost();
    const sel = h?.boneSelection().active ?? null;
    const has = !!sel && !!h?.doc?.bones.some((x) => x.parent === sel);
    for (const id of ["vh-branch", "selbranch", "ol-selbranch"]) {
      const el = $(id) as HTMLButtonElement | null;
      if (el) el.disabled = !has;
    }
  };
  whenHost((h) => {
    for (const ev of ["select", "rig", "clip"] as const) h.on(ev, syncBranch);
    syncBranch();
  });
  window.setInterval(syncBranch, 400);

}
