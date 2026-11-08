import { describe, expect, it } from "vitest";
import { CLIP_BASE_NEW, checkClipBase, copyClipName, textHash } from "./clipConflict.js";

describe("textHash", () => {
  it("is stable, 14 hex digits, and tells texts apart", () => {
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).toMatch(/^[0-9a-f]{14}$/);
    expect(textHash("abc")).not.toBe(textHash("abd"));
    expect(textHash('{"duration":1}')).not.toBe(textHash('{"duration":1}\n'));
  });
});

describe("checkClipBase", () => {
  const disk = '{"duration":1}';
  it("lets unchecked saves (no header) through", () => {
    expect(checkClipBase("a.clip.json", undefined, disk)).toEqual({ ok: true });
  });
  it("accepts a save whose base is the file on disk", () => {
    expect(checkClipBase("a.clip.json", textHash(disk), disk)).toEqual({ ok: true });
  });
  it("refuses a stale base (another tab saved in between)", () => {
    const v = checkClipBase("a.clip.json", textHash('{"duration":2}'), disk);
    expect(v).toMatchObject({ ok: false, current: textHash(disk) });
    expect(!v.ok && v.message).toMatch(/another tab\/window/);
  });
  it("a new clip may be written only when no saved file exists", () => {
    expect(checkClipBase("a.clip.json", CLIP_BASE_NEW, null)).toEqual({ ok: true });
    expect(checkClipBase("a.clip.json", CLIP_BASE_NEW, disk)).toMatchObject({ ok: false, current: textHash(disk) });
  });
  it("a file deleted under the tab is a conflict too", () => {
    expect(checkClipBase("a.clip.json", textHash(disk), null)).toMatchObject({ ok: false, current: null });
  });
});

describe("copyClipName", () => {
  it("finds a free copy name", () => {
    const taken = new Set(["walk_copy", "walk_copy2"]);
    expect(copyClipName("walk", (n) => taken.has(n))).toBe("walk_copy3");
    expect(copyClipName("run", () => false)).toBe("run_copy");
  });
});
