/*
 * Atlas Animator: original implementation.
 *
 * Builds the per-frame update list: which bones are active for the current skins, which
 * constraints are active, and the order to update them in.
 *
 * Rules the order guarantees:
 * 1. A bone is computed after the latest change to its parent (parents first).
 * 2. A constraint runs after its target and its constrained bones have been computed.
 * 3. Everything below a constrained bone is computed (again) after the constraint, so children
 *    follow the solved pose.
 * 4. Constraints run in the order given to planUpdateOrder. The skeleton sorts them by
 *    (order, kind, list index); `order` defaults to 0 for IK, 1 for transform, 2 for path and 3
 *    for physics, so by default all IK runs first, then transform, then path, then physics (which then simulates the
 *    fully constrained pose). A transform constraint that places an IK target sets order -1.
 *
 * A bone may appear more than once (once before a constraint that reads it, once after a
 * constraint that moved its parent). That is intended: each appearance recomputes from the
 * current parent.
 *
 * Activation: non-skin bones are always active. A skin bone is active when an active skin lists
 * it or one of its descendants (the parent chain activates with the listed bone). A constraint is
 * active when every bone it reads or writes is active and, if it is a skin constraint, an active
 * skin lists it. Inactive bones and constraints are left out of the order entirely.
 *
 * This module is pure (index-based input, plain output) so it can be tested in isolation.
 */

export const CONSTRAINT_KINDS = ["ik", "transform", "path", "physics"] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export type UpdateStep =
  | { readonly kind: "bone"; readonly bone: number }
  | { readonly kind: ConstraintKind; readonly index: number };

export interface OrderBone {
  /** Index of the parent bone (must be lower than this bone's index), or -1 for a root. */
  readonly parent: number;
  readonly skin: boolean;
}

export interface OrderConstraint {
  readonly kind: ConstraintKind;
  /** Index within its own kind's list. */
  readonly index: number;
  readonly name: string;
  readonly skin: boolean;
  /** Bones the constraint writes. */
  readonly bones: readonly number[];
  /** Bone the constraint reads, or -1 (physics reads only its own bone). */
  readonly target: number;
  /** Further bones the constraint reads (the bones a weighted path is bound to). */
  readonly reads?: readonly number[];
}

export interface Activation {
  /** Skin bones listed by the active skins. */
  readonly bones: ReadonlySet<number>;
  /** Skin constraint names listed by the active skins. */
  readonly constraints: ReadonlySet<string>;
}

export interface UpdatePlan {
  readonly steps: readonly UpdateStep[];
  readonly boneActive: readonly boolean[];
  /** Aligned with the `constraints` argument. */
  readonly constraintActive: readonly boolean[];
}

/**
 * `constraints` must already be in execution order (see rule 4). Precondition (enforced by the
 * document checks): when one bone of a constraint is below another bone of the same constraint,
 * every bone between them belongs to the constraint too, listed parents-first. Otherwise an
 * unlisted bone in the middle would be recomputed after the constraint while the listed bone
 * below it kept the constraint's result, leaving the two disconnected.
 */
export function planUpdateOrder(
  bones: readonly OrderBone[],
  constraints: readonly OrderConstraint[],
  activation: Activation
): UpdatePlan {
  const boneActive = bones.map((bone) => !bone.skin);
  for (const listed of activation.bones) {
    for (let bone = listed; bone >= 0 && !boneActive[bone]; bone = bones[bone]?.parent ?? -1) {
      boneActive[bone] = true;
    }
  }

  const constraintActive = constraints.map(
    (constraint) =>
      (!constraint.skin || activation.constraints.has(constraint.name)) &&
      constraint.bones.every((bone) => boneActive[bone] === true) &&
      (constraint.target < 0 || boneActive[constraint.target] === true) &&
      (constraint.reads ?? []).every((bone) => boneActive[bone] === true)
  );

  const children: number[][] = bones.map(() => []);
  bones.forEach((bone, i) => {
    if (bone.parent >= 0) children[bone.parent]?.push(i);
  });

  // `placed` = the bone's world transform is current at this point of the list.
  const placed = bones.map(() => false);
  const steps: UpdateStep[] = [];

  const place = (bone: number): void => {
    if (bone < 0 || placed[bone] || !boneActive[bone]) return;
    place(bones[bone]?.parent ?? -1);
    placed[bone] = true;
    steps.push({ kind: "bone", bone });
  };
  // Walks the whole subtree: a bone written by an earlier constraint can be placed below an
  // unplaced bone, and it must be invalidated too when an ancestor moves again.
  const unplaceBelow = (bone: number): void => {
    for (const child of children[bone] ?? []) {
      placed[child] = false;
      unplaceBelow(child);
    }
  };

  constraints.forEach((constraint, i) => {
    if (!constraintActive[i]) return;
    place(constraint.target);
    for (const bone of constraint.reads ?? []) place(bone);
    for (const bone of constraint.bones) place(bone);
    steps.push({ kind: constraint.kind, index: constraint.index });
    for (const bone of constraint.bones) unplaceBelow(bone);
    // The constraint itself leaves its bones current.
    for (const bone of constraint.bones) placed[bone] = true;
  });

  bones.forEach((_, i) => place(i));
  return { steps, boneActive, constraintActive };
}
