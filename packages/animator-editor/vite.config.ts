/*
 * Dev server for the Atlas Animator editor MVP. Besides the app it serves:
 * - GET  /repo/<path>       read-only repo files under the allowed roots (rigs, atlases, clip fixtures, saved clips);
 * - GET  /api/clips         saved clip file names in packages/animator-editor/clips;
 * - POST /api/clips/<file>  writes one clip file there (`<name>.clip.json`; the browser validated it with clipSchema). The X-Clip-Base header
 *                           (src/clipConflict.ts) makes it refuse with 409 when the file changed since the tab saw it (two tabs/windows);
 * - GET /api/poses, POST /api/poses/<name> { pose, png? }, DELETE /api/poses/<name>: the pose library (packages/animator-editor/poses, `<name>.pose.json` + `<name>.pose.png`);
 * - GET /api/smears, POST /api/smears/<name> { meta, png }, DELETE /api/smears/<name>: weapon smear attachments (packages/animator-editor/smears, `<name>.smear.json` + `<name>.smear.png`);
 * - GET /api/autosave (versions per clip + the saved files' times), POST /api/autosave (one version), GET /api/autosave/<clip>/<id>: the autosave folder
 *   (packages/animator-editor/autosave, git-ignored; the newest 30 versions per clip; all asynchronous);
 * - POST /api/apply         writes a clip into the canonical player rig document(s) (packages/animator/rigs/player);
 * - GET /api/rig/scripts?file=<rig>.anim.json: the `build-*.jsonl` scripts in that rig's folder as { files: [{ name, text }] } (read from the sandbox rig copy under ATLAS_EDITOR_DATA_DIR);
 * - GET /api/rig/hash?file=, POST /api/rig/save: Setup-mode edits of a rig document, applied through the document store's command log (src/rigSave.ts);
 * - GET/POST /api/clip-meta (clip-meta.json at the data root: { [clip]: { audio?: { file, name, offset, volume, muted } } }), POST/GET/DELETE /api/audio/<file>
 *   (the audio reference track of a clip, kept in <data>/audio as <clip>.wav|mp3; POST takes { data: base64 });
 * - GET /api/board, POST /api/board: the Clip board status file (packages/animator-editor/clips/board.json, { [clipId]: { done, rigHash, updated } });
 * - POST /api/rig/import-spine { file, spine, dryRun? }, POST /api/rig/import-spine/revert { file, backup }, POST /api/rig/export-spine { file }: the engine Spine
 *   importers (meshes, weights, linked meshes, deform, clips) and exporter on the saved rig document (src/spineApi.ts);
 * - POST /api/skins        writes the skins (and setup placeholders) of an open rig document: { file: packages/animator/rigs/<dir>/<name>.anim.json, skins, setup };
 * - POST /api/render        renders the contact sheet and the phone-size previews of a clip through the `animator render`
 *                           CLI into packages/animator-editor/exports/<rig>/<clip>/ (served under /repo/ too).
 * - GET /api/history?kind=clip|rig&file=, POST /api/history/restore { kind, file, id }: the rolling snapshots ("Versions…"). Every clip save/delete
 *   and every rig write (Setup save, Apply, Skins, Spine import/revert) first copies the previous file to clips/.history/ (newest 50 per file,
 *   user data, git-ignored); a restore snapshots the current file first (src/safeFs.ts).
 *
 * - /api/phone/* and /phone/<token>/*: "Phone preview", the clip live on the user's phone over the LAN (opt-in, token, read-only; src/phoneLive.ts).
 *
 * Every write is atomic (temp file + fsync + rename, src/safeFs.ts), every request body has a size cap, and every handler runs inside one
 * async router whose errors become a JSON { error } answer: a failed write never takes the server down.
 *
 * User data lives OUTSIDE the repo (src/dataDirs.ts): %USERPROFILE%\Documents\Atlas Animator\ by default, the Files dialog's "Data folder"
 * (after a restart), or ATLAS_EDITOR_DATA_DIR (demo and QA runs use a temp folder). Clips, history, board files, poses, smears, autosave,
 * exports and the user's rig working copies (rigs/) all live there; the repo's packages/animator/rigs are the stock rigs (src/rigStore.ts):
 * reads prefer the user copy, the first write copies a stock rig folder in, and nothing writes the repo except the explicit Publish.
 * - GET /api/data, POST /api/data/location { dir|null }, POST /api/data/backup, POST /api/data/restore { name }: Files dialog (src/userData.ts);
 * - GET /api/rigs/stock[?dir=], POST /api/rigs/stock { dir, choice: "theirs"|"mine" }: "a newer stock version of this rig exists";
 * - GET /api/publish?kind=rig|clip&name=, POST /api/publish { kind, name }: Ship's "Publish to project folder" (preview, then copy; no git).
 *   Rigs the repo does not have answer 400 with the register hint; every publish updates packages/animator/publish-manifest.json.
 * - GET /api/publish/validate[?rig=]: Ship's "Validate published": runs the Publish validator (animator validate-publish) on the repo.
 * - GET/POST /api/keymap (keymap.json at the data root: { keymapVersion: 1, bindings: { <action>: "J" or "J / Alt+J" } }, the rebound keyboard shortcuts; Help > Keyboard shortcuts);
 * - GET /api/transitions?rig=, POST /api/transitions { rig, graph|null } (transitions.json at the data root: { transitionsVersion: 1, rigs: { [rig]: graph } }), the Transitions panel's clip state graphs;
 * - GET /api/help/guide (the user guide Markdown), GET /api/help/shot/<name>.png (its screenshots), GET /api/help/about (version, commit, data folder, log file): the Help menu.
 * On start the dev server migrates the old in-worktree data once (zip backup first, nothing deleted) and makes the daily backup zip.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { addParts, createRig, deleteRig, renameRig, type CreateRequest, type PartIn } from "./src/rigCreate.js";
import { rigAbs, rigHash, rigsDirOf, rigTextHash, saveRig, SaveError, type SaveRequest } from "./src/rigSave.js";
import { KEYMAP_VERSION, parseChord } from "./src/keymapModel.js";
import { MIGRATE_FROM_ENV, resolveDataDirs, RIGS_REL } from "./src/dataDirs.js";
import { createRigStore } from "./src/rigStore.js";
import { planTransfers } from "./src/swagTransfer.js";
import { formatReport, readPublishManifest, validatePublish } from "../animator/src/cli/validatePublish.js";
import { autoBackup, backupNow, listBackups, migrateWorktreeData, readMigrations, restoreBackup, setDataLocation } from "./src/userData.js";
import { exportSpineFull, importSpineIntoRig, revertSpineImport, SpineApiError } from "./src/spineApi.js";
import { handleRefsApi } from "./src/refsApi.js";
import { createAutosaveStore, AutosaveError } from "./src/autosaveStore.js";
import { createPhoneLive } from "./src/phoneLive.js";
import { CLIP_NAME, allowRigDocument, isRigFile, mergeClipIntoRigText, mergeSkinsIntoRigText, SKIN_RIG_PATH, PHONE_SCALES, renderPlan, rigPath } from "./src/exportApi.js";
import { ApiError, errorResponse, listSnapshots, MB, parseJson, readBodyLimited, restoreSnapshot, snapshot, writeAtomic } from "./src/safeFs.js";
import { CLIP_BASE_HEADER, checkClipBase, textHash } from "./src/clipConflict.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const dirs = resolveDataDirs(here, repoRoot);
const { saveDir, poseDir, smearDir, autosaveDir, dataDir, historyDir } = dirs;
const autosave = createAutosaveStore(autosaveDir);
const READ_ROOTS = dirs.readRoots;
/** The user's rig working copies over the stock rigs (src/rigStore.ts). */
const publishEnv = process.env["ATLAS_EDITOR_PUBLISH_DIR"]?.trim();
if (publishEnv && !isAbsolute(publishEnv)) throw new Error(`ATLAS_EDITOR_PUBLISH_DIR must be an absolute folder path (got ${publishEnv})`);
/** Publish writes into this project folder (ATLAS_EDITOR_PUBLISH_DIR); with none set Publish is off. */
const publishRoot: string | null = publishEnv ? resolve(publishEnv) : null;
const rigs = createRigStore({ publishRoot, stockRoot: dirs.stockRoot, rigsDir: dirs.rigsDir, backupsDir: dirs.backupsDir, log: (l) => console.log(l) });
const rootFile = (name: string): string => resolve(dataDir, name);
let startupNote: string | null = null;
const TYPES: Record<string, string> = { ".json": "application/json", ".png": "image/png", ".gif": "image/gif" };
const run = promisify(execFile);
/** Request body caps: small JSON, clips and documents, and requests that carry PNG images or a whole Spine export. */
const LIMIT = { small: 4 * MB, clip: 32 * MB, doc: 64 * MB, images: 128 * MB } as const;
const send = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};
/** Answers any error as JSON (never throws: the last line of defence that keeps the server up). */
const fail = (res: ServerResponse, error: unknown, fallback = 400): void => {
  try {
    const { status, body } = errorResponse(error, fallback);
    if (status >= 500) console.error(`[animator-editor] ${String(body["error"])}`);
    if (res.headersSent || res.writableEnded) res.destroy();
    else send(res, status, body);
  } catch {
    // nothing left to do
  }
};
const SMEAR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const POSE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;
const CLIP_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/;
const AUDIO_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.(wav|mp3)$/i;
const CLIP_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.clip\.json$/;
const readJsonFile = <T>(file: string, fallback: T): T => (existsSync(file) ? parseJson<T>(readFileSync(file, "utf8"), file.split(sep).pop()) : fallback);

