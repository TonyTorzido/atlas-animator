/*
 * Atlas Animator editor: the user's rig working copies over the repo's stock rigs (Node; used by vite.config.ts).
 *
 * - Stock rigs: <repo>/packages/animator/rigs/<dir>/ (tracked; rigsync updates them).
 * - User rigs: <data>/rigs/<dir>/ (outside git). A folder there wins over the stock folder of the same name.
 * - Copy on first edit: the first write to a stock rig copies its whole folder into the user rigs (temp folder + rename) and records
 *   the stock file hashes it started from in `.stock-base.json`. Every later read and write of that rig uses the user copy.
 * - Newer stock: when a stock file differs from that base (and from the user's file), `status()` reports the rig; the editor asks
 *   "Compare / Take theirs / Keep mine". Nothing is overwritten without that answer; Take theirs moves the user folder to
 *   backups/replaced-rigs/ first.
 * - Publish: copies an user rig folder (or a saved clip) into the repo after showing what changes; the repo files it replaces are
 *   copied to backups/published/ first. It never runs git. Only rigs the repo already has (registered game rigs) are published; a
 *   New-rig character is refused with the register hint (PL-02). Every publish records the sha1 of what it wrote in
 *   `packages/animator/publish-manifest.json`, which the Publish validator (animator validate-publish) checks.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { listRigs, type RigEntry } from "./rigCreate.js";
import { RIGS_DIR, SaveError, type RigRoot } from "./rigSave.js";
import { writeAtomic } from "./safeFs.js";
import { PUBLISH_MANIFEST_FORMAT, PUBLISH_MANIFEST_REL, readPublishManifest, type PublishManifest } from "../../animator/src/cli/validatePublish.js";

export const BASE_FILE = ".stock-base.json";
/** Bookkeeping files that never count as rig content. */
const SKIP = new Set([BASE_FILE, "MIGRATED.txt"]);
export const CLIPS_REPO_REL = "packages/animator/clips";
const DIR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/;
const CLIP_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.clip\.json$/;

/** The refusal for a rig the project repo does not have (PL-02): the message names the register step. */
export const unregisteredRig = (name: string): string =>
  `Rig '${name}' is not a registered game rig: the repo has no ${RIGS_DIR}/${name} folder, so nothing in the project would load it. Nothing was published. A New-rig character has to be registered as a new character first (catalog entry + game sheets: "Register as a new character", Batch 11).`;

export interface StockBase {
  format: "atlas-stock-base@1";
  taken: string;
  /** Stock file hashes (path inside the rig folder -> sha1) the user copy started from; null = unknown (migrated edits). */
  files: Record<string, string> | null;
}
export interface FileChange {
  file: string;
  change: "added" | "changed" | "removed";
}
export interface DocCounts {
  bones: number;
  slots: number;
  skins: number;
  animations: number;
  bytes: number;
}
export interface StockStatus {
  dir: string;
  /** Stock files that changed since the user's base (and differ from the user's file). */
  changes: FileChange[];
  baseUnknown: boolean;
  /** Per rig document: counts in the user copy (mine) and in the stock copy (theirs). */
  docs: { file: string; mine: DocCounts | null; theirs: DocCounts | null }[];
}
export interface PublishPlan {
  kind: "rig" | "clip";
  name: string;
  /** Repo-relative folder or file that receives the files. */
  target: string;
  added: string[];
  changed: string[];
  unchanged: number;
  /** Repo files the user copy does not have: left alone. */
  onlyInRepo: string[];
  /** Short sha1 of each file that would be written (added + changed), by file name: what the artist reviewed (). */
  hashes: Record<string, string>;
  /** One token over the source and destination hashes of those files; Publish sends it back and the server refuses when it moved. */
  token: string;
}

const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();
function fileHash(path: string): string {
  const st = statSync(path);
  const hit = hashCache.get(path);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.hash;
  const hash = createHash("sha1").update(readFileSync(path)).digest("hex");
  hashCache.set(path, { size: st.size, mtime: st.mtimeMs, hash });
  return hash;
}

/** Every file in a folder (recursive, forward-slash paths) -> sha1, without the bookkeeping files. */
export function hashFolder(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(resolve(dir, e.name), rel);
      else if (e.isFile() && !SKIP.has(rel)) out[rel] = fileHash(resolve(dir, e.name));
    }
  };
  if (existsSync(folder)) walk(folder, "");
  return out;
}

function docCounts(path: string): DocCounts | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const len = (v: unknown): number => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);
    return { bones: len(doc["bones"]), slots: len(doc["slots"]), skins: len(doc["skins"]), animations: len(doc["animations"]), bytes: statSync(path).size };
  } catch {
    return { bones: 0, slots: 0, skins: 0, animations: 0, bytes: statSync(path).size };
  }
}

