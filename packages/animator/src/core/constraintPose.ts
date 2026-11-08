/*
 * Atlas Animator: original implementation.
 *
 * The keyable values of constraints, per skeleton. Clips key them (IK mix, softness and flags,
 * transform mixes, physics mix and resets); setToSetupPose restores the document's values. The
 * constraint solvers (phase 3) read them every frame.
 */
import type { IkConstraintData, PhysicsConstraintData, TransformConstraintData } from "./format.js";

export interface IkPose {
  mix: number;
  softness: number;
  bendPositive: boolean;
  stretch: boolean;
  compress: boolean;
}

export interface TransformPose {
  mixRotate: number;
  mixX: number;
  mixY: number;
  mixScaleX: number;
  mixScaleY: number;
  mixShearY: number;
}

export interface PhysicsPose {
  mix: number;
  /**
   * Set by a physics reset key; the physics solver snaps the simulation to the current pose and
   * clears it. Not touched by setToSetupPose (it is a request, not a pose value).
   */
  resetRequested: boolean;
}

export function createIkPose(data: IkConstraintData): IkPose {
  return resetIkPose({ mix: 0, softness: 0, bendPositive: true, stretch: false, compress: false }, data);
}

export function resetIkPose(pose: IkPose, data: IkConstraintData): IkPose {
  pose.mix = data.mix;
  pose.softness = data.softness;
  pose.bendPositive = data.bendPositive;
  pose.stretch = data.stretch;
  pose.compress = data.compress;
  return pose;
}

export function createTransformPose(data: TransformConstraintData): TransformPose {
  return resetTransformPose({ mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 }, data);
}

export function resetTransformPose(pose: TransformPose, data: TransformConstraintData): TransformPose {
  pose.mixRotate = data.mixRotate;
  pose.mixX = data.mixX;
  pose.mixY = data.mixY;
  pose.mixScaleX = data.mixScaleX;
  pose.mixScaleY = data.mixScaleY;
  pose.mixShearY = data.mixShearY;
  return pose;
}

export { createPathPose, resetPathPose, type PathPose } from "./pathConstraint.js";

export function createPhysicsPose(data: PhysicsConstraintData): PhysicsPose {
  return { mix: data.mix, resetRequested: false };
}

export function resetPhysicsPose(pose: PhysicsPose, data: PhysicsConstraintData): PhysicsPose {
  pose.mix = data.mix;
  return pose;
}
