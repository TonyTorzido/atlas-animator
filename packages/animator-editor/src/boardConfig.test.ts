import { describe, expect, it } from "vitest";
import { addSlotsToSummary, attackSlotId, clipNameError, customClipEntry, customClipNames, freeName, lengthFpsError, nextStep, parseBoardConfig, retimeClip, slotToGameClip, slugify, type CustomSlot } from "./boardConfig.js";
import { emptyClip, frameCount } from "./clipModel.js";
import { boardSummary } from "./gameClips.js";
import { templateFor } from "./clipTemplates.js";

describe("clip names", () => {
  it("accepts file-safe names and explains the rest", () => {
    expect(clipNameError("my_clip.2", new Set())).toBeNull();
    expect(clipNameError("", new Set())).toMatch(/name/);
    expect(clipNameError("two words", new Set())).toMatch(/letters/);
    expect(clipNameError("x.clip.json", new Set())).toMatch(/clip\.json/);
    expect(clipNameError("a".repeat(97), new Set())).toMatch(/under/);
    expect(clipNameError("taken", new Set(["taken"]))).toMatch(/exists/);
    expect(clipNameError("taken", new Set(["taken"]), "taken")).toBeNull();
    expect(clipNameError("atk_sword_1", new Set())).toMatch(/project clip/);
    expect(clipNameError("idle", new Set())).toMatch(/project clip/);
  });
  it("slugifies labels and finds free names", () => {
    expect(slugify("Emote: dance!")).toBe("emote_dance");
    expect(freeName("a_copy", new Set(["a_copy", "a_copy2"]))).toBe("a_copy3");
  });
});

describe("board config", () => {
  const good = { id: "emote_dance", label: "Emote: dance", category: "other", loop: false, durationS: 2 };
  it("keeps valid slots and drops bad ones", () => {
    const cfg = parseBoardConfig({
      slots: [good, good, { ...good, id: "idle" }, { ...good, id: "bad id" }, { id: "atk_x", label: "x", category: "attack", weapon: "laser", step: 4 }, { id: "atk_sword_4", label: "S4", category: "attack", weapon: "sword", step: 4 }, null]
    });
    expect(cfg.slots.map((s) => s.id)).toEqual(["emote_dance", "atk_sword_4"]);
    expect(parseBoardConfig(null).slots).toEqual([]);
  });
  it("numbers the next combo step after the built-in three and custom ones", () => {
    const s: CustomSlot = { id: attackSlotId("sword", null, 4), label: "x", category: "attack", weapon: "sword", klass: null, step: 4, loop: false, durationS: 1 };
    expect(nextStep([], "sword", null)).toBe(4);
    expect(nextStep([s], "sword", null)).toBe(5);
    expect(nextStep([s], "sword", "ronin")).toBe(4);
  });
  it("turns a slot into a blank-template project clip counted in the summary", () => {
    const slot: CustomSlot = { ...(good as CustomSlot), category: "other" };
    const clip = slotToGameClip(slot);
    expect(clip).toMatchObject({ id: "emote_dance", group: "emote", custom: true });
    expect(frameCount(templateFor(clip))).toBe(60);
    const base = boardSummary([], {});
    const sum = addSlotsToSummary(base, [slot], new Set(["emote_dance"]), {}, {});
    expect(sum.total).toBe(base.total + 1);
    expect(sum.status.emote_dance).toBe("draft");
    expect(sum.counts.draft).toBe(1);
  });
  it("lists the user's own clips only", () => {
    const slot = slotToGameClip({ ...(good as CustomSlot) });
    expect(customClipNames(["idle_weight_shift", "walk_in_place", "atk_axe_1", slot.id, "zed", "alpha", "alpha"], [good as CustomSlot])).toEqual(["alpha", "zed"]);
    expect(customClipEntry("zed")).toMatchObject({ id: "zed", mine: true });
  });
});

describe("length and fps", () => {
  it("validates", () => {
    expect(lengthFpsError(1, 30)).toBeNull();
    expect(lengthFpsError(0, 30)).toMatch(/Length/);
    expect(lengthFpsError(1, 0)).toMatch(/Frames/);
    expect(lengthFpsError(1, 29.5)).toMatch(/whole/);
    expect(lengthFpsError(61, 30)).toMatch(/at most/);
  });
  it("retimes to a new length and fps", () => {
    const c = retimeClip(emptyClip(1, false, 30), 2, 24);
    expect(c.clip.fps).toBe(24);
    expect(frameCount(c.clip)).toBe(48);
    expect(c.dropped).toBe(0);
  });
});
