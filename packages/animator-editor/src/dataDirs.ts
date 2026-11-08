/*
 * Atlas Animator editor: where the dev server reads and writes the user's data (Node; used by vite.config.ts).
 *
 * The user's data lives in one folder outside any git checkout (data-safety rule), so a `git clean`, a reset, a
 * worktree retire or a script's rigsync can never take it:
 *   default   %USERPROFILE%\Documents\Atlas Animator\
 *   Settings  the "Data folder" field in Files (saved to %APPDATA%\Atlas Animator\data-location.json; used after a restart)
 *   env       ATLAS_EDITOR_DATA_DIR=<absolute folder> wins over both (demo and QA runs use a temp folder this way)
 * Layout:
 *   clips/  poses/  smears/  autosave/  exports/  history/  rigs/  backups/
 *   board-config.json  board.json  tween-marks.json  refs.json  migration.json
 * Rigs: the repo's packages/animator/rigs are the stock (published) rigs. The user's working copies live in <data>/rigs/<dir>/:
 * a rig folder there wins over the stock folder of the same name (src/rigStore.ts copies a stock folder in on its first edit).
 * Mostly path logic; the only file access is the pointer-file read and the "is there an user copy" check.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export const DATA_DIR_ENV = "ATLAS_EDITOR_DATA_DIR";
/** Test hook: the repo root whose packages/animator/rigs are the stock rigs and the Publish target (default: this checkout). */
export const STOCK_ROOT_ENV = "ATLAS_EDITOR_STOCK_ROOT";
/** Test hook: migrate the in-worktree data of this repo root even though ATLAS_EDITOR_DATA_DIR is set. */
/**
 * Set to 1 by the launcher (tools/atlas-animator) and nothing else: only then may the editor use the user's REAL data folder and migrate
 * old in-worktree data into it. A plain `pnpm dev` (any checkout) has no such variable and gets <worktree>/.atlas-sandbox-data.
 */
export const USER_DATA_ENV = "ATLAS_EDITOR_USER_DATA";
export const SANDBOX_DIR_NAME = ".atlas-sandbox-data";
export const MIGRATE_FROM_ENV = "ATLAS_EDITOR_MIGRATE_FROM";
export const RIGS_REL = "packages/animator/rigs";
export const EDITOR_REL = "packages/animator-editor";
/** Folders under packages/animator-editor that moved into the data dir (same names there). */
export const DATA_FOLDERS = ["clips", "poses", "smears", "autosave", "exports"] as const;
/** Small state files that lived in clips/ and now sit at the data dir root. */
export const ROOT_FILES = ["board-config.json", "board.json", "tween-marks.json", "refs.json"] as const;

type Env = Record<string, string | undefined>;
export type DataSource = "env" | "settings" | "default" | "sandbox";

export interface DataLocation {
  dataDir: string;
  source: DataSource;
  defaultDir: string;
  /** The Settings pointer file (outside the data dir, so a moved data dir is still found). */
  pointerFile: string;
}

const home = (env: Env): string => env["USERPROFILE"]?.trim() || env["HOME"]?.trim() || homedir();
export const defaultDataDir = (env: Env): string => resolve(home(env), "Documents", "Atlas Animator");
export const pointerFileOf = (env: Env): string => resolve(env["APPDATA"]?.trim() || resolve(home(env), ".config"), "Atlas Animator", "data-location.json");

/** env > Settings pointer > default. A broken pointer file falls back to the default (never throws for it). */
export function resolveDataLocation(env: Env = process.env, readText: (file: string) => string | null = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null)): DataLocation {
  const defaultDir = defaultDataDir(env);
  const pointerFile = pointerFileOf(env);
  const raw = env[DATA_DIR_ENV]?.trim();
  if (raw) {
    if (!isAbsolute(raw)) throw new Error(`${DATA_DIR_ENV} must be an absolute path (got ${raw})`);
    return { dataDir: resolve(raw), source: "env", defaultDir, pointerFile };
  }
  try {
    const text = readText(pointerFile);
    const dir = text ? (JSON.parse(text) as { dataDir?: unknown }).dataDir : null;
    if (typeof dir === "string" && isAbsolute(dir)) return { dataDir: resolve(dir), source: "settings", defaultDir, pointerFile };
  } catch {
    // unreadable pointer: use the default
  }
  return { dataDir: defaultDir, source: "default", defaultDir, pointerFile };
}

