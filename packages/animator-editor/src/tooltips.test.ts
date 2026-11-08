import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { saveText, selectionText } from "./chrome.js";
import { HOTKEYS } from "./hotkeys.js";
import { keysFor, TABS, TIPS, tipText } from "./tooltips.js";

describe("tooltip table", () => {
  it("only names hotkeys that exist in the hotkey table", () => {
    for (const t of TIPS) if (t.action) expect(HOTKEYS.some((h) => h.action === t.action), `${t.sel} -> ${t.action}`).toBe(true);
  });

  it("has a description for every entry and no selector twice", () => {
    expect(new Set(TIPS.map((t) => t.sel)).size).toBe(TIPS.length);
    for (const t of TIPS) expect(t.tip.length, t.sel).toBeGreaterThan(2);
  });

  it("puts the hotkey after the description, taking it from the hotkey table", () => {
    const rotate = TIPS.find((t) => t.sel === "#gizmo [data-mode=rotate]")!;
    expect(tipText(rotate)).toBe("Rotate: drag a bone to rotate it (R)");
    expect(keysFor({ action: "redo" })).toBe(HOTKEYS.find((h) => h.action === "redo")!.keys);
    expect(tipText({ sel: "#x", tip: "No key here" })).toBe("No key here");
  });

  it("covers every static tool button and every pane in index.html", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    for (const id of ["play", "undo", "redo", "setkey", "delkey", "autokey", "graphbtn", "save", "compensate"]) expect(TIPS.some((t) => t.sel === `#${id}`), id).toBe(true);
    for (const tab of TABS) expect(html.includes(`id="pane-${tab.id}"`), tab.id).toBe(true);
  });
});

describe("every static control has a table tooltip", () => {
  it("names each button / input in index.html that has an id (Setup tool buttons and dynamic panels carry their own)", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const ids = [...html.matchAll(/<(?:button|input|select|textarea)[^>]*id="([^"]+)"/g)].map((m) => m[1]!);
    const missing = ids.filter((id) => !TIPS.some((t) => t.sel === `#${id}` || t.sel.startsWith(`#${id} `)));
    expect(missing).toEqual([]);
  });
});

describe("status bar text", () => {
  it("describes the selection", () => {
    expect(selectionText(null, [])).toBe("No bone selected");
    expect(selectionText("hand_l", ["hand_l"])).toBe("Bone: hand_l");
    expect(selectionText("hand_l", ["hand_l", "hand_r", "head"])).toBe("3 bones: hand_l + 2");
  });

  it("names the save states", () => {
    expect(saveText("saved")).toBe("Saved");
    expect(saveText("unsaved")).toBe("Unsaved");
    expect(saveText("autosaving")).toBe("Autosaving");
  });
});

describe("transform strip and canvas edge controls", () => {
  it("has a tooltip for every id they build and for the channel fields and key buttons", async () => {
    const { XFORM_IDS } = await import("./transformStrip.js");
    const { EDGE_IDS } = await import("./canvasTools.js");
    const missing = [...XFORM_IDS, ...EDGE_IDS].filter((id) => !TIPS.some((t) => t.sel === `#${id}`));
    expect(missing).toEqual([]);
    for (const ch of ["rotate", "translate", "scale", "shear"]) expect(TIPS.some((t) => t.sel === `.xf-in[data-ch=${ch}]`), ch).toBe(true);
    expect(TIPS.some((t) => t.sel === ".xf-key")).toBe(true);
  });
});

describe("animate bar controls", () => {
  it("has a tooltip for every id the Animate bar builds", async () => {
    const { TRANSPORT_IDS } = await import("./transport.js");
    const missing = TRANSPORT_IDS.filter((id) => !TIPS.some((t) => t.sel === `#${id}`));
    expect(missing).toEqual([]);
  });
});
