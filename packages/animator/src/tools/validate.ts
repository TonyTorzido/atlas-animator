/*
 * Atlas Animator: original implementation.
 *
 * Rig validators (plan 3, Validators; 4.5.6 clipping check; 4.7 budgets). A machine-checkable
 * quality bar that runs before the user looks:
 *
 * - format:   the loader's own errors and warnings (schema and cross references);
 * - weights:  every weighted vertex sums to 1 (1e-3), no bone twice, no zero weight, every vertex
 *             used by a triangle (no orphans);
 * - mesh:     no degenerate triangle (error), no sliver under `minAngle` degrees in a mesh that
 *             bends (warning; a mesh on one bone never pinches);
 * - limits:   no rotate key asks a limited bone for more than its limits (it would be clamped);
 * - chains:   the limits along a chain must not add up to more than a front-only drawing can
 *             show: summed one-way limits of the bones that carry the end bone's pivot (the
 *             start and end bones excluded) within the declared budgets (the preset's or the
 *             document's `budgets.chains`; warning; chains whose bones are missing are skipped);
 * - physics:  strength <= fps^2 (semi-implicit Euler stability, Phase 3 review);
 * - budget:   the declared body, item and dressed (body + the `maxItems` largest items) vertex
 *             budgets (preset or document; none declared = a warning), bones <= 40;
 * - atlas:    every texture path the rig draws has a region, pages within count and size;
 * - bounds:   nothing leaves the canvas at the setup pose or at `samples` times of every clip,
 *             for every outfit: the body alone, the body with each other skin, and every declared
 *             combination (`outfits`);
 * - clipping: for each outfit with items, body texels that the items' slots hide at the setup pose
 *             (shrunk by 2 canvas px, the tolerance of 4.5.6) must never be the visible top texel
 *             at any sampled time of any clip; zero flagged pixels at 1x is the bar. Needs the
 *             textures.
 *
 * - tears: on every review pose (rigPoses: derived from the rig) and clip sample, body alone and with each skin:
 *             enclosed background holes inside the figure that were mostly figure at rest and
 *             are bordered only by parts that touch at rest (error; a fist closing on the hip or
 *             a hand near the head encloses a gap, not a tear); parts that touch at rest
 *             (pieces named `<part>.<piece>` count as that part) keep at least half their rest
 *             contact and never lose it (error, "joint opened"; for a ball-and-socket joint
 *             only the contact within the cap round the pivot counts); edge length ratios are
 *             reported only (the geometry check judges distortion); on the review poses, rendered at 3x, a
 *             background pixel with figure within 2 px on all four sides (a hairline crack or
 *             speck; the narrow tip of an open notch, such as a bent elbow, is not one; error); a
 *             texel of a part (not a generated `<part>.<piece>`) hidden at rest and drawn as
 *             outline ink 4 px or more inside the silhouette, across that part's own fill (buried
 *             ink: a rim meant for an edge showing across solid skin; error; outlines revealed
 *             on the silhouette or beside another part, and clothing bands, pass). Needs the
 *             textures.
 *
 * - geometry: the unified evaluator (validateGeometry.ts, shared with the surface
 *             gates): per triangle signed-area ratio (flip / collapse below 0.2), principal
 *             stretches with region allowances and an absolute edge change in game px, at the
 *             companion's poses (else the review poses) and the clip samples; the companion is
 *             hash-checked; the old edge rule (ratio > 3 and > 4 game px) is a diagnostic warning.
 *
 * Clip sampling plays each clip from the setup pose at 60 Hz with physics running, so dangly
 * skins are judged in motion, and reads the pose at `samples` evenly spaced times.
 */
import { AnimationState, AnimationStateData } from "../core/animationState.js";
import type { AtlasPack } from "../core/atlasPack.js";
import { attachmentTexturePaths, isDrawable, type MeshAttachment } from "../core/attachments.js";
import { DEFAULT_CLIP_FPS, MAX_VERTEX_INFLUENCES, meshVertexCount, type AnimDocument, type MeshAttachmentData, type RigBudgetsData } from "../core/format.js";
import { inContactBand } from "./contactBand.js";
import { leanSplitOk, outsideDistance } from "./liveLimits.js";
import { MAX_IK_REACH, ikReachViolationsInOutfits } from "./ikReach.js";
import { bandEligible, bandOutfits } from "./bandOwnership.js";
import { formatIssuePath, parseAnimDocument } from "../core/formatLoader.js";
import type { IssuePath } from "../core/formatReferences.js";
import { Skeleton } from "../core/skeleton.js";
import { drivenValue } from "../core/driven.js";
import { triangleAngles } from "./autoMesh.js";
import { createMask, cropImage, dilateMask, erodeMask, type RgbaImage } from "./image.js";
import { isInk } from "./image.js";
import { poseSkeleton, type ReviewPose } from "./review.js";
import { rigPoses } from "./rigPoses.js";
import { authoringJoints, validateAuthoring } from "./authoring.js";
import { mergeBudgets, type BodyPreset, type ChainBudget } from "./bodyPreset.js";
import { softRender, worldScratch } from "./softRender.js";
import { companionProblems, EDGE_GROWTH_GAME_PX, EDGE_GROWTH_RATIO, findingKey, GeometryEvaluator, type GeometryFinding, type ValidationCompanion } from "./validateGeometry.js";

export type ValidationCheck = "format" | "weights" | "mesh" | "limits" | "contacts" | "chains" | "physics" | "budget" | "atlas" | "bounds" | "clipping" | "tears" | "geometry" | "authoring";

export interface ValidationIssue {
  severity: "error" | "warning";
  check: ValidationCheck;
  message: string;
  path?: IssuePath;
}

export interface RigBudgets {
  /** Vertex budgets: undefined = not judged (no generic default; a preset or the document declares them). */
  bodyVertices: number | undefined;
  itemVertices: number | undefined;
  dressedVertices: number | undefined;
  /** Items worn at once for the dressed budget (undefined = every item). */
  maxItems: number | undefined;
  bones: number;
  atlasPages: number;
  pageSize: number;
}

/**
 * Generic defaults (any rig): engine limits only. Vertex budgets and chain budgets come from the
 * body preset or the document's `budgets`.
 */
export const DEFAULT_BUDGETS: RigBudgets = {
  bodyVertices: undefined,
  itemVertices: undefined,
  dressedVertices: undefined,
  maxItems: undefined,
  bones: 40,
  atlasPages: 1,
  pageSize: 2048
};

/** Declared budgets: the preset, then the document's `budgets`, then explicit option budgets. */
export function resolveBudgets(doc: AnimDocument, options: ValidateOptions): RigBudgetsData {
  return mergeBudgets(options.preset?.budgets, doc.budgets, options.budgets as RigBudgetsData | undefined);
}

/**
 * A declared joint between two parts (slot names; sub-pieces like `<part>.rim` count as their
 * part). The tears contact rule ("parts that touch at rest keep at least half that contact")
 * applies only to declared joints, so incidental contacts (a body on a base plate, a fist on the
 * hip) are not judged. With `pivotBone` and `radius` it is a ball-and-socket joint: the child's
 * root is a cap round the pivot bone's origin, and its contact with the parent is judged only
 * within `radius` of the pivot (the rest of the child's seam is meant to leave the parent).
 */
export interface RigJoint {
  parent: string;
  child: string;
  pivotBone?: string;
  radius?: number;
}

