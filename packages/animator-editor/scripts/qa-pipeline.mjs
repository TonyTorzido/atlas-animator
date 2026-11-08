// Pipeline persistence + Publish validator QA (Batch 9, PL-10): everything a rigger makes survives save -> reload -> Publish, and what
// Publish writes loads the way the project would load it. Runs a sandboxed dev server (free port) on a temp data folder and a temp
// ATLAS_EDITOR_STOCK_ROOT (a copy of the kit-body-cutout rig only): the real repo rigs, :5211 and the user's data are never touched.
//   node packages/animator-editor/scripts/qa-pipeline.mjs [--headed] [--keep] [--json=rows.json]
// `pnpm qa` runs it as area "pipeline" (qa-core.mjs); `pnpm animator:verify` runs it as its own step.
// Rows (area "pipeline"):
//   new rig from the practice-kit PSD -> reload: document deep-equal (editor vs disk vs before) and every atlas page loads
//   swag item through the wizard API (buildItemBatch + /api/rig/save) -> reload: skin present, every piece resolves, pages packed
//   pose / smear / clip (v2 events with audio, colour and constraint-mix keys) round trips
//   publish rig + clip -> validatePublish passes, manifest hashes equal the data-folder files
//   publish of an unregistered (New-rig) id answers 400 with the register hint; a stale publish token answers 409
//   every gameClips.ts id has a clipMap.json row or is listed as not in project
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const PKG = resolve(here, "..");
const REPO = resolve(PKG, "../..");
const require = createRequire(resolve(PKG, "../animator/package.json"));
const { chromium } = require("@playwright/test");
const argv = process.argv.slice(2);
const PSD = process.env.ANIMATOR_QA_PSD ?? "";
const KIT = "packages/animator/rigs/kit-body-cutout";
const KIT_DOC = `${KIT}/kit-body-cutout.anim.json`;
const KIT_ATLAS = `${KIT}/kit-body-cutout.atlas.json`;
const sha1 = (b) => createHash("sha1").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------------------------- results
const rows = [];
const rec = (name, status, detail = "") => {
  rows.push({ area: "pipeline", name, status, detail: String(detail).replace(/\s+/g, " ").slice(0, 300) });
  process.stdout.write(`${status.padEnd(5)} pipeline  ${name}${detail && status !== "PASS" ? `  -- ${String(detail).replace(/\s+/g, " ").slice(0, 240)}` : ""}\n`);
};
async function test(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error("timed out after 120s")), 120_000))]);
    rec(name, "PASS");
  } catch (e) {
    rec(name, e?.skip ? "SKIP" : "FAIL", e?.message ?? String(e));
  }
}
const need = (cond, msg) => {
  if (!cond) throw new Error(typeof msg === "function" ? msg() : msg);
};

// ---------------------------------------------------------------------------------------------------------------- sandbox
const tmp = mkdtempSync(resolve(tmpdir(), "atlas-qa-pipeline-"));
const stock = resolve(tmp, "stock");
const data = resolve(tmp, "data");
const home = resolve(tmp, "home");
for (const d of [data, home, resolve(home, "AppData")]) mkdirSync(d, { recursive: true });
{
  // The stock copy: the rig document, its atlas manifest and the pages the manifest lists (not the 190 MB of build history).
  const src = resolve(REPO, KIT);
  const dst = resolve(stock, KIT);
  mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(src, "kit-body-cutout.atlas.json"), "utf8"));
  for (const f of ["kit-body-cutout.anim.json", "kit-body-cutout.atlas.json", ...manifest.pages.map((p) => p.file)]) copyFileSync(resolve(src, f), resolve(dst, f));
  mkdirSync(resolve(stock, "packages/animator/clips"), { recursive: true });
}
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const port = await freePort();
if (port === 5211) throw new Error("refusing port 5211");
const viteBin = resolve(dirname(createRequire(resolve(PKG, "package.json")).resolve("vite/package.json")), "bin/vite.js");
const serverLog = [];
const server = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: PKG,
  env: { ...process.env, ATLAS_EDITOR_DATA_DIR: data, ATLAS_EDITOR_STOCK_ROOT: stock, USERPROFILE: home, APPDATA: resolve(home, "AppData") },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (b) => serverLog.push(String(b)));
