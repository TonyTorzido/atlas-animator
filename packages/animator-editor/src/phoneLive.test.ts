import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cookieValue, createPhoneLive, isPrivateLan, lanCandidates, parsePhonePath, proxyAllowed, tokenMatches } from "./phoneLive.js";

describe("phoneLive helpers", () => {
  it("knows private LAN addresses and leaves VPN overlay, link-local and public ones out", () => {
    expect(["192.168.1.5", "10.0.0.7", "172.16.4.1", "172.31.9.9"].every(isPrivateLan)).toBe(true);
    expect(["100.101.2.3", "169.254.1.1", "8.8.8.8", "172.32.0.1", "127.0.0.1"].some(isPrivateLan)).toBe(false);
    const nic = (address: string, internal = false) => [{ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null }];
    const list = lanCandidates({ "Wi-Fi": nic("192.168.1.20"), Overlay: nic("100.100.1.1"), "vEthernet (WSL)": nic("172.20.0.1"), Loopback: nic("127.0.0.1", true), Ethernet: nic("10.1.2.3") });
    expect(list.map((c) => c.address)).toEqual(["192.168.1.20", "10.1.2.3"]);
  });
  it("whitelists only read paths the phone page needs", () => {
    expect(proxyAllowed("GET", "/phone/abcdefgh12345678/state")).toBe(true);
    expect(proxyAllowed("GET", "/src/phonePage.ts")).toBe(true);
    expect(proxyAllowed("GET", "/node_modules/.vite/deps/pixi__js.js")).toBe(true);
    expect(proxyAllowed("GET", "/@fs/C:/repo/packages/animator/src/pixi/index.ts")).toBe(true);
    expect(proxyAllowed("GET", "/@fs/C:/Users/me/.ssh/id_rsa")).toBe(false);
    expect(proxyAllowed("POST", "/phone/abcdefgh12345678/state")).toBe(false);
    for (const p of ["/api/clips", "/api/phone/state", "/api/rig/save", "/repo/packages/animator/rigs/x.json", "/", "/index.html", "/src/main.ts", "/src/../../x.ts", "/src/%2e%2e/x.ts"]) expect(proxyAllowed("GET", p)).toBe(false);
  });
  it("parses tokens and cookies", () => {
    expect(parsePhonePath("/phone/0123456789abcdef/rig")).toEqual({ token: "0123456789abcdef", rest: "/rig" });
    expect(parsePhonePath("/phone/x/")).toBeNull();
    expect(cookieValue("a=1; atlasphone=tok; b=2", "atlasphone")).toBe("tok");
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", null)).toBe(false);
    expect(tokenMatches("abc", "abc")).toBe(true);
  });
});

const servers: Server[] = [];
const listen = (server: Server): Promise<number> =>
  new Promise((ok) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port));
  });
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const get = (port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> =>
  new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", fail);
    req.end(body);
  });

describe("phoneLive server", () => {
  it("is off until started, token-gated, read-only and whitelisted on the LAN side", async () => {
    // A stand-in for Vite: answers everything it is asked, so the whitelist is what is under test.
    const vite = createServer((req, res) => res.end(`vite:${req.url}:${req.headers["x-phone-proxy"] ?? ""}`));
    const vitePort = await listen(vite);
    const phone = createPhoneLive({ viteOrigin: () => `http://127.0.0.1:${vitePort}`, repoFile: () => null, pageHtml: () => "<html>phone</html>", host: "127.0.0.1", port: 0 });
    const editor = createServer((req, res) => phone.middleware(req, res, () => ((res.statusCode = 404), res.end("next"))));
    const editorPort = await listen(editor);

    expect((await get(editorPort, "/phone/0123456789abcdef0123456789abcdef/")).status).toBe(403);
    const status = await phone.start();
    expect(status.running).toBe(true);
    const token = /\/phone\/([0-9a-f]{32})\//.exec(status.url!)![1]!;
    const lanPort = status.port!;
    expect(lanPort).not.toBe(editorPort);

    // page: needs the token, sets the cookie
    expect((await get(editorPort, "/phone/ffffffffffffffffffffffffffffffff/")).status).toBe(403);
    const page = await get(editorPort, `/phone/${token}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("phone");
    expect(String(page.headers["set-cookie"])).toContain(`atlasphone=${token}`);
    expect((await get(editorPort, `/phone/${token}/state`, {}, "POST", "{}")).status).toBe(405);

    // editor pushes, phone reads
    expect((await get(editorPort, `/phone/${token}/state`)).text).toContain("waiting");
    const bad = await get(editorPort, "/api/phone/state", { "content-type": "application/json" }, "POST", JSON.stringify({ clipName: "c" }));
    expect(bad.status).toBe(400);
    const rig = { raw: { format: "atlas-anim@1" }, meta: { document: "d", atlas: "a", standIn: false, skins: ["body"] } };
    const pushed = await get(editorPort, "/api/phone/state", { "content-type": "application/json" }, "POST", JSON.stringify({ clipName: "c", clip: { duration: 1 }, facing: "left", rig }));
    expect(JSON.parse(pushed.text)).toMatchObject({ rev: 1, rigRev: 1 });
    const state = JSON.parse((await get(editorPort, `/phone/${token}/state?c=abc`)).text);
    expect(state).toMatchObject({ rev: 1, rigRev: 1, clipName: "c", clip: { duration: 1 }, facing: "left", rigMeta: { atlas: "a" } });
    expect(JSON.parse((await get(editorPort, `/phone/${token}/rig`)).text)).toEqual(rig.raw);
    expect(phone.status().phones).toBe(1);
    // a rig-less push keeps the rig revision
    await get(editorPort, "/api/phone/state", {}, "POST", JSON.stringify({ clipName: "c", clip: { duration: 2 }, facing: "right" }));
    expect(JSON.parse((await get(editorPort, `/phone/${token}/state`)).text)).toMatchObject({ rev: 2, rigRev: 1, facing: "right" });

    // LAN side: only the whitelist, only with the token or the cookie, never the editor API or a write
    expect((await get(lanPort, `/phone/${token}/state`)).text).toContain("vite:/phone/");
    expect((await get(lanPort, "/phone/ffffffffffffffffffffffffffffffff/state")).status).toBe(403);
    expect((await get(lanPort, "/src/phonePage.ts")).status).toBe(403);
    expect((await get(lanPort, "/src/phonePage.ts", { cookie: "atlasphone=wrong" })).status).toBe(403);
    const asset = await get(lanPort, "/src/phonePage.ts", { cookie: `atlasphone=${token}` });
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("vite:/src/phonePage.ts:1");
    for (const path of ["/api/clips", "/api/phone/status", "/api/rig/save", "/repo/packages/animator/rigs/a.json", "/"]) expect((await get(lanPort, path, { cookie: `atlasphone=${token}` })).status).toBe(404);
    expect((await get(lanPort, `/phone/${token}/state`, {}, "POST", "{}")).status).toBe(404);
    // the editor API refuses anything that came through the LAN server, even if it were forwarded
    expect((await get(editorPort, "/api/phone/status", { "x-phone-proxy": "1" })).status).toBe(403);

    // stop forgets the token and closes the LAN server
    phone.stop();
    expect((await get(editorPort, `/phone/${token}/state`)).status).toBe(403);
    await expect(get(lanPort, `/phone/${token}/state`)).rejects.toThrow();
  });
});
