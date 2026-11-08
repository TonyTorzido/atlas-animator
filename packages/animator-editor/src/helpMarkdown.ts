/*
 * Atlas Animator editor: a tiny Markdown renderer for the in-app user guide (Help > User guide). It handles exactly what
 * the design notes uses: headings, paragraphs, bold, italic, inline code, links, images,
 * ordered and bullet lists, tables and rules. Everything is HTML-escaped first, so the guide cannot inject markup.
 */

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The id of a heading: lowercase words joined by "-", with a leading section number dropped ("5. Troubleshooting" -> "troubleshooting"). */
export function slug(text: string): string {
  return text
    .replace(/^[\d.]+\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Image sources in the guide are relative (`guide-shots/x.png`); the editor server serves them under /api/help/shot/. */
export function imageUrl(src: string): string {
  const m = /^(?:\.\/)?guide-shots\/([A-Za-z0-9_.-]+\.png)$/.exec(src);
  return m ? `/api/help/shot/${m[1]}` : "";
}

function inline(raw: string): string {
  const codes: string[] = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const url = imageUrl(src.replace(/&amp;/g, "&"));
    return url ? `<img src="${url}" alt="${alt}">` : esc(alt);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => (/^(https?:\/\/|#)/.test(href) ? `<a href="${href}"${href.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${text}</a>` : text));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Renders the Markdown text to an HTML string. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] ?? "#").length;
      const text = (h[2] ?? "").trim();
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableRow(line) && isTableRow(lines[i + 1] ?? "") && /^[\s|:-]+$/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = /^\s*(?:(\d+)\.|[-*])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = !!li[1];
      const items: string[] = [];
      const first = Number(li[1] ?? 1);
      while (i < lines.length) {
        const m = /^\s*(?:(\d+)\.|[-*])\s+(.*)$/.exec(lines[i] ?? "");
        if (!m || !!m[1] !== ordered) break;
        let text = m[2] ?? "";
        i++;
        // A continuation line (indented, not a new item) belongs to the item above it.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "") && !/^\s*(?:\d+\.|[-*])\s+/.test(lines[i] ?? "")) text += ` ${(lines[i++] ?? "").trim()}`;
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(ordered ? `<ol${first > 1 ? ` start="${first}"` : ""}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    // A paragraph runs to the next blank line or block start; its lines join with a space.
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,4})\s/.test(lines[i] ?? "") && !isTableRow(lines[i] ?? "") && !/^\s*(?:\d+\.|[-*])\s+/.test(lines[i] ?? "")) para.push((lines[i++] ?? "").trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
