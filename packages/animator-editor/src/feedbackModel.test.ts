import { describe, expect, it } from "vitest";
import { clipDownloadMessage, discardedMessage, keyPoseTip, loopMessage, spineExportLines, spineExportStatus, unkeyedBones, unkeyedChip, unkeyedStripText } from "./feedbackModel.js";

describe("feedback text", () => {
  it("words the loop toggle from the state it ended in", () => {
    expect(loopMessage(true)).toMatch(/^Loop on/);
    expect(loopMessage(false)).toMatch(/^Loop off/);
  });
  it("counts each unkeyed bone once across channels", () => {
    expect(unkeyedBones({ a: 1, b: 2 }, { a: { x: 1 } }, {}, { c: 0 })).toEqual(["a", "b", "c"]);
    expect(unkeyedChip(0)).toBe("");
    expect(unkeyedChip(2)).toBe("2 unkeyed");
    expect(keyPoseTip("Key pose", 0)).toBe("Key pose");
    expect(keyPoseTip("Key pose", 1)).toContain("1 bone moved but not keyed");
    expect(unkeyedStripText(3)).toBe("3 bones not keyed");
    expect(unkeyedStripText(1)).toBe("Not keyed");
    expect(discardedMessage(1)).toBe("Dropped the unkeyed pose on 1 bone");
  });
  it("reports where a Spine export went", () => {
    const s = { json: "C:/x/rig.json", images: 1, clips: ["idle"], deformTimelines: 0, linkedMeshes: 2, warnings: ["w"] };
    expect(spineExportLines(s)[0]).toBe("Wrote C:/x/rig.json");
    expect(spineExportLines(s)[1]).toBe("1 image, 1 clip, 0 deform timelines, 2 linked meshes.");
    expect(spineExportStatus(s)).toContain("1 warning");
    expect(clipDownloadMessage("a.clip.json")).toContain("Downloads");
  });
});
