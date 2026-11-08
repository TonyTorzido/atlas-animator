import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadAnimDocument } from "@atlas-animator/core/core";
import { emptyClip, parseClip, writeClip } from "./clipModel.js";
import { setEvent } from "./eventModel.js";
import { isRigFile, mergeClipIntoRigText, mergeSkinsIntoRigText, PHONE_SCALES, renderPlan, rigPath } from "./exportApi.js";

const rigUrl = new URL(`../../../${rigPath("front-turn15-faceA.anim.json")}`, import.meta.url);
const text = readFileSync(rigUrl, "utf8");

describe("apply a clip to a rig document", () => {
  const clip = writeClip(setEvent(emptyClip(0.5, false), 0.2, "hit"));
  it("adds the clip, declares its events and keeps the file minified", () => {
    const out = mergeClipIntoRigText(text, "demo_swing", clip);
    expect(out.includes("\n")).toBe(false);
    const doc = JSON.parse(out);
    expect(doc.animations.demo_swing).toEqual(clip);
    expect(doc.events.hit).toEqual({});
    expect(Object.keys(doc.animations)).toContain("walk_in_place");
    // the result is still a valid rig document with the clip in it
    const loaded = loadAnimDocument(doc);
    expect(parseClip(writeClip(loaded.animations.demo_swing!)).events[0]!.name).toBe("hit");
  });
  it("replaces a clip of the same name and leaves the other clips alone", () => {
    const before = JSON.parse(text).animations.walk_in_place;
    const out = JSON.parse(mergeClipIntoRigText(text, "walk_in_place", writeClip(emptyClip(1, true))));
    expect(out.animations.walk_in_place).toEqual({ duration: 1, loop: true, fps: 30 });
    expect(out.animations.idle_weight_shift).toEqual(JSON.parse(text).animations.idle_weight_shift);
    expect(before.duration).toBeGreaterThan(0.9);
  });
  it("keeps an indented document indented and rejects bad names or documents", () => {
    const pretty = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    expect(mergeClipIntoRigText(pretty, "x", clip).includes("\n  ")).toBe(true);
    expect(() => mergeClipIntoRigText(text, "../evil", clip)).toThrow();
    expect(() => mergeClipIntoRigText("{}", "x", clip)).toThrow();
    expect(() => mergeClipIntoRigText(text, "x", {})).toThrow();
  });
  it("only the editor's fixture rig files are writable", () => {
    expect(isRigFile("kit-body-front0.anim.json")).toBe(false); // front view retired 2026-10-25
    expect(isRigFile("kit-body-cutout.anim.json")).toBe(true);
    expect(rigPath("kit-body-cutout.anim.json")).toBe("packages/animator/rigs/kit-body-cutout/kit-body-cutout.anim.json");
    expect(() => rigPath("../player/x.anim.json")).toThrow();
    expect(isRigFile("kit-body-front0/../../x.anim.json")).toBe(false);
    expect(isRigFile("front-turn15-faceA.anim.json")).toBe(true);
    expect(isRigFile("front-turn15-faceA-mirin.anim.json")).toBe(true);
    expect(isRigFile("../../package.json")).toBe(false);
    expect(isRigFile("front-x.atlas.png")).toBe(false);
  });
});

describe("render plan", () => {
  it("builds the CLI arguments for both phone scales from the canvas", () => {
    const canvas = { width: 1086, height: 1448, originX: 542, originY: 960 };
    const plans = PHONE_SCALES.map((scale) => renderPlan({ doc: "d.anim.json", clip: "swing", scale, canvas, outDir: "out" }));
    expect(plans.map((p) => p.scale)).toEqual([0.4, 0.471]);
    const big = plans[1]!;
    expect(big.args).toContain("--sheet");
    expect(big.args[big.args.indexOf("--size") + 1]).toBe("512x683");
    expect(big.args[big.args.indexOf("--origin") + 1]).toBe("255,452");
    expect(big.args[big.args.indexOf("--clip") + 1]).toBe("swing");
    expect(big.gif).toBe("out/swing-0.471.gif");
    expect(big.sheet).toBe("out/swing-0.471-sheet.png");
  });
});

describe("mergeSkinsIntoRigText", () => {
  const rig = { format: "atlas-anim@1", slots: [{ name: "shirt", attachment: "a" }, { name: "hat", attachment: null }], skins: { body: {} } };
  it("replaces the skins and the named setup attachments, keeping the rest and the layout", () => {
    const out = mergeSkinsIntoRigText(JSON.stringify(rig), { body: {}, red: { attachments: {} } }, { shirt: "b", nope: "x" });
    expect(out.includes("\n")).toBe(false);
    const doc = JSON.parse(out);
    expect(Object.keys(doc.skins)).toEqual(["body", "red"]);
    expect(doc.slots).toEqual([{ name: "shirt", attachment: "b" }, { name: "hat", attachment: null }]);
  });
  it("refuses a file that is not an atlas-anim rig", () => {
    expect(() => mergeSkinsIntoRigText("{}", {})).toThrow();
  });
});
