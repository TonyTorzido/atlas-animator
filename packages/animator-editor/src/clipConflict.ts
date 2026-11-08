/*
 * Atlas Animator editor: optimistic concurrency for clip saves (shared by the browser and the dev server).
 *
 * The editor remembers the hash of the saved clip text it last saw (opened from disk or written by its own save) and sends it
 * as the X-Clip-Base header; `new` means "I expect no saved file". The server refuses (409) a save whose base does not match
 * the file on disk, so a second tab or window can no longer overwrite a clip silently. A request without the header is not
 * checked (scripts and old pages keep working).
 */

export const CLIP_BASE_HEADER = "x-clip-base";
/** Base value meaning "this clip was never saved from here: refuse if a saved file exists". */
export const CLIP_BASE_NEW = "new";

/** A fast, stable 53-bit hash (cyrb53) of a text, as 14 hex digits; the same in Node and the browser. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export type ClipConflict = { ok: true } | { ok: false; current: string | null; message: string };

/**
 * Decides whether a save may overwrite. `base` is the request header (undefined = unchecked), `currentText` the saved file's
 * text (null = no file yet).
 */
export function checkClipBase(name: string, base: string | undefined, currentText: string | null): ClipConflict {
  if (base === undefined || base === "") return { ok: true };
  const current = currentText === null ? null : textHash(currentText);
  if (base === CLIP_BASE_NEW) {
    if (current === null) return { ok: true };
    return { ok: false, current, message: `${name} already exists on disk (saved from another tab/window or earlier)` };
  }
  if (current === base) return { ok: true };
  return { ok: false, current, message: current === null ? `${name} was deleted on disk since this tab opened it` : `${name} changed in another tab/window since this tab opened it` };
}

/** A free "<name>_copy", "<name>_copy2", ... clip name. */
export function copyClipName(name: string, taken: (candidate: string) => boolean): string {
  for (let i = 1; ; i++) {
    const candidate = `${name}_copy${i === 1 ? "" : i}`;
    if (!taken(candidate)) return candidate;
  }
}
