import { describe, expect, it } from "vitest";
import type { ClipData } from "@atlas-animator/core/core";
import { emptyClip, frameCount, frameTime, parseClip, previewClipFps, setClipFps, setDuration, setRotateKey, writeClip } from "./clipModel.js";
import { allKeys, deleteFrames, insertFrames, keyedRows, moveKeys, reverseKeys, rowKeyTimes } from "./dopesheetModel.js";
import { timedArrays } from "./clipChannels.js";

const f = (n: number, fps = 30) => frameTime({ fps }, n);

/** A 1 s clip with a key in every channel kind. */
function everything(): ClipData {
  let clip = emptyClip(1, false);
  for (const fr of [0, 6, 12]) clip = setRotateKey(clip, "arm", f(fr), fr * 5);
  clip = parseClip({
    ...writeClip(clip),
    slots: { eyes: { attachment: [{ time: f(6), name: "eyes_closed" }], color: [{ time: 0, color: "ffffffff" }, { time: f(12), color: "ffffff00" }] } },
    ik: { arm_ik: [{ time: 0, mix: 1 }, { time: f(12), mix: 0 }] },
    transform: { tc: [{ time: 0, mixRotate: 1 }, { time: f(12), mixRotate: 0.5 }] },
    physics: { hair: { mix: [{ time: 0, value: 1 }, { time: f(12), value: 0 }], reset: [{ time: f(6) }] } },
    deform: { default: { skin_a: { mesh: [{ time: 0, vertices: [0, 0] }, { time: f(12), vertices: [1, 1] }] } } },
    drawOrder: [{ time: f(12), offsets: [{ slot: "hair", offset: -1 }] }],
    events: [{ time: f(6), name: "step" }, { time: f(6), name: "dust" }]
  });
  return clip;
}

describe("channel rows", () => {
  it("lists a row for every channel kind, with colour apart from images", () => {
    const rows = keyedRows(everything());
    expect(rows).toEqual(expect.arrayContaining(["bone:arm", "ik:arm_ik", "transform:tc", "physics:hair", "slot:eyes", "color:eyes", "draw", "event"]));
    expect(rows.some((r) => r.startsWith("deform:"))).toBe(true);
    const clip = everything();
    expect(rowKeyTimes(clip, "color:eyes")).toEqual([0, f(12)]);
    expect(rowKeyTimes(clip, "slot:eyes")).toEqual([f(6)]);
    expect(rowKeyTimes(clip, "transform:tc")).toEqual([0, f(12)]);
    expect(rowKeyTimes(clip, "physics:hair")).toEqual([0, f(6), f(12)]);
  });
  it("moves a colour key and a transform mix key through the shared move", () => {
    const clip = everything();
    const a = moveKeys(clip, [{ row: "color:eyes", time: f(12) }], -4);
    expect(a.clip.slots.eyes!.color!.map((k) => k.time)).toEqual([0, f(8)]);
    expect(a.clip.slots.eyes!.attachment!.map((k) => k.time)).toEqual([f(6)]);
    const b = moveKeys(clip, [{ row: "transform:tc", time: f(12) }], -2);
    expect(b.clip.transform.tc!.map((k) => k.time)).toEqual([0, f(10)]);
  });
});

describe("insert / delete frames", () => {
  it("inserting 5 frames at 6 shifts every key at or after 6 by 5 and grows the clip", () => {
    const clip = everything();
    const next = insertFrames(clip, 6, 5);
    expect(frameCount(next)).toBe(frameCount(clip) + 5);
    expect(rowKeyTimes(next, "bone:arm")).toEqual([0, f(11), f(17)]);
    expect(rowKeyTimes(next, "color:eyes")).toEqual([0, f(17)]);
    expect(next.events.map((e) => e.time)).toEqual([f(11), f(11)]);
    expect(next.drawOrder[0]!.time).toBe(f(17));
    expect(allKeys(next).length).toBe(allKeys(clip).length);
    parseClip(writeClip(next));
  });
  it("deleting 3 frames at 4 removes keys inside, shifts the rest back and shrinks the clip", () => {
    const clip = everything();
    const r = deleteFrames(clip, 5, 3); // frames 5, 6, 7 go
    expect(r.removed).toBeGreaterThan(0);
    expect(frameCount(r.clip)).toBe(frameCount(clip) - 3);
    expect(rowKeyTimes(r.clip, "bone:arm")).toEqual([0, f(9)]);
    expect(r.clip.events).toHaveLength(0);
    parseClip(writeClip(r.clip));
  });
  it("never deletes the whole clip", () => {
    const r = deleteFrames(emptyClip(1, false), 0, 99);
    expect(frameCount(r.clip)).toBeGreaterThanOrEqual(1);
  });
});

