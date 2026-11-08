/*
 * Atlas Animator: original implementation.
 *
 * The runtime skeleton: bones built from a validated document, slots and their attachments, the
 * active skins (outfit), per-instance deform offsets, driven keys, the update order, and the
 * per-frame world-transform pass.
 *
 * Frame order: update(dt) advances the physics clock; setToSetupPose and then animation
 * (AnimationState.apply) write bone poses, slot colours and placeholders, draw-order offsets,
 * deform offsets and constraint values; updateWorldTransform then computes bone world matrices
 * (bones and the IK, transform and physics constraints in update order), evaluates driven keys,
 * and resolves each slot's attachment and the draw order. Renderers read the result.
 *
 * A game loop per character: state.update(dt); skeleton.update(dt); state.apply(skeleton);
 * skeleton.updateWorldTransform() (AnimatorCharacter.update does the last step and the redraw).
 * Moving the character in the world should move `x`/`y` (so cloth reacts); a teleport is followed
 * by physicsTranslate. Off-screen characters can skip physics (updateWorldTransform("none")); the
 * simulation snaps back to the pose when it runs again.
 *
 * Tests can replace a constraint kind's solver (SkeletonOptions.solvers) to exercise the update
 * order in isolation.
 *
 * Joint-ready body: a mesh with draw groups is skinned once per frame (meshWorldVertices
 * caches the result per updateWorldTransform) and each group slot reads its vertices from that one
 * buffer (computeGroupWorldVertices), so group boundaries are identical by construction. Contours of
 * the active skins (activeContours) evaluate their centrelines from the same cache. Driven grids
 * are evaluated with the driven keys, after bones, IK, constraints and limits.
 */
import { attachmentLibraryFor, isGroupedMesh, type Attachment, type AttachmentLibrary, type MeshAttachment } from "./attachments.js";
import { applyContacts, applyJoin, compileContours, computeBoneContourPoints, computeMeshContourPoints, type CompiledContour, type CompiledContours, type ContactInk, type ContourJoin } from "./contours.js";
import { Bone } from "./bone.js";
import { contourCappedEndsOf, contourFilletsOf, contourHandoverRunsOf, contourRunsOf } from "./coverageRuns.js";
import { AnchoredDrawOrder } from "./drawOrder.js";
import { createIkPose, createPathPose, createPhysicsPose, createTransformPose, resetIkPose, resetPathPose, resetPhysicsPose, resetTransformPose, type IkPose, type PathPose, type PhysicsPose, type TransformPose } from "./constraintPose.js";
import { PathConstraint } from "./pathConstraint.js";
import { CompiledDriven, DrivenState, drivenValue, evaluateDriven } from "./driven.js";
import { IkConstraint } from "./ikConstraint.js";
import { MAX_FRAME_DELTA, PhysicsConstraint, type PhysicsClock, type PhysicsMode } from "./physicsConstraint.js";
import { TransformConstraint } from "./transformConstraint.js";
import {
  DEFAULT_CONSTRAINT_ORDER,
  type AnimDocument,
  type IkConstraintData,
  type PathConstraintData,
  type PhysicsConstraintData,
  type TransformConstraintData
} from "./format.js";
import { copyLocalTransform } from "./math.js";
import { sequenceFrame } from "./sequence.js";
import { computePolygonWorld, pointInPolygon, computeEmbeddedVertices, computeGeometryWorldVertices, computeMeshWorldVertices, computeRegionWorldVertices, type NumberArray } from "./skinning.js";
import { Slot } from "./slot.js";
import {
  CONSTRAINT_KINDS,
  planUpdateOrder,
  type ConstraintKind,
  type OrderConstraint,
  type UpdatePlan,
  type UpdateStep
} from "./updateOrder.js";

/** The parts of a document a skeleton is built from (slots, draw order and driven keys optional). */
export type SkeletonDocument = Pick<AnimDocument, "bones" | "skins" | "ik" | "transform" | "physics"> &
  Partial<Pick<AnimDocument, "slots" | "drawOrder" | "driven" | "drivenGrids" | "path">>;

/** Runs one constraint step. `index` is the constraint's index within its kind's list. */
export type ConstraintSolver = (skeleton: Skeleton, index: number) => void;

export interface SkeletonOptions {
  /** Replaces the built-in solver of a constraint kind (tests of the update order). */
  solvers?: Partial<Record<ConstraintKind, ConstraintSolver>>;
}

export interface ConstraintInfo {
  readonly kind: ConstraintKind;
  readonly index: number;
  readonly name: string;
  /** Effective execution order (the document's `order`, or the kind default). */
  readonly order: number;
}

/** Compiled driven keys, shared by every skeleton of the same document object. */
const drivenCache = new WeakMap<SkeletonDocument, CompiledDriven>();
/** Compiled contours, shared likewise. */
const contourCache = new WeakMap<SkeletonDocument, CompiledContours>();

export class Skeleton implements PhysicsClock {
  readonly document: SkeletonDocument;
  readonly bones: readonly Bone[];
  readonly slots: readonly Slot[];
  /** Slots in the current draw order, back to front. Updated in place by updateWorldTransform. */
  readonly drawOrder: Slot[];
  /** Incremented whenever `drawOrder` changes, so renderers re-sort only then. */
  drawOrderVersion = 0;
  /** Attachments of the document (shared by every skeleton of the same document object). */
  readonly attachments: AttachmentLibrary;
  /**
   * Draw-order offsets per slot index, written by animation and reset by setToSetupPose.
   * Driven-key offsets are added on top. Offsets move a slot among the unanchored slots;
   * anchored slots follow their anchors (AnchoredDrawOrder).
   */
  readonly drawOrderOffsets: Int32Array;
  /** Every constraint in execution order: sorted by (order, kind, list index). */
  readonly constraints: readonly ConstraintInfo[];
  /**
   * Whether bone rotation limits clamp the pose. AnimationState.apply sets it: on for a looping pose,
   * off while a non-looping (one-shot, combat) clip is posed, where the swing is judged by the editor gates instead.
   */
  limitsEnforced = true;
  /** World position of skeleton space (0, 0). */
  x = 0;
  y = 0;
  /** Physics clock in seconds, advanced by update(). */
  time = 0;
  /** The clock's last advance (clamped): the time an asleep physics constraint counts on waking. */
  frameDelta = 0;
  /** The physics mode of the current (or last) updateWorldTransform pass. */
  physicsMode: PhysicsMode = "update";

