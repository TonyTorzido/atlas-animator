import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "./setupModel.js";
import { rigZones } from "./swagZones.js";

const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../animator/rigs/kit-body-cutout/kit-body-cutout.anim.json", import.meta.url)), "utf8")) as JsonObject;

describe("wizard zones from the rig", () => {
  it("draws a zone for every item slot the kit rig can serve, from its own art or bones", () => {
    const z = rigZones(raw);
    expect(z.bounds).not.toBeNull();
    const chest = z.zones.find((q) => q.item === "chest")!;
    expect(chest.boxes.length).toBeGreaterThan(2);
    expect(chest.boxes.some((b) => b.from === "art")).toBe(true);
    const boots = z.zones.find((q) => q.item === "boots")!;
    expect(boots.boxes.length).toBeGreaterThan(0);
    for (const q of z.zones) for (const b of q.boxes) expect(b.x1).toBeGreaterThan(b.x0);
  });
  it("lists the bones an unserved item slot needs, and draws nothing for it", () => {
    const bare = JSON.parse(JSON.stringify(raw)) as JsonObject;
    bare["bones"] = (bare["bones"] as { name: string }[]).filter((b) => !/^(hand|foot|shin)_/.test(b.name) && b.name !== "head");
    const z = rigZones(bare);
    const gloves = z.zones.find((q) => q.item === "gloves")!;
    expect(gloves.boxes).toEqual([]);
    expect(gloves.missingBones.length).toBeGreaterThan(0);
  });
  it("a different rig gives a different picture (the zones follow the bones)", () => {
    const moved = JSON.parse(JSON.stringify(raw)) as JsonObject;
    for (const b of moved["bones"] as { name: string; x?: number }[]) if (b.name === "pelvis") b.x = (b.x ?? 0) + 200;
    expect(rigZones(moved).bounds).not.toEqual(rigZones(raw).bounds);
  });
});
