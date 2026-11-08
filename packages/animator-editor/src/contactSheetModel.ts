/*
 * Atlas Animator editor: the item contact sheet's pure parts (no DOM, no Pixi; unit tested).
 *
 * A sheet is rows x (4 frames per view). A clip row shows four frames of one clip: first, contact (the `hit` key, else a third of the
 * way in), middle and last. A pose-sweep row shows one bone driven through four values. Rows are shown a page at a time.
 */
import type { ClipData } from "@atlas-animator/core/core";
import { GAME_CLIPS, LEGACY_CLIP_ALIASES, type GameClip } from "./gameClips.js";

export const SHEET_SCALE = 0.4;
export const FRAME_LABELS = ["First", "Contact", "Middle", "Last"] as const;
export const ROWS_PER_PAGE = 2;
/** Smallest row height (px) at which a figure is still judgeable; rows per page is how many of these fit the window. */
export const MIN_ROW_H = 220;
export const ROW_GAP = 8;
/** Frames per row: one view (the turned rig), four frames. */
export const SHEET_COLUMNS = 4;

/** How many rows fit a window region `availH` px tall (at least 1, at most `rowCount`). */
export const rowsThatFit = (availH: number, rowCount: number): number => Math.max(1, Math.min(Math.max(1, rowCount), Math.floor((availH + ROW_GAP) / (MIN_ROW_H + ROW_GAP))));

/** The row height (px) that makes `per` rows fill `availH` exactly. */
export const rowHeightFor = (availH: number, per: number): number => Math.max(MIN_ROW_H, Math.floor((availH - (per - 1) * ROW_GAP) / Math.max(1, per)));

/** The page a row (by index) lands on. */
export const pageOfRow = (index: number, per: number): number => Math.floor(Math.max(0, index) / Math.max(1, per));

export interface FrameSpec {
  label: (typeof FRAME_LABELS)[number];
  t: number;
}

/** The four sample times of a clip. */
export function sheetFrames(clip: Pick<ClipData, "duration" | "loop" | "events">): FrameSpec[] {
  const d = Math.max(0, clip.duration);
  const hit = clip.events?.find((e) => e.name === "hit");
  const last = clip.loop ? Math.max(0, d - 1e-3) : d;
  const contact = Math.min(last, hit ? hit.time : d / 3);
  return [
    { label: "First", t: 0 },
    { label: "Contact", t: contact },
    { label: "Middle", t: d / 2 },
    { label: "Last", t: last }
  ];
}

export interface SweepRow {
  id: string;
  label: string;
  bone: string;
  /** Degrees added to the bone's setup rotation, one per frame. */
  values: [number, number, number, number];
}

/** The pose sweep: the same item through the poses that stress it most. */
export const POSE_SWEEPS: readonly SweepRow[] = [
  { id: "elbow", label: "Elbow 0 to 120", bone: "forearm_near", values: [0, 40, 80, 120] },
  { id: "shoulder", label: "Shoulder swing", bone: "upper_arm_near", values: [-45, -15, 15, 45] },
  { id: "lean", label: "Lean +-12", bone: "lean", values: [-12, -4, 4, 12] },
  { id: "head", label: "Head +-15", bone: "head", values: [-15, -5, 5, 15] }
];

export interface SheetRow {
  key: string;
  label: string;
  kind: "clip" | "sweep";
  /** Clip rows: the clip's name in the library / clips folder, and the project clip it is. */
  clipName?: string;
  game?: GameClip;
  sweep?: SweepRow;
}

/** The project clips that exist (by id, or by a legacy name), as sheet rows. `have` holds every clip name the editor knows. */
export function clipRows(have: ReadonlySet<string>): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const game of GAME_CLIPS) {
    const name = have.has(game.id) ? game.id : (LEGACY_CLIP_ALIASES[game.id] ?? []).find((a) => have.has(a));
    if (name) rows.push({ key: game.id, label: game.label, kind: "clip", clipName: name, game });
  }
  return rows;
}

export const sweepRows = (): SheetRow[] => POSE_SWEEPS.map((s) => ({ key: `sweep-${s.id}`, label: s.label, kind: "sweep", sweep: s }));

export const pageCount = (rows: number, per = ROWS_PER_PAGE): number => Math.max(1, Math.ceil(rows / per));

export const pageRows = <T>(rows: readonly T[], page: number, per = ROWS_PER_PAGE): T[] => rows.slice(page * per, page * per + per);