export interface ValidateOptions {
  /**
   * Declared joints. Omitted: the document's authoring block (`authoring.joints` plus the slot
   * pairs across welded/overlap connections, authoring.ts `authoringJoints`). With none the tears
   * check runs holes, hairlines, stretch and buried ink only (no joint-contact rule).
   */
  joints?: readonly RigJoint[];
  /** Chain budgets (default: the preset's or document's `budgets.chains`, else none). */
  chainBudgets?: readonly ChainBudget[];
  /** The skin every outfit starts from (default "body"). */
  bodySkin?: string;
  /** Explicit budgets, over the document's and the preset's (CLI flags). */
  budgets?: Partial<RigBudgets>;
  /** The body preset the rig was built from: its budgets and review poses. */
  preset?: BodyPreset;
  /**
   * Declared outfit combinations checked besides the body alone and the body with each item:
   * lists of item skins worn together (the body skin is implied), e.g. [["tunic", "cape"]].
   */
  outfits?: readonly (readonly string[])[];
  /** Sampled times per clip for bounds and clipping (default 6). */
  samples?: number;
  /** Smallest acceptable triangle angle (default 15). */
  minAngle?: number;
  /** The atlas sidecar, for the atlas check. */
  atlas?: AtlasPack;
  /** Images per texture path (full image = UV 0..1), for the clipping check. */
  textures?: ReadonlyMap<string, RgbaImage>;
  /** Clipping tolerance, canvas px (default 2). */
  clippingTolerance?: number;
  /** Run the tears check (default true when textures are given). */
  tears?: boolean;
  /** Poses the tears check judges besides the clip samples (default: rigPoses, derived from the rig's hierarchy, roles and limits). */
  poses?: readonly ReviewPose[];
  /**
   * The rig's validation companion (`<name>.validation.json`): triangle regions,
   * distortion allowances, excused findings and the poses the geometry check evaluates (instead of
   * `poses`), hash-checked against the rig. Without it the geometry check uses DEFAULT_ALLOWANCE
   * with canvas px as game px.
   */
  companion?: ValidationCompanion | undefined;
}

export interface ValidationReport {
  ok: boolean;
  document: AnimDocument | null;
  issues: ValidationIssue[];
  /** Clipping: flagged pixels per skin, clip and sample time (for reports). */
  clipping: { skin: string; clip: string; time: number; flagged: number }[];
  /**
   * Tears: per outfit and judged pose, holes, worst edge stretch, hairline pixels at 3x (review
   * poses only, else 0), buried hidden-ink pixels and error count.
   */
  tears: { outfit: string; pose: string; holes: number; stretch: number; hairlines: number; buriedInk: number; errors: number }[];
  /**
   * Geometry (unified evaluator, validateGeometry.ts): findings (errors and excused, one per ID and
   * pose label; companion poses are labelled like the surface gates' sweep frames), the count of
   * diagnostic old-rule edge findings, the largest visible principal stretch and edge ratio.
   */
  geometry: { findings: GeometryFinding[]; diagnostics: number; maxVisibleStretch: number; maxEdgeRatio: number; worst: string };
}

export function validateRig(raw: unknown, options: ValidateOptions = {}): ValidationReport {
  const issues: ValidationIssue[] = [];
  const loaded = parseAnimDocument(raw);
  if (!loaded.ok) {
    for (const issue of loaded.issues) issues.push({ severity: issue.severity, check: "format", message: issue.message, path: issue.path });
    return { ok: false, document: null, issues, clipping: [], tears: [], geometry: emptyGeometry() };
  }
  const doc = loaded.document;
  for (const issue of loaded.warnings) {
    if (issue.message.includes("exceeds fps^2")) continue; // repeated by the physics check below
    issues.push({ severity: issue.severity, check: "format", message: issue.message, path: issue.path });
  }
  // Preset review poses stand in for the rig-derived ones unless poses are given.
  if (options.poses === undefined && options.preset?.reviewPoses) options = { ...options, poses: options.preset.reviewPoses };
  const declared = resolveBudgets(doc, options);
  const budgets: RigBudgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(budgets) as (keyof RigBudgets)[]) {
    const value = declared[key];
    if (value !== undefined) budgets[key] = value;
  }
  for (const issue of validateAuthoring(doc)) issues.push({ severity: issue.severity, check: "authoring", message: issue.message });
  checkMeshes(doc, options.minAngle ?? 15, issues);
  checkLimits(doc, issues);
  checkPoseLimits(doc, issues);
  checkChains(doc, options.chainBudgets ?? declared.chains ?? [], issues);
  checkPhysics(doc, issues);
  checkBudgets(doc, options.bodySkin ?? "body", budgets, issues);
  checkOutfits(doc, options.outfits ?? [], issues);
  if (options.atlas) checkAtlas(doc, options.atlas, budgets, issues);
  checkBounds(doc, options, issues);
  const clipping = options.textures ? checkClipping(doc, options, options.textures, issues) : [];
  const tears = options.textures && options.tears !== false ? checkTears(doc, options, options.textures, issues) : [];
  const geometry = checkGeometry(doc, options, issues);
  return { ok: !issues.some((issue) => issue.severity === "error"), document: doc, issues, clipping, tears, geometry };
}

const emptyGeometry = (): ValidationReport["geometry"] => ({ findings: [], diagnostics: 0, maxVisibleStretch: 1, maxEdgeRatio: 1, worst: "" });

/**
 * Geometry: the unified evaluator on every outfit, at the companion's poses (else the
 * review poses) and the clip samples. One issue per failing finding ID (its poses counted); excused
 * findings are warnings; the old edge rule (ratio > 3 and > 4 game px) is reported, never an error.
 */
function checkGeometry(doc: AnimDocument, options: ValidateOptions, issues: ValidationIssue[]): ValidationReport["geometry"] {
  const report = emptyGeometry();
  for (const message of companionProblems(doc, options.companion)) issues.push({ severity: "error", check: "geometry", message });
  const poses = options.companion?.poses ?? (options.poses ?? rigPoses(doc, { bend: resolveBudgets(doc, options).bend })).map((p) => ({ name: `pose '${p.name}'`, rotate: p.rotate, ...(p.ikMix !== undefined ? { ikMix: p.ikMix } : {}) }));
  const seen = new Set<string>();
  const byId = new Map<string, { finding: GeometryFinding; poses: number; worst: GeometryFinding }>();
  for (const outfit of outfits(doc, options.bodySkin ?? "body", options.outfits)) {
    const evaluator = new GeometryEvaluator(poseSkeleton(doc, outfit, null), options.companion);
    const judge = (skeleton: Skeleton, label: string) => {
      const found: GeometryFinding[] = [];
      const st = evaluator.evaluate(skeleton, label, found);
      if (st.maxVisibleStretch > report.maxVisibleStretch) Object.assign(report, { maxVisibleStretch: st.maxVisibleStretch, worst: `${label}: ${st.worst}` });
      report.maxEdgeRatio = Math.max(report.maxEdgeRatio, st.maxEdgeRatio);
      for (const finding of found) {
        if (finding.severity === "diagnostic") {
          report.diagnostics++;
          continue;
        }
        if (seen.has(findingKey(finding))) continue;
        seen.add(findingKey(finding));
        report.findings.push(finding);
        const entry = byId.get(finding.id);
        if (!entry) byId.set(finding.id, { finding, poses: 1, worst: finding });
        else {
          entry.poses++;
          if (Math.abs(Math.log(Math.max(finding.value, 1e-9))) > Math.abs(Math.log(Math.max(entry.worst.value, 1e-9)))) entry.worst = finding;
        }
      }
    };
    for (const pose of poses) judge(poseSkeleton(doc, outfit, pose), pose.name);
    samplePoses(doc, outfit, options.samples ?? 6, (skeleton, clip, time) => {
      if (clip !== null) judge(skeleton, `'${clip}' at ${time.toFixed(2)}s`);
    });
  }
  for (const { finding, poses: count, worst } of byId.values()) {
    issues.push({
      severity: finding.severity === "error" ? "error" : "warning",
      check: "geometry",
      path: ["skins"],
      message: `${finding.id} (${finding.region}${finding.severity === "excused" ? ", excused" : ""}): ${finding.kind} ${worst.value} at ${worst.pose}, edge change ${worst.absGamePx} game px (${count} pose(s))`
    });
  }
  if (report.diagnostics > 0) issues.push({ severity: "warning", check: "geometry", message: `diagnostic only: ${report.diagnostics} triangle-pose(s) with an edge over ${EDGE_GROWTH_RATIO}x and ${EDGE_GROWTH_GAME_PX} game px longer than at rest (largest ratio ${report.maxEdgeRatio.toFixed(2)})` });
  return report;
}

export function formatValidationIssue(issue: ValidationIssue): string {
  const where = issue.path ? `${formatIssuePath(issue.path)}: ` : "";
  return `${issue.severity === "warning" ? "warning" : "error"} [${issue.check}] ${where}${issue.message}`;
}

// ---------------------------------------------------------------------------------------------

function* meshes(doc: AnimDocument): Generator<{ skin: string; slot: string; name: string; mesh: MeshAttachmentData; path: IssuePath }> {
  for (const [skin, data] of Object.entries(doc.skins)) {
    for (const [slot, placeholders] of Object.entries(data.attachments)) {
      for (const [name, attachment] of Object.entries(placeholders)) {
        if (attachment.type === "mesh") yield { skin, slot, name, mesh: attachment, path: ["skins", skin, "attachments", slot, name] };
      }
    }
  }
}

