/*
 * Atlas Animator editor: original implementation.
 *
 * The transform strip docked at the bottom of the canvas (Animate and Pro): a row per channel (Rotate, Translate x y, Scale x y, Shear x y)
 * with editable fields and a key button. Batch 2 moved everything else out: the tools are the one palette (toolPalette.ts), the axis space
 * (Local / Parent / World) and Keep in place (children / images) sit in the stage context bar (#vtop, in Animate, Rig and Pro), and the
 * Bones / Images / Others selectable + visible grid is the Layers section of the Overlays popover. The channel rows are ONE implementation (`createXformControls`) that the
 * Pose panel uses too, so the two always agree: same fields, same axis space, same wheel and drag-scrub, same key buttons.
 * Everything reaches the editor through the EditorHost (host.xform / host.view / host.compensate); the math is transformModel.ts.
 */
import { unkeyedStripText } from "./feedbackModel.js";
import { getSpace, installOverflow, LAYERS, layerFlag, onLayers, onSpace, setLayerFlag, setSpace, type Layer, type LayerKey } from "./canvasTools.js";
import type { EditorHost } from "./host.js";
import {
  CHANNELS,
  formatField,
  keyState,
  rotateFromSpace,
  rotateToSpace,
  scrubValue,
  SPACES,
  translateFromSpace,
  translateToSpace,
  wheelValue,
  type Channel,
  type Space
} from "./transformModel.js";

/** Ids of the controls the strip builds once (each has an entry in tooltips.ts). The channel fields and key buttons are classes (the Pose panel has them too). */
export const XFORM_IDS = [
  "xs-space-local",
  "xs-space-parent",
  "xs-space-world",
  "xs-comp-bones",
  "xs-comp-images",
  "xs-grid-bones-selectable",
  "xs-grid-bones-visible",
  "xs-grid-images-selectable",
  "xs-grid-images-visible",
  "xs-grid-others-selectable",
  "xs-grid-others-visible"
] as const;

const LABEL: Record<Channel, string> = { rotate: "Rotate", translate: "Translate", scale: "Scale", shear: "Shear" };
const PREFIX: Record<Channel, string[]> = { rotate: ["∠"], translate: ["X", "Y"], scale: ["X", "Y"], shear: ["X", "Y"] };

const SVGNS = "http://www.w3.org/2000/svg";
function svg(path: string, fill = false): SVGElement {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", fill ? "currentColor" : "none");
  if (!fill) {
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2.2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  }
  s.append(p);
  return s;
}

const num = (v: string): number => (v.trim() === "" ? NaN : Number(v));

export interface XformRow {
  label: HTMLElement;
  ctrl: HTMLElement;
}

export interface XformControls {
  rows: Record<Channel, XformRow>;
  /** Re-reads the active bone and fills the fields and key buttons. */
  refresh(): void;
}

