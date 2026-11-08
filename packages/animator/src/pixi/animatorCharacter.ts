/*
 * Atlas Animator: original implementation.
 *
 * AnimatorCharacter: draws one Skeleton with Pixi 8.
 *
 * Structure: one Pixi Mesh per slot, children in draw order. Each mesh uses a MeshGeometry per
 * attachment the slot can show (built when the outfit changes) with:
 * - positions: the skinned vertices, written in place every frame (no allocation) and pushed with
 *   one buffer update;
 * - uvs: page UVs, computed once from the attachment's image UVs and its atlas region;
 * - indices: the attachment's triangles (shared, read-only).
 * The mesh's texture is the atlas page texture itself, its tint/alpha the slot colour times the
 * attachment colour, its blend mode the slot's.
 *
 * Draw groups: a mesh with `groups` is skinned once by the skeleton; each group slot's
 * mesh gets a geometry of that group's triangles (compact vertex list) and copies its positions
 * from the one skinned result, so a boundary vertex lands on the same pixel in both groups. The
 * group draws at its slot's draw-order position with that slot's colour.
 *
 * Contours: each contour of the active skins is one more batched mesh, drawn right
 * after its owner slot's mesh. Its geometry is the stroke built around the deformed centreline
 * (core/contours.ts buildStroke) with the atlas-resident coverage ramp as texture, so it batches
 * with the body. A stroke is rebuilt only when it must: an owner bone's world transform changed
 * (relative to the skeleton origin; a pure skeleton move only shifts the vertices), animation
 * deform moves its mesh, its embed source or a contact dependency (or moved one at the last build:
 * removing a deform is a geometry change too), a contact partner or junction ink appeared or
 * disappeared, or the display scale changed. Level of detail: a contour narrower than
 * `contourMinPixels` display pixels is not drawn or rebuilt.
 *
 * Batching (plan 4.7): every mesh is a batched mesh (geometry batchMode "batch", default shader),
 * so Pixi's batcher packs all slots of all characters into shared vertex buffers and draws
 * them together, up to 16 atlas pages per draw call. One character on one page is one draw call;
 * a crowd sharing pages is still one draw call per batch. This replaces the plan's "one Mesh with
 * an interleaved buffer per page" idea: a custom-shader mesh per character and page could never
 * batch across characters (Pixi does not batch custom-shader meshes), which would make the
 * crowd cost one draw call per character and page.
 *
 * Held-pose cache: updateHeld(state) with a held-frame AnimationState (clip fps,
 * default 30, on a 60 Hz display) evaluates the pose only when the displayed frame changes. The
 * cache key is the state's poseVersion (clip frames, crossfade steps, entries, alphas, masks), the
 * outfit version, the skeleton origin, the contour settings and the quantized display scale
 * (contourScaleStep: a pinch-zoom misses only when it crosses a step; between steps the cached
 * strokes scale with the container); on a hit nothing runs: no pose evaluation, no skinning or embedding, no stroke tessellation and no
 * buffer update, so Pixi re-uploads nothing. Move characters with the container's position (the
 * display transform), not skeleton.x/y, so a moving character still hits.
 *
 * Procedural edits (review): a miss runs state.apply (which first resets every bone, slot and
 * constraint to the setup pose), then `onAfterApply(skeleton)`, then updateWorldTransform. So IK
 * targets, aim, direct bone or constraint edits go in onAfterApply, never between updates (the
 * next miss would wipe them). What the hook reads takes part in the cache key through
 * `proceduralVersion`: change it whenever the hook's inputs change (or call invalidate()). Slot
 * colour, alpha or attachment written directly on the skeleton's slots between updates are
 * overwritten by the next miss too: tint through the container (tint, alpha), slot/colour
 * timelines, or onAfterApply.
 *
 * Clock and movement (review, physics): step(state, dt) advances the state and the
 * skeleton's physics clock (Skeleton.time) together, then runs updateHeld. A container move is
 * invisible to the skeleton, so cloth gets no inertia from it: report it with moveWorld(dx, dy)
 * (parent units, those of `position`). A rig without an active physics constraint drops the
 * motion and keeps hitting; a physics rig with pending motion misses and feeds the motion to
 * physics as if the skeleton had moved. Physics progression is independent of the animation
 * sample (runtime contract F2): while the clock runs and an active simulation is not settled
 * (Skeleton.physicsSettled: springs still moving under wind, gravity or a recent impulse, or a
 * reset pending), every update misses, even with the pose held (a finished clip, a constant
 * pose, a frozen state). Once the springs are asleep (PhysicsConstraint sleep criterion) the held
 * pose hits again; asleep constraints count only the waking frame's time, awake ones the whole
 * advance since their last update (catch-up limit max(0.25 s, 4 steps)), so a cached and an
 * uncached run agree at any simulation rate. Physics reset keys passed between held frames change
 * the state's poseVersion, so they always reach the skeleton.
 *
 * Separate decisions: a miss samples the animation (state.apply +
 * onAfterApply) only when the sample key changed (pose version, state, outfit, procedural version,
 * invalidate()); runs the constraints and world transform when the sample, the skeleton origin, the
 * pending motion or a due physics step changed; and rebuilds geometry (skinning, strokes, buffer
 * uploads) on any of those or a display-scale / contour-LOD change, which alone re-poses nothing.
 *
 * Display scale (review): device pixels per canvas pixel = the longer axis of the
 * container's global transform (non-uniform scale: the AA band is at most 1 device px along either
 * axis, thinner along the shorter one) times `displayResolution` (set it to the renderer's
 * resolution), or `contourPixelScale` when set. Known spike: a crowd at one zoom crosses a
 * contourScaleStep bucket on the same frame, so a pinch-zoom crossing a step invalidates the whole
 * crowd at once (held phases do not spread it).
 *
 * Coordinates: the container's local space is skeleton space in canvas pixels (y down). Scale
 * the container for display size and mirror it with a negative scale.x (plan 4.4).
 */
import { Container, Graphics, Matrix, Mesh, MeshGeometry, type Buffer, type DestroyOptions } from "pixi.js";
import { attachmentTexturePaths, isDrawable, isGroupedMesh, sequenceFramePath, type Attachment, type DrawableAttachment } from "../core/attachments.js";
import type { AnimationState } from "../core/animationState.js";
import type { Bone } from "../core/bone.js";
import { rgb24 } from "../core/color.js";
import { buildStroke, createStrokeTopology, type CompiledContour, type StrokeCounts, type StrokeRamp, type StrokeTopology } from "../core/contours.js";
import { buildTrimmedStroke, filletCapacity, joinedEndMask, trimmedStrokeCapacity } from "../core/coverage.js";
import type { Skeleton } from "../core/skeleton.js";
import type { Slot } from "../core/slot.js";
import type { AtlasRegion, DynamicAtlas, SourceImage } from "./dynamicAtlas.js";
import type { PartImageProvider } from "./partImages.js";

