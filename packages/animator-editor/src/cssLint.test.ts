// Enforces the component-layer rules documented at the top of src/components.css, and bans native dialogs.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL(".", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, SRC), "utf8");
const cssFiles = readdirSync(SRC).filter((f) => f.endsWith(".css"));
const htmlStyle = (file: string): string => [...readFileSync(new URL(`../${file}`, SRC), "utf8").matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
const sources: Array<[string, string]> = [...cssFiles.map((f): [string, string] => [f, read(f)]), ["index.html", htmlStyle("index.html")]]; // phone.html is the separate phone companion page

/** [selector, body] for every declaration block that is not :root. */
function blocks(css: string): Array<[string, string]> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<[string, string]> = [];
  for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) if (!m[1]!.trim().endsWith(":root")) out.push([m[1]!.trim(), m[2]!]);
  return out;
}
const ICON_SELECTOR = /\.ico|svg|\.swatch|\.range|canvas/;
const find = (re: (sel: string, body: string) => string[]): string[] => sources.flatMap(([file, css]) => blocks(css).flatMap(([sel, body]) => re(sel, body).map((x) => `${file}: ${sel.slice(0, 50)} -> ${x}`)));

describe("css lint", () => {
  it("has no raw hex colour outside :root", () => {
    expect(find((_s, b) => [...b.matchAll(/(?<![\w&-])#[0-9a-fA-F]{3,8}\b(?![-\w])/g)].map((m) => m[0]))).toEqual([]);
  });
  it("sets font-size only from the --fs-* tokens", () => {
    expect(find((_s, b) => [...b.matchAll(/font-size:\s*([^;]+)/g)].map((m) => m[1]!.trim()).filter((v) => !/^(var\(--fs-[a-z0-9]+\)|inherit)( !important)?$/.test(v)))).toEqual([]);
    expect(find((_s, b) => [...b.matchAll(/(?<![-\w])font:\s*(\d[^;\s]*)/g)].map((m) => m[1]!))).toEqual([]);
  });
  it("keeps control heights on the 16 / 24 / 28 / 32 scale (44 and up are layout sizes)", () => {
    const bad = find((sel, b) => (ICON_SELECTOR.test(sel) ? [] : [...b.matchAll(/(?<![-\w])(?:min-)?height:\s*(\d+)px/g)].map((m) => Number(m[1])).filter((v) => v >= 13 && v <= 43 && ![16, 24, 28, 32].includes(v)).map(String)));
    expect(bad).toEqual([]);
  });
  it("leaves scrollbars hidden (no scrollbar-width or ::-webkit-scrollbar overrides)", () => {
    const text = sources.map(([f, c]) => `${f}\n${c}`).join("\n");
    expect(text.match(/scrollbar-width:\s*(thin|auto)/g) ?? []).toEqual([]);
    expect(text.match(/scrollbar-color/g) ?? []).toEqual([]);
    expect(find((sel, b) => (/::-webkit-scrollbar/.test(sel) && !/display:\s*none/.test(b) ? ["visible webkit scrollbar"] : []))).toEqual([]);
  });
});

describe("native dialogs", () => {
  it("are not used in src/*.ts (use src/dialog.ts)", () => {
    const hits: string[] = [];
    for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      read(f).split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\.|(?!\1).)*\1/g, '""');
        if (/(window\.|globalThis\.)(prompt|confirm|alert)\(|(?<![\w.$])(prompt|confirm|alert)\(/.test(code)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