  /** Constraint runtimes, one per document entry, in document order. */
  readonly ikConstraints: readonly IkConstraint[];
  readonly transformConstraints: readonly TransformConstraint[];
  readonly pathConstraints: readonly PathConstraint[];
  readonly physicsConstraints: readonly PhysicsConstraint[];

  private readonly bonesByName: ReadonlyMap<string, Bone>;
  private readonly slotsByName: ReadonlyMap<string, Slot>;
  private readonly orderConstraints: readonly OrderConstraint[];
  /** kind -> list index -> position in orderConstraints (and in plan.constraintActive). */
  private readonly constraintPositions: Readonly<Record<ConstraintKind, readonly number[]>>;
  private readonly solvers: Partial<Record<ConstraintKind, ConstraintSolver>>;
  private skins: readonly string[] = [];
  private readonly activeSkinSet = new Set<string>();
  private plan: UpdatePlan;
  /** Per slot index: placeholder name -> attachment, for the active skins. */
  private outfit: ReadonlyMap<string, Attachment>[] = [];

  /**
   * Keyable constraint values (mixes, softness, IK flags, physics reset requests), one per
   * constraint in document order. Animation writes them; setToSetupPose resets them (except
   * `resetRequested`, which the physics solver consumes). The solvers (phase 3) read them.
   */
  readonly ikPoses: readonly IkPose[];
  readonly transformPoses: readonly TransformPose[];
  readonly pathPoses: readonly PathPose[];
  readonly physicsPoses: readonly PhysicsPose[];

  // Draw order: anchored resolution, combined offsets, the order last published.
  private readonly drawOrderResolver: AnchoredDrawOrder;
  private readonly combinedOffsets: Int32Array;
  private readonly order: Int32Array;

  // Deform, per deform owner: animation-written offsets, and the sum with driven offsets.
  private readonly animationDeform: (Float32Array | null)[];
  private readonly animationDeformActive: Uint8Array;
  private readonly combinedDeform: (Float32Array | null)[];

  private readonly driven: CompiledDriven;
  private readonly drivenState: DrivenState;

  // Draw groups and contours.
  private readonly contourData: CompiledContours;
  /** Contours of the active skins, in skin merge order. Rebuilt when the active skins change. */
  private active: readonly CompiledContour[] = [];
  /** Per contour id: owner slot index. */
  private readonly contourSlots: Int32Array;
  /** Per contour: the slot index of its owning attachment (-1: no attachment gate). */
  private readonly contourOwnerSlots: Int32Array;
  /** Per contour id: the slot whose alpha fades the stroke (its the user's, when elsewhere), or -1. */
  readonly contourFaderSlots: Int32Array;
  /** Per contour id: the deform owner indices whose animation deform moves its centreline (contourHasAnimatedDeform). */
  private readonly contourDeformOwners: Int32Array[];
  /** Grouped mesh attachment id -> slot index per group (-1 for an unknown slot). */
  private readonly groupSlots = new Map<number, Int32Array>();
  /** Per attachment id: skinned world vertices of the current pass (meshes with groups or contours). */
  private readonly meshWorld: (Float32Array | null)[];
  private readonly meshWorldStamp: Int32Array;
  private worldStamp = 1;
  private readonly skinGate = (skin: string): boolean => this.activeSkinSet.has(skin);

