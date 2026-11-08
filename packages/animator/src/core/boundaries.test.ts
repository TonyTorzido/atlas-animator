import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The runtime core must run unchanged in the game, the editor, the CLI's headless browser and
 * Node tests (plan section 4.1): no Pixi, no DOM, no Node built-ins. Runtime modules may import
 * only each other and zod; tests and test helpers may also use vitest and node built-ins.
 * DOM types are already unavailable to the core through tsconfig ("lib": ["ES2022"]).
 */
const coreDir = new URL("./", import.meta.url);
const files = readdirSync(coreDir).filter((file) => file.endsWith(".ts"));
// Checkouts may use CRLF (core.autocrlf on Windows); compare with normalised line endings.
const readSource = (file: string) => readFileSync(new URL(file, coreDir), "utf8").replace(/\r\n/g, "\n");
const isTestFile = (file: string) => file.endsWith(".test.ts") || file === "testHelpers.ts";

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1] ?? match[2] ?? "");
  return specifiers;
}

describe("core module boundaries", () => {
  it("finds the core modules", () => {
    expect(files).toEqual(expect.arrayContaining(["format.ts", "math.ts", "bone.ts", "skeleton.ts", "index.ts"]));
  });

  for (const file of files.filter((name) => !isTestFile(name))) {
    it(`${file} imports only core modules and zod`, () => {
      const source = readSource(file);
      for (const specifier of importsOf(source)) {
        const allowed = specifier === "zod" || /^\.\/[A-Za-z]+\.js$/.test(specifier);
        expect(allowed, `${file} imports '${specifier}'`).toBe(true);
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${file} touches a browser global`).not.toMatch(/(?<![.\w])(?:window|document|globalThis|PIXI)\./);
    });

    it(`${file} carries the original-implementation header`, () => {
      const source = readSource(file);
      expect(source.startsWith("/*\n * Atlas Animator: original implementation")).toBe(true);
    });
  }

  it("the public index does not export test helpers", () => {
    const index = readFileSync(new URL("index.ts", coreDir), "utf8");
    expect(importsOf(index)).not.toContain("./testHelpers.js");
  });
});