/** Per-character work counters (benches and tests). Times are filled only while a profiler clock is set. */
export interface AnimatorCharacterStats {
  /** updateHeld calls that found the cache key unchanged and did nothing. */
  cacheHits: number;
  /** updateHeld calls that evaluated the pose. */
  cacheMisses: number;
  /** Pose evaluations (constraints + world transform) made by updateHeld. */
  poseEvaluations: number;
  /** Animation samples (state.apply + onAfterApply) made by updateHeld; a physics-only miss skips it. */
  poseSamples: number;
  /** Vertex buffer update marks (each one is a re-pack and upload by Pixi). */
  bufferUpdates: number;
  /**
   * Milliseconds (profiler clock only) in pose evaluation (state apply + world transform), the slot
   * pass (skinning/embedding into the fill and group meshes, their buffer marks and colours) and
   * the contour pass (owner checks, centrelines, stroke building, their buffer marks). Timed per
   * pass, not per slot or contour: clock reads are not free on phones.
   */
  msPose: number;
  msEmbed: number;
  msStroke: number;
  /**
   * Per-stage split of msPose: animation sampling
   * (state.apply + onAfterApply) and constraints + world transform (IK, transform, physics, driven).
   */
  msSample: number;
  msConstraints: number;
  /** Bytes of vertex/index data marked for upload (each buffer mark's data size; Pixi uploads it at render). */
  uploadBytes: number;
}

export interface AnimatorCharacterOptions {
  skeleton: Skeleton;
  atlas: DynamicAtlas;
  images: PartImageProvider;
}

interface Drawable {
  readonly attachment: DrawableAttachment;
  readonly geometry: MeshGeometry;
  readonly positions: Float32Array;
  /** The geometry's position buffer (looked up once, not by name per frame). */
  readonly positionBuffer: Buffer;
  readonly region: AtlasRegion;
  /** Draw group index, or -1 for a whole attachment. */
  readonly group: number;
}

interface ContourView {
  /** Visible runs of the last build (clothing model; owned copy) and whether there are any trims. */
  runs: number[];
  hasRuns: boolean;
  readonly contour: CompiledContour;
  readonly mesh: Mesh<MeshGeometry>;
  readonly geometry: MeshGeometry;
  /**
   * Capacity buffers (trimmedStrokeCapacity), handed whole to the geometry: its size never changes.
   * A batched mesh whose size changes from one frame to the next could keep a stale batch layout
   * (pixi 8 batcher), so a stroke drew other atlas content (body skin) along its rim while a join
   * switched layout. Indices past the
   * build's are degenerate (0, 0, 0).
   */
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /**
   * The index list Pixi last packed into its batch. A batched mesh of
   * unchanged size is re-packed for its attributes only (MeshPipe.updateRenderable): its indices
   * stay those of the last instruction-set build. A new join or trim layout of the same capacity
   * then drew the old triangles over the new vertices (slivers from a stroke's end back to its
   * start along the shoulder tops, changing with the pose). When the built indices differ from
   * these, the render group's structure is marked changed so the batch is rebuilt with them.
   */
  readonly packedIndices: Uint32Array;
  /** Vertices and indices of the current build (the used prefix of the capacity buffers). */
  vertices: number;
  usedIndices: number;
  /** Join layout of the last build: a rebuild with the same layout rewrites positions only. */
  readonly topology: StrokeTopology;
  /**
   * The stroke's positions minus the skeleton origin at build time (pure moves shift these). Filled
   * on the first pure move after a build (from the still unshifted positions), not on every build.
   */
  readonly relative: Float32Array;
  relativeValid: boolean;
  readonly points: Float32Array;
  /** Per owner bone: world a, b, c, d, x - skeleton.x, y - skeleton.y at the last build. */
  readonly snapshot: Float64Array;
  built: boolean;
  /**
   * The last build read animation deform: the next build must run even when no deform is active
   * any more (removing the deform moves the centreline back without any bone change).
   */
  deformed: boolean;
  /** contourDependencyVisibility at the last build (contact partners and junction inks drawn). */
  dependencyVisibility: number;
  /** Skeleton x, y and the anti-aliasing band of the last build (typed: per-frame doubles never box). */
  readonly state: Float64Array;
  tint: number;
  alpha: number;
}

interface SlotView {
  readonly slot: Slot;
  readonly mesh: Mesh<MeshGeometry>;
  /** key -> drawable, for every attachment (or draw group, negative keys) the outfit offers this slot. */
  drawables: Map<number, Drawable>;
  shown: Drawable | null;
  tint: number;
  alpha: number;
  /** Contours owned by this slot, drawn right after its mesh. */
  contours: ContourView[];
}

const EMPTY_GEOMETRY_SIZE = 3;

/** Atlas key of the coverage ramp every contour samples. */
export const COVERAGE_RAMP_KEY = "@animator/coverage-ramp";
const RAMP_WIDTH = 256;
const RAMP_HEIGHT = 4;
/** Texels over which the ramp rises from 0 to 1 (alpha of texel i = (i + 0.5) / RAMP_TEXELS). */
const RAMP_TEXELS = 8;

/** Owner-bone change below which a stroke is not rebuilt (matrix terms; canvas pixels). */
const MATRIX_EPSILON = 1e-7;
const TRANSLATION_EPSILON = 1e-4;

/**
 * The display scale contours are built for (zoom): `scale` rounded UP to a step of
 * `step` in log2 space (step <= 0: exact). Rounding up keeps the displayed AA band in
 * (2^-step, 1] display px and the join error at or under STROKE_JOIN_ERROR at every scale inside
 * the step; the coverage-integrated stroke width is w for any band (core/contours.ts), so it is
 * unaffected.
 */
export function quantizeDisplayScale(scale: number, step: number): number {
  if (!(step > 0) || !(scale > 0)) return scale;
  return 2 ** (Math.ceil(Math.log2(scale) / step - 1e-9) * step);
}