  /** `doc` must come from loadAnimDocument/parseAnimDocument (validated, defaults filled). */
  constructor(doc: SkeletonDocument, options: SkeletonOptions = {}) {
    this.document = doc;
    this.solvers = { ...options.solvers };

    const byName = new Map<string, Bone>();
    const bones: Bone[] = [];
    doc.bones.forEach((data, i) => {
      const parent = data.parent === undefined ? null : byName.get(data.parent);
      if (parent === undefined) throw new Error(`bone '${data.name}': parent '${data.parent}' is not listed before it`);
      const bone = new Bone(data, i, parent, this);
      bones.push(bone);
      byName.set(data.name, bone);
    });
    this.bones = bones;
    this.bonesByName = byName;

    const indexOf = (name: string, owner: string): number => {
      const bone = byName.get(name);
      if (!bone) throw new Error(`${owner}: unknown bone '${name}'`);
      return bone.index;
    };

    const slots = (doc.slots ?? []).map((data, i) => new Slot(data, i, bones[indexOf(data.bone, `slot '${data.name}'`)] as Bone));
    this.slots = slots;
    this.slotsByName = new Map(slots.map((slot) => [slot.data.name, slot]));
    this.attachments = attachmentLibraryFor(doc);

    // Setup draw order: the document's list, then any slot it omits in slot order (loader warning).
    const listed = (doc.drawOrder ?? []).map((name) => this.slotsByName.get(name)?.index ?? -1).filter((i) => i >= 0);
    const seen = new Set(listed);
    const setup = [...listed, ...slots.map((slot) => slot.index).filter((i) => !seen.has(i))];
    this.drawOrderResolver = new AnchoredDrawOrder(slots.map((slot) => slot.data), setup);
    this.combinedOffsets = new Int32Array(slots.length);
    this.drawOrderOffsets = new Int32Array(slots.length);
    this.order = new Int32Array(slots.length);
    this.drawOrderResolver.resolve(this.combinedOffsets, this.order);
    this.drawOrder = Array.from(this.order, (i) => slots[i] as Slot);

    this.ikPoses = doc.ik.map(createIkPose);
    this.transformPoses = doc.transform.map(createTransformPose);
    this.physicsPoses = doc.physics.map(createPhysicsPose);
    const pathData = doc.path ?? [];
    this.pathPoses = pathData.map(createPathPose);
    const boneOf = (name: string, owner: string) => bones[indexOf(name, owner)] as Bone;
    this.ikConstraints = doc.ik.map(
      (c, i) => new IkConstraint(c, this.ikPoses[i] as IkPose, c.bones.map((b) => boneOf(b, c.name)), boneOf(c.target, c.name))
    );
    this.transformConstraints = doc.transform.map(
      (c, i) =>
        new TransformConstraint(c, this.transformPoses[i] as TransformPose, c.bones.map((b) => boneOf(b, c.name)), boneOf(c.target, c.name), this)
    );
    this.pathConstraints = pathData.map((c, i) => {
      const slot = this.slotsByName.get(c.target);
      if (!slot) throw new Error(`${c.name}: unknown slot '${c.target}'`);
      return new PathConstraint(c, this.pathPoses[i] as PathPose, c.bones.map((b) => boneOf(b, c.name)), slot, this);
    });
    this.physicsConstraints = doc.physics.map(
      (c, i) => new PhysicsConstraint(c, this.physicsPoses[i] as PhysicsPose, boneOf(c.bone, c.name), this)
    );

    const ownerCount = this.attachments.deformOwners.length;
    this.animationDeform = new Array<Float32Array | null>(ownerCount).fill(null);
    this.animationDeformActive = new Uint8Array(ownerCount);
    this.combinedDeform = new Array<Float32Array | null>(ownerCount).fill(null);

    let compiled = drivenCache.get(doc);
    if (!compiled) {
      const slotsByName = this.slotsByName;
      compiled = new CompiledDriven(
        doc.driven ?? [],
        {
          boneIndex: (name) => indexOf(name, "driven key"),
          slotIndex: (name) => {
            const slot = slotsByName.get(name);
            if (!slot) throw new Error(`driven key: unknown slot '${name}'`);
            return slot.index;
          },
          library: this.attachments
        },
        doc.drivenGrids ?? []
      );
      drivenCache.set(doc, compiled);
    }
    this.driven = compiled;
    this.drivenState = new DrivenState(this.driven, this.attachments, slots.length);

    let contours = contourCache.get(doc);
    if (!contours) {
      const driven = this.driven;
      contours = compileContours(doc, {
        boneIndex: (name) => indexOf(name, "contour"),
        slotBone: (name) => {
          const slot = this.slotsByName.get(name);
          if (!slot) throw new Error(`contour: unknown slot '${name}'`);
          return slot.bone.index;
        },
        library: this.attachments,
        driven
      });
      contourCache.set(doc, contours);
    }
    this.contourData = contours;
    this.contourSlots = Int32Array.from(contours.all, (contour) => this.slotsByName.get(contour.slot)?.index ?? -1);
    this.contourOwnerSlots = Int32Array.from(contours.all, (contour) => (contour.ownerAttachment ? (this.slotsByName.get(contour.ownerSlot)?.index ?? -1) : -1));
    // Owners (explicit, or the bound mesh) in another slot than the stroke's: that slot's alpha fades
    // the stroke (-1: none).
    this.contourFaderSlots = Int32Array.from(contours.all, (contour, i) => {
      const owner = this.contourOwnerSlots[i] as number;
      return contour.ownerAttachment && owner >= 0 && owner !== this.contourSlots[i] ? owner : -1;
    });
    // Animation deform that moves a centreline without a bone: its mesh, the embed source chain of
    // that mesh, and the same for each geometry dependency (contact partners, junction inks).
    const meshOwners = (mesh: MeshAttachment | null, out: Set<number>) => {
      for (let m = mesh; m; m = m.embedSource) if (m.deformOwner.deformIndex >= 0) out.add(m.deformOwner.deformIndex);
    };
    this.contourDeformOwners = contours.all.map((contour) => {
      const owners = new Set<number>();
      meshOwners(contour.mesh, owners);
      for (const id of contour.dependencies) meshOwners((contours.all[id] as CompiledContour).mesh, owners);
      return Int32Array.from(owners);
    });
    for (const attachment of this.attachments.attachments) {
      if (attachment.type !== "mesh" || !isGroupedMesh(attachment)) continue;
      const groups = attachment.geometry.groups ?? [];
      this.groupSlots.set(attachment.id, Int32Array.from(groups, (group) => this.slotsByName.get(group.slot)?.index ?? -1));
    }
    this.meshWorld = new Array<Float32Array | null>(this.attachments.attachments.length).fill(null);
    this.meshWorldStamp = new Int32Array(this.attachments.attachments.length);

    const constraints: (OrderConstraint & { order: number })[] = [];
    for (const kind of CONSTRAINT_KINDS) {
      if (kind === "physics") {
        doc.physics.forEach((c, index) =>
          constraints.push({
            kind,
            index,
            name: c.name,
            order: c.order ?? DEFAULT_CONSTRAINT_ORDER[kind],
            skin: c.skin,
            bones: [indexOf(c.bone, c.name)],
            target: -1
          })
        );
      } else if (kind === "path") {
        pathData.forEach((c, index) => {
          const slot = this.slotsByName.get(c.target) as Slot;
          constraints.push({
            kind,
            index,
            name: c.name,
            order: c.order ?? DEFAULT_CONSTRAINT_ORDER[kind],
            skin: c.skin,
            bones: c.bones.map((bone) => indexOf(bone, c.name)),
            target: slot.bone.index,
            reads: this.pathReadBones(c.target)
          });
        });
      } else {
        doc[kind].forEach((c, index) =>
          constraints.push({
            kind,
            index,
            name: c.name,
            order: c.order ?? DEFAULT_CONSTRAINT_ORDER[kind],
            skin: c.skin,
            bones: c.bones.map((bone) => indexOf(bone, c.name)),
            target: indexOf(c.target, c.name)
          })
        );
      }
    }
    // Sort key (order, kind, list index): the push order above already is (kind, list index) and
    // Array.prototype.sort is stable, so sorting by order alone yields the full key.
    constraints.sort((a, b) => a.order - b.order);
    this.orderConstraints = constraints;
    this.constraints = constraints.map(({ kind, index, name, order }) => ({ kind, index, name, order }));
    const positions: Record<ConstraintKind, number[]> = { ik: [], transform: [], path: [], physics: [] };
    constraints.forEach((c, position) => {
      positions[c.kind][c.index] = position;
    });
    this.constraintPositions = positions;
    this.plan = this.buildPlan();
    this.buildOutfit();
  }

