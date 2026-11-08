/*
 * Atlas Animator: original implementation.
 *
 * Test helper: the canonical surface rigs, built once per process. A canonical build blocks for
 * tens of seconds; the surface test files run in one fork without isolation (vitest.config.ts,
 * project "surface"), so every file shares these builds instead of rebuilding them. Callers must
 * not modify the returned rig (build from loadPreset for a modified preset).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRig, type SurfaceRig } from "./output.js";
import { loadPreset } from "./preset.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigs = new Map<string, SurfaceRig>();

export const canonicalPresetPath = (name: string): string => resolve(here, "../../../fixtures/canonical", `${name}.preset.json`);

export function canonicalRig(name: string): SurfaceRig {
  let rig = rigs.get(name);
  if (!rig) {
    const path = canonicalPresetPath(name);
    rigs.set(name, (rig = buildRig(loadPreset(path), dirname(path))));
  }
  return rig;
}