function checkMeshes(doc: AnimDocument, minAngle: number, issues: ValidationIssue[]): void {
  for (const { mesh, path } of meshes(doc)) {
    const vertexCount = meshVertexCount(mesh);
    const used = new Uint8Array(vertexCount);
    for (const v of mesh.triangles) used[v] = 1;
    const orphans = used.reduce((count, u) => count + (u ? 0 : 1), 0);
    if (orphans > 0) issues.push({ severity: "error", check: "weights", path, message: `${orphans} vertices are not used by any triangle (orphan vertices)` });

    // Triangle shape, in the image's own space (UV x size), which is the bind shape.
    let slivers = 0;
    let worst = 180;
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      const corner = (k: number) => {
        const v = mesh.triangles[t + k] as number;
        return [(mesh.uvs[v * 2] as number) * mesh.width, (mesh.uvs[v * 2 + 1] as number) * mesh.height] as const;
      };
      const [ax, ay] = corner(0);
      const [bx, by] = corner(1);
      const [cx, cy] = corner(2);
      const doubleArea = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
      if (doubleArea < 1e-6) {
        issues.push({ severity: "error", check: "mesh", path: [...path, "triangles", t], message: `triangle ${t / 3} is degenerate (zero area)` });
        continue;
      }
      const angle = Math.min(...triangleAngles(ax, ay, bx, by, cx, cy));
      worst = Math.min(worst, angle);
      if (angle < minAngle) slivers++;
    }
    // A mesh on one bone never bends, so thin triangles there cannot pinch (rim strips).
    const rigid = !mesh.bones || meshBoneSet(mesh).size <= 1;
    if (slivers > 0 && !rigid) {
      issues.push({
        severity: "warning",
        check: "mesh",
        path,
        message: `${slivers} sliver triangle(s) under ${minAngle} degrees (smallest ${worst.toFixed(1)}); they pinch when the mesh bends`
      });
    }

    if (!mesh.bones) continue;
    let cursor = 0;
    for (let v = 0; v < vertexCount; v++) {
      const count = mesh.vertices[cursor++] as number;
      let sum = 0;
      const seen = new Set<number>();
      for (let k = 0; k < count; k++, cursor += 4) {
        const bone = mesh.vertices[cursor] as number;
        const weight = mesh.vertices[cursor + 3] as number;
        sum += weight;
        if (seen.has(bone)) issues.push({ severity: "error", check: "weights", path: [...path, "vertices"], message: `vertex ${v} lists bone '${mesh.bones[bone]}' twice` });
        seen.add(bone);
        if (weight === 0) issues.push({ severity: "warning", check: "weights", path: [...path, "vertices"], message: `vertex ${v} has a zero weight for '${mesh.bones[bone]}' (prune it)` });
      }
      if (count > MAX_VERTEX_INFLUENCES) {
        issues.push({ severity: "error", check: "weights", path: [...path, "vertices"], message: `vertex ${v} has ${count} influences (max ${MAX_VERTEX_INFLUENCES})` });
      }
      if (Math.abs(sum - 1) > 1e-3) {
        issues.push({ severity: "error", check: "weights", path: [...path, "vertices"], message: `vertex ${v} weights sum to ${sum.toFixed(4)}, not 1` });
      }
    }
  }
}

/** The mesh bone indices any vertex actually uses with a non-zero weight. */
function meshBoneSet(mesh: MeshAttachmentData): Set<number> {
  const used = new Set<number>();
  let cursor = 0;
  for (let v = 0; v < meshVertexCount(mesh); v++) {
    const count = mesh.vertices[cursor++] as number;
    for (let k = 0; k < count; k++, cursor += 4) if ((mesh.vertices[cursor + 3] as number) > 0) used.add(mesh.vertices[cursor] as number);
  }
  return used;
}

function checkLimits(doc: AnimDocument, issues: ValidationIssue[]): void {
  const bones = new Map(doc.bones.map((bone) => [bone.name, bone]));
  for (const [clipName, clip] of Object.entries(doc.animations)) {
    for (const [boneName, timelines] of Object.entries(clip.bones)) {
      const limits = bones.get(boneName)?.limits;
      if (!limits || !timelines.rotate) continue;
      timelines.rotate.forEach((key, k) => {
        if (key.value < limits.min - 1e-6 || key.value > limits.max + 1e-6) {
          issues.push({
            severity: "error",
            check: "limits",
            path: ["animations", clipName, "bones", boneName, "rotate", k],
            message: `rotate ${key.value} at ${key.time}s is outside the limits [${limits.min}, ${limits.max}] of '${boneName}' (it would be clamped)`
          });
        }
      });
    }
  }
}

/** Points inside a limit polygon (either winding, convex or not) within a small tolerance. */
function insideConvex(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  return outsideDistance(poly, [x, y]) <= 1e-4;
}

/**
 * Times (clip seconds) of the poses the held-frame cache displays: frame k at k / fps from the
 * clip start. A loop keeps cycling at the same rate, so when the duration is not a whole number of
 * frames every phase is displayed in turn: loops are sampled until the frame phase repeats (at most
 * 64 cycles); the clip time is wrapped by the runtime. This is the frame set every held phase
 * shares: AnimationState.heldPhase moves only when each frame starts (heldClipTime still returns
 * k / fps), never which clip times are shown, so certifying these times certifies both phases.
 */
export function displayedFrameTimes(clip: { duration: number; loop: boolean; fps?: number | undefined }): number[] {
  const fps = clip.fps ?? DEFAULT_CLIP_FPS;
  const frames = clip.duration * fps;
  if (!clip.loop || clip.duration <= 0) {
    const out: number[] = [];
    for (let k = 0; k <= Math.floor(frames + 1e-9); k++) out.push(k / fps);
    if (out[out.length - 1] !== clip.duration && clip.duration > 0) out.push(clip.duration);
    return out;
  }
  const out: number[] = [];
  let cycles = 1;
  while (cycles < 64 && Math.abs(frames * cycles - Math.round(frames * cycles)) > 1e-6) cycles++;
  const total = Math.ceil(frames * cycles - 1e-9);
  for (let k = 0; k < Math.max(1, total); k++) out.push(k / fps);
  return out;
}

/**
 * Combined pose limits (pass 3d-1) and contact bands. Every clip is played
 * through the runtime (mixing on its track, IK and constraints applied):
 * - limits: its key times and 8 steps between them; a pose whose driver pair lies outside a declared
 *   polygon is an error (the runtime never clamps, so the clip itself must stay inside);
 * - contact bands: every pose the held-frame cache displays at the clip's fps (loops included);
 *   motion may jump across a band between displayed frames, but a displayed pose inside a band (under
 *   its measurement condition) is an error. Displayed samples are checked, never projected.
 */