/**
 * A rig document path (`packages/animator/rigs/<dir>/<name>.anim.json`) as a file, or a 400. Reads use the user copy when there is one,
 * else the stock rig; `write` first copies a stock rig folder into the user rigs, so a write never touches the repo.
 */
function rigDocPath(file: unknown, write = false): string {
  const rel = String(file ?? "");
  if (!rel.endsWith(".anim.json")) throw new ApiError(`expected a rig document under ${RIGS_REL} ending in .anim.json`);
  const root = write ? rigs.writeRoot(rel) : rigs.readRoot(rel);
  const path = rigAbs(root, rel);
  if (!path.startsWith(rigsDirOf(root) + sep)) throw new ApiError(`expected a rig document under ${RIGS_REL} ending in .anim.json`);
  return path;
}
/** The snapshot folder key of a rig document: rigs/<path below the rigs folder> (the same for the user copy and the stock rig). */
const rigKey = (path: string): string => {
  for (const root of [dirs.rigsDir, resolve(dirs.stockRoot, RIGS_REL)]) if (path.startsWith(root + sep)) return `rigs/${path.slice(root.length + 1).split(sep).join("/")}`;
  throw new ApiError("not a rig file");
};
const snapshotRig = (path: string): void => void snapshot(path, historyDir, rigKey(path));
const snapshotClip = (name: string): void => void snapshot(resolve(saveDir, name), historyDir, `clips/${name}`);
const clipFile = (name: string): string => {
  if (!CLIP_FILE.test(name)) throw new ApiError("expected <name>.clip.json");
  return resolve(saveDir, name);
};

