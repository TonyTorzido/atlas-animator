/*
 * Atlas Animator: original implementation.
 *
 * Auto-weights (plan 4.6 step 4): bone weights for a part mesh.
 *
 * Model. A part is a chain of bones (upper arm, forearm, hand), optionally hung from an anchor
 * bone through a cut (the arm's root ring under the torso hangs from the shoulder). Weights are
 * heat weights (Baran and Popovic 2007, "Pinocchio"): per bone j, solve
 *     (K + M H) w_j = M H p_j
 * on the mesh, with K the cotangent stiffness matrix (linear finite elements), M the lumped vertex
 * areas, H_i = heat / d_i^2 for d_i the distance from vertex i to its nearest bone segment, and
 * p_j(i) = 1 when j is that nearest bone. Scaling H by the vertex area makes the result
 * independent of the image resolution.
 *
 * Joint hygiene (research: alternatives-practices.md section 2) is imposed as hard constraints
 * before solving, so the heat solve only fills the joint bands and every band is a smooth ramp:
 * - pinned ring: vertices within `pinDepth` of the anchor cut are 100% the anchor bone (underarm
 *   and inner-thigh rings stay on the torso, so a turning limb stretches its root instead of
 *   tearing away from the body);
 * - rigid zones: vertices further than a band from every joint are 100% their own bone (a band is
 *   the limb radius, capped at 40% of the shorter neighbouring bone so short chibi bones keep a
 *   core), and the ring of vertices nearest each bone's middle is always 100% that bone;
 * - the root band runs from the pinned ring to one limb radius past the cut.
 * After the solve: clamp to 0..1, keep the largest `maxInfluences` (4), drop weights under
 * `minWeight`, normalise, then `smooth` passes over the free vertices only (rigid and pinned
 * vertices stay exact), normalise again.
 */
import { segmentDistance, type Point } from "./outline.js";

export interface WeightBone {
  name: string;
  /** Canvas start and end of the bone. */
  start: Point;
  end: Point;
  /** Half-width of the body around the bone. */
  radius: number;
}

export interface WeightChain {
  /** Parent to child, each starting where the previous one ends (or near it). */
  bones: readonly WeightBone[];
  /** The bone the chain's root ring is pinned to, and the cut the part was cut along. */
  anchor?: { bone: WeightBone; cut: { a: Point; b: Point } };
}

export interface AutoWeightOptions {
  maxInfluences?: number;
  /** Weights below this are dropped (default 0.02). */
  minWeight?: number;
  /** Smoothing passes over free vertices (default 1). */
  smooth?: number;
  /** Vertices this close to the anchor cut are pinned to the anchor (default 10 px). */
  pinDepth?: number;
  /** Heat coefficient (default 0.2; larger follows the nearest bone more sharply). */
  heat?: number;
}

/** How two parts of one weight tree meet (authoring `connections`). */
export type ConnectionKind = "welded" | "overlap" | "membrane";

export interface TreeWeightOptions extends AutoWeightOptions {
  /**
   * Deformation domain: tree bones (indices) the mesh may be influenced by; a bone it rejects is
   * no vertex's domain and gets no weight anywhere, enforced inside the solve.
   */
  allow?: (bone: number) => boolean;
  /**
   * Connections between two sets of tree bones: `membrane` lets vertices between them blend
   * across the sets anywhere (a wing membrane between finger bones), `overlap` forbids any
   * influence across them, even at a shared joint (a tail drawn over the body), `welded` is the
   * default joint rule.
   */
  connections?: readonly { a: readonly number[]; b: readonly number[]; kind: ConnectionKind }[];
  /** Transition width per joint (tree bone index k = the joint at bone k's start), over the default band. */
  jointWidth?: ReadonlyMap<number, number>;
  /**
   * Anchor eligibility: with an anchor, the anchor bone may carry weight (the pinned
   * ring and the root bone's joint band) unless this is false; an ineligible anchor pins nothing and
   * joins no vertex's mask. `allow` speaks only of tree bones.
   */
  allowAnchor?: boolean;
  /**
   * Pruning to `maxInfluences` measures the dropped mass and the posed displacement
   * error (each bone alone, and all bones with alternating sign, rotated 30 degrees about their
   * starts). Vertices whose error exceeds `hubErrorPx` (default 1 px) are reported in the
   * diagnostics; `hubPolicy: "reject"` throws instead (a hub the influence cap cannot represent
   * needs other topology).
   */
  hubErrorPx?: number;
  hubPolicy?: "warn" | "reject";
}

/** One ambiguous vertex: its owner and up to three competing non-adjacent bones (tree indices). */
export interface Ambiguity {
  vertex: number;
  owner: number;
  competitors: { bone: number; distance: number }[];
}

/** What the weight solve had to correct, for reports. */
export interface WeightDiagnostics {
  /** Vertices whose nearest allowed bones include a non-adjacent one at nearly the same distance. */
  ambiguities: Ambiguity[];
  /** Heat weights outside [0, 1] before the clamp: vertices and the largest overshoot. */
  clamped: { vertices: number[]; maxMagnitude: number };
  /** Influence-cap pruning: largest dropped mass and posed error, and the vertices over `hubErrorPx`. */
  pruning: { maxDiscarded: number; maxErrorPx: number; worstVertex: number; overVertices: number[] };
}

const emptyDiagnostics = (): WeightDiagnostics => ({ ambiguities: [], clamped: { vertices: [], maxMagnitude: 0 }, pruning: { maxDiscarded: 0, maxErrorPx: 0, worstVertex: -1, overVertices: [] } });

/** Solved heat weights outside [0, 1] (before any clamp). */
function clampStats(weights: readonly Float64Array[], n: number): WeightDiagnostics["clamped"] {
  const vertices: number[] = [];
  let maxMagnitude = 0;
  for (let i = 0; i < n; i++) {
    let over = 0;
    for (const w of weights) {
      const v = w[i] as number;
      over = Math.max(over, -v, v - 1);
    }
    if (over > 1e-9) {
      vertices.push(i);
      maxMagnitude = Math.max(maxMagnitude, over);
    }
  }
  return { vertices, maxMagnitude };
}

/** One influence of one vertex; `bone` indexes the part's bone list (anchor first, then the chain). */
export interface Influence {
  bone: number;
  weight: number;
}

export interface MeshForWeights {
  /** x, y per vertex (canvas). */
  points: ArrayLike<number>;
  triangles: ArrayLike<number>;
}

export interface WeightResult {
  /** The part's bones: the anchor (if any) first, then the chain. */
  bones: WeightBone[];
  /** Per vertex, influences sorted by weight (largest first), weights summing to 1. */
  weights: Influence[][];
  /** Per vertex: "pinned", "rigid" or "free" (for overlays and tests). */
  kinds: ("pinned" | "rigid" | "free")[];
  /** Heat weights outside [0, 1] before the clamp. */
  clamped?: WeightDiagnostics["clamped"];
}

