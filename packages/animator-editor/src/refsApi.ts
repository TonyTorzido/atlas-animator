/*
 * Atlas Animator editor: the dev-server side of the reference underlay (Node; used by vite.config.ts).
 *
 * - GET  /api/refs                 the refs.json store { [clip]: RefMeta } from the clips folder (next to board.json);
 * - POST /api/refs/<clip>          saves (body = RefMeta) or removes (body = null) one clip's reference;
 * - GET  /api/refs/media?path=     streams a local video or image with Range support (a video must seek);
 * - GET  /api/refs/dir?path=       the image files of a folder, natural-sorted: the frames of an image sequence.
 * Only media extensions are served, and only absolute paths. The dev server listens on the local machine and is the editor's own tool.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { MB, readBodyLimited, writeAtomic } from "./safeFs.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { IMAGE_EXT, isImagePath, isVideoPath, parseRef, parseRefStore, REF_CLIP_ID, sequenceOrder, type RefMeta } from "./refModel.js";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

/** Serves the file with a Range reply when asked (browsers seek a video with byte ranges). */
export function serveMedia(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = statSync(file).size;
  res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(size));
  createReadStream(file).pipe(res);
}

/** Handles the /api/refs routes; returns true when it answered the request. */
export function handleRefsApi(req: IncomingMessage, res: ServerResponse, url: URL, saveDir: string): boolean {
  if (url.pathname !== "/api/refs" && !url.pathname.startsWith("/api/refs/")) return false;
  const store = resolve(saveDir, "refs.json");
  const read = (): Record<string, RefMeta> => (existsSync(store) ? parseRefStore(JSON.parse(readFileSync(store, "utf8"))) : {});
  try {
    if (req.method === "GET" && url.pathname === "/api/refs") {
      json(res, 200, read());
      return true;
    }
    if (req.method === "GET" && (url.pathname === "/api/refs/media" || url.pathname === "/api/refs/dir")) {
      const path = url.searchParams.get("path") ?? "";
      if (!isAbsolute(path) || !existsSync(path)) {
        json(res, 404, { error: "no such path (an absolute path is needed)" });
        return true;
      }
      if (url.pathname === "/api/refs/dir") {
        if (!statSync(path).isDirectory()) {
          json(res, 400, { error: "not a folder" });
          return true;
        }
        const files = readdirSync(path).filter((f) => (IMAGE_EXT as readonly string[]).includes(extname(f).toLowerCase())).sort(sequenceOrder);
        json(res, 200, { files: files.map((f) => resolve(path, f)) });
        return true;
      }
      if (!statSync(path).isFile() || !(isVideoPath(path) || isImagePath(path))) {
        json(res, 400, { error: "only video and image files are served" });
        return true;
      }
      serveMedia(req, res, path);
      return true;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/refs/")) {
      const clip = decodeURIComponent(url.pathname.slice("/api/refs/".length));
      if (!REF_CLIP_ID.test(clip)) {
        json(res, 400, { error: "bad clip name" });
        return true;
      }
      void readBodyLimited(req, MB).then((text) => {
        try {
          const body = JSON.parse(text) as unknown;
          const all = read();
          if (body === null) delete all[clip];
          else {
            const meta = parseRef(body);
            if (!meta) return json(res, 400, { error: "expected a reference { kind, path, fps, offsetFrames, speed, transform, trace } or null" });
            all[clip] = meta;
          }
          writeAtomic(store, `${JSON.stringify(all, null, 2)}\n`);
          json(res, 200, { ok: true });
        } catch (error) {
          const e = error as { status?: number; code?: string };
          json(res, typeof e.status === "number" ? e.status : e.code ? 500 : 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }, (error: unknown) => json(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  json(res, 405, { error: "unsupported" });
  return true;
}