/** Drawable key of draw group `group` of attachment `id` (negative, so never an attachment id). */
const groupKey = (id: number, group: number) => -(id * 64 + group) - 1;
/** Drawable key of frame `frame` of an image sequence (frame 0 is the attachment's own key). */
const SEQUENCE_KEY_BASE = 1 << 24;
const frameKey = (id: number, frame: number) => (frame <= 0 ? id : SEQUENCE_KEY_BASE + id * 256 + frame);

export class AnimatorCharacter extends Container {
  readonly skeleton: Skeleton;
  /**
   * Device pixels per canvas pixel used to anti-alias and level-of-detail the contours. null
   * (default): the longer axis of the container's global transform times displayResolution.
   */
  contourPixelScale: number | null = null;
  /**
   * Device pixels per stage unit (the renderer's resolution, e.g. devicePixelRatio with
   * autoDensity). Multiplies the transform-derived display scale; ignored while contourPixelScale
   * is set (that is already in device pixels).
   */
  displayResolution = 1;
  /**
   * Caller-owned number that must change whenever an input of onAfterApply changes (an IK target,
   * an aim angle): part of the held-pose cache key. Ignored while onAfterApply is null.
   */
  proceduralVersion = 0;
  /**
   * Display-scale quantization in log2 steps (zoom; default 1/8 = 9.05 % per step):
   * strokes (AA band, join steps, level of detail) and the held-pose cache key use the display
   * scale rounded up to a step (quantizeDisplayScale), so a continuous pinch-zoom rebuilds strokes
   * only when it crosses a step; in between the cached geometry scales with the container. 0:
   * exact (golden renders and the surface gates).
   */
  contourScaleStep = 1 / 8;
  /** Contours narrower than this many display pixels are not drawn (level of detail). */
  contourMinPixels = 0.35;
  /** Stroke rebuilds so far (for benches and tests: a still pose rebuilds nothing). */
  contourRebuilds = 0;
  /** Work counters (see AnimatorCharacterStats). */
  readonly stats: AnimatorCharacterStats = { cacheHits: 0, cacheMisses: 0, poseEvaluations: 0, poseSamples: 0, bufferUpdates: 0, msPose: 0, msEmbed: 0, msStroke: 0, msSample: 0, msConstraints: 0, uploadBytes: 0 };
  /** Clock for the stats times (e.g. () => performance.now()); null (default): not timed. */
  profiler: (() => number) | null = null;
  private outfitVersion = 0;
  private cacheValid = false;
  /** Held-pose cache key: pose version, outfit version, skeleton x, y, display scale, contour LOD, procedural version. */
  private readonly cacheKey = new Float64Array(8);
  private afterApply: ((skeleton: Skeleton) => void) | null = null;
  /** Motion reported by moveWorld since the last miss, in skeleton space. */
  private motionX = 0;
  private motionY = 0;
  private physicsOutfit = -1;
  private physicsActive = false;
  private cacheState: object | null = null;
  private readonly atlas: DynamicAtlas;
  private readonly images: PartImageProvider;
  private readonly views: SlotView[];
  private readonly emptyGeometry: MeshGeometry;
  private orderVersion = -1;
  private childCount = 0;
  /** Clipping masks: one Graphics per clipping slot that is active, children of maskHolder (drawn never, used as stencil). */
  private readonly maskHolder = new Container({ label: "clip-masks" });
  private readonly masks = new Map<number, Graphics>();
  private hasClipping = false;
  private missing: string[] = [];
  private rampRegion: AtlasRegion | null = null;
  private readonly ramp: StrokeRamp = { u0: 0, u1: 1, v: 0.5, rampFraction: RAMP_TEXELS / RAMP_WIDTH };

  constructor(options: AnimatorCharacterOptions) {
    super({ label: "AnimatorCharacter" });
    this.skeleton = options.skeleton;
    this.atlas = options.atlas;
    this.images = options.images;
    this.emptyGeometry = new MeshGeometry({
      positions: new Float32Array(EMPTY_GEOMETRY_SIZE * 2),
      uvs: new Float32Array(EMPTY_GEOMETRY_SIZE * 2),
      indices: new Uint32Array([0, 1, 2])
    });
    this.emptyGeometry.batchMode = "batch";
    this.views = this.skeleton.slots.map((slot) => {
      const mesh = new Mesh<MeshGeometry>({ geometry: this.emptyGeometry, label: slot.data.name });
      mesh.blendMode = slot.data.blend === "additive" ? "add" : "normal";
      mesh.visible = false;
      return { slot, mesh, drawables: new Map(), shown: null, tint: 0xffffff, alpha: 1, contours: [] };
    });
    try {
      this.refreshOutfit();
      this.syncFromSkeleton();
    } catch (error) {
      // No character reaches the caller, so nothing could destroy it later: release everything
      // here (refreshOutfit already released what it staged; F3).
      // destroy() takes the meshes already added as children; release only the ones it did not.
      this.destroy();
      for (const view of this.views) if (!view.mesh.destroyed) view.mesh.destroy();
      throw error;
    }
  }

  /** Texture paths of the outfit that no image provider had (those attachments draw nothing). */
  get missingTextures(): readonly string[] {
    return this.missing;
  }

  /**
   * Activates an outfit on the skeleton and loads its textures. Transactional (runtime contract
   * F3): when a texture cannot be acquired (atlas full, an oversized image) it throws, having
   * released what it acquired and restored the previous skins, so the previous outfit stays drawn.
   * The new outfit's textures are acquired before the old ones are released, so a swap needs room
   * for both at once.
   */
  setActiveSkins(names: readonly string[]): void {
    const previous = [...this.skeleton.activeSkins];
    this.skeleton.setActiveSkins(names);
    try {
      this.refreshOutfit();
    } catch (error) {
      this.skeleton.setActiveSkins(previous);
      throw error;
    }
  }