export function autoWeights(mesh: MeshForWeights, chain: WeightChain, options: AutoWeightOptions = {}): WeightResult {
  const maxInfluences = options.maxInfluences ?? 4;
  const minWeight = options.minWeight ?? 0.02;
  const pinDepth = options.pinDepth ?? 10;
  const heat = options.heat ?? 0.2;
  const anchor = chain.anchor;
  const bones = anchor ? [anchor.bone, ...chain.bones] : [...chain.bones];
  const chainOffset = anchor ? 1 : 0;
  const n = mesh.points.length / 2;
  const px = (i: number) => mesh.points[i * 2] as number;
  const py = (i: number) => mesh.points[i * 2 + 1] as number;

  if (chain.bones.length === 0) throw new Error("auto-weights: the chain has no bones");
  const constrained = new Int32Array(n).fill(-1);
  const kinds: WeightResult["kinds"] = new Array(n).fill("free");

  // Chain geometry: arc-length position of each vertex along the chain.
  const lengths = chain.bones.map((b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y));
  const starts: number[] = [];
  let along = 0;
  for (const length of lengths) {
    starts.push(along);
    along += length;
  }
  const axial = new Float64Array(n);
  const nearestChain = new Int32Array(n);
  // The owning chain bone is the nearest along the mesh (geodesicBoneDistances), never across a gap.
  const geodesic = geodesicBoneDistances(mesh, chain.bones);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    chain.bones.forEach((_, k) => {
      const d = (geodesic[k] as Float64Array)[i] as number;
      if (d < best) {
        best = d;
        nearestChain[i] = k;
      }
    });
    const k = nearestChain[i] as number;
    const bone = chain.bones[k] as WeightBone;
    const length = lengths[k] as number;
    const t = length > 0 ? ((px(i) - bone.start.x) * (bone.end.x - bone.start.x) + (py(i) - bone.start.y) * (bone.end.y - bone.start.y)) / length : 0;
    // Clamp inside interior bones; the chain's two ends extend past their bones.
    const lo = k === 0 ? -Infinity : 0;
    const hi = k === chain.bones.length - 1 ? Infinity : length;
    axial[i] = (starts[k] as number) + Math.max(lo, Math.min(hi, t));
  }

  // Joint bands.
  const band = (k: number) => {
    // Band around the joint between chain bone k and k + 1.
    const a = chain.bones[k] as WeightBone;
    const b = chain.bones[k + 1] as WeightBone;
    return Math.min((a.radius + b.radius) / 2, 0.4 * Math.min(lengths[k] as number, lengths[k + 1] as number));
  };
  const cutDistance = (i: number) => (anchor ? segmentDistance(px(i), py(i), anchor.cut.a, anchor.cut.b) : Infinity);
  const rootBand = anchor ? Math.min(chain.bones[0]?.radius ?? 0, 0.6 * (lengths[0] as number)) : 0;

  for (let i = 0; i < n; i++) {
    const dc = cutDistance(i);
    if (dc <= pinDepth) {
      constrained[i] = 0;
      kinds[i] = "pinned";
      continue;
    }
    if (dc < pinDepth + rootBand) continue;
    const s = axial[i] as number;
    for (let k = 0; k < chain.bones.length; k++) {
      const from = k === 0 ? -Infinity : (starts[k] as number) + band(k - 1);
      const to = k === chain.bones.length - 1 ? Infinity : (starts[k] as number) + (lengths[k] as number) - band(k);
      if (s >= from && s <= to) {
        constrained[i] = chainOffset + k;
        kinds[i] = "rigid";
      }
    }
  }

  const neighbours = adjacency(n, mesh.triangles);
  // Every chain bone keeps at least the ring nearest its middle.
  const spacing = meanEdgeLength(mesh, neighbours);
  chain.bones.forEach((_, k) => {
    const middle = (starts[k] as number) + (lengths[k] as number) / 2;
    let closest = Infinity;
    for (let i = 0; i < n; i++) if (kinds[i] !== "pinned") closest = Math.min(closest, Math.abs((axial[i] as number) - middle));
    for (let i = 0; i < n; i++) {
      if (kinds[i] === "pinned") continue;
      if (Math.abs((axial[i] as number) - middle) <= closest + spacing * 0.25) {
        constrained[i] = chainOffset + k;
        kinds[i] = "rigid";
      }
    }
  });

  // Heat solve over the free vertices.
  const weights: Float64Array[] = bones.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) if ((constrained[i] as number) >= 0) (weights[constrained[i] as number] as Float64Array)[i] = 1;
  const free: number[] = [];
  for (let i = 0; i < n; i++) if ((constrained[i] as number) < 0) free.push(i);
  if (free.length > 0) {
    const { stiffness, area } = cotanSystem(mesh);
    const nearest = new Int32Array(n);
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      bones.forEach((bone, j) => {
        const d = segmentDistance(px(i), py(i), bone.start, bone.end);
        if (d < best) {
          best = d;
          nearest[i] = j;
        }
      });
      h[i] = ((area[i] as number) * heat) / Math.max(1, best) ** 2;
    }
    const m = free.length;
    const a = new Float64Array(m * m);
    for (let r = 0; r < m; r++) {
      const v = free[r] as number;
      for (let c = 0; c < m; c++) a[r * m + c] = stiffness[v * n + (free[c] as number)] as number;
      a[r * m + r] = (a[r * m + r] as number) + (h[v] as number);
    }
    const factor = cholesky(a, m);
    for (let j = 0; j < bones.length; j++) {
      const rhs = new Float64Array(m);
      for (let r = 0; r < m; r++) {
        const v = free[r] as number;
        let value = nearest[v] === j ? (h[v] as number) : 0;
        for (let u = 0; u < n; u++) {
          if ((constrained[u] as number) === j) value -= stiffness[v * n + u] as number;
        }
        rhs[r] = value;
      }
      const solution = choleskySolve(factor, m, rhs);
      for (let r = 0; r < m; r++) (weights[j] as Float64Array)[free[r] as number] = solution[r] as number;
    }
  }

  const clamped = clampStats(weights, n);
  let result = finalize(weights, n, maxInfluences, minWeight);
  for (let pass = 0; pass < (options.smooth ?? 1); pass++) {
    result = smoothWeights(result, neighbours, (i) => (constrained[i] as number) < 0, bones.length);
    result = pruneWeights(result, maxInfluences, minWeight);
  }
  return { bones, weights: result, kinds, clamped };
}

/**
 * A branched part: a bone TREE, parents before children, `parent` indexing this list
 * (-1 for the single trunk root). A quadruped body with a neck, a tail and four legs, a torso with two
 * clavicles and a head: each branch is its own chain hung from an explicit bone of another chain.
 */
export interface WeightTreeBone extends WeightBone {
  parent: number;
  /**
   * Domain reach (px, optional): past it the bone's domain distance grows four times as fast, so
   * a short side branch does not own far vertices of a wide body that a trunk bone should take
   * (weights.auto sets it to the side chain's length; the trunk has none).
   */
  reach?: number;
}

export interface WeightTree {
  bones: readonly WeightTreeBone[];
  anchor?: WeightChain["anchor"];
}

/** The chain form of a tree when it is one (every bone's parent is the previous bone). */
function treeAsChain(tree: WeightTree): WeightChain | undefined {
  if (!tree.bones.every((bone, k) => bone.parent === k - 1)) return undefined;
  return { bones: tree.bones.map(({ name, start, end, radius }) => ({ name, start, end, radius })), ...(tree.anchor ? { anchor: tree.anchor } : {}) };
}

/** Checks the tree's shape: parents listed first, exactly one root. Throws a message naming the bone. */
export function checkWeightTree(tree: WeightTree): void {
  if (tree.bones.length === 0) throw new Error("auto-weights: the tree has no bones");
  const roots = tree.bones.filter((bone) => bone.parent === -1);
  if (roots.length !== 1) {
    throw new Error(`auto-weights: the tree needs exactly one root bone (parent -1), found ${roots.length}: ${roots.map((b) => b.name).join(", ") || "none"}`);
  }
  tree.bones.forEach((bone, k) => {
    if (bone.parent !== -1 && !(Number.isInteger(bone.parent) && bone.parent >= 0 && bone.parent < k)) {
      throw new Error(`auto-weights: bone '${bone.name}' has parent ${bone.parent}; a parent must be listed before its children`);
    }
  });
}

