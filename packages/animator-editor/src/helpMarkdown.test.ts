import { describe, expect, it } from "vitest";
import { imageUrl, renderMarkdown, slug } from "./helpMarkdown.js";

describe("help markdown renderer", () => {
  it("renders headings with ids, paragraphs and inline styles", () => {
    const html = renderMarkdown("# Title\n\n## 5. Troubleshooting\n\nPress **Save** or `Ctrl+S`.\nSecond *line*.");
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<h2 id="troubleshooting">5. Troubleshooting</h2>');
    expect(html).toContain("<p>Press <strong>Save</strong> or <code>Ctrl+S</code>. Second <em>line</em>.</p>");
  });

  it("renders ordered and bullet lists and tables", () => {
    const html = renderMarkdown("1. one\n2. two\n   more\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| 1 | `x` |");
    expect(html).toContain("<ol><li>one</li><li>two more</li></ol>");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td><code>x</code></td>");
  });

  it("keeps the number a list starts at (a screenshot can split a numbered list)", () => {
    expect(renderMarkdown("3. third\n4. fourth")).toContain('<ol start="3"><li>third</li><li>fourth</li></ol>');
  });

  it("serves guide images from the help route and drops other sources", () => {
    expect(imageUrl("guide-shots/g01-home.png")).toBe("/api/help/shot/g01-home.png");
    expect(imageUrl("../../secret.png")).toBe("");
    expect(renderMarkdown("![Home](guide-shots/g01-home.png)")).toContain('<img src="/api/help/shot/g01-home.png" alt="Home"');
    expect(renderMarkdown("![x](https://evil.example/a.png)")).not.toContain("<img");
  });

  it("escapes HTML and refuses script links", () => {
    const html = renderMarkdown("<script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  it("makes slugs without the section number", () => {
    expect(slug("3. Where your files live")).toBe("where-your-files-live");
  });
});