server.stderr.on("data", (b) => serverLog.push(String(b)));
const url = `http://127.0.0.1:${port}/`;
const cleanup = () => {
  try {
    server.kill();
  } catch {}
  if (!argv.includes("--keep")) {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
};
process.on("exit", cleanup);
for (let i = 0; i < 240; i++) {
  if (server.exitCode !== null) throw new Error(`server exited: ${serverLog.join("")}`);
  try {
    if ((await fetch(`${url}api/clips`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
const api = async (path, body, method) => {
  const res = await fetch(url + path, body === undefined ? { method: method ?? "GET" } : { method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};

const browser = await chromium.launch({ headless: !argv.includes("--headed"), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const E = (fn, arg) => page.evaluate(fn, arg);
const boot = async () => {
  await page.goto(url);
  await page.waitForFunction(() => !!window.atlasEditor, null, { timeout: 90_000 });
  await page.waitForTimeout(800);
};
const mount = async (id) => {
  await E((i) => window.atlasEditor.mountOutfit(i), id);
  await page.waitForTimeout(800);
};
/** Every page of an atlas manifest decodes in the browser (naturalWidth > 0). */
const pagesLoad = (atlas) =>
  E(async (atlasPath) => {
    const m = await (await fetch(`/repo/${atlasPath}?v=${Date.now()}`)).json();
    const dir = atlasPath.slice(0, atlasPath.lastIndexOf("/") + 1);
    const out = [];
    for (const p of m.pages) {
      const w = await new Promise((ok) => {
        const img = new Image();
        img.onload = () => ok(img.naturalWidth);
        img.onerror = () => ok(0);
        img.src = `/repo/${dir}${p.file}?v=${Date.now()}`;
      });
      out.push({ file: p.file, w });
    }
    return out;
  }, atlas);
const diskDoc = (doc) => E(async (d) => (await fetch(`/repo/${d}?v=${Date.now()}`)).json(), doc);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await boot();

// ---------------------------------------------------------------------------------------------------------------- 1. New rig from the PSD
let newRig = null;
await test("new rig from the practice-kit PSD -> reload: the document deep-equals (editor before, editor after, disk) and every atlas page loads", async () => {
  if (!PSD || !existsSync(PSD)) throw Object.assign(new Error("skipped: set ANIMATOR_QA_PSD to a layered PSD of the practice rig to run this check"), { skip: true });
  await E(() => window.atlasEditor.workspace("rig"));
  await page.waitForTimeout(400);
  await page.click("#rig-file");
  await page.click("#newrig-open");
  await page.waitForSelector("#newrig-dialog");
  await page.fill("#newrig-name", "QA Pipe Kit");
  const chooser = page.waitForEvent("filechooser");
  await page.click("#newrig-drop");
  await (await chooser).setFiles(PSD); // read only
  await page.waitForFunction(() => document.querySelector("#newrig-parts")?.children.length > 3, null, { timeout: 60_000 });
  await page.click("#newrig-create");
  await page.waitForSelector("#newrig-dialog", { state: "detached", timeout: 60_000 });
  await page.waitForTimeout(1500);
  const before = await E(() => ({ id: window.atlasEditor.state().outfit, doc: window.atlasEditor.rigDocument(), atlas: window.atlasEditor.rigAtlas(), raw: window.atlasEditor.setupRaw() }));
  need(before.doc && before.raw && /qa/i.test(before.doc), `the new rig is not mounted (${before.doc})`);
  need(Array.isArray(before.raw.slots) && before.raw.slots.length > 3, "the new rig has no slots from the PSD");
  newRig = before;
  await boot();
  await mount(before.id);
  const after = await E(() => window.atlasEditor.setupRaw());
  need(same(after, before.raw), "the reloaded document differs from the one the editor held before the reload");
  need(same(await diskDoc(before.doc), before.raw), "the document on disk differs from the editor's");
  const pages = await pagesLoad(before.atlas);
  need(pages.length > 0 && pages.every((p) => p.w > 0), `atlas pages that do not load: ${JSON.stringify(pages.filter((p) => !(p.w > 0)))}`);
});

// ---------------------------------------------------------------------------------------------------------------- 2. Swag item
await test("swag item through the wizard API (buildItemBatch + /api/rig/save) -> reload: skin present, every piece resolves to an attachment and a region, pages packed (count <= before + 1)", async () => {
  await mount("pro-turned");
  const pagesBefore = (await E(async (a) => (await (await fetch(`/repo/${a}?v=1`)).json()).pages.length, KIT_ATLAS));
  const r = await E(
    async ({ doc, atlas }) => {
      const model = await import("/src/swagWorkshopModel.ts");
      const raw = await (await fetch(`/repo/${doc}?v=${Date.now()}`)).json();
      const hash = (await (await fetch(`/api/rig/hash?file=${encodeURIComponent(doc)}`)).json()).hash;
      const png = (w, h, color) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.fillStyle = color;
        g.fillRect(2, 2, w - 4, h - 4);
        return c.toDataURL("image/png");
      };
      const pieces = [
        { rigSlot: "shirt_torso", width: 60, height: 80, png: png(60, 80, "#a33"), x: 0, y: 0, rotation: 0, scale: 1 },
        { rigSlot: "shirt_sleeve_near", width: 24, height: 50, png: png(24, 50, "#3a3"), x: 0, y: 0, rotation: 0, scale: 1 }
      ];
      const batch = model.buildItemBatch(raw, { slot: "chest", item: "qa_coat", rigName: "kit-body-cutout", pieces });
      const res = await fetch("/api/rig/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: doc, atlas, base: hash, undo: 0, batches: [batch.commands], images: batch.images }) });
      return { status: res.status, body: await res.json(), paths: batch.images.map((i) => i.path) };
    },
    { doc: KIT_DOC, atlas: KIT_ATLAS }
  );
  need(r.status === 200, `save answered ${r.status}: ${JSON.stringify(r.body)}`);
  need(r.body.packed?.length >= 1, "the save did not re-pack the imported pieces");
  await boot();
  await mount("pro-turned");
  const raw = await E(() => window.atlasEditor.setupRaw());
  const skin = raw.skins?.["chest.qa_coat"];
  need(skin, `no chest.qa_coat skin after reload (skins: ${Object.keys(raw.skins ?? {}).join(", ")})`);
  const manifest = await E(async (a) => (await fetch(`/repo/${a}?v=${Date.now()}`)).json(), KIT_ATLAS);
  const regions = new Set(manifest.pages.flatMap((p) => Object.keys(p.regions)));
  const atts = Object.entries(skin.attachments).flatMap(([slot, byName]) => Object.entries(byName).map(([name, a]) => ({ slot, name, a })));
  need(atts.length === 2, `expected 2 pieces, found ${atts.length}`);
  for (const { slot, name, a } of atts) need(regions.has(a.path), `${slot}/${name}: ${a.path} is not in the atlas`);
  for (const p of r.paths) need(regions.has(p), `${p} is not in the atlas`);
  need(manifest.pages.length <= pagesBefore + 1, `page count grew from ${pagesBefore} to ${manifest.pages.length}`);
  need(same(raw.atlas.pages, manifest.pages.map((p) => p.file)), "the document's atlas.pages and the manifest disagree");
  const pages = await pagesLoad(KIT_ATLAS);
  const owned = new Set(readdirSync(resolve(data, "rigs/kit-body-cutout")));
  need(pages.every((p) => p.w > 0 && owned.has(p.file)), `pages that do not load: ${JSON.stringify(pages.filter((p) => !(p.w > 0)))}`);
  need(existsSync(resolve(data, "rigs/kit-body-cutout/imports")), "no imports/ folder with the piece sources");
  need(!existsSync(resolve(stock, KIT, "imports")), "the save wrote into the stock copy");
});

// ---------------------------------------------------------------------------------------------------------------- 2b. Rig contract (Batch 10a)
const contractMeta = () =>
  E(async () => {
    window.atlasEditor.inspectorOpen("rig.contract", true);
    await new Promise((r) => setTimeout(r, 300));
    const sec = document.querySelector('[data-sec="rig.contract"]');
    return { meta: sec?.querySelector(".insp-sec-meta")?.textContent ?? null, text: sec?.textContent ?? "", create: sec?.querySelector("#rc-create")?.disabled ?? null };
  });
const makeRig = async (name, template) => {
  await E(() => window.atlasEditor.workspace("rig"));
  await page.waitForTimeout(300);
  await page.click("#rig-file");
  await page.click("#newrig-open");
  await page.waitForSelector("#newrig-dialog");
  await page.fill("#newrig-name", name);
  await page.click(`#newrig-dialog [data-template="${template}"]`);
  await page.click("#newrig-create");
  await page.waitForSelector("#newrig-dialog", { state: "detached", timeout: 60_000 });
  await page.waitForTimeout(1800);
  await E(() => window.atlasEditor.setMode("setup"));
  await page.waitForTimeout(500);
  await E(() => window.atlasEditor.select("root"));
  await page.waitForTimeout(300);
};
await test("rig contract: the card on kit-body-cutout shows 0 missing (bones, core slots, grip and tip)", async () => {
  await mount("pro-turned");
  await E(() => window.atlasEditor.workspace("rig"));
  await page.waitForTimeout(400);
  await E(() => window.atlasEditor.setMode("setup"));
  await page.waitForTimeout(400);
  await E(() => window.atlasEditor.select("chest"));
  await page.waitForTimeout(300);
  const c = await contractMeta();
  need(c.meta === "0 missing", `meta ${c.meta}: ${c.text.slice(0, 200)}`);
  need(c.create === true, "Create missing is enabled on a complete rig");
});
await test("rig contract: a Blank New rig lists what is missing; Create missing adds it on the contract bones in one undo step and the rig wears an item with 0 'no rig slot' issues", async () => {
  await makeRig("QA Blank Contract", "blank");
  const c0 = await contractMeta();
  need(/^\d+ missing$/.test(c0.meta ?? "") && c0.meta !== "0 missing", `blank rig meta ${c0.meta}`);
  need(/Bonesmissing body, pelvis/.test(c0.text) && /Slotsmissing shirt_torso/.test(c0.text), `blank card text ${c0.text.slice(0, 300)}`);
  const n0 = await E(() => window.atlasEditor.setupRaw().bones.length);
  await page.click("#rc-create");
  await page.waitForTimeout(700);
  const c1 = await contractMeta();
  need(c1.meta === "0 missing", `after Create missing: ${c1.meta}`);
  const made = await E(() => {
    const r = window.atlasEditor.setupRaw();
    return { bones: r.bones.length, slots: r.slots.length, sleeveBone: r.slots.find((s) => s.name === "shirt_sleeve_near")?.bone, hand: r.bones.find((b) => b.name === "hand_near")?.parent };
  });
  need(made.bones > n0 + 20 && made.sleeveBone === "upper_arm_near" && made.hand === "forearm_near", `created ${JSON.stringify(made)}`);
  const issues = await E(async () => {
    const m = await import("/src/swagWorkshopModel.ts");
    const s = await import("/src/swagModel.ts");
    const { runBatch } = await import("/src/setupModel.ts");
    const raw = window.atlasEditor.setupRaw();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const b = m.buildItemBatch(raw, { slot: "chest", item: "qa-coat", rigName: "qa-blank-contract", pieces: [{ rigSlot: "shirt_torso", width: 60, height: 80, png, x: 0, y: 0, rotation: 0 }, { rigSlot: "shirt_sleeve_near", width: 24, height: 50, png, x: 0, y: 0, rotation: 0 }] });
    const doc = runBatch(structuredClone(raw), b.commands).doc;
    return s.checkItem(doc, "chest.qa-coat").filter((i) => i.kind === "no rig slot").length;
  });
  need(issues === 0, `${issues} 'no rig slot' issues after Create missing`);
  await E(() => window.atlasEditor.setupUndo());
  await page.waitForTimeout(500);
  const c2 = await contractMeta();
  need(c2.meta === c0.meta, `Undo did not take the batch back in one step: ${c2.meta} vs ${c0.meta}`);
});
await test("rig contract: the Player skeleton start already has every contract slot and an explicit grip and tip point", async () => {
  await makeRig("QA Player Contract", "player");
  const c = await contractMeta();
  need(c.meta === "0 missing", `player start meta ${c.meta}`);
  need(/grip: point, tip: point/.test(c.text) && !/On first use/.test(c.text), `points/slots text ${c.text.slice(0, 260)}`);
  const raw = await E(() => window.atlasEditor.setupRaw());
  need(raw.slots.some((s) => s.name === "boots_foot_near") && raw.slots.some((s) => s.name === "weapon_points"), "the first-use slots and weapon_points are not there");
  need(raw.skins[Object.keys(raw.skins)[0]].attachments.weapon_points?.grip?.type === "point", "no grip point attachment");
});
await test("weapon item: the grip click registers grip and tip points; the saved grip lands within 2 px of the weapon bone", async () => {
  await mount("pro-turned");
  const r = await E(
    async ({ doc, atlas }) => {
      const m = await import("/src/swagWorkshopModel.ts");
      const raw = await (await fetch(`/repo/${doc}?v=${Date.now()}`)).json();
      const hash = (await (await fetch(`/api/rig/hash?file=${encodeURIComponent(doc)}`)).json()).hash;
      const c = document.createElement("canvas");
      c.width = 30;
      c.height = 200;
      const g = c.getContext("2d");
      g.fillStyle = "#99a";
      g.fillRect(8, 4, 14, 190);
      const base = { rigSlot: "weapon", width: 30, height: 200, png: c.toDataURL("image/png"), rotation: 17, scale: 1 };
      const grip = { x: 15, y: 160 };
      const at = m.alignGrip(base, grip);
      const batch = m.buildItemBatch(raw, { slot: "weapon", item: "qa_blade", rigName: "kit-body-cutout", pieces: [{ ...base, ...at, grip, tip: { x: 15, y: 6 } }] });
      const res = await fetch("/api/rig/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: doc, atlas, base: hash, undo: 0, batches: [batch.commands], images: batch.images }) });
      return { status: res.status, body: await res.json() };
    },
    { doc: KIT_DOC, atlas: KIT_ATLAS }
  );
  need(r.status === 200, `save answered ${r.status}: ${JSON.stringify(r.body)}`);
  await boot();
  await mount("pro-turned");
  const w = await E(() => window.atlasEditor.setupRaw().skins["weapon.qa_blade"]?.attachments.weapon);
  need(w?.grip?.type === "point" && w?.tip?.type === "point", `points after reload: ${JSON.stringify(Object.keys(w ?? {}))}`);
  need(Math.hypot(w.grip.x, w.grip.y) <= 2, `grip is ${Math.hypot(w.grip.x, w.grip.y).toFixed(2)} px from the weapon bone`);
  need(Math.hypot(w.tip.x, w.tip.y) > 100, "tip is not out at the end of the blade");
});

// ---------------------------------------------------------------------------------------------------------------- 3. Pose, smear, clip
await test("pose saved -> listed -> applied gives the same bone values", async () => {
  const pose = { format: "atlas-pose@1", name: "qa_pipe_pose", bones: { pelvis: { rotate: 12.5, translate: { x: 3, y: -2 }, scale: { x: 1, y: 1 } } }, attachments: {}, drawOrder: [] };
  const w = await api("api/poses/qa_pipe_pose", { pose });
  need(w.status === 200, `save answered ${w.status} ${w.text}`);
  need((await api("api/poses")).json?.includes("qa_pipe_pose"), "the pose is not listed");
  const disk = JSON.parse(readFileSync(resolve(data, "poses/qa_pipe_pose.pose.json"), "utf8"));
  need(same(disk, pose), "the saved pose file differs from what was sent");
  const got = await E(async (p) => {
    const m = await import("/src/poseModel.ts");
    const r = m.applyPoseRecord({ duration: 1, loop: false, bones: {}, slots: {}, ik: {}, transform: {}, physics: {}, deform: {}, drawOrder: [], events: [] }, p, 0);
    return r.clip.bones.pelvis ?? null;
  }, disk);
  need(got && got.rotate?.[0]?.value === 12.5, `applied pose rotate ${JSON.stringify(got?.rotate)}`);
  need(got.translate?.[0]?.x === 3 && got.translate?.[0]?.y === -2, `applied pose translate ${JSON.stringify(got?.translate)}`);
});

await test("smear saved -> reloads with the same meta and image", async () => {
  const png = "data:image/png;base64," + readFileSync(resolve(stock, KIT, JSON.parse(readFileSync(resolve(stock, KIT_ATLAS), "utf8")).pages[0].file)).toString("base64");
  const meta = { format: "atlas-smear@1", name: "qa_pipe_smear", slot: "weapon", attachment: "smear", path: "smear/qa", region: { x: 0, y: 0, width: 10, height: 10 }, from: 2, to: 5, show: 3, steps: 4, stretch: 1.2 };
  const w = await api("api/smears/qa_pipe_smear", { meta, png });
  need(w.status === 200, `save answered ${w.status} ${w.text}`);
  need((await api("api/smears")).json?.includes("qa_pipe_smear"), "the smear is not listed");
  need(same(JSON.parse(readFileSync(resolve(data, "smears/qa_pipe_smear.smear.json"), "utf8")), meta), "smear meta differs after reload");
  need(sha1(readFileSync(resolve(data, "smears/qa_pipe_smear.smear.png"))) === sha1(Buffer.from(png.split(",")[1], "base64")), "smear image differs");
});

const CLIP = {
  clipVersion: 2,
  duration: 1,
  loop: true,
  fps: 30,
  bones: { pelvis: { rotate: [{ time: 0, value: 0 }, { time: 0.5, value: 15, curve: "stepped" }] } },
  slots: { shirt_torso: { color: [{ time: 0, color: "ffffffff" }, { time: 0.5, color: "ff000080" }] } },
  ik: { qa_ik: [{ time: 0, mix: 1 }, { time: 0.5, mix: 0.25 }] },
  transform: { qa_tc: [{ time: 0, mixRotate: 1, mixX: 0.5 }] },
  events: [{ time: 0.2, name: "footstep", int: 2, float: 0.5, string: "left", audio: "step_grass" }]
};
await test("clip with v2 events (audio), colour and constraint-mix keys -> saved -> reload: byte-equal file, parses to the same clip", async () => {
  const text = JSON.stringify(CLIP, null, 2);
  const w = await api("api/clips/qa_pipe.clip.json", text);
  need(w.status === 200, `save answered ${w.status} ${w.text}`);
  need(readFileSync(resolve(data, "clips/qa_pipe.clip.json"), "utf8") === text, "the clip file is not byte-equal");
  const r = await E(async (t) => {
    const m = await import("/src/clipModel.ts");
    const sent = m.parseClip(JSON.parse(t.sent));
    const a = m.parseClip(JSON.parse(t.disk));
    return { a, sameAsSent: JSON.stringify(a) === JSON.stringify(sent) };
  }, { sent: text, disk: readFileSync(resolve(data, "clips/qa_pipe.clip.json"), "utf8") });
  need(r.a.events[0].audio === "step_grass" && r.a.slots.shirt_torso.color.length === 2 && r.a.ik.qa_ik[1].mix === 0.25 && r.a.transform.qa_tc[0].mixX === 0.5, `parsed clip lost keys: ${JSON.stringify(r.a).slice(0, 200)}`);
  need(r.sameAsSent, "the clip read back from disk parses differently from the one sent");
});

// ---------------------------------------------------------------------------------------------------------------- 4. Publish + validator
await test("publish rig + clip into the temp repo -> validatePublish passes and the manifest hashes equal the data-folder files", async () => {
  const plan = await api("api/publish?kind=rig&name=kit-body-cutout");
  need(plan.status === 200, `plan answered ${plan.status} ${plan.text}`);
  const pub = await api("api/publish", { kind: "rig", name: "kit-body-cutout", token: plan.json.token });
  need(pub.status === 200, `publish answered ${pub.status} ${pub.text}`);
  // The clip goes in under a mapped id so the validator checks it against the rig.
  const clip = await api("api/clips/gather_chop.clip.json", JSON.stringify({ ...CLIP, ik: {}, transform: {} }, null, 2));
  need(clip.status === 200, `clip save answered ${clip.status}`);
  const cpub = await api("api/publish", { kind: "clip", name: "gather_chop.clip.json" });
  need(cpub.status === 200, `clip publish answered ${cpub.status} ${cpub.text}`);
  const v = await api("api/publish/validate?rig=kit-body-cutout");
  need(v.status === 200 && v.json.ok, `validator: ${v.json?.text ?? v.text}`);
  need(!v.json.reports[0].missingClips.includes("gather_chop"), "the published mapped clip was not found");
  const manifest = JSON.parse(readFileSync(resolve(stock, "packages/animator/publish-manifest.json"), "utf8"));
  const files = manifest.rigs["kit-body-cutout"].files;
  const owner = resolve(data, "rigs/kit-body-cutout");
  for (const [f, h] of Object.entries(files)) need(sha1(readFileSync(resolve(owner, f))) === h, `${f}: manifest hash differs from the data-folder file`);
  need(manifest.clips["gather_chop.clip.json"].sha1 === sha1(readFileSync(resolve(data, "clips/gather_chop.clip.json"))), "clip hash differs");
  // The validator CLI agrees (exit 0) on the same temp repo.
  const tsx = createRequire(resolve(PKG, "../animator/package.json")).resolve("tsx/cli");
  const cli = await new Promise((ok) => {
    const p = spawn(process.execPath, [tsx, resolve(PKG, "../animator/src/cli/validatePublish.ts"), "--repo", stock, "--rig", "kit-body-cutout"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("close", (code) => ok({ code, out }));
  });
  need(cli.code === 0, `validate-publish CLI exit ${cli.code}: ${cli.out}`);
});

await test("a stale publish (token from before a later save) answers 409, an unregistered New-rig id answers 400 with the register hint", async () => {
  const plan = await api("api/publish?kind=rig&name=kit-body-cutout");
  need(plan.status === 200, `plan answered ${plan.status}`);
  // A later save changes the user copy, so the checked plan is stale.
  const hash = (await api(`api/rig/hash?file=${encodeURIComponent(KIT_DOC)}`)).json.hash;
  const save = await api("api/rig/save", { file: KIT_DOC, base: hash, undo: 0, batches: [[{ op: "bone.set", name: "pelvis", color: "ff00ffff" }]] });
  need(save.status === 200, `save answered ${save.status} ${save.text}`);
  const stale = await api("api/publish", { kind: "rig", name: "kit-body-cutout", token: plan.json.token });
  need(stale.status === 409, `stale publish answered ${stale.status}`);
  const id = newRig?.doc?.split("/")[3] ?? "qa-pipe-kit";
  const unknown = await api("api/publish", { kind: "rig", name: id });
  need(unknown.status === 400 && /not a registered game rig/.test(unknown.json?.error ?? "") && /Register as a new character/.test(unknown.json?.error ?? ""), `unregistered publish answered ${unknown.status} ${unknown.text}`);
  need(!existsSync(resolve(stock, "packages/animator/rigs", id)), "the unregistered rig was written into the repo");
  const probe = await api(`api/publish?kind=rig&probe=1&name=${encodeURIComponent(id)}`);
  need(probe.status === 200 && /Register as a new character/.test(probe.json?.unregistered ?? ""), `the Ship probe answered ${probe.status} ${probe.text}`);
  const v = await api("api/publish/validate?rig=kit-body-cutout");
  need(v.json?.ok, `the repo stopped validating after refused publishes: ${v.json?.text ?? v.text}`);
});

await test("every gameClips.ts id has a clipMap.json row or is listed as not in project", async () => {
  const r = await E(async () => {
    const m = await import("/src/gameClips.ts");
    const notIn = new Set(m.clipsNotInGame().map((c) => c.id));
    return m.GAME_CLIPS.filter((c) => notIn.has(c.id) === m.gameIdsFor(c.id).length > 0).map((c) => c.id);
  });
  need(r.length === 0, `clips neither mapped nor listed: ${r.join(", ")}`);
});

await test("no page error during the pipeline run", async () => {
  need(errors.length === 0, errors.slice(0, 3).join(" | "));
});

await browser.close().catch(() => {});
const failed = rows.filter((r) => r.status === "FAIL").length;
const jsonOut = (argv.find((a) => a.startsWith("--json=")) ?? "").slice(7);
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(rows, null, 2));
console.log(`\n${rows.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${rows.filter((r) => r.status === "SKIP").length} skipped. ${failed ? "QA PIPELINE FAILED" : "QA PIPELINE OK"}`);
process.exit(failed ? 1 : 0);