/** The four channel rows. One instance is the strip's; the Pose panel builds its own each time it redraws. */
export function createXformControls(host: EditorHost): XformControls {
  const rows = {} as Record<Channel, XformRow>;
  const inputs: Record<Channel, HTMLInputElement[]> = { rotate: [], translate: [], scale: [], shear: [] };
  const keys = {} as Record<Channel, HTMLButtonElement>;

  const boneOf = () => {
    const r = host.xform.read();
    const bone = r ? host.skeleton?.findBone(r.bone) : undefined;
    return r && bone ? { r, bone } : null;
  };

  /** Typed numbers (in the axis space) as the stored values. */
  const stored = (ch: Channel): { x: number; y: number } | null => {
    const got = boneOf();
    if (!got) return null;
    const vals = inputs[ch].map((i) => num(i.value));
    if (vals.some((v) => !Number.isFinite(v))) return null;
    const space = getSpace();
    if (ch === "rotate") return { x: rotateFromSpace(got.bone, space, vals[0]!, got.r.values.rotate), y: 0 };
    if (ch === "translate") return translateFromSpace(got.bone, space, { x: vals[0]!, y: vals[1]! });
    return { x: vals[0]!, y: vals[1]! };
  };

  const apply = (ch: Channel, live: boolean) => {
    const v = stored(ch);
    if (v) host.xform.set(ch, v.x, v.y, live);
  };

  for (const ch of CHANNELS) {
    const ctrl = document.createElement("span");
    ctrl.className = "xf-ctrl";
    ctrl.dataset.ch = ch;
    PREFIX[ch].forEach((prefix, axis) => {
      const wrap = document.createElement("span");
      wrap.className = "xf-field";
      const grip = document.createElement("span");
      grip.className = "xf-grip";
      grip.textContent = prefix;
      grip.dataset.ch = ch;
      grip.title = "Drag left or right to change the value (Shift fine, Ctrl coarse)";
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "xf-in";
      input.dataset.ch = ch;
      input.dataset.axis = axis ? "y" : "x";
      input.setAttribute("aria-label", `${LABEL[ch]}${PREFIX[ch].length > 1 ? " " + prefix.toLowerCase() : ""}`);
      inputs[ch].push(input);
      input.addEventListener("change", () => apply(ch, false));
      // Wheel over a field nudges it (Shift fine, Ctrl coarse); a pause ends the edit and auto key runs once.
      let wheelTimer = 0;
      input.addEventListener(
        "wheel",
        (e) => {
          if (input.disabled) return;
          e.preventDefault();
          const next = wheelValue(ch, num(input.value) || 0, e.deltaY, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
          input.value = formatField(ch, next);
          apply(ch, true);
          window.clearTimeout(wheelTimer);
          wheelTimer = window.setTimeout(() => host.xform.finish(ch), 350);
        },
        { passive: false }
      );
      // Dragging the little label scrubs the value (Spine style); Shift is fine, Ctrl coarse.
      grip.addEventListener("pointerdown", (e) => {
        if (input.disabled || e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const start = num(input.value) || 0;
        const move = (m: PointerEvent) => {
          input.value = formatField(ch, scrubValue(ch, start, m.clientX - x0, { shift: m.shiftKey, ctrl: m.ctrlKey || m.metaKey, alt: m.altKey }));
          apply(ch, true);
        };
        const up = () => {
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          grip.removeEventListener("pointercancel", up);
          host.xform.finish(ch);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
      });
      wrap.append(grip, input);
      ctrl.append(wrap);
    });
    if (PREFIX[ch].length === 1) {
      const gap = document.createElement("span");
      gap.className = "xf-field xf-blank";
      ctrl.append(gap);
    }
    const key = document.createElement("button");
    key.type = "button";
    key.className = "xf-key";
    key.title = `Key ${LABEL[ch].toLowerCase()} at this frame. Shift-click keys every channel`;
    key.dataset.ch = ch;
    key.dataset.state = "none";
    key.dataset.tipped = "1";
    key.setAttribute("aria-label", `Key ${LABEL[ch].toLowerCase()}`);
    key.append(svg("M12 3l8 9-8 9-8-9z", true));
    key.addEventListener("click", (e) => (e.shiftKey ? host.xform.keyAll() : host.xform.key(ch)));
    keys[ch] = key;
    ctrl.append(key);
    const label = document.createElement("span");
    label.className = "xf-label label";
    label.textContent = LABEL[ch];
    rows[ch] = { label, ctrl };
  }

  const refresh = () => {
    const got = boneOf();
    const space = getSpace();
    for (const ch of CHANNELS) {
      const off = !got;
      for (const i of inputs[ch]) i.disabled = off;
      keys[ch].disabled = off;
      const g = rows[ch].ctrl.querySelectorAll<HTMLElement>(".xf-grip");
      for (const e of g) e.classList.toggle("off", off);
      if (!got) {
        for (const i of inputs[ch]) if (document.activeElement !== i) i.value = "";
        keys[ch].dataset.state = "none";
        continue;
      }
      const v = got.r.values;
      const shown =
        ch === "rotate" ? [rotateToSpace(got.bone, space, v.rotate)] : ch === "translate" ? Object.values(translateToSpace(got.bone, space, v.translate)) : ch === "scale" ? [v.scale.x, v.scale.y] : [v.shear.x, v.shear.y];
      inputs[ch].forEach((i, n) => {
        if (document.activeElement !== i) i.value = formatField(ch, shown[n]!);
      });
      const state = keyState(got.r.keyed[ch], got.r.unkeyed[ch]);
      keys[ch].dataset.state = state;
      keys[ch].title = state === "keyed" ? `${LABEL[ch]} is keyed at this frame. Click to key it again, Shift-click to key every channel` : state === "changed" ? `${LABEL[ch]} changed and not keyed. Click to key it, Shift-click to key every channel` : `Key ${LABEL[ch].toLowerCase()} at this frame. Shift-click keys every channel`;
    }
  };
  refresh();
  return { rows, refresh };
}

/** The Pose panel's transform rows as [label, control] pairs for its key-value grid; built from the same controls as the strip. */
export function poseRows(host: EditorHost): HTMLElement[] {
  const c = createXformControls(host);
  return CHANNELS.flatMap((ch) => [c.rows[ch].label, c.rows[ch].ctrl]);
}

// ---------------------------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------------------------

function btn(id: string, text: string, ic?: SVGElement): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "xs-btn";
  if (ic) b.append(ic);
  if (text) b.append(Object.assign(document.createElement("span"), { textContent: text }));
  return b;
}

const LAYER_NAME: Record<Layer, string> = { bones: "Bones", images: "Images", others: "Others" };
const ARROW = "M5 3l14 8-6 2-3 6z";
const EYE = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z";

export function installTransformStrip(host: EditorHost, view: HTMLElement = document.getElementById("view")!): HTMLElement {
  const strip = document.createElement("div");
  strip.id = "xstrip";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "Transform values");

  // Transform rows
  // One horizontal row: Rotate, Translate, Scale, Shear, each with its fields and key button (the only copy in Animate and Pro).
  const xform = document.createElement("div");
  xform.className = "xs-xform";
  const controls = createXformControls(host);
  for (const ch of CHANNELS) {
    const row = document.createElement("div");
    row.className = "xs-row";
    row.dataset.ch = ch;
    row.append(controls.rows[ch].label, controls.rows[ch].ctrl);
    xform.append(row);
  }

  // Unkeyed edits on the active bone: a plain pill with a one-click Key it (Esc drops them).
  const unkeyed = document.createElement("div");
  unkeyed.className = "xs-unkeyed";
  unkeyed.hidden = true;
  const unkeyedText = document.createElement("span");
  const keyIt = document.createElement("button");
  keyIt.type = "button";
  keyIt.id = "xs-keyit";
  keyIt.className = "xs-btn xs-keyit";
  keyIt.textContent = "Key changes";
  keyIt.addEventListener("click", () => {
    const n = host.keyUnkeyed();
    if (!n) host.status("Nothing unkeyed to key", "bad");
  });
  // : the visible, explicit way to throw unkeyed edits away (scrub / play / switch keep them parked on their frame).
  const discard = document.createElement("button");
  discard.type = "button";
  discard.id = "xs-discard";
  discard.className = "xs-btn xs-discard";
  discard.textContent = "Discard";
  discard.title = "Discard unkeyed: throw away the unkeyed changes at this frame (the bones go back to the clip's pose). Esc does the same";
  discard.addEventListener("click", () => host.discardUnkeyed());
  unkeyed.append(unkeyedText, keyIt, discard);
  xform.append(unkeyed);

  // Axes and Keep in place: built here (they share the state with the numeric fields) and mounted in the stage context bar.
  const axes = document.getElementById("ctx-axes")!;
  axes.append(Object.assign(document.createElement("span"), { className: "ctx-cap", textContent: "Axes" }));
  const seg = document.createElement("div");
  seg.className = "seg xs-seg";
  const spaceBtns = new Map<Space, HTMLButtonElement>();
  for (const sp of SPACES) {
    const b = btn(`xs-space-${sp}`, sp[0]!.toUpperCase() + sp.slice(1));
    b.addEventListener("click", () => setSpace(sp));
    spaceBtns.set(sp, b);
    seg.append(b);
  }
  axes.append(seg);
  const comp = document.getElementById("ctx-keep")!;
  comp.append(Object.assign(document.createElement("span"), { className: "ctx-cap", textContent: "Keep" }));
  const cseg = document.createElement("div");
  cseg.className = "seg xs-seg";
  const compBones = btn("xs-comp-bones", "Children");
  const compImages = btn("xs-comp-images", "Images");
  compBones.dataset.tipped = compImages.dataset.tipped = "1";
  compBones.addEventListener("click", () => host.compensate.setBones(!host.compensate.bones));
  compImages.addEventListener("click", () => host.compensate.setImages(!host.compensate.images));
  cseg.append(compBones, compImages);
  comp.append(cseg);

  // Selectable / visible grid
  const grid = document.getElementById("ov-layers")!;
  const table = document.createElement("div");
  table.className = "xs-table";
  // Column headers (an arrow = selectable, an eye = visible), then one row per layer with its name.
  const head = document.createElement("div");
  head.className = "xs-grow xs-ghead";
  for (const [ic, label] of [[ARROW, "Selectable"], [EYE, "Visible"]] as const) {
    const h = document.createElement("span");
    h.className = "xs-hcell";
    h.title = label;
    h.append(svg(ic));
    head.append(h);
  }
  head.append(Object.assign(document.createElement("span"), { className: "xs-gname", textContent: "Layer" }));
  table.append(head);
  const toggles = new Map<string, HTMLButtonElement>();
  for (const layer of LAYERS) {
    const row = document.createElement("div");
    row.className = "xs-grow";
    for (const key of ["selectable", "visible"] as LayerKey[]) {
      const b = btn(`xs-grid-${layer}-${key}`, "", svg(key === "selectable" ? ARROW : EYE));
      b.classList.add("xs-tog");
      b.setAttribute("aria-label", `${LAYER_NAME[layer]} ${key}`);
      b.addEventListener("click", () => {
        if (key === "visible") {
          const next = !host.view.layerVisible(layer);
          if (layer === "images") setLayerFlag("images", "visible", next);
          host.view.setLayerVisible(layer, next);
        } else setLayerFlag(layer, "selectable", !layerFlag(layer, "selectable"));
        refresh();
      });
      toggles.set(`${layer}.${key}`, b);
      row.append(b);
    }
    const name = document.createElement("span");
    name.className = "xs-gname";
    name.textContent = LAYER_NAME[layer];
    row.append(name);
    table.append(row);
  }
  grid.append(table);

  // One row of transform fields. The bone breadcrumb and the one-line tip sit on the strip's top edge (#vtip, in index.html), which follows the strip's height through --xs-h.
  strip.append(xform);
  view.append(strip);
  // One row only: when the fields do not fit, they give way (Shear, Scale, Translate) into a "..." popover above the strip.
  const rowOf = (ch: Channel) => () => xform.querySelector<HTMLElement>(`.xs-row[data-ch="${ch}"]`);
  installOverflow(strip, [rowOf("shear"), rowOf("scale"), rowOf("translate"), rowOf("rotate")], true);

  const syncHeights = () => {
    view.style.setProperty("--xs-h", `${strip.offsetParent === null ? 0 : strip.offsetHeight}px`);
    const top = document.getElementById("vtop");
    view.style.setProperty("--vt-h", `${top ? top.offsetHeight : 0}px`);
  };
  const heights = new ResizeObserver(syncHeights);
  heights.observe(strip);
  heights.observe(view);
  const topBar = document.getElementById("vtop");
  if (topBar) heights.observe(topBar);

  const refresh = () => {
    controls.refresh();
    const un = host.unkeyed;
    unkeyed.hidden = un.length === 0 || host.compensate.setupMode;
    if (!unkeyed.hidden) {
      unkeyedText.textContent = unkeyedStripText(un.length);
    }
    const setup = host.compensate.setupMode;
    for (const [sp, b] of spaceBtns) b.classList.toggle("on", sp === getSpace());
    compBones.classList.toggle("on", host.compensate.bones);
    document.getElementById("ctx-axes")?.setAttribute("data-space", getSpace());
    compImages.classList.toggle("on", setup && host.compensate.images);
    compImages.disabled = !setup;
    compImages.classList.toggle("off", !setup);
    compImages.title = setup ? "Images stay put: moving or rotating a bone keeps the images on its slots where they are" : "Images stay put works in Setup mode only (it edits the rig, not a clip). Disabled in Animate";
    compBones.title = setup ? "Bones stay put: moving or rotating a bone keeps its child bones where they are" : "Bones stay put: while you move or rotate a bone, its children keep their place on screen (keyed on them too)";
    strip.classList.toggle("setup", setup);
    for (const layer of LAYERS) {
      toggles.get(`${layer}.selectable`)!.classList.toggle("on", layerFlag(layer, "selectable"));
      toggles.get(`${layer}.visible`)!.classList.toggle("on", host.view.layerVisible(layer));
    }
    syncHeights();
  };

  const applyImages = () => {
    if (!layerFlag("images", "visible")) host.view.setLayerVisible("images", false);
  };
  for (const ev of ["pose", "clip", "time", "rig", "tool"] as const) host.on(ev, refresh);
  host.on("rig", applyImages);
  onSpace(refresh);
  onLayers(refresh);
  // Workspace, mode and the top-bar buttons (Bones, Helpers, Compensate) change state this module does not own: look again after them.
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("click", () => queueMicrotask(refresh));
  refresh();
  return strip;
}
