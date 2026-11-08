import { describe, expect, it } from "vitest";
import { applyPatch, getAt, parsePatch, parsePointer, PatchError, pointer, type JsonValue, type PatchOperation } from "./jsonPatch.js";

const text = (value: JsonValue) => JSON.stringify(value, null, 1);

/** Applies, checks the expected result, then checks the inverse restores the input byte-for-byte. */
function roundTrip(doc: JsonValue, patch: PatchOperation[], expected: JsonValue): void {
  const before = text(doc);
  const { doc: after, inverse } = applyPatch(doc, patch);
  expect(after).toEqual(expected);
  expect(text(doc), "input untouched").toBe(before);
  expect(text(applyPatch(after, inverse).doc)).toBe(before);
}

describe("JSON pointers", () => {
  it("escapes and parses ~ and /", () => {
    expect(pointer("a/b", "c~d", 0)).toBe("/a~1b/c~0d/0");
    expect(parsePointer("/a~1b/c~0d/0")).toEqual(["a/b", "c~d", "0"]);
    expect(parsePointer("")).toEqual([]);
    expect(() => parsePointer("a")).toThrow(PatchError);
    expect(() => parsePointer("/a~2")).toThrow(/escape/);
  });

  it("reads values and reports missing paths as undefined", () => {
    const doc = { a: [{ b: 1 }], "x/y": null };
    expect(getAt(doc, "/a/0/b")).toBe(1);
    expect(getAt(doc, "/x~1y")).toBeNull();
    expect(getAt(doc, "/a/1")).toBeUndefined();
    expect(getAt(doc, "/a/-")).toBeUndefined();
  });
});

describe("applyPatch with inverses", () => {
  it("add/remove/replace on objects and arrays round-trip", () => {
    const doc = { a: 1, b: [1, 2, 3], c: { d: true } };
    roundTrip(doc, [{ op: "add", path: "/e", value: { f: [1] } }], { a: 1, b: [1, 2, 3], c: { d: true }, e: { f: [1] } });
    roundTrip(doc, [{ op: "add", path: "/b/1", value: 9 }], { a: 1, b: [1, 9, 2, 3], c: { d: true } });
    roundTrip(doc, [{ op: "add", path: "/b/-", value: 4 }], { a: 1, b: [1, 2, 3, 4], c: { d: true } });
    roundTrip(doc, [{ op: "remove", path: "/b/0" }], { a: 1, b: [2, 3], c: { d: true } });
    roundTrip(doc, [{ op: "replace", path: "/c/d", value: false }], { a: 1, b: [1, 2, 3], c: { d: false } });
    roundTrip(doc, [{ op: "add", path: "/a", value: 2 }], { a: 2, b: [1, 2, 3], c: { d: true } });
  });

  it("restores object key order when a middle key is removed", () => {
    const doc = { first: 1, middle: 2, last: 3 };
    const { doc: after, inverse } = applyPatch(doc, [{ op: "remove", path: "/middle" }]);
    expect(Object.keys(after as object)).toEqual(["first", "last"]);
    expect(Object.keys(applyPatch(after, inverse).doc as object)).toEqual(["first", "middle", "last"]);
    roundTrip(doc, [{ op: "remove", path: "/last" }], { first: 1, middle: 2 });
  });

  it("move and copy (including within one array) round-trip", () => {
    const doc = { list: ["a", "b", "c", "d"], o: { x: 1 } };
    roundTrip(doc, [{ op: "move", from: "/list/0", path: "/list/2" }], { list: ["b", "c", "a", "d"], o: { x: 1 } });
    roundTrip(doc, [{ op: "move", from: "/o/x", path: "/y" }], { list: ["a", "b", "c", "d"], o: {}, y: 1 });
    roundTrip(doc, [{ op: "copy", from: "/list", path: "/o/copy" }], { list: ["a", "b", "c", "d"], o: { x: 1, copy: ["a", "b", "c", "d"] } });
  });

  it("a multi-operation patch undoes in reverse order, root replace included", () => {
    const doc = { a: [1], b: { c: 1 } };
    roundTrip(
      doc,
      [
        { op: "add", path: "/a/0", value: 0 },
        { op: "replace", path: "/b", value: { c: 2, d: 3 } },
        { op: "remove", path: "/b/c" },
        { op: "test", path: "/b/d", value: 3 }
      ],
      { a: [0, 1], b: { d: 3 } }
    );
    roundTrip(doc, [{ op: "replace", path: "", value: { fresh: true } }], { fresh: true });
  });

  it("is atomic and names the failing operation", () => {
    const doc = { a: [1, 2] };
    const attempt = () =>
      applyPatch(doc, [
        { op: "add", path: "/a/0", value: 0 },
        { op: "remove", path: "/missing" }
      ]);
    expect(attempt).toThrow(/patch operation 1 \(remove \/missing\)/);
    expect(doc).toEqual({ a: [1, 2] });
    expect(() => applyPatch(doc, [{ op: "replace", path: "/a/5", value: 1 }])).toThrow(/out of range/);
    expect(() => applyPatch(doc, [{ op: "test", path: "/a/0", value: 9 }])).toThrow(/test failed/);
    expect(() => applyPatch(doc, [{ op: "move", from: "/a", path: "/a/0" }])).toThrow(/own child/);
    expect(() => applyPatch(doc, [{ op: "add", path: "/a/x", value: 1 }])).toThrow(/not an array index/);
  });

  it("parsePatch rejects malformed operations", () => {
    expect(parsePatch([{ op: "remove", path: "/a" }])).toEqual([{ op: "remove", path: "/a" }]);
    expect(() => parsePatch({})).toThrow(/array/);
    expect(() => parsePatch([{ op: "add", path: "/a" }])).toThrow(/needs a 'value'/);
    expect(() => parsePatch([{ op: "move", path: "/a" }])).toThrow(/'from'/);
    expect(() => parsePatch([{ op: "frob", path: "/a" }])).toThrow(/unknown op/);
  });
});
