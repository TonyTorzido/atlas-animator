/*
 * Atlas Animator editor: original implementation.
 *
 * Autosave (pure, shared by the browser and the dev server): the version naming, the keep-last-N rule, the change
 * fingerprint, and the "is there an autosave newer than the saved file" decision behind the Restore offer.
 *
 * A version is one JSON file `packages/animator-editor/autosave/<clip>/<id>.<flags>.<outfit>.json`:
 *   id      UTC timestamp to the millisecond, 20261024T101500123Z (sorts as time)
 *   flags   c = the working clip, s = unsaved skin edits, u = unsaved Setup (rig) edits
 *   outfit  the rig that was open (an outfit id from fixtures.ts)
 * so a listing needs no file reads.
 */

export const AUTOSAVE_FORMAT = "atlas-autosave@1";
export const AUTOSAVE_KEEP = 30;
export const AUTOSAVE_INTERVAL_MS = 60_000;
/** Same rule as the clip file names the dev server accepts (without the .clip.json). */
export const AUTOSAVE_CLIP = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const OUTFIT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const VERSION_FILE = /^(\d{8}T\d{9}Z)\.([csu]+)\.([A-Za-z0-9_][A-Za-z0-9_-]*)\.json$/;

export interface AutosaveRigPart {
  /** Repo-relative rig document the edits belong to. */
  document: string;
  /** Unsaved skin edits (the whole skins block and the setup placeholders changed with it). */
  skins?: { skins: unknown; setup: Record<string, string | null> } | undefined;
  /** Unsaved Setup-mode edits: the command batches the rig file does not have yet, oldest first. */
  setup?: { batches: unknown[][]; undo: number } | undefined;
}

export interface AutosavePayload {
  format: typeof AUTOSAVE_FORMAT;
  clip: string;
  outfit: string;
  /** Why it was written: interval, switch, manual, before-restore. */
  reason: string;
  savedAt: string;
  /** The clip as writeClip makes it. */
  clipData: unknown;
  rig?: AutosaveRigPart | undefined;
  /** Unkeyed poses of this clip (parked per frame, plus the live one): { frame, rotate, move, scale, shear } each (). */
  drafts?: unknown[] | undefined;
}

/**
 * The autosave "clip" a rig with no clip open is kept under (): its Setup / skin edits and working pose are recovered without
 * a clip. Restoring it brings back only the rig part and the drafts, never a clip of that name.
 */
export const SETUP_SESSION_PREFIX = "_setup.";
export const setupSessionId = (outfit: string): string => `${SETUP_SESSION_PREFIX}${outfit}`;
export const isSetupSession = (clip: string): boolean => clip.startsWith(SETUP_SESSION_PREFIX);

export interface VersionInfo {
  id: string;
  /** Milliseconds since the epoch, from the id. */
  time: number;
  flags: string;
  outfit: string;
  bytes: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function versionId(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}Z`;
}

export function versionTime(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(id);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

export function flagsOf(payload: Pick<AutosavePayload, "rig">): string {
  return `c${payload.rig?.skins ? "s" : ""}${payload.rig?.setup ? "u" : ""}`;
}

export function versionFile(id: string, flags: string, outfit: string): string {
  if (!OUTFIT.test(outfit)) throw new Error(`bad outfit '${outfit}'`);
  return `${id}.${flags}.${outfit}.json`;
}

export function parseVersionFile(file: string, bytes = 0): VersionInfo | null {
  const m = VERSION_FILE.exec(file);
  if (!m) return null;
  const time = versionTime(m[1]!);
  return Number.isFinite(time) ? { id: m[1]!, time, flags: m[2]!, outfit: m[3]!, bytes } : null;
}

/** Newest first. */
export function sortVersions<T extends { time: number; id: string }>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

/** The files to delete so only the newest `keep` versions stay. */
export function pruneVersions<T extends { time: number; id: string }>(versions: readonly T[], keep = AUTOSAVE_KEEP): T[] {
  return sortVersions(versions).slice(Math.max(0, keep));
}

/** What the content is, ignoring when it was written and why: two payloads with the same fingerprint need only one version. */
export function fingerprint(payload: Pick<AutosavePayload, "clip" | "outfit" | "clipData" | "rig" | "drafts">): string {
  return JSON.stringify([payload.clip, payload.outfit, payload.clipData, payload.rig ?? null, ...(payload.drafts?.length ? [payload.drafts] : [])]);
}

/** 7 -> "7 s ago", 125 -> "2 min ago", ... for the history list. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function describeFlags(flags: string): string {
  const parts = ["clip"];
  if (flags.includes("s")) parts.push("skins");
  if (flags.includes("u")) parts.push("rig setup");
  return parts.join(" + ");
}

export interface SavedTimes {
  /** Modification time of packages/animator-editor/clips/<clip>.clip.json, by clip name. */
  clips: Record<string, number>;
  /** Modification time of each rig document, by repo-relative path. */
  rigs: Record<string, number>;
}

/**
 * Is `latest` (the newest autosave of its clip) newer than what is saved? The clip counts as saved by its clip file; a clip
 * that was never saved as a file lives in the rig document (Apply writes it there), so that file stands in. Unsaved skin /
 * Setup edits count against the rig document.
 */
export function newerThanSaved(clip: string, latest: VersionInfo, rigDocument: string | null, saved: SavedTimes): { clip: boolean; rig: boolean } {
  const clipSaved = saved.clips[clip] ?? (rigDocument ? saved.rigs[rigDocument] : undefined);
  const rigSaved = rigDocument ? saved.rigs[rigDocument] : undefined;
  const hasRig = latest.flags.includes("s") || latest.flags.includes("u");
  return { clip: clipSaved === undefined || latest.time > clipSaved, rig: hasRig && (rigSaved === undefined || latest.time > rigSaved) };
}
