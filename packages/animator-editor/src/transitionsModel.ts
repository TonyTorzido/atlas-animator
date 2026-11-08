/*
 * Atlas Animator editor: original implementation.
 *
 * Clip transitions: a small state graph of a rig's clips, Rive style. Nodes are clips, an edge is a transition
 * from one clip to another with a blend time and an optional condition label. The graph is previewed on the stage with the runtime's
 * own AnimationState (one track; a transition is `setAnimation(..., { mix })`, the engine crossfades). The graph is a preview and
 * hand-off aid: the project's own state machine is not driven by it. Pure code (no DOM, no Pixi); unit tested.
 */
import { AnimationState, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { compileClips } from "./trackModel.js";

export const TRANSITIONS_FORMAT = "atlas-transitions@1";
export const MAX_BLEND = 5;
export const DEFAULT_BLEND = 0.2;
/** Longest a node plays during an auto-cycle, so a long clip does not stall the walk through the path. */
export const CYCLE_MAX_DWELL = 3;
export const CYCLE_MIN_DWELL = 0.6;

export interface TransitionEdge {
  /** `from>to`: one edge per ordered pair. */
  id: string;
  from: string;
  to: string;
  /** Crossfade seconds. */
  blend: number;
  /** A label such as `speed > 0` or `attack`: shown on the arrow and on the trigger button; empty = unconditional. */
  condition: string;
}

export interface TransitionGraph {
  format: typeof TRANSITIONS_FORMAT;
  /** The clip the preview starts on. */
  entry: string;
  /** Clip names, in the order the graph lists them. */
  nodes: string[];
  edges: TransitionEdge[];
  /** The auto-cycle path (clip names, the last one hands back to the first). */
  path: string[];
}

export const edgeId = (from: string, to: string): string => `${from}>${to}`;

export function emptyGraph(): TransitionGraph {
  return { format: TRANSITIONS_FORMAT, entry: "", nodes: [], edges: [], path: [] };
}

const isName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/.test(v);

/** Reads a stored graph (anything unreadable becomes an empty graph; bad edges and unknown nodes are dropped). */
export function parseGraph(raw: unknown): TransitionGraph {
  const g = emptyGraph();
  if (!raw || typeof raw !== "object") return g;
  const o = raw as Record<string, unknown>;
  const nodes = Array.isArray(o["nodes"]) ? o["nodes"].filter(isName) : [];
  g.nodes = [...new Set(nodes)];
  const have = new Set(g.nodes);
  const seen = new Set<string>();
  for (const e of Array.isArray(o["edges"]) ? o["edges"] : []) {
    const r = e as Record<string, unknown>;
    if (!isName(r?.["from"]) || !isName(r["to"]) || !have.has(r["from"]) || !have.has(r["to"]) || r["from"] === r["to"]) continue;
    const id = edgeId(r["from"], r["to"]);
    if (seen.has(id)) continue;
    seen.add(id);
    const blend = typeof r["blend"] === "number" && Number.isFinite(r["blend"]) ? Math.min(MAX_BLEND, Math.max(0, r["blend"])) : DEFAULT_BLEND;
    g.edges.push({ id, from: r["from"], to: r["to"], blend, condition: typeof r["condition"] === "string" ? r["condition"].slice(0, 60) : "" });
  }
  g.entry = isName(o["entry"]) && have.has(o["entry"]) ? o["entry"] : (g.nodes[0] ?? "");
  g.path = (Array.isArray(o["path"]) ? o["path"] : []).filter((n): n is string => isName(n) && have.has(n)).slice(0, 24);
  return g;
}

export function addNode(g: TransitionGraph, clip: string): TransitionGraph {
  if (!clip || g.nodes.includes(clip)) return g;
  const nodes = [...g.nodes, clip];
  return { ...g, nodes, entry: g.entry || clip };
}

export function removeNode(g: TransitionGraph, clip: string): TransitionGraph {
  const nodes = g.nodes.filter((n) => n !== clip);
  return { ...g, nodes, edges: g.edges.filter((e) => e.from !== clip && e.to !== clip), entry: g.entry === clip ? (nodes[0] ?? "") : g.entry, path: g.path.filter((n) => n !== clip) };
}

/** Adds (or updates) the transition from -> to. Returns the new graph, or the reason it cannot be made. */
export function setEdge(g: TransitionGraph, from: string, to: string, blend: number, condition: string): TransitionGraph | { error: string } {
  if (!g.nodes.includes(from) || !g.nodes.includes(to)) return { error: "Both clips must be nodes in the graph" };
  if (from === to) return { error: "A transition needs two different clips" };
  if (!Number.isFinite(blend) || blend < 0) return { error: "Blend time is a number of seconds, 0 or more" };
  const id = edgeId(from, to);
  const edge: TransitionEdge = { id, from, to, blend: Math.min(MAX_BLEND, Math.round(blend * 1000) / 1000), condition: condition.trim().slice(0, 60) };
  const has = g.edges.some((e) => e.id === id);
  return { ...g, edges: has ? g.edges.map((e) => (e.id === id ? edge : e)) : [...g.edges, edge] };
}

export function removeEdge(g: TransitionGraph, id: string): TransitionGraph {
  return { ...g, edges: g.edges.filter((e) => e.id !== id) };
}

export const edgesFrom = (g: TransitionGraph, clip: string): TransitionEdge[] => g.edges.filter((e) => e.from === clip);

/** The path the graph walks by itself: from the entry, the first transition out of each clip, until it returns (at most 8 steps). */
export function defaultPath(g: TransitionGraph): string[] {
  const out: string[] = [];
  let at = g.entry;
  const visited = new Set<string>();
  while (at && out.length < 8) {
    out.push(at);
    if (visited.has(at)) break;
    visited.add(at);
    const next = edgesFrom(g, at)[0];
    if (!next) break;
    if (next.to === g.entry) break;
    at = next.to;
  }
  return out;
}

/** The edges of a path (clip i to clip i+1, and the last back to the first); `missing` names hops that have no transition. */
export function pathEdges(g: TransitionGraph, path: readonly string[]): { edges: TransitionEdge[]; missing: string[] } {
  const edges: TransitionEdge[] = [];
  const missing: string[] = [];
  if (path.length < 2) return { edges, missing };
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    if (a === b) continue;
    const e = g.edges.find((x) => x.from === a && x.to === b);
    if (e) edges.push(e);
    else missing.push(`${a} to ${b}`);
  }
  return { edges, missing };
}