  /**
   * Acquires atlas regions and builds geometry for every drawable attachment (and draw group) the
   * active skins offer, and releases those no longer offered; builds the contour meshes of the
   * active skins. Call after Skeleton.setActiveSkins (the setActiveSkins method here does both).
   * Not a per-frame call. Transactional (F3): everything is acquired and built first; on a failure
   * the new atlas references and staged geometry are released and the current outfit is untouched;
   * only then are the drawables swapped and the old ones released.
   */
  refreshOutfit(): void {
    const missing = new Set<string>();
    const next = this.views.map(() => new Map<number, Drawable>());
    const staged: Drawable[] = [];
    let stagedRamp: AtlasRegion | null = null;
    const keep = (viewIndex: number, key: number, make: () => Drawable) => {
      const existing = (this.views[viewIndex] as SlotView).drawables.get(key);
      (next[viewIndex] as Map<number, Drawable>).set(key, existing ?? stage(make));
    };
    const stage = (make: () => Drawable): Drawable => {
      const drawable = make();
      staged.push(drawable);
      return drawable;
    };
    try {
      this.stageOutfit(missing, keep);
      if (this.skeleton.activeContours.length > 0 && !this.rampRegion) {
        stagedRamp = this.atlas.acquire(COVERAGE_RAMP_KEY, () => coverageRampImage(this.atlas.scale));
      }
    } catch (error) {
      for (const drawable of staged) {
        this.atlas.release(drawable.region);
        drawable.geometry.destroy();
      }
      if (stagedRamp) this.atlas.release(stagedRamp);
      throw error;
    }
    if (stagedRamp) this.useRamp(stagedRamp);
    this.commitOutfit(next, missing);
  }

  /** Collects the drawables of the active skins through `keep` (acquires may throw). */
  private stageOutfit(missing: Set<string>, keep: (viewIndex: number, key: number, make: () => Drawable) => void): void {
    this.views.forEach((view, viewIndex) => {
      for (const attachment of this.outfitAttachments(view.slot)) {
        if (attachment.sequence) {
          // One drawable per frame: each frame is its own atlas region of the same attachment.
          attachmentTexturePaths(attachment).forEach((framePath, frame) => {
            const image = this.images.get(framePath);
            if (!image) {
              missing.add(framePath);
              return;
            }
            keep(viewIndex, frameKey(attachment.id, frame), () => {
              const region = this.atlas.acquire(framePath, () => image);
              const uvs = attachment.type === "region" ? attachment.uvs : attachment.geometry.uvs;
              const triangles = attachment.type === "region" ? attachment.triangles : attachment.geometry.triangles;
              return buildDrawable(attachment, region, uvs, triangles, -1);
            });
          });
          continue;
        }
        const image = this.images.get(attachment.path);
        if (!image) {
          missing.add(attachment.path);
          continue;
        }
        if (attachment.type === "mesh" && isGroupedMesh(attachment)) {
          (attachment.geometry.groups ?? []).forEach((group, g) => {
            const target = this.skeleton.findSlot(group.slot);
            if (!target) return;
            keep(target.index, groupKey(attachment.id, g), () => {
              const region = this.atlas.acquire(attachment.path, () => image);
              return buildDrawable(attachment, region, group.uvs, group.triangles, g);
            });
          });
          continue;
        }
        keep(viewIndex, attachment.id, () => {
          const region = this.atlas.acquire(attachment.path, () => image);
          const uvs = attachment.type === "region" ? attachment.uvs : attachment.geometry.uvs;
          const triangles = attachment.type === "region" ? attachment.triangles : attachment.geometry.triangles;
          return buildDrawable(attachment, region, uvs, triangles, -1);
        });
      }
    });
  }

  /** Swaps in the staged drawables, releasing those no longer offered. Cannot fail. */
  private commitOutfit(next: Map<number, Drawable>[], missing: Set<string>): void {
    this.views.forEach((view, viewIndex) => {
      const nextDrawables = next[viewIndex] as Map<number, Drawable>;
      for (const [key, drawable] of view.drawables) {
        if (nextDrawables.get(key) === drawable) continue;
        if (view.shown === drawable) this.show(view, null);
        this.atlas.release(drawable.region);
        drawable.geometry.destroy();
      }
      view.drawables = nextDrawables;
    });
    this.missing = [...missing].sort();
    this.refreshContours();
    this.refreshClipping();
    this.orderVersion = -1;
    this.outfitVersion++;
  }

  /**
   * Forces the next updateHeld to evaluate. Edits made directly on the skeleton between updates do
   * not survive it (the miss re-applies the state from the setup pose): put them in onAfterApply.
   */
  invalidate(): void {
    this.cacheValid = false;
  }

  /**
   * Procedural pose hook: runs on every miss after the animation state is applied and before the
   * world transform is evaluated (IK targets, aim, direct bone or constraint edits). Its inputs take
   * part in the cache key through proceduralVersion; setting the hook invalidates.
   */
  get onAfterApply(): ((skeleton: Skeleton) => void) | null {
    return this.afterApply;
  }

  set onAfterApply(hook: ((skeleton: Skeleton) => void) | null) {
    this.afterApply = hook;
    this.cacheValid = false;
  }

  /**
   * One frame: advances `state` and the skeleton's physics clock by `delta` seconds together, then
   * updateHeld(state) (its result).
   */
  step(state: AnimationState, delta: number): boolean {
    state.update(delta);
    this.skeleton.update(delta);
    return this.updateHeld(state);
  }

  /**
   * Reports that the character moved by (dx, dy) in its parent's coordinates (the units of
   * `position`) without a skeleton move, so physics gets the move's inertia. Converted to skeleton
   * space through the container's scale, rotation and mirror, and accumulated until the next miss.
   * A rig without an active physics constraint drops it (still a cache hit).
   */
  moveWorld(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.updateLocalTransform();
    const m = this.localTransform;
    const det = m.a * m.d - m.b * m.c;
    if (!(Math.abs(det) > 1e-12)) return;
    this.motionX += (m.d * dx - m.c * dy) / det;
    this.motionY += (m.a * dy - m.b * dx) / det;
  }

  /** True when an active physics constraint of the current outfit simulates (cached per outfit). */
  private hasActivePhysics(): boolean {
    if (this.physicsOutfit !== this.outfitVersion) {
      this.physicsOutfit = this.outfitVersion;
      const skeleton = this.skeleton;
      this.physicsActive = skeleton.physicsConstraints.some((_, i) => skeleton.isConstraintActive("physics", i));
    }
    return this.physicsActive;
  }

