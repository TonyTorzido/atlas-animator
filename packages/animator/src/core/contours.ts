/*
 * Atlas Animator: original implementation.
 *
 * Dynamic contours (plan Phase 4d, "dynamic contours"; consult: outlines of deforming skin are
 * stroke geometry built after deforming their centrelines, not baked into the deforming texture).
 *
 * Three parts, all renderer-neutral:
 * - compileContours: the document's skin `contours` resolved once per document: point bindings
 *   (mesh vertex refs / barycentric points, or bone weights), the bones whose movement changes the
 *   centreline (mesh influences plus the bones driving the mesh's correctives), visibility rules.
 * - the centreline: the skeleton evaluates a compiled contour into world points (Skeleton.
 *   computeContourPoints), reading the mesh's skinned vertices so a contour sits exactly on the
 *   deformed surface.
 * - buildStroke: centreline to a triangle list whose topology follows the centreline (
 *   item 3, stroke compaction): rebuilt only on held-pose cache misses, so each build spends only
 *   the vertices its joins need, into buffers allocated once at capacity (rebuilds allocate
 *   nothing). Per point a centre vertex; the inner side of a turn is the miter point; the outer
 *   side is the polygon circumscribing the round join (SVG stroke-linejoin round is the reference
 *   shape) with the fewest vertices whose outward error stays within STROKE_JOIN_ERROR display px
 *   (strokeJoinSteps): one vertex (a miter) on smooth runs, two (a clipped miter) at moderate
 *   corners, a fan of up to STROKE_MAX_ARC_STEPS at sharp ones. Each segment is two half-quads
 *   (rim to centreline on each side); open contours get round caps (semicircle fans) unless `caps`
 *   is "butt".
 *
 * Anti-aliasing (one treatment, "coverage ramp"): every vertex carries a texture coordinate on a
 * 1D ramp image in the atlas (alpha 0 at the rim, rising linearly to 1 over the first
 * `rampFraction` of the image, 1 beyond). The rim lies at w / 2 + aa / 2 from the centreline and
 * the coordinate grows linearly with the distance from the rim, reaching the end of the ramp aa
 * further in. So coverage is 0.5 exactly at w / 2 and the coverage integrated across the stroke is
 * exactly w, independent of how the centreline bends: width invariance is by construction, not by
 * correction (the 3x golden in browser-tests measures it).
 */
import type { Attachment, AttachmentLibrary, MeshAttachment } from "./attachments.js";
import type { Bone } from "./bone.js";
import { parseRgba, type Rgba } from "./color.js";
import type { CompiledDriven } from "./driven.js";
import { contourPointCount, type AnimDocument, type ContourData } from "./format.js";

/** Most vertices (arc pieces) on the outer side of a join; a join uses strokeJoinSteps of them. */
export const STROKE_MAX_ARC_STEPS = 4;
/** Join error budget in display px: the outer rim polygon stays within this of the true round join. */
export const STROKE_JOIN_ERROR = 0.125;

/**
 * Vertices k of the outer join polygon for a turn of `turn` radians: the fewest whose outward
 * error (the circumscribed polygon's vertex distance radius / cos(turn / 2k) minus the radius)
 * stays within STROKE_JOIN_ERROR, for a rim radius of `radiusDisplay` display px; clamped to
 * [1, STROKE_MAX_ARC_STEPS]. k = 1 is a miter (smooth runs), 2 a clipped miter.
 */
export function strokeJoinSteps(turn: number, radiusDisplay: number): number {
  return joinSteps(turn, joinHalfAngle(radiusDisplay));
}

/** Half the turn one outer-join vertex may cover at a rim radius of `radiusDisplay` display px (constant per stroke build). */
function joinHalfAngle(radiusDisplay: number): number {
  return Math.acos(1 / (1 + STROKE_JOIN_ERROR / radiusDisplay));
}

function joinSteps(turn: number, half: number): number {
  if (!(turn > 1e-9)) return 1;
  return Math.min(STROKE_MAX_ARC_STEPS, Math.max(1, Math.ceil(turn / (2 * half) - 1e-9)));
}

/** Outward error (display px) of the outer join polygon of a `turn` radian join (strokeJoinSteps vertices). */
export function strokeJoinError(turn: number, radiusDisplay: number): number {
  return radiusDisplay * (1 / Math.cos(turn / (2 * strokeJoinSteps(turn, radiusDisplay))) - 1);
}
/** Fan triangles in a round cap (a semicircle). */
export const STROKE_CAP_STEPS = 6;
/** Inner-side miter length limit, in half widths (at sharper turns the inner corner is clipped). */
export const STROKE_MITER_LIMIT = 2;

// Capacity per point: centre, the inner miter vertex, the outer join polygon at its most.
const PER_POINT = 2 + STROKE_MAX_ARC_STEPS;
const CAP = STROKE_CAP_STEPS + 2;

/** A contour of the document, compiled once and shared by every skeleton. */
export interface CompiledContour {
  /** Index in CompiledContours.all. */
  readonly id: number;
  readonly skin: string;
  /** Owner slot name. */
  readonly slot: string;
  readonly name: string;
  readonly closed: boolean;
  readonly roundCaps: boolean;
  /** Full stroke width in canvas pixels. */
  readonly width: number;
  readonly color: Readonly<Rgba>;
  /** Centreline points written per frame: the bound points plus one per extended end. */
  readonly pointCount: number;
  /** Bound points (mesh refs or bone-weighted points). */
  readonly boundCount: number;
  /** End extensions (canvas px) along the posed end tangents; a positive one adds a centreline point at that end. */
  readonly extendStart: number;
  readonly extendEnd: number;
  /** Mesh binding: the bound mesh (null for a bone-bound contour). */
  readonly mesh: MeshAttachment | null;
  /** Mesh binding: the skeleton bone of the mesh's slot (unweighted meshes ride it). */
  readonly meshSlotBone: number;
  /** Mesh binding: per point three mesh vertex indices and their weights. */
  readonly refs: Int32Array;
  readonly refWeights: Float64Array;
  /** Bone binding: per point influence counts, and per influence bone, bind (x, y) and weight. */
  readonly counts: Uint8Array;
  readonly influenceBones: Uint16Array;
  readonly bind: Float64Array;
  readonly weights: Float64Array;
  /** Bones whose world transform (or driven angle) changes the centreline. */
  readonly ownerBones: Int32Array;
  /** Visibility rules: bone index, min, max of its driver value (all must hold). */
  readonly visibleBones: Int32Array;
  readonly visibleMin: Float64Array;
  readonly visibleMax: Float64Array;
  /**
   * Ownership gate (part c): the attachment whose display the contour needs (`owner`,
   * else the bound mesh) and its slot; null / "" for a bone-bound contour without `owner`.
   */
  readonly ownerAttachment: Attachment | null;
  readonly ownerSlot: string;
  /** Clothing model: trimmed by pieces drawn after this slot ("" = the user slot). */
  readonly coverFrom: string;
  /** Arm layer: an under-sheet slot (drawn before the user) that also trims the stroke ("" = none; format `coverUnder`). */
  readonly coverUnder: string;
  /** Arm layer: coverers (meshes and opaque regions) trim at their outline and every trim end is capped, no feather (format `coverTight`). */
  readonly coverTight: boolean;
  /** Clothing model: rigid coverers trim at their outline only (format `trimAtOutline`). */
  readonly trimAtOutline: boolean;
  /** Contour contacts of this contour (partner id, gap, cos of the angle, overlap; canvas px). */
  readonly contacts: readonly ContourContact[];
  /** Contour joins of this contour (applyJoin). */
  readonly joins: readonly ContourJoin[];
  /**
   * Other contours (ids) whose geometry or visibility can move this centreline: with contacts, the
   * partners and every same-skin ink a contact junction may test (open inks and their chain
   * members); empty without contacts. Their owner bones are in ownerBones; their animation deform
   * (mesh and embed source) and their visibility are checked by the renderer (Skeleton
   * contourHasAnimatedDeform / contourDependencyVisibility).
   */
  readonly dependencies: readonly number[];
  /**
   * Ink chain id: contours bound to one mesh with one width, chained end to start, are one ink
   * (the lowest member id; a lone contour is its own chain). Contact junctions are judged per chain.
   */
  readonly chain: number;
  /** Stroke buffer capacities (a build writes at most this many vertices / indices; see buildStroke). */
  readonly vertexCount: number;
  readonly indexCount: number;
}

