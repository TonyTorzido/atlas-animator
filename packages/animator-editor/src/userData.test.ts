import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_KEEP, autoBackup, backupNow, listBackups, migrateWorktreeData, restoreBackup, setDataLocation } from "./userData.js";
import { createRigStore } from "./rigStore.js";
import { readZip, writeZip } from "./zipFiles.js";

const temps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(resolve(tmpdir(), "atlas-user-data-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const files = (dir: string): string[] => {
  const out: string[] = [];
  const go = (d: string, p: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? go(resolve(d, e.name), `${p}${e.name}/`) : out.push(`${p}${e.name}`);
  };
  if (existsSync(dir)) go(dir, "");
  return out.sort();
};
const quiet = () => undefined;

/** A fake worktree with the old in-repo user data layout. */
function fakeWorktree(): string {
  const repo = tmp();
  const pkg = resolve(repo, "packages/animator-editor");
  put(resolve(pkg, "clips/walk.clip.json"), '{"duration":1}');
  put(resolve(pkg, "clips/board-config.json"), '{"slots":[]}');
  put(resolve(pkg, "clips/tween-marks.json"), "{}");
  put(resolve(pkg, "clips/.history/clips/walk.clip.json/2026-01-01.json"), '{"duration":0.5}');
  put(resolve(pkg, "autosave/walk/1.json"), "{}");
  put(resolve(pkg, "poses/a.pose.json"), "{}");
  put(resolve(pkg, "exports/x/y.gif"), "GIF");
  put(resolve(repo, "packages/animator/rigs/stock1/stock1.anim.json"), '{"bones":[]}');
  put(resolve(repo, "packages/animator/rigs/mine1/mine1.anim.json"), '{"bones":[{"name":"root"}]}');
  put(resolve(repo, "packages/animator/rigs/mine1/rig.meta.json"), '{"id":"mine1"}');
  return repo;
}

describe("zip", () => {
  it("round-trips text and binary entries and checks CRCs", async () => {
    const dir = tmp();
    const big = Buffer.from("abc".repeat(5000));
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 255]);
    await writeZip(resolve(dir, "a.zip"), [{ name: "x/big.json", data: big }, { name: "p.png", data: bin }, { name: "ü.txt", data: Buffer.from("hi") }]);
    const back = readZip(resolve(dir, "a.zip"));
    expect(back.map((e) => e.name)).toEqual(["x/big.json", "p.png", "ü.txt"]);
    expect(back[0]!.data.equals(big)).toBe(true);
    expect(back[1]!.data.equals(bin)).toBe(true);
    expect(existsSync(resolve(dir, "a.zip.partial"))).toBe(false);
  });
});

describe("migrateWorktreeData", () => {
  it("backs up, copies into the new layout, leaves the old files with a marker, and runs once", async () => {
    const repo = fakeWorktree();
    const data = tmp();
    const s = await migrateWorktreeData({ repoRoot: repo, dataDir: data, log: quiet });
    expect(s?.errors).toEqual([]);
    expect(s?.copied).toMatchObject({ clips: 1, history: 1, "root files": 2, autosave: 1, poses: 1, exports: 1, rigs: 2 });
    expect(s?.rigs).toEqual(["mine1"]);
    expect(readFileSync(resolve(data, "clips/walk.clip.json"), "utf8")).toBe('{"duration":1}');
    expect(existsSync(resolve(data, "history/clips/walk.clip.json/2026-01-01.json"))).toBe(true);
    expect(existsSync(resolve(data, "board-config.json"))).toBe(true);
    expect(existsSync(resolve(data, "rigs/mine1/rig.meta.json"))).toBe(true);
    expect(existsSync(resolve(data, "rigs/stock1"))).toBe(false);
    // old files stay, with a marker
    expect(existsSync(resolve(repo, "packages/animator-editor/clips/walk.clip.json"))).toBe(true);
    expect(existsSync(resolve(repo, "packages/animator-editor/clips/MIGRATED.txt"))).toBe(true);
    // the pre-migration zip holds everything, in the new layout
    const zip = readZip(s!.backup!).map((e) => e.name);
    expect(zip).toContain("clips/walk.clip.json");
    expect(zip).toContain("rigs/mine1/mine1.anim.json");
    // idempotent: a second start does nothing and makes no second zip
    expect(await migrateWorktreeData({ repoRoot: repo, dataDir: data, log: quiet })).toBeNull();
    expect(listBackups(data).filter((b) => b.kind === "pre-migration")).toHaveLength(1);
  });

  it("never overwrites a file already in the data folder", async () => {
    const repo = fakeWorktree();
    const data = tmp();
    put(resolve(data, "clips/walk.clip.json"), '{"duration":9}');
    const s = await migrateWorktreeData({ repoRoot: repo, dataDir: data, log: quiet });
    expect(s?.skipped).toBe(1);
    expect(readFileSync(resolve(data, "clips/walk.clip.json"), "utf8")).toBe('{"duration":9}');
  });
});

