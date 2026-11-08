/*
 * Atlas Animator editor: original implementation.
 *
 * The one tool palette. A vertical rail on the stage's left edge, icon + label per tool, in two
 * groups like the Rig mockup: MODE (Select, Create, Image, Mesh, Weights) and TRANSFORM (Rotate, Translate, Scale, Shear, Length, Hand IK).
 * It replaces the three older tool bars: the view HUD's `Tool` segment (the Animate gizmo modes), the transform strip's TOOL group
 * (Pose / Shape keys / Weights / Create) and Setup's own tool row. It owns no behaviour: each button asks the editor for the same thing the
 * old button asked for, and shows the state the editor reports.
 *
 *   Setup mode:   the tool is Setup's tool (`atlasEditor.setupTool`); Scale and Shear edit the bone's setup scale / shear, Hand IK needs a clip so it is disabled there.
 *   Animate mode: Select is the posing canvas, Rotate / Translate / Scale / Shear / Hand IK are the gizmo modes (`atlasEditor.setGizmo`),
 *                 Mesh is Shape keys; Create, Image, Weights and Length edit the rig, so they open Setup (Pro) or are disabled (Animate).
 *
 * Hotkeys are unchanged (they live in hotkeys.ts / setupMode.ts); the tooltips quote them.
 */
import { getCanvasTool, SHAPE_KEYS_ID, type EditorHost } from "./host.js";
import { iconEl, type IconName } from "./icons.js";
import { tipText } from "./tooltips.js";

export type PaletteTool = "select" | "bone" | "attachment" | "mesh" | "weights" | "rotate" | "move" | "scale" | "shear" | "length" | "ik";
type GizmoName = "rotate" | "move" | "scale" | "shear" | "ik";

interface Def {
  id: PaletteTool;
  label: string;
  icon: IconName;
  group: "mode" | "transform";
  key: string;
  tip: string;
}

/** The palette, top to bottom. `key` is the hotkey the tooltip quotes ("" = none). */
export const PALETTE_TOOLS: readonly Def[] = [
  { id: "select", label: "Select", icon: "toolSelect", group: "mode", key: "V", tip: "Select: pick bones and drag their handles" },
  { id: "bone", label: "Create", icon: "toolCreate", group: "mode", key: "B", tip: "Create: drag in the view to draw a new bone (Setup mode)" },
  { id: "attachment", label: "Image", icon: "toolImage", group: "mode", key: "A", tip: "Image: move, rotate and scale the selected slot's image (Setup mode)" },
  { id: "mesh", label: "Mesh", icon: "toolMesh", group: "mode", key: "M", tip: "Mesh: edit the selected slot's mesh (Setup mode); Shape keys in Animate" },
  { id: "weights", label: "Weights", icon: "toolWeights", group: "mode", key: "W", tip: "Weights: paint which bones move each mesh vertex (Setup mode)" },
  { id: "rotate", label: "Rotate", icon: "toolRotate", group: "transform", key: "R", tip: "Rotate: drag to turn the selected bone about its origin" },
  { id: "move", label: "Translate", icon: "toolMove", group: "transform", key: "T", tip: "Translate: drag the selected bone along the Local / Parent / World axes" },
  { id: "scale", label: "Scale", icon: "toolScale", group: "transform", key: "S", tip: "Scale: drag the square handles to squash and stretch the selected bone (Animate)" },
  { id: "shear", label: "Shear", icon: "toolShear", group: "transform", key: "", tip: "Shear: drag the round handles to skew the selected bone (Animate)" },
  { id: "length", label: "Length", icon: "toolLength", group: "transform", key: "L", tip: "Length: drag the square at the bone's tip to change its length (Setup mode)" },
  { id: "ik", label: "Hand IK", icon: "toolIk", group: "transform", key: "H", tip: "Hand IK: drag a fist and the arm follows (Animate)" }
];

const GIZMOS: ReadonlySet<string> = new Set(["rotate", "move", "scale", "shear", "ik"]);

type Atlas = {
  setMode?: (m: "animate" | "setup") => unknown;
  setupTool?: (t: string) => unknown;
  setGizmo?: (m: string) => unknown;
  setupState?: () => { tool?: string };
};
const api = (): Atlas => (window as unknown as { atlasEditor?: Atlas }).atlasEditor ?? {};

/** Tells the palette the tool state changed (setupMode.ts renderHud and main.ts setGizmoMode call it). */
export function announceTools(detail: { gizmo?: string } = {}): void {
  window.dispatchEvent(new CustomEvent("atlas-tools", { detail }));
}