  /** Bone indices every weighted path attachment of `slot` (any skin) is bound to: read by a path constraint on that slot. */
  private pathReadBones(slot: string): number[] {
    const found = new Set<number>();
    for (const skin of Object.values(this.document.skins)) {
      for (const attachment of Object.values(skin.attachments[slot] ?? {})) {
        if (attachment.type !== "path" || !attachment.bones) continue;
        for (const name of attachment.bones) {
          const bone = this.bonesByName.get(name);
          if (bone) found.add(bone.index);
        }
      }
    }
    return [...found];
  }

  findBone(name: string): Bone | undefined {
    return this.bonesByName.get(name);
  }

  getBone(name: string): Bone {
    const bone = this.bonesByName.get(name);
    if (!bone) throw new Error(`unknown bone '${name}'`);
    return bone;
  }

  findSlot(name: string): Slot | undefined {
    return this.slotsByName.get(name);
  }

  getSlot(name: string): Slot {
    const slot = this.slotsByName.get(name);
    if (!slot) throw new Error(`unknown slot '${name}'`);
    return slot;
  }

  /** Names of the active skins, in merge order. */
  get activeSkins(): readonly string[] {
    return this.skins;
  }

  /**
   * Activates exactly these skins (an outfit), in merge order: where two skins define the same
   * placeholder of a slot, the later one wins. Hides of every active skin apply. Rebuilds the
   * update order (skin bones and constraints) and re-resolves slot attachments.
   */
  setActiveSkins(names: readonly string[]): void {
    for (const name of names) {
      if (!(name in this.document.skins)) throw new Error(`unknown skin '${name}'`);
    }
    this.skins = [...names];
    this.activeSkinSet.clear();
    for (const name of names) this.activeSkinSet.add(name);
    const wasActive = this.physicsConstraints.map((_, i) => this.isConstraintActive("physics", i));
    this.plan = this.buildPlan();
    // A physics constraint switched on by this outfit starts from the pose, not from stale state.
    this.physicsConstraints.forEach((constraint, i) => {
      if (!wasActive[i] && this.isConstraintActive("physics", i)) constraint.reset();
    });
    this.buildOutfit();
    this.resolveAttachments();
  }

  isSkinActive(name: string): boolean {
    return this.activeSkinSet.has(name);
  }

  /** The attachment the active skins show for `placeholder` on `slot` (ignoring hides), if any. */
  getAttachment(slot: Slot, placeholder: string): Attachment | undefined {
    return this.outfit[slot.index]?.get(placeholder);
  }

  /** Contours of the active skins, in skin merge order. */
  get activeContours(): readonly CompiledContour[] {
    return this.active;
  }

  /** The owner slot of a contour. */
  contourSlot(contour: CompiledContour): Slot {
    return this.slots[this.contourSlots[contour.id] as number] as Slot;
  }

  /**
   * Whether a contour draws this frame (before colour and level of detail): its owner slot is not
   * hidden and its bone is active, its owning attachment is displayed (part c: the slot
   * of `owner` / the bound mesh is not hidden and shows that attachment or a mesh sharing its
   * deform), and every visibility rule holds.
   */
  isContourVisible(contour: CompiledContour): boolean {
    const slot = this.slots[this.contourSlots[contour.id] as number];
    if (!slot || slot.hidden || !slot.bone.active) return false;
    const owner = contour.ownerAttachment;
    if (owner) {
      const holder = this.slots[this.contourOwnerSlots[contour.id] as number];
      if (!holder || holder.hidden) return false;
      const shown = holder.attachment;
      if (shown !== owner && !(shown && shown.type === "mesh" && owner.type === "mesh" && shown.deformOwner === owner.deformOwner)) return false;
    }
    for (let i = 0; i < contour.visibleBones.length; i++) {
      const bone = this.bones[contour.visibleBones[i] as number] as Bone;
      if (!bone.active) return false;
      const value = drivenValue(bone);
      if (value < (contour.visibleMin[i] as number) || value > (contour.visibleMax[i] as number)) return false;
    }
    return true;
  }

  /**
   * Effective opacity of a contour's owner (clothing model, close): the user slot's
   * alpha x driven alpha x attachment alpha when the user sits in another slot than the one the
   * stroke draws in (a garment fading in its own slot fades its strokes too); 1 otherwise.
   * Renderers multiply it into the stroke alpha.
   */
  contourOwnerAlpha(contour: CompiledContour): number {
    const holder = this.contourOwnerHolder(contour);
    return holder ? holder.color.a * holder.drivenAlpha * (contour.ownerAttachment as Attachment).color.a : 1;
  }

  /** The user's slot when it is not the slot the stroke draws in (its alpha fades the stroke), else null. */
  contourOwnerHolder(contour: CompiledContour): Slot | null {
    const index = this.contourFaderSlots[contour.id] as number;
    return index >= 0 ? (this.slots[index] as Slot) : null;
  }


  /**
   * Clothing model (close, core/coverage.ts): the visible runs of a contour's stroke this
   * frame, or null when nothing covers it (draw it whole). Coverers are the pieces drawn after the
   * contour's slot (attachments and draw groups) that are shown, opaque enough (COVER_ALPHA) and not
   * the contour's own mesh family. A coverer riding the contour's surface (same root mesh, fully
   * embedded) covers a pose-invariant interval: computed once per (contour, coverer) and cached, so
   * a swap while posed gives the same trims as at the setup pose. Rigid coverers (region plates,
   * bone-bound meshes) are evaluated from their posed polygon each call. `points` is the current
   * centreline when the caller has it (else it is computed). Allocation-free in the steady state:
   * the returned array is owned by the skeleton and reused (copy it to keep it).
   */
  contourRuns(contour: CompiledContour, points?: ArrayLike<number>): number[] | null {
    return contourRunsOf(this, contour, points);
  }

