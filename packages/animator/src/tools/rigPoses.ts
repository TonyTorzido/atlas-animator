/*
 * Atlas Animator: original implementation.
 *
 * Rig-agnostic review poses. The validator's geometry and tears checks pose the rig
 * from the rig itself, never from a template's bone names:
 *
 * - roles: each deforming bone gets a semantic role, declared (`role` on the bone, inherited by
 *   descendants that declare none) or inferred from the hierarchy. The spine is the path from the
 *   first deforming bone towards the branch points; the chains hanging off it are limbs when they
 *   have a twin (another off-spine chain with the same bone count and a total length within 25%,
 *   a left/right or front/back pair), else the unpaired chain off the spine's last bone that best
 *   continues it is the head, the unpaired chain off its first bone pointing back is the tail, and
 *   any other unpaired chain of two or more bones is a limb (one bone: other). A rig with no branch
 *   point is one limb.
 * - ranges: a bone's `limits`, else a role default (spine 8, head 15, limb 45, tail 30, other 10
 *   degrees each way).
 * - poses (parentless bones excepted: they turn the rig rigidly): rest; for limbs and tails, each chain depth alone at its max and min (shoulder, upper
 *   arm, elbow, wrist; hip, knee, paw), then curl (every bone at max) and extend (every bone at
 *   min); spine and head curl and extend; and three whole-body combinations: all max, all min and
 *   stride (twins in opposition). Every posed bone reaches both ends of its range in some pose.
 * - bend caps: a pose moving two or more bones of one chain is scaled to the chain role's
 *   cumulative bend cap (ROLE_DEFAULT_BEND, the document's `budgets.bend` or options); a chain
 *   that was capped also gets the one-depth-at-a-time poses, so its joints still reach their ends.
 */
import type { AnimDocument } from "../core/format.js";
import { Skeleton } from "../core/skeleton.js";
import type { ReviewPose } from "./review.js";
import { authoringChains, authoringProbes, deformingBones } from "./authoring.js";

export const BONE_ROLES = ["spine", "limb", "head", "tail", "other"] as const;
export type BoneRole = (typeof BONE_ROLES)[number];

export const ROLE_DEFAULT_RANGE: Readonly<Record<BoneRole, number>> = { spine: 8, head: 15, limb: 45, tail: 30, other: 10 };

export interface RigChain {
  role: BoneRole;
  /** Bones from the chain's root outwards (the main path; side branches are in `members`). */
  path: string[];
  /** Every bone of the chain, side branches included. */
  members: string[];
  /** The chain this one is twinned with (index into the chain list), if any. */
  twin?: number;
  /** Authoring chain id, when the chain is declared rather than inferred. */
  id?: string;
  /** Plan: inferred for bones no declared chain covers (declared chains exist). */
  fallback?: boolean;
}

export interface RigRoles {
  /**
   * Posed bone -> role: deforming bones and the bones between them (a bare clavicle that moves an
   * arm). Bones with nothing deforming below them (IK targets, empty roots) are absent.
   */
  roles: Map<string, BoneRole>;
  chains: RigChain[];
}

export function inferRoles(doc: AnimDocument): RigRoles {
  // Plan: declared chains (the authoring block) replace inference for the bones they cover.
  // Plan: the deforming bones (and the posed bones between them) that no declared chain
  // covers still get inferred chains, marked `fallback`, so a partial declaration never silently
  // drops a moving bone from the review poses; validateAuthoring warns about them.
  const declaredChains = authoringChains(doc);
  const inferred = inferFromSkeleton(doc);
  if (!declaredChains) return inferred;
  const covered = new Set(declaredChains.flatMap((chain) => chain.members));
  const roles = new Map<string, BoneRole>();
  for (const chain of declaredChains) for (const bone of chain.members) roles.set(bone, chain.role);
  const kept = inferred.chains
    .map((chain, index) => ({ chain, index, path: chain.path.filter((b) => !covered.has(b)), members: chain.members.filter((b) => !covered.has(b)) }))
    .filter((entry) => entry.members.length > 0);
  const renumber = new Map(kept.map((entry, k) => [entry.index, declaredChains.length + k]));
  const fallback: RigChain[] = kept.map(({ chain, path, members }) => {
    const twin = chain.twin !== undefined ? renumber.get(chain.twin) : undefined;
    const twinPath = twin !== undefined ? kept[twin - declaredChains.length]?.path : undefined;
    return { role: chain.role, path: path.length > 0 ? path : [...members], members, fallback: true, ...(twin !== undefined && twinPath?.length === path.length ? { twin } : {}) };
  });
  for (const chain of fallback) for (const bone of chain.members) roles.set(bone, inferred.roles.get(bone) ?? chain.role);
  for (const [bone, role] of inferred.roles) if (!roles.has(bone) && !covered.has(bone)) roles.set(bone, role);
  // A twin pair only when both kept it.
  fallback.forEach((chain, k) => {
    if (chain.twin !== undefined && fallback[chain.twin - declaredChains.length]?.twin !== declaredChains.length + k) delete chain.twin;
  });
  return { roles, chains: [...declaredChains, ...fallback] };
}