async function route(req: IncomingMessage, res: ServerResponse, url: URL, next: () => void): Promise<void> {
  if (url.pathname.startsWith("/api/")) for (const r of rigs.list()) allowRigDocument(r.document);
  if (url.pathname.startsWith("/api/help/")) return helpRoute(req, res, url);
  if (url.pathname.startsWith("/api/data") || url.pathname.startsWith("/api/rigs/stock") || url.pathname === "/api/publish" || url.pathname === "/api/publish/validate" || url.pathname === "/api/publish/config") return dataRoute(req, res, url);
  const body = async <T>(limit: number): Promise<T> => parseJson<T>(await readBodyLimited(req, limit));
  if (req.method === "GET" && url.pathname.startsWith("/repo/")) {
    const file = dirs.mapRepoPath(decodeURIComponent(url.pathname.slice("/repo/".length)));
    if (!READ_ROOTS.some((root) => file.startsWith(root)) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(file));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/clips") {
    return send(res, 200, existsSync(saveDir) ? readdirSync(saveDir).filter((f) => CLIP_FILE.test(f)).sort() : []);
  }
  // Clip board: delete one saved clip file (the Clip board's Delete; a clip that was never saved answers 404, which is fine). Snapshotted first.
  if (req.method === "DELETE" && url.pathname.startsWith("/api/clips/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/clips/".length));
    const file = clipFile(name);
    if (!existsSync(file)) return send(res, 404, { error: `${name} is not saved` });
    snapshotClip(name);
    unlinkSync(file);
    return send(res, 200, { ok: true });
  }
  // Clip board: custom slots (clips/board-config.json) and where the clip files live.
  if (url.pathname === "/api/board-config" && (req.method === "GET" || req.method === "POST")) {
    const file = rootFile("board-config.json");
    if (req.method === "GET") return send(res, 200, { ...readJsonFile<Record<string, unknown>>(file, { slots: [] }), clipsDir: saveDir, dataDir });
    const config = await body<{ slots?: { id?: unknown }[] }>(LIMIT.small);
    const ok = !!config && Array.isArray(config.slots) && config.slots.every((s) => typeof s?.id === "string" && CLIP_ID.test(s.id));
    if (!ok) return send(res, 400, { error: "board-config.json is { slots: [{ id, label, category, ... }] }" });
    writeAtomic(file, JSON.stringify({ slots: config.slots }, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/clips/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/clips/".length));
    const file = clipFile(name);
    const text = await readBodyLimited(req, LIMIT.clip);
    if (typeof parseJson<{ duration?: unknown }>(text, "the clip")?.duration !== "number") throw new ApiError("expected <name>.clip.json with a clip JSON body");
    const header = req.headers[CLIP_BASE_HEADER];
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    const verdict = checkClipBase(name, Array.isArray(header) ? header[0] : header, current);
    if (!verdict.ok) return send(res, 409, { error: verdict.message, conflict: true, current: verdict.current });
    if (current !== text) snapshotClip(name);
    writeAtomic(file, text);
    return send(res, 200, { path: `packages/animator-editor/clips/${name}`, hash: textHash(text) });
  }
  if (req.method === "GET" && url.pathname === "/api/poses") {
    return send(res, 200, existsSync(poseDir) ? readdirSync(poseDir).filter((f) => f.endsWith(".pose.json")).map((f) => f.slice(0, -".pose.json".length)).filter((n) => POSE_NAME.test(n)).sort() : []);
  }
  // Pose versions (): every replace or delete first snapshots the pose file, so an accidental overwrite can be restored.
  // GET /api/pose-history (names of deleted poses with versions), GET ?name= (versions of one pose), POST /restore { name, id }.
  if (req.method === "GET" && url.pathname === "/api/pose-history") {
    const name = url.searchParams.get("name");
    if (name) {
      if (!POSE_NAME.test(name)) throw new ApiError("bad pose name");
      return send(res, 200, { name, versions: listSnapshots(historyDir, `poses/${name}.pose.json`) });
    }
    const base = resolve(historyDir, "poses");
    const deleted = (existsSync(base) ? readdirSync(base) : []).filter((f) => f.endsWith(".pose.json")).map((f) => f.slice(0, -".pose.json".length)).filter((n) => POSE_NAME.test(n) && !existsSync(resolve(poseDir, `${n}.pose.json`)));
    return send(res, 200, { deleted: deleted.filter((n) => listSnapshots(historyDir, `poses/${n}.pose.json`).length) });
  }
  if (req.method === "POST" && url.pathname === "/api/pose-history/restore") {
    const { name, id } = await body<{ name?: string; id?: string }>(LIMIT.small);
    if (!POSE_NAME.test(String(name ?? ""))) throw new ApiError("bad pose name");
    const file = resolve(poseDir, `${name}.pose.json`);
    if (readJsonFile<{ builtin?: boolean }>(file, {}).builtin === true) return send(res, 403, { error: `${name} is a built-in pose (read-only)` });
    const out = restoreSnapshot(file, historyDir, `poses/${name}.pose.json`, String(id ?? ""));
    return send(res, 200, { restored: out.restored, backup: out.backup });
  }
  if ((req.method === "POST" || req.method === "DELETE") && url.pathname.startsWith("/api/poses/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/poses/".length));
    if (!POSE_NAME.test(name)) throw new ApiError("bad pose name");
    const json = resolve(poseDir, `${name}.pose.json`);
    const png = resolve(poseDir, `${name}.pose.png`);
    // Built-in (starter) poses ship with the editor: read-only, never overwritten or deleted through the API.
    if (readJsonFile<{ builtin?: boolean }>(json, {}).builtin === true) return send(res, 403, { error: `${name} is a built-in pose (read-only)` });
    if (req.method === "DELETE") {
      if (!existsSync(json) && !existsSync(png)) return send(res, 404, { error: `no pose named ${name}` });
      snapshot(json, historyDir, `poses/${name}.pose.json`);
      for (const f of [json, png]) if (existsSync(f)) unlinkSync(f);
      return send(res, 200, { deleted: name });
    }
    const b = await body<{ pose?: { format?: string; name?: string; builtin?: boolean }; png?: string }>(LIMIT.clip);
    if (b.pose?.builtin) throw new ApiError("built-in poses are not made through the API");
    if (b.pose?.format !== "atlas-pose@1" || b.pose.name !== name) throw new ApiError("expected { pose: atlas-pose@1 named like the URL, png? }");
    snapshot(json, historyDir, `poses/${name}.pose.json`);
    writeAtomic(json, `${JSON.stringify(b.pose, null, 2)}\n`);
    const m = /^data:image\/png;base64,(.+)$/.exec(b.png ?? "");
    if (m) writeAtomic(png, Buffer.from(m[1]!, "base64"));
    return send(res, 200, { path: `packages/animator-editor/poses/${name}.pose.json`, png: !!m });
  }
  if (url.pathname === "/api/autosave" || url.pathname.startsWith("/api/autosave/")) {
    try {
      if (req.method === "POST" && url.pathname === "/api/autosave") return send(res, 200, await autosave.write(await body(LIMIT.images)));
      if (req.method === "GET" && url.pathname === "/api/autosave") {
        const clips: Record<string, unknown> = {};
        const savedClips: Record<string, number> = {};
        for (const name of await autosave.clips()) {
          clips[name] = await autosave.versions(name);
          const file = resolve(saveDir, `${name}.clip.json`);
          if (existsSync(file)) savedClips[name] = statSync(file).mtimeMs;
        }
        const rigTimes: Record<string, number> = {};
        for (const [d, folder] of rigs.folders()) for (const f of readdirSync(folder)) if (f.endsWith(".anim.json")) rigTimes[`packages/animator/rigs/${d}/${f}`] = statSync(resolve(folder, f)).mtimeMs;
        return send(res, 200, { clips, saved: { clips: savedClips, rigs: rigTimes } });
      }
      const m = /^\/api\/autosave\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && m) return send(res, 200, await autosave.read(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)));
      return send(res, 404, { error: "not found" });
    } catch (error) {
      throw error instanceof AutosaveError ? new ApiError(error.message, error.status) : error;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/smears") {
    return send(res, 200, existsSync(smearDir) ? readdirSync(smearDir).filter((f) => f.endsWith(".smear.json")).map((f) => f.slice(0, -".smear.json".length)).filter((n) => SMEAR_NAME.test(n)).sort() : []);
  }
  if ((req.method === "POST" || req.method === "DELETE") && url.pathname.startsWith("/api/smears/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/smears/".length));
    if (!SMEAR_NAME.test(name)) throw new ApiError("bad smear name");
    const json = resolve(smearDir, `${name}.smear.json`);
    const png = resolve(smearDir, `${name}.smear.png`);
    if (req.method === "DELETE") {
      if (!existsSync(json) && !existsSync(png)) return send(res, 404, { error: `no smear named ${name}` });
      for (const f of [json, png]) if (existsSync(f)) unlinkSync(f);
      return send(res, 200, { deleted: name });
    }
    const b = await body<{ meta?: { format?: string; name?: string }; png?: string }>(LIMIT.doc);
    const m = /^data:image\/png;base64,(.+)$/.exec(b.png ?? "");
    if (b.meta?.format !== "atlas-smear@1" || b.meta.name !== name || !m) throw new ApiError("expected { meta: atlas-smear@1 named like the URL, png: data URL }");
    writeAtomic(png, Buffer.from(m[1]!, "base64"));
    writeAtomic(json, JSON.stringify(b.meta, null, 2) + "\n");
    return send(res, 200, { path: `packages/animator-editor/smears/${name}.smear.json` });
  }
  if (req.method === "POST" && url.pathname === "/api/apply") {
    const { files, clip, data } = await body<{ files: string[]; clip: string; data: Record<string, unknown> }>(LIMIT.doc);
    if (!CLIP_NAME.test(clip) || !Array.isArray(files) || !files.length || !files.every(isRigFile)) throw new ApiError("expected { files: [fixture rig file names], clip, data }");
    // Merge every file first (a bad document fails before anything is written), then snapshot and write each.
    const merged = files.map((file) => {
      const rel = rigPath(file);
      const path = rigDocPath(rel, true);
      return { rel, path, text: mergeClipIntoRigText(readFileSync(path, "utf8"), clip, data) };
    });
    for (const { path, text } of merged) {
      snapshotRig(path);
      writeAtomic(path, text);
    }
    // The new hash of each rig file, so the editor's Setup / skins saves keep their conflict check after an Apply.
    return send(res, 200, { files: merged.map((m) => m.rel), hashes: Object.fromEntries(merged.map((m) => [m.rel, rigTextHash(m.text)])) });
  }
  if (url.pathname === "/api/board" && (req.method === "GET" || req.method === "POST")) {
    const file = rootFile("board.json");
    if (req.method === "GET") return send(res, 200, readJsonFile(file, {}));
    const board = await body<Record<string, { done?: unknown; rigHash?: unknown; updated?: unknown }>>(LIMIT.small);
    const ok = !!board && typeof board === "object" && !Array.isArray(board) && Object.entries(board).every(([id, e]) => CLIP_ID.test(id) && typeof e?.done === "boolean" && typeof e?.rigHash === "string" && typeof e?.updated === "string");
    if (!ok) return send(res, 400, { error: "board.json is { [clipId]: { done: boolean, rigHash: string, updated: string } }" });
    writeAtomic(file, JSON.stringify(board, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  // Keyboard shortcut overrides (Batch 8b-2): only the actions the user rebound; hotkeys.ts applies them over the built-in table.
  if (url.pathname === "/api/keymap" && (req.method === "GET" || req.method === "POST")) {
    const file = rootFile("keymap.json");
    if (req.method === "GET") return send(res, 200, readJsonFile(file, { keymapVersion: KEYMAP_VERSION, bindings: {} }));
    const map = await body<{ keymapVersion?: unknown; bindings?: Record<string, unknown> }>(LIMIT.small);
    const ok =
      !!map &&
      typeof map === "object" &&
      map.keymapVersion === KEYMAP_VERSION &&
      !!map.bindings &&
      typeof map.bindings === "object" &&
      !Array.isArray(map.bindings) &&
      Object.entries(map.bindings).every(([action, keys]) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(action) && typeof keys === "string" && keys.split(" / ").every((part) => parseChord(part) !== null));
    if (!ok) return send(res, 400, { error: 'keymap.json is { keymapVersion: 1, bindings: { <action>: "J" or "J / Alt+J" } }' });
    writeAtomic(file, JSON.stringify({ keymapVersion: KEYMAP_VERSION, bindings: map.bindings }, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  // Audio reference track (): per-clip metadata in clip-meta.json, the sound itself in <data>/audio. Not part of the clip file.
  if (url.pathname === "/api/clip-meta" && (req.method === "GET" || req.method === "POST")) {
    const file = rootFile("clip-meta.json");
    if (req.method === "GET") return send(res, 200, readJsonFile(file, {}));
    const meta = await body<Record<string, { audio?: { file?: unknown; name?: unknown; offset?: unknown; volume?: unknown; muted?: unknown } }>>(LIMIT.small);
    const ok =
      !!meta &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      Object.entries(meta).every(([id, m]) => {
        const a = m?.audio;
        return CLIP_ID.test(id) && (a === undefined || (typeof a.file === "string" && AUDIO_FILE.test(a.file) && typeof a.name === "string" && Number.isFinite(a.offset) && Number.isFinite(a.volume) && typeof a.muted === "boolean"));
      });
    if (!ok) return send(res, 400, { error: "clip-meta.json is { [clip]: { audio?: { file: <name>.wav|mp3, name, offset, volume, muted } } }" });
    writeAtomic(file, JSON.stringify(meta, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/api/audio/") && ["GET", "POST", "DELETE"].includes(req.method ?? "")) {
    const name = decodeURIComponent(url.pathname.slice("/api/audio/".length));
    if (!AUDIO_FILE.test(name)) throw new ApiError("audio files are <name>.wav or <name>.mp3");
    const file = resolve(dataDir, "audio", name);
    if (req.method === "GET") {
      if (!existsSync(file)) return send(res, 404, { error: `no audio ${name}` });
      res.setHeader("Content-Type", name.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
      res.setHeader("Cache-Control", "no-cache");
      res.end(readFileSync(file));
      return;
    }
    if (req.method === "DELETE") {
      if (existsSync(file)) unlinkSync(file);
      return send(res, 200, { deleted: name });
    }
    const { data } = await body<{ data?: string }>(LIMIT.images);
    if (typeof data !== "string" || !data) throw new ApiError("expected { data: base64 }");
    const bytes = Buffer.from(data, "base64");
    const wav = bytes.subarray(0, 4).toString("latin1") === "RIFF";
    const mp3 = bytes.subarray(0, 3).toString("latin1") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    if (!(name.toLowerCase().endsWith(".wav") ? wav : mp3)) throw new ApiError(`${name} is not a ${name.slice(-3).toLowerCase()} file`);
    mkdirSync(resolve(dataDir, "audio"), { recursive: true });
    writeAtomic(file, bytes);
    return send(res, 200, { file: name, bytes: bytes.length });
  }
  if (url.pathname === "/api/tween-marks" && (req.method === "GET" || req.method === "POST")) {
    // Which keys Arc in-betweens generated: { [clip]: [bone, time, value][] } (keeps them marked after a reload).
    const file = rootFile("tween-marks.json");
    if (req.method === "GET") return send(res, 200, readJsonFile(file, {}));
    const marks = await body<Record<string, unknown>>(LIMIT.clip);
    const ok = !!marks && typeof marks === "object" && !Array.isArray(marks) && Object.entries(marks).every(([id, rows]) => CLIP_ID.test(id) && Array.isArray(rows) && rows.every((r) => Array.isArray(r) && r.length === 3 && typeof r[0] === "string" && Number.isFinite(r[1]) && Number.isFinite(r[2])));
    if (!ok) return send(res, 400, { error: "tween-marks.json is { [clip]: [bone, time, value][] }" });
    writeAtomic(file, JSON.stringify(marks) + "\n");
    return send(res, 200, { ok: true });
  }
  // Clip transitions (Batch 12c): the state graph of each rig's clips, { transitionsVersion: 1, rigs: { [rig]: graph } } in transitions.json at the
  // data root. GET ?rig= answers { graph } (null when none); POST { rig, graph|null } replaces one rig's graph and leaves the others alone (atomic write).
  if (url.pathname === "/api/transitions" && (req.method === "GET" || req.method === "POST")) {
    const file = rootFile("transitions.json");
    const all = readJsonFile<{ transitionsVersion?: number; rigs?: Record<string, unknown> }>(file, {});
    const rigs = all.rigs && typeof all.rigs === "object" && !Array.isArray(all.rigs) ? all.rigs : {};
    if (req.method === "GET") {
      const rig = url.searchParams.get("rig") ?? "";
      if (!CLIP_ID.test(rig)) return send(res, 400, { error: "rig is a rig id like turned-l" });
      return send(res, 200, { graph: rigs[rig] ?? null });
    }
    const input = await body<{ rig?: unknown; graph?: unknown }>(LIMIT.small);
    const g = input?.graph as { format?: unknown; entry?: unknown; nodes?: unknown; edges?: unknown; path?: unknown } | null | undefined;
    const name = (v: unknown): boolean => typeof v === "string" && CLIP_ID.test(v);
    const ok =
      !!input &&
      typeof input.rig === "string" &&
      CLIP_ID.test(input.rig) &&
      (g === null ||
        (!!g &&
          typeof g === "object" &&
          g.format === "atlas-transitions@1" &&
          Array.isArray(g.nodes) &&
          g.nodes.length <= 200 &&
          g.nodes.every(name) &&
          Array.isArray(g.edges) &&
          g.edges.length <= 2000 &&
          g.edges.every((e: { from?: unknown; to?: unknown; blend?: unknown; condition?: unknown }) => name(e?.from) && name(e?.to) && Number.isFinite(e.blend) && typeof e.condition === "string") &&
          (g.entry === "" || name(g.entry)) &&
          Array.isArray(g.path) &&
          g.path.length <= 24 &&
          g.path.every(name)));
    if (!ok) return send(res, 400, { error: "POST { rig, graph } where graph is { format: atlas-transitions@1, entry, nodes: [clip], edges: [{ from, to, blend, condition }], path: [clip] }, or graph null to clear" });
    const next = { ...rigs };
    if (g === null) delete next[input.rig as string];
    else next[input.rig as string] = g;
    writeAtomic(file, JSON.stringify({ transitionsVersion: 1, rigs: next }, null, 2) + "\n");
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/rig/scripts") {
    const rigFile = rigDocPath(url.searchParams.get("file"));
    const folder = dirname(rigFile);
    const files = existsSync(folder)
      ? readdirSync(folder)
          .filter((n) => /^build-[A-Za-z0-9_.-]*\.jsonl$/.test(n))
          .sort()
          .map((name) => ({ name, text: readFileSync(resolve(folder, name), "utf8") }))
      : [];
    return send(res, 200, { files });
  }
  if (req.method === "GET" && url.pathname === "/api/rigs") return send(res, 200, { rigs: rigs.list() });
  if (req.method === "POST" && (url.pathname === "/api/rig/create" || url.pathname === "/api/rig/parts")) {
    const b = await body<CreateRequest & { parts?: PartIn[] }>(LIMIT.images);
    if (url.pathname === "/api/rig/create") {
      if (rigs.folders().has(String(b.id ?? ""))) throw new ApiError(`a rig folder '${String(b.id)}' already exists`, 409);
      const entry = createRig(rigs.user, b, dirs.stockRoot);
      allowRigDocument(entry.document);
      return send(res, 200, { rig: entry });
    }
    const id = String(b.id ?? "");
    const doc = rigs.list().find((r) => r.id === id)?.document;
    if (doc) snapshotRig(rigDocPath(doc, true));
    return send(res, 200, addParts(rigs.user, id, b.parts ?? [], { replace: (b as { replace?: boolean }).replace === true }));
  }
  if (req.method === "POST" && url.pathname === "/api/rig/rename") {
    const b = await body<{ id?: string; label?: string }>(LIMIT.images);
    rigs.ensureOwned(String(b.id ?? ""));
    return send(res, 200, { rig: renameRig(rigs.user, String(b.id ?? ""), String(b.label ?? "")) });
  }
  if (req.method === "POST" && url.pathname === "/api/rig/delete") {
    const b = await body<{ id?: string }>(LIMIT.images);
    deleteRig(rigs.user, String(b.id ?? ""), snapshotRig);
    return send(res, 200, { deleted: String(b.id ?? "") });
  }
  if (req.method === "GET" && url.pathname === "/api/rig/hash") {
    const file = url.searchParams.get("file") ?? "";
    return send(res, 200, { hash: rigHash(rigs.readRoot(file), file) });
  }
  if (req.method === "POST" && url.pathname === "/api/rig/save") {
    const b = await body<SaveRequest>(LIMIT.images);
    const path = rigDocPath(b?.file, true);
    snapshotRig(path);
    return send(res, 200, saveRig(rigs.user, b));
  }
  if (req.method === "POST" && /^\/api\/rig\/(import-spine(\/revert)?|export-spine)$/.test(url.pathname)) {
    const b = await body<{ file: string; spine?: string; dryRun?: boolean; backup?: string; base?: string | null }>(LIMIT.images);
    try {
      if (url.pathname === "/api/rig/import-spine") {
        if (b.dryRun !== true) snapshotRig(rigDocPath(b.file, true));
        return send(res, 200, importSpineIntoRig(b.dryRun === true ? rigs.readRoot(b.file) : rigs.user, b.file, String(b.spine ?? ""), b.dryRun === true));
      }
      if (url.pathname === "/api/rig/import-spine/revert") {
        snapshotRig(rigDocPath(b.file, true));
        return send(res, 200, revertSpineImport(rigs.user, b.file, String(b.backup ?? "")));
      }
      // : the export is bound to the rig revision the tab shows; a file that changed since is refused instead of exported.
      if (typeof b.base === "string" && rigHash(rigs.readRoot(b.file), b.file) !== b.base) throw new ApiError("the rig file changed since this tab read it: reload, then export", 409);
      return send(res, 200, exportSpineFull(rigs.readRoot(b.file), b.file, resolve(dirs.exportsDir, "spine", String(b.file).split("/").pop()!.replace(/\.anim\.json$/, ""))));
    } catch (error) {
      throw error instanceof SpineApiError ? new ApiError(error.message, 400) : error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/skins") {
    const { file, skins, setup, base } = await body<{ file: string; skins: Record<string, unknown>; setup?: Record<string, string | null>; base?: string | null }>(LIMIT.doc);
    if (typeof file !== "string" || !SKIN_RIG_PATH.test(file) || !skins || typeof skins !== "object") throw new ApiError("expected { file: packages/animator/rigs/<dir>/<name>.anim.json, skins, base? }");
    const path = rigDocPath(file, true);
    const current = readFileSync(path, "utf8");
    // Compare-and-swap (): a rig file that changed since the editor read it (another tab, a Setup save elsewhere) is not overwritten.
    if (typeof base === "string" && rigTextHash(current) !== base) return send(res, 409, { error: `${file.split("/").pop()} changed on disk since this tab read it`, current: rigTextHash(current) });
    const text = mergeSkinsIntoRigText(current, skins, setup);
    snapshotRig(path);
    writeAtomic(path, text);
    return send(res, 200, { file, hash: rigTextHash(text) });
  }
  // POST /api/swag/import { file, skin?, pieces: [{ rigSlot, width, height, x, y, rotation, scale? }] } -> { transfers: { [rigSlot]: { attachment, report } }, revision }:
  // the mesh / weight transfer plan for a swag item against the rig as it is on disk (Batch 10b, PL-04). Nothing is written; the client folds `attachment` into the item batch.
  if (req.method === "POST" && url.pathname === "/api/swag/import") {
    const b = await body<{ file?: string; skin?: string; pieces?: { rigSlot: string; width: number; height: number; x: number; y: number; rotation: number; scale?: number }[] }>(LIMIT.doc);
    if (typeof b.file !== "string" || !SKIN_RIG_PATH.test(b.file) || !Array.isArray(b.pieces)) throw new ApiError("expected { file: packages/animator/rigs/<dir>/<name>.anim.json, pieces: [...] }");
    const text = readFileSync(rigAbs(rigs.readRoot(b.file), b.file), "utf8");
    const pieces = b.pieces.map((p) => ({ rigSlot: String(p.rigSlot), width: Number(p.width), height: Number(p.height), x: Number(p.x) || 0, y: Number(p.y) || 0, rotation: Number(p.rotation) || 0, scale: Number(p.scale) || 1 }));
    if (pieces.some((p) => !(p.width > 0) || !(p.height > 0))) throw new ApiError("every piece needs a width and a height");
    return send(res, 200, { transfers: planTransfers(JSON.parse(text), pieces, String(b.skin ?? "")), revision: rigTextHash(text) });
  }
  // Recently deleted clips (): every clip with snapshots under clips/.history/ whose file is gone, newest deletion first.
  if (req.method === "GET" && url.pathname === "/api/history/deleted") {
    const base = resolve(historyDir, "clips");
    const out: { file: string; time: string; versions: number }[] = [];
    for (const name of existsSync(base) ? readdirSync(base) : []) {
      if (!CLIP_FILE.test(name) || existsSync(resolve(saveDir, name))) continue;
      const list = listSnapshots(historyDir, `clips/${name}`);
      if (list.length) out.push({ file: name, time: list[0]!.time, versions: list.length });
    }
    out.sort((a, b) => (a.time < b.time ? 1 : -1));
    return send(res, 200, { deleted: out, keep: 50 });
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    const kind = url.searchParams.get("kind");
    const file = url.searchParams.get("file") ?? "";
    if (kind === "clip") {
      clipFile(file);
      return send(res, 200, { kind, file, versions: listSnapshots(historyDir, `clips/${file}`) });
    }
    if (kind === "rig") return send(res, 200, { kind, file, versions: listSnapshots(historyDir, rigKey(rigDocPath(file))) });
    throw new ApiError("expected ?kind=clip|rig&file=");
  }
  if (req.method === "POST" && url.pathname === "/api/history/restore") {
    const { kind, file, id } = await body<{ kind?: string; file?: string; id?: string }>(LIMIT.small);
    if (kind === "clip") {
      const path = clipFile(String(file ?? ""));
      const out = restoreSnapshot(path, historyDir, `clips/${file}`, String(id ?? ""));
      return send(res, 200, { restored: out.restored, backup: out.backup, hash: textHash(out.text) });
    }
    if (kind === "rig") {
      const path = rigDocPath(file, true);
      const out = restoreSnapshot(path, historyDir, rigKey(path), String(id ?? ""));
      return send(res, 200, { restored: out.restored, backup: out.backup, hash: rigHash(rigs.user, String(file)) });
    }
    throw new ApiError("expected { kind: clip|rig, file, id }");
  }
  if (req.method === "POST" && url.pathname === "/api/render") {
    const { file, clip, scales, background } = await body<{ file: string; clip: string; scales?: unknown; background?: unknown }>(LIMIT.small);
    const useScales = Array.isArray(scales) && scales.length > 0 && scales.length <= 3 && scales.every((n) => typeof n === "number" && n >= 0.1 && n <= 2) ? (scales as number[]) : [...PHONE_SCALES];
    const bg = typeof background === "string" && /^[0-9a-fA-F]{6}$/.test(background) ? background : undefined;
    if (!CLIP_NAME.test(clip) || !isRigFile(file)) throw new ApiError("expected { file: fixture rig file name, clip }");
    const docPath = rigDocPath(rigPath(file));
    const canvas = (JSON.parse(readFileSync(docPath, "utf8")) as { canvas: { width: number; height: number; originX: number; originY: number } }).canvas;
    const rel = `packages/animator-editor/exports/${file.replace(/.anim.json$/, "")}/${clip}`;
    const outAbs = dirs.mapRepoPath(rel);
    mkdirSync(outAbs, { recursive: true });
    const tsx = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
    const cli = resolve(repoRoot, "packages/animator/src/cli/animator.ts");
    const out: { scale: number; sheet: string; gif: string; log: string }[] = [];
    for (const scale of useScales) {
      const plan = renderPlan({ doc: docPath.split(sep).join("/"), clip, scale, canvas, outDir: outAbs.split(sep).join("/"), ...(bg ? { background: bg } : {}) });
      const { stdout } = await run(process.execPath, [tsx, cli, ...plan.args], { cwd: repoRoot, timeout: 180_000, maxBuffer: 16 << 20 });
      out.push({ scale, sheet: `${rel}/${clip}-${scale}-sheet.png`, gif: `${rel}/${clip}-${scale}.gif`, log: stdout.trim().split("\n")[0] ?? "" });
    }
    return send(res, 200, { files: out });
  }
  next();
}

/** Migration (once per worktree; never for an ATLAS_EDITOR_DATA_DIR run unless ATLAS_EDITOR_MIGRATE_FROM says so) and the daily backup. */
async function startup(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  console.log(`[animator-editor] user data folder: ${dataDir} (${dirs.source})`);
  if (dirs.source === "sandbox") {
    const bar = "=".repeat(94);
    console.warn(`
${bar}
  [animator-editor] SANDBOX RUN: this editor was not started by the Atlas Animator launcher.
  It uses ${dataDir}
  and NOT the user's real files; nothing is migrated. To use the real data, run tools/atlas-animator/Start Atlas Animator.cmd.
${bar}
`);
    startupNote = `SANDBOX: these are throw-away files in ${dataDir}, not your real Atlas Animator folder. Start the editor with the Atlas Animator shortcut for your real work.`;
  }
  // Migration of old in-worktree data happens only from the user launcher (or the explicit test hook).
  const from = process.env[MIGRATE_FROM_ENV]?.trim() || (dirs.user ? repoRoot : null);
  if (from) {
    try {
      const done = await migrateWorktreeData({ repoRoot: resolve(from), dataDir });
      if (done?.errors.length) startupNote = `Moving your files into ${dataDir} had ${done.errors.length} problem(s); the old files are untouched. See the server log.`;
    } catch (error) {
      startupNote = `Could not move your old files into ${dataDir}: ${(error as Error).message}. They are untouched in the worktree.`;
      console.error(`[animator-editor] migration failed: ${(error as Error).message}`);
    }
  }
  try {
    const made = await autoBackup(dataDir);
    if (made) console.log(`[animator-editor] daily backup ${made}`);
  } catch (error) {
    console.error(`[animator-editor] daily backup failed: ${(error as Error).message}`);
  }
}

const GUIDE_DIR = resolve(here, "..", "..", "docs");
let commitInfo: { commit: string; branch: string } | null = null;
/** The checkout's short commit hash and branch (read once; "unknown" when git is not available). */
async function gitInfo(): Promise<{ commit: string; branch: string }> {
  if (commitInfo) return commitInfo;
  const ask = async (args: string[]): Promise<string> => {
    try {
      return (await run("git", args, { cwd: repoRoot, timeout: 5000 })).stdout.trim() || "unknown";
    } catch {
      return "unknown";
    }
  };
  commitInfo = { commit: await ask(["rev-parse", "--short", "HEAD"]), branch: await ask(["rev-parse", "--abbrev-ref", "HEAD"]) };
  return commitInfo;
}

/** The Help menu: the user guide, its screenshots and the About details. Read-only. */
async function helpRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET") return send(res, 405, { error: "GET only" });
  if (url.pathname === "/api/help/guide") {
    const file = resolve(GUIDE_DIR, "USER-GUIDE.md");
    if (!existsSync(file)) return send(res, 404, { error: "The user guide file is missing from this checkout." });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(file, "utf8"));
    return;
  }
  const shot = /^\/api\/help\/shot\/([A-Za-z0-9_.-]+\.png)$/.exec(url.pathname);
  if (shot) {
    const file = resolve(GUIDE_DIR, "guide-shots", shot[1] ?? "");
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "no such screenshot" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/api/help/about") {
    const pkg = readJsonFile<{ version?: string }>(resolve(here, "package.json"), {});
    const port = /:(\d+)$/.exec(String(req.headers.host ?? ""))?.[1] ?? "5211";
    return send(res, 200, { name: "Atlas Animator", version: pkg.version ?? "unknown", ...(await gitInfo()), dataDir, logFile: resolve(dataDir, "logs", `editor-${port}.log`), source: dirs.source, node: process.version });
  }
  return send(res, 404, { error: "not found" });
}

/** The Files dialog, the newer-stock-rig question and Publish. */
async function dataRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = async <T>(limit: number): Promise<T> => parseJson<T>(await readBodyLimited(req, limit));
  if (req.method === "GET" && url.pathname === "/api/data") {
    const pointer = existsSync(dirs.pointerFile) ? (readJsonFile<{ dataDir?: string | null }>(dirs.pointerFile, {}).dataDir ?? null) : null;
    return send(res, 200, {
      dataDir,
      source: dirs.source,
      defaultDir: dirs.defaultDir,
      pointerFile: dirs.pointerFile,
      nextStart: dirs.source === "env" || dirs.source === "sandbox" ? dataDir : (pointer ?? dirs.defaultDir),
      stockRoot: dirs.stockRoot,
      folders: { clips: saveDir, rigs: dirs.rigsDir, autosave: autosaveDir, history: historyDir, exports: dirs.exportsDir, poses: poseDir, smears: smearDir, backups: dirs.backupsDir },
      userRigs: rigs.ownedDirs(),
      backups: listBackups(dataDir),
      migrations: readMigrations(dataDir),
      note: startupNote
    });
  }
  if (req.method === "POST" && url.pathname === "/api/data/location") {
    const b = await body<{ dir?: string | null }>(LIMIT.small);
    try {
      return send(res, 200, { ...setDataLocation(dirs, b.dir === null || b.dir === undefined ? null : String(b.dir)), restartNeeded: true });
    } catch (error) {
      throw new ApiError((error as Error).message, 400);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/data/backup") return send(res, 200, await backupNow(dataDir, "manual"));
  if (req.method === "POST" && url.pathname === "/api/data/restore") {
    const b = await body<{ name?: string }>(LIMIT.small);
    try {
      return send(res, 200, await restoreBackup(dataDir, String(b.name ?? "")));
    } catch (error) {
      throw new ApiError((error as Error).message, 400);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/rigs/stock") {
    const dir = url.searchParams.get("dir");
    return send(res, 200, dir ? rigs.compare(dir) : { rigs: rigs.status() });
  }
  if (req.method === "POST" && url.pathname === "/api/rigs/stock") {
    const b = await body<{ dir?: string; choice?: string }>(LIMIT.small);
    const dir = String(b.dir ?? "");
    if (!rigs.ownedDirs().includes(dir)) throw new ApiError(`rig ${dir} has no user copy`, 404);
    if (b.choice === "mine") {
      rigs.keepMine(dir);
      return send(res, 200, { dir, kept: "mine" });
    }
    if (b.choice === "theirs") {
      for (const f of readdirSync(resolve(dirs.rigsDir, dir))) if (f.endsWith(".anim.json")) snapshotRig(resolve(dirs.rigsDir, dir, f));
      return send(res, 200, { dir, kept: "theirs", ...rigs.takeTheirs(dir) });
    }
    throw new ApiError('expected { dir, choice: "theirs" | "mine" }');
  }
  if (url.pathname === "/api/publish/config" && req.method === "GET") return send(res, 200, { dir: rigs.publishRoot });
  if (url.pathname === "/api/publish/validate" && req.method === "GET") {
    const pubDir = rigs.publishRoot;
    if (pubDir === null) throw new ApiError("No publish folder is set (ATLAS_EDITOR_PUBLISH_DIR).", 400);
    // One rig (rig=<folder>) or every rig the publish manifest lists.
    const one = url.searchParams.get("rig");
    if (one !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/.test(one)) throw new ApiError("expected rig=<rig folder>");
    let names: string[];
    try {
      names = one !== null ? [one] : Object.keys(readPublishManifest(pubDir)?.rigs ?? {}).sort();
    } catch (error) {
      throw new ApiError((error as Error).message, 400);
    }
    const reports = names.map((rig) => validatePublish({ repoRoot: pubDir, rig }));
    const text = reports.length ? reports.map(formatReport).join("\n") : "Nothing is published yet: publish a rig first.";
    return send(res, 200, { ok: reports.length > 0 && reports.every((r) => r.ok), reports, text });
  }
  if (url.pathname === "/api/publish" && (req.method === "GET" || req.method === "POST")) {
    const b = req.method === "POST" ? await body<{ kind?: string; name?: string; token?: string }>(LIMIT.small) : { kind: url.searchParams.get("kind") ?? "", name: url.searchParams.get("name") ?? "" };
    const kind = b.kind === "clip" ? "clip" : b.kind === "rig" ? "rig" : null;
    if (!kind) throw new ApiError("expected kind=rig|clip and name");
    if (req.method === "GET") {
      // probe=1 (Ship's Published table): an unregistered rig is a state to show, not a failed request.
      if (url.searchParams.get("probe") === "1" && kind === "rig") {
        try {
          return send(res, 200, rigs.publishPlan(kind, String(b.name ?? ""), saveDir));
        } catch (error) {
          if (error instanceof SaveError && error.status === 400) return send(res, 200, { kind, name: b.name, unregistered: error.message });
          throw error;
        }
      }
      return send(res, 200, rigs.publishPlan(kind, String(b.name ?? ""), saveDir));
    }
    const token = (b as { token?: unknown }).token;
    return send(res, 200, rigs.publish(kind, String(b.name ?? ""), saveDir, new Date(), typeof token === "string" ? token : undefined));
  }
  return send(res, 404, { error: "not found" });
}

function editorFiles(): Plugin {
  return {
    name: "animator-editor-files",
    configureServer(server) {
      const phone = createPhoneLive({
        viteOrigin: () => {
          const a = server.httpServer?.address();
          return a && typeof a === "object" ? `http://127.0.0.1:${a.port}` : null;
        },
        repoFile: (rel) => (rel.startsWith(`${RIGS_REL}/`) ? dirs.mapRepoPath(rel) : null),
        pageHtml: () => readFileSync(resolve(here, "phone.html"), "utf8"),
        port: dirs.sandbox ? 0 : 5290
      });
      const ready = startup();
      const daily = setInterval(() => void autoBackup(dataDir).catch((e: unknown) => console.error(`[animator-editor] daily backup failed: ${(e as Error).message}`)), 3600_000);
      daily.unref();
      server.httpServer?.once("close", () => {
        phone.stop();
        clearInterval(daily);
      });
      server.middlewares.use(phone.middleware);
      server.middlewares.use((req, res, next) => {
        let url: URL;
        try {
          url = new URL(req.url ?? "/", "http://local");
          if (handleRefsApi(req, res, url, dataDir)) return;
        } catch (error) {
          return fail(res, error);
        }
        // Errors (thrown or rejected) become a JSON answer here; SaveError carries its own status (409 stale rig, 404 ...).
        ready.then(() => route(req, res, url, next)).catch((error: unknown) => fail(res, error instanceof SaveError ? new ApiError(error.message, error.status) : error));
      });
    }
  };
}

export default defineConfig({
  plugins: [editorFiles()],
  server: { host: "127.0.0.1" }
});
