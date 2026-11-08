import { describe, expect, it } from "vitest";
import { clipAfterDelete, startClipName } from "./startClip.js";

describe("startClip", () => {
  it("opens a rig with no clips on no clip, not a broken one", () => {
    expect(startClipName([])).toBe("");
    expect(clipAfterDelete(["only"], "only")).toBe("");
  });
  it("prefers user_pose, then walk_in_place, then the first", () => {
    expect(startClipName(["a", "walk_in_place", "user_pose"])).toBe("user_pose");
    expect(startClipName(["a", "walk_in_place"])).toBe("walk_in_place");
    expect(startClipName(["a", "b"])).toBe("a");
  });
  it("moves to a neighbour when a clip is deleted", () => {
    expect(clipAfterDelete(["a", "b", "c"], "b")).toBe("c");
    expect(clipAfterDelete(["a", "b", "c"], "c")).toBe("b");
  });
});