  /**
   * Held-pose update: when the cache key is unchanged since the last evaluation,
   * returns false having done nothing; otherwise poses the skeleton from `state` (apply + world
   * transform), redraws and returns true. `state` should have heldFrames on (otherwise its pose
   * version changes every frame and every call misses).
   */
  updateHeld(state: AnimationState): boolean {
    const key = this.cacheKey;
    const version = state.poseVersion;
    const skeleton = this.skeleton;
    const scale = this.displayScale();
    const procedural = this.afterApply ? this.proceduralVersion : 0;
    // Motion only matters to physics: a rig without it drops the motion and can still hit.
    let moving = this.motionX !== 0 || this.motionY !== 0;
    if (moving && !this.hasActivePhysics()) {
      this.motionX = this.motionY = 0;
      moving = false;
    }
    // Physics progression (runtime contract F2): an unsettled simulation keeps running while the
    // animation sample is held (a finished clip, a constant pose, a frozen state), so a physics
    // rig misses whenever its clock moved and its springs are not at rest. A rig without active
    // physics, or with settled physics, keeps hitting; so does a frame with no fixed step due (a 60 Hz
    // frame between the steps of a 30 fps simulation changes nothing).
    const simulating = skeleton.time !== key[7] && this.hasActivePhysics() && !skeleton.physicsSettled && skeleton.physicsStepDue;
    // Separate decisions: sampling, then constraints + world transform, then geometry + upload.
    const sample = !this.cacheValid || this.cacheState !== state || key[0] !== version || key[1] !== this.outfitVersion || key[6] !== procedural;
    const constraints = sample || moving || simulating || key[2] !== skeleton.x || key[3] !== skeleton.y;
    if (!constraints && key[4] === scale && key[5] === this.contourMinPixels) {
      this.stats.cacheHits++;
      return false;
    }
    this.stats.cacheMisses++;
    if (!constraints) {
      // Display scale or contour LOD only: same pose, new strokes.
      this.syncFromSkeleton();
      key[4] = scale;
      key[5] = this.contourMinPixels;
      return true;
    }
    const clock = this.profiler;
    const t0 = clock ? clock() : 0;
    if (sample) {
      state.apply(skeleton);
      if (this.afterApply) this.afterApply(skeleton);
      this.stats.poseSamples++;
    }
    const t1 = clock ? clock() : 0;
    if (moving) {
      // The skeleton stood still while the container moved: tell physics the world moved under it
      // (the reverse of physicsTranslate's "moved on purpose"), so the cloth lags as on a real move.
      skeleton.physicsTranslate(-this.motionX, -this.motionY);
      this.motionX = this.motionY = 0;
    }
    skeleton.updateWorldTransform();
    this.stats.poseEvaluations++;
    if (clock) {
      const t2 = clock();
      this.stats.msPose += t2 - t0;
      this.stats.msSample += t1 - t0;
      this.stats.msConstraints += t2 - t1;
    }
    this.syncFromSkeleton();
    this.cacheState = state;
    key[0] = version;
    key[1] = this.outfitVersion;
    key[2] = skeleton.x;
    key[3] = skeleton.y;
    key[4] = scale;
    key[5] = this.contourMinPixels;
    key[6] = procedural;
    key[7] = skeleton.time;
    this.cacheValid = true;
    return true;
  }

  /** Vertices of the meshes currently drawn (fill, groups and contours): what one character submits. */
  get submittedVertices(): number {
    let total = 0;
    for (const view of this.views) {
      if (view.shown && view.mesh.visible) total += view.shown.positions.length / 2;
      for (const contour of view.contours) if (contour.mesh.visible) total += contour.vertices;
    }
    return total;
  }

  /** Updates the skeleton's world transform (after the caller posed it) and redraws. */
  update(): void {
    this.skeleton.updateWorldTransform();
    this.syncFromSkeleton();
  }

  /**
   * Copies the skeleton's current state into the meshes: draw order, visibility, colours,
   * skinned positions and contour strokes. Use when the skeleton was already updated this frame.
   */
  syncFromSkeleton(): void {
    // Upload images packed since the last frame (a no-op unless a page changed).
    this.atlas.flush();
    const skeleton = this.skeleton;
    const clock = this.profiler;
    const stats = this.stats;
    if (this.orderVersion !== skeleton.drawOrderVersion) {
      this.orderVersion = skeleton.drawOrderVersion;
      this.applyDrawOrder();
    }
    const t0 = clock ? clock() : 0;
    let contours = false;
    let clipping = false;
    for (const view of this.views) {
      const slot = view.slot;
      if (slot.attachment !== null && slot.attachment.type === "clipping") clipping = true;
      const groupMesh = slot.groupMesh;
      let drawable: Drawable | null = null;
      if (groupMesh) {
        if (!slot.hidden) drawable = view.drawables.get(groupKey(groupMesh.id, slot.groupIndex)) ?? null;
      } else {
        const attachment = slot.attachment;
        if (attachment && isDrawable(attachment) && !isGroupedMesh(attachment)) {
          drawable = view.drawables.get(attachment.sequence ? frameKey(attachment.id, slot.sequenceFrame) : attachment.id) ?? null;
        }
      }
      const slotAlpha = slot.color.a * slot.drivenAlpha;
      const alpha = drawable ? slotAlpha * drawable.attachment.color.a : 0;
      if (!drawable || alpha <= 0) {
        if (view.shown) this.show(view, null);
      } else {
        if (view.shown !== drawable) this.show(view, drawable);
        if (drawable.group >= 0) skeleton.computeGroupWorldVertices(slot, drawable.positions);
        else skeleton.computeSlotWorldVertices(slot, drawable.positions);
        drawable.positionBuffer.update();
        stats.bufferUpdates++;
        stats.uploadBytes += drawable.positions.length * 4;

        const color = drawable.attachment.color;
        const tint = rgb24(slot.color.r * color.r, slot.color.g * color.g, slot.color.b * color.b);
        if (tint !== view.tint) setTint(view.mesh, (view.tint = tint));
        if (alpha !== view.alpha) view.mesh.alpha = view.alpha = alpha;
      }
      if (view.contours.length > 0) contours = true;
    }
    if (clipping) {
      if (this.maskHolder.parent !== this) this.addChild(this.maskHolder);
      this.syncClipping();
    } else if (this.hasClipping) {
      this.clearMasks();
      this.maskHolder.removeFromParent();
    }
    this.hasClipping = clipping;
    const t1 = clock ? clock() : 0;
    if (clock) stats.msEmbed += t1 - t0;
    if (!contours) return;
    // Contours after every slot (they read the skeleton only, so the order is free; one pass is
    // one clock read pair).
    for (const view of this.views) {
      if (view.contours.length > 0) this.syncContours(view, view.slot.color.a * view.slot.drivenAlpha);
    }
    if (clock) stats.msStroke += clock() - t1;
  }

  /** The slot meshes in current draw order (for tests and debug tools; contour meshes excluded). */
  get slotMeshes(): readonly Mesh<MeshGeometry>[] {
    return this.skeleton.drawOrder.map((slot) => (this.views[slot.index] as SlotView).mesh);
  }