describe("reverse keys", () => {
  it("swaps the values of the selected keys end for end", () => {
    const clip = everything();
    const sel = [0, 6, 12].map((fr) => ({ row: "bone:arm" as const, time: f(fr) }));
    const r = reverseKeys(clip, sel);
    expect(r.clip.bones.arm!.rotate!.map((k) => k.value)).toEqual([60, 30, 0]);
    expect(r.clip.bones.arm!.rotate!.map((k) => k.time)).toEqual([0, f(6), f(12)]);
  });
  it("mirrors a bezier segment with the reversal", () => {
    let clip = everything();
    clip.bones.arm!.rotate![0]!.curve = [0.1, 0.2, 0.3, 0.4];
    const sel = [0, 6, 12].map((fr) => ({ row: "bone:arm" as const, time: f(fr) }));
    const r = reverseKeys(clip, sel);
    const c = r.clip.bones.arm!.rotate![1]!.curve;
    expect(c).toEqual([1 - 0.3, 1 - 0.4, 1 - 0.1, 1 - 0.2]);
    clip = r.clip;
    expect(() => parseClip(writeClip(clip))).not.toThrow();
  });
  it("leaves a single key alone", () => {
    const clip = everything();
    const r = reverseKeys(clip, [{ row: "bone:arm", time: f(6) }]);
    expect(r.clip).toEqual(clip);
  });
});

describe("retime and trim cover every channel", () => {
  it("lists every channel kind", () => {
    const kinds = new Set(timedArrays(everything()).map((a) => a.kind));
    for (const k of ["bone", "slotAttachment", "slotColor", "ik", "transform", "physicsMix", "physicsReset", "deform", "drawOrder", "event"]) expect(kinds.has(k as never)).toBe(true);
  });
  it("30 to 12 fps moves transform, physics, colour and deform keys and reports collisions", () => {
    const clip = everything();
    const pv = previewClipFps(clip, 12);
    expect(pv.channels).toBeGreaterThan(8);
    // frames 0/6/12 at 30 fps are 0, 0.2, 0.4 s: 12 fps lands them on frames 0, 2.4 -> 2, 4.8 -> 5
    expect(pv.clip.transform.tc!.map((k) => k.time)).toEqual([0, 5 / 12]);
    expect(pv.clip.physics.hair!.reset![0]!.time).toBeCloseTo(2 / 12, 6);
    expect(pv.clip.slots.eyes!.color!.map((k) => k.time)).toEqual([0, 5 / 12]);
    expect(Object.values(pv.clip.deform.default!.skin_a!)[0]!.map((k) => k.time)).toEqual([0, 5 / 12]);
    expect(pv.clip.fps).toBe(12);
    expect(() => parseClip(writeClip(pv.clip))).not.toThrow();
    expect(setClipFps(clip, 12).clip).toEqual(pv.clip);
  });
  it("two keys that land on one frame merge (the later wins) and are listed; events are never merged", () => {
    let clip = emptyClip(1, false);
    clip = setRotateKey(clip, "arm", f(0), 1);
    clip = setRotateKey(clip, "arm", f(1), 2);
    clip = setRotateKey(clip, "arm", f(2), 3);
    const pv = previewClipFps(clip, 10);
    expect(pv.merged).toBeGreaterThan(0);
    expect(pv.collisions[0]!.channel).toContain("bone arm rotate");
    const keys = pv.clip.bones.arm!.rotate!;
    expect(new Set(keys.map((k) => k.time)).size).toBe(keys.length);
    const withEvents = everything();
    withEvents.events.push({ time: f(7), name: "late" });
    const e = previewClipFps(withEvents, 12);
    expect(e.clip.events.length).toBe(withEvents.events.length);
  });
  it("clamps the rate to the engine's 60 fps", () => {
    expect(previewClipFps(emptyClip(1, false), 240).fps).toBe(60);
  });
  it("shortening trims slot colour, deform, physics and transform keys too", () => {
    const clip = everything();
    const r = setDuration(clip, 0.3); // 9 frames: keys at frame 12 go
    expect(r.dropped).toBeGreaterThanOrEqual(7);
    expect(r.clip.slots.eyes!.color!.map((k) => k.time)).toEqual([0]);
    expect(r.clip.transform.tc!.map((k) => k.time)).toEqual([0]);
    expect(r.clip.physics.hair!.mix!.map((k) => k.time)).toEqual([0]);
    expect(Object.values(r.clip.deform.default!.skin_a!)[0]!.map((k) => k.time)).toEqual([0]);
    expect(() => parseClip(writeClip(r.clip))).not.toThrow();
  });
});

import { addChannelKey, describeCurve, keyChannels, setKeyFields, setKeyCurve, interpolationOf } from "./keyInspectorModel.js";

