/*
 * Atlas Animator editor: the user data folder's housekeeping (Node; used by vite.config.ts and scripts/qa-data-safety.mjs).
 *
 * - migrateWorktreeData: the one-time copy of the data that used to live inside the git worktree (packages/animator-editor/clips with
 *   .history, board files, refs and tween marks; autosave, poses, smears, exports; and rig folders made with New rig or edited but not
 *   committed) into the data folder. It zips everything to backups/pre-migration-<time>.zip first, copies without ever overwriting a
 *   file already in the data folder, leaves the old files where they are with a MIGRATED.txt next to them, and records the run in
 *   migration.json so a second start does nothing.
 * - backupNow / listBackups / restoreBackup / autoBackup: zips of the whole data folder (except backups/) in backups/. The automatic one
 *   runs at most once a day and only when something changed; the newest 14 automatic zips are kept (manual ones are never pruned).
 * - setDataLocation: the Settings "Data folder" pointer (used after a restart), copying the current files into an empty new folder.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DATA_FOLDERS, EDITOR_REL, RIGS_REL, ROOT_FILES, type DataLocation } from "./dataDirs.js";
import { hashFolder, writeBase } from "./rigStore.js";
import { writeAtomic } from "./safeFs.js";
import { readZip, writeZip, type ZipInput } from "./zipFiles.js";

export const AUTO_KEEP = 14;
const DAY_MS = 24 * 3600 * 1000;
const INFO_ENTRY = "_backup-info.json";
const BACKUP_NAME = /^(pre-migration|manual|auto|before-restore)-[0-9TZ-]+\.zip$/;
const stamp = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");

/** Files under a folder, recursive, as [absolute path, forward-slash relative path]. */
function walk(root: string, skipTop: readonly string[] = []): [string, string][] {
  const out: [string, string][] = [];
  const go = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!prefix && skipTop.includes(e.name)) continue;
      if (e.isDirectory()) go(resolve(dir, e.name), rel);
      else if (e.isFile() && !e.name.endsWith(".partial") && !/\.tmp-/.test(e.name)) out.push([resolve(dir, e.name), rel]);
    }
  };
  if (existsSync(root)) go(root, "");
  return out;
}

export interface MigrationSummary {
  at: string;
  /** The worktree package folder the data came from. */
  from: string;
  backup: string | null;
  /** Files copied per area (clips, history, autosave, poses, smears, exports, rigs, root files). */
  copied: Record<string, number>;
  /** Files already in the data folder (left as they were). */
  skipped: number;
  rigs: string[];
  errors: string[];
}

interface Planned {
  src: string;
  /** Path inside the data folder (forward slashes). */
  dest: string;
  area: string;
}

/** Rig folders that are user work: made with New rig (rig.meta.json) or with uncommitted changes (git status, when git is there). */
function userRigFolders(repoRoot: string): { dir: string; edited: boolean }[] {
  const rigsRoot = resolve(repoRoot, RIGS_REL);
  if (!existsSync(rigsRoot)) return [];
  const changed = new Set<string>();
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", RIGS_REL], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    for (const line of out.split("\n")) {
      const path = line.slice(3).trim().replace(/^"|"$/g, "");
      const m = path.startsWith(`${RIGS_REL}/`) ? path.slice(RIGS_REL.length + 1).split("/")[0] : null;
      if (m) changed.add(m);
    }
  } catch {
    // no git: only New rig folders count
  }
  return readdirSync(rigsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (existsSync(resolve(rigsRoot, e.name, "rig.meta.json")) || changed.has(e.name)))
    .map((e) => ({ dir: e.name, edited: changed.has(e.name) && !existsSync(resolve(rigsRoot, e.name, "rig.meta.json")) }));
}

function planMigration(repoRoot: string): { plan: Planned[]; rigs: { dir: string; edited: boolean }[] } {
  const pkg = resolve(repoRoot, EDITOR_REL);
  const plan: Planned[] = [];
  const clips = resolve(pkg, "clips");
  for (const [src, rel] of walk(clips)) {
    if (rel === "MIGRATED.txt") continue;
    if (rel.startsWith(".history/")) plan.push({ src, dest: `history/${rel.slice(".history/".length)}`, area: "history" });
    else if ((ROOT_FILES as readonly string[]).includes(rel)) plan.push({ src, dest: rel, area: "root files" });
    else plan.push({ src, dest: `clips/${rel}`, area: "clips" });
  }
  for (const name of DATA_FOLDERS) {
    if (name === "clips") continue;
    for (const [src, rel] of walk(resolve(pkg, name))) if (rel !== "MIGRATED.txt") plan.push({ src, dest: `${name}/${rel}`, area: name });
  }
  const rigs = userRigFolders(repoRoot);
  for (const { dir } of rigs) for (const [src, rel] of walk(resolve(repoRoot, RIGS_REL, dir))) if (rel !== "MIGRATED.txt") plan.push({ src, dest: `rigs/${dir}/${rel}`, area: "rigs" });
  return { plan, rigs };
}

