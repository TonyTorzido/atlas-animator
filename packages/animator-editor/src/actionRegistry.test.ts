import { describe, expect, it } from "vitest";
import { HOTKEYS } from "./hotkeys.js";
import { allActions, fuzzyScore, hotkeyActions, pushRecent, rankActions, registerActions, shortLabel, type PaletteAction } from "./actionRegistry.js";

const act = (id: string, label: string, group = "G"): PaletteAction => ({ id, label, group, run: () => undefined });

describe("fuzzyScore", () => {
  it("matches substrings above scattered letters, and rejects misses", () => {
    expect(fuzzyScore("rot", "Rotate tool")!).toBeGreaterThan(fuzzyScore("rotool", "Rotate tool")!);
    expect(fuzzyScore("rotate", "Render contact sheets")).toBeNull();
    expect(fuzzyScore("xyz", "Rotate tool")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("go an", "Go to Animate")).not.toBeNull();
  });
});

describe("registry", () => {
  it("turns every hotkey row (but the palette) into a palette row automatically", () => {
    const ran: string[] = [];
    const rows = hotkeyActions((a) => void ran.push(a));
    expect(rows.length).toBe(HOTKEYS.length - 1);
    const rot = rows.find((r) => r.id === "hotkey:rotate")!;
    expect(rot.label).toBe("Rotate tool");
    expect(rot.keys).toBe("R");
    rot.run();
    expect(ran).toEqual(["rotate"]);
    expect(rows.some((r) => r.id === "hotkey:pinPose")).toBe(true);
  });
  it("reads providers every time and keeps the first of a repeated id", () => {
    let n = 0;
    const off = registerActions("t", () => [act("a", "A"), act("a", "A again"), act(`b${n++}`, "B")]);
    expect(allActions().filter((a) => a.id.startsWith("a") || a.id.startsWith("b")).map((a) => a.id)).toEqual(["a", "b0"]);
    expect(allActions().some((a) => a.id === "b1")).toBe(true);
    off();
    expect(allActions().some((a) => a.id === "a")).toBe(false);
  });
  it("shortens long hotkey labels", () => {
    expect(shortLabel("Shape keys tool (Animate): deform")).toBe("Shape keys tool");
    expect(shortLabel("Key the selected bones at the playhead")).toBe("Key the selected bones at the playhead");
  });
});

describe("rankActions", () => {
  const list = [act("1", "Rotate tool"), act("2", "Move tool"), act("3", "Go to Animate workspace"), act("4", "Onion skin")];
  it("floats recents to the top with no query", () => {
    expect(rankActions(list, "", ["4", "2"]).map((a) => a.id)).toEqual(["4", "2", "1", "3"]);
  });
  it("ranks by match with a query and lifts recents on a tie", () => {
    expect(rankActions(list, "anim", [])[0]!.id).toBe("3");
    expect(rankActions(list, "tool", []).map((a) => a.id).sort()).toEqual(["1", "2"]);
    expect(rankActions(list, "tool", ["2"])[0]!.id).toBe("2");
    expect(rankActions(list, "zzz", [])).toEqual([]);
  });
  it("keeps a bounded most-recent-first list", () => {
    let r: string[] = [];
    for (let i = 0; i < 20; i++) r = pushRecent(r, `a${i}`);
    expect(r.length).toBe(12);
    expect(pushRecent(["x", "y"], "y")).toEqual(["y", "x"]);
  });
});