  /**
   * Arm layer: the fillet pieces of a `coverUnder` contour this frame (core/trimFillet.ts): where a
   * trimmed end of its visible run meets a trimmed end of an under-sheet contour at an acute corner,
   * a short arc piece that closes the corner's tip with ink. Layout: point count, then x, y per
   * point, per piece; null when there is none. `points` is the current centreline. The array is
   * owned by the skeleton and reused.
   */
  contourFillets(contour: CompiledContour, points: ArrayLike<number>): number[] | null {
    return contourFilletsOf(this, contour, points);
  }

  /**
   * Line junctions (arm layer): per visible run, bit 0 / bit 1 when its start / end is a
   * trim on another visible line of the same width: drawn with full ink and its round cap (a round
   * join with that line, or hidden under it) instead of a feather. Null when there is none.
   * Owned and reused, like contourRuns.
   */
  contourCappedEnds(contour: CompiledContour, points: ArrayLike<number>): number[] | null {
    return contourCappedEndsOf(this, contour, points);
  }

  /**
   * Hand-over bridges (arm layer, core/trimFillet.ts appendHandover): the visible runs to
   * draw, with each end that hands over to the line it meets at a wide corner cut back to the
   * bridge (the over line's contourFillets carries the bridge piece, contourCappedEnds marks the
   * cut ends). Null when there is none: draw contourRuns. Owned and reused.
   */
  contourHandoverRuns(contour: CompiledContour, points: ArrayLike<number>): number[] | null {
    return contourHandoverRunsOf(this, contour, points);
  }

  /**
   * True when animation deform keys move the contour's centreline this frame without any bone: its
   * mesh, the source mesh its embedded vertices ride (recursively), and the same for every contour
   * in `contour.dependencies` (contact partners and junction inks).
   */
  contourHasAnimatedDeform(contour: CompiledContour): boolean {
    const owners = this.contourDeformOwners[contour.id] as Int32Array;
    const active = this.animationDeformActive;
    for (let i = 0; i < owners.length; i++) if (active[owners[i] as number] === 1) return true;
    return false;
  }

  /**
   * Visibility of `contour.dependencies` as one number (bit i: dependency i draws): a contact's
   * merge and junctions read only drawn inks, so a change moves the centreline without any bone.
   * 0 without dependencies; NaN (never equal: always a change) past 52 dependencies.
   */
  contourDependencyVisibility(contour: CompiledContour): number {
    const deps = contour.dependencies;
    if (deps.length > 52) return Number.NaN;
    let mask = 0;
    for (let i = 0, bit = 1; i < deps.length; i++, bit *= 2) {
      if (this.isContourVisible(this.contourData.all[deps[i] as number] as CompiledContour)) mask += bit;
    }
    return mask;
  }

  /** Writes a contour's world centreline (2 floats per point, skeleton x/y included). */
  computeContourPoints(contour: CompiledContour, out: Float32Array): void {
    if (!contour.contacts.length) {
      if (contour.joins.length) out.set(this.contourRaw(contour));
      else this.rawContourPoints(contour, out);
      this.applyContourJoins(contour, out);
      return;
    }
    const raw = this.contourRaw(contour);
    out.set(raw);
    // Contour contacts: merged along the pair's contact run while the partner draws; every drawn ink
    // of the skin is a junction candidate (core/contours.ts applyContacts).
    const inks: (ContactInk | null)[] = [];
    for (const other of this.active) {
      if (other === contour || other.skin !== contour.skin || !this.isContourVisible(other)) continue;
      inks[other.id] = { points: this.contourRaw(other), count: other.pointCount, closed: other.closed, width: other.width, chain: other.chain };
    }
    applyContacts(out, { points: raw, count: contour.pointCount, closed: contour.closed, width: contour.width, chain: contour.chain }, contour.contacts, inks);
    this.applyContourJoins(contour, out);
  }

  /** Contour joins (core/contours.ts applyJoin) with each drawn partner, on unmoved centrelines. */
  private applyContourJoins(contour: CompiledContour, out: Float32Array): void {
    const joins = contour.joins;
    for (let i = 0; i < joins.length; i++) {
      const join = joins[i] as ContourJoin;
      const other = this.contourData.all[join.other] as CompiledContour;
      if (!this.isContourVisible(other)) continue;
      const own = this.contourRaw(contour);
      const theirs = this.contourRaw(other);
      if (join.isA) applyJoin(out, true, own, contour.pointCount, theirs, other.pointCount, join);
      else applyJoin(out, false, theirs, other.pointCount, own, contour.pointCount, join);
    }
  }

  /** A contour's centreline without contact merges (2 floats per point). */
  rawContourPoints(contour: CompiledContour, out: Float32Array): void {
    const mesh = contour.mesh;
    if (mesh) computeMeshContourPoints(contour, this.meshWorldVertices(mesh, this.bones[contour.meshSlotBone] as Bone), out);
    else computeBoneContourPoints(contour, this.bones, out);
  }

  private readonly contourRawCache: { stamp: number; points: Float32Array }[] = [];

  /** A contour's unmoved centreline for the current pass (cached per world update). */
  private contourRaw(contour: CompiledContour): Float32Array {
    let entry = this.contourRawCache[contour.id];
    if (!entry) this.contourRawCache[contour.id] = entry = { stamp: 0, points: new Float32Array(contour.pointCount * 2) };
    if (entry.stamp !== this.worldStamp) {
      entry.stamp = this.worldStamp;
      this.rawContourPoints(contour, entry.points);
    }
    return entry.points;
  }

