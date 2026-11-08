/*
 * Atlas Animator editor: Setup mode constraints (pure; no DOM).
 *
 * View and edit IK and transform constraints and add a 2-bone IK, as command batches
 * (`constraint.add`, `constraint.set`, `constraint.remove`, `bone.add`).
 */
import { Skeleton, loadAnimDocument } from "@atlas-animator/core/core";
import { cloneJson } from "@atlas-animator/core/patch";
import { boneNames, canvasOrigin, fail, listOf, objOf, r4, runBatch, setupSkeleton, timelineRemoval, uniqueName, type Command, type JsonObject } from "./setupModel.js";

export type ConstraintKind = "ik" | "transform" | "path" | "physics";

export const TRANSFORM_MIXES = ["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"] as const;
export const TRANSFORM_OFFSETS = ["rotation", "x", "y", "scaleX", "scaleY", "shearY"] as const;

export interface IkView {
  name: string;
  bones: string[];
  target: string;
  mix: number;
  bendPositive: boolean;
  softness: number;
  stretch: boolean;
  compress: boolean;
}

export interface TransformView {
  name: string;
  bones: string[];
  target: string;
  local: boolean;
  relative: boolean;
  mixes: Record<(typeof TRANSFORM_MIXES)[number], number>;
  offset: Record<(typeof TRANSFORM_OFFSETS)[number], number>;
}

/** One editable number of a physics constraint: the engine's field, an artist label, a tooltip and the range the engine accepts. */
export interface PhysicsField {
  key: "x" | "y" | "rotate" | "scaleX" | "shearX" | "inertia" | "strength" | "damping" | "mass" | "wind" | "gravity" | "mix" | "limit" | "fps";
  label: string;
  group: "follow" | "spring" | "forces" | "run";
  step: string;
  min?: number;
  max?: number;
  def: number;
  tip: string;
}

export const PHYSICS_FIELDS: readonly PhysicsField[] = [
  { key: "rotate", label: "Rotate", group: "follow", step: "0.05", min: 0, max: 1, def: 0, tip: "How much the bone swings (rotates) with the spring, 0 to 1: the usual setting for hair, capes and tails" },
  { key: "x", label: "Move X", group: "follow", step: "0.05", min: 0, max: 1, def: 0, tip: "How much the bone slides along x with the spring, 0 to 1" },
  { key: "y", label: "Move Y", group: "follow", step: "0.05", min: 0, max: 1, def: 0, tip: "How much the bone slides along y with the spring, 0 to 1" },
  { key: "scaleX", label: "Stretch", group: "follow", step: "0.05", min: 0, max: 1, def: 0, tip: "How much the bone stretches along its length with the spring, 0 to 1" },
  { key: "shearX", label: "Shear", group: "follow", step: "0.05", min: 0, max: 1, def: 0, tip: "How much the bone shears with the spring, 0 to 1" },
  { key: "inertia", label: "Inertia", group: "spring", step: "0.05", min: 0, max: 1, def: 1, tip: "How much of the parent's movement the bone feels, 0 to 1 (1 = all of it, lower = it lags less)" },
  { key: "strength", label: "Strength", group: "spring", step: "5", min: 0, def: 100, tip: "Spring stiffness: higher snaps back to the setup pose faster" },
  { key: "damping", label: "Damping", group: "spring", step: "0.05", min: 0, max: 1, def: 1, tip: "How quickly the swing dies out, 0 to 1 (1 = settles at once, lower = keeps swinging)" },
  { key: "mass", label: "Mass", group: "spring", step: "0.1", min: 0.01, def: 1, tip: "Weight of the bone: heavier swings slower and further" },
  { key: "wind", label: "Wind", group: "forces", step: "5", def: 0, tip: "Constant sideways push (negative pushes the other way)" },
  { key: "gravity", label: "Gravity", group: "forces", step: "5", def: 0, tip: "Constant downward pull (negative lifts)" },
  { key: "mix", label: "Mix", group: "run", step: "0.05", min: 0, max: 1, def: 1, tip: "How much the simulation shows, 0 to 1 (0 = off, the pose is untouched)" },
  { key: "limit", label: "Speed limit", group: "run", step: "100", min: 0, def: 5000, tip: "Largest bone movement per second fed to the simulation (a guard against jumps and teleports)" },
  { key: "fps", label: "Steps / s", group: "run", step: "1", min: 1, max: 240, def: 60, tip: "Simulation steps per second (60 is smooth; lower is cheaper and stiffer)" }
];

export interface PhysicsView {
  name: string;
  bone: string;
  values: Record<PhysicsField["key"], number>;
}

/** The physics constraints of a rig document with the defaults filled in. */
export function physicsConstraints(raw: JsonObject): PhysicsView[] {
  return listOf(raw["physics"]).map((c) => ({
    name: String(c["name"]),
    bone: String(c["bone"]),
    values: Object.fromEntries(PHYSICS_FIELDS.map((f) => [f.key, Number(c[f.key] ?? f.def)])) as PhysicsView["values"]
  }));
}

/** The IK constraints of a rig document with the defaults filled in. */
export function ikConstraints(raw: JsonObject): IkView[] {
  return listOf(raw["ik"]).map((c) => ({
    name: String(c["name"]),
    bones: [...(c["bones"] as string[])],
    target: String(c["target"]),
    mix: Number(c["mix"] ?? 1),
    bendPositive: c["bendPositive"] !== false,
    softness: Number(c["softness"] ?? 0),
    stretch: c["stretch"] === true,
    compress: c["compress"] === true
  }));
}

