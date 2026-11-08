import { describe, expect, it } from "vitest";
import { allGameClipIds, CLIP_MAP, clipMapSchema, gameClipsFor } from "./clipMap.js";

describe("clipMap.json", () => {
  it("refuses a game clip mapped twice", () => {
    const bad = structuredClone(CLIP_MAP) as unknown as { clips: Record<string, { game: unknown[] }> };
    bad.clips["walk_down"]!.game.push({ id: "idle", side: "front", flip: false, frames: 1 });
    expect(() => clipMapSchema.parse(bad)).toThrow(/mapped twice/);
  });

  it("an unmapped editor clip feeds nothing", () => {
    expect(gameClipsFor("atk_sword_1")).toEqual([]);
    expect(gameClipsFor("gather_chop").map((g) => g.id)).toEqual(["chopL", "chopR"]);
  });
});
