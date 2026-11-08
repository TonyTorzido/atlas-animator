import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cellUsed, legacyAliasIn, matrixRows, parseBoard, passesFilter, rigHasWeapon, weaponSkins, withDone } from "./clipBoard.js";
import { GAME_CLIPS, matrixCell, WEAPONS } from "./gameClips.js";
import { TIPS } from "./tooltips.js";

describe("matrix", () => {
  it("has a generic row plus the six classes, and each class uses only its own weapon", () => {
    const rows = matrixRows();
    expect(rows.map((r) => r.label)).toEqual(["Generic", "Ronin", "Warrior", "Paladin", "Cleric", "Ranger", "Mage"]);
    for (const r of rows) expect(WEAPONS.filter((w) => cellUsed(r.klass, w)).length).toBe(r.klass ? 1 : 6);
  });

  it("covers every attack clip exactly once, three steps per cell", () => {
    let n = 0;
    for (const r of matrixRows()) for (const w of WEAPONS) if (cellUsed(r.klass, w)) {
      const cell = matrixCell(r.klass, w);
      expect(cell.map((c) => c.step)).toEqual([1, 2, 3]);
      n += cell.length;
    }
    expect(n).toBe(GAME_CLIPS.filter((c) => c.group === "attack").length);
  });
});

describe("filters, aliases, weapons", () => {
  it("filters by status", () => {
    expect(passesFilter("missing", "missing")).toBe(true);
    expect(passesFilter("draft", "missing")).toBe(false);
    expect(passesFilter("broken", "problems")).toBe(true);
    expect(passesFilter("needs-recheck", "problems")).toBe(true);
    expect(passesFilter("done", "problems")).toBe(false);
    expect(passesFilter("done", "all")).toBe(true);
  });

  it("finds a clip under its legacy name only when the new name is absent", () => {
    expect(legacyAliasIn("idle", new Set(["idle_weight_shift"]))).toBe("idle_weight_shift");
    expect(legacyAliasIn("idle", new Set(["idle", "idle_weight_shift"]))).toBeNull();
    expect(legacyAliasIn("run", new Set(["run"]))).toBeNull();
  });

  it("knows which weapons the rig draws", () => {
    const skins = { body: { attachments: { weapon: { double_axe: {} } } } };
    expect(rigHasWeapon(skins, "axe")).toBe(true);
    expect(rigHasWeapon(skins, "bow")).toBe(false);
    expect(rigHasWeapon(skins, null)).toBe(true);
    expect(weaponSkins(["body", "weapon/axe"], "axe")).toEqual(["weapon/axe"]);
    expect(weaponSkins(["body"], "axe")).toEqual([]);
  });

  it("reads and updates the board file", () => {
    expect(parseBoard({ a: { done: true, rigHash: "x", updated: "t" }, b: { done: "no" }, c: 5 })).toEqual({ a: { done: true, rigHash: "x", updated: "t" } });
    expect(parseBoard(null)).toEqual({});
    expect(withDone({}, "a", true, "h", "now")).toEqual({ a: { done: true, rigHash: "h", updated: "now" } });
  });
});

describe("tooltips", () => {
  it("has a table entry for every control id the board creates", () => {
    const src = readFileSync(new URL("./clipBoard.ts", import.meta.url), "utf8");
    const ids = [...src.matchAll(/\.id = "([^"]+)"/g)].map((m) => m[1]!).filter((id) => id !== "clipboard");
    expect(ids.length).toBeGreaterThan(3);
    const spans = new Set(["cb-progress-text", "cb-notice", "cb-standin"]);
    for (const id of ids) if (!spans.has(id) || id === "cb-standin") expect(TIPS.some((t) => t.sel === `#${id}`), id).toBe(true);
  });
});
