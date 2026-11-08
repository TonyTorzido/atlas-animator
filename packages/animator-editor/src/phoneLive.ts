/*
 * Atlas Animator editor: "Phone preview" server side (Node; used by vite.config.ts). The user scans a QR code and their phone plays the
 * clip being edited at real game size, updating as he edits. Everything stays on the local network while the PC is on.
 *
 * LAN exposure is opt-in and does NOT change Vite's own host (that stays 127.0.0.1): pressing "Phone preview" starts a second, tiny
 * read-only server that listens on 0.0.0.0, accepts only connections that arrive on a private LAN address from a private or loopback
 * peer (never VPN overlay, never a public address), and forwards a short whitelist of GET paths to Vite. Pressing Stop (or closing the
 * dev server) closes it and forgets the token. ATLAS_PHONE_HOST / ATLAS_PHONE_PORT override the bind address and port.
 *
 * Routes (the editor, over loopback only; refused when they arrive through the LAN server):
 *   GET  /api/phone/status   -> { running, url, urls, lan, phones, ... }
 *   POST /api/phone/start    -> starts the LAN server with a fresh random token, returns the status
 *   POST /api/phone/stop     -> stops it
 *   POST /api/phone/state    -> the editor's current { clipName, clip, facing, rig? } (rig only when it changed)
 * The phone (needs the token in the path; the page also sets a cookie so the script modules may load):
 *   GET /phone/<token>/        the page (phone.html)
 *   GET /phone/<token>/state   { rev, rigRev, clipName, clip, facing, rigMeta } (the phone polls this about twice a second)
 *   GET /phone/<token>/rig     the rig document JSON when rigRev changed
 *   GET /phone/<token>/repo/<path>   atlas json and png pages under packages/animator/rigs only
 * The phone can never write: the LAN server forwards GET and HEAD only, and /api/* is not on its whitelist.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

export const PHONE_COOKIE = "atlasphone";
const PROXY_HEADER = "x-phone-proxy";
const POLL_WINDOW_MS = 3000;
const MAX_BODY = 48 << 20;

export interface LanCandidate {
  name: string;
  address: string;
}

const VIRTUAL_NAME = /VPN overlay|vethernet|wsl|docker|virtualbox|vmware|hyper-?v|loopback|bluetooth|vpn|zerotier|hamachi|npcap|tap-|tun/i;

const ipv4 = (a: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  return m ? m.slice(1).map(Number) : null;
};

/** 10/8, 172.16/12, 192.168/16: addresses a home or office router hands out. */
export function isPrivateLan(address: string): boolean {
  const p = ipv4(address);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

export const isLoopback = (address: string | undefined): boolean => !!address && (address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127."));

/** Strips the IPv4-mapped IPv6 prefix some sockets report. */
const plain = (address: string | undefined): string => (address ?? "").replace(/^::ffff:/, "");

/** The PC's Wi-Fi / Ethernet addresses a phone can reach, best first. VPN overlay (100.64/10), link-local and virtual adapters are left out. */
export function lanCandidates(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal || !isPrivateLan(info.address)) continue;
      out.push({ name, address: info.address });
    }
  }
  const rank = (a: string): number => (a.startsWith("192.168.") ? 0 : a.startsWith("10.") ? 1 : 2);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

export const newToken = (): string => randomBytes(16).toString("hex");

export function tokenMatches(given: string | undefined | null, expected: string | null): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** `/phone/<token>/<rest>` -> { token, rest } ("rest" starts with a slash or is empty). */
export function parsePhonePath(pathname: string): { token: string; rest: string } | null {
  const m = /^\/phone\/([A-Za-z0-9]{8,64})(\/.*)?$/.exec(pathname);
  return m ? { token: m[1]!, rest: m[2] ?? "" } : null;
}

/**
 * The only paths the LAN server forwards to Vite. The phone page lives under /phone/<token>/; its script modules load from the
 * editor's own source and the pre-bundled libraries (read-only). Everything else, /api/* and /repo/* included, is refused.
 */