export interface ContourContact {
  readonly other: number;
  readonly gap: number;
  readonly cosMax: number;
  readonly overlap: number;
  /** Minimum arc length (canvas px) of a merged contact run; shorter runs are left apart. */
  readonly minRun: number;
  /** Taper length (canvas px): the move ramps in from a run's ends over this length. */
  readonly taper: number;
}

/** One end of a contour join, seen from one of the pair (format `contourJoins`). */
export interface ContourJoin {
  readonly other: number;
  /** This contour is the pair's `a` (the line that arrives; `b` continues it). */
  readonly isA: boolean;
  /** The joining end of `a` and of `b`: 0 = start, 1 = end. */
  readonly endA: 0 | 1;
  readonly endB: 0 | 1;
  /** Canvas px from the joining ends searched for a crossing and redrawn as the bridge. */
  readonly reach: number;
  /** Canvas px each line gives up on either side of a crossing, rounded by the bridge (a's width). */
  readonly fillet: number;
  /** a's stroke width: closer than this, the two lines overlap. */
  readonly width: number;
  /** The partner's owner slot: what it draws over does not trim this contour (they are one line). */
  readonly otherSlot: string;
}

export interface CompiledContours {
  readonly all: readonly CompiledContour[];
  /** skin -> its contours in document order. */
  readonly bySkin: ReadonlyMap<string, readonly CompiledContour[]>;
}

export interface ContourLookups {
  boneIndex(name: string): number;
  /** Bone index of a slot's bone. */
  slotBone(name: string): number;
  readonly library: AttachmentLibrary;
  readonly driven: CompiledDriven;
}

/** Compiles every skin's contours (the document must be validated). */
export function compileContours(doc: Pick<AnimDocument, "skins">, lookups: ContourLookups): CompiledContours {
  const all: CompiledContour[] = [];
  const bySkin = new Map<string, CompiledContour[]>();
  const inks: { key: string; first: number; last: number }[] = [];
  for (const [skin, skinData] of Object.entries(doc.skins)) {
    for (const [slot, contours] of Object.entries(skinData.contours ?? {})) {
      for (const [name, data] of Object.entries(contours)) {
        const contour = compileContour(all.length, skin, slot, name, data, lookups);
        all.push(contour);
        const pts = data.points ?? [];
        inks.push(data.mesh && pts.length && !data.closed ? { key: `${skin}|${data.mesh.slot}|${data.mesh.attachment}|${data.width}`, first: pts[0] as number, last: pts[pts.length - 1] as number } : { key: "", first: -1, last: -1 });
        let list = bySkin.get(skin);
        if (!list) bySkin.set(skin, (list = []));
        list.push(contour);
      }
    }
  }
  // Ink chains (union of mesh contours with one width chained end to start).
  const root = (i: number): number => ((all[i] as CompiledContour).chain === i ? i : root((all[i] as CompiledContour).chain));
  inks.forEach((a, i) => inks.forEach((b, j) => {
    if (i === j || !a.key || a.key !== b.key || a.last !== b.first) return;
    const [ra, rb] = [root(i), root(j)];
    if (ra !== rb) Object.assign(all[Math.max(ra, rb)] as CompiledContour, { chain: Math.min(ra, rb) });
  }));
  for (const c of all) Object.assign(c, { chain: root(c.id) });
  // Contacts: both contours carry the pair; each also rebuilds when the other's bones move.
  for (const [skin, skinData] of Object.entries(doc.skins)) {
    for (const c of skinData.contourContacts ?? []) {
      const find = (r: { slot: string; name: string }) => all.find((x) => x.skin === skin && x.slot === r.slot && x.name === r.name);
      const a = find(c.a);
      const b = find(c.b);
      // A document variant that strips or merges contours keeps its contacts: one whose contour is
      // gone has nothing to merge (skipped, not an error).
      if (!a || !b) continue;
      const spec = { gap: c.gap, cosMax: Math.cos(((c.angle ?? 15) * Math.PI) / 180), overlap: c.overlap ?? c.gap, minRun: c.minRun ?? 2 * c.gap, taper: c.taper ?? c.gap };
      for (const [self, other] of [[a, b], [b, a]] as const) {
        (self.contacts as ContourContact[]).push({ other: other.id, ...spec });
        Object.assign(self, { ownerBones: Int32Array.from([...new Set([...self.ownerBones, ...other.ownerBones])].sort((x, y) => x - y)) });
      }
    }
  }
  // Joins: both contours carry the pair, depend on each other and rebuild when either's bones move.
  const joinDeps = new Map<number, Set<number>>();
  for (const [skin, skinData] of Object.entries(doc.skins)) {
    for (const j of skinData.contourJoins ?? []) {
      const find = (r: { slot: string; name: string }) => all.find((x) => x.skin === skin && x.slot === r.slot && x.name === r.name);
      const a = find(j.a);
      const b = find(j.b);
      if (!a || !b || a === b || a.closed || b.closed) continue;
      const spec = { endA: j.a.end === "start" ? 0 : 1, endB: j.b.end === "start" ? 0 : 1, reach: j.reach, fillet: Math.min(a.width, j.reach / 2), width: a.width } as const;
      (a.joins as ContourJoin[]).push({ other: b.id, isA: true, otherSlot: b.slot, ...spec });
      (b.joins as ContourJoin[]).push({ other: a.id, isA: false, otherSlot: a.slot, ...spec });
      for (const [self, other] of [[a, b], [b, a]] as const) {
        let deps = joinDeps.get(self.id);
        if (!deps) joinDeps.set(self.id, (deps = new Set()));
        deps.add(other.id);
      }
    }
  }
  // Trim fillets and hand-over bridges (core/trimFillet.ts): a coverUnder stroke's fillet follows
  // the under sheet's contours, and an under-sheet contour's hand-over cut follows the strokes over
  // it, so each rebuilds when the other's bones move.
  const sheetBones = all.map((c) => c.ownerBones);
  for (const self of all) {
    const partners = all.filter((o) => o !== self && o.skin === self.skin && ((self.coverUnder && o.slot === self.coverUnder) || (o.coverUnder && o.coverUnder === self.slot)));
    if (!partners.length) continue;
    const bones = new Set(self.ownerBones);
    for (const o of partners) for (const bone of sheetBones[o.id] as Int32Array) bones.add(bone);
    Object.assign(self, { ownerBones: Int32Array.from([...bones].sort((x, y) => x - y)) });
  }
  const unjoinedBones = all.map((c) => c.ownerBones);
  for (const [id, deps] of joinDeps) {
    const self = all[id] as CompiledContour;
    const bones = new Set(self.ownerBones);
    for (const o of deps) for (const bone of unjoinedBones[o] as Int32Array) bones.add(bone);
    Object.assign(self, { ownerBones: Int32Array.from([...bones].sort((x, y) => x - y)) });
  }
  // Geometry dependencies of contact contours (review): the partners, and every same-skin
  // ink a junction test reads (open inks, and the members of their chains for the joint test).
  const ownBones = all.map((c) => c.ownerBones);
  for (const self of all) {
    if (!self.contacts.length) continue;
    const peers = all.filter((o) => o.skin === self.skin && o !== self);
    const openChains = new Set(peers.filter((o) => !o.closed).map((o) => o.chain));
    const deps = new Set<number>(self.contacts.map((c) => c.other));
    for (const o of peers) if (!o.closed || openChains.has(o.chain)) deps.add(o.id);
    const bones = new Set(self.ownerBones);
    for (const id of deps) for (const bone of ownBones[id] as Int32Array) bones.add(bone);
    Object.assign(self, { dependencies: [...deps].sort((x, y) => x - y), ownerBones: Int32Array.from([...bones].sort((x, y) => x - y)) });
  }
  for (const [id, deps] of joinDeps) {
    const self = all[id] as CompiledContour;
    Object.assign(self, { dependencies: [...new Set([...self.dependencies, ...deps])].sort((x, y) => x - y) });
  }
  return { all, bySkin };
}