describe("key inspector model", () => {
  it("shows value, curve, interpolation and event payload of the selection", () => {
    const clip = everything();
    const bone = keyChannels(clip, "bone:arm", f(6));
    expect(bone[0]!.channel).toBe("rotate");
    expect(bone[0]!.fields.find((x) => x.id === "value")!.value).toBe(30);
    expect(describeCurve(bone[0]!.curve)).toBe("linear");
    const ev = keyChannels(clip, "event", f(6));
    expect(ev[0]!.fields.map((x) => x.id)).toContain("name");
    expect(interpolationOf([0.2, 0, 0.8, 1])).toBe("Bezier");
    expect(interpolationOf("stepped")).toBe("Stepped");
  });
  it("sets a value and a curve", () => {
    const clip = everything();
    const a = setKeyFields(clip, "bone:arm", f(6), "rotate", { value: 12 });
    expect(a.bones.arm!.rotate![1]!.value).toBe(12);
    const b = setKeyCurve(a, "bone:arm", f(6), "rotate", "stepped");
    expect(b.bones.arm!.rotate![1]!.curve).toBe("stepped");
    const c = setKeyFields(clip, "transform:tc", 0, "transform", { mixRotate: 4 });
    expect(c.transform.tc![0]!.mixRotate).toBe(1);
    const d = setKeyFields(clip, "event", f(6), "event", { int: 2.6, string: "x" });
    expect(d.events[0]!.int).toBe(3);
    expect(() => parseClip(writeClip(d))).not.toThrow();
  });
  it("adds a colour key on a slot, a transform mix key and a physics key, each valid", () => {
    let clip = emptyClip(1, false);
    clip = addChannelKey(clip, { kind: "color", slot: "eyes" }, f(4), { color: "ff8800ff" });
    expect(clip.slots.eyes!.color).toEqual([{ time: f(4), color: "ff8800ff", curve: "linear" }]);
    clip = addChannelKey(clip, { kind: "transform", name: "tc" }, f(4), { mixRotate: 0.25 });
    expect(clip.transform.tc![0]!.mixRotate).toBe(0.25);
    expect(clip.transform.tc![0]!.mixX).toBe(1);
    clip = addChannelKey(clip, { kind: "physics", name: "hair", channel: "mix" }, f(2), { value: 0.5 });
    clip = addChannelKey(clip, { kind: "physics", name: "hair", channel: "reset" }, f(2));
    clip = addChannelKey(clip, { kind: "ik", name: "arm_ik" }, f(2), { mix: 0 });
    const again = parseClip(writeClip(clip));
    expect(again.physics.hair!.mix![0]!.value).toBe(0.5);
    expect(again.physics.hair!.reset).toEqual([{ time: f(2) }]);
    expect(again.ik.arm_ik![0]!.mix).toBe(0);
    expect(addChannelKey(clip, { kind: "color", slot: "eyes" }, f(4), { color: "nope" })).toBe(clip);
  });
});

import { channelKeys, linkHandles, setTangent } from "./graphModel.js";

describe("graph tangents", () => {
  function three() {
    let c = emptyClip(1, false);
    for (const [fr, v] of [[0, 0], [6, 40], [12, 10]] as const) c = setRotateKey(c, "arm", f(fr), v);
    return c;
  }
  it("flat puts both handles at the key level", () => {
    const keys = channelKeys(setTangent(three(), "arm", "rotate", f(6), "flat"), "arm", "rotate");
    expect((keys[0]!.curve as number[])[3]).toBe(1);
    expect((keys[1]!.curve as number[])[1]).toBe(0);
  });
  it("auto at a peak is flat, smooth follows the neighbours, and the clip stays valid", () => {
    const peak = channelKeys(setTangent(three(), "arm", "rotate", f(6), "auto"), "arm", "rotate");
    expect((peak[1]!.curve as number[])[1]).toBe(0);
    const smooth = setTangent(three(), "arm", "rotate", f(6), "smooth");
    expect((channelKeys(smooth, "arm", "rotate")[1]!.curve as number[])[1]).not.toBe(0);
    expect(() => parseClip(writeClip(smooth))).not.toThrow();
  });
  it("linked handles keep one slope through the key", () => {
    let c = setTangent(three(), "arm", "rotate", f(6), "smooth");
    const out = channelKeys(c, "arm", "rotate")[1]!.curve as number[];
    c = setTangent(c, "arm", "rotate", f(6), "flat");
    c = linkHandles(c, "arm", "rotate", f(6), "out");
    const keys = channelKeys(c, "arm", "rotate");
    const inn = keys[0]!.curve as number[];
    expect(inn[3]).toBeCloseTo(1, 3); // flat out of the key -> flat into it
    expect(out.length).toBe(4);
  });
});
