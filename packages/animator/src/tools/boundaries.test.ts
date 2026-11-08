import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The rigging tools (plan 4.1, src/tools) run in Node only. They may import Node built-ins, the
 * allowed third-party libraries (plan section 2: cdt2d; pngjs for files), core modules and the
 * pure image modules of the Pixi adapter (no Pixi itself). Every module carries the
 * original-implementation header.
 */
const toolsDir = new URL("./", import.meta.url);
const files = readdirSync(toolsDir).filter((file) => file.endsWith(".ts"));
const readSource = (file: string) => readFileSync(new URL(file, toolsDir), "utf8").replace(/\r\n/g, "\n");

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? "");
  return specifiers;
}

const PURE_PIXI_MODULES = new Set(["../pixi/imageOps.js", "../pixi/partImages.js"]);

describe("tools module boundaries", () => {
  for (const file of files.filter((name) => !name.endsWith(".test.ts"))) {
    it(`${file} imports only allowed modules`, () => {
      for (const specifier of importsOf(readSource(file))) {
        const allowed =
          specifier.startsWith("node:") ||
          specifier === "cdt2d" ||
          specifier === "pngjs" ||
          specifier === "zod" ||
          /^\.\/[A-Za-z]+\.js$/.test(specifier) ||
          /^\.\.\/core\/(?!testHelpers)[A-Za-z]+\.js$/.test(specifier) ||
          PURE_PIXI_MODULES.has(specifier);
        expect(allowed, `${file} imports '${specifier}'`).toBe(true);
      }
    });

    it(`${file} carries the original-implementation header`, () => {
      expect(readSource(file).startsWith("/*\n * Atlas Animator: original implementation")).toBe(true);
    });
  }
});
