import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, checklist, gateRows, parsePresets, parseScales, publishedRow } from "./shipModel.js";

describe("render presets", () => {
  it("parses scale lists and refuses out-of-range ones", () => {
    expect(parseScales("0.4, 1")).toEqual([0.4, 1]);
    expect(parseScales("0.05")).toBeNull();
    expect(parseScales("1 2 1.5 1.2")).toBeNull();
    expect(parseScales("abc")).toBeNull();
  });
  it("keeps only well-formed saved presets and never shadows a built-in", () => {
    const list = parsePresets([{ label: "Mine", scales: [1], background: "FFFFFF" }, { label: "Bad", scales: [9], background: "ffffff" }, { label: BUILTIN_PRESETS[0]!.label, scales: [1], background: "ffffff" }, 4]);
    expect(list.map((p) => p.label)).toEqual(["Mine"]);
    expect(list[0]!.background).toBe("ffffff");
  });
});

describe("checklist", () => {
  const base = { rig: "pro-turned", rigUnsaved: false, clip: "walk", clipDirty: false, clipApplied: true };
  it("is all green for a saved, applied clip", () => {
    expect(checklist(base).every((r) => r.status === "ok")).toBe(true);
  });
  it("flags unsaved rigs, unsaved clips and unapplied clips", () => {
    const rows = checklist({ ...base, rigUnsaved: true, clipDirty: true, clipApplied: false });
    expect(rows.find((r) => r.id === "rig")!.status).toBe("bad");
    expect(rows.find((r) => r.id === "clip")!.status).toBe("bad");
    expect(rows.find((r) => r.id === "applied")!.status).toBe("warn");
  });
  it("shows no clip rows for a rig-only session", () => {
    expect(checklist({ ...base, clip: "", clipApplied: false }).map((r) => r.id)).toEqual(["rig", "clip"]);
  });
});

describe("published rows", () => {
  it("reads the diff", () => {
    expect(publishedRow("clip", "walk.clip.json", { added: [], changed: [], unchanged: 1 }).state).toBe("same");
    expect(publishedRow("rig", "mine", { added: ["a"], changed: [], unchanged: 0 }).state).toBe("new");
    expect(publishedRow("rig", "mine", { added: [], changed: ["a.json"], unchanged: 3, hashes: { "a.json": "abcdef0123" } }).detail).toMatch(/changed since published: 1 file \(abcdef0123\)/);
  });
});

describe("gateRows", () => {
  const run = (scope: "full" | "sampled") => ({ mode: "sample" as const, results: [{ id: "neck", label: "Neck", status: "pass" as const, summary: "Neck: passes", coverage: { scope } }, { id: "ink", label: "Ink outline", status: "fail" as const, summary: "Ink outline: 1 failing", coverage: { scope } }] });
  it("says not run before any run", () => {
    expect(gateRows(null)).toMatchObject([{ id: "gates", status: "todo" }]);
  });
  it("shows each gate with its scope and status", () => {
    const rows = gateRows(run("sampled"));
    expect(rows.map((r) => [r.id, r.status])).toEqual([["gate-neck", "ok"], ["gate-ink", "bad"]]);
    expect(rows[0]!.label).toContain("sampled");
    expect(gateRows(run("full"))[0]!.label).toContain("full check");
  });
});
