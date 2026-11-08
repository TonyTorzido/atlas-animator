import { describe, expect, it } from "vitest";
import { HOTKEYS, hotkeyAction } from "./hotkeys.js";
import { ROOT_WARNING, clipKeysRoot, hitsRootGlyph, rootLabel } from "./rootMaster.js";

describe("root master control", () => {
  it("hits the glyph within the pick radius at any zoom", () => {
    expect(hitsRootGlyph(5, 0, 0, 0, 1)).toBe(true);
    expect(hitsRootGlyph(40, 0, 0, 0, 1)).toBe(false);
    expect(hitsRootGlyph(40, 0, 0, 0, 0.25)).toBe(true);
  });
  it("sees root keys on any channel", () => {
    expect(clipKeysRoot(undefined)).toBe(false);
    expect(clipKeysRoot({ bones: {} } as never)).toBe(false);
    expect(clipKeysRoot({ bones: { root: { translate: [] } } } as never)).toBe(false);
    expect(clipKeysRoot({ bones: { root: { translate: [{ time: 0, x: 1, y: 0 }] } } } as never)).toBe(true);
  });
  it("flags root motion in Animate only", () => {
    expect(rootLabel(true, true, true).warn).toBe(false);
    expect(rootLabel(false, false, false)).toEqual({ text: "ROOT", warn: false });
    expect(rootLabel(false, true, false).text).toContain(ROOT_WARNING);
  });
  it("Shift+R selects root and no other key row uses it", () => {
    const e = { key: "R", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false };
    expect(hotkeyAction(e)).toBe("selectRoot");
    expect(HOTKEYS.filter((h) => h.match(e)).length).toBe(1);
  });
});
