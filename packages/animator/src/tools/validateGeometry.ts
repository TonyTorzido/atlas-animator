/*
 * Atlas Animator: original implementation.
 *
 * Unified geometry evaluator: the one source of
 * truth for triangle deformation, called by `animator validate` (validate.ts) and by the surface
 * gates (surface/gates.ts) on poses run through the final runtime (`Skeleton`).
 *
 * Per mesh triangle, F is the 2x2 deformation gradient of the posed world triangle against its
 * setup (bind) world triangle. Measures:
 * - signed-area ratio det F (flip: < 0; collapse: [0, minDet); over-growth: > maxDet);
 * - principal stretches, the singular values of F (sigma1 >= sigma2): directional stretch and
 *   compression, which det F alone misses (10x by 0.1x has det 1);
 * - absolute error in game px: the largest change of an edge length of the triangle.
 * A stretch/compression finding needs both a principal stretch outside the triangle's region
 * allowance and an absolute error above the allowance's `absGamePx` (sub-pixel distortion of a tiny
 * bind triangle is invisible). The old edge rule (length ratio > 3 AND growth > 4 game px) is kept as
 * a diagnostic only.
 *
 * Regions, allowances and excused findings are rig data: a companion `<name>.validation.json` beside
 * the rig, hash-checked against the rig (bones, slots, skins, constraints: everything but clips), so
 * a stale companion is itself an error. Finding IDs are `<kind>/<slot>/<attachment>/t<triangle>`
 * (`edge-growth/.../e<i>-<j>` for the diagnostic), identical in both paths.
 */
import type { MeshAttachment } from "../core/attachments.js";
import { animDocumentSchema, type AnimDocument } from "../core/format.js";
import { Skeleton } from "../core/skeleton.js";

export interface DistortionAllowance {
  /** Signed-area floor: det F at or below it is a collapse (below 0 a flip). */
  minDet: number;
  /** Signed-area ceiling. */
  maxDet: number;
  /** Largest principal stretch. */
  maxStretch: number;
  /** Smallest principal stretch (compression). */
  minStretch: number;
  /** Stretch/compression only counts when an edge length changes by more than this (game px). */
  absGamePx: number;
}

/**
 * Defaults for a rig without a companion (canvas px = game px) and for undeclared regions: the old
 * validator's 2.2x stretch error, and compression to a quarter (the old validator judged none; a
 * companion region declares tighter limits).
 */
export const DEFAULT_ALLOWANCE: DistortionAllowance = { minDet: 0.2, maxDet: 5, maxStretch: 2.2, minStretch: 0.25, absGamePx: 0.5 };

/** The old edge rule, diagnostic only: length ratio above this AND growth above EDGE_GROWTH_GAME_PX. */
export const EDGE_GROWTH_RATIO = 3;
export const EDGE_GROWTH_GAME_PX = 4;

export const COMPANION_FORMAT = "atlas-animator-validation";

export interface ValidationCompanion {
  format: typeof COMPANION_FORMAT;
  version: 1;
  /** rigHash() of the rig this companion belongs to. */
  rigHash: string;
  /** Game px per canvas px. */
  gameScale: number;
  /** Allowance per region id ("default" applies to triangles of no region). */
  allowances: Record<string, DistortionAllowance>;
  /** Per mesh (`<slot>/<attachment>`): region of each triangle not in the mesh default, and the mesh default. */
  regions: Record<string, { default: string; triangles: Record<string, number[]> }>;
  /** Excused findings: exact IDs, or a prefix ending in `*`, each with its reason. */
  exceptions: { id: string; reason: string }[];
  /** Poses both validators evaluate (bone rotation deltas from the setup pose, degrees). */
  poses: { name: string; rotate: Record<string, number>; scale?: Record<string, { x: number; y: number }> }[];
}

export type FindingKind = "flip" | "collapse" | "overgrowth" | "stretch" | "compress" | "edge-growth";

