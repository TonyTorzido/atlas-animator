import { readFileSync } from "node:fs";
import { loadAnimDocument, Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { describe, expect, it } from "vitest";
import { CLIP_MAP } from "../../animator/src/clipMap.js";
import { ALL_OUTFITS } from "./fixtures.js";
import { withEventDefs } from "./eventModel.js";
import { addNode, defaultPath, edgeId, GraphSession, emptyGraph, parseGraph, pathEdges, prefillGraph, removeEdge, removeNode, setEdge, type TransitionGraph } from "./transitionsModel.js";

const player = ALL_OUTFITS.find((o) => o.id === "turned-l")!;
const raw = JSON.parse(readFileSync(new URL(`../../../${player.document}`, import.meta.url), "utf8")) as unknown;
const doc: AnimDocument = withEventDefs(loadAnimDocument(raw, { source: player.document }));
const clips = structuredClone(doc.animations) as Record<string, ClipData>;
const names = Object.keys(clips);

const must = <T,>(v: T | { error: string }): T => {
  if (v && typeof v === "object" && "error" in v) throw new Error(String((v as { error: string }).error));
  return v as T;
};
const rot = (sk: Skeleton, bone: string) => sk.findBone(bone)!.pose.rotation;

describe("transition graph model", () => {
  const [a, b, c] = names;
  it("adds one edge per ordered pair, updates it, and refuses bad ones", () => {
    let g = emptyGraph();
    g = addNode(addNode(addNode(g, a!), b!), c!);
    expect(g.entry).toBe(a);
    g = must(setEdge(g, a!, b!, 0.3, " speed > 0 "));
    expect(g.edges).toEqual([{ id: edgeId(a!, b!), from: a, to: b, blend: 0.3, condition: "speed > 0" }]);
    g = must(setEdge(g, a!, b!, 0.5, ""));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.blend).toBe(0.5);
    expect(setEdge(g, a!, a!, 0.2, "")).toHaveProperty("error");
    expect(setEdge(g, a!, "nope", 0.2, "")).toHaveProperty("error");
    expect(setEdge(g, a!, c!, -1, "")).toHaveProperty("error");
    expect(removeEdge(g, edgeId(a!, b!)).edges).toHaveLength(0);
    const gone = removeNode(g, b!);
    expect(gone.edges).toHaveLength(0);
    expect(gone.nodes).toEqual([a, c]);
  });

  it("reads a stored graph defensively", () => {
    const g = parseGraph({ nodes: ["a", "b", "a", 3], edges: [{ from: "a", to: "b", blend: 99, condition: "x" }, { from: "a", to: "zz", blend: 1 }, { from: "a", to: "a" }], entry: "zz", path: ["a", "q", "b"] });
    expect(g.nodes).toEqual(["a", "b"]);
    expect(g.edges).toEqual([{ id: "a>b", from: "a", to: "b", blend: 5, condition: "x" }]);
    expect(g.entry).toBe("a");
    expect(g.path).toEqual(["a", "b"]);
    expect(parseGraph(null).nodes).toEqual([]);
  });

  it("pre-fills from the project clip map (only clips the rig has) and builds an auto-cycle path", () => {
    const have: Record<string, ClipData> = { ...clips, idle_weight_shift: clips[names[0]!]!, walk_in_place: clips[names[1]!]!, "attack_1": clips[names[2]!]! };
    const g = prefillGraph(CLIP_MAP, have);
    expect(g.nodes).toEqual(expect.arrayContaining(["idle_weight_shift", "walk_in_place", "attack_1"]));
    expect(g.entry).toBe("idle_weight_shift");
    expect(g.edges.some((e) => e.from === "idle_weight_shift" && e.to === "walk_in_place")).toBe(true);
    expect(g.edges.some((e) => e.from === "walk_in_place" && e.to === "idle_weight_shift")).toBe(true);
    expect(g.path).toEqual(["idle_weight_shift", "walk_in_place", "attack_1"]);
    expect(pathEdges(g, g.path).missing).toEqual([]);
    expect(prefillGraph(CLIP_MAP, {}).nodes).toEqual([]);
  });

  it("default path follows the first transition out of each clip and stops on a return", () => {
    let g: TransitionGraph = { ...emptyGraph(), nodes: ["a", "b", "c"], entry: "a" };
    g = must(setEdge(g, "a", "b", 0.2, ""));
    g = must(setEdge(g, "b", "c", 0.2, ""));
    g = must(setEdge(g, "c", "a", 0.2, ""));
    expect(defaultPath(g)).toEqual(["a", "b", "c"]);
    expect(pathEdges({ ...g, edges: g.edges.slice(0, 2) }, ["a", "b", "c"]).missing).toEqual(["c to a"]);
  });
});