  /** The contour meshes in current draw order (for tests and debug tools). */
  get contourMeshes(): readonly Mesh<MeshGeometry>[] {
    return this.skeleton.drawOrder.flatMap((slot) => (this.views[slot.index] as SlotView).contours.map((view) => view.mesh));
  }

  override destroy(options?: DestroyOptions): void {
    for (const view of this.views) {
      for (const drawable of view.drawables.values()) {
        this.atlas.release(drawable.region);
        drawable.geometry.destroy();
      }
      view.drawables.clear();
      view.shown = null;
      for (const contour of view.contours) contour.geometry.destroy();
      view.contours = [];
    }
    if (this.rampRegion) this.atlas.release(this.rampRegion);
    this.rampRegion = null;
    this.emptyGeometry.destroy();
    super.destroy({ ...(typeof options === "object" ? options : {}), children: true });
  }

  private show(view: SlotView, drawable: Drawable | null): void {
    view.shown = drawable;
    if (drawable) {
      view.mesh.geometry = drawable.geometry;
      view.mesh.texture = drawable.region.page.texture;
      view.mesh.visible = true;
    } else {
      view.mesh.visible = false;
      view.mesh.geometry = this.emptyGeometry;
    }
  }

  /** Drops the mask state; syncFromSkeleton rebuilds it from the slots that show a clipping attachment. */
  private refreshClipping(): void {
    this.clearMasks();
    this.maskHolder.removeFromParent();
    this.hasClipping = false;
  }

  private clearMasks(): void {
    for (const view of this.views) {
      view.mesh.mask = null;
      for (const contour of view.contours) contour.mesh.mask = null;
    }
    for (const g of this.masks.values()) g.clear();
  }

  /**
   * Spine clipping: a slot showing a clipping attachment starts a mask; every later slot in draw
   * order up to its end slot (inclusive; the end of the draw order when none) is clipped to the
   * polygon. The polygon is the stencil of those meshes.
   */
  private syncClipping(): void {
    const order = this.skeleton.drawOrder;
    let active: Graphics | null = null;
    let endSlot: string | null = null;
    for (const slot of order) {
      const view = this.views[slot.index] as SlotView;
      const attachment = slot.attachment;
      if (attachment && attachment.type === "clipping" && !slot.hidden) {
        let g = this.masks.get(attachment.id);
        if (!g) {
          g = new Graphics();
          this.masks.set(attachment.id, g);
          this.maskHolder.addChild(g);
        }
        const world = this.skeleton.slotPolygonWorld(slot);
        g.clear();
        if (world && world.length >= 6) g.poly(Array.from(world)).fill(0xffffff);
        active = g;
        endSlot = attachment.endSlot;
        view.mesh.mask = null;
        continue;
      }
      const mask = active;
      view.mesh.mask = mask;
      for (const contour of view.contours) contour.mesh.mask = mask;
      if (active && endSlot !== null && slot.data.name === endSlot) {
        active = null;
        endSlot = null;
      }
    }
  }

  private applyDrawOrder(): void {
    const order = this.skeleton.drawOrder;
    if (this.children.length !== this.childCount + (this.maskHolder.parent === this ? 1 : 0)) {
      this.removeChildren();
      for (const slot of order) {
        const view = this.views[slot.index] as SlotView;
        this.addChild(view.mesh);
        for (const contour of view.contours) this.addChild(contour.mesh);
      }
      if (this.hasClipping) this.addChild(this.maskHolder);
      return;
    }
    let i = 0;
    const place = (mesh: Mesh<MeshGeometry>) => {
      if (this.children[i] !== mesh) this.setChildIndex(mesh, i);
      i++;
    };
    for (const slot of order) {
      const view = this.views[slot.index] as SlotView;
      place(view.mesh);
      for (const contour of view.contours) place(contour.mesh);
    }
  }

  private outfitAttachments(slot: Slot): DrawableAttachment[] {
    const result: DrawableAttachment[] = [];
    for (const skin of this.skeleton.activeSkins) {
      const placeholders = this.skeleton.document.skins[skin]?.attachments[slot.data.name];
      if (!placeholders) continue;
      for (const name of Object.keys(placeholders)) {
        const attachment = this.skeleton.getAttachment(slot, name);
        // Only the winning attachment per placeholder (a later skin may override it).
        if (attachment && isDrawable(attachment) && attachment.skin === skin && !result.includes(attachment)) result.push(attachment);
      }
    }
    return result;
  }

  // --- Contours ----------------------------------------------------------------------------------

  private refreshContours(): void {
    const active = this.skeleton.activeContours;
    const byId = new Map<number, ContourView>();
    for (const view of this.views) for (const contour of view.contours) byId.set(contour.contour.id, contour);
    for (const view of this.views) view.contours = [];
    if (active.length > 0 && !this.rampRegion) this.useRamp(this.atlas.acquire(COVERAGE_RAMP_KEY, () => coverageRampImage(this.atlas.scale)));
    for (const contour of active) {
      const slot = this.skeleton.contourSlot(contour);
      const owner = this.views[slot.index] as SlotView;
      const existing = byId.get(contour.id);
      byId.delete(contour.id);
      owner.contours.push(existing ?? this.buildContourView(contour, owner.slot));
    }
    for (const stale of byId.values()) {
      stale.mesh.removeFromParent();
      stale.mesh.destroy();
      stale.geometry.destroy();
    }
    this.childCount = this.views.reduce((sum, view) => sum + 1 + view.contours.length, 0);
  }

  private useRamp(region: AtlasRegion): void {
    this.rampRegion = region;
    this.ramp.u0 = region.u0;
    this.ramp.u1 = region.u1;
    this.ramp.v = (region.v0 + region.v1) / 2;
  }

  private buildContourView(contour: CompiledContour, slot: Slot): ContourView {
    // Sized for any trimmed build (clothing model: up to MAX_TRIM_RUNS runs with faded ends).
    const capacity = trimmedStrokeCapacity(contour.pointCount, contour.closed, contour.roundCaps, filletCapacity(contour));
    const positions = new Float32Array(capacity.vertices * 2);
    const uvs = new Float32Array(capacity.vertices * 2);
    const indices = new Uint32Array(capacity.indices);
    // The full capacity, all degenerate until the first build (constant size: see ContourView.positions).
    const geometry = new MeshGeometry({ positions, uvs, indices });
    geometry.batchMode = "batch";
    const mesh = new Mesh<MeshGeometry>({ geometry, label: `${slot.data.name}:${contour.name}` });
    mesh.texture = (this.rampRegion as AtlasRegion).page.texture;
    mesh.blendMode = "normal";
    mesh.visible = false;
    return {
      contour,
      mesh,
      geometry,
      positions,
      uvs,
      indices,
      packedIndices: new Uint32Array(capacity.indices),
      vertices: 0,
      usedIndices: 0,
      topology: createStrokeTopology(contour.pointCount),
      relative: new Float32Array(capacity.vertices * 2),
      runs: [],
      hasRuns: false,
      relativeValid: false,
      points: new Float32Array(contour.pointCount * 2),
      snapshot: new Float64Array(contour.ownerBones.length * 6),
      built: false,
      deformed: false,
      dependencyVisibility: 0,
      state: new Float64Array(3),
      tint: -1,
      alpha: -1
    };
  }