const stamp = (now = new Date()): string => now.toISOString().replace(/[:.]/g, "-");

export function writeBase(folder: string, files: Record<string, string> | null, now = new Date()): void {
  const base: StockBase = { format: "atlas-stock-base@1", taken: now.toISOString(), files };
  writeAtomic(resolve(folder, BASE_FILE), `${JSON.stringify(base, null, 2)}\n`);
}
export function readBase(folder: string): StockBase | null {
  const file = resolve(folder, BASE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StockBase;
  } catch {
    return null;
  }
}

export interface RigStoreOptions {
  /** Repo root holding the stock rigs (packages/animator/rigs) and receiving Publish. */
  stockRoot: string;
  /** The user's rig folder (<data>/rigs). */
  rigsDir: string;
  /**
   * The project folder Publish writes into (it mirrors this repo's layout: <folder>/packages/animator/rigs/<rig>). Omitted: the stock root
   * (the old behaviour). null: no publish folder is set, so Publish is off.
   */
  publishRoot?: string | null;
  /** <data>/backups (Take theirs and Publish keep their copies there). */
  backupsDir: string;
  log?: (line: string) => void;
}

export type RigStore = ReturnType<typeof createRigStore>;

export function createRigStore(o: RigStoreOptions) {
  const own: RigRoot = { rigsDir: o.rigsDir };
  const stockRigs = resolve(o.stockRoot, RIGS_DIR);
  const log = o.log ?? (() => undefined);
  const checkDir = (dir: string): string => {
    if (!DIR_NAME.test(dir) || dir.includes("..")) throw new SaveError(`bad rig folder name '${dir}'`);
    return dir;
  };
  /** The rig folder name of a repo-relative rig path (packages/animator/rigs/<dir>/...). */
  const dirOf = (rel: string): string => {
    const clean = String(rel ?? "").split(String.fromCharCode(92)).join("/");
    if (!clean.startsWith(`${RIGS_DIR}/`)) throw new SaveError(`expected a file under ${RIGS_DIR}`);
    return checkDir(clean.slice(RIGS_DIR.length + 1).split("/")[0] ?? "");
  };
  const ownedPath = (dir: string): string => resolve(o.rigsDir, checkDir(dir));
  const stockPath = (dir: string): string => resolve(stockRigs, checkDir(dir));
  const publishDir: string | null = o.publishRoot === undefined ? o.stockRoot : o.publishRoot;
  const separatePublish = publishDir !== null && resolve(publishDir) !== resolve(o.stockRoot);
  /** The folder Publish writes into, or a SaveError (400) when none is set. */
  const pubRoot = (): string => {
    if (publishDir === null) throw new SaveError("No publish folder is set. Choose one in Files > Publish folder (or set ATLAS_EDITOR_PUBLISH_DIR) to publish rigs and clips.", 400);
    return publishDir;
  };
  const pubPath = (dir: string): string => resolve(pubRoot(), RIGS_DIR, checkDir(dir));
  const hashIfThere = (folder: string): Record<string, string> => (existsSync(folder) ? hashFolder(folder) : {});
  const owned = (dir: string): boolean => existsSync(ownedPath(dir));

  /** Copies a stock rig folder into the user rigs (once). A rig with no stock folder is simply created in the user rigs. */
  function ensureOwned(dir: string): void {
    if (owned(dir)) return;
    const src = stockPath(dir);
    if (!existsSync(src)) return;
    mkdirSync(o.rigsDir, { recursive: true });
    const tmp = resolve(o.rigsDir, `.copying-${dir}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    cpSync(src, tmp, { recursive: true, preserveTimestamps: true });
    writeBase(tmp, hashFolder(src));
    renameSync(tmp, ownedPath(dir));
    log(`[animator-editor] rig ${dir}: first edit, copied the stock folder into ${ownedPath(dir)}`);
  }

  /** Stock changes the user has not answered yet (empty when there is nothing newer). */
  function compare(dir: string): StockStatus {
    const mineDir = ownedPath(dir);
    const theirsDir = stockPath(dir);
    const base = readBase(mineDir);
    const empty: StockStatus = { dir, changes: [], baseUnknown: false, docs: [] };
    if (!existsSync(mineDir) || !existsSync(theirsDir)) return empty;
    const theirs = hashFolder(theirsDir);
    const mine = hashFolder(mineDir);
    const baseFiles = base?.files ?? null;
    const changes: FileChange[] = [];
    for (const [file, hash] of Object.entries(theirs)) {
      if (mine[file] === hash) continue; // already the same as the user's
      if (baseFiles && baseFiles[file] === hash) continue; // unchanged since the user's copy was taken
      changes.push({ file, change: baseFiles ? (file in baseFiles ? "changed" : "added") : file in mine ? "changed" : "added" });
    }
    if (baseFiles) for (const file of Object.keys(baseFiles)) if (!(file in theirs) && file in mine) changes.push({ file, change: "removed" });
    changes.sort((a, b) => a.file.localeCompare(b.file));
    const docs = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])]
      .filter((f) => f.endsWith(".anim.json"))
      .sort()
      .map((file) => ({ file, mine: docCounts(resolve(mineDir, file)), theirs: docCounts(resolve(theirsDir, file)) }));
    return { dir, changes, baseUnknown: !baseFiles, docs };
  }

  const ownedDirs = (): string[] => (existsSync(o.rigsDir) ? readdirSync(o.rigsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && DIR_NAME.test(e.name) && !e.name.startsWith(".")).map((e) => e.name).sort() : []);

  const planToken = (rows: [string, string, string][]): string => createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 16);

  function publishPlan(kind: "rig" | "clip", name: string, clipsDir: string): PublishPlan {
    if (kind === "rig" && !separatePublish && DIR_NAME.test(name) && !existsSync(stockPath(name))) throw new SaveError(unregisteredRig(name), 400);
    if (kind === "clip") {
      if (!CLIP_FILE.test(name)) throw new SaveError("expected <name>.clip.json");
      const src = resolve(clipsDir, name);
      if (!existsSync(src)) throw new SaveError(`${name} is not saved`, 404);
      const dest = resolve(pubRoot(), CLIPS_REPO_REL, name);
      const exists = existsSync(dest);
      const same = exists && fileHash(dest) === fileHash(src);
      const hashes: Record<string, string> = same ? {} : { [name]: fileHash(src).slice(0, 10) };
      return { kind, name, target: `${CLIPS_REPO_REL}/${name}`, added: exists ? [] : [name], changed: exists && !same ? [name] : [], unchanged: same ? 1 : 0, onlyInRepo: [], hashes, token: planToken([[name, fileHash(src), exists ? fileHash(dest) : ""]]) };
    }
    const mineDir = ownedPath(name);
    if (!existsSync(mineDir)) throw new SaveError(`rig ${name} has no user copy to publish (it was never edited)`, 404);
    const mine = hashFolder(mineDir);
    const theirs = hashIfThere(pubPath(name));
    const plan: PublishPlan = { kind, name, target: `${RIGS_DIR}/${name}`, added: [], changed: [], unchanged: 0, onlyInRepo: [], hashes: {}, token: "" };
    for (const [file, hash] of Object.entries(mine)) {
      if (!(file in theirs)) plan.added.push(file);
      else if (theirs[file] !== hash) plan.changed.push(file);
      else plan.unchanged++;
    }
    plan.onlyInRepo = Object.keys(theirs).filter((f) => !(f in mine)).sort();
    plan.added.sort();
    plan.changed.sort();
    const moved = [...plan.added, ...plan.changed];
    for (const f of moved) plan.hashes[f] = mine[f]!.slice(0, 10);
    plan.token = planToken(moved.map((f) => [f, mine[f]!, theirs[f] ?? ""] as [string, string, string]));
    return plan;
  }

  /** Adds this publish to packages/animator/publish-manifest.json (sha1 of every file the repo now has from it). */
  function recordPublish(kind: "rig" | "clip", name: string, files: Record<string, string>, target: string, now: Date): void {
    const file = resolve(pubRoot(), PUBLISH_MANIFEST_REL);
    let manifest: PublishManifest;
    try {
      manifest = readPublishManifest(pubRoot()) ?? { format: PUBLISH_MANIFEST_FORMAT, rigs: {}, clips: {} };
    } catch {
      manifest = { format: PUBLISH_MANIFEST_FORMAT, rigs: {}, clips: {} }; // an unreadable manifest is replaced, the files are the truth
    }
    const publishedAt = now.toISOString();
    if (kind === "rig") manifest.rigs[name] = { publishedAt, target, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
    else manifest.clips[name] = { publishedAt, target, sha1: files[name]! };
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(manifest, null, 1)}\n`);
  }

  return {
    user: own,
    stockRoot: o.stockRoot,
    /** The folder Publish writes into (null: Publish is off until a folder is set). */
    publishRoot: publishDir,
    dirOf,
    owned,
    ownedDirs,
    /** The rig root to READ a repo-relative rig path from: the user copy when there is one, else the stock repo. */
    readRoot(rel: string): RigRoot {
      return owned(dirOf(rel)) ? own : o.stockRoot;
    },
    /** The rig root to WRITE a repo-relative rig path to: always the user rigs (copying the stock folder in first). */
    writeRoot(rel: string): RigRoot {
      ensureOwned(dirOf(rel));
      return own;
    },
    ensureOwned,
    /** Absolute file of a repo-relative rig path for reading (user copy first). */
    readPath(rel: string): string {
      const dir = dirOf(rel);
      const rest = String(rel).split(String.fromCharCode(92)).join("/").slice(RIGS_DIR.length + 1);
      return owned(dir) ? resolve(o.rigsDir, rest) : resolve(stockRigs, rest);
    },
    /** Every listed (rig.meta.json) rig: user rigs first, then stock rigs the user has no copy of. */
    list(): RigEntry[] {
      const mine = listRigs(own);
      const ids = new Set(mine.map((r) => r.id));
      return [...mine, ...listRigs(o.stockRoot).filter((r) => !ids.has(r.id))].sort((a, b) => a.id.localeCompare(b.id));
    },
    /** Rig folders (user + stock, user wins) as name -> absolute folder. */
    folders(): Map<string, string> {
      const out = new Map<string, string>();
      if (existsSync(stockRigs)) for (const e of readdirSync(stockRigs, { withFileTypes: true })) if (e.isDirectory() && DIR_NAME.test(e.name)) out.set(e.name, resolve(stockRigs, e.name));
      for (const d of ownedDirs()) out.set(d, ownedPath(d));
      return out;
    },
    compare,
    /** User rigs whose stock version moved on since the user's copy was taken. */
    status(): StockStatus[] {
      return ownedDirs()
        .map((d) => compare(d))
        .filter((s) => s.changes.length > 0);
    },
    /** "Keep mine": the current stock becomes the base, so the question is not asked again until the stock changes again. */
    keepMine(dir: string, now = new Date()): void {
      if (!owned(dir)) throw new SaveError(`rig ${dir} has no user copy`, 404);
      writeBase(ownedPath(dir), hashFolder(stockPath(dir)), now);
      log(`[animator-editor] rig ${dir}: kept the user's copy over the newer stock version`);
    },
    /** "Take theirs": the user folder moves to backups/replaced-rigs/<dir>-<time>/, then the stock folder is copied in. */
    takeTheirs(dir: string, now = new Date()): { backup: string } {
      if (!owned(dir)) throw new SaveError(`rig ${dir} has no user copy`, 404);
      const src = stockPath(dir);
      if (!existsSync(src)) throw new SaveError(`there is no stock rig ${dir}`, 404);
      const backup = resolve(o.backupsDir, "replaced-rigs", `${dir}-${stamp(now)}`);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(ownedPath(dir), backup, { recursive: true, preserveTimestamps: true });
      rmSync(ownedPath(dir), { recursive: true, force: true });
      ensureOwned(dir);
      log(`[animator-editor] rig ${dir}: took the stock version; the user's copy was saved to ${backup}`);
      return { backup };
    },
    publishPlan,
    /** Copies the user rig folder (or a saved clip) into the repo. The repo files it replaces are copied to backups/published/ first. No git. */
    publish(kind: "rig" | "clip", name: string, clipsDir: string, now = new Date(), expectToken?: string): PublishPlan & { written: string[]; snapshot: string | null } {
      const plan = publishPlan(kind, name, clipsDir);
      if (expectToken && expectToken !== plan.token) throw new SaveError("The files changed since you checked what would be published. Check again to see the new differences.", 409);
      const files = [...plan.added, ...plan.changed];
      const snapRoot = resolve(o.backupsDir, "published", `${kind}-${name.replace(/\.clip\.json$/, "")}-${stamp(now)}`);
      let snapshot: string | null = null;
      const srcOf = (f: string): string => (kind === "clip" ? resolve(clipsDir, name) : resolve(ownedPath(name), f));
      const destOf = (f: string): string => (kind === "clip" ? resolve(pubRoot(), CLIPS_REPO_REL, name) : resolve(pubPath(name), f));
      for (const f of plan.changed) {
        mkdirSync(dirname(resolve(snapRoot, f)), { recursive: true });
        cpSync(destOf(f), resolve(snapRoot, f), { preserveTimestamps: true });
        snapshot = snapRoot;
      }
      const written: string[] = [];
      for (const f of files) {
        const dest = destOf(f);
        if (!dest.startsWith(resolve(pubRoot()) + sep)) throw new SaveError("publish target outside the repo");
        mkdirSync(dirname(dest), { recursive: true });
        writeAtomic(dest, readFileSync(srcOf(f)));
        written.push(kind === "clip" ? plan.target : `${plan.target}/${f}`);
      }
      if (kind === "rig" && !separatePublish) writeBase(ownedPath(name), hashFolder(stockPath(name)), now);
      recordPublish(kind, name, kind === "clip" ? { [name]: fileHash(destOf(name)) } : hashFolder(ownedPath(name)), plan.target, now);
      log(`[animator-editor] published ${kind} ${name} into ${plan.target}: ${written.length} file(s) written${snapshot ? `, previous repo files saved to ${snapshot}` : ""} (not committed)`);
      return { ...plan, written, snapshot };
    }
  };
}
