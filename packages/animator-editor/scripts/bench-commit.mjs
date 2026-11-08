// Commit-time bench for the mesh tools (MESH-WEIGHTS-PLAN P1), in a sandbox server (scripts/demo-server.mjs; never port 5211):
//   times host.setupRun (command batch + replaceRig/remount) for a weights.table and a mesh.edit commit on the largest mesh,
//   plus the same two commits through the fast path (host.patchMeshGeometry) when the editor offers one. Target: <= 150 ms.
//   node packages/animator-editor/scripts/bench-commit.mjs [outfit=turned-l] [runs=9]
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoServer } from "./demo-server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const { chromium } = createRequire(resolve(here, "../../animator/package.json"))("@playwright/test");
const outfit = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "turned-l";
const runs = Number(process.argv[3] ?? 9);
const { url } = await demoServer();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 60_000 });
await page.waitForTimeout(1200);
await page.evaluate((id) => window.atlasEditor.mountOutfit(id), outfit);
await page.waitForTimeout(1500);
await page.evaluate(() => window.atlasEditor.setMode("setup"));
await page.waitForTimeout(500);

const profileOut = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
const cdp = profileOut ? await page.context().newCDPSession(page) : null;
if (cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
const result = await page.evaluate(async (n) => {
  const E = window.atlasEditor;
  const meshes = E.meshes().sort((a, b) => b.vertexCount - a.vertexCount);
  let big = meshes[0];
  let addr = { skin: big.skin, slot: big.slot, name: big.attachment };
  const meshOf = (raw) => raw.skins[addr.skin].attachments[addr.slot][addr.name];
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const out = { outfit: E.rigInfo?.() ?? null, mesh: { ...big }, runs: n };
  let parts = null;
  const time = async (label, make, probe) => {
    const ms = [];
    if (probe) {
      // mesh.edit refuses meshes with draw groups: ungroup the largest mesh first (the real flow), then take the largest it accepts.
      await E.setupRun("bench ungroup", () => ({ commands: [{ op: "mesh.groups", ...addr, groups: null }] }));
      for (const candidate of meshes) {
        big = candidate;
        addr = { skin: big.skin, slot: big.slot, name: big.attachment };
        if (await E.setupRun(label, (raw) => ({ commands: [make(raw, 1)] }))) break;
        out.skipped = [...(out.skipped ?? []), `${big.slot}/${big.attachment}: ${document.querySelector("#status")?.textContent}`];
      }
    }
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const ok = await E.setupRun(label, (raw) => ({ commands: [make(raw, i)] }));
      await new Promise((r) => requestAnimationFrame(() => r()));
      ms.push(performance.now() - t0);
      if (!ok) throw new Error(`${label} was refused: ${(out.skipped ?? []).join(" | ")}`);
    }
    out.mesh = { ...big };
    const part = (name) => +median(performance.getEntriesByName(name).slice(-n).map((e) => e.duration)).toFixed(1);
    parts = { commands: part("setup.commands"), replaceRig: part("setup.replaceRig") };
    return { parts, median: +median(ms).toFixed(1), max: +Math.max(...ms).toFixed(1), all: ms.map((m) => +m.toFixed(1)) };
  };
  out.weightsTable = { mesh: { ...big }, ...(await time("bench weights.table", (raw) => {
    const m = meshOf(raw);
    const columns = [...m.bones];
    const rows = [];
    let c = 0;
    for (let v = 0; v < m.uvs.length / 2; v++) {
      const k = m.vertices[c++];
      const row = new Array(columns.length).fill(0);
      for (let j = 0; j < k; j++, c += 4) row[m.vertices[c]] = m.vertices[c + 3];
      rows.push(...row);
    }
    return { op: "weights.table", ...addr, influences: columns, weights: rows };
  })) };
  out.meshEdit = await time("bench mesh.edit", (raw, i) => {
    const m = meshOf(raw);
    const points = m.uvs.map((u, j) => (j % 2 === 0 ? u * m.width : u * m.height));
    points[0] += i % 2 ? 0.5 : -0.5;
    return { op: "mesh.edit", ...addr, points, triangles: m.triangles, hull: m.hull, origin: Array.from({ length: m.uvs.length / 2 }, (_, j) => j) };
  }, true);
  return out;
}, runs);
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  (await import("node:fs")).writeFileSync(profileOut, JSON.stringify(profile));
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.log("top self time (ms):");
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${v.toFixed(0).padStart(6)}  ${k}`);
}
console.log(JSON.stringify({ ...result, weightsTable: { ...result.weightsTable, all: undefined }, meshEdit: { ...result.meshEdit, all: undefined } }));
if (errors.length) console.log("page errors:", errors.join("; "));
await browser.close();
process.exit(errors.length ? 1 : 0);