export function checkPoseLimits(doc: AnimDocument, issues: ValidationIssue[]): void {
  const limits = doc.poseLimits ?? [];
  const bands = doc.contactBands ?? [];
  if (!limits.length && !bands.length && !doc.ik.length) return;
  const data = new AnimationStateData(doc);
  const pose = (skeleton: Skeleton, clipName: string, loop: boolean, time: number) => {
    skeleton.setToSetupPose();
    const state = new AnimationState(data);
    state.setAnimation(0, clipName, { loop });
    state.update(time);
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
  };
  for (const [clipName, clip] of Object.entries(doc.animations)) {
    const skeleton = new Skeleton(doc);
    // Hard IK reach (r3): every displayed frame keeps two-bone targets within MAX_IK_REACH.
    if (doc.ik.length) {
      let count = 0;
      let first: string | null = null;
      // Every outfit (as the live check): a skin chain is checked where its skin is worn.
      const outfits = bandOutfits(doc);
      for (const time of displayedFrameTimes(clip)) {
        for (const r of ikReachViolationsInOutfits(skeleton, outfits, () => pose(skeleton, clipName, false, time))) {
          count++;
          first ??= `t ${time.toFixed(3)}s ${r.name} reach ${r.ratio.toFixed(3)}`;
        }
      }
      if (count) issues.push({ severity: "error", check: "limits", path: ["animations", clipName], message: `${count} IK samples past ${MAX_IK_REACH} of the chain reach (first ${first}); IK is hard, keep targets inside` });
    }
    if (limits.length) {
      const times = new Set<number>([0, clip.duration]);
      for (const timelines of Object.values(clip.bones)) for (const key of timelines.rotate ?? []) times.add(key.time);
      const sorted = [...times].sort((a, b) => a - b);
      const samples: number[] = [];
      sorted.forEach((t, i) => {
        const next = sorted[i + 1];
        for (let k = 0; k < (next === undefined ? 1 : 8); k++) samples.push(next === undefined ? t : t + ((next - t) * k) / 8);
      });
      for (const limit of limits) {
        let first: string | null = null;
        let count = 0;
        for (const time of samples) {
          pose(skeleton, clipName, false, time);
          const x = drivenValue(skeleton.getBone(limit.x));
          const y = drivenValue(skeleton.getBone(limit.y)) + (limit.plus ?? []).reduce((s, b) => s + drivenValue(skeleton.getBone(b)), 0);
          const split: Record<string, number> = {};
          for (const b of [limit.y, ...(limit.plus ?? [])]) split[b] = drivenValue(skeleton.getBone(b));
          if (insideConvex(limit.polygon, x, y) && leanSplitOk(limit, split)) continue;
          count++;
          first ??= `t ${time.toFixed(3)}s (${limit.x} ${x.toFixed(1)}, ${limit.y} ${y.toFixed(1)})`;
        }
        if (count) {
          issues.push({ severity: "error", check: "limits", path: ["animations", clipName], message: `${count} sampled poses are outside pose limit '${limit.name}' (first ${first}); the runtime does not clamp` });
        }
      }
    }
    if (bands.length) {
      const names = [...new Set(bands.flatMap((b) => [b.x, b.y, ...Object.keys(b.when ?? {})]))].filter((n) => skeleton.findBone(n));
      const frames = displayedFrameTimes(clip);
      const hits = new Map<string, { count: number; first: string }>();
      // Ownership: a band measured between two contours gates only
      // while both draw, judged per outfit (body alone, body + each skin), so an overridden garment's
      // bands still gate in the outfit that shows it. Bands without a pair gate once, as before.
      const gated = bands.some((b) => b.contours);
      const outfitList = gated ? bandOutfits(doc) : [null];
      outfitList.forEach((outfit, oi) => {
        if (outfit) skeleton.setActiveSkins(outfit);
        for (const time of frames) {
          pose(skeleton, clipName, clip.loop, time);
          const drivers: Record<string, number> = {};
          for (const n of names) drivers[n] = drivenValue(skeleton.getBone(n));
          for (const band of bands) {
            if (oi > 0 && !band.contours) continue; // ungated bands: counted in the first outfit only
            if (!bandEligible(skeleton, band, drivers)) continue;
            const h = hits.get(band.name);
            if (h) h.count++;
            else hits.set(band.name, { count: 1, first: `t ${time.toFixed(3)}s${outfit ? ` in outfit ${outfit.join("+")}` : ""} (${band.x} ${(drivers[band.x] ?? 0).toFixed(1)}, ${band.y} ${(drivers[band.y] ?? 0).toFixed(1)})` });
          }
        }
      });
      for (const [name, h] of hits) {
        issues.push({ severity: "error", check: "contacts", path: ["animations", clipName], message: `${h.count} displayed frame${h.count === 1 ? "" : "s"} (at ${clip.fps ?? DEFAULT_CLIP_FPS} fps) sit in contact band '${name}' (first ${h.first}); a displayed pose may not hold a contact crack` });
      }
    }
  }
}

function checkChains(doc: AnimDocument, chains: readonly { from: string; to: string; budget: number }[], issues: ValidationIssue[]): void {
  const bones = new Map(doc.bones.map((bone) => [bone.name, bone]));
  for (const chain of chains) {
    const end = bones.get(chain.to);
    if (!end || !bones.has(chain.from)) continue;
    let positive = 0;
    let negative = 0;
    let found = false;
    for (let bone = end.parent ? bones.get(end.parent) : undefined; bone; bone = bone.parent ? bones.get(bone.parent) : undefined) {
      if (bone.name === chain.from) {
        found = true;
        break;
      }
      // An unlimited bone can turn all the way.
      positive += bone.limits ? Math.max(0, bone.limits.max) : 180;
      negative += bone.limits ? Math.max(0, -bone.limits.min) : 180;
    }
    if (!found) continue;
    const worst = Math.max(positive, negative);
    if (worst > chain.budget) {
      issues.push({
        severity: "warning",
        check: "chains",
        path: ["bones"],
        message: `limits from '${chain.from}' to '${chain.to}' add up to ${worst} degrees one way (budget ${chain.budget})`
      });
    }
  }
}

function checkPhysics(doc: AnimDocument, issues: ValidationIssue[]): void {
  doc.physics.forEach((physics, i) => {
    if (physics.strength > physics.fps * physics.fps) {
      issues.push({
        severity: "warning",
        check: "physics",
        path: ["physics", i, "strength"],
        message: `strength ${physics.strength} exceeds fps^2 (${physics.fps * physics.fps}); the spring rings or explodes (raise fps or lower strength)`
      });
    }
  });
}

function skinVertexCount(doc: AnimDocument, skin: string): number {
  let count = 0;
  for (const placeholders of Object.values(doc.skins[skin]?.attachments ?? {})) {
    for (const attachment of Object.values(placeholders)) {
      if (attachment.type === "mesh") count += meshVertexCount(attachment);
      else if (attachment.type === "region") count += 4;
      else if (attachment.type === "linkedMesh") {
        const source = doc.skins[attachment.source.skin]?.attachments[attachment.source.slot]?.[attachment.source.attachment];
        if (source?.type === "mesh") count += meshVertexCount(source);
      }
    }
  }
  return count;
}

function checkBudgets(doc: AnimDocument, bodySkin: string, budgets: RigBudgets, issues: ValidationIssue[]): void {
  const body = skinVertexCount(doc, bodySkin);
  if (budgets.bodyVertices === undefined && budgets.dressedVertices === undefined) {
    issues.push({ severity: "warning", check: "budget", message: `no vertex budget declared (the body has ${body} vertices): declare budgets in the document (doc.set budgets) or validate with a body preset` });
  }
  if (budgets.bodyVertices !== undefined && body > budgets.bodyVertices) {
    issues.push({ severity: "error", check: "budget", path: ["skins", bodySkin], message: `the body has ${body} vertices (budget ${budgets.bodyVertices})` });
  }
  const items = Object.keys(doc.skins)
    .filter((skin) => skin !== bodySkin)
    .map((skin) => ({ skin, count: skinVertexCount(doc, skin) }));
  for (const item of items) {
    if (budgets.itemVertices !== undefined && item.count > budgets.itemVertices) {
      issues.push({ severity: "error", check: "budget", path: ["skins", item.skin], message: `skin '${item.skin}' has ${item.count} vertices (budget ${budgets.itemVertices})` });
    }
  }
  const worn = budgets.maxItems ?? items.length;
  const dressed = body + items.map((item) => item.count).sort((a, b) => b - a).slice(0, worn).reduce((s, c) => s + c, 0);
  if (budgets.dressedVertices !== undefined && dressed > budgets.dressedVertices) {
    issues.push({ severity: "error", check: "budget", message: `the body with its ${worn} largest skins has ${dressed} vertices (budget ${budgets.dressedVertices})` });
  }
  if (doc.bones.length > budgets.bones) {
    issues.push({ severity: "error", check: "budget", path: ["bones"], message: `${doc.bones.length} bones (budget ${budgets.bones})` });
  }
}

