/*
 * Atlas Animator editor: crash-safe file writes and rolling snapshots for the dev server (Node only).
 *
 * - writeAtomic: write to a temp file in the same folder, fsync, rename over the target (retried on Windows EPERM/EBUSY/EACCES,
 *   which antivirus and OneDrive cause), so a crash or power cut never leaves a truncated file.
 * - snapshot: before a clip or rig file is overwritten, its previous version is copied into a history folder
 *   (<history>/<key>/<UTC time>.<ext>), keeping the newest 50; listSnapshots / restoreSnapshot read them back.
 * - readBodyLimited / ApiError / errorResponse: request bodies with a size cap and errors that become a JSON answer instead of a
 *   crashed server.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** The fs seam the helpers use (tests inject failures). */
export interface FsOps {
  openSync: typeof openSync;
  writeSync: (fd: number, data: Uint8Array) => number;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}
const realFs: FsOps = { openSync, writeSync: (fd, data) => writeSync(fd, data), fsyncSync, closeSync, renameSync, unlinkSync };

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let tempSeq = 0;

/** Writes `data` to `path` atomically (temp in the same folder + fsync + rename). Creates the folder. */
export function writeAtomic(path: string, data: string | Uint8Array, fs: FsOps = realFs, retries = 8): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && statSync(path).isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: "EISDIR", path });
  const temp = resolve(dirname(path), `.${basename(path)}.${process.pid}.${Date.now().toString(36)}${(tempSeq++).toString(36)}.tmp`);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  try {
    const fd = fs.openSync(temp, "w");
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes.subarray(off));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!RETRY_CODES.has(code) || attempt >= retries) throw error;
        pause(Math.min(25 * 2 ** attempt, 400));
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // the temp file may not exist
    }
    throw error;
  }
}

export const HISTORY_KEEP = 50;
const SNAPSHOT_NAME = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d+))?(\..+)?$/;

export interface Snapshot {
  id: string;
  /** ISO time the snapshot was taken. */
  time: string;
  size: number;
}

/** The snapshot folder of one file: `<historyDir>/<key>` (key = a relative path made of safe segments). */
export function snapshotFolder(historyDir: string, key: string): string {
  const folder = resolve(historyDir, key);
  if (!folder.startsWith(resolve(historyDir) + sep) || key.split(/[\\/]/).some((s) => !s || s === "." || s === "..")) throw new ApiError(`bad history key ${key}`);
  return folder;
}

const extOf = (file: string): string => {
  const m = /(\.[A-Za-z0-9]+\.json|\.[A-Za-z0-9]+)$/.exec(basename(file));
  return m ? m[1]! : "";
};

/**
 * Copies `file` (when it exists) into its snapshot folder under a time-stamped name and prunes to the newest `keep`.
 * Returns the snapshot id, or null when there was nothing to keep (no file, or the newest snapshot already has the same bytes).
 */
export function snapshot(file: string, historyDir: string, key: string, keep = HISTORY_KEEP, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  const folder = snapshotFolder(historyDir, key);
  mkdirSync(folder, { recursive: true });
  const existing = snapshotIds(folder);
  const current = readFileSync(file);
  const newest = existing[existing.length - 1];
  if (newest && readFileSync(resolve(folder, newest)).equals(current)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const ext = extOf(file);
  let id = `${stamp}${ext}`;
  for (let n = 2; existing.includes(id) || existsSync(resolve(folder, id)); n++) id = `${stamp}-${n}${ext}`;
  writeAtomic(resolve(folder, id), current);
  const all = snapshotIds(folder);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    try {
      unlinkSync(resolve(folder, old));
    } catch {
      // pruning is best effort
    }
  }
  return id;
}

function snapshotIds(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const sortKey = (id: string): string => {
    const m = SNAPSHOT_NAME.exec(id)!;
    return `${m[1]}-${(m[2] ?? "1").padStart(6, "0")}`;
  };
  return readdirSync(folder)
    .filter((f) => SNAPSHOT_NAME.test(f))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** The snapshots of one file, newest first. */
export function listSnapshots(historyDir: string, key: string): Snapshot[] {
  const folder = snapshotFolder(historyDir, key);
  return snapshotIds(folder)
    .reverse()
    .map((id) => {
      const m = SNAPSHOT_NAME.exec(id)!;
      const [d, t] = m[1]!.split("T") as [string, string];
      const [hh, mm, ss, ms] = t.replace(/Z$/, "").split("-");
      return { id, time: `${d}T${hh}:${mm}:${ss}.${ms}Z`, size: statSync(resolve(folder, id)).size };
    });
}

/** Restores snapshot `id` over `file`; the current file is snapshotted first, so a restore can itself be undone. */
export function restoreSnapshot(file: string, historyDir: string, key: string, id: string, keep = HISTORY_KEEP): { restored: string; backup: string | null; text: string } {
  const folder = snapshotFolder(historyDir, key);
  if (!SNAPSHOT_NAME.test(id) || !existsSync(resolve(folder, id))) throw new ApiError(`no snapshot ${id} of ${key}`, 404);
  const bytes = readFileSync(resolve(folder, id));
  const backup = snapshot(file, historyDir, key, keep);
  writeAtomic(file, bytes);
  return { restored: id, backup, text: bytes.toString("utf8") };
}

export const MB = 1 << 20;

/** Reads a request body up to `limit` bytes; a bigger body is drained and refused with 413. */
export function readBodyLimited(req: NodeJS.ReadableStream, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      if (!over) chunks.push(c);
    });
    req.on("end", () => (over ? fail(new ApiError(`request body is ${(size / MB).toFixed(1)} MB; the limit for this request is ${(limit / MB).toFixed(0)} MB`, 413)) : ok(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (e: Error) => fail(new ApiError(`request failed while reading: ${e.message}`, 400)));
    req.on("aborted", () => fail(new ApiError("request aborted by the browser", 400)));
  });
}

/** Parses JSON or throws a 400 that says so. */
export function parseJson<T = unknown>(text: string, what = "request body"): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ApiError(`${what} is not valid JSON (${error instanceof Error ? error.message : String(error)})`, 400);
  }
}

const FS_MESSAGES: Record<string, [number, string]> = {
  ENOSPC: [507, "the disk is full"],
  EDQUOT: [507, "the disk quota is exceeded"],
  EACCES: [500, "permission denied (is the file read-only or open in another program?)"],
  EPERM: [500, "the operation was not permitted (is the file read-only, locked by antivirus/OneDrive, or open in another program?)"],
  EBUSY: [500, "the file is busy (locked by another program, antivirus or OneDrive)"],
  EISDIR: [500, "a folder is in the way of the file"],
  EROFS: [500, "the file system is read-only"],
  EMFILE: [503, "too many open files"]
};

/** Maps any thrown value to an HTTP status and a JSON body that says what went wrong. */
export function errorResponse(error: unknown, fallbackStatus = 500): { status: number; body: Record<string, unknown> } {
  if (error instanceof ApiError) return { status: error.status, body: { error: error.message, ...error.extra } };
  const e = error as NodeJS.ErrnoException;
  const known = e?.code ? FS_MESSAGES[e.code] : undefined;
  if (known) return { status: known[0], body: { error: `Could not write ${e.path ? basename(e.path) : "the file"}: ${known[1]} [${e.code}]`, code: e.code } };
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : fallbackStatus;
  return { status, body: { error: error instanceof Error ? error.message : String(error) } };
}
