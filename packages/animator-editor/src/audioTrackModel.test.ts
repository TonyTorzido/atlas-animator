import { describe, expect, it } from "vitest";
import { audioFileName, audioPosition, cleanMeta, clampOffset, clampVolume, computePeaks, PEAKS_PER_SECOND, peakRange } from "./audioTrackModel.js";

describe("audio reference track ()", () => {
  it("names the stored file from the clip and the picked extension", () => {
    expect(audioFileName("walk", "Footsteps.MP3")).toBe("walk.mp3");
    expect(audioFileName("walk", "x.wav")).toBe("walk.wav");
    expect(audioFileName("walk", "x.ogg")).toBeNull();
  });
  it("clamps volume and offset", () => {
    expect(clampVolume(3)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampOffset(99)).toBe(30);
    expect(clampOffset(NaN)).toBe(0);
    expect(audioPosition(2, 0.5)).toBe(1.5);
  });
  it("computes peaks that find a spike where it is", () => {
    const sr = 8000;
    const data = new Float32Array(sr); // 1 s of silence
    data[4000] = 0.8;
    data[4001] = -0.6;
    const p = computePeaks([data], sr);
    expect(p.max.length).toBe(PEAKS_PER_SECOND);
    const hit = peakRange(p, 0.49, 0.51);
    expect(hit.hi).toBeCloseTo(0.8);
    expect(hit.lo).toBeCloseTo(-0.6);
    expect(peakRange(p, 0.1, 0.2)).toEqual({ lo: 0, hi: 0 });
    expect(peakRange(p, 2, 3)).toEqual({ lo: 0, hi: 0 });
  });
  it("cleanMeta keeps good audio rows and drops junk", () => {
    const m = cleanMeta({ a: { audio: { file: "a.wav", name: "x.wav", offset: 1, volume: 2, muted: true } }, b: { audio: 5 }, c: null });
    expect(m).toEqual({ a: { audio: { file: "a.wav", name: "x.wav", offset: 1, volume: 1, muted: true } } });
  });
});