describe("backups", () => {
  it("backs up, restores (with a before-restore zip) and keeps 14 daily zips", async () => {
    const data = tmp();
    put(resolve(data, "clips/a.clip.json"), "1");
    const made = await backupNow(data);
    expect(made.files).toBe(1);
    put(resolve(data, "clips/a.clip.json"), "2");
    const r = await restoreBackup(data, made.name);
    expect(r.restored).toBe(1);
    expect(readFileSync(resolve(data, "clips/a.clip.json"), "utf8")).toBe("1");
    expect(listBackups(data).some((b) => b.kind === "before-restore")).toBe(true);
    await expect(restoreBackup(data, "../x.zip")).rejects.toThrow();

    const day = 24 * 3600 * 1000;
    const t0 = Date.parse("2026-01-01T12:00:00Z");
    for (let i = 0; i < AUTO_KEEP + 3; i++) {
      put(resolve(data, "clips/a.clip.json"), `v${i}`);
      const when = new Date(t0 + i * day);
      utimesSync(resolve(data, "clips/a.clip.json"), when, when);
      const name = await autoBackup(data, when);
      expect(name).not.toBeNull();
      utimesSync(resolve(data, "backups", name!), when, when);
      expect(await autoBackup(data, new Date(t0 + i * day + 1000))).toBeNull(); // once a day
    }
    expect(listBackups(data).filter((b) => b.kind === "auto")).toHaveLength(AUTO_KEEP);
  });

  it("moves to a new data folder by copying, and refuses a folder inside the current one", () => {
    const data = tmp();
    const next = resolve(tmp(), "new place");
    put(resolve(data, "clips/a.clip.json"), "1");
    const loc = { dataDir: data, source: "default" as const, defaultDir: data, pointerFile: resolve(tmp(), "ptr", "data-location.json") };
    const out = setDataLocation(loc, next);
    expect(out.copied).toBe(1);
    expect(readFileSync(resolve(next, "clips/a.clip.json"), "utf8")).toBe("1");
    expect(JSON.parse(readFileSync(loc.pointerFile, "utf8")).dataDir).toBe(next);
    expect(existsSync(resolve(data, "clips/a.clip.json"))).toBe(true);
    expect(() => setDataLocation(loc, resolve(data, "sub"))).toThrow(/inside/);
    expect(() => setDataLocation({ ...loc, source: "env" }, next)).toThrow(/ATLAS_EDITOR_DATA_DIR/);
  });
});