function compileContour(id: number, skin: string, slot: string, name: string, data: ContourData, lookups: ContourLookups): CompiledContour {
  const label = `contour '${skin}/${slot}/${name}'`;
  const boundCount = contourPointCount(data);
  const extendStart = data.closed ? 0 : (data.extend?.[0] ?? 0);
  const extendEnd = data.closed ? 0 : (data.extend?.[1] ?? 0);
  const pointCount = boundCount + (extendStart > 0 ? 1 : 0) + (extendEnd > 0 ? 1 : 0);
  const owners = new Set<number>();
  let mesh: MeshAttachment | null = null;
  let meshSlotBone = -1;
  const refs = new Int32Array(data.points ? boundCount * 3 : 0);
  const refWeights = new Float64Array(refs.length);
  let counts = new Uint8Array(0);
  let influenceBones = new Uint16Array(0);
  let bind = new Float64Array(0);
  let weights = new Float64Array(0);

  if (data.mesh && data.points) {
    const target = lookups.library.get(data.mesh.skin ?? skin, data.mesh.slot, data.mesh.attachment);
    if (!target || target.type !== "mesh") throw new Error(`${label}: bound mesh is not a mesh`);
    mesh = target;
    meshSlotBone = lookups.slotBone(data.mesh.slot);
    const geometry = target.geometry;
    // First influence index of each vertex (weighted meshes), to collect the referenced bones.
    const firstInfluence = new Int32Array(geometry.vertexCount + 1);
    if (geometry.weighted) for (let v = 0; v < geometry.vertexCount; v++) firstInfluence[v + 1] = (firstInfluence[v] as number) + (geometry.counts[v] as number);
    const own = (vertex: number) => {
      if (!geometry.weighted) owners.add(meshSlotBone);
      else for (let i = firstInfluence[vertex] as number; i < (firstInfluence[vertex + 1] as number); i++) owners.add(geometry.influenceBones[i] as number);
    };
    data.points.forEach((point, p) => {
      const [a, b, c, wa, wb] = typeof point === "number" ? [point, point, point, 1, 0] : point;
      refs[p * 3] = a;
      refs[p * 3 + 1] = b;
      refs[p * 3 + 2] = c;
      refWeights[p * 3] = wa;
      refWeights[p * 3 + 1] = wb;
      refWeights[p * 3 + 2] = 1 - wa - wb;
      own(a);
      if (wb !== 0) own(b);
      if (1 - wa - wb !== 0) own(c);
    });
    for (const bone of lookups.driven.drivers.get(target.deformOwner.deformIndex) ?? []) owners.add(bone);
    // Embedded vertices move with their source mesh: its bones and drivers also rebuild the stroke.
    const source = target.embedSource;
    if (source) {
      const embedSlot = (target.geometry.embed as { slot: string }).slot;
      if (source.geometry.weighted) for (const bone of source.geometry.influenceBones) owners.add(bone);
      else owners.add(lookups.slotBone(embedSlot));
      for (const bone of lookups.driven.drivers.get(source.deformOwner.deformIndex) ?? []) owners.add(bone);
    }
  } else if (data.bones && data.vertices) {
    const table = data.bones.map((bone) => lookups.boneIndex(bone));
    counts = new Uint8Array(boundCount);
    const influences: number[] = [];
    const binds: number[] = [];
    const ws: number[] = [];
    let cursor = 0;
    for (let p = 0; p < boundCount; p++) {
      const n = data.vertices[cursor++] as number;
      counts[p] = n;
      for (let k = 0; k < n; k++) {
        const bone = table[data.vertices[cursor] as number] as number;
        influences.push(bone);
        owners.add(bone);
        binds.push(data.vertices[cursor + 1] as number, data.vertices[cursor + 2] as number);
        ws.push(data.vertices[cursor + 3] as number);
        cursor += 4;
      }
    }
    influenceBones = Uint16Array.from(influences);
    bind = Float64Array.from(binds);
    weights = Float64Array.from(ws);
  } else {
    throw new Error(`${label}: no binding`);
  }

  const roundCaps = data.caps === "round" && !data.closed;
  const ownerRef = data.owner ?? data.mesh;
  const ownerAttachment = ownerRef ? (lookups.library.get(ownerRef.skin ?? skin, ownerRef.slot, ownerRef.attachment) ?? null) : null;
  if (ownerRef && !ownerAttachment) throw new Error(`${label}: owner attachment '${ownerRef.slot}/${ownerRef.attachment}' does not exist`);
  return {
    id,
    skin,
    slot,
    name,
    closed: data.closed,
    roundCaps,
    width: data.width,
    color: parseRgba(data.color),
    pointCount,
    boundCount,
    extendStart,
    extendEnd,
    mesh,
    meshSlotBone,
    refs,
    refWeights,
    counts,
    influenceBones,
    bind,
    weights,
    ownerBones: Int32Array.from([...owners].sort((x, y) => x - y)),
    visibleBones: Int32Array.from(data.visible.map((rule) => lookups.boneIndex(rule.bone))),
    visibleMin: Float64Array.from(data.visible.map((rule) => rule.min)),
    visibleMax: Float64Array.from(data.visible.map((rule) => rule.max)),
    ownerAttachment,
    ownerSlot: ownerRef?.slot ?? "",
    coverFrom: data.coverFrom ?? "",
    coverUnder: data.coverUnder ?? "",
    coverTight: data.coverTight === true,
    trimAtOutline: data.trimAtOutline === true,
    contacts: [],
    joins: [],
    dependencies: NO_DEPENDENCIES,
    chain: id,
    vertexCount: strokeVertexCount(pointCount, data.closed, roundCaps),
    indexCount: strokeIndexCount(pointCount, data.closed, roundCaps)
  };
}

/**
 * Writes the world points of a bone-bound contour (2 floats per point). Mesh-bound contours are
 * evaluated by the skeleton (Skeleton.computeContourPoints), which owns the skinned-mesh cache.
 */
export function computeBoneContourPoints(contour: CompiledContour, bones: readonly Bone[], out: Float32Array): void {
  const { counts, influenceBones, bind, weights } = contour;
  const o = contour.extendStart > 0 ? 1 : 0;
  let influence = 0;
  for (let p = 0; p < contour.boundCount; p++) {
    let x = 0;
    let y = 0;
    const end = influence + (counts[p] as number);
    for (; influence < end; influence++) {
      const world = (bones[influenceBones[influence] as number] as Bone).world;
      const bx = bind[influence * 2] as number;
      const by = bind[influence * 2 + 1] as number;
      const w = weights[influence] as number;
      x += (world.a * bx + world.b * by + world.x) * w;
      y += (world.c * bx + world.d * by + world.y) * w;
    }
    out[(p + o) * 2] = x;
    out[(p + o) * 2 + 1] = y;
  }
  extendContourEnds(contour, out);
}

/** One ink for contour contacts: a contour's unmoved centreline (2 floats per point) and its chain. */
export interface ContactInk {
  readonly points: ArrayLike<number>;
  readonly count: number;
  readonly closed: boolean;
  readonly width: number;
  readonly chain: number;
}

/** Nearest point of `ink` to (px, py) and the |cos| of either tangent (t0, t1) against that segment. */
function nearestOn(px: number, py: number, ink: ContactInk, t0x: number, t0y: number, t1x: number, t1y: number): { d: number; qx: number; qy: number; cos: number } {
  const segs = ink.closed ? ink.count : ink.count - 1;
  const pts = ink.points;
  let d = Infinity;
  let qx = px;
  let qy = py;
  let cos = 0;
  for (let j = 0; j < segs; j++) {
    const k = (j + 1) % ink.count;
    const ax = pts[j * 2] as number;
    const ay = pts[j * 2 + 1] as number;
    const dx = (pts[k * 2] as number) - ax;
    const dy = (pts[k * 2 + 1] as number) - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const cx = ax + dx * u;
    const cy = ay + dy * u;
    const e = Math.hypot(px - cx, py - cy);
    if (e < d) {
      d = e;
      qx = cx;
      qy = cy;
      cos = l2 > 1e-12 ? Math.max(Math.abs(t0x * dx + t0y * dy), Math.abs(t1x * dx + t1y * dy)) / Math.sqrt(l2) : 0;
    }
  }
  return { d, qx, qy, cos };
}