/** Roles and chains inferred from the skeleton and the weights alone (no authoring block). */
function inferFromSkeleton(doc: AnimDocument): RigRoles {
  const deform = deformingBones(doc);
  const children = new Map<string, string[]>();
  for (const bone of doc.bones) {
    children.set(bone.name, []);
    if (bone.parent) children.get(bone.parent)?.push(bone.name);
  }
  const relevantMemo = new Map<string, boolean>();
  const relevant = (name: string): boolean => {
    const known = relevantMemo.get(name);
    if (known !== undefined) return known;
    const value = deform.has(name) || (children.get(name) ?? []).some(relevant);
    relevantMemo.set(name, value);
    return value;
  };
  const kids = (name: string) => (children.get(name) ?? []).filter(relevant);
  const branchMemo = new Map<string, number>();
  const branchCount = (name: string): number => {
    const known = branchMemo.get(name);
    if (known !== undefined) return known;
    const list = kids(name);
    const value = (list.length >= 2 ? 1 : 0) + list.reduce((sum, child) => sum + branchCount(child), 0);
    branchMemo.set(name, value);
    return value;
  };
  const subtree = (name: string): string[] => [name, ...kids(name).flatMap(subtree)];

  // World direction of each bone at the setup pose.
  const skeleton = new Skeleton(doc);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform("pose");
  const direction = (name: string) => {
    const bone = skeleton.findBone(name);
    if (!bone) return { x: 1, y: 0 };
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    bone.localToWorld(0, 0, a);
    bone.localToWorld(Math.max(bone.data.length, 1), 0, b);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  const boneLength = (name: string) => doc.bones.find((b) => b.name === name)?.length ?? 0;

  // Plan: every relevant root tree gets its own chains (largest first, ties by name), not
  // only the largest; non-deforming bones between deforming ones are chain members (posed), only a
  // non-deforming single-child run at the very top of a tree (it turns the tree rigidly) is skipped.
  const roots = doc.bones
    .filter((b) => !b.parent && relevant(b.name))
    .map((b) => b.name)
    .sort((a, b) => subtree(b).length - subtree(a).length || (a < b ? -1 : a > b ? 1 : 0));
  const allChains: RigChain[] = [];
  for (const treeRoot of roots) {
    let start = treeRoot;
    const spine: string[] = [];
    const chains: RigChain[] = [];
    while (!deform.has(start) && kids(start).length === 1) start = kids(start)[0] as string;
    if (branchCount(start) === 0) {
      // No branch point: the rig is one limb.
      const path: string[] = [];
      for (let at: string | undefined = start; at !== undefined; at = kids(at)[0]) path.push(at);
      chains.push({ role: "limb", path, members: subtree(start) });
    } else {
      let at = start;
      for (;;) {
        spine.push(at);
        const list = kids(at);
        const next = [...list].sort((a, b) => branchCount(b) - branchCount(a) || subtree(b).length - subtree(a).length)[0];
        if (next === undefined || branchCount(next) === 0) break;
        at = next;
      }
      // A chain's path: from a bone down its largest subtree.
      const pathFrom = (child: string): string[] => {
        const path: string[] = [];
        for (let node: string | undefined = child; node !== undefined; node = [...kids(node)].sort((a, b) => subtree(b).length - subtree(a).length)[0]) path.push(node);
        return path;
      };
      // Plan: the spine ends at the last hub carrying a twin pair of 2+-bone chains (two
      // chains of the same bone count; lengths may differ, as near and far legs drawn in
      // perspective do); everything beyond it is the head chain, its side branches
      // (ears, horns) members of it. A bone on the walked spine that declares role "head" cuts the
      // spine there instead (a declared head re-chains membership, not only the label).
      const twinHub = (hub: string, next: string | undefined) => {
        const paths = kids(hub).filter((c) => c !== next).map(pathFrom).filter((path) => path.length >= 2);
        return paths.some((a, i) => paths.some((b, j) => j > i && a.length === b.length));
      };
      const ownRole = (name: string) => (doc.bones.find((b) => b.name === name) as { role?: BoneRole } | undefined)?.role;
      let cut = spine.findIndex((bone, k) => k > 0 && ownRole(bone) === "head");
      if (cut < 0) {
        let lastHub = -1;
        spine.forEach((bone, k) => {
          if (twinHub(bone, spine[k + 1])) lastHub = k;
        });
        if (lastHub >= 0 && lastHub < spine.length - 1) cut = lastHub + 1;
      }
      const headPath = cut > 0 ? spine.splice(cut) : [];
      const onSpine = new Set(spine);
      const hubs = new Map<number, string>();
      let headChain = -1;
      // Off-spine chains: each relevant child of a spine bone.
      for (const hub of spine) {
        for (const child of kids(hub)) {
          if (onSpine.has(child)) continue;
          if (child === headPath[0]) headChain = chains.length;
          hubs.set(chains.length, hub);
          chains.push({ role: "other", path: child === headPath[0] ? headPath : pathFrom(child), members: subtree(child) });
        }
      }
      // Twins, then head / tail / limb.
      const total = (chain: RigChain) => chain.path.reduce((sum, b) => sum + boneLength(b), 0);
      // Candidate pairs: same hub, same bone count, total length within 25%; best matches first.
      const pairs: { i: number; j: number; score: number }[] = [];
      chains.forEach((a, i) =>
        chains.forEach((b, j) => {
          if (j <= i || i === headChain || j === headChain || hubs.get(i) !== hubs.get(j) || a.path.length !== b.path.length) return;
          const difference = Math.abs(total(a) - total(b));
          if (difference <= 0.25 * Math.max(total(a), total(b), 1)) pairs.push({ i, j, score: difference });
        })
      );
      for (const { i, j } of pairs.sort((p, q) => p.score - q.score)) {
        const a = chains[i] as RigChain;
        const b = chains[j] as RigChain;
        if (a.twin !== undefined || b.twin !== undefined) continue;
        a.twin = j;
        b.twin = i;
      }
      const first = spine[0];
      const last = spine[spine.length - 1] ?? at;
      const spineDirection = first !== undefined && last !== undefined ? direction(last) : { x: 0, y: -1 };
      const dot = (u: { x: number; y: number }, v: { x: number; y: number }) => u.x * v.x + u.y * v.y;
      const hubOf = (i: number) => hubs.get(i);
      let headIndex = headChain;
      let headScore = 0.3;
      let tailIndex = -1;
      let tailScore = 0.3;
      chains.forEach((chain, i) => {
        if (chain.twin !== undefined) return;
        const d = direction(chain.path[0] ?? (chain.members[0] as string));
        if (headChain < 0 && hubOf(i) === last && dot(d, spineDirection) > headScore) {
          headScore = dot(d, spineDirection);
          headIndex = i;
        }
        if (hubOf(i) === first && first !== last && -dot(d, spineDirection) > tailScore) {
          tailScore = -dot(d, spineDirection);
          tailIndex = i;
        }
      });
      chains.forEach((chain, i) => {
        chain.role = chain.twin !== undefined ? "limb" : i === headIndex ? "head" : i === tailIndex ? "tail" : chain.path.length >= 2 ? "limb" : "other";
      });
      if (spine.length > 0) chains.unshift({ role: "spine", path: [...spine], members: [...spine] });
      // Twins were indexed before the spine was put first.
      if (spine.length > 0) for (const chain of chains) if (chain.twin !== undefined) chain.twin += 1;
    }
    const base = allChains.length;
    for (const chain of chains) {
      if (chain.twin !== undefined) chain.twin += base;
      allChains.push(chain);
    }
  }

  // Declared roles override (inherited by descendants that declare none).
  const declared = new Map<string, BoneRole>();
  for (const bone of doc.bones) {
    const own = (bone as { role?: BoneRole }).role;
    const inherited = bone.parent ? declared.get(bone.parent) : undefined;
    if (own ?? inherited) declared.set(bone.name, (own ?? inherited) as BoneRole);
  }
  const roles = new Map<string, BoneRole>();
  for (const chain of allChains) for (const bone of chain.members) roles.set(bone, declared.get(bone) ?? chain.role);
  for (const bone of deform) if (!roles.has(bone)) roles.set(bone, declared.get(bone) ?? "other");
  // Non-deforming bones above the first branch-free start (a bare root) are never posed.
  for (const chain of allChains) {
    const own = chain.path[0] !== undefined ? declared.get(chain.path[0]) : undefined;
    if (own) chain.role = own;
  }
  return { roles, chains: allChains };
}

/** The [min, max] a review pose takes a bone to: its limits, else its role's default. */
export function boneRange(doc: AnimDocument, name: string, role: BoneRole): [number, number] {
  const limits = doc.bones.find((b) => b.name === name)?.limits;
  if (limits) return [limits.min, limits.max];
  const range = ROLE_DEFAULT_RANGE[role];
  return [-range, range];
}

/**
 * Default cumulative bend caps per chain role, degrees: a pose that moves two or more bones of one
 * chain is scaled down so no path from the chain's root bends more than this in total (a spine is
 * never posed at every joint's max at once). Limbs are uncapped: a limb curled to every joint's
 * limit is a real extreme. Override per rig with the document's `budgets.bend` or a preset.
 */
export const ROLE_DEFAULT_BEND: Readonly<Record<BoneRole, number>> = { spine: 30, head: 30, tail: 90, limb: Infinity, other: Infinity };

export interface RigPoseOptions {
  /** Cumulative bend caps per chain role (over ROLE_DEFAULT_BEND). */
  bend?: Partial<Record<BoneRole, number | undefined>> | undefined;
}

/**
 * Scale each chain's share of `rotate` to its role's cumulative bend cap (when two or more of its
 * bones move). Returns whether anything was scaled.
 */
function capChainBends(rotate: Record<string, number>, chains: readonly RigChain[], parentOf: ReadonlyMap<string, string | undefined>, caps: Readonly<Record<BoneRole, number>>, own?: ReadonlyMap<string, number>): boolean {
  let scaled = false;
  for (const chain of chains) {
    const cap = (chain.id !== undefined ? own?.get(chain.id) : undefined) ?? caps[chain.role];
    if (!Number.isFinite(cap)) continue;
    const members = new Set(chain.members);
    if (chain.members.filter((b) => (rotate[b] ?? 0) !== 0).length < 2) continue;
    const memo = new Map<string, number>();
    const cumulative = (bone: string): number => {
      const known = memo.get(bone);
      if (known !== undefined) return known;
      const parent = parentOf.get(bone);
      const value = Math.abs(rotate[bone] ?? 0) + (parent !== undefined && members.has(parent) ? cumulative(parent) : 0);
      memo.set(bone, value);
      return value;
    };
    const worst = Math.max(...chain.members.map(cumulative));
    if (worst <= cap) continue;
    for (const bone of chain.members) if (rotate[bone] !== undefined) rotate[bone] = (rotate[bone] as number) * (cap / worst);
    scaled = true;
  }
  return scaled;
}

/** Review poses derived from the rig (see the file comment). */
export function rigPoses(doc: AnimDocument, options: RigPoseOptions = {}): ReviewPose[] {
  const { roles, chains } = inferRoles(doc);
  const declared = doc.authoring?.chains ?? [];
  const chainRange = new Map<string, number>();
  for (const chain of declared) if (chain.range !== undefined) for (const bone of chain.bones) chainRange.set(bone, chain.range);
  const range = (name: string): [number, number] => {
    const own = chainRange.get(name);
    if (own !== undefined && !doc.bones.find((b) => b.name === name)?.limits) return [-own, own];
    return boneRange(doc, name, roles.get(name) ?? "other");
  };
  const caps = { ...ROLE_DEFAULT_BEND } as Record<BoneRole, number>;
  for (const role of BONE_ROLES) {
    const value = options.bend?.[role] ?? doc.budgets?.bend?.[role];
    if (value !== undefined) caps[role] = value;
  }
  // Per-chain bend caps from the authoring block cap their own chain only.
  const ownCaps = new Map(declared.flatMap((c) => (c.bend !== undefined ? [[c.id, c.bend] as const] : [])));
  const parentOf = new Map(doc.bones.map((b) => [b.name, b.parent]));
  const poses: ReviewPose[] = [{ name: "rest", rotate: {} }];
  const add = (name: string, rotate: Record<string, number>) => {
    if (Object.values(rotate).some((value) => value !== 0)) poses.push({ name, rotate });
  };
  // A parentless bone turns the whole rig rigidly: nothing to judge, so it is never posed.
  const rooted = new Set(doc.bones.filter((b) => !b.parent).map((b) => b.name));
  let capped = false;
  const at = (bones: readonly string[], end: 0 | 1) => {
    const rotate: Record<string, number> = Object.fromEntries(bones.filter((b) => !rooted.has(b)).map((b) => [b, range(b)[end]]));
    capped = capChainBends(rotate, chains, parentOf, caps, ownCaps) || capped;
    return rotate;
  };
  for (const role of BONE_ROLES) {
    const group = chains.filter((chain) => chain.role === role);
    if (group.length === 0) continue;
    const members = group.flatMap((chain) => chain.members);
    capped = false;
    const curl = at(members, 1);
    const extend = at(members, 0);
    // A capped chain still takes every joint to its own extremes, one depth at a time.
    if (role === "limb" || role === "tail" || capped) {
      const depth = Math.max(...group.map((chain) => chain.path.length));
      for (let d = 0; d < depth; d++) {
        const bones = group.flatMap((chain) => (chain.path[d] !== undefined ? [chain.path[d] as string] : []));
        add(`${role} depth ${d} max`, at(bones, 1));
        add(`${role} depth ${d} min`, at(bones, 0));
      }
      // Plan: side branches (ears off a head, a dewclaw off a leg) are chain members off
      // the main path; the caps scale them with the path, so each also gets its own endpoint
      // probes: the s-th side bone of every chain of the role, one bone per chain per pose (a
      // single moving bone is never capped), so every eligible bone reaches both of its limits.
      const sides = group.map((chain) => {
        const onPath = new Set(chain.path);
        return chain.members.filter((b) => !onPath.has(b) && !rooted.has(b));
      });
      const sideCount = Math.max(0, ...sides.map((list) => list.length));
      for (let k = 0; k < sideCount; k++) {
        const bones = sides.flatMap((list) => (list[k] !== undefined ? [list[k] as string] : []));
        add(`${role} side ${k} max`, at(bones, 1));
        add(`${role} side ${k} min`, at(bones, 0));
      }
    }
    add(`${role} curl`, curl);
    add(`${role} extend`, extend);
  }
  const all = [...roles.keys()];
  add("all max", at(all, 1));
  add("all min", at(all, 0));
  const stride: Record<string, number> = {};
  chains.forEach((chain, i) => {
    if (chain.twin === undefined) return;
    Object.assign(stride, at(chain.members, i < chain.twin ? 1 : 0));
  });
  add("stride", stride);
  // Declared chains are each tested alone too (eight legs off one hub move independently), and so
  // are the fallback chains inferred beside them, named as fallback.
  for (const chain of chains) {
    const label = chain.id !== undefined ? `chain ${chain.id}` : chain.fallback ? `fallback chain ${chain.path[0] ?? chain.members[0]}` : undefined;
    if (label === undefined) continue;
    add(`${label} max`, at(chain.members, 1));
    add(`${label} min`, at(chain.members, 0));
  }
  for (const probe of authoringProbes(doc)) poses.push(probe);
  // Plan r3: with IK constraints, generated poses run with IK released
  // (pure FK), plus one small IK-held lean each way (+-5 deg on the first bone of the spine curl).
  if (doc.ik.length) {
    for (const p of poses) p.ikMix ??= 0;
    const curl = poses.find((p) => p.name === "spine curl");
    const lean = curl ? Object.keys(curl.rotate)[0] : undefined;
    if (lean) for (const sgn of [1, -1]) poses.push({ name: `lean ${sgn > 0 ? "+" : "-"}5 ik-held`, rotate: { [lean]: 5 * sgn }, ikMix: 1 });
  }
  return poses;
}
