import { describe, expect, it } from "vitest";
import { HOTKEYS } from "./hotkeys.js";
import { WORKSPACE_IDS } from "./workspace.js";
import { GUIDES, guideKeys, needsFirstRun, parseSeen, showAnimateEmpty, workspaceForKey } from "./workspaceGuide.js";

const key = (o: Partial<Parameters<typeof workspaceForKey>[0]>) => ({ key: "1", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe("workspace guide", () => {
  it("has a guide with keys for every workspace, and every named action exists in the hotkey table", () => {
    for (const id of WORKSPACE_IDS) {
      expect(GUIDES[id].keys.length, id).toBeGreaterThan(1);
      for (const k of GUIDES[id].keys) if (typeof k === "string") expect(HOTKEYS.some((h) => h.action === k), `${id}: ${k}`).toBe(true);
    }
  });

  it("takes the key text from the hotkey table", () => {
    const keys = guideKeys("animate");
    expect(keys.find((k) => k.label === "Key the selected bones")?.keys).toBe("K");
    expect(keys.find((k) => k.label === "Undo")?.keys).toBe("Ctrl+Z");
    expect(keys.every((k) => k.keys && k.label)).toBe(true);
  });

  it("maps Alt+1 to Alt+6 onto the workspace bar order and nothing else", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((d) => workspaceForKey(key({ key: d })))).toEqual(["home", "animate", "swag", "rig", "ship", "pro"]);
    expect(workspaceForKey(key({ key: "7" }))).toBeNull();
    expect(workspaceForKey(key({ key: "1", altKey: false }))).toBeNull();
    expect(workspaceForKey(key({ key: "1", ctrlKey: true }))).toBeNull();
    expect(workspaceForKey(key({ key: "!", code: "Digit1", shiftKey: true }))).toBeNull();
    expect(workspaceForKey(key({ key: "¡", code: "Digit1" }))).toBe("home");
  });

  it("shows the first-run card once per work workspace and never on Home", () => {
    expect(needsFirstRun([], "animate")).toBe(true);
    expect(needsFirstRun(["animate"], "animate")).toBe(false);
    expect(needsFirstRun([], "home")).toBe(false);
  });

  it("reads the remembered list defensively", () => {
    expect(parseSeen(null)).toEqual([]);
    expect(parseSeen("nonsense")).toEqual([]);
    expect(parseSeen('["animate","bogus",3]')).toEqual(["animate"]);
  });

  it("shows the Animate empty state only with no clip open outside Setup", () => {
    expect(showAnimateEmpty("animate", "", false)).toBe(true);
    expect(showAnimateEmpty("animate", "idle", false)).toBe(false);
    expect(showAnimateEmpty("animate", "", true)).toBe(false);
    expect(showAnimateEmpty("pro", "", false)).toBe(false);
  });
});