export function proxyAllowed(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (p.includes("..") || p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/phone/")) return true;
  if (p === "/@vite/env" || p.startsWith("/@id/")) return true;
  if (p.startsWith("/src/")) return /\.(ts|js|css|json)$/.test(p) && !/\/main\.ts$/.test(p);
  if (p.startsWith("/node_modules/")) return true;
  if (p.startsWith("/@fs/")) return /\/(packages\/(animator|shared|animator-editor)\/src|node_modules)\//.test(p);
  return false;
}

export interface PhoneRigMeta {
  document: string;
  atlas: string;
  standIn: boolean;
  skins: string[];
}

export interface PhoneStatus {
  running: boolean;
  url: string | null;
  /** The same page on every LAN address the PC has. */
  urls: string[];
  /** False when no private LAN address was found (the URL then only works on this PC). */
  lan: boolean;
  host: string | null;
  port: number | null;
  /** Distinct phones that polled in the last few seconds. */
  phones: number;
  rev: number;
  hasState: boolean;
}

export interface PhoneLiveOptions {
  /** Vite's own origin, e.g. http://127.0.0.1:5211 (null until it listens). */
  viteOrigin(): string | null;
  /** Absolute file for a repo-relative path the phone may read (rigs only), or null. */
  repoFile(rel: string): string | null;
  /** phone.html. */
  pageHtml(): string;
  /** Port of the LAN server: 0 picks a free one. The preferred port is tried first when `fallback` is set. */
  port?: number;
  fallback?: boolean;
  /** Bind address override (tests, ATLAS_PHONE_HOST). */
  host?: string;
}

type Next = () => void;

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const MIME: Record<string, string> = { ".json": "application/json", ".png": "image/png" };

export function createPhoneLive(options: PhoneLiveOptions) {
  let token: string | null = null;
  let lan: Server | null = null;
  let bound: { host: string; port: number; lan: boolean; allowedLocal: Set<string> } | null = null;
  let candidates: LanCandidate[] = [];
  let rev = 0;
  let rigRev = 0;
  let rigJson = "null";
  let rigMeta: PhoneRigMeta | null = null;
  let live: { clipName: string; clip: unknown; facing: string } | null = null;
  const polled = new Map<string, number>();

  const phones = (): number => {
    const now = Date.now();
    for (const [id, t] of polled) if (now - t > POLL_WINDOW_MS) polled.delete(id);
    return polled.size;
  };

  const urlsFor = (): string[] => (token && bound ? (bound.lan ? candidates.map((c) => c.address) : [bound.host]).map((h) => `http://${h}:${bound!.port}/phone/${token}/`) : []);

  const status = (): PhoneStatus => ({
    running: !!lan,
    url: urlsFor()[0] ?? null,
    urls: urlsFor(),
    lan: !!bound?.lan,
    host: bound?.host ?? null,
    port: bound?.port ?? null,
    phones: phones(),
    rev,
    hasState: !!live
  });

  /** Forwards one allowed request to Vite. */
  function forward(req: IncomingMessage, res: ServerResponse): void {
    const origin = options.viteOrigin();
    if (!origin) return send(res, 503, { error: "editor not ready" });
    const target = new URL(origin);
    const headers = { ...req.headers, host: target.host, [PROXY_HEADER]: "1" };
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
    const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => send(res, 502, { error: "editor unreachable" }));
    up.end();
  }

  function lanHandler(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://lan");
    if (!proxyAllowed(req.method, url.pathname)) return send(res, 404, { error: "not found" });
    const phone = parsePhonePath(url.pathname);
    const ok = phone ? tokenMatches(phone.token, token) : tokenMatches(cookieValue(req.headers.cookie, PHONE_COOKIE), token);
    if (!ok) return send(res, 403, { error: "forbidden" });
    forward(req, res);
  }

  async function start(): Promise<PhoneStatus> {
    if (lan) return status();
    candidates = lanCandidates();
    const forced = options.host ?? process.env.ATLAS_PHONE_HOST;
    const bindHost = forced || "0.0.0.0";
    const wanted = Number(process.env.ATLAS_PHONE_PORT ?? options.port ?? 0);
    const allowedLocal = new Set(["127.0.0.1", "::1", ...candidates.map((c) => c.address), ...(forced ? [forced] : [])]);
    const server = createServer(lanHandler);
    server.on("connection", (socket) => {
      const peer = plain(socket.remoteAddress);
      const local = plain(socket.localAddress);
      const peerOk = isLoopback(peer) || isPrivateLan(peer);
      const localOk = allowedLocal.has(local) || isLoopback(local);
      if (!peerOk || !localOk) socket.destroy();
    });
    const listen = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindHost, () => {
          server.off("error", reject);
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    let port: number;
    try {
      port = await listen(wanted);
    } catch (error) {
      if (!wanted || !(options.fallback ?? true) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      port = await listen(0);
    }
    token = newToken();
    lan = server;
    bound = { host: forced || candidates[0]?.address || "127.0.0.1", port, lan: !forced && candidates.length > 0, allowedLocal };
    return status();
  }

  function stop(): PhoneStatus {
    lan?.close();
    lan?.closeAllConnections();
    lan = null;
    bound = null;
    token = null;
    polled.clear();
    return status();
  }

  /** The Vite middleware: editor routes (/api/phone/*) and the phone's own routes (/phone/<token>/*). */
  function middleware(req: IncomingMessage, res: ServerResponse, next: Next): void {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname.startsWith("/api/phone/")) {
      // Editor-only: never through the LAN server, never from a non-loopback peer.
      if (req.headers[PROXY_HEADER] || !isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: "forbidden" });
      void (async () => {
        try {
          const op = url.pathname.slice("/api/phone/".length);
          if (op === "status" && req.method === "GET") return send(res, 200, status());
          if (op === "start" && req.method === "POST") return send(res, 200, await start());
          if (op === "stop" && req.method === "POST") return send(res, 200, stop());
          if (op === "state" && req.method === "POST") {
            const body = JSON.parse(await readBody(req)) as { clipName?: unknown; clip?: unknown; facing?: unknown; rig?: { raw?: unknown; meta?: PhoneRigMeta } | null };
            if (typeof body.clipName !== "string" || !body.clip || typeof body.clip !== "object" || (body.facing !== "left" && body.facing !== "right")) return send(res, 400, { error: "expected { clipName, clip, facing, rig? }" });
            if (body.rig?.raw && body.rig.meta) {
              rigJson = JSON.stringify(body.rig.raw);
              rigMeta = body.rig.meta;
              rigRev++;
            }
            live = { clipName: body.clipName, clip: body.clip, facing: body.facing };
            rev++;
            return send(res, 200, { rev, rigRev });
          }
          send(res, 404, { error: "not found" });
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return;
    }
    if (url.pathname.startsWith("/phone/")) {
      const phone = parsePhonePath(url.pathname);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only" });
      if (!phone || !tokenMatches(phone.token, token)) return send(res, 403, { error: "forbidden" });
      const { rest } = phone;
      if (rest === "" || rest === "/") {
        res.setHeader("Set-Cookie", `${PHONE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
        return send(res, 200, options.pageHtml(), "text/html; charset=utf-8");
      }
      if (rest === "/state") {
        const client = url.searchParams.get("c")?.slice(0, 40);
        if (client) polled.set(client, Date.now());
        if (!live) return send(res, 200, { rev: 0, rigRev: 0, waiting: true });
        return send(res, 200, { rev, rigRev, ...live, rigMeta });
      }
      if (rest === "/rig") return send(res, 200, rigJson);
      if (rest.startsWith("/repo/")) {
        let rel: string;
        try {
          rel = decodeURIComponent(rest.slice("/repo/".length));
        } catch {
          return send(res, 400, { error: "bad path" });
        }
        const file = /\.(json|png)$/.test(rel) && !rel.includes("..") ? options.repoFile(rel) : null;
        if (!file || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
        return send(res, 200, readFileSync(file), MIME[extname(file)] ?? "application/octet-stream");
      }
      return send(res, 404, { error: "not found" });
    }
    next();
  }

  return { middleware, start, stop, status };
}
