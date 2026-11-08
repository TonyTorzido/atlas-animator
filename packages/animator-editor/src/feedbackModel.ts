/*
 * Atlas Animator editor: original implementation.
 *
 * Honest feedback text (pure): what a toggle changed, how unkeyed edits are counted and worded, and the result of a Spine export.
 */

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith("mesh") ? `${word}es` : `${word}s`}`;

/** The status after a toggle, from the state it ended in: "Loop on". */
export function toggleMessage(label: string, on: boolean): string {
  return `${label} ${on ? "on" : "off"}`;
}

/** "Loop on: the clip repeats" / "Loop off: the clip plays once and holds its last frame". */
export function loopMessage(on: boolean): string {
  return on ? "Loop on: the clip repeats" : "Loop off: the clip plays once and holds its last frame";
}

/** The bones that carry an unkeyed edit, from the four pending maps (sorted, each once). */
export function unkeyedBones(...maps: readonly Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  for (const m of maps) for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== null) out.add(k);
  return [...out].sort();
}

/** "1 unkeyed" / "3 unkeyed" for the status bar; empty when there is nothing pending. */
export function unkeyedChip(count: number): string {
  return count > 0 ? `${count} unkeyed` : "";
}

/** The Key pose button's tooltip while edits are unkeyed. */
export function keyPoseTip(base: string, count: number): string {
  return count > 0 ? `${base}. ${plural(count, "bone")} moved but not keyed: scrubbing keeps them parked on this frame (come back to key them), Esc drops them` : base;
}

/** The note beside "Key it" in the transform strip (the bone is in the breadcrumb). */
export function unkeyedStripText(count: number): string {
  return count > 1 ? `${count} bones not keyed` : "Not keyed";
}

/** What Esc dropped. */
export function discardedMessage(count: number): string {
  return `Dropped the unkeyed pose on ${plural(count, "bone")}`;
}

export interface SpineSummary {
  json: string;
  images: number;
  clips: string[];
  deformTimelines: number;
  linkedMeshes: number;
  warnings: string[];
}

/** The result block of a Spine export: what was written, where, and what to look at. */
export function spineExportLines(s: SpineSummary): string[] {
  return [
    `Wrote ${s.json}`,
    `${plural(s.images, "image")}, ${plural(s.clips.length, "clip")}, ${plural(s.deformTimelines, "deform timeline")}, ${plural(s.linkedMeshes, "linked mesh")}.`,
    ...s.warnings.map((w) => `warning: ${w}`)
  ];
}

/** The status line for the same export. */
export function spineExportStatus(s: SpineSummary): string {
  const w = s.warnings.length ? ` with ${plural(s.warnings.length, "warning")}` : "";
  return `Exported the rig to Spine${w}: ${s.json}`;
}

/** Download of the open clip: browsers pick the folder, so say that instead of naming a path we do not know. */
export function clipDownloadMessage(file: string): string {
  return `Downloaded ${file} (check your browser's Downloads folder)`;
}