  private readonly globalScratch = new Matrix();
  private readonly strokeCounts: StrokeCounts = { vertices: 0, indices: 0 };

  private quantRaw = Number.NaN;
  private quantStep = Number.NaN;
  private quantValue = 1;

  /** The quantized display scale (contourScaleStep) the contours and the cache key use. */
  private displayScale(): number {
    const raw = this.rawDisplayScale();
    if (raw !== this.quantRaw || this.contourScaleStep !== this.quantStep) {
      this.quantRaw = raw;
      this.quantStep = this.contourScaleStep;
      this.quantValue = quantizeDisplayScale(raw, this.contourScaleStep);
    }
    return this.quantValue;
  }

  private rawDisplayScale(): number {
    if (this.contourPixelScale !== null) return this.contourPixelScale;
    // The global transform walked from the parents' local transforms, not `worldTransform`: that is
    // only refreshed by a render, so before the first render after a scale change (a character's
    // first frame) it is stale and the stroke's AA band would be built for the wrong display scale.
    const world = this.getGlobalTransform(this.globalScratch, false);
    // Non-uniform scale: the longer axis (strokes are built isotropically in skeleton space, so the
    // AA band stays at most one device pixel along either axis).
    const ax = Math.sqrt(world.a * world.a + world.b * world.b);
    const ay = Math.sqrt(world.c * world.c + world.d * world.d);
    const scale = (ax > ay ? ax : ay) * this.displayResolution;
    return scale > 0 ? scale : 1;
  }

  private syncContours(view: SlotView, slotAlpha: number): void {
    const skeleton = this.skeleton;
    const scale = this.displayScale();
    const aa = 1 / scale;
    const sx = skeleton.x;
    const sy = skeleton.y;
    const bones = skeleton.bones;
    const slotColor = view.slot.color;
    for (const cv of view.contours) {
      const contour = cv.contour;
      const faderIndex = skeleton.contourFaderSlots[contour.id] as number;
      let alpha = contour.color.a * slotAlpha;
      if (faderIndex >= 0) {
        const fader = skeleton.slots[faderIndex] as Slot;
        alpha *= fader.color.a * fader.drivenAlpha * (contour.ownerAttachment as Attachment).color.a;
      }
      if (alpha <= 0 || contour.width * scale < this.contourMinPixels || !skeleton.isContourVisible(contour)) {
        if (cv.mesh.visible) cv.mesh.visible = false;
        continue;
      }
      // Clothing model: visible runs under later opaque coverers (cached per pose-invariant coverer).
      const runs = skeleton.contourRuns(contour);
      if (runs && runs.length === 0) {
        if (cv.mesh.visible) cv.mesh.visible = false;
        if (!cv.hasRuns || cv.runs.length) {
          cv.hasRuns = true;
          cv.runs.length = 0;
          cv.built = false;
        }
        continue;
      }
      // The skeleton reuses its runs array: compare with, and keep, an owned copy.
      let runsChanged = (runs === null) !== !cv.hasRuns || (runs !== null && runs.length !== cv.runs.length);
      if (!runsChanged && runs) for (let r = 0; r < runs.length; r++) if (Math.abs((runs[r] as number) - (cv.runs[r] as number)) > 1e-6) runsChanged = true;
      if (runsChanged) {
        cv.hasRuns = runs !== null;
        cv.runs.length = 0;
        if (runs) for (let r = 0; r < runs.length; r++) cv.runs.push(runs[r] as number);
        cv.built = false;
        cv.topology.valid = false;
      }
      if (!cv.mesh.visible) cv.mesh.visible = true;
      // Compare (and refresh) the user bones' transforms relative to the skeleton origin.
      let moved = false;
      const owners = contour.ownerBones;
      const snapshot = cv.snapshot;
      for (let k = 0, o = 0; k < owners.length; k++, o += 6) {
        const world = (bones[owners[k] as number] as Bone).world;
        const tx = world.x - sx;
        const ty = world.y - sy;
        // The translation is compared with a tolerance: (x + skeleton.x) - skeleton.x is not
        // always x in floating point, and a pure skeleton move must not rebuild. Drift below the
        // tolerance never accumulates unseen: the comparison is against the last build.
        if (
          moved ||
          Math.abs((snapshot[o] as number) - world.a) > MATRIX_EPSILON ||
          Math.abs((snapshot[o + 1] as number) - world.b) > MATRIX_EPSILON ||
          Math.abs((snapshot[o + 2] as number) - world.c) > MATRIX_EPSILON ||
          Math.abs((snapshot[o + 3] as number) - world.d) > MATRIX_EPSILON ||
          Math.abs((snapshot[o + 4] as number) - tx) > TRANSLATION_EPSILON ||
          Math.abs((snapshot[o + 5] as number) - ty) > TRANSLATION_EPSILON
        ) {
          moved = true;
          snapshot[o] = world.a;
          snapshot[o + 1] = world.b;
          snapshot[o + 2] = world.c;
          snapshot[o + 3] = world.d;
          snapshot[o + 4] = tx;
          snapshot[o + 5] = ty;
        }
      }
      const state = cv.state;
      const deformed = skeleton.contourHasAnimatedDeform(contour);
      const visibility = contour.dependencies.length > 0 ? skeleton.contourDependencyVisibility(contour) : 0;
      if (moved || !cv.built || state[2] !== aa || deformed || cv.deformed || visibility !== cv.dependencyVisibility) {
        cv.deformed = deformed;
        cv.dependencyVisibility = visibility;
        skeleton.computeContourPoints(contour, cv.points);
        const counts = this.strokeCounts;
        // The topology skips uvs and indices when the join layout is unchanged (bit-identical).
        if (cv.hasRuns) {
          buildTrimmedStroke(cv.points, contour.pointCount, contour.closed, contour.roundCaps, contour.width, aa, this.ramp, skeleton.contourHandoverRuns(contour, cv.points) ?? cv.runs, cv.positions, cv.uvs, cv.indices, counts, undefined, joinedEndMask(contour.joins), skeleton.contourFillets(contour, cv.points), skeleton.contourCappedEnds(contour, cv.points));
          cv.topology.valid = false;
        } else buildStroke(cv.points, contour.pointCount, contour.closed, contour.roundCaps, contour.width, aa, this.ramp, cv.positions, cv.uvs, cv.indices, counts, cv.topology);
        cv.relativeValid = false;
        // Constant geometry size: a shorter build leaves the tail of the last one degenerate.
        if (counts.topologyChanged !== false && counts.indices < cv.usedIndices) cv.indices.fill(0, counts.indices, cv.usedIndices);
        cv.vertices = counts.vertices;
        cv.usedIndices = counts.indices;
        const geometry = cv.geometry;
        geometry.attributes.aPosition!.buffer.update();
        this.stats.bufferUpdates++;
        this.stats.uploadBytes += cv.vertices * 8;
        if (counts.topologyChanged !== false) {
          geometry.attributes.aUV!.buffer.update();
          geometry.indexBuffer.update();
          if (indicesDiffer(cv.indices, cv.packedIndices)) {
            cv.packedIndices.set(cv.indices);
            const group = cv.mesh.parentRenderGroup;
            if (group) group.structureDidChange = true;
          }
          this.stats.bufferUpdates += 2;
          this.stats.uploadBytes += cv.vertices * 8 + counts.indices * 2;
        }
        cv.built = true;
        state[0] = sx;
        state[1] = sy;
        state[2] = aa;
        this.contourRebuilds++;
      } else if (state[0] !== sx || state[1] !== sy) {
        const positions = cv.positions;
        const relative = cv.relative;
        const floats = cv.vertices * 2;
        if (!cv.relativeValid) {
          // First pure move since the build: positions still hold the build, made at state[0], state[1].
          const bx = state[0] as number;
          const by = state[1] as number;
          for (let i = 0; i < floats; i += 2) {
            relative[i] = (positions[i] as number) - bx;
            relative[i + 1] = (positions[i + 1] as number) - by;
          }
          cv.relativeValid = true;
        }
        for (let i = 0; i < floats; i += 2) {
          positions[i] = (relative[i] as number) + sx;
          positions[i + 1] = (relative[i + 1] as number) + sy;
        }
        cv.geometry.attributes.aPosition!.buffer.update();
        this.stats.bufferUpdates++;
        this.stats.uploadBytes += floats * 4;
        state[0] = sx;
        state[1] = sy;
      }
      const color = contour.color;
      const tint = rgb24(slotColor.r * color.r, slotColor.g * color.g, slotColor.b * color.b);
      if (tint !== cv.tint) setTint(cv.mesh, (cv.tint = tint));
      if (alpha !== cv.alpha) cv.mesh.alpha = cv.alpha = alpha;
    }
  }
}