function checkAtlas(doc: AnimDocument, pack: AtlasPack, budgets: RigBudgets, issues: ValidationIssue[]): void {
  if (pack.pages.length > budgets.atlasPages) {
    issues.push({ severity: "error", check: "atlas", message: `${pack.pages.length} atlas pages (budget ${budgets.atlasPages})` });
  }
  pack.pages.forEach((page, p) => {
    if (page.width > budgets.pageSize || page.height > budgets.pageSize) {
      issues.push({ severity: "error", check: "atlas", path: ["pages", p], message: `page '${page.file}' is ${page.width}x${page.height} (max ${budgets.pageSize})` });
    }
  });
  if (doc.atlas && Math.abs(doc.atlas.scale - pack.scale) > 1e-9) {
    issues.push({ severity: "error", check: "atlas", path: ["atlas", "scale"], message: `document scale ${doc.atlas.scale} differs from the pack's ${pack.scale}` });
  }
  const regions = new Set(pack.pages.flatMap((page) => Object.keys(page.regions)));
  const used = new Set<string>();
  for (const [skin, data] of Object.entries(doc.skins)) {
    for (const [slot, placeholders] of Object.entries(data.attachments)) {
      for (const [name, attachment] of Object.entries(placeholders)) {
        if (attachment.type === "point" || attachment.type === "clipping" || attachment.type === "boundingbox" || attachment.type === "path") continue;
        const frames = attachment.sequence ? attachmentTexturePaths({ path: attachment.path, sequence: attachment.sequence } as never) : [attachment.path];
        for (const frame of frames) {
          used.add(frame);
          if (!regions.has(frame)) {
            issues.push({ severity: "error", check: "atlas", path: ["skins", skin, "attachments", slot, name, "path"], message: `texture '${frame}' has no atlas region${attachment.sequence ? " (image sequence frame)" : ""}` });
          }
        }
      }
    }
  }
  for (const region of regions) {
    if (!used.has(region)) issues.push({ severity: "warning", check: "atlas", message: `atlas region '${region}' is not used by the rig` });
  }
}

// ---------------------------------------------------------------------------------------------
// Posed checks
// ---------------------------------------------------------------------------------------------

/** Declared outfit combinations must name skins the document has (format error; the combination is skipped). */
function checkOutfits(doc: AnimDocument, combinations: readonly (readonly string[])[], issues: ValidationIssue[]): void {
  for (const combination of combinations) {
    for (const skin of combination) {
      if (!doc.skins[skin]) issues.push({ severity: "error", check: "format", path: ["skins"], message: `declared outfit ${combination.join("+")} names skin '${skin}', which the document lacks (outfit not checked)` });
    }
  }
}

/**
 * Outfits checked: the body alone, the body with each other skin, then the body with each
 * declared combination (`options.outfits`, item skins; the body is implied). A combination that
 * names a skin the document lacks is skipped here; `checkOutfits` reports it as a format error.
 */
function outfits(doc: AnimDocument, bodySkin: string, combinations: readonly (readonly string[])[] = []): string[][] {
  const others = Object.keys(doc.skins).filter((skin) => skin !== bodySkin);
  const singles = [[bodySkin], ...others.map((skin) => [bodySkin, skin])].map((outfit) => outfit.filter((skin) => doc.skins[skin]));
  const seen = new Set(singles.map((outfit) => outfit.join("+")));
  for (const combination of combinations) {
    if (combination.some((skin) => !doc.skins[skin])) continue;
    const outfit = [bodySkin, ...combination.filter((skin) => skin !== bodySkin)].filter((skin) => doc.skins[skin]);
    const key = outfit.join("+");
    if (seen.has(key)) continue;
    seen.add(key);
    singles.push(outfit);
  }
  return singles;
}

/**
 * Calls `visit` with the skeleton posed at the setup pose (clip null) and at `samples` evenly
 * spaced times of every clip, played from the setup pose at 60 Hz with physics. A target between
 * two 60 Hz steps gets a final shorter step, so the pose visited is the pose at the reported time.
 */
export function samplePoses(
  doc: AnimDocument,
  skins: readonly string[],
  samples: number,
  visit: (skeleton: Skeleton, clip: string | null, time: number) => void
): void {
  const skeleton = new Skeleton(doc);
  skeleton.x = doc.canvas.originX;
  skeleton.y = doc.canvas.originY;
  skeleton.setActiveSkins(skins);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("reset");
  visit(skeleton, null, 0);
  const names = Object.keys(doc.animations);
  if (names.length === 0) return;
  const data = new AnimationStateData(doc);
  const step = 1 / 60;
  for (const name of names) {
    const clip = doc.animations[name];
    if (!clip) continue;
    const times = Array.from({ length: samples }, (_, k) => (clip.duration * k) / Math.max(1, clip.loop ? samples : samples - 1));
    const state = new AnimationState(data);
    skeleton.setToSetupPose();
    skeleton.resetPhysics();
    state.setAnimation(0, name, { loop: clip.loop });
    state.apply(skeleton);
    skeleton.updateWorldTransform("reset");
    let time = 0;
    for (const target of times) {
      while (time < target - 1e-9) {
        const delta = Math.min(step, target - time);
        state.update(delta);
        skeleton.update(delta);
        state.apply(skeleton);
        skeleton.updateWorldTransform("update");
        time = delta === step ? time + step : target;
      }
      visit(skeleton, name, time);
    }
  }
}

function checkBounds(doc: AnimDocument, options: ValidateOptions, issues: ValidationIssue[]): void {
  const { width, height } = doc.canvas;
  const scratch = worldScratch();
  let buffer = new Float64Array(0);
  const reported = new Set<string>();
  for (const outfit of outfits(doc, options.bodySkin ?? "body", options.outfits)) {
    samplePoses(doc, outfit, options.samples ?? 6, (skeleton, clip, time) => {
      for (const slot of skeleton.drawOrder) {
        if (!isDrawable(slot.attachment)) continue;
        const count = skeleton.computeSlotWorldVertices(slot, (buffer = scratch(skeleton, slot)));
        let outside = 0;
        for (let v = 0; v < count; v++) {
          const x = buffer[v * 2] as number;
          const y = buffer[v * 2 + 1] as number;
          if (x < 0 || y < 0 || x > width || y > height) outside++;
        }
        const key = `${slot.data.name}|${clip ?? ""}`;
        if (outside > 0 && !reported.has(key)) {
          reported.add(key);
          issues.push({
            severity: "error",
            check: "bounds",
            path: clip ? ["animations", clip] : ["slots"],
            message: `slot '${slot.data.name}' has ${outside} vertices outside the ${width}x${height} canvas ${clip ? `in '${clip}' at ${time.toFixed(2)}s` : "at the setup pose"} (outfit ${outfit.join("+")})`
          });
        }
      }
    });
  }
}

function checkClipping(
  doc: AnimDocument,
  options: ValidateOptions,
  textures: ReadonlyMap<string, RgbaImage>,
  issues: ValidationIssue[]
): ValidationReport["clipping"] {
  const bodySkin = options.bodySkin ?? "body";
  const results: ValidationReport["clipping"] = [];
  const { width, height } = doc.canvas;
  const tolerance = options.clippingTolerance ?? 2;
  for (const outfit of outfits(doc, bodySkin, options.outfits).slice(1)) {
    const skin = outfit.slice(1).join("+");
    // Body texels this skin hides at the setup pose (the first pose visited), per body slot.
    let hidden = new Map<number, { mask: Uint8Array }>();
    samplePoses(doc, outfit, options.samples ?? 6, (skeleton, clip, time) => {
      const dressed = softRender(skeleton, textures, { width, height, ids: true });
      const topSlot = dressed.topSlot as Int16Array;
      const topTexel = dressed.topTexel as Int32Array;
      if (clip === null) {
        const bodyOnly = softRender(skeleton, textures, { width, height, ids: true, slotFilter: (slot) => slot.attachment?.skin === bodySkin });
        hidden = hiddenBodyTexels(skeleton, textures, bodyOnly, topSlot, bodySkin, tolerance);
        return;
      }
      let flagged = 0;
      for (let p = 0; p < topSlot.length; p++) {
        const slotIndex = (topSlot[p] as number) - 1;
        if (slotIndex < 0 || skeleton.slots[slotIndex]?.attachment?.skin !== bodySkin) continue;
        if (hidden.get(slotIndex)?.mask[topTexel[p] as number]) flagged++;
      }
      results.push({ skin, clip, time, flagged });
      if (flagged > 0) {
        issues.push({
          severity: "error",
          check: "clipping",
          path: ["animations", clip],
          message: `${flagged} body pixels show through skin '${skin}' in '${clip}' at ${time.toFixed(2)}s`
        });
      }
    });
  }
  return results;
}

/**
 * Body texels (per body slot, in that slot's texture) that are visible in the body-only render
 * but not on top in the dressed render, eroded by the tolerance (in texels of each texture).
 */