const NO_DEPENDENCIES: readonly number[] = Object.freeze([]);

/** Share of a stroke's width a contact may move it: the stroke still covers its own fill edge. */
export const CONTACT_MOVE_CAP = 0.4;

/**
 * Contour contacts (closeout): adds to `out` (a copy of `self`'s unmoved centreline) a move
 * toward each declared partner where the two run near-parallel (|cos| of either adjacent tangent
 * against the partner segment >= `cosMax`) with an ink gap g = distance - (width + otherWidth) / 2
 * in (-overlap, gap): by (g + overlap) / 2, capped at CONTACT_MOVE_CAP of this stroke's width so the
 * stroke still covers its own fill edge (no background between fill and ink). The merge is scoped to
 * the pair's actual contact run:
 * - per point, each partner chain contributes its nearest member only (a chain joint is not doubled);
 * - a point where an open end of a third ink (another chain, drawn) lies within reach of both the
 *   point and the partner there is a three-way junction (e.g. the tank trim vs the torso and
 *   upper-arm outlines meeting at the shoulder top) and is not merged; `inks` is indexed by contour
 *   id (null = not drawn);
 * - runs of merged points shorter than `minRun` canvas px are dropped, and each run tapers in over
 *   `taper` canvas px from where it leaves contact (an open contour end does not taper: the ink
 *   continues on its chain).
 * Measured on unmoved geometry; pure; 2 floats per point. Runtime and clearance gate share it.
 */
export function applyContacts(out: { [i: number]: number }, self: ContactInk, contacts: readonly ContourContact[], inks: readonly (ContactInk | null)[]): void {
  const { points: raw, count, closed, width } = self;
  if (count < 2 || !contacts.length) return;
  const cap = CONTACT_MOVE_CAP * width;
  const mx = new Float64Array(count);
  const my = new Float64Array(count);
  const on = new Uint8Array(count);
  const seg = (from: number, to: number): [number, number] => {
    const dx = (raw[to * 2] as number) - (raw[from * 2] as number);
    const dy = (raw[to * 2 + 1] as number) - (raw[from * 2 + 1] as number);
    const l = Math.hypot(dx, dy);
    return l < 1e-9 ? [0, 0] : [dx / l, dy / l];
  };
  for (let i = 0; i < count; i++) {
    const px = raw[i * 2] as number;
    const py = raw[i * 2 + 1] as number;
    const i0 = closed ? (i - 1 + count) % count : Math.max(0, i - 1);
    const i1 = closed ? (i + 1) % count : Math.min(count - 1, i + 1);
    // Tangents of both adjacent segments: near-parallel when either is (a vertex on a bend).
    const [t0x, t0y] = seg(i0, i);
    const [t1x, t1y] = seg(i, i1);
    if (!t0x && !t0y && !t1x && !t1y) continue;
    const byChain = new Map<number, { d: number; qx: number; qy: number; s: number; ink: ContactInk; gap: number }>();
    for (const c of contacts) {
      const ink = inks[c.other];
      if (!ink || ink.chain === self.chain) continue;
      const n = nearestOn(px, py, ink, t0x, t0y, t1x, t1y);
      if (n.cos < c.cosMax || n.d < 1e-9) continue;
      const g = n.d - (width + ink.width) / 2;
      if (!(g < c.gap && g > -c.overlap)) continue;
      const prev = byChain.get(ink.chain);
      if (!prev || n.d < prev.d) byChain.set(ink.chain, { d: n.d, qx: n.qx, qy: n.qy, s: Math.min((g + c.overlap) / 2, cap) / n.d, ink, gap: c.gap });
    }
    if (!byChain.size) continue;
    // Three-way junction: an open end of a third ink (not a joint inside its chain) within reach of
    // this point and of the partner there (where outlines meet, e.g. torso and upper arm at the
    // shoulder top). A third ink merely running alongside (a stacked flank) is not a junction.
    let junction = false;
    for (const m of byChain.values()) {
      for (const ink of inks) {
        if (!ink || ink.closed || ink.chain === self.chain || ink.chain === m.ink.chain) continue;
        for (const e of [0, ink.count - 1]) {
          const ex = ink.points[e * 2] as number;
          const ey = ink.points[e * 2 + 1] as number;
          if (Math.hypot(px - ex, py - ey) >= (width + ink.width) / 2 + m.gap) continue;
          if (Math.hypot(m.qx - ex, m.qy - ey) >= (m.ink.width + ink.width) / 2 + m.gap) continue;
          const joint = inks.some((o) => o && o !== ink && o.chain === ink.chain && [0, o.count - 1].some((k) => Math.hypot((o.points[k * 2] as number) - ex, (o.points[k * 2 + 1] as number) - ey) < 1e-6));
          if (!joint) junction = true;
        }
        if (junction) break;
      }
      if (junction) break;
    }
    if (junction) continue;
    for (const m of byChain.values()) {
      mx[i] = (mx[i] as number) + (m.qx - px) * m.s;
      my[i] = (my[i] as number) + (m.qy - py) * m.s;
    }
    on[i] = 1;
  }
  const minRun = Math.max(0, ...contacts.map((c) => c.minRun));
  const taper = Math.max(0, ...contacts.map((c) => c.taper));
  const len = (a: number, b: number) => Math.hypot((raw[b * 2] as number) - (raw[a * 2] as number), (raw[b * 2 + 1] as number) - (raw[a * 2 + 1] as number));
  const add = (i: number, w: number) => {
    out[i * 2] = (out[i * 2] as number) + (mx[i] as number) * w;
    out[i * 2 + 1] = (out[i * 2 + 1] as number) + (my[i] as number) * w;
  };
  // Runs; a closed contour starts after an unmerged point (all merged = one endless run).
  let startAt = 0;
  if (closed) {
    startAt = on.indexOf(0);
    if (startAt < 0) {
      for (let i = 0; i < count; i++) add(i, 1);
      return;
    }
  }
  for (let k = 0; k < count; ) {
    if (!on[(startAt + k) % count]) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < count && on[(startAt + e + 1) % count]) e++;
    const idx = Array.from({ length: e - k + 1 }, (_, j) => (startAt + k + j) % count);
    const s: number[] = [0];
    for (let j = 1; j < idx.length; j++) s.push((s[j - 1] as number) + len(idx[j - 1] as number, idx[j] as number));
    const runLen = s[s.length - 1] as number;
    const first = idx[0] as number;
    const last = idx[idx.length - 1] as number;
    // The taper origin is the unmerged neighbour outside the run; an open contour end has none.
    const lead = !closed && first === 0 ? Infinity : len((first - 1 + count) % count, first);
    const trail = !closed && last === count - 1 ? Infinity : len(last, (last + 1) % count);
    if (runLen >= minRun) idx.forEach((i, j) => add(i, taper > 0 ? Math.min(1, Math.min(lead + (s[j] as number), trail + runLen - (s[j] as number)) / taper) : 1));
    k = e + 1;
  }
}

/** One contact pair with no junction inks and no run scope (applyContacts with a single partner). */
export function applyContact(out: { [i: number]: number }, raw: ArrayLike<number>, count: number, closed: boolean, width: number, other: ArrayLike<number>, otherCount: number, otherClosed: boolean, otherWidth: number, gap: number, cosMax: number, overlap: number): void {
  applyContacts(out, { points: raw, count, closed, width, chain: 0 }, [{ other: 1, gap, cosMax, overlap, minRun: 0, taper: 0 }], [null, { points: other, count: otherCount, closed: otherClosed, width: otherWidth, chain: 1 }]);
}

