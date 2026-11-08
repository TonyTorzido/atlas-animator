import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, errorResponse, listSnapshots, readBodyLimited, restoreSnapshot, snapshot, snapshotFolder, writeAtomic, type FsOps } from "./safeFs.js";
import * as fs from "node:fs";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "safefs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const realOps: FsOps = { openSync: fs.openSync, writeSync: (fd, d) => fs.writeSync(fd, d), fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
const leftovers = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeAtomic", () => {
  it("writes a new file and replaces an old one, leaving no temp file", () => {
    const file = resolve(dir, "sub", "a.clip.json");
    writeAtomic(file, "one");
    writeAtomic(file, "two");
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(resolve(dir, "sub")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the old file intact and removes the temp when the write fails", () => {
    const file = resolve(dir, "a.json");
    writeFileSync(file, "old");
    const ops: FsOps = {
      ...realOps,
      writeSync: () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
    };
    expect(() => writeAtomic(file, "new", ops)).toThrow(/ENOSPC/);
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });

  it("retries the rename on EPERM/EBUSY (Windows locks) and then succeeds", () => {
    const file = resolve(dir, "a.json");
    let fails = 2;
    const ops: FsOps = {
      ...realOps,
      renameSync: (a, b) => {
        if (fails-- > 0) throw Object.assign(new Error("EBUSY: resource busy"), { code: fails ? "EPERM" : "EBUSY" });
        renameSync(a, b);
      }
    };
    writeAtomic(file, "ok", ops);
    expect(readFileSync(file, "utf8")).toBe("ok");
    expect(fails).toBe(-1);
  });

  it("gives up after the retries, leaving the target untouched and no temp", () => {
    const file = resolve(dir, "a.json");
    writeFileSync(file, "old");
    const ops: FsOps = {
      ...realOps,
      renameSync: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
    };
    expect(() => writeAtomic(file, "new", ops, 2)).toThrow(/EPERM/);
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });

  it("does not retry other errors (a folder in the way)", () => {
    const file = resolve(dir, "a.json");
    mkdirSync(resolve(file, "inner"), { recursive: true });
    writeFileSync(resolve(file, "inner", "x"), "x");
    expect(() => writeAtomic(file, "new")).toThrow();
    expect(leftovers()).toEqual([]);
  });
});

describe("snapshots", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, s));

  it("copies the previous version, skips identical copies and keeps the newest N", () => {
    const file = resolve(dir, "walk.clip.json");
    const history = resolve(dir, ".history");
    expect(snapshot(file, history, "clips/walk.clip.json")).toBeNull(); // nothing yet
    for (let i = 0; i < 6; i++) {
      writeFileSync(file, `v${i}`);
      expect(snapshot(file, history, "clips/walk.clip.json", 4, t(i))).toMatch(/\.clip\.json$/);
    }
    expect(snapshot(file, history, "clips/walk.clip.json", 4, t(30))).toBeNull(); // same bytes as the newest
    const list = listSnapshots(history, "clips/walk.clip.json");
    expect(list.map((s) => readFileSync(resolve(history, "clips/walk.clip.json", s.id), "utf8"))).toEqual(["v5", "v4", "v3", "v2"]);
    expect(list[0]!.time).toBe("2026-10-26T12:00:05.000Z");
  });

  it("names same-millisecond snapshots apart and lists them in order", () => {
    const file = resolve(dir, "a.clip.json");
    const history = resolve(dir, ".history");
    for (const v of ["a", "b", "c"]) {
      writeFileSync(file, v);
      snapshot(file, history, "clips/a.clip.json", 50, t(1));
    }
    const list = listSnapshots(history, "clips/a.clip.json");
    expect(list.map((s) => readFileSync(resolve(history, "clips/a.clip.json", s.id), "utf8"))).toEqual(["c", "b", "a"]);
  });

  it("restore snapshots the current file first, so a restore can be undone", () => {
    const file = resolve(dir, "a.clip.json");
    const history = resolve(dir, ".history");
    writeFileSync(file, "first");
    const id = snapshot(file, history, "clips/a.clip.json", 50, t(1))!;
    writeFileSync(file, "second");
    const out = restoreSnapshot(file, history, "clips/a.clip.json", id);
    expect(readFileSync(file, "utf8")).toBe("first");
    expect(out.backup).not.toBeNull();
    expect(readFileSync(resolve(history, "clips/a.clip.json", out.backup!), "utf8")).toBe("second");
    expect(() => restoreSnapshot(file, history, "clips/a.clip.json", "2020-01-01T00-00-00-000Z.clip.json")).toThrow(ApiError);
  });

  it("refuses history keys that leave the history folder", () => {
    expect(() => snapshotFolder(dir, "../x")).toThrow(ApiError);
    expect(() => snapshotFolder(dir, "clips/../../x")).toThrow(ApiError);
  });
});

describe("request bodies and errors", () => {
  it("reads a body under the limit and refuses one over it with 413", async () => {
    const small = new PassThrough();
    const p1 = readBodyLimited(small, 10);
    small.end("hello");
    await expect(p1).resolves.toBe("hello");
    const big = new PassThrough();
    const p2 = readBodyLimited(big, 4);
    big.end("too long");
    await expect(p2).rejects.toMatchObject({ status: 413 });
  });

  it("maps fs errors to clear JSON messages", () => {
    expect(errorResponse(Object.assign(new Error("x"), { code: "ENOSPC", path: "/a/b.clip.json" }))).toMatchObject({ status: 507, body: { code: "ENOSPC" } });
    expect(errorResponse(Object.assign(new Error("x"), { code: "EPERM", path: "/a/b.clip.json" })).body["error"]).toMatch(/b\.clip\.json.*read-only/);
    expect(errorResponse(new ApiError("stale", 409, { conflict: true }))).toEqual({ status: 409, body: { error: "stale", conflict: true } });
    expect(errorResponse(new Error("bad"), 400)).toEqual({ status: 400, body: { error: "bad" } });
  });

  it("a read-only target fails the write with EPERM/EACCES and keeps the old bytes", () => {
    const file = resolve(dir, "ro.json");
    writeFileSync(file, "old");
    chmodSync(file, 0o444);
    try {
      writeAtomic(file, "new", realOps, 1);
      // POSIX lets rename replace a read-only file; Windows refuses. Either way the file is whole.
      expect(["old", "new"]).toContain(readFileSync(file, "utf8"));
    } catch (error) {
      expect(["EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
      expect(readFileSync(file, "utf8")).toBe("old");
    } finally {
      chmodSync(file, 0o644);
    }
    expect(existsSync(file)).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});
