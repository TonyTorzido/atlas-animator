/*
 * The "delete the worktree" drill (data-safety rule): proves the user's data survives a `git clean -fdx` and a script's
 * rigsync, and still loads in the editor afterwards.
 *
 *   node scripts/qa-data-safety.mjs [--source <worktree root>] [--keep]
 *
 * Everything happens in a temp folder; nothing in this checkout or in --source is written (the source is only read):
 *  1. A fake worktree is built: a git repo with the stock rig `player` tracked, a copy of the source's in-worktree user data
 *     (packages/animator-editor/clips with .history, autosave, poses, smears, exports; the source's New rig folders) and one untracked
 *     New rig folder. Empty areas get a small seed so every path is exercised. --source defaults to this checkout.
 *  2. A sandboxed editor server (free port, never 5211) starts with ATLAS_EDITOR_DATA_DIR=<temp>/data, ATLAS_EDITOR_MIGRATE_FROM and
 *     ATLAS_EDITOR_STOCK_ROOT=<fake worktree>: it migrates. The drill checks the counts, the pre-migration zip, the MIGRATED.txt
 *     markers, then edits the stock rig (skins) and saves a new clip through the API, and makes a manual backup.
 *  3. A second start must not migrate again.
 *  4. Disaster: `git clean -fdx` in the fake worktree, then a "rigsync" (the stock player rig changes and is committed) and a reset.
 *  5. A third start: every clip still loads with the same bytes, the New rig is listed and loads, the user's rig edit is what loads
 *     (not the new stock), the "newer stock version" question is asked and Keep mine answers it, a backup restores a deleted clip, and
 *     Publish copies a clip into the fake repo without making a commit.
 * Exit code 0 = every check passed.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageDir = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const source = resolve(opt("--source") ?? resolve(packageDir, "../.."));
const keep = args.includes("--keep");
const EDITOR = "packages/animator-editor";
const RIGS = "packages/animator/rigs";
const STOCK_RIG = "player";
const STOCK_DOC = `${RIGS}/${STOCK_RIG}/front-turn15-faceA.anim.json`;
const NEW_RIG = "drill-newrig";

const T = mkdtempSync(resolve(tmpdir(), "atlas-data-safety-"));
const fake = resolve(T, "worktree");
const data = resolve(T, "data");
const home = resolve(T, "home");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
};
const sha = (buf) => createHash("sha1").update(buf).digest("hex");
const git = (...a) => execFileSync("git", a, { cwd: fake, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const walk = (dir, prefix = "") => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
};

// 1. The fake worktree.
mkdirSync(fake, { recursive: true });
for (const name of ["clips", "autosave", "poses", "smears", "exports"]) {
  const src = resolve(source, EDITOR, name);
  if (existsSync(src)) cpSync(src, resolve(fake, EDITOR, name), { recursive: true, filter: (p) => !p.endsWith("MIGRATED.txt") });
}
for (const e of existsSync(resolve(source, RIGS)) ? readdirSync(resolve(source, RIGS), { withFileTypes: true }) : []) {
  if (e.isDirectory() && existsSync(resolve(source, RIGS, e.name, "rig.meta.json"))) cpSync(resolve(source, RIGS, e.name), resolve(fake, RIGS, e.name), { recursive: true });
}
const fakeClips = resolve(fake, EDITOR, "clips");
const sourceClipCount = walk(fakeClips).filter((f) => !f.includes("/") && f.endsWith(".clip.json")).length;
if (!walk(fakeClips).some((f) => f.endsWith(".clip.json"))) put(resolve(fakeClips, "drill_seed.clip.json"), JSON.stringify({ duration: 1, bones: {} }));
if (!existsSync(resolve(fakeClips, ".history"))) put(resolve(fakeClips, ".history/clips/drill_seed.clip.json/2026-01-01T00-00-00-000Z.json"), JSON.stringify({ duration: 0.5 }));
if (!existsSync(resolve(fakeClips, "board-config.json"))) put(resolve(fakeClips, "board-config.json"), JSON.stringify({ slots: [] }));
if (!walk(resolve(fake, EDITOR, "poses")).length) put(resolve(fake, EDITOR, "poses/drill.pose.json"), JSON.stringify({ format: "atlas-pose@1", name: "drill" }));
cpSync(resolve(source, RIGS, STOCK_RIG), resolve(fake, RIGS, STOCK_RIG), { recursive: true });
const tmpl = JSON.parse(readFileSync(resolve(fake, STOCK_DOC), "utf8"));
put(resolve(fake, RIGS, NEW_RIG, `${NEW_RIG}.anim.json`), JSON.stringify({ format: "atlas-anim@1", name: NEW_RIG, canvas: tmpl.canvas, bones: [{ name: "root", x: 0, y: 0 }], slots: [], skins: { default: { attachments: {} } }, animations: {}, atlas: { pages: [], scale: 1 } }, null, 2));
put(resolve(fake, RIGS, NEW_RIG, "rig.meta.json"), JSON.stringify({ id: NEW_RIG, label: "Drill rig", template: "blank" }));
put(resolve(fake, EDITOR, ".gitignore"), readFileSync(resolve(packageDir, ".gitignore"), "utf8"));
git("init", "-q");
git("config", "user.email", "drill@example.invalid");
git("config", "user.name", "drill");
git("config", "core.autocrlf", "false");
git("add", `${EDITOR}/.gitignore`, `${RIGS}/${STOCK_RIG}`);
git("commit", "-q", "-m", "stock");

// What the user had before (relative file -> hash), in the new layout.
const before = new Map();
for (const f of walk(fakeClips)) {
  const buf = readFileSync(resolve(fakeClips, f));
  if (f.startsWith(".history/")) before.set(`history/${f.slice(9)}`, sha(buf));
  else if (["board-config.json", "board.json", "tween-marks.json", "refs.json"].includes(f)) before.set(f, sha(buf));
  else before.set(`clips/${f}`, sha(buf));
}
for (const name of ["autosave", "poses", "smears", "exports"]) for (const f of walk(resolve(fake, EDITOR, name))) before.set(`${name}/${f}`, sha(readFileSync(resolve(fake, EDITOR, name, f))));
for (const e of readdirSync(resolve(fake, RIGS))) if (existsSync(resolve(fake, RIGS, e, "rig.meta.json"))) for (const f of walk(resolve(fake, RIGS, e))) before.set(`rigs/${e}/${f}`, sha(readFileSync(resolve(fake, RIGS, e, f))));
const clipNames = [...before.keys()].filter((k) => /^clips\/[^/]+\.clip\.json$/.test(k)).map((k) => k.slice(6));
console.log(`fake worktree ${fake}: ${before.size} user files (${clipNames.length} clips, ${sourceClipCount} of them from ${source})`);

// The sandboxed server.
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const viteBin = resolve(dirname(createRequire(resolve(packageDir, "package.json")).resolve("vite/package.json")), "bin/vite.js");
async function startServer() {
  const port = await freePort();
  const log = [];
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: packageDir,
    env: { ...process.env, ATLAS_EDITOR_DATA_DIR: data, ATLAS_EDITOR_MIGRATE_FROM: fake, ATLAS_EDITOR_STOCK_ROOT: fake, USERPROFILE: home, APPDATA: resolve(home, "AppData") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log.join("")}`);
    try {
      if ((await fetch(`${url}api/clips`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const api = async (path, body, method) => {
    const res = await fetch(url + path, body === undefined ? { method: method ?? "GET" } : { method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const stop = () =>
    new Promise((ok) => {
      if (child.exitCode !== null) return ok();
      child.once("exit", () => ok());
      child.kill();
    });
  return { api, stop, log };
}
const raw = async (s, rel) => (await s.api(`repo/${rel}`)).text;

let failed = false;
let s = null;
try {
  // 2. First start: migration.
  s = await startServer();
  const info = (await s.api("api/data")).json;
  const run = info.migrations[0];
  const copied = Object.values(run?.copied ?? {}).reduce((a, b) => a + b, 0);
  check("migration ran once, with no errors", info.migrations.length === 1 && run.errors.length === 0, run?.errors);
  check("every user file was copied into the data folder (counts before = after)", copied === before.size, { before: before.size, copied, byArea: run?.copied });
  const same = [...before].filter(([rel, h]) => existsSync(resolve(data, rel)) && sha(readFileSync(resolve(data, rel))) === h).length;
  check("every copied file has the same bytes", same === before.size, { same, of: before.size });
  check("the pre-migration zip was made first", !!run?.backup && existsSync(run.backup));
  check("old files were left in place with MIGRATED.txt", existsSync(resolve(fakeClips, "MIGRATED.txt")) && clipNames.every((c) => existsSync(resolve(fakeClips, c))));
  const stockHash = sha(readFileSync(resolve(fake, STOCK_DOC)));
  const doc = JSON.parse(await raw(s, STOCK_DOC));
  const skins = { ...doc.skins, "drill.user-edit": { attachments: {} } };
  const sk = await s.api("api/skins", { file: STOCK_DOC, skins });
  check("an user rig edit (skins) saves", sk.status === 200, sk.json);
  check("the edit went to the user copy, the stock rig is untouched", existsSync(resolve(data, "rigs", STOCK_RIG, ".stock-base.json")) && sha(readFileSync(resolve(fake, STOCK_DOC))) === stockHash);
  const newClip = JSON.stringify({ duration: 1.25, bones: {}, note: "saved after the move" });
  const sv = await s.api("api/clips/drill_new.clip.json", newClip);
  check("a new clip saves into the data folder", sv.status === 200 && existsSync(resolve(data, "clips/drill_new.clip.json")), sv.json);
  const bk = await s.api("api/data/backup", {});
  check("Back up now makes a zip", bk.status === 200 && existsSync(resolve(data, "backups", bk.json.name)), bk.json?.name);
  await s.stop();

  // 3. Second start: no second migration.
  s = await startServer();
  const again = (await s.api("api/data")).json;
  check("a second start does not migrate again", again.migrations.length === 1 && again.backups.filter((b) => b.kind === "pre-migration").length === 1);
  await s.stop();

  // 4. Disaster: git clean -fdx, then a rigsync that changes the stock rig, then a reset.
  git("clean", "-fdxq");
  const stock = JSON.parse(readFileSync(resolve(fake, STOCK_DOC), "utf8"));
  stock.drillStock = "rigsync";
  writeFileSync(resolve(fake, STOCK_DOC), JSON.stringify(stock, null, 2));
  git("commit", "-qam", "rigsync");
  git("reset", "--hard", "-q");
  check("git clean -fdx removed the old in-worktree data", !existsSync(fakeClips) && !existsSync(resolve(fake, RIGS, NEW_RIG)));

  // 5. Third start: everything still loads.
  s = await startServer();
  const after = (await s.api("api/data")).json;
  check("still one migration record after the clean", after.migrations.length === 1);
  const list = (await s.api("api/clips")).json;
  check("every clip is still listed", [...clipNames, "drill_new.clip.json"].every((c) => list.includes(c)), { listed: list.length });
  let loads = 0;
  for (const c of clipNames) if (sha(Buffer.from(await raw(s, `${EDITOR}/clips/${c}`))) === before.get(`clips/${c}`)) loads++;
  check("every migrated clip loads with the same bytes", loads === clipNames.length, { loads, of: clipNames.length });
  check("the clip saved after the move loads", (await raw(s, `${EDITOR}/clips/drill_new.clip.json`)) === newClip);
  const rigs = (await s.api("api/rigs")).json.rigs.map((r) => r.id);
  check("the New rig is still listed and loads", rigs.includes(NEW_RIG) && JSON.parse(await raw(s, `${RIGS}/${NEW_RIG}/${NEW_RIG}.anim.json`)).name === NEW_RIG, rigs);
  const served = JSON.parse(await raw(s, STOCK_DOC));
  check("the user's rig edit is what loads (not the new stock)", "drill.user-edit" in served.skins && served.drillStock === undefined);
  const st = (await s.api("api/rigs/stock")).json.rigs;
  check("the newer stock version is reported", st.length === 1 && st[0].dir === STOCK_RIG, st.map((r) => r.dir));
  const keep = await s.api("api/rigs/stock", { dir: STOCK_RIG, choice: "mine" });
  check("Keep mine answers it and keeps the user's edit", keep.status === 200 && (await s.api("api/rigs/stock")).json.rigs.length === 0 && "drill.user-edit" in JSON.parse(await raw(s, STOCK_DOC)).skins);
  unlinkSync(resolve(data, "clips/drill_new.clip.json"));
  const rs = await s.api("api/data/restore", { name: bk.json.name });
  check("Restore from backup brings a deleted clip back", rs.status === 200 && readFileSync(resolve(data, "clips/drill_new.clip.json"), "utf8") === newClip, rs.json);
  const commits = git("rev-list", "--count", "HEAD").trim();
  const pv = await s.api("api/publish?kind=clip&name=drill_new.clip.json");
  const pb = await s.api("api/publish", { kind: "clip", name: "drill_new.clip.json" });
  check("Publish previews, then copies the clip into the repo", pv.json?.added?.length === 1 && pb.status === 200 && readFileSync(resolve(fake, "packages/animator/clips/drill_new.clip.json"), "utf8") === newClip, pb.json?.written);
  check("Publish made no commit", git("rev-list", "--count", "HEAD").trim() === commits && git("status", "--porcelain").includes("packages/animator/clips/"));
  await s.stop();
  s = null;
} catch (error) {
  failed = true;
  console.error(error);
  if (s) console.error(s.log.join("").slice(-4000));
} finally {
  if (s) await s.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed ? " (the drill stopped early)" : ""}`);
if (keep) console.log(`kept ${T}`);
else rmSync(T, { recursive: true, force: true, maxRetries: 3 });
process.exit(bad.length || failed ? 1 : 0);