/** Writes the points of a mesh-bound contour from the mesh's world vertices (2 floats each). */
export function computeMeshContourPoints(contour: CompiledContour, meshWorld: ArrayLike<number>, out: Float32Array): void {
  const { refs, refWeights } = contour;
  const o = contour.extendStart > 0 ? 1 : 0;
  for (let p = 0, i = 0; p < contour.boundCount; p++, i += 3) {
    const a = (refs[i] as number) * 2;
    const b = (refs[i + 1] as number) * 2;
    const c = (refs[i + 2] as number) * 2;
    const wa = refWeights[i] as number;
    const wb = refWeights[i + 1] as number;
    const wc = refWeights[i + 2] as number;
    out[(p + o) * 2] = (meshWorld[a] as number) * wa + (meshWorld[b] as number) * wb + (meshWorld[c] as number) * wc;
    out[(p + o) * 2 + 1] = (meshWorld[a + 1] as number) * wa + (meshWorld[b + 1] as number) * wb + (meshWorld[c + 1] as number) * wc;
  }
  extendContourEnds(contour, out);
}

/**
 * Writes the end extensions of an open contour (the bound points are already at their slots): the
 * first/last point continued `extendStart`/`extendEnd` canvas px along the posed end tangent (the
 * direction from the nearest distinct bound point). A degenerate centreline extends by nothing.
 */
function extendContourEnds(contour: CompiledContour, out: Float32Array): void {
  const o = contour.extendStart > 0 ? 1 : 0;
  const n = contour.boundCount;
  if (contour.extendStart > 0) extendEnd(out, o, n, 0, o, 1, contour.extendStart);
  if (contour.extendEnd > 0) extendEnd(out, o, n, o + n, o + n - 1, -1, contour.extendEnd);
}

// One end of extendContourEnds (a module function, not a per-call closure: this runs per stroke rebuild).
function extendEnd(out: Float32Array, o: number, n: number, slot: number, end: number, step: number, length: number): void {
  const ex = out[end * 2] as number;
  const ey = out[end * 2 + 1] as number;
  let dx = 0;
  let dy = 0;
  for (let k = end + step; k >= o && k < o + n; k += step) {
    dx = ex - (out[k * 2] as number);
    dy = ey - (out[k * 2 + 1] as number);
    if (dx * dx + dy * dy > 1e-12) break;
  }
  const len = Math.hypot(dx, dy);
  const s = len > 1e-6 ? length / len : 0;
  out[slot * 2] = ex + dx * s;
  out[slot * 2 + 1] = ey + dy * s;
}

/** applyJoin searches B this multiple of `reach` for where A (or its extension) meets it. */
export const JOIN_SEARCH = 2.5;
/** Overlap ramp (in stroke widths past one width) over which a meeting fades in: no snap. */
export const JOIN_RAMP = 0.5;

// Scratch for applyJoin (grown on demand; a join rebuild allocates nothing once warm).
let joinA = new Float64Array(64);
let joinB = new Float64Array(64);
let joinSA = new Float64Array(32);
let joinSB = new Float64Array(32);
const joinP = new Float64Array(4);

/**
 * Contour join (format `contourJoins`): writes into `out` (`self`'s centreline,
 * 2 floats per point) the pair's joined geometry for `self`. `a` arrives at its joining end, `b`
 * leaves from its own; both are read unmoved (`aPts`, `bPts`) so the two members compute the same
 * answer independently. Every quantity is a continuous function of the two centrelines:
 * - overlap: each vertex and segment midpoint of B's head (within JOIN_SEARCH x `reach` px) has a
 *   distance d to A's last `reach` px or to A's extension past its end; its overlap weight is
 *   o = 1 under one stroke width, 0 past (1 + JOIN_RAMP) widths, linear between (and faded out
 *   over the last tenth of the search). The meeting depth on B is s* = max(s_i x o_i) and the
 *   overlap strength m = max(o_i): maxima of continuous functions;
 * - A is cut at arc lerp(A's length, X, m), X the arc on A (or its extension) nearest to B(s*), and
 *   gives up m x `fillet` px more (a rounded corner where the lines overlap);
 * - B's head up to arc s* + lerp(`reach`, `fillet`, m) is redrawn as a cubic Hermite curve from A's
 *   new end (leaving along A's tangent, turned toward the target where it would hairpin) to that
 *   point of B (arriving along B); each replaced point sits at the curve parameter of its own arc,
 *   so a point entering the curve enters at its own position.
 * With no overlap (m = 0) this is the bridge across an outer-side gap; with full overlap the lines
 * are cut where they meet and rounded. Pure; the partner's visibility is the caller's.
 */
export function applyJoin(out: Float32Array, isA: boolean, aPts: ArrayLike<number>, aCount: number, bPts: ArrayLike<number>, bCount: number, join: ContourJoin): void {
  if (aCount < 2 || bCount < 2) return;
  if (joinA.length < aCount * 2) joinA = new Float64Array(aCount * 4);
  if (joinB.length < bCount * 2) joinB = new Float64Array(bCount * 4);
  if (joinSA.length < aCount) joinSA = new Float64Array(aCount * 2);
  if (joinSB.length < bCount) joinSB = new Float64Array(bCount * 2);
  const A = joinA;
  const B = joinB;
  for (let i = 0; i < aCount; i++) {
    const k = join.endA === 1 ? i : aCount - 1 - i;
    A[i * 2] = aPts[k * 2] as number;
    A[i * 2 + 1] = aPts[k * 2 + 1] as number;
  }
  for (let j = 0; j < bCount; j++) {
    const k = join.endB === 0 ? j : bCount - 1 - j;
    B[j * 2] = bPts[k * 2] as number;
    B[j * 2 + 1] = bPts[k * 2 + 1] as number;
  }
  const reach = join.reach;
  const width = join.width;
  const SA = joinSA;
  const SB = joinSB;
  SA[0] = 0;
  for (let i = 1; i < aCount; i++) SA[i] = (SA[i - 1] as number) + Math.hypot((A[i * 2] as number) - (A[(i - 1) * 2] as number), (A[i * 2 + 1] as number) - (A[(i - 1) * 2 + 1] as number));
  SB[0] = 0;
  for (let j = 1; j < bCount; j++) SB[j] = (SB[j - 1] as number) + Math.hypot((B[j * 2] as number) - (B[(j - 1) * 2] as number), (B[j * 2 + 1] as number) - (B[(j - 1) * 2 + 1] as number));
  const lenA = SA[aCount - 1] as number;
  const ex = A[(aCount - 1) * 2] as number;
  const ey = A[(aCount - 1) * 2 + 1] as number;
  let etx = 0;
  let ety = 0;
  for (let i = aCount - 2; i >= 0; i--) {
    etx = ex - (A[i * 2] as number);
    ety = ey - (A[i * 2 + 1] as number);
    if (etx * etx + ety * ety > 1e-12) break;
  }
  const el = Math.hypot(etx, ety) || 1;
  etx /= el;
  ety /= el;
  const search = JOIN_SEARCH * reach;
  let m = 0;
  let sStar = 0;
  const weigh = (qx: number, qy: number, s: number) => {
    if (s > search) return;
    joinNearestA(A, SA, aCount, lenA, ex, ey, etx, ety, reach, qx, qy);
    const o = Math.max(0, Math.min(1, (width * (1 + JOIN_RAMP) - (joinP[0] as number)) / (width * JOIN_RAMP))) * Math.max(0, Math.min(1, (search - s) / (0.1 * search)));
    if (o > m) m = o;
    if (s * o > sStar) sStar = s * o;
  };
  for (let j = 0; j < bCount && (SB[j] as number) <= search; j++) {
    weigh(B[j * 2] as number, B[j * 2 + 1] as number, SB[j] as number);
    if (j + 1 < bCount) weigh(((B[j * 2] as number) + (B[(j + 1) * 2] as number)) / 2, ((B[j * 2 + 1] as number) + (B[(j + 1) * 2 + 1] as number)) / 2, ((SB[j] as number) + (SB[j + 1] as number)) / 2);
  }
  joinPointOnB(B, SB, bCount, sStar);
  joinNearestA(A, SA, aCount, lenA, ex, ey, etx, ety, reach, joinP[0] as number, joinP[1] as number);
  const cutArc = lenA + ((joinP[1] as number) - lenA) * m - m * join.fillet;
  // A's new end (cut, or extended along its tangent) and its tangent there.
  let px = ex;
  let py = ey;
  let tax = etx;
  let tay = ety;
  let firstA = aCount;
  if (cutArc > lenA) {
    px = ex + etx * (cutArc - lenA);
    py = ey + ety * (cutArc - lenA);
    firstA = aCount - 1;
    A[firstA * 2] = px;
    A[firstA * 2 + 1] = py;
  } else if (cutArc < lenA) {
    const c = Math.max(0, cutArc);
    let i = 1;
    while (i < aCount - 1 && (SA[i] as number) < c) i++;
    const l = (SA[i] as number) - (SA[i - 1] as number);
    const u = l > 1e-12 ? Math.min(1, (c - (SA[i - 1] as number)) / l) : 0;
    const x0 = A[(i - 1) * 2] as number;
    const y0 = A[(i - 1) * 2 + 1] as number;
    px = x0 + ((A[i * 2] as number) - x0) * u;
    py = y0 + ((A[i * 2 + 1] as number) - y0) * u;
    if (l > 1e-12) {
      tax = ((A[i * 2] as number) - x0) / l;
      tay = ((A[i * 2 + 1] as number) - y0) / l;
    }
    // the points past the cut spread along its last segment (coincident end points would leave the
    // end cap without a direction; collinear points keep the stroke the same)
    firstA = i;
    const n = aCount - i;
    for (let k = 0; k < n; k++) {
      A[(i + k) * 2] = x0 + (px - x0) * ((k + 1) / n);
      A[(i + k) * 2 + 1] = y0 + (py - y0) * ((k + 1) / n);
    }
  }
  let lastB = -1;
  if (!isA) {
    const sq = sStar + reach + (join.fillet - reach) * m;
    joinPointOnB(B, SB, bCount, sq);
    const qx = joinP[0] as number;
    const qy = joinP[1] as number;
    const tbx = joinP[2] as number;
    const tby = joinP[3] as number;
    const dqx = qx - px;
    const dqy = qy - py;
    const dq = Math.hypot(dqx, dqy);
    // a tangent pointing away from the target would hairpin: it turns toward it as it reverses
    if (dq > 1e-9) {
      const w = Math.max(0, Math.min(1, (-2 * (tax * dqx + tay * dqy)) / dq));
      tax = (1 - w) * tax + (w * dqx) / dq;
      tay = (1 - w) * tay + (w * dqy) / dq;
      const tl = Math.hypot(tax, tay) || 1;
      tax /= tl;
      tay /= tl;
    }
    for (let j = 0; j < bCount && (SB[j] as number) < sq; j++) {
      const t = sq > 1e-9 ? (SB[j] as number) / sq : 1;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      B[j * 2] = h00 * px + h10 * dq * tax + h01 * qx + h11 * dq * tbx;
      B[j * 2 + 1] = h00 * py + h10 * dq * tay + h01 * qy + h11 * dq * tby;
      lastB = j;
    }
  }
  if (isA) {
    for (let i = firstA; i < aCount; i++) {
      const k = join.endA === 1 ? i : aCount - 1 - i;
      out[k * 2] = A[i * 2] as number;
      out[k * 2 + 1] = A[i * 2 + 1] as number;
    }
  } else {
    for (let j = 0; j <= lastB; j++) {
      const k = join.endB === 0 ? j : bCount - 1 - j;
      out[k * 2] = B[j * 2] as number;
      out[k * 2 + 1] = B[j * 2 + 1] as number;
    }
  }
}