interface MigrationRecord {
  format: "atlas-migration@1";
  runs: MigrationSummary[];
}
export const readMigrations = (dataDir: string): MigrationSummary[] => {
  const file = resolve(dataDir, "migration.json");
  try {
    return existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as MigrationRecord).runs ?? []) : [];
  } catch {
    return [];
  }
};

/**
 * Copies the in-worktree user data of `repoRoot` into `dataDir` once (see the header). Returns null when this worktree was already
 * migrated. Never deletes or overwrites anything.
 */
export async function migrateWorktreeData(o: { repoRoot: string; dataDir: string; now?: Date; log?: (line: string) => void }): Promise<MigrationSummary | null> {
  const now = o.now ?? new Date();
  const log = o.log ?? ((l: string) => console.log(l));
  const pkg = resolve(o.repoRoot, EDITOR_REL);
  const runs = readMigrations(o.dataDir);
  if (runs.some((r) => resolve(r.from) === pkg)) return null;
  const { plan, rigs } = planMigration(o.repoRoot);
  const summary: MigrationSummary = { at: now.toISOString(), from: pkg, backup: null, copied: {}, skipped: 0, rigs: rigs.map((r) => r.dir), errors: [] };
  mkdirSync(o.dataDir, { recursive: true });
  if (plan.length) {
    // 1. Back everything up first (the zip uses the new layout, so "Restore from backup" can use it like any other backup).
    const backups = resolve(o.dataDir, "backups");
    mkdirSync(backups, { recursive: true });
    const zip = resolve(backups, `pre-migration-${stamp(now)}.zip`);
    const info = { kind: "pre-migration", at: now.toISOString(), from: pkg, repoRoot: o.repoRoot, files: plan.map((p) => ({ from: relative(o.repoRoot, p.src).split(sep).join("/"), to: p.dest })) };
    await writeZip(zip, [{ name: INFO_ENTRY, data: Buffer.from(JSON.stringify(info, null, 2)) }, ...plan.map((p): ZipInput => ({ name: p.dest, path: p.src, mtime: statSync(p.src).mtime }))]);
    summary.backup = zip;
    // 2. Copy, never overwriting, keeping the file times (autosave and History sort by them).
    for (const p of plan) {
      const dest = resolve(o.dataDir, p.dest);
      try {
        if (existsSync(dest)) {
          summary.skipped++;
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(p.src, dest, { preserveTimestamps: true, errorOnExist: true, force: false });
        if (statSync(dest).size !== statSync(p.src).size) throw new Error("size differs after the copy");
        summary.copied[p.area] = (summary.copied[p.area] ?? 0) + 1;
      } catch (error) {
        summary.errors.push(`${p.dest}: ${(error as Error).message}`);
      }
    }
    // 3. Migrated rigs: New rig folders are the user's own (base = what was copied); edited stock rigs have an unknown base.
    for (const r of rigs) {
      const folder = resolve(o.dataDir, "rigs", r.dir);
      if (existsSync(folder) && !existsSync(resolve(folder, ".stock-base.json"))) writeBase(folder, r.edited ? null : hashFolder(resolve(o.repoRoot, RIGS_REL, r.dir)), now);
    }
    // 4. Markers next to the old files (they stay; nothing is deleted).
    const note = `Migrated to ${o.dataDir} on ${now.toISOString()}.\r\nThe editor now reads and writes that folder. These old files were left in place (backup: ${zip}).\r\n`;
    const markerDirs = new Set(plan.map((p) => (p.area === "rigs" ? resolve(o.repoRoot, RIGS_REL, p.dest.split("/")[1]!) : resolve(pkg, p.dest.startsWith("history/") || p.area === "root files" || p.area === "clips" ? "clips" : p.dest.split("/")[0]!))));
    for (const d of markerDirs) {
      try {
        writeFileSync(resolve(d, "MIGRATED.txt"), note);
      } catch (error) {
        summary.errors.push(`MIGRATED.txt in ${d}: ${(error as Error).message}`);
      }
    }
  }
  writeAtomic(resolve(o.dataDir, "migration.json"), `${JSON.stringify({ format: "atlas-migration@1", runs: [...runs, summary] } satisfies MigrationRecord, null, 2)}\n`);
  const counts = Object.entries(summary.copied).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing to copy";
  log(`[animator-editor] migrated user data from ${pkg} to ${o.dataDir}: ${counts}; ${summary.skipped} already there; ${summary.errors.length} error(s)${summary.backup ? `; backup ${summary.backup}` : ""}`);
  for (const e of summary.errors) log(`[animator-editor]   migration error: ${e}`);
  return summary;
}

export interface BackupInfo {
  name: string;
  kind: string;
  bytes: number;
  time: string;
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = resolve(dataDir, "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => BACKUP_NAME.test(n))
    .map((name) => {
      const st = statSync(resolve(dir, name));
      return { name, kind: name.replace(/-\d.*$/, ""), bytes: st.size, time: st.mtime.toISOString() };
    })
    .sort((a, b) => b.time.localeCompare(a.time) || b.name.localeCompare(a.name));
}

/** Zips the whole data folder (except backups/) into backups/<kind>-<time>.zip. */
export async function backupNow(dataDir: string, kind: "manual" | "auto" | "before-restore" = "manual", now = new Date()): Promise<BackupInfo & { files: number; path: string }> {
  const files = walk(dataDir, ["backups"]);
  const dir = resolve(dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  let name = `${kind}-${stamp(now)}.zip`;
  for (let i = 1; existsSync(resolve(dir, name)); i++) name = `${kind}-${stamp(new Date(now.getTime() + i))}.zip`;
  const path = resolve(dir, name);
  const info = { kind, at: now.toISOString(), dataDir, files: files.length };
  const out = await writeZip(path, [{ name: INFO_ENTRY, data: Buffer.from(JSON.stringify(info, null, 2)) }, ...files.map(([src, rel]): ZipInput => ({ name: rel, path: src, mtime: statSync(src).mtime }))]);
  return { name, kind, bytes: out.bytes, time: now.toISOString(), files: files.length, path };
}

/**
 * Restores a backup over the data folder: a before-restore backup is made first, then every file in the zip is written back
 * (files added since the backup stay). Returns how many files were written.
 */
export async function restoreBackup(dataDir: string, name: string, now = new Date()): Promise<{ restored: number; before: string }> {
  if (!BACKUP_NAME.test(name)) throw new Error("not a backup name");
  const zip = resolve(dataDir, "backups", name);
  if (!existsSync(zip)) throw new Error(`no backup ${name}`);
  const entries = readZip(zip);
  const before = await backupNow(dataDir, "before-restore", now);
  const root = resolve(dataDir) + sep;
  let restored = 0;
  for (const e of entries) {
    if (e.name === INFO_ENTRY || e.name.startsWith("backups/")) continue;
    const dest = resolve(dataDir, e.name);
    if (!dest.startsWith(root) || isAbsolute(e.name)) throw new Error(`unsafe path in backup: ${e.name}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeAtomic(dest, e.data);
    restored++;
  }
  return { restored, before: before.name };
}

/** The daily automatic zip: at most one per 24 h, only when a file changed since the last one; keeps the newest AUTO_KEEP. */
export async function autoBackup(dataDir: string, now = new Date()): Promise<string | null> {
  const autos = listBackups(dataDir).filter((b) => b.kind === "auto");
  const last = autos[0] ? Date.parse(autos[0].time) : 0;
  if (last && now.getTime() - last < DAY_MS) return null;
  const files = walk(dataDir, ["backups"]).filter(([, rel]) => rel !== "migration.json");
  if (!files.length) return null;
  const newest = Math.max(...files.map(([p]) => statSync(p).mtimeMs));
  if (last && newest <= last) return null;
  const made = await backupNow(dataDir, "auto", now);
  for (const old of listBackups(dataDir).filter((b) => b.kind === "auto").slice(AUTO_KEEP)) unlinkSync(resolve(dataDir, "backups", old.name));
  return made.name;
}

/**
 * Saves the Settings "Data folder" (null = back to the default). An empty or new target gets a copy of the current files (backups too),
 * so nothing is left behind; the editor uses the new folder after a restart.
 */
export function setDataLocation(loc: DataLocation, dir: string | null): { dataDir: string; copied: number } {
  if (loc.source === "sandbox") throw new Error("this is a sandbox run (not started by the Atlas Animator launcher), so it never uses your real data folder");
  if (loc.source === "env") throw new Error("ATLAS_EDITOR_DATA_DIR is set for this run; the folder can only be changed there");
  const target = dir === null ? loc.defaultDir : dir.trim();
  if (!isAbsolute(target)) throw new Error("the data folder must be a full path, like C:\\Users\\you\\Documents\\Atlas Animator");
  const abs = resolve(target);
  const current = resolve(loc.dataDir);
  if (abs.startsWith(current + sep) || current.startsWith(abs + sep)) throw new Error("the new folder cannot be inside the current one (or the other way round)");
  let copied = 0;
  if (abs !== current) {
    mkdirSync(abs, { recursive: true });
    if (readdirSync(abs).length === 0 && existsSync(current)) {
      copied = walk(current).length;
      cpSync(current, abs, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: false });
    }
  }
  mkdirSync(dirname(loc.pointerFile), { recursive: true });
  writeAtomic(loc.pointerFile, `${JSON.stringify({ dataDir: dir === null ? null : abs, updated: new Date().toISOString() }, null, 2)}\n`);
  return { dataDir: abs, copied };
}