/**
 * Heat weights over a bone tree. A simple chain gives exactly `autoWeights`. For a
 * branched tree every vertex belongs to the domain of its nearest bone and may blend only with
 * that bone's parent and its nearest child, when their shared joint is within reach, so weight
 * never bleeds from one branch into another except around the joint they share. Joint hygiene
 * follows the chain rules per joint: a band of min(mean radius, 40% of the shorter bone) measured
 * along each bone's own axis (and inside a disk around the joint, so a leg hung from the side of a
 * long body bone frees only the body vertices near it), rigid cores elsewhere, the ring nearest
 * each bone's middle always rigid, and the anchor's pinned ring.
 *
 * `ambiguous` counts vertices whose two nearest bones are in different, non-adjacent branches at
 * nearly the same distance (ratio under 1.15): where one mesh holds two branches that touch
 * (overlapping legs) the domain split is a guess, and the part should be split into meshes.
 */
export function autoWeightsTree(mesh: MeshForWeights, tree: WeightTree, options: TreeWeightOptions = {}): WeightResult & { ambiguous: number; domains: Int32Array; diagnostics: WeightDiagnostics } {
  checkWeightTree(tree);
  const n = mesh.points.length / 2;
  const anchor = tree.anchor;
  const offset = anchor ? 1 : 0;
  const connections = options.connections ?? [];
  // Plan: the domain's allowed set, checked once; an empty domain is an error, never a guess.
  const allowedBone = (k: number) => !options.allow || options.allow(k);
  if (!tree.bones.some((_, k) => allowedBone(k))) throw new Error(`auto-weights: the deformation domain allows none of the tree's bones (${tree.bones.map((b) => b.name).join(", ")})`);
  const anchorEligible = anchor !== undefined && options.allowAnchor !== false;
  const asChain = !options.allow && !options.jointWidth && options.allowAnchor !== false && connections.every((c) => c.kind === "welded") ? treeAsChain(tree) : null;
  if (asChain) {
    const result = autoWeights(mesh, asChain, options);
    const domains = new Int32Array(n);
    for (let i = 0; i < n; i++) domains[i] = Math.max(0, (result.weights[i]?.[0]?.bone ?? offset) - offset);
    return { ...result, ambiguous: 0, domains, diagnostics: { ...emptyDiagnostics(), clamped: result.clamped ?? emptyDiagnostics().clamped } };
  }
  const maxInfluences = options.maxInfluences ?? 4;
  const minWeight = options.minWeight ?? 0.02;
  const pinDepth = options.pinDepth ?? 10;
  const heat = options.heat ?? 0.2;
  const treeBones = tree.bones;
  const bones: WeightBone[] = anchor ? [anchor.bone, ...treeBones] : [...treeBones];
  const px = (i: number) => mesh.points[i * 2] as number;
  const py = (i: number) => mesh.points[i * 2 + 1] as number;
  const tb = (k: number) => treeBones[k] as WeightTreeBone;
  const lengths = treeBones.map((b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y));
  const children: number[][] = treeBones.map(() => []);
  treeBones.forEach((bone, k) => {
    if (bone.parent >= 0) (children[bone.parent] as number[]).push(k);
  });
  // Joint k: where bone k meets its parent, at bone k's start.
  const jointBand = (k: number) => options.jointWidth?.get(k) ?? Math.min((tb(k).radius + tb(tb(k).parent).radius) / 2, 0.4 * Math.min(lengths[k] as number, lengths[tb(k).parent] as number));
  const jointReach = (k: number) => jointBand(k) + Math.max(tb(k).radius, tb(tb(k).parent).radius);
  const projectXY = (x: number, y: number, k: number) => {
    const bone = tb(k);
    const length = lengths[k] as number;
    return length > 0 ? ((x - bone.start.x) * (bone.end.x - bone.start.x) + (y - bone.start.y) * (bone.end.y - bone.start.y)) / length : 0;
  };
  const project = (i: number, k: number) => projectXY(px(i), py(i), k);
  // The joints touching bone k: its own start (with its parent) and each child's start.
  const jointsOf = (k: number) => [...(children[k] as number[]), ...(tb(k).parent >= 0 ? [k] : [])];
  const inJointBand = (i: number, k: number, joint: number) => {
    const at = tb(joint).start;
    const band = jointBand(joint);
    if (Math.hypot(px(i) - at.x, py(i) - at.y) > 2 * Math.max(band, tb(k).radius)) return false;
    return Math.abs(project(i, k) - projectXY(at.x, at.y, k)) < band;
  };
  // Parent and child are adjacent everywhere. Siblings (two legs off one hub) are adjacent only
  // around the joints they hang from (both starts within reach): away from the hub two siblings
  // near each other are two overlapping branches, and the split between them is a guess.
  // Connections between bone sets (authoring): membrane pairs may blend anywhere, overlap pairs never.
  const across = (kind: ConnectionKind, a: number, b: number) => connections.some((c) => c.kind === kind && ((c.a.includes(a) && c.b.includes(b)) || (c.a.includes(b) && c.b.includes(a))));
  const membrane = (a: number, b: number) => across("membrane", a, b);
  const forbidden = (a: number, b: number) => across("overlap", a, b);
  // Membrane partners of vertex i's domain bone k within reach of the vertex.
  const membraneNear = (i: number, k: number) =>
    treeBones
      .map((_, p) => p)
      .filter((p) => p !== k && allowed(i, p) && membrane(k, p) && segmentDistance(px(i), py(i), tb(p).start, tb(p).end) <= segmentDistance(px(i), py(i), tb(k).start, tb(k).end) + Math.max(tb(k).radius, tb(p).radius));
  const adjacent = (i: number, a: number, b: number) => {
    if (membrane(a, b)) return true;
    if (a === b || tb(a).parent === b || tb(b).parent === a) return true;
    if (tb(a).parent < 0 || tb(a).parent !== tb(b).parent) return false;
    const near = (k: number) => Math.hypot(px(i) - tb(k).start.x, py(i) - tb(k).start.y) <= jointReach(k);
    return near(a) && near(b);
  };

  // Domains (nearest tree bone) and the ambiguity count. Order-independent: bones at
  // the same distance (siblings sharing a start, a vertex on a hub) are a tie, resolved by the
  // hierarchy (a tied bone that is an ancestor of every other tied bone owns the vertex), else by
  // bone name, never by list order; tied bones also share the vertex's heat source below.
  const isAncestor = (a: number, b: number) => {
    for (let at = tb(b).parent; at >= 0; at = tb(at).parent) if (at === a) return true;
    return false;
  };
  const byName = (a: number, b: number) => (tb(a).name < tb(b).name ? -1 : tb(a).name > tb(b).name ? 1 : 0);
  const domains = new Int32Array(n);
  const ambiguities: Ambiguity[] = [];
  const distance = new Float64Array(treeBones.length);
  const allowed = (_i: number, k: number) => allowedBone(k);
  const byDistance = (a: number, b: number) => {
    const da = distance[a] as number;
    const db = distance[b] as number;
    return Math.abs(da - db) <= tieTolerance(Math.max(da, db)) ? byName(a, b) : da - db;
  };
  // Domain distance is along the mesh (geodesicBoneDistances), so a branch never owns vertices it
  // reaches only by a straight line across a gap in the art.
  const geodesic = geodesicBoneDistances(mesh, treeBones, allowedBone);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    treeBones.forEach((_, k) => {
      const d = (geodesic[k] as Float64Array)[i] as number;
      const reach = tb(k).reach;
      distance[k] = !allowed(i, k) ? Infinity : reach !== undefined && d > reach ? reach + 4 * (d - reach) : d;
      best = Math.min(best, distance[k] as number);
    });
    const tied: number[] = [];
    treeBones.forEach((_, k) => {
      if ((distance[k] as number) <= best + tieTolerance(best)) tied.push(k);
    });
    tied.sort(byName);
    const owner = tied.find((a) => tied.every((b) => b === a || isAncestor(a, b))) ?? (tied[0] as number);
    domains[i] = owner;
    // Competitors by (distance, name), never by list order: every bone within the
    // ratio that is not adjacent to the user, so an adjacent runner-up (the user's own child at
    // the joint) does not hide a third, non-adjacent branch just behind it. Top three reported.
    const competitors = treeBones
      .map((_, k) => k)
      .filter((k) => k !== owner && Number.isFinite(distance[k] as number) && (distance[k] as number) < 1.15 * Math.max(best, 1) && !adjacent(i, owner, k))
      .sort(byDistance)
      .slice(0, 3);
    if (competitors.length > 0) ambiguities.push({ vertex: i, owner, competitors: competitors.map((k) => ({ bone: k, distance: distance[k] as number })) });
  }
  const ambiguous = ambiguities.length;

  const constrained = new Int32Array(n).fill(-1);
  const kinds: WeightResult["kinds"] = new Array(n).fill("free");
  const rootBone = treeBones.findIndex((b) => b.parent === -1);
  const rootBand = anchor ? Math.min(tb(rootBone).radius, 0.6 * (lengths[rootBone] as number)) : 0;
  for (let i = 0; i < n; i++) {
    const dc = anchor && anchorEligible ? segmentDistance(px(i), py(i), anchor.cut.a, anchor.cut.b) : Infinity;
    if (dc <= pinDepth) {
      constrained[i] = 0;
      kinds[i] = "pinned";
      continue;
    }
    if (dc < pinDepth + rootBand) continue;
    const k = domains[i] as number;
    if (jointsOf(k).some((joint) => inJointBand(i, k, joint))) continue;
    if (membraneNear(i, k).length > 0) continue;
    constrained[i] = offset + k;
    kinds[i] = "rigid";
  }

  const neighbours = adjacency(n, mesh.triangles);
  const spacing = meanEdgeLength(mesh, neighbours);
  treeBones.forEach((_, k) => {
    const middle = (lengths[k] as number) / 2;
    let closest = Infinity;
    for (let i = 0; i < n; i++) if (kinds[i] !== "pinned" && domains[i] === k) closest = Math.min(closest, Math.abs(project(i, k) - middle));
    for (let i = 0; i < n; i++) {
      if (kinds[i] === "pinned" || domains[i] !== k) continue;
      if (membraneNear(i, k).length > 0) continue;
      if (Math.abs(project(i, k) - middle) <= closest + spacing * 0.25) {
        constrained[i] = offset + k;
        kinds[i] = "rigid";
      }
    }
  });

  // Allowed bones per vertex (indices into `bones`): its domain, the tree neighbours whose shared
  // joint is within reach, and the anchor around the root.
  const masks: Set<number>[] = [];
  for (let i = 0; i < n; i++) {
    if ((constrained[i] as number) >= 0) {
      masks.push(new Set([constrained[i] as number]));
      continue;
    }
    const k = domains[i] as number;
    const set = new Set<number>([offset + k]);
    const near = (joint: number) => Math.hypot(px(i) - tb(joint).start.x, py(i) - tb(joint).start.y) <= jointReach(joint);
    if (tb(k).parent >= 0 && near(k)) set.add(offset + tb(k).parent);
    // Of the children, the one nearest by segment evidence (the distance to the child bone
    // itself): two branches leaving the same bone (a neck and a foreleg off the chest) each own the
    // parent's vertices around their own joint. Children at the same distance (coincident starts,
    // a vertex on the hub) all stay allowed: a tie is shared, never given to the first listed.
    const reachable = (children[k] as number[]).filter((c) => near(c) && allowed(i, c));
    const childDistance = (c: number) => segmentDistance(px(i), py(i), tb(c).start, tb(c).end);
    const nearestChildDistance = Math.min(...reachable.map(childDistance));
    for (const c of reachable) if (childDistance(c) <= nearestChildDistance + tieTolerance(nearestChildDistance)) set.add(offset + c);
    for (const p of membraneNear(i, k)) set.add(offset + p);
    if (anchorEligible && k === rootBone) set.add(0);
    // Plan: every mask is intersected with the domain's allowed set (a parent added for
    // joint reach is still only a candidate), then candidate-versus-candidate overlap conflicts are
    // resolved before the solve: candidates in order (domain bone first, then by distance and name)
    // are admitted only when no admitted bone forbids them, so no vertex carries both sides of an
    // overlap connection.
    const dist = (j: number) => segmentDistance(px(i), py(i), (bones[j] as WeightBone).start, (bones[j] as WeightBone).end);
    const ranked = [...set]
      .filter((j) => (j < offset ? anchorEligible : allowedBone(j - offset)))
      .sort((a, b) => {
        if (a === offset + k || b === offset + k) return a === offset + k ? -1 : 1;
        const da = dist(a);
        const db = dist(b);
        if (Math.abs(da - db) > tieTolerance(Math.max(da, db))) return da - db;
        const na = (bones[a] as WeightBone).name;
        const nb = (bones[b] as WeightBone).name;
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
    const admitted = new Set<number>();
    for (const j of ranked) {
      if (j >= offset && [...admitted].some((a) => a >= offset && a !== j && forbidden(a - offset, j - offset))) continue;
      admitted.add(j);
    }
    masks.push(admitted);
  }

  const weights: Float64Array[] = bones.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) if ((constrained[i] as number) >= 0) (weights[constrained[i] as number] as Float64Array)[i] = 1;
  const free: number[] = [];
  for (let i = 0; i < n; i++) if ((constrained[i] as number) < 0) free.push(i);
  if (free.length > 0) {
    const { stiffness, area } = cotanSystem(mesh);
    // Heat source per vertex: its nearest allowed bone; bones tied for nearest share it equally.
    const nearest: number[][] = [];
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      const at = new Map<number, number>();
      for (const j of masks[i] as Set<number>) {
        const bone = bones[j] as WeightBone;
        const d = segmentDistance(px(i), py(i), bone.start, bone.end);
        at.set(j, d);
        best = Math.min(best, d);
      }
      nearest.push([...at].filter(([, d]) => d <= best + tieTolerance(best)).map(([j]) => j));
      h[i] = ((area[i] as number) * heat) / Math.max(1, best) ** 2;
    }
    // Forbidden influences are enforced inside the solve: bone j's heat equation is
    // solved only over the free vertices whose mask allows j; every other vertex is a boundary
    // value (1 where rigid on j, else 0), so weight never diffuses into a vertex that may not
    // carry it and the masking below removes nothing the solve produced. One factorization per
    // distinct free set.
    const factors = new Map<string, Float64Array>();
    for (let j = 0; j < bones.length; j++) {
      const freeJ = free.filter((v) => (masks[v] as Set<number>).has(j));
      const m = freeJ.length;
      if (m === 0) continue;
      const key = freeJ.join(",");
      let factor = factors.get(key);
      if (!factor) {
        const a = new Float64Array(m * m);
        for (let r = 0; r < m; r++) {
          const v = freeJ[r] as number;
          for (let c = 0; c < m; c++) a[r * m + c] = stiffness[v * n + (freeJ[c] as number)] as number;
          a[r * m + r] = (a[r * m + r] as number) + (h[v] as number);
        }
        factor = cholesky(a, m);
        factors.set(key, factor);
      }
      const rhs = new Float64Array(m);
      for (let r = 0; r < m; r++) {
        const v = freeJ[r] as number;
        const sources = nearest[v] as number[];
        let value = sources.includes(j) ? (h[v] as number) / sources.length : 0;
        for (const u of neighbours[v] as Set<number>) if ((constrained[u] as number) === j) value -= stiffness[v * n + u] as number;
        rhs[r] = value;
      }
      const solution = choleskySolve(factor, m, rhs);
      for (let r = 0; r < m; r++) (weights[j] as Float64Array)[freeJ[r] as number] = solution[r] as number;
    }
  }
  // Branch domains: drop every bone outside the vertex's mask, before and after smoothing; a
  // vertex left with nothing falls back to its domain bone.
  const masked = (list: Influence[][]) =>
    list.map((influences, i) => {
      const kept = influences.filter((inf) => inf.weight > 0 && (masks[i] as Set<number>).has(inf.bone));
      return kept.length > 0 ? kept : [{ bone: offset + (domains[i] as number), weight: 1 }];
    });
  const clamped = clampStats(weights, n);
  const raw: Influence[][] = [];
  for (let i = 0; i < n; i++) raw.push(weights.map((w, bone) => ({ bone, weight: Math.max(0, Math.min(1, w[i] as number)) })));
  const pruning = new PruneStats(bones, mesh.points, options.hubErrorPx ?? 1);
  let result = pruneByName(masked(raw), bones, maxInfluences, minWeight, pruning);
  for (let pass = 0; pass < (options.smooth ?? 1); pass++) {
    // Smoothing never imports a forbidden influence: it reads only the vertex's mask.
    result = smoothWeights(result, neighbours, (i) => (constrained[i] as number) < 0, bones.length, (i, bone) => (masks[i] as Set<number>).has(bone));
    result = pruneByName(masked(result), bones, maxInfluences, minWeight, pruning);
  }
  const diagnostics: WeightDiagnostics = { ambiguities, clamped, pruning: pruning.summary() };
  if (options.hubPolicy === "reject" && diagnostics.pruning.overVertices.length > 0) {
    throw new Error(
      `auto-weights: ${diagnostics.pruning.overVertices.length} vertices need more than ${maxInfluences} influences (worst: vertex ${diagnostics.pruning.worstVertex}, ${diagnostics.pruning.maxErrorPx.toFixed(2)} px posed error); split the hub or give it a hub bone`
    );
  }
  return { bones, weights: result, kinds, ambiguous, domains, diagnostics };
}