/** applyJoin: nearest arc on A's last `reach` px or its extension to (qx, qy): joinP[0] = distance, joinP[1] = arc. */
function joinNearestA(A: Float64Array, SA: Float64Array, aCount: number, lenA: number, ex: number, ey: number, etx: number, ety: number, reach: number, qx: number, qy: number): void {
  let d = Infinity;
  let arc = lenA;
  for (let i = aCount; i >= 1; i--) {
    const ext = i === aCount;
    if (!ext && lenA - (SA[i] as number) > reach) break;
    const x0 = ext ? ex : (A[(i - 1) * 2] as number);
    const y0 = ext ? ey : (A[(i - 1) * 2 + 1] as number);
    const sx = ext ? etx * reach : (A[i * 2] as number) - x0;
    const sy = ext ? ety * reach : (A[i * 2 + 1] as number) - y0;
    const l2 = sx * sx + sy * sy;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((qx - x0) * sx + (qy - y0) * sy) / l2)) : 0;
    const e = Math.hypot(qx - x0 - sx * u, qy - y0 - sy * u);
    if (e < d) {
      d = e;
      arc = ext ? lenA + u * reach : (SA[i - 1] as number) + u * Math.sqrt(l2);
    }
  }
  joinP[0] = d;
  joinP[1] = arc;
}

/** applyJoin: point and unit tangent of B at arc s (clamped): joinP[0..3]. */
function joinPointOnB(B: Float64Array, SB: Float64Array, bCount: number, s: number): void {
  let j = 1;
  while (j < bCount - 1 && (SB[j] as number) < s) j++;
  const x0 = B[(j - 1) * 2] as number;
  const y0 = B[(j - 1) * 2 + 1] as number;
  const l = (SB[j] as number) - (SB[j - 1] as number);
  const u = l > 1e-12 ? Math.max(0, Math.min(1, (s - (SB[j - 1] as number)) / l)) : 0;
  joinP[0] = x0 + ((B[j * 2] as number) - x0) * u;
  joinP[1] = y0 + ((B[j * 2 + 1] as number) - y0) * u;
  joinP[2] = l > 1e-12 ? ((B[j * 2] as number) - x0) / l : 1;
  joinP[3] = l > 1e-12 ? ((B[j * 2 + 1] as number) - y0) / l : 0;
}

// ---------------------------------------------------------------------------------------------
// Stroke geometry
// ---------------------------------------------------------------------------------------------

/** Buffer capacity (vertices) of a stroke: every outer join at STROKE_MAX_ARC_STEPS vertices. */
export function strokeVertexCount(points: number, closed: boolean, roundCaps: boolean): number {
  return points * PER_POINT + (!closed && roundCaps ? 2 * CAP : 0);
}

/** Index buffer capacity of a stroke (see strokeVertexCount). */
export function strokeIndexCount(points: number, closed: boolean, roundCaps: boolean): number {
  const segments = closed ? points : Math.max(0, points - 1);
  return 3 * (points * (STROKE_MAX_ARC_STEPS - 1) + 4 * segments + (!closed && roundCaps ? 2 * STROKE_CAP_STEPS : 0));
}

/** What a buildStroke call wrote: vertices (positions / uvs pairs) and indices. */
export interface StrokeCounts {
  vertices: number;
  indices: number;
  /**
   * False when buildStroke was given a StrokeTopology matching this build's join layout and ramp
   * coordinates: the uvs and indices it would write are already in the buffers, so it left them
   * (and the caller need not re-upload them). True otherwise.
   */
  topologyChanged?: boolean;
}

/**
 * The join layout of a caller's last stroke build (per point its left and right rim vertex counts,
 * the caps and the ramp coordinates), so a rebuild with the same topology writes positions only.
 * Owned by the caller, one per stroke buffer set; `valid` false (new) forces a full write.
 */
export interface StrokeTopology {
  valid: boolean;
  /** 2 per point: left, right rim vertex counts. */
  readonly sides: Uint8Array;
  /**
   * uCentre, uRim, v, caps (0 / 1), the exact point count and closed (0 / 1) of the last full write:
   * the same join layout with another point count or an open/closed switch writes other indices.
   */
  readonly ramp: Float64Array;
}

export function createStrokeTopology(points: number): StrokeTopology {
  return { valid: false, sides: new Uint8Array(points * 2), ramp: new Float64Array(TOPOLOGY_KEY) };
}

/** Where the coverage ramp sits in the atlas. */
export interface StrokeRamp {
  /** Texture u of the ramp's start (alpha 0) and end. */
  u0: number;
  u1: number;
  /** Texture v of the ramp row. */
  v: number;
  /** Fraction of [u0, u1] over which alpha rises from 0 to 1. */
  rampFraction: number;
}