function hiddenBodyTexels(
  skeleton: Skeleton,
  textures: ReadonlyMap<string, RgbaImage>,
  bodyOnly: { topSlot?: Int16Array; topTexel?: Int32Array },
  dressedTop: Int16Array,
  bodySkin: string,
  toleranceCanvasPx: number
): Map<number, { mask: Uint8Array; width: number; height: number }> {
  const out = new Map<number, { mask: Uint8Array; width: number; height: number }>();
  const bodyTop = bodyOnly.topSlot as Int16Array;
  const bodyTexel = bodyOnly.topTexel as Int32Array;
  for (let p = 0; p < bodyTop.length; p++) {
    const slotIndex = (bodyTop[p] as number) - 1;
    if (slotIndex < 0) continue;
    const dressedSlot = (dressedTop[p] as number) - 1;
    const slot = skeleton.slots[slotIndex];
    const coverSkin = dressedSlot >= 0 ? skeleton.slots[dressedSlot]?.attachment?.skin : undefined;
    if (!slot || coverSkin === undefined || coverSkin === bodySkin) continue;
    const attachment = slot.attachment as MeshAttachment | null;
    if (!attachment || attachment.skin !== bodySkin) continue;
    const texture = textures.get(attachment.path);
    if (!texture) continue;
    let entry = out.get(slotIndex);
    if (!entry) {
      entry = { mask: new Uint8Array(texture.width * texture.height), width: texture.width, height: texture.height };
      out.set(slotIndex, entry);
    }
    entry.mask[bodyTexel[p] as number] = 1;
  }
  // Erode by the tolerance in texels (texture pixels per canvas pixel = texture width / mesh width).
  for (const [slotIndex, entry] of out) {
    const attachment = skeleton.slots[slotIndex]?.attachment;
    const canvasWidth = isDrawable(attachment) ? attachment.width : entry.width;
    const radius = Math.max(1, Math.round(toleranceCanvasPx * (entry.width / canvasWidth)));
    // Close single-texel holes first (pixel centres skip some texels when the texture is denser
    // than the canvas), then erode.
    const closed = createMask(entry.width, entry.height);
    closed.data.set(entry.mask);
    const eroded = erodeMask(closeMask(closed), radius);
    entry.mask = eroded.data;
  }
  return out;
}

function closeMask(mask: ReturnType<typeof createMask>): ReturnType<typeof createMask> {
  const { width, height } = mask;
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask.data[i]) {
        out.data[i] = 1;
        continue;
      }
      let around = 0;
      if (x > 0 && mask.data[i - 1]) around++;
      if (x < width - 1 && mask.data[i + 1]) around++;
      if (y > 0 && mask.data[i - width]) around++;
      if (y < height - 1 && mask.data[i + width]) around++;
      out.data[i] = around >= 3 ? 1 : 0;
    }
  }
  return out;
}

/** Per texture path, the region image cut out of prepacked atlas pages (for the clipping check). */
export function texturesFromAtlas(pack: AtlasPack, pages: ReadonlyMap<string, RgbaImage>): Map<string, RgbaImage> {
  const out = new Map<string, RgbaImage>();
  for (const page of pack.pages) {
    const image = pages.get(page.file);
    if (!image) throw new Error(`atlas page '${page.file}' was not provided`);
    for (const [path, rect] of Object.entries(page.regions)) out.set(path, cropImage(image, rect));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tears (Phase 4 review, 4c)
// ---------------------------------------------------------------------------------------------

/** The part a slot belongs to (1-based slot index): generated pieces are named `<part>.<piece>`. */
function slotGroups(skeleton: Skeleton): Int32Array {
  const byName = new Map(skeleton.slots.map((slot) => [slot.data.name, slot.index]));
  return Int32Array.from(skeleton.slots, (slot) => {
    const prefix = slot.data.name.split(".")[0] as string;
    return (byName.get(prefix) ?? slot.index) + 1;
  });
}

interface TearFrame {
  /** pair key (group a * 65536 + group b, a < b) -> shared boundary length in px. */
  contacts: Map<number, number>;
  /** Enclosed background holes (size, first pixel). */
  holes: { size: number; x: number; y: number }[];
}

function tearFrame(
  skeleton: Skeleton,
  textures: ReadonlyMap<string, RgbaImage>,
  width: number,
  height: number,
  groups: Int32Array,
  restFigure: Uint8Array | null,
  restContacts: ReadonlyMap<number, number> | null,
  caps: readonly { key: number; x: number; y: number; radius: number }[] = []
): TearFrame & { figure: Uint8Array; group: Int32Array; top: Int16Array; texel: Int32Array; image: RgbaImage } {
  const render = softRender(skeleton, textures, { width, height, ids: true });
  const top = render.topSlot as Int16Array;
  const group = new Int32Array(top.length);
  for (let p = 0; p < top.length; p++) group[p] = (top[p] as number) > 0 ? (groups[(top[p] as number) - 1] as number) : 0;
  const contacts = new Map<number, number>();
  const count = (a: number, b: number, x: number, y: number) => {
    if (a === 0 || b === 0 || a === b) return;
    const key = Math.min(a, b) * 65536 + Math.max(a, b);
    const cap = caps.find((c) => c.key === key);
    if (cap && Math.hypot(x - cap.x, y - cap.y) > cap.radius) return;
    contacts.set(key, (contacts.get(key) ?? 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (x + 1 < width) count(group[p] as number, group[p + 1] as number, x + 1, y + 0.5);
      if (y + 1 < height) count(group[p] as number, group[p + width] as number, x + 0.5, y + 1);
    }
  }
  // Background reachable from the border; whatever background is left is enclosed.
  const seen = new Uint8Array(top.length);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!seen[p] && group[p] === 0) {
      seen[p] = 1;
      stack.push(p);
    }
  };
  const flood = () => {
    let size = 0;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      size++;
      const x = p % width;
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (p >= width) push(p - width);
      if (p + width < top.length) push(p + width);
    }
    return size;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  flood();
  // A hole is a tear when most of it was figure at rest (a limb pulled away from where it was);
  // background that limbs close in on (a fist resting on the hip) was background at rest too.
  const holes: TearFrame["holes"] = [];
  for (let p = 0; p < top.length; p++) {
    if (seen[p] || group[p] !== 0) continue;
    let wasFigure = 0;
    let size = 0;
    const around = new Set<number>();
    const border = (q: number) => {
      const g = group[q] as number;
      if (g > 0) around.add(g);
    };
    push(p);
    while (stack.length > 0) {
      const q = stack.pop() as number;
      size++;
      if (restFigure?.[q]) wasFigure++;
      const x = q % width;
      const visit = (n: number) => {
        push(n);
        border(n);
      };
      if (x > 0) visit(q - 1);
      if (x < width - 1) visit(q + 1);
      if (q >= width) visit(q - width);
      if (q + width < top.length) visit(q + width);
    }
    // Parts that close in on each other without touching at rest (a hand near the head) make a
    // gap, not a tear.
    const groupsAround = [...around];
    const closure = restContacts !== null && groupsAround.some((a) => groupsAround.some((b) => a < b && !restContacts.has(a * 65536 + b)));
    if (size >= 4 && !closure && (!restFigure || wasFigure * 2 > size)) holes.push({ size, x: p % width, y: Math.floor(p / width) });
  }
  const figure = Uint8Array.from(group, (g) => (g > 0 ? 1 : 0));
  return { contacts, holes, figure, group, top, texel: render.topTexel as Int32Array, image: render.image };
}

/** Per part slot, the texels on top somewhere at rest, grown by one texel. */
function restVisibleTexels(skeleton: Skeleton, textures: ReadonlyMap<string, RgbaImage>, top: Int16Array, texel: Int32Array): Map<number, Uint8Array> {
  const visible = new Map<number, ReturnType<typeof createMask>>();
  for (let p = 0; p < top.length; p++) {
    const slotIndex = (top[p] as number) - 1;
    if (slotIndex < 0) continue;
    let mask = visible.get(slotIndex);
    if (!mask) {
      const attachment = skeleton.slots[slotIndex]?.attachment;
      const texture = isDrawable(attachment) ? textures.get(attachment.path) : undefined;
      if (!texture) continue;
      mask = createMask(texture.width, texture.height);
      visible.set(slotIndex, mask);
    }
    mask.data[texel[p] as number] = 1;
  }
  return new Map([...visible].map(([slotIndex, mask]) => [slotIndex, dilateMask(mask, 1).data]));
}

/**
 * Buried hidden ink: pixels whose top texel belongs to any slot (generated `<part>.<piece>` slots
 * included), was hidden at rest and is outline ink (dark, of the outline's hue: a rim), 4 px or more inside the
 * silhouette and away from any other part, with that part's fill on both sides along some
 * direction within `LINE_REACH` px: a rim lying across the part's own fill (the neck rim over the
 * shoulder skin), not an edge. Revealed outlines on the silhouette or beside another part, and
 * revealed clothing bands of another colour (the tank's strap beside a raised arm), pass.
 */
const LINE_REACH = 14;
/** Chromaticity distance within which dark ink counts as the outline's colour. */
const OUTLINE_HUE = 0.12;

function chromaticity(r: number, g: number, b: number): [number, number] {
  const sum = r + g + b + 1;
  return [r / sum, g / sum];
}

/** The outline colour's chromaticity: median dark pixel on the silhouette edge of a render. */
function outlineHue(image: RgbaImage, figure: Uint8Array, width: number): [number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let p = width; p < figure.length - width; p++) {
    if (!figure[p] || (figure[p - 1] && figure[p + 1] && figure[p - width] && figure[p + width])) continue;
    const r = image.data[p * 4] as number;
    const g = image.data[p * 4 + 1] as number;
    const b = image.data[p * 4 + 2] as number;
    if (0.299 * r + 0.587 * g + 0.114 * b >= 110) continue;
    rs.push(r);
    gs.push(g);
    bs.push(b);
  }
  const median = (values: number[]) => (values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0);
  return chromaticity(median(rs), median(gs), median(bs));
}

