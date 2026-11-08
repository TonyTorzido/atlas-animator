/*
 * Atlas Animator editor: pose library helpers (pure, no DOM). The library itself is poseModel.ts; this adds what the thumbnail grid needs:
 * tags and search, partial application (a blend between the posed character and a library pose), mirrored application (the same mirror
 * maths as Shift+M, mirrorModel.ts) and a cache key for rendered thumbnails.
 */
import { type BoneOffsets, type PoseCopy } from "./clipModel.js";
import { mirrorOffsets, planFlip, type MirrorRig } from "./mirrorModel.js";
import type { PoseRecord } from "./poseModel.js";

export const POSE_TAGS = ["guard", "wind-up", "follow-through", "contact", "idle"] as const;
export type PoseTag = (typeof POSE_TAGS)[number];

const TAG_WORDS: Record<PoseTag, RegExp> = {
  guard: /guard|block|brace|shield|ready/i,
  "wind-up": /wind|load|draw|raise|back/i,
  "follow-through": /follow|recover|swing_end|finish/i,
  contact: /contact|hit|strike|impact|slash/i,
  idle: /idle|rest|stand|neutral/i
};

/** Tags a pose gets when it has none saved (the built-in starter poses): guessed from its name and note. */
export function inferTags(p: Pick<PoseRecord, "name" | "note">): PoseTag[] {
  const text = `${p.name} ${p.note ?? ""}`;
  return POSE_TAGS.filter((t) => TAG_WORDS[t].test(text));
}

export function effectiveTags(p: Pick<PoseRecord, "name" | "note" | "tags">): string[] {
  return p.tags?.length ? p.tags : inferTags(p);
}

/** Lower-case, trimmed, known-order tags without duplicates (free tags are kept after the five standard ones). */
export function normalizeTags(tags: readonly string[]): string[] {
  const set = new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const known = POSE_TAGS.filter((t) => set.has(t));
  return [...known, ...[...set].filter((t) => !(POSE_TAGS as readonly string[]).includes(t)).sort()];
}

/** Poses whose name, note or tags contain every word of `query`, and (when tags are chosen) carry at least one chosen tag. */
export function filterPoses<T extends { pose: PoseRecord }>(list: readonly T[], query: string, tags: ReadonlySet<string>): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter(({ pose }) => {
    const mine = effectiveTags(pose);
    if (tags.size && !mine.some((t) => tags.has(t))) return false;
    const hay = `${pose.name} ${pose.note ?? ""} ${mine.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const IDENTITY: BoneOffsets = { rotate: 0, translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };

export function blendOffsets(from: BoneOffsets, to: BoneOffsets, k: number): BoneOffsets {
  const mix = (a: number, b: number) => a + (b - a) * k;
  return {
    rotate: mix(from.rotate, to.rotate),
    translate: { x: mix(from.translate.x, to.translate.x), y: mix(from.translate.y, to.translate.y) },
    scale: { x: mix(from.scale.x, to.scale.x), y: mix(from.scale.y, to.scale.y) }
  };
}

/** Every bone of `target` moved `k` (0..1) of the way from where `current` has it: 0 leaves the pose as it is, 1 is the library pose. */
export function blendPoseCopy(current: PoseCopy, target: PoseCopy, k: number): PoseCopy {
  const f = Math.min(1, Math.max(0, k));
  const out: PoseCopy = {};
  for (const [bone, o] of Object.entries(target)) out[bone] = blendOffsets(current[bone] ?? IDENTITY, o, f);
  return out;
}

/** The pose as seen in a mirror: every near / far pair swaps and the bones on the axis mirror in place (the Shift+M flip, applied to a stored pose). */
export function mirrorPoseCopy(rig: MirrorRig, copy: PoseCopy, skip?: ReadonlySet<string>): PoseCopy {
  const out: PoseCopy = {};
  for (const op of planFlip(rig, skip).ops) {
    const src = copy[op.from];
    if (!src) continue;
    const m = mirrorOffsets(rig, op, { ...src, shear: { x: 0, y: 0 } });
    out[op.to] = { rotate: m.rotate, translate: m.translate, scale: m.scale };
  }
  return out;
}

/** The entries of `copy` for these bones. */
export function onlyBones(copy: PoseCopy, names: readonly string[]): PoseCopy {
  const out: PoseCopy = {};
  for (const n of names) if (copy[n]) out[n] = copy[n]!;
  return out;
}

/** A short hash of what makes a thumbnail look the way it does (bones, swaps, order), for the thumbnail cache. */
export function poseHash(p: PoseRecord): string {
  const text = JSON.stringify([p.bones, p.attachments, p.drawOrder]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