// Cap directions: cos and sin of j * pi / STROKE_CAP_STEPS.
const CAP_COS = Float64Array.from({ length: STROKE_CAP_STEPS + 1 }, (_, j) => Math.cos((j * Math.PI) / STROKE_CAP_STEPS));
const CAP_SIN = Float64Array.from({ length: STROKE_CAP_STEPS + 1 }, (_, j) => Math.sin((j * Math.PI) / STROKE_CAP_STEPS));

// Unit directions in a typed scratch (incoming x, y; outgoing x, y): stores into a Float64Array
// never box, where double fields of a plain object can (the allocation test caught it).
const dir = new Float64Array(4);
const IN = 0;
const OUT = 2;
// Per point of the stroke being built: its first vertex (the centre) and its left and right rim
// vertex counts. Grown to the largest contour, never shrunk.
let pointBase = new Int32Array(64);
let pointLeft = new Int32Array(64);
let pointRight = new Int32Array(64);

function direction(points: ArrayLike<number>, from: number, to: number, at: number): boolean {
  const dx = (points[to * 2] as number) - (points[from * 2] as number);
  const dy = (points[to * 2 + 1] as number) - (points[from * 2 + 1] as number);
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1e-9) return false;
  dir[at] = dx / length;
  dir[at + 1] = dy / length;
  return true;
}

/**
 * Builds the stroke around `count` centreline points (2 floats each) into `positions` and `uvs`
 * (2 floats per vertex) and `indices` (a triangle list), sized by strokeVertexCount and
 * strokeIndexCount. The topology follows the centreline (each join takes only the vertices its turn
 * needs), so the call reports what it wrote: it returns the vertex count and, when `counts` is
 * given, stores both counts there. `width` is the full stroke width and `aa` the anti-aliasing
 * band, both in the points' units (canvas pixels; aa = one display pixel). Allocates nothing (once
 * the per-point scratch has grown to the largest contour).
 *
 * Layout per point p: the centre, the left rim run, the right rim run. The inner side of a turn is
 * one vertex (the miter point, clipped at STROKE_MITER_LIMIT); the outer side is the join polygon
 * (strokeJoinSteps vertices). Then for open round-capped strokes a start-cap and an end-cap block
 * (centre and STROKE_CAP_STEPS + 1 rim vertices).
 */
export function buildStroke(
  points: ArrayLike<number>,
  count: number,
  closed: boolean,
  roundCaps: boolean,
  width: number,
  aa: number,
  ramp: StrokeRamp,
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array | Uint16Array,
  counts?: StrokeCounts,
  topology?: StrokeTopology
): number {
  const radius = width / 2 + aa / 2;
  const uRim = ramp.u0;
  const uCentre = ramp.u0 + (ramp.u1 - ramp.u0) * Math.min(1, (radius / aa) * ramp.rampFraction);
  const v = ramp.v;
  // Constant per build (the join error budget at this rim radius): once, not per point.
  const half = joinHalfAngle(radius / aa);
  if (pointBase.length < count) {
    const size = Math.max(count, pointBase.length * 2);
    pointBase = new Int32Array(size);
    pointLeft = new Int32Array(size);
    pointRight = new Int32Array(size);
  }
  let lastX = 1;
  let lastY = 0;
  let vertex = 0;
  // Point p's outgoing direction is point p + 1's incoming one (the same segment, the same doubles):
  // computed once and carried over.
  let carried = false;

  for (let p = 0; p < count; p++) {
    const px = points[p * 2] as number;
    const py = points[p * 2 + 1] as number;
    const previous = p > 0 ? p - 1 : closed ? count - 1 : -1;
    const next = p < count - 1 ? p + 1 : closed ? 0 : -1;
    let hasIn: boolean;
    if (p > 0) {
      hasIn = carried;
      if (carried) {
        dir[IN] = dir[OUT] as number;
        dir[IN + 1] = dir[OUT + 1] as number;
      }
    } else hasIn = previous >= 0 && direction(points, previous, p, IN);
    const hasOut = next >= 0 && direction(points, p, next, OUT);
    carried = hasOut;
    if (!hasIn && !hasOut) {
      dir[IN] = dir[OUT] = lastX;
      dir[IN + 1] = dir[OUT + 1] = lastY;
    } else if (!hasIn) {
      dir[IN] = dir[OUT] as number;
      dir[IN + 1] = dir[OUT + 1] as number;
    } else if (!hasOut) {
      dir[OUT] = dir[IN] as number;
      dir[OUT + 1] = dir[IN + 1] as number;
    }
    const inX = dir[IN] as number;
    const inY = dir[IN + 1] as number;
    const outX = dir[OUT] as number;
    const outY = dir[OUT + 1] as number;
    lastX = outX;
    lastY = outY;

    // Normals (d rotated +90 degrees): n = (-dy, dx). The left side is +n.
    const nix = -inY;
    const niy = inX;
    const nox = -outY;
    const noy = outX;
    let bx = nix + nox;
    let by = niy + noy;
    const bl = Math.sqrt(bx * bx + by * by);
    let miter: number;
    if (bl < 1e-6) {
      // A full reversal: the bisector points along the incoming direction.
      bx = inX;
      by = inY;
      miter = STROKE_MITER_LIMIT;
    } else {
      bx /= bl;
      by /= bl;
      const cosHalf = bx * nix + by * niy;
      miter = cosHalf > 1 / STROKE_MITER_LIMIT ? 1 / cosHalf : STROKE_MITER_LIMIT;
    }
    // Turn towards +n (cross > 0): the left side is the inner side.
    const leftInner = inX * outY - inY * outX > 0;
    // Outer join: the polygon circumscribing the round join from n_in to n_out (signed turn; a
    // full reversal turns -pi, through the incoming direction like the bisector above) with the
    // fewest vertices the error budget allows: vertex j at angle turn (2j + 1) / 2k from n_in, at
    // radius / cos(turn / 2k). One vertex is a miter, two a clipped miter, more a round fan; the
    // first and last vertices lie on the adjoining segments' offset lines, so segments stay exact.
    let turn = Math.atan2(nix * noy - niy * nox, nix * nox + niy * noy);
    if (bl < 1e-6) turn = -Math.PI;
    const steps = joinSteps(Math.abs(turn), half);
    // cos(turn / 2k) is also the first outer vertex's cos (its angle turn * 1 / 2k is the same double).
    const cosFirst = Math.cos(turn / (2 * steps));
    const reach = radius / cosFirst;

    pointBase[p] = vertex;
    positions[vertex * 2] = px;
    positions[vertex * 2 + 1] = py;
    vertex++;
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const inner = side === 0 ? leftInner : !leftInner;
      const n = inner ? 1 : steps;
      if (side === 0) pointLeft[p] = n;
      else pointRight[p] = n;
      for (let j = 0; j < n; j++) {
        let ox: number;
        let oy: number;
        if (inner) {
          ox = bx * miter * radius;
          oy = by * miter * radius;
        } else {
          const a = (turn * (2 * j + 1)) / (2 * steps);
          const c = (j === 0 ? cosFirst : Math.cos(a)) * reach;
          const sn = Math.sin(a) * reach;
          ox = nix * c - niy * sn;
          oy = nix * sn + niy * c;
        }
        const o = vertex * 2;
        positions[o] = px + sign * ox;
        positions[o + 1] = py + sign * oy;
        vertex++;
      }
    }
  }

  const capBase = vertex;
  const caps = !closed && roundCaps && count >= 2;
  if (caps) {
    for (let cap = 0; cap < 2; cap++) {
      const p = cap === 0 ? 0 : count - 1;
      const px = points[p * 2] as number;
      const py = points[p * 2 + 1] as number;
      // Direction along the stroke at this end (falls back to +x for a degenerate stroke).
      let dx = 1;
      let dy = 0;
      for (let q = 1; q < count; q++) {
        const from = cap === 0 ? 0 : count - 1 - q;
        const to = cap === 0 ? q : count - 1;
        if (direction(points, from, to, IN)) {
          dx = dir[IN] as number;
          dy = dir[IN + 1] as number;
          break;
        }
      }
      const nx = -dy;
      const ny = dx;
      // Start cap sweeps from +n backwards (-d) to -n; end cap from +n forwards (+d) to -n.
      const along = cap === 0 ? -1 : 1;
      const block = vertex;
      positions[block * 2] = px;
      positions[block * 2 + 1] = py;
      for (let j = 0; j <= STROKE_CAP_STEPS; j++) {
        const c = CAP_COS[j] as number;
        const s = (CAP_SIN[j] as number) * along;
        const o = (block + 1 + j) * 2;
        positions[o] = px + (c * nx + s * dx) * radius;
        positions[o + 1] = py + (c * ny + s * dy) * radius;
      }
      vertex += CAP;
    }
  }

  // Topology (uvs and indices) follows only the join layout, the caps and the ramp coordinates:
  // when the caller's last build had the same, its buffers already hold exactly these values.
  // The ramp coordinates go through a typed scratch: doubles passed to a call that is not inlined
  // are boxed (one heap number each, per build; src/pixi/allocation.test.ts).
  rampNow[0] = uCentre;
  rampNow[1] = uRim;
  rampNow[2] = v;
  rampNow[3] = caps ? 1 : 0;
  rampNow[4] = count;
  rampNow[5] = closed ? 1 : 0;
  if (topology && topology.valid && sameTopology(topology, count)) {
    if (counts) {
      counts.vertices = vertex;
      counts.indices = strokeIndicesFor(count, closed, caps);
      counts.topologyChanged = false;
    }
    return vertex;
  }
  if (topology) storeTopology(topology, count);

  // UVs: each point's and cap block's centre at uCentre, every rim vertex at uRim.
  for (let p = 0; p < count; p++) {
    const c = pointBase[p] as number;
    const end = c + 1 + (pointLeft[p] as number) + (pointRight[p] as number);
    uvs[c * 2] = uCentre;
    uvs[c * 2 + 1] = v;
    for (let i = c + 1; i < end; i++) {
      uvs[i * 2] = uRim;
      uvs[i * 2 + 1] = v;
    }
  }
  for (let block = capBase; block < vertex; block += CAP) {
    uvs[block * 2] = uCentre;
    uvs[block * 2 + 1] = v;
    for (let j = 0; j <= STROKE_CAP_STEPS; j++) {
      const o = (block + 1 + j) * 2;
      uvs[o] = uRim;
      uvs[o + 1] = v;
    }
  }

  // Triangles: per point a fan from the centre over each rim run; per segment two half-quads (rim
  // to centreline on each side) from p's last rim vertex to q's first; then the cap fans.
  let k = 0;
  for (let p = 0; p < count; p++) {
    const c = pointBase[p] as number;
    const left = pointLeft[p] as number;
    const right = pointRight[p] as number;
    for (let j = 0; j + 1 < left; j++) {
      indices[k++] = c;
      indices[k++] = c + 1 + j;
      indices[k++] = c + 2 + j;
    }
    const r0 = c + 1 + left;
    for (let j = 0; j + 1 < right; j++) {
      indices[k++] = c;
      indices[k++] = r0 + j + 1;
      indices[k++] = r0 + j;
    }
  }
  const segments = closed ? count : count - 1;
  for (let p = 0; p < segments; p++) {
    const q = p + 1 === count ? 0 : p + 1;
    const cp = pointBase[p] as number;
    const cq = pointBase[q] as number;
    const leftP = pointLeft[p] as number;
    const lastLeft = cp + leftP;
    const lastRight = cp + leftP + (pointRight[p] as number);
    const firstRight = cq + 1 + (pointLeft[q] as number);
    indices[k++] = lastLeft;
    indices[k++] = cq + 1;
    indices[k++] = cq;
    indices[k++] = lastLeft;
    indices[k++] = cq;
    indices[k++] = cp;
    indices[k++] = lastRight;
    indices[k++] = firstRight;
    indices[k++] = cq;
    indices[k++] = lastRight;
    indices[k++] = cq;
    indices[k++] = cp;
  }
  if (caps) {
    for (let block = capBase; block < vertex; block += CAP) {
      for (let j = 0; j < STROKE_CAP_STEPS; j++) {
        indices[k++] = block;
        indices[k++] = block + 1 + j;
        indices[k++] = block + 2 + j;
      }
    }
  }
  if (counts) {
    counts.vertices = vertex;
    counts.indices = k;
    counts.topologyChanged = true;
  }
  return vertex;
}

