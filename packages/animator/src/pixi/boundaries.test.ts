import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The Pixi adapter depends on the core and Pixi only (plan 4.1): runtime modules may import
 * pixi.js, core modules and each other, never Node built-ins or other packages. The core must
 * never import the adapter (checked by src/core/boundaries.test.ts, which allows only core
 * modules and zod there).
 */
const pixiDir = new URL("./", import.meta.url);
const files = readdirSync(pixiDir).filter((file) => file.endsWith(".ts"));
const readSource = (file: string) => readFileSync(new URL(file, pixiDir), "utf8").replace(/\r\n/g, "\n");

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? "");
  return specifiers;
}

describe("pixi adapter module boundaries", () => {
  it("finds the adapter modules", () => {
    expect(files).toEqual(expect.arrayContaining(["animatorCharacter.ts", "dynamicAtlas.ts", "index.ts"]));
  });

  for (const file of files.filter((name) => !name.endsWith(".test.ts"))) {
    it(`${file} imports only pixi.js, core modules and adapter modules`, () => {
      for (const specifier of importsOf(readSource(file))) {
        const allowed = specifier === "pixi.js" || /^\.\/[A-Za-z]+\.js$/.test(specifier) || /^\.\.\/core\/(?!testHelpers)[A-Za-z]+\.js$/.test(specifier);
        expect(allowed, `${file} imports '${specifier}'`).toBe(true);
      }
    });

    it(`${file} carries the original-implementation header`, () => {
      expect(readSource(file).startsWith("/*\n * Atlas Animator: original implementation")).toBe(true);
    });
  }
});