// ---------------------------------------------------------------------------------------------------------------- prefill

export interface ClipMapLike {
  clips: Readonly<Record<string, { source: string }>>;
}

const ATTACK_WORDS = /attack|slash|swing|strike/i;

/**
 * A starting graph from the project's clip map: every mapped clip the rig has becomes a node (the map's editor id, or the clip the sheets
 * were rendered from), plus an attack clip when the rig has one. Idle goes to each other clip on a named condition; the clip comes
 * back to idle when it ends (looping moves: when you stop). The auto-cycle path is idle, walk, an attack or gather, idle.
 */
export function prefillGraph(map: ClipMapLike, available: Readonly<Record<string, ClipData>>): TransitionGraph {
  const names = Object.keys(available);
  const nodes: string[] = [];
  const role = new Map<string, string>();
  for (const [editorId, row] of Object.entries(map.clips)) {
    const found = [editorId, row.source].find((n) => names.includes(n));
    if (found && !nodes.includes(found)) {
      nodes.push(found);
      role.set(found, editorId);
    }
  }
  // A rig whose clips are named differently from the map (a fresh data folder has only the rig's own clips) still gets the three
  // roles the preview needs: idle (idle / rest), walk and an attack, found by name.
  const fallback = (r: string, re: RegExp): void => {
    if ([...role.values()].some((x) => x === r || (r === "walk" && x === "walk_down"))) return;
    const found = names.find((n) => re.test(n) && !nodes.includes(n));
    if (found) {
      nodes.push(found);
      role.set(found, r);
    }
  };
  fallback("idle", /idle|rest/i);
  fallback("walk", /walk/i);
  const attack = names.find((n) => ATTACK_WORDS.test(n) && !nodes.includes(n));
  if (attack) {
    nodes.push(attack);
    role.set(attack, "attack");
  }
  let g: TransitionGraph = { ...emptyGraph(), nodes, entry: nodes.find((n) => role.get(n) === "idle") ?? nodes[0] ?? "" };
  const idle = g.entry;
  if (!idle) return g;
  for (const n of nodes) {
    if (n === idle) continue;
    const r = role.get(n)!;
    const moving = /^walk|run|guard_walk/.test(r) || /walk/.test(n);
    const next = setEdge(g, idle, n, moving ? 0.15 : 0.1, moving ? "speed > 0" : r === "attack" ? "attack" : r.replace(/^gather_/, "gather "));
    if (!("error" in next)) g = next;
    const back = setEdge(g, n, idle, moving ? 0.2 : 0.15, moving ? "speed = 0" : "on end");
    if (!("error" in back)) g = back;
  }
  const walk = nodes.find((n) => /^walk|walk_in_place/.test(role.get(n) ?? "") || (role.get(n) === "walk"));
  const act = attack ?? nodes.find((n) => /^gather_/.test(role.get(n) ?? ""));
  g.path = [idle, ...(walk ? [walk] : []), ...(act ? [act] : [])];
  if (g.path.length < 2) g.path = defaultPath(g);
  // the auto-cycle walks hop to hop: give every hop of the path (including the way back to the first clip) a transition
  for (let i = 0; i < g.path.length; i++) {
    const from = g.path[i]!;
    const to = g.path[(i + 1) % g.path.length]!;
    if (from === to || g.edges.some((e) => e.from === from && e.to === to)) continue;
    const next = setEdge(g, from, to, 0.15, role.get(to) === "attack" ? "attack" : "next");
    if (!("error" in next)) g = next;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------------------- preview

export interface GraphStatus {
  current: string;
  /** The clip being faded out and how far the fade is (0..1), or null when no transition is running. */
  from: string | null;
  mix: number | null;
  /** Seconds the current clip has played. */
  at: number;
  /** The last transition fired (`idle > walk`) and how many have fired. */
  last: string;
  fired: number;
}

/**
 * Plays the graph on a skeleton. One track; `fire` starts a transition with the engine's crossfade. A clip that does not loop and
 * has played out follows its first unconditional or "on end" transition by itself. `cycle` walks the path: each node plays long
 * enough to be seen (its length, held between CYCLE_MIN_DWELL and CYCLE_MAX_DWELL seconds), then the next transition fires.
 */
export class GraphSession {
  private data;
  private state: AnimationState;
  private current = "";
  private playedFor = 0;
  private lastFired = "";
  private count = 0;
  private cycling = false;
  private cycleIndex = 0;

  constructor(
    private readonly doc: AnimDocument,
    private clips: Record<string, ClipData>,
    private graph: TransitionGraph
  ) {
    this.data = compileClips(doc, clips);
    this.state = new AnimationState(this.data);
  }

  /** The clips or the graph changed: recompile, keep playing the same node where it still exists. */
  setGraph(clips: Record<string, ClipData>, graph: TransitionGraph): void {
    this.clips = clips;
    this.graph = graph;
    this.data = compileClips(this.doc, clips);
    const keep = this.current;
    this.state = new AnimationState(this.data);
    this.current = "";
    this.cycling = this.cycling && graph.path.length > 1;
    if (keep && clips[keep] && graph.nodes.includes(keep)) this.start(keep);
  }

  /** Starts (or restarts) on a clip with no fade. */
  start(clip: string): boolean {
    if (!this.clips[clip]) return false;
    this.state = new AnimationState(this.data);
    this.state.setAnimation(0, clip, { mix: 0 });
    this.current = clip;
    this.playedFor = 0;
    this.lastFired = "";
    this.count = 0;
    this.cycleIndex = Math.max(0, this.graph.path.indexOf(clip));
    return true;
  }

  get node(): string {
    return this.current;
  }

  get isCycling(): boolean {
    return this.cycling;
  }

  /** Fires the transition from the current clip to `to` (an edge id also works). Returns the edge, or the reason it is not possible. */
  fire(to: string): TransitionEdge | { error: string } {
    if (!this.current) return { error: "Press Start first: no clip is playing" };
    const edge = this.graph.edges.find((e) => e.from === this.current && (e.to === to || e.id === to));
    if (!edge) return { error: `No transition from ${this.current} to ${to}` };
    if (!this.clips[edge.to]) return { error: `The clip ${edge.to} is not in this rig` };
    this.state.setAnimation(0, edge.to, { mix: edge.blend });
    this.current = edge.to;
    this.playedFor = 0;
    this.lastFired = `${edge.from} > ${edge.to}`;
    this.count++;
    return edge;
  }

  setCycling(on: boolean): void {
    this.cycling = on && this.graph.path.length > 1;
    if (this.cycling) {
      if (!this.current) this.start(this.graph.path[0]!);
      const at = this.graph.path.indexOf(this.current);
      this.cycleIndex = at >= 0 ? at : 0;
    }
  }

  private dwell(clip: string): number {
    const c = this.clips[clip];
    return Math.min(CYCLE_MAX_DWELL, Math.max(CYCLE_MIN_DWELL, c?.duration ?? CYCLE_MIN_DWELL));
  }

  /** Advances the preview clock by `dt` seconds (steps no longer than 1/30 s so crossfades start on time). */
  update(dt: number): void {
    let left = Math.max(0, dt);
    while (left > 1e-9) {
      const step = Math.min(left, 1 / 30);
      left -= step;
      this.state.update(step);
      this.playedFor += step;
      this.autoAdvance();
    }
  }

  private autoAdvance(): void {
    if (!this.current) return;
    if (this.cycling && this.graph.path.length > 1) {
      if (this.playedFor >= this.dwell(this.current)) {
        const path = this.graph.path;
        const here = path.indexOf(this.current);
        const from = here >= 0 ? here : this.cycleIndex;
        const next = path[(from + 1) % path.length]!;
        const r = this.fire(next);
        // a hop with no transition is skipped over (the panel names it) so the cycle never stalls
        if ("error" in r) {
          const skip = this.graph.nodes.includes(next) ? next : path[(from + 2) % path.length]!;
          this.state.setAnimation(0, skip, { mix: 0 });
          this.current = skip;
          this.playedFor = 0;
        }
        this.cycleIndex = path.indexOf(this.current);
      }
      return;
    }
    const clip = this.clips[this.current];
    if (clip && !clip.loop && this.playedFor >= clip.duration) {
      const auto = edgesFrom(this.graph, this.current).find((e) => !e.condition || /^(on )?end$/i.test(e.condition));
      if (auto) this.fire(auto.to);
    }
  }

  apply(sk: Parameters<AnimationState["apply"]>[0]): void {
    this.state.apply(sk);
  }

  status(): GraphStatus {
    const entry = this.state.getCurrent(0);
    const mixing = entry?.mixingFrom ?? null;
    return {
      current: this.current,
      from: mixing ? mixing.clip.name : null,
      mix: mixing && entry ? Math.min(1, Math.max(0, entry.mixFraction)) : null,
      at: this.playedFor,
      last: this.lastFired,
      fired: this.count
    };
  }
}