describe("rig store", () => {
  it("copies a stock rig on first write, flags newer stock, and resolves Keep mine / Take theirs", () => {
    const repo = fakeWorktree();
    const data = tmp();
    const store = createRigStore({ stockRoot: repo, rigsDir: resolve(data, "rigs"), backupsDir: resolve(data, "backups") });
    const rel = "packages/animator/rigs/stock1/stock1.anim.json";
    expect(store.readRoot(rel)).toBe(repo);
    store.writeRoot(rel);
    const mine = resolve(data, "rigs/stock1/stock1.anim.json");
    expect(existsSync(mine)).toBe(true);
    expect(store.readPath(rel)).toBe(mine);
    expect(store.status()).toEqual([]);
    // the user edits; then a script's rigsync changes the stock
    writeFileSync(mine, '{"bones":[{"name":"user"}]}');
    writeFileSync(resolve(repo, rel), '{"bones":[{"name":"a"},{"name":"b"}]}');
    const st = store.status();
    expect(st.map((s) => s.dir)).toEqual(["stock1"]);
    expect(st[0]!.changes).toEqual([{ file: "stock1.anim.json", change: "changed" }]);
    expect(st[0]!.docs[0]).toMatchObject({ mine: { bones: 1 }, theirs: { bones: 2 } });
    expect(readFileSync(mine, "utf8")).toContain("user"); // never overwritten silently
    store.keepMine("stock1");
    expect(store.status()).toEqual([]);
    writeFileSync(resolve(repo, rel), '{"bones":[]}');
    expect(store.status()).toHaveLength(1);
    const { backup } = store.takeTheirs("stock1");
    expect(readFileSync(mine, "utf8")).toBe('{"bones":[]}');
    expect(readFileSync(resolve(backup, "stock1.anim.json"), "utf8")).toContain("user");
    expect(store.status()).toEqual([]);
  });

  it("publishes an user rig and a clip into the repo with a preview and a snapshot", () => {
    const repo = fakeWorktree();
    const data = tmp();
    const store = createRigStore({ stockRoot: repo, rigsDir: resolve(data, "rigs"), backupsDir: resolve(data, "backups") });
    store.writeRoot("packages/animator/rigs/stock1/stock1.anim.json");
    put(resolve(data, "rigs/stock1/stock1.anim.json"), '{"bones":[1]}');
    put(resolve(data, "rigs/stock1/new.png"), "PNG");
    const plan = store.publishPlan("rig", "stock1", resolve(data, "clips"));
    expect(plan).toMatchObject({ added: ["new.png"], changed: ["stock1.anim.json"], unchanged: 0 });
    const out = store.publish("rig", "stock1", resolve(data, "clips"));
    expect(out.written).toHaveLength(2);
    expect(readFileSync(resolve(repo, "packages/animator/rigs/stock1/stock1.anim.json"), "utf8")).toBe('{"bones":[1]}');
    expect(readFileSync(resolve(out.snapshot!, "stock1.anim.json"), "utf8")).toBe('{"bones":[]}');
    expect(store.status()).toEqual([]);
    put(resolve(data, "clips/walk.clip.json"), '{"duration":2}');
    const clip = store.publish("clip", "walk.clip.json", resolve(data, "clips"));
    expect(clip.target).toBe("packages/animator/clips/walk.clip.json");
    expect(readFileSync(resolve(repo, clip.target), "utf8")).toBe('{"duration":2}');
    expect(() => store.publishPlan("rig", "mine1", resolve(data, "clips"))).toThrow(/no user copy/);
    // Batch 9: every publish is recorded with the sha1 of what the repo now has.
    const manifest = JSON.parse(readFileSync(resolve(repo, "packages/animator/publish-manifest.json"), "utf8")) as { format: string; rigs: Record<string, { files: Record<string, string> }>; clips: Record<string, { sha1: string }> };
    expect(manifest.format).toBe("atlas-publish-manifest@1");
    expect(Object.keys(manifest.rigs["stock1"]!.files).sort()).toEqual(["new.png", "stock1.anim.json"]);
    expect(manifest.rigs["stock1"]!.files["new.png"]).toBe(createHash("sha1").update("PNG").digest("hex"));
    expect(manifest.clips["walk.clip.json"]!.sha1).toBe(createHash("sha1").update('{"duration":2}').digest("hex"));
  });

  it("refuses to publish a rig the repo does not have (a New-rig character) with the register hint, writing nothing", () => {
    const repo = fakeWorktree();
    const data = tmp();
    const store = createRigStore({ stockRoot: repo, rigsDir: resolve(data, "rigs"), backupsDir: resolve(data, "backups") });
    put(resolve(data, "rigs/hero/hero.anim.json"), '{"bones":[]}');
    expect(() => store.publishPlan("rig", "hero", resolve(data, "clips"))).toThrow(/not a registered game rig.*Register as a new character/);
    let status = 0;
    try {
      store.publish("rig", "hero", resolve(data, "clips"));
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(400);
    expect(existsSync(resolve(repo, "packages/animator/rigs/hero"))).toBe(false);
    expect(existsSync(resolve(repo, "packages/animator/publish-manifest.json"))).toBe(false);
  });
});