describe("transition graph preview", () => {
  const [a, b] = names;
  const graph = (): TransitionGraph => {
    let g: TransitionGraph = { ...emptyGraph(), nodes: [a!, b!], entry: a!, path: [a!, b!] };
    g = must(setEdge(g, a!, b!, 0.5, "go"));
    g = must(setEdge(g, b!, a!, 0.25, "back"));
    return g;
  };
  const pose = (s: GraphSession): Record<string, number> => {
    const sk = new Skeleton(doc);
    s.apply(sk);
    return Object.fromEntries(sk.bones.map((x) => [x.data.name, x.pose.rotation]));
  };

  it("crossfades between the clips for the blend time and then shows only the target", () => {
    const s = new GraphSession(doc, clips, graph());
    expect(s.start(a!)).toBe(true);
    s.update(0.5);
    const before = s.status();
    expect(before.current).toBe(a);
    expect(before.mix).toBeNull();
    pose(s); // the stage applies the pose every frame; a clip that was never shown is replaced outright
    const r = s.fire(b!);
    expect("error" in r).toBe(false);
    s.update(0.25);
    const mid = s.status();
    expect(mid.from).toBe(a);
    expect(mid.mix).toBeGreaterThan(0.3);
    expect(mid.mix).toBeLessThan(0.7);
    s.update(0.5);
    const done = s.status();
    expect(done.current).toBe(b);
    expect(done.mix).toBeNull();
    expect(done.fired).toBe(1);
    // fully faded: the pose is the target clip alone
    const alone = new GraphSession(doc, clips, graph());
    alone.start(b!);
    alone.update(done.at);
    const x = pose(s);
    const y = pose(alone);
    const bone = doc.bones.map((n) => n.name).find((n) => Math.abs((x[n] ?? 0) - (y[n] ?? 0)) > 1e-3);
    expect(bone).toBeUndefined();
  });

  it("refuses a transition that does not exist", () => {
    const s = new GraphSession(doc, clips, graph());
    expect(s.fire(b!)).toHaveProperty("error");
    s.start(a!);
    expect(s.fire("nope")).toHaveProperty("error");
  });

  it("auto-cycles the path and wraps back to the first clip", () => {
    const s = new GraphSession(doc, clips, graph());
    s.start(a!);
    s.setCycling(true);
    const seen: string[] = [a!];
    for (let i = 0; i < 40 * 8; i++) {
      s.update(1 / 30);
      if (s.node !== seen[seen.length - 1]) seen.push(s.node);
    }
    expect(seen.slice(0, 4)).toEqual([a, b, a, b]);
    expect(s.status().fired).toBeGreaterThanOrEqual(3);
  });

  it("a one-shot clip follows its unconditional transition when it ends", () => {
    const shot: Record<string, ClipData> = { ...clips, __shot: { ...clips[b!]!, loop: false, duration: 0.5 } };
    let g: TransitionGraph = { ...emptyGraph(), nodes: ["__shot", a!], entry: "__shot" };
    g = must(setEdge(g, "__shot", a!, 0.1, "on end"));
    const s = new GraphSession(doc, shot, g);
    s.start("__shot");
    s.update(0.6);
    expect(s.node).toBe(a);
  });
});