export function installToolPalette(host: EditorHost, view: HTMLElement = document.getElementById("view")!): HTMLElement {
  const rail = document.createElement("div");
  rail.id = "toolpalette";
  rail.setAttribute("role", "toolbar");
  rail.setAttribute("aria-label", "Tools");
  rail.setAttribute("aria-orientation", "vertical");
  rail.dataset.tools = "1";
  rail.dataset.cols = "1";

  const buttons = new Map<PaletteTool, HTMLButtonElement>();
  let gizmo: GizmoName = "rotate";
  for (const group of ["mode", "transform"] as const) {
    const head = document.createElement("div");
    head.className = "tp-head";
    head.textContent = group === "mode" ? "Mode" : "Transform";
    rail.append(head);
    for (const def of PALETTE_TOOLS.filter((d) => d.group === group)) {
      const b = document.createElement("button");
      b.type = "button";
      b.id = `tp-${def.id}`;
      b.className = "tp-btn";
      b.dataset.tool = def.id;
      b.dataset.tipped = "1";
      b.setAttribute("aria-pressed", "false");
      const label = document.createElement("span");
      label.className = "tp-label";
      label.textContent = def.label;
      b.append(iconEl(def.icon), label);
      b.addEventListener("click", () => void choose(def.id));
      buttons.set(def.id, b);
      rail.append(b);
    }
  }
  view.append(rail);

  const inSetup = () => host.compensate.setupMode;
  const inAnimateWs = () => document.body.classList.contains("ws-animate");

  async function choose(id: PaletteTool): Promise<void> {
    const a = api();
    if (inSetup()) {
      if (id === "select" || id === "bone" || id === "attachment" || id === "mesh" || id === "weights" || id === "rotate" || id === "move" || id === "scale" || id === "shear" || id === "length") a.setupTool?.(id);
      return;
    }
    // Animate mode.
    if (id === "select") {
      host.setCanvasTool(null);
      return;
    }
    if (id === "mesh") {
      // Shape keys deform mesh vertices on this frame (Animate); outside the Animate workspace, while Shape keys is only the stand-in, Mesh opens Setup's mesh tool.
      const real = getCanvasTool(SHAPE_KEYS_ID) && !getCanvasTool(SHAPE_KEYS_ID)!.placeholder;
      if (real || inAnimateWs()) {
        host.setCanvasTool(host.canvasTool === SHAPE_KEYS_ID ? null : SHAPE_KEYS_ID);
        return;
      }
      host.setCanvasTool(null);
      await a.setMode?.("setup");
      a.setupTool?.("mesh");
      return;
    }
    if (GIZMOS.has(id)) {
      if (host.canvasTool !== null) host.setCanvasTool(null);
      a.setGizmo?.(id);
      return;
    }
    // Create, Image, Weights: rig edits. They open Setup (Pro); the Animate workspace never edits the rig (the buttons are disabled there).
    if (id === "bone" || id === "attachment" || id === "weights") {
      host.setCanvasTool(null);
      await a.setMode?.("setup");
      a.setupTool?.(id);
    }
  }

  const refresh = (): void => {
    const setup = inSetup();
    const animateWs = inAnimateWs();
    const swag = document.body.classList.contains("ws-swag");
    const subTool = setup ? api().setupState?.().tool : undefined;
    for (const def of PALETTE_TOOLS) {
      const b = buttons.get(def.id)!;
      let on = false;
      let enabled = true;
      let tip = def.tip;
      if (setup) {
        on = subTool === def.id;
        if (def.id === "scale") tip = "Scale: drag the square handles to set the selected bone's setup scale (children and images follow); the handles lie along the Axes choice";
        else if (def.id === "shear") tip = "Shear: drag the round handles to set the selected bone's setup shear; the handles lie along the Axes choice";
        else if (def.id === "ik") {
          enabled = false;
          tip = `${def.label} works on a pose in Animate mode (Setup edits the rig's own numbers: use the bone fields)`;
        }
      } else {
        if (def.id === "select") on = host.canvasTool === null;
        else if (def.id === "mesh") on = host.canvasTool === SHAPE_KEYS_ID;
        else if (GIZMOS.has(def.id)) on = host.canvasTool === null && gizmo === def.id;
        if (def.id === "mesh") tip = animateWs || !!(getCanvasTool(SHAPE_KEYS_ID) && !getCanvasTool(SHAPE_KEYS_ID)!.placeholder) ? "Shape keys: deform mesh vertices on this frame (Animate)" : def.tip;
        if (def.id === "length") {
          enabled = false;
          tip = "Length is a Setup tool: switch to Setup mode (Pro) or the Rig workspace";
        }
        if (animateWs && (def.id === "bone" || def.id === "attachment" || def.id === "weights")) {
          enabled = false;
          tip = `${def.label} edits the rig: use the Rig or Pro workspace (the Animate workspace never edits the rig)`;
        }
      }
      if (def.id === "mesh") b.querySelector(".tp-label")!.textContent = !setup && (animateWs || (getCanvasTool(SHAPE_KEYS_ID) && !getCanvasTool(SHAPE_KEYS_ID)!.placeholder)) ? "Shape keys" : "Mesh";
      const key = def.id === "mesh" && !setup && animateWs ? "D" : def.key;
      b.title = tipText({ sel: "", tip, ...(key ? { keys: key } : {}) });
      b.setAttribute("aria-label", `${b.querySelector(".tp-label")!.textContent}${key ? ` (${key})` : ""}`);
      b.disabled = !enabled;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    fit();
  };

  // Two columns when one would be taller than the stage leaves it (a short window): never a scrollbar, never a hidden tool.
  const fit = (): void => {
    if (rail.offsetParent === null) return;
    rail.dataset.cols = "1";
    const top = rail.getBoundingClientRect().top - view.getBoundingClientRect().top;
    const room = view.clientHeight - top - 56;
    if (rail.offsetHeight > room) rail.dataset.cols = "2";
    // Things drawn beside the palette (the Setup hint, the empty-state card) start to its right.
    view.style.setProperty("--tp-w", `${rail.offsetWidth + 16}px`);
  };

  for (const ev of ["pose", "clip", "rig", "tool"] as const) host.on(ev, refresh);
  window.addEventListener("atlas-tools", (e) => {
    const g = (e as CustomEvent<{ gizmo?: string }>).detail?.gizmo;
    if (g && GIZMOS.has(g)) gizmo = g as GizmoName;
    refresh();
  });
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(fit).observe(view);
  refresh();
  return rail;
}
