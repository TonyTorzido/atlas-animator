/*
 * Atlas Animator editor: original implementation.
 *
 * The Transitions panel: a clip state graph for the open rig. Clips are nodes, a transition has a blend time and an
 * optional condition label. "Show on stage" plays the graph on the stage in place of the edited clip (the same slot the layered Tracks
 * preview uses; the clip is never changed): press a trigger to take a transition (the engine crossfades), click an arrow's target node, or
 * turn on Auto-cycle to walk the path. The graph is saved per rig in transitions.json in the data folder (/api/transitions). The model is
 * transitionsModel.ts.
 */
import type { AnimDocument, ClipData, Skeleton } from "@atlas-animator/core/core";
import { CLIP_MAP } from "../../animator/src/clipMap.js";
import {
  addNode,
  DEFAULT_BLEND,
  defaultPath,
  edgesFrom,
  emptyGraph,
  GraphSession,
  parseGraph,
  pathEdges,
  prefillGraph,
  removeEdge,
  removeNode,
  setEdge,
  type GraphStatus,
  type TransitionGraph
} from "./transitionsModel.js";
import "./transitionsPanel.css";

export interface TransitionsHost {
  panel: HTMLElement;
  doc(): AnimDocument | null;
  /** Every editable clip by name, including the edited one as it is now. */
  clips(): Record<string, ClipData>;
  /** The open rig's id (the key the graph is stored under), or "" with no rig. */
  rigId(): string;
  /** The clip being edited (the entry of a new graph when it is a node). */
  editedClip(): string;
  /** The preview changed: pose and render again. */
  changed(): void;
  /** Called just before the preview turns on, so the other stage preview can close. */
  beforeActivate(): void;
  status(text: string, kind?: "ok" | "bad"): void;
}

export interface TransitionsInfo {
  active: boolean;
  playing: boolean;
  rig: string;
  saved: "saved" | "unsaved" | "draft" | "error" | "none";
  graph: TransitionGraph;
  status: GraphStatus | null;
  cycling: boolean;
  missingHops: string[];
}

export interface TransitionsPreview {
  active(): boolean;
  setActive(on: boolean): void;
  tick(dt: number): void;
  apply(skeleton: Skeleton): void;
  invalidate(): void;
  play(on: boolean): void;
  start(clip?: string): void;
  fire(to: string): string | null;
  setCycle(on: boolean): void;
  addNode(clip: string): void;
  removeNode(clip: string): void;
  addEdge(from: string, to: string, blend: number, condition: string): string | null;
  removeEdge(id: string): void;
  prefill(): void;
  setPath(path: string[]): void;
  /** Writes the graph to transitions.json now (edits also save by themselves). */
  save(): Promise<boolean>;
  info(): TransitionsInfo;
}

const SVGNS = "http://www.w3.org/2000/svg";