/**
 * Along-mesh distance from every vertex to every bone (second rig acceptance; Baran and Popovic's
 * visibility rule). A vertex whose straight segment to its closest point on bone k stays inside
 * the mesh (it leaves the vertex into the mesh and crosses no boundary edge) is seeded with that
 * straight distance; every other vertex gets the shortest path along mesh edges to a seeded one.
 * So a curled tail no longer owns body-edge vertices across the gap: the straight line to the tail
 * leaves the mesh, and the path along the mesh goes round through the body. On a convex mesh every
 * vertex is visible and this is the straight-line distance (the triangle inequality keeps the
 * relaxation from improving a seed). A bone that sees no vertex (it lies outside the mesh) keeps
 * the straight-line distance everywhere. `allowed(k)` false gives Infinity for that bone.
 */
export function geodesicBoneDistances(mesh: MeshForWeights, bones: readonly { start: Point; end: Point }[], allowed: (k: number) => boolean = () => true): Float64Array[] {
  const n = mesh.points.length / 2;
  const px = (i: number) => mesh.points[i * 2] as number;
  const py = (i: number) => mesh.points[i * 2 + 1] as number;
  const tris = mesh.triangles;
  const edgeCount = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const incident: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const tri = [tris[t] as number, tris[t + 1] as number, tris[t + 2] as number];
    for (let e = 0; e < 3; e++) {
      const k = key(tri[e] as number, tri[(e + 1) % 3] as number);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      (incident[tri[e] as number] as number[]).push(t);
    }
  }
  const boundary: [number, number][] = [];
  const onBoundary = new Uint8Array(n);
  for (const [k, count] of edgeCount) {
    if (count !== 1) continue;
    const a = Math.floor(k / n);
    const b = k % n;
    boundary.push([a, b]);
    onBoundary[a] = 1;
    onBoundary[b] = 1;
  }
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  // Direction (dx, dy) from vertex i enters the mesh: it lies in the wedge of an incident triangle.
  const entersMesh = (i: number, dx: number, dy: number) => {
    if (!onBoundary[i]) return true;
    for (const t of incident[i] as number[]) {
      const tri = [tris[t] as number, tris[t + 1] as number, tris[t + 2] as number];
      const at = tri.indexOf(i);
      const a = tri[(at + 1) % 3] as number;
      const b = tri[(at + 2) % 3] as number;
      const ax = px(a) - px(i);
      const ay = py(a) - py(i);
      const bx = px(b) - px(i);
      const by = py(b) - py(i);
      const s = Math.sign(cross(ax, ay, bx, by)) || 1;
      const eps = -1e-9 * Math.hypot(dx, dy) * Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      if (s * cross(ax, ay, dx, dy) >= eps && s * cross(dx, dy, bx, by) >= eps) return true;
    }
    return false;
  };
  // Proper crossing of segment p-q with a boundary edge not touching vertex i.
  const crossesBoundary = (i: number, qx: number, qy: number) => {
    const ix = px(i);
    const iy = py(i);
    for (const [a, b] of boundary) {
      if (a === i || b === i) continue;
      const ax = px(a);
      const ay = py(a);
      const bx = px(b);
      const by = py(b);
      const d1 = cross(bx - ax, by - ay, ix - ax, iy - ay);
      const d2 = cross(bx - ax, by - ay, qx - ax, qy - ay);
      const d3 = cross(qx - ix, qy - iy, ax - ix, ay - iy);
      const d4 = cross(qx - ix, qy - iy, bx - ix, by - iy);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
    // A segment through a boundary vertex (grid-aligned art) crosses no edge properly: it stays
    // inside only when both of its directions at that vertex enter the mesh.
    const lx = qx - ix;
    const ly = qy - iy;
    const ll = lx * lx + ly * ly;
    if (ll === 0) return false;
    for (let v = 0; v < n; v++) {
      if (!onBoundary[v] || v === i) continue;
      const t = ((px(v) - ix) * lx + (py(v) - iy) * ly) / ll;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      if (Math.abs(cross(lx, ly, px(v) - ix, py(v) - iy)) > 1e-7 * ll) continue;
      if (!entersMesh(v, lx, ly) || !entersMesh(v, -lx, -ly)) return true;
    }
    return false;
  };
  const neighbours = adjacency(n, tris);
  return bones.map((bone, k) => {
    const out = new Float64Array(n).fill(Infinity);
    if (!allowed(k)) return out;
    const dx = bone.end.x - bone.start.x;
    const dy = bone.end.y - bone.start.y;
    const ls = dx * dx + dy * dy;
    const done = new Uint8Array(n);
    let seeded = 0;
    for (let i = 0; i < n; i++) {
      const t = ls > 0 ? Math.max(0, Math.min(1, ((px(i) - bone.start.x) * dx + (py(i) - bone.start.y) * dy) / ls)) : 0;
      const qx = bone.start.x + t * dx;
      const qy = bone.start.y + t * dy;
      const d = Math.hypot(qx - px(i), qy - py(i));
      if (d < 1e-9 || (entersMesh(i, qx - px(i), qy - py(i)) && !crossesBoundary(i, qx, qy))) {
        out[i] = d;
        seeded++;
      }
    }
    if (seeded === 0) {
      for (let i = 0; i < n; i++) out[i] = segmentDistance(px(i), py(i), bone.start, bone.end);
      return out;
    }
    // Dijkstra along mesh edges (O(n^2), meshes are a few hundred vertices).
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && Number.isFinite(out[i] as number) && (u < 0 || (out[i] as number) < (out[u] as number))) u = i;
      if (u < 0) break;
      done[u] = 1;
      for (const v of neighbours[u] as Set<number>) {
        const via = (out[u] as number) + Math.hypot(px(v) - px(u), py(v) - py(u));
        if (via < (out[v] as number)) out[v] = via;
      }
    }
    // Vertices in no triangle reachable from a seed keep the straight-line distance.
    for (let i = 0; i < n; i++) if (!Number.isFinite(out[i] as number)) out[i] = segmentDistance(px(i), py(i), bone.start, bone.end);
    return out;
  });
}