/** The transform constraints of a rig document with the defaults filled in. */
export function transformConstraints(raw: JsonObject): TransformView[] {
  return listOf(raw["transform"]).map((c) => {
    const offset = objOf(c["offset"]);
    return {
      name: String(c["name"]),
      bones: [...(c["bones"] as string[])],
      target: String(c["target"]),
      local: c["local"] === true,
      relative: c["relative"] === true,
      mixes: Object.fromEntries(TRANSFORM_MIXES.map((k) => [k, Number(c[k] ?? 1)])) as TransformView["mixes"],
      offset: Object.fromEntries(TRANSFORM_OFFSETS.map((k) => [k, Number(offset[k] ?? 0)])) as TransformView["offset"]
    };
  });
}

/** Edits fields of a constraint. Transform `offset` fields are merged into the constraint's offset. */
export function planConstraintSet(raw: JsonObject, kind: ConstraintKind, name: string, fields: Record<string, unknown>): Command[] {
  const list = listOf(raw[kind]);
  const current = list.find((c) => c["name"] === name);
  if (!current) return fail(`no ${kind} constraint '${name}'`);
  const next: Record<string, unknown> = { ...fields };
  if (kind === "transform" && fields["offset"]) next["offset"] = { ...objOf(current["offset"]), ...(fields["offset"] as object) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && !Number.isFinite(value)) fail(`${key} must be a number`);
    if ((key === "mix" || key.startsWith("mix")) && typeof value === "number" && (value < 0 || value > 1)) fail(`${key} is between 0 and 1`);
    if (kind === "physics") {
      const spec = PHYSICS_FIELDS.find((f) => f.key === key);
      if (typeof value === "number" && spec) {
        if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) fail(`${spec.label} is ${spec.min !== undefined && spec.max !== undefined ? `between ${spec.min} and ${spec.max}` : spec.min !== undefined ? `at least ${spec.min}` : `at most ${spec.max}`}`);
        if (key === "fps" && !Number.isInteger(value)) fail("Steps / s is a whole number");
      }
      if (key === "bone" && !boneNames(raw).includes(String(value))) fail(`no bone '${String(value)}'`);
    }
  }
  return [{ op: "constraint.set", kind, name, fields: next }];
}

export function planRemoveConstraint(raw: JsonObject, kind: ConstraintKind, name: string): Command[] {
  if (!listOf(raw[kind]).some((c) => c["name"] === name)) fail(`no ${kind} constraint '${name}'`);
  const out: Command[] = [];
  for (const [clip, def] of Object.entries(objOf(raw["animations"]))) if (objOf(objOf(def)[kind])[name] !== undefined) out.push(timelineRemoval(clip, kind, name));
  return [...out, { op: "constraint.remove", kind, name }];
}

export interface TwoBoneIkPlan {
  commands: Command[];
  constraint: string;
  target: string;
  bendPositive: boolean;
}

/**
 * A 2-bone IK for the limb that ends in `lower` (its parent is the upper bone). The target is a new
 * helper bone at the tip of `lower` under the first root, and the bend is the one that keeps the
 * limb as it is posed in setup. The constraint starts at mix 0 so clips that pose the limb with
 * rotations keep working; raise the mix to let the target drive it.
 */
export function planAddTwoBoneIk(raw: JsonObject, lower: string, o: { name?: string; target?: string } = {}): TwoBoneIkPlan {
  const bones = listOf(raw["bones"]);
  const lowerData = bones.find((b) => b["name"] === lower) ?? fail(`no bone '${lower}'`);
  const upper = typeof lowerData["parent"] === "string" ? lowerData["parent"] : fail(`'${lower}' has no parent bone to use as the upper bone of the IK`);
  for (const c of listOf(raw["ik"])) if ((c["bones"] as string[]).includes(lower) || (c["bones"] as string[]).includes(upper)) fail(`'${upper}' or '${lower}' already has the IK '${String(c["name"])}'`);
  const constraint = uniqueName([...listOf(raw["ik"]), ...listOf(raw["transform"]), ...listOf(raw["physics"])].map((c) => String(c["name"])), o.name ?? `${lower}_ik`);

  const sk = setupSkeleton(raw);
  const bone = sk.getBone(lower);
  const tip = bone.localToWorld(bone.data.length, 0, { x: 0, y: 0 });
  const rootBone = bones.find((b) => b["parent"] === undefined);
  const parent = rootBone ? String(rootBone["name"]) : null;
  const origin = canvasOrigin(raw);
  const targetName = uniqueName(boneNames(raw), o.target ?? `${lower}_target`);
  const addTarget = { bone: targetName, commands: [{ op: "bone.add", name: targetName, ...(parent ? { parent } : {}), world: [r4(tip.x + origin.x), r4(tip.y + origin.y)], helper: true }] as Command[] };
  const withTarget = runBatch(raw, addTarget.commands).doc;
  const bendFor = (bendPositive: boolean): number => {
    const trial = cloneJson(withTarget);
    (trial["ik"] as JsonObject[] | undefined) ??= [];
    (trial["ik"] as JsonObject[]).push({ name: constraint, bones: [upper, lower], target: addTarget.bone, bendPositive, mix: 1 });
    const doc = loadAnimDocument(trial);
    const solved = new Skeleton(doc);
    solved.setActiveSkins(Object.keys(doc.skins));
    solved.updateWorldTransform("none");
    const b = solved.getBone(lower);
    const p = b.localToWorld(b.data.length, 0, { x: 0, y: 0 });
    return Math.hypot(p.x - tip.x, p.y - tip.y);
  };
  const bendPositive = bendFor(true) <= bendFor(false);
  return {
    commands: [...addTarget.commands, { op: "constraint.add", kind: "ik", constraint: { name: constraint, bones: [upper, lower], target: addTarget.bone, bendPositive, mix: 0 } }],
    constraint,
    target: addTarget.bone,
    bendPositive
  };
}

export { boneNames };