/**
 * The coverage ramp: white, alpha rising linearly over the first RAMP_TEXELS texels and 1 after,
 * identical rows. Stored at `pixelScale` = the atlas scale so the atlas keeps it texel for texel.
 */
export function coverageRampImage(pixelScale: number): SourceImage {
  const data = new Uint8Array(RAMP_WIDTH * RAMP_HEIGHT * 4);
  for (let y = 0; y < RAMP_HEIGHT; y++) {
    for (let x = 0; x < RAMP_WIDTH; x++) {
      const i = (y * RAMP_WIDTH + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, (x + 0.5) / RAMP_TEXELS) * 255);
    }
  }
  return { pixels: { width: RAMP_WIDTH, height: RAMP_HEIGHT, data }, rect: { x: 0, y: 0, width: RAMP_WIDTH, height: RAMP_HEIGHT }, pixelScale };
}

function buildDrawable(
  attachment: DrawableAttachment,
  region: AtlasRegion,
  imageUvs: Float32Array,
  triangles: Uint16Array | Uint32Array,
  group: number
): Drawable {
  const uvs = new Float32Array(imageUvs.length);
  const du = region.u1 - region.u0;
  const dv = region.v1 - region.v0;
  for (let i = 0; i < imageUvs.length; i += 2) {
    uvs[i] = region.u0 + (imageUvs[i] as number) * du;
    uvs[i + 1] = region.v0 + (imageUvs[i + 1] as number) * dv;
  }
  const positions = new Float32Array(imageUvs.length);
  const geometry = new MeshGeometry({ positions, uvs, indices: sharedIndices(triangles) });
  geometry.batchMode = "batch";
  return { attachment, geometry, positions, positionBuffer: geometry.getBuffer("aPosition"), region, group };
}

/**
 * Sets a container's tint (0xRRGGBB) the way Pixi 8's `tint` setter does (BGR `localColor`, the
 * colour update flag, `_onUpdate`), without going through Pixi's generic Color parser, which
 * allocates on every change. Slot colours can animate every frame, so this is on the per-frame
 * path (src/pixi/allocation.test.ts). animatorCharacter.test.ts checks it against the setter, so
 * a Pixi upgrade that changes the setter fails a test instead of drifting silently.
 */
export function setTint(container: Container, rgb: number): void {
  const bgr = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff);
  if (bgr === container.localColor) return;
  container.localColor = bgr;
  container._updateFlags |= TINT_UPDATE_FLAG;
  container._onUpdate();
}

/** Pixi's UPDATE_COLOR container flag (not exported from the package root). */
const TINT_UPDATE_FLAG = 1;

// Pixi types mesh indices as Uint32Array. Attachments keep compact triangles; each distinct
// triangle list is widened once and shared by every character (read-only).
const widenedIndices = new WeakMap<Uint16Array | Uint32Array, Uint32Array>();
function sharedIndices(triangles: Uint16Array | Uint32Array): Uint32Array {
  if (triangles instanceof Uint32Array) return triangles;
  let widened = widenedIndices.get(triangles);
  if (!widened) widenedIndices.set(triangles, (widened = Uint32Array.from(triangles)));
  return widened;
}

/** Whether a stroke's built index list differs from the one Pixi last packed (see ContourView.packedIndices). */
function indicesDiffer(built: Uint32Array, packed: Uint32Array): boolean {
  for (let i = 0; i < built.length; i++) if (built[i] !== packed[i]) return true;
  return false;
}
