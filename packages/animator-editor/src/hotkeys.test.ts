import { describe, expect, it } from "vitest";
import { GESTURES, HOTKEYS, SETUP_KEYS, SETUP_SHARED, hotkeyAction } from "./hotkeys.js";

describe("hotkeys", () => {
  it("binds the standard tool and timeline keys", () => {
    const table: [Parameters<typeof hotkeyAction>[0], string][] = [
      [{ key: "r" }, "rotate"],
      [{ key: "R" }, "rotate"],
      [{ key: "t" }, "move"],
      [{ key: "s" }, "scale"],
      [{ key: "k" }, "key"],
      [{ key: "m" }, "mirror"],
      [{ key: "M", shiftKey: true }, "flipPose"],
      [{ key: "n" }, "breakdown"],
      [{ key: "Delete" }, "deleteKey"],
      [{ key: "z", ctrlKey: true }, "undo"],
      [{ key: "y", ctrlKey: true }, "redo"],
      [{ key: "Z", ctrlKey: true, shiftKey: true }, "redo"],
      [{ key: "s", ctrlKey: true }, "save"],
      [{ key: "ArrowLeft" }, "prevFrame"],
      [{ key: "ArrowRight" }, "nextFrame"],
      [{ key: "ArrowLeft", shiftKey: true }, "prevFrame5"],
      [{ key: "Home" }, "firstFrame"],
      [{ key: "End" }, "lastFrame"],
      [{ key: "f" }, "frameSelection"],
      [{ key: "F", shiftKey: true }, "fitAll"],
      [{ key: "a", ctrlKey: true }, "selectAllKeys"],
      [{ key: "A", ctrlKey: true, shiftKey: true }, "selectAllBones"],
      [{ key: "v" }, "gameView"],
      [{ key: "?", shiftKey: true }, "help"],
      [{ key: "F1" }, "help"]
    ];
    for (const [e, action] of table) expect(hotkeyAction(e), JSON.stringify(e)).toBe(action);
  });

  it("does not let a bare tool key fire under Ctrl (Ctrl+S is save, not the scale tool)", () => {
    expect(hotkeyAction({ key: "s", ctrlKey: true })).toBe("save");
    expect(hotkeyAction({ key: "r", ctrlKey: true })).toBeNull();
    expect(hotkeyAction({ key: "t", altKey: true })).toBeNull();
    expect(hotkeyAction({ key: "q" })).toBe("pinPose");
    expect(hotkeyAction({ key: "q", ctrlKey: true })).toBeNull();
    expect(hotkeyAction({ key: "k", ctrlKey: true })).toBe("palette");
    expect(hotkeyAction({ key: "k", metaKey: true })).toBe("palette");
  });

  it("gives every table row a distinct key press and keeps the cheat sheet complete", () => {
    expect(new Set(HOTKEYS.map((h) => h.action)).size).toBe(HOTKEYS.length);
    for (const h of HOTKEYS) {
      expect(h.keys.length).toBeGreaterThan(0);
      expect(h.label.length).toBeGreaterThan(0);
    }
    expect(GESTURES.length).toBeGreaterThan(4);
  });

  it("is mode-aware: Setup's V / B / T / A tool keys never reach the Animate actions", () => {
    expect(hotkeyAction({ key: "v" })).toBe("gameView");
    expect(hotkeyAction({ key: "v" }, "setup")).toBeNull();
    for (const k of SETUP_KEYS) expect(hotkeyAction({ key: k.keys.toLowerCase() }, "setup"), k.keys).toBeNull();
    expect(hotkeyAction({ key: "b" })).toBe("bonesOverlay");
    expect(hotkeyAction({ key: "f" }, "setup")).toBe("frameSelection");
    expect(hotkeyAction({ key: "?", shiftKey: true }, "setup")).toBe("help");
    for (const a of SETUP_SHARED) expect(HOTKEYS.some((h) => h.action === a), a).toBe(true);
  });

  it("gives M, N and G one meaning each and no two rows the same press", () => {
    expect(hotkeyAction({ key: "m" })).toBe("mirror");
    expect(hotkeyAction({ key: "n" })).toBe("breakdown");
    expect(hotkeyAction({ key: "g" })).toBe("graph");
    const probes = HOTKEYS.flatMap((h) => [h.keys.split(" / ")[0]!]).filter((k) => k.length === 1);
    for (const k of probes) expect(HOTKEYS.filter((h) => h.match({ key: k.toLowerCase(), ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).length, k).toBe(1);
  });

  it("keeps M as Mirror in Animate and makes it the Mesh tool in Setup; W and D are new tool keys", () => {
    expect(hotkeyAction({ key: "m" })).toBe("mirror");
    expect(hotkeyAction({ key: "m" }, "setup")).toBeNull();
    expect(SETUP_KEYS.map((k) => k.keys)).toEqual(expect.arrayContaining(["M", "W"]));
    expect(hotkeyAction({ key: "w" })).toBe("weightsTool");
    expect(hotkeyAction({ key: "d" })).toBe("shapeKeys");
  });
});
