import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ATTACK_PROFILES } from "./preview/attackProfiles.js";
import { frameCount, frameTime } from "./clipModel.js";
import { eventIssues, stepContactFrame } from "./eventModel.js";
import {
  boardSummary, CLASS_WEAPON, CLASSES, clipId, clipsInGroup, clipsNotInGame, findClip, gameIdsFor, GAME_CLIPS, GATHER_TIMING, matrixCell, styleIdFor, WEAPONS,
  type BoardState
} from "./gameClips.js";
import { attackFrames, templateFor } from "./clipTemplates.js";
import { mappedEditorClips } from "../../animator/src/clipMap.js";

describe("catalogue", () => {
  it("has unique ids and the expected size", () => {
    const ids = GAME_CLIPS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GAME_CLIPS.length).toBe(58);
    expect(clipsInGroup("attack").length).toBe(36);
    expect(clipsInGroup("guard").length).toBe(6);
    expect(clipsInGroup("gather").length).toBe(5);
  });
  it("names clips from one function", () => {
    expect(clipId({ kind: "attack", weapon: "sword", step: 2 })).toBe("atk_sword_2");
    expect(clipId({ kind: "attack", weapon: "sword", klass: "ronin", step: 3 })).toBe("atk_sword_ronin_3");
    expect(clipId({ kind: "guard", weapon: "hammer_shield" })).toBe("guard_walk_hammer_shield");
    expect(clipId({ kind: "gather", name: "chop" })).toBe("gather_chop");
    for (const c of GAME_CLIPS) expect(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(c.id)).toBe(true);
  });
  it("uses one class -> weapon table", () => {
    expect(CLASS_WEAPON).toEqual({ ronin: "sword", warrior: "axe", paladin: "hammer_shield", cleric: "scepter_relic", ranger: "bow", mage: "staff" });
    for (const k of CLASSES) {
      expect(matrixCell(k, CLASS_WEAPON[k]).length).toBe(3);
      for (const w of WEAPONS) if (w !== CLASS_WEAPON[k]) expect(matrixCell(k, w).length).toBe(0);
    }
    for (const w of WEAPONS) expect(matrixCell(null, w).map((c) => c.step)).toEqual([1, 2, 3]);
  });
  it("uses the right rig and mirroring", () => {
    expect(findClip("idle")!.rig).toBe("pro-turned");
    expect(findClip("walk_down")!.rig).toBe("pro-turned");
    for (const id of ["walk_side", "run", "dash", "gather_chop", "atk_axe_1", "guard_walk_bow"]) {
      const c = findClip(id)!;
      expect(c.rig).toBe("pro-turned");
      expect(c.facing).toBe("left");
      expect(c.mirrorForRight).toBe(true);
    }
    expect(findClip("idle")!.mirrorForRight).toBe(true);
  });
  it("marks entries without a real attack profile as default timing", () => {
    expect(styleIdFor("sword", "ronin")).toBe("sword:ronin");
    expect(styleIdFor("axe", "warrior")).toBe("axe:warrior");
    expect(findClip("atk_sword_ronin_1")!.timing.source).toBe("profile");
    expect(findClip("atk_axe_2")!.timing).toMatchObject({ source: "profile", styleId: "axe:generic" });
    for (const id of ["atk_hammer_shield_1", "atk_hammer_shield_paladin_2", "atk_scepter_relic_cleric_1", "atk_bow_ranger_3", "atk_staff_mage_1"]) {
      expect(findClip(id)!.timing).toMatchObject({ source: "default", styleId: "default" });
    }
    const real = GAME_CLIPS.filter((c) => c.group === "attack" && c.timing.source === "profile");
    expect(real.length).toBe(12);
  });
});

