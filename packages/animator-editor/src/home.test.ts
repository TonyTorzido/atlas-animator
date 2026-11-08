import { describe, expect, it } from "vitest";
import { clipState, milestones, pushRecent, pushRecentRig, recentClips } from "./home.js";

describe("home helpers", () => {
  it("puts the newest clip first without duplicates and caps the list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a"], "")).toEqual(["a"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  it("keeps only recent clips that still exist, in recent order", () => {
    const clips = [
      { name: "walk", dirty: false },
      { name: "idle", dirty: true }
    ];
    expect(recentClips(["idle", "gone", "walk"], clips).map((c) => c.name)).toEqual(["idle", "walk"]);
  });

  it("keeps one row per rig, newest first", () => {
    const a = { id: "a", label: "A", clip: "walk", ws: "animate", at: 1 };
    const b = { id: "b", label: "B", clip: "", ws: "rig", at: 2 };
    expect(pushRecentRig([a], b).map((r) => r.id)).toEqual(["b", "a"]);
    expect(pushRecentRig([b, a], { ...a, at: 3 }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("lists project milestones from what exists", () => {
    const m = milestones({ slots: 4, bones: 1, images: 3, weighted: false, clips: 0, checked: false });
    expect(m.map((x) => x.done)).toEqual([true, false, false, false, false]);
  });

  it("describes a clip's state", () => {
    expect(clipState({ name: "x", dirty: true })).toBe("unsaved draft");
    expect(clipState({ name: "x", dirty: false })).toBe("saved");
  });
});