/** Distances closer than this are a tie (relative, with a floor for points on a bone). */
function tieTolerance(distance: number): number {
  return Number.isFinite(distance) ? 1e-6 * Math.max(1, distance) : 0;
}

/** The displacement of (x, y) rotated by `angle` about `pivot`. */
function rotationDisplacement(x: number, y: number, pivot: Point, angle: number): { x: number; y: number } {
  const dx = x - pivot.x;
  const dy = y - pivot.y;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: dx * c - dy * s - dx, y: dx * s + dy * c - dy };
}

/**
 * Pruning cost per vertex: the dropped mass, and the posed displacement between the
 * dense and the pruned weights over probe poses (each bone alone rotated 30 degrees about its start,
 * and every bone rotated with alternating sign by name rank).
 */
export class PruneStats {
  private readonly error = new Map<number, number>();
  private maxDiscarded = 0;
  private readonly sign: number[];
  constructor(
    private readonly bones: readonly WeightBone[],
    private readonly points: ArrayLike<number>,
    private readonly limitPx: number
  ) {
    const rank = bones.map((_, j) => j).sort((a, b) => ((bones[a] as WeightBone).name < (bones[b] as WeightBone).name ? -1 : (bones[a] as WeightBone).name > (bones[b] as WeightBone).name ? 1 : 0));
    this.sign = bones.map(() => 1);
    rank.forEach((j, r) => (this.sign[j] = r % 2 === 0 ? 1 : -1));
  }
  record(vertex: number, dense: readonly Influence[], kept: readonly Influence[], discarded: number): void {
    this.maxDiscarded = Math.max(this.maxDiscarded, discarded);
    if (discarded <= 1e-9) return;
    const x = this.points[vertex * 2] as number;
    const y = this.points[vertex * 2 + 1] as number;
    const delta = new Map<number, number>();
    for (const inf of dense) delta.set(inf.bone, (delta.get(inf.bone) ?? 0) + inf.weight);
    for (const inf of kept) delta.set(inf.bone, (delta.get(inf.bone) ?? 0) - inf.weight);
    let worst = 0;
    let sx = 0;
    let sy = 0;
    const angle = Math.PI / 6;
    for (const [bone, dw] of delta) {
      const at = (this.bones[bone] as WeightBone).start;
      const single = rotationDisplacement(x, y, at, angle);
      worst = Math.max(worst, Math.abs(dw) * Math.hypot(single.x, single.y));
      const spread = rotationDisplacement(x, y, at, angle * (this.sign[bone] as number));
      sx += dw * spread.x;
      sy += dw * spread.y;
    }
    worst = Math.max(worst, Math.hypot(sx, sy));
    this.error.set(vertex, Math.max(this.error.get(vertex) ?? 0, worst));
  }
  summary(): WeightDiagnostics["pruning"] {
    let maxErrorPx = 0;
    let worstVertex = -1;
    const overVertices: number[] = [];
    for (const [vertex, e] of [...this.error].sort((a, b) => a[0] - b[0])) {
      if (e > maxErrorPx) {
        maxErrorPx = e;
        worstVertex = vertex;
      }
      if (e > this.limitPx) overVertices.push(vertex);
    }
    return { maxDiscarded: this.maxDiscarded, maxErrorPx, worstVertex, overVertices };
  }
}

