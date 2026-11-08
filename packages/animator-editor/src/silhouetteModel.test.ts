import { describe, expect, it } from "vitest";
import { silhouetteStats } from "./silhouetteModel.js";

const GROUND = 0xe8e4da;
const px = (...rgb: number[][]) => Uint8Array.from(rgb.flatMap((c) => [...c, 255]));

describe("silhouette stats", () => {
  it("counts black, ground and blended edge pixels as flat", () => {
    const s = silhouetteStats(px([0, 0, 0], [0xe8, 0xe4, 0xda], [0x74, 0x72, 0x6d]), GROUND);
    expect(s).toMatchObject({ blackPx: 1, groundPx: 1, otherPx: 0, otherShare: 0 });
  });
  it("flags a coloured pixel", () => {
    const s = silhouetteStats(px([0, 0, 0], [200, 40, 40], [0xe8, 0xe4, 0xda], [0, 0, 0]), GROUND);
    expect(s.otherPx).toBe(1);
    expect(s.otherShare).toBeCloseTo(0.25);
  });
});