  /**
   * The world vertices of a mesh (2 floats per vertex) for the current pass: skinned on first use
   * after each updateWorldTransform and cached, so every group and contour of the mesh reads one
   * result. `slotBone` is the bone of the mesh's slot (used by unweighted meshes). Do not modify.
   */
  meshWorldVertices(mesh: MeshAttachment, slotBone: Bone): Float32Array {
    let world = this.meshWorld[mesh.id];
    if (!world) this.meshWorld[mesh.id] = world = new Float32Array(mesh.geometry.vertexCount * 2);
    if (this.meshWorldStamp[mesh.id] !== this.worldStamp) {
      this.meshWorldStamp[mesh.id] = this.worldStamp;
      computeGeometryWorldVertices(mesh.geometry, slotBone, this.bones, this.deformFor(mesh), world);
      const source = mesh.embedSource;
      if (source) {
        const embed = mesh.geometry.embed as NonNullable<MeshAttachment["geometry"]["embed"]>;
        const sourceBone = this.slotsByName.get(embed.slot)?.bone ?? slotBone;
        computeEmbeddedVertices(embed, this.meshWorldVertices(source, sourceBone), world);
      }
    }
    return world;
  }

  /**
   * Writes the world vertices of the draw group shown in `slot` (slot.groupMesh) into `out` and
   * returns the group's vertex count (0 when the slot shows no group). Each group vertex is copied
   * from the mesh's single skinned result, so boundary vertices match bit for bit.
   */
  computeGroupWorldVertices(slot: Slot, out: NumberArray, offset = 0, stride = 2): number {
    const mesh = slot.groupMesh;
    const owner = slot.groupOwner;
    if (!mesh || !owner) return 0;
    const group = (mesh.geometry.groups as NonNullable<MeshAttachment["geometry"]["groups"]>)[slot.groupIndex];
    if (!group) return 0;
    const vertices = group.vertices;
    checkCapacity(out, offset, stride, vertices.length);
    const world = this.meshWorldVertices(mesh, owner.bone);
    for (let i = 0, o = offset; i < vertices.length; i++, o += stride) {
      const v = (vertices[i] as number) * 2;
      out[o] = world[v] as number;
      out[o + 1] = world[v + 1] as number;
    }
    return vertices.length;
  }

  /** The current update order. Rebuilt only when the active skins change. */
  get updateSteps(): readonly UpdateStep[] {
    return this.plan.steps;
  }

  isConstraintActive(kind: ConstraintKind, index: number): boolean {
    const position = this.constraintPositions[kind][index];
    return position !== undefined && this.plan.constraintActive[position] === true;
  }

  /** Resets bones, slots, draw-order offsets and animation deform to the setup pose. */
  setToSetupPose(): void {
    for (const bone of this.bones) bone.setToSetupPose();
    this.setSlotsToSetupPose();
  }

  setSlotsToSetupPose(): void {
    for (const slot of this.slots) slot.setToSetupPose();
    this.drawOrderOffsets.fill(0);
    this.animationDeformActive.fill(0);
    this.setConstraintsToSetupPose();
  }

  /** Resets the keyable constraint values (mixes, softness, IK flags) to the document's. */
  setConstraintsToSetupPose(): void {
    // Plain loops: this runs every frame (AnimationState.apply) and must not allocate.
    const doc = this.document;
    for (let i = 0; i < this.ikPoses.length; i++) resetIkPose(this.ikPoses[i] as IkPose, doc.ik[i] as IkConstraintData);
    for (let i = 0; i < this.transformPoses.length; i++) {
      resetTransformPose(this.transformPoses[i] as TransformPose, doc.transform[i] as TransformConstraintData);
    }
    const pathData = doc.path ?? [];
    for (let i = 0; i < this.pathPoses.length; i++) resetPathPose(this.pathPoses[i] as PathPose, pathData[i] as PathConstraintData);
    for (let i = 0; i < this.physicsPoses.length; i++) resetPhysicsPose(this.physicsPoses[i] as PhysicsPose, doc.physics[i] as PhysicsConstraintData);
  }

  /**
   * Animation deform offsets of a deform owner (allocated on first use), marked active for this
   * frame. Deform timelines write into it; setToSetupPose deactivates it.
   */
  animationDeformFor(owner: MeshAttachment): Float32Array {
    const index = owner.deformIndex;
    if (index < 0) throw new Error(`'${owner.skin}/${owner.slot}/${owner.name}' inherits deform; key its source mesh`);
    let deform = this.animationDeform[index];
    if (!deform) this.animationDeform[index] = deform = new Float32Array(owner.geometry.deformLength);
    if (this.animationDeformActive[index] === 0) {
      deform.fill(0);
      this.animationDeformActive[index] = 1;
    }
    return deform;
  }

  /**
   * The deform offsets moving `mesh` this frame (animation plus driven keys), or null for none.
   * Valid after updateWorldTransform.
   */
  deformFor(mesh: MeshAttachment): Float32Array | null {
    const index = mesh.deformOwner.deformIndex;
    const animated = this.animationDeformActive[index] === 1 ? this.animationDeform[index] ?? null : null;
    const driven = this.drivenState.deformActive[index] === 1 ? this.drivenState.deform[index] ?? null : null;
    if (!animated) return driven;
    if (!driven) return animated;
    let combined = this.combinedDeform[index];
    if (!combined) this.combinedDeform[index] = combined = new Float32Array(animated.length);
    for (let i = 0; i < combined.length; i++) combined[i] = (animated[i] as number) + (driven[i] as number);
    return combined;
  }

  /**
   * Advances the physics clock by `delta` seconds (must be finite; negative counts as 0, more than 0.25 s as
   * 0.25 s). Call once per frame, before updateWorldTransform.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta)) throw new Error(`Skeleton.update: delta must be a finite number of seconds (got ${delta})`);
    this.frameDelta = delta > 0 ? (delta < MAX_FRAME_DELTA ? delta : MAX_FRAME_DELTA) : 0;
    this.time += this.frameDelta;
  }

  /**
   * True when no active physics constraint still needs simulating: each is settled (see
   * PhysicsConstraint.settled) and has no reset request pending. A held-pose cache may skip pose
   * evaluation only while this holds (runtime contract F2). Allocation-free.
   */
  get physicsSettled(): boolean {
    const constraints = this.physicsConstraints;
    for (let i = 0; i < constraints.length; i++) {
      if (!this.isConstraintActive("physics", i)) continue;
      const constraint = constraints[i] as PhysicsConstraint;
      if (!constraint.settled || constraint.pose.resetRequested) return false;
    }
    return true;
  }

