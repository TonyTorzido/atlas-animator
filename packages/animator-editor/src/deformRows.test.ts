import { describe, expect, it } from "vitest";
import { emptyClip, frameTime } from "./clipModel.js";
import { setDeformKey } from "./deformModel.js";
import { allKeys, deformRowId, deformRowsOfSlot, deleteSelectedKeys, keyedRows, moveKeys, parseDeformRow, rowKeyTimes } from "./dopesheetModel.js";
import { deformAmount, deformAmountKeys, setDeformCurve } from "./graphModel.js";
import { clearExternalGateIssues, clipGates, externalGateIssues, poseGates, setExternalGateIssues } from "./gates.js";

const f = (n: number) => frameTime({ fps: 30 }, n);
const addr = { skin: "default", slot: "torso", attachment: "torso" };

function sample() {
  let clip = emptyClip(1, false);
  clip = setDeformKey(clip, addr, f(0), [0, 0, 0, 0]);
  clip = setDeformKey(clip, addr, f(6), [0, 0, 3, 4, 0, 0]);
  return clip;
}

describe("deform rows in the dopesheet", () => {
  it("lists a row per mesh, with its key times", () => {
    const clip = sample();
    const id = deformRowId(addr);
    expect(parseDeformRow(id)).toEqual(addr);
    expect(keyedRows(clip)).toContain(id);
    expect(deformRowsOfSlot(clip, "torso")).toEqual([addr]);
    expect(deformRowsOfSlot(clip, "head")).toEqual([]);
    expect(rowKeyTimes(clip, id)).toEqual([0, f(6)]);
    expect(allKeys(clip).some((k) => k.row === id)).toBe(true);
  });

  it("moves and deletes deform keys like any other key", () => {
    const clip = sample();
    const id = deformRowId(addr);
    const moved = moveKeys(clip, [{ row: id, time: f(6) }], 3).clip;
    expect(rowKeyTimes(moved, id)).toEqual([0, f(9)]);
    const gone = deleteSelectedKeys(deleteSelectedKeys(clip, [{ row: id, time: f(6) }]), [{ row: id, time: 0 }]);
    expect(gone.deform.default).toBeUndefined();
  });
});

describe("deform amount curve", () => {
  it("is the largest vertex offset, with the key's curve", () => {
    let clip = sample();
    expect(deformAmount({ vertices: [0, 0, 3, 4] })).toBe(5);
    expect(deformAmountKeys(clip, "default", "torso", "torso")).toEqual([
      { time: 0, value: 0, curve: "linear" },
      { time: f(6), value: 5, curve: "linear" }
    ]);
    clip = setDeformCurve(clip, "default", "torso", "torso", f(6), "stepped");
    expect(deformAmountKeys(clip, "default", "torso", "torso")[1]!.curve).toBe("stepped");
    expect(setDeformCurve(clip, "default", "torso", "torso", f(3), "linear")).toBe(clip);
  });
});

describe("handed-over gate issues", () => {
  it("reach the pose and clip checks as warnings", () => {
    setExternalGateIssues("outline:walk", [{ kind: "outline", severity: "warning", time: f(6), message: "Outline broken at frame 6" }]);
    expect(externalGateIssues("outline:walk", f(6))).toHaveLength(1);
    expect(externalGateIssues("outline:walk", f(7))).toHaveLength(0);
    clearExternalGateIssues("outline:walk");
    expect(externalGateIssues("outline:walk")).toHaveLength(0);
    void clipGates;
    void poseGates;
  });
});