function buriedInk(
  skeleton: Skeleton,
  textures: ReadonlyMap<string, RgbaImage>,
  frame: { group: Int32Array; top: Int16Array; texel: Int32Array },
  restVisible: ReadonlyMap<number, Uint8Array>,
  hue: readonly [number, number],
  width: number,
  height: number
): { count: number; x: number; y: number } {
  const textureOf = (p: number) => {
    const attachment = skeleton.slots[(frame.top[p] as number) - 1]?.attachment;
    return isDrawable(attachment) ? textures.get(attachment.path) : undefined;
  };
  const inkAt = (p: number) => {
    const texture = textureOf(p);
    const t = frame.texel[p] as number;
    return texture !== undefined && t >= 0 && (texture.data[t * 4 + 3] as number) >= 128 && isInk(texture, t);
  };
  const outlineInkAt = (p: number) => {
    if (!inkAt(p)) return false;
    const [r, g, b] = colourAt(p);
    const [cr, cg] = chromaticity(r, g, b);
    return Math.hypot(cr - hue[0], cg - hue[1]) < OUTLINE_HUE;
  };
  // Fill: clearly lighter than ink and its shaded edges (luma 150 and up).
  const fillAt = (p: number) => {
    const [r, g, b] = colourAt(p);
    return 0.299 * r + 0.587 * g + 0.114 * b >= 150;
  };
  const colourAt = (p: number): [number, number, number] => {
    const texture = textureOf(p);
    const t = frame.texel[p] as number;
    if (!texture || t < 0) return [0, 0, 0];
    return [texture.data[t * 4] as number, texture.data[t * 4 + 1] as number, texture.data[t * 4 + 2] as number];
  };
  const depth = 3;
  const deep = (x: number, y: number, own: number) => {
    if (x < depth || y < depth || x >= width - depth || y >= height - depth) return false;
    for (let dy = -depth; dy <= depth; dy++) {
      for (let dx = -depth; dx <= depth; dx++) if (frame.group[(y + dy) * width + x + dx] !== own) return false;
    }
    return true;
  };
  // Walks from (x, y) across the dark band: the fill colour when it ends in the same part's fill.
  const fillAlong = (x: number, y: number, dx: number, dy: number, own: number): [number, number, number] | null => {
    for (let k = 1; k <= LINE_REACH; k++) {
      const xx = x + dx * k;
      const yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) return null;
      const q = yy * width + xx;
      if (frame.group[q] !== own) return null;
      if (fillAt(q)) return colourAt(q);
    }
    return null;
  };
  const acrossFill = (x: number, y: number, dx: number, dy: number, own: number) =>
    fillAlong(x, y, dx, dy, own) !== null && fillAlong(x, y, -dx, -dy, own) !== null;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ] as const;
  let count = 0;
  let first = -1;
  for (let p = 0; p < frame.top.length; p++) {
    const slotIndex = (frame.top[p] as number) - 1;
    const slot = skeleton.slots[slotIndex];
    if (!slot) continue;
    if (restVisible.get(slotIndex)?.[frame.texel[p] as number] || !outlineInkAt(p)) continue;
    const x = p % width;
    const y = (p - x) / width;
    const own = frame.group[p] as number;
    if (!deep(x, y, own)) continue;
    if (!directions.some(([dx, dy]) => acrossFill(x, y, dx, dy, own))) continue;
    count++;
    if (first < 0) first = p;
  }
  return { count, x: first % width, y: Math.floor(first / width) };
}

/**
 * Hairlines at 3x: pixels where the background shows through (composite alpha below `solid`)
 * with solid figure within `HAIRLINE_REACH` px on both sides along a row, a column or a diagonal:
 * a crack or speck too thin for the 1x id buffer, including a seam where two parts' edges each
 * cover the pixel only partly (a translucent line, open to the outside or not). The only
 * allowance is the narrow tip of an open notch (the inside of a bent elbow: within
 * `HAIRLINE_TIP` px of transparent background at least 3 px wide), which is the notch's own
 * shape. There is no exemption near the silhouette (a narrow gap between two parts there, such as
 * an armpit sliver, counts) and none for places that already have a hairline at rest. Renders
 * only the posed figure's bounds.
 */
export function hairlines(
  skeleton: Skeleton,
  textures: ReadonlyMap<string, RgbaImage>,
  canvas: { width: number; height: number },
  scale = 3,
  solid = HAIRLINE_SOLID
): { count: number; x: number; y: number } {
  const scratch = worldScratch();
  let world = new Float64Array(0);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const slot of skeleton.drawOrder) {
    if (!isDrawable(slot.attachment)) continue;
    const count = skeleton.computeSlotWorldVertices(slot, (world = scratch(skeleton, slot)));
    for (let v = 0; v < count; v++) {
      x0 = Math.min(x0, world[v * 2] as number);
      x1 = Math.max(x1, world[v * 2] as number);
      y0 = Math.min(y0, world[v * 2 + 1] as number);
      y1 = Math.max(y1, world[v * 2 + 1] as number);
    }
  }
  if (!Number.isFinite(x0)) return { count: 0, x: 0, y: 0 };
  const left = Math.max(0, Math.floor(x0) - 2);
  const top = Math.max(0, Math.floor(y0) - 2);
  const width = (Math.min(canvas.width, Math.ceil(x1) + 2) - left) * scale;
  const height = (Math.min(canvas.height, Math.ceil(y1) + 2) - top) * scale;
  const render = softRender(skeleton, textures, { width, height, scale, left, top });
  const { data } = render.image;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && (data[(y * width + x) * 4 + 3] as number) >= solid;
  // Transparent background at least 3 px wide (a 3x3 opening), grown by the tip allowance.
  const background = createMask(width, height);
  for (let p = 0; p < width * height; p++) background.data[p] = (data[p * 4 + 3] as number) < 128 ? 1 : 0;
  const open = dilateMask(erodeMaskKeepBorder(background, 1), 1 + HAIRLINE_TIP);
  let count = 0;
  let first = -1;
  const hits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if ((data[p * 4 + 3] as number) >= solid) continue;
      if (open.data[p]) continue;
      const solidAlong = (dx: number, dy: number) => {
        for (let k = 1; k <= HAIRLINE_REACH; k++) if (at(x + dx * k, y + dy * k)) return true;
        return false;
      };
      if (!HAIRLINE_AXES.some(([dx, dy]) => solidAlong(dx, dy) && solidAlong(-dx, -dy))) continue;
      hits[p] = 1;
    }
  }
  // Only clusters of `HAIRLINE_MIN_CLUSTER` px or more count: one or two 3x pixels are a third of
  // a canvas pixel, below what shows at game scale or on the 3x sheet.
  const seen = new Uint8Array(width * height);
  for (let p = 0; p < hits.length; p++) {
    if (!hits[p] || seen[p]) continue;
    const cluster: number[] = [];
    const stack = [p];
    seen[p] = 1;
    while (stack.length > 0) {
      const q = stack.pop() as number;
      cluster.push(q);
      const qx = q % width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          const n = q + dy * width + dx;
          if (nx < 0 || nx >= width || n < 0 || n >= hits.length || !hits[n] || seen[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cluster.length < HAIRLINE_MIN_CLUSTER) continue;
    count += cluster.length;
    if (first < 0) first = p;
  }
  return { count, x: left + (first % width) / scale, y: top + Math.floor(first / width) / scale };
}

/** Hairline pixels this close (3x px) to wide background are a notch's tip. */
const HAIRLINE_TIP = 9;
/** Composite alpha below this (over 20% see-through) shows the background as a light line. */
const HAIRLINE_SOLID = 200;
/** Smallest counted hairline cluster (3x px). */
const HAIRLINE_MIN_CLUSTER = 3;
/** Solid figure this close (3x px) on both sides makes a see-through pixel a crack. */
const HAIRLINE_REACH = 4;
const HAIRLINE_AXES = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
] as const;