export function createTransitionsPreview(host: TransitionsHost): TransitionsPreview {
  let on = false;
  let playing = true;
  let graph: TransitionGraph = emptyGraph();
  let graphRig = "";
  let saveState: TransitionsInfo["saved"] = "none";
  let session: GraphSession | null = null;
  let sessionDoc: AnimDocument | null = null;
  let stale = true;
  let selNode = "";
  let note = "";
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let loadSeq = 0;
  let lastStatusKey = "";

  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const clipNames = (): string[] => Object.keys(host.clips());

  // --- storage --------------------------------------------------------------------------------

  async function loadFor(rig: string): Promise<void> {
    const seq = ++loadSeq;
    graphRig = rig;
    session = null;
    stale = true;
    if (!rig) {
      graph = emptyGraph();
      saveState = "none";
      render();
      return;
    }
    let stored: TransitionGraph | null = null;
    try {
      const res = await fetch(`/api/transitions?rig=${encodeURIComponent(rig)}`);
      if (res.ok) {
        const body = (await res.json()) as { graph: unknown };
        if (body.graph) stored = parseGraph(body.graph);
      }
    } catch {
      // the server being away leaves a draft graph; Save reports the failure
    }
    if (seq !== loadSeq) return;
    if (stored && stored.nodes.length) {
      graph = stored;
      saveState = "saved";
    } else {
      graph = prefillGraph(CLIP_MAP, host.clips());
      saveState = graph.nodes.length ? "draft" : "none";
    }
    selNode = graph.entry;
    render();
    if (on) startSession();
    host.changed();
  }

  async function save(): Promise<boolean> {
    if (!graphRig) return false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      const res = await fetch("/api/transitions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rig: graphRig, graph }) });
      saveState = res.ok ? "saved" : "error";
      if (!res.ok) host.status(`Could not save the transitions: ${((await res.json()) as { error?: string }).error ?? res.status}`, "bad");
    } catch (e) {
      saveState = "error";
      host.status(`Could not save the transitions: ${e instanceof Error ? e.message : String(e)}`, "bad");
    }
    render();
    return saveState === "saved";
  }

  function edited(): void {
    saveState = "unsaved";
    stale = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 400);
    render();
    host.changed();
  }

  // --- session --------------------------------------------------------------------------------

  function ensureSession(): GraphSession | null {
    const doc = host.doc();
    if (!doc) return null;
    if (!session || sessionDoc !== doc) {
      session = new GraphSession(doc, host.clips(), graph);
      sessionDoc = doc;
      stale = false;
      const first = graph.nodes.includes(host.editedClip()) && !graph.entry ? host.editedClip() : graph.entry;
      if (first) session.start(first);
    } else if (stale) {
      session.setGraph(host.clips(), graph);
      stale = false;
    }
    return session;
  }

  function startSession(clip?: string): void {
    session = null;
    const s = ensureSession();
    if (s && clip) s.start(clip);
  }

  // --- DOM ------------------------------------------------------------------------------------

  const h2 = node("h2");
  h2.append("Clip transitions", Object.assign(node("span", "spacer"), { style: "flex:1" }));
  const toggle = node("button", "", "Off");
  toggle.id = "transtoggle";
  toggle.type = "button";
  toggle.title = "Show the transition graph on the stage in place of the edited clip: press a trigger to blend from one clip to the next. The edited clip is not changed";
  toggle.setAttribute("aria-label", "Show the transition graph on the stage");
  toggle.onclick = () => api.setActive(!on);
  h2.append(toggle);

  const intro = node("div", "note", "A preview of how the clips blend into each other. Add a transition between two clips, press Play, then use the triggers. It is saved with the rig in the data folder; the project does not read it yet.");
  const body = node("div", "transbody");
  const saveLine = node("div", "note");
  saveLine.id = "transsave";
  saveLine.setAttribute("role", "status");
  host.panel.append(h2, intro, body, saveLine);

  const select = (opts: [string, string][], value: string, title: string, id: string, onChange: (v: string) => void): HTMLSelectElement => {
    const s = node("select");
    s.id = id;
    s.title = title;
    s.setAttribute("aria-label", title);
    for (const [v, label] of opts) {
      const o = node("option", "", label);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
  };
  const button = (text: string, id: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = node("button", "", text);
    b.id = id;
    b.type = "button";
    b.title = title;
    b.onclick = onClick;
    return b;
  };
  const row = (label: string, ...kids: HTMLElement[]): HTMLElement => {
    const r = node("div", "row");
    r.append(node("span", "label", label), ...kids);
    return r;
  };

  // ---- graph drawing
  const W = 300;
  const H = 250;
  function layout(): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    const n = graph.nodes.length;
    graph.nodes.forEach((name, i) => {
      if (n === 1) out.set(name, [W / 2, H / 2]);
      else {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        out.set(name, [W / 2 + Math.cos(a) * (W / 2 - 62), H / 2 + Math.sin(a) * (H / 2 - 34)]);
      }
    });
    return out;
  }

  function drawGraph(): SVGSVGElement {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "transgraph");
    svg.setAttribute("id", "transgraph");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Transition graph: clips as boxes, transitions as arrows");
    const defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML = '<marker id="transarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="transhead"/></marker>';
    svg.append(defs);
    const pos = layout();
    const st = session?.status() ?? null;
    const cur = on ? (st?.current ?? "") : "";
    const mk = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text !== undefined) e.textContent = text;
      return e;
    };
    for (const e of graph.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const off = 14;
      const cx = (a[0] + b[0]) / 2 + nx * off * 1.6;
      const cy = (a[1] + b[1]) / 2 + ny * off * 1.6;
      const trim = (p: [number, number], q: [number, number]): [number, number] => {
        const ux = q[0] - p[0];
        const uy = q[1] - p[1];
        const l = Math.hypot(ux, uy) || 1;
        const tx = Math.abs(ux / l) > 0 ? 50 / Math.abs(ux / l) : 1e9;
        const ty = Math.abs(uy / l) > 0 ? 11 / Math.abs(uy / l) : 1e9;
        const t = Math.min(tx, ty, l / 2 - 2);
        return [p[0] + (ux / l) * t, p[1] + (uy / l) * t];
      };
      const p0 = trim(a, [cx, cy]);
      const p1 = trim(b, [cx, cy]);
      const hot = !!st && st.last === `${e.from} > ${e.to}` && st.mix !== null;
      const g = mk("g", { class: `transedge${hot ? " hot" : ""}`, "data-edge": e.id });
      g.append(mk("path", { d: `M${p0[0]},${p0[1]} Q${cx},${cy} ${p1[0]},${p1[1]}`, "marker-end": "url(#transarrow)" }));
      const label = mk("text", { x: (cx + (p0[0] + p1[0]) / 2) / 2, y: (cy + (p0[1] + p1[1]) / 2) / 2 + 3, "text-anchor": "middle" }, e.condition ? e.condition : `${e.blend}s`);
      g.append(label);
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = `${e.from} to ${e.to}: blends over ${e.blend} s${e.condition ? `, when ${e.condition}` : ""}`;
      g.append(tip);
      svg.append(g);
    }
    for (const name of graph.nodes) {
      const p = pos.get(name)!;
      const missing = !host.clips()[name];
      const cls = ["transnode", name === cur ? "cur" : "", st?.from === name && st.mix !== null ? "from" : "", name === selNode ? "sel" : "", name === graph.entry ? "entry" : "", missing ? "missing" : ""].filter(Boolean).join(" ");
      const g = mk("g", { class: cls, "data-node": name, tabindex: 0, role: "button", "aria-label": `Clip ${name}${missing ? " (not in this rig)" : ""}` });
      g.append(mk("rect", { x: p[0] - 50, y: p[1] - 11, width: 100, height: 22, rx: 6 }));
      g.append(mk("text", { x: p[0], y: p[1] + 3.5, "text-anchor": "middle" }, name.length > 17 ? `${name.slice(0, 16)}...` : name));
      const tip = document.createElementNS(SVGNS, "title");
      tip.textContent = `${name}${name === graph.entry ? " (start)" : ""}${missing ? ": not in this rig's clips" : ""}. Click to select it${on ? "; click a clip with an arrow from the playing one to take that transition" : ""}`;
      g.append(tip);
      const act = (): void => {
        const s = on ? ensureSession() : null;
        if (s && s.node && s.node !== name && graph.edges.some((e) => e.from === s.node && e.to === name)) api.fire(name);
        else {
          selNode = name;
          render();
        }
      };
      g.addEventListener("click", act);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          act();
        }
      });
      svg.append(g);
    }
    return svg;
  }

  // ---- panel
  function render(): void {
    const st = on ? (ensureSession()?.status() ?? null) : null;
    lastStatusKey = statusKey(st);
    toggle.textContent = on ? "On" : "Off";
    toggle.classList.toggle("on", on);
    body.replaceChildren();
    if (!host.doc()) {
      body.append(node("div", "note", "Open a rig first."));
      saveLine.textContent = "";
      return;
    }
    const names = clipNames();
    const all: [string, string][] = names.map((n) => [n, n]);
    const inGraph: [string, string][] = graph.nodes.map((n) => [n, n]);

    // nodes
    const addable: [string, string][] = [["", "Choose a clip..."], ...names.filter((n) => !graph.nodes.includes(n)).map((n): [string, string] => [n, n])];
    const nodePick = select(addable, "", "Clip to add to the graph", "transnodepick", () => {});
    const addNodeBtn = button("Add clip", "transnodeadd", "Add the chosen clip to the graph as a node", () => nodePick.value && api.addNode(nodePick.value));
    const rmNodeBtn = button("Remove clip", "transnoderemove", "Take the selected node (and its transitions) out of the graph. The clip itself is not touched", () => selNode && api.removeNode(selNode));
    rmNodeBtn.disabled = !selNode || !graph.nodes.includes(selNode);
    const prefillBtn = button("Pre-fill from project clips", "transprefill", "Replace the graph with a starting one built from the project's clip map: the mapped clips this rig has, idle to each, and back", () => api.prefill());
    body.append(row("Clips", nodePick, addNodeBtn, rmNodeBtn, prefillBtn));
    body.append(drawGraph());

    // playback
    const entryPick = select([["", "(none)"], ...inGraph], graph.entry, "The clip the preview starts on", "transentry", (v) => {
      graph = { ...graph, entry: v };
      edited();
    });
    const playBtn = button(playing ? "Pause" : "Play", "transplay", "Play or pause the graph on the stage", () => api.play(!playing));
    playBtn.classList.toggle("on", playing);
    const startBtn = button("Start over", "transstart", "Go back to the start clip with no blend", () => api.start());
    body.append(row("Start", entryPick, startBtn, playBtn));

    const cycle = node("input");
    cycle.type = "checkbox";
    cycle.id = "transcycle";
    cycle.checked = !!session?.isCycling;
    cycle.setAttribute("aria-label", "Auto-cycle the path");
    cycle.onchange = () => api.setCycle(cycle.checked);
    const cycleLabel = node("label", "", "");
    cycleLabel.title = "Walk the path by itself: each clip plays for a moment, then the next transition fires";
    cycleLabel.append(cycle, " Auto-cycle");
    const pathIn = node("input");
    pathIn.id = "transpath";
    pathIn.value = graph.path.join(", ");
    pathIn.placeholder = "idle, walk, attack";
    pathIn.title = "The auto-cycle path: clip names in order, separated by commas. The last clip hands back to the first";
    pathIn.setAttribute("aria-label", "Auto-cycle path");
    pathIn.onchange = () => api.setPath(pathIn.value.split(",").map((s) => s.trim()).filter(Boolean));
    const defPath = button("Default path", "transpathdefault", "Fill the path from the first transition out of each clip, starting at the start clip", () => api.setPath(defaultPath(graph)));
    body.append(row("Path", pathIn, defPath, cycleLabel));
    const missing = pathEdges(graph, graph.path).missing;
    if (missing.length) {
      const warn = node("div", "note bad", `No transition for: ${missing.join("; ")}. The cycle skips those hops.`);
      warn.id = "transpathwarn";
      body.append(warn);
    }

    // triggers
    const cur = st?.current ?? "";
    const trig = node("div", "transtriggers");
    trig.id = "transtriggers";
    const out = cur ? edgesFrom(graph, cur) : [];
    if (!on) trig.append(node("span", "label", "Turn on Show on stage to use the triggers"));
    else if (!cur) trig.append(node("span", "label", "Press Start over to begin"));
    else if (!out.length) trig.append(node("span", "label", `No transitions leave ${cur}`));
    for (const e of out) {
      const b = button(`${e.to}${e.condition ? `  (${e.condition})` : ""}`, `transfire-${e.to}`, `Take the transition ${e.from} to ${e.to}: blend over ${e.blend} s${e.condition ? `, when ${e.condition}` : ""}`, () => api.fire(e.to));
      b.dataset.act = "fire";
      b.dataset.to = e.to;
      trig.append(b);
    }
    body.append(row("Triggers", trig));
    const read = node("div", "readout");
    read.id = "transread";
    read.setAttribute("role", "status");
    read.textContent = readoutText(st);
    body.append(read);

    // transitions
    const from = select(inGraph, selNode && graph.nodes.includes(selNode) ? selNode : (graph.nodes[0] ?? ""), "Transition from this clip", "transfrom", () => {});
    const to = select(inGraph, graph.nodes.find((n) => n !== from.value) ?? "", "Transition to this clip", "transto", () => {});
    const blend = node("input");
    blend.id = "transblend";
    blend.type = "number";
    blend.step = "0.05";
    blend.min = "0";
    blend.max = "5";
    blend.value = String(DEFAULT_BLEND);
    blend.title = "Blend time in seconds: how long the two clips crossfade";
    blend.setAttribute("aria-label", "Blend time in seconds");
    const cond = node("input");
    cond.id = "transcond";
    cond.placeholder = "condition (optional)";
    cond.title = "A label for when this transition happens, such as speed > 0. It is shown on the arrow and the trigger; it does not run anything";
    cond.setAttribute("aria-label", "Condition label");
    const err = node("div", "note bad");
    err.id = "transerr";
    err.hidden = true;
    const addEdgeBtn = button("Add transition", "transedgeadd", "Add the transition from the first clip to the second (or update it if it exists)", () => {
      const r = api.addEdge(from.value, to.value, Number(blend.value), cond.value);
      err.hidden = !r;
      err.textContent = r ?? "";
    });
    body.append(row("From", from, node("span", "label", "to"), to), row("Blend", blend, node("span", "label", "s"), cond, addEdgeBtn), err);

    const list = node("div", "transedges");
    list.id = "transedges";
    for (const e of graph.edges) {
      const r = node("div", "row transedgerow");
      r.dataset.edge = e.id;
      const bl = node("input");
      bl.type = "number";
      bl.step = "0.05";
      bl.min = "0";
      bl.max = "5";
      bl.value = String(e.blend);
      bl.title = `Blend time of ${e.from} to ${e.to}, in seconds`;
      bl.setAttribute("aria-label", `Blend ${e.from} to ${e.to}`);
      bl.onchange = () => api.addEdge(e.from, e.to, Number(bl.value), e.condition);
      const cn = node("input");
      cn.value = e.condition;
      cn.placeholder = "condition";
      cn.title = `Condition label of ${e.from} to ${e.to}`;
      cn.setAttribute("aria-label", `Condition ${e.from} to ${e.to}`);
      cn.onchange = () => api.addEdge(e.from, e.to, e.blend, cn.value);
      const rm = button("Remove", `transedgeremove-${e.id}`, `Remove the transition ${e.from} to ${e.to}`, () => api.removeEdge(e.id));
      rm.dataset.act = "remove-edge";
      r.append(node("span", "transedgename", `${e.from} > ${e.to}`), bl, cn, rm);
      list.append(r);
    }
    if (!graph.edges.length) list.append(node("span", "label", "No transitions yet"));
    body.append(list);
    void all;

    const saveBtn = button("Save now", "transsavenow", "Write the graph to transitions.json in the data folder (edits also save by themselves)", () => void api.save());
    body.append(row("", saveBtn));
    saveLine.textContent =
      note ||
      (saveState === "saved" ? "Saved in the data folder (transitions.json)." : saveState === "unsaved" ? "Saving..." : saveState === "draft" ? "A starter graph from the project's clip map: it is saved when you change something or press Save now." : saveState === "error" ? "Not saved: the data folder could not be written." : "");
  }

  function readoutText(st: GraphStatus | null): string {
    if (!st || !st.current) return on ? "Nothing playing" : "Off";
    const mix = st.from && st.mix !== null ? ` | blending ${st.from} to ${st.current}: ${Math.round(st.mix * 100)}%` : "";
    return `Playing ${st.current} (${st.at.toFixed(1)} s)${mix}${st.last ? ` | last: ${st.last}` : ""}`;
  }

  /** What a redraw of the panel depends on; the blend percentage only moves the readout line, not the DOM. */
  const statusKey = (st: GraphStatus | null): string => (st ? `${st.current}|${st.from && st.mix !== null ? st.from : ""}|${st.fired}` : "");

  // --- API ------------------------------------------------------------------------------------

  const api: TransitionsPreview = {
    active: () => on,
    setActive(next) {
      if (next === on) return;
      if (next) host.beforeActivate();
      on = next;
      if (on) {
        playing = true;
        const rig = host.rigId();
        // a graph nobody saved or edited is a starter: build it again from the clips the rig has now
        if (rig !== graphRig || saveState === "none" || saveState === "draft") void loadFor(rig);
        else startSession(graph.entry || undefined);
      }
      render();
      host.changed();
    },
    tick(dt) {
      if (!on || !playing) return;
      const s = ensureSession();
      if (!s) return;
      s.update(dt);
      const st = s.status();
      const key = statusKey(st);
      const read = document.getElementById("transread");
      if (read) read.textContent = readoutText(st);
      if (key !== lastStatusKey) render();
    },
    apply(skeleton) {
      const s = ensureSession();
      if (s) s.apply(skeleton);
    },
    invalidate() {
      stale = true;
      const rig = host.rigId();
      if (rig !== graphRig || ((saveState === "none" || saveState === "draft") && !on)) {
        void loadFor(rig);
        return;
      }
      if (on) {
        render();
        host.changed();
      }
    },
    play(next) {
      playing = next;
      render();
      host.changed();
    },
    start(clip) {
      const target = clip ?? graph.entry;
      if (!target) return;
      const s = ensureSession();
      s?.start(target);
      render();
      host.changed();
    },
    fire(to) {
      const s = ensureSession();
      if (!s) return "Open a rig first";
      const r = s.fire(to);
      if ("error" in r) {
        note = r.error;
        render();
        return r.error;
      }
      note = "";
      playing = true;
      render();
      host.changed();
      return null;
    },
    setCycle(next) {
      const s = ensureSession();
      if (!s) return;
      if (!s.node && graph.path[0]) s.start(graph.path[0]);
      s.setCycling(next);
      playing = true;
      render();
      host.changed();
    },
    addNode(clip) {
      graph = addNode(graph, clip);
      selNode = clip;
      edited();
    },
    removeNode(clip) {
      graph = removeNode(graph, clip);
      selNode = graph.nodes[0] ?? "";
      edited();
    },
    addEdge(from, to, blend, condition) {
      const r = setEdge(graph, from, to, blend, condition);
      if ("error" in r) return r.error;
      graph = r;
      edited();
      return null;
    },
    removeEdge(id) {
      graph = removeEdge(graph, id);
      edited();
    },
    prefill() {
      graph = prefillGraph(CLIP_MAP, host.clips());
      selNode = graph.entry;
      note = graph.nodes.length ? "" : "None of the project's mapped clips are in this rig, so there is nothing to pre-fill";
      if (on) startSession(graph.entry || undefined);
      edited();
    },
    setPath(path) {
      const keep = path.filter((n) => graph.nodes.includes(n));
      graph = { ...graph, path: keep };
      note = keep.length < path.length ? `Left out clips that are not nodes: ${path.filter((n) => !graph.nodes.includes(n)).join(", ")}` : "";
      edited();
    },
    save,
    info() {
      return { active: on, playing, rig: graphRig, saved: saveState, graph: structuredClone(graph), status: on ? (session?.status() ?? null) : null, cycling: !!session?.isCycling, missingHops: pathEdges(graph, graph.path).missing };
    }
  };

  render();
  return api;
}
