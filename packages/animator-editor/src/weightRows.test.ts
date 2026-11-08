import { describe, expect, it } from "vitest";
import { createTable, pasteTable, smoothTable, trimTable } from "./weightModel.js";

const table = (bones: string[], rows: number[][]) => {
  const t = createTable(bones, rows.length);
  rows.forEach((r, v) => t.data.set(r, v * bones.length));
  return t;
};

describe("smooth, paste and trim of weight rows", () => {
  it("smooths only the chosen vertices toward their neighbours and keeps rows summing to 1", () => {
    const t = table(["a", "b"], [[1, 0], [0, 1], [1, 0]]);
    const near = [new Set([1]), new Set([0, 2]), new Set([1])];
    const out = smoothTable(t, near, [1], 1);
    expect(Array.from(out.data.slice(2, 4))).toEqual([1, 0]);
    expect(Array.from(out.data.slice(0, 2))).toEqual([1, 0]);
    expect(Array.from(t.data.slice(2, 4))).toEqual([0, 1]);
    const half = smoothTable(t, near, null, 0.5);
    for (let v = 0; v < 3; v++) expect(half.data[v * 2]! + half.data[v * 2 + 1]!).toBeCloseTo(1, 5);
  });

  it("pastes by bone name onto the selection only, and refuses a different vertex count", () => {
    const target = table(["a", "b"], [[1, 0], [1, 0]]);
    const source = table(["b", "c"], [[1, 0], [0, 1]]);
    const out = pasteTable(target, source, [1])!;
    expect(out.bones).toEqual(["a", "b", "c"]);
    expect(Array.from(out.data)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(pasteTable(target, table(["a"], [[1]]), null)).toBeNull();
  });

  it("trims columns no vertex uses, keeping the ones asked for", () => {
    const t = table(["a", "b", "c"], [[1, 0, 0], [1, 0, 0]]);
    expect(trimTable(t).bones).toEqual(["a"]);
    expect(trimTable(t, ["c"]).bones).toEqual(["a", "c"]);
  });
});