/**
 * `pruneWeights` without any dependence on bone list order: normalise first, keep the
 * largest `maxInfluences` by (weight, bone name) (a tie straddling the cap is cut by name, never
 * collapsed into one rigid weight), drop weights under the relative threshold `minWeight` of the
 * vertex's total, renormalise. The dropped mass and posed error go to `stats`.
 */
export function pruneByName(weights: readonly Influence[][], bones: readonly { name: string }[], maxInfluences: number, minWeight: number, stats?: PruneStats): Influence[][] {
  const key = (bone: number) => bones[bone]?.name ?? "";
  return weights.map((list, vertex) => {
    const positive = list.filter((inf) => inf.weight > 0);
    const total = positive.reduce((sum, inf) => sum + inf.weight, 0);
    if (!(total > 0)) throw new Error("prune: a vertex has no weight at all");
    const dense = positive.map((inf) => ({ bone: inf.bone, weight: inf.weight / total }));
    const sorted = [...dense].sort((a, b) => b.weight - a.weight || (key(a.bone) < key(b.bone) ? -1 : key(a.bone) > key(b.bone) ? 1 : 0));
    let kept = sorted.slice(0, maxInfluences).filter((inf) => inf.weight >= minWeight);
    if (kept.length === 0) kept = sorted.slice(0, 1);
    const keptMass = kept.reduce((sum, inf) => sum + inf.weight, 0);
    const result = normalizeInfluences(kept);
    stats?.record(vertex, dense, result, 1 - keptMass);
    return result;
  });
}

function finalize(weights: Float64Array[], n: number, maxInfluences: number, minWeight: number): Influence[][] {
  const out: Influence[][] = [];
  for (let i = 0; i < n; i++) {
    const list: Influence[] = [];
    weights.forEach((w, bone) => list.push({ bone, weight: Math.max(0, Math.min(1, w[i] as number)) }));
    out.push(list);
  }
  return pruneWeights(out, maxInfluences, minWeight);
}

/**
 * Weights at a point inside a weighted mesh: the barycentric blend of the containing triangle's
 * vertex weights (the nearest vertex's weights when the point is outside every triangle).
 */
export function weightsAtPoint(mesh: MeshForWeights, weights: readonly Influence[][], x: number, y: number): Influence[] {
  const p = mesh.points;
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t] as number, mesh.triangles[t + 1] as number, mesh.triangles[t + 2] as number];
    const ax = p[a * 2] as number;
    const ay = p[a * 2 + 1] as number;
    const bx = p[b * 2] as number;
    const by = p[b * 2 + 1] as number;
    const cx = p[c * 2] as number;
    const cy = p[c * 2 + 1] as number;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const wa = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
    const wb = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    const sum = new Map<number, number>();
    for (const [vertex, w] of [[a, wa], [b, wb], [c, wc]] as const) {
      for (const inf of weights[vertex] ?? []) sum.set(inf.bone, (sum.get(inf.bone) ?? 0) + inf.weight * w);
    }
    return pruneWeights([[...sum].map(([bone, weight]) => ({ bone, weight }))])[0] as Influence[];
  }
  let nearest = 0;
  let best = Infinity;
  for (let v = 0; v < p.length / 2; v++) {
    const d = Math.hypot((p[v * 2] as number) - x, (p[v * 2 + 1] as number) - y);
    if (d < best) {
      best = d;
      nearest = v;
    }
  }
  return (weights[nearest] ?? []).map((inf) => ({ ...inf }));
}