describe("templates", () => {
  it("builds attack clips from the profile: length, linked hit, trail window, ready", () => {
    const entry = findClip("atk_axe_1")!;
    const clip = templateFor(entry);
    expect(clip.fps).toBe(30);
    expect(clip.loop).toBe(false);
    expect(frameCount(clip)).toBe(24);
    const at = (n: string) => clip.events.filter((e) => e.name === n).map((e) => Math.round(e.time * 30));
    expect(at("windup")).toEqual([0]);
    expect(at("hit")).toEqual([6]);
    expect(at("trailOn")).toEqual([4]);
    expect(at("trailOff")).toEqual([8]);
    expect(at("ready")).toEqual([24]);
    expect(clip.events.find((e) => e.name === "hit")!.string).toBe("axe:generic#0");
    expect(eventIssues(clip)).toEqual([]);
  });
  it("puts every attack hit on its step's contact frame with no event issues", () => {
    for (const c of GAME_CLIPS.filter((x) => x.group === "attack")) {
      const clip = templateFor(c);
      const step = c.step! - 1;
      const hit = clip.events.find((e) => e.name === "hit")!;
      expect(Math.round(hit.time * 30)).toBe(stepContactFrame(c.timing.styleId!, step));
      expect(eventIssues(clip)).toEqual([]);
      const p = ATTACK_PROFILES[c.timing.styleId as keyof typeof ATTACK_PROFILES].combo[step]!;
      expect(frameCount(clip)).toBe(Math.round(((p.windupMs + p.recoveryMs) / 1000) * 30));
    }
    expect(attackFrames("sword:ronin", 2)).toBe(30);
  });
  it("keeps trail events inside the clip for the shortest windups", () => {
    for (const c of GAME_CLIPS.filter((x) => x.group === "attack")) {
      const clip = templateFor(c);
      for (const e of clip.events) {
        expect(e.time).toBeGreaterThanOrEqual(0);
        expect(e.time).toBeLessThanOrEqual(clip.duration + 1e-9);
      }
    }
  });
  it("loops gathers and puts hit on the tool impact", () => {
    const chop = templateFor(findClip("gather_chop")!);
    expect(chop.loop).toBe(true);
    expect(frameCount(chop)).toBe(30);
    expect(chop.events.map((e) => [e.name, Math.round(e.time * 30)])).toEqual([["hit", 17]]);
    expect(frameCount(templateFor(findClip("gather_mine")!))).toBe(39);
    expect(templateFor(findClip("gather_fish")!).events).toEqual([]);
    expect(templateFor(findClip("gather_plant")!).loop).toBe(true);
  });
  it("makes one loop cycle for moves and guard walks, and one-shots for the rest", () => {
    const walk = templateFor(findClip("walk_side")!);
    expect(walk.loop).toBe(true);
    expect(frameCount(walk)).toBe(28);
    expect(walk.duration).toBeCloseTo(frameTime({ fps: 30 }, 28));
    expect(templateFor(findClip("guard_walk_axe")!).loop).toBe(true);
    expect(templateFor(findClip("dash")!).loop).toBe(false);
    expect(templateFor(findClip("death")!).loop).toBe(false);
    for (const c of GAME_CLIPS) expect(templateFor(c).fps).toBe(30);
  });
});

describe("boardSummary", () => {
  const entry = (rigHash: string, done = true) => ({ done, rigHash, updated: "2026-10-24" });
  it("reports missing for everything when nothing exists", () => {
    const s = boardSummary([], {});
    expect(s.total).toBe(GAME_CLIPS.length);
    expect(s.counts.missing).toBe(GAME_CLIPS.length);
    expect(s.progress).toBe(0);
  });
  it("derives draft, done, needs-recheck and broken", () => {
    const board: BoardState = {
      atk_axe_1: entry("h1"),
      atk_axe_2: entry("old"),
      atk_axe_3: entry("h1"),
      atk_sword_1: entry("h1", false),
      death: entry("h1")
    };
    const s = boardSummary(["atk_axe_1", "atk_axe_2", "atk_axe_3", "atk_sword_1", "atk_sword_2", "gather_chop"], board, {
      rigHashes: { "pro-turned": "h1" },
      gateErrors: { atk_axe_3: 2 }
    });
    expect(s.status.atk_axe_1).toBe("done");
    expect(s.status.atk_axe_2).toBe("needs-recheck");
    expect(s.status.atk_axe_3).toBe("broken");
    expect(s.status.atk_sword_1).toBe("draft");
    expect(s.status.atk_sword_2).toBe("draft");
    expect(s.status.gather_chop).toBe("draft");
    expect(s.status.death).toBe("missing");
    expect(s.counts).toMatchObject({ done: 1, "needs-recheck": 1, broken: 1, draft: 3 });
    expect(s.problems).toBe(2);
    expect(s.progress).toBeCloseTo(1 / GAME_CLIPS.length);
  });
  it("counts the rigs' existing idle_weight_shift / walk_in_place as idle / walk_down", () => {
    const s = boardSummary(["idle_weight_shift", "walk_in_place"], { idle: entry("h") }, { rigHashes: { "pro-turned": "h" } });
    expect(s.status.idle).toBe("done");
    expect(s.status.walk_down).toBe("draft");
  });
  it("skips the re-check when the rig has no hash", () => {
    expect(boardSummary(["run"], { run: entry("x") }).status.run).toBe("done");
  });
});

describe("clipMap.json rows (PL-03)", () => {
  it("every row is a catalogue clip, and every catalogue clip is mapped or listed as not in project", () => {
    const ids = new Set(GAME_CLIPS.map((c) => c.id));
    for (const id of mappedEditorClips()) expect(ids.has(id), id).toBe(true);
    const notIn = new Set(clipsNotInGame().map((c) => c.id));
    for (const c of GAME_CLIPS) expect(notIn.has(c.id) !== gameIdsFor(c.id).length > 0, c.id).toBe(true);
    expect(gameIdsFor("idle")).toEqual(["idle", "standL", "standR"]);
  });
});
