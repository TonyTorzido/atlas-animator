import { describe, expect, it } from "vitest";
import { TABS } from "./tooltips.js";
import { allowedTabs, homeKey, parseWorkspace, shownIn, WORKSPACES } from "./workspace.js";

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false });

describe("workspaces", () => {
  it("lists the six workspaces, Pro and Home unfiltered", () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual(["home", "animate", "swag", "rig", "ship", "pro"]);
    expect(allowedTabs("pro")).toBeNull();
    expect(allowedTabs("home")).toBeNull();
  });

  it("only allows tabs that exist", () => {
    for (const w of WORKSPACES) for (const t of w.tabs ?? []) expect(TABS.some((x) => x.id === t), `${w.id}/${t}`).toBe(true);
  });

  it("follows the plan's tab table", () => {
    expect(allowedTabs("animate")).toEqual(["pose", "keys", "library"]);
    expect(allowedTabs("swag")).toEqual(["preview"]);
    expect(allowedTabs("rig")).toEqual(["rig", "skins"]);
    expect(allowedTabs("ship")).toEqual(["export"]);
  });

  it("parses a remembered value", () => {
    expect(parseWorkspace("rig")).toBe("rig");
    expect(parseWorkspace("nope")).toBeNull();
    expect(parseWorkspace(null)).toBeNull();
  });

  it("shows header groups by workspace", () => {
    expect(shownIn("animate pro", "pro")).toBe(true);
    expect(shownIn("animate pro", "ship")).toBe(false);
    expect(shownIn("animate pro", "home")).toBe(false);
  });

  it("sends H Home only where Hand IK is not in use, and Shift+H everywhere", () => {
    expect(homeKey(key("h"), "animate")).toBe(false);
    expect(homeKey(key("h"), "pro")).toBe(false);
    expect(homeKey(key("h"), "rig")).toBe(true);
    expect(homeKey(key("H", true), "animate")).toBe(true);
    expect(homeKey(key("H", true), "home")).toBe(false);
    expect(homeKey({ ...key("h"), ctrlKey: true }, "rig")).toBe(false);
  });
});
