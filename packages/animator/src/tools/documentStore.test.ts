import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToFile, createDocumentFile, hashText, historyOf, logPathFor, openDocument, readLog, serializeDocument, stepHistory } from "./documentStore.js";

const FIXTURE = new URL("../../fixtures/rigs/three-part.anim.json", import.meta.url);
let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "animator-store-"));
  path = join(dir, "rig.anim.json");
  // Canonical form first, so file bytes can be compared across undo.
  writeFileSync(path, serializeDocument(JSON.parse(readFileSync(FIXTURE, "utf8")), 1));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("document store and command log", () => {
  it("logs each batch before writing and undo/redo restore the file byte for byte", () => {
    const original = readFileSync(path, "utf8");
    applyToFile(path, [{ op: "bone.set", name: "chest", rotation: 5 }]);
    const afterFirst = readFileSync(path, "utf8");
    applyToFile(path, [{ op: "clip.add", name: "jump", duration: 0.5 }, { op: "key.set", clip: "jump", bone: "hips", timeline: "translate", time: 0.25, x: 0, y: -30 }]);
    const log = readLog(path);
    expect(log.map((entry) => entry.kind)).toEqual(["apply", "apply"]);
    expect(log[0]?.before).toBe(hashText(original));
    expect(log[1]?.after).toBe(hashText(readFileSync(path, "utf8")));
    expect(logPathFor(path)).toBe(join(dir, "rig.anim.log.ndjson"));

    expect(stepHistory(path, "undo")).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(stepHistory(path, "undo", 5)).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(stepHistory(path, "redo", 2)).toHaveLength(2);
    expect(historyOf(readLog(path))).toEqual({ undo: [1, 2], redo: [] });
    stepHistory(path, "undo");
    applyToFile(path, [{ op: "bone.set", name: "head", x: 61 }]);
    expect(historyOf(readLog(path))).toEqual({ undo: [1, 8], redo: [] });
  });

  it("a rejected batch writes nothing", () => {
    const original = readFileSync(path, "utf8");
    expect(() => applyToFile(path, [{ op: "bone.set", name: "chest", rotation: 5 }, { op: "bone.remove", name: "head" }])).toThrow(/command 2/);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readLog(path)).toEqual([]);
  });

  it("repairs the crash window: logged but not written is re-applied on open", () => {
    const original = readFileSync(path, "utf8");
    applyToFile(path, [{ op: "bone.set", name: "chest", rotation: 5 }]);
    const edited = readFileSync(path, "utf8");
    writeFileSync(path, original);
    const open = openDocument(path);
    expect(open.repaired).toBe("recovered");
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("an outside edit becomes an external entry and undo stops there; a torn log line is ignored", () => {
    applyToFile(path, [{ op: "bone.set", name: "chest", rotation: 5 }]);
    copyFileSync(path, `${path}.bak`);
    const outside = JSON.parse(readFileSync(path, "utf8"));
    outside.bones[2].rotation = 6;
    writeFileSync(path, JSON.stringify(outside, null, 2));
    appendFileSync(logPathFor(path), '{"seq": 99, "kind": "app');
    const result = applyToFile(path, [{ op: "bone.set", name: "head", x: 70 }]);
    expect(result.repaired).toBe("external");
    expect(readLog(path).map((entry) => entry.kind)).toEqual(["apply", "external", "apply"]);
    expect(stepHistory(path, "undo", 3)).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).bones[2].rotation).toBe(6);
  });

  it("creates new documents with a create entry and refuses to overwrite", () => {
    const fresh = join(dir, "fresh.anim.json");
    createDocumentFile(fresh, [{ op: "doc.new", name: "fresh", width: 100, height: 200 }]);
    expect(JSON.parse(readFileSync(fresh, "utf8")).canvas).toEqual({ width: 100, height: 200, originX: 50, originY: 200 });
    expect(readLog(fresh)[0]?.kind).toBe("create");
    expect(() => createDocumentFile(fresh, [{ op: "doc.new", name: "fresh", width: 1, height: 1 }])).toThrow(/already exists/);
    expect(stepHistory(fresh, "undo")).toEqual([]);
  });
});
