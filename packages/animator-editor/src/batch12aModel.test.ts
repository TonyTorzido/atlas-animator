import { describe, expect, it } from "vitest";
import { emptyClip } from "./clipModel.js";
import { keyedRows, rowChannels } from "./dopesheetModel.js";
import { addChannelKey, keyChannels, setKeyFields, targetRow } from "./keyInspectorModel.js";

const clip = () => emptyClip(2);

describe("sequence keys in the dopesheet and key inspector (Batch 12a)", () => {
  it("a new sequence key starts as loop, frame 0, 0.1 s and shows on its own row", () => {
    const next = addChannelKey(clip(), { kind: "sequence", slot: "fx" }, 0.5, {}, { mode: "loop", index: 0, delay: 0.1 });
    expect(keyedRows(next)).toEqual(["seq:fx"]);
    expect(targetRow({ kind: "sequence", slot: "fx" })).toBe("seq:fx");
    const [ch] = keyChannels(next, "seq:fx", 0.5);
    expect(ch?.channel).toBe("sequence");
    expect(ch?.fields.map((f) => [f.id, f.kind])).toEqual([["mode", "choice"], ["index", "number"], ["delay", "number"]]);
    expect(ch?.fields[0]?.options).toEqual(["hold", "once", "loop", "pingpong"]);
  });
  it("the mode and delay are editable", () => {
    let next = addChannelKey(clip(), { kind: "sequence", slot: "fx" }, 0, {});
    next = setKeyFields(next, "seq:fx", 0, "sequence", { mode: "pingpong", delay: 0.2 });
    expect((next.slots["fx"] as unknown as { sequence: { mode: string; delay: number }[] }).sequence[0]).toMatchObject({ mode: "pingpong", delay: 0.2 });
    expect(rowChannels(next, "seq:fx")[0]?.keys).toHaveLength(1);
  });
});