/** Keeps the largest `maxInfluences` weights at or above `minWeight` and normalises to 1. */
export function pruneWeights(weights: readonly Influence[][], maxInfluences = 4, minWeight = 0.02): Influence[][] {
  return weights.map((list) => {
    const sorted = list.filter((inf) => inf.weight > 0).sort((a, b) => b.weight - a.weight || a.bone - b.bone);
    let kept = sorted.slice(0, maxInfluences).filter((inf) => inf.weight >= minWeight);
    if (kept.length === 0) kept = sorted.slice(0, 1);
    if (kept.length === 0) throw new Error("prune: a vertex has no weight at all");
    return normalizeInfluences(kept);
  });
}

/** Scales influences to sum to 1 (and rounds to 1e-5, fixing the rounding on the largest). */
export function normalizeInfluences(list: readonly Influence[]): Influence[] {
  const sum = list.reduce((s, inf) => s + inf.weight, 0);
  const out = list.map((inf) => ({ bone: inf.bone, weight: Math.round((inf.weight / sum) * 1e5) / 1e5 })).filter((inf) => inf.weight > 0);
  const total = out.reduce((s, inf) => s + inf.weight, 0);
  (out[0] as Influence).weight = Math.round(((out[0] as Influence).weight + 1 - total) * 1e5) / 1e5;
  return out;
}

/**
 * One smoothing pass: each selected vertex moves halfway to the average of its neighbours'
 * weights (per bone). Unselected vertices are unchanged.
 */
export function smoothWeights(
  weights: readonly Influence[][],
  neighbours: readonly Set<number>[],
  selected: (vertex: number) => boolean,
  boneCount: number,
  /** Plan: bones vertex `i` may carry; others are never imported from its neighbours. */
  allow?: (vertex: number, bone: number) => boolean
): Influence[][] {
  const dense = (list: readonly Influence[]) => {
    const out = new Float64Array(boneCount);
    for (const inf of list) out[inf.bone] = inf.weight;
    return out;
  };
  return weights.map((list, i) => {
    if (!selected(i) || (neighbours[i]?.size ?? 0) === 0) return list.map((inf) => ({ ...inf }));
    const own = dense(list);
    const average = new Float64Array(boneCount);
    for (const j of neighbours[i] as Set<number>) {
      const other = dense(weights[j] as Influence[]);
      for (let b = 0; b < boneCount; b++) average[b] = (average[b] as number) + (other[b] as number);
    }
    const count = (neighbours[i] as Set<number>).size;
    const out: Influence[] = [];
    for (let b = 0; b < boneCount; b++) {
      if (allow && !allow(i, b)) continue;
      const w = 0.5 * (own[b] as number) + (0.5 * (average[b] as number)) / count;
      if (w > 0) out.push({ bone: b, weight: w });
    }
    return out;
  });
}

/**
 * Weld across meshes: vertices of different meshes within `tolerance` px of each other (by
 * canvas position) get the same weights, the average of the group, so a seam between two parts
 * deforms identically on both sides. Groups are the connected components of the "within
 * tolerance, different mesh" relation (union-find), so a pair that links two groups found
 * earlier merges them whole. Bone indices here are global (shared by all meshes).
 */
export function weldWeights(
  meshes: readonly { points: ArrayLike<number>; weights: Influence[][] }[],
  tolerance = 0.5,
  maxInfluences = 4
): number {
  const entries: { mesh: number; vertex: number; x: number; y: number }[] = [];
  meshes.forEach((mesh, m) => {
    for (let v = 0; v < mesh.points.length / 2; v++) entries.push({ mesh: m, vertex: v, x: mesh.points[v * 2] as number, y: mesh.points[v * 2 + 1] as number });
  });
  entries.sort((a, b) => a.x - b.x);
  const parent = Int32Array.from(entries, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[i] !== root) {
      const next = parent[i] as number;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const linked = new Uint8Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i] as (typeof entries)[number];
    for (let j = i + 1; j < entries.length && (entries[j] as (typeof entries)[number]).x - a.x <= tolerance; j++) {
      const b = entries[j] as (typeof entries)[number];
      if (b.mesh === a.mesh || Math.hypot(b.x - a.x, b.y - a.y) > tolerance) continue;
      linked[i] = 1;
      linked[j] = 1;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  const byRoot = new Map<number, (typeof entries)[number][]>();
  for (let i = 0; i < entries.length; i++) {
    if (!linked[i]) continue;
    const root = find(i);
    const members = byRoot.get(root);
    if (members) members.push(entries[i] as (typeof entries)[number]);
    else byRoot.set(root, [entries[i] as (typeof entries)[number]]);
  }
  let welded = 0;
  for (const members of byRoot.values()) {
    const sum = new Map<number, number>();
    for (const member of members) {
      for (const inf of (meshes[member.mesh] as (typeof meshes)[number]).weights[member.vertex] as Influence[]) {
        sum.set(inf.bone, (sum.get(inf.bone) ?? 0) + inf.weight / members.length);
      }
    }
    const merged = pruneWeights([[...sum].map(([bone, weight]) => ({ bone, weight }))], maxInfluences, 0)[0] as Influence[];
    for (const member of members) (meshes[member.mesh] as (typeof meshes)[number]).weights[member.vertex] = merged.map((inf) => ({ ...inf }));
    welded += members.length;
  }
  return welded;
}

// ---------------------------------------------------------------------------------------------
// Linear finite elements
// ---------------------------------------------------------------------------------------------

export function adjacency(n: number, triangles: ArrayLike<number>): Set<number>[] {
  const out = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    (out[a] as Set<number>).add(b).add(c);
    (out[b] as Set<number>).add(a).add(c);
    (out[c] as Set<number>).add(a).add(b);
  }
  return out;
}

function meanEdgeLength(mesh: MeshForWeights, neighbours: readonly Set<number>[]): number {
  let sum = 0;
  let count = 0;
  neighbours.forEach((set, i) => {
    for (const j of set) {
      if (j <= i) continue;
      sum += Math.hypot((mesh.points[j * 2] as number) - (mesh.points[i * 2] as number), (mesh.points[j * 2 + 1] as number) - (mesh.points[i * 2 + 1] as number));
      count++;
    }
  });
  return count > 0 ? sum / count : 1;
}