/** Square erosion where the image border counts as inside (the margin round a render is open). */
function erodeMaskKeepBorder(mask: ReturnType<typeof createMask>, radius: number): ReturnType<typeof createMask> {
  const inverted = createMask(mask.width, mask.height);
  for (let i = 0; i < inverted.data.length; i++) inverted.data[i] = mask.data[i] ? 0 : 1;
  const grown = dilateMask(inverted, radius);
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = mask.data[i] && !grown.data[i] ? 1 : 0;
  return out;
}

/** Rest lengths of the unique triangle edges of every mesh slot, by slot index. */
function meshEdges(skeleton: Skeleton): Map<number, { a: Uint32Array; b: Uint32Array; rest: Float64Array }> {
  const out = new Map<number, { a: Uint32Array; b: Uint32Array; rest: Float64Array }>();
  const scratch = worldScratch();
  let world = new Float64Array(0);
  for (const slot of skeleton.slots) {
    const attachment = slot.attachment;
    if (!attachment || attachment.type !== "mesh") continue;
    const triangles = attachment.geometry.triangles;
    const pairs = new Set<number>();
    for (let t = 0; t + 2 < triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = triangles[t + k] as number;
        const j = triangles[t + ((k + 1) % 3)] as number;
        pairs.add(Math.min(i, j) * 65536 + Math.max(i, j));
      }
    }
    skeleton.computeSlotWorldVertices(slot, (world = scratch(skeleton, slot)));
    const a = Uint32Array.from(pairs, (key) => Math.floor(key / 65536));
    const b = Uint32Array.from(pairs, (key) => key % 65536);
    const rest = Float64Array.from(a, (i, k) => {
      const j = b[k] as number;
      return Math.hypot((world[i * 2] as number) - (world[j * 2] as number), (world[i * 2 + 1] as number) - (world[j * 2 + 1] as number));
    });
    out.set(slot.index, { a, b, rest });
  }
  return out;
}

function checkTears(
  doc: AnimDocument,
  options: ValidateOptions,
  textures: ReadonlyMap<string, RgbaImage>,
  issues: ValidationIssue[]
): ValidationReport["tears"] {
  const { width, height } = doc.canvas;
  const results: ValidationReport["tears"] = [];
  const joints = options.joints ?? authoringJoints(doc);
  const scratch = worldScratch();
  let world = new Float64Array(0);
  for (const outfit of outfits(doc, options.bodySkin ?? "body", options.outfits)) {
    const rest = poseSkeleton(doc, outfit, null);
    const groups = slotGroups(rest);
    const capsFor = (skeleton: Skeleton) =>
      joints.flatMap((joint) => {
        const parent = skeleton.findSlot(joint.parent);
        const child = skeleton.findSlot(joint.child);
        const bone = joint.pivotBone === undefined ? undefined : skeleton.findBone(joint.pivotBone);
        if (!parent || !child || !bone || joint.radius === undefined) return [];
        const a = (groups[parent.index] as number);
        const b = (groups[child.index] as number);
        return [{ key: Math.min(a, b) * 65536 + Math.max(a, b), x: bone.world.x, y: bone.world.y, radius: joint.radius }];
      });
    const restFrame = tearFrame(rest, textures, width, height, groups, null, null, capsFor(rest));
    const restVisible = restVisibleTexels(rest, textures, restFrame.top, restFrame.texel);
    const hue = outlineHue(restFrame.image, restFrame.figure, width);
    const edges = meshEdges(rest);
    const name = (group: number) => rest.slots[group - 1]?.data.name ?? "?";
    // Group pairs of the declared joints: the only contacts the "joint opened" rule judges.
    const declared = new Set(
      joints.flatMap((joint) => {
        const parent = rest.findSlot(joint.parent);
        const child = rest.findSlot(joint.child);
        if (!parent || !child) return [];
        const a = groups[parent.index] as number;
        const b = groups[child.index] as number;
        return [Math.min(a, b) * 65536 + Math.max(a, b)];
      })
    );
    const judge = (skeleton: Skeleton, label: string, path: IssuePath) => {
      const frame = tearFrame(skeleton, textures, width, height, groups, restFrame.figure, restFrame.contacts, capsFor(skeleton));
      let errors = 0;
      const buried = buriedInk(skeleton, textures, frame, restVisible, hue, width, height);
      if (buried.count > 0) {
        errors++;
        issues.push({
          severity: "error",
          check: "tears",
          path,
          message: `${label}: ${buried.count} px of ink hidden at rest drawn inside the silhouette near (${buried.x}, ${buried.y}) (outfit ${outfit.join("+")})`
        });
      }
      // The 3x hairline render runs on the review poses and the clip samples alike.
      const cracks = hairlines(skeleton, textures, doc.canvas, 3, HAIRLINE_SOLID);
      if (cracks.count > 0) {
        errors++;
        issues.push({
          severity: "error",
          check: "tears",
          path,
          message: `${label}: ${cracks.count} hairline px at 3x near (${cracks.x.toFixed(0)}, ${cracks.y.toFixed(0)}) (outfit ${outfit.join("+")})`
        });
      }
      for (const hole of frame.holes) {
        errors++;
        issues.push({ severity: "error", check: "tears", path, message: `${label}: enclosed hole of ${hole.size} px at (${hole.x}, ${hole.y}) (outfit ${outfit.join("+")})` });
      }
      for (const [key, restLength] of restFrame.contacts) {
        if (restLength < 8 || !declared.has(key)) continue;
        const now = frame.contacts.get(key) ?? 0;
        if (now === 0 || now < restLength / 2) {
          errors++;
          issues.push({
            severity: "error",
            check: "tears",
            path,
            message: `${label}: joint opened between '${name(Math.floor(key / 65536))}' and '${name(key % 65536)}' (contact ${now} of ${restLength} px at rest; outfit ${outfit.join("+")})`
          });
        }
      }
      let worst = 1;
      for (const [slotIndex, edge] of edges) {
        const slot = skeleton.slots[slotIndex];
        if (!slot || !slot.attachment) continue;
        skeleton.computeSlotWorldVertices(slot, (world = scratch(skeleton, slot)));
        let slotWorst = 1;
        for (let k = 0; k < edge.a.length; k++) {
          const i = edge.a[k] as number;
          const j = edge.b[k] as number;
          const length = Math.hypot((world[i * 2] as number) - (world[j * 2] as number), (world[i * 2 + 1] as number) - (world[j * 2 + 1] as number));
          slotWorst = Math.max(slotWorst, length / Math.max(1e-6, edge.rest[k] as number));
        }
        // Edge ratios are reported only: distortion is judged by the geometry check.
        worst = Math.max(worst, slotWorst);
      }
      results.push({ outfit: outfit.join("+"), pose: label, holes: frame.holes.length, stretch: worst, hairlines: cracks.count, buriedInk: buried.count, errors });
    };
    for (const pose of options.poses ?? rigPoses(doc, { bend: resolveBudgets(doc, options).bend })) judge(poseSkeleton(doc, outfit, pose), `pose '${pose.name}'`, ["bones"]);
    samplePoses(doc, outfit, options.samples ?? 6, (skeleton, clip, time) => {
      if (clip !== null) judge(skeleton, `'${clip}' at ${time.toFixed(2)}s`, ["animations", clip]);
    });
  }
  return results;
}