  /**
   * True when an active, unsettled physics constraint has a fixed step due at the current clock
   * (PhysicsConstraint.stepDue). A held-pose cache may hit on a frame with no step due. Allocation-free.
   */
  get physicsStepDue(): boolean {
    const constraints = this.physicsConstraints;
    for (let i = 0; i < constraints.length; i++) {
      if (!this.isConstraintActive("physics", i)) continue;
      const constraint = constraints[i] as PhysicsConstraint;
      if ((!constraint.settled || constraint.pose.resetRequested) && constraint.stepDue(this.time)) return true;
    }
    return false;
  }

  /** Clears every physics simulation; each snaps to the pose at its next update. */
  resetPhysics(): void {
    for (const constraint of this.physicsConstraints) constraint.reset();
  }

  /**
   * Tells physics the skeleton was moved by (x, y) on purpose (teleport, respawn), so cloth does
   * not react. Call together with the move (for example after changing `x`/`y`).
   */
  physicsTranslate(x: number, y: number): void {
    for (const constraint of this.physicsConstraints) constraint.translate(x, y);
  }

  /** Tells physics the skeleton was turned by `degrees` about world (x, y) on purpose. */
  physicsRotate(x: number, y: number, degrees: number): void {
    for (const constraint of this.physicsConstraints) constraint.rotate(x, y, degrees);
  }

  /**
   * Holds the current pose for `seconds` of physics time, so cloth settles (gravity sag, rest
   * offsets) before the first frame of a render. Pose the skeleton first; the pose is kept.
   */
  warmUpPhysics(seconds: number, fps = 60): void {
    const steps = Math.ceil(seconds * fps);
    for (let i = 0; i < steps; i++) {
      this.update(1 / fps);
      this.updateWorldTransform("update");
    }
  }