/** Dense cotangent stiffness matrix (n x n, row-major) and lumped vertex areas. */
export function cotanSystem(mesh: MeshForWeights): { stiffness: Float64Array; area: Float64Array } {
  const n = mesh.points.length / 2;
  const stiffness = new Float64Array(n * n);
  const area = new Float64Array(n);
  const p = mesh.points;
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const v = [mesh.triangles[t] as number, mesh.triangles[t + 1] as number, mesh.triangles[t + 2] as number];
    const doubleArea = Math.abs(
      ((p[(v[1] as number) * 2] as number) - (p[(v[0] as number) * 2] as number)) * ((p[(v[2] as number) * 2 + 1] as number) - (p[(v[0] as number) * 2 + 1] as number)) -
        ((p[(v[1] as number) * 2 + 1] as number) - (p[(v[0] as number) * 2 + 1] as number)) * ((p[(v[2] as number) * 2] as number) - (p[(v[0] as number) * 2] as number))
    );
    if (doubleArea < 1e-12) continue;
    for (let k = 0; k < 3; k++) {
      // Angle at vertex o, opposite edge (i, j).
      const o = v[k] as number;
      const i = v[(k + 1) % 3] as number;
      const j = v[(k + 2) % 3] as number;
      const ux = (p[i * 2] as number) - (p[o * 2] as number);
      const uy = (p[i * 2 + 1] as number) - (p[o * 2 + 1] as number);
      const wx = (p[j * 2] as number) - (p[o * 2] as number);
      const wy = (p[j * 2 + 1] as number) - (p[o * 2 + 1] as number);
      const cot = (ux * wx + uy * wy) / doubleArea;
      const value = cot / 2;
      stiffness[i * n + j] = (stiffness[i * n + j] as number) - value;
      stiffness[j * n + i] = (stiffness[j * n + i] as number) - value;
      stiffness[i * n + i] = (stiffness[i * n + i] as number) + value;
      stiffness[j * n + j] = (stiffness[j * n + j] as number) + value;
      area[o] = (area[o] as number) + doubleArea / 6;
    }
  }
  return { stiffness, area };
}

/** Cholesky factor (lower triangle, row-major) of a symmetric positive definite matrix. */
function cholesky(a: Float64Array, m: number): Float64Array {
  const l = new Float64Array(m * m);
  for (let r = 0; r < m; r++) {
    for (let c = 0; c <= r; c++) {
      let sum = a[r * m + c] as number;
      for (let k = 0; k < c; k++) sum -= (l[r * m + k] as number) * (l[c * m + k] as number);
      if (r === c) {
        if (sum <= 0) throw new Error("auto-weights: the heat system is not positive definite (degenerate mesh?)");
        l[r * m + c] = Math.sqrt(sum);
      } else {
        l[r * m + c] = sum / (l[c * m + c] as number);
      }
    }
  }
  return l;
}

function choleskySolve(l: Float64Array, m: number, b: Float64Array): Float64Array {
  const y = new Float64Array(m);
  for (let r = 0; r < m; r++) {
    let sum = b[r] as number;
    for (let k = 0; k < r; k++) sum -= (l[r * m + k] as number) * (y[k] as number);
    y[r] = sum / (l[r * m + r] as number);
  }
  const x = new Float64Array(m);
  for (let r = m - 1; r >= 0; r--) {
    let sum = y[r] as number;
    for (let k = r + 1; k < m; k++) sum -= (l[k * m + r] as number) * (x[k] as number);
    x[r] = sum / (l[r * m + r] as number);
  }
  return x;
}

/**
 * Harmonic weights from zones: `zoneOf(x, y)` names the bone (index) a vertex belongs to fully,
 * or -1 for a free vertex. Free vertices solve Laplace's equation (cotangent weights) per bone
 * with the zones as boundary values, so weights blend smoothly between zones (a stretch of cloth
 * between a pelvis and two thighs); then the usual clamp, prune and normalise.
 *
 * A connected component of free vertices that shares no (non-degenerate) triangle with a zoned
 * vertex has no boundary value: the solve would give it zero weights. By default that is an
 * error naming the component; `isolated: "nearest"` instead seeds the whole component fully on
 * the zone of the zoned vertex nearest to it (rigid on that bone).
 */
export function zoneWeights(
  mesh: MeshForWeights,
  boneCount: number,
  zoneOf: (x: number, y: number) => number,
  maxInfluences = 4,
  options: { isolated?: "reject" | "nearest" } = {}
): Influence[][] {
  const n = mesh.points.length / 2;
  const zone = Int32Array.from({ length: n }, (_, v) => zoneOf(mesh.points[v * 2] as number, mesh.points[v * 2 + 1] as number));
  seedIsolatedComponents(mesh, zone, options.isolated ?? "reject");
  const free: number[] = [];
  for (let v = 0; v < n; v++) if ((zone[v] as number) < 0) free.push(v);
  const weights: Float64Array[] = Array.from({ length: boneCount }, () => new Float64Array(n));
  for (let v = 0; v < n; v++) if ((zone[v] as number) >= 0) (weights[zone[v] as number] as Float64Array)[v] = 1;
  if (free.length > 0) {
    const { stiffness, area } = cotanSystem(mesh);
    const m = free.length;
    const a = new Float64Array(m * m);
    for (let r = 0; r < m; r++) {
      const v = free[r] as number;
      for (let c = 0; c < m; c++) a[r * m + c] = stiffness[v * n + (free[c] as number)] as number;
      // A tiny mass term keeps the system definite where a free patch touches no zone.
      a[r * m + r] = (a[r * m + r] as number) + 1e-6 * ((area[v] as number) + 1);
    }
    const factor = cholesky(a, m);
    for (let j = 0; j < boneCount; j++) {
      const rhs = new Float64Array(m);
      for (let r = 0; r < m; r++) {
        const v = free[r] as number;
        let value = 0;
        for (let u = 0; u < n; u++) if (zone[u] === j) value -= stiffness[v * n + u] as number;
        rhs[r] = value;
      }
      const solution = choleskySolve(factor, m, rhs);
      for (let r = 0; r < m; r++) (weights[j] as Float64Array)[free[r] as number] = solution[r] as number;
    }
  }
  return finalize(weights, n, maxInfluences, 0.02);
}

/**
 * Free components (zone -1) linked to no zoned vertex through a non-degenerate triangle (the
 * cotangent system's couplings): rejected, or set to the zone of the nearest zoned vertex.
 */
function seedIsolatedComponents(mesh: MeshForWeights, zone: Int32Array, mode: "reject" | "nearest"): void {
  const n = zone.length;
  const p = mesh.points;
  const x = (v: number) => p[v * 2] as number;
  const y = (v: number) => p[v * 2 + 1] as number;
  const neighbours = Array.from({ length: n }, () => [] as number[]);
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const a = mesh.triangles[t] as number;
    const b = mesh.triangles[t + 1] as number;
    const c = mesh.triangles[t + 2] as number;
    if (Math.abs((x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a))) < 1e-12) continue;
    (neighbours[a] as number[]).push(b, c);
    (neighbours[b] as number[]).push(a, c);
    (neighbours[c] as number[]).push(a, b);
  }
  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || (zone[start] as number) >= 0) continue;
    const component: number[] = [];
    let anchored = false;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const v = stack.pop() as number;
      component.push(v);
      for (const u of neighbours[v] as number[]) {
        if ((zone[u] as number) >= 0) anchored = true;
        else if (!seen[u]) {
          seen[u] = 1;
          stack.push(u);
        }
      }
    }
    if (anchored) continue;
    const at = `(${x(start).toFixed(1)}, ${y(start).toFixed(1)})`;
    if (mode === "reject") {
      throw new Error(`zone weights: a free component of ${component.length} vertices near ${at} touches no zone (it would get no weights); zone it or pass isolated: "nearest"`);
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let u = 0; u < n; u++) {
      if ((zone[u] as number) < 0) continue;
      for (const v of component) {
        const d = Math.hypot(x(u) - x(v), y(u) - y(v));
        if (d < bestDistance) {
          bestDistance = d;
          best = u;
        }
      }
    }
    if (best < 0) throw new Error(`zone weights: a free component near ${at} touches no zone and the mesh has no zoned vertex to seed it from`);
    for (const v of component) zone[v] = zone[best] as number;
  }
}
