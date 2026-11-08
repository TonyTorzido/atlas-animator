import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDataDirs, resolveDataLocation } from "./dataDirs.js";

const pkg = resolve("/work/repo/packages/animator-editor");
const repo = resolve("/work/repo");
const user = resolve("/users/user");
const base = { USERPROFILE: user, APPDATA: resolve(user, "AppData/Roaming") };
const none = () => null;

describe("resolveDataLocation", () => {
  it("defaults to Documents\\Atlas Animator outside any repo", () => {
    const loc = resolveDataLocation(base, none);
    expect(loc.source).toBe("default");
    expect(loc.dataDir).toBe(resolve(user, "Documents", "Atlas Animator"));
    expect(loc.pointerFile).toBe(resolve(user, "AppData/Roaming", "Atlas Animator", "data-location.json"));
  });

  it("uses the Settings pointer, and the env var over it", () => {
    const chosen = resolve("/d/Art/Animator");
    const read = () => JSON.stringify({ dataDir: chosen });
    expect(resolveDataLocation(base, read)).toMatchObject({ dataDir: chosen, source: "settings" });
    const env = resolve("/tmp/sandbox");
    expect(resolveDataLocation({ ...base, ATLAS_EDITOR_DATA_DIR: env }, read)).toMatchObject({ dataDir: env, source: "env" });
  });

  it("falls back to the default for a broken or relative pointer, and rejects a relative env dir", () => {
    expect(resolveDataLocation(base, () => "{nope").source).toBe("default");
    expect(resolveDataLocation(base, () => JSON.stringify({ dataDir: "rel/x" })).source).toBe("default");
    expect(() => resolveDataLocation({ ...base, ATLAS_EDITOR_DATA_DIR: "rel/dir" }, none)).toThrow(/absolute/);
  });
});

describe("resolveDataDirs", () => {
  const dir = resolve("/tmp/sandbox-1");
  const env = { ...base, ATLAS_EDITOR_DATA_DIR: dir };

  it("puts every user folder under the data dir", () => {
    const d = resolveDataDirs(pkg, repo, env, () => false);
    expect(d.sandbox).toBe(true);
    for (const [got, name] of [[d.saveDir, "clips"], [d.poseDir, "poses"], [d.smearDir, "smears"], [d.autosaveDir, "autosave"], [d.exportsDir, "exports"], [d.historyDir, "history"], [d.rigsDir, "rigs"], [d.backupsDir, "backups"]] as const) expect(got).toBe(resolve(dir, name));
    expect(d.stockRoot).toBe(repo);
    expect(resolveDataDirs(pkg, repo, { ...base, ATLAS_EDITOR_USER_DATA: "1" }, () => false).saveDir).toBe(resolve(user, "Documents", "Atlas Animator", "clips"));
  });

  it("guard: only the launcher (ATLAS_EDITOR_USER_DATA=1) uses the real folder and may migrate; plain dev gets the per-worktree sandbox", () => {
    const plain = resolveDataDirs(pkg, repo, base, () => false);
    expect(plain).toMatchObject({ source: "sandbox", sandbox: true, user: false, dataDir: resolve(repo, ".atlas-sandbox-data") });
    expect(plain.saveDir).toBe(resolve(repo, ".atlas-sandbox-data", "clips"));
    const user = resolveDataDirs(pkg, repo, { ...base, ATLAS_EDITOR_USER_DATA: "1" }, () => false);
    expect(user).toMatchObject({ source: "default", sandbox: false, user: true });
    expect(resolveDataDirs(pkg, repo, { ...base, ATLAS_EDITOR_USER_DATA: "0" }, () => false).source).toBe("sandbox");
    expect(resolveDataDirs(pkg, repo, { ...env, ATLAS_EDITOR_USER_DATA: "1" }, () => false)).toMatchObject({ source: "env", user: false, sandbox: true });
  });

  it("maps user data paths into the data dir and rigs to the user copy first, then the stock rig", () => {
    const owned = new Set([resolve(dir, "rigs", "player")]);
    const d = resolveDataDirs(pkg, repo, env, (p) => owned.has(p));
    expect(d.mapRepoPath("packages/animator-editor/clips/a.clip.json")).toBe(resolve(dir, "clips/a.clip.json"));
    expect(d.mapRepoPath("packages/animator-editor/exports/x/y.gif")).toBe(resolve(dir, "exports/x/y.gif"));
    expect(d.mapRepoPath("packages/animator/rigs/player/a.anim.json")).toBe(resolve(dir, "rigs/player/a.anim.json"));
    expect(d.mapRepoPath("packages/animator/rigs/jacketb/b.anim.json")).toBe(resolve(repo, "packages/animator/rigs/jacketb/b.anim.json"));
    expect(d.mapRepoPath("packages/animator/fixtures/f.json")).toBe(resolve(repo, "packages/animator/fixtures/f.json"));
    expect(d.readRoots).toContain(resolve(dir, "rigs") + sep);
    expect(d.readRoots).toContain(resolve(repo, "packages/animator/rigs") + sep);
    expect(d.readRoots.some((r) => r.startsWith(resolve(pkg, "clips")))).toBe(false);
  });

  it("takes the stock rigs from ATLAS_EDITOR_STOCK_ROOT when set", () => {
    const stock = resolve("/tmp/fake-repo");
    expect(resolveDataDirs(pkg, repo, { ...env, ATLAS_EDITOR_STOCK_ROOT: stock }, () => false).mapRepoPath("packages/animator/rigs/p/a.anim.json")).toBe(resolve(stock, "packages/animator/rigs/p/a.anim.json"));
  });
});
