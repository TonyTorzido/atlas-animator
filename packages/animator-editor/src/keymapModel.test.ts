import { describe, expect, it } from "vitest";
import { chordMatches, chordOfEvent, chordsOfText, findConflicts, formatChord, parseChord, parseKeymap } from "./keymapModel.js";

describe("chords", () => {
  it("parses and formats", () => {
    expect(formatChord(parseChord("ctrl+shift+k")!)).toBe("Ctrl+Shift+K");
    expect(parseChord("Left")).toEqual({ key: "ArrowLeft", ctrl: false, shift: false, alt: false });
    expect(parseChord("Ctrl+Hyper+K")).toBeNull();
    expect(parseChord("")).toBeNull();
  });
  it("reads a keys text with alternatives", () => {
    expect(chordsOfText("Ctrl+Y / Ctrl+Shift+Z").map(formatChord)).toEqual(["Ctrl+Y", "Ctrl+Shift+Z"]);
    expect(chordsOfText(", / Alt+Left").map(formatChord)).toEqual([",", "Alt+Left"]);
  });
  it("matches key presses, with shift implied by symbols", () => {
    expect(chordMatches(parseChord("J")!, { key: "j" })).toBe(true);
    expect(chordMatches(parseChord("J")!, { key: "J", shiftKey: true })).toBe(false);
    expect(chordMatches(parseChord("K")!, { key: "j" })).toBe(false);
    expect(chordMatches(parseChord("?")!, { key: "?", shiftKey: true })).toBe(true);
    expect(chordMatches(parseChord("Ctrl+Z")!, { key: "z", metaKey: true })).toBe(true);
  });
  it("makes a chord from an event and ignores bare modifiers", () => {
    expect(chordOfEvent({ key: "Shift", shiftKey: true })).toBeNull();
    expect(formatChord(chordOfEvent({ key: "K", shiftKey: true, ctrlKey: true })!)).toBe("Ctrl+Shift+K");
  });
});

describe("keymap file", () => {
  const known = new Set(["key", "undo"]);
  it("keeps well-formed rows for known actions only", () => {
    expect(parseKeymap({ bindings: { key: "j", undo: "Ctrl+Hyper+Z", ghost: "Q" } }, known)).toEqual({ key: "J" });
    expect(parseKeymap(null, known)).toEqual({});
  });
  it("flags a chord two actions share", () => {
    const m = new Map([["key", chordsOfText("J")], ["other", chordsOfText("J / Alt+J")], ["undo", chordsOfText("Ctrl+Z")]]);
    expect(findConflicts(m)).toEqual([{ chord: "J", actions: ["key", "other"] }]);
  });
});