export interface DataDirs extends DataLocation {
  /** True when ATLAS_EDITOR_DATA_DIR chose the folder or the per-worktree sandbox is in use (demo / QA / dev runs; no automatic migration). */
  sandbox: boolean;
  /** True only for a launcher run (ATLAS_EDITOR_USER_DATA=1) without an ATLAS_EDITOR_DATA_DIR override: the real user data folder, migration allowed. */
  user: boolean;
  saveDir: string;
  poseDir: string;
  smearDir: string;
  autosaveDir: string;
  exportsDir: string;
  historyDir: string;
  backupsDir: string;
  /** The user's rig working copies (<data>/rigs/<dir>/...). */
  rigsDir: string;
  /** The repo root that holds the stock rigs (packages/animator/rigs) and receives Publish. */
  stockRoot: string;
  /** Absolute folders GET /repo/<path> may serve, each with a trailing separator. */
  readRoots: string[];
  /** Where a repo-relative path (as the browser asks for it) really lives: data dir for user data, user rig copy before stock rig. */
  mapRepoPath(rel: string): string;
}

export function resolveDataDirs(_packageDir: string, repoRoot: string, env: Env = process.env, exists: (path: string) => boolean = existsSync): DataDirs {
  const fromEnv = resolveDataLocation(env);
  const isUserData = env[USER_DATA_ENV]?.trim() === "1";
  // The guard: without the launcher's flag (and without an explicit ATLAS_EDITOR_DATA_DIR) the real user folder is never used.
  const loc: DataLocation = fromEnv.source === "env" || isUserData ? fromEnv : { ...fromEnv, dataDir: resolve(repoRoot, SANDBOX_DIR_NAME), source: "sandbox" };
  const { dataDir } = loc;
  const stockRaw = env[STOCK_ROOT_ENV]?.trim();
  if (stockRaw && !isAbsolute(stockRaw)) throw new Error(`${STOCK_ROOT_ENV} must be an absolute path (got ${stockRaw})`);
  const stockRoot = stockRaw ? resolve(stockRaw) : repoRoot;
  const rigsDir = resolve(dataDir, "rigs");
  const stockRigs = resolve(stockRoot, RIGS_REL);
  const mapRepoPath = (rel: string): string => {
    const clean = rel.split(String.fromCharCode(92)).join("/").replace(/^\/+/, "");
    if (clean === RIGS_REL || clean.startsWith(`${RIGS_REL}/`)) {
      const rest = clean.slice(RIGS_REL.length + 1);
      const dir = rest.split("/")[0] ?? "";
      if (dir && dir !== "." && dir !== ".." && exists(resolve(rigsDir, dir))) return resolve(rigsDir, rest);
      return resolve(stockRigs, rest);
    }
    for (const name of DATA_FOLDERS) {
      const base = `${EDITOR_REL}/${name}`;
      if (clean === base || clean.startsWith(`${base}/`)) return resolve(dataDir, name, clean.slice(base.length + 1));
    }
    return resolve(repoRoot, clean);
  };
  return {
    ...loc,
    sandbox: loc.source === "env" || loc.source === "sandbox",
    user: isUserData && loc.source !== "env",
    saveDir: resolve(dataDir, "clips"),
    poseDir: resolve(dataDir, "poses"),
    smearDir: resolve(dataDir, "smears"),
    autosaveDir: resolve(dataDir, "autosave"),
    exportsDir: resolve(dataDir, "exports"),
    historyDir: resolve(dataDir, "history"),
    backupsDir: resolve(dataDir, "backups"),
    rigsDir,
    stockRoot,
    readRoots: [
      resolve(repoRoot, "docs/plans/atlas-animator-demos"),
      resolve(repoRoot, "packages/animator/fixtures"),
      stockRigs,
      rigsDir,
      ...["clips", "poses", "smears", "exports"].map((n) => resolve(dataDir, n))
    ].map((p) => p + sep),
    mapRepoPath
  };
}
