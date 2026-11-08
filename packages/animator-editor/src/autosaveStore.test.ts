import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTOSAVE_FORMAT, type AutosavePayload } from "./autosaveModel.js";
import { AutosaveError, createAutosaveStore } from "./autosaveStore.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autosave-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const payload = (n: number, over: Partial<AutosavePayload> = {}): AutosavePayload => ({
  format: AUTOSAVE_FORMAT,
  clip: "chop",
  outfit: "pro-front",
  reason: "interval",
  savedAt: "",
  clipData: { duration: 1, loop: false, bones: { chest: { rotate: [{ time: 0, value: n }] } } },
  ...over
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 10, 0, s));

describe("autosave store", () => {
  it("writes a version, lists it newest first and reads it back", async () => {
    const store = createAutosaveStore(dir);
    const a = await store.write(payload(1), at(1));
    const b = await store.write(payload(2), at(2));
    expect(a.skipped).toBe(false);
    const list = await store.versions("chop");
    expect(list.map((v) => v.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ flags: "c", outfit: "pro-front" });
    expect(list[0]!.bytes).toBeGreaterThan(50);
    const back = await store.read("chop", a.id);
    expect(back.clipData).toEqual(payload(1).clipData);
    expect(back.savedAt).toBe(at(1).toISOString());
    expect(await store.clips()).toEqual(["chop"]);
  });

  it("keeps the newest 30 per clip and prunes only that clip", async () => {
    const store = createAutosaveStore(dir);
    await store.write(payload(0, { clip: "walk" }), at(0));
    for (let i = 1; i <= 35; i++) await store.write(payload(i), at(i));
    const list = await store.versions("chop");
    expect(list).toHaveLength(30);
    // the oldest five (1..5) are gone, 6..35 stay
    expect((await store.read("chop", list.at(-1)!.id)).clipData).toEqual(payload(6).clipData);
    expect((await store.read("chop", list[0]!.id)).clipData).toEqual(payload(35).clipData);
    expect(await store.versions("walk")).toHaveLength(1);
  });

  it("does not store the same content twice, and never reuses or goes behind the newest id", async () => {
    const store = createAutosaveStore(dir);
    const a = await store.write(payload(1), at(5));
    const same = await store.write(payload(1, { reason: "switch" }), at(6));
    expect(same).toMatchObject({ skipped: true, id: a.id });
    const early = await store.write(payload(2), at(1)); // the clock stepped back
    expect(early.id > a.id).toBe(true);
    const again = await store.write(payload(3), at(1));
    expect(again.id > early.id).toBe(true);
    expect(await store.versions("chop")).toHaveLength(3);
  });

  it("records rig edits in the flags and leaves no temp files", async () => {
    const store = createAutosaveStore(dir);
    await store.write(payload(1, { rig: { document: "packages/animator/rigs/x/x.anim.json", skins: { skins: {}, setup: {} }, setup: { batches: [[{ op: "bone.add" }]], undo: 0 } } }), at(1));
    expect((await store.versions("chop"))[0]!.flags).toBe("csu");
    expect(readdirSync(join(dir, "chop")).every((f) => f.endsWith(".json"))).toBe(true);
  });

  it("refuses bad input without writing", async () => {
    const store = createAutosaveStore(dir);
    await expect(store.write({ format: "nope" })).rejects.toBeInstanceOf(AutosaveError);
    await expect(store.write(payload(1, { clip: "../evil" }))).rejects.toThrow(/clip name/);
    await expect(store.write(payload(1, { outfit: "a/b" }))).rejects.toThrow(/outfit/);
    await expect(store.write(payload(1, { clipData: { nope: true } }))).rejects.toThrow(/clip/);
    await expect(store.read("chop", "20261024T100000000Z")).rejects.toMatchObject({ status: 404 });
    await expect(store.read("../x", "1")).rejects.toThrow(/clip name/);
    expect(await store.clips()).toEqual([]);
  });

  it("writes concurrently without losing or corrupting versions", async () => {
    const store = createAutosaveStore(dir);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.write(payload(i + 10, { clip: `c${i % 2}` }), at(i))));
    expect(results.every((r) => !r.skipped)).toBe(true);
    expect((await store.versions("c0")).length + (await store.versions("c1")).length).toBe(6);
  });
});
