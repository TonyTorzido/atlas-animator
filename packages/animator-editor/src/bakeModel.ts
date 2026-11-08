/*
 * Atlas Animator editor: baking the layered (mix) preview into a normal clip (). The combined result of the preview tracks is
 * sampled on the frame grid and written as plain bone keys (and optionally slot attachment / colour keys), so it can be edited like
 * any clip. Pure: it builds its own skeleton from the document and never touches the one on the stage.
 */
import { Skeleton, type AnimDocument, type ClipData } from "@atlas-animator/core/core";
import { emptyClip, parseClip, writeClip } from "./clipModel.js";
import { previewSpan, TrackSession, type TrackConfig } from "./trackModel.js";

export interface BakeOptions {
  /** Frames per second of the new clip. */
  fps: number;
  /** Sample every n-th frame (1 = every frame); the last frame is always sampled. */
  step: number;
  /** Also write slot attachment and colour keys (default bones only). */
  slots: boolean;
}

export interface BakeResult {
  clip: ClipData;
  /** Frames in the new clip. */
  frames: number;
  /** Keys written over all channels. */
  keys: number;
  /** Bones that got a timeline. */
  bones: number;
}

const EPS = 1e-4;
const r4 = (v: number): number => (Object.is(Math.round(v * 1e4) / 1e4, -0) ? 0 : Math.round(v * 1e4) / 1e4);

/** Drops interior samples that sit on a straight-line run of their neighbours (flat or constant), keeping the first and last. */
function prune(times: number[], values: number[][]): number[] {
  const keep = [0];
  for (let i = 1; i < times.length - 1; i++) {
    const a = keep[keep.length - 1]!;
    const b = i + 1;
    const f = (times[i]! - times[a]!) / (times[b]! - times[a]!);
    const straight = values[i]!.every((v, c) => Math.abs(v - (values[a]![c]! + (values[b]![c]! - values[a]![c]!) * f)) < 5e-4);
    if (!straight) keep.push(i);
  }
  if (times.length > 1) keep.push(times.length - 1);
  return keep;
}

const hex = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

/** Samples the combined tracks and returns the baked clip. Throws when no track has a clip. */
export function bakeMix(doc: AnimDocument, clips: Record<string, ClipData>, tracks: TrackConfig[], options: BakeOptions): BakeResult {
  const span = previewSpan(clips, tracks);
  if (!(span > 0)) throw new Error("Nothing to bake: no track has a clip");
  const fps = Math.max(1, Math.min(60, Math.round(options.fps)));
  const step = Math.max(1, Math.round(options.step));
  const frames = Math.max(1, Math.round(span * fps));
  const sampled: number[] = [];
  for (let f = 0; f < frames; f += step) sampled.push(f);
  if (sampled[sampled.length - 1] !== frames) sampled.push(frames);
  const session = new TrackSession(doc, clips, tracks);
  const sk = new Skeleton(doc);
  const times = sampled.map((f) => f / fps);

  type BoneRow = { rotate: number[][]; translate: number[][]; scale: number[][]; shear: number[][] };
  const bones = new Map<string, BoneRow>(sk.bones.map((b) => [b.data.name, { rotate: [], translate: [], scale: [], shear: [] }]));
  const attach = new Map<string, (string | null)[]>(sk.slots.map((s) => [s.data.name, []]));
  const colors = new Map<string, string[]>(sk.slots.map((s) => [s.data.name, []]));
  for (const t of times) {
    session.seek(Math.min(t, span));
    sk.setToSetupPose();
    session.apply(sk);
    for (const b of sk.bones) {
      const row = bones.get(b.data.name)!;
      row.rotate.push([b.pose.rotation - b.data.rotation]);
      row.translate.push([b.pose.x - b.data.x, b.pose.y - b.data.y]);
      row.scale.push([b.data.scaleX ? b.pose.scaleX / b.data.scaleX : 1, b.data.scaleY ? b.pose.scaleY / b.data.scaleY : 1]);
      row.shear.push([b.pose.shearX - b.data.shearX, b.pose.shearY - b.data.shearY]);
    }
    if (options.slots) {
      for (const s of sk.slots) {
        attach.get(s.data.name)!.push(s.placeholder);
        colors.get(s.data.name)!.push(`${hex(s.color.r)}${hex(s.color.g)}${hex(s.color.b)}${hex(s.color.a)}`);
      }
    }
  }

  const clip = emptyClip(frames / fps, false, fps);
  let keys = 0;
  let boneCount = 0;
  for (const [name, row] of bones) {
    for (const ch of ["rotate", "translate", "scale", "shear"] as const) {
      const rest = ch === "scale" ? 1 : 0;
      const vals = row[ch];
      if (!vals.some((v) => v.some((x) => Math.abs(x - rest) > EPS))) continue;
      const kept = prune(times, vals);
      const list = kept.map((i) => (ch === "rotate" ? { time: times[i]!, value: r4(vals[i]![0]!), curve: "linear" as const } : { time: times[i]!, x: r4(vals[i]![0]!), y: r4(vals[i]![1]!), curve: "linear" as const }));
      const tl = (clip.bones[name] ??= {});
      (tl as Record<string, unknown>)[ch] = list;
      keys += list.length;
    }
    if (clip.bones[name]) boneCount++;
  }
  if (options.slots) {
    for (const [name, list] of attach) {
      const setupName = sk.slots.find((s) => s.data.name === name)!.data.attachment;
      if (list.some((v) => v !== setupName)) {
        const out: { time: number; name: string | null }[] = [];
        list.forEach((v, i) => {
          if (i === 0 || v !== list[i - 1]) out.push({ time: times[i]!, name: v });
        });
        ((clip.slots[name] ??= {}) as Record<string, unknown>)["attachment"] = out;
        keys += out.length;
      }
      const cols = colors.get(name)!;
      const sc = sk.slots.find((x) => x.data.name === name)!.setupColor;
      const setupColor = `${hex(sc.r)}${hex(sc.g)}${hex(sc.b)}${hex(sc.a)}`;
      if (cols.some((c) => c !== setupColor)) {
        const idx = prune(times, cols.map((c) => [0, 2, 4, 6].map((o) => parseInt(c.slice(o, o + 2), 16))));
        const out = idx.map((i) => ({ time: times[i]!, color: cols[i]!, curve: "linear" as const }));
        ((clip.slots[name] ??= {}) as Record<string, unknown>)["color"] = out;
        keys += out.length;
      }
    }
  }
  // Round trip through the format so the result is exactly what a save would read back.
  return { clip: parseClip(writeClip(clip)), frames, keys, bones: boneCount };
}
