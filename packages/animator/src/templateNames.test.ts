import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Generality gate (extended in): library and CLI source (core, tools, pixi, cli)
 * names no body template. No template file name (template7), no humanoid bone, slot or part name,
 * no test-mob name (the fox) and no literal canvas coordinate (a crop or frame at a fixed canvas
 * x/y) outside body-preset modules and fixtures. Rig-agnostic code takes such names and crops from
 * a preset (BodyPreset) or from the document.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SCANNED = ["core", "tools", "pixi", "cli"];

/** Body-preset modules: the humanoid's data and its surface preset. */
const PRESETS = ["tools/humanoid.ts", "tools/surface/preset.ts"];
/** Fixtures: tests and the test-figure / test-rig builders. */
const FIXTURES = [/\.test\.ts$/, /^tools\/testFigures\.ts$/, /^tools\/surface\/test[A-Z]\w*\.ts$/];
/**
 * Debt listed apart so it stays visible. Emptied in: the raster rig builder (tools/rig.ts) and
 * its joint pieces (tools/jointPieces.ts) were deleted; review crops moved to HUMANOID_BODY.
 */
const RETIRING_IN_4D_4J: string[] = [];

const LIMB = "(?:upper_arm|forearm|hand|thigh|shin|foot|shoulder|clavicle|elbow|knee|arm|leg|sleeve)";
const PATTERNS: readonly [string, RegExp][] = [
  ["template file", /template7/i],
  ["test mob", /\bfox(?:es)?\b/i],
  ["humanoid bone/part", /["'`](?:pelvis|chest|torso|shorts|spine_\w+)["'`.]/],
  ["sided humanoid name", new RegExp(`\\b${LIMB}_[lr]\\b|\\b${LIMB}_\\$\\{`)],
  // A fixed canvas position: an x/y (or left/top) key set to a literal of 3+ digits.
  ["canvas coordinate", /\b(?:x|y|left|top)\s*:\s*\d{3,}(?:\.\d+)?\b/]
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("generality: no template names in library source ()", () => {
  const files = SCANNED.flatMap((dir) => walk(join(SRC, dir))).map((path) => relative(SRC, path).split("\\").join("/"));
  const allowed = (file: string) => PRESETS.includes(file) || RETIRING_IN_4D_4J.includes(file) || FIXTURES.some((re) => re.test(file));

  it("scans the library", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const file of [...PRESETS, ...RETIRING_IN_4D_4J]) expect(files, file).toContain(file);
  });

  it("finds zero hits outside presets and fixtures", () => {
    const hits: string[] = [];
    for (const file of files.filter((f) => !allowed(f))) {
      readFileSync(join(SRC, file), "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const [kind, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1} ${kind}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch what they are for", () => {
    const caught = (line: string) => PATTERNS.some(([, re]) => re.test(line));
    for (const line of ['bone: "chest"', "hand_r", "`arm_${side}`", "template7-clean.png", "the fox rig", '"torso.flank_l"', "frame: { x: Math.round(width * 0.4), y: 940, width: 220 }"]) expect(caught(line), line).toBe(true);
    // Generic terms stay legal: roles, and the surface gates' strap "neck" curve.
    for (const line of ['role: "spine"', "kind: \"head\"", 'kind: "neck"', "handle_r", "forearms", "foxglove", "{ x: 0, y: 12 }", "width: 1024"]) expect(caught(line), line).toBe(false);
  });
});