export interface GeometryFinding {
  id: string;
  kind: FindingKind;
  /** error: a gate failure; excused: declared in the companion; diagnostic: the old edge rule. */
  severity: "error" | "excused" | "diagnostic";
  pose: string;
  mesh: string;
  region: string;
  /** det F (flip/collapse/overgrowth), the principal stretch (stretch/compress) or the edge ratio. */
  value: number;
  absGamePx: number;
}

export interface PoseStats {
  minDet: number;
  maxStretch: number;
  minStretch: number;
  /** Largest stretch among triangles whose edges also change by more than their absGamePx. */
  maxVisibleStretch: number;
  maxEdgeRatio: number;
  worst: string;
}

interface MeshBind {
  key: string;
  attachment: MeshAttachment;
  slotIndex: number;
  triangles: ArrayLike<number>;
  /** Per triangle: inverse of the bind edge matrix [e1 e2] (a, b, c, d), bind sign, bind edge lengths. */
  inv: Float64Array;
  sign: Int8Array;
  /** Triangles with (near) zero area at bind: no deformation gradient; always a collapse finding. */
  degenerate: Uint8Array;
  edges: Float64Array;
  region: string[];
}

/** FNV-1a over a string, two seeds: 16 hex chars (no crypto dependency, runs in the browser). */
function fnv(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Hash of everything in the rig but its clips: a companion is valid for any clip on the same rig.
 * Hashed on the normalized (parsed, defaults-filled, schema key order) document, so a raw document
 * and its loaded form hash alike.
 */
export function rigHash(doc: AnimDocument | Record<string, unknown>): string {
  const parsed = animDocumentSchema.safeParse(doc);
  const { animations: _clips, ...rest } = (parsed.success ? parsed.data : doc) as Record<string, unknown>;
  return fnv(JSON.stringify(rest));
}

/** Companion problems (stale hash, malformed): validation errors in both paths. */
export function companionProblems(doc: AnimDocument, companion: ValidationCompanion | undefined): string[] {
  if (!companion) return [];
  if (companion.format !== COMPANION_FORMAT || companion.version !== 1) return [`validation companion: unknown format ${String(companion.format)} v${String(companion.version)}`];
  const hash = rigHash(doc);
  return hash === companion.rigHash ? [] : [`validation companion is stale: rig hash ${hash}, companion declares ${companion.rigHash} (rebuild the rig to rewrite it)`];
}

const meshKey = (skeleton: Skeleton, slotIndex: number, attachment: MeshAttachment) => `${skeleton.slots[slotIndex]?.data.name ?? "?"}/${attachment.name}`;

/** Mesh attachments shown by the skeleton (each once, from the slot that owns it). */
function shownMeshes(skeleton: Skeleton): { slotIndex: number; attachment: MeshAttachment }[] {
  const seen = new Set<MeshAttachment>();
  const out: { slotIndex: number; attachment: MeshAttachment }[] = [];
  for (const slot of skeleton.slots) {
    const attachment = slot.attachment;
    if (!attachment || attachment.type !== "mesh" || seen.has(attachment)) continue;
    seen.add(attachment);
    out.push({ slotIndex: slot.index, attachment });
  }
  return out;
}

function worldOf(skeleton: Skeleton, slotIndex: number, attachment: MeshAttachment): ArrayLike<number> {
  return skeleton.meshWorldVertices(attachment, (skeleton.slots[slotIndex] as { bone: Parameters<Skeleton["meshWorldVertices"]>[1] }).bone);
}

/**
 * Bind data of every shown mesh at the skeleton's current pose (call on a setup-pose skeleton).
 */
export class GeometryEvaluator {
  private readonly binds: MeshBind[] = [];
  readonly gameScale: number;
  private readonly exceptions: { id: string; prefix: boolean }[];
  private readonly allowances: Record<string, DistortionAllowance>;

  constructor(setup: Skeleton, readonly companion?: ValidationCompanion) {
    this.gameScale = companion?.gameScale ?? 1;
    this.allowances = companion?.allowances ?? {};
    this.exceptions = (companion?.exceptions ?? []).map((e) => (e.id.endsWith("*") ? { id: e.id.slice(0, -1), prefix: true } : { id: e.id, prefix: false }));
    // A setup-pose twin (same document and skins) for attachments first shown after setup.
    this.bindSkeleton = new Skeleton(setup.document);
    if (setup.activeSkins.length) this.bindSkeleton.setActiveSkins(setup.activeSkins);
    this.bindSkeleton.setToSetupPose();
    this.bindSkeleton.updateWorldTransform("reset");
    for (const { slotIndex, attachment } of shownMeshes(setup)) this.register(setup, slotIndex, attachment);
  }

  private readonly bindSkeleton: Skeleton;
  private readonly bound = new Set<MeshAttachment>();

  /** Bind data of one mesh at `skeleton`'s current (setup) pose. */
  private register(skeleton: Skeleton, slotIndex: number, attachment: MeshAttachment, keyFrom: Skeleton = skeleton): void {
    if (this.bound.has(attachment)) return;
    this.bound.add(attachment);
    {
      const setup = skeleton;
      const key = meshKey(keyFrom, slotIndex, attachment);
      const triangles = attachment.geometry.triangles;
      const world = worldOf(setup, slotIndex, attachment);
      const n = Math.floor(triangles.length / 3);
      const inv = new Float64Array(n * 4);
      const sign = new Int8Array(n);
      const degenerate = new Uint8Array(n);
      const edges = new Float64Array(n * 3);
      const declared = this.companion?.regions[key];
      const region = Array.from({ length: n }, () => declared?.default ?? "default");
      for (const [name, list] of Object.entries(declared?.triangles ?? {})) for (const t of list) if (t < n) region[t] = name;
      for (let t = 0; t < n; t++) {
        const [ax, ay, bx, by, cx, cy] = corners(world, triangles, t);
        const e1x = bx - ax, e1y = by - ay, e2x = cx - ax, e2y = cy - ay;
        const det = e1x * e2y - e2x * e1y;
        sign[t] = det < 0 ? -1 : 1;
        degenerate[t] = Math.abs(det) <= 1e-9 * Math.max(1, e1x * e1x + e1y * e1y + e2x * e2x + e2y * e2y) ? 1 : 0;
        const d = Math.abs(det) > 1e-12 ? det : 1e-12;
        inv.set([e2y / d, -e2x / d, -e1y / d, e1x / d], t * 4);
        edges.set([Math.hypot(e1x, e1y), Math.hypot(cx - bx, cy - by), Math.hypot(e2x, e2y)], t * 3);
      }
      this.binds.push({ key, attachment, slotIndex, triangles, inv, sign, degenerate, edges, region });
    }
  }

  allowance(region: string): DistortionAllowance {
    return this.allowances[region] ?? this.allowances.default ?? DEFAULT_ALLOWANCE;
  }

  private excused(id: string): boolean {
    return this.exceptions.some((e) => (e.prefix ? id.startsWith(e.id) : id === e.id));
  }

  /**
   * Evaluates the skeleton's current pose. Findings are appended to `out`; returns the pose stats.
   * Every exercised mesh is judged: an attachment swapped in after setup is bound on first sight
   * against its setup-pose geometry.
   */
  evaluate(skeleton: Skeleton, pose: string, out: GeometryFinding[]): PoseStats {
    const stats: PoseStats = { minDet: Infinity, maxStretch: 1, minStretch: 1, maxVisibleStretch: 1, maxEdgeRatio: 1, worst: "" };
    let worstScore = 0;
    for (const { slotIndex, attachment } of shownMeshes(skeleton)) if (!this.bound.has(attachment)) this.register(this.bindSkeleton, slotIndex, attachment, skeleton);
    for (const bind of this.binds) {
      const slot = skeleton.slots[bind.slotIndex];
      if (!slot || slot.attachment !== bind.attachment) continue;
      const world = worldOf(skeleton, bind.slotIndex, bind.attachment);
      const n = bind.sign.length;
      for (let t = 0; t < n; t++) {
        const [ax, ay, bx, by, cx, cy] = corners(world, bind.triangles, t);
        const p1x = bx - ax, p1y = by - ay, p2x = cx - ax, p2y = cy - ay;
        const i = t * 4;
        const ia = bind.inv[i] as number, ib = bind.inv[i + 1] as number, ic = bind.inv[i + 2] as number, id = bind.inv[i + 3] as number;
        // F = P B^-1, with P = [p1 p2] and B^-1 = [[ia ib] [ic id]] (rows).
        const fa = p1x * ia + p2x * ic, fb = p1x * ib + p2x * id;
        const fc = p1y * ia + p2y * ic, fd = p1y * ib + p2y * id;
        const det = bind.degenerate[t] ? 0 : fa * fd - fb * fc;
        const [s1, s2] = singularValues(fa, fb, fc, fd);
        const e = t * 3;
        const posed = [Math.hypot(p1x, p1y), Math.hypot(cx - bx, cy - by), Math.hypot(p2x, p2y)];
        let abs = 0;
        let ratio = 1;
        for (let k = 0; k < 3; k++) {
          const rest = bind.edges[e + k] as number;
          abs = Math.max(abs, Math.abs((posed[k] as number) - rest) * this.gameScale);
          if (rest > 1e-9) ratio = Math.max(ratio, (posed[k] as number) / rest);
        }
        const region = bind.region[t] as string;
        const allow = this.allowance(region);
        stats.minDet = Math.min(stats.minDet, det);
        stats.maxStretch = Math.max(stats.maxStretch, s1);
        stats.minStretch = Math.min(stats.minStretch, s2);
        stats.maxEdgeRatio = Math.max(stats.maxEdgeRatio, ratio);
        const visible = abs > allow.absGamePx;
        if (visible) stats.maxVisibleStretch = Math.max(stats.maxVisibleStretch, s1);
        const push = (kind: FindingKind, value: number, diagnostic = false) => {
          const id = `${kind}/${bind.key}/t${t}`;
          out.push({ id, kind, severity: diagnostic ? "diagnostic" : this.excused(id) ? "excused" : "error", pose, mesh: bind.key, region, value: round(value), absGamePx: round(abs) });
        };
        if (det < allow.minDet) push(det < 0 ? "flip" : "collapse", det);
        else if (det > allow.maxDet) push("overgrowth", det);
        else if (visible && s1 > allow.maxStretch) push("stretch", s1);
        else if (visible && s2 < allow.minStretch) push("compress", s2);
        if (ratio > EDGE_GROWTH_RATIO && abs > EDGE_GROWTH_GAME_PX) push("edge-growth", ratio, true);
        const score = Math.max(s1 / allow.maxStretch, allow.minStretch / Math.max(s2, 1e-9), allow.minDet / Math.max(det, 1e-9)) * (visible ? 1 : 0.5);
        if (score > worstScore) {
          worstScore = score;
          stats.worst = `${bind.key} t${t} (${region}): det ${det.toFixed(3)}, stretches ${s1.toFixed(2)}/${s2.toFixed(2)}, edge change ${abs.toFixed(2)} game px`;
        }
      }
    }
    return stats;
  }
}

function corners(world: ArrayLike<number>, triangles: ArrayLike<number>, t: number): [number, number, number, number, number, number] {
  const a = (triangles[t * 3] as number) * 2, b = (triangles[t * 3 + 1] as number) * 2, c = (triangles[t * 3 + 2] as number) * 2;
  return [world[a] as number, world[a + 1] as number, world[b] as number, world[b + 1] as number, world[c] as number, world[c + 1] as number];
}

/** Singular values (descending) of the 2x2 matrix [[a b] [c d]]. */
export function singularValues(a: number, b: number, c: number, d: number): [number, number] {
  const e = (a + d) / 2, f = (a - d) / 2, g = (c + b) / 2, h = (c - b) / 2;
  const q = Math.hypot(e, h), r = Math.hypot(f, g);
  return [q + r, Math.abs(q - r)];
}

const round = (x: number) => Number(x.toFixed(4));

/** The findings that fail validation (errors only; excused and diagnostic findings are reported). */
export const failing = (findings: readonly GeometryFinding[]) => findings.filter((f) => f.severity === "error");

/** Stable comparison key of a finding (ID + pose): both validators must produce the same set. */
export const findingKey = (f: GeometryFinding) => `${f.id}@${f.pose}`;