  /**
   * Computes every active bone's world transform from its pose (bones and constraints in update
   * order), then evaluates driven keys and resolves slot attachments and the draw order.
   * `physics` picks what physics constraints do this pass (default: simulate and apply).
   */
  updateWorldTransform(physics: PhysicsMode = "update"): void {
    this.physicsMode = physics;
    for (const bone of this.bones) copyLocalTransform(bone.pose, bone.applied);
    const steps = this.plan.steps;
    const solvers = this.solvers;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as UpdateStep;
      if (step.kind === "bone") {
        (this.bones[step.bone] as Bone).updateWorldTransform();
        continue;
      }
      const solver = solvers[step.kind];
      if (solver) solver(this, step.index);
      else if (step.kind === "ik") (this.ikConstraints[step.index] as IkConstraint).update();
      else if (step.kind === "transform") (this.transformConstraints[step.index] as TransformConstraint).update();
      else if (step.kind === "path") (this.pathConstraints[step.index] as PathConstraint).update();
      else (this.physicsConstraints[step.index] as PhysicsConstraint).update();
    }
    evaluateDriven(this.driven, this.bones, this.skinGate, this.drivenState);
    // Invalidate the skinned-mesh cache (stays positive; 0 marks a never-filled entry).
    this.worldStamp = this.worldStamp >= 0x3fffffff ? 1 : this.worldStamp + 1;
    this.resolveAttachments();
    this.updateDrawOrder();
  }

  /**
   * Floats `computeSlotWorldVertices` (or, for a draw-group slot, `computeGroupWorldVertices`)
   * writes for `slot` at stride 2: size a typed buffer with it.
   */
  slotWorldFloats(slot: Slot): number {
    const mesh = slot.groupMesh;
    if (mesh) return 2 * (mesh.geometry.groups?.[slot.groupIndex]?.vertices.length ?? 0);
    const attachment = slot.attachment;
    if (!attachment) return 0;
    if (attachment.type === "region") return 8;
    return attachment.type === "mesh" ? 2 * attachment.geometry.vertexCount : 0;
  }

  /**
   * Writes the world vertices of the slot's current drawable attachment into `out` and returns
   * the vertex count (0 when the slot shows nothing or a point).
   */
  computeSlotWorldVertices(slot: Slot, out: NumberArray, offset = 0, stride = 2): number {
    const attachment = slot.attachment;
    if (!attachment) return 0;
    if (attachment.type === "region") {
      checkCapacity(out, offset, stride, 4);
      computeRegionWorldVertices(attachment, slot.bone, out, offset, stride);
      return 4;
    }
    if (attachment.type === "mesh") {
      checkCapacity(out, offset, stride, attachment.geometry.vertexCount);
      if (attachment.embedSource) {
        const world = this.meshWorldVertices(attachment, slot.bone);
        for (let v = 0, o = offset; v < attachment.geometry.vertexCount; v++, o += stride) {
          out[o] = world[v * 2] as number;
          out[o + 1] = world[v * 2 + 1] as number;
        }
      } else computeMeshWorldVertices(attachment, slot.bone, this.bones, this.deformFor(attachment), out, offset, stride);
      return attachment.geometry.vertexCount;
    }
    return 0;
  }

  /**
   * Hit boxes (bounding-box attachments) shown this frame that contain the world point, topmost
   * (last in draw order) first. Call after updateWorldTransform; hidden slots and inactive bones
   * never hit. Allocates the result array only.
   */
  hitBoundingBoxes(x: number, y: number): { slot: string; name: string }[] {
    const hits: { slot: string; name: string }[] = [];
    for (let i = this.drawOrder.length - 1; i >= 0; i--) {
      const slot = this.drawOrder[i] as Slot;
      const attachment = slot.attachment;
      if (!attachment || attachment.type !== "boundingbox") continue;
      const count = computePolygonWorld(attachment, slot.bone, (this.polygonScratch.length >= attachment.vertices.length ? this.polygonScratch : (this.polygonScratch = new Float64Array(attachment.vertices.length))));
      if (pointInPolygon(this.polygonScratch, count, x, y)) hits.push({ slot: slot.data.name, name: attachment.name });
    }
    return hits;
  }

  /** World polygon (x, y pairs) of the bounding box or clipping attachment a slot shows, or null. */
  slotPolygonWorld(slot: Slot): Float64Array | null {
    const attachment = slot.attachment;
    if (!attachment || (attachment.type !== "boundingbox" && attachment.type !== "clipping")) return null;
    const out = new Float64Array(attachment.vertices.length);
    computePolygonWorld(attachment, slot.bone, out);
    return out;
  }

  private polygonScratch = new Float64Array(0);

  private resolveAttachments(): void {
    const placeholders = this.drivenState.placeholders;
    for (const slot of this.slots) {
      slot.drivenPlaceholder = placeholders[slot.index];
      slot.drivenAlpha = this.drivenState.alpha[slot.index] as number;
      const name = slot.effectivePlaceholder;
      slot.attachment =
        name === null || slot.hidden || !slot.bone.active ? null : this.outfit[slot.index]?.get(name) ?? null;
      slot.groupMesh = null;
      slot.groupIndex = -1;
      slot.groupOwner = null;
      const sequence = slot.attachment && (slot.attachment.type === "region" || slot.attachment.type === "mesh") ? slot.attachment.sequence : null;
      slot.sequenceFrame = !sequence ? 0 : slot.sequenceMode === null ? sequence.setup : sequenceFrame(slot.sequenceMode, slot.sequenceIndex, slot.sequenceDelay, sequence.count, slot.sequenceElapsed);
    }
    if (this.groupSlots.size === 0) return;
    for (const slot of this.slots) {
      const attachment = slot.attachment;
      if (!attachment || attachment.type !== "mesh") continue;
      const targets = this.groupSlots.get(attachment.id);
      if (!targets) continue;
      for (let g = 0; g < targets.length; g++) {
        const target = this.slots[targets[g] as number];
        if (!target) continue;
        target.groupMesh = attachment;
        target.groupIndex = g;
        target.groupOwner = slot;
      }
    }
  }

  private updateDrawOrder(): void {
    const n = this.slots.length;
    const driven = this.drivenState.drawOrderOffsets;
    for (let i = 0; i < n; i++) this.combinedOffsets[i] = (this.drawOrderOffsets[i] as number) + (driven[i] as number);
    // Compute into shared scratch; publish into `order`/`drawOrder` only when something moved.
    const scratch = scratchOrder(n);
    this.drawOrderResolver.resolve(this.combinedOffsets, scratch);
    let changed = false;
    for (let p = 0; p < n; p++) {
      if (scratch[p] !== this.order[p]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    for (let p = 0; p < n; p++) {
      const index = scratch[p] as number;
      this.order[p] = index;
      this.drawOrder[p] = this.slots[index] as Slot;
    }
    this.drawOrderVersion++;
  }

  private buildOutfit(): void {
    const outfit = this.slots.map(() => new Map<string, Attachment>());
    for (const slot of this.slots) slot.hidden = false;
    for (const skinName of this.skins) {
      const skin = this.document.skins[skinName];
      if (!skin) continue;
      for (const [slotName, placeholders] of Object.entries(skin.attachments)) {
        const slot = this.slotsByName.get(slotName);
        if (!slot) continue;
        for (const name of Object.keys(placeholders)) {
          const attachment = this.attachments.get(skinName, slotName, name);
          if (attachment) (outfit[slot.index] as Map<string, Attachment>).set(name, attachment);
        }
      }
      for (const slotName of skin.hides) {
        const slot = this.slotsByName.get(slotName);
        if (slot) slot.hidden = true;
      }
    }
    this.outfit = outfit;
    const active: CompiledContour[] = [];
    for (const skinName of new Set(this.skins)) active.push(...(this.contourData.bySkin.get(skinName) ?? []));
    this.active = active;
  }

  private buildPlan(): UpdatePlan {
    const skinBones = new Set<number>();
    const skinConstraints = new Set<string>();
    for (const name of this.skins) {
      const skin = this.document.skins[name];
      if (!skin) continue;
      for (const bone of skin.bones) {
        const found = this.bonesByName.get(bone);
        if (found) skinBones.add(found.index);
      }
      for (const constraint of skin.constraints) skinConstraints.add(constraint);
    }
    const plan = planUpdateOrder(
      this.document.bones.map((data, i) => ({ parent: this.bones[i]?.parent?.index ?? -1, skin: data.skin })),
      this.orderConstraints,
      { bones: skinBones, constraints: skinConstraints }
    );
    this.bones.forEach((bone, i) => {
      bone.active = plan.boneActive[i] === true;
    });
    return plan;
  }
}

// One scratch buffer shared by all skeletons (updates run one at a time on one thread), grown on
// demand, so the per-frame draw-order pass allocates nothing once warm.
let sharedOrderScratch = new Int32Array(64);
function scratchOrder(n: number): Int32Array {
  if (sharedOrderScratch.length < n) sharedOrderScratch = new Int32Array(Math.max(n, sharedOrderScratch.length * 2));
  return sharedOrderScratch;
}

/**
 * A typed array silently drops writes past its end, which used to leave the vertices of a large
 * mesh unwritten (a CPU review render then lost every triangle past vertex 1024). Refuse instead.
 */
function checkCapacity(out: NumberArray, offset: number, stride: number, count: number): void {
  if (count > 0 && ArrayBuffer.isView(out) && offset + (count - 1) * stride + 2 > out.length) {
    throw new RangeError(`world vertex buffer too small: ${count} vertices at offset ${offset}, stride ${stride} need ${offset + (count - 1) * stride + 2} slots, the buffer has ${out.length} (size it with slotWorldFloats)`);
  }
}