/** Index count of the stroke just laid out: per point (left - 1) + (right - 1) fan triangles, 4 per segment, the cap fans. */
function strokeIndicesFor(count: number, closed: boolean, caps: boolean): number {
  let triangles = 4 * (closed ? count : count - 1) + (caps ? 2 * STROKE_CAP_STEPS : 0);
  for (let p = 0; p < count; p++) triangles += (pointLeft[p] as number) + (pointRight[p] as number) - 2;
  return triangles * 3;
}

// uCentre, uRim, v, caps, point count, closed of the build in progress (StrokeTopology.ramp).
const TOPOLOGY_KEY = 6;
const rampNow = new Float64Array(TOPOLOGY_KEY);

function sameTopology(topology: StrokeTopology, count: number): boolean {
  const ramp = topology.ramp;
  for (let i = 0; i < TOPOLOGY_KEY; i++) if (ramp[i] !== rampNow[i]) return false;
  const sides = topology.sides;
  if (sides.length < count * 2) return false;
  for (let p = 0; p < count; p++) {
    if (sides[p * 2] !== pointLeft[p] || sides[p * 2 + 1] !== pointRight[p]) return false;
  }
  return true;
}

function storeTopology(topology: StrokeTopology, count: number): void {
  const sides = topology.sides;
  topology.ramp.set(rampNow);
  topology.valid = sides.length >= count * 2;
  if (!topology.valid) return;
  for (let p = 0; p < count; p++) {
    sides[p * 2] = pointLeft[p] as number;
    sides[p * 2 + 1] = pointRight[p] as number;
  }
}

// ---------------------------------------------------------------------------------------------
// Authoring helper
// ---------------------------------------------------------------------------------------------

/**
 * Binds a canvas point to a mesh at its setup pose: the barycentric point `[a, b, c, wa, wb]` of
 * the triangle containing it (or, outside the mesh, of the nearest triangle, clamped onto it), or a
 * bare vertex index when the point is on a vertex. `world` holds the mesh's setup world vertices.
 */
export function bindPointToMesh(
  world: ArrayLike<number>,
  triangles: ArrayLike<number>,
  x: number,
  y: number
): number | [number, number, number, number, number] {
  let best: [number, number, number, number, number] | null = null;
  let bestDistance = Infinity;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t] as number;
    const b = triangles[t + 1] as number;
    const c = triangles[t + 2] as number;
    const ax = world[a * 2] as number, ay = world[a * 2 + 1] as number;
    const bx = world[b * 2] as number, by = world[b * 2 + 1] as number;
    const cx = world[c * 2] as number, cy = world[c * 2 + 1] as number;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    let wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    let wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    let wc = 1 - wa - wb;
    // Clamp onto the triangle and measure how far the point is from it.
    wa = Math.max(0, wa);
    wb = Math.max(0, wb);
    wc = Math.max(0, wc);
    const sum = wa + wb + wc;
    wa /= sum;
    wb /= sum;
    const qx = ax * wa + bx * wb + cx * (1 - wa - wb);
    const qy = ay * wa + by * wb + cy * (1 - wa - wb);
    const distance = Math.hypot(qx - x, qy - y);
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = [a, b, c, wa, wb];
    }
  }
  if (!best) throw new Error("the mesh has no non-degenerate triangle");
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const [a, b, c, wa, wb] = best;
  const ra = round(wa);
  const rb = round(Math.min(wb, 1 - ra));
  if (ra === 1) return a;
  if (rb === 1) return b;
  if (ra === 0 && rb === 0) return c;
  return [a, b, c, ra, rb];
}
