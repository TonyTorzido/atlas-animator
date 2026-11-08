import { describe, expect, it } from "vitest";
import { AUTOSAVE_FORMAT, AUTOSAVE_KEEP, ago, fingerprint, flagsOf, newerThanSaved, parseVersionFile, pruneVersions, sortVersions, versionFile, versionId, versionTime, type AutosavePayload } from "./autosaveModel.js";
import { offersFrom, whenLabel, type Listing } from "./historyPanel.js";

const payload = (over: Partial<AutosavePayload> = {}): AutosavePayload => ({ format: AUTOSAVE_FORMAT, clip: "chop", outfit: "pro-front", reason: "interval", savedAt: "2026-10-24T10:00:00.000Z", clipData: { duration: 1, loop: false, bones: {} }, ...over });

describe("autosave version names", () => {
  it("round-trips a timestamp to the millisecond and sorts as time", () => {
    const d = new Date(Date.UTC(2026, 9, 24, 10, 15, 0, 123));
    expect(versionId(d)).toBe("20261024T101500123Z");
    expect(versionTime(versionId(d))).toBe(d.getTime());
    const a = versionId(new Date(Date.UTC(2026, 9, 24, 10, 15, 0, 123)));
    const b = versionId(new Date(Date.UTC(2026, 9, 24, 10, 15, 0, 124)));
    expect(a < b).toBe(true);
  });
  it("encodes flags and the outfit in the file name and reads them back", () => {
    const flags = flagsOf({ rig: { document: "x", skins: { skins: {}, setup: {} }, setup: { batches: [], undo: 0 } } });
    expect(flags).toBe("csu");
    expect(flagsOf({})).toBe("c");
    const file = versionFile("20261024T101500123Z", flags, "pro-front");
    expect(parseVersionFile(file, 42)).toMatchObject({ id: "20261024T101500123Z", flags: "csu", outfit: "pro-front", bytes: 42 });
    expect(parseVersionFile("notes.txt")).toBeNull();
    expect(parseVersionFile("20261024T101500123Z.c.pro-front.json.tmp")).toBeNull();
    expect(() => versionFile("x", "c", "../etc")).toThrow(/outfit/);
  });
});

describe("keeping the newest 30", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ id: versionId(new Date(Date.UTC(2026, 9, 24, 10, 0, i))), time: Date.UTC(2026, 9, 24, 10, 0, i) }));
  it("prunes the oldest beyond the limit and nothing below it", () => {
    expect(AUTOSAVE_KEEP).toBe(30);
    expect(pruneVersions(make(30))).toEqual([]);
    const gone = pruneVersions(make(34));
    expect(gone).toHaveLength(4);
    expect(gone.map((v) => v.time)).toEqual([Date.UTC(2026, 9, 24, 10, 0, 3), Date.UTC(2026, 9, 24, 10, 0, 2), Date.UTC(2026, 9, 24, 10, 0, 1), Date.UTC(2026, 9, 24, 10, 0, 0)]);
    expect(sortVersions(make(3))[0]!.time).toBe(Date.UTC(2026, 9, 24, 10, 0, 2));
  });
});

describe("fingerprint", () => {
  it("ignores timestamps and reasons, sees any content change", () => {
    expect(fingerprint(payload())).toBe(fingerprint(payload({ reason: "switch", savedAt: "2026-10-25T00:00:00.000Z" })));
    expect(fingerprint(payload())).not.toBe(fingerprint(payload({ clipData: { duration: 2, loop: false, bones: {} } })));
    expect(fingerprint(payload())).not.toBe(fingerprint(payload({ rig: { document: "d", setup: { batches: [[]], undo: 0 } } })));
  });
});

describe("the Restore offer", () => {
  const v = (time: number, flags = "c") => ({ id: versionId(new Date(time)), time, flags, outfit: "pro-front", bytes: 10 });
  it("offers when the autosave is newer than the clip file, or the clip was never saved", () => {
    const saved = { clips: { chop: 1000 }, rigs: { "rig.anim.json": 500 } };
    expect(newerThanSaved("chop", v(2000), "rig.anim.json", saved)).toEqual({ clip: true, rig: false });
    expect(newerThanSaved("chop", v(900), "rig.anim.json", saved)).toEqual({ clip: false, rig: false });
    // never saved as a clip file: the rig document stands in
    expect(newerThanSaved("fresh", v(400), "rig.anim.json", saved)).toEqual({ clip: false, rig: false });
    expect(newerThanSaved("fresh", v(600), "rig.anim.json", saved)).toEqual({ clip: true, rig: false });
    expect(newerThanSaved("fresh", v(600), null, saved)).toEqual({ clip: true, rig: false });
  });
  it("offers unsaved rig edits against the rig document", () => {
    const saved = { clips: { chop: 5000 }, rigs: { "rig.anim.json": 3000 } };
    expect(newerThanSaved("chop", v(4000, "csu"), "rig.anim.json", saved)).toEqual({ clip: false, rig: true });
    expect(newerThanSaved("chop", v(2000, "csu"), "rig.anim.json", saved)).toEqual({ clip: false, rig: false });
  });
  it("lists the clips to offer from the newest version and skips dismissed ones", () => {
    const listing: Listing = { clips: { chop: [v(3000), v(1000)], walk: [v(100)] }, saved: { clips: { chop: 2000, walk: 200 }, rigs: {} } };
    const doc = () => null;
    expect(offersFrom(listing, doc, new Set()).map((o) => o.clip)).toEqual(["chop"]);
    expect(offersFrom(listing, doc, new Set([`chop/${v(3000).id}`]))).toEqual([]);
  });
});

describe("labels", () => {
  it("reads the age and the clock", () => {
    expect(ago(4000)).toBe("4 s ago");
    expect(ago(125_000)).toBe("2 min ago");
    expect(ago(3 * 3600_000)).toBe("3 h ago");
    expect(ago(3 * 86_400_000)).toBe("3 d ago");
    const t = new Date(2026, 9, 24, 14, 5, 9).getTime();
    expect(whenLabel(t, new Date(2026, 9, 24, 20, 0, 0).getTime())).toBe("14:05:09");
    expect(whenLabel(t, new Date(2026, 9, 26, 20, 0, 0).getTime())).toMatch(/14:05:09/);
  });
});
