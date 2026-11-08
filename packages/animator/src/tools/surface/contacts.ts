/*
 * Atlas Animator: original implementation.
 *
 * Measures the declared contact bands of a surface rig (preset `gates.clearance.contacts`) on its
 * baked runtime: every grid sample of the driver plane inside the pose limits, posed through the
 * document, where the declared contour pair leaves a stroke-clearance crack (gap under one display
 * px). The band's cells go into the document (`contactBands`) for live limits and the gates.
 */
import type { AnimDocument } from "../../core/format.js";
import { inContactBand, type ContactBandData } from "../contactBand.js";
import type { BuiltSurface } from "./build.js";
import { Poser, type Pose } from "./correctives.js";
import { clearanceCovered, clearanceLimitOf, clearanceLines, strokeClearance } from "./gates.js";
import type { Pt } from "./geometry.js";
import { insideLimits, type PoseLimit } from "./limits.js";

export interface ContactBand extends ContactBandData {
  pair: [string, string];
  /** Samples measured, and how many showed the crack (before the neighbour ring). */
  sampled: number;
  measured: number;
}

/** True when a crack between inks `a` and `b` (chained keys joined by '+') is the declared pair. */
export function pairMatches(pair: readonly [string, string], a: string, b: string): boolean {
  const pa = a.split("+");
  const pb = b.split("+");
  return (pa.includes(pair[0]) && pb.includes(pair[1])) || (pa.includes(pair[1]) && pb.includes(pair[0]));
}

export function measureContacts(built: BuiltSurface, document: AnimDocument, limits: readonly PoseLimit[]): ContactBand[] {
  const preset = built.preset;
  const specs = preset.gates?.clearance?.contacts ?? [];
  if (!specs.length) return [];
  const poser = new Poser(document, built);
  const meshes = [built.skin, ...built.garments];
  const limit = clearanceLimitOf(preset);
  return specs.map((c) => {
    const range = (bone: string) => (preset.bones.find((b) => b.name === bone)?.limits ?? [0, 0]) as [number, number];
    const [x0, x1] = range(c.x);
    const [y0, y1] = range(c.y);
    const cells: [number, number][] = [];
    let sampled = 0;
    for (let x = x0; x <= x1 + 1e-9; x += c.step[0]) {
      for (let y = y0; y <= y1 + 1e-9; y += c.step[1]) {
        const pose: Pose = { ...c.hold, [c.x]: Number(x.toFixed(4)), [c.y]: Number(y.toFixed(4)) };
        if (!insideLimits(limits, pose)) continue;
        sampled++;
        poser.pose(pose);
        const verts: Pt[][] = meshes.map((m) => poser.vertices(m));
        const found = strokeClearance(clearanceLines(built, verts), limit, clearanceCovered(built, verts));
        if (found.some((v) => pairMatches(c.pair, v.a, v.b))) cells.push([pose[c.x] as number, pose[c.y] as number]);
      }
    }
    // The band is where the gap sits in (-1, +1) display px: the measured cracks are (0, 1); the
    // overlap side and the sampling margin are covered by cells 1.5 steps wide (half a step of margin
    // around each measured sample, short of the next clean sample).
    // Measurement condition: every other driver of the rig at its held value (setup when unheld).
    const when: Record<string, [number, number]> = {};
    for (const b of preset.bones) if (b.limits && b.name !== c.x && b.name !== c.y) when[b.name] = [c.hold?.[b.name] ?? 0, c.hold?.[b.name] ?? 0];
    return { name: c.name, pair: c.pair, x: c.x, y: c.y, size: [c.step[0] * 1.5, c.step[1] * 1.5], cells, when, sampled, measured: cells.length };
  });
}

/** Document form: the pair goes in as `contours` (the band gates only while both draw). */
export const bandData = (bands: readonly ContactBand[]): ContactBandData[] => bands.map((b) => ({ name: b.name, x: b.x, y: b.y, size: b.size, cells: b.cells, ...(b.when && Object.keys(b.when).length ? { when: b.when } : {}), contours: [b.pair[0], b.pair[1]] }));

export { inContactBand };
