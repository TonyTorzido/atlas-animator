/*
 * Atlas Animator editor: the autosave folder (Node; used by the dev server).
 *
 * packages/animator-editor/autosave/<clip>/<id>.<flags>.<outfit>.json, newest 30 per clip. Everything is asynchronous
 * (the editor's save request never holds up the server's other requests), writes go to a temp file and are renamed in
 * place so a crash mid-write never leaves a half version, and a payload identical to the newest version is not stored twice.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AUTOSAVE_CLIP,
  AUTOSAVE_FORMAT,
  AUTOSAVE_KEEP,
  fingerprint,
  flagsOf,
  parseVersionFile,
  pruneVersions,
  sortVersions,
  versionFile,
  versionId,
  type AutosavePayload,
  type VersionInfo
} from "./autosaveModel.js";

export class AutosaveError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export function validPayload(raw: unknown): AutosavePayload {
  const p = raw as Partial<AutosavePayload> | null;
  if (!p || typeof p !== "object" || p.format !== AUTOSAVE_FORMAT) throw new AutosaveError(`expected ${AUTOSAVE_FORMAT}`);
  if (typeof p.clip !== "string" || !AUTOSAVE_CLIP.test(p.clip)) throw new AutosaveError("bad clip name");
  if (typeof p.outfit !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(p.outfit)) throw new AutosaveError("bad outfit id");
  if (!p.clipData || typeof p.clipData !== "object" || typeof (p.clipData as { duration?: unknown }).duration !== "number") throw new AutosaveError("clipData is not a clip");
  if (p.rig !== undefined && (typeof p.rig !== "object" || p.rig === null || typeof p.rig.document !== "string")) throw new AutosaveError("bad rig part");
  return p as AutosavePayload;
}

export function createAutosaveStore(dir: string, keep = AUTOSAVE_KEEP) {
  const clipDir = (clip: string): string => {
    if (!AUTOSAVE_CLIP.test(clip)) throw new AutosaveError("bad clip name");
    return resolve(dir, clip);
  };

  async function versions(clip: string): Promise<VersionInfo[]> {
    const folder = clipDir(clip);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const out: VersionInfo[] = [];
    for (const f of names) {
      const meta = parseVersionFile(f);
      if (!meta) continue;
      try {
        out.push({ ...meta, bytes: (await stat(resolve(clipDir(clip), f))).size });
      } catch {
        /* removed under us */
      }
    }
    return sortVersions(out);
  }

  const fileOf = (clip: string, v: VersionInfo) => resolve(clipDir(clip), versionFile(v.id, v.flags, v.outfit));
  const lastWrite = new Map<string, number>();

  return {
    versions,
    /** Names of the clips that have autosaves. */
    async clips(): Promise<string[]> {
      try {
        return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && AUTOSAVE_CLIP.test(e.name)).map((e) => e.name);
      } catch {
        return [];
      }
    },
    /** Writes one version (unless identical to the newest) and prunes to the newest `keep`. */
    async write(raw: unknown, now = new Date()): Promise<{ id: string; skipped: boolean; kept: number }> {
      const payload = validPayload(raw);
      const existing = await versions(payload.clip);
      const newest = existing[0];
      if (newest) {
        const prior = JSON.parse(await readFile(fileOf(payload.clip, newest), "utf8")) as AutosavePayload;
        if (fingerprint(prior) === fingerprint(payload)) return { id: newest.id, skipped: true, kept: existing.length };
      }
      // Versions of one clip are ordered by id: never reuse or go behind the newest one (a clock step, two saves in a millisecond).
      const time = Math.max(now.getTime(), (lastWrite.get(payload.clip) ?? 0) + 1, newest ? newest.time + 1 : 0);
      lastWrite.set(payload.clip, time);
      const id = versionId(new Date(time));
      const folder = clipDir(payload.clip);
      await mkdir(folder, { recursive: true });
      const target = resolve(folder, versionFile(id, flagsOf(payload), payload.outfit));
      const temp = `${target}.tmp`;
      await writeFile(temp, JSON.stringify({ ...payload, savedAt: new Date(time).toISOString() }));
      await rename(temp, target);
      const all = await versions(payload.clip);
      for (const old of pruneVersions(all, keep)) await unlink(fileOf(payload.clip, old)).catch(() => undefined);
      return { id, skipped: false, kept: Math.min(all.length, keep) };
    },
    async read(clip: string, id: string): Promise<AutosavePayload> {
      const v = (await versions(clip)).find((x) => x.id === id);
      if (!v) throw new AutosaveError(`no autosave ${id} of ${clip}`, 404);
      return JSON.parse(await readFile(fileOf(clip, v), "utf8")) as AutosavePayload;
    }
  };
}

export type AutosaveStore = ReturnType<typeof createAutosaveStore>;
